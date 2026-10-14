/**
 * [PLT-04] Single-file build gate (tools/postbuild.mjs) and bundle breakdown helpers (tools/size-check.ts):
 * self-containment checks on HTML, font accounting, the sw.js build-version injection (idempotent), extras copied
 * and verified, unexpected files and the 4 MB gzip budget, the module grouping and the PERF_REPORT section writer.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { groupOf, renderMarkdown, replaceSection, type SizeReport } from '../../tools/size-check';

interface PostbuildReport {
  ok: boolean; errors: string[]; warnings: string[]; notes: string[];
  sizes: { raw: number; gzip: number; brotli: number } | null; files?: string[]; fonts?: { count: number; bytes: number }; build?: string | null;
}
interface Postbuild {
  GZIP_BUDGET_BYTES: number;
  analyzeHtml(html: string): { errors: string[]; warnings: string[]; fonts: { count: number; bytes: number; other: number } };
  injectBuildVersion(sw: string, build: string): { text: string; changed: boolean; found: boolean };
  buildId(version: string, html: string | Buffer): string;
  sizesOf(b: Buffer): { raw: number; gzip: number; brotli: number };
  runPostbuild(dist: string, opts?: { publicDir?: string; gzipBudget?: number }): PostbuildReport;
}

async function loadPostbuild(): Promise<Postbuild> {
  return (await import(/* @vite-ignore */ new URL('../../tools/postbuild.mjs', import.meta.url).href)) as Postbuild;
}

const WOFF2 = Buffer.from('wOF2-fake-font-bytes').toString('base64');
const GOOD = `<!doctype html><html><head><meta charset="utf-8">
<link rel="manifest" href="manifest.webmanifest"><link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon-180.png">
<style>body{background:url(data:image/png;base64,AAAA)}</style>
<script type="module">const f=new FontFace('X','url(data:font/woff2;base64,${WOFF2})');const s='http://www.w3.org/2000/svg';</script>
</head><body><canvas id="game"></canvas></body></html>`;

const SW = `const BUILD = 'dev'; // dotkick-build: tools/postbuild.mjs replaces the quoted value\nconst CACHE = 'x' + BUILD;\n`;

describe('PLT-04 postbuild self-containment checks', () => {
  it('accepts a self-contained page (inline code, data: fonts, relative extras)', async () => {
    const pb = await loadPostbuild();
    const r = pb.analyzeHtml(GOOD);
    expect(r.errors).toEqual([]);
    expect(r.fonts.count).toBe(1);
    expect(r.fonts.bytes).toBe(Buffer.from(WOFF2, 'base64').length);
  });

  it.each([
    ['external script', GOOD.replace('<script type="module">', '<script src="https://cdn.example/x.js"></script><script type="module">'), /external script/],
    ['external stylesheet', GOOD.replace('<style>', '<link rel="stylesheet" href="assets/style.css"><style>'), /external <link rel="stylesheet"/],
    ['font preload', GOOD.replace('<style>', '<link rel="preload" href="/fonts/a.woff2"><style>'), /external <link rel="preload"/],
    ['absolute manifest path', GOOD.replace('href="manifest.webmanifest"', 'href="/manifest.webmanifest"'), /absolute path in <link rel="manifest"/],
    ['protocol-relative icon', GOOD.replace('href="icons/icon-192.png"', 'href="//cdn.example/i.png"'), /absolute path in <link rel="icon"/],
    ['absolute img src', GOOD.replace('<canvas', '<img src="/logo.png"><canvas'), /absolute path in <img src/],
    ['css @import', GOOD.replace('body{', '@import url(https://fonts.example/css);body{'), /CSS @import/],
    ['css url to a file', GOOD.replace('data:image/png;base64,AAAA', '/bg.png'), /CSS url\(\/bg\.png\) is not inlined/],
    ['un-inlined chunk', GOOD.replace("const s=", "const c='./assets/chunk-1.js';const s="), /un-inlined build file/],
    ['dynamic import', GOOD.replace("const s=", "import('./lazy.js');const s="), /dynamic import of "\.\/lazy\.js"/],
    ['ttf font', GOOD.replace('data:font/woff2', 'data:font/ttf'), /non-woff2 font/],
    ['font file', GOOD.replace(`data:font/woff2;base64,${WOFF2}`, 'fonts/a.woff2'), /font file not inlined: fonts\/a\.woff2/],
  ])('rejects %s', async (_name, html, re) => {
    const pb = await loadPostbuild();
    const r = pb.analyzeHtml(html);
    expect(r.errors.some((e) => re.test(e))).toBe(true);
  });

  it('rejects a page without inline code', async () => {
    const pb = await loadPostbuild();
    expect(pb.analyzeHtml('<html><body></body></html>').errors).toContain('no inline <script>: the game code is missing');
  });
});

