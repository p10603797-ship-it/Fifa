/**
 * SIM-06 possession and dribbling, on a mini pipeline (SIM-04 locomotion -> SIM-02 ball -> SIM-06 dribbleTick) so the
 * dribble model is measured without the AI / resolver: touches ahead at a jog vs a sprint, the poke-away window,
 * turns and stops, close control, touch quality, wind-up and shield holds, steals and blocks, loose-ball pick-up
 * rules, possession loss, the stuck-ball squirt (glitch list "Ball stuck: between two players / under a sliding
 * player"), countdowns, canTouchBall and determinism.
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_DRIBBLE } from '../../src/contracts/tuning';
import { ballTick } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { recordTouch } from '../../src/sim/core/kick';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { LOCAL_TUNING as L, canTouchBall, dribbleTick } from '../../src/sim/players/possession';
import { makeScenario } from '../harness/scenario';

const DRIBBLER = 9;
const OPP = 14;
const MATE = 7;

/** IN_PLAY state: everyone parked in two far rows, the dribbler at (x, z) facing +x, ball at his feet (owner). */
function world(seed = 1, x = -30, z = 0, owner = true): SimState {
  const s = makeScenario({ seed, phase: MatchPhase.IN_PLAY });
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = 48; p.z = -32 + i * 3; p.vx = 0; p.vz = 0; p.moveMode = MoveMode.STOP;
  }
  const p = s.players[DRIBBLER]!;
  p.x = x; p.z = z; p.fx = 1; p.fz = 0;
  const b = s.ball;
  Object.assign(b, { x: x + 0.5, y: 0.11, z, px: x + 0.5, py: 0.11, pz: z, vx: 0, vy: 0, vz: 0, grounded: 1, owner: owner ? DRIBBLER : -1, heldBy: -1 });
  if (owner) { b.lastTouch = DRIBBLER; b.lastTouchTeam = 0; }
  return s;
}

const evb = createEventBuffer();
/** One mini-pipeline tick; returns copies of the tick's events. */
function tick(s: SimState): SimEvent[] {
  s.tick++;
  evb.begin(s.tick);
  locomotionTick(s, evb);
  ballTick(s, evb);
  dribbleTick(s, evb);
  const out: SimEvent[] = [];
  for (let k = 0; k < evb.count; k++) out.push({ ...evb.get(k) });
  return out;
}

function stick(s: SimState, slot: number, ix: number, iz: number, sprint = 0): void {
  const p = s.players[slot]!;
  p.moveMode = MoveMode.DIRECT; p.ix = ix; p.iz = iz; p.wantSprint = sprint;
}

const dist = (s: SimState, slot: number): number => Math.hypot(s.ball.x - s.players[slot]!.x, s.ball.z - s.players[slot]!.z);
const isTouch = (e: SimEvent): boolean => e.type === EventType.KICK && e.b === KickKind.DRIBBLE_TOUCH;
/** The owner's reach used by SIM-06 (controlRadius + speed x reachLookahead). */
const reachOf = (s: SimState, slot: number): number =>
  T_DRIBBLE.controlRadius + Math.hypot(s.players[slot]!.vx, s.players[slot]!.vz) * L.reachLookahead;

interface RunStats { maxLead: number; touches: number; gaps: number[]; outOfReach: number; ticks: number; lostAt: number; maxSide: number }

/** Dribble straight along +x for n ticks (stats after `warm` ticks). */
function runStraight(s: SimState, n: number, sprint: number, mag = 1, warm = 90): RunStats {
  const r: RunStats = { maxLead: 0, touches: 0, gaps: [], outOfReach: 0, ticks: 0, lostAt: -1, maxSide: 0 };
  let last = -1;
  for (let t = 0; t < n; t++) {
    stick(s, DRIBBLER, mag, 0, sprint);
    const ev = tick(s);
    if (s.ball.owner !== DRIBBLER && r.lostAt < 0) r.lostAt = t;
    for (const e of ev) if (isTouch(e)) { r.touches++; if (last >= 0 && t >= warm) r.gaps.push(t - last); last = t; }
    if (t < warm) continue;
    const p = s.players[DRIBBLER]!;
    r.ticks++;
    r.maxLead = Math.max(r.maxLead, s.ball.x - p.x);
    r.maxSide = Math.max(r.maxSide, Math.abs(s.ball.z - p.z));
    if (dist(s, DRIBBLER) > reachOf(s, DRIBBLER)) r.outOfReach++;
  }
  return r;
}

