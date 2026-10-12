/**
 * TAI-03 scenarios: attacking runs (in behind with onside timing, overlaps with cover, late runs into the box),
 * trigger run and pass and go. Movement over time uses the real TAI-07 executeJobs and SIM-04 locomotion
 * (`driveTick`); opponents are scripted so the offside line can move. Onside is measured with RUL-08
 * isOffsidePosition and with this module's own mirror (inOffsidePosition).
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, AiJob, KickKind, MatchPhase, Role, TacticalFocus, TeamPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { teamAiTick } from '../../src/ai';
import { assignJob, resetJobs } from '../../src/ai/jobs';
import {
  assignRuns, carrierLookUp, inOffsidePosition, LOCAL_TUNING as T, onsideLimitX, pickTriggerRunner, RUN_CALL_TICKS,
  triggerRun,
} from '../../src/ai/runs';
import { assignSupport } from '../../src/ai/support';
import { executeJobs } from '../../src/ai/steer';
import { cloneState } from '../../src/sim/core/clone';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { secondLastDefenderX } from '../../src/sim/core/query';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { isOffsidePosition } from '../../src/sim/rules/offside';
import { makeScenario, runTicks } from '../harness/scenario';

type Spot = [slot: number, role: Role, x: number, z: number];
/** Home 4-4-2 in possession, attacking +x (right flank = +z). */
const HOME: Spot[] = [
  [0, Role.GK, -45, 0],
  [1, Role.RB, 0, 24], [2, Role.CB, -12, 8], [3, Role.CB, -12, -8], [4, Role.LB, 0, -24],
  [5, Role.RM, 12, 25], [6, Role.CM, 6, 6], [7, Role.CM, 8, -5], [8, Role.LM, 12, -25],
  [9, Role.ST, 20, 6], [10, Role.ST, 20, -6],
];
/** Away 4-4-2 defending the goal at +x: back four on x = 24, keeper at 49. */
const AWAY: Spot[] = [
  [11, Role.GK, 49, 0],
  [12, Role.RB, 24, -18], [13, Role.CB, 24, -6], [14, Role.CB, 24, 6], [15, Role.LB, 24, 18],
  [16, Role.RM, 15, -20], [17, Role.CM, 15, -8], [18, Role.CM, 15, 7], [19, Role.LM, 15, 20],
  [20, Role.ST, -5, -10], [21, Role.ST, -5, 10],
];
const BACK4 = [12, 13, 14, 15];
const RUN_JOBS = [AiJob.RUN_IN_BEHIND, AiJob.OVERLAP, AiJob.LATE_RUN];

interface BuildOpts {
  carrier?: number; phase?: TeamPhase; facing?: number; ballAt?: [number, number]; spots?: Spot[];
  /** Human P1 controls the carrier (else the team-0 CPU brain does). */
  human?: boolean;
}

function build(o: BuildOpts = {}): SimState {
  const carrier = o.carrier ?? 7;
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: o.human ? [{ side: 0, slot: carrier }] : 0 });
  const over = new Map((o.spots ?? []).map((sp) => [sp[0], sp]));
  for (const base of [...HOME, ...AWAY]) {
    const [slot, role, x, z] = over.get(base[0]) ?? base;
    const p = s.players[slot]!;
    p.role = role; p.isKeeper = role === Role.GK ? 1 : 0;
    p.x = x; p.z = z; p.homeX = x; p.homeZ = z; p.vx = 0; p.vz = 0;
    p.fx = slot < 11 ? 1 : -1; p.fz = 0;
    p.moveMode = MoveMode.STOP;
  }
  const c = s.players[carrier]!;
  if (o.ballAt) { c.x = o.ballAt[0] - 0.5; c.z = o.ballAt[1]; }
  c.fx = o.facing ?? 1; c.fz = 0;
  setBall(s, carrier);
  if (!o.human) { s.ctrl[2]!.slot = carrier; c.ctrl = 2; }
  s.teams[0]!.phase = o.phase ?? TeamPhase.ATTACK;
  s.teams[1]!.phase = TeamPhase.DEFEND;
  return s;
}

function setBall(s: SimState, owner: number): void {
  const c = s.players[owner]!;
  const b = s.ball;
  b.owner = owner; b.x = c.x + 0.5 * s.teams[c.team]!.dir; b.z = c.z; b.px = b.x; b.pz = b.z; b.y = 0.11;
  b.vx = 0; b.vy = 0; b.vz = 0; b.lastTouch = owner; b.lastTouchTeam = c.team; b.passTarget = -1;
}

function runs(s: SimState, team = 0): void {
  resetJobs(s, team);
  assignRuns(s, team, NULL_SINK);
}

function jobs(s: SimState, job: AiJob, team = 0): number[] {
  const out: number[] = [];
  for (let i = team * 11; i < team * 11 + 11; i++) if (s.players[i]!.job === job) out.push(i);
  return out;
}

