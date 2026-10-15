/**
 * [GKP-05] Keeper with the ball, stepped through the real pipeline: hold box (never over his own line, never out of
 * the area), walking cap, the 6-second rule for humans and AI (incl. a charged release cut at the hard limit), user
 * control of pick-up / throws / kicks / drop through the resolver, carries of each release kind, drop then no
 * re-pick-up, determinism. Glitch-list regressions are named "glitch: ...".
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_GK } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import {
  LOCAL_TUNING as L, canHandle, isKeeperReleaseKind, keeperPickUp, startKeeperRelease,
} from '../../src/sim/keeper/handling';
import { makeScenario, runTicks } from '../harness/scenario';
import { KEEPER, MATE, depth, eventsOf, keeperBall, keeperHolding, request, xAt } from '../unit/gkp-05-helpers';

const HUMAN = [{ side: 0, slot: KEEPER }];
const AXIS = 127;

/** Per-tick inputs for P1 from a function of the tick index since the start (1-based). */
function p1(fn: (i: number, s: SimState) => Partial<InputFrame>) {
  let i = 0;
  return (_t: number, s: SimState, out: InputFrame[]) => { i++; Object.assign(out[0]!, fn(i, s)); };
}

function inArea(x: number, z: number, slack: number): boolean {
  const u = depth(x);
  return u >= -slack && u <= PENALTY_AREA_DEPTH + slack && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH + slack;
}

/** Release events of the keeper: KEEPER_HANDS(0) and the KICK, with the ticks. */
function releaseOf(events: readonly SimEvent[]): { hands: SimEvent | undefined; kick: SimEvent | undefined } {
  const hands = events.find((e) => e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 0);
  const kick = events.find((e) => e.type === EventType.KICK && e.a === KEEPER);
  return { hands, kick };
}