describe('SIM-06 dribble touches: closer at a jog, further at a sprint', () => {
  it('touches ahead at a jog: the ball runs about touchAheadJog ahead, stays within his reach, touched every interval', () => {
    for (const seed of [1, 2, 3, 4]) {
      const s = world(seed);
      const r = runStraight(s, 480, 0);
      expect(r.lostAt, `seed ${seed}`).toBe(-1);
      expect(r.maxLead).toBeGreaterThan(0.8 * T_DRIBBLE.touchAheadJog);
      expect(r.maxLead).toBeLessThan(1.3 * T_DRIBBLE.touchAheadJog);
      expect(r.outOfReach).toBe(0);
      expect(r.maxSide).toBeLessThan(0.3);
      // Steady jog: one touch per interval (quality-scaled), never faster than the interval.
      expect(Math.min(...r.gaps)).toBeGreaterThanOrEqual(Math.round(T_DRIBBLE.touchIntervalJog * (1 - L.intervalQualityScale / 2)));
      expect(Math.max(...r.gaps)).toBeLessThanOrEqual(Math.round(T_DRIBBLE.touchIntervalJog * (1 + L.intervalQualityScale / 2)) + 1);
    }
  });

  it('touches ahead at a sprint are heavier: the ball runs about touchAheadSprint ahead, far beyond the jog lead', () => {
    for (const seed of [1, 2, 3, 4]) {
      const jog = runStraight(world(seed), 480, 0);
      const s = world(seed);
      const r = runStraight(s, 480, 1);
      expect(r.lostAt, `seed ${seed}`).toBe(-1);
      expect(r.maxLead).toBeGreaterThan(0.8 * T_DRIBBLE.touchAheadSprint);
      expect(r.maxLead).toBeLessThanOrEqual(T_DRIBBLE.loseRadius - L.loseMargin + 0.1);
      expect(r.maxLead).toBeGreaterThan(jog.maxLead + 0.8);
      expect(s.players[DRIBBLER]!.sprinting).toBe(1);
      // Never closer than the interval either.
      expect(Math.min(...r.gaps)).toBeGreaterThanOrEqual(T_DRIBBLE.touchIntervalSprint * (1 - L.intervalQualityScale / 2) - 1);
    }
  });

  it('poke-away window exists at a sprint: the ball spends most of each sprint touch out of his reach, never at a jog', () => {
    const sprint = runStraight(world(5), 480, 1);
    const jog = runStraight(world(5), 480, 0);
    expect(sprint.outOfReach / sprint.ticks).toBeGreaterThan(0.5);
    expect(jog.outOfReach).toBe(0);
  });

  it('a walking dribble keeps the ball closer than a jog (lead between touchAheadClose and touchAheadJog)', () => {
    const r = runStraight(world(2), 480, 0, 0.4);
    expect(r.lostAt).toBe(-1);
    expect(r.maxLead).toBeGreaterThan(0.8 * T_DRIBBLE.touchAheadClose);
    expect(r.maxLead).toBeLessThan(T_DRIBBLE.touchAheadJog * 0.85);
  });

  it('strafe / jockey dribbling uses close control (touchAheadClose)', () => {
    const s = world(3);
    const p = s.players[DRIBBLER]!;
    let maxD = 0;
    for (let t = 0; t < 360; t++) {
      stick(s, DRIBBLER, 0, 1);
      p.lookAt = 1; p.lookX = 52.5; p.lookZ = 0; // face the goal, move sideways
      tick(s);
      if (t > 60) maxD = Math.max(maxD, dist(s, DRIBBLER));
    }
    expect(s.ball.owner).toBe(DRIBBLER);
    expect(p.jockeying).toBe(1);
    expect(maxD).toBeLessThan(T_DRIBBLE.touchAheadClose * 1.35);
  });

  it('near opponents a jog dribble pulls the ball in toward close control', () => {
    const free = runStraight(world(4), 420, 0);
    const s = world(4);
    const o = s.players[OPP]!;
    o.x = -30; o.z = 2.2; // runs alongside, 2.2 m to the side
    const r: number[] = [];
    for (let t = 0; t < 420; t++) {
      stick(s, DRIBBLER, 1, 0);
      stick(s, OPP, 1, 0);
      tick(s);
      if (t > 90) r.push(s.ball.x - s.players[DRIBBLER]!.x);
    }
    expect(s.ball.owner).toBe(DRIBBLER);
    expect(Math.max(...r)).toBeLessThan(free.maxLead - 0.15);
  });

  it('dribble touches keep possession and pass / offside data: recordTouch only, KICK event with DRIBBLE_TOUCH', () => {
    const s = world(1);
    const b = s.ball;
    Object.assign(b, { lastKickBy: 3, lastKickTeam: 0, lastKickKind: KickKind.GROUND_PASS, lastKickTick: -50, passTarget: -1, passX: 7, passZ: 8 });
    let touches = 0;
    for (let t = 0; t < 120; t++) {
      stick(s, DRIBBLER, 1, 0);
      const ev = tick(s);
      for (const e of ev) {
        if (!isTouch(e)) continue;
        touches++;
        expect(e.a).toBe(DRIBBLER);
        expect(e.c).toBeGreaterThanOrEqual(0);
        expect(e.c).toBeLessThan(0.5);
        expect(b.lastTouch).toBe(DRIBBLER);
        expect(b.touchedTick).toBe(s.tick);
        expect(s.players[DRIBBLER]!.lastTouchTick).toBe(s.tick);
      }
      expect(b.owner).toBe(DRIBBLER);
    }
    expect(touches).toBeGreaterThan(3);
    expect([b.lastKickBy, b.lastKickKind, b.lastKickTick, b.passX, b.passZ]).toEqual([3, KickKind.GROUND_PASS, -50, 7, 8]);
  });
});

