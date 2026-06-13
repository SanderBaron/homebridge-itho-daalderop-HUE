/* global homebridge */
/* eslint-env browser */
'use strict';

/**
 * Itho Daalderop — Homebridge custom UI client script.
 *
 * Loads the plugin config, lets the user edit it via a friendly form,
 * and saves back via the homebridge UI helpers. Communicates with the
 * plugin's UI server (`homebridge-ui/server.js`) for network tasks:
 * Hue discovery, pairing, light listing, sensor listing, and device status.
 */

// ─────────────────────────────────────────────── constants

const DAYS = [
  { val: 'mon', lbl: 'Ma' }, { val: 'tue', lbl: 'Di' },
  { val: 'wed', lbl: 'Wo' }, { val: 'thu', lbl: 'Do' },
  { val: 'fri', lbl: 'Vr' }, { val: 'sat', lbl: 'Za' },
  { val: 'sun', lbl: 'Zo' },
];

// ─────────────────────────────────────────────── state

const state = {
  config: {},
  lights: [],   // [{ id, name, type }]
  sensors: [],  // [{ id, name, type, modelid }]
  scheduleEntries: [],
  settingsLoaded: false,
  activeTab: 'dashboard',
};

// ─────────────────────────────────────────────── init

(async function init() {
  applyThemeFromHomebridge();
  wireTabButtons();
  wireButtons();
  try {
    const configs = await homebridge.getPluginConfig();
    state.config = (Array.isArray(configs) && configs[0]) || {};
    loadDashboard();
    setInterval(loadDashboard, 30_000);
  } catch (err) {
    homebridge.toast.error('Config laden mislukt: ' + describeError(err));
  }
})();

// ─────────────────────────────────────────────── tab switching

function wireTabButtons() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('hidden', p.id !== 'tab-' + tab);
  });
  const saveBar = document.getElementById('save-bar');
  if (saveBar) saveBar.style.display = tab === 'settings' ? 'flex' : 'none';
  if (tab === 'settings' && !state.settingsLoaded) {
    loadSettings();
  }
}

// ─────────────────────────────────────────────── button wiring
// All event handlers are attached here — no onclick/onchange attributes in HTML
// (Homebridge CSP blocks inline event handlers).

function wireButtons() {
  // Dashboard
  on('btn-refresh',       'click', () => loadDashboard());

  // Hue Bridge
  on('btn-discover',      'click', () => discoverBridges());
  on('btn-probe',         'click', () => probeBridge());
  on('btn-pair',          'click', () => pairBridge());
  on('btn-refresh-hue',   'click', () => refreshLightsAndSensors());

  // Humidity mode select
  on('humidity_mode', 'change', () => updateHumidityModeHints());

  // Schedule
  on('btn-add-schedule', 'click', () => {
    state.scheduleEntries.push({ label: '', days: [], from: '', to: '', speed: 'medium' });
    renderScheduleEntries();
  });

  // Save
  on('save-btn', 'click', () => saveSettings());

  // Toggle switches (labels with data-toggle attribute)
  document.querySelectorAll('.toggle-wrap[data-toggle]').forEach(label => {
    label.addEventListener('click', () => toggleSwitch(label.dataset.toggle));
  });
}

function on(id, event, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, handler);
}

function toggleSwitch(id) {
  const cb = document.getElementById(id);
  if (!cb) return;
  cb.checked = !cb.checked;
  updateToggleUI(id);
}

// ─────────────────────────────────────────────── dashboard

async function loadDashboard() {
  if (state.activeTab !== 'dashboard') return;

  const loadingEl = document.getElementById('dash-loading');
  const errorEl   = document.getElementById('dash-error');
  const bodyEl    = document.getElementById('dash-body');
  const refreshBtn = document.getElementById('btn-refresh');

  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const cfg = state.config;
    const deviceIp = cfg?.api?.deviceIp || (cfg?.api?.protocol === 'http' ? cfg?.api?.ip : null);
    // Loopback betekent "deze server" — toon dan het echte adres waarop
    // Homebridge bereikt wordt; dat leest prettiger bij troubleshooten.
    const brokerIp = ['127.0.0.1', 'localhost', '::1'].includes(cfg?.api?.ip)
      ? window.location.hostname
      : cfg?.api?.ip || '';
    const mqttBroker = cfg?.api?.protocol === 'mqtt'
      ? `${brokerIp}:${cfg.api.port || ''}` : null;

    if (!deviceIp) {
      showDashError('Geen device IP ingesteld. Ga naar Instellingen → Verbinding en vul het Device IP in.');
      return;
    }

    const result = await homebridge.request('/module-info', {
      deviceIp,
      mqttBroker,
      deviceUsername: cfg?.api?.deviceUsername,
      devicePassword: cfg?.api?.devicePassword,
    });

    if (!result.ok) {
      showDashError('Kan module niet bereiken op ' + deviceIp + ': ' + result.error);
      if (result.status) renderDashboard(result.status, result.queue, result.meta);
      return;
    }

    renderDashboard(result.status, result.queue, result.meta);
    bodyEl.classList.remove('hidden');
    const lu = document.getElementById('last-update');
    if (lu) lu.textContent = 'Bijgewerkt ' + new Date().toLocaleTimeString('nl-NL');
  } catch (err) {
    showDashError(describeError(err));
  } finally {
    loadingEl.classList.add('hidden');
    if (refreshBtn) refreshBtn.disabled = false;
  }
}

