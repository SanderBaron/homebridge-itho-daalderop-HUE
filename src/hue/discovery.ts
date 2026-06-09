import type { BridgeCandidate } from './types';

/**
 * Discover Hue Bridges on the local network via Philips' cloud endpoint.
 *
 * The cloud endpoint (`https://discovery.meethue.com/`) returns bridges that
 * share the caller's public IP. It is a reliable fallback when mDNS is blocked
 * by VLAN or firewall configuration — which is common in home-automation setups.
 *
 * Never throws — failures return an empty array.
 */

const CLOUD_DISCOVERY_URL = 'https://discovery.meethue.com/';
const CLOUD_TIMEOUT_MS = 6000;

export interface DiscoveryOptions {
  /** Maximum time (ms) to wait for the cloud endpoint. Default 6000. */
  timeoutMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export async function discoverBridges(options: DiscoveryOptions = {}): Promise<BridgeCandidate[]> {
  const timeoutMs = options.timeoutMs ?? CLOUD_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(CLOUD_DISCOVERY_URL, { signal: controller.signal });
    if (!res.ok) return [];

    const body = (await res.json()) as Array<{ id?: string; internalipaddress?: string }>;
    if (!Array.isArray(body)) return [];

    const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
    return body
      .filter(
        (b): b is { id: string; internalipaddress: string } =>
          typeof b.id === 'string' &&
          typeof b.internalipaddress === 'string' &&
          IPV4.test(b.internalipaddress),
      )
      .map(b => ({
        id: b.id.toUpperCase(),
        ip: b.internalipaddress,
        source: 'cloud' as const,
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