function runnerSlots(s: SimState, team = 0): number[] {
  const out: number[] = [];
  for (let i = team * 11; i < team * 11 + 11; i++) if (RUN_JOBS.includes(s.players[i]!.job)) out.push(i);
  return out;
}

const top = (s: SimState, i: number): number => s.attrs[i]!.topSpeed;
const line = (s: SimState): number => secondLastDefenderX(s, 1);

/** Scripted opponent back line: x = lineX (keeper fixed), velocity set so the predicted line is consistent. */
function placeLine(s: SimState, lineX: number, vx: number): void {
  for (const i of BACK4) { const p = s.players[i]!; p.x = lineX; p.vx = vx; p.vz = 0; }
}

interface Drive {
  /** Carrier stick (team 0 attacks +x): DIRECT intent, or null = stand. */
  stick?: [number, number] | null;
  /** Back line x and velocity this tick (scripted after locomotion), or undefined = untouched. */
  backLine?: (tick: number) => [number, number] | undefined;
  /** Also run TAI-02 support before the runs (pipeline order). */
  support?: boolean;
}

/**
 * One tick: TAI-03 (+ optional TAI-02) jobs, TAI-07 steering, the carrier's KICK action timer (dispatch order:
 * AI -> actions -> locomotion), SIM-04 locomotion, ball at the carrier's feet, scripted back line. Returns 1 on
 * the tick the carrier's kick reaches its contact.
 */
function driveTick(s: SimState, d: Drive = {}): number {
  s.tick++;
  resetJobs(s, 0);
  if (d.support) assignSupport(s, 0, NULL_SINK);
  assignRuns(s, 0, NULL_SINK);
  executeJobs(s, 0, NULL_SINK);
  const o = s.ball.owner;
  let contact = 0;
  if (o >= 0) {
    const c = s.players[o]!;
    if (c.act === ActionKind.KICK) {
      c.actT++;
      if (c.actDone === 0 && c.actT >= c.actContact) { c.actDone = 1; contact = 1; }
      c.moveMode = MoveMode.STOP;
    } else if (d.stick) {
      c.moveMode = MoveMode.DIRECT; c.ix = d.stick[0]; c.iz = d.stick[1]; c.wantSprint = 0;
    } else c.moveMode = MoveMode.STOP;
  }
  locomotionTick(s, NULL_SINK);
  if (o >= 0) {
    const c = s.players[o]!;
    s.ball.x = c.x + 0.5 * c.fx; s.ball.z = c.z + 0.5 * c.fz; s.ball.px = s.ball.x; s.ball.pz = s.ball.z;
  }
  const bl = d.backLine?.(s.tick);
  if (bl) placeLine(s, bl[0], bl[1]);
  return contact;
}

function startKick(s: SimState, kind: KickKind, contact: number): void {
  const c = s.players[s.ball.owner]!;
  c.act = ActionKind.KICK; c.actKick = kind; c.actT = 0; c.actContact = contact; c.actDur = contact + 10;
  c.actDone = 0; c.actCharging = 0;
}

/** Every team-0 player with a run job is onside (RUL-08 and the module's own mirror). */
function expectRunnersOnside(s: SimState, where: string): void {
  for (const i of runnerSlots(s)) {
    expect(isOffsidePosition(s, i), `${where}: slot ${i} offside (RUL-08)`).toBe(false);
    expect(inOffsidePosition(s, i), `${where}: slot ${i} offside (own check)`).toBe(false);
  }
}

// =====================================================================================================

