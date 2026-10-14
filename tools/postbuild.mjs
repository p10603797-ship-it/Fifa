/* global console, process, URL, Buffer */
/**
 * [PLT-04; FND-06 baseline] Post-build gate for `npm run build` (brief sections 3, 4 and 19):
 *
 * 1. dist/index.html exists and is self-contained: no external script, stylesheet, font or preload URL, no CSS
 *    @import or url() other than data: URIs, no absolute paths (`/x`, `//host`, `http(s)://`) in src / href, no
 *    references to un-inlined build chunks (`assets/...`), and nothing else in dist but the optional extras. Only
 *    `manifest`, `icon` and `apple-touch-icon` links may point beside it (relative paths).
 * 2. Fonts: only woff2 data URIs (the @fontsource Latin subsets), counted and sized, within FONT_BUDGET_BYTES.
 * 3. Extras beside it: manifest.webmanifest, sw.js and icons are copied from public/ when missing, the manifest must
 *    parse and its icons must exist, and the service worker's `const BUILD = '...'; // dotkick-build` line gets this
 *    build's id (package version + a hash of index.html), so every build that changes the game is a new worker
 *    (update flow). Idempotent: running it twice gives the same files.
 * 4. Sizes: raw, gzip and brotli of index.html and of the whole dist; fails when index.html is over the 4 MB gzip
 *    budget (brief section 3: download 4 MB or less compressed).
 *
 *   node tools/postbuild.mjs [distDir] [--json]
 *
 * Exit code 0 = PASS, 1 = FAIL (every problem is printed). The functions are exported for tests.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliCompressSync, constants as zlibConstants, gzipSync } from 'node:zlib';

export const GZIP_BUDGET_BYTES = 4 * 1024 * 1024;
/** Decoded woff2 bytes allowed inline (five Latin faces are ~80 KB). */
export const FONT_BUDGET_BYTES = 200 * 1024;
/** Files allowed beside index.html (the optional extras). */
export const EXTRA_FILES = ['manifest.webmanifest', 'sw.js'];
export const EXTRA_DIRS = ['icons'];
export const SW_BUILD_RE = /^(const BUILD = )'([^'\n]*)'(; \/\/ dotkick-build)/m;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Human-readable size. */
export function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

