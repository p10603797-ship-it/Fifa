/**
 * [GKP-04] Keeper distribution planner (planDistribution, pure) and its entry point keeperDistributionAi, called
 * directly on hand-built states: wait times, quick release on counters, short vs long by pressure and style, the
 * driven throw to a midfielder, patience before a long ball, the deadline, offside, targets are teammates, purity,
 * guards. Pipeline behaviour is in tests/scenario/gkp-04-distribution.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, KickKind, MatchPhase, Role, TeamPhase, TeamStyle } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_GK } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import {
  DistClass, LOCAL_TUNING as L, createDistributionPlan, distributionKindFor, distributionPowerFor, distributionWait,
  isCounterOn, isPressHigh, keeperDistributionAi, ownReleaseSafety, planDistribution, type DistributionPlan,
} from '../../src/sim/keeper/distribution';
import { LOCAL_TUNING as H, releaseWindupTicks } from '../../src/sim/keeper/handling';
import {
  GK, MATES_OPEN, OPPS_COMMITTED, OPPS_HIGH_PRESS, OPPS_MID_BLOCK, PICKUP, holdingScene, isKick, type HoldingOpts,
  type Layout,
} from './gkp-04-helpers';

/** Only the strikers (5 m of space) are acceptable targets; everybody else is marked at 1 m; no press, no counter. */
const MATES_MARKED: Layout = {
  1: [-18, 26], 2: [-40, 8], 3: [-40, -8], 4: [-18, -26],
  5: [-12, 20], 6: [-12, 8], 7: [-12, -8], 8: [-12, -20],
  9: [5, 8], 10: [5, -8],
};
const OPPS_MARKING: Layout = {
  11: [50, 0],
  12: [-17, 26], 13: [-39, 8], 14: [-39, -8], 15: [-17, -26],
  16: [-11, 20], 17: [-11, 8], 18: [-11, -8], 19: [-11, -20],
  20: [10, 8], 21: [10, -8],
};
/** As OPPS_MARKING with the strikers marked at 1 m too: no acceptable option anywhere. */
const OPPS_ALL_MARKED: Layout = { ...OPPS_MARKING, 20: [6, 8], 21: [6, -8] };

const DEFENDERS = [1, 2, 3, 4];
const MIDFIELDERS = [5, 6, 7, 8];
const STRIKERS = [9, 10];

/** First hold time (ticks) at which planDistribution says release, with the plan (copied). */
function firstRelease(s: SimState, maxHeld = 200): { held: number; plan: DistributionPlan } | null {
  const plan = createDistributionPlan();
  for (let h = 0; h <= maxHeld; h++) {
    s.tick = PICKUP + h;
    if (planDistribution(s, 0, plan) === 1) return { held: h, plan: { ...plan } };
  }
  return null;
}

function decide(o: HoldingOpts, mut?: (s: SimState) => void): { held: number; plan: DistributionPlan } {
  const s = holdingScene(o);
  mut?.(s);
  const r = firstRelease(s);
  expect(r, 'a release decision').not.toBeNull();
  return r!;
}

describe('GKP-04 wait before releasing', () => {
  it('waits 0.9-1.6 s normally and 0.5-0.75 s on a counter (within the 0.5-2.5 s brief), varied per possession', () => {
    const normal = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const s = holdingScene({ seed });
      const w = distributionWait(s, GK, false);
      const wc = distributionWait(s, GK, true);
      expect(w).toBeGreaterThanOrEqual(L.waitMinTicks);
      expect(w).toBeLessThanOrEqual(L.waitMaxTicks);
      expect(wc).toBeGreaterThanOrEqual(L.counterWaitMinTicks);
      expect(wc).toBeLessThanOrEqual(L.counterWaitMaxTicks);
      expect(wc).toBeLessThan(w);
      normal.add(w);
    }
    expect(L.counterWaitMinTicks).toBeGreaterThanOrEqual(30); // 0.5 s
    expect(L.deadlineTicks).toBeLessThanOrEqual(150); // 2.5 s
    expect(normal.size).toBeGreaterThan(5);
  });

  it('never releases before the wait, then releases on the first evaluation when an option is good', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { held, plan } = decide({ seed });
      expect(held).toBe(plan.wait);
      expect(held).toBeGreaterThanOrEqual(L.waitMinTicks);
    }
  });
});