describe('SIM-06 turns and stops', () => {
  for (const [name, ix, iz] of [['90 degrees', 0, 1], ['180 degrees', -1, 0], ['135 degrees', -0.7, -0.7]] as const) {
    it(`turning sharply (${name}) at a jog takes an extra small touch and keeps the ball`, () => {
      for (const seed of [1, 2, 3]) {
        const s = world(seed);
        for (let t = 0; t < 120; t++) { stick(s, DRIBBLER, 1, 0); tick(s); }
        let turnTouch = 0;
        let maxD = 0;
        for (let t = 0; t < 180; t++) {
          stick(s, DRIBBLER, ix, iz);
          const ev = tick(s);
          if (ev.some(isTouch) && s.players[DRIBBLER]!.touchCd === L.turnInterval - 1) turnTouch++;
          maxD = Math.max(maxD, dist(s, DRIBBLER));
        }
        expect(s.ball.owner, `seed ${seed}`).toBe(DRIBBLER);
        expect(turnTouch).toBeGreaterThanOrEqual(1);
        expect(maxD).toBeLessThan(T_DRIBBLE.loseRadius * 0.6);
        // The ball now travels the new way, ahead of him.
        const p = s.players[DRIBBLER]!;
        const n = Math.hypot(ix, iz);
        expect(((s.ball.x - p.x) * ix + (s.ball.z - p.z) * iz) / n).toBeGreaterThan(0.3);
        expect((s.ball.vx * ix + s.ball.vz * iz) / n).toBeGreaterThan(2);
      }
    });
  }

  it('a zigzag and a curving run at a jog keep the ball', () => {
    for (const seed of [1, 2]) {
      const s = world(seed, -20, 0);
      for (let t = 0; t < 480; t++) {
        const zig = Math.floor(t / 40) % 2 === 0 ? 0.7 : -0.7;
        stick(s, DRIBBLER, 0.7, zig);
        tick(s);
        expect(s.ball.owner, `zigzag seed ${seed} t ${t}`).toBe(DRIBBLER);
      }
      const c = world(seed, -10, 0);
      for (let t = 0; t < 480; t++) {
        const a = t / 40; // 1.5 rad/s: a 3.4 m radius circle at a jog
        // Unit stick on the circle (polynomial cos/sin are fine in a test).
        stick(c, DRIBBLER, Math.cos(a), Math.sin(a));
        tick(c);
        expect(c.ball.owner, `circle seed ${seed} t ${t}`).toBe(DRIBBLER);
      }
    }
  });

  it('releasing the stick at a jog: a stopping touch rests the ball close in front of him', () => {
    for (const seed of [1, 2, 3]) {
      const s = world(seed);
      for (let t = 0; t < 120; t++) { stick(s, DRIBBLER, 1, 0); tick(s); }
      let touches = 0;
      for (let t = 0; t < 180; t++) { stick(s, DRIBBLER, 0, 0); touches += tick(s).filter(isTouch).length; }
      const p = s.players[DRIBBLER]!;
      expect(s.ball.owner).toBe(DRIBBLER);
      expect(Math.hypot(p.vx, p.vz)).toBe(0);
      expect(Math.hypot(s.ball.vx, s.ball.vz)).toBe(0);
      expect(dist(s, DRIBBLER)).toBeLessThan(T_DRIBBLE.controlRadius);
      expect(s.ball.x - p.x).toBeGreaterThan(0.2);
      expect(touches).toBeLessThanOrEqual(4); // one stopping touch (+ at most a correction or two), no touch spam
      // Standing with the ball at rest at his feet: no more touches.
      for (let t = 0; t < 60; t++) { stick(s, DRIBBLER, 0, 0); expect(tick(s).filter(isTouch)).toHaveLength(0); }
    }
  });

  it('a standing owner sets off in any direction with the ball (first touch pushes it the new way)', () => {
    const s = world(6);
    for (let t = 0; t < 30; t++) { stick(s, DRIBBLER, 0, 0); tick(s); }
    for (let t = 0; t < 120; t++) { stick(s, DRIBBLER, -1, 0); tick(s); }
    expect(s.ball.owner).toBe(DRIBBLER);
    expect(s.ball.x).toBeLessThan(s.players[DRIBBLER]!.x);
  });

  it('a sprint knock-on that he turns away from runs loose (it is out of his reach): the brief\'s heavy sprint touch', () => {
    const s = world(1);
    for (let t = 0; t < 150; t++) { stick(s, DRIBBLER, 1, 0, 1); tick(s); }
    let lost = -1;
    for (let t = 0; t < 120 && lost < 0; t++) {
      stick(s, DRIBBLER, 0, 1, 1);
      tick(s);
      if (s.ball.owner < 0) lost = t;
    }
    expect(lost).toBeGreaterThanOrEqual(0);
    expect(dist(s, DRIBBLER)).toBeGreaterThan(T_DRIBBLE.loseRadius);
  });
});

