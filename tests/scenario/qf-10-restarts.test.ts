/**
 * [QF-10] Restarts (FIX-02): walked set-ups for the main-camera restarts (throw-ins, free kicks away from goal) instead
 * of the D-008 teleport, the free-kick taker lining up on the dead ball, the fouled player lying on the foul spot,
 * penalty legality with the body radius, and the CPU corner / free-kick fallback grace.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_ARC_RADIUS,
  POST_RADIUS,
} from '../../src/contracts/constants';
import { ActionKind, ControllerKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_PLAYER, T_RULES } from '../../src/contracts/tuning';
import { LOCAL_TUNING as CINE_LT } from '../../src/render/camera/cinematic';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { knockDown } from '../../src/sim/defend/tackle';
import { initMatch } from '../../src/sim/init';
import { KICK_TUNING } from '../../src/sim/kicks/kickCommon';
import { startPass } from '../../src/sim/kicks/pass';
import { bodyRadiusOf } from '../../src/sim/players/bodies';
import { LOCAL_TUNING as CORNER_LT } from '../../src/sim/rules/corner';
import { freeKickTakerScore, LOCAL_TUNING as FK_LT } from '../../src/sim/rules/freekick';
import {
  awardRestart, isLegalRestartPosition, isWalkedSetup, LOCAL_TUNING as RESTART_LT, prepareTakerKick, restartLookPoint,
} from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { req } from '../unit/sim-08-helpers';

/** A CPU v CPU match at kick-off (3-minute halves). */
function cpuMatch(seed: number): SimState {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.halfMinutes = 3 as never;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  return initMatch(cfg) as SimState;
}

/** CPU match `seed` stepped until it is in play past tick `from`. */
function inPlay(seed: number, from = 700): { s: SimState; step1: () => void } {
  const s = cpuMatch(seed);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const step1 = (): void => { step(s, frames, ev); };
  while (s.tick < from || s.match.phase !== MatchPhase.IN_PLAY) step1();
  return { s, step1 };
}

