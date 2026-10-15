/**
 * TAI-08 CPU ball-carrier decision engine: scripted situations, through the real step pipeline (resolver, SIM-16
 * switching, SIM-06 dribbling, SIM-08 passes, SIM-13 skills) and by direct calls. The modules the engine consults that
 * are still Wave-1 stubs are replaced by contract doubles (tests/scenario/tai-08-helpers.ts): TAI-09 scorePassOptions,
 * TAI-10 estimateXg / bestDribble / chooseSkill, and the SIM-09/10/11 starters (recording doubles: they begin a charging
 * action so the press / hold / release can be checked). TAI-12 styleWeights can be forced per test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CPU_CONTROLLER_BASE, GOAL_HALF_WIDTH, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, Difficulty, GestureKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, clearInputFrame, copyInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { CpuPlan, type SimState } from '../../src/contracts/state';
import type { ActionRequest, StyleWeights } from '../../src/contracts/systems';
import { T_AI, T_INPUT, T_LEVEL, T_PASS } from '../../src/contracts/tuning';
import { cpuCarrier, LOCAL_TUNING as LT } from '../../src/ai/cpu/carrier';
import { cloneState } from '../../src/sim/core/clone';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { makeScenario, runTicks, type ScenarioPlayer } from '../harness/scenario';
import { CTL, resetCtl } from './tai-08-helpers';

vi.mock('../../src/ai/cpu/passing', async (orig) => {
  const h = await import('./tai-08-helpers');
  return { ...(await orig<typeof import('../../src/ai/cpu/passing')>()), scorePassOptions: h.scorePassDouble };
});
vi.mock('../../src/ai/cpu/shooting', async () => {
  const h = await import('./tai-08-helpers');
  // [QF-2] lastXgBlock / shotLaneClear: the double's xG has no separate blocker factor and every lane is clear.
  return {
    estimateXg: h.xgDouble, bestDribble: h.dribbleDouble, chooseSkill: h.skillDouble, lastXgBlock: () => 1, shotLaneClear: () => 1,
    // The double gives no exit suggestion: the carrier keeps its own side exit.
    SKILL_CHOICE: { move: 0, side: 0, dirX: 0, dirZ: 0 },
  };
});
vi.mock('../../src/ai/cpu/levels', async (orig) => {
  const h = await import('./tai-08-helpers');
  const real = await orig<typeof import('../../src/ai/cpu/levels')>();
  return { ...real, styleWeights: (st: number) => h.CTL.style ?? real.styleWeights(st) };
});
vi.mock('../../src/sim/kicks/shot', async (orig) => {
  const h = await import('./tai-08-helpers');
  return { ...(await orig<typeof import('../../src/sim/kicks/shot')>()), startShot: (st: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => h.starterDouble('shot', st, slot, kind, req, ev) };
});
vi.mock('../../src/sim/kicks/lob', async (orig) => {
  const h = await import('./tai-08-helpers');
  return { ...(await orig<typeof import('../../src/sim/kicks/lob')>()), startLob: (st: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => h.starterDouble('lob', st, slot, kind, req, ev) };
});
vi.mock('../../src/sim/kicks/through', async (orig) => {
  const h = await import('./tai-08-helpers');
  return { ...(await orig<typeof import('../../src/sim/kicks/through')>()), startThrough: (st: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink) => h.starterDouble('through', st, slot, kind, req, ev) };
});

// ---------------------------------------------------------------- setup

/** Default layout: team 0 attacks +x (first half), both sides in a loose 4-4-2 well apart. */
const BASE: [number, number][] = [
  [-51, 0], [-35, -25], [-38, -8], [-38, 8], [-35, 25], [-25, -15], [-25, 0], [-25, 15], [-15, -20], [-15, 0], [-15, 20],
  [51, 0], [35, -25], [38, -8], [38, 8], [35, 25], [25, -15], [25, 0], [25, 15], [15, -20], [15, 0], [15, 20],
];

interface Setup {
  carrier: number;
  at?: Record<number, [number, number]>;
  level?: Difficulty;
  seed?: number;
  ownerT?: number;
  fx?: number;
  fz?: number;
}

