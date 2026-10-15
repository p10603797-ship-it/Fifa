/**
 * [QF-11 skeptic] Regression tests for defects found by the second QF-11 pass (ladder levels / keepers), one per defect,
 * named after the symptom.
 *  1. TAI-07: a CPU-controlled player still in his brain's reaction delay (TAI-11 branch 2 keeps his old run) was made
 *     the loose-ball chaser although he ran the other way: at Beginner (80 ticks) nobody went for the ball for up to
 *     1.3 s, about 10 times a short match.
 *  4. GKP-02: when a shot had got past an unreacted keeper (behind his plane), the save decision freed him and SIM-07
 *     gave him a heavy first touch on it from behind: the ball went in off him as an own goal (the scorer lost), or was
 *     stopped by a keeper who never saw it. He now stays planted until it is in or away.
 *  5. GKP-02 tip over from under the bar's footprint (contact closer to the line than ball radius + bar): the ball
 *     rose into the underside of the bar and dropped in (an own goal in a match; 12 of 72 test contacts). He now parries
 *     it out from there (T_GK.tipBarFront).
 *  6. GKP-02 / GKP-03: a slow ball rolling at goal at the edge of reaching the line made GKP-02 take a rushing keeper into
 *     a set catch and drop it 1-3 ticks later when the prediction flickered, and GKP-03 restarted the rush (start /
 *     abort flip-flop; found by the QF-2 keeper scan). The set catch is now kept T_GK.catchKeepTicks while the ball
 *     still comes at him.
 *  3. TAI-11 (first pass's edge clamp incomplete): a CPU defender sprinting straight at a touchline / goal line in his
 *     reaction delay still ran 2.2-2.4 m off the pitch: the fixed 2 m margin is shorter than his braking distance
 *     (9 m/s: 4 m). The margin now grows with v^2 / (2 x T_PLAYER.decel).
 *  2. GKP-02: an idle AI keeper left a post rebound / loose ball inside his reach to SIM-07's outfield first touch, which
 *     settles the ball along his run (back toward his line) and put it in his own net (2 own goals in 30 Professional
 *     matches). He now gathers it into his hands.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, AiJob, Difficulty, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_AI, T_GK, T_TOUCH } from '../../src/contracts/tuning';
import { assignChaser } from '../../src/ai/steer';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario, runTicks } from '../harness/scenario';

// ---------------------------------------------------------------- 1. chaser in the reaction delay

const C = 7; // team 0's CPU-controlled player
const T = 8; // an AI-driven teammate

/** A loose ball lying at the centre spot (an opponent touched it last); team 0's controlled player C 2 m from it running
 *  away at 6 m/s, teammate T 6 m away standing; everyone else far away. */
function looseScene(reactT: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 7, config: { difficulty: Difficulty.BEGINNER } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -40 : 40; p.z = -25 + (i % 11) * 5; p.vx = 0; p.vz = 0; p.act = ActionKind.NONE; p.stunT = 0;
    p.moveMode = MoveMode.STOP; p.ctrl = -1;
  }
  const c = s.players[C]!;
  c.x = -2; c.z = 0; c.vx = -6; c.vz = 0; c.fx = -1; c.fz = 0;
  const t = s.players[T]!;
  t.x = 6; t.z = 2;
  for (let team = 0; team < 2; team++) s.ctrl[CPU_CONTROLLER_BASE + team]!.slot = -1;
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = C;
  c.ctrl = CPU_CONTROLLER_BASE;
  const b = s.ball;
  b.x = 0; b.z = 0; b.y = 0.11; b.px = 0; b.pz = 0; b.py = 0.11; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = -1; b.heldBy = -1; b.passTarget = -1; b.lastTouch = 14; b.lastTouchTeam = 1; b.lastKickTeam = 1;
  const brain = s.teams[0]!.cpu;
  brain.active = 1; brain.level = Difficulty.BEGINNER; brain.reactT = reactT; brain.seenOwner = -1;
  s.teams[0]!.chaser = -1; s.teams[0]!.chaserT = 0;
  return s;
}

