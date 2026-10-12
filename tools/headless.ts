/**
 * [FND-06] Headless match runner: initMatch + step until POST_MATCH or maxTicks, with optional input script,
 * invariant checking every tick, replay recording, match statistics and timing. Used by soak, fuzz, scenario
 * tests and QA agents. Never throws for sim errors: an exception ends the run and is returned in `exception`.
 *
 *   const r = runMatch({ config, checker: 'all', fastCutscenes: true });
 *   r.hash, r.stats.goals, r.invariantFailures.count, r.watchdogs, r.exception
 */
import './lib/env';
import { NUM_SLOTS, PLAYERS_PER_TEAM } from '../src/contracts/constants';
import type { Club } from '../src/contracts/data';
import {
  CardKind, ChallengeOutcome, Command, KickKind, MatchPhase, ModeId, Period, RestartKind, WatchdogReason,
} from '../src/contracts/enums';
import { EventType, type EventBuffer } from '../src/contracts/events';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../src/contracts/input';
import { createSimState, type MatchConfig, type SimState } from '../src/contracts/state';
import { CUTSCENE_PHASES } from '../src/contracts/transitions';
import { createEventBuffer } from '../src/sim/core/events';
import { hashState } from '../src/sim/core/hash';
import {
  createInvariantChecker, INVARIANT_NAMES, type InvariantChecker, type InvariantName,
} from '../src/sim/debug/invariants';
import { initMatch, periodLength } from '../src/sim/init';
import { createReplayRecorder, type Replay } from '../src/sim/replay';
import { step } from '../src/sim/step';

export type CheckerMode = 'none' | 'core' | 'all';

/** Fill `out` (one frame per human, already cleared) for the coming tick. */
export type InputsFn = (tick: number, state: SimState, out: InputFrame[]) => void;

export interface RunMatchOptions {
  config: MatchConfig;
  /** Human input script; called before every tick with neutral frames to fill. */
  inputs?: InputsFn;
  /** Tick limit (default defaultMaxTicks(config)). */
  maxTicks?: number;
  /** Invariant set checked every tick (default 'core'). */
  checker?: CheckerMode;
  /** Feed Btn.SKIP edges + Command.SKIP during cut-scene phases (bot-v-bot soak). */
  fastCutscenes?: boolean;
  /** Record a replay (returned in `replay`). */
  record?: boolean;
  clubs?: readonly Club[];
  /** Invariant failure messages kept (default 20); all failures are still counted. */
  messageLimit?: number;
  /** Called after every tick (after the checker); return true to stop the run. */
  onTick?: (s: SimState, events: EventBuffer) => boolean | void;
}

/** Per-team pairs: index 0 = home (team 0), 1 = away (team 1). */
export interface MatchStats {
  goals: [number, number];
  shots: [number, number];
  shotsOnTarget: [number, number];
  /** KICK events of a pass kind (isPassStatKind). */
  passes: [number, number];
  /** PASS_COMPLETE events whose passer's last kick was a pass kind. */
  passesCompleted: [number, number];
  /** IN_PLAY ticks in possession (loose ball counts for the last team in possession). */
  possessionTicks: [number, number];
  /** Share of possessionTicks, 0..100 (0 when nobody had the ball). */
  possessionPct: [number, number];
  /** FOUL events with an outcome other than CLEAN, by offending team. */
  fouls: [number, number];
  yellows: [number, number];
  reds: [number, number];
  offsides: [number, number];
  saves: [number, number];
  corners: [number, number];
  tackles: [number, number];
  tacklesWon: [number, number];
  interceptions: [number, number];
}

export interface InvariantReport {
  /** First messageLimit messages. */
  first: string[];
  count: number;
  byName: Record<InvariantName, number>;
}

export interface RunException {
  message: string;
  stack: string;
  tick: number;
  /** Where it was thrown: 'init' | 'inputs' | 'step' | 'record' | 'checker' | 'onTick' | 'hash'. */
  where: string;
}

