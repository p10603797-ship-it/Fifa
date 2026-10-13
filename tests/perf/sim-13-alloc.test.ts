/**
 * SIM-13 — skill handlers allocate nothing per tick and stay cheap.
 *  1. The per-tick path of every move (scripted ball and body, window scan with an opponent near, the knock-on's
 *     burst) is driven through the actions stage on its own, looping each move over its event-free ticks (between
 *     its start and its exit touch / after the knock-on's touch): no allocation at all.
 *  2. The full cycle (every move and the fake: starts, exit touches, the knock-on's solver + applyKick) for the
 *     average: event emits with double arguments and the solver's RNG / log calls may box a few numbers per move
 *     (V8 boxes doubles passed to calls it does not inline), never per tick.
 * Heap growth is the minimum over several windows after a long warm-up (a window can hold an optimizing compile,
 * ~1-2 MB of code objects: JIT noise, not per-tick allocation).
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DT } from '../../src/contracts/constants';
import { ActionKind, KickKind, SkillMove } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_SKILL } from '../../src/contracts/tuning';
import { actionsTick, clearAction } from '../../src/sim/actions/dispatch';
import { NULL_SINK } from '../../src/sim/core/events';
import { LOCAL_TUNING, startFake, startSkill } from '../../src/sim/kicks/skills';
import { OPP, SKILLER, skillScene } from '../scenario/sim-13-helpers';

const MOVES = [
  SkillMove.BALL_ROLL, SkillMove.STEP_OVER, SkillMove.BODY_FEINT, SkillMove.DRAG_BACK, SkillMove.FAKE_SHOT,
  SkillMove.ROULETTE, SkillMove.HEEL_FLICK, SkillMove.KNOCK_ON, SkillMove.STOP_BALL, SkillMove.STOP_FACE_GOAL,
  SkillMove.HARD_STOP,
];

function place(s: SimState): void {
  const p = s.players[SKILLER]!, b = s.ball, q = s.players[OPP]!;
  p.x = 0; p.z = 0; p.vx = 3; p.vz = 0; p.fx = 1; p.fz = 0; p.noTouchT = 0; p.stunT = 0;
  q.x = 2.5; q.z = 2.5; q.vx = 0; q.vz = 0; q.noTouchT = 0; q.act = ActionKind.NONE; // near, never in reach
  b.x = 0.4; b.z = 0; b.y = 0.11; b.vx = 3; b.vy = 0; b.vz = 0; b.owner = SKILLER; b.heldBy = -1;
}

/** Event-free tick range [lo, hi] of move k (actT values after the dispatcher's increment). */
function quietRange(k: SkillMove): [number, number] {
  const d = T_SKILL.duration[k]!;
  if (k === SkillMove.KNOCK_ON) return [LOCAL_TUNING.knockTouchTick + 1, d - 1];
  const f = LOCAL_TUNING.releaseFrac[k]!;
  return [2, f < 1 ? Math.round(f * d) - 1 : d - 1];
}

/** Loop move k over its quiet ticks n times through the actions stage (positions re-placed each loop). */
function driveQuiet(s: SimState, k: SkillMove, n: number): void {
  const p = s.players[SKILLER]!, b = s.ball;
  const [lo, hi] = quietRange(k);
  for (let i = 0; i < n; i++) {
    s.tick++;
    if (p.act !== ActionKind.SKILL || p.actT >= hi) {
      if (p.act !== ActionKind.SKILL) { place(s); startSkill(s, SKILLER, k, 0, 1, NULL_SINK); }
      // Rewind into the quiet stretch (a knock-on: after its touch, ball loose).
      p.actT = lo - 1;
      p.actDone = k === SkillMove.KNOCK_ON ? 1 : 0;
      if (k === SkillMove.KNOCK_ON) b.owner = -1;
      p.x = 0; p.z = 0; b.x = 0.4; b.z = 0; b.y = 0.11; b.vy = 0;
    }
    actionsTick(s, NULL_SINK);
    p.x += p.vx * DT; p.z += p.vz * DT;
    b.x += b.vx * DT; b.z += b.vz * DT;
  }
}

let next = 0;

/** The full cycle: every move and the fake from their starts, with the ball integrated by Euler steps. */
function driveCycle(s: SimState, n: number): void {
  const p = s.players[SKILLER]!, b = s.ball;
  for (let i = 0; i < n; i++) {
    s.tick++;
    if (p.act === ActionKind.NONE) {
      place(s);
      const j = next++ % (MOVES.length + 1);
      if (j === MOVES.length) {
        // A shot wind-up converted into a fake.
        p.act = ActionKind.SHOT; p.actKick = KickKind.SHOT_NORMAL; p.actT = 3; p.actDur = 25; p.actContact = 10; p.actDone = 0;
        if (startFake(s, SKILLER, NULL_SINK) !== 1) clearAction(p);
      } else {
        startSkill(s, SKILLER, MOVES[j]!, 0, (next & 1) === 0 ? 1 : -1, NULL_SINK);
      }
    }
    actionsTick(s, NULL_SINK);
    p.x += p.vx * DT; p.z += p.vz * DT;
    b.x += b.vx * DT; b.z += b.vz * DT; b.y += b.vy * DT;
    if (b.y < 0.11) { b.y = 0.11; b.vy = 0; } else b.vy -= 9.81 * DT;
    if (b.owner !== SKILLER && p.act === ActionKind.NONE) b.owner = SKILLER;
  }
}

function bytesPerTick(drive: (n: number) => void, n: number): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  drive(n);
  let bytes = 1e9;
  for (let w = 0; w < 4; w++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    drive(n);
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < bytes) bytes = b;
  }
  return bytes;
}

describe('SIM-13 per-tick cost', () => {
  it('every move\'s per-tick path allocates nothing', () => {
    const s = skillScene();
    // Warm every move first so a later move does not deoptimise the shared code inside a measured window.
    for (const k of MOVES) driveQuiet(s, k, 5000);
    for (const k of MOVES) {
      const bytes = bytesPerTick((n) => driveQuiet(s, k, n), 20000);
      console.log(`SIM-13 ${SkillMove[k]} per-tick path: ${bytes.toFixed(2)} bytes per tick (best window)`);
      // A real per-tick allocation is >= 16 bytes per tick; allow GC/JIT noise below that.
      expect(bytes, `${SkillMove[k]}: ${bytes.toFixed(1)} bytes/tick`).toBeLessThan(4);
    }
  }, 120_000);

  it('the full cycle (starts, exit touches, knock-on solver) stays within a few bytes per tick on average', () => {
    const s = skillScene();
    const bytes = bytesPerTick((n) => driveCycle(s, n), 30000);
    console.log(`SIM-13 full skill cycle: ${bytes.toFixed(2)} bytes per tick (best window)`);
    expect(bytes, `${bytes.toFixed(1)} bytes/tick`).toBeLessThan(16);
  }, 120_000);

  it('a skiller costs a few microseconds per tick at most (whole actions stage, best window)', () => {
    const s = skillScene();
    driveCycle(s, 20000);
    let best = 1e9;
    for (let w = 0; w < 5; w++) {
      const t0 = performance.now();
      driveCycle(s, 20000);
      const us = ((performance.now() - t0) / 20000) * 1000;
      if (us < best) best = us;
    }
    console.log(`SIM-13 actions stage with a skiller: ${best.toFixed(3)} us per tick (best window)`);
    expect(best).toBeLessThan(20);
  }, 120_000);
});