describe('QF-10 walked set-ups (FIX-02: QF-4 CR set-up teleport, D-008)', () => {
  it('qf-10: throw-in and far free-kick set-ups walk everybody in: no player moves 1 m in a tick, ready within the cap', () => {
    let walked = 0;
    for (const seed of [2, 3]) {
      const curr = cpuMatch(seed);
      const prev = cloneState(curr);
      const ev = createEventBuffer();
      const frames = [createInputFrame(), createInputFrame()];
      let n = 0, awardTick = -1;
      for (let t = 0; t < 60 * 60 * 7 && n < 6; t++) {
        copyState(prev, curr);
        step(curr, frames, ev);
        if (curr.match.phase === MatchPhase.POST_MATCH) break;
        const r = curr.match.restart;
        if (!(curr.match.phase >= MatchPhase.THROW_IN && curr.match.phase <= MatchPhase.PENALTY) || r.taken === 1) continue;
        if (!isWalkedSetup(curr)) continue;
        if (r.t === 1) awardTick = curr.tick - 1;
        for (let i = 0; i < NUM_SLOTS; i++) {
          const a = prev.players[i]!, b = curr.players[i]!;
          if (a.active !== 1 || b.active !== 1) continue;
          expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(1);
        }
        if (prev.match.restart.ready === 0 && r.ready === 1) {
          n++;
          walked++;
          // ready at restartSetupTicks at the earliest, setupExtendMaxTicks later at the latest; restart.t then counts
          // as restartSetupTicks (the CPU's "past ready" delays keep their meaning)
          expect(r.t).toBe(T_RULES.restartSetupTicks);
          expect(curr.tick - awardTick).toBeGreaterThanOrEqual(T_RULES.restartSetupTicks);
          expect(curr.tick - awardTick).toBeLessThanOrEqual(T_RULES.restartSetupTicks + RESTART_LT.setupExtendMaxTicks);
        }
      }
    }
    expect(walked).toBeGreaterThan(5);
  }, 240_000);

  it('qf-10: set-ups with a camera cut (corner, goal kick, penalty, free kick near goal) are still ready at restartSetupTicks', () => {
    const cases: [RestartKind, number, number][] = [
      [RestartKind.CORNER, 52, 30], [RestartKind.GOAL_KICK, -48, 5], [RestartKind.PENALTY, 41.5, 0], [RestartKind.FREE_KICK, 28, 6],
    ];
    for (const [kind, x, z] of cases) {
      const { s, step1 } = inPlay(4);
      const dir = s.teams[0]!.dir;
      awardRestart(s, kind, 0, dir * x, z, NULL_SINK);
      expect(s.match.restart.kind).toBe(kind);
      expect(isWalkedSetup(s)).toBe(false);
      let readyT = -1;
      for (let t = 0; t < 120 && readyT < 0; t++) { step1(); if (s.match.restart.ready === 1) readyT = s.match.restart.t; }
      expect(readyT).toBe(T_RULES.restartSetupTicks);
    }
  });

  it('qf-10: the walked free-kick threshold is the set-piece camera\'s (GFX-15 fkNearGoal)', () => {
    expect(RESTART_LT.cutFreeKickGoalDist).toBe(CINE_LT.fkNearGoal);
  });

  it('qf-10: a walked free kick goes to the best taker within takerWalkMaxDist, who runs there (no 40-60 m teleport)', () => {
    for (const seed of [1, 5]) {
      const { s, step1 } = inPlay(seed);
      const dir = s.teams[0]!.dir;
      awardRestart(s, RestartKind.FREE_KICK, 0, dir * -5, -12, NULL_SINK);
      const r = s.match.restart;
      expect(isWalkedSetup(s)).toBe(true);
      const t = r.taker;
      const p = s.players[t]!;
      const d0 = Math.hypot(p.x - r.x, p.z - r.z);
      expect(d0).toBeLessThanOrEqual(FK_LT.takerWalkMaxDist);
      for (let i = 0; i < 11; i++) {
        const q = s.players[i]!;
        if (i === t || q.active !== 1 || q.isKeeper === 1 || Math.hypot(q.x - r.x, q.z - r.z) > FK_LT.takerWalkMaxDist) continue;
        expect(freeKickTakerScore(s, i, false)).toBeLessThanOrEqual(freeKickTakerScore(s, t, false));
      }
      let px = p.x, pz = p.z, maxStep = 0;
      for (let k = 0; k < 260 && r.ready === 0; k++) {
        step1();
        maxStep = Math.max(maxStep, Math.hypot(p.x - px, p.z - pz));
        px = p.x; pz = p.z;
      }
      expect(r.ready).toBe(1);
      expect(maxStep).toBeLessThan(0.3);
      expect(Math.hypot(p.x - r.x, p.z - r.z)).toBeLessThanOrEqual(RESTART_LT.takerReach);
      // He ran in facing his run: waiting, he turns to his aim (SIM-04 does not turn a LOCKED player).
      for (let k = 0; k < 30 && p.act === ActionKind.SET_PIECE; k++) step1();
      if (p.act === ActionKind.SET_PIECE) {
        const look = { x: 0, z: 0 };
        restartLookPoint(s, look);
        const lx = look.x - p.x, lz = look.z - p.z, ll = Math.hypot(lx, lz);
        expect((p.fx * lx + p.fz * lz) / ll).toBeGreaterThan(0.95);
      }
    }
  });
});

