/**
 * [NET-03] Room codes and share links: alphabet, generation, validation / normalisation, link building and parsing on
 * boot. Pure functions, no network.
 */
import { describe, expect, it } from 'vitest';
import {
  formatRoomCode, generateRoomCode, isRoomCode, isRoomCodeChar, normaliseRoomCode, randomRoomCode, ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH, roomCodeFromUrl, roomLink, urlWithoutRoom,
} from '../../src/net/roomCode';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('NET-03 room code alphabet', () => {
  it('has no ambiguous characters (0/O, 1/I/L) and no duplicates', () => {
    for (const ch of '0O1IL') expect(ROOM_CODE_ALPHABET.includes(ch)).toBe(false);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
    expect(ROOM_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
    expect(ROOM_CODE_LENGTH).toBe(6);
  });

  it('generates 6-character codes from the alphabet only, using every character', () => {
    const r = seeded(7);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = generateRoomCode(r);
      expect(c).toHaveLength(6);
      expect(isRoomCode(c)).toBe(true);
      for (const ch of c) seen.add(ch);
    }
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length);
  });

  it('clamps out-of-range random values instead of producing bad characters', () => {
    expect(generateRoomCode(() => 0)).toBe('AAAAAA');
    expect(generateRoomCode(() => 0.9999999)).toBe('999999');
    expect(isRoomCode(generateRoomCode(() => 1))).toBe(true);
    expect(isRoomCode(generateRoomCode(() => -3))).toBe(true);
    expect(isRoomCode(generateRoomCode(() => Number.NaN))).toBe(true);
  });

  it('randomRoomCode uses the platform random source and gives valid, varied codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) codes.add(randomRoomCode());
    for (const c of codes) expect(isRoomCode(c)).toBe(true);
    expect(codes.size).toBeGreaterThan(45);
  });
});

describe('NET-03 room code validation', () => {
  it('normalises case, spaces and separators', () => {
    expect(normaliseRoomCode('abcdef')).toBe('ABCDEF');
    expect(normaliseRoomCode(' abc def ')).toBe('ABCDEF');
    expect(normaliseRoomCode('ABC-DEF')).toBe('ABCDEF');
    expect(normaliseRoomCode('k7q.wmz')).toBe('K7QWMZ');
  });

  it('rejects wrong lengths, ambiguous and foreign characters', () => {
    for (const bad of ['', '   ', 'ABCDE', 'ABCDEFG', 'ABCDE0', 'ABCDEO', 'ABCDE1', 'ABCDEI', 'ABCDEL', 'ABC!EF', 'ÄBCDEF', 'AB CD']) {
      expect(normaliseRoomCode(bad)).toBeNull();
    }
    expect(normaliseRoomCode(42 as unknown as string)).toBeNull();
    expect(isRoomCode('abcdef')).toBe(false);
    expect(isRoomCodeChar('k')).toBe(true);
    expect(isRoomCodeChar('0')).toBe(false);
    expect(isRoomCodeChar('AB')).toBe(false);
  });

  it('accepts a pasted share link in the code field', () => {
    expect(normaliseRoomCode('https://dotkick.app/play/?room=K7QWMZ')).toBe('K7QWMZ');
    expect(normaliseRoomCode('dotkick.app/?room=k7qwmz')).toBe('K7QWMZ');
    expect(normaliseRoomCode('https://dotkick.app/play/')).toBeNull();
  });

  it('formats codes in two groups of three for display', () => {
    expect(formatRoomCode('ABCDEF')).toBe('ABC DEF');
    expect(formatRoomCode('ABCD')).toBe('ABC D');
    expect(formatRoomCode('AB')).toBe('AB');
  });
});

describe('NET-03 share links', () => {
  it('builds <origin><path>?room=CODE from the page URL, dropping other query and hash', () => {
    expect(roomLink('K7QWMZ', 'https://dotkick.app/play/index.html?debug=1#x')).toBe('https://dotkick.app/play/index.html?room=K7QWMZ');
    expect(roomLink('k7q wmz', 'http://localhost:5173/')).toBe('http://localhost:5173/?room=K7QWMZ');
    expect(() => roomLink('NOPE', 'https://dotkick.app/')).toThrow(RangeError);
  });

  it('parses the code from a share link on boot (query and hash forms), or null', () => {
    expect(roomCodeFromUrl('https://dotkick.app/?room=K7QWMZ')).toBe('K7QWMZ');
    expect(roomCodeFromUrl('https://dotkick.app/?x=1&room=k7q-wmz')).toBe('K7QWMZ');
    expect(roomCodeFromUrl('https://dotkick.app/#room=K7QWMZ')).toBe('K7QWMZ');
    expect(roomCodeFromUrl('https://dotkick.app/')).toBeNull();
    expect(roomCodeFromUrl('https://dotkick.app/?room=BAD0OO')).toBeNull();
    expect(roomCodeFromUrl('https://dotkick.app/?room=')).toBeNull();
    expect(roomCodeFromUrl('')).toBeNull();
  });

  it('round-trips: roomCodeFromUrl(roomLink(code)) === code', () => {
    const r = seeded(3);
    for (let i = 0; i < 100; i++) {
      const c = generateRoomCode(r);
      expect(roomCodeFromUrl(roomLink(c, 'https://example.org/dotkick/'))).toBe(c);
    }
  });

  it('removes the room parameter after leaving a room (keeps the rest)', () => {
    expect(urlWithoutRoom('https://dotkick.app/play/?room=K7QWMZ')).toBe('https://dotkick.app/play/');
    expect(urlWithoutRoom('https://dotkick.app/?a=1&room=K7QWMZ')).toBe('https://dotkick.app/?a=1');
    expect(urlWithoutRoom('https://dotkick.app/#room=K7QWMZ')).toBe('https://dotkick.app/');
    expect(urlWithoutRoom('https://dotkick.app/?a=1')).toBe('https://dotkick.app/?a=1');
  });
});