function showDashError(msg) {
  const el = document.getElementById('dash-error');
  el.textContent = '⚠ ' + msg;
  el.classList.remove('hidden');
}

function renderDashboard(d, queue, meta) {
  d = d || {};
  const body = document.getElementById('dash-body');
  if (!body) return;

  const mode = deriveMode(d);
  setText('val-mode', mode.label);
  const badge = document.getElementById('val-mode');
  if (badge) badge.className = 'mode-badge ' + mode.cls;
  setText('val-mode-sub', mode.sub);
  setText('val-speed', d['Speed status'] != null ? Math.round(d['Speed status']) + '%' : '–');

  const aq = airQuality(d['CO2level (ppm)']);
  const aqEl = document.getElementById('val-aq');
  if (aqEl) { aqEl.textContent = aq.text; aqEl.className = 'badge ' + aq.cls; }

  setText('val-co2',  d['CO2level (ppm)'] ?? '–');
  setText('val-hum',  d.hum  != null ? d.hum.toFixed(1)  : '–');
  setText('val-temp', d.temp != null ? d.temp.toFixed(1) : '–');
  const indoorHum = d['Indoorhumidity (%)'];
  setText('val-hum-indoor', indoorHum != null ? Number(indoorHum).toFixed(1) : '–');
  setText('val-exhfan',  d['ExhFanSpeed (%)'] ?? '–');
  setText('val-rpm',     d['Fan speed (rpm)'] ?? '–');
  setText('val-fault',   d['Internal fault'] ? '⚠ JA' : 'Geen');
  setText('val-uptime',  d['Total operation (hours)'] != null
    ? hoursToUptime(d['Total operation (hours)']) : '–');
  setText('val-startups', d['Startup counter'] ?? '–');

  setText('info-ip',   meta?.deviceIp  || '–');
  setText('info-mqtt', meta?.mqttBroker || '–');
  const statusEl = document.getElementById('info-status');
  if (statusEl) {
    statusEl.innerHTML = d
      ? '<span style="color:var(--success)">●</span> Online'
      : '<span style="color:var(--danger)">●</span> Offline';
  }

  if (queue) {
    setText('info-speed',    queue.ithoSpeed    ?? '–');
    setText('info-fallback', queue.fallBackSpeed ?? '–');
  }

  const co2v = d['Co2 velocity'];
  setText('info-co2vel', co2v == null ? '–' : co2v > 2 ? '⬆ Stijgend' : co2v < -2 ? '⬇ Dalend' : '➡ Stabiel');

  body.classList.remove('hidden');
}

// ─────────────────────────────────────────────── settings — load

