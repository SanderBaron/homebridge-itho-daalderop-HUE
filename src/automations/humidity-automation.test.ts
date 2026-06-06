import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HumidityAutomation, HumidityAutomationConfig } from './humidity-automation';

const mockLog = {
  info:  vi.fn(),
  warn:  vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

function makeCfg(overrides: Partial<HumidityAutomationConfig> = {}): HumidityAutomationConfig {
  return {
    enabled: true,
    mode: 'badkamer',
    boostThreshold: 85,
    dropThreshold: 82,
    cooldownMinutes: 20,
    riseRate: 3,
    riseWindowSeconds: 24,
    minSpeedThreshold: 75,
    ...overrides,
  };
}

describe('HumidityAutomation — badkamer', () => {
  let onSpeed: ReturnType<typeof vi.fn>;
  let auto: HumidityAutomation;

  beforeEach(() => {
    vi.useFakeTimers();
    onSpeed = vi.fn();
    auto = new HumidityAutomation(makeCfg(), onSpeed, mockLog);
  });

  afterEach(() => { vi.useRealTimers(); });

  it('stays idle below boostThreshold', () => {
    auto.update(80);
    expect(auto.getState()).toBe('idle');
    expect(onSpeed).not.toHaveBeenCalled();
  });

  it('triggers boost at absolute threshold', () => {
    auto.update(85);
    expect(auto.getState()).toBe('boosting');
    expect(onSpeed).toHaveBeenCalledWith('high');
  });

  it('triggers boost on rapid rise within window', () => {
    auto.update(70);
    vi.advanceTimersByTime(20_000);
    auto.update(74); // +4% in 20s → above riseRate of 3%
    expect(auto.getState()).toBe('boosting');
    expect(onSpeed).toHaveBeenCalledWith('high');
  });

  it('does NOT trigger boost on slow rise outside window', () => {
    auto.update(70);
    vi.advanceTimersByTime(30_000); // outside 24s window
    auto.update(74);
    expect(auto.getState()).toBe('idle');
  });

  it('does NOT trigger boost on small rise within window', () => {
    auto.update(70);
    vi.advanceTimersByTime(10_000);
    auto.update(72); // only 2% — below riseRate of 3%
    expect(auto.getState()).toBe('idle');
  });

  it('NO CYCLING: rapid rise at low humidity does not immediately exit (stays boosting for minimum time)', () => {
    // Rapid rise triggers at 48% (below dropThreshold of 82%)
    // Previous bug: boost → immediate cooldown → boost → loop
    auto.update(45);
    vi.advanceTimersByTime(10_000);
    auto.update(49); // +4% rapid rise → boost

    expect(auto.getState()).toBe('boosting');
    expect(onSpeed).toHaveBeenCalledWith('high');

    // 5 more updates with hum still below dropThreshold — must NOT cycle
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(10_000);
      auto.update(50 + i);
    }
    expect(auto.getState()).toBe('boosting'); // still boosting, no exit
    expect(onSpeed).toHaveBeenCalledTimes(1); // 'high' sent only once
  });

  it('returns to auto after minimum timer if humidity is below dropThreshold', () => {
    auto.update(49); // rapid rise baseline
    vi.advanceTimersByTime(10_000);
    auto.update(53); // +4% → boost

    // Humidity stays below dropThreshold the whole time (quick shower)
    vi.advanceTimersByTime(20 * 60_000); // 20 min timer fires
    // lastHumidity is 53%, which is < 82% (dropThreshold) → should finish
    expect(auto.getState()).toBe('idle');
    expect(onSpeed).toHaveBeenLastCalledWith('auto');
  });

  it('long shower: stays boosting when hum is above dropThreshold after timer', () => {
    auto.update(90); // → boost
    expect(auto.getState()).toBe('boosting');

    // 20-min timer fires with hum still high (90% > 82%)
    auto['lastHumidity'] = 90;
    vi.advanceTimersByTime(20 * 60_000);
    expect(auto.getState()).toBe('boosting'); // NOT idle — humidity still high

    // Humidity finally drops on next MQTT update
    auto.update(75); // 75% < 82% AND minElapsed → finish
    expect(auto.getState()).toBe('idle');
    expect(onSpeed).toHaveBeenLastCalledWith('auto');
  });

  it('stays in boost for entire 70-minute shower', () => {
    auto.update(90); // → boost
    for (let i = 0; i < 70; i++) {
      vi.advanceTimersByTime(60_000);
      auto.update(88); // hum stays above dropThreshold
    }
    expect(auto.getState()).toBe('boosting');
    expect(onSpeed).toHaveBeenCalledTimes(1); // only 'high' once
  });

  it('re-triggers minimum timer if hum spikes again after minElapsed', () => {
    auto.update(90); // → boost
    vi.advanceTimersByTime(20 * 60_000); // timer elapses, hum = 90 → stays boosting
    auto['lastHumidity'] = 90;
    expect(auto['minElapsed']).toBe(true);

    // Hum drops then spikes again — timer should restart
    auto.update(75); // → would finish since minElapsed && hum < drop... wait, 75 < 82, minElapsed → finish

    // Actually for re-trigger test: hum was 90 when timer fired, then update with 90 again
    // Let's test: timer elapsed, then update with 90 (still high) — should restart timer
    // Reset for this test
    onSpeed.mockClear();
    auto = new HumidityAutomation(makeCfg(), onSpeed, mockLog);
    auto.update(90); // → boost
    auto['lastHumidity'] = 90; // keep hum high when timer fires
    vi.advanceTimersByTime(20 * 60_000); // timer elapses, stays boosting (hum = 90)
    expect(auto['minElapsed']).toBe(true);

    // Now hum exceeds boostThreshold again → timer restarts
    auto.update(88); // 88 >= 85 (boostThreshold) AND minElapsed → restart timer
    expect(auto['minElapsed']).toBe(false); // timer restarted
    expect(auto.getState()).toBe('boosting');
  });

  it('disabled: does nothing regardless of humidity', () => {
    auto = new HumidityAutomation(makeCfg({ enabled: false }), onSpeed, mockLog);
    auto.update(95);
    expect(auto.getState()).toBe('idle');
    expect(onSpeed).not.toHaveBeenCalled();
  });

  it('cancel() resets to idle', () => {
    auto.update(90);
    auto.cancel();
    expect(auto.getState()).toBe('idle');
  });
});

