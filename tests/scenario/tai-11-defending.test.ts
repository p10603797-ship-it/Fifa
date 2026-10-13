/**
 * TAI-11 CPU defending, frame level: cpuDefend is called directly on hand-built IN_PLAY states (team 1 is the CPU and
 * defends the goal at x = +52.5; the human carrier, slot 9 of team 0, attacks +x) and the produced InputFrame is
 * checked against BRIEF §7 / §10 and the TAI-11 brief: goal-side approach, jockey within ~3 m, contain, second
 * defender in the final third, keeper rush on one-on-ones, tackle timing after tackleTimingTicks with the tackleCd
 * cooldown (better levels strike earlier), rash lunges that grow with decision noise, rare slides from behind, player
 * choice by gesture TAP or MOD_L, reaction delay, loose-ball interception and clearances, frame-only writes and
 * determinism.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, PITCH_LENGTH } from '../../src/contracts/constants';
import { ActionKind, Difficulty, GestureKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { AXIS_SCALE, Btn, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_LEVEL, T_SKILL, T_TACKLE } from '../../src/contracts/tuning';
import { cpuDefend, DEFEND_TUNING as L, noise01, throughOnGoal } from '../../src/ai/cpu/defending';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';

const D = 15; // CPU defender (team 1)
const C = 9; // human carrier (team 0)
const T = 16; // CPU teammate
const CPU = 3; // controller index of team 1's CPU brain
const LEVELS = [0, 1, 2, 3, 4, 5] as Difficulty[];

interface Pos { x: number; z: number; vx?: number; vz?: number; fx?: number; fz?: number }
interface SceneOpts {
  level?: Difficulty;
  d: Pos;
  c: Pos;
  /** Ball relative to the carrier (owned by him) unless loose. */
  ball?: { dx: number; dz: number; vx?: number; vz?: number };
  tick?: number;
  seed?: number;
}

/** Quiet IN_PLAY scene: everyone else parked far up the pitch (x = -45), keepers on their lines. */
function scene(o: SceneOpts): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed: o.seed ?? 11,
    config: { difficulty: o.level ?? Difficulty.PROFESSIONAL },
  });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
  }
  place(s, D, o.d, -1);
  place(s, C, o.c, 1);
  const q = s.players[C]!;
  const b = s.ball;
  const bo = o.ball ?? { dx: 0.4, dz: 0 };
  b.x = q.x + bo.dx; b.z = q.z + bo.dz; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y;
  b.vx = bo.vx ?? q.vx; b.vz = bo.vz ?? q.vz; b.vy = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0;
  s.tick = o.tick ?? 1000;
  b.lastTouchTick = s.tick - 2; q.lastTouchTick = s.tick - 2;
  const ctl = s.ctrl[CPU]!;
  ctl.slot = D; s.players[D]!.ctrl = CPU; ctl.switchLockT = 0; ctl.nextSwitch = -1; ctl.buttons = 0; ctl.prevButtons = 0;
  const brain = s.teams[1]!.cpu;
  brain.level = o.level ?? Difficulty.PROFESSIONAL;
  brain.seenOwner = C; brain.reactT = 0; brain.tackleCd = 0;
  return s;
}

function place(s: SimState, slot: number, o: Pos, face: number): void {
  const p = s.players[slot]!;
  p.x = o.x; p.z = o.z; p.vx = o.vx ?? 0; p.vz = o.vz ?? 0; p.fx = o.fx ?? face; p.fz = o.fz ?? 0;
  p.act = ActionKind.NONE; p.stunT = 0; p.moveMode = MoveMode.STOP;
}

const OUT = createInputFrame();
/** One cpuDefend call into a fresh frame (as cpuThink does); the frame's buttons also become last tick's buttons. */
function think(s: SimState): InputFrame {
  clearInputFrame(OUT);
  cpuDefend(s, 1, OUT, NULL_SINK);
  return OUT;
}
/** Advance one "tick" for the brain only: tick++, last frame's buttons become ctrl.buttons (like the resolver). */
function thinkNext(s: SimState): InputFrame {
  s.tick++;
  const f = think(s);
  s.ctrl[CPU]!.prevButtons = s.ctrl[CPU]!.buttons;
  s.ctrl[CPU]!.buttons = f.buttons;
  return f;
}
const has = (f: InputFrame, bit: number): boolean => (f.buttons & bit) !== 0;
const stick = (f: InputFrame): { x: number; z: number; m: number } => {
  const m = Math.sqrt(f.mx * f.mx + f.mz * f.mz);
  return { x: m > 0 ? f.mx / m : 0, z: m > 0 ? f.mz / m : 0, m: m / AXIS_SCALE };
};

