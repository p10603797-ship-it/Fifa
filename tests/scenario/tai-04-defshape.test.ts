/**
 * TAI-04 scenarios: defensive shape and back-line control. The defending side runs the real team-AI stages that
 * shape it (TAI-01 updateShape -> jobs.resetJobs -> TAI-07 assignChaser -> TAI-04 assignDefensiveShape -> TAI-07
 * executeJobs) and the real SIM-04 locomotion; the attacking side and the ball are scripted, so the tests do not
 * depend on modules that are still stubs (TAI-05 press, TAI-06 phase, RUL-08 offside, CPU brains).
 * Every scenario is written in the defending team's frame (u toward the opposition goal, v = dir * z) and runs for
 * both attack directions.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { GOAL_AREA_DEPTH, HALF_LENGTH, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { AiJob, FormationId, MatchPhase, TeamPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { resetJobs } from '../../src/ai/jobs';
import { updateShape } from '../../src/ai/shape';
import { assignChaser, executeJobs } from '../../src/ai/steer';
import {
  assignDefensiveShape, backLineSlots, defensiveLineTarget, DEFSHAPE_TUNING as LT, isDefending,
} from '../../src/ai/defshape';
import { ShapeLine, slotLine } from '../../src/data/formations';
import { QUICK_TACTICS } from '../../src/data/tactics';
import { cloneState } from '../../src/sim/core/clone';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario, runTicks } from '../harness/scenario';
import { rngChance, rngFloat, rngInt, rngSeed } from '../../src/sim/core/rng';
import { secondLastDefenderX as secondLast } from '../../src/sim/core/query';

const HL = HALF_LENGTH;

/** An opponent placed in the defending team's frame: formation index k, position, velocity, facing. */
interface OppSpot { k: number; u: number; v: number; vu?: number; vv?: number; fu?: number; fv?: number }

interface RigOpts {
  def: 0 | 1;
  form?: FormationId;
  oppForm?: FormationId;
  offside?: 0 | 1;
  trap?: 0 | 1;
  seed?: number;
}

/** Test rig: defending team `def` run by the real AI stages; the other team and the ball are scripted. */
class Rig {
  readonly s: SimState;
  readonly def: number;
  readonly opp: number;
  readonly dir: number;
  /** Scripted opponents (frame coordinates), re-applied before every tick. */
  opps: OppSpot[] = [];
  /** Ball owner (opponent formation index) or -1 for a scripted loose ball. */
  ownerK = -1;
  ball = { u: 0, v: 0, vu: 0, vv: 0 };

  constructor(o: RigOpts) {
    this.s = makeScenario({
      seed: o.seed ?? 5, phase: MatchPhase.IN_PLAY, humans: 0,
      config: { homeFormation: o.def === 0 ? o.form ?? FormationId.F442 : o.oppForm ?? FormationId.F442,
        awayFormation: o.def === 1 ? o.form ?? FormationId.F442 : o.oppForm ?? FormationId.F442, offside: o.offside ?? 1 },
    });
    this.def = o.def;
    this.opp = 1 - o.def;
    this.dir = this.s.teams[this.def]!.dir;
    const t = this.s.teams[this.def]!;
    t.offsideTrap = o.trap ?? 0;
    t.phase = TeamPhase.DEFEND;
    this.s.teams[this.opp]!.phase = TeamPhase.ATTACK;
    // Opponents parked deep in their own half unless scripted.
    for (let k = 0; k < PLAYERS_PER_TEAM; k++) {
      const p = this.oppP(k);
      const [x, z] = this.w(k === 0 ? 50 : 30 + (k % 3) * 4, -25 + k * 5);
      p.x = x; p.z = z; p.vx = 0; p.vz = 0; p.moveMode = MoveMode.STOP;
    }
    // Our keeper on his line area; outfielders on their neutral formation spots.
    const kp = this.defP(0);
    [kp.x, kp.z] = this.w(-49, 0);
  }

  /** Frame -> world. */
  w(u: number, v: number): [number, number] { return [this.dir * u + 0, this.dir * v + 0]; }
  u(x: number): number { return this.dir * x; }
  v(z: number): number { return this.dir * z; }
  defSlot(k: number): number { return teamFirstSlot(this.def) + k; }
  oppSlot(k: number): number { return teamFirstSlot(this.opp) + k; }
  defP(k: number) { return this.s.players[this.defSlot(k)]!; }
  oppP(k: number) { return this.s.players[this.oppSlot(k)]!; }
  lineU(): number { return this.dir * this.s.teams[this.def]!.lineX; }

  /** Apply the script (opponents + ball) to the state. */
  applyScript(): void {
    const s = this.s;
    for (const o of this.opps) {
      const p = this.oppP(o.k);
      [p.x, p.z] = this.w(o.u, o.v);
      [p.vx, p.vz] = this.w(o.vu ?? 0, o.vv ?? 0);
      const fu = o.fu ?? -1, fv = o.fv ?? 0;
      const fl = Math.sqrt(fu * fu + fv * fv) || 1;
      [p.fx, p.fz] = this.w(fu / fl, fv / fl);
      p.moveMode = MoveMode.STOP;
    }
    const b = s.ball;
    if (this.ownerK >= 0) {
      const p = this.oppP(this.ownerK);
      b.owner = this.oppSlot(this.ownerK);
      b.x = p.x; b.z = p.z; b.vx = p.vx; b.vz = p.vz;
    } else {
      b.owner = -1;
      [b.x, b.z] = this.w(this.ball.u, this.ball.v);
      [b.vx, b.vz] = this.w(this.ball.vu, this.ball.vv);
    }
    b.heldBy = -1;
    b.y = 0.11; b.vy = 0; b.grounded = 1;
    b.px = b.x; b.pz = b.z; b.py = b.y;
  }

  /** One tick: script, the defending side's AI stages, locomotion. */
  tick(script?: (r: Rig) => void): void {
    const s = this.s;
    s.tick++;
    if (script) script(this);
    this.applyScript();
    updateShape(s, this.def, NULL_SINK);
    resetJobs(s, this.def);
    assignChaser(s, this.def, NULL_SINK);
    assignDefensiveShape(s, this.def, NULL_SINK);
    executeJobs(s, this.def, NULL_SINK);
    locomotionTick(s, NULL_SINK);
  }

