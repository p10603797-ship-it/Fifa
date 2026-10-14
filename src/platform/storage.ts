/**
 * [PLT-03] Safe storage: a synchronous key-value store over `localStorage` and an async blob store over IndexedDB.
 *
 * BRIEF §3: "Keep settings and progress in localStorage or IndexedDB with a schema version and migrations. Fall
 * back to memory if storage is blocked." Nothing here ever throws to the caller: Safari private mode, a full quota,
 * disabled site data, a `localStorage` getter that throws (SecurityError) or an IndexedDB that never opens all
 * degrade to an in-memory copy for the rest of the session.
 *
 * KeyValueStorage (createSafeStorage, sync; settings, records, cup saves):
 *  - Backing unreadable (missing, getter or getItem throws) -> pure memory store, `persistent` false.
 *  - Backing readable but the probe write fails (quota full, old Safari private mode) -> read-only mode: stored
 *    values are still read, writes are attempted and kept in memory when they fail; `persistent` turns true after
 *    the first write that succeeds.
 *  - A failed write keeps the value in a memory shadow so reads in the same session see it; a failed remove leaves a
 *    tombstone so the stale backing value is not read back.
 *
 * BlobStore (createBlobStore, async; large progress such as replays, which can be megabytes):
 *  - IndexedDB database BLOB_DB_NAME, one object store of string values keyed by string. Opened lazily on the first
 *    call; an open that errors, throws or hangs (LOCAL_TUNING.idbOpenTimeoutMs) switches to memory for the session.
 *  - Operations run strictly in call order (one queue). A failed transaction (quota, connection lost after
 *    backgrounding on iPadOS, or one that hangs past LOCAL_TUNING.idbTxTimeoutMs) is retried once on a fresh
 *    connection (not for quota); if it still fails the value is kept in memory and the call resolves false.
 */

const LOCAL_TUNING = { // TUNING-CR (platform timing, not gameplay)
  /** An IndexedDB open that has neither succeeded nor failed after this long falls back to memory, ms. */
  idbOpenTimeoutMs: 4000,
  /** A transaction that has neither completed nor aborted after this long is abandoned (WebKit hangs), ms. */
  idbTxTimeoutMs: 10000,
} as const;

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

/** Storage operations reported to `onError`. */
export type StorageOp = 'get' | 'set' | 'remove' | 'keys' | 'open';

/** Error sink for diagnostics. Exceptions thrown by it are swallowed. */
export type StorageErrorFn = (op: StorageOp, key: string, err: unknown) => void;

export interface SafeStorageOptions {
  onError?: StorageErrorFn;
}

export const PROBE_KEY = '__dotkick_probe__';

/** True for a quota error from localStorage or IndexedDB (names differ between engines). Pure. */
export function isQuotaError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014;
}

function safeReport(fn: StorageErrorFn | undefined, op: StorageOp, key: string, err: unknown): void {
  if (!fn) return;
  try {
    fn(op, key, err);
  } catch {
    /* a broken logger must not break storage */
  }
}

/** Pure in-memory storage (tests, blocked storage). `set` returns false: nothing survives a reload. */
export function createMemoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    persistent: false,
    get: (k) => (map.has(k) ? map.get(k)! : null),
    set: (k, v) => { map.set(k, String(v)); return false; },
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

/** True when the backing can be read at all (Safari with site data blocked throws on every access). */
function canRead(s: StorageLike): boolean {
  try {
    s.getItem(PROBE_KEY);
    void s.length;
    return true;
  } catch {
    return false;
  }
}

/** True when a write round-trips. Leaves no probe key behind. */
function probeWrite(s: StorageLike): boolean {
  let ok: boolean;
  try {
    s.setItem(PROBE_KEY, '1');
    ok = s.getItem(PROBE_KEY) === '1';
  } catch {
    ok = false;
  }
  try {
    s.removeItem(PROBE_KEY);
  } catch {
    /* ignore */
  }
  return ok;
}

