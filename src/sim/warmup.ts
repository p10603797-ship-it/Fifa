/**
 * [FIN-P] Sim + AI warm-up on the loading screen (BRIEF section 13 "Warm-up": during loading ... run each animation and
 * effect once off screen, so the first slide tackle or replay in a match does not hitch; and the throttled proxy gate,
 * DoD 6). A JavaScript engine compiles a function the first time it runs, re-compiles it optimised once it is hot, and
 * the sim's state objects settle their hidden classes (a field's first double generalises its map, which deoptimises
 * every function that read it) during the first thousands of ticks of a session. Without a warm-up all of that lands
 * inside the ticks of the first match: in Chromium under 4x CPU throttling most ticks over the 4 ms budget in the first
 * 90 s carried compile or deopt work (tests/perf/fin-p-tick-trace.ts).
 *
 * warmUpSim() plays a scratch CPU v CPU match (cut-scenes skipped) and then each restart kind for both teams on it,
 * T_WARMUP ticks in all, with its own state, input frames and event buffer: nothing outside the scratch state is
 * written, so the match that follows is bit-identical with or without it (tests/unit/fin-p-warmup.test.ts compares
 * hash timelines). initMatch runs it once per process in production builds (warmUpOnce: the app's loading screen, about
 * 1.5 s in desktop Chromium, 5 s under 4x CPU throttling); dev builds, tests and the Node tools skip it (hundreds of test
 * files would each pay it) unless they call warmUpSim() themselves.
 */
import { HALF_LENGTH, HALF_WIDTH, PENALTY_SPOT_DIST } from '../contracts/constants';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../contracts/input';
import { Command, ControllerKind, Difficulty, MatchPhase, ModeId, RestartKind } from '../contracts/enums';
import { createMatchConfig, type MatchConfig, type SimState } from '../contracts/state';
import { CUTSCENE_PHASES } from '../contracts/transitions';
import { T_WARMUP } from '../contracts/tuning';
import { createEventBuffer } from './core/events';
import { awardRestart } from './rules/restart';
import { step } from './step';

/**
 * [FIN-P] Settle the hidden classes of a fresh state's objects up front, so they do not change in play: every numeric
 * field (and every all-number array) that holds an integer is written once with a fraction and then back, so V8 gives it
 * its double representation (and a mutable, non-constant field) now instead of on its first fractional value in play.
 * createSimState's literals start every number as a small integer (x: 0, vy: 0, ...); a field's first fraction (the
 * ball's first spin at tick ~6000, a restart's wall position, an advantage spot) changed the map of that object kind and
 * deoptimised every optimised function that had read it (Node: 457 "wrong map" deopts in two matches, 2 after this), so
 * the engine kept re-optimising for some 20000 ticks and paced ticks ran in slower tiers with boxed doubles.
 * Integer-only fields are settled too, on purpose: in Chromium (V8 14) under 4x throttling, settling only the 79 fields
 * that ever hold fractions left twice the Maglev recompilations, deopts and allocation per tick in the first match's
 * window (141 vs 62 recompilations, 34 vs 17 KB per tick, 39 vs 17 of 130 frames with a tick over 4 ms;
 * tests/perf/fin-p-tick-trace.ts). Node's V8 12 boxes a few more doubles at call boundaries for it (bytes per tick;
 * tests/perf/sim-15-perf, rul-07-budget). Values are unchanged (an integer plus 0.5 is exact, and the integer itself is
 * written back, -0 included), so this is invisible to the sim and its hash; JavaScriptCore has no field representations
 * and is unaffected. tests/unit/fin-p-warmup.test.ts plays matches and checks that no map changes. Load-time only.
 */
export function settleStateShapes(s: SimState): void {
  const r = s as unknown as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k === 'config' || k === 'squads') continue; // shared inputs, never written by the sim
    settleValue(r, k, 0);
  }
}

function settleValue(o: Record<string | number, unknown>, k: string | number, depth: number): void {
  const v = o[k];
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      o[k] = v + 0.5;
      o[k] = v;
    }
  } else if (Array.isArray(v)) {
    if (depth > 6) return;
    let allNum = v.length > 0;
    for (let i = 0; i < v.length; i++) if (typeof v[i] !== 'number') { allNum = false; break; }
    const a = v as unknown as Record<number, unknown>;
    if (allNum) settleValue(a, 0, depth + 1); // one store moves the whole array to double elements
    else for (let i = 0; i < v.length; i++) if (v[i] !== null && typeof v[i] === 'object') settleValue(a, i, depth + 1);
  } else if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v)) {
    if (depth > 6) return;
    const obj = v as Record<string, unknown>;
    for (const key of Object.keys(obj)) settleValue(obj, key, depth + 1);
  }
}

/**
 * Scratch match config: the coming match's clubs, formations and level (so the CPU brains take the same branches), both
 * sides CPU, its own seed (never the match's: the warm-up must not rehearse the very match it precedes). No base (a
 * direct call): the top level, which does the most AI work.
 */
