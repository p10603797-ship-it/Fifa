/**
 * [TAI-12] Difficulty levels and team styles. Six levels (Beginner..Legend) differ in reaction time, decision
 * noise, look-ahead, execution error, pressing and tackle timing — never physics (T_LEVEL). Styles (possession,
 * counter-attack, direct, high press, wing play) weight CPU choices so clubs feel different.
 * Target: each level beats the one below in >= 65% of bot-v-bot matches.
 */
import type { Difficulty, TeamStyle } from '../../contracts/enums';
import type { LevelParams, StyleWeights } from '../../contracts/systems';
import { T_LEVEL } from '../../contracts/tuning';

const LEVELS: LevelParams[] = [0, 1, 2, 3, 4, 5].map((i) => ({
  reactionTicks: T_LEVEL.reactionTicks[i]!, decisionNoise: T_LEVEL.decisionNoise[i]!, lookAheadTicks: T_LEVEL.lookAheadTicks[i]!,
  executionError: T_LEVEL.executionError[i]!, pressIntensity: T_LEVEL.pressIntensity[i]!, tackleTimingTicks: T_LEVEL.tackleTimingTicks[i]!,
  shotThresholdXg: T_LEVEL.shotThresholdXg[i]!,
}));

const NEUTRAL: StyleWeights = { safety: 0.5, progress: 0.5, directness: 0.5, width: 0.5, dribble: 0.5, longShot: 0.5, press: 0.5, counter: 0.5 };

export function levelParams(level: Difficulty): LevelParams { return LEVELS[level] ?? LEVELS[3]!; }
export function styleWeights(style: TeamStyle): StyleWeights { return NEUTRAL; }