describe('GKP-04 quick release on counters', () => {
  it('counter from the opponents committing forward: short wait, ball forward to a free striker', () => {
    const s = holdingScene({ opps: OPPS_COMMITTED });
    expect(isCounterOn(s, 0)).toBe(true);
    const { held, plan } = decide({ opps: OPPS_COMMITTED });
    expect(plan.counter).toBe(1);
    expect(held).toBeLessThanOrEqual(L.counterWaitMaxTicks);
    expect(held).toBeGreaterThanOrEqual(L.counterWaitMinTicks);
    expect(STRIKERS).toContain(plan.slot);
    expect(isKick(plan.kind)).toBe(true);
  });

  it('counter from TAI-06 (team phase TRANSITION_ATTACK): quick release, progressive option', () => {
    const base = decide({ style: TeamStyle.POSSESSION });
    const fast = decide({ style: TeamStyle.POSSESSION }, (s) => { s.teams[0]!.phase = TeamPhase.TRANSITION_ATTACK; });
    expect(base.plan.counter).toBe(0);
    expect(fast.plan.counter).toBe(1);
    expect(fast.held).toBeLessThan(base.held);
    expect(fast.held).toBeLessThanOrEqual(L.counterWaitMaxTicks);
    // On the counter the choice goes further forward than the patient build-up's.
    const gain = (p: DistributionPlan, s: SimState): number => s.players[p.slot]!.x - s.players[GK]!.x;
    const s = holdingScene({});
    expect(gain(fast.plan, s)).toBeGreaterThan(gain(base.plan, s));
  });

  it('man-marking all over the pitch is a press, not a counter', () => {
    const s = holdingScene({ opps: OPPS_HIGH_PRESS });
    expect(isCounterOn(s, 0)).toBe(false);
    expect(isPressHigh(s, 0)).toBe(true);
  });
});

describe('GKP-04 short vs long by pressure and style', () => {
  it('possession team, no press: quick throw / roll to an open full-back or centre-back', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { plan } = decide({ seed, style: TeamStyle.POSSESSION });
      expect(plan.press).toBe(0);
      expect(plan.cls).toBe(DistClass.SHORT);
      expect(DEFENDERS).toContain(plan.slot);
      expect([KickKind.GK_ROLL, KickKind.GK_THROW]).toContain(plan.kind);
    }
  });

  it('high press: drop kick / driven kick long to a forward (same team, same style)', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { plan } = decide({ seed, style: TeamStyle.POSSESSION, opps: OPPS_HIGH_PRESS });
      expect(plan.press).toBe(1);
      expect(plan.cls).toBe(DistClass.LONG);
      expect(STRIKERS).toContain(plan.slot);
      expect(isKick(plan.kind)).toBe(true);
    }
  });

  it('direct style: long to a forward even with open defenders', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { plan } = decide({ seed, style: TeamStyle.DIRECT });
      expect(plan.cls).toBe(DistClass.LONG);
      expect(STRIKERS).toContain(plan.slot);
      expect(isKick(plan.kind)).toBe(true);
    }
  });

  it('a style that values progress (counter / high-press clubs): driven throw to a midfielder', () => {
    for (const style of [TeamStyle.COUNTER, TeamStyle.HIGH_PRESS]) {
      const { plan } = decide({ style });
      expect(plan.kind).toBe(KickKind.GK_DRIVEN_THROW);
      expect(MIDFIELDERS).toContain(plan.slot);
      expect(plan.cls).toBe(DistClass.MID);
    }
  });

  it('wing play prefers a wide full-back', () => {
    const { plan } = decide({ style: TeamStyle.WING_PLAY });
    expect([1, 4]).toContain(plan.slot);
  });
});

