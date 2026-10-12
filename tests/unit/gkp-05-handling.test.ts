/**
 * [GKP-05] Keeper ball handling: canHandle (area, back-pass rule, released this possession), keeperPickUp,
 * release starts and the release solver's bands (launch level), handler end paths. Scenario-level behaviour
 * (6-second rule, hold box, user control, carries) lives in tests/scenario/gkp-05-*.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { MoveMode } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_GK } from '../../src/contracts/tuning';
import { endAction } from '../../src/sim/actions/dispatch';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick, recordTouch } from '../../src/sim/core/kick';
import {
  LOCAL_TUNING as L, canHandle, isBackPassTainted, isKeeperReleaseKind, keeperHeldTicks, keeperPickUp,
  keeperReleasePoint, releasedThisPossession, releaseWindupTicks, solveKeeperRelease, startKeeperRelease, throwHandler,
} from '../../src/sim/keeper/handling';
import { KEEPER, MATE, OPP, depth, keeperBall, keeperHolding, request, xAt } from './gkp-05-helpers';

const hyp = (x: number, y: number, z = 0): number => Math.sqrt(x * x + y * y + z * z);

describe('GKP-05 canHandle: who, where and when', () => {
  it('a keeper inside his own area with a loose ball there may handle it', () => {
    const s = keeperBall();
    expect(canHandle(s, KEEPER)).toBe(true);
  });

  it('outfield players, inactive keepers, the other keeper and bad slots may not', () => {
    const s = keeperBall();
    s.players[3]!.x = s.players[KEEPER]!.x; s.players[3]!.z = 1;
    expect(canHandle(s, 3)).toBe(false);
    expect(canHandle(s, 11)).toBe(false); // the other keeper: not his area
    expect(canHandle(s, -1)).toBe(false);
    expect(canHandle(s, 22)).toBe(false);
    expect(canHandle(s, 0.5)).toBe(false);
    s.players[KEEPER]!.active = 0;
    expect(canHandle(s, KEEPER)).toBe(false);
  });

  it('only while the ball is live (IN_PLAY / SHOOT_OUT / a restart already taken)', () => {
    const s = keeperBall();
    s.match.phase = MatchPhase.GOAL_KICK; s.match.restart.taken = 0;
    expect(canHandle(s, KEEPER)).toBe(false);
    s.match.restart.taken = 1;
    expect(canHandle(s, KEEPER)).toBe(true);
    s.match.phase = MatchPhase.SHOOT_OUT;
    expect(canHandle(s, KEEPER)).toBe(true);
    s.match.phase = MatchPhase.HALF_TIME;
    expect(canHandle(s, KEEPER)).toBe(false);
  });

  it('never a ball another player owns or holds', () => {
    const s = keeperBall();
    s.ball.owner = OPP;
    expect(canHandle(s, KEEPER)).toBe(false);
    s.ball.owner = 3;
    expect(canHandle(s, KEEPER)).toBe(false);
    s.ball.owner = KEEPER;
    expect(canHandle(s, KEEPER)).toBe(true);
  });

  it('respects the attack direction after the sides swap', () => {
    const s = keeperBall({ u: 4 });
    s.teams[0]!.dir = -1; s.teams[1]!.dir = 1;
    expect(canHandle(s, KEEPER)).toBe(false); // now his area is at +x
    s.players[KEEPER]!.x = -s.players[KEEPER]!.x; s.ball.x = -s.ball.x;
    expect(canHandle(s, KEEPER)).toBe(true);
  });
});

describe('GKP-05 glitch "Keeper: handles outside the area"', () => {
  it('ball outside the area: no handling even with the keeper inside it', () => {
    const s = keeperBall({ u: PENALTY_AREA_DEPTH - 0.3, bdx: 0.6 });
    expect(depth(s.ball.x)).toBeGreaterThan(PENALTY_AREA_DEPTH + BALL_RADIUS);
    expect(canHandle(s, KEEPER)).toBe(false);
  });

  it('ball touching the line from outside counts (lines belong to the area), beyond that it does not', () => {
    const s = keeperBall({ u: PENALTY_AREA_DEPTH - 0.4, bdx: 0.4 + BALL_RADIUS * 0.9 });
    expect(canHandle(s, KEEPER)).toBe(true);
    s.ball.x = xAt(PENALTY_AREA_DEPTH + BALL_RADIUS + 0.01);
    expect(canHandle(s, KEEPER)).toBe(false);
    s.ball.x = xAt(5); s.ball.z = PENALTY_AREA_HALF_WIDTH + BALL_RADIUS + 0.01;
    s.players[KEEPER]!.z = PENALTY_AREA_HALF_WIDTH - 0.2;
    expect(canHandle(s, KEEPER)).toBe(false);
  });

  it('keeper standing well outside his area (beyond the arm slack) cannot handle a ball just inside', () => {
    const s = keeperBall({ u: PENALTY_AREA_DEPTH + L.handleKeeperSlack + 0.3, bdx: -1.5 });
    expect(depth(s.ball.x)).toBeLessThan(PENALTY_AREA_DEPTH);
    expect(canHandle(s, KEEPER)).toBe(false);
    s.players[KEEPER]!.x = xAt(PENALTY_AREA_DEPTH + L.handleKeeperSlack - 0.1);
    expect(canHandle(s, KEEPER)).toBe(true);
  });

  it('a ball wholly over his goal line is not handled', () => {
    const s = keeperBall({ u: 0.3, bdx: -0.3 - BALL_RADIUS - 0.05 });
    expect(depth(s.ball.x)).toBeLessThan(-BALL_RADIUS);
    expect(canHandle(s, KEEPER)).toBe(false);
  });

  it('keeperPickUp refuses (state untouched) outside the area', () => {
    const s = keeperBall({ u: PENALTY_AREA_DEPTH + 2 });
    const ev = createEventBuffer(); ev.begin(s.tick);
    keeperPickUp(s, KEEPER, ev);
    expect(s.ball.heldBy).toBe(-1);
    expect(s.ball.owner).toBe(-1);
    expect(s.players[KEEPER]!.act).toBe(ActionKind.NONE);
    expect(ev.count).toBe(0);
  });
});

describe('GKP-05 back-pass rule', () => {
  function passed(kind: KickKind, by: number, team: number) {
    const s = keeperBall();
    const b = s.ball;
    b.lastKickBy = by; b.lastKickTeam = team; b.lastKickKind = kind; b.lastKickTick = 8;
    b.lastTouch = by; b.lastTouchTeam = team; b.lastTouchTick = 8;
    s.players[by]!.lastTouchTick = 8;
    return s;
  }

  it('no hands for a deliberate foot pass from a teammate (every foot-pass kind)', () => {
    for (const k of [KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.LOB_PASS, KickKind.THROUGH_GROUND,
      KickKind.CROSS, KickKind.CLEARANCE, KickKind.VOLLEY_PASS, KickKind.FREE_KICK_SHOT, KickKind.GOAL_KICK]) {
      const s = passed(k, 4, 0);
      expect(isBackPassTainted(s, KEEPER), KickKind[k]).toBe(true);
      expect(canHandle(s, KEEPER), KickKind[k]).toBe(false);
    }
  });

  it('hands allowed for a teammate header, chest touch or throw-in, and for any opponent kick', () => {
    for (const k of [KickKind.HEADER_PASS, KickKind.FIRST_TOUCH, KickKind.DEFLECTION, KickKind.THROW_IN]) {
      expect(canHandle(passed(k, 4, 0), KEEPER), KickKind[k]).toBe(true);
    }
    expect(canHandle(passed(KickKind.GROUND_PASS, OPP, 1), KEEPER)).toBe(true);
    expect(canHandle(passed(KickKind.SHOT_POWER, OPP, 1), KEEPER)).toBe(true);
  });

  it('an opponent touching the back-pass on the way lifts the rule', () => {
    const s = passed(KickKind.GROUND_PASS, 4, 0);
    s.tick = 20;
    recordTouch(s, OPP); // deflection off an opponent at tick 20
    expect(canHandle(s, KEEPER)).toBe(true);
  });

  it('another teammate touching it (not a deliberate kick) lifts the rule too', () => {
    const s = passed(KickKind.GROUND_PASS, 4, 0);
    s.tick = 20;
    recordTouch(s, 3);
    expect(canHandle(s, KEEPER)).toBe(true);
  });

  it('trapping a back-pass with his feet first does not make it handleable (no trap-then-pick-up loophole)', () => {
    const s = passed(KickKind.GROUND_PASS, 4, 0);
    s.tick = 20;
    recordTouch(s, KEEPER); // controlled with the feet
    s.ball.owner = KEEPER;
    expect(canHandle(s, KEEPER)).toBe(false);
    const ev = createEventBuffer(); ev.begin(s.tick);
    keeperPickUp(s, KEEPER, ev);
    expect(s.ball.heldBy).toBe(-1);
  });

  it('a kicker re-touching his own pass does not lift it', () => {
    const s = passed(KickKind.GROUND_PASS, 4, 0);
    s.tick = 20;
    recordTouch(s, 4);
    expect(canHandle(s, KEEPER)).toBe(false);
  });
});

describe('GKP-05 keeperPickUp', () => {
  it('ball into his hands: heldBy = owner = keeper, still, KEEPER_HANDS(1), GK_HOLD, ball at hands height in front', () => {
    const { s, ev } = keeperHolding();
    const b = s.ball;
    const p = s.players[KEEPER]!;
    expect(b.heldBy).toBe(KEEPER);
    expect(b.owner).toBe(KEEPER);
    expect([b.vx, b.vy, b.vz, b.sx, b.sy, b.sz]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(p.act).toBe(ActionKind.GK_HOLD);
    expect(p.actB).toBe(s.tick);
    expect(p.actDur).toBeGreaterThan(T_GK.maxHoldTicks);
    expect(b.y).toBeCloseTo(L.holdHeight, 6);
    expect(b.x - p.x).toBeCloseTo(L.holdAhead, 6);
    const evs = ev.toArray();
    const hands = evs.filter((e) => e.type === EventType.KEEPER_HANDS);
    expect(hands).toHaveLength(1);
    expect(hands[0]!.a).toBe(KEEPER);
    expect(hands[0]!.b).toBe(1);
    // A shot from the opponent: possession changes team.
    expect(evs.filter((e) => e.type === EventType.POSSESSION && e.a === 0 && e.b === KEEPER)).toHaveLength(1);
    expect(b.lastTouch).toBe(KEEPER);
    expect(b.shotBy).toBe(-1);
    expect(keeperHeldTicks(s, KEEPER)).toBe(0);
  });

  it('refuses a ball out of reach, a ball already held, and a back-pass (no events, nothing changes)', () => {
    const far = keeperBall({ bdx: L.pickUpReach + 0.5 });
    const ev = createEventBuffer(); ev.begin(far.tick);
    keeperPickUp(far, KEEPER, ev);
    expect(far.ball.heldBy).toBe(-1);
    const { s } = keeperHolding();
    const ev2 = createEventBuffer(); ev2.begin(s.tick);
    keeperPickUp(s, KEEPER, ev2);
    expect(ev2.count).toBe(0);
    expect(ev.count).toBe(0);
  });

  it('ends a running action first (e.g. a catch / dive that collected the ball)', () => {
    const s = keeperBall();
    const p = s.players[KEEPER]!;
    p.act = ActionKind.GK_CATCH; p.actT = 3; p.actDur = 20; p.moveMode = MoveMode.LOCKED;
    const ev = createEventBuffer(); ev.begin(s.tick);
    keeperPickUp(s, KEEPER, ev);
    expect(p.act).toBe(ActionKind.GK_HOLD);
    expect(p.actT).toBe(0);
    expect(p.moveMode).toBe(MoveMode.STOP);
  });
});

describe('GKP-05 startKeeperRelease', () => {
  it('needs the ball in his hands and a keeper release kind', () => {
    const s = keeperBall();
    const ev = createEventBuffer(); ev.begin(s.tick);
    expect(startKeeperRelease(s, KEEPER, KickKind.GK_THROW, request(), ev)).toBe(0);
    const h = keeperHolding().s;
    expect(startKeeperRelease(h, KEEPER, KickKind.GROUND_PASS, request(), ev)).toBe(0);
    expect(startKeeperRelease(h, 3, KickKind.GK_THROW, request(), ev)).toBe(0);
    expect(startKeeperRelease(h, KEEPER, KickKind.GK_THROW, request({ dirX: 1 }), ev)).toBe(1);
    // Already winding up: a second start is refused.
    expect(startKeeperRelease(h, KEEPER, KickKind.GK_DROP_KICK, request(), ev)).toBe(0);
  });

  it('maps kinds to GK_THROW / GK_KICK with the documented wind-up, movement locked, pickup tick kept', () => {
    for (const k of [KickKind.GK_THROW, KickKind.GK_DRIVEN_THROW, KickKind.GK_ROLL, KickKind.GK_DROP_KICK,
      KickKind.GK_DRIVEN_KICK, KickKind.GK_RELEASE]) {
      const { s } = keeperHolding();
      const pickup = s.players[KEEPER]!.actB;
      s.tick += 30;
      const ev = createEventBuffer(); ev.begin(s.tick);
      expect(startKeeperRelease(s, KEEPER, k, request({ dirX: 1, power: 0.5 }), ev)).toBe(1);
      const p = s.players[KEEPER]!;
      expect(isKeeperReleaseKind(k)).toBe(true);
      expect(p.act).toBe(k === KickKind.GK_DROP_KICK || k === KickKind.GK_DRIVEN_KICK ? ActionKind.GK_KICK : ActionKind.GK_THROW);
      expect(p.actKick).toBe(k);
      expect(p.actContact).toBe(releaseWindupTicks(k));
      expect(p.actDur).toBeGreaterThan(p.actContact);
      expect(p.moveMode).toBe(MoveMode.LOCKED);
      expect(p.actB).toBe(pickup);
      expect(s.ball.heldBy).toBe(KEEPER); // still in his hands during the wind-up
    }
  });

  it('a GK_THROW to a nearby teammate becomes a roll', () => {
    const { s } = keeperHolding({ mate: { x: xAt(4) + 7, z: 2 } });
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_THROW, request({ targetSlot: MATE }), ev);
    expect(s.players[KEEPER]!.actKick).toBe(KickKind.GK_ROLL);
  });

  it('ignores an opponent or self as the explicit target', () => {
    const { s } = keeperHolding();
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_THROW, request({ targetSlot: OPP, dirX: 1 }), ev);
    expect(s.players[KEEPER]!.actSlot).toBe(-1);
  });
});

describe('GKP-05 solveKeeperRelease: each kind launches inside its band', () => {
  const out = createKickLaunch();
  function launchFor(k: KickKind, dist: number, power: number, seed = 11, gkKicking = -1) {
    const { s } = keeperHolding({ seed, mate: { x: xAt(4) + dist, z: 3 } });
    s.players[MATE]!.vx = 0; s.players[MATE]!.vz = 0;
    if (gkKicking > 0) s.attrs[KEEPER]!.gkKicking = gkKicking;
    const ev = createEventBuffer(); ev.begin(s.tick);
    expect(startKeeperRelease(s, KEEPER, k, request({ targetSlot: MATE, power }), ev)).toBe(1);
    expect(solveKeeperRelease(s, KEEPER, out)).toBe(1);
    return { s, l: { ...out } };
  }

  it('GK_THROW (overarm): 14-22 m/s for targets 12-45 m, aimed at the receiver', () => {
    for (const d of [12, 18, 25, 32, 40, 45]) {
      for (const pw of [0, 0.5, 1]) {
        const { l } = launchFor(KickKind.GK_THROW, d, pw);
        const sp = hyp(l.vx, l.vy, l.vz);
        expect(l.kind).toBe(KickKind.GK_THROW);
        expect(sp, `d ${d} pw ${pw}`).toBeGreaterThanOrEqual(L.throwSpeedMin - 1e-9);
        expect(sp, `d ${d} pw ${pw}`).toBeLessThanOrEqual(L.throwSpeedMax + 1e-9);
        expect(l.target).toBe(MATE);
        expect(l.vx).toBeGreaterThan(0);
      }
    }
  });

  it('GK_DRIVEN_THROW: faster and flatter than GK_THROW to the same target', () => {
    for (const d of [15, 25, 35]) {
      const t = launchFor(KickKind.GK_THROW, d, 0.5).l;
      const ts = hyp(t.vx, t.vy, t.vz), tAng = t.vy / ts;
      const r = launchFor(KickKind.GK_DRIVEN_THROW, d, 0.5).l;
      const rs = hyp(r.vx, r.vy, r.vz), rAng = r.vy / rs;
      expect(r.kind).toBe(KickKind.GK_DRIVEN_THROW);
      expect(rs).toBeGreaterThan(ts);
      expect(rAng).toBeLessThan(tAng);
      expect(rs).toBeGreaterThanOrEqual(L.drivenThrowSpeedMin - 1e-9);
      expect(rs).toBeLessThanOrEqual(L.drivenThrowSpeedMax + 1e-9);
    }
  });

  it('GK_ROLL: along the ground at 8-14 m/s', () => {
    for (const d of [6, 12, 20, 30, 45]) {
      const { l } = launchFor(KickKind.GK_ROLL, d, 0.5);
      const sp = hyp(l.vx, l.vz);
      expect(l.vy).toBe(0);
      expect(sp, `d ${d}`).toBeGreaterThanOrEqual(L.rollSpeedMin - 1e-9);
      expect(sp, `d ${d}`).toBeLessThanOrEqual(L.rollSpeedMax + 1e-9);
    }
  });

  it('GK_DROP_KICK carries 50-60 m upfield (planned landing), more with power; GK_DRIVEN_KICK lower and flatter', () => {
    const near = launchFor(KickKind.GK_DROP_KICK, 80, 0).l;
    const nearCarry = hyp(near.tx - xAt(4), near.tz);
    const farL = launchFor(KickKind.GK_DROP_KICK, 80, 1).l;
    const farCarry = hyp(farL.tx - xAt(4), farL.tz);
    expect(farCarry).toBeGreaterThan(nearCarry);
    for (const pw of [0, 0.25, 0.5, 0.75, 1]) {
      const { l } = launchFor(KickKind.GK_DROP_KICK, 80, pw, 11, 99);
      const c = hyp(l.tx - xAt(4), l.tz);
      // The planned carry includes the kicking error (2% at gkKicking 99).
      expect(c, `pw ${pw}`).toBeGreaterThanOrEqual(L.dropKickRangeMin * (1 - L.kickDistErrBest) - 0.6);
      expect(c, `pw ${pw}`).toBeLessThanOrEqual(L.dropKickRangeMax * (1 + L.kickDistErrBest));
      const dk = launchFor(KickKind.GK_DRIVEN_KICK, 80, pw, 11, 99).l;
      const dropAng = l.vy / hyp(l.vx, l.vy, l.vz);
      const drivenAng = dk.vy / hyp(dk.vx, dk.vy, dk.vz);
      expect(drivenAng).toBeLessThan(dropAng);
      expect(hyp(dk.tx - xAt(4), dk.tz)).toBeLessThan(c);
    }
  });

  it('a short target still gets the drop kick minimum carry', () => {
    const { l } = launchFor(KickKind.GK_DROP_KICK, 15, 0.5);
    expect(hyp(l.tx - xAt(4), l.tz)).toBeGreaterThan(L.dropKickMinDist * (1 - L.kickDistErrWorst) - 1);
  });

  it('GK_RELEASE drops the ball at his feet: on the ground, gentle, no receiver', () => {
    const { s, l } = launchFor(KickKind.GK_RELEASE, 20, 0.5);
    expect(l.kind).toBe(KickKind.GK_RELEASE);
    expect(l.vy).toBe(0);
    expect(hyp(l.vx, l.vz)).toBeLessThan(1);
    expect(l.target).toBe(-1);
    const rp = { x: 0, y: 0, z: 0 };
    keeperReleasePoint(s, KEEPER, KickKind.GK_RELEASE, rp);
    expect(rp.y).toBe(BALL_RADIUS);
  });

  it('no receiver in the aim: aims along the stick at the power-implied distance', () => {
    const { s } = keeperHolding();
    for (let i = 1; i < 11; i++) { s.players[i]!.x = -40; s.players[i]!.z = -30; }
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_THROW, request({ dirX: 0.6, dirZ: 0.8, power: 1 }), ev);
    expect(solveKeeperRelease(s, KEEPER, out)).toBe(1);
    expect(out.target).toBe(-1);
    expect(out.vz).toBeGreaterThan(0);
    expect(out.vx).toBeGreaterThan(0);
  });

  it('is deterministic: same state -> same launch; the RNG advances by a fixed count', () => {
    const a = launchFor(KickKind.GK_THROW, 25, 0.6, 5);
    const la = { ...a.l };
    const b = launchFor(KickKind.GK_THROW, 25, 0.6, 5);
    expect({ ...b.l }).toEqual(la);
    expect(b.s.rng).toEqual(a.s.rng);
  });

  it('returns 0 for a non-keeper kind / bad slot', () => {
    const { s } = keeperHolding();
    expect(solveKeeperRelease(s, KEEPER, out)).toBe(0); // GK_HOLD: no release kind
    expect(solveKeeperRelease(s, -1, out)).toBe(0);
  });
});

describe('GKP-05 drop at feet, then no re-pick-up', () => {
  it('after GK_RELEASE he owns the ball at his feet but can never pick it up again until another player touches it', () => {
    const { s } = keeperHolding();
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_RELEASE, request(), ev);
    const out = createKickLaunch();
    solveKeeperRelease(s, KEEPER, out);
    applyKick(s, KEEPER, out, 0, ev);
    expect(s.ball.heldBy).toBe(-1);
    expect(releasedThisPossession(s, KEEPER)).toBe(true);
    expect(canHandle(s, KEEPER)).toBe(false);
    s.tick += 5;
    recordTouch(s, KEEPER); // dribbles it
    expect(canHandle(s, KEEPER)).toBe(false);
    keeperPickUp(s, KEEPER, ev);
    expect(s.ball.heldBy).toBe(-1);
    s.tick += 5;
    recordTouch(s, OPP); // an opponent pokes it
    expect(canHandle(s, KEEPER)).toBe(true);
  });

  it('a skill touch of his own after the drop does not reset the rule (no 6-second reset)', () => {
    const { s } = keeperHolding();
    const ev = createEventBuffer(); ev.begin(s.tick);
    const l = createKickLaunch();
    l.kind = KickKind.GK_RELEASE;
    applyKick(s, KEEPER, l, 0, ev);
    s.tick += 3;
    l.kind = KickKind.KNOCK_ON; l.vx = 3;
    applyKick(s, KEEPER, l, 0, ev);
    expect(canHandle(s, KEEPER)).toBe(false);
  });

  it('his own parry / punch / tip does not stop him catching the rebound', () => {
    for (const k of [KickKind.GK_PARRY, KickKind.GK_PUNCH, KickKind.GK_TIP, KickKind.DEFLECTION]) {
      const s = keeperBall();
      s.tick = 30;
      const ev = createEventBuffer(); ev.begin(s.tick);
      const l = createKickLaunch();
      l.kind = k;
      applyKick(s, KEEPER, l, 0, ev);
      expect(canHandle(s, KEEPER), KickKind[k]).toBe(true);
    }
  });
});

describe('GKP-05 release wind-up', () => {
  it('a power charge nobody ends (lost power-bar owner) is capped and the ball still leaves his hands', () => {
    const { s } = keeperHolding({ mate: { x: xAt(4) + 25, z: 0 } });
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_THROW, request({ targetSlot: MATE, power: 0.4 }), ev);
    const p = s.players[KEEPER]!;
    p.actCharging = 1;
    const contact = p.actContact;
    let released = -1;
    for (let i = 0; i < 200 && released < 0; i++) {
      s.tick++;
      ev.begin(s.tick);
      p.actT++;
      throwHandler.update(s, KEEPER, ev);
      if (s.ball.heldBy === -1) released = p.actT;
    }
    expect(released).toBe(contact + L.chargeCapTicks);
    expect(s.ball.lastKickKind).toBe(KickKind.GK_THROW);
  });

  it('turns toward the aim and lifts the ball to the release point over the wind-up', () => {
    const { s } = keeperHolding({ mate: { x: xAt(4), z: 20 } }); // receiver square to his left
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_THROW, request({ targetSlot: MATE, power: 0.5 }), ev);
    const p = s.players[KEEPER]!;
    for (let t = 1; t < p.actContact; t++) {
      s.tick++; ev.begin(s.tick); p.actT = t;
      throwHandler.update(s, KEEPER, ev);
    }
    expect(p.fz).toBeGreaterThan(0.95);
    expect(s.ball.heldBy).toBe(KEEPER);
    expect(s.ball.y).toBeGreaterThan(L.holdHeight + (L.throwReleaseHeight - L.holdHeight) * 0.8);
  });
});

describe('GKP-05 handler end paths never leave the ball stuck in his hands', () => {
  it('an interrupted GK_HOLD (rules / watchdog endAction) lets the ball drop', () => {
    const { s } = keeperHolding();
    endAction(s, KEEPER, 1);
    const p = s.players[KEEPER]!;
    expect(p.act).toBe(ActionKind.NONE);
    expect(s.ball.heldBy).toBe(-1);
    expect(s.ball.owner).toBe(-1);
    expect(s.ball.grounded).toBe(0); // falls from his hands
    expect(p.moveMode).not.toBe(MoveMode.LOCKED);
  });

  it('an interrupted release wind-up drops the ball too', () => {
    const { s } = keeperHolding();
    const ev = createEventBuffer(); ev.begin(s.tick);
    startKeeperRelease(s, KEEPER, KickKind.GK_DROP_KICK, request({ dirX: 1 }), ev);
    endAction(s, KEEPER, 1);
    expect(s.ball.heldBy).toBe(-1);
    expect(s.players[KEEPER]!.act).toBe(ActionKind.NONE);
    expect(s.players[KEEPER]!.moveMode).toBe(MoveMode.STOP);
  });
});
