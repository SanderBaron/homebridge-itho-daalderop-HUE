import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgeIthoDaalderop } from '@/platform';
import { IthoDaalderopAccessoryContext, IthoStatusSanitizedPayload } from './types';
import {
  ACTIVE_SPEED_THRESHOLD,
  DEFAULT_FAN_NAME,
  FAN_INFO_KEY,
  MANUFACTURER,
  REQ_FAN_SPEED_KEY,
  SPEED_STATUS_KEY,
} from './settings';
import { ConfigSchema } from './config.schema';
import { serialNumberFromUUID } from './utils/serial';
import { PLUGIN_VERSION } from './version';

const DEFAULT_TURBO_MINUTES = 20;
const COUNTDOWN_INTERVAL_MS = 10_000; // update countdown every 10 s

export class FanAccessory {
  private fanService: Service;
  private turboService: Service;
  private informationService: Service | undefined;

  private lastStatusPayload: IthoStatusSanitizedPayload | null = null;
  private lastStatePayload: number | null = null;

  private turboTimer: ReturnType<typeof setTimeout> | null = null;
  private turboCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private turboEndsAt: number | null = null;

  private readonly turboMinutes: number;

  constructor(
    private readonly platform: HomebridgeIthoDaalderop,
    private readonly accessory: PlatformAccessory<IthoDaalderopAccessoryContext>,
    private readonly config: ConfigSchema,
  ) {
    this.turboMinutes = config.automation?.turbo?.durationMinutes ?? DEFAULT_TURBO_MINUTES;

    this.log.debug('Initializing fan accessory');

    // ---- Accessory information ----
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
    this.informationService = infoService;
    this.informationService?.setCharacteristic(this.platform.Characteristic.Manufacturer, MANUFACTURER);
    this.informationService?.setCharacteristic(this.platform.Characteristic.Model, DEFAULT_FAN_NAME);
    this.informationService?.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      serialNumberFromUUID(this.accessory.UUID),
    );
    this.informationService?.setCharacteristic(
      this.platform.Characteristic.FirmwareRevision,
      PLUGIN_VERSION || '2.0',
    );

    // ---- Remove stale services from previous versions ----
    const oldSwitch = this.accessory.getService(this.platform.Service.Switch);
    if (oldSwitch) this.accessory.removeService(oldSwitch);

