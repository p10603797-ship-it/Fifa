/* global Response, TextDecoder, TextEncoder, URL, crypto */
/**
 * [GATE] DotKick password checker (D-048): a Cloudflare Worker with one D1 database, so a password works once across
 * every device. Plain ES module, no dependencies. Deployed by tools/gate-deploy.mjs; the table is schema.sql.
 *
 *   GET  /         -> 200 {"ok":true}  (health; reveals nothing)
 *   POST /redeem   body {"code": "...", "device": "..."}  -> 200 {"result": "ok" | "used" | "wrong"}
 *   OPTIONS *      -> 204 CORS preflight
 *   anything else  -> 404 (unknown path) or 405 (wrong method), JSON {"error": "..."}
 *
 * Redeem: the code is normalised and hashed exactly like src/app/gate.ts (upper case, everything but A-Z and 0-9
 * removed; lowercase hex SHA-256 of "dotkick-gate-v1:" + that), then, in one statement (atomic in D1):
 *   UPDATE codes SET used_at = now, device = ? WHERE hash = ? AND used_at IS NULL
 * One row changed -> "ok". Otherwise the row is read: same device id -> "ok" again (a retry after a lost response
 * must not burn the code), another device -> "used", no row -> "wrong".
 *
 * The device id is a random id the game makes and stores before its first request (128 bits or more: 32+ hex digits
 * or 22+ base64url characters). Requests that are not a small JSON object with a string code and a well-formed
 * device id get 400 (413 when the body is over 1 KB). Nothing is logged; only the code's hash, the time it was used
 * and the device id are stored. CORS: any origin (no cookies or credentials are used).
 */

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

/** The redeem step against D1 (`db`: prepare / bind / run / first). Returns 'ok' | 'used' | 'wrong'. */
export async function redeem(db, code, device, now = Date.now()) {
  const n = normaliseCode(code);
  if (n.length < MIN_CODE_LEN || n.length > MAX_CODE_LEN) return 'wrong';
  const hash = await hashCode(n);
  const claim = await db
    .prepare('UPDATE codes SET used_at = ?1, device = ?2 WHERE hash = ?3 AND used_at IS NULL')
    .bind(now, device, hash)
    .run();
  if (claim && claim.meta && claim.meta.changes === 1) return 'ok';
  const row = await db.prepare('SELECT device FROM codes WHERE hash = ?1').bind(hash).first();
  if (!row) return 'wrong';
  return row.device === device ? 'ok' : 'used';
}

export async function handle(request, env) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (url.pathname === '/' || url.pathname === '') {
    if (method === 'GET' || method === 'HEAD') return json(200, { ok: true });
    return json(405, { error: 'method not allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
  }
  if (url.pathname !== '/redeem') return json(404, { error: 'not found' });
  if (method !== 'POST') return json(405, { error: 'method not allowed' }, { Allow: 'POST, OPTIONS' });
  const text = await readSmallBody(request);
  if (text === null) return json(413, { error: 'body too large' });
  const body = parseRedeemBody(text);
  if (typeof body === 'string') return json(400, { error: body });
  try {
    return json(200, { result: await redeem(env.DB, body.code, body.device) });
  } catch {
    return json(503, { error: 'unavailable' });
  }
}

export default {
  fetch(request, env) {
    return handle(request, env).catch(() => json(500, { error: 'internal' }));
  },
};
