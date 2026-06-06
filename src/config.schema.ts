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
    username: z.string().optional(),
    password: z.string().optional(),
    // Optional: direct Itho device IP for the dashboard when protocol is 'mqtt'
    deviceIp: ipv4Schema('deviceIp must be a valid IPv4 address').optional(),
  }),

  automation: z
    .object({
      humidity: z
        .object({
          enabled: z.boolean().default(true),
          boostThreshold: z.number().min(50).max(95).default(70),
          dropThreshold: z.number().min(40).max(85).default(60),
          cooldownMinutes: z.number().min(1).max(120).default(20),
          manualOverrideMinutes: z.number().min(0).max(240).default(60),
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
    })
    .optional(),

  verboseLogging: z
    .boolean({ invalid_type_error: "'verboseLogging' must be a boolean" })
    .optional(),
});

export type ConfigSchema = z.infer<typeof configSchema> & PlatformConfig;
