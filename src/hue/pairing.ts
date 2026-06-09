import os from 'node:os';

import { huesFetch, type HueRequestInit } from './httpsAgent';
import { HueError } from './types';

export interface PairingOptions {
  /** Bridge IPv4 address. */
  ip: string;
  /**
   * `devicetype` sent to the bridge. Hue limits this to 40 characters,
   * formatted as `<app>#<device>`. Defaults to `ithodaalderop#<hostname>`.
   */
  deviceType?: string;
  /** Request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface HueApiSuccessEntry {
  success: { username: string };
}

interface HueApiErrorEntry {
  error: { type: number; address: string; description: string };
}

type HueApiResponse = Array<HueApiSuccessEntry | HueApiErrorEntry>;

const APP_NAME = 'ithodaalderop';
const MAX_DEVICE_TYPE_LENGTH = 40;
const LINK_BUTTON_NOT_PRESSED = 101;

export function defaultDeviceType(hostname: string = os.hostname()): string {
  const sanitisedHost = hostname.split('.')[0] ?? 'host';
  const prefix = `${APP_NAME}#`;
  const remaining = MAX_DEVICE_TYPE_LENGTH - prefix.length;
  return prefix + sanitisedHost.slice(0, remaining);
}

/**
 * Attempt a single pairing request against a Hue Bridge.
 *
 * One attempt only — the UI is responsible for polling while showing
 * the "press the link button" prompt. Throws {@link HueError} with kind
 * `link-not-pressed` so callers can distinguish "keep trying" from "give up".
 *
 * @returns The API key (username) the bridge issued.
 */
export async function pairWithBridge(options: PairingOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? huesFetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deviceType = options.deviceType ?? defaultDeviceType();
  const url = `https://${options.ip}/api`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const init: HueRequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ devicetype: deviceType }),
    signal: controller.signal,
  };

  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new HueError(`Pairing request to ${options.ip} timed out`, 'timeout', { cause: err });
    }
    throw new HueError(
      `Network error contacting Hue Bridge at ${options.ip}`,
      'network',
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new HueError(
      `Hue Bridge returned HTTP ${res.status} during pairing`,
      'http',
      { httpStatus: res.status },
    );
  }

  let body: HueApiResponse;
  try {
    body = (await res.json()) as HueApiResponse;
  } catch (err) {
    throw new HueError('Pairing response was not valid JSON', 'protocol', { cause: err });
  }

  if (!Array.isArray(body) || body.length === 0) {
    throw new HueError('Pairing response was empty or malformed', 'protocol');
  }

  const first = body[0];
  if (first === undefined) {
    throw new HueError('Pairing response was empty', 'protocol');
  }

  if ('success' in first && typeof first.success.username === 'string') {
    return first.success.username;
  }

  if ('error' in first) {
    if (first.error.type === LINK_BUTTON_NOT_PRESSED) {
      throw new HueError(
        'Link button on the Hue Bridge has not been pressed yet',
        'link-not-pressed',
      );
    }
    throw new HueError(`Hue Bridge rejected pairing: ${first.error.description}`, 'protocol');
  }

  throw new HueError('Pairing response was in an unrecognised shape', 'protocol');
}
