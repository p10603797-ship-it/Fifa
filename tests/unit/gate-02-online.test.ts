/**
 * [GATE] Online password checker (D-048): the Worker (server/gate-worker/worker.js) with its GateStore Durable Object
 * over an in-memory SQLite stand-in for ctx.storage.sql, the game's client (src/app/gateOnline.ts) against a mocked
 * fetch and against the Worker itself, gateBoot choosing the online checker, and the Cloudflare tooling
 * (tools/lib/cloudflare.mjs) refusing anything that is not DotKick's. Test codes only: real codes are never in the
 * repository; the worker's codes.js is replaced by the two test hashes below.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, {
  DEVICE_RE, GateStore, MAX_BODY_BYTES, VALID_HASHES, handle, hashCode as workerHash, normaliseCode as workerNormalise, parseRedeemBody, redeem,
  type GateEnv,
} from '../../server/gate-worker/worker.js';
import {
  GATE_DEVICE_KEY, GATE_HASH_PREFIX, GATE_UNLOCK_KEY, GATE_USED_KEY, createGate, hashCode, normaliseCode, parseUsedList,
  unlockRecordJson,
} from '../../src/app/gate';
import { chooseRedeemer, startBehindGate } from '../../src/app/gateBoot';
import { createOnlineRedeemer, deviceId, parseCheckerAnswer } from '../../src/app/gateOnline';
import { GATE_SERVER_TIMEOUT_MS, GATE_SERVER_URL } from '../../src/data/gateConfig';
import { createMemoryStorage, type KeyValueStorage } from '../../src/platform/storage';

// The worker's accepted hashes: the two test codes below (TSTA-2345-6789, TSTB-ABCD-EFGH).
vi.mock('../../server/gate-worker/codes.js', () => ({
  default: [
    '21df140d0c3f30718d6bc4a717c3f0b9fb26c4efc21d248ab90e94d95ec54808',
    '063046bf77795914556e4ee5d813889ab7e91a453a70c0e3ad29c2c5fbf5cdca',
  ],
}));

/** tools/lib/cloudflare.mjs (plain ESM). */
type Cfg = { account: string; token: string };
interface CloudflareLib {
  GATE_ENVS: Record<'prod' | 'test', { script: string }>;
  COMPATIBILITY_DATE: string;
  STORE_MIGRATION_TAG: string;
  assertGateName(name: string): string;
  gateEnv(name: string): { script: string };
  cloudflareConfig(args: string[], env: Record<string, string | undefined>): Cfg;
  cfApi(cfg: Cfg, method: string, path: string, body?: unknown, fetchFn?: typeof fetch): Promise<unknown>;
  uploadWorker(cfg: Cfg, script: string, source: string, codes: string, currentTag: string, fetchFn?: typeof fetch): Promise<unknown>;
  enableWorkersDev(cfg: Cfg, script: string, fetchFn?: typeof fetch): Promise<unknown>;
  migrationTag(cfg: Cfg, script: string, fetchFn?: typeof fetch): Promise<string>;
  codesModule(hashes: string[]): string;
  hashesInCodesModule(text: string): string[];
}
const cf = (await import(/* @vite-ignore */ new URL('../../tools/lib/cloudflare.mjs', import.meta.url).href)) as CloudflareLib;

const nodeHash = (code: string): string => createHash('sha256').update(GATE_HASH_PREFIX + normaliseCode(code), 'utf8').digest('hex');

const CODE_A = 'TSTA-2345-6789';
const CODE_B = 'TSTB-ABCD-EFGH';
const DEV_1 = 'a'.repeat(32);
const DEV_2 = 'b'.repeat(32);

/** ctx.storage.sql stand-in over node:sqlite: exec(query, ...bindings) -> { toArray() }, synchronous like the real one. */
function fakeSql() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(query: string, ...bindings: (string | number | null)[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? (st.all(...bindings) as Record<string, unknown>[]) : (st.run(...bindings), []);
      return { toArray: () => rows };
    },
  };
}

