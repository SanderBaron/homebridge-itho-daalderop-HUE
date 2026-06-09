import { Logger } from 'homebridge';
import { SupportedVirtualRemoteCommands } from '@/types';

export interface ToiletLightConfig {
  enabled: boolean;
  /**
   * Hue sensor/switch ID used by the caller to poll for state changes.
   * Not used internally by this class — the caller translates Hue events
   * into `notifyLightOn()` / `notifyLightOff()` calls.
   */
  hueSensorId: string;
  /** Minimum minutes the light must be on continuously before CVE boost triggers */
  minOnMinutes: number;
  /** Minutes CVE runs at HIGH after the boost triggers */
  boostMinutes: number;
}

export type ToiletSpeedCallback = (speed: SupportedVirtualRemoteCommands | 'auto') => void;

type ToiletState = 'idle' | 'light_on' | 'boosting';

/**
 * Boosts the CVE when the toilet light has been on for at least `minOnMinutes`.
 *
 * This class is purely event-driven — it has no internal polling or Hue API
 * dependency. The caller (platform.ts) is responsible for detecting Hue switch
 * state changes (via sensor poll or Hue v2 SSE) and calling the public
 * `notifyLightOn()` / `notifyLightOff()` methods.
 *
 * State machine:
 *
 *   idle ──(notifyLightOn)──▶ light_on ──(minOnMinutes timer)──▶ boosting
 *   light_on ──(notifyLightOff before timer)──▶ idle  (no boost — too short)
 *   boosting ──(boostMinutes timer)──▶ idle, CVE → auto
 *   boosting ──(notifyLightOff)──▶ boost continues (post-use ventilation)
 */
export class ToiletLightAutomation {
  private state: ToiletState = 'idle';
  private minOnTimer: ReturnType<typeof setTimeout> | null = null;
  private boostTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly config: ToiletLightConfig,
    private readonly onSpeedChange: ToiletSpeedCallback,
    private readonly log: Logger,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  start(): void {
    if (!this.config.enabled) return;
    this.log.info('[Toilet] Detectie gereed — wacht op schakelaar-signaal');
  }

  destroy(): void {
    if (this.minOnTimer) { clearTimeout(this.minOnTimer); this.minOnTimer = null; }
    if (this.boostTimer) { clearTimeout(this.boostTimer); this.boostTimer = null; }
  }

  getState(): ToiletState { return this.state; }

  /**
   * Call when the toilet light/switch turns ON.
   * Typically triggered by a Hue input-only switch event.
   */
  notifyLightOn(): void {
    if (!this.config.enabled) return;
    if (this.state === 'boosting') {
      this.log.debug('[Toilet] Licht aan, boost al actief — negeren');
      return;
    }
    if (this.state === 'light_on') {
      // Already tracking — ignore duplicate on-events
      return;
    }
    this.state = 'light_on';
    this.log.info(
      `[Toilet] Licht aan — boost start over ${this.config.minOnMinutes} min als licht aan blijft`,
    );
    this.minOnTimer = setTimeout(() => {
      this.minOnTimer = null;
      if (this.state === 'light_on') {
        this.startBoost();
      }
    }, this.config.minOnMinutes * 60_000);
  }

  /**
   * Call when the toilet light/switch turns OFF.
   * Typically triggered by a Hue input-only switch event.
   */
  notifyLightOff(): void {
    if (!this.config.enabled) return;
    if (this.state === 'light_on') {
      this.log.debug(
        `[Toilet] Licht te snel uit (< ${this.config.minOnMinutes} min) — geen boost`,
      );
      if (this.minOnTimer) { clearTimeout(this.minOnTimer); this.minOnTimer = null; }
      this.state = 'idle';
      return;
    }
    // If boosting: let the boost run its full duration (post-use ventilation)
    if (this.state === 'boosting') {
      this.log.debug('[Toilet] Licht uit — boost loopt door tot timer verloopt');
    }
  }

  // ── State machine ──────────────────────────────────────────────────────────

  private startBoost(): void {
    this.state = 'boosting';
    this.log.info(`[Toilet] CVE boost — HIGH voor ${this.config.boostMinutes} min`);
    this.onSpeedChange('high');

    this.boostTimer = setTimeout(() => {
      this.boostTimer = null;
      this.state = 'idle';
      this.log.info('[Toilet] Boost timer verlopen — CVE terug naar automatisch');
      this.onSpeedChange('auto');
    }, this.config.boostMinutes * 60_000);
  }
}
