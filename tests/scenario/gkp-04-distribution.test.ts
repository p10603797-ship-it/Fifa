/**
 * [GKP-04] Keeper distribution through the real pipeline (step -> teamAiTick -> keeperTick -> GKP-05 handlers):
 * the AI keeper always releases (well inside 6 s, before GKP-05's forced release), quick release on counters,
 * short vs long by pressure and style, targets are teammates, determinism (replay and clone). Invariants checked
 * every tick. Glitch-list regressions are named "glitch: ...".
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, TeamStyle } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { T_GK } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { hashState } from '../../src/sim/core/hash';
import { LOCAL_TUNING as L } from '../../src/sim/keeper/distribution';
import { isKeeperReleaseKind } from '../../src/sim/keeper/handling';
import { runTicks } from '../harness/scenario';
import {
  GK, OPPS_COMMITTED, OPPS_HIGH_PRESS, PICKUP, holdingScene, isKick, lcg, type HoldingOpts, type Layout, type P2,
} from '../unit/gkp-04-helpers';

interface HoldRun {
  s: SimState;
  events: SimEvent[];
  /** Hold time (ticks) when the keeper left GK_HOLD, -1 never; the release kind / receiver he started with. */
  startHeld: number;
  startKind: KickKind;
  startSlot: number;
  /** The KICK event of his release, its hold time, and ball.passTarget right after it. */
  kick: SimEvent | undefined;
  kickHeld: number;
  passTarget: number;
}

/** Step the pipeline until a few ticks after the keeper's release (or maxHoldTicks + 30), invariants on. */
function runHold(o: HoldingOpts): HoldRun {
  const s = holdingScene(o);
  const r: HoldRun = { s, events: [], startHeld: -1, startKind: KickKind.NONE, startSlot: -2, kick: undefined, kickHeld: -1, passTarget: -2 };
  r.events = runTicks(s, T_GK.maxHoldTicks + 30, undefined, {
    check: 'all',
    until: (st, evs) => {
      const p = st.players[GK]!;
      if (r.startHeld < 0 && p.act !== ActionKind.GK_HOLD) {
        r.startHeld = st.tick - PICKUP; r.startKind = p.actKick; r.startSlot = p.actSlot;
      }
      if (!r.kick) {
        const k = evs.find((e) => e.type === EventType.KICK && e.a === GK);
        if (k) { r.kick = k; r.kickHeld = k.tick - PICKUP; r.passTarget = st.ball.passTarget; }
      }
      return r.kick !== undefined && st.tick - PICKUP > r.kickHeld + 3;
    },
  });
  return r;
}

const DEFENDERS = [1, 2, 3, 4];
const STRIKERS = [9, 10];

function randomLayout(r: () => number): { mates: Layout; opps: Layout; keeper: P2; style: TeamStyle } {
  const mates: Record<number, P2> = {};
  const opps: Record<number, P2> = { 11: [50, 0] };
  for (let i = 1; i < 11; i++) mates[i] = [-45 + r() * 65, -30 + r() * 60];
  for (let i = 12; i < 22; i++) opps[i] = [-40 + r() * 80, -30 + r() * 60];
  const keeper: P2 = [-52.5 + 3 + r() * 9, -6 + r() * 12];
  return { mates, opps, keeper, style: Math.floor(r() * 5) as TeamStyle };
}

describe('GKP-04 always releases (pipeline)', () => {
  it('glitch: Keeper holds the ball forever (GKP-04 AI distribution releases in 0.5-2.5 s, before the 6-second backstop)', () => {
    const r = lcg(20261012);
    for (let c = 0; c < 16; c++) {
      const lay = randomLayout(r);
      const run = runHold({ seed: 500 + c, ...lay });
      const tag = `case ${c}`;
      expect(run.startHeld, tag).toBeGreaterThanOrEqual(L.counterWaitMinTicks);
      expect(run.startHeld, tag).toBeLessThanOrEqual(L.deadlineTicks);
      expect(run.kick, tag).toBeDefined();
      expect(run.kickHeld, tag).toBeLessThan(T_GK.autoReleaseTicks); // GKP-04 released, not GKP-05's forced release
      expect(isKeeperReleaseKind(run.kick!.b), tag).toBe(true);
      expect(run.kick!.b, tag).not.toBe(KickKind.GK_RELEASE);
      const hands = run.events.find((e) => e.type === EventType.KEEPER_HANDS && e.a === GK && e.b === 0);
      expect(hands!.tick - PICKUP, tag).toBeLessThanOrEqual(T_GK.maxHoldTicks);
      expect(run.s.ball.heldBy, tag).toBe(-1);
    }
  });

  it('glitch: Keeper holds the ball forever (every teammate marked: long ball at the deadline)', () => {
    const mates: Layout = {
      1: [-18, 26], 2: [-40, 8], 3: [-40, -8], 4: [-18, -26], 5: [-12, 20], 6: [-12, 8], 7: [-12, -8], 8: [-12, -20],
      9: [5, 8], 10: [5, -8],
    };
    const opps: Layout = {
      11: [50, 0], 12: [-17, 26], 13: [-39, 8], 14: [-39, -8], 15: [-17, -26], 16: [-11, 20], 17: [-11, 8], 18: [-11, -8],
      19: [-11, -20], 20: [6, 8], 21: [6, -8],
    };
    const run = runHold({ mates, opps });
    expect(run.startHeld).toBeGreaterThanOrEqual(L.waitMinTicks);
    expect(run.startHeld).toBeLessThanOrEqual(L.deadlineTicks);
    expect(run.kickHeld).toBeLessThan(T_GK.autoReleaseTicks);
    expect(isKeeperReleaseKind(run.kick!.b)).toBe(true);
  });
});

