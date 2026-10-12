/**
 * SIM-05 body contact scenarios: crowded penalty area, the "run in place" and "ball stuck between two players"
 * glitches, shielding against a challenger, keeper priority and the goal frame, stepped through the real movement
 * stages (actions -> SIM-04 locomotion -> SIM-05 bodies) with intents re-asserted every tick like the AI does, plus
 * a smoke run of the full step() pipeline with the overlap invariant on.
 */
// Load the action registry before any handler module (sim/actions import cycle; see the SIM-05 report).
import '../../src/sim/actions/dispatch';
import { describe, expect, it } from 'vitest';
import { GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_DRIBBLE, T_PLAYER } from '../../src/contracts/tuning';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import {
  LOCAL_TUNING as BT, bodyContactTick, contactDistance, isShielding, shieldBlocks,
} from '../../src/sim/players/bodies';
import { startShield } from '../../src/sim/players/bodiesShield';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { makeScenario, runTicks } from '../harness/scenario';

const TOL = T_PLAYER.overlapTolerance;

/** IN_PLAY state with everyone parked in a far-away row at rest; average bodies. */
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

function put(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
}

function arrive(s: SimState, slot: number, x: number, z: number, speed: number): void {
  const p = s.players[slot]!;
  p.moveMode = MoveMode.ARRIVE; p.tgtX = x; p.tgtZ = z; p.tgtSpeed = speed;
}

function stick(s: SimState, slot: number, ix: number, iz: number): void {
  const p = s.players[slot]!;
  p.moveMode = MoveMode.DIRECT; p.ix = ix; p.iz = iz;
}

function dist(s: SimState, a: number, b: number): number {
  const p = s.players[a]!, q = s.players[b]!;
  return Math.hypot(p.x - q.x, p.z - q.z);
}

function distTo(s: SimState, a: number, x: number, z: number): number {
  return Math.hypot(s.players[a]!.x - x, s.players[a]!.z - z);
}

const EV = createEventBuffer();

/** The movement stages of step(): actions, SIM-04 locomotion, SIM-05 bodies. */
function move(s: SimState): void {
  s.tick++;
  EV.begin(s.tick);
  actionsTick(s, EV);
  locomotionTick(s, EV);
  bodyContactTick(s, EV);
}

/** Tracks, per pair, consecutive ticks overlapping beyond tolerance; returns the worst streak seen. */
function overlapTracker(): (s: SimState) => number {
  const streak = new Int32Array(NUM_SLOTS * NUM_SLOTS);
  let worst = 0;
  return (s) => {
    for (let i = 0; i < NUM_SLOTS; i++) {
      for (let j = i + 1; j < NUM_SLOTS; j++) {
        const k = i * NUM_SLOTS + j;
        if (s.players[i]!.active === 1 && s.players[j]!.active === 1 && dist(s, i, j) < contactDistance(s, i, j) - TOL) {
          streak[k]!++;
          if (streak[k]! > worst) worst = streak[k]!;
        } else streak[k] = 0;
      }
    }
    return worst;
  };
}

/** Body centre inside a goal: behind the line between the posts and in front of the back netting. */
function insideGoal(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  const ax = Math.abs(p.x);
  return ax > HALF_LENGTH + 1e-9 && ax < HALF_LENGTH + GOAL_DEPTH && Math.abs(p.z) < GOAL_HALF_WIDTH;
}

/** Deterministic pseudo-random sequence for scenario targets (test-side only). */
function lcg(seed: number): () => number {
  let v = seed >>> 0;
  return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 4294967296; };
}

