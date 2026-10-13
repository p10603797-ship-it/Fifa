/**
 * TAI-07: loose-ball chaser assignment (assignChaser). Unit-level: builds states with the scenario helper, then
 * calls jobs.resetJobs + steer.assignChaser directly (the same order as ai/index.ts) so other AI modules cannot
 * mask the behaviour. Glitch regressions: "Players: two teammates chase or nobody does".
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { ActionKind, AiJob, MatchPhase } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createBallPrediction } from '../../src/contracts/systems';
import { T_AI } from '../../src/contracts/tuning';
import { assignJob, isJobDriven, resetJobs } from '../../src/ai/jobs';
import {
  assignChaser, busyTicks, createInterceptEstimate, estimateIntercept, executeJobs, STEER_TUNING,
} from '../../src/ai/steer';
import { predictBall } from '../../src/sim/ball/flight';
import { rngFloat, rngInt, rngSeed } from '../../src/sim/core/rng';
import { makeScenario, type ScenarioOptions } from '../harness/scenario';

const ev: EventSink = { emit() { /* discard */ } };

/** Park every outfield player far from the centre (team 0 at x = -50, team 1 at x = +50), standing still. */
function park(s: SimState): void {
  for (let t = 0; t < 2; t++) {
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = s.players[teamFirstSlot(t) + k]!;
      p.x = t === 0 ? -50 : 50;
      p.z = -30 + 6 * (k - 1);
      p.vx = 0; p.vz = 0;
      p.fx = t === 0 ? 1 : -1; p.fz = 0;
      p.homeX = p.x; p.homeZ = p.z;
    }
  }
}

function place(s: SimState, slot: number, x: number, z: number, extra: Partial<SimState['players'][number]> = {}): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
  // Face the centre of the pitch by default.
  const l = Math.sqrt(x * x + z * z);
  if (l > 0.01) { p.fx = -x / l; p.fz = -z / l; }
  Object.assign(p, extra);
}

function looseState(opts: ScenarioOptions = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, ...opts, ball: { owner: -1, heldBy: -1, ...(opts.ball ?? {}) } });
  park(s);
  return s;
}

/** One AI pass for both teams: reset jobs then assign the chaser (as ai/index.ts does). */
function aiTick(s: SimState): void {
  s.tick++;
  for (let t = 0; t < 2; t++) {
    resetJobs(s, t);
    assignChaser(s, t, ev);
  }
}

function chaseJobs(s: SimState, team: number): number[] {
  const out: number[] = [];
  for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + PLAYERS_PER_TEAM; i++) {
    if (s.players[i]!.job === AiJob.CHASE_LOOSE) out.push(i);
  }
  return out;
}

/** The team invariant: one valid active chaser; CHASE_LOOSE on him iff he is job-driven, on nobody else. */
function expectOneChaser(s: SimState, team: number): void {
  const c = s.teams[team]!.chaser;
  const first = teamFirstSlot(team);
  expect(c, `team ${team} chaser`).toBeGreaterThanOrEqual(first);
  expect(c).toBeLessThan(first + PLAYERS_PER_TEAM);
  expect(s.players[c]!.active).toBe(1);
  const jobs = chaseJobs(s, team);
  if (isJobDriven(s, c)) expect(jobs).toEqual([c]);
  else expect(jobs).toEqual([]);
}

/** Ball fields as applyKick leaves them for a pass by `by` (team `team`) to `target`, kicked on tick `tick`. */
function passBy(by: number, team: number, target: number, tick: number): Partial<SimState['ball']> {
  return {
    passTarget: target, lastKickBy: by, lastKickTeam: team, lastKickTick: tick,
    lastTouch: by, lastTouchTeam: team, lastTouchTick: tick,
  };
}

const est = createInterceptEstimate();
function ballT(s: SimState, slot: number): number { return estimateIntercept(s, slot, est); }