async function loadSettings() {
  try {
    const configs = await homebridge.getPluginConfig();
    const cfg = (Array.isArray(configs) ? configs[0] : configs) || {};
    state.config = cfg;

    // Verbinding
    setVal('api_protocol',       cfg.api?.protocol     || 'mqtt');
    setVal('api_ip',             cfg.api?.ip            || '');
    setVal('api_port',           cfg.api?.port          || 1883);
    setVal('api_deviceIp',       cfg.api?.deviceIp      || '');
    setVal('api_username',       cfg.api?.username      || '');
    setVal('api_password',       cfg.api?.password      || '');
    setVal('api_deviceUsername', cfg.api?.deviceUsername || '');
    setVal('api_devicePassword', cfg.api?.devicePassword || '');

    // Turbo
    setVal('turbo_durationMinutes', cfg.automation?.turbo?.durationMinutes ?? 20);

    // Vochtigheid
    setToggle('humidity_enabled',        cfg.automation?.humidity?.enabled ?? true);
    setVal('humidity_mode',              cfg.automation?.humidity?.mode               ?? 'badkamer');
    setVal('humidity_boostThreshold',    cfg.automation?.humidity?.boostThreshold     ?? 85);
    setVal('humidity_dropThreshold',     cfg.automation?.humidity?.dropThreshold      ?? 82);
    setVal('humidity_cooldownMinutes',   cfg.automation?.humidity?.cooldownMinutes    ?? 20);
    setVal('humidity_riseRate',          cfg.automation?.humidity?.riseRate           ?? 3);
    setVal('humidity_riseWindowSeconds', cfg.automation?.humidity?.riseWindowSeconds  ?? 24);
    setVal('humidity_triggerLogic',      cfg.automation?.humidity?.triggerLogic       ?? 'or');
    setVal('humidity_minSpeedThreshold', cfg.automation?.humidity?.minSpeedThreshold  ?? 75);
    updateHumidityModeHints();

    // Tijdschema
    setToggle('schedule_enabled', cfg.automation?.schedule?.enabled ?? false);
    state.scheduleEntries = (cfg.automation?.schedule?.entries || []).map(e => ({
      ...e, days: [...(e.days || [])],
    }));
    renderScheduleEntries();

    // Hue bridge
    setVal('hue_bridgeIp', cfg.hue?.bridgeIp || '');
    setVal('hue_apiKey',   cfg.hue?.apiKey   || '');
    if (cfg.hue?.bridgeIp && cfg.hue?.apiKey) {
      setHueStatus('status-online', 'Verbonden (cached)');
      refreshLightsAndSensors(true).catch(() => undefined);
    }

    // Spiegelverwarming
    setToggle('mirrorHeater_enabled',       cfg.automation?.mirrorHeater?.enabled ?? false);
    setVal('mirrorHeater_hueLightId',       cfg.automation?.mirrorHeater?.hueLightId      || '');
    setVal('mirrorHeater_hueButtonId',      cfg.automation?.mirrorHeater?.hueButtonId     || '');
    setVal('mirrorHeater_triggerThreshold', cfg.automation?.mirrorHeater?.triggerThreshold ?? 70);
    setVal('mirrorHeater_dropThreshold',    cfg.automation?.mirrorHeater?.dropThreshold    ?? '');
    setVal('mirrorHeater_riseRate',          cfg.automation?.mirrorHeater?.riseRate          ?? 3);
    setVal('mirrorHeater_riseWindowSeconds', cfg.automation?.mirrorHeater?.riseWindowSeconds ?? 24);
    setVal('mirrorHeater_triggerLogic',      cfg.automation?.mirrorHeater?.triggerLogic      ?? 'or');
    setVal('mirrorHeater_durationMinutes',  cfg.automation?.mirrorHeater?.durationMinutes  ?? 15);
    setVal('mirrorHeater_triggerDelayMinutes', cfg.automation?.mirrorHeater?.triggerDelayMinutes ?? 5);

    // Toilet
    setToggle('toiletLight_enabled',      cfg.automation?.toiletLight?.enabled ?? false);
    setVal('toiletLight_hueSensorId',     cfg.automation?.toiletLight?.hueSensorId  || '');
    setVal('toiletLight_minOnMinutes',    cfg.automation?.toiletLight?.minOnMinutes  ?? 2);
    setVal('toiletLight_boostMinutes',    cfg.automation?.toiletLight?.boostMinutes  ?? 20);

    // Dagelijkse reset
    setToggle('dailyReset_enabled', cfg.dailyReset?.enabled ?? true);
    setVal('dailyReset_time',       cfg.dailyReset?.time    || '02:00');

    // Overig
    setToggle('verboseLogging', cfg.verboseLogging ?? false);
    setToggle('dataLogging_enabled', cfg.dataLogging?.enabled ?? false);

    state.settingsLoaded = true;
  } catch (err) {
    homebridge.toast.error('Instellingen laden mislukt: ' + describeError(err));
  }
}

// ─────────────────────────────────────────────── settings — save

/**
 * Saves only the hue section (bridgeIp + apiKey) immediately after pairing.
 * The rest of the settings remain untouched so partial edits aren't accidentally persisted.
 */
async function saveHueConfig() {
  try {
    const configs = await homebridge.getPluginConfig();
    const cfg = { ...((Array.isArray(configs) ? configs[0] : configs) || {}) };
    const ip  = getVal('hue_bridgeIp');
    const key = getVal('hue_apiKey');
    if (ip || key) {
      cfg.hue = {};
      if (ip)  cfg.hue.bridgeIp = ip;
      if (key) cfg.hue.apiKey   = key;
    }
    await homebridge.updatePluginConfig([cfg]);
    await homebridge.savePluginConfig();
  } catch (err) {
    homebridge.toast.warning('Gekoppeld, maar automatisch opslaan mislukt: ' + describeError(err));
  }
}