describe('TAI-03 runs in behind', () => {
  it('forwards hold on the offside line (launch point, jog) while the carrier does not look up', () => {
    const s = build({ facing: -1 });
    expect(carrierLookUp(s, 0)).toBe(0);
    runs(s);
    const onT = line(s) - T.onsideMargin;
    for (const i of [9, 10]) {
      const p = s.players[i]!;
      expect(p.job).toBe(AiJob.RUN_IN_BEHIND);
      expect(p.tgtX).toBeCloseTo(onT - T.launchDepth, 9);
      expect(p.tgtZ).toBeCloseTo(p.homeZ, 9);
      expect(p.tgtSpeed).toBeCloseTo(top(s, i) * T.speedHold, 9);
      expect(p.tgtX).toBeLessThan(onsideLimitX(s, 0));
    }
  });

  it('the carrier looking up (facing forward, not pressed) starts the runs: sprint to the line in the gaps between defenders (curved runs)', () => {
    const s = build();
    expect(carrierLookUp(s, 0)).toBe(2);
    runs(s);
    const ib = jobs(s, AiJob.RUN_IN_BEHIND);
    expect(ib).toEqual(expect.arrayContaining([9, 10]));
    const lanes: number[] = [];
    for (const i of ib) {
      const p = s.players[i]!;
      expect(p.tgtX).toBeCloseTo(line(s) - T.onsideMargin, 9);
      expect(p.tgtSpeed).toBeCloseTo(top(s, i), 9);
      // In a gap: at least minGap/2 from every back-line defender laterally.
      for (const d of BACK4) expect(Math.abs(p.tgtZ - s.players[d]!.z)).toBeGreaterThanOrEqual(T.minGap / 2);
      lanes.push(p.tgtZ);
    }
    // Strikers bend across the line into different gaps, not straight at a defender.
    expect(s.players[9]!.tgtZ).not.toBeCloseTo(s.players[9]!.z, 3);
    for (let a = 0; a < lanes.length; a++) for (let b = a + 1; b < lanes.length; b++) {
      expect(Math.abs(lanes[a]! - lanes[b]!)).toBeGreaterThanOrEqual(T.laneSep - 1e-9);
    }
  });

  it('a pressed carrier does not look up: runners wait at the launch point', () => {
    const s = build();
    const c = s.players[7]!;
    s.players[17]!.x = c.x + 1.5; s.players[17]!.z = c.z; // opponent 1.5 m away
    expect(carrierLookUp(s, 0)).toBe(0);
    runs(s);
    expect(s.players[9]!.tgtX).toBeCloseTo(line(s) - T.onsideMargin - T.launchDepth, 9);
  });

  it('a runner already on his way keeps running on the relaxed look-up (no stop-start at the threshold)', () => {
    const s = build();
    s.players[17]!.x = s.players[7]!.x + 3; s.players[17]!.z = s.players[7]!.z; // 3 m: under lookUpSpace, over commit
    expect(carrierLookUp(s, 0)).toBe(1);
    s.players[9]!.vx = 4; // ST 9 is running
    runs(s);
    expect(s.players[9]!.tgtX).toBeCloseTo(line(s) - T.onsideMargin, 9);
    expect(s.players[10]!.tgtX).toBeCloseTo(line(s) - T.onsideMargin - T.launchDepth, 9); // ST 10 standing: waits
  });

  it('offside switched off: no onside clamp, runners go straight in behind', () => {
    const s = build();
    s.config = { ...s.config, offside: 0 };
    runs(s);
    for (const i of [9, 10]) {
      expect(s.players[i]!.job).toBe(AiJob.RUN_IN_BEHIND);
      expect(s.players[i]!.tgtX).toBeCloseTo(line(s) + T.behindDepth, 9);
    }
    expect(inOffsidePosition(s, 9)).toBe(false);
  });

  it('no run in behind when there is no space behind the line (line at the goal area)', () => {
    const s = build();
    placeLine(s, 44, 0);
    runs(s);
    expect(jobs(s, AiJob.RUN_IN_BEHIND)).toEqual([]);
  });

  it('no run in behind when the carrier is out of through-ball range', () => {
    const s = build({ carrier: 2, ballAt: [-30, 8] });
    runs(s);
    expect(jobs(s, AiJob.RUN_IN_BEHIND)).toEqual([]);
  });

  it('no runs when the opponents have the ball or the ball is loose and not our pass', () => {
    const s = build();
    setBall(s, 17);
    runs(s);
    expect(runnerSlots(s)).toEqual([]);
    const s2 = build();
    s2.ball.owner = -1; s2.ball.lastKickTeam = 1; s2.ball.lastTouchTeam = 1;
    runs(s2);
    expect(runnerSlots(s2)).toEqual([]);
  });

  it('release: a runner who cannot reach the line before the contact goes beyond it; one who could is held', () => {
    const s = build();
    const L = line(s);
    s.players[9]!.x = 15; s.players[9]!.vx = 8; // far enough back even flat out
    s.players[10]!.x = L - 1.2; s.players[10]!.vx = 8; // would cross before the contact
    startKick(s, KickKind.THROUGH_GROUND, 10);
    runs(s);
    const behindU = Math.min(L + T.behindDepth, HALF_LENGTH - T.behindGoalMargin);
    expect(s.players[9]!.tgtX).toBeCloseTo(behindU, 9);
    // Curved: the lane bends in toward goal behind the line.
    expect(Math.abs(s.players[9]!.tgtZ)).toBeLessThanOrEqual(Math.abs(s.players[9]!.z) + 1e-9);
    expect(s.players[10]!.tgtX).toBeLessThanOrEqual(L - T.onsideMargin + 1e-9);
    // Charging (contact unknown): nobody is released.
    const s2 = build();
    s2.players[9]!.x = 15; s2.players[9]!.vx = 8;
    startKick(s2, KickKind.THROUGH_GROUND, 10);
    s2.players[7]!.actCharging = 1;
    runs(s2);
    expect(s2.players[9]!.tgtX).toBeLessThanOrEqual(line(s2) - T.onsideMargin + 1e-9);
  });

  it('runners stay onside until the pass while the line steps up and drops, and burst at the contact', () => {
    const s = build({ facing: -1 });
    // Line oscillates between x = 21 and x = 27 at 4 m/s (stepping up and dropping), the carrier turns to
    // face forward at tick 120, and plays a through ball (10-tick wind-up) at tick 150.
    const backLine = (t: number): [number, number] => {
      const ph = t % 180;
      return ph < 90 ? [27 - (ph / 90) * 6, -4] : [21 + ((ph - 90) / 90) * 6, 4];
    };
    let contactAt = -1;
    const vx0: number[] = [];
    for (let k = 0; k < 400 && contactAt < 0; k++) {
      if (k === 120) s.players[7]!.fx = 1;
      if (k === 150) { startKick(s, KickKind.THROUGH_GROUND, 10); vx0.push(s.players[9]!.vx, s.players[10]!.vx); }
      const hit = driveTick(s, { stick: k < 120 ? null : [0.25, 0], backLine });
      expectRunnersOnside(s, `tick ${k}`);
      if (hit) contactAt = k;
    }
    expect(contactAt).toBe(159);
    // Released during the wind-up: target beyond the line, accelerating forward into the contact.
    const L = line(s);
    [9, 10].forEach((i, n) => {
      const p = s.players[i]!;
      expect(p.job).toBe(AiJob.RUN_IN_BEHIND);
      expect(p.tgtX).toBeGreaterThan(L);
      expect(p.vx).toBeGreaterThan(vx0[n]! + 0.5);
      expect(p.vx).toBeGreaterThan(3);
    });
  });

  it('timed run against a static line: at the contact the runner is on the line, onside, moving forward', () => {
    for (const [kickAt, near] of [[30, 4.5], [120, 2.5]]) { // mid-run, and after waiting on the line
      const s = build();
      let hit = 0;
      for (let k = 0; k < kickAt + 12 && hit === 0; k++) {
        if (k === kickAt) startKick(s, KickKind.THROUGH_GROUND, 10);
        hit = driveTick(s, { stick: [0.2, 0] });
        expectRunnersOnside(s, `kick at ${kickAt}, tick ${k}`);
      }
      expect(hit).toBe(1);
      const L = line(s);
      for (const i of [9, 10]) {
        const p = s.players[i]!;
        expect(L - p.x, `kick at ${kickAt}: slot ${i} distance to the line`).toBeLessThan(near!);
        expect(p.vx, `kick at ${kickAt}: slot ${i} forward speed`).toBeGreaterThan(0.5);
      }
    }
  });

  it('runners released during a wind-up are onside at the contact for every wind-up length', () => {
    for (const windup of [1, 3, 6, 8, 12, 20, 30]) {
      for (const delay of [0, 10, 25, 60]) {
        const s = build({ facing: 1 });
        let contact = 0;
        for (let k = 0; k < delay + windup + 2 && contact === 0; k++) {
          if (k === delay) startKick(s, KickKind.THROUGH_GROUND, windup);
          contact = driveTick(s, { stick: [0.2, 0] });
        }
        expect(contact).toBe(1);
        expectRunnersOnside(s, `windup ${windup} delay ${delay}`);
      }
    }
  });

  it('mirrors exactly by team.dir (team attacking -x)', () => {
    const a = build();
    const b = build();
    b.teams[0]!.dir = -1; b.teams[1]!.dir = 1;
    for (const p of b.players) { p.x = -p.x; p.z = -p.z; p.homeX = -p.homeX; p.homeZ = -p.homeZ; p.fx = -p.fx; p.fz = -p.fz; p.vx = -p.vx; p.vz = -p.vz; }
    b.ball.x = -b.ball.x; b.ball.z = -b.ball.z; b.ball.px = b.ball.x; b.ball.pz = b.ball.z;
    for (const s of [a, b]) runs(s);
    for (let i = 0; i < 11; i++) {
      const pa = a.players[i]!, pb = b.players[i]!;
      expect(pb.job).toBe(pa.job);
      if (pa.job === AiJob.NONE) continue;
      expect(pb.tgtX).toBeCloseTo(-pa.tgtX, 12);
      expect(pb.tgtZ).toBeCloseTo(-pa.tgtZ, 12);
      expect(pb.tgtSpeed).toBe(pa.tgtSpeed);
    }
    expect(runnerSlots(a).length).toBeGreaterThan(0);
  });

  it('team 1 runs too (attacking -x, mirrored scene)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
    // Mirror of the home scene for team 1: slots swapped, coordinates negated.
    for (const [slot, role, x, z] of [...HOME, ...AWAY]) {
      const ms = slot < 11 ? slot + 11 : slot - 11;
      const p = s.players[ms]!;
      p.role = role; p.isKeeper = role === Role.GK ? 1 : 0; p.x = -x; p.z = -z; p.homeX = -x; p.homeZ = -z;
      p.vx = 0; p.vz = 0; p.fx = ms >= 11 ? -1 : 1; p.fz = 0;
    }
    setBall(s, 18);
    s.teams[1]!.phase = TeamPhase.ATTACK;
    resetJobs(s, 1);
    assignRuns(s, 1, NULL_SINK);
    const ib = jobs(s, AiJob.RUN_IN_BEHIND, 1);
    expect(ib).toEqual(expect.arrayContaining([20, 21]));
    for (const i of ib) expect(s.players[i]!.tgtX).toBeCloseTo(secondLastDefenderX(s, 0) + T.onsideMargin, 9);
  });
});

