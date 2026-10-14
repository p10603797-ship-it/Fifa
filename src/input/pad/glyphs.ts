/**
 * [PAD-07] Controller family detection and button glyphs (section 10: "label by controller family: PlayStation
 * shapes, Xbox letters or Switch letters. Detect the family from gamepad.id, with a manual override in settings";
 * section 2: no commercial logos, everything visible is generated in code).
 *
 * Family detection (detectPadFamily) reads the gamepad.id string the browser reports:
 *  - a vendor id first, in the forms browsers use: Chrome "(... Vendor: 054c Product: 0ce6)", Firefox "054c-0ce6-Name"
 *    or "54c-ce6-Name" (leading zeros dropped), "vendor_id 054c" / "VID_054C" styles: 054c Sony -> PLAYSTATION,
 *    045e Microsoft -> XBOX, 057e Nintendo -> SWITCH. Any other vendor id falls through to the name.
 *  - then brand words in the product name: Xbox / XInput / Microsoft -> XBOX; Nintendo / Pro Controller / Joy-Con /
 *    Switch -> SWITCH; DualSense / DualShock / PlayStation / PS3-5 / Sony -> PLAYSTATION. Sony's own product name is
 *    the bare "Wireless Controller": it counts only when it is the whole name (after the vendor decoration), so
 *    "Xbox Wireless Controller" or "8BitDo Pro 2 Wireless Controller" never read as PlayStation.
 *  - else GENERIC. effectiveFamily applies settings.controls.pad.familyOverride (AUTO = detected; an unknown value
 *    from damaged settings counts as AUTO).
 *
 * Glyphs: glyph(family, button) returns { label, name, svg } for a Standard Gamepad button index (0 Cross/A,
 * 1 Circle/B, 2 Square/X, 3 Triangle/Y, 4 L1/LB, 5 R1/RB, 6 L2/LT, 7 R2/RT, 8 Create/View, 9 Options/Menu, 10 L3,
 * 11 R3, 12-15 D-pad, plus GLYPH_LEFT_STICK / GLYPH_RIGHT_STICK) or, with kind 'btn', for an InputFrame Btn bit.
 * Binding is positional (the mapper binds by position), so the label is what is printed at that position:
 * PlayStation shapes (drawn here: cross, circle, square, triangle), Xbox letters A B X Y, Switch letters by position
 * (south B, east A, west Y, north X). GENERIC uses the Xbox letters (the common layout of generic pads).
 * The SVG is a small inline drawing (viewBox 0 0 32 32, 1em square, stroke/fill currentColor, no colours of any
 * brand), cached per family and button, so callers may ask every frame without allocating.
 * rawButtonLabel(i) names a raw button of a pad without the standard mapping ('Button 8', 1-based) and
 * facePositionSvg(i) draws the four face buttons with the one at standard position i filled (the remap screen).
 */

import { PadFamily } from '../../contracts/enums';
import { Btn } from '../../contracts/input';
import type { Settings } from '../../contracts/settings';

// ============================================================ family detection

/** Vendor id (lower-case hex, no leading zeros) -> family. */
const VENDOR_FAMILY: Readonly<Record<string, PadFamily>> = {
  '54c': PadFamily.PLAYSTATION,
  '45e': PadFamily.XBOX,
  '57e': PadFamily.SWITCH,
};

/** "Vendor: 054c", "vendor_id 054c", "vendor=054c", "VID_054C", "VID 054C". */
const VENDOR_FIELD = /\b(?:vendor(?:[ _-]?id)?|vid)\s*[:=_ ]?\s*(?:0x)?([0-9a-f]{1,4})\b/;
/** Firefox / Safari style prefix "054c-0ce6-Name" or "54c-ce6-Name". */
const VENDOR_PREFIX = /^\s*(?:0x)?([0-9a-f]{1,4})-(?:0x)?[0-9a-f]{1,4}-/;

/** The vendor id (lower-case hex without leading zeros) a gamepad.id names, or ''. */
export function padVendorId(id: string): string {
  const s = typeof id === 'string' ? id.toLowerCase() : '';
  const m = VENDOR_FIELD.exec(s) ?? VENDOR_PREFIX.exec(s);
  if (!m) return '';
  const v = m[1]!.replace(/^0+/, '');
  return v.length > 0 ? v : '0';
}

