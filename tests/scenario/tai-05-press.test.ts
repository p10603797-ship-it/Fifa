/**
 * TAI-05 scenarios: pressing, cover, the second defender, team press and tracking runners. The defending side runs
 * the real team-AI stages that drive it out of possession (TAI-01 updateShape -> jobs.resetJobs -> TAI-07
 * assignChaser -> TAI-04 assignDefensiveShape -> TAI-05 assignPressing -> TAI-07 executeJobs) and the real SIM-04
 * locomotion; the attacking side and the ball are scripted, so the tests do not depend on modules that are still
 * stubs (CPU brains, SIM-15 switching). Every scenario is written in the defending team's frame (u toward the
 * opposition goal, v = dir * z: our goal is at u = -52.5) and runs for both attack directions.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { DT, HALF_LENGTH, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { AiJob, ControllerKind, Difficulty, FormationId, MatchPhase, TacticalFocus, TeamPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { resetJobs } from '../../src/ai/jobs';
import { updateShape } from '../../src/ai/shape';
import { assignChaser, executeJobs } from '../../src/ai/steer';
import { assignDefensiveShape } from '../../src/ai/defshape';
import { assignTransition } from '../../src/ai/transition';
import {
  assignPressing, PRESS_TUNING as LT, pressEngageRadius, pressStandoff, teamPressIntensity,
} from '../../src/ai/press';
import { ShapeLine, slotLine } from '../../src/data/formations';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario, runTicks } from '../harness/scenario';

const HL = HALF_LENGTH;
const N = PLAYERS_PER_TEAM;

/** A scripted opponent in the defending team's frame (formation index k). */
interface OppSpot { k: number; u: number; v: number; vu?: number; vv?: number }

interface RigOpts {
  def: 0 | 1;
  form?: FormationId;
  offside?: 0 | 1;
  teamPress?: 0 | 1;
  /** Human controller 0 on the defending side (controlling nothing until `control` is called). */
  human?: boolean;
  difficulty?: Difficulty;
  seed?: number;
}

/** Test rig: defending team `def` run by the real AI stages; the other team and the ball are scripted. */
class Rig {
  readonly s: SimState;
  readonly def: number;
  readonly opp: number;
  readonly dir: number;
  opps: OppSpot[] = [];
  /** Ball owner (opponent formation index), or -1: the ball is scripted by `ballScript`. */
  ownerK = -1;
  /** Called every tick when ownerK < 0 (pass in flight etc.). */
  ballScript: ((r: Rig) => void) | null = null;
  /** Run TAI-04 too (default) — off for isolating TAI-05. */
  withShape = true;
  /** Run TAI-06 assignTransition after TAI-05 (as ai/index.ts does). */
  withTransition = false;

  constructor(o: RigOpts) {
    const f = o.form ?? FormationId.F442;
    this.s = makeScenario({
      seed: o.seed ?? 7, phase: MatchPhase.IN_PLAY, humans: o.human ? [{ side: o.def }] : 0,
      config: { homeFormation: f, awayFormation: f, offside: o.offside ?? 1, difficulty: o.difficulty ?? Difficulty.PROFESSIONAL },
    });
    this.def = o.def;
    this.opp = 1 - o.def;
    this.dir = this.s.teams[this.def]!.dir;
    const t = this.s.teams[this.def]!;
    t.teamPress = o.teamPress ?? 0;
    t.phase = TeamPhase.DEFEND;
    this.s.teams[this.opp]!.phase = TeamPhase.ATTACK;
    for (let k = 0; k < N; k++) {
      const p = this.oppP(k);
      [p.x, p.z] = this.w(k === 0 ? 50 : 30 + (k % 3) * 4, -25 + k * 5);
      p.vx = 0; p.vz = 0; p.moveMode = MoveMode.STOP;
    }
    const kp = this.defP(0);
    [kp.x, kp.z] = this.w(-49, 0);
  }

  /** Frame -> world. */
  w(u: number, v: number): [number, number] { return [this.dir * u, this.dir * v]; }
  /** World -> frame. */
  f(x: number, z: number): [number, number] { return [this.dir * x, this.dir * z]; }
  defSlot(k: number): number { return teamFirstSlot(this.def) + k; }
  oppSlot(k: number): number { return teamFirstSlot(this.opp) + k; }
  defP(k: number) { return this.s.players[this.defSlot(k)]!; }
  oppP(k: number) { return this.s.players[this.oppSlot(k)]!; }
  get team() { return this.s.teams[this.def]!; }

  /** Place defender k at a frame point, at rest. */
  put(k: number, u: number, v: number): void {
    const p = this.defP(k);
    [p.x, p.z] = this.w(u, v);
    p.vx = 0; p.vz = 0;
  }
  /** Park every defending outfielder far away (deep, spread) so a test controls who is near. */
  parkDefenders(u = -44): void {
    for (let k = 1; k < N; k++) this.put(k, u, -30 + k * 6);
  }
  /** Human controller 0 takes defender k. */
  control(k: number): void {
    const c = this.s.ctrl[0]!;
    if (c.slot >= 0) this.s.players[c.slot]!.ctrl = -1;
    c.slot = this.defSlot(k);
    this.defP(k).ctrl = 0;
  }

  private script(): void {
    for (const o of this.opps) {
      const p = this.oppP(o.k);
      [p.x, p.z] = this.w(o.u, o.v);
      [p.vx, p.vz] = this.w(o.vu ?? 0, o.vv ?? 0);
      const sp = Math.sqrt((o.vu ?? 0) ** 2 + (o.vv ?? 0) ** 2);
      if (sp > 0) { p.fx = p.vx / sp; p.fz = p.vz / sp; }
      p.moveMode = MoveMode.STOP;
    }
    const b = this.s.ball;
    if (this.ownerK >= 0) {
      const c = this.oppP(this.ownerK);
      b.owner = c.slot; b.heldBy = -1;
      b.x = c.x + c.fx * 0.4; b.z = c.z + c.fz * 0.4; b.y = 0.11;
      b.vx = c.vx; b.vz = c.vz; b.vy = 0;
      b.lastTouch = c.slot; b.lastTouchTeam = this.opp;
    } else if (this.ballScript) this.ballScript(this);
  }

