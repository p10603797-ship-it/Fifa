/**
 * RUL-03: goal kicks. Setup (spot on the goal-area line on the side the ball went out, keeper taker or a defender,
 * legal positions), correct team, input (stick aim, PASS short, LOB long, modifiers, gestures, power), the Default
 * (short to an open defender, else long to the target man; TAI-09 laneSafety when it gives a signal), the human
 * timeout and the CPU fallback, opponents kept out of the penalty area until the ball is played, no offside from
 * goal kicks, and the glitch-list lines that touch goal kicks (taker missing or sent off, ball out of play during a
 * restart, restart given to the wrong team, offside from a goal kick).
 *
 * The real pipeline runs (step.ts, RUL-01 machine, RUL-11 restart flow, SIM-15/16 resolver and switching, locomotion,
 * bodies, ball physics). Mocked:
 *  - SIM-08 startPass / SIM-09 startLob: record every request; when `K.accept` is set they kick the ball at once through
 *    core/kick.ts applyKick (no action, like a contact on the same tick), else they refuse (like the Wave 0 stubs);
 *  - TAI-09 laneSafety: 0 (the stub) unless a test installs `K.lane`;
 *  - RUL-08 offsideTick: wrapped to record the phase on every tick a kick was struck;
 *  - team AI, CPU brains and contacts: no-ops (only the rules decide; tests drive intruders and CPU frames).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALL_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS, PENALTY_AREA_DEPTH,
  PENALTY_AREA_HALF_WIDTH, RESTART_DISTANCE,
} from '../../src/contracts/constants';
import {
  ActionKind, AssistLevel, AutoSwitch, CrossKind, GestureKind, KickKind, MatchPhase, RestartKind,
} from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { MoveMode, RosterStatus, type SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { applyKick } from '../../src/sim/core/kick';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { step } from '../../src/sim/step';
import { rulesTick } from '../../src/sim/rules/machine';
import { LOCAL_TUNING as RESTART_TUNING, SETPIECE_INPUT, awardRestart, isLegalRestartPosition } from '../../src/sim/rules/restart';
import {
  LOCAL_TUNING, bestLongOption, bestShortOption, chooseGoalKick, clearOfOwnGoal, createGoalKickChoice, goalKickDefault,
  goalKickInput, goalKickSetup, goalKickSpot, goalKickTick, longPower, pickGoalKickTaker, shortPower,
} from '../../src/sim/rules/goalkick';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

interface Call {
  fn: 'pass' | 'lob';
  slot: number;
  kind: number;
  target: number;
  flags: number;
  power: number;
  charging: number;
  dirX: number;
  dirZ: number;
  hasTarget: number;
  targetX: number;
  targetZ: number;
  assist: number;
  tick: number;
  phase: number;
  rt: number;
  takerAct: number;
}

type LaneFn = (team: number, x0: number, z0: number, x1: number, z1: number, speed: number, lofted: number) => number;

const K = vi.hoisted(() => ({
  accept: false,
  calls: [] as unknown[],
  lane: null as unknown,
  kickPhases: [] as number[],
}));

function record(fn: 'pass' | 'lob', s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink): number {
  (K.calls as Call[]).push({
    fn, slot, kind, target: req.targetSlot, flags: req.flags, power: req.power, charging: req.charging, dirX: req.dirX,
    dirZ: req.dirZ, hasTarget: req.hasTarget, targetX: req.targetX, targetZ: req.targetZ, assist: req.assist, tick: s.tick,
    phase: s.match.phase, rt: s.match.restart.t, takerAct: s.players[slot]!.act,
  });
  if (!K.accept) return 0;
  const l = createKickLaunch();
  const sp = fn === 'lob' ? 18 : 14;
  l.vx = req.dirX * sp;
  l.vz = req.dirZ * sp;
  l.vy = fn === 'lob' ? 8 : 0;
  l.kind = kind;
  l.target = req.targetSlot;
  l.tx = s.ball.x + req.dirX * 20;
  l.tz = s.ball.z + req.dirZ * 20;
  applyKick(s, slot, l, req.power, ev);
  return 1;
}

vi.mock('../../src/sim/kicks/pass', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/pass')>()),
  startPass: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => record('pass', s, slot, kind, req, ev),
}));
vi.mock('../../src/sim/kicks/lob', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/lob')>()),
  startLob: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => record('lob', s, slot, kind, req, ev),
}));
vi.mock('../../src/ai/cpu/passing', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/passing')>()),
  laneSafety: (_s: SimState, team: number, x0: number, z0: number, x1: number, z1: number, speed: number, lofted: number) =>
    (K.lane ? (K.lane as LaneFn)(team, x0, z0, x1, z1, speed, lofted) : 0),
}));
vi.mock('../../src/sim/rules/offside', async (orig) => {
  const mod = await orig<typeof import('../../src/sim/rules/offside')>();
  return {
    ...mod,
    offsideTick: (s: SimState, ev: EventSink) => {
      if (s.ball.lastKickTick === s.tick) K.kickPhases.push(s.match.phase);
      mod.offsideTick(s, ev);
    },
  };
});
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
  K.accept = false;
  K.calls.length = 0;
  K.lane = null;
  K.kickPhases.length = 0;
});

const calls = (): Call[] => K.calls as Call[];

// ---------------------------------------------------------------- harness

const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser'); // team AI is mocked out
const EV = createEventBuffer();
const SETUP = T_RULES.restartSetupTicks;
const SPOT_X = HALF_LENGTH - GOAL_AREA_DEPTH; // 47
/** RUL-01 awards goal kicks at half the goal-area half width toward the side the ball went out. */
const AWARD_Z = GOAL_AREA_HALF_WIDTH * 0.5;

type Inputs = (s: SimState, frames: InputFrame[]) => void;

