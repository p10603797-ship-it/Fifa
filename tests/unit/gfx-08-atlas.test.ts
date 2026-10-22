/**
 * GFX-08: the generated kit atlas (layout, patterns, numbers baked on the back and chest, number cells, shorts,
 * socks, crests, the linear-light per-tile mip chain, determinism, cost), the per-instance UV lookups (and that they
 * allocate nothing), the three.js glue (DataTexture with manual mips, material patch, instanced attribute), the
 * KitSet convenience, shirt numbers from the match state, and crests (SVG for menus / HUD, cached data URLs).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinearMipmapLinearFilter, MeshLambertMaterial, SRGBColorSpace } from 'three';
import { describe, expect, it } from 'vitest';
import type { Kit } from '../../src/contracts/data';
import { KitPattern, KitSlot } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { chB, chG, chR } from '../../src/render/kit/colour';
import { clipConvex, crestLayers, crestOutline, emblemShapes, insetConvex } from '../../src/render/kit/crest';
import {
  KIT_ATLAS_H, KIT_ATLAS_LEVELS, KIT_ATLAS_W, KIT_UV_ATTRIBUTE, MAX_ATLAS_NUMBERS, NUMBER_ATLAS_COLS, NUMBER_ATLAS_LEVELS,
  NUMBER_GLYPH_H, NUMBER_GLYPH_W, SHIRT_TILE_H, SHIRT_TILE_W, applyKitUv, createKitAtlas, createKitNumberAtlas, createKitSet,
  createKitTexture, createKitUvAttribute, crestDataUrl, crestSvg, drawKitAtlas, kitDataUrl, kitSvg, matchShirtNumbers,
  numberCellRect, resolveKits, shirtTileRect, type KitAtlas, type MatchKits,
} from '../../src/render/kits';
import type { NumberAtlas } from '../../src/render/players/model';
import { initMatch } from '../../src/sim/init';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Sum of absolute channel differences. */
function colourDistanceProxy(a: number[], b: number[]): number {
  return Math.abs(a[0]! - b[0]!) + Math.abs(a[1]! - b[1]!) + Math.abs(a[2]! - b[2]!);
}

function px(atlas: KitAtlas, x: number, y: number): [number, number, number, number] {
  const o = (y * atlas.width + x) * 4;
  const d = atlas.image.data;
  return [d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!];
}
function near(p: [number, number, number, number], rgb: number, tol = 3): boolean {
  return Math.abs(p[0] - chR(rgb)) <= tol && Math.abs(p[1] - chG(rgb)) <= tol && Math.abs(p[2] - chB(rgb)) <= tol;
}
function kitsWith(home: Kit, away: Kit): MatchKits {
  const r = resolveKits(null, null, KitSlot.HOME, KitSlot.AWAY);
  r.outfield = [home, away];
  return r;
}
const kitOf = (shirt: number, pattern: KitPattern, shirt2: number, number = 0xffffff): Kit =>
  ({ shirt, shirt2, pattern, shorts: 0x141414, socks: shirt, number });

