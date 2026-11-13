/* global console, process, URL */
/**
 * [GATE] Deploy the password checker (server/gate-worker, D-048) to the owner's Cloudflare account.
 *
 *   node tools/gate-deploy.mjs --env prod     worker "dotkick-gate" + D1 database "dotkick-gate" (the published game)
 *   node tools/gate-deploy.mjs --env test     worker "dotkick-gate-test" + D1 database "dotkick-gate-test" (tests)
 *
 * Steps (each safe to repeat): create the D1 database when missing (found by name), apply server/gate-worker/
 * schema.sql (CREATE TABLE IF NOT EXISTS: existing passwords are kept), upload worker.js as an ES module with the
 * database bound as DB (compatibility date 2025-01-01), and turn on that script's workers.dev address. It prints the
 * address and the database id. It never touches any other worker, database, route or the account's subdomain.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID (or --account <id>) and CLOUDFLARE_API_TOKEN (Workers Scripts Edit + D1 Edit); see
 * tools/lib/cloudflare.mjs. Add passwords afterwards with tools/gate-codes.mjs --server prod|test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudflareConfig, d1Query, enableWorkersDev, ensureDatabase, flagValue, gateEnv, sqlStatements, uploadWorker, workersSubdomain,
} from './lib/cloudflare.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

async function main() {
  const envName = flagValue(args, '--env');
  if (!envName) throw new Error('pass --env prod or --env test');
  const target = gateEnv(envName);
  const cfg = cloudflareConfig(args);
  const source = readFileSync(resolve(root, 'server/gate-worker/worker.js'), 'utf8');
  const schema = readFileSync(resolve(root, 'server/gate-worker/schema.sql'), 'utf8');

  const db = await ensureDatabase(cfg, target.database);
  console.log(`D1 database ${db.name}: ${db.created ? 'created' : 'found'} (id ${db.uuid})`);
  for (const sql of sqlStatements(schema)) await d1Query(cfg, db.uuid, sql);
  console.log('schema applied');
  await uploadWorker(cfg, target.script, source, db.uuid);
  console.log(`worker ${target.script} uploaded (D1 bound as DB)`);
  await enableWorkersDev(cfg, target.script);
  const sub = await workersSubdomain(cfg);
  console.log(`workers.dev on: https://${target.script}.${sub}.workers.dev/redeem`);
  const counts = await d1Query(cfg, db.uuid, 'SELECT COUNT(*) AS total, COUNT(used_at) AS used FROM codes');
  const c = counts.results[0] ?? { total: 0, used: 0 };
  console.log(`passwords: ${c.total} total, ${c.used} used, ${c.total - c.used} unused`);
}

main().catch((err) => {
  console.error(`gate-deploy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