  run(n: number, script?: (r: Rig) => void): void { for (let i = 0; i < n; i++) this.tick(script); }

  /** Back-line slots (formation DEF line). */
  back(): number[] {
    const out: number[] = [];
    const n = backLineSlots(this.s, this.def, out);
    return out.slice(0, n);
  }

  /** Frame u of back-liners whose final job is line keeping (HOLD_SHAPE) or marking. */
  backU(): number[] {
    return this.back().filter((i) => {
      const j = this.s.players[i]!.job;
      return j === AiJob.HOLD_SHAPE || j === AiJob.MARK;
    }).map((i) => this.u(this.s.players[i]!.x));
  }
}

function sd(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length);
}
function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length; }

/** A settled-defence picture: opponent carrier in midfield, two strikers in front of the line, wide players. */
function settledOpps(r: Rig): void {
  r.opps = [
    { k: 6, u: -4, v: 4, fu: 0, fv: 1 },
    { k: 9, u: -20, v: 7 },
    { k: 10, u: -20, v: -7 },
    { k: 5, u: -12, v: 24 },
    { k: 8, u: -12, v: -24 },
    { k: 7, u: -6, v: -6 },
  ];
  r.ownerK = 6;
}


const DIRS = [0, 1] as const;
const FORMS = [FormationId.F442, FormationId.F433, FormationId.F4231, FormationId.F352, FormationId.F532, FormationId.F41212];

/** Frame u of the defending team's offside line (second-last player incl. keeper). */
function offsideLineU(r: Rig): number { return r.dir * secondLast(r.s, r.def); }

/** True if opponent formation index k is in an offside position (beyond the second-last defender and the ball, in
 *  our half), judged as RUL-08 would at the moment of a pass. */
function inOffsidePosition(r: Rig, k: number): boolean {
  const ua = r.u(r.oppP(k).x);
  return ua < offsideLineU(r) && ua < r.u(r.s.ball.x) && ua < 0;
}

/**
 * Script a pass by opponent `fromK` to opponent `toK` at `speed` m/s: the ball travels in a straight line (kick
 * bookkeeping as sim/core/kick.ts applyKick would leave it) and the receiver takes it on arrival. Returns the
 * frame line u after every tick of the flight; the receiver owns the ball when it returns.
 */
function playPass(r: Rig, fromK: number, toK: number, speed: number): number[] {
  const s = r.s;
  const from = r.opps.find((o) => o.k === fromK)!;
  const to = r.opps.find((o) => o.k === toK)!;
  const du = to.u - from.u, dv = to.v - from.v;
  const dl = Math.sqrt(du * du + dv * dv);
  r.ownerK = -1;
  r.ball = { u: from.u, v: from.v, vu: (du / dl) * speed, vv: (dv / dl) * speed };
  const b = s.ball;
  b.lastKickBy = r.oppSlot(fromK); b.lastKickTeam = r.opp; b.lastKickTick = s.tick + 1;
  b.lastTouch = r.oppSlot(fromK); b.lastTouchTeam = r.opp; b.lastTouchTick = s.tick + 1;
  b.passTarget = r.oppSlot(toK);
  [b.passX, b.passZ] = r.w(to.u, to.v);
  const ticks = Math.round((dl / speed) * 60);
  const trace: number[] = [];
  for (let i = 0; i < ticks; i++) {
    r.tick((rr) => { rr.ball.u += rr.ball.vu / 60; rr.ball.v += rr.ball.vv / 60; });
    trace.push(r.lineU());
  }
  r.ownerK = toK;
  s.ball.passTarget = -1;
  r.applyScript();
  return trace;
}

/** Defending-team frame target of the line for the current state (pure). */
function target(r: Rig): number { return r.dir * defensiveLineTarget(r.s, r.def); }

describe('TAI-04 line flatness (settled defence)', () => {
  for (const def of DIRS) {
    it.each(FORMS)(`formation %i, defending team ${def}: std dev of back-line x < 1.5 m, everybody on the line`, (form) => {
      const r = new Rig({ def, form });
      settledOpps(r);
      r.run(300);
      const us = r.backU();
      expect(us.length).toBeGreaterThanOrEqual(3);
      expect(sd(us)).toBeLessThan(1.5);
      const L = r.lineU();
      expect(L).toBeGreaterThan(-36);
      expect(L).toBeLessThan(-20);
      for (const u of us) {
        expect(u).toBeGreaterThan(L - 0.8);
        expect(u).toBeLessThan(L + LT.maxStepOut + 0.8);
      }
      // team.lineX is the line the back line stands on (ball-side defenders up to `stagger` higher).
      const tgts = r.back().map((i) => r.u(r.s.players[i]!.tgtX));
      expect(Math.min(...tgts)).toBeGreaterThanOrEqual(L - 1e-9);
      expect(Math.min(...tgts)).toBeLessThanOrEqual(L + LT.stagger + 1e-9);
    });
  }
});

