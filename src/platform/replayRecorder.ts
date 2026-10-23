/**
 * [PLT-05] Live replay recording and playback for the shipped game (brief section 4 rule 7: replay save and load,
 * seed plus inputs; section 14.4: a saved replay plays back identically after a reload; section 19: a reported glitch
 * is reproduced from the replay file).
 *
 * Recording (always on, so a glitch can be saved after it happened): after every sim tick the recorder packs the
 * human InputFrames the tick used (sim/core/serialize packFrames, PACKED_FRAME_INTS int16 per tick) into
 * preallocated Int16Array chunks (one new chunk per LOCAL_TUNING.chunkTicks ticks, nothing else allocated per tick)
 * and hashes the state every REPLAY_HASH_INTERVAL ticks. A match is recognised by its first tick (state.tick === 1);
 * a recorder that joins mid-match records nothing until the next match. snapshot() builds a sim/replay.ts Replay
 * (JSON-serialisable; tools/replay-inspect.ts and playReplay read it). Recording stops after
 * LOCAL_TUNING.maxMinutes of play (the replay stays valid as a prefix).
 *
 * Hook: attachReplayRecorder wraps the app session's afterTick(rt) (app/types.ts LoopSession), which the loop calls
 * after every step with the tick's frames (rt.frames) and the state after it (rt.curr). Interim: a change request
 * asks the lead for an official per-tick hook (see the PLT-05 report).
 *
 * Playback: createReplayInputProvider(replay) is a TickInputProvider that feeds the recorded frames tick by tick;
 * replaySetup() wraps it in a MatchSetup for session.start (bindings: none, so devices never reach the sim). It
 * compares the live state hash with every recorded checkpoint and the final hash, logs the verdict and stores it in
 * provider.check. After the last recorded tick the humans send neutral frames. Commands queued during playback are
 * ignored (they would change the recorded input stream).
 */
import type { MatchSetup, SessionControl, TickInputProvider } from '../contracts/app';
import { MAX_HUMANS, SIM_VERSION } from '../contracts/constants';
import { clearInputFrame, type InputFrame } from '../contracts/input';
import type { MatchConfig, ReadonlySimState, SimState } from '../contracts/state';
import type { MatchRuntime } from '../app/types';
import { hashHex, hashState, hashValue } from '../sim/core/hash';
import { PACKED_FRAME_INTS, packFrames } from '../sim/core/serialize';
import { REPLAY_FORMAT, REPLAY_HASH_INTERVAL, replayFramesAt, replayProblem, type Replay } from '../sim/replay';

const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: platform, replay recorder)
  /** Ticks per preallocated frame chunk (60 s at 60 Hz), ticks. */
  chunkTicks: 3600,
  /** Longest recording; later ticks are not recorded (the replay stays a valid prefix), minutes of play. */
  maxMinutes: 120,
} as const;

const TICK_HZ = 60;

export interface LiveReplayRecorder {
  /** After every tick: the frames the tick used and the state after it. Allocation-free except a new chunk per minute. */
  onTick(frames: readonly InputFrame[], s: ReadonlySimState): void;
  /** Replay of the current (or last) match, or null when nothing usable was recorded. Allocates (UI only). */
  snapshot(): Replay | null;
  /** Ticks recorded for the current match. */
  readonly ticks: number;
  /** True while a match is being recorded. */
  readonly recording: boolean;
  /** Why the current match is not (fully) recorded, or null. */
  readonly problem: string | null;
  /** One line for the diagnostics report. */
  summary(): string;
  /** Forget everything (the next tick 1 starts a new recording). */
  reset(): void;
}

export interface LiveReplayRecorderOptions {
  chunkTicks?: number;
  maxTicks?: number;
  hashInterval?: number;
}

