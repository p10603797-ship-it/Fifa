/**
 * [MOD-02] Cup: draw, bracket, quick results, save. WAVE 0 STUB (FND-04).
 * MOD-02: 8- or 16-team knockout for one or two humans; other ties use a quick ratings-based result; progress is
 * saved with ctx.settings.saveProgress(CUP_PROGRESS_KEY, ...).
 */
import type { AppContext, MatchSetup, MatchSummary } from '../contracts/app';

export const CUP_PROGRESS_KEY = 'cup';

export interface CupTie {
  home: number;
  away: number;
  /** Goals, -1 until played. */
  homeGoals: number;
  awayGoals: number;
  /** Shoot-out result when level, else null. */
  shootout: [number, number] | null;
  winner: number;
}

export interface CupState {
  size: 8 | 16;
  /** Club indices controlled by humans (one or two). */
  humanClubs: number[];
  /** Rounds of ties, first round first. */
  rounds: CupTie[][];
  round: number;
  seed: number;
  finished: boolean;
}

export interface CupRun {
  readonly state: CupState;
  /** Setup for the human tie of the current round, or null when the human is out / the cup is over. */
  nextMatch(): MatchSetup | null;
  /** Record the human tie result and quick-sim the rest of the round. */
  recordResult(summary: MatchSummary): void;
  save(): void;
}

export function createCup(ctx: AppContext, opts: { size: 8 | 16; humanClubs: number[] }): CupRun {
  void ctx;
  void opts;
  throw new Error('not implemented (MOD-02)');
}

export function loadCup(ctx: AppContext): CupRun | null {
  void ctx;
  return null;
}
