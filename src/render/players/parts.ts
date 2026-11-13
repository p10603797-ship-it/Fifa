/**
 * [GFX-07] Low-poly body part geometry (helper of src/render/players/model.ts). Every part is built in its joint's
 * local space (see fk.ts: limbs hang along -y from the joint, torso and head rise along +y, boots point along +x)
 * for the 180 cm reference body, so a part's instance matrix is simply its joint's world frame.
 *
 * [LOOK] The figure is an athletic stylised build on the unchanged skeleton (fk.ts BODY: joint positions, foot,
 * hand and head extents are what IK, contact, reach, the ground snap and the foot lock use, so none of them moves):
 * a V-shaped shirt (chest, lats and shoulder slope over a narrower waist; flat back for the number), rounded deltoid
 * caps inside cuffed short sleeves, tapered biceps and forearms, a shaped thigh with a quad bulge under flared
 * shorts, a calf under a cuffed sock, ball-ended knees and elbows (both parts at a joint end in a sphere of the same
 * radius around the joint, so a bent joint shows no gap or kink), a head with a jaw, brow, nose and ears, mitten
 * hands with a thumb, oversized keeper gloves, and boots with a shaped toe and a sole.
 *
 * Each vertex carries `aSel` (0 or 1): the shader colours it with the instance's colour A or B, so one part draws
 * two regions with crisp edges (sleeve / arm, shorts / thigh, sock / knee, skin / hair and brows, hand / glove, shirt
 * / collar trim, boot / sole). Region edges follow whole triangles.
 *
 * Each vertex also carries `aVar`, a variant id: 0 is always drawn; any other id is drawn only on instances whose
 * per-instance `iVar` equals it (the vertex shader collapses the others to a point: zero-area triangles that are
 * never rasterised). That gives several hair styles (head) and bare hands or keeper gloves (forearm) without extra
 * draw calls. Variant triangles count in the budgets (the GPU still runs their vertices).
 *
 * LODs: lod 1 (default) is the full model; lod 0 (PERFORMANCE tier) is the same shapes with fewer segments, no
 * larger than the pre-[LOOK] model (1,123 triangles per player).
 *
 * Geometry is non-indexed (a triangle soup) with smooth normals (area-weighted face normals of each surface grid).
 * Built once per renderer and LOD.
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

/** Hair styles (head variants; per-instance iVar of the head). BUZZ draws no shell (the scalp cap alone). */
export const HairStyle = {
  BUZZ: 1,
  SHORT: 2,
  SWEPT: 3,
  CURLY: 4,
  TIED: 5,
} as const;
export const HAIR_STYLE_COUNT = 5;
/** Sleeve variants (per-instance iVar of the upper arm; full LOD only). */
export const SleeveVariant = {
  SHORT: 1,
  LONG: 2,
} as const;
/** Hand variants (per-instance iVar of the forearm). */
export const HandVariant = {
  BARE: 1,
  GLOVE: 2,
} as const;
/** Highest point of any hair style above the crown (BODY.headY + BODY.headRY), m. */
export const HAIR_MAX_RISE = 0.05;

/** Geometry detail: 0 = PERFORMANCE LOD, 1 = full. */
export type PartLod = 0 | 1;

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

type V3 = [number, number, number];