describe('TAI-07 assignChaser: selection by arrival time', () => {
  it('chooses the player who intercepts a rolling ball first and sends him to the interception point at top speed', () => {
    const s = looseState({ ball: { x: 0, z: 0, vx: 10, vz: 0 } });
    place(s, 5, 12, 5); // ahead of the ball's path
    place(s, 6, -6, 4); // behind it
    place(s, 16, 30, -8); // team 1, further ahead
    place(s, 17, -10, -10);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    expectOneChaser(s, 0);
    expectOneChaser(s, 1);
    const p = s.players[5]!;
    expect(p.job).toBe(AiJob.CHASE_LOOSE);
    expect(Math.abs(p.tgtZ)).toBeLessThan(0.5); // on the ball's line
    expect(p.tgtX).toBeGreaterThan(0);
    expect(p.tgtSpeed).toBeCloseTo(s.attrs[5]!.topSpeed, 9);
    // The job target is exactly the estimated interception point.
    estimateIntercept(s, 5, est);
    expect(p.tgtX).toBeCloseTo(est.x, 9);
    expect(p.tgtZ).toBeCloseTo(est.z, 9);
    expect(est.inHorizon).toBe(1);
    expect(est.playerT).toBeLessThanOrEqual(est.ballT);
    expect(s.players[6]!.job).toBe(AiJob.HOLD_SHAPE);
  });

  it('the chosen chaser has the earliest interception among AI candidates (fresh assignment)', () => {
    const s = looseState({ ball: { x: 10, z: -5, vx: -6, vz: 4 } });
    place(s, 3, 0, 0); place(s, 4, 8, 6); place(s, 7, 20, -10); place(s, 9, -5, -12);
    aiTick(s);
    const c = s.teams[0]!.chaser;
    const tc = ballT(s, c);
    for (const i of [3, 4, 7, 9]) expect(tc).toBeLessThanOrEqual(ballT(s, i));
  });

  it('plays an airborne ball where it comes down to a playable height', () => {
    const s = looseState({ ball: { x: -10, y: 0.5, z: 0, vx: 12, vy: 11, vz: 0, grounded: 0 } });
    place(s, 4, 0, 3); // under the early flight
    place(s, 5, 14, -2);
    aiTick(s);
    const c = s.teams[0]!.chaser;
    estimateIntercept(s, c, est);
    const pred = createBallPrediction();
    predictBall(s.ball, STEER_TUNING.chasePredictTicks, pred);
    if (pred.count > 0 && est.inHorizon === 1) {
      expect(pred.y[est.ballT - 1]!).toBeLessThanOrEqual(STEER_TUNING.chaseReachHeight);
      // Every earlier sample the chaser could have reached in time is above head height.
      expect(est.x).toBeCloseTo(pred.x[est.ballT - 1]!, 9);
    }
    expect(est.x).toBeGreaterThan(-10); // never back where the ball was kicked from
  });

  it('a ball nobody can catch within the horizon: chase toward the end of its predicted path', () => {
    const s = looseState({ ball: { x: 20, z: 0, vx: 30, vz: 0 } });
    place(s, 4, -20, 0);
    estimateIntercept(s, 4, est);
    expect(est.inHorizon).toBe(0);
    expect(est.ballT).toBeGreaterThan(STEER_TUNING.chasePredictTicks);
    const pred = createBallPrediction();
    predictBall(s.ball, STEER_TUNING.chasePredictTicks, pred);
    expect(est.x).toBeCloseTo(pred.x[pred.count - 1]!, 9);
    aiTick(s);
    expectOneChaser(s, 0);
    expectOneChaser(s, 1);
  });

  it('ball owned or in a keeper\'s hands: no chaser; outside IN_PLAY executeJobs clears it', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    place(s, 5, 2, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    s.ball.owner = 5;
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(-1);
    expect(s.teams[1]!.chaser).toBe(-1);
    expect(chaseJobs(s, 0)).toEqual([]);
    s.ball.owner = 11; s.ball.heldBy = 11;
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(-1);
    s.ball.owner = -1; s.ball.heldBy = -1;
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    s.match.phase = MatchPhase.THROW_IN;
    executeJobs(s, 0, ev);
    executeJobs(s, 1, ev);
    expect(s.teams[0]!.chaser).toBe(-1);
    expect(s.teams[1]!.chaser).toBe(-1);
    expect(s.teams[0]!.chaserT).toBe(0);
  });
});