  /** Team-AI stages for the defending side (no locomotion). */
  ai(): void {
    const s = this.s;
    this.script();
    const t = this.def;
    updateShape(s, t, NULL_SINK);
    resetJobs(s, t);
    assignChaser(s, t, NULL_SINK);
    if (this.withShape) assignDefensiveShape(s, t, NULL_SINK);
    assignPressing(s, t, NULL_SINK);
    if (this.withTransition) assignTransition(s, t, NULL_SINK);
    executeJobs(s, t, NULL_SINK);
  }

  /** One tick: AI + locomotion; scripted opponents advance by their velocity. */
  tick(): void {
    this.s.tick++;
    this.ai();
    locomotionTick(this.s, NULL_SINK);
    for (const o of this.opps) { o.u += (o.vu ?? 0) * DT; o.v += (o.vv ?? 0) * DT; }
  }
  run(n: number, each?: (r: Rig, i: number) => void): void { for (let i = 0; i < n; i++) { this.tick(); each?.(this, i); } }

  /** Defending slots holding a job. */
  withJob(job: AiJob): number[] {
    const out: number[] = [];
    for (let k = 0; k < N; k++) if (this.defP(k).job === job) out.push(this.defSlot(k));
    return out;
  }
  /** Frame position / target of a slot. */
  pos(slot: number): [number, number] { const p = this.s.players[slot]!; return this.f(p.x, p.z); }
  tgt(slot: number): [number, number] { const p = this.s.players[slot]!; return this.f(p.tgtX, p.tgtZ); }
  /** Back-line flag of a defending slot (4-4-2 etc.: formation DEF line). */
  isBack(slot: number): boolean {
    return slotLine(this.team.formation, this.s.players[slot]!.formIdx) === ShapeLine.DEF;
  }
}

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Unit vector from p toward our goal centre (frame). */
function goalDir(p: [number, number]): [number, number] {
  const dx = -HL - p[0], dz = -p[1];
  const l = Math.hypot(dx, dz);
  return [dx / l, dz / l];
}
/** Signed lateral offset of q from the line p -> our goal (frame). */
function lateral(p: [number, number], q: [number, number]): number {
  const g = goalDir(p);
  return (q[0] - p[0]) * -g[1] + (q[1] - p[1]) * g[0];
}
/** Distance of q along the line p -> our goal (frame). */
function along(p: [number, number], q: [number, number]): number {
  const g = goalDir(p);
  return (q[0] - p[0]) * g[0] + (q[1] - p[1]) * g[1];
}

const DEFS = [0, 1] as const;

/** Standard carrier rig: opponent 9 on the ball at (u, v), a few attackers around; defenders on their formation. */
function carrierRig(def: 0 | 1, u: number, v: number, o: Partial<RigOpts> = {}): Rig {
  const r = new Rig({ def, ...o });
  r.opps = [{ k: 9, u, v }, { k: 10, u: u - 2, v: v - 14 }, { k: 7, u: u + 6, v: v + 10 }];
  r.ownerK = 9;
  return r;
}

// ================================================================ primary presser

