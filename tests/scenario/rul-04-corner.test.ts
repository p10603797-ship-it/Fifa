/**
 * RUL-04: corners. Setup (ball in the corner arc of the attacked end on the side it went out, best crosser not needed
 * in the box as taker, opponents >= 9.15 m, aim reticle on the penalty-spot area), correct side and team, input (left /
 * right stick move the reticle, always clamped in the box; LOB = cross to the reticle via SIM-09 startLob(CROSS) with a
 * target; PASS = short corner to the nearest teammate; taps and swipes from the ball; corner-tactic commands), the
 * Default (cross to the tactic's zone) at the human timeout and as the CPU fallback, the cross landing near the aim,
 * no offside from corners, and the glitch-list lines that touch corners.
 *
 * The real pipeline runs (step.ts, RUL-01 machine, RUL-11 restart flow, SIM-15/16 resolver and switching, locomotion,
 * bodies, ball physics). Mocked:
 *  - SIM-08 startPass / SIM-09 startLob: record every request; when `K.accept` is set they kick the ball at once through
 *    core/kick.ts applyKick (a targeted lob is launched with SIM-01 solveLaunchSpin so it really flies to the requested
 *    point), else they refuse (like the Wave 0 stubs);
 *  - TAI-14 applyCommand: a CORNER_* command sets team.cornerTactic (its documented effect; the module is a stub);
 *  - RUL-08 offsideTick: wrapped to record the phase on every tick a kick was struck;
 *  - team AI, CPU brains and contacts: no-ops (only the rules decide; tests drive intruders and CPU frames).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// [QF-1] Evaluate rules/corner before anything reaches the mocked kicks modules: when the real kicks/lob.ts is
// loaded first (inside its mock factory) it pulls the rules modules in through the action registry, and corner.ts then
// binds to the ORIGINAL startLob / startPass (the mock is still being built), so the spies saw no calls.
import '../../src/sim/rules/corner';
import {
  BALL_RADIUS, CORNER_ARC_RADIUS, DT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH,
  RESTART_DISTANCE,
} from '../../src/contracts/constants';
import {
  ActionKind, AutoSwitch, Command, ControllerKind, CrossKind, GestureKind, KickKind, MatchPhase, RestartKind,
} from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { Btn, GestureFlag, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { MoveMode, RosterStatus, type SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_PASS, T_RULES } from '../../src/contracts/tuning';
import { createLaunchSolution, solveLaunchSpin } from '../../src/sim/ball/flight';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { applyKick } from '../../src/sim/core/kick';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { step } from '../../src/sim/step';
import { rulesTick } from '../../src/sim/rules/machine';
import { LOCAL_TUNING as RESTART_TUNING, awardRestart, isLegalRestartPosition } from '../../src/sim/rules/restart';
import {
  LOCAL_TUNING, chooseCornerCross, clampToCornerBox, cornerCrossPower, cornerDefault, cornerInput, cornerSetup,
  cornerSpot, cornerTacticIndex, cornerTick, cornerZone, createCornerChoice, inCornerBox, isCornerSpot, pickCornerTaker,
} from '../../src/sim/rules/corner';
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
  curve: number;
  assist: number;
  tick: number;
  phase: number;
  rt: number;
  takerAct: number;
}

const K = vi.hoisted(() => ({
  accept: false,
  calls: [] as unknown[],
  kickPhases: [] as number[],
}));

const SOL = createLaunchSolution();

function record(fn: 'pass' | 'lob', s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink): number {
  (K.calls as Call[]).push({
    fn, slot, kind, target: req.targetSlot, flags: req.flags, power: req.power, charging: req.charging, dirX: req.dirX,
    dirZ: req.dirZ, hasTarget: req.hasTarget, targetX: req.targetX, targetZ: req.targetZ, curve: req.curve,
    assist: req.assist, tick: s.tick, phase: s.match.phase, rt: s.match.restart.t, takerAct: s.players[slot]!.act,
  });
  if (!K.accept) return 0;
  const b = s.ball;
  const l = createKickLaunch();
  if (fn === 'lob' && req.hasTarget === 1) {
    // A real flight to the requested point (SIM-01 solver; the ball then flies through the real ballTick).
    solveLaunchSpin(req.targetX - b.x, req.targetZ - b.z, T_PASS.lobAngle, BALL_RADIUS, 0, 0, SOL);
    l.vx = SOL.vx; l.vy = SOL.vy; l.vz = SOL.vz;
    l.tx = req.targetX; l.tz = req.targetZ;
  } else {
    const sp = fn === 'lob' ? 18 : 12;
    l.vx = req.dirX * sp; l.vz = req.dirZ * sp; l.vy = fn === 'lob' ? 8 : 0;
    l.tx = b.x + req.dirX * 10; l.tz = b.z + req.dirZ * 10;
  }
  l.kind = kind;
  l.target = req.targetSlot;
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
vi.mock('../../src/ai/tactics', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/tactics')>()),
  applyCommand: (s: SimState, team: number, cmd: number) => {
    if (cmd >= 11 && cmd <= 14 && (team === 0 || team === 1)) s.teams[team]!.cornerTactic = cmd;
  },
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
  K.kickPhases.length = 0;
});

const calls = (): Call[] => K.calls as Call[];

// ---------------------------------------------------------------- harness

const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser'); // team AI is mocked out
const EV = createEventBuffer();
const SETUP = T_RULES.restartSetupTicks;
const INSET = CORNER_ARC_RADIUS * LOCAL_TUNING.spotInset;

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

function place(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
}

/** Mirror every player's x (after swapping the directions). */
function mirrorPositions(s: SimState): void {
  for (const p of s.players) { p.x = -p.x; p.homeX = -p.homeX; p.fx = -p.fx; }
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

/** World point at depth u from the goal line `team` attacks and lateral w toward the corner side `sd`. */
function at(s: SimState, team: number, sd: number, u: number, w: number): [number, number] {
  const e = s.teams[team]!.dir;
  return [e * (HALF_LENGTH - u), sd * w];
}

/** Independent box check: inside the attacked penalty area, aimLineMargin off the goal line, aimBoxMargin inside. */
function aimInBox(s: SimState, team: number, x: number, z: number, slack = 1e-9): boolean {
  const u = HALF_LENGTH - s.teams[team]!.dir * x;
  return u >= LOCAL_TUNING.aimLineMargin - slack && u <= PENALTY_AREA_DEPTH - LOCAL_TUNING.aimBoxMargin + slack &&
    Math.abs(z) <= PENALTY_AREA_HALF_WIDTH - LOCAL_TUNING.aimBoxMargin + slack;
}

/**
 * Corner layout for `team` from side `sd`: the taker-to-be (first + 10: best crosser, poor in the air) far away, headers
 * in the box (first + 3 penalty spot, + 4 far post, + 5 near post, + 7 six-yard box), first + 6 at the edge, first + 8
 * the short option ~7.6 m from the ball, defenders marking in the box (all > 9.15 m from the ball).
 */
function layoutCorner(s: SimState, team: number, sd: number): void {
  const f = team === 0 ? 0 : 11;
  const o = team === 0 ? 11 : 0;
  const P = (slot: number, u: number, w: number): void => { const [x, z] = at(s, team, sd, u, w); place(s, slot, x, z); };
  const e = s.teams[team]!.dir;
  place(s, f, -e * 50, 0);
  P(f + 1, 60, 10); P(f + 2, 62, -10);
  P(f + 3, 10, 0); P(f + 4, 6, -5); P(f + 5, 5.5, 3.5); P(f + 6, 16, 1); P(f + 7, 3, 0.8); P(f + 8, 4.5, 27);
  P(f + 9, 30, -15); P(f + 10, 40, 5);
  for (let i = f + 1; i <= f + 10; i++) { s.attrs[i]!.crossing = 50; s.attrs[i]!.curve = 50; }
  const a = s.attrs[f + 10]!;
  a.crossing = 95; a.curve = 90; a.heading = 25; a.height = 168;
  place(s, o, e * (HALF_LENGTH - 1), 0);
  P(o + 1, 9, 1.5); P(o + 2, 6.5, -3.5); P(o + 3, 4.5, 5.5); P(o + 4, 12, -6); P(o + 5, 15, 6); P(o + 6, 1, 3.4);
  P(o + 7, 20, -12); P(o + 8, 11, 18); P(o + 9, 50, 0); P(o + 10, 25, 0);
}

interface CornerOpts {
  humans?: number | ScenarioHuman[];
  seed?: number;
  /** Second half: home attacks -x. */
  swap?: boolean;
  side?: number;
  /** Override the award spot (x, z). */
  award?: [number, number];
}

/** A match in play with a corner awarded to `team` (not ready yet). */
function cornerState(team: number, opts: CornerOpts = {}, prep?: (s: SimState) => void): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: opts.humans ?? 0, seed: opts.seed ?? 7 });
  if (opts.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; mirrorPositions(s); }
  prep?.(s);
  const e = s.teams[team]!.dir;
  const sd = opts.side ?? 1;
  const [x, z] = opts.award ?? [e * (HALF_LENGTH - INSET), sd * (HALF_WIDTH - INSET)];
  EV.begin(s.tick);
  awardRestart(s, RestartKind.CORNER, team, x, z, EV);
  expect(s.match.phase).toBe(MatchPhase.CORNER);
  return s;
}