describe('GKP-05 hold box', () => {
  it('glitch: Keeper carries it over his own line (stick held toward his goal for 5 s)', () => {
    for (const mz of [0, 90, -90]) {
      const { s } = keeperHolding({ u: 1.2, z: mz / 20, humans: HUMAN });
      let minKeeper = 1e9, minBall = 1e9;
      const ev = runTicks(s, T_GK.autoReleaseTicks - 5, p1(() => ({ mx: -AXIS, mz })), {
        check: 'all',
        until: (st) => {
          minKeeper = Math.min(minKeeper, depth(st.players[KEEPER]!.x));
          if (st.ball.heldBy === KEEPER) minBall = Math.min(minBall, depth(st.ball.x));
          return false;
        },
      });
      expect(s.ball.heldBy).toBe(KEEPER);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(eventsOf(ev, EventType.GOAL)).toHaveLength(0);
      expect(minKeeper).toBeGreaterThanOrEqual(L.holdLineMargin - 1e-9);
      expect(minBall).toBeGreaterThan(BALL_RADIUS);
      expect(s.ball.cross).toBe(0);
    }
  });

  it('glitch: Keeper carries it over his own line (away keeper, and after the sides swap)', () => {
    for (const swapped of [false, true]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 5, humans: [{ side: 1, slot: 11 }] });
      if (swapped) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
      const dir = s.teams[1]!.dir;
      const own = -dir * HALF_LENGTH; // his goal line
      const k = s.players[11]!;
      k.x = own + dir * 1.5; k.z = 2; k.fx = dir; k.fz = 0; k.vx = 0; k.vz = 0;
      const b = s.ball;
      b.x = k.x + dir * 0.4; b.z = 2; b.y = BALL_RADIUS; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0;
      b.lastKickBy = 4; b.lastKickTeam = 0; b.lastKickKind = KickKind.SHOT_NORMAL; b.lastTouch = 4; b.lastTouchTeam = 0;
      const ev0 = createEventBuffer(); ev0.begin(s.tick);
      keeperPickUp(s, 11, ev0);
      expect(s.ball.heldBy).toBe(11);
      let minK = 1e9, minB = 1e9;
      const ev = runTicks(s, 300, (_t, _st, out) => { out[1]!.mx = -dir * AXIS; out[1]!.mz = 40; }, {
        check: 'all',
        until: (st) => {
          minK = Math.min(minK, dir * st.players[11]!.x + HALF_LENGTH);
          if (st.ball.heldBy === 11) minB = Math.min(minB, dir * st.ball.x + HALF_LENGTH);
          return false;
        },
      });
      expect(s.ball.heldBy).toBe(11);
      expect(eventsOf(ev, EventType.GOAL)).toHaveLength(0);
      expect(minK).toBeGreaterThanOrEqual(L.holdLineMargin - 1e-9);
      expect(minB).toBeGreaterThan(BALL_RADIUS);
    }
  });

  it('caught on his line facing his own goal: the ball is never placed behind the line', () => {
    const { s } = keeperHolding({ u: 0.05, humans: HUMAN });
    const k = s.players[KEEPER]!;
    k.fx = -1; k.fz = 0;
    let minBall = 1e9;
    runTicks(s, 60, p1(() => ({ mx: -AXIS })), { check: 'all', until: (st) => { minBall = Math.min(minBall, depth(st.ball.x)); return false; } });
    expect(minBall).toBeGreaterThan(BALL_RADIUS);
    expect(depth(k.x)).toBeGreaterThanOrEqual(L.holdLineMargin - 1e-9);
  });

  it('glitch: Keeper handles outside the area (walks the ball to the edge of the box and pushes on)', () => {
    for (const [mx, mz, z0, u0] of [[AXIS, 0, 0, 12], [0, AXIS, 15, 6], [0, -AXIS, -15, 6], [90, 90, 16, 13]] as const) {
      const { s } = keeperHolding({ u: u0, z: z0, humans: HUMAN });
      let ok = true;
      let maxSpeed = 0;
      runTicks(s, 300, p1(() => ({ mx, mz })), {
        check: 'all',
        until: (st) => {
          const p = st.players[KEEPER]!;
          if (st.ball.heldBy === KEEPER) {
            if (!inArea(p.x, p.z, 0) || !inArea(st.ball.x, st.ball.z, 0)) ok = false;
            maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vz));
          }
          return false;
        },
      });
      expect(ok, `${mx},${mz}`).toBe(true);
      expect(s.ball.heldBy).toBe(KEEPER);
      expect(maxSpeed).toBeLessThanOrEqual(L.holdWalkSpeed + 1e-6);
      const p = s.players[KEEPER]!;
      expect(depth(p.x)).toBeLessThanOrEqual(PENALTY_AREA_DEPTH - L.holdEdgeMargin + 1e-9);
      expect(Math.abs(p.z)).toBeLessThanOrEqual(PENALTY_AREA_HALF_WIDTH - L.holdEdgeMargin + 1e-9);
    }
  });

  it('a catch at the edge of the box is eased back inside, the ball stays in his hands in front of him', () => {
    const { s } = keeperHolding({ u: PENALTY_AREA_DEPTH + 0.5, bdx: -0.4, humans: HUMAN });
    expect(s.ball.heldBy).toBe(KEEPER);
    runTicks(s, 40, undefined, { check: 'all' });
    const p = s.players[KEEPER]!;
    expect(depth(p.x)).toBeLessThanOrEqual(PENALTY_AREA_DEPTH - L.holdEdgeMargin + 1e-9);
    expect(s.ball.y).toBeCloseTo(L.holdHeight, 6);
    expect(Math.hypot(s.ball.x - p.x, s.ball.z - p.z)).toBeLessThan(L.holdAhead + 0.1);
  });

  it('the ball follows him at hands height while he walks', () => {
    const { s } = keeperHolding({ u: 6, humans: HUMAN });
    runTicks(s, 90, p1(() => ({ mz: AXIS })), {
      until: (st) => {
        const p = st.players[KEEPER]!;
        expect(st.ball.y).toBeCloseTo(L.holdHeight, 6);
        expect(Math.hypot(st.ball.x - p.x, st.ball.z - p.z)).toBeLessThan(L.holdAhead + L.holdWalkSpeed / 60 + 1e-6);
        return false;
      },
    });
    expect(s.players[KEEPER]!.z).toBeGreaterThan(1.5);
  });
});