describe('GFX-08 atlas layout', () => {
  it('fits 2048 x 2048, regions are 32-px aligned and never overlap', () => {
    expect(KIT_ATLAS_W).toBeLessThanOrEqual(2048);
    expect(KIT_ATLAS_H).toBeLessThanOrEqual(2048);
    const rects: { x: number; y: number; w: number; h: number; name: string }[] = [];
    for (let v = 0; v < 4; v++) {
      for (let t = 0; t < 24; t++) rects.push({ ...shirtTileRect(v, t), name: `shirt ${v}/${t}` });
      for (let c = 0; c < 24; c++) rects.push({ ...numberCellRect(v, c), name: `num ${v}/${c}` });
      rects.push({ x: v * 64, y: 768, w: 64, h: 64, name: `shorts ${v}` }, { x: 256 + v * 64, y: 768, w: 64, h: 64, name: `socks ${v}` });
    }
    rects.push({ x: 512, y: 768, w: 64, h: 64, name: 'crest0' }, { x: 576, y: 768, w: 64, h: 64, name: 'crest1' }, { x: 640, y: 768, w: 64, h: 64, name: 'white' });
    const occ = new Uint8Array(KIT_ATLAS_W * KIT_ATLAS_H);
    for (const r of rects) {
      expect(r.x % 32, r.name).toBe(0); expect(r.y % 32, r.name).toBe(0);
      expect(r.w % 32, r.name).toBe(0); expect(r.h % 32, r.name).toBe(0);
      expect(r.x + r.w, r.name).toBeLessThanOrEqual(KIT_ATLAS_W); expect(r.y + r.h, r.name).toBeLessThanOrEqual(KIT_ATLAS_H);
      for (let y = r.y; y < r.y + r.h; y += 8) for (let x = r.x; x < r.x + r.w; x += 8) {
        expect(occ[y * KIT_ATLAS_W + x], r.name).toBe(0);
        occ[y * KIT_ATLAS_W + x] = 1;
      }
    }
  });

  it('memory: one 1024 x 1024 RGBA texture with 6 levels is about 5.3 MB (budget 64 MB for all textures)', () => {
    const atlas = createKitAtlas();
    let bytes = 0;
    for (const l of atlas.mips) bytes += l.data.byteLength;
    expect(atlas.mips.length).toBe(KIT_ATLAS_LEVELS);
    expect(bytes).toBeLessThan(6 * 1024 * 1024);
  });
});

