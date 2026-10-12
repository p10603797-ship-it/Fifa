/**
 * FND-06 review fixes: runMatch with a broken sim (src/sim/step replaced by a test double). The runner counts its
 * own steps, so it terminates at maxTicks whatever the sim does to s.tick, and with a checker on it reports every
 * step that does not advance s.tick by exactly one (the checker alone would silently re-baseline).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ControllerKind } from '../../src/contracts/enums';
import type { EventBuffer } from '../../src/contracts/events';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';

const ctl = vi.hoisted(() => ({ advance: 1, calls: 0 }));

vi.mock('../../src/sim/step', () => ({
  step: (s: { tick: number }, _f: unknown, e: { begin(t: number): void }): void => {
    ctl.calls++;
    s.tick = Math.max(0, s.tick + ctl.advance);
    e.begin(s.tick);
  },
}));

import { runMatch } from '../../tools/headless';

function cfg(): MatchConfig {
  const c = createMatchConfig();
  c.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
  ];
  return c;
}

beforeEach(() => {
  ctl.calls = 0;
  ctl.advance = 1;
});

describe('FND-06 fixes: runMatch with a broken tick', () => {
  it('a step that does not advance s.tick: stops at maxTicks and reports a [clock] failure per step', () => {
    ctl.advance = 0;
    const r = runMatch({ config: cfg(), maxTicks: 50, checker: 'core' });
    expect(ctl.calls).toBe(50);
    expect(r.ticks).toBe(50);
    expect(r.exception).toBeUndefined();
    expect(r.invariantFailures.byName.clock).toBeGreaterThanOrEqual(50);
    expect(r.invariantFailures.count).toBeGreaterThanOrEqual(50);
    expect(r.invariantFailures.first[0]).toBe('t=0 [clock] step 1 did not advance s.tick by one (0 -> 0)');
  });

  it('a step that moves s.tick backwards is reported too', () => {
    ctl.advance = 1;
    const r0 = runMatch({ config: cfg(), maxTicks: 5, checker: 'none' });
    expect(r0.ticks).toBe(5);
    ctl.advance = -1;
    ctl.calls = 0;
    const r = runMatch({ config: cfg(), maxTicks: 20, checker: 'all' });
    expect(ctl.calls).toBe(20);
    expect(r.invariantFailures.first.some((m) => /\[clock\] step \d+ did not advance s\.tick by one/.test(m))).toBe(true);
  });

  it('a healthy step gets no runner-level failures; with checker none nothing is counted', () => {
    const ok = runMatch({ config: cfg(), maxTicks: 30, checker: 'core' });
    expect(ok.invariantFailures.first.filter((m) => m.includes('did not advance'))).toEqual([]);
    ctl.advance = 0;
    const off = runMatch({ config: cfg(), maxTicks: 30, checker: 'none' });
    expect(off.invariantFailures.count).toBe(0);
    expect(off.ticks).toBe(30);
  });

  it('recording a broken tick stops the run with an exception in "record", not a hang', () => {
    ctl.advance = 0;
    const r = runMatch({ config: cfg(), maxTicks: 50, checker: 'none', record: true });
    expect(r.exception?.where).toBe('record');
    expect(r.exception?.message).toMatch(/state tick 0 != recorded ticks 1/);
    expect(ctl.calls).toBe(1);
  });

  it('the scripted state type is a SimState (onTick sees the live state)', () => {
    let seen: SimState | null = null;
    runMatch({ config: cfg(), maxTicks: 3, checker: 'none', onTick: (s: SimState, _e: EventBuffer) => { seen = s; } });
    expect(seen).not.toBeNull();
    expect(seen!.tick).toBe(3);
  });
});