function setup(o: Setup): SimState {
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) {
    const [x, z] = o.at?.[i] ?? BASE[i]!;
    const f = i < 11 ? 1 : -1;
    players.push({ slot: i, x, z, vx: 0, vz: 0, fx: f, fz: 0, homeX: x, homeZ: z });
  }
  const team = o.carrier < 11 ? 0 : 1;
  const c = players[o.carrier]!;
  if (o.fx !== undefined) { c.fx = o.fx; c.fz = o.fz ?? 0; }
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: 0, seed: o.seed ?? 7, config: { difficulty: o.level ?? Difficulty.LEGEND }, players,
    ball: {
      x: c.x! + 0.6 * c.fx!, y: 0.11, z: c.z! + 0.6 * c.fz!, owner: o.carrier, ownerT: o.ownerT ?? 120, lastTouch: o.carrier,
      lastTouchTeam: team,
    },
  });
  const ci = CPU_CONTROLLER_BASE + team;
  s.ctrl[ci]!.slot = o.carrier;
  s.players[o.carrier]!.ctrl = ci;
  return s;
}

interface Rec { tick: number; f: InputFrame; plan: CpuPlan; owner: number; act: number; evalT: number }

/** Step the real pipeline n ticks (or until stop), recording team's CPU frame after each tick. */
function run(s: SimState, n: number, team = 0, stop?: (st: SimState) => boolean): { recs: Rec[]; events: SimEvent[] } {
  const recs: Rec[] = [];
  const events = runTicks(s, n, undefined, {
    until: (st) => {
      const b = st.teams[team]!.cpu;
      const f = createInputFrame();
      copyInputFrame(f, b.out);
      const o = st.ball.owner;
      recs.push({ tick: st.tick, f, plan: b.plan, owner: o, act: o >= 0 ? st.players[o]!.act : -1, evalT: b.evalT });
      return stop ? stop(st) : false;
    },
  });
  return { recs, events };
}

const OUT = createInputFrame();

/** One direct call on a static state (the tick advances so the brain sees a continuous possession). */
function think(s: SimState, team = 0): InputFrame {
  s.tick++;
  clearInputFrame(OUT);
  cpuCarrier(s, team, OUT, NULL_SINK);
  const f = createInputFrame();
  copyInputFrame(f, OUT);
  return f;
}

function stickMag(f: InputFrame): number { return Math.hypot(f.mx, f.mz) / AXIS_SCALE; }

function maxRun(recs: Rec[], bit: number): number {
  let best = 0, cur = 0;
  for (const r of recs) { cur = (r.f.buttons & bit) !== 0 ? cur + 1 : 0; if (cur > best) best = cur; }
  return best;
}

function isOneShot(p: CpuPlan): boolean {
  return p === CpuPlan.PASS || p === CpuPlan.THROUGH || p === CpuPlan.CROSS || p === CpuPlan.CLEAR || p === CpuPlan.SHOOT ||
    p === CpuPlan.SKILL;
}

const NEUTRAL_STYLE: StyleWeights = { safety: 0.5, progress: 0.5, directness: 0.5, width: 0.5, dribble: 0.5, longShot: 0.5, press: 0.5, counter: 0.5 };

beforeEach(() => { resetCtl(); });

// ---------------------------------------------------------------- behaviours

