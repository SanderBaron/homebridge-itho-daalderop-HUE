import { IthoDaalderopAccessoryContext } from '@/types';
import { HomebridgeIthoDaalderop } from '@/platform';
import { Accessory, Characteristic, Service } from '@homebridge/hap-nodejs';
import { PlatformAccessory } from 'homebridge';
import { mockUUID, mockAccessoryContext, mockDisplayName } from './fan-accessory';
import { loggerMock } from './logger';

export const mockSetCharacteristics = vi.fn(() => {
  return {
    updateValue: vi.fn().mockReturnThis(),
    onSet: vi.fn().mockReturnThis(),
    onGet: vi.fn().mockReturnThis(),
    setCharacteristic: mockSetCharacteristics,
    getCharacteristics: mockGetCharacteristics,
  };
});

const mockGetCharacteristics = () => {
  return {
    updateValue: vi.fn().mockReturnThis(),
    onSet: vi.fn().mockReturnThis(),
    onGet: vi.fn().mockReturnThis(),
    getCharacteristics: mockGetCharacteristics,
    setCharacteristics: mockSetCharacteristics,
    setProps: vi.fn().mockReturnThis(),
    value: null,
  };
};

const getServiceMock = () => ({
  setCharacteristic: mockSetCharacteristics,
  getCharacteristic: mockGetCharacteristics,
  updateCharacteristic: vi.fn(),
});

export const platformMock = {
  log: loggerMock,
  api: {
    hap: {
      Service,
      Characteristic,
      HapStatusError: vi.fn(),
      HAPStatus: {
        SUCCESS: 'SUCCESS',
        SERVICE_COMMUNICATION_FAILURE: 'SERVICE_COMMUNICATION_FAILURE',
      },
    },
  },
  Service,
  Characteristic,
  notifyManualOverride: vi.fn(),
  sendVirtualRemoteCommand: vi.fn(),
  sendSpeed: vi.fn(),
  isManualOverrideActive: vi.fn().mockReturnValue(false),
} as unknown as HomebridgeIthoDaalderop;

export const accessoryMock = {
  context: mockAccessoryContext,
  getService: getServiceMock,
  addService: getServiceMock,
  on: vi.fn(),
  emit: vi.fn(),
  removeService: vi.fn(),
  displayName: mockDisplayName,
  UUID: mockUUID,
  _associatedHAPAccessory: {} as Accessory,
  category: '' as unknown,
  reachable: true,
  services: [],
  getServiceById: vi.fn(),
  getServiceByUUIDAndSubType: vi.fn(),
  updateReachability: vi.fn(),
  configureCameraSource: vi.fn(),
  configureController: vi.fn(),
  removeController: vi.fn(),
  addListener: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn(),
  off: vi.fn(),
  removeAllListeners: vi.fn(),
  setMaxListeners: vi.fn(),
  getMaxListeners: vi.fn(),
  listeners: vi.fn(),
  rawListeners: vi.fn(),
  listenerCount: vi.fn(),
  prependListener: vi.fn(),
  prependOnceListener: vi.fn(),
  eventNames: vi.fn(),
} as unknown as PlatformAccessory<IthoDaalderopAccessoryContext>;
