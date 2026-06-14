import {
  IthoGetSpeedResponse,
  IthoSetSpeedResponse,
  IthoStatusSanitizedPayload,
  VirtualRemoteCommand,
} from '@/types';
import { sanitizeStatusObject } from '@/utils/api';
import EventEmitter from 'events';
import { Logger } from 'homebridge';

export const DEFAULT_POLLING_INTERVAL = 5000;

interface HttpApiOptions {
  ip: string;
  username?: string;
  password?: string;
  verboseLogging?: boolean;
  logger: Logger;
}

/** Envelope returned by the RESTful API v2: { status, data, message? }. */
interface ApiV2Response<T = Record<string, unknown>> {
  status: 'success' | 'error';
  data?: T;
  message?: string;
}

export class HttpApi {
  private readonly baseUrl: string;
  private readonly authHeader?: string;
  private readonly eventEmitter: EventEmitter;
  private readonly logger: Logger;
  private readonly verboseLogging: boolean;
  protected isPolling: Record<string, boolean> = {};

  constructor(options: HttpApiOptions) {
    this.baseUrl = `http://${options.ip}`;
    // RESTful API v2 uses HTTP Basic Auth (only sent when credentials are set)
    if (options.username) {
      const creds = `${options.username}:${options.password ?? ''}`;
      this.authHeader = `Basic ${Buffer.from(creds).toString('base64')}`;
    }

    this.eventEmitter = new EventEmitter();
    this.logger = options.logger;
    this.verboseLogging = options.verboseLogging ?? false;
  }

  private log(...args: unknown[]): void {
    if (!this.verboseLogging) return;
    this.logger.debug('[HTTP]', ...args);
  }

  /** GET a v2 endpoint and return its `data` payload, throwing on a non-success status. */
  private async getV2<T = Record<string, unknown>>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: this.authHeader ? { Authorization: this.authHeader } : {},
      signal: AbortSignal.timeout(2000),
    });
    const json = (await res.json()) as ApiV2Response<T>;
    if (json.status !== 'success' || json.data === undefined) {
      throw new Error(`GET ${path} failed: ${json.message ?? json.status}`);
    }
    return json.data;
  }

  /** POST a command to /api/v2/command, throwing with the API's message on failure. */
  private async postCommand(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/v2/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.authHeader ? { Authorization: this.authHeader } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    const json = (await res.json()) as ApiV2Response;
    if (json.status !== 'success') {
      throw new Error(`Command ${JSON.stringify(body)} failed: ${json.message ?? json.status}`);
    }
  }

  on<T extends IthoStatusSanitizedPayload>(
    event: 'response.getStatus',
    listener: (response: T) => void,
  ): void;
  on<T extends IthoGetSpeedResponse>(
    event: 'response.getSpeed',
    listener: (response: T) => void,
  ): void;
  on(event: 'error', listener: (error: Error) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void) {
    this.eventEmitter.on(event, listener);
  }

  async setSpeed<T extends IthoSetSpeedResponse>(speed: number): Promise<T> {
    this.log(`setSpeed ${speed}`);
    await this.postCommand({ speed });
    return speed as T;
  }

  async setVirtualRemoteCommand<T extends VirtualRemoteCommand>(
    command: VirtualRemoteCommand,
  ): Promise<T> {
    this.log(`setVirtualRemoteCommand ${command}`);
    await this.postCommand({ command });
    return command as T;
  }

  async getSpeed<T extends IthoGetSpeedResponse>(): Promise<T> {
    this.log('getSpeed');
    const data = await this.getV2<{ currentspeed: number }>('/api/v2/speed');
    const speed = data.currentspeed;
    if (typeof speed !== 'number' || Number.isNaN(speed)) {
      throw new Error(`Failed to parse speed: ${JSON.stringify(data)}`);
    }
    return speed as T;
  }

  async getStatus<T extends IthoStatusSanitizedPayload>(): Promise<T> {
    this.log('getStatus');
    const data = await this.getV2<{ ithostatus: Record<string, unknown> }>('/api/v2/ithostatus');
    return sanitizeStatusObject<T>(data.ithostatus);
  }

  get polling() {
    return {
      getSpeed: {
        start: () => this.startPolling('getSpeed', this.getSpeed.bind(this)),
        stop: () => this.stopPolling('getSpeed'),
        on: this.on.bind(this),
      },
      getStatus: {
        start: () => this.startPolling('getStatus', this.getStatus.bind(this)),
        stop: () => this.stopPolling('getStatus'),
        on: this.on.bind(this),
      },
    };
  }

  protected stopPolling(method: string): void {
    this.isPolling[method] = false;
  }

  protected async startPolling(method: string, fn: () => Promise<unknown>): Promise<void> {
    this.isPolling[method] = true;
    while (this.isPolling[method]) {
      try {
        this.eventEmitter.emit(`response.${method}`, await fn());
      } catch (err) {
        this.eventEmitter.emit(`error.${method}`, err);
      }
      await new Promise(resolve => setTimeout(resolve, DEFAULT_POLLING_INTERVAL));
    }
  }
}
