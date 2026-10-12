/**
 * [MOD-01] Kick-Off flow and match configuration. WAVE 0 STUB (FND-04).
 *
 * MOD-01: the Kick-Off flow mode-setup -> team-select -> side-select -> match-settings -> loading, collecting
 * KickOffChoices (teams, kits, difficulty, half length, friendly/cup rules, day/night, rule toggles, side
 * assignment per device) and building the MatchSetup. Play a Friend (same iPad) is the same flow with two humans.
 */
import type { AppContext, HumanBinding, MatchSetup } from '../contracts/app';
import { ControllerKind, type Difficulty, type FormationId, type KitSlot } from '../contracts/enums';
import { defaultSetup } from './setup';

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
  /** Device assignment from side select: human index -> side and devices. */
  humans?: { human: number; side: number; deviceIds: string[] }[];
}

/** Build the MatchSetup for a Kick-Off / local friendly. WAVE 0: applies team and rule choices over defaultSetup. */
export function buildKickOffSetup(ctx: AppContext, choices: KickOffChoices = {}): MatchSetup {
  const setup = defaultSetup(ctx);
  const c = setup.config;
  if (choices.homeClub !== undefined) c.homeClub = choices.homeClub;
  if (choices.awayClub !== undefined) c.awayClub = choices.awayClub;
  if (choices.homeKit !== undefined) c.homeKit = choices.homeKit;
  if (choices.awayKit !== undefined) c.awayKit = choices.awayKit;
  if (choices.homeFormation !== undefined) c.homeFormation = choices.homeFormation;
  if (choices.awayFormation !== undefined) c.awayFormation = choices.awayFormation;
  if (choices.difficulty !== undefined) c.difficulty = choices.difficulty;
  if (choices.halfMinutes !== undefined) c.halfMinutes = Math.max(2, Math.min(10, Math.round(choices.halfMinutes)));
  if (choices.cupRules !== undefined) c.cupRules = choices.cupRules ? 1 : 0;
  if (choices.night !== undefined) c.night = choices.night ? 1 : 0;
  if (choices.offside !== undefined) c.offside = choices.offside ? 1 : 0;
  if (choices.fouls !== undefined) c.fouls = choices.fouls ? 1 : 0;
  if (choices.humans) {
    const bindings: HumanBinding[] = [];
    for (const h of choices.humans) {
      const cfg = c.humans[h.human];
      if (!cfg) continue;
      if (h.side < 0) {
        cfg.kind = ControllerKind.NONE;
        cfg.side = -1;
        continue;
      }
      cfg.kind = ControllerKind.HUMAN;
      cfg.side = h.side;
      bindings.push({ human: h.human, deviceIds: h.deviceIds.slice() });
    }
    setup.bindings = bindings;
  }
  return setup;
}
