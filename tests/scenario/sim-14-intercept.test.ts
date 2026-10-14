/**
 * SIM-14 interceptions and clearances through the real pipeline: interception rates by attribute and ball speed, the
 * passing team never intercepting its own pass, body blocks, slow / high balls left alone, keeper priority, controlled
 * vs blocked interceptions; clearances long, high and upfield, toward the touchline under pressure, timed to an
 * arriving ball, aerial balls handed to SIM-12, and never back toward goal.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { createActionRequest, createKickLaunch } from '../../src/contracts/systems';
import { T_TACKLE } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { cloneState } from '../../src/sim/core/clone';
import {
  LOCAL_TUNING as L, interceptChance, interceptContacts, solveClearance, startClearance,
} from '../../src/sim/defend/tackle';
import { P1, P2, loose, owned, pass, place, scene, stepN, trial } from './sim-14-helpers';

const EV = createEventBuffer();
const PASSER = 8; // home midfielder
const MATE = 7; // another home player
const inter = (ev: SimEvent[]): SimEvent[] => ev.filter((e) => e.type === EventType.INTERCEPT);

/** A home ground pass from (-10, 0) along +x at `speed`; P2 (away) stands `off` metres off the line at x = 0. */
function lane(seed: number, speed: number, off: number) {
  const s = scene(seed);
  place(s, PASSER, -10.5, 0, 1, 0);
  place(s, P2, 0, off, -1, 0);
  pass(s, PASSER, KickKind.GROUND_PASS, -10, 0, speed, 0);
  return s;
}

function rate(base: ReturnType<typeof lane>, n: number): number {
  let k = 0;
  for (let i = 0; i < n; i++) {
    const s = trial(base, i);
    const ev = stepN(s, 90, (st) => st.ball.x > 3 || st.ball.lastTouch !== PASSER);
    if (inter(ev).some((e) => e.a === P2 && e.b === PASSER)) k++;
  }
  return k / n;
}

