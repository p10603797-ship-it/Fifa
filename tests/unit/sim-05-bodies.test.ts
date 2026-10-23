/**
 * SIM-05 body contact: unit tests of bodyContactTick and the body / shield / shoulder queries, stage in isolation.
 */
// Load the action registry before any handler module (sim/actions import cycle; see the SIM-05 report).
import '../../src/sim/actions/dispatch';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  BOARD_X, BOARD_Z, GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS,
} from '../../src/contracts/constants';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import {
  LOCAL_TUNING as BT, bodyContactTick, bodyMassOf, bodyRadiusOf, contactDistance, isAnchored, isShielding,
  keeperHasPriority, shieldBallSpot, shieldBlocks, shieldFactor, shieldHandler, shieldLook, shieldTarget,
  shoulderPartner, shoulderToShoulder,
} from '../../src/sim/players/bodies';
import { applyShieldIntent, startShield, stopShield } from '../../src/sim/players/bodiesShield';
import { maxSpeed } from '../../src/sim/players/locomotion';
import { makeScenario } from '../harness/scenario';

const R = T_PLAYER.bodyRadius;
const TOL = T_PLAYER.overlapTolerance;

/** IN_PLAY state with every player parked far apart at rest, average bodies (182.5 cm, strength 50). */
function world(): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY });
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = -45 + i * 4; p.z = 30; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
    p.moveMode = MoveMode.STOP; p.lookAt = 0; p.act = ActionKind.NONE; p.stunT = 0; p.active = 1;
    s.attrs[i]!.height = 182.5; s.attrs[i]!.strength = 50;
  }
  s.ball.x = 0; s.ball.z = -30; s.ball.owner = -1; s.ball.heldBy = -1;
  s.match.restart.taker = -1;
  return s;
}

function put(s: SimState, slot: number, x: number, z: number, vx = 0, vz = 0): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = vx; p.vz = vz;
}

function dist(s: SimState, a: number, b: number): number {
  const p = s.players[a]!, q = s.players[b]!;
  return Math.hypot(p.x - q.x, p.z - q.z);
}

function tick(s: SimState, ev = createEventBuffer()): ReturnType<typeof createEventBuffer> {
  s.tick++;
  ev.begin(s.tick);
  bodyContactTick(s, ev);
  return ev;
}

function contacts(ev: ReturnType<typeof createEventBuffer>): { a: number; b: number; c: number; d: number; x: number; z: number }[] {
  const out = [];
  for (let i = 0; i < ev.count; i++) {
    const e = ev.get(i);
    if (e.type === EventType.BODY_CONTACT) out.push({ a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, z: e.z });
  }
  return out;
}

describe('SIM-05 body properties', () => {
  it('radius is T_PLAYER.bodyRadius scaled +-10% by height and clamped (finite for bad data)', () => {
    const s = world();
    const r = (h: number): number => { s.attrs[3]!.height = h; return bodyRadiusOf(s, 3); };
    expect(r(182.5)).toBeCloseTo(R, 12);
    expect(r(165)).toBeCloseTo(R * 0.9, 12);
    expect(r(200)).toBeCloseTo(R * 1.1, 12);
    expect(r(140)).toBeCloseTo(R * 0.9, 12);
    expect(r(230)).toBeCloseTo(R * 1.1, 12);
    expect(r(Number.NaN)).toBeCloseTo(R * 0.9, 12);
    expect(r(190)).toBeGreaterThan(r(175));
    s.attrs[4]!.height = 200;
    s.attrs[3]!.height = 165;
    expect(contactDistance(s, 3, 4)).toBeCloseTo(2 * R, 12);
  });

  it('mass grows with strength (1 at 50) and is clamped to the attribute range', () => {
    const s = world();
    const m = (v: number): number => { s.attrs[3]!.strength = v; return bodyMassOf(s, 3); };
    expect(m(50)).toBe(1);
    expect(m(99)).toBeCloseTo(1 + BT.strengthMassK * 49 / 50, 12);
    expect(m(1)).toBeCloseTo(1 - BT.strengthMassK * 49 / 50, 12);
    expect(m(80)).toBeGreaterThan(m(60));
    expect(m(500)).toBe(m(99));
    expect(m(-5)).toBe(m(1));
  });
});

