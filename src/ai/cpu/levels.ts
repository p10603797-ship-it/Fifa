/**
 * [TAI-12] Difficulty levels and team styles. Six levels (Beginner..Legend) differ in reaction time, decision
 * noise, look-ahead, execution error, pressing and tackle timing — never physics (T_LEVEL). Styles (possession,
 * counter-attack, direct, high press, wing play) weight CPU choices so clubs feel different.
 * Target: each level beats the one below in >= 65% of bot-v-bot matches (verified with tools/ladder.ts).
 *
 * levelParams(level): the T_LEVEL column of a Difficulty as one frozen LevelParams object (built once at module
 *   load, so the per-tick call allocates nothing). Every parameter is strictly monotonic from Beginner to Legend:
 *   reactionTicks, decisionNoise, executionError and tackleTimingTicks fall; lookAheadTicks, pressIntensity and
 *   shotThresholdXg (the CPU waits for better chances) rise. LevelParams holds AI parameters only: there is no
 *   physics, attribute or stamina field, so a level can never change what a player's body can do. An invalid level
 *   (not an integer 0..5) gets Professional, like createCpuBrainState's default.
 *
 * styleWeights(style): frozen StyleWeights per TeamStyle (LOCAL_TUNING.style, all 0..1, 0.5 = neutral, which is
 *   what the consumers treat as "no bias": carrier styleMul / safety multiplier, press.ts style factor, counter x2).
 *   Each style leads the league in its signature weight:
 *     POSSESSION  safety highest, directness / longShot / counter lowest (keep the ball, build patiently);
 *     COUNTER     counter highest, directness high, press lowest (sit off, break fast after winning the ball);
 *     DIRECT      progress and directness highest, long shots highest, dribble lowest (long balls forward);
 *     HIGH_PRESS  press highest, counter high (win it high and go). press 0.9 is the top of TAI-05's style factor
 *                 (x1.4): a high-press CPU reaches full press intensity (clamped to 1) from Professional up;
 *     WING_PLAY   width highest (crosses, wide play), dribble highest (beat the full-back).
 *   An unknown style gets NEUTRAL_STYLE (every weight 0.5).
 *
 * applyExecutionError(s, team, value, scale): value + rngGauss(s.rng) x scale x executionError of the team's CPU
 *   level. `scale` is the noise sd at Professional (executionError 1.0) in the value's own units (m of aim, 0..1 of
 *   power, rad of direction ...). Used on what a CPU writes into its InputFrame: the CPU's inputs get noisier at low
 *   levels; the physics never changes. Determinism: always exactly one rngGauss (4 draws of s.rng) whatever the
 *   arguments, so the stream position depends on the call sequence only; nothing but s.rng is touched; no
 *   allocation. Bad input never leaks into the frame: a non-finite or negative scale adds no noise, a non-finite
 *   value returns 0. An invalid team index or brain level uses Professional.
 */
import { Difficulty, TeamStyle } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';
import type { LevelParams, StyleWeights } from '../../contracts/systems';
import { T_AI, T_LEVEL } from '../../contracts/tuning';
import { rngGauss } from '../../sim/core/rng';

export const LOCAL_TUNING = { // TUNING-CR (TAI-12): move into contracts/tuning.ts as T_STYLE
  /**
   * StyleWeights per TeamStyle (index = TeamStyle), every weight 0..1, 0.5 = neutral. Field meanings: see
   * contracts/systems.ts StyleWeights (safety vs progress, directness = through / long balls and runs in behind,
   * width = crosses / wide play, dribble = dribbles and skills, longShot = long shots, press = pressing height and
   * intensity, counter = counter-attack urgency after winning the ball).
   */
  style: [
    // POSSESSION
    { safety: 0.85, progress: 0.35, directness: 0.2, width: 0.45, dribble: 0.55, longShot: 0.25, press: 0.55, counter: 0.25 },
    // COUNTER
    { safety: 0.45, progress: 0.65, directness: 0.75, width: 0.45, dribble: 0.55, longShot: 0.5, press: 0.3, counter: 0.95 },
    // DIRECT
    { safety: 0.3, progress: 0.85, directness: 0.85, width: 0.5, dribble: 0.3, longShot: 0.7, press: 0.5, counter: 0.6 },
    // HIGH_PRESS
    { safety: 0.5, progress: 0.6, directness: 0.5, width: 0.5, dribble: 0.5, longShot: 0.45, press: 0.9, counter: 0.7 },
    // WING_PLAY
    { safety: 0.55, progress: 0.55, directness: 0.4, width: 0.9, dribble: 0.65, longShot: 0.3, press: 0.5, counter: 0.5 },
  ] as readonly StyleWeights[],
} as const;

/** Number of difficulty levels (Beginner..Legend). */
export const LEVEL_COUNT = Difficulty.LEGEND + 1;
/** Number of team styles. */
export const STYLE_COUNT = TeamStyle.WING_PLAY + 1;

function buildLevel(i: number): LevelParams {
  return Object.freeze({
    reactionTicks: T_LEVEL.reactionTicks[i]!,
    decisionNoise: T_LEVEL.decisionNoise[i]!,
    lookAheadTicks: T_LEVEL.lookAheadTicks[i]!,
    executionError: T_LEVEL.executionError[i]!,
    pressIntensity: T_LEVEL.pressIntensity[i]!,
    tackleTimingTicks: T_LEVEL.tackleTimingTicks[i]!,
    shotThresholdXg: T_LEVEL.shotThresholdXg[i]!,
  });
}