describe('TAI-04 back line staggers toward the ball side', () => {
  for (const def of DIRS) {
    it.each([1, -1])(`ball out wide on side %i, defending team ${def}: ball-side defenders up to \`stagger\` above the line, far side on it`, (side) => {
      const r = new Rig({ def });
      // Carrier out wide in midfield, facing across; nobody in the back line's zones, so every back-liner keeps the
      // line (no marking, no chaser for an owned ball) and his target is the line + stagger alone.
      r.opps = [{ k: 6, u: -2, v: 22 * side, fu: 0, fv: -side }];
      r.ownerK = 6;
      r.run(240);
      // Where the settled players stand (real pipeline), before this module's next output is read.
      const stand = new Map(r.back().map((i) => [i, r.u(r.s.players[i]!.x)] as const));
      r.s.tick++;
      resetJobs(r.s, r.def);
      assignChaser(r.s, r.def, NULL_SINK);
      assignDefensiveShape(r.s, r.def, NULL_SINK);
      const L = r.lineU();
      const bv = r.v(r.s.ball.z);
      expect(bv).toBeCloseTo(22 * side, 9);
      const rows = r.back().map((i) => {
        const p = r.s.players[i]!;
        return { i, job: p.job, lat: Math.abs(r.v(p.tgtZ) - bv), tu: r.u(p.tgtX), u: stand.get(i)! };
      }).sort((a, b) => a.lat - b.lat);
      expect(rows.length).toBe(4);
      for (const row of rows) expect(row.job, `slot ${row.i}`).toBe(AiJob.HOLD_SHAPE);
      const near = rows[0]!;
      // The back-liner nearest the ball laterally has the highest target: above the line, at most `stagger` above.
      for (const row of rows) expect(near.tu).toBeGreaterThanOrEqual(row.tu);
      expect(near.tu).toBeGreaterThan(L + 0.25 * LT.stagger);
      expect(near.tu).toBeLessThanOrEqual(L + LT.stagger + 1e-9);
      // Never reversed: the further across from the ball, the lower (never below the line).
      for (let k = 1; k < rows.length; k++) {
        expect(rows[k]!.tu, `slot ${rows[k]!.i}`).toBeLessThanOrEqual(rows[k - 1]!.tu + 1e-9);
        expect(rows[k]!.tu, `slot ${rows[k]!.i}`).toBeGreaterThanOrEqual(L - 1e-9);
      }
      // Defenders staggerRange (20 m) or more across from the ball aim exactly at the line.
      expect(LT.staggerRange).toBeLessThanOrEqual(20);
      const far = rows.filter((row) => row.lat >= LT.staggerRange);
      expect(far.length).toBeGreaterThanOrEqual(1);
      for (const row of far) expect(row.tu, `slot ${row.i}`).toBeCloseTo(L, 9);
      // And the settled players stand that way: the ball-side defender higher than the furthest one, the line level.
      const furthest = rows[rows.length - 1]!;
      expect(near.u - furthest.u).toBeGreaterThan(0.25 * LT.stagger);
      expect(near.u - furthest.u).toBeLessThan(LT.stagger + 0.5);
      expect(sd(rows.map((row) => row.u))).toBeLessThan(1.5);
    });
  }
});

describe('TAI-04 stepping up and dropping', () => {
  it.each(DIRS)('steps up together on a backward pass and stays level (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [
      { k: 6, u: -12, v: 0, fu: 0, fv: 1 },
      { k: 7, u: 8, v: 14, fu: 1, fv: 0 },
      { k: 9, u: -18, v: 6 },
      { k: 10, u: -18, v: -6 },
    ];
    r.ownerK = 6;
    r.run(240);
    const L0 = r.lineU();
    const B0 = mean(r.backU());
    const trace = playPass(r, 6, 7, 15);
    for (let i = 1; i < trace.length; i++) expect(trace[i]!).toBeGreaterThanOrEqual(trace[i - 1]! - 1e-9);
    expect(r.lineU()).toBeGreaterThan(L0 + 4);
    expect(mean(r.backU())).toBeGreaterThan(B0 + 2.5);
    r.run(120);
    expect(sd(r.backU())).toBeLessThan(1.5);
    expect(r.lineU()).toBeGreaterThan(L0 + 4);
  });

  it.each(DIRS)('target: backward and square balls step the line up, a forward ball does not (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [
      { k: 6, u: -12, v: 0, fu: 0, fv: 1 },
      { k: 7, u: 8, v: 0, fu: 1, fv: 0 },
      { k: 5, u: -12, v: 20, fu: 0, fv: -1 },
      { k: 9, u: -30, v: 0 },
    ];
    r.ownerK = 6;
    r.run(240);
    const t0 = target(r);
    const loose = (vu: number, vv: number, toK: number): number => {
      const c = cloneState(r.s);
      const b = c.ball;
      b.owner = -1;
      [b.vx, b.vz] = r.w(vu, vv);
      b.lastKickBy = r.oppSlot(6); b.lastKickTeam = r.opp; b.lastKickTick = c.tick;
      b.lastTouch = r.oppSlot(6); b.lastTouchTeam = r.opp;
      b.passTarget = r.oppSlot(toK);
      const to = c.players[r.oppSlot(toK)]!;
      b.passX = to.x; b.passZ = to.z;
      return r.dir * defensiveLineTarget(c, r.def);
    };
    const back = loose(14, 0, 7);
    const square = loose(0, 14, 5);
    const fwd = loose(-14, 0, 9);
    expect(back).toBeGreaterThanOrEqual(t0 + LT.stepUpM - 1e-9);
    expect(square).toBeGreaterThanOrEqual(t0 + LT.stepUpM - 1e-9);
    expect(back).toBeGreaterThan(square); // the base also follows the ball's predicted position
    expect(fwd).toBeLessThanOrEqual(t0 + 1e-9);
  });

  it.each(DIRS)('drops when the carrier faces our goal unpressured, not when pressed or facing away (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: -8, v: 0, fu: 0, fv: 1 }];
    r.ownerK = 6;
    r.run(240);
    const side = target(r);
    const facing = (fu: number, press: boolean): number => {
      const c = cloneState(r.s);
      const p = c.players[r.oppSlot(6)]!;
      [p.fx, p.fz] = r.w(fu, 0);
      if (press) {
        const m = c.players[r.defSlot(6)]!;
        [m.x, m.z] = r.w(-9, 0); // 1 m in front of him, goal-side
      }
      return r.dir * defensiveLineTarget(c, r.def);
    };
    const fwdFree = facing(-1, false);
    const fwdPressed = facing(-1, true);
    const awayFree = facing(1, false);
    // Free = nobody of ours near him (0 within freeDistMin .. 1 beyond freeDistFull).
    const c = r.oppP(6);
    const near = Math.min(...r.s.players.filter((p) => p.team === r.def && p.active === 1).map((p) => Math.hypot(p.x - c.x, p.z - c.z)));
    const free = Math.min(1, Math.max(0, (near - LT.freeDistMin) / (LT.freeDistFull - LT.freeDistMin)));
    expect(free).toBeGreaterThan(0.8);
    expect(fwdFree).toBeLessThanOrEqual(side - LT.dropUnpressured * free + 1e-6);
    expect(fwdPressed).toBeCloseTo(side, 6);
    expect(awayFree).toBeCloseTo(side, 6);
    // Dynamics: the carrier turns to face our goal; the line and the players drop together.
    const L0 = r.lineU();
    const B0 = mean(r.backU());
    r.opps[0]!.fu = -1; r.opps[0]!.fv = 0;
    r.run(90);
    expect(r.lineU()).toBeLessThan(L0 - 4);
    expect(mean(r.backU())).toBeLessThan(B0 - 3);
    expect(sd(r.backU())).toBeLessThan(1.5);
  });

  it.each(DIRS)('drops further just after losing the ball (team.phase TRANSITION_DEFEND) (defending team %i)', (def) => {
    const r = new Rig({ def });
    settledOpps(r);
    r.run(240);
    const settled = target(r);
    r.s.teams[r.def]!.phase = TeamPhase.TRANSITION_DEFEND;
    expect(target(r)).toBeCloseTo(settled - LT.transitionDrop, 9);
    // The players hurry back with the line (checked on this module's output, before TAI-07 steering).
    r.s.tick++;
    resetJobs(r.s, r.def);
    assignDefensiveShape(r.s, r.def, NULL_SINK);
    for (const i of r.back()) {
      const p = r.s.players[i]!;
      if (p.job === AiJob.HOLD_SHAPE) expect(p.tgtSpeed).toBe(r.s.attrs[i]!.topSpeed);
    }
  });

  it.each(DIRS)('drops goal-side of an onside runner in behind; holds against an offside one (defending team %i)', (def) => {
    for (const offside of [0, 1] as const) {
      const r = new Rig({ def, offside });
      r.opps = [{ k: 6, u: -5, v: 0, fu: 0, fv: 1 }, { k: 9, u: -5, v: 8 }];
      r.ownerK = 6;
      r.run(240);
      const L = r.lineU();
      r.opps[1]!.u = L - 4; // parked 4 m behind our line
      r.applyScript();
      const t = target(r);
      if (offside === 0) {
        expect(t).toBeLessThanOrEqual(L - 4 - LT.runnerMargin + 1e-9);
        r.run(150);
        for (const u of r.backU()) expect(u).toBeLessThan(L - 4);
      } else {
        expect(t).toBeGreaterThan(L - 1); // he is offside: keep him there
        r.run(150);
        expect(r.lineU()).toBeGreaterThan(L - 1);
        expect(inOffsidePosition(r, 9)).toBe(true);
      }
    }
  });

  it.each(DIRS)('drops for a runner breaking the line while the carrier is free, except with the trap (defending team %i)', (def) => {
    for (const trap of [0, 1] as const) {
      const r = new Rig({ def, trap });
      r.opps = [{ k: 6, u: -5, v: 0, fu: 0, fv: 1 }, { k: 9, u: 0, v: 8 }];
      r.ownerK = 6;
      r.run(240);
      const L = r.lineU();
      const calm = target(r);
      r.opps[1]!.u = L + 1;
      r.opps[1]!.vu = -7;
      r.applyScript();
      const t = target(r);
      if (trap === 0) expect(t).toBeLessThanOrEqual(L + 1 - 7 * LT.runnerLookahead - LT.runnerMargin + 0.05);
      else expect(t).toBeCloseTo(calm, 6);
    }
  });

  it.each(DIRS)('never deeper than the 6-yard box edge while the ball is far, deeper only when it is near (defending team %i)', (def) => {
    const r = new Rig({ def, offside: 0 }); // no offside: a parked attacker drags the line as far as allowed
    r.opps = [{ k: 6, u: 10, v: 0, fu: 0, fv: 1 }, { k: 9, u: -51, v: 0 }];
    r.ownerK = 6;
    const edge = -HL + GOAL_AREA_DEPTH;
    for (let i = 0; i < 300; i++) {
      r.tick();
      expect(r.lineU()).toBeGreaterThanOrEqual(edge - 1e-9);
      for (const k of r.back()) expect(r.u(r.s.players[k]!.tgtX)).toBeGreaterThanOrEqual(edge - 1e-9);
    }
    expect(r.lineU()).toBeLessThan(edge + 0.01); // it did drop as far as allowed
    r.opps[0]!.u = -36; r.opps[0]!.v = -20;
    r.applyScript();
    const near = target(r);
    expect(near).toBeLessThan(edge - 1);
    expect(near).toBeGreaterThanOrEqual(-HL + LT.floorNear - 1e-9);
  });
});