describe('TAI-05 primary presser', () => {
  for (const def of DEFS) {
    it(`exactly one primary presser, goal-side of the carrier at the standoff (def ${def})`, () => {
      // Formation positions: one presser, his target goal-side between the standoff circle and the arc radius.
      const r = carrierRig(def, -15, 5);
      r.ai();
      const pressers = r.withJob(AiJob.PRESS);
      expect(pressers).toHaveLength(1);
      expect(r.team.pressSlot).toBe(pressers[0]);
      expect(r.s.players[pressers[0]!]!.jobSlot).toBe(r.oppSlot(9));
      const so = pressStandoff(teamPressIntensity(r.s, r.def));
      expect(so).toBeGreaterThanOrEqual(1.5);
      expect(so).toBeLessThanOrEqual(2.5);
      const c = r.pos(r.oppSlot(9));
      const d0 = dist(r.tgt(pressers[0]!), c);
      expect(d0).toBeGreaterThanOrEqual(so - 1e-9);
      expect(d0).toBeLessThanOrEqual(so / LT.arcStepCos + 1e-9);
      // A presser already goal-side on the carrier's path to goal gets exactly the goal-side spot at the standoff.
      const q = carrierRig(def, -15, 5);
      q.parkDefenders();
      const g = goalDir([-15, 5]);
      q.put(6, -15 + g[0] * 8, 5 + g[1] * 8);
      q.ai();
      expect(q.withJob(AiJob.PRESS)).toEqual([q.defSlot(6)]);
      const cq = q.pos(q.oppSlot(9));
      const tg = q.tgt(q.defSlot(6));
      expect(dist(tg, cq)).toBeCloseTo(so, 6);
      expect(along(cq, tg)).toBeCloseTo(so, 6);
      expect(Math.abs(lateral(cq, tg))).toBeLessThan(1e-6);
    });

    it(`the presser is the best arrival, not a far team-mate (def ${def})`, () => {
      const r = carrierRig(def, -10, 0);
      r.parkDefenders();
      r.put(7, -14, 3); // 5 m goal-side
      r.put(6, -22, -4); // further
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(7));
      expect(r.withJob(AiJob.PRESS)).toEqual([r.defSlot(7)]);
    });

    it(`the presser stops 1.5-2.5 m goal-side and jockeys facing the ball: no diving in, no orbiting (def ${def})`, () => {
      const r = carrierRig(def, -15, 5);
      r.parkDefenders();
      r.put(6, -8, 10); // upfield and wide: has to get round the carrier
      let minD = 1e9;
      r.run(300, (rr) => {
        const ps = rr.team.pressSlot;
        if (ps >= 0) minD = Math.min(minD, dist(rr.pos(ps), rr.pos(rr.oppSlot(9))));
      });
      const ps = r.team.pressSlot;
      expect(ps).toBe(r.defSlot(6));
      const p = r.s.players[ps]!;
      const c = r.pos(r.oppSlot(9));
      const d = dist(r.pos(ps), c);
      expect(d).toBeGreaterThanOrEqual(1.4);
      expect(d).toBeLessThanOrEqual(2.6);
      expect(along(c, r.pos(ps)) / d).toBeGreaterThan(0.9); // goal-side
      expect(Math.hypot(p.vx, p.vz)).toBeLessThan(0.3); // settled: no orbiting
      expect(p.lookAt).toBe(1); // facing the ball
      expect(minD).toBeGreaterThanOrEqual(1.4); // never dives in
    });

    it(`a presser directly behind the carrier circles round at the standoff (def ${def})`, () => {
      const r = carrierRig(def, -15, 0);
      r.parkDefenders();
      r.put(6, -10, 0); // directly upfield of the carrier
      let minD = 1e9;
      r.run(200, (rr) => {
        if (rr.team.pressSlot >= 0) minD = Math.min(minD, dist(rr.pos(rr.team.pressSlot), rr.pos(rr.oppSlot(9))));
      });
      expect(r.team.pressSlot).toBe(r.defSlot(6));
      const c = r.pos(r.oppSlot(9));
      const pp = r.pos(r.defSlot(6));
      expect(along(c, pp) / dist(pp, c)).toBeGreaterThan(0.9);
      expect(minD).toBeGreaterThanOrEqual(1.4);
    });

    it(`hysteresis: the current presser keeps the job against a marginally faster team-mate (def ${def})`, () => {
      const r = carrierRig(def, -12, 0);
      r.withShape = false;
      r.parkDefenders();
      const g = goalDir([-12, 0]);
      const at = (d: number, lat: number): [number, number] => [-12 + g[0] * d - g[1] * lat, g[1] * d + g[0] * lat];
      const [au, av] = at(7, 3);
      const [bu, bv] = at(7, -3);
      // Same attributes, mirror positions: an exact tie, which the lower slot would win.
      Object.assign(r.s.attrs[r.defSlot(7)]!, r.s.attrs[r.defSlot(6)]!);
      r.put(6, au, av);
      r.put(7, bu, bv);
      r.team.pressSlot = r.defSlot(7);
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(7)); // the incumbent keeps a tie
      // A marginal gain (well under pressHystTicks) for the challenger does not flip the job.
      const [cu, cv] = at(6.6, 3);
      r.put(6, cu, cv);
      r.put(7, bu, bv);
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(7));
      // A clear gain does.
      const [du, dv] = at(3, 2);
      r.put(6, du, dv);
      r.put(7, bu, bv);
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(6));
      // Without an incumbent the tie goes to the lower slot.
      r.put(6, au, av);
      r.put(7, bu, bv);
      r.team.pressSlot = -1;
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(6));
    });

    it(`glitch: presser flip-flops or jitters around the carrier (def ${def})`, () => {
      // Two midfielders mirror-placed about the carrier's goal line; the carrier drifts across slowly.
      const r = carrierRig(def, -12, 0);
      r.parkDefenders();
      r.put(6, -20, 4);
      r.put(7, -20, -4);
      const o = r.opps[0]!;
      // The carrier weaves across (smooth velocity, 2 s period): no instant velocity flips.
      const vAt = (i: number): number => 1.5 * Math.cos((2 * Math.PI * i) / 120);
      o.vv = vAt(0);
      let changes = 0;
      let last = -2;
      let jitter = 0;
      let prevTgt: [number, number] | null = null;
      r.run(360, (rr, i) => {
        o.vv = vAt(i + 1);
        const ps = rr.team.pressSlot;
        if (ps !== last) { if (last !== -2) changes++; last = ps; prevTgt = null; }
        if (ps >= 0) {
          const tg = rr.tgt(ps);
          if (prevTgt) jitter = Math.max(jitter, dist(tg, prevTgt));
          prevTgt = tg;
        }
      });
      expect(changes).toBeLessThanOrEqual(1);
      // The target moves with the carrier (1.5 m/s: 0.025 m per tick + the lead change), never jumps.
      expect(jitter).toBeLessThan(0.1);
    });
  }
});

// ================================================================ cover

