/**
 * [MOD-05] Lifetime records saved as progress (settings.saveProgress(RECORDS_PROGRESS_KEY)).
 *
 * Records count finished matches from a human's point of view (a match with humans on both sides counts once, for
 * the home side; CPU-only and practice matches never count): played / won / drawn / lost (a shoot-out decides a
 * level match: summary.winner), goals for / against (regulation + extra time, never shoot-out goals), biggest win
 * (largest goal margin, then most goals scored; ties keep the earlier one), current and best winning streak, cups
 * won. Stored with a schema version; anything malformed loads as empty records (never throws).
 *
 * recordMatch(settings, setup, summary) is the one call a mode needs at POST_MATCH (withRecords wraps a setup's
 * onFinish with it); recordResult(settings, summary, humanSide) is the lower-level form; recordCupWon adds a cup.
 */
import type { MatchSetup, MatchSummary, SettingsStore } from '../contracts/app';
import { ControllerKind, ModeId, PracticeKind } from '../contracts/enums';
import type { MatchConfig } from '../contracts/state';

export const RECORDS_PROGRESS_KEY = 'records';
export const RECORDS_SCHEMA = 1;

export interface BiggestWin {
  goalsFor: number;
  goalsAgainst: number;
  /** Club index the human played as, and the opponent club index. */
  club: number;
  opponent: number;
}

export interface Records {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  cupsWon: number;
  /** Largest winning margin so far, or null. */
  biggestWin: BiggestWin | null;
  /** Wins in a row now, and the best run. */
  streak: number;
  bestStreak: number;
}

interface StoredRecords extends Records {
  schema: number;
}

export function emptyRecords(): Records {
  return {
    played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, cupsWon: 0, biggestWin: null, streak: 0, bestStreak: 0,
  };
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function sanitizeBiggest(v: unknown): BiggestWin | null {
  if (!v || typeof v !== 'object') return null;
  const b = v as Partial<BiggestWin>;
  const r: BiggestWin = { goalsFor: count(b.goalsFor), goalsAgainst: count(b.goalsAgainst), club: count(b.club), opponent: count(b.opponent) };
  return r.goalsFor > r.goalsAgainst ? r : null;
}

/** Records from a stored value (any shape; missing or bad fields become 0). Pure. */
export function sanitizeRecords(v: unknown): Records {
  const r = emptyRecords();
  if (!v || typeof v !== 'object') return r;
  const o = v as Partial<StoredRecords>;
  if (o.schema !== undefined && o.schema !== RECORDS_SCHEMA) return r;
  r.played = count(o.played);
  r.won = count(o.won);
  r.drawn = count(o.drawn);
  r.lost = count(o.lost);
  r.goalsFor = count(o.goalsFor);
  r.goalsAgainst = count(o.goalsAgainst);
  r.cupsWon = count(o.cupsWon);
  r.biggestWin = sanitizeBiggest(o.biggestWin);
  r.streak = count(o.streak);
  r.bestStreak = Math.max(count(o.bestStreak), r.streak);
  return r;
}

export function loadRecords(settings: SettingsStore): Records {
  try {
    return sanitizeRecords(settings.loadProgress<unknown>(RECORDS_PROGRESS_KEY));
  } catch {
    return emptyRecords();
  }
}

function save(settings: SettingsStore, r: Records): void {
  try {
    settings.saveProgress<StoredRecords>(RECORDS_PROGRESS_KEY, { schema: RECORDS_SCHEMA, ...r });
  } catch {
    /* storage blocked: records live for this session only */
  }
}

/** Apply one result to records (pure; returns a new object). */
export function applyResult(prev: Readonly<Records>, summary: MatchSummary, humanSide: number, club = -1, opponent = -1): Records {
  const r: Records = { ...prev, biggestWin: prev.biggestWin ? { ...prev.biggestWin } : null };
  if (humanSide !== 0 && humanSide !== 1) return r;
  const us = count(summary.teams[humanSide]?.goals);
  const them = count(summary.teams[1 - humanSide]?.goals);
  r.played++;
  r.goalsFor += us;
  r.goalsAgainst += them;
  if (summary.winner === humanSide) {
    r.won++;
    r.streak++;
    if (r.streak > r.bestStreak) r.bestStreak = r.streak;
    const b = r.biggestWin;
    const margin = us - them;
    if (margin > 0 && (!b || margin > b.goalsFor - b.goalsAgainst || (margin === b.goalsFor - b.goalsAgainst && us > b.goalsFor))) {
      r.biggestWin = { goalsFor: us, goalsAgainst: them, club: Math.max(0, club), opponent: Math.max(0, opponent) };
    }
  } else if (summary.winner === 1 - humanSide) {
    r.lost++;
    r.streak = 0;
  } else {
    r.drawn++;
    r.streak = 0;
  }
  return r;
}

/** Add a finished match from `humanSide`'s point of view and save. */
export function recordResult(settings: SettingsStore, summary: MatchSummary, humanSide: number, club = -1, opponent = -1): Records {
  const before = loadRecords(settings);
  if (humanSide !== 0 && humanSide !== 1) return before;
  const r = applyResult(before, summary, humanSide, club, opponent);
  save(settings, r);
  return r;
}

/** The side whose result counts for the records: the home side if a human plays it, else the away side, else -1. */
export function humanSideOf(config: Readonly<MatchConfig>): number {
  let side = -1;
  for (const h of config.humans) {
    if (h.kind !== ControllerKind.HUMAN || (h.side !== 0 && h.side !== 1)) continue;
    if (side < 0 || h.side < side) side = h.side;
  }
  return side;
}

/** True when a finished match of this config counts for the records (not practice, not online-only bench runs). */
export function countsForRecords(config: Readonly<MatchConfig>): boolean {
  return config.mode !== ModeId.PRACTICE && config.mode !== ModeId.BENCH && config.practice === PracticeKind.NONE;
}

/** Record a finished match of `setup` (no-op for quits, practice, CPU-only or a null summary). */
export function recordMatch(settings: SettingsStore, setup: Pick<MatchSetup, 'config'>, summary: MatchSummary | null, quit = false): Records | null {
  if (quit || !summary || !countsForRecords(setup.config)) return null;
  const side = humanSideOf(setup.config);
  if (side < 0) return null;
  const club = side === 0 ? setup.config.homeClub : setup.config.awayClub;
  const opp = side === 0 ? setup.config.awayClub : setup.config.homeClub;
  return recordResult(settings, summary, side, club, opp);
}

/** Wrap a setup's onFinish so the finished match is recorded first (idempotent: wrapping twice records once). */
export function withRecords<T extends MatchSetup>(settings: SettingsStore, setup: T): T {
  const tagged = setup as T & { __records?: boolean };
  if (tagged.__records) return setup;
  const inner = setup.onFinish;
  const wrapped: T & { __records?: boolean } = {
    ...setup,
    onFinish: (summary: MatchSummary | null, quit: boolean) => {
      try {
        recordMatch(settings, wrapped, summary, quit);
      } catch {
        /* records never break the end of a match */
      }
      inner?.(summary, quit);
    },
  };
  Object.defineProperty(wrapped, '__records', { value: true, enumerable: false });
  return wrapped;
}

/** Add a won cup and save. */
export function recordCupWon(settings: SettingsStore): Records {
  const r = loadRecords(settings);
  r.cupsWon++;
  save(settings, r);
  return r;
}
