/** DAT-02: name screening against famous real footballers (BRIEF §2, §15). */
import { describe, expect, it } from 'vitest';
import {
  FAMOUS_MONONYMS, FAMOUS_PLAYERS, ICONIC_SURNAMES, OFFENSIVE_FRAGMENTS, denylistSize, isNameAllowed, nameKey,
  normalizeName, screenName, withinOneEdit,
} from '../../src/data/screen';

describe('DAT-02 screen: normalisation', () => {
  it('folds case, accents, special letters and punctuation', () => {
    expect(normalizeName('Ødegaard')).toBe('odegaard');
    expect(normalizeName('Gündoğan')).toBe('gundogan');
    expect(normalizeName('Mbappé')).toBe('mbappe');
    expect(normalizeName('Łukasz  Piszczek')).toBe('lukasz piszczek');
    expect(normalizeName("Samuel Eto'o")).toBe('samuel eto o');
    expect(normalizeName('Trent Alexander-Arnold')).toBe('trent alexander arnold');
    expect(normalizeName('Straße Æsir İlhan')).toBe('strasse aesir ilhan');
    expect(nameKey('Di Stéfano')).toBe('distefano');
    expect(nameKey("Eto'o")).toBe('etoo');
  });

  it('withinOneEdit detects single insertions, deletions and substitutions only', () => {
    expect(withinOneEdit('messi', 'messi')).toBe(true);
    expect(withinOneEdit('messi', 'messy')).toBe(true);
    expect(withinOneEdit('messi', 'mesi')).toBe(true);
    expect(withinOneEdit('messi', 'messia')).toBe(true);
    expect(withinOneEdit('messi', 'massy')).toBe(false);
    expect(withinOneEdit('zidane', 'zidan')).toBe(true);
    expect(withinOneEdit('zidane', 'zdan')).toBe(false);
    expect(withinOneEdit('', 'a')).toBe(true);
    expect(withinOneEdit('', 'ab')).toBe(false);
  });
});

describe('DAT-02 screen: denylist', () => {
  it('holds a few hundred famous full names, all distinct', () => {
    expect(FAMOUS_PLAYERS.length).toBeGreaterThanOrEqual(300);
    expect(denylistSize()).toBe(FAMOUS_PLAYERS.length);
    const keys = FAMOUS_PLAYERS.map(nameKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const n of FAMOUS_PLAYERS) expect(normalizeName(n).split(' ').length).toBeGreaterThanOrEqual(2);
    expect(FAMOUS_MONONYMS.length).toBeGreaterThanOrEqual(40);
    expect(ICONIC_SURNAMES.length).toBeGreaterThanOrEqual(50);
  });

  it('every listed famous player is rejected by his own name (any spelling of case/accents)', () => {
    for (const full of FAMOUS_PLAYERS) {
      const sp = full.indexOf(' ');
      const first = full.slice(0, sp);
      const last = full.slice(sp + 1);
      expect(screenName(first, last), full).not.toBeNull();
      expect(screenName(first.toUpperCase(), last.toLowerCase()), full).not.toBeNull();
    }
  });
});

describe('DAT-02 screen: rules on injected collisions', () => {
  it('full name match (accent/case-insensitive)', () => {
    expect(screenName('Lionel', 'Messi')?.reason).toBeDefined();
    expect(screenName('kylian', 'MBAPPE')).not.toBeNull();
    expect(screenName('Luis', 'Suárez')?.reason).toBe('full');
    expect(screenName('Virgil', 'van Dijk')).not.toBeNull();
  });

  it('famous surname + matching initial (non-iconic surname)', () => {
    // Nemanja Vidic: surname not on the iconic list, so only the initial rule applies in lenient mode.
    expect(screenName('Nikola', 'Vidic')?.reason).toBe('surname-initial');
    expect(screenName('Nikola', 'Vidić')?.reason).toBe('surname-initial');
    expect(screenName('Marko', 'Vidic')).toBeNull();
    // Strict mode (used by the generator) rejects the famous surname whatever the initial.
    expect(screenName('Marko', 'Vidic', true)?.reason).toBe('famous-surname');
    // Several famous players share a surname: each initial counts.
    expect(screenName('Thomas', 'Silva')?.reason).toBe('surname-initial');
    expect(screenName('Bruno', 'Silva')?.reason).toBe('surname-initial');
    expect(screenName('Zeke', 'Silva')).toBeNull();
  });

  it('surname parts: particles, double-barrelled and multi-word surnames', () => {
    expect(screenName('Vince', 'Dijk')?.reason).toBe('surname-initial');
    expect(screenName('Tomas', 'Arnold')?.reason).toBe('surname-initial');
    expect(screenName('Tomas', 'Okafor-Arnold')?.reason).toBe('surname-initial');
    expect(screenName('Rolf', 'Riquelme')).toBeNull();
    expect(screenName('Rolf', 'Riquelme', true)?.reason).toBe('famous-surname');
  });

  it('iconic surnames and mononyms are rejected whatever the initial, in any name part', () => {
    expect(screenName('Tomas', 'Messi')?.reason).toBe('iconic');
    expect(screenName('Zane', 'Ronaldo')?.reason).toBe('iconic');
    expect(screenName('Arno', 'Pelé')?.reason).toBe('iconic');
    expect(screenName('Arno', 'Lind-Kaká')?.reason).toBe('iconic');
    expect(screenName('Neymar', 'Holmqvist')?.reason).toBe('iconic');
    expect(screenName('Arno', 'De Bruyne')?.reason).toBe('iconic');
  });

  it('near-misses of iconic surnames (one edit, 5+ letters) are rejected', () => {
    expect(screenName('Tomas', 'Messy')?.reason).toBe('near-iconic');
    expect(screenName('Tomas', 'Zidan')?.reason).toBe('near-iconic');
    expect(screenName('Tomas', 'Mbape')?.reason).toBe('near-iconic');
    expect(screenName('Tomas', 'Rivalho')?.reason).toBe('near-iconic');
    expect(screenName('Tomas', 'Totta')?.reason).toBe('near-iconic');
  });

  it('offensive fragments are rejected', () => {
    expect(OFFENSIVE_FRAGMENTS.length).toBeGreaterThan(20);
    expect(screenName('Tomas', 'Fuckerson')?.reason).toBe('offensive');
    expect(screenName('Nazira', 'Holm')?.reason).toBe('offensive');
  });

  it('invented names pass', () => {
    for (const [f, l] of [['Torvald', 'Holmqvist'], ['Chinedu', 'Okeke'], ['Rétien', 'Latier'], ['Kaito', 'Shimahara'],
      ['Zoran', 'Peček'], ['Alesco', 'Zanozzi'], ['Thabo', 'Mwambo'], ['Buray', 'Aktan']] as const) {
      expect(isNameAllowed(f, l, true), `${f} ${l}`).toBe(true);
    }
  });
});