describe('GKP-04 patience and deadline', () => {
  it('possession team with only a long option waits for the team to spread, then kicks long after patienceTicks', () => {
    const { held, plan } = decide({ style: TeamStyle.POSSESSION, mates: MATES_MARKED, opps: OPPS_MARKING });
    expect(plan.counter).toBe(0);
    expect(plan.press).toBe(0);
    expect(held).toBeGreaterThanOrEqual(L.patienceTicks);
    expect(held).toBeLessThan(L.patienceTicks + L.evalInterval);
    expect(STRIKERS).toContain(plan.slot);
    expect(isKick(plan.kind)).toBe(true);
  });

  it('a direct team kicks that long ball at once', () => {
    const { held, plan } = decide({ style: TeamStyle.DIRECT, mates: MATES_MARKED, opps: OPPS_MARKING });
    expect(held).toBe(plan.wait);
    expect(isKick(plan.kind)).toBe(true);
  });

  it('nothing acceptable anywhere: the best long ball at the deadline (2.5 s), never later', () => {
    const { held, plan } = decide({ mates: MATES_MARKED, opps: OPPS_ALL_MARKED });
    expect(held).toBe(L.deadlineTicks);
    expect(plan.cls).toBe(DistClass.LONG);
    expect(STRIKERS).toContain(plan.slot);
  });

  it('nobody to aim at: an untargeted drop kick upfield at the deadline', () => {
    const { held, plan } = decide({}, (s) => { for (let i = 1; i < 11; i++) s.players[i]!.active = 0; });
    expect(held).toBe(L.deadlineTicks);
    expect(plan.slot).toBe(-1);
    expect(plan.kind).toBe(KickKind.GK_DROP_KICK);
    expect(plan.dirX).toBe(1);
    expect(plan.dirZ).toBe(0);
  });

  it('the deadline plus the longest wind-up stays far inside the 6-second rule and before GKP-05 steps in', () => {
    const windup = Math.max(H.throwWindup, H.drivenThrowWindup, H.rollWindup, H.dropKickWindup, H.drivenKickWindup);
    expect(L.deadlineTicks + windup + 1).toBeLessThan(T_GK.autoReleaseTicks);
    expect(T_GK.autoReleaseTicks).toBeLessThanOrEqual(T_GK.maxHoldTicks);
  });
});

