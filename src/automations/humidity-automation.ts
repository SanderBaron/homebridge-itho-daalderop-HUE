import { Logger } from 'homebridge';
import { HumidityAutomationState, SupportedVirtualRemoteCommands } from '@/types';

export interface HumidityAutomationConfig {
  enabled: boolean;
  /** 'badkamer': absolute + rapid-rise + minimum timer. 'wasruimte': three-zone threshold. */
  mode: 'badkamer' | 'wasruimte';
  /** Absolute humidity level that triggers boost (%) */
  boostThreshold: number;
  /** Humidity must be below this for the minimum timer to end the boost (%) */
  dropThreshold: number;
  /** Minimum minutes to keep fan at high (applies to both quick and long showers) */
  cooldownMinutes: number;
  /** Rapid-rise detection: trigger boost when humidity rises this many % within riseWindowSeconds (0 = disabled) */
  riseRate: number;
  /** Rapid-rise detection window (seconds) */
  riseWindowSeconds: number;
  /**
   * How the two badkamer triggers combine (default 'or'):
   *   'or'        — absolute threshold OR rapid rise
   *   'and'       — both must hold; filters household moisture pulses at low
   *                 humidity and slow weather creep past the threshold
   *   'threshold' — absolute threshold only
   *   'rise'      — rapid rise only
   */
  triggerLogic?: 'or' | 'and' | 'threshold' | 'rise';
  /** Wasruimte only: below this humidity the fan is set to low (%) */
  minSpeedThreshold: number;
}

export type SpeedChangeCallback = (speed: SupportedVirtualRemoteCommands | 'auto') => void;

const HISTORY_MAX_MS = 120_000; // keep 2 minutes of history for rapid-rise detection

/**
 * Humidity-based fan automation for Itho Daalderop CVE.
 *
 * Badkamer state machine (two states: idle / boosting):
 *
 *   idle ──(absolute threshold OR rapid rise)──▶ boosting
 *         sends 'high', starts minimum timer
 *
 *   boosting ──(timer elapsed AND hum < dropThreshold)──▶ idle
 *              sends 'auto'
 *
 * The minimum timer prevents premature return to auto for quick showers.
 * For long showers (hum stays high after the timer), the fan keeps running
 * at high until humidity actually drops below dropThreshold.
 *
 * Rapid-rise triggered boosts at low absolute humidity (e.g. 48%) no longer
 * cause boost→cooldown cycling, because the timer runs its full duration
 * before checking the dropThreshold exit condition.
 *
 * Wasruimte: simple three-zone threshold, no timer.
 */
export class HumidityAutomation {
  private state: HumidityAutomationState = 'idle';

  /** The minimum-hold timer. Restarted on each re-trigger. */
  private minTimer: ReturnType<typeof setTimeout> | null = null;
  private minTimerEndsAt: number | null = null;

  /**
   * True once the minimum timer has elapsed.
   * In 'boosting': the fan returns to auto on the next update where hum < dropThreshold.
   */
  private minElapsed = false;

  /** Last known humidity value — used by the timer callback. */
  private lastHumidity: number | null = null;

  /** Sliding window of (time, humidity) for rapid-rise detection. */
  private history: Array<{ time: number; value: number }> = [];

  /** Wasruimte: last issued command to suppress redundant MQTT messages. */
  private lastWasruimteCmd: string | null = null;

  constructor(
    private readonly config: HumidityAutomationConfig,
    private readonly onSpeedChange: SpeedChangeCallback,
    private readonly log: Logger,
  ) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /** Called on every MQTT status update with the current humidity reading. */
  update(humidity: number): void {
    this.lastHumidity = humidity;
    this.recordHistory(humidity);
    if (!this.config.enabled) return;

    if (this.config.mode === 'wasruimte') {
      this.updateWasruimte(humidity);
    } else {
      this.updateBadkamer(humidity);
    }
  }

  getState(): HumidityAutomationState { return this.state; }

  /** Returns the timestamp (ms) when the minimum boost timer expires, or null. */
  getMinTimerEndsAt(): number | null { return this.minTimerEndsAt; }

  /** @deprecated Use getMinTimerEndsAt() */
  getCooldownEndsAt(): number | null { return this.getMinTimerEndsAt(); }

  getLastHumidity(): number | null { return this.lastHumidity; }

  /** Cancel any active automation (called on manual override). */
  cancel(): void {
    this.clearMinTimer();
    this.state = 'idle';
    this.lastWasruimteCmd = null;
  }

  destroy(): void {
    this.clearMinTimer();
  }

  // ── Badkamer mode ─────────────────────────────────────────────────────────

  private updateBadkamer(hum: number): void {
    const trigger = this.evaluateTrigger(hum);

    switch (this.state) {
      case 'idle':
        if (trigger.fired) {
          this.startBoosting(trigger.reason);
        }
        break;

      case 'boosting':
        if (trigger.fired) {
          // Hum still rising or re-triggering — restart the minimum timer so we don't
          // exit too early. Only restart if it already elapsed (re-trigger after a break).
          if (this.minElapsed) {
            this.log.info(`[Humidity] Herstart boost: ${hum.toFixed(1)}% — minimale timer opnieuw gestart`);
            this.startMinTimer();
          }
          // else: timer still running, nothing to do
        } else if (this.minElapsed && hum < this.config.dropThreshold) {
          // Minimum time has passed AND humidity is sufficiently low → back to auto
          this.finishBoosting(hum);
        }
        // else: timer still running, or hum between dropThreshold and boostThreshold → keep waiting
        break;
    }
  }