describe('SIM-06 touch quality', () => {
  /** Mean |sideways error| of the ball at each touch-to-touch cycle and mean gap, over several seeds. */
  function erratic(attr: number, stamina: number): { side: number; gap: number; lead: number } {
    let side = 0, gap = 0, lead = 0, n = 0, ng = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const s = world(seed);
      const a = s.attrs[DRIBBLER]!;
      a.dribbling = attr; a.ballControl = attr; a.agility = attr;
      s.players[DRIBBLER]!.stamina = stamina;
      const r = runStraight(s, 480, 1);
      side += r.maxSide; lead += r.maxLead; n++;
      for (const g of r.gaps) { gap += g; ng++; }
    }
    return { side: side / n, gap: gap / Math.max(1, ng), lead: lead / n };
  }

  it('a poor dribbler errs more and pushes further than a great one; low stamina makes touches worse', () => {
    const good = erratic(95, 1);
    const poor = erratic(15, 1);
    const tired = erratic(95, 0.05);
    expect(poor.side).toBeGreaterThan(good.side * 1.5);
    expect(poor.lead).toBeGreaterThan(good.lead);
    expect(tired.side).toBeGreaterThan(good.side);
  });

  it('a poor dribbler waits longer between touches (cooldown after a regular touch)', () => {
    const cd = (attr: number): number => {
      const s = world(2);
      const a = s.attrs[DRIBBLER]!;
      a.dribbling = attr; a.ballControl = attr; a.agility = attr;
      let sum = 0, n = 0;
      for (let t = 0; t < 480; t++) {
        stick(s, DRIBBLER, 1, 0);
        if (tick(s).some(isTouch) && t > 60) { sum += s.players[DRIBBLER]!.touchCd + 1; n++; }
      }
      return sum / n;
    };
    expect(cd(10)).toBeGreaterThan(cd(95) + 3);
  });
});

describe('SIM-06 holds: kick wind-up and shielding', () => {
  it('KICK / SHOT wind-up: the ball is held on the kicking spot (holdAhead in front), slowing it', () => {
    for (const act of [ActionKind.KICK, ActionKind.SHOT]) {
      const s = world(1);
      const p = s.players[DRIBBLER]!;
      for (let t = 0; t < 100; t++) { stick(s, DRIBBLER, 1, 0); tick(s); }
      p.act = act; p.actT = 0; p.actDur = 60; p.actContact = 40; p.actDone = 0; p.moveMode = MoveMode.LOCKED;
      s.ball.vx += 3; // a loose-ish ball running on
      for (let t = 0; t < 30; t++) tick(s);
      const sx = p.x + p.fx * L.holdAhead, sz = p.z + p.fz * L.holdAhead;
      expect(s.ball.owner).toBe(DRIBBLER);
      expect(Math.hypot(s.ball.x - sx, s.ball.z - sz)).toBeLessThan(0.08);
      expect(Math.hypot(s.ball.vx - p.vx, s.ball.vz - p.vz)).toBeLessThan(0.5);
      expect(canTouchBall(s, DRIBBLER)).toBe(true);
      // After contact (actDone) nothing holds it any more.
      p.actDone = 1;
      s.ball.vx = p.vx + 4;
      tick(s);
      expect(s.ball.vx).toBeGreaterThan(p.vx + 3);
    }
  });

  it('SKILL: held before its contact tick only (afterwards SIM-13 scripts the ball)', () => {
    const s = world(1);
    const p = s.players[DRIBBLER]!;
    p.act = ActionKind.SKILL; p.actT = 0; p.actDur = 30; p.actContact = 5; p.actDone = 0; p.moveMode = MoveMode.LOCKED;
    s.ball.x = p.x + 0.8; s.ball.vx = 2;
    for (let t = 0; t < 4; t++) { p.actT++; tick(s); }
    expect(s.ball.vx).toBeLessThan(0); // pulled back toward the spot
    p.actT = 6;
    s.ball.vx = 2.5;
    const vx = s.ball.vx;
    tick(s);
    expect(s.ball.vx).toBeLessThan(vx); // rolling friction only
    expect(s.ball.vx).toBeGreaterThan(vx - 0.1);
    expect(s.ball.owner).toBe(DRIBBLER);
  });

  it('shielding: the ball is kept on the far side of his body from the challenger', () => {
    const s = world(2, 0, 0);
    const p = s.players[DRIBBLER]!;
    p.act = ActionKind.SHIELD; p.actT = 2; p.actDur = 1000; p.shielding = 1;
    const o = s.players[OPP]!;
    o.x = 1.6; o.z = 0.4;
    s.ball.x = 0.5; s.ball.z = 0; // between them at first
    for (let t = 0; t < 60; t++) { p.moveMode = MoveMode.STOP; tick(s); }
    expect(s.ball.owner).toBe(DRIBBLER);
    // Ball behind him, on the line away from the challenger.
    const ux = (p.x - o.x) / Math.hypot(p.x - o.x, p.z - o.z), uz = (p.z - o.z) / Math.hypot(p.x - o.x, p.z - o.z);
    const bx = s.ball.x - p.x, bz = s.ball.z - p.z;
    expect(bx * ux + bz * uz).toBeGreaterThan(0.4);
    expect(Math.abs(bx * uz - bz * ux)).toBeLessThan(0.1);
  });
});

