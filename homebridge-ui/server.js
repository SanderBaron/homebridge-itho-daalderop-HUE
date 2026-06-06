'use strict';

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

class IthoPluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/device-status', this.handleGetDeviceStatus.bind(this));
    this.onRequest('/module-info', this.handleGetModuleInfo.bind(this));
    this.ready();
  }

  /**
   * Build Basic-Auth header value from optional credentials.
   * Returns undefined when no username is given.
   */
  _authHeader(username, password) {
    if (!username) return undefined;
    return 'Basic ' + Buffer.from(`${username}:${password || ''}`).toString('base64');
  }

  /**
   * Fetch a single endpoint from the NRGWatch HTTP API.
   * Returns { ok, data | error }.
   */
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

  /** /device-status — main ithostatus payload */
  async handleGetDeviceStatus(body) {
    const ip = body && body.deviceIp;
    if (!ip) return { ok: false, error: 'No deviceIp provided' };

    const auth = this._authHeader(body.deviceUsername, body.devicePassword);
    return this._fetchEndpoint(ip, '/api.html?get=ithostatus', auth);
  }

  /** /module-info — ithostatus + queue combined, plus echo of connection params */
  async handleGetModuleInfo(body) {
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

(() => new IthoPluginUiServer())();
