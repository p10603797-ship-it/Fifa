/**
 * [MOD-01] Kick-Off flow and match configuration (BRIEF §11 Modes: Kick-Off = you against the CPU; Play a Friend on the
 * same iPad = the same flow with two humans; §12 Screens: Mode setup -> Team and kit select -> Side select -> Match
 * settings -> Loading).
 *
 *  - KickOffChoices: what the Kick-Off screens collect (teams, kits, formations, difficulty, half length,
 *    friendly / cup rules, day / night, rule toggles, side assignment per device).
 *  - buildKickOffSetup(ctx, choices): the MatchSetup (modes/setup buildSetup: fresh seed, clash-checked kits, clubs'
 *    formations, humans consistent with bindings) with the lifetime records hooked to onFinish.
 *  - Flow helpers: KICKOFF_STEPS, nextKickOffScreen(from) (null after match settings = start the match),
 *    rematchSetup(setup) (a fresh seed, nothing else), changeTeamsTarget(setup) (team select with the same choices).
 *  - choicesFromSettings / rememberChoices: the last choices live in settings.match (clubs, kits, home formation,
 *    difficulty, half length, day / night, offside, fouls, replays), so the next Kick-Off and Play now start there.
 */
import type { AppContext, MatchSetup, ScreenId, ScreenParams } from '../contracts/app';
import type { Difficulty, FormationId, KitSlot } from '../contracts/enums';
import { ModeId } from '../contracts/enums';
import type { Settings } from '../contracts/settings';
import type { MatchConfig } from '../contracts/state';
import { withRecords } from './records';
import { buildSetup, clampDifficulty, clampHalfMinutes, reseedSetup, type MatchChoices } from './setup';

/** Choices collected by the Kick-Off screens. Every field is optional; missing ones use settings.match. */
export interface KickOffChoices {
  homeClub?: number;
  awayClub?: number;
  homeKit?: KitSlot;
  awayKit?: KitSlot;
  homeFormation?: FormationId;
  awayFormation?: FormationId;
  difficulty?: Difficulty;
  halfMinutes?: number;
  cupRules?: boolean;
  night?: boolean;
  offside?: boolean;
  fouls?: boolean;
  replays?: boolean;
  /** Device assignment from side select: human index -> side and devices. */
  humans?: { human: number; side: number; deviceIds: string[] }[];
  /** KICK_OFF (default) or FRIEND_LOCAL. */
  mode?: ModeId.KICK_OFF | ModeId.FRIEND_LOCAL;
}

/** Screens of the Kick-Off / Play a Friend flow, in order (the session start follows the last one). */
export const KICKOFF_STEPS: readonly ScreenId[] = ['mode-setup', 'team-select', 'side-select', 'match-settings'];

/** The screen after `from` in the Kick-Off flow; null after the last step (start the match). Unknown -> first step. */
export function nextKickOffScreen(from: ScreenId | null): ScreenId | null {
  if (from === null) return KICKOFF_STEPS[0]!;
  const i = KICKOFF_STEPS.indexOf(from);
  if (i < 0) return KICKOFF_STEPS[0]!;
  return i + 1 < KICKOFF_STEPS.length ? KICKOFF_STEPS[i + 1]! : null;
}

/** The screen before `from` (Back), or 'main' from the first step. */
export function prevKickOffScreen(from: ScreenId): ScreenId {
  const i = KICKOFF_STEPS.indexOf(from);
  return i > 0 ? KICKOFF_STEPS[i - 1]! : 'main';
}

/** Build the MatchSetup for a Kick-Off / local friendly (recorded in the lifetime records when it finishes). */
export function buildKickOffSetup(ctx: AppContext, choices: KickOffChoices = {}): MatchSetup {
  const mode = choices.mode === ModeId.FRIEND_LOCAL ? ModeId.FRIEND_LOCAL : ModeId.KICK_OFF;
  const c: MatchChoices = { ...choices, mode };
  return withRecords(ctx.settings, buildSetup(ctx, c));
}

/** Rematch: the same setup with a new seed (teams, kits, rules, humans, bindings and callbacks unchanged). */
export function rematchSetup(setup: MatchSetup, seed?: number): MatchSetup {
  return reseedSetup(setup, seed);
}

/** Choices that rebuild `config` (for Change Teams and remembering). Pure. */
export function choicesFromConfig(config: Readonly<MatchConfig>): KickOffChoices {
  return {
    homeClub: config.homeClub, awayClub: config.awayClub, homeKit: config.homeKit, awayKit: config.awayKit,
    homeFormation: config.homeFormation, awayFormation: config.awayFormation, difficulty: config.difficulty,
    halfMinutes: config.halfMinutes, cupRules: config.cupRules === 1, night: config.night === 1, offside: config.offside === 1,
    fouls: config.fouls === 1, replays: config.replaySeconds > 0,
    mode: config.mode === ModeId.FRIEND_LOCAL ? ModeId.FRIEND_LOCAL : ModeId.KICK_OFF,
  };
}

/** Change Teams after a match: team select with the finished match's choices as the starting point. */
export function changeTeamsTarget(setup: MatchSetup | null): [ScreenId, ScreenParams] {
  return ['team-select', setup ? { choices: choicesFromConfig(setup.config) } : {}];
}

/** Choices from the saved match defaults. Pure. */
export function choicesFromSettings(settings: Readonly<Settings>): KickOffChoices {
  const m = settings.match;
  return {
    homeClub: m.homeClub, awayClub: m.awayClub, homeKit: m.homeKit, awayKit: m.awayKit, homeFormation: m.homeFormation,
    difficulty: m.difficulty, halfMinutes: m.halfMinutes, night: m.night, offside: m.offside, fouls: m.fouls, replays: m.replays,
  };
}

/** Save the given choices as the match defaults (only the fields settings.match holds). */
export function rememberChoices(ctx: Pick<AppContext, 'settings' | 'clubs'>, choices: KickOffChoices): void {
  const n = ctx.clubs.length;
  const club = (v: number | undefined): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && (n === 0 || v < n);
  const kit = (v: unknown): v is KitSlot => v === 0 || v === 1;
  try {
    ctx.settings.update((s) => {
      const m = s.match;
      if (club(choices.homeClub)) m.homeClub = choices.homeClub;
      if (club(choices.awayClub)) m.awayClub = choices.awayClub;
      if (kit(choices.homeKit)) m.homeKit = choices.homeKit;
      if (kit(choices.awayKit)) m.awayKit = choices.awayKit;
      if (typeof choices.homeFormation === 'number' && Number.isInteger(choices.homeFormation)) m.homeFormation = choices.homeFormation;
      if (choices.difficulty !== undefined) m.difficulty = clampDifficulty(choices.difficulty);
      if (choices.halfMinutes !== undefined) m.halfMinutes = clampHalfMinutes(choices.halfMinutes);
      if (choices.night !== undefined) m.night = !!choices.night;
      if (choices.offside !== undefined) m.offside = !!choices.offside;
      if (choices.fouls !== undefined) m.fouls = !!choices.fouls;
      if (choices.replays !== undefined) m.replays = !!choices.replays;
    });
  } catch {
    /* storage blocked: nothing to remember */
  }
}

/** Remember the choices of a setup that is about to start. */
export function rememberSetup(ctx: Pick<AppContext, 'settings' | 'clubs'>, setup: MatchSetup): void {
  const c = choicesFromConfig(setup.config);
  rememberChoices(ctx, c);
}
