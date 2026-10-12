/**
 * [FND-06] Replay record and playback. Pure data, JSON-serialisable (JSON.stringify(replay) round-trips).
 *
 * A replay is the match config plus every tick's human InputFrames packed with serialize.packFrames
 * (PACKED_FRAME_INTS int16 values per tick), with a state hash every REPLAY_HASH_INTERVAL ticks and the final
 * hash, so playback can say where it diverged. Recording: after each step(s, frames, events) call
 * recorder.record(frames, s); at the end recorder.finish(s). Playback re-runs initMatch + step and compares.
 */
import { SIM_VERSION } from '../contracts/constants';
import type { Club } from '../contracts/data';
import type { EventBuffer } from '../contracts/events';
import { createInputFrame, type InputFrame } from '../contracts/input';
import type { MatchConfig, SimState } from '../contracts/state';
import { createEventBuffer } from './core/events';
import { hashState, hashValue } from './core/hash';
import { PACKED_FRAME_INTS, packFrames, unpackFrames } from './core/serialize';
import { initMatch } from './init';
import { step } from './step';

/** Replay file format version (bump on layout changes). */
export const REPLAY_FORMAT = 1;
/** Ticks between recorded state hashes. */
export const REPLAY_HASH_INTERVAL = 60;

export interface Replay {
  format: number;
  /** SIM_VERSION the replay was recorded with; playback refuses another version. */
  simVersion: number;
  /** Deep copy of the match config (seed included). */
  config: MatchConfig;
  /** config.seed, duplicated for quick reading. */
  seed: number;
  /** hashValue of the squads the match was initialised with (detects changed club data). */
  squadsHash: number;
  /** Packed human frames, PACKED_FRAME_INTS int16 values per tick (tick 1 first). */
  frames: number[];
  /** Number of recorded ticks. */
  ticks: number;
  /** hashState after the last recorded tick. */
  finalHash: number;
  hashInterval: number;
  /** hashState after ticks hashInterval, 2 * hashInterval, ... */
  hashes: number[];
}

export interface ReplayRecorder {
  /**
   * Record the frames used for the tick that was just stepped. Pass the state after the step so the
   * recorder can hash it every hashInterval ticks (and check it is in sync: s.tick must equal ticks + 1).
   */
  record(frames: readonly InputFrame[], s?: SimState): void;
  /** Close the replay with the final state hash. The recorder may keep recording afterwards. */
  finish(s: SimState): Replay;
  /** Ticks recorded so far. */
  readonly ticks: number;
  /** The live replay object (finalHash is only valid after finish). */
  readonly replay: Replay;
}