const LEVELS: readonly LevelParams[] = (() => {
  const out: LevelParams[] = [];
  for (let i = 0; i < LEVEL_COUNT; i++) out.push(buildLevel(i));
  return Object.freeze(out);
})();

const PROFESSIONAL = LEVELS[Difficulty.PROFESSIONAL]!;

/** Every weight 0.5: no style bias (unknown styles). */
export const NEUTRAL_STYLE: StyleWeights = Object.freeze({
  safety: 0.5, progress: 0.5, directness: 0.5, width: 0.5, dribble: 0.5, longShot: 0.5, press: 0.5, counter: 0.5,
});

const STYLES: readonly StyleWeights[] = (() => {
  const out: StyleWeights[] = [];
  for (let i = 0; i < STYLE_COUNT; i++) {
    const w = LOCAL_TUNING.style[i];
    out.push(w ? Object.freeze({ ...w }) : NEUTRAL_STYLE);
  }
  return Object.freeze(out);
})();

/** True for an integer in [0, n). */
function validIndex(v: number, n: number): boolean {
  return v === (v | 0) && v >= 0 && v < n;
}

/** AI parameters of a difficulty level (frozen, shared; Professional for an invalid level). Never physics. */
export function levelParams(level: Difficulty): LevelParams {
  return validIndex(level, LEVEL_COUNT) ? LEVELS[level]! : PROFESSIONAL;
}

/** Choice weights of a team style (frozen, shared; NEUTRAL_STYLE for an unknown style). */
export function styleWeights(style: TeamStyle): StyleWeights {
  return validIndex(style, STYLE_COUNT) ? STYLES[style]! : NEUTRAL_STYLE;
}

/**
 * [QF-11] Difficulty level that drives team `team`'s AI: its CPU brain's level when the team has an active CPU brain,
 * else Professional (a human side's teammates and keeper always play at Professional; an invalid level too).
 */
export function teamLevel(s: SimState, team: number): Difficulty {
  const t = validIndex(team, s.teams.length) ? s.teams[team] : undefined;
  if (!t || t.cpu.active !== 1) return Difficulty.PROFESSIONAL;
  const lv = t.cpu.level;
  return validIndex(lv, LEVEL_COUNT) ? lv : Difficulty.PROFESSIONAL;
}

/**
 * [QF-11] Entry of a per-level T_LEVEL table (index = Difficulty) at team `team`'s AI level (teamLevel); the
 * Professional entry for a short table or a non-finite value. The extra tables (beyond LevelParams) are AI parameters
 * only, read where they apply (contracts/systems.ts LevelParams stays the seven TAI-12 fields).
 */
export function levelValue(s: SimState, team: number, table: readonly number[]): number {
  const v = table[teamLevel(s, team)];
  if (v !== undefined && Number.isFinite(v)) return v;
  const pro = table[Difficulty.PROFESSIONAL];
  return pro !== undefined && Number.isFinite(pro) ? pro : 0;
}

/**
 * [QF-11] Decision-noise multiplier for a player of composure `composure` under a CPU of difficulty `level`
 * (T_AI.composureNoise*, weighted by T_LEVEL.composureNoiseWeight of the level): 1 at the reference, smaller for a calm
 * player, larger for a nervous one, clamped; 1 for a non-finite attribute or a level whose weight is 0 (World Class
 * and Legend decide alike whatever the player: a spread of noise round a small level noise narrows the gap between
 * the top levels, since the cost of noise is steepest near none). An invalid level uses Professional's weight.
 */
export function composureNoiseMul(composure: number, level: Difficulty = Difficulty.PROFESSIONAL): number {
  if (!Number.isFinite(composure)) return 1;
  const wt = T_LEVEL.composureNoiseWeight[validIndex(level, LEVEL_COUNT) ? level : Difficulty.PROFESSIONAL];
  const w = wt !== undefined && Number.isFinite(wt) ? wt : 1;
  const m = 1 + (w * T_AI.composureNoiseSlope * (T_AI.composureNoiseRef - composure)) / 30;
  return m < T_AI.composureNoiseMin ? T_AI.composureNoiseMin : m > T_AI.composureNoiseMax ? T_AI.composureNoiseMax : m;
}

/**
 * `value` plus deterministic execution noise for team `team`'s CPU: rngGauss(s.rng) x scale x executionError of the
 * team's brain level (scale = sd at Professional, in the value's units). Always consumes exactly one rngGauss
 * (4 draws); touches nothing but s.rng; finite output for any input (see the header).
 */
export function applyExecutionError(s: SimState, team: number, value: number, scale: number): number {
  const g = rngGauss(s.rng);
  if (!Number.isFinite(value)) return 0;
  if (!(scale > 0) || !Number.isFinite(scale)) return value;
  const t = validIndex(team, s.teams.length) ? s.teams[team] : undefined;
  const lv = t ? levelParams(t.cpu.level) : PROFESSIONAL;
  const v = value + g * scale * lv.executionError;
  return Number.isFinite(v) ? v : value;
}
