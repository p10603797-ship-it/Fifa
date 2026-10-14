/**
 * [PLT-03] Safe localStorage wrapper, IndexedDB blob store, and the versioned progress API (cup saves, records,
 * replays) with corruption recovery. Node only, over the fakes in plt-03-fakes.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createSettingsStore, decodeProgress, encodeProgress, LARGE_BACKUP_PREFIX, LARGE_PROGRESS_PREFIX, PROGRESS_BACKUP_PREFIX,
  PROGRESS_MARK, PROGRESS_PREFIX, PROGRESS_SCHEMAS, registerProgressSchema, SETTINGS_BACKUP_KEY, SETTINGS_KEY,
  STORAGE_LOG_KIND, type ProgressSchema, type SettingsStoreOptions,
} from '../../src/platform/settingsStore';
import {
  createBlobStore, createMemoryStorage, createSafeStorage, isQuotaError, PROBE_KEY, type BlobStore,
} from '../../src/platform/storage';
import { createFakeIdb, createFakeStorage, createManualTimers, settle, type FakeIdb, type FakeStorage } from './plt-03-fakes';

function err(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

// ============================================================ createSafeStorage

describe('PLT-03 safe localStorage', () => {
  it('a readable store whose probe write fails is read-only: stored values are read, writes stay in memory', () => {
    const fake = createFakeStorage({ initial: { a: '1' } });
    fake.quotaChars = 0;
    const s = createSafeStorage(fake);
    expect(s.persistent).toBe(false);
    expect(s.get('a')).toBe('1');
    expect(s.set('b', '2')).toBe(false);
    expect(s.get('b')).toBe('2');
    expect(fake.map.has('b')).toBe(false);
    expect(s.keys().sort()).toEqual(['a', 'b']);
    // Space comes back (the player cleared website data elsewhere): the next write persists and so does the flag.
    fake.quotaChars = Infinity;
    expect(s.set('c', '3')).toBe(true);
    expect(s.persistent).toBe(true);
    expect(fake.map.get('c')).toBe('3');
  });

  it('a failed remove leaves a tombstone so the stale value is not read back', () => {
    const fake = createFakeStorage({ initial: { k: 'old' } });
    const s = createSafeStorage(fake);
    fake.failRemoves = true;
    s.remove('k');
    expect(s.get('k')).toBeNull();
    expect(s.keys()).toEqual([]);
    expect(fake.map.get('k')).toBe('old');
    expect(s.set('k', 'new')).toBe(true);
    expect(s.get('k')).toBe('new');
  });

  it('never leaves the probe key behind and never lists it', () => {
    const fake = createFakeStorage({ initial: { [PROBE_KEY]: 'stale', x: '1' } });
    const s = createSafeStorage(fake);
    expect(fake.map.has(PROBE_KEY)).toBe(false);
    expect(s.keys()).toEqual(['x']);
  });

  it('reports failures to onError and survives a throwing onError', () => {
    const fake = createFakeStorage();
    const onError = vi.fn(() => { throw new Error('logger'); });
    const s = createSafeStorage(fake, { onError });
    fake.failWrites = true;
    expect(s.set('k', 'v')).toBe(false);
    expect(onError).toHaveBeenCalledWith('set', 'k', expect.objectContaining({ name: 'QuotaExceededError' }));
  });

  it('a backing that throws on every access, or none at all, is memory only', () => {
    expect(createSafeStorage(createFakeStorage({ blocked: true })).persistent).toBe(false);
    expect(createSafeStorage(null).persistent).toBe(false);
    const m = createMemoryStorage();
    expect(m.set('a', 'b')).toBe(false);
    expect(m.get('a')).toBe('b');
  });

  it('isQuotaError recognises every engine flavour', () => {
    expect(isQuotaError(err('QuotaExceededError'))).toBe(true);
    expect(isQuotaError(err('NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true);
    expect(isQuotaError({ name: 'Error', code: 22 })).toBe(true);
    expect(isQuotaError(err('SecurityError'))).toBe(false);
    expect(isQuotaError(null)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
  });
});

// ============================================================ blob store

describe('PLT-03 IndexedDB blob store', () => {
  it('round-trips values, lists and removes keys, and persists across connections', async () => {
    const idb = createFakeIdb();
    const b = createBlobStore({ idb: idb.factory });
    expect(b.backend).toBe('unopened');
    expect(await b.ready()).toBe(true);
    expect(b.backend).toBe('indexeddb');
    expect(await b.set('progress.a', 'A')).toBe(true);
    expect(await b.set('progress.b', 'B')).toBe(true);
    expect(await b.set('other', 'O')).toBe(true);
    expect(await b.get('progress.a')).toBe('A');
    expect(await b.get('missing')).toBeNull();
    expect(await b.keys('progress.')).toEqual(['progress.a', 'progress.b']);
    await b.remove('progress.a');
    expect(await b.get('progress.a')).toBeNull();
    b.close();
    const again = createBlobStore({ idb: idb.factory });
    expect(await again.get('progress.b')).toBe('B');
    expect(await again.removePrefix('progress.')).toBe(1);
    expect(await again.keys()).toEqual(['other']);
    expect([...idb.data().keys()]).toEqual(['other']);
  });

  it('runs operations in call order', async () => {
    const b = createBlobStore({ idb: createFakeIdb().factory });
    const w1 = b.set('k', '1');
    const w2 = b.set('k', '2');
    const r = b.get('k');
    const del = b.remove('k');
    const r2 = b.get('k');
    expect(await Promise.all([w1, w2, r, del, r2])).toEqual([true, true, '2', undefined, null]);
  });

  it('no IndexedDB: memory only, set resolves false but the value is readable this session', async () => {
    const b = createBlobStore({ idb: null });
    expect(b.backend).toBe('memory');
    expect(await b.ready()).toBe(false);
    expect(await b.set('k', 'v')).toBe(false);
    expect(await b.get('k')).toBe('v');
    expect(await b.keys()).toEqual(['k']);
    expect(await b.removePrefix('k')).toBe(1);
    expect(await b.get('k')).toBeNull();
  });

  it.each([
    ['fires onerror', { failOpen: true }],
    ['throws synchronously', { throwOnOpen: true }],
  ])('an open that %s falls back to memory and reports it', async (_name, opts) => {
    const onError = vi.fn();
    const b = createBlobStore({ idb: createFakeIdb(opts).factory, onError });
    expect(await b.set('k', 'v')).toBe(false);
    expect(b.backend).toBe('memory');
    expect(await b.get('k')).toBe('v');
    expect(onError).toHaveBeenCalledWith('open', 'dotkick', expect.anything());
  });

  it('an open that never settles (WebKit) times out to memory', async () => {
    const onError = vi.fn();
    const b = createBlobStore({ idb: createFakeIdb({ hangOpen: true }).factory, openTimeoutMs: 20, onError });
    expect(await b.set('k', 'v')).toBe(false);
    expect(b.backend).toBe('memory');
    expect(await b.get('k')).toBe('v');
    expect(String(onError.mock.calls[0]![2])).toContain('timed out');
  });

  it('a connection lost after backgrounding is reopened and the write retried once', async () => {
    const idb = createFakeIdb();
    const b = createBlobStore({ idb: idb.factory });
    await b.ready();
    idb.failNextTx = 1;
    expect(await b.set('k', 'v')).toBe(true);
    expect(idb.data().get('k')).toBe('v');
    expect(idb.opens).toBe(2);
  });

  it('a write that fails twice is kept in memory, then a later write persists it', async () => {
    const idb = createFakeIdb();
    const b = createBlobStore({ idb: idb.factory });
    idb.failNextTx = 2;
    expect(await b.set('k', 'v1')).toBe(false);
    expect(await b.get('k')).toBe('v1');
    expect(idb.data().has('k')).toBe(false);
    expect(b.backend).toBe('indexeddb');
    expect(await b.set('k', 'v2')).toBe(true);
    expect(idb.data().get('k')).toBe('v2');
    expect(await b.get('k')).toBe('v2');
  });

  it('the browser closing the connection (onclose) makes the next call reopen', async () => {
    const idb = createFakeIdb();
    const b = createBlobStore({ idb: idb.factory });
    await b.set('a', '1');
    idb.closeAll();
    expect(await b.set('b', '2')).toBe(true);
    expect(idb.opens).toBe(2);
    expect(await b.keys()).toEqual(['a', 'b']);
  });

  it('a quota abort keeps the value in memory and reports it without a retry', async () => {
    const idb = createFakeIdb({ quotaChars: 100 });
    const onError = vi.fn();
    const b = createBlobStore({ idb: idb.factory, onError });
    expect(await b.set('small', 'x')).toBe(true);
    expect(await b.set('big', 'y'.repeat(500))).toBe(false);
    expect(await b.get('big')).toBe('y'.repeat(500));
    expect(idb.data().has('big')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(isQuotaError(onError.mock.calls[0]![2])).toBe(true);
    expect(idb.opens).toBe(1);
  });

  it('a transaction that never settles times out, is aborted and retried on a fresh connection', async () => {
    const idb = createFakeIdb();
    const onError = vi.fn();
    const b = createBlobStore({ idb: idb.factory, txTimeoutMs: 20, onError });
    await b.set('a', '1');
    idb.hangNextTx = 1;
    expect(await b.set('k', 'v')).toBe(true);
    expect(idb.aborted).toBe(1);
    expect(idb.opens).toBe(2);
    expect(String(onError.mock.calls[0]![2])).toContain('timed out');
    // Two hangs in a row: the value is kept in memory and the queue keeps moving.
    idb.hangNextTx = 2;
    expect(await b.set('k', 'w')).toBe(false);
    expect(await b.get('k')).toBe('w');
    expect(await b.get('a')).toBe('1');
  });

  it('a failed delete leaves a tombstone', async () => {
    const idb = createFakeIdb();
    const b = createBlobStore({ idb: idb.factory });
    await b.set('k', 'v');
    idb.failNextTx = 2;
    await b.remove('k');
    expect(idb.data().get('k')).toBe('v');
    expect(await b.get('k')).toBeNull();
    expect(await b.keys()).toEqual([]);
  });
});

// ============================================================ progress envelope (pure)

describe('PLT-03 progress envelope', () => {
  it('encodes with the marker, format and data version, and decodes back', () => {
    const text = encodeProgress({ round: 2 }, 3)!;
    expect(JSON.parse(text)).toEqual({ [PROGRESS_MARK]: 1, v: 3, data: { round: 2 } });
    expect(decodeProgress(text, { version: 3 })).toEqual({ status: 'ok', data: { round: 2 }, version: 3 });
  });

  it('values JSON cannot hold are refused', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(encodeProgress(cyclic, 1)).toBeNull();
    expect(encodeProgress(10n, 1)).toBeNull();
    expect(encodeProgress(undefined, 1)).toBeNull();
    expect(encodeProgress(() => 1, 1)).toBeNull();
  });

  it('legacy raw values (Wave 0) are data version 0', () => {
    expect(decodeProgress('{"won":3}')).toEqual({ status: 'migrated', data: { won: 3 }, version: 1 });
    expect(decodeProgress('null')).toEqual({ status: 'empty' });
    expect(decodeProgress(JSON.stringify({ [PROGRESS_MARK]: 1, v: 1, data: null }))).toEqual({ status: 'empty' });
  });

  it('broken envelopes, bad JSON, throwing migrations and failed validation are corrupt', () => {
    expect(decodeProgress('{').status).toBe('corrupt');
    expect(decodeProgress(JSON.stringify({ [PROGRESS_MARK]: 1, data: 1 }))).toEqual({ status: 'corrupt', reason: 'bad envelope' });
    expect(decodeProgress(JSON.stringify({ [PROGRESS_MARK]: 1, v: 1 }))).toEqual({ status: 'corrupt', reason: 'bad envelope' });
    expect(decodeProgress('{"a":1}', { version: 2, migrations: { 0: () => { throw new Error('x'); } } }))
      .toEqual({ status: 'corrupt', reason: 'migration 0 failed' });
    expect(decodeProgress('{"a":1}', { version: 1, validate: () => false })).toEqual({ status: 'corrupt', reason: 'failed validation' });
    expect(decodeProgress('{"a":1}', { version: 1, validate: () => { throw new Error('v'); } }).status).toBe('corrupt');
  });

  it('a newer data version is returned as is, or unreadable when it fails this build\'s validator', () => {
    const text = encodeProgress({ x: 1 }, 9)!;
    expect(decodeProgress(text, { version: 2 })).toEqual({ status: 'newer', data: { x: 1 }, version: 9 });
    expect(decodeProgress(text, { version: 2, validate: (d) => 'y' in (d as object) })).toEqual({ status: 'unreadable', version: 9 });
  });

  it('registerProgressSchema rejects bad versions', () => {
    expect(() => registerProgressSchema('plt03-bad', { version: 0 })).toThrow(RangeError);
    expect(() => registerProgressSchema('plt03-bad', { version: 1.5 })).toThrow(RangeError);
    expect(PROGRESS_SCHEMAS['plt03-bad']).toBeUndefined();
  });
});

// ============================================================ progress through the store

function storeOver(fake: FakeStorage, opts: SettingsStoreOptions = {}) {
  const lines: string[] = [];
  const store = createSettingsStore(createSafeStorage(fake), {
    lifecycle: null, timers: createManualTimers(), blobs: createBlobStore({ idb: null }),
    log: (kind, message) => { lines.push(`${kind}: ${message}`); }, ...opts,
  });
  return { store, lines };
}

describe('PLT-03 progress API (cup saves, records)', () => {
  it('saves a versioned envelope and loads a fresh copy every time', () => {
    const fake = createFakeStorage();
    const { store } = storeOver(fake);
    const cup = { size: 8, round: 1, rounds: [[{ home: 0, away: 1 }]] };
    store.saveProgress('cup', cup);
    expect(JSON.parse(fake.map.get(PROGRESS_PREFIX + 'cup')!)).toEqual({ [PROGRESS_MARK]: 1, v: 1, data: cup });
    const a = store.loadProgress<typeof cup>('cup')!;
    const b = store.loadProgress<typeof cup>('cup')!;
    expect(a).toEqual(cup);
    expect(a).not.toBe(b);
    a.round = 9;
    expect(store.loadProgress<typeof cup>('cup')!.round).toBe(1);
  });

  it('a legacy raw value from a Wave 0 build loads and is rewritten as an envelope', () => {
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'records']: '{"played":4,"won":2}' } });
    const { store, lines } = storeOver(fake);
    expect(store.loadProgress('records')).toEqual({ played: 4, won: 2 });
    expect(JSON.parse(fake.map.get(PROGRESS_PREFIX + 'records')!)).toEqual({ [PROGRESS_MARK]: 1, v: 1, data: { played: 4, won: 2 } });
    expect(lines).toEqual([]);
  });

  it('runs the registered migrations of a key and rewrites the upgraded value', () => {
    const schemas: Record<string, ProgressSchema> = {
      cup: {
        version: 3,
        migrations: {
          1: (d) => ({ ...(d as object), humans: [0] }),
          2: (d) => ({ ...(d as object), size: 8 }),
        },
        validate: (d) => typeof d === 'object' && d !== null && 'size' in d,
      },
    };
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'cup']: encodeProgress({ round: 2 }, 1)! } });
    const { store } = storeOver(fake, { progressSchemas: schemas });
    expect(store.loadProgress('cup')).toEqual({ round: 2, humans: [0], size: 8 });
    expect(JSON.parse(fake.map.get(PROGRESS_PREFIX + 'cup')!).v).toBe(3);
  });

  it('the shared registry is read at call time (a mode registering after boot still applies)', () => {
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'plt03-late']: encodeProgress({ a: 1 }, 1)! } });
    const store = createSettingsStore(createSafeStorage(fake), { lifecycle: null, blobs: createBlobStore({ idb: null }) });
    registerProgressSchema('plt03-late', { version: 2, migrations: { 1: (d) => ({ ...(d as object), b: 2 }) } });
    try {
      expect(store.loadProgress('plt03-late')).toEqual({ a: 1, b: 2 });
    } finally {
      delete PROGRESS_SCHEMAS['plt03-late'];
    }
  });

  it('bad JSON: moved to the backup key, null returned, logged, and the next load is clean', () => {
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'cup']: '{"round":' } });
    const { store, lines } = storeOver(fake);
    expect(store.loadProgress('cup')).toBeNull();
    expect(fake.map.get(PROGRESS_BACKUP_PREFIX + 'cup')).toBe('{"round":');
    expect(fake.map.has(PROGRESS_PREFIX + 'cup')).toBe(false);
    expect(store.recoveries).toBe(1);
    expect(lines).toEqual([`${STORAGE_LOG_KIND}: progress "cup" corrupt (bad JSON): moved to ${PROGRESS_BACKUP_PREFIX}cup`]);
    expect(store.loadProgress('cup')).toBeNull();
    expect(store.recoveries).toBe(1);
  });

  it('data failing its validator on load is treated as corrupt; on save it is refused and the old save kept', () => {
    const schemas: Record<string, ProgressSchema> = {
      records: { version: 1, validate: (d) => typeof (d as { won?: unknown }).won === 'number' },
    };
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'records']: encodeProgress({ won: 'many' }, 1)! } });
    const { store, lines } = storeOver(fake, { progressSchemas: schemas });
    expect(store.loadProgress('records')).toBeNull();
    expect(fake.map.has(PROGRESS_BACKUP_PREFIX + 'records')).toBe(true);
    store.saveProgress('records', { won: 2 });
    store.saveProgress('records', { won: null });
    expect(store.loadProgress('records')).toEqual({ won: 2 });
    expect(lines.some((l) => l.includes('progress "records" failed validation: not saved'))).toBe(true);
  });

  it('a newer data version is returned and left untouched', () => {
    const text = encodeProgress({ x: 1 }, 7)!;
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'cup']: text } });
    const { store } = storeOver(fake);
    expect(store.loadProgress('cup')).toEqual({ x: 1 });
    expect(fake.map.get(PROGRESS_PREFIX + 'cup')).toBe(text);
  });

  it('a newer save this build cannot validate is ignored but kept for the newer build (no backup, no removal)', () => {
    const text = encodeProgress({ bracket: 'v7 layout' }, 7)!;
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'cup']: text } });
    const schemas: Record<string, ProgressSchema> = { cup: { version: 2, validate: (d) => Array.isArray((d as { rounds?: unknown }).rounds) } };
    const { store, lines } = storeOver(fake, { progressSchemas: schemas });
    expect(store.loadProgress('cup')).toBeNull();
    expect(fake.map.get(PROGRESS_PREFIX + 'cup')).toBe(text);
    expect(fake.map.has(PROGRESS_BACKUP_PREFIX + 'cup')).toBe(false);
    expect(store.recoveries).toBe(0);
    expect(lines).toEqual([`${STORAGE_LOG_KIND}: progress "cup" was saved by a newer version (data v7): ignored, left in place`]);
  });

  it('saving null or undefined removes the key; unserialisable values are logged, not thrown', () => {
    const fake = createFakeStorage();
    const { store, lines } = storeOver(fake);
    store.saveProgress('cup', { round: 1 });
    store.saveProgress('cup', null);
    expect(fake.map.has(PROGRESS_PREFIX + 'cup')).toBe(false);
    store.saveProgress('cup', { round: 1 });
    store.saveProgress('cup', undefined);
    expect(store.loadProgress('cup')).toBeNull();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => store.saveProgress('cup', cyclic)).not.toThrow();
    expect(lines).toEqual([`${STORAGE_LOG_KIND}: progress "cup" is not serialisable: not saved`]);
  });

  it('a progress save over a full quota is kept in memory for the session and logged', () => {
    const fake = createFakeStorage();
    const { store, lines } = storeOver(fake);
    fake.quotaChars = 50;
    store.saveProgress('cup', { bracket: 'x'.repeat(200) });
    expect(store.loadProgress<{ bracket: string }>('cup')!.bracket).toHaveLength(200);
    expect(fake.map.has(PROGRESS_PREFIX + 'cup')).toBe(false);
    expect(lines[0]).toContain('progress "cup" could not be saved');
  });

  it('progressKeys lists saved keys; removeProgress and clearProgress remove progress and its backups only', async () => {
    const fake = createFakeStorage({ initial: { [PROGRESS_PREFIX + 'broken']: '{', [SETTINGS_KEY]: '{bad' } });
    const { store } = storeOver(fake);
    store.saveProgress('records', { won: 1 });
    store.saveProgress('cup', { round: 1 });
    store.update((s) => { s.nickname = 'Keep'; });
    expect(store.progressKeys()).toEqual(['broken', 'cup', 'records']);
    store.loadProgress('broken');
    expect(fake.map.has(PROGRESS_BACKUP_PREFIX + 'broken')).toBe(true);
    store.removeProgress('records');
    expect(store.progressKeys()).toEqual(['cup']);
    await store.saveLargeProgress('replay', { frames: [1] });
    store.clearProgress();
    expect(store.progressKeys()).toEqual([]);
    expect(fake.map.has(PROGRESS_BACKUP_PREFIX + 'broken')).toBe(false);
    expect(store.get().nickname).toBe('Keep');
    expect(fake.map.has(SETTINGS_BACKUP_KEY)).toBe(true);
    expect(await store.largeProgressKeys()).toEqual([]);
  });
});

// ============================================================ large progress (IndexedDB)

function largeSetup(idb: FakeIdb = createFakeIdb()) {
  const fake = createFakeStorage();
  const lines: string[] = [];
  const blobs: BlobStore = createBlobStore({ idb: idb.factory });
  const store = createSettingsStore(createSafeStorage(fake), {
    lifecycle: null, blobs, log: (kind, message) => { lines.push(`${kind}: ${message}`); },
  });
  return { store, idb, lines, blobs };
}

describe('PLT-03 large progress (replays in IndexedDB)', () => {
  it('saves and loads a replay-sized value in a versioned envelope, across sessions', async () => {
    const { store, idb } = largeSetup();
    const replay = { format: 1, seed: 7, frames: Array.from({ length: 200_000 }, (_, i) => i % 97), ticks: 12_500 };
    expect(await store.saveLargeProgress('replay.last', replay)).toBe(true);
    const raw = idb.data().get(LARGE_PROGRESS_PREFIX + 'replay.last') as string;
    expect(raw.length).toBeGreaterThan(500_000);
    expect(JSON.parse(raw)[PROGRESS_MARK]).toBe(1);
    const next = largeSetup(idb);
    expect(await next.store.loadLargeProgress('replay.last')).toEqual(replay);
    expect(await next.store.largeProgressKeys()).toEqual(['replay.last']);
    await next.store.removeLargeProgress('replay.last');
    expect(await next.store.loadLargeProgress('replay.last')).toBeNull();
    expect(next.store.describe()).toContain('large progress indexeddb');
  });

  it('a corrupt large value moves to the backup key and loads as null', async () => {
    const idb = createFakeIdb();
    const { store, lines, blobs } = largeSetup(idb);
    await blobs.set(LARGE_PROGRESS_PREFIX + 'replay', '{"format":');
    expect(await store.loadLargeProgress('replay')).toBeNull();
    expect(idb.data().get(LARGE_BACKUP_PREFIX + 'replay')).toBe('{"format":');
    expect(idb.data().has(LARGE_PROGRESS_PREFIX + 'replay')).toBe(false);
    expect(store.recoveries).toBe(1);
    expect(lines[0]).toContain('large progress "replay" corrupt (bad JSON)');
  });

  it('clearProgress also clears large progress and its backups', async () => {
    const idb = createFakeIdb();
    const { store, blobs } = largeSetup(idb);
    await store.saveLargeProgress('a', { x: 1 });
    await blobs.set(LARGE_BACKUP_PREFIX + 'b', 'junk');
    await blobs.set('unrelated', 'keep');
    store.clearProgress();
    await settle();
    expect([...idb.data().keys()]).toEqual(['unrelated']);
  });

  it('without IndexedDB large progress lives in memory: save resolves false, load still works this session', async () => {
    const store = createSettingsStore(createMemoryStorage(), { lifecycle: null, blobs: createBlobStore({ idb: null }) });
    expect(await store.saveLargeProgress('replay', { f: [1, 2] })).toBe(false);
    expect(await store.loadLargeProgress('replay')).toEqual({ f: [1, 2] });
    expect(await store.saveLargeProgress('replay', null)).toBe(false);
    expect(await store.loadLargeProgress('replay')).toBeNull();
  });

  it('the default blob store is created lazily (no IndexedDB in Node: memory)', async () => {
    const store = createSettingsStore(createMemoryStorage(), { lifecycle: null });
    expect(store.describe()).toContain('large progress unopened');
    expect(await store.saveLargeProgress('x', { a: 1 })).toBe(false);
    expect(store.describe()).toContain('large progress memory');
  });
});
