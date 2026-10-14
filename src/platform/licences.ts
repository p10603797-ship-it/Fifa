/**
 * [QF-5] Credits and licences at runtime (PLT-06 CR 2, SGN-05).
 *
 * tools/postbuild.mjs writes one HTML comment right after the doctype of dist/index.html: the name, version, licence
 * and full licence text of every bundled library and both fonts (read from node_modules at build time). This module
 * reads that comment back, so the texts are not shipped twice:
 *  - findNoticesText(doc): the comment's text (null in a dev build, where postbuild did not run);
 *  - parseNotices(text): one entry per library / font;
 *  - creditsSummary(doc): one line for the diagnostics report (Settings > Diagnostics);
 *  - createCreditsView(doc): a DOM view with every entry and its licence text (Settings > Diagnostics > Credits and
 *    licences). Without the comment (dev server) it lists BUNDLED_CREDITS and says where the texts are.
 * Never throws; nothing here runs per frame.
 */

/** First word of the notices comment (tools/postbuild.mjs NOTICES_MARK). */
export const NOTICES_MARK = 'dotkick-notices';

export interface LicenceNotice {
  name: string;
  version: string;
  license: string;
  use: string;
  /** Full licence text ('' when unknown, e.g. the dev fallback). */
  text: string;
}

/** What ships in the game (versions come from the build's comment; docs/ASSETS.md has the same list). */
export const BUNDLED_CREDITS: readonly LicenceNotice[] = [
  { name: 'three', version: '', license: 'MIT', use: '3D rendering', text: '' },
  { name: 'peerjs', version: '', license: 'MIT', use: 'online 1v1 (WebRTC data channels)', text: '' },
  { name: 'webrtc-adapter', version: '', license: 'BSD-3-Clause', use: 'bundled with PeerJS', text: '' },
  { name: 'sdp', version: '', license: 'MIT', use: 'bundled with PeerJS (webrtc-adapter)', text: '' },
  { name: 'peerjs-js-binarypack', version: '', license: 'MIT', use: 'bundled with PeerJS', text: '' },
  { name: '@msgpack/msgpack', version: '', license: 'ISC', use: 'bundled with PeerJS', text: '' },
  { name: 'eventemitter3', version: '', license: 'MIT', use: 'bundled with PeerJS', text: '' },
  { name: '@fontsource/space-grotesk', version: '', license: 'OFL-1.1', use: 'Space Grotesk font (menus and HUD)', text: '' },
  { name: '@fontsource/jetbrains-mono', version: '', license: 'OFL-1.1', use: 'JetBrains Mono font (numbers)', text: '' },
];

const HEADER_RE = /^=== (\S+) (\S+) \(([^)]*)\) - (.*) ===$/;

/** Undo postbuild's comment escaping ("--" was written as "- -"). Pure. */
function unescapeComment(t: string): string {
  let s = t;
  while (s.includes('- -')) s = s.replace(/- -/g, '--');
  return s;
}

/** Text of the notices comment in `doc` (a child of the document, after the doctype), or null. Never throws. */
export function findNoticesText(doc: Document | null = typeof document !== 'undefined' ? document : null): string | null {
  if (!doc) return null;
  try {
    const nodes = doc.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      if (n.nodeType !== 8) continue; // Node.COMMENT_NODE
      const data = (n as Comment).data ?? '';
      if (data.trimStart().startsWith(NOTICES_MARK)) return unescapeComment(data.trimStart().slice(NOTICES_MARK.length)).trim();
    }
  } catch {
    /* no DOM */
  }
  return null;
}

/** Entries of a notices text (see tools/postbuild.mjs noticesComment). Pure. */
export function parseNotices(text: string): LicenceNotice[] {
  const out: LicenceNotice[] = [];
  let cur: LicenceNotice | null = null;
  let body: string[] = [];
  const close = (): void => {
    if (cur) {
      cur.text = body.join('\n').trim();
      out.push(cur);
    }
  };
  for (const line of String(text).split('\n')) {
    const m = HEADER_RE.exec(line.trim());
    if (m) {
      close();
      cur = { name: m[1]!, version: m[2]!, license: m[3]!, use: m[4]!, text: '' };
      body = [];
    } else if (cur) {
      body.push(line);
    }
  }
  close();
  return out;
}

/** The shipped notices (from the build's comment), or BUNDLED_CREDITS without texts in a dev build. */
export function readNotices(doc?: Document | null): { entries: LicenceNotice[]; fromBuild: boolean } {
  const text = findNoticesText(doc === undefined ? (typeof document !== 'undefined' ? document : null) : doc);
  const entries = text ? parseNotices(text) : [];
  return entries.length > 0 ? { entries, fromBuild: true } : { entries: BUNDLED_CREDITS.map((e) => ({ ...e })), fromBuild: false };
}

/** One line for the diagnostics report. */
export function creditsSummary(doc?: Document | null): string {
  const { entries, fromBuild } = readNotices(doc);
  const list = entries.map((e) => `${e.name}${e.version ? ` ${e.version}` : ''} (${e.license})`).join(', ');
  return `${list}; ${fromBuild ? 'full licence texts in Credits and licences and at the top of index.html' : 'dev build: licence texts in docs/ASSETS.md'}`;
}

/**
 * The Credits and licences view: a heading, a short note and one block per library / font with its licence text in
 * a scrollable <pre data-scroll> (iPad: [data-scroll] containers may scroll, platform/ipados.ts).
 */
export function createCreditsView(doc: Document = document): HTMLElement {
  const { entries, fromBuild } = readNotices(doc);
  const el = (tag: string, text?: string, cls?: string): HTMLElement => {
    const e = doc.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const root = el('section', undefined, 'credits');
  root.setAttribute('data-testid', 'credits-view');
  root.setAttribute('data-scroll', '');
  root.style.cssText = 'display:flex;flex-direction:column;gap:12px;max-height:100%;overflow:auto;-webkit-overflow-scrolling:touch;';
  root.append(
    el('h2', 'Credits and licences', 'credits-title'),
    el('p', 'DotKick is an original game: everything you see and hear is made in code. It uses these open-source libraries and fonts, under their licences.', 'credits-note'),
  );
  for (const e of entries) {
    const item = el('article', undefined, 'credits-item');
    item.setAttribute('data-testid', 'credits-item');
    item.append(el('h3', `${e.name}${e.version ? ` ${e.version}` : ''} - ${e.license}`, 'credits-name'), el('p', e.use, 'credits-use'));
    const pre = el('pre', e.text || (fromBuild ? '' : 'The full licence text ships in the built game (index.html) and in docs/ASSETS.md.'), 'credits-text');
    pre.setAttribute('data-scroll', '');
    pre.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.45 var(--font-num, ui-monospace, monospace);margin:0;opacity:.85;user-select:text;-webkit-user-select:text;';
    item.append(pre);
    root.append(item);
  }
  return root;
}