  /**
   * Combines the absolute threshold and rapid-rise conditions per triggerLogic.
   * Returns the human-readable reason for the boost-start log line.
   */
  private evaluateTrigger(hum: number): { fired: boolean; reason: string } {
    const absolute = hum >= this.config.boostThreshold;
    const rapidRise = this.detectRapidRise(hum);
    const abs = `${hum.toFixed(1)}% ≥ drempel ${this.config.boostThreshold}%`;

    switch (this.config.triggerLogic ?? 'or') {
      case 'and':
        return { fired: absolute && rapidRise, reason: `${abs} én snelle stijging` };
      case 'threshold':
        return { fired: absolute, reason: abs };
      case 'rise':
        return { fired: rapidRise, reason: 'snelle stijging gedetecteerd' };
      case 'or':
      default:
        return { fired: absolute || rapidRise, reason: absolute ? abs : 'snelle stijging gedetecteerd' };
    }
  }

  private startBoosting(reason: string): void {
    this.clearMinTimer();
    this.state = 'boosting';
    this.log.info(`[Humidity] Boost gestart (${reason}) — ventilator naar HIGH, minimaal ${this.config.cooldownMinutes} min`);
    this.onSpeedChange('high');
    this.startMinTimer();
  }

  private startMinTimer(): void {
    this.clearMinTimer();
    this.minElapsed = false;
    const ms = this.config.cooldownMinutes * 60_000;
    this.minTimerEndsAt = Date.now() + ms;
    this.minTimer = setTimeout(() => {
      this.minTimer = null;
      this.minTimerEndsAt = null;
      this.minElapsed = true;
      this.log.debug(
        `[Humidity] Minimale boudsttijd verstreken — vochtigheid: ${this.lastHumidity?.toFixed(1)}%`,
      );
      // Check immediately with the last known humidity
      if (this.state === 'boosting' && this.lastHumidity !== null && this.lastHumidity < this.config.dropThreshold) {
        this.finishBoosting(this.lastHumidity);
      }
      // If still humid: the next update() call will call finishBoosting() when hum drops
    }, ms);
  }

  private finishBoosting(hum: number): void {
    this.clearMinTimer();
    this.state = 'idle';
    this.log.info(`[Humidity] Boost afgerond — ${hum.toFixed(1)}% < ${this.config.dropThreshold}% — terug naar automatisch`);
    this.onSpeedChange('auto');
  }

  private clearMinTimer(): void {
    if (this.minTimer) {
      clearTimeout(this.minTimer);
      this.minTimer = null;
      this.minTimerEndsAt = null;
    }
    this.minElapsed = false;
  }

  // ── Wasruimte mode ────────────────────────────────────────────────────────

  /**
   * Three-zone logic per Itho spec:
   *   hum < minSpeedThreshold  → low
   *   minSpeedThreshold ≤ hum < boostThreshold → auto (medium)
   *   hum ≥ boostThreshold     → high
   */
  private updateWasruimte(hum: number): void {
    let cmd: string;
    if (hum >= this.config.boostThreshold) {
      cmd = 'high';
    } else if (hum < this.config.minSpeedThreshold) {
      cmd = 'low';
    } else {
      cmd = 'auto';
    }

    if (cmd !== this.lastWasruimteCmd) {
      this.lastWasruimteCmd = cmd;
      this.log.info(
        `[Humidity] Wasruimte: ${hum.toFixed(1)}% → ${cmd} ` +
        `(laag <${this.config.minSpeedThreshold}%, hoog ≥${this.config.boostThreshold}%)`,
      );
      this.onSpeedChange(cmd as SupportedVirtualRemoteCommands | 'auto');
    }
  }

  // ── Rapid-rise detection ──────────────────────────────────────────────────

  private recordHistory(hum: number): void {
    const now = Date.now();
    this.history.push({ time: now, value: hum });
    const cutoff = now - HISTORY_MAX_MS;
    while (this.history.length > 1 && this.history[0].time < cutoff) {
      this.history.shift();
    }
  }

  private detectRapidRise(currentHum: number): boolean {
    if (this.config.riseRate <= 0 || this.config.riseWindowSeconds <= 0) return false;
    const windowMs = this.config.riseWindowSeconds * 1000;
    const cutoff = Date.now() - windowMs;
    const inWindow = this.history.filter(e => e.time >= cutoff);
    if (inWindow.length === 0) return false;
    const rise = currentHum - inWindow[0].value;
    if (rise >= this.config.riseRate) {
      this.log.debug(
        `[Humidity] Snelle stijging: +${rise.toFixed(1)}% in ${this.config.riseWindowSeconds}s ` +
        `(drempel: ${this.config.riseRate}%)`,
      );
      return true;
    }
    return false;
  }
}
