/* global fetch, process, FormData, Blob, URLSearchParams */
/**
 * [GATE] Small Cloudflare REST helper for the password checker tools (tools/gate-deploy.mjs, tools/gate-codes.mjs;
 * D-048). Only the DotKick checker's own resources can be named here (GATE_ENVS, plus throwaway review resources
 * whose names start with "dotkick-gate-review-"): nothing else on the Cloudflare account is ever touched.
 *
 * Account id: CLOUDFLARE_ACCOUNT_ID or --account <id>. API token: CLOUDFLARE_API_TOKEN (a token with "Workers
 * Scripts: Edit" and "D1: Edit" on that account), sent as "Authorization: Bearer <token>".
 * Node 22's fetch ignores HTTPS_PROXY; behind a proxy run the tools with NODE_USE_ENV_PROXY=1.
 */

const API = 'https://api.cloudflare.com/client/v4';

/** The checker's two deployments: --env prod (what the published game uses) and --env test (for tests). */
export const GATE_ENVS = {
  prod: { script: 'dotkick-gate', database: 'dotkick-gate' },
  test: { script: 'dotkick-gate-test', database: 'dotkick-gate-test' },
};
export const REVIEW_PREFIX = 'dotkick-gate-review-';
/** Fixed compatibility date of the worker (a past date: the runtime behaviour never moves under it). */
export const COMPATIBILITY_DATE = '2025-01-01';

/** Throws unless `name` is one of the checker's own resource names. */
export function assertGateName(name) {
  const own = Object.values(GATE_ENVS).some((e) => e.script === name || e.database === name);
  if (!own && !(typeof name === 'string' && name.startsWith(REVIEW_PREFIX) && /^[a-z0-9-]+$/.test(name))) {
    throw new Error(`refusing to touch "${name}": not a DotKick password-checker resource`);
  }
  return name;
}

/** --env value -> { script, database }. `review-<x>` names a throwaway pair. */
export function gateEnv(name) {
  if (name === 'prod' || name === 'test') return GATE_ENVS[name];
  if (typeof name === 'string' && /^review-[a-z0-9-]+$/.test(name)) {
    const n = `dotkick-gate-${name}`;
    return { script: n, database: n };
  }
  throw new Error(`unknown environment "${name}" (prod or test)`);
}

/** Value after `--flag` in argv, or undefined. */
export function flagValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** { account, token } from --account / CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Throws a plain message. */
export function cloudflareConfig(args = process.argv.slice(2), env = process.env) {
  const account = flagValue(args, '--account') ?? env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!account || !/^[0-9a-f]{32}$/.test(account)) throw new Error('set CLOUDFLARE_ACCOUNT_ID (or pass --account <id>): the 32-character account id');
  if (!token) throw new Error('set CLOUDFLARE_API_TOKEN: an API token with Workers Scripts Edit and D1 Edit');
  return { account, token };
}

/** One API call; returns `result`, throws with Cloudflare's error messages. */
export async function cfApi(cfg, method, path, body, fetchFn = fetch) {
  const headers = { Authorization: `Bearer ${cfg.token}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetchFn(`${API}/accounts/${cfg.account}${path}`, { method, headers, body: payload });
  let j;
  try {
    j = await res.json();
  } catch {
    throw new Error(`${method} ${path}: HTTP ${res.status}, not JSON`);
  }
  if (!res.ok || !j || j.success !== true) {
    const msg = (j && Array.isArray(j.errors) ? j.errors.map((e) => `${e.code}: ${e.message}`).join('; ') : '') || `HTTP ${res.status}`;
    throw new Error(`${method} ${path}: ${msg}`);
  }
  return j.result;
}

/** The D1 database called `name` ({ uuid, name }) or null. */
export async function findDatabase(cfg, name, fetchFn) {
  assertGateName(name);
  const list = await cfApi(cfg, 'GET', `/d1/database?${new URLSearchParams({ name, per_page: '100' })}`, undefined, fetchFn);
  const hit = (list ?? []).find((d) => d.name === name);
  return hit ? { uuid: hit.uuid, name: hit.name } : null;
}

/** The D1 database called `name`, created when missing. */
export async function ensureDatabase(cfg, name, fetchFn) {
  const found = await findDatabase(cfg, name, fetchFn);
  if (found) return { ...found, created: false };
  const made = await cfApi(cfg, 'POST', '/d1/database', { name: assertGateName(name) }, fetchFn);
  return { uuid: made.uuid, name: made.name, created: true };
}

/** Run one SQL statement with params; returns { results, changes }. */
export async function d1Query(cfg, uuid, sql, params = [], fetchFn) {
  const out = await cfApi(cfg, 'POST', `/d1/database/${uuid}/query`, { sql, params }, fetchFn);
  const first = Array.isArray(out) ? out[0] : out;
  return { results: first?.results ?? [], changes: first?.meta?.changes ?? 0 };
}

/** Upload the worker module with the D1 binding DB (multipart: metadata + worker.js). */
export async function uploadWorker(cfg, script, source, databaseId, fetchFn) {
  assertGateName(script);
  const form = new FormData();
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [{ type: 'd1', name: 'DB', id: databaseId }],
  };
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
  return cfApi(cfg, 'PUT', `/workers/scripts/${script}`, form, fetchFn);
}

/** Turn on the workers.dev address of this one script (the account's subdomain itself is not changed). */
export async function enableWorkersDev(cfg, script, fetchFn) {
  assertGateName(script);
  return cfApi(cfg, 'POST', `/workers/scripts/${script}/subdomain`, { enabled: true, previews_enabled: false }, fetchFn);
}

/** The account's workers.dev subdomain (read only). */
export async function workersSubdomain(cfg, fetchFn) {
  const r = await cfApi(cfg, 'GET', '/workers/subdomain', undefined, fetchFn);
  return r.subdomain;
}

/** Split an SQL file into statements (comments dropped; no semicolons inside strings in our schema). */
export function sqlStatements(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
