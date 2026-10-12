import { describe, expect, it, vi } from 'vitest';
import { AssistLevel } from '../../src/contracts/enums';
import { createDefaultSettings, SETTINGS_SCHEMA_VERSION } from '../../src/contracts/settings';
import {
  createSettingsStore, mergeWithDefaults, migrateSettings, PROGRESS_PREFIX, SETTINGS_KEY, type SettingsMigration,
} from '../../src/platform/settingsStore';
import { createMemoryStorage, createSafeStorage, type StorageLike } from '../../src/platform/storage';

function fakeLocalStorage(opts: { throwAll?: boolean; quotaAfter?: number } = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  let writes = 0;
  return {
    map,
    getItem(k) { if (opts.throwAll) throw new Error('SecurityError'); return map.has(k) ? map.get(k)! : null; },
    setItem(k, v) {
      if (opts.throwAll) throw new Error('SecurityError');
      writes++;
      if (opts.quotaAfter !== undefined && writes > opts.quotaAfter) throw new Error('QuotaExceededError');
      map.set(k, v);
    },
    removeItem(k) { if (opts.throwAll) throw new Error('SecurityError'); map.delete(k); },
    key(i) { return [...map.keys()][i] ?? null; },
    get length() { return map.size; },
  };
}

describe('FND-04 safe storage', () => {
  it('falls back to memory when storage throws', () => {
    const s = createSafeStorage(fakeLocalStorage({ throwAll: true }));
    expect(s.persistent).toBe(false);
    s.set('a', '1');
    expect(s.get('a')).toBe('1');
    s.remove('a');
    expect(s.get('a')).toBeNull();
  });

  it('falls back to memory when there is no storage at all', () => {
    const s = createSafeStorage(null);
    expect(s.persistent).toBe(false);
    s.set('x', 'y');
    expect(s.keys()).toEqual(['x']);
  });

  it('keeps values written after a quota error in memory for the session', () => {
    const backing = fakeLocalStorage({ quotaAfter: 2 }); // probe write + one more
    const s = createSafeStorage(backing);
    expect(s.persistent).toBe(true);
    expect(s.set('k1', 'v1')).toBe(true);
    expect(s.set('k2', 'v2')).toBe(false);
    expect(s.get('k2')).toBe('v2');
    expect(backing.map.has('k2')).toBe(false);
    expect(s.keys('k').sort()).toEqual(['k1', 'k2']);
    expect(backing.map.has('__dotkick_probe__')).toBe(false);
  });
});

describe('FND-04 settings migration and merge', () => {
  it('fills missing and mistyped fields from the defaults', () => {
    const merged = mergeWithDefaults({
      audio: { master: 0.3, crowd: 'loud' },
      controls: { touch: { layout: { '0': { dx: 10, dy: 20, scale: 1.1 } }, opacity: Number.NaN } },
      nickname: 42,
      debug: true,
      extra: 'ignored',
    });
    const d = createDefaultSettings();
    expect(merged.audio.master).toBe(0.3);
    expect(merged.audio.crowd).toBe(d.audio.crowd);
    expect(merged.controls.touch.layout).toEqual({ '0': { dx: 10, dy: 20, scale: 1.1 } });
    expect(merged.controls.touch.opacity).toBe(d.controls.touch.opacity);
    expect(merged.nickname).toBe(d.nickname);
    expect(merged.debug).toBe(true);
    expect((merged as unknown as Record<string, unknown>).extra).toBeUndefined();
  });

  it('returns defaults for corrupt input', () => {
    expect(migrateSettings(null)).toEqual(createDefaultSettings());
    expect(migrateSettings('nope')).toEqual(createDefaultSettings());
    expect(migrateSettings([1, 2])).toEqual(createDefaultSettings());
  });

  it('runs the migration chain from an old schema to the target', () => {
    const calls: number[] = [];
    const migrations: Record<number, SettingsMigration> = {
      0: (raw) => { calls.push(0); return { ...raw, nickname: 'from-v0' }; },
      1: (raw) => { calls.push(1); return raw; },
      2: (raw) => { calls.push(2); const a = raw.audio as Record<string, number>; return { ...raw, audio: { ...a, master: a.master / 2 } }; },
    };
    const out = migrateSettings({ audio: { master: 0.8 } }, migrations, 3);
    expect(calls).toEqual([0, 1, 2]);
    expect(out.schema).toBe(3);
    expect(out.nickname).toBe('from-v0');
    expect(out.audio.master).toBeCloseTo(0.4);
  });

  it('a throwing migration yields defaults; a newer schema keeps compatible fields', () => {
    const bad = migrateSettings({ schema: 0 }, { 0: () => { throw new Error('x'); } }, 1);
    expect(bad).toEqual(createDefaultSettings());
    const newer = migrateSettings({ schema: SETTINGS_SCHEMA_VERSION + 5, nickname: 'Future' });
    expect(newer.nickname).toBe('Future');
    expect(newer.schema).toBe(SETTINGS_SCHEMA_VERSION);
  });
});

describe('FND-04 settings store', () => {
  it('loads defaults, persists updates and notifies subscribers', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore(storage);
    expect(store.get()).toEqual(createDefaultSettings());
    expect(store.persistent).toBe(false);
    const fn = vi.fn();
    const unsub = store.subscribe(fn);
    const before = store.get();
    store.update((s) => { s.controls.assist = AssistLevel.MANUAL; s.audio.menus = 0.1; });
    expect(store.get().controls.assist).toBe(AssistLevel.MANUAL);
    expect(before.controls.assist).toBe(AssistLevel.ASSISTED); // updates produce a new object
    expect(fn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.get(SETTINGS_KEY)!).audio.menus).toBe(0.1);
    unsub();
    store.reset();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(store.get()).toEqual(createDefaultSettings());
  });

  it('reloads persisted settings and survives corrupt JSON', () => {
    const storage = createMemoryStorage();
    createSettingsStore(storage).update((s) => { s.nickname = 'Ada'; });
    expect(createSettingsStore(storage).get().nickname).toBe('Ada');
    storage.set(SETTINGS_KEY, '{not json');
    expect(createSettingsStore(storage).get()).toEqual(createDefaultSettings());
  });

  it('works with blocked storage (memory only)', () => {
    const store = createSettingsStore(createSafeStorage(fakeLocalStorage({ throwAll: true })));
    expect(store.persistent).toBe(false);
    store.update((s) => { s.debug = true; });
    expect(store.get().debug).toBe(true);
  });

  it('a throwing subscriber does not break updates', () => {
    const store = createSettingsStore(createMemoryStorage());
    store.subscribe(() => { throw new Error('bad listener'); });
    const ok = vi.fn();
    store.subscribe(ok);
    store.update((s) => { s.debug = true; });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('saves, loads and clears progress keys', () => {
    const storage = createMemoryStorage();
    const store = createSettingsStore(storage);
    expect(store.loadProgress('cup')).toBeNull();
    store.saveProgress('cup', { round: 2, clubs: [1, 2] });
    store.saveProgress('records', { won: 3 });
    expect(store.loadProgress<{ round: number }>('cup')!.round).toBe(2);
    storage.set(PROGRESS_PREFIX + 'broken', '{');
    expect(store.loadProgress('broken')).toBeNull();
    store.update((s) => { s.nickname = 'Keep'; });
    store.clearProgress();
    expect(store.loadProgress('cup')).toBeNull();
    expect(store.loadProgress('records')).toBeNull();
    expect(store.get().nickname).toBe('Keep');
  });
});