describe('TAI-08 CPU carrier: scripted situations', () => {
  it('passes to an open teammate: a gesture tap on him, and the real SIM-08 pass goes to him', () => {
    const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [10, -10] } });
    const { recs, events } = run(s, 90, 0, (st) => st.ball.owner !== 6);
    const tap = recs.find((r) => r.f.gesture === GestureKind.TAP);
    expect(tap, 'a TAP gesture').toBeDefined();
    expect(tap!.f.gSlot).toBe(9);
    expect(Math.abs(tap!.f.gx / 10 - s.players[9]!.x)).toBeLessThan(3);
    const kick = events.find((e) => e.type === EventType.KICK && e.a === 6);
    expect(kick, 'a KICK by the carrier').toBeDefined();
    expect(kick!.b).toBe(KickKind.GROUND_PASS);
    expect(s.ball.passTarget).toBe(9);
    // Decided right after the Legend reaction delay (plus at most the aiming ticks).
    expect(tap!.tick - recs[0]!.tick).toBeLessThanOrEqual(T_LEVEL.reactionTicks[Difficulty.LEGEND]! + LT.aimMaxTicks + 2);
  });

  it('shoots from a good position: SHOOT held for the wanted power, the stick on the goal mouth', () => {
    const s = setup({ carrier: 9, at: { 9: [40, 3], 13: [30, -20], 14: [30, 20] } });
    const { recs } = run(s, 45);
    const st = CTL.starts.find((r) => r.via === 'shot');
    expect(st, 'startShot called').toBeDefined();
    expect(st!.kind).toBe(KickKind.SHOT_NORMAL);
    expect(st!.charging).toBe(1);
    // Toward the goal mouth from (40, 3): the ray crosses the goal line inside the posts (+ margin).
    expect(st!.dirX).toBeGreaterThan(0.85);
    expect(Math.abs(3 + (st!.dirZ / st!.dirX) * (HALF_LENGTH - 40))).toBeLessThan(GOAL_HALF_WIDTH + 1.5);
    const i0 = recs.findIndex((r) => (r.f.buttons & Btn.SHOOT) !== 0);
    let n = 0;
    while (recs[i0 + n] && (recs[i0 + n]!.f.buttons & Btn.SHOOT) !== 0) {
      const f = recs[i0 + n]!.f;
      // The stick ray from the shooter crosses the goal line inside (or just outside) the mouth.
      const zAt = s.players[9]!.z + (f.mz / f.mx) * (HALF_LENGTH - 40);
      expect(f.mx).toBeGreaterThan(0);
      expect(Math.abs(zAt)).toBeLessThan(GOAL_HALF_WIDTH + 1.5);
      n++;
    }
    // Power for ~13 m: shotPowerNear..Far => ~0.61 x powerFillTicks, +- execution noise.
    expect(n).toBeGreaterThanOrEqual(Math.round(0.5 * T_PASS.powerFillTicks));
    expect(n).toBeLessThanOrEqual(Math.round(0.72 * T_PASS.powerFillTicks));
    const p = s.players[9]!;
    expect(p.act).toBe(ActionKind.SHOT);
    expect(p.actPower).toBeCloseTo(n / T_PASS.powerFillTicks, 1);
  });

  it('dribbles into space: sprints toward goal with the ball when nobody is near', () => {
    CTL.passes = 'none';
    const s = setup({ carrier: 6, at: { 6: [-20, 0] } });
    const x0 = s.players[6]!.x;
    const { recs } = run(s, 150);
    // [QF-11] Only the carrier's own frames: a sprint knock-on leaves the ball loose between touches for a few ticks,
    // when TAI-11 (not TAI-08) drives him onto it.
    const dr = recs.filter((r) => r.plan === CpuPlan.DRIBBLE && r.owner === 6);
    expect(dr.length).toBeGreaterThan(120);
    for (const r of dr) expect(r.f.mx).toBeGreaterThan(50); // upfield (bestDribble may angle away from a presser)
    expect(dr.reduce((a, r) => a + r.f.mx, 0) / dr.length).toBeGreaterThan(95);
    expect(dr.filter((r) => (r.f.buttons & Btn.SPRINT) !== 0).length).toBeGreaterThan(dr.length * 0.7);
    // Still his ball: at his feet, or knocked ahead and not touched by anyone else since.
    expect(s.ball.owner === 6 || (s.ball.owner < 0 && s.ball.lastTouch === 6)).toBe(true);
    expect(s.players[6]!.x - x0).toBeGreaterThan(10);
  });

  it('sprints only with space: never pressed tightly, never with an opponent close in the cone ahead', () => {
    CTL.passes = 'none';
    CTL.skill = SkillMove.NONE;
    const cases: { opp: [number, number]; expect: 'never' | 'some' | 'rule' }[] = [
      { opp: [-18.2, 1.6], expect: 'never' }, // 2.4 m: tight
      { opp: [-17.6, 0.8], expect: 'rule' }, // 2.5 m ahead
      { opp: [-15.5, 0.5], expect: 'rule' }, // 4.5 m ahead
      { opp: [-24.5, 0], expect: 'some' }, // 4.5 m behind
    ];
    for (const c of cases) {
      const s = setup({ carrier: 6, at: { 6: [-20, 0], 20: c.opp } });
      const p = s.players[6]!;
      const frames: InputFrame[] = [];
      for (let i = 0; i < 40; i++) frames.push(think(s));
      const sprints = frames.filter((f) => (f.buttons & Btn.SPRINT) !== 0);
      if (c.expect === 'never') expect(sprints, `opponent at ${c.opp}`).toHaveLength(0);
      if (c.expect === 'some') expect(sprints.length, `opponent at ${c.opp}`).toBeGreaterThan(20);
      for (const f of sprints) {
        const m = Math.hypot(f.mx, f.mz);
        const dx = f.mx / m, dz = f.mz / m;
        for (let i = 11; i < 22; i++) {
          const q = s.players[i]!;
          const ox = q.x - p.x, oz = q.z - p.z;
          const d = Math.hypot(ox, oz);
          expect(d).toBeGreaterThan(LT.tightDist);
          if (d <= LT.sprintSpaceDist) expect(ox * dx + oz * dz).toBeLessThan(LT.sprintConeCos * d + 0.05);
        }
      }
    }
  });

  it('clears under pressure in its own third: LOB held upfield toward its touchline', () => {
    CTL.passes = 'none';
    const s = setup({ carrier: 2, at: { 2: [-44, 6], 20: [-42.3, 6.6], 21: [-40, 12] } });
    const { recs } = run(s, 50);
    const i0 = recs.findIndex((r) => (r.f.buttons & Btn.LOB) !== 0);
    expect(i0, 'LOB pressed').toBeGreaterThanOrEqual(0);
    expect(recs[i0]!.plan).toBe(CpuPlan.CLEAR);
    expect(recs[i0]!.f.mx).toBeGreaterThan(0);
    expect(recs[i0]!.f.mz).toBeGreaterThan(0);
    const hold = maxRun(recs, Btn.LOB);
    expect(Math.abs(hold - LT.clearPower * T_PASS.powerFillTicks)).toBeLessThanOrEqual(5);
    const st = CTL.starts.find((r) => r.via === 'lob');
    expect(st).toBeDefined();
    expect(st!.kind).toBe(KickKind.LOB_PASS);
    expect(st!.dirX).toBeGreaterThan(0.5);
  });

  it('does not clear deep in its own half when unpressed', () => {
    const s = setup({ carrier: 2, at: { 2: [-44, 6] } });
    const { recs } = run(s, 60, 0, (st) => st.ball.owner !== 2);
    expect(recs.some((r) => r.plan === CpuPlan.CLEAR)).toBe(false);
    expect(recs.some((r) => (r.f.buttons & Btn.LOB) !== 0)).toBe(false);
  });

  it('shields when pressed with no option (SHIELD held, stick released, no sprint)', () => {
    CTL.passes = 'none';
    CTL.skill = SkillMove.NONE;
    CTL.dribbleScore = 0.05;
    const s = setup({ carrier: 6, at: { 6: [0, 0], 20: [1.7, 0.4] } });
    s.attrs[6]!.strength = 80;
    const frames: InputFrame[] = [];
    for (let i = 0; i < 30; i++) frames.push(think(s));
    const after = frames.slice(T_LEVEL.reactionTicks[Difficulty.LEGEND]!);
    expect(s.teams[0]!.cpu.plan).toBe(CpuPlan.SHIELD);
    for (const f of after) {
      expect(f.buttons & Btn.SHIELD).toBe(Btn.SHIELD);
      expect(f.buttons & Btn.SPRINT).toBe(0);
      expect(f.mx === 0 && f.mz === 0).toBe(true);
    }
  });

  it('glitch "CPU: shields forever": after shieldMaxTicks of shielding the carrier plays on, and the shield rests', () => {
    CTL.passes = 'none';
    CTL.skill = SkillMove.NONE;
    CTL.dribbleScore = 0.05;
    const s = setup({ carrier: 6, at: { 6: [0, 0], 20: [1.7, 0.4] } });
    s.attrs[6]!.strength = 99;
    const plans: CpuPlan[] = [];
    const n = T_LEVEL.reactionTicks[Difficulty.LEGEND]! + LT.shieldMaxTicks + (LT.shieldRestEvals + 3) * T_AI.carrierEvalInterval;
    for (let i = 0; i < n; i++) { think(s); plans.push(s.teams[0]!.cpu.plan); }
    let run = 0, longest = 0, firstEnd = -1;
    for (let i = 0; i < plans.length; i++) {
      if (plans[i] === CpuPlan.SHIELD) { run++; longest = Math.max(longest, run); } else { if (run > 0 && firstEnd < 0) firstEnd = i; run = 0; }
    }
    expect(plans.includes(CpuPlan.SHIELD)).toBe(true);
    expect(longest).toBeLessThanOrEqual(LT.shieldMaxTicks + T_AI.carrierEvalInterval);
    expect(firstEnd).toBeGreaterThan(0);
    // The shield rests for shieldRestEvals decisions after it ends.
    let rest = 0;
    for (let i = firstEnd; i < plans.length && plans[i] !== CpuPlan.SHIELD; i++) rest++;
    expect(rest).toBeGreaterThanOrEqual((LT.shieldRestEvals - 1) * T_AI.carrierEvalInterval);
  });

  it('beats a close defender with a skill move: frame.skill edge, exit away from him, then dribbles on', () => {
    CTL.passes = 'none';
    const s = setup({ carrier: 6, at: { 6: [0, 0], 20: [2.0, 0.4] } });
    const a = s.attrs[6]!;
    a.skillMoves = 4; a.dribbling = 90; a.strength = 30;
    const { recs, events } = run(s, 50);
    const sk = recs.find((r) => r.f.skill !== SkillMove.NONE);
    expect(sk, 'a skill edge').toBeDefined();
    expect(sk!.f.skill).toBe(SkillMove.BODY_FEINT);
    expect(sk!.f.mz).toBeLessThan(0); // defender on the +z side
    expect(recs.filter((r) => r.f.skill !== SkillMove.NONE)).toHaveLength(1);
    expect(events.some((e) => e.type === EventType.SKILL && e.a === 6 && e.b === SkillMove.BODY_FEINT)).toBe(true);
    const after = recs.slice(recs.indexOf(sk!) + 1).find((r) => r.act !== ActionKind.SKILL && r.owner === 6);
    if (after) expect(after.plan === CpuPlan.DRIBBLE || !isOneShot(after.plan) || after.plan === CpuPlan.SKILL).toBe(true);
  });

  it('neutral frame while a keeper holds the ball and while the ball is loose', () => {
    const s = setup({ carrier: 0, at: { 0: [-48, 0] } });
    s.ball.heldBy = 0;
    for (let i = 0; i < 20; i++) {
      const f = think(s);
      expect(f.buttons | f.mx | f.mz | f.gesture | f.skill).toBe(0);
    }
    s.ball.heldBy = -1;
    s.ball.owner = -1;
    for (let i = 0; i < 20; i++) {
      const f = think(s);
      expect(f.buttons | f.mx | f.mz | f.gesture | f.skill).toBe(0);
    }
  });
});

