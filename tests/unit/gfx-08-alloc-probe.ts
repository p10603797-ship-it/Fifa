/**
 * [GFX-08] Allocation probe for the per-frame-safe kit atlas lookups (run by tests/unit/gfx-08-atlas.test.ts in a
 * child process): node --expose-gc --import tsx tests/unit/gfx-08-alloc-probe.ts [n]
 * Prints JSON { <lookup>: bytes allocated per call }.
 */
import { CLUBS } from '../../src/data/clubs';
import { createKitAtlas, drawKitAtlas, resolveKits } from '../../src/render/kits';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const n = Number(process.argv[2] ?? 50000);

const atlas = createKitAtlas();
const kits = resolveKits(CLUBS[0]!, CLUBS[1]!, 0, 1);
drawKitAtlas(atlas, kits, [CLUBS[0]!.squad.map((p) => p.shirt), CLUBS[1]!.squad.map((p) => p.shirt)], [CLUBS[0]!.crest, CLUBS[1]!.crest]);
const out = new Float32Array(22 * 4);

const probes: Record<string, (i: number) => void> = {
  shirtUv: (i) => atlas.shirtUv(i & 1, (i & 2) !== 0, (i % 30) + 1, out, (i % 22) * 4),
  numberUv: (i) => atlas.numberUv(i & 1, (i & 2) !== 0, (i % 30) + 1, out, (i % 22) * 4),
  shortsSocksCrestWhite: (i) => {
    atlas.shortsUv(i & 1, false, out, 0);
    atlas.socksUv(i & 1, true, out, 4);
    atlas.crestUv(i & 1, out, 8);
    atlas.whiteUv(out, 12);
  },
};
const res: Record<string, number> = {};
for (const name of Object.keys(probes)) {
  const f = probes[name]!;
  for (let i = 0; i < 5000; i++) f(i);
  gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) f(i);
  res[name] = (process.memoryUsage().heapUsed - h0) / n;
}
console.log(JSON.stringify(res));