describe('SIM-05 crowded penalty area', () => {
  it('20 players jostling in the box for 10 s: never overlap beyond tolerance for 1 s, never in the goal (all invariants hold)', () => {
    const s = world(7);
    const rnd = lcg(99);
    const outfield: number[] = [];
    for (let i = 0; i < NUM_SLOTS; i++) if (s.players[i]!.isKeeper !== 1) outfield.push(i);
    expect(outfield).toHaveLength(20);
    for (let k = 0; k < outfield.length; k++) {
      const i = outfield[k]!;
      put(s, i, 38 + rnd() * 13, -18 + rnd() * 36);
      s.attrs[i]!.strength = 20 + Math.floor(rnd() * 79);
      s.attrs[i]!.height = 165 + Math.floor(rnd() * 35);
    }
    const kd = s.teams[1]!.keeperSlot; // defends +x in the first half
    put(s, kd, HALF_LENGTH - 1, 0);
    const tx = new Float64Array(NUM_SLOTS), tz = new Float64Array(NUM_SLOTS);
    const checker = createInvariantChecker(['finite', 'bounds', 'overlap']);
    const worst = overlapTracker();
    let streak = 0;
    for (let t = 0; t < 600; t++) {
      if (t % 60 === 0) {
        for (const i of outfield) {
          const r = rnd();
          if (r < 0.4) { tx[i] = 41.5 + rnd() * 2; tz[i] = -1 + rnd() * 2; } // penalty spot scramble
          else if (r < 0.7) { tx[i] = 48 + rnd() * 4.3; tz[i] = -4 + rnd() * 8; } // six-yard box / goal mouth
          else { tx[i] = 37 + rnd() * 15; tz[i] = -20 + rnd() * 40; }
        }
      }
      for (const i of outfield) {
        // Defenders mark the attacker in the same index when the scramble is on: targets inside other bodies.
        const marker = i >= 11 && t % 240 > 120;
        const m = s.players[i - 11 >= 0 ? i - 11 : i]!;
        arrive(s, i, marker ? m.x : tx[i]!, marker ? m.z : tz[i]!, 4 + (i % 4));
      }
      arrive(s, kd, HALF_LENGTH - 1, s.ball.z * 0.1, 3);
      move(s);
      expect(checker.check(s, EV)).toEqual([]);
      streak = worst(s);
      for (let i = 0; i < NUM_SLOTS; i++) expect(insideGoal(s, i), `player ${i} at t=${t}`).toBe(false);
    }
    expect(streak).toBeLessThan(60);
  });

  it('the full step() pipeline keeps the overlap invariant with 20 players in the box (smoke)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, ball: { x: 0, z: 0 } });
    const rnd = lcg(5);
    const slots: number[] = [];
    for (let i = 0; i < NUM_SLOTS; i++) if (s.players[i]!.isKeeper !== 1) slots.push(i);
    for (const i of slots) put(s, i, 40 + rnd() * 10, -12 + rnd() * 24);
    const inv = createInvariantChecker(['finite', 'bounds', 'overlap']);
    const events = createEventBuffer();
    let ticks = 0;
    runTicks(s, 600, (_tick, st) => {
      // Intents as an AI would set them (the team AI may override them once it drives these players).
      for (const i of slots) {
        if (st.players[i]!.ctrl >= 0) continue;
        arrive(st, i, 41.5 + ((i * 7) % 5) * 0.3, -1 + ((i * 3) % 5) * 0.4, 5);
      }
    }, { events, until: (st) => { expect(inv.check(st, events)).toEqual([]); ticks++; return false; } });
    expect(ticks).toBe(600);
  });
});

