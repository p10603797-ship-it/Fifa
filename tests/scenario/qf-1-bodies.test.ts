/**
 * [QF-1] QA-10 player overlap and goal-frame penetration, and SIM-04/05 movement glitches, through the movement
 * stages of the real pipeline (actions -> SIM-04 locomotion -> SIM-05 bodies) with intents re-asserted every tick.
 */
// Load the action registry before any handler module (sim/actions import cycle).
import '../../src/sim/actions/dispatch';
import { describe, expect, it } from 'vitest';
import { BOARD_X, GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, POST_RADIUS } from '../../src/contracts/constants';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_DRIBBLE, T_PLAYER } from '../../src/contracts/tuning';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { bodyContactTick } from '../../src/sim/players/bodies';
import { accelFor, locomotionTick, topSpeedFor } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

const EV = createEventBuffer();

function world(seed = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed });
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = -45 + i * 4; p.z = -32; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
    p.moveMode = MoveMode.STOP; p.lookAt = 0; p.act = ActionKind.NONE; p.stunT = 0; p.active = 1; p.wantSprint = 0;
  }
  s.ball.x = 0; s.ball.z = 30; s.ball.vx = 0; s.ball.vz = 0; s.ball.owner = -1; s.ball.heldBy = -1;
  s.match.restart.taker = -1;
  return s;
}

function move(s: SimState): void {
  s.tick++;
  EV.begin(s.tick);
  actionsTick(s, EV);
  locomotionTick(s, EV);
  bodyContactTick(s, EV);
}

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

describe('QF-1 SIM-04/05 two players wanting the same spot', { timeout: 600_000 }, () => {
  it('glitch orbit — two players sent head-on to the same spot press together and stop circling (40 attribute sets)', () => {
    const rnd = lcg(31);
    for (let n = 0; n < 40; n++) {
      const s = world(1 + n);
      const A = 5, B = 16;
      for (const k of [A, B]) {
        const a = s.attrs[k]!;
        a.acceleration = 1 + rnd() * 98; a.sprintSpeed = 1 + rnd() * 98; a.agility = 1 + rnd() * 98;
        a.strength = 1 + rnd() * 98; a.height = 165 + rnd() * 35;
        a.topSpeed = topSpeedFor(a); a.accel = accelFor(a);
      }
      const off = (rnd() - 0.5) * 0.02; // exactly head-on, or a hair off the axis
      const sp = 3 + rnd() * 5;
      const pa = s.players[A]!, pb = s.players[B]!;
      pa.x = -4; pa.z = off; pb.x = 4; pb.z = -off;
      let sweep = 0;
      let prevAng = 0;
      for (let t = 0; t < 360; t++) {
        for (const k of [A, B]) { const p = s.players[k]!; p.moveMode = MoveMode.ARRIVE; p.tgtX = 0; p.tgtZ = 0; p.tgtSpeed = sp; }
        move(s);
        const ang = Math.atan2(pb.z - pa.z, pb.x - pa.x);
        if (t >= 120) {
          let d = ang - prevAng;
          if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
          sweep += Math.abs(d);
        }
        prevAng = ang;
      }
      // After the first 2 s the pair's axis barely turns (an orbit sweeps whole radians), both are slow and both
      // are within reach of the spot (a ball there can be played).
      expect(sweep, `case ${n}`).toBeLessThan(0.35);
      expect(Math.hypot(pa.vx, pa.vz), `case ${n}`).toBeLessThan(0.3);
      expect(Math.hypot(pb.vx, pb.vz), `case ${n}`).toBeLessThan(0.3);
      expect(Math.hypot(pa.x, pa.z), `case ${n}`).toBeLessThan(T_DRIBBLE.controlRadius);
      expect(Math.hypot(pb.x, pb.z), `case ${n}`).toBeLessThan(T_DRIBBLE.controlRadius);
    }
  });
});

// ---------------------------------------------------------------- QA-10 goal frame and net

const GL = HALF_LENGTH;
const GB = HALF_LENGTH + GOAL_DEPTH;
const SIDE = GOAL_HALF_WIDTH + POST_RADIUS;