describe('SIM-06 steals between touches', () => {
  /** Sprint until a touch has just sent the ball ahead (out of his reach), then put an opponent in its path. */
  function sprintAndBlock(seed: number, oppVx: number): { s: SimState; ev: SimEvent[] } {
    const s = world(seed);
    let sent = false;
    for (let t = 0; t < 400 && !sent; t++) {
      stick(s, DRIBBLER, 1, 0, 1);
      const ev = tick(s);
      if (t > 100 && ev.some(isTouch)) sent = true;
    }
    for (let t = 0; t < 30; t++) { stick(s, DRIBBLER, 1, 0, 1); tick(s); }
    expect(dist(s, DRIBBLER)).toBeGreaterThan(reachOf(s, DRIBBLER));
    const o = s.players[OPP]!;
    o.x = s.ball.x + s.ball.vx * 0.05 + 0.2; o.z = s.ball.z + 0.3; o.vx = oppVx; o.vz = 0; o.fx = -1; o.fz = 0;
    const ev: SimEvent[] = [];
    for (let t = 0; t < 20; t++) {
      stick(s, DRIBBLER, 1, 0, 1);
      if (oppVx > 0) stick(s, OPP, 1, 0, 1); else s.players[OPP]!.moveMode = MoveMode.STOP;
      ev.push(...tick(s));
      if (s.ball.owner !== DRIBBLER) break;
    }
    return { s, ev };
  }

  it('an opponent running with the knocked-on ball takes it (POSSESSION, dribbler locked out for dispossessedNoTouch)', () => {
    for (const seed of [1, 2, 3]) {
      const { s, ev } = sprintAndBlock(seed, 7.5);
      expect(s.ball.owner, `seed ${seed}`).toBe(OPP);
      expect(ev.filter((e) => e.type === EventType.POSSESSION && e.a === 1 && e.b === OPP)).toHaveLength(1);
      expect(s.players[DRIBBLER]!.noTouchT).toBeGreaterThan(T_DRIBBLE.dispossessedNoTouch - 10);
      expect(s.ball.lastTouch).toBe(OPP);
    }
  });

  it('a standing opponent in the path of a fast sprint touch blocks it: deflected, loose, last touch his', () => {
    for (const seed of [1, 2, 3]) {
      const { s, ev } = sprintAndBlock(seed, 0);
      expect(s.ball.owner, `seed ${seed}`).toBe(-1);
      const defl = ev.filter((e) => e.type === EventType.KICK && e.b === KickKind.DEFLECTION);
      expect(defl).toHaveLength(1);
      expect(defl[0]!.a).toBe(OPP);
      expect(s.ball.lastTouch).toBe(OPP);
      expect(s.ball.vx).toBeLessThan(4); // it bounced off his feet
      expect(s.players[DRIBBLER]!.noTouchT).toBeGreaterThan(0);
    }
  });

  it('a ball within the owner\'s reach is never taken by an opponent next to it (he must tackle)', () => {
    const s = world(1, 0, 0);
    const o = s.players[OPP]!;
    o.x = 1.2; o.z = 0;
    for (let t = 0; t < 120; t++) { stick(s, DRIBBLER, 0, 0); o.moveMode = MoveMode.STOP; tick(s); }
    expect(s.ball.owner).toBe(DRIBBLER);
  });

  it('teammates never steal from the dribbler', () => {
    const s = world(1);
    let sent = false;
    for (let t = 0; t < 400 && !sent; t++) { stick(s, DRIBBLER, 1, 0, 1); if (t > 100 && tick(s).some(isTouch)) sent = true; else if (t <= 100) tick(s); }
    for (let t = 0; t < 30; t++) { stick(s, DRIBBLER, 1, 0, 1); tick(s); }
    const m = s.players[MATE]!;
    m.x = s.ball.x + 0.3; m.z = s.ball.z;
    for (let t = 0; t < 20; t++) { stick(s, DRIBBLER, 1, 0, 1); m.moveMode = MoveMode.STOP; tick(s); }
    expect(s.ball.owner).toBe(DRIBBLER);
  });
});