/**
 * Storage over `backing` (default: localStorage) with a memory fallback. See the file header for the modes.
 * `persistent` is a live value: false while writes cannot reach the backing (blocked, or the probe hit a full quota).
 */
export function createSafeStorage(
  backing: StorageLike | null = getDefaultBacking(),
  opts: SafeStorageOptions = {},
): KeyValueStorage {
  if (backing === null || !canRead(backing)) return createMemoryStorage();
  const b = backing;
  const onError = opts.onError;
  let writable = probeWrite(b);
  /** Values whose persistent write failed; they shadow the backing store for this session. */
  const shadow = new Map<string, string>();
  /** Keys whose backing remove failed: read as missing for this session. */
  const removed = new Set<string>();
  return {
    get persistent() {
      return writable;
    },
    get(k) {
      if (shadow.has(k)) return shadow.get(k)!;
      if (removed.has(k)) return null;
      try {
        return b.getItem(k);
      } catch (err) {
        safeReport(onError, 'get', k, err);
        return null;
      }
    },
    set(k, v) {
      const value = String(v);
      removed.delete(k);
      try {
        b.setItem(k, value);
        shadow.delete(k);
        writable = true;
        return true;
      } catch (err) {
        shadow.set(k, value);
        safeReport(onError, 'set', k, err);
        return false;
      }
    },
    remove(k) {
      shadow.delete(k);
      try {
        b.removeItem(k);
        removed.delete(k);
      } catch (err) {
        removed.add(k);
        safeReport(onError, 'remove', k, err);
      }
    },
    keys(prefix = '') {
      const out = new Set<string>();
      try {
        const n = b.length;
        for (let i = 0; i < n; i++) {
          const k = b.key(i);
          if (k !== null && k.startsWith(prefix) && k !== PROBE_KEY && !removed.has(k)) out.add(k);
        }
      } catch (err) {
        safeReport(onError, 'keys', prefix, err);
      }
      for (const k of shadow.keys()) if (k.startsWith(prefix)) out.add(k);
      return [...out];
    },
  };
}

// ============================================================ async blob store (IndexedDB)

/** IndexedDB database and object store used by createBlobStore. */
export const BLOB_DB_NAME = 'dotkick';
export const BLOB_DB_VERSION = 1;
export const BLOB_STORE_NAME = 'blobs';

/** Where blob values live: 'unopened' until the first call, then 'indexeddb' or 'memory'. */
export type BlobBackend = 'unopened' | 'indexeddb' | 'memory';

export interface BlobStore {
  readonly backend: BlobBackend;
  /** True while values are written to IndexedDB (false before the first call and once it fell back to memory). */
  readonly persistent: boolean;
  /** Open the database if needed; resolves with `persistent`. */
  ready(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** Resolves false when the value is kept in memory only (no IndexedDB, quota, failed transaction). Never rejects. */
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<void>;
  /** Remove every key starting with `prefix` in one operation; resolves with the number of keys removed. */
  removePrefix(prefix: string): Promise<number>;
  /** Keys starting with `prefix`, sorted. */
  keys(prefix?: string): Promise<string[]>;
  /** Close the connection (dispose, tests). A later call reopens it. */
  close(): void;
}

export interface BlobStoreOptions {
  /** IndexedDB factory. Default `globalThis.indexedDB`; null forces memory only. */
  idb?: IDBFactory | null;
  dbName?: string;
  storeName?: string;
  /** Default LOCAL_TUNING.idbOpenTimeoutMs. */
  openTimeoutMs?: number;
  /** Default LOCAL_TUNING.idbTxTimeoutMs. */
  txTimeoutMs?: number;
  onError?: StorageErrorFn;
}

/** Returns `globalThis.indexedDB` or null when it is missing or its getter throws. */
export function getDefaultIdb(): IDBFactory | null {
  try {
    const f = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    return f ?? null;
  } catch {
    return null;
  }
}

/** One transaction: `body` issues requests and returns a getter for the result, read at completion. */
type TxBody<T> = (store: IDBObjectStore) => () => T;

const NO_RESULT = { ok: false } as const;
type TxResult<T> = { ok: true; value: T } | typeof NO_RESULT;

/** Async string store over IndexedDB with a memory fallback. See the file header. */
export function createBlobStore(opts: BlobStoreOptions = {}): BlobStore {
  const factory = opts.idb === undefined ? getDefaultIdb() : opts.idb;
  const dbName = opts.dbName ?? BLOB_DB_NAME;
  const storeName = opts.storeName ?? BLOB_STORE_NAME;
  const timeoutMs = opts.openTimeoutMs ?? LOCAL_TUNING.idbOpenTimeoutMs;
  const txTimeoutMs = opts.txTimeoutMs ?? LOCAL_TUNING.idbTxTimeoutMs;
  const onError = opts.onError;
  let backend: BlobBackend = factory ? 'unopened' : 'memory';
  let db: IDBDatabase | null = null;
  let opening: Promise<IDBDatabase | null> | null = null;
  /** Values not (yet) in IndexedDB: memory mode, or a failed write. */
  const shadow = new Map<string, string>();
  /** Keys whose IndexedDB delete failed: read as missing. */
  const removed = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = queue.then(fn, fn);
    queue = p.then(() => undefined, () => undefined);
    return p;
  }