async function saveSettings() {
  const btn = document.getElementById('save-btn');
  const feedback = document.getElementById('save-feedback');
  btn.disabled = true;
  feedback.textContent = 'Bezig met opslaan…';
  feedback.className = 'save-feedback';

  try {
    const configs = await homebridge.getPluginConfig();
    const existing = (Array.isArray(configs) ? configs[0] : configs) || {};
    const cfg = { ...existing };

    cfg.platform = 'HomebridgeIthoDaalderop';
    cfg.name = existing.name || 'Itho Daalderop';

    cfg.api = {
      protocol: getVal('api_protocol') || 'mqtt',
      ip:   getVal('api_ip'),
      port: parseInt(getVal('api_port')) || 1883,
    };
    const devIp = getVal('api_deviceIp');
    const mqttU = getVal('api_username');
    const mqttP = getVal('api_password');
    const devU  = getVal('api_deviceUsername');
    const devP  = getVal('api_devicePassword');
    if (devIp) cfg.api.deviceIp        = devIp;
    if (mqttU) cfg.api.username        = mqttU;
    if (mqttP) cfg.api.password        = mqttP;
    if (devU)  cfg.api.deviceUsername  = devU;
    if (devP)  cfg.api.devicePassword  = devP;

    cfg.automation = {
      turbo: { durationMinutes: parseInt(getVal('turbo_durationMinutes')) || 20 },
      humidity: buildHumidityConfig(),
      schedule: {
        enabled: getChecked('schedule_enabled'),
        entries: state.scheduleEntries
          .filter(e => e.label || (e.days && e.days.length) || e.from || e.to)
          .map(e => ({ label: e.label||'', days: e.days||[], from: e.from||'', to: e.to||'', speed: e.speed||'medium' })),
      },
    };

    const mhEnabled  = getChecked('mirrorHeater_enabled');
    const mhLightId  = getVal('mirrorHeater_hueLightId');
    const mhButtonId = getVal('mirrorHeater_hueButtonId');
    if (mhEnabled || mhLightId) {
      cfg.automation.mirrorHeater = {
        enabled:              mhEnabled,
        triggerThreshold:     numVal('mirrorHeater_triggerThreshold', 70),
        riseRate:             numVal('mirrorHeater_riseRate', 3),
        riseWindowSeconds:    numVal('mirrorHeater_riseWindowSeconds', 24),
        triggerLogic:         getVal('mirrorHeater_triggerLogic') || 'or',
        durationMinutes:      numVal('mirrorHeater_durationMinutes', 15),
        triggerDelayMinutes:  numVal('mirrorHeater_triggerDelayMinutes', 5),
      };
      // Optional guard — empty or 0 means: omit from config (disabled)
      const mhDrop = optNumVal('mirrorHeater_dropThreshold');
      if (mhDrop !== undefined) cfg.automation.mirrorHeater.dropThreshold = mhDrop;
      if (mhLightId)  cfg.automation.mirrorHeater.hueLightId  = mhLightId;
      if (mhButtonId) cfg.automation.mirrorHeater.hueButtonId = mhButtonId;
    }

    const tlEnabled  = getChecked('toiletLight_enabled');
    const tlSensorId = getVal('toiletLight_hueSensorId');
    if (tlEnabled || tlSensorId) {
      cfg.automation.toiletLight = {
        enabled:       tlEnabled,
        minOnMinutes:  parseInt(getVal('toiletLight_minOnMinutes'))  || 2,
        boostMinutes:  parseInt(getVal('toiletLight_boostMinutes'))  || 20,
      };
      if (tlSensorId) cfg.automation.toiletLight.hueSensorId = tlSensorId;
    }

    const hueIp  = getVal('hue_bridgeIp');
    const hueKey = getVal('hue_apiKey');
    if (hueIp || hueKey) {
      cfg.hue = {};
      if (hueIp)  cfg.hue.bridgeIp = hueIp;
      if (hueKey) cfg.hue.apiKey   = hueKey;
    } else {
      delete cfg.hue;
    }

    cfg.dailyReset = {
      enabled: getChecked('dailyReset_enabled'),
      time:    getVal('dailyReset_time') || '02:00',
    };

    cfg.verboseLogging = getChecked('verboseLogging');
    cfg.dataLogging = { enabled: getChecked('dataLogging_enabled') };

    await homebridge.updatePluginConfig([cfg]);
    await homebridge.savePluginConfig();
    homebridge.toast.success('Instellingen opgeslagen — herstart de child bridge om ze te activeren.');
    feedback.textContent = '✓ Opgeslagen om ' + new Date().toLocaleTimeString('nl-NL');
    feedback.className = 'save-feedback success';
  } catch (err) {
    homebridge.toast.error('Opslaan mislukt: ' + describeError(err));
    feedback.textContent = '⚠ ' + describeError(err);
    feedback.className = 'save-feedback error';
  } finally {
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────── Hue actions

async function discoverBridges() {
  homebridge.showSpinner();
  const container = document.getElementById('discovery-results');
  container.innerHTML = '';
  container.classList.remove('hidden');
  try {
    const results = await homebridge.request('/discover-bridges', { timeoutMs: 6000 });
    if (!results || results.length === 0) {
      container.innerHTML = '<p class="muted">Geen Hue Bridges gevonden via cloud discovery.</p>';
      return;
    }
    results.forEach(c => {
      const row = document.createElement('div');
      row.className = 'result';
      row.innerHTML = `
        <span><strong>${esc(c.name || c.id)}</strong> · ${esc(c.ip)} <span class="muted">(${c.source})</span></span>
        <button type="button" class="primary small">Gebruik</button>
      `;
      row.querySelector('button').addEventListener('click', () => {
        setVal('hue_bridgeIp', c.ip);
        container.classList.add('hidden');
      });
      container.appendChild(row);
    });
  } catch (err) {
    container.innerHTML = '<p style="color:var(--danger)">' + esc(describeError(err)) + '</p>';
  } finally {
    homebridge.hideSpinner();
  }
}

async function probeBridge() {
  const ip = getVal('hue_bridgeIp');
  if (!ip) { homebridge.toast.warning('Vul eerst een Bridge IP in'); return; }
  setHueStatus('status-pending', 'Verbinding testen…');
  try {
    const result = await homebridge.request('/probe-bridge', { ip });
    if (result && result.ok) {
      setHueStatus('status-online', `Online — ${result.name || result.bridgeid || ''}`);
    } else {
      setHueStatus('status-offline', `Niet bereikbaar: ${result && result.error || '?'}`);
    }
  } catch (err) {
    setHueStatus('status-offline', describeError(err));
  }
}

async function pairBridge() {
  const ip = getVal('hue_bridgeIp');
  if (!ip) { homebridge.toast.warning('Vul eerst een Bridge IP in of klik op "Zoeken"'); return; }

  const btn      = document.getElementById('btn-pair');
  const statusEl = document.getElementById('pair-status');

  function setPairStatus(cls, msg) {
    if (!statusEl) return;
    statusEl.className = 'pair-status ' + cls;
    statusEl.textContent = msg;
  }

  // Lock UI
  if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
  setPairStatus('info', '⏳ Verbinding maken — druk nu op de knop van de Hue Bridge als je dat nog niet gedaan hebt.');

  const deadline = Date.now() + 30_000;
  let attempt = 0;

  try {
    while (Date.now() < deadline) {
      attempt++;
      const remaining = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setPairStatus('info', `⏳ Poging ${attempt}… (nog ${remaining}s) — wacht op bridge-knop`);

      try {
        const result = await homebridge.request('/pair-bridge', { ip });
        if (result && result.ok) {
          setVal('hue_apiKey', result.apiKey);
          setPairStatus('success', '✓ Gekoppeld! Instellingen opgeslagen.');
          setHueStatus('status-online', 'Verbonden');
          await saveHueConfig();
          homebridge.toast.success('Gekoppeld! Lampen en sensoren ophalen…');
          await refreshLightsAndSensors();
          return;
        }
        if (result && result.kind === 'link-not-pressed') {
          const rem2 = Math.max(0, Math.round((deadline - Date.now()) / 1000));
          setPairStatus('info', `⏳ Wacht op bridge-knop… (nog ${rem2}s) — druk nu op de ronde knop!`);
          await delay(2000);
          continue;
        }
      } catch (err) {
        setPairStatus('error', '⚠ ' + describeError(err));
        homebridge.toast.error(describeError(err));
        return;
    }
  }
  setPairStatus('error', '⚠ Timeout — druk op de Bridge-knop en klik meteen op Koppelen.');
  homebridge.toast.error('Koppelen mislukt (timeout) — druk op de knop en probeer opnieuw.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Koppelen'; }
  }
}

/** @param silent true bij automatisch laden — geen succes-toast, alleen fouten */
async function refreshLightsAndSensors(silent = false) {
  const ip     = getVal('hue_bridgeIp');
  const apiKey = getVal('hue_apiKey');
  if (!ip || !apiKey) return;

  homebridge.showSpinner();
  try {
    const [lights, sensors] = await Promise.all([
      homebridge.request('/list-lights',  { ip, apiKey }),
      homebridge.request('/list-sensors', { ip, apiKey }),
    ]);
    state.lights  = lights  || [];
    state.sensors = sensors || [];
    renderLightsList();
    renderSensorsList();
    populateLightDropdowns();
    populateSensorDropdowns();
    if (!silent) {
      homebridge.toast.success(`${state.lights.length} lampen, ${state.sensors.length} schakelaars gevonden`);
    }
  } catch (err) {
    homebridge.toast.error('Ophalen mislukt: ' + describeError(err));
  } finally {
    homebridge.hideSpinner();
  }
}

function renderLightsList() {
  const container = document.getElementById('hue-lights-list');
  const countEl   = document.getElementById('hue-lights-count');
  if (countEl) countEl.textContent = state.lights.length > 0 ? `(${state.lights.length})` : '';
  if (!container) return;
  if (!state.lights.length) {
    container.innerHTML = '<p class="empty">Geen lampen gevonden.</p>';
    return;
  }
  container.innerHTML = '';
  state.lights.forEach(l => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `<span><strong>#${esc(l.id)}</strong> ${esc(l.name)}</span><span class="muted">${esc(l.type)}</span>`;
    container.appendChild(row);
  });
}

function renderSensorsList() {
  const container = document.getElementById('hue-sensors-list');
  const countEl   = document.getElementById('hue-sensors-count');
  if (countEl) countEl.textContent = state.sensors.length > 0 ? `(${state.sensors.length})` : '';
  if (!container) return;
  if (!state.sensors.length) {
    container.innerHTML = '<p class="empty">Geen schakelaars/sensoren gevonden.</p>';
    return;
  }
  container.innerHTML = '';
  state.sensors.forEach(s => {
    const row = document.createElement('div');
    row.className = 'item-row';
    row.innerHTML = `<span><strong>#${esc(s.id)}</strong> ${esc(s.name)}</span><span class="muted">${esc(s.type)}</span>`;
    container.appendChild(row);
  });
}

function populateLightDropdowns() {
  populateSelect('mirrorHeater_hueLightId', state.lights,
    state.config?.automation?.mirrorHeater?.hueLightId,
    s => `#${s.id} ${s.name}`);
}

function populateSensorDropdowns() {
  populateSelect('mirrorHeater_hueButtonId', state.sensors,
    state.config?.automation?.mirrorHeater?.hueButtonId,
    s => `#${s.id} ${s.name} (${s.type})`);
  // Toilet: een zigbee-schakelaar kan bij Hue als lamp/stopcontact binnenkomen,
  // dus bied lampen én schakelaars aan. Waarde krijgt een type-prefix zodat de
  // backend weet wat hij moet pollen; een kale id (legacy) = sensor.
  const toiletItems = [
    ...state.lights.map(l  => ({ ...l, _kind: 'light' })),
    ...state.sensors.map(s => ({ ...s, _kind: 'sensor' })),
  ];
  let savedToilet = state.config?.automation?.toiletLight?.hueSensorId || '';
  if (savedToilet && !savedToilet.includes(':')) savedToilet = 'sensor:' + savedToilet;
  populateSelect('toiletLight_hueSensorId', toiletItems, savedToilet,
    i => i._kind === 'light' ? `💡 #${i.id} ${i.name} (lamp)` : `🔘 #${i.id} ${i.name} (${i.type})`,
    i => `${i._kind}:${i.id}`);
}

function populateSelect(elementId, items, savedVal, labelFn, valueFn) {
  const sel = document.getElementById(elementId);
  if (!sel) return;
  // Prefer an in-session selection; fall back to the saved config value.
  // The saved value can't be read from the <select> itself: at load time the
  // options don't exist yet, so the browser silently drops the assignment.
  const currentVal = getVal(elementId) || (savedVal != null ? String(savedVal) : '');
  sel.innerHTML = '<option value="">(selecteer…)</option>';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = valueFn ? valueFn(item) : String(item.id);
    opt.textContent = labelFn(item);
    if (opt.value === currentVal) opt.selected = true;
    sel.appendChild(opt);
  });
}