describe('TAI-05 cover', () => {
  for (const def of DEFS) {
    it(`cover is the next man, goal-side behind the presser on the carrier's path (def ${def})`, () => {
      const r = carrierRig(def, -8, 4);
      r.ai();
      const ps = r.team.pressSlot;
      const cs = r.team.coverSlot;
      expect(ps).toBeGreaterThanOrEqual(0);
      expect(cs).toBeGreaterThanOrEqual(0);
      expect(cs).not.toBe(ps);
      expect(r.withJob(AiJob.COVER)).toContain(cs);
      const c = r.pos(r.oppSlot(9));
      const pt = r.tgt(ps);
      const ct = r.tgt(cs);
      expect(along(c, ct)).toBeGreaterThan(along(c, pt) + 3); // behind the presser
      expect(dist(ct, [-HL, 0])).toBeLessThan(dist(pt, [-HL, 0])); // nearer our goal
      expect(Math.abs(lateral(c, ct))).toBeLessThan(1); // on the carrier's path to goal
    });

    it(`the cover never stands deeper than our line while the ball is in front of it (def ${def})`, () => {
      let clamped = 0;
      let covered = 0;
      for (const [u, v] of [[-24, 0], [-28, 10], [-20, -15], [-30, 0], [-34, -6]] as const) {
        const r = carrierRig(def, u, v);
        r.run(40, (rr) => {
          const cs = rr.team.coverSlot;
          if (cs < 0) return;
          covered++;
          const lineU = rr.dir * rr.team.lineX;
          const bu = rr.dir * rr.s.ball.x;
          const tu = rr.tgt(cs)[0];
          if (bu > lineU) {
            expect(tu).toBeGreaterThanOrEqual(lineU - 1e-9);
            if (tu === lineU) clamped++;
          }
          expect(tu).toBeGreaterThan(-HL + 5.5);
        });
      }
      expect(covered).toBeGreaterThan(100);
      expect(clamped).toBeGreaterThan(0); // the clamp did bind
    });

    it(`just lost the ball: a player caught upfield is never the cover; TAI-06 recovery runs keep the cover (def ${def})`, () => {
      const r = carrierRig(def, -6, 2);
      r.withTransition = true;
      r.team.phase = TeamPhase.TRANSITION_DEFEND;
      r.team.lostT = 0;
      r.parkDefenders(-38);
      r.put(6, -4, 6); // caught upfield, nearest to the cover point's lane
      r.put(7, -3, -4); // caught upfield
      r.put(5, -24, 10); // goal-side
      let covered = 0;
      r.run(30, (rr) => {
        const bu = rr.dir * rr.s.ball.x;
        const cs = rr.team.coverSlot;
        if (cs >= 0) {
          covered++;
          expect(rr.s.players[cs]!.job).toBe(AiJob.COVER);
          expect(rr.pos(cs)[0]).toBeLessThan(bu - LT.caughtMargin);
        }
        for (const sl of rr.withJob(AiJob.TRACK_RUNNER)) expect(rr.pos(sl)[0]).toBeLessThan(bu - LT.caughtMargin);
      });
      expect(covered).toBeGreaterThan(0);
    });

    it(`no cover and no presser while the carrier is out of range (def ${def})`, () => {
      const r = carrierRig(def, 40, 0);
      r.parkDefenders(-30);
      r.ai();
      expect(r.team.pressSlot).toBe(-1);
      expect(r.team.coverSlot).toBe(-1);
      expect(r.withJob(AiJob.PRESS)).toHaveLength(0);
    });
  }
});

// ================================================================ human / CPU-controlled team-mates, second defender

