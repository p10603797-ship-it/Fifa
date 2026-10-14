/**
 * RUL-08 offside: table-driven checks of the snapshot (position at the pass), which kicks and phases are judged,
 * involvement, resets, the restart (free kick to the defending team where he was) and config.offside = 0.
 * Glitch list "Offside: given from a throw-in, goal kick or corner, or against a player in his own half." has one
 * named regression test per case (prefix "glitch:").
 *
 * These tests build a SimState with makeScenario and call offsideTick directly at controlled ticks (kicks and
 * touches go through the real sim/core/kick.ts helpers; the restart goes through the real RUL-11 awardRestart).
 * The full step() pipeline is exercised in rul-08-pipeline.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { ActionKind, ChallengeKind, CrossKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, WhistleKind, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick, recordTouch, takePossession } from '../../src/sim/core/kick';
import { secondLastDefenderX } from '../../src/sim/core/query';
import { LOCAL_TUNING, isOffsidePosition, offsideLineX, offsideTick } from '../../src/sim/rules/offside';
import { makeScenario } from '../harness/scenario';

const MARGIN = T_RULES.offsideMargin;
const EV = createEventBuffer();
const L = createKickLaunch();

// ---------------------------------------------------------------- harness

interface Scene {
  s: SimState;
  /** Attacking team, its attack direction, the defending team. */
  att: number;
  dir: number;
  def: number;
  /** Passer (behind the ball), the test attacker, the "line" defender, the defending keeper. */
  kicker: number;
  striker: number;
  liner: number;
  keeper: number;
  /** Every event emitted by offsideTick calls made through tickOffside(). */
  events: SimEvent[];
}

interface SceneOpts {
  att?: number;
  /** Second half: both teams' directions swapped. */
  swap?: boolean;
  /** Attack-frame positions (u = dir * x of the attacking team; the defended goal line is at u = +52.5). */
  ballU?: number;
  lineU?: number;
  strikerU?: number;
  strikerZ?: number;
  keeperU?: number;
  /** The other defenders (default lineU - 5). */
  restU?: number;
  offside?: number;
}

/**
 * Attackers in their own half at u = -20, defending keeper at u = 50, one defender (liner) at lineU, the other
 * defenders at lineU - 5 (so the liner is the second-last defender), passer just behind the ball, striker at
 * strikerU. Everyone stands still. Phase IN_PLAY at tick 100.
 */
function scene(o: SceneOpts = {}): Scene {
  const att = o.att ?? 0;
  const def = 1 - att;
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, config: { offside: o.offside ?? 1 } });
  if (o.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
  s.tick = 100;
  const dir = s.teams[att]!.dir;
  const a0 = teamFirstSlot(att);
  const d0 = teamFirstSlot(def);
  const lineU = o.lineU ?? 30;
  const ballU = o.ballU ?? 10;
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    put(s, a0 + i, dir, -20, -25 + 5 * i);
    put(s, d0 + i, dir, o.restU ?? lineU - 5, -25 + 5 * i);
  }
  const sc: Scene = {
    s, att, dir, def, kicker: a0 + 6, striker: a0 + 9, liner: d0 + 4, keeper: d0, events: [],
  };
  put(s, sc.keeper, dir, o.keeperU ?? 50, 0);
  put(s, sc.liner, dir, lineU, 4);
  put(s, sc.kicker, dir, ballU - 0.3, 0);
  put(s, sc.striker, dir, o.strikerU ?? -20, o.strikerZ ?? 6);
  const b = s.ball;
  b.x = dir * ballU; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = 0; b.py = 0.11;
  b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1;
  return sc;
}

/** Place a player at attack-frame u (team-relative frame of `dir`), standing still. */
function put(s: SimState, slot: number, dir: number, u: number, z: number): void {
  const p = s.players[slot]!;
  p.x = dir * u; p.z = z; p.vx = 0; p.vz = 0;
}

/** A kick by `slot` this tick through the real applyKick. */
function kick(sc: Scene, slot: number, kind: KickKind, target = -1, onTarget = 0): void {
  L.vx = sc.dir * 12; L.vy = 0; L.vz = 0; L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = kind; L.target = target; L.tx = 0; L.tz = 0; L.onTarget = onTarget;
  applyKick(sc.s, slot, L, 0.5, EV);
}

/** Run offsideTick for the current tick and keep its events. */
function tickOffside(sc: Scene): SimEvent[] {
  EV.begin(sc.s.tick);
  offsideTick(sc.s, EV);
  const out = EV.toArray();
  sc.events.push(...out);
  return out;
}

/** Advance the tick counter (nothing else moves unless the test moves it). */
function nextTick(sc: Scene, n = 1): void {
  sc.s.tick += n;
}

/** Pass from the kicker this tick and judge it. */
function pass(sc: Scene, target = -1, kind: KickKind = KickKind.THROUGH_GROUND): SimEvent[] {
  kick(sc, sc.kicker, kind, target);
  return tickOffside(sc);
}

function flagged(s: SimState, slot: number): boolean {
  return ((s.match.offside.flags >>> slot) & 1) === 1;
}

function offsides(ev: readonly SimEvent[]): SimEvent[] {
  return ev.filter((e) => e.type === EventType.OFFSIDE);
}

/** Independent reference (Laws of the Game wording + margin), using the lead's secondLastDefenderX. */
function lawOffside(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.active !== 1) return false;
  const dir = s.teams[p.team]!.dir;
  const u = dir * p.x;
  const ownHalf = u <= MARGIN;
  const behindBall = u <= dir * s.ball.x + MARGIN;
  const behindLine = u <= dir * secondLastDefenderX(s, 1 - p.team) + MARGIN;
  return !ownHalf && !behindBall && !behindLine;
}

const LAYOUTS: { att: number; swap: boolean; label: string }[] = [
  { att: 0, swap: false, label: 'home attacking +x' },
  { att: 1, swap: false, label: 'away attacking -x' },
  { att: 0, swap: true, label: 'home attacking -x (second half)' },
  { att: 1, swap: true, label: 'away attacking +x (second half)' },
];

// ---------------------------------------------------------------- position table

interface PosRow { name: string; lineU: number; ballU: number; u: number; offside: boolean; keeperU?: number; restU?: number }

