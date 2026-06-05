import { Logger } from 'homebridge';
import { DayOfWeek, ScheduleEntry, SupportedVirtualRemoteCommands } from '@/types';

export interface ScheduleConfig {
  enabled: boolean;
  entries: ScheduleEntry[];
}

export type ScheduleChangeCallback = (speed: SupportedVirtualRemoteCommands | null) => void;

const DAY_NAMES: DayOfWeek[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export class ScheduleEngine {
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private lastAppliedSpeed: SupportedVirtualRemoteCommands | null = null;

  constructor(
    private readonly config: ScheduleConfig,
    private readonly onScheduleChange: ScheduleChangeCallback,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (!this.config.enabled || this.tickInterval) return;
    this.tick();
    this.tickInterval = setInterval(() => this.tick(), 60_000);
    this.log.debug('[Schedule Engine] Started');
  }

  stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  getActiveEntry(): ScheduleEntry | null {
    if (!this.config.enabled) return null;

    const now = new Date();
    const day = DAY_NAMES[now.getDay()];
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    return (
      this.config.entries.find(e => e.days.includes(day) && time >= e.from && time < e.to) ?? null
    );
  }

  destroy(): void {
    this.stop();
  }

  private tick(): void {
    const entry = this.getActiveEntry();
    const speed = entry?.speed ?? null;

    if (speed !== this.lastAppliedSpeed) {
      this.lastAppliedSpeed = speed;
      if (speed) {
        this.log.info(`[Schedule Engine] "${entry!.label}" active → ${speed}`);
      } else {
        this.log.debug('[Schedule Engine] No active schedule entry');
      }
      this.onScheduleChange(speed);
    }
  }
}
