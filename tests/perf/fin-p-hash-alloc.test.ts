/**
 * [FIN-P skeptic] hashState allocates nothing per mixed number in Chromium (the proxy gate's engine).
 *
 * The replay recorder hashes the live state every REPLAY_HASH_INTERVAL ticks of every match (net desync checks every
 * T_NET.hashInterval online, the sim warm-up every T_WARMUP.hashEvery). Its running murmur state was a module `let`
 * updated per mixed word, and each double's two words went to mixWord as call arguments: Chromium's V8 stored the
 * out-of-small-integer-range int32 into the module's context slot as a new heap number, one per mixed number, even in
 * fully optimised code: ~12 B per number, ~47 KB per hash of a live state, the largest single allocation of play in the
 * bench (1.5 KB a tick at 4x, tests/perf/fin-p-tick-trace.ts --alloc; more scavenges, each 3-5 ms under throttling).
 * Node's V8 does not show it, so this test runs the real src/sim/core/hash.ts in headless Chromium: bundled with
 * esbuild, a live bench-match state, the hasher warmed, then the CDP sampling heap profiler over 200 hashes.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const ENTRY = `
import { hashState } from './src/sim/core/hash';
import { initMatch } from './src/sim/init';
import { step } from './src/sim/step';
import { clearInputFrame, createInputFrame } from './src/contracts/input';
import { createEventBuffer } from './src/sim/core/events';
import { benchSetup } from './src/platform/benchHook';
const s = initMatch(benchSetup(1).config);
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
for (let t = 0; t < 600; t++) { clearInputFrame(frames[0]); clearInputFrame(frames[1]); step(s, frames, ev); }
const sink = new Int32Array(1);
let numbers = 0;
(function count(v) {
  if (typeof v === 'number') { numbers++; return; }
  if (v === null || typeof v !== 'object') return;
  if (ArrayBuffer.isView(v)) { numbers += v.length; return; }
  for (const k of Object.keys(v)) if (!(v === s && (k === 'config' || k === 'squads'))) count(v[k]);
})(s);
window.__finpHash = { hash(n) { for (let i = 0; i < n; i++) sink[0] ^= hashState(s); return sink[0]; }, numbers };
`;

describe('fin-p: hashState allocation in Chromium', () => {
  it('fin-p: hashing a live state allocates no heap number per mixed number in Chromium (replay recorder, desync checks)', async () => {
    const out = await build({
      stdin: { contents: ENTRY, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'iife', write: false,
      platform: 'browser', target: 'es2022', define: { __DEV_BUILD__: 'true' }, logLevel: 'silent',
    });
    const code = out.outputFiles[0]!.text;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.addScriptTag({ content: code });
      const numbers = await page.evaluate('window.__finpHash.numbers') as number;
      expect(numbers).toBeGreaterThan(1000);
      await page.evaluate('window.__finpHash.hash(400)'); // optimised by now
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('HeapProfiler.enable');
      await cdp.send('HeapProfiler.startSampling', {
        samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
      } as never);
      const calls = 200;
      await page.evaluate(`window.__finpHash.hash(${calls})`);
      const p = (await cdp.send('HeapProfiler.stopSampling')) as { profile: { head: HeapNode } };
      // Only what the hashing allocates (the subtree under the page's hash() loop; not the page's idle / CDP work).
      let bytes = 0;
      const by: Record<string, number> = {};
      const walk = (nd: HeapNode, inHash: boolean): void => {
        const h = inHash || nd.callFrame.functionName === 'hash';
        if (h && nd.selfSize > 0) {
          bytes += nd.selfSize;
          const k = `${nd.callFrame.functionName}:${nd.callFrame.lineNumber}`;
          by[k] = (by[k] ?? 0) + nd.selfSize;
        }
        for (const c of nd.children) walk(c, h);
      };
      walk(p.profile.head, false);
      const top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${Math.round(v / calls)}`);
      const perHash = bytes / calls;
      console.log(`FIN-P hashState in Chromium: ${Math.round(perHash)} B per hash of ${numbers} numbers; ${top.join(', ')}`);
      // Was ~12 B per number (~47 KB a hash). Slack for sampling noise: well under one byte per number.
      expect(perHash).toBeLessThan(numbers * 0.25);
    } finally {
      await browser.close();
    }
  }, 120_000);
});

interface HeapNode { selfSize: number; callFrame: { functionName: string; lineNumber: number }; children: HeapNode[] }
