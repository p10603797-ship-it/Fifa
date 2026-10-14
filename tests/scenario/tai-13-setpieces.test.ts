/**
 * TAI-13 set-piece AI: positions (legal for every restart kind and both teams, corner tactics, walls, spacing,
 * walking in through the real pipeline) and the CPU's set-piece frames (timing, input programs, retries, wall jump,
 * penalties), determinism. Real pipeline, no mocks. End-to-end completion of each restart kind with the real kind
 * modules runs here as soon as those modules are implemented (probes below); until then
 * tai-13-cpu-contract.test.ts drives the CPU against contract fakes of the stubbed modules.
 *
 * Glitch-list lines covered (positions are TAI-13's share of them): "kick-off with players in the wrong half",
 * "opponents inside the required distance blocking forever", "run in place against each other",
 * "stay off the pitch after a throw-in".
 */
import { describe, expect, it } from 'vitest';
import {
  CENTRE_CIRCLE_RADIUS, CPU_CONTROLLER_BASE, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_ARC_RADIUS,
  PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST, RESTART_DISTANCE, THROW_IN_DISTANCE,
} from '../../src/contracts/constants';
import {
  ActionKind, AiJob, Command, Difficulty, GestureKind, KickKind, MatchPhase, RestartKind, Role,
} from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { CpuPlan, type SimState } from '../../src/contracts/state';
import { createActionRequest } from '../../src/contracts/systems';
import { T_PASS, T_RULES } from '../../src/contracts/tuning';
import {
  FkZone, LOCAL_TUNING, SpotRole, cpuSetPiece, freeKickZone, setPiecePositions, setPieceTarget,
} from '../../src/ai/setpieces';
import { cloneState } from '../../src/sim/core/clone';
import { NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { startPass } from '../../src/sim/kicks/pass';
import { startLob } from '../../src/sim/kicks/lob';
import { startShot } from '../../src/sim/kicks/shot';
import { setupKickOff } from '../../src/sim/rules/machine';
import { awardRestart, isLegalRestartPosition } from '../../src/sim/rules/restart';
import { throwInSetup } from '../../src/sim/rules/throwin';
import { cornerSetup } from '../../src/sim/rules/corner';
import { freeKickSetup } from '../../src/sim/rules/freekick';
import { penaltySetup } from '../../src/sim/rules/penalty';
import { goalKickSetup } from '../../src/sim/rules/goalkick';
import { shootoutStart } from '../../src/sim/rules/shootout';
import { makeScenario, runTicks, type ScenarioHuman } from '../harness/scenario';

const SETUP = T_RULES.restartSetupTicks;
const DELAY = T_RULES.cpuRestartDelay;

// ---------------------------------------------------------------- scenario helpers

interface Opts { seed?: number; humans?: number | ScenarioHuman[]; shift?: number; level?: Difficulty }

/** A match in play (optionally everybody shifted along x, as after an attack), then the restart awarded. */
function awarded(kind: RestartKind, team: number, x: number, z: number, o: Opts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: o.humans ?? 0, seed: o.seed ?? 1 });
  if (o.level !== undefined) { s.teams[0]!.cpu.level = o.level; s.teams[1]!.cpu.level = o.level; }
  if (o.shift) {
    for (const p of s.players) {
      if (p.isKeeper === 1) continue;
      p.x = Math.max(-48, Math.min(48, p.x + o.shift));
    }
  }
  awardRestart(s, kind, team, x, z, NULL_SINK);
  expect(s.match.restart.kind).toBe(kind);
  return s;
}

function kickOff(team: number, o: Opts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.KICK_OFF, humans: o.humans ?? 0, seed: o.seed ?? 1 });
  setupKickOff(s, team, NULL_SINK);
  return s;
}

function shootout(team: number, kicker: number, o: Opts = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.SHOOT_OUT, humans: o.humans ?? 0, seed: o.seed ?? 1 });
  const so = s.match.shootout;
  so.active = 1;
  so.team = team;
  so.kicker = kicker;
  return s;
}

interface Spot { slot: number; role: number; x: number; z: number }

function spots(s: SimState): Spot[] {
  const out: Spot[] = [];
  const pt = { x: 0, z: 0 };
  for (let i = 0; i < NUM_SLOTS; i++) {
    const role = setPieceTarget(s, i, pt);
    if (role !== SpotRole.NONE) out.push({ slot: i, role, x: pt.x, z: pt.z });
  }
  return out;
}

/** Everybody with a spot teleported onto it (spots computed once, before anyone moves). */
function placeOnSpots(s: SimState): Spot[] {
  const sp = spots(s);
  for (const p of sp) { s.players[p.slot]!.x = p.x; s.players[p.slot]!.z = p.z; }
  return sp;
}

function dist(ax: number, az: number, bx: number, bz: number): number { return Math.hypot(ax - bx, az - bz); }

/** Every legality rule of section 5 for a spot of a player of `team`, checked explicitly (independent of RUL-11). */
function checkLegal(s: SimState, slot: number, x: number, z: number): string | null {
  const r = s.match.restart;
  const p = s.players[slot]!;
  const opp = p.team !== r.team;
  if (Math.abs(x) > HALF_LENGTH || Math.abs(z) > HALF_WIDTH) return `slot ${slot} off the pitch (${x}, ${z})`;
  const dBall = dist(x, z, r.x, r.z);
  const dir = s.teams[p.team]!.dir;
  const attDir = s.teams[r.team]!.dir;
  switch (r.kind) {
    case RestartKind.KICK_OFF:
      if (dir * x > 0) return `slot ${slot} in the wrong half at a kick-off`;
      if (opp && Math.hypot(x, z) < CENTRE_CIRCLE_RADIUS) return `slot ${slot} inside the centre circle`;
      return null;
    case RestartKind.THROW_IN:
      return opp && dBall < THROW_IN_DISTANCE ? `slot ${slot} within 2 m of a throw-in` : null;
    case RestartKind.PENALTY: {
      const ex = attDir * x;
      if (ex >= HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH) return `slot ${slot} in the area`;
      if (dist(x, z, attDir * (HALF_LENGTH - PENALTY_SPOT_DIST), 0) < PENALTY_ARC_RADIUS) return `slot ${slot} in the arc`;
      return null;
    }
    case RestartKind.GOAL_KICK: {
      if (!opp) return null;
      const ex = -attDir * x;
      if (ex >= HALF_LENGTH - PENALTY_AREA_DEPTH && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH) return `slot ${slot} in the area`;
      return dBall < RESTART_DISTANCE ? `slot ${slot} within 9.15 m` : null;
    }
    case RestartKind.FREE_KICK: {
      if (!opp || dBall >= RESTART_DISTANCE) return null;
      const onLine = Math.abs(x - attDir * HALF_LENGTH) <= 0.6 && Math.abs(z) <= GOAL_HALF_WIDTH;
      return onLine ? null : `slot ${slot} within 9.15 m of a free kick`;
    }
    default:
      return opp && dBall < RESTART_DISTANCE ? `slot ${slot} within 9.15 m` : null;
  }
}

/** Both slots hold WALL spots (a free-kick wall: RUL-05 lines them up shoulder to shoulder). */
function isWallPair(sp: readonly Spot[], i: number, j: number): boolean {
  const a = sp.find((q) => q.slot === i), b = sp.find((q) => q.slot === j);
  return a !== undefined && b !== undefined && a.role === SpotRole.WALL && b.role === SpotRole.WALL;
}

