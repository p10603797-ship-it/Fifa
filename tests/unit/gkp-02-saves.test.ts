/**
 * [GKP-02] Keeper saves: physical reach, reaction delay (+ screening), catch / parry / tip / block, parry direction,
 * the Keeper glitch-list lines this module owns, determinism and cost. Keeper handling (GKP-05) is replaced by a
 * contract-following double so these tests do not depend on GKP-05's progress.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/keeper/handling', async () => (await import('./gkp-02-handling-mock')).handlingMock());

import { BALL_RADIUS, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, CrossKind, KickKind, MatchPhase, SaveKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_GK } from '../../src/contracts/tuning';
import { actionsTick, endAction, isFree } from '../../src/sim/actions/dispatch';
import { ballStepTick } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { contactsTick } from '../../src/sim/contacts';
import {
  keeperContacts, keeperDiveTicks, keeperMaxReach, keeperReactTicks, keeperSaveDecision, startKeeperDive,
} from '../../src/sim/keeper/saves';
import { LOCAL_TUNING } from '../../src/sim/keeper/saveKinematics';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { ballTick } from '../../src/sim/ball/contact';
import { makeScenario, runTicks } from '../harness/scenario';
import { mockState } from './gkp-02-handling-mock';
import {
  batchShot, depth, KEEPER, keeperScenario, lcg, lineCrossing, miniTick, reachExcess, runShot, shoot, SHOOTER, xAt,
} from './gkp-02-helpers';

/** Outcome of one shot at a freshly built keeper scenario. */
function shotAt(o: Parameters<typeof keeperScenario>[0], sh: Parameters<typeof shoot>[1]) {
  const s = keeperScenario(o);
  shoot(s, sh);
  const r = runShot(s);
  return { s, r };
}

describe('GKP-02 saves: physical reach', () => {
  it('saves only when physically reachable (shots to the corners at 30 m/s vs keeper attributes)', () => {
    const gks = [1, 30, 60, 99];
    const tzs = [1.6, 2.0, 2.4, 2.8, 3.2];
    const saved: boolean[][] = [];
    for (const gk of gks) {
      const row: boolean[] = [];
      for (const tz of tzs) {
        const { s, r } = shotAt({ gk, u: 2.5 }, { u: 16, z: 0, tz, speed: 30 });
        expect(r.outcome === 'save' || r.outcome === 'goal').toBe(true);
        if (r.outcome === 'save') expect(reachExcess(s, r)).toBeLessThanOrEqual(1e-6);
        // Closest approach of the ball path (until the line) to where the keeper stood: beyond his max reach plus
        // what he can move in the time = never saved.
        row.push(r.outcome === 'save');
      }
      saved.push(row);
    }
    // Better keepers save everything worse keepers save; shots closer to the keeper are saved at least as often.
    for (let g = 1; g < gks.length; g++) for (let t = 0; t < tzs.length; t++) if (saved[g - 1]![t]) expect(saved[g]![t]).toBe(true);
    for (let g = 0; g < gks.length; g++) for (let t = 1; t < tzs.length; t++) if (saved[g]![t]) expect(saved[g]![t - 1]).toBe(true);
    // The best keeper reaches the shots inside the corner; the worst cannot reach a ball 2.3 m+ away (reach 2.2 m).
    expect(saved[3]!.slice(0, 3)).toEqual([true, true, true]);
    expect(saved[0]!.slice(2)).toEqual([false, false, false]);
    expect(saved.flat().filter((v) => v).length).toBeGreaterThan(5);
  });

  it('every touch over a mixed batch is physically reachable from where he started', () => {
    const rnd = lcg(99);
    let saves = 0;
    for (let i = 0; i < 160; i++) {
      const sh = batchShot(rnd);
      const gk = 1 + Math.floor(rnd() * 99);
      const { s, r } = shotAt({ gk, u: 1 + rnd() * 4, z: (rnd() - 0.5) * 2 }, sh);
      if (r.outcome !== 'save') continue;
      saves++;
      expect(reachExcess(s, r)).toBeLessThanOrEqual(1e-6);
    }
    expect(saves).toBeGreaterThan(60);
  });

  it('dive kinematics: reach and timing come from gkDiving', () => {
    const s = keeperScenario({});
    const a = s.attrs[KEEPER]!;
    a.gkDiving = 99;
    const best = keeperMaxReach(a), bestT = keeperDiveTicks(a, 2.2);
    a.gkDiving = 1;
    const worst = keeperMaxReach(a), worstT = keeperDiveTicks(a, 2.2);
    expect(best).toBeCloseTo(3.2, 6);
    expect(worst).toBeCloseTo(2.2, 6);
    expect(bestT).toBeLessThan(worstT);
    expect(keeperDiveTicks(a, 2.3)).toBeGreaterThan(1e6); // beyond reach: never
  });
});

