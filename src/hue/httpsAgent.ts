import type { Dispatcher } from 'undici-types';

/**
 * Hue Bridge HTTPS dispatcher + fetch wrapper.
 *
 * Recent Hue Bridges force HTTPS on port 443 and serve a self-signed certificate
 * whose CN does not match the bridge's LAN IP. Node's global `fetch` rejects the
 * cert because it uses an internal copy of undici that does NOT accept a dispatcher
 * from an externally-installed undici package.
 *
 * The fix: use undici's **own** `fetch` (from the installed `undici` npm package)
 * together with a custom Agent that has `rejectUnauthorized: false`. This is
 * provided via `huesFetch`, which callers should use as their default `fetchImpl`.
 *
 * The risk is contained: the destination is a hard-configured LAN IP, and the API
 * key only authorises light control — no broader system access leaks through a
 * compromised channel.
 */

interface UndiciModule {
  Agent: new (opts: { connect: { rejectUnauthorized: boolean } }) => Dispatcher;
  fetch: typeof fetch;
}

let cachedUndici: UndiciModule | undefined;
let attempted = false;

function getUndici(): UndiciModule | undefined {
  if (cachedUndici !== undefined) return cachedUndici;
  if (attempted) return undefined;
  attempted = true;
  try {
    /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
    cachedUndici = require('undici') as UndiciModule;
    /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
    return cachedUndici;
  } catch {
    return undefined;
  }
}

let cachedDispatcher: Dispatcher | undefined;

/**
 * Returns the insecure-TLS undici Agent, or `undefined` when undici is not
 * available. Kept for callers that need the dispatcher directly.
 */
export function getHueDispatcher(): Dispatcher | undefined {
  if (cachedDispatcher !== undefined) return cachedDispatcher;
  const u = getUndici();
  if (!u) return undefined;
  cachedDispatcher = new u.Agent({ connect: { rejectUnauthorized: false } });
  return cachedDispatcher;
}

/**
 * A `fetch`-compatible function for Hue Bridge requests that bypasses TLS
 * certificate verification using undici's own `fetch` + a custom Agent.
 *
 * Falls back to the global `fetch` when undici is unavailable (test environments
 * inject a mock via `fetchImpl` and never reach this code path).
 */
export async function huesFetch(
  url: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const u = getUndici();
  if (u !== undefined) {
    const dispatcher = getHueDispatcher();
    // undici's own fetch fully supports the `dispatcher` option.
    return u.fetch(url as string, { ...init, dispatcher } as RequestInit) as unknown as Promise<Response>;
  }
  // Fallback: no undici (test environments use a mock fetchImpl anyway).
  return fetch(url, init);
}

/** RequestInit extended with the undici-specific `dispatcher` option. */
export interface HueRequestInit extends RequestInit {
  dispatcher?: Dispatcher;
}