describe('GKP-04 quick release on counters (pipeline)', () => {
  it('opponents committed forward: released after 0.5-0.75 s; a normal build-up waits longer', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const counter = runHold({ seed, opps: OPPS_COMMITTED });
      const normal = runHold({ seed });
      expect(counter.startHeld).toBeGreaterThanOrEqual(L.counterWaitMinTicks);
      expect(counter.startHeld).toBeLessThanOrEqual(L.counterWaitMaxTicks + L.evalInterval);
      expect(normal.startHeld).toBeGreaterThanOrEqual(L.waitMinTicks);
      expect(counter.startHeld).toBeLessThan(normal.startHeld);
      // Forward, to the free striker.
      expect(STRIKERS).toContain(counter.passTarget);
    }
  });
});

describe('GKP-04 short vs long (pipeline)', () => {
  it('possession team, no press: throw / roll to a defender', () => {
    const run = runHold({ style: TeamStyle.POSSESSION });
    expect([KickKind.GK_ROLL, KickKind.GK_THROW]).toContain(run.kick!.b);
    expect(DEFENDERS).toContain(run.passTarget);
  });

  it('possession team under a high press: drop kick / driven kick to a forward', () => {
    const run = runHold({ style: TeamStyle.POSSESSION, opps: OPPS_HIGH_PRESS });
    expect(isKick(run.kick!.b)).toBe(true);
    expect(STRIKERS).toContain(run.passTarget);
  });

  it('direct team, no press: long to a forward', () => {
    const run = runHold({ style: TeamStyle.DIRECT });
    expect(isKick(run.kick!.b)).toBe(true);
    expect(STRIKERS).toContain(run.passTarget);
  });
});

describe('GKP-04 targets are teammates (pipeline)', () => {
  it('the receiver he starts with and the pass target of the launch are outfield teammates', () => {
    const r = lcg(4242);
    for (let c = 0; c < 12; c++) {
      const lay = randomLayout(r);
      const run = runHold({ seed: 900 + c, ...lay });
      const tag = `case ${c}`;
      expect(run.startSlot, tag).toBeGreaterThanOrEqual(1);
      expect(run.startSlot, tag).toBeLessThanOrEqual(10);
      expect(run.passTarget, tag).toBeGreaterThanOrEqual(1);
      expect(run.passTarget, tag).toBeLessThanOrEqual(10);
      expect(run.s.players[run.passTarget]!.team, tag).toBe(0);
      expect(run.kick!.b, tag).toBe(run.startKind);
    }
  });
});

describe('GKP-04 determinism (pipeline)', () => {
  it('same seed and layout -> identical events and state hash', () => {
    const a = runHold({ seed: 31, opps: OPPS_HIGH_PRESS });
    const b = runHold({ seed: 31, opps: OPPS_HIGH_PRESS });
    expect(b.events).toEqual(a.events);
    expect(hashState(b.s)).toBe(hashState(a.s));
    expect(b.startHeld).toBe(a.startHeld);
  });

  it('a clone taken mid-hold continues identically (no module memory)', () => {
    const s = holdingScene({ seed: 8 });
    runTicks(s, 30);
    expect(s.ball.heldBy).toBe(GK);
    const c = cloneState(s);
    // Dirty the module scratch with an unrelated keeper between the two runs.
    runHold({ seed: 99, opps: OPPS_COMMITTED });
    const ea = runTicks(s, 150);
    runHold({ seed: 98, opps: OPPS_HIGH_PRESS });
    const eb = runTicks(c, 150);
    expect(eb).toEqual(ea);
    expect(hashState(c)).toBe(hashState(s));
    expect(ea.some((e) => e.type === EventType.KICK && e.a === GK)).toBe(true);
  });
});

describe('GKP-04 leaves human keepers alone (pipeline)', () => {
  it('a human-controlled keeper is not released by the AI (GKP-05 auto release only)', () => {
    const run = runHold({ humans: [{ side: 0, slot: GK }] });
    expect(run.startHeld).toBeGreaterThanOrEqual(T_GK.autoReleaseTicks);
  });
});
