import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgeIthoDaalderop } from '@/platform';
import { IthoDaalderopAccessoryContext, IthoStatusSanitizedPayload } from './types';
import { CO2_LEVEL_SENSOR_KEY, DEFAULT_AIR_QUALITY_SENSOR_NAME, MANUFACTURER } from './settings';
import { isNil } from './utils/lang';
import { ConfigSchema } from './config.schema';
import { serialNumberFromUUID } from './utils/serial';
import { PLUGIN_VERSION } from './version';

export class AirQualitySensorAccessory {
  private service: Service;

  constructor(
    private readonly platform: HomebridgeIthoDaalderop,
    private readonly accessory: PlatformAccessory<IthoDaalderopAccessoryContext>,
    private readonly config: ConfigSchema,
  ) {
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation);
    infoService?.setCharacteristic(this.platform.Characteristic.Manufacturer, MANUFACTURER);
    infoService?.setCharacteristic(
      this.platform.Characteristic.Model,
      DEFAULT_AIR_QUALITY_SENSOR_NAME,
    );
    infoService?.setCharacteristic(
      this.platform.Characteristic.SerialNumber,
      serialNumberFromUUID(this.accessory.UUID),
    );
    infoService?.setCharacteristic(
      this.platform.Characteristic.FirmwareRevision,
      PLUGIN_VERSION || '2.0',
    );

    this.service =
      this.accessory.getService(this.platform.Service.AirQualitySensor) ||
      this.accessory.addService(this.platform.Service.AirQualitySensor);

    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.displayName);
    this.service.setCharacteristic(
      this.platform.Characteristic.AirQuality,
      this.platform.Characteristic.AirQuality.GOOD,
    );
    this.service.setCharacteristic(this.platform.Characteristic.StatusActive, true);

    this.service
      .getCharacteristic(this.platform.Characteristic.AirQuality)
      .onGet(this.handleGetAirQuality.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.StatusActive).onGet(() => true);
  }

  get log() {
    const prefix = `[${this.accessory.displayName}]`;
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      info: (...a: any[]) => this.platform.log.info(prefix, ...a),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      debug: (...a: any[]) => {
        if (this.config.verboseLogging) this.platform.log.debug(prefix, ...a);
      },
    };
  }

  // Called by platform when status payload arrives
  handleStatusResponse(data: IthoStatusSanitizedPayload): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.AirQuality,
      this.getAirQualityFromPpm(data[CO2_LEVEL_SENSOR_KEY]),
    );

    if (!isNil(data.hum)) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        Math.round(data.hum!),
      );
    }

    if (!isNil(data.temp)) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        parseFloat(data.temp!.toFixed(1)),
      );
    }

    if (!isNil(data[CO2_LEVEL_SENSOR_KEY])) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.CarbonDioxideLevel,
        data[CO2_LEVEL_SENSOR_KEY]!,
      );
    }
  }

  private getAirQualityFromPpm(ppm: number | null): number {
    if (isNil(ppm)) return this.platform.Characteristic.AirQuality.UNKNOWN;
    if (ppm! < 350) return this.platform.Characteristic.AirQuality.EXCELLENT;
    if (ppm! < 1000) return this.platform.Characteristic.AirQuality.GOOD;
    if (ppm! < 2500) return this.platform.Characteristic.AirQuality.FAIR;
    if (ppm! < 5000) return this.platform.Characteristic.AirQuality.INFERIOR;
    return this.platform.Characteristic.AirQuality.POOR;
  }

  async handleGetAirQuality(): Promise<CharacteristicValue> {
    return (
      this.service.getCharacteristic(this.platform.Characteristic.AirQuality).value ??
      this.platform.Characteristic.AirQuality.UNKNOWN
    );
  }
}