function toReady(s: SimState, inputs?: Inputs): SimEvent[] {
  const ev = run(s, SETUP + 5, inputs, (st) => st.match.restart.ready === 1);
  expect(s.match.restart.ready).toBe(1);
  return ev;
}

/** Human P1 for team 0 (side `sd`), corner ready, P1 holds the taker. */
function humanReady(sd = 1, prep?: (s: SimState) => void, human: Partial<ScenarioHuman> = {}, opts: CornerOpts = {}): SimState {
  const s = cornerState(0, { humans: [{ side: 0, ...human }], side: sd, ...opts }, (st) => { layoutCorner(st, 0, sd); prep?.(st); });
  toReady(s);
  run(s, 1);
  expect(s.ctrl[0]!.slot).toBe(s.match.restart.taker);
  return s;
}

const press = (bits: number) => (s: SimState, f: InputFrame[]) => { void s; f[0]!.buttons = bits; };

/** Independent check: opponents of the kicking team at least 9.15 m from the ball spot. */
function closeOpponents(s: SimState, slack = 0.06): string[] {
  const r = s.match.restart;
  const out: string[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.team === r.team) continue;
    const d = Math.hypot(p.x - r.x, p.z - r.z);
    if (d < RESTART_DISTANCE - slack) out.push(`${i} within 9.15 m (${d.toFixed(2)})`);
  }
  return out;
}

/** The boxHeaders best in the air of a team (independent of the module). */
function topHeaders(s: SimState, team: number): number[] {
  const first = team === 0 ? 0 : 11;
  const list: { slot: number; sc: number }[] = [];
  for (let i = first; i < first + 11; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    list.push({ slot: i, sc: s.attrs[i]!.heading + LOCAL_TUNING.heightWeight * (s.attrs[i]!.height - 180) });
  }
  list.sort((a, b) => b.sc - a.sc || a.slot - b.slot);
  return list.slice(0, LOCAL_TUNING.boxHeaders).map((x) => x.slot);
}

// ---------------------------------------------------------------- setup

describe('RUL-04 setup', () => {
  const table: { team: number; swap: boolean; side: number }[] = [];
  for (const team of [0, 1]) for (const swap of [false, true]) for (const side of [1, -1]) table.push({ team, swap, side });

  it.each(table)('team $team, second half $swap, side $side: ball in the arc of the attacked end, aim on the penalty-spot area',
    ({ team, swap, side }) => {
      const s = cornerState(team, { swap, side });
      const r = s.match.restart;
      const b = s.ball;
      const e = s.teams[team]!.dir;
      expect(r.kind).toBe(RestartKind.CORNER);
      expect(r.team).toBe(team);
      expect(r.side).toBe(side);
      expect(r.x).toBeCloseTo(e * (HALF_LENGTH - INSET), 9);
      expect(r.z).toBeCloseTo(side * (HALF_WIDTH - INSET), 9);
      // whole ball inside the field and inside the corner arc
      const dFlag = Math.hypot(r.x - e * HALF_LENGTH, r.z - side * HALF_WIDTH);
      expect(dFlag + BALL_RADIUS).toBeLessThanOrEqual(CORNER_ARC_RADIUS);
      expect(HALF_LENGTH - Math.abs(r.x)).toBeGreaterThan(BALL_RADIUS);
      expect(HALF_WIDTH - Math.abs(r.z)).toBeGreaterThan(BALL_RADIUS);
      expect([b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner, b.heldBy]).toEqual([r.x, BALL_RADIUS, r.z, 0, 0, 0, -1, -1]);
      // aim reticle on the penalty-spot area, inside the box
      expect(r.aimX).toBeCloseTo(e * (HALF_LENGTH - LOCAL_TUNING.zoneDepth[0]!), 9);
      expect(r.aimZ).toBeCloseTo(side * LOCAL_TUNING.zoneSide[0]!, 9);
      expect(Math.abs(Math.abs(r.aimX) - (HALF_LENGTH - 11))).toBeLessThanOrEqual(2); // near the penalty spot
      expect(aimInBox(s, team, r.aimX, r.aimZ)).toBe(true);
      expect([r.aimPower, r.aimCurve]).toEqual([0, 0]);
      // taker: an outfield player of the team, not one of the best headers
      const tk = s.players[r.taker]!;
      expect(tk.team).toBe(team);
      expect(tk.isKeeper).toBe(0);
      expect(topHeaders(s, team)).not.toContain(r.taker);
    });

  it('an award on the corner flag itself (watchdog), on a line or outside the arc gives the canonical spot in the arc', () => {
    for (const award of [[HALF_LENGTH, HALF_WIDTH], [HALF_LENGTH - 0.05, HALF_WIDTH - 0.9], [HALF_LENGTH - 0.6, HALF_WIDTH - 0.05],
      [HALF_LENGTH - 0.8, HALF_WIDTH - 0.8], [HALF_LENGTH, 20]] as [number, number][]) {
      const s = cornerState(0, { award });
      expect([s.match.restart.x, s.match.restart.z], `${award}`).toEqual([HALF_LENGTH - INSET, HALF_WIDTH - INSET]);
      expect([s.ball.x, s.ball.z]).toEqual([HALF_LENGTH - INSET, HALF_WIDTH - INSET]);
    }
  });

  it('a legal spot in the arc (whole ball inside both lines) is kept as awarded', () => {
    for (const [team, sd, u, w] of [[0, 1, 0.7, 0.5], [1, -1, 0.2, 0.9], [0, -1, 0.85, 0.2]] as [number, number, number, number][]) {
      const s0 = makeScenario({ phase: MatchPhase.IN_PLAY });
      const [x, z] = at(s0, team, sd, u, HALF_WIDTH - w);
      const s = cornerState(team, { award: [x, z], side: sd });
      expect([s.match.restart.x, s.match.restart.z]).toEqual([x, z]);
      expect([s.ball.x, s.ball.z, s.match.restart.side]).toEqual([x, z, sd]);
    }
  });

  it('cornerSetup takes the side from ball.crossZ when the restart z is 0 (RUL-11 normally resolves the side first)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const r = s.match.restart;
    r.kind = RestartKind.CORNER; r.team = 0; r.x = HALF_LENGTH; r.z = 0;
    s.ball.crossZ = -12;
    cornerSetup(s, EV);
    expect([r.x, r.z, r.side]).toEqual([HALF_LENGTH - INSET, -(HALF_WIDTH - INSET), -1]);
    expect([s.ball.x, s.ball.z]).toEqual([r.x, r.z]);
    s.ball.crossZ = 3;
    r.z = 0;
    cornerSetup(s, EV);
    expect([r.z, r.side]).toEqual([HALF_WIDTH - INSET, 1]);
  });

  it('cornerSetup ignores a restart of another kind; cornerSpot is pure placement', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    s.match.restart.kind = RestartKind.GOAL_KICK;
    const before = JSON.stringify(s.match.restart);
    cornerSetup(s, EV);
    expect(JSON.stringify(s.match.restart)).toBe(before);
    const out = { x: 0, z: 0 };
    cornerSpot(s, 1, -1, out);
    expect(out).toEqual({ x: -(HALF_LENGTH - INSET), z: -(HALF_WIDTH - INSET) });
    expect(isCornerSpot(s, 1, -1, out.x, out.z)).toBe(true);
    expect(isCornerSpot(s, 1, 1, out.x, out.z)).toBe(false); // other side
    expect(isCornerSpot(s, 0, -1, out.x, out.z)).toBe(false); // other end
    expect(isCornerSpot(s, 1, -1, -HALF_LENGTH, -HALF_WIDTH)).toBe(false); // on the flag: half the ball over the lines
    expect(isCornerSpot(s, 1, -1, Number.NaN, 0)).toBe(false);
  });

  it('after the setup delay everyone is legal: opponents >= 9.15 m, taker on the ball in SET_PIECE, no watchdog', () => {
    for (const team of [0, 1]) {
      for (const side of [1, -1]) {
        const s = cornerState(team, { side }, (st) => {
          layoutCorner(st, team, side);
          const o = team === 0 ? 11 : 0;
          // three opponents crowding the corner flag, one standing on the ball spot
          const [x1, z1] = at(st, team, side, 0.5, 33.5);
          place(st, o + 7, x1, z1);
          const [x2, z2] = at(st, team, side, 4, 30);
          place(st, o + 8, x2, z2);
          const [x3, z3] = at(st, team, side, 8, 27);
          place(st, o + 10, x3, z3);
        });
        const ev = toReady(s);
        expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
        expect(closeOpponents(s)).toEqual([]);
        for (let i = 0; i < NUM_SLOTS; i++) expect(isLegalRestartPosition(s, i), `team ${team} side ${side} slot ${i}`).toBe(true);
        const r = s.match.restart;
        const tk = s.players[r.taker]!;
        expect(r.taker).toBe((team === 0 ? 0 : 11) + 10); // the layout's best crosser
        expect(Math.hypot(tk.x - r.x, tk.z - r.z)).toBeLessThanOrEqual(RESTART_TUNING.takerReach);
        expect(tk.act).toBe(ActionKind.SET_PIECE);
        expect([s.ball.x, s.ball.z]).toEqual([r.x, r.z]);
      }
    }
  });
});

