/* global console, process */
/**
 * [GATE] Make and manage passwords for the password lock (src/app/gate.ts; online checker D-048).
 *
 *   npm run gate:codes -- 10 --server prod     10 new passwords, added to the published game's checker, then printed
 *   npm run gate:codes -- 10 --server test     ... to the test checker instead
 *   npm run gate:codes -- --status prod        how many passwords the checker holds: total, used, unused
 *   npm run gate:codes -- --retire CODE --server prod   remove a password nobody has used yet
 *   npm run gate:codes -- --import FILE --server prod   add hashes listed in FILE (one per line) to the checker
 *   npm run gate:codes -- 10                   10 new passwords and their hashes, printed only (nothing is added)
 *   npm run gate:codes -- --hash CODE          the hash of a password
 *
 * Passwords are 12 characters from CODE_ALPHABET (crypto randomness, crypto.randomInt: uniform), shown as
 * XXXX-XXXX-XXXX. They are printed to stdout ONLY: never written to a file, never committed (the repository is
 * public), never sent anywhere (only their hashes go to the checker). Copy them somewhere safe before closing the
 * terminal; they cannot be recovered from the hashes. With --server the passwords are printed only after their
 * hashes were added, so every printed password works.
 * Hash = lowercase hex SHA-256 of "dotkick-gate-v1:" + the normalised code (upper case, only A-Z and 0-9), the same
 * recipe as src/app/gate.ts and server/gate-worker/worker.js (tests/unit/gate-01-lock.test.ts and
 * tests/unit/gate-02-online.test.ts check that they agree).
 *
 * --server / --status / --retire / --import need CLOUDFLARE_ACCOUNT_ID (or --account <id>) and CLOUDFLARE_API_TOKEN
 * (see tools/lib/cloudflare.mjs; behind a proxy add NODE_USE_ENV_PROXY=1).
 */
