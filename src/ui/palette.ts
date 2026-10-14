/**
 * [UIX-01] Dot design system palette derivation (brief section 12 "Visual identity": derive the rest of the palette
 * from ink #07070D and ember #FF6B35 and keep every token as a CSS variable in one file).
 *
 * The CSS file (src/ui/tokens.css) holds the literal values; this module is the recipe that produced them and the
 * maths the tests use to prove it (tests/unit/uix-01-palette.test.ts checks that tokens.css equals derivePalette()
 * and that every text tier passes WCAG AA on every surface). Pure: no DOM.
 *
 * Recipe (OKLCH, perceptual lightness L 0..1, chroma C, hue h in degrees):
 *  - surfaces: the ink lifted in lightness, same hue (cool, near-black panels).
 *  - text tiers: warm greys on the ember hue at three lightness steps (all >= 4.5:1 on every surface).
 *  - hairlines: text-1 at low alpha (thin, quiet borders); a solid control line for toggles and slider tracks.
 *  - ember family: brighter (hover), deeper (pressed), soft and glow alphas; dark warm text on ember.
 *  - player 2 cyan: the ember hue + 180 deg (its complement); success, warning, error: the ember hue rotated, kept
 *    at text-safe lightness.
 */

export const PALETTE_SOURCES = { ink: '#07070D', ember: '#FF6B35' } as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklch {
  l: number;
  c: number;
  h: number;
}

/** Parse #rgb or #rrggbb into 0..255 channels. */
export function hexToRgb(hex: string): Rgb {
  let s = hex.trim().replace(/^#/, '');
  if (s.length === 3) s = s[0]! + s[0]! + s[1]! + s[1]! + s[2]! + s[2]!;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`palette: bad hex colour '${hex}'`);
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function to2(n: number): string {
  const v = Math.max(0, Math.min(255, Math.round(n)));
  return v.toString(16).padStart(2, '0');
}

/** 0..255 channels to lower-case #rrggbb. */
export function rgbToHex(c: Rgb): string {
  return `#${to2(c.r)}${to2(c.g)}${to2(c.b)}`;
}

/** sRGB channel 0..1 -> linear light. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Linear light -> sRGB channel 0..1. */
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** sRGB (0..255) to OKLCH. */
export function rgbToOklch(c: Rgb): Oklch {
  const r = srgbToLinear(c.r / 255), g = srgbToLinear(c.g / 255), b = srgbToLinear(c.b / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  let h = (Math.atan2(B, A) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c: Math.sqrt(A * A + B * B), h };
}

/** OKLCH to linear sRGB (may fall outside 0..1 when out of gamut). */
function oklchToLinear(o: Oklch): [number, number, number] {
  const hr = (o.h * Math.PI) / 180;
  const A = o.c * Math.cos(hr), B = o.c * Math.sin(hr);
  const l = o.l + 0.3963377774 * A + 0.2158037573 * B;
  const m = o.l - 0.1055613458 * A - 0.0638541728 * B;
  const s = o.l - 0.0894841775 * A - 1.291485548 * B;
  const l3 = l * l * l, m3 = m * m * m, s3 = s * s * s;
  return [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
}

function inGamut(lin: [number, number, number]): boolean {
  const e = 1e-6;
  return lin[0] >= -e && lin[0] <= 1 + e && lin[1] >= -e && lin[1] <= 1 + e && lin[2] >= -e && lin[2] <= 1 + e;
}

/** OKLCH to sRGB (0..255), reducing chroma until the colour fits the sRGB gamut (hue and lightness kept). */
export function oklchToRgb(o: Oklch): Rgb {
  let lin = oklchToLinear(o);
  if (!inGamut(lin)) {
    let lo = 0, hi = o.c;
    for (let i = 0; i < 32; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToLinear({ l: o.l, c: mid, h: o.h }))) lo = mid; else hi = mid;
    }
    lin = oklchToLinear({ l: o.l, c: lo, h: o.h });
  }
  const ch = (v: number): number => linearToSrgb(Math.max(0, Math.min(1, v))) * 255;
  return { r: ch(lin[0]), g: ch(lin[1]), b: ch(lin[2]) };
}

export function oklchToHex(o: Oklch): string {
  return rgbToHex(oklchToRgb(o));
}

/** WCAG 2.x relative luminance of a 0..255 colour. */
export function relativeLuminance(c: Rgb): number {
  return 0.2126 * srgbToLinear(c.r / 255) + 0.7152 * srgbToLinear(c.g / 255) + 0.0722 * srgbToLinear(c.b / 255);
}

/** WCAG contrast ratio (1..21) between two opaque colours. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const hi = Math.max(la, lb), lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour that may carry alpha (parsed from #hex or rgba()). */
export interface Rgba extends Rgb {
  a: number;
}

/** Parse '#rrggbb', '#rgb', 'rgb(r, g, b)' or 'rgba(r, g, b, a)'. */
export function parseColor(css: string): Rgba {
  const s = css.trim();
  if (s.startsWith('#')) return { ...hexToRgb(s), a: 1 };
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (!m) throw new Error(`palette: cannot parse colour '${css}'`);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) };
}

