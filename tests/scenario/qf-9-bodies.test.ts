/**
 * [QF-9] SIM-05 body contact: a pusher gives way behind a body moving across his push (the "body lock" of a runner and
 * a man running alongside him the same way, QF-2 CR qf-2-cr-body-lock), without breaking the existing slide-arounds.
 * Movement stages only (actions, SIM-04 locomotion, SIM-05 bodies) with intents rewritten every tick.
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { bodyContactTick } from '../../src/sim/players/bodies';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';

function world(seed = 1): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed });
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = -45 + i * 4; p.z = -32; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
    p.moveMode = MoveMode.STOP; p.lookAt = 0; p.act = ActionKind.NONE; p.stunT = 0; p.active = 1; p.wantSprint = 0;
    s.attrs[i]!.height = 182.5; s.attrs[i]!.strength = 50;
  }
  s.ball.x = 0; s.ball.z = 30; s.ball.vx = 0; s.ball.vz = 0; s.ball.owner = -1; s.ball.heldBy = -1;
  s.match.restart.taker = -1;
  return s;
}

const EV = createEventBuffer();

interface Driver { slot: number; set: (s: SimState) => void }

/** Run n movement ticks with the drivers' intents; returns reversal counts (|v| > 1 both ticks, v . v' < 0) and the
 * longest streak the pair (a, b) spends within 0.85 m. */
function run(s: SimState, n: number, drivers: Driver[], a: number, b: number): { revA: number; revB: number; lock: number } {
  let revA = 0, revB = 0, lock = 0, streak = 0;
  let pa = { x: s.players[a]!.vx, z: s.players[a]!.vz }, pb = { x: s.players[b]!.vx, z: s.players[b]!.vz };
  for (let t = 0; t < n; t++) {
    for (const d of drivers) d.set(s);
    s.tick++;
    EV.begin(s.tick);
    actionsTick(s, EV);
    locomotionTick(s, EV);
    bodyContactTick(s, EV);
    const A = s.players[a]!, B = s.players[b]!;
    if (Math.hypot(A.vx, A.vz) > 1 && Math.hypot(pa.x, pa.z) > 1 && A.vx * pa.x + A.vz * pa.z < 0) revA++;
    if (Math.hypot(B.vx, B.vz) > 1 && Math.hypot(pb.x, pb.z) > 1 && B.vx * pb.x + B.vz * pb.z < 0) revB++;
    pa = { x: A.vx, z: A.vz }; pb = { x: B.vx, z: B.vz };
    streak = Math.hypot(A.x - B.x, A.z - B.z) < 0.85 ? streak + 1 : 0;
    if (streak > lock) lock = streak;
  }
  return { revA, revB, lock };
}

const arrive = (slot: number, x: number, z: number, speed: number): Driver => ({
  slot, set: (s) => { const p = s.players[slot]!; p.moveMode = MoveMode.ARRIVE; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = speed; },
});
const stick = (slot: number, ix: number, iz: number, sprint = 0): Driver => ({
  slot, set: (s) => { const p = s.players[slot]!; p.moveMode = MoveMode.DIRECT; p.ix = ix; p.iz = iz; p.wantSprint = sprint; },
});

