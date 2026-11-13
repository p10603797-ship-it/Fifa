/**
 * [GFX-07] Body part geometry (src/render/players/parts.ts), kit looks and shader patches (model.ts): budgets
 * (<= 14 draw calls; [LOOK] <= 3,500 triangles per player, <= 80k for 22; the PERFORMANCE LOD <= 1,123), outward winding and unit normals, crisp colour regions in the
 * right places (sleeve / arm, shorts / thigh, knee / sock, face / hair, hand, collar), sizes matching the skeleton,
 * no shirt / shorts z-fighting, keeper looks (long sleeves, gloves), halves sleeves, number glyph rects.
 */
import { describe, expect, it } from 'vitest';
import { ShaderLib, Vector3 } from 'three';
import { KitPattern } from '../../src/contracts/enums';
import type { Kit } from '../../src/contracts/data';
import { NUMBER_GLYPH_H, NUMBER_GLYPH_W } from '../../src/render/kits';
import { BODY } from '../../src/render/players/fk';
import {
  buildPartGeometry, buildPartSoup, HAIR_MAX_RISE, HAIR_STYLE_COUNT, HairStyle, HandVariant, HEM_RX, HEM_RZ, NUMBER_PANEL,
  Part, PART_COUNT, PART_PAIRED, SleeveVariant, TORSO_Y0, TORSO_Y1, trianglesPerPlayer, visibleTrianglesPerPlayer,
} from '../../src/render/players/parts';
import {
  createSlotLook, GLOVE_COLOUR, gridGlyphRect, heightScale, luminance, patchDepthShader, patchPartShader, patchTorsoShader,
  SKIN_TONES, slotLook, strideDistance,
} from '../../src/render/players/model';

interface Tri { p: Vector3[]; n: Vector3[]; sel: number; c: Vector3 }

interface VTri extends Tri { variant: number }

function tris(part: number, lod: 0 | 1 = 1): VTri[] {
  const b = buildPartSoup(part, lod);
  const out: VTri[] = [];
  for (let t = 0; t < b.triangles; t++) {
    const p: Vector3[] = [], n: Vector3[] = [];
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 3;
      p.push(new Vector3(b.pos[o]!, b.pos[o + 1]!, b.pos[o + 2]!));
      n.push(new Vector3(b.nrm[o]!, b.nrm[o + 1]!, b.nrm[o + 2]!));
    }
    const c = new Vector3().add(p[0]!).add(p[1]!).add(p[2]!).multiplyScalar(1 / 3);
    out.push({ p, n, sel: b.sel[t * 3]!, c, variant: b.vars[t * 3]! });
  }
  return out;
}