describe('GKP-05 6-second rule', () => {
  it('glitch: Keeper holds the ball forever (human who does nothing: automatic release by 6 s)', () => {
    const { s } = keeperHolding({ humans: HUMAN, mate: { x: xAt(4) + 22, z: 6 } });
    const pickup = s.tick;
    let heldAtAuto = -1;
    const ev = runTicks(s, T_GK.maxHoldTicks + 30, undefined, {
      check: 'all',
      until: (st) => { if (st.tick - pickup === T_GK.autoReleaseTicks - 1) heldAtAuto = st.ball.heldBy; return false; },
    });
    expect(heldAtAuto).toBe(KEEPER); // not released before the auto-release deadline
    const { hands, kick } = releaseOf(ev);
    expect(hands).toBeDefined();
    expect(kick).toBeDefined();
    expect(hands!.tick - pickup).toBeLessThanOrEqual(T_GK.maxHoldTicks);
    expect(hands!.tick - pickup).toBeGreaterThanOrEqual(T_GK.autoReleaseTicks);
    expect(isKeeperReleaseKind(kick!.b)).toBe(true);
    expect(kick!.b).not.toBe(KickKind.GK_RELEASE);
  });

  it('glitch: Keeper holds the ball forever (AI keeper, bot v bot): released within 6 s', () => {
    const { s } = keeperHolding({ mate: { x: xAt(4) + 25, z: -8 } });
    const pickup = s.tick;
    const ev = runTicks(s, T_GK.maxHoldTicks + 30, undefined, { check: 'all' });
    const { hands, kick } = releaseOf(ev);
    expect(hands).toBeDefined();
    expect(hands!.tick - pickup).toBeLessThanOrEqual(T_GK.maxHoldTicks);
    expect(isKeeperReleaseKind(kick!.b)).toBe(true);
    expect(s.ball.heldBy).toBe(-1);
  });

  it('the automatic release goes to the nearest open teammate', () => {
    const { s } = keeperHolding({ humans: HUMAN, mate: { x: xAt(4) + 20, z: 10 } });
    // Mark the other teammates tightly so MATE is the open one.
    for (let i = 1; i < 11; i++) {
      if (i === MATE) continue;
      s.players[i]!.x = xAt(40); s.players[i]!.z = -30 + i * 2;
      const o = 11 + i;
      s.players[o]!.x = s.players[i]!.x + 1; s.players[o]!.z = s.players[i]!.z;
    }
    s.tick = 10 + T_GK.autoReleaseTicks - 2;
    s.players[KEEPER]!.actB = 10;
    let target = -2;
    runTicks(s, 60, undefined, {
      until: (st, evs) => {
        if (evs.some((e) => e.type === EventType.KICK && e.a === KEEPER)) { target = st.ball.passTarget; return true; }
        return false;
      },
    });
    expect(target).toBe(MATE);
  });

  it('a charged release that is never let go is cut short at the hard limit', () => {
    const { s } = keeperHolding({ humans: HUMAN, mate: { x: xAt(4) + 25, z: 0 } });
    const pickup = s.tick;
    const press = T_GK.maxHoldTicks - 20; // press PASS 20 ticks before the limit and keep holding it
    const ev = runTicks(s, T_GK.maxHoldTicks + 30, p1((i) => (i >= press ? { buttons: Btn.PASS, mx: AXIS } : {})), { check: 'all' });
    const { hands, kick } = releaseOf(ev);
    expect(hands).toBeDefined();
    expect(hands!.tick - pickup).toBeLessThanOrEqual(T_GK.maxHoldTicks);
    expect(kick!.b === KickKind.GK_THROW || kick!.b === KickKind.GK_ROLL || kick!.b === KickKind.GK_DROP_KICK).toBe(true);
  });

  it('a release wind-up started on the last tick still lets go by the limit', () => {
    const { s } = keeperHolding({ mate: { x: xAt(4) + 30, z: 0 } });
    const pickup = s.tick;
    s.tick = pickup + T_GK.maxHoldTicks - 3;
    const ev0 = createEventBuffer(); ev0.begin(s.tick);
    expect(startKeeperRelease(s, KEEPER, KickKind.GK_DROP_KICK, request({ targetSlot: MATE }), ev0)).toBe(1);
    const ev = runTicks(s, 30, undefined, { check: 'all' });
    expect(releaseOf(ev).hands!.tick - pickup).toBeLessThanOrEqual(T_GK.maxHoldTicks);
  });
});

