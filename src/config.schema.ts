import { z } from 'zod';
import { PlatformConfig } from 'homebridge';

const ipv4Regex = /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/;

const ipv4Schema = (requiredMessage: string) =>
  z
    .string({ required_error: requiredMessage })
    .refine(
      ip => ipv4Regex.test(ip),
      ip => ({ message: `'${ip}' is not a valid IPv4 address` }),
    );

const dayOfWeekSchema = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const speedSchema = z.enum(['low', 'medium', 'high']);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Must be HH:MM format');

export const configSchema = z.object({
  name: z.string({ required_error: 'A bridge name is required' }),

  device: z
    .object({
      co2Sensor: z
        .boolean({ invalid_type_error: "'co2Sensor' must be a boolean" })
        .optional(),
      nonCve: z
        .boolean({ invalid_type_error: "'nonCve' must be a boolean" })
        .optional(),
    })
    .optional(),

  api: z.object({
    protocol: z.enum(['mqtt', 'http']),
    ip: ipv4Schema('IP address is required for setup'),
    port: z.number({ required_error: 'Port is required for setup' }),
    /** MQTT broker credentials */
    username: z.string().optional(),
    password: z.string().optional(),
    /** Optional: direct Itho device IP for the dashboard when protocol is 'mqtt' */
    deviceIp: ipv4Schema('deviceIp must be a valid IPv4 address').optional(),
    /** NRGWatch HTTP API credentials (if auth is enabled on the device) */
    deviceUsername: z.string().optional(),
    devicePassword: z.string().optional(),
  }),

  /** Philips Hue integration (Phase 2) */
  hue: z
    .object({
      bridgeIp: ipv4Schema('Hue bridge IP must be a valid IPv4 address').optional(),
      apiKey: z.string().optional(),
    })
    .optional(),

  automation: z
    .object({
      humidity: z
        .object({
          enabled: z.boolean().default(true),
          /** 'badkamer': absolute + rapid-rise + cooldown. 'wasruimte': three-zone thresholds. */
          mode: z.enum(['badkamer', 'wasruimte']).default('badkamer'),
          /** Absolute humidity level that immediately triggers boost (%) */
          boostThreshold: z.number().min(50).max(100).default(85),
          /** Humidity must drop below this before cooldown can finish (%) */
          dropThreshold: z.number().min(40).max(95).default(82),
          /** Minimum minutes to keep fan at high after humidity drops */
          cooldownMinutes: z.number().min(1).max(120).default(20),
          /** Rapid-rise detection: boost when humidity rises this many % within riseWindowSeconds (0 = disabled) */
          riseRate: z.number().min(0).max(20).default(3),
          /** Rapid-rise detection window in seconds (Itho spec: 24 or 48) */
          riseWindowSeconds: z.number().min(5).max(120).default(24),
          /** Wasruimte only: below this humidity the fan is set to low (%) */
          minSpeedThreshold: z.number().min(40).max(85).default(75),
        })
        .optional(),
      turbo: z
        .object({
          durationMinutes: z.number().min(1).max(120).default(20),
        })
        .optional(),
      schedule: z
        .object({
          enabled: z.boolean().default(false),
          entries: z
            .array(
              z.object({
                label: z.string(),
                days: z.array(dayOfWeekSchema).min(1),
                from: timeSchema,
                to: timeSchema,
                speed: speedSchema,
              }),
            )
            .default([]),
        })
        .optional(),

      /** Phase 2: mirror heater control via external humidity sensor + Hue */
      mirrorHeater: z
        .object({
          enabled: z.boolean().default(false),
          /** Hue light resource ID for the mirror heater */
          hueLightId: z.string().optional(),
          /** Minutes to keep the mirror heater on after humidity drops */
          durationMinutes: z.number().min(1).max(120).default(30),
        })
        .optional(),

      /** Phase 2: toilet ventilation boost via Hue button/sensor */
      toiletLight: z
        .object({
          enabled: z.boolean().default(false),
          /** Hue sensor/button resource ID to detect toilet light */
          hueSensorId: z.string().optional(),
          /** Minimum minutes the light must be on to trigger a boost */
          minOnMinutes: z.number().min(1).max(30).default(2),
          /** Minutes to run CVE at high speed after trigger */
          boostMinutes: z.number().min(1).max(120).default(20),
        })
        .optional(),
    })
    .optional(),

  /**
   * Daily failsafe reset — sends 'medium' (CO₂ auto) at a fixed time every night
   * so a forgotten manual override never leaves the CVE stuck indefinitely.
   */
  dailyReset: z
    .object({
      enabled: z.boolean().default(true),
      time: timeSchema.default('02:00'),
    })
    .optional(),

  verboseLogging: z
    .boolean({ invalid_type_error: "'verboseLogging' must be a boolean" })
    .optional(),
});

export type ConfigSchema = z.infer<typeof configSchema> & PlatformConfig;