/** raw / gzip (level 9) / brotli (quality 11) byte counts of a buffer. */
export function sizesOf(buf) {
  return {
    raw: buf.length,
    gzip: gzipSync(buf, { level: 9 }).length,
    brotli: brotliCompressSync(buf, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length,
  };
}

function isRelativeUrl(u) {
  return !/^([a-z][a-z0-9+.-]*:|\/)/i.test(u);
}

function attr(tag, name) {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/**
 * Check an HTML string for self-containment. Returns { errors, warnings, fonts: { count, bytes, other } , links }.
 * Pure (no file access).
 */
export function analyzeHtml(html) {
  const errors = [];
  const warnings = [];
  const links = [];
  // Inline <script> and <style> bodies are checked separately; tags are scanned with them removed.
  const scripts = [];
  const styles = [];
  const tagsOnly = html
    .replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (_m, attrs, body) => {
      scripts.push({ attrs, body });
      return `<script${attrs}></script>`;
    })
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (_m, attrs, body) => {
      styles.push(body);
      return `<style${attrs}></style>`;
    });

  for (const s of scripts) {
    const src = attr(`<script${s.attrs}>`, 'src');
    if (src !== null) errors.push(`external script: <script src="${src}">`);
  }
  if (scripts.length === 0) errors.push('no inline <script>: the game code is missing');

  const tagRe = /<([a-z][a-z0-9-]*)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(tagsOnly)) !== null) {
    const tag = m[0];
    const name = m[1].toLowerCase();
    if (name === 'link') {
      const rel = (attr(tag, 'rel') ?? '').toLowerCase();
      const href = attr(tag, 'href') ?? '';
      links.push({ rel, href });
      const allowedBeside = /(^|\s)(manifest|icon|apple-touch-icon|shortcut)(\s|$)/.test(rel);
      if (href.startsWith('data:')) continue;
      if (!allowedBeside) {
        errors.push(`external <link rel="${rel}" href="${href}">`);
      } else if (!isRelativeUrl(href)) {
        errors.push(`absolute path in <link rel="${rel}" href="${href}"> (relative paths only)`);
      }
      continue;
    }
    for (const a of ['src', 'href', 'srcset', 'poster', 'data']) {
      const v = attr(tag, a);
      if (v === null || v === '' || v.startsWith('data:') || v.startsWith('#') || v.startsWith('blob:')) continue;
      if (name === 'a' && a === 'href') continue;
      if (!isRelativeUrl(v)) errors.push(`absolute path in <${name} ${a}="${v}">`);
      else warnings.push(`<${name} ${a}="${v}"> loads a file beside index.html`);
    }
  }

  const css = styles.join('\n');
  for (const im of css.matchAll(/@import\s+[^;]+;/gi)) errors.push(`CSS ${im[0]}`);
  for (const u of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi)) {
    const v = u[2].trim();
    if (v.startsWith('data:') || v.startsWith('#')) continue;
    errors.push(`CSS url(${v}) is not inlined`);
  }

  // Un-inlined chunks or assets referenced from code.
  const js = scripts.map((s) => s.body).join('\n');
  for (const a of js.matchAll(/["'`](\.?\/)?assets\/[^"'`\s]+\.(js|mjs|css|woff2?|ttf|otf|png|jpe?g|svg|wasm)["'`]/g)) {
    errors.push(`reference to an un-inlined build file ${a[0]}`);
  }
  for (const d of js.matchAll(/\bimport\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    if (!d[1].startsWith('data:')) errors.push(`dynamic import of "${d[1]}" (code must be inlined)`);
  }

  // Fonts: woff2 data URIs only.
  const fonts = { count: 0, bytes: 0, other: 0 };
  for (const f of html.matchAll(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/g)) {
    fonts.count++;
    fonts.bytes += Buffer.from(f[1], 'base64').length;
  }
  for (const f of html.matchAll(/data:(?:font\/(?:ttf|otf|woff)(?![0-9])|application\/(?:x-font-[a-z]+|font-woff))[;,]/g)) {
    fonts.other++;
    errors.push(`non-woff2 font inlined (${f[0]})`);
  }
  // A font loaded from a file (CSS or FontFace source `url(x.woff2)`); bare file names are only metadata.
  for (const f of html.matchAll(/url\(\s*["'`]?([^"'`()\s]+\.(?:woff2?|ttf|otf))["'`]?\s*\)/g)) {
    if (!f[1].startsWith('data:')) errors.push(`font file not inlined: ${f[1]}`);
  }
  if (fonts.bytes > FONT_BUDGET_BYTES) errors.push(`inlined fonts ${kb(fonts.bytes)} exceed ${kb(FONT_BUDGET_BYTES)}`);
  return { errors, warnings, fonts, links };
}

/** Write `build` into the sw.js BUILD line. Returns { text, changed, found }. Pure. */
export function injectBuildVersion(swText, build) {
  if (!SW_BUILD_RE.test(swText)) return { text: swText, changed: false, found: false };
  const text = swText.replace(SW_BUILD_RE, (_m, a, _old, c) => `${a}'${build}'${c}`);
  return { text, changed: text !== swText, found: true };
}

/** Build id: package version + the first 10 hex of sha256(index.html). Pure. */
export function buildId(version, html) {
  return `${version}-${createHash('sha256').update(html).digest('hex').slice(0, 10)}`;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...listFiles(p, base));
    else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else if (!existsSync(d)) copyFileSync(s, d);
  }
}

/**
 * Run every check on `dist`. Returns a report object; does not exit. `publicDir` is where missing extras come from;
 * `gzipBudget` overrides the 4 MB budget (tests).
 */
