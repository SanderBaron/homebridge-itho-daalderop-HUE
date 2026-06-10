import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
  APIEvent,
} from 'homebridge';

import {
  DEFAULT_AIR_QUALITY_SENSOR_NAME,
  DEFAULT_FAN_NAME,
  DEFAULT_HUMIDITY_BOOST_THRESHOLD,
  DEFAULT_HUMIDITY_COOLDOWN_MINUTES,
  DEFAULT_HUMIDITY_DROP_THRESHOLD,
  DEFAULT_DAILY_RESET_TIME,
  DEFAULT_HUMIDITY_MIN_SPEED_THRESHOLD,
  DEFAULT_HUMIDITY_MODE,
  DEFAULT_HUMIDITY_RISE_RATE,
  DEFAULT_HUMIDITY_RISE_WINDOW_SECONDS,
  MQTT_STATE_TOPIC,
  MQTT_STATUS_TOPIC,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from '@/settings';
import { FanAccessory } from '@/fan-accessory';
import { ZodError } from 'zod';
import { ConfigSchema, configSchema } from './config.schema';
import {
  IthoDaalderopAccessoryContext,
  IthoStatusSanitizedPayload,
  SupportedVirtualRemoteCommands,
  VirtualRemoteCommand,
} from './types';
import { AirQualitySensorAccessory } from './air-quality-sensor-accessory';
import { MqttApi } from './api/mqtt';
import { HttpApi } from './api/http';
import { HueApi } from './api/hue';
import { sanitizeStatusPayload } from './utils/api';
import { HumidityAutomation } from './automations/humidity-automation';
import { HumidityDataLogger } from './utils/data-logger';
import { ScheduleEngine } from './automations/schedule-engine';
import path from 'node:path';
import { MirrorHeaterAutomation } from './automations/mirror-heater-automation';
import { ToiletLightAutomation } from './automations/toilet-light-automation';

export class HomebridgeIthoDaalderop implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public cachedAccessories: PlatformAccessory<IthoDaalderopAccessoryContext>[] = [];

  private config: ConfigSchema;
  private mqttClient: MqttApi | null = null;
  private httpClient: HttpApi | null = null;

  private fanAccessory: FanAccessory | null = null;
  private airQualityAccessory: AirQualitySensorAccessory | null = null;

  private humidityAutomation: HumidityAutomation | null = null;
  private scheduleEngine: ScheduleEngine | null = null;
  private mirrorHeaterAutomation: MirrorHeaterAutomation | null = null;
  private dataLogger: HumidityDataLogger | null = null;
  /** Last automation states written to the data log — for transition markers. */
  private lastLoggedStates: Record<string, string> = { cve: 'idle', mirror: 'idle', toilet: 'idle' };
  private toiletLightAutomation: ToiletLightAutomation | null = null;
  private hueApi: HueApi | null = null;
  private dailyResetTimer: ReturnType<typeof setTimeout> | null = null;
  /** Polls the Hue sensor for the toilet input-only switch. */
  private toiletSwitchPollInterval: ReturnType<typeof setInterval> | null = null;
  private toiletSwitchLastUpdated: string | null = null;
  /** Last seen on/off state when the toilet source is a Hue light. */
  private toiletLightLastOn: boolean | null = null;

  constructor(public readonly log: Logger, config: PlatformConfig, public readonly api: API) {
    this.config = config as ConfigSchema;
    this.api.on(APIEvent.DID_FINISH_LAUNCHING, this.handleDidFinishLaunching.bind(this));
    this.api.on(APIEvent.SHUTDOWN, this.handleShutdown.bind(this));
  }

  // ---- Lifecycle ----------------------------------------------------------

  private handleDidFinishLaunching(): void {
    if (!this.isValidConfig(this.config)) {
      this.log.error(
        '[Platform] Invalid config — fix config.json and restart Homebridge.',
      );
      return;
    }

    this.setupApiClients();
    this.setupHueApi();
    this.setupAutomations();
    this.registerAccessories();
    this.scheduleDailyReset();
  }

  private handleShutdown(): void {
    this.log.debug('[Platform] Shutting down');
    this.mqttClient?.end();
    this.humidityAutomation?.destroy();
    this.scheduleEngine?.destroy();
    this.mirrorHeaterAutomation?.destroy();
    this.toiletLightAutomation?.destroy();
    if (this.toiletSwitchPollInterval) {
      clearInterval(this.toiletSwitchPollInterval);
      this.toiletSwitchPollInterval = null;
    }
    this.fanAccessory?.destroy();
    if (this.dailyResetTimer) {
      clearTimeout(this.dailyResetTimer);
      this.dailyResetTimer = null;
    }
  }

  configureAccessory(accessory: PlatformAccessory<IthoDaalderopAccessoryContext>): void {
    this.log.debug(`[Platform] Restoring cached accessory: ${accessory.displayName}`);
    this.cachedAccessories.push(accessory);
  }

  // ---- Setup --------------------------------------------------------------

  private setupApiClients(): void {
    if (this.config.api.protocol === 'mqtt') {
      this.mqttClient = new MqttApi({
        ip: this.config.api.ip,
        port: this.config.api.port,
        username: this.config.api.username,
        password: this.config.api.password,
        logger: this.log,
        verboseLogging: this.config.verboseLogging,
      });
      this.mqttClient.subscribe([MQTT_STATE_TOPIC, MQTT_STATUS_TOPIC]);
      this.mqttClient.on('message', this.handleMqttMessage.bind(this));
    }

    // HTTP client: device IP when protocol=http, or optional deviceIp override when protocol=mqtt
    const deviceIp =
      this.config.api.deviceIp ??
      (this.config.api.protocol === 'http' ? this.config.api.ip : undefined);

    if (deviceIp) {
      this.httpClient = new HttpApi({
        ip: deviceIp,
        username: this.config.api.username,
        password: this.config.api.password,
        logger: this.log,
        verboseLogging: this.config.verboseLogging,
      });
    }
  }

  private setupHueApi(): void {
    const hue = this.config.hue;
    if (!hue?.bridgeIp || !hue?.apiKey) return;

    this.hueApi = new HueApi({
      bridgeIp: hue.bridgeIp,
      apiKey: hue.apiKey,
      logger: this.log,
      verboseLogging: this.config.verboseLogging,
    });

    // Fire-and-forget connection test on startup
    this.hueApi.testConnection().then(result => {
      if (result.ok) {
        this.log.info(`[Hue] Verbonden met bridge — ${result.lightsCount} lampen gevonden`);
      } else {
        this.log.warn(`[Hue] Verbinding mislukt: ${result.error}`);
      }
    }).catch(() => { /* swallow */ });
  }

  private setupAutomations(): void {
    if (this.config.dataLogging?.enabled) {
      const file = path.join(this.api.user.storagePath(), 'itho-humidity-log.csv');
      this.dataLogger = new HumidityDataLogger(file, this.log);
      this.log.info(`[DataLog] Datalogging actief → ${file}`);
    }

    const humCfg = this.config.automation?.humidity;

    this.humidityAutomation = new HumidityAutomation(
      {
        enabled:             humCfg?.enabled !== false,
        mode:                humCfg?.mode               ?? DEFAULT_HUMIDITY_MODE,
        boostThreshold:      humCfg?.boostThreshold     ?? DEFAULT_HUMIDITY_BOOST_THRESHOLD,
        dropThreshold:       humCfg?.dropThreshold      ?? DEFAULT_HUMIDITY_DROP_THRESHOLD,
        cooldownMinutes:     humCfg?.cooldownMinutes     ?? DEFAULT_HUMIDITY_COOLDOWN_MINUTES,
        riseRate:            humCfg?.riseRate            ?? DEFAULT_HUMIDITY_RISE_RATE,
        riseWindowSeconds:   humCfg?.riseWindowSeconds   ?? DEFAULT_HUMIDITY_RISE_WINDOW_SECONDS,
        triggerLogic:        humCfg?.triggerLogic        ?? 'or',
        minSpeedThreshold:   humCfg?.minSpeedThreshold   ?? DEFAULT_HUMIDITY_MIN_SPEED_THRESHOLD,
      },
      this.handleAutomationSpeedChange.bind(this),
      this.log,
    );

    const schedCfg = this.config.automation?.schedule;
    if (schedCfg?.enabled) {
      this.scheduleEngine = new ScheduleEngine(
        { enabled: true, entries: schedCfg.entries ?? [] },
        this.handleScheduleSpeedChange.bind(this),
        this.log,
      );
      this.scheduleEngine.start();
    }

    // Mirror heater (Phase 2 — Hue)
    const mirrorCfg = this.config.automation?.mirrorHeater;
    if (mirrorCfg?.enabled && mirrorCfg.hueLightId && this.hueApi) {
      this.mirrorHeaterAutomation = new MirrorHeaterAutomation(
        {
          enabled:                  true,
          hueLightId:               mirrorCfg.hueLightId,
          hueButtonId:              mirrorCfg.hueButtonId,
          triggerThreshold:         mirrorCfg.triggerThreshold        ?? 70,
          dropThreshold:            mirrorCfg.dropThreshold,
          riseRate:                 mirrorCfg.riseRate                ?? 3,
          riseWindowSeconds:        mirrorCfg.riseWindowSeconds       ?? 24,
          triggerLogic:             mirrorCfg.triggerLogic            ?? 'or',
          triggerDelayMinutes:      mirrorCfg.triggerDelayMinutes     ?? 5,
          durationMinutes:          mirrorCfg.durationMinutes         ?? 30,
          manualButtonTimerMinutes: mirrorCfg.manualButtonTimerMinutes ?? 30,
        },
        this.hueApi,
        this.log,
      );
      this.mirrorHeaterAutomation.start();
      this.log.info('[Mirror] Spiegelverwarming automaat gestart');
    }

    // Toilet light detection (Phase 2 — Hue input-only switch)
    const toiletCfg = this.config.automation?.toiletLight;
    if (toiletCfg?.enabled && toiletCfg.hueSensorId && this.hueApi) {
      this.toiletLightAutomation = new ToiletLightAutomation(
        {
          enabled:        true,
          hueSensorId:    toiletCfg.hueSensorId,
          minOnMinutes:   toiletCfg.minOnMinutes  ?? 2,
          boostMinutes:   toiletCfg.boostMinutes  ?? 20,
        },
        this.handleToiletSpeedChange.bind(this),
        this.log,
      );
      this.toiletLightAutomation.start();
      this.startToiletSwitchPoller(toiletCfg.hueSensorId);
      this.log.info('[Toilet] Toilet-detectie gestart');
    }
  }

  /**
   * Polls the Hue input-only switch sensor every 3 seconds for state changes.
   * Translates `buttonevent` / `lastupdated` changes into `notifyLightOn()` /
   * `notifyLightOff()` calls on the toilet automation.
   *
   * Polling at 3 s gives ~1–3 s latency — fast enough for a toilet light.
   * When Hue v2 SSE is available this can be replaced with an event subscription.
   */
  private startToiletSwitchPoller(idSpec: string): void {
    if (!this.hueApi || !this.toiletLightAutomation) return;

    const POLL_MS = 3_000;

    // The id can be 'light:23' (Hue light/socket — e.g. a zigbee switch that the
    // bridge exposes as a light), 'sensor:8', or a bare id (legacy = sensor).
    const sep = idSpec.indexOf(':');
    const kind = sep === -1 ? 'sensor' : idSpec.slice(0, sep);
    const sensorId = sep === -1 ? idSpec : idSpec.slice(sep + 1);

    if (kind === 'light') {
      this.toiletSwitchPollInterval = setInterval(() => {
        void this.hueApi!.getLight(sensorId)
          .then(light => {
            if (this.toiletLightLastOn === null) {
              this.toiletLightLastOn = light.on; // first poll: only record
              return;
            }
            if (light.on === this.toiletLightLastOn) return;
            this.toiletLightLastOn = light.on;
            if (light.on) this.toiletLightAutomation?.notifyLightOn();
            else this.toiletLightAutomation?.notifyLightOff();
          })
          .catch((err: unknown) => {
            this.log.debug(
              `[Toilet] Lamp poll fout: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }, POLL_MS);
      return;
    }
    // buttonevent codes for Friends-of-Hue / Hue Dimmer switches:
    //   x000 = initial press (on)    x002 = short release (on)
    //   x001 = hold               x003 = long release (off)
    // For a simple on/off input switch we treat even hundreds as ON, odd as OFF.
    // Adjust if your specific switch model uses different codes.
    const isOnEvent = (code: number): boolean => Math.floor(code / 1000) % 2 === 0;

    this.toiletSwitchPollInterval = setInterval(() => {
      void this.hueApi!.getSensor(sensorId)
        .then(sensor => {
          const { lastupdated, buttonevent } = sensor.state;
          if (lastupdated === this.toiletSwitchLastUpdated) return; // nothing changed
          this.toiletSwitchLastUpdated = lastupdated;

          if (buttonevent !== undefined) {
            if (isOnEvent(buttonevent)) {
              this.toiletLightAutomation?.notifyLightOn();
            } else {
              this.toiletLightAutomation?.notifyLightOff();
            }
          }
        })
        .catch((err: unknown) => {
          this.log.debug(
            `[Toilet] Switch poll fout: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }, POLL_MS);
  }

  private registerAccessories(): void {
    this.addFanAccessory(DEFAULT_FAN_NAME, this.api.hap.uuid.generate(DEFAULT_FAN_NAME));
    this.addAirQualitySensor(
      DEFAULT_AIR_QUALITY_SENSOR_NAME,
      this.api.hap.uuid.generate(DEFAULT_AIR_QUALITY_SENSOR_NAME),
    );
  }

  // ---- Accessory registration ---------------------------------------------

  private addFanAccessory(displayName: string, uuid: string): void {
    const existing = this.cachedAccessories.find(
      a => a.UUID === uuid,
    ) as PlatformAccessory<IthoDaalderopAccessoryContext> | undefined;

    let accessory: PlatformAccessory<IthoDaalderopAccessoryContext>;
    if (existing) {
      this.log.info('[Platform] Restoring fan accessory from cache');
      this.api.updatePlatformAccessories([existing]);
      accessory = existing;
    } else {
      this.log.info('[Platform] Registering new fan accessory');
      accessory = new this.api.platformAccessory<IthoDaalderopAccessoryContext>(
        displayName,
        uuid,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.fanAccessory = new FanAccessory(this, accessory, this.config);

    if (this.config.api.protocol === 'http' && this.httpClient) {
      this.httpClient.polling.getSpeed.start();
      this.httpClient.polling.getStatus.start();
      this.httpClient.polling.getSpeed.on('response.getSpeed', s =>
        this.fanAccessory?.handleSpeedResponse(s),
      );
      this.httpClient.polling.getStatus.on('response.getStatus', p =>
        this.handleStatusPayload(p as IthoStatusSanitizedPayload),
      );
    }
  }

  private addAirQualitySensor(displayName: string, uuid: string): void {
    const existing = this.cachedAccessories.find(
      a => a.UUID === uuid,
    ) as PlatformAccessory<IthoDaalderopAccessoryContext> | undefined;

    let accessory: PlatformAccessory<IthoDaalderopAccessoryContext>;
    if (existing) {
      this.log.info('[Platform] Restoring air quality sensor from cache');
      this.api.updatePlatformAccessories([existing]);
      accessory = existing;
    } else {
      this.log.info('[Platform] Registering new air quality sensor accessory');
      accessory = new this.api.platformAccessory<IthoDaalderopAccessoryContext>(
        displayName,
        uuid,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.airQualityAccessory = new AirQualitySensorAccessory(this, accessory, this.config);
  }

  // ---- MQTT message routing -----------------------------------------------

  private handleMqttMessage(topic: string, message: Buffer): void {
    const text = message.toString();

    if (topic === MQTT_STATUS_TOPIC) {
      try {
        const payload = sanitizeStatusPayload<IthoStatusSanitizedPayload>(text);
        this.handleStatusPayload(payload);
      } catch {
        this.log.error('[Platform] Failed to parse MQTT status payload');
      }
      return;
    }

    if (topic === MQTT_STATE_TOPIC) {
      const speed = Number(text);
      if (!Number.isNaN(speed)) {
        this.fanAccessory?.handleSpeedResponse(speed);
      }
    }
  }

  private handleStatusPayload(payload: IthoStatusSanitizedPayload): void {
    this.fanAccessory?.handleStatusResponse(payload);
    this.airQualityAccessory?.handleStatusResponse(payload);

    // Internal duct sensor → CVE humidity automation
    if (payload.hum !== null && payload.hum !== undefined) {
      this.humidityAutomation?.update(payload.hum);
    }

    // External RFT-RV sensor (Indoorhumidity) → mirror heater automation
    const indoorHum = payload['Indoorhumidity (%)'];
    if (indoorHum !== null && indoorHum !== undefined) {
      this.mirrorHeaterAutomation?.update(indoorHum);
    }

    if (this.dataLogger) {
      const states: Record<string, string> = {
        cve:    this.humidityAutomation?.getState()     ?? 'idle',
        mirror: this.mirrorHeaterAutomation?.getState() ?? 'idle',
        toilet: this.toiletLightAutomation?.getState()  ?? 'idle',
      };
      const events: string[] = [];
      for (const [name, state] of Object.entries(states)) {
        if (state !== this.lastLoggedStates[name]) {
          events.push(`${name}:${this.lastLoggedStates[name]}->${state}`);
          this.lastLoggedStates[name] = state;
        }
      }
      this.dataLogger.append({
        ductHum:     payload.hum,
        indoorHum:   indoorHum,
        speedPct:    payload['Speed status'],
        cveState:    states.cve ?? 'idle',
        mirrorState: states.mirror,
        toiletState: states.toilet,
        event:       events.length ? events.join(';') : undefined,
      });
    }
  }

  // ---- Automation callbacks -----------------------------------------------

  private handleAutomationSpeedChange(speed: SupportedVirtualRemoteCommands | 'auto'): void {
    if (speed === 'auto') {
      // A still-running toilet boost may not be cut short — its own timer
      // will send 'auto' later (and defers to humidity state at that moment)
      if (this.toiletLightAutomation?.getState() === 'boosting') {
        this.log.debug('[Humidity] Boost klaar maar toilet-boost actief — ventilator blijft op HIGH');
        return;
      }
      // If a schedule is active, apply that speed; otherwise return to medium (CO₂ auto)
      const entry = this.scheduleEngine?.getActiveEntry();
      this.sendVirtualRemoteCommand(entry ? entry.speed : 'medium');
    } else {
      this.sendVirtualRemoteCommand(speed);
      // Notify mirror heater that a fan boost just started
      if (speed === 'high') {
        this.mirrorHeaterAutomation?.onFanBoostStarted();
      }
    }
  }

  private handleToiletSpeedChange(speed: SupportedVirtualRemoteCommands | 'auto'): void {
    if (this.humidityAutomation?.getState() === 'boosting') {
      this.log.debug('[Toilet] Humidity boost actief — toilet boost uitgesteld');
      return; // humidity has priority
    }
    if (speed === 'auto') {
      const entry = this.scheduleEngine?.getActiveEntry();
      this.sendVirtualRemoteCommand(entry ? entry.speed : 'medium');
    } else {
      this.sendVirtualRemoteCommand(speed);
    }
  }

  private handleScheduleSpeedChange(speed: SupportedVirtualRemoteCommands | null): void {
    if (this.humidityAutomation?.getState() === 'boosting') return; // humidity has priority
    this.sendVirtualRemoteCommand(speed ?? 'medium');
  }

  // ---- Daily reset --------------------------------------------------------

  /**
   * Schedules a daily failsafe reset at the configured time.
   * Sends 'medium' (CO₂ auto) every night so a forgotten manual override
   * never leaves the CVE stuck in an undesired state indefinitely.
   */
  private scheduleDailyReset(): void {
    const resetCfg = this.config.dailyReset;
    if (!resetCfg?.enabled) return;

    const time = resetCfg.time ?? DEFAULT_DAILY_RESET_TIME;
    const [hours, minutes] = time.split(':').map(Number);

    const now = new Date();
    const next = new Date();
    next.setHours(hours, minutes, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);

    const delay = next.getTime() - now.getTime();
    this.log.debug(
      `[DailyReset] Volgende reset ingepland om ${time} (over ${Math.round(delay / 60_000)} min)`,
    );

    this.dailyResetTimer = setTimeout(() => {
      this.dailyResetTimer = null;
      this.log.info(`[DailyReset] Dagelijkse reset om ${time} — terug naar automatisch`);
      this.humidityAutomation?.cancel();
      this.sendVirtualRemoteCommand('medium');
      this.scheduleDailyReset(); // opnieuw inplannen voor de volgende dag
    }, delay);
  }

  sendVirtualRemoteCommand(command: VirtualRemoteCommand | SupportedVirtualRemoteCommands): void {
    if (this.mqttClient) {
      this.mqttClient.setVirtualRemoteCommand(command as VirtualRemoteCommand);
    } else if (this.httpClient) {
      this.httpClient.setVirtualRemoteCommand(command as VirtualRemoteCommand);
    }
  }

  sendSpeed(speed: number): void {
    if (this.mqttClient) {
      this.mqttClient.setSpeed(speed);
    } else if (this.httpClient) {
      this.httpClient.setSpeed(speed);
    }
  }

  // ---- Config validation --------------------------------------------------

  isValidConfig(config: ConfigSchema): boolean {
    try {
      configSchema.parse(config);
      return true;
    } catch (err) {
      if (err instanceof ZodError) {
        const msgs = err.errors.map(e => `${e.message} at: ${e.path.join('.')}`);
        this.log.error(`[Platform] Config error: ${JSON.stringify(msgs)}`);
        return false;
      }
      this.log.error(`[Platform] Unknown config error: ${JSON.stringify(err)}`);
      return false;
    }
  }
}
