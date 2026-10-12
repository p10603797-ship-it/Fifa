/**
 * [FND-06] Scenario helpers for rules / sim tests: build a SimState from initMatch with overrides, step the real
 * pipeline, and collect events.
 *
 *   const s = makeScenario({
 *     phase: MatchPhase.IN_PLAY,
 *     ball: { x: 40, z: 2, vx: 20 },
 *     players: [{ slot: 9, x: 38, z: 2 }, { slot: 11, x: 50, z: 0 }],
 *     humans: [{ side: 0, slot: 9 }],
 *   });
 *   const ev = runTicks(s, 120, (tick, st, out) => { if (tick === 5) out[0]!.buttons = Btn.SHOOT; }, { check: 'core' });
 *   expect(findEvents(ev, EventType.GOAL)).toHaveLength(1);
 */
import { NUM_SLOTS } from '../../src/contracts/constants';
import type { Club } from '../../src/contracts/data';
import { AssistLevel, AutoSwitch, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import type { EventType, SimEvent } from '../../src/contracts/events';
import { clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import {
  createMatchConfig, type BallState, type ControllerConfig, type MatchConfig, type MatchState, type PlayerState, type SimState,
  type TeamState,
} from '../../src/contracts/state';
import { CLOCK_PHASES } from '../../src/contracts/transitions';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { createInvariantChecker, type InvariantChecker } from '../../src/sim/debug/invariants';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

/** Same shape as tools/headless InputsFn: fill `out` (cleared) for the coming tick. */
export type ScenarioInputs = (tick: number, state: SimState, out: InputFrame[]) => void;

export interface ScenarioHuman {
  side: number;
  /** Controlled player slot (sets ctrl.slot and player.ctrl). */
  slot?: number;
  assist?: AssistLevel;
  autoSwitch?: AutoSwitch;
  fastPower?: number;
}

export type ScenarioPlayer = { slot: number } & Partial<Omit<PlayerState, 'slot'>>;

export interface ScenarioOptions {
  /** Config overrides on top of createMatchConfig() (humans come from `humans`). */
  config?: Partial<MatchConfig>;
  seed?: number;
  /** Phase to start in (PRE_MATCH = the initMatch default). The clock runs if the phase is a clock phase. */
  phase?: MatchPhase;
  /** Ball overrides; when x/y/z are given and px/py/pz are not, the previous position is set to match. */
  ball?: Partial<BallState>;
  /** Per-player overrides by slot. */
  players?: ScenarioPlayer[];
  /** Per-team overrides (index 0 = home, 1 = away). */
  teams?: (Partial<TeamState> | undefined)[];
  /** Match overrides (period, periodT, kickoffTeam, ...). Nested objects (restart, ...) are merged one level. */
  match?: Partial<MatchState>;
  /**
   * Human controllers: a count (0 = bot v bot, 1 = P1 home, 2 = P1 home + P2 away) or explicit list. Default 0.
   */
  humans?: number | ScenarioHuman[];
  clubs?: readonly Club[];
}

function humanConfig(h: ScenarioHuman): ControllerConfig {
  return {
    kind: ControllerKind.HUMAN, side: h.side, assist: h.assist ?? AssistLevel.ASSISTED,
    autoSwitch: h.autoSwitch ?? AutoSwitch.AIR_AND_LOOSE, fastPower: h.fastPower ?? 0,
  };
}

function noHuman(): ControllerConfig {
  return { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 };
}

function humansList(h: ScenarioOptions['humans']): ScenarioHuman[] {
  if (h === undefined) return [];
  if (typeof h === 'number') return h <= 0 ? [] : h === 1 ? [{ side: 0 }] : [{ side: 0 }, { side: 1 }];
  return h;
}

/** Assign own enumerable fields of `src` onto `dst` (one level; nested plain objects merge one level deeper). */
function assignInto(dst: object, src: object): void {
  const d = dst as Record<string, unknown>;
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue;
    const cur = d[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && cur !== null && typeof cur === 'object' && !Array.isArray(cur)) {
      Object.assign(cur, v);
    } else d[k] = v;
  }
}

/** A match config with the given humans (and overrides). */
export function scenarioConfig(opts: ScenarioOptions = {}): MatchConfig {
  const c = createMatchConfig();
  if (opts.config) Object.assign(c, opts.config);
  if (opts.seed !== undefined) c.seed = opts.seed >>> 0;
  const hs = humansList(opts.humans);
  c.humans = [hs[0] ? humanConfig(hs[0]) : noHuman(), hs[1] ? humanConfig(hs[1]) : noHuman()];
  return c;
}

/** Build a SimState from initMatch with the requested overrides applied. */
export function makeScenario(opts: ScenarioOptions = {}): SimState {
  const config = scenarioConfig(opts);
  const s = initMatch(config, opts.clubs);
  const m = s.match;
  if (opts.phase !== undefined) {
    m.phase = opts.phase;
    m.prevPhase = opts.phase;
    m.phaseT = 0;
    m.clockRunning = CLOCK_PHASES.includes(opts.phase) ? 1 : 0;
  }
  if (opts.match) assignInto(m, opts.match);
  if (opts.ball) {
    const b = opts.ball;
    assignInto(s.ball, b);
    if (b.px === undefined && b.x !== undefined) s.ball.px = b.x;
    if (b.py === undefined && b.y !== undefined) s.ball.py = b.y;
    if (b.pz === undefined && b.z !== undefined) s.ball.pz = b.z;
    if (b.y !== undefined && b.grounded === undefined) s.ball.grounded = b.y <= 0.12 && (b.vy ?? 0) === 0 ? 1 : 0;
  }
  if (opts.teams) {
    for (let t = 0; t < 2; t++) {
      const o = opts.teams[t];
      if (o) assignInto(s.teams[t]!, o);
    }
  }
  for (const p of opts.players ?? []) {
    if (p.slot < 0 || p.slot >= NUM_SLOTS) throw new RangeError(`makeScenario: bad slot ${p.slot}`);
    const { slot, ...rest } = p;
    assignInto(s.players[slot]!, rest);
  }
  const hs = humansList(opts.humans);
  for (let h = 0; h < hs.length && h < 2; h++) {
    const slot = hs[h]!.slot;
    if (slot === undefined) continue;
    const c = s.ctrl[h]!;
    if (c.slot >= 0 && s.players[c.slot]!.ctrl === h) s.players[c.slot]!.ctrl = -1;
    c.slot = slot;
    s.players[slot]!.ctrl = h;
  }
  return s;
}

export interface RunTicksOptions {
  /** Run the invariant checker every tick and throw on the first failing tick. */
  check?: 'none' | 'core' | 'all';
  /** Stop early when this returns true (checked after each tick). */
  until?: (s: SimState, tickEvents: readonly SimEvent[]) => boolean;
  /** Event buffer to use (default a fresh one). */
  events?: EventBufferImpl;
}

/** Copy of an event (the buffer is reused every tick). */
function copyEvent(e: Readonly<SimEvent>): SimEvent {
  return { type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z };
}

/**
 * Step the real pipeline up to n ticks. `inputs` fills the human frames (cleared before each tick). Returns every
 * event emitted, in order. With `check`, throws an Error listing the failures of the first failing tick.
 */
export function runTicks(s: SimState, n: number, inputs?: ScenarioInputs, opts: RunTicksOptions = {}): SimEvent[] {
  const events = opts.events ?? createEventBuffer();
  const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
  const all: SimEvent[] = [];
  const tickEvents: SimEvent[] = [];
  const checker: InvariantChecker | null = opts.check && opts.check !== 'none' ? createInvariantChecker(opts.check) : null;
  for (let i = 0; i < n; i++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    if (inputs) inputs(s.tick + 1, s, frames);
    step(s, frames, events);
    tickEvents.length = 0;
    for (let k = 0; k < events.count; k++) {
      const e = copyEvent(events.get(k));
      all.push(e);
      tickEvents.push(e);
    }
    if (checker) {
      const fails = checker.check(s, events);
      if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    }
    if (opts.until && opts.until(s, tickEvents)) break;
  }
  return all;
}

/** Run until `pred` holds (checked after each tick) or maxTicks; returns the events and whether pred held. */
export function runUntil(
  s: SimState, pred: (s: SimState, tickEvents: readonly SimEvent[]) => boolean, maxTicks: number, inputs?: ScenarioInputs,
  check: RunTicksOptions['check'] = 'none',
): { events: SimEvent[]; reached: boolean } {
  let reached = false;
  const events = runTicks(s, maxTicks, inputs, { check, until: (st, ev) => (reached = pred(st, ev)) });
  return { events, reached };
}

/** Events of one type (optionally filtered further). */
export function findEvents(events: readonly SimEvent[], type: EventType, filter?: (e: SimEvent) => boolean): SimEvent[] {
  return events.filter((e) => e.type === type && (!filter || filter(e)));
}

/** An InputFrame with the given fields set. */
export function frame(fields: Partial<InputFrame> = {}): InputFrame {
  return Object.assign(createInputFrame(), fields);
}