/** A GateEnv whose GATE namespace routes to one GateStore over fakeSql (as the Durable Object would). */
function fakeEnv(): GateEnv & { store: GateStore; sql: ReturnType<typeof fakeSql>; rows(): { hash: string; device: string; used_at: number }[] } {
  const sql = fakeSql();
  const store = new GateStore({ storage: { sql } });
  const stub = { fetch: (url: string, init?: RequestInit) => store.fetch(new Request(url, init)) };
  return {
    GATE: { idFromName: (n: string) => n, get: () => stub },
    store,
    sql,
    rows: () => sql.db.prepare('SELECT hash, device, used_at FROM used ORDER BY hash').all() as never,
  };
}

const post = (body: string, init: RequestInit = {}): Request =>
  new Request('https://gate.example/redeem', { method: 'POST', body, headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, ...init });

async function answer(res: Response): Promise<{ status: number; body: unknown; cors: string | null }> {
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, cors: res.headers.get('Access-Control-Allow-Origin') };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('GATE checker worker: hashing and body checks', () => {
  it('the mocked codes.js holds exactly the two test codes', () => {
    expect([...VALID_HASHES].sort()).toEqual([nodeHash(CODE_A), nodeHash(CODE_B)].sort());
  });

  it('normalises and hashes exactly like the game', async () => {
    for (const c of [CODE_A, 'tstb abcd efgh', ' t-s-t-c jkmn pqrs ', 'é漢字ABCD']) {
      expect(workerNormalise(c)).toBe(normaliseCode(c));
      expect(await workerHash(c)).toBe(nodeHash(c));
      expect(await workerHash(c)).toBe(await hashCode(c));
    }
  });

  it('accepts { code, device } only: JSON object, string code of 1..100 characters, device id of 128+ bits', () => {
    expect(parseRedeemBody(JSON.stringify({ code: CODE_A, device: DEV_1 }))).toEqual({ code: CODE_A, device: DEV_1 });
    expect(parseRedeemBody(JSON.stringify({ code: 'x', device: 'AbC_-'.repeat(5) }))).toEqual({ code: 'x', device: 'AbC_-'.repeat(5) });
    for (const [body, why] of [
      ['{bad', 'bad json'], ['', 'bad json'], ['[]', 'bad body'], ['null', 'bad body'], ['"x"', 'bad body'],
      [JSON.stringify({ device: DEV_1 }), 'bad code'], [JSON.stringify({ code: 5, device: DEV_1 }), 'bad code'],
      [JSON.stringify({ code: '', device: DEV_1 }), 'bad code'], [JSON.stringify({ code: 'x'.repeat(101), device: DEV_1 }), 'bad code'],
      [JSON.stringify({ code: CODE_A }), 'bad device'], [JSON.stringify({ code: CODE_A, device: 'short' }), 'bad device'],
      [JSON.stringify({ code: CODE_A, device: 'a'.repeat(21) }), 'bad device'], [JSON.stringify({ code: CODE_A, device: `${DEV_1}!` }), 'bad device'],
      [JSON.stringify({ code: CODE_A, device: 'a'.repeat(129) }), 'bad device'],
    ] as const) expect(parseRedeemBody(body), body).toBe(why);
    expect(DEVICE_RE.test(DEV_1)).toBe(true);
  });
});

