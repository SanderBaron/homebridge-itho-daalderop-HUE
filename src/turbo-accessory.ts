import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgeIthoDaalderop } from '@/platform';
import { IthoDaalderopAccessoryContext } from './types';
import { DEFAULT_TURBO_NAME, MANUFACTURER } from './settings';
import { ConfigSchema } from './config.schema';
import { serialNumberFromUUID } from './utils/serial';
import { PLUGIN_VERSION } from './version';

const DEFAULT_TURBO_MINUTES = 20;
const COUNTDOWN_INTERVAL_MS = 10_000;

export class TurboAccessory {
  private service: Service;

  private turboTimer: ReturnType<typeof setTimeout> | null = null;
  private turboCountdownInterval: ReturnType<typeof setInterval> | null = null;
  private turboEndsAt: number | null = null;

  readonly turboMinutes: number;

  constructor(
    private readonly platform: HomebridgeIthoDaalderop,
    private readonly accessory: PlatformAccessory<IthoDaalderopAccessoryContext>,
    private readonly config: ConfigSchema,
  ) {
    this.turboMinutes = config.automation?.turbo?.durationMinutes ?? DEFAULT_TURBO_MINUTES;

    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
    infoService?.setCharacteristic(this.platform.Characteristic.Manufacturer, MANUFACTURER);
    infoService?.setCharacteristic(this.platform.Characteristic.Model, DEFAULT_TURBO_NAME);
    infoService?.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      serialNumberFromUUID(this.accessory.UUID),
    );
    infoService?.setCharacteristic(
      this.platform.Characteristic.FirmwareRevision,
      PLUGIN_VERSION || '2.0',
    );

    // Valve: the only HomeKit service with native countdown (RemainingDuration).
    // Icon can be changed by the user in the Home app (long press → edit → icon).
    this.service =
      this.accessory.getServiceById(this.platform.Service.Valve, 'turbo') ||
      this.accessory.addService(this.platform.Service.Valve, DEFAULT_TURBO_NAME, 'turbo');

    this.service.setCharacteristic(this.platform.Characteristic.Name, DEFAULT_TURBO_NAME);
    this.service.setCharacteristic(
      this.platform.Characteristic.ValveType,
      this.platform.Characteristic.ValveType.GENERIC_VALVE,
    );
    this.service.setCharacteristic(this.platform.Characteristic.Active, 0);
    this.service.setCharacteristic(this.platform.Characteristic.InUse, 0);
    this.service.setCharacteristic(
      this.platform.Characteristic.SetDuration,
      this.turboMinutes * 60,
    );
    this.service.setCharacteristic(this.platform.Characteristic.RemainingDuration, 0);

    this.service
      .getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleSetActive.bind(this))
      .onGet(this.handleGetActive.bind(this));

    this.service
      .getCharacteristic(this.platform.Characteristic.RemainingDuration)
      .onGet(this.handleGetRemainingDuration.bind(this));
  }

  get log() {
    const prefix = `[${DEFAULT_TURBO_NAME}]`;
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      info: (...a: any[]) => this.platform.log.info(prefix, ...a),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      debug: (...a: any[]) => {
        if (this.config.verboseLogging) this.platform.log.debug(prefix, ...a);
      },
    };
  }

  // Called by the platform when FanInfo leaves 'high' externally (e.g. CO2 override)
  notifyFanLeftHigh(): void {
    if (this.turboTimer) {
      this.log.debug('FanInfo left high externally — cancelling turbo');
      this.cancelTurbo();
    }
  }

  handleSetActive(value: CharacteristicValue): void {
    if ((value as number) === 1) {
      this.startTurbo();
    } else {
      this.stopTurbo();
    }
  }

  handleGetActive(): CharacteristicValue {
    return this.turboTimer !== null ? 1 : 0;
  }

  handleGetRemainingDuration(): CharacteristicValue {
    if (!this.turboEndsAt) return 0;
    return Math.max(0, Math.round((this.turboEndsAt - Date.now()) / 1000));
  }

  destroy(): void {
    this.cancelTurbo();
  }

  private startTurbo(): void {
    this.cancelTurbo();

    const durationSeconds = this.turboMinutes * 60;
    this.turboEndsAt = Date.now() + durationSeconds * 1000;

    this.service.updateCharacteristic(this.platform.Characteristic.Active, 1);
    this.service.updateCharacteristic(this.platform.Characteristic.InUse, 1);
    this.service.updateCharacteristic(
      this.platform.Characteristic.RemainingDuration,
      durationSeconds,
    );

    this.platform.sendVirtualRemoteCommand('high');
    this.platform.notifyManualOverride();
    this.log.info(`ON → high for ${this.turboMinutes} min`);

    this.turboCountdownInterval = setInterval(() => {
      const remaining = this.handleGetRemainingDuration() as number;
      this.service.updateCharacteristic(
        this.platform.Characteristic.RemainingDuration,
        remaining,
      );
    }, COUNTDOWN_INTERVAL_MS);

    this.turboTimer = setTimeout(() => this.stopTurbo(), durationSeconds * 1000);
  }

  private stopTurbo(): void {
    this.cancelTurbo();
    this.platform.sendVirtualRemoteCommand('medium');
    this.platform.notifyManualOverride();
    this.log.info('OFF → auto');
  }

  private cancelTurbo(): void {
    if (this.turboTimer) { clearTimeout(this.turboTimer); this.turboTimer = null; }
    if (this.turboCountdownInterval) { clearInterval(this.turboCountdownInterval); this.turboCountdownInterval = null; }
    this.turboEndsAt = null;
    this.service.updateCharacteristic(this.platform.Characteristic.Active, 0);
    this.service.updateCharacteristic(this.platform.Characteristic.InUse, 0);
    this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, 0);
  }
}