// ---------------------------------------------------------------- execution mapping (custom options)

describe('TAI-08 CPU carrier: kick execution through the frame', () => {
  it('through ball: tap ahead of the runner (>= throughMinLead), the resolver makes a through ball to him', () => {
    CTL.passes = 'custom';
    CTL.custom.push({ target: 9, kind: KickKind.THROUGH_GROUND, x: 5.5, z: -10, completion: 0.95, progress: 10.5, danger: 0.3 });
    const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [5, -10] } });
    const { recs } = run(s, 40);
    const tap = recs.find((r) => r.f.gesture !== GestureKind.NONE);
    expect(tap).toBeDefined();
    expect(tap!.f.gesture).toBe(GestureKind.TAP);
    expect(tap!.f.gSlot).toBe(9);
    expect(tap!.f.gx / 10).toBeGreaterThanOrEqual(5 + LT.throughMinLead - 1e-9);
    const st = CTL.starts.find((r) => r.via === 'through');
    expect(st).toBeDefined();
    expect(st!.kind).toBe(KickKind.THROUGH_GROUND);
    expect(st!.target).toBe(9);
    expect(st!.hasTarget).toBe(1);
  });

  it('cross from the crossing zone: double tap at the target, the resolver crosses to the post spot', () => {
    CTL.passes = 'custom';
    CTL.custom.push({ target: 10, kind: KickKind.CROSS, x: 47, z: 3, completion: 0.6, progress: 12, danger: 0.4 });
    const s = setup({ carrier: 9, at: { 9: [35, 25], 10: [46, 2] } });
    const { recs } = run(s, 40);
    const tap = recs.find((r) => r.f.gesture !== GestureKind.NONE);
    expect(tap).toBeDefined();
    expect(tap!.f.gesture).toBe(GestureKind.DOUBLE_TAP);
    const st = CTL.starts.find((r) => r.via === 'lob');
    expect(st).toBeDefined();
    expect(st!.kind).toBe(KickKind.CROSS);
  });

  it('lob pass: double tap on the receiver', () => {
    CTL.passes = 'custom';
    CTL.custom.push({ target: 9, kind: KickKind.LOB_PASS, x: 12, z: -8, completion: 0.9, progress: 17, danger: 0.2 });
    const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [12, -8] } });
    const { recs } = run(s, 40);
    const tap = recs.find((r) => r.f.gesture !== GestureKind.NONE);
    expect(tap!.f.gesture).toBe(GestureKind.DOUBLE_TAP);
    expect(tap!.f.gSlot).toBe(9);
    const st = CTL.starts.find((r) => r.via === 'lob');
    expect(st!.kind).toBe(KickKind.LOB_PASS);
    expect(st!.target).toBe(9);
  });

  it('driven pass: PASS + MOD_R on the press tick, PASS held for the power, the real SIM-08 kick is driven', () => {
    CTL.passes = 'custom';
    CTL.custom.push({ target: 9, kind: KickKind.DRIVEN_PASS, x: 12, z: -8, completion: 0.95, progress: 17, danger: 0.2 });
    const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [12, -8] } });
    const { recs, events } = run(s, 70, 0, (st) => st.ball.owner !== 6);
    const i0 = recs.findIndex((r) => (r.f.buttons & Btn.PASS) !== 0);
    expect(i0).toBeGreaterThanOrEqual(0);
    expect(recs[i0]!.f.buttons & Btn.MOD_R).toBe(Btn.MOD_R);
    expect(recs[i0 + 1]!.f.buttons & Btn.MOD_R).toBe(0);
    const hold = maxRun(recs, Btn.PASS);
    const d = Math.hypot(17, 8);
    const want = Math.min(LT.drivenPowerMax, LT.drivenPowerBase + LT.drivenPowerPerM * d) * T_PASS.powerFillTicks;
    expect(Math.abs(hold - want)).toBeLessThanOrEqual(4);
    const kick = events.find((e) => e.type === EventType.KICK && e.a === 6);
    expect(kick, 'the driven pass was struck').toBeDefined();
    expect(kick!.b).toBe(KickKind.DRIVEN_PASS);
    expect(s.ball.passTarget).toBe(9);
  });

  it('a refused kick is released and dropped, not held (no stuck button), and not retried at once', () => {
    CTL.starters = 'refuse';
    const s = setup({ carrier: 9, at: { 9: [40, 3], 13: [30, -20], 14: [30, 20] } });
    const { recs } = run(s, 150);
    expect(CTL.starts.length).toBeGreaterThan(0);
    expect(maxRun(recs, Btn.SHOOT)).toBeLessThanOrEqual(LT.startTimeoutTicks + 1);
    // Gaps between SHOOT press runs: the failed plan sits out failEvals decisions.
    const presses: number[] = [];
    for (let i = 0; i < recs.length; i++) {
      if ((recs[i]!.f.buttons & Btn.SHOOT) !== 0 && (i === 0 || (recs[i - 1]!.f.buttons & Btn.SHOOT) === 0)) presses.push(recs[i]!.tick);
    }
    for (let i = 1; i < presses.length; i++) {
      expect(presses[i]! - presses[i - 1]!).toBeGreaterThanOrEqual(LT.startTimeoutTicks + T_AI.carrierEvalInterval);
    }
  });
});

