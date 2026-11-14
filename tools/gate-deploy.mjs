/* global console, process, URL, fetch */
/**
 * [GATE] Deploy the password checker (server/gate-worker, D-048) to the owner's Cloudflare account.
 *
 *   node tools/gate-deploy.mjs --env prod                      worker "dotkick-gate" (the published game)
 *   node tools/gate-deploy.mjs --env test --hashes <file>      worker "dotkick-gate-test" (tests), with the hashes in
 *                                                              <file> (one per line) instead of codes.js
 *
 * Uploads worker.js and codes.js (the accepted hashes) as ES modules with the GateStore Durable Object (SQLite
 * backed) bound as GATE, creating the class on the first deploy, then turns on that script's workers.dev address and
 * prints it with the password counts. Safe to repeat: the used-password table lives in the Durable Object and is
 * kept. It never touches any other worker, route or the account's subdomain.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID (or --account <id>) and CLOUDFLARE_API_TOKEN (Workers Scripts Edit); see
 * tools/lib/cloudflare.mjs. Behind an HTTPS proxy run with NODE_USE_ENV_PROXY=1.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cloudflareConfig, codesModule, enableWorkersDev, flagValue, gateEnv, migrationTag, uploadWorker, workersSubdomain,
} from './lib/cloudflare.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

async function main() {
  const envName = flagValue(args, '--env');
  if (!envName) throw new Error('pass --env prod or --env test');
  const target = gateEnv(envName);
  const cfg = cloudflareConfig(args);
  const source = readFileSync(resolve(root, 'server/gate-worker/worker.js'), 'utf8');
  const hashFile = flagValue(args, '--hashes');
  if (envName === 'prod' && hashFile) throw new Error('prod always uses server/gate-worker/codes.js');
  const codes = hashFile
    ? codesModule(readFileSync(hashFile, 'utf8').split(/\s+/).filter(Boolean))
    : readFileSync(resolve(root, 'server/gate-worker/codes.js'), 'utf8');

  const tag = await migrationTag(cfg, target.script);
  await uploadWorker(cfg, target.script, source, codes, tag);
  console.log(`worker ${target.script} uploaded (${tag ? 'store kept' : 'store created'})`);
  await enableWorkersDev(cfg, target.script);
  const sub = await workersSubdomain(cfg);
  const base = `https://${target.script}.${sub}.workers.dev`;
  console.log(`workers.dev on: ${base}/redeem`);
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(`${base}/stats`);
      if (r.ok) {
        const s = await r.json();
        console.log(`passwords: ${s.total} accepted, ${s.used} used, ${s.total - s.used} unused`);
        return;
      }
    } catch {
      /* the new address can take a few seconds to answer */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log('passwords: the checker did not answer /stats yet; try node tools/gate-codes.mjs --status ' + envName);
}

main().catch((err) => {
  console.error(`gate-deploy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
