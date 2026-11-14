/**
 * [GATE] Password lock logic (src/app/gate.ts, src/app/sha256.ts, tools/gate-codes.mjs; D-047, D-048). The online
 * checker and its client are tests/unit/gate-02-online.test.ts. Test codes only: real codes are never in the repository.
 */
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODE_ALPHABET, CODE_LENGTH, GATE_HASH_PREFIX, GATE_UNLOCK_KEY, GATE_USED_KEY, acceptedHashes, createGate,
  createLocalRedeemer, defaultDigest, fallbackDigest, formatCode, hashCode, normaliseCode, parseUnlockRecord,
  parseUsedList, readTestHook, subtleDigest, unlockRecordJson, type CodeRedeemer, type RedeemResult,
} from '../../src/app/gate';
import { sha256Bytes, sha256HexFallback, toHex } from '../../src/app/sha256';
import { createMemoryStorage, createSafeStorage, type KeyValueStorage, type StorageLike } from '../../src/platform/storage';

/** tools/gate-codes.mjs (plain ESM, no type declarations). */
interface GateCodesTool {
  CODE_ALPHABET: string;
  CODE_LENGTH: number;
  GATE_HASH_PREFIX: string;
  normaliseCode(input: string): string;
  formatCode(code: string): string;
  hashCode(code: string): string;
  newCode(rand?: (n: number) => number): string;
  newCodes(n: number, existing?: readonly string[], rand?: (n: number) => number): string[];
  parseHashList(text: string): string[];
  insertStatement(hashes: readonly string[]): { sql: string; params: string[] };
}
const tool = (await import(/* @vite-ignore */ new URL('../../tools/gate-codes.mjs', import.meta.url).href)) as GateCodesTool;

const nodeHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const testHash = (code: string): string => nodeHash(GATE_HASH_PREFIX + normaliseCode(code));

const CODE_A = 'TSTA-2345-6789';
const CODE_B = 'TSTB-ABCD-EFGH';
const CODE_C = 'TSTC-JKMN-PQRS';
const TEST_HASHES = [CODE_A, CODE_B, CODE_C].map(testHash);

/** A localStorage stand-in (Map-backed) whose operations can be made to throw. */
function fakeBacking(opts: { getThrows?: boolean; setThrows?: boolean } = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem(k) {
      if (opts.getThrows) throw new DOMException('blocked', 'SecurityError');
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k, v) {
      if (opts.setThrows) throw new DOMException('quota', 'QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k) {
      map.delete(k);
    },
    key(i) {
      return [...map.keys()][i] ?? null;
    },
    get length() {
      return map.size;
    },
  };
}

function setup(storage: KeyValueStorage = createSafeStorage(fakeBacking()), hashes: readonly string[] = TEST_HASHES) {
  const redeemer = createLocalRedeemer({ storage, hashes, digest: fallbackDigest });
  const gate = createGate({ storage, redeemer, now: () => 1234 });
  return { storage, redeemer, gate };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GATE code normalisation', () => {
  it('upper case, everything but A-Z and 0-9 removed: dashes, spaces and case do not matter', () => {
    expect(normaliseCode('abcd-efgh-jkmn')).toBe('ABCDEFGHJKMN');
    expect(normaliseCode('ABCD EFGH JKMN')).toBe('ABCDEFGHJKMN');
    expect(normaliseCode('  aBcD_eFgH.jKmN \n')).toBe('ABCDEFGHJKMN');
    expect(normaliseCode('ABCDEFGHJKMN')).toBe('ABCDEFGHJKMN');
    expect(normaliseCode('')).toBe('');
    expect(normaliseCode('— –')).toBe('');
    expect(formatCode('abcdefghjkmn')).toBe('ABCD-EFGH-JKMN');
    expect(formatCode('ab cd')).toBe('ABCD');
  });

  it('every spelling of one code has the same hash', async () => {
    const spellings = ['tsta-2345-6789', 'TSTA 2345 6789', 'TSTA23456789', ' t s t a 2345-6789 '];
    const hashes = await Promise.all(spellings.map((s) => hashCode(s, fallbackDigest)));
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(testHash(CODE_A));
  });

  it('the code alphabet has no easily misread characters; codes are 12 long', () => {
    expect(CODE_ALPHABET).toHaveLength(31);
    for (const ch of 'ILO01') expect(CODE_ALPHABET).not.toContain(ch);
    expect(CODE_LENGTH).toBe(12);
  });
});

