import { Logger } from 'homebridge';
import { HueApi } from '@/api/hue';

export interface MirrorHeaterConfig {
  enabled: boolean;
  /** Hue light resource ID for the mirror heater */
  hueLightId: string;
  /** Hue button/sensor resource ID for manual trigger (optional) */
  hueButtonId?: string;
  /**
   * RFT-RV humidity threshold (%) that triggers the mirror heater.
   * Source: 'Indoorhumidity (%)' from ithostatus — the external RFT-RV sensor.
   */
  triggerThreshold: number;
  /**
   * Optional fast-rise trigger: activate when humidity rises by this many
   * percent within `riseWindowSeconds`. Works as OR with triggerThreshold.
   * Set to 0 or omit to disable.
   */
  riseRate?: number;
  /** Window for fast-rise detection in seconds. */
  riseWindowSeconds?: number;
  /**
   * How triggerThreshold and fast rise combine (default 'or'):
   * 'or' | 'and' | 'threshold' (absolute only) | 'rise' (fast rise only)
   */
  triggerLogic?: 'or' | 'and' | 'threshold' | 'rise';
  /**
   * Optional: if humidity drops below this value after activation, the off-timer
   * is already running so nothing changes — but the guard during the delay window
   * uses this to avoid activating if humidity already dropped back down.
   * If omitted, the guard is skipped (always activate after delay).
   */
  dropThreshold?: number;
  /**
   * Minimum minutes after the CVE fan boost before the mirror heater can
   * activate. The mirror is not immediately fogged on shower start.
   */
  triggerDelayMinutes: number;
  /** Minutes the mirror heater stays on after it activates */
  durationMinutes: number;
  /** Minutes the mirror heater stays on when triggered manually via Hue button */
  manualButtonTimerMinutes: number;
}

type MirrorState = 'idle' | 'delay_waiting' | 'active';
type TriggerReason = 'absolute' | 'rise' | 'absolute+rise';

const BUTTON_POLL_INTERVAL_MS = 5_000;

/**
 * Controls a mirror heater (Hue light) based on the external RFT-RV humidity
 * sensor ('Indoorhumidity (%)' in the ithostatus MQTT payload).
 *
 * Trigger logic (OR):
 *   - Absolute threshold: humidity ≥ triggerThreshold
 *   - Fast rise: humidity rose ≥ riseRate% within riseWindowSeconds
 *
 * State machine:
 *
 *   idle ──(trigger, delay not met)──▶ delay_waiting
 *   idle ──(trigger, delay met)──▶ active
 *   delay_waiting ──(delay timer)──▶ active  (or idle when humidity already dropped)
 *   active ──(durationMinutes timer, started at activation)──▶ idle
 *
 * Manual button trigger bypasses delay and resets the timer.
 */
export class MirrorHeaterAutomation {
  private state: MirrorState = 'idle';
  private offTimer: ReturnType<typeof setTimeout> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private buttonPollInterval: ReturnType<typeof setInterval> | null = null;

  /** When the CVE fan boost started (ms since epoch). */
  private fanBoostStartedAt: number | null = null;
  /** Last RFT-RV humidity value received. */
  private lastHumidity: number | null = null;
  /** Last Hue button lastupdated timestamp — used to detect press events. */
  private lastButtonUpdated: string | null = null;
  /** Sliding window of (timestamp, humidity) pairs for fast-rise detection. */
  private humidityWindow: Array<{ ts: number; val: number }> = [];

