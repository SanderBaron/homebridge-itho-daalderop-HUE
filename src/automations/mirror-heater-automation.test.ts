import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MirrorHeaterAutomation, MirrorHeaterConfig } from './mirror-heater-automation';

const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

function makeCfg(overrides: Partial<MirrorHeaterConfig> = {}): MirrorHeaterConfig {
  return {
    enabled: true,
    hueLightId: '69',
    triggerThreshold: 70,
    triggerDelayMinutes: 0,
    durationMinutes: 15,
    ...overrides,
  };
}

function makeHue(initialOn = false) {
  const light = { on: initialOn };
  return {
    light,
    getLight: vi.fn(async () => ({
      id: '69', name: 'mirror', type: '', modelid: '', manufacturername: '',
      reachable: true, on: light.on,
    })),
    setLightOn: vi.fn(async (_id: string, on: boolean) => { light.on = on; }),
    getSensor: vi.fn(),
  } as any;
}

describe('MirrorHeaterAutomation — manual relay detection', () => {
  let hue: ReturnType<typeof makeHue>;
  let auto: MirrorHeaterAutomation;

  beforeEach(() => { vi.useFakeTimers(); hue = makeHue(false); });
  afterEach(() => { vi.useRealTimers(); });

  it('manual switch-on starts the single auto-off timer (durationMinutes)', async () => {
    auto = new MirrorHeaterAutomation(makeCfg({ durationMinutes: 15 }), hue, mockLog);
    await auto['pollLight'](); // first read records off

    hue.light.on = true;          // someone flips the wall switch
    await auto['pollLight']();     // off → on, no recent command → manual
    expect(auto.getState()).toBe('active');

    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(hue.setLightOn).toHaveBeenCalledWith('69', false);
    expect(auto.getState()).toBe('idle');
  });

  it('manual switch-off cancels a running timer', async () => {
    auto = new MirrorHeaterAutomation(makeCfg(), hue, mockLog);
    await auto['pollLight']();
    hue.light.on = true;
    await auto['pollLight']();      // manual on → active
    expect(auto.getState()).toBe('active');

    hue.light.on = false;          // user flips it off again
    await auto['pollLight']();      // on → off → cancel
    expect(auto.getState()).toBe('idle');

    // timer was cancelled: no further setLightOn from an expiring timer
    hue.setLightOn.mockClear();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(hue.setLightOn).not.toHaveBeenCalled();
  });

  it('manual off then on restarts the timer fresh', async () => {
    auto = new MirrorHeaterAutomation(makeCfg({ durationMinutes: 15 }), hue, mockLog);
    await auto['pollLight']();
    hue.light.on = true;
    await auto['pollLight']();            // manual on → active
    await vi.advanceTimersByTimeAsync(10 * 60_000); // 10 of 15 min passed

    hue.light.on = false;
    await auto['pollLight']();            // off → idle, timer cancelled
    hue.light.on = true;
    await auto['pollLight']();            // on again → fresh 15-min timer
    expect(auto.getState()).toBe('active');

    hue.setLightOn.mockClear();
    await vi.advanceTimersByTimeAsync(14 * 60_000); // would have been off if old timer survived
    expect(hue.setLightOn).not.toHaveBeenCalled();   // still on at 14 min into the new timer
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(hue.setLightOn).toHaveBeenCalledWith('69', false); // off at 15 min
  });

  it('does not flag the automation\'s own activation as manual', async () => {
    auto = new MirrorHeaterAutomation(makeCfg({ triggerThreshold: 70 }), hue, mockLog);
    await auto['pollLight']();      // off

    auto.update(80);               // humidity ≥ threshold → automation turns it on
    expect(auto.getState()).toBe('active');
    expect(hue.setLightOn).toHaveBeenCalledWith('69', true);

    await auto['pollLight']();      // relay now on, but it was our command
    expect(auto.getState()).toBe('active'); // unchanged, not re-flagged as manual
  });

  it('first poll with the light already on does not trigger a manual timer', async () => {
    hue = makeHue(true);           // relay already on at startup
    auto = new MirrorHeaterAutomation(makeCfg(), hue, mockLog);
    await auto['pollLight']();      // first read only records state
    expect(auto.getState()).toBe('idle');
  });
});