/** The product name without the browser's decoration ("054c-0ce6-" prefix, "(STANDARD GAMEPAD Vendor: ...)"). */
export function padProductName(id: string): string {
  if (typeof id !== 'string') return '';
  return id
    .replace(VENDOR_PREFIX, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:standard gamepad|extended gamepad|micro gamepad|gamepad)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const XBOX_WORDS = /\bx-?box\b|xinput|\bmicrosoft\b/;
const SWITCH_WORDS = /nintendo|pro controller|joy-?con|\bswitch\b/;
const PLAYSTATION_WORDS = /dualsense|dual ?shock|playstation|\bps[345]\b|\bsony\b/;

/** Detect the family from a gamepad.id string (vendor ids: 054c Sony, 045e Microsoft, 057e Nintendo). */
export function detectPadFamily(id: string): PadFamily {
  if (typeof id !== 'string' || id.length === 0) return PadFamily.GENERIC;
  const byVendor = VENDOR_FAMILY[padVendorId(id)];
  if (byVendor !== undefined) return byVendor;
  const s = id.toLowerCase();
  // Xbox and Switch first: "Xbox Wireless Controller" must not match Sony's bare "Wireless Controller".
  if (XBOX_WORDS.test(s)) return PadFamily.XBOX;
  if (SWITCH_WORDS.test(s)) return PadFamily.SWITCH;
  if (PLAYSTATION_WORDS.test(s)) return PadFamily.PLAYSTATION;
  if (padProductName(id).toLowerCase() === 'wireless controller') return PadFamily.PLAYSTATION;
  return PadFamily.GENERIC;
}

function isFamily(f: unknown): f is PadFamily {
  return f === PadFamily.AUTO || f === PadFamily.PLAYSTATION || f === PadFamily.XBOX || f === PadFamily.SWITCH || f === PadFamily.GENERIC;
}

/** Resolve the family to show: the settings override unless AUTO (an unknown override counts as AUTO). */
export function effectiveFamily(detected: PadFamily, override: PadFamily): PadFamily {
  const d = isFamily(detected) && detected !== PadFamily.AUTO ? detected : PadFamily.GENERIC;
  return isFamily(override) && override !== PadFamily.AUTO ? override : d;
}

/** The family to label a pad with: detected from its gamepad.id, unless settings.controls.pad.familyOverride says. */
export function familyForPad(gamepadId: string, settings?: Readonly<Settings> | null): PadFamily {
  const o = settings?.controls?.pad?.familyOverride;
  return effectiveFamily(detectPadFamily(gamepadId), typeof o === 'number' ? o : PadFamily.AUTO);
}

/** Name of a family for settings and device lists. */
export function familyName(f: PadFamily): string {
  switch (f) {
    case PadFamily.AUTO: return 'Automatic';
    case PadFamily.PLAYSTATION: return 'PlayStation';
    case PadFamily.XBOX: return 'Xbox';
    case PadFamily.SWITCH: return 'Switch';
    default: return 'Generic';
  }
}

// ============================================================ labels

/** Pseudo button indices for the sticks (glyph() accepts them next to the standard indices 0..15). */
export const GLYPH_LEFT_STICK = 32;
export const GLYPH_RIGHT_STICK = 33;

const PS = ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Create', 'Options', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right'];
const XB = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];
// Switch Pro by position: south B, east A, west Y, north X.
const NS = ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', 'Minus', 'Plus', 'LS', 'RS', 'Up', 'Down', 'Left', 'Right'];

function labelTable(family: PadFamily): readonly string[] {
  if (family === PadFamily.PLAYSTATION) return PS;
  if (family === PadFamily.SWITCH) return NS;
  return XB;
}

/** Name of a raw button of a pad without the standard mapping (1-based, as printed on most generic pads). */
export function rawButtonLabel(raw: number): string {
  return Number.isInteger(raw) && raw >= 0 ? `Button ${raw + 1}` : 'Not set';
}

/** Plain-text label for a standard-mapping button index in a family. */
export function buttonLabel(family: PadFamily, index: number): string {
  if (index === GLYPH_LEFT_STICK) return 'Left stick';
  if (index === GLYPH_RIGHT_STICK) return 'Right stick';
  const t = labelTable(family);
  return Number.isInteger(index) && index >= 0 && index < t.length ? t[index]! : rawButtonLabel(index);
}

/** Friendly device label from a gamepad.id. */
export function padLabel(id: string): string {
  const f = detectPadFamily(id);
  if (f === PadFamily.PLAYSTATION) return 'PlayStation controller';
  if (f === PadFamily.XBOX) return 'Xbox controller';
  if (f === PadFamily.SWITCH) return 'Switch controller';
  const clean = padProductName(id);
  return clean.length > 0 ? clean.slice(0, 32) : 'Controller';
}