const POSITION_TABLE: PosRow[] = [
  { name: 'level with the second-last defender is onside', lineU: 30, ballU: 10, u: 30, offside: false },
  { name: 'inside the margin past the defender is onside (benefit to the attacker)', lineU: 30, ballU: 10, u: 30 + MARGIN * 0.9, offside: false },
  { name: 'just beyond the margin past the defender is offside', lineU: 30, ballU: 10, u: 30 + MARGIN + 0.01, offside: true },
  { name: 'clearly beyond the second-last defender is offside', lineU: 30, ballU: 10, u: 36, offside: true },
  { name: 'behind the second-last defender is onside', lineU: 30, ballU: 10, u: 25, offside: false },
  { name: 'behind the ball is onside even beyond every defender', lineU: 10, ballU: 40, u: 39, offside: false },
  { name: 'level with the ball is onside', lineU: 10, ballU: 40, u: 40, offside: false },
  { name: 'inside the margin ahead of the ball is onside', lineU: 10, ballU: 40, u: 40 + MARGIN * 0.9, offside: false },
  { name: 'ahead of the ball and the defender beyond the margin is offside', lineU: 10, ballU: 40, u: 40.5, offside: true },
  { name: 'own half: never offside even ahead of ball and defenders', lineU: -15, ballU: -25, u: -3, offside: false },
  { name: 'on the halfway line is onside', lineU: -15, ballU: -25, u: 0, offside: false },
  { name: 'inside the margin past halfway is onside', lineU: -15, ballU: -25, u: MARGIN * 0.9, offside: false },
  { name: 'just past halfway beyond the margin is offside', lineU: -15, ballU: -25, u: MARGIN + 0.05, offside: true },
  { name: 'keeper off his line: the keeper is the second-last defender', lineU: 50, ballU: 10, keeperU: 20, restU: 5, u: 30, offside: true },
  { name: 'keeper off his line: behind him is onside', lineU: 50, ballU: 10, keeperU: 20, restU: 5, u: 19, offside: false },
];

describe('RUL-08 offside position at the moment of the pass (table)', () => {
  for (const lay of LAYOUTS) {
    describe(lay.label, () => {
      for (const row of POSITION_TABLE) {
        it(row.name, () => {
          const sc = scene({ att: lay.att, swap: lay.swap, lineU: row.lineU, ballU: row.ballU, strikerU: row.u, keeperU: row.keeperU, restU: row.restU });
          expect(isOffsidePosition(sc.s, sc.striker)).toBe(row.offside);
          expect(lawOffside(sc.s, sc.striker)).toBe(row.offside);
          pass(sc, sc.striker);
          expect(flagged(sc.s, sc.striker)).toBe(row.offside);
          const o = sc.s.match.offside;
          expect(o.passTick).toBe(sc.s.tick);
          expect(o.passTeam).toBe(sc.att);
          expect(o.passBy).toBe(sc.kicker);
        });
      }
    });
  }

  it('flags is a bitmask of every attacker in an offside position, never the kicker or a sent-off player', () => {
    const sc = scene({ lineU: 20, ballU: 10 });
    const { s, dir } = sc;
    const a0 = teamFirstSlot(sc.att);
    put(s, a0 + 7, dir, 25, -10); // offside
    put(s, a0 + 8, dir, 15, 10); // onside
    put(s, a0 + 9, dir, 30, 12); // offside
    put(s, a0 + 10, dir, 35, -12); // offside position but sent off
    s.players[a0 + 10]!.active = 0;
    put(s, sc.kicker, dir, 26, 0); // the kicker is never flagged, wherever he stands
    pass(sc);
    expect(s.match.offside.flags).toBe((1 << (a0 + 7)) | (1 << (a0 + 9)));
  });

  it('a sent-off defender does not count for the line', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 28 });
    expect(isOffsidePosition(sc.s, sc.striker)).toBe(false);
    sc.s.players[sc.liner]!.active = 0; // the others stand at u = 25
    expect(isOffsidePosition(sc.s, sc.striker)).toBe(true);
    pass(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
  });

  it('agrees with an independent Laws-of-the-game reference on 400 random static layouts', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
    for (let n = 0; n < 400; n++) {
      const lay = LAYOUTS[n % LAYOUTS.length]!;
      const sc = scene({ att: lay.att, swap: lay.swap });
      const { s } = sc;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        p.x = (rnd() * 2 - 1) * (HALF_LENGTH - 1);
        p.z = (rnd() * 2 - 1) * (HALF_WIDTH - 1);
        p.active = rnd() < 0.05 && i !== sc.kicker ? 0 : 1;
      }
      // Snap some attackers onto the exact line / ball / halfway to exercise the level cases.
      const line = secondLastDefenderX(s, sc.def);
      s.ball.x = s.players[sc.kicker]!.x + sc.dir * 0.3; s.ball.px = s.ball.x;
      const a0 = teamFirstSlot(sc.att);
      if (n % 3 === 0) s.players[a0 + 1]!.x = line;
      if (n % 3 === 1) s.players[a0 + 2]!.x = s.ball.x;
      if (n % 3 === 2) s.players[a0 + 3]!.x = 0;
      for (let i = a0; i < a0 + PLAYERS_PER_TEAM; i++) expect(isOffsidePosition(s, i)).toBe(lawOffside(s, i));
      pass(sc);
      for (let i = a0; i < a0 + PLAYERS_PER_TEAM; i++) {
        expect(flagged(s, i)).toBe(i !== sc.kicker && lawOffside(s, i));
      }
      nextTick(sc);
    }
  });

  it('offsideLineX is the most advanced of second-last defender, ball and halfway', () => {
    const sc = scene({ lineU: 30, ballU: 10 });
    expect(offsideLineX(sc.s, sc.att)).toBeCloseTo(sc.dir * 30, 9);
    const sc2 = scene({ lineU: 10, ballU: 40 });
    expect(offsideLineX(sc2.s, sc2.att)).toBeCloseTo(sc2.dir * 40, 9);
    const sc3 = scene({ att: 1, lineU: -15, ballU: -25 });
    expect(offsideLineX(sc3.s, sc3.att)).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------- one-tick window

describe('RUL-08 benefit of the doubt over the tick of the pass', () => {
  it('an attacker level one tick ago who sprinted past the line during the kick tick is onside', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 30.25 });
    sc.s.players[sc.striker]!.vx = sc.dir * 9; // one tick ago: u = 30.1
    expect(isOffsidePosition(sc.s, sc.striker)).toBe(true); // right now he is past it
    pass(sc, sc.striker);
    expect(flagged(sc.s, sc.striker)).toBe(false);
  });

  it('an attacker already past the line at both ends of the tick is offside', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 30.5 });
    sc.s.players[sc.striker]!.vx = sc.dir * 9; // one tick ago: u = 30.35
    pass(sc, sc.striker);
    expect(flagged(sc.s, sc.striker)).toBe(true);
  });

  it('a defender stepping up during the tick of the pass does not catch a level attacker', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 30.25 });
    sc.s.players[sc.liner]!.vx = -sc.dir * 9; // one tick ago he was at u = 30.15
    expect(isOffsidePosition(sc.s, sc.striker)).toBe(true);
    pass(sc, sc.striker);
    expect(flagged(sc.s, sc.striker)).toBe(false);
  });

  it('the ball is judged at the more advanced of its position before and after the kick tick', () => {
    const sc = scene({ lineU: 10, ballU: 35, strikerU: 35.1 });
    sc.s.ball.px = sc.dir * 34.5; // where it was struck
    pass(sc, sc.striker);
    expect(flagged(sc.s, sc.striker)).toBe(false);
    const sc2 = scene({ lineU: 10, ballU: 35, strikerU: 35.3 });
    sc2.s.ball.px = sc2.dir * 34.5;
    pass(sc2, sc2.striker);
    expect(flagged(sc2.s, sc2.striker)).toBe(true);
  });
});