function setHueStatus(cls, text) {
  const dot = document.getElementById('hue-status-dot');
  const lbl = document.getElementById('hue-status-text');
  if (dot) dot.className = 'status-dot ' + cls;
  if (lbl) lbl.textContent = text;
}

// ─────────────────────────────────────────────── humidity mode

function updateHumidityModeHints() {
  const mode = getVal('humidity_mode');
  const isBadkamer = mode !== 'wasruimte';
  document.getElementById('badkamer-fields')?.classList.toggle('hidden', !isBadkamer);
  document.getElementById('wasruimte-fields')?.classList.toggle('hidden', isBadkamer);
  const hint = document.getElementById('humidity-mode-hint');
  if (!hint) return;
  if (isBadkamer) {
    hint.textContent = 'Badkamer: absolute drempel + snelle stijging + minimale cooldown.';
    const lbl1 = document.getElementById('lbl-boostThreshold');
    const lbl2 = document.getElementById('lbl-dropThreshold');
    if (lbl1) lbl1.textContent = 'Absolute drempel (%)';
    if (lbl2) lbl2.textContent = 'Terugkeerdrempel (%)';
  } else {
    hint.textContent = 'Wasruimte: drie zones. Onder minimum-drempel → laag, boven absolute drempel → hoog.';
    const lbl1 = document.getElementById('lbl-boostThreshold');
    const lbl2 = document.getElementById('lbl-dropThreshold');
    if (lbl1) lbl1.textContent = 'Hoog-drempel (%)';
    if (lbl2) lbl2.textContent = 'Laag→auto drempel (%)';
  }
}