/** A carrier dribbling at the defender with the ball pushed 1 m ahead, `age` ticks after his touch (exposed). */
function exposedScene(level: Difficulty, age: number, seed = 11): SimState {
  const s = scene({
    level, seed, c: { x: 30, z: 0, vx: 4, fx: 1 }, d: { x: 32.5, z: 0 }, ball: { dx: 1.0, dz: 0, vx: 5, vz: 0 },
  });
  s.players[C]!.lastTouchTick = s.tick - age;
  s.ball.lastTouchTick = s.tick - age;
  return s;
}

describe('TAI-11 approach, jockey and contain', () => {
  it('goal-side approach: a defender off to the side runs to the guard point between the carrier and our goal', () => {
    const s = scene({ c: { x: 10, z: 0, vx: 0 }, d: { x: 20, z: 15 } });
    const f = think(s);
    const st = stick(f);
    // Guard point: carrier + 2 m-ish toward the goal centre (+x), i.e. near (12, 0).
    const gx = 12 - 20, gz = 0 - 15, gl = Math.hypot(gx, gz);
    expect(st.x * (gx / gl) + st.z * (gz / gl)).toBeGreaterThan(0.95);
    expect(st.m).toBeGreaterThan(0.99);
    expect(has(f, Btn.SPRINT)).toBe(true); // far from the point
    expect(has(f, Btn.SHIELD)).toBe(false);
  });

  it('goal-side approach: a defender behind the carrier recovers deeper than the carrier (sprinting), never at him', () => {
    for (const dz of [-1, 0.3, 2]) {
      const s = scene({ c: { x: 10, z: 0, vx: 4, fx: 1 }, d: { x: 6, z: dz } });
      const f = think(s);
      const st = stick(f);
      expect(st.x).toBeGreaterThan(0.6); // heading toward our goal, past the carrier
      expect(has(f, Btn.SPRINT)).toBe(true);
      expect(has(f, Btn.SHIELD)).toBe(false);
      expect(has(f, Btn.SHOOT)).toBe(false); // never tackles from behind
    }
  });

  it('jockey distance: SHIELD held goal-side within ~3 m (kept to 3.6 m once jockeying), not beyond', () => {
    for (const [dist, held] of [[1.8, true], [2.9, true], [3.3, false], [5, false]] as const) {
      const s = scene({ c: { x: 10, z: 0 }, d: { x: 10 + dist, z: 0 } });
      expect(has(think(s), Btn.SHIELD), `d=${dist}`).toBe(held);
    }
    const s = scene({ c: { x: 10, z: 0 }, d: { x: 13.4, z: 0 } });
    s.ctrl[CPU]!.buttons = Btn.SHIELD; // jockeying last tick
    expect(has(think(s), Btn.SHIELD)).toBe(true);
    s.players[D]!.x = 14; // beyond the keep distance
    expect(has(think(s), Btn.SHIELD)).toBe(false);
  });

  it('jockey is not held when not goal-side, and the stick backs off toward the guard point', () => {
    const s = scene({ c: { x: 10, z: 0 }, d: { x: 9, z: 2.2 } });
    expect(has(think(s), Btn.SHIELD)).toBe(false);
    const s2 = scene({ c: { x: 10, z: 0, vx: 4.5, fx: 1 }, d: { x: 11.2, z: 0 } }); // inside the standoff: back off
    const f = think(s2);
    expect(has(f, Btn.SHIELD)).toBe(true);
    expect(stick(f).x).toBeGreaterThan(0.9);
  });

  it('sprint jockey when the carrier is quick (SHIELD + SPRINT, stick not idle), plain jockey when he walks', () => {
    const fast = scene({ c: { x: 10, z: 0, vx: 5.5, fx: 1 }, d: { x: 11.5, z: 1 } });
    const f = think(fast);
    expect(has(f, Btn.SHIELD) && has(f, Btn.SPRINT)).toBe(true);
    expect(stick(f).m).toBeGreaterThanOrEqual(L.sprintMinStick);
    const slow = scene({ c: { x: 10, z: 0, vx: 1, fx: 1 }, d: { x: 12, z: 0 } });
    const g = think(slow);
    expect(has(g, Btn.SHIELD)).toBe(true);
    expect(has(g, Btn.SPRINT)).toBe(false);
  });

  it('contain (PASS held) when the carrier dribbles at speed and we are goal-side within 8 m', () => {
    const s = scene({ c: { x: 0, z: 0, vx: 7, fx: 1 }, d: { x: 5, z: 1 } });
    const f = think(s);
    expect(has(f, Btn.PASS)).toBe(true);
    expect(has(f, Btn.SHIELD)).toBe(false);
    expect(has(f, Btn.SPRINT)).toBe(false);
    // Hysteresis: keeps containing down to containKeepSpeed.
    s.players[C]!.vx = 5.5;
    expect(has(think(s), Btn.PASS)).toBe(false);
    s.ctrl[CPU]!.buttons = Btn.PASS;
    expect(has(think(s), Btn.PASS)).toBe(true);
    // Too far / from behind: no contain.
    const far = scene({ c: { x: 0, z: 0, vx: 7, fx: 1 }, d: { x: 9, z: 0 } });
    expect(has(think(far), Btn.PASS)).toBe(false);
    const behind = scene({ c: { x: 0, z: 0, vx: 7, fx: 1 }, d: { x: -3, z: 0.5 } });
    expect(has(think(behind), Btn.PASS)).toBe(false);
  });

  it('a stick never left idle with SPRINT (that would mean "press" to SIM-15)', () => {
    for (let k = 0; k < 200; k++) {
      const s = scene({ c: { x: 10, z: (k % 7) - 3, vx: (k % 9) - 2, fx: 1 }, d: { x: 9 + (k % 11) * 0.5, z: (k % 5) - 2 } });
      const f = think(s);
      if (has(f, Btn.SPRINT)) expect(stick(f).m).toBeGreaterThanOrEqual(L.sprintMinStick - 1 / AXIS_SCALE);
      expect(f.mx * f.mx + f.mz * f.mz).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    }
  });
});