describe('SIM-05 regression "Players: run in place against each other"', () => {
  it('two opponents heading straight through each other slide round and both arrive', () => {
    const s = world();
    put(s, 5, -5, 0); put(s, 16, 5, 0);
    let reached = -1;
    for (let t = 0; t < 360 && reached < 0; t++) {
      arrive(s, 5, 10, 0, 6); arrive(s, 16, -10, 0, 6);
      move(s);
      if (distTo(s, 5, 10, 0) < 0.5 && distTo(s, 16, -10, 0) < 0.5) reached = t;
    }
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(300);
  });

  it('two teammates heading through each other pass (deterministic sides: each keeps to his right)', () => {
    const s = world();
    put(s, 5, 0, -5); put(s, 6, 0, 5);
    let passed = -1;
    for (let t = 0; t < 360 && passed < 0; t++) {
      arrive(s, 5, 0, 10, 7); arrive(s, 6, 0, -10, 7);
      move(s);
      if (s.players[5]!.z > 2 && s.players[6]!.z < -2 && passed < 0) passed = t;
      if (t === 40) {
        // While passing, slot 5 (moving +z, right = -x) is on the -x side, slot 6 on the +x side.
        expect(s.players[5]!.x).toBeLessThanOrEqual(s.players[6]!.x);
      }
    }
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThan(240);
  });

  it('nearly aligned paths with the same sideways wish still pass (side chosen per pair, not in tandem)', () => {
    const s = world();
    put(s, 5, -5, 0); put(s, 16, 5, 0);
    let reached = -1;
    for (let t = 0; t < 360 && reached < 0; t++) {
      arrive(s, 5, 10, 0.05, 6); arrive(s, 16, -10, 0.05, 6);
      move(s);
      if (distTo(s, 5, 10, 0.05) < 0.5 && distTo(s, 16, -10, 0.05) < 0.5) reached = t;
    }
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(300);
  });

  it('two stick-driven opponents pushing head-on do not deadlock', () => {
    const s = world();
    put(s, 5, -3, 0); put(s, 16, 3, 0);
    let passed = -1;
    for (let t = 0; t < 240 && passed < 0; t++) {
      stick(s, 5, 1, 0); stick(s, 16, -1, 0);
      move(s);
      if (s.players[5]!.x > s.players[16]!.x + 0.8) passed = t;
    }
    expect(passed).toBeGreaterThan(0);
    expect(passed).toBeLessThan(180);
  });

  it('a runner gets round an opponent holding his spot; the holder returns to it', () => {
    const s = world();
    put(s, 5, -6, 0); put(s, 16, 0, 0);
    let reached = -1;
    for (let t = 0; t < 600; t++) {
      arrive(s, 5, 8, 0, 8); arrive(s, 16, 0, 0, 5);
      move(s);
      if (reached < 0 && distTo(s, 5, 8, 0) < 0.5) reached = t;
    }
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(300);
    expect(distTo(s, 16, 0, 0)).toBeLessThan(0.3);
  });

  it('a runner gets round a line of three players standing across his path', () => {
    const s = world();
    put(s, 5, -6, 0.1);
    put(s, 14, 0, -0.78); put(s, 15, 0, 0); put(s, 16, 0, 0.78);
    let reached = -1;
    for (let t = 0; t < 600 && reached < 0; t++) {
      arrive(s, 5, 8, 0, 7);
      for (const k of [14, 15, 16]) arrive(s, k, 0, (k - 15) * 0.78, 4);
      move(s);
      if (distTo(s, 5, 8, 0) < 0.5) reached = t;
    }
    expect(reached).toBeGreaterThan(0);
    expect(reached).toBeLessThan(420);
  });

  it('two players sent to the same spot settle side by side: no orbit, no jitter, no slide', () => {
    const s = world();
    put(s, 5, -4, 0.3); put(s, 16, 4, -0.2);
    for (let t = 0; t < 240; t++) { arrive(s, 5, 0, 0, 6); arrive(s, 16, 0, 0, 6); move(s); }
    const x5 = s.players[5]!.x, z5 = s.players[5]!.z, x16 = s.players[16]!.x, z16 = s.players[16]!.z;
    let path = 0;
    for (let t = 0; t < 60; t++) {
      const ax = s.players[5]!.x, az = s.players[5]!.z;
      arrive(s, 5, 0, 0, 6); arrive(s, 16, 0, 0, 6); move(s);
      path += Math.hypot(s.players[5]!.x - ax, s.players[5]!.z - az);
    }
    expect(path).toBeLessThan(0.1);
    expect(Math.hypot(s.players[5]!.x - x5, s.players[5]!.z - z5)).toBeLessThan(0.05);
    expect(Math.hypot(s.players[16]!.x - x16, s.players[16]!.z - z16)).toBeLessThan(0.05);
    expect(dist(s, 5, 16)).toBeGreaterThan(contactDistance(s, 5, 16) - TOL);
  });
});

