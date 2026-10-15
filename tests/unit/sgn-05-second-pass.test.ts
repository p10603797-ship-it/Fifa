/**
 * [SGN-05, second auditor] Name screen, second pass with an independent source.
 *
 * The first pass screened the league against hand-made lists (src/data/screen.ts, src/data/names.ts). The second pass
 * screened all 360 display names and every surname the generator can form against Wikidata: about 98,000 footballers
 * and managers with 6+ Wikipedia language editions, 37,000 club labels, aliases and nicknames. Findings pinned here:
 *  - glitch "W. Thornton": the exact display name of Willie Thornton (Rangers centre-forward, Scotland), on a striker;
 *  - glitch "S. Zanotti": one letter from Javier Zanetti (Inter, Argentina), an iconic surname the lists missed;
 *  - 51 famous surnames the generator can form were not screened at all (Matsuda, Ferreira, Rosato, Skoglund ...);
 *    they are now in AUDIT_FAMOUS_PLAYERS, which `screenShippedName` applies to the shipped league (a regeneration
 *    that draws one fails here) while the generator's own screen, and so its RNG stream for every seed and the DAT-02
 *    sample statistics, stay as they were. The ones the committed league already uses with a different initial are
 *    accepted near misses (minor players, common surnames), listed below.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLUBS } from '../../src/data/clubs';
import { seamOk } from '../../src/data/playerGen';
import {
  AUDIT_FAMOUS_PLAYERS, FAMOUS_PLAYERS, LATE_FAMOUS_PLAYERS, LATE_ICONIC_SURNAMES, PLAYER_NAME_FIXES, screenName,
  screenShippedName,
} from '../../src/data/screen';

const root = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Generable surnames that a footballer or manager with 20+ Wikipedia editions carries (Wikidata, October 2026), with
 * that player. Each must be blocked by the generator's strict screen or by the shipped-name screen (LATE / AUDIT
 * lists), or be one of the ACCEPTED near misses below.
 */
const FAMOUS_GENERABLE: Readonly<Record<string, string>> = {
  Zanetti: 'Javier Zanetti', Carvalho: 'Ricardo Carvalho', Araujo: 'Leonardo Araujo', Kawashima: 'Eiji Kawashima',
  Nakamura: 'Shunsuke Nakamura', Capello: 'Fabio Capello', Morimoto: 'Takayuki Morimoto', Matsuda: 'Naoki Matsuda',
  Rivera: 'Gianni Rivera', Morishima: 'Hiroaki Morishima', Ferreira: 'Paulo Ferreira', Yamamura: 'Kazuya Yamamura',
  Fujimoto: 'Jungo Fujimoto', Takahara: 'Naohiro Takahara', Kawamoto: 'Taizo Kawamoto', Yamamoto: 'Masakuni Yamamoto',
  Matsumoto: 'Ikuo Matsumoto', Ishikawa: 'Naohiro Ishikawa', Tadić: 'Dusan Tadic', Takada: 'Kazumi Takada',
  Yamada: 'Naoki Yamada', Fujishima: 'Nobuo Fujishima', Kurobe: 'Teruaki Kurobe', Marić: 'Tomislav Maric',
  Savić: 'Stefan Savic', Kawano: 'Junji Kawano', Nakamoto: 'Kuniharu Nakamoto', Valdez: 'Nelson Valdez',
  Bremner: 'Billy Bremner', Lindner: 'Heinz Lindner', Rosato: 'Roberto Rosato', Özcan: 'Ramazan Ozcan',
  Kurokawa: 'Takaya Kurokawa', Faubert: 'Julien Faubert', Ashton: 'Dean Ashton', Skoglund: 'Lennart Skoglund',
  Beauchamp: 'Michael Beauchamp', Sašić: 'Celia Sasic', Yamazaki: 'Ryohei Yamazaki', Marini: 'Gianpiero Marini',
  Ishihara: 'Naoki Ishihara', Kawamura: 'Takahiro Kawamura', Kawahara: 'Kazuhisa Kawahara', Fujikawa: 'Takayuki Fujikawa',
  Shimada: 'Takahiro Shimada', Sakamoto: 'Masataka Sakamoto', Moreira: 'Aymore Moreira', Harada: 'Takeo Harada',
  Ishizaki: 'Nobuhiro Ishizaki', Pabón: 'Dorlan Pabon', Ishida: 'Hiroyuki Ishida', Nakashima: 'Yuki Nakashima',
  Yamauchi: 'Takao Yamauchi', Matsukawa: 'Tomoaki Matsukawa', Berglund: 'Emma Berglund', Nakano: 'Hiroshi Nakano',
  Hoshihara: 'Kenta Hoshihara', Saadane: 'Rabah Saadane', Serrão: 'Jose Carlos Serrao', Whitmore: 'Theodore Whitmore',
  Morimura: 'Kota Morimura', Matsushima: 'Hitoshi Matsushima', Shimamura: 'Masashi Shimamura', Berner: 'Bruno Berner',
  Ercan: 'Abdullah Ercan', Morikawa: 'Toru Morikawa', Corini: 'Eugenio Corini', Lindberg: 'Torsten Lindberg',
  Hafner: 'Reinhard Hafner', Holmlund: 'Anna Holmlund', Nakada: 'Kenji Nakada',
};

