/**
 * [GKP-06] Penalty and shoot-out keeper through the real step pipeline: on the line centre, the dive committed at
 * the kick's contact tick (AI: the kick-keyed choice; human: restart.side / restart.aimPower as RUL-06 / RUL-07 store
 * it), saves decided only by GKP-02's physical contacts, both ends. SIM-11 startShot / the SHOT handler are replaced
 * by a contract fake (tests/scenario/gkp-06-fakes.ts) that strikes inside the actions stage at its contact tick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./gkp-06-fakes')).mockShot(await o()));

import { GOAL_HALF_WIDTH, HALF_LENGTH, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createActionRequest } from '../../src/contracts/systems';
import { NULL_SINK } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { startShot } from '../../src/sim/kicks/shot';
import {
  aiDiveChoice, createDiveChoice, LOCAL_TUNING as LT, penaltyKeeperSpot,
} from '../../src/sim/keeper/setpieces';
import { awardRestart, isLegalRestartPosition, prepareTakerKick } from '../../src/sim/rules/restart';
import { ShootoutSub, shootoutEnd } from '../../src/sim/rules/shootout';
import { findEvents, makeScenario, runTicks, runUntil, type ScenarioHuman } from '../harness/scenario';
import { SHOT, resetShot } from './gkp-06-fakes';
import { shootoutScenario, untilSub } from './rul-07-helpers';

SHOT.applyKick = applyKick;

beforeEach(() => resetShot());

interface PenScene { s: SimState; attack: number; def: number; keeper: number; taker: number; end: number }

/** A penalty for `attack`, awarded in play and stepped until ready. P1 is a human on the attacking side (so nobody
 *  but the test kicks); humanKeeper adds P2 on the defending side (switching hands him the keeper). */
function penaltyScene(seed: number, attack: number, o: { humanKeeper?: boolean; swap?: boolean; gk?: number } = {}): PenScene {
  const def = attack === 0 ? 1 : 0;
  const humans: ScenarioHuman[] = [{ side: attack }];
  if (o.humanKeeper) humans.push({ side: def });
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans, teams: o.swap ? [{ dir: -1 }, { dir: 1 }] : undefined });
  if (o.swap) for (const p of s.players) { p.x = -p.x; p.fx = -p.fx; } // second-half ends
  const keeper = s.teams[def]!.keeperSlot;
  if (o.gk !== undefined) {
    const a = s.attrs[keeper]!;
    a.gkDiving = o.gk; a.gkHandling = o.gk; a.gkReflexes = o.gk; a.gkPositioning = o.gk;
  }
  const end = s.teams[attack]!.dir;
  awardRestart(s, RestartKind.PENALTY, attack, end * 40, 0, NULL_SINK);
  expect(s.match.phase).toBe(MatchPhase.PENALTY);
  const r = runUntil(s, (st) => st.match.restart.ready === 1, 200, undefined, 'core');
  expect(r.reached).toBe(true);
  runTicks(s, 20, undefined, { check: 'core' });
  return { s, attack, def, keeper, taker: s.match.restart.taker, end };
}

/** The taker starts his penalty now (fake SIM-11 action: contact SHOT.windup ticks later) at (goal line, tz, ty). */
function shoot(sc: PenScene, tz: number, ty: number, speed = 22): void {
  SHOT.useReq = 0;
  SHOT.tx = sc.end * (HALF_LENGTH + 0.6);
  SHOT.tz = tz;
  SHOT.ty = ty;
  SHOT.speed = speed;
  expect(prepareTakerKick(sc.s, sc.taker)).toBe(1);
  const req = createActionRequest();
  req.power = 0.8;
  expect(startShot(sc.s, sc.taker, KickKind.PENALTY, req, NULL_SINK)).toBe(1);
}

interface ContactResult { tick: number; before: number; after: number; events: SimEvent[] }

