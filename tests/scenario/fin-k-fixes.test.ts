/**
 * [FIN-K] Final fixes for the KNOWN_ISSUES "Match engine" lines that affected match state or input (DoD 8, BRIEF §14):
 *  1. goal-line free-kick wall vs the keeper's spot (RUL-05 lineWallKeeperZ / placeLineKeeper, GKP-06);
 *  2. "choose the taker" at a set-piece-camera free kick: the new taker runs in, no swap teleport (RUL-05);
 *  3. the 12 s restart timeout never places a taker who is still running in (RUL-11);
 *  4. a set-piece taker strikes at the planned contact from his current approach (kickCommon approachDeadBall);
 *  5. turn-and-kick: an owned ball never goes through the kicker's body (SIM-06 holdOn, kickCommon ownLaunchBlocked).
 * Each test fails on the code before its fix.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { ControllerKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_FREE_KICK, T_KICK, T_PLAYER, T_POSSESSION, T_RESTART_COMMON, T_RULES } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { startPass } from '../../src/sim/kicks/pass';
import { startShot } from '../../src/sim/kicks/shot';
import { bodyRadiusOf } from '../../src/sim/players/bodies';
import { lineWallKeeperZ, wallSlot } from '../../src/sim/rules/freekick';
import { awardRestart, isWalkedSetup, prepareTakerKick } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { makeScenario, runTicks } from '../harness/scenario';
import { giveBall, MATE_A, PASSER, place, req } from '../unit/sim-08-helpers';

/** A CPU v CPU match (3-minute halves) stepped until in play past tick 700. */
function cpuInPlay(seed: number): { s: SimState; step1: () => SimEvent[] } {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.halfMinutes = 3 as never;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  return stepper(initMatch(cfg) as SimState, [createInputFrame(), createInputFrame()]);
}

/** A match with the default human on team 0 (controller 0), stepped until in play past tick 700. */
function humanInPlay(seed: number): { s: SimState; frames: ReturnType<typeof createInputFrame>[]; step1: () => SimEvent[] } {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.halfMinutes = 3 as never;
  const frames = [createInputFrame(), createInputFrame()];
  return { ...stepper(initMatch(cfg) as SimState, frames), frames };
}

function stepper(s: SimState, frames: ReturnType<typeof createInputFrame>[]): { s: SimState; step1: () => SimEvent[] } {
  const ev = createEventBuffer();
  const step1 = (): SimEvent[] => {
    step(s, frames, ev);
    const out: SimEvent[] = [];
    for (let i = 0; i < ev.count; i++) out.push({ ...ev.get(i) });
    return out;
  };
  while (s.tick < 700 || s.match.phase !== MatchPhase.IN_PLAY) step1();
  return { s, step1 };
}

describe('FIN-K 1: goal-line free-kick wall and the keeper', () => {
  it('fin-k: goal-line free-kick wall - the keeper stands at the end of the wall, no member is pushed off his slot (no overlap, no gap)', () => {
    for (const [seed, z] of [[519, 0], [520, 0.6], [521, -0.9], [522, 2.5], [523, -1.5], [524, 4]] as [number, number][]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, match: { periodT: 600 } });
      const dir = s.teams[0]!.dir;
      const k = s.teams[1]!.keeperSlot;
      const kp = s.players[k]!;
      kp.x = dir * 50.5; kp.z = 0; kp.vx = 0; kp.vz = 0; // in his goal (a back-pass picked up in his box)
      const ev = createEventBuffer();
      ev.begin(s.tick);
      awardRestart(s, RestartKind.FREE_KICK, 0, dir * 47, z, ev);
      const r = s.match.restart;
      runTicks(s, 300, undefined, { until: (st) => st.match.restart.ready === 1 && st.match.restart.t >= T_RULES.restartSetupTicks + 90 });
      expect(r.taken, `z ${z}`).toBe(0);
      expect(r.wallCount).toBeGreaterThan(1);
      const bodies: { z: number; r: number }[] = [{ z: kp.z, r: bodyRadiusOf(s, k) }];
      const o = { x: 0, z: 0 };
      for (let i = 0; i < r.wallCount; i++) {
        wallSlot(s, i, o);
        const w = r.wall[i]!;
        const p = s.players[w]!;
        expect(Math.hypot(p.x - o.x, p.z - o.z), `member ${i} off his slot, z ${z}`).toBeLessThan(0.05);
        bodies.push({ z: p.z, r: bodyRadiusOf(s, w) });
      }
      // One line of bodies: neighbours touch (contact distance + wallGap), neither overlapping nor leaving a gap.
      bodies.sort((a, b) => a.z - b.z);
      for (let i = 1; i < bodies.length; i++) {
        const gap = bodies[i]!.z - bodies[i - 1]!.z - bodies[i]!.r - bodies[i - 1]!.r;
        expect(gap, `gap ${i} z ${z}`).toBeGreaterThan(-T_PLAYER.overlapTolerance);
        expect(gap, `gap ${i} z ${z}`).toBeLessThan(T_FREE_KICK.wallGap + 0.05);
      }
      // The keeper is in his slot at the wall's end (on the line, inside the posts).
      const spot = { x: 0, z: 0 };
      expect(lineWallKeeperZ(s, spot)).toBe(1);
      expect(Math.hypot(kp.x - spot.x, kp.z - spot.z), `keeper z ${z}`).toBeLessThan(0.05);
      expect(Math.abs(kp.z)).toBeLessThan(GOAL_HALF_WIDTH);
    }
  });
});