describe('GKP-05 user control through the resolver (section 10 keeper table)', () => {
  function pressed(fn: (i: number) => Partial<InputFrame>, ticks = 60, mate = { x: xAt(4) + 24, z: 0 }) {
    const { s } = keeperHolding({ humans: HUMAN, mate });
    const ev = runTicks(s, ticks, p1(fn), { check: 'all' });
    return { s, ev, kick: releaseOf(ev).kick };
  }

  it('PASS throws to the teammate the stick points at', () => {
    const { kick, s } = pressed((i) => (i <= 4 ? { buttons: Btn.PASS, mx: AXIS } : { mx: AXIS }));
    expect(kick?.b).toBe(KickKind.GK_THROW);
    expect(s.ball.lastKickKind).toBe(KickKind.GK_THROW);
  });

  it('R1 + PASS is a driven throw', () => {
    const { kick } = pressed((i) => (i === 1 ? { buttons: Btn.MOD_R } : i <= 4 ? { buttons: Btn.MOD_R | Btn.PASS, mx: AXIS } : {}));
    expect(kick?.b).toBe(KickKind.GK_DRIVEN_THROW);
  });

  it('SHOOT is a drop kick, R1 + LOB a driven kick', () => {
    expect(pressed((i) => (i <= 4 ? { buttons: Btn.SHOOT, mx: AXIS } : {})).kick?.b).toBe(KickKind.GK_DROP_KICK);
    expect(pressed((i) => (i === 1 ? { buttons: Btn.MOD_R } : i <= 4 ? { buttons: Btn.MOD_R | Btn.LOB, mx: AXIS } : {})).kick?.b)
      .toBe(KickKind.GK_DRIVEN_KICK);
  });

  it('THROUGH drops the ball at his feet: he owns it on the ground, no longer in his hands', () => {
    const { kick, s } = pressed((i) => (i <= 3 ? { buttons: Btn.THROUGH } : {}), 30);
    expect(kick?.b).toBe(KickKind.GK_RELEASE);
    expect(s.ball.heldBy).toBe(-1);
    expect(s.ball.owner === KEEPER || Math.hypot(s.ball.x - s.players[KEEPER]!.x, s.ball.z - s.players[KEEPER]!.z) < 1.5).toBe(true);
    expect(s.ball.y).toBeLessThan(0.2);
  });

  it('holding PASS charges the power bar: a longer hold throws harder', () => {
    const tap = pressed((i) => (i <= 2 ? { buttons: Btn.PASS, mx: AXIS } : { mx: AXIS }), 60, { x: xAt(4) + 30, z: 0 });
    const hold = pressed((i) => (i <= 40 ? { buttons: Btn.PASS, mx: AXIS } : { mx: AXIS }), 90, { x: xAt(4) + 30, z: 0 });
    expect(tap.kick).toBeDefined();
    expect(hold.kick).toBeDefined();
    expect(hold.kick!.c).toBeGreaterThan(tap.kick!.c);
    expect(hold.kick!.tick).toBeGreaterThan(tap.kick!.tick);
  });

  it('R1 picks the ball up at his feet inside his area', () => {
    const s = keeperBall({ humans: HUMAN });
    s.ball.owner = KEEPER;
    const ev = runTicks(s, 10, p1((i) => (i <= 3 ? { buttons: Btn.MOD_R } : {})), { check: 'all' });
    expect(s.ball.heldBy).toBe(KEEPER);
    expect(s.players[KEEPER]!.act).toBe(ActionKind.GK_HOLD);
    expect(eventsOf(ev, EventType.KEEPER_HANDS, KEEPER).filter((e) => e.b === 1)).toHaveLength(1);
  });

  it('glitch: Keeper handles outside the area (R1 with the ball at his feet outside the box does nothing)', () => {
    const s = keeperBall({ humans: HUMAN, u: PENALTY_AREA_DEPTH + 3 });
    s.ball.owner = KEEPER;
    const ev = runTicks(s, 10, p1((i) => (i <= 3 ? { buttons: Btn.MOD_R } : {})), { check: 'all' });
    expect(s.ball.heldBy).toBe(-1);
    expect(eventsOf(ev, EventType.KEEPER_HANDS)).toHaveLength(0);
  });

  it('drop then no re-pick-up: THROUGH, then R1 at once and later never puts the ball back in his hands', () => {
    const { s } = keeperHolding({ humans: HUMAN });
    const ev = runTicks(s, 60, p1((i) => (i <= 3 ? { buttons: Btn.THROUGH } : (i >= 15 && i <= 17) || (i >= 40 && i <= 42) ? { buttons: Btn.MOD_R } : {})), { check: 'all' });
    expect(eventsOf(ev, EventType.KEEPER_HANDS, KEEPER).filter((e) => e.b === 1)).toHaveLength(0);
    expect(s.ball.heldBy).toBe(-1);
    expect(canHandle(s, KEEPER)).toBe(false);
  });
});