describe('GKP-02 saves: reaction delay', () => {
  it('reaction delay from gkReflexes: no save action before reactBest..reactWorst ticks, and slow reflexes save less', () => {
    let fast = 0, slow = 0;
    for (const tz of [1.6, 1.8, 2.0, 2.2, 2.4]) for (const speed of [24, 28, 32]) for (const u of [12, 14, 16]) {
      const a = shotAt({ diving: 80, handling: 70, reflexes: 99, u: 2 }, { u, z: 0, tz, ty: 0.4, speed });
      const b = shotAt({ diving: 80, handling: 70, reflexes: 1, u: 2 }, { u, z: 0, tz, ty: 0.4, speed });
      if (a.r.firstActTick >= 0) expect(a.r.firstActTick).toBeGreaterThanOrEqual(keeperReactTicks(a.s.attrs[KEEPER]!));
      if (b.r.firstActTick >= 0) expect(b.r.firstActTick).toBeGreaterThanOrEqual(keeperReactTicks(b.s.attrs[KEEPER]!));
      if (b.r.outcome === 'save') expect(a.r.outcome).toBe('save');
      if (a.r.outcome === 'save') fast++;
      if (b.r.outcome === 'save') slow++;
    }
    const k = keeperScenario({ reflexes: 99 }).attrs[KEEPER]!;
    expect(keeperReactTicks(k)).toBe(T_GK.reactBest); // [INT-A] read from tuning (retuned 6 / 20 -> 8 / 22)
    k.gkReflexes = 1;
    expect(keeperReactTicks(k)).toBe(T_GK.reactWorst);
    expect(fast).toBeGreaterThan(slow + 10);
  });

  it('before reacting he plants his feet (ready stance, body only) and positioning cannot move him', () => {
    const s = keeperScenario({ gk: 60, reflexes: 1, u: 2.5 });
    shoot(s, { u: 20, z: 4, tz: -2.6, ty: 0.5, speed: 24 });
    const k = s.players[KEEPER]!;
    const x0 = k.x, z0 = k.z;
    const ev = createEventBuffer();
    const react = keeperReactTicks(s.attrs[KEEPER]!);
    for (let t = 1; t < react; t++) {
      miniTick(s, ev);
      expect(k.act).toBe(ActionKind.GK_CATCH);
      expect(k.actA).toBe(2);
      expect(Math.hypot(k.x - x0, k.z - z0)).toBeLessThan(0.05);
    }
    for (let t = 0; t < 3; t++) miniTick(s, ev);
    expect(k.act === ActionKind.GK_DIVE || (k.act === ActionKind.GK_CATCH && k.actA !== 2)).toBe(true);
  });

  it('a screened shot is reacted to later than an unscreened one (worse when screened)', () => {
    let clear = 0, screened = 0;
    for (const tz of [1.4, 1.8, 2.2, 2.6]) for (const speed of [24, 30]) {
      const a = shotAt({ gk: 80, u: 2 }, { u: 16, z: 0, tz, ty: 0.3, speed });
      const s = keeperScenario({ gk: 80, u: 2 });
      // Two defenders on the shooter's sight line to the keeper (not in the ball's path to the corner).
      s.players[4]!.x = xAt(9); s.players[4]!.z = 0.2;
      s.players[5]!.x = xAt(11); s.players[5]!.z = -0.2;
      shoot(s, { u: 16, z: 0, tz, ty: 0.3, speed });
      // The shooter stands 1.2 m behind the ball on the same line, so the sight line passes both defenders.
      const r = runShot(s);
      const base = keeperReactTicks(s.attrs[KEEPER]!);
      if (r.firstActTick >= 0) expect(r.firstActTick).toBeGreaterThanOrEqual(base + 2 * LOCAL_TUNING.screenTicks);
      if (a.r.firstActTick >= 0) expect(a.r.firstActTick).toBeLessThan(base + 2 * LOCAL_TUNING.screenTicks);
      if (r.outcome === 'save') expect(a.r.outcome).toBe('save');
      if (a.r.outcome === 'save') clear++;
      if (r.outcome === 'save') screened++;
    }
    expect(clear).toBeGreaterThan(screened);
  });
});

