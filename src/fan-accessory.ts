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

export class FanAccessory {
  private fanService: Service;
  private informationService: Service | undefined;

  lastStatusPayload: IthoStatusSanitizedPayload | null = null;
  private lastStatePayload: number | null = null;

  /** Callback invoked when FanInfo leaves 'high' (e.g. CO2 override or timer) */
  onFanLeftHigh?: () => void;

  constructor(
    private readonly platform: HomebridgeIthoDaalderop,
    private readonly accessory: PlatformAccessory<IthoDaalderopAccessoryContext>,
    private readonly config: ConfigSchema,
  ) {
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
    for (const stale of [
      this.accessory.getService(this.platform.Service.Switch),
      this.accessory.getServiceById(this.platform.Service.Valve, 'turbo'),
    ]) {
      if (stale) this.accessory.removeService(stale);
    }

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

    // Notify turbo accessory if device externally left high mode
    const fanInfo = payload[FAN_INFO_KEY];
    if (fanInfo !== 'high') {
      this.onFanLeftHigh?.();
    }
  }

  handleSpeedResponse(speed: number): void {
    this.lastStatePayload = speed;
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

  private speedToFanState(speed: number): number {
    if (speed === 0) return this.platform.Characteristic.CurrentFanState.INACTIVE;
    if (speed < ACTIVE_SPEED_THRESHOLD) return this.platform.Characteristic.CurrentFanState.IDLE;
    return this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
  }
}