describe('QF-9 SIM-05: no body lock with a man running alongside', () => {
  it('glitch: Players run in place against each other — a runner crossing behind an opponent running the same way gets free (table of speeds and sides)', () => {
    // Runner A (slot 10, AI ARRIVE target 20 m away across B's run) shoulder to shoulder with B (slot 17, stick-driven,
    // running +z). Table: B's stick strength (pace), which side A starts on, and A's target speed.
    for (const pace of [0.55, 0.8, 1]) {
      for (const side of [-1, 1]) {
        for (const tsp of [5.2, 7.5]) {
          const s = world(3);
          const A = s.players[10]!, B = s.players[17]!;
          A.x = 0.75 * side; A.z = 0; A.vx = 0.6 * -side; A.vz = 2.2;
          B.x = 0; B.z = 0; B.vx = 0; B.vz = 2.6;
          const r = run(s, 90, [arrive(10, -14 * side, 18, tsp), stick(17, 0.5 * side * pace, 0.86 * pace)], 10, 17);
          const name = `pace ${pace} side ${side} speed ${tsp}`;
          expect(r.revA, name).toBeLessThanOrEqual(2);
          expect(r.lock, name).toBeLessThanOrEqual(45);
        }
      }
    }
  });

  it('two teammates whose runs converge while running the same way part along their run (the one behind gives way)', () => {
    const s = world(5);
    const A = s.players[3]!, B = s.players[4]!;
    A.x = -0.4; A.z = 0; A.vz = 4; B.x = 0.4; B.z = 0.1; B.vz = 4.2;
    const r = run(s, 90, [arrive(3, 8, 25, 6), arrive(4, -8, 25, 6)], 3, 4);
    expect(r.revA).toBeLessThanOrEqual(2);
    expect(r.revB).toBeLessThanOrEqual(2);
    expect(r.lock).toBeLessThanOrEqual(45);
    // Both make progress toward their targets.
    expect(s.players[3]!.z).toBeGreaterThan(6);
    expect(s.players[4]!.z).toBeGreaterThan(6);
  });

  it('glitch: Players run in place against each other — a runner never jitters against a goal-side marker drifting across his path', () => {
    // Soak seed 91 #0 t 6290 (2-minute halves): runner 21 heading for a spot 9 m away, marker 2 (lookAt, ARRIVE on a
    // spot just goal-side of him) 0.8 m in front-left drifting across at 1.0-1.3 m/s. Giving way with a lower threshold
    // alternated with the world-frame slide every 2-3 ticks (A's velocity flipped 6+ times in 2 s).
    for (const [ox, oz] of [[-0.5, -0.62], [-0.5, 0.62], [-0.7, -0.3]] as const) {
      const s = world(9);
      const A = s.players[21]!, B = s.players[2]!;
      A.x = -14.8; A.z = 14; A.vx = -1.5; A.vz = 0;
      B.x = A.x + ox; B.z = A.z + oz; B.vx = -1.3; B.vz = 0;
      const marker: Driver = {
        slot: 2,
        set: (st) => {
          const a = st.players[21]!, b = st.players[2]!;
          b.moveMode = MoveMode.ARRIVE; b.tgtX = a.x - 1.0; b.tgtZ = a.z + oz * 0.8; b.tgtSpeed = 8.9;
          b.lookAt = 1; b.lookX = a.x; b.lookZ = a.z;
        },
      };
      const r = run(s, 120, [arrive(21, -24, 13.5, 5.3), marker], 21, 2);
      expect(r.revA, `offset ${ox}, ${oz}`).toBeLessThanOrEqual(2);
    }
  });

  it('head-on runners still slide past each other, and a runner still slides round a standing man (existing behaviour)', () => {
    const s = world(6);
    s.players[5]!.x = -3; s.players[5]!.z = 0; s.players[16]!.x = 3; s.players[16]!.z = 0.05;
    const r = run(s, 120, [arrive(5, 15, 0, 6), arrive(16, -15, 0, 6)], 5, 16);
    expect(r.lock).toBeLessThan(30);
    expect(s.players[5]!.x).toBeGreaterThan(4); // past each other
    expect(s.players[16]!.x).toBeLessThan(-4);
    const s2 = world(7);
    s2.players[6]!.x = -3; s2.players[6]!.z = 0; s2.players[18]!.x = 0; s2.players[18]!.z = 0;
    const r2 = run(s2, 120, [arrive(6, 12, 0, 6)], 6, 18);
    expect(r2.lock).toBeLessThan(60);
    expect(s2.players[6]!.x).toBeGreaterThan(4); // round him
  });
});
