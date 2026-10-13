/**
 * RUL-06: penalties in play, on the real pipeline (step.ts, RUL-01 machine, RUL-11 restart flow and legal positions,
 * SIM-15/16 resolver and switching, TAI-13 set-piece positions, GKP keepers, ball physics). Nothing is mocked: kicks
 * that SIM-11 would strike are scripted through core/kick applyKick at the moment the taker would make contact (see
 * rul-06-helpers strike). The shot-starter contract (startShot requests from buttons / swipes / the Default) is covered
 * with a recording startShot in rul-06-pipeline.test.ts; SIM-11's own accuracy model in rul-06-accuracy.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_ARC_RADIUS, PENALTY_SPOT_DIST,
} from '../../src/contracts/constants';
import { ActionKind, ControllerKind, GestureKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, createInputFrame, quantPos } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { NULL_SINK, createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { applyKick } from '../../src/sim/core/kick';
import { createKickLaunch } from '../../src/contracts/systems';
import { awardRestart, isLegalRestartPosition } from '../../src/sim/rules/restart';
import {
  DiveHeight, LOCAL_TUNING as LT, createPenaltyDiveChoice, penaltyAimFromDir, penaltyDiveChoice, penaltyInput,
  penaltyKeeper, penaltySpot, pickPenaltyTaker,
} from '../../src/sim/rules/penalty';
import { findEvents, makeScenario, runTicks, runUntil } from '../harness/scenario';
import { inArea, penaltyScenario, spotX, strike, untilReady } from './rul-06-helpers';

/** Both sides human (P1 home, P2 away): nobody kicks unless a test says so. */
const BOTH = [{ side: 0 }, { side: 1 }];

function bestTakerByHand(s: SimState, team: number): number {
  let best = -1;
  let bs = -1e9;
  const first = team === 0 ? 0 : 11;
  for (let i = first; i < first + 11; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    const a = s.attrs[i]!;
    const sc = a.finishing + a.composure + a.shotPower / 1000;
    if (sc > bs) { bs = sc; best = i; }
  }
  return best;
}

