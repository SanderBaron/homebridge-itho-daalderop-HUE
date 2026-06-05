import {
  IthoGetSpeedResponse,
  IthoSetSpeedResponse,
  IthoStatusSanitizedPayload,
  VirtualRemoteCommand,
} from '@/types';
import { sanitizeStatusPayload } from '@/utils/api';
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

async function timedFetch(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  return response.text();
}

export class HttpApi {
  private readonly baseUrl: string;
  private readonly eventEmitter: EventEmitter;
  private readonly logger: Logger;
  private readonly verboseLogging: boolean;
  protected isPolling: Record<string, boolean> = {};

  constructor(options: HttpApiOptions) {
    const params = new URLSearchParams();
    if (options.username) params.set('username', options.username);
    if (options.password) params.set('password', options.password);
    const qs = params.toString() ? `?${params}` : '';
    this.baseUrl = `http://${options.ip}/api.html${qs}`;

    this.eventEmitter = new EventEmitter();
    this.logger = options.logger;
    this.verboseLogging = options.verboseLogging ?? false;
  }

  private log(...args: unknown[]): void {
    if (!this.verboseLogging) return;
    this.logger.debug('[HTTP]', ...args);
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
    const text = await timedFetch(`${this.baseUrl}&speed=${speed}`);
    if (text === 'NOK') throw new Error('Failed to set speed');
    return speed as T;
  }

  async setVirtualRemoteCommand<T extends VirtualRemoteCommand>(
    command: VirtualRemoteCommand,
  ): Promise<T> {
    this.log(`setVirtualRemoteCommand ${command}`);
    const text = await timedFetch(`${this.baseUrl}&vremote=${command}`);
    if (text === 'NOK') throw new Error('Failed to set vremote');
    return command as T;
  }

  async getSpeed<T extends IthoGetSpeedResponse>(): Promise<T> {
    this.log('getSpeed');
    const text = await timedFetch(`${this.baseUrl}&get=currentspeed`);
    if (text === 'NOK') throw new Error('Failed to get speed');
    const speed = parseInt(text, 10);
    if (Number.isNaN(speed)) throw new Error(`Failed to parse speed: ${text}`);
    return speed as T;
  }

  async getStatus<T extends IthoStatusSanitizedPayload>(): Promise<T> {
    this.log('getStatus');
    const text = await timedFetch(`${this.baseUrl}&get=ithostatus`);
    if (text === 'NOK') throw new Error('Failed to get status');
    return sanitizeStatusPayload<T>(text);
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