/** Step until the kick strikes; the keeper's action at the end of the tick before and of the contact tick. */
function untilContact(sc: PenScene, max = 60): ContactResult {
  let prevAct = sc.s.players[sc.keeper]!.act as number;
  const { events, reached } = runUntil(sc.s, (st) => {
    if (st.ball.lastKickTick === st.tick && st.ball.lastKickBy === sc.taker) return true;
    prevAct = st.players[sc.keeper]!.act;
    return false;
  }, max, undefined, 'core');
  expect(reached).toBe(true);
  return { tick: sc.s.tick, before: prevAct, after: sc.s.players[sc.keeper]!.act, events };
}

/** After the strike: 'goal', 'save' (keeper touched it and no goal) or 'other', within max ticks. */
function outcome(sc: PenScene, max = 120): 'goal' | 'save' | 'other' {
  let touched = false;
  const ev = runTicks(sc.s, max, undefined, {
    check: 'core',
    until: (st, tickEv) => {
      if (st.ball.lastTouch === sc.keeper) touched = true;
      return tickEv.some((e) => e.type === EventType.GOAL) || st.match.phase === MatchPhase.GOAL;
    },
  });
  if (findEvents(ev, EventType.GOAL).length > 0) return 'goal';
  return touched ? 'save' : 'other';
}

describe('GKP-06 penalty: keeper on his line', () => {
  it.each([
    [0, false], [1, false], [0, true], [1, true],
  ])('attack %i swap %s: the defending AI keeper walks to his line centre and stays legal', (attack, swap) => {
    const def = attack === 0 ? 1 : 0;
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, humans: [{ side: attack }], teams: swap ? [{ dir: -1 }, { dir: 1 }] : undefined });
    const k = s.teams[def]!.keeperSlot;
    const own = -s.teams[def]!.dir; // his goal line is at own * HALF_LENGTH
    s.players[k]!.x = own * (HALF_LENGTH - 7);
    s.players[k]!.z = 4;
    awardRestart(s, RestartKind.PENALTY, attack, s.teams[attack]!.dir * 40, 0, NULL_SINK);
    runTicks(s, 160, undefined, { check: 'core' });
    const spot = { x: 0, z: 0 };
    penaltyKeeperSpot(s, def, spot);
    expect(spot.x).toBeCloseTo(own * (HALF_LENGTH - LT.penLineDepth), 6);
    const p = s.players[k]!;
    expect(Math.hypot(p.x - spot.x, p.z - spot.z)).toBeLessThan(0.35);
    expect(isLegalRestartPosition(s, k)).toBe(true);
    expect(p.lookAt).toBe(1);
    expect(p.act).toBe(ActionKind.NONE);
  });
});

