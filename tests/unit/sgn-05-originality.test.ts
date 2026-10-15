/**
 * [SGN-05] Originality and licence audit (BRIEF section 2, section 15, definition of done 9). Static guards for the six
 * audit items; the runtime network proof is tests/e2e/sgn-05-network.spec.ts.
 *
 * 1. Names: every shipped player passes the strict screen plus the late list (screenShippedName); the late hits are
 *    exactly the PLAYER_NAME_FIXES and every replacement is screened and unique; clubs, cities and codes pass the
 *    broadened club screen; the screen lists are broad (legends, current, managers, women's football).
 * 2. Visuals: crests are plain geometry (no text, images or links); no image, model, font or audio file outside the
 *    generated icons; fonts come only from the two OFL @fontsource packages; board brands are invented words.
 * 3. Audio: nothing is loaded or decoded (no samples); the only note sequences are short original stings.
 * 4. Dependencies: every shipped package has a permissive licence and a notice in dist (NOTICE_PACKAGES) and a row
 *    in docs/ASSETS.md; src imports only shipped packages (dev-only packages, peer included, never reach the bundle).
 * 5. Network: src uses no tracker or beacon, the only fetch is the same-origin service-worker probe, PeerJS is loaded
 *    only by src/net/transport.ts (dynamic import), the broker / STUN / TURN hosts live only in src/net/config.ts.
 * 6. Text: in-game strings, the manifest and the docs never name FIFA / EA / a league as ours or claim affiliation,
 *    and no club or title imitates the "EA SPORTS FC" brand.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLUBS } from '../../src/data/clubs';
import {
  CLUB_NICKNAMES, EMBLEM_WORDS, PLACE_HEADS, clubDenylistSizes, isCodeAllowed, screenClubName,
} from '../../src/data/names';
import {
  FAMOUS_MONONYMS, FAMOUS_PLAYERS, ICONIC_SURNAMES, LATE_FAMOUS_PLAYERS, PLAYER_NAME_FIXES, applyPlayerNameFixes,
  denylistSize, nameKey, screenName, screenShippedName,
} from '../../src/data/screen';
import { crestSvg } from '../../src/render/kit/crest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(root, p).split('\\').join('/');
const SRC_FILES = walk(join(root, 'src')).filter((p) => p.endsWith('.ts'));
const srcText = (p: string): string => readFileSync(p, 'utf8');

const players = CLUBS.flatMap((c) => c.squad.map((p, i) => ({ club: c.id, index: i, name: p.name, short: p.short })));

// --------------------------------------------------------------------------------------------- 1. names

describe('SGN-05 item 1: names', () => {
  it('the famous-player screen is broad: legends, current stars, managers who played, women\'s football', () => {
    expect(FAMOUS_PLAYERS.length).toBeGreaterThanOrEqual(1500);
    expect(denylistSize()).toBe(FAMOUS_PLAYERS.length);
    expect(FAMOUS_MONONYMS.length).toBeGreaterThanOrEqual(80);
    expect(ICONIC_SURNAMES.length).toBeGreaterThanOrEqual(120);
    for (const [f, l] of [
      ['Raymond', 'Kopa'], ['Geoff', 'Hurst'], ['Gigi', 'Riva'], ['Carlo', 'Ancelotti'], ['Jose', 'Mourinho'],
      ['Mia', 'Hamm'], ['Alexia', 'Putellas'], ['Sam', 'Kerr'], ['Homare', 'Sawa'], ['Lamine', 'Yamal'], ['Cole', 'Palmer'],
    ] as const) expect(screenName(f, l, true), `${f} ${l}`).not.toBeNull();
    for (const m of ['Marta', 'Formiga', 'Garrincha', 'Dunga', 'Pedri']) expect(screenName('Arno', m, true), m).not.toBeNull();
  });

  it('no shipped player shares a famous footballer\'s name or surname (strict screen + late list), glitch "O. Capello"', () => {
    const hits = players.map((p) => ({ ...p, hit: screenShippedName(p.name.charAt(0), p.short) })).filter((p) => p.hit !== null);
    expect(hits.map((p) => `${p.name} (club ${p.club}): ${p.hit!.reason} ${p.hit!.match}`),
      'apply SGN-05 CR 1 (tools/gen-data.ts applyPlayerNameFixes) and run `npm run gen:data`').toEqual([]);
  });

  it('the late list catches what it must, and only the committed names PLAYER_NAME_FIXES replaces', () => {
    expect(screenShippedName('O', 'Capello')?.reason).toBe('iconic');
    expect(screenShippedName('Z', 'Capelo')?.reason).toBe('near-iconic');
    expect(screenShippedName('G', 'Šašić')?.reason).toBe('famous-surname');
    expect(screenShippedName('Fabio', 'Capello')).not.toBeNull();
    // The generator's own screen does not see them (a redraw would re-roll the rest of the squad's attributes).
    expect(screenName('Olaku', 'Capello', true)).toBeNull();
    expect(screenName('Gotko', 'Sašić', true)).toBeNull();
    expect(LATE_FAMOUS_PLAYERS.length).toBe(3); // + Willie Thornton (second pass, sgn-05-second-pass.test.ts)
    const fromKeys = new Set(PLAYER_NAME_FIXES.map((f) => `${f.club}:${f.from}`));
    for (const p of players) {
      if (screenShippedName(p.name.charAt(0), p.short) !== null) expect(fromKeys.has(`${p.club}:${p.name}`), p.name).toBe(true);
    }
  });

  it('every PLAYER_NAME_FIXES replacement is screened, unique in the league and in its squad, same initial', () => {
    const keys = new Map<string, number>();
    for (const p of players) keys.set(nameKey(p.name), (keys.get(nameKey(p.name)) ?? 0) + 1);
    for (const f of PLAYER_NAME_FIXES) {
      const club = CLUBS[f.club]!;
      const at = club.squad.findIndex((p) => p.name === f.from || p.name === f.to);
      expect(at, `${f.from} / ${f.to} in club ${f.club}`).toBeGreaterThanOrEqual(0);
      expect(f.to.charAt(0)).toBe(f.from.charAt(0));
      const short = f.to.slice(f.to.indexOf('. ') + 2);
      expect(screenShippedName(f.to.charAt(0), short), f.to).toBeNull();
      const shippedAsTo = club.squad[at]!.name === f.to ? 1 : 0;
      expect((keys.get(nameKey(f.to)) ?? 0) - shippedAsTo, `${f.to} unique in the league`).toBe(0);
      for (let i = 0; i < club.squad.length; i++) {
        if (i !== at) expect(nameKey(club.squad[i]!.short), `${f.to} surname unique in ${club.name}`).not.toBe(nameKey(short));
      }
    }
  });

  it('applyPlayerNameFixes changes the two names and nothing else', () => {
    for (const f of PLAYER_NAME_FIXES) {
      const squad = CLUBS[f.club]!.squad.map((p) => ({ ...p }));
      const at = squad.findIndex((p) => p.name === f.from || p.name === f.to);
      squad[at]!.name = f.from;
      squad[at]!.short = f.from.slice(f.from.indexOf('. ') + 2);
      const before = JSON.parse(JSON.stringify(squad)) as typeof squad;
      expect(applyPlayerNameFixes(f.club, squad)).toBe(1);
      expect(applyPlayerNameFixes(f.club + 1, squad.map((p) => ({ ...p })))).toBe(0);
      expect(squad[at]!.name).toBe(f.to);
      expect(squad[at]!.short).toBe(f.to.slice(f.to.indexOf('. ') + 2));
      for (let i = 0; i < squad.length; i++) {
        const { name: n1, short: s1, ...rest1 } = squad[i]!;
        const { name: n0, short: s0, ...rest0 } = before[i]!;
        expect(rest1, `${f.club}:${i}`).toEqual(rest0);
        if (i !== at) expect([n1, s1]).toEqual([n0, s0]);
      }
    }
  });

  it('clubs, cities and codes pass the broadened club screen (real clubs, towns, stadiums, nicknames, codes)', () => {
    const sizes = clubDenylistSizes();
    expect(sizes.names).toBeGreaterThanOrEqual(700);
    expect(sizes.tokens).toBeGreaterThanOrEqual(800);
    expect(sizes.nicknames).toBeGreaterThanOrEqual(350);
    expect(CLUBS.length).toBe(20);
    expect(new Set(CLUBS.map((c) => c.code)).size).toBe(20);
    for (const c of CLUBS) {
      expect(screenClubName(c.name, c.city), c.name).toBeNull();
      expect(isCodeAllowed(c.code), c.code).toBe(true);
    }
    for (const [n, city] of [['Melchester Rovers', 'Melchester'], ['Harchester United', 'Harchester'], ['Castellon City', 'Castellon'],
      ['Ironbridge Town', 'Elland']] as const) expect(screenClubName(n, city), n).not.toBeNull();
  });

  it('no club, city, word list or board brand names a competition, governing body, game brand or sponsor', () => {
    const banned = [
      'fifa', 'uefa', 'conmebol', 'concacaf', 'premier', 'champions', 'laliga', 'liga', 'serie', 'bundesliga', 'ligue',
      'eredivisie', 'libertadores', 'sudamericana', 'mls', 'copa', 'eafc', 'easports', 'ultimate', 'konami', 'efootball',
      'nike', 'adidas', 'puma', 'umbro', 'kappa', 'hummel', 'macron', 'joma', 'emirates', 'etihad', 'qatar', 'rakuten',
      'spotify', 'heineken', 'budweiser', 'cocacola', 'pepsi', 'mastercard', 'visa', 'santander', 'playstation', 'xbox',
      'nintendo', 'sky', 'bt', 'dazn', 'espn', 'bein', 'canal', 'telemundo',
    ];
    const stadium = read('src/render/stadium.ts');
    const brands = /BOARD_BRANDS: readonly string\[\] = Object\.freeze\(\[([^\]]*)\]/.exec(stadium)![1]!.match(/'[A-Z]+'/g)!.map((s) => s.slice(1, -1));
    expect(brands.length).toBeGreaterThanOrEqual(6);
    const words = [
      ...CLUBS.flatMap((c) => [...c.name.split(' '), ...c.city.split(' ')]), ...brands, ...PLACE_HEADS, ...EMBLEM_WORDS,
      ...CLUB_NICKNAMES,
    ].map(nameKey).filter((w) => w.length > 0 && w !== 'fc' && w !== 'afc');
    for (const w of words) {
      for (const b of banned) {
        const hit = b.length <= 3 ? w === b : w === b || w.includes(b);
        expect(hit, `${w} ~ ${b}`).toBe(false);
      }
    }
  });
});

// --------------------------------------------------------------------------------------------- 2. visuals

const MEDIA_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.glb', '.gltf', '.fbx', '.obj', '.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.mid',
  '.mp4', '.webm']);

describe('SGN-05 item 2: visuals', () => {
  it('crests are plain geometry: no text, images, links or fonts in the SVG', () => {
    for (const c of CLUBS) {
      const svg = crestSvg(c.crest, 64);
      expect(svg, c.name).toMatch(/^<svg[\s>]/);
      expect(svg, c.name).not.toMatch(/<(text|image|use|foreignObject|font|style|script|a)\b|href|url\(/i);
      const tags = new Set([...svg.matchAll(/<([a-zA-Z]+)/g)].map((m) => m[1]!.toLowerCase()));
      for (const t of tags) expect(['svg', 'path', 'g', 'polygon', 'circle', 'rect', 'title'], `${c.name} <${t}>`).toContain(t);
    }
  });

  it('no image, model, font or sound file in the repo except the generated app icons', () => {
    const files = [...walk(join(root, 'src')), ...walk(join(root, 'public')), join(root, 'index.html')].filter((p) => existsSync(p));
    const media = files.filter((p) => MEDIA_EXT.has(extname(p).toLowerCase())).map(rel);
    expect(media.every((p) => /^public\/icons\/[a-z0-9-]+\.png$/.test(p)), media.join(', ')).toBe(true);
    expect(read('tools/gen-icons.mjs')).toMatch(/png|PNG/);
    for (const p of SRC_FILES) expect(srcText(p), rel(p)).not.toMatch(/data:(audio|video|font|image\/(png|jpe?g|gif|webp));base64/);
  });

  it('fonts come only from the two OFL @fontsource packages (Latin subsets), never from a URL', () => {
    const imports = SRC_FILES.flatMap((p) => [...srcText(p).matchAll(/from\s+'([^']*\.(?:woff2?|ttf|otf)(?:\?url)?)'/g)].map((m) => m[1]!));
    expect(imports.length).toBeGreaterThanOrEqual(5);
    for (const i of imports) expect(i).toMatch(/^@fontsource\/(space-grotesk|jetbrains-mono)\/files\/[a-z-]+-latin-\d{3}-normal\.woff2\?url$/);
    for (const p of [...SRC_FILES, join(root, 'index.html')]) {
      expect(srcText(p), rel(p)).not.toMatch(/@import\s+url\(\s*['"]?https?:|<link[^>]+fonts\.googleapis/i);
    }
    for (const pkg of ['@fontsource/space-grotesk', '@fontsource/jetbrains-mono']) {
      expect((JSON.parse(read(`node_modules/${pkg}/package.json`)) as { license: string }).license).toBe('OFL-1.1');
    }
  });
});

// --------------------------------------------------------------------------------------------- 3. audio

describe('SGN-05 item 3: audio', () => {
  const audio = SRC_FILES.filter((p) => rel(p).startsWith('src/audio/'));

  it('everything is synthesised: no file, sample or stream is loaded or decoded', () => {
    expect(audio.length).toBeGreaterThanOrEqual(5);
    for (const p of SRC_FILES) {
      const t = srcText(p);
      expect(t, rel(p)).not.toMatch(/decodeAudioData|new Audio\(|HTMLAudioElement|createMediaElementSource|createMediaStreamSource|getUserMedia/);
      expect(t, rel(p)).not.toMatch(/['"`][^'"`]*\.(mp3|wav|ogg|m4a|aac|flac|opus|mid)['"`]/i);
    }
    for (const p of audio) expect(srcText(p), rel(p)).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(/);
  });

  it('the only note sequences are short original stings (four notes at most), no chant or anthem', () => {
    const seqs: string[] = [];
    for (const p of audio) {
      for (const m of srcText(p).matchAll(/notes:\s*\[((?:\[[^\]]*\],?\s*)+)\]/g)) seqs.push(m[1]!);
      for (const m of srcText(p).matchAll(/^\s*\[((?:\[[\d.,\s]+\],?\s*){2,})\],/gm)) seqs.push(m[1]!);
    }
    expect(seqs.length).toBeGreaterThanOrEqual(5);
    for (const s of seqs) expect((s.match(/\[/g) ?? []).length, s).toBeLessThanOrEqual(4);
    for (const p of audio) expect(srcText(p).toLowerCase(), rel(p)).not.toMatch(/anthem|walk alone|seven nation|chant melody|olé|ole ole/);
  });
});

// --------------------------------------------------------------------------------------------- 4. dependencies

interface PackageJson { dependencies: Record<string, string>; devDependencies: Record<string, string> }
interface LockPackage { version?: string; dev?: boolean; license?: string }

describe('SGN-05 item 4: dependencies and licences', () => {
  const pkg = JSON.parse(read('package.json')) as PackageJson;
  const lock = JSON.parse(read('package-lock.json')) as { packages: Record<string, LockPackage> };
  const shipped = Object.entries(lock.packages)
    .filter(([k, v]) => k.startsWith('node_modules/') && !v.dev)
    .map(([k, v]) => ({ name: k.slice('node_modules/'.length), version: v.version ?? '', license: v.license ?? '' }));
  const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'OFL-1.1', '0BSD', 'CC0-1.0', 'Zlib']);

  it('every shipped package has a permissive licence (no GPL, LGPL, AGPL, MPL, EPL, CDDL, SSPL)', () => {
    expect(shipped.map((s) => s.name).sort()).toEqual(['@fontsource/jetbrains-mono', '@fontsource/space-grotesk', '@msgpack/msgpack',
      'eventemitter3', 'peerjs', 'peerjs-js-binarypack', 'sdp', 'three', 'webrtc-adapter']);
    for (const s of shipped) {
      const declared = (JSON.parse(read(`node_modules/${s.name}/package.json`)) as { license: string; version: string });
      expect(declared.version, s.name).toBe(s.version);
      expect(PERMISSIVE.has(declared.license), `${s.name}: ${declared.license}`).toBe(true);
    }
  });

  it('every shipped package has its licence text in dist (NOTICE_PACKAGES) and a row in docs/ASSETS.md', async () => {
    const postbuild = (await import(/* @vite-ignore */ new URL('../../tools/postbuild.mjs', import.meta.url).href)) as { NOTICE_PACKAGES: { pkg: string }[] };
    const notices = new Set(postbuild.NOTICE_PACKAGES.map((n) => n.pkg));
    const assets = read('docs/ASSETS.md');
    for (const s of shipped) {
      expect(notices.has(s.name), `${s.name} in tools/postbuild.mjs NOTICE_PACKAGES`).toBe(true);
      expect(assets, `${s.name} ${s.version}`).toContain(s.version);
    }
  });

  it('src imports only shipped packages: dev-only packages (vite, vitest, playwright, peer ...) never reach the bundle', () => {
    const runtime = new Set(Object.keys(pkg.dependencies));
    for (const p of SRC_FILES) {
      for (const m of srcText(p).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+'([^'./][^']*)'|\bimport\(\s*'([^'./][^']*)'\s*\)/gm)) {
        const spec = (m[1] ?? m[2])!;
        if (spec.startsWith('node:')) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
        if (name === 'vitest' && rel(p).endsWith('.test.ts')) continue;
        expect(runtime.has(name), `${rel(p)} imports ${spec}`).toBe(true);
      }
    }
    expect(Object.keys(pkg.devDependencies)).toContain('peer');
  });
});