/** Accumulates a triangle soup: positions, normals, the colour selector and the variant id. */
export class SoupBuilder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly sel: number[] = [];
  readonly vars: number[] = [];
  /** Variant id written with the next triangles (0 = always drawn). */
  variant = 0;

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
      this.vars.push(this.variant);
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
    g.setAttribute('aVar', new BufferAttribute(new Float32Array(this.vars), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// ============================================================ surface grids

/** Selector of a triangle from its centroid (and the grid row it starts on). */
type SelFn = (x: number, y: number, z: number, row: number) => number;

/**
 * A surface grid: rows of points (P[row][col]); columns wrap around (a closed tube). Rows whose points coincide are
 * poles. Smooth normals: area-weighted face normals, oriented away from the grid's centroid. Appended to `b`.
 */
function grid(b: SoupBuilder, P: V3[][], sel: SelFn): void {
  const R = P.length, C = P[0]!.length;
  const N: V3[][] = P.map((row) => row.map((): V3 => [0, 0, 0]));
  const add = (n: V3, x: number, y: number, z: number): void => { n[0] += x; n[1] += y; n[2] += z; };
  const face = (a: V3, bq: V3, c: V3, na: V3, nb: V3, nc: V3): void => {
    const ux = bq[0] - a[0], uy = bq[1] - a[1], uz = bq[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    add(na, gx, gy, gz); add(nb, gx, gy, gz); add(nc, gx, gy, gz);
  };
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C; c++) {
      const c2 = (c + 1) % C;
      face(P[r]![c]!, P[r]![c2]!, P[r + 1]![c2]!, N[r]![c]!, N[r]![c2]!, N[r + 1]![c2]!);
      face(P[r]![c]!, P[r + 1]![c2]!, P[r + 1]![c]!, N[r]![c]!, N[r + 1]![c2]!, N[r + 1]![c]!);
    }
  }
  // Poles: one shared normal (the sum around the pole).
  for (let r = 0; r < R; r++) {
    const row = P[r]!;
    let span = 0;
    for (let c = 1; c < C; c++) span = Math.max(span, Math.abs(row[c]![0] - row[0]![0]) + Math.abs(row[c]![1] - row[0]![1]) + Math.abs(row[c]![2] - row[0]![2]));
    if (span > 1e-9) continue;
    const s: V3 = [0, 0, 0];
    for (let c = 0; c < C; c++) add(s, N[r]![c]![0], N[r]![c]![1], N[r]![c]![2]);
    for (let c = 0; c < C; c++) N[r]![c] = [s[0], s[1], s[2]];
  }
  // Orientation: outward from the centroid.
  let cx = 0, cy = 0, cz = 0, cnt = 0;
  for (const row of P) for (const p of row) { cx += p[0]; cy += p[1]; cz += p[2]; cnt++; }
  cx /= cnt; cy /= cnt; cz /= cnt;
  let vote = 0;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const p = P[r]![c]!, n = N[r]![c]!;
    vote += n[0] * (p[0] - cx) + n[1] * (p[1] - cy) + n[2] * (p[2] - cz);
  }
  const sgn = vote < 0 ? -1 : 1;
  for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    const n = N[r]![c]!;
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l > 1e-12) N[r]![c] = [sgn * n[0] / l, sgn * n[1] / l, sgn * n[2] / l];
    else {
      const p = P[r]![c]!;
      const d = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) || 1;
      N[r]![c] = [(p[0] - cx) / d, (p[1] - cy) / d, (p[2] - cz) / d];
    }
  }
  for (let r = 0; r < R - 1; r++) {
    for (let c = 0; c < C; c++) {
      const c2 = (c + 1) % C;
      const a = P[r]![c]!, bq = P[r]![c2]!, cc = P[r + 1]![c2]!, d = P[r + 1]![c]!;
      const s1 = sel((a[0] + bq[0] + cc[0]) / 3, (a[1] + bq[1] + cc[1]) / 3, (a[2] + bq[2] + cc[2]) / 3, r);
      const s2 = sel((a[0] + cc[0] + d[0]) / 3, (a[1] + cc[1] + d[1]) / 3, (a[2] + cc[2] + d[2]) / 3, r);
      b.tri(a, bq, cc, N[r]![c]!, N[r]![c2]!, N[r + 1]![c2]!, s1);
      b.tri(a, cc, d, N[r]![c]!, N[r + 1]![c2]!, N[r + 1]![c]!, s2);
    }
  }
}

/**
 * One cross-section of a tube along local y: front (+x) and back half depths, side half width, centre offset, the
 * selector of the band from this section to the next, and a superellipse exponent (2 = ellipse, larger = boxier).
 */
export interface Sec {
  y: number;
  rf: number;
  rb: number;
  rz: number;
  cx?: number;
  cz?: number;
  sel?: number;
  e?: number;
  /** Full LOD only (dropped at lod 0). */
  hi?: boolean;
}

const sec = (y: number, rf: number, rb: number, rz: number, sel = 0, cx = 0): Sec => ({ y, rf, rb, rz, sel, cx });
const round = (y: number, r: number, sel = 0): Sec => ({ y, rf: r, rb: r, rz: r, sel });
/** A section drawn only at the full LOD. */
const hi = (s: Sec): Sec => ({ ...s, hi: true });

