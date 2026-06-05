import { Logger } from 'homebridge';
import { HumidityAutomationState, SupportedVirtualRemoteCommands } from '@/types';

export interface HumidityAutomationConfig {
  enabled: boolean;
  boostThreshold: number;
  dropThreshold: number;
  cooldownMinutes: number;
}

export type SpeedChangeCallback = (speed: SupportedVirtualRemoteCommands | 'auto') => void;

export class HumidityAutomation {
  private state: HumidityAutomationState = 'idle';
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownEndsAt: number | null = null;

  constructor(
    private readonly config: HumidityAutomationConfig,
    private readonly onSpeedChange: SpeedChangeCallback,
    private readonly log: Logger,
  ) {}

  update(humidity: number): void {
    if (!this.config.enabled) return;

    if (humidity >= this.config.boostThreshold && this.state !== 'boost') {
      this.startBoost(humidity);
    } else if (humidity < this.config.dropThreshold && this.state === 'boost') {
      this.startCooldown(humidity);
    } else if (humidity >= this.config.boostThreshold && this.state === 'cooldown') {
      // Humidity spiked again during cooldown — stay in boost
      this.cancelCooldown();
      this.startBoost(humidity);
    }
  }

  getState(): HumidityAutomationState {
    return this.state;
  }

  getCooldownEndsAt(): number | null {
    return this.cooldownEndsAt;
  }

  /** Cancel any active automation and reset to idle. */
  cancel(): void {
    this.cancelCooldown();
    this.state = 'idle';
    this.cooldownEndsAt = null;
  }

  destroy(): void {
    this.cancelCooldown();
  }

  private startBoost(humidity: number): void {
    this.cancelCooldown();
    this.state = 'boost';
    this.log.info(
      `[Humidity Automation] ${humidity}% ≥ ${this.config.boostThreshold}% threshold — fan to high`,
    );
    this.onSpeedChange('high');
  }

  private startCooldown(humidity: number): void {
    if (this.cooldownTimer) return;
    this.state = 'cooldown';
    const ms = this.config.cooldownMinutes * 60_000;
    this.cooldownEndsAt = Date.now() + ms;
    this.log.info(
      `[Humidity Automation] ${humidity}% < ${this.config.dropThreshold}% — cooldown ${this.config.cooldownMinutes} min`,
    );
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.cooldownEndsAt = null;
      this.state = 'idle';
      this.log.info('[Humidity Automation] Cooldown complete — returning to auto');
      this.onSpeedChange('auto');
    }, ms);
  }

  private cancelCooldown(): void {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
      this.cooldownEndsAt = null;
    }
  }
}
