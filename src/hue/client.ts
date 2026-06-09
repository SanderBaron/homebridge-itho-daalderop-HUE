import { huesFetch, type HueRequestInit } from './httpsAgent';
import { HueError, type BridgeConfig, type HueLight, type HueSensor } from './types';

export interface HueClientOptions {
  /** Bridge IPv4 address. */
  ip: string;
  /** API key (username) issued by the bridge during pairing. */
  apiKey: string;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Retries on transient failures (timeout, network, 5xx). Default 1. */
  retries?: number;
  /** Backoff (ms) between retries — multiplied by attempt number. Default 100. */
  backoffMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

type HttpMethod = 'GET' | 'PUT' | 'POST';

interface HueApiErrorEntry {
  error: { type: number; address: string; description: string };
}

interface HueLightRaw {
  name: string;
  type: string;
  modelid: string;
  manufacturername: string;
  state: { on: boolean; reachable?: boolean };
}

interface HueSensorRaw {
  name: string;
  type: string;
  modelid: string;
  state: {
    lastupdated: string;
    buttonevent?: number;
    presence?: boolean;
    on?: boolean;
    [key: string]: unknown;
  };
}

const HUE_UNAUTHORIZED = 1;
const HUE_LINK_NOT_PRESSED = 101;

/**
 * Thin wrapper around the Hue Bridge v1 REST API.
 *
 * Each public method:
 * - applies the configured per-request timeout via AbortController;
 * - retries transient failures (timeout, network, 5xx) up to `retries` times;
 * - converts Hue's application-level error envelopes into typed {@link HueError}s.
 * - uses HTTPS with a self-signed-cert dispatcher for modern bridge firmware.
 */
export class HueClient {
  private readonly ip: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: HueClientOptions) {
    this.ip = options.ip;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.retries = options.retries ?? 1;
    this.backoffMs = options.backoffMs ?? 100;
    this.fetchImpl = options.fetchImpl ?? huesFetch;
  }

  /** Fetch unauthenticated bridge metadata. Useful as a reachability probe. */
  public async getConfig(): Promise<BridgeConfig> {
    return this.request<BridgeConfig>('GET', '/api/config');
  }

  /** List all lights/sockets the bridge knows about. */
  public async getLights(): Promise<HueLight[]> {
    const raw = await this.request<Record<string, HueLightRaw>>(
      'GET',
      `/api/${this.apiKey}/lights`,
    );
    return Object.entries(raw).map(([id, l]) => ({
      id,
      name: l.name,
      type: l.type,
      modelid: l.modelid,
      manufacturername: l.manufacturername,
      reachable: l.state.reachable ?? true,
      on: l.state.on,
    }));
  }

  /** Fetch a single light by id. */
  public async getLight(id: string): Promise<HueLight> {
    const l = await this.request<HueLightRaw>(
      'GET',
      `/api/${this.apiKey}/lights/${encodeURIComponent(id)}`,
    );
    return {
      id,
      name: l.name,
      type: l.type,
      modelid: l.modelid,
      manufacturername: l.manufacturername,
      reachable: l.state.reachable ?? true,
      on: l.state.on,
    };
  }

  /** Turn a light/socket on or off. */
  public async setLightOn(id: string, on: boolean): Promise<void> {
    await this.request<unknown>(
      'PUT',
      `/api/${this.apiKey}/lights/${encodeURIComponent(id)}/state`,
      { on },
    );
  }

  /**
   * List all sensors. Includes buttons (ZLLSwitch, ZGPSwitch), presence sensors,
   * and CLIPSwitch resources used by input-only switches.
   */
  public async listSensors(): Promise<HueSensor[]> {
    const raw = await this.request<Record<string, HueSensorRaw>>(
      'GET',
      `/api/${this.apiKey}/sensors`,
    );
    return Object.entries(raw).map(([id, s]) => ({
      id,
      name: s.name,
      type: s.type,
      modelid: s.modelid,
      state: s.state,
    }));
  }

  /** Fetch a single sensor / button by id. */
  public async getSensor(id: string): Promise<HueSensor> {
    const s = await this.request<HueSensorRaw>(
      'GET',
      `/api/${this.apiKey}/sensors/${encodeURIComponent(id)}`,
    );
    return { id, name: s.name, type: s.type, modelid: s.modelid, state: s.state };
  }

  /** Returns true when the bridge responds to an unauthenticated config probe. */
  public async healthCheck(): Promise<boolean> {
    try {
      await this.getConfig();
      return true;
    } catch {
      return false;
    }
  }

  // ── Core request with retry ─────────────────────────────────────────────────

  private async request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.attemptRequest<T>(method, path, body);
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err) || attempt === this.retries) throw err;
        await delay(this.backoffMs * (attempt + 1));
      }
    }
    throw lastErr instanceof Error ? lastErr : new HueError('Unknown error', 'network');
  }

  private async attemptRequest<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const url = `https://${this.ip}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const init: HueRequestInit = { method, signal: controller.signal };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new HueError(`Hue request to ${url} timed out`, 'timeout', { cause: err });
      }
      throw new HueError(
        `Network error contacting Hue Bridge at ${this.ip}`,
        'network',
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new HueError(
        `Hue Bridge returned HTTP ${res.status}`,
        'http',
        { httpStatus: res.status },
      );
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new HueError('Hue Bridge response was not valid JSON', 'protocol', { cause: err });
    }

    if (Array.isArray(parsed)) {
      const firstError = (parsed as unknown[]).find(
        (entry): entry is HueApiErrorEntry =>
          typeof entry === 'object' && entry !== null && 'error' in entry,
      );
      if (firstError !== undefined) {
        if (firstError.error.type === HUE_UNAUTHORIZED) {
          throw new HueError(
            'Hue Bridge rejected the API key — re-pairing required',
            'unauthorized',
          );
        }
        if (firstError.error.type === HUE_LINK_NOT_PRESSED) {
          throw new HueError('Press the link button on the Hue Bridge first', 'link-not-pressed');
        }
        throw new HueError(`Hue API error: ${firstError.error.description}`, 'protocol');
      }
    }

    return parsed as T;
  }

  private isRetryable(err: unknown): boolean {
    if (!(err instanceof HueError)) return false;
    if (err.kind === 'timeout' || err.kind === 'network') return true;
    if (err.kind === 'http' && err.httpStatus !== undefined && err.httpStatus >= 500) return true;
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
