import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { HomebridgeIthoDaalderop } from '@/platform';
import { IthoDaalderopAccessoryContext, IthoStatusSanitizedPayload } from './types';
import { CO2_LEVEL_SENSOR_KEY, DEFAULT_AIR_QUALITY_SENSOR_NAME, MANUFACTURER } from './settings';
import { isNil } from './utils/lang';
import { ConfigSchema } from './config.schema';
import { serialNumberFromUUID } from './utils/serial';
import { PLUGIN_VERSION } from './version';

// CO2 ppm thresholds for CarbonDioxideDetected characteristic
const CO2_DETECTED_THRESHOLD = 1500;

export class AirQualitySensorAccessory {
  private airQualityService: Service;
  private temperatureService: Service;
  private humidityService: Service;
  private co2Service: Service;

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

    // Air quality (CO2-based rating)
    this.airQualityService =
      this.accessory.getService(this.platform.Service.AirQualitySensor) ||
      this.accessory.addService(this.platform.Service.AirQualitySensor, 'Air Quality');

    this.airQualityService.setCharacteristic(
      this.platform.Characteristic.AirQuality,
      this.platform.Characteristic.AirQuality.GOOD,
    );
    this.airQualityService.setCharacteristic(this.platform.Characteristic.StatusActive, true);
    this.airQualityService
      .getCharacteristic(this.platform.Characteristic.AirQuality)
      .onGet(this.handleGetAirQuality.bind(this));

    // Temperature sensor
    this.temperatureService =
      this.accessory.getService(this.platform.Service.TemperatureSensor) ||
      this.accessory.addService(this.platform.Service.TemperatureSensor, 'Temperature');

    this.temperatureService.setCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      0,
    );
    this.temperatureService.setCharacteristic(this.platform.Characteristic.StatusActive, true);

    // Humidity sensor
    this.humidityService =
      this.accessory.getService(this.platform.Service.HumiditySensor) ||
      this.accessory.addService(this.platform.Service.HumiditySensor, 'Humidity');

    this.humidityService.setCharacteristic(
      this.platform.Characteristic.CurrentRelativeHumidity,
      0,
    );
    this.humidityService.setCharacteristic(this.platform.Characteristic.StatusActive, true);

    // CO2 sensor
    this.co2Service =
      this.accessory.getService(this.platform.Service.CarbonDioxideSensor) ||
      this.accessory.addService(this.platform.Service.CarbonDioxideSensor, 'CO2');

    this.co2Service.setCharacteristic(
      this.platform.Characteristic.CarbonDioxideDetected,
      this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
    );
    this.co2Service.setCharacteristic(this.platform.Characteristic.CarbonDioxideLevel, 400);
    this.co2Service.setCharacteristic(this.platform.Characteristic.StatusActive, true);
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
    const ppm = data[CO2_LEVEL_SENSOR_KEY];

    this.airQualityService.updateCharacteristic(
      this.platform.Characteristic.AirQuality,
      this.getAirQualityFromPpm(ppm),
    );

    if (!isNil(data.temp)) {
      this.temperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        parseFloat(data.temp!.toFixed(1)),
      );
    }

    if (!isNil(data.hum)) {
      this.humidityService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        Math.round(data.hum!),
      );
    }

    if (!isNil(ppm)) {
      this.co2Service.updateCharacteristic(
        this.platform.Characteristic.CarbonDioxideLevel,
        ppm!,
      );
      this.co2Service.updateCharacteristic(
        this.platform.Characteristic.CarbonDioxideDetected,
        ppm! >= CO2_DETECTED_THRESHOLD
          ? this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_ABNORMAL
          : this.platform.Characteristic.CarbonDioxideDetected.CO2_LEVELS_NORMAL,
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
      this.airQualityService.getCharacteristic(this.platform.Characteristic.AirQuality).value ??
      this.platform.Characteristic.AirQuality.UNKNOWN
    );
  }
}
