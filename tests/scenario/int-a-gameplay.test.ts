/**
 * INT-A gameplay integration regressions through the real step pipeline (BRIEF §5-§7, §14 glitch list,
 * docs/INTEGRATION_ISSUES.md "Gameplay feel" / "Wiring"): head tennis, header passes completing, receivers and chasers
 * not trailing a ball rolling away, a sprinting receiver keeping his pace, keepers collecting back passes (the 8 s
 * ball-untouched watchdog), TAI-14 receiver vs TAI-07 chaser, press / cover picks cleared at stoppages, stamina per
 * match length, HOLD_SHAPE catch-up speed, determinism of a short bot-v-bot run.
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { describe, expect, it } from 'vitest';
import { ActionKind, AiJob, AutoSwitch, ControllerKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { AXIS_SCALE, Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { holdShapeSpeed } from '../../src/ai/jobs';
import { isCompletablePassKind, isUntouchedPass } from '../../src/sim/players/firstTouch';
import { MEET, meetPoint } from '../../src/sim/control/resolveShared';
import { hashState } from '../../src/sim/core/hash';
import { findEvents, makeScenario, runTicks, type ScenarioHuman } from '../harness/scenario';

/** Park every player except `keep` far from the action (homes too, so the shape does not pull them back at once). */
function park(s: SimState, keep: readonly number[], side = -1): void {
  for (let i = 0; i < 22; i++) {
    if (keep.includes(i)) continue;
    const p = s.players[i]!;
    if (p.isKeeper === 1) continue;
    p.x = side * (i < 11 ? 44 : 40); p.z = -30 + 2.5 * (i % 11); p.vx = 0; p.vz = 0; p.homeX = p.x; p.homeZ = p.z;
  }
}

/** Switch both CPU brains off (team AI drives everyone). */
function noBrains(s: SimState): void {
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE; ctl.side = -1; ctl.slot = -1;
  }
  s.teams[0]!.cpu.active = 0;
  s.teams[1]!.cpu.active = 0;
}

describe('INT-A head tennis', () => {
  it('a header pass that reaches a teammate is a completed pass (PASS_COMPLETE), like a foot pass', () => {
    expect(isCompletablePassKind(KickKind.HEADER_PASS)).toBe(true);
    expect(isCompletablePassKind(KickKind.GROUND_PASS)).toBe(true);
    expect(isCompletablePassKind(KickKind.HEADER_SHOT)).toBe(false);
    expect(isCompletablePassKind(KickKind.THROW_IN)).toBe(false);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4, humans: 0 });
    Object.assign(s.ball, { lastKickBy: 6, lastTouch: 6, lastKickTick: 10, lastTouchTick: 10, lastKickKind: KickKind.HEADER_PASS, lastKickTeam: 0 });
    expect(isUntouchedPass(s.ball)).toBe(true);
    // Through the pipeline: a headed ball dropping to a free teammate is controlled and counted.
    const r = 9;
    const t = makeScenario({
      phase: MatchPhase.IN_PLAY, seed: 4, humans: 0,
      ball: {
        x: 0, y: 1.2, z: 0, vx: 7, vy: 0.5, vz: 0, owner: -1, passTarget: r, passX: 8, passZ: 0,
        lastKickBy: 6, lastTouch: 6, lastKickTeam: 0, lastTouchTeam: 0, lastKickKind: KickKind.HEADER_PASS, lastKickTick: 0, lastTouchTick: 0,
      },
    });
    noBrains(t);
    park(t, [r, 6]);
    Object.assign(t.players[6]!, { x: -1, z: 0, homeX: -1, homeZ: 0 });
    Object.assign(t.players[r]!, { x: 8, z: 0, vx: 0, vz: 0, fx: -1, fz: 0, homeX: 8, homeZ: 0 });
    const ev = runTicks(t, 120, undefined, { check: 'core', until: (st) => st.ball.owner === r });
    expect(t.ball.owner).toBe(r);
    expect(findEvents(ev, EventType.PASS_COMPLETE).some((e) => e.a === r && e.b === 6)).toBe(true);
  });

  it('glitch "head tennis": our own uncontested high ball is brought down, not headed on into another aerial ball', () => {
    const r = 9;
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, seed: 5, humans: 0,
      ball: {
        x: -6, y: 3.2, z: 0, vx: 13, vy: 3, vz: 0, owner: -1, passTarget: r, passX: 8, passZ: 0, grounded: 0,
        lastKickBy: 6, lastTouch: 6, lastKickTeam: 0, lastTouchTeam: 0, lastKickKind: KickKind.LOB_PASS, lastKickTick: 0, lastTouchTick: 0,
      },
    });
    noBrains(s);
    park(s, [r, 6]);
    Object.assign(s.players[6]!, { x: -8, z: 0, homeX: -8, homeZ: 0 });
    Object.assign(s.players[r]!, { x: 9, z: 0, vx: 0, vz: 0, fx: -1, fz: 0, homeX: 9, homeZ: 0 });
    const ev = runTicks(s, 180, undefined, { check: 'core', until: (st) => st.ball.owner === r });
    const headers = ev.filter((e) => e.type === EventType.KICK && e.b === KickKind.HEADER_PASS);
    expect(headers).toHaveLength(0);
    expect(s.ball.owner).toBe(r);
  });

  it('a contested high ball is still headed (an opponent at the drop spot)', () => {
    const r = 9;
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, seed: 5, humans: 0,
      ball: {
        x: -6, y: 3.2, z: 0, vx: 13, vy: 3, vz: 0, owner: -1, passTarget: r, passX: 8, passZ: 0, grounded: 0,
        lastKickBy: 6, lastTouch: 6, lastKickTeam: 0, lastTouchTeam: 0, lastKickKind: KickKind.LOB_PASS, lastKickTick: 0, lastTouchTick: 0,
      },
    });
    noBrains(s);
    park(s, [r, 6, 16]);
    Object.assign(s.players[6]!, { x: -8, z: 0, homeX: -8, homeZ: 0 });
    Object.assign(s.players[r]!, { x: 9, z: 0, vx: 0, vz: 0, fx: -1, fz: 0, homeX: 9, homeZ: 0 });
    Object.assign(s.players[16]!, { x: 8.2, z: 0.9, vx: 0, vz: 0, fx: -1, fz: 0, homeX: 8.2, homeZ: 0.9 });
    const ev = runTicks(s, 180, undefined, { check: 'core', until: (st) => st.ball.owner >= 0 });
    expect(ev.some((e) => e.type === EventType.AERIAL)).toBe(true);
  });
});

