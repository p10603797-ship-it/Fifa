/**
 * [GFX-07] Body part geometry (src/render/players/parts.ts), kit looks and shader patches (model.ts): budgets
 * (<= 14 draw calls, <= 30k triangles for 22 players), outward winding and unit normals, crisp colour regions in the
 * right places (sleeve / arm, shorts / thigh, knee / sock, face / hair, hand, collar), sizes matching the skeleton,
 * no shirt / shorts z-fighting, keeper looks (long sleeves, gloves), halves sleeves, number glyph rects.
 */
import { describe, expect, it } from 'vitest';
import { ShaderLib, Vector3 } from 'three';
import { KitPattern } from '../../src/contracts/enums';
import type { Kit } from '../../src/contracts/data';
import { BODY } from '../../src/render/players/fk';
import {
  buildPartGeometry, buildPartSoup, HEM_RX, HEM_RZ, NUMBER_PANEL, Part, PART_COUNT, PART_PAIRED, TORSO_Y0, TORSO_Y1,
  trianglesPerPlayer,
} from '../../src/render/players/parts';
import {
  createSlotLook, GLOVE_COLOUR, gridGlyphRect, heightScale, luminance, patchPartShader, patchTorsoShader,
  SKIN_TONES, slotLook, strideDistance,
} from '../../src/render/players/model';

interface Tri { p: Vector3[]; n: Vector3[]; sel: number; c: Vector3 }

function tris(part: number): Tri[] {
  const b = buildPartSoup(part);
  const out: Tri[] = [];
  for (let t = 0; t < b.triangles; t++) {
    const p: Vector3[] = [], n: Vector3[] = [];
    for (let k = 0; k < 3; k++) {
      const o = (t * 3 + k) * 3;
      p.push(new Vector3(b.pos[o]!, b.pos[o + 1]!, b.pos[o + 2]!));
      n.push(new Vector3(b.nrm[o]!, b.nrm[o + 1]!, b.nrm[o + 2]!));
    }
    const c = new Vector3().add(p[0]!).add(p[1]!).add(p[2]!).multiplyScalar(1 / 3);
    out.push({ p, n, sel: b.sel[t * 3]!, c });
  }
  return out;
}

describe('GFX-07 part geometry', () => {
  it('budget: 8 draw calls (one InstancedMesh per part) and <= 30k triangles for 22 players', () => {
    expect(PART_COUNT).toBe(8);
    expect(PART_COUNT).toBeLessThanOrEqual(14);
    const perPlayer = trianglesPerPlayer();
    expect(perPlayer).toBeGreaterThan(600); // reads as a body, not a capsule
    expect(perPlayer * 22).toBeLessThanOrEqual(30_000);
    expect(PART_PAIRED.filter(Boolean)).toHaveLength(5);
  });

  it('every part: finite positions, unit normals, outward winding, selector 0 / 1 constant per triangle', () => {
    for (let part = 0; part < PART_COUNT; part++) {
      const g = buildPartGeometry(part);
      expect(g.getAttribute('position').count % 3).toBe(0);
      expect(g.getAttribute('aSel').count).toBe(g.getAttribute('position').count);
      for (const t of tris(part)) {
        for (const v of t.p) expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
        for (const n of t.n) expect(n.length()).toBeCloseTo(1, 4);
        expect([0, 1]).toContain(t.sel);
        const geo = new Vector3().subVectors(t.p[1]!, t.p[0]!).cross(new Vector3().subVectors(t.p[2]!, t.p[0]!));
        const mean = new Vector3().add(t.n[0]!).add(t.n[1]!).add(t.n[2]!);
        expect(geo.dot(mean), `part ${part} winding`).toBeGreaterThan(0);
      }
      const b = buildPartSoup(part);
      for (let i = 0; i < b.sel.length; i += 3) {
        expect(b.sel[i + 1]).toBe(b.sel[i]);
        expect(b.sel[i + 2]).toBe(b.sel[i]);
      }
    }
  });

  it('sizes match the skeleton: crown, boot sole and toe, limb lengths, torso span', () => {
    const box = (part: number) => { const g = buildPartGeometry(part); g.computeBoundingBox(); return g.boundingBox!; };
    expect(box(Part.HEAD).max.y).toBeCloseTo(BODY.headY + BODY.headRY, 3);
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
    expect(selAt(Part.BOOT, () => true)).toEqual([0]);
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
    // Back faces under the panel all face -x.
    for (const t of tris(Part.TORSO)) {
      if (Math.abs(t.c.z) < 0.03 && t.c.x < 0 && Math.abs(t.c.y - NUMBER_PANEL.y) < 0.05) {
        const mean = new Vector3().add(t.n[0]!).add(t.n[1]!).add(t.n[2]!).normalize();
        expect(mean.x).toBeLessThan(-0.8);
      }
    }
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

  it('fails loudly when three.js moves its chunks (no silent white players)', () => {
    expect(() => patchPartShader('void main() {}', fs)).toThrow(/not found/);
    expect(() => patchTorsoShader(vs, 'void main() {}')).toThrow(/not found/);
  });
});