// ---------------------------------------------------------------- taker

describe('RUL-04 taker: the best crosser not needed in the box', () => {
  function attrs(s: SimState, slot: number, crossing: number, curve: number, heading: number, height: number): void {
    const a = s.attrs[slot]!;
    a.crossing = crossing; a.curve = curve; a.heading = heading; a.height = height;
  }

  function baseline(s: SimState): void {
    for (let i = 0; i < 22; i++) attrs(s, i, 40, 40, 40, 178);
  }

  it('picks the best crosser; a top header is kept for the box even when he crosses best; never the keeper', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    baseline(s);
    attrs(s, 9, 99, 99, 95, 195); // best crosser, but the best header too: needed in the box
    attrs(s, 3, 60, 60, 90, 190);
    attrs(s, 4, 60, 60, 88, 188);
    attrs(s, 7, 85, 70, 40, 175); // best crosser of the rest
    attrs(s, 8, 80, 90, 40, 175); // 80 + 45 = 125 > 85 + 35 = 120: curve counts too
    attrs(s, 0, 99, 99, 20, 190); // the keeper never takes it
    expect(pickCornerTaker(s, 0)).toBe(8);
    attrs(s, 8, 70, 60, 40, 175);
    expect(pickCornerTaker(s, 0)).toBe(7);
  });

  it('players who are down are avoided while someone else can take it; fallbacks to headers, then anyone', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    baseline(s);
    attrs(s, 12, 90, 90, 40, 175);
    attrs(s, 13, 80, 80, 40, 175);
    s.players[12]!.act = ActionKind.FALLEN;
    s.players[12]!.stunT = 30;
    expect(pickCornerTaker(s, 1)).toBe(13);
    s.players[12]!.act = ActionKind.NONE;
    s.players[12]!.stunT = 0;
    expect(pickCornerTaker(s, 1)).toBe(12);
    // only the best headers and the keeper left: a header takes it, then the keeper, then nobody
    for (let i = 12; i < 22; i++) s.players[i]!.active = 0;
    s.players[15]!.active = 1;
    attrs(s, 15, 30, 30, 99, 199);
    expect(pickCornerTaker(s, 1)).toBe(15);
    s.players[15]!.active = 0;
    expect(pickCornerTaker(s, 1)).toBe(11);
    s.players[11]!.active = 0;
    expect(pickCornerTaker(s, 1)).toBe(-1);
  });

  it('glitch: taker missing or sent off -- a new taker is picked and the human can still take the corner', () => {
    K.accept = true;
    const s = humanReady();
    const old = s.match.restart.taker;
    sendOff(s, old);
    run(s, 3);
    const t = s.match.restart.taker;
    expect(t).not.toBe(old);
    expect(s.players[t]!.active).toBe(1);
    expect(s.players[t]!.team).toBe(0);
    expect(s.ctrl[0]!.slot).toBe(t);
    run(s, 2, press(Btn.LOB));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]!.slot).toBe(t);
    run(s, 1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

// ---------------------------------------------------------------- correct team (RUL-01 -> RUL-11 -> RUL-04)

describe('RUL-04 correct side and team (glitch: restart given to the wrong team)', () => {
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
    { swap: false, end: 1, z: 20, last: 1, team: 0 },
    { swap: false, end: 1, z: -6, last: 1, team: 0 },
    { swap: false, end: -1, z: -15, last: 0, team: 1 },
    { swap: false, end: -1, z: 4.5, last: 0, team: 1 },
    { swap: true, end: -1, z: -25, last: 1, team: 0 },
    { swap: true, end: 1, z: 9, last: 0, team: 1 },
  ];
  it.each(cases)('second half $swap: out over end $end at z $z last touched by $last -> corner for team $team', (c) => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    if (c.swap) { s.teams[0]!.dir = -1; s.teams[1]!.dir = 1; mirrorPositions(s); }
    outOver(s, c.end, c.z, c.last);
    const r = s.match.restart;
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(r.kind).toBe(RestartKind.CORNER);
    expect(r.team).toBe(c.team);
    expect(s.teams[c.team]!.dir).toBe(c.end); // the end they attack
    expect(r.x).toBeCloseTo(c.end * (HALF_LENGTH - INSET), 9);
    expect(r.z).toBeCloseTo(Math.sign(c.z) * (HALF_WIDTH - INSET), 9);
    expect(r.side).toBe(Math.sign(c.z));
    expect(s.players[r.taker]!.team).toBe(c.team);
  });

  it('out over the goal line last touched by the attacking team is a goal kick, not a corner', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    outOver(s, 1, 20, 0); // team 0 attacks end +1
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    expect(s.match.restart.team).toBe(1);
  });

  it('a corner award at the end the team defends is refused (wrong team) and logged', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const ev = createEventBuffer();
    ev.begin(s.tick);
    awardRestart(s, RestartKind.CORNER, 0, -HALF_LENGTH, HALF_WIDTH, ev);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    let watchdogs = 0;
    for (let k = 0; k < ev.count; k++) if (ev.get(k).type === EventType.WATCHDOG) watchdogs++;
    expect(watchdogs).toBe(1);
  });
});

