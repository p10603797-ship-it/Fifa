/**
 * [MOD-03] Shoot-out mode (BRIEF §11 "Shoot-out: Straight to penalties"; §5 / RUL-07 shoot-out rules: five each, then
 * sudden death, every player takes one before anyone repeats).
 *
 *  - buildShootoutSetup(ctx, choices): a MatchSetup with config.mode = SHOOT_OUT and config.startPhase = SHOOT_OUT
 *    (PRE_MATCH -> SHOOT_OUT -> POST_MATCH; cup rules on). Teams, kits and the human sides come from the same choices
 *    as Kick-Off (side select fills `humans`); a side without a human is the CPU. Both teams' kickers are picked and
 *    ordered by the sim (RUL-07 orders each squad); shootoutKickers(club) previews the likely first five for menus.
 *  - Post-match: the session shows the full-time screen with the summary (summary.shootout holds the tally and
 *    summary.winner the winner); shootoutHeadline(summary, clubs) is the winner banner text for that screen;
 *    Rematch = session.restart() / rematchShootout(setup) (same sides, a new seed). Results go to the records.
 */
import type { AppContext, MatchSetup, MatchSummary } from '../contracts/app';
import type { Club, PlayerData } from '../contracts/data';
import { MatchPhase, ModeId, Role } from '../contracts/enums';
import type { KickOffChoices } from './kickoff';
import { withRecords } from './records';
import { buildSetup, reseedSetup } from './setup';

export type ShootoutChoices = Omit<KickOffChoices, 'mode' | 'halfMinutes' | 'cupRules'>;

export function buildShootoutSetup(ctx: AppContext, choices: ShootoutChoices = {}): MatchSetup {
  const setup = buildSetup(ctx, { ...choices, mode: ModeId.SHOOT_OUT });
  // buildSetup applies the mode rules; restate the two that define the mode.
  setup.config.startPhase = MatchPhase.SHOOT_OUT;
  setup.config.cupRules = 1;
  return withRecords(ctx.settings, setup);
}

/** Rematch: same teams and sides, a new seed. */
export function rematchShootout(setup: MatchSetup, seed?: number): MatchSetup {
  return reseedSetup(setup, seed);
}

/** Penalty-taking score of a squad member (finishing, composure, shot power). Pure. */
export function penaltyScore(p: Readonly<PlayerData>): number {
  return p.finishing * 0.45 + p.composure * 0.35 + p.shotPower * 0.2;
}

/** Likely first `n` kickers of a club (starters, outfield, best penalty score first; ties by squad order). Pure. */
export function shootoutKickers(club: Readonly<Club> | undefined, n = 5): number[] {
  if (!club) return [];
  const idx: number[] = [];
  const squad = club.squad;
  for (let i = 0; i < squad.length && i < 11; i++) if (squad[i]!.pos !== Role.GK) idx.push(i);
  idx.sort((a, b) => penaltyScore(squad[b]!) - penaltyScore(squad[a]!) || a - b);
  return idx.slice(0, Math.max(0, n));
}

/** Winner banner for the full-time screen, e.g. "NOR win 5-4 on penalties". Pure. */
export function shootoutHeadline(summary: MatchSummary | null, clubs: readonly Club[], homeClub: number, awayClub: number): string {
  if (!summary) return 'Shoot-out abandoned';
  const so = summary.shootout;
  const code = (team: number): string => clubs[team === 0 ? homeClub : awayClub]?.code ?? (team === 0 ? 'HOME' : 'AWAY');
  if (summary.winner !== 0 && summary.winner !== 1) return so ? `Level ${so[0]}-${so[1]}` : 'No winner';
  const w = summary.winner;
  if (!so) return `${code(w)} win`;
  return `${code(w)} win ${so[w]}-${so[1 - w]} on penalties`;
}