describe('GFX-07 part geometry', () => {
  // [LOOK] The redesigned figure has a budget of 2,500..3,500 triangles per player at the full LOD (22 players under
  // 80k of the 200k frame budget; it was 30k for the 1,123-triangle pre-[LOOK] model), every variant counted. The
  // PERFORMANCE tier's LOD stays no heavier than the pre-[LOOK] model. Draw calls are unchanged (8).
  it('budget: 8 draw calls (one InstancedMesh per part), <= 3,500 triangles per player (<= 80k for 22); LOD 0 <= 1,123', () => {
    expect(PART_COUNT).toBe(8);
    expect(PART_COUNT).toBeLessThanOrEqual(14);
    const perPlayer = trianglesPerPlayer();
    expect(perPlayer).toBeGreaterThan(2_000); // a shaped figure, not sticks
    expect(perPlayer).toBeLessThanOrEqual(3_500);
    expect(perPlayer * 22).toBeLessThanOrEqual(80_000);
    expect(trianglesPerPlayer(0)).toBeLessThanOrEqual(1_123);
    expect(trianglesPerPlayer(0)).toBeGreaterThan(600); // reads as a body, not a capsule
    expect(visibleTrianglesPerPlayer()).toBeLessThan(perPlayer);
    expect(PART_PAIRED.filter(Boolean)).toHaveLength(5);
  });

  it('variants: hair styles on the head, short / long sleeve (full LOD), bare hand / glove, nothing elsewhere; both LODs', () => {
    for (const lod of [0, 1] as const) {
      for (let part = 0; part < PART_COUNT; part++) {
        const ids = new Set(tris(part, lod).map((t) => t.variant));
        if (part === Part.HEAD) {
          // BUZZ is the scalp cap alone (no shell); every other style has its own shell.
          const want = [0];
          for (let k = 1; k <= HAIR_STYLE_COUNT; k++) if (k !== HairStyle.BUZZ) want.push(k);
          expect([...ids].sort(), `lod ${lod}`).toEqual(want);
        } else if (part === Part.LOWER_ARM) {
          expect([...ids].sort()).toEqual([0, HandVariant.BARE, HandVariant.GLOVE]);
        } else if (part === Part.UPPER_ARM && lod === 1) {
          expect([...ids].sort()).toEqual([SleeveVariant.SHORT, SleeveVariant.LONG]);
        } else {
          expect([...ids]).toEqual([0]);
        }
      }
      // Hair and gloves are in the second colour (hair / glove).
      for (const t of tris(Part.HEAD, lod)) if (t.variant !== 0) expect(t.sel).toBe(1);
      for (const t of tris(Part.LOWER_ARM, lod)) if (t.variant !== 0) expect(t.sel).toBe(1);
    }
  });

  it('the keeper glove is larger than the bare hand and ends at the same hand tip', () => {
    const ext = (v: number) => {
      const ts = tris(Part.LOWER_ARM).filter((t) => t.variant === v);
      const xs = ts.flatMap((t) => t.p.map((p) => p.x)), zs = ts.flatMap((t) => t.p.map((p) => p.z));
      const ys = ts.flatMap((t) => t.p.map((p) => p.y));
      return { w: Math.max(...xs) - Math.min(...xs), t: Math.max(...zs) - Math.min(...zs), tip: Math.min(...ys) };
    };
    const hand = ext(HandVariant.BARE), glove = ext(HandVariant.GLOVE);
    expect(glove.w).toBeGreaterThan(hand.w * 1.25);
    expect(glove.t).toBeGreaterThan(hand.t * 1.25);
    expect(hand.tip).toBeCloseTo(-(BODY.foreArm + BODY.hand), 6);
    expect(glove.tip).toBeCloseTo(-(BODY.foreArm + BODY.hand), 6);
  });

  it('joints: the parts meeting at the knee and elbow both end in a ball of about the same radius on the joint', () => {
    // Points of the thigh below the knee joint and of the shin above it lie within one radius of the joint, as do the
    // upper arm and forearm at the elbow: a bent joint is covered by a round cap from both sides (no gap, no kink).
    const capR = (part: number, jointY: number, below: boolean) => {
      let r = 0;
      for (const t of tris(part)) for (const p of t.p) {
        if (t.variant !== 0 && t.variant !== SleeveVariant.SHORT) continue;
        if (below ? p.y < jointY - 1e-9 : p.y > jointY + 1e-9) r = Math.max(r, Math.hypot(p.x, p.y - jointY, p.z));
      }
      return r;
    };
    const kneeA = capR(Part.UPPER_LEG, -BODY.thigh, true), kneeB = capR(Part.LOWER_LEG, 0, false);
    const elbowA = capR(Part.UPPER_ARM, -BODY.upperArm, true), elbowB = capR(Part.LOWER_ARM, 0, false);
    expect(kneeA).toBeGreaterThan(0.04);
    expect(Math.abs(kneeA - kneeB)).toBeLessThan(0.006);
    expect(elbowA).toBeGreaterThan(0.035);
    expect(Math.abs(elbowA - elbowB)).toBeLessThan(0.004);
  });

  it('the keeper\'s long sleeve has no cuff step; the short sleeve ends in a cuff over the bare arm', () => {
    // Largest radius drop between neighbouring heights along the arm (front-most vertex per height).
    const profile = (v: number): number => {
      const front = new Map<string, number>();
      for (const t of tris(Part.UPPER_ARM)) if (t.variant === v) for (const p of t.p) {
        const k = p.y.toFixed(4);
        front.set(k, Math.max(front.get(k) ?? 0, Math.hypot(p.x, p.z)));
      }
      const ys = [...front.keys()].map(Number).filter((y) => y < -0.05 && y > -BODY.upperArm).sort((a, b) => b - a);
      let drop = 0;
      for (let i = 1; i < ys.length; i++) drop = Math.max(drop, front.get(ys[i - 1]!.toFixed(4))! - front.get(ys[i]!.toFixed(4))!);
      return drop;
    };
    expect(profile(SleeveVariant.SHORT)).toBeGreaterThan(0.006);
    expect(profile(SleeveVariant.LONG)).toBeLessThan(0.006);
  });

  it('every part (both LODs): finite positions, unit normals, outward winding, selector 0 / 1 constant per triangle', () => {
    for (const lod of [0, 1] as const) for (let part = 0; part < PART_COUNT; part++) {
      const g = buildPartGeometry(part, lod);
      expect(g.getAttribute('aVar').count).toBe(g.getAttribute('position').count);
      expect(g.getAttribute('position').count % 3).toBe(0);
      expect(g.getAttribute('aSel').count).toBe(g.getAttribute('position').count);
      for (const t of tris(part, lod)) {
        for (const v of t.p) expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
        for (const n of t.n) expect(n.length()).toBeCloseTo(1, 4);
        expect([0, 1]).toContain(t.sel);
        const geo = new Vector3().subVectors(t.p[1]!, t.p[0]!).cross(new Vector3().subVectors(t.p[2]!, t.p[0]!));
        const mean = new Vector3().add(t.n[0]!).add(t.n[1]!).add(t.n[2]!);
        expect(geo.dot(mean), `part ${part} winding`).toBeGreaterThan(0);
      }
      const b = buildPartSoup(part, lod);
      for (let i = 0; i < b.sel.length; i += 3) {
        expect(b.sel[i + 1]).toBe(b.sel[i]);
        expect(b.sel[i + 2]).toBe(b.sel[i]);
        expect(b.vars[i + 1]).toBe(b.vars[i]);
        expect(b.vars[i + 2]).toBe(b.vars[i]);
      }
    }
  });

  it('sizes match the skeleton: crown, boot sole and toe, limb lengths, torso span', () => {
    const box = (part: number) => { const g = buildPartGeometry(part); g.computeBoundingBox(); return g.boundingBox!; };
    // The skull's crown is the skeleton's (variant 0); hair styles add at most HAIR_MAX_RISE of volume above it.
    const skullTop = Math.max(...tris(Part.HEAD).filter((t) => t.variant === 0).flatMap((t) => t.p.map((p) => p.y)));
    expect(skullTop).toBeCloseTo(BODY.headY + BODY.headRY, 3);
    expect(box(Part.HEAD).max.y).toBeGreaterThan(BODY.headY + BODY.headRY + 0.02); // a voluminous style exists
    expect(box(Part.HEAD).max.y).toBeLessThanOrEqual(BODY.headY + BODY.headRY + HAIR_MAX_RISE);
    expect(box(Part.BOOT).min.y).toBeCloseTo(-BODY.ankleY, 6);
    expect(box(Part.BOOT).max.x).toBeCloseTo(BODY.toeX, 6);
    expect(box(Part.BOOT).min.x).toBeLessThan(BODY.heelX);
    expect(box(Part.TORSO).min.y).toBeCloseTo(TORSO_Y0, 6);
    expect(box(Part.TORSO).max.y).toBeCloseTo(TORSO_Y1, 6);
    // Limbs reach the next joint (overlap so bent joints show no gaps).
    expect(box(Part.UPPER_ARM).min.y).toBeLessThan(-BODY.upperArm);
    expect(box(Part.UPPER_LEG).min.y).toBeLessThan(-BODY.thigh);
    expect(box(Part.LOWER_LEG).min.y).toBeLessThan(-BODY.shin);
    expect(box(Part.LOWER_ARM).min.y).toBeCloseTo(-(BODY.foreArm + BODY.hand), 6);
    expect(box(Part.LOWER_LEG).max.y).toBeGreaterThan(0);
    expect(box(Part.UPPER_LEG).max.y).toBeGreaterThan(0);
  });

  it('colour regions: sleeve over skin, shorts over thigh, knee over sock, hair on top and back, hand, collar trim', () => {
    const selAt = (part: number, pred: (c: Vector3) => boolean): number[] => [...new Set(tris(part).filter((t) => pred(t.c)).map((t) => t.sel))];
    expect(selAt(Part.UPPER_ARM, (c) => c.y > -0.1)).toEqual([0]); // sleeve (colour A)
    expect(selAt(Part.UPPER_ARM, (c) => c.y < -0.15)).toEqual([1]); // arm (colour B)
    expect(selAt(Part.UPPER_LEG, (c) => c.y > -0.17)).toEqual([0]); // shorts leg
    expect(selAt(Part.UPPER_LEG, (c) => c.y < -0.21)).toEqual([1]); // thigh
    expect(selAt(Part.LOWER_LEG, (c) => c.y > -0.05)).toEqual([1]); // knee skin
    expect(selAt(Part.LOWER_LEG, (c) => c.y < -0.08)).toEqual([0]); // sock
    expect(selAt(Part.LOWER_ARM, (c) => c.y < -BODY.foreArm - 0.01)).toEqual([1]); // hand / glove
    expect(selAt(Part.LOWER_ARM, (c) => c.y > -0.2)).toEqual([0]); // forearm
    expect(selAt(Part.TORSO, (c) => c.y > 0.545)).toEqual([1]); // collar trim
    expect(selAt(Part.TORSO, (c) => c.y < 0.46)).toEqual([0]); // shirt body (pattern + number)
    expect(selAt(Part.HEAD, (c) => c.y > BODY.headY + 0.1)).toEqual([1]); // hair on top
    expect(selAt(Part.HEAD, (c) => c.x > 0.08 && Math.abs(c.y - BODY.headY) < 0.04)).toEqual([0]); // face
    expect(selAt(Part.HEAD, (c) => c.x < -0.09 && c.y > BODY.headY - 0.03)).toEqual([1]); // back of the head
    expect(selAt(Part.HEAD, (c) => c.y < 0.12)).toEqual([0]); // neck
    // [LOOK] Boots have a sole in the second colour (dark, or light under dark boots); the upper is the boot colour.
    expect(selAt(Part.BOOT, (c) => c.y > -BODY.ankleY + 0.02)).toEqual([0]);
    expect(selAt(Part.BOOT, (c) => c.y < -BODY.ankleY + 0.004)).toEqual([1]);
    expect(selAt(Part.PELVIS, () => true)).toEqual([0]);
  });

  it('the shirt hem hangs over the shorts with a gap (no z-fighting at the waist)', () => {
    // Pelvis vertices at or above the hem (pelvis-local y >= spineY + TORSO_Y0) lie inside the hem's inner ellipse
    // (10 segments: flat faces at cos(18 deg) of the radii) with >= 1 cm front / back and 2 mm sideways to spare (a
    // lean slides the hem front-back). Same for the tops of the thighs
    // in the standing pose (hip joints at z = -/+hipZ): no shorts "teeth" poking through the hem.
    const hemY = BODY.spineY + TORSO_Y0;
    const inner = { x: HEM_RX * Math.cos(Math.PI / 10) - 0.01, z: HEM_RZ * Math.cos(Math.PI / 10) - 0.002 };
    let n = 0;
    for (const t of tris(Part.PELVIS)) {
      for (const v of t.p) {
        if (v.y < hemY) continue;
        n++;
        expect((v.x / inner.x) ** 2 + (v.z / inner.z) ** 2).toBeLessThan(1);
      }
    }
    expect(n).toBeGreaterThan(10);
    let m = 0;
    for (const t of tris(Part.UPPER_LEG)) {
      for (const v of t.p) {
        if (v.y < hemY) continue;
        for (const side of [-1, 1]) {
          m++;
          const z = v.z + side * BODY.hipZ;
          expect((v.x / inner.x) ** 2 + (z / inner.z) ** 2, `thigh vertex ${v.toArray()}`).toBeLessThan(1);
        }
      }
    }
    expect(m).toBeGreaterThan(10);
  });

  it('the back-number panel sits on the flat back of the torso, inside the shirt body', () => {
    expect(NUMBER_PANEL.y - NUMBER_PANEL.h / 2).toBeGreaterThan(TORSO_Y0 + 0.1);
    expect(NUMBER_PANEL.y + NUMBER_PANEL.h / 2).toBeLessThan(0.5);
    // Within the narrowest back width over the panel's height (rz >= 0.176 between y 0.16 and 0.48).
    expect(NUMBER_PANEL.w / 2).toBeLessThan(0.176);
    // Back faces under the panel all face -x.
    for (const t of tris(Part.TORSO)) {
      if (Math.abs(t.c.z) < 0.03 && t.c.x < 0 && Math.abs(t.c.y - NUMBER_PANEL.y) < 0.05) {
        const mean = new Vector3().add(t.n[0]!).add(t.n[1]!).add(t.n[2]!).normalize();
        expect(mean.x).toBeLessThan(-0.8);
      }
    }
  });
});