describe('TAI-03 overlaps', () => {
  /** RM on the ball wide on the right, RB behind him, RCB covering. */
  function overlapScene(extra: Spot[] = []): SimState {
    return build({ carrier: 5, spots: [[5, Role.RM, 20, 26], [1, Role.RB, 5, 22], [2, Role.CB, -8, 10], ...extra] });
  }

  it('the full-back overlaps outside and beyond the carrier when a teammate covers behind him', () => {
    const s = overlapScene();
    runs(s);
    const p = s.players[1]!;
    expect(p.job).toBe(AiJob.OVERLAP);
    const ball = s.ball;
    expect(p.tgtZ).toBeGreaterThan(ball.z); // outside
    expect(p.tgtX).toBeGreaterThan(ball.x); // beyond
    expect(p.tgtX).toBeLessThanOrEqual(onsideLimitX(s, 0) - T.onsideMargin + 1e-9);
    expect(p.tgtSpeed).toBeCloseTo(top(s, 1), 9);
  });

  it('no overlap without cover behind the full-back', () => {
    const s = overlapScene([[2, Role.CB, -8, -14], [6, Role.CM, 6, -2]]);
    runs(s);
    expect(s.players[1]!.job).not.toBe(AiJob.OVERLAP);
  });

  it('no overlap when the ball is not in the wide channel', () => {
    const s = overlapScene([[5, Role.RM, 20, 6]]);
    runs(s);
    expect(s.players[1]!.job).not.toBe(AiJob.OVERLAP);
  });

  it('no overlap when it would leave fewer than the rest defenders behind the ball', () => {
    // Only RB, CB 2 and CB 3 behind the ball: restDefenders (4) already unmet.
    const s = overlapScene([[4, Role.LB, 25, -24], [6, Role.CM, 25, 6], [8, Role.LM, 30, -25]]);
    s.players[7]!.x = 25;
    runs(s);
    expect(s.players[1]!.job).not.toBe(AiJob.OVERLAP);
  });

  it('a full-back who has gone past the carrier keeps the overlap (committed) and settles ahead of him', () => {
    const s = overlapScene();
    placeLine(s, 32, 0); // room ahead of the winger
    for (let k = 0; k < 240; k++) driveTick(s, { stick: [0.15, 0] });
    const p = s.players[1]!;
    expect(p.job).toBe(AiJob.OVERLAP);
    expect(p.x).toBeGreaterThan(s.ball.x);
    expect(p.z).toBeGreaterThan(s.ball.z);
    expectRunnersOnside(s, 'after the overlap');
  });
});