/** Step the real pipeline n ticks (invariants but 'chaser' checked); stops early when `until` holds. */
function run(s: SimState, n: number, inputs?: Inputs, until?: (s: SimState) => boolean): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker(CHECKS);
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    inputs?.(s, frames);
    step(s, frames, events);
    for (let k = 0; k < events.count; k++) all.push({ ...events.get(k) });
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until?.(s)) break;
  }
  return all;
}

function ofType(ev: readonly SimEvent[], type: EventType): SimEvent[] {
  return ev.filter((e) => e.type === type);
}

interface GkOpts {
  humans?: number | ScenarioHuman[];
  seed?: number;
  /** Second half: home attacks -x. */
  swap?: boolean;
  side?: number;
  awardZ?: number;
}

/** Own goal end (+-1) of a team. */
function ownEnd(s: SimState, team: number): number {
  return -s.teams[team]!.dir;
}

/** A match in play with a goal kick awarded to `team` (not ready yet). */
function gkState(team: number, opts: GkOpts = {}, prep?: (s: SimState) => void): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: opts.humans ?? 0, seed: opts.seed ?? 7 });
  if (opts.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; mirrorPositions(s); }
  prep?.(s);
  const e = ownEnd(s, team);
  EV.begin(s.tick);
  awardRestart(s, RestartKind.GOAL_KICK, team, e * SPOT_X, opts.awardZ ?? (opts.side ?? 1) * AWARD_Z, EV);
  expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
  return s;
}

/** Mirror every player's x (after swapping the directions). */
function mirrorPositions(s: SimState): void {
  for (const p of s.players) { p.x = -p.x; p.homeX = -p.homeX; p.fx = -p.fx; }
}

function toReady(s: SimState, inputs?: Inputs): SimEvent[] {
  const ev = run(s, SETUP + 5, inputs, (st) => st.match.restart.ready === 1);
  expect(s.match.restart.ready).toBe(1);
  return ev;
}

function place(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
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

function inPA(x: number, z: number, end: number): boolean {
  return end * x >= HALF_LENGTH - PENALTY_AREA_DEPTH && end * x <= HALF_LENGTH && Math.abs(z) <= PENALTY_AREA_HALF_WIDTH;
}

/** Independent check of the goal-kick positions: opponents outside the kicking team's area and >= 9.15 m. */
function illegalOpponents(s: SimState, slack = 0.06): string[] {
  const r = s.match.restart;
  const end = ownEnd(s, r.team);
  const out: string[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.team === r.team) continue;
    const d = Math.hypot(p.x - r.x, p.z - r.z);
    if (d < RESTART_DISTANCE - slack) out.push(`${i} within 9.15 m (${d.toFixed(2)})`);
    // inside the area by more than the slack
    const depth = Math.min(end * p.x - (HALF_LENGTH - PENALTY_AREA_DEPTH), PENALTY_AREA_HALF_WIDTH - Math.abs(p.z));
    if (inPA(p.x, p.z, end) && depth > slack) out.push(`${i} in the area by ${depth.toFixed(2)} m`);
  }
  return out;
}

const press = (bits: number) => (s: SimState, f: InputFrame[]) => { void s; f[0]!.buttons = bits; };

/**
 * Shared layout for the team-0 Default tests (home attacks +x; own goal line at x = -52.5; spot (-47, +4.58)):
 * opponents far up the pitch, team 0 midfielders out of short range.
 */
function layoutFar(s: SimState): void {
  for (let i = 11; i < 22; i++) if (i !== 11) place(s, i, 10 + (i - 11) * 2, -25 + (i - 11) * 5);
  place(s, 11, 45, 0); // their keeper at the other end
  for (let i = 5; i <= 8; i++) place(s, i, 0, -24 + (i - 5) * 16);
  place(s, 9, -2, 10);
  place(s, 10, -2, -10);
}

// ---------------------------------------------------------------- setup