/** Shipped with a different initial than the famous bearer (common surnames, minor players): accepted near misses. */
const ACCEPTED: Readonly<Record<string, string>> = {
  Morimoto: 'K. Morimoto', Kurobe: 'R. Kurobe', Yamazaki: 'D. Yamazaki', Ishizaki: 'K. Ishizaki',
  Morikawa: 'S. Morikawa', Corini: 'A. Corini', Holmlund: 'H. Holmlund', Sakamoto: 'Y. Sakamoto',
};
/** Every surname one syllable pair of one playerGen origin can form (same seam rules as the generator). */
function generableSurnames(): Set<string> {
  const src = readFileSync(`${root}src/data/playerGen.ts`, 'utf8');
  const vowels = 'aeiouyáéíóúàèìòùâêîôûäëïöüåøæœãõ';
  const isVowel = (c: string): boolean => vowels.includes(c.toLowerCase());
  const join = (a: string, b: string): string => (isVowel(a.slice(-1)) && a.slice(-1).toLowerCase() === b.charAt(0).toLowerCase() ? a + b.slice(1) : a + b);
  const list = (s: string): string[] => [...s.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
  const out = new Set<string>();
  for (const m of src.matchAll(/id: '[a-z]+',[\s\S]*?lastA: \[([^\]]*)\],\s*lastB: \[([^\]]*)\]/g)) {
    for (const a of list(m[1]!)) {
      for (const b of list(m[2]!)) if (seamOk(a, b)) out.add(join(a, b.startsWith('+') ? b.slice(1) : b));
    }
  }
  return out;
}

const shippedNames = new Set(CLUBS.flatMap((c) => c.squad.map((p) => p.name)));

describe('SGN-05 second pass: independent name screen', () => {
  it('glitch "W. Thornton": the exact display name of a famous striker is late-listed and renamed', () => {
    expect(LATE_FAMOUS_PLAYERS).toContain('Willie Thornton');
    expect(screenShippedName('W', 'Thornton')?.reason).toBe('famous-surname');
    expect(screenShippedName('Willie', 'Thornton')?.reason).toBe('full');
    // The generator's own screen does not see it: a redraw would re-roll the rest of the squad (DAT-02).
    expect(screenName('Wilton', 'Thornton', true)).toBeNull();
    const fix = PLAYER_NAME_FIXES.find((f) => f.from === 'W. Thornton');
    expect(fix).toEqual({ club: 19, from: 'W. Thornton', to: 'W. Hartcroft' });
    expect(CLUBS[19]!.squad.some((p) => p.name === 'W. Thornton' || p.name === 'W. Hartcroft')).toBe(true);
    expect(screenShippedName('W', 'Hartcroft')).toBeNull();
  });

  it('glitch "S. Zanotti": one letter from an iconic surname is late-listed and renamed', () => {
    expect(LATE_ICONIC_SURNAMES).toContain('Zanetti');
    expect(screenShippedName('S', 'Zanotti')?.reason).toBe('near-iconic');
    expect(screenShippedName('A', 'Zanetti')).not.toBeNull();
    expect(screenName('Sergio', 'Zanotti', true)).toBeNull();
    const fix = PLAYER_NAME_FIXES.find((f) => f.from === 'S. Zanotti');
    expect(fix).toEqual({ club: 14, from: 'S. Zanotti', to: 'S. Rosaldi' });
    expect(CLUBS[14]!.squad.some((p) => p.name === 'S. Zanotti' || p.name === 'S. Rosaldi')).toBe(true);
    expect(screenShippedName('S', 'Rosaldi')).toBeNull();
  });

  it('every famous surname the generator can form is blocked, late-listed, or a documented accepted near miss', () => {
    const space = generableSurnames();
    expect(space.size).toBeGreaterThan(2000);
    const open: string[] = [];
    for (const [surname, famous] of Object.entries(FAMOUS_GENERABLE)) {
      expect(space.has(surname), `${surname} is generable`).toBe(true);
      if (screenName('Xq', surname, true) !== null) continue; // blocked for every initial by the generator itself
      if (ACCEPTED[surname] !== undefined) {
        expect(shippedNames.has(ACCEPTED[surname]!), `${ACCEPTED[surname]} ships`).toBe(true);
        expect(ACCEPTED[surname]!.charAt(0), `${surname}: different initial from ${famous}`).not.toBe(famous.charAt(0));
        expect(screenName(famous.split(' ')[0]!, surname, false), `${surname} not in the generator lists`).toBeNull();
        continue;
      }
      if (screenShippedName('X', surname) !== null) continue; // LATE (renamed) or AUDIT (never drawn) lists
      open.push(`${surname} (${famous})`);
    }
    expect(open, 'add the famous player to AUDIT_FAMOUS_PLAYERS (src/data/screen.ts)').toEqual([]);
  });

  it('the AUDIT list guards the shipped league only: the generator screen and its RNG stream are unchanged', () => {
    expect(AUDIT_FAMOUS_PLAYERS.length).toBeGreaterThanOrEqual(50);
    const famous = new Set(FAMOUS_PLAYERS);
    for (const full of AUDIT_FAMOUS_PLAYERS) {
      const [first, ...rest] = full.split(' ');
      const last = rest.join(' ');
      expect(famous.has(full), full).toBe(false);
      expect(screenShippedName(first!, last), full).not.toBeNull();
      expect(screenShippedName('X', rest[rest.length - 1]!), `${full}: any initial`).not.toBeNull();
      expect(screenName('Xq', rest[rest.length - 1]!, true), `${full}: the generator does not see it`).toBeNull();
    }
    // No shipped name hits it (the AUDIT list renames nothing).
    for (const c of CLUBS) {
      for (const p of c.squad) {
        const hit = screenShippedName(p.name.charAt(0), p.short);
        if (hit === null) continue;
        expect(PLAYER_NAME_FIXES.some((f) => f.club === c.id && f.from === p.name), `${p.name}: ${hit.reason} ${hit.match}`).toBe(true);
      }
    }
  });
});