// ---------------------------------------------------------------- which kicks

const JUDGED_KINDS = new Set<KickKind>([
  KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.DINKED_PASS, KickKind.LOB_PASS, KickKind.HIGH_LOB,
  KickKind.DRIVEN_LOB, KickKind.CROSS, KickKind.GROUND_CROSS, KickKind.LOW_CROSS, KickKind.THROUGH_GROUND,
  KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED, KickKind.SHOT_NORMAL, KickKind.SHOT_FINESSE, KickKind.SHOT_CHIP,
  KickKind.SHOT_POWER, KickKind.SHOT_LOW_DRIVEN, KickKind.HEADER_SHOT, KickKind.HEADER_PASS, KickKind.VOLLEY_SHOT,
  KickKind.VOLLEY_PASS, KickKind.CLEARANCE, KickKind.GK_THROW, KickKind.GK_DRIVEN_THROW, KickKind.GK_ROLL,
  KickKind.GK_DROP_KICK, KickKind.GK_DRIVEN_KICK, KickKind.FREE_KICK_SHOT,
]);

describe('RUL-08 offside is judged from passes, shots and headers, not from touches', () => {
  for (let k = KickKind.GROUND_PASS; k <= KickKind.GK_RELEASE; k++) {
    const judged = JUDGED_KINDS.has(k);
    it(`${KickKind[k]} ${judged ? 'takes' : 'does not take'} a snapshot`, () => {
      const sc = scene({ lineU: 30, ballU: 10, strikerU: 35 });
      kick(sc, sc.kicker, k);
      tickOffside(sc);
      expect(flagged(sc.s, sc.striker)).toBe(judged);
    });
  }

  it('a dribble touch by the passer after his pass ends the phase of play: no offside when the flagged player gets it later', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 35 });
    pass(sc, -1, KickKind.GROUND_PASS);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    nextTick(sc, 20);
    kick(sc, sc.kicker, KickKind.KNOCK_ON);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
    nextTick(sc, 30);
    takePossession(sc.s, sc.striker, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
    expect(sc.s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

// ---------------------------------------------------------------- phases

interface PhaseRow { name: string; phase: MatchPhase; kind: KickKind; judged: boolean }

const PHASE_TABLE: PhaseRow[] = [
  { name: 'open play pass', phase: MatchPhase.IN_PLAY, kind: KickKind.GROUND_PASS, judged: true },
  { name: 'free kick played short (offside applies from free kicks)', phase: MatchPhase.FREE_KICK, kind: KickKind.GROUND_PASS, judged: true },
  { name: 'free kick crossed in', phase: MatchPhase.FREE_KICK, kind: KickKind.CROSS, judged: true },
  { name: 'glitch: offside given from a throw-in', phase: MatchPhase.THROW_IN, kind: KickKind.THROW_IN, judged: false },
  { name: 'glitch: offside given from a throw-in (thrown as a pass kind)', phase: MatchPhase.THROW_IN, kind: KickKind.LOB_PASS, judged: false },
  { name: 'glitch: offside given from a goal kick', phase: MatchPhase.GOAL_KICK, kind: KickKind.GOAL_KICK, judged: false },
  { name: 'glitch: offside given from a goal kick (kicked as a lob)', phase: MatchPhase.GOAL_KICK, kind: KickKind.HIGH_LOB, judged: false },
  { name: 'glitch: offside given from a corner', phase: MatchPhase.CORNER, kind: KickKind.CROSS, judged: false },
  { name: 'glitch: offside given from a corner played short', phase: MatchPhase.CORNER, kind: KickKind.GROUND_PASS, judged: false },
  { name: 'no offside from a kick-off', phase: MatchPhase.KICK_OFF, kind: KickKind.KICK_OFF, judged: false },
  { name: 'no offside from a penalty kick', phase: MatchPhase.PENALTY, kind: KickKind.PENALTY, judged: false },
];

describe('RUL-08 phase at the moment of the kick', () => {
  for (const row of PHASE_TABLE) {
    it(row.name, () => {
      const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
      const { s } = sc;
      s.match.phase = row.phase;
      s.match.restart.taker = sc.kicker;
      s.match.restart.taken = 0;
      kick(sc, sc.kicker, row.kind, sc.striker);
      expect(s.match.restart.taken).toBe(row.phase === MatchPhase.IN_PLAY ? 0 : 1);
      tickOffside(sc);
      expect(flagged(s, sc.striker)).toBe(row.judged);
      // Play is live again: the attacker standing in an "offside position" receives the ball.
      s.match.phase = MatchPhase.IN_PLAY;
      nextTick(sc, 40);
      takePossession(s, sc.striker, EV);
      expect(offsides(tickOffside(sc))).toHaveLength(row.judged ? 1 : 0);
    });
  }

  it('a free kick not taken this tick takes no snapshot and clears stale flags', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    pass(sc);
    expect(sc.s.match.offside.flags).not.toBe(0);
    nextTick(sc);
    sc.s.match.phase = MatchPhase.FREE_KICK;
    sc.s.match.restart.taken = 0;
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
  });

  for (const phase of [MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.KICK_OFF, MatchPhase.PENALTY]) {
    it(`stale flags are cleared in ${MatchPhase[phase]}`, () => {
      const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
      pass(sc);
      expect(sc.s.match.offside.flags).not.toBe(0);
      nextTick(sc);
      sc.s.match.phase = phase;
      tickOffside(sc);
      expect(sc.s.match.offside.flags).toBe(0);
    });
  }

  it('glitch: offside given against a player in his own half', () => {
    for (const lay of LAYOUTS) {
      // Defenders pushed up into the attackers' half; the receiver is ahead of the ball and every defender but
      // still in his own half (and on the halfway line).
      for (const u of [-8, -0.5, 0, MARGIN * 0.5]) {
        const sc = scene({ att: lay.att, swap: lay.swap, lineU: -20, ballU: -30, strikerU: u });
        pass(sc, sc.striker);
        expect(flagged(sc.s, sc.striker)).toBe(false);
        nextTick(sc, 30);
        takePossession(sc.s, sc.striker, EV);
        expect(offsides(tickOffside(sc))).toHaveLength(0);
        expect(sc.s.match.phase).toBe(MatchPhase.IN_PLAY);
      }
    }
  });
});

// ---------------------------------------------------------------- involvement and restart

describe('RUL-08 involvement: flagged only when he becomes involved', () => {
  it('receiving the ball: OFFSIDE, free kick to the defending team where he is', () => {
    for (const lay of LAYOUTS) {
      const sc = scene({ att: lay.att, swap: lay.swap, lineU: 30, ballU: 10, strikerU: 36, strikerZ: -7 });
      const { s } = sc;
      pass(sc, sc.striker);
      expect(flagged(s, sc.striker)).toBe(true);
      // The ball travels; he runs on to it.
      nextTick(sc, 45);
      put(s, sc.striker, sc.dir, 38, -6);
      s.ball.x = sc.dir * 37.8; s.ball.z = -6;
      takePossession(s, sc.striker, EV);
      const ev = tickOffside(sc);
      const off = offsides(ev);
      expect(off).toHaveLength(1);
      expect(off[0]!.a).toBe(sc.striker);
      expect(off[0]!.x).toBeCloseTo(sc.dir * 38, 9);
      expect(off[0]!.z).toBeCloseTo(-6, 9);
      expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
      expect(s.match.restart.kind).toBe(RestartKind.FREE_KICK);
      expect(s.match.restart.team).toBe(sc.def);
      expect(s.match.restart.x).toBeCloseTo(sc.dir * 38, 9);
      expect(s.match.restart.z).toBeCloseTo(-6, 9);
      expect(s.match.offside.flags).toBe(0);
      expect(s.ball.owner).toBe(-1);
      expect(ev.some((e) => e.type === EventType.RESTART_AWARDED && e.a === RestartKind.FREE_KICK && e.b === sc.def)).toBe(true);
      expect(ev.some((e) => e.type === EventType.WHISTLE && e.a === WhistleKind.SHORT)).toBe(true);
      expect(s.players[s.match.restart.taker]!.team).toBe(sc.def);
    }
  });

  it('standing in an offside position without becoming involved is not offside', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    const mate = teamFirstSlot(sc.att) + 8;
    put(s, mate, sc.dir, 25, -3);
    pass(sc, mate);
    expect(flagged(s, sc.striker)).toBe(true);
    for (let t = 0; t < 90; t++) { nextTick(sc); expect(offsides(tickOffside(sc))).toHaveLength(0); }
    // The onside teammate receives: a new phase of play, flags gone.
    nextTick(sc);
    takePossession(s, mate, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
    expect(s.match.offside.flags).toBe(0);
    // He dribbles on and loses it; the previously flagged striker picks it up: still no offside.
    nextTick(sc, 40);
    s.ball.owner = -1;
    nextTick(sc, 5);
    takePossession(s, sc.striker, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('heading the ball is involvement', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    pass(sc, sc.striker, KickKind.CROSS);
    nextTick(sc, 50);
    kick(sc, sc.striker, KickKind.HEADER_SHOT, -1, 1);
    const off = offsides(tickOffside(sc));
    expect(off).toHaveLength(1);
    expect(off[0]!.a).toBe(sc.striker);
  });

  it('the ball hitting him (any touch) is involvement', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    pass(sc);
    nextTick(sc, 30);
    recordTouch(sc.s, sc.striker);
    expect(offsides(tickOffside(sc))).toHaveLength(1);
  });

  it('challenging an opponent for the ball is involvement', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    pass(sc, sc.striker, KickKind.LOB_PASS);
    nextTick(sc, 40);
    const rec = s.match.challenges[0]!;
    Object.assign(rec, { active: 1, tackler: sc.striker, victim: sc.liner, kind: ChallengeKind.SHOULDER, ballFirst: 0, tick: s.tick, x: 0, z: 0 });
    const off = offsides(tickOffside(sc));
    expect(off).toHaveLength(1);
    expect(off[0]!.a).toBe(sc.striker);
    expect(s.match.restart.team).toBe(sc.def);
  });

  it('a challenge recorded before the pass is not involvement', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    const rec = s.match.challenges[1]!;
    Object.assign(rec, { active: 1, tackler: sc.striker, victim: sc.liner, kind: ChallengeKind.PUSH_PULL, tick: s.tick - 1 });
    pass(sc, sc.striker);
    nextTick(sc);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
    expect(flagged(s, sc.striker)).toBe(true);
  });

  it('a challenge by an unflagged teammate is not offside', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    pass(sc, sc.striker);
    nextTick(sc, 10);
    const mate = teamFirstSlot(sc.att) + 8;
    Object.assign(s.match.challenges[0]!, { active: 1, tackler: mate, victim: sc.liner, tick: s.tick });
    expect(offsides(tickOffside(sc))).toHaveLength(0);
  });

  interface RecvRow { name: string; dist: number; height: number; target: boolean; offside: boolean }
  const RECEIVER_TABLE: RecvRow[] = [
    { name: 'intended receiver arriving within 2 m of the ball is involved', dist: 1.8, height: 0.11, target: true, offside: true },
    { name: 'intended receiver at exactly 2 m is involved', dist: LOCAL_TUNING.receiverReach, height: 0.11, target: true, offside: true },
    { name: 'intended receiver still 2.2 m away is not yet involved', dist: 2.2, height: 0.11, target: true, offside: false },
    { name: 'a ball flying high over the receiver does not involve him', dist: 0.5, height: 4, target: true, offside: false },
    { name: 'a headable ball involves the receiver', dist: 0.5, height: 2.2, target: true, offside: true },
    { name: 'a flagged player near the ball who is not the intended receiver is not involved', dist: 1.0, height: 0.11, target: false, offside: false },
  ];
  for (const row of RECEIVER_TABLE) {
    it(row.name, () => {
      const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
      const { s } = sc;
      const mate = teamFirstSlot(sc.att) + 8;
      put(s, mate, sc.dir, 20, 10);
      pass(sc, row.target ? sc.striker : mate);
      nextTick(sc, 40);
      const p = s.players[sc.striker]!;
      s.ball.x = p.x - sc.dir * row.dist; s.ball.z = p.z; s.ball.y = row.height;
      expect(offsides(tickOffside(sc))).toHaveLength(row.offside ? 1 : 0);
    });
  }

  it('a fallen intended receiver is not involved by proximity', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    pass(sc, sc.striker);
    nextTick(sc, 40);
    s.players[sc.striker]!.act = ActionKind.FALLEN;
    s.ball.x = s.players[sc.striker]!.x; s.ball.z = s.players[sc.striker]!.z;
    expect(offsides(tickOffside(sc))).toHaveLength(0);
  });

  it('a new pass re-judges: an attacker who came back onside is no longer flagged', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    const mate = teamFirstSlot(sc.att) + 8;
    put(s, mate, sc.dir, 24, -8);
    pass(sc, mate);
    expect(flagged(s, sc.striker)).toBe(true);
    nextTick(sc, 30);
    takePossession(s, mate, EV);
    tickOffside(sc);
    nextTick(sc, 20);
    put(s, sc.striker, sc.dir, 29, 6); // back onside
    s.ball.x = s.players[mate]!.x; s.ball.px = s.ball.x;
    kick(sc, mate, KickKind.THROUGH_GROUND, sc.striker);
    tickOffside(sc);
    expect(flagged(s, sc.striker)).toBe(false);
    expect(s.match.offside.passBy).toBe(mate);
    nextTick(sc, 30);
    takePossession(s, sc.striker, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
  });

  it('a new pass re-judges: an onside attacker who has run offside is flagged', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 28 });
    const { s } = sc;
    const mate = teamFirstSlot(sc.att) + 8;
    put(s, mate, sc.dir, 24, -8);
    pass(sc, mate);
    expect(flagged(s, sc.striker)).toBe(false);
    nextTick(sc, 30);
    takePossession(s, mate, EV);
    tickOffside(sc);
    nextTick(sc, 20);
    put(s, sc.striker, sc.dir, 33, 6);
    s.ball.x = s.players[mate]!.x; s.ball.px = s.ball.x;
    kick(sc, mate, KickKind.THROUGH_GROUND, sc.striker);
    tickOffside(sc);
    expect(flagged(s, sc.striker)).toBe(true);
    nextTick(sc, 30);
    takePossession(s, sc.striker, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- resets by the defending team

describe('RUL-08 resets: deliberate play by the defending team, out of play', () => {
  /** Flags the striker, then the defender `slot` does `act` with the ball at tick +20; then the striker touches it. */
  function afterDefender(act: (sc: Scene, slot: number) => void, shot = false): { sc: Scene; flagsAfter: number; offside: number } {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    if (shot) {
      kick(sc, sc.kicker, KickKind.SHOT_NORMAL, -1, 1);
      tickOffside(sc);
    } else {
      pass(sc, -1, KickKind.CROSS);
    }
    expect(flagged(sc.s, sc.striker)).toBe(true);
    nextTick(sc, 20);
    act(sc, sc.liner);
    tickOffside(sc);
    const flagsAfter = sc.s.match.offside.flags;
    nextTick(sc, 20);
    takePossession(sc.s, sc.striker, EV);
    const offside = offsides(tickOffside(sc)).length;
    return { sc, flagsAfter, offside };
  }

  it('a defender gaining possession resets offside', () => {
    const r = afterDefender((sc, d) => takePossession(sc.s, d, EV));
    expect(r.flagsAfter).toBe(0);
    expect(r.offside).toBe(0);
  });

  it('a defender still in possession resets offside even without a touch this tick', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    pass(sc);
    nextTick(sc);
    sc.s.ball.owner = sc.liner; // possession without a recorded touch this tick
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
  });

  it('a defender\'s headed clearance resets offside', () => {
    const r = afterDefender((sc, d) => kick(sc, d, KickKind.HEADER_PASS));
    expect(r.flagsAfter).toBe(0);
    expect(r.offside).toBe(0);
  });

  it('a defender\'s miscued pass (deliberate play) resets offside', () => {
    const r = afterDefender((sc, d) => kick(sc, d, KickKind.GROUND_PASS));
    expect(r.offside).toBe(0);
  });

  it('a keeper punching a cross away resets offside', () => {
    const r = afterDefender((sc) => kick(sc, sc.keeper, KickKind.GK_PUNCH));
    expect(r.flagsAfter).toBe(0);
    expect(r.offside).toBe(0);
  });

  it('a deflection off a defender does not reset offside', () => {
    const r = afterDefender((sc, d) => kick(sc, d, KickKind.DEFLECTION));
    expect(r.flagsAfter).not.toBe(0);
    expect(r.offside).toBe(1);
  });

  it('the ball bouncing off a defender (touch without a kick) does not reset offside', () => {
    const r = afterDefender((sc, d) => recordTouch(sc.s, d));
    expect(r.offside).toBe(1);
  });

  it('a keeper parry of a shot does not reset offside: the rebound tap-in is offside', () => {
    const r = afterDefender((sc) => kick(sc, sc.keeper, KickKind.GK_PARRY), true);
    expect(r.offside).toBe(1);
  });

  it('a keeper tip of a shot does not reset offside', () => {
    const r = afterDefender((sc) => kick(sc, sc.keeper, KickKind.GK_TIP), true);
    expect(r.offside).toBe(1);
  });

  it('a defender clearing an on-target shot off the line is a save: offside stands', () => {
    const r = afterDefender((sc, d) => kick(sc, d, KickKind.CLEARANCE), true);
    expect(r.flagsAfter).not.toBe(0);
    expect(r.sc.s.match.offside.passTeam).toBe(r.sc.att); // the save keeps the shot's snapshot
    expect(r.offside).toBe(1);
  });

  it('a defender heading an on-target shot away is a save: offside stands', () => {
    const r = afterDefender((sc, d) => kick(sc, d, KickKind.HEADER_PASS), true);
    expect(r.offside).toBe(1);
  });

  it('a keeper punching an on-target shot is a save: offside stands', () => {
    const r = afterDefender((sc) => kick(sc, sc.keeper, KickKind.GK_PUNCH), true);
    expect(r.offside).toBe(1);
  });

  it('a defender clearing an off-target shot is deliberate play: offside reset', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    kick(sc, sc.kicker, KickKind.SHOT_NORMAL, -1, 0);
    tickOffside(sc);
    nextTick(sc, 20);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
  });

  it('a clearance after the keeper parried the shot is deliberate play: offside reset', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    kick(sc, sc.kicker, KickKind.SHOT_POWER, -1, 1);
    tickOffside(sc);
    nextTick(sc, 20);
    kick(sc, sc.keeper, KickKind.GK_PARRY);
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    nextTick(sc, 15);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
    nextTick(sc, 15);
    takePossession(sc.s, sc.striker, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
  });

  it('the ball going out of play clears the flags', () => {
    for (const cross of [CrossKind.TOUCHLINE, CrossKind.GOAL_LINE, CrossKind.GOAL]) {
      const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
      pass(sc);
      nextTick(sc, 30);
      sc.s.ball.cross = cross;
      tickOffside(sc);
      expect(sc.s.match.offside.flags).toBe(0);
    }
  });

  it('a pass that goes straight out takes no snapshot', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    kick(sc, sc.kicker, KickKind.LOB_PASS);
    sc.s.ball.cross = CrossKind.TOUCHLINE;
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
  });

  it('a flagged touch in the same tick the ball crosses the goal line is offside (no goal)', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 51 });
    const { s } = sc;
    pass(sc, sc.striker, KickKind.CROSS);
    nextTick(sc, 50);
    kick(sc, sc.striker, KickKind.SHOT_NORMAL, -1, 1);
    s.ball.cross = CrossKind.GOAL;
    const off = offsides(tickOffside(sc));
    expect(off).toHaveLength(1);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.team).toBe(sc.def);
  });

  it('the opponents\' pass snapshots for them and drops the old flags', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    pass(sc);
    nextTick(sc, 30);
    s.ball.x = s.players[sc.liner]!.x; s.ball.px = s.ball.x;
    kick(sc, sc.liner, KickKind.DRIVEN_PASS);
    tickOffside(sc);
    expect(s.match.offside.passTeam).toBe(sc.def);
    expect(s.match.offside.passBy).toBe(sc.liner);
    for (let i = teamFirstSlot(sc.att); i < teamFirstSlot(sc.att) + PLAYERS_PER_TEAM; i++) expect(flagged(s, i)).toBe(false);
  });
});