/** Sections of a hemispherical end around (0, y0, 0): radius r, toward dir (+1 up, -1 down), n rings (last a pole). */
function dome(y0: number, r: number, dir: number, n: number, sel = 0, flat = 1): Sec[] {
  const out: Sec[] = [];
  for (let i = 1; i <= n; i++) {
    const t = (i / n) * (Math.PI / 2);
    const k = i === n ? 0 : Math.cos(t);
    out.push({ y: y0 + dir * r * Math.sin(t) * flat, rf: r * k, rb: r * k, rz: r * k, sel });
  }
  return out;
}

/** Tube through `secs` (in order along y), `seg` points around; selector per band (or `selAt`). */
function tube(b: SoupBuilder, d: Detail, all: readonly Sec[], seg: number, selAt?: SelFn, phase = 0): void {
  const secs = d.features ? all : all.filter((s) => !s.hi);
  const P: V3[][] = secs.map((s) => {
    const row: V3[] = [];
    const ex = 2 / (s.e ?? 2);
    for (let j = 0; j < seg; j++) {
      const a = phase + (j / seg) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const pc = Math.sign(c) * Math.abs(c) ** ex, ps = Math.sign(sn) * Math.abs(sn) ** ex;
      row.push([(s.cx ?? 0) + (c >= 0 ? s.rf : s.rb) * pc, s.y, (s.cz ?? 0) + s.rz * ps]);
    }
    return row;
  });
  grid(b, P, selAt ?? ((_x, _y, _z, row) => secs[row]!.sel ?? 0));
}

/** Ellipsoid around c with (scaled) axis vectors u (pole axis), v, w; `lat` rows, `seg` around. */
function ellipsoid(b: SoupBuilder, c: V3, u: V3, v: V3, w: V3, lat: number, seg: number, sel: number): void {
  const P: V3[][] = [];
  for (let i = 0; i <= lat; i++) {
    const t = (i / lat) * Math.PI;
    const ct = i === 0 ? 1 : i === lat ? -1 : Math.cos(t), st = i === 0 || i === lat ? 0 : Math.sin(t);
    const row: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const ca = Math.cos(a) * st, sa = Math.sin(a) * st;
      row.push([
        c[0] + u[0] * ct + v[0] * ca + w[0] * sa,
        c[1] + u[1] * ct + v[1] * ca + w[1] * sa,
        c[2] + u[2] * ct + v[2] * ca + w[2] * sa,
      ]);
    }
    P.push(row);
  }
  grid(b, P, () => sel);
}

// ============================================================ detail per LOD

interface Detail {
  /** Segments around: torso, pelvis, arms, legs, hands, head, hair. */
  torso: number;
  pelvis: number;
  arm: number;
  leg: number;
  hand: number;
  skullSeg: number;
  skullLat: number;
  hairSeg: number;
  hairRows: number;
  /** Rings per joint-ball hemisphere. */
  dome: number;
  /** Ears, brows and thumbs drawn. */
  features: boolean;
  bootSeg: number;
}

const DETAIL: readonly Detail[] = [
  { torso: 8, pelvis: 6, arm: 5, leg: 6, hand: 4, skullSeg: 8, skullLat: 5, hairSeg: 5, hairRows: 1, dome: 1, features: false, bootSeg: 5 },
  { torso: 12, pelvis: 8, arm: 8, leg: 8, hand: 6, skullSeg: 12, skullLat: 9, hairSeg: 10, hairRows: 3, dome: 2, features: true, bootSeg: 7 },
];

// ============================================================ head

const HY = BODY.headY;
/** The skull's centre below BODY.headY (m). */
const SKULL_DROP = 0.012;
/** Skull width over BODY.headRZ. */
const HEAD_WIDEN = 1.07;