describe('GKP-06 penalty: AI dive at the contact tick', () => {
  it.each([
    [0, false], [1, false], [0, true], [1, true],
  ])('attack %i swap %s: GK_DIVE starts in the very tick the kick strikes (never before), as aiDiveChoice says', (attack, swap) => {
    let dives = 0, stays = 0;
    for (let seed = 1; seed <= 14; seed++) {
      const sc = penaltyScene(seed, attack, { swap });
      const k = sc.s.players[sc.keeper]!;
      shoot(sc, 2.4, 0.5);
      const c = untilContact(sc);
      const want = createDiveChoice();
      aiDiveChoice(sc.s, sc.taker, sc.keeper, c.tick, want);
      expect(c.before).not.toBe(ActionKind.GK_DIVE);
      if (want.side === 0) {
        stays++;
        expect(c.after).toBe(ActionKind.NONE);
        continue;
      }
      dives++;
      expect(c.after).toBe(ActionKind.GK_DIVE);
      expect(k.actT).toBe(1); // began in this tick's keeper stage, one dispatcher update so far
      expect(Math.sign(k.actDirZ)).toBe(want.side);
      expect(k.actA).toBe(want.height);
    }
    console.log(`GKP-06 AI penalty dives: ${dives} dives, ${stays} stays of 14`);
    expect(dives).toBeGreaterThan(8);
    expect(dives + stays).toBe(14);
  });

  it('the choice is the same whenever it is asked for that kick and does not consume s.rng', () => {
    const sc = penaltyScene(5, 0);
    const a = createDiveChoice(), b = createDiveChoice();
    const rng = { ...sc.s.rng };
    aiDiveChoice(sc.s, sc.taker, sc.keeper, 1234, a);
    aiDiveChoice(sc.s, sc.taker, sc.keeper, 1234, b);
    expect(b).toEqual(a);
    expect(sc.s.rng).toEqual(rng);
  });

  it('no dive before the strike while the power bar is held (charging), then at the contact tick', () => {
    const sc = penaltyScene(2, 0);
    SHOT.useReq = 0; SHOT.tx = sc.end * 53; SHOT.tz = -2.5; SHOT.ty = 0.5;
    expect(prepareTakerKick(sc.s, sc.taker)).toBe(1);
    const req = createActionRequest();
    req.charging = 1;
    expect(startShot(sc.s, sc.taker, KickKind.PENALTY, req, NULL_SINK)).toBe(1);
    const t = sc.s.players[sc.taker]!;
    runTicks(sc.s, 30, undefined, { check: 'core' }); // well past the contact tick, still charging
    expect(t.actCharging).toBe(1);
    expect(sc.s.players[sc.keeper]!.act).toBe(ActionKind.NONE);
    expect(sc.s.ball.lastKickTick).toBeLessThan(0);
    t.actCharging = 0; // released (what the resolver does on the button release)
    const c = untilContact(sc, 5);
    expect(c.tick).toBe(sc.s.tick);
    const want = createDiveChoice();
    aiDiveChoice(sc.s, sc.taker, sc.keeper, c.tick, want);
    expect(c.after).toBe(want.side === 0 ? ActionKind.NONE : ActionKind.GK_DIVE);
  });
});

describe('GKP-06 penalty: human dive choice and physical saves', () => {
  it.each([0, 1])('attack %i: P2 on the keeper; restart.side / aimPower are honoured at the contact tick', (attack) => {
    for (const [side, height] of [[1, 2], [-1, 0], [1, 1], [-1, 2]] as const) {
      const sc = penaltyScene(7, attack, { humanKeeper: true });
      expect(sc.s.ctrl[1]!.slot).toBe(sc.keeper);
      const r = sc.s.match.restart;
      r.side = side;
      r.aimPower = height;
      shoot(sc, 0.0, 1.0);
      const c = untilContact(sc);
      expect(c.before).not.toBe(ActionKind.GK_DIVE);
      expect(c.after).toBe(ActionKind.GK_DIVE);
      const k = sc.s.players[sc.keeper]!;
      expect(Math.sign(k.actDirZ)).toBe(side);
      expect(k.actA).toBe(height);
    }
  });

  it('a human who chose nothing (side 0) does not dive at the kick; GKP-02 then saves a shot at him standing', () => {
    const sc = penaltyScene(8, 0, { humanKeeper: true, gk: 80 });
    shoot(sc, 0.25, 1.0, 18);
    const c = untilContact(sc);
    expect(c.after).not.toBe(ActionKind.GK_DIVE);
    expect(outcome(sc)).toBe('save');
  });

  it.each([0, 1])('attack %i: right way + within reach = save; wrong way = goal; right way but out of reach = goal', (attack) => {
    // Right way, ball within his dive (2.3 m out, mid height).
    let sc = penaltyScene(9, attack, { humanKeeper: true, gk: 80 });
    sc.s.match.restart.side = 1; sc.s.match.restart.aimPower = 1;
    shoot(sc, 2.3, 0.9);
    untilContact(sc);
    expect(outcome(sc)).toBe('save');
    // Wrong way: the same shot goes in.
    sc = penaltyScene(9, attack, { humanKeeper: true, gk: 80 });
    sc.s.match.restart.side = -1; sc.s.match.restart.aimPower = 1;
    shoot(sc, 2.3, 0.9);
    untilContact(sc);
    expect(outcome(sc)).toBe('goal');
    // Right way, but inside the post at full speed and a weak diver: beyond his reach in time.
    sc = penaltyScene(9, attack, { humanKeeper: true, gk: 1 });
    sc.s.match.restart.side = 1; sc.s.match.restart.aimPower = 1;
    shoot(sc, GOAL_HALF_WIDTH - 0.3, 1.2, 30);
    untilContact(sc);
    expect(outcome(sc)).toBe('goal');
  });

  it('the dive is a GKP-02 dive: it always ends (no stuck dive) and the keeper gets up', () => {
    const sc = penaltyScene(10, 1, { humanKeeper: true });
    sc.s.match.restart.side = -1; sc.s.match.restart.aimPower = 0;
    shoot(sc, 2.5, 0.4);
    untilContact(sc);
    const k = sc.s.players[sc.keeper]!;
    expect(k.act).toBe(ActionKind.GK_DIVE);
    const r = runUntil(sc.s, (st) => st.players[sc.keeper]!.act !== ActionKind.GK_DIVE, 200, undefined, 'core');
    expect(r.reached).toBe(true);
  });
});

