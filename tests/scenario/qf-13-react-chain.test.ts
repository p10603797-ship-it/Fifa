/**
 * [QF-13] TAI-11 reaction delay in an opponent's passing chain: every change of ball owner re-armed the level's delay
 * (Beginner 80 ticks), so the CPU's controlled defender kept his old run, often standing, for up to 29 s with gaps
 * under 0.25 s (6 Beginner short matches: 129 near-continuous freezes over 2.5 s). Now a change re-arms it only once
 * the delay has run out and the defender has been awake for T_AI.reactRearmGapFrac x the delay; a turnover (the
 * previous situation our own ball) always re-arms.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_AI, T_LEVEL } from '../../src/contracts/tuning';
import { cpuDefend } from '../../src/ai/cpu/defending';
import { possessingTeam } from '../../src/sim/core/query';
import { NULL_SINK } from '../../src/sim/core/events';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario } from '../harness/scenario';

const D = 15; // CPU defender (team 1)
const CPU = 3; // team 1's CPU controller
const OUT = createInputFrame();

function scene(level: Difficulty): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], seed: 13, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = i < 11 ? -10 + k * 3 : 10 + k; p.z = -25 + k * 5; }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.stunT = 0; p.moveMode = MoveMode.STOP;
  }
  const ctl = s.ctrl[CPU]!;
  ctl.slot = D; s.players[D]!.ctrl = CPU; ctl.switchLockT = 999; ctl.nextSwitch = -1;
  const brain = s.teams[1]!.cpu;
  brain.level = level; brain.seenOwner = -1; brain.reactT = 0; brain.tackleCd = 0;
  return s;
}

/** Ball with `owner` (-1 loose, the last touch by team `lastTeam`) at the owner's feet / midfield. */
function own(s: SimState, owner: number, lastTeam = 0): void {
  const b = s.ball;
  b.owner = owner; b.heldBy = -1; b.passTarget = -1; b.lastTouchTeam = lastTeam;
  if (owner >= 0) { b.x = s.players[owner]!.x + 0.4; b.z = s.players[owner]!.z; } else { b.x = 0; b.z = 0; }
  b.y = 0.11; b.vx = 0; b.vz = 0; b.vy = 0; b.grounded = 1;
}

function think(s: SimState): void {
  s.tick++;
  clearInputFrame(OUT);
  cpuDefend(s, 1, OUT, NULL_SINK);
}