describe('TAI-05 controlled team-mates and the second defender', () => {
  for (const def of DEFS) {
    it(`human controls the nearest: the AI presser is the next, as a support on the other side (def ${def})`, () => {
      const r = carrierRig(def, -12, 2, { human: true });
      r.parkDefenders();
      r.put(6, -14, 3); // the human's man, 2.2 m goal-side
      r.put(7, -18, -3); // next
      r.put(5, -24, 0); // a cover
      r.control(6);
      r.ai();
      const ps = r.team.pressSlot;
      expect(ps).toBe(r.defSlot(7));
      expect(ps).not.toBe(r.defSlot(6));
      const ai = r.withJob(AiJob.PRESS);
      expect(ai).toEqual([r.defSlot(7)]);
      const c = r.pos(r.oppSlot(9));
      const tg = r.tgt(ps);
      expect(dist(tg, c)).toBeGreaterThanOrEqual(LT.supportDist - 0.5); // support, not on the carrier
      expect(Math.sign(lateral(c, tg))).toBe(-Math.sign(lateral(c, r.pos(r.defSlot(6))))); // other side
      expect(r.team.coverSlot).toBeGreaterThanOrEqual(0); // the human presses: cover behind him
    });

    it(`human controls the nearest with team press: the AI presser joins him on the carrier (def ${def})`, () => {
      const r = carrierRig(def, -12, 2, { human: true, teamPress: 1 });
      r.parkDefenders();
      r.put(6, -14, 3);
      r.put(7, -18, -3);
      r.control(6);
      r.ai();
      const ps = r.team.pressSlot;
      expect(ps).toBe(r.defSlot(7));
      expect(r.withJob(AiJob.PRESS)).toEqual([r.defSlot(7)]);
      const so = pressStandoff(teamPressIntensity(r.s, r.def));
      expect(dist(r.tgt(ps), r.pos(r.oppSlot(9)))).toBeCloseTo(so, 6);
    });

    it(`an idle controlled player away from the carrier does not stop the AI press (def ${def})`, () => {
      const r = carrierRig(def, -12, 2, { human: true });
      r.parkDefenders();
      r.put(6, -12, 12); // controlled, 10 m away, standing
      r.put(7, -18, -3);
      r.control(6);
      r.ai();
      const ps = r.team.pressSlot;
      expect(ps).toBe(r.defSlot(7));
      const c = r.pos(r.oppSlot(9));
      const so = pressStandoff(teamPressIntensity(r.s, r.def));
      const tg = r.tgt(ps);
      // Front spot: on the carrier's line to goal, between the standoff and the arc radius (he comes from the side).
      expect(Math.abs(lateral(c, tg))).toBeLessThan(1e-6);
      expect(along(c, tg)).toBeGreaterThanOrEqual(so - 1e-9);
      expect(along(c, tg)).toBeLessThanOrEqual(so / LT.arcStepCos + 1e-9);
    });

    it(`the called second defender presses hard, even from beyond the engage radius (def ${def})`, () => {
      const r = carrierRig(def, -12, 2, { human: true });
      r.parkDefenders(-46);
      r.put(6, -14, 3);
      r.put(7, -18, -3); // nearest AI
      r.put(9, -10, 22); // far: 20 m
      r.control(6);
      r.s.ctrl[0]!.secondDef = r.defSlot(9);
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(9));
      const p = r.defP(9);
      expect(p.job).toBe(AiJob.PRESS);
      const ball: [number, number] = r.f(r.s.ball.x, r.s.ball.z);
      expect(dist(r.tgt(r.defSlot(9)), ball)).toBeCloseTo(LT.hardStandoff, 6); // hard: at the ball
      expect(p.tgtSpeed).toBeCloseTo(r.s.attrs[r.defSlot(9)]!.topSpeed, 6);
      // Double team: on the side away from the human's man.
      const c = r.pos(r.oppSlot(9));
      expect(Math.sign(lateral(c, r.tgt(r.defSlot(9))))).toBe(-Math.sign(lateral(c, r.pos(r.defSlot(6)))));
      // Still one AI presser on the carrier (the nearest AI is not pressing too).
      expect(r.withJob(AiJob.PRESS)).toEqual([r.defSlot(9)]);
      // He keeps pressing and closes right in.
      r.run(240);
      expect(r.team.pressSlot).toBe(r.defSlot(9));
      expect(dist(r.pos(r.defSlot(9)), ball)).toBeLessThan(2);
    });

    it(`the second defender called while the human is away takes the goal-side spot, hard (def ${def})`, () => {
      const r = carrierRig(def, -12, 2, { human: true });
      r.parkDefenders(-46);
      r.put(6, -30, 20); // human far away
      r.put(9, -18, 6);
      r.control(6);
      r.s.ctrl[0]!.secondDef = r.defSlot(9);
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(9));
      const ball: [number, number] = r.f(r.s.ball.x, r.s.ball.z);
      const tg = r.tgt(r.defSlot(9));
      const d = dist(tg, ball);
      expect(d).toBeGreaterThanOrEqual(LT.hardStandoff - 1e-9);
      expect(d).toBeLessThanOrEqual(LT.hardStandoff / LT.arcStepCos + 1e-9);
      expect(along(ball, tg) / d).toBeGreaterThan(0.99); // goal-side of the ball
      expect(r.defP(9).tgtSpeed).toBeCloseTo(r.s.attrs[r.defSlot(9)]!.topSpeed, 6);
    });

    it(`a CPU-controlled team-mate counts like a human one (def ${def})`, () => {
      const r = carrierRig(def, -12, 2);
      r.parkDefenders();
      r.put(6, -14, 3);
      r.put(7, -18, -3);
      const c = r.s.ctrl[2 + r.def]!;
      expect(c.kind).toBe(ControllerKind.CPU);
      c.slot = r.defSlot(6);
      r.defP(6).ctrl = 2 + r.def;
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(7));
      expect(dist(r.tgt(r.defSlot(7)), r.pos(r.oppSlot(9)))).toBeGreaterThanOrEqual(LT.supportDist - 0.5);
    });

    it(`a second defender that is not a valid job-driven team-mate is ignored (def ${def})`, () => {
      const r = carrierRig(def, -12, 2, { human: true });
      r.parkDefenders();
      r.put(7, -16, 2);
      for (const bad of [-1, r.oppSlot(3), r.defSlot(0), 99, 2.5]) {
        r.s.ctrl[0]!.secondDef = bad;
        r.ai();
        expect(r.team.pressSlot).toBe(r.defSlot(7));
      }
    });
  }
});

// ================================================================ team press, engagement, intensity

