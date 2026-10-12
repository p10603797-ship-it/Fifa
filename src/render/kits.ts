/**
 * [GFX-08] Kits, shirt numbers, crests, the kit texture atlas and the automatic clash check (section 8 "Look":
 * "An automatic clash check picks kits by colour distance, including against the grass and the other keeper").
 * Patterns (plain, stripes, hoops, halves, sash) and numbers come from one generated atlas (GFX-08).
 *
 * WAVE 0 STUB (FND-05): resolves the shirt colours per team with a simple clash fallback (away side switches to
 * its other kit when the shirts are too close; keepers switch to keeper2 when they clash with anyone), no atlas.
 */

import type { Club, Kit, Rgb } from '../contracts/data';
import { KitSlot } from '../contracts/enums';
import type { ReadonlySimState } from '../contracts/state';

/** Mid grass colour used for the grass clash test. */
export const GRASS_RGB: Rgb = 0x4a9440;
/** Normalised colour distance below which two kits clash. */
export const CLASH_THRESHOLD = 0.2;

export interface MatchKits {
  /** Outfield kit per team (0 home, 1 away) after the clash check. */
  outfield: [Kit, Kit];
  /** Keeper kit per team after the clash check. */
  keeper: [Kit, Kit];
  /** Kit slot actually used per team (may differ from the requested one after a clash). */
  slot: [KitSlot, KitSlot];
}

/** Perceptual-ish distance between two 0xRRGGBB colours ("redmean"), normalised to 0..1. Pure. */
export function colourDistance(a: Rgb, b: Rgb): number {
  const r1 = (a >> 16) & 255, g1 = (a >> 8) & 255, b1 = a & 255;
  const r2 = (b >> 16) & 255, g2 = (b >> 8) & 255, b2 = b & 255;
  const rm = (r1 + r2) / 2;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  const d = Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
  return d / 764.8339663572415;
}

export function clubById(clubs: readonly Club[], id: number): Club | null {
  const direct = clubs[id];
  if (direct && direct.id === id) return direct;
  for (let i = 0; i < clubs.length; i++) if (clubs[i]!.id === id) return clubs[i]!;
  return clubs[id] ?? null;
}

const FALLBACK_HOME: Kit = { shirt: 0xd7263d, shirt2: 0xffffff, pattern: 0, shorts: 0xffffff, socks: 0xd7263d, number: 0xffffff };
const FALLBACK_AWAY: Kit = { shirt: 0x1b6cff, shirt2: 0xffffff, pattern: 0, shorts: 0x10204a, socks: 0x1b6cff, number: 0xffffff };
const FALLBACK_KEEPER: Kit = { shirt: 0x222222, shirt2: 0x444444, pattern: 0, shorts: 0x222222, socks: 0x222222, number: 0xffffff };
const FALLBACK_KEEPER2: Kit = { shirt: 0xeeee22, shirt2: 0x222222, pattern: 0, shorts: 0x222222, socks: 0xeeee22, number: 0x111111 };

/** Minimum distance of `shirt` to every colour in `others`. */
function minDist(shirt: Rgb, others: readonly Rgb[]): number {
  let m = 1;
  for (let i = 0; i < others.length; i++) m = Math.min(m, colourDistance(shirt, others[i]!));
  return m;
}

/** Resolve the kits for a match: requested slots from state.teams[t].kit, then the clash fallback. */
export function resolveMatchKits(state: ReadonlySimState, clubs: readonly Club[]): MatchKits {
  const homeClub = clubById(clubs, state.teams[0]!.clubIdx);
  const awayClub = clubById(clubs, state.teams[1]!.clubIdx);
  const pick = (c: Club | null, slot: KitSlot, fb: Kit): Kit => (c ? (slot === KitSlot.AWAY ? c.away : c.home) : fb);
  const homeSlot = state.teams[0]!.kit === KitSlot.AWAY ? KitSlot.AWAY : KitSlot.HOME;
  let awaySlot = state.teams[1]!.kit === KitSlot.HOME ? KitSlot.HOME : KitSlot.AWAY;
  const home = pick(homeClub, homeSlot, FALLBACK_HOME);
  let away = pick(awayClub, awaySlot, FALLBACK_AWAY);

  // Away side changes kit when it clashes with the home shirts or the grass and its other kit is better.
  const awayScore = (k: Kit): number => Math.min(colourDistance(k.shirt, home.shirt), colourDistance(k.shirt, GRASS_RGB) * 1.5);
  if (awayScore(away) < CLASH_THRESHOLD) {
    const otherSlot = awaySlot === KitSlot.AWAY ? KitSlot.HOME : KitSlot.AWAY;
    const other = pick(awayClub, otherSlot, FALLBACK_AWAY);
    if (awayScore(other) > awayScore(away)) { away = other; awaySlot = otherSlot; }
    if (awayScore(away) < CLASH_THRESHOLD && awayScore(FALLBACK_AWAY) > awayScore(away)) away = FALLBACK_AWAY;
  }

  // Keepers: switch to keeper2 when clashing with either outfield shirt or the other keeper.
  let homeKeeper = homeClub ? homeClub.keeper : FALLBACK_KEEPER;
  if (minDist(homeKeeper.shirt, [home.shirt, away.shirt, GRASS_RGB]) < CLASH_THRESHOLD) {
    homeKeeper = homeClub ? homeClub.keeper2 : FALLBACK_KEEPER2;
  }
  let awayKeeper = awayClub ? awayClub.keeper : FALLBACK_KEEPER;
  if (minDist(awayKeeper.shirt, [home.shirt, away.shirt, homeKeeper.shirt, GRASS_RGB]) < CLASH_THRESHOLD) {
    const alt = awayClub ? awayClub.keeper2 : FALLBACK_KEEPER2;
    if (minDist(alt.shirt, [home.shirt, away.shirt, homeKeeper.shirt]) > minDist(awayKeeper.shirt, [home.shirt, away.shirt, homeKeeper.shirt])) {
      awayKeeper = alt;
    }
  }
  return { outfield: [home, away], keeper: [homeKeeper, awayKeeper], slot: [homeSlot, awaySlot] };
}
