/**
 * [PLT-04] Bundle size breakdown and budget (brief section 3: download 4 MB or less compressed).
 *
 * Runs the production Vite build in memory (vite.config.ts + a measuring plugin, write: false), groups every bundled
 * module by package (three, peerjs, ...) or source folder (src/sim, src/render, ...), and reports per group the
 * code size as the bundler renders it (before minification), the gzip size of that code on its own, the share and a
 * budget. The inlined
 * fonts (woff2 data URIs, the @fontsource Latin subsets) and the CSS are their own rows. The total is the real
 * single-file index.html (raw / gzip / brotli), checked against the 4 MB gzip budget.
 *
 *   npx tsx tools/size-check.ts            print the table; exit 1 when a budget fails
 *   npx tsx tools/size-check.ts --write    also replace the "Bundle" section of docs/PERF_REPORT.md
 *   npx tsx tools/size-check.ts --json     machine-readable output
 *
 * Startup: when reports/plt-04-startup.json exists (written by tests/e2e/plt-04-build.spec.ts, which measures the
 * time to the main menu with ~20 Mbit/s network throttling), its numbers are added to the report.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { build, type Plugin } from 'vite';

export const TOTAL_GZIP_BUDGET = 4 * 1024 * 1024;

/**
 * Per-group budgets in KB of module code as the bundler renders it (before minification; the minified, inlined
 * index.html is the total). They catch a group that suddenly grows (a new dependency, generated data) long before the
 * 4 MB gzip total is at risk; src/net and peerjs leave room for online 1v1.
 */
export const GROUP_BUDGETS_KB: Record<string, number> = {
  three: 1100,
  'src/sim': 1100,
  'src/ui': 650,
  'src/render': 650,
  'src/ai': 450,
  'src/input': 350,
  peerjs: 350,
  'src/data': 250,
  'src/net': 200,
  fonts: 160,
  'src/platform': 150,
  'src/audio': 150,
  css: 150,
  other: 150,
  'src/modes': 120,
  // [FIN-A] 80 KB predated moving every gameplay number into contracts/tuning.ts (TUN-1/TUN-7S: ~110 KB now). An
  // early-warning group budget only; the 4 MB gzip total gate is unchanged.
  'src/contracts': 160,
  'src/app': 80,
};

export interface GroupRow { group: string; rawBytes: number; gzipBytes: number; modules: number; budgetKb: number | null; ok: boolean }

/** Group of a module id. Pure. */
export function groupOf(id: string): string {
  const norm = id.replace(/\\/g, '/').replace(/^\0/, '').replace(/\?.*$/, '');
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(norm);
  if (nm) {
    const pkg = nm[1]!;
    if (pkg === 'three') return 'three';
    if (pkg.startsWith('@fontsource/')) return 'fonts';
    if (pkg === 'peerjs' || pkg === 'peerjs-js-binarypack' || pkg === 'webrtc-adapter' || pkg === 'sdp' || pkg === 'eventemitter3') return 'peerjs';
    return 'other';
  }
  const src = /\/src\/([^/]+)\//.exec(norm);
  if (src) return `src/${src[1]}`;
  if (/\/src\/[^/]+\.ts$/.test(norm)) return 'src/app';
  return 'other';
}