describe('TAI-05 team press, engagement and intensity', () => {
  for (const def of DEFS) {
    it(`glitch: two teammates press the carrier at once — one AI presser unless team press (def ${def})`, () => {
      const forms = [FormationId.F442, FormationId.F433, FormationId.F352, FormationId.F41212];
      let cases = 0;
      for (const form of forms) {
        for (let u = -44; u <= 40; u += 12) {
          for (let v = -28; v <= 28; v += 14) {
            const r = carrierRig(def, u, v, { form });
            r.run(20, (rr) => {
              const c = rr.pos(rr.oppSlot(9));
              let near = 0;
              for (const sl of rr.withJob(AiJob.PRESS)) if (dist(rr.tgt(sl), c) < 3) near++;
              expect(near).toBeLessThanOrEqual(1);
              expect(rr.withJob(AiJob.PRESS).length).toBeLessThanOrEqual(1);
            });
            cases++;
          }
        }
      }
      expect(cases).toBeGreaterThan(100);
    });

    it(`team press: two pressers on the carrier, from both sides (def ${def})`, () => {
      const r = carrierRig(def, -10, 0, { teamPress: 1 });
      r.parkDefenders();
      r.put(6, -15, 4);
      r.put(7, -16, -5);
      r.ai();
      const ps = r.withJob(AiJob.PRESS);
      expect(ps).toHaveLength(2);
      expect(ps).toContain(r.team.pressSlot);
      const c = r.pos(r.oppSlot(9));
      const so = pressStandoff(teamPressIntensity(r.s, r.def));
      for (const sl of ps) {
        expect(dist(r.tgt(sl), c)).toBeGreaterThanOrEqual(so - 1e-9);
        expect(dist(r.tgt(sl), c)).toBeLessThanOrEqual(so / LT.arcStepCos + 1e-9);
      }
      const second = ps.find((sl) => sl !== r.team.pressSlot)!;
      expect(dist(r.tgt(second), c)).toBeCloseTo(so, 6);
      expect(Math.abs(lateral(c, r.tgt(second)))).toBeGreaterThan(1); // from the side
      r.run(120);
      const near = r.withJob(AiJob.PRESS).filter((sl) => dist(r.pos(sl), c) < 3);
      expect(near).toHaveLength(2);
    });

    it(`engagement: a carrier beyond the engage radius is not pressed; team press reaches further (def ${def})`, () => {
      const make = (tp: 0 | 1) => {
        const r = carrierRig(def, 20, 0, { teamPress: tp });
        r.parkDefenders(-40);
        r.put(9, 6, 0); // 14 m goal-side of the carrier
        return r;
      };
      const a = make(0);
      const R0 = pressEngageRadius(teamPressIntensity(a.s, a.def), false, 1);
      expect(R0).toBeLessThan(14);
      a.ai();
      expect(a.team.pressSlot).toBe(-1);
      const b = make(1);
      const R1 = pressEngageRadius(teamPressIntensity(b.s, b.def), false, 1.4);
      expect(R1).toBeGreaterThan(14);
      b.ai();
      expect(b.team.pressSlot).toBe(b.defSlot(9));
    });

    it(`engagement reaches further with the carrier in our defensive third (def ${def})`, () => {
      const r = carrierRig(def, -25, 0);
      r.parkDefenders(-50);
      r.put(9, -39, 0); // 14 m goal-side
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(9));
    });
  }

  it('intensity: difficulty ladder, human default, team press, focus and counter-press', () => {
    const at = (o: Partial<RigOpts>, mut?: (r: Rig) => void) => {
      const r = new Rig({ def: 1, ...o });
      mut?.(r);
      return teamPressIntensity(r.s, 1);
    };
    const lv = [Difficulty.BEGINNER, Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS, Difficulty.LEGEND]
      .map((d) => at({ difficulty: d }));
    for (let i = 1; i < lv.length; i++) expect(lv[i]!).toBeGreaterThan(lv[i - 1]!);
    expect(at({ human: true })).toBeCloseTo(LT.humanPressIntensity, 9);
    const base = at({});
    expect(at({ teamPress: 1 })).toBeCloseTo(Math.min(1, base + 0.2), 9);
    expect(at({}, (r) => { r.team.focus = TacticalFocus.DEFENDING; })).toBeCloseTo(base * 0.85, 9);
    expect(at({}, (r) => { r.team.phase = TeamPhase.TRANSITION_DEFEND; })).toBeCloseTo(base + LT.counterPressAdd, 9);
    for (const v of [...lv, at({ teamPress: 1, difficulty: Difficulty.LEGEND })]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Higher intensity: closer standoff, larger engage radius.
    expect(pressStandoff(1)).toBeLessThan(pressStandoff(0));
    expect(pressStandoff(0)).toBeCloseTo(2.5, 9);
    expect(pressStandoff(1)).toBeCloseTo(1.5, 9);
    expect(pressEngageRadius(1, false, 1)).toBeGreaterThan(pressEngageRadius(0, false, 1));
    expect(pressEngageRadius(0.5, true, 1)).toBeCloseTo(pressEngageRadius(0.5, false, 1) * LT.dangerScale, 9);
    expect(pressEngageRadius(0.5, false, 1)).toBeCloseTo(T_AI.pressDistance * (LT.engageBase + LT.engageGain * 0.5), 9);
  });

  it('a Legend side presses closer and faster than a Beginner side', () => {
    const go = (d: Difficulty) => {
      const r = carrierRig(0, -12, 0, { difficulty: d });
      r.parkDefenders();
      r.put(6, -17, 0.5); // 5 m goal-side: engaged at every level
      r.ai();
      expect(r.team.pressSlot).toBe(r.defSlot(6));
      return { d: dist(r.tgt(r.defSlot(6)), r.pos(r.oppSlot(9))), v: r.defP(6).tgtSpeed };
    };
    const lo = go(Difficulty.BEGINNER);
    const hi = go(Difficulty.LEGEND);
    expect(hi.d).toBeLessThan(lo.d);
    expect(hi.v).toBeGreaterThan(lo.v);
  });
});

// ================================================================ runners