describe('SIM-14 interceptions', () => {
  it('interception rates rise with the interceptions attribute', () => {
    const lo = lane(1, 15, 0.7), hi = lane(1, 15, 0.7);
    lo.attrs[P2]!.interceptions = 15; lo.attrs[P2]!.agility = 30;
    hi.attrs[P2]!.interceptions = 95; hi.attrs[P2]!.agility = 85;
    const rl = rate(lo, 80), rh = rate(hi, 80);
    expect(rh).toBeGreaterThan(rl + 0.2);
    expect(rh).toBeGreaterThan(0.45);
    expect(rl).toBeGreaterThan(0.03);
  });

  it('faster passes are intercepted less often; a ball through his body never slips past', () => {
    const slow = rate(lane(2, 12, 0.8), 80);
    const fast = rate(lane(2, 26, 0.8), 80);
    expect(slow).toBeGreaterThan(fast + 0.15);
    expect(rate(lane(3, 24, 0.05), 20)).toBe(1);
  });

  it('the chance model: closer, slower, lower and facing the ball is better', () => {
    const s = lane(4, 15, 0.5);
    const base = interceptChance(s, P2, 0.3, 12, 0.11);
    expect(interceptChance(s, P2, 1.1, 12, 0.11)).toBeLessThan(base);
    expect(interceptChance(s, P2, 0.3, 24, 0.11)).toBeLessThan(base);
    expect(interceptChance(s, P2, 0.3, 12, 0.95)).toBeLessThan(base);
    s.players[P2]!.fx = 1; // ball now comes from behind him
    expect(interceptChance(s, P2, 0.3, 12, 0.11)).toBeLessThan(base);
  });

  it('the passing team never intercepts its own pass', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const s = scene(seed);
      place(s, PASSER, -10.5, 0, 1, 0);
      place(s, MATE, 0, 0.3, -1, 0);
      s.attrs[MATE]!.interceptions = 99;
      pass(s, PASSER, KickKind.GROUND_PASS, -10, 0, 14, 0);
      const ev = stepN(s, 40);
      expect(inter(ev)).toHaveLength(0);
      expect(ev.some((e) => e.type === EventType.TACKLE)).toBe(false);
    }
  });

  it('INTERCEPT names the interceptor and the passer; a moderate pass is controlled, a fast one blocked', () => {
    const ctl = lane(5, 12, 0.0);
    ctl.attrs[P2]!.ballControl = 95;
    const e1 = inter(stepN(ctl, 60, (st) => st.ball.lastTouch !== PASSER));
    expect(e1).toHaveLength(1);
    expect(e1[0]!.a).toBe(P2);
    expect(e1[0]!.b).toBe(PASSER);
    expect(ctl.ball.owner).toBe(P2);
    stepN(ctl, 30);
    expect(ctl.ball.owner).toBe(P2);

    const blk = lane(5, 30, 0.0);
    blk.attrs[P2]!.ballControl = 5;
    const ev = stepN(blk, 60, (st) => st.ball.lastTouch !== PASSER);
    expect(inter(ev)).toHaveLength(1);
    expect(ev.some((e) => e.type === EventType.KICK && e.a === P2 && e.b === KickKind.DEFLECTION)).toBe(true);
    expect(blk.ball.owner).not.toBe(P2);
  });

  it('slow passes (SIM-06 pick-ups), high balls and dead balls are not interception contacts', () => {
    const slow = lane(6, L.interceptMinSpeed - 1.5, 0.3);
    expect(inter(stepN(slow, 120))).toHaveLength(0);
    const high = lane(7, 15, 0.2);
    high.ball.y = 1.6; high.ball.py = 1.6; high.ball.vy = 0; high.ball.grounded = 0;
    const ev = stepN(high, 4);
    expect(inter(ev)).toHaveLength(0);
    const dead = lane(8, 15, 0.0);
    dead.match.phase = 6; // FREE_KICK, not taken
    dead.match.restart.taken = 0;
    dead.tick++;
    dead.ball.px = -0.5; dead.ball.x = 0; // straight through him
    const evb = createEventBuffer();
    evb.begin(dead.tick);
    interceptContacts(dead, evb);
    expect(evb.count).toBe(0);
    expect(dead.ball.vx).toBe(15);
    dead.match.restart.taken = 1; // once taken the ball is live again
    interceptContacts(dead, evb);
    const types: number[] = [];
    for (let i = 0; i < evb.count; i++) types.push(evb.get(i).type);
    expect(types).toContain(EventType.INTERCEPT);
  });

  it('Keeper fights a defender: a defender does not intercept a ball his claiming keeper is about to take', () => {
    const s = lane(9, 15, 0.2);
    const gk = s.teams[1]!.keeperSlot;
    place(s, gk, 1.2, 0, -1, 0);
    s.players[gk]!.act = ActionKind.GK_RUSH; s.players[gk]!.actDur = 60;
    // ball entering P2's reach this tick
    s.ball.px = -1.3; s.ball.x = -1.05; s.ball.pz = 0; s.ball.z = 0;
    s.tick++;
    const c = cloneState(s);
    interceptContacts(s, EV);
    expect(s.ball.touchedTick).not.toBe(s.tick);
    c.players[gk]!.act = ActionKind.NONE; // control: without the claim the ball through his body is his
    interceptContacts(c, EV);
    expect(c.ball.touchedTick).toBe(c.tick);
  });

  it('interceptions are deterministic', () => {
    const run = (): number => { const s = lane(10, 15, 0.6); stepN(s, 60); return hashState(s); };
    expect(run()).toBe(run());
  });
});

