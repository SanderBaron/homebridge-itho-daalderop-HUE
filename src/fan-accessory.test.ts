import { Characteristic } from '@homebridge/hap-nodejs';
import { ConfigSchema } from './config.schema';
import { FanAccessory } from './fan-accessory';
import { accessoryMock, platformMock } from './mocks/platform';
import { vi } from 'vitest';
import {
  PLATFORM_NAME,
  DEFAULT_BRIDGE_NAME,
  DEFAULT_FAN_NAME,
  ACTIVE_SPEED_THRESHOLD,
} from './settings';
import { IthoStatusSanitizedPayload } from './types';

const configMock: ConfigSchema = {
  platform: PLATFORM_NAME,
  name: DEFAULT_BRIDGE_NAME,
  api: {
    ip: '192.168.0.10',
    port: 1883,
    protocol: 'mqtt',
  },
  device: {
    co2Sensor: true,
  },
};

const configManualMock: ConfigSchema = {
  ...configMock,
  device: undefined,
};

function makeStatusPayload(overrides: Partial<IthoStatusSanitizedPayload> = {}): IthoStatusSanitizedPayload {
  return {
    temp: 21.5,
    hum: 55,
    ppmw: 0,
    'Speed status': 37,
    'Internal fault': 0,
    'Frost cycle': 0,
    'Filter dirty': 0,
    'AirQuality (%)': null,
    'AirQbased on': null,
    'CO2level (ppm)': 714,
    'Indoorhumidity (%)': null,
    'Outdoorhumidity (%)': null,
    'Exhausttemp (°C)': null,
    'SupplyTemp (°C)': null,
    'IndoorTemp (°C)': null,
    'OutdoorTemp (°C)': null,
    SpeedCap: null,
    'BypassPos (%)': null,
    FanInfo: 'auto',
    Actual_Mode: null,
    'ExhFanSpeed (%)': 37,
    'InFanSpeed (%)': 0,
    'RemainingTime (min)': 0,
    'PostHeat (%)': null,
    'PreHeat (%)': null,
    'InFlow (l sec)': null,
    'ExhFlow (l sec)': null,
    'Ventilation setpoint (%)': null,
    'Fan setpoint (rpm)': 1030,
    'Fan speed (rpm)': 1036,
    Error: 0,
    Selection: 7,
    'Startup counter': 97,
    'Total operation (hours)': 81269,
    'Absence (min)': 0,
    'Highest CO2 concentration (ppm)': 714,
    'Highest RH concentration (%)': 59,
    RelativeHumidity: null,
    Temperature: null,
    ...overrides,
  };
}