function warmConfig(base: MatchConfig | null): MatchConfig {
  const c = createMatchConfig();
  c.difficulty = Difficulty.LEGEND;
  if (base) {
    c.homeClub = base.homeClub;
    c.awayClub = base.awayClub;
    c.homeFormation = base.homeFormation;
    c.awayFormation = base.awayFormation;
    c.difficulty = base.difficulty;
  }
  c.seed = (T_WARMUP.seed ^ (base ? base.seed : 0)) >>> 0;
  if (base && c.seed === base.seed >>> 0) c.seed = (c.seed + 1) >>> 0;
  c.mode = ModeId.KICK_OFF;
  c.halfMinutes = T_WARMUP.halfMinutes;
  c.startPhase = MatchPhase.KICK_OFF;
  for (let h = 0; h < c.humans.length; h++) {
    c.humans[h] = { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 };
  }
  return c;
}

function isCutscene(p: number): boolean {
  for (let i = 0; i < CUTSCENE_PHASES.length; i++) if (CUTSCENE_PHASES[i] === p) return true;
  return false;
}

/** One scratch tick; cut-scenes are skipped (Btn.SKIP edges, as the headless soak does). */
function tick(s: SimState, frames: InputFrame[], ev: ReturnType<typeof createEventBuffer>): void {
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  if (isCutscene(s.match.phase) && s.match.phaseT % 2 === 0) {
    for (let h = 0; h < frames.length; h++) {
      frames[h]!.buttons |= Btn.SKIP;
      frames[h]!.cmd = Command.SKIP;
    }
  }
  step(s, frames, ev);
  phasesSeen |= 1 << s.match.phase;
}

/** The phase as a plain number (TypeScript would keep a narrowing across the steps that change it). */
function phaseOf(s: SimState): number {
  return s.match.phase;
}

/**
 * Restart scenes played after the open play: kind, attacking team, spot as a fraction of (HALF_LENGTH, HALF_WIDTH).
 * Kind and team live in their own small-integer arrays: read from an array that also holds fractions they would be
 * heap numbers, and storing those into restart.kind / .team would give those fields a double representation.
 */
const SCENE_KIND: readonly RestartKind[] = [RestartKind.CORNER, RestartKind.FREE_KICK, RestartKind.PENALTY, RestartKind.THROW_IN,
  RestartKind.GOAL_KICK, RestartKind.CORNER, RestartKind.FREE_KICK, RestartKind.THROW_IN];
const SCENE_TEAM: readonly number[] = [0, 1, 0, 1, 0, 1, 0, 0];
const SCENE_X: readonly number[] = [1, -0.62, 1 - PENALTY_SPOT_DIST / HALF_LENGTH, 0.2, -0.9, -1, 0.66, -0.3];
const SCENE_Z: readonly number[] = [1, 0.1, 0, 1, 0.15, -1, -0.2, -1];

/** Bit per MatchPhase the warm-up's scratch match went through (tests check every restart kind ran). */
let phasesSeen = 0;
/** Ticks warmUpSim ran in this process (0 = never). */
let warmedTicks = 0;
/** Re-entrancy guard (warmUpSim builds its scratch state with initMatch). */
let warming = false;
/** warmUpOnce has run (or tried to) in this process. */
let attempted = false;

export function simWarmedTicks(): number {
  return warmedTicks;
}

/** Bit mask (1 << MatchPhase) of the phases the warm-up went through in this process. */
export function simWarmedPhases(): number {
  return phasesSeen;
}

/**
 * Play the warm-up (T_WARMUP.openPlayTicks of open play, then T_WARMUP.sceneTicks per restart scene) on a scratch state
 * made by `makeState` (initMatch). Returns the ticks run. Writes nothing but the scratch state.
 */
export function warmUpSim(makeState: (c: MatchConfig) => SimState, base: MatchConfig | null = null): number {
  if (warming) return 0;
  warming = true;
  let ran = 0;
  try {
    const s = makeState(warmConfig(base));
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let t = 0; t < T_WARMUP.openPlayTicks && phaseOf(s) !== MatchPhase.POST_MATCH; t++) { tick(s, frames, ev); ran++; }
    for (let k = 0; k < SCENE_KIND.length; k++) {
      // Back to open play first (a restart is awarded from play), then the scene.
      for (let t = 0; t < T_WARMUP.sceneTicks && phaseOf(s) !== MatchPhase.IN_PLAY && phaseOf(s) !== MatchPhase.POST_MATCH; t++) { tick(s, frames, ev); ran++; }
      if (phaseOf(s) !== MatchPhase.IN_PLAY) break;
      awardRestart(s, SCENE_KIND[k]!, SCENE_TEAM[k]!, SCENE_X[k]! * HALF_LENGTH, SCENE_Z[k]! * HALF_WIDTH, ev);
      for (let t = 0; t < T_WARMUP.sceneTicks && phaseOf(s) !== MatchPhase.POST_MATCH; t++) { tick(s, frames, ev); ran++; }
    }
  } finally {
    warming = false;
  }
  warmedTicks += ran;
  return ran;
}

/**
 * The loading-screen entry (initMatch, production builds): warmUpSim once per process, before the first match's state
 * is built. Never throws: a failing warm-up only costs the warm-up (the match itself would fail the same way anyway).
 */
export function warmUpOnce(makeState: (c: MatchConfig) => SimState, base: MatchConfig): void {
  if (attempted || warming) return;
  attempted = true;
  try {
    warmUpSim(makeState, base);
  } catch {
    // optional work: the match loads without it
  }
}