describe('TAI-03 late runs into the box on crosses', () => {
  /** RM on the ball in the crossing zone; back line dropped into the box. */
  function crossScene(rmX: number, extra: Spot[] = []): SimState {
    const s = build({
      carrier: 5,
      spots: [[5, Role.RM, rmX, 24], [9, Role.ST, 38, 4], [10, Role.ST, 38, -5], [6, Role.CM, 22, 4], [7, Role.CM, 20, -6], ...extra],
    });
    for (const [i, z] of [[12, -15], [13, -5], [14, 5], [15, 15]] as const) { s.players[i]!.x = 44; s.players[i]!.z = z; }
    return s;
  }
  const inBox = (x: number, z: number): boolean => x >= HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH;

  it('cross imminent (ball near the byline): midfielders LATE_RUN into the box at sprint, forwards attack the posts', () => {
    const s = crossScene(43);
    runs(s);
    const late = jobs(s, AiJob.LATE_RUN);
    expect(late.length).toBeGreaterThan(0);
    for (const i of late) {
      const p = s.players[i]!;
      expect([Role.CM, Role.CAM, Role.LM, Role.RM]).toContain(p.role);
      expect(inBox(p.tgtX, p.tgtZ)).toBe(true);
      expect(p.tgtSpeed).toBeCloseTo(top(s, i), 9);
      expect(p.tgtX).toBeLessThanOrEqual(onsideLimitX(s, 0) - T.onsideMargin + 1e-9);
    }
    expect(jobs(s, AiJob.RUN_IN_BEHIND)).toEqual(expect.arrayContaining([9, 10]));
    expect(runnerSlots(s).length).toBe(T.boxRunnersDefault);
  });

  it('before the cross is imminent, late runners stage outside the box at jog (arrive late)', () => {
    const s = crossScene(30);
    runs(s);
    const late = jobs(s, AiJob.LATE_RUN);
    expect(late.length).toBeGreaterThan(0);
    for (const i of late) {
      const p = s.players[i]!;
      expect(p.tgtX).toBeCloseTo(HALF_LENGTH - T.lateStageDepth, 9);
      expect(p.tgtSpeed).toBeCloseTo(top(s, i) * T.speedHold, 9);
    }
  });

  it('a cross in the wind-up makes the late run go', () => {
    const s = crossScene(30);
    startKick(s, KickKind.CROSS, 10);
    runs(s);
    for (const i of jobs(s, AiJob.LATE_RUN)) expect(inBox(s.players[i]!.tgtX, s.players[i]!.tgtZ)).toBe(true);
  });

  it('cross in flight: box runners attack their spots (no onside clamp after the cross is played)', () => {
    const s = crossScene(43);
    const b = s.ball;
    b.owner = -1; b.lastKickTeam = 0; b.lastTouchTeam = 0; b.lastKickBy = 5; b.lastKickKind = KickKind.CROSS;
    b.passTarget = 9; b.passX = 47; b.passZ = 2; b.vx = -5; b.vz = -20; b.y = 2;
    runs(s);
    const late = jobs(s, AiJob.LATE_RUN);
    expect(late.length).toBeGreaterThan(0);
    for (const i of late) expect(inBox(s.players[i]!.tgtX, s.players[i]!.tgtZ)).toBe(true);
    expect(s.players[9]!.job).not.toBe(AiJob.RUN_IN_BEHIND); // the intended receiver is TAI-07/TAI-14's
  });

  it('GET_IN_BOX sends four box runners', () => {
    const s = crossScene(43);
    s.teams[0]!.getInBox = 1;
    runs(s);
    expect(runnerSlots(s).length).toBe(4);
  });

  it('a late runner arrives in the box over time', () => {
    const s = crossScene(43);
    for (let k = 0; k < 150; k++) driveTick(s, { stick: null });
    const late = jobs(s, AiJob.LATE_RUN);
    expect(late.length).toBeGreaterThan(0);
    for (const i of late) expect(inBox(s.players[i]!.x, s.players[i]!.z)).toBe(true);
    expectRunnersOnside(s, 'box');
  });
});