describe('TAI-11 second defender and keeper rush', () => {
  it('second defender (MOD_R held) while the carrier is in our final third, with hysteresis', () => {
    const third = PITCH_LENGTH / 3;
    const inside = scene({ c: { x: HALF_LENGTH - third + 2, z: 0 }, d: { x: HALF_LENGTH - third + 8, z: 0 } });
    expect(has(think(inside), Btn.MOD_R)).toBe(true);
    const outside = scene({ c: { x: HALF_LENGTH - third - 2, z: 0 }, d: { x: HALF_LENGTH - third + 4, z: 0 } });
    expect(has(think(outside), Btn.MOD_R)).toBe(false);
    outside.ctrl[CPU]!.buttons = Btn.MOD_R; // already calling: keeps calling a little longer
    expect(has(think(outside), Btn.MOD_R)).toBe(true);
    const half = scene({ c: { x: -5, z: 0 }, d: { x: 2, z: 0 } });
    expect(has(think(half), Btn.MOD_R)).toBe(false);
  });

  it('keeper rush (THROUGH held) on a clear one-on-one close to goal, never with cover or a busy keeper', () => {
    // Our defender beaten (behind the carrier); carrier 12 m out, running at goal.
    const s = scene({ c: { x: 41, z: 2, vx: 6, fx: 1 }, d: { x: 37, z: 3 } });
    expect(throughOnGoal(s, 1, s.players[C]!, L.rushStartDist)).toBe(true);
    expect(has(think(s), Btn.THROUGH)).toBe(true);
    // Too far out to start.
    const far = scene({ c: { x: 30, z: 2, vx: 6, fx: 1 }, d: { x: 26, z: 3 } });
    expect(has(think(far), Btn.THROUGH)).toBe(false);
    // A covering teammate in the channel.
    const cov = scene({ c: { x: 41, z: 2, vx: 6, fx: 1 }, d: { x: 37, z: 3 } });
    cov.players[T]!.x = 46; cov.players[T]!.z = 1;
    expect(has(think(cov), Btn.THROUGH)).toBe(false);
    // Tight angle.
    const wide = scene({ c: { x: 45, z: 13, vx: 6, fx: 1 }, d: { x: 40, z: 14 } });
    expect(has(think(wide), Btn.THROUGH)).toBe(false);
    // The keeper is already coming out on his own (AI come-out): left alone.
    const ai = scene({ c: { x: 41, z: 2, vx: 6, fx: 1 }, d: { x: 37, z: 3 } });
    ai.players[11]!.act = ActionKind.GK_RUSH;
    expect(has(think(ai), Btn.THROUGH)).toBe(false);
    // Already holding: keeps holding while the keeper rushes and the carrier stays close.
    ai.ctrl[CPU]!.buttons = Btn.THROUGH;
    ai.players[C]!.x = 35; // 17.5 m: beyond the start distance, inside the keep distance
    ai.players[D]!.x = 31; // still beaten (behind him)
    expect(has(think(ai), Btn.THROUGH)).toBe(true);
  });
});