// ---------------------------------------------------------------- input

describe('RUL-04 input', () => {
  it('aim reticle clamped in the box: full left / right stick in every direction never leaves the box', () => {
    for (const sd of [1, -1]) {
      for (const swap of [false, true]) {
        const s = humanReady(sd, undefined, {}, { swap });
        const r = s.match.restart;
        const out: string[] = [];
        let minU = 99, maxU = -99, minZ = 99, maxZ = -99;
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          const sx = Math.round(Math.cos(a) * 127), sz = Math.round(Math.sin(a) * 127);
          run(s, 80, (_s, f) => { // 8 x 80 ticks stays inside the 12 s human timeout
            if (k % 2 === 0) { f[0]!.mx = sx; f[0]!.mz = sz; } else { f[0]!.ax = sx; f[0]!.az = sz; }
          }, (st) => {
            const rr = st.match.restart;
            if (!aimInBox(st, 0, rr.aimX, rr.aimZ)) out.push(`k=${k} t=${st.tick} (${rr.aimX}, ${rr.aimZ})`);
            const u = HALF_LENGTH - st.teams[0]!.dir * rr.aimX;
            minU = Math.min(minU, u); maxU = Math.max(maxU, u); minZ = Math.min(minZ, rr.aimZ); maxZ = Math.max(maxZ, rr.aimZ);
            return false;
          });
        }
        expect(out).toEqual([]);
        // it reaches every edge of the region (the clamp, not a stuck reticle)
        expect(minU).toBeCloseTo(LOCAL_TUNING.aimLineMargin, 9);
        expect(maxU).toBeCloseTo(PENALTY_AREA_DEPTH - LOCAL_TUNING.aimBoxMargin, 9);
        expect(minZ).toBeCloseTo(-(PENALTY_AREA_HALF_WIDTH - LOCAL_TUNING.aimBoxMargin), 9);
        expect(maxZ).toBeCloseTo(PENALTY_AREA_HALF_WIDTH - LOCAL_TUNING.aimBoxMargin, 9);
        expect(r.taken).toBe(0);
        expect(calls()).toHaveLength(0);
      }
    }
  });

  it('left stick moves the reticle at aimSpeed, the right stick at reticleSpeed; a stick inside the dead zone does not', () => {
    const s = humanReady();
    const r = s.match.restart;
    let x0 = r.aimX, z0 = r.aimZ;
    run(s, 10, (_s, f) => { f[0]!.mz = -127; });
    expect(r.aimX).toBeCloseTo(x0, 9);
    expect(r.aimZ - z0).toBeCloseTo(-LOCAL_TUNING.aimSpeed * DT * 10, 6);
    x0 = r.aimX; z0 = r.aimZ;
    run(s, 10, (_s, f) => { f[0]!.ax = -127; });
    expect(r.aimX - x0).toBeCloseTo(-LOCAL_TUNING.reticleSpeed * DT * 10, 6);
    expect(r.aimZ).toBeCloseTo(z0, 9);
    x0 = r.aimX; z0 = r.aimZ;
    run(s, 10, (_s, f) => { f[0]!.mx = 15; f[0]!.az = -20; });
    expect([r.aimX, r.aimZ]).toEqual([x0, z0]);
  });

  it('LOB -> cross to the reticle: startLob(CROSS), target point = reticle, charging, SET_PIECE; then IN_PLAY', () => {
    K.accept = true;
    const s = humanReady();
    const r = s.match.restart;
    run(s, 12, (_s, f) => { f[0]!.mz = -127; }); // reticle toward the far post
    const ax = r.aimX, az = r.aimZ;
    const ev = run(s, 1, press(Btn.LOB));
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.hasTarget, c.target, c.charging, c.power]).toEqual(['lob', KickKind.CROSS, 1, -1, 1, 0]);
    expect([c.targetX, c.targetZ]).toEqual([ax, az]);
    expect(c.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
    expect(c.flags & (ReqFlag.CPU | ReqFlag.GESTURE | ReqFlag.LOFTED)).toBe(0);
    expect(c.phase).toBe(MatchPhase.CORNER);
    expect(c.takerAct).toBe(ActionKind.NONE); // RUL-11 prepareTakerKick freed him first
    const d = Math.hypot(ax - r.x, az - r.z);
    expect(c.dirX).toBeCloseTo((ax - r.x) / d, 9);
    expect(c.dirZ).toBeCloseTo((az - r.z) / d, 9);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
  });

  it.each([
    { bits: Btn.LOB | Btn.MOD_L | Btn.MOD_R, kind: KickKind.LOW_CROSS, lofted: 0 },
    { bits: Btn.LOB | Btn.MOD_L, kind: KickKind.CROSS, lofted: ReqFlag.LOFTED },
    { bits: Btn.LOB | Btn.MOD_R, kind: KickKind.CROSS, lofted: 0 },
  ])('modifiers: buttons $bits -> kind $kind', ({ bits, kind, lofted }) => {
    const s = humanReady();
    run(s, 1, press(bits & ~Btn.LOB)); // modifiers held first
    run(s, 1, press(bits));
    expect(calls()).toHaveLength(1);
    expect([calls()[0]!.fn, calls()[0]!.kind, calls()[0]!.flags & ReqFlag.LOFTED]).toEqual(['lob', kind, lofted]);
  });

  it('explicit frame power and curl: that power (not charging) and curve; the preview shows the curl', () => {
    const s = humanReady();
    run(s, 1, (_s, f) => { f[0]!.buttons = Btn.LOB; f[0]!.power = 100; f[0]!.curve = -64; });
    const c = calls()[0]!;
    expect(c.charging).toBe(0);
    expect(c.power).toBeCloseTo(100 / 127, 9);
    expect(c.curve).toBeCloseTo(-64 / 127, 9);
    expect(s.match.restart.aimCurve).toBeCloseTo(-64 / 127, 9);
  });

  it('PASS -> short corner: ground pass to the nearest outfield teammate (the short option); R1 -> driven', () => {
    K.accept = true;
    const s = humanReady();
    const r = s.match.restart;
    run(s, 1, press(Btn.PASS));
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.target, c.charging, c.hasTarget]).toEqual(['pass', KickKind.GROUND_PASS, 8, 1, 0]);
    expect(c.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
    const q = s.players[8]!;
    const d = Math.hypot(q.x - r.x, q.z - r.z);
    expect(d).toBeLessThan(10);
    expect(c.dirX).toBeCloseTo((q.x - r.x) / d, 9);
    expect(c.dirZ).toBeCloseTo((q.z - r.z) / d, 9);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    // R1 + PASS: driven
    const s2 = humanReady();
    run(s2, 1, press(Btn.MOD_R));
    run(s2, 1, press(Btn.MOD_R | Btn.PASS));
    expect([calls()[1]!.fn, calls()[1]!.kind, calls()[1]!.target]).toEqual(['pass', KickKind.DRIVEN_PASS, 8]);
  });

  it('PASS never picks the keeper while an outfield teammate is available', () => {
    const s = humanReady(1, (st) => { place(st, 0, HALF_LENGTH - 6, HALF_WIDTH - 4); }); // keeper wandered up, nearest
    run(s, 1, press(Btn.PASS));
    expect(calls()[0]!.target).toBe(8);
  });

  it('gesture TAP on a teammate in the box -> cross to him (receiver + point); DOUBLE_TAP -> lofted cross', () => {
    const s = humanReady();
    const q = s.players[4]!; // far post header
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 4; f[0]!.gx = 0; f[0]!.gz = 0; });
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.target, c.hasTarget, c.charging]).toEqual(['lob', KickKind.CROSS, 4, 1, 0]);
    expect([c.targetX, c.targetZ]).toEqual([q.x, q.z]);
    expect(c.flags & (ReqFlag.GESTURE | ReqFlag.SET_PIECE)).toBe(ReqFlag.GESTURE | ReqFlag.SET_PIECE);
    expect(c.power).toBeCloseTo(cornerCrossPower(Math.hypot(q.x - s.match.restart.x, q.z - s.match.restart.z)), 9);
    expect([s.match.restart.aimX, s.match.restart.aimZ]).toEqual([q.x, q.z]);
    const s2 = humanReady();
    run(s2, 1, (_s, f) => { f[0]!.gesture = GestureKind.DOUBLE_TAP; f[0]!.gSlot = 3; });
    expect([calls()[1]!.kind, calls()[1]!.target, calls()[1]!.flags & ReqFlag.LOFTED]).toEqual([KickKind.CROSS, 3, ReqFlag.LOFTED]);
  });

  it('gesture TAP on a teammate at the edge of the box (just outside the line) still crosses to him', () => {
    const s = humanReady();
    const q = s.players[6]!; // u = 16 inside; move him 2 m beyond the line
    const [x, z] = at(s, 0, 1, PENALTY_AREA_DEPTH + 2, 1);
    place(s, 6, x, z);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 6; });
    expect([calls()[0]!.kind, calls()[0]!.target, calls()[0]!.targetX, calls()[0]!.targetZ]).toEqual([KickKind.CROSS, 6, q.x, q.z]);
    // the reticle stays in the box
    expect(aimInBox(s, 0, s.match.restart.aimX, s.match.restart.aimZ)).toBe(true);
  });

  it('gesture TAP on a spot in the box -> cross to that spot; an opponent standing there does not change it', () => {
    const s = humanReady();
    const [x, z] = at(s, 0, 1, 7, -2);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 12; f[0]!.gx = Math.round(x * 10); f[0]!.gz = Math.round(z * 10); });
    const c = calls()[0]!;
    expect([c.kind, c.target, c.hasTarget]).toEqual([KickKind.CROSS, -1, 1]);
    expect(c.targetX).toBeCloseTo(Math.round(x * 10) / 10, 9);
    expect(c.targetZ).toBeCloseTo(Math.round(z * 10) / 10, 9);
  });

  it('gesture TAP on the short option -> ground pass to his feet; DOUBLE_TAP -> lofted pass', () => {
    const s = humanReady();
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 8; });
    expect([calls()[0]!.fn, calls()[0]!.kind, calls()[0]!.target]).toEqual(['pass', KickKind.GROUND_PASS, 8]);
    const s2 = humanReady();
    run(s2, 1, (_s, f) => { f[0]!.gesture = GestureKind.DOUBLE_TAP; f[0]!.gSlot = 8; });
    expect([calls()[1]!.fn, calls()[1]!.kind, calls()[1]!.target]).toEqual(['lob', KickKind.LOB_PASS, 8]);
  });

  it('gesture TAP far outside the box -> cross to the nearest point of the box; TAP on the taker / ball is ignored', () => {
    const s = humanReady();
    const r = s.match.restart;
    const [x, z] = at(s, 0, 1, 30, 0);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = r.taker; });
    expect(calls()).toHaveLength(0);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gx = Math.round(r.x * 10); f[0]!.gz = Math.round(r.z * 10); });
    expect(calls()).toHaveLength(0);
    run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gx = Math.round(x * 10); f[0]!.gz = Math.round(z * 10); });
    const c = calls()[0]!;
    expect([c.kind, c.hasTarget]).toEqual([KickKind.CROSS, 1]);
    expect(c.targetX).toBeCloseTo(HALF_LENGTH - (PENALTY_AREA_DEPTH - LOCAL_TUNING.aimBoxMargin), 9);
    expect(c.targetZ).toBeCloseTo(0, 9);
  });

  it('swipe from the ball: lands on the swipe line where it passes the reticle; speed sets the height band, curve the curl', () => {
    const bands = [
      { gPower: 10, kind: KickKind.GROUND_CROSS, lofted: 0 },
      { gPower: 40, kind: KickKind.LOW_CROSS, lofted: 0 },
      { gPower: 80, kind: KickKind.CROSS, lofted: 0 },
      { gPower: 120, kind: KickKind.CROSS, lofted: ReqFlag.LOFTED },
    ];
    for (const b of bands) {
      calls().length = 0;
      const s = humanReady();
      const r = s.match.restart;
      // swipe toward a point at the near post area
      const [tx, tz] = at(s, 0, 1, 6, 2);
      const dx = tx - r.x, dz = tz - r.z, d = Math.hypot(dx, dz);
      run(s, 1, (_s, f) => {
        Object.assign(f[0]!, {
          gesture: GestureKind.CURVED_SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: Math.round((dx / d) * 127),
          gdz: Math.round((dz / d) * 127), gPower: b.gPower, gCurve: 50, gx: Math.round(r.x * 10), gz: Math.round(r.z * 10),
        });
      });
      expect(calls()).toHaveLength(1);
      const c = calls()[0]!;
      expect([c.fn, c.kind, c.flags & ReqFlag.LOFTED, c.hasTarget, c.charging]).toEqual(['lob', b.kind, b.lofted, 1, 0]);
      expect(c.power).toBeCloseTo(b.gPower / 127, 9);
      expect(c.curve).toBeCloseTo(50 / 127, 9);
      // the landing lies on the swipe line, inside the box
      const ux = Math.round((dx / d) * 127), uz = Math.round((dz / d) * 127);
      const cross = (c.targetX - r.x) * uz - (c.targetZ - r.z) * ux;
      expect(Math.abs(cross) / Math.hypot(ux, uz)).toBeLessThan(1e-6);
      expect(aimInBox(s, 0, c.targetX, c.targetZ)).toBe(true);
      expect([r.aimX, r.aimZ]).toEqual([c.targetX, c.targetZ]);
      expect(r.aimCurve).toBeCloseTo(50 / 127, 9);
    }
  });

  it('swipe landing: the swipe line point nearest the reticle (inside the box); a swipe ending in the box lands there', () => {
    const s = humanReady();
    const r = s.match.restart;
    // a straight line from the ball through the box: landing = projection of the reticle onto it
    const ux = -0.3, uz = -0.954;
    const n = Math.hypot(ux, uz);
    run(s, 1, (_s, f) => {
      Object.assign(f[0]!, { gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: Math.round(ux / n * 127), gdz: Math.round(uz / n * 127), gPower: 80 });
    });
    const c = calls()[0]!;
    // unit swipe direction as quantised in the frame; the reticle was on the penalty-spot zone (team 0, side +1)
    const gx = Math.round(ux / n * 127), gz = Math.round(uz / n * 127), gl = Math.hypot(gx, gz);
    const retX = HALF_LENGTH - LOCAL_TUNING.zoneDepth[0]!, retZ = LOCAL_TUNING.zoneSide[0]!;
    const t = (retX - r.x) * (gx / gl) + (retZ - r.z) * (gz / gl);
    expect(c.targetX).toBeCloseTo(r.x + (gx / gl) * t, 6);
    expect(c.targetZ).toBeCloseTo(r.z + (gz / gl) * t, 6);
    expect(aimInBox(s, 0, c.targetX, c.targetZ)).toBe(true);
    // a swipe whose end point (gx, gz) is in the box lands on it
    const s2 = humanReady();
    const [ex, ez] = at(s2, 0, 1, 8, -6);
    run(s2, 1, (_s, f) => {
      Object.assign(f[0]!, { gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: -40, gdz: -120, gPower: 80, gx: Math.round(ex * 10), gz: Math.round(ez * 10) });
    });
    expect(calls()[1]!.targetX).toBeCloseTo(Math.round(ex * 10) / 10, 9);
    expect(calls()[1]!.targetZ).toBeCloseTo(Math.round(ez * 10) / 10, 9);
  });

  it('a swipe not from the ball, or away from the box, is ignored', () => {
    const s = humanReady();
    run(s, 1, (_s, f) => { Object.assign(f[0]!, { gesture: GestureKind.SWIPE, gFlags: 0, gdx: -40, gdz: -120, gPower: 80 }); });
    run(s, 1, (_s, f) => { Object.assign(f[0]!, { gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: 60, gdz: 110, gPower: 80 }); });
    run(s, 1, (_s, f) => { Object.assign(f[0]!, { gesture: GestureKind.BACK_FORTH_SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: -40, gdz: -120, gPower: 80 }); });
    expect(calls()).toHaveLength(0);
    expect(s.match.restart.taken).toBe(0);
  });

  it('corner-tactic command (D-pad): the reticle jumps to the zone of the applied tactic', () => {
    const s = humanReady();
    const r = s.match.restart;
    const out = { x: 0, z: 0 };
    for (const cmd of [Command.CORNER_FAR_POST, Command.CORNER_EDGE_OF_BOX, Command.CORNER_CROWD_KEEPER, Command.CORNER_NEAR_POST]) {
      run(s, 1, (_s, f) => { f[0]!.cmd = cmd; });
      expect(s.teams[0]!.cornerTactic).toBe(cmd); // TAI-14 (mocked) applied it
      cornerZone(s, 0, 1, cmd, out);
      expect([r.aimX, r.aimZ]).toEqual([out.x, out.z]);
      expect(aimInBox(s, 0, r.aimX, r.aimZ)).toBe(true);
    }
    // a command whose tactic ended up off (toggled by TAI-14) shows the penalty-spot area
    s.teams[0]!.cornerTactic = 0;
    const f = createInputFrame();
    f.cmd = Command.CORNER_NEAR_POST;
    cornerInput(s, 0, f, EV);
    cornerZone(s, 0, 1, 0, out);
    expect([r.aimX, r.aimZ]).toEqual([out.x, out.z]);
  });

  it('the defending human moves his player with the stick (kept 9.15 m away by RUL-11); he cannot take the corner', () => {
    const s = humanReady(1, undefined, {}, { humans: [{ side: 0 }, { side: 1, autoSwitch: AutoSwitch.OFF }] });
    const r = s.match.restart;
    const d = s.ctrl[1]!.slot;
    expect(d).toBeGreaterThanOrEqual(11);
    const p0 = { x: s.players[d]!.x, z: s.players[d]!.z };
    run(s, 60, (_s, f) => { f[1]!.mx = -127; f[1]!.buttons = Btn.LOB; });
    const p = s.players[d]!;
    expect(p.x - p0.x).toBeLessThan(-2); // he ran along -x as steered
    expect(calls()).toHaveLength(0);
    expect(r.taken).toBe(0);
    expect(closeOpponents(s, 0.35)).toEqual([]);
  });

  it('inputs before ready, and while the taker is already kicking, are ignored', () => {
    const s = cornerState(0, { humans: 1 }, (st) => layoutCorner(st, 0, 1));
    run(s, SETUP - 2, press(Btn.LOB));
    expect(calls()).toHaveLength(0);
    toReady(s);
    run(s, 1);
    const tk = s.players[s.match.restart.taker]!;
    tk.act = ActionKind.KICK; tk.actT = 1; tk.actDur = 60; tk.actCharging = 1;
    const ax = s.match.restart.aimX;
    const f = createInputFrame();
    f.buttons = Btn.LOB; f.mx = 127;
    cornerInput(s, 0, f, EV);
    expect(calls()).toHaveLength(0);
    expect(s.match.restart.aimX).toBe(ax);
  });
});

