/** FND-03: tests for the lead-owned ball contact bookkeeping in src/sim/core/kick.ts. */
import { describe, expect, it } from 'vitest';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createKickLaunch, type KickLaunch } from '../../src/contracts/systems';
import { RESTART_PHASES } from '../../src/contracts/transitions';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick, ballTouchedThisTick, recordTouch, releasePossession, takePossession } from '../../src/sim/core/kick';
import { initMatch } from '../../src/sim/init';

function setup(): { s: SimState; ev: ReturnType<typeof createEventBuffer> } {
  const s = initMatch(createMatchConfig());
  s.tick = 100;
  s.match.phase = MatchPhase.IN_PLAY;
  const ev = createEventBuffer();
  ev.begin(s.tick);
  return { s, ev };
}

function launch(kind: KickKind, over: Partial<KickLaunch> = {}): KickLaunch {
  const l = createKickLaunch();
  l.kind = kind;
  l.vx = 10; l.vy = 0; l.vz = 2; l.sx = 1; l.sy = -3; l.sz = 0.5;
  l.target = 7; l.tx = 20; l.tz = -5; l.onTarget = 0;
  return Object.assign(l, over);
}

const events = (ev: ReturnType<typeof createEventBuffer>): SimEvent[] => ev.toArray();

describe('recordTouch', () => {
  it('records last touch, team, ticks and resets idle', () => {
    const { s } = setup();
    s.ball.idleT = 50;
    recordTouch(s, 14);
    expect(s.ball.lastTouch).toBe(14);
    expect(s.ball.lastTouchTeam).toBe(1);
    expect(s.ball.lastTouchTick).toBe(100);
    expect(s.ball.touchedTick).toBe(100);
    expect(s.ball.idleT).toBe(0);
    expect(s.players[14]!.lastTouchTick).toBe(100);
    expect(ballTouchedThisTick(s)).toBe(true);
    s.tick++;
    expect(ballTouchedThisTick(s)).toBe(false);
  });

  it('clears a shot in flight only when someone else touches it', () => {
    const { s } = setup();
    s.ball.shotBy = 9;
    recordTouch(s, 9);
    expect(s.ball.shotBy).toBe(9);
    recordTouch(s, 11);
    expect(s.ball.shotBy).toBe(-1);
  });
});

describe('takePossession', () => {
  it('sets the owner, resets ownerT on change, clears the pass target and records the touch', () => {
    const { s, ev } = setup();
    s.ball.passTarget = 4;
    s.ball.ownerT = 30;
    takePossession(s, 4, ev);
    expect(s.ball.owner).toBe(4);
    expect(s.ball.ownerT).toBe(0);
    expect(s.ball.passTarget).toBe(-1);
    expect(s.ball.lastTouch).toBe(4);
    s.ball.ownerT = 12;
    takePossession(s, 4, ev); // same owner again keeps ownerT
    expect(s.ball.ownerT).toBe(12);
  });

  it('emits POSSESSION(team, slot) when the possessing team changes, not for a teammate hand-over', () => {
    const { s, ev } = setup();
    takePossession(s, 5, ev);
    expect(events(ev).map((e) => [e.type, e.a, e.b])).toEqual([[EventType.POSSESSION, 0, 5]]);
    ev.begin(s.tick);
    takePossession(s, 6, ev); // teammate takes over directly
    expect(events(ev)).toEqual([]);
    takePossession(s, 15, ev); // opponent wins it
    expect(events(ev).map((e) => [e.type, e.a, e.b, e.tick])).toEqual([[EventType.POSSESSION, 1, 15, 100]]);
  });

  it('current behaviour: a loose ball collected by the same team emits POSSESSION again', () => {
    // Documented in the FND-03 report: prevTeam is derived from the owner only, so pass receptions after
    // applyKick (which releases the ball) re-emit POSSESSION for the same team.
    const { s, ev } = setup();
    takePossession(s, 5, ev);
    applyKick(s, 5, launch(KickKind.GROUND_PASS), 0.5, ev);
    ev.begin(s.tick);
    takePossession(s, 7, ev);
    expect(events(ev).filter((e) => e.type === EventType.POSSESSION).map((e) => e.a)).toEqual([0]);
  });
});

describe('releasePossession', () => {
  it('makes the ball loose without events when not held', () => {
    const { s, ev } = setup();
    takePossession(s, 3, ev);
    ev.begin(s.tick);
    s.ball.ownerT = 9;
    releasePossession(s, ev);
    expect(s.ball.owner).toBe(-1);
    expect(s.ball.ownerT).toBe(0);
    expect(events(ev)).toEqual([]);
  });

  it('releases a keeper hold and emits KEEPER_HANDS(keeper, 0)', () => {
    const { s, ev } = setup();
    takePossession(s, 11, ev);
    s.ball.heldBy = 11;
    ev.begin(s.tick);
    releasePossession(s, ev);
    expect(s.ball.heldBy).toBe(-1);
    expect(events(ev).map((e) => [e.type, e.a, e.b])).toEqual([[EventType.KEEPER_HANDS, 11, 0]]);
  });

  it('is a no-op on a loose ball', () => {
    const { s, ev } = setup();
    s.ball.ownerT = 4;
    releasePossession(s, ev);
    expect(s.ball.ownerT).toBe(4);
    expect(ev.count).toBe(0);
  });
});