describe('GFX-08 atlas drawing', () => {
  const RED = 0xd7263d, WHITE = 0xf6f6f2, NAVY = 0x14213d, GOLD = 0xf2a900;

  function drawn(home: Kit, away: Kit, numbers: number[][] = [[10, 7], [9]]): KitAtlas {
    const atlas = createKitAtlas();
    drawKitAtlas(atlas, kitsWith(home, away), numbers, [CLUBS[0]!.crest, CLUBS[1]!.crest]);
    return atlas;
  }

  it('plain shirt: shirt colour everywhere below the collar, trim collar on top', () => {
    const a = drawn(kitOf(RED, KitPattern.PLAIN, GOLD), kitOf(WHITE, KitPattern.PLAIN, NAVY, NAVY));
    const t = shirtTileRect(0, 0);
    expect(near(px(a, t.x + 10, t.y + 50), RED)).toBe(true);
    expect(near(px(a, t.x + 100, t.y + 50), RED)).toBe(true);
    expect(near(px(a, t.x + 70, t.y + 1), GOLD)).toBe(true);
  });

  it('stripes: chest centre (u 0.25) and back centre (u 0.75) are primary stripes, a stripe width over is shirt2', () => {
    const a = drawn(kitOf(NAVY, KitPattern.STRIPES, WHITE), kitOf(WHITE, KitPattern.PLAIN, NAVY, NAVY));
    const t = shirtTileRect(0, 0), sw = SHIRT_TILE_W / 12;
    const y = t.y + 58;
    expect(near(px(a, t.x + 32, y), NAVY)).toBe(true);
    expect(near(px(a, t.x + 96, y), NAVY)).toBe(true);
    expect(near(px(a, Math.round(t.x + 32 + sw), y), WHITE)).toBe(true);
    // Seamless wrap: both edges of the tile (the right side seam) are the same stripe.
    const l = px(a, t.x, y), r = px(a, t.x + SHIRT_TILE_W - 1, y);
    expect(Math.abs(l[0] - r[0]) + Math.abs(l[1] - r[1]) + Math.abs(l[2] - r[2])).toBeLessThan(40);
  });

  it('hoops: horizontal bands alternate down the shirt', () => {
    const a = drawn(kitOf(0x5ec8f2, KitPattern.HOOPS, 0xffd23f, 0x14213d), kitOf(NAVY, KitPattern.PLAIN, WHITE));
    const t = shirtTileRect(0, 0), band = SHIRT_TILE_H / 8;
    const x = t.x + 60;
    expect(near(px(a, x, t.y + Math.round(band * 0.5) + 1), 0x5ec8f2)).toBe(true);
    expect(near(px(a, x, t.y + Math.round(band * 1.5)), 0xffd23f)).toBe(true);
    expect(near(px(a, x, t.y + Math.round(band * 2.5)), 0x5ec8f2)).toBe(true);
  });

  it('halves: the right half (u 0..0.25 and 0.75..1) is primary, the left half is shirt2', () => {
    const a = drawn(kitOf(RED, KitPattern.HALVES, WHITE), kitOf(NAVY, KitPattern.PLAIN, WHITE));
    const t = shirtTileRect(0, 0), y = t.y + 60;
    expect(near(px(a, t.x + 8, y), RED)).toBe(true);
    expect(near(px(a, t.x + 120, y), RED)).toBe(true);
    expect(near(px(a, t.x + 64, y), WHITE)).toBe(true);
  });

  it('sash: a band from the left shoulder to the right hip, continuous over the shoulder and round the side', () => {
    const a = drawn(kitOf(WHITE, KitPattern.SASH, RED, 0x14213d), kitOf(NAVY, KitPattern.PLAIN, WHITE));
    const t = shirtTileRect(0, 0);
    expect(near(px(a, t.x + 32, t.y + 32), RED)).toBe(true); // front panel, on the diagonal x + y = 64
    expect(near(px(a, t.x + 96, t.y + 32), RED)).toBe(true); // back panel, on x - y = 64
    expect(near(px(a, t.x + 32, t.y + 6 + 50), WHITE)).toBe(true);
    expect(near(px(a, t.x + 4, t.y + 62), RED)).toBe(true); // right hip, front
    expect(near(px(a, t.x + 124, t.y + 62), RED)).toBe(true); // right hip, back (seam)
  });

  it('numbered tiles: big number on the back, small on the chest, outlined; the plain tile has none', () => {
    const a = drawn(kitOf(RED, KitPattern.PLAIN, GOLD, 0xffffff), kitOf(WHITE, KitPattern.PLAIN, NAVY, NAVY), [[10], [7]]);
    const count = (t: { x: number; y: number }, x0: number, x1: number, rgb: number): number => {
      let n = 0;
      for (let y = t.y + 6; y < t.y + SHIRT_TILE_H; y++) for (let x = t.x + x0; x < t.x + x1; x++) if (near(px(a, x, y), rgb, 10)) n++;
      return n;
    };
    const plain = shirtTileRect(0, 0), ten = shirtTileRect(0, 1);
    expect(count(plain, 64, 128, 0xffffff)).toBe(0);
    expect(count(ten, 64, 128, 0xffffff)).toBeGreaterThan(150); // back
    expect(count(ten, 64, 128, 0x111111)).toBeGreaterThan(60); // dark outline round a light number
    expect(count(ten, 0, 64, 0xffffff)).toBeGreaterThan(20); // chest
    // Away (white shirt, navy number): a light outline is used for the dark number.
    const seven = shirtTileRect(2, 1);
    let navy = 0;
    for (let y = seven.y + 10; y < seven.y + 50; y++) for (let x = seven.x + 80; x < seven.x + 112; x++) if (near(px(a, x, y), NAVY, 12)) navy++;
    expect(navy).toBeGreaterThan(80);
  });

  it('number cells: transparent background, opaque outlined number, blank cell 0', () => {
    const a = drawn(kitOf(RED, KitPattern.PLAIN, GOLD), kitOf(WHITE, KitPattern.PLAIN, NAVY, NAVY), [[10], [7]]);
    const blank = numberCellRect(0, 0), ten = numberCellRect(0, 1);
    let opaque = 0, blankOpaque = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
      if (px(a, ten.x + x, ten.y + y)[3] > 200) opaque++;
      if (px(a, blank.x + x, blank.y + y)[3] > 0) blankOpaque++;
    }
    expect(blankOpaque).toBe(0);
    expect(opaque).toBeGreaterThan(200);
    expect(px(a, ten.x + 1, ten.y + 1)[3]).toBe(0);
  });

  it('shorts with side stripes, socks with a band, crests and the white cell', () => {
    const home = { ...kitOf(RED, KitPattern.PLAIN, GOLD), shorts: WHITE, socks: RED };
    const a = drawn(home, kitOf(NAVY, KitPattern.PLAIN, WHITE));
    expect(near(px(a, 16, 768 + 32), WHITE)).toBe(true); // shorts body
    expect(near(px(a, 0, 768 + 32), GOLD)).toBe(true); // right-side stripe (u 0)
    expect(near(px(a, 31, 768 + 32), GOLD)).toBe(true); // left-side stripe (u 0.5)
    expect(near(px(a, 256 + 32, 768 + 40), RED)).toBe(true); // sock
    expect(near(px(a, 256 + 32, 768 + 8), GOLD)).toBe(true); // sock band
    expect(near(px(a, 640 + 32, 768 + 32), 0xffffff, 0)).toBe(true);
    // Crest cell: transparent corner, opaque centre.
    expect(px(a, 512 + 32, 768 + 32)[3]).toBe(255);
    expect(px(a, 512, 768)[3]).toBe(0);
  });

  it('mips: per-tile filtering, no bleeding between neighbouring kits down to the last level', () => {
    const a = drawn(kitOf(RED, KitPattern.PLAIN, RED), kitOf(NAVY, KitPattern.PLAIN, NAVY), [[], []]);
    const last = a.mips[KIT_ATLAS_LEVELS - 1]!;
    const scale = 1 << (KIT_ATLAS_LEVELS - 1);
    const sample = (x: number, yTop: number): number[] => {
      const lx = Math.floor(x / scale), ly = last.height - 1 - Math.floor(yTop / scale);
      const o = (ly * last.width + lx) * 4;
      return [last.data[o]!, last.data[o + 1]!, last.data[o + 2]!];
    };
    // Bottom row of the home keeper block (row 5) next to the top row of the away block (row 6): both stay pure.
    const homeK = shirtTileRect(1, 16), away = shirtTileRect(2, 0);
    const k = resolveKits(null, null, 0, 1).keeper[0].shirt;
    const kc = sample(homeK.x + 40, homeK.y + 40);
    expect(Math.abs(kc[0]! - chR(k)) + Math.abs(kc[1]! - chG(k)) + Math.abs(kc[2]! - chB(k))).toBeLessThan(12);
    const ac = sample(away.x + 40, away.y + 40);
    expect(Math.abs(ac[0]! - chR(NAVY)) + Math.abs(ac[1]! - chG(NAVY)) + Math.abs(ac[2]! - chB(NAVY))).toBeLessThan(12);
    // Shorts cells side by side (different kits) stay apart at the 2 x 2 level.
    const s0 = sample(32, 768 + 32), s2 = sample(2 * 64 + 32, 768 + 32);
    expect(colourDistanceProxy(s0, s2)).toBeGreaterThan(0);
  });

  it('deterministic: drawing the same match twice gives identical bytes in every level', () => {
    const k = resolveKits(CLUBS[4]!, CLUBS[9]!, 0, 1);
    const nums = [CLUBS[4]!.squad.map((p) => p.shirt), CLUBS[9]!.squad.map((p) => p.shirt)];
    const a = createKitAtlas(), b = createKitAtlas();
    drawKitAtlas(a, k, nums, [CLUBS[4]!.crest, CLUBS[9]!.crest]);
    drawKitAtlas(b, resolveKits(CLUBS[0]!, CLUBS[1]!, 0, 1), nums, [null, null]);
    drawKitAtlas(b, k, nums, [CLUBS[4]!.crest, CLUBS[9]!.crest]); // redraw over an older match
    for (let i = 0; i < KIT_ATLAS_LEVELS; i++) expect(Buffer.compare(Buffer.from(a.mips[i]!.data), Buffer.from(b.mips[i]!.data))).toBe(0);
    expect(b.version).toBe(2);
  });

  it('cost: drawing a match atlas stays well under a loading-screen budget (CPU time)', () => {
    const atlas = createKitAtlas();
    const k = resolveKits(CLUBS[2]!, CLUBS[7]!, 0, 1);
    const nums = [CLUBS[2]!.squad.map((p) => p.shirt), CLUBS[7]!.squad.map((p) => p.shirt)];
    drawKitAtlas(atlas, k, nums, [CLUBS[2]!.crest, CLUBS[7]!.crest]); // warm the JIT
    const c0 = process.cpuUsage();
    drawKitAtlas(atlas, k, nums, [CLUBS[2]!.crest, CLUBS[7]!.crest]);
    const ms = process.cpuUsage(c0).user / 1000;
    expect(ms).toBeLessThan(400);
  });
});