// ---------------------------------------------------------------- the cross lands near the aim

describe('RUL-04 cross lands near the aim (real ball flight to the requested target)', () => {
  const aims: { name: string; sd: number; swap: boolean; mx: number; mz: number; ticks: number }[] = [
    { name: 'penalty spot', sd: 1, swap: false, mx: 0, mz: 0, ticks: 0 },
    { name: 'far post', sd: 1, swap: false, mx: 0, mz: -127, ticks: 25 },
    { name: 'near post (other side, second half)', sd: -1, swap: true, mx: 127, mz: -127, ticks: 25 },
    { name: 'edge of the box', sd: -1, swap: false, mx: -127, mz: 30, ticks: 20 },
  ];
  it.each(aims)('$name', ({ sd, swap, mx, mz, ticks }) => {
    K.accept = true;
    const s = humanReady(sd, undefined, {}, { swap });
    const r = s.match.restart;
    if (ticks > 0) run(s, ticks, (_s, f) => { f[0]!.mx = mx; f[0]!.mz = mz; });
    const ax = r.aimX, az = r.aimZ;
    expect(aimInBox(s, 0, ax, az)).toBe(true);
    const kick = run(s, 1, press(Btn.LOB));
    expect(ofType(kick, EventType.KICK)).toHaveLength(1);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ball.y).toBeGreaterThan(BALL_RADIUS); // in the air
    // The first ground contact after the kick (the first BOUNCE) is the landing.
    const flight = run(s, 240, undefined, () => false);
    const land = flight.find((e) => e.type === EventType.BOUNCE);
    expect(land).toBeDefined();
    expect(Math.hypot(land!.x - ax, land!.z - az)).toBeLessThan(0.6);
    expect(inCornerBox(s, 0, land!.x, land!.z, 0.6)).toBe(true);
  });
});