function buildHumidityConfig() {
  const mode = getVal('humidity_mode') || 'badkamer';
  const cfg = {
    enabled:        getChecked('humidity_enabled'),
    mode,
    boostThreshold: numVal('humidity_boostThreshold', 85),
    dropThreshold:  numVal('humidity_dropThreshold', 82),
  };
  if (mode !== 'wasruimte') {
    cfg.cooldownMinutes   = numVal('humidity_cooldownMinutes', 20);
    cfg.riseRate          = numVal('humidity_riseRate', 3);
    cfg.riseWindowSeconds = numVal('humidity_riseWindowSeconds', 24);
    cfg.triggerLogic      = getVal('humidity_triggerLogic') || 'or';
  } else {
    cfg.minSpeedThreshold = numVal('humidity_minSpeedThreshold', 75);
  }
  return cfg;
}

// ─────────────────────────────────────────────── schedule entries

function renderScheduleEntries() {
  const container = document.getElementById('schedule-entries');
  if (!container) return;
  container.innerHTML = '';
  if (!state.scheduleEntries.length) {
    container.innerHTML = '<p class="empty">Nog geen tijdvensters.</p>';
    return;
  }
  state.scheduleEntries.forEach((entry, idx) => {
    container.appendChild(buildEntryCard(entry, idx));
  });
}