describe('GFX-08 UV lookups', () => {
  const atlas = createKitAtlas();
  const kits = resolveKits(CLUBS[0]!, CLUBS[1]!, 0, 1);
  drawKitAtlas(atlas, kits, [[1, 10, 23], [7, 99]], [null, null]);

  it('numbered shirt tile for a squad number, the plain tile otherwise; keepers use their own variant', () => {
    const out = new Float32Array(4);
    atlas.shirtUv(0, false, 10, out);
    const r = shirtTileRect(0, 2);
    expect(out[0]).toBeCloseTo(r.x / KIT_ATLAS_W, 6);
    expect(out[1]).toBeCloseTo(1 - (r.y + r.h - 0.5) / KIT_ATLAS_H, 6);
    expect(out[2]).toBeCloseTo(SHIRT_TILE_W / KIT_ATLAS_W, 6);
    expect(out[3]).toBeCloseTo((SHIRT_TILE_H - 1) / KIT_ATLAS_H, 6);
    const plain = new Float32Array(4), unknown = new Float32Array(4);
    atlas.plainShirtUv(0, false, plain);
    atlas.shirtUv(0, false, 55, unknown);
    expect(Array.from(unknown)).toEqual(Array.from(plain));
    atlas.shirtUv(0, false, 0, unknown);
    expect(Array.from(unknown)).toEqual(Array.from(plain));
    const keeper = new Float32Array(4);
    atlas.shirtUv(0, true, 10, keeper);
    expect(keeper[1]).not.toBeCloseTo(out[1]!, 4);
    atlas.shirtUv(1, false, 99, out, 0);
    const r99 = shirtTileRect(2, 2);
    expect(out[0]).toBeCloseTo(r99.x / KIT_ATLAS_W, 6);
  });

  it('every rect lies inside the texture; offsets write in place', () => {
    const out = new Float32Array(40).fill(-1);
    atlas.shortsUv(1, true, out, 4);
    atlas.socksUv(0, false, out, 8);
    atlas.crestUv(1, out, 12);
    atlas.whiteUv(out, 16);
    atlas.numberUv(1, false, 7, out, 20);
    atlas.numberUv(1, false, 8, out, 24); // not baked: blank cell
    expect(out[0]).toBe(-1);
    for (let o = 4; o < 28; o += 4) {
      expect(out[o]!).toBeGreaterThanOrEqual(0); expect(out[o + 1]!).toBeGreaterThanOrEqual(0);
      expect(out[o]! + out[o + 2]!).toBeLessThanOrEqual(1); expect(out[o + 1]! + out[o + 3]!).toBeLessThanOrEqual(1);
      expect(out[o + 2]!).toBeGreaterThan(0); expect(out[o + 3]!).toBeGreaterThan(0);
    }
    expect(out[24]).toBeCloseTo((numberCellRect(2, 0).x + 0.5) / KIT_ATLAS_W, 6);
  });

  it('the lookups allocate nothing (safe per frame)', () => {
    const r = spawnSync(process.execPath, [...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/gfx-08-alloc-probe.ts', '50000'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    expect(Object.keys(bytes).sort()).toEqual(['numberUv', 'shirtUv', 'shortsSocksCrestWhite']);
    for (const [name, b] of Object.entries(bytes)) expect(b, name).toBeLessThan(8);
  }, 150_000);
});

describe('GFX-08 three.js glue', () => {
  it('DataTexture over the manual mip chain: sRGB, trilinear, no generated mips, no flip', () => {
    const atlas = createKitAtlas();
    const tex = createKitTexture(atlas, 8);
    expect(tex.image.width).toBe(KIT_ATLAS_W);
    expect(tex.mipmaps.length).toBe(KIT_ATLAS_LEVELS);
    expect(tex.mipmaps[5]!.width).toBe(32);
    expect(tex.generateMipmaps).toBe(false);
    expect(tex.minFilter).toBe(LinearMipmapLinearFilter);
    expect(tex.colorSpace).toBe(SRGBColorSpace);
    expect(tex.flipY).toBe(false);
    expect(tex.anisotropy).toBe(8);
    expect(tex.version).toBeGreaterThan(0); // needsUpdate set
  });

  it('applyKitUv patches the vertex shader to read the per-instance rect', () => {
    const mat = new MeshLambertMaterial();
    applyKitUv(mat);
    const shader = { vertexShader: '#include <common>\nvoid main() {\n#include <uv_vertex>\n}', fragmentShader: '', uniforms: {} };
    (mat.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);
    expect(shader.vertexShader).toContain(`attribute vec4 ${KIT_UV_ATTRIBUTE};`);
    expect(shader.vertexShader).toContain(`vMapUv = ${KIT_UV_ATTRIBUTE}.xy + vMapUv * ${KIT_UV_ATTRIBUTE}.zw;`);
    expect(shader.vertexShader.indexOf('#include <uv_vertex>')).toBeLessThan(shader.vertexShader.indexOf('vMapUv ='));
    expect(mat.customProgramCacheKey()).toBe('dk-kit-uv');
    const attr = createKitUvAttribute(22);
    expect(attr.count).toBe(22);
    expect(attr.itemSize).toBe(4);
    expect(Array.from(attr.array.slice(0, 4))).toEqual([0, 0, 1, 1]);
  });

  it('KitSet: setMatch resolves, draws and flags the upload; high contrast toggles and reports changes', () => {
    const set = createKitSet();
    expect(set.kits).toBeNull();
    expect(set.setHighContrast(true)).toBe(false); // nothing to redraw yet
    const s = initMatch(createMatchConfig());
    const v0 = set.texture.version;
    const k = set.setMatch(s, CLUBS, false);
    expect(k.report.clean).toBe(true);
    expect(set.kits).toBe(k);
    expect(set.texture.version).toBeGreaterThan(v0);
    expect(set.atlas.numbers[0]!.length).toBeGreaterThanOrEqual(11);
    const v1 = set.texture.version;
    expect(set.setHighContrast(false)).toBe(false);
    expect(set.setHighContrast(true)).toBe(true);
    expect(set.kits!.highContrast).toBe(true);
    expect(set.texture.version).toBeGreaterThan(v1);
    set.dispose();
  });
});

describe('GFX-08 shirt numbers from the match', () => {
  it('starters, then the squad, unique and valid, capped per team', () => {
    const s = initMatch(createMatchConfig());
    const [h, a] = matchShirtNumbers(s, CLUBS);
    for (const list of [h, a]) {
      expect(new Set(list).size).toBe(list.length);
      for (const n of list) { expect(Number.isInteger(n)).toBe(true); expect(n).toBeGreaterThanOrEqual(1); expect(n).toBeLessThanOrEqual(99); }
      expect(list.length).toBeLessThanOrEqual(MAX_ATLAS_NUMBERS);
    }
    for (let i = 0; i < 22; i++) {
      const p = s.players[i]!;
      if (p.active !== 1) continue;
      expect((p.team === 0 ? h : a)).toContain(s.attrs[i]!.shirt);
    }
    expect(h).toEqual(expect.arrayContaining(CLUBS[0]!.squad.map((p) => p.shirt)));
    s.attrs[3]!.shirt = 0; s.attrs[4]!.shirt = 150; s.attrs[5]!.shirt = 7.5;
    const [h2] = matchShirtNumbers(s, CLUBS);
    expect(h2.every((n) => n >= 1 && n <= 99 && Number.isInteger(n))).toBe(true);
  });
});

describe('GFX-08 crests', () => {
  it('every club crest builds valid SVG with its colours; the data URL is cached and decodes to it', () => {
    for (const c of CLUBS) {
      const svg = crestSvg(c.crest, 48);
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="48" height="48">')).toBe(true);
      expect(svg.endsWith('</svg>')).toBe(true);
      expect(svg).toContain(`#${c.crest.primary.toString(16).padStart(6, '0')}`);
      expect(svg).toContain(`#${c.crest.secondary.toString(16).padStart(6, '0')}`);
      expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      expect((svg.match(/<path /g) ?? []).length).toBeGreaterThanOrEqual(3);
      const url = crestDataUrl(c);
      expect(url.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
      expect(crestDataUrl(c)).toBe(url);
      expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(crestSvg(c.crest, 128));
    }
    // Different designs, different URLs.
    expect(crestDataUrl(CLUBS[0]!)).not.toBe(crestDataUrl(CLUBS[1]!));
  });

  it('every shape / layout / emblem combination is finite and stays inside the 100 box', () => {
    for (let shape = 0; shape < 6; shape++) for (let layout = 0; layout < 4; layout++) for (let emblem = 0; emblem < 10; emblem++) {
      for (const l of crestLayers({ shape, layout, emblem, primary: 0x1f4fd1, secondary: 0xffd23f })) {
        for (const sh of l.shapes) for (const c of sh) {
          expect(c.length).toBeGreaterThanOrEqual(6);
          for (const v of c) { expect(Number.isFinite(v)).toBe(true); expect(v).toBeGreaterThanOrEqual(-0.01); expect(v).toBeLessThanOrEqual(100.01); }
        }
      }
    }
    // Hostile ids wrap, colours clamp.
    const odd = crestLayers({ shape: -7, layout: 99, emblem: NaN, primary: NaN, secondary: 0x2000000 });
    expect(odd.length).toBeGreaterThanOrEqual(3);
    expect(odd[0]!.rgb).toBe(0xffffff);
  });

  it('geometry helpers: inset shrinks a convex outline evenly; clipping a half-plane halves a square', () => {
    const sq = [0, 0, 100, 0, 100, 100, 0, 100];
    const ins = insetConvex(sq, 10);
    expect(ins.map((v) => Math.round(v))).toEqual([10, 10, 90, 10, 90, 90, 10, 90]);
    const insRev = insetConvex([0, 0, 0, 100, 100, 100, 100, 0], 10);
    expect(insRev.map((v) => Math.round(v))).toEqual([10, 10, 10, 90, 90, 90, 90, 10]);
    const half = clipConvex([50, -10, 110, -10, 110, 110, 50, 110], sq);
    let area = 0;
    for (let i = 0; i < half.length / 2; i++) {
      const j = (i + 1) % (half.length / 2);
      area += half[2 * i]! * half[2 * j + 1]! - half[2 * j]! * half[2 * i + 1]!;
    }
    expect(Math.abs(area / 2)).toBeCloseTo(5000, 6);
    expect(clipConvex([200, 200, 300, 200, 300, 300], sq)).toEqual([]);
    for (let s = 0; s < 6; s++) expect(crestOutline(s).length).toBeGreaterThanOrEqual(8);
    for (let e = 0; e < 10; e++) expect(emblemShapes(e).length).toBeGreaterThanOrEqual(1);
  });
});

describe('GFX-08 number glyph atlas (players/model.ts NumberAtlas)', () => {
  const na = createKitNumberAtlas();

  it('is a drop-in NumberAtlas: same grid and rect convention as the model expects', () => {
    const asModel: NumberAtlas = na; // compile-time: structural match with GFX-07's interface
    const out = [0, 0, 0, 0];
    expect(asModel.glyphRect(23, out, 0)).toBe(true);
    expect(out).toEqual([0.3, 1 - 0.3, 0.4, 1 - 0.2]);
    expect(na.glyphRect(0, out, 0)).toBe(false);
    expect(na.glyphRect(100, out, 0)).toBe(false);
    expect(na.glyphRect(7.5, out, 0)).toBe(false);
    expect(na.width / NUMBER_ATLAS_COLS / (na.height / NUMBER_ATLAS_COLS)).toBeCloseTo(NUMBER_GLYPH_W / NUMBER_GLYPH_H, 9);
    expect(NUMBER_GLYPH_W / NUMBER_GLYPH_H).toBeCloseTo(0.24 / 0.2, 9); // players/parts.ts NUMBER_PANEL w / h
    expect(na.texture.mipmaps.length).toBe(NUMBER_ATLAS_LEVELS);
    expect(na.texture.premultiplyAlpha).toBe(false);
    expect(na.texture.generateMipmaps).toBe(false);
  });

  it('premultiplied coverage: fill <= alpha everywhere; every number has fill and an outline ring', () => {
    const d = na.mips[0]!.data, w = na.width, h = na.height;
    let bad = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] !== d[i + 1] || d[i] !== d[i + 2] || d[i]! > d[i + 3]!) bad++;
    expect(bad).toBe(0);
    const problems: string[] = [];
    for (let n = 1; n <= 99; n++) {
      const col = n % 10, row = Math.floor(n / 10);
      let fill = 0, ring = 0, edge = 0;
      for (let y = 0; y < NUMBER_GLYPH_H; y++) for (let x = 0; x < NUMBER_GLYPH_W; x++) {
        const gy = h - 1 - (row * NUMBER_GLYPH_H + y); // GL order
        const o = (gy * w + col * NUMBER_GLYPH_W + x) * 4;
        if (d[o]! > 200) fill++;
        if (d[o + 3]! > 200 && d[o]! < 50) ring++;
        if ((x === 0 || y === 0 || x === NUMBER_GLYPH_W - 1 || y === NUMBER_GLYPH_H - 1) && d[o + 3]! > 0) edge++;
      }
      if (fill <= 250) problems.push(`${n} fill ${fill}`);
      if (ring <= 150) problems.push(`${n} outline ${ring}`);
      if (edge > 0) problems.push(`${n} touches the cell edge`);
    }
    expect(problems).toEqual([]);
  });

  it('mips average premultiplied values per glyph cell (no bleeding between cells)', () => {
    const last = na.mips[NUMBER_ATLAS_LEVELS - 1]!;
    const cw = NUMBER_GLYPH_W >> (NUMBER_ATLAS_LEVELS - 1), ch = NUMBER_GLYPH_H >> (NUMBER_ATLAS_LEVELS - 1);
    expect(Number.isInteger(cw) && Number.isInteger(ch)).toBe(true);
    // Cell 0 (unused) stays fully transparent at the last level.
    const top = last.height - ch;
    for (let y = top; y < last.height; y++) for (let x = 0; x < cw; x++) expect(last.data[(y * last.width + x) * 4 + 3]).toBe(0);
  });
});

describe('GFX-08 kit previews (menus)', () => {
  it('every club kit renders an SVG with its colours, pattern and an optional number; data URLs are cached', () => {
    for (const c of CLUBS) {
      for (const kit of [c.home, c.away, c.keeper, c.keeper2]) {
        const svg = kitSvg(kit, 96, 10);
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120"')).toBe(true);
        expect(svg).toContain(`#${kit.shirt.toString(16).padStart(6, '0')}`);
        expect(svg).toContain(`#${kit.shorts.toString(16).padStart(6, '0')}`);
        if (kit.pattern !== KitPattern.PLAIN) expect(svg).toContain(`#${kit.shirt2.toString(16).padStart(6, '0')}`);
        expect(svg).not.toMatch(/NaN|undefined|Infinity/);
        expect(svg).toContain('stroke-linecap="round"'); // the number
        const url = kitDataUrl(kit, 10);
        expect(kitDataUrl(kit, 10)).toBe(url);
        expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(kitSvg(kit, 120, 10));
      }
    }
    expect(kitSvg(CLUBS[0]!.home)).not.toContain('stroke-linecap'); // no number
    expect(kitDataUrl(CLUBS[0]!.home)).not.toBe(kitDataUrl(CLUBS[0]!.away));
  });
});
