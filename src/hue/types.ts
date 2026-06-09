/**
 * Shared types and the {@link HueError} class for the Hue Bridge layer.
 *
 * The Hue v1 REST API is used: simpler, sufficient for on/off control and
 * sensor/button polling.
 */

/**
 * The kinds of failure the Hue layer can surface to callers:
 *
 * - `timeout`          — request did not complete within the timeout. Retry-safe.
 * - `network`          — TCP/TLS-level failure. Retry-safe.
 * - `http`             — bridge returned a non-2xx status. Not retry-safe.
 * - `protocol`         — bridge responded but the body was malformed. Not retry-safe.
 * - `unauthorized`     — API key was rejected (Hue error code 1). User must re-pair.
 * - `link-not-pressed` — pairing request before the link button was pressed (code 101).
 */
export type HueErrorKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'protocol'
  | 'unauthorized'
  | 'link-not-pressed';

export class HueError extends Error {
  public readonly kind: HueErrorKind;
  public readonly httpStatus?: number;
  public readonly cause?: unknown;

  public constructor(
    message: string,
    kind: HueErrorKind,
    extras: { httpStatus?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'HueError';
    this.kind = kind;
    if (extras.httpStatus !== undefined) this.httpStatus = extras.httpStatus;
    if (extras.cause !== undefined) this.cause = extras.cause;
  }
}

/** A Hue Bridge discovered on the local network. */
export interface BridgeCandidate {
  /** Bridge ID (uppercase hex), e.g. `ECBXXXXXXXXXX`. */
  id: string;
  /** IPv4 address on the LAN. */
  ip: string;
  /** Human-readable name when known. */
  name?: string;
  /** How this candidate was found. */
  source: 'cloud' | 'manual';
}

/** Minimal bridge metadata from `GET /api/config` (no auth required). */
export interface BridgeConfig {
  name: string;
  bridgeid: string;
  modelid: string;
  apiversion: string;
  swversion: string;
}

/** Hue v1 light, flattened for convenience. */
export interface HueLight {
  /** Numeric id as a string. */
  id: string;
  name: string;
  type: string;
  modelid: string;
  manufacturername: string;
  reachable: boolean;
  on: boolean;
}

/** Hue v1 sensor / button response. */
export interface HueSensor {
  id: string;
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