/** Composite a possibly translucent colour over an opaque background (sRGB space, as browsers do). */
export function composite(fg: Rgba, bg: Rgb): Rgb {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
}

function rgba(hex: string, a: number): string {
  const c = hexToRgb(hex);
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

function wrapHue(h: number): number {
  return ((h % 360) + 360) % 360;
}

/** Colour tokens (CSS custom property name without the leading dashes -> CSS value). */
export type Palette = Record<string, string>;

/** Text tokens: each must reach WCAG AA (4.5:1) on every surface token. */
export const TEXT_TOKENS = ['text-1', 'text-2', 'text-3', 'ember', 'ember-strong', 'cyan', 'success', 'warning', 'error'] as const;
/** Opaque surface tokens text sits on. */
export const SURFACE_TOKENS = ['ink', 'surface-1', 'surface-2', 'surface-3', 'surface-4'] as const;

/** Lightness steps of the surfaces above the ink (OKLCH L). */
const SURFACE_LIFT = [0.03, 0.065, 0.1, 0.14] as const;

/** Derive every colour token from the two source colours. */
export function derivePalette(inkHex: string = PALETTE_SOURCES.ink, emberHex: string = PALETTE_SOURCES.ember): Palette {
  const ink = rgbToOklch(hexToRgb(inkHex));
  const ember = rgbToOklch(hexToRgb(emberHex));
  const hi = ink.h, he = ember.h;
  const at = (l: number, c: number, h: number): string => oklchToHex({ l, c, h: wrapHue(h) });

  const inkOut = rgbToHex(hexToRgb(inkHex));
  const emberOut = rgbToHex(hexToRgb(emberHex));
  const surface = SURFACE_LIFT.map((d) => at(ink.l + d, ink.c * 1.15, hi));
  const text1 = at(0.96, 0.008, he);
  const text2 = at(0.82, 0.011, he);
  const text3 = at(0.68, 0.012, he);
  const emberStrong = at(Math.min(0.9, ember.l + 0.07), ember.c * 0.9, he);
  const emberDeep = at(ember.l - 0.1, ember.c, he);
  const cyan = at(0.8, 0.13, he + 180);
  const cyanStrong = at(0.87, 0.11, he + 180);
  const success = at(0.8, 0.15, he + 115);
  const warning = at(0.85, 0.15, he + 45);
  const error = at(0.7, 0.19, he - 20);

  return {
    ink: inkOut,
    ember: emberOut,
    cyan,
    'surface-1': surface[0]!,
    'surface-2': surface[1]!,
    'surface-3': surface[2]!,
    'surface-4': surface[3]!,
    scrim: rgba(inkOut, 0.78),
    hairline: rgba(text1, 0.1),
    'hairline-strong': rgba(text1, 0.18),
    'line-control': at(ink.l + 0.42, ink.c, hi),
    'text-1': text1,
    'text-2': text2,
    'text-3': text3,
    'text-on-ember': at(ink.l + 0.04, 0.035, he),
    'ember-strong': emberStrong,
    'ember-deep': emberDeep,
    'ember-soft': rgba(emberOut, 0.16),
    'ember-glow': rgba(emberOut, 0.38),
    'ember-tint': rgba(emberOut, 0.08),
    'cyan-strong': cyanStrong,
    'cyan-soft': rgba(cyan, 0.16),
    'cyan-tint': rgba(cyan, 0.08),
    success,
    'success-soft': rgba(success, 0.16),
    warning,
    'warning-soft': rgba(warning, 0.16),
    error,
    'error-soft': rgba(error, 0.16),
  };
}

/** Parse the custom properties of the first :root { ... } block of a CSS text (name without dashes -> value). */
export function parseRootVars(css: string): Record<string, string> {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = /:root\s*\{([^}]*)\}/.exec(noComments);
  const out: Record<string, string> = {};
  if (!m) return out;
  const re = /--([a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
  let d: RegExpExecArray | null;
  while ((d = re.exec(m[1]!)) !== null) out[d[1]!] = d[2]!.trim();
  return out;
}
