/**
 * [PLT-06] Docs guard: README.md, docs/ASSETS.md, docs/DEVICE_CHECKLIST.md and docs/DEPLOY.md.
 *
 * - every relative link resolves to a file in the repo, and every #anchor to a heading of the target file;
 * - every repo path quoted in inline code exists, and every `npm run <script>` is a package.json script;
 * - README has each BRIEF section 19 deliverable (local run, HTTPS for the iPad, two free hosting ways, Home Screen,
 *   controller pairing, touch + controller reference, troubleshooting) and the section 11 privacy note;
 * - the README controls tables repeat BRIEF sections 9 and 10 row for row, and its keyboard table agrees with
 *   docs/KEYBOARD.md;
 * - docs/ASSETS.md lists every shipped dependency (package.json dependencies and their production dependencies in
 *   package-lock.json) with the pinned version and the licence its package declares, and every dev dependency;
 * - the checklist's steps add up to 15 minutes, cover the six required checks and quote the real benchmark budgets;
 * - the GitHub Pages workflow in docs/DEPLOY.md builds with the same commands as package.json and deploys dist/;
 * - online-service addresses quoted in the docs match src/net/config.ts.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NET_CONFIG } from '../../src/net/config';
import { BENCH_BUDGETS } from '../../src/platform/benchHook';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

const DOCS = ['README.md', 'docs/ASSETS.md', 'docs/DEVICE_CHECKLIST.md', 'docs/DEPLOY.md'] as const;
/** Paths the docs tell the reader to create (they need not exist in the repo). */
const USER_CREATED = new Set(['.github/workflows/pages.yml']);

interface PackageJson {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}
interface LockPackage { version?: string; dev?: boolean; license?: string }
const pkg = JSON.parse(read('package.json')) as PackageJson;
const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, LockPackage> };

/** Markdown without fenced code blocks (links and headings inside fences do not count). */
function stripFences(md: string): string {
  return md.replace(/^```[\s\S]*?^```/gm, '');
}

/** GitHub's heading anchor: lower case, punctuation dropped (hyphens and underscores kept), spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');
}

function anchorsOf(md: string): Set<string> {
  const out = new Set<string>();
  for (const m of stripFences(md).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) out.add(slug(m[1]!));
  return out;
}

/** Markdown table rows (cells trimmed) of the lines between two headings. */
function tableRows(md: string): string[][] {
  const rows: string[][] = [];
  for (const line of md.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|[\s|:-]+\|$/.test(t)) continue;
    rows.push(t.slice(1, -1).split('|').map((c) => c.trim()));
  }
  return rows;
}

/** The text of a markdown section: from a heading line matching `start` to the next heading of the same or higher level. */
function section(md: string, start: RegExp): string {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => start.test(l));
  if (i < 0) throw new Error(`no heading ${start}`);
  const level = /^(#+)/.exec(lines[i]!)![1]!.length;
  let j = i + 1;
  while (j < lines.length && !(new RegExp(`^#{1,${level}}\\s`).test(lines[j]!))) j++;
  return lines.slice(i, j).join('\n');
}

const README = read('README.md');
const BRIEF = read('docs/BRIEF.md');