describe('QF-10 free-kick taker on the dead ball', () => {
  it('qf-10: a taker turned away from his line-up side-steps round the ball and strikes it in front of him', () => {
    const { s, step1 } = inPlay(3);
    const dir = s.teams[0]!.dir;
    awardRestart(s, RestartKind.FREE_KICK, 0, dir * -10, 8, NULL_SINK);
    const r = s.match.restart;
    for (let k = 0; k < 300 && r.ready === 0; k++) step1();
    expect(r.ready).toBe(1); // (the CPU side may take it at once: act before the next tick)
    const t = r.taker;
    const p = s.players[t]!;
    // Pass straight back (his line-up faces the attacked goal): the ball is behind him once he turns.
    expect(prepareTakerKick(s, t)).toBe(1);
    p.fx = -dir; p.fz = 0;
    expect(startPass(s, t, KickKind.GROUND_PASS, req({ power: 0.4, dirX: -dir, dirZ: 0 }), NULL_SINK)).toBe(1);
    let minD = 1e9, kicked = false, spotD = -1, along = 0;
    for (let k = 0; k < 90 && !kicked; k++) {
      const prev = cloneState(s);
      step1();
      const q = prev.players[t]!;
      minD = Math.min(minD, Math.hypot(p.x - prev.ball.x, p.z - prev.ball.z));
      if (s.ball.lastKickBy === t && s.ball.lastKickTick === s.tick) {
        kicked = true;
        const fl = Math.hypot(q.fx, q.fz) || 1;
        spotD = Math.hypot(prev.ball.x - (q.x + (q.fx / fl) * KICK_TUNING.spotAhead), prev.ball.z - (q.z + (q.fz / fl) * KICK_TUNING.spotAhead));
        along = ((prev.ball.x - q.x) * q.fx + (prev.ball.z - q.z) * q.fz) / fl;
      }
    }
    expect(kicked).toBe(true);
    expect(spotD).toBeLessThanOrEqual(KICK_TUNING.spotReach + 1e-9);
    expect(along).toBeGreaterThan(0);
    expect(minD).toBeGreaterThan(KICK_TUNING.spotAhead - 0.15); // round the ball, never through it
    expect(r.taken).toBe(1);
  });

  it('qf-10: the fouled player lying on the foul spot is not under the free-kick ball (it goes beside him)', () => {
    for (const u of [-30, 0, 25]) {
      const { s, step1 } = inPlay(3);
      const vic = 7;
      const p = s.players[vic]!;
      p.x = s.teams[0]!.dir * u; p.z = 5;
      knockDown(s, vic, ActionKind.FALLEN, NULL_SINK);
      awardRestart(s, RestartKind.FREE_KICK, 0, p.x, p.z, NULL_SINK);
      expect(s.match.restart.taker).not.toBe(vic);
      let closest = 1e9;
      for (let k = 0; k < 300 && s.match.restart.taken === 0; k++) {
        step1();
        if (p.act === ActionKind.FALLEN || p.act === ActionKind.GET_UP) closest = Math.min(closest, Math.hypot(p.x - s.ball.x, p.z - s.ball.z));
      }
      expect(closest).toBeGreaterThanOrEqual(FK_LT.downClear - 0.35);
    }
  });
});