// ---------------------------------------------------------------- save window

describe('RUL-08 save window: only the first contact after an on-target shot is a save', () => {
  /** On-target shot by the kicker at tick 100 with the striker flagged; the ball flies toward goal at 12 m/s. */
  function shotScene(): Scene {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    kick(sc, sc.kicker, KickKind.SHOT_NORMAL, -1, 1);
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    expect(sc.s.match.offside.passTick).toBe(sc.s.tick);
    return sc;
  }

  /** `n` ticks of flight with no contact, offsideTick on each (the ball keeps its velocity). */
  function fly(sc: Scene, n: number): void {
    for (let i = 0; i < n; i++) {
      nextTick(sc);
      tickOffside(sc);
    }
  }

  /** The striker then gets the ball: number of OFFSIDE calls. */
  function strikerGetsIt(sc: Scene, how: 'possession' | 'hit' = 'possession'): number {
    nextTick(sc, 10);
    if (how === 'possession') takePossession(sc.s, sc.striker, EV);
    else recordTouch(sc.s, sc.striker);
    return offsides(tickOffside(sc)).length;
  }

  it('regression: a block (deflection) then a clearance by the same defender resets offside (clearance hits the striker)', () => {
    const sc = shotScene();
    fly(sc, 19);
    nextTick(sc);
    kick(sc, sc.liner, KickKind.DEFLECTION);
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true); // the block keeps the flags
    nextTick(sc, 10);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0); // his clearance is deliberate play
    expect(strikerGetsIt(sc, 'hit')).toBe(0);
  });

  it('regression: the ball bouncing off a defender, then his own clearance, resets offside', () => {
    const sc = shotScene();
    nextTick(sc, 20);
    recordTouch(sc.s, sc.liner);
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    nextTick(sc, 10);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
    expect(strikerGetsIt(sc)).toBe(0);
  });

  it('regression: a keeper parry, then the same keeper\'s clearance, resets offside', () => {
    const sc = shotScene();
    nextTick(sc, 20);
    kick(sc, sc.keeper, KickKind.GK_PARRY);
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    nextTick(sc, 10);
    kick(sc, sc.keeper, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
    expect(strikerGetsIt(sc)).toBe(0);
  });

  it('a keeper tip, then the same keeper\'s punch, resets offside', () => {
    const sc = shotScene();
    nextTick(sc, 20);
    kick(sc, sc.keeper, KickKind.GK_TIP);
    tickOffside(sc);
    nextTick(sc, 10);
    kick(sc, sc.keeper, KickKind.GK_PUNCH);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
    expect(strikerGetsIt(sc)).toBe(0);
  });

  it('a save, then the saver\'s deliberate pass, resets offside', () => {
    const sc = shotScene();
    nextTick(sc, 20);
    kick(sc, sc.liner, KickKind.CLEARANCE); // clearance off the line: the save
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    nextTick(sc, 10);
    kick(sc, sc.liner, KickKind.GROUND_PASS);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
    expect(strikerGetsIt(sc)).toBe(0);
  });

  it('a save, then a rebound off the same saver, keeps the flags: the striker is offside', () => {
    const sc = shotScene();
    nextTick(sc, 20);
    kick(sc, sc.liner, KickKind.HEADER_PASS); // headed off the line: the save
    tickOffside(sc);
    nextTick(sc, 5);
    recordTouch(sc.s, sc.liner); // the ball comes back off him: not deliberate
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true);
    expect(strikerGetsIt(sc)).toBe(1);
  });

  it('the window closes at the first contact that keeps the flags (passTick moves to it)', () => {
    const sc = shotScene();
    nextTick(sc, 20);
    kick(sc, sc.liner, KickKind.DEFLECTION);
    tickOffside(sc);
    expect(sc.s.match.offside.passTick).toBe(sc.s.tick);
    expect(sc.s.match.offside.passTeam).toBe(sc.att);
    expect(sc.s.match.offside.passBy).toBe(sc.kicker);
  });

  it('the window stays open while the shot is still going in, on every tick until the save', () => {
    const sc = shotScene();
    const shotTick = sc.s.tick;
    fly(sc, 15);
    sc.s.ball.vx = sc.dir * (LOCAL_TUNING.saveMinGoalSpeed + 0.2); // slowing, still going in
    fly(sc, 15);
    expect(sc.s.match.offside.passTick).toBe(shotTick);
    nextTick(sc);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(flagged(sc.s, sc.striker)).toBe(true); // a save
    expect(strikerGetsIt(sc)).toBe(1);
  });

  it('regression: an on-target shot off the woodwork, then a defender\'s clearance, resets offside', () => {
    const sc = shotScene();
    const { s } = sc;
    fly(sc, 20);
    // Off the post: back out of the goal mouth, no player contact.
    s.ball.x = sc.dir * 52.2; s.ball.z = 3.5; s.ball.vx = -sc.dir * 8; s.ball.vz = 1.5;
    fly(sc, 1);
    expect(flagged(s, sc.striker)).toBe(true); // the woodwork is no deliberate play
    expect(s.match.offside.passTick).toBe(s.tick); // ... but the shot can no longer be saved
    fly(sc, 5);
    nextTick(sc);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(s.match.offside.flags).toBe(0);
    expect(strikerGetsIt(sc)).toBe(0);
  });

  it('an on-target shot off the woodwork straight to the offside striker is still offside', () => {
    const sc = shotScene();
    const { s } = sc;
    fly(sc, 20);
    s.ball.x = sc.dir * 52.2; s.ball.z = 3.5; s.ball.vx = -sc.dir * 8; s.ball.vz = 1.5;
    fly(sc, 1);
    expect(strikerGetsIt(sc)).toBe(1);
  });

  it('an on-target shot that rolls to a stop short of the goal can no longer be saved: the clearance resets', () => {
    const sc = shotScene();
    const { s } = sc;
    fly(sc, 30);
    s.ball.vx = 0; s.ball.vz = 0; s.ball.vy = 0;
    fly(sc, 1);
    expect(flagged(s, sc.striker)).toBe(true);
    nextTick(sc);
    kick(sc, sc.liner, KickKind.CLEARANCE);
    tickOffside(sc);
    expect(s.match.offside.flags).toBe(0);
    expect(strikerGetsIt(sc)).toBe(0);
  });

  it('a stopped ball after a pass (not a shot) changes nothing: the flags stand until someone plays it', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    pass(sc, -1, KickKind.CROSS);
    const pt = sc.s.match.offside.passTick;
    fly(sc, 5);
    sc.s.ball.vx = 0; sc.s.ball.vz = 0;
    fly(sc, 5);
    expect(sc.s.match.offside.passTick).toBe(pt);
    expect(flagged(sc.s, sc.striker)).toBe(true);
  });
});