describe('SIM-05 regression "Ball stuck: between two players"', () => {
  it('two opponents converging on a loose ball stop with it inside their reach (SIM-06 can pick it up)', () => {
    const s = world();
    s.ball.x = 0; s.ball.z = 0;
    put(s, 5, -4, 0); put(s, 16, 4, 0);
    for (let t = 0; t < 240; t++) { arrive(s, 5, 0, 0, 7); arrive(s, 16, 0, 0, 7); move(s); }
    const d5 = distTo(s, 5, 0, 0), d16 = distTo(s, 16, 0, 0);
    expect(Math.min(d5, d16)).toBeLessThan(T_DRIBBLE.controlRadius);
    expect(Math.max(d5, d16)).toBeLessThan(T_DRIBBLE.controlRadius);
    expect(Math.hypot(s.players[5]!.vx, s.players[5]!.vz)).toBeLessThan(0.3);
    expect(Math.hypot(s.players[16]!.vx, s.players[16]!.vz)).toBeLessThan(0.3);
  });

  it('four players crowding a ball from four sides all stay within reach of it and do not overlap', () => {
    const s = world();
    s.ball.x = 10; s.ball.z = 5;
    const who = [3, 7, 14, 19];
    const from = [[-3, 0], [3, 0.2], [0.1, -3], [-0.2, 3]];
    for (let k = 0; k < 4; k++) put(s, who[k]!, 10 + from[k]![0]!, 5 + from[k]![1]!);
    for (let t = 0; t < 300; t++) { for (const k of who) arrive(s, k, 10, 5, 6); move(s); }
    for (const k of who) expect(distTo(s, k, 10, 5)).toBeLessThan(T_DRIBBLE.controlRadius);
    for (let a = 0; a < 4; a++) {
      for (let b = a + 1; b < 4; b++) expect(dist(s, who[a]!, who[b]!)).toBeGreaterThan(contactDistance(s, who[a]!, who[b]!) - TOL);
    }
  });
});

describe('SIM-05 shielding', () => {
  /** Owner 9 shields a ball at his feet (ball static: SIM-06 dribbling is not part of these stages). */
  function shieldScene(ownerStr: number, challStr: number, cx: number, cz: number): SimState {
    const s = world();
    s.attrs[9]!.strength = ownerStr; s.attrs[14]!.strength = challStr;
    put(s, 9, 0, 0);
    s.players[9]!.fx = 1; s.players[9]!.fz = 0;
    s.ball.x = -0.5; s.ball.z = 0; s.ball.owner = 9;
    put(s, 14, cx, cz);
    expect(startShield(s, 9)).toBe(1);
    return s;
  }

  function challenge(s: SimState, ticks: number): number {
    let minD = Infinity;
    for (let t = 0; t < ticks; t++) {
      s.players[9]!.moveMode = MoveMode.STOP;
      arrive(s, 14, s.ball.x, s.ball.z, 7);
      move(s);
      if (t > 20) minD = Math.min(minD, distTo(s, 14, s.ball.x, s.ball.z));
    }
    return minD;
  }

  it('shielding keeps the ball away from an equally strong challenger coming from the front', () => {
    const s = shieldScene(60, 60, 3, 0.3);
    const minD = challenge(s, 300);
    expect(minD).toBeGreaterThan(T_DRIBBLE.controlRadius);
    expect(isShielding(s, 9)).toBe(true);
    expect(shieldBlocks(s, 9, 14)).toBe(true);
    // He faces the challenger (lookAt) with the ball behind him.
    const o = s.players[9]!, c = s.players[14]!;
    expect(o.lookAt).toBe(1);
    expect(o.fx * (c.x - o.x) + o.fz * (c.z - o.z)).toBeGreaterThan(0);
  });

  it('the shielder turns to stay between ball and challenger when the challenger comes round the side', () => {
    const s = shieldScene(60, 60, -0.5, 3); // straight at the ball from the side
    const minD = challenge(s, 300);
    expect(minD).toBeGreaterThan(T_DRIBBLE.controlRadius);
    // Body on the ball-challenger line.
    const o = s.players[9]!, c = s.players[14]!, b = s.ball;
    const ax = o.x - b.x, az = o.z - b.z, cx = c.x - b.x, cz = c.z - b.z;
    const cos = (ax * cx + az * cz) / (Math.hypot(ax, az) * Math.hypot(cx, cz));
    expect(cos).toBeGreaterThan(0.95);
    expect(shieldBlocks(s, 9, 14)).toBe(true);
  });

  it('a much stronger challenger muscles through a weak shielder', () => {
    const s = shieldScene(40, 90, 3, 0.3);
    expect(challenge(s, 300)).toBeLessThan(T_DRIBBLE.controlRadius);
    expect(shieldBlocks(s, 9, 14)).toBe(false);
  });

  it('moves slowly while shielding even with the sprint held (SIM-04 cap, SIM-05 backstop)', () => {
    const s = shieldScene(60, 60, 3, 0.3);
    let vmax = 0;
    for (let t = 0; t < 120; t++) {
      stick(s, 9, -1, 0.3);
      s.players[9]!.wantSprint = 1;
      arrive(s, 14, s.ball.x, s.ball.z, 7);
      move(s);
      vmax = Math.max(vmax, Math.hypot(s.players[9]!.vx, s.players[9]!.vz));
    }
    expect(isShielding(s, 9)).toBe(true);
    expect(vmax).toBeLessThanOrEqual(BT.shieldSpeedBackstop * T_PLAYER.shieldSpeedFraction * T_PLAYER.jogFraction *
      s.attrs[9]!.topSpeed + 1e-9);
  });

  it('without shielding the same challenger walks round the owner to the ball', () => {
    const s = shieldScene(60, 60, 3, 0.3);
    s.players[9]!.act = ActionKind.NONE; s.players[9]!.shielding = 0;
    expect(challenge(s, 300)).toBeLessThan(T_DRIBBLE.controlRadius);
  });
});

