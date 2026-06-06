import { Characteristic } from '@homebridge/hap-nodejs';
import { ConfigSchema } from './config.schema';
import { FanAccessory } from './fan-accessory';
import { accessoryMock, platformMock } from './mocks/platform';
import { vi } from 'vitest';
import { PLATFORM_NAME, DEFAULT_BRIDGE_NAME, DEFAULT_FAN_NAME, ACTIVE_SPEED_THRESHOLD } from './settings';
import { IthoStatusSanitizedPayload } from './types';

const configMock: ConfigSchema = {
  platform: PLATFORM_NAME,
  name: DEFAULT_BRIDGE_NAME,
  api: { ip: '192.168.0.10', port: 1883, protocol: 'mqtt' },
  device: { co2Sensor: true },
};


function makeStatusPayload(overrides: Partial<IthoStatusSanitizedPayload> = {}): IthoStatusSanitizedPayload {
  return {
    temp: 21.5, hum: 55, ppmw: 0,
    'Speed status': 37, 'Internal fault': 0, 'Frost cycle': 0, 'Filter dirty': 0,
    'AirQuality (%)': null, 'AirQbased on': null, 'CO2level (ppm)': 714,
    'Indoorhumidity (%)': null, 'Outdoorhumidity (%)': null,
    'Exhausttemp (°C)': null, 'SupplyTemp (°C)': null, 'IndoorTemp (°C)': null, 'OutdoorTemp (°C)': null,
    SpeedCap: null, 'BypassPos (%)': null, FanInfo: 'auto', Actual_Mode: null,
    'ExhFanSpeed (%)': 37, 'InFanSpeed (%)': 0, 'RemainingTime (min)': 0,
    'PostHeat (%)': null, 'PreHeat (%)': null, 'InFlow (l sec)': null, 'ExhFlow (l sec)': null,
    'Ventilation setpoint (%)': null, 'Fan setpoint (rpm)': 1030, 'Fan speed (rpm)': 1036,
    Error: 0, Selection: 7, 'Startup counter': 97, 'Total operation (hours)': 81269,
    'Absence (min)': 0, 'Highest CO2 concentration (ppm)': 714, 'Highest RH concentration (%)': 59,
    RelativeHumidity: null, Temperature: null,
    ...overrides,
  };
}

describe('FanAccessory', () => {
  it('should create an instance', () => {
    expect(new FanAccessory(platformMock, accessoryMock, configMock)).toBeTruthy();
  });

  it('should have the correct displayName', () => {
    expect(new FanAccessory(platformMock, accessoryMock, configMock)['accessory'].displayName).toBe(DEFAULT_FAN_NAME);
  });

  describe('handleStatusResponse()', () => {
    it('updates CurrentFanState to BLOWING_AIR for speed above threshold', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const spy = vi.fn();
      fa['fanService'].updateCharacteristic = spy;
      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': 50 }));
      expect(spy).toHaveBeenCalledWith(
        platformMock.Characteristic.CurrentFanState,
        Characteristic.CurrentFanState.BLOWING_AIR,
      );
    });

    it('updates CurrentFanState to IDLE for speed below threshold', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const spy = vi.fn();
      fa['fanService'].updateCharacteristic = spy;
      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': ACTIVE_SPEED_THRESHOLD - 1 }));
      expect(spy).toHaveBeenCalledWith(
        platformMock.Characteristic.CurrentFanState,
        Characteristic.CurrentFanState.IDLE,
      );
    });

    it('updates CurrentFanState to INACTIVE for speed 0', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const spy = vi.fn();
      fa['fanService'].updateCharacteristic = spy;
      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': 0 }));
      expect(spy).toHaveBeenCalledWith(
        platformMock.Characteristic.CurrentFanState,
        Characteristic.CurrentFanState.INACTIVE,
      );
    });

    it('stores the payload', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const payload = makeStatusPayload({ FanInfo: 'high' });
      fa.handleStatusResponse(payload);
      expect(fa['lastStatusPayload']).toBe(payload);
    });
  });

  describe('handleSpeedResponse()', () => {
    it('stores the raw speed', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      fa.handleSpeedResponse(128);
      expect(fa['lastStatePayload']).toBe(128);
    });
  });

  // Turbo logic is now in TurboAccessory — tested separately

  describe('handleGetRotationSpeed()', () => {
    it('returns Speed status when available', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': 42 }));
      expect(fa.handleGetRotationSpeed()).toBe(42);
    });

    it('returns 0 when no data available', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      expect(fa.handleGetRotationSpeed()).toBe(0);
    });
  });
});