describe('GKP-06 shoot-out keeper', () => {
  it.each([21, 22, 23])('CPU v CPU (seed %i): each defending keeper commits at the contact tick as aiDiveChoice says', (seed) => {
    const s = shootoutScenario(seed);
    const so = s.match.shootout;
    let checked = 0;
    for (let kick = 0; kick < 6 && s.match.phase === MatchPhase.SHOOT_OUT; kick++) {
      untilSub(s, ShootoutSub.AIM);
      const keeper = so.keeper, kicker = so.kicker;
      // The keepers stand where RUL-07 put them, the defending one facing the ball.
      const end = shootoutEnd(s);
      expect(Math.abs(s.players[keeper]!.x - end * (HALF_LENGTH - 0.25))).toBeLessThan(0.4);
      let prev = -1 as number;
      const r = runUntil(s, (st) => {
        if (st.ball.lastKickTick === st.tick && st.ball.lastKickBy === kicker) return true;
        prev = st.players[keeper]!.act;
        return false;
      }, 600, undefined, 'core');
      expect(r.reached).toBe(true);
      expect(prev).not.toBe(ActionKind.GK_DIVE);
      const want = createDiveChoice();
      aiDiveChoice(s, kicker, keeper, s.tick, want);
      const g = s.players[keeper]!;
      if (want.side !== 0) {
        expect(g.act).toBe(ActionKind.GK_DIVE);
        expect(g.actT).toBe(1);
        expect(Math.sign(g.actDirZ)).toBe(want.side);
      } else {
        expect(g.act).not.toBe(ActionKind.GK_DIVE);
      }
      checked++;
      const taken = so.taken[so.team]!;
      const team = so.team;
      runUntil(s, (st) => st.match.shootout.taken[team]! > taken || st.match.phase !== MatchPhase.SHOOT_OUT, 1200, undefined, 'core');
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('human keeper: an RS flick before the kick is the dive at the contact tick', () => {
    const s = shootoutScenario(16, [{ side: 1 }]);
    const so = s.match.shootout;
    // Wait for a kick by team 0 (CPU) against P1's keeper (team 1).
    untilSub(s, ShootoutSub.AIM, 3000, undefined, 0);
    expect(s.ctrl[0]!.slot).toBe(so.keeper);
    const end = shootoutEnd(s);
    runTicks(s, 1, (_t, _st, out) => { out[0]!.buttons = Btn.RS_FLICK; out[0]!.ax = Math.round(end * 90); out[0]!.az = -90; });
    expect([s.match.restart.side, s.match.restart.aimPower]).toEqual([-1, 2]);
    const keeper = so.keeper, kicker = so.kicker;
    let prev = -1 as number;
    const r = runUntil(s, (st) => {
      if (st.ball.lastKickTick === st.tick && st.ball.lastKickBy === kicker) return true;
      prev = st.players[keeper]!.act;
      return false;
    }, 600, undefined, 'core');
    expect(r.reached).toBe(true);
    expect(prev).not.toBe(ActionKind.GK_DIVE);
    const g = s.players[keeper]!;
    expect(g.act).toBe(ActionKind.GK_DIVE);
    expect(Math.sign(g.actDirZ)).toBe(-1);
    expect(g.actA).toBe(2);
  });

  it('human keeper without a choice: no dive at the kick, GKP-02 saves the ball struck at him (kick missed)', () => {
    const s = shootoutScenario(16, [{ side: 1 }]);
    const so = s.match.shootout;
    untilSub(s, ShootoutSub.AIM, 3000, undefined, 0);
    const keeper = so.keeper;
    SHOT.useReq = 0;
    SHOT.tx = shootoutEnd(s) * (HALF_LENGTH + 0.6);
    SHOT.tz = s.players[keeper]!.z + 0.2;
    SHOT.ty = 1.0;
    SHOT.speed = 17;
    const team = so.team;
    const taken = so.taken[team]!;
    let touched = false;
    const r = runUntil(s, (st) => {
      if (st.ball.lastTouch === keeper) touched = true;
      if (st.players[keeper]!.act === ActionKind.GK_DIVE && st.ball.lastKickTick === st.tick) throw new Error('dived at the kick');
      return st.match.shootout.taken[team]! > taken;
    }, 1500, undefined, 'core');
    expect(r.reached).toBe(true);
    expect(touched).toBe(true);
    const kicks = findEvents(r.events, EventType.SHOOTOUT_KICK);
    expect(kicks[kicks.length - 1]!.c).toBe(0);
  });

  it('safety-net kick (RUL-07 forceKick in the rules stage): the AI keeper answers on the next tick', () => {
    SHOT.refuse = true; // CPU kicks never start: RUL-07 forces the kick through applyKick
    let seen = 0;
    for (const seed of [31, 32, 33, 34]) {
      const s = shootoutScenario(seed);
      const so = s.match.shootout;
      untilSub(s, ShootoutSub.AIM);
      const keeper = so.keeper, kicker = so.kicker;
      const r = runUntil(s, (st) => st.ball.lastKickBy === kicker && st.ball.lastKickTick === st.tick, 800);
      expect(r.reached).toBe(true);
      const t = s.tick;
      expect(s.players[keeper]!.act).not.toBe(ActionKind.GK_DIVE);
      runTicks(s, 1);
      const want = createDiveChoice();
      aiDiveChoice(s, kicker, keeper, t, want);
      if (want.side !== 0) {
        seen++;
        expect(s.players[keeper]!.act).toBe(ActionKind.GK_DIVE);
        expect(Math.sign(s.players[keeper]!.actDirZ)).toBe(want.side);
      } else {
        expect(s.players[keeper]!.act).not.toBe(ActionKind.GK_DIVE);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('the kicking team\'s keeper waits beside the goal (RUL-07 spot) facing the ball, and is never moved onto the pitch', () => {
    const s = shootoutScenario(25);
    const so = s.match.shootout;
    untilSub(s, ShootoutSub.AIM);
    runTicks(s, 30, undefined, { check: 'core' });
    const kt = so.team;
    const wk = s.teams[kt]!.keeperSlot;
    if (wk === so.kicker) return;
    const w = s.players[wk]!;
    const end = shootoutEnd(s);
    expect(Math.abs(w.x - end * (HALF_LENGTH - 0.6))).toBeLessThan(0.5);
    expect(w.lookAt).toBe(1);
    expect(wk).toBeLessThan(PLAYERS_PER_TEAM * 2);
  });
});
