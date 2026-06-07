export const PLATFORM_NAME = 'HomebridgeIthoDaalderop';
export const PLUGIN_NAME = 'homebridge-itho-daalderop-hue';

export const DEFAULT_BRIDGE_NAME = 'Itho Daalderop';
export const MANUFACTURER = 'Itho Daalderop';
export const DEFAULT_FAN_NAME = 'Mechanical Ventilation';
export const DEFAULT_AIR_QUALITY_SENSOR_NAME = 'Air Quality Sensor';

/**
 * MQTT topic published by the Itho WiFi module with full status JSON.
 * @link https://github.com/arjenhiemstra/ithowifi/wiki/MQTT-integration
 */
export const MQTT_STATUS_TOPIC = 'itho/ithostatus';

/** MQTT topic with current fan speed (0–254) as plain text. */
export const MQTT_STATE_TOPIC = 'itho/state';

/** MQTT topic to send commands to the add-on (speed or vremote). */
export const MQTT_CMD_TOPIC = 'itho/cmd';

export const MAX_ROTATION_SPEED = 100;
export const ACTIVE_SPEED_THRESHOLD = 20;

export const CO2_LEVEL_SENSOR_KEY = 'CO2level (ppm)';
export const FAN_INFO_KEY = 'FanInfo';
export const ACTUAL_MODE_KEY = 'Actual_Mode';
export const SPEED_STATUS_KEY = 'Speed status';
export const REQ_FAN_SPEED_KEY = 'ReqFanspeed';

export const FALLBACK_VIRTUAL_REMOTE_COMMAND = 'medium';

// Humidity automation defaults
export const DEFAULT_HUMIDITY_MODE = 'badkamer' as const;
export const DEFAULT_HUMIDITY_BOOST_THRESHOLD = 85;     // Itho spec: 85% badkamer, 90% wasruimte
export const DEFAULT_HUMIDITY_DROP_THRESHOLD = 82;      // Itho spec: 82% badkamer, 75% wasruimte
export const DEFAULT_HUMIDITY_COOLDOWN_MINUTES = 20;
export const DEFAULT_HUMIDITY_RISE_RATE = 3;            // % rise to trigger rapid-rise boost
export const DEFAULT_HUMIDITY_RISE_WINDOW_SECONDS = 24; // detection window (24 or 48 s per Itho)
export const DEFAULT_HUMIDITY_MIN_SPEED_THRESHOLD = 75; // wasruimte: below this → low

// Daily reset defaults
export const DEFAULT_DAILY_RESET_TIME = '02:00';
