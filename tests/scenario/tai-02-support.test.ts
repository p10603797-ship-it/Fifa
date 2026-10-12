/**
 * TAI-02 scenarios: support play over time. TAI-07 executeJobs is still a stub, so `driveTick` emulates its
 * contract (ARRIVE at the job target, sprint when the speed cap is above jog) and runs the real SIM-04 locomotion.
 * Also checks that the evaluation keeps no memory outside SimState (clone / interleaving), the settle-without-jitter
 * glitch line, and the ai/index integration point.
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { AiJob, MatchPhase, Role, TeamPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { teamAiTick } from '../../src/ai';
import { finalizeJobT, isJobDriven, resetJobs } from '../../src/ai/jobs';
import { assignSupport, callSupport, laneClearance, LOCAL_TUNING as T, SUPPORT_CALL_TICKS } from '../../src/ai/support';
import { cloneState } from '../../src/sim/core/clone';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';

type Spot = [slot: number, role: Role, x: number, z: number];
const HOME_442: Spot[] = [
  [0, Role.GK, -48, 0],
  [1, Role.RB, -20, 22], [2, Role.CB, -28, 7], [3, Role.CB, -28, -7], [4, Role.LB, -20, -22],
  [5, Role.RM, -2, 24], [6, Role.CM, -6, 6], [7, Role.CM, 0, -4], [8, Role.LM, -2, -24],
  [9, Role.ST, 18, 5], [10, Role.ST, 16, -6],
];
const AWAY_BLOCK: Spot[] = [
  [11, Role.GK, 49, 0],
  [12, Role.RB, 24, -18], [13, Role.CB, 24, -6], [14, Role.CB, 24, 6], [15, Role.LB, 24, 18],
  [16, Role.RM, 8, -20], [17, Role.CM, 8, -8], [18, Role.CM, 8, 7], [19, Role.LM, 8, 20],
  [20, Role.ST, -3, -12], [21, Role.ST, -3, 12],
];

function build(carrier = 7, phase = TeamPhase.ATTACK, seed = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed });
  for (const [slot, role, x, z] of [...HOME_442, ...AWAY_BLOCK]) {
    const p = s.players[slot]!;
    p.role = role; p.isKeeper = role === Role.GK ? 1 : 0;
    p.x = x; p.z = z; p.homeX = x; p.homeZ = z; p.vx = 0; p.vz = 0;
  }
  const c = s.players[carrier]!;
  s.ball.owner = carrier; s.ball.x = c.x; s.ball.z = c.z; s.ball.px = c.x; s.ball.pz = c.z;
  s.ball.lastTouch = carrier; s.ball.lastTouchTeam = 0;
  s.ctrl[2]!.slot = carrier; c.ctrl = 2;
  c.moveMode = MoveMode.STOP;
  s.teams[0]!.phase = phase;
  s.teams[1]!.phase = TeamPhase.DEFEND;
  return s;
}

/** Opponents slide with the ball (deterministic, state-derived) so lanes keep changing. */
function moveOpponentHomes(s: SimState): void {
  for (const [slot, , x, z] of AWAY_BLOCK) {
    if (slot === 11) continue;
    const p = s.players[slot]!;
    p.homeX = x + 0.35 * s.ball.x;
    p.homeZ = z + 0.45 * s.ball.z;
  }
}

/** One AI + locomotion tick (TAI-07 executeJobs emulated). */
function driveTick(s: SimState, opponentsFollow: boolean): void {
  s.tick++;
  if (opponentsFollow) moveOpponentHomes(s);
  for (let team = 0; team < 2; team++) {
    resetJobs(s, team);
    assignSupport(s, team, NULL_SINK);
    const a = team === 0 ? 0 : 11;
    for (let i = a; i < a + 11; i++) {
      if (!isJobDriven(s, i)) continue;
      const p = s.players[i]!;
      p.moveMode = MoveMode.ARRIVE;
      p.wantSprint = p.tgtSpeed > s.attrs[i]!.topSpeed * T_PLAYER.jogFraction + 1e-9 ? 1 : 0;
      finalizeJobT(s, i);
    }
  }
  locomotionTick(s, NULL_SINK);
  const o = s.ball.owner;
  if (o >= 0) { s.ball.x = s.players[o]!.x; s.ball.z = s.players[o]!.z; }
}