describe('QF-11 skeptic: TAI-07 chaser and the CPU reaction delay', () => {
  it('control: after the delay the controlled player near the ball is the chaser (near claim)', () => {
    const s = looseScene(0);
    assignChaser(s, 0, NULL_SINK);
    expect(s.teams[0]!.chaser).toBe(C);
  });

  it('glitch: two teammates chase or nobody does — a CPU-controlled player still keeping his old run away from the ball is not made the chaser while a teammate gets there sooner', () => {
    expect(T_AI.chaserReactNearDist).toBeGreaterThan(0);
    const s = looseScene(60);
    assignChaser(s, 0, NULL_SINK);
    expect(s.teams[0]!.chaser, 'the AI teammate goes for it').toBe(T);
    expect(s.players[T]!.job).toBe(AiJob.CHASE_LOOSE);
  });

  it('a controlled player whose run already takes him to the ball keeps the chase in his delay', () => {
    const s = looseScene(60);
    const c = s.players[C]!;
    c.vx = 6; c.fx = 1; // running at the ball
    assignChaser(s, 0, NULL_SINK);
    expect(s.teams[0]!.chaser).toBe(C);
  });
});

// ---------------------------------------------------------------- 2. keeper gather

describe('QF-11 skeptic: GKP-02 idle keeper gathers a loose ball in reach', () => {
  it('the gather reach covers SIM-07\'s receive reach (his hands get there before a first touch)', () => {
    expect(T_GK.gatherReach).toBeGreaterThanOrEqual(T_TOUCH.receiveRadius);
  });

  it('glitch: Keeper carries it over his own line — a post rebound dropping at an idle keeper on his line is caught, never first-touched into his own net', () => {
    // Replays the match case (shot off the post, ball rising at the keeper who walks back to his line): before the fix
    // 12 of these 24 variants ended in an own goal off his first touch.
    let n = 0, held = 0, touches = 0, goals = 0;
    for (const vz of [-5.4, -4, -3, 3, 4, 5.4]) {
      for (const kvx of [1.5, 0.8]) {
        for (const bz of [1.4, 2.0]) {
          const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 91 });
          const t = 1;
          const dir = s.teams[t]!.dir;
          const k = s.teams[t]!.keeperSlot;
          const ok = s.teams[0]!.keeperSlot;
          const gx = (d: number): number => -dir * (HALF_LENGTH - d); // x at depth d in front of team t's goal line
          for (let i = 0; i < 22; i++) {
            if (i === k || i === ok) continue;
            const p = s.players[i]!;
            p.x = dir * 10 + (i % 11); p.z = -20 + (i % 11) * 4; p.vx = 0; p.vz = 0;
          }
          const side = vz < 0 ? 1 : -1;
          const p = s.players[k]!;
          p.x = gx(0.65); p.z = 0.8 * side; p.vx = -dir * kvx; p.vz = -1.4 * side; p.act = ActionKind.NONE;
          const b = s.ball;
          b.x = gx(0.42); b.z = bz * side; b.y = 1.4; b.vx = dir * 0.9; b.vz = vz; b.vy = 5.9;
          b.px = b.x; b.pz = b.z; b.py = b.y; b.grounded = 0; b.owner = -1; b.heldBy = -1; b.passTarget = -1;
          const shooter = ok === 0 ? 5 : 16;
          b.lastTouch = shooter; b.lastTouchTeam = 0; b.lastKickBy = shooter; b.lastKickTeam = 0;
          b.lastKickKind = KickKind.SHOT_NORMAL; b.lastTouchTick = s.tick - 60; b.lastKickTick = s.tick - 60;
          b.shotBy = shooter; b.shotTick = s.tick - 60; b.shotOnTarget = 1;
          n++;
          let touched = false;
          const ev = runTicks(s, 60, undefined, {
            until: (st) => {
              if (st.players[k]!.act === ActionKind.FIRST_TOUCH) touched = true;
              return st.ball.heldBy === k || st.match.phase !== MatchPhase.IN_PLAY;
            },
          });
          if (touched) touches++;
          if (s.ball.heldBy === k) held++;
          goals += ev.filter((e) => e.type === EventType.GOAL).length;
        }
      }
    }
    expect(n).toBe(24);
    expect(goals, 'own goals').toBe(0);
    expect(touches, 'outfield first touches by the keeper').toBe(0);
    expect(held, 'balls gathered into his hands').toBe(n);
  });

  it('a teammate\'s foot pass (back-pass) reaching the idle keeper is never gathered into his hands', () => {
    // Back-pass: a teammate's deliberate ground pass reaches the idle AI keeper: no hands (SIM-07 / SIM-06 play it).
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 92 });
    const t = 1;
    const dir = s.teams[t]!.dir;
    const k = s.teams[t]!.keeperSlot;
    const mate = k + 4;
    for (let i = 0; i < 22; i++) {
      if (i === k) continue;
      const p = s.players[i]!;
      p.x = dir * 20 + (i % 11); p.z = -20 + (i % 11) * 4; p.vx = 0; p.vz = 0;
    }
    const p = s.players[k]!;
    p.x = -dir * (HALF_LENGTH - 6); p.z = 0; p.vx = 0; p.vz = 0; p.act = ActionKind.NONE;
    const b = s.ball;
    b.x = p.x + dir * 4; b.z = 0.3; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = -dir * 6; b.vz = 0; b.vy = 0;
    b.grounded = 1; b.owner = -1; b.heldBy = -1;
    b.lastTouch = mate; b.lastTouchTeam = t; b.lastKickBy = mate; b.lastKickTeam = t; b.lastKickKind = KickKind.GROUND_PASS;
    b.lastTouchTick = s.tick - 5; b.lastKickTick = s.tick - 5; b.passTarget = k;
    s.players[mate]!.lastTouchTick = s.tick - 5;
    let handled = false;
    runTicks(s, 40, undefined, { until: (st) => { if (st.ball.heldBy === k) handled = true; return handled; } });
    expect(handled, 'back-pass rule').toBe(false);
  });
});

