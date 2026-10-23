/**
 * [FIN-P] Match load time of the benchmark match (diagnostic, not a test): navigation to ?bench=1 until the match
 * state exists (session.getState() non-null: initMatch, the sim warm-up and the renderer warm-up are done), in
 * headless Chromium with CDP CPU throttling, as tools/bench.ts launches it.
 *
 *   npx tsx tests/perf/fin-p-load-time.ts --dist dist-e2e/fin-p [--throttle 1,4] [--runs 2]
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { serveDir } from '../../tools/bench';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const arg = (k: string, d: string): string => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d; };

async function main(): Promise<void> {
  const s = await serveDir(resolve(ROOT, arg('dist', 'dist-e2e/fin-p')));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const rate of arg('throttle', '1,4').split(',').map(Number)) {
      for (let r = 0; r < Number(arg('runs', '2')); r++) {
        const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
        const t0 = Date.now();
        await page.goto(`${s.url}index.html?bench=1&benchSeconds=5`, { timeout: 300_000 });
        const tNav = Date.now() - t0;
        await page.waitForFunction(`(() => { const d = window.__dotkick; return !!d && d.ctx.session.getState() !== null; })()`, null, { timeout: 300_000, polling: 50 });
        const tState = Date.now() - t0;
        console.log(JSON.stringify({ throttle: rate, run: r, loadedMs: tNav, matchStateMs: tState }));
        await context.close();
      }
    }
  } finally {
    await browser.close();
    s.server.close();
  }
}
main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