describe('TAI-07 assignChaser: hysteresis', () => {
  it('hysteresis prevents flip-flop between two teammates with near-equal arrival times', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    place(s, 5, 6, 0);
    place(s, 6, -6.2, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    let switches = 0;
    let last = 5;
    for (let k = 0; k < 300; k++) {
      // Alternate which of the two is (slightly) closer.
      const a = k % 2 === 0 ? 6.4 : 6.0;
      const b = k % 2 === 0 ? 6.0 : 6.4;
      place(s, 5, a, 0);
      place(s, 6, -b, 0);
      aiTick(s);
      expect(Math.abs(ballT(s, 5) - ballT(s, 6))).toBeLessThan(T_AI.chaserHysteresisTicks);
      if (s.teams[0]!.chaser !== last) { switches++; last = s.teams[0]!.chaser; }
      expectOneChaser(s, 0);
    }
    expect(switches).toBe(0);
    expect(s.teams[0]!.chaser).toBe(5);
  });

  it('a clearly faster teammate takes over only after chaserMinTicks', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    place(s, 5, 8, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    place(s, 6, -1.5, 0); // now much faster than 5
    expect(ballT(s, 5) - ballT(s, 6)).toBeGreaterThanOrEqual(T_AI.chaserHysteresisTicks);
    let held = 1;
    while (s.teams[0]!.chaser === 5 && held < 100) { aiTick(s); if (s.teams[0]!.chaser === 5) held++; }
    expect(s.teams[0]!.chaser).toBe(6);
    expect(held).toBeGreaterThanOrEqual(T_AI.chaserMinTicks);
    expect(held).toBeLessThanOrEqual(T_AI.chaserMinTicks + 1);
    expect(s.teams[0]!.chaserT).toBe(0);
    expectOneChaser(s, 0);
  });

  it('a chaser who goes down (FALLEN) is replaced at once, without waiting for chaserMinTicks', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    place(s, 5, 2, 0);
    place(s, 6, -4, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    Object.assign(s.players[5]!, { act: ActionKind.FALLEN, actT: 0, actDur: 70, moveMode: MoveMode.LOCKED });
    expect(busyTicks(s.players[5]!)).toBe(70);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(6);
    expectOneChaser(s, 0);
  });

  it('a sent-off chaser is replaced at once', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    place(s, 5, 2, 0);
    place(s, 6, -4, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    s.players[5]!.active = 0;
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(6);
    expectOneChaser(s, 0);
  });
});

