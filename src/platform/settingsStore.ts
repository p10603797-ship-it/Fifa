/**
 * [PLT-03] Settings store with schema version, migrations and progress keys (Wave 0 version by FND-04).
 *
 * Settings live under SETTINGS_KEY as JSON `{ schema, ...Settings }`. Loading runs the migration chain from the
 * stored schema up to SETTINGS_SCHEMA_VERSION, then merges the result over createDefaultSettings() so missing or
 * mistyped fields fall back to defaults (forward and backward compatible). Progress (cup runs, records, ...) is
 * stored per key under PROGRESS_PREFIX.
 */
import type { SettingsStore } from '../contracts/app';
import { createDefaultSettings, SETTINGS_SCHEMA_VERSION, type Settings } from '../contracts/settings';
import { createSafeStorage, type KeyValueStorage } from './storage';

export { createDefaultSettings };

export const SETTINGS_KEY = 'dotkick.settings';
export const PROGRESS_PREFIX = 'dotkick.progress.';

/** Upgrades a raw settings blob from schema v to v + 1 (registered as SETTINGS_MIGRATIONS[v]). */
export type SettingsMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Migration chain. Add `SETTINGS_MIGRATIONS[n] = (raw) => ...` when bumping SETTINGS_SCHEMA_VERSION from n to n + 1.
 * Entry 0 upgrades pre-versioned blobs (no `schema` field).
 */
export const SETTINGS_MIGRATIONS: Record<number, SettingsMigration> = {
  0: (raw) => ({ ...raw, schema: 1 }),
};

export interface SettingsStoreOptions {
  migrations?: Record<number, SettingsMigration>;
  /** Target schema (tests). Defaults to SETTINGS_SCHEMA_VERSION. */
  schemaVersion?: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function mergeValue(def: unknown, stored: unknown): unknown {
  if (Array.isArray(def)) return Array.isArray(stored) ? cloneJson(stored) : cloneJson(def);
  if (isPlainObject(def)) {
    if (!isPlainObject(stored)) return cloneJson(def);
    const keys = Object.keys(def);
    // An empty default object is a free-form record (layout, remaps, flags): take the stored record as is.
    if (keys.length === 0) return cloneJson(stored);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = mergeValue(def[k], stored[k]);
    return out;
  }
  if (typeof def === 'number') return typeof stored === 'number' && Number.isFinite(stored) ? stored : def;
  if (typeof def === 'boolean') return typeof stored === 'boolean' ? stored : def;
  if (typeof def === 'string') return typeof stored === 'string' ? stored : def;
  return def;
}

/** Merge a stored blob over the defaults: every default key exists with the default's type. Pure. */
export function mergeWithDefaults(stored: unknown, defaults: Settings = createDefaultSettings()): Settings {
  return mergeValue(defaults, stored) as Settings;
}

/**
 * Bring a raw stored value to the current schema and merge it over the defaults. Unknown or corrupt input yields
 * the defaults. A blob from a newer schema keeps every compatible field. Pure.
 */
export function migrateSettings(
  raw: unknown,
  migrations: Record<number, SettingsMigration> = SETTINGS_MIGRATIONS,
  target: number = SETTINGS_SCHEMA_VERSION,
): Settings {
  if (!isPlainObject(raw)) return createDefaultSettings();
  let blob: Record<string, unknown> = { ...raw };
  let v = typeof blob.schema === 'number' && Number.isFinite(blob.schema) ? Math.floor(blob.schema) : 0;
  while (v < target) {
    const m = migrations[v];
    if (m) {
      try {
        blob = m(blob);
      } catch {
        return createDefaultSettings();
      }
    }
    v++;
  }
  const merged = mergeWithDefaults(blob);
  merged.schema = target;
  return merged;
}

/** Create the settings store. Storage defaults to safe localStorage with a memory fallback. */
export function createSettingsStore(storage: KeyValueStorage = createSafeStorage(), opts: SettingsStoreOptions = {}): SettingsStore {
  const target = opts.schemaVersion ?? SETTINGS_SCHEMA_VERSION;
  const migrations = opts.migrations ?? SETTINGS_MIGRATIONS;
  const listeners = new Set<(s: Readonly<Settings>) => void>();

  function load(): Settings {
    const text = storage.get(SETTINGS_KEY);
    if (text === null) return createDefaultSettings();
    try {
      return migrateSettings(JSON.parse(text), migrations, target);
    } catch {
      return createDefaultSettings();
    }
  }

  let current: Settings = load();

  function persist(): void {
    try {
      storage.set(SETTINGS_KEY, JSON.stringify(current));
    } catch {
      /* storage layer already falls back to memory */
    }
  }

  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn(current);
      } catch {
        /* a broken listener must not break settings */
      }
    }
  }

  return {
    get: () => current,
    update(mut) {
      const next = cloneJson(current);
      mut(next);
      current = mergeWithDefaults(next);
      current.schema = target;
      persist();
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    reset() {
      current = createDefaultSettings();
      current.schema = target;
      persist();
      notify();
    },
    get persistent() {
      return storage.persistent;
    },
    loadProgress<T>(key: string): T | null {
      const text = storage.get(PROGRESS_PREFIX + key);
      if (text === null) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    },
    saveProgress<T>(key: string, value: T): void {
      try {
        storage.set(PROGRESS_PREFIX + key, JSON.stringify(value));
      } catch {
        /* unserialisable values are dropped */
      }
    },
    clearProgress() {
      for (const k of storage.keys(PROGRESS_PREFIX)) storage.remove(k);
    },
  };
}