describe('TAI-11 tackle timing', () => {
  it('tackle timing improves with level: SHOOT is pressed exactly once the exposure is tackleTimingTicks old', () => {
    const first: number[] = [];
    for (const lv of LEVELS) {
      let at = -1;
      for (let age = 0; age <= 20 && at < 0; age++) {
        const f = think(exposedScene(lv, age));
        if (has(f, Btn.SHOOT)) at = age;
      }
      first.push(at);
      expect(at, `level ${lv}`).toBe(T_LEVEL.tackleTimingTicks[lv]);
    }
    for (let i = 1; i < first.length; i++) expect(first[i]!).toBeLessThanOrEqual(first[i - 1]!);
    expect(first[5]!).toBeLessThan(first[0]!);
  });

  it('a standing tackle press releases MOD_R (R1 + Circle would be a hard tackle) and starts brain.tackleCd', () => {
    const s = scene({
      c: { x: 36, z: 0, vx: 4, fx: 1 }, d: { x: 38.5, z: 0 }, ball: { dx: 1.0, dz: 0, vx: 5 },
    }); // final third: MOD_R would be held
    s.players[C]!.lastTouchTick = s.tick - 20;
    const f = think(s);
    expect(has(f, Btn.SHOOT)).toBe(true);
    expect(has(f, Btn.MOD_R)).toBe(false);
    const cd = s.teams[1]!.cpu.tackleCd;
    expect(cd).toBe(T_TACKLE.standWindup + T_TACKLE.standContactTicks + T_TACKLE.standRecovery + T_LEVEL.reactionTicks[3]!);
    // Cooldown: no new press until it has run out, then again.
    let presses = 0;
    let lastPress = -1;
    for (let i = 0; i < cd + 5; i++) {
      const g = thinkNext(s);
      s.players[C]!.lastTouchTick = s.tick - 20;
      if (has(g, Btn.SHOOT)) { presses++; lastPress = i; }
    }
    expect(presses).toBe(1);
    expect(lastPress).toBe(cd - 1);
  });

  it('skill vulnerable window: the CPU tackles inside the window after its timing delay, not before the window', () => {
    for (const lv of [Difficulty.BEGINNER, Difficulty.LEGEND]) {
      const k = SkillMove.ROULETTE; // long window
      const vs = T_SKILL.vulnStart[k]!, ve = T_SKILL.vulnEnd[k]!;
      let at = -1;
      for (let actT = 0; actT < ve && at < 0; actT++) {
        const s = scene({ level: lv, c: { x: 30, z: 0, vx: 1, fx: 1 }, d: { x: 31.4, z: 0 }, ball: { dx: 0.3, dz: 0, vx: 1 } });
        const q = s.players[C]!;
        q.act = ActionKind.SKILL; q.actSkill = k; q.actT = actT; q.actDur = T_SKILL.duration[k]!;
        q.actX = 1; q.actZ = 0; q.actDirX = 1; q.actDirZ = 0; q.actA = 1; q.actB = 1;
        if (has(think(s), Btn.SHOOT)) at = actT;
      }
      const want = vs + T_LEVEL.tackleTimingTicks[lv]!;
      if (want + T_TACKLE.standWindup + (T_TACKLE.standContactTicks >> 1) < ve || lv === Difficulty.BEGINNER) {
        // Careful levels only lunge when the window is still open at contact; noisy draws may lunge anyway.
        expect(at === -1 || at >= want, `level ${lv} at ${at}`).toBe(true);
      }
      if (lv === Difficulty.LEGEND) expect(at).toBe(want);
    }
  });

  it('first-touch window: a receiver still controlling the ball is tackled while the window lasts', () => {
    const s = scene({ level: Difficulty.LEGEND, c: { x: 30, z: 0, vx: 1, fx: 1 }, d: { x: 31.6, z: 0 }, ball: { dx: 0.8, dz: 0, vx: 1.5 } });
    const q = s.players[C]!;
    q.act = ActionKind.FIRST_TOUCH; q.actT = T_LEVEL.tackleTimingTicks[5]!; q.actDur = 30;
    expect(has(think(s), Btn.SHOOT)).toBe(true);
    const late = scene({ level: Difficulty.LEGEND, c: { x: 30, z: 0, vx: 1, fx: 1 }, d: { x: 31.6, z: 0 }, ball: { dx: 0.3, dz: 0, vx: 1 } });
    const r = late.players[C]!;
    r.act = ActionKind.FIRST_TOUCH; r.actT = 25; r.actDur = 30; // the window closes before the contact
    late.ball.lastTouchTick = late.tick - 25; r.lastTouchTick = late.tick - 25;
    const rash = noise01(late.config.seed, 64 + C, (late.tick - 25) * 4 + 1) < T_LEVEL.decisionNoise[5]!;
    expect(has(think(late), Btn.SHOOT)).toBe(rash);
  });

  it('a careful CPU waits when the ball will be back at the carrier\'s feet by contact; a noisy draw lunges anyway', () => {
    // Ball exposed now but coming back to the carrier quickly (it rolls toward him).
    let careful = 0, lunged = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = scene({
        level: Difficulty.BEGINNER, seed, c: { x: 30, z: 0, vx: 4, fx: 1 }, d: { x: 32.6, z: 0 }, ball: { dx: 0.9, dz: 0, vx: 0 },
      });
      s.players[C]!.lastTouchTick = s.tick - 30;
      const rash = noise01(seed, 64 + C, (s.tick - 30) * 4 + 1) < T_LEVEL.decisionNoise[0]!;
      const f = think(s);
      if (rash) { expect(has(f, Btn.SHOOT)).toBe(true); lunged++; } else { expect(has(f, Btn.SHOOT)).toBe(false); careful++; }
    }
    // Noise draws: roughly decisionNoise of the windows are rash.
    expect(lunged / 400).toBeGreaterThan(T_LEVEL.decisionNoise[0]! - 0.08);
    expect(lunged / 400).toBeLessThan(T_LEVEL.decisionNoise[0]! + 0.08);
    expect(careful).toBeGreaterThan(0);
  });

  it('occasional fouls: rash lunges at a carrier with the ball at his feet scale with decision noise', () => {
    const rate: number[] = [];
    for (const lv of [Difficulty.BEGINNER, Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
      let n = 0;
      const N = 3000;
      for (let k = 0; k < N; k++) {
        const s = scene({ level: lv, c: { x: 30, z: 0 }, d: { x: 31.3, z: 0 }, tick: 1000 + k * L.rashBucketTicks });
        if (has(think(s), Btn.SHOOT)) n++;
      }
      rate.push(n / N);
      const want = T_LEVEL.decisionNoise[lv]! * L.rashLungeChance;
      expect(Math.abs(n / N - want), `level ${lv}: ${n / N} vs ${want}`).toBeLessThan(0.025);
    }
    expect(rate[0]!).toBeGreaterThan(rate[1]!);
    expect(rate[1]!).toBeGreaterThan(rate[2]!);
  });

  it('never tackles from behind, when out of reach, while busy, or before the reaction delay is over', () => {
    const behind = exposedScene(Difficulty.LEGEND, 20);
    behind.players[D]!.x = 28.5; // behind the carrier
    expect(has(think(behind), Btn.SHOOT)).toBe(false);
    const far = exposedScene(Difficulty.LEGEND, 20);
    far.players[D]!.x = 34.5;
    expect(has(think(far), Btn.SHOOT)).toBe(false);
    const busy = exposedScene(Difficulty.LEGEND, 20);
    busy.players[D]!.act = ActionKind.STUMBLE;
    expect(has(think(busy), Btn.SHOOT)).toBe(false);
    const stunned = exposedScene(Difficulty.LEGEND, 20);
    stunned.players[D]!.stunT = 5;
    expect(has(think(stunned), Btn.SHOOT)).toBe(false);
    const react = exposedScene(Difficulty.LEGEND, 20);
    react.teams[1]!.cpu.seenOwner = -1; // situation just changed
    expect(think(react).buttons).toBe(0);
  });
});

