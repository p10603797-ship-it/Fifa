/**
 * UIX-01 palette: tokens.css holds exactly the colours derivePalette() makes from ink #07070D and ember #FF6B35,
 * every text tier passes WCAG AA on every surface, every token lives in the one tokens file, and every var(--x) the
 * design-system CSS uses is defined.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composite, contrastRatio, derivePalette, hexToRgb, oklchToHex, parseColor, parseRootVars, PALETTE_SOURCES, rgbToHex,
  rgbToOklch, SURFACE_TOKENS, TEXT_TOKENS,
} from '../../src/ui/palette';

const root = resolve(__dirname, '../..');
const tokensCss = readFileSync(resolve(root, 'src/ui/tokens.css'), 'utf8');
const componentsCss = readFileSync(resolve(root, 'src/ui/components.css'), 'utf8');
const viewportCss = readFileSync(resolve(root, 'src/platform/viewport.css'), 'utf8');
const vars = parseRootVars(tokensCss);
const palette = derivePalette();

/** Angular distance between two hues, 0..180 deg. */
function hueDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function opaque(name: string): { r: number; g: number; b: number } {
  const v = vars[name];
  if (v === undefined) throw new Error(`token --${name} missing`);
  return hexToRgb(v);
}

describe('UIX-01 palette derivation', () => {
  it('keeps the two source colours from the brief', () => {
    expect(vars.ink).toBe('#07070d');
    expect(vars.ember).toBe('#ff6b35');
    expect(PALETTE_SOURCES).toEqual({ ink: '#07070D', ember: '#FF6B35' });
  });

  it('tokens.css holds exactly the derived colour of every palette token', () => {
    for (const [name, value] of Object.entries(palette)) {
      expect(vars[name], `--${name}`).toBe(value);
    }
  });

  it('every text tier reaches WCAG AA (4.5:1) on every surface', () => {
    for (const t of TEXT_TOKENS) {
      for (const s of SURFACE_TOKENS) {
        const ratio = contrastRatio(opaque(t), opaque(s));
        expect(ratio, `--${t} on --${s} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('the text tiers keep their order (text-1 > text-2 > text-3 on every surface)', () => {
    for (const s of SURFACE_TOKENS) {
      const c1 = contrastRatio(opaque('text-1'), opaque(s));
      const c2 = contrastRatio(opaque('text-2'), opaque(s));
      const c3 = contrastRatio(opaque('text-3'), opaque(s));
      expect(c1).toBeGreaterThan(c2);
      expect(c2).toBeGreaterThan(c3);
      expect(c1).toBeGreaterThanOrEqual(7); // AAA for primary text
    }
  });

  it('text on ember (primary buttons, pressed and hover too) reaches AA', () => {
    for (const bg of ['ember', 'ember-strong', 'ember-deep']) {
      expect(contrastRatio(opaque('text-on-ember'), opaque(bg)), bg).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('control outlines reach the 3:1 non-text contrast on the surfaces controls sit on', () => {
    for (const s of ['ink', 'surface-1', 'surface-2', 'surface-3']) {
      expect(contrastRatio(opaque('line-control'), opaque(s)), s).toBeGreaterThanOrEqual(3);
    }
  });

  it('hairlines are visible but quiet', () => {
    for (const s of SURFACE_TOKENS) {
      const bg = opaque(s);
      const thin = contrastRatio(composite(parseColor(vars.hairline!), bg), bg);
      const strong = contrastRatio(composite(parseColor(vars['hairline-strong']!), bg), bg);
      expect(thin).toBeGreaterThan(1.15);
      expect(thin).toBeLessThan(1.6);
      expect(strong).toBeGreaterThan(thin);
    }
  });

  it('surfaces lift the ink step by step and keep its hue', () => {
    const ink = rgbToOklch(hexToRgb(vars.ink!));
    let prev = ink.l;
    for (const s of ['surface-1', 'surface-2', 'surface-3', 'surface-4']) {
      const o = rgbToOklch(opaque(s));
      expect(o.l).toBeGreaterThan(prev);
      expect(Math.abs(o.h - ink.h)).toBeLessThan(15);
      prev = o.l;
    }
  });

  it('player 2 cyan is the ember complement and clearly distinct from player 1', () => {
    const e = rgbToOklch(opaque('ember'));
    const c = rgbToOklch(opaque('cyan'));
    expect(180 - hueDist(c.h, e.h)).toBeLessThan(12); // within 12 deg of exactly opposite
    expect(vars.p1).toBe('var(--ember)');
    expect(vars.p2).toBe('var(--cyan)');
  });

  it('success, warning and error are distinct hues from ember and from each other', () => {
    const hue = (n: string): number => rgbToOklch(opaque(n)).h;
    const names = ['ember', 'success', 'warning', 'error', 'cyan'];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        expect(hueDist(hue(names[i]!), hue(names[j]!)), `${names[i]} vs ${names[j]}`).toBeGreaterThan(14);
      }
    }
  });

  it('colour maths round-trips the source colours', () => {
    for (const hex of ['#07070d', '#ff6b35', '#3ed1f6', '#ffffff', '#000000']) {
      expect(oklchToHex(rgbToOklch(hexToRgb(hex)))).toBe(hex);
    }
    expect(rgbToHex(hexToRgb('#abc'))).toBe('#aabbcc');
    expect(contrastRatio(hexToRgb('#000000'), hexToRgb('#ffffff'))).toBeCloseTo(21, 5);
    expect(() => hexToRgb('#12')).toThrow();
  });
});

describe('UIX-01 tokens: one file, nothing undefined', () => {
  it('only tokens.css defines design tokens (components.css defines just the slider-internal --f)', () => {
    const defs = [...componentsCss.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(new Set(defs)).toEqual(new Set(['--f']));
    expect(Object.keys(vars).length).toBeGreaterThan(80);
  });

  it('every var(--x) used by the design-system CSS and the existing UI code is defined', () => {
    const viewport = parseRootVars(viewportCss);
    const defined = new Set([...Object.keys(vars), ...Object.keys(viewport), 'f']);
    const used = new Set<string>();
    for (const css of [tokensCss, componentsCss]) {
      for (const m of css.matchAll(/var\(--([a-z0-9-]+)/g)) used.add(m[1]!);
    }
    // Names other agents' files rely on (src/ui/**, touch overlay).
    for (const n of [
      'ember', 'space-6', 'font-num', 'target', 'space-4', 'text-2', 'text-1', 'space-5', 'ink', 'hairline', 'fs-sm',
      'font-ui', 'ease', 'dk-ember', 'text-3', 'surface-1', 'space-3', 'scrim', 'radius', 'fs-md', 'dur-fast',
      'text-on-ember', 'surface-3', 'surface-2', 'space-2', 'radius-lg', 'p2', 'p1', 'hairline-strong', 'fs-xl',
      'fs-lg', 'fs-hero', 'focus-ring', 'dk-text', 'dk-ink', 'cyan',
    ]) used.add(n);
    for (const n of used) expect(defined.has(n), `--${n}`).toBe(true);
  });

  it('the minimum touch target is 60 pt and every interactive component uses it', () => {
    expect(vars.target).toBe('60px');
    const css = componentsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const block = (sel: string): string => {
      const re = new RegExp(`(^|\\n)${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
      const m = re.exec(css);
      if (!m) throw new Error(`no rule for ${sel}`);
      return m[2]!;
    };
    for (const sel of ['.btn', '.ctl', '.tab', '.lst__row', '.card', '.sel__arrow', '.seg__opt']) {
      expect(block(sel), sel).toMatch(/min-height:\s*var\(--target\)/);
    }
    // The slider row: head + 40 px hit zone + padding >= 60.
    expect(block('.sld__hit')).toMatch(/height:\s*40px/);
  });

  it('regression: clipped components (tabs, lists) never collapse to zero height in a short (21:9) flex column', () => {
    const css = componentsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const sel of ['.tabs', '.lst']) {
      const m = new RegExp(`(^|\\n)\\${sel}\\s*\\{([^}]*)\\}`).exec(css);
      expect(m, sel).not.toBeNull();
      expect(m![2], sel).toMatch(/overflow/);
      expect(m![2], sel).toMatch(/flex-shrink:\s*0/);
    }
    // Long content scrolls inside .ui-scroll, which opts back into vertical touch panning.
    expect(css).toMatch(/\.ui-scroll\s*\{[^}]*overflow-y:\s*auto[^}]*touch-action:\s*pan-y/);
  });

  it('component motion animates transform and opacity only (no layout properties in transitions or keyframes)', () => {
    const css = componentsCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const layout = /\b(width|height|left|right|top|bottom|margin|padding)\b/;
    for (const m of css.matchAll(/transition:\s*([^;]+);/g)) expect(m[1], m[0]).not.toMatch(layout);
    for (const m of css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\}\s*\}/g)) {
      const props = [...m[1]!.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      for (const p of props) expect(['opacity', 'transform']).toContain(p);
    }
  });
});