/** Deep copy of plain JSON data (configs). */
function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** Start recording a match with this config (copied, so later edits to the caller's object do not leak in). */
export function createReplayRecorder(config: MatchConfig): ReplayRecorder {
  const cfg = jsonCopy(config);
  const replay: Replay = {
    format: REPLAY_FORMAT, simVersion: SIM_VERSION, config: cfg, seed: cfg.seed >>> 0, squadsHash: 0, frames: [],
    ticks: 0, finalHash: 0, hashInterval: REPLAY_HASH_INTERVAL, hashes: [],
  };
  const packed = new Int16Array(PACKED_FRAME_INTS);
  let squadsHashed = false;

  function noteState(s: SimState): void {
    if (!squadsHashed) {
      replay.squadsHash = hashValue(s.squads);
      squadsHashed = true;
    }
  }

  return {
    record(frames, s) {
      packFrames(frames, packed, 0);
      const f = replay.frames;
      for (let i = 0; i < PACKED_FRAME_INTS; i++) f.push(packed[i]!);
      replay.ticks++;
      if (s) {
        if (s.tick !== replay.ticks) {
          throw new Error(`ReplayRecorder: state tick ${s.tick} != recorded ticks ${replay.ticks} (record after every step)`);
        }
        noteState(s);
        if (s.tick % replay.hashInterval === 0) replay.hashes.push(hashState(s));
      }
    },
    finish(s) {
      noteState(s);
      replay.finalHash = hashState(s);
      return replay;
    },
    get ticks() { return replay.ticks; },
    get replay() { return replay; },
  };
}

export interface ReplayPlayback {
  state: SimState;
  /** hashState of the final state. */
  hash: number;
  /** First tick whose hash differs from the recording (checkpoint or final), -1 = identical. */
  divergedAt: number;
  /** False if the squads differ from the recording (club data changed since). */
  squadsMatch: boolean;
  /** Ticks played (less than replay.ticks if stopped early). */
  ticks: number;
}

export interface PlayReplayOptions {
  /** Clubs to initialise with (default data/clubs). */
  clubs?: readonly Club[];
  /** Stop at the first divergence. */
  stopAtDivergence?: boolean;
  /** Play at most this many ticks. */
  maxTicks?: number;
}

/**
 * Callback after every played tick; return true to stop playback.
 */
export type ReplayTickFn = (s: SimState, events: EventBuffer, tick: number) => boolean | void;

/** Problems with a parsed replay object, or null when it looks valid. */
export function replayProblem(r: unknown): string | null {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return 'not an object';
  const o = r as Record<string, unknown>;
  if (o.format !== REPLAY_FORMAT) return `format ${String(o.format)} != ${REPLAY_FORMAT}`;
  if (typeof o.simVersion !== 'number') return 'missing simVersion';
  if (typeof o.config !== 'object' || o.config === null) return 'missing config';
  if (typeof o.seed !== 'number' || typeof o.squadsHash !== 'number') return 'missing seed / squadsHash';
  if (typeof o.ticks !== 'number' || !Number.isInteger(o.ticks) || o.ticks < 0) return 'bad ticks';
  if (!Array.isArray(o.frames) || o.frames.length !== o.ticks * PACKED_FRAME_INTS) {
    return `frames length ${Array.isArray(o.frames) ? o.frames.length : 'n/a'} != ticks * ${PACKED_FRAME_INTS}`;
  }
  if (typeof o.finalHash !== 'number') return 'missing finalHash';
  if (typeof o.hashInterval !== 'number' || !Number.isInteger(o.hashInterval) || o.hashInterval <= 0) return 'bad hashInterval';
  if (!Array.isArray(o.hashes)) return 'missing hashes';
  return null;
}

/** Parse and validate a replay JSON string. Throws a SyntaxError with the reason on a bad file. */
export function parseReplay(json: string): Replay {
  const r = JSON.parse(json) as unknown;
  const problem = replayProblem(r);
  if (problem !== null) throw new SyntaxError(`parseReplay: ${problem}`);
  return r as Replay;
}

/** Unpack the frames of tick `tick` (1-based) into `out` (MAX_HUMANS frames, reused). */
export function replayFramesAt(replay: Replay, tick: number, out: InputFrame[], scratch?: Int16Array): void {
  const buf = scratch ?? new Int16Array(PACKED_FRAME_INTS);
  const base = (tick - 1) * PACKED_FRAME_INTS;
  for (let i = 0; i < PACKED_FRAME_INTS; i++) buf[i] = replay.frames[base + i]!;
  unpackFrames(buf, 0, out);
}

/**
 * Re-run a replay from initMatch and compare its hashes. Throws if the replay is malformed or was recorded with
 * another SIM_VERSION.
 */
export function playReplay(replay: Replay, onTick?: ReplayTickFn, opts: PlayReplayOptions = {}): ReplayPlayback {
  const problem = replayProblem(replay);
  if (problem !== null) throw new Error(`playReplay: ${problem}`);
  if (replay.simVersion !== SIM_VERSION) {
    throw new Error(`playReplay: replay simVersion ${replay.simVersion} != SIM_VERSION ${SIM_VERSION}`);
  }
  const s = initMatch(jsonCopy(replay.config), opts.clubs);
  const squadsMatch = hashValue(s.squads) === replay.squadsHash;
  const events = createEventBuffer();
  const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
  const packed = Int16Array.from(replay.frames);
  const interval = replay.hashInterval;
  const limit = opts.maxTicks !== undefined && opts.maxTicks < replay.ticks ? opts.maxTicks : replay.ticks;
  let divergedAt = -1;
  let played = 0;
  for (let i = 0; i < limit; i++) {
    unpackFrames(packed, i * PACKED_FRAME_INTS, frames);
    step(s, frames, events);
    played++;
    if (s.tick % interval === 0) {
      const k = s.tick / interval - 1;
      if (k < replay.hashes.length && divergedAt < 0 && hashState(s) !== replay.hashes[k]) divergedAt = s.tick;
    }
    if (onTick && onTick(s, events, s.tick) === true) break;
    if (divergedAt >= 0 && opts.stopAtDivergence) break;
  }
  const hash = hashState(s);
  if (divergedAt < 0 && played === replay.ticks && hash !== replay.finalHash) divergedAt = s.tick;
  return { state: s, hash, divergedAt, squadsMatch, ticks: played };
}
