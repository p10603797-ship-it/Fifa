/**
 * [QF-13 skeptic] TAI-11 reception near a touchline / goal line. The CPU's controlled receiver of an overhit pass
 * sprinted onto it at the line with the stick on the ball (cpuDefend branch 1, the trailing run), or met it there with
 * the stick released (SIM-15's meeting point, clamped onto the line by the first pass), and SIM-07's clean settle (in
 * the stick / arrival direction, at the trap lead) put the ball over the line ahead of him: 1.4 throw-ins a match (18% of
 * all, 16 Professional matches) were a CPU player trapping the ball out of play. Now, about to receive with the trap's
 * settle point at the line, his stick's component toward it is turned into the pitch (receiveTurn) and the trap keeps
 * the ball in. [QF-13 skeptic, second run] The turn now triggers only when the predicted clean settle would end less
 * than T_CPU.defendReceiveSettleMargin inside the line (it turned every reception within 3 m of a line with any stick
 * component toward it, also those that stayed in, and the goals band went up).
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, Difficulty, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario, runTicks } from '../harness/scenario';

const PASSER = 6;
const RECV = 7;
const CPU0 = 2; // team 0's CPU controller

/**
 * Team 0 (CPU, attacking +x) has just played an overhit pass to RECV that rolls toward a line; RECV runs after it.
 * `line` 'touch' (toward +z) or 'goal' (toward +x, the opponents' goal line, off-centre so it is no shot).
 */
function scene(seed: number, line: 'touch' | 'goal', off: number, ballSpeed: number, runSpeed: number, gap: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, config: { difficulty: Difficulty.PROFESSIONAL } });
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = i < 11 ? -30 + k : -10 + k; p.z = -28 + k * 2; }
    p.vx = 0; p.vz = 0; p.act = ActionKind.NONE; p.stunT = 0; p.moveMode = MoveMode.STOP;
  }
  // Ball and receiver: the ball `off` m from the line rolling at it, the receiver `gap` m behind it running after it.
  const b = s.ball;
  let ux: number, uz: number, bx: number, bz: number;
  if (line === 'touch') { ux = 0.15; uz = 1; bx = 5; bz = HALF_WIDTH - off; } else { ux = 1; uz = 0.15; bx = HALF_LENGTH - off; bz = -18; }
  const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
  b.x = bx; b.z = bz; b.y = 0.11; b.px = bx; b.py = 0.11; b.pz = bz;
  b.vx = ux * ballSpeed; b.vz = uz * ballSpeed; b.vy = 0; b.grounded = 1; b.sx = 0; b.sy = 0; b.sz = 0;
  b.owner = -1; b.heldBy = -1; b.inNet = 0;
  const r = s.players[RECV]!;
  r.x = bx - ux * gap; r.z = bz - uz * gap; r.vx = ux * runSpeed; r.vz = uz * runSpeed; r.fx = ux; r.fz = uz;
  r.moveMode = MoveMode.DIRECT;
  const ps = s.players[PASSER]!;
  ps.x = bx - ux * 25; ps.z = bz - uz * 25;
  b.lastTouch = PASSER; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
  b.lastKickBy = PASSER; b.lastKickTeam = 0; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = s.tick;
  b.passTarget = RECV; b.passX = bx + ux * 4; b.passZ = bz + uz * 4; b.shotBy = -1;
  const ctl = s.ctrl[CPU0]!;
  if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === CPU0) s.players[ctl.slot]!.ctrl = -1;
  ctl.slot = RECV; r.ctrl = CPU0; ctl.switchLockT = 999;
  s.teams[0]!.cpu.seenOwner = -1; s.teams[0]!.cpu.reactT = 0;
  return s;
}

