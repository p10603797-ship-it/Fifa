/**
 * [SIM-11] The SHOT action driven through the real action dispatcher: wind-up (power shot longer), charging and its
 * backstop, low driven conversion (markLowDriven), fake-shot interruption (SIM-13 startFake), dispossession / whiffs,
 * first-time ground shots, movement capping and follow-through, start refusals, set-piece shots, and a human SHOOT
 * press through the full pipeline (determinism).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AssistLevel, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_PASS, T_SHOT } from '../../src/contracts/tuning';
import { actionsTick, endAction } from '../../src/sim/actions/dispatch';
import { ballStepTick } from '../../src/sim/ball/contact';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { LOCAL_TUNING as LT, markLowDriven, startShot } from '../../src/sim/kicks/shot';
import { startFake } from '../../src/sim/kicks/skills';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import {
  DEF, giveBall, GX, KEEPER, peakBefore, place, shootScene, SHOOTER, shotReq, skill, type ShotOpts,
} from '../unit/sim-11-helpers';

const W = T_SHOT.windup;
const PW = T_SHOT.powerShotWindup;
const REC = T_SHOT.contact + T_SHOT.recovery;

interface Step { t: number; events: SimEvent[] }

/**
 * Advance the action stage only (no locomotion / contacts): `before(t, s)` runs ahead of each actionsTick (the
 * resolver's slot in the pipeline); `ballPhysics` also steps the ball after it. Returns the events per call.
 */
function actTicks(s: SimState, n: number, before?: (t: number, s: SimState) => void, ballPhysics = false): Step[] {
  const ev = createEventBuffer();
  const out: Step[] = [];
  for (let t = 1; t <= n; t++) {
    s.tick++;
    ev.begin(s.tick);
    if (before) before(t, s);
    actionsTick(s, ev);
    if (ballPhysics) ballStepTick(s.ball, null);
    out.push({ t, events: ev.toArray() });
  }
  return out;
}

function kickTicks(steps: Step[], slot = SHOOTER): number[] {
  const r: number[] = [];
  for (const st of steps) for (const e of st.events) if (e.type === EventType.KICK && e.a === slot) r.push(st.t);
  return r;
}

function eventOf(steps: Step[], type: EventType): SimEvent | undefined {
  for (const st of steps) for (const e of st.events) if (e.type === type) return e;
  return undefined;
}

function start(s: SimState, kind: KickKind = KickKind.SHOT_NORMAL, o: ShotOpts = {}): void {
  expect(startShot(s, SHOOTER, kind, shotReq(o), NULL_SINK)).toBe(1);
}

// ---------------------------------------------------------------- timing