describe('TAI-07 assignChaser: controlled players, keepers, receivers', () => {
  it('a human-controlled player near the ball counts as the chaser; no AI teammate also chases', () => {
    const s = looseState({ ball: { x: 0, z: 0 }, humans: [{ side: 0, slot: 7 }] });
    place(s, 7, 2.5, 0);
    place(s, 8, -1.0, 0); // AI teammate even closer
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(7);
    expect(chaseJobs(s, 0)).toEqual([]);
    expect(s.players[8]!.job).not.toBe(AiJob.CHASE_LOOSE);
    expectOneChaser(s, 0);
    // Repeated ticks keep it that way.
    for (let k = 0; k < 30; k++) { aiTick(s); expect(s.teams[0]!.chaser).toBe(7); }
  });

  it('a human going for the ball claims it within the bias; a human far away leaves it to the AI', () => {
    const s = looseState({ ball: { x: 0, z: 0 }, humans: [{ side: 0, slot: 7 }] });
    place(s, 8, -5, 0); // AI
    place(s, 7, 11, 0, { vx: -5, vz: 0, fx: -1, fz: 0 }); // human running at the ball
    const ai = ballT(s, 8), human = ballT(s, 7);
    expect(human).toBeGreaterThan(ai); // the AI would be first...
    expect(human - ai).toBeLessThan(STEER_TUNING.controlledBiasTicks); // ...but within the bias
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(7);
    expect(chaseJobs(s, 0)).toEqual([]);

    const s2 = looseState({ ball: { x: 0, z: 0 }, humans: [{ side: 0, slot: 7 }] });
    place(s2, 8, -7, 0);
    place(s2, 7, 35, 0, { vx: -5, fx: -1, fz: 0 });
    aiTick(s2);
    expect(s2.teams[0]!.chaser).toBe(8);
    expect(chaseJobs(s2, 0)).toEqual([8]);
  });

  it('an AI chaser hands over to a human who arrives in time, and takes over again only with hysteresis', () => {
    const s = looseState({ ball: { x: 0, z: 0 }, humans: [{ side: 0, slot: 7 }] });
    place(s, 8, -6, 0);
    place(s, 7, 30, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(8);
    // The human runs in: as soon as his (biased) time is no worse than the AI's, he is the chaser.
    place(s, 7, 8, 0, { vx: -6, fx: -1, fz: 0 });
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(7);
    // He stops 5 m away (not going for it any more): the AI takes over again only after chaserMinTicks.
    place(s, 7, 5, 0, { vx: 0, fx: -1 });
    place(s, 8, -1, 0);
    let held = 0;
    while (s.teams[0]!.chaser === 7 && held < 100) { aiTick(s); held++; }
    expect(s.teams[0]!.chaser).toBe(8);
    expect(held).toBeGreaterThanOrEqual(T_AI.chaserMinTicks);
  });

  it('an AI keeper is not the chaser unless he rushes out (GK_RUSH); then no outfield teammate chases', () => {
    const s = looseState({ ball: { x: -46, z: 2 } });
    const k = s.teams[0]!.keeperSlot;
    place(s, k, -50, 0);
    place(s, 4, -30, 10);
    aiTick(s);
    expect(s.teams[0]!.chaser).not.toBe(k);
    expectOneChaser(s, 0);
    s.players[k]!.act = ActionKind.GK_RUSH;
    s.players[k]!.actDur = 60;
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(k);
    expect(chaseJobs(s, 0)).toEqual([]);
    s.players[k]!.act = ActionKind.NONE;
    aiTick(s);
    expect(s.teams[0]!.chaser).not.toBe(k);
    expectOneChaser(s, 0);
  });

  it('the intended receiver of our own pass is the chaser (a closer teammate does not cut in)', () => {
    // As applyKick leaves it: kicked and last touched by 5 (team 0) on the previous tick.
    const s = looseState({ ball: { x: -10, z: 0, vx: 14, vz: 0, ...passBy(5, 0, 9, 0) } });
    place(s, 5, -11, 0);
    place(s, 9, 15, 0); // receiver at the end of the pass
    place(s, 6, -2, 0.4); // teammate right on the ball's path
    place(s, 16, 5, 6); // opponent
    expect(ballT(s, 6)).toBeLessThan(ballT(s, 9));
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(9);
    expectOneChaser(s, 0);
    expectOneChaser(s, 1);
    for (let k = 0; k < 40; k++) { aiTick(s); expect(s.teams[0]!.chaser).toBe(9); }
    // An opponent's pass target does not bind team 0 (a new kick by team 1 on this tick).
    Object.assign(s.ball, passBy(16, 1, 16, s.tick));
    s.teams[0]!.chaser = -1;
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(6);
    expect(s.teams[1]!.chaser).toBe(16);
  });

  it('a receiver claim survives a brief lock (busy <= chaserHysteresisTicks) and a touch by a teammate', () => {
    const s = looseState({ ball: { x: -10, z: 0, vx: 14, vz: 0, ...passBy(5, 0, 9, 0) } });
    place(s, 5, -11, 0);
    place(s, 9, 15, 0);
    place(s, 6, -2, 0.4);
    // Just finishing a kick: T_AI.chaserHysteresisTicks ticks left.
    Object.assign(s.players[9]!, {
      act: ActionKind.KICK, actT: 30 - T_AI.chaserHysteresisTicks, actDur: 30, moveMode: MoveMode.LOCKED,
    });
    expect(busyTicks(s.players[9]!)).toBe(T_AI.chaserHysteresisTicks);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(9);
    // A teammate's touch does not end the pass (TAI-14 keeps assisting the receiver too).
    Object.assign(s.ball, { lastTouch: 6, lastTouchTeam: 0, lastTouchTick: s.tick });
    for (let k = 0; k < 20; k++) { aiTick(s); expect(s.teams[0]!.chaser).toBe(9); }
  });

  it('a first-time pass from a loose ball hands the chase from the passer to the receiver at once', () => {
    const s = looseState({ ball: { x: 0, z: 0, vx: 0 } });
    place(s, 5, 1.5, 0);
    place(s, 9, 25, 0);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(5);
    for (let k = 0; k < 3; k++) aiTick(s); // chaserT < chaserMinTicks: only a claim can move it now
    // 5 plays it first time to 9 on this tick (after the AI ran).
    Object.assign(s.ball, { vx: 16, ...passBy(5, 0, 9, s.tick) });
    Object.assign(s.players[5]!, { act: ActionKind.KICK, actT: 6, actDur: 20, moveMode: MoveMode.LOCKED });
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(9);
    expectOneChaser(s, 0);
  });

  it('a side reduced to its keeper still has exactly one chaser (never nobody)', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) s.players[11 + k]!.active = 0;
    aiTick(s);
    expect(s.teams[1]!.chaser).toBe(11);
    expectOneChaser(s, 1);
  });

  it('busy players (locked action, stun, no-touch window) are delayed by the remaining ticks', () => {
    const s = looseState({ ball: { x: 0, z: 0 } });
    place(s, 5, 0.8, 0);
    place(s, 6, -3, 0);
    expect(ballT(s, 5)).toBeLessThan(ballT(s, 6));
    Object.assign(s.players[5]!, { act: ActionKind.KICK, actT: 2, actDur: 40, moveMode: MoveMode.LOCKED });
    estimateIntercept(s, 5, est);
    expect(est.playerT).toBeGreaterThanOrEqual(38);
    expect(est.ballT).toBeGreaterThanOrEqual(38);
    aiTick(s);
    expect(s.teams[0]!.chaser).toBe(6);
    // Stun without an action, and the no-touch window after losing the ball, delay the same way.
    Object.assign(s.players[5]!, { act: ActionKind.NONE, actT: 0, actDur: 0, moveMode: MoveMode.STOP, stunT: 30 });
    expect(ballT(s, 5)).toBeGreaterThanOrEqual(30);
    Object.assign(s.players[5]!, { stunT: 0, noTouchT: 45 });
    expect(ballT(s, 5)).toBeGreaterThanOrEqual(45);
  });
});

