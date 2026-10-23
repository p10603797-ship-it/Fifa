/**
 * [MOD-02] Cup: draw, bracket, quick results, save (BRIEF §11 "Cup: An 8- or 16-team knockout against bots, for one or
 * two humans. Other ties use a quick ratings-based result. Progress saves."; §5 cup rules: extra time, then a
 * shoot-out; no cup tie ends level).
 *
 * MODEL (CupState, plain JSON): `clubs` = the drawn bracket order (club indices); rounds[0] pairs clubs (0,1), (2,3),
 * ...; tie j of round r+1 is the winners of ties 2j and 2j+1 of round r (home / away -1 until known). A tie is unplayed
 * while homeGoals < 0. winner = winning club index (-1 until played). `round` = first round with an unplayed tie;
 * `finished` once the final is played; `champion` = its winner. `rng` is the uint32 state of the cup's own seeded
 * generator (mulberry32), so a saved cup continues deterministically.
 *
 * HUMANS: humanClubs[i] is human i's club. One human: humanClubs = [club]. Two humans, co-op (coop = true): one club,
 * both humans on its side. Two humans, opposing paths: two clubs drawn into opposite halves, so they can meet only in
 * the final, where human 0 plays his club's side and human 1 the other. In a tie with one human club only that
 * club's human(s) play; the other human sits out. Devices: cupBindings (one human: every local device; two humans:
 * P1 touch + keyboard (+ the first pad when there are two), P2 the other pad, plus ANY_DEVICE so a pad that connects
 * later joins P2).
 *
 * FLOW: createCup draws (seeded) and saves. nextMatch() = MatchSetup of the pending human tie of the current round
 * (config.mode CUP, cupRules 1, the cup's difficulty and half length) whose onFinish records the result (a quit
 * leaves the tie unplayed so it can be replayed), adds the match to the lifetime records, quick-sims the CPU ties of
 * the round, advances the bracket (advanceCup: other results appear after the human's match; once no human is left
 * the cup plays out to the end), saves, and then calls the caller's onFinished. simulateRest() also quick-sims
 * pending human ties. A human champion adds a cup to the records once.
 *
 * QUICK RESULT (quickResult, CPU-only ties): goals per side ~ Poisson(lambda) sampled from the cumulative table,
 * lambda = QUICK.baseGoals * e^(QUICK.ratingSlope * (own rating - other rating)) clamped; level -> extra time with
 * lambda / 3; still level -> a shoot-out (five each, then sudden death) with a per-kick conversion from the rating.
 *
 * SAVE: settings.saveProgress(CUP_PROGRESS_KEY, { schema: CUP_SCHEMA, state }); loadCup validates everything and
 * returns null for a missing, older-schema or malformed save (never throws).
 */
import type { AppContext, DeviceInfo, HumanBinding, MatchSetup, MatchSummary } from '../contracts/app';
import type { Club } from '../contracts/data';
import { Difficulty, ModeId } from '../contracts/enums';
import { T_CUP_QUICK } from '../contracts/tuning';
import { ANY_DEVICE } from '../app/localInput';
import { newMatchSeed } from '../app/session';
import { recordCupWon, recordMatch } from './records';
import { buildSetup, clampDifficulty, clampHalfMinutes, type HumanChoice } from './setup';

export const CUP_PROGRESS_KEY = 'cup';
export const CUP_SCHEMA = 1;

/** Quick-result model constants: contracts/tuning.ts T_CUP_QUICK ([TUN-2]; the old name is kept). */
export const QUICK = T_CUP_QUICK;

export interface CupTie {
  home: number;
  away: number;
  /** Goals, -1 until played. */
  homeGoals: number;
  awayGoals: number;
  /** Shoot-out result when level, else null. */
  shootout: [number, number] | null;
  winner: number;
  /** The tie went to extra time. */
  extraTime?: boolean;
  /** Result came from the quick ratings-based model (CPU tie or simulated). */
  quick?: boolean;
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
  /** Two humans on one club. */
  coop?: boolean;
  /** Number of humans (1 or 2). */
  humans?: number;
  /** Drawn bracket order (club indices). */
  clubs?: number[];
  /** State of the cup's generator (uint32). */
  rng?: number;
  /** Winner of the final, -1 until then. */
  champion?: number;
  difficulty?: Difficulty;
  halfMinutes?: number;
  /** The human champion was added to the records. */
  cupRecorded?: boolean;
}