function dist(s: SimState, a: number, b: number): number {
  return Math.hypot(s.players[a]!.x - s.players[b]!.x, s.players[a]!.z - s.players[b]!.z);
}

/** Per-tick trace of everything this module and the emulated movement write. */
function snapshot(s: SimState): number[] {
  const out: number[] = [s.teams[0]!.supportSlot, s.teams[0]!.supportCallT];
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    out.push(p.job, p.tgtX, p.tgtZ, p.tgtSpeed, p.jobSlot, p.x, p.z);
  }
  return out;
}

describe('TAI-02 call for support over time', () => {
  it('call-for-support brings a player within 10 m of a stationary carrier within 2 s', () => {
    const s = build();
    s.players[6]!.x = -10; s.players[6]!.z = 10; // 17.2 m from the carrier, standing still
    expect(dist(s, 6, 7)).toBeGreaterThan(17);
    callSupport(s, 0, NULL_SINK);
    expect(s.teams[0]!.supportSlot).toBe(6);
    let reached = -1;
    for (let k = 1; k <= SUPPORT_CALL_TICKS; k++) {
      driveTick(s, false);
      if (reached < 0 && dist(s, 6, 7) <= 10) reached = k;
    }
    expect(reached).toBeGreaterThan(0);
    expect(dist(s, 6, 7)).toBeLessThanOrEqual(10);
    expect(s.teams[0]!.supportSlot).toBe(-1);
  });

  it('call-for-support reaches a slowly dribbling carrier while the opponents shift', () => {
    const s = build();
    const c = s.players[7]!;
    c.moveMode = MoveMode.DIRECT; c.ix = 0.5; c.iz = 0;
    s.players[6]!.x = -10; s.players[6]!.z = 8;
    callSupport(s, 0, NULL_SINK);
    for (let k = 0; k < SUPPORT_CALL_TICKS; k++) driveTick(s, true);
    expect(dist(s, 6, 7)).toBeLessThanOrEqual(10);
  });
});

describe('TAI-02 support positions over time', () => {
  it('supporters arrive on points with open lanes in the band, apart from each other', () => {
    const s = build();
    for (let k = 0; k < 240; k++) driveTick(s, false);
    const c = s.players[7]!;
    const close: number[] = [];
    for (let i = 1; i < 11; i++) {
      const p = s.players[i]!;
      if (p.job !== AiJob.SUPPORT) continue;
      expect(Math.hypot(p.x - p.tgtX, p.z - p.tgtZ)).toBeLessThan(1); // arrived
      if (Math.abs(Math.abs(p.tgtZ) - (34 - T.widthMargin)) < 1e-9) continue; // width holder
      close.push(i);
      const d = Math.hypot(p.tgtX - c.x, p.tgtZ - c.z);
      expect(d).toBeGreaterThanOrEqual(T.bandMin - 1e-9);
      expect(d).toBeLessThanOrEqual(T.bandMax + 1e-9);
      expect(laneClearance(s, 0, c.x, c.z, p.tgtX, p.tgtZ)).toBeGreaterThan(0);
    }
    expect(close.length).toBeGreaterThanOrEqual(2);
    for (const i of close) for (const j of close) if (i < j) expect(dist(s, i, j)).toBeGreaterThan(T.hardSeparation);
  });

  it('glitch: Players orbit or jitter around a target - support targets settle without flip-flops', () => {
    const s = build();
    const prevJob = new Array<number>(11).fill(-1);
    const switches = new Array<number>(11).fill(0);
    let lateChanges = 0;
    let prev = snapshot(s);
    for (let k = 1; k <= 420; k++) {
      driveTick(s, false);
      for (let i = 0; i < 11; i++) {
        const j = s.players[i]!.job;
        if (prevJob[i]! >= 0 && prevJob[i] !== j) switches[i]!++;
        prevJob[i] = j;
      }
      const cur = snapshot(s);
      if (k > 240) {
        // job / target / speed / jobSlot of every team-0 player frozen once everyone has arrived
        for (let i = 0; i < 11; i++) {
          for (let f = 0; f < 5; f++) if (cur[2 + i * 7 + f] !== prev[2 + i * 7 + f]) lateChanges++;
        }
      }
      prev = cur;
    }
    expect(lateChanges).toBe(0);
    for (let i = 0; i < 11; i++) expect(switches[i]).toBeLessThanOrEqual(1);
    // nobody keeps moving once settled
    for (let i = 0; i < 11; i++) expect(Math.hypot(s.players[i]!.vx, s.players[i]!.vz)).toBeLessThan(0.05);
  });

  it('support targets move smoothly while the carrier dribbles (no tick-to-tick jumps)', () => {
    const s = build();
    for (let k = 0; k < 120; k++) driveTick(s, false);
    const c = s.players[7]!;
    c.moveMode = MoveMode.DIRECT; c.ix = 0.6; c.iz = 0.2;
    const lastX = new Array<number>(11).fill(NaN), lastZ = new Array<number>(11).fill(NaN);
    let jumps = 0;
    for (let k = 0; k < 180; k++) {
      driveTick(s, true);
      for (let i = 1; i < 11; i++) {
        const p = s.players[i]!;
        if (p.job === AiJob.SUPPORT && !Number.isNaN(lastX[i]!) && Math.hypot(p.tgtX - lastX[i]!, p.tgtZ - lastZ[i]!) > 3) jumps++;
        lastX[i] = p.job === AiJob.SUPPORT ? p.tgtX : NaN;
        lastZ[i] = p.job === AiJob.SUPPORT ? p.tgtZ : NaN;
      }
    }
    // A supporter may re-choose a point when a lane closes, but not every few ticks.
    expect(jumps).toBeLessThanOrEqual(6);
  });
});

