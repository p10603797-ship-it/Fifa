/* global console, process, fetch, URL */
/**
 * [GATE] Make and manage passwords for the password lock (src/app/gate.ts; online checker D-048). The checker accepts
 * the hashes listed in server/gate-worker/codes.js; after changing that file, publish it with
 * `node tools/gate-deploy.mjs --env prod` (the site itself does not need rebuilding) and commit it.
 *
 *   npm run gate:codes -- 10 --add             10 new passwords: hashes added to codes.js, passwords printed
 *   npm run gate:codes -- 10                   10 new passwords and their hashes, printed only (nothing is changed)
 *   npm run gate:codes -- --import FILE        add the hashes listed in FILE (one per line) to codes.js
 *   npm run gate:codes -- --retire CODE        remove a password's hash from codes.js (it stops working once deployed)
 *   npm run gate:codes -- --status prod        how many passwords the published checker accepts: total, used, unused
 *   npm run gate:codes -- --hash CODE          the hash of a password
 *
 * Passwords are 12 characters from CODE_ALPHABET (crypto randomness, crypto.randomInt: uniform), shown as
 * XXXX-XXXX-XXXX. They are printed to stdout ONLY: never written to a file, never committed (the repository is
 * public), never sent anywhere. Copy them somewhere safe before closing the terminal; they cannot be recovered from
 * the hashes.
 * Hash = lowercase hex SHA-256 of "dotkick-gate-v1:" + the normalised code (upper case, only A-Z and 0-9), the same
 * recipe as src/app/gate.ts and server/gate-worker/worker.js (tests/unit/gate-01-lock.test.ts and
 * tests/unit/gate-02-online.test.ts check that they agree).
 *
 * --status needs CLOUDFLARE_ACCOUNT_ID (or --account <id>) and CLOUDFLARE_API_TOKEN (see tools/lib/cloudflare.mjs;
 * behind a proxy add NODE_USE_ENV_PROXY=1).
 */
import { createHash, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

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

export const CODES_FILE = 'server/gate-worker/codes.js';
const END_MARK = '  // gate-codes:end';

/** The hashes listed in codes.js text. */
export function listedHashes(text) {
  return [...new Set(text.match(/[0-9a-f]{64}/g) ?? [])];
}

/** codes.js text with `hashes` added before the end marker (ones already listed are skipped). Pure. */
export function appendHashes(text, hashes) {
  if (!hashes.every((h) => HASH_RE.test(h))) throw new Error('not a lowercase hex SHA-256 hash');
  const at = text.indexOf(END_MARK);
  if (at < 0) throw new Error(`${CODES_FILE} has no gate-codes:end marker`);
  const have = new Set(listedHashes(text));
  const add = [...new Set(hashes)].filter((h) => !have.has(h));
  return { text: text.slice(0, at) + add.map((h) => `  '${h}',\n`).join('') + text.slice(at), added: add.length };
}

/** codes.js text without `hash`. Pure. */
export function removeHash(text, hash) {
  const lines = text.split('\n');
  const kept = lines.filter((l) => l.trim() !== `'${hash}',`);
  return { text: kept.join('\n'), removed: lines.length - kept.length };
}

async function status(args, envName) {
  const cf = await import('./lib/cloudflare.mjs');
  const target = cf.gateEnv(envName);
  const sub = await cf.workersSubdomain(cf.cloudflareConfig(args));
  const r = await fetch(`https://${target.script}.${sub}.workers.dev/stats`);
  if (!r.ok) throw new Error(`the ${envName} checker answered HTTP ${r.status}`);
  const s = await r.json();
  return { total: s.total, used: s.used, unused: s.total - s.used };
}

const REDEPLOY = 'Now publish them to the checker: node tools/gate-deploy.mjs --env prod (and commit server/gate-worker/codes.js).';

async function main(args) {
  const { flagValue } = await import('./lib/cloudflare.mjs');
  const file = resolve(root, CODES_FILE);
  const hashAt = args.indexOf('--hash');
  if (hashAt >= 0) {
    const code = args[hashAt + 1];
    if (!code) throw new Error('--hash needs a code');
    console.log(hashCode(code));
    return;
  }
  const statusEnv = flagValue(args, '--status');
  if (statusEnv !== undefined) {
    const s = await status(args, statusEnv);
    console.log(`${statusEnv} checker: ${s.total} passwords, ${s.used} used, ${s.unused} unused`);
    return;
  }
  const retire = flagValue(args, '--retire');
  if (retire !== undefined) {
    const r = removeHash(readFileSync(file, 'utf8'), hashCode(retire));
    if (r.removed === 0) {
      console.log(`Nothing removed: that password is not in ${CODES_FILE}.`);
      return;
    }
    writeFileSync(file, r.text);
    console.log(`Removed from ${CODES_FILE}. ${REDEPLOY}`);
    return;
  }
  const importFile = flagValue(args, '--import');
  if (importFile !== undefined) {
    const hashes = parseHashList(readFileSync(resolve(importFile), 'utf8'));
    if (hashes.length === 0) throw new Error('no hashes in that file');
    const r = appendHashes(readFileSync(file, 'utf8'), hashes);
    writeFileSync(file, r.text);
    console.log(`${r.added} of ${hashes.length} hash${hashes.length === 1 ? '' : 'es'} added to ${CODES_FILE}. ${REDEPLOY}`);
    return;
  }
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error('the number of codes must be 1..1000');
  const text = readFileSync(file, 'utf8');
  const codes = newCodes(n, listedHashes(text));
  const hashes = codes.map(hashCode);
  if (args.includes('--add')) {
    writeFileSync(file, appendHashes(text, hashes).text);
    console.log(`${n} new DotKick password${n === 1 ? '' : 's'}, added to ${CODES_FILE}. Each works once, on one device.`);
    console.log('Keep them safe; they are not saved anywhere:\n');
    for (const c of codes) console.log(`  ${formatCode(c)}`);
    console.log(`\n${REDEPLOY}`);
    return;
  }
  console.log(`${n} new DotKick password${n === 1 ? '' : 's'} (NOT added anywhere). Keep them safe; they are not saved anywhere:\n`);
  for (const c of codes) console.log(`  ${formatCode(c)}`);
  console.log('\nTheir hashes (save them in a file and add it with --import FILE, or run again with --add):\n');
  for (const h of hashes) console.log(`  ${h}`);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`gate-codes: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(err instanceof Error && /needs|must be/.test(err.message) ? 2 : 1);
  });
}