describe('GFX-07 number panel vs the GFX-08 glyph atlas', () => {
  it('the back panel has the glyph cell aspect (digits are not stretched) and prints readable digits', () => {
    expect(NUMBER_PANEL.w / NUMBER_PANEL.h).toBeCloseTo(NUMBER_GLYPH_W / NUMBER_GLYPH_H, 6);
    // Digits fill 72 % of the cell height: at least 17 cm tall on the 180 cm reference body.
    expect(NUMBER_PANEL.h * 0.72).toBeGreaterThan(0.17);
  });
});

describe('GFX-07 looks', () => {
  const kit = (pattern: KitPattern): Kit => ({ shirt: 0xd7263d, shirt2: 0xffffff, pattern, shorts: 0x111111, socks: 0xd7263d, number: 0xffffff });

  it('outfield: short sleeves, bare arms and hands in the skin tone, kit colours from the kit', () => {
    const l = slotLook(kit(KitPattern.PLAIN), false, 3, 7, createSlotLook());
    expect(SKIN_TONES).toContain(l.skin);
    expect(l.sleeveL).toBe(0xd7263d);
    expect(l.sleeveR).toBe(0xd7263d);
    expect(l.armSkinL).toBe(l.skin);
    expect(l.hand).toBe(l.skin);
    expect(l.shorts).toBe(0x111111);
    expect(l.socks).toBe(0xd7263d);
    expect(l.keeper).toBe(false);
  });

  it('keepers wear long sleeves and gloves', () => {
    const k = { ...kit(KitPattern.PLAIN), shirt: 0xeeee22 };
    const l = slotLook(k, true, 3, 0, createSlotLook());
    expect(l.armSkinL).toBe(0xeeee22);
    expect(l.armSkinR).toBe(0xeeee22);
    expect(l.hand).toBe(GLOVE_COLOUR);
    expect(l.keeper).toBe(true);
  });

  it('halves: the left sleeve wears the second colour; unknown patterns read as plain', () => {
    const l = slotLook(kit(KitPattern.HALVES), false, 1, 1, createSlotLook());
    expect(l.sleeveL).toBe(0xffffff);
    expect(l.sleeveR).toBe(0xd7263d);
    expect(slotLook({ ...kit(KitPattern.PLAIN), pattern: 99 as KitPattern }, false, 1, 1, createSlotLook()).pattern).toBe(KitPattern.PLAIN);
  });

  it('variety is deterministic per club and squad index, and a squad is not all one look', () => {
    const a = slotLook(kit(0), false, 5, 9, createSlotLook());
    const b = slotLook(kit(0), false, 5, 9, createSlotLook());
    expect(a).toEqual(b);
    const skins = new Set<number>(), boots = new Set<number>(), hair = new Set<number>();
    for (let r = 0; r < 18; r++) {
      const l = slotLook(kit(0), false, 5, r, createSlotLook());
      skins.add(l.skin); boots.add(l.boot); hair.add(l.hair);
    }
    expect(skins.size).toBeGreaterThanOrEqual(3);
    expect(boots.size).toBeGreaterThanOrEqual(2);
    expect(hair.size).toBeGreaterThanOrEqual(3);
  });

  it('number glyph rects: 1..99 inside the atlas, disjoint; 0, 100, fractions and NaN have none', () => {
    const r = new Float32Array(4);
    const seen = new Set<string>();
    for (let n = 1; n <= 99; n++) {
      expect(gridGlyphRect(n, r, 0)).toBe(true);
      expect(r[0]).toBeGreaterThanOrEqual(0); expect(r[2]).toBeLessThanOrEqual(1);
      expect(r[1]).toBeGreaterThanOrEqual(0); expect(r[3]).toBeLessThanOrEqual(1);
      expect(r[2]! - r[0]!).toBeCloseTo(0.1, 6);
      expect(r[3]! - r[1]!).toBeCloseTo(0.1, 6); // v0 is the bottom edge (v up)
      seen.add(`${r[0]!.toFixed(3)},${r[1]!.toFixed(3)}`);
    }
    expect(seen.size).toBe(99);
    for (const n of [0, 100, 7.5, Number.NaN, -3]) expect(gridGlyphRect(n, r, 0)).toBe(false);
  });

  it('height scale and luminance helpers', () => {
    expect(heightScale(180)).toBe(1);
    expect(heightScale(198)).toBeCloseTo(1.1, 9);
    expect(heightScale(0)).toBe(1);
    expect(heightScale(Number.NaN)).toBe(1);
    expect(heightScale(400)).toBe(1.2);
    expect(heightScale(50)).toBe(0.85);
    expect(luminance(0xffffff)).toBeCloseTo(1, 6);
    expect(luminance(0x000000)).toBe(0);
    expect(luminance(0xffff00)).toBeGreaterThan(0.35);
    expect(luminance(0x1b2a6b)).toBeLessThan(0.35);
  });

  it('stride distance: travelled metres, 0 for the first frame, teleports (> 3 m) and NaN', () => {
    expect(strideDistance(0, 0, 0.3, 0.4, true)).toBeCloseTo(0.5, 9);
    expect(strideDistance(0, 0, 0.3, 0.4, false)).toBe(0);
    expect(strideDistance(0, 0, 10, 0, true)).toBe(0);
    expect(strideDistance(0, 0, Number.NaN, 0, true)).toBe(0);
  });
});

