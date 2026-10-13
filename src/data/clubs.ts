/**
 * [DAT-01] The 20 clubs (BRIEF §15): invented names, unique 3-letter codes, geometric crests, home / away / keeper
 * kits, a preferred formation, a style, a rating 62..88 and an 18-player squad each.
 *
 * The data is the committed output of tools/gen-data.ts (`npm run gen:data`), in src/data/clubs.generated.ts, so
 * the teams are identical in every build; never edit it by hand. This module only re-exports it, so the game
 * bundle carries the data but none of the generators, word lists or denylists.
 *
 * Squad layout (contracts/data.ts Club.squad): 0..10 starters in formation slot order (0 = keeper), 11 the reserve
 * keeper, 12..17 outfield cover. The data is shared by reference with every match: treat it as read-only.
 */
import type { Club } from '../contracts/data';
import { CLUBS_DATA } from './clubs.generated';

/** Every club; index = Club.id. */
export const CLUBS: readonly Club[] = CLUBS_DATA;

/** Number of clubs. */
export const CLUB_COUNT = CLUBS.length;

/** The club with this id; an unknown id (out of range, fractional, NaN) gives club 0. */
export function getClub(id: number): Club {
  return CLUBS[id] ?? CLUBS[0]!;
}

/** The club with this 3-letter code (case-insensitive), or undefined. */
export function findClubByCode(code: string): Club | undefined {
  const c = code.toUpperCase();
  for (let i = 0; i < CLUBS.length; i++) if (CLUBS[i]!.code === c) return CLUBS[i];
  return undefined;
}

/** Crest.shape ids 0..5 (contracts/data.ts). Labels for renderers and menus. */
export const CREST_SHAPES = ['shield', 'circle', 'diamond', 'hexagon', 'square', 'chevron'] as const;

/** Crest.emblem ids 0..9: simple geometric marks drawn in the secondary colour. The generator gives a club the
 *  emblem its name suggests when one does (src/data/names.ts EMBLEM_HINTS: "Comet" -> star, "Brook" -> wave). */
export const CREST_EMBLEMS = ['star', 'bolt', 'wave', 'ring', 'triangle', 'arrow', 'bars', 'sun', 'dots', 'gem'] as const;

/** Crest.layout ids 0..3: how the primary and secondary colours split the field behind the emblem
 *  (plain primary field, vertical halves, horizontal band, diagonal sash). */
export const CREST_LAYOUTS = ['plain', 'halves', 'band', 'sash'] as const;