describe('SIM-11 SHOT action timing', () => {
  it('contacts at T_SHOT.windup (KICK + SHOT events, ball.shotBy), recovers, then frees the player', () => {
    const s = shootScene(36, 0);
    start(s, KickKind.SHOT_NORMAL, { power: 0.8 });
    const p = s.players[SHOOTER]!;
    expect(p.act).toBe(ActionKind.SHOT);
    expect(p.actContact).toBe(W);
    const steps = actTicks(s, W + REC + 2, undefined, true);
    expect(kickTicks(steps)).toEqual([W]);
    const k = eventOf(steps, EventType.KICK)!;
    expect(k.b).toBe(KickKind.SHOT_NORMAL);
    expect(k.c).toBeCloseTo(0.8, 9);
    const sh = eventOf(steps, EventType.SHOT)!;
    expect(sh.a).toBe(SHOOTER);
    expect(s.ball.shotBy).toBe(SHOOTER);
    expect(s.ball.shotOnTarget).toBe(sh.b);
    expect(s.ball.owner).toBe(-1);
    expect(s.ball.vx).toBeGreaterThan(15);
    expect(p.act).toBe(ActionKind.NONE);
    const freeAt = steps.findIndex((st) => st.t >= W && s.players[SHOOTER]!.act === ActionKind.NONE);
    expect(freeAt).toBeGreaterThanOrEqual(0);
  });

  it('the action ends exactly at wind-up + contact + recovery', () => {
    const s = shootScene(36, 0);
    start(s);
    const p = s.players[SHOOTER]!;
    let endT = -1;
    actTicks(s, W + REC + 3, (t) => { if (endT < 0 && t > 1 && p.act === ActionKind.NONE) endT = t - 1; });
    expect(endT).toBe(W + REC);
  });

  it('power shot wind-up is longer: contact at T_SHOT.powerShotWindup', () => {
    const s = shootScene(36, 0);
    start(s, KickKind.SHOT_POWER, { power: 1 });
    const steps = actTicks(s, PW + 4);
    expect(kickTicks(steps)).toEqual([PW]);
    expect(eventOf(steps, EventType.KICK)!.b).toBe(KickKind.SHOT_POWER);
    expect(PW).toBeGreaterThan(W);
  });

  it('charging holds the contact until release and uses the power the resolver charged', () => {
    const s = shootScene(36, 0);
    start(s, KickKind.SHOT_NORMAL, { power: 0, charging: 1 });
    const p = s.players[SHOOTER]!;
    const steps = actTicks(s, 40, (t) => {
      if (p.actCharging === 1) p.actPower = Math.min(1, t / 40);
      if (t === 24) p.actCharging = 0; // released
    });
    expect(kickTicks(steps)).toEqual([24]);
    expect(eventOf(steps, EventType.KICK)!.c).toBeCloseTo(24 / 40, 9);
  });

  it('glitch: power bar stuck full - a held charge is released after powerFillTicks + chargeWaitExtraTicks', () => {
    const s = shootScene(36, 0);
    start(s, KickKind.SHOT_NORMAL, { power: 0.5, charging: 1 });
    const wait = T_PASS.powerFillTicks + LT.chargeWaitExtraTicks;
    const steps = actTicks(s, W + wait + 3);
    expect(kickTicks(steps)).toEqual([W + wait]);
  });
});

// ---------------------------------------------------------------- low driven

describe('SIM-11 low driven (second SHOOT press during the power-up)', () => {
  it('markLowDriven converts the charging shot, keeps the power, and the ball stays under 1 m', () => {
    const s = shootScene(34, 2, 1, false);
    start(s, KickKind.SHOT_NORMAL, { power: 0, charging: 1 });
    const p = s.players[SHOOTER]!;
    const steps = actTicks(s, 30, (t, st) => {
      if (t < 15) p.actPower = t / 20;
      if (t === 15) {
        expect(markLowDriven(st, SHOOTER)).toBe(1);
        p.actCharging = 0; // what the resolver does after the call
      }
    });
    expect(kickTicks(steps)).toEqual([15]);
    const k = eventOf(steps, EventType.KICK)!;
    expect(k.b).toBe(KickKind.SHOT_LOW_DRIVEN);
    expect(k.c).toBeCloseTo(14 / 20, 9);
    expect(peakBefore({ ...s.ball }, GX)).toBeLessThan(1);
  });

  it('a power shot converted during its wind-up shrinks to the normal wind-up', () => {
    const s = shootScene(36, 0);
    start(s, KickKind.SHOT_POWER, { power: 0.6 });
    const steps = actTicks(s, PW + 2, (t, st) => { if (t === 4) expect(markLowDriven(st, SHOOTER)).toBe(1); });
    expect(kickTicks(steps)).toEqual([W]);
    expect(eventOf(steps, EventType.KICK)!.b).toBe(KickKind.SHOT_LOW_DRIVEN);
  });

  it('returns 0 without a running open-play shot (idle, after contact, free kick, bad slot)', () => {
    const s = shootScene(36, 0);
    expect(markLowDriven(s, SHOOTER)).toBe(0);
    expect(markLowDriven(s, -3)).toBe(0);
    start(s);
    actTicks(s, W + 1);
    expect(s.players[SHOOTER]!.actDone).toBe(1);
    expect(markLowDriven(s, SHOOTER)).toBe(0);
    const f = shootScene(GX - 25, 0);
    f.match.phase = MatchPhase.FREE_KICK;
    f.match.restart.kind = RestartKind.FREE_KICK; f.match.restart.taker = SHOOTER; f.match.restart.taken = 0;
    expect(startShot(f, SHOOTER, KickKind.FREE_KICK_SHOT, shotReq(), NULL_SINK)).toBe(1);
    expect(markLowDriven(f, SHOOTER)).toBe(0);
    expect(f.players[SHOOTER]!.actKick).toBe(KickKind.FREE_KICK_SHOT);
  });
});