describe('PLT-04 service worker build id', () => {
  it('injects the build id once; a second run is a no-op; a missing marker is reported', async () => {
    const pb = await loadPostbuild();
    const id = pb.buildId('0.1.0', 'html');
    expect(id).toMatch(/^0\.1\.0-[0-9a-f]{10}$/);
    expect(pb.buildId('0.1.0', 'html')).toBe(id);
    expect(pb.buildId('0.1.0', 'html2')).not.toBe(id);
    const a = pb.injectBuildVersion(SW, id);
    expect(a).toMatchObject({ found: true, changed: true });
    expect(a.text).toContain(`const BUILD = '${id}'; // dotkick-build`);
    expect(pb.injectBuildVersion(a.text, id)).toMatchObject({ found: true, changed: false });
    expect(pb.injectBuildVersion('self.x = 1;', id)).toMatchObject({ found: false, changed: false });
    // The real service worker carries the marker.
    const real = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8');
    expect(pb.injectBuildVersion(real, id).found).toBe(true);
  });
});

describe('PLT-04 runPostbuild on a dist folder', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeDist(): { dist: string; pub: string } {
    const base = mkdtempSync(join(tmpdir(), 'plt04-'));
    dirs.push(base);
    const dist = join(base, 'dist');
    const pub = join(base, 'public');
    mkdirSync(join(pub, 'icons'), { recursive: true });
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, 'index.html'), GOOD);
    writeFileSync(join(pub, 'sw.js'), SW);
    writeFileSync(join(pub, 'icons', 'icon-192.png'), 'png');
    writeFileSync(join(pub, 'icons', 'apple-touch-icon-180.png'), 'png');
    writeFileSync(join(pub, 'manifest.webmanifest'), JSON.stringify({ start_url: './', scope: './', icons: [{ src: 'icons/icon-192.png' }] }));
    return { dist, pub };
  }

  it('copies missing extras, versions sw.js, reports sizes and passes; running twice changes nothing', async () => {
    const pb = await loadPostbuild();
    const { dist, pub } = makeDist();
    const r = pb.runPostbuild(dist, { publicDir: pub });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.notes).toEqual(expect.arrayContaining(['copied manifest.webmanifest from public/', 'copied sw.js from public/']));
    expect(r.files!.sort()).toEqual(['icons/apple-touch-icon-180.png', 'icons/icon-192.png', 'index.html', 'manifest.webmanifest', 'sw.js']);
    const sw = readFileSync(join(dist, 'sw.js'), 'utf8');
    expect(sw).toContain(`const BUILD = '${r.build}';`);
    expect(r.sizes!.gzip).toBeGreaterThan(0);
    expect(r.sizes!.brotli).toBeGreaterThan(0);
    const again = pb.runPostbuild(dist, { publicDir: pub });
    expect(again.ok).toBe(true);
    expect(again.notes).toEqual([]);
    expect(readFileSync(join(dist, 'sw.js'), 'utf8')).toBe(sw);
  });

  it('fails on an unexpected file, a manifest icon that is missing, and a missing index.html', async () => {
    const pb = await loadPostbuild();
    const { dist, pub } = makeDist();
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'assets', 'index-abc.js'), 'x');
    writeFileSync(join(pub, 'manifest.webmanifest'), JSON.stringify({ start_url: '/', icons: [{ src: 'icons/nope.png' }] }));
    const r = pb.runPostbuild(dist, { publicDir: pub });
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(expect.arrayContaining([
      'unexpected file in dist: assets/index-abc.js (everything must be inlined into index.html)',
      'manifest start_url "/" is absolute',
      'manifest icon "icons/nope.png" is missing from dist',
    ]));
    rmSync(join(dist, 'index.html'));
    expect(pb.runPostbuild(dist, { publicDir: pub }).errors[0]).toMatch(/index\.html does not exist/);
  });

  it('fails over the gzip budget (4 MB by default)', async () => {
    const pb = await loadPostbuild();
    expect(pb.GZIP_BUDGET_BYTES).toBe(4 * 1024 * 1024);
    const { dist, pub } = makeDist();
    // Incompressible filler: a deterministic xorshift byte stream, base64 encoded, against a 16 KB test budget.
    let x = 2463534242;
    const bytes = Buffer.alloc(24 * 1024);
    for (let i = 0; i < bytes.length; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      bytes[i] = x & 0xff;
    }
    writeFileSync(join(dist, 'index.html'), GOOD.replace('</body>', `<script>var pad='${bytes.toString('base64')}'</script></body>`));
    expect(pb.runPostbuild(dist, { publicDir: pub }).ok).toBe(true);
    const r = pb.runPostbuild(dist, { publicDir: pub, gzipBudget: 16 * 1024 });
    expect(r.errors.some((e) => /exceeds the 16\.0 KB budget/.test(e))).toBe(true);
  });
});

