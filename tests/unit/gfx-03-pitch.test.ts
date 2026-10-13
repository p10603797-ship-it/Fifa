/**
 * [GFX-03] Pitch: marking geometry against contracts/constants, the line-coverage maths (TypeScript twin of the
 * generated GLSL), the minimum on-screen line width, stripes, wear / detail texture, the Lambert shader patch and
 * the module's draw-call / triangle budget. Node only (no WebGL): the e2e spec gfx-03-pitch checks the pixels.
 */
import { Color, Mesh, MeshLambertMaterial, Scene, ShaderLib, PerspectiveCamera, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import {
  CENTRE_CIRCLE_RADIUS, CORNER_ARC_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_WIDTH, HALF_LENGTH, HALF_WIDTH, LINE_WIDTH,
  PENALTY_ARC_RADIUS, PENALTY_AREA_DEPTH, PENALTY_AREA_WIDTH, PENALTY_SPOT_DIST, PITCH_LENGTH, PITCH_WIDTH, BOARD_X, BOARD_Z,
} from '../../src/contracts/constants';
import { QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import {
  DETAIL_SIZE, GRASS_DARK, GRASS_LIGHT, LINE_COLOUR, PITCH_MARKS, PITCH_QX, PITCH_QZ, PITCH_SHADER_ANCHORS, PITCH_TUNING,
  SPOT_RADIUS, STRIPE_WIDTH, WEAR_COLOUR, WEAR_SPOTS, anisotropyFor, buildLineGlsl, createPitch, createPitchMaterial,
  createPitchUniforms, drawQuarterPitch, generateGrassDetail, lineCoverage, patchPitchShader, stripeDarkness, valueNoise,
  wearAt, type DiscMark, type PitchMark, type RectMark, type RingMark, type ScreenJacobian,
} from '../../src/render/pitch';
import type { RenderContext } from '../../src/render/types';

const L = LINE_WIDTH;
const EPS = 1e-9;

function mark<K extends PitchMark['kind']>(name: string, kind: K): Extract<PitchMark, { kind: K }> {
  const m = PITCH_MARKS.find((x) => x.name === name);
  expect(m, name).toBeDefined();
  expect(m!.kind).toBe(kind);
  return m as Extract<PitchMark, { kind: K }>;
}

/** Isotropic footprint: `mpp` metres per pixel along both world axes (top-down camera). */
const iso = (mpp: number): ScreenJacobian => ({ xdx: mpp, zdx: 0, xdy: 0, zdy: mpp });
/** Broadcast-like footprint: x along screen x, z foreshortened along screen y. */
const broadcast = (mppX: number, mppZ: number): ScreenJacobian => ({ xdx: mppX, zdx: 0, xdy: 0, zdy: mppZ });

describe('GFX-03 marking geometry matches contracts/constants', () => {
  it('pitch outline: touchlines 105 m long and goal lines 68 m long, outer edges on the boundary, 0.12 wide', () => {
    const t = mark('touchline', 'rect');
    expect(t.across).toBe('z');
    expect(t.pin).toBe('max');
    expect(2 * (t.x1 - t.x0)).toBeCloseTo(PITCH_LENGTH, 9);
    expect(t.z1).toBe(HALF_WIDTH);
    expect(t.z1 - t.z0).toBeCloseTo(L, 9);
    const g = mark('goal line', 'rect');
    expect(g.across).toBe('x');
    expect(g.pin).toBe('max');
    expect(g.x1).toBe(HALF_LENGTH);
    expect(g.x1 - g.x0).toBeCloseTo(L, 9);
    expect(2 * (g.z1 - g.z0)).toBeCloseTo(PITCH_WIDTH, 9);
  });

  it('halfway line: centred on x = 0, 0.12 wide, touchline to touchline', () => {
    const h = mark('halfway line', 'rect');
    expect(h.x0).toBe(0); // mirror fold: the line straddles x = 0
    expect(2 * h.x1).toBeCloseTo(L, 9);
    expect(2 * (h.z1 - h.z0)).toBeCloseTo(PITCH_WIDTH, 9);
  });

  it('penalty area 40.32 x 16.5 and goal area 18.32 x 5.5, lines inside the areas they bound', () => {
    for (const [prefix, width, depth] of [['penalty area', PENALTY_AREA_WIDTH, PENALTY_AREA_DEPTH], ['goal area', GOAL_AREA_WIDTH, GOAL_AREA_DEPTH]] as const) {
      const front = mark(`${prefix} front`, 'rect');
      const side = mark(`${prefix} side`, 'rect');
      // Outer extents: front edge at goal line - depth, sides at +-width/2.
      expect(front.x0).toBeCloseTo(HALF_LENGTH - depth, 9);
      expect(HALF_LENGTH - front.x0).toBeCloseTo(depth, 9);
      expect(2 * front.z1).toBeCloseTo(width, 9);
      expect(2 * side.z1).toBeCloseTo(width, 9);
      expect(side.x1).toBe(HALF_LENGTH);
      expect(side.x0).toBeCloseTo(front.x0, 9);
      // Lines lie inside the area: the front line grows toward the goal, the side line toward the centre.
      expect(front.pin).toBe('min');
      expect(front.x1 - front.x0).toBeCloseTo(L, 9);
      expect(side.pin).toBe('max');
      expect(side.z1 - side.z0).toBeCloseTo(L, 9);
    }
  });

  it('spots at 11 m and the centre, circles and arcs 9.15 m, corner arcs r = 1', () => {
    const ps = mark('penalty spot', 'disc');
    expect(HALF_LENGTH - ps.cx).toBeCloseTo(PENALTY_SPOT_DIST, 9);
    expect(ps.cz).toBe(0);
    expect(ps.r).toBe(SPOT_RADIUS);
    const cs = mark('centre spot', 'disc');
    expect([cs.cx, cs.cz, cs.r]).toEqual([0, 0, SPOT_RADIUS]);
    const cc = mark('centre circle', 'ring');
    expect([cc.cx, cc.cz, cc.r, cc.w]).toEqual([0, 0, CENTRE_CIRCLE_RADIUS, L]);
    const arc = mark('penalty arc', 'ring');
    expect([arc.cx, arc.cz, arc.r, arc.w]).toEqual([ps.cx, 0, PENALTY_ARC_RADIUS, L]);
    // Drawn only outside the penalty area; the clip reaches into the front line (seamless join), never past it.
    const front = mark('penalty area front', 'rect');
    expect(arc.clipX).toBeGreaterThan(front.x0);
    expect(arc.clipX).toBeLessThanOrEqual(front.x1);
    const corner = mark('corner arc', 'ring');
    expect([corner.cx, corner.cz, corner.r, corner.w]).toEqual([HALF_LENGTH, HALF_WIDTH, CORNER_ARC_RADIUS, L]);
    expect([corner.clipX, corner.clipZ]).toEqual([HALF_LENGTH, HALF_WIDTH]);
  });

  it('the table holds every marking once, in the quarter x >= 0, z >= 0, inside the pitch', () => {
    const names = PITCH_MARKS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([
      'centre circle', 'centre spot', 'corner arc', 'goal area front', 'goal area side', 'goal line', 'halfway line',
      'penalty arc', 'penalty area front', 'penalty area side', 'penalty spot', 'touchline',
    ]);
    for (const m of PITCH_MARKS) {
      if (m.kind === 'rect') {
        expect(m.x0).toBeGreaterThanOrEqual(0);
        expect(m.z0).toBeGreaterThanOrEqual(0);
        expect(m.x1).toBeLessThanOrEqual(HALF_LENGTH);
        expect(m.z1).toBeLessThanOrEqual(HALF_WIDTH);
        expect(m.x1).toBeGreaterThan(m.x0);
        expect(m.z1).toBeGreaterThan(m.z0);
      } else {
        expect(m.cx).toBeGreaterThanOrEqual(0);
        expect(m.cz).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the plane (with run-off) reaches past the advertising boards', () => {
    expect(PITCH_QX).toBeGreaterThan(BOARD_X);
    expect(PITCH_QZ).toBeGreaterThan(BOARD_Z);
  });
});

describe('GFX-03 line coverage (twin of the shader)', () => {
  const near = iso(0.01); // lines 12 px wide

  /** A point in the middle of each marking (quarter coordinates). */
  function centreOf(m: PitchMark): [number, number] {
    if (m.kind === 'rect') return [m.x0 === 0 && m.across === 'x' ? 0 : (m.x0 + m.x1) / 2, (m.z0 + m.z1) / 2];
    if (m.kind === 'disc') return [m.cx, m.cz];
    // Ring: at the angle pointing toward the pitch centre-ish, inside the clip.
    const rm = m.r - m.w / 2;
    if (m.name === 'corner arc') return [m.cx - rm * Math.SQRT1_2, m.cz - rm * Math.SQRT1_2];
    return [m.cx - rm, m.cz];
  }

  it('every marking is fully painted at its centre line, in all four quarters', () => {
    for (const m of PITCH_MARKS) {
      const [x, z] = centreOf(m);
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        expect(lineCoverage(sx * x, sz * z, near), `${m.name} at (${sx * x}, ${sz * z})`).toBeCloseTo(1, 6);
      }
    }
  });

  it('paint stops at the true edges: 3 px outside every straight line and ring is grass', () => {
    const d = 0.03;
    // Outer edges (on the boundary) and inner edges.
    const outside: [string, number, number][] = [
      ['beyond touchline', 10, HALF_WIDTH + d], ['inside touchline', 10, HALF_WIDTH - L - d],
      ['beyond goal line', HALF_LENGTH + d, 15], ['inside goal line', HALF_LENGTH - L - d, 15],
      ['beside halfway', L / 2 + d, 20], ['beside halfway (-x)', -(L / 2 + d), 20],
      ['outside penalty area', HALF_LENGTH - PENALTY_AREA_DEPTH - d, 10], ['inside penalty front', HALF_LENGTH - PENALTY_AREA_DEPTH + L + d, 10],
      ['outside penalty side', 44, PENALTY_AREA_WIDTH / 2 + d], ['inside penalty side', 44, PENALTY_AREA_WIDTH / 2 - L - d],
      ['outside centre circle', -(CENTRE_CIRCLE_RADIUS + d), 0], ['inside centre circle', -(CENTRE_CIRCLE_RADIUS - L - d), 0],
      ['outside spot', SPOT_RADIUS + d, 0], ['outside penalty spot', HALF_LENGTH - PENALTY_SPOT_DIST + SPOT_RADIUS + d, 0],
    ];
    for (const [name, x, z] of outside) expect(lineCoverage(x, z, near), name).toBeLessThan(1e-6);
  });

  it('halfway line centre (the mirror fold at x = 0) is solid paint, not an edge', () => {
    for (const mpp of [0.004, 0.02, 0.06, 0.2]) {
      expect(lineCoverage(0, 20, iso(mpp)), `mpp ${mpp}`).toBeGreaterThan(0.99 * PITCH_TUNING.lineMinAlpha);
      expect(lineCoverage(0, 20, iso(mpp))).toBeGreaterThanOrEqual(lineCoverage(1e-4, 20, iso(mpp)) - 1e-9);
    }
    expect(lineCoverage(0, 20, near)).toBe(1);
    expect(lineCoverage(0, 0.5, near)).toBe(1); // fold in z too
  });

  it('penalty arc only outside the penalty area; corner arc only inside the pitch', () => {
    const arc = mark('penalty arc', 'ring');
    const rm = arc.r - arc.w / 2;
    // On the arc circle but inside the area (x = 37): no paint.
    const zIn = Math.sqrt(rm * rm - (arc.cx - 37) ** 2);
    expect(lineCoverage(37, zIn, near)).toBe(0);
    // On the arc circle outside the area (x = 34): paint.
    const zOut = Math.sqrt(rm * rm - (arc.cx - 34) ** 2);
    expect(lineCoverage(34, zOut, near)).toBeCloseTo(1, 6);
    // Corner arc: the quarter circle outside the pitch is not drawn.
    const c = mark('corner arc', 'ring');
    const cm = c.r - c.w / 2;
    expect(lineCoverage(c.cx + cm * Math.SQRT1_2, c.cz - cm * Math.SQRT1_2, near)).toBe(0); // behind the goal line
    expect(lineCoverage(c.cx - cm * Math.SQRT1_2, c.cz + cm * Math.SQRT1_2, near)).toBe(0); // beyond the touchline
    expect(lineCoverage(-(c.cx - cm * Math.SQRT1_2), -(c.cz - cm * Math.SQRT1_2), near)).toBeCloseTo(1, 6);
  });

  it('the penalty arc joins the front line without a seam (no dip in coverage along the arc into the line)', () => {
    const arc = mark('penalty arc', 'ring');
    const front = mark('penalty area front', 'rect');
    const rm = arc.r - arc.w / 2;
    for (const mpp of [0.005, 0.02, 0.05]) {
      for (let x = front.x0 - 0.3; x <= front.x0 + L / 2; x += 0.005) {
        const z = Math.sqrt(rm * rm - (arc.cx - x) ** 2);
        expect(lineCoverage(x, z, iso(mpp)), `x ${x.toFixed(3)} mpp ${mpp}`).toBeGreaterThan(0.99);
      }
    }
  });

  it('mirror symmetry about both axes', () => {
    let seed = 7;
    const rnd = (): number => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 2000; i++) {
      const x = (rnd() - 0.5) * 2 * PITCH_QX, z = (rnd() - 0.5) * 2 * PITCH_QZ;
      const j = broadcast(0.01 + rnd() * 0.1, 0.01 + rnd() * 0.3);
      const c = lineCoverage(x, z, j);
      expect(lineCoverage(-x, z, j)).toBeCloseTo(c, 9);
      expect(lineCoverage(x, -z, j)).toBeCloseTo(c, 9);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  /** Painted width in pixels across the touchline (z) at footprint mppZ: samples every 0.1 px with coverage >= 0.5. */
  function paintedPx(lineAt: (t: number) => number, mpp: number): number {
    let n = 0;
    for (let px = -40; px <= 40; px += 0.1) if (lineAt(px * mpp) >= 0.5 * PITCH_TUNING.lineMinAlpha) n++;
    return n * 0.1;
  }

  it('far touchline breaks up / shimmers (regression): never thinner than lineMinPx at any distance', () => {
    const minPx = PITCH_TUNING.lineMinPx;
    for (const mppZ of [0.005, 0.01, 0.03, 0.06, 0.1, 0.2, 0.4, 1]) {
      const j = broadcast(0.03, mppZ);
      const w = paintedPx((dz) => lineCoverage(5, HALF_WIDTH - L / 2 + dz, j), mppZ);
      const truePx = L / mppZ;
      expect(w, `mppZ ${mppZ}: painted ${w.toFixed(2)} px, true ${truePx.toFixed(2)} px`).toBeGreaterThanOrEqual(minPx - 0.15);
      // A line wider than the minimum keeps its true width (within the 1 px anti-aliasing ramp).
      if (truePx > minPx) expect(Math.abs(w - truePx), `mppZ ${mppZ}`).toBeLessThan(1.05);
      // Opacity: full when not widened, never below lineMinAlpha when widened.
      const peak = lineCoverage(5, HALF_WIDTH - Math.max(L, minPx * mppZ) / 2, j);
      expect(peak).toBeGreaterThanOrEqual(PITCH_TUNING.lineMinAlpha - 1e-9);
      if (truePx >= minPx) expect(peak).toBeCloseTo(1, 6);
    }
  });

  it('a widened line keeps its outer edge on the boundary (grows into the area it bounds)', () => {
    for (const mpp of [0.06, 0.2, 0.5]) {
      // Just beyond the outer edge (more than half a pixel): no paint, however much the line is widened.
      expect(lineCoverage(5, HALF_WIDTH + 0.55 * mpp, broadcast(0.03, mpp)), `touchline mpp ${mpp}`).toBe(0);
      expect(lineCoverage(HALF_LENGTH + 0.55 * mpp, 10, broadcast(mpp, 0.03)), `goal line mpp ${mpp}`).toBe(0);
      expect(lineCoverage(-(CENTRE_CIRCLE_RADIUS + 0.55 * mpp), 0, iso(mpp)), `centre circle mpp ${mpp}`).toBe(0);
      // Just inside the outer edge: paint.
      expect(lineCoverage(5, HALF_WIDTH - 0.6 * mpp, broadcast(0.03, mpp))).toBeGreaterThan(0.5);
    }
  });

  it('circles and spots are never thinner than lineMinPx either (radial footprint)', () => {
    const minPx = PITCH_TUNING.lineMinPx;
    for (const mpp of [0.01, 0.05, 0.2]) {
      const j = broadcast(0.02, mpp);
      // Far side of the centre circle: radial direction = z.
      const w = paintedPx((dz) => lineCoverage(0, -(CENTRE_CIRCLE_RADIUS - L / 2) + dz, j), mpp);
      expect(w, `circle mpp ${mpp}`).toBeGreaterThanOrEqual(Math.min(minPx, L / mpp + minPx) - 0.15);
      // Penalty spot seen edge-on in z: at least minPx tall.
      const s = paintedPx((dz) => lineCoverage(HALF_LENGTH - PENALTY_SPOT_DIST, dz, j), mpp);
      expect(s, `spot mpp ${mpp}`).toBeGreaterThanOrEqual(Math.min(minPx, (2 * SPOT_RADIUS) / mpp) - 0.15);
    }
  });

  it('junctions are not brighter than the lines that meet there (max, not sum)', () => {
    for (const mpp of [0.01, 0.1, 0.3]) {
      const j = iso(mpp);
      const single = lineCoverage(20, HALF_WIDTH - L / 2, j);
      const junction = lineCoverage(0, HALF_WIDTH - L / 2, j); // halfway line meets the touchline
      expect(junction).toBeLessThanOrEqual(Math.max(single, lineCoverage(0, 20, j)) + 1e-9);
      expect(lineCoverage(0, 0, j)).toBeLessThanOrEqual(1); // centre spot on the halfway line
    }
  });

  it('degenerate footprints stay finite (mpp 0, huge mpp, NaN-free at the circle centres)', () => {
    for (const j of [iso(0), iso(1e-9), iso(1e3), { xdx: 0, zdx: 0, xdy: 0, zdy: 0 }]) {
      for (const [x, z] of [[0, 0], [HALF_LENGTH - PENALTY_SPOT_DIST, 0], [HALF_LENGTH, HALF_WIDTH], [10, 10]]) {
        const c = lineCoverage(x!, z!, j);
        expect(Number.isFinite(c), `(${x}, ${z})`).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('GFX-03 mowing stripes', () => {
  it('alternate across x: light stripe on the halfway line, goal lines on stripe boundaries, symmetric', () => {
    const fine = 0.01;
    expect(stripeDarkness(0, fine)).toBe(0);
    expect(stripeDarkness(STRIPE_WIDTH, fine)).toBe(1);
    expect(stripeDarkness(2 * STRIPE_WIDTH, fine)).toBe(0);
    expect(stripeDarkness(-STRIPE_WIDTH, fine)).toBe(1);
    expect(stripeDarkness(STRIPE_WIDTH / 2, fine)).toBeCloseTo(0.5, 9);
    expect(stripeDarkness(HALF_LENGTH, fine)).toBeCloseTo(0.5, 9);
    expect(stripeDarkness(-HALF_LENGTH, fine)).toBeCloseTo(0.5, 9);
    // 21 stripes over the pitch.
    expect((PITCH_LENGTH - STRIPE_WIDTH) / STRIPE_WIDTH / 2 % 1).toBe(0);
    for (let x = -60; x <= 60; x += 0.37) expect(stripeDarkness(x, fine)).toBeCloseTo(stripeDarkness(-x, fine), 9);
  });

  it('band-limited: stripes only a few pixels wide fade to the mean (no moire)', () => {
    expect(Math.abs(stripeDarkness(STRIPE_WIDTH, STRIPE_WIDTH / 2) - 0.5)).toBeLessThan(1e-9);
    expect(stripeDarkness(STRIPE_WIDTH, STRIPE_WIDTH / 20)).toBe(1);
  });

  it('stripe edges are never sharper than one pixel', () => {
    for (const mpp of [0.01, 0.05, 0.2]) {
      // Darkness change across one pixel at a boundary stays below 0.5 + small.
      let maxStep = 0;
      for (let x = STRIPE_WIDTH / 2 - 1; x < STRIPE_WIDTH / 2 + 1; x += mpp) {
        maxStep = Math.max(maxStep, Math.abs(stripeDarkness(x + mpp, mpp) - stripeDarkness(x, mpp)));
      }
      expect(maxStep, `mpp ${mpp}`).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
});

describe('GFX-03 wear and grass detail texture', () => {
  const N = 128;
  const tex = generateGrassDetail(N);
  const at = (x: number, z: number): [number, number, number, number] => {
    const i = Math.min(N - 1, Math.max(0, Math.floor((x / (2 * PITCH_QX) + 0.5) * N)));
    const j = Math.min(N - 1, Math.max(0, Math.floor((z / (2 * PITCH_QZ) + 0.5) * N)));
    const o = (j * N + i) * 4;
    return [tex[o]!, tex[o + 1]!, tex[o + 2]!, tex[o + 3]!];
  };

  it('is deterministic RGBA8 of size^2', () => {
    expect(tex.length).toBe(N * N * 4);
    expect(generateGrassDetail(N)).toEqual(tex);
    expect(generateGrassDetail().length).toBe(DETAIL_SIZE * DETAIL_SIZE * 4);
    for (let o = 3; o < tex.length; o += 4) if (tex[o] !== 255) throw new Error(`alpha ${tex[o]} at ${o}`);
  });

  it('wear near both goalmouths, the penalty spots and the centre; none in the open field or the run-off', () => {
    let goal = 0, centre = 0;
    for (const sx of [1, -1]) {
      let m = 0;
      for (let dz = -2; dz <= 2; dz += 0.5) for (let dx = 0; dx <= 3; dx += 0.5) m = Math.max(m, wearAt(sx * (HALF_LENGTH - 1 - dx), dz));
      expect(m, `goalmouth ${sx}`).toBeGreaterThan(0.5);
      goal = Math.max(goal, m);
      let p = 0;
      for (let dz = -1; dz <= 1; dz += 0.25) for (let dx = -1; dx <= 1; dx += 0.25) p = Math.max(p, wearAt(sx * (HALF_LENGTH - PENALTY_SPOT_DIST) + dx, dz));
      expect(p, `penalty spot ${sx}`).toBeGreaterThan(0.2);
    }
    for (let dz = -1; dz <= 1; dz += 0.25) for (let dx = -1; dx <= 1; dx += 0.25) centre = Math.max(centre, wearAt(dx, dz));
    expect(centre).toBeGreaterThan(0.1);
    expect(centre).toBeLessThan(goal); // goalmouths wear most
    for (const [x, z] of [[25, 20], [-25, -20], [0, 25], [30, 0], [-45, 28], [57, 38], [10, -33]]) {
      expect(wearAt(x!, z!), `(${x}, ${z})`).toBe(0);
      expect(at(x!, z!)[0], `texel (${x}, ${z})`).toBe(0);
    }
    expect(at(HALF_LENGTH - 2.2, 0)[0]).toBeGreaterThan(60);
    // Every wear spot is on the pitch.
    for (const s of WEAR_SPOTS) expect(s.ax).toBeLessThanOrEqual(HALF_LENGTH);
  });

  it('mottling and grain vary (not flat) and the grain tiles with the texture', () => {
    let gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (let o = 0; o < tex.length; o += 4) {
      gMin = Math.min(gMin, tex[o + 1]!); gMax = Math.max(gMax, tex[o + 1]!);
      bMin = Math.min(bMin, tex[o + 2]!); bMax = Math.max(bMax, tex[o + 2]!);
    }
    expect(gMax - gMin).toBeGreaterThan(60);
    expect(bMax - bMin).toBeGreaterThan(60);
    for (let i = 0; i < 50; i++) {
      const u = i * 1.37, v = i * 0.71;
      expect(valueNoise(u + 32, v, 31, 32)).toBeCloseTo(valueNoise(u, v, 31, 32), 12);
      expect(valueNoise(u, v + 32, 31, 32)).toBeCloseTo(valueNoise(u, v, 31, 32), 12);
    }
  });

  it('fully worn grass still reads as grass (green dominant), so worn goalmouths never look like a kit colour', () => {
    const lin = (hex: string): Color => new Color(hex);
    for (const base of [GRASS_LIGHT, GRASS_DARK]) {
      const g = lin(base), w = lin(WEAR_COLOUR).multiplyScalar(1.15); // brightest grain factor
      const mixed = g.clone().lerp(w, PITCH_TUNING.wearStrength);
      const s = mixed.getHex();
      const r = (s >> 16) & 255, gg = (s >> 8) & 255, b = s & 255;
      expect(gg, `worn ${base}: ${r},${gg},${b}`).toBeGreaterThan(r + 8);
      expect(gg).toBeGreaterThan(b + 8);
    }
  });

  it('texture memory is small (<= 2 MB with mipmaps)', () => {
    expect(DETAIL_SIZE * DETAIL_SIZE * 4 * (4 / 3)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});

describe('GFX-03 shader patch and GLSL generation', () => {
  it('the installed three.js Lambert shaders still have the anchors the pitch patches', () => {
    expect(ShaderLib.lambert.vertexShader).toContain(PITCH_SHADER_ANCHORS.vertexPars);
    expect(ShaderLib.lambert.vertexShader).toContain(PITCH_SHADER_ANCHORS.vertexMain);
    expect(ShaderLib.lambert.fragmentShader).toContain(PITCH_SHADER_ANCHORS.fragmentPars);
    expect(ShaderLib.lambert.fragmentShader).toContain(PITCH_SHADER_ANCHORS.fragmentMain);
  });

  it('generates one coverage statement per marking, with the constants as literals', () => {
    const glsl = buildLineGlsl();
    expect(glsl.match(/dkCov = max\(dkCov,/g)).toHaveLength(PITCH_MARKS.length);
    for (const m of PITCH_MARKS) expect(glsl).toContain(`// ${m.name}`);
    for (const lit of ['52.50000', '34.00000', '36.00000', '20.16000', '47.00000', '9.16000', '41.50000', '9.15000', '0.12000', '1.00000']) {
      expect(glsl).toContain(lit);
    }
    expect(glsl).not.toMatch(/Infinity|NaN|undefined/);
    // Every float literal has a decimal point (GLSL ES has no implicit int -> float in these calls).
    const nums = glsl.replace(/\/\/.*$/gm, '').replace(/dk\w+|vec2|max|min|length|dot/g, '').match(/\d+(\.\d+)?(e-?\d+)?/g) ?? [];
    for (const n of nums) expect(n, n).toMatch(/\.|e/);
  });

  it('patches the Lambert shaders: world xz varying, procedural colour instead of <map_fragment>, uniforms bound', () => {
    const uniforms = createPitchUniforms(null);
    const shader = {
      vertexShader: ShaderLib.lambert.vertexShader,
      fragmentShader: ShaderLib.lambert.fragmentShader,
      uniforms: {} as Record<string, { value: unknown }>,
    };
    patchPitchShader(shader, uniforms);
    expect(shader.vertexShader).toContain('vDkPitch = (modelMatrix * vec4(transformed, 1.0)).xz;');
    expect(shader.vertexShader).toContain('varying vec2 vDkPitch;');
    expect(shader.fragmentShader).not.toContain(PITCH_SHADER_ANCHORS.fragmentMain);
    expect(shader.fragmentShader).toContain('diffuseColor.rgb *= mix(dkGrass, uDkLineColour, dkCov);');
    expect(shader.fragmentShader).toContain(buildLineGlsl().split('\n')[1]!.trim());
    // Balanced braces / parentheses; every uDk uniform used is declared and bound.
    const f = shader.fragmentShader;
    expect((f.match(/\{/g) ?? []).length).toBe((f.match(/\}/g) ?? []).length);
    expect((f.match(/\(/g) ?? []).length).toBe((f.match(/\)/g) ?? []).length);
    const used = new Set(f.match(/uDk\w+/g));
    for (const u of used) {
      expect(f, u).toMatch(new RegExp(`uniform \\w+ ${u};`));
      expect(shader.uniforms[u], u).toBe(uniforms[u]);
    }
    expect(used.size).toBe(Object.keys(uniforms).length);
  });

  it('throws on a missing anchor instead of silently drawing a white plane', () => {
    const shader = { vertexShader: 'void main() {}', fragmentShader: ShaderLib.lambert.fragmentShader, uniforms: {} };
    expect(() => patchPitchShader(shader, createPitchUniforms(null))).toThrow(/anchor missing/);
  });

  it('colour uniforms are the sRGB constants converted to linear (lit by Lambert)', () => {
    const u = createPitchUniforms(null);
    expect(u.uDkGrassLight.value.getHexString()).toBe(GRASS_LIGHT.slice(1));
    expect(u.uDkGrassDark.value.getHexString()).toBe(GRASS_DARK.slice(1));
    expect(u.uDkLineColour.value.getHexString()).toBe(LINE_COLOUR.slice(1));
    expect(u.uDkLineMinPx.value).toBe(PITCH_TUNING.lineMinPx);
    const m = createPitchMaterial(u);
    expect(m).toBeInstanceOf(MeshLambertMaterial);
    expect(m.customProgramCacheKey()).toBe('dk-pitch-1');
  });
});

describe('GFX-03 module', () => {
  function fakeCtx(maxAniso = 16): { ctx: RenderContext; inited: unknown[] } {
    const inited: unknown[] = [];
    const renderer = {
      capabilities: { getMaxAnisotropy: () => maxAniso },
      initTexture: (t: unknown) => { inited.push(t); },
    } as unknown as WebGLRenderer;
    const settings = createDefaultSettings();
    const ctx: RenderContext = {
      renderer, scene: new Scene(), camera: new PerspectiveCamera(), settings, clubs: [],
      size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED, cameraSettings: { ...settings.camera },
      reducedMotion: false, night: false,
    };
    return { ctx, inited };
  }

  it('one mesh, one draw call, 2 triangles (budget: <= 3 draw calls, < 5k triangles); hidden outside a match', () => {
    const { ctx, inited } = fakeCtx();
    const p = createPitch(ctx);
    const meshes: Mesh[] = [];
    ctx.scene.traverse((o) => { if ((o as Mesh).isMesh) meshes.push(o as Mesh); });
    expect(meshes).toEqual([p.mesh]);
    expect(Array.isArray(p.mesh.material)).toBe(false);
    expect(p.mesh.material).toBeInstanceOf(MeshLambertMaterial);
    const idx = p.mesh.geometry.getIndex()!;
    expect(idx.count / 3).toBe(2);
    // Horizontal plane at y = 0 covering the run-off out to PITCH_QX x PITCH_QZ.
    p.mesh.geometry.computeBoundingBox();
    const bb = p.mesh.geometry.boundingBox!;
    const ext = [bb.min.x, bb.max.x, bb.min.y, bb.max.y, bb.min.z, bb.max.z];
    [-PITCH_QX, PITCH_QX, 0, 0, -PITCH_QZ, PITCH_QZ].forEach((v, i) => expect(ext[i]).toBeCloseTo(v, 9));
    expect(p.mesh.geometry.getAttribute('normal').getY(0)).toBeCloseTo(1, 9);
    expect(p.mesh.visible).toBe(false);
    p.setMatch!({} as never, []);
    expect(p.mesh.visible).toBe(true);
    p.update({} as never);
    p.warmUp!();
    expect(inited).toEqual([p.detail]);
    p.clearMatch!();
    expect(p.mesh.visible).toBe(false);
    p.dispose();
    expect(ctx.scene.children).not.toContain(p.mesh);
  });

  it('dispose releases the geometry, material and texture', () => {
    const { ctx } = fakeCtx();
    const p = createPitch(ctx);
    const disposed: string[] = [];
    p.mesh.geometry.addEventListener('dispose', () => disposed.push('geometry'));
    p.material.addEventListener('dispose', () => disposed.push('material'));
    p.detail.addEventListener('dispose', () => disposed.push('texture'));
    p.dispose();
    expect(disposed.sort()).toEqual(['geometry', 'material', 'texture']);
  });

  it('quality tiers set the detail anisotropy, capped by the GPU', () => {
    expect(anisotropyFor(QualityTier.PERFORMANCE, 16)).toBe(1);
    expect(anisotropyFor(QualityTier.BALANCED, 16)).toBe(4);
    expect(anisotropyFor(QualityTier.QUALITY, 16)).toBe(8);
    expect(anisotropyFor(QualityTier.QUALITY, 2)).toBe(2);
    expect(anisotropyFor(QualityTier.BALANCED, 0)).toBe(1);
    const { ctx } = fakeCtx(4);
    const p = createPitch(ctx);
    expect(p.detail.anisotropy).toBe(4);
    const v = p.detail.version;
    p.setQuality!(QualityTier.QUALITY);
    expect(p.detail.anisotropy).toBe(4); // capped
    expect(p.detail.version).toBe(v); // no needless re-upload
    p.setQuality!(QualityTier.PERFORMANCE);
    expect(p.detail.anisotropy).toBe(1);
    expect(p.detail.version).toBeGreaterThan(v);
    p.dispose();
  });

  it('works without a renderer (headless): anisotropy 1, warm-up is a no-op', () => {
    const { ctx } = fakeCtx();
    (ctx as { renderer: unknown }).renderer = null;
    const p = createPitch(ctx);
    expect(p.detail.anisotropy).toBe(1);
    expect(() => p.warmUp!()).not.toThrow();
    p.dispose();
  });
});

describe('GFX-03 2D reference drawing', () => {
  it('draws the stripes and every marking, balanced save / restore', () => {
    const calls: string[] = [];
    let depth = 0, maxDepth = 0;
    const g = new Proxy({}, {
      get: (_t, prop: string) => {
        if (prop === 'save') return () => { depth++; maxDepth = Math.max(maxDepth, depth); calls.push('save'); };
        if (prop === 'restore') return () => { depth--; calls.push('restore'); };
        return (...args: unknown[]) => { calls.push(`${prop}(${args.map((a) => (typeof a === 'number' ? +a.toFixed(3) : a)).join(',')})`); };
      },
      set: (_t, prop: string, v: unknown) => { calls.push(`${prop}=${String(v)}`); return true; },
    }) as unknown as CanvasRenderingContext2D;
    drawQuarterPitch(g, 1200, 840);
    expect(depth).toBe(0);
    expect(maxDepth).toBeGreaterThan(0);
    expect(calls).toContain('scale(20,20)');
    const rects = PITCH_MARKS.filter((m): m is RectMark => m.kind === 'rect');
    for (const m of rects) expect(calls).toContain(`fillRect(${+m.x0.toFixed(3)},${+m.z0.toFixed(3)},${+(m.x1 - m.x0).toFixed(3)},${+(m.z1 - m.z0).toFixed(3)})`);
    const rings = PITCH_MARKS.filter((m): m is RingMark => m.kind === 'ring');
    const discs = PITCH_MARKS.filter((m): m is DiscMark => m.kind === 'disc');
    expect(calls.filter((c) => c.startsWith('arc(')).length).toBe(2 * rings.length + discs.length);
    expect(calls.filter((c) => c === 'clip()').length).toBe(rings.length);
    expect(calls).toContain(`fillStyle=${LINE_COLOUR}`);
    expect(calls.filter((c) => c.startsWith('fillRect(')).length).toBeGreaterThan(rects.length + 10);
    expect(EPS).toBeGreaterThan(0);
  });
});