describe('TAI-04 compactness', () => {
  for (const def of DIRS) {
    it.each(FORMS)(`formation %i, defending team ${def}: midfield 8-14 m ahead of the line, block within two line spacings`, (form) => {
      const r = new Rig({ def, form });
      settledOpps(r);
      r.run(300);
      const L = r.lineU();
      const tol = 0.7;
      let checked = 0;
      for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
        const slot = r.defSlot(k);
        if (r.back().includes(slot)) continue;
        const p = r.s.players[slot]!;
        if (p.job !== AiJob.HOLD_SHAPE) continue;
        const gap = r.u(p.x) - L;
        const line = slotLine(form, p.formIdx);
        const hi = line === ShapeLine.FWD ? 2 * T_AI.lineSpacingMax : line === ShapeLine.AM ? T_AI.lineSpacingMax + LT.amExtra : T_AI.lineSpacingMax;
        expect(gap, `slot ${slot} line ${line}`).toBeGreaterThanOrEqual(LT.midGapMin - tol);
        expect(gap, `slot ${slot} line ${line}`).toBeLessThanOrEqual(hi + tol);
        if (line !== ShapeLine.FWD) checked++;
      }
      expect(checked).toBeGreaterThanOrEqual(1);
      // Markers in midfield stay in front of the back line too.
      for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
        const p = r.defP(k);
        if (!r.back().includes(p.slot) && p.job === AiJob.MARK) expect(r.u(p.tgtX)).toBeGreaterThanOrEqual(L + LT.midMarkMinGap - 1e-9);
      }
    });
  }

  it.each(DIRS)('the midfield is never pushed in front of the ball (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: -30, v: 0, fu: 0, fv: 1 }];
    r.ownerK = 6;
    r.run(200);
    const bu = r.u(r.s.ball.x);
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = r.defP(k);
      if (r.back().includes(p.slot) || p.job !== AiJob.HOLD_SHAPE) continue;
      const home = r.u(p.homeX);
      const tu = r.u(p.tgtX);
      // Raised above his home only up to the ball.
      if (tu > home + 1e-9) expect(tu).toBeLessThanOrEqual(Math.max(bu, r.lineU()) + 1e-9);
    }
  });
});