describe('RUL-03 setup', () => {
  const table: { team: number; swap: boolean; side: number }[] = [];
  for (const team of [0, 1]) for (const swap of [false, true]) for (const side of [1, -1]) table.push({ team, swap, side });

  it.each(table)('team $team, second half $swap, side $side: ball on the goal-area line of its own end, at rest', ({ team, swap, side }) => {
    const s = gkState(team, { swap, side });
    const r = s.match.restart;
    const b = s.ball;
    const e = ownEnd(s, team);
    expect(r.kind).toBe(RestartKind.GOAL_KICK);
    expect(r.team).toBe(team);
    expect(r.x).toBeCloseTo(e * SPOT_X, 9);
    expect(Math.sign(r.z)).toBe(side);
    expect(Math.abs(r.z)).toBeGreaterThanOrEqual(LOCAL_TUNING.spotZMin);
    expect(Math.abs(r.z)).toBeLessThanOrEqual(LOCAL_TUNING.spotZMax);
    expect(r.side).toBe(side);
    expect([b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner, b.heldBy]).toEqual([r.x, BALL_RADIUS, r.z, 0, 0, 0, -1, -1]);
    expect([r.aimX, r.aimZ]).toEqual([r.x, r.z]);
    expect(r.taker).toBe(s.teams[team]!.keeperSlot);
  });

  it('clamps |z| into spotZMin..spotZMax and keeps the side', () => {
    expect(Math.abs(gkState(0, { awardZ: 0.5 }).match.restart.z)).toBe(LOCAL_TUNING.spotZMin);
    expect(gkState(0, { awardZ: -0.5 }).match.restart.z).toBe(-LOCAL_TUNING.spotZMin);
    expect(gkState(1, { awardZ: 30 }).match.restart.z).toBe(LOCAL_TUNING.spotZMax);
    expect(gkState(1, { awardZ: -7 }).match.restart.z).toBe(-7);
  });

  it('takes the side from ball.crossZ when the award z is 0', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    s.ball.crossZ = -12;
    EV.begin(s.tick);
    awardRestart(s, RestartKind.GOAL_KICK, 0, -SPOT_X, 0, EV);
    expect(s.match.restart.z).toBe(-LOCAL_TUNING.spotZMin);
    expect(s.match.restart.side).toBe(-1);
  });

  it('goalKickSpot / goalKickSetup are pure placement: spot from team end, side and |z| hint', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const out = { x: 0, z: 0 };
    goalKickSpot(s, 1, -1, 6, out);
    expect(out).toEqual({ x: SPOT_X, z: -6 });
    goalKickSpot(s, 0, 1, Number.NaN, out);
    expect(out).toEqual({ x: -SPOT_X, z: LOCAL_TUNING.spotZMin });
    // Setup ignores a restart of another kind.
    s.match.restart.kind = RestartKind.CORNER;
    const before = JSON.stringify(s.match.restart);
    goalKickSetup(s, EV);
    expect(JSON.stringify(s.match.restart)).toBe(before);
  });

  it('after the setup delay everyone is legal: opponents outside the area and 9.15 m away, taker on the ball', () => {
    for (const team of [0, 1]) {
      const s = gkState(team, {}, (st) => {
        const e = -st.teams[team]!.dir;
        const opp = team === 0 ? 12 : 1;
        // three opponents in the kicking team's box, one on the ball spot
        place(st, opp, e * 47, 4.58);
        place(st, opp + 1, e * 40, -10);
        place(st, opp + 2, e * 50, 15);
      });
      const ev = toReady(s);
      expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
      expect(illegalOpponents(s)).toEqual([]);
      for (let i = 0; i < NUM_SLOTS; i++) expect(isLegalRestartPosition(s, i), `team ${team} slot ${i}`).toBe(true);
      const r = s.match.restart;
      const tk = s.players[r.taker]!;
      expect(r.taker).toBe(s.teams[team]!.keeperSlot);
      expect(Math.hypot(tk.x - r.x, tk.z - r.z)).toBeLessThanOrEqual(RESTART_TUNING.takerReach);
      expect(tk.act).toBe(ActionKind.SET_PIECE);
      expect([s.ball.x, s.ball.z]).toEqual([r.x, r.z]);
    }
  });
});

// ---------------------------------------------------------------- correct team (RUL-01 -> RUL-11 -> RUL-03)

describe('RUL-03 correct team (glitch: restart given to the wrong team)', () => {
  /** Ball wholly over the goal line at `end` outside the posts, last touched by `team`; one rules tick. */
  function outOver(s: SimState, end: number, z: number, lastTeam: number): void {
    const b = s.ball;
    b.x = end * (HALF_LENGTH + 0.5); b.y = BALL_RADIUS; b.z = z; b.vx = end * 5; b.vz = 0;
    b.lastTouch = lastTeam === 0 ? 5 : 16;
    b.lastTouchTeam = lastTeam;
    s.tick++;
    EV.begin(s.tick);
    s.match.phaseT++;
    b.cross = CrossKind.GOAL_LINE;
    b.crossX = end * HALF_LENGTH;
    b.crossZ = z;
    b.crossEnd = end;
    rulesTick(s, EV);
  }

  const cases = [
    { swap: false, end: -1, z: 20, last: 1, team: 0 },
    { swap: false, end: 1, z: -15, last: 0, team: 1 },
    { swap: true, end: 1, z: -25, last: 1, team: 0 },
    { swap: true, end: -1, z: 9, last: 0, team: 1 },
  ];
  it.each(cases)('second half $swap: out over end $end last touched by $last -> goal kick for team $team', (c) => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    if (c.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; mirrorPositions(s); }
    outOver(s, c.end, c.z, c.last);
    const r = s.match.restart;
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    expect(r.kind).toBe(RestartKind.GOAL_KICK);
    expect(r.team).toBe(c.team);
    expect(ownEnd(s, c.team)).toBe(c.end); // their own end
    expect(r.x).toBeCloseTo(c.end * SPOT_X, 9);
    expect(Math.sign(r.z)).toBe(Math.sign(c.z));
    expect(r.taker).toBe(s.teams[c.team]!.keeperSlot);
  });

  it('out over the goal line last touched by the defending team is a corner, not a goal kick', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    outOver(s, -1, 20, 0); // team 0 defends end -1
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(s.match.restart.team).toBe(1);
  });
});

// ---------------------------------------------------------------- taker