describe('GKP-02 saves: catch, parry, tip, block', () => {
  it('catch vs parry by ball speed: slow shots are caught (GK_CATCH window, then GK_HOLD), hard ones parried', () => {
    const slow = shotAt({ gk: 75, u: 2 }, { u: 18, z: 0, tz: 0, ty: 1.0, speed: 12 });
    expect(slow.r.outcome).toBe('save');
    expect(slow.r.save?.b).toBe(SaveKind.CATCH);
    expect(slow.r.caught).toBe(true);
    expect(slow.r.sawCatch).toBe(true);
    expect(slow.r.actBeforeContact).toBe(ActionKind.GK_CATCH);
    expect(slow.s.players[KEEPER]!.act).toBe(ActionKind.GK_HOLD);
    expect(slow.s.ball.heldBy).toBe(KEEPER);
    expect(slow.r.events.filter((e) => e.type === EventType.KEEPER_HANDS && e.b === 1)).toHaveLength(1);
    const hard = shotAt({ gk: 75, u: 2 }, { u: 18, z: 0, tz: 0, ty: 1.0, speed: 32 });
    expect(hard.r.outcome).toBe('save');
    expect(hard.r.save?.b).toBe(SaveKind.PARRY);
    expect(hard.s.ball.heldBy).toBe(-1);
    expect(hard.s.ball.lastKickKind).toBe(KickKind.GK_PARRY);
  });

  it('catch vs parry by handling: the same 24 m/s shot is held by a good handler and parried by a poor one', () => {
    const good = shotAt({ gk: 75, handling: 99, u: 2 }, { u: 18, z: 0, tz: 0, ty: 1.0, speed: 24 });
    const poor = shotAt({ gk: 75, handling: 20, u: 2 }, { u: 18, z: 0, tz: 0, ty: 1.0, speed: 24 });
    expect(good.r.save?.b).toBe(SaveKind.CATCH);
    expect(poor.r.save?.b).toBe(SaveKind.PARRY);
  });

  it('a refused pick-up (GKP-05 canHandle false) is parried, never lost or held', () => {
    mockState.refuse = true;
    try {
      const r = shotAt({ gk: 75, u: 2 }, { u: 18, z: 0, tz: 0, ty: 1.0, speed: 12 });
      expect(r.r.outcome).toBe('save');
      expect(r.r.save?.b).toBe(SaveKind.PARRY);
      expect(r.s.ball.heldBy).toBe(-1);
    } finally {
      mockState.refuse = false;
    }
  });

  it('parry direction: away from goal; good keepers parry wide, poor keepers back into the middle', () => {
    const angles: Record<string, number[]> = { good: [], poor: [] };
    for (const [label, gk] of [['good', 99], ['poor', 20]] as const) {
      for (let seed = 1; seed <= 6; seed++) for (const tz of [-1.5, 1.5]) {
        const { s, r } = shotAt({ gk, u: 2, seed }, { u: 16, z: 0, tz, ty: 0.6, speed: 32 });
        expect(r.outcome).toBe('save');
        expect(r.save?.b).toBe(SaveKind.PARRY);
        const b = s.ball;
        expect(b.vx).toBeGreaterThan(0); // team 0 defends -x: away from goal is +x
        const ang = Math.atan2(b.vz, b.vx);
        angles[label]!.push(Math.abs(ang));
        if (label === 'good') expect(Math.sign(b.vz)).toBe(Math.sign(tz)); // wide, to the side he saved it on
        // The parried ball never ends up in the goal.
        const c = { z: 0, y: 0, t: 0 };
        if (lineCrossing(b, c, 180)) expect(Math.abs(c.z) < GOAL_HALF_WIDTH && c.y < GOAL_HEIGHT).toBe(false);
      }
    }
    const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / v.length;
    expect(mean(angles.good!)).toBeGreaterThan(0.9);
    expect(mean(angles.poor!)).toBeLessThan(0.5);
  });

  it('tips high shots near the bar over the bar', () => {
    for (const tz of [0, 1.0]) {
      const { s, r } = shotAt({ gk: 75, u: 2 }, { u: 18, z: 0, tz, ty: 2.25, speed: 28 });
      expect(r.outcome).toBe('save');
      expect(r.save?.b).toBe(SaveKind.TIP_OVER);
      expect(s.ball.lastKickKind).toBe(KickKind.GK_TIP);
      const c = { z: 0, y: 0, t: 0 };
      expect(lineCrossing(s.ball, c, 180)).toBe(true);
      expect(c.y).toBeGreaterThan(GOAL_HEIGHT + BALL_RADIUS);
    }
  });

  it('touches on a ball going wide are not counted as saves', () => {
    const { r } = shotAt({ gk: 75, u: 0.6, z: 4.05 }, { u: 9, z: 1, tz: 4.3, ty: 0.5, speed: 26 });
    expect(r.outcome).toBe('save'); // he touched it
    expect(r.save).toBeNull();
  });
});

