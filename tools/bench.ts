/**
 * [FND-06] Headless benchmark proxy gate (brief section 13): serves dist/ (build it first: `npm run bench` does),
 * opens it in Playwright Chromium at ?bench=1 with CDP CPU throttling (default 4x), waits for
 * window.__benchResult, prints it, and exits 1 if the sim, draw-call or triangle budgets fail. The fps budgets
 * are informational under throttling (only a real iPad run decides them).
 *
 *   npx tsx tools/bench.ts [--throttle 4] [--seconds 90] [--seed N] [--json reports/bench.json] [--headed]
 *                          [--timeout S] [--dist dist]
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import type { BenchResult } from '../src/platform/benchHook';
import { formatBenchResult } from '../src/platform/benchHook';
import { bool, num, parseArgs, str } from './lib/args';
import { writeJson } from './lib/report';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

/** Tiny static file server for dist/ (no directory listing, no path escape). */
export function serveDir(dir: string): Promise<{ server: Server; url: string }> {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? '/').split('?')[0]!);
    const rel = normalize(path === '/' ? '/index.html' : path);
    const file = resolve(join(root, rel));
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      ok({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const SPEC = {
  throttle: 'number', seconds: 'number', seed: 'number', json: 'string', headed: 'boolean', timeout: 'number', dist: 'string',
  help: 'boolean',
} as const;

async function main(argv: readonly string[]): Promise<number> {
  const { flags } = parseArgs(argv, SPEC);
  if (bool(flags, 'help')) {
    console.log('usage: tsx tools/bench.ts [--throttle 4] [--seconds 90] [--seed N] [--json out.json] [--headed] [--timeout S] [--dist dist]');
    return 0;
  }
  const throttle = num(flags, 'throttle', 4);
  const seconds = num(flags, 'seconds', 90);
  const dist = str(flags, 'dist', fileURLToPath(new URL('../dist/', import.meta.url)));
  const timeoutMs = num(flags, 'timeout', seconds + 180) * 1000;
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`bench: ${join(dist, 'index.html')} not found - run "npm run build" first (npm run bench does)`);
    return 2;
  }
  const { server, url } = await serveDir(dist);
  const browser = await chromium.launch({ headless: !bool(flags, 'headed') });
  const errors: string[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, hasTouch: true });
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    if (throttle > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    }
    const q = new URLSearchParams({ bench: '1', benchSeconds: String(seconds) });
    if (typeof flags.seed === 'number') q.set('benchSeed', String(flags.seed));
    console.log(`bench: ${url}index.html?${q.toString()} (CPU throttle ${throttle}x, ${seconds} s window)`);
    await page.goto(`${url}index.html?${q.toString()}`);
    await page.waitForFunction(() => window.__benchResult !== undefined, null, { timeout: timeoutMs, polling: 1000 });
    const result = (await page.evaluate(() => window.__benchResult)) as BenchResult;
    console.log(formatBenchResult(result));
    for (const e of errors.slice(0, 20)) console.log(`  ${e}`);
    if (typeof flags.json === 'string') writeJson(flags.json, { throttle, result, errors });
    const ok = result.proxyPass;
    console.log(`bench proxy gate (sim, draw calls, triangles; fps informational under ${throttle}x throttling): ${ok ? 'PASS' : 'FAIL'}`);
    return ok ? 0 : 1;
  } finally {
    await browser.close();
    server.close();
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => { console.error(err); process.exit(1); },
  );
}