describe('RUL-03 taker (glitch: taker missing or sent off)', () => {
  it('keeper sent off with nobody in goal yet -> the nearest defender takes it (not a nearer midfielder)', () => {
    const s = gkState(0, {}, (st) => {
      sendOff(st, 0);
      place(st, 2, -40, 8); // CB nearest to the spot among the defenders
      place(st, 6, -44, 6); // a midfielder even nearer: not a defender
    });
    expect(s.match.restart.taker).toBe(2);
  });

  it('keeper sent off and replaced in goal (RUL-10 puts an outfield player in) -> the new keeper takes it', () => {
    const s = gkState(0, {}, (st) => {
      sendOff(st, 0);
      st.players[6]!.isKeeper = 1;
      st.teams[0]!.keeperSlot = 6;
    });
    expect(s.match.restart.taker).toBe(6);
    toReady(s);
    expect(s.match.restart.taker).toBe(6);
    expect(s.players[6]!.act).toBe(ActionKind.SET_PIECE);
  });

  it('keeper down -> a defender; no defenders -> the nearest outfield player; only the keeper left -> him', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    place(s, 3, -41, -5);
    place(s, 1, -30, 10);
    s.players[0]!.act = ActionKind.FALLEN;
    s.players[0]!.stunT = 40;
    expect(pickGoalKickTaker(s, 0, -47, 4.58)).toBe(3);
    s.players[0]!.act = ActionKind.NONE;
    s.players[0]!.stunT = 0;
    expect(pickGoalKickTaker(s, 0, -47, 4.58)).toBe(0);
    s.players[0]!.active = 0;
    for (const d of [1, 2, 3, 4]) s.players[d]!.active = 0;
    place(s, 7, -35, 2);
    expect(pickGoalKickTaker(s, 0, -47, 4.58)).toBe(7);
    // a defender who is down is skipped while someone else can take it
    s.players[2]!.active = 1;
    place(s, 2, -46, 4);
    s.players[2]!.stunT = 10;
    expect(pickGoalKickTaker(s, 0, -47, 4.58)).toBe(7);
    for (let i = 1; i < 11; i++) s.players[i]!.active = 0;
    s.players[0]!.active = 1;
    expect(pickGoalKickTaker(s, 0, -47, 4.58)).toBe(0);
    s.players[0]!.active = 0;
    expect(pickGoalKickTaker(s, 0, -47, 4.58)).toBe(-1);
  });

  it('taker sent off while waiting: a new taker is picked and the human can still take it', () => {
    K.accept = true;
    const s = gkState(0, { humans: 1 }, layoutFar);
    toReady(s);
    sendOff(s, 0);
    s.players[1]!.isKeeper = 1; // RUL-10: an outfield player goes in goal
    s.teams[0]!.keeperSlot = 1;
    run(s, 3);
    const t = s.match.restart.taker;
    expect(t).toBe(1);
    expect(s.ctrl[0]!.slot).toBe(t);
    run(s, 2, press(Btn.PASS));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.slot).toBe(t);
    run(s, 1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

// ---------------------------------------------------------------- input

describe('RUL-03 input', () => {
  /** Human P1 for team 0, ready; layout with an open CB (slot 2) and strikers up front. */
  function humanReady(prep?: (s: SimState) => void, human: Partial<ScenarioHuman> = {}): SimState {
    const s = gkState(0, { humans: [{ side: 0, ...human }] }, (st) => {
      layoutFar(st);
      place(st, 1, -30, 26); place(st, 2, -42, 18); place(st, 3, -42, -12); place(st, 4, -30, -26);
      prep?.(st);
    });
    toReady(s);
    expect(s.ctrl[0]!.slot).toBe(s.match.restart.taker);
    return s;
  }

  it('PASS -> short ground pass (startPass GROUND_PASS, SET_PIECE, charging) to the best short option; then IN_PLAY', () => {
    K.accept = true;
    const s = humanReady();
    const ev = run(s, 1, press(Btn.PASS));
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.fn).toBe('pass');
    expect(c.kind).toBe(KickKind.GROUND_PASS);
    expect(c.slot).toBe(0);
    expect(c.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
    expect(c.flags & ReqFlag.CPU).toBe(0);
    expect(c.charging).toBe(1);
    expect(c.target).toBe(2);
    expect(c.phase).toBe(MatchPhase.GOAL_KICK);
    expect(c.takerAct).toBe(ActionKind.NONE); // RUL-11 prepareTakerKick freed him first
    const q = s.players[2]!;
    const d = Math.hypot(q.x - s.match.restart.x, q.z - s.match.restart.z);
    expect(c.dirX).toBeCloseTo((q.x - s.match.restart.x) / d, 9);
    expect(s.match.restart.taken).toBe(1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
  });

  it('LOB -> long LOB_PASS to the target man (forwards first, best in the air)', () => {
    const s = humanReady((st) => { st.attrs[10]!.heading = 85; st.attrs[10]!.height = 192; });
    run(s, 1, press(Btn.LOB));
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.target, c.charging]).toEqual(['lob', KickKind.LOB_PASS, 10, 1]);
    expect(c.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
  });

  it.each([
    { bits: Btn.LOB | Btn.MOD_L, fn: 'lob', kind: KickKind.HIGH_LOB },
    { bits: Btn.LOB | Btn.MOD_L | Btn.MOD_R, fn: 'lob', kind: KickKind.DRIVEN_LOB },
    { bits: Btn.PASS | Btn.MOD_R, fn: 'pass', kind: KickKind.DRIVEN_PASS },
  ])('modifiers: buttons $bits -> $fn kind $kind', ({ bits, fn, kind }) => {
    const s = humanReady();
    run(s, 1, press(bits & ~(Btn.PASS | Btn.LOB))); // modifiers held first
    run(s, 1, press(bits));
    expect(calls()).toHaveLength(1);
    expect([calls()[0]!.fn, calls()[0]!.kind]).toEqual([fn, kind]);
  });

  it('explicit frame power -> that power, not charging', () => {
    const s = humanReady();
    run(s, 1, (_s, f) => { f[0]!.buttons = Btn.PASS; f[0]!.power = 100; });
    expect(calls()[0]!.charging).toBe(0);
    expect(calls()[0]!.power).toBeCloseTo(100 / 127, 9);
  });

  it('stick aims: restart.aim follows it, the kick goes along it with no forced receiver, the taker lines up behind the ball', () => {
    const s = humanReady();
    const r = s.match.restart;
    run(s, 40, (_s, f) => { f[0]!.mx = 64; f[0]!.mz = 110; });
    const ux = 64 / Math.hypot(64, 110), uz = 110 / Math.hypot(64, 110);
    expect(r.aimX).toBeCloseTo(r.x + ux * LOCAL_TUNING.aimDist, 6);
    expect(r.aimZ).toBeCloseTo(r.z + uz * LOCAL_TUNING.aimDist, 6);
    const tk = s.players[r.taker]!;
    expect(tk.act).toBe(ActionKind.SET_PIECE);
    expect(tk.x).toBeCloseTo(r.x - ux * RESTART_TUNING.takerBehind, 3);
    expect(tk.z).toBeCloseTo(r.z - uz * RESTART_TUNING.takerBehind, 3);
    run(s, 1, press(Btn.PASS)); // stick released: the aim stays
    const c = calls()[0]!;
    expect(c.target).toBe(-1);
    expect(c.dirX).toBeCloseTo(ux, 6);
    expect(c.dirZ).toBeCloseTo(uz, 6);
  });

  it('the taker never cuts through the ball while lining up (stays on the circle around it)', () => {
    const s = humanReady();
    const r = s.match.restart;
    let minD = 1e9;
    run(s, 60, (st, f) => {
      f[0]!.mx = 0; f[0]!.mz = -127; // aim sideways across the box
      const tk = st.players[st.match.restart.taker]!;
      minD = Math.min(minD, Math.hypot(tk.x - r.x, tk.z - r.z));
    });
    expect(minD).toBeGreaterThanOrEqual(RESTART_TUNING.takerBehind - 1e-9);
    expect(s.players[r.taker]!.z).toBeCloseTo(r.z + RESTART_TUNING.takerBehind, 3);
  });

  it('the aim never points back toward the own goal line (sideways is allowed)', () => {
    const s = humanReady();
    const r = s.match.restart;
    run(s, 1, (_s, f) => { f[0]!.mx = -127; f[0]!.mz = 0; });
    expect([r.aimX, r.aimZ]).toEqual([r.x + LOCAL_TUNING.aimDist, r.z]); // straight back -> forward
    run(s, 1, (_s, f) => { f[0]!.mx = -90; f[0]!.mz = 90; });
    expect(r.aimX).toBeCloseTo(r.x, 9);
    expect(r.aimZ).toBeCloseTo(r.z + LOCAL_TUNING.aimDist, 9);
    run(s, 1, press(Btn.LOB));
    expect(calls()[0]!.dirX).toBeCloseTo(0, 9);
  });

  it('Manual assistance: direction only (no receiver chosen for him)', () => {
    const s = humanReady(undefined, { assist: AssistLevel.MANUAL });
    run(s, 1, press(Btn.PASS));
    const c = calls()[0]!;
    expect([c.target, c.assist, c.dirX, c.dirZ]).toEqual([-1, AssistLevel.MANUAL, 1, 0]);
  });

  it('gesture TAP on a teammate -> ground pass to his feet; far teammate -> lob; DOUBLE_TAP -> lob', () => {
    const s = humanReady();
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 2; });
    let c = calls()[0]!;
    expect([c.fn, c.kind, c.target, c.charging, c.hasTarget]).toEqual(['pass', KickKind.GROUND_PASS, 2, 0, 0]);
    expect(c.flags & (ReqFlag.SET_PIECE | ReqFlag.GESTURE)).toBe(ReqFlag.SET_PIECE | ReqFlag.GESTURE);
    const q = s.players[2]!;
    expect(c.power).toBeCloseTo(shortPower(Math.hypot(q.x - s.match.restart.x, q.z - s.match.restart.z)), 9);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 9; });
    c = calls()[1]!;
    expect([c.fn, c.kind, c.target]).toEqual(['lob', KickKind.LOB_PASS, 9]);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.DOUBLE_TAP; f[0]!.gSlot = 2; });
    c = calls()[2]!;
    expect([c.fn, c.kind, c.target]).toEqual(['lob', KickKind.LOB_PASS, 2]);
  });

  it('gesture TAP on a pitch spot -> kick to that spot (hasTarget); opponents, the taker, the ball and the own goal mouth are ignored', () => {
    const s = humanReady();
    const r = s.match.restart;
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = -1; f[0]!.gx = -300; f[0]!.gz = 100; });
    let c = calls()[0]!;
    expect([c.fn, c.kind, c.target, c.hasTarget, c.targetX, c.targetZ]).toEqual(['pass', KickKind.GROUND_PASS, -1, 1, -30, 10]);
    expect([r.aimX, r.aimZ]).toEqual([-30, 10]);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = -1; f[0]!.gx = 150; f[0]!.gz = -200; });
    c = calls()[1]!;
    expect([c.fn, c.kind, c.targetX, c.targetZ]).toEqual(['lob', KickKind.LOB_PASS, 15, -20]);
    const n = calls().length;
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 15; }); // opponent
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 0; }); // the taker
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = -1; f[0]!.gx = -470; f[0]!.gz = 50; }); // on the ball
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.DOUBLE_TAP; f[0]!.gSlot = -1; f[0]!.gx = -525; f[0]!.gz = 0; }); // own goal
    expect(calls()).toHaveLength(n);
  });

  it('ignored before ready and from the defending side; accepted from the taker\'s controller once; nothing after the kick', () => {
    K.accept = true;
    const s = gkState(0, { humans: 2 }, layoutFar);
    run(s, 3, press(Btn.PASS)); // during the setup delay
    expect(calls()).toHaveLength(0);
    toReady(s);
    run(s, 1, (_s, f) => { f[1]!.buttons = Btn.PASS; f[1]!.gesture = GestureKind.TAP; f[1]!.gSlot = 12; }); // defending human
    run(s, 1);
    run(s, 1, (_s, f) => { f[1]!.buttons = Btn.LOB; });
    expect(calls()).toHaveLength(0);
    // the controller holding the taker (called directly, as the resolver does)
    const r = s.match.restart;
    const c0 = s.ctrl[0]!;
    goalKickInput(s, 0, Object.assign(createInputFrame(), { gesture: GestureKind.TAP, gSlot: 2 }), EV);
    expect(calls()).toHaveLength(1); // P1 holds the taker: accepted
    expect(r.taken).toBe(1);
    expect(c0.slot).toBe(r.taker);
    run(s, 1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    goalKickInput(s, 0, Object.assign(createInputFrame(), { gesture: GestureKind.TAP, gSlot: 2 }), EV);
    goalKickDefault(s, EV);
    goalKickTick(s, EV);
    expect(calls()).toHaveLength(1);
    // bad controller indices / kinds are ignored without throwing
    expect(() => goalKickInput(s, -1, createInputFrame(), EV)).not.toThrow();
    expect(() => goalKickInput(s, 99, createInputFrame(), EV)).not.toThrow();
  });

  it('a second human on the kicking side does not take it; he moves his own player instead', () => {
    const s = gkState(0, { humans: [{ side: 0 }, { side: 0, autoSwitch: AutoSwitch.OFF }] }, layoutFar);
    toReady(s);
    const r = s.match.restart;
    const holder = s.ctrl[0]!.slot === r.taker ? 0 : 1;
    const other = 1 - holder;
    const os = s.ctrl[other]!.slot;
    expect(os).toBeGreaterThanOrEqual(0);
    expect(os).not.toBe(r.taker);
    const x0 = s.players[os]!.x;
    run(s, 30, (_s, f) => { f[other]!.buttons = Btn.PASS; f[other]!.mx = 127; });
    expect(calls()).toHaveLength(0);
    expect(s.players[os]!.x).toBeGreaterThan(x0 + 0.5);
  });

  it('the SETPIECE_INPUT routing table holds goalKickInput', () => {
    expect(SETPIECE_INPUT[RestartKind.GOAL_KICK]).toBe(goalKickInput);
  });

  it('a CPU controller kicking marks the request ReqFlag.CPU', () => {
    const s = gkState(0, { humans: 0 }, layoutFar);
    toReady(s);
    const out = s.teams[0]!.cpu.out;
    out.buttons = Btn.LOB;
    run(s, 1);
    clearInputFrame(out);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.flags & (ReqFlag.CPU | ReqFlag.SET_PIECE)).toBe(ReqFlag.CPU | ReqFlag.SET_PIECE);
  });
});

