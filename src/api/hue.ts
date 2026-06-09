/**
 * HueApi — thin wrapper around HueClient that adds Homebridge logger support
 * and a `bridgeIp` alias so platform.ts keeps a stable import.
 *
 * For direct client usage in the UI server, import HueClient from
 * `../hue/client` instead.
 */

import type { Logger } from 'homebridge';
import { HueClient } from '../hue/client';

// Re-export shared types so callers don't need two import paths.
export type { HueLight as HueLightV1, HueSensor as HueSensorV1 } from '../hue/types';
export { HueError } from '../hue/types';
export type { HueErrorKind } from '../hue/types';

export interface HueApiConfig {
  bridgeIp: string;
  apiKey: string;
  logger: Logger;
  verboseLogging?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export class HueApi {
  private readonly client: HueClient;

  constructor(private readonly cfg: HueApiConfig) {
    this.client = new HueClient({
      ip: cfg.bridgeIp,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
    });
  }

  private get log(): Logger { return this.cfg.logger; }

  // ── Lights ──────────────────────────────────────────────────────────────────

  async listLights() { return this.client.getLights(); }
  async getLight(id: string) { return this.client.getLight(id); }

  async setLightOn(id: string, on: boolean): Promise<void> {
    await this.client.setLightOn(id, on);
    if (this.cfg.verboseLogging) {
      this.log.debug(`[Hue] Lamp ${id} → ${on ? 'AAN' : 'UIT'}`);
    }
  }

  // ── Sensors ─────────────────────────────────────────────────────────────────

  async listSensors() { return this.client.listSensors(); }
  async getSensor(id: string) { return this.client.getSensor(id); }

  // ── Utility ─────────────────────────────────────────────────────────────────

  async testConnection(): Promise<{ ok: boolean; lightsCount?: number; error?: string }> {
    try {
      const lights = await this.client.getLights();
      return { ok: true, lightsCount: lights.length };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