describe('SIM-05 separation', () => {
  it('separates two overlapping players symmetrically, keeping their midpoint, until they just touch', () => {
    const s = world();
    put(s, 4, 0, 0); put(s, 15, 0.6, 0);
    tick(s);
    const a = s.players[4]!, b = s.players[15]!;
    expect(a.x).toBeLessThan(0);
    expect(b.x).toBeGreaterThan(0.6);
    expect(a.x + b.x).toBeCloseTo(0.6, 12);
    expect(a.z).toBe(0);
    for (let t = 0; t < 30; t++) tick(s);
    expect(dist(s, 4, 15)).toBeGreaterThan(2 * R - 1e-3);
    expect(dist(s, 4, 15)).toBeLessThanOrEqual(2 * R + 1e-9);
  });

  it('weights the separation by strength: the stronger body moves less, in the inverse mass ratio', () => {
    const s = world();
    s.attrs[4]!.strength = 95; s.attrs[15]!.strength = 20;
    put(s, 4, 0, 0); put(s, 15, 0.7, 0);
    tick(s);
    const moveStrong = -s.players[4]!.x, moveWeak = s.players[15]!.x - 0.7;
    expect(moveStrong).toBeGreaterThan(0);
    expect(moveWeak).toBeGreaterThan(moveStrong);
    expect(moveWeak / moveStrong).toBeCloseTo(bodyMassOf(s, 4) / bodyMassOf(s, 15), 9);
  });

  it('hard-separates an overlap beyond tolerance in one tick (also clear of the invariant distance)', () => {
    const s = world();
    for (const h of [165, 182.5, 200]) {
      s.attrs[4]!.height = h; s.attrs[15]!.height = h;
      put(s, 4, 0, 0); put(s, 15, 0.2, 0.05);
      tick(s);
      const rs = contactDistance(s, 4, 15);
      expect(dist(s, 4, 15)).toBeGreaterThanOrEqual(Math.max(rs - TOL, 2 * R - TOL + BT.hardMargin) - 1e-9);
    }
  });

  it('separates players standing on exactly the same spot deterministically (second one to the first one\'s right)', () => {
    const s = world();
    put(s, 4, 10, 5); put(s, 15, 10, 5);
    s.players[4]!.fx = 1; s.players[4]!.fz = 0;
    tick(s);
    expect(dist(s, 4, 15)).toBeGreaterThan(0.6);
    expect(s.players[15]!.z).toBeGreaterThan(s.players[4]!.z); // facing +x, right is +z
    expect(Number.isFinite(s.players[4]!.x) && Number.isFinite(s.players[15]!.z)).toBe(true);
  });

  it('damps the closing velocity along the contact normal and keeps the tangential part', () => {
    const s = world();
    put(s, 4, 0, 0, 3, 1); put(s, 15, 0.7, 0, -3, 1);
    tick(s);
    const a = s.players[4]!, b = s.players[15]!;
    expect(b.vx - a.vx).toBeGreaterThanOrEqual(-1e-12); // no longer closing
    expect(a.vz).toBeCloseTo(1, 12);
    expect(b.vz).toBeCloseTo(1, 12);
    // Separating players keep their velocity.
    const s2 = world();
    put(s2, 4, 0, 0, -2, 0); put(s2, 15, 0.7, 0, 2, 0);
    tick(s2);
    expect(s2.players[4]!.vx).toBe(-2);
    expect(s2.players[15]!.vx).toBe(2);
  });

  it('leaves players that do not touch untouched, ignores inactive players, emits nothing', () => {
    const s = world();
    put(s, 4, 0, 0, 1, 0); put(s, 15, 0.77, 0, -1, 0);
    put(s, 6, 5, 5); put(s, 17, 5.1, 5);
    s.players[17]!.active = 0;
    const before = cloneState(s);
    const ev = tick(s);
    for (const k of [4, 15, 6, 17]) {
      expect(s.players[k]!.x).toBe(before.players[k]!.x);
      expect(s.players[k]!.z).toBe(before.players[k]!.z);
      expect(s.players[k]!.vx).toBe(before.players[k]!.vx);
    }
    expect(contacts(ev)).toHaveLength(0);
  });

  it('resolves a dense pile of all 22 players in a few ticks without pushing anyone through the boards', () => {
    const s = world();
    for (let i = 0; i < NUM_SLOTS; i++) put(s, i, 20 + (i % 5) * 0.15, -3 + Math.floor(i / 5) * 0.15);
    for (let t = 0; t < 120; t++) tick(s);
    for (let i = 0; i < NUM_SLOTS; i++) {
      for (let j = i + 1; j < NUM_SLOTS; j++) expect(dist(s, i, j)).toBeGreaterThan(contactDistance(s, i, j) - TOL);
    }
    // Pile against a corner of the boards.
    const c = world();
    for (let i = 0; i < NUM_SLOTS; i++) put(c, i, BOARD_X - 0.5 - (i % 4) * 0.2, BOARD_Z - 0.5 - Math.floor(i / 4) * 0.2);
    for (let t = 0; t < 240; t++) {
      tick(c);
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = c.players[i]!;
        expect(Math.abs(p.x)).toBeLessThanOrEqual(BOARD_X);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(BOARD_Z);
      }
    }
    for (let i = 0; i < NUM_SLOTS; i++) {
      for (let j = i + 1; j < NUM_SLOTS; j++) expect(dist(c, i, j)).toBeGreaterThan(contactDistance(c, i, j) - TOL);
    }
  });
});