describe('GKP-02 glitch list: Keeper', () => {
  it('Keeper: dives after the ball has passed — never starts a dive once the ball is behind his plane', () => {
    // Off his line, the ball already between him and the goal.
    const s = keeperScenario({ gk: 99, u: 7 });
    const b = s.ball;
    b.x = xAt(5.5); b.y = BALL_RADIUS; b.z = 0.5; b.px = b.x; b.py = b.y; b.pz = b.z;
    b.vx = -15; b.vy = 0; b.vz = 0; b.grounded = 1;
    b.lastTouch = SHOOTER; b.lastTouchTeam = 1; b.lastTouchTick = -40; b.shotBy = SHOOTER; b.shotOnTarget = 1;
    b.lastKickBy = SHOOTER; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL;
    const r = runShot(s, 60);
    expect(r.dived).toBe(false);
    expect(r.firstActTick).toBe(-1);
    // A shot that passes beside a slow-reacting keeper before he has reacted: no late dive after it.
    const t = shotAt({ gk: 50, reflexes: 1, u: 3 }, { u: 5.5, z: 1, tz: 3.3, ty: 0.3, speed: 30 });
    expect(t.r.dived).toBe(false);
    expect(t.r.outcome).toBe('goal');
    // Across a batch every dive starts with the ball still in front of his plane.
    const rnd = lcg(5);
    for (let i = 0; i < 80; i++) {
      const sh = batchShot(rnd);
      const x = shotAt({ gk: 1 + Math.floor(rnd() * 99), u: 1 + rnd() * 6 }, sh);
      expect(x.r.divesBeforePassing).toBe(true);
    }
  });

  it('Keeper: handles outside the area — outside his area he only blocks with the body', () => {
    mockState.pickUps = 0;
    // Rushed out to 20 m: a slow, catchable ground shot straight at him.
    const out = shotAt({ gk: 90, u: 20 }, { u: 27, z: 0, tz: 0, speed: 17 });
    expect(out.r.outcome).toBe('save');
    expect(out.r.save?.b).toBe(SaveKind.BLOCK);
    expect(out.s.ball.heldBy).toBe(-1);
    expect(out.s.ball.lastKickKind).toBe(KickKind.DEFLECTION);
    expect(out.r.events.some((e) => e.type === EventType.KEEPER_HANDS)).toBe(false);
    // Standing on the edge of the area: he meets the ball in front of the line, outside the area -> no hands.
    const edge = shotAt({ gk: 90, u: 16.3 }, { u: 26, z: 0, tz: 0, speed: 16 });
    expect(edge.r.outcome).toBe('save');
    expect(depth(edge.r.save!.x)).toBeGreaterThan(16.5 + BALL_RADIUS);
    expect(edge.r.save?.b).toBe(SaveKind.BLOCK);
    expect(mockState.pickUps).toBe(0);
    // Inside the area the same shot is caught.
    const inside = shotAt({ gk: 90, u: 8 }, { u: 26, z: 0, tz: 0, speed: 16 });
    expect(inside.r.save?.b).toBe(SaveKind.CATCH);
  });

  it('Keeper: handles outside the area — the keeperArea invariant holds over a shot batch', () => {
    const checker = createInvariantChecker(['keeperArea', 'finite', 'bounds', 'owner', 'action']);
    const rnd = lcg(31);
    for (let i = 0; i < 60; i++) {
      const sh = batchShot(rnd);
      const s = keeperScenario({ gk: 40 + Math.floor(rnd() * 60), u: 1 + rnd() * 18 });
      shoot(s, sh);
      checker.reset();
      runShot(s, 150, (st, ev) => {
        miniTick(st, ev);
        const f = checker.check(st, ev);
        if (f.length > 0) throw new Error(f.join('\n'));
      });
    }
  });

  it('Keeper: stays stuck in a dive — every dive ends (with a get-up) within its fixed duration', () => {
    const rnd = lcg(17);
    const ev = createEventBuffer();
    for (let i = 0; i < 250; i++) {
      const s = keeperScenario({ gk: 1 + Math.floor(rnd() * 99), u: 0.2 + rnd() * 10, z: (rnd() - 0.5) * 8 });
      s.ball.x = 30; s.ball.z = 20; s.ball.px = 30; s.ball.pz = 20; // far away, still
      const k = s.players[KEEPER]!;
      const tx = k.x + (rnd() - 0.5) * 10, tz = k.z + (rnd() - 0.5) * 10, ty = rnd() * 3.2;
      expect(startKeeperDive(s, KEEPER, tx, ty, tz)).toBe(1);
      const dur = k.actDur;
      expect(dur).toBeGreaterThan(0);
      expect(dur).toBeLessThan(120);
      let ticks = 0;
      while (k.act === ActionKind.GK_DIVE && ticks < 500) {
        s.tick++; ev.begin(s.tick);
        actionsTick(s, ev);
        locomotionTick(s, ev);
        ticks++;
        expect(k.actT).toBeLessThanOrEqual(k.actDur);
        expect(Number.isFinite(k.x) && Number.isFinite(k.z)).toBe(true);
        expect(depth(k.x)).toBeGreaterThanOrEqual(LOCAL_TUNING.minDepth - 1e-9);
      }
      expect(ticks).toBe(dur);
      expect(k.act).toBe(ActionKind.NONE);
      expect(k.moveMode).not.toBe(MoveMode.LOCKED);
      expect(isFree(k)).toBe(true);
    }
    // Interrupted mid-dive (restart, foul...): free and unlocked at once.
    const s = keeperScenario({ gk: 70, u: 2 });
    expect(startKeeperDive(s, KEEPER, xAt(2), 0.5, 2.5)).toBe(1);
    for (let i = 0; i < 8; i++) { s.tick++; ev.begin(s.tick); actionsTick(s, ev); }
    endAction(s, KEEPER, 1);
    const k = s.players[KEEPER]!;
    expect(k.act).toBe(ActionKind.NONE);
    expect(k.moveMode).toBe(MoveMode.STOP);
    expect(isFree(k)).toBe(true);
  });

  it('Keeper: fights a defender for the same ball — leaves a teammate\'s back-pass alone and wins contact priority', () => {
    // A defender's deliberate ground pass back toward the keeper / goal: no save action, no keeper touch from saves.
    const s = keeperScenario({ gk: 80, u: 2 });
    const d = s.players[4]!;
    d.x = xAt(22); d.z = 0;
    const b = s.ball;
    b.x = xAt(21); b.z = 0; b.y = BALL_RADIUS; b.px = b.x; b.pz = b.z; b.py = b.y;
    b.vx = -18; b.vy = 0; b.vz = 0.2; b.grounded = 1; b.owner = -1;
    b.lastTouch = 4; b.lastTouchTeam = 0; b.lastTouchTick = 0; b.lastKickBy = 4; b.lastKickTeam = 0;
    b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = 0; b.shotBy = -1; b.passTarget = KEEPER;
    const r = runShot(s, 120);
    expect(r.firstActTick).toBe(-1);
    expect(r.save).toBeNull();
    expect(s.ball.lastTouch).toBe(4);
    // A teammate's miscued clearance heading into the goal (not meant for him): he stops it, body only (back-pass rule).
    const c = keeperScenario({ gk: 80, u: 1.5 });
    shoot(c, { u: 14, z: 2, tz: 0.4, ty: 0.6, speed: 18, shooter: 4, kind: KickKind.CLEARANCE });
    expect(c.ball.lastKickTeam).toBe(0);
    const rc = runShot(c, 120);
    expect(rc.outcome).toBe('save');
    expect(c.ball.heldBy).toBe(-1);
    expect(c.ball.lastKickKind).toBe(KickKind.DEFLECTION);
    expect(rc.save?.b).toBe(SaveKind.BLOCK);
    // A shot reaching keeper and a defender beside him in the same tick: the keeper's contact runs first and is the
    // only contact of that tick (one ball, one player).
    const t = keeperScenario({ gk: 80, u: 2 });
    t.players[3]!.x = xAt(2); t.players[3]!.z = 0.6;
    shoot(t, { u: 18, z: 0, tz: 0.3, ty: 0.5, speed: 14 });
    const full = (st: SimState, ev: ReturnType<typeof createEventBuffer>) => {
      st.tick++; ev.begin(st.tick); st.ball.cross = 0;
      keeperSaveDecision(st, 0, ev); keeperSaveDecision(st, 1, ev);
      actionsTick(st, ev); locomotionTick(st, ev); ballTick(st, ev);
      contactsTick(st, ev);
    };
    const rr = runShot(t, 120, full);
    expect(rr.outcome).toBe('save');
    expect(t.ball.lastTouch).toBe(KEEPER);
    expect(t.ball.heldBy).toBe(KEEPER);
    expect(t.ball.owner).toBe(KEEPER);
  });
});