describe('HumidityAutomation — wasruimte', () => {
  let onSpeed: ReturnType<typeof vi.fn>;
  let auto: HumidityAutomation;

  beforeEach(() => {
    onSpeed = vi.fn();
    auto = new HumidityAutomation(
      makeCfg({ mode: 'wasruimte', boostThreshold: 90, minSpeedThreshold: 75 }),
      onSpeed,
      mockLog,
    );
  });

  it('sends low below minSpeedThreshold', () => {
    auto.update(60);
    expect(onSpeed).toHaveBeenCalledWith('low');
  });

  it('sends auto between thresholds', () => {
    auto.update(60);
    auto.update(80);
    expect(onSpeed).toHaveBeenLastCalledWith('auto');
  });

  it('sends high above boostThreshold', () => {
    auto.update(92);
    expect(onSpeed).toHaveBeenCalledWith('high');
  });

  it('does not repeat the same command', () => {
    auto.update(60);
    auto.update(62);
    auto.update(65);
    expect(onSpeed).toHaveBeenCalledTimes(1);
  });

  it('transitions correctly across all three zones', () => {
    auto.update(60);
    auto.update(80);
    auto.update(92);
    auto.update(80);
    auto.update(60);
    expect(onSpeed.mock.calls.map(c => c[0])).toEqual(['low', 'auto', 'high', 'auto', 'low']);
  });
});

describe('HumidityAutomation — rapid-rise disabled', () => {
  it('does not trigger when riseRate is 0', () => {
    vi.useFakeTimers();
    const onSpeed = vi.fn();
    const auto = new HumidityAutomation(makeCfg({ riseRate: 0 }), onSpeed, mockLog);
    auto.update(70);
    vi.advanceTimersByTime(10_000);
    auto.update(75);
    expect(auto.getState()).toBe('idle');
    vi.useRealTimers();
  });
});