describe('SIM-06 loose-ball pick-up', () => {
  function loose(ballX: number, ballZ: number, vx = 0, vz = 0, y = 0.11): SimState {
    const s = world(1, -30, 0, false);
    Object.assign(s.ball, { x: ballX, z: ballZ, px: ballX, pz: ballZ, y, py: y, vx, vz, vy: 0, grounded: y <= 0.12 ? 1 : 0, owner: -1, lastTouch: -1, lastTouchTeam: -1 });
    s.players[DRIBBLER]!.x = 0; s.players[DRIBBLER]!.z = 0;
    return s;
  }

  it('the nearest eligible player within controlRadius takes a slow low ball (and controls it at once)', () => {
    const s = loose(0.6, 0);
    s.players[OPP]!.x = 1.3; s.players[OPP]!.z = 0; // 0.7 m away: further than the dribbler (0.6 m)
    const ev = tick(s);
    expect(s.ball.owner).toBe(DRIBBLER);
    expect(ev.filter((e) => e.type === EventType.POSSESSION)).toHaveLength(1);
    expect(s.ball.touchedTick).toBe(s.tick);
  });

  it('ties are broken deterministically: closest, then the lower slot', () => {
    for (const [a, b] of [[DRIBBLER, OPP], [OPP, DRIBBLER], [3, 18]] as const) {
      const s = loose(0, 0);
      s.players[DRIBBLER]!.x = 40;
      s.players[a]!.x = -0.5; s.players[a]!.z = 0;
      s.players[b]!.x = 0.5; s.players[b]!.z = 0;
      tick(s);
      expect(s.ball.owner).toBe(Math.min(a, b));
    }
  });

  it('not when the ball is too fast, too high, in the net, or out of reach', () => {
    const fast = loose(0.5, 0, L.pickUpMaxSpeed + 0.5, 0);
    tick(fast);
    expect(fast.ball.owner).toBe(-1);
    const high = loose(0.5, 0, 0, 0, T_DRIBBLE.controlHeight + 0.4);
    tick(high);
    expect(high.ball.owner).toBe(-1);
    const far = loose(T_DRIBBLE.controlRadius + 0.05, 0);
    tick(far);
    expect(far.ball.owner).toBe(-1);
    const net = loose(53.2, 0);
    net.ball.inNet = 1;
    net.players[11]!.x = 52.5; net.players[11]!.z = 0; // keeper on his line, the ball 0.7 m away in his net
    tick(net);
    expect(net.ball.inNet).toBe(1);
    expect(net.ball.owner).toBe(-1);
  });

  it('not by ineligible players: stunned, fallen, noTouchT, tackling, skilling, inactive, after a kick contact', () => {
    const setups: ((s: SimState) => void)[] = [
      (s) => { s.players[DRIBBLER]!.stunT = 10; },
      (s) => { s.players[DRIBBLER]!.act = ActionKind.FALLEN; s.players[DRIBBLER]!.actDur = 100; },
      (s) => { s.players[DRIBBLER]!.noTouchT = 5; },
      (s) => { s.players[DRIBBLER]!.act = ActionKind.SLIDE_TACKLE; s.players[DRIBBLER]!.actDur = 100; },
      (s) => { s.players[DRIBBLER]!.act = ActionKind.SKILL; s.players[DRIBBLER]!.actDur = 100; },
      (s) => { s.players[DRIBBLER]!.act = ActionKind.GK_DIVE; s.players[DRIBBLER]!.actDur = 100; },
      (s) => { s.players[DRIBBLER]!.act = ActionKind.KICK; s.players[DRIBBLER]!.actDur = 100; s.players[DRIBBLER]!.actDone = 1; },
    ];
    for (const set of setups) {
      const s = loose(0.4, 0);
      set(s);
      tick(s);
      expect(s.ball.owner).toBe(-1);
    }
  });

  it('a player in a KICK wind-up (first time) may take it: the ball goes onto his kicking spot', () => {
    const s = loose(0.7, 0, -1, 0);
    const p = s.players[DRIBBLER]!;
    p.act = ActionKind.KICK; p.actDur = 40; p.actContact = 20; p.actDone = 0; p.moveMode = MoveMode.LOCKED;
    tick(s);
    expect(s.ball.owner).toBe(DRIBBLER);
    for (let t = 0; t < 20; t++) tick(s);
    expect(Math.abs(s.ball.x - (p.x + L.holdAhead))).toBeLessThan(0.05);
  });

  it('no pick-up when another contact stage touched the ball this tick (one contact per tick)', () => {
    const s = loose(0.4, 0);
    // Emulate an earlier contact stage of this tick.
    s.tick++;
    evb.begin(s.tick);
    recordTouch(s, OPP);
    dribbleTick(s, evb);
    expect(s.ball.owner).toBe(-1);
  });

  it('the kicker cannot re-pick his own soft kick for selfKickTicks', () => {
    const s = loose(0.4, 0, 3, 0);
    Object.assign(s.ball, { lastKickBy: DRIBBLER, lastKickTick: s.tick, lastKickKind: KickKind.GROUND_PASS });
    tick(s);
    expect(s.ball.owner).toBe(-1);
    const t = loose(0.4, 0, 0, 0);
    Object.assign(t.ball, { lastKickBy: DRIBBLER, lastKickTick: t.tick - L.selfKickTicks, lastKickKind: KickKind.GROUND_PASS });
    tick(t);
    expect(t.ball.owner).toBe(DRIBBLER);
  });

  it('a slow pass rolling across an opponent is picked up by him; the change of team emits POSSESSION once', () => {
    const s = loose(-3, 0, 4.5, 0);
    s.ball.lastTouch = MATE; s.ball.lastTouchTeam = 0;
    s.players[DRIBBLER]!.x = 40;
    s.players[OPP]!.x = 0; s.players[OPP]!.z = 0.3;
    const ev: SimEvent[] = [];
    for (let t = 0; t < 60 && s.ball.owner < 0; t++) ev.push(...tick(s));
    expect(s.ball.owner).toBe(OPP);
    expect(ev.filter((e) => e.type === EventType.POSSESSION)).toEqual([expect.objectContaining({ a: 1, b: OPP })]);
  });

  it('nothing happens outside IN_PLAY (restarts belong to the rules), but the countdowns run', () => {
    for (const phase of [MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.CORNER, MatchPhase.GOAL, MatchPhase.SHOOT_OUT]) {
      const s = loose(0.4, 0);
      s.match.phase = phase;
      s.players[OPP]!.noTouchT = 3; s.players[OPP]!.touchCd = 2;
      tick(s);
      expect(s.ball.owner).toBe(-1);
      expect([s.players[OPP]!.noTouchT, s.players[OPP]!.touchCd]).toEqual([2, 1]);
    }
  });
});