describe('GFX-07 shader patches (three.js Lambert sources)', () => {
  const vs = ShaderLib.lambert.vertexShader, fs = ShaderLib.lambert.fragmentShader;

  it('generic parts: colour A / B by the per-vertex selector replaces the diffuse colour', () => {
    const p = patchPartShader(vs, fs);
    expect(p.vertex).toContain('attribute vec3 iColA;');
    expect(p.vertex).toContain('attribute float aSel;');
    expect(p.vertex.indexOf('vKitCol = mix( iColA, iColB, aSel );')).toBeGreaterThan(p.vertex.indexOf('#include <color_vertex>'));
    expect(p.fragment).toContain('vec4 diffuseColor = vec4( diffuse * vKitCol, opacity );');
    expect(p.fragment).not.toContain('vec4 diffuseColor = vec4( diffuse, opacity );');
  });

  it('torso: pattern, trim and number composite; derivatives for anti-aliasing', () => {
    const p = patchTorsoShader(vs, fs);
    expect(p.vertex).toContain('vLoc = position;');
    expect(p.fragment).toContain('uniform sampler2D uNumAtlas;');
    expect(p.fragment).toContain('fwidth(');
    expect(p.fragment).toContain('vec4 diffuseColor = vec4( diffuse * dkShirt(), opacity );');
    expect(p.fragment.indexOf('vec3 dkShirt()')).toBeLessThan(p.fragment.indexOf('void main()'));
  });

  it('[LOOK] variants collapse in the part and depth shaders; parts and torso add the sky / rim term', () => {
    const p = patchPartShader(vs, fs);
    const collapse = 'transformed *= max( 1.0 - step( 0.5, aVar ), 1.0 - step( 0.5, abs( aVar - iVar ) ) );';
    expect(p.vertex).toContain('attribute float iVar;');
    expect(p.vertex.indexOf(collapse)).toBeGreaterThan(p.vertex.indexOf('#include <begin_vertex>'));
    expect(p.fragment).toContain('dkRim');
    expect(p.fragment.indexOf('dkRim')).toBeGreaterThan(p.fragment.indexOf('#include <aomap_fragment>'));
    expect(patchTorsoShader(vs, fs).fragment).toContain('dkRim');
    const d = patchDepthShader(ShaderLib.depth.vertexShader);
    expect(d).toContain('attribute float aVar;');
    expect(d.indexOf(collapse)).toBeGreaterThan(d.indexOf('#include <begin_vertex>'));
  });

  it('[LOOK] looks: hair style seeded per player (shaved heads are buzz cuts), a sole colour that contrasts the boot', () => {
    const k: Kit = { shirt: 0xd7263d, shirt2: 0xffffff, pattern: KitPattern.PLAIN, shorts: 0x111111, socks: 0xd7263d, number: 0xffffff };
    const styles = new Set<number>();
    for (let c = 0; c < 6; c++) for (let r = 0; r < 25; r++) {
      const l = slotLook(k, false, c, r, createSlotLook());
      expect(l.hairStyle).toBeGreaterThanOrEqual(1);
      expect(l.hairStyle).toBeLessThanOrEqual(HAIR_STYLE_COUNT);
      if (l.hair === l.skin) expect(l.hairStyle).toBe(HairStyle.BUZZ);
      expect(Math.abs(luminance(l.sole) - luminance(l.boot))).toBeGreaterThan(0.15);
      styles.add(l.hairStyle);
    }
    expect(styles.size).toBe(HAIR_STYLE_COUNT);
  });

  it('fails loudly when three.js moves its chunks (no silent white players)', () => {
    expect(() => patchPartShader('void main() {}', fs)).toThrow(/not found/);
    expect(() => patchTorsoShader(vs, 'void main() {}')).toThrow(/not found/);
  });
});