// ============================================================ glyphs

/** How a glyph is drawn (tests, styling hooks). */
export type GlyphShape =
  | 'cross' | 'circle' | 'square' | 'triangle' | 'letter' | 'shoulder' | 'trigger' | 'menu' | 'view' | 'stick' | 'dpad';

export interface PadGlyph {
  /** Standard index (or GLYPH_*_STICK) the glyph shows; -1 for an unknown button. */
  readonly index: number;
  /** Short plain-text label ('Cross', 'A', 'LB', 'Up'). */
  readonly label: string;
  /** Spoken / long name ('Cross button', 'D-pad up'). */
  readonly name: string;
  readonly shape: GlyphShape;
  /** Inline SVG markup (generated, no assets). */
  readonly svg: string;
}

const VIEW = '0 0 32 32';

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function svgWrap(name: string, body: string): string {
  return `<svg class="dk-glyph" xmlns="http://www.w3.org/2000/svg" viewBox="${VIEW}" width="1em" height="1em" role="img" aria-label="${esc(name)}" focusable="false">${body}</svg>`;
}

function text(t: string, size: number, y = 16): string {
  return `<text x="16" y="${y}" text-anchor="middle" dominant-baseline="central" font-size="${size}" font-weight="700" fill="currentColor">${esc(t)}</text>`;
}

const CAP = '<circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2"/>';
const STROKE = 'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"';

/** Face button body for a family at a face position (0 south, 1 east, 2 west, 3 north). */
function faceBody(family: PadFamily, index: number): { shape: GlyphShape; body: string } {
  if (family === PadFamily.PLAYSTATION) {
    switch (index) {
      case 0: return { shape: 'cross', body: `${CAP}<path d="M11 11L21 21M21 11L11 21" ${STROKE}/>` };
      case 1: return { shape: 'circle', body: `${CAP}<circle cx="16" cy="16" r="6" ${STROKE}/>` };
      case 2: return { shape: 'square', body: `${CAP}<rect x="10.5" y="10.5" width="11" height="11" ${STROKE}/>` };
      default: return { shape: 'triangle', body: `${CAP}<path d="M16 9.5L22.5 20.5H9.5Z" ${STROKE}/>` };
    }
  }
  return { shape: 'letter', body: `${CAP}${text(labelTable(family)[index]!, 15)}` };
}

function fit(label: string): number {
  return label.length <= 1 ? 14 : label.length === 2 ? 12 : 10;
}

/** D-pad: a plus outline with the pressed arm filled. */
function dpadBody(index: number): string {
  const arm = index === 12 ? 'M12 4h8v8h-8z' : index === 13 ? 'M12 20h8v8h-8z' : index === 14 ? 'M4 12h8v8H4z' : 'M20 12h8v8h-8z';
  return `<path d="M12 4h8v8h8v8h-8v8h-8v-8H4v-8h8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="${arm}" fill="currentColor"/>`;
}

function buildGlyph(family: PadFamily, index: number): PadGlyph {
  const label = buttonLabel(family, index);
  let shape: GlyphShape;
  let body: string;
  let name: string;
  if (index >= 0 && index <= 3) {
    const f = faceBody(family, index);
    shape = f.shape;
    body = f.body;
    name = `${label} button`;
  } else if (index === 4 || index === 5) {
    shape = 'shoulder';
    body = `<rect x="3" y="9" width="26" height="14" rx="7" fill="none" stroke="currentColor" stroke-width="2"/>${text(label, fit(label))}`;
    name = label;
  } else if (index === 6 || index === 7) {
    shape = 'trigger';
    body = `<path d="M6 28V15a10 10 0 0 1 20 0v13z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>${text(label, fit(label), 19)}`;
    name = label;
  } else if (index === 8) {
    shape = 'view';
    body = family === PadFamily.SWITCH
      ? `${CAP}<path d="M10 16h12" ${STROKE}/>`
      : `${CAP}<rect x="9" y="10" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="14" y="14" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="2"/>`;
    name = family === PadFamily.SWITCH ? 'Minus button' : `${label} button`;
  } else if (index === 9) {
    shape = 'menu';
    body = family === PadFamily.SWITCH ? `${CAP}<path d="M10 16h12M16 10v12" ${STROKE}/>` : `${CAP}<path d="M10 11h12M10 16h12M10 21h12" ${STROKE}/>`;
    name = family === PadFamily.SWITCH ? 'Plus button' : `${label} button`;
  } else if (index === 10 || index === 11 || index === GLYPH_LEFT_STICK || index === GLYPH_RIGHT_STICK) {
    shape = 'stick';
    const click = index === 10 || index === 11;
    const t = click ? label : index === GLYPH_LEFT_STICK ? 'L' : 'R';
    body = `<circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="${click ? '0' : '2 2'}"/>${text(t, fit(t))}`;
    name = click ? `${label} (press the stick)` : label;
  } else if (index >= 12 && index <= 15) {
    shape = 'dpad';
    body = dpadBody(index);
    name = `D-pad ${label.toLowerCase()}`;
  } else {
    shape = 'letter';
    const t = Number.isInteger(index) && index >= 0 ? String(index + 1) : '?';
    body = `${CAP}${text(t, fit(t))}`;
    name = label;
    index = Number.isInteger(index) && index >= 0 ? index : -1;
  }
  return { index, label, name, shape, svg: svgWrap(name, body) };
}

