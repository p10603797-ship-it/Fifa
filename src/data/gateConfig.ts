/**
 * [GATE] Where the password lock checks a password (D-048): the redeem address of the online checker
 * (server/gate-worker/worker.js, deployed with `node tools/gate-deploy.mjs --env prod` on the owner's Cloudflare
 * account). This is the only address the game contacts outside online 1v1, and only when a password is submitted on
 * the lock screen: an unlocked device never contacts it. The accepted hashes are in server/gate-worker/codes.js, so new
 * passwords are added there (`npm run gate:codes -- 10 --add`, then deploy) without rebuilding the site.
 */
export const GATE_SERVER_URL = 'https://dotkick-gate.dotquiz-live.workers.dev/redeem';

/** How long one check may take before the lock says it could not reach the checker, ms. */
export const GATE_SERVER_TIMEOUT_MS = 10_000;
