/**
 * [MOD-05] Records (wins, draws, losses, goals, cups won) saved as progress. WAVE 0 STUB (FND-04).
 */
import type { MatchSummary, SettingsStore } from '../contracts/app';

export const RECORDS_PROGRESS_KEY = 'records';

export interface Records {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  cupsWon: number;
}

export function emptyRecords(): Records {
  return { played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, cupsWon: 0 };
}

export function loadRecords(settings: SettingsStore): Records {
  return { ...emptyRecords(), ...(settings.loadProgress<Partial<Records>>(RECORDS_PROGRESS_KEY) ?? {}) };
}

/** Add a finished match from `humanSide`'s point of view. WAVE 0: not wired yet (MOD-05). */
export function recordResult(settings: SettingsStore, summary: MatchSummary, humanSide: number): Records {
  const r = loadRecords(settings);
  if (humanSide !== 0 && humanSide !== 1) return r;
  const us = summary.teams[humanSide].goals;
  const them = summary.teams[1 - humanSide]!.goals;
  r.played++;
  r.goalsFor += us;
  r.goalsAgainst += them;
  if (summary.winner === humanSide) r.won++;
  else if (summary.winner === -1) r.drawn++;
  else r.lost++;
  settings.saveProgress(RECORDS_PROGRESS_KEY, r);
  return r;
}