// ---------------------------------------------------------------- Default: tactic zones, timeout, CPU fallback

describe('RUL-04 Default: cross to the tactic zone (tactics bias)', () => {
  it('the Default target follows team.cornerTactic: a header in each tactic zone, the zone point when nobody is there', () => {
    const out = { x: 0, z: 0 };
    const choice = createCornerChoice();
    const targets: number[] = [];
    for (const tactic of [0, Command.CORNER_FAR_POST, Command.CORNER_EDGE_OF_BOX, Command.CORNER_CROWD_KEEPER, Command.CORNER_NEAR_POST]) {
      const s = cornerState(0, {}, (st) => {
        layoutCorner(st, 0, 1);
        for (const i of [3, 4, 5, 6, 7]) { st.attrs[i]!.heading = 70; st.attrs[i]!.height = 185; }
        st.teams[0]!.cornerTactic = tactic;
      });
      toReady(s);
      expect(chooseCornerCross(s, choice)).toBe(1);
      cornerZone(s, 0, 1, tactic, out);
      expect(choice.kind).toBe(KickKind.CROSS);
      expect(choice.target).toBeGreaterThanOrEqual(1);
      expect(Math.hypot(choice.x - out.x, choice.z - out.z), `tactic ${tactic}`).toBeLessThanOrEqual(LOCAL_TUNING.zoneRadius);
      targets.push(choice.target);
      // nobody near the zone: the zone point itself
      for (let i = 1; i <= 9; i++) place(s, i, -20 + i * 2, -10);
      chooseCornerCross(s, choice);
      expect([choice.target, choice.x, choice.z]).toEqual([-1, out.x, out.z]);
      expect(choice.power).toBeCloseTo(cornerCrossPower(Math.hypot(out.x - s.match.restart.x, out.z - s.match.restart.z)), 9);
    }
    // each tactic aims at a different player of the layout
    expect(new Set(targets).size).toBe(5);
    expect(targets).toEqual([3, 4, 6, 7, 5]);
  });

  it('within the zone the better header wins (heading + height + openness)', () => {
    const s = cornerState(0, {}, (st) => {
      layoutCorner(st, 0, 1);
      const [x, z] = at(st, 0, 1, 11, -2);
      place(st, 9, x, z);
      st.attrs[9]!.heading = 95; st.attrs[9]!.height = 194;
      st.attrs[3]!.heading = 60; st.attrs[3]!.height = 178;
    });
    toReady(s);
    const choice = createCornerChoice();
    chooseCornerCross(s, choice);
    expect(choice.target).toBe(9);
  });

  it('cornerTacticIndex / cornerZone: zones are inside the box, mirrored to the corner side and the attacked end', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    expect([0, 11, 12, 13, 14, 5].map(cornerTacticIndex)).toEqual([0, 1, 2, 3, 4, 0]);
    const out = { x: 0, z: 0 };
    for (const team of [0, 1]) {
      for (const sd of [1, -1]) {
        for (let cmd = 10; cmd <= 14; cmd++) {
          cornerZone(s, team, sd, cmd, out);
          expect(inCornerBox(s, team, out.x, out.z, 0), `team ${team} side ${sd} cmd ${cmd}`).toBe(true);
          expect(aimInBox(s, team, out.x, out.z)).toBe(true);
        }
        cornerZone(s, team, sd, Command.CORNER_FAR_POST, out);
        expect(Math.sign(out.z)).toBe(-sd); // far post: the other side of the goal
        cornerZone(s, team, sd, Command.CORNER_NEAR_POST, out);
        expect(Math.sign(out.z)).toBe(sd);
      }
    }
  });

  it('clampToCornerBox: any point (non-finite too) ends inside the box', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    const out = { x: 0, z: 0 };
    for (const team of [0, 1]) {
      for (const [x, z] of [[0, 0], [60, 40], [-60, -40], [52.5, 0], [40, 30], [Number.NaN, 5], [Infinity, -Infinity]] as [number, number][]) {
        clampToCornerBox(s, team, x, z, out);
        expect(Number.isFinite(out.x) && Number.isFinite(out.z)).toBe(true);
        expect(aimInBox(s, team, out.x, out.z), `team ${team} (${x}, ${z})`).toBe(true);
      }
    }
  });
});