describe('TAI-05 tracking runners', () => {
  for (const def of DEFS) {
    it(`a forward run into our defensive third is tracked goal-side by a midfielder (def ${def})`, () => {
      const r = carrierRig(def, 0, -18);
      r.opps.push({ k: 7, u: -12, v: 6, vu: -6.5, vv: 0 }); // CM bursting forward
      const runner = r.oppSlot(7);
      let tracker = -1;
      let changes = 0;
      let minGoalSide = 1e9;
      r.run(70, (rr) => {
        const t = rr.withJob(AiJob.TRACK_RUNNER).filter((sl) => rr.s.players[sl]!.jobSlot === runner);
        expect(t.length).toBeLessThanOrEqual(1);
        if (t.length === 1) {
          if (tracker !== -1 && t[0] !== tracker) changes++;
          tracker = t[0]!;
          expect(rr.isBack(tracker)).toBe(false);
          // target goal-side of the runner (or held on our line)
          const tg = rr.tgt(tracker);
          const ru = rr.pos(runner)[0];
          const lineU = rr.dir * rr.team.lineX;
          if (tg[0] > lineU + 1e-9) minGoalSide = Math.min(minGoalSide, ru - tg[0]);
        }
      });
      expect(tracker).toBeGreaterThanOrEqual(0);
      expect(changes).toBe(0);
      expect(minGoalSide).toBeGreaterThan(0);
      // He actually runs with the runner.
      const d = dist(r.pos(tracker), r.pos(runner));
      expect(d).toBeLessThan(6);
    });

    it(`no tracking without a forward run, outside our third, or of an offside-flagged runner (def ${def})`, () => {
      const cases: ((r: Rig) => void)[] = [
        (r) => { r.opps.push({ k: 7, u: -12, v: 6, vu: 0, vv: 5 }); }, // sideways
        (r) => { r.opps.push({ k: 7, u: 20, v: 6, vu: -6, vv: 0 }); }, // far from our third
        (r) => {
          r.opps.push({ k: 7, u: -12, v: 6, vu: -6.5, vv: 0 });
          r.s.match.offside.passTeam = r.opp;
          r.s.match.offside.flags = 1 << r.oppSlot(7);
        },
      ];
      for (const setup of cases) {
        const r = carrierRig(def, 0, -18);
        setup(r);
        r.ai();
        expect(r.withJob(AiJob.TRACK_RUNNER).filter((sl) => r.s.players[sl]!.jobSlot === r.oppSlot(7))).toHaveLength(0);
      }
    });

    it(`back-liners never track; a runner on our line is TAI-04's (def ${def})`, () => {
      const r = carrierRig(def, -5, -20);
      r.opps.push({ k: 7, u: -20, v: 4, vu: -6, vv: 0 }, { k: 8, u: -24, v: 20, vu: -5, vv: -1 }, { k: 6, u: -15, v: -2, vu: -7, vv: 0 });
      let tracks = 0;
      r.run(40, (rr) => {
        for (const sl of rr.withJob(AiJob.TRACK_RUNNER)) expect(rr.isBack(sl)).toBe(false);
        tracks += rr.withJob(AiJob.TRACK_RUNNER).length;
        expect(rr.withJob(AiJob.TRACK_RUNNER).length).toBeLessThanOrEqual(LT.trackMax);
      });
      expect(tracks).toBeGreaterThan(0);
    });

    it(`a tracker is never pulled deeper than our line while the ball is in front of it (def ${def})`, () => {
      const r = carrierRig(def, 5, -10);
      r.opps.push({ k: 7, u: -22, v: 6, vu: -7, vv: 0 });
      let held = 0;
      r.run(60, (rr) => {
        const lineU = rr.dir * rr.team.lineX;
        const bu = rr.dir * rr.s.ball.x;
        for (const sl of rr.withJob(AiJob.TRACK_RUNNER)) {
          if (bu <= lineU) continue;
          expect(rr.tgt(sl)[0]).toBeGreaterThanOrEqual(lineU - 1e-9);
          if (rr.tgt(sl)[0] === lineU) held++;
        }
      });
      expect(held).toBeGreaterThan(0); // the runner went beyond our line: his tracker held on it
    });
  }
});

// ================================================================ pass in flight, other states

describe('TAI-05 pass in flight and inactive states', () => {
  for (const def of DEFS) {
    it(`opponent pass in flight: the receiver is pressed at the reception point; the chaser is not the presser (def ${def})`, () => {
      const r = new Rig({ def });
      r.opps = [{ k: 9, u: -5, v: -10 }, { k: 10, u: -14, v: 8 }];
      r.put(7, -20, 4); // within range of the reception point (the nearest man will be the chaser)
      const recv = r.oppSlot(10);
      r.ballScript = (rr) => {
        const b = rr.s.ball;
        const [x, z] = rr.w(-9, -2);
        const [vx, vz] = rr.w(-8, 8);
        b.owner = -1; b.heldBy = -1; b.x = x; b.z = z; b.y = 0.11; b.vx = vx; b.vz = vz; b.vy = 0; b.grounded = 1;
        b.lastTouch = rr.oppSlot(9); b.lastTouchTeam = rr.opp; b.lastKickBy = rr.oppSlot(9); b.lastKickTeam = rr.opp;
        b.passTarget = recv;
        [b.passX, b.passZ] = rr.w(-14, 7);
      };
      r.ai();
      const ps = r.team.pressSlot;
      expect(ps).toBeGreaterThanOrEqual(0);
      expect(ps).not.toBe(r.team.chaser);
      expect(r.s.players[ps]!.jobSlot).toBe(recv);
      const tg = r.tgt(ps);
      const pt: [number, number] = [-14, 7];
      const so = pressStandoff(teamPressIntensity(r.s, r.def));
      expect(dist(tg, pt)).toBeLessThanOrEqual(so / LT.arcStepCos + 1e-6);
      expect(r.withJob(AiJob.CHASE_LOOSE)).toHaveLength(1);
    });

    it(`nothing with our ball, a loose ball nobody passed, a keeper holding, or outside IN_PLAY (def ${def})`, () => {
      const check = (r: Rig, trackOk: boolean) => {
        r.team.pressSlot = 5; r.team.coverSlot = 6; // stale values must be cleared
        r.ai();
        expect(r.team.pressSlot).toBe(-1);
        expect(r.team.coverSlot).toBe(-1);
        expect(r.withJob(AiJob.PRESS)).toHaveLength(0);
        if (!trackOk) expect(r.withJob(AiJob.TRACK_RUNNER)).toHaveLength(0);
      };
      // Our ball.
      const a = new Rig({ def });
      a.opps = [{ k: 7, u: -12, v: 6, vu: -6.5 }];
      a.ballScript = (rr) => { const b = rr.s.ball; const p = rr.defP(6); b.owner = p.slot; b.heldBy = -1; b.x = p.x; b.z = p.z; };
      check(a, false);
      // Loose ball, last touched by us.
      const b0 = new Rig({ def });
      b0.ballScript = (rr) => {
        const b = rr.s.ball; b.owner = -1; b.heldBy = -1; b.x = 0; b.z = 0; b.vx = 3; b.vz = 0;
        b.lastTouchTeam = rr.def; b.passTarget = -1;
      };
      check(b0, false);
      // Loose ball, last touched by them, no pass.
      const c0 = new Rig({ def });
      c0.ballScript = (rr) => {
        const b = rr.s.ball; b.owner = -1; b.heldBy = -1; b.x = 0; b.z = 0; b.vx = 3; b.vz = 0;
        b.lastTouchTeam = rr.opp; b.passTarget = -1;
      };
      check(c0, false);
      // Their keeper holds the ball: no press (runners may still be tracked).
      const d0 = new Rig({ def });
      d0.opps = [{ k: 0, u: 46, v: 0 }];
      d0.ballScript = (rr) => {
        const b = rr.s.ball; const k = rr.oppP(0); b.owner = k.slot; b.heldBy = k.slot; b.x = k.x; b.z = k.z; b.y = 1;
      };
      check(d0, true);
      // Not IN_PLAY: assignPressing clears and gives no jobs.
      const e0 = carrierRig(def, -12, 0);
      e0.ai();
      expect(e0.team.pressSlot).toBeGreaterThanOrEqual(0);
      e0.s.match.phase = MatchPhase.THROW_IN;
      resetJobs(e0.s, e0.def);
      assignPressing(e0.s, e0.def, NULL_SINK);
      expect(e0.team.pressSlot).toBe(-1);
      expect(e0.team.coverSlot).toBe(-1);
      expect(e0.withJob(AiJob.PRESS)).toHaveLength(0);
    });

    it(`corrupt inputs (NaN carrier, NaN pass point) never write a non-finite target (def ${def})`, () => {
      const r = carrierRig(def, -12, 0);
      r.ai();
      const c = r.oppP(9);
      c.vx = NaN;
      resetJobs(r.s, r.def);
      assignPressing(r.s, r.def, NULL_SINK);
      for (let k = 1; k < N; k++) {
        const p = r.defP(k);
        expect(Number.isFinite(p.tgtX) && Number.isFinite(p.tgtZ) && Number.isFinite(p.tgtSpeed)).toBe(true);
      }
      c.x = NaN;
      resetJobs(r.s, r.def);
      assignPressing(r.s, r.def, NULL_SINK);
      expect(r.team.pressSlot).toBe(-1);
      for (let k = 1; k < N; k++) expect(Number.isFinite(r.defP(k).tgtX)).toBe(true);
    });
  }
});