describe('TAI-03 runner budget', () => {
  it('at most 3 runners by default, 2 with the defending focus, 3 (hard cap) with the attacking focus', () => {
    for (const [focus, max] of [[TacticalFocus.DEFAULT, 3], [TacticalFocus.DEFENDING, 2], [TacticalFocus.ATTACKING, 3]] as const) {
      const s = build({ carrier: 5, spots: [[5, Role.RM, 20, 26], [1, Role.RB, 5, 22], [2, Role.CB, -8, 10], [8, Role.LM, 12, -20]] });
      s.teams[0]!.focus = focus;
      runs(s);
      expect(runnerSlots(s).length, `focus ${focus}`).toBe(max);
    }
  });

  it('a midfielder running in behind from behind the ball respects the rest defence', () => {
    // Run candidates: ST 9 and the CAM (behind the ball). Behind the ball: CB 2, CB 3 and the CAM only
    // (restDefenders = 4), so the CAM must stay; with both full-backs back as well, he may go.
    const spots: Spot[] = [[6, Role.CAM, 9, 8], [1, Role.RB, 14, 24], [4, Role.LB, 14, -24], [5, Role.CM, 16, 25],
      [8, Role.CM, 16, -25], [10, Role.CM, 21, -6]];
    const s = build({ spots, ballAt: [12, -2] });
    runs(s);
    expect(s.players[9]!.job).toBe(AiJob.RUN_IN_BEHIND);
    expect(s.players[6]!.job).not.toBe(AiJob.RUN_IN_BEHIND);
    const s2 = build({ spots: [...spots, [1, Role.RB, 0, 24], [4, Role.LB, 0, -24]], ballAt: [12, -2] });
    runs(s2);
    expect(s2.players[6]!.job).toBe(AiJob.RUN_IN_BEHIND);
  });

  it('runner jobs another module gave this tick (TAI-06 counters) count toward the budget and are left alone', () => {
    const s = build();
    resetJobs(s, 0);
    assignJob(s, 8, AiJob.RUN_IN_BEHIND, 30, -20, 9, -1);
    assignJob(s, 5, AiJob.RUN_IN_BEHIND, 30, 20, 9, -1);
    assignRuns(s, 0, NULL_SINK);
    expect(runnerSlots(s).length).toBe(3);
    expect(s.players[8]!.tgtX).toBe(30);
    expect(s.players[5]!.tgtX).toBe(30);
  });

  it('a supporter whose role prefers support (CF) stays a supporter; a striker is turned into a runner', () => {
    const s = build({ spots: [[10, Role.CF, 20, -6]] });
    resetJobs(s, 0);
    assignJob(s, 10, AiJob.SUPPORT, 12, -10, 5, 7);
    assignJob(s, 9, AiJob.SUPPORT, 12, 10, 5, 7);
    assignRuns(s, 0, NULL_SINK);
    expect(s.players[10]!.job).toBe(AiJob.SUPPORT);
    expect(s.players[9]!.job).toBe(AiJob.RUN_IN_BEHIND);
  });

  it('with TAI-02 support in the pipeline the in-possession jobs stay consistent over time', () => {
    const s = build();
    for (let k = 0; k < 120; k++) {
      driveTick(s, { stick: [0.2, 0], support: true });
      expect(runnerSlots(s).length).toBeLessThanOrEqual(3);
      expectRunnersOnside(s, `tick ${k}`);
    }
  });
});

