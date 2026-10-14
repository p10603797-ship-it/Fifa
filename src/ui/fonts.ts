/**
 * [UIX-01 / PLT-04] UI fonts: Space Grotesk (UI) and JetBrains Mono (numbers, tabular figures), both SIL Open Font
 * License 1.1, Latin subsets only, inlined into the single-file build (brief section 12).
 *
 * The woff2 files come from the @fontsource packages (Latin subset files). They are imported with `?url`, and the
 * build's assetsInlineLimit (vite.config.ts) turns each into a data: URI inside dist/index.html, so the game needs no
 * font requests. Faces: Space Grotesk 400 / 500 / 700 and JetBrains Mono 400 / 600 (about 80 KB of woff2 in total).
 *
 * installFonts() declares the @font-face rules (one <style>) and starts loading every face at once, so the first
 * screen does not flash fallback text. components.ts calls it on import, which happens before the first screen
 * mounts; calling it again does nothing. fontsReady() resolves when the faces are loaded (or failed: system fonts
 * then stand in via the --font-ui / --font-num stacks).
 */
import jbm400 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url';
import jbm600 from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url';
import sg400 from '@fontsource/space-grotesk/files/space-grotesk-latin-400-normal.woff2?url';
import sg500 from '@fontsource/space-grotesk/files/space-grotesk-latin-500-normal.woff2?url';
import sg700 from '@fontsource/space-grotesk/files/space-grotesk-latin-700-normal.woff2?url';

export const FONT_UI = 'Space Grotesk';
export const FONT_NUM = 'JetBrains Mono';

/** The Latin range the subset files cover (from @fontsource's latin subset). Other characters use the fallbacks. */
export const LATIN_UNICODE_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,' +
  'U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

export interface FontFaceSpec {
  family: string;
  weight: number;
  /** Data URI in the build, a module URL in dev. */
  url: string;
  /** Source file name (licence records, size checks). */
  file: string;
}

export const FONT_FACES: readonly FontFaceSpec[] = [
  { family: FONT_UI, weight: 400, url: sg400, file: 'space-grotesk-latin-400-normal.woff2' },
  { family: FONT_UI, weight: 500, url: sg500, file: 'space-grotesk-latin-500-normal.woff2' },
  { family: FONT_UI, weight: 700, url: sg700, file: 'space-grotesk-latin-700-normal.woff2' },
  { family: FONT_NUM, weight: 400, url: jbm400, file: 'jetbrains-mono-latin-400-normal.woff2' },
  { family: FONT_NUM, weight: 600, url: jbm600, file: 'jetbrains-mono-latin-600-normal.woff2' },
];

/** Licence records for the credits screen and README (PLT-06). */
export interface FontLicence {
  family: string;
  licence: string;
  licenceUrl: string;
  copyright: string;
  /** npm package and version the files were taken from. */
  source: string;
  files: readonly string[];
}

export const FONT_LICENCES: readonly FontLicence[] = [
  {
    family: FONT_UI,
    licence: 'SIL Open Font License 1.1',
    licenceUrl: 'https://openfontlicense.org',
    copyright: 'Copyright 2020 The Space Grotesk Project Authors (https://github.com/floriankarsten/space-grotesk)',
    source: '@fontsource/space-grotesk 5.3.0',
    files: FONT_FACES.filter((f) => f.family === FONT_UI).map((f) => f.file),
  },
  {
    family: FONT_NUM,
    licence: 'SIL Open Font License 1.1',
    licenceUrl: 'https://openfontlicense.org',
    copyright: 'Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)',
    source: '@fontsource/jetbrains-mono 5.3.0',
    files: FONT_FACES.filter((f) => f.family === FONT_NUM).map((f) => f.file),
  },
];

const STYLE_ID = 'dk-fonts';

/** The @font-face rules for the given faces. Pure. */
export function fontFaceCss(faces: readonly FontFaceSpec[] = FONT_FACES): string {
  let css = '';
  for (const f of faces) {
    css +=
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:swap;` +
      `src:url("${f.url}") format('woff2');unicode-range:${LATIN_UNICODE_RANGE};}\n`;
  }
  return css;
}

/** CSS font shorthand that selects one face (for document.fonts.load / check). Pure. */
export function faceQuery(f: Pick<FontFaceSpec, 'family' | 'weight'>, sizePx = 16): string {
  return `${f.weight} ${sizePx}px "${f.family}"`;
}

type FontDoc = Document & { fonts?: FontFaceSet };

let loading: Promise<void> | null = null;

function getDoc(): FontDoc | null {
  return typeof document !== 'undefined' ? (document as FontDoc) : null;
}

/** Install the inlined @font-face rules and start loading every face. Safe to call more than once; never throws. */
export function installFonts(): void {
  const doc = getDoc();
  if (!doc) return;
  try {
    if (typeof doc.getElementById !== 'function' || doc.getElementById(STYLE_ID)) return;
    const head = doc.head;
    if (!head || typeof head.appendChild !== 'function') return;
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = fontFaceCss();
    head.appendChild(st);
    const fonts = doc.fonts;
    if (fonts && typeof fonts.load === 'function') {
      const all: Promise<unknown>[] = [];
      for (const f of FONT_FACES) all.push(fonts.load(faceQuery(f)).catch(() => undefined));
      loading = Promise.all(all).then(() => undefined, () => undefined);
    }
  } catch {
    /* a missing or fake document: the fallback font stacks apply */
  }
}

/** Resolves when the UI fonts are ready (or immediately when the Font Loading API is missing). Never rejects. */
export function fontsReady(): Promise<void> {
  const doc = getDoc();
  const fonts = doc ? doc.fonts : undefined;
  if (!fonts) return Promise.resolve();
  const ready = fonts.ready.then(() => undefined, () => undefined);
  return loading ? Promise.all([loading, ready]).then(() => undefined) : ready;
}

/** True when every UI face is loaded (document.fonts.check). False without the Font Loading API. */
export function fontsLoaded(): boolean {
  const fonts = getDoc()?.fonts;
  if (!fonts || typeof fonts.check !== 'function') return false;
  try {
    for (const f of FONT_FACES) if (!fonts.check(faceQuery(f))) return false;
    return true;
  } catch {
    return false;
  }
}