function buildEntryCard(entry, idx) {
  const card = document.createElement('div');
  card.className = 'entry-card';

  const days = DAYS.map(d => `
    <span class="day-pill${(entry.days||[]).includes(d.val) ? ' selected' : ''}"
          data-day="${d.val}" data-idx="${idx}">${d.lbl}</span>
  `).join('');

  card.innerHTML = `
    <div class="entry-head">
      <span class="entry-num">Tijdvenster ${idx + 1}</span>
      <button type="button" class="danger small" data-del="${idx}">✕</button>
    </div>
    <div class="form-grid two" style="margin-bottom:10px;">
      <label>Label
        <input type="text" data-field="label" data-idx="${idx}"
               value="${esc(entry.label || '')}" placeholder="bijv. Ochtend luchten" />
      </label>
      <label>Snelheid
        <select data-field="speed" data-idx="${idx}">
          <option value="low"    ${entry.speed==='low'    ?'selected':''}>Laag</option>
          <option value="medium" ${entry.speed==='medium' ?'selected':''}>Middel</option>
          <option value="high"   ${entry.speed==='high'   ?'selected':''}>Hoog</option>
        </select>
      </label>
    </div>
    <div style="margin-bottom:10px;">
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px;">Dagen</div>
      <div class="days-wrap">${days}</div>
    </div>
    <div class="form-grid two">
      <label>Van (UU:MM)
        <input type="text" data-field="from" data-idx="${idx}"
               value="${esc(entry.from||'')}" placeholder="07:00" />
      </label>
      <label>Tot (UU:MM)
        <input type="text" data-field="to" data-idx="${idx}"
               value="${esc(entry.to||'')}" placeholder="08:00" />
      </label>
    </div>
  `;

  card.querySelectorAll('[data-field]').forEach(el => {
    el.addEventListener('input', () => {
      state.scheduleEntries[parseInt(el.dataset.idx)][el.dataset.field] = el.value;
    });
    el.addEventListener('change', () => {
      state.scheduleEntries[parseInt(el.dataset.idx)][el.dataset.field] = el.value;
    });
  });

  card.querySelectorAll('.day-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const i = parseInt(pill.dataset.idx);
      const day = pill.dataset.day;
      const e = state.scheduleEntries[i];
      if (!e.days) e.days = [];
      if (e.days.includes(day)) {
        e.days = e.days.filter(d => d !== day);
        pill.classList.remove('selected');
      } else {
        e.days.push(day);
        pill.classList.add('selected');
      }
    });
  });

  card.querySelector('[data-del]').addEventListener('click', () => {
    state.scheduleEntries.splice(idx, 1);
    renderScheduleEntries();
  });

  return card;
}