describe('RUL-04 timeout default and CPU fallback', () => {
  it('human who never acts: the Default crosses to the tactic zone restartTimeoutTicks after ready, no watchdog', () => {
    K.accept = true;
    const s = cornerState(0, { humans: 1 }, (st) => {
      layoutCorner(st, 0, 1);
      st.attrs[3]!.heading = 99; st.attrs[3]!.height = 199; // a better header at the penalty spot: outside the far-post zone
      st.teams[0]!.cornerTactic = Command.CORNER_FAR_POST;
    });
    toReady(s);
    const readyTick = s.tick;
    const ev = run(s, T_RULES.restartTimeoutTicks + 10, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect(c.tick - readyTick).toBeGreaterThanOrEqual(T_RULES.restartTimeoutTicks - 1);
    expect(c.tick - readyTick).toBeLessThanOrEqual(T_RULES.restartTimeoutTicks + 1);
    expect([c.fn, c.kind, c.target, c.hasTarget, c.flags]).toEqual(['lob', KickKind.CROSS, 4, 1, ReqFlag.SET_PIECE]);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
  });

  it('CPU side: takes it cpuRestartDelay + cpuGraceTicks after ready when its brain did not, no watchdog', () => {
    K.accept = true;
    for (const team of [0, 1]) {
      calls().length = 0;
      const s = cornerState(team, { humans: 0 }, (st) => layoutCorner(st, team, -1));
      const ev = run(s, 400, undefined, (st) => st.match.phase === MatchPhase.IN_PLAY);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]!.rt - SETUP).toBe(T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks);
      expect(calls()[0]!.kind).toBe(KickKind.CROSS);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
    }
  });

  it('CPU fallback retries every cpuRetryTicks while the start is refused (RUL-11 safety nets stay behind it)', () => {
    const s = cornerState(0, { humans: 0 }, (st) => layoutCorner(st, 0, 1));
    // [QF-10] cpuGraceTicks 60 -> 140 (TAI-13 may wait for its box runners): the fallback and its first retry come
    // before RUL-11's 4 s CPU timeout (cpuTakeTimeoutTicks past ready), which then backs it up.
    const due = SETUP + T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks;
    const rul11 = SETUP + RESTART_TUNING.cpuTakeTimeoutTicks;
    expect(due + LOCAL_TUNING.cpuRetryTicks).toBeLessThan(rul11);
    run(s, rul11 - 1);
    expect(calls().map((c) => c.rt)).toEqual([0, 1].map((k) => due + k * LOCAL_TUNING.cpuRetryTicks));
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(s.players[s.match.restart.taker]!.act).toBe(ActionKind.SET_PIECE); // RUL-11 put him back to wait
  });

  it('a CPU brain frame (TAP on the best header) takes it before the fallback; a human side never gets the fallback', () => {
    K.accept = true;
    const s = cornerState(1, { humans: 0 }, (st) => layoutCorner(st, 1, 1));
    toReady(s);
    // the CPU brain for team 1 (controller 3) taps slot 14 (11 + 3, at the penalty spot)
    s.teams[1]!.cpu.out.gesture = GestureKind.TAP;
    s.teams[1]!.cpu.out.gSlot = 14;
    run(s, 2);
    expect(calls()).toHaveLength(1);
    expect([calls()[0]!.kind, calls()[0]!.target, calls()[0]!.flags & ReqFlag.CPU]).toEqual([KickKind.CROSS, 14, ReqFlag.CPU]);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    calls().length = 0;
    const h = cornerState(0, { humans: 1 }, (st) => layoutCorner(st, 0, 1));
    run(h, SETUP + 400);
    expect(calls()).toHaveLength(0);
  });

  it('cornerDefault leaves a taker who is already kicking alone (no double kick)', () => {
    const s = humanReady();
    const tk = s.players[s.match.restart.taker]!;
    tk.act = ActionKind.KICK; tk.actT = 1; tk.actDur = 60;
    cornerDefault(s, EV);
    expect(calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- offside, ball safety, determinism

describe('RUL-04 regressions', () => {
  it('glitch: offside given from a corner -- the kick is struck while the phase is CORNER (RUL-08 checks it)', () => {
    K.accept = true;
    const s = humanReady(1, (st) => {
      // attackers level with the goal line beyond every defender but the keeper
      const [x, z] = at(st, 0, 1, 0.7, -2);
      place(st, 7, x, z);
    });
    const ev = run(s, 1, (_s, f) => { f[0]!.gesture = GestureKind.TAP; f[0]!.gSlot = 7; });
    expect(K.kickPhases).toEqual([MatchPhase.CORNER]);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.match.offside.flags).toBe(0);
    const later = run(s, 120);
    expect(ofType([...ev, ...later], EventType.OFFSIDE)).toHaveLength(0);
  });

  it('glitch: ball out of play during a restart -- a corner ball knocked away or out goes back on the spot', () => {
    const s = humanReady();
    const r = s.match.restart;
    s.ball.x = HALF_LENGTH + 1; s.ball.z = 20; s.ball.vx = 3; // over the goal line
    run(s, 1);
    expect([s.ball.x, s.ball.z, s.ball.vx]).toEqual([r.x, r.z, 0]);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    s.ball.owner = 15; // an opponent got it
    run(s, 1);
    expect([s.ball.owner, s.ball.x, s.ball.z]).toEqual([-1, r.x, r.z]);
  });

  it('glitch: opponents inside the required distance blocking forever -- a defender pushing at the ball stays 9.15 m away', () => {
    K.accept = true;
    const s = humanReady(1, undefined, {}, { humans: [{ side: 0 }, { side: 1, autoSwitch: AutoSwitch.OFF }] });
    const r = s.match.restart;
    const d = s.ctrl[1]!.slot;
    const intruder = d === 19 ? 18 : 19;
    // both start 15-19 m from the ball on the corner's side
    const [hx, hz] = at(s, 0, 1, 15, 21);
    place(s, d, hx, hz);
    const [ix, iz] = at(s, 0, 1, 11, 24);
    place(s, intruder, ix, iz);
    const push: Inputs = (st, f) => {
      const p = st.players[d]!;
      const dx = r.x - p.x, dz = r.z - p.z, dd = Math.hypot(dx, dz);
      f[1]!.mx = Math.round((dx / dd) * 127); f[1]!.mz = Math.round((dz / dd) * 127); f[1]!.buttons = Btn.SPRINT;
      const q = st.players[intruder]!;
      q.moveMode = MoveMode.ARRIVE; q.tgtX = r.x; q.tgtZ = r.z; q.tgtSpeed = 8; q.wantSprint = 1;
    };
    const bad: string[] = [];
    run(s, 300, push, (st) => { bad.push(...closeOpponents(st, 0.35).map((m) => `t=${st.tick} ${m}`)); return false; });
    expect(bad).toEqual([]);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    for (const i of [d, intruder]) {
      const p = s.players[i]!;
      expect(Math.hypot(p.x - r.x, p.z - r.z), `slot ${i} at the 9.15 m line`).toBeLessThan(RESTART_DISTANCE + 1);
    }
    // the corner is taken: play goes on
    run(s, 1, (st, f) => { push(st, f); f[0]!.buttons = Btn.LOB; });
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('glitch: two restarts queued -- another award during an untaken corner is refused', () => {
    const s = humanReady();
    const before = JSON.stringify(s.match.restart);
    EV.begin(s.tick);
    awardRestart(s, RestartKind.FREE_KICK, 1, 10, 0, EV);
    awardRestart(s, RestartKind.CORNER, 1, -HALF_LENGTH, HALF_WIDTH, EV);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(JSON.stringify(s.match.restart)).toBe(before);
  });

  it('the waiting taker lines up behind the ball along the aim and never cuts through it', () => {
    const s = humanReady();
    const r = s.match.restart;
    let minD = 1e9;
    run(s, 60, (st, f) => {
      f[0]!.mz = -127;
      const tk = st.players[st.match.restart.taker]!;
      minD = Math.min(minD, Math.hypot(tk.x - r.x, tk.z - r.z));
    });
    run(s, 40);
    expect(minD).toBeGreaterThanOrEqual(RESTART_TUNING.takerBehind - 1e-9);
    const tk = s.players[r.taker]!;
    const d = Math.hypot(r.aimX - r.x, r.aimZ - r.z);
    expect(tk.x).toBeCloseTo(r.x - ((r.aimX - r.x) / d) * RESTART_TUNING.takerBehind, 3);
    expect(tk.z).toBeCloseTo(r.z - ((r.aimZ - r.z) / d) * RESTART_TUNING.takerBehind, 3);
    expect(tk.act).toBe(ActionKind.SET_PIECE);
  });

  it('power bar: restart.aimPower mirrors a charging kick', () => {
    const s = humanReady();
    const tk = s.players[s.match.restart.taker]!;
    tk.act = ActionKind.KICK; tk.actT = 1; tk.actDur = 60; tk.actCharging = 1; tk.actPower = 0.4;
    cornerTick(s, EV);
    expect(s.match.restart.aimPower).toBeCloseTo(0.4, 9);
  });

  it('a corner phase adopted without its Setup (aim on the ball) gets its reticle back in the box', () => {
    const s = humanReady();
    const r = s.match.restart;
    r.aimX = r.x; r.aimZ = r.z;
    cornerTick(s, EV);
    expect(aimInBox(s, 0, r.aimX, r.aimZ)).toBe(true);
    const out = { x: 0, z: 0 };
    cornerZone(s, 0, 1, 0, out);
    expect([r.aimX, r.aimZ]).toEqual([out.x, out.z]);
  });

  it('deterministic: the same seed and inputs give the same state hash', () => {
    const go = () => {
      K.accept = true;
      K.calls.length = 0;
      const s = humanReady(-1, undefined, { }, { humans: 2, seed: 99 });
      run(s, 20, (_s, f) => { f[0]!.mx = 40; f[0]!.az = -100; f[1]!.mx = -127; });
      run(s, 1, press(Btn.LOB));
      run(s, 60);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });

  it('every corner state stays finite with hostile frames', () => {
    const s = humanReady(1, undefined, {}, { humans: 2 });
    const f = createInputFrame();
    Object.assign(f, { mx: Number.NaN, mz: 1e9, ax: -1e9, az: Number.NaN, gesture: GestureKind.TAP, gSlot: 999, gx: Number.POSITIVE_INFINITY, gz: -1e12 });
    for (const c of [0, 1, 2, 3]) cornerInput(s, c, f, EV);
    Object.assign(f, { gSlot: -1, gx: Number.NaN });
    cornerInput(s, 0, f, EV);
    Object.assign(f, { gesture: GestureKind.SWIPE, gFlags: GestureFlag.FROM_BALL, gdx: Number.NaN, gdz: 1e9, gPower: Number.NaN, gCurve: Infinity });
    cornerInput(s, 0, f, EV);
    Object.assign(f, { gesture: GestureKind.NONE, buttons: Btn.LOB, power: Number.NaN, curve: Number.NaN });
    s.ctrl[0]!.prevButtons = 0; s.ctrl[0]!.buttons = Btn.LOB;
    cornerInput(s, 0, f, EV);
    cornerInput(s, -1, f, EV);
    cornerInput(s, 99, f, EV);
    const r = s.match.restart;
    for (const v of [r.aimX, r.aimZ, r.aimPower, r.aimCurve, r.x, r.z, s.ball.x, s.ball.z]) expect(Number.isFinite(v)).toBe(true);
    for (const c of calls()) {
      for (const v of [c.power, c.dirX, c.dirZ, c.targetX, c.targetZ, c.curve]) expect(Number.isFinite(v), JSON.stringify(c)).toBe(true);
    }
    expect(aimInBox(s, 0, r.aimX, r.aimZ)).toBe(true);
    for (const p of s.players) expect(Number.isFinite(p.ix) && Number.isFinite(p.iz)).toBe(true);
  });

  it('the line-up, inputs and Default do nothing outside a ready corner', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 1 });
    const before = hashState(s);
    cornerTick(s, EV);
    cornerDefault(s, EV);
    const f = createInputFrame();
    f.buttons = Btn.LOB; f.mx = 127; f.gesture = GestureKind.TAP; f.gSlot = 9;
    cornerInput(s, 0, f, EV);
    expect(hashState(s)).toBe(before);
    expect(calls()).toHaveLength(0);
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.HUMAN);
  });
});
