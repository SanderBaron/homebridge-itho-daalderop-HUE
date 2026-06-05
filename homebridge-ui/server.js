'use strict';

const { HomebridgePluginUiServer } = require('@homebridge/plugin-ui-utils');

class IthoPluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    this.onRequest('/device-status', this.handleGetDeviceStatus.bind(this));
    this.ready();
  }

  async handleGetDeviceStatus(body) {
    const ip = body && body.deviceIp;
    if (!ip) {
      return { ok: false, error: 'No deviceIp provided' };
    }

    try {
      const response = await fetch(`http://${ip}/api.html?get=ithostatus`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return { ok: false, error: `Device returned HTTP ${response.status}` };
      }
      const data = await response.json();
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
}

(() => new IthoPluginUiServer())();
