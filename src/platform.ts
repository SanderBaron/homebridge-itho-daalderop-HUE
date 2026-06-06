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
  DEFAULT_TURBO_NAME,
  DEFAULT_HUMIDITY_BOOST_THRESHOLD,
  DEFAULT_HUMIDITY_COOLDOWN_MINUTES,
  DEFAULT_HUMIDITY_DROP_THRESHOLD,
  DEFAULT_MANUAL_OVERRIDE_MINUTES,
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
import { TurboAccessory } from './turbo-accessory';
import { MqttApi } from './api/mqtt';
import { HttpApi } from './api/http';
import { sanitizeStatusPayload } from './utils/api';
import { HumidityAutomation } from './automations/humidity-automation';
import { ScheduleEngine } from './automations/schedule-engine';

export class HomebridgeIthoDaalderop implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public cachedAccessories: PlatformAccessory<IthoDaalderopAccessoryContext>[] = [];

  private config: ConfigSchema;
  private mqttClient: MqttApi | null = null;
  private httpClient: HttpApi | null = null;

  private fanAccessory: FanAccessory | null = null;
  private airQualityAccessory: AirQualitySensorAccessory | null = null;
  private turboAccessory: TurboAccessory | null = null;

  private humidityAutomation: HumidityAutomation | null = null;
  private scheduleEngine: ScheduleEngine | null = null;

  private manualOverrideUntil: number | null = null;
  private readonly manualOverrideMinutes: number;

  constructor(public readonly log: Logger, config: PlatformConfig, public readonly api: API) {
    this.config = config as ConfigSchema;
    this.manualOverrideMinutes =
      (config as ConfigSchema).automation?.humidity?.manualOverrideMinutes ??
      DEFAULT_MANUAL_OVERRIDE_MINUTES;

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
    this.setupAutomations();
    this.registerAccessories();
  }

  private handleShutdown(): void {
    this.log.debug('[Platform] Shutting down');
    this.mqttClient?.end();
    this.humidityAutomation?.destroy();
    this.scheduleEngine?.destroy();
    this.turboAccessory?.destroy();
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

  private setupAutomations(): void {
    const humCfg = this.config.automation?.humidity;

    this.humidityAutomation = new HumidityAutomation(
      {
        enabled: humCfg?.enabled !== false,
        boostThreshold: humCfg?.boostThreshold ?? DEFAULT_HUMIDITY_BOOST_THRESHOLD,
        dropThreshold: humCfg?.dropThreshold ?? DEFAULT_HUMIDITY_DROP_THRESHOLD,
        cooldownMinutes: humCfg?.cooldownMinutes ?? DEFAULT_HUMIDITY_COOLDOWN_MINUTES,
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
  }

  private registerAccessories(): void {
    this.addFanAccessory(DEFAULT_FAN_NAME, this.api.hap.uuid.generate(DEFAULT_FAN_NAME));
    this.addAirQualitySensor(
      DEFAULT_AIR_QUALITY_SENSOR_NAME,
      this.api.hap.uuid.generate(DEFAULT_AIR_QUALITY_SENSOR_NAME),
    );
    this.addTurboAccessory(
      DEFAULT_TURBO_NAME,
      this.api.hap.uuid.generate(DEFAULT_TURBO_NAME),
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
    this.fanAccessory.onFanLeftHigh = () => this.turboAccessory?.notifyFanLeftHigh();

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

  private addTurboAccessory(displayName: string, uuid: string): void {
    const existing = this.cachedAccessories.find(
      a => a.UUID === uuid,
    ) as PlatformAccessory<IthoDaalderopAccessoryContext> | undefined;

    let accessory: PlatformAccessory<IthoDaalderopAccessoryContext>;
    if (existing) {
      this.log.info('[Platform] Restoring Turbo accessory from cache');
      this.api.updatePlatformAccessories([existing]);
      accessory = existing;
    } else {
      this.log.info('[Platform] Registering new Turbo accessory');
      accessory = new this.api.platformAccessory<IthoDaalderopAccessoryContext>(
        displayName,
        uuid,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }
    this.turboAccessory = new TurboAccessory(this, accessory, this.config);
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

    if (payload.hum !== null && payload.hum !== undefined) {
      this.humidityAutomation?.update(payload.hum);
    }
  }

  // ---- Automation callbacks -----------------------------------------------

  private handleAutomationSpeedChange(speed: SupportedVirtualRemoteCommands | 'auto'): void {
    if (this.isManualOverrideActive()) {
      this.log.debug('[Platform] Manual override active — ignoring humidity automation');
      return;
    }

    if (speed === 'auto') {
      // If a schedule is active, apply that speed; otherwise return to medium
      const entry = this.scheduleEngine?.getActiveEntry();
      this.sendVirtualRemoteCommand(entry ? entry.speed : 'medium');
    } else {
      this.sendVirtualRemoteCommand(speed);
    }
  }

  private handleScheduleSpeedChange(speed: SupportedVirtualRemoteCommands | null): void {
    if (this.isManualOverrideActive()) return;
    if (this.humidityAutomation?.getState() === 'boost') return; // humidity has priority

    this.sendVirtualRemoteCommand(speed ?? 'medium');
  }

  // ---- Public API for accessories -----------------------------------------

  /** Notify the platform that the user manually changed the fan in HomeKit. */
  notifyManualOverride(): void {
    const ms = this.manualOverrideMinutes * 60_000;
    this.manualOverrideUntil = Date.now() + ms;
    this.log.info(`[Platform] Manual override active for ${this.manualOverrideMinutes} min`);
    if (this.humidityAutomation?.getState() !== 'idle') {
      this.humidityAutomation?.cancel();
    }
  }

  isManualOverrideActive(): boolean {
    if (!this.manualOverrideUntil) return false;
    if (Date.now() > this.manualOverrideUntil) {
      this.manualOverrideUntil = null;
      return false;
    }
    return true;
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