// ---------------------------------------------------------------- 3. sprinting defender in the reaction delay

describe('QF-11 skeptic: TAI-11 reaction delay at sprint speed', () => {
  it('a CPU defender sprinting straight at a touchline / goal line in his reaction delay stops on the pitch (ran 2.3 m off)', () => {
    const D = 15;
    const cases: ['x' | 'z', number, number, number][] = [
      ['z', -1, 9, 4.5], ['z', 1, 9, 5], ['z', 1, 6, 3], ['x', 1, 9, 5], ['z', -1, 9.5, 6], ['x', -1, 8, 4.5],
    ];
    for (const [axis, side, speed, start] of cases) {
      const s = makeScenario({
        phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], seed: 11, config: { difficulty: Difficulty.BEGINNER },
      });
      for (let i = 0; i < 22; i++) {
        const p = s.players[i]!;
        const k = i % 11;
        if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
        p.vx = 0; p.vz = 0; p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP;
      }
      // The human carrier stands still with the ball in midfield (a change of owner starts the CPU's reaction delay).
      const q = s.players[9]!;
      q.x = 10; q.z = 0;
      const b = s.ball;
      b.x = 10.4; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = 0; b.py = 0.11; b.vx = 0; b.vz = 0; b.vy = 0; b.grounded = 1;
      b.owner = 9; b.heldBy = -1; b.lastTouch = 9; b.lastTouchTeam = 0;
      const d = s.players[D]!;
      if (axis === 'z') { d.x = 0; d.z = side * (HALF_WIDTH - start); d.vx = 0; d.vz = side * speed; d.fx = 0; d.fz = side; }
      else { d.x = side * (HALF_LENGTH - start); d.z = 10; d.vx = side * speed; d.vz = 0; d.fx = side; d.fz = 0; }
      d.sprinting = 1;
      for (let i = 11; i < 22; i++) if (s.players[i]!.ctrl === CPU_CONTROLLER_BASE + 1) s.players[i]!.ctrl = -1;
      const ctl = s.ctrl[CPU_CONTROLLER_BASE + 1]!;
      ctl.slot = D; d.ctrl = CPU_CONTROLLER_BASE + 1; ctl.switchLockT = 0;
      const brain = s.teams[1]!.cpu;
      brain.level = Difficulty.BEGINNER; brain.seenOwner = -5; brain.reactT = 0;
      let maxOut = -99, delayed = 0;
      runTicks(s, 75, undefined, {
        until: (st) => {
          const p = st.players[D]!;
          if (st.teams[1]!.cpu.reactT > 0 && st.ctrl[CPU_CONTROLLER_BASE + 1]!.slot === D) delayed++;
          const out = Math.max(Math.abs(p.x) - HALF_LENGTH, Math.abs(p.z) - HALF_WIDTH);
          if (out > maxOut) maxOut = out;
          return false;
        },
      });
      const tag = `${axis} side ${side} ${speed} m/s from ${start} m`;
      expect(delayed, `${tag}: in his reaction delay throughout`).toBeGreaterThanOrEqual(70);
      expect(maxOut, `${tag}: metres past the line`).toBeLessThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------- 4. shot already past the keeper

describe('QF-11 skeptic: GKP-02 a ball already past the keeper', () => {
  it('glitch: Keeper dives after the ball has passed — nor takes a first touch on a shot behind him (it went in off him as an own goal)', () => {
    let n = 0, touches = 0, own = 0, goals = 0;
    for (const kz of [2.3, 2.61, 2.9]) {
      for (const bz of [3.4, 3.71]) {
        for (const sp of [15, 17.2, 20]) {
          for (const kd of [0.87, 1.2]) {
            const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 32 });
            const t = 0;
            const dir = s.teams[t]!.dir;
            const k = s.teams[t]!.keeperSlot;
            const ok = s.teams[1]!.keeperSlot;
            const gx = (d: number): number => -dir * (HALF_LENGTH - d);
            for (let i = 0; i < 22; i++) {
              if (i === k || i === ok) continue;
              const p = s.players[i]!;
              p.x = -dir * 10 + (i % 11); p.z = -20 + (i % 11) * 4; p.vx = 0; p.vz = 0;
            }
            const shooter = 20;
            const sh = s.players[shooter]!;
            sh.x = gx(2.6); sh.z = 3.9;
            const p = s.players[k]!;
            p.x = gx(kd); p.z = kz; p.vx = 0; p.vz = 0; p.act = ActionKind.NONE;
            // A close-range shot just struck past him at the near post: he has not reacted yet.
            const b = s.ball;
            b.x = gx(2.2); b.z = bz; b.y = 0.16; b.vx = -dir * sp; b.vz = (-4.7 * sp) / 17.2; b.vy = 2.9;
            b.px = b.x; b.pz = b.z; b.py = b.y; b.grounded = 0; b.owner = -1; b.heldBy = -1; b.passTarget = -1;
            b.lastTouch = shooter; b.lastTouchTeam = 1; b.lastKickBy = shooter; b.lastKickTeam = 1;
            b.lastKickKind = KickKind.SHOT_NORMAL; b.lastTouchTick = s.tick; b.lastKickTick = s.tick;
            b.shotBy = shooter; b.shotTick = s.tick; b.shotOnTarget = 1;
            sh.lastTouchTick = s.tick;
            n++;
            let touched = false;
            const ev = runTicks(s, 40, undefined, {
              until: (st) => {
                if (st.players[k]!.act === ActionKind.FIRST_TOUCH) touched = true;
                return st.match.phase !== MatchPhase.IN_PLAY;
              },
            });
            if (touched) touches++;
            for (const e of ev) if (e.type === EventType.GOAL) { goals++; if (e.d === 1) own++; }
          }
        }
      }
    }
    expect(n).toBe(36);
    expect(touches, 'first touches on a ball behind him').toBe(0);
    expect(own, 'own goals off the keeper').toBe(0);
    expect(goals, 'the beaten shots go in (credited to the shooter)').toBeGreaterThan(n / 2);
  });
});

// ---------------------------------------------------------------- 5. tip over at the line

describe('QF-11 skeptic: GKP-02 tip over at the line', () => {
  it('a dropping ball pushed away at the line never goes in off the keeper (a tip under the bar met its underside and dropped in)', () => {
    // The match case: a lofted ball dropping at the near post under the bar, the keeper on his line; too fast for his
    // hands (handling 1 / 40), so he tips or parries it. Before the fix 12 of 72 went in off the bar as own goals.
    let n = 0, touched = 0, goals = 0;
    for (const kd of [0.3, 0.43, 0.55]) {
      for (const dy of [-0.3, -0.15, 0, 0.15, 0.3]) {
        for (const dvy of [-0.4, 0, 0.4]) {
          for (const hand of [1, 40]) {
            const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 32 });
            const t = 1;
            const dir = s.teams[t]!.dir;
            const k = s.teams[t]!.keeperSlot;
            const ok = s.teams[0]!.keeperSlot;
            const gx = (d: number): number => -dir * (HALF_LENGTH - d);
            for (let i = 0; i < 22; i++) {
              if (i === k || i === ok) continue;
              const p = s.players[i]!;
              p.x = dir * 10 + (i % 11); p.z = -20 + (i % 11) * 4; p.vx = 0; p.vz = 0;
            }
            const p = s.players[k]!;
            p.x = gx(kd); p.z = -2.4; p.vx = 0; p.vz = 0; p.act = ActionKind.NONE;
            s.attrs[k]!.gkHandling = hand;
            const passer = ok === 0 ? 5 : 16;
            const b = s.ball;
            b.x = gx(6.19); b.z = -5.86; b.y = 6.6 + dy; b.vx = -dir * 14.6; b.vz = 8.4; b.vy = -8.8 + dvy;
            b.px = b.x; b.pz = b.z; b.py = b.y; b.grounded = 0; b.owner = -1; b.heldBy = -1; b.passTarget = -1;
            b.lastTouch = passer; b.lastTouchTeam = 0; b.lastKickBy = passer; b.lastKickTeam = 0;
            b.lastKickKind = KickKind.LOB_PASS; b.lastTouchTick = s.tick - 40; b.lastKickTick = s.tick - 40;
            n++;
            let kept = false;
            const ev = runTicks(s, 60, undefined, {
              until: (st, te) => {
                for (const e of te) {
                  if (e.type === EventType.KICK && (e.b === KickKind.GK_TIP || e.b === KickKind.GK_PARRY)) kept = true;
                }
                return st.match.phase !== MatchPhase.IN_PLAY;
              },
            });
            if (kept) touched++;
            goals += ev.filter((e) => e.type === EventType.GOAL).length;
          }
        }
      }
    }
    expect(n).toBe(90);
    expect(touched, 'the scene makes tips / parries (control)').toBeGreaterThanOrEqual(60);
    expect(goals, 'goals off the keeper\'s tip / parry').toBe(0);
  });
});