function gz(s: string | Uint8Array): number {
  return gzipSync(typeof s === 'string' ? Buffer.from(s) : s, { level: 9 }).length;
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)}`;
}

interface Measured {
  modules: { id: string; code: string }[];
  css: string;
  html: string;
}

function measuringPlugin(out: Measured): Plugin {
  return {
    name: 'dotkick-size-check',
    enforce: 'pre',
    generateBundle(_opts, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') {
          for (const [id, m] of Object.entries(item.modules)) {
            const code = (m as { code?: string | null }).code ?? '';
            out.modules.push({ id, code });
          }
        } else if (item.fileName.endsWith('.css')) {
          out.css += typeof item.source === 'string' ? item.source : Buffer.from(item.source).toString('utf8');
        }
      }
    },
    writeBundle() { /* write: false */ },
  };
}

export interface SizeReport {
  rows: GroupRow[];
  total: { raw: number; gzip: number; brotli: number; budget: number; ok: boolean };
  fonts: { count: number; bytes: number };
  ok: boolean;
  startup: Record<string, unknown> | null;
}

export async function measure(rootDir: string): Promise<SizeReport> {
  const out: Measured = { modules: [], css: '', html: '' };
  const result = await build({
    root: rootDir,
    configFile: join(rootDir, 'vite.config.ts'),
    logLevel: 'silent',
    plugins: [measuringPlugin(out)],
    build: { write: false, reportCompressedSize: false },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const o of outputs) {
    const items = (o as { output?: { fileName: string; type: string; source?: string | Uint8Array }[] }).output ?? [];
    for (const it of items) {
      if (it.fileName === 'index.html' && it.source !== undefined) {
        out.html = typeof it.source === 'string' ? it.source : Buffer.from(it.source).toString('utf8');
      }
    }
  }
  const groups = new Map<string, { code: string[]; raw: number; n: number }>();
  for (const m of out.modules) {
    const g = groupOf(m.id);
    const e = groups.get(g) ?? { code: [], raw: 0, n: 0 };
    e.code.push(m.code);
    e.raw += Buffer.byteLength(m.code);
    e.n++;
    groups.set(g, e);
  }
  if (out.css) groups.set('css', { code: [out.css], raw: Buffer.byteLength(out.css), n: 1 });
  const rows: GroupRow[] = [];
  for (const [group, e] of groups) {
    const budgetKb = GROUP_BUDGETS_KB[group] ?? null;
    rows.push({ group, rawBytes: e.raw, gzipBytes: gz(e.code.join('\n')), modules: e.n, budgetKb, ok: budgetKb === null || e.raw <= budgetKb * 1024 });
  }
  rows.sort((a, b) => b.rawBytes - a.rawBytes);
  const htmlBuf = Buffer.from(out.html);
  const fonts = { count: 0, bytes: 0 };
  for (const f of out.html.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)) {
    fonts.count++;
    fonts.bytes += Buffer.from(f[1]!, 'base64').length;
  }
  const total = {
    raw: htmlBuf.length,
    gzip: gz(htmlBuf),
    brotli: brotliCompressSync(htmlBuf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11 } }).length,
    budget: TOTAL_GZIP_BUDGET,
    ok: false,
  };
  total.ok = total.raw > 0 && total.gzip <= TOTAL_GZIP_BUDGET;
  const startupPath = join(rootDir, 'reports', 'plt-04-startup.json');
  let startup: Record<string, unknown> | null = null;
  if (existsSync(startupPath)) {
    try {
      startup = JSON.parse(readFileSync(startupPath, 'utf8')) as Record<string, unknown>;
    } catch {
      startup = null;
    }
  }
  return { rows, total, fonts, ok: total.ok && rows.every((r) => r.ok), startup };
}

/** Markdown "Bundle" section. Pure. */
export function renderMarkdown(r: SizeReport, date: string): string {
  const lines: string[] = [];
  lines.push('## Bundle');
  lines.push('');
  lines.push(`Generated by \`npx tsx tools/size-check.ts --write\` (PLT-04) on ${date}. Budget: 4 MB gzip for the whole`);
  lines.push('single-file `index.html` (brief section 3; `tools/postbuild.mjs` enforces it on every `npm run build`). Group sizes are');
  lines.push('module code as the bundler renders it, before minification (the shares are what matters); "gzip" compresses each');
  lines.push('group on its own. The total line is the real minified, inlined file.');
  lines.push('');
  lines.push(`**index.html: ${kb(r.total.raw)} KB raw, ${kb(r.total.gzip)} KB gzip, ${kb(r.total.brotli)} KB brotli — ` +
    `${((r.total.gzip / r.total.budget) * 100).toFixed(1)} % of the gzip budget (${r.total.ok ? 'PASS' : 'FAIL'}).**`);
  lines.push(`Fonts: ${r.fonts.count} woff2 faces inlined (Latin subsets of Space Grotesk and JetBrains Mono), ${kb(r.fonts.bytes)} KB.`);
  lines.push('');
  lines.push('| Group | Modules | Code KB | Gzip KB | Share | Budget KB | Status |');
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  const sum = r.rows.reduce((a, x) => a + x.rawBytes, 0) || 1;
  for (const row of r.rows) {
    lines.push(`| ${row.group} | ${row.modules} | ${kb(row.rawBytes)} | ${kb(row.gzipBytes)} | ${((row.rawBytes / sum) * 100).toFixed(1)} % | ` +
      `${row.budgetKb ?? '-'} | ${row.ok ? 'ok' : '**over**'} |`);
  }
  lines.push('');
  if (r.startup) {
    lines.push('### Startup (time to main menu)');
    lines.push('');
    lines.push('Measured by `tests/e2e/plt-04-build.spec.ts` in Chromium with network throttling (target: main menu within 3 s on Wi-Fi).');
    lines.push('');
    lines.push('| Metric | Value |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(r.startup)) lines.push(`| ${k} | ${String(v)} |`);
    lines.push('');
  }
  return lines.join('\n');
}

const START = '<!-- bundle:start (tools/size-check.ts) -->';
const END = '<!-- bundle:end -->';

/** Replace (or append) the marked Bundle section of a markdown document. Pure. */
export function replaceSection(doc: string, section: string): string {
  const block = `${START}\n${section}\n${END}`;
  const a = doc.indexOf(START);
  const b = doc.indexOf(END);
  if (a >= 0 && b > a) return doc.slice(0, a) + block + doc.slice(b + END.length);
  const base = doc.trim() === '' ? '# Performance report\n' : doc.replace(/\s*$/, '\n');
  return `${base}\n${block}\n`;
}

async function main(): Promise<void> {
  const rootDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const args = process.argv.slice(2);
  const r = await measure(rootDir);
  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(`size-check: index.html ${kb(r.total.raw)} KB raw, ${kb(r.total.gzip)} KB gzip, ${kb(r.total.brotli)} KB brotli (budget ${kb(r.total.budget)} KB gzip)`);
    for (const row of r.rows) {
      console.log(`size-check:   ${row.group.padEnd(14)} ${kb(row.rawBytes).padStart(8)} KB code ${kb(row.gzipBytes).padStart(8)} KB gzip` +
        `  budget ${row.budgetKb ?? '-'} KB ${row.ok ? '' : ' OVER'}`);
    }
  }
  if (args.includes('--write')) {
    const p = join(rootDir, 'docs', 'PERF_REPORT.md');
    const doc = existsSync(p) ? readFileSync(p, 'utf8') : '';
    writeFileSync(p, replaceSection(doc, renderMarkdown(r, new Date().toISOString().slice(0, 10))));
    console.log(`size-check: wrote the Bundle section of ${p}`);
  }
  console.log(r.ok ? 'size-check: PASS' : 'size-check: FAIL');
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((err: unknown) => {
    console.error('size-check: error', err);
    process.exitCode = 1;
  });
}