export interface RunMatchResult {
  state: SimState;
  hash: number;
  /** Ticks run (steps taken; equals the final s.tick for a sim that advances its tick by one per step). */
  ticks: number;
  /** True if the match reached POST_MATCH. */
  finished: boolean;
  /** Phase at the end of the run. */
  endPhase: MatchPhase;
  /** Event counts by EventType name (unknown types under UNKNOWN). */
  events: Record<string, number>;
  /** Events dropped because a tick overflowed the buffer. */
  eventsDropped: number;
  stats: MatchStats;
  invariantFailures: InvariantReport;
  /** WATCHDOG events (forced restarts). */
  watchdogs: number;
  watchdogReasons: Record<string, number>;
  exception?: RunException;
  replay?: Replay;
  perf: { wallMs: number; simMsAvg: number; simMsMax: number; checkMsAvg: number };
}

/** Kick kinds counted as pass attempts for the pass-completion statistic. */
export function isPassStatKind(k: number): boolean {
  return (k >= KickKind.GROUND_PASS && k <= KickKind.THROUGH_DINKED) || k === KickKind.HEADER_PASS || k === KickKind.VOLLEY_PASS;
}

/** Ticks of grace on top of +30% for pre-match, breaks and the final whistle. */
const CUTSCENE_ALLOWANCE_TICKS = 3600;
/** Shoot-out allowance (up to ~14 kicks of ~12 s). */
const SHOOTOUT_ALLOWANCE_TICKS = 14 * 12 * 60;
/** Practice modes have no clock: run this long by default. */
const PRACTICE_TICKS = 3 * 60 * 60;

/** Default tick limit: regulation (+ extra time and shoot-out for cup rules) + 30% + cut-scene allowance. */
export function defaultMaxTicks(config: MatchConfig): number {
  if (config.mode === ModeId.PRACTICE) return PRACTICE_TICKS;
  if (config.startPhase === MatchPhase.SHOOT_OUT) return Math.ceil(SHOOTOUT_ALLOWANCE_TICKS * 1.3) + CUTSCENE_ALLOWANCE_TICKS;
  let reg = 2 * periodLength(config, Period.FIRST_HALF);
  if (config.cupRules) reg += 2 * periodLength(config, Period.ET_FIRST) + SHOOTOUT_ALLOWANCE_TICKS;
  return Math.ceil(reg * 1.3) + CUTSCENE_ALLOWANCE_TICKS;
}

function enumNames(e: Record<string, string | number>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(e)) {
    const v = e[k];
    if (typeof v === 'number') out[v] = k;
  }
  return out;
}

export const EVENT_NAMES: readonly string[] = enumNames(EventType as unknown as Record<string, string | number>);
const WATCHDOG_NAMES: readonly string[] = enumNames(WatchdogReason as unknown as Record<string, string | number>);

function isCutscene(p: number): boolean {
  for (let i = 0; i < CUTSCENE_PHASES.length; i++) if (CUTSCENE_PHASES[i] === p) return true;
  return false;
}

function teamOf(slot: number): number {
  return slot === (slot | 0) && slot >= 0 && slot < NUM_SLOTS ? (slot < PLAYERS_PER_TEAM ? 0 : 1) : -1;
}

function pair(): [number, number] { return [0, 0]; }

export function createMatchStats(): MatchStats {
  return {
    goals: pair(), shots: pair(), shotsOnTarget: pair(), passes: pair(), passesCompleted: pair(), possessionTicks: pair(),
    possessionPct: pair(), fouls: pair(), yellows: pair(), reds: pair(), offsides: pair(), saves: pair(), corners: pair(),
    tackles: pair(), tacklesWon: pair(), interceptions: pair(),
  };
}

function errorInfo(err: unknown, tick: number, where: string): RunException {
  const e = err instanceof Error ? err : new Error(String(err));
  return { message: e.message, stack: e.stack ?? e.message, tick, where };
}

/**
 * Run one match headless. Deterministic for the same config and input script. Stops at POST_MATCH or after
 * maxTicks steps, counted by the runner itself, so a sim that fails to advance s.tick (or moves it backwards) still
 * terminates; with a checker on, every step that does not advance s.tick by exactly one is also reported as a
 * 'clock' invariant failure (the checker alone would silently re-baseline on it).
 */