describe('QF-13 TAI-11: the reaction delay does not chain through an opponent\'s passes', () => {
  it('Beginner defender in a 20-tick passing chain: frozen at most reactionTicks in a row, with awake gaps between', () => {
    const s = scene(Difficulty.BEGINNER);
    const delay = T_LEVEL.reactionTicks[Difficulty.BEGINNER]!;
    const gap = Math.round(delay * T_AI.reactRearmGapFrac);
    const chain = [1, -1, 3, -1, 5, -1, 7, -1, 2, -1, 4, -1, 6, -1, 8, -1, 10, -1, 1, -1, 3, -1, 5, -1, 7, -1, 2, -1, 4];
    let run = 0, longest = 0, awake = 0, armed = 0;
    let prevReact = 0;
    for (let k = 0; k < chain.length; k++) {
      own(s, chain[k]!, 0);
      for (let t = 0; t < 20; t++) {
        think(s);
        const r = s.teams[1]!.cpu.reactT;
        if (r > 0 && prevReact <= 0) armed++;
        prevReact = r;
        if (r > 0) { run++; if (run > longest) longest = run; } else { run = 0; awake++; }
      }
    }
    expect(longest).toBeLessThanOrEqual(delay);
    expect(armed).toBeGreaterThan(1); // it does re-arm after the gap (a slow defender stays slow)
    expect(awake).toBeGreaterThanOrEqual(gap * (armed - 1));
    // Old behaviour: re-armed every 20 ticks, frozen for the whole 580-tick chain.
    expect(awake).toBeGreaterThan(100);
  });

  it('no re-arm while the delay runs or within the gap; a change after the gap re-arms', () => {
    const s = scene(Difficulty.BEGINNER);
    const delay = T_LEVEL.reactionTicks[Difficulty.BEGINNER]!;
    const gap = Math.round(delay * T_AI.reactRearmGapFrac);
    const brain = s.teams[1]!.cpu;
    own(s, 1); think(s);
    expect(brain.reactT).toBe(delay);
    for (let t = 0; t < 30; t++) think(s);
    own(s, -1); think(s); // their pass: still the first delay
    expect(brain.reactT).toBe(delay - 31);
    while (brain.reactT > 0) think(s);
    expect(brain.reactT).toBe(-gap);
    own(s, 3); think(s); // received inside the gap: awake
    expect(brain.reactT).toBeLessThanOrEqual(0);
    while (brain.reactT < 0) think(s);
    own(s, -1); think(s); // the next change after the gap re-arms
    expect(brain.reactT).toBe(delay);
  });

  it('a turnover (the previous situation our own ball) re-arms even while a delay or the gap runs', () => {
    const s = scene(Difficulty.BEGINNER);
    const delay = T_LEVEL.reactionTicks[Difficulty.BEGINNER]!;
    const brain = s.teams[1]!.cpu;
    own(s, 1); think(s);
    for (let t = 0; t < 40; t++) think(s);
    brain.seenOwner = 17; // as the carrier module leaves it: our player had the ball (and a delay of its own left)
    brain.reactT = 25;
    own(s, 2); think(s);
    expect(brain.reactT).toBe(delay);
  });

  it('every level: a long chain never freezes the defender longer than its own delay in a row', () => {
    for (let lv = Difficulty.BEGINNER; lv <= Difficulty.LEGEND; lv++) {
      const s = scene(lv as Difficulty);
      const delay = T_LEVEL.reactionTicks[lv]!;
      let run = 0, longest = 0;
      for (let k = 0; k < 40; k++) {
        own(s, k % 2 === 0 ? 1 + (k % 10) : -1);
        for (let t = 0; t < 7; t++) {
          think(s);
          if (s.teams[1]!.cpu.reactT > 0) { run++; if (run > longest) longest = run; } else run = 0;
        }
      }
      expect(longest, `level ${lv}`).toBeLessThanOrEqual(Math.max(1, delay));
    }
  });

  it('Beginner bot matches: no near-continuous freeze of the CPU defender (gaps under 15 ticks merged) over 2.5 s', () => {
    let longestMerged = 0, defTicks = 0;
    for (let m = 0; m < 2; m++) {
      const config = soakConfig(m, 13, { halfMinutes: 2, difficulty: Difficulty.BEGINNER });
      const merged = [0, 0];
      const gapT = [99, 99];
      runMatch({
        config, checker: 'none', fastCutscenes: true,
        onTick: (st) => {
          for (let t = 0; t < 2; t++) {
            // [QF-13 skeptic] Our own pass in flight is not defending: TAI-11 branch 1 meets the ball and ignores the
            // delay (armed when the pass left the foot), so those ticks are no freeze.
            const b = st.ball;
            const ownPass = b.owner < 0 && b.heldBy < 0 && b.passTarget >= 0 && b.lastTouchTeam === t &&
              st.players[b.passTarget]!.team === t;
            const inDef = st.match.phase === MatchPhase.IN_PLAY && possessingTeam(st) !== t && st.teams[t]!.cpu.active === 1 &&
              !ownPass;
            if (inDef) defTicks++;
            if (inDef && st.teams[t]!.cpu.reactT > 0) {
              if (gapT[t]! < 15) merged[t]! += gapT[t]!;
              gapT[t] = 0;
              merged[t]!++;
              if (merged[t]! > longestMerged) longestMerged = merged[t]!;
            } else if (!inDef) {
              // Our ball (or a stoppage) in between: the next delay is a new situation (a turnover re-arms).
              merged[t] = 0; gapT[t] = 99;
            } else {
              gapT[t]!++;
              if (gapT[t]! >= 15) merged[t] = 0;
            }
          }
        },
      });
    }
    expect(defTicks).toBeGreaterThan(10000);
    expect(longestMerged).toBeLessThanOrEqual(T_LEVEL.reactionTicks[Difficulty.BEGINNER]! + 1); // was up to 1746 (merged)
  });
});
