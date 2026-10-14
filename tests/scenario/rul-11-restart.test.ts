/**
 * RUL-11: the common restart flow (awardRestart, restartTick, legalizePositions, SET_PIECE, timeouts, forced kick)
 * and the glitch-list "Restarts" lines: taker missing or sent off; opponents inside the required distance blocking
 * forever; ball out of play during a restart; restart given to the wrong team; two restarts queued; kick-off with
 * players in the wrong half.
 *
 * The real pipeline runs (step.ts with RUL-01's machine, the resolver and switching, locomotion, bodies, ball
 * physics). Mocked so that only RUL-11 decides what happens at a restart:
 *  - RUL-02..06 kind modules: Setup / Default are spies with optional per-test hooks; their ticks, inputs and the
 *    THROW_IN handler do nothing (the real ones would take restarts on their own timers).
 *  - team AI and CPU brains: no-ops (nobody else moves players or takes restarts);
 *  - contacts: no-op (no loose-ball pick-ups); RUL-09 showCard: spy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// [QF-1] Evaluate rules/restart before anything reaches the mocked kind modules: when the real throwin.ts is loaded
// first (inside its mock factory) it pulls restart.ts in, and restart.ts then binds to the ORIGINAL throwin exports
// (the mock is still being built), so the Setup / Default spies were never called for throw-ins.
import '../../src/sim/rules/restart';
import {
  BALL_RADIUS, CENTRE_CIRCLE_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH,
  NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_ARC_RADIUS, PENALTY_SPOT_DIST, PLAYERS_PER_TEAM,
  RESTART_DISTANCE, THROW_IN_DISTANCE, teamFirstSlot,
} from '../../src/contracts/constants';
import { ActionKind, CardKind, KickKind, MatchPhase, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType, WhistleKind, type EventSink, type SimEvent } from '../../src/contracts/events';
import { clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { MoveMode, RosterStatus, type SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_PLAYER, T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { applyKick } from '../../src/sim/core/kick';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { step } from '../../src/sim/step';
import {
  LOCAL_TUNING, SETPIECE_INPUT, awardRestart, forceRestartKick, isLegalRestartPosition, legalizePositions,
  pickRestartTaker, prepareTakerKick, restartTick,
} from '../../src/sim/rules/restart';
import { setPieceHandler } from '../../src/sim/rules/restartCommon';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { makeScenario } from '../harness/scenario';

type Hook = ((s: SimState, ev: EventSink) => void) | null;

const H = vi.hoisted(() => ({
  log: [] as string[],
  setup: [null, null, null, null, null, null, null] as (((s: unknown, ev: unknown) => void) | null)[],
  dflt: [null, null, null, null, null, null, null] as (((s: unknown, ev: unknown) => void) | null)[],
  cards: [] as number[][],
}));

vi.mock('../../src/sim/rules/throwin', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/throwin')>()),
  throwInSetup: (s: unknown, ev: unknown) => { H.log.push('setup:2'); H.setup[2]?.(s, ev); },
  throwInDefault: (s: unknown, ev: unknown) => { H.log.push('default:2'); H.dflt[2]?.(s, ev); },
  throwInTick: () => { /* none */ },
  throwInInput: () => { /* none */ },
  throwInHandler: { update() { /* none */ }, end() { /* none */ } },
}));
vi.mock('../../src/sim/rules/goalkick', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/goalkick')>()),
  goalKickSetup: (s: unknown, ev: unknown) => { H.log.push('setup:3'); H.setup[3]?.(s, ev); },
  goalKickDefault: (s: unknown, ev: unknown) => { H.log.push('default:3'); H.dflt[3]?.(s, ev); },
  goalKickTick: () => { /* none */ },
  goalKickInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/corner', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/corner')>()),
  cornerSetup: (s: unknown, ev: unknown) => { H.log.push('setup:4'); H.setup[4]?.(s, ev); },
  cornerDefault: (s: unknown, ev: unknown) => { H.log.push('default:4'); H.dflt[4]?.(s, ev); },
  cornerTick: () => { /* none */ },
  cornerInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/freekick', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/freekick')>()),
  freeKickSetup: (s: unknown, ev: unknown) => { H.log.push('setup:5'); H.setup[5]?.(s, ev); },
  freeKickDefault: (s: unknown, ev: unknown) => { H.log.push('default:5'); H.dflt[5]?.(s, ev); },
  freeKickTick: () => { /* none */ },
  freeKickInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/penalty', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/penalty')>()),
  penaltySetup: (s: unknown, ev: unknown) => { H.log.push('setup:6'); H.setup[6]?.(s, ev); },
  penaltyDefault: (s: unknown, ev: unknown) => { H.log.push('default:6'); H.dflt[6]?.(s, ev); },
  penaltyTick: () => { /* none */ },
  penaltyInput: () => { /* none */ },
}));
vi.mock('../../src/sim/rules/fouls', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/rules/fouls')>()),
  showCard: (_s: unknown, slot: number, kind: number) => { H.cards.push([slot, kind]); },
}));
vi.mock('../../src/ai/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/index')>()),
  teamAiTick: () => { /* none */ },
}));
vi.mock('../../src/ai/cpu/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/index')>()),
  cpuThink: () => { /* none */ },
}));
vi.mock('../../src/sim/contacts', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/contacts')>()),
  contactsTick: () => { /* none */ },
}));

beforeEach(() => {
  H.log.length = 0;
  H.cards.length = 0;
  for (let i = 0; i < 7; i++) { H.setup[i] = null; H.dflt[i] = null; }
});