describe('SIM-06 possession loss', () => {
  it('the ball beyond loseRadius from the owner is loose', () => {
    const s = world(1, 0, 0);
    s.ball.x = T_DRIBBLE.loseRadius + 0.05; s.ball.vx = 3;
    const ev = tick(s);
    expect(s.ball.owner).toBe(-1);
    expect(ev.filter((e) => e.type === EventType.POSSESSION)).toHaveLength(0);
  });

  it('owner stunned, fallen, stumbling, tackling, diving, celebrating or sent off -> loose', () => {
    const setups: [string, (s: SimState) => void][] = [
      ['stunned', (s) => { s.players[DRIBBLER]!.stunT = 5; }],
      ['fallen', (s) => { s.players[DRIBBLER]!.act = ActionKind.FALLEN; s.players[DRIBBLER]!.actDur = 50; }],
      ['stumble', (s) => { s.players[DRIBBLER]!.act = ActionKind.STUMBLE; s.players[DRIBBLER]!.actDur = 50; }],
      ['get up', (s) => { s.players[DRIBBLER]!.act = ActionKind.GET_UP; s.players[DRIBBLER]!.actDur = 50; }],
      ['tackle', (s) => { s.players[DRIBBLER]!.act = ActionKind.STAND_TACKLE; s.players[DRIBBLER]!.actDur = 50; }],
      ['dive', (s) => { s.players[DRIBBLER]!.act = ActionKind.GK_DIVE; s.players[DRIBBLER]!.actDur = 50; }],
      ['celebrate', (s) => { s.players[DRIBBLER]!.act = ActionKind.CELEBRATE; s.players[DRIBBLER]!.actDur = 50; }],
      ['sent off', (s) => { s.players[DRIBBLER]!.active = 0; }],
    ];
    for (const [name, set] of setups) {
      const s = world(1, 0, 0);
      set(s);
      tick(s);
      expect(s.ball.owner, name).toBe(-1);
    }
  });

  it('ball actions keep possession (kick / shot wind-up, skill, fake, shield, first touch, header, keeper hands)', () => {
    for (const act of [ActionKind.KICK, ActionKind.SHOT, ActionKind.SKILL, ActionKind.FAKE, ActionKind.SHIELD, ActionKind.FIRST_TOUCH, ActionKind.HEADER, ActionKind.VOLLEY]) {
      const s = world(1, 0, 0);
      const p = s.players[DRIBBLER]!;
      p.act = act; p.actDur = 50; p.actContact = 30;
      tick(s);
      expect(s.ball.owner, ActionKind[act]).toBe(DRIBBLER);
    }
  });

  it('a ball in a keeper\'s hands is left to GKP-05 (owner kept equal to heldBy)', () => {
    const s = world(1, 0, 0);
    const k = 0;
    const kp = s.players[k]!;
    kp.x = -45; kp.z = 0;
    Object.assign(s.ball, { x: -44.6, z: 0, y: 1.2, owner: 3, heldBy: k });
    const x = s.ball.x;
    tick(s);
    expect([s.ball.owner, s.ball.heldBy]).toEqual([k, k]);
    expect(s.ball.x).toBe(x);
  });
});

describe('SIM-06 glitch list', () => {
  it('glitch "Ball stuck: between two players" - two equidistant players: resolved at once to the lower slot', () => {
    const s = world(1, 0, 0, false);
    Object.assign(s.ball, { x: 0, z: 0, vx: 0, vz: 0, owner: -1 });
    s.players[DRIBBLER]!.x = -0.45; s.players[DRIBBLER]!.z = 0;
    s.players[OPP]!.x = 0.45; s.players[OPP]!.z = 0;
    tick(s);
    expect(s.ball.owner).toBe(DRIBBLER);
  });

  it('glitch "Ball stuck: between two players" - neither can take it (both stunned): it squirts out at right angles', () => {
    const s = world(1, 0, 0, false);
    Object.assign(s.ball, { x: 0, z: 0, vx: 0, vz: 0, owner: -1, idleT: 0 });
    for (const [slot, x] of [[DRIBBLER, -0.45], [OPP, 0.45]] as const) {
      const p = s.players[slot]!;
      p.x = x; p.z = 0; p.stunT = 10_000;
    }
    let moved = -1;
    for (let t = 0; t < 120 && moved < 0; t++) {
      s.ball.idleT++; // step() counts idle ticks in play; the mini pipeline does it here
      tick(s);
      if (Math.hypot(s.ball.vx, s.ball.vz) > 0) moved = t;
    }
    expect(moved).toBeGreaterThanOrEqual(L.stuckTicks - 2);
    expect(moved).toBeLessThanOrEqual(L.stuckTicks + 1);
    expect(Math.abs(s.ball.vz)).toBeGreaterThan(Math.abs(s.ball.vx) * 10); // perpendicular to the pair
    for (let t = 0; t < 120; t++) tick(s);
    expect(Math.min(dist(s, DRIBBLER), dist(s, OPP))).toBeGreaterThan(L.stuckRadius);
    expect(s.ball.lastTouch).toBe(DRIBBLER); // the nearest body (tie: lower slot)
  });

  it('glitch "Ball stuck: between two players" - an owner and an opponent face to face: never a frozen loose ball', () => {
    // Owner standing with the ball between him and a pressing opponent: the owner keeps it (the opponent must
    // tackle); when the owner falls the opponent takes it at once.
    const s = world(1, 0, 0);
    s.ball.x = 0.45;
    const o = s.players[OPP]!;
    o.x = 0.9; o.z = 0;
    for (let t = 0; t < 60; t++) { stick(s, DRIBBLER, 0, 0); o.moveMode = MoveMode.STOP; tick(s); }
    expect(s.ball.owner).toBe(DRIBBLER);
    const p = s.players[DRIBBLER]!;
    p.act = ActionKind.FALLEN; p.actDur = 500; p.stunT = 500;
    tick(s);
    expect(s.ball.owner).toBe(OPP);
  });

  it('glitch "Ball stuck: under a sliding player" - a ball resting under a slider squirts out, then a teammate takes it', () => {
    for (const act of [ActionKind.SLIDE_TACKLE, ActionKind.FALLEN]) {
      const s = world(2, 0, 0, false);
      const slider = s.players[OPP]!;
      slider.x = 0; slider.z = 0; slider.fx = 0; slider.fz = 1;
      slider.act = act; slider.actDur = 10_000; slider.stunT = act === ActionKind.FALLEN ? 10_000 : 0;
      Object.assign(s.ball, { x: 0.05, z: 0, vx: 0, vz: 0, owner: -1, idleT: 0 });
      s.players[DRIBBLER]!.x = -10;
      // A teammate 2 m away cannot reach it (bodies keep him off the slider) until it squirts out.
      const mate = s.players[MATE]!;
      mate.x = 0; mate.z = 2;
      let freed = -1;
      for (let t = 0; t < 300 && s.ball.owner < 0; t++) {
        s.ball.idleT = s.ball.touchedTick === s.tick ? 0 : s.ball.idleT + 1;
        if (freed < 0) mate.moveMode = MoveMode.STOP;
        else { mate.moveMode = MoveMode.ARRIVE; mate.tgtX = s.ball.x; mate.tgtZ = s.ball.z; mate.tgtSpeed = 3; }
        tick(s);
        if (freed < 0 && dist(s, OPP) > L.stuckRadius) freed = t;
      }
      expect(freed, ActionKind[act]).toBeGreaterThanOrEqual(L.stuckTicks - 2);
      expect(freed).toBeLessThan(L.stuckTicks + 30);
      expect(s.ball.owner).toBe(MATE);
      expect(s.ball.x).toBeGreaterThan(0.5); // squirted out away from the slider's body
    }
  });

  it('glitch "Ball stuck: under a sliding player" - the owner going down under the ball loses it to the nearest eligible player', () => {
    const s = world(1, 0, 0);
    s.ball.x = 0.1;
    s.players[OPP]!.x = 0.8; s.players[OPP]!.z = 0.2;
    const p = s.players[DRIBBLER]!;
    p.act = ActionKind.SLIDE_TACKLE; p.actDur = 100;
    tick(s);
    expect(s.ball.owner).toBe(OPP);
  });
});