describe('TAI-11 slides', () => {
  /** Carrier through on goal at speed with the ball pushed ahead; the defender `rel` relative to the carrier. */
  function slideScene(lv: Difficulty, seed: number, k: number, behind: boolean): SimState {
    const cx = 32 + (k % 7), cz = ((k * 7) % 9) - 4;
    // Ball 1 m ahead of the carrier; the defender 2.0 .. 2.8 m from it (beyond standing reach, inside slide reach).
    const d = behind ? { x: cx - 1.0 - (k % 5) * 0.2, z: cz + ((k % 3) - 1) * 0.3 } : { x: cx + 3.2 + (k % 4) * 0.15, z: cz + ((k % 3) - 1) * 0.4 };
    const s = scene({ level: lv, seed, c: { x: cx, z: cz, vx: 7, fx: 1 }, d, ball: { dx: 1.0, dz: 0, vx: 8 } });
    s.players[C]!.lastTouchTick = s.tick - 25 - (k % 50);
    return s;
  }

  it('rare slides from behind (only for a carrier through on goal; chance x decision noise); goal-side slides are commoner', () => {
    const N = 2000;
    const rates: Record<string, number> = {};
    for (const lv of [Difficulty.BEGINNER, Difficulty.LEGEND]) {
      for (const behind of [true, false]) {
        let n = 0, shoot = 0;
        for (let k = 0; k < N; k++) {
          const f = think(slideScene(lv, 1 + (k % 13), k, behind));
          if (has(f, Btn.LOB)) n++;
          if (has(f, Btn.SHOOT)) shoot++;
        }
        rates[`${lv}-${behind}`] = n / N;
        if (behind) expect(shoot).toBe(0);
      }
    }
    expect(rates[`${Difficulty.BEGINNER}-true`]!).toBeLessThan(L.slideBehindChance * T_LEVEL.decisionNoise[0]! + 0.03);
    expect(rates[`${Difficulty.LEGEND}-true`]!).toBeLessThan(0.02);
    expect(rates[`${Difficulty.BEGINNER}-true`]!).toBeGreaterThan(rates[`${Difficulty.LEGEND}-true`]!);
    expect(rates[`${Difficulty.LEGEND}-false`]!).toBeGreaterThan(rates[`${Difficulty.LEGEND}-true`]! * 3);
    expect(rates[`${Difficulty.LEGEND}-false`]!).toBeGreaterThan(L.slideChance - 0.04);
    expect(rates[`${Difficulty.LEGEND}-false`]!).toBeLessThan(L.slideChance + 0.04);
  });

  it('no slide from behind when a teammate covers, when the carrier is not through, or in the opponent half', () => {
    let n = 0;
    for (let k = 0; k < 500; k++) {
      const a = slideScene(Difficulty.BEGINNER, 1 + (k % 13), k, true);
      a.players[T]!.x = a.players[C]!.x + 6; a.players[T]!.z = a.players[C]!.z; // cover in the channel
      if (has(think(a), Btn.LOB)) n++;
      const b = scene({ level: Difficulty.BEGINNER, c: { x: -10, z: 0, vx: 7, fx: 1 }, d: { x: -11.2, z: 0 }, ball: { dx: 1.0, dz: 0, vx: 8 } });
      b.players[C]!.lastTouchTick = b.tick - 25 - k;
      if (has(think(b), Btn.LOB)) n++;
    }
    expect(n).toBe(0);
  });

  it('never slides through the carrier: no goal-side slide when the ball is on his far side', () => {
    let n = 0;
    for (let k = 0; k < 500; k++) {
      // Carrier in our final third at speed, the ball dragged back behind him (away from the defender).
      const s = scene({ c: { x: 38, z: 0, vx: 6, fx: 1 }, d: { x: 40, z: 0.3 }, ball: { dx: -0.9, dz: 0, vx: 4 } });
      s.players[C]!.lastTouchTick = s.tick - 20 - k;
      if (has(think(s), Btn.LOB)) n++;
    }
    expect(n).toBe(0);
  });

  it('no goal-side slide for a slow carrier outside our final third, nor within standing reach', () => {
    let n = 0;
    for (let k = 0; k < 500; k++) {
      const s = scene({ c: { x: 5, z: 0, vx: 3, fx: 1 }, d: { x: 8.2, z: 0 }, ball: { dx: 1.2, dz: 0, vx: 3.5 } });
      s.players[C]!.lastTouchTick = s.tick - 20 - k;
      if (has(think(s), Btn.LOB)) n++;
    }
    expect(n).toBe(0);
  });
});