// ---------------------------------------------------------------- timing, commitment, levels, styles

describe('TAI-08 CPU carrier: timing and commitment', () => {
  it('evaluation staggering: options are scored once per carrierEvalInterval ticks, after the reaction delay', () => {
    CTL.passes = 'none';
    const s = setup({ carrier: 6, at: { 6: [-20, 0] }, level: Difficulty.PROFESSIONAL });
    const t0 = s.tick;
    run(s, 100);
    const calls = CTL.scoreCalls;
    expect(s.ball.owner).toBe(6);
    expect(calls[0]! - t0).toBe(T_LEVEL.reactionTicks[Difficulty.PROFESSIONAL]! + 1);
    expect(calls.length).toBeGreaterThan(8);
    for (let i = 1; i < calls.length; i++) expect(calls[i]! - calls[i - 1]!).toBe(T_AI.carrierEvalInterval);
  });

  it('reaction delay: longer at lower levels; a plain carry (no buttons, gestures or skills) meanwhile', () => {
    for (const level of [Difficulty.BEGINNER, Difficulty.SEMI_PRO, Difficulty.LEGEND]) {
      resetCtl();
      CTL.passes = 'none';
      const s = setup({ carrier: 6, at: { 6: [-20, 0] }, level });
      s.players[6]!.vx = 4;
      const t0 = s.tick;
      const react = T_LEVEL.reactionTicks[level]!;
      const { recs } = run(s, react + 20);
      expect(CTL.scoreCalls[0]! - t0, `level ${level}`).toBe(react + 1);
      for (const r of recs.slice(0, react)) {
        expect(r.f.buttons).toBe(0);
        expect(r.f.gesture).toBe(GestureKind.NONE);
        expect(r.f.skill).toBe(SkillMove.NONE);
      }
    }
  });

  it('commits to a plan: it changes only at an evaluation tick or after a kick / skill plan ends (no dithering)', () => {
    CTL.passes = 'none';
    CTL.skill = SkillMove.NONE;
    // An opponent closing in from the front: dribble and shield compete.
    const s = setup({ carrier: 6, at: { 6: [0, 0], 20: [6, 1] }, level: Difficulty.PROFESSIONAL });
    s.players[20]!.vx = -3;
    const { recs } = run(s, 160, 0, (st) => st.ball.owner !== 6);
    let changes = 0;
    for (let i = 1; i < recs.length; i++) {
      const a = recs[i - 1]!, b = recs[i]!;
      if (a.owner !== 6 || b.owner !== 6 || a.plan === b.plan) continue;
      changes++;
      const decided = b.evalT === T_AI.carrierEvalInterval;
      expect(decided || isOneShot(a.plan) || a.plan === CpuPlan.NONE, `tick ${b.tick}: ${a.plan} -> ${b.plan}`).toBe(true);
    }
    expect(changes).toBeLessThanOrEqual(Math.ceil(recs.length / T_AI.carrierEvalInterval));
  });

  it('a re-chosen dribble keeps its direction smooth (no flip-flop)', () => {
    CTL.passes = 'none';
    const s = setup({ carrier: 6, at: { 6: [-20, 0] }, level: Difficulty.BEGINNER });
    const { recs } = run(s, 120);
    const dr = recs.filter((r) => r.plan === CpuPlan.DRIBBLE && stickMag(r.f) > 0.5);
    for (let i = 1; i < dr.length; i++) {
      const a = dr[i - 1]!.f, b = dr[i]!.f;
      const cos = (a.mx * b.mx + a.mz * b.mz) / (Math.hypot(a.mx, a.mz) * Math.hypot(b.mx, b.mz));
      expect(cos).toBeGreaterThan(0.7);
    }
  });

  it('stop-ball safety: SPRINT never with a released stick; MOD_L only on a shot press', () => {
    const all: Rec[] = [];
    CTL.passes = 'none';
    all.push(...run(setup({ carrier: 6, at: { 6: [-20, 0] } }), 120).recs);
    resetCtl();
    all.push(...run(setup({ carrier: 9, at: { 9: [20, 0] }, level: Difficulty.AMATEUR }), 200, 0).recs);
    resetCtl();
    all.push(...run(setup({ carrier: 9, at: { 9: [38, 10], 11: [45, 2] } }), 60).recs);
    for (const r of all) {
      // [QF-2] Stop-ball inputs matter only with the ball at our feet: with our pass in flight TAI-11's receiver frame
      // is SPRINT + idle stick on purpose (SIM-15: meet the ball at top speed).
      if (r.owner < 0) continue;
      if ((r.f.buttons & Btn.SPRINT) !== 0) expect(stickMag(r.f), JSON.stringify(r)).toBeGreaterThanOrEqual(T_INPUT.stickIdle);
      if ((r.f.buttons & Btn.MOD_L) !== 0) expect(r.f.buttons & Btn.SHOOT).toBe(Btn.SHOOT);
    }
  });

  it('lower levels decide with more noise (the clearly best pass is picked less often)', () => {
    const picks = (level: Difficulty): number => {
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        resetCtl();
        CTL.passes = 'custom';
        CTL.dribbleScore = 0.5;
        CTL.custom.push({ target: 9, kind: KickKind.GROUND_PASS, x: 8, z: -10, completion: 0.97, progress: 13, danger: 0.035 });
        const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [8, -10] }, level, seed });
        const react = T_LEVEL.reactionTicks[level]!;
        for (let i = 0; i <= react; i++) think(s);
        if (s.teams[0]!.cpu.plan === CpuPlan.PASS) n++;
      }
      return n;
    };
    const legend = picks(Difficulty.LEGEND);
    const beginner = picks(Difficulty.BEGINNER);
    expect(legend).toBeGreaterThanOrEqual(36);
    expect(beginner).toBeLessThan(legend);
  });

  it('team style weights choices: a direct side plays the through ball, a cautious one the safe pass', () => {
    const choose = (directness: number): CpuPlan => {
      resetCtl();
      CTL.style = { ...NEUTRAL_STYLE, directness };
      CTL.passes = 'custom';
      CTL.dribbleScore = 0;
      CTL.custom.push({ target: 10, kind: KickKind.GROUND_PASS, x: 6, z: 10, completion: 0.98, progress: 11, danger: 0.055 });
      CTL.custom.push({ target: 9, kind: KickKind.THROUGH_GROUND, x: 20, z: -10, completion: 0.95, progress: 25, danger: 0.06 });
      const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [17, -10], 10: [6, 10] } });
      for (let i = 0; i <= T_LEVEL.reactionTicks[Difficulty.LEGEND]!; i++) think(s);
      return s.teams[0]!.cpu.plan;
    };
    expect(choose(1)).toBe(CpuPlan.THROUGH);
    expect(choose(0)).toBe(CpuPlan.PASS);
  });
});