describe('SIM-05 keeper priority and anchors', () => {
  it('a keeper inside his own goal area is never pushed: the attacker takes the whole correction', () => {
    const s = world();
    const k = s.teams[0]!.keeperSlot; // team 0 defends x = -52.5 in the first half
    put(s, k, -51, 0); put(s, 18, -50.4, 0.1, -4, 0);
    expect(keeperHasPriority(s, k)).toBe(true);
    for (let t = 0; t < 20; t++) {
      s.players[18]!.vx = -4;
      tick(s);
      expect(s.players[k]!.x).toBe(-51);
      expect(s.players[k]!.z).toBe(0);
    }
    expect(dist(s, k, 18)).toBeGreaterThan(contactDistance(s, k, 18) - 0.07);
  });

  it('outside his goal area the keeper is an ordinary body; holding the ball he is anchored', () => {
    const s = world();
    const k = s.teams[0]!.keeperSlot;
    put(s, k, -40, 0); put(s, 18, -39.4, 0);
    expect(keeperHasPriority(s, k)).toBe(false);
    tick(s);
    expect(s.players[k]!.x).toBeLessThan(-40);
    put(s, k, -40, 0); put(s, 18, -39.4, 0);
    s.ball.owner = k; s.ball.heldBy = k;
    expect(keeperHasPriority(s, k)).toBe(true);
    tick(s);
    expect(s.players[k]!.x).toBe(-40);
    // The away keeper's goal area is at +x (dir -1); an outfield player never gets keeper priority.
    const k1 = s.teams[1]!.keeperSlot;
    put(s, k1, 50, 3);
    expect(keeperHasPriority(s, k1)).toBe(true);
    put(s, 5, -51, 0);
    expect(keeperHasPriority(s, 5)).toBe(false);
  });

  it('the restart taker is anchored until the restart is taken', () => {
    const s = world();
    s.match.phase = MatchPhase.FREE_KICK;
    s.match.restart.kind = RestartKind.FREE_KICK;
    s.match.restart.taker = 7; s.match.restart.taken = 0;
    expect(isAnchored(s, 7)).toBe(true);
    put(s, 7, 0, 0); put(s, 8, 0.5, 0);
    tick(s);
    expect(s.players[7]!.x).toBe(0);
    s.match.restart.taken = 1;
    expect(isAnchored(s, 7)).toBe(false);
    s.match.phase = MatchPhase.IN_PLAY;
    expect(isAnchored(s, 7)).toBe(false);
  });

  it('two anchored bodies still separate (split by mass, finite)', () => {
    const s = world();
    const k = s.teams[0]!.keeperSlot;
    s.match.phase = MatchPhase.GOAL_KICK;
    s.match.restart.taker = 3; s.match.restart.taken = 0;
    put(s, k, -50, 0); put(s, 3, -49.5, 0);
    for (let t = 0; t < 10; t++) tick(s);
    expect(dist(s, k, 3)).toBeGreaterThan(contactDistance(s, k, 3) - TOL);
    expect(Number.isFinite(s.players[k]!.x)).toBe(true);
  });
});