describe('TAI-04 offside trap', () => {
  it.each(DIRS)('the trap catches a scripted runner on a backward pass (defending team %i)', (def) => {
    const margin: number[] = [];
    for (const trap of [0, 1] as const) {
      const r = new Rig({ def, trap });
      r.opps = [
        { k: 6, u: -12, v: 0, fu: 0, fv: 1 },
        { k: 7, u: 8, v: 14, fu: 1, fv: 0 },
        { k: 9, u: -24, v: 5 },
      ];
      r.ownerK = 6;
      r.run(240);
      // The runner stands 3 m onside of the settled offside line.
      r.opps[2]!.u = offsideLineU(r) + 3;
      r.run(30);
      expect(inOffsidePosition(r, 9)).toBe(false);
      playPass(r, 6, 7, 15);
      // The receiver plays the ball forward at once: judged now.
      margin.push(offsideLineU(r) - r.opps[2]!.u);
      if (trap === 1) expect(inOffsidePosition(r, 9)).toBe(true);
    }
    expect(margin[1]!).toBeGreaterThan(1);
    expect(margin[1]!).toBeGreaterThan(margin[0]! + 1);
  });

  it.each(DIRS)('the trap holds a higher line (defending team %i)', (def) => {
    const lines: number[] = [];
    for (const trap of [0, 1] as const) {
      const r = new Rig({ def, trap });
      settledOpps(r);
      r.run(240);
      lines.push(r.lineU());
    }
    expect(lines[1]! - lines[0]!).toBeCloseTo(QUICK_TACTICS.offsideTrap.lineNx * HL, 1);
  });

  it.each(DIRS)('no trap step without offside (config.offside = 0) (defending team %i)', (def) => {
    const r = new Rig({ def, trap: 1, offside: 0 });
    r.opps = [{ k: 6, u: -12, v: 0, fu: 0, fv: 1 }, { k: 7, u: 8, v: 14, fu: 1, fv: 0 }];
    r.ownerK = 6;
    r.run(240);
    const plain = new Rig({ def, trap: 0, offside: 0 });
    plain.opps = r.opps.map((o) => ({ ...o }));
    plain.ownerK = 6;
    plain.run(240);
    expect(r.lineU()).toBeCloseTo(plain.lineU(), 9);
  });
});

describe('TAI-04 zonal marking', () => {
  it.each(DIRS)('strikers in the centre-backs\' zones are marked one-to-one, goal-side, from the line (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [
      { k: 6, u: -4, v: 4, fu: 0, fv: 1 },
      { k: 9, u: -24, v: 7 },
      { k: 10, u: -24, v: -7 },
      { k: 7, u: 2, v: -10 },
    ];
    r.ownerK = 6;
    r.run(240);
    const L = r.lineU();
    const markers = new Map<number, number>();
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = r.defP(k);
      if (p.job !== AiJob.MARK) continue;
      expect(markers.has(p.jobSlot), `attacker ${p.jobSlot} marked twice`).toBe(false);
      markers.set(p.jobSlot, p.slot);
    }
    for (const k of [9, 10]) {
      const a = r.oppSlot(k);
      const m = markers.get(a);
      expect(m, `striker ${k} unmarked`).toBeDefined();
      expect(r.back()).toContain(m);
      const p = r.s.players[m!]!;
      const tu = r.u(p.tgtX), tv = r.v(p.tgtZ);
      expect(tu).toBeGreaterThanOrEqual(L - 1e-9);
      expect(tu).toBeLessThanOrEqual(L + LT.markStepOut + 1e-9);
      const av = r.opps.find((o) => o.k === k)!.v;
      expect(Math.abs(tv)).toBeLessThan(Math.abs(av)); // goal-side = toward the goal centre
      expect(Math.abs(tv - av)).toBeLessThan(LT.markGap);
      // The marker actually got there.
      expect(Math.abs(r.v(p.z) - tv)).toBeLessThan(0.7);
    }
    expect(markers.has(r.oppSlot(7))).toBe(false); // far from every zone
    expect(sd(r.backU())).toBeLessThan(1.5);
  });

  it.each(DIRS)('an attacker walking into a defender\'s zone gets marked there (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: -2, v: -12, fu: 0, fv: 1 }, { k: 9, u: 10, v: 6, vu: -3 }];
    r.ownerK = 6;
    r.run(200);
    const back = r.back();
    let firstMarkU = NaN;
    for (let i = 0; i < 600; i++) {
      r.tick((rr) => {
        const o = rr.opps[1]!;
        if (o.u > rr.lineU() + 3) o.u -= 3 / 60; else o.vu = 0;
      });
      const a = r.oppSlot(9);
      const marked = back.some((sl) => r.s.players[sl]!.job === AiJob.MARK && r.s.players[sl]!.jobSlot === a);
      const gap = r.opps[1]!.u - r.lineU();
      if (gap > 12) expect(marked, `marked ${gap.toFixed(1)} m in front of the line`).toBe(false);
      if (marked && Number.isNaN(firstMarkU)) firstMarkU = gap;
    }
    expect(firstMarkU).toBeGreaterThan(3);
    expect(firstMarkU).toBeLessThanOrEqual(12);
    const a = r.oppSlot(9);
    expect(back.some((sl) => r.s.players[sl]!.job === AiJob.MARK && r.s.players[sl]!.jobSlot === a)).toBe(true);
  });

  it.each(DIRS)('an attacker behind the line in an offside position is not followed (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: -4, v: 0, fu: 0, fv: 1 }, { k: 9, u: -10, v: 7 }];
    r.ownerK = 6;
    r.run(200);
    const L = r.lineU();
    r.opps[1]!.u = L - 3;
    r.run(120);
    for (const sl of r.back()) {
      const p = r.s.players[sl]!;
      expect(r.u(p.tgtX)).toBeGreaterThanOrEqual(r.lineU() - 1e-9);
    }
    expect(r.lineU()).toBeGreaterThan(L - 1);
    expect(inOffsidePosition(r, 9)).toBe(true);
  });
});