import { createHash, randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 12;
export const GATE_HASH_PREFIX = 'dotkick-gate-v1:';
const HASH_RE = /^[0-9a-f]{64}$/;

/** Upper case, everything but A-Z and 0-9 removed (src/app/gate.ts normaliseCode). */
export function normaliseCode(input) {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** XXXX-XXXX-XXXX. */
export function formatCode(code) {
  return normaliseCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

/** Lowercase hex SHA-256 of the prefix + normalised code. */
export function hashCode(code) {
  return createHash('sha256').update(GATE_HASH_PREFIX + normaliseCode(code), 'utf8').digest('hex');
}

/** One new code (normalised, no dashes). `rand(n)` returns a uniform integer in [0, n). */
export function newCode(rand = (n) => randomInt(0, n)) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[rand(CODE_ALPHABET.length)];
  return s;
}

/** `n` distinct new codes whose hashes are not in `existing`. */
export function newCodes(n, existing = [], rand) {
  const seen = new Set(existing);
  const out = [];
  while (out.length < n) {
    const c = newCode(rand);
    const h = hashCode(c);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(c);
  }
  return out;
}

/** Well-formed hashes in a text (one per line; blank lines and # comments ignored). Throws on anything else. */
export function parseHashList(text) {
  const out = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;
    if (!HASH_RE.test(line)) throw new Error(`line ${i + 1} is not a lowercase hex SHA-256 hash`);
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** SQL + params that add `hashes` (unused) to the checker's table, skipping ones already there. Pure. */
export function insertStatement(hashes) {
  if (hashes.length === 0 || hashes.length > 90 || !hashes.every((h) => HASH_RE.test(h))) throw new Error('1..90 well-formed hashes per statement');
  return { sql: `INSERT OR IGNORE INTO codes (hash) VALUES ${hashes.map(() => '(?)').join(', ')}`, params: [...hashes] };
}

async function cloudflare(args, envName) {
  const cf = await import('./lib/cloudflare.mjs');
  const target = cf.gateEnv(envName);
  const cfg = cf.cloudflareConfig(args);
  const db = await cf.findDatabase(cfg, target.database);
  if (!db) throw new Error(`no D1 database "${target.database}": run node tools/gate-deploy.mjs --env ${envName} first`);
  return { cf, cfg, db, target };
}

async function addHashes(args, envName, hashes) {
  const { cf, cfg, db } = await cloudflare(args, envName);
  let added = 0;
  for (let i = 0; i < hashes.length; i += 90) {
    const st = insertStatement(hashes.slice(i, i + 90));
    added += (await cf.d1Query(cfg, db.uuid, st.sql, st.params)).changes;
  }
  return added;
}

async function status(args, envName) {
  const { cf, cfg, db } = await cloudflare(args, envName);
  const r = await cf.d1Query(cfg, db.uuid, 'SELECT COUNT(*) AS total, COUNT(used_at) AS used FROM codes');
  const c = r.results[0] ?? { total: 0, used: 0 };
  return { total: c.total, used: c.used, unused: c.total - c.used };
}

async function main(args) {
  const { flagValue } = await import('./lib/cloudflare.mjs');
  const hashAt = args.indexOf('--hash');
  if (hashAt >= 0) {
    const code = args[hashAt + 1];
    if (!code) throw new Error('--hash needs a code');
    console.log(hashCode(code));
    return;
  }
  if (args.includes('--append')) {
    throw new Error('--append is gone: passwords now live in the online checker. Use --server prod (see README "Make new passwords").');
  }
  const statusEnv = flagValue(args, '--status');
  if (statusEnv !== undefined) {
    const s = await status(args, statusEnv);
    console.log(`${statusEnv} checker: ${s.total} passwords, ${s.used} used, ${s.unused} unused`);
    return;
  }
  const server = flagValue(args, '--server');
  if (args.includes('--server') && !server) throw new Error('--server needs prod or test');
  const retire = flagValue(args, '--retire');
  if (retire !== undefined) {
    if (!server) throw new Error('--retire needs --server prod or --server test');
    const { cf, cfg, db } = await cloudflare(args, server);
    const r = await cf.d1Query(cfg, db.uuid, 'DELETE FROM codes WHERE hash = ?1 AND used_at IS NULL', [hashCode(retire)]);
    console.log(r.changes === 1 ? 'Removed: that password no longer works.' : 'Nothing removed: that password is not in the checker, or it has already been used.');
    return;
  }
  const importFile = flagValue(args, '--import');
  if (importFile !== undefined) {
    if (!server) throw new Error('--import needs --server prod or --server test');
    const hashes = parseHashList(readFileSync(resolve(importFile), 'utf8'));
    if (hashes.length === 0) throw new Error('no hashes in that file');
    const added = await addHashes(args, server, hashes);
    console.log(`${added} of ${hashes.length} hash${hashes.length === 1 ? '' : 'es'} added (the rest were already there).`);
    return;
  }
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('the number of codes must be 1..1000');
  const codes = newCodes(n);
  const hashes = codes.map(hashCode);
  if (server) {
    const added = await addHashes(args, server, hashes);
    if (added !== n) throw new Error(`only ${added} of ${n} hashes were added (a clash with an existing password): run again`);
    const s = await status(args, server);
    console.log(`${n} new DotKick password${n === 1 ? '' : 's'}, added to the ${server} checker. Each works once, on one device.`);
    console.log('Keep them safe; they are not saved anywhere:\n');
    for (const c of codes) console.log(`  ${formatCode(c)}`);
    console.log(`\nThe ${server} checker now holds ${s.total} passwords (${s.used} used, ${s.unused} unused).`);
    return;
  }
  console.log(`${n} new DotKick password${n === 1 ? '' : 's'} (NOT added to any checker yet). Keep them safe; they are not saved anywhere:\n`);
  for (const c of codes) console.log(`  ${formatCode(c)}`);
  console.log('\nTheir hashes (put them in a file and add it with --import FILE --server prod):\n');
  for (const h of hashes) console.log(`  ${h}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`gate-codes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof Error && /needs|must be|gone/.test(err.message) ? 2 : 1);
  });
}