describe('GKP-04 targets', () => {
  it('targets are active outfield teammates (never the keeper, an opponent or a sent-off player)', () => {
    let n = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (const opps of [OPPS_MID_BLOCK, OPPS_HIGH_PRESS, OPPS_COMMITTED, OPPS_MARKING]) {
        const { plan } = decide({ seed, opps, style: (seed % 5) as TeamStyle }, (s) => { s.players[1 + (seed % 10)]!.active = 0; });
        if (plan.slot < 0) continue;
        const s = holdingScene({});
        expect(plan.slot).toBeGreaterThan(0);
        expect(plan.slot).toBeLessThan(11);
        expect(plan.slot).not.toBe(1 + (seed % 10));
        expect(s.players[plan.slot]!.team).toBe(0);
        expect(Math.hypot(plan.dirX, plan.dirZ)).toBeCloseTo(1, 9);
        expect(plan.power).toBeGreaterThan(0);
        expect(plan.power).toBeLessThanOrEqual(1);
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });

  it('never aims at a striker in an offside position (offside on); does with offside off', () => {
    const mates: Layout = { ...MATES_OPEN, 9: [16, 0] }; // beyond their second-last defender (x = 14)
    const on = decide({ style: TeamStyle.DIRECT, mates });
    expect(on.plan.slot).not.toBe(9);
    const off = decide({ style: TeamStyle.DIRECT, mates, offside: 0 });
    expect(off.plan.slot).toBe(9);
  });

  it('a striker running into an offside position during the wind-up is skipped', () => {
    const mates: Layout = { ...MATES_OPEN, 10: [12.5, -8] }; // onside now (line x = 14) ...
    const on = decide({ style: TeamStyle.DIRECT, mates }, (s) => { s.players[10]!.vx = 8; }); // ... not at contact
    expect(on.plan.slot).not.toBe(10);
  });

  it('stunned teammates are not targets', () => {
    const base = decide({ style: TeamStyle.POSSESSION });
    const again = decide({ style: TeamStyle.POSSESSION }, (s) => { s.players[base.plan.slot]!.stunT = 30; });
    expect(again.plan.slot).not.toBe(base.plan.slot);
  });

  it('kind by distance and role; kick power reaches the target', () => {
    expect(distributionKindFor(5, false, false)).toBe(KickKind.NONE);
    expect(distributionKindFor(12, false, false)).toBe(KickKind.GK_ROLL);
    expect(distributionKindFor(25, false, false)).toBe(KickKind.GK_THROW);
    expect(distributionKindFor(25, true, false)).toBe(KickKind.GK_DRIVEN_THROW);
    expect(distributionKindFor(25, false, true)).toBe(KickKind.GK_DRIVEN_THROW);
    expect(distributionKindFor(40, false, false)).toBe(KickKind.GK_DRIVEN_THROW);
    expect(distributionKindFor(46, false, false)).toBe(KickKind.GK_DRIVEN_KICK);
    expect(distributionKindFor(56, false, false)).toBe(KickKind.GK_DROP_KICK);
    expect(distributionKindFor(80, false, false)).toBe(KickKind.NONE);
    expect(distributionKindFor(Number.NaN, false, false)).toBe(KickKind.NONE);
    for (let d = 51; d <= 60; d++) {
      const p = distributionPowerFor(KickKind.GK_DROP_KICK, d, false);
      expect(H.dropKickRangeMin + (H.dropKickRangeMax - H.dropKickRangeMin) * p).toBeGreaterThanOrEqual(d);
    }
    for (let d = 43; d <= 50; d++) {
      const p = distributionPowerFor(KickKind.GK_DRIVEN_KICK, d, false);
      expect(H.drivenKickRangeMin + (H.drivenKickRangeMax - H.drivenKickRangeMin) * p).toBeGreaterThanOrEqual(d);
    }
    // GKP-04's mirrored GKP-05 constants stay equal to GKP-05's.
    expect(L.dropKickCarryMin).toBe(H.dropKickRangeMin);
    expect(L.dropKickCarryMax).toBe(H.dropKickRangeMax);
    expect(L.drivenKickCarryMin).toBe(H.drivenKickRangeMin);
    expect(L.drivenKickCarryMax).toBe(H.drivenKickRangeMax);
    for (const k of [KickKind.GK_THROW, KickKind.GK_DRIVEN_THROW, KickKind.GK_ROLL, KickKind.GK_DROP_KICK, KickKind.GK_DRIVEN_KICK]) {
      expect(L.offsideLookAheadTicks).toBeGreaterThanOrEqual(releaseWindupTicks(k));
    }
    // The kinds chosen never ask for a carry shorter than GKP-05's minimum (kicks start beyond it).
    expect(L.drivenThrowMaxUse).toBeGreaterThan(H.drivenKickMinDist);
    expect(L.drivenKickMaxUse).toBeGreaterThan(H.dropKickMinDist);
    expect(L.rollMaxUse).toBeLessThanOrEqual(H.rollMaxDist);
    expect(L.throwMaxUse).toBeLessThanOrEqual(H.throwMaxDist);
    expect(L.drivenThrowMaxUse).toBeLessThanOrEqual(H.drivenThrowMaxDist);
  });

  it('own safety: an open receiver is safe, a marked one is not, a blocked roll lane is not', () => {
    const s = holdingScene({});
    const k = s.players[GK]!;
    // Open centre-back 12 m away.
    expect(ownReleaseSafety(s, 0, k.x, k.z, -38, 8, KickKind.GK_ROLL)).toBe(1);
    // Marker 1 m from the receiver.
    s.players[13]!.x = -38; s.players[13]!.z = 9;
    expect(ownReleaseSafety(s, 0, k.x, k.z, -38, 8, KickKind.GK_ROLL)).toBe(0);
    // Opponent on the roll lane, 30% of the way (8 m from the receiver).
    s.players[13]!.x = -43.95; s.players[13]!.z = 2.4;
    expect(ownReleaseSafety(s, 0, k.x, k.z, -38, 8, KickKind.GK_ROLL)).toBeLessThan(0.3);
    // ... but a throw goes over him.
    expect(ownReleaseSafety(s, 0, k.x, k.z, -38, 8, KickKind.GK_THROW)).toBeGreaterThan(0.6);
  });
});

describe('GKP-04 purity and guards', () => {
  it('planDistribution changes nothing (state hash and RNG untouched)', () => {
    const s = holdingScene({ opps: OPPS_HIGH_PRESS });
    const plan = createDistributionPlan();
    for (let h = 0; h <= 160; h++) {
      s.tick = PICKUP + h;
      const before = hashState(s);
      const rng = { ...s.rng };
      planDistribution(s, 0, plan);
      expect(hashState(s)).toBe(before);
      expect(s.rng).toEqual(rng);
    }
  });

  it('same state -> same plan (no hidden module memory)', () => {
    const a = holdingScene({ seed: 3 });
    const b = holdingScene({ seed: 3 });
    const pa = createDistributionPlan();
    const pb = createDistributionPlan();
    for (let h = 0; h <= 160; h++) {
      a.tick = PICKUP + h; b.tick = PICKUP + h;
      planDistribution(a, 0, pa);
      // Interleave an unrelated evaluation so module scratch is dirty.
      const c = holdingScene({ seed: 9, opps: OPPS_HIGH_PRESS });
      c.tick = PICKUP + 150;
      planDistribution(c, 0, createDistributionPlan());
      planDistribution(b, 0, pb);
      expect(pb).toEqual(pa);
    }
  });

  it('keeperDistributionAi starts the planned release through GKP-05 startKeeperRelease', () => {
    const s = holdingScene({ style: TeamStyle.POSSESSION });
    const { held, plan } = firstRelease(holdingScene({ style: TeamStyle.POSSESSION }))!;
    const ev = createEventBuffer();
    for (let h = 0; h < held; h++) {
      s.tick = PICKUP + h;
      ev.begin(s.tick);
      keeperDistributionAi(s, 0, ev);
      expect(s.players[GK]!.act).toBe(ActionKind.GK_HOLD);
    }
    s.tick = PICKUP + held;
    ev.begin(s.tick);
    keeperDistributionAi(s, 0, ev);
    const p = s.players[GK]!;
    expect(p.act).toBe(ActionKind.GK_THROW);
    expect(p.actKick).toBe(plan.kind);
    expect(p.actSlot).toBe(plan.slot);
    expect(p.actPower).toBeCloseTo(plan.power, 12);
    expect(s.ball.heldBy).toBe(GK); // released at the contact tick by GKP-05
  });

  it('does nothing for a human-controlled keeper, outside IN_PLAY, mid-release, or without the ball', () => {
    // [mutation, the pure planner also declines] (the planner does not look at controllers: the entry point does).
    const cases: [(s: SimState) => void, boolean][] = [
      [(s) => { s.ctrl[0]!.kind = ControllerKind.HUMAN; s.ctrl[0]!.side = 0; s.ctrl[0]!.slot = GK; s.players[GK]!.ctrl = 0; }, false],
      [(s) => { s.match.phase = MatchPhase.GOAL_KICK; }, true],
      [(s) => { s.players[GK]!.act = ActionKind.GK_THROW; }, true],
      [(s) => { s.ball.heldBy = -1; s.ball.owner = -1; }, true],
    ];
    for (const [mut, plannerDeclines] of cases) {
      const s = holdingScene({});
      mut(s);
      const before = { act: s.players[GK]!.act, held: s.ball.heldBy };
      const ev = createEventBuffer();
      for (let h = 0; h <= 200; h++) {
        s.tick = PICKUP + h;
        ev.begin(s.tick);
        keeperDistributionAi(s, 0, ev);
        if (plannerDeclines) expect(planDistribution(s, 0, createDistributionPlan())).toBe(0);
      }
      expect(s.players[GK]!.act).toBe(before.act);
      expect(s.ball.heldBy).toBe(before.held);
    }
    // Bad team indices are ignored.
    const s = holdingScene({});
    s.tick = PICKUP + 150;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    expect(() => keeperDistributionAi(s, 2, ev)).not.toThrow();
    expect(() => keeperDistributionAi(s, -1, ev)).not.toThrow();
    expect(s.players[GK]!.act).toBe(ActionKind.GK_HOLD);
  });

  it('a CPU team uses its level for decision noise but the decisions above still hold at every level', () => {
    for (let level = 0; level <= 5; level++) {
      const short = decide({ style: TeamStyle.POSSESSION }, (s) => { s.teams[0]!.cpu.active = 1; s.teams[0]!.cpu.level = level; });
      expect(short.plan.cls).toBe(DistClass.SHORT);
      const long = decide({ style: TeamStyle.POSSESSION, opps: OPPS_HIGH_PRESS }, (s) => {
        s.teams[0]!.cpu.active = 1; s.teams[0]!.cpu.level = level;
      });
      expect(long.plan.cls).toBe(DistClass.LONG);
    }
  });

  it('roles in the default 4-4-2 match the test layout assumptions', () => {
    const s = holdingScene({});
    expect(DEFENDERS.map((i) => s.players[i]!.role).every((r) => r === Role.RB || r === Role.CB || r === Role.LB)).toBe(true);
    expect(MIDFIELDERS.map((i) => s.players[i]!.role).every((r) => r === Role.RM || r === Role.CM || r === Role.LM)).toBe(true);
    expect(STRIKERS.map((i) => s.players[i]!.role).every((r) => r === Role.ST)).toBe(true);
  });
});
