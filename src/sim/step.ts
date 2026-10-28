/**
 * The deterministic fixed-step simulation (ARCHITECTURE rule 1). Lead-owned.
 * step(state, humanFrames, events) advances exactly one 1/60 s tick. Same seed + same input stream =>
 * bit-identical state hash in every engine. No Math.random, clocks, DOM or Three.js anywhere below here.
 */
import { HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_SPOT_DIST } from '../contracts/constants';
import { Command, ControllerKind, Difficulty, MatchPhase, ModeId, RestartKind } from '../contracts/enums';
import type { EventBuffer } from '../contracts/events';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../contracts/input';
import { createMatchConfig, createSimState, type MatchConfig, type SimState } from '../contracts/state';
import { CUTSCENE_PHASES } from '../contracts/transitions';
import { T_DRIBBLE, T_RULES, T_WARMUP } from '../contracts/tuning';
import { cpuThink } from '../ai/cpu';
import { teamAiTick } from '../ai';
import { resolveControllers } from './control/resolve';
import { actionsTick } from './actions/dispatch';
import { locomotionTick } from './players/locomotion';
import { bodyContactTick } from './players/bodies';
import { ballTick } from './ball/contact';
import { contactsTick } from './contacts';
import { rulesTick } from './rules/machine';
import { practiceRulesTick } from './rules/practice';
import { watchdogTick } from './rules/watchdog';
import { awardRestart } from './rules/restart';
import { copyState } from './core/clone';
import { createEventBuffer } from './core/events';
import { hashState } from './core/hash';
import { bindSimWarmUp } from './init';

/** Squared T_RULES.ballLieSpeed, (m/s)^2. */
const LIE2 = T_RULES.ballLieSpeed * T_RULES.ballLieSpeed;

/**
 * Advance one tick. `humanFrames` has one InputFrame per human controller (MAX_HUMANS); entries for
 * controllers that are not humans are ignored, except that in a match with no HUMAN controller at all a Btn.SKIP
 * edge (or Command.SKIP) in humanFrames[0] skips the current cut-scene (headless soak fast-forward; RUL-01 reads it
 * via s.ctrl[0].buttons). Calls events.begin() itself.
 */
export function step(s: SimState, humanFrames: readonly InputFrame[], events: EventBuffer): void {
  s.tick++;
  events.begin(s.tick);
  const m = s.match;
  m.phaseT++;
  s.ball.cross = 0;
  cpuThink(s, events); // ai/cpu: CPU brains write their InputFrames
  resolveControllers(s, humanFrames, events); // SIM-15/16: frames -> intents, actions, switching
  teamAiTick(s, events); // ai: jobs/targets for every uncontrolled player, keepers
  actionsTick(s, events); // action state machines (kicks happen at contact ticks)
  locomotionTick(s, events); // SIM-04
  bodyContactTick(s, events); // SIM-05
  ballTick(s, events); // SIM-01/02/03 (+ line crossing)
  contactsTick(s, events); // keepers, aerials, tackles, interceptions, first touch, dribble
  rulesTick(s, events); // RUL-01..10
  practiceRulesTick(s, events); // QF-1 (from MOD-04): set-piece practice re-awards its restart; no-op outside practice
  watchdogTick(s, events); // RUL-11
  // [QF-1] ball.idleT counts the ticks the ball has LAIN untouched in play (BRIEF §5 "the ball lies unreachable or
  // untouched for 8 s"): horizontal speed below T_RULES.ballLieSpeed, or held in a keeper's hands. A long ball still rolling
  // or bouncing away with the chasers after it is not lying: counted from its first touch it fired the watchdog the
  // moment it stopped, a step ahead of the arriving chasers (fuzz seed 303 #33). [QF-1 skeptic] Nor is a ball a field
  // player owns: a standing owner leaves a still ball at his feet untouched (SIM-06), so it aged while he kept it, and
  // when he was knocked down 8+ s later the released ball fired BALL_UNTOUCHED on that very tick.
  const b = s.ball;
  if (b.owner >= 0 && b.heldBy < 0) b.idleT = 0;
  else if (m.phase === MatchPhase.IN_PLAY && b.touchedTick !== s.tick &&
    (b.heldBy >= 0 || b.vx * b.vx + b.vz * b.vz < LIE2)) b.idleT++;
  if (b.passTarget >= 0 && b.idleT >= T_RULES.passDeadTicks && b.owner < 0 && b.heldBy < 0) endDeadPass(s);
}

/** Squared T_DRIBBLE.controlRadius + T_RULES.passDeadReach, m^2. */
const DEAD_REACH2 = (T_DRIBBLE.controlRadius + T_RULES.passDeadReach) * (T_DRIBBLE.controlRadius + T_RULES.passDeadReach);

/**
 * [QF-1] A pass that died short of its receiver (the ball has lain T_RULES.passDeadTicks) while he is not closing in
 * on it is over: ball.passTarget clears. Its "our pass in flight" claims (SIM-16 forced ownership of the receiver,
 * which also blocks the manual switch; TAI-07's receiver chase claim, which bypasses arrival times) otherwise held
 * forever: a weak pass stopped 17 m from a receiver steered elsewhere, a teammate 4 m from it never went and the user
 * could not switch to him (fuzz seed 919 #14: BALL_UNTOUCHED). A receiver walking onto it (idle-stick meet run, AI
 * RECEIVE) keeps the pass until he takes it.
 */