function jsonCopy<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function createLiveReplayRecorder(opts: LiveReplayRecorderOptions = {}): LiveReplayRecorder {
  const chunkTicks = Math.max(1, Math.floor(opts.chunkTicks ?? LOCAL_TUNING.chunkTicks));
  const maxTicks = Math.max(1, Math.floor(opts.maxTicks ?? LOCAL_TUNING.maxMinutes * 60 * TICK_HZ));
  const interval = Math.max(1, Math.floor(opts.hashInterval ?? REPLAY_HASH_INTERVAL));
  const chunkInts = chunkTicks * PACKED_FRAME_INTS;
  const chunks: Int16Array[] = [];
  let config: MatchConfig | null = null;
  let squadsHash = 0;
  let ticks = 0;
  let hashes: number[] = [];
  let lastState: ReadonlySimState | null = null;
  let recording = false;
  let problem: string | null = null;

  function start(s: ReadonlySimState): void {
    config = s.config as MatchConfig;
    squadsHash = hashValue(s.squads);
    ticks = 0;
    hashes = [];
    recording = true;
    problem = null;
  }

  return {
    onTick(frames, s) {
      if (s.tick === 1) start(s);
      else if (!recording) {
        if (s.config !== config && problem === null) problem = 'joined mid-match';
        return;
      }
      if (s.config !== config || s.tick !== ticks + 1) {
        // A tick went unrecorded (or another state): the replay so far stays valid as a prefix.
        recording = false;
        problem = `tick ${s.tick} after ${ticks} recorded`;
        return;
      }
      if (ticks >= maxTicks) {
        recording = false;
        problem = 'longest recording reached';
        return;
      }
      const c = (ticks / chunkTicks) | 0;
      if (c >= chunks.length) chunks.push(new Int16Array(chunkInts));
      packFrames(frames as InputFrame[], chunks[c]!, (ticks - c * chunkTicks) * PACKED_FRAME_INTS);
      ticks++;
      lastState = s;
      if (ticks % interval === 0) hashes.push(hashState(s as SimState));
    },
    snapshot() {
      if (config === null || ticks === 0) return null;
      let n = ticks;
      let finalHash: number;
      let keptHashes = hashes;
      const live = lastState;
      if (live !== null && live.config === config && live.tick === ticks) {
        finalHash = hashState(live as SimState);
      } else {
        // The live state moved on without us: cut back to the last checkpoint.
        const k = Math.min(hashes.length, Math.floor(ticks / interval));
        if (k === 0) return null;
        n = k * interval;
        finalHash = hashes[k - 1]!;
        keptHashes = hashes.slice(0, k);
      }
      const frames: number[] = new Array<number>(n * PACKED_FRAME_INTS);
      for (let t = 0; t < n; t++) {
        const c = (t / chunkTicks) | 0;
        const base = (t - c * chunkTicks) * PACKED_FRAME_INTS;
        const chunk = chunks[c]!;
        for (let i = 0; i < PACKED_FRAME_INTS; i++) frames[t * PACKED_FRAME_INTS + i] = chunk[base + i]!;
      }
      const cfg = jsonCopy(config);
      return {
        format: REPLAY_FORMAT, simVersion: SIM_VERSION, config: cfg, seed: cfg.seed >>> 0, squadsHash, frames,
        ticks: n, finalHash, hashInterval: interval, hashes: keptHashes.slice(),
      };
    },
    get ticks() { return ticks; },
    get recording() { return recording; },
    get problem() { return problem; },
    summary() {
      if (config === null) return problem ? `nothing recorded (${problem})` : 'nothing recorded yet';
      const secs = (ticks / TICK_HZ).toFixed(1);
      return `seed ${config.seed >>> 0}, ${ticks} ticks (${secs} s)${recording ? ', recording' : ''}${problem ? `, ${problem}` : ''}`;
    },
    reset() {
      chunks.length = 0;
      config = null;
      ticks = 0;
      hashes = [];
      lastState = null;
      recording = false;
      problem = null;
    },
  };
}

type TickHookable = { afterTick?: (rt: MatchRuntime) => void };

/**
 * Record every tick of the app session (wraps its afterTick). Returns a detach function, or null when the session
 * has no afterTick hook (then nothing is recorded).
 */
export function attachReplayRecorder(session: SessionControl, rec: LiveReplayRecorder, onError?: (err: unknown) => void): (() => void) | null {
  const target = session as SessionControl & TickHookable;
  const orig = target.afterTick;
  if (typeof orig !== 'function') return null;
  let failed = false;
  const wrapped = function (this: unknown, rt: MatchRuntime): void {
    if (!failed) {
      try {
        rec.onTick(rt.frames, rt.curr);
      } catch (err) {
        failed = true; // never let the recorder break play; report once
        onError?.(err);
      }
    }
    orig.call(this ?? target, rt);
  };
  target.afterTick = wrapped;
  return () => {
    if (target.afterTick === wrapped) target.afterTick = orig;
  };
}

// ============================================================ playback

export type ReplayVerdict = 'pending' | 'match' | 'diverged';

export interface ReplayCheck {
  verdict: ReplayVerdict;
  /** First tick whose hash differed (-1 none). */
  divergedAt: number;
  /** Checkpoints compared so far. */
  checked: number;
  /** False when the squads differ from the recording (club data changed). */
  squadsMatch: boolean;
  /** Hash of the live state after the last recorded tick (0 until reached). */
  finalHash: number;
  ticks: number;
}