describe('SIM-05 goal frame and boards ("Players: walk through the goal frame or net")', () => {
  /** True if a body centre is inside a goal (between the posts, behind the line, in front of the back net). */
  function insideGoal(x: number, z: number): boolean {
    const ax = Math.abs(x);
    return ax > HALF_LENGTH + 1e-9 && ax < HALF_LENGTH + GOAL_DEPTH && Math.abs(z) < GOAL_HALF_WIDTH;
  }

  it('bodies never push a defender on the goal line into the goal', () => {
    const s = world();
    put(s, 3, -52.3, 1); // defender on his line, between the posts
    for (let t = 0; t < 120; t++) {
      put(s, 14, s.players[3]!.x + 0.55, 1.05, -5, 0); // attacker keeps barging in from the field
      tick(s);
      expect(insideGoal(s.players[3]!.x, s.players[3]!.z)).toBe(false);
      expect(s.players[3]!.x).toBeGreaterThanOrEqual(-HALF_LENGTH);
    }
  });

  it('bodies never push a player through the side or back netting from outside', () => {
    const s = world();
    // Behind the goal line beside the side netting, shoved toward the goal by an opponent.
    put(s, 3, 53.5, GOAL_HALF_WIDTH + 0.5);
    for (let t = 0; t < 120; t++) {
      const p = s.players[3]!;
      put(s, 14, p.x, p.z + 0.5, 0, -5);
      tick(s);
      expect(insideGoal(s.players[3]!.x, s.players[3]!.z)).toBe(false);
    }
    // Behind the back netting, shoved toward the field.
    put(s, 3, HALF_LENGTH + GOAL_DEPTH + 0.5, 0);
    for (let t = 0; t < 120; t++) {
      const p = s.players[3]!;
      put(s, 14, p.x + 0.5, p.z, -5, 0);
      tick(s);
      expect(insideGoal(s.players[3]!.x, s.players[3]!.z)).toBe(false);
      expect(Math.abs(s.players[14]!.x)).toBeLessThanOrEqual(BOARD_X);
    }
  });

  it('bodies never push a player past the advertising boards', () => {
    const s = world();
    put(s, 3, 10, BOARD_Z - 0.3);
    for (let t = 0; t < 60; t++) {
      put(s, 14, 10, s.players[3]!.z - 0.4, 0, 6);
      tick(s);
      expect(s.players[3]!.z).toBeLessThanOrEqual(BOARD_Z);
      expect(s.players[14]!.z).toBeLessThanOrEqual(BOARD_Z);
    }
  });
});

describe('SIM-05 BODY_CONTACT events', () => {
  it('a hard head-on collision emits one shove (b = 1) with the closing speed at the contact point, then nothing while they lean', () => {
    const s = world();
    put(s, 4, 0, 0, 5, 0); put(s, 15, 0.7, 0, -5, 0);
    const ev = tick(s);
    const c = contacts(ev);
    expect(c).toHaveLength(1);
    expect(c[0]!.b).toBe(1);
    expect(c[0]!.c).toBeCloseTo(10, 9);
    expect([c[0]!.a, c[0]!.d].sort((x, y) => x - y)).toEqual([4, 15]);
    expect(c[0]!.x).toBeCloseTo((s.players[4]!.x + s.players[15]!.x) / 2, 9);
    for (let t = 0; t < 30; t++) {
      // Both keep leaning in at walking pace: sustained contact, no new events.
      s.players[4]!.vx += 0.1; s.players[15]!.vx -= 0.1;
      expect(contacts(tick(s))).toHaveLength(0);
    }
  });

  it('a moderate bump is b = 0, a gentle touch emits nothing; the lighter body is reported as the pushed one', () => {
    const s = world();
    s.attrs[15]!.strength = 20;
    put(s, 4, 0, 0, 1, 0); put(s, 15, 0.7, 0, -1, 0);
    const c = contacts(tick(s));
    expect(c).toHaveLength(1);
    expect(c[0]!.b).toBe(0);
    expect(c[0]!.a).toBe(15);
    expect(c[0]!.d).toBe(4);
    const g = world();
    put(g, 4, 0, 0, 0.4, 0); put(g, 15, 0.7, 0, -0.4, 0);
    expect(contacts(tick(g))).toHaveLength(0);
  });

  it('caps BODY_CONTACT events per tick', () => {
    const s = world();
    for (let k = 0; k < 8; k++) { put(s, 2 * k, k * 3, 0, 4, 0); put(s, 2 * k + 1, k * 3 + 0.7, 0, -4, 0); }
    expect(contacts(tick(s))).toHaveLength(BT.maxEventsPerTick);
  });
});