describe('TAI-04 passing lanes into the box', () => {
  it.each(DIRS)('a free midfielder covers the open lane to a receiver in the box (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: -34, v: -24, fu: -1, fv: 1 }, { k: 9, u: -44, v: 3 }];
    r.ownerK = 6;
    r.run(150);
    const recv = r.oppSlot(9);
    const covers = [];
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = r.defP(k);
      if (p.job === AiJob.COVER && p.jobSlot === recv) covers.push(p);
    }
    expect(covers).toHaveLength(1);
    const p = covers[0]!;
    expect(r.back()).not.toContain(p.slot);
    // On the lane, between 30% and 70% of the way.
    const cu = -34, cv = -24, ru = -44, rv = 3;
    const lu = ru - cu, lv = rv - cv, l2 = lu * lu + lv * lv;
    const tu = r.u(p.tgtX), tv = r.v(p.tgtZ);
    const f = ((tu - cu) * lu + (tv - cv) * lv) / l2;
    expect(f).toBeGreaterThanOrEqual(LT.laneTMin - 1e-9);
    expect(f).toBeLessThanOrEqual(LT.laneTMax + 1e-9);
    const du = cu + lu * f - tu, dv = cv + lv * f - tv;
    expect(Math.sqrt(du * du + dv * dv)).toBeLessThan(1e-6);
  });

  it.each(DIRS)('a lane already blocked by a team-mate is not covered twice (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: -34, v: -24, fu: -1, fv: 1 }, { k: 9, u: -44, v: 3 }];
    r.ownerK = 6;
    r.run(150);
    // Our forward stands on the middle of the lane.
    const f = r.defP(10);
    [f.x, f.z] = r.w(-39, -10.5);
    f.vx = 0; f.vz = 0;
    r.tick();
    const recv = r.oppSlot(9);
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = r.defP(k);
      expect(p.job === AiJob.COVER && p.jobSlot === recv).toBe(false);
    }
  });

  it.each(DIRS)('no lane covering while the carrier is far from our goal (defending team %i)', (def) => {
    const r = new Rig({ def });
    r.opps = [{ k: 6, u: 0, v: -24, fu: -1, fv: 1 }, { k: 9, u: -40, v: 3 }];
    r.ownerK = 6;
    r.run(60);
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) expect(r.defP(k).job).not.toBe(AiJob.COVER);
  });
});

describe('TAI-04 both directions, determinism, purity', () => {
  it('mirror: defending either way gives the identical picture in the team frame, every tick', () => {
    const a = new Rig({ def: 0, form: FormationId.F4231, trap: 1 });
    const b = new Rig({ def: 1, form: FormationId.F4231, trap: 1 });
    // TAI-01 staggers shape updates (team 1 half an interval after team 0): align the clocks.
    b.s.tick = a.s.tick + (T_AI.shapeInterval >> 1);
    // Same players on both sides of the mirror (the two clubs' attributes differ).
    for (let k = 0; k < PLAYERS_PER_TEAM; k++) {
      Object.assign(b.s.attrs[b.defSlot(k)]!, a.s.attrs[a.defSlot(k)]!);
      Object.assign(b.s.attrs[b.oppSlot(k)]!, a.s.attrs[a.oppSlot(k)]!);
    }
    for (const r of [a, b]) {
      settledOpps(r);
      r.opps.push({ k: 3, u: 6, v: 14, fu: 1, fv: 0 });
    }
    const snap = (r: Rig): number[] => {
      const out = [r.lineU()];
      for (let k = 0; k < PLAYERS_PER_TEAM; k++) {
        const p = r.defP(k);
        out.push(r.u(p.x) + 0, r.v(p.z) + 0, r.u(p.tgtX) + 0, r.v(p.tgtZ) + 0, p.tgtSpeed, p.job, p.jobSlot < 0 ? -1 : p.jobSlot - teamFirstSlot(r.opp));
      }
      return out;
    };
    for (let i = 0; i < 200; i++) {
      a.tick(); b.tick();
      expect(snap(b)).toEqual(snap(a));
    }
    playPass(a, 6, 3, 14);
    playPass(b, 6, 3, 14);
    expect(snap(b)).toEqual(snap(a));
    a.run(60); b.run(60);
    expect(snap(b)).toEqual(snap(a));
  });

  it('deterministic: identical runs give identical hashes every tick', () => {
    const run = (): number[] => {
      const r = new Rig({ def: 1, form: FormationId.F352, trap: 1 });
      settledOpps(r);
      const hashes: number[] = [];
      for (let i = 0; i < 240; i++) {
        r.tick((rr) => { rr.opps[1]!.u = -20 + Math.round(((i * 7) % 40) - 20) / 4; });
        hashes.push(hashState(r.s));
      }
      return hashes;
    };
    const h = run();
    expect(run()).toEqual(h);
  });

  it('pure apart from lineX and jobs: same result on a clone; repeated evaluation is stable', () => {
    const r = new Rig({ def: 0 });
    settledOpps(r);
    r.run(120);
    const c = cloneState(r.s);
    resetJobs(r.s, 0); resetJobs(c, 0);
    assignDefensiveShape(r.s, 0, NULL_SINK);
    assignDefensiveShape(c, 0, NULL_SINK);
    expect(hashState(c)).toBe(hashState(r.s));
    const t1 = defensiveLineTarget(r.s, 0);
    const h = hashState(r.s);
    expect(defensiveLineTarget(r.s, 0)).toBe(t1);
    expect(hashState(r.s)).toBe(h); // the pure query writes nothing
  });
});