// ================================================================ determinism and mirror symmetry

describe('TAI-05 determinism', () => {
  it('same setup, same ticks -> identical state hash', () => {
    const make = () => {
      const r = carrierRig(0, -10, 6, { teamPress: 1 });
      r.opps.push({ k: 7, u: -12, v: 6, vu: -6.5 });
      r.run(120, (rr, i) => { rr.opps[0]!.vv = i % 60 < 30 ? 2 : -2; });
      return hashState(r.s);
    };
    expect(make()).toBe(make());
  });

  it('assignPressing is an exact mirror image for the two attack directions', () => {
    // Same squad attributes on both sides, mirrored positions: every job target mirrors exactly.
    const a = carrierRig(0, -10, 6);
    const b = carrierRig(1, -10, 6);
    for (const r of [a, b]) r.withShape = false;
    for (let i = 0; i < N; i++) {
      Object.assign(b.s.attrs[N + i]!, a.s.attrs[i]!);
      Object.assign(b.s.attrs[i]!, a.s.attrs[N + i]!);
    }
    for (const r of [a, b]) {
      r.opps.push({ k: 7, u: -12, v: 6, vu: -6.5, vv: 1 });
      for (let k = 1; k < N; k++) r.put(k, -30 + k * 3, -20 + ((k * 7) % 40));
    }
    for (let t = 0; t < 30; t++) {
      a.tick();
      b.tick();
      for (let k = 0; k < N; k++) {
        const pa = a.defP(k), pb = b.defP(k);
        expect(pb.job).toBe(pa.job);
        expect(pb.tgtX === -pa.tgtX && pb.tgtZ === -pa.tgtZ).toBe(true);
      }
      expect(b.team.pressSlot - N).toBe(a.team.pressSlot);
      expect(b.team.coverSlot - (b.team.coverSlot < 0 ? 0 : N)).toBe(a.team.coverSlot);
    }
  });
});

// ================================================================ full pipeline

describe('TAI-05 in the full sim pipeline', () => {
  it('bot v bot: pressSlot is always an active PRESS player of its team; at most one AI presser on the carrier', () => {
    const s = makeScenario({ seed: 11, humans: 0, config: { halfMinutes: 2 } });
    let aiRanInPlay = false;
    let checked = 0;
    let pressed = 0;
    runTicks(s, 3600, (_tick, st) => { aiRanInPlay = st.match.phase === MatchPhase.IN_PLAY; }, {
      check: 'core',
      until: (st) => {
        if (!aiRanInPlay) return false;
        for (let team = 0; team < 2; team++) {
          const t = st.teams[team]!;
          for (const sl of [t.pressSlot, t.coverSlot]) {
            if (sl < 0) continue;
            const p = st.players[sl]!;
            expect(p.team).toBe(team);
            expect(p.active).toBe(1);
            expect(p.ctrl).toBe(-1);
          }
          if (t.pressSlot >= 0) { expect(st.players[t.pressSlot]!.job).toBe(AiJob.PRESS); pressed++; }
          if (t.coverSlot >= 0) expect(st.players[t.coverSlot]!.job).toBe(AiJob.COVER);
          const o = st.ball.owner;
          if (o >= 0 && st.players[o]!.team !== team) {
            let near = 0;
            for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + N; i++) {
              const p = st.players[i]!;
              if (p.job === AiJob.PRESS && Math.hypot(p.tgtX - st.players[o]!.x, p.tgtZ - st.players[o]!.z) < 3) near++;
            }
            expect(near).toBeLessThanOrEqual(t.teamPress ? 2 : 1);
          }
        }
        checked++;
        return false;
      },
    });
    expect(checked).toBeGreaterThan(1000);
    expect(pressed).toBeGreaterThan(100);
  });
});
