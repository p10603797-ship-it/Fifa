/**
 * [QF-11] Regression tests for defects found and fixed by QF-11 (Wave 4 round 2: difficulty ladder, club balance,
 * TAI-13 round-2 CRs). One test per defect, named after the symptom.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, GestureKind, MatchPhase } from '../../src/contracts/enums';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { CPU_CONTROLLER_BASE, HALF_WIDTH } from '../../src/contracts/constants';
import { CARRIER_DEBUG, cpuCarrier } from '../../src/ai/cpu/carrier';
import { rngSeed } from '../../src/sim/core/rng';
import { T_AI } from '../../src/contracts/tuning';
import { cpuDefend } from '../../src/ai/cpu/defending';
import { LOCAL_TUNING as SP } from '../../src/ai/setpieces';
import { NULL_SINK } from '../../src/sim/core/events';
import { LOCAL_TUNING as CORNER_LT } from '../../src/sim/rules/corner';
import { LOCAL_TUNING as FK_LT } from '../../src/sim/rules/freekick';
import { makeScenario } from '../harness/scenario';

const D = 15; // CPU defender (team 1)
const C = 9; // human carrier (team 0)
const T = 16; // CPU teammate
const CPU = 3; // controller index of team 1's CPU brain

/** Quiet IN_PLAY scene (as tai-11-defending): everyone else parked at x = -45; D controlled by team 1's CPU. */
function scene(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed: 11, config: { difficulty: Difficulty.PROFESSIONAL },
  });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.stunT = 0; p.moveMode = MoveMode.STOP;
  }
  // Carrier at x 10 running at our goal; our current defender D beaten (behind him), T well placed goal-side.
  const q = s.players[C]!;
  q.x = 10; q.z = 0; q.vx = 4; q.fx = 1;
  const d = s.players[D]!;
  d.x = 2; d.z = 6; d.fx = -1;
  const t = s.players[T]!;
  t.x = 18; t.z = 1; t.fx = -1;
  const b = s.ball;
  b.x = q.x + 0.4; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 4; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.tick = 1005; // a player-choice evaluation tick for team 1
  b.lastTouchTick = s.tick - 2; q.lastTouchTick = s.tick - 2;
  const ctl = s.ctrl[CPU]!;
  ctl.slot = D; d.ctrl = CPU; ctl.switchLockT = 0; ctl.nextSwitch = -1; ctl.buttons = 0; ctl.prevButtons = 0;
  const brain = s.teams[1]!.cpu;
  brain.level = Difficulty.PROFESSIONAL; brain.seenOwner = C; brain.reactT = 0; brain.tackleCd = 0;
  return s;
}

const OUT = createInputFrame();
function think(s: SimState): InputFrame {
  clearInputFrame(OUT);
  cpuDefend(s, 1, OUT, NULL_SINK);
  return OUT;
}
const switched = (f: InputFrame): boolean => f.gesture === GestureKind.TAP || (f.buttons & Btn.MOD_L) !== 0;

describe('QF-11 CPU defending: player choice', () => {
  it('the scene switches when the current defender is free (control: the choice rule is live)', () => {
    expect(switched(think(scene()))).toBe(true);
  });

  it('CPU never switches away from its own man mid-tackle or mid-header (committed to the ball)', () => {
    const cases: [ActionKind, number][] = [
      [ActionKind.STAND_TACKLE, 4], [ActionKind.SLIDE_TACKLE, 6], [ActionKind.SHOULDER, 3], [ActionKind.HEADER, 5],
      [ActionKind.KICK, 2], [ActionKind.VOLLEY, 3],
    ];
    for (const [act, t] of cases) {
      const s = scene();
      const d = s.players[D]!;
      d.act = act; d.actT = t; d.actDur = 40; d.actContact = 10; d.actDone = 0; d.moveMode = MoveMode.LOCKED;
      expect(switched(think(s)), ActionKind[act]).toBe(false);
      // Once the action has played (or missed) the ball, the choice is free again.
      const after = scene();
      const a = after.players[D]!;
      a.act = act; a.actT = 30; a.actDur = 40; a.actContact = 10; a.actDone = 1; a.moveMode = MoveMode.STOP;
      expect(switched(think(after)), `${ActionKind[act]} done`).toBe(true);
    }
  });
});