describe('TAI-04 when not defending, controllers, short-handed', () => {
  it('isDefending: opponent ball, opponent pass in flight, loose ball nearer the opponent', () => {
    const r = new Rig({ def: 0 });
    settledOpps(r);
    r.applyScript();
    const s = r.s;
    expect(isDefending(s, 0)).toBe(true);
    expect(isDefending(s, 1)).toBe(false);
    // Opponent keeper holding the ball.
    s.ball.owner = s.ball.heldBy = r.oppSlot(0);
    expect(isDefending(s, 0)).toBe(true);
    s.ball.heldBy = -1;
    // Loose ball: nearer one of ours -> not defending; nearer theirs -> defending.
    s.ball.owner = -1; s.ball.passTarget = -1; s.ball.lastTouchTeam = 0;
    const ours = r.defP(6);
    s.ball.x = ours.x + 0.5; s.ball.z = ours.z;
    expect(isDefending(s, 0)).toBe(false);
    const theirs = r.oppP(9);
    s.ball.x = theirs.x + 0.5; s.ball.z = theirs.z;
    expect(isDefending(s, 0)).toBe(true);
    // Their pass in flight, even past one of ours.
    s.ball.x = ours.x + 0.5; s.ball.z = ours.z;
    s.ball.lastTouchTeam = 1; s.ball.passTarget = r.oppSlot(9);
    expect(isDefending(s, 0)).toBe(true);
  });

  it.each(DIRS)('in possession: no TAI-04 jobs, lineX tracks the back line (defending team %i)', (def) => {
    const r = new Rig({ def });
    settledOpps(r);
    r.run(120);
    // We win the ball: our midfielder owns it.
    const s = r.s;
    r.ownerK = -1;
    const own = r.defP(6);
    r.ball = { u: r.u(own.x), v: r.v(own.z), vu: 0, vv: 0 };
    r.applyScript();
    s.ball.owner = own.slot;
    s.tick++;
    updateShape(s, r.def, NULL_SINK);
    resetJobs(s, r.def);
    assignDefensiveShape(s, r.def, NULL_SINK);
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = r.defP(k);
      if (p.job === AiJob.NONE) continue;
      expect(p.job).toBe(AiJob.HOLD_SHAPE);
      expect(p.tgtX).toBe(p.homeX);
      expect(p.tgtZ).toBe(p.homeZ);
    }
    const us = r.back().map((i) => r.u(s.players[i]!.x)).sort((x, y) => x - y);
    const med = us.length % 2 === 1 ? us[us.length >> 1]! : (us[us.length / 2 - 1]! + us[us.length / 2]!) / 2;
    expect(r.lineU()).toBeCloseTo(med, 9);
  });

  it('outside IN_PLAY: nothing happens', () => {
    const r = new Rig({ def: 0 });
    settledOpps(r);
    r.run(60);
    r.s.match.phase = MatchPhase.THROW_IN;
    const h = hashState(r.s);
    assignDefensiveShape(r.s, 0, NULL_SINK);
    expect(hashState(r.s)).toBe(h);
    expect(Number.isNaN(defensiveLineTarget(r.s, 0))).toBe(true);
  });

  it.each(DIRS)('a human-controlled defender is left alone; the AI back line stays level (defending team %i)', (def) => {
    const r = new Rig({ def });
    settledOpps(r);
    const cb = r.defP(2);
    cb.ctrl = 0;
    r.s.ctrl[0]!.slot = cb.slot;
    r.run(240);
    expect(cb.job).toBe(AiJob.NONE);
    const ai = r.back().filter((i) => i !== cb.slot).map((i) => r.u(r.s.players[i]!.x));
    expect(ai.length).toBe(3);
    expect(sd(ai)).toBeLessThan(1.5);
  });

  it.each(DIRS)('short-handed: a sent-off centre-back is replaced in the line and the line stays level (defending team %i)', (def) => {
    const r = new Rig({ def });
    settledOpps(r);
    r.run(60);
    const cb = r.defP(2);
    cb.active = 0;
    [cb.x, cb.z] = r.w(0, 40);
    r.s.teams[r.def]!.onPitch = 10;
    r.s.teams[r.def]!.shapeT = 0;
    r.run(300);
    const back = r.back();
    expect(back).toHaveLength(4);
    expect(back).not.toContain(cb.slot);
    expect(sd(r.backU())).toBeLessThan(1.5);
    for (const u of r.backU()) expect(u).toBeLessThan(r.lineU() + LT.maxStepOut + 0.8);
  });
});

describe('TAI-04 glitch: Players: orbit or jitter around a target (defensive line)', () => {
  it.each(DIRS)('settled back line: targets move smoothly and players stand still (defending team %i)', (def) => {
    const r = new Rig({ def });
    settledOpps(r);
    r.run(300);
    const back = r.back();
    let prev = back.map((i) => [r.s.players[i]!.tgtX, r.s.players[i]!.tgtZ] as const);
    for (let t = 0; t < 120; t++) {
      r.tick();
      const now = back.map((i) => [r.s.players[i]!.tgtX, r.s.players[i]!.tgtZ] as const);
      for (let k = 0; k < back.length; k++) {
        expect(Math.abs(now[k]![0] - prev[k]![0])).toBeLessThan(LT.lineDownRate / 60 + 1e-6);
        expect(Math.abs(now[k]![1] - prev[k]![1])).toBeLessThan(0.5);
      }
      prev = now;
      for (const i of back) {
        const p = r.s.players[i]!;
        expect(Math.sqrt(p.vx * p.vx + p.vz * p.vz)).toBeLessThan(0.3);
      }
    }
  });
});

describe('TAI-04 through the real step pipeline', () => {
  it('opponent build-up for 10 s: lineX finite and on the pitch, targets valid, deterministic, invariants hold', () => {
    const run = (): number[] => {
      const s = makeScenario({ seed: 21, phase: MatchPhase.IN_PLAY, humans: 0 });
      // Team 1 has the ball in its own half; team 0 defends (team 1 attacks -x).
      const c = s.players[17]!;
      c.x = 10; c.z = 3;
      s.ball.x = 10; s.ball.z = 3; s.ball.px = 10; s.ball.pz = 3; s.ball.owner = 17; s.ball.lastTouch = 17; s.ball.lastTouchTeam = 1;
      s.teams[0]!.offsideTrap = 1;
      const hashes: number[] = [];
      let defending = 0;
      runTicks(s, 600, undefined, {
        check: 'core',
        until: (st) => {
          if (st.match.phase === MatchPhase.IN_PLAY && isDefending(st, 0)) defending++;
          for (const team of [0, 1]) {
            const L = st.teams[team]!.lineX;
            expect(Number.isFinite(L)).toBe(true);
            expect(Math.abs(L)).toBeLessThanOrEqual(HL);
          }
          for (const p of st.players) {
            if (p.active !== 1 || (p.job !== AiJob.MARK && p.job !== AiJob.COVER)) continue;
            expect(Number.isFinite(p.tgtX) && Number.isFinite(p.tgtZ) && Number.isFinite(p.tgtSpeed)).toBe(true);
            expect(Math.abs(p.tgtX)).toBeLessThanOrEqual(HL);
            expect(Math.abs(p.tgtZ)).toBeLessThanOrEqual(34);
            expect(st.players[p.jobSlot]!.team).not.toBe(p.team);
          }
          hashes.push(hashState(st));
          return false;
        },
      });
      expect(defending).toBeGreaterThan(100);
      return hashes;
    };
    const h = run();
    expect(h.length).toBe(600);
    expect(run()).toEqual(h);
  });
});