describe('TAI-11 player choice', () => {
  /** Current defender beaten (behind the carrier); teammate T well placed goal-side. Tick on the evaluation phase. */
  function switchScene(): SimState {
    const s = scene({ c: { x: 10, z: 0, vx: 4, fx: 1 }, d: { x: 2, z: 6 }, tick: 1005 });
    s.players[T]!.x = 18; s.players[T]!.z = 1; s.players[T]!.fx = -1;
    return s;
  }

  it('gesture TAP on the best-placed goal-side defender (gSlot) when SIM-16 would pick someone else', () => {
    const s = switchScene();
    const f = think(s);
    expect(f.gesture).toBe(GestureKind.TAP);
    expect(f.gSlot).toBe(T);
    expect(f.gx).toBe(180);
    expect(f.gz).toBe(10);
    expect(has(f, Btn.MOD_L)).toBe(false);
    expect(has(f, Btn.SHOOT) || has(f, Btn.LOB)).toBe(false);
  });

  it('MOD_L press when SIM-16\'s next-switch marker is the same (or as good)', () => {
    const s = switchScene();
    s.ctrl[CPU]!.nextSwitch = T;
    const f = think(s);
    expect(has(f, Btn.MOD_L)).toBe(true);
    expect(f.gesture).toBe(GestureKind.NONE);
    // The stick is already the new defender's: from T toward the guard point (back toward the carrier, -x).
    expect(stick(f).x).toBeLessThan(0);
  });

  it('no switch during SIM-16\'s lock-out, off the evaluation tick, or away from an engaged defender', () => {
    const lock = switchScene();
    lock.ctrl[CPU]!.switchLockT = 5;
    let f = think(lock);
    expect(f.gesture === GestureKind.NONE && !has(f, Btn.MOD_L)).toBe(true);
    const off = switchScene();
    off.tick = 1006;
    f = think(off);
    expect(f.gesture === GestureKind.NONE && !has(f, Btn.MOD_L)).toBe(true);
    const engaged = switchScene();
    engaged.players[D]!.x = 13; engaged.players[D]!.z = 0.5; // goal-side, 3 m away
    engaged.players[T]!.x = 12.2; engaged.players[T]!.z = 0.2;
    f = think(engaged);
    expect(f.gesture === GestureKind.NONE && !has(f, Btn.MOD_L)).toBe(true);
  });

  it('never picks the keeper, a busy player, or a teammate only marginally better', () => {
    const s = switchScene();
    s.players[T]!.x = -45; // T parked away
    s.players[11]!.x = 13; s.players[11]!.z = 0; // keeper right in front of the carrier
    let f = think(s);
    expect(f.gSlot === 11 || f.gesture !== GestureKind.NONE && f.gSlot === 11).toBe(false);
    const busy = switchScene();
    busy.players[T]!.act = ActionKind.FALLEN; busy.players[T]!.moveMode = MoveMode.LOCKED;
    busy.players[T]!.actT = 0; busy.players[T]!.actDur = 200;
    f = think(busy);
    expect(f.gSlot).not.toBe(T);
    const marginal = scene({ c: { x: 10, z: 0, vx: 0, fx: 1 }, d: { x: 16, z: 4 }, tick: 1005 });
    marginal.players[T]!.x = 15.5; marginal.players[T]!.z = 3.5;
    f = think(marginal);
    expect(f.gesture).toBe(GestureKind.NONE);
  });
});

