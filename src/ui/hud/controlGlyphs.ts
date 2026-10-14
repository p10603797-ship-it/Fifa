/**
 * [UIX-12] Control glyphs for hints and the tutorial (helper file of UIX-12): one hint line = a few keys plus text,
 * drawn for the device in use. Keys are InputFrame Btn bits (pad glyphs from PAD-07 src/input/pad/glyphs.ts by
 * controller family, key caps from the keyboard scheme src/input/keyboard.ts KEY_BUTTONS), 'LS' / 'RS' for the
 * sticks, or a literal label (touch button names such as 'PASS', keyboard caps such as 'T').
 *
 * Pure parts (keyChip, keyboardKeyLabel) are unit-tested in Node; renderHintLines builds DOM (called only when a
 * hint or tutorial card changes, never per frame).
 */
import { PadFamily } from '../../contracts/enums';
import { Btn } from '../../contracts/input';
import { KEY_BUTTONS } from '../../input/keyboard';
import { GLYPH_LEFT_STICK, GLYPH_RIGHT_STICK, glyph, glyphForBtn } from '../../input/pad/glyphs';
import { h } from '../components';
import type { DeviceSpec } from './hudShared';

/** A key in a hint line: a Btn bit, 'LS' / 'RS', or a literal label. */
export type HintKey = number | string;

export interface HintLine {
  readonly keys: readonly HintKey[];
  readonly text: string;
}

/** Hint lines per device; keyboard falls back to the pad lines (same positional buttons). */
export interface DeviceLines {
  readonly touch: readonly HintLine[];
  readonly pad: readonly HintLine[];
  readonly keyboard?: readonly HintLine[];
}

export interface KeyChip {
  /** Plain-text label (also the accessible name). */
  readonly label: string;
  /** Inline SVG (pad glyphs) or null for a text chip. */
  readonly svg: string | null;
}

/** Touch button names for Btn bits (the attack cluster labels; brief section 9). */
const TOUCH_BTN_LABEL: Readonly<Record<number, string>> = {
  [Btn.PASS]: 'PASS',
  [Btn.SHOOT]: 'SHOOT',
  [Btn.LOB]: 'LOB',
  [Btn.THROUGH]: 'THROUGH',
  [Btn.SPRINT]: 'SPRINT',
  [Btn.MOD_L]: 'SWITCH',
  [Btn.MOD_R]: '2ND DEF',
  [Btn.SHIELD]: 'SHIELD',
};

function codeLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Shift')) return 'Shift';
  return code;
}

/** Keyboard key cap for a Btn bit (from KEY_BUTTONS, first code wins), or '' when no key produces it. Pure. */
export function keyboardKeyLabel(bit: number): string {
  for (const code of Object.keys(KEY_BUTTONS)) if (KEY_BUTTONS[code] === bit) return codeLabel(code);
  return '';
}

const CHIP_CACHE: Record<string, KeyChip> = {};

function cached(key: string, make: () => KeyChip): KeyChip {
  let c = CHIP_CACHE[key];
  if (!c) {
    c = make();
    CHIP_CACHE[key] = c;
  }
  return c;
}

/** The chip drawn for one key on one device. Results are cached per device kind, family and key. Pure. */
export function keyChip(dev: DeviceSpec, key: HintKey): KeyChip {
  const fam = dev.kind === 'pad' ? dev.family : PadFamily.GENERIC;
  return cached(`${dev.kind}:${fam}:${String(key)}`, () => {
    if (dev.kind === 'pad') {
      if (key === 'LS' || key === 'RS') {
        const g = glyph(fam, key === 'LS' ? GLYPH_LEFT_STICK : GLYPH_RIGHT_STICK);
        return { label: g.label, svg: g.svg };
      }
      if (typeof key === 'number') {
        const g = glyphForBtn(fam, key);
        if (g) return { label: g.label, svg: g.svg };
        return { label: '?', svg: null };
      }
      return { label: key, svg: null };
    }
    if (dev.kind === 'keyboard') {
      if (key === 'LS') return { label: 'WASD', svg: null };
      if (key === 'RS') return { label: 'Numpad', svg: null };
      if (typeof key === 'number') return { label: keyboardKeyLabel(key) || '?', svg: null };
      return { label: key, svg: null };
    }
    if (key === 'LS') return { label: 'STICK', svg: null };
    if (key === 'RS') return { label: 'SWIPE', svg: null };
    if (typeof key === 'number') return { label: TOUCH_BTN_LABEL[key] ?? '?', svg: null };
    return { label: key, svg: null };
  });
}

/** The lines for a device (keyboard falls back to the pad lines). */
export function linesFor(lines: DeviceLines, dev: DeviceSpec): readonly HintLine[] {
  if (dev.kind === 'touch') return lines.touch;
  if (dev.kind === 'keyboard') return lines.keyboard ?? lines.pad;
  return lines.pad;
}

/** Plain-text form of a line for a device ("[A] Short pass"), for aria labels and tests. */
export function lineText(line: HintLine, dev: DeviceSpec): string {
  const keys = line.keys.map((k) => `[${keyChip(dev, k).label}]`).join(' + ');
  return keys ? `${keys} ${line.text}` : line.text;
}

/** One key chip element. */
export function chipElement(dev: DeviceSpec, key: HintKey, cls = 'kc'): HTMLElement {
  const c = keyChip(dev, key);
  const el = h('span', { class: c.svg ? `${cls} ${cls}--glyph` : cls, attrs: { 'aria-label': c.label, role: 'img' } });
  if (c.svg) el.innerHTML = c.svg;
  else el.textContent = c.label;
  return el;
}

/** Build the line rows into `parent` (replacing its children). DOM work: call on content change only. */
export function renderHintLines(parent: HTMLElement, dev: DeviceSpec, lines: readonly HintLine[], cls = 'hl'): void {
  const rows: HTMLElement[] = [];
  for (const line of lines) {
    const keys = h('span', { class: `${cls}__keys` });
    line.keys.forEach((k, i) => {
      if (i > 0) keys.append(h('span', { class: `${cls}__plus`, text: '+', attrs: { 'aria-hidden': 'true' } }));
      keys.append(chipElement(dev, k));
    });
    rows.push(h('div', { class: cls }, keys, h('span', { class: `${cls}__text`, text: line.text })));
  }
  parent.replaceChildren(...rows);
}

/** Shared chip styles (pad glyph SVGs are 1em squares drawn in currentColor). */
export const GLYPH_CSS = `
.kc { display:inline-flex; align-items:center; justify-content:center; min-width: 1.9em; height: 1.9em; padding: 0 .45em;
  border-radius: .5em; border: 1px solid var(--hairline-strong); background: var(--surface-3); color: var(--text-1);
  font-family: var(--font-num); font-variant-numeric: tabular-nums; font-size: .78em; font-weight: 600;
  letter-spacing: .04em; white-space: nowrap; box-sizing: border-box; }
.kc--glyph { padding: 0 .3em; font-size: 1em; }
.kc--glyph svg { width: 1.2em; height: 1.2em; display:block; }
.hl, .tl { display:flex; align-items:center; gap: .6em; }
.hl__keys, .tl__keys { display:inline-flex; align-items:center; gap: .25em; flex: none; }
.hl__plus, .tl__plus { color: var(--text-3); font-size: .8em; }
.hl__text, .tl__text { color: var(--text-2); }
`;