function setHook(table: 'setup' | 'dflt', kind: RestartKind, fn: Hook): void {
  H[table][kind] = fn as ((s: unknown, ev: unknown) => void) | null;
}

// ---------------------------------------------------------------- harness

const SETUP = T_RULES.restartSetupTicks;
const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser'); // team AI is mocked out
const EV = createEventBuffer();

function award(s: SimState, kind: RestartKind, team: number, x: number, z: number): SimEvent[] {
  EV.begin(s.tick);
  awardRestart(s, kind, team, x, z, EV);
  return EV.toArray();
}

interface RunOpts {
  inputs?: (s: SimState, frames: InputFrame[]) => void;
  until?: (s: SimState) => boolean;
}

/** Step the real pipeline n ticks with every invariant but 'chaser' checked; returns all events. */
function run(s: SimState, n: number, opts: RunOpts = {}): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker(CHECKS);
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    opts.inputs?.(s, frames);
    step(s, frames, events);
    for (let k = 0; k < events.count; k++) all.push({ ...events.get(k) });
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (opts.until?.(s)) break;
  }
  return all;
}

function ofType(ev: readonly SimEvent[], type: EventType): SimEvent[] {
  return ev.filter((e) => e.type === type);
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

function inPA(x: number, z: number, end: number): boolean {
  return end * x >= HALF_LENGTH - PENALTY_AREA_DEPTH && end * x <= HALF_LENGTH && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH;
}

/**
 * Independent Laws-of-the-game check of every non-taker position for the current restart (not RUL-11's own code).
 * Returns a description of each illegal player.
 */
function illegalPositions(s: SimState): string[] {
  const r = s.match.restart;
  const out: string[] = [];
  const tol = 0.06;
  const dir = s.teams[r.team]!.dir;
  const defKeeper = s.teams[1 - r.team]!.keeperSlot;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || i === r.taker) continue;
    const opp = p.team !== r.team;
    if (r.kind === RestartKind.PENALTY && i === defKeeper) {
      if (Math.abs(p.x - dir * HALF_LENGTH) > 1.0 + 1e-9 || Math.abs(p.z) > GOAL_HALF_WIDTH) out.push(`${i} keeper off his line`);
      continue;
    }
    if (Math.abs(p.x) > HALF_LENGTH || Math.abs(p.z) > HALF_WIDTH) out.push(`${i} off the pitch (${p.x}, ${p.z})`);
    const d = dist(p.x, p.z, r.x, r.z);
    switch (r.kind) {
      case RestartKind.KICK_OFF:
        if (s.teams[p.team]!.dir * p.x > 1e-9) out.push(`${i} in the wrong half`);
        if (opp && Math.hypot(p.x, p.z) < CENTRE_CIRCLE_RADIUS - tol) out.push(`${i} in the centre circle`);
        break;
      case RestartKind.THROW_IN:
        if (opp && d < THROW_IN_DISTANCE - tol) out.push(`${i} within 2 m`);
        break;
      case RestartKind.CORNER:
        if (opp && d < RESTART_DISTANCE - tol) out.push(`${i} within 9.15 m`);
        break;
      case RestartKind.GOAL_KICK:
        if (opp && (d < RESTART_DISTANCE - tol || inPA(p.x, p.z, -dir))) out.push(`${i} in the area / within 9.15 m`);
        break;
      case RestartKind.FREE_KICK: {
        if (!opp) break;
        const onLine = Math.abs(p.x - dir * HALF_LENGTH) <= 0.6 && Math.abs(p.z) <= GOAL_HALF_WIDTH;
        if (d < RESTART_DISTANCE - tol && !onLine) out.push(`${i} within 9.15 m`);
        if (inPA(r.x, r.z, -dir) && inPA(p.x, p.z, -dir)) out.push(`${i} in the kicking team's area`);
        break;
      }
      case RestartKind.PENALTY:
        if (inPA(p.x, p.z, dir) || d < PENALTY_ARC_RADIUS - tol) out.push(`${i} in the area / arc`);
        break;
      default:
        break;
    }
  }
  return out;
}

function sendOff(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const t = s.teams[p.team]!;
  p.active = 0;
  p.act = ActionKind.NONE;
  if (p.ctrl >= 0) { s.ctrl[p.ctrl]!.slot = -1; p.ctrl = -1; }
  p.x = 0; p.z = -42;
  t.roster[p.rosterIdx] = RosterStatus.SENT_OFF;
  t.onPitch--;
}

/** Take the restart the way a kind module would: free the taker, kick the ball into the pitch through applyKick. */
function takeRestart(s: SimState, ev: EventSink): void {
  const r = s.match.restart;
  const dir = s.teams[r.team]!.dir;
  prepareTakerKick(s, r.taker);
  let tx = r.x + dir * 15, tz = r.z * 0.5;
  if (r.kind === RestartKind.CORNER) { tx = dir * (HALF_LENGTH - PENALTY_SPOT_DIST); tz = 0; }
  if (r.kind === RestartKind.THROW_IN) { tx = r.x; tz = 0; }
  const d = Math.hypot(tx - s.ball.x, tz - s.ball.z);
  const l = createKickLaunch();
  l.vx = ((tx - s.ball.x) / d) * 10;
  l.vz = ((tz - s.ball.z) / d) * 10;
  l.vy = r.kind === RestartKind.THROW_IN ? 3 : 0;
  l.kind = r.kind === RestartKind.THROW_IN ? KickKind.THROW_IN : KickKind.GROUND_PASS;
  applyKick(s, r.taker, l, 0.5, ev);
}

const NULL_EV: EventSink = { emit() { /* none */ } };