describe('TAI-11 reaction delay', () => {
  it('after a change of situation the CPU keeps its run for reactionTicks, then defends (shorter at better levels)', () => {
    const waited: number[] = [];
    for (const lv of LEVELS) {
      const s = scene({ level: lv, c: { x: 10, z: 0 }, d: { x: 12.5, z: 0, vx: 0, vz: 4 } });
      s.teams[1]!.cpu.seenOwner = 20; // the ball was someone else's: new carrier
      s.players[D]!.vz = 4;
      let n = 0;
      for (; n < 60; n++) {
        const f = n === 0 ? think(s) : thinkNext(s);
        if (has(f, Btn.SHIELD)) break;
        // Momentum: stick along his run (+z), no buttons.
        expect(f.buttons & ~Btn.SPRINT).toBe(0);
        expect(stick(f).z).toBeGreaterThan(0.99);
      }
      waited.push(n);
      expect(n).toBe(T_LEVEL.reactionTicks[lv]);
    }
    expect(waited[5]!).toBeLessThan(waited[0]!);
  });
});

describe('TAI-11 loose balls', () => {
  function looseScene(): SimState {
    const s = scene({ c: { x: 20, z: -10 }, d: { x: 24, z: 3 } });
    const b = s.ball;
    b.owner = -1; b.x = 20; b.z = -6; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 14; b.y = 0.11; b.grounded = 1;
    b.lastTouch = C; b.lastTouchTeam = 0; b.lastKickBy = C; b.lastKickTeam = 0; b.passTarget = 8; b.passX = 20; b.passZ = 16;
    s.players[8]!.x = 20; s.players[8]!.z = 16;
    s.teams[1]!.cpu.seenOwner = -1;
    return s;
  }

  it('intercepts an opponent pass in its lane when he gets there first (sprinting toward the ball path)', () => {
    const s = looseScene();
    s.players[D]!.x = 21.2; s.players[D]!.z = 2;
    const f = think(s);
    const st = stick(f);
    expect(st.x).toBeLessThan(-0.3); // toward the lane at x = 20
    expect(has(f, Btn.SPRINT)).toBe(true);
    expect(has(f, Btn.SHOOT) || has(f, Btn.LOB)).toBe(false);
  });

  it('contests the receiver goal-side of the reception point when he cannot get to the lane first', () => {
    const s = looseScene();
    s.players[D]!.x = 45; s.players[D]!.z = 30;
    const f = think(s);
    const st = stick(f);
    const tx = 20 + 2.4, tz = 16; // roughly goal-side (+x) of the reception point
    const gx = tx - 45, gz = tz - 30, gl = Math.hypot(gx, gz);
    expect(st.x * (gx / gl) + st.z * (gz / gl)).toBeGreaterThan(0.95);
  });

  it('our own pass in flight: neutral stick so the receiver meets the ball; SPRINT only when contested', () => {
    const s = looseScene();
    const b = s.ball;
    b.lastTouchTeam = 1; b.lastKickTeam = 1; b.lastTouch = D; b.passTarget = T; b.passX = 30; b.passZ = 0;
    s.players[T]!.x = 30; s.players[T]!.z = 0;
    let f = think(s);
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(0);
    expect(f.buttons).toBe(0);
    s.players[C]!.x = 33; s.players[C]!.z = 2; // an opponent near the reception point
    f = think(s);
    expect(f.mx === 0 && f.mz === 0 && f.buttons === Btn.SPRINT).toBe(true);
  });

  it('clears (SHOOT) a ball about to reach him in our own third under pressure, not without pressure or upfield', () => {
    const mk = (dx: number, oppNear: boolean): SimState => {
      const s = scene({ c: oppNear ? { x: 40 + dx, z: 3 } : { x: -20, z: 20 }, d: { x: 44 + dx, z: 0 } });
      const b = s.ball;
      b.owner = -1; b.x = 41.5 + dx; b.z = 0; b.px = b.x; b.pz = b.z; b.vx = 12; b.vz = 0; b.y = 0.11; b.grounded = 1;
      b.lastTouchTeam = 0; b.passTarget = -1;
      s.teams[1]!.cpu.seenOwner = -1;
      return s;
    };
    expect(has(think(mk(0, true)), Btn.SHOOT)).toBe(true);
    expect(has(think(mk(0, false)), Btn.SHOOT)).toBe(false);
    expect(has(think(mk(-30, true)), Btn.SHOOT)).toBe(false); // middle third: SHOOT would be a shot
  });

  it('a pass to a receiver who is no longer active is treated as a loose ball (chased), not as our pass', () => {
    const s = scene({ c: { x: -20, z: 20 }, d: { x: 10, z: 0 } });
    const b = s.ball;
    b.owner = -1; b.x = 14; b.z = 6; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0; b.lastTouchTeam = 1; b.passTarget = T;
    s.players[T]!.active = 0;
    s.teams[1]!.cpu.seenOwner = -1;
    const f = think(s);
    expect(f.mx !== 0 || f.mz !== 0).toBe(true);
  });

  it('chases another loose ball to its interception point', () => {
    const s = scene({ c: { x: -20, z: 20 }, d: { x: 10, z: 0 } });
    const b = s.ball;
    b.owner = -1; b.x = 14; b.z = 6; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0; b.lastTouchTeam = 0; b.passTarget = -1;
    s.teams[1]!.cpu.seenOwner = -1;
    const f = think(s);
    const st = stick(f);
    const gl = Math.hypot(4, 6);
    expect(st.x * (4 / gl) + st.z * (6 / gl)).toBeGreaterThan(0.95);
    expect(has(f, Btn.SPRINT)).toBe(true);
  });

  it('ball in the opponent keeper\'s hands: drifts back toward his home position, no buttons', () => {
    const s = scene({ c: { x: -20, z: 0 }, d: { x: -30, z: 4 } });
    s.players[D]!.homeX = -5; s.players[D]!.homeZ = 4;
    const b = s.ball;
    b.owner = 0; b.heldBy = 0; b.x = s.players[0]!.x; b.z = 0;
    s.teams[1]!.cpu.seenOwner = 0;
    const f = think(s);
    expect(stick(f).x).toBeGreaterThan(0.99);
    expect(f.buttons & ~Btn.SPRINT).toBe(0);
  });
});