describe('QF-10 choose the taker at a walked free kick', () => {
  /** A match with the default human on team 0 (controller 0), stepped until in play past tick 700. */
  function humanMatch(seed: number): { s: SimState; frames: ReturnType<typeof createInputFrame>[]; step1: () => SimEvent[] } {
    const cfg = createMatchConfig();
    cfg.seed = seed;
    cfg.halfMinutes = 3 as never;
    const s = initMatch(cfg) as SimState;
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    const step1 = (): SimEvent[] => {
      step(s, frames, ev);
      const out: SimEvent[] = [];
      for (let i = 0; i < ev.count; i++) out.push({ ...ev.get(i) });
      return out;
    };
    while (s.tick < 700 || s.match.phase !== MatchPhase.IN_PLAY) step1();
    return { s, frames, step1 };
  }

  it('qf-10: glitch choose-the-taker teleport - at a walked free kick the new taker runs to the ball, the old one stays, and the kick waits for him', () => {
    let longRuns = 0;
    for (const [seed, u, z] of [[1, -5, -12], [5, -5, -12], [2, 0, 20], [3, -10, 8]] as const) {
      const { s, frames, step1 } = humanMatch(seed);
      const dir = s.teams[0]!.dir;
      awardRestart(s, RestartKind.FREE_KICK, 0, dir * u, z, NULL_SINK);
      const r = s.match.restart;
      expect(isWalkedSetup(s)).toBe(true);
      for (let k = 0; k < 300 && r.ready === 0; k++) step1();
      expect(r.ready).toBe(1);
      step1();
      step1();
      const t0 = r.taker;
      const o = s.players[t0]!;
      const ox = o.x, oz = o.z;
      frames[0]!.buttons = Btn.SPRINT;
      step1();
      frames[0]!.buttons = 0;
      const t1 = r.taker;
      if (t1 === t0) continue; // nobody else within takerWalkMaxDist
      const p = s.players[t1]!;
      // Nobody is teleported: the old taker is still where he stood, the new one has not jumped to the ball.
      expect(Math.hypot(o.x - ox, o.z - oz)).toBeLessThan(0.3);
      const d0 = Math.hypot(p.x - r.x, p.z - r.z);
      if (d0 > 3) longRuns++;
      // Press PASS every other tick while he runs: no kick before he is at the ball; then the kick is his.
      let prev = cloneState(s), kickTick = -1, arriveTick = -1, maxStep = 0;
      for (let k = 0; k < 400 && r.taken === 0; k++) {
        frames[0]!.buttons = (k & 2) !== 0 ? Btn.PASS : 0;
        const evs = step1();
        for (let i = 0; i < NUM_SLOTS; i++) {
          const a = prev.players[i]!, b = s.players[i]!;
          if (a.active === 1 && b.active === 1) maxStep = Math.max(maxStep, Math.hypot(b.x - a.x, b.z - a.z));
        }
        if (arriveTick < 0 && Math.hypot(p.x - r.x, p.z - r.z) <= RESTART_LT.takerReach) arriveTick = s.tick;
        if (kickTick < 0 && evs.some((e) => e.type === EventType.KICK)) kickTick = s.tick;
        prev = cloneState(s);
      }
      frames[0]!.buttons = 0;
      expect(maxStep).toBeLessThan(0.5);
      expect(arriveTick).toBeGreaterThan(0);
      expect(kickTick).toBeGreaterThanOrEqual(arriveTick);
      expect(r.taken).toBe(1);
      expect(s.ball.lastKickBy).toBe(t1);
    }
    expect(longRuns).toBeGreaterThan(0);
  }, 60_000);
});

describe('QF-10 restart placements clear of the goal frame', () => {
  it('qf-10: glitch players walk through the goal frame or net - a player behind the goal line at a goal kick is placed in front of the frame', () => {
    const { s, step1 } = inPlay(7);
    const dir = s.teams[1]!.dir; // team 1's goal kick at its own end (x = -dir * 52.5)
    const end = -dir;
    const mate = 14, opp = 5;
    awardRestart(s, RestartKind.GOAL_KICK, 1, end * 52.6, -4, NULL_SINK);
    expect(s.match.restart.kind).toBe(RestartKind.GOAL_KICK);
    // Behind the goal line beside the post (he ran after the ball), and an opponent likewise.
    const pm = s.players[mate]!, po = s.players[opp]!;
    pm.x = end * 55.2; pm.z = -4.0; pm.vx = 0; pm.vz = 0;
    po.x = end * 54.8; po.z = 3.9; po.vx = 0; po.vz = 0;
    for (let k = 0; k < 120 && s.match.restart.ready === 0; k++) {
      step1();
      if (k < 45) { pm.x = end * 55.2; pm.z = -4.0; po.x = end * 54.8; po.z = 3.9; } // still there at the set-up tick
    }
    expect(s.match.restart.ready).toBe(1);
    const R = T_PLAYER.bodyRadius, side = GOAL_HALF_WIDTH + POST_RADIUS + R;
    for (const q of [pm, po]) {
      const u = end * q.x;
      // Outfield bodies stay a body radius in front of the goal line between the posts (qf-1-bodies goalPenetration).
      const pen = Math.min(u - (HALF_LENGTH - R), HALF_LENGTH + GOAL_DEPTH + R - u, side - Math.abs(q.z));
      expect(pen, `(${q.x.toFixed(2)}, ${q.z.toFixed(2)})`).toBeLessThanOrEqual(1e-6);
      expect(Math.abs(q.x)).toBeLessThanOrEqual(HALF_LENGTH);
    }
    expect(isLegalRestartPosition(s, mate)).toBe(true);
  });
});