describe('TAI-07 glitch: Players: two teammates chase or nobody does', () => {
  it('exactly one chaser per team for many random loose-ball scenarios', () => {
    const r = { a: 0, b: 0, c: 0, d: 0 };
    rngSeed(r, 0x7a107);
    const range = (lo: number, hi: number): number => lo + (hi - lo) * rngFloat(r);
    let controlledChasers = 0, keeperChasers = 0, aiChasers = 0;
    for (let n = 0; n < 300; n++) {
      const humans = rngInt(r, 3);
      const hl: ScenarioOptions['humans'] = [];
      if (humans >= 1) hl.push({ side: 0, slot: 1 + rngInt(r, 10) });
      if (humans >= 2) hl.push({ side: rngInt(r, 2), slot: -1 });
      const airborne = rngInt(r, 3) === 0;
      const s = makeScenario({
        phase: MatchPhase.IN_PLAY, seed: n + 1,
        ball: {
          x: range(-50, 50), z: range(-32, 32), y: airborne ? range(0.5, 6) : 0.11,
          vx: range(-25, 25), vz: range(-15, 15), vy: airborne ? range(-3, 14) : 0, grounded: airborne ? 0 : 1,
          owner: -1, heldBy: -1,
        },
        humans: hl.map((h) => ({ side: h.side, ...(h.slot! >= 0 ? { slot: h.slot } : {}) })),
      });
      // Second human on the away side: give him a random away player.
      if (humans >= 2 && s.ctrl[1]!.side === 1) { const sl = 12 + rngInt(r, 10); s.ctrl[1]!.slot = sl; s.players[sl]!.ctrl = 1; }
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        p.x = range(-52, 52); p.z = range(-33, 33);
        p.vx = range(-6, 6); p.vz = range(-6, 6);
        const fl = Math.sqrt(p.vx * p.vx + p.vz * p.vz) || 1;
        p.fx = p.vx / fl; p.fz = p.vz / fl;
        const roll = rngInt(r, 12);
        if (roll === 0) Object.assign(p, { act: ActionKind.FALLEN, actT: 0, actDur: 70, moveMode: MoveMode.LOCKED });
        else if (roll === 1) Object.assign(p, { act: ActionKind.KICK, actT: 3, actDur: 20, moveMode: MoveMode.LOCKED });
        else if (roll === 2) p.noTouchT = rngInt(r, 30);
        else if (roll === 3) p.stunT = rngInt(r, 40);
        // Random sent-offs (never a keeper, never a controlled player).
        if (p.isKeeper === 0 && p.ctrl < 0 && rngInt(r, 10) === 0) p.active = 0;
      }
      for (let t = 0; t < 2; t++) {
        const k = s.teams[t]!.keeperSlot;
        if (rngInt(r, 6) === 0) Object.assign(s.players[k]!, { act: ActionKind.GK_RUSH, actT: 0, actDur: 90 });
      }
      if (rngInt(r, 4) === 0) {
        const team = rngInt(r, 2);
        s.ball.lastKickTeam = team;
        s.ball.passTarget = teamFirstSlot(team) + rngInt(r, PLAYERS_PER_TEAM);
      }
      for (let k = 0; k < 6; k++) {
        aiTick(s);
        for (let t = 0; t < 2; t++) {
          expectOneChaser(s, t);
          const c = s.teams[t]!.chaser;
          if (s.players[c]!.ctrl >= 0) controlledChasers++;
          else if (s.players[c]!.isKeeper === 1) keeperChasers++;
          else aiChasers++;
        }
        // Small random drift between AI passes.
        for (let i = 0; i < NUM_SLOTS; i++) { s.players[i]!.x += range(-0.3, 0.3); s.players[i]!.z += range(-0.3, 0.3); }
        s.ball.x += s.ball.vx / 60; s.ball.z += s.ball.vz / 60;
      }
    }
    // The generator covered every kind of chaser.
    expect(controlledChasers).toBeGreaterThan(0);
    expect(keeperChasers).toBeGreaterThan(0);
    expect(aiChasers).toBeGreaterThan(1000);
  });

  it('other modules cannot add a second chaser: CHASE_LOOSE is only given to team.chaser', () => {
    const s = looseState({ ball: { x: 0, z: 0, vx: 4 } });
    place(s, 5, 3, 0); place(s, 6, 6, 1); place(s, 7, -3, 0);
    aiTick(s);
    expectOneChaser(s, 0);
    // A lower-priority job given afterwards does not replace CHASE_LOOSE (jobs.ts priority order).
    expect(assignJob(s, s.teams[0]!.chaser, AiJob.PRESS, 9, 9, 5, -1)).toBe(false);
    expectOneChaser(s, 0);
  });
});