/** Skull surface point for polar angle phi (0 = crown) and azimuth th (0 = front, +x; pi/2 = his right, +z). */
function skull(phi: number, th: number): V3 {
  const st = Math.sin(phi);
  const dx = st * Math.cos(th), dy = Math.cos(phi), dz = st * Math.sin(th);
  // Centred SKULL_DROP below the skeleton's head centre with a taller cranium, so the crown stays on BODY.headY +
  // headRY and the jaw sits closer to the collar (a shorter visible neck).
  let x = BODY.headRX * dx, y = (BODY.headRY + SKULL_DROP) * dy - SKULL_DROP, z = BODY.headRZ * dz;
  const low = Math.max(-dy, 0);
  // Jaw narrower than the cranium; face a little narrower than the back of the head.
  z *= 1 - 0.2 * low ** 1.5 - 0.05 * Math.max(dx, 0) ** 2;
  // Nape tucks in toward the neck; the chin stays forward.
  if (dx < 0) x *= 1 - 0.3 * low;
  else x *= 1 - 0.1 * low * low;
  // A slightly larger head than the skeleton's ellipsoid (readability): wider, and a longer lower half that brings
  // the jaw and chin down toward the collar (the crown stays at BODY.headY + headRY).
  if (dy < 0) y = -SKULL_DROP - BODY.headRY * 1.06 * low ** 0.8; // a squarer jaw line than the ellipsoid's
  z *= HEAD_WIDEN;
  x *= 1.04;
  if (dx < 0 && dy > 0) x *= 1 + 0.06 * dy;
  // Brow ridge.
  x += 0.008 * Math.max(dx, 0) ** 6 * Math.exp(-(((dy - 0.3) / 0.12) ** 2));
  return [x, HY + y, z];
}

/** Hairline: hair above this height (head-centre relative) at a given x (high on the forehead, low at the nape). */
function hairline(x: number): number {
  return x > 0 ? 0.035 + 0.5 * x : 0.035 + 0.95 * x;
}