describe('QF-10 penalty legality with the body radius (FIX-02 item 7)', () => {
  it('qf-10: at a penalty nobody waits with part of his body inside the area or the arc', () => {
    const { s, step1 } = inPlay(2);
    const dir = s.teams[0]!.dir;
    const lineX = dir * (HALF_LENGTH - PENALTY_AREA_DEPTH);
    // Park players with their centres exactly on the area line and on the arc (half the body inside).
    const spots: [number, number][] = [[lineX, 22.5], [lineX, -25], [lineX - dir * 0.01, PENALTY_AREA_HALF_WIDTH + 0.01]];
    const movers = [3, 4, 14];
    for (let k = 0; k < movers.length; k++) { const q = s.players[movers[k]!]!; q.x = spots[k]![0]; q.z = spots[k]![1]; q.vx = 0; q.vz = 0; }
    awardRestart(s, RestartKind.PENALTY, 0, dir * 41.5, 0, NULL_SINK);
    const r = s.match.restart;
    for (let k = 0; k < 120 && r.ready === 0; k++) step1();
    expect(r.ready).toBe(1);
    for (let k = 0; k < 20; k++) step1();
    const keeper = s.teams[1]!.keeperSlot;
    const slack = RESTART_LT.legalSlack;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const q = s.players[i]!;
      if (q.active !== 1 || i === r.taker || i === keeper) continue;
      const R = bodyRadiusOf(s, i);
      const ex = dir * q.x, az = Math.abs(q.z);
      // Outside the area grown by his radius, and the arc disc grown by it.
      const inGrown = ex >= HALF_LENGTH - PENALTY_AREA_DEPTH - (R - slack) && az <= PENALTY_AREA_HALF_WIDTH + (R - slack);
      expect(inGrown, `slot ${i} at (${q.x.toFixed(2)}, ${q.z.toFixed(2)})`).toBe(false);
      expect(Math.hypot(q.x - r.x, q.z - r.z)).toBeGreaterThanOrEqual(PENALTY_ARC_RADIUS + R - slack - 1e-9);
    }
  });
});

describe('QF-10 CPU set-piece fallbacks (FIX-02 item 4)', () => {
  it('qf-10: corner / free-kick CPU fallbacks leave TAI-13 ~2 s for its box runners and stay inside RUL-11\'s CPU watchdog', () => {
    for (const lt of [CORNER_LT, FK_LT]) {
      expect(lt.cpuGraceTicks).toBeGreaterThanOrEqual(120);
      // The fallback and its first retry come before RUL-11's 4 s CPU timeout (logged as a watchdog event).
      expect(T_RULES.cpuRestartDelay + lt.cpuGraceTicks + lt.cpuRetryTicks).toBeLessThan(RESTART_LT.cpuTakeTimeoutTicks);
    }
  });

  it('qf-10: a CPU match has no restart watchdog events (walked set-ups, line-ups and the longer grace included)', () => {
    const s = cpuMatch(6);
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    let watchdogs = 0, kicks = 0;
    for (let t = 0; t < 60 * 60 * 7 && s.match.phase !== MatchPhase.POST_MATCH; t++) {
      step(s, frames, ev);
      for (let i = 0; i < ev.count; i++) {
        const e = ev.get(i);
        if (e.type === EventType.WATCHDOG) watchdogs++;
        if (e.type === EventType.KICK && e.b === KickKind.GROUND_PASS) kicks++;
      }
    }
    expect(kicks).toBeGreaterThan(50);
    expect(watchdogs).toBe(0);
  }, 240_000);
});