/** A loose pass rolling at `v` m/s along +x with the receiver `ahead` m behind the ball (the ball has just run past him). */
function rollingAway(v: number, ahead: number, human: boolean, runSpeed = 5): { s: SimState; r: number } {
  const r = 9;
  const humans: ScenarioHuman[] = human ? [{ side: 0, slot: r, autoSwitch: AutoSwitch.OFF }] : [{ side: 0, slot: 2, autoSwitch: AutoSwitch.OFF }];
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed: 7, humans,
    ball: {
      x: ahead, y: 0.11, z: 0, vx: v, vy: 0, vz: 0, owner: -1, passTarget: r, passX: 0, passZ: 0, grounded: 1,
      lastKickBy: 6, lastTouch: 6, lastKickTeam: 0, lastTouchTeam: 0, lastKickKind: KickKind.GROUND_PASS, lastKickTick: 0, lastTouchTick: 0,
    },
  });
  noBrains(s);
  park(s, [r, 6, 2]);
  Object.assign(s.players[6]!, { x: -20, z: 0, homeX: -20, homeZ: 0 });
  Object.assign(s.players[2]!, { x: -30, z: 20, homeX: -30, homeZ: 20 });
  // He was running onto the pass (at runSpeed) when it went past him.
  Object.assign(s.players[r]!, { x: 0, z: 0.3, vx: runSpeed, vz: 0, fx: 1, fz: 0, homeX: 0, homeZ: 0.3 });
  return { s, r };
}