describe('SIM-05 shoulder to shoulder', () => {
  it('opponents running alongside and leaning in are shoulder to shoulder; it emits a shove for audio', () => {
    const s = world();
    put(s, 9, 0, 0, 7, 0.6); put(s, 15, 0.1, 0.72, 7, -0.6);
    expect(shoulderToShoulder(s, 9, 15)).toBe(true);
    expect(shoulderToShoulder(s, 15, 9)).toBe(true);
    expect(shoulderPartner(s, 9)).toBe(15);
    expect(shoulderPartner(s, 15)).toBe(9);
    const c = contacts(tick(s));
    expect(c).toHaveLength(1);
    expect(c[0]!.b).toBe(1);
  });

  it('not shoulder to shoulder: head-on, one behind the other, too slow, too far, teammates as partners', () => {
    const s = world();
    put(s, 9, 0, 0, 7, 0); put(s, 15, 0.7, 0, -7, 0);
    expect(shoulderToShoulder(s, 9, 15)).toBe(false); // head-on
    put(s, 15, 0.7, 0, 7, 0);
    expect(shoulderToShoulder(s, 9, 15)).toBe(false); // in line
    put(s, 15, 0, 0.75, 1, 0); put(s, 9, 0, 0, 1, 0);
    expect(shoulderToShoulder(s, 9, 15)).toBe(false); // jogging slowly
    put(s, 15, 0, 1.5, 7, 0); put(s, 9, 0, 0, 7, 0);
    expect(shoulderToShoulder(s, 9, 15)).toBe(false); // apart
    put(s, 10, 0, 0.75, 7, 0); put(s, 15, 30, 0);
    expect(shoulderToShoulder(s, 9, 10)).toBe(true); // geometry holds for teammates ...
    expect(shoulderPartner(s, 9)).toBe(-1); // ... but only opponents are partners
    expect(shoulderToShoulder(s, 9, 9)).toBe(false);
    expect(shoulderPartner(s, -1)).toBe(-1);
  });
});

