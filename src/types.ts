export interface IthoDaalderopAccessoryContext {
  accessoryType?: 'fan' | 'airQuality';
}

export const virtualRemoteCommands = [
  'low',
  'medium',
  'high',
  'timer1',
  'timer2',
  'timer3',
  'join',
  'leave',
] as const;
export type VirtualRemoteCommand = (typeof virtualRemoteCommands)[number];

// https://github.com/arjenhiemstra/ithowifi/wiki/Controlling-the-speed-of-a-fan
export type FanInfo = 'auto' | 'low' | 'medium' | 'high';

// https://github.com/arjenhiemstra/ithowifi/wiki/Non-CVE-units-support
// 1 = Low, 2 = Medium, 3 = High, 24 = Automatic
export type ActualMode = 1 | 2 | 3 | 24;

export type Selection = 'auto' | 'low' | 'medium' | 'high' | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface IthoStatusSanitizedPayload {
  temp: number | null;
  hum: number | null;
  ppmw: number | null;
  'Speed status': number | null;
  'Internal fault': number | null;
  'Frost cycle': number | null;
  'Filter dirty': number | null;
  'AirQuality (%)': number | null;
  'AirQbased on': number | null;
  'CO2level (ppm)': number | null;
  'Indoorhumidity (%)': number | null;
  'Outdoorhumidity (%)': number | null;
  'Exhausttemp (°C)': number | null;
  'SupplyTemp (°C)': number | null;
  'IndoorTemp (°C)': number | null;
  'OutdoorTemp (°C)': number | null;
  SpeedCap: number | null;
  'BypassPos (%)': number | null;
  FanInfo?: FanInfo | null;
  Actual_Mode?: ActualMode | null;
  'ExhFanSpeed (%)': number | null;
  'InFanSpeed (%)': number | null;
  'RemainingTime (min)': number | null;
  'PostHeat (%)': number | null;
  'PreHeat (%)': number | null;
  'InFlow (l sec)': number | null;
  'ExhFlow (l sec)': number | null;
  'Ventilation setpoint (%)': number | null;
  'Fan setpoint (rpm)': number | null;
  'Fan speed (rpm)': number | null;
  Error: number | null;
  Selection: Selection;
  'Startup counter': number | null;
  'Total operation (hours)': number | null;
  'Absence (min)': number | null;
  'Highest CO2 concentration (ppm)': number | null;
  'Highest RH concentration (%)': number | null;
  RelativeHumidity: number | null;
  Temperature: number | null;
}

export type IthoStatusPayload = {
  [K in keyof IthoStatusSanitizedPayload]: number | string;
};

export type IthoGetSpeedResponse = number;
export type IthoSetSpeedResponse = number;
export type IthoStatePayload = string;

export enum VirtualRemoteOptions {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  TIMER1 = 'timer1',
  TIMER2 = 'timer2',
  TIMER3 = 'timer3',
  JOIN = 'join',
  LEAVE = 'leave',
}

export const supportedVirtualRemoteCommands = ['low', 'medium', 'high'] as const;
export type SupportedVirtualRemoteCommands = (typeof supportedVirtualRemoteCommands)[number];
export type VirtualRemoteMapping = Record<SupportedVirtualRemoteCommands, [number, number]>;

// --- Schedule engine ---

export type DayOfWeek = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface ScheduleEntry {
  label: string;
  days: DayOfWeek[];
  from: string; // HH:MM
  to: string; // HH:MM
  speed: SupportedVirtualRemoteCommands;
}

// --- Automation state ---

/** 'boosting' covers both the active boost and the post-shower minimum hold. */
export type HumidityAutomationState = 'idle' | 'boosting';
export type AutomationSource = 'manual' | 'humidity' | 'schedule' | 'auto';

export interface AutomationStatus {
  humidityState: HumidityAutomationState;
  activeScheduleLabel: string | null;
  currentSource: AutomationSource;
  manualOverrideExpiresAt: number | null;
  cooldownEndsAt: number | null;
}