describe('FIN-K 4: set-piece taker strike timing', () => {
  it('fin-k: a free-kick taker whose kick goes another way than his line-up strikes at the planned contact (no re-line-up in a frozen kick pose)', () => {
    let cases = 0;
    for (const [deg, shot] of [[60, false], [90, false], [135, false], [180, false], [70, true]] as [number, boolean][]) {
      const { s, step1 } = cpuInPlay(3);
      const dir = s.teams[0]!.dir;
      awardRestart(s, RestartKind.FREE_KICK, 0, dir * 10, 8, NULL_SINK); // 42.5 m out: no wall, a pass or a long shot
      const r = s.match.restart;
      for (let k = 0; k < 300 && r.ready === 0; k++) step1();
      expect(r.ready).toBe(1);
      const t = r.taker;
      const p = s.players[t]!;
      // His line-up faces the attacked goal; the kick goes deg degrees off it (the set-piece modules turn him along it).
      const gx = dir * HALF_LENGTH - r.x, gz = -r.z, gl = Math.hypot(gx, gz);
      const a = (deg * Math.PI) / 180;
      const kx = (gx / gl) * Math.cos(a) - (gz / gl) * Math.sin(a), kz = (gx / gl) * Math.sin(a) + (gz / gl) * Math.cos(a);
      expect(prepareTakerKick(s, t)).toBe(1);
      p.fx = kx; p.fz = kz;
      const ok = shot
        ? startShot(s, t, KickKind.FREE_KICK_SHOT, req({ power: 0.6, dirX: kx, dirZ: kz }), NULL_SINK)
        : startPass(s, t, KickKind.GROUND_PASS, req({ power: 0.4, dirX: kx, dirZ: kz }), NULL_SINK);
      expect(ok).toBe(1);
      const planned = p.actContact; // contact tick of the action as started (the normal kick timing)
      const start = s.tick;
      let kickTick = -1, minD = 1e9;
      for (let k = 0; k < 90 && kickTick < 0; k++) {
        const prev = cloneState(s);
        step1();
        minD = Math.min(minD, Math.hypot(p.x - prev.ball.x, p.z - prev.ball.z));
        if (s.ball.lastKickBy === t && s.ball.lastKickTick === s.tick) kickTick = s.tick;
      }
      expect(kickTick, `${deg} deg`).toBeGreaterThan(0);
      expect(kickTick - start, `${deg} deg: input-to-contact`).toBeLessThanOrEqual(planned);
      expect(minD).toBeGreaterThan(T_KICK.spotAhead - 0.15); // round the ball during the wind-up, never through it
      expect(r.taken).toBe(1);
      cases++;
    }
    expect(cases).toBe(5);
  });
});

/** Segment (ax, az)-(bx, bz) distance to the origin. */
function segToOrigin(ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + az * dz) / l2)) : 0;
  return Math.hypot(ax + dx * t, az + dz * t);
}