describe('SIM-05 shielding API', () => {
  /** Owner 9 with the ball at his feet, opponent 14 nearby. */
  function shieldSetup(): SimState {
    const s = world();
    put(s, 9, 0, 0);
    s.players[9]!.fx = -1; s.players[9]!.fz = 0;
    s.ball.x = -0.5; s.ball.z = 0; s.ball.owner = 9;
    put(s, 14, 1.0, 0);
    return s;
  }

  it('startShield needs the ball at the feet and a free player; stopShield frees him at once', () => {
    const s = shieldSetup();
    expect(startShield(s, 10)).toBe(0); // not the owner
    s.players[9]!.act = ActionKind.KICK;
    expect(startShield(s, 9)).toBe(0); // busy
    s.players[9]!.act = ActionKind.NONE;
    expect(isShielding(s, 9)).toBe(false);
    expect(startShield(s, 9)).toBe(1);
    expect(s.players[9]!.act).toBe(ActionKind.SHIELD);
    expect(s.players[9]!.shielding).toBe(1);
    expect(isShielding(s, 9)).toBe(true);
    expect(s.players[9]!.lookAt).toBe(1);
    expect([s.players[9]!.lookX, s.players[9]!.lookZ]).toEqual([1, 0]);
    expect(startShield(s, 9)).toBe(1); // idempotent
    stopShield(s, 9);
    expect(s.players[9]!.act).toBe(ActionKind.NONE);
    expect(s.players[9]!.shielding).toBe(0);
    expect(s.players[9]!.lookAt).toBe(0);
    s.ball.heldBy = 9;
    expect(startShield(s, 9)).toBe(0); // in hands
    expect(startShield(s, -1)).toBe(0);
    stopShield(s, 99);
  });

  it('applyShieldIntent starts on hold and stops on release; not without the ball', () => {
    const s = shieldSetup();
    expect(applyShieldIntent(s, 9, 1)).toBe(1);
    expect(isShielding(s, 9)).toBe(true);
    expect(applyShieldIntent(s, 9, 1)).toBe(1);
    expect(applyShieldIntent(s, 9, 0)).toBe(0);
    expect(s.players[9]!.act).toBe(ActionKind.NONE);
    expect(applyShieldIntent(s, 10, 1)).toBe(0);
    expect(s.players[10]!.act).toBe(ActionKind.NONE);
    expect(applyShieldIntent(s, 10, 0)).toBe(0);
  });

  it('the SHIELD handler keeps the action open while held and ends it on loss of the ball, hands, stun or release', () => {
    const ev = createEventBuffer();
    const checker = createInvariantChecker(['action']);
    const run = (s: SimState, n: number): void => {
      for (let t = 0; t < n; t++) {
        s.tick++;
        ev.begin(s.tick);
        actionsTick(s, ev);
        expect(checker.check(s, ev)).toEqual([]);
      }
    };
    const s = shieldSetup();
    startShield(s, 9);
    run(s, 200);
    expect(s.players[9]!.act).toBe(ActionKind.SHIELD);
    s.ball.owner = 14;
    run(s, 1);
    expect(s.players[9]!.act).toBe(ActionKind.NONE);
    expect(s.players[9]!.shielding).toBe(0);

    const h = shieldSetup();
    startShield(h, 9);
    run(h, 5);
    h.ball.heldBy = 9;
    run(h, 1);
    expect(h.players[9]!.act).toBe(ActionKind.NONE);

    const st = shieldSetup();
    startShield(st, 9);
    run(st, 5);
    st.players[9]!.stunT = 10;
    run(st, 1);
    expect(st.players[9]!.act).toBe(ActionKind.NONE);

    const r = shieldSetup();
    startShield(r, 9);
    r.players[9]!.shielding = 0; // a stale flag on the first tick is ignored (SIM-04 writes it after the actions)
    run(r, 1);
    expect(r.players[9]!.act).toBe(ActionKind.SHIELD);
    run(r, 3);
    r.players[9]!.shielding = 0; // resolver released SHIELD
    run(r, 1);
    expect(r.players[9]!.act).toBe(ActionKind.NONE);
    expect(r.players[9]!.lookAt).toBe(0);

    // A SHIELD action begun directly (without p.shielding) keeps going once SIM-04 mirrors the flag.
    const d = shieldSetup();
    d.players[9]!.act = ActionKind.SHIELD; d.players[9]!.actT = 0; d.players[9]!.actDur = 1;
    run(d, 1);
    expect(d.players[9]!.act).toBe(ActionKind.SHIELD);
    expect(d.players[9]!.shielding).toBe(1);
    shieldHandler.end(d, 9, 1);
    expect(d.players[9]!.shielding).toBe(0);
  });

  it('shieldTarget is the nearest active standing opponent within range', () => {
    const s = shieldSetup();
    put(s, 10, 0.5, 0); // teammate closer
    put(s, 15, 0, 2);
    expect(shieldTarget(s, 9)).toBe(14);
    s.players[14]!.act = ActionKind.FALLEN;
    expect(shieldTarget(s, 9)).toBe(15);
    s.players[15]!.active = 0;
    expect(shieldTarget(s, 9)).toBe(-1);
    s.players[14]!.act = ActionKind.NONE;
    put(s, 14, BT.shieldRange + 0.1, 0);
    expect(shieldTarget(s, 9)).toBe(-1);
    put(s, 14, 1, 0); put(s, 16, -1, 0); // tie: lower slot
    expect(shieldTarget(s, 9)).toBe(14);
  });

  it('shieldFactor / shieldBlocks: covered + strength duel; nothing when not covering, not shielding or a teammate', () => {
    const s = shieldSetup();
    expect(shieldFactor(s, 9, 14)).toBe(0); // not shielding yet
    startShield(s, 9);
    expect(shieldBlocks(s, 9, 14)).toBe(true);
    expect(shieldFactor(s, 9, 14)).toBeCloseTo(0.5 + BT.shieldStrengthBonus / BT.shieldFactorSpan, 12);
    s.attrs[14]!.strength = 50 + BT.shieldStrengthBonus;
    expect(shieldFactor(s, 9, 14)).toBeCloseTo(0.5, 12);
    expect(shieldBlocks(s, 9, 14)).toBe(true);
    s.attrs[14]!.strength = 50 + BT.shieldStrengthBonus + 1;
    expect(shieldBlocks(s, 9, 14)).toBe(false);
    s.attrs[14]!.strength = 99; s.attrs[9]!.strength = 1;
    expect(shieldFactor(s, 9, 14)).toBe(0);
    s.attrs[14]!.strength = 1; s.attrs[9]!.strength = 99;
    expect(shieldFactor(s, 9, 14)).toBe(1);
    // Challenger on the ball's side of the body: not covered.
    put(s, 14, -1.2, 0.2);
    expect(shieldFactor(s, 9, 14)).toBe(0);
    // Off to the side, the body is not in the way.
    put(s, 14, 0.2, 1.5);
    expect(shieldFactor(s, 9, 14)).toBe(0);
    put(s, 14, -0.5, 1.5);
    expect(shieldFactor(s, 9, 14)).toBe(0);
    put(s, 14, 1.2, 0.35); // nearly behind the body: covered
    expect(shieldBlocks(s, 9, 14)).toBe(true);
    put(s, 14, 1.0, 0.1);
    expect(shieldBlocks(s, 9, 14)).toBe(true);
    put(s, 10, 1.0, -0.1); // teammate
    expect(shieldFactor(s, 9, 10)).toBe(0);
    expect(shieldFactor(s, 9, 9)).toBe(0);
    expect(shieldFactor(s, 9, -1)).toBe(0);
    put(s, 14, -0.5, 0); // standing on the ball
    expect(shieldFactor(s, 9, 14)).toBe(0);
  });

  it('shieldBallSpot is on the far side of the body from the nearest opponent; shieldLook faces him', () => {
    const s = shieldSetup();
    const out = { x: 99, z: 99 };
    expect(shieldBallSpot(s, 9, out)).toBe(false);
    expect(out).toEqual({ x: 99, z: 99 });
    startShield(s, 9);
    put(s, 14, 0, 2);
    expect(shieldBallSpot(s, 9, out)).toBe(true);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.z).toBeCloseTo(-BT.shieldBallDist, 12);
    shieldLook(s, 9);
    expect([s.players[9]!.lookAt, s.players[9]!.lookX, s.players[9]!.lookZ]).toEqual([1, 0, 2]);
    put(s, 14, 30, 0);
    expect(shieldBallSpot(s, 9, out)).toBe(false);
    shieldLook(s, 9);
    expect(s.players[9]!.lookAt).toBe(0);
  });

  it('the shielder moves at most shieldSpeedFraction of jog speed (backstop to SIM-04) and holds a challenger off', () => {
    const s = shieldSetup();
    startShield(s, 9);
    put(s, 14, 20, 0);
    put(s, 9, 0, 0, 6, 0);
    tick(s);
    const v = Math.hypot(s.players[9]!.vx, s.players[9]!.vz);
    const cap = BT.shieldSpeedBackstop * T_PLAYER.shieldSpeedFraction * T_PLAYER.jogFraction * s.attrs[9]!.topSpeed;
    expect(v).toBeCloseTo(cap, 9);
    // Only a backstop: never tighter than SIM-04's own SHIELD cap (shieldSpeedFraction of jog speed).
    expect(cap).toBeGreaterThanOrEqual(T_PLAYER.shieldSpeedFraction * maxSpeed(s, 9, false));
    expect(s.players[9]!.x).toBeLessThan(6 / 60); // this tick's excess displacement undone
    // Held off: a challenger of equal strength in the covered position takes the whole correction.
    const h = shieldSetup();
    startShield(h, 9);
    put(h, 14, 0.6, 0, -2, 0);
    tick(h);
    expect(h.players[9]!.x).toBeCloseTo(0, 9);
    expect(h.players[14]!.x).toBeGreaterThan(0.6);
    // A clearly stronger challenger is not held off: the shielder gives ground too.
    const w = shieldSetup();
    w.attrs[14]!.strength = 50 + BT.shieldStrengthBonus + 15;
    startShield(w, 9);
    put(w, 14, 0.6, 0, -2, 0);
    tick(w);
    expect(w.players[9]!.x).toBeLessThan(-0.01);
  });
});