function base(opts: { humans?: number; seed?: number } = {}): SimState {
  return makeScenario({ phase: MatchPhase.IN_PLAY, humans: opts.humans ?? 0, seed: opts.seed ?? 11 });
}

// ---------------------------------------------------------------- awardRestart

describe('RUL-11 awardRestart', () => {
  it('fills the restart, places the ball still, interrupts actions (falls finish), emits events, calls Setup, sets the phase', () => {
    const s = base();
    const b = s.ball;
    b.x = 10; b.z = 35; b.vx = 5; b.vy = 1; b.owner = 9; b.shotBy = 9; b.passTarget = 7;
    s.players[3]!.act = ActionKind.KICK; s.players[3]!.actDur = 20; s.players[3]!.actT = 4;
    s.players[4]!.act = ActionKind.FALLEN; s.players[4]!.actDur = 70; s.players[4]!.actT = 5;
    const ev = award(s, RestartKind.THROW_IN, 1, 10.4, 34);
    const r = s.match.restart;
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
    expect([r.kind, r.team, r.x, r.z, r.t, r.ready, r.taken, r.timeoutT, r.wallCount]).toEqual(
      [RestartKind.THROW_IN, 1, 10.4, HALF_WIDTH, 0, 0, 0, T_RULES.restartTimeoutTicks, 0]);
    expect(r.wall.every((w) => w === -1)).toBe(true);
    expect([b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner, b.heldBy, b.shotBy, b.passTarget]).toEqual(
      [10.4, BALL_RADIUS, HALF_WIDTH, 0, 0, 0, -1, -1, -1, -1]);
    expect(s.players[3]!.act).toBe(ActionKind.NONE);
    expect(s.players[4]!.act).toBe(ActionKind.FALLEN); // falls finish
    expect(H.log).toEqual(['setup:2']);
    expect(r.taker).toBeGreaterThanOrEqual(teamFirstSlot(1)); // Setup left none: RUL-11 picked one of team 1
    expect(s.players[r.taker]!.isKeeper).toBe(0);
    const types = ev.map((e) => e.type);
    expect(types).toEqual([EventType.RESTART_AWARDED, EventType.WHISTLE, EventType.PHASE_CHANGE]);
    expect(ev[0]).toMatchObject({ a: RestartKind.THROW_IN, b: 1, x: 10.4, z: HALF_WIDTH });
    expect(ev[1]!.a).toBe(WhistleKind.SHORT);
    expect(ev[2]).toMatchObject({ a: MatchPhase.IN_PLAY, b: MatchPhase.THROW_IN });
  });

  it('glitch "two restarts queued": a second award in the same tick, a nested award from a Setup and an award while pending are ignored', () => {
    const s = base();
    setHook('setup', RestartKind.FREE_KICK, (st, ev) => awardRestart(st, RestartKind.PENALTY, 0, 40, 0, ev));
    const ev1 = award(s, RestartKind.FREE_KICK, 1, -20, 5);
    const ev2 = award(s, RestartKind.THROW_IN, 0, 3, -34);
    expect(ofType(ev1, EventType.RESTART_AWARDED)).toHaveLength(1);
    expect(ev2).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect([s.match.restart.kind, s.match.restart.team, s.match.restart.x, s.match.restart.z]).toEqual([RestartKind.FREE_KICK, 1, -20, 5]);
    // still pending a second later
    const evs = run(s, 60, { inputs: (st) => { if (st.tick === s.tick) awardRestart(st, RestartKind.CORNER, 0, 52, 33, NULL_EV); } });
    expect(ofType(evs, EventType.RESTART_AWARDED)).toHaveLength(0);
    expect(s.match.restart.kind).toBe(RestartKind.FREE_KICK);
  });

  it('a restart that was just taken goes through IN_PLAY (legal transitions only)', () => {
    const s = base();
    award(s, RestartKind.CORNER, 0, 52, 33.5);
    s.match.restart.taken = 1; // the corner was played this tick; a foul follows in the same tick
    const ev = award(s, RestartKind.FREE_KICK, 1, 40, 10);
    const pc = ofType(ev, EventType.PHASE_CHANGE).map((e) => [e.a, e.b]);
    expect(pc).toEqual([[MatchPhase.CORNER, MatchPhase.IN_PLAY], [MatchPhase.IN_PLAY, MatchPhase.FREE_KICK]]);
    expect(s.match.restart.kind).toBe(RestartKind.FREE_KICK);
  });

  it('refuses awards the phase cannot take (cut-scenes) and invalid kinds / teams', () => {
    const s = base();
    s.match.phase = MatchPhase.GOAL;
    expect(award(s, RestartKind.THROW_IN, 0, 0, 34)).toHaveLength(0);
    s.match.phase = MatchPhase.IN_PLAY;
    expect(award(s, RestartKind.NONE, 0, 0, 0)).toHaveLength(0);
    expect(award(s, RestartKind.THROW_IN, 2, 0, 34)).toHaveLength(0);
    expect(award(s, RestartKind.KICK_OFF, 0, 0, 0)).toHaveLength(0); // IN_PLAY -> KICK_OFF is not a legal transition
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('glitch "restart given to the wrong team": corners, goal kicks and penalties at the wrong end are refused and logged', () => {
    const s = base(); // team 0 attacks +x
    const before = s.match.watchdogCount;
    const e1 = award(s, RestartKind.CORNER, 0, -52, 33); // a corner at its own end
    const e2 = award(s, RestartKind.GOAL_KICK, 0, 52, 3); // a goal kick at the end it attacks
    const e3 = award(s, RestartKind.PENALTY, 1, 45, 0); // team 1 attacks -x
    for (const e of [e1, e2, e3]) {
      expect(ofType(e, EventType.RESTART_AWARDED)).toHaveLength(0);
      expect(ofType(e, EventType.WATCHDOG).map((w) => w.a)).toEqual([WatchdogReason.OTHER]);
    }
    expect(s.match.watchdogCount).toBe(before + 3);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    // After the sides swap the same end is right for the other team.
    s.teams[0]!.dir = -1; s.teams[1]!.dir = 1;
    award(s, RestartKind.CORNER, 0, -52, 33);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(s.match.restart.x).toBeLessThan(-HALF_LENGTH + 1);
  });

  it('puts every kind on a legal spot for its team', () => {
    const cases: [RestartKind, number, number, number, (x: number, z: number) => boolean][] = [
      [RestartKind.KICK_OFF, 0, 5, 5, (x, z) => x === 0 && z === 0],
      [RestartKind.PENALTY, 0, 40, 9, (x, z) => x === HALF_LENGTH - PENALTY_SPOT_DIST && z === 0],
      [RestartKind.PENALTY, 1, -44, 3, (x, z) => x === -(HALF_LENGTH - PENALTY_SPOT_DIST) && z === 0],
      [RestartKind.THROW_IN, 0, 70, -20, (x, z) => x === HALF_LENGTH && z === -HALF_WIDTH],
      [RestartKind.GOAL_KICK, 0, -52.7, 25, (x, z) => x === -(HALF_LENGTH - GOAL_AREA_DEPTH) && z === GOAL_AREA_HALF_WIDTH],
      [RestartKind.GOAL_KICK, 1, 50, -4, (x, z) => x === 50 && z === -4],
      [RestartKind.CORNER, 0, 52.6, -34.2, (x, z) => x < HALF_LENGTH && x > HALF_LENGTH - 1 && z > -HALF_WIDTH && z < -HALF_WIDTH + 1],
      [RestartKind.FREE_KICK, 0, 51, 2, (x, z) => x === HALF_LENGTH - GOAL_AREA_DEPTH && z === 2],
      [RestartKind.FREE_KICK, 1, 51, 2, (x, z) => x === 51 && z === 2], // own goal area: allowed
      [RestartKind.FREE_KICK, 1, 10, -50, (x, z) => x === 10 && z === -HALF_WIDTH],
    ];
    for (const [kind, team, x, z, ok] of cases) {
      const s = base();
      award(s, kind === RestartKind.KICK_OFF ? RestartKind.FREE_KICK : kind, team, x, z);
      if (kind === RestartKind.KICK_OFF) {
        // kick-offs come from a cut-scene; check the spot through a REPLAY -> KICK_OFF award
        const k = base();
        k.match.phase = MatchPhase.REPLAY;
        award(k, RestartKind.KICK_OFF, team, x, z);
        expect(ok(k.match.restart.x, k.match.restart.z)).toBe(true);
        expect(k.match.phase).toBe(MatchPhase.KICK_OFF);
        continue;
      }
      const r = s.match.restart;
      expect(ok(r.x, r.z), `${RestartKind[kind]} team ${team} -> (${r.x}, ${r.z})`).toBe(true);
      expect([s.ball.x, s.ball.z]).toEqual([r.x, r.z]);
    }
  });

  it('resolves a running advantage as played on and shows its pending card', () => {
    const s = base();
    const a = s.match.advantage;
    a.active = 1; a.team = 0; a.offender = 14; a.victim = 9; a.card = CardKind.YELLOW;
    s.match.offside.flags = 0b1010;
    const ev = award(s, RestartKind.THROW_IN, 0, 0, 34);
    expect(a.active).toBe(0);
    expect(a.card).toBe(CardKind.NONE);
    expect(H.cards).toEqual([[14, CardKind.YELLOW]]);
    expect(ofType(ev, EventType.ADVANTAGE).map((e) => [e.a, e.b])).toEqual([[0, 0]]);
    expect(s.match.offside.flags).toBe(0);
  });

  it("adopts the Setup's ball position as the spot (not for penalties)", () => {
    const s = base();
    setHook('setup', RestartKind.GOAL_KICK, (st) => { st.ball.x = -46; st.ball.z = 6; });
    award(s, RestartKind.GOAL_KICK, 0, -52.6, 20);
    expect([s.match.restart.x, s.match.restart.z]).toEqual([-46, 6]);
    const p = base();
    setHook('setup', RestartKind.PENALTY, (st) => { st.ball.x = 10; });
    award(p, RestartKind.PENALTY, 0, 45, 1);
    expect([p.ball.x, p.ball.z]).toEqual([HALF_LENGTH - PENALTY_SPOT_DIST, 0]);
  });
});

// ---------------------------------------------------------------- legal positions

describe('RUL-11 legal positions', () => {
  /** Scatter every player around the ball spot (worst case) and run to ready. */
  function crowdAndReady(kind: RestartKind, team: number, x: number, z: number): SimState {
    const s = base();
    award(s, kind, team, x, z);
    const r = s.match.restart;
    for (let i = 0; i < NUM_SLOTS; i++) {
      if (i === r.taker) continue;
      const p = s.players[i]!;
      const a = (i * 2.399) % (2 * Math.PI);
      const rad = 0.8 + (i % 6) * 1.1;
      p.x = Math.max(-HALF_LENGTH - 2, Math.min(HALF_LENGTH + 2, r.x + Math.cos(a) * rad));
      p.z = Math.max(-HALF_WIDTH - 2, Math.min(HALF_WIDTH + 2, r.z + Math.sin(a) * rad));
    }
    run(s, SETUP);
    expect(s.match.restart.ready).toBe(1);
    return s;
  }

  const cases: [string, RestartKind, number, number, number][] = [
    ['throw-in', RestartKind.THROW_IN, 1, 20, HALF_WIDTH],
    ['corner', RestartKind.CORNER, 0, HALF_LENGTH - 0.5, -HALF_WIDTH + 0.5],
    ['goal kick', RestartKind.GOAL_KICK, 1, HALF_LENGTH - GOAL_AREA_DEPTH, 4],
    ['free kick (centre)', RestartKind.FREE_KICK, 0, -5, 3],
    ['free kick 7 m from goal', RestartKind.FREE_KICK, 0, HALF_LENGTH - 7, 1],
    ['free kick in own area', RestartKind.FREE_KICK, 0, -(HALF_LENGTH - 10), -6],
    ['penalty', RestartKind.PENALTY, 1, -40, 0],
  ];
  for (const [name, kind, team, x, z] of cases) {
    it(`${name}: at restartSetupTicks every player is legal, spaced, the taker on the ball in SET_PIECE`, () => {
      const s = crowdAndReady(kind, team, x, z);
      const r = s.match.restart;
      expect(illegalPositions(s)).toEqual([]);
      for (let i = 0; i < NUM_SLOTS; i++) expect(isLegalRestartPosition(s, i), `slot ${i}`).toBe(true);
      const t = s.players[r.taker]!;
      expect(t.team).toBe(team);
      const reach = kind === RestartKind.THROW_IN ? LOCAL_TUNING.throwInLeash : LOCAL_TUNING.takerReach;
      const tx = kind === RestartKind.THROW_IN ? r.x : r.x, tz = kind === RestartKind.THROW_IN ? Math.sign(r.z) * (HALF_WIDTH + LOCAL_TUNING.throwInTakerOut) : r.z;
      expect(dist(t.x, t.z, tx, tz)).toBeLessThanOrEqual(reach + 1e-9);
      expect(t.act).toBe(kind === RestartKind.THROW_IN ? ActionKind.THROW_IN : ActionKind.SET_PIECE);
      for (let i = 0; i < NUM_SLOTS; i++) {
        for (let j = i + 1; j < NUM_SLOTS; j++) {
          const a = s.players[i]!, b = s.players[j]!;
          if (a.active !== 1 || b.active !== 1) continue;
          expect(dist(a.x, a.z, b.x, b.z), `players ${i} and ${j} overlap`).toBeGreaterThan(2 * T_PLAYER.bodyRadius - T_PLAYER.overlapTolerance);
        }
      }
      // and they stay legal while waiting
      run(s, 120);
      expect(illegalPositions(s)).toEqual([]);
    });
  }

  it('free kick near goal: the keeper on his line between the posts is not moved; defenders may stay on the line', () => {
    const s = base();
    award(s, RestartKind.FREE_KICK, 0, HALF_LENGTH - 7, 0);
    const k = s.teams[1]!.keeperSlot;
    s.players[k]!.x = HALF_LENGTH - 0.3; s.players[k]!.z = 0.5;
    s.players[13]!.x = HALF_LENGTH - 0.45; s.players[13]!.z = -2;
    s.players[14]!.x = HALF_LENGTH - 2; s.players[14]!.z = 2; // in front of the line: not on it
    run(s, SETUP);
    // (outfield bodies are kept a body radius in front of the goal line by SIM-04/05; RUL-11 itself does not move them)
    expect(dist(s.players[k]!.x, s.players[k]!.z, HALF_LENGTH - 0.3, 0.5)).toBeLessThan(0.3);
    expect(dist(s.players[13]!.x, s.players[13]!.z, HALF_LENGTH - 0.45, -2)).toBeLessThan(0.3);
    expect(Math.abs(s.players[13]!.x - HALF_LENGTH)).toBeLessThanOrEqual(0.6);
    expect(dist(s.players[14]!.x, s.players[14]!.z, s.match.restart.x, 0) >= RESTART_DISTANCE - 0.06 ||
      Math.abs(s.players[14]!.x - HALF_LENGTH) <= 0.6).toBe(true);
    expect(illegalPositions(s)).toEqual([]);
  });

  it('glitch "kick-off with players in the wrong half": everyone in his own half and opponents outside the circle at ready', () => {
    const s = base();
    s.match.phase = MatchPhase.REPLAY;
    award(s, RestartKind.KICK_OFF, 1, 0, 0);
    expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
    const r = s.match.restart;
    // players drift into the wrong half during the setup delay
    for (let i = 0; i < NUM_SLOTS; i++) {
      if (i === r.taker) continue;
      const p = s.players[i]!;
      const dir = s.teams[p.team]!.dir;
      p.x = dir * (2 + (i % 5) * 4);
      p.z = ((i % 7) - 3) * 3;
    }
    run(s, SETUP);
    expect(r.ready).toBe(1);
    expect(illegalPositions(s)).toEqual([]);
    for (let i = 0; i < NUM_SLOTS; i++) expect(s.teams[s.players[i]!.team]!.dir * s.players[i]!.x).toBeLessThanOrEqual(0);
    // a defender walking into the circle later is pushed back out, never left there
    const opp = teamFirstSlot(0) + 9;
    s.players[opp]!.x = -2; s.players[opp]!.z = 1;
    run(s, 60);
    expect(illegalPositions(s)).toEqual([]);
  });

  it('kick-off: a taker within reach of the ball but in the opponents\' half is put back in his own half', () => {
    const s = base();
    s.match.phase = MatchPhase.REPLAY;
    award(s, RestartKind.KICK_OFF, 0, 0, 0);
    const t = s.match.restart.taker;
    run(s, 10);
    s.players[t]!.x = 0.5; s.players[t]!.z = 0; // team 0 attacks +x: 0.5 m into the wrong half
    run(s, SETUP);
    expect(s.match.restart.taker).toBe(t);
    expect(s.players[t]!.x).toBeLessThanOrEqual(0);
    expect(dist(s.players[t]!.x, s.players[t]!.z, 0, 0)).toBeLessThanOrEqual(LOCAL_TUNING.takerReach);
  });

  it('glitch "opponents inside the required distance blocking forever": pushed out within 1 s, no teleport, even when walking in', () => {
    const s = base();
    award(s, RestartKind.FREE_KICK, 0, 10, 0);
    run(s, SETUP + 1);
    const r = s.match.restart;
    const o = 15;
    const p = s.players[o]!;
    p.x = r.x + 1.2; p.z = 0.3; p.vx = 0; p.vz = 0;
    let maxStep = 0;
    let prevX = p.x, prevZ = p.z;
    let outAt = -1;
    run(s, 70, {
      inputs: (st) => {
        // the player keeps trying to walk onto the ball (as a buggy job or a stray intent would)
        const q = st.players[o]!;
        const dx = r.x - q.x, dz = r.z - q.z, d = Math.hypot(dx, dz) || 1;
        q.moveMode = MoveMode.DIRECT; q.ix = dx / d; q.iz = dz / d; q.wantSprint = 1;
      },
      until: (st) => {
        const q = st.players[o]!;
        maxStep = Math.max(maxStep, dist(q.x, q.z, prevX, prevZ));
        prevX = q.x; prevZ = q.z;
        if (outAt < 0 && dist(q.x, q.z, r.x, r.z) >= RESTART_DISTANCE - 0.06) outAt = st.tick;
        return false;
      },
    });
    expect(outAt).toBeGreaterThan(0);
    expect(dist(p.x, p.z, r.x, r.z)).toBeGreaterThanOrEqual(RESTART_DISTANCE - 0.06); // still out at the end
    expect(maxStep).toBeLessThan(LOCAL_TUNING.pushMaxStep + 0.25); // a slide (push + own step), never a teleport
  });

  it('the push gets anyone out within 1 s from the worst spot (standing on the ball)', () => {
    for (const kind of [RestartKind.CORNER, RestartKind.THROW_IN, RestartKind.FREE_KICK]) {
      const s = base();
      const x = kind === RestartKind.CORNER ? HALF_LENGTH - 0.5 : 0;
      const z = kind === RestartKind.CORNER ? HALF_WIDTH - 0.5 : kind === RestartKind.THROW_IN ? -HALF_WIDTH : 0;
      award(s, kind, 0, x, z);
      run(s, SETUP + 1);
      const r = s.match.restart;
      const p = s.players[14]!;
      p.x = r.x + 0.05; p.z = r.z + (kind === RestartKind.THROW_IN ? 0.5 : -0.05);
      run(s, 60);
      expect(illegalPositions(s), RestartKind[kind]).toEqual([]);
    }
  });

  it('legalizePositions is a no-op without a restart and safe to call from a Setup', () => {
    const s = base();
    const before = hashState(s);
    legalizePositions(s);
    expect(hashState(s)).toBe(before);
    setHook('setup', RestartKind.PENALTY, (st) => legalizePositions(st as SimState));
    const s2 = base();
    award(s2, RestartKind.PENALTY, 0, 45, 0);
    expect(illegalPositions(s2)).toEqual([]);
  });
});

// ---------------------------------------------------------------- taker

describe('RUL-11 taker', () => {
  it('glitch "taker missing or sent off": a taker is always picked, re-picked from the same team when sent off', () => {
    const s = base();
    award(s, RestartKind.FREE_KICK, 1, -10, 0);
    const first = s.match.restart.taker;
    expect(s.players[first]!.team).toBe(1);
    // sent off during the setup delay
    run(s, 10);
    sendOff(s, first);
    // an opponent stands right on the ball: he must never become the taker
    s.players[5]!.x = -10.2; s.players[5]!.z = 0;
    run(s, 1);
    const second = s.match.restart.taker;
    expect(second).not.toBe(first);
    expect(s.players[second]!.team).toBe(1);
    expect(s.players[second]!.active).toBe(1);
    run(s, SETUP);
    expect(s.players[second]!.act).toBe(ActionKind.SET_PIECE);
    // sent off after ready: the next taker is put on the ball and waits
    sendOff(s, second);
    run(s, 1);
    const third = s.match.restart.taker;
    expect(s.players[third]!.team).toBe(1);
    expect(s.players[third]!.act).toBe(ActionKind.SET_PIECE);
    expect(dist(s.players[third]!.x, s.players[third]!.z, -10, 0)).toBeLessThanOrEqual(LOCAL_TUNING.takerReach);
    expect(s.players[second]!.act).toBe(ActionKind.NONE);
  });

  it('a substituted taker (slot cleared of its action and moved away) is put back on the ball', () => {
    const s = base({ humans: 1 });
    award(s, RestartKind.CORNER, 0, HALF_LENGTH - 0.5, HALF_WIDTH - 0.5);
    run(s, SETUP + 1);
    const t = s.match.restart.taker;
    const p = s.players[t]!;
    p.act = ActionKind.NONE; p.x = 0; p.z = -HALF_WIDTH; // RUL-10 swapped the player in at the halfway line
    run(s, 1);
    expect(s.match.restart.taker).toBe(t);
    expect(p.act).toBe(ActionKind.SET_PIECE);
    expect(dist(p.x, p.z, s.match.restart.x, s.match.restart.z)).toBeLessThanOrEqual(LOCAL_TUNING.takerReach);
  });

  it('picks the keeper for goal kicks, the best finisher for penalties, never the keeper for throw-ins', () => {
    const s = base();
    award(s, RestartKind.GOAL_KICK, 1, HALF_LENGTH - 5.5, 3);
    expect(s.match.restart.taker).toBe(s.teams[1]!.keeperSlot);
    const p = base();
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) { p.attrs[i]!.finishing = 40; p.attrs[i]!.composure = 40; }
    p.attrs[7]!.finishing = 90; p.attrs[7]!.composure = 85;
    award(p, RestartKind.PENALTY, 0, 45, 0);
    expect(p.match.restart.taker).toBe(7);
    const t = base();
    const k = t.teams[0]!.keeperSlot;
    t.players[k]!.x = -10; t.players[k]!.z = -HALF_WIDTH + 0.5; // the keeper happens to be nearest
    award(t, RestartKind.THROW_IN, 0, -10, -HALF_WIDTH);
    expect(t.match.restart.taker).not.toBe(k);
    expect(pickRestartTaker(t, -1)).not.toBe(k);
  });

  it('SET_PIECE: the waiting taker is locked facing the aim, never overruns, and is freed by prepareTakerKick', () => {
    const s = base({ humans: 1 });
    expect(ACTION_HANDLERS[ActionKind.SET_PIECE]).toBe(setPieceHandler);
    award(s, RestartKind.FREE_KICK, 0, 20, -10);
    const r = s.match.restart;
    r.aimX = 40; r.aimZ = 10;
    run(s, SETUP + 300);
    const p = s.players[r.taker]!;
    expect(p.act).toBe(ActionKind.SET_PIECE);
    expect(p.actT).toBeLessThanOrEqual(p.actDur);
    expect(p.moveMode).toBe(MoveMode.LOCKED);
    expect([p.lookAt, p.lookX, p.lookZ]).toEqual([1, 40, 10]);
    EV.begin(s.tick);
    expect(prepareTakerKick(s, r.taker)).toBe(1);
    expect(p.act).toBe(ActionKind.NONE);
    expect(prepareTakerKick(s, (r.taker + 1) % NUM_SLOTS)).toBe(0); // not the taker
    run(s, 1); // nothing started: back to waiting
    expect(p.act).toBe(ActionKind.SET_PIECE);
  });
});

// ---------------------------------------------------------------- ball safety

describe('RUL-11 ball safety', () => {
  it('glitch "ball out of play during a restart": a ball that strays, moves, flies, enters a net or is taken by an opponent is put back', () => {
    const s = base();
    award(s, RestartKind.FREE_KICK, 1, -20, 8);
    const b = s.ball;
    const r = s.match.restart;
    const back = () => [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner];
    const spot = [-20, BALL_RADIUS, 8, 0, 0, 0, -1];
    b.x = -20; b.z = HALF_WIDTH + 3; b.vz = 6; // rolled out over the touchline before the kick
    run(s, 1);
    expect(back()).toEqual(spot);
    b.vx = 3; // nudged
    run(s, 1);
    expect(back()).toEqual(spot);
    b.y = 1.5; b.vy = 2;
    run(s, 1);
    expect(back()).toEqual(spot);
    run(s, SETUP);
    expect(r.ready).toBe(1);
    b.owner = 3; // an opponent took it
    run(s, 1);
    expect(back()).toEqual(spot);
    b.x = HALF_LENGTH + 1; b.inNet = 1;
    run(s, 1);
    expect(back()).toEqual(spot);
    // an opponent kicking it does not take the restart (only the taker can)
    EV.begin(s.tick);
    const l = createKickLaunch();
    l.vx = 20; l.kind = KickKind.CLEARANCE;
    applyKick(s, 3, l, 1, EV);
    expect(r.taken).toBe(0);
    run(s, 1);
    expect(r.taken).toBe(0);
    expect(back()).toEqual(spot);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
  });

  it('the throw-in taker holding the ball (RUL-02) is left alone', () => {
    const s = base();
    award(s, RestartKind.THROW_IN, 0, 5, HALF_WIDTH);
    run(s, SETUP + 1);
    const t = s.match.restart.taker;
    const b = s.ball;
    b.owner = t; b.x = s.players[t]!.x; b.z = s.players[t]!.z; b.y = 2.0;
    run(s, 1, { inputs: (st) => { st.ball.owner = t; st.ball.y = 2.0; st.ball.vy = 0; } });
    expect(b.owner).toBe(t);
  });
});

// ---------------------------------------------------------------- timeouts and forced kicks

describe('RUL-11 timeouts', () => {
  it('a human taker who does not act gets the kind Default after 12 s (once); a Default that kicks needs no watchdog', () => {
    const s = base({ humans: 1 });
    setHook('dflt', RestartKind.CORNER, (st, ev) => takeRestart(st, ev));
    award(s, RestartKind.CORNER, 0, HALF_LENGTH - 0.5, -HALF_WIDTH + 0.5);
    const evs = run(s, SETUP + T_RULES.restartTimeoutTicks - 1);
    expect(H.log.filter((l) => l.startsWith('default'))).toEqual([]);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    const evs2 = run(s, 1);
    expect(H.log.filter((l) => l.startsWith('default'))).toEqual(['default:4']);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ofType([...evs, ...evs2], EventType.WATCHDOG)).toEqual([]);
  });

  it('a CPU taker that has not acted after 4 s gets the Default (logged); a Default that does nothing is followed by a forced kick', () => {
    const s = base();
    award(s, RestartKind.THROW_IN, 1, -30, -HALF_WIDTH);
    const evs = run(s, SETUP + LOCAL_TUNING.cpuTakeTimeoutTicks);
    expect(H.log).toContain('default:2');
    const w = ofType(evs, EventType.WATCHDOG);
    expect(w.map((e) => [e.a, e.b])).toEqual([[WatchdogReason.RESTART_BLOCKED, RestartKind.THROW_IN]]);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
    const evs2 = run(s, LOCAL_TUNING.defaultGraceTicks);
    expect(ofType(evs2, EventType.WATCHDOG).map((e) => e.a)).toEqual([WatchdogReason.RESTART_BLOCKED]);
    const kick = ofType(evs2, EventType.KICK);
    expect(kick).toHaveLength(1);
    expect(kick[0]!.b).toBe(KickKind.THROW_IN);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ball.vz).toBeGreaterThan(0); // thrown into the pitch
    expect(s.ball.lastTouchTeam).toBe(1);
  });

  it('no watchdog in normal flows: every kind taken by its taker returns to IN_PLAY cleanly', () => {
    const kinds: [RestartKind, number, number][] = [
      [RestartKind.THROW_IN, 3, -HALF_WIDTH], [RestartKind.GOAL_KICK, -47, 3], [RestartKind.CORNER, 52, 33],
      [RestartKind.FREE_KICK, 0, 0], [RestartKind.PENALTY, 41.5, 0],
    ];
    for (const [kind, x, z] of kinds) {
      const s = base({ humans: 1 });
      award(s, kind, 0, x, z);
      const evs = run(s, SETUP + 40, {
        inputs: (st) => {
          const r = st.match.restart;
          if (st.match.phase !== MatchPhase.IN_PLAY && r.ready === 1 && r.taken === 0 && r.t >= SETUP + 30) takeRestart(st, NULL_EV);
        },
      });
      expect(ofType(evs, EventType.PHASE_CHANGE).map((e) => e.b), RestartKind[kind]).toEqual([MatchPhase.IN_PLAY]);
      expect(s.match.phase, RestartKind[kind]).toBe(MatchPhase.IN_PLAY);
      expect(ofType(evs, EventType.WATCHDOG), RestartKind[kind]).toEqual([]);
      expect(s.match.watchdogCount).toBe(0);
    }
  });

  it('forceRestartKick takes each kind with a sensible kick', () => {
    const want: [RestartKind, number, number, KickKind][] = [
      [RestartKind.GOAL_KICK, -47, 3, KickKind.GOAL_KICK], [RestartKind.CORNER, 52, 33, KickKind.GROUND_PASS],
      [RestartKind.FREE_KICK, 5, 5, KickKind.GROUND_PASS], [RestartKind.PENALTY, 41.5, 0, KickKind.PENALTY],
      [RestartKind.THROW_IN, 0, HALF_WIDTH, KickKind.THROW_IN],
    ];
    for (const [kind, x, z, kk] of want) {
      const s = base();
      award(s, kind, 0, x, z);
      run(s, SETUP + 1);
      EV.begin(s.tick);
      expect(forceRestartKick(s, EV)).toBe(1);
      const ev = EV.toArray();
      expect(ofType(ev, EventType.KICK).map((e) => [e.a, e.b])).toEqual([[s.match.restart.taker, kk]]);
      expect(s.match.restart.taken).toBe(1);
      expect(forceRestartKick(s, EV)).toBe(0); // only once
      if (kind === RestartKind.PENALTY) {
        expect(s.ball.vx).toBeGreaterThan(10);
        expect(s.ball.shotBy).toBe(s.match.restart.taker);
        expect(ofType(ev, EventType.SHOT)).toHaveLength(1);
      } else {
        expect(s.ball.passTarget).toBeGreaterThanOrEqual(0);
        expect(s.players[s.ball.passTarget]!.team).toBe(0);
      }
      run(s, 1);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    }
  });

  it('restart.t counts ticks since the award, also when the award happens inside the rules tick', () => {
    const s = base();
    award(s, RestartKind.CORNER, 1, -52, -33.5);
    expect(s.match.phaseT).toBe(0);
    EV.begin(s.tick);
    restartTick(s, EV); // RUL-01 runs restartTick right after the award in the same tick
    expect(s.match.restart.t).toBe(0);
    run(s, 25);
    expect(s.match.restart.t).toBe(25);
    expect(s.match.restart.t).toBe(s.match.phaseT);
  });

  it('restartTick adopts a restart phase entered without its record', () => {
    const s = base();
    s.match.phase = MatchPhase.THROW_IN;
    s.ball.x = 12; s.ball.z = 30; s.ball.lastTouchTeam = 1;
    EV.begin(s.tick);
    restartTick(s, EV);
    const r = s.match.restart;
    expect([r.kind, r.team, r.x, r.z]).toEqual([RestartKind.THROW_IN, 0, 12, HALF_WIDTH]);
    expect(s.players[r.taker]!.team).toBe(0);
  });

  it('SETPIECE_INPUT routes every restart kind to a function', () => {
    expect(SETPIECE_INPUT[RestartKind.NONE]).toBeNull();
    for (let k = RestartKind.KICK_OFF; k <= RestartKind.PENALTY; k++) expect(typeof SETPIECE_INPUT[k]).toBe('function');
  });

  it('is deterministic: identical runs give identical hashes', () => {
    const hashes: number[] = [];
    for (let n = 0; n < 2; n++) {
      const s = base({ seed: 99 });
      award(s, RestartKind.PENALTY, 1, -45, 0);
      run(s, SETUP + LOCAL_TUNING.cpuTakeTimeoutTicks + LOCAL_TUNING.defaultGraceTicks + 30);
      hashes.push(hashState(s));
    }
    expect(hashes[0]).toBe(hashes[1]);
  });
});