describe('GATE checker worker: redeem through the GateStore Durable Object', () => {
  it('ok once; the same device again is ok (lost answer); another device is told used; unknown codes are wrong', async () => {
    const env = fakeEnv();
    expect(await redeem(env, 'nope-nope-nope', DEV_1, 1)).toBe('wrong');
    expect(await redeem(env, 'ab', DEV_1, 1)).toBe('wrong');
    expect(env.rows()).toEqual([]); // wrong codes never reach the store
    expect(await redeem(env, 'tsta 2345 6789', DEV_1, 1000)).toBe('ok');
    expect(await redeem(env, CODE_A, DEV_1, 2000)).toBe('ok');
    expect(await redeem(env, CODE_A, DEV_2, 3000)).toBe('used');
    expect(await redeem(env, CODE_A, DEV_1, 4000)).toBe('ok');
    expect(await redeem(env, CODE_B, DEV_2, 5000)).toBe('ok');
    const rows = env.rows();
    expect(rows.find((r) => r.hash === nodeHash(CODE_A))).toEqual({ hash: nodeHash(CODE_A), used_at: 1000, device: DEV_1 });
    expect(rows.find((r) => r.hash === nodeHash(CODE_B))).toEqual({ hash: nodeHash(CODE_B), used_at: 5000, device: DEV_2 });
    expect(JSON.stringify(rows)).not.toMatch(/TST[AB]/); // only hashes are stored
    expect(env.store.usedCount()).toBe(2);
  });

  it('20 devices redeem one code at the same time: exactly one is ok', async () => {
    const env = fakeEnv();
    const devices = Array.from({ length: 20 }, (_, i) => i.toString(16).padStart(32, 'c'));
    const results = await Promise.all(devices.map((d) => redeem(env, CODE_A, d)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'used')).toHaveLength(19);
    expect(env.rows()[0]!.device).toBe(devices[results.indexOf('ok')]);
  });

  it('a store that fails or answers nonsense is an error, never ok', async () => {
    const env = fakeEnv();
    const bad = (res: Response): GateEnv => ({ GATE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => res }) } });
    await expect(redeem(bad(new Response('x', { status: 500 })), CODE_A, DEV_1)).rejects.toThrow();
    await expect(redeem(bad(Response.json({ result: 'maybe' })), CODE_A, DEV_1)).rejects.toThrow();
    expect(env.rows()).toEqual([]);
  });
});