  constructor(
    private readonly config: MirrorHeaterConfig,
    private readonly hue: HueApi,
    private readonly log: Logger,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Start button polling (if hueButtonId is configured). Call once after construction. */
  start(): void {
    if (!this.config.enabled || !this.config.hueButtonId) return;
    this.log.info('[Mirror] Knop-polling gestart (interval: 5s)');
    this.buttonPollInterval = setInterval(() => { void this.pollButton(); }, BUTTON_POLL_INTERVAL_MS);
    void this.pollButton();
  }

  /**
   * Call when the CVE humidity automation triggers a fan boost.
   * Sets the timestamp for the triggerDelayMinutes check.
   */
  onFanBoostStarted(): void {
    this.fanBoostStartedAt = Date.now();
    this.log.debug('[Mirror] Fan boost geregistreerd — vertraging loopt');
  }

  /**
   * Feed the RFT-RV humidity value here on every MQTT update.
   * Source: ithostatus field 'Indoorhumidity (%)'
   */
  update(humidity: number): void {
    // RFT-RV dropouts arrive as 0 — ignore them entirely so a 0→real jump
    // can never count as a fast rise
    if (!Number.isFinite(humidity) || humidity <= 0) return;
    this.lastHumidity = humidity;
    const now = Date.now();

    // Maintain sliding window for fast-rise detection
    const windowMs = (this.config.riseWindowSeconds ?? 0) * 1_000;
    if (windowMs > 0) {
      this.humidityWindow.push({ ts: now, val: humidity });
      this.humidityWindow = this.humidityWindow.filter(e => now - e.ts <= windowMs);
    }

    if (!this.config.enabled || !this.config.hueLightId) return;

    switch (this.state) {
      case 'idle':
        this.checkTrigger(humidity, now);
        break;

      case 'delay_waiting':
        // Delay timer is running — nothing to do on updates
        break;

      case 'active':
        // Off-timer is running since activation. Log when humidity drops below
        // the optional drop threshold so the user can follow progress.
        if (this.config.dropThreshold !== undefined && humidity < this.config.dropThreshold) {
          this.log.debug(
            `[Mirror] Vochtigheid ${humidity.toFixed(0)}% onder uitschakeldrempel ` +
            `${this.config.dropThreshold}% — off-timer loopt door`,
          );
        }
        break;
    }
  }

  getState(): MirrorState { return this.state; }

  destroy(): void {
    this.cancelDelayTimer();
    this.cancelOffTimer();
    if (this.buttonPollInterval) {
      clearInterval(this.buttonPollInterval);
      this.buttonPollInterval = null;
    }
  }

  // ── Trigger detection ──────────────────────────────────────────────────────

  private checkTrigger(humidity: number, now: number): void {
    const absolute = humidity >= this.config.triggerThreshold;
    const rise = this.detectRise(humidity, now);

    let fired: boolean;
    let reason: TriggerReason;
    switch (this.config.triggerLogic ?? 'or') {
      case 'and':       fired = absolute && rise; reason = 'absolute+rise'; break;
      case 'threshold': fired = absolute;         reason = 'absolute';      break;
      case 'rise':      fired = rise;             reason = 'rise';          break;
      case 'or':
      default:          fired = absolute || rise; reason = absolute ? 'absolute' : 'rise'; break;
    }
    if (fired) this.tryActivate(humidity, reason);
  }

  private detectRise(humidity: number, now: number): boolean {
    const riseRate = this.config.riseRate ?? 0;
    const windowMs = (this.config.riseWindowSeconds ?? 0) * 1_000;
    if (riseRate <= 0 || windowMs <= 0 || this.humidityWindow.length < 2) return false;
    const oldest = this.humidityWindow[0];
    if (oldest === undefined || now - oldest.ts > windowMs) return false;
    if (humidity - oldest.val < riseRate) return false;
    this.log.debug(
      `[Mirror] Snelle stijging gedetecteerd: +${(humidity - oldest.val).toFixed(1)}% ` +
      `in ${Math.round((now - oldest.ts) / 1000)}s`,
    );
    return true;
  }

  // ── Manual trigger ─────────────────────────────────────────────────────────

  private onManualTrigger(): void {
    this.log.info(
      `[Mirror] Handmatig ingeschakeld via Hue knop — ${this.config.manualButtonTimerMinutes} min timer`,
    );
    this.cancelDelayTimer();
    this.cancelOffTimer();
    this.state = 'active';
    this.turnOn();
    this.scheduleOff(this.config.manualButtonTimerMinutes);
  }

  // ── Activation logic ───────────────────────────────────────────────────────

  private tryActivate(humidity: number, reason: TriggerReason): void {
    const delayMs = this.config.triggerDelayMinutes * 60_000;
    // Delay anchor: the CVE fan boost when one is running, otherwise the
    // mirror's own trigger moment — the mirror never activates instantly
    // just because the fan boost is absent
    const elapsed = this.fanBoostStartedAt
      ? Date.now() - this.fanBoostStartedAt
      : 0;

    if (elapsed < delayMs) {
      const remainingMs = delayMs - elapsed;
      this.state = 'delay_waiting';
      this.log.info(
        `[Mirror] RFT-RV ${humidity.toFixed(0)}% trigger (${reason}) ` +
        `— wacht nog ${Math.round(remainingMs / 1000)}s op vertraging`,
      );
      this.delayTimer = setTimeout(() => {
        this.delayTimer = null;
        if (this.state !== 'delay_waiting') return;
        // Guard: if dropThreshold configured and humidity already dropped — skip
        if (
          this.config.dropThreshold !== undefined &&
          this.lastHumidity !== null &&
          this.lastHumidity < this.config.dropThreshold
        ) {
          this.state = 'idle';
          this.log.debug('[Mirror] Vertraging voorbij maar vochtigheid al gedaald — geen activatie');
          return;
        }
        this.activate(this.lastHumidity ?? humidity, reason);
      }, remainingMs);
    } else {
      this.activate(humidity, reason);
    }
  }

  private activate(humidity: number, reason: TriggerReason): void {
    this.state = 'active';
    this.log.info(
      `[Mirror] Spiegel AAN — RFT-RV ${humidity.toFixed(0)}% (trigger: ${reason}) ` +
      `— ${this.config.durationMinutes} min timer gestart`,
    );
    this.turnOn();
    this.scheduleOff(this.config.durationMinutes);
  }

  /** Start the off-timer. Cancels any existing one first. */
  private scheduleOff(durationMinutes: number): void {
    this.cancelOffTimer();
    this.offTimer = setTimeout(() => {
      this.offTimer = null;
      this.log.info('[Mirror] Timer verlopen — spiegel uit');
      this.turnOff();
      this.state = 'idle';
    }, durationMinutes * 60_000);
  }

  // ── Hue control ────────────────────────────────────────────────────────────

  private turnOn(): void {
    this.hue.setLightOn(this.config.hueLightId, true).catch((err: unknown) => {
      this.log.error(
        `[Mirror] Lamp inschakelen mislukt: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private turnOff(): void {
    this.hue.setLightOn(this.config.hueLightId, false).catch((err: unknown) => {
      this.log.error(
        `[Mirror] Lamp uitschakelen mislukt: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  private async pollButton(): Promise<void> {
    if (!this.config.hueButtonId) return;
    try {
      const sensor = await this.hue.getSensor(this.config.hueButtonId);
      const { lastupdated } = sensor.state;
      if (this.lastButtonUpdated !== null && lastupdated !== this.lastButtonUpdated) {
        this.onManualTrigger();
      }
      this.lastButtonUpdated = lastupdated;
    } catch (err: unknown) {
      this.log.debug(
        `[Mirror] Knop poll fout: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Timer helpers ──────────────────────────────────────────────────────────

  private cancelDelayTimer(): void {
    if (this.delayTimer) { clearTimeout(this.delayTimer); this.delayTimer = null; }
  }

  private cancelOffTimer(): void {
    if (this.offTimer) { clearTimeout(this.offTimer); this.offTimer = null; }
  }
}