describe('TAI-04 robustness', () => {
  it('the loose-ball chaser keeps his CHASE_LOOSE job; the rest of the line stays level', () => {
    for (const def of DIRS) {
      const r = new Rig({ def });
      settledOpps(r);
      r.run(240);
      // Their pass in flight toward their striker, rolling right at our right centre-back.
      const cb = r.defP(2);
      const cbU = r.u(cb.x), cbV = r.v(cb.z);
      r.ownerK = -1;
      r.ball = { u: cbU + 3, v: cbV, vu: -2, vv: 0 };
      const b = r.s.ball;
      b.lastTouchTeam = r.opp; b.lastKickTeam = r.opp; b.lastKickBy = r.oppSlot(6); b.lastKickTick = r.s.tick;
      b.passTarget = r.oppSlot(9);
      r.tick((rr) => { rr.ball.u += rr.ball.vu / 60; });
      expect(isDefending(r.s, r.def)).toBe(true);
      expect(r.s.teams[r.def]!.chaser).toBe(cb.slot);
      expect(cb.job).toBe(AiJob.CHASE_LOOSE);
      const others = r.back().filter((i) => i !== cb.slot).map((i) => r.u(r.s.players[i]!.tgtX));
      expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(LT.markStepOut + 1e-9);
    }
  });

  it('hostile random states: finite, in-pitch outputs; one marker per attacker; valid job targets (fuzz, 400 states)', () => {
    const rng = { a: 0, b: 0, c: 0, d: 0 };
    rngSeed(rng, 0x7a104);
    const f = (lo: number, hi: number): number => lo + (hi - lo) * rngFloat(rng);
    for (let n = 0; n < 400; n++) {
      const form = FORMS[rngInt(rng, FORMS.length)]!;
      const s = makeScenario({
        seed: n + 1, phase: MatchPhase.IN_PLAY, humans: rngInt(rng, 3),
        config: { homeFormation: form, awayFormation: FORMS[rngInt(rng, FORMS.length)]!, offside: rngInt(rng, 2) },
      });
      if (rngChance(rng, 0.5)) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
      for (const t of s.teams) {
        t.offsideTrap = rngInt(rng, 2); t.teamPress = rngInt(rng, 2); t.extraStriker = rngInt(rng, 2);
        t.focus = rngInt(rng, 3); t.phase = rngInt(rng, 6); t.lineX = rngChance(rng, 0.1) ? NaN : f(-60, 60);
      }
      for (const p of s.players) {
        p.x = f(-56, 56); p.z = f(-38, 38); p.vx = f(-9, 9); p.vz = f(-9, 9);
        const a = f(0, 6.283); p.fx = Math.cos(a); p.fz = Math.sin(a);
        p.homeX = rngChance(rng, 0.03) ? NaN : f(-50, 50); p.homeZ = f(-33, 33);
        if (p.isKeeper === 0 && rngChance(rng, 0.06)) p.active = 0;
        if (p.isKeeper === 0 && rngChance(rng, 0.05)) p.ctrl = 2 + p.team;
      }
      const owner = rngInt(rng, 24) - 2; // -2..21: some loose balls
      const b = s.ball;
      b.owner = owner >= 0 && s.players[owner]!.active === 1 ? owner : -1;
      b.heldBy = b.owner >= 0 && s.players[b.owner]!.isKeeper === 1 && rngChance(rng, 0.5) ? b.owner : -1;
      b.x = b.owner >= 0 ? s.players[b.owner]!.x : f(-54, 54); b.z = b.owner >= 0 ? s.players[b.owner]!.z : f(-35, 35);
      b.vx = f(-25, 25); b.vz = f(-15, 15);
      b.lastTouchTeam = rngInt(rng, 3) - 1; b.lastKickTeam = rngInt(rng, 3) - 1; b.lastKickBy = rngInt(rng, 23) - 1;
      b.lastKickTick = s.tick - rngInt(rng, 200); b.passTarget = rngInt(rng, 23) - 1;
      b.passX = f(-52, 52); b.passZ = f(-34, 34);
      s.match.offside.passTeam = rngInt(rng, 3) - 1; s.match.offside.flags = rngInt(rng, 1 << 22);
      s.tick++;
      for (let team = 0; team < 2; team++) {
        resetJobs(s, team);
        assignChaser(s, team, NULL_SINK);
        const before = s.teams[team]!.lineX;
        assignDefensiveShape(s, team, NULL_SINK);
        const L = s.teams[team]!.lineX;
        if (!Object.is(L, before) || isDefending(s, team)) { // written by this module
          expect(Number.isFinite(L), `state ${n} team ${team} lineX ${L}`).toBe(true);
          expect(Math.abs(L)).toBeLessThanOrEqual(HL);
        }
        const marked = new Set<number>();
        const defending = isDefending(s, team);
        for (let i = team * 11; i < team * 11 + 11; i++) {
          const p = s.players[i]!;
          // HOLD_SHAPE comes from jobs.resetJobs (home as given) unless this module placed the player (defending).
          if (p.job !== AiJob.MARK && p.job !== AiJob.COVER && !(p.job === AiJob.HOLD_SHAPE && defending)) continue;
          expect(Number.isFinite(p.tgtX) && Number.isFinite(p.tgtZ) && Number.isFinite(p.tgtSpeed), `state ${n} slot ${i}`).toBe(true);
          expect(Math.abs(p.tgtX)).toBeLessThanOrEqual(HL);
          expect(Math.abs(p.tgtZ)).toBeLessThanOrEqual(34);
          expect(p.tgtSpeed).toBeGreaterThan(0);
          if (p.job === AiJob.MARK || p.job === AiJob.COVER) {
            const a = s.players[p.jobSlot]!;
            expect(a.team).not.toBe(team);
            expect(a.active).toBe(1);
            if (p.job === AiJob.MARK) { expect(marked.has(p.jobSlot)).toBe(false); marked.add(p.jobSlot); }
          }
        }
      }
    }
  });
});