// ---------------------------------------------------------------- safety-net free kick

describe('RUL-08 a free kick taken after offsideTick (RUL-11 safety net) is judged on the next tick', () => {
  interface NetOpts { prevPhase?: MatchPhase; byTaker?: boolean; judged?: boolean; ticksAgo?: number; kind?: KickKind }

  /**
   * Phase FREE_KICK for the attacking team with the kicker as the taker; at tick 100 the ball is kicked after this
   * tick's offsideTick (as forceRestartKick does in restartTick / watchdogTick) and the phase becomes IN_PLAY. Then
   * offsideTick runs `ticksAgo` ticks later (phaseT as step() counts it).
   */
  function safetyNet(o: NetOpts = {}): Scene {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    const m = s.match;
    const r = m.restart;
    m.phase = MatchPhase.FREE_KICK;
    r.kind = RestartKind.FREE_KICK; r.team = sc.att; r.taker = sc.kicker; r.ready = 1; r.taken = 0;
    tickOffside(sc); // this tick's offsideTick: the free kick is not taken yet
    const by = o.byTaker === false ? sc.att * PLAYERS_PER_TEAM + 7 : sc.kicker;
    if (by !== sc.kicker) put(s, by, sc.dir, 9.7, 0.5);
    kick(sc, by, o.kind ?? KickKind.GROUND_PASS, sc.striker);
    r.taken = 1;
    if (o.judged) { m.offside.passTick = s.tick; m.offside.passTeam = sc.att; m.offside.passBy = sc.kicker; }
    m.prevPhase = o.prevPhase ?? MatchPhase.FREE_KICK;
    m.phase = MatchPhase.IN_PLAY;
    r.kind = RestartKind.NONE;
    m.phaseT = 0;
    const n = o.ticksAgo ?? 1;
    nextTick(sc, n);
    m.phaseT = n;
    tickOffside(sc);
    return sc;
  }

  it('the snapshot is taken one tick late with the kick tick as passTick', () => {
    const sc = safetyNet();
    const o = sc.s.match.offside;
    expect(flagged(sc.s, sc.striker)).toBe(true);
    expect(o.passTick).toBe(sc.s.tick - 1);
    expect(o.passTeam).toBe(sc.att);
    expect(o.passBy).toBe(sc.kicker);
    // ... and involvement follows as for any pass
    nextTick(sc, 30);
    takePossession(sc.s, sc.striker, EV);
    const off = offsides(tickOffside(sc));
    expect(off).toHaveLength(1);
    expect(sc.s.match.restart.team).toBe(sc.def);
  });

  it('an onside receiver is not flagged', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 28 });
    const { s } = sc;
    const m = s.match;
    m.phase = MatchPhase.FREE_KICK;
    m.restart.kind = RestartKind.FREE_KICK; m.restart.team = sc.att; m.restart.taker = sc.kicker; m.restart.ready = 1;
    tickOffside(sc);
    kick(sc, sc.kicker, KickKind.GROUND_PASS, sc.striker);
    m.restart.taken = 1; m.prevPhase = MatchPhase.FREE_KICK; m.phase = MatchPhase.IN_PLAY; m.phaseT = 0;
    nextTick(sc); m.phaseT = 1;
    tickOffside(sc);
    expect(s.match.offside.flags).toBe(0);
    expect(s.match.offside.passTick).toBe(s.tick - 1);
  });

  const NOT_JUDGED: { name: string; o: NetOpts }[] = [
    { name: 'a safety-net corner (no offside from a corner)', o: { prevPhase: MatchPhase.CORNER } },
    { name: 'a safety-net throw-in', o: { prevPhase: MatchPhase.THROW_IN } },
    { name: 'a safety-net goal kick', o: { prevPhase: MatchPhase.GOAL_KICK } },
    { name: 'a safety-net kick-off', o: { prevPhase: MatchPhase.KICK_OFF } },
    { name: 'a safety-net penalty', o: { prevPhase: MatchPhase.PENALTY } },
    { name: 'a kick by somebody other than the restart taker', o: { byTaker: false } },
    { name: 'a kick of a kind offside is not judged from (a dribble touch)', o: { kind: KickKind.DRIBBLE_TOUCH } },
    { name: 'a kick older than one tick', o: { ticksAgo: 2 } },
  ];
  for (const row of NOT_JUDGED) {
    it(`no late snapshot for ${row.name}`, () => {
      const sc = safetyNet(row.o);
      expect(sc.s.match.offside.flags).toBe(0);
      expect(sc.s.match.offside.passTick).not.toBe(sc.s.tick - (row.o.ticksAgo ?? 1));
    });
  }

  it('a free kick already judged on its own tick is not judged again', () => {
    const sc = safetyNet({ judged: true });
    expect(sc.s.match.offside.flags).toBe(0); // the stored (empty) snapshot stands
    expect(sc.s.match.offside.passTick).toBe(sc.s.tick - 1);
  });

  it('config.offside = 0: no late snapshot either', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36, offside: 0 });
    const m = sc.s.match;
    m.phase = MatchPhase.FREE_KICK;
    m.restart.kind = RestartKind.FREE_KICK; m.restart.team = sc.att; m.restart.taker = sc.kicker; m.restart.ready = 1;
    kick(sc, sc.kicker, KickKind.GROUND_PASS, sc.striker);
    m.restart.taken = 1; m.prevPhase = MatchPhase.FREE_KICK; m.phase = MatchPhase.IN_PLAY; m.phaseT = 0;
    nextTick(sc); m.phaseT = 1;
    tickOffside(sc);
    expect(m.offside.flags).toBe(0);
  });
});