describe('PLT-06 docs: files, links and paths', () => {
  it('PLT-06 the four owned docs exist and are not empty', () => {
    for (const f of DOCS) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(read(f).length, f).toBeGreaterThan(1000);
    }
  });

  it('PLT-06 every relative link resolves to a file, and every #anchor to a heading', () => {
    const problems: string[] = [];
    for (const f of DOCS) {
      const md = stripFences(read(f));
      for (const m of md.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto:
        const [path, anchor] = target.split('#') as [string, string | undefined];
        const file = path === '' ? f : normalize(join(dirname(f), path));
        if (!existsSync(join(root, file))) {
          problems.push(`${f}: missing ${target}`);
          continue;
        }
        if (anchor !== undefined && file.endsWith('.md') && !anchorsOf(read(file)).has(anchor)) {
          problems.push(`${f}: no heading #${anchor} in ${file}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('PLT-06 every repo path quoted in inline code exists', () => {
    const problems: string[] = [];
    const pathLike = /^(?:\.github|src|tools|tests|docs|public)\/[\w./-]+$|^[\w.-]+\.(?:json|ts|mjs|md)$/;
    for (const f of DOCS) {
      for (const m of stripFences(read(f)).matchAll(/`([^`\s]+)`/g)) {
        const p = m[1]!.replace(/[.,;:]$/, '');
        if (!pathLike.test(p) || p.includes('*') || USER_CREATED.has(p)) continue;
        if (!existsSync(join(root, p))) problems.push(`${f}: ${p}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('PLT-06 every npm command in the docs is a package.json script', () => {
    const builtin = new Set(['install', 'ci', 'test']);
    const problems: string[] = [];
    for (const f of DOCS) {
      for (const m of read(f).matchAll(/\bnpm (run )?([a-z][\w:-]*)/g)) {
        const name = m[2]!;
        if (m[1] === undefined && builtin.has(name)) continue;
        if (m[1] === undefined) continue; // prose such as "npm may print"
        if (!(name in pkg.scripts)) problems.push(`${f}: npm run ${name}`);
      }
    }
    expect(problems).toEqual([]);
    // The README lists every script a developer needs.
    for (const s of ['dev', 'build', 'preview', 'verify', 'soak', 'fuzz', 'bench']) {
      expect(README, s).toContain(`npm run ${s}`);
    }
  });
});

describe('PLT-06 README covers the BRIEF section 19 deliverables', () => {
  it('PLT-06 README has every required part', () => {
    const anchors = anchorsOf(README);
    for (const a of [
      '2-run-it-on-your-computer',
      '3-open-your-own-build-on-the-ipad-https',
      'way-1-drag-and-drop-to-a-static-host',
      'way-2-github-pages-builds-itself-on-every-change',
      '5-add-it-to-the-home-screen-and-play-offline',
      '6-pair-a-controller',
      '7-play-a-friend',
      'on-the-same-ipad',
      'online-with-a-room-code',
      'touch',
      'controller',
      'keyboard-computer',
      '9-troubleshooting',
      '10-privacy',
    ]) {
      expect(anchors.has(a), a).toBe(true);
    }
    for (const phrase of [
      'npm install', 'npm run dev', 'mkcert', 'Netlify Drop', 'Cloudflare Pages', 'Settings > Pages', 'GitHub Actions',
      'Add to Home Screen', 'Settings > Bluetooth', 'press any button', 'Low Power Mode', 'Settings > Battery',
    ]) {
      expect(README, phrase).toContain(phrase);
    }
  });

  it('PLT-06 README has the section 11 privacy note about IP addresses', () => {
    const privacy = section(README, /^## 10\. Privacy/);
    expect(privacy).toMatch(/shows each player's IP address to the other/);
    expect(privacy).toMatch(/only with people\s+you know/);
    expect(privacy).toMatch(/No accounts, ads, analytics or tracking/);
  });

  it('PLT-06 troubleshooting covers low power, silent audio, controller detection and online errors', () => {
    const t = section(README, /^## 9\. Troubleshooting/);
    expect(t).toMatch(/Low Power Mode/);
    expect(t).toMatch(/no sound/i);
    expect(t).toMatch(/controller is not detected/i);
    expect(t).toMatch(/only after a button press/);
    for (const msg of ['cannot be reached', 'not found', 'full', 'Version mismatch', 'blocked']) expect(t).toContain(msg);
  });
});

describe('PLT-06 controls reference matches the brief and docs/KEYBOARD.md', () => {
  /** Rows keyed by their first two cells (situation tables) or first cell. */
  function rowsByKey(md: string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const r of tableRows(md)) m.set(r.join(' | '), r);
    return m;
  }
  const readmeRows = rowsByKey(stripFences(README));

  it('PLT-06 every controller table row of BRIEF section 10 is in the README verbatim', () => {
    const sec10 = section(BRIEF, /^## 10\. Controller controls/);
    const rows = tableRows(sec10).filter((r) => r[0] !== 'Action' && r[0] !== 'Situation');
    expect(rows.length).toBeGreaterThan(60);
    const missing = rows.map((r) => r.join(' | ')).filter((k) => !readmeRows.has(k));
    expect(missing).toEqual([]);
  });

  it('PLT-06 the touch tables of BRIEF section 9 are in the README (large buttons keep their cells)', () => {
    const sec9 = section(BRIEF, /^## 9\. Touch controls/);
    const rows = tableRows(sec9).filter((r) => r[0] !== 'Button' && r[0] !== 'Gesture');
    expect(rows.length).toBeGreaterThan(20);
    const readmeTouch = tableRows(stripFences(section(README, /^### Touch/)));
    const missing: string[] = [];
    for (const r of rows) {
      // The large buttons are labelled as on screen (SPRINT / TACKLE); compare their remaining cells.
      const large = r[0]!.startsWith('SPRINT &');
      const hit = readmeTouch.some((x) =>
        large ? x.length === r.length && x.slice(1).join('|') === r.slice(1).join('|') : x.join('|') === r.join('|'));
      if (!hit) missing.push(r.join(' | '));
    }
    expect(missing).toEqual([]);
  });

  it('PLT-06 the README keyboard table agrees with docs/KEYBOARD.md', () => {
    const kb = tableRows(section(read('docs/KEYBOARD.md'), /^## In a match/));
    const kbPad = new Map(kb.map((r) => [r[0]!, r[1]!]));
    const readmeKb = tableRows(section(README, /^### Keyboard/));
    let compared = 0;
    for (const r of readmeKb) {
      const pad = kbPad.get(r[0]!);
      if (pad === undefined || pad === '(skip)' || r[0] === 'Key') continue;
      expect(r[1]!.toLowerCase(), r[0]).toBe(pad.toLowerCase());
      compared++;
    }
    expect(compared).toBeGreaterThanOrEqual(8);
    for (const key of ['J', 'K', 'U', 'I', 'Q', 'E', 'C']) expect(kbPad.has(key), key).toBe(true);
  });
});

describe('PLT-06 docs/ASSETS.md credits every shipped source', () => {
  const assets = read('docs/ASSETS.md');
  const assetRows = tableRows(stripFences(assets)).map((r) => r.join(' | '));

  /** Production packages: the dependencies and everything they pull in (package-lock entries not marked dev). */
  function productionPackages(): { name: string; version: string; license: string }[] {
    const out: { name: string; version: string; license: string }[] = [];
    for (const [key, p] of Object.entries(lock.packages)) {
      if (key === '' || p.dev === true || !key.startsWith('node_modules/')) continue;
      const name = key.slice('node_modules/'.length);
      if (name.includes('/node_modules/')) continue;
      const manifest = JSON.parse(read(`node_modules/${name}/package.json`)) as { version: string; license: string };
      out.push({ name, version: manifest.version, license: manifest.license });
    }
    return out;
  }

  it('PLT-06 every runtime dependency and its production dependencies is listed with version and licence', () => {
    const prod = productionPackages();
    for (const name of Object.keys(pkg.dependencies)) expect(prod.some((p) => p.name === name), name).toBe(true);
    expect(prod.length).toBeGreaterThanOrEqual(Object.keys(pkg.dependencies).length);
    const problems: string[] = [];
    for (const p of prod) {
      const row = assetRows.find((r) => r.includes(p.name) && r.includes(p.version));
      if (!row) problems.push(`${p.name} ${p.version}: no row`);
      else if (!row.includes(p.license)) problems.push(`${p.name}: licence ${p.license} not in "${row}"`);
    }
    expect(problems).toEqual([]);
  });

  it('PLT-06 the pinned versions in package.json are the versions credited', () => {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      expect(range, `${name} must be pinned`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(assetRows.some((r) => r.includes(name) && r.includes(range)), name).toBe(true);
    }
  });

  it('PLT-06 every dev dependency is listed as a build tool with its version', () => {
    const missing: string[] = [];
    for (const [name, version] of Object.entries(pkg.devDependencies)) {
      const ok = assetRows.some((r) => r.toLowerCase().includes(name.toLowerCase()) && r.includes(version));
      if (!ok) missing.push(`${name} ${version}`);
    }
    expect(missing).toEqual([]);
  });

  it('PLT-06 the two fonts, Three.js and PeerJS carry the licences named in BRIEF section 2', () => {
    const row = (needle: string): string => assetRows.find((r) => r.startsWith(needle)) ?? '';
    expect(row('Space Grotesk')).toContain('OFL-1.1');
    expect(row('JetBrains Mono')).toContain('OFL-1.1');
    expect(row('three.js')).toContain('MIT');
    expect(row('PeerJS')).toContain('MIT');
    // Licence texts are reproduced (MIT and BSD notices must travel with the software).
    expect(assets).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(assets).toContain('Copyright © 2010-2026 three.js authors');
    expect(assets).toContain('Redistributions in binary form must reproduce the above copyright');
  });
});

describe('PLT-06 docs/DEVICE_CHECKLIST.md', () => {
  const checklist = read('docs/DEVICE_CHECKLIST.md');

  it('PLT-06 the numbered steps take 15 minutes in total and cover the six required checks', () => {
    const steps = [...checklist.matchAll(/^## (\d+)\. (.+?) \((\d+) minutes?/gm)];
    const total = steps.reduce((sum, m) => sum + Number(m[3]), 0);
    expect(total).toBe(15);
    const titles = steps.map((m) => m[2]!.toLowerCase()).join(' / ');
    for (const need of ['benchmark', 'five-finger', 'multitasking swipe', 'sprint', 'controller', 'disconnect', 'offline', 'online match']) {
      expect(titles, need).toContain(need);
    }
  });

  it('PLT-06 the benchmark pass line quotes the real BENCH_BUDGETS', () => {
    const bench = section(checklist, /^## 2\. Benchmark/);
    expect(bench).toContain(`average ${BENCH_BUDGETS.avgFps} fps`);
    expect(bench).toContain(`1 % low ${BENCH_BUDGETS.low1Fps} fps`);
    expect(bench).toContain(`longest frame ${BENCH_BUDGETS.longestFrameMs} ms`);
    expect(bench).toContain(`sim ${BENCH_BUDGETS.simMsAvg} ms average and ${BENCH_BUDGETS.simMsMax} ms worst`);
    expect(bench).toContain(`${BENCH_BUDGETS.drawCalls} draw calls`);
    expect(bench).toContain(`${BENCH_BUDGETS.triangles.toLocaleString('en-US')} triangles`);
    expect(bench).toContain('Copy Results');
  });

  it('PLT-06 the checklist has a results sheet to paste back', () => {
    expect(checklist).toMatch(/## Results sheet/);
    expect(checklist).toMatch(/Benchmark result:/);
  });
});

describe('PLT-06 docs/DEPLOY.md GitHub Pages workflow', () => {
  const deploy = read('docs/DEPLOY.md');
  const yaml = /```yaml\n([\s\S]*?)```/.exec(deploy)?.[1] ?? '';

  it('PLT-06 the workflow installs with npm ci, builds with npm run build and deploys dist/', () => {
    expect(yaml.length).toBeGreaterThan(200);
    expect(yaml).not.toMatch(/\t/);
    expect(yaml).toMatch(/^name: Deploy to GitHub Pages$/m);
    expect(yaml).toMatch(/^\s+run: npm ci$/m);
    expect(yaml).toMatch(/^\s+run: npm run build$/m);
    expect(pkg.scripts.build).toContain('vite build');
    expect(pkg.scripts.build).toContain('tools/postbuild.mjs');
    expect(yaml).toMatch(/uses: actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: dist$/m);
    expect(yaml).toMatch(/uses: actions\/deploy-pages@v\d+/);
    expect(yaml).toMatch(/pages: write/);
    expect(yaml).toMatch(/id-token: write/);
    expect(yaml).toMatch(/workflow_dispatch:/);
    expect(yaml).toMatch(/name: github-pages/);
  });

  it('PLT-06 the workflow Node version satisfies the engines of the pinned Vite', () => {
    const node = /node-version: (\d+)/.exec(yaml)?.[1];
    expect(node).toBeDefined();
    const vite = JSON.parse(read('node_modules/vite/package.json')) as { engines: { node: string } };
    // "^20.19.0 || >=22.12.0": a bare major 22 resolves to the newest 22.x.
    expect(vite.engines.node).toMatch(new RegExp(`>=\\s*${node}\\.|\\^${node}\\.`));
  });

  it('PLT-06 the online services quoted in the docs match src/net/config.ts', () => {
    expect(NET_CONFIG.host).toBe('0.peerjs.com');
    expect(deploy).toContain(`\`${NET_CONFIG.host}\``);
    expect(deploy).toContain(`port ${NET_CONFIG.port}`);
    expect(read('docs/ASSETS.md')).toContain(`\`${NET_CONFIG.host}\` (port ${NET_CONFIG.port})`);
  });
});

/**
 * [SGN-06] Docs audit guards: the README online flow names the real online-screen buttons and the real pause / rejoin
 * numbers; docs/CONTRACTS.md covers every contract file and cites only recorded decisions; docs/ARCHITECTURE.md lists
 * every stage of the tick pipeline; docs/TUNING.md indexes every tuning block; docs/OWNERSHIP.md names every source
 * file (directly, through a brace list, or through a folder or resolve*.ts glob).
 */
describe('SGN-06 docs match the code', () => {
  const online = read('src/ui/screens/online.ts');
  const friend = section(README, /^## 7\. Play a friend/);

  it('SGN-06 README "Play a friend" uses the online screen labels and the T_NET pause and rejoin numbers', async () => {
    for (const label of ['Create room', 'Join room', 'Copy link', 'Share…', 'Your club', 'Ready', 'Rejoin match',
      'Finish against CPU', 'End match']) {
      expect(online, `online.ts has ${label}`).toMatch(new RegExp(`['\`]${label}`));
      expect(friend, label).toContain(label);
    }
    for (const label of ['Same iPad', 'Online']) expect(read('src/ui/screens/modeSetup.ts')).toContain(`'${label}'`);
    const { T_NET } = await import('../../src/contracts/tuning');
    const { ROOM_CODE_LENGTH } = await import('../../src/net/roomCode');
    expect(friend).toContain(`**${T_NET.pausesPerPlayer} pauses**`);
    expect(friend).toContain(`**${T_NET.pauseMaxMs / 1000} seconds**`);
    expect(friend).toContain(`**${T_NET.rejoinWaitMs / 1000} seconds**`);
    expect(friend).toContain(`${ROOM_CODE_LENGTH}-character code`);
    expect(read('docs/DEVICE_CHECKLIST.md')).toContain('**Create room**');
  });

  it('SGN-06 docs/CONTRACTS.md describes every contract file and cites only decisions in docs/DECISIONS.md', () => {
    const contracts = read('docs/CONTRACTS.md');
    const files = readdirSync(join(root, 'src/contracts')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(14);
    for (const f of files) expect(contracts, f).toMatch(new RegExp(`^\\| \`${f.replace('.', '\\.')}\` \\|`, 'm'));
    const decisions = new Set([...read('docs/DECISIONS.md').matchAll(/^\| (D-\d{3}) \|/gm)].map((m) => m[1]!));
    const cited = [...contracts.matchAll(/\bD-\d{3}\b/g)].map((m) => m[0]);
    expect(cited.length).toBeGreaterThan(5);
    for (const d of cited) expect(decisions.has(d), d).toBe(true);
    // Every decision that names a contract member is cited.
    for (const d of ['D-012', 'D-013', 'D-019', 'D-021']) expect(cited, d).toContain(d);
  });

  it('SGN-06 docs/ARCHITECTURE.md lists every stage that src/sim/step.ts calls', () => {
    const arch = read('docs/ARCHITECTURE.md');
    const step = read('src/sim/step.ts');
    const body = step.slice(step.indexOf('export function step('));
    const stages = [...body.matchAll(/^\s+([a-z][A-Za-z]+Tick|cpuThink|resolveControllers)\(s, /gm)].map((m) => m[1]!);
    expect(stages.length).toBeGreaterThanOrEqual(11);
    for (const st of stages) expect(arch, st).toMatch(new RegExp(`\\| \\d+ \\| \`${st}\` \\|`));
  });

  it('SGN-06 docs/TUNING.md names every block exported by src/contracts/tuning.ts', () => {
    const tuningDoc = read('docs/TUNING.md');
    const blocks = [...read('src/contracts/tuning.ts').matchAll(/^export const (T_[A-Z0-9_]+)\b/gm)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(90);
    expect(tuningDoc).toContain(`${blocks.length} exported blocks`);
    const missing = blocks.filter((b) => !tuningDoc.includes(`\`${b}\``));
    expect(missing).toEqual([]);
  });

  it('SGN-06 docs/OWNERSHIP.md names an owner for every source file', () => {
    // The Wave 0 stub rows (FND-04 / FND-05 created every stub under src/ui, src/render, ...) do not count as owners.
    const own = read('docs/OWNERSHIP.md').split('\n').filter((l) => !/^\| FND-0[45] \|/.test(l)).join('\n');
    const listed = (rel: string): boolean => {
      if (own.includes(`\`${rel}\``)) return true;
      const dir = rel.slice(0, rel.lastIndexOf('/'));
      const base = rel.slice(rel.lastIndexOf('/') + 1);
      // Folder globs (`src/app/**`), brace lists (`src/sim/core/{rng,dmath}.ts`), prefix globs (`resolve*.ts`) and
      // files named after their folder's first entry in a table row (`lobHooks.ts` next to `src/sim/kicks/passHooks.ts`).
      for (let d = dir; d.includes('/'); d = d.slice(0, d.lastIndexOf('/'))) if (own.includes(`\`${d}/**\``)) return true;
      for (const m of own.matchAll(/`([\w/.-]+)\/\{([\w,]+)\}\.(\w+)`/g)) {
        if (m[1] === dir && m[2]!.split(',').some((n) => `${n}.${m[3]}` === base)) return true;
      }
      for (const m of own.matchAll(/`([\w/.-]+)\/(\w+)\*\.(\w+)`/g)) {
        if (m[1] === dir && base.startsWith(m[2]!) && base.endsWith(`.${m[3]}`)) return true;
      }
      return own.split('\n').some((line) => line.includes(`\`${dir}/`) && line.includes(`\`${base}\``));
    };
    const walk = (rel: string): string[] => readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(`${rel}/${e.name}`) : [`${rel}/${e.name}`]);
    const unlisted = walk('src').filter((f) => !f.startsWith('src/contracts/') && f !== 'src/env.d.ts' && !listed(f));
    expect(unlisted).toEqual([]);
  });
});