export function runMatch(opts: RunMatchOptions): RunMatchResult {
  const t0 = performance.now();
  const config = opts.config;
  const maxTicks = opts.maxTicks ?? defaultMaxTicks(config);
  const mode = opts.checker ?? 'core';
  const messageLimit = opts.messageLimit ?? 20;
  const checker: InvariantChecker | null = mode === 'none' ? null : createInvariantChecker(mode, { messageLimit });
  const events = createEventBuffer();
  const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
  const recorder = opts.record ? createReplayRecorder(config) : null;
  const stats = createMatchStats();
  const eventCounts = new Float64Array(EVENT_NAMES.length + 1);
  const watchdogCounts = new Float64Array(WATCHDOG_NAMES.length + 1);
  const lastKick = new Int32Array(NUM_SLOTS);
  const firstFailures: string[] = [];
  let watchdogs = 0;
  let dropped = 0;
  let possTeam = -1;
  let simMs = 0;
  let simMsMax = 0;
  let checkMs = 0;
  let exception: RunException | undefined;
  /** Steps taken (the loop bound: never trust s.tick for termination). */
  let ran = 0;
  /** Runner-level failures (tick not advancing), counted under 'clock'. */
  let tickFailures = 0;

  let s: SimState;
  try {
    s = initMatch(config, opts.clubs);
  } catch (err) {
    // No match state: report the exception around an empty state and run nothing.
    exception = errorInfo(err, 0, 'init');
    s = createSimState(config, [[], []]);
  }

  let where = 'inputs';
  try {
    while (!exception && ran < maxTicks && s.tick < maxTicks && s.match.phase !== MatchPhase.POST_MATCH) {
      where = 'inputs';
      clearInputFrame(frames[0]!);
      clearInputFrame(frames[1]!);
      if (opts.inputs) opts.inputs(s.tick + 1, s, frames);
      if (opts.fastCutscenes && isCutscene(s.match.phase) && s.match.phaseT % 2 === 0) {
        for (let h = 0; h < frames.length; h++) {
          const f = frames[h]!;
          f.buttons |= Btn.SKIP;
          if (f.cmd === Command.NONE) f.cmd = Command.SKIP;
        }
      }
      where = 'step';
      const tickBefore = s.tick;
      const a = performance.now();
      step(s, frames, events);
      const dt = performance.now() - a;
      ran++;
      simMs += dt;
      if (dt > simMsMax) simMsMax = dt;
      dropped += (events as { dropped?: number }).dropped ?? 0;
      if (checker && s.tick !== tickBefore + 1) {
        tickFailures++;
        if (firstFailures.length < messageLimit) {
          firstFailures.push(`t=${s.tick} [clock] step ${ran} did not advance s.tick by one (${tickBefore} -> ${s.tick})`);
        }
      }
      where = 'record';
      if (recorder) recorder.record(frames, s);

      // Statistics from this tick's events.
      for (let i = 0; i < events.count; i++) {
        const e = events.get(i);
        const type = e.type;
        eventCounts[type >= 0 && type < EVENT_NAMES.length && EVENT_NAMES[type] !== undefined ? type : EVENT_NAMES.length]!++;
        switch (type) {
          case EventType.KICK: {
            const t = teamOf(e.a);
            if (t < 0) break;
            lastKick[e.a] = e.b;
            if (isPassStatKind(e.b)) stats.passes[t]++;
            break;
          }
          case EventType.PASS_COMPLETE: {
            const t = teamOf(e.b);
            if (t >= 0 && isPassStatKind(lastKick[e.b]!)) {
              stats.passesCompleted[t]++;
              lastKick[e.b] = KickKind.NONE;
            }
            break;
          }
          case EventType.SHOT: {
            const t = teamOf(e.a);
            if (t < 0) break;
            stats.shots[t]++;
            if (e.b === 1) stats.shotsOnTarget[t]++;
            break;
          }
          case EventType.FOUL: {
            const t = teamOf(e.a);
            if (t >= 0 && e.c !== ChallengeOutcome.CLEAN) stats.fouls[t]++;
            break;
          }
          case EventType.CARD: {
            const t = teamOf(e.a);
            if (t < 0) break;
            if (e.b === CardKind.YELLOW) stats.yellows[t]++;
            else if (e.b === CardKind.RED || e.b === CardKind.SECOND_YELLOW) stats.reds[t]++;
            break;
          }
          case EventType.OFFSIDE: {
            const t = teamOf(e.a);
            if (t >= 0) stats.offsides[t]++;
            break;
          }
          case EventType.SAVE: {
            const t = teamOf(e.a);
            if (t >= 0) stats.saves[t]++;
            break;
          }
          case EventType.RESTART_AWARDED:
            if (e.a === RestartKind.CORNER && (e.b === 0 || e.b === 1)) stats.corners[e.b]++;
            break;
          case EventType.TACKLE: {
            const t = teamOf(e.a);
            if (t < 0) break;
            stats.tackles[t]++;
            if (e.c === 1) stats.tacklesWon[t]++;
            break;
          }
          case EventType.INTERCEPT: {
            const t = teamOf(e.a);
            if (t >= 0) stats.interceptions[t]++;
            break;
          }
          case EventType.WATCHDOG:
            watchdogs++;
            watchdogCounts[e.a >= 0 && e.a < WATCHDOG_NAMES.length ? e.a : WATCHDOG_NAMES.length]!++;
            break;
          default:
            break;
        }
      }
      if (s.match.phase === MatchPhase.IN_PLAY) {
        const ot = teamOf(s.ball.owner);
        if (ot >= 0) possTeam = ot;
        if (possTeam >= 0) stats.possessionTicks[possTeam]++;
      }

      if (checker) {
        where = 'checker';
        const c0 = performance.now();
        const msgs = checker.check(s, events);
        checkMs += performance.now() - c0;
        for (let i = 0; i < msgs.length && firstFailures.length < messageLimit; i++) firstFailures.push(msgs[i]!);
      }
      if (opts.onTick) {
        where = 'onTick';
        if (opts.onTick(s, events) === true) break;
      }
    }
  } catch (err) {
    exception = errorInfo(err, s.tick, where);
  }

  const ticks = ran;
  stats.goals[0] = s.teams[0]!.goals;
  stats.goals[1] = s.teams[1]!.goals;
  const possTotal = stats.possessionTicks[0] + stats.possessionTicks[1];
  if (possTotal > 0) {
    stats.possessionPct[0] = (100 * stats.possessionTicks[0]) / possTotal;
    stats.possessionPct[1] = 100 - stats.possessionPct[0];
  }
  const evRecord: Record<string, number> = {};
  for (let i = 0; i < EVENT_NAMES.length; i++) {
    const n = EVENT_NAMES[i];
    if (n !== undefined) evRecord[n] = eventCounts[i]!;
  }
  if (eventCounts[EVENT_NAMES.length]! > 0) evRecord.UNKNOWN = eventCounts[EVENT_NAMES.length]!;
  const wdRecord: Record<string, number> = {};
  for (let i = 0; i <= WATCHDOG_NAMES.length; i++) {
    if (watchdogCounts[i]! > 0) wdRecord[WATCHDOG_NAMES[i] ?? 'UNKNOWN'] = watchdogCounts[i]!;
  }
  const byName = checker ? checker.counts : (Object.fromEntries(INVARIANT_NAMES.map((n) => [n, 0])) as Record<InvariantName, number>);
  byName.clock += tickFailures;
  let hash = 0;
  try {
    hash = hashState(s);
  } catch (err) {
    exception ??= errorInfo(err, s.tick, 'hash');
  }
  return {
    state: s,
    hash,
    ticks,
    finished: s.match.phase === MatchPhase.POST_MATCH,
    endPhase: s.match.phase,
    events: evRecord,
    eventsDropped: dropped,
    stats,
    invariantFailures: { first: firstFailures, count: checker ? checker.total + tickFailures : 0, byName },
    watchdogs,
    watchdogReasons: wdRecord,
    ...(exception ? { exception } : {}),
    ...(recorder ? { replay: recorder.finish(s) } : {}),
    perf: {
      wallMs: performance.now() - t0,
      simMsAvg: ticks > 0 ? simMs / ticks : 0,
      simMsMax,
      checkMsAvg: ticks > 0 && checker ? checkMs / ticks : 0,
    },
  };
}