describe('TAI-11 frame-only writes and determinism', () => {
  const snapshot = (s: SimState): string => JSON.stringify({ ...s, config: null, squads: null });

  it('writes only the CPU frame (and the brain fields tackleCd / reactT / seenOwner)', () => {
    const cases = [
      exposedScene(Difficulty.BEGINNER, 20),
      scene({ c: { x: 41, z: 2, vx: 6, fx: 1 }, d: { x: 37, z: 3 } }),
      scene({ c: { x: 10, z: 0, vx: 4, fx: 1 }, d: { x: 2, z: 6 }, tick: 1005 }),
    ];
    for (const s of cases) {
      s.teams[1]!.cpu.seenOwner = -1;
      for (let i = 0; i < 40; i++) {
        s.tick++;
        const brain = s.teams[1]!.cpu;
        clearInputFrame(brain.out);
        const before = snapshot(s);
        const keep = { tackleCd: brain.tackleCd, reactT: brain.reactT, seenOwner: brain.seenOwner };
        clearInputFrame(brain.out);
        cpuDefend(s, 1, brain.out, NULL_SINK);
        const outCopy = { ...brain.out };
        clearInputFrame(brain.out);
        const after = { tackleCd: brain.tackleCd, reactT: brain.reactT, seenOwner: brain.seenOwner };
        Object.assign(brain, keep);
        expect(snapshot(s)).toBe(before);
        Object.assign(brain, after);
        Object.assign(brain.out, outCopy);
      }
    }
  });

  it('deterministic: identical inputs give identical frames (and no hidden module state leaks between states)', () => {
    const run = (): number[] => {
      const out: number[] = [];
      const a = exposedScene(Difficulty.SEMI_PRO, 0, 5);
      const b = scene({ c: { x: 10, z: 0, vx: 4, fx: 1 }, d: { x: 2, z: 6 }, tick: 1005 });
      for (let i = 0; i < 120; i++) {
        for (const s of [a, b]) {
          const f = thinkNext(s);
          s.players[C]!.x += 0.05; s.ball.x += 0.06;
          out.push(f.mx, f.mz, f.buttons, f.gesture, f.gSlot, f.gx, f.gz);
        }
      }
      return out;
    };
    expect(run()).toEqual(run());
  });

  it('does nothing outside IN_PLAY or for a team without an active CPU controller', () => {
    const s = exposedScene(Difficulty.LEGEND, 20);
    s.match.phase = MatchPhase.THROW_IN;
    let f = think(s);
    expect(f.buttons | f.mx | f.mz).toBe(0);
    const h = exposedScene(Difficulty.LEGEND, 20);
    h.ctrl[CPU]!.kind = 1; // HUMAN
    f = think(h);
    expect(f.buttons | f.mx | f.mz).toBe(0);
    const k = exposedScene(Difficulty.LEGEND, 20);
    k.ctrl[CPU]!.slot = -1;
    f = think(k);
    expect(f.buttons | f.mx | f.mz).toBe(0);
  });
});