describe('SIM-06 countdowns, canTouchBall, determinism', () => {
  it('touchCd and noTouchT count down once per tick for every player; ownerT counts up while owned', () => {
    const s = world(1);
    for (let i = 0; i < NUM_SLOTS; i++) { s.players[i]!.noTouchT = 5 + i; if (i !== DRIBBLER) s.players[i]!.touchCd = 3; }
    s.ball.ownerT = 7;
    for (let t = 0; t < 4; t++) tick(s);
    for (let i = 0; i < NUM_SLOTS; i++) {
      expect(s.players[i]!.noTouchT).toBe(1 + i);
      if (i !== DRIBBLER) expect(s.players[i]!.touchCd).toBe(0);
    }
    expect(s.ball.ownerT).toBe(11);
    s.players[3]!.noTouchT = Number.NaN;
    tick(s);
    expect(s.players[3]!.noTouchT).toBe(0);
  });

  it('canTouchBall: distance, height, stun, down states, noTouchT, another player\'s hands', () => {
    const s = world(1, 0, 0);
    s.ball.x = 0.8;
    expect(canTouchBall(s, DRIBBLER)).toBe(true);
    s.ball.x = T_DRIBBLE.controlRadius + 0.01;
    expect(canTouchBall(s, DRIBBLER)).toBe(false);
    s.ball.x = 0.5; s.ball.y = T_DRIBBLE.controlHeight + 0.01;
    expect(canTouchBall(s, DRIBBLER)).toBe(false);
    s.ball.y = 0.11;
    const p = s.players[DRIBBLER]!;
    p.stunT = 1; expect(canTouchBall(s, DRIBBLER)).toBe(false); p.stunT = 0;
    p.noTouchT = 1; expect(canTouchBall(s, DRIBBLER)).toBe(false); p.noTouchT = 0;
    p.act = ActionKind.FALLEN; expect(canTouchBall(s, DRIBBLER)).toBe(false); p.act = ActionKind.STAND_TACKLE;
    expect(canTouchBall(s, DRIBBLER)).toBe(true); p.act = ActionKind.NONE;
    s.ball.heldBy = 0; expect(canTouchBall(s, DRIBBLER)).toBe(false); s.ball.heldBy = -1;
    p.active = 0; expect(canTouchBall(s, DRIBBLER)).toBe(false); p.active = 1;
    expect(canTouchBall(s, -1)).toBe(false);
    expect(canTouchBall(s, NUM_SLOTS)).toBe(false);
  });

  it('deterministic: the same dribble twice gives the same state hash; another seed differs', () => {
    const run = (seed: number): number => {
      const s = world(seed);
      for (let t = 0; t < 600; t++) {
        const phase = Math.floor(t / 90) % 4;
        stick(s, DRIBBLER, phase === 1 ? 0 : 1, phase === 1 ? 1 : phase === 3 ? -0.5 : 0, phase === 2 ? 1 : 0);
        tick(s);
      }
      return hashState(s);
    };
    expect(run(11)).toBe(run(11));
    expect(run(11)).not.toBe(run(12));
  });
});