describe('FIN-K 5: turn-and-kick', () => {
  it('fin-k: a dribbler who turns sharply and passes never draws the ball through his own body (it goes round; turn-and-kick)', () => {
    // [facing angle, ball angle (rel. to +x, 0.6 m from him), pass angle, speed along +x]: a pass back over his shoulder
    // with the ball ahead, and a sharp turn (he faces back, the ball still ahead of where he ran) then a pass that way.
    const cases: [number, number, number, number][] = [
      [0, 0, 150, 0], [0, 0, 180, 3], [0, 0, 165, 5], [180, 0, 180, 3], [180, 0, 170, 0], [150, 10, 160, 4],
    ];
    for (const [fa, ba, pa, speed] of cases) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4 });
      for (let i = 0; i < NUM_SLOTS; i++) {
        if (i === 0 || i === 11 || i === PASSER) continue;
        place(s, i, (i < 11 ? -30 : 30) + (i % 3), -25 + (i % 11) * 5);
      }
      for (let t = 0; t < 2; t++) s.teams[t]!.chaser = -1;
      for (let c = 0; c < s.ctrl.length; c++) s.ctrl[c]!.slot = -1;
      const rad = Math.PI / 180;
      place(s, PASSER, 0, 0, Math.cos(fa * rad), Math.sin(fa * rad));
      const p = s.players[PASSER]!;
      p.vx = speed;
      giveBall(s, PASSER);
      const b = s.ball;
      b.x = 0.6 * Math.cos(ba * rad); b.z = 0.6 * Math.sin(ba * rad); b.px = b.x; b.pz = b.z; b.vx = speed; b.vz = 0;
      const dx = Math.cos(pa * rad), dz = Math.sin(pa * rad);
      place(s, MATE_A, dx * 15, dz * 15);
      expect(startPass(s, PASSER, KickKind.GROUND_PASS, req({ power: 0.5, dirX: dx, dirZ: dz, targetSlot: MATE_A }), NULL_SINK)).toBe(1);
      const planned = p.actContact;
      let t = 0, kickT = -1, minSeg = 1e9;
      let rx = b.x - p.x, rz = b.z - p.z;
      runTicks(s, 90, undefined, {
        until: (_st, ev) => {
          t++;
          const nx = b.x - p.x, nz = b.z - p.z;
          if (b.y < 1) minSeg = Math.min(minSeg, segToOrigin(rx, rz, nx, nz)); // the ball relative to him, tick to tick
          rx = nx; rz = nz;
          if (kickT < 0 && ev.some((e) => e.type === EventType.KICK && e.a === PASSER && e.b === KickKind.GROUND_PASS)) kickT = t;
          return kickT >= 0 && t >= kickT + 10;
        },
      });
      const tag = `facing ${fa} ball ${ba} pass ${pa} speed ${speed}`;
      expect(kickT, tag).toBeGreaterThan(0); // kicked (not dropped) ...
      expect(kickT - planned, tag).toBeLessThanOrEqual(T_KICK.turnKickMaxTicks); // ... after the turn at most
      // Never through his body: the held ball and the launched ball pass him at least ~holdBodyClear away.
      expect(minSeg, tag).toBeGreaterThan(T_POSSESSION.holdBodyClear - 0.06);
    }
  });
});

/**
 * Award team 0 (human) a free kick at (u from the attacked goal line, z), step to ready (+2), press SPRINT ("choose
 * the taker") once `atTimeout` ticks before the 12 s timeout (or at once), then step without input until the restart
 * is taken. Reports whether the taker changed, his run, the largest per-tick move of any player and the kick.
 */