// ---------------------------------------------------------------- default

describe('RUL-03 default', () => {
  function defaultState(prep: (s: SimState) => void, team = 0): SimState {
    const s = gkState(team, { humans: 1 }, (st) => { layoutFar(st); prep(st); });
    toReady(s);
    return s;
  }

  it('short ground pass to an open defender', () => {
    const s = defaultState((st) => {
      place(st, 1, -28, 30); place(st, 2, -41, 17); place(st, 3, -41, -14); place(st, 4, -28, -30);
    });
    goalKickDefault(s, EV);
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.target, c.charging, c.assist]).toEqual(['pass', KickKind.GROUND_PASS, 2, 0, AssistLevel.ASSISTED]);
    expect(c.flags).toBe(ReqFlag.SET_PIECE);
    const q = s.players[2]!;
    expect(c.power).toBeCloseTo(shortPower(Math.hypot(q.x - s.match.restart.x, q.z - s.match.restart.z)), 9);
    expect([s.match.restart.aimX, s.match.restart.aimZ]).toEqual([q.x, q.z]);
  });

  it('long LOB_PASS to the target man when no defender is open', () => {
    const s = defaultState((st) => {
      st.attrs[9]!.heading = 88;
      st.attrs[9]!.height = 194;
      // every defender outside the area with an opponent at his shoulder
      place(st, 1, -30, 25); place(st, 2, -30, 8); place(st, 3, -30, -8); place(st, 4, -30, -25);
      place(st, 12, -28.5, 25); place(st, 13, -28.5, 8); place(st, 14, -28.5, -8); place(st, 15, -28.5, -25);
    });
    goalKickDefault(s, EV);
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.target]).toEqual(['lob', KickKind.LOB_PASS, 9]);
    const q = s.players[9]!;
    expect(c.power).toBeCloseTo(longPower(Math.hypot(q.x - s.match.restart.x, q.z - s.match.restart.z)), 9);
  });

  it('a lane blocked by an opponent (geometric check while laneSafety is a stub) is not open', () => {
    const s = defaultState((st) => {
      place(st, 1, -30, 26); place(st, 3, -28, -24); place(st, 4, -30, -30);
      place(st, 2, -22, 20); // CB outside the area; an opponent sits in the lane, >= 8 m from him
      place(st, 12, -34, 13);
    });
    // nearest opponent to the CB is far enough, but the lane is blocked -> not chosen
    expect(bestShortOption(s, 0, 0, 1)).not.toBe(2);
  });

  it('uses TAI-09 laneSafety when it gives a signal (overrides the geometric preference)', () => {
    const prep = (st: SimState) => {
      place(st, 1, -30, 30); place(st, 4, -30, -30);
      place(st, 2, -40, 18); // more open geometrically
      place(st, 3, -40, -12);
    };
    const s = defaultState(prep);
    expect(bestShortOption(s, 0, 0, 1)).toBe(2);
    K.lane = ((_t: number, _x0: number, _z0: number, _x1: number, z1: number) => (z1 > 0 ? 0.2 : 0.95)) as LaneFn;
    expect(bestShortOption(s, 0, 0, 1)).toBe(3);
    K.lane = (() => 0.3) as LaneFn; // every lane unsafe -> no short option -> long
    goalKickDefault(s, EV);
    expect(calls()[0]!.fn).toBe('lob');
  });

  it('nobody open and nobody in long range -> short to the best teammate; nobody at all -> long kick straight ahead', () => {
    // Pure choice on the awarded restart (spot (-47, +4.58)); not stepped, so any layout is allowed.
    const s = gkState(0, { humans: 1 }, layoutFar);
    const spots: [number, number][] = [[-35, 20], [-35, 14], [-35, 8], [-35, -2], [-35, -10], [-35, -16], [-38, 24], [-40, -14]];
    for (let i = 1; i <= 8; i++) {
      const [x, z] = spots[i - 1]!;
      place(s, i, x, z);
      place(s, 11 + i, x + (i === 3 ? 4 : 1.2), z); // marked; slot 3's marker is furthest -> most open
    }
    place(s, 9, 40, 5); place(s, 10, 40, -5); // forwards beyond longMax
    const ch = createGoalKickChoice();
    expect(bestShortOption(s, 0, 0, 1)).toBe(-1);
    expect(bestLongOption(s, 0, 0)).toBe(-1);
    expect(chooseGoalKick(s, ch)).toBe(1);
    expect([ch.kind, ch.target]).toEqual([KickKind.GROUND_PASS, 3]);
    for (let i = 1; i <= 10; i++) s.players[i]!.active = 0;
    expect(chooseGoalKick(s, ch)).toBe(1);
    const r = s.match.restart;
    expect([ch.kind, ch.target, ch.x, ch.z]).toEqual([KickKind.LOB_PASS, -1, r.x + LOCAL_TUNING.longFallbackDist, r.z]);
    expect(ch.power).toBeCloseTo(longPower(LOCAL_TUNING.longFallbackDist), 9);
    s.match.restart.ready = 1;
    goalKickDefault(s, EV);
    const c = calls()[0]!;
    expect([c.fn, c.target, c.hasTarget, c.dirX, c.dirZ]).toEqual(['lob', -1, 1, 1, 0]);
    // no goal kick set up -> no choice
    s.match.restart.kind = RestartKind.CORNER;
    expect(chooseGoalKick(s, ch)).toBe(0);
    expect(ch.kind).toBe(KickKind.NONE);
  });

  it('never passes into the own goal mouth; a sideways pass to a full-back on the goal line is fine', () => {
    const s = defaultState(() => { /* defaults */ });
    const r = s.match.restart; // (-47, +4.58)
    expect(clearOfOwnGoal(s, 0, r.x, r.z, -5.5, -4.58)).toBe(false); // at the near post
    expect(clearOfOwnGoal(s, 0, r.x, r.z, -5.5, -9)).toBe(false); // across the goal mouth
    expect(clearOfOwnGoal(s, 0, r.x, r.z, -4, 12)).toBe(true); // to the byline wide of the goal
    expect(clearOfOwnGoal(s, 0, r.x, r.z, 0, -1)).toBe(true);
    expect(clearOfOwnGoal(s, 0, r.x, r.z, 1, 0)).toBe(true);
    // team 1 attacking -x has its own goal at +x
    expect(clearOfOwnGoal(s, 1, 47, 4.58, 5.5, -4.58)).toBe(false);
  });

  it('the AI never picks a teammate behind the ball across the goal mouth; behind on the ball side is fine', () => {
    const s = defaultState((st) => {
      place(st, 1, -30, 30); place(st, 4, -30, -30); place(st, 2, -24, 30);
      place(st, 3, -51, -12); // behind the ball, far side: the lane runs back across the goal mouth
    });
    expect(bestShortOption(s, 0, 0, 0)).not.toBe(3);
    expect(bestShortOption(s, 0, 0, 1)).not.toBe(3);
    place(s, 3, -50.5, 18); // behind the ball on its own side, moving away from the goal
    expect(bestShortOption(s, 0, 0, 1)).toBe(3);
  });

  it('leaves a taker who is already kicking alone (no double kick)', () => {
    const s = defaultState(() => { /* defaults */ });
    const tk = s.players[s.match.restart.taker]!;
    tk.act = ActionKind.KICK; tk.actT = 2; tk.actDur = 30; tk.actCharging = 1;
    goalKickDefault(s, EV);
    expect(calls()).toHaveLength(0);
  });

  it('default for team 1 in the second half kicks toward its attacking direction', () => {
    const s = gkState(1, { humans: [{ side: 1 }], swap: true });
    toReady(s);
    goalKickDefault(s, EV);
    const c = calls()[0]!;
    expect(c.slot).toBe(s.teams[1]!.keeperSlot);
    expect(Math.sign(c.dirX) === s.teams[1]!.dir || c.dirX === 0).toBe(true);
  });
});