describe('INT-A receivers and chasers do not trail a ball rolling away', () => {
  it('AI receiver (TAI-14 RECEIVE + TAI-07 steering): a 7.5 m/s pass 1.5 m past him is collected within 75 ticks', () => {
    const { s, r } = rollingAway(7.5, 1.5, false);
    const t0 = s.tick;
    runTicks(s, 150, undefined, { check: 'core', until: (st) => st.ball.owner === r });
    expect(s.ball.owner).toBe(r);
    expect(s.tick - t0).toBeLessThanOrEqual(75);
  });

  it('human receiver with the stick released (SIM-15 meet point): a 7.5 m/s pass 1.5 m past him is collected within 75 ticks', () => {
    const { s, r } = rollingAway(7.5, 1.5, true);
    const t0 = s.tick;
    runTicks(s, 150, undefined, { check: 'core', until: (st) => st.ball.owner === r });
    expect(s.ball.owner).toBe(r);
    expect(s.tick - t0).toBeLessThanOrEqual(75);
  });

  it('a loose ball rolling away from the AI chaser (no pass target) is caught, not followed at a distance', () => {
    const { s, r } = rollingAway(6, 2, false);
    s.ball.passTarget = -1;
    s.ball.lastKickKind = KickKind.DEFLECTION;
    const t0 = s.tick;
    runTicks(s, 200, undefined, { check: 'core', until: (st) => st.ball.owner >= 0 });
    expect(s.ball.owner).toBe(r);
    expect(s.tick - t0).toBeLessThanOrEqual(90);
  });

  it('a sprinting receiver with the stick released keeps his pace (meet point planned at his speed, not jog)', () => {
    const { s, r } = rollingAway(12, 6, true);
    const p = s.players[r]!;
    p.vx = 8.5; p.vz = 0;
    meetPoint(s, r, 0);
    const jog = s.attrs[r]!.topSpeed * T_PLAYER.jogFraction;
    expect(MEET.speed).toBeGreaterThan(jog + 1);
    expect(MEET.speed).toBeCloseTo(Math.min(8.5, s.attrs[r]!.topSpeed), 6);
    // Through the pipeline his speed does not collapse to a jog while he runs onto it.
    let minSpeed = 99;
    runTicks(s, 40, undefined, { until: (st) => { minSpeed = Math.min(minSpeed, Math.hypot(st.players[r]!.vx, st.players[r]!.vz)); return st.ball.owner === r; } });
    expect(minSpeed).toBeGreaterThan(jog);
  });
});

describe('INT-A keeper and back passes', () => {
  it('glitch "ball untouched": a back pass rolling across the goal mouth is collected by the keeper (no 8 s watchdog)', () => {
    for (const team of [0, 1]) {
      const k = team === 0 ? 0 : 11;
      const passer = team === 0 ? 3 : 14;
      const gx = team === 0 ? -52.5 : 52.5;
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 9 + team, humans: 0, teams: [{ dir: 1 }, { dir: -1 }] });
      const sx = gx === -52.5 ? 1 : -1;
      Object.assign(s.ball, {
        x: gx + sx * 9, y: 0.11, z: -17, vx: -sx * 4, vy: 0, vz: 13, grounded: 1, owner: -1, heldBy: -1, passTarget: k,
        passX: gx + sx * 2, passZ: -3, lastKickBy: passer, lastTouch: passer, lastKickTeam: team, lastTouchTeam: team,
        lastKickKind: KickKind.GROUND_PASS, lastKickTick: s.tick, lastTouchTick: s.tick,
      });
      s.ball.px = s.ball.x; s.ball.pz = s.ball.z;
      park(s, [k, passer], sx); // everybody else far up the other end
      Object.assign(s.players[passer]!, { x: gx + sx * 9.5, z: -18, homeX: gx + sx * 9.5, homeZ: -18 });
      Object.assign(s.players[k]!, { x: gx + sx * 1.7, z: -3.3, vx: 0, vz: 0 });
      let watchdog = false;
      runTicks(s, 300, undefined, {
        check: 'core',
        until: (st, ev) => { if (ev.some((e) => e.type === EventType.WATCHDOG)) watchdog = true; return st.ball.lastTouch === k; },
      });
      expect(s.ball.lastTouch, `team ${team}`).toBe(k);
      expect(watchdog).toBe(false);
    }
  });
});

