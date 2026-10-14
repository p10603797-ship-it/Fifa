/**
 * [GFX-07] Low-poly body part geometry (helper of src/render/players/model.ts). Every part is built in its joint's
 * local space (see fk.ts: limbs hang along -y from the joint, torso and head rise along +y, boots point along +x)
 * for the 180 cm reference body, so a part's instance matrix is simply its joint's world frame.
 *
 * Each vertex carries `aSel` (0 or 1): the shader colours it with the instance's colour A or B, so one part draws
 * two kit regions with crisp edges (sleeve / arm, shorts / thigh, sock / knee, skin / hair, hand / glove, shirt /
 * collar trim). Region edges follow whole triangles (bands of a lathe, or a predicate on a triangle's centroid).
 * Geometry is non-indexed (a triangle soup) with smooth normals from the analytic surface. Built once per renderer.
 */

import { BufferAttribute, BufferGeometry } from 'three';
import { BODY } from './fk';

/** Body part meshes (one InstancedMesh each). */
export const Part = {
  HEAD: 0,
  TORSO: 1,
  PELVIS: 2,
  UPPER_ARM: 3,
  LOWER_ARM: 4,
  UPPER_LEG: 5,
  LOWER_LEG: 6,
  BOOT: 7,
} as const;
export const PART_COUNT = 8;
/** Instances per part: 22 for single parts, 44 for paired limbs (index = slot * 2 + side, side 0 left, 1 right). */
export const PART_PAIRED: readonly boolean[] = [false, false, false, true, true, true, true, true];
export const PART_NAMES: readonly string[] = ['head', 'torso', 'pelvis', 'upper-arm', 'lower-arm', 'upper-leg', 'lower-leg', 'boot'];

/** Torso extent along the spine (local y, m): hem and collar. The shader maps kit patterns onto this range. */
export const TORSO_Y0 = -0.05;
export const TORSO_Y1 = 0.555;
/** Shirt hem half extents (front-back, side-side) at TORSO_Y0. */
export const HEM_RX = 0.124;
export const HEM_RZ = 0.19;
/**
 * Shirt-number panel on the back (torso local, m): centre height, width (across z) and height. Its 1.2 : 1 aspect is
 * the glyph cell aspect of the number atlas (kits.ts NUMBER_GLYPH_W / NUMBER_GLYPH_H), so digits are not stretched.
 */
export const NUMBER_PANEL = { y: 0.33, w: 0.3, h: 0.25 } as const;