// ---------------------------------------------------------------- timeouts

describe('RUL-03 timeout default and CPU fallback', () => {
  it('human who never acts: the Default takes it restartTimeoutTicks after ready, no watchdog', () => {
    K.accept = true;
    const s = gkState(0, { humans: 1 }, layoutFar);
    toReady(s);
    const readyTick = s.tick;
    const ev = run(s, T_RULES.restartTimeoutTicks + 10, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.tick - readyTick).toBeGreaterThanOrEqual(T_RULES.restartTimeoutTicks - 1);
    expect(c.tick - readyTick).toBeLessThanOrEqual(T_RULES.restartTimeoutTicks + 1);
    expect(c.flags).toBe(ReqFlag.SET_PIECE);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
  });

  it('CPU side: takes it cpuRestartDelay + cpuGraceTicks after ready when its brain did not, no watchdog', () => {
    K.accept = true;
    for (const team of [0, 1]) {
      calls().length = 0;
      const s = gkState(team, { humans: 0 }, layoutFar);
      const ev = run(s, 400, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]!.rt - SETUP).toBe(T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
    }
  });

  it('CPU fallback retries every cpuRetryTicks while the start is refused (RUL-11 safety nets stay behind it)', () => {
    const s = gkState(0, { humans: 0 }, layoutFar);
    run(s, SETUP + T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks + 3 * LOCAL_TUNING.cpuRetryTicks + 5);
    const due = SETUP + T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks;
    expect(calls().map((c) => c.rt)).toEqual([0, 1, 2, 3].map((k) => due + k * LOCAL_TUNING.cpuRetryTicks));
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    expect(s.players[s.match.restart.taker]!.act).toBe(ActionKind.SET_PIECE); // RUL-11 put him back to wait
  });

  it('a human side never gets the CPU fallback', () => {
    const s = gkState(0, { humans: 1 }, layoutFar);
    run(s, SETUP + 400);
    expect(calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- opponents kept out

describe('RUL-03 opponents kept out of the penalty area until the ball is played', () => {
  it('an AI intruder and a human defender pushing in stay outside until the kick, then may enter', () => {
    K.accept = true;
    const s = gkState(0, { humans: [{ side: 0 }, { side: 1, autoSwitch: AutoSwitch.OFF }] }, layoutFar);
    toReady(s);
    const r = s.match.restart;
    const end = ownEnd(s, 0);
    const human2 = s.ctrl[1]!.slot;
    const intruder = human2 === 20 ? 21 : 20;
    expect(human2).toBeGreaterThanOrEqual(11);
    place(s, human2, -26, 2);
    place(s, intruder, -27, 12);
    const push: Inputs = (st, f) => {
      const p = st.players[human2]!;
      const dx = r.x - p.x, dz = r.z - p.z, d = Math.hypot(dx, dz);
      f[1]!.mx = Math.round((dx / d) * 127); f[1]!.mz = Math.round((dz / d) * 127); f[1]!.buttons = Btn.SPRINT;
      const q = st.players[intruder]!;
      q.moveMode = MoveMode.ARRIVE; q.tgtX = r.x; q.tgtZ = r.z; q.tgtSpeed = 8; q.wantSprint = 1;
    };
    const bad: string[] = [];
    run(s, 300, push, (st) => { bad.push(...illegalOpponents(st, 0.35).map((m) => `t=${st.tick} ${m}`)); return false; });
    expect(bad).toEqual([]);
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    // both are pressing at the edge of the area
    for (const i of [human2, intruder]) {
      const p = s.players[i]!;
      expect(end * p.x, `slot ${i} at the edge of the area`).toBeGreaterThan(HALF_LENGTH - PENALTY_AREA_DEPTH - 0.35 - 0.5);
    }
    // the ball is played: the area is open again
    run(s, 1, (st, f) => { push(st, f); f[0]!.buttons = Btn.LOB; });
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    run(s, 90, push);
    const entered = [human2, intruder].some((i) => inPA(s.players[i]!.x, s.players[i]!.z, end));
    expect(entered).toBe(true);
  });
});

// ---------------------------------------------------------------- offside, ball safety, determinism

describe('RUL-03 regressions', () => {
  it('glitch: offside given from a goal kick -- the kick is struck while the phase is GOAL_KICK (RUL-08 checks it)', () => {
    K.accept = true;
    const s = gkState(0, { humans: 1 }, (st) => {
      layoutFar(st);
      place(st, 9, 30, 0); // far beyond the second-last defender
    });
    toReady(s);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 9; });
    expect(K.kickPhases).toEqual([MatchPhase.GOAL_KICK]);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.match.offside.flags).toBe(0);
  });

  it('glitch: ball out of play during a restart -- a goal-kick ball moved or knocked out goes back on the spot', () => {
    const s = gkState(0, { humans: 1 }, layoutFar);
    toReady(s);
    const r = s.match.restart;
    s.ball.x = -54; s.ball.z = 20; s.ball.vx = -3; // over the line
    run(s, 1);
    expect([s.ball.x, s.ball.z, s.ball.vx]).toEqual([r.x, r.z, 0]);
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    s.ball.owner = 15; // an opponent got it
    run(s, 1);
    expect([s.ball.owner, s.ball.x, s.ball.z]).toEqual([-1, r.x, r.z]);
  });

  it('power bar: restart.aimPower mirrors a charging kick', () => {
    const s = gkState(0, { humans: 1 }, layoutFar);
    toReady(s);
    const tk = s.players[s.match.restart.taker]!;
    tk.act = ActionKind.KICK; tk.actT = 1; tk.actDur = 60; tk.actCharging = 1; tk.actPower = 0.4;
    goalKickTick(s, EV);
    expect(s.match.restart.aimPower).toBeCloseTo(0.4, 9);
  });

  it('deterministic: the same seed and inputs give the same state hash', () => {
    const go = () => {
      K.accept = true;
      K.calls.length = 0;
      const s = gkState(0, { humans: 2, seed: 99 }, layoutFar);
      run(s, SETUP + 20, (_s, f) => { f[0]!.mx = 40; f[0]!.mz = -100; f[1]!.mx = -127; });
      run(s, 1, press(Btn.LOB));
      run(s, 60);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });

  it('every goal-kick state stays finite with hostile frames', () => {
    const s = gkState(0, { humans: 2 }, layoutFar);
    toReady(s);
    const f = createInputFrame();
    Object.assign(f, { mx: Number.NaN, mz: 1e9, gesture: GestureKind.TAP, gSlot: 999, gx: Number.POSITIVE_INFINITY, gz: -1e12 });
    for (const c of [0, 1, 2, 3]) goalKickInput(s, c, f, EV);
    Object.assign(f, { gSlot: -1, gx: Number.NaN });
    goalKickInput(s, 0, f, EV);
    const r = s.match.restart;
    for (const v of [r.aimX, r.aimZ, r.x, r.z, s.ball.x, s.ball.z]) expect(Number.isFinite(v)).toBe(true);
    for (const p of s.players) expect(Number.isFinite(p.ix) && Number.isFinite(p.iz)).toBe(true);
  });

  it('the line-up and CPU fallback do nothing outside a ready goal kick', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const before = hashState(s);
    goalKickTick(s, EV);
    goalKickDefault(s, EV);
    goalKickInput(s, 0, createInputFrame(), EV);
    expect(hashState(s)).toBe(before);
    expect(calls()).toHaveLength(0);
  });
});