export function runPostbuild(dist, opts = {}) {
  const publicDir = opts.publicDir ?? join(root, 'public');
  const gzipBudget = opts.gzipBudget ?? GZIP_BUDGET_BYTES;
  const errors = [];
  const warnings = [];
  const notes = [];
  const indexPath = join(dist, 'index.html');
  if (!existsSync(indexPath)) {
    return { ok: false, errors: [`${indexPath} does not exist (did vite build run?)`], warnings, notes, sizes: null };
  }
  const htmlBuf = readFileSync(indexPath);
  const html = htmlBuf.toString('utf8');
  const a = analyzeHtml(html);
  errors.push(...a.errors);
  warnings.push(...a.warnings);

  // Extras: copy what is missing, verify the manifest and its icons.
  for (const f of EXTRA_FILES) {
    if (!existsSync(join(dist, f)) && existsSync(join(publicDir, f))) {
      copyFileSync(join(publicDir, f), join(dist, f));
      notes.push(`copied ${f} from public/`);
    }
  }
  for (const d of EXTRA_DIRS) {
    if (existsSync(join(publicDir, d))) copyDir(join(publicDir, d), join(dist, d));
  }
  const manifestPath = join(dist, 'manifest.webmanifest');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
      for (const k of ['start_url', 'scope']) {
        if (typeof m[k] === 'string' && !isRelativeUrl(m[k])) errors.push(`manifest ${k} "${m[k]}" is absolute`);
      }
      for (const icon of Array.isArray(m.icons) ? m.icons : []) {
        if (!isRelativeUrl(icon.src)) errors.push(`manifest icon "${icon.src}" is absolute`);
        else if (!existsSync(join(dist, icon.src))) errors.push(`manifest icon "${icon.src}" is missing from dist`);
      }
    } catch (err) {
      errors.push(`manifest.webmanifest does not parse: ${String(err)}`);
    }
  } else {
    warnings.push('manifest.webmanifest missing (install unavailable; the game still runs)');
  }
  for (const l of a.links) {
    if (/(^|\s)(icon|apple-touch-icon|manifest)(\s|$)/.test(l.rel) && isRelativeUrl(l.href) && !existsSync(join(dist, l.href))) {
      warnings.push(`<link rel="${l.rel}" href="${l.href}"> has no file beside index.html`);
    }
  }

  // Service worker build id.
  let build = null;
  const swPath = join(dist, 'sw.js');
  if (existsSync(swPath)) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    build = buildId(pkg.version ?? '0.0.0', htmlBuf);
    const r = injectBuildVersion(readFileSync(swPath, 'utf8'), build);
    if (!r.found) errors.push("sw.js has no `const BUILD = '...'; // dotkick-build` line: cannot version the cache");
    else if (r.changed) writeFileSync(swPath, r.text);
  } else {
    warnings.push('sw.js missing (offline play unavailable; the game still runs)');
  }

  // Nothing else may sit beside index.html.
  const files = listFiles(dist);
  for (const f of files) {
    if (f === 'index.html' || EXTRA_FILES.includes(f)) continue;
    if (EXTRA_DIRS.some((d) => f.startsWith(`${d}/`))) continue;
    errors.push(`unexpected file in dist: ${f} (everything must be inlined into index.html)`);
  }

  const sizes = sizesOf(htmlBuf);
  let total = 0;
  for (const f of files) total += statSync(join(dist, f)).size;
  if (sizes.gzip > gzipBudget) errors.push(`index.html gzip ${kb(sizes.gzip)} exceeds the ${kb(gzipBudget)} budget`);
  return { ok: errors.length === 0, errors, warnings, notes, sizes, totalBytes: total, files, fonts: a.fonts, build };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const distArg = args.find((x) => !x.startsWith('--'));
  const dist = resolve(distArg ?? join(root, 'dist'));
  const r = runPostbuild(dist);
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    if (r.sizes) {
      console.log(`postbuild: index.html ${kb(r.sizes.raw)} raw, ${kb(r.sizes.gzip)} gzip, ${kb(r.sizes.brotli)} brotli ` +
        `(budget ${kb(GZIP_BUDGET_BYTES)} gzip, ${((r.sizes.gzip / GZIP_BUDGET_BYTES) * 100).toFixed(1)} % used)`);
      console.log(`postbuild: fonts ${r.fonts.count} woff2 inlined, ${kb(r.fonts.bytes)}; dist total ${kb(r.totalBytes)} in ${r.files.length} files`);
      if (r.build) console.log(`postbuild: sw.js build ${r.build}`);
      for (const f of r.files) if (f !== 'index.html') console.log(`postbuild:   ${f} ${kb(statSync(join(dist, f)).size)}`);
    }
    for (const n of r.notes) console.log(`postbuild: note: ${n}`);
    for (const w of r.warnings) console.log(`postbuild: warning: ${w}`);
    for (const e of r.errors) console.error(`postbuild: FAIL ${e}`);
    console.log(r.ok ? 'postbuild: PASS' : 'postbuild: FAIL');
  }
  process.exit(r.ok ? 0 : 1);
}
