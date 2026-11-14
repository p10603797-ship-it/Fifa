/* global Response, TextDecoder, TextEncoder, URL, crypto */
/**
 * [GATE] DotKick password checker (D-048): a Cloudflare Worker with one SQLite-backed Durable Object (GateStore), so a
 * password works once across every device. Plain ES module, no dependencies. Deployed by tools/gate-deploy.mjs, which
 * also writes ./codes.js (the accepted password hashes) next to it at upload time.
 *
 *   GET  /         -> 200 {"ok":true}  (health; reveals nothing)
 *   POST /redeem   body {"code": "...", "device": "..."}  -> 200 {"result": "ok" | "used" | "wrong"}
 *   GET  /stats    -> 200 {"total": n, "used": n}  (counts only)
 *   OPTIONS *      -> 204 CORS preflight
 *   anything else  -> 404 (unknown path) or 405 (wrong method), JSON {"error": "..."}
 *
 * Redeem: the code is normalised and hashed exactly like src/app/gate.ts (upper case, everything but A-Z and 0-9
 * removed; lowercase hex SHA-256 of "dotkick-gate-v1:" + that). A hash not in codes.js -> "wrong" (no storage read).
 * Otherwise the one GateStore instance claims it: its SQLite calls are synchronous, so the read and the write of one
 * claim can never interleave with another request's (a Durable Object runs one event at a time between awaits):
 * no row -> insert (hash, device, now) -> "ok"; same device id -> "ok" again (a retry after a lost response must not
 * burn the code); another device -> "used".
 *
 * The device id is a random id the game makes and stores before its first request (128 bits or more: 32+ hex digits
 * or 22+ base64url characters). Requests that are not a small JSON object with a string code and a well-formed
 * device id get 400 (413 when the body is over 1 KB). Nothing is logged; only the code's hash, the time it was used
 * and the device id are stored. CORS: any origin (no cookies or credentials are used).
 */

import CODE_HASHES from './codes.js';

export const GATE_HASH_PREFIX = 'dotkick-gate-v1:';
/** Largest accepted request body, bytes. */
export const MAX_BODY_BYTES = 1024;
/** Longest code string accepted before normalisation (a code is 12 characters; typing may add spaces and dashes). */
export const MAX_CODE_CHARS = 100;
/** Normalised codes outside this length range cannot exist: answered "wrong" without a database read. */
export const MIN_CODE_LEN = 4;
export const MAX_CODE_LEN = 64;
/** A device id: 22-128 characters of base64url (hex is a subset). */
export const DEVICE_RE = /^[A-Za-z0-9_-]{22,128}$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** Upper case, everything but A-Z and 0-9 removed (src/app/gate.ts normaliseCode). */
export function normaliseCode(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Lowercase hex SHA-256 of GATE_HASH_PREFIX + the normalised code. */
export async function hashCode(code) {
  const bytes = new TextEncoder().encode(GATE_HASH_PREFIX + normaliseCode(code));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

/** Read at most MAX_BODY_BYTES of the body; null when it is longer. */
async function readSmallBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Parse and check a redeem body: { code, device } or a string naming what is wrong. */
export function parseRedeemBody(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return 'bad json';
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'bad body';
  const { code, device } = v;
  if (typeof code !== 'string' || code.length === 0 || code.length > MAX_CODE_CHARS) return 'bad code';
  if (typeof device !== 'string' || !DEVICE_RE.test(device)) return 'bad device';
  return { code, device };
}

/** The accepted hashes (codes.js), as a set. */
export const VALID_HASHES = new Set(CODE_HASHES);

/**
 * The single-use store: one Durable Object instance (name "codes") with an SQLite table of used hashes. `sql` is
 * ctx.storage.sql (exec(query, ...bindings) -> cursor with toArray()); every call below is synchronous.
 */
export class GateStore {
  constructor(ctx) {
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS used (hash TEXT PRIMARY KEY NOT NULL, device TEXT NOT NULL, used_at INTEGER NOT NULL)');
  }

  /** Claim `hash` for `device`: 'ok' (now, or already this device's) or 'used' (another device has it). */
  claim(hash, device, now) {
    const row = this.sql.exec('SELECT device FROM used WHERE hash = ?', hash).toArray()[0];
    if (row) return row.device === device ? 'ok' : 'used';
    this.sql.exec('INSERT INTO used (hash, device, used_at) VALUES (?, ?, ?)', hash, device, now);
    return 'ok';
  }

  /** Number of used hashes that are still accepted. */
  usedCount() {
    let n = 0;
    for (const r of this.sql.exec('SELECT hash FROM used').toArray()) if (VALID_HASHES.has(r.hash)) n++;
    return n;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/claim') {
      const { hash, device, now } = await request.json();
      return Response.json({ result: this.claim(hash, device, now) });
    }
    if (url.pathname === '/stats') return Response.json({ used: this.usedCount() });
    return new Response('not found', { status: 404 });
  }
}

function store(env) {
  return env.GATE.get(env.GATE.idFromName('codes'));
}

/** The redeem step. Returns 'ok' | 'used' | 'wrong'. */
export async function redeem(env, code, device, now = Date.now()) {
  const n = normaliseCode(code);
  if (n.length < MIN_CODE_LEN || n.length > MAX_CODE_LEN) return 'wrong';
  const hash = await hashCode(n);
  if (!VALID_HASHES.has(hash)) return 'wrong';
  const res = await store(env).fetch('https://gate-store/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, device, now }),
  });
  if (!res.ok) throw new Error(`store ${res.status}`);
  const { result } = await res.json();
  if (result !== 'ok' && result !== 'used') throw new Error('store answer');
  return result;
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === '/' || url.pathname === '') {
    if (method === 'GET' || method === 'HEAD') return json(200, { ok: true });
    return json(405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (url.pathname === '/stats') {
    if (method !== 'GET') return json(405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
    try {
      const r = await store(env).fetch('https://gate-store/stats');
      const { used } = await r.json();
      return json(200, { total: VALID_HASHES.size, used });
    } catch {
      return json(503, { error: 'unavailable' });
    }
  }
  if (url.pathname !== '/redeem') return json(404, { error: 'not found' });
  if (method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });
  const text = await readSmallBody(request);
  if (text === null) return json(413, { error: 'body too large' });
  const body = parseRedeemBody(text);
  if (typeof body === 'string') return json(400, { error: body });
  try {
    return json(200, { result: await redeem(env, body.code, body.device) });
  } catch {
    return json(503, { error: 'unavailable' });
  }
}

export default {
  fetch(request, env) {
    return handle(request, env).catch(() => json(500, { error: 'internal' }));
  },
};