/** Polar angle of the hairline on the skull at azimuth th. */
function hairPhi(th: number): number {
  let lo = 0, hi = Math.PI;
  for (let k = 0; k < 40; k++) {
    const m = (lo + hi) / 2;
    const p = skull(m, th);
    if (p[1] - HY > hairline(p[0])) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** A hair shell: the skull from the crown down to the hairline, pushed out by off(th, s) (s 0 crown .. 1 edge). */
function hairShell(b: SoupBuilder, d: Detail, off: (th: number, s: number) => number, edge = 1): void {
  const seg = d.hairSeg, rows = d.hairRows + 1;
  const P: V3[][] = [];
  let o0 = 0;
  for (let j = 0; j < seg; j++) o0 += off((j / seg) * Math.PI * 2, 0) / seg;
  for (let i = 0; i <= rows; i++) {
    const s = i / rows;
    const row: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const th = (j / seg) * Math.PI * 2 + Math.PI / seg;
      const ph = hairPhi(th) * Math.min(s * edge, 1.04);
      const p = skull(ph, th);
      const rx = p[0], ry = p[1] - HY, rz = p[2];
      const l = Math.hypot(rx, ry, rz) || 1;
      const o = i === rows ? 0 : off(th, s);
      row.push(i === 0 ? [0, HY + BODY.headRY + o0, 0] : [p[0] + (rx / l) * o, p[1] + (ry / l) * o, p[2] + (rz / l) * o]);
    }
    P.push(row);
  }
  grid(b, P, () => 1);
}

/** Head, face and neck (neck-base local). Colour A = skin, B = hair (scalp, brows, hair styles). */
function buildHead(b: SoupBuilder, d: Detail): void {
  // Neck: a short, strong column from inside the collar into the skull.
  tube(b, d, [
    round(-0.045, 0, 0), sec(-0.045, 0.058, 0.062, 0.066), hi(sec(0.02, 0.055, 0.058, 0.058)), sec(0.09, 0.055, 0.059, 0.057, 0, -0.002),
    sec(0.14, 0.052, 0.058, 0.056, 0, -0.006), round(0.14, 0, 0),
  ], d.features ? 8 : 6);
  // Skull with jaw and brow; scalp above the hairline in the hair colour (BUZZ shows just this).
  const P: V3[][] = [];
  for (let i = 0; i <= d.skullLat; i++) {
    const phi = (i / d.skullLat) * Math.PI;
    const row: V3[] = [];
    for (let j = 0; j < d.skullSeg; j++) row.push(skull(phi, (j / d.skullSeg) * Math.PI * 2));
    P.push(row);
  }
  grid(b, P, (x, y) => (y - HY > hairline(x) ? 1 : 0));
  // Nose: a wedge on the face.
  const face = skull(Math.acos(-0.12), 0);
  nose(b, face[0] - 0.006, HY - 0.012, 0.034, 0.02, 0.03, 0);
  if (d.features) {
    // Ears.
    for (const s of [-1, 1]) {
      ellipsoid(b, [-0.008, HY - 0.008, s * (BODY.headRZ * HEAD_WIDEN - 0.004)], [0, 0.03, 0], [0.019, 0, 0], [0, 0, 0.014], 4, 6, 0);
    }
    // Brows in the hair colour (above the face band, so the face reads as skin).
    for (const s of [-1, 1]) {
      const p = skull(Math.acos((0.05 + SKULL_DROP) / (BODY.headRY + SKULL_DROP)), s * 0.36);
      ellipsoid(b, [p[0] - 0.001, HY + 0.05, p[2]], [0, 0.0065, 0], [0.007, 0, 0], [0, 0, 0.026], 2, 6, 1);
    }
  }
  // Hair styles (variants).
  b.variant = HairStyle.SHORT;
  hairShell(b, d, (th, s) => 0.011 + 0.006 * (1 - s) + 0.004 * Math.max(Math.cos(th), 0));
  b.variant = HairStyle.SWEPT;
  hairShell(b, d, (th, s) => {
    const front = Math.max(Math.cos(th), 0);
    return 0.01 + 0.03 * front * front * Math.sin(Math.min(s * 1.4, 1) * Math.PI * 0.9) + 0.008 * (1 - s) + 0.006 * Math.max(Math.sin(th), 0);
  });
  b.variant = HairStyle.CURLY;
  hairShell(b, d, (th, s) => 0.03 + 0.012 * (1 - s) + (d.features ? 0.006 * Math.sin(th * 5) * Math.sin(s * 9 + 1) : 0), 1.02);
  b.variant = HairStyle.TIED;
  hairShell(b, d, (_th, s) => 0.008 + 0.004 * (1 - s));
  ellipsoid(b, [-0.122, HY + 0.045, 0], [-0.014, 0.034, 0], [0.034, 0.012, 0], [0, 0, 0.034], d.features ? 4 : 3, d.hairSeg - 2, 1);
  b.variant = 0;
}

/** A small pyramid (nose) pointing along +x from (x, y, 0), with a base underneath. */
function nose(b: SoupBuilder, x: number, y: number, len: number, w: number, h: number, sel: number): void {
  const tip: V3 = [x + len, y - h * 0.35, 0];
  const p: V3[] = [[x, y + h, 0], [x - 0.004, y - h, -w], [x - 0.004, y - h, w]];
  for (let i = 0; i < 3; i++) {
    const a = p[i]!, c = p[(i + 1) % 3]!;
    const nx = 0.75, ny = (a[1] + c[1]) / 2 - y, nz = (a[2] + c[2]) / 2;
    const l = Math.hypot(nx, ny, nz);
    const nn: V3 = [nx / l, ny / l, nz / l];
    b.tri(a, c, tip, nn, nn, nn, sel);
  }
}

// ============================================================ torso and shorts

/** Torso (spine-pivot local), hem to collar. Colour A = shirt (pattern in the shader), B = trim (collar). */
function buildTorso(b: SoupBuilder, d: Detail): void {
  // V shape: hem and waist under a fuller rib cage and chest, lats and shoulder line, then the trapezius slope to a
  // crew collar with a small V at the front. The hem (HEM_RX, HEM_RZ) hangs over the shorts and the thigh tops; the
  // sides at elbow height stay inside the hanging arms; the back is flat under the number panel.
  const secs: Sec[] = [
    sec(TORSO_Y0, 0, 0, 0),
    sec(TORSO_Y0, HEM_RX, HEM_RX, HEM_RZ),
    hi(sec(-0.03, 0.122, 0.121, 0.187)),
    hi(sec(0.06, 0.121, 0.116, 0.181)),
    sec(0.15, 0.116, 0.112, 0.172),
    hi(sec(0.25, 0.13, 0.114, 0.182, 0, 0.004)),
    sec(0.33, 0.135, 0.12, 0.192, 0, 0.006),
    // [REPAIR] The shoulder line runs out to the sleeve seam (over the deltoid caps), so the outline goes smoothly from
    // the neck down onto the arm instead of the sleeves standing off the torso like pads.
    sec(0.405, 0.124, 0.124, 0.21, 0, 0.004),
    sec(0.455, 0.104, 0.112, 0.226),
    sec(0.497, 0.082, 0.088, 0.19),
    hi(sec(0.518, 0.072, 0.074, 0.1)),
    // Collar trim: a crew band around the neck (whole bands, so its edge is a clean line).
    sec(0.53, 0.073, 0.075, 0.088, 1),
    hi(sec(0.543, 0.07, 0.072, 0.078, 1)),
    sec(TORSO_Y1, 0.066, 0.068, 0.07, 1),
    sec(TORSO_Y1, 0, 0, 0, 1),
  ];
  tube(b, d, secs, d.torso, undefined, Math.PI / d.torso);
}

/** Shorts body (hip-level local). Colour A = shorts. */
function buildPelvis(b: SoupBuilder, d: Detail): void {
  // Inside the shirt hem where they overlap (the hem hangs over the shorts with a clear gap, so the surfaces never
  // z-fight); fuller below the hem at the hips and seat. [REPAIR] The front hangs straight (vertical, so it shades
  // like the shorts legs) just behind the fronts of the thigh tops, and closes in a short flat crotch between them: a
  // front fuller than the thighs, rounding down to a point, read as a darker lump between the legs in front views.
  tube(b, d, [
    round(0.06, 0), sec(0.06, 0.07, 0.07, 0.12), sec(0.0, 0.08, 0.085, 0.14), hi(sec(-0.035, 0.08, 0.092, 0.15)),
    sec(-0.075, 0.074, 0.106, 0.16), hi(sec(-0.1, 0.07, 0.098, 0.146)), sec(-0.122, 0.064, 0.07, 0.1), round(-0.128, 0),
  ], d.pelvis, undefined, Math.PI / d.pelvis);
}

// ============================================================ limbs

/**
 * Upper arm (shoulder local). Colour A = sleeve, B = skin (keepers: sleeve too). Full LOD: a short cuffed sleeve over a
 * bare arm (SleeveVariant.SHORT) or a smooth long sleeve (LONG, keepers); LOD 0 draws the short shape for everyone.
 */
function buildUpperArm(b: SoupBuilder, d: Detail): void {
  const u = BODY.upperArm;
  if (d.features) b.variant = SleeveVariant.SHORT;
  tube(b, d, [
    // Deltoid cap (sleeve) around the joint, so a raised or swung arm stays joined to the shoulder. [REPAIR] Lower and
    // flatter (its top sits inside the shirt's shoulder line) and a little narrower at the top of the sleeve.
    ...dome(-0.03, 0.058, 1, d.dome, 0, 0.42).reverse(),
    round(-0.03, 0.058),
    hi(sec(-0.075, 0.061, 0.06, 0.058)),
    // Sleeve cuff: a slight lip at the hem.
    hi(sec(-0.118, 0.066, 0.064, 0.062)),
    sec(-0.132, 0.066, 0.064, 0.062),
    // Bare arm from inside the cuff: biceps, then the elbow ball.
    sec(-0.132, 0.06, 0.059, 0.057, 1),
    hi(sec(-0.175, 0.064, 0.059, 0.056, 1, 0.003)),
    sec(-0.235, 0.055, 0.053, 0.052, 1),
    round(-u, 0.05, 1),
    ...dome(-u, 0.05, -1, d.dome, 1),
  ].map(fixPole), d.arm, (_x, y) => (y > -0.1325 ? 0 : 1));
  if (d.features) {
    b.variant = SleeveVariant.LONG;
    tube(b, d, [
      ...dome(-0.03, 0.058, 1, d.dome, 0, 0.42).reverse(),
      round(-0.03, 0.058),
      sec(-0.08, 0.061, 0.06, 0.058),
      sec(-0.15, 0.06, 0.058, 0.056, 1),
      sec(-0.225, 0.055, 0.053, 0.051, 1),
      round(-u, 0.05, 1),
      ...dome(-u, 0.05, -1, d.dome, 1),
    ].map(fixPole), d.arm, (_x, y) => (y > -0.1325 ? 0 : 1));
  }
  b.variant = 0;
}

/** Forearm and hand (elbow local). Colour A = forearm skin (keepers: sleeve), B = hand (variants: bare / glove). */
function buildLowerArm(b: SoupBuilder, d: Detail): void {
  const f = BODY.foreArm, tip = -(f + BODY.hand);
  tube(b, d, [
    ...dome(0, 0.05, 1, d.dome).reverse(),
    round(0, 0.05),
    hi(sec(-0.055, 0.054, 0.053, 0.049, 0, 0.002)),
    sec(-0.15, 0.045, 0.043, 0.04),
    sec(-f + 0.01, 0.033, 0.032, 0.028),
    round(-f - 0.005, 0),
  ].map(fixPole), d.arm);
  // Bare hand: a mitten (palm toward the body: thin across z) with a thumb at the front.
  b.variant = HandVariant.BARE;
  tube(b, d, [
    round(-f + 0.01, 0, 1), sec(-f + 0.01, 0.028, 0.028, 0.02, 1), sec(-f - 0.025, 0.04, 0.038, 0.023, 1),
    hi(sec(-f - 0.06, 0.04, 0.037, 0.021, 1)), sec(-f - 0.085, 0.031, 0.028, 0.018, 1), round(tip, 0, 1),
  ].map((s) => ({ ...s, e: 2.6 })), d.hand);
  if (d.features) ellipsoid(b, [0.034, -f - 0.03, 0], [0.012, -0.026, 0], [0.011, 0.005, 0], [0, 0, 0.011], 3, 5, 1);
  // Keeper glove: oversized, with a wide cuff, so the hands read at broadcast distance.
  b.variant = HandVariant.GLOVE;
  tube(b, d, [
    round(-f + 0.022, 0, 1), sec(-f + 0.022, 0.044, 0.044, 0.04, 1), hi(sec(-f - 0.002, 0.046, 0.046, 0.042, 1)),
    sec(-f - 0.012, 0.042, 0.04, 0.03, 1), sec(-f - 0.04, 0.056, 0.052, 0.032, 1), hi(sec(-f - 0.07, 0.055, 0.05, 0.03, 1)),
    sec(-f - 0.09, 0.043, 0.04, 0.026, 1), round(tip, 0, 1),
  ].map((s) => ({ ...s, e: 2.6 })), d.hand);
  ellipsoid(b, [0.05, -f - 0.03, 0], [0.016, -0.032, 0], [0.015, 0.007, 0], [0, 0, 0.016], 3, d.features ? 5 : 4, 1);
  b.variant = 0;
}

/**
 * Thigh (hip local). Colour A = shorts leg, B = skin. The top tapers inside the shirt and the shorts body (hidden
 * there) so a flexed hip (running stride, keeper stance) does not cut through the lower shirt as jagged shorts-coloured
 * "teeth" above the hem (regression test tests/unit/gfx-07-hem.test.ts); the shorts leg flares out at its hem.
 */
function buildUpperLeg(b: SoupBuilder, d: Detail): void {
  const t = BODY.thigh;
  tube(b, d, [
    round(0.05, 0), hi(round(0.035, 0.045)), round(0.0, 0.055), sec(-0.05, 0.06, 0.06, 0.058),
    sec(-0.11, 0.074, 0.074, 0.072), sec(-0.17, 0.092, 0.09, 0.088), hi(sec(-0.198, 0.102, 0.1, 0.097)),
    sec(-0.206, 0.102, 0.1, 0.097),
    // Skin from inside the shorts hem: quad bulge at the front, then the knee ball.
    sec(-0.206, 0.094, 0.09, 0.088, 1, 0.004), hi(sec(-0.27, 0.095, 0.084, 0.084, 1, 0.008)), sec(-0.35, 0.079, 0.07, 0.07, 1, 0.005),
    round(-t, 0.061, 1), ...dome(-t, 0.061, -1, d.dome, 1),
  ].map(fixPole), d.leg, (_x, y) => (y > -0.2065 ? 0 : 1));
}

/** Shin (knee local). Colour A = sock (cuffed, over the calf), B = skin (knee). */
function buildLowerLeg(b: SoupBuilder, d: Detail): void {
  const s = BODY.shin;
  tube(b, d, [
    ...dome(0, 0.061, 1, d.dome, 1).reverse(), sec(0, 0.064, 0.061, 0.061, 1), sec(-0.055, 0.057, 0.059, 0.055, 1),
    // Sock cuff (a small rolled lip), then the calf at the back, tapering to the ankle.
    sec(-0.066, 0.062, 0.066, 0.06), hi(sec(-0.084, 0.062, 0.069, 0.061)), hi(sec(-0.09, 0.056, 0.066, 0.056)),
    sec(-0.15, 0.056, 0.084, 0.062), hi(sec(-0.25, 0.048, 0.061, 0.051)), sec(-0.36, 0.039, 0.04, 0.037),
    round(-s, 0.034), ...dome(-s, 0.034, -1, d.dome),
  ].map(fixPole), d.leg, (_x, y) => (y > -0.066 ? 1 : 0));
}

/** Boot (ankle local), heel to toe along +x, flat sole at y = -ankleY. Colour A = boot, B = sole. */
function buildBoot(b: SoupBuilder, d: Detail): void {
  const sole = -BODY.ankleY;
  // Stations along the foot: x, upper height above the sole, half width, toe-spring lift of the bottom.
  const st: [number, number, number][] = d.features
    ? [[-0.072, 0.07, 0.03], [-0.055, 0.1, 0.042], [-0.015, 0.115, 0.046], [0.035, 0.098, 0.048], [0.085, 0.068, 0.05], [0.135, 0.05, 0.047], [0.172, 0.038, 0.039], [0.192, 0.028, 0.028]]
    : [[-0.07, 0.08, 0.034], [-0.02, 0.115, 0.046], [0.06, 0.08, 0.05], [0.15, 0.045, 0.043], [0.19, 0.03, 0.028]];
  const seg = d.bootSeg;
  const P: V3[][] = [];
  const pole = (x: number, y: number): V3[] => Array.from({ length: seg }, (): V3 => [x, y, 0]);
  P.push(pole(BODY.heelX - 0.016, sole + 0.04));
  for (const [x, h, w] of st) {
    const row: V3[] = [];
    for (let j = 0; j < seg; j++) {
      const a = -Math.PI / 2 + (j / seg) * Math.PI * 2; // first point straight down: on the sole
      const c = Math.cos(a), s = Math.sin(a);
      const pz = Math.sign(c) * Math.abs(c) ** 0.7, py = Math.sign(s) * Math.abs(s) ** 0.6;
      // Narrower at the top of the foot than across the sole.
      row.push([x, sole + (h / 2) * (1 + py), w * pz * (1 - 0.2 * Math.max(py, 0))]);
    }
    P.push(row);
  }
  P.push(pole(BODY.toeX, sole + 0.013));
  grid(b, P, (_x, y) => (y < sole + 0.011 ? 1 : 0));
}

/** Poles (radius 0 sections) need rf = rb = rz = 0. */
function fixPole(s: Sec): Sec {
  return s.rf === 0 || s.rz === 0 ? { ...s, rf: 0, rb: 0, rz: 0 } : s;
}

const BUILDERS: readonly ((b: SoupBuilder, d: Detail) => void)[] = [
  buildHead, buildTorso, buildPelvis, buildUpperArm, buildLowerArm, buildUpperLeg, buildLowerLeg, buildBoot,
];

/** Triangle soup of one part (for tests and the model). */
export function buildPartSoup(part: number, lod: PartLod = 1): SoupBuilder {
  const b = new SoupBuilder();
  BUILDERS[part]!(b, DETAIL[lod]!);
  return b;
}

/** BufferGeometry of one part: position, normal, aSel, aVar. */
export function buildPartGeometry(part: number, lod: PartLod = 1): BufferGeometry {
  return buildPartSoup(part, lod).build();
}

/** Triangles drawn per player (paired parts count twice; every variant counts: the GPU runs their vertices). */
export function trianglesPerPlayer(lod: PartLod = 1): number {
  let n = 0;
  for (let p = 0; p < PART_COUNT; p++) n += buildPartSoup(p, lod).triangles * (PART_PAIRED[p] ? 2 : 1);
  return n;
}

/** Triangles of one player as seen (one hair style, sleeve and hand variant): outfield look by default. */
export function visibleTrianglesPerPlayer(
  lod: PartLod = 1, style: number = HairStyle.SHORT, hand: number = HandVariant.BARE, sleeve: number = SleeveVariant.SHORT,
): number {
  let n = 0;
  for (let p = 0; p < PART_COUNT; p++) {
    const b = buildPartSoup(p, lod);
    const want = p === Part.HEAD ? style : p === Part.LOWER_ARM ? hand : p === Part.UPPER_ARM ? sleeve : 0;
    let k = 0;
    for (let t = 0; t < b.triangles; t++) {
      const v = b.vars[t * 3]!;
      if (v === 0 || v === want) k++;
    }
    n += k * (PART_PAIRED[p] ? 2 : 1);
  }
  return n;
}