// ─────────────────────────────────────────────── dashboard helpers

function deriveMode(d) {
  const fi = (d['FanInfo'] || '').toLowerCase();
  switch (fi) {
    case 'high':   return { label: 'Turbo',       sub: 'Maximale stand',    cls: 'bad' };
    case 'auto':   return { label: 'Automatisch', sub: 'CO₂-gestuurd',      cls: 'good' };
    case 'medium': return { label: 'Normaal',     sub: 'Gemiddelde stand',   cls: 'warn' };
    case 'low':    return { label: 'Nachtstand',  sub: 'Laagste stand',      cls: 'night' };
    case 'away':   return { label: 'Afwezig',     sub: 'Afwezigheidsstand',  cls: 'night' };
    default:       return { label: fi || '–',     sub: '',                   cls: 'default' };
  }
}

function airQuality(ppm) {
  if (ppm == null) return { text: 'Onbekend', cls: '' };
  if (ppm < 350)   return { text: 'Uitstekend', cls: 'good' };
  if (ppm < 1000)  return { text: 'Goed',       cls: 'good' };
  if (ppm < 2500)  return { text: 'Matig',      cls: 'warn' };
  if (ppm < 5000)  return { text: 'Slecht',     cls: 'warn' };
  return                  { text: 'Gevaarlijk',  cls: 'bad' };
}

function hoursToUptime(h) {
  h = Math.floor(h);
  const years    = Math.floor(h / 8760);
  const remH     = h % 8760;
  const days     = Math.floor(remH / 24);
  const hours    = remH % 24;
  const parts = [];
  if (years > 0) parts.push(years + ' jaar');
  if (days > 0)  parts.push(days + ' dag' + (days !== 1 ? 'en' : ''));
  parts.push(hours + ' uur');
  return parts.join(', ');
}

// ─────────────────────────────────────────────── theme

function applyThemeFromHomebridge() {
  let resolved = null;
  try {
    if (window.parent && window.parent !== window && window.parent.document) {
      const cls = window.parent.document.body.classList;
      if (cls.contains('dark-mode')) resolved = 'dark';
      else if (cls.contains('light-mode')) resolved = 'light';
      else for (const c of cls) {
        if (c.includes('dark'))  { resolved = 'dark';  break; }
        if (c.includes('light')) { resolved = 'light'; break; }
      }
    }
  } catch { /* cross-origin */ }

  if (resolved === null) {
    try {
      const theme = String((homebridge?.serverEnv?.theme) || '').toLowerCase();
      if (theme.includes('dark'))  resolved = 'dark';
      else if (theme.includes('light')) resolved = 'light';
    } catch { /* ignore */ }
  }

  if (resolved !== null) document.body.setAttribute('data-theme', resolved);
}

// ─────────────────────────────────────────────── DOM helpers

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = (val != null && val !== '') ? String(val) : '–';
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.type === 'checkbox') el.checked = !!val;
  else el.value = (val == null) ? '' : String(val);
}

function getVal(id) {
  const el = document.getElementById(id);
  if (!el) return '';
  if (el.type === 'checkbox') return el.checked;
  return el.value;
}

function getChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}

/**
 * Numeric field value with fallback. Unlike `parseInt(...) || fallback`,
 * a valid 0 is preserved — only empty/non-numeric input yields the fallback.
 */
function numVal(id, fallback) {
  const v = parseFloat(getVal(id));
  return Number.isFinite(v) ? v : fallback;
}

/** Numeric field value, or undefined when empty/non-numeric/zero (optional fields). */
function optNumVal(id) {
  const v = parseFloat(getVal(id));
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

function setToggle(id, val) {
  const el = document.getElementById(id);
  if (el) { el.checked = !!val; updateToggleUI(id); }
}

function updateToggleUI(id) {
  const cb  = document.getElementById(id);
  const tog = document.getElementById('toggle-' + id);
  const lbl = document.getElementById('toggle-label-' + id);
  if (!cb || !tog) return;
  const on = cb.checked;
  tog.classList.toggle('on', on);
  if (lbl) lbl.textContent = on ? 'Aan' : 'Uit';
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function describeError(err) {
  if (!err) return 'onbekende fout';
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  return String(err);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