describe('SIM-05 keeper priority and the goal frame', () => {
  it('an attacker barging into a keeper on his line never moves him', () => {
    const s = world();
    const k = s.teams[1]!.keeperSlot; // defends +x
    put(s, k, HALF_LENGTH - 0.6, 0.5);
    put(s, 3, HALF_LENGTH - 4, 0.4);
    for (let t = 0; t < 180; t++) {
      s.players[k]!.moveMode = MoveMode.STOP;
      arrive(s, 3, HALF_LENGTH + 1, 0.5, 8); // target inside the goal: straight through the keeper
      move(s);
      expect(s.players[k]!.x).toBe(HALF_LENGTH - 0.6);
      expect(s.players[k]!.z).toBe(0.5);
      expect(insideGoal(s, 3)).toBe(false);
    }
    expect(dist(s, k, 3)).toBeGreaterThan(contactDistance(s, k, 3) - TOL);
  });

  it('regression "Players: walk through the goal frame or net": a scrum pushed at the goal never ends up in it', () => {
    const s = world();
    const scrum = [2, 3, 4, 5, 13, 14, 15, 16];
    for (let k = 0; k < scrum.length; k++) put(s, scrum[k]!, HALF_LENGTH - 3 - (k % 3) * 0.8, -5 + k * 1.4);
    put(s, 6, HALF_LENGTH + 1, GOAL_HALF_WIDTH + 1); // behind the line, outside the side netting
    for (let t = 0; t < 300; t++) {
      for (let k = 0; k < scrum.length; k++) arrive(s, scrum[k]!, HALF_LENGTH + 1.5, -3 + k * 0.8, 7);
      arrive(s, 6, HALF_LENGTH + 1, -GOAL_HALF_WIDTH - 1, 6); // tries to walk through the side netting
      move(s);
      for (let i = 0; i < NUM_SLOTS; i++) expect(insideGoal(s, i), `player ${i} at t=${t}`).toBe(false);
    }
  });
});

describe('SIM-05 determinism through the movement stages', () => {
  it('two identical runs of the crowd give identical state hashes', () => {
    const runOnce = (): number => {
      const s = world(11);
      const rnd = lcg(4);
      for (let i = 0; i < NUM_SLOTS; i++) if (s.players[i]!.isKeeper !== 1) put(s, i, 40 + rnd() * 10, -10 + rnd() * 20);
      for (let t = 0; t < 300; t++) {
        for (let i = 0; i < NUM_SLOTS; i++) if (s.players[i]!.isKeeper !== 1) arrive(s, i, 42, 0, 6);
        move(s);
      }
      return hashState(s);
    };
    expect(runOnce()).toBe(runOnce());
  });
});