describe('TAI-03 trigger run', () => {
  it('the best-placed forward runs in behind immediately, even while the carrier does not look up', () => {
    const s = build({ facing: -1 });
    s.players[10]!.x = 10; // ST 10 further from the line: ST 9 is better placed
    expect(pickTriggerRunner(s, 0)).toBe(9);
    triggerRun(s, 0, NULL_SINK);
    expect(s.teams[0]!.runSlot).toBe(9);
    expect(s.teams[0]!.runCallT).toBe(RUN_CALL_TICKS);
    runs(s);
    const p = s.players[9]!;
    expect(p.job).toBe(AiJob.RUN_IN_BEHIND);
    expect(p.tgtX).toBeGreaterThan(line(s)); // in behind: overrides holding
    expect(p.tgtSpeed).toBeCloseTo(top(s, 9), 9);
    // Over the next second he gets beyond the line (the human times the pass).
    for (let k = 0; k < 90; k++) driveTick(s);
    expect(s.players[9]!.x).toBeGreaterThan(line(s));
  });

  it('lasts runCallSeconds and is then cleared', () => {
    const s = build({ facing: -1 });
    triggerRun(s, 0, NULL_SINK);
    const r = s.teams[0]!.runSlot;
    expect([9, 10]).toContain(r);
    for (let k = 0; k < RUN_CALL_TICKS - 1; k++) driveTick(s);
    expect(s.teams[0]!.runSlot).toBe(r);
    driveTick(s);
    expect(s.teams[0]!.runSlot).toBe(-1);
    expect(s.teams[0]!.runCallT).toBe(0);
  });

  it('is cancelled when the opponents win the ball, and when the runner receives it', () => {
    const s = build();
    triggerRun(s, 0, NULL_SINK);
    setBall(s, 17);
    runs(s);
    expect(s.teams[0]!.runSlot).toBe(-1);
    const s2 = build();
    triggerRun(s2, 0, NULL_SINK);
    const r = s2.teams[0]!.runSlot;
    s2.players[7]!.ctrl = -1; s2.ctrl[2]!.slot = r; s2.players[r]!.ctrl = 2;
    setBall(s2, r);
    runs(s2);
    expect(s2.teams[0]!.runSlot).toBe(-1);
  });

  it('does nothing outside IN_PLAY or without the ball', () => {
    const s = build();
    s.match.phase = MatchPhase.THROW_IN;
    triggerRun(s, 0, NULL_SINK);
    expect(s.teams[0]!.runSlot).toBe(-1);
    const s2 = build();
    setBall(s2, 17);
    triggerRun(s2, 0, NULL_SINK);
    expect(s2.teams[0]!.runSlot).toBe(-1);
  });

  it('through the real input path: a human L1 tap on the ball triggers the run (SIM-15 -> triggerRun)', () => {
    const s = build({ human: true });
    expect(s.players[7]!.ctrl).toBe(0);
    let n = 0;
    runTicks(s, 4, (_t, _st, out) => { if (n++ < 3) out[0]!.buttons = Btn.MOD_L; });
    expect([9, 10]).toContain(s.teams[0]!.runSlot);
    expect(s.teams[0]!.runCallT).toBeGreaterThan(RUN_CALL_TICKS - 3);
  });
});