describe('SIM-14 clearances', () => {
  /** P1 in his own third (home defends -x), the ball at his feet. */
  function own(seed: number, opp: boolean) {
    const s = scene(seed);
    place(s, P1, -40, 10, 1, 0);
    owned(s, P1, -39.5, 10);
    if (opp) place(s, P2, -38.5, 11, -1, 0);
    else place(s, P2, 20, -20, -1, 0);
    return s;
  }

  it('long and high upfield', () => {
    const s = own(1, false);
    const req = createActionRequest();
    expect(startClearance(s, P1, KickKind.CLEARANCE, req, EV)).toBe(1);
    expect(s.players[P1]!.act).toBe(ActionKind.KICK);
    expect(s.players[P1]!.actKick).toBe(KickKind.CLEARANCE);
    let kicked = false, landX = 0;
    const ev = stepN(s, 200, (st) => {
      if (!kicked && st.ball.lastKickKind === KickKind.CLEARANCE) kicked = true;
      if (kicked && landX === 0 && st.ball.bounces > 0) landX = st.ball.x;
      return landX !== 0;
    });
    const k = ev.find((e) => e.type === EventType.KICK && e.b === KickKind.CLEARANCE);
    expect(k?.a).toBe(P1);
    expect(landX - -39.5).toBeGreaterThan(30);
  });

  it('under pressure it goes toward the near touchline', () => {
    const l = createKickLaunch();
    const s = own(2, true);
    s.players[P1]!.actPower = 0.8;
    expect(solveClearance(s, P1, l)).toBe(1);
    expect(l.kind).toBe(KickKind.CLEARANCE);
    expect(l.vx).toBeGreaterThan(0);
    expect(l.vy).toBeGreaterThan(5);
    expect(l.vz).toBeGreaterThan(0.3 * l.vx); // P1 is at z = +10: toward the +z touchline
    const f = own(2, false);
    f.players[P1]!.actPower = 0.8;
    solveClearance(f, P1, l);
    expect(Math.abs(l.vz)).toBeLessThan(0.35 * l.vx);
  });

  it('never back toward his own goal, whatever the facing or request', () => {
    const l = createKickLaunch();
    for (let seed = 1; seed <= 20; seed++) {
      const s = own(seed, seed % 2 === 0);
      const p = s.players[P1]!;
      p.fx = -1; p.fz = 0; p.actDirX = -0.8; p.actDirZ = 0.6; p.actPower = 1;
      solveClearance(s, P1, l);
      expect(l.vx / Math.hypot(l.vx, l.vz)).toBeGreaterThan(L.clearMinForward * 0.5 - 1e-9);
      s.teams[0]!.dir = -1; // second half: home defends +x
      solveClearance(s, P1, l);
      expect(l.vx).toBeLessThan(0);
    }
  });

  it('first-time on an arriving ball: the contact is timed to the arrival', () => {
    const s = scene(3);
    place(s, P1, -40, 0, 1, 0);
    loose(s, -34, 0, -12, 0);
    expect(startClearance(s, P1, KickKind.CLEARANCE, createActionRequest(), EV)).toBe(1);
    expect(s.players[P1]!.actContact).toBeGreaterThan(L.clearWindup);
    const ev = stepN(s, 60, (st) => st.ball.lastKickKind === KickKind.CLEARANCE);
    expect(ev.some((e) => e.type === EventType.KICK && e.a === P1 && e.b === KickKind.CLEARANCE)).toBe(true);
    expect(s.ball.vx).toBeGreaterThan(5);
  });

  it('refused: an opponent\'s ball, a ball not coming, busy, wrong kind', () => {
    const s = scene(4);
    place(s, P1, -40, 0, 1, 0);
    place(s, P2, -30, 0, -1, 0);
    owned(s, P2, -30.5, 0);
    const req = createActionRequest();
    expect(startClearance(s, P1, KickKind.CLEARANCE, req, EV)).toBe(0);
    loose(s, -30, 10, 0, 0);
    expect(startClearance(s, P1, KickKind.CLEARANCE, req, EV)).toBe(0);
    loose(s, -39.5, 0, 0, 0);
    expect(startClearance(s, P1, KickKind.GROUND_PASS, req, EV)).toBe(0);
    s.players[P1]!.stunT = 3;
    expect(startClearance(s, P1, KickKind.CLEARANCE, req, EV)).toBe(0);
  });

  it('a high ball he can only head goes to SIM-12 as an aerial clearance', () => {
    const s = scene(5);
    place(s, P1, -40, 0, 1, 0);
    // a dropping cross: about head height when it reaches him
    loose(s, -30, 0, -14, 0);
    s.ball.y = 3.5; s.ball.py = 3.5; s.ball.vy = 1.5; s.ball.grounded = 0;
    const r = startClearance(s, P1, KickKind.CLEARANCE, createActionRequest(), EV);
    if (r === 1) expect([ActionKind.HEADER, ActionKind.VOLLEY]).toContain(s.players[P1]!.act);
    else expect(s.players[P1]!.act).toBe(ActionKind.NONE);
  });

  it('a standing tackle reach is the tuned one', () => {
    expect(T_TACKLE.standReach).toBeGreaterThan(1);
  });
});