// ---------------------------------------------------------------- restart spot, config

describe('RUL-08 restart and settings', () => {
  it('the free kick spot is his position, kept inside the pitch', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36, strikerZ: 20 });
    const { s } = sc;
    pass(sc, sc.striker, KickKind.LOB_PASS);
    nextTick(sc, 60);
    put(s, sc.striker, sc.dir, 52.9, HALF_WIDTH + 0.4); // ran off the corner of the pitch
    recordTouch(s, sc.striker);
    const off = offsides(tickOffside(sc));
    expect(off).toHaveLength(1);
    expect(Math.abs(s.match.restart.x)).toBeLessThanOrEqual(HALF_LENGTH);
    expect(Math.abs(s.match.restart.z)).toBeLessThanOrEqual(HALF_WIDTH);
    expect(off[0]!.x).toBe(s.match.restart.x);
    expect(off[0]!.z).toBe(s.match.restart.z);
    expect(s.match.restart.team).toBe(sc.def);
  });

  it('config.offside = 0 disables offside: no flags, no call, no offside positions', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 40, offside: 0 });
    const { s } = sc;
    expect(isOffsidePosition(s, sc.striker)).toBe(false);
    pass(sc, sc.striker);
    expect(s.match.offside.flags).toBe(0);
    nextTick(sc, 30);
    takePossession(s, sc.striker, EV);
    expect(offsides(tickOffside(sc))).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('config.offside = 0 drops flags left over from before', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 40 });
    pass(sc);
    expect(sc.s.match.offside.flags).not.toBe(0);
    (sc.s.config as { offside: number }).offside = 0;
    nextTick(sc);
    tickOffside(sc);
    expect(sc.s.match.offside.flags).toBe(0);
  });

  it('isOffsidePosition is false for invalid and sent-off slots', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 40 });
    expect(isOffsidePosition(sc.s, -1)).toBe(false);
    expect(isOffsidePosition(sc.s, NUM_SLOTS)).toBe(false);
    expect(isOffsidePosition(sc.s, 2.5)).toBe(false);
    expect(isOffsidePosition(sc.s, sc.striker)).toBe(true);
    sc.s.players[sc.striker]!.active = 0;
    expect(isOffsidePosition(sc.s, sc.striker)).toBe(false);
  });

  it('isOffsidePosition and offsideTick without a kick do not change state', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 40 });
    const before = JSON.stringify({ m: sc.s.match, b: sc.s.ball, p: sc.s.players });
    for (let i = 0; i < NUM_SLOTS; i++) isOffsidePosition(sc.s, i);
    offsideLineX(sc.s, 0);
    tickOffside(sc);
    expect(JSON.stringify({ m: sc.s.match, b: sc.s.ball, p: sc.s.players })).toBe(before);
    expect(sc.events).toHaveLength(0);
  });
});
