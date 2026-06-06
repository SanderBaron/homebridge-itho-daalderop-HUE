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

export class FanAccessory {
  private fanService: Service;
  private turboService: Service;
  private informationService: Service | undefined;

  lastStatusPayload: IthoStatusSanitizedPayload | null = null;
  private lastStatePayload: number | null = null;

  private turboTimer: ReturnType<typeof setTimeout> | null = null;

  readonly turboMinutes: number;

  constructor(
    private readonly platform: HomebridgeIthoDaalderop,
    private readonly accessory: PlatformAccessory<IthoDaalderopAccessoryContext>,
    private readonly config: ConfigSchema,
  ) {
    this.turboMinutes = config.automation?.turbo?.durationMinutes ?? DEFAULT_TURBO_MINUTES;
    const turboLabel = `Turbo (${this.turboMinutes} min)`;

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
    const oldValve = this.accessory.getServiceById(this.platform.Service.Valve, 'turbo');
    if (oldValve) this.accessory.removeService(oldValve);

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
    if (oldTargetFanState) this.fanService.removeCharacteristic(oldTargetFanState);

    this.fanService
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 1 })
      .onGet(this.handleGetRotationSpeed.bind(this));

    this.fanService
      .getCharacteristic(this.platform.Characteristic.CurrentFanState)
      .onGet(this.handleGetCurrentFanState.bind(this));

    // ---- Turbo — Switch sub-service ----
    // Simple on/off switch. Name shows the configured duration: "Turbo (20 min)".
    // HomeKit will show this label on the button. Auto-reverts after durationMinutes.
    this.turboService =
      this.accessory.getServiceById(this.platform.Service.Switch, 'turbo') ||
      this.accessory.addService(this.platform.Service.Switch, turboLabel, 'turbo');

    // Set both Name and ConfiguredName so HomeKit shows the correct label.
    // ConfiguredName is what the Home app actually displays — without it HomeKit
    // defaults to the accessory name ("Mechanical Ventilation") for all sub-services.
    this.turboService.setCharacteristic(this.platform.Characteristic.Name, turboLabel);
    this.turboService.updateCharacteristic(this.platform.Characteristic.ConfiguredName, turboLabel);
    this.turboService.setCharacteristic(this.platform.Characteristic.On, false);

    this.turboService
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleSetTurbo.bind(this))
      .onGet(this.handleGetTurbo.bind(this));
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

  // ---- Turbo handlers ----------------------------------------------------

  handleSetTurbo(value: CharacteristicValue): void {
    if (value as boolean) {
      this.startTurbo();
    } else {
      this.stopTurbo();
    }
  }

  handleGetTurbo(): CharacteristicValue {
    return this.turboTimer !== null;
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

  destroy(): void {
    this.cancelTurbo();
  }

  // ---- Private -----------------------------------------------------------

  private startTurbo(): void {
    this.cancelTurbo();
    this.platform.sendVirtualRemoteCommand('high');
    this.platform.notifyManualOverride();
    this.log.info(`Turbo ON → high for ${this.turboMinutes} min`);
    this.turboTimer = setTimeout(() => this.stopTurbo(), this.turboMinutes * 60_000);
  }

  private stopTurbo(): void {
    this.cancelTurbo();
    this.platform.sendVirtualRemoteCommand('medium');
    this.platform.notifyManualOverride();
    this.log.info('Turbo OFF → auto');
  }

  private cancelTurbo(): void {
    if (this.turboTimer) { clearTimeout(this.turboTimer); this.turboTimer = null; }
    this.turboService.updateCharacteristic(this.platform.Characteristic.On, false);
  }

  private speedToFanState(speed: number): number {
    if (speed === 0) return this.platform.Characteristic.CurrentFanState.INACTIVE;
    if (speed < ACTIVE_SPEED_THRESHOLD) return this.platform.Characteristic.CurrentFanState.IDLE;
    return this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
  }
}