describe('FanAccessory', () => {
  it('should create an instance', () => {
    const fanAccessory = new FanAccessory(platformMock, accessoryMock, configMock);
    expect(fanAccessory).toBeTruthy();
  });

  it('should have the correct displayName', () => {
    const fanAccessory = new FanAccessory(platformMock, accessoryMock, configMock);
    expect(fanAccessory['accessory'].displayName).toBe(DEFAULT_FAN_NAME);
  });

  describe('allowsManualSpeedControl', () => {
    it('should return false when device.co2Sensor is true', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, { ...configMock, device: { co2Sensor: true } });
      expect(fa['allowsManualSpeedControl']).toBe(false);
    });

    it('should return false when device.nonCve is true', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, { ...configMock, device: { nonCve: true } });
      expect(fa['allowsManualSpeedControl']).toBe(false);
    });

    it('should return false when both co2Sensor and nonCve are true', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, { ...configMock, device: { co2Sensor: true, nonCve: true } });
      expect(fa['allowsManualSpeedControl']).toBe(false);
    });

    it('should return true when both are false', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, { ...configMock, device: { co2Sensor: false, nonCve: false } });
      expect(fa['allowsManualSpeedControl']).toBe(true);
    });

    it('should return true when device is undefined', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, { ...configMock, device: undefined });
      expect(fa['allowsManualSpeedControl']).toBe(true);
    });
  });

  describe('handleStatusResponse()', () => {
    it('should update CurrentFanState to BLOWING_AIR for speed above threshold', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const updateSpy = vi.fn();
      fa['service'].updateCharacteristic = updateSpy;

      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': 50 }));

      expect(updateSpy).toHaveBeenCalledWith(
        platformMock.Characteristic.CurrentFanState,
        Characteristic.CurrentFanState.BLOWING_AIR,
      );
    });

    it('should update CurrentFanState to IDLE for speed below threshold', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const updateSpy = vi.fn();
      fa['service'].updateCharacteristic = updateSpy;

      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': ACTIVE_SPEED_THRESHOLD - 1 }));

      expect(updateSpy).toHaveBeenCalledWith(
        platformMock.Characteristic.CurrentFanState,
        Characteristic.CurrentFanState.IDLE,
      );
    });

    it('should update CurrentFanState to INACTIVE for speed 0', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const updateSpy = vi.fn();
      fa['service'].updateCharacteristic = updateSpy;

      fa.handleStatusResponse(makeStatusPayload({ 'Speed status': 0 }));

      expect(updateSpy).toHaveBeenCalledWith(
        platformMock.Characteristic.CurrentFanState,
        Characteristic.CurrentFanState.INACTIVE,
      );
    });

    it('should store the payload for later retrieval', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const payload = makeStatusPayload({ FanInfo: 'high' });
      fa.handleStatusResponse(payload);
      expect(fa['lastStatusPayload']).toBe(payload);
    });
  });

  describe('handleSpeedResponse()', () => {
    it('should store the raw speed value', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      fa.handleSpeedResponse(128);
      expect(fa['lastStatePayload']).toBe(128);
    });
  });

  describe('handleSetRotationSpeed()', () => {
    it('should call platform.sendVirtualRemoteCommand for co2Sensor devices', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock); // co2Sensor=true
      const spy = platformMock.sendVirtualRemoteCommand as ReturnType<typeof vi.fn>;
      spy.mockClear();

      fa.handleSetRotationSpeed(50);

      expect(spy).toHaveBeenCalledWith('medium');
    });

    it('should call platform.sendSpeed for manual-control devices', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configManualMock);
      const spy = platformMock.sendSpeed as ReturnType<typeof vi.fn>;
      spy.mockClear();

      fa.handleSetRotationSpeed(50); // 50% → ~127 raw

      expect(spy).toHaveBeenCalledWith(127);
    });

    it('should notify manual override on HomeKit change', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const spy = platformMock.notifyManualOverride as ReturnType<typeof vi.fn>;
      spy.mockClear();

      fa.handleSetRotationSpeed(50);

      expect(spy).toHaveBeenCalled();
    });
  });

  describe('handleGetRotationSpeed()', () => {
    it('should return speed from FanInfo for co2Sensor devices', async () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      fa.handleStatusResponse(makeStatusPayload({ FanInfo: 'high' }));

      const speed = await fa.handleGetRotationSpeed();
      expect(speed).toBeGreaterThan(0);
    });

    it('should return 0 when no status available', async () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      const speed = await fa.handleGetRotationSpeed();
      expect(speed).toBe(0);
    });

    it('should return converted speed for manual-control devices', async () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configManualMock);
      fa.handleSpeedResponse(127); // ~50%

      const speed = await fa.handleGetRotationSpeed();
      expect(speed).toBeCloseTo(50, 0);
    });
  });

  describe('handleGetActive()', () => {
    it('should return ACTIVE when RotationSpeed is not nil', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      fa['service'].getCharacteristic = vi.fn().mockReturnValue({ value: 50 });

      expect(fa.handleGetActive()).toBe(Characteristic.Active.ACTIVE);
    });

    it('should return ACTIVE when RotationSpeed is nil', () => {
      const fa = new FanAccessory(platformMock, accessoryMock, configMock);
      fa['service'].getCharacteristic = vi.fn().mockReturnValue({ value: null });

      expect(fa.handleGetActive()).toBe(Characteristic.Active.ACTIVE);
    });
  });
});