describe('GATE SHA-256 fallback', () => {
  it('matches the FIPS 180 / NIST test vectors', () => {
    expect(sha256HexFallback('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256HexFallback('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256HexFallback('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))
      .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
    expect(sha256HexFallback('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'))
      .toBe('cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1');
    expect(sha256HexFallback('a'.repeat(1_000_000))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
    expect(sha256HexFallback('The quick brown fox jumps over the lazy dog'))
      .toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
  });

  it('agrees with node:crypto at every padding boundary and on random bytes', () => {
    for (let n = 0; n <= 200; n++) {
      const bytes = randomBytes(n);
      expect(toHex(sha256Bytes(new Uint8Array(bytes))), `length ${n}`).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('agrees with crypto.subtle on random strings (ASCII, codes and non-ASCII)', async () => {
    const subtle = webcrypto.subtle;
    const strings = ['', 'dotkick-gate-v1:ABCDEFGHJKMN', 'é ü 漢字 🎉', 'x'.repeat(64), 'y'.repeat(55)];
    for (let i = 0; i < 60; i++) strings.push(randomBytes(1 + (i * 7) % 150).toString('base64'));
    for (let i = 0; i < 20; i++) strings.push(String.fromCodePoint(...Array.from({ length: 1 + i }, (_, j) => 0x20 + ((i * 131 + j * 977) % 0x2fff))));
    for (const s of strings) {
      const ref = toHex(new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(s))));
      expect(sha256HexFallback(s), JSON.stringify(s)).toBe(ref);
    }
  });

  it('defaultDigest uses crypto.subtle when present, the fallback when missing or failing; all agree', async () => {
    const text = 'dotkick-gate-v1:TSTA23456789';
    const want = nodeHash(text);
    expect(subtleDigest()).not.toBeNull(); // Node has crypto.subtle
    expect(await defaultDigest()(text)).toBe(want);
    vi.stubGlobal('crypto', undefined); // plain http on a LAN address: no crypto.subtle
    expect(subtleDigest()).toBeNull();
    expect(await defaultDigest()(text)).toBe(want);
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('NotSupportedError')) } });
    expect(await defaultDigest()(text)).toBe(want);
  });
});

describe('GATE no code list in the game', () => {
  it('the shipped game has no list of hashes: the online checker holds them (D-048)', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    expect(existsSync(new URL('../../src/data/gateCodes.ts', import.meta.url))).toBe(false);
    const boot = readFileSync(new URL('../../src/app/gateBoot.ts', import.meta.url), 'utf8');
    expect(boot).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe('GATE redeem and unlock', () => {
  it('a fresh device is locked; a wrong code is refused; a listed code unlocks and is remembered', async () => {
    const { gate, storage } = setup();
    expect(gate.isUnlocked()).toBe(false);
    expect(await gate.unlock('NOPE-NOPE-NOPE')).toEqual({ result: 'wrong', remembered: false });
    expect(await gate.unlock('')).toEqual({ result: 'wrong', remembered: false });
    expect(await gate.unlock('---')).toEqual({ result: 'wrong', remembered: false });
    expect(gate.isUnlocked()).toBe(false);
    expect(await gate.unlock('tsta 2345 6789')).toEqual({ result: 'ok', remembered: true });
    expect(gate.isUnlocked()).toBe(true);
    expect(parseUnlockRecord(storage.get(GATE_UNLOCK_KEY))).toEqual({ v: 1, at: 1234 });
    expect(parseUsedList(storage.get(GATE_USED_KEY))).toEqual([testHash(CODE_A)]);
    // A new page on the same device (a reload): still unlocked.
    expect(setup(storage).gate.isUnlocked()).toBe(true);
  });

  it('a code works once: used twice is refused; after clearing only the unlock record it is still used; another code works', async () => {
    const backing = fakeBacking();
    const first = setup(createSafeStorage(backing));
    expect((await first.gate.unlock(CODE_A)).result).toBe('ok');
    expect((await first.gate.unlock(CODE_A)).result).toBe('used');
    expect((await first.gate.unlock('tsta-2345-6789')).result).toBe('used');
    backing.map.delete(GATE_UNLOCK_KEY);
    const again = setup(createSafeStorage(backing));
    expect(again.gate.isUnlocked()).toBe(false);
    expect(await again.gate.unlock(CODE_A)).toEqual({ result: 'used', remembered: false });
    expect(again.gate.isUnlocked()).toBe(false);
    expect(await again.gate.unlock(CODE_B)).toEqual({ result: 'ok', remembered: true });
    expect(again.gate.isUnlocked()).toBe(true);
    expect(parseUsedList(backing.map.get(GATE_USED_KEY) ?? null).sort()).toEqual([testHash(CODE_A), testHash(CODE_B)].sort());
  });

  it('a wrong code is checked before the used list (a used code never reads as wrong, a wrong one never as used)', async () => {
    const { gate } = setup();
    await gate.unlock(CODE_A);
    expect((await gate.unlock('ZZZZ-ZZZZ-ZZZZ')).result).toBe('wrong');
    expect((await gate.unlock(CODE_A)).result).toBe('used');
  });

  it('two quick submits of one code: exactly one opens', async () => {
    const { redeemer } = setup();
    const results = await Promise.all([redeemer.redeem(CODE_C), redeemer.redeem(CODE_C), redeemer.redeem(CODE_C)]);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'used')).toHaveLength(2);
  });

  it('storage that throws on every access: the code opens the game for this session, not remembered', async () => {
    const storage = createSafeStorage(fakeBacking({ getThrows: true }));
    expect(storage.persistent).toBe(false);
    const { gate } = setup(storage);
    expect(gate.isUnlocked()).toBe(false);
    expect(await gate.unlock(CODE_A)).toEqual({ result: 'ok', remembered: false });
    expect(gate.isUnlocked()).toBe(true);
    expect((await gate.unlock(CODE_A)).result).toBe('used'); // within the session
  });

  it('read-only storage (quota full: every write throws) and memory-only storage are not remembered', async () => {
    const ro = setup(createSafeStorage(fakeBacking({ setThrows: true })));
    expect(await ro.gate.unlock(CODE_A)).toEqual({ result: 'ok', remembered: false });
    expect(ro.gate.isUnlocked()).toBe(true);
    const mem = setup(createMemoryStorage());
    expect(await mem.gate.unlock(CODE_A)).toEqual({ result: 'ok', remembered: false });
    expect(mem.gate.isUnlocked()).toBe(true);
    expect(setup(createSafeStorage(null)).gate.isUnlocked()).toBe(false); // no localStorage at all
  });

  it('a redeemer that fails or answers offline-error never unlocks (the plug-in point for an online checker)', async () => {
    const storage = createMemoryStorage();
    const throwing: CodeRedeemer = { redeem: () => Promise.reject(new Error('network down')) };
    const offline: CodeRedeemer = { redeem: () => Promise.resolve<RedeemResult>('offline-error') };
    for (const redeemer of [throwing, offline]) {
      const gate = createGate({ storage, redeemer });
      expect(await gate.unlock(CODE_A)).toEqual({ result: 'offline-error', remembered: false });
      expect(gate.isUnlocked()).toBe(false);
    }
    const online: CodeRedeemer = { redeem: () => Promise.resolve<RedeemResult>('ok') };
    const gate = createGate({ storage: createSafeStorage(fakeBacking()), redeemer: online });
    expect(await gate.unlock('anything')).toEqual({ result: 'ok', remembered: true });
  });

  it('malformed hashes in the accepted list are ignored', async () => {
    const { gate } = setup(createSafeStorage(fakeBacking()), ['', 'XYZ', testHash(CODE_A).toUpperCase(), testHash(CODE_B)]);
    expect((await gate.unlock(CODE_A)).result).toBe('wrong');
    expect((await gate.unlock(CODE_B)).result).toBe('ok');
  });
});

describe('GATE stored records', () => {
  it('a malformed unlock record counts as locked; only { v: 1, at: finite number } unlocks', () => {
    for (const raw of ['', 'null', '[]', '{}', 'true', '1', '"x"', '{"v":2,"at":1}', '{"v":1}', '{"v":1,"at":"5"}',
      '{"v":1,"at":null}', '{"v":"1","at":5}', '{garbage', '[{"v":1,"at":5}]']) {
      expect(parseUnlockRecord(raw), raw).toBeNull();
      const backing = fakeBacking();
      backing.map.set(GATE_UNLOCK_KEY, raw);
      expect(setup(createSafeStorage(backing)).gate.isUnlocked(), raw).toBe(false);
    }
    expect(parseUnlockRecord(null)).toBeNull();
    expect(parseUnlockRecord(unlockRecordJson(0))).toEqual({ v: 1, at: 0 });
    expect(parseUnlockRecord('{"v":1,"at":1700000000000,"extra":true}')).toEqual({ v: 1, at: 1700000000000 });
  });

  it('a malformed used list keeps only its well-formed hashes; a listed used code stays used', async () => {
    const hA = testHash(CODE_A);
    expect(parseUsedList(null)).toEqual([]);
    for (const raw of ['', 'garbage', 'null', '[]', '{"used":"x"}', '{"used":null}']) expect(parseUsedList(raw), raw).toEqual([]);
    expect(parseUsedList(JSON.stringify({ v: 1, used: ['nope', 42, hA.toUpperCase(), hA, hA, null] }))).toEqual([hA]);
    const backing = fakeBacking();
    backing.map.set(GATE_USED_KEY, JSON.stringify({ v: 1, used: ['nope', hA] }));
    const { gate } = setup(createSafeStorage(backing));
    expect((await gate.unlock(CODE_A)).result).toBe('used');
    backing.map.set(GATE_USED_KEY, '{broken');
    expect((await gate.unlock(CODE_B)).result).toBe('ok');
    expect(parseUsedList(backing.map.get(GATE_USED_KEY)!)).toEqual([testHash(CODE_B)]);
  });
});

describe('GATE test hook', () => {
  it('window.__dotkickGateTest: well-formed hashes and an http(s) serverUrl only; absent or malformed, nothing', () => {
    expect(readTestHook()).toBeNull(); // no window in node
    vi.stubGlobal('window', {});
    expect(readTestHook()).toBeNull();
    vi.stubGlobal('window', { __dotkickGateTest: { hashes: [TEST_HASHES[0], 'bad', TEST_HASHES[0]] } });
    expect(readTestHook()).toEqual({ hashes: [TEST_HASHES[0]], serverUrl: null });
    vi.stubGlobal('window', { __dotkickGateTest: { hashes: 'not a list' } });
    expect(readTestHook()).toBeNull();
    vi.stubGlobal('window', { __dotkickGateTest: { serverUrl: 'https://checker.example/redeem' } });
    expect(readTestHook()).toEqual({ hashes: null, serverUrl: 'https://checker.example/redeem' });
    for (const bad of ['javascript:alert(1)', 'ftp://x.example/', '', 42, 'https://a b.example/']) {
      vi.stubGlobal('window', { __dotkickGateTest: { serverUrl: bad } });
      expect(readTestHook(), String(bad)).toBeNull();
    }
    vi.stubGlobal('window', { get __dotkickGateTest() { throw new Error('boom'); } });
    expect(readTestHook()).toBeNull();
    expect(acceptedHashes(['x', TEST_HASHES[1], TEST_HASHES[1]])).toEqual([TEST_HASHES[1]]);
  });
});

describe('GATE tools/gate-codes.mjs', () => {
  it('makes codes from the alphabet, 12 long, with the same normalisation and hash as the game', async () => {
    expect(tool.CODE_ALPHABET).toBe(CODE_ALPHABET);
    expect(tool.CODE_LENGTH).toBe(CODE_LENGTH);
    expect(tool.GATE_HASH_PREFIX).toBe(GATE_HASH_PREFIX);
    const codes = tool.newCodes(50, []);
    expect(new Set(codes).size).toBe(50);
    for (const c of codes) {
      expect(c).toMatch(new RegExp(`^[${CODE_ALPHABET}]{12}$`));
      expect(tool.formatCode(c)).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(tool.normaliseCode(tool.formatCode(c).toLowerCase())).toBe(normaliseCode(c));
      expect(tool.hashCode(c)).toBe(await hashCode(c, fallbackDigest));
    }
    expect(tool.hashCode('abcd efgh jkmn')).toBe(tool.hashCode('ABCD-EFGH-JKMN'));
  });

  it('uses every alphabet character (uniform draw) and never repeats a listed hash', () => {
    let i = 0;
    const seq = (n: number): number => (i++) % n;
    const c = tool.newCode(seq);
    expect(c).toBe(CODE_ALPHABET.slice(0, 12));
    const listed = [tool.hashCode(CODE_ALPHABET.slice(0, 12))];
    i = 0;
    const out = tool.newCodes(1, listed, (n: number) => (i++) % n);
    expect(tool.hashCode(out[0]!)).not.toBe(listed[0]);
  });

  it('reads hash lists (one per line, # comments) and builds the INSERT OR IGNORE for the checker', () => {
    expect(tool.parseHashList(`# test\n${TEST_HASHES[0]}\n\n  ${TEST_HASHES[1]}  # b\n${TEST_HASHES[0]}\n`)).toEqual(TEST_HASHES.slice(0, 2));
    expect(() => tool.parseHashList('nope')).toThrow(/line 1/);
    expect(() => tool.parseHashList(TEST_HASHES[0]!.toUpperCase())).toThrow();
    const st = tool.insertStatement(TEST_HASHES);
    expect(st).toEqual({ sql: 'INSERT OR IGNORE INTO codes (hash) VALUES (?), (?), (?)', params: TEST_HASHES });
    expect(() => tool.insertStatement([])).toThrow();
    expect(() => tool.insertStatement(['x'])).toThrow();
    expect(() => tool.insertStatement(Array.from({ length: 91 }, () => TEST_HASHES[0]!))).toThrow();
  });
});