describe('GKP-02 contact details', () => {
  function crossingTick(keeperU: number) {
    const s = keeperScenario({ gk: 75, u: keeperU });
    const b = s.ball;
    // This tick the ball moved from 0.25 m in front of the line to 0.45 m behind it, through the keeper's body.
    b.px = xAt(0.25); b.py = 0.8; b.pz = 0;
    b.x = xAt(-0.45); b.y = 0.8; b.z = 0;
    b.vx = -30; b.vy = 0; b.vz = 0; b.grounded = 0; b.owner = -1; b.heldBy = -1;
    b.lastTouch = SHOOTER; b.lastTouchTeam = 1; b.lastTouchTick = s.tick - 30; b.touchedTick = -1;
    b.shotBy = SHOOTER; b.shotOnTarget = 1; b.lastKickBy = SHOOTER; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL;
    s.tick++;
    b.cross = CrossKind.GOAL; b.crossEnd = -1; b.crossX = -HALF_LENGTH; b.crossZ = 0;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    keeperContacts(s, ev);
    return s;
  }

  it('a save on the tick the ball crossed is made in front of the line and undoes the crossing', () => {
    const s = crossingTick(0.15);
    expect(s.ball.lastTouch).toBe(KEEPER);
    expect(s.ball.cross).toBe(CrossKind.NONE);
    expect(depth(s.ball.x)).toBeGreaterThan(-BALL_RADIUS);
    expect(s.ball.vx).toBeGreaterThan(0);
  });

  it('a ball that was wholly over the line before reaching him stays a goal', () => {
    const s = crossingTick(-0.4);
    expect(s.ball.lastTouch).toBe(SHOOTER);
    expect(s.ball.cross).toBe(CrossKind.GOAL);
  });

  it('keeper contacts are idle outside live play and never touch a ball in someone\'s possession', () => {
    const s = keeperScenario({ gk: 75, u: 2 });
    shoot(s, { u: 3, z: 0, tz: 0, ty: 1, speed: 20 });
    s.match.phase = MatchPhase.GOAL;
    const ev = createEventBuffer();
    for (let i = 0; i < 20; i++) { s.tick++; ev.begin(s.tick); ballTick(s, ev); keeperContacts(s, ev); }
    expect(s.ball.lastTouch).toBe(SHOOTER);
    const t = keeperScenario({ gk: 75, u: 2 });
    shoot(t, { u: 3, z: 0, tz: 0, ty: 1, speed: 20 });
    t.ball.owner = SHOOTER;
    for (let i = 0; i < 20; i++) { t.tick++; ev.begin(t.tick); ballTick(t, ev); keeperContacts(t, ev); }
    expect(t.ball.lastTouch).toBe(SHOOTER);
  });
});