describe('applyKick', () => {
  it('launches the ball and records all kick bookkeeping', () => {
    const { s, ev } = setup();
    takePossession(s, 8, ev);
    ev.begin(s.tick);
    s.ball.bounces = 3;
    s.ball.inNet = 1;
    s.ball.x = 1; s.ball.y = 0.11; s.ball.z = 2;
    applyKick(s, 8, launch(KickKind.GROUND_PASS), 0.6, ev);
    const b = s.ball;
    expect([b.vx, b.vy, b.vz, b.sx, b.sy, b.sz]).toEqual([10, 0, 2, 1, -3, 0.5]);
    expect(b.owner).toBe(-1);
    expect(b.bounces).toBe(0);
    expect(b.inNet).toBe(0);
    expect(b.grounded).toBe(1);
    expect([b.lastKickBy, b.lastKickTeam, b.lastKickKind, b.lastKickTick]).toEqual([8, 0, KickKind.GROUND_PASS, 100]);
    expect([b.passTarget, b.passX, b.passZ]).toEqual([7, 20, -5]);
    expect([b.lastTouch, b.lastTouchTeam, b.touchedTick]).toEqual([8, 0, 100]);
    expect(b.shotBy).toBe(-1);
    const e = events(ev);
    expect(e.length).toBe(1);
    expect(e[0]).toMatchObject({ type: EventType.KICK, tick: 100, a: 8, b: KickKind.GROUND_PASS, c: 0.6, d: 0, x: 1, y: 0.11, z: 2 });
  });

  it('lifts the ball off the ground only for vy > 0.5', () => {
    const { s, ev } = setup();
    applyKick(s, 2, launch(KickKind.LOB_PASS, { vy: 8 }), 1, ev);
    expect(s.ball.grounded).toBe(0);
    s.ball.grounded = 1;
    applyKick(s, 2, launch(KickKind.GROUND_PASS, { vy: 0.5 }), 1, ev);
    expect(s.ball.grounded).toBe(1);
  });

  it('marks shots (every shot kind) and emits SHOT(slot, onTarget)', () => {
    const shots = [KickKind.SHOT_NORMAL, KickKind.SHOT_FINESSE, KickKind.SHOT_CHIP, KickKind.SHOT_POWER, KickKind.SHOT_LOW_DRIVEN,
      KickKind.HEADER_SHOT, KickKind.VOLLEY_SHOT, KickKind.PENALTY, KickKind.FREE_KICK_SHOT];
    for (let k = KickKind.NONE; k <= KickKind.GK_RELEASE; k++) {
      const { s, ev } = setup();
      applyKick(s, 9, launch(k, { onTarget: 1 }), 0.9, ev);
      const isShot = shots.includes(k);
      expect(s.ball.shotBy).toBe(isShot ? 9 : -1);
      const shotEv = events(ev).filter((e) => e.type === EventType.SHOT);
      if (isShot) {
        expect(s.ball.shotTick).toBe(100);
        expect(s.ball.shotOnTarget).toBe(1);
        expect(shotEv.map((e) => [e.a, e.b])).toEqual([[9, 1]]);
      } else {
        expect(shotEv).toEqual([]);
      }
    }
  });

  it('a non-shot kick clears a previous shot', () => {
    const { s, ev } = setup();
    applyKick(s, 9, launch(KickKind.SHOT_NORMAL), 1, ev);
    applyKick(s, 9, launch(KickKind.GROUND_PASS), 1, ev);
    expect(s.ball.shotBy).toBe(-1);
  });

  it('releases a keeper hold (KEEPER_HANDS before KICK)', () => {
    const { s, ev } = setup();
    takePossession(s, 0, ev);
    s.ball.heldBy = 0;
    ev.begin(s.tick);
    applyKick(s, 0, launch(KickKind.GK_DROP_KICK, { vy: 9 }), 1, ev);
    expect(s.ball.heldBy).toBe(-1);
    expect(events(ev).map((e) => e.type)).toEqual([EventType.KEEPER_HANDS, EventType.KICK]);
  });

  it('sets restart.taken when the restart taker plays the ball in every restart phase', () => {
    for (const phase of RESTART_PHASES) {
      const { s, ev } = setup();
      s.match.phase = phase;
      s.match.restart.taker = 6;
      applyKick(s, 5, launch(KickKind.GROUND_PASS), 1, ev);
      expect(s.match.restart.taken).toBe(0);
      applyKick(s, 6, launch(KickKind.GROUND_PASS), 1, ev);
      expect(s.match.restart.taken).toBe(1);
    }
  });

  it('does not set restart.taken in open play even for the stale taker', () => {
    const { s, ev } = setup();
    s.match.restart.taker = 6;
    applyKick(s, 6, launch(KickKind.GROUND_PASS), 1, ev);
    expect(s.match.restart.taken).toBe(0);
  });

  it('sets restart.taken for the shoot-out kicker', () => {
    const { s, ev } = setup();
    s.match.phase = MatchPhase.SHOOT_OUT;
    s.match.shootout.kicker = 10;
    applyKick(s, 4, launch(KickKind.PENALTY), 1, ev);
    expect(s.match.restart.taken).toBe(0);
    applyKick(s, 10, launch(KickKind.PENALTY), 1, ev);
    expect(s.match.restart.taken).toBe(1);
  });
});