describe('GATE checker worker: HTTP', () => {
  it('POST /redeem answers 200 { result } with CORS for any origin; no cookies, no caching', async () => {
    const env = fakeEnv();
    const ok = await worker.fetch(post(JSON.stringify({ code: CODE_A, device: DEV_1 })), env);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(ok.headers.get('Content-Type')).toMatch(/^application\/json/);
    expect(ok.headers.get('Set-Cookie')).toBeNull();
    expect(await answer(ok)).toEqual({ status: 200, body: { result: 'ok' }, cors: '*' });
    expect(await answer(await worker.fetch(post(JSON.stringify({ code: CODE_A, device: DEV_2 })), env))).toEqual({ status: 200, body: { result: 'used' }, cors: '*' });
    expect(await answer(await worker.fetch(post(JSON.stringify({ code: 'WRNG-WRNG-WRNG', device: DEV_2 })), env))).toEqual({ status: 200, body: { result: 'wrong' }, cors: '*' });
    expect((await answer(await worker.fetch(post(JSON.stringify({ code: CODE_A, device: DEV_1 }), { headers: { 'Content-Type': 'application/json' } }), env))).body).toEqual({ result: 'ok' });
    expect(await answer(await worker.fetch(new Request('https://gate.example/stats'), env))).toEqual({ status: 200, body: { total: 2, used: 1 }, cors: '*' });
  });

  it('preflight, health, wrong method / path, bad and oversized bodies get proper status codes', async () => {
    const env = fakeEnv();
    const pre = await worker.fetch(new Request('https://gate.example/redeem', {
      method: 'OPTIONS', headers: { Origin: 'https://p10603797-ship-it.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    }), env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(pre.headers.get('Access-Control-Allow-Methods')).toMatch(/POST/);
    expect(pre.headers.get('Access-Control-Allow-Headers')).toMatch(/Content-Type/i);
    expect(pre.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    expect(await answer(await worker.fetch(new Request('https://gate.example/'), env))).toEqual({ status: 200, body: { ok: true }, cors: '*' });
    expect((await worker.fetch(new Request('https://gate.example/redeem'), env)).status).toBe(405);
    expect((await worker.fetch(new Request('https://gate.example/stats', { method: 'POST', body: '{}' }), env)).status).toBe(405);
    expect((await worker.fetch(new Request('https://gate.example/', { method: 'POST', body: '{}' }), env)).status).toBe(405);
    expect((await worker.fetch(new Request('https://gate.example/other'), env)).status).toBe(404);
    expect((await worker.fetch(post('{bad'), env)).status).toBe(400);
    expect((await worker.fetch(post(JSON.stringify({ code: CODE_A, device: 'x' })), env)).status).toBe(400);
    expect((await worker.fetch(post(''), env)).status).toBe(400);
    const big = JSON.stringify({ code: CODE_A, device: DEV_1, pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await worker.fetch(post(big), env)).status).toBe(413);
    expect((await worker.fetch(post(big, { headers: { 'Content-Length': String(big.length) } }), env)).status).toBe(413);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode('x'.repeat(200)));
        c.close();
      },
    });
    expect((await worker.fetch(new Request('https://gate.example/redeem', { method: 'POST', body: stream, duplex: 'half' } as RequestInit), env)).status).toBe(413);
    expect(env.rows()).toEqual([]);
  });

  it('a failing store answers 503 (the game shows its "connect and try again" message), never ok', async () => {
    const broken: GateEnv = { GATE: { idFromName: (n: string) => n, get: () => ({ fetch: async () => { throw new Error('down'); } }) } };
    const res = await handle(post(JSON.stringify({ code: CODE_A, device: DEV_1 })), broken);
    expect(res.status).toBe(503);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('logs nothing (no console call in the worker source)', () => {
    const src = readFileSync(new URL('../../server/gate-worker/worker.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/console\./);
  });
});

// ------------------------------------------------------------------------------------------------ client

interface Call { url: string; init: RequestInit; body: { code: string; device: string }; deviceStored: string | null }

/** A fetch that records calls (and what storage held at that moment) and answers with `reply`. */
function mockFetch(storage: KeyValueStorage, reply: (call: Call) => Promise<Response> | Response) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init, body: JSON.parse(String(init.body)), deviceStored: storage.get(GATE_DEVICE_KEY) };
    calls.push(call);
    return reply(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const jsonRes = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('GATE online client (src/app/gateOnline.ts)', () => {
  it('ok: one POST with the normalised code and a stored device id; the hash goes into the used list', async () => {
    const storage = createMemoryStorage();
    const m = mockFetch(storage, () => jsonRes(200, { result: 'ok' }));
    const r = createOnlineRedeemer({ url: 'https://gate.example/redeem', storage, fetch: m.fn });
    expect(await r.redeem('tsta 2345-6789')).toBe('ok');
    expect(m.calls).toHaveLength(1);
    const c = m.calls[0]!;
    expect(c.url).toBe('https://gate.example/redeem');
    expect(c.init.method).toBe('POST');
    expect(c.init.credentials).toBe('omit');
    expect(c.init.headers).toEqual({ 'Content-Type': 'text/plain;charset=UTF-8' }); // CORS simple request: no preflight
    expect(c.body.code).toBe('TSTA23456789');
    expect(c.body.device).toMatch(/^[0-9a-f]{32}$/);
    expect(DEVICE_RE.test(c.body.device)).toBe(true);
    expect(c.deviceStored).toBe(c.body.device); // stored BEFORE the request
    expect(parseUsedList(storage.get(GATE_USED_KEY))).toEqual([nodeHash(CODE_A)]);
    // This device then refuses it without asking.
    expect(await r.redeem(CODE_A)).toBe('used');
    expect(m.calls).toHaveLength(1);
  });

  it('used and wrong come from the checker and change nothing locally; an empty code is wrong without a request', async () => {
    for (const result of ['used', 'wrong'] as const) {
      const storage = createMemoryStorage();
      const m = mockFetch(storage, () => jsonRes(200, { result }));
      const r = createOnlineRedeemer({ url: 'https://gate.example/redeem', storage, fetch: m.fn });
      expect(await r.redeem(CODE_B)).toBe(result);
      expect(storage.get(GATE_USED_KEY)).toBeNull();
      expect(await r.redeem(' -- ')).toBe('wrong');
      expect(m.calls).toHaveLength(1);
    }
  });

  it('500, 503, 404, garbage JSON, an unknown answer, a network error and a timeout are offline-error', async () => {
    const replies: (() => Promise<Response> | Response)[] = [
      () => jsonRes(500, { error: 'internal' }), () => jsonRes(503, { result: 'ok' }), () => new Response('nope', { status: 404 }),
      () => new Response('{garbage', { status: 200 }), () => jsonRes(200, { result: 'maybe' }), () => jsonRes(200, ['ok']),
      () => jsonRes(200, null), () => Promise.reject(new TypeError('Failed to fetch')),
    ];
    for (const reply of replies) {
      const storage = createMemoryStorage();
      const m = mockFetch(storage, reply);
      const r = createOnlineRedeemer({ url: 'https://gate.example/redeem', storage, fetch: m.fn });
      expect(await r.redeem(CODE_A)).toBe('offline-error');
      expect(storage.get(GATE_USED_KEY)).toBeNull();
    }
    // Timeout: the request never answers; the attempt gives up after timeoutMs and aborts the request.
    const storage = createMemoryStorage();
    let signal: AbortSignal | undefined;
    const m = mockFetch(storage, (c) => {
      signal = c.init.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const r = createOnlineRedeemer({ url: 'https://gate.example/redeem', storage, fetch: m.fn, timeoutMs: 40 });
    const t0 = Date.now();
    expect(await r.redeem(CODE_A)).toBe('offline-error');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(signal?.aborted).toBe(true);
    expect(GATE_SERVER_TIMEOUT_MS).toBe(10_000);
  });

  it('a lost answer: trying again sends the same device id, and the checker opens the game again', async () => {
    const env = fakeEnv();
    const storage = createMemoryStorage();
    let lose = true;
    const m = mockFetch(storage, async (c) => {
      const res = await worker.fetch(new Request(c.url, c.init), env);
      if (lose) {
        lose = false;
        throw new TypeError('Load failed'); // the checker used the code, the answer never arrived
      }
      return res;
    });
    const gate = createGate({ storage, redeemer: createOnlineRedeemer({ url: 'https://gate.example/redeem', storage, fetch: m.fn }) });
    expect((await gate.unlock(CODE_A)).result).toBe('offline-error');
    expect(gate.isUnlocked()).toBe(false);
    expect((await gate.unlock(CODE_A)).result).toBe('ok');
    expect(gate.isUnlocked()).toBe(true);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[1]!.body.device).toBe(m.calls[0]!.body.device);
    // Another device (fresh storage) is told it has been used.
    const other = createMemoryStorage();
    const m2 = mockFetch(other, (c) => worker.fetch(new Request(c.url, c.init), env));
    expect(await createOnlineRedeemer({ url: 'https://gate.example/redeem', storage: other, fetch: m2.fn }).redeem(CODE_A)).toBe('used');
    expect(m2.calls[0]!.body.device).not.toBe(m.calls[0]!.body.device);
  });

  it('two quick submits run one after the other: the second is used locally, one request only', async () => {
    const env = fakeEnv();
    const storage = createMemoryStorage();
    const m = mockFetch(storage, (c) => worker.fetch(new Request(c.url, c.init), env));
    const r = createOnlineRedeemer({ url: 'https://gate.example/redeem', storage, fetch: m.fn });
    expect(await Promise.all([r.redeem(CODE_B), r.redeem(CODE_B)])).toEqual(['ok', 'used']);
    expect(m.calls).toHaveLength(1);
  });

  it('device id: 128 random bits as 32 hex digits, made once, kept; a malformed stored id is replaced', () => {
    const storage = createMemoryStorage();
    const id = deviceId(storage, () => new Uint8Array(16).fill(0xab));
    expect(id).toBe('ab'.repeat(16));
    expect(deviceId(storage, () => new Uint8Array(16))).toBe(id);
    storage.set(GATE_DEVICE_KEY, 'not-an-id');
    expect(deviceId(storage)).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceId(createMemoryStorage())).not.toBe(deviceId(createMemoryStorage()));
  });

  it('parseCheckerAnswer: only 200 with ok / used / wrong counts', () => {
    expect(parseCheckerAnswer(200, { result: 'ok' })).toBe('ok');
    expect(parseCheckerAnswer(200, { result: 'used' })).toBe('used');
    expect(parseCheckerAnswer(200, { result: 'wrong' })).toBe('wrong');
    expect(parseCheckerAnswer(201, { result: 'ok' })).toBe('offline-error');
    expect(parseCheckerAnswer(200, 'ok')).toBe('offline-error');
    expect(parseCheckerAnswer(200, { result: 'offline-error' })).toBe('offline-error');
  });

  it('no fetch at all (very old browser): offline-error, never ok', async () => {
    vi.stubGlobal('fetch', undefined);
    const storage = createMemoryStorage();
    expect(await createOnlineRedeemer({ url: 'https://gate.example/redeem', storage }).redeem(CODE_A)).toBe('offline-error');
  });
});

describe('GATE boot picks the online checker', () => {
  it('GATE_SERVER_URL is the production worker; the game uses it unless the e2e hook says otherwise', () => {
    expect(GATE_SERVER_URL).toBe('https://dotkick-gate.dotquiz-live.workers.dev/redeem');
    const storage = createMemoryStorage();
    expect(chooseRedeemer(storage)).toMatchObject({ kind: 'online', url: GATE_SERVER_URL });
    vi.stubGlobal('window', { __dotkickGateTest: { serverUrl: 'https://test.example/redeem' } });
    expect(chooseRedeemer(storage)).toMatchObject({ kind: 'online', url: 'https://test.example/redeem' });
    vi.stubGlobal('window', { __dotkickGateTest: { hashes: [nodeHash(CODE_A)] } });
    expect(chooseRedeemer(storage)).toMatchObject({ kind: 'local', url: null });
    vi.stubGlobal('window', { __dotkickGateTest: { hashes: [nodeHash(CODE_A)], serverUrl: 'https://test.example/redeem' } });
    expect(chooseRedeemer(storage)).toMatchObject({ kind: 'online', url: 'https://test.example/redeem' });
    vi.stubGlobal('window', {});
    expect(chooseRedeemer(storage, '')).toMatchObject({ kind: 'local' });
  });

  it('the online checker in startBehindGate: an unlocked device starts at once with no request', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const storage = createMemoryStorage();
    storage.set(GATE_UNLOCK_KEY, unlockRecordJson(5));
    const start = vi.fn();
    const handle = startBehindGate(start, { storage });
    expect(start).toHaveBeenCalledTimes(1);
    expect(handle.locked).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(storage.get(GATE_DEVICE_KEY)).toBeNull(); // nothing is even prepared for the checker
  });

  it('the redeemer startBehindGate uses on a locked device asks GATE_SERVER_URL', async () => {
    const storage = createMemoryStorage();
    const m = mockFetch(storage, () => jsonRes(200, { result: 'ok' }));
    vi.stubGlobal('fetch', m.fn);
    const chosen = chooseRedeemer(storage);
    expect(await chosen.redeemer.redeem(CODE_A)).toBe('ok');
    expect(m.calls.map((c) => c.url)).toEqual([GATE_SERVER_URL]);
  });
});

// ------------------------------------------------------------------------------------------------ tooling

describe('GATE Cloudflare tooling (tools/lib/cloudflare.mjs)', () => {
  const cfg = { account: '0'.repeat(32), token: 'proxy-injected' };

  it('names only DotKick checker resources; refuses everything else on the account', () => {
    expect(cf.gateEnv('prod')).toEqual({ script: 'dotkick-gate' });
    expect(cf.gateEnv('test')).toEqual({ script: 'dotkick-gate-test' });
    expect(cf.gateEnv('review-x1')).toEqual({ script: 'dotkick-gate-review-x1' });
    for (const bad of ['dotquiz', 'dotquiz-live', '', 'dotkick', 'dotkick-gate-prod', 'dotkick-gate-review-X']) expect(() => cf.assertGateName(bad), bad).toThrow(/refusing/);
    for (const bad of ['production', 'dotquiz', 'review-', 'review-A']) expect(() => cf.gateEnv(bad), bad).toThrow();
    expect(cf.COMPATIBILITY_DATE).toBe('2025-01-01');
  });

  it('account id and token from flags / environment, with plain messages when missing', () => {
    expect(cf.cloudflareConfig(['--account', cfg.account], { CLOUDFLARE_API_TOKEN: 't' })).toEqual({ account: cfg.account, token: 't' });
    expect(cf.cloudflareConfig([], { CLOUDFLARE_ACCOUNT_ID: cfg.account, CLOUDFLARE_API_TOKEN: 't' })).toEqual({ account: cfg.account, token: 't' });
    expect(() => cf.cloudflareConfig([], { CLOUDFLARE_API_TOKEN: 't' })).toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(() => cf.cloudflareConfig([], { CLOUDFLARE_ACCOUNT_ID: cfg.account })).toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  it('uploads worker.js + codes.js with the GateStore Durable Object, creating the class only on the first deploy', async () => {
    const seen: { url: string; method: string; auth: string | null; body: unknown }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: String(init.method), auth: new Headers(init.headers).get('Authorization'), body: init.body });
      return jsonRes(200, { success: true, result: {} });
    }) as unknown as typeof fetch;
    await cf.uploadWorker(cfg, 'dotkick-gate-test', 'export default {}', 'export default [];', '', fake);
    await cf.uploadWorker(cfg, 'dotkick-gate-test', 'export default {}', 'export default [];', cf.STORE_MIGRATION_TAG, fake);
    await cf.enableWorkersDev(cfg, 'dotkick-gate-test', fake);
    const base = `https://api.cloudflare.com/client/v4/accounts/${cfg.account}/workers/scripts/dotkick-gate-test`;
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([`PUT ${base}`, `PUT ${base}`, `POST ${base}/subdomain`]);
    expect(seen.every((s) => s.auth === 'Bearer proxy-injected')).toBe(true);
    const meta = async (i: number) => JSON.parse(await ((seen[i]!.body as FormData).get('metadata') as Blob).text());
    const binding = [{ type: 'durable_object_namespace', name: 'GATE', class_name: 'GateStore' }];
    expect(await meta(0)).toEqual({ main_module: 'worker.js', compatibility_date: '2025-01-01', bindings: binding, migrations: { new_tag: 'v1', new_sqlite_classes: ['GateStore'] } });
    expect(await meta(1)).toEqual({ main_module: 'worker.js', compatibility_date: '2025-01-01', bindings: binding });
    const form = seen[0]!.body as FormData;
    expect(await (form.get('worker.js') as Blob).text()).toBe('export default {}');
    expect(await (form.get('codes.js') as Blob).text()).toBe('export default [];');
    await expect(cf.uploadWorker(cfg, 'dotquiz', 'x', 'y', '', fake)).rejects.toThrow(/refusing/);
    await expect(cf.enableWorkersDev(cfg, 'dotquiz-live', fake)).rejects.toThrow(/refusing/);
    expect(seen).toHaveLength(3);
  });

  it('reads the migration tag of its own script only; API errors carry Cloudflare\'s message', async () => {
    const fake = (async () => jsonRes(200, { success: true, result: [{ id: 'dotquiz', migration_tag: 'zz' }, { id: 'dotkick-gate-test', migration_tag: 'v1' }] })) as unknown as typeof fetch;
    expect(await cf.migrationTag(cfg, 'dotkick-gate-test', fake)).toBe('v1');
    expect(await cf.migrationTag(cfg, 'dotkick-gate', fake)).toBe('');
    await expect(cf.migrationTag(cfg, 'dotquiz', fake)).rejects.toThrow(/refusing/);
    const denied = (async () => jsonRes(403, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })) as unknown as typeof fetch;
    await expect(cf.cfApi(cfg, 'PUT', '/workers/scripts/dotkick-gate-test', {}, denied)).rejects.toThrow(/10000: Authentication error/);
  });

  it('codes.js round trip: builds from hashes, rejects anything that is not a hash, and the repo copy holds 64-hex hashes only', () => {
    const hs = [nodeHash(CODE_A), nodeHash(CODE_B)];
    expect(cf.hashesInCodesModule(cf.codesModule(hs))).toEqual(hs);
    expect(() => cf.codesModule(['TSTA-2345-6789'])).toThrow(/not a password hash/);
    const repo = readFileSync(new URL('../../server/gate-worker/codes.js', import.meta.url), 'utf8');
    expect(cf.hashesInCodesModule(repo).length).toBeGreaterThanOrEqual(1);
    expect(repo.replace(/\/\*[\s\S]*?\*\//, '').replace(/\/\/.*$/gm, '').replace(/'[0-9a-f]{64}',/g, '').replace(/\s/g, '')).toBe('exportdefault[];');
  });
});