export interface ReplayInputProvider extends TickInputProvider {
  readonly replay: Replay;
  readonly check: Readonly<ReplayCheck>;
}

export interface ReplayProviderOptions {
  /** Called once with the verdict when the last recorded tick has been played (or at the first divergence). */
  onResult?(check: Readonly<ReplayCheck>): void;
}

/** Validate a replay for playback in this build; returns the problem or null. Pure. */
export function replayPlaybackProblem(r: unknown): string | null {
  const p = replayProblem(r);
  if (p !== null) return p;
  const rep = r as Replay;
  if (rep.simVersion !== SIM_VERSION) return `recorded with sim version ${rep.simVersion}, this build is ${SIM_VERSION}`;
  return null;
}

export function createReplayInputProvider(replay: Replay, opts: ReplayProviderOptions = {}): ReplayInputProvider {
  const scratch = new Int16Array(PACKED_FRAME_INTS);
  const check: ReplayCheck = { verdict: 'pending', divergedAt: -1, checked: 0, squadsMatch: true, finalHash: 0, ticks: replay.ticks };
  let lastSeen = -1;
  let reported = false;
  let squadsChecked = false;

  function report(): void {
    if (reported) return;
    reported = true;
    opts.onResult?.(check);
  }

  /** Compare the state after tick `done` with the recording. */
  function compare(done: number, s: ReadonlySimState): void {
    if (done <= lastSeen) return;
    lastSeen = done;
    if (!squadsChecked) {
      squadsChecked = true;
      check.squadsMatch = hashValue(s.squads) === replay.squadsHash;
    }
    if (done <= 0 || check.verdict === 'diverged') return;
    const iv = replay.hashInterval;
    if (done % iv === 0) {
      const k = done / iv - 1;
      if (k < replay.hashes.length) {
        check.checked++;
        if (hashState(s as SimState) !== replay.hashes[k]) {
          check.verdict = 'diverged';
          check.divergedAt = done;
          report();
          return;
        }
      }
    }
    if (done === replay.ticks) {
      check.finalHash = hashState(s as SimState);
      check.checked++;
      if (check.finalHash !== replay.finalHash) {
        check.verdict = 'diverged';
        check.divergedAt = done;
      } else {
        check.verdict = 'match';
      }
      report();
    }
  }

  return {
    replay,
    check,
    ready: () => true,
    take(tick, frames, state) {
      compare(tick - 1, state);
      if (tick >= 1 && tick <= replay.ticks) {
        replayFramesAt(replay, tick, frames, scratch);
      } else {
        for (let h = 0; h < MAX_HUMANS; h++) if (frames[h]) clearInputFrame(frames[h]!);
      }
    },
    pump() { /* nothing to poll */ },
    get waiting() { return false; },
    releaseAll() { /* no held inputs */ },
    queueCommand() { /* ignored: the recorded frames already carry the commands */ },
    dispose() { /* nothing held */ },
  };
}

/** A MatchSetup that plays `replay` in the app session. */
export function replaySetup(replay: Replay, opts: ReplayProviderOptions = {}): { setup: MatchSetup; provider: ReplayInputProvider } {
  const provider = createReplayInputProvider(replay, opts);
  return { setup: { config: jsonCopy(replay.config), bindings: [], inputProvider: provider, modeData: { replay: true } }, provider };
}

/** One line describing a playback verdict. Pure. */
export function describeReplayCheck(c: Readonly<ReplayCheck>): string {
  if (c.verdict === 'pending') return `replay playing (${c.checked} checkpoints matched)`;
  const squads = c.squadsMatch ? '' : ' (club data differs from the recording)';
  if (c.verdict === 'match') return `replay matched: ${c.ticks} ticks, ${c.checked} checkpoints, final hash ${hashHex(c.finalHash)}${squads}`;
  return `replay diverged at tick ${c.divergedAt}${squads}`;
}

/** File name for a saved replay. Pure. */
export function replayFileName(replay: Replay, stamp: string): string {
  const safe = stamp.replace(/[^0-9A-Za-z-]/g, '-');
  return `dotkick-replay-${replay.seed >>> 0}-${replay.ticks}t-${safe}.json`;
}

// ============================================================ app-wide instance

let shared: LiveReplayRecorder | null = null;

/** The recorder installed for the app (recovery.ts installs it), or null. */
export function appReplayRecorder(): LiveReplayRecorder | null {
  return shared;
}

/** Install (or replace) the app-wide recorder. Returns it. */
export function setAppReplayRecorder(rec: LiveReplayRecorder | null): LiveReplayRecorder | null {
  shared = rec;
  return rec;
}