export interface CupMatchData {
  kind: 'cup';
  seed: number;
  round: number;
  tie: number;
}

export interface NextMatchOptions {
  /** Called after the cup recorded (or skipped, on a quit) the result. Navigation belongs here. */
  onFinished?: (summary: MatchSummary | null, quit: boolean) => void;
}

export interface CupRun {
  readonly state: CupState;
  /** Setup for the human tie of the current round, or null when the human is out / the cup is over. */
  nextMatch(opts?: NextMatchOptions): MatchSetup | null;
  /** Record the human tie result and quick-sim the rest of the round. */
  recordResult(summary: MatchSummary, at?: { round: number; tie: number }): boolean;
  save(): void;
  /** The pending human tie of the current round, or null. */
  pendingTie(): { round: number; tie: number } | null;
  /** True while a human club is still in the cup and it is not finished. */
  humanAlive(): boolean;
  /** Quick-sim the pending human tie (debug / e2e hook). Returns false when there is none. */
  simulateHumanTie(): boolean;
  /** Quick-sim every remaining tie to the end. */
  simulateRest(): void;
}

// ================================================================ seeded generator

/** mulberry32 step over a holder's uint32 state; returns [0, 1). */
export function nextRandom(h: { rng: number }): number {
  h.rng = (h.rng + 0x6d2b79f5) >>> 0;
  let t = h.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randInt(h: { rng: number }, n: number): number {
  return Math.min(n - 1, Math.floor(nextRandom(h) * n));
}

function shuffle<T>(h: { rng: number }, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(h, i + 1);
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

// ================================================================ pure model

export function roundCount(size: 8 | 16): number {
  return size === 16 ? 4 : 3;
}

/** Display name of round r for a cup of `size`. */
export function roundName(size: 8 | 16, r: number): string {
  const left = roundCount(size) - r;
  if (left <= 1) return 'Final';
  if (left === 2) return 'Semi-finals';
  if (left === 3) return 'Quarter-finals';
  return 'Round of 16';
}

function emptyTie(home = -1, away = -1): CupTie {
  return { home, away, homeGoals: -1, awayGoals: -1, shootout: null, winner: -1 };
}

export function isPlayed(t: Readonly<CupTie>): boolean {
  return t.homeGoals >= 0 && t.awayGoals >= 0 && t.winner >= 0;
}

/**
 * Seeded draw: the bracket order of `size` clubs out of `clubCount`, humans included; two opposing humans end up in
 * opposite halves. Pure given the generator state.
 */
export function drawCup(h: { rng: number }, clubCount: number, size: 8 | 16, humanClubs: readonly number[], coop: boolean): number[] {
  const humans = Array.from(new Set(humanClubs.filter((c) => Number.isInteger(c) && c >= 0 && c < clubCount))).slice(0, coop ? 1 : 2);
  const others: number[] = [];
  for (let c = 0; c < clubCount; c++) if (!humans.includes(c)) others.push(c);
  shuffle(h, others);
  const picked = humans.concat(others.slice(0, Math.max(0, size - humans.length)));
  shuffle(h, picked);
  if (humans.length === 2) {
    const half = size / 2;
    const a = picked.indexOf(humans[0]!);
    const b = picked.indexOf(humans[1]!);
    if ((a < half) === (b < half)) {
      const lo = b < half ? half : 0;
      const j = lo + randInt(h, half);
      const t = picked[b]!;
      picked[b] = picked[j]!;
      picked[j] = t;
    }
  }
  return picked;
}

/** Poisson sample with mean `lambda` from the cumulative table (capped). */
export function poissonSample(h: { rng: number }, lambda: number): number {
  const u = nextRandom(h);
  let k = 0;
  let p = Math.exp(-lambda);
  let cum = p;
  while (u > cum && k < QUICK.maxSampledGoals) {
    k++;
    p *= lambda / k;
    cum += p;
  }
  return k;
}

/** Expected goals in 90 minutes for a side rated `own` against `other`. */
export function expectedGoals(own: number, other: number): number {
  const l = QUICK.baseGoals * Math.exp(QUICK.ratingSlope * (own - other));
  return l < QUICK.minGoals ? QUICK.minGoals : l > QUICK.maxGoals ? QUICK.maxGoals : l;
}

/** Per-kick penalty conversion for a side rated `r`. */
export function penaltyConversion(r: number): number {
  const p = QUICK.penBase + (r - QUICK.penRefRating) * QUICK.penSlope;
  return p < QUICK.penMin ? QUICK.penMin : p > QUICK.penMax ? QUICK.penMax : p;
}

export interface QuickResult {
  homeGoals: number;
  awayGoals: number;
  extraTime: boolean;
  shootout: [number, number] | null;
  /** 0 home, 1 away. */
  winner: 0 | 1;
}

/** A shoot-out between sides rated hr / ar: five each (stopping once decided), then sudden death. */
export function quickShootout(h: { rng: number }, hr: number, ar: number): [number, number] {
  const ph = penaltyConversion(hr);
  const pa = penaltyConversion(ar);
  let gh = 0;
  let ga = 0;
  for (let k = 0; k < 5; k++) {
    if (nextRandom(h) < ph) gh++;
    if (gh > ga + (5 - k) || ga > gh + (4 - k)) return [gh, ga];
    if (nextRandom(h) < pa) ga++;
    if (gh > ga + (4 - k) || ga > gh + (4 - k)) return [gh, ga];
  }
  for (let k = 0; k < QUICK.maxSuddenDeath && gh === ga; k++) {
    if (nextRandom(h) < ph) gh++;
    if (nextRandom(h) < pa) ga++;
  }
  if (gh === ga) {
    if (nextRandom(h) < 0.5) gh++;
    else ga++;
  }
  return [gh, ga];
}

/** Ratings-based result of a tie (never level). Pure given the generator state. */
export function quickResult(h: { rng: number }, homeRating: number, awayRating: number): QuickResult {
  const lh = expectedGoals(homeRating, awayRating);
  const la = expectedGoals(awayRating, homeRating);
  let hg = poissonSample(h, lh);
  let ag = poissonSample(h, la);
  let extraTime = false;
  let shootout: [number, number] | null = null;
  if (hg === ag) {
    extraTime = true;
    hg += poissonSample(h, lh * QUICK.extraTimeShare);
    ag += poissonSample(h, la * QUICK.extraTimeShare);
    if (hg === ag) shootout = quickShootout(h, homeRating, awayRating);
  }
  const winner: 0 | 1 = hg !== ag ? (hg > ag ? 0 : 1) : shootout![0] > shootout![1] ? 0 : 1;
  return { homeGoals: hg, awayGoals: ag, extraTime, shootout, winner };
}

/** A fresh cup state (seeded draw). Pure. */
export function createCupState(clubs: readonly Pick<Club, 'rating'>[], opts: {
  size: 8 | 16; humanClubs: number[]; seed: number; coop?: boolean; humans?: number; difficulty?: Difficulty; halfMinutes?: number;
}): CupState {
  const size: 8 | 16 = opts.size === 16 && clubs.length >= 16 ? 16 : 8;
  if (clubs.length < size) throw new RangeError(`createCupState: need ${size} clubs, have ${clubs.length}`);
  const valid = Array.from(new Set(opts.humanClubs.filter((c) => Number.isInteger(c) && c >= 0 && c < clubs.length)));
  const humans = opts.humans === 2 || (valid.length >= 2 && !opts.coop) ? 2 : 1;
  const coop = humans === 2 && (opts.coop === true || valid.length < 2);
  const humanClubs = valid.length > 0 ? valid.slice(0, coop || humans === 1 ? 1 : 2) : [0];
  const holder = { rng: opts.seed >>> 0 };
  const order = drawCup(holder, clubs.length, size, humanClubs, coop);
  const rounds: CupTie[][] = [];
  let n = size / 2;
  for (let r = 0; r < roundCount(size); r++, n /= 2) {
    const ties: CupTie[] = [];
    for (let i = 0; i < n; i++) ties.push(r === 0 ? emptyTie(order[2 * i]!, order[2 * i + 1]!) : emptyTie());
    rounds.push(ties);
  }
  return {
    size, humanClubs, rounds, round: 0, seed: opts.seed >>> 0, finished: false, coop, humans, clubs: order, rng: holder.rng,
    champion: -1, difficulty: clampDifficulty(opts.difficulty ?? Difficulty.PROFESSIONAL), halfMinutes: clampHalfMinutes(opts.halfMinutes ?? 4),
    cupRecorded: false,
  };
}

/** True when the tie involves a human club. */
export function isHumanTie(state: Readonly<CupState>, t: Readonly<CupTie>): boolean {
  return state.humanClubs.includes(t.home) || state.humanClubs.includes(t.away);
}

/** The first unplayed human tie of the current round, or null. */
export function pendingHumanTie(state: Readonly<CupState>): { round: number; tie: number } | null {
  if (state.finished) return null;
  const ties = state.rounds[state.round];
  if (!ties) return null;
  for (let i = 0; i < ties.length; i++) {
    const t = ties[i]!;
    if (!isPlayed(t) && t.home >= 0 && t.away >= 0 && isHumanTie(state, t)) return { round: state.round, tie: i };
  }
  return null;
}

/** A human club is still in the cup (not finished, and a human club is in the current round). */
export function humanStillIn(state: Readonly<CupState>): boolean {
  if (state.finished) return false;
  const ties = state.rounds[state.round];
  if (!ties) return false;
  for (const t of ties) {
    if (isPlayed(t)) {
      if (state.humanClubs.includes(t.winner)) return true;
    } else if (isHumanTie(state, t)) return true;
  }
  return false;
}

function rating(clubs: readonly Pick<Club, 'rating'>[], c: number): number {
  const r = clubs[c]?.rating;
  return typeof r === 'number' && Number.isFinite(r) ? r : 75;
}

/** Fill a tie with a quick result. */
export function simulateTie(state: CupState, clubs: readonly Pick<Club, 'rating'>[], t: CupTie): void {
  const holder = { rng: (state.rng ?? state.seed) >>> 0 };
  const q = quickResult(holder, rating(clubs, t.home), rating(clubs, t.away));
  state.rng = holder.rng;
  t.homeGoals = q.homeGoals;
  t.awayGoals = q.awayGoals;
  t.shootout = q.shootout;
  t.extraTime = q.extraTime;
  t.quick = true;
  t.winner = q.winner === 0 ? t.home : t.away;
}

/**
 * Advance the bracket: while no human tie of the current round is waiting, quick-sim its CPU ties (in tie order), fill
 * the next round from the winners and move on; the final's winner is the champion. So other results appear after the
 * human's match, and once no human is left the cup plays out to the end. Pure apart from the state. Returns true when
 * the cup finished in this call.
 */
export function advanceCup(state: CupState, clubs: readonly Pick<Club, 'rating'>[]): boolean {
  let finishedNow = false;
  while (!state.finished) {
    const ties = state.rounds[state.round];
    if (!ties) break;
    if (ties.some((t) => !isPlayed(t) && isHumanTie(state, t))) break;
    for (const t of ties) if (!isPlayed(t) && t.home >= 0 && t.away >= 0) simulateTie(state, clubs, t);
    if (!ties.every(isPlayed)) break;
    const next = state.rounds[state.round + 1];
    if (!next) {
      state.finished = true;
      state.champion = ties[0]!.winner;
      finishedNow = true;
      break;
    }
    for (let j = 0; j < next.length; j++) {
      next[j]!.home = ties[2 * j]!.winner;
      next[j]!.away = ties[2 * j + 1]!.winner;
    }
    state.round++;
  }
  return finishedNow;
}

/** Tie result from a played match's summary (side 0 = tie.home). Level results are settled by a quick shoot-out. */
export function applySummary(state: CupState, clubs: readonly Pick<Club, 'rating'>[], t: CupTie, summary: MatchSummary): void {
  const hg = Math.max(0, Math.floor(summary.teams[0]?.goals ?? 0));
  const ag = Math.max(0, Math.floor(summary.teams[1]?.goals ?? 0));
  let side = summary.winner === 0 || summary.winner === 1 ? summary.winner : -1;
  if (side < 0 && (summary.forfeit === 0 || summary.forfeit === 1)) side = 1 - summary.forfeit;
  let so = summary.shootout ? ([summary.shootout[0], summary.shootout[1]] as [number, number]) : null;
  if (side < 0 && hg !== ag) side = hg > ag ? 0 : 1;
  if (side < 0 && so && so[0] !== so[1]) side = so[0] > so[1] ? 0 : 1;
  if (side < 0) {
    const holder = { rng: (state.rng ?? state.seed) >>> 0 };
    so = quickShootout(holder, rating(clubs, t.home), rating(clubs, t.away));
    state.rng = holder.rng;
    side = so[0] > so[1] ? 0 : 1;
  }
  t.homeGoals = hg;
  t.awayGoals = ag;
  t.shootout = hg === ag ? so : null;
  t.extraTime = t.shootout !== null || summary.goals.some((g) => g.minute > 90);
  t.quick = false;
  t.winner = side === 0 ? t.home : t.away;
}

// ================================================================ validation (load)

const isInt = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A deep-checked copy of a stored cup state, or null. */
export function validateCupState(v: unknown, clubCount: number): CupState | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Partial<CupState>;
  if (s.size !== 8 && s.size !== 16) return null;
  const size = s.size;
  const club = (c: unknown, allowNone: boolean): boolean => isInt(c, allowNone ? -1 : 0, clubCount - 1);
  if (!Array.isArray(s.humanClubs) || s.humanClubs.length < 1 || s.humanClubs.length > 2 || !s.humanClubs.every((c) => club(c, false))) return null;
  if (!Array.isArray(s.rounds) || s.rounds.length !== roundCount(size)) return null;
  if (!isInt(s.round, 0, roundCount(size) - 1) || typeof s.finished !== 'boolean' || !isInt(s.seed, 0, 0xffffffff)) return null;
  const rounds: CupTie[][] = [];
  let n = size / 2;
  for (let r = 0; r < s.rounds.length; r++, n /= 2) {
    const ties = s.rounds[r];
    if (!Array.isArray(ties) || ties.length !== n) return null;
    const out: CupTie[] = [];
    for (const t of ties as unknown[]) {
      if (!t || typeof t !== 'object') return null;
      const x = t as Partial<CupTie>;
      if (!club(x.home, true) || !club(x.away, true) || !isInt(x.homeGoals, -1, 99) || !isInt(x.awayGoals, -1, 99) || !club(x.winner, true)) return null;
      let so: [number, number] | null = null;
      if (x.shootout !== null && x.shootout !== undefined) {
        if (!Array.isArray(x.shootout) || x.shootout.length !== 2 || !isInt(x.shootout[0], 0, 99) || !isInt(x.shootout[1], 0, 99)) return null;
        so = [x.shootout[0], x.shootout[1]];
      }
      const tie: CupTie = { home: x.home!, away: x.away!, homeGoals: x.homeGoals!, awayGoals: x.awayGoals!, shootout: so, winner: x.winner! };
      if (x.extraTime !== undefined) tie.extraTime = !!x.extraTime;
      if (x.quick !== undefined) tie.quick = !!x.quick;
      if (tie.winner >= 0 && tie.winner !== tie.home && tie.winner !== tie.away) return null;
      out.push(tie);
    }
    rounds.push(out);
  }
  const humans = s.humans === 2 ? 2 : 1;
  const champion = isInt(s.champion, -1, clubCount - 1) ? s.champion : -1;
  if (s.finished && champion < 0) return null;
  return {
    size, humanClubs: s.humanClubs.slice(), rounds, round: s.round, seed: s.seed >>> 0, finished: s.finished, coop: s.coop === true,
    humans, clubs: Array.isArray(s.clubs) && s.clubs.every((c) => club(c, false)) ? s.clubs.slice() : undefined,
    rng: isInt(s.rng, 0, 0xffffffff) ? s.rng : s.seed >>> 0, champion, difficulty: clampDifficulty(s.difficulty),
    halfMinutes: clampHalfMinutes(s.halfMinutes), cupRecorded: s.cupRecorded === true,
  };
}

// ================================================================ devices

/** Device bindings for the cup's humans (see header). Pure. */
export function cupBindings(devices: readonly DeviceInfo[], humans: number): HumanBinding[] {
  const connected = devices.filter((d) => d.connected);
  if (humans < 2) return [{ human: 0, deviceIds: connected.map((d) => d.id).concat(ANY_DEVICE) }];
  const pads = connected.filter((d) => d.kind === 'pad').map((d) => d.id);
  const touch = connected.filter((d) => d.kind === 'touch').map((d) => d.id);
  const keys = connected.filter((d) => d.kind === 'keyboard').map((d) => d.id);
  const p1: string[] = touch.slice();
  const p2: string[] = [];
  if (pads.length >= 2) {
    p1.push(...keys, pads[0]!);
    p2.push(pads[1]!);
  } else if (pads.length === 1) {
    p1.push(...keys);
    p2.push(pads[0]!);
  } else {
    p2.push(...keys);
  }
  p2.push(ANY_DEVICE);
  return [{ human: 0, deviceIds: p1 }, { human: 1, deviceIds: p2 }];
}

// ================================================================ app-facing run

function humanChoicesFor(state: Readonly<CupState>, t: Readonly<CupTie>, bindings: readonly HumanBinding[]): HumanChoice[] {
  const ids = (h: number): string[] => bindings.find((b) => b.human === h)?.deviceIds.slice() ?? [];
  const sideOf = (club: number): number => (t.home === club ? 0 : t.away === club ? 1 : -1);
  const humans = state.humans === 2 ? 2 : 1;
  const out: HumanChoice[] = [];
  if (humans === 1) {
    out.push({ human: 0, side: sideOf(state.humanClubs[0]!), deviceIds: ids(0) });
  } else if (state.coop) {
    const side = sideOf(state.humanClubs[0]!);
    out.push({ human: 0, side, deviceIds: ids(0) }, { human: 1, side, deviceIds: ids(1) });
  } else {
    out.push({ human: 0, side: sideOf(state.humanClubs[0]!), deviceIds: ids(0) });
    out.push({ human: 1, side: sideOf(state.humanClubs[1] ?? -2), deviceIds: ids(1) });
  }
  return out;
}

function listDevices(ctx: Pick<AppContext, 'devices'>): DeviceInfo[] {
  try {
    return ctx.devices.list();
  } catch {
    return [];
  }
}

function makeRun(ctx: AppContext, state: CupState): CupRun {
  const clubs = ctx.clubs;
  const run: CupRun = {
    state,
    pendingTie: () => pendingHumanTie(state),
    humanAlive: () => humanStillIn(state),
    save() {
      try {
        ctx.settings.saveProgress(CUP_PROGRESS_KEY, { schema: CUP_SCHEMA, state });
      } catch {
        /* storage blocked: the cup lives for this session */
      }
    },
    nextMatch(opts = {}) {
      const at = pendingHumanTie(state);
      if (!at) return null;
      const t = state.rounds[at.round]![at.tie]!;
      const bindings = cupBindings(listDevices(ctx), state.humans === 2 ? 2 : 1);
      const setup = buildSetup(ctx, {
        mode: ModeId.CUP, homeClub: t.home, awayClub: t.away, difficulty: state.difficulty, halfMinutes: state.halfMinutes,
        cupRules: true, humans: humanChoicesFor(state, t, bindings),
      });
      setup.config.cupRules = 1;
      const data: CupMatchData = { kind: 'cup', seed: state.seed, round: at.round, tie: at.tie };
      setup.modeData = data;
      let done = false;
      setup.onFinish = (summary, quit) => {
        if (done) return;
        done = true;
        if (!quit && summary) {
          // The saved cup is the truth (the screen may hold another CupRun over the same cup).
          const live = loadCup(ctx);
          const target = live && live.state.seed === state.seed ? live : run;
          if (target.recordResult(summary, at)) {
            try {
              recordMatch(ctx.settings, setup, summary, false);
            } catch {
              /* records never block the cup */
            }
          }
        }
        opts.onFinished?.(summary, quit);
      };
      return setup;
    },
    recordResult(summary, at) {
      const p = pendingHumanTie(state);
      if (!p || (at && (at.round !== p.round || at.tie !== p.tie))) return false;
      applySummary(state, clubs, state.rounds[p.round]![p.tie]!, summary);
      afterResult();
      return true;
    },
    simulateHumanTie() {
      const p = pendingHumanTie(state);
      if (!p) return false;
      simulateTie(state, clubs, state.rounds[p.round]![p.tie]!);
      afterResult();
      return true;
    },
    simulateRest() {
      let guard = 64;
      while (!state.finished && guard-- > 0) {
        const p = pendingHumanTie(state);
        if (p) simulateTie(state, clubs, state.rounds[p.round]![p.tie]!);
        advanceCup(state, clubs);
      }
      afterResult();
    },
  };

  function afterResult(): void {
    advanceCup(state, clubs);
    if (state.finished && !state.cupRecorded && state.humanClubs.includes(state.champion ?? -1)) {
      state.cupRecorded = true;
      try {
        recordCupWon(ctx.settings);
      } catch {
        /* records never block the cup */
      }
    }
    run.save();
  }

  return run;
}

export interface CreateCupOptions {
  size: 8 | 16;
  humanClubs: number[];
  seed?: number;
  /** Two humans on one club. */
  coop?: boolean;
  /** 1 or 2 humans (default: 2 when two clubs or coop, else 1). */
  humans?: number;
  difficulty?: Difficulty;
  halfMinutes?: number;
}

export function createCup(ctx: AppContext, opts: CreateCupOptions): CupRun {
  const settings = ctx.settings.get();
  const humans = opts.humans ?? (opts.coop || opts.humanClubs.length >= 2 ? 2 : 1);
  const state = createCupState(ctx.clubs, {
    size: opts.size, humanClubs: opts.humanClubs, seed: opts.seed ?? newMatchSeed(), coop: opts.coop, humans,
    difficulty: opts.difficulty ?? settings.match.difficulty, halfMinutes: opts.halfMinutes ?? settings.match.halfMinutes,
  });
  const run = makeRun(ctx, state);
  run.save();
  return run;
}

export function loadCup(ctx: AppContext): CupRun | null {
  let raw: unknown;
  try {
    raw = ctx.settings.loadProgress<unknown>(CUP_PROGRESS_KEY);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const wrapped = raw as { schema?: unknown; state?: unknown };
  if (wrapped.schema !== CUP_SCHEMA) return null;
  const state = validateCupState(wrapped.state, ctx.clubs.length);
  return state ? makeRun(ctx, state) : null;
}

/** Forget the saved cup. */
export function clearCup(ctx: Pick<AppContext, 'settings'>): void {
  try {
    ctx.settings.saveProgress<null>(CUP_PROGRESS_KEY, null);
  } catch {
    /* nothing saved */
  }
}
