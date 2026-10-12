/**
 * [PLT-03] Safe key-value storage (Wave 0 version by FND-04).
 *
 * Wraps `localStorage` so a blocked, full or throwing storage (Safari private mode, quota, disabled site data)
 * never breaks the game: every access is in try/catch and values fall back to an in-memory map for the rest of
 * the session. `persistent` reports whether values survive a reload.
 */

export interface KeyValueStorage {
  /** False when the backing store is unavailable and values live in memory only. */
  readonly persistent: boolean;
  get(key: string): string | null;
  /** Returns false when the value could only be kept in memory (quota, blocked). */
  set(key: string, value: string): boolean;
  remove(key: string): void;
  /** Keys currently stored, optionally filtered by prefix. Allocates (not for hot paths). */
  keys(prefix?: string): string[];
}

/** Minimal subset of the DOM Storage interface we rely on (lets tests pass fakes). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

const PROBE_KEY = '__dotkick_probe__';

/** Pure in-memory storage (tests, blocked storage). */
export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    persistent: false,
    get: (k) => (map.has(k) ? map.get(k)! : null),
    set: (k, v) => { map.set(k, v); return false; },
    remove: (k) => { map.delete(k); },
    keys: (prefix = '') => [...map.keys()].filter((k) => k.startsWith(prefix)),
  };
}

/** Returns `globalThis.localStorage` or null when it is missing or its getter throws. */
export function getDefaultBacking(): StorageLike | null {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    return ls ?? null;
  } catch {
    return null;
  }
}

function probe(s: StorageLike): boolean {
  try {
    s.setItem(PROBE_KEY, '1');
    const ok = s.getItem(PROBE_KEY) === '1';
    s.removeItem(PROBE_KEY);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Storage over `backing` (default: localStorage) with a memory fallback. When the probe write fails the store is
 * memory-only (`persistent` false). Individual failed writes (quota) keep the value in memory so reads in the same
 * session still see it.
 */
export function createSafeStorage(backing: StorageLike | null = getDefaultBacking()): KeyValueStorage {
  const usable = backing !== null && probe(backing);
  if (!usable) return createMemoryStorage();
  const b = backing;
  /** Values whose persistent write failed; they shadow the backing store for this session. */
  const shadow = new Map<string, string>();
  return {
    persistent: true,
    get(k) {
      if (shadow.has(k)) return shadow.get(k)!;
      try {
        return b.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        b.setItem(k, v);
        shadow.delete(k);
        return true;
      } catch {
        shadow.set(k, v);
        return false;
      }
    },
    remove(k) {
      shadow.delete(k);
      try {
        b.removeItem(k);
      } catch {
        /* ignore */
      }
    },
    keys(prefix = '') {
      const out = new Set<string>();
      try {
        for (let i = 0; i < b.length; i++) {
          const k = b.key(i);
          if (k !== null && k.startsWith(prefix) && k !== PROBE_KEY) out.add(k);
        }
      } catch {
        /* ignore */
      }
      for (const k of shadow.keys()) if (k.startsWith(prefix)) out.add(k);
      return [...out];
    },
  };
}