describe('SIM-05 determinism and budget', () => {
  function crowd(seedShift: number): SimState {
    const s = world();
    for (let i = 0; i < NUM_SLOTS; i++) {
      put(s, i, 40 + (i % 5) * 0.45 + seedShift, -2 + Math.floor(i / 5) * 0.55, ((i * 7) % 5) - 2, ((i * 3) % 5) - 2);
      s.attrs[i]!.strength = 30 + ((i * 17) % 60);
      s.attrs[i]!.height = 168 + ((i * 11) % 30);
    }
    return s;
  }

  it('is deterministic: same state in, bit-identical state and events out (also from a clone)', () => {
    const a = crowd(0), b = crowd(0);
    const c = cloneState(a);
    const ea = createEventBuffer(), eb = createEventBuffer(), ec = createEventBuffer();
    for (let t = 0; t < 120; t++) {
      tick(a, ea); tick(b, eb); tick(c, ec);
      expect(ea.count).toBe(eb.count);
      for (let k = 0; k < ea.count; k++) expect(ea.get(k)).toEqual(eb.get(k));
    }
    expect(hashState(a)).toBe(hashState(b));
    expect(hashState(a)).toBe(hashState(c));
    for (let i = 0; i < NUM_SLOTS; i++) {
      expect(Object.is(a.players[i]!.x, c.players[i]!.x)).toBe(true);
      expect(Number.isFinite(a.players[i]!.x) && Number.isFinite(a.players[i]!.vz)).toBe(true);
    }
  });

  it('costs well under 0.1 ms per tick for 22 players in a pile', () => {
    const s = crowd(0);
    const ev = createEventBuffer();
    const jiggle = (t: number): void => {
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        p.x += (((t + i * 3) % 5) - 2) * 0.01;
        p.vx = (((t + i) % 7) - 3) * 0.5;
      }
    };
    let t = 0;
    for (; t < 5000; t++) { jiggle(t); ev.begin(t); bodyContactTick(s, ev); }
    // Many short windows, best one: robust to the scheduler pre-empting a loaded test machine.
    let best = Infinity;
    for (let rep = 0; rep < 40; rep++) {
      const n = 250;
      const t0 = performance.now();
      for (let k = 0; k < n; k++, t++) { jiggle(t); ev.begin(t); bodyContactTick(s, ev); }
      best = Math.min(best, (performance.now() - t0) / n);
    }
    expect(best, `${best.toFixed(4)} ms/tick`).toBeLessThan(0.1);
  });

  it('allocates nothing per tick (child process with --expose-gc)', () => {
    const code = `
      import './tools/lib/env.ts';
      import './src/sim/actions/dispatch.ts';
      const { makeScenario } = await import('./tests/harness/scenario.ts');
      const { bodyContactTick } = await import('./src/sim/players/bodies.ts');
      const { createEventBuffer } = await import('./src/sim/core/events.ts');
      const out = {};
      for (const [name, x0] of [['midfield', 10], ['goalLine', 52.2], ['slideAndEvents', -20]]) {
        const s = makeScenario({});
        for (let i = 0; i < 22; i++) {
          const p = s.players[i]; p.x = x0 - (i % 5) * 0.5; p.z = -2 + Math.floor(i / 5) * 0.6; p.vx = 2; p.isKeeper = 0;
        }
        const ev = createEventBuffer();
        const pile = (t) => {
          for (let i = 0; i < 22; i++) { const p = s.players[i]; p.x += ((t + i) % 3 - 1) * 0.004; p.vx = ((t + i) % 5) - 2; }
        };
        // Four head-on pairs pushing through each other every tick: slide-around and a BODY_CONTACT per pair.
        const headOn = (t) => {
          for (let k = 0; k < 4; k++) {
            const a = s.players[2 + k], b = s.players[13 + k];
            a.x = k * 5; a.z = 0.01 * (t % 3); b.x = k * 5 + 0.7; b.z = 0; a.vx = 3; a.vz = 0; b.vx = -3; b.vz = 0;
            a.moveMode = 2; a.tgtX = k * 5 + 10; a.tgtZ = 0; a.tgtSpeed = 6;
            b.moveMode = k % 2 === 0 ? 2 : 1; b.tgtX = k * 5 - 10; b.tgtZ = 0; b.tgtSpeed = 6; b.ix = -1; b.iz = 0;
          }
        };
        const run = (t) => {
          if (name === 'slideAndEvents') headOn(t);
          ev.begin(t); bodyContactTick(s, ev);
          if (name !== 'slideAndEvents') pile(t);
        };
        // Long warm-up, then the best of several windows (optimised code allocated mid-window is not per-tick garbage).
        let t = 0;
        for (; t < 30000; t++) run(t);
        let best = Infinity;
        for (let w = 0; w < 5; w++) {
          globalThis.gc(); const h0 = process.memoryUsage().heapUsed;
          const N = 20000;
          for (let k = 0; k < N; k++) run(t++);
          best = Math.min(best, (process.memoryUsage().heapUsed - h0) / N);
        }
        out[name] = best;
      }
      console.log(JSON.stringify(out));
    `;
    // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
    const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--no-concurrent-recompilation', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const b = JSON.parse(r.stdout.trim().split('\n').pop()!) as { midfield: number; goalLine: number; slideAndEvents: number };
    const msg = JSON.stringify(b);
    expect(b.midfield, msg).toBeLessThan(2); // GC noise only
    expect(b.goalLine, msg).toBeLessThan(2); // piled on the goal line: SIM-04 confinePlayer runs too
    expect(b.slideAndEvents, msg).toBeLessThan(2);
  }, 150_000);
});
