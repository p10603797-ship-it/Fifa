/**
 * [QF-13 skeptic] TAI-11 box care at the top levels. The first pass took the rash / noisy lunges and slides out of the
 * own penalty area from Professional up but kept the careful, well-timed standing tackle as it was: at World Class and
 * Legend (tackle timing 4 / 3 ticks, short cool-down) the CPU defender made 5-6 such tackles in his box a match, and a
 * missed one with the carrier's body within reach is a foul (SIM-14 bodyInZone): 2.0 / 1.6 penalties a match at Legend
 * (seeds 505 / 606, 8 matches each), 0.75 at World Class, 0.38 at Professional; 13 of 16 scored, nearly half of
 * Legend's goals. In the box a careful tackle now also needs the ball clear of the carrier's body at contact (boxClear):
 * the carrier beyond body contact (two body radii + T_CPU.defendBoxBodyGap) and not across the line to the ball.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ChallengeOutcome, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { Btn, clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { EventType } from '../../src/contracts/events';
import { cpuDefend } from '../../src/ai/cpu/defending';
import { NULL_SINK } from '../../src/sim/core/events';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario } from '../harness/scenario';

const D = 15; // CPU defender (team 1, defending the goal at +x)
const C = 9; // carrier (team 0, attacking +x)
const CPU = 3;

/**
 * Carrier at (cx, cz) running at the goal at 2 m/s, his last touch `ballAhead` m ahead of him (exposed); the defender
 * `defAhead` m in front of him, goal-side, facing him.
 */
function scene(cx: number, cz: number, level: Difficulty, seed: number, ballAhead: number, defAhead: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.stunT = 0; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[C]!;
  q.x = cx; q.z = cz; q.vx = 2; q.vz = 0; q.fx = 1; q.fz = 0;
  const d = s.players[D]!;
  d.x = cx + defAhead; d.z = cz; d.fx = -1; d.fz = 0;
  const b = s.ball;
  b.x = cx + ballAhead; b.z = cz; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 2; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.tick = 1000;
  b.lastTouchTick = s.tick - 20; q.lastTouchTick = s.tick - 20;
  const ctl = s.ctrl[CPU]!;
  ctl.slot = D; d.ctrl = CPU; ctl.switchLockT = 999; ctl.nextSwitch = -1; ctl.buttons = 0; ctl.prevButtons = 0;
  const brain = s.teams[1]!.cpu;
  brain.level = level; brain.seenOwner = C; brain.reactT = 0; brain.tackleCd = 0;
  return s;
}

/** Does the CPU press for a standing tackle (SHOOT) on this tick? */
function tackles(s: SimState): boolean {
  const f = createInputFrame();
  s.tick++;
  clearInputFrame(f);
  cpuDefend(s, 1, f, NULL_SINK);
  return (f.buttons & Btn.SHOOT) !== 0;
}

describe('QF-13 skeptic TAI-11: no penalty-giving careful tackles at the top levels', () => {
  it('Legend / World Class: an exposed ball with the carrier in body reach is tackled in midfield, not in the own box', () => {
    // [QF-13 skeptic, second run] T_LEVEL.boxBodyClear: World Class and Legend (Professional's 0.38 penalties a match
    // were no excess; Professional keeps the first pass's tackles, the section 7 bands' reference).
    for (const lv of [Difficulty.WORLD_CLASS, Difficulty.LEGEND]) {
      let mid = 0, box = 0;
      for (let seed = 1; seed <= 6; seed++) {
        // Ball 0.8 m ahead of the carrier, the defender 1.4 m ahead of him: well timed, but his body is in reach.
        if (tackles(scene(10, 0, lv, seed, 0.8, 1.4))) mid++;
        if (tackles(scene(42, 0, lv, seed, 0.8, 1.4))) box++;
        if (tackles(scene(44, -10, lv, seed, 0.8, 1.4))) box++;
      }
      expect(mid, `level ${lv}: the careful tackle is live`).toBeGreaterThan(0);
      expect(box, `level ${lv}`).toBe(0);
    }
  });

  it('Professional keeps the first pass\'s careful box tackle (no boxClear there)', () => {
    let box = 0;
    for (let seed = 1; seed <= 6; seed++) if (tackles(scene(42, 0, Difficulty.PROFESSIONAL, seed, 0.8, 1.4))) box++;
    expect(box).toBeGreaterThan(0);
  });

  it('in the box the careful tackle stays when the ball is clear of the carrier (out of body reach)', () => {
    for (const lv of [Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
      let box = 0;
      for (let seed = 1; seed <= 6; seed++) if (tackles(scene(42, 0, lv, seed, 1.3, 2.4))) box++;
      expect(box, `level ${lv}`).toBeGreaterThan(0);
    }
  });

  it('Legend bot matches: penalties stay near the real-football rate', { timeout: 300000 }, () => {
    // [QF-13 skeptic, second run] 8 matches (was 4 with at most 3): over 16 matches of this sample the final tree
    // concedes 0.81 a match (its first four 4, first eight 5) and boxClear switched off 1.56 (first eight 13), so 4
    // matches put the threshold on the mean.
    let pens = 0, shots = 0;
    for (let m = 0; m < 8; m++) {
      const config = soakConfig(m, 606, { halfMinutes: 4, difficulty: Difficulty.LEGEND });
      config.cupRules = 0; config.fouls = 1;
      runMatch({
        config, checker: 'none', fastCutscenes: true,
        onTick: (_st, evs) => {
          for (let i = 0; i < evs.count; i++) {
            const e = evs.get(i);
            if (e.type === EventType.FOUL && e.c !== ChallengeOutcome.CLEAN && e.d === 1) pens++;
            if (e.type === EventType.SHOT) shots++;
          }
        },
      });
    }
    // [QF-16] A sample floor (enough box play to count penalties in): 78 shots on the QF-16 tree (165 in 16 matches),
    // 2 penalties (4 in 16).
    expect(shots).toBeGreaterThan(70);
    expect(pens).toBeLessThanOrEqual(8); // 5 here; boxClear off: 13 in these 8 matches
  });
});