/** Accumulates a triangle soup: positions, normals and the colour selector. */
export class SoupBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly sel: number[] = [];

  /** One triangle (a, b, c are xyz triples; na, nb, nc their normals). Wound counter-clockwise seen from outside. */
  tri(a: ArrayLike<number>, b: ArrayLike<number>, c: ArrayLike<number>, na: ArrayLike<number>, nb: ArrayLike<number>, nc: ArrayLike<number>, sel: number): void {
    // Skip degenerate triangles (pole rings).
    const ux = b[0]! - a[0]!, uy = b[1]! - a[1]!, uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!, vy = c[1]! - a[1]!, vz = c[2]! - a[2]!;
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const area2 = gx * gx + gy * gy + gz * gz;
    if (!(area2 > 1e-14)) return;
    // Orient with the mean vertex normal (outward).
    const mx = na[0]! + nb[0]! + nc[0]!, my = na[1]! + nb[1]! + nc[1]!, mz = na[2]! + nb[2]! + nc[2]!;
    const flip = gx * mx + gy * my + gz * mz < 0;
    const p = flip ? [a, c, b] : [a, b, c];
    const n = flip ? [na, nc, nb] : [na, nb, nc];
    for (let k = 0; k < 3; k++) {
      this.pos.push(p[k]![0]!, p[k]![1]!, p[k]![2]!);
      this.nrm.push(n[k]![0]!, n[k]![1]!, n[k]![2]!);
      this.sel.push(sel);
    }
  }

  get triangles(): number {
    return this.pos.length / 9;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('aSel', new BufferAttribute(new Float32Array(this.sel), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

/**
 * One lathe ring: position along the axis, half extents across it (rx along local x, rz along local z), centre
 * offset (cx, cz) and the selector of the band from this ring to the next. A ring with rx = rz = 0 is a pole.
 */
export interface Ring {
  y: number;
  rx: number;
  rz: number;
  cx?: number;
  cz?: number;
  sel?: number;
}

export interface LatheOptions {
  /** Segments around the axis. */
  seg: number;
  /** Axis: 'y' (default) or 'x' (lathe y becomes +x, lathe x becomes -y: boots). */
  axis?: 'y' | 'x';
  /** Per-triangle selector from the centroid (overrides the ring's band selector). */
  selAt?: (x: number, y: number, z: number) => number;
  /** Angle of the first segment (rad); default 0 (a vertex straight ahead, +x). */
  phase?: number;
}

/** Elliptic lathe through `rings` (in order along the axis), appended to `b`. */
export function lathe(b: SoupBuilder, rings: readonly Ring[], opt: LatheOptions): void {
  const seg = opt.seg;
  const n = rings.length;
  const P: number[][][] = [];
  const N: number[][][] = [];
  const ph = opt.phase ?? 0;
  for (let k = 0; k < n; k++) {
    const r = rings[k]!;
    const row: number[][] = [];
    for (let j = 0; j < seg; j++) {
      const a = ph + (j / seg) * Math.PI * 2;
      row.push([(r.cx ?? 0) + r.rx * Math.cos(a), r.y, (r.cz ?? 0) + r.rz * Math.sin(a)]);
    }
    P.push(row);
  }
  // Smooth normals: cross product of the tangent around the ring and the tangent along the profile.
  for (let k = 0; k < n; k++) {
    const r = rings[k]!;
    const row: number[][] = [];
    const kp = Math.max(0, k - 1), kn = Math.min(n - 1, k + 1);
    for (let j = 0; j < seg; j++) {
      const a = ph + (j / seg) * Math.PI * 2;
      const pole = r.rx === 0 && r.rz === 0;
      // Profile tangent from the neighbouring rings.
      let ty = P[kn]![j]![1]! - P[kp]![j]![1]!;
      let tx = P[kn]![j]![0]! - P[kp]![j]![0]!;
      let tz = P[kn]![j]![2]! - P[kp]![j]![2]!;
      if (tx === 0 && ty === 0 && tz === 0) { ty = 1; tx = 0; tz = 0; }
      // Ring tangent (direction only; a pole uses the ellipse direction).
      const rx = Math.max(r.rx, 1e-3), rz = Math.max(r.rz, 1e-3);
      const ux = -rx * Math.sin(a), uz = rz * Math.cos(a);
      let nx = 0 * tz - uz * ty;
      let ny = uz * tx - ux * tz;
      let nz = ux * ty - 0 * tx;
      // Outward: away from the axis (or along the axis at a pole).
      const ox = Math.cos(a) / rx, oz = Math.sin(a) / rz;
      if (pole) {
        const dir = k === 0 ? -1 : 1; // first ring caps the start of the axis, last ring the end
        const sy = Math.sign(P[kn]![j]![1]! - P[kp]![j]![1]!) || 1;
        nx = 0; nz = 0; ny = dir * sy;
      } else if (nx * ox + nz * oz < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      row.push([nx / l, ny / l, nz / l]);
    }
    N.push(row);
  }
  const toAxis = (v: number[]): number[] => (opt.axis === 'x' ? [v[1]!, -v[0]!, v[2]!] : v);
  for (let k = 0; k < n - 1; k++) {
    const bandSel = rings[k]!.sel ?? 0;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      const a = toAxis(P[k]![j]!), bq = toAxis(P[k]![j2]!), c = toAxis(P[k + 1]![j2]!), d = toAxis(P[k + 1]![j]!);
      const na = toAxis(N[k]![j]!), nb = toAxis(N[k]![j2]!), nc = toAxis(N[k + 1]![j2]!), nd = toAxis(N[k + 1]![j]!);
      const s1 = opt.selAt ? opt.selAt((a[0]! + bq[0]! + c[0]!) / 3, (a[1]! + bq[1]! + c[1]!) / 3, (a[2]! + bq[2]! + c[2]!) / 3) : bandSel;
      const s2 = opt.selAt ? opt.selAt((a[0]! + c[0]! + d[0]!) / 3, (a[1]! + c[1]! + d[1]!) / 3, (a[2]! + c[2]! + d[2]!) / 3) : bandSel;
      b.tri(a, bq, c, na, nb, nc, s1);
      b.tri(a, c, d, na, nc, nd, s2);
    }
  }
}

/** Rings of an ellipsoid (centre cy on the axis, half extents rx, ry, rz), `lat` bands from top to bottom. */
export function ellipsoidRings(cy: number, rx: number, ry: number, rz: number, lat: number, cx = 0): Ring[] {
  const out: Ring[] = [];
  for (let i = 0; i <= lat; i++) {
    const t = (i / lat) * Math.PI;
    const s = i === 0 || i === lat ? 0 : Math.sin(t);
    out.push({ y: cy + ry * Math.cos(t), rx: rx * s, rz: rz * s, cx });
  }
  return out;
}

/** A small pyramid (nose) pointing along +x from (x, y, 0). */
function nose(b: SoupBuilder, x: number, y: number, len: number, w: number, h: number, sel: number): void {
  const tip = [x + len, y - h * 0.2, 0];
  const p = [[x, y + h, 0], [x, y - h, -w], [x, y - h, w]];
  for (let i = 0; i < 3; i++) {
    const a = p[i]!, c = p[(i + 1) % 3]!;
    const nx = 0.7, ny = (a[1]! + c[1]!) / 2 - y, nz = (a[2]! + c[2]!) / 2;
    const l = Math.hypot(nx, ny, nz);
    const nn = [nx / l, ny / l, nz / l];
    b.tri(a, c, tip, nn, nn, nn, sel);
  }
}

/** Head and neck (neck-base local). Colour A = skin, B = hair. */
function buildHead(b: SoupBuilder): void {
  const hy = BODY.headY;
  lathe(b, [
    { y: -0.03, rx: 0, rz: 0 }, { y: -0.03, rx: 0.05, rz: 0.05 }, { y: hy - 0.05, rx: 0.048, rz: 0.048 }, { y: hy - 0.05, rx: 0, rz: 0 },
  ], { seg: 6 });
  // Hairline: high on the forehead, low at the nape.
  const hairline = (x: number): number => (x > 0 ? 0.035 + 0.5 * x : 0.035 + 0.95 * x);
  lathe(b, ellipsoidRings(hy, BODY.headRX, BODY.headRY, BODY.headRZ, 8, 0.004), {
    seg: 10,
    selAt: (x, y) => (y - hy > hairline(x) ? 1 : 0),
  });
  nose(b, BODY.headRX - 0.006, hy - 0.005, 0.03, 0.016, 0.022, 0);
}

/** Torso (spine-pivot local), hem to collar. Colour A = shirt (pattern in the shader), B = trim (collar). */
function buildTorso(b: SoupBuilder): void {
  // The hem flares a little (rx HEM_RX, rz 0.19) so it hangs over the shorts and the tops of the thighs, also with the
  // hips flexed; the collar is a narrow trim band around the neck.
  lathe(b, [
    { y: TORSO_Y0, rx: 0, rz: 0 },
    { y: TORSO_Y0, rx: HEM_RX, rz: HEM_RZ },
    { y: 0.04, rx: 0.12, rz: 0.184 },
    { y: 0.16, rx: 0.116, rz: 0.176, cx: 0.004 },
    { y: 0.29, rx: 0.12, rz: 0.19, cx: 0.012 },
    { y: 0.41, rx: 0.118, rz: 0.205, cx: 0.01 },
    { y: 0.48, rx: 0.106, rz: 0.21, cx: 0.004 },
    { y: 0.525, rx: 0.08, rz: 0.15 },
    { y: 0.542, rx: 0.06, rz: 0.078, sel: 1 },
    { y: TORSO_Y1, rx: 0.05, rz: 0.06, sel: 1 },
    { y: TORSO_Y1, rx: 0, rz: 0, sel: 1 },
  ], { seg: 10, phase: Math.PI / 10 });
}

/** Shorts body (hip-level local). Colour A = shorts. */
function buildPelvis(b: SoupBuilder): void {
  // Well inside the shirt hem (HEM_RX, HEM_RZ at y = spineY + TORSO_Y0 = -0.05) where they overlap: the shirt hangs
  // over the shorts with a clear gap (>= 1.4 cm), so the surfaces never z-fight and a lean shows no shorts "teeth".
  lathe(b, [
    { y: 0.06, rx: 0, rz: 0 }, { y: 0.06, rx: 0.07, rz: 0.12 }, { y: 0.0, rx: 0.078, rz: 0.138 },
    { y: -0.03, rx: 0.084, rz: 0.148 }, { y: -0.065, rx: 0.093, rz: 0.155 }, { y: -0.1, rx: 0.05, rz: 0.08 },
    { y: -0.1, rx: 0, rz: 0 },
  ], { seg: 8, phase: Math.PI / 8 });
}

/** Upper arm (shoulder local). Colour A = sleeve, B = skin (keepers: sleeve too). */
function buildUpperArm(b: SoupBuilder): void {
  lathe(b, [
    { y: 0.055, rx: 0, rz: 0 }, { y: 0.035, rx: 0.046, rz: 0.046 }, { y: 0.0, rx: 0.06, rz: 0.058 },
    { y: -0.13, rx: 0.058, rz: 0.056 }, { y: -0.13, rx: 0.047, rz: 0.047, sel: 1 }, { y: -0.27, rx: 0.042, rz: 0.042, sel: 1 },
    { y: -0.31, rx: 0, rz: 0 },
  ], { seg: 6 });
}

/** Forearm and hand (elbow local). Colour A = forearm skin (keepers: sleeve), B = hand (keepers: glove). */
function buildLowerArm(b: SoupBuilder): void {
  const f = BODY.foreArm;
  lathe(b, [
    { y: 0.04, rx: 0, rz: 0 }, { y: 0.025, rx: 0.044, rz: 0.044 }, { y: -0.1, rx: 0.042, rz: 0.04 },
    { y: -f + 0.01, rx: 0.033, rz: 0.03 }, { y: -f + 0.01, rx: 0, rz: 0 },
  ], { seg: 6 });
  lathe(b, [
    { y: -f + 0.015, rx: 0, rz: 0, sel: 1 }, { y: -f + 0.005, rx: 0.032, rz: 0.022, sel: 1 }, { y: -f - 0.045, rx: 0.044, rz: 0.024, sel: 1 },
    { y: -f - BODY.hand + 0.02, rx: 0.036, rz: 0.021, sel: 1 }, { y: -f - BODY.hand, rx: 0, rz: 0, sel: 1 },
  ], { seg: 6 });
}

/**
 * Thigh (hip local). Colour A = shorts leg, B = skin. The top tapers inside the shirt and the shorts body (hidden
 * there) so a flexed hip (running stride, keeper stance) does not cut through the lower shirt as jagged shorts-coloured
 * "teeth" above the hem (regression test tests/unit/gfx-07-hem.test.ts); the shorts leg flares out below.
 */
function buildUpperLeg(b: SoupBuilder): void {
  const t = BODY.thigh;
  lathe(b, [
    { y: 0.05, rx: 0, rz: 0 }, { y: 0.035, rx: 0.045, rz: 0.045 }, { y: 0.0, rx: 0.055, rz: 0.055 },
    { y: -0.05, rx: 0.06, rz: 0.06 }, { y: -0.11, rx: 0.074, rz: 0.074 },
    { y: -0.19, rx: 0.088, rz: 0.088 }, { y: -0.19, rx: 0.074, rz: 0.074, sel: 1 }, { y: -t + 0.06, rx: 0.062, rz: 0.06, sel: 1 },
    { y: -t, rx: 0.056, rz: 0.054, sel: 1 }, { y: -t - 0.04, rx: 0, rz: 0, sel: 1 },
  ], { seg: 6 });
}

/** Shin (knee local). Colour A = sock, B = skin (knee). */
function buildLowerLeg(b: SoupBuilder): void {
  const s = BODY.shin;
  lathe(b, [
    { y: 0.035, rx: 0, rz: 0, sel: 1 }, { y: 0.02, rx: 0.056, rz: 0.054, sel: 1 }, { y: -0.06, rx: 0.06, rz: 0.058 },
    { y: -0.06, rx: 0.066, rz: 0.064 }, { y: -0.15, rx: 0.066, rz: 0.062 }, { y: -0.3, rx: 0.05, rz: 0.047 },
    { y: -s + 0.02, rx: 0.042, rz: 0.04 }, { y: -s - 0.02, rx: 0, rz: 0 },
  ], { seg: 6 });
}

/** Boot (ankle local), heel to toe along +x, flat sole at y = -ankleY. Colour A = boot. */
function buildBoot(b: SoupBuilder): void {
  const sole = -BODY.ankleY;
  // Lathe x is vertical (becomes -y). Six segments with a 30 degree phase put a flat face at the bottom, at
  // hh * cos(30 deg) below the ring centre: cx = -(sole + hh * cos 30) puts that face exactly on the sole.
  const c30 = Math.cos(Math.PI / 6);
  const ring = (x: number, hh: number, hw: number): Ring => ({ y: x, rx: hh, rz: hw, cx: -(sole + hh * c30) });
  lathe(b, [
    { y: BODY.heelX - 0.005, rx: 0, rz: 0, cx: -(sole + 0.05) },
    ring(BODY.heelX + 0.01, 0.05, 0.04), ring(0.02, 0.056, 0.05), ring(0.12, 0.04, 0.05), ring(BODY.toeX - 0.02, 0.026, 0.04),
    { y: BODY.toeX, rx: 0, rz: 0, cx: -(sole + 0.02) },
  ], { seg: 6, axis: 'x', phase: Math.PI / 6 });
}

const BUILDERS: readonly ((b: SoupBuilder) => void)[] = [
  buildHead, buildTorso, buildPelvis, buildUpperArm, buildLowerArm, buildUpperLeg, buildLowerLeg, buildBoot,
];

/** Triangle soup of one part (for tests and the model). */
export function buildPartSoup(part: number): SoupBuilder {
  const b = new SoupBuilder();
  BUILDERS[part]!(b);
  return b;
}

/** BufferGeometry of one part: position, normal, aSel. */
export function buildPartGeometry(part: number): BufferGeometry {
  return buildPartSoup(part).build();
}

/** Triangles drawn per player (paired parts count twice). */
export function trianglesPerPlayer(): number {
  let n = 0;
  for (let p = 0; p < PART_COUNT; p++) n += buildPartSoup(p).triangles * (PART_PAIRED[p] ? 2 : 1);
  return n;
}