function chooseTakerRun(seed: number, u: number, z: number, atTimeout: number, pressPass: boolean): {
  changed: boolean; walked: boolean; d0: number; oldMoved: number; maxStep: number; arriveTick: number; kickTick: number;
  kickBy: number; t1: number; taken: number;
} {
  const { s, frames, step1 } = humanInPlay(seed);
  const dir = s.teams[0]!.dir;
  awardRestart(s, RestartKind.FREE_KICK, 0, dir * (HALF_LENGTH - u), z, NULL_SINK);
  const r = s.match.restart;
  const walked = isWalkedSetup(s);
  for (let k = 0; k < 400 && r.ready === 0; k++) step1();
  expect(r.ready).toBe(1);
  step1();
  step1();
  while (atTimeout > 0 && r.timeoutT > atTimeout && r.taken === 0) step1();
  const t0 = r.taker;
  const o = s.players[t0]!;
  const ox = o.x, oz = o.z;
  frames[0]!.buttons = Btn.SPRINT;
  step1();
  frames[0]!.buttons = 0;
  const t1 = r.taker;
  const p = s.players[t1]!;
  const out = {
    changed: t1 !== t0, walked, d0: Math.hypot(p.x - r.x, p.z - r.z), oldMoved: Math.hypot(o.x - ox, o.z - oz), maxStep: 0,
    arriveTick: -1, kickTick: -1, kickBy: -1, t1, taken: 0,
  };
  let prev = cloneState(s);
  for (let k = 0; k < 900 && r.taken === 0; k++) {
    frames[0]!.buttons = pressPass && (k & 2) !== 0 ? Btn.PASS : 0;
    const evs = step1();
    for (let i = 0; i < NUM_SLOTS; i++) {
      const a = prev.players[i]!, b = s.players[i]!;
      if (a.active === 1 && b.active === 1) out.maxStep = Math.max(out.maxStep, Math.hypot(b.x - a.x, b.z - a.z));
    }
    if (out.arriveTick < 0 && Math.hypot(p.x - r.x, p.z - r.z) <= 1.0) out.arriveTick = s.tick;
    if (out.kickTick < 0 && evs.some((e) => e.type === EventType.KICK)) { out.kickTick = s.tick; out.kickBy = s.ball.lastKickBy; }
    prev = cloneState(s);
  }
  frames[0]!.buttons = 0;
  out.taken = r.taken;
  return out;
}

describe('FIN-K 2-3: choose the taker under the set-piece camera, and the restart timeout', () => {
  it('fin-k: choose the taker at a free kick within 35 m of goal - the new taker runs to the ball, nobody is teleported, the kick waits for him', () => {
    let runs = 0;
    for (const [seed, u, z] of [[1, 24, 6], [5, 22, -8], [2, 28, 0], [3, 18, 12]] as const) {
      // 5 s after ready: the attackers have come up for the free kick (candidates within takerWalkMaxDist).
      const r = chooseTakerRun(seed, u, z, T_RULES.restartTimeoutTicks - 300, true);
      expect(r.walked).toBe(false); // the set-piece camera (GFX-15 fkNearGoal), where the swap used to be instant
      if (!r.changed) continue; // nobody else within takerWalkMaxDist
      expect(r.oldMoved, `seed ${seed}`).toBeLessThan(0.3); // the old taker is not swapped onto the new one's spot
      expect(r.d0).toBeLessThanOrEqual(T_FREE_KICK.takerWalkMaxDist + 1);
      if (r.d0 > 3) runs++;
      expect(r.maxStep, `seed ${seed}`).toBeLessThan(0.5); // nobody moves a body-width in a tick
      expect(r.arriveTick).toBeGreaterThan(0);
      expect(r.kickTick).toBeGreaterThanOrEqual(r.arriveTick); // PASS pressed all along: no kick before he is there
      expect(r.taken).toBe(1);
      expect(r.kickBy).toBe(r.t1);
    }
    expect(runs).toBeGreaterThan(0);
  }, 120_000);

  it('fin-k: the 12 s restart timeout never places a newly chosen taker who is still running in - it waits for him', () => {
    let runs = 0;
    for (const [seed, u, z] of [[1, 24, 6], [5, 22, -8], [1, 50, -10], [2, 28, 0]] as const) {
      // SPRINT 20 ticks before the timeout: the new taker needs longer than that to get there.
      const r = chooseTakerRun(seed, u, z, 20, false);
      if (!r.changed || r.d0 < 3) continue;
      runs++;
      expect(r.maxStep, `seed ${seed} u ${u}`).toBeLessThan(0.5); // not placed on his spot
      expect(r.arriveTick).toBeGreaterThan(0);
      expect(r.taken).toBe(1); // the Default takes it once he is there
      expect(r.kickTick).toBeGreaterThanOrEqual(r.arriveTick);
      expect(r.kickBy).toBe(r.t1);
      expect(r.kickTick - r.arriveTick).toBeLessThan(T_RESTART_COMMON.swapRunMaxTicks);
    }
    expect(runs).toBeGreaterThan(0);
  }, 120_000);
});
