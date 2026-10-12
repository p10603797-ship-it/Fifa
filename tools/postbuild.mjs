/* global console, process, URL */
/**
 * [FND-06 baseline; PLT-04 extends] Post-build check for `npm run build`: dist/index.html must exist; report its raw
 * and gzip sizes and fail if the gzip size exceeds the 4 MB budget (brief section 3). Copies nothing.
 *
 *   node tools/postbuild.mjs [distDir]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const GZIP_BUDGET_BYTES = 4 * 1024 * 1024;

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = resolve(process.argv[2] ?? join(root, 'dist'));
const indexPath = join(dist, 'index.html');

function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

if (!existsSync(indexPath)) {
  console.error(`postbuild: FAIL ${indexPath} does not exist (did vite build run?)`);
  process.exit(1);
}

const html = readFileSync(indexPath);
const gz = gzipSync(html, { level: 9 });
console.log(`postbuild: dist/index.html ${kb(html.length)} raw, ${kb(gz.length)} gzip (budget ${kb(GZIP_BUDGET_BYTES)} gzip)`);
for (const name of readdirSync(dist)) {
  if (name === 'index.html') continue;
  const p = join(dist, name);
  const st = statSync(p);
  if (st.isFile()) console.log(`postbuild:   ${name} ${kb(st.size)}`);
}
if (gz.length > GZIP_BUDGET_BYTES) {
  console.error(`postbuild: FAIL gzip size ${kb(gz.length)} exceeds the ${kb(GZIP_BUDGET_BYTES)} budget`);
  process.exit(1);
}
console.log('postbuild: PASS');