  function dropConnection(): void {
    const d = db;
    db = null;
    opening = null;
    if (d) {
      try {
        d.close();
      } catch {
        /* ignore */
      }
    }
  }

  function open(): Promise<IDBDatabase | null> {
    if (!factory || backend === 'memory') return Promise.resolve(null);
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise<IDBDatabase | null>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (d: IDBDatabase | null, err?: unknown): void => {
        if (settled) {
          // A late success after the timeout: the session already runs from memory.
          if (d) {
            try {
              d.close();
            } catch {
              /* ignore */
            }
          }
          return;
        }
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (d) {
          db = d;
          backend = 'indexeddb';
          // Another tab upgrading the schema, or the browser closing the connection (iPadOS after backgrounding):
          // forget it so the next call reopens.
          d.onversionchange = () => {
            if (db === d) dropConnection();
            else d.close();
          };
          (d as { onclose: ((this: IDBDatabase, ev: Event) => unknown) | null }).onclose = () => {
            if (db === d) {
              db = null;
              opening = null;
            }
          };
        } else {
          backend = 'memory';
          safeReport(onError, 'open', dbName, err ?? new Error('IndexedDB unavailable'));
        }
        resolve(d);
      };
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(dbName, BLOB_DB_VERSION);
      } catch (err) {
        finish(null, err);
        return;
      }
      req.onupgradeneeded = () => {
        try {
          const d = req.result;
          if (!d.objectStoreNames.contains(storeName)) d.createObjectStore(storeName);
        } catch (err) {
          safeReport(onError, 'open', dbName, err);
        }
      };
      req.onsuccess = () => {
        let d: IDBDatabase;
        try {
          d = req.result;
          if (!d.objectStoreNames.contains(storeName)) {
            d.close();
            finish(null, new Error(`IndexedDB store "${storeName}" missing`));
            return;
          }
        } catch (err) {
          finish(null, err);
          return;
        }
        finish(d);
      };
      req.onerror = () => {
        let err: unknown;
        try {
          err = req.error;
        } catch (e) {
          err = e;
        }
        finish(null, err);
      };
      // onblocked: an older connection elsewhere has not closed yet; wait for success or the timeout.
      timer = setTimeout(() => finish(null, new Error(`IndexedDB open timed out after ${timeoutMs} ms`)), timeoutMs);
    });
    return opening;
  }

  function transact<T>(d: IDBDatabase, mode: IDBTransactionMode, body: TxBody<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      let result: () => T;
      try {
        tx = d.transaction(storeName, mode);
        result = body(tx.objectStore(storeName));
      } catch (err) {
        reject(err);
        return;
      }
      // A transaction that never settles would block the queue for the rest of the session.
      const timer = setTimeout(() => {
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        reject(new Error(`IndexedDB transaction timed out after ${txTimeoutMs} ms`));
      }, txTimeoutMs);
      tx.oncomplete = () => {
        clearTimeout(timer);
        try {
          resolve(result());
        } catch (err) {
          reject(err);
        }
      };
      const fail = (ev?: Event): void => {
        clearTimeout(timer);
        let err: unknown;
        try {
          // tx.error is set at abort; a request error event reaches tx.onerror first, with the request as target.
          const target = ev ? (ev.target as { error?: unknown } | null) : null;
          err = tx.error ?? (target && target !== (tx as unknown) ? target.error : null);
        } catch (e) {
          err = e;
        }
        reject(err ?? new Error('IndexedDB transaction aborted'));
      };
      tx.onabort = fail;
      tx.onerror = fail;
    });
  }

  /** Run one transaction, reopening the connection once when it fails for a reason other than quota. */
  async function run<T>(mode: IDBTransactionMode, body: TxBody<T>, op: StorageOp, key: string): Promise<TxResult<T>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const d = await open();
      if (!d) return NO_RESULT;
      try {
        const value = await transact(d, mode, body);
        return { ok: true, value };
      } catch (err) {
        safeReport(onError, op, key, err);
        if (isQuotaError(err)) return NO_RESULT;
        dropConnection();
      }
    }
    return NO_RESULT;
  }

  return {
    get backend() {
      return backend;
    },
    get persistent() {
      return backend === 'indexeddb';
    },
    ready() {
      return enqueue(async () => {
        await open();
        return backend === 'indexeddb';
      });
    },
    get(key) {
      return enqueue(async () => {
        if (shadow.has(key)) return shadow.get(key)!;
        if (removed.has(key)) return null;
        const r = await run<unknown>('readonly', (st) => {
          const req = st.get(key);
          return () => req.result;
        }, 'get', key);
        return r.ok && typeof r.value === 'string' ? r.value : null;
      });
    },
    set(key, value) {
      const text = String(value);
      return enqueue(async () => {
        removed.delete(key);
        const r = await run<void>('readwrite', (st) => {
          st.put(text, key);
          return () => undefined;
        }, 'set', key);
        if (r.ok) {
          shadow.delete(key);
          return true;
        }
        shadow.set(key, text);
        return false;
      });
    },
    remove(key) {
      return enqueue(async () => {
        shadow.delete(key);
        if (backend === 'memory') return;
        const r = await run<void>('readwrite', (st) => {
          st.delete(key);
          return () => undefined;
        }, 'remove', key);
        // A failed delete leaves a tombstone so the stale IndexedDB value is not read back this session.
        if (r.ok) removed.delete(key);
        else removed.add(key);
      });
    },
    removePrefix(prefix) {
      return enqueue(async () => {
        let n = 0;
        for (const k of [...shadow.keys()]) {
          if (k.startsWith(prefix)) {
            shadow.delete(k);
            n++;
          }
        }
        if (backend === 'memory') return n;
        const r = await run<string[]>('readwrite', (st) => {
          const gone: string[] = [];
          const req = st.getAllKeys();
          req.onsuccess = () => {
            for (const k of req.result) {
              if (typeof k === 'string' && k.startsWith(prefix)) {
                st.delete(k);
                gone.push(k);
              }
            }
          };
          return () => gone;
        }, 'remove', prefix);
        if (r.ok) {
          for (const k of r.value) {
            if (!removed.has(k)) n++;
            removed.delete(k);
          }
        }
        return n;
      });
    },
    keys(prefix = '') {
      return enqueue(async () => {
        const out = new Set<string>();
        if (backend !== 'memory') {
          const r = await run<IDBValidKey[]>('readonly', (st) => {
            const req = st.getAllKeys();
            return () => req.result;
          }, 'keys', prefix);
          if (r.ok) for (const k of r.value) if (typeof k === 'string' && k.startsWith(prefix) && !removed.has(k)) out.add(k);
        }
        for (const k of shadow.keys()) if (k.startsWith(prefix)) out.add(k);
        return [...out].sort();
      });
    },
    close() {
      dropConnection();
    },
  };
}