describe('INT-A wiring', () => {
  it('TAI-14: the intended receiver gets RECEIVE only while he is his team\'s TAI-07 chaser', async () => {
    const { receiverAssist } = await import('../../src/ai/tactics');
    const { resetJobs } = await import('../../src/ai/jobs');
    const { s, r } = rollingAway(7, 3, false);
    resetJobs(s, 0);
    s.teams[0]!.chaser = r;
    receiverAssist(s, 0, { emit: () => {} } as never);
    expect(s.players[r]!.job).toBe(AiJob.RECEIVE);
    resetJobs(s, 0);
    s.teams[0]!.chaser = 6; // the chase went to a teammate: no second player runs for the ball
    receiverAssist(s, 0, { emit: () => {} } as never);
    expect(s.players[r]!.job).not.toBe(AiJob.RECEIVE);
  });

  it('TAI-07 vs GKP-03: a keeper on a user rush far upfield does not claim the chase from an outfielder (an AI rush still does)', async () => {
    const { assignChaser, RUSH_USER_MODE_MIN } = await import('../../src/ai/steer');
    const { resetJobs } = await import('../../src/ai/jobs');
    const { RushMode } = await import('../../src/sim/keeper/sweeper');
    expect(RUSH_USER_MODE_MIN).toBe(RushMode.USER_HOLD);
    expect(RushMode.USER_TIMED).toBeGreaterThan(RUSH_USER_MODE_MIN);
    expect(Math.max(RushMode.AI_BALL, RushMode.AI_ONE_ON_ONE)).toBeLessThan(RUSH_USER_MODE_MIN);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 13, humans: 0, ball: { owner: -1, heldBy: -1 } });
    noBrains(s);
    park(s, [9]);
    Object.assign(s.ball, { x: 20, z: 5, y: 0.11, vx: 6, vy: 0, vz: 0, grounded: 1 });
    Object.assign(s.players[9]!, { x: 22, z: 5, vx: 0, vz: 0 });
    const k = s.teams[0]!.keeperSlot;
    const tick = (): void => { s.tick++; for (let t = 0; t < 2; t++) { resetJobs(s, t); assignChaser(s, t, { emit: () => {} } as never); } };
    // As the fuzz case: a held keeper-rush button has sent him 40 m out after the ball.
    Object.assign(s.players[k]!, { x: -10, z: 0, act: ActionKind.GK_RUSH, actA: RushMode.USER_HOLD, actT: 0, actDur: 300 });
    tick();
    expect(s.teams[0]!.chaser).toBe(9);
    expect(s.players[9]!.job).toBe(AiJob.CHASE_LOOSE);
    s.players[k]!.actA = RushMode.AI_BALL; // the brain's rush (kept inside his come-out zone by GKP-03) claims the ball
    tick();
    expect(s.teams[0]!.chaser).toBe(k);
  });

  it('TAI-05: press / cover picks are cleared outside open play (no stale pick after a stoppage)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 11, humans: 0 });
    s.teams[0]!.pressSlot = 7; s.teams[0]!.coverSlot = 6; s.teams[1]!.pressSlot = 18; s.teams[1]!.coverSlot = 17;
    s.match.phase = MatchPhase.THROW_IN;
    s.match.restart.kind = RestartKind.THROW_IN;
    runTicks(s, 1);
    for (const t of s.teams) { expect(t.pressSlot).toBe(-1); expect(t.coverSlot).toBe(-1); }
  });

  it('HOLD_SHAPE speed: a jog near home, close to top speed when far from it (the shape keeps up with the ball)', () => {
    const top = 8.5;
    expect(holdShapeSpeed(top, 2, 0)).toBeCloseTo(top * T_PLAYER.jogFraction, 9);
    expect(holdShapeSpeed(top, 30, 0)).toBeGreaterThan(top * 0.85);
    expect(holdShapeSpeed(top, 8, 0)).toBeGreaterThan(holdShapeSpeed(top, 5, 0));
  });

  it('stamina drains per match, not per real second: 2-minute halves drain twice as fast as 4-minute halves', () => {
    const drain = (halfMinutes: number): number => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 12, humans: [{ side: 0, slot: 9, autoSwitch: AutoSwitch.OFF }], config: { halfMinutes } });
      noBrains(s);
      park(s, [9]);
      Object.assign(s.players[9]!, { x: -30, z: 0, stamina: 1 });
      Object.assign(s.ball, { x: 40, z: 30, owner: -1 });
      runTicks(s, 120, (_t, _st, out) => { out[0]!.mx = AXIS_SCALE; out[0]!.buttons = Btn.SPRINT; });
      return 1 - s.players[9]!.stamina;
    };
    const d4 = drain(4), d2 = drain(2), d8 = drain(8);
    expect(d4).toBeGreaterThan(0);
    expect(d2 / d4).toBeCloseTo(2, 1);
    expect(d8 / d4).toBeCloseTo(0.5, 1);
  });
});

describe('INT-A bot v bot', () => {
  it('a short bot-v-bot run keeps every invariant, produces shots and passes, and is deterministic', () => {
    const run = (): { hash: number; shots: number; passes: number } => {
      const s = makeScenario({ phase: MatchPhase.KICK_OFF, seed: 77, humans: 0, config: { halfMinutes: 2 } });
      const ev = runTicks(s, 5400, undefined, { check: 'all' });
      return {
        hash: hashState(s),
        shots: findEvents(ev, EventType.SHOT).length,
        passes: ev.filter((e) => e.type === EventType.KICK && (e.b === KickKind.GROUND_PASS || e.b === KickKind.DRIVEN_PASS)).length,
      };
    };
    const a = run(), b = run();
    expect(a.hash).toBe(b.hash);
    expect(a.passes).toBeGreaterThan(10);
    expect(a.shots).toBeGreaterThanOrEqual(0);
  });
});
