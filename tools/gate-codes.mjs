/* global console, process, URL */
/**
 * [GATE] Make new passwords for the password lock (src/app/gate.ts, D-047).
 *
 *   npm run gate:codes                      10 new codes: plain codes and their hashes printed to the terminal
 *   npm run gate:codes -- 5                 5 new codes
 *   npm run gate:codes -- 5 --append        ... and add the hashes to src/data/gateCodes.ts (commit that file)
 *   npm run gate:codes -- --hash CODE       the hash of an existing code (to find or remove its line)
 *
 * Codes are 12 characters from CODE_ALPHABET (crypto randomness, crypto.randomInt: uniform), shown as XXXX-XXXX-XXXX.
 * The plain codes are printed to stdout ONLY: never written to a file, never committed (the repository is public).
 * Copy them somewhere safe before closing the terminal; they cannot be recovered from the hashes.
 * Hash = lowercase hex SHA-256 of "dotkick-gate-v1:" + the normalised code (upper case, only A-Z and 0-9), the same
 * recipe as src/app/gate.ts (tests/unit/gate-01-lock.test.ts checks the two agree).
 */
import { createHash, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 12;
export const GATE_HASH_PREFIX = 'dotkick-gate-v1:';
export const BEGIN_MARK = '// gate-codes:begin';
export const END_MARK = '// gate-codes:end';

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

/** Hashes listed between the markers of a code list file's text. */
export function listedHashes(text) {
  const a = text.indexOf(BEGIN_MARK);
  const b = text.indexOf(END_MARK);
  if (a < 0 || b < a) throw new Error(`code list: markers "${BEGIN_MARK}" / "${END_MARK}" not found`);
  return [...text.slice(a, b).matchAll(/'([0-9a-f]{64})'/g)].map((m) => m[1]);
}

/** The code list file's text with `hashes` added before the end marker (keeps its indentation). */
export function appendHashes(text, hashes) {
  listedHashes(text); // validates the markers
  const b = text.indexOf(END_MARK);
  const lineStart = text.lastIndexOf('\n', b) + 1;
  const indent = text.slice(lineStart, b);
  const lines = hashes.map((h) => `${indent}'${h}',\n`).join('');
  return text.slice(0, lineStart) + lines + text.slice(lineStart);
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const listFile = resolve(root, 'src/data/gateCodes.ts');
  const args = process.argv.slice(2);
  const hashAt = args.indexOf('--hash');
  if (hashAt >= 0) {
    const code = args[hashAt + 1];
    if (!code) {
      console.error('gate-codes: --hash needs a code');
      process.exit(2);
    }
    console.log(hashCode(code));
    process.exit(0);
  }
  const n = Number(args.find((a) => /^\d+$/.test(a)) ?? 10);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    console.error('gate-codes: the number of codes must be 1..1000');
    process.exit(2);
  }
  const text = readFileSync(listFile, 'utf8');
  const codes = newCodes(n, listedHashes(text));
  const hashes = codes.map(hashCode);
  console.log(`${n} new DotKick password${n === 1 ? '' : 's'} (each works once per device). Keep them safe; they are not saved anywhere:\n`);
  for (const c of codes) console.log(`  ${formatCode(c)}`);
  console.log('\nHashes for src/data/gateCodes.ts:\n');
  for (const h of hashes) console.log(`  '${h}',`);
  if (args.includes('--append')) {
    writeFileSync(listFile, appendHashes(text, hashes));
    console.log(`\nAdded ${n} hash${n === 1 ? '' : 'es'} to src/data/gateCodes.ts. Build and publish to make the new codes work.`);
  } else {
    console.log('\nNot added: paste these hash lines between the markers in src/data/gateCodes.ts yourself (a run with');
    console.log('--append makes new codes and adds their hashes in one go; the codes above would then not work).');
  }
}