function endDeadPass(s: SimState): void {
  const b = s.ball;
  const r = b.passTarget;
  if (r < NUM_SLOTS && (r | 0) === r) {
    const p = s.players[r]!;
    if (p.active === 1) {
      const dx = b.x - p.x, dz = b.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= DEAD_REACH2) return;
      const toward = p.vx * dx + p.vz * dz; // |v| cos * d
      if (toward > 0 && toward * toward >= LIE2 * d2) return;
    }
  }
  b.passTarget = -1;
}

// ---------------------------------------------------------------- [FIN-P] sim + AI warm-up (sim/init.ts warmUpSim)
// The loading-screen warm-up plays this pipeline on scratch states; see the block comment in sim/init.ts. It lives here,
// with the pipeline it plays, and binds itself to init.ts (bindSimWarmUp below) so that init.ts imports nothing of the
// tick pipeline [FIN-P skeptic].

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

/** Sink for the warm-up's hashes (never read for anything else). */
const HASH_SINK = new Int32Array(1);

/**
 * One scratch tick as the app's loop runs it: [FIN-P] copyState(prev, s) first (the loop refreshes the interpolation
 * state before every tick) and a hashState every hashEvery ticks (the replay recorder), so the generated copier and
 * hasher are optimised too: run cold in the first match they boxed every double field they copied (3.8 KB a tick in
 * Chromium, the largest allocation of a frame, and the scavenges it brought landed in sim ticks). Cut-scenes are
 * skipped (Btn.SKIP edges, as the headless soak does).
 */
function warmTick(s: SimState, prev: SimState, frames: InputFrame[], ev: EventBuffer): void {
  copyState(prev, s);
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  if (isCutscene(s.match.phase) && s.match.phaseT % 2 === 0) {
    for (let h = 0; h < frames.length; h++) {
      frames[h]!.buttons |= Btn.SKIP;
      frames[h]!.cmd = Command.SKIP;
    }
  }
  step(s, frames, ev);
  if (s.tick % T_WARMUP.hashEvery === 0) HASH_SINK[0] = hashState(s);
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

/**
 * Play the warm-up (T_WARMUP.openPlayTicks of open play, then T_WARMUP.sceneTicks per restart scene) on a scratch state
 * made by `makeState` (initMatch). Returns the ticks run. Writes nothing but the scratch state.
 */
function warmUpSimImpl(makeState: (c: MatchConfig) => SimState, base: MatchConfig | null): number {
  if (warming) return 0;
  warming = true;
  let ran = 0;
  try {
    // [FIN-P] Three states, the first two thrown away: the first state built in a process generalises the hidden
    // classes (settleStateShapes), which leaves the object literals' boilerplates on deprecated maps; the next state
    // built migrates them and changes field types, and its array literals ([0, 0]) still start as small-integer arrays
    // that settling turns into packed doubles, while every later state gets them from the updated allocation sites as
    // holey doubles. The warm-up plays the third, built exactly like the match's own. Built after the warm-up instead
    // (the match's initMatch), the second state deoptimised some 90 optimised sim / AI functions at once and the third
    // the state copier and hasher ("wrong map"), all re-optimised in the first seconds of the match
    // (tests/unit/fin-p-warmup.test.ts).
    makeState(warmConfig(base));
    makeState(warmConfig(base));
    const s = makeState(warmConfig(base));
    // The interpolation state, built as the app builds it (app/liveState.ts cloneLiveState: the live maps).
    const prev = createSimState(s.config, s.squads);
    copyState(prev, s);
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let t = 0; t < T_WARMUP.openPlayTicks && phaseOf(s) !== MatchPhase.POST_MATCH; t++) { warmTick(s, prev, frames, ev); ran++; }
    for (let k = 0; k < SCENE_KIND.length; k++) {
      // Back to open play first (a restart is awarded from play), then the scene.
      for (let t = 0; t < T_WARMUP.sceneTicks && phaseOf(s) !== MatchPhase.IN_PLAY && phaseOf(s) !== MatchPhase.POST_MATCH; t++) { warmTick(s, prev, frames, ev); ran++; }
      if (phaseOf(s) !== MatchPhase.IN_PLAY) break;
      awardRestart(s, SCENE_KIND[k]!, SCENE_TEAM[k]!, SCENE_X[k]! * HALF_LENGTH, SCENE_Z[k]! * HALF_WIDTH, ev);
      for (let t = 0; t < T_WARMUP.sceneTicks && phaseOf(s) !== MatchPhase.POST_MATCH; t++) { warmTick(s, prev, frames, ev); ran++; }
    }
    // [FIN-P] Then a match start as the app makes the coming one: a fresh state and interpolation state (the states
    // built after a match has been played get some array literals from the updated allocation sites as holey doubles,
    // the state copier and hasher met them only here: "wrong map" in the first ticks of the match otherwise).
    const s2 = makeState(warmConfig(base));
    const prev2 = createSimState(s2.config, s2.squads);
    copyState(prev2, s2);
    for (let t = 0; t < T_WARMUP.restartTicks && phaseOf(s2) !== MatchPhase.POST_MATCH; t++) { warmTick(s2, prev2, frames, ev); ran++; }
  } finally {
    warming = false;
  }
  warmedTicks += ran;
  return ran;
}

bindSimWarmUp({ run: warmUpSimImpl, ticks: () => warmedTicks, phases: () => phasesSeen });