/** Penetration (m) of a body centre into goal `end`'s frame + net box: > 0 = inside it. Keepers may stand on the line. */
function goalPenetration(x: number, z: number, keeper: boolean): number {
  let worst = -1;
  for (const end of [-1, 1]) {
    const u = end * x;
    const front = keeper ? GL : GL - T_PLAYER.bodyRadius;
    const pen = Math.min(u - front, GB + T_PLAYER.bodyRadius - u, SIDE + T_PLAYER.bodyRadius - Math.abs(z));
    if (pen > worst) worst = pen;
  }
  return worst;
}

describe('QF-1 QA-10 players never walk through the goal frame or net', { timeout: 600_000 }, () => {
  it('glitch players walk through the goal frame or net — runs at targets inside the goal from every side, both ends, keeper or not', () => {
    let runs = 0;
    for (const end of [-1, 1]) {
      for (const keeper of [false, true]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * 2 * Math.PI;
          const s = world(3 + k);
          const slot = keeper ? (end === 1 ? 11 : 0) : 7;
          const p = s.players[slot]!;
          // Start 6 m from the goal centre on a ring (outside the frame), aim at a point inside the net.
          p.x = end * (GL + 1) + 6 * Math.cos(a); p.z = 6 * Math.sin(a);
          if (goalPenetration(p.x, p.z, keeper) > -0.5) { p.x = end * (GL - 6); }
          if (Math.abs(p.x) > BOARD_X - 1) p.x = Math.sign(p.x) * (BOARD_X - 1);
          const tx = end * (GL + 1), tz = (k % 3 - 1) * 1.5;
          let worst = -1;
          for (let t = 0; t < 240; t++) {
            if (t < 120) { p.moveMode = MoveMode.ARRIVE; p.tgtX = tx; p.tgtZ = tz; p.tgtSpeed = 9; }
            else { p.moveMode = MoveMode.DIRECT; p.ix = Math.sign(tx - p.x) || end; p.iz = Math.sign(tz - p.z) * 0.5; p.wantSprint = 1; }
            move(s);
            worst = Math.max(worst, goalPenetration(p.x, p.z, keeper));
          }
          runs++;
          expect(worst, `end ${end} keeper ${keeper} k ${k}`).toBeLessThanOrEqual(1e-6);
        }
      }
    }
    expect(runs).toBe(64);
  });

  it('glitch players walk through the goal frame or net — a defender shoved by a sprinting opponent is not pushed into the net', () => {
    for (const end of [-1, 1]) {
      for (const z of [-3, 0, 2.5, 4.2]) {
        const s = world(9);
        const def = s.players[3]!, att = s.players[18]!;
        def.x = end * (GL - 0.6); def.z = z;
        att.x = end * (GL - 3); att.z = z + 0.1;
        s.attrs[18]!.strength = 99; s.attrs[3]!.strength = 1;
        let worst = -1;
        for (let t = 0; t < 180; t++) {
          att.moveMode = MoveMode.DIRECT; att.ix = end; att.iz = 0; att.wantSprint = 1;
          def.moveMode = MoveMode.STOP;
          move(s);
          worst = Math.max(worst, goalPenetration(def.x, def.z, false), goalPenetration(att.x, att.z, false));
        }
        expect(worst, `end ${end} z ${z}`).toBeLessThanOrEqual(1e-6);
      }
    }
  });

  it('glitch players walk through the goal frame or net — nobody is ever inside a goal frame in real matches (3 bot matches)', () => {
    for (const seed of [21, 22, 23]) {
      const config = soakConfig(seed, 77, { halfMinutes: 2 });
      let worst = -1;
      let who = '';
      runMatch({
        config, checker: 'core', fastCutscenes: true,
        onTick: (s) => {
          for (let i = 0; i < NUM_SLOTS; i++) {
            const p = s.players[i]!;
            if (p.active !== 1) continue;
            const pen = goalPenetration(p.x, p.z, p.isKeeper === 1);
            if (pen > worst) { worst = pen; who = `t=${s.tick} slot ${i} phase ${s.match.phase} (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`; }
          }
        },
      });
      expect(worst, who).toBeLessThanOrEqual(1e-6);
    }
  });
});