// ---------------------------------------------------------------- interruption, whiffs

describe('SIM-11 interruption and whiffs', () => {
  it('fake shot (SIM-13 startFake) cancels the wind-up cleanly: no kick, nothing left locked', () => {
    const s = shootScene(36, 0);
    s.attrs[SHOOTER]!.skillMoves = 5;
    start(s, KickKind.SHOT_NORMAL, { power: 0.7, charging: 1 });
    const p = s.players[SHOOTER]!;
    let faked = 0;
    const steps = actTicks(s, W + REC, (t, st) => { if (t === 5) faked = startFake(st, SHOOTER, NULL_SINK); });
    expect(faked).toBe(1);
    // The fake may take its own touch (SIM-13), but no shot is ever struck.
    for (const e of findEventsIn(steps, EventType.KICK)) expect(e.b === KickKind.SHOT_NORMAL).toBe(false);
    expect(findEventsIn(steps, EventType.SHOT)).toHaveLength(0);
    expect(s.ball.shotBy).toBe(-1);
    expect(p.act === ActionKind.SHOT).toBe(false);
    expect(p.moveMode).not.toBe(MoveMode.LOCKED);
  });

  it('interrupted during the follow-through: end() releases the LOCKED movement', () => {
    const s = shootScene(36, 0);
    start(s);
    actTicks(s, W + 1);
    const p = s.players[SHOOTER]!;
    expect(p.moveMode).toBe(MoveMode.LOCKED);
    endAction(s, SHOOTER, 1);
    expect(p.act).toBe(ActionKind.NONE);
    expect(p.moveMode).toBe(MoveMode.STOP);
  });

  it('dispossessed before contact: whiff at once, no kick, the action recovers', () => {
    const s = shootScene(36, 0);
    place(s, DEF, 37, 0.8, -1, 0);
    start(s);
    const p = s.players[SHOOTER]!;
    const steps = actTicks(s, W + REC + 2, (t, st) => { if (t === 5) { st.ball.owner = DEF; st.ball.lastTouch = DEF; } });
    expect(kickTicks(steps)).toEqual([]);
    expect(p.act).toBe(ActionKind.NONE);
  });

  it('ball gone out of reach at the contact tick: whiff (no kick)', () => {
    const s = shootScene(36, 0);
    start(s);
    const steps = actTicks(s, W + 8, (t, st) => {
      if (t === 3) { st.ball.owner = -1; st.ball.x += 6; st.ball.px = st.ball.x; }
    });
    expect(kickTicks(steps)).toEqual([]);
  });

  it('phase no longer live at contact (e.g. the whistle went): no kick', () => {
    const s = shootScene(36, 0);
    start(s);
    const steps = actTicks(s, W + 3, (t, st) => { if (t === 6) st.match.phase = MatchPhase.GOAL; });
    expect(kickTicks(steps)).toEqual([]);
  });
});

function findEventsIn(steps: Step[], type: EventType): SimEvent[] {
  const r: SimEvent[] = [];
  for (const st of steps) for (const e of st.events) if (e.type === type) r.push(e);
  return r;
}

// ---------------------------------------------------------------- first-time ground shots, refusals

