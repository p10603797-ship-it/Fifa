/**
 * [QF-13 skeptic] TAI-11 reaction delay at an interception. The first pass's chain fix re-arms the delay on a turnover
 * only when the previous situation was our own ball; our own pass leaving the foot (our ball -> loose) was that
 * turnover, so the delay ran down while our pass was in flight (branch 1 has no delay) and the interception that
 * followed (loose -> theirs) found it running or spent and did not re-arm it: a Beginner CPU defender reacted to an
 * intercepted pass after 46-58 of his 80 ticks on average, and at once after 1 interception in 10 (Beginner matches).
 * Now our pass in flight is remembered (OUR_PASS) and an opponent taking it re-arms the delay in full; our own ball
 * going loose still starts it as before (clearing it there instead freed a Beginner's chase of his own failed passes:
 * Amateur v Beginner fell from 68% to 58%).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_LEVEL } from '../../src/contracts/tuning';
import { cpuDefend } from '../../src/ai/cpu/defending';
import { NULL_SINK } from '../../src/sim/core/events';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario } from '../harness/scenario';

const D = 15; // CPU defender (team 1)
const CPU = 3; // team 1's CPU controller
const OUT = createInputFrame();

function scene(level: Difficulty): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], seed: 21, config: { difficulty: level } });
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
  brain.level = level; brain.reactT = 0; brain.tackleCd = 0;
  return s;
}

function think(s: SimState): void {
  s.tick++;
  clearInputFrame(OUT);
  cpuDefend(s, 1, OUT, NULL_SINK);
}

/** Team 1's player `from` has just passed to teammate `to`: the ball loose and travelling, an untouched pass. */
function ourPass(s: SimState, from: number, to: number): void {
  const b = s.ball;
  const p = s.players[from]!;
  b.owner = -1; b.heldBy = -1; b.x = p.x - 0.5; b.z = p.z; b.y = 0.11; b.vx = -8; b.vz = 0; b.vy = 0; b.grounded = 1;
  b.lastTouch = from; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = from; b.lastKickTeam = 1;
  b.lastKickTick = s.tick; b.passTarget = to;
}

function own(s: SimState, owner: number): void {
  const b = s.ball;
  const p = s.players[owner]!;
  b.owner = owner; b.heldBy = -1; b.passTarget = -1; b.lastTouch = owner; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick;
  b.x = p.x + 0.4; b.z = p.z; b.vx = 0; b.vz = 0;
}

describe('QF-13 skeptic TAI-11: an intercepted pass arms the full reaction delay', () => {
  it('at every level the interception of our pass (after a long flight too) arms the whole delay', () => {
    for (let lv = Difficulty.BEGINNER; lv <= Difficulty.LEGEND; lv++) {
      for (const flight of [5, 40, 90]) {
        const s = scene(lv as Difficulty);
        const brain = s.teams[1]!.cpu;
        const delay = T_LEVEL.reactionTicks[lv]!;
        brain.seenOwner = 17; // as the carrier module leaves it: our player 17 had the ball
        own(s, 17);
        ourPass(s, 17, 19);
        think(s);
        expect(brain.reactT, `level ${lv}: our ball going loose starts the delay as before`).toBe(delay);
        for (let t = 1; t < flight; t++) think(s);
        expect(brain.reactT).toBeLessThan(delay > 1 ? delay : 2); // running down (or spent) while the pass flies
        own(s, 4); // intercepted by team 0
        think(s);
        expect(brain.reactT, `level ${lv} flight ${flight}`).toBe(delay);
      }
    }
  });

  it('a pass deflected loose first is a plain loose ball: the delay from the pass holds, the pick-up does not chain it', () => {
    const s = scene(Difficulty.AMATEUR);
    const brain = s.teams[1]!.cpu;
    const delay = T_LEVEL.reactionTicks[Difficulty.AMATEUR]!;
    brain.seenOwner = 17;
    own(s, 17);
    ourPass(s, 17, 19);
    think(s);
    for (let t = 0; t < 20; t++) think(s);
    // Deflected off a team 0 player: no longer our pass in flight, still loose; then he picks it up.
    s.ball.lastTouch = 5; s.ball.lastTouchTeam = 0; s.ball.passTarget = -1;
    for (let t = 0; t < 20; t++) think(s);
    expect(brain.reactT).toBeGreaterThan(0); // the delay from the pass holds his run now (branch 2)
    expect(brain.reactT).toBeLessThan(delay - 30);
    const before = brain.reactT;
    own(s, 5);
    think(s);
    expect(brain.reactT).toBe(before - 1); // no chain: the freeze stays one delay long
  });

  it('our pass received by our teammate is no turnover (no re-arm on the reception)', () => {
    const s = scene(Difficulty.BEGINNER);
    const brain = s.teams[1]!.cpu;
    brain.seenOwner = 17;
    ourPass(s, 17, 19);
    think(s);
    for (let t = 0; t < 30; t++) think(s);
    const before = brain.reactT;
    own(s, 19); // our receiver has it (the carrier module takes over; the defending upkeep must not re-arm)
    think(s);
    expect(brain.reactT).toBeLessThanOrEqual(before);
  });

  it('a tackle (our ball knocked loose: no pass) still starts the delay at once', () => {
    const s = scene(Difficulty.BEGINNER);
    const brain = s.teams[1]!.cpu;
    brain.seenOwner = 17;
    own(s, 17);
    const b = s.ball;
    b.owner = -1; b.passTarget = -1; b.lastTouch = 4; b.lastTouchTeam = 0; b.vx = 3;
    think(s);
    expect(brain.reactT).toBe(T_LEVEL.reactionTicks[Difficulty.BEGINNER]);
  });

  it('Beginner bot matches: the CPU defender gets (almost) his whole delay after the opponent intercepts a pass', { timeout: 120000 }, () => {
    const delay = T_LEVEL.reactionTicks[Difficulty.BEGINNER]!;
    const left: number[] = [];
    for (let m = 0; m < 2; m++) {
      const config = soakConfig(m, 101, { halfMinutes: 3, difficulty: Difficulty.BEGINNER });
      config.cupRules = 0;
      let passTeam = -1, prevKey = -1;
      let pending: { team: number; tick: number } | null = null;
      runMatch({
        config, checker: 'none', fastCutscenes: true,
        onTick: (st) => {
          const b = st.ball;
          const key = b.heldBy >= 0 ? b.heldBy : b.owner >= 0 ? b.owner : -1;
          if (pending && st.tick === pending.tick + 1) {
            const r = st.teams[pending.team]!.cpu.reactT;
            left.push(r > 0 ? r : 0);
            pending = null;
          }
          // An interception: a team's pass in flight (last tick) taken by a player of the other team.
          if (st.match.phase === MatchPhase.IN_PLAY && prevKey === -1 && key >= 0 && passTeam >= 0 &&
              st.players[key]!.team !== passTeam) {
            pending = { team: passTeam, tick: st.tick };
          }
          const pt = b.passTarget;
          passTeam = key < 0 && pt >= 0 && pt < 22 && st.players[pt]!.team === b.lastTouchTeam ? b.lastTouchTeam : -1;
          prevKey = key;
        },
      });
    }
    expect(left.length).toBeGreaterThan(5);
    const mean = left.reduce((a, b) => a + b, 0) / left.length;
    const none = left.filter((x) => x === 0).length;
    expect(mean).toBeGreaterThan(0.9 * delay);
    expect(none).toBe(0);
  });
});
