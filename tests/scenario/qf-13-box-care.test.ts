/**
 * [QF-13] TAI-11 in its own penalty area: every CPU tackle there was as free as in midfield (rash lunges at a carrier
 * with the ball at his feet, noisy lunges at an exposure, slides), so Professional bot matches gave 0.92 penalties a
 * match (real football about 0.3; 12 matches, soak seed 5) and the 88 v 62 balance pair 1.2, half of the weaker
 * club's goals. Inside the area the rash / noisy lunges and slides are scaled by T_LEVEL.boxRashMul / boxSlideMul
 * (0 from Professional up: only the careful, well-timed standing tackle is left; 12 matches: 0.42 penalties). Beginner
 * and Amateur keep their rash lunges there (a low level's mistake), Semi-Pro half.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { Btn, clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_LEVEL } from '../../src/contracts/tuning';
import { cpuDefend } from '../../src/ai/cpu/defending';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';

const D = 15; // CPU defender (team 1, defending the goal at +x)
const C = 9; // carrier (team 0, attacking +x)
const CPU = 3;

/** Carrier at (cx, cz) with the ball at his feet walking at the goal; D goal-side 1.3 m in front of him. */
function scene(cx: number, cz: number, level: Difficulty, seed: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.stunT = 0; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[C]!;
  q.x = cx; q.z = cz; q.vx = 1; q.vz = 0; q.fx = 1; q.fz = 0;
  const d = s.players[D]!;
  d.x = cx + 1.3; d.z = cz; d.fx = -1; d.fz = 0;
  const b = s.ball;
  b.x = cx + 0.3; b.z = cz; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 1; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.tick = 1000;
  b.lastTouchTick = s.tick - 2; q.lastTouchTick = s.tick - 2;
  const ctl = s.ctrl[CPU]!;
  ctl.slot = D; d.ctrl = CPU; ctl.switchLockT = 999; ctl.nextSwitch = -1; ctl.buttons = 0; ctl.prevButtons = 0;
  const brain = s.teams[1]!.cpu;
  brain.level = level; brain.seenOwner = C; brain.reactT = 0; brain.tackleCd = 0;
  return s;
}

/** Ticks (of n, a fresh tackle cool-down each tick) on which the CPU presses for a standing tackle (SHOOT). */
function lunges(s: SimState, n: number): number {
  const f = createInputFrame();
  let k = 0;
  for (let t = 0; t < n; t++) {
    s.tick++;
    s.teams[1]!.cpu.tackleCd = 0;
    clearInputFrame(f);
    cpuDefend(s, 1, f, NULL_SINK);
    if ((f.buttons & Btn.SHOOT) !== 0) k++;
  }
  return k;
}

describe('QF-13 TAI-11: careful in the own penalty area', () => {
  it('a Professional / World Class CPU defender lunges rashly at a carrier with the ball at his feet in midfield, never in his own box', () => {
    for (const lv of [Difficulty.PROFESSIONAL, Difficulty.WORLD_CLASS]) {
      expect(T_LEVEL.boxRashMul[lv]).toBe(0);
      expect(T_LEVEL.boxSlideMul[lv]).toBe(0);
      let outside = 0, inside = 0;
      for (let seed = 1; seed <= 8; seed++) {
        outside += lunges(scene(20, 0, lv, seed), 900); // 30 rash buckets
        inside += lunges(scene(44, 0, lv, seed), 900);
        inside += lunges(scene(40, -12, lv, seed), 900);
      }
      expect(outside, `level ${lv}`).toBeGreaterThan(0); // control: the rash lunge is live
      expect(inside, `level ${lv}`).toBe(0);
    }
  });

  it('a Beginner keeps his rash lunges in the box (a low level\'s mistake), Semi-Pro fewer', () => {
    let beg = 0, semi = 0;
    for (let seed = 1; seed <= 4; seed++) {
      beg += lunges(scene(44, 0, Difficulty.BEGINNER, seed), 600);
      semi += lunges(scene(44, 0, Difficulty.SEMI_PRO, seed), 600);
    }
    expect(beg).toBeGreaterThan(0);
    expect(semi).toBeLessThan(beg);
  });

  it('the careful tackle stays in the box: an exposed ball that will be in reach is still tackled', () => {
    let hits = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const s = scene(44, 0, Difficulty.PROFESSIONAL, seed);
      // The carrier's touch ran 1.3 m ahead of him, toward the defender: exposed and in reach at contact, and (QF-13
      // skeptic boxClear) the carrier out of body contact with the defender.
      const b = s.ball;
      b.x = s.players[C]!.x + 1.3; b.px = b.x;
      s.players[D]!.x = s.players[C]!.x + 2.4;
      s.players[C]!.lastTouchTick = s.tick - 20; b.lastTouchTick = s.tick - 20;
      hits += lunges(s, 1);
    }
    expect(hits).toBeGreaterThan(0);
  });
});