/** Cache per family (1..4) and index (0..15, then the two sticks). */
const CACHE: (PadGlyph | undefined)[][] = [[], [], [], [], []];
const STICK_SLOT = 16;

function cacheSlot(index: number): number {
  if (index === GLYPH_LEFT_STICK) return STICK_SLOT;
  if (index === GLYPH_RIGHT_STICK) return STICK_SLOT + 1;
  return Number.isInteger(index) && index >= 0 && index < 16 ? index : -1;
}

/** InputFrame Btn bit -> Standard Gamepad index (right-stick bits -> GLYPH_RIGHT_STICK), -1 when no pad button. */
export function btnToPadIndex(btn: number): number {
  switch (btn) {
    case Btn.PASS: return 0;
    case Btn.SHOOT: return 1;
    case Btn.LOB: return 2;
    case Btn.THROUGH: return 3;
    case Btn.MOD_L: return 4;
    case Btn.MOD_R: return 5;
    case Btn.SHIELD: return 6;
    case Btn.SPRINT: return 7;
    case Btn.RS_FLICK:
    case Btn.RS_HOLD: return GLYPH_RIGHT_STICK;
    default: return -1;
  }
}

/**
 * Glyph (label + inline SVG) for a button in a family. `button` is a Standard Gamepad index (default) or, with
 * kind 'btn', an InputFrame Btn bit (a Btn bit with no pad button, e.g. Btn.SKIP, gives null). AUTO is drawn as
 * GENERIC. Results are cached: the same object comes back for the same family and button.
 */
export function glyph(family: PadFamily, button: number, kind?: 'index'): PadGlyph;
export function glyph(family: PadFamily, button: number, kind: 'btn'): PadGlyph | null;
export function glyph(family: PadFamily, button: number, kind: 'index' | 'btn' = 'index'): PadGlyph | null {
  const index = kind === 'btn' ? btnToPadIndex(button) : button;
  if (kind === 'btn' && index < 0) return null;
  const fam = family === PadFamily.PLAYSTATION || family === PadFamily.XBOX || family === PadFamily.SWITCH ? family : PadFamily.GENERIC;
  const slot = cacheSlot(index);
  if (slot < 0) return buildGlyph(fam, index);
  const row = CACHE[fam]!;
  let g = row[slot];
  if (!g) {
    g = buildGlyph(fam, index);
    row[slot] = g;
  }
  return g;
}

/** Glyph for an InputFrame Btn bit (null when no pad button produces it). */
export function glyphForBtn(family: PadFamily, btn: number): PadGlyph | null {
  return glyph(family, btn, 'btn');
}

const FACE_POS: readonly (readonly [number, number])[] = [[16, 25], [25, 16], [7, 16], [16, 7]];
const FACE_SVG: string[] = [];

/**
 * The four face buttons as a diamond with the one at standard position `index` (0 south, 1 east, 2 west, 3 north)
 * filled: a family-neutral "where it usually is" hint. Other indices draw the diamond with nothing filled.
 */
export function facePositionSvg(index: number): string {
  const k = Number.isInteger(index) && index >= 0 && index <= 3 ? index : 4;
  let s = FACE_SVG[k];
  if (s === undefined) {
    let body = '';
    for (let i = 0; i < 4; i++) {
      const [x, y] = FACE_POS[i]!;
      body += `<circle cx="${x}" cy="${y}" r="5" ${i === k ? 'fill="currentColor"' : 'fill="none"'} stroke="currentColor" stroke-width="2"/>`;
    }
    const where = ['bottom', 'right', 'left', 'top'][k];
    s = svgWrap(where ? `The ${where} face button` : 'Face buttons', body);
    FACE_SVG[k] = s;
  }
  return s;
}