// ---------------------------------------------------------------- 6. rush / catch flip-flop

describe('QF-11 skeptic: GKP-02 / GKP-03 slow ball at goal', () => {
  it('a rushing keeper taken into a set catch keeps it: no catch dropped within 4 ticks for a new rush (flip-flop)', () => {
    let n = 0, flips = 0, catches = 0;
    for (const bvx of [5.0, 5.6, 6.2, 6.8, 7.4]) {
      for (const bd of [5.6, 6.2, 6.8, 7.4]) {
        for (const kz of [-1.2, -1.7]) {
          for (const vy of [0, 0.4, 0.8, 1.2]) {
            const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 0x2f2 });
            const t = 0;
            const dir = s.teams[t]!.dir;
            const k = s.teams[t]!.keeperSlot;
            const ok = s.teams[1]!.keeperSlot;
            const gx = (d: number): number => -dir * (HALF_LENGTH - d);
            for (let i = 0; i < 22; i++) {
              if (i === k || i === ok) continue;
              const p = s.players[i]!;
              p.x = -dir * 15 + (i % 11); p.z = -20 + (i % 11) * 4; p.vx = 0; p.vz = 0;
            }
            const p = s.players[k]!;
            p.x = gx(2.1); p.z = kz; p.vx = 0; p.vz = 0; p.act = ActionKind.NONE;
            // An opponent's long ball rolling and bouncing slowly at the near post (the match case: 7.4 m/s, 6 m out).
            const b = s.ball;
            b.x = gx(bd); b.z = -3.46; b.y = 0.17; b.vx = -dir * bvx; b.vz = 5.5; b.vy = vy;
            b.px = b.x; b.pz = b.z; b.py = b.y; b.grounded = 0; b.owner = -1; b.heldBy = -1; b.passTarget = -1;
            const opp = ok === 11 ? 16 : 5;
            b.lastTouch = opp; b.lastTouchTeam = 1; b.lastKickBy = opp; b.lastKickTeam = 1;
            b.lastKickKind = KickKind.GROUND_PASS; b.lastTouchTick = s.tick - 120; b.lastKickTick = s.tick - 120;
            n++;
            let prev = ActionKind.NONE, catchStart = -999, flip = false;
            runTicks(s, 60, undefined, {
              until: (st) => {
                const a = st.players[k]!.act;
                if (a === ActionKind.GK_CATCH && prev !== a) { catchStart = st.tick; catches++; }
                if (a === ActionKind.GK_RUSH && prev === ActionKind.GK_CATCH && st.tick - catchStart <= 4) flip = true;
                prev = a;
                return st.ball.heldBy >= 0 || st.match.phase !== MatchPhase.IN_PLAY;
              },
            });
            if (flip) flips++;
          }
        }
      }
    }
    expect(n).toBe(160);
    expect(catches, 'GKP-02 takes over some rushes (control)').toBeGreaterThan(40);
    expect(flips, 'set catches dropped for a rush within 4 ticks (before the fix: 6)').toBe(0);
  });
});
