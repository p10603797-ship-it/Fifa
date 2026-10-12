/**
 * [DAT-01/DAT-02/DAT-03] Clubs, squads and kits. WAVE 0 PLACEHOLDER: 20 generic clubs with flat attributes so
 * the skeleton and harness can run. DAT-01..03 replace this with committed output of tools/gen-data.ts
 * (invented names, unique codes, crests, kits, styles, ratings 62..88, 18-player squads).
 */
import { FormationId, Foot, KitPattern, Role, TeamStyle } from '../contracts/enums';
import type { Club, Kit, PlayerData } from '../contracts/data';
import { getFormation } from './formations';

const PALETTE = [0xd7263d, 0x1b998b, 0xf46036, 0x2e294e, 0xc5d86d, 0x3a86ff, 0xffbe0b, 0x8338ec, 0xff006e, 0x06d6a0];

function kit(shirt: number, shirt2: number, shorts: number): Kit {
  return { shirt, shirt2, pattern: KitPattern.PLAIN, shorts, socks: shirt, number: 0xffffff };
}

function player(i: number, role: Role, rating: number): PlayerData {
  const gk = role === Role.GK;
  const o = gk ? 30 : rating;
  const g = gk ? rating : 15;
  return {
    name: `Player ${i + 1}`, short: `P${i + 1}`, shirt: i + 1, pos: role, height: gk ? 190 : 180, foot: Foot.RIGHT,
    weakFoot: 3, skillMoves: gk ? 1 : 3, overall: rating,
    acceleration: o, sprintSpeed: o, agility: o, ballControl: o, dribbling: o, shortPassing: o, longPassing: o, crossing: o,
    vision: o, finishing: o, shotPower: o, longShots: o, curve: o, heading: o, standingTackle: o, slidingTackle: o,
    interceptions: o, strength: o, stamina: o, composure: o,
    gkDiving: g, gkHandling: g, gkReflexes: g, gkPositioning: g, gkKicking: g,
  };
}

function club(id: number): Club {
  const rating = 62 + Math.round((26 * id) / 19);
  const formation = (id % 6) as FormationId;
  const slots = getFormation(formation).slots;
  const squad: PlayerData[] = [];
  for (let i = 0; i < 11; i++) squad.push(player(i, slots[i]!.role, rating));
  const benchRoles = [Role.GK, Role.CB, Role.LB, Role.CM, Role.CM, Role.RW, Role.ST];
  for (let i = 0; i < 7; i++) squad.push(player(11 + i, benchRoles[i]!, rating - 4));
  const c1 = PALETTE[id % PALETTE.length]!;
  const c2 = PALETTE[(id + 3) % PALETTE.length]!;
  return {
    id, name: `Club ${id + 1}`, code: `C${String(id + 1).padStart(2, '0')}`, city: 'City', rating, style: (id % 5) as TeamStyle,
    formation, home: kit(c1, c2, 0xffffff), away: kit(0xf2f2f2, c1, c1), keeper: kit(0x222222, 0x444444, 0x222222),
    keeper2: kit(0xeeee22, 0x222222, 0x222222), crest: { shape: id % 6, primary: c1, secondary: c2, emblem: id % 10, layout: id % 4 }, squad,
  };
}

export const CLUBS: readonly Club[] = Array.from({ length: 20 }, (_, i) => club(i));

export function getClub(id: number): Club {
  return CLUBS[id] ?? CLUBS[0]!;
}