describe('TAI-02 determinism (evaluation every tick, no memory outside SimState)', () => {
  function trace(s: SimState, ticks: number, from: number, call: number): number[][] {
    const out: number[][] = [];
    for (let k = from; k < from + ticks; k++) {
      if (k === call) callSupport(s, 0, NULL_SINK);
      if (k === 60) { const c = s.players[7]!; c.moveMode = MoveMode.DIRECT; c.ix = 0.4; c.iz = -0.3; }
      driveTick(s, true);
      out.push(snapshot(s));
    }
    return out;
  }

  it('two runs of the same scenario are bit-identical', () => {
    const a = trace(build(), 300, 0, 90);
    const b = trace(build(), 300, 0, 90);
    expect(b).toEqual(a);
  });

  it('a clone taken mid-run (snapshot resync) continues bit-identically to the original', () => {
    const s = build();
    trace(s, 150, 0, 90); // the call at 90 is still active at the clone point
    expect(s.teams[0]!.supportCallT).toBeGreaterThan(0);
    const c = cloneState(s);
    expect(hashState(c)).toBe(hashState(s));
    // Step the clone first and the original second each tick: shared module scratch must not leak.
    for (let k = 150; k < 450; k++) {
      const tc = trace(c, 1, k, -1)[0]!;
      const ts = trace(s, 1, k, -1)[0]!;
      expect(tc).toEqual(ts);
    }
    expect(hashState(c)).toBe(hashState(s));
  });

  it('interleaving an unrelated match does not change the result', () => {
    const alone = trace(build(), 240, 0, 30);
    const a = build();
    const other = build(9, TeamPhase.BUILD_UP, 7);
    other.players[5]!.x = 10;
    const mixed: number[][] = [];
    for (let k = 0; k < 240; k++) {
      trace(other, 1, k, 50);
      mixed.push(trace(a, 1, k, 30)[0]!);
    }
    expect(mixed).toEqual(alone);
  });
});

describe('TAI-02 integration through ai/index teamAiTick', () => {
  it('the team AI pipeline gives the possessing team SUPPORT jobs and the defending team none', () => {
    const s = build();
    teamAiTick(s, NULL_SINK);
    let sup0 = 0, sup1 = 0;
    for (let i = 0; i < 11; i++) if (s.players[i]!.job === AiJob.SUPPORT) sup0++;
    for (let i = 11; i < 22; i++) if (s.players[i]!.job === AiJob.SUPPORT) sup1++;
    expect(sup0).toBeGreaterThanOrEqual(2);
    expect(sup1).toBe(0);
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      expect(Number.isFinite(p.tgtX) && Number.isFinite(p.tgtZ)).toBe(true);
    }
  });
});
