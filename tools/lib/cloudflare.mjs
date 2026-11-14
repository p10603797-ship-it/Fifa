/* global fetch, process, FormData, Blob */
/**
 * [GATE] Small Cloudflare REST helper for the password checker tools (tools/gate-deploy.mjs, tools/gate-codes.mjs;
 * D-048). Only the DotKick checker's own resources can be named here (GATE_ENVS, plus throwaway review resources
 * whose names start with "dotkick-gate-review-"): nothing else on the Cloudflare account is ever touched.
 *
 * Account id: CLOUDFLARE_ACCOUNT_ID or --account <id>. API token: CLOUDFLARE_API_TOKEN (a token with "Workers
 * Scripts: Edit" on that account, e.g. the "Edit Cloudflare Workers" template), sent as "Authorization: Bearer <token>".
 * Node 22's fetch ignores HTTPS_PROXY; behind a proxy run the tools with NODE_USE_ENV_PROXY=1.
 */

const API = 'https://api.cloudflare.com/client/v4';

/** The checker's two deployments: --env prod (what the published game uses) and --env test (for tests). */
export const GATE_ENVS = {
  prod: { script: 'dotkick-gate' },
  test: { script: 'dotkick-gate-test' },
};
export const REVIEW_PREFIX = 'dotkick-gate-review-';
/** Fixed compatibility date of the worker (a past date: the runtime behaviour never moves under it). */
export const COMPATIBILITY_DATE = '2025-01-01';

/** Throws unless `name` is one of the checker's own resource names. */
export function assertGateName(name) {
  const own = Object.values(GATE_ENVS).some((e) => e.script === name);
  if (!own && !(typeof name === 'string' && name.startsWith(REVIEW_PREFIX) && /^[a-z0-9-]+$/.test(name))) {
    throw new Error(`refusing to touch "${name}": not a DotKick password-checker resource`);
  }
  return name;
}

/** --env value -> { script }. `review-<x>` names a throwaway checker. */
export function gateEnv(name) {
  if (name === 'prod' || name === 'test') return GATE_ENVS[name];
  if (typeof name === 'string' && /^review-[a-z0-9-]+$/.test(name)) {
    return { script: `dotkick-gate-${name}` };
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
  if (!token) throw new Error('set CLOUDFLARE_API_TOKEN: an API token with Workers Scripts Edit');
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

/** The Durable Object migration tag the script has now ('' when it does not exist yet). */
export async function migrationTag(cfg, script, fetchFn) {
  assertGateName(script);
  const list = await cfApi(cfg, 'GET', '/workers/scripts', undefined, fetchFn);
  const hit = (list ?? []).find((w) => w.id === script);
  return hit && typeof hit.migration_tag === 'string' ? hit.migration_tag : '';
}

/** Durable Object migration that creates the SQLite-backed GateStore class. */
export const STORE_MIGRATION_TAG = 'v1';

/**
 * Upload worker.js plus its codes.js module, with the GateStore Durable Object bound as GATE. The migration that
 * creates the class is sent only when the script does not have it yet (`currentTag`).
 */
export async function uploadWorker(cfg, script, source, codesSource, currentTag, fetchFn) {
  assertGateName(script);
  const form = new FormData();
  const metadata = {
    main_module: 'worker.js',
    compatibility_date: COMPATIBILITY_DATE,
    bindings: [{ type: 'durable_object_namespace', name: 'GATE', class_name: 'GateStore' }],
  };
  if (currentTag !== STORE_MIGRATION_TAG) metadata.migrations = { new_tag: STORE_MIGRATION_TAG, new_sqlite_classes: ['GateStore'] };
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([source], { type: 'application/javascript+module' }), 'worker.js');
  form.append('codes.js', new Blob([codesSource], { type: 'application/javascript+module' }), 'codes.js');
  return cfApi(cfg, 'PUT', `/workers/scripts/${script}`, form, fetchFn);
}

/** codes.js source for a list of hashes (lowercase hex SHA-256, 64 characters each). */
export function codesModule(hashes) {
  for (const h of hashes) if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('not a password hash: ' + String(h).slice(0, 8) + '...');
  return `export default [\n${hashes.map((h) => `  '${h}',`).join('\n')}\n];\n`;
}

/** The hashes listed in a codes.js source (between its markers or anywhere). */
export function hashesInCodesModule(text) {
  return [...new Set(text.match(/[0-9a-f]{64}/g) ?? [])];
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