describe('GKP-05 carries through the real ball physics', () => {
  /** Start a release toward MATE at dist (power), run until the first bounce; carry from the release point. */
  function carry(k: KickKind, dist: number, power: number, gk = 99) {
    const { s } = keeperHolding({ mate: { x: xAt(4) + dist, z: 0 } });
    s.attrs[KEEPER]!.gkKicking = gk; s.attrs[KEEPER]!.gkHandling = gk;
    const ev0 = createEventBuffer(); ev0.begin(s.tick);
    expect(startKeeperRelease(s, KEEPER, k, request({ targetSlot: MATE, power }), ev0)).toBe(1);
    let x0 = NaN, z0 = 0, land = -1, apex = 0, kicked = false, order = '';
    runTicks(s, 300, undefined, {
      until: (st, evs) => {
        for (const e of evs) {
          if (e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 0) order += 'H';
          if (e.type === EventType.KICK && e.a === KEEPER) { order += 'K'; kicked = true; x0 = st.ball.px; z0 = st.ball.pz; }
        }
        if (kicked) apex = Math.max(apex, st.ball.y);
        // [QF-11] Since QF-9's lofted receiver the mate often runs in and meets a short throw before it bounces: that
        // counts as landing at the receiver (land = the target distance); otherwise the first bounce ends the flight.
        if (kicked && st.ball.lastTouch === MATE) { land = dist; return true; }
        if (kicked && evs.some((e) => e.type === EventType.BOUNCE)) { land = Math.hypot(st.ball.x - x0, st.ball.z - z0); return true; }
        return false;
      },
    });
    return { land, apex, order, mate: Math.hypot(s.players[MATE]!.x - x0, s.players[MATE]!.z - z0) };
  }

  it('throws land at the receiver (12-35 m) and emit KEEPER_HANDS(0) then KICK', () => {
    for (const d of [14, 22, 30, 35]) {
      const r = carry(KickKind.GK_THROW, d, 0.5);
      expect(r.order).toBe('HK');
      expect(Math.abs(r.land - d), `d ${d}: ${r.land}`).toBeLessThan(2.5);
      const dr = carry(KickKind.GK_DRIVEN_THROW, d, 0.5);
      expect(Math.abs(dr.land - d), `driven d ${d}: ${dr.land}`).toBeLessThan(2.5);
      expect(dr.apex).toBeLessThan(r.apex);
    }
  });

  it('drop kick lands 50-60 m upfield; the driven kick flies lower', () => {
    for (const pw of [0.2, 0.5, 0.8]) {
      const r = carry(KickKind.GK_DROP_KICK, 80, pw);
      expect(r.land, `pw ${pw}`).toBeGreaterThanOrEqual(L.dropKickRangeMin - 1.5);
      expect(r.land, `pw ${pw}`).toBeLessThanOrEqual(L.dropKickRangeMax + 1.5);
      const d = carry(KickKind.GK_DRIVEN_KICK, 80, pw);
      expect(d.apex).toBeLessThan(r.apex * 0.6);
      expect(d.land).toBeGreaterThanOrEqual(L.drivenKickRangeMin - 1.5);
      expect(d.land).toBeLessThanOrEqual(L.drivenKickRangeMax + 1.5);
    }
  });

  it('a roll never leaves the ground', () => {
    const r = carry(KickKind.GK_ROLL, 18, 0.5);
    expect(r.apex).toBeLessThan(BALL_RADIUS + 0.01);
  });
});

describe('GKP-05 determinism', () => {
  function scripted(seed: number) {
    const { s } = keeperHolding({ seed, humans: HUMAN, mate: { x: xAt(4) + 26, z: 8 } });
    const ev = runTicks(s, 260, p1((i) => (i < 120 ? { mx: 60, mz: 40 } : i < 150 ? { buttons: Btn.PASS, mx: AXIS, mz: 30 } : {})));
    return { s, ev };
  }

  it('same seed and inputs: identical hash and events', () => {
    const a = scripted(21);
    const b = scripted(21);
    expect(hashState(b.s)).toBe(hashState(a.s));
    expect(b.ev).toEqual(a.ev);
    expect(releaseOf(a.ev).kick).toBeDefined();
  });

  it('a clone taken mid-hold continues bit-identically', () => {
    const { s } = keeperHolding({ seed: 4, mate: { x: xAt(4) + 26, z: -5 } });
    // [QF-2] Mid-hold = inside GKP-04's first wait (0.9 s); with TAI-09's lanes live the keeper throws to the open
    // mate at ~1.5 s, so the old clone point (2.5 s) came after the release.
    runTicks(s, 40);
    expect(s.ball.heldBy).toBe(KEEPER);
    const c = cloneState(s);
    const ea = runTicks(s, 260);
    const eb = runTicks(c, 260);
    expect(hashState(c)).toBe(hashState(s));
    expect(eb).toEqual(ea);
    expect(releaseOf(ea).hands).toBeDefined();
  });
});