// --------------------------------------------------------------------------------------------- 5. network

describe('SGN-05 item 5: runtime network (static half; the e2e spec logs a real run)', () => {
  it('no analytics, tracker, beacon, font CDN or API key anywhere in src, public or index.html', () => {
    const files = [...SRC_FILES, ...walk(join(root, 'public')).filter((p) => /\.(js|json|webmanifest)$/.test(p)), join(root, 'index.html')];
    for (const p of files) {
      const t = srcText(p);
      expect(t, rel(p)).not.toMatch(/google-analytics|googletagmanager|\bgtag\(|\bsentry\b|mixpanel|amplitude\.com|hotjar|segment\.io|plausible\.io|\bmatomo\b|posthog|bugsnag|fonts\.googleapis|fonts\.gstatic|cdn\.jsdelivr|unpkg\.com|cdnjs/i);
      expect(t, rel(p)).not.toMatch(/sendBeacon|\bAIza[0-9A-Za-z_-]{20,}|\bapi[_-]?key\s*[:=]/i);
    }
  });

  it('network APIs: one same-origin fetch (service-worker probe), PeerJS only through src/net/transport.ts', () => {
    const uses = (re: RegExp): string[] => SRC_FILES.filter((p) => !p.endsWith('.test.ts') && re.test(srcText(p))).map(rel).sort();
    expect(uses(/(?<![.\w])fetch\(|\bfetchFn\(/)).toEqual(['src/platform/pwa.ts']);
    expect(srcText(join(root, 'src/platform/pwa.ts'))).toMatch(/credentials: 'same-origin'/);
    expect(uses(/new (WebSocket|EventSource|RTCPeerConnection)\b|XMLHttpRequest/)).toEqual([]);
    expect(uses(/from 'peerjs'|import\('peerjs'\)/)).toEqual(['src/net/transport.ts']);
    expect(srcText(join(root, 'src/net/transport.ts'))).toMatch(/await import\('peerjs'\)/);
    expect(uses(/0\.peerjs\.com/)).toEqual(['src/net/config.ts']);
  });

  it('every absolute URL in src is a namespace, a licence or credit link, or the online 1v1 broker', () => {
    const allowed = [/^https?:\/\/www\.w3\.org\//, /^https:\/\/openfontlicense\.org/, /^https:\/\/github\.com\/(floriankarsten|JetBrains)\//,
      /^https?:\/\/(localhost|127\.0\.0\.1)\b/, /^https?:\/\/[a-z0-9.-]*example\.(org|com|net)\b/, /^https:\/\/dotkick\.app\//];
    for (const p of SRC_FILES) {
      for (const m of srcText(p).matchAll(/\b(?:https?|wss?):\/\/[^\s'"`)<>]+/g)) {
        expect(allowed.some((re) => re.test(m[0])), `${rel(p)}: ${m[0]}`).toBe(true);
      }
    }
  });
});

// --------------------------------------------------------------------------------------------- 6. text

describe('SGN-05 item 6: no claimed affiliation, no EA FC style branding', () => {
  const UI_DIRS = ['src/ui/', 'src/app/', 'src/modes/', 'src/platform/'];
  const uiFiles = SRC_FILES.filter((p) => UI_DIRS.some((d) => rel(p).startsWith(d)));

  it('in-game code, index.html and the manifest never name FIFA, EA, a league or a competition', () => {
    const brand = /\bFIFA\b|\bEA\s+SPORTS\b|\bEA\s*FC\b|\bFC\s*2\d\b|Ultimate Team|Premier League|Champions League|\bUEFA\b|La\s?Liga|Bundesliga|Serie A\b|Ligue 1|Eredivisie|\bMLS\b|Libertadores|\bKonami\b|eFootball|\bPES\b/;
    expect(uiFiles.length).toBeGreaterThan(20);
    for (const p of [...uiFiles, join(root, 'index.html'), join(root, 'public/manifest.webmanifest')]) {
      expect(srcText(p), rel(p)).not.toMatch(brand);
    }
  });

  it('the title is DotKick from one constant; no club or title reads like the EA SPORTS FC brand', () => {
    const manifest = JSON.parse(read('public/manifest.webmanifest')) as { name: string; short_name: string };
    expect(manifest.name).toBe('DotKick');
    expect(manifest.short_name).toBe('DotKick');
    expect(read('index.html')).toMatch(/<title>DotKick<\/title>/);
    for (const c of CLUBS) {
      expect(c.name, c.name).not.toMatch(/\bEA\b|\bFC\s*\d|\d+\s*FC\b|^FC$/);
      expect(c.code).not.toMatch(/^(EA|FC)/);
    }
    expect(CLUBS.filter((c) => /\bA?FC\b/.test(c.name)).length).toBeLessThanOrEqual(3);
  });

  it('docs never claim affiliation with or endorsement by FIFA, EA, a league or a club', () => {
    const docs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md') && f !== 'BRIEF.md').map((f) => `docs/${f}`)];
    const claim = /(officially licensed|official (game|product|partner)|endorsed by|in (association|partnership) with|affiliated with|licensed by|approved by)\s[^.\n]{0,40}(FIFA|EA\b|UEFA|league|club|federation)/i;
    for (const d of docs) {
      const text = read(d).replace(/not (affiliated|endorsed|licensed|approved)[^.\n]*/gi, '');
      expect(text, d).not.toMatch(claim);
    }
    expect(read('docs/ASSETS.md')).toMatch(/not affiliated with/i);
  });
});