/** Every rule of a legal penalty position for every active player (taker / defending keeper / others). */
function legalityFailures(s: SimState): string[] {
  const r = s.match.restart;
  const team = r.team;
  const dir = s.teams[team]!.dir;
  const k = penaltyKeeper(s);
  const sx = spotX(s, team);
  const out: string[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    if (!isLegalRestartPosition(s, i)) out.push(`slot ${i} illegal for RUL-11 at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
    if (i === r.taker) {
      const dx = p.x - s.ball.x, dz = p.z - s.ball.z;
      if (Math.sqrt(dx * dx + dz * dz) > 1.0) out.push(`taker ${i} not at the ball`);
      if (dir * (p.x - s.ball.x) >= 0) out.push(`taker ${i} not behind the ball`);
      continue;
    }
    if (i === k) {
      if (Math.abs(p.x - dir * HALF_LENGTH) > 1.0 || Math.abs(p.z) > GOAL_HALF_WIDTH) out.push(`keeper ${i} off his line`);
      continue;
    }
    if (inArea(s, team, p.x, p.z)) out.push(`slot ${i} in the area`);
    const dx = p.x - sx, dz = p.z;
    if (Math.sqrt(dx * dx + dz * dz) < PENALTY_ARC_RADIUS - 0.05) out.push(`slot ${i} inside the arc`);
    if (dir * p.x > dir * sx + 0.05) out.push(`slot ${i} ahead of the penalty mark (x ${p.x.toFixed(2)})`);
    if (Math.abs(p.x) > HALF_LENGTH || Math.abs(p.z) > HALF_WIDTH) out.push(`slot ${i} off the pitch`);
  }
  return out;
}

describe('RUL-06 setup', () => {
  it.each([
    [0, 1], [0, -1], [1, -1], [1, 1],
  ])('team %i attacking dir %i: PENALTY phase, ball still on the mark of the attacked end, aim on the goal centre, no dive', (team, dir) => {
    const { s, awardEvents } = penaltyScenario({ team, dir, seed: 3, warmup: 20 });
    const m = s.match;
    const r = m.restart;
    expect(m.phase).toBe(MatchPhase.PENALTY);
    expect(r.kind).toBe(RestartKind.PENALTY);
    expect(r.team).toBe(team);
    expect(r.x).toBe(dir * (HALF_LENGTH - PENALTY_SPOT_DIST));
    expect(r.z).toBe(0);
    const b = s.ball;
    expect([b.x, b.z, b.vx, b.vy, b.vz, b.owner, b.heldBy]).toEqual([r.x, 0, 0, 0, 0, -1, -1]);
    expect(r.aimX).toBe(dir * HALF_LENGTH);
    expect(r.aimZ).toBe(0);
    expect([r.side, r.aimPower, r.ready, r.taken]).toEqual([0, 0, 0, 0]);
    expect(r.taker).toBe(bestTakerByHand(s, team));
    expect(findEvents(awardEvents, EventType.RESTART_AWARDED)).toHaveLength(1);
    const pt = { x: 0, z: 0 };
    penaltySpot(s, team, pt);
    expect(pt).toEqual({ x: r.x, z: 0 });
  });

  it('taker: best finishing + composure among outfield players who are not down; shot power breaks ties; keeper last', () => {
    const s = makeScenario({ seed: 2, phase: MatchPhase.IN_PLAY });
    for (let i = 0; i < 11; i++) { const a = s.attrs[i]!; a.finishing = 50; a.composure = 50; a.shotPower = 50; }
    s.attrs[0]!.finishing = 99; s.attrs[0]!.composure = 99; // the keeper: never first
    s.attrs[4]!.finishing = 80; s.attrs[4]!.composure = 80;
    s.attrs[9]!.finishing = 80; s.attrs[9]!.composure = 80; s.attrs[9]!.shotPower = 90;
    expect(pickPenaltyTaker(s, 0)).toBe(9);
    s.attrs[9]!.shotPower = 10;
    expect(pickPenaltyTaker(s, 0)).toBe(4);
    s.players[4]!.act = ActionKind.FALLEN; // the fouled player is still down
    expect(pickPenaltyTaker(s, 0)).toBe(9);
    s.players[4]!.act = ActionKind.NONE;
    s.players[4]!.stunT = 20;
    expect(pickPenaltyTaker(s, 0)).toBe(9);
    // Everyone else gone: the down player, then the keeper.
    for (let i = 1; i < 11; i++) if (i !== 4) s.players[i]!.active = 0;
    expect(pickPenaltyTaker(s, 0)).toBe(4);
    s.players[4]!.active = 0;
    expect(pickPenaltyTaker(s, 0)).toBe(0);
    s.players[0]!.active = 0;
    expect(pickPenaltyTaker(s, 0)).toBe(-1);
  });

  it.each([[0, 4], [1, 9], [0, 17], [1, 23]])('setup legality (team %i, seed %i): at ready and for 2 s after, taker behind the ball, keeper on his line between the posts, everyone else outside the area, the arc and behind the mark', (team, seed) => {
    const { s } = penaltyScenario({ team, seed, humans: BOTH, warmup: 90 + seed * 7 });
    untilReady(s);
    expect(s.match.restart.t).toBe(T_RULES.restartSetupTicks);
    expect(legalityFailures(s)).toEqual([]);
    const t = s.players[s.match.restart.taker]!;
    expect(t.act).toBe(ActionKind.SET_PIECE);
    for (let i = 0; i < 12; i++) {
      runTicks(s, 10, undefined, { check: 'core' });
      expect(s.match.phase).toBe(MatchPhase.PENALTY);
      expect(legalityFailures(s)).toEqual([]);
    }
    // The waiting taker faces the goal.
    expect(t.fx * s.teams[team]!.dir).toBeGreaterThan(0.9);
  });

  it('players standing in the area (and on the mark) at the award are outside it at ready and stay out', () => {
    const players = [];
    for (let i = 1; i < 11; i++) players.push({ slot: i, x: 44 + (i % 4) * 2, z: -8 + i * 1.5, vx: 0, vz: 0 });
    for (let i = 12; i < 22; i++) players.push({ slot: i, x: 41.5 + (i % 3) * 3, z: 9 - (i - 12) * 1.7, vx: 0, vz: 0 });
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 6, humans: BOTH, players });
    untilReady(s);
    expect(legalityFailures(s)).toEqual([]);
    runTicks(s, 90, undefined, { check: 'core' });
    expect(legalityFailures(s)).toEqual([]);
  });

  it('the taker walks to his spot during the setup delay (camera cut), and is placed exactly on it at ready', () => {
    const { s } = penaltyScenario({
      team: 0, dir: 1, seed: 8, humans: BOTH,
      before: (st) => { // the best taker is far from the box
        st.attrs[10]!.finishing = 99; st.attrs[10]!.composure = 99;
        st.players[10]!.x = 25; st.players[10]!.z = 15;
      },
    });
    const t = s.match.restart.taker;
    expect(t).toBe(10);
    const p = s.players[t]!;
    const d0 = Math.hypot(p.x - 40.9, p.z);
    runTicks(s, 40, undefined, { check: 'core' });
    expect(s.match.restart.ready).toBe(0);
    expect(Math.hypot(p.x - 40.9, p.z)).toBeLessThan(d0 - 1);
    // Heading for the spot behind the ball (40.9, 0).
    const vl = Math.hypot(p.vx, p.vz);
    expect(vl).toBeGreaterThan(2);
    expect((p.vx * (40.9 - p.x) + p.vz * -p.z) / (vl * Math.hypot(40.9 - p.x, p.z))).toBeGreaterThan(0.95);
    untilReady(s);
    expect(Math.hypot(p.x - s.ball.x, p.z - s.ball.z)).toBeLessThan(1.0);
  });
});

describe('RUL-06 taker input', () => {
  it.each([1, -1])('stick aims where its ray from the spot meets the goal line (dir %i): clamped inside the posts, persists when released', (dir) => {
    const { s } = penaltyScenario({ team: 0, dir, seed: 4, humans: BOTH });
    untilReady(s);
    const r = s.match.restart;
    expect(s.ctrl[0]!.slot).toBe(r.taker);
    const aimWith = (mx: number, mz: number): void => {
      runTicks(s, 1, (_t, _s, out) => { out[0]!.mx = mx; out[0]!.mz = mz; }, { check: 'core' });
    };
    // 30/120 of the forward length sideways over 11 m: 2.75 m toward +z.
    aimWith(dir * 120, 30);
    expect(r.aimX).toBe(dir * HALF_LENGTH);
    expect(r.aimZ).toBeCloseTo((30 / 120) * PENALTY_SPOT_DIST, 1);
    aimWith(dir * 120, -12);
    expect(r.aimZ).toBeCloseTo(-(12 / 120) * PENALTY_SPOT_DIST, 1);
    // Straight at the goal: the centre. Sideways only: the corner on that side (inside the post).
    aimWith(dir * 127, 0);
    expect(r.aimZ).toBeCloseTo(0, 6);
    aimWith(0, 127);
    expect(r.aimZ).toBeCloseTo(LT.aimMaxZ, 6);
    aimWith(dir * 40, -120); // far outside the post: clamped
    expect(r.aimZ).toBeCloseTo(-LT.aimMaxZ, 6);
    expect(LT.aimMaxZ).toBeLessThan(GOAL_HALF_WIDTH);
    // Released: the aim stays.
    runTicks(s, 30, undefined, { check: 'core' });
    expect(r.aimZ).toBeCloseTo(-LT.aimMaxZ, 6);
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    // The waiting taker turns to face his aim.
    const p = s.players[r.taker]!;
    expect(p.fz).toBeLessThan(-0.1);
  });

  it('penaltyAimFromDir: the same ray mapping (a direction from the spot to a goal-line point aims at that point)', () => {
    const { s } = penaltyScenario({ team: 1, dir: -1, seed: 5 });
    const r = s.match.restart;
    for (const tz of [-3.2, -1.1, 0.4, 2.9]) {
      penaltyAimFromDir(s, -HALF_LENGTH - r.x, tz - r.z);
      expect(r.aimX).toBe(-HALF_LENGTH);
      expect(r.aimZ).toBeCloseTo(tz, 9);
    }
    expect(penaltyAimFromDir(s, 0, 0)).toBe(0);
  });

  it('input before ready, after the kick, from the defending side or from a controller not holding the taker is ignored', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 7, humans: BOTH });
    const r = s.match.restart;
    // Before ready (setup delay): no aim, no dive.
    runTicks(s, 20, (_t, _s, out) => {
      out[0]!.mx = 120; out[0]!.mz = 60;
      out[1]!.buttons = Btn.RS_FLICK; out[1]!.az = 127;
    }, { check: 'core' });
    expect([r.aimZ, r.side, r.aimPower]).toEqual([0, 0, 0]);
    untilReady(s);
    // The defending side's stick does not aim.
    runTicks(s, 5, (_t, _s, out) => { out[1]!.mx = -120; out[1]!.mz = 60; }, { check: 'core' });
    expect(r.aimZ).toBe(0);
    // A direct call for a controller that does not hold the taker: nothing.
    const f = createInputFrame();
    f.mx = 120; f.mz = 60; f.buttons = Btn.SHOOT;
    const c0 = s.ctrl[0]!;
    const held = c0.slot;
    c0.slot = held === 9 ? 8 : 9;
    penaltyInput(s, 0, f, NULL_SINK);
    expect(r.aimZ).toBe(0);
    c0.slot = held;
    penaltyInput(s, 7, f, NULL_SINK); // out of range
    penaltyInput(s, -1, f, NULL_SINK);
    expect(r.aimZ).toBe(0);
    // After the kick: nothing either (restart taken).
    strike(s, 2.0);
    penaltyInput(s, 0, f, NULL_SINK);
    expect(r.aimZ).toBe(0);
  });
});

describe('RUL-06 keeper input', () => {
  it('human keeper: the left stick moves him along his line (|z| <= keeperMaxZ), facing the ball, never off it', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 9, humans: BOTH });
    untilReady(s);
    const k = penaltyKeeper(s);
    expect(s.ctrl[1]!.slot).toBe(k);
    const p = s.players[k]!;
    let maxZ = 0;
    runTicks(s, 150, (_t, st, out) => {
      out[1]!.mx = 60; out[1]!.mz = 127;
      maxZ = Math.max(maxZ, st.players[k]!.z);
    }, { check: 'core' });
    expect(p.z).toBeGreaterThan(LT.keeperMaxZ - 0.3);
    expect(Math.max(maxZ, p.z)).toBeLessThanOrEqual(LT.keeperMaxZ + 1e-9);
    expect(Math.abs(p.x - HALF_LENGTH)).toBeLessThan(1.0);
    runTicks(s, 200, (_t, _st, out) => { out[1]!.mz = -127; }, { check: 'core' });
    expect(p.z).toBeGreaterThanOrEqual(-LT.keeperMaxZ - 1e-9);
    expect(p.z).toBeLessThan(-LT.keeperMaxZ + 0.3);
    expect(Math.abs(p.x - HALF_LENGTH)).toBeLessThan(1.0);
    expect(p.fx).toBeLessThan(0); // facing the taker (-x)
    // Released: he stops (no drift).
    runTicks(s, 40, undefined, { check: 'core' });
    const z0 = p.z;
    runTicks(s, 20, undefined, { check: 'core' });
    expect(Math.abs(p.z - z0)).toBeLessThan(0.02);
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
  });

  it.each([1, -1])('human keeper (dir %i): RS flick, swipe or tap commit a dive (restart.side = pitch-z side, aimPower = height); latest wins', (dir) => {
    const { s } = penaltyScenario({ team: 0, dir, seed: 10, humans: BOTH });
    untilReady(s);
    const r = s.match.restart;
    const choice = createPenaltyDiveChoice();
    const flick = (ax: number, az: number): void => {
      runTicks(s, 1, (_t, _s, out) => { out[1]!.buttons = Btn.RS_FLICK; out[1]!.ax = ax; out[1]!.az = az; }, { check: 'core' });
      runTicks(s, 1, undefined, { check: 'core' });
    };
    expect(penaltyDiveChoice(s, choice)).toBe(1);
    expect(choice).toEqual({ dir: 0, height: DiveHeight.LOW });
    flick(0, 127); // straight to +z
    expect([r.side, r.aimPower]).toEqual([1, DiveHeight.MID]);
    flick(dir * 100, -100); // toward -z and up (toward the goal line, behind him)
    expect([r.side, r.aimPower]).toEqual([-1, DiveHeight.HIGH]);
    flick(-dir * 100, 100); // toward +z and low (toward the taker)
    expect([r.side, r.aimPower]).toEqual([1, DiveHeight.LOW]);
    flick(dir * 127, 10); // straight up: stay in the middle, high
    expect([r.side, r.aimPower]).toEqual([0, DiveHeight.HIGH]);
    // A held RS_FLICK bit is one edge only: the direction it has on later ticks commits nothing.
    const t0 = s.tick;
    runTicks(s, 3, (t, _s, out) => {
      out[1]!.buttons = Btn.RS_FLICK; out[1]!.ax = 0; out[1]!.az = t === t0 + 1 ? -127 : 127;
    }, { check: 'core' });
    expect([r.side, r.aimPower]).toEqual([-1, DiveHeight.MID]);
    // Swipe.
    runTicks(s, 1, (_t, _s, out) => {
      out[1]!.gesture = GestureKind.SWIPE; out[1]!.gdx = dir * 90; out[1]!.gdz = 90; out[1]!.gPower = 100;
    }, { check: 'core' });
    expect([r.side, r.aimPower]).toEqual([1, DiveHeight.HIGH]);
    // Tap: the side of the keeper the tap lies on, mid height; near him: the middle.
    const kz = s.players[penaltyKeeper(s)]!.z;
    runTicks(s, 1, (_t, _s, out) => {
      out[1]!.gesture = GestureKind.TAP; out[1]!.gx = quantPos(dir * HALF_LENGTH); out[1]!.gz = quantPos(kz - 2.5);
    }, { check: 'core' });
    expect([r.side, r.aimPower]).toEqual([-1, DiveHeight.MID]);
    runTicks(s, 1, (_t, _s, out) => {
      out[1]!.gesture = GestureKind.TAP; out[1]!.gx = quantPos(dir * HALF_LENGTH); out[1]!.gz = quantPos(kz + 0.3);
    }, { check: 'core' });
    expect([r.side, r.aimPower]).toEqual([0, DiveHeight.MID]);
    runTicks(s, 1, (_t, _s, out) => {
      out[1]!.gesture = GestureKind.DOUBLE_TAP; out[1]!.gx = quantPos(dir * HALF_LENGTH); out[1]!.gz = quantPos(kz + 2);
    }, { check: 'core' });
    expect(penaltyDiveChoice(s, choice)).toBe(1);
    expect(choice).toEqual({ dir: 1, height: DiveHeight.MID });
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
  });

  it('a CPU-controlled keeper\'s frame is never applied (GKP-06 chooses the dive and moves him)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 12, humans: [{ side: 0 }] });
    untilReady(s);
    const k = penaltyKeeper(s);
    expect(s.ctrl[3]!.kind).toBe(ControllerKind.CPU);
    s.ctrl[3]!.slot = k;
    const f = createInputFrame();
    f.buttons = Btn.RS_FLICK; f.az = 127; f.mz = 127;
    s.ctrl[3]!.buttons = Btn.RS_FLICK; s.ctrl[3]!.prevButtons = 0; s.ctrl[3]!.mz = 1;
    const z0 = s.players[k]!.z;
    penaltyInput(s, 3, f, NULL_SINK);
    expect([s.match.restart.side, s.match.restart.aimPower]).toEqual([0, 0]);
    expect(s.players[k]!.iz).toBe(0);
    expect(s.players[k]!.z).toBe(z0);
  });

  it('every penalty starts without a dive choice (a choice never carries over to the next one)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 13, humans: BOTH });
    untilReady(s);
    runTicks(s, 1, (_t, _s, out) => { out[1]!.buttons = Btn.RS_FLICK; out[1]!.ax = 90; out[1]!.az = 90; }, { check: 'core' });
    expect([s.match.restart.side, s.match.restart.aimPower]).toEqual([1, DiveHeight.HIGH]);
    strike(s, -3.0, 0.5, 22);
    runTicks(s, 1, undefined, { check: 'core' });
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    // A second penalty (a foul in the other area), the other way.
    const buf = createEventBuffer();
    buf.begin(s.tick);
    awardRestart(s, RestartKind.PENALTY, 1, s.teams[1]!.dir * 45, 0, buf);
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    expect([s.match.restart.side, s.match.restart.aimPower]).toEqual([0, 0]);
    const c = createPenaltyDiveChoice();
    expect(penaltyDiveChoice(s, c)).toBe(1);
    expect(c).toEqual({ dir: 0, height: DiveHeight.LOW });
  });
});

describe('RUL-06 after the kick', () => {
  it('the kick ends the penalty: IN_PLAY on the next rules pass, restart cleared, every player free to play', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 14, humans: BOTH });
    untilReady(s);
    strike(s, 2.4, 0.8, 23);
    expect(s.match.restart.taken).toBe(1);
    const ev = runTicks(s, 1, undefined, { check: 'core' });
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.match.restart.kind).toBe(RestartKind.NONE);
    expect(findEvents(ev, EventType.PHASE_CHANGE, (e) => e.a === MatchPhase.PENALTY && e.b === MatchPhase.IN_PLAY)).toHaveLength(1);
    for (let i = 0; i < NUM_SLOTS; i++) expect(s.players[i]!.act).not.toBe(ActionKind.SET_PIECE);
    // Penalty input no longer does anything (play is live).
    const f = createInputFrame();
    f.mx = 127; f.mz = 127;
    penaltyInput(s, 0, f, NULL_SINK);
    expect(s.match.restart.aimZ).toBe(0);
  });

  it('rebound playable: off the post the ball is live (no restart), the first player to reach it plays it', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 5 });
    untilReady(s);
    s.players[penaltyKeeper(s)]!.z = -2.5; // keeper on the other side
    strike(s, 3.66, 1.0, 22, 0); // the far post, rebounds into the field
    const all: SimEvent[] = [];
    const r = runUntil(s, (st, ev) => {
      all.push(...ev);
      return st.ball.lastTouch !== st.match.restart.taker && st.ball.lastTouch >= 0 && st.ball.touchedTick === st.tick;
    }, 400, undefined, 'core');
    expect(findEvents(all, EventType.POST)).toHaveLength(1);
    expect(r.reached).toBe(true);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(findEvents(all, EventType.RESTART_AWARDED)).toHaveLength(0);
    expect(findEvents(all, EventType.GOAL)).toHaveLength(0);
  });

  it('a goal from the rebound counts (the taker\'s teammate scores after the post)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 5 });
    untilReady(s);
    const k = penaltyKeeper(s);
    s.players[k]!.z = -2.5;
    strike(s, 3.66, 1.0, 22, 0);
    const post = runUntil(s, (_st, ev) => ev.some((e) => e.type === EventType.POST), 120, undefined, 'core');
    expect(post.reached).toBe(true);
    runTicks(s, 6, undefined, { check: 'core' });
    // An attacker arrives at the loose ball and side-foots it into the empty half of the goal.
    const att = s.match.restart.taker === 9 ? 10 : 9;
    const b = s.ball;
    const p = s.players[att]!;
    p.x = b.x - 0.5; p.z = b.z; p.vx = 0; p.vz = 0;
    s.players[k]!.x = HALF_LENGTH - 0.5; s.players[k]!.z = -3.2; s.players[k]!.vx = 0; s.players[k]!.vz = 0;
    const l = createKickLaunch();
    const tx = HALF_LENGTH + 1, tz = 2.0;
    const dx = tx - b.x, dz = tz - b.z, d = Math.hypot(dx, dz);
    l.vx = (dx / d) * 18; l.vz = (dz / d) * 18; l.vy = 1.5; l.kind = 13; l.target = -1; l.tx = tx; l.tz = tz; l.onTarget = 1;
    b.y = Math.max(b.y, 0.11);
    applyKick(s, att, l, 0.6, NULL_SINK);
    const g = runUntil(s, (st) => st.match.phase === MatchPhase.GOAL, 200, undefined, 'core');
    expect(g.reached).toBe(true);
    const goal = findEvents(g.events, EventType.GOAL);
    expect(goal).toHaveLength(1);
    expect(goal[0]!.a).toBe(0);
    expect(goal[0]!.b).toBe(att);
    expect(s.teams[0]!.goals).toBe(1);
  });

  it('the half cannot end during a penalty: time up during the setup and the aim -> still PENALTY; the kick\'s goal counts; then the whistle', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 15, humans: BOTH, match: { periodT: 4 * 3600 - 10 } });
    expect(s.match.periodLen).toBe(4 * 3600);
    const ev: SimEvent[] = [];
    ev.push(...untilReady(s));
    ev.push(...runTicks(s, 400, undefined, { check: 'core' }));
    expect(s.match.periodT).toBeGreaterThan(s.match.periodLen);
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    expect(findEvents(ev, EventType.PERIOD_END)).toHaveLength(0);
    s.players[penaltyKeeper(s)]!.z = -2.5;
    strike(s, 2.9, 0.6, 24);
    const g = runUntil(s, (st) => st.match.phase === MatchPhase.GOAL || st.match.phase === MatchPhase.HALF_TIME, 300, undefined, 'core');
    expect(g.reached).toBe(true);
    expect(s.match.phase).toBe(MatchPhase.GOAL);
    expect(s.teams[0]!.goals).toBe(1);
    ev.push(...g.events);
    // Never PENALTY -> anything but IN_PLAY.
    for (const e of findEvents(ev, EventType.PHASE_CHANGE, (x) => x.a === MatchPhase.PENALTY)) expect(e.b).toBe(MatchPhase.IN_PLAY);
    // The half then ends after the goal sequence (no kick-off).
    const h = runUntil(s, (st) => st.match.phase === MatchPhase.HALF_TIME || st.match.phase === MatchPhase.KICK_OFF, 1500, undefined, 'core');
    expect(h.reached).toBe(true);
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
  });

  it('the half cannot end during a penalty even when the taker takes the full 12 s (the Default then takes it)', () => {
    const { s } = penaltyScenario({ team: 0, dir: 1, seed: 16, humans: BOTH, match: { periodT: 4 * 3600 - 5 } });
    const r = runUntil(s, (st) => st.match.phase !== MatchPhase.PENALTY, T_RULES.restartSetupTicks + T_RULES.restartTimeoutTicks + 200, undefined, 'core');
    expect(r.reached).toBe(true);
    // Left the penalty only for live play (the kick was taken: Default, or RUL-11's forced kick while SIM-11 refuses).
    expect(findEvents(r.events, EventType.PHASE_CHANGE, (x) => x.a === MatchPhase.PENALTY).map((e) => e.b)).toEqual([MatchPhase.IN_PLAY]);
    expect(findEvents(r.events, EventType.PERIOD_END)).toHaveLength(0);
    const kicks = findEvents(r.events, EventType.KICK);
    expect(kicks.length).toBeGreaterThan(0);
    expect(kicks[kicks.length - 1]!.a).toBe(s.match.restart.kind === RestartKind.NONE ? s.ball.lastKickBy : -2);
  });
});

describe('RUL-06 timeout and determinism', () => {
  it('a human taker who does nothing gets the Default at the 12 s timeout, not before: aim on a corner (s.rng), the kick follows', () => {
    const { s } = penaltyScenario({ team: 1, dir: -1, seed: 17, humans: BOTH });
    untilReady(s);
    const r = s.match.restart;
    const readyTick = s.tick;
    runTicks(s, T_RULES.restartTimeoutTicks - 1, undefined, { check: 'core' });
    expect(r.aimZ).toBe(0);
    expect(r.taken).toBe(0);
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    runTicks(s, 1, undefined, { check: 'core' });
    expect(s.tick - readyTick).toBe(T_RULES.restartTimeoutTicks);
    expect(Math.abs(r.aimZ)).toBeGreaterThanOrEqual(GOAL_HALF_WIDTH - LT.defaultInsetMax - 1e-9);
    expect(Math.abs(r.aimZ)).toBeLessThanOrEqual(GOAL_HALF_WIDTH - LT.defaultInsetMin + 1e-9);
    const done = runUntil(s, (st) => st.match.phase !== MatchPhase.PENALTY, 300, undefined, 'core');
    expect(done.reached).toBe(true);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('determinism: the same seed and inputs give the same state hash through a whole penalty', () => {
    const run = (): number => {
      const { s } = penaltyScenario({ team: 0, dir: 1, seed: 21, humans: BOTH, warmup: 40 });
      untilReady(s);
      runTicks(s, 120, (t, _st, out) => {
        out[0]!.mx = 110; out[0]!.mz = t % 7 === 0 ? -40 : 30;
        out[1]!.mz = t % 30 < 15 ? 127 : -127;
        if (t % 50 === 0) { out[1]!.buttons = Btn.RS_FLICK; out[1]!.ax = 50; out[1]!.az = -90; }
      }, { check: 'core' });
      strike(s, s.match.restart.aimZ, 0.7, 25);
      runTicks(s, 200, undefined, { check: 'core' });
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