describe('TAI-03 pass and go', () => {
  /** CM 7 just played a pass-and-go ball to ST 10 (in flight). */
  function passGoScene(): SimState {
    const s = build();
    const b = s.ball;
    b.owner = -1; b.lastKickTeam = 0; b.lastTouchTeam = 0; b.lastKickBy = 7; b.lastKickKind = KickKind.GROUND_PASS;
    b.lastKickTick = s.tick; b.passTarget = 10; b.passX = 19; b.passZ = -6; b.vx = 12; b.vz = -0.5;
    s.players[7]!.ctrl = -1; s.ctrl[2]!.slot = 10; s.players[10]!.ctrl = 2; // control moved to the receiver
    s.teams[0]!.passGoSlot = 7; s.teams[0]!.passGoT = 120;
    return s;
  }

  it('the passer sprints forward, away from the receiver, staying onside for the return pass', () => {
    const s = passGoScene();
    runs(s);
    const p = s.players[7]!;
    expect(p.job).toBe(AiJob.RUN_IN_BEHIND);
    expect(p.tgtX).toBeGreaterThan(p.x + 5);
    expect(p.tgtX).toBeLessThanOrEqual(Math.max(line(s), s.ball.passX) - T.onsideMargin + 1e-9);
    expect(p.tgtSpeed).toBeCloseTo(top(s, 7), 9);
    expect(s.teams[0]!.passGoT).toBe(119);
  });

  it('counts down and clears after passGoT ticks; cancelled when the passer receives the ball', () => {
    const s = passGoScene();
    for (let k = 0; k < 120; k++) { s.tick++; runs(s); }
    expect(s.teams[0]!.passGoSlot).toBe(-1);
    expect(s.teams[0]!.passGoT).toBe(0);
    const s2 = passGoScene();
    setBall(s2, 7);
    runs(s2);
    expect(s2.teams[0]!.passGoSlot).toBe(-1);
  });

  it('requests from before a stoppage are dropped on the first IN_PLAY tick', () => {
    const s = build();
    s.teams[0]!.runSlot = 9; s.teams[0]!.runCallT = 40;
    s.teams[0]!.passGoSlot = 6; s.teams[0]!.passGoT = 50;
    s.match.prevPhase = MatchPhase.THROW_IN; s.match.phaseT = 1;
    s.ball.lastKickBy = 4;
    runs(s);
    expect(s.teams[0]!.runSlot).toBe(-1);
    expect(s.teams[0]!.passGoSlot).toBe(-1);
    // A pass and go played as the restart kick itself survives.
    const s2 = build();
    s2.teams[0]!.passGoSlot = 7; s2.teams[0]!.passGoT = 120;
    s2.match.prevPhase = MatchPhase.FREE_KICK; s2.match.phaseT = 1;
    s2.ball.lastKickBy = 7;
    s2.players[7]!.ctrl = -1; s2.ctrl[2]!.slot = 6; s2.players[6]!.ctrl = 2; setBall(s2, 6);
    runs(s2);
    expect(s2.teams[0]!.passGoSlot).toBe(7);
    expect(s2.players[7]!.job).toBe(AiJob.RUN_IN_BEHIND);
  });
});

describe('TAI-03 determinism and glitch regressions', () => {
  /** Per-tick trace of what this module and the movement write. */
  function trace(s: SimState): number[] {
    const out = [s.teams[0]!.runSlot, s.teams[0]!.runCallT, s.teams[0]!.passGoSlot, s.teams[0]!.passGoT];
    for (let i = 0; i < 22; i++) { const p = s.players[i]!; out.push(p.job, p.tgtX, p.tgtZ, p.tgtSpeed, p.x, p.z); }
    return out;
  }
  const backLine = (t: number): [number, number] => [24 + ((t * 7) % 40) / 10 - 2, 0.5];

  it('deterministic: a clone run interleaved with another match gives bit-identical traces and hashes', () => {
    const a = build();
    const b = cloneState(a);
    const other = build({ carrier: 5, spots: [[5, Role.RM, 43, 24]] });
    triggerRun(a, 0, NULL_SINK); triggerRun(b, 0, NULL_SINK);
    for (let k = 0; k < 300; k++) {
      if (k === 200) { startKick(a, KickKind.THROUGH_GROUND, 9); startKick(b, KickKind.THROUGH_GROUND, 9); }
      driveTick(a, { stick: [0.2, 0.05], backLine });
      driveTick(other, { stick: [0.1, 0] });
      driveTick(b, { stick: [0.2, 0.05], backLine });
      expect(trace(b)).toEqual(trace(a));
    }
    expect(hashState(b)).toBe(hashState(a));
  });

  it('Players: orbit or jitter around a target - a runner holding the line settles without jitter', () => {
    const s = build({ facing: -1 });
    for (let k = 0; k < 180; k++) driveTick(s);
    const x0 = s.players[9]!.x, z0 = s.players[9]!.z;
    let maxD = 0;
    for (let k = 0; k < 240; k++) {
      driveTick(s);
      maxD = Math.max(maxD, Math.hypot(s.players[9]!.x - x0, s.players[9]!.z - z0));
    }
    expect(s.players[9]!.job).toBe(AiJob.RUN_IN_BEHIND);
    expect(maxD).toBeLessThan(0.01);
    expect(Math.hypot(s.players[9]!.vx, s.players[9]!.vz)).toBeLessThan(0.01);
  });

  it('through the real step pipeline: runs are assigned, invariants (core) hold, state stays finite', () => {
    const s = build();
    s.match.periodT = 600;
    let seen = 0;
    runTicks(s, 240, undefined, {
      check: 'core',
      until: (st) => { if (runnerSlots(st).length > 0) seen++; return false; },
    });
    expect(seen).toBeGreaterThan(0);
    for (const p of s.players) { expect(Number.isFinite(p.tgtX)).toBe(true); expect(Number.isFinite(p.tgtZ)).toBe(true); }
    // ai/index wiring: one teamAiTick on a fresh scene gives the same runner jobs as calling the module directly.
    const a = build(), b = build();
    a.tick++; b.tick++;
    teamAiTick(a, NULL_SINK);
    runs(b);
    for (const i of [9, 10]) expect(a.players[i]!.job).toBe(b.players[i]!.job);
  });
});