describe('SIM-11 starting a shot', () => {
  it('first-time ground shot: a low loose ball arriving within the wind-up is struck toward goal', () => {
    const s = shootScene(36, 0, 1, false);
    const b = s.ball;
    b.owner = -1; b.lastTouch = 10; b.lastTouchTeam = 0;
    b.x = 34.2; b.z = 2.6; b.px = b.x; b.pz = b.z; b.y = 0.11; b.vy = 0; b.grounded = 1;
    b.vx = 6; b.vz = -8.5;
    start(s, KickKind.SHOT_NORMAL, { power: 0.7 });
    const steps = actTicks(s, W + REC, undefined, true);
    const kt = kickTicks(steps);
    expect(kt).toHaveLength(1);
    expect(kt[0]!).toBeGreaterThanOrEqual(W);
    expect(kt[0]!).toBeLessThanOrEqual(W + LT.contactGraceTicks);
    expect(s.ball.vx).toBeGreaterThan(15);
    expect(s.ball.shotBy).toBe(SHOOTER);
  });

  it('glitch: first-time shot pressed early (ball still ~20 ticks away) waits for the ball instead of whiffing', () => {
    const s = shootScene(36, 0, 1, false);
    const b = s.ball;
    b.owner = -1; b.lastTouch = 10; b.lastTouchTeam = 0;
    b.x = 36.3; b.z = 3.9; b.px = b.x; b.pz = b.z; b.y = 0.11; b.vy = 0; b.grounded = 1;
    b.vx = 0; b.vz = -8;
    start(s, KickKind.SHOT_NORMAL, { power: 0.7 });
    const steps = actTicks(s, W + LT.startArriveTicks + REC, undefined, true);
    const kt = kickTicks(steps);
    expect(kt).toHaveLength(1);
    expect(kt[0]!).toBeGreaterThan(W);
    expect(s.ball.vx).toBeGreaterThan(15);
    // The recovery follows the actual contact.
    expect(s.players[SHOOTER]!.act).toBe(ActionKind.NONE);
  });

  it('refuses a loose ball that is far away or rolling away from him', () => {
    const s = shootScene(36, 0, 1, false);
    const b = s.ball;
    b.owner = -1; b.x = 30; b.z = 8; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0;
    expect(startShot(s, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
    b.x = 38; b.z = 0; b.px = b.x; b.pz = b.z; b.vx = 10; // 2 m ahead, running away
    expect(startShot(s, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
    b.y = 1.6; b.x = 36.5; b.vx = 0; b.grounded = 0; // in his reach but too high (volley = SIM-12)
    expect(startShot(s, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
  });

  it('refuses when busy, when someone else owns or holds the ball, when the phase is not live for him, or a non-shot kind', () => {
    const busy = shootScene(36, 0);
    start(busy);
    expect(startShot(busy, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
    const owned = shootScene(36, 0);
    owned.ball.owner = DEF;
    expect(startShot(owned, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
    const held = shootScene(36, 0);
    held.ball.owner = -1; held.ball.heldBy = KEEPER;
    expect(startShot(held, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
    const dead = shootScene(36, 0);
    dead.match.phase = MatchPhase.GOAL;
    expect(startShot(dead, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
    const notTaker = shootScene(GX - 25, 0);
    notTaker.match.phase = MatchPhase.FREE_KICK;
    notTaker.match.restart.kind = RestartKind.FREE_KICK; notTaker.match.restart.taker = 10; notTaker.match.restart.taken = 0;
    expect(startShot(notTaker, SHOOTER, KickKind.FREE_KICK_SHOT, shotReq(), NULL_SINK)).toBe(0);
    const so = shootScene(GX - 11, 0);
    so.match.phase = MatchPhase.SHOOT_OUT; so.match.shootout.kicker = 10;
    expect(startShot(so, SHOOTER, KickKind.PENALTY, shotReq(), NULL_SINK)).toBe(0);
    so.match.shootout.kicker = SHOOTER;
    expect(startShot(so, SHOOTER, KickKind.PENALTY, shotReq(), NULL_SINK)).toBe(1);
    const wrong = shootScene(36, 0);
    expect(startShot(wrong, SHOOTER, KickKind.GROUND_PASS, shotReq(), NULL_SINK)).toBe(0);
    const stunned = shootScene(36, 0);
    stunned.players[SHOOTER]!.stunT = 5;
    expect(startShot(stunned, SHOOTER, KickKind.SHOT_NORMAL, shotReq(), NULL_SINK)).toBe(0);
  });

  it('stores the request on the action fields (kind, power, unit stick, target, curl, flags, assist)', () => {
    const s = shootScene(36, 0);
    start(s, KickKind.SHOT_FINESSE, { power: 0.4, dirX: 3, dirZ: 4, curve: 2, assist: AssistLevel.SEMI, hasTarget: 1, targetX: GX, targetZ: 1 });
    const p = s.players[SHOOTER]!;
    expect(p.actKick).toBe(KickKind.SHOT_FINESSE);
    expect(p.actPower).toBeCloseTo(0.4, 9);
    expect(p.actDirX).toBeCloseTo(0.6, 9);
    expect(p.actDirZ).toBeCloseTo(0.8, 9);
    expect(p.actCurve).toBe(1);
    expect(p.actX).toBe(GX);
    expect(p.actZ).toBe(1);
    expect(p.actB).toBe(AssistLevel.SEMI + 4);
    expect(p.actSlot).toBe(-1);
    expect(p.actDur).toBe(W + REC);
  });
});

// ---------------------------------------------------------------- movement, set pieces

describe('SIM-11 movement and set-piece shots', () => {
  it('movement is slowed during the wind-up (stick capped, no sprint) and locked through the follow-through', () => {
    const s = shootScene(36, 0);
    start(s);
    const p = s.players[SHOOTER]!;
    const seen: { t: number; ix: number; mode: MoveMode; sprint: number }[] = [];
    actTicks(s, W + REC, (t) => {
      if (t > 1) seen.push({ t: t - 1, ix: p.ix, mode: p.moveMode, sprint: p.wantSprint });
      if (p.moveMode !== MoveMode.LOCKED) { p.moveMode = MoveMode.DIRECT; p.ix = 1; p.iz = 0; p.wantSprint = 1; }
    });
    for (const v of seen) {
      if (v.t < W) {
        expect(v.ix).toBeLessThanOrEqual(LT.windupMoveScale + 1e-9);
        expect(v.sprint).toBe(0);
      } else if (v.t < W + LT.contactLockTicks) expect(v.mode).toBe(MoveMode.LOCKED);
    }
    // The cap ramps back toward 1 by the end of the recovery.
    const last = seen[seen.length - 1]!;
    expect(last.ix).toBeGreaterThan(LT.windupMoveScale);
  });

  it('a free-kick shot by the taker marks the restart taken', () => {
    const s = shootScene(GX - 25, 3);
    s.match.phase = MatchPhase.FREE_KICK;
    const r = s.match.restart;
    r.kind = RestartKind.FREE_KICK; r.taker = SHOOTER; r.taken = 0; r.side = 0.5; r.wallCount = 0;
    start(s, KickKind.FREE_KICK_SHOT, { power: 0.6, curve: -0.6 });
    const steps = actTicks(s, W + 2);
    expect(kickTicks(steps)).toEqual([W]);
    expect(eventOf(steps, EventType.KICK)!.b).toBe(KickKind.FREE_KICK_SHOT);
    expect(r.taken).toBe(1);
    expect(s.ball.sy).toBeGreaterThan(0); // curve -0.6 = bends left of travel
  });
});

// ---------------------------------------------------------------- full pipeline

describe('SIM-11 through the full pipeline', () => {
  function humanScene(seed: number): SimState {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: [{ side: 0, slot: SHOOTER }] });
    const p = s.players[SHOOTER]!;
    p.x = 35; p.z = 3; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
    skill(s, SHOOTER, 85);
    giveBall(s, SHOOTER);
    // Keep defenders out of the way so the shot is struck.
    for (let i = 11; i < 22; i++) if (i !== KEEPER) { s.players[i]!.x = -20; s.players[i]!.z = -30 + i; }
    return s;
  }

  /** Hold SHOOT (stick toward +x) for 12 ticks from the current tick, then run on; returns every event. */
  function pressShoot(s: SimState): SimEvent[] {
    const t0 = s.tick;
    return runTicks(s, 90, (tick, _st, out) => {
      const i = tick - 1 - t0;
      if (i >= 0 && i < 12) { out[0]!.buttons = Btn.SHOOT; out[0]!.mx = 127; }
    }, { check: 'core' });
  }

  it('a held SHOOT press plays a shot toward goal; two runs are identical', () => {
    const a = humanScene(5);
    const evA = pressShoot(a);
    const shots = findEvents(evA, EventType.SHOT, (e) => e.a === SHOOTER);
    expect(shots).toHaveLength(1);
    const kick = findEvents(evA, EventType.KICK, (e) => e.a === SHOOTER)[0]!;
    expect(kick.b).toBeGreaterThanOrEqual(KickKind.SHOT_NORMAL);
    expect(kick.b).toBeLessThanOrEqual(KickKind.SHOT_LOW_DRIVEN);
    expect(kick.c).toBeGreaterThan(0.2);
    const b = humanScene(5);
    const evB = pressShoot(b);
    expect(hashState(b)).toBe(hashState(a));
    expect(evB.length).toBe(evA.length);
    expect(JSON.stringify(evB)).toBe(JSON.stringify(evA));
  });
});
