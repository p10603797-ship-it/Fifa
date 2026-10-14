/**
 * GFX-08: colour maths (CIE Lab, CIEDE2000 against the published Sharma 2005 test pairs, WCAG contrast, gamut-safe
 * LCh) and the kit rasteriser primitives (exact-area polygon coverage, holes, clipping, square-wave coverage,
 * distance-field strokes, compositing, linear-light mip chain) and the shirt-number digits.
 */
import { describe, expect, it } from 'vitest';
import {
  contrastRatio, deltaE2000Lab, deltaE76, labInGamut, labToLch, labToRgb, lchToLab, lchToRgb, luminance, mixRgb, rgbToLab,
} from '../../src/render/kit/colour';
import { DIGIT_STROKES, DIGIT_W, numberLines, numberWidthEm, renderNumber } from '../../src/render/kit/glyphs';
import {
  blendMask, buildMips, createImg, createMask, createMipLevels, fillRect, fillShape, squareWaveCoverage, strokeLines,
} from '../../src/render/kit/raster';
import { colourDistance } from '../../src/render/kits';

function maskSum(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]!;
  return s;
}

describe('GFX-08 colour maths', () => {
  // Sharma, Wu, Dalal (2005) "The CIEDE2000 color-difference formula" test data (pairs 1-3, 7-15, 17-21, 24-33).
  const SHARMA: [number, number, number, number, number, number, number][] = [
    [50, 2.6772, -79.7751, 50, 0, -82.7485, 2.0425],
    [50, 3.1571, -77.2803, 50, 0, -82.7485, 2.8615],
    [50, 2.8361, -74.02, 50, 0, -82.7485, 3.4412],
    [50, 0, 0, 50, -1, 2, 2.3669],
    [50, -1, 2, 50, 0, 0, 2.3669],
    [50, 2.49, -0.001, 50, -2.49, 0.0009, 7.1792],
    [50, 2.49, -0.001, 50, -2.49, 0.001, 7.1792],
    [50, 2.49, -0.001, 50, -2.49, 0.0011, 7.2195],
    [50, 2.49, -0.001, 50, -2.49, 0.0012, 7.2195],
    [50, -0.001, 2.49, 50, 0.0009, -2.49, 4.8045],
    [50, -0.001, 2.49, 50, 0.001, -2.49, 4.8045],
    [50, -0.001, 2.49, 50, 0.0011, -2.49, 4.7461],
    [50, 2.5, 0, 73, 25, -18, 27.1492],
    [50, 2.5, 0, 61, -5, 29, 22.8977],
    [50, 2.5, 0, 56, -27, -3, 31.903],
    [50, 2.5, 0, 58, 24, 15, 19.4535],
    [50, 2.5, 0, 50, 3.1736, 0.5854, 1.0],
    [60.2574, -34.0099, 36.2677, 60.4626, -34.1751, 39.4387, 1.2644],
    [63.0109, -31.0961, -5.8663, 62.8187, -29.7946, -4.0864, 1.263],
    [61.2901, 3.7196, -5.3901, 61.4292, 2.248, -4.962, 1.8731],
    [35.0831, -44.1164, 3.7933, 35.0232, -40.0716, 1.5901, 1.8645],
    [22.7233, 20.0904, -46.694, 23.0331, 14.973, -42.5619, 2.0373],
    [36.4612, 47.858, 18.3852, 36.2715, 50.5065, 21.2231, 1.4146],
    [90.8027, -2.0831, 1.441, 91.1528, -1.6435, 0.0447, 1.4441],
    [90.9257, -0.5406, -0.9208, 88.6381, -0.8985, -0.7239, 1.5381],
    [6.7747, -0.2908, -2.4247, 5.8714, -0.0985, -2.2286, 0.6377],
    [2.0776, 0.0795, -1.135, 0.9033, -0.0636, -0.5514, 0.9082],
  ];

  it('CIEDE2000 reproduces the Sharma 2005 reference values (and is symmetric)', () => {
    for (const [L1, a1, b1, L2, a2, b2, want] of SHARMA) {
      const p = { L: L1, a: a1, b: b1 }, q = { L: L2, a: a2, b: b2 };
      expect(deltaE2000Lab(p, q)).toBeCloseTo(want, 4);
      expect(deltaE2000Lab(q, p)).toBeCloseTo(want, 4);
    }
  });

  it('sRGB -> Lab anchors and round trips', () => {
    const w = rgbToLab(0xffffff), k = rgbToLab(0x000000);
    expect(w.L).toBeCloseTo(100, 3); expect(Math.abs(w.a)).toBeLessThan(0.01); expect(Math.abs(w.b)).toBeLessThan(0.01);
    expect(k.L).toBeCloseTo(0, 6);
    const red = rgbToLab(0xff0000);
    expect(red.L).toBeCloseTo(53.24, 1); expect(red.a).toBeCloseTo(80.09, 1); expect(red.b).toBeCloseTo(67.2, 1);
    for (const c of [0x000000, 0xffffff, 0xd7263d, 0x14213d, 0x4a9440, 0xe4ff1a, 0x7f7f7f, 0x123456, 0xfedcba]) {
      expect(labToRgb(rgbToLab(c))).toBe(c);
    }
  });

  it('colourDistance: 0 for identical, 1 for black/white, symmetric; CIE76 sanity', () => {
    expect(colourDistance(0xd7263d, 0xd7263d)).toBe(0);
    expect(colourDistance(0x000000, 0xffffff)).toBeCloseTo(1, 3);
    expect(colourDistance(0x1f4fd1, 0xffd23f)).toBeCloseTo(colourDistance(0xffd23f, 0x1f4fd1), 12);
    expect(deltaE76(0x000000, 0xffffff)).toBeCloseTo(100, 3);
  });

  it('WCAG luminance and contrast', () => {
    expect(luminance(0xffffff)).toBeCloseTo(1, 6);
    expect(luminance(0x000000)).toBe(0);
    expect(contrastRatio(0xffffff, 0x000000)).toBeCloseTo(21, 6);
    expect(contrastRatio(0x777777, 0x777777)).toBe(1);
  });

  it('LCh -> sRGB keeps lightness and hue while reducing out-of-gamut chroma', () => {
    const lab = rgbToLab(0x1f4fd1);
    const l = labToLch(lab);
    const back = lchToLab(l);
    expect(back.a).toBeCloseTo(lab.a, 6);
    expect(back.b).toBeCloseTo(lab.b, 6);
    const wild = { L: 60, C: 300, h: 140 }; // far outside sRGB
    expect(labInGamut(lchToLab(wild))).toBe(false);
    const c = lchToRgb(wild);
    const got = labToLch(rgbToLab(c));
    expect(got.L).toBeCloseTo(60, 0);
    expect(Math.abs(got.h - 140)).toBeLessThan(4);
    expect(got.C).toBeGreaterThan(20);
    expect(mixRgb(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });
});

describe('GFX-08 rasteriser', () => {
  it('polygon coverage equals the exact area at any sub-pixel offset', () => {
    for (const off of [0, 0.25, 0.5, 0.73]) {
      const m = createMask(16, 16);
      fillShape(m, [[2 + off, 3 + off, 9.5 + off, 3 + off, 9.5 + off, 8 + off, 2 + off, 8 + off]], 0, 0, 1, 1);
      expect(maskSum(m.a)).toBeCloseTo(7.5 * 5, 4);
    }
    const tri = createMask(20, 20);
    fillShape(tri, [[1, 1, 17, 1, 1, 13]], 0, 0, 1, 1);
    expect(maskSum(tri.a)).toBeCloseTo((16 * 12) / 2, 4);
  });

  it('a circle covers pi r^2; a hole with opposite winding is empty; winding direction does not matter', () => {
    const circ = (r: number, rev: boolean): number[] => {
      const p: number[] = [];
      for (let i = 0; i < 96; i++) { const a = ((rev ? -i : i) / 96) * Math.PI * 2; p.push(20 + r * Math.cos(a), 20 + r * Math.sin(a)); }
      return p;
    };
    const m = createMask(40, 40);
    fillShape(m, [circ(15, false)], 0, 0, 1, 1);
    expect(maskSum(m.a)).toBeCloseTo(Math.PI * 225, -1);
    const ring = createMask(40, 40);
    fillShape(ring, [circ(15, false), circ(8, true)], 0, 0, 1, 1);
    expect(maskSum(ring.a)).toBeCloseTo(Math.PI * (225 - 64), -1);
    expect(ring.a[20 * 40 + 20]).toBe(0);
    const ccw = createMask(40, 40);
    fillShape(ccw, [circ(15, true)], 0, 0, 1, 1);
    expect(maskSum(ccw.a)).toBeCloseTo(maskSum(m.a), 4);
  });

  it('shapes partly outside the mask are clipped, not distorted', () => {
    const m = createMask(10, 10);
    fillShape(m, [[-5, -5, 5, -5, 5, 5, -5, 5]], 0, 0, 1, 1); // only the 5 x 5 inside quarter shows
    expect(maskSum(m.a)).toBeCloseTo(25, 4);
    const r = createMask(10, 10);
    fillShape(r, [[6, 2, 30, 2, 30, 4, 6, 4]], 0, 0, 1, 1); // runs off the right edge
    expect(maskSum(r.a)).toBeCloseTo(4 * 2, 4);
    // Transform: scale 2 and offset.
    const t = createMask(20, 20);
    fillShape(t, [[0, 0, 3, 0, 3, 2, 0, 2]], 1, 1, 2, 2);
    expect(maskSum(t.a)).toBeCloseTo(24, 4);
  });

  it('squareWaveCoverage is the exact box-filtered duty', () => {
    expect(squareWaveCoverage(0, 10, 10, 0, 0.5)).toBeCloseTo(0.5, 12);
    expect(squareWaveCoverage(0, 5, 10, 0, 0.5)).toBeCloseTo(1, 12);
    expect(squareWaveCoverage(5, 10, 10, 0, 0.5)).toBeCloseTo(0, 12);
    expect(squareWaveCoverage(4, 6, 10, 0, 0.5)).toBeCloseTo(0.5, 12);
    expect(squareWaveCoverage(100, 300, 21.3, 7, 0.3)).toBeCloseTo(0.3, 1);
    expect(squareWaveCoverage(3, 3, 10, 0, 0.5)).toBe(0);
  });

  it('strokes: round caps, symmetric coverage, outline ring wider than the fill', () => {
    const f = createMask(40, 20), o = createMask(40, 20);
    strokeLines(f, [[5, 10, 35, 10]], 0, 0, 1, 3, o, 2);
    // Area of a capsule: 30 x 6 + pi 3^2.
    expect(maskSum(f.a)).toBeCloseTo(30 * 6 + Math.PI * 9, -1);
    expect(maskSum(o.a)).toBeCloseTo(30 * 10 + Math.PI * 25, -1);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) {
      expect(f.a[y * 40 + x]).toBeCloseTo(f.a[(19 - y) * 40 + x]!, 5);
      expect(o.a[y * 40 + x]!).toBeGreaterThanOrEqual(f.a[y * 40 + x]! - 1e-6);
    }
  });

  it('blendMask composites source-over in straight alpha', () => {
    const img = createImg(4, 1);
    fillRect(img, 0, 0, 2, 1, 0x000000); // opaque black on the left, transparent on the right
    const m = createMask(4, 1);
    m.a.set([1, 0.5, 1, 0.5]);
    blendMask(img, 0, 0, m, 0xffffff);
    expect(Array.from(img.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(img.data.subarray(4, 8))).toEqual([128, 128, 128, 255]);
    expect(Array.from(img.data.subarray(8, 12))).toEqual([255, 255, 255, 255]);
    expect(Array.from(img.data.subarray(12, 16))).toEqual([255, 255, 255, 128]); // colour kept, alpha 0.5 (no dark fringe)
  });

  it('mip chain: GL row order, linear-light box filter, alpha-weighted colour, exact level sizes', () => {
    const img = createImg(64, 64);
    fillRect(img, 0, 0, 32, 64, 0x000000);
    fillRect(img, 32, 0, 32, 64, 0xffffff);
    fillRect(img, 0, 0, 64, 1, 0xff0000); // top row red: becomes the LAST row in GL order
    const lv = createMipLevels(64, 64, 6);
    buildMips(img, lv);
    expect(lv.map((l) => `${l.width}x${l.height}`)).toEqual(['64x64', '32x32', '16x16', '8x8', '4x4', '2x2']);
    const l0 = lv[0]!.data;
    expect(Array.from(l0.subarray(63 * 64 * 4, 63 * 64 * 4 + 4))).toEqual([255, 0, 0, 255]);
    expect(Array.from(l0.subarray(0, 4))).toEqual([0, 0, 0, 255]);
    // Black / white halves never mix: tile boundary at 32 stays sharp down to the 2 x 2 level.
    const l5 = lv[5]!.data;
    expect(l5[0]).toBe(0); expect(l5[4]).toBe(255);
    // A 50 % checker averages in linear light (sRGB 188), not in sRGB (128).
    const ck = createImg(2, 2);
    fillRect(ck, 0, 0, 1, 1, 0xffffff); fillRect(ck, 1, 1, 1, 1, 0xffffff); fillRect(ck, 1, 0, 1, 1, 0x000000); fillRect(ck, 0, 1, 1, 1, 0x000000);
    const cl = createMipLevels(2, 2, 2);
    buildMips(ck, cl);
    expect(cl[1]!.data[0]).toBeGreaterThanOrEqual(186);
    expect(cl[1]!.data[0]).toBeLessThanOrEqual(189);
    // A transparent neighbour does not darken a red texel.
    const tr = createImg(2, 2);
    fillRect(tr, 0, 0, 1, 1, 0xff0000);
    const tl = createMipLevels(2, 2, 2);
    buildMips(tr, tl);
    expect(Array.from(tl[1]!.data)).toEqual([255, 0, 0, 64]);
  });
});

describe('GFX-08 shirt-number digits', () => {
  it('every digit is a distinct, non-empty bold glyph inside its box', () => {
    const masks = [];
    for (let d = 0; d <= 9; d++) {
      const m = renderNumber(d, 40, 0);
      const sum = maskSum(m.fill.a);
      expect(sum).toBeGreaterThan(40 * 40 * DIGIT_W * 0.18);
      masks.push(m);
      for (const l of DIGIT_STROKES[d]!) {
        for (let i = 0; i < l.length; i += 2) {
          expect(l[i]!).toBeGreaterThanOrEqual(0.08); expect(l[i]!).toBeLessThanOrEqual(DIGIT_W - 0.08);
          expect(l[i + 1]!).toBeGreaterThanOrEqual(0.08); expect(l[i + 1]!).toBeLessThanOrEqual(0.92);
        }
      }
    }
    // Pairwise: at least 12 % of the glyph area differs (no two digits look alike).
    for (let i = 0; i <= 9; i++) for (let j = i + 1; j <= 9; j++) {
      const a = masks[i]!.fill.a, b = masks[j]!.fill.a;
      let diff = 0;
      for (let k = 0; k < a.length; k++) diff += Math.abs(a[k]! - b[k]!);
      expect(diff / Math.max(maskSum(a), maskSum(b))).toBeGreaterThan(0.12);
    }
  });

  it('numbers 1..99 lay out in their box; the outline surrounds the fill', () => {
    for (let n = 1; n <= 99; n++) {
      const w = numberWidthEm(n);
      for (const l of numberLines(n)) for (let i = 0; i < l.length; i += 2) {
        expect(l[i]!).toBeGreaterThanOrEqual(0); expect(l[i]!).toBeLessThanOrEqual(w);
      }
    }
    const m = renderNumber(88, 30, 2);
    expect(m.w).toBeGreaterThan(m.h);
    expect(maskSum(m.outline.a)).toBeGreaterThan(maskSum(m.fill.a) * 1.3);
    // Edges of the mask stay empty (padding), so blits never cut a glyph.
    for (let x = 0; x < m.w; x++) { expect(m.outline.a[x]).toBe(0); expect(m.outline.a[(m.h - 1) * m.w + x]).toBe(0); }
  });
});