describe('QF-13 skeptic TAI-11: the CPU receiver keeps an overhit pass in at the line', () => {
  it('the CPU receiver never traps an overhit pass over the touchline or goal line (a grid of chases ending in a first touch)', () => {
    let receptions = 0, outOffHim = 0;
    const bad: string[] = [];
    for (const line of ['touch', 'goal'] as const) {
      for (const off of [1.5, 2.5, 3.5]) {
        for (const ballSpeed of [4, 5.5, 7]) {
          for (const gap of [1.5, 3]) {
            const s = scene(31 + receptions, line, off, ballSpeed, 7.5, gap);
            let touched = false, trapped = false;
            let prevRk = s.match.restart.kind as number;
            runTicks(s, 150, undefined, {
              until: (st) => {
                if (!touched && st.ball.lastTouch === RECV) {
                  touched = true;
                  // His first contact a SIM-07 first touch (a ball slower than minTrapSpeed is a SIM-06 pick-up).
                  trapped = st.players[RECV]!.act === ActionKind.FIRST_TOUCH;
                }
                const rk = st.match.restart.kind as number;
                if (rk !== prevRk && (rk === RestartKind.THROW_IN || rk === RestartKind.GOAL_KICK || rk === RestartKind.CORNER)) {
                  if (st.ball.lastTouch === RECV && trapped) {
                    outOffHim++;
                    if (bad.length < 8) bad.push(`${line} off ${off} ball ${ballSpeed} gap ${gap}: ${RestartKind[rk]} off the receiver`);
                  }
                  return true;
                }
                prevRk = rk;
                return st.ball.owner === RECV && st.players[RECV]!.act === ActionKind.NONE && st.match.phase === MatchPhase.IN_PLAY &&
                  Math.abs(st.ball.z) < HALF_WIDTH - 0.5 && Math.abs(st.ball.x) < HALF_LENGTH - 0.5 && Math.hypot(st.ball.vx, st.ball.vz) < 3;
              },
            });
            if (trapped) receptions++;
          }
        }
      }
    }
    expect(receptions).toBeGreaterThan(18); // he gets to the ball and traps it in most of them
    expect(bad).toEqual([]);
    expect(outOffHim).toBe(0);
  });

  it('Professional bot matches: CPU players no longer trap the ball out of play', { timeout: 120000 }, () => {
    let trappedOut = 0, throwIns = 0;
    for (let m = 0; m < 4; m++) {
      const config = soakConfig(m, 202, { halfMinutes: 3, difficulty: Difficulty.PROFESSIONAL });
      config.cupRules = 0;
      let lastOwner = -1, lastOwnerTick = -1, prevRk = 0, trapBy = -1, trapTick = -1;
      runMatch({
        config, checker: 'none', fastCutscenes: true,
        onTick: (st) => {
          const b = st.ball;
          // A CPU-controlled player's SIM-07 trap (FIRST_TOUCH action on the tick he touched it).
          if (b.lastTouchTick === st.tick && b.lastTouch >= 0) {
            const q = st.players[b.lastTouch]!;
            if (q.act === ActionKind.FIRST_TOUCH && q.ctrl >= 2) { trapBy = b.lastTouch; trapTick = st.tick; } else trapBy = -1;
          }
          const rk = st.match.restart.kind as number;
          if (rk !== prevRk && (rk === RestartKind.THROW_IN || rk === RestartKind.GOAL_KICK || rk === RestartKind.CORNER)) {
            if (rk === RestartKind.THROW_IN) throwIns++;
            // He trapped it, owned it up to the tick it went out and touched it last: trapped out of play.
            if (trapBy >= 0 && trapBy === b.lastTouch && lastOwner === trapBy && lastOwnerTick === st.tick - 1 &&
                st.tick - trapTick <= 60) trappedOut++;
          }
          prevRk = rk;
          if (b.owner >= 0) { lastOwner = b.owner; lastOwnerTick = st.tick; }
        },
      });
    }
    expect(throwIns).toBeGreaterThan(5); // (a control on the sample: 8 here once the traps out are gone)
    expect(trappedOut).toBeLessThanOrEqual(1); // 9 in these 4 matches on the first pass tree
  });
});