describe('PLT-04 size-check helpers', () => {
  it('groups modules by package and source folder', () => {
    expect(groupOf('/home/x/node_modules/three/build/three.module.js')).toBe('three');
    expect(groupOf('/home/x/node_modules/@fontsource/space-grotesk/files/a.woff2?url')).toBe('fonts');
    expect(groupOf('/home/x/node_modules/peerjs/dist/bundler.mjs')).toBe('peerjs');
    expect(groupOf('/home/x/node_modules/left-pad/index.js')).toBe('other');
    expect(groupOf('/home/x/src/sim/step.ts')).toBe('src/sim');
    expect(groupOf('C:\\x\\src\\render\\index.ts')).toBe('src/render');
    expect(groupOf('/home/x/src/main.ts')).toBe('src/app');
    expect(groupOf('\0vite/modulepreload-polyfill')).toBe('other');
  });

  it('writes and replaces the marked Bundle section', () => {
    const r: SizeReport = {
      rows: [{ group: 'three', rawBytes: 2048, gzipBytes: 1024, modules: 3, budgetKb: 10, ok: true }],
      total: { raw: 4096, gzip: 1024, brotli: 900, budget: 4 * 1024 * 1024, ok: true },
      fonts: { count: 5, bytes: 80 * 1024 },
      ok: true,
      startup: { 'main menu (ms)': 1234 },
    };
    const md = renderMarkdown(r, '2026-10-14');
    expect(md).toContain('## Bundle');
    expect(md).toContain('| three | 3 | 2.0 | 1.0 | 100.0 % | 10 | ok |');
    expect(md).toContain('| main menu (ms) | 1234 |');
    const doc1 = replaceSection('# Performance report\n\n## Frame rate\n\nx\n', md);
    expect(doc1).toContain('## Frame rate');
    expect(doc1).toContain('<!-- bundle:start');
    const doc2 = replaceSection(doc1, md.replace('2026-10-14', '2026-10-15'));
    expect(doc2.match(/## Bundle/g)).toHaveLength(1);
    expect(doc2).toContain('2026-10-15');
    expect(doc2).toContain('## Frame rate');
    expect(replaceSection('', md)).toMatch(/^# Performance report\n/);
  });
});