    // ---- Fan service (read-only status display) ----
    this.fanService =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2, DEFAULT_FAN_NAME);

    this.fanService.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.fanService.setCharacteristic(
      this.platform.Characteristic.Active,
      this.platform.Characteristic.Active.ACTIVE,
    );

    // Remove TargetFanState if cached from a previous version
    const oldTargetFanState = this.fanService.getCharacteristic(
      this.platform.Characteristic.TargetFanState,
    );
    if (oldTargetFanState) {
      this.fanService.removeCharacteristic(oldTargetFanState);
    }

    // Speed: read-only, shows actual measured speed from MQTT
    this.fanService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.handleGetRotationSpeed.bind(this));

    this.fanService
      .getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.handleGetCurrentFanState.bind(this));

    // ---- Turbo — Valve service with countdown timer ----
    // Valve is used (not Switch) because it supports SetDuration + RemainingDuration,
    // giving a live countdown display just like irrigation tiles.
    this.turboService =
      this.accessory.getServiceById(this.platform.Service.Valve, 'turbo') ||
      this.accessory.addService(this.platform.Service.Valve, 'Turbo', 'turbo');

    this.turboService.setCharacteristic(this.platform.Characteristic.Name, 'Turbo');
    this.turboService.setCharacteristic(
      this.platform.Characteristic.ValveType,
      this.platform.Characteristic.ValveType.GENERIC_VALVE,
    );
    this.turboService.setCharacteristic(this.platform.Characteristic.Active, 0);
    this.turboService.setCharacteristic(this.platform.Characteristic.InUse, 0);
    this.turboService.setCharacteristic(
      this.platform.Characteristic.SetDuration,
      this.turboMinutes * 60,
    );
    this.turboService.setCharacteristic(this.platform.Characteristic.RemainingDuration, 0);

    this.turboService
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleSetTurboActive.bind(this))
      .onGet(this.handleGetTurboActive.bind(this));

    this.turboService
      .getCharacteristic(this.platform.Characteristic.RemainingDuration)
      .onGet(this.handleGetRemainingDuration.bind(this));
  }

  get log() {
    const prefix = `[${this.accessory.displayName}]`;
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      info: (...a: any[]) => this.platform.log.info(prefix, ...a),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      warn: (...a: any[]) => this.platform.log.warn(prefix, ...a),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      error: (...a: any[]) => this.platform.log.error(prefix, ...a),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      debug: (...a: any[]) => {
        if (this.config.verboseLogging) this.platform.log.debug(prefix, ...a);
      },
    };
  }

  // ---- Called by platform on MQTT updates --------------------------------

  handleStatusResponse(payload: IthoStatusSanitizedPayload): void {
    this.lastStatusPayload = payload;
    const speed = (payload[SPEED_STATUS_KEY] ?? payload[REQ_FAN_SPEED_KEY] ?? 0) as number;

    this.fanService.updateCharacteristic(
      this.platform.Characteristic.RotationSpeed,
      Math.round(speed),
    );
    this.fanService.updateCharacteristic(
      this.platform.Characteristic.CurrentFanState,
      this.speedToFanState(speed),
    );

    // If the device externally left high mode, cancel our turbo timer
    const fanInfo = payload[FAN_INFO_KEY];
    if (fanInfo !== 'high' && this.turboTimer) {
      this.log.debug('FanInfo left high externally — cancelling turbo');
      this.cancelTurbo();
    }
  }

  handleSpeedResponse(speed: number): void {
    this.lastStatePayload = speed;
  }

  // ---- Turbo valve handlers ----------------------------------------------

  handleSetTurboActive(value: CharacteristicValue): void {
    if ((value as number) === 1) {
      this.startTurbo();
    } else {
      this.stopTurbo();
    }
  }

  handleGetTurboActive(): CharacteristicValue {
    return this.turboTimer !== null ? 1 : 0;
  }

  handleGetRemainingDuration(): CharacteristicValue {
    if (!this.turboEndsAt) return 0;
    return Math.max(0, Math.round((this.turboEndsAt - Date.now()) / 1000));
  }

  // ---- Fan display handlers (read-only) ----------------------------------

  handleGetRotationSpeed(): CharacteristicValue {
    const speed = this.lastStatusPayload?.[SPEED_STATUS_KEY];
    if (speed !== null && speed !== undefined) return Math.round(speed as number);
    return Math.round((this.lastStatePayload ?? 0) / 2.54);
  }

  handleGetCurrentFanState(): CharacteristicValue {
    return (
      this.fanService.getCharacteristic(this.platform.Characteristic.CurrentFanState).value ?? 0
    );
  }

  // ---- Private -----------------------------------------------------------

  private startTurbo(): void {
    this.cancelTurbo();

    const durationSeconds = this.turboMinutes * 60;
    this.turboEndsAt = Date.now() + durationSeconds * 1000;

    this.turboService.updateCharacteristic(this.platform.Characteristic.Active, 1);
    this.turboService.updateCharacteristic(this.platform.Characteristic.InUse, 1);
    this.turboService.updateCharacteristic(
      this.platform.Characteristic.RemainingDuration,
      durationSeconds,
    );

    this.platform.sendVirtualRemoteCommand('high');
    this.platform.notifyManualOverride();
    this.log.info(`Turbo ON → ${this.turboMinutes} min`);

    // Live countdown update every 10 seconds
    this.turboCountdownInterval = setInterval(() => {
      const remaining = this.handleGetRemainingDuration() as number;
      this.turboService.updateCharacteristic(
        this.platform.Characteristic.RemainingDuration,
        remaining,
      );
    }, COUNTDOWN_INTERVAL_MS);

    this.turboTimer = setTimeout(() => {
      this.stopTurbo();
    }, durationSeconds * 1000);
  }

  private stopTurbo(): void {
    this.cancelTurbo();
    this.platform.sendVirtualRemoteCommand('medium');
    this.platform.notifyManualOverride();
    this.log.info('Turbo OFF → auto');
  }

  /** Cancel timer + interval + reset valve state, without sending any MQTT command */
  private cancelTurbo(): void {
    if (this.turboTimer) {
      clearTimeout(this.turboTimer);
      this.turboTimer = null;
    }
    if (this.turboCountdownInterval) {
      clearInterval(this.turboCountdownInterval);
      this.turboCountdownInterval = null;
    }
    this.turboEndsAt = null;

    this.turboService.updateCharacteristic(this.platform.Characteristic.Active, 0);
    this.turboService.updateCharacteristic(this.platform.Characteristic.InUse, 0);
    this.turboService.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
  }

  private speedToFanState(speed: number): number {
    if (speed === 0) return this.platform.Characteristic.CurrentFanState.INACTIVE;
    if (speed < ACTIVE_SPEED_THRESHOLD) return this.platform.Characteristic.CurrentFanState.IDLE;
    return this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
  }
}