describe('GKP-02 determinism and cost', () => {
  it('the full pipeline is deterministic through a save (same seed, same hash every tick)', () => {
    const run = () => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4242 });
      s.players[KEEPER]!.x = xAt(2); s.players[KEEPER]!.z = 0;
      shoot(s, { u: 16, z: 1, tz: -1.8, ty: 0.6, speed: 30 });
      const hashes: number[] = [];
      runTicks(s, 90, undefined, { until: (st) => { hashes.push(hashState(st)); return false; } });
      return { hashes, s };
    };
    const a = run();
    const b = run();
    expect(a.hashes).toEqual(b.hashes);
    expect(a.s.ball.lastTouch).toBe(b.s.ball.lastTouch);
  });

  it('the prediction memo never leaks between matches: interleaved runs equal solo runs bit for bit', () => {
    const mk = (seed: number, tz: number) => {
      const s = keeperScenario({ gk: 70, u: 2.2, seed });
      shoot(s, { u: 17, z: seed % 3, tz, ty: 0.7, speed: 28 });
      return s;
    };
    const solo = (s: SimState) => {
      const ev = createEventBuffer();
      const h: number[] = [];
      for (let t = 0; t < 60; t++) { miniTick(s, ev); h.push(hashState(s)); }
      return h;
    };
    const ha = solo(mk(1, 2.1)), hb = solo(mk(2, -1.2));
    const a = mk(1, 2.1), b = mk(2, -1.2);
    const ea = createEventBuffer(), eb = createEventBuffer();
    const ia: number[] = [], ib: number[] = [];
    for (let t = 0; t < 60; t++) {
      miniTick(a, ea); ia.push(hashState(a));
      miniTick(b, eb); ib.push(hashState(b));
    }
    expect(ia).toEqual(ha);
    expect(ib).toEqual(hb);
  });

  it('runs through the real step pipeline with core + action invariants', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 77 });
    s.players[KEEPER]!.x = xAt(2.2); s.players[KEEPER]!.z = 0;
    shoot(s, { u: 18, z: -2, tz: 1.5, ty: 0.8, speed: 26 });
    const checker = createInvariantChecker(['finite', 'bounds', 'owner', 'action', 'keeperArea']);
    let touched = false;
    runTicks(s, 160, undefined, {
      until: (st, evs) => {
        const f = checker.check(st, null);
        if (f.length > 0) throw new Error(f.join('\n'));
        if (st.ball.lastTouch === KEEPER) touched = true;
        void evs;
        return false;
      },
    });
    expect(touched).toBe(true);
    expect(s.players[KEEPER]!.act === ActionKind.GK_DIVE).toBe(false);
  });

  it('decision + contacts cost stays small (per tick, during shots)', () => {
    // Compared with the keeper-free stages of the same ticks (actions, locomotion for 22 players, ball physics),
    // measured in the same loop. CPUs are shared with other jobs and contention only ever inflates a sample, so the
    // best of several repetitions is used; plus a generous absolute cap for pathological regressions.
    let bestRatio = Infinity;
    let bestPer = Infinity;
    let ticks = 0;
    for (let rep = 0; rep < 5; rep++) {
      const rnd = lcg(3);
      const ev = createEventBuffer();
      let mine = 0;
      let rest = 0;
      ticks = 0;
      for (let i = 0; i < 80; i++) {
        const s = keeperScenario({ gk: 75, u: 2 });
        shoot(s, batchShot(rnd));
        for (let t = 0; t < 60; t++) {
          s.tick++; ev.begin(s.tick);
          const t0 = performance.now();
          keeperSaveDecision(s, 0, ev); keeperSaveDecision(s, 1, ev);
          const t1 = performance.now();
          actionsTick(s, ev); locomotionTick(s, ev); ballTick(s, ev);
          const t2 = performance.now();
          keeperContacts(s, ev);
          const t3 = performance.now();
          mine += (t1 - t0) + (t3 - t2);
          rest += t2 - t1;
          ticks++;
          if (s.ball.lastTouch === KEEPER || depth(s.ball.x) < 0) break;
        }
      }
      bestRatio = Math.min(bestRatio, mine / rest);
      bestPer = Math.min(bestPer, mine / ticks);
    }
    console.log(`GKP-02 cost: ${(bestPer * 1000).toFixed(1)} us per tick over ${ticks} shot ticks ` +
      `(${bestRatio.toFixed(2)}x actions + locomotion + ball physics; best of 5)`);
    expect(bestRatio).toBeLessThan(3);
    expect(bestPer).toBeLessThan(0.5);
  });

  it('ball physics stays the sim\'s: the helper aim reproduces the requested crossing', () => {
    const s = keeperScenario({ u: 2 });
    shoot(s, { u: 20, z: 3, tz: -2.5, ty: 1.4, speed: 27 });
    const c = { z: 0, y: 0, t: 0 };
    expect(lineCrossing(s.ball, c)).toBe(true);
    expect(c.z).toBeCloseTo(-2.5, 1);
    expect(c.y).toBeCloseTo(1.4, 1);
    void ballStepTick;
  });
});