// ---------------------------------------------------------------- contract properties

/** JSON of the state without the CPU brains (cpu.*) and the RNG: what cpuCarrier must never write. */
function worldJson(s: SimState): string {
  return JSON.stringify(s, (k, v: unknown) => (k === 'cpu' || k === 'rng' || k === 'config' || k === 'squads' ? undefined : v));
}

describe('TAI-08 CPU carrier: contract', () => {
  const SCENES: Setup[] = [
    { carrier: 6, at: { 6: [-5, 0], 9: [10, -10] } },
    { carrier: 9, at: { 9: [40, 3], 13: [30, -20], 14: [30, 20] } },
    { carrier: 6, at: { 6: [0, 0], 20: [2.0, 0.4] } },
    { carrier: 2, at: { 2: [-44, 6], 20: [-42.3, 6.6] } },
    { carrier: 17, at: { 17: [5, 3] }, level: Difficulty.BEGINNER },
  ];

  it('frames only: cpuCarrier writes nothing outside its own brain / frame (and the RNG)', () => {
    for (const sc of SCENES) {
      const s = setup(sc);
      run(s, 3, sc.carrier < 11 ? 0 : 1); // a live state
      const team = s.ball.owner >= 11 ? 1 : 0;
      for (let i = 0; i < 80; i++) {
        s.tick++;
        const before = worldJson(s);
        clearInputFrame(OUT);
        cpuCarrier(s, team, OUT, NULL_SINK);
        expect(worldJson(s)).toBe(before);
        expect(s.teams[1 - team]!.cpu.plan === s.teams[1 - team]!.cpu.plan).toBe(true);
      }
    }
  });

  it('never reads human inputs: human controller state does not change the frames', () => {
    for (const sc of SCENES) {
      const a = setup(sc);
      const team = sc.carrier < 11 ? 0 : 1;
      const b = cloneState(a);
      for (let h = 0; h < 2; h++) {
        const c = b.ctrl[h]!;
        c.buttons = 0xff; c.prevButtons = 0x0f; c.mx = 0.7; c.mz = -0.7; c.stickIdleT = 0; c.powerBtn = Btn.SHOOT; c.power = 0.9;
        c.receiver = 5; c.bufAction = 3; c.slot = h === 0 ? 7 : 18;
        for (let i = 0; i < 8; i++) { c.holdT[i] = 30 + i; c.pressTick[i] = 3; c.releaseTick[i] = 1; }
      }
      for (let i = 0; i < 80; i++) {
        const fa = think(a, team), fb = think(b, team);
        expect(fb).toEqual(fa);
      }
      expect(b.teams[team]!.cpu.plan).toBe(a.teams[team]!.cpu.plan);
      expect(b.rng).toEqual(a.rng);
    }
  });

  it('determinism: the same setup and seed give identical frames and state hashes', () => {
    const once = (): { h: number; frames: string } => {
      resetCtl();
      CTL.starters = 'kick';
      const s = setup({ carrier: 6, at: { 6: [-5, 0], 9: [10, -10] }, level: Difficulty.SEMI_PRO, seed: 99 });
      const { recs } = run(s, 400);
      return { h: hashState(s), frames: JSON.stringify(recs.map((r) => r.f)) };
    };
    const a = once(), b = once();
    expect(b.h).toBe(a.h);
    expect(b.frames).toBe(a.frames);
  });

  it('every frame is a legal InputFrame (axes in range, radial stick <= 127, gesture targets on the pitch)', () => {
    for (const sc of SCENES) {
      resetCtl();
      CTL.starters = 'kick';
      const s = setup(sc);
      const { recs } = run(s, 240, sc.carrier < 11 ? 0 : 1);
      for (const r of recs) {
        const f = r.f;
        expect(Math.hypot(f.mx, f.mz)).toBeLessThanOrEqual(127);
        for (const v of [f.mx, f.mz, f.ax, f.az]) expect(Number.isInteger(v) && Math.abs(v) <= 127).toBe(true);
        if (f.gesture !== GestureKind.NONE) {
          expect(Math.abs(f.gx)).toBeLessThanOrEqual(Math.round(HALF_LENGTH * 10));
          expect(Math.abs(f.gz)).toBeLessThanOrEqual(340);
          expect(f.gSlot).toBeGreaterThanOrEqual(0);
        }
        expect(f.cmd).toBe(0);
      }
    }
  });
});