describe('QF-11 TAI-13 corner / free-kick wait (round-2 CR)', () => {
  it('a CPU cross waits for its box runners until just before the RUL-04 / RUL-05 CPU fallback (aim included)', () => {
    // The fallback Default fires at cpuRestartDelay + cpuGraceTicks past ready; the wait ends maxArrivalWait past
    // cpuRestartDelay and the kick is aimed for aimTicks (a free-kick shot shotAimTicks) before its input.
    const aim = Math.max(SP.aimTicks, SP.shotAimTicks);
    expect(SP.maxArrivalWait + aim).toBeLessThan(CORNER_LT.cpuGraceTicks - 2);
    expect(SP.maxArrivalWait + aim).toBeLessThan(FK_LT.cpuGraceTicks - 2);
    expect(SP.maxArrivalWait).toBeGreaterThanOrEqual(CORNER_LT.cpuGraceTicks - 25);
  });
});

describe('QF-11 CPU carrier reaction delay', () => {
  it('a reacting CPU carrier near the touchline keeps running along it, never over it (ball run out of play)', () => {
    for (const side of [1, -1]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 5 });
      const c = 7; // team 0 carrier
      const p = s.players[c]!;
      p.x = 10; p.z = side * (HALF_WIDTH - 1.2); p.vx = 4; p.vz = side * 4; p.fx = 0.7; p.fz = side * 0.7;
      const b = s.ball;
      b.x = p.x + 0.5; b.z = p.z + side * 0.4; b.y = 0.11; b.px = b.x; b.pz = b.z; b.vx = p.vx; b.vz = p.vz; b.vy = 0;
      b.owner = c; b.heldBy = -1; b.lastTouch = c; b.lastTouchTeam = 0; b.ownerT = 1;
      s.ctrl[CPU_CONTROLLER_BASE]!.slot = c; p.ctrl = CPU_CONTROLLER_BASE;
      s.teams[0]!.cpu.level = Difficulty.BEGINNER; // the longest reaction delay
      s.teams[0]!.cpu.p0 = -100; // a new situation: the reaction delay starts now
      const f = createInputFrame();
      cpuCarrier(s, 0, f, NULL_SINK);
      expect(s.teams[0]!.cpu.reactT, 'in the reaction delay').toBeGreaterThan(0);
      expect(f.mx, 'carries on upfield').toBeGreaterThan(0);
      expect(f.mz * side, 'not toward the touchline').toBeLessThanOrEqual(0);
      // In open space the same carrier keeps his run (both components).
      p.z = 0; b.z = 0.4 * side;
      s.teams[0]!.cpu.p0 = -100;
      const g = createInputFrame();
      cpuCarrier(s, 0, g, NULL_SINK);
      expect(g.mz * side).toBeGreaterThan(0);
    }
  });
});

describe('QF-11 ratings show through decisions (BRIEF section 15 balance)', () => {
  /** A midfield carrier with several options; returns how often a Professional CPU picks the noiseless choice. */
  function cleanPicks(composure: number, n: number): number {
    const base = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 3 });
    const c = 6;
    const p = base.players[c]!;
    p.x = -5; p.z = 4; p.vx = 2; p.vz = 0; p.fx = 1; p.fz = 0;
    const b = base.ball;
    b.x = p.x + 0.5; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.vx = 2; b.vz = 0; b.vy = 0;
    b.owner = c; b.heldBy = -1; b.lastTouch = c; b.lastTouchTeam = 0; b.ownerT = 200;
    base.ctrl[CPU_CONTROLLER_BASE]!.slot = c; p.ctrl = CPU_CONTROLLER_BASE;
    base.attrs[c]!.composure = composure;
    const decideOnce = (level: Difficulty, seed: number): string => {
      const brain = base.teams[0]!.cpu;
      brain.level = level; brain.plan = 0; brain.evalT = 0; brain.reactT = 0; brain.seenOwner = c; brain.p0 = base.tick - 1;
      brain.p1 = 0;
      rngSeed(base.rng, seed);
      cpuCarrier(base, 0, createInputFrame(), NULL_SINK);
      return `${CARRIER_DEBUG.plan}:${CARRIER_DEBUG.passSlot}`;
    };
    const clean = decideOnce(Difficulty.LEGEND, 1); // no decision noise at Legend
    let same = 0;
    for (let k = 0; k < n; k++) if (decideOnce(Difficulty.PROFESSIONAL, 1000 + k) === clean) same++;
    return same;
  }

  it('a calm carrier (composure 90) makes the clean choice more often than a nervous one (40) at Professional', () => {
    expect(T_AI.composureNoiseSlope).toBeGreaterThan(0);
    const calm = cleanPicks(90, 200), nervous = cleanPicks(40, 200);
    expect(calm).toBeGreaterThan(nervous + 20);
  });
});
