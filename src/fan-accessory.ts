import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgeIthoDaalderop } from '@/platform';
import { IthoDaalderopAccessoryContext, IthoStatusSanitizedPayload } from './types';
import {
  ACTIVE_SPEED_THRESHOLD,
  ACTUAL_MODE_KEY,
  DEFAULT_FAN_NAME,
  FAN_INFO_KEY,
  MANUFACTURER,
  MAX_ROTATION_SPEED,
  REQ_FAN_SPEED_KEY,
  SPEED_STATUS_KEY,
} from './settings';
import {
  getRotationSpeedFromActualMode,
  getRotationSpeedFromFanInfo,
  getVirtualRemoteCommandForRotationSpeed,
} from './utils/api';
import { ConfigSchema } from './config.schema';
import { isNil } from './utils/lang';
import { serialNumberFromUUID } from './utils/serial';
import { PLUGIN_VERSION } from './version';

export class FanAccessory {
  private service: Service;
  private informationService: Service | undefined;
  private lastStatusPayload: IthoStatusSanitizedPayload | null = null;
  private lastStatePayload: number | null = null;

  constructor(
    private readonly platform: HomebridgeIthoDaalderop,
    private readonly accessory: PlatformAccessory<IthoDaalderopAccessoryContext>,
    private readonly config: ConfigSchema,
  ) {
    this.log.debug('Initializing fan accessory');

    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
    this.informationService = infoService;

    this.informationService?.setCharacteristic(
      this.platform.Characteristic.Manufacturer,
      MANUFACTURER,
    );
    this.informationService?.setCharacteristic(
      this.platform.Characteristic.Model,
      DEFAULT_FAN_NAME,
    );
    this.informationService?.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      serialNumberFromUUID(this.accessory.UUID),
    );
    this.informationService?.setCharacteristic(
      this.platform.Characteristic.FirmwareRevision,
      PLUGIN_VERSION || '2.0',
    );

    this.service =
      this.accessory.getService(this.platform.Service.Fanv2) ||
      this.accessory.addService(this.platform.Service.Fanv2);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.service.setCharacteristic(
      this.platform.Characteristic.Active,
      this.platform.Characteristic.Active.ACTIVE,
    );

    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleSetActive.bind(this))
      .onGet(this.handleGetActive.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .setProps(
        this.allowsManualSpeedControl
          ? { minValue: 0, maxValue: 100, minStep: 1 }
          : { minValue: 0, maxValue: 100, minStep: Math.round(100 / 3) },
      )
      .onSet(this.handleSetRotationSpeed.bind(this))
      .onGet(this.handleGetRotationSpeed.bind(this));

    this.service
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

  get allowsManualSpeedControl(): boolean {
    // CO2 sensor and non-CVE devices require virtual remote commands, not raw 0–254 speed
    // https://github.com/arjenhiemstra/ithowifi/wiki/CO2-sensors
    return !this.config.device?.co2Sensor && !this.config.device?.nonCve;
  }

  // Called by platform when MQTT status arrives
  handleStatusResponse(payload: IthoStatusSanitizedPayload): void {
    this.lastStatusPayload = payload;
    const speed = (payload[SPEED_STATUS_KEY] ?? payload[REQ_FAN_SPEED_KEY] ?? 0) as number;
    this.updateCurrentFanState(speed);
  }

  // Called by platform when MQTT state (raw speed) arrives
  handleSpeedResponse(speed: number): void {
    this.lastStatePayload = speed;
  }

  private updateCurrentFanState(rotationSpeed: number): void {
    let state: number;
    if (rotationSpeed === 0) {
      state = this.platform.Characteristic.CurrentFanState.INACTIVE;
    } else if (rotationSpeed < ACTIVE_SPEED_THRESHOLD) {
      state = this.platform.Characteristic.CurrentFanState.IDLE;
    } else {
      state = this.platform.Characteristic.CurrentFanState.BLOWING_AIR;
    }
    this.service.updateCharacteristic(this.platform.Characteristic.CurrentFanState, state);
  }

  private sendCommand(speedValue: number): void {
    if (!this.allowsManualSpeedControl) {
      const cmd = getVirtualRemoteCommandForRotationSpeed(speedValue);
      this.platform.sendVirtualRemoteCommand(cmd);
    } else {
      const rawSpeed = Math.round(speedValue * 2.54);
      this.platform.sendSpeed(rawSpeed);
    }
    this.platform.notifyManualOverride();
  }

  // ---- HomeKit SET/GET handlers -------------------------------------------

  handleSetRotationSpeed(value: CharacteristicValue): void {
    const speedValue = Number(value);
    if (Number.isNaN(speedValue)) {
      this.log.error(`RotationSpeed: invalid value ${value}`);
      return;
    }
    this.log.info(`Set RotationSpeed → ${speedValue}/${MAX_ROTATION_SPEED}`);
    this.sendCommand(speedValue);
  }

  handleSetActive(value: CharacteristicValue): void {
    const activate = value === this.platform.Characteristic.Active.ACTIVE;
    this.log.info(`Set Active → ${activate ? 'ACTIVE' : 'INACTIVE'}`);
    this.service.updateCharacteristic(this.platform.Characteristic.Active, value);
    this.sendCommand(activate ? ACTIVE_SPEED_THRESHOLD : 0);
  }

  handleGetActive(): CharacteristicValue {
    const rotationSpeed = this.service.getCharacteristic(
      this.platform.Characteristic.RotationSpeed,
    ).value;

    if (isNil(rotationSpeed)) {
      return this.platform.Characteristic.Active.ACTIVE;
    }

    return (rotationSpeed as number) > 0
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
  }

  async handleGetRotationSpeed(): Promise<CharacteristicValue> {
    if (!this.allowsManualSpeedControl) {
      if (this.config.device?.nonCve) {
        const mode = this.lastStatusPayload?.[ACTUAL_MODE_KEY];
        return mode ? getRotationSpeedFromActualMode(mode) : 0;
      }
      if (this.config.device?.co2Sensor) {
        const fanInfo = this.lastStatusPayload?.[FAN_INFO_KEY];
        return fanInfo ? getRotationSpeedFromFanInfo(fanInfo) : 0;
      }
    }
    return Math.round((this.lastStatePayload ?? 0) / 2.54);
  }

  handleGetCurrentFanState(): CharacteristicValue {
    return (
      this.service.getCharacteristic(this.platform.Characteristic.CurrentFanState).value ?? 0
    );
  }
}