/** Legal spots for every candidate of both teams (explicit rules + RUL-11's own check), inside the pitch, spaced. */
function expectLegalLayout(s: SimState, label: string): Spot[] {
  const sp = placeOnSpots(s);
  const problems: string[] = [];
  const r = s.match.restart;
  for (const p of sp) {
    if (p.role === SpotRole.WALL) continue;
    const e = checkLegal(s, p.slot, p.x, p.z);
    if (e) problems.push(e);
    if (!isLegalRestartPosition(s, p.slot)) problems.push(`slot ${p.slot} (role ${p.role}) illegal for RUL-11 at (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
  }
  // Spacing: spots apart from each other and from players without a spot (taker, keepers).
  for (let i = 0; i < NUM_SLOTS; i++) {
    for (let j = 0; j < i; j++) {
      const a = s.players[i]!, b = s.players[j]!;
      if (a.active !== 1 || b.active !== 1) continue;
      if (!sp.some((q) => q.slot === i || q.slot === j)) continue;
      // [INT-A] Wall members stand shoulder to shoulder (RUL-05 spacing, now live instead of the Wave 1 stub).
      if (isWallPair(sp, i, j)) continue;
      const d = dist(a.x, a.z, b.x, b.z);
      if (d < LOCAL_TUNING.minSpacing - 0.05) problems.push(`slots ${i} and ${j} only ${d.toFixed(2)} m apart`);
    }
  }
  // Every active outfield player but the taker (and humans) has a spot.
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1 || i === r.taker) continue;
    if (!sp.some((q) => q.slot === i)) problems.push(`slot ${i} has no spot`);
  }
  expect(problems, label).toEqual([]);
  return sp;
}

function teamSpots(sp: Spot[], team: number): Spot[] {
  return sp.filter((p) => (p.slot < 11 ? 0 : 1) === team);
}

// ---------------------------------------------------------------- positions: legality per restart kind

const RESTARTS: [string, RestartKind, number, number, number][] = [
  ['throw-in, home, near touchline', RestartKind.THROW_IN, 0, 10, 34],
  ['throw-in, away, far touchline', RestartKind.THROW_IN, 1, -30, -34],
  ['throw-in, home, by the attacked corner flag', RestartKind.THROW_IN, 0, 50, -34],
  ['throw-in, away, by its own corner flag', RestartKind.THROW_IN, 1, 51.5, 34],
  ['goal kick, home', RestartKind.GOAL_KICK, 0, -50, 5],
  ['goal kick, away', RestartKind.GOAL_KICK, 1, 50, -8],
  ['corner, home, right', RestartKind.CORNER, 0, 52.5, 34],
  ['corner, home, left', RestartKind.CORNER, 0, 52.5, -34],
  ['corner, away, right', RestartKind.CORNER, 1, -52.5, 34],
  ['corner, away, left', RestartKind.CORNER, 1, -52.5, -34],
  ['free kick, shooting range, central', RestartKind.FREE_KICK, 0, 30, 2],
  ['free kick, shooting range, angled', RestartKind.FREE_KICK, 1, -28, 14],
  ['free kick, wide', RestartKind.FREE_KICK, 0, 25, 28],
  ['free kick, wide, away', RestartKind.FREE_KICK, 1, -20, -25],
  ['free kick, deep', RestartKind.FREE_KICK, 0, -10, 12],
  ['free kick, halfway', RestartKind.FREE_KICK, 1, 0, 0],
  ['free kick in the own penalty area', RestartKind.FREE_KICK, 0, -40, 6],
  ['free kick 6.5 m from goal', RestartKind.FREE_KICK, 1, -46, -2],
  ['penalty, home', RestartKind.PENALTY, 0, 41.5, 0],
  ['penalty, away', RestartKind.PENALTY, 1, -41.5, 0],
];

describe('TAI-13 positions: legal for every restart kind and both teams', () => {
  it.each(RESTARTS)('%s', (label, kind, team, x, z) => {
    const s = awarded(kind, team, x, z);
    expectLegalLayout(s, label);
  });

  it.each(RESTARTS)('%s, second half (directions swapped), short-handed sides', (label, kind, team, x, z) => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 5 });
    s.teams[0]!.dir = -1;
    s.teams[1]!.dir = 1;
    for (const p of s.players) { p.x = -p.x; p.z = -p.z; }
    s.players[3]!.active = 0; // sent off
    s.players[19]!.active = 0;
    s.players[20]!.active = 0;
    awardRestart(s, kind, team, -x, z, NULL_SINK);
    if (s.match.restart.kind !== kind) return; // a spot at the wrong end for the swapped direction: refused
    expectLegalLayout(s, `${label} (2nd half)`);
  });

  it('glitch: kick-off with players in the wrong half — kick-off spots keep both teams home, opponents outside the circle', () => {
    for (const team of [0, 1]) {
      for (const swapped of [false, true]) {
        const s = makeScenario({ phase: MatchPhase.KICK_OFF, humans: 0, seed: 3 });
        if (swapped) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; }
        setupKickOff(s, team, NULL_SINK);
        const before = s.players.map((p) => [p.x, p.z]);
        const sp = expectLegalLayout(s, `kick-off ${team} swapped ${swapped}`);
        // Nobody needs to walk: the spots are where RUL-01 placed everyone.
        for (const p of sp) expect(dist(p.x, p.z, before[p.slot]![0]!, before[p.slot]![1]!)).toBeLessThan(0.05);
      }
    }
  });

  it('glitch: opponents inside the required distance blocking forever — every spot keeps its legal distance with a margin', () => {
    for (const [label, kind, team, x, z] of RESTARTS) {
      const s = awarded(kind, team, x, z, { seed: 11 });
      const r = s.match.restart;
      for (const p of spots(s)) {
        if (p.role === SpotRole.WALL) continue;
        const opp = (p.slot < 11 ? 0 : 1) !== r.team;
        if (!opp || kind === RestartKind.PENALTY) continue;
        const need = kind === RestartKind.THROW_IN ? THROW_IN_DISTANCE : RESTART_DISTANCE;
        const d = dist(p.x, p.z, r.x, r.z);
        const onGoalLine = kind === RestartKind.FREE_KICK && Math.abs(Math.abs(p.x) - HALF_LENGTH) < 0.6 && Math.abs(p.z) <= GOAL_HALF_WIDTH;
        if (!onGoalLine) expect(d, `${label} slot ${p.slot}`).toBeGreaterThanOrEqual(need + 0.5);
      }
    }
  });

  it('glitch: stay off the pitch after a throw-in — throw-in spots lie inside the pitch, options 5-15 m from the thrower', () => {
    for (const [x, z, team] of [[10, 34, 0], [-30, -34, 1], [50, -34, 0], [-51.5, 34, 1], [0, 34, 1]] as const) {
      const s = awarded(RestartKind.THROW_IN, team, x, z);
      const r = s.match.restart;
      const sp = spots(s);
      for (const p of sp) {
        expect(Math.abs(p.x)).toBeLessThanOrEqual(HALF_LENGTH - 0.4);
        expect(Math.abs(p.z)).toBeLessThanOrEqual(HALF_WIDTH - 0.4);
      }
      const opts = sp.filter((p) => p.role === SpotRole.THROW_OPTION);
      expect(opts.length).toBeGreaterThanOrEqual(3);
      const thrower = { x: r.x, z: Math.sign(r.z) * (HALF_WIDTH + 0.4) };
      for (const o of opts) {
        expect((o.slot < 11 ? 0 : 1)).toBe(team);
        const d = dist(o.x, o.z, thrower.x, thrower.z);
        expect(d).toBeGreaterThanOrEqual(4);
        expect(d).toBeLessThanOrEqual(16.5);
      }
      // Markers stand goal-side of the options they mark.
      const marks = sp.filter((p) => p.role === SpotRole.MARK);
      expect(marks.length).toBeGreaterThanOrEqual(2);
      const defDir = s.teams[1 - team]!.dir;
      for (const m of marks) {
        const o = opts.find((q) => dist(q.x, q.z, m.x, m.z) < 2.5);
        expect(o, `marker ${m.slot} next to an option`).toBeDefined();
        expect(defDir * m.x).toBeLessThan(defDir * o!.x + 1e-6); // nearer his own goal
      }
    }
  });

  it('glitch: players run in place against each other — spots are spaced at least minSpacing apart (incl. the taker)', () => {
    for (const [label, kind, team, x, z] of RESTARTS) {
      const s = awarded(kind, team, x, z, { seed: 21 });
      const sp = spots(s);
      const t = s.match.restart.taker;
      const pts = sp.map((p) => [p.x, p.z]);
      if (t >= 0) pts.push([s.players[t]!.x, s.players[t]!.z]);
      for (let i = 0; i < sp.length; i++) {
        for (let j = 0; j < pts.length; j++) {
          if (j === i) continue;
          if (j < sp.length && sp[i]!.role === SpotRole.WALL && sp[j]!.role === SpotRole.WALL) continue; // [INT-A] wall
          expect(dist(pts[i]![0]!, pts[i]![1]!, pts[j]![0]!, pts[j]![1]!), `${label} ${sp[i]!.slot}`).toBeGreaterThanOrEqual(LOCAL_TUNING.minSpacing - 0.05);
        }
      }
    }
  });

  it('shoot-out: every outfield player but the kicker stands in the centre circle, the two teams side by side', () => {
    const s = shootout(0, 9);
    const sp = spots(s);
    expect(sp.length).toBe(19); // 22 - 2 keepers - the kicker
    for (const p of sp) {
      expect(p.role).toBe(SpotRole.CIRCLE);
      expect(Math.hypot(p.x, p.z)).toBeLessThan(CENTRE_CIRCLE_RADIUS - 1);
      expect(Math.sign(p.z)).toBe(p.slot < 11 ? -1 : 1);
    }
    expect(sp.some((p) => p.slot === 9)).toBe(false);
    for (let i = 0; i < sp.length; i++) for (let j = 0; j < i; j++) expect(dist(sp[i]!.x, sp[i]!.z, sp[j]!.x, sp[j]!.z)).toBeGreaterThan(1.2);
  });

  it('a human-controlled player, the keepers and the taker get no spot; a CPU-controlled defender does', () => {
    const s = awarded(RestartKind.CORNER, 0, 52.5, 34, { humans: [{ side: 1, slot: 14 }] });
    expect(setPieceTarget(s, 14, { x: 0, z: 0 })).toBe(SpotRole.NONE);
    expect(setPieceTarget(s, 0, { x: 0, z: 0 })).toBe(SpotRole.NONE);
    expect(setPieceTarget(s, 11, { x: 0, z: 0 })).toBe(SpotRole.NONE);
    expect(setPieceTarget(s, s.match.restart.taker, { x: 0, z: 0 })).toBe(SpotRole.NONE);
    const t = awarded(RestartKind.CORNER, 0, 52.5, 34);
    runTicks(t, 2); // switching gives the defending CPU a player
    const cpuSlot = t.ctrl[CPU_CONTROLLER_BASE + 1]!.slot;
    expect(cpuSlot).toBeGreaterThanOrEqual(11);
    expect(setPieceTarget(t, cpuSlot, { x: 0, z: 0 })).not.toBe(SpotRole.NONE);
  });

  it('setPiecePositions gives every job-driven player a SET_PIECE job at his spot (and nothing outside restarts)', () => {
    const s = awarded(RestartKind.CORNER, 1, -52.5, -34);
    placeOnSpots(s);
    runTicks(s, 1);
    const sp = spots(s);
    for (const p of sp) {
      const q = s.players[p.slot]!;
      if (q.ctrl >= 0) continue;
      expect(q.job, `slot ${p.slot}`).toBe(AiJob.SET_PIECE);
      // [QF-2] The spots read after the tick see the keepers and the taker (players without a spot) where that tick
      // moved them; spacing from them shifts a spot by a centimetre or two.
      expect(dist(q.tgtX, q.tgtZ, p.x, p.z)).toBeLessThan(0.05);
    }
    const marks = sp.filter((p) => p.role === SpotRole.MARK);
    expect(marks.length).toBe(LOCAL_TUNING.maxMarkers);
    for (const m of marks) {
      const q = s.players[m.slot]!;
      if (q.ctrl >= 0) continue;
      expect(q.jobSlot).toBeGreaterThanOrEqual(11); // the marked attacker
    }
    const play = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
    setPiecePositions(play, 0, NULL_SINK);
    expect(play.players.some((p) => p.job === AiJob.SET_PIECE)).toBe(false);
  });
});

// ---------------------------------------------------------------- positions: scripted roles

describe('TAI-13 positions: scripted roles', () => {
  it('corner: near post, far post, penalty spot, edge of box, short option, two back; defenders on the near post, markers, zonal, one up', () => {
    const s = awarded(RestartKind.CORNER, 0, 52.5, 34);
    const sp = spots(s);
    const att = teamSpots(sp, 0), def = teamSpots(sp, 1);
    const roles = (l: Spot[]) => l.map((p) => p.role);
    for (const r of [SpotRole.NEAR_POST, SpotRole.FAR_POST, SpotRole.PEN_SPOT, SpotRole.EDGE, SpotRole.SHORT, SpotRole.STAY_BACK]) {
      expect(roles(att), `attack role ${r}`).toContain(r);
    }
    for (const r of [SpotRole.POST_GUARD, SpotRole.MARK, SpotRole.ZONAL, SpotRole.COUNTER]) expect(roles(def), `defence role ${r}`).toContain(r);
    const near = att.find((p) => p.role === SpotRole.NEAR_POST)!;
    const far = att.find((p) => p.role === SpotRole.FAR_POST)!;
    expect(Math.sign(near.z)).toBe(1); // corner on +z: near post is the +z post
    expect(Math.sign(far.z)).toBe(-1);
    const short = att.find((p) => p.role === SpotRole.SHORT)!;
    const dShort = dist(short.x, short.z, s.match.restart.x, s.match.restart.z);
    expect(dShort).toBeGreaterThan(5);
    expect(dShort).toBeLessThan(10);
    const post = def.find((p) => p.role === SpotRole.POST_GUARD)!;
    expect(post.x).toBeGreaterThan(HALF_LENGTH - 1.5);
    expect(post.z).toBeGreaterThan(0);
    expect(post.z).toBeLessThan(GOAL_HALF_WIDTH);
    // Markers stand goal-side of the attacker they mark.
    for (const m of def.filter((p) => p.role === SpotRole.MARK)) {
      const tgt = att.find((a) => dist(a.x, a.z, m.x, m.z) < 1.6);
      expect(tgt, `marker ${m.slot}`).toBeDefined();
      expect(dist(m.x, m.z, HALF_LENGTH, 0)).toBeLessThan(dist(tgt!.x, tgt!.z, HALF_LENGTH, 0));
    }
    // The box roles go to the best headers: the mean heading of the box players beats that of the stay-backs.
    const head = (l: Spot[]) => l.reduce((a, p) => a + s.attrs[p.slot]!.heading, 0) / l.length;
    const box = att.filter((p) => p.role === SpotRole.NEAR_POST || p.role === SpotRole.FAR_POST || p.role === SpotRole.PEN_SPOT);
    expect(head(box)).toBeGreaterThan(head(att.filter((p) => p.role === SpotRole.STAY_BACK)));
  });

  it('corner tactics move players (far post, edge of box, crowd the keeper, near post)', () => {
    const count = (tactic: number, pred: (p: Spot) => boolean): number => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, teams: [{ cornerTactic: tactic }] });
      awardRestart(s, RestartKind.CORNER, 0, 52.5, 34, NULL_SINK);
      return teamSpots(spots(s), 0).filter(pred).length;
    };
    // Corner from +z at the +x end: far post z < 0.
    const farZone = (p: Spot) => p.x > HALF_LENGTH - 11 && p.z < -3;
    const edgeZone = (p: Spot) => p.x < HALF_LENGTH - PENALTY_AREA_DEPTH + 1 && p.x > HALF_LENGTH - 24 && Math.abs(p.z) < 12;
    const keeperZone = (p: Spot) => p.x > HALF_LENGTH - 3 && Math.abs(p.z) < GOAL_HALF_WIDTH;
    const nearZone = (p: Spot) => p.x > HALF_LENGTH - 9 && p.z > 1 && p.z < 9;
    expect(count(Command.CORNER_FAR_POST, farZone)).toBeGreaterThan(count(0, farZone));
    expect(count(Command.CORNER_EDGE_OF_BOX, edgeZone)).toBeGreaterThan(count(0, edgeZone));
    expect(count(Command.CORNER_CROWD_KEEPER, keeperZone)).toBeGreaterThan(count(0, keeperZone));
    expect(count(Command.CORNER_NEAR_POST, nearZone)).toBeGreaterThan(count(0, nearZone));
  });

  it('goal kick: centre-backs split wide in the box, a pivot, full-backs wide, a target man; two opponents press outside the box', () => {
    const s = awarded(RestartKind.GOAL_KICK, 1, 50, -8);
    const sp = spots(s);
    const kick = teamSpots(sp, 1);
    const split = kick.filter((p) => p.role === SpotRole.SPLIT_CB);
    expect(split.length).toBe(2);
    for (const p of split) expect(s.players[p.slot]!.role).toBe(Role.CB);
    expect(Math.sign(split[0]!.z)).not.toBe(Math.sign(split[1]!.z));
    expect(kick.filter((p) => p.role === SpotRole.WIDE).every((p) => Math.abs(p.z) > 25)).toBe(true);
    const tgt = kick.filter((p) => p.role === SpotRole.TARGET);
    expect(tgt.length).toBe(2);
    for (const p of tgt) expect(Math.abs(p.x)).toBeLessThan(6);
    const press = teamSpots(sp, 0).filter((p) => p.role === SpotRole.PRESS);
    expect(press.length).toBe(2);
    for (const p of press) expect(p.x).toBeLessThan(HALF_LENGTH - PENALTY_AREA_DEPTH);
  });

  it('free-kick zones: shooting range, wide (attackers in the box), deep', () => {
    const z = (team: number, x: number, zz: number) => freeKickZone(awarded(RestartKind.FREE_KICK, team, x, zz));
    expect(z(0, 30, 2)).toBe(FkZone.SHOOT);
    expect(z(1, -28, 14)).toBe(FkZone.SHOOT);
    expect(z(0, 25, 28)).toBe(FkZone.WIDE);
    expect(z(0, -10, 12)).toBe(FkZone.DEEP);
    expect(freeKickZone(makeScenario({ phase: MatchPhase.IN_PLAY }))).toBe(FkZone.NONE);
    // Wide free kick: four runners on the defensive line inside the box area, markers on them.
    const s = awarded(RestartKind.FREE_KICK, 0, 25, 28);
    const sp = spots(s);
    const line = teamSpots(sp, 0).filter((p) => p.role === SpotRole.LINE);
    expect(line.length).toBe(4);
    for (const p of line) expect(HALF_LENGTH - p.x).toBeLessThanOrEqual(LOCAL_TUNING.fkLineMax + LOCAL_TUNING.fkRunnerOnside + 0.01);
    expect(teamSpots(sp, 1).filter((p) => p.role === SpotRole.MARK).length).toBeGreaterThanOrEqual(3);
  });

  it('free kick: wall members walk to the wall, then hold where RUL-05 puts them; nobody else is placed on the wall', () => {
    const s = awarded(RestartKind.FREE_KICK, 0, 30, 2);
    const r = s.match.restart;
    // RUL-05 (stubbed here) would choose the wall; emulate its record.
    r.wallCount = 3;
    r.wall[0] = 13; r.wall[1] = 14; r.wall[2] = 17;
    r.wallX = 30 + 9.15; r.wallZ = 2 * (1 - 9.15 / 22.6);
    const far = spots(s).filter((p) => p.role === SpotRole.WALL);
    expect(far.map((p) => p.slot).sort()).toEqual([13, 14, 17]);
    for (const p of far) expect(dist(p.x, p.z, r.wallX, r.wallZ)).toBeLessThan(1.0);
    // Standing near the wall: hold exactly where he is (RUL-05 places him precisely).
    s.players[14]!.x = r.wallX + 0.3; s.players[14]!.z = r.wallZ - 0.4;
    const pt = { x: 0, z: 0 };
    expect(setPieceTarget(s, 14, pt)).toBe(SpotRole.WALL);
    expect(pt.x).toBe(s.players[14]!.x);
    expect(pt.z).toBe(s.players[14]!.z);
    for (const p of spots(s)) {
      if (p.role === SpotRole.WALL) continue;
      expect(dist(p.x, p.z, r.wallX, r.wallZ), `slot ${p.slot}`).toBeGreaterThan(1.0);
    }
  });

  it('penalty: both teams line the edge of the area outside the arc, alternating; two attackers and a defender further back', () => {
    const s = awarded(RestartKind.PENALTY, 0, 41.5, 0);
    const sp = spots(s);
    const arc = sp.filter((p) => p.role === SpotRole.ARC);
    expect(teamSpots(arc, 0).length).toBe(4);
    expect(teamSpots(arc, 1).length).toBe(4);
    const sorted = [...arc].sort((a, b) => a.z - b.z);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.slot < 11).not.toBe(sorted[i - 1]!.slot < 11);
    expect(teamSpots(sp, 0).filter((p) => p.role === SpotRole.STAY_BACK).every((p) => p.x < 0)).toBe(true);
    expect(teamSpots(sp, 1).filter((p) => p.role === SpotRole.COUNTER).every((p) => p.x < 5)).toBe(true);
  });

  it('routing: a walk that would cross the 9.15 m disc or the penalty area goes round it; inside a zone, out first', () => {
    // Free kick: a defender behind the ball whose spot is goal-side of it.
    const s = awarded(RestartKind.FREE_KICK, 0, 25, 0, { shift: 20 });
    const r = s.match.restart;
    const sp = teamSpots(spots(s), 1).filter((p) => p.x > r.x + 9 && s.players[p.slot]!.ctrl < 0);
    expect(sp.length).toBeGreaterThan(0);
    const mover = sp[0]!;
    const q = s.players[mover.slot]!;
    q.x = r.x - 11; q.z = 0.3; q.vx = 0; q.vz = 0;
    setPiecePositions(s, 1, NULL_SINK);
    expect(q.job).toBe(AiJob.SET_PIECE);
    expect(dist(q.tgtX, q.tgtZ, r.x, r.z)).toBeGreaterThan(RESTART_DISTANCE + LOCAL_TUNING.legalMargin);
    expect(dist(q.tgtX, q.tgtZ, mover.x, mover.z)).toBeGreaterThan(1);
    // Penalty: a player beside the area heads for the outside corner of the area, not through it.
    const pen = awarded(RestartKind.PENALTY, 1, -41.5, 0);
    const arc = teamSpots(spots(pen), 0).find((p) => p.role === SpotRole.ARC && pen.players[p.slot]!.ctrl < 0)!;
    const a = pen.players[arc.slot]!;
    a.x = -44; a.z = Math.sign(arc.z) * 20.6; a.vx = 0; a.vz = 0;
    setPiecePositions(pen, 0, NULL_SINK);
    expect(a.tgtX).toBeGreaterThan(-(HALF_LENGTH - PENALTY_AREA_DEPTH)); // outside the area's front line
    expect(Math.abs(a.tgtZ)).toBeGreaterThan(PENALTY_AREA_HALF_WIDTH);
    // Standing inside the area: step out first.
    a.x = -44; a.z = Math.sign(arc.z) * 12;
    setPiecePositions(pen, 0, NULL_SINK);
    const ex = -a.tgtX, ez = Math.abs(a.tgtZ);
    expect(ex < HALF_LENGTH - PENALTY_AREA_DEPTH || ez > PENALTY_AREA_HALF_WIDTH).toBe(true);
    expect(dist(a.tgtX, a.tgtZ, a.x, a.z)).toBeLessThan(10);
  });

  it('assignments are stable while players walk (no flip-flop)', () => {
    for (const [label, kind, team, x, z] of RESTARTS) {
      const s = awarded(kind, team, x, z, { humans: [{ side: team }] });
      const first = spots(s).map((p) => `${p.slot}:${p.role}`).sort();
      runTicks(s, 90);
      if (s.match.phase === MatchPhase.IN_PLAY) continue;
      const later = spots(s).filter((p) => p.role !== SpotRole.HOLD).map((p) => `${p.slot}:${p.role}`).sort();
      expect(later, label).toEqual(first.filter((k) => !k.endsWith(`:${SpotRole.HOLD}`)));
    }
  });
});

// ---------------------------------------------------------------- positions through the real pipeline

describe('TAI-13 positions through the pipeline (walk in, legal, at rest)', () => {
  const CASES: [string, RestartKind, number, number, number, number][] = [
    ['corner', RestartKind.CORNER, 0, 52.5, -34, 30],
    ['free kick in range', RestartKind.FREE_KICK, 1, -27, 6, -25],
    ['wide free kick', RestartKind.FREE_KICK, 0, 28, 26, 25],
    ['throw-in', RestartKind.THROW_IN, 1, -12, 34, -10],
    ['goal kick', RestartKind.GOAL_KICK, 0, -50, -5, -15],
    ['penalty', RestartKind.PENALTY, 1, -41.5, 0, -25],
  ];
  it.each(CASES)('%s: everybody reaches a legal spot and stands still; nobody runs in place', (label, kind, team, x, z, shift) => {
    // The taking side is a human who does not press anything (12 s timeout), so only the AI moves players. (The
    // defending CPU's controlled player moves only where the kind module moves off-ball players: see the goal kick test.)
    const s = awarded(kind, team, x, z, { humans: [{ side: team }], shift, seed: 4 });
    runTicks(s, 560, undefined, { check: 'core' });
    expect(s.match.phase, label).not.toBe(MatchPhase.IN_PLAY);
    const sp = spots(s);
    const pt = { x: 0, z: 0 };
    for (const p of sp) {
      const q = s.players[p.slot]!;
      if (q.ctrl >= 0) continue;
      setPieceTarget(s, p.slot, pt);
      expect(dist(q.x, q.z, pt.x, pt.z), `${label} slot ${p.slot} role ${p.role}`).toBeLessThan(1.2);
      expect(isLegalRestartPosition(s, p.slot), `${label} slot ${p.slot}`).toBe(true);
      expect(Math.hypot(q.vx, q.vz), `${label} slot ${p.slot} speed`).toBeLessThan(0.6);
    }
    for (let i = 0; i < NUM_SLOTS; i++) {
      for (let j = 0; j < i; j++) {
        const a = s.players[i]!, b = s.players[j]!;
        if (a.active === 1 && b.active === 1) expect(dist(a.x, a.z, b.x, b.z), `${label} ${i}-${j}`).toBeGreaterThan(0.6);
      }
    }
  });
});

// ---------------------------------------------------------------- CPU frames (real pipeline)

interface FrameRec { tick: number; age: number; f: InputFrame; taken: number; phase: MatchPhase }

/** Run the real pipeline, recording the taking CPU's frame (and the restart age) every tick. */
function recordCpu(s: SimState, team: number, n: number, stopWhenTaken = true): FrameRec[] {
  const recs: FrameRec[] = [];
  for (let i = 0; i < n; i++) {
    const age = s.match.restart.t - SETUP; // as cpuThink sees it (rules increment t later in the tick)
    runTicks(s, 1);
    const f = createInputFrame();
    Object.assign(f, s.teams[team]!.cpu.out);
    recs.push({ tick: s.tick, age, f, taken: s.match.restart.taken, phase: s.match.phase });
    if (stopWhenTaken && s.match.phase === MatchPhase.IN_PLAY) break;
  }
  return recs;
}

function active(f: InputFrame): boolean {
  return f.buttons !== 0 || f.gesture !== GestureKind.NONE || f.mx !== 0 || f.mz !== 0;
}

describe('TAI-13 CPU taker: timing and input programs', () => {
  it('does nothing before restart.ready + cpuRestartDelay, then acts within a few ticks (every kind)', () => {
    const cases: [string, () => SimState, number][] = [
      ['kick-off', () => kickOff(1), 1],
      ['throw-in', () => awarded(RestartKind.THROW_IN, 0, 5, -34), 0],
      ['goal kick', () => awarded(RestartKind.GOAL_KICK, 1, 50, 6), 1],
      ['corner', () => awarded(RestartKind.CORNER, 0, 52.5, 34, { shift: 30 }), 0],
      ['free kick', () => awarded(RestartKind.FREE_KICK, 1, -30, 3, { shift: -25 }), 1],
      ['deep free kick', () => awarded(RestartKind.FREE_KICK, 0, -15, -10), 0],
      ['penalty', () => awarded(RestartKind.PENALTY, 0, 41.5, 0), 0],
    ];
    for (const [label, mk, team] of cases) {
      const s = mk();
      const recs = recordCpu(s, team, SETUP + DELAY + LOCAL_TUNING.maxArrivalWait + 40);
      const first = recs.findIndex((r) => active(r.f));
      expect(first, label).toBeGreaterThanOrEqual(0);
      expect(recs[first]!.age, label).toBeGreaterThanOrEqual(DELAY);
      expect(recs[first]!.age, label).toBeLessThanOrEqual(DELAY + LOCAL_TUNING.maxArrivalWait);
    }
  });

  it('kick-off: a single PASS press edge', () => {
    const s = kickOff(0);
    const recs = recordCpu(s, 0, SETUP + DELAY + 10);
    const presses = recs.filter((r) => (r.f.buttons & Btn.PASS) !== 0);
    expect(presses.length).toBe(1);
    expect(presses[0]!.age).toBe(DELAY);
  });

  it('throw-in: TAP on an open teammate 3.5-22 m away (exact target)', () => {
    for (const seed of [1, 2, 3]) {
      const s = awarded(RestartKind.THROW_IN, 1, -20, 34, { seed, shift: -25 });
      const recs = recordCpu(s, 1, SETUP + DELAY + 5, false);
      const tap = recs.find((r) => r.f.gesture === GestureKind.TAP);
      expect(tap, `seed ${seed}`).toBeDefined();
      const g = tap!.f.gSlot;
      expect(g).toBeGreaterThanOrEqual(11);
      expect(s.players[g]!.isKeeper).toBe(0);
      const d = dist(tap!.f.gx / 10, tap!.f.gz / 10, s.match.restart.x, s.match.restart.z);
      expect(d).toBeGreaterThanOrEqual(LOCAL_TUNING.throwMinDist - 0.2);
      expect(d).toBeLessThanOrEqual(LOCAL_TUNING.throwMaxDist + 0.2);
    }
  });

  it('goal kick: TAP (short) or DOUBLE_TAP (long) on the RUL-03 choice, never across the own goal', () => {
    for (const seed of [1, 2, 3, 4]) {
      const s = awarded(RestartKind.GOAL_KICK, 0, -50, 4, { seed });
      const recs = recordCpu(s, 0, SETUP + DELAY + 5, false);
      const g = recs.find((r) => r.f.gesture === GestureKind.TAP || r.f.gesture === GestureKind.DOUBLE_TAP);
      expect(g, `seed ${seed}`).toBeDefined();
      expect(g!.f.gx / 10).toBeGreaterThan(s.match.restart.x); // forward of the ball
      if (g!.f.gSlot >= 0) expect(g!.f.gSlot).toBeLessThan(11);
    }
  });

  it('corner: waits (bounded) for runners, then TAPs a header in the box or plays the short option', () => {
    let taps = 0, shorts = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = awarded(RestartKind.CORNER, 0, 52.5, -34, { seed, shift: 30 });
      const recs = recordCpu(s, 0, SETUP + DELAY + LOCAL_TUNING.maxArrivalWait + 30, false);
      const tap = recs.find((r) => r.f.gesture === GestureKind.TAP);
      const pass = recs.find((r) => (r.f.buttons & Btn.PASS) !== 0);
      if (tap) {
        taps++;
        const x = tap.f.gx / 10, z = tap.f.gz / 10;
        expect(HALF_LENGTH - x).toBeLessThanOrEqual(LOCAL_TUNING.boxDepth + 4.5);
        expect(Math.abs(z)).toBeLessThanOrEqual(PENALTY_AREA_HALF_WIDTH + 0.5);
        if (tap.f.gSlot >= 0) expect(tap.f.gSlot).toBeLessThan(11);
      } else {
        expect(pass, `seed ${seed}`).toBeDefined();
        shorts++;
      }
    }
    expect(taps + shorts).toBe(6);
    expect(taps).toBeGreaterThan(0);
  });

  it('free kick in range: shot with stick aim at the goal mouth, curl (right stick + curve) and SHOOT held for power', () => {
    let shots = 0;
    for (let seed = 1; seed <= 12 && shots < 3; seed++) {
      const s = awarded(RestartKind.FREE_KICK, 0, 31, -3, { seed, shift: 25 });
      s.attrs[s.match.restart.taker]!.curve = 90; // a free-kick specialist
      s.attrs[s.match.restart.taker]!.longShots = 90;
      s.attrs[s.match.restart.taker]!.shotPower = 90;
      const recs = recordCpu(s, 0, SETUP + DELAY + LOCAL_TUNING.maxArrivalWait + 60, false);
      const hold = recs.filter((r) => (r.f.buttons & Btn.SHOOT) !== 0);
      if (hold.length === 0) continue;
      shots++;
      const h0 = hold[0]!.f;
      // Stick toward the goal mouth.
      const r = s.match.restart;
      const tz = r.z + (HALF_LENGTH - r.x) * (h0.mz / h0.mx);
      expect(h0.mx).toBeGreaterThan(0);
      expect(Math.abs(tz)).toBeLessThan(GOAL_HALF_WIDTH + 1.2);
      // Curl both ways it is expressed; RS_HOLD while curling.
      expect(h0.curve).not.toBe(0);
      expect((h0.buttons & Btn.RS_HOLD) !== 0).toBe(true);
      expect(Math.sign(h0.az)).toBe(Math.sign(h0.curve)); // kicking toward +x: curl toward +z is +curve
      // Power from hold: contiguous ticks, inside the tuned range.
      const ticks = hold.length;
      expect(ticks).toBeGreaterThanOrEqual(Math.round(LOCAL_TUNING.fkPowerMin * T_PASS.powerFillTicks) - 1);
      expect(ticks).toBeLessThanOrEqual(Math.round(LOCAL_TUNING.fkPowerMax * T_PASS.powerFillTicks) + 1);
      expect(hold[hold.length - 1]!.tick - hold[0]!.tick).toBe(ticks - 1);
    }
    expect(shots).toBeGreaterThan(0);
  });

  it('penalty: stick aimed inside a post first, then SHOOT held for 64-86% power', () => {
    for (const team of [0, 1]) {
      const s = awarded(RestartKind.PENALTY, team, team === 0 ? 41.5 : -41.5, 0);
      const recs = recordCpu(s, team, SETUP + DELAY + 80, false);
      const firstStick = recs.findIndex((r) => r.f.mx !== 0);
      const firstShoot = recs.findIndex((r) => (r.f.buttons & Btn.SHOOT) !== 0);
      expect(firstStick).toBeGreaterThanOrEqual(0);
      expect(firstShoot - firstStick).toBe(LOCAL_TUNING.shotAimTicks);
      const hold = recs.filter((r) => (r.f.buttons & Btn.SHOOT) !== 0).length;
      expect(hold).toBeGreaterThanOrEqual(Math.round(LOCAL_TUNING.penPowerMin * T_PASS.powerFillTicks) - 1);
      expect(hold).toBeLessThanOrEqual(Math.round(LOCAL_TUNING.penPowerMax * T_PASS.powerFillTicks) + 1);
      const f = recs[firstShoot]!.f;
      expect(Math.sign(f.mx)).toBe(s.teams[team]!.dir);
    }
  });

  it('penalties aim at both corners, mostly inside the posts; Beginner misses the target more than Legend', () => {
    const aims = (level: Difficulty): number[] => {
      const out: number[] = [];
      for (let seed = 1; seed <= 60; seed++) {
        const s = awarded(RestartKind.PENALTY, 0, 41.5, 0, { seed, level });
        // Jump to the decision: ready, delay elapsed, CPU holding the taker.
        s.match.restart.ready = 1;
        s.match.restart.t = SETUP + DELAY;
        const ci = CPU_CONTROLLER_BASE;
        s.ctrl[ci]!.slot = s.match.restart.taker;
        const f = createInputFrame();
        cpuSetPiece(s, 0, f, NULL_SINK);
        expect(f.mx).toBeGreaterThan(0);
        out.push(s.ball.z + (HALF_LENGTH - s.ball.x) * (f.mz / f.mx));
      }
      return out;
    };
    const legend = aims(Difficulty.LEGEND);
    const beginner = aims(Difficulty.BEGINNER);
    expect(legend.some((z) => z > 1.5)).toBe(true);
    expect(legend.some((z) => z < -1.5)).toBe(true);
    const off = (l: number[]) => l.filter((z) => Math.abs(z) > GOAL_HALF_WIDTH - 0.1).length;
    expect(off(legend)).toBeLessThanOrEqual(3);
    expect(off(beginner)).toBeGreaterThanOrEqual(off(legend));
    const spread = (l: number[]) => l.reduce((a, z) => a + Math.abs(Math.abs(z) - 2.9), 0) / l.length;
    expect(spread(beginner)).toBeGreaterThan(spread(legend));
  });

  it('retries a decision that the kind module did not take, with the button equivalent, and stops once taken', () => {
    // Goal kick with the SIM-08/09 starters still stubbed (or a module that ignores the gesture): no kick happens.
    const s = awarded(RestartKind.GOAL_KICK, 1, 50, -6);
    const b = s.teams[1]!.cpu;
    const recs = recordCpu(s, 1, SETUP + DELAY + LOCAL_TUNING.retryTicks + 30, false);
    if (s.match.restart.taken === 1) return; // real starters: taken by the first input (covered elsewhere)
    const firstGesture = recs.findIndex((r) => r.f.gesture !== GestureKind.NONE);
    const firstButton = recs.findIndex((r) => (r.f.buttons & (Btn.PASS | Btn.LOB)) !== 0);
    expect(firstGesture).toBeGreaterThanOrEqual(0);
    expect(firstButton).toBeGreaterThan(firstGesture);
    expect(recs[firstButton]!.age - recs[firstGesture]!.age).toBeGreaterThanOrEqual(LOCAL_TUNING.retryTicks);
    // The stick aimed before the press (aimTicks), toward the target.
    expect(recs[firstButton - 1]!.f.mx !== 0 || recs[firstButton - 1]!.f.mz !== 0).toBe(true);
    // Program state is clean once its input is complete.
    for (let i = 0; i < 40; i++) runTicks(s, 1);
    if ((b.p1 & 15) === 5) { expect(b.plan).toBe(CpuPlan.NONE); expect(b.holdTicks).toBe(0); }
  });

  it('a human side gets nothing from cpuSetPiece; a CPU never presses on a restart it is not taking or defending', () => {
    const s = awarded(RestartKind.CORNER, 0, 52.5, 34, { humans: [{ side: 0 }] });
    const recs = recordCpu(s, 0, SETUP + DELAY + 80, false);
    expect(recs.every((r) => !active(r.f))).toBe(true);
    const f = createInputFrame();
    const play = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
    cpuSetPiece(play, 0, f, NULL_SINK);
    expect(active(f)).toBe(false);
  });
});

describe('TAI-13 CPU defending set pieces', () => {
  function fkWithShot(level: Difficulty): { s: SimState; f: InputFrame; fire: (actT: number) => boolean } {
    const s = awarded(RestartKind.FREE_KICK, 0, 30, 2, { level });
    const r = s.match.restart;
    r.ready = 1;
    r.t = SETUP + 70;
    r.wallCount = 3; r.wall[0] = 13; r.wall[1] = 14; r.wall[2] = 17;
    r.wallX = 39; r.wallZ = 1.2;
    const p = s.players[r.taker]!;
    p.act = ActionKind.SHOT; p.actKick = KickKind.FREE_KICK_SHOT; p.actCharging = 0; p.actContact = 20; p.actDone = 0; p.actDur = 40;
    const f = createInputFrame();
    const fire = (actT: number): boolean => {
      p.actT = actT;
      for (const k of Object.keys(f) as (keyof InputFrame)[]) (f as unknown as Record<string, number>)[k] = k === 'gSlot' ? -1 : 0;
      cpuSetPiece(s, 1, f, NULL_SINK);
      return (f.buttons & Btn.THROUGH) !== 0;
    };
    return { s, f, fire };
  }

  it('wall jump: THROUGH once, at the kick moment of a shooting free kick (Legend: wallJumpLeadTicks before contact)', () => {
    const { fire } = fkWithShot(Difficulty.LEGEND);
    const jumps: number[] = [];
    for (let actT = 0; actT < 20; actT++) if (fire(actT)) jumps.push(actT);
    expect(jumps.length).toBe(1);
    const ttc = 20 - (jumps[0]! + 1);
    expect(Math.abs(ttc - LOCAL_TUNING.wallJumpLeadTicks)).toBeLessThanOrEqual(1);
  });

  it('wall jump: not for a pass, not while the shot is still charging, not without a wall', () => {
    const a = fkWithShot(Difficulty.PROFESSIONAL);
    a.s.players[a.s.match.restart.taker]!.act = ActionKind.KICK;
    for (let actT = 0; actT < 20; actT++) expect(a.fire(actT)).toBe(false);
    const b = fkWithShot(Difficulty.PROFESSIONAL);
    b.s.players[b.s.match.restart.taker]!.actCharging = 1;
    for (let actT = 0; actT < 20; actT++) expect(b.fire(actT)).toBe(false);
    const c = fkWithShot(Difficulty.PROFESSIONAL);
    c.s.match.restart.wallCount = 0;
    for (let actT = 0; actT < 20; actT++) expect(c.fire(actT)).toBe(false);
  });

  it('wall jump timing gets less precise at lower levels (deterministic per seed)', () => {
    const err = (level: Difficulty): number => {
      let sum = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const t = fkWithShot(level);
        t.s.rng.a = seed * 7919; t.s.rng.b = seed; t.s.rng.c = 12345; t.s.rng.d = 1;
        let jumpAt = 21;
        for (let actT = 0; actT < 20; actT++) if (t.fire(actT)) { jumpAt = actT; break; }
        sum += Math.abs(20 - (jumpAt + 1) - LOCAL_TUNING.wallJumpLeadTicks);
      }
      return sum / 30;
    };
    expect(err(Difficulty.BEGINNER)).toBeGreaterThan(err(Difficulty.LEGEND));
  });

  it('the CPU-controlled defender walks to his spot with the stick (goal kick: RUL-03 moves off-ball players); neutral at penalties', () => {
    const s = awarded(RestartKind.GOAL_KICK, 0, -50, 5, { humans: [{ side: 0 }] });
    runTicks(s, 2);
    const c = s.ctrl[CPU_CONTROLLER_BASE + 1]!;
    const slot = c.slot;
    const pt = { x: 0, z: 0 };
    expect(setPieceTarget(s, slot, pt)).not.toBe(SpotRole.NONE);
    const p = s.players[slot]!;
    const f = createInputFrame();
    cpuSetPiece(s, 1, f, NULL_SINK);
    const d = dist(p.x, p.z, pt.x, pt.z);
    if (d > LOCAL_TUNING.stickArrive) {
      expect(f.mx * (pt.x - p.x) + f.mz * (pt.z - p.z)).toBeGreaterThan(0);
    }
    runTicks(s, 450);
    expect(s.ctrl[CPU_CONTROLLER_BASE + 1]!.slot).toBe(slot);
    setPieceTarget(s, slot, pt);
    expect(dist(p.x, p.z, pt.x, pt.z)).toBeLessThan(1.2);
    expect(isLegalRestartPosition(s, slot)).toBe(true);
    const pen = awarded(RestartKind.PENALTY, 0, 41.5, 0, { humans: [{ side: 0 }] });
    for (let i = 0; i < SETUP + DELAY + 20; i++) {
      runTicks(pen, 1);
      expect(active(pen.teams[1]!.cpu.out)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- determinism

describe('TAI-13 determinism', () => {
  const run = (s: SimState, n: number): number[] => {
    const h: number[] = [];
    for (let i = 0; i < n; i++) { runTicks(s, 1); h.push(hashState(s)); }
    return h;
  };
  it('same seed and inputs: identical state hashes through restarts of every kind (bot v bot)', () => {
    const mk = (): SimState[] => [
      awarded(RestartKind.CORNER, 0, 52.5, -34, { seed: 9, shift: 30 }),
      awarded(RestartKind.FREE_KICK, 1, -30, 4, { seed: 9, shift: -25 }),
      awarded(RestartKind.THROW_IN, 0, 20, 34, { seed: 9 }),
      awarded(RestartKind.PENALTY, 1, -41.5, 0, { seed: 9 }),
      kickOff(0, { seed: 9 }),
      shootout(1, 15, { seed: 9 }),
    ];
    const a = mk(), b = mk();
    for (let i = 0; i < a.length; i++) expect(run(a[i]!, 260)).toEqual(run(b[i]!, 260));
  });

  it('no hidden module state: a clone taken mid-restart continues bit-identically', () => {
    const s = awarded(RestartKind.FREE_KICK, 0, 29, -6, { seed: 13, shift: 25 });
    runTicks(s, SETUP + DELAY - 5);
    const c = cloneState(s);
    // Run something else in between (module scratch gets other data).
    runTicks(awarded(RestartKind.CORNER, 1, -52.5, 34, { seed: 2 }), 30);
    expect(run(c, 120)).toEqual(run(s, 120));
  });
});

// ---------------------------------------------------------------- end to end with the real kind modules (auto-enabled)

/** True once SIM-08/09/11 starters start kicks (they are stubs returning 0 in early Wave 1). */
function startersReady(): boolean {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  const p = s.players[9]!;
  s.ball.x = p.x + 0.4; s.ball.z = p.z; s.ball.owner = 9;
  const req = createActionRequest();
  req.dirX = 1; req.power = 0.5;
  const a = startPass(s, 9, KickKind.GROUND_PASS, req, NULL_SINK);
  const s2 = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  s2.ball.x = s2.players[9]!.x + 0.4; s2.ball.z = s2.players[9]!.z; s2.ball.owner = 9;
  const b = startLob(s2, 9, KickKind.LOB_PASS, req, NULL_SINK);
  const s3 = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  s3.ball.x = s3.players[9]!.x + 0.4; s3.ball.z = s3.players[9]!.z; s3.ball.owner = 9;
  const c = startShot(s3, 9, KickKind.SHOT_NORMAL, req, NULL_SINK);
  return a === 1 && b === 1 && c === 1;
}

/** True once a kind module's Setup chooses a taker (all RUL-02..06 briefs require it). */
function setupReady(kind: RestartKind, fn: (s: SimState, ev: typeof NULL_SINK) => void, x: number, z: number): boolean {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  const r = s.match.restart;
  r.kind = kind; r.team = 0; r.x = x; r.z = z; r.taker = -1;
  try { fn(s, NULL_SINK); } catch { return false; }
  return r.taker >= 0;
}

const STARTERS = startersReady();
const READY = {
  kickOff: STARTERS,
  throwIn: setupReady(RestartKind.THROW_IN, throwInSetup, 10, 34),
  goalKick: STARTERS && setupReady(RestartKind.GOAL_KICK, goalKickSetup, -47, 5),
  corner: STARTERS && setupReady(RestartKind.CORNER, cornerSetup, 52, 33.5),
  freeKick: STARTERS && setupReady(RestartKind.FREE_KICK, freeKickSetup, 28, 4),
  penalty: STARTERS && setupReady(RestartKind.PENALTY, penaltySetup, 41.5, 0),
  shootout: STARTERS && (() => {
    const s = makeScenario({ phase: MatchPhase.SHOOT_OUT, humans: 0 });
    try { shootoutStart(s, NULL_SINK); } catch { return false; }
    return s.match.shootout.active === 1;
  })(),
};

describe('TAI-13 end to end: the CPU completes every restart kind within a few seconds, no watchdog (real modules)', () => {
  const budget = SETUP + DELAY + LOCAL_TUNING.maxArrivalWait + 120;
  const complete = (s: SimState, label: string): void => {
    const ev = runTicks(s, budget, undefined, { until: (st) => st.match.phase === MatchPhase.IN_PLAY });
    expect(s.match.phase, label).toBe(MatchPhase.IN_PLAY);
    expect(ev.filter((e) => e.type === EventType.WATCHDOG), label).toEqual([]);
    expect(ev.some((e) => e.type === EventType.KICK), label).toBe(true);
  };
  it.runIf(READY.kickOff)('kick-off', () => { complete(kickOff(1), 'kick-off'); });
  it.runIf(READY.throwIn)('throw-in (both sides of the pitch)', () => {
    complete(awarded(RestartKind.THROW_IN, 0, 12, 34), 'throw-in +z');
    complete(awarded(RestartKind.THROW_IN, 1, -25, -34, { seed: 3 }), 'throw-in -z');
  });
  it.runIf(READY.goalKick)('goal kick', () => { complete(awarded(RestartKind.GOAL_KICK, 0, -50, 4), 'goal kick'); });
  it.runIf(READY.corner)('corner', () => { complete(awarded(RestartKind.CORNER, 1, -52.5, 34, { shift: -30 }), 'corner'); });
  it.runIf(READY.freeKick)('free kicks (shooting range, wide, deep)', () => {
    complete(awarded(RestartKind.FREE_KICK, 0, 30, 3, { shift: 25 }), 'fk shoot');
    complete(awarded(RestartKind.FREE_KICK, 1, -25, -28, { shift: -25 }), 'fk wide');
    complete(awarded(RestartKind.FREE_KICK, 0, -15, 10), 'fk deep');
  });
  it.runIf(READY.penalty)('penalty', () => { complete(awarded(RestartKind.PENALTY, 0, 41.5, 0), 'penalty'); });
  it.runIf(READY.shootout)('shoot-out: CPU kickers take their kicks', () => {
    const s = makeScenario({ phase: MatchPhase.SHOOT_OUT, humans: 0 });
    shootoutStart(s, NULL_SINK);
    const ev = runTicks(s, 2400, undefined, { until: (st) => st.match.shootout.taken[0]! + st.match.shootout.taken[1]! >= 4 });
    expect(s.match.shootout.taken[0]! + s.match.shootout.taken[1]!).toBeGreaterThanOrEqual(4);
    expect(ev.filter((e) => e.type === EventType.WATCHDOG)).toEqual([]);
  });
});
