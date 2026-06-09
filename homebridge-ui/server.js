/* eslint-env node */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

/**
 * Custom Homebridge UI server.
 *
 * Runs in the Homebridge UI process (separate from the plugin platform) and
 * exposes endpoints the browser-side script calls via
 * `homebridge.request(path, payload)`.
 *
 * Hue logic is delegated to the compiled plugin modules in `../dist/hue/`
 * rather than re-implemented here, so there is a single source of truth for
 * HTTPS, retries, and error handling.
 */

const { HomebridgePluginUiServer, RequestError } = require('@homebridge/plugin-ui-utils');

const { discoverBridges } = require('../dist/hue/discovery');
const { pairWithBridge } = require('../dist/hue/pairing');
const { HueClient } = require('../dist/hue/client');

// Sensor types worth showing in the UI (buttons, switches, presence sensors).
const USEFUL_SENSOR_TYPES = new Set([
  'ZLLSwitch',
  'ZGPSwitch',
  'ZLLPresence',
  'ZLLLightLevel',
  'CLIPSwitch',
  'CLIPPresence',
]);

class IthoPluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/discover-bridges', (p) => this.discoverBridges(p));
    this.onRequest('/probe-bridge',     (p) => this.probeBridge(p));
    this.onRequest('/pair-bridge',      (p) => this.pairBridge(p));
    this.onRequest('/list-lights',      (p) => this.listLights(p));
    this.onRequest('/list-sensors',     (p) => this.listSensors(p));
    this.onRequest('/device-status',    (p) => this.deviceStatus(p));
    this.onRequest('/module-info',      (p) => this.moduleInfo(p));
    this.ready();
  }

  // ── Hue endpoints ─────────────────────────────────────────────────────────

  /**
   * Cloud-based Hue Bridge discovery.
   * Returns `[{ id, ip, source }]`. Always resolves — empty array on failure.
   */
  async discoverBridges(payload) {
    const timeoutMs = Number(payload && payload.timeoutMs) || 6000;
    try {
      return await discoverBridges({ timeoutMs });
    } catch (err) {
      throw new RequestError('Discovery failed: ' + String(err && err.message ? err.message : err));
    }
  }

  /**
   * Unauthenticated bridge reachability probe.
   * Returns `{ ok, name?, bridgeid?, modelid? }` or `{ ok: false, error }`.
   */
  async probeBridge(payload) {
    if (!payload || typeof payload.ip !== 'string' || !payload.ip) {
      throw new RequestError('probe-bridge requires an ip');
    }
    const client = new HueClient({ ip: payload.ip, apiKey: 'probe', timeoutMs: 4000, retries: 0 });
    try {
      const cfg = await client.getConfig();
      return { ok: true, name: cfg.name, bridgeid: cfg.bridgeid, modelid: cfg.modelid };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * Single pairing attempt.
   * Returns `{ ok: true, apiKey }` or `{ ok: false, kind: 'link-not-pressed' }`.
   * Other errors throw a RequestError.
   */
  async pairBridge(payload) {
    if (!payload || typeof payload.ip !== 'string' || !payload.ip) {
      throw new RequestError('pair-bridge requires an ip');
    }
    try {
      const apiKey = await pairWithBridge({ ip: payload.ip });
      return { ok: true, apiKey };
    } catch (err) {
      if (err && err.kind === 'link-not-pressed') {
        return { ok: false, kind: 'link-not-pressed' };
      }
      const kind = (err && err.kind) || 'unknown';
      const message = err && err.message ? err.message : String(err);
      throw new RequestError(`Pairing failed (${kind}): ${message}`);
    }
  }

  /**
   * List all lights/sockets so dropdowns in the settings can be populated.
   * Returns `HueLight[]` (id, name, type, modelid, reachable, on).
   */
  async listLights(payload) {
    if (!payload || typeof payload.ip !== 'string' || typeof payload.apiKey !== 'string') {
      throw new RequestError('list-lights requires ip and apiKey');
    }
    const client = new HueClient({ ip: payload.ip, apiKey: payload.apiKey, retries: 0 });
    try {
      return await client.getLights();
    } catch (err) {
      throw new RequestError('Could not list lights: ' + String(err && err.message ? err.message : err));
    }
  }

  /**
   * List sensors / buttons so switch and button dropdowns can be populated.
   * Filtered to types that are useful as triggers (ZLLSwitch, presence, etc.).
   * Returns `[{ id, name, type, modelid }]`.
   */
  async listSensors(payload) {
    if (!payload || typeof payload.ip !== 'string' || typeof payload.apiKey !== 'string') {
      throw new RequestError('list-sensors requires ip and apiKey');
    }
    const client = new HueClient({ ip: payload.ip, apiKey: payload.apiKey, retries: 0 });
    try {
      const all = await client.listSensors();
      return all
        .filter(s => USEFUL_SENSOR_TYPES.has(s.type))
        .map(s => ({ id: s.id, name: s.name, type: s.type, modelid: s.modelid }));
    } catch (err) {
      throw new RequestError('Could not list sensors: ' + String(err && err.message ? err.message : err));
    }
  }

  // ── Itho / NRGWatch endpoints ──────────────────────────────────────────────

  _authHeader(username, password) {
    if (!username) return undefined;
    return 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
  }

  async _fetchEndpoint(ip, path, authHeader) {
    const headers = authHeader ? { Authorization: authHeader } : {};
    try {
      const res = await fetch(`http://${ip}${path}`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = await res.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async deviceStatus(body) {
    const ip = body && body.deviceIp;
    if (!ip) return { ok: false, error: 'No deviceIp provided' };
    const auth = this._authHeader(body.deviceUsername, body.devicePassword);
    return this._fetchEndpoint(ip, '/api.html?get=ithostatus', auth);
  }

  async moduleInfo(body) {
    const ip = body && body.deviceIp;
    if (!ip) return { ok: false, error: 'No deviceIp provided' };
    const auth = this._authHeader(body.deviceUsername, body.devicePassword);
    const [statusResult, queueResult] = await Promise.all([
      this._fetchEndpoint(ip, '/api.html?get=ithostatus', auth),
      this._fetchEndpoint(ip, '/api.html?get=queue', auth),
    ]);
    return {
      ok: statusResult.ok,
      error: statusResult.ok ? undefined : statusResult.error,
      status: statusResult.data,
      queue: queueResult.ok ? queueResult.data : null,
      meta: {
        deviceIp: ip,
        mqttBroker: body.mqttBroker || null,
        fetchedAt: new Date().toISOString(),
      },
    };
  }
}

// eslint-disable-next-line no-new
new IthoPluginUiServer();
