/**
 * [PLT-03] Test fakes: a DOM Storage (localStorage) with blocked / quota modes, a minimal IndexedDB factory with
 * failure injection, and a manual clock for the debounced settings writes. Node only (no jsdom).
 */
import type { StoreTimers } from '../../src/platform/settingsStore';
import type { StorageLike } from '../../src/platform/storage';

function domError(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

// ============================================================ localStorage

export interface FakeStorageOptions {
  /** Every access throws SecurityError (Safari with site data blocked). */
  blocked?: boolean;
  /** Most characters (keys + values) the store may hold; a write past it throws QuotaExceededError. */
  quotaChars?: number;
  initial?: Record<string, string>;
}

export interface FakeStorage extends StorageLike {
  readonly map: Map<string, string>;
  /** Keys written successfully, in order. */
  readonly writes: string[];
  /** While true every setItem throws QuotaExceededError. */
  failWrites: boolean;
  /** While true every removeItem throws. */
  failRemoves: boolean;
  /** Change the quota at runtime. */
  quotaChars: number;
}

export function createFakeStorage(opts: FakeStorageOptions = {}): FakeStorage {
  const map = new Map<string, string>(Object.entries(opts.initial ?? {}));
  const writes: string[] = [];
  const used = (): number => {
    let n = 0;
    for (const [k, v] of map) n += k.length + v.length;
    return n;
  };
  const guard = (): void => {
    if (opts.blocked) throw domError('SecurityError');
  };
  const fake: FakeStorage = {
    map,
    writes,
    failWrites: false,
    failRemoves: false,
    quotaChars: opts.quotaChars ?? Infinity,
    getItem(k) {
      guard();
      return map.has(k) ? map.get(k)! : null;
    },
    setItem(k, v) {
      guard();
      if (fake.failWrites) throw domError('QuotaExceededError');
      const prev = map.get(k);
      const next = used() - (prev === undefined ? 0 : k.length + prev.length) + k.length + String(v).length;
      if (next > fake.quotaChars) throw domError('QuotaExceededError');
      map.set(k, String(v));
      writes.push(k);
    },
    removeItem(k) {
      guard();
      if (fake.failRemoves) throw domError('SecurityError');
      map.delete(k);
    },
    key(i) {
      guard();
      return [...map.keys()][i] ?? null;
    },
    get length() {
      guard();
      return map.size;
    },
  };
  return fake;
}

// ============================================================ manual clock

export interface ManualTimers extends StoreTimers {
  t: number;
  /** Advance the clock, firing due timers in order. */
  advance(ms: number): void;
  readonly pendingTimers: number;
}

export function createManualTimers(): ManualTimers {
  let nextId = 1;
  const queue: { id: number; at: number; fn: () => void }[] = [];
  const timers: ManualTimers = {
    t: 0,
    now: () => timers.t,
    setTimeout(fn, ms) {
      const id = nextId++;
      queue.push({ id, at: timers.t + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(h) {
      const i = queue.findIndex((q) => q.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    advance(ms) {
      const end = timers.t + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const q = queue[0];
        if (!q || q.at > end) break;
        queue.shift();
        timers.t = q.at;
        q.fn();
      }
      timers.t = end;
    },
    get pendingTimers() {
      return queue.length;
    },
  };
  return timers;
}

// ============================================================ IndexedDB

export interface FakeIdbOptions {
  /** open() fires onerror. */
  failOpen?: boolean;
  /** open() throws synchronously (SecurityError). */
  throwOnOpen?: boolean;
  /** open() never settles (WebKit bug): the store's timeout must fire. */
  hangOpen?: boolean;
  /** Most characters (keys + string values) a database may hold; a commit past it aborts with QuotaExceededError. */
  quotaChars?: number;
}

type Handler = ((ev: Event) => void) | null;

interface FakeRequest {
  result: unknown;
  error: Error | null;
  onsuccess: Handler;
  onerror: Handler;
}

interface FakeDb {
  name: string;
  closed: boolean;
  onversionchange: Handler;
  onclose: Handler;
  objectStoreNames: { contains(n: string): boolean };
  createObjectStore(n: string): unknown;
  transaction(store: string, mode: string): unknown;
  close(): void;
}

export interface FakeIdb {
  readonly factory: IDBFactory;
  /** Committed data per "db/store". Survives connections (the disk). */
  readonly stores: Map<string, Map<string, unknown>>;
  readonly opens: number;
  /** The next N transactions abort with UnknownError (connection lost after backgrounding). */
  failNextTx: number;
  /** The next N transactions never complete nor abort (WebKit hang). */
  hangNextTx: number;
  /** Transactions abandoned with abort(). */
  readonly aborted: number;
  quotaChars: number;
  /** The browser closes every open connection (fires onclose). */
  closeAll(): void;
  /** Committed data of the default store. */
  data(dbName?: string, store?: string): Map<string, unknown>;
}

const EV = {} as Event;
const later = (fn: () => void): void => {
  setTimeout(fn, 0);
};

export function createFakeIdb(opts: FakeIdbOptions = {}): FakeIdb {
  const stores = new Map<string, Map<string, unknown>>();
  const schemas = new Map<string, Set<string>>();
  const live: FakeDb[] = [];
  let opens = 0;
  let aborted = 0;

  function used(dbName: string, override: Map<string, Map<string, unknown>>): number {
    let n = 0;
    for (const [id, m] of stores) {
      if (!id.startsWith(dbName + '/')) continue;
      const src = override.get(id) ?? m;
      for (const [k, v] of src) n += k.length + (typeof v === 'string' ? v.length : 8);
    }
    return n;
  }

  function makeDb(name: string): FakeDb {
    const names = schemas.get(name) ?? new Set<string>();
    schemas.set(name, names);
    const db: FakeDb = {
      name,
      closed: false,
      onversionchange: null,
      onclose: null,
      objectStoreNames: { contains: (n) => names.has(n) },
      createObjectStore(n) {
        names.add(n);
        if (!stores.has(name + '/' + n)) stores.set(name + '/' + n, new Map());
        return {};
      },
      transaction(storeName, _mode) {
        if (db.closed) throw domError('InvalidStateError');
        if (!names.has(storeName)) throw domError('NotFoundError');
        const id = name + '/' + storeName;
        const staged = new Map(stores.get(id)!);
        const queue: { req: FakeRequest; run: () => unknown }[] = [];
        const failing = fake.failNextTx > 0;
        if (failing) fake.failNextTx--;
        const hanging = !failing && fake.hangNextTx > 0;
        if (hanging) fake.hangNextTx--;
        const tx = {
          error: null as Error | null,
          oncomplete: null as Handler,
          onabort: null as Handler,
          onerror: null as Handler,
          abort() {
            aborted++;
          },
          objectStore(_n: string) {
            const add = (run: () => unknown): FakeRequest => {
              const req: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
              queue.push({ req, run });
              return req;
            };
            return {
              get: (k: string) => add(() => staged.get(k)),
              put: (v: unknown, k: string) => add(() => {
                staged.set(k, v);
                return k;
              }),
              delete: (k: string) => add(() => {
                staged.delete(k);
                return undefined;
              }),
              getAllKeys: () => add(() => [...staged.keys()].sort()),
            };
          },
        };
        const abort = (err: Error): void => {
          tx.error = err;
          tx.onerror?.(EV);
          tx.onabort?.(EV);
        };
        if (hanging) return tx;
        later(() => {
          if (failing) {
            abort(domError('UnknownError'));
            return;
          }
          while (queue.length > 0) {
            const { req, run } = queue.shift()!;
            req.result = run();
            req.onsuccess?.(EV);
          }
          const over = new Map([[id, staged]]);
          if (used(name, over) > fake.quotaChars) {
            abort(domError('QuotaExceededError'));
            return;
          }
          stores.set(id, staged);
          tx.oncomplete?.(EV);
        });
        return tx;
      },
      close() {
        db.closed = true;
      },
    };
    return db;
  }

  const factory = {
    open(name: string, _version?: number) {
      if (opts.throwOnOpen) throw domError('SecurityError');
      opens++;
      const req = {
        result: null as unknown,
        error: null as Error | null,
        onsuccess: null as Handler,
        onerror: null as Handler,
        onupgradeneeded: null as Handler,
        onblocked: null as Handler,
      };
      if (opts.hangOpen) return req;
      later(() => {
        if (opts.failOpen) {
          req.error = domError('UnknownError');
          req.onerror?.(EV);
          return;
        }
        const fresh = !schemas.has(name);
        const db = makeDb(name);
        req.result = db;
        if (fresh) req.onupgradeneeded?.(EV);
        live.push(db);
        req.onsuccess?.(EV);
      });
      return req;
    },
  };

  const fake: FakeIdb = {
    factory: factory as unknown as IDBFactory,
    stores,
    get opens() {
      return opens;
    },
    failNextTx: 0,
    hangNextTx: 0,
    get aborted() {
      return aborted;
    },
    quotaChars: opts.quotaChars ?? Infinity,
    closeAll() {
      for (const db of live.splice(0)) {
        if (db.closed) continue;
        db.closed = true;
        db.onclose?.(EV);
      }
    },
    data(dbName = 'dotkick', store = 'blobs') {
      return stores.get(dbName + '/' + store) ?? new Map();
    },
  };
  return fake;
}

/** Let queued fake-IDB callbacks (setTimeout 0) and promise chains run. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
