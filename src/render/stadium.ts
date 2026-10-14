/**
 * [GFX-05] Stadium, advertising boards, sky, day and floodlit-night lighting (section 8 "Look": "one stadium with
 * stands, a simple instanced crowd that reacts to events, original advertising boards, and day and floodlit-night
 * lighting"; section 2: original art only; section 13 "Cheap shading": one directional light plus ambient, no
 * real-time shadow maps at the default tier).
 *
 * LAYOUT (metres, pitch centre at the origin, x along the pitch, z across it, +z = the near side under the broadcast
 * camera). The stand front walls sit on the sim's stand walls at the world bounds (|x| = WORLD_MAX_X 62,
 * |z| = WORLD_MAX_Z 44); the advertising boards sit on the sim's board rectangle (|x| = BOARD_X 58, |z| = BOARD_Z 40,
 * LOCAL_TUNING.boardHeight = sim boardHeight 0.9 m high, front face exactly on the line, so a ball bouncing off a board
 * visibly touches it).
 *  - Far stand (z < -44) and both end stands (|x| > 62): the MAIN profile, two tiers (lower 14 rows, balcony, upper
 *    14 rows) under a roof slab with an accent fascia. The far corners are the same profile swept round a quarter arc
 *    (a closed bowl on three sides).
 *  - Near stand (z > 44) and the near corners: the NEAR profile, one low tier and no roof. It stays below the broadcast
 *    camera's lowest view ray (the camera sits above it at z 70..78), so it never blocks the pitch and the camera can
 *    never dip into it (glitch "Camera: dipping into the stand"; tests check every vertex against cameraEnvelope()).
 *  - Four floodlight towers behind the corners (lamp heads aimed at the pitch). By day the lamps are grey glass; at night
 *    they glow and get additive halos.
 * Every stand surface, roof and tower is ONE merged, vertex-coloured Lambert mesh (one draw call, ~8k triangles).
 *
 * SEATS (generateSeats): one seat per crowd spectator on every tread of every stand (aisles every
 * LOCAL_TUNING.aisleEvery seats on the straight stands), with its facing toward the pitch, stand id, tier and row.
 * GFX-06 (crowd.ts) instances its spectators from this layout.
 *
 * BOARDS: one merged mesh of four thin boxes; the front faces show a generated LED strip (canvas texture: eight
 * invented brand panels, words and abstract logos drawn in code, see BOARD_BRANDS; no real sponsor) that scrolls
 * slowly (texture offset, no allocation). Unlit (LED), slightly dimmer at night. Reduced camera motion stops the
 * scroll.
 *
 * SKY: a gradient dome (unlit shader) that follows the camera, drawn after the opaque scene without writing depth.
 *
 * LIGHTING: exactly one directional light (sun / floodlight key) and one ambient light. DAY_LOOK / NIGHT_LOOK
 * (config.night) set their colours and intensities, the sky gradient, the lamp glow and the board brightness.
 * crowdLightOf(look) gives the matching light for unlit materials (the crowd). QUALITY tier only: the key light
 * casts one shadow map (getTierParams(tier).shadowMap / shadowMapSize, GFX-02); other tiers have none.
 *
 * DRAW CALLS: ground, stands, boards, lamps, sky = 5 by day; + halos = 6 at night (budget 10). No per-frame allocation.
 * DEBUG: window.__dotkickStadium (StadiumDebug): view(name) overrides ctx.camera after the cameras ran (e2e
 * screenshots of the stands), snapshot() reports draw calls, triangles, seats and the look.
 */

import {
  AdditiveBlending, AmbientLight, BackSide, BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, Color,
  DataTexture, DirectionalLight, Group, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, PlaneGeometry, RepeatWrapping, RGBAFormat, SRGBColorSpace, ShaderMaterial, SphereGeometry,
  Vector3, type Texture, type WebGLRenderer,
} from 'three';
import { BOARD_X, BOARD_Z, WORLD_MAX_X, WORLD_MAX_Z } from '../contracts/constants';
import type { Club } from '../contracts/data';
import type { QualityTier } from '../contracts/enums';
import type { ReadonlySimState } from '../contracts/state';
import { getTierParams } from './quality';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export const LOCAL_TUNING = { // TUNING-CR (GFX-05, render only)
  // ---- stand profiles (m)
  /** Pitch-level front wall height (behind the boards; the sim's stand wall). */
  frontWallHeight: 1.6,
  /** Walkway between the front wall (or balcony) and the first row of a tier. */
  walkway: 0.8,
  /** Depth of one row (tread). */
  rowDepth: 0.9,
  /** Main profile: lower tier rows and riser height per row. */
  lowerRows: 14,
  lowerRiser: 0.42,
  /** Main profile: balcony wall height above the last lower row (upper tier front). */
  balcony: 2.6,
  /** Main profile: upper tier rows and riser height. */
  upperRows: 14,
  upperRiser: 0.55,
  /** Back wall height above the last row (main / near), and the wall-top cap depth. */
  backWallMain: 3.0,
  backWallNear: 1.1,
  backCap: 0.6,
  /** Near profile: rows and riser (one low tier under the broadcast camera). */
  nearRows: 12,
  nearRiser: 0.48,
  // ---- roof (main profile only)
  /** Roof front depth measured back from the upper tier's front wall (negative = overhangs the balcony). */
  roofFrontOverhang: 2.8,
  /** Roof underside above the back wall top at the back, and extra rise toward the front. */
  roofClearance: 0.5,
  roofRise: 1.5,
  roofThickness: 1.2,
  /** Roof depth past the back wall cap. */
  roofBackExtra: 0.4,
  // ---- seats
  /** Seat spacing along a row. */
  seatPitch: 0.72,
  /** Kept clear at both ends of a straight row. */
  seatEndMargin: 0.6,
  /** Seat point depth into the tread, fraction of rowDepth. */
  seatInset: 0.5,
  /** One aisle (empty slot) every this many seat slots on the straight stands. */
  aisleEvery: 26,
  /** Quarter-arc segments per corner. */
  cornerSegments: 8,
  // ---- boards (match sim/ball/contact.ts LOCAL_TUNING.boardHeight)
  boardHeight: 0.9,
  boardDepth: 0.2,
  /** Board length per generated panel (m) and LED scroll speed (m/s). */
  panelLength: 5.76,
  boardScroll: 0.45,
  // ---- floodlights
  towerHeight: 44,
  /** Tower distance behind the stand's back, along the corner diagonal. */
  towerBehind: 3,
  towerBase: 1.8,
  towerTop: 0.9,
  /** Lamp head size (m): width, height, depth; lamp grid columns x rows. */
  headW: 8,
  headH: 4.6,
  headD: 1.0,
  lampCols: 5,
  lampRows: 3,
  /** Halo radius (m) at night. */
  haloSize: 10,
  // ---- sky
  skyRadius: 450,
  // ---- debug views
  debugFovDeg: 42,
} as const;

/** Tuning (read-only) for tests and tools. */
export const STADIUM_TUNING = LOCAL_TUNING;
const T = LOCAL_TUNING;

// ============================================================ looks and lighting

export interface StadiumLook {
  sky: number;
  ground: number;
  sunColour: number;
  sunIntensity: number;
  ambientColour: number;
  ambientIntensity: number;
  /** Sky dome gradient: zenith, horizon and below-horizon colours (sRGB). */
  skyTop: number;
  skyHorizon: number;
  skyBottom: number;
  /** Floodlight lamp faces (sRGB) and halo strength (0 = no halos). */
  lampColour: number;
  haloStrength: number;
  /** LED board brightness multiplier (unlit). */
  boardBrightness: number;
}

export const DAY_LOOK: StadiumLook = {
  sky: 0x8fb8d8, ground: 0x2f5a2a, sunColour: 0xfff4e0, sunIntensity: 2.6, ambientColour: 0xdfe8ff, ambientIntensity: 1.25,
  skyTop: 0x3f7fc4, skyHorizon: 0xc4dcef, skyBottom: 0x9db5a0, lampColour: 0x9ca3ad, haloStrength: 0, boardBrightness: 1,
};
export const NIGHT_LOOK: StadiumLook = {
  sky: 0x0b1020, ground: 0x1d3a1c, sunColour: 0xf2f6ff, sunIntensity: 2.4, ambientColour: 0x9aa8d0, ambientIntensity: 1.0,
  skyTop: 0x03050c, skyHorizon: 0x1c2640, skyBottom: 0x0c1218, lampColour: 0xfffbea, haloStrength: 0.55, boardBrightness: 0.9,
};

/** The look for a match (config.night). */
export function lookFor(night: boolean): StadiumLook {
  return night ? NIGHT_LOOK : DAY_LOOK;
}

/** Average fraction of the key light an upright, camera-facing surface receives (crowd billboards). */
const CROWD_KEY_SHARE = 0.55;
const tmpLightColour = new Color();

/**
 * Light for unlit materials that must match the Lambert scene (the crowd): (sun * CROWD_KEY_SHARE + ambient) / pi in
 * linear RGB, the same Lambert sum three.js applies to an upright surface. Writes `out`; no allocation.
 */
export function crowdLightOf(look: StadiumLook, out: Color): Color {
  out.setHex(look.ambientColour).multiplyScalar(look.ambientIntensity);
  tmpLightColour.setHex(look.sunColour).multiplyScalar(look.sunIntensity * CROWD_KEY_SHARE);
  out.add(tmpLightColour).multiplyScalar(1 / Math.PI);
  return out;
}

// ============================================================ stand profiles

/** Profile kinds. */
export const PROFILE_MAIN = 0;
export const PROFILE_NEAR = 1;

/** A stand cross-section: a top-surface polyline (depth from the front wall, height), monotone in depth. */
export interface StandProfile {
  /** Flattened (depth, height) points from the front wall foot to the back wall foot. */
  pts: number[];
  /** sRGB colour per segment (pts.length / 2 - 1 entries). */
  colours: number[];
  /** Seat points: flattened (depth, height, tier, row) per row. */
  rows: number[];
  /** Deepest point (back wall), m. */
  depth: number;
  /** Highest point (back wall top), m. */
  top: number;
  /** Depth of the upper tier's front wall (main profile; 0 for the near profile). */
  upperFront: number;
}

/** Stand palette (sRGB). Muted so the pitch and kits stay the most saturated things on screen. */
export const STAND_COLOURS = {
  frontWall: 0x1c2430,
  walkway: 0x7d848e,
  riser: 0x5a6472,
  seatA: 0x26324a,
  seatB: 0x2c3a56,
  fascia: 0xff6b35,
  backWall: 0x4a525e,
  cap: 0x8a919b,
  roofTop: 0xc5cbd3,
  roofUnder: 0x2a2f37,
  roofBack: 0x5d6570,
  tower: 0x6b7280,
  head: 0x3b414a,
} as const;

/** Build a stand profile (pure; init time only). */
export function standProfile(kind: number): StandProfile {
  const C = STAND_COLOURS;
  const pts: number[] = [0, 0];
  const colours: number[] = [];
  const rows: number[] = [];
  let d = 0, h = 0;
  const to = (nd: number, nh: number, colour: number): void => {
    d = nd; h = nh;
    pts.push(d, h);
    colours.push(colour);
  };
  const tier = (count: number, riser: number, tierIdx: number, rowBase: number): void => {
    for (let i = 0; i < count; i++) {
      to(d, h + riser, C.riser);
      rows.push(d + T.rowDepth * T.seatInset, h, tierIdx, rowBase + i);
      to(d + T.rowDepth, h, (i & 1) === 0 ? C.seatA : C.seatB);
    }
  };
  to(0, T.frontWallHeight, C.frontWall);
  to(T.walkway, h, C.walkway);
  let upperFront = 0;
  if (kind === PROFILE_MAIN) {
    tier(T.lowerRows, T.lowerRiser, 0, 0);
    upperFront = d;
    to(d, h + T.balcony, C.fascia);
    to(d + T.walkway, h, C.walkway);
    tier(T.upperRows, T.upperRiser, 1, T.lowerRows);
    to(d, h + T.backWallMain, C.backWall);
  } else {
    tier(T.nearRows, T.nearRiser, 0, 0);
    to(d, h + T.backWallNear, C.backWall);
  }
  const top = h;
  to(d + T.backCap, h, C.cap);
  to(d, 0, C.backWall);
  return { pts, colours, rows, depth: d, top, upperFront };
}

/** Roof cross-section of the main profile: closed loop (top, back, underside, fascia), flattened (depth, height). */
export function roofProfile(main: StandProfile): { pts: number[]; colours: number[] } {
  const C = STAND_COLOURS;
  const back = main.depth + T.roofBackExtra;
  const front = main.upperFront - T.roofFrontOverhang;
  const yb = main.top + T.roofClearance;
  const yf = yb + T.roofRise;
  return {
    // Order gives outward normals with the profile normal rule (see extrude): top, back, underside, fascia.
    pts: [front, yf + T.roofThickness, back, yb + T.roofThickness, back, yb, front, yf],
    colours: [C.roofTop, C.roofBack, C.roofUnder, C.fascia],
  };
}

// ============================================================ stands (front lines and corner arcs)

export const STAND_FAR = 0;
export const STAND_NEAR = 1;
export const STAND_WEST = 2;
export const STAND_EAST = 3;
export const STAND_CORNER_FAR_WEST = 4;
export const STAND_CORNER_FAR_EAST = 5;
export const STAND_CORNER_NEAR_WEST = 6;
export const STAND_CORNER_NEAR_EAST = 7;
export const STAND_COUNT = 8;

/** One stand: a straight front line (a -> b, outward normal n) or a quarter arc round a corner point (c). */
export interface StandDef {
  id: number;
  profile: number;
  roof: boolean;
  arc: boolean;
  /** Straight: front line end points; arc: the corner point in ax, az. */
  ax: number; az: number; bx: number; bz: number;
  /** Straight: outward unit normal (away from the pitch). */
  nx: number; nz: number;
  /** Arc: start angle and signed sweep (rad), direction = (cos, sin) in (x, z). */
  phi0: number; sweep: number;
}

const FX = WORLD_MAX_X;
const FZ = WORLD_MAX_Z;

function straight(id: number, profile: number, roof: boolean, ax: number, az: number, bx: number, bz: number, nx: number, nz: number): StandDef {
  return { id, profile, roof, arc: false, ax, az, bx, bz, nx, nz, phi0: 0, sweep: 0 };
}
function corner(id: number, profile: number, roof: boolean, sx: number, sz: number): StandDef {
  const phi0 = Math.atan2(0, sx);
  const phi1 = Math.atan2(sz, 0);
  let sweep = phi1 - phi0;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  return { id, profile, roof, arc: true, ax: sx * FX, az: sz * FZ, bx: sx * FX, bz: sz * FZ, nx: 0, nz: 0, phi0, sweep };
}

/** The eight stands (index = stand id). */
export const STANDS: readonly StandDef[] = Object.freeze([
  straight(STAND_FAR, PROFILE_MAIN, true, -FX, -FZ, FX, -FZ, 0, -1),
  straight(STAND_NEAR, PROFILE_NEAR, false, -FX, FZ, FX, FZ, 0, 1),
  straight(STAND_WEST, PROFILE_MAIN, true, -FX, -FZ, -FX, FZ, -1, 0),
  straight(STAND_EAST, PROFILE_MAIN, true, FX, -FZ, FX, FZ, 1, 0),
  corner(STAND_CORNER_FAR_WEST, PROFILE_MAIN, true, -1, -1),
  corner(STAND_CORNER_FAR_EAST, PROFILE_MAIN, true, 1, -1),
  corner(STAND_CORNER_NEAR_WEST, PROFILE_NEAR, false, -1, 1),
  corner(STAND_CORNER_NEAR_EAST, PROFILE_NEAR, false, 1, 1),
]);

/** Frames along a stand: flattened (originX, originZ, outwardX, outwardZ). Straight = 2 frames, arc = segments + 1. */
function standFrames(s: StandDef): number[] {
  if (!s.arc) return [s.ax, s.az, s.nx, s.nz, s.bx, s.bz, s.nx, s.nz];
  const out: number[] = [];
  const n = T.cornerSegments;
  for (let k = 0; k <= n; k++) {
    const phi = s.phi0 + (s.sweep * k) / n;
    out.push(s.ax, s.az, Math.cos(phi), Math.sin(phi));
  }
  return out;
}

// ============================================================ geometry builder

/** Growable, non-indexed triangle soup with normals, colours and optional uvs (init time only). */
export interface SoupBuilder {
  pos: number[];
  nrm: number[];
  col: number[];
  uv: number[] | null;
}

function createSoup(withUv: boolean): SoupBuilder {
  return { pos: [], nrm: [], col: [], uv: withUv ? [] : null };
}

const linColour = new Color();
/** Linear RGB of an sRGB hex into a 3-array (three.js working colour space). */
function lin(hex: number): [number, number, number] {
  linColour.setHex(hex);
  return [linColour.r, linColour.g, linColour.b];
}

/**
 * Append one triangle. Vertices as flat [x, y, z] with one normal per vertex (n0..n2) and one colour. The winding is
 * fixed so the geometric normal agrees with the given normals (front faces outward); zero-area triangles are dropped.
 */
function tri(
  b: SoupBuilder, p: readonly number[], n: readonly number[], rgb: readonly number[], uv: readonly number[] | null,
): void {
  const e1x = p[3]! - p[0]!, e1y = p[4]! - p[1]!, e1z = p[5]! - p[2]!;
  const e2x = p[6]! - p[0]!, e2y = p[7]! - p[1]!, e2z = p[8]! - p[2]!;
  const gx = e1y * e2z - e1z * e2y, gy = e1z * e2x - e1x * e2z, gz = e1x * e2y - e1y * e2x;
  const area2 = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (area2 < 1e-7) return;
  const sx = n[0]! + n[3]! + n[6]!, sy = n[1]! + n[4]! + n[7]!, sz = n[2]! + n[5]! + n[8]!;
  const flip = gx * sx + gy * sy + gz * sz < 0;
  const order = flip ? [0, 2, 1] : [0, 1, 2];
  for (let k = 0; k < 3; k++) {
    const v = order[k]!;
    b.pos.push(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!);
    b.nrm.push(n[v * 3]!, n[v * 3 + 1]!, n[v * 3 + 2]!);
    b.col.push(rgb[0]!, rgb[1]!, rgb[2]!);
    if (b.uv) b.uv.push(uv ? uv[v * 2]! : 0, uv ? uv[v * 2 + 1]! : 0);
  }
}

/** Quad a-b-c-d (loop order) as two triangles; per-vertex normals; optional per-vertex uv. */
function quad(
  b: SoupBuilder, p: readonly number[], n: readonly number[], rgb: readonly number[], uv: readonly number[] | null = null,
): void {
  tri(b, [p[0]!, p[1]!, p[2]!, p[3]!, p[4]!, p[5]!, p[6]!, p[7]!, p[8]!],
    [n[0]!, n[1]!, n[2]!, n[3]!, n[4]!, n[5]!, n[6]!, n[7]!, n[8]!], rgb,
    uv ? [uv[0]!, uv[1]!, uv[2]!, uv[3]!, uv[4]!, uv[5]!] : null);
  tri(b, [p[0]!, p[1]!, p[2]!, p[6]!, p[7]!, p[8]!, p[9]!, p[10]!, p[11]!],
    [n[0]!, n[1]!, n[2]!, n[6]!, n[7]!, n[8]!, n[9]!, n[10]!, n[11]!], rgb,
    uv ? [uv[0]!, uv[1]!, uv[4]!, uv[5]!, uv[6]!, uv[7]!] : null);
}

/** Quad with one flat normal for all four vertices. */
function flatQuad(b: SoupBuilder, p: readonly number[], nx: number, ny: number, nz: number, rgb: readonly number[], uv: readonly number[] | null = null): void {
  quad(b, p, [nx, ny, nz, nx, ny, nz, nx, ny, nz, nx, ny, nz], rgb, uv);
}

/**
 * Extrude a profile (flattened depth, height points; colour per segment) along frames (origin + outward per frame).
 * Profile normal rule: for a segment (d0, h0) -> (d1, h1), the face normal is (-dh) * outward + dd * up, normalised;
 * so a riser faces the pitch and a tread faces up. `closed` joins the last point to the first (roof).
 * `caps`: straight stands close both ends (vertical strips down to the ground, or a fan for closed profiles).
 */
function extrude(b: SoupBuilder, frames: readonly number[], pts: readonly number[], colours: readonly number[], closed: boolean, caps: boolean, capColour: number): void {
  const nf = frames.length / 4;
  const np = pts.length / 2;
  const segs = closed ? np : np - 1;
  for (let s = 0; s < segs; s++) {
    const i0 = s, i1 = (s + 1) % np;
    const d0 = pts[i0 * 2]!, h0 = pts[i0 * 2 + 1]!, d1 = pts[i1 * 2]!, h1 = pts[i1 * 2 + 1]!;
    const dd = d1 - d0, dh = h1 - h0;
    const len = Math.sqrt(dd * dd + dh * dh);
    if (len < 1e-6) continue;
    if (d0 === 0 && d1 === 0 && frames[0] === frames[4] && frames[1] === frames[5]) continue; // arc: front collapses
    const a = -dh / len, u = dd / len;
    const rgb = lin(colours[s]!);
    for (let f = 0; f < nf - 1; f++) {
      const o0x = frames[f * 4]!, o0z = frames[f * 4 + 1]!, n0x = frames[f * 4 + 2]!, n0z = frames[f * 4 + 3]!;
      const o1x = frames[f * 4 + 4]!, o1z = frames[f * 4 + 5]!, n1x = frames[f * 4 + 6]!, n1z = frames[f * 4 + 7]!;
      quad(b, [
        o0x + n0x * d0, h0, o0z + n0z * d0,
        o1x + n1x * d0, h0, o1z + n1z * d0,
        o1x + n1x * d1, h1, o1z + n1z * d1,
        o0x + n0x * d1, h1, o0z + n0z * d1,
      ], [
        a * n0x, u, a * n0z, a * n1x, u, a * n1z, a * n1x, u, a * n1z, a * n0x, u, a * n0z,
      ], rgb);
    }
  }
  if (!caps) return;
  const rgb = lin(capColour);
  for (let end = 0; end < 2; end++) {
    const f = end === 0 ? 0 : nf - 1;
    const ox = frames[f * 4]!, oz = frames[f * 4 + 1]!, nx = frames[f * 4 + 2]!, nz = frames[f * 4 + 3]!;
    // Along-stand tangent at this end (outward from the stand).
    let tx = frames[(nf - 1) * 4]! - frames[0]!, tz = frames[(nf - 1) * 4 + 1]! - frames[1]!;
    const tl = Math.sqrt(tx * tx + tz * tz) || 1;
    tx /= tl; tz /= tl;
    if (end === 0) { tx = -tx; tz = -tz; }
    const at = (d: number, h: number): number[] => [ox + nx * d, h, oz + nz * d];
    if (closed) {
      const p0 = at(pts[0]!, pts[1]!);
      for (let i = 1; i < np - 1; i++) {
        tri(b, [...p0, ...at(pts[i * 2]!, pts[i * 2 + 1]!), ...at(pts[i * 2 + 2]!, pts[i * 2 + 3]!)],
          [tx, 0, tz, tx, 0, tz, tx, 0, tz], rgb, null);
      }
    } else {
      for (let s = 0; s < np - 1; s++) {
        const d0 = pts[s * 2]!, h0 = pts[s * 2 + 1]!, d1 = pts[s * 2 + 2]!, h1 = pts[s * 2 + 3]!;
        if (Math.abs(d1 - d0) < 1e-6) continue;
        flatQuad(b, [...at(d0, 0), ...at(d1, 0), ...at(d1, h1), ...at(d0, h0)], tx, 0, tz, rgb);
      }
    }
  }
}

/** Floodlight tower positions: flattened (x, z, lampCentreX, lampCentreY, lampCentreZ, forwardX, forwardY, forwardZ). */
export function towerLayout(): number[] {
  const out: number[] = [];
  const main = standProfile(PROFILE_MAIN), near = standProfile(PROFILE_NEAR);
  for (let i = STAND_CORNER_FAR_WEST; i <= STAND_CORNER_NEAR_EAST; i++) {
    const s = STANDS[i]!;
    const depth = (s.profile === PROFILE_MAIN ? main.depth + T.roofBackExtra : near.depth) + T.towerBehind;
    const mid = s.phi0 + s.sweep / 2;
    const x = s.ax + Math.cos(mid) * depth, z = s.az + Math.sin(mid) * depth;
    const cy = T.towerHeight + T.headH / 2;
    let fx = -x, fy = -cy * 0.55, fz = -z;
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz);
    fx /= fl; fy /= fl; fz /= fl;
    out.push(x, z, x + fx * (T.headD / 2 + 0.05), cy + fy * (T.headD / 2 + 0.05), z + fz * (T.headD / 2 + 0.05), fx, fy, fz);
  }
  return out;
}

/** Oriented box (centre, half extents along right / up / forward) as 6 flat quads. */
function orientedBox(b: SoupBuilder, c: readonly number[], r: readonly number[], u: readonly number[], f: readonly number[], hw: number, hh: number, hd: number, rgb: readonly number[]): void {
  const corner = (sr: number, su: number, sf: number): number[] => [
    c[0]! + r[0]! * hw * sr + u[0]! * hh * su + f[0]! * hd * sf,
    c[1]! + r[1]! * hw * sr + u[1]! * hh * su + f[1]! * hd * sf,
    c[2]! + r[2]! * hw * sr + u[2]! * hh * su + f[2]! * hd * sf,
  ];
  const face = (n: readonly number[], a: number[], b2: number[], c2: number[], d: number[]): void => {
    flatQuad(b, [...a, ...b2, ...c2, ...d], n[0]!, n[1]!, n[2]!, rgb);
  };
  face(f, corner(-1, -1, 1), corner(1, -1, 1), corner(1, 1, 1), corner(-1, 1, 1));
  face([-f[0]!, -f[1]!, -f[2]!], corner(-1, -1, -1), corner(1, -1, -1), corner(1, 1, -1), corner(-1, 1, -1));
  face(r, corner(1, -1, -1), corner(1, -1, 1), corner(1, 1, 1), corner(1, 1, -1));
  face([-r[0]!, -r[1]!, -r[2]!], corner(-1, -1, -1), corner(-1, -1, 1), corner(-1, 1, 1), corner(-1, 1, -1));
  face(u, corner(-1, 1, -1), corner(1, 1, -1), corner(1, 1, 1), corner(-1, 1, 1));
  face([-u[0]!, -u[1]!, -u[2]!], corner(-1, -1, -1), corner(1, -1, -1), corner(1, -1, 1), corner(-1, -1, 1));
}

/** Lamp head basis from a forward vector: right = normalize(forward x up), up' = right x forward. */
function headBasis(fx: number, fy: number, fz: number): { r: number[]; u: number[]; f: number[] } {
  let rx = -fz, rz = fx;
  const rl = Math.sqrt(rx * rx + rz * rz) || 1;
  rx /= rl; rz /= rl;
  return { r: [rx, 0, rz], u: [-rz * fy, rz * fx - rx * fz, rx * fy], f: [fx, fy, fz] };
}

/** Stand, roof and tower soup (pure; init time only). */
export function buildStandSoup(): SoupBuilder {
  const b = createSoup(false);
  const profiles = [standProfile(PROFILE_MAIN), standProfile(PROFILE_NEAR)];
  const roof = roofProfile(profiles[PROFILE_MAIN]!);
  for (let i = 0; i < STANDS.length; i++) {
    const s = STANDS[i]!;
    const p = profiles[s.profile]!;
    const frames = standFrames(s);
    extrude(b, frames, p.pts, p.colours, false, !s.arc, STAND_COLOURS.backWall);
    if (s.roof) extrude(b, frames, roof.pts, roof.colours, true, !s.arc, STAND_COLOURS.roofBack);
  }
  // Floodlight towers: tapered square poles and lamp head boxes (the lamp faces are a separate unlit mesh).
  const tl = towerLayout();
  const towerRgb = lin(STAND_COLOURS.tower), headRgb = lin(STAND_COLOURS.head);
  for (let i = 0; i < tl.length; i += 8) {
    const x = tl[i]!, z = tl[i + 1]!;
    const hb = T.towerBase / 2, ht = T.towerTop / 2, H = T.towerHeight;
    const sides: number[][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let k = 0; k < 4; k++) {
      // Face with outward normal a = (ax, az); it spans the tangent (-az, ax).
      const ax = sides[k]![0]!, az = sides[k]![1]!;
      const px = -az, pz = ax;
      flatQuad(b, [
        x + ax * hb - px * hb, 0, z + az * hb - pz * hb,
        x + ax * hb + px * hb, 0, z + az * hb + pz * hb,
        x + ax * ht + px * ht, H, z + az * ht + pz * ht,
        x + ax * ht - px * ht, H, z + az * ht - pz * ht,
      ], ax, 0, az, towerRgb);
    }
    const basis = headBasis(tl[i + 5]!, tl[i + 6]!, tl[i + 7]!);
    orientedBox(b, [x, H + T.headH / 2, z], basis.r, basis.u, basis.f, T.headW / 2, T.headH / 2, T.headD / 2, headRgb);
  }
  return b;
}

/** Lamp faces (grid of panels on each head's front), flat soup (pure). */
export function buildLampSoup(): SoupBuilder {
  const b = createSoup(false);
  const tl = towerLayout();
  const white = [1, 1, 1];
  const cw = (T.headW * 0.92) / T.lampCols, ch = (T.headH * 0.88) / T.lampRows;
  for (let i = 0; i < tl.length; i += 8) {
    const c = [tl[i + 2]!, tl[i + 3]!, tl[i + 4]!];
    const { r, u, f } = headBasis(tl[i + 5]!, tl[i + 6]!, tl[i + 7]!);
    for (let row = 0; row < T.lampRows; row++) {
      for (let col = 0; col < T.lampCols; col++) {
        const cx = (col + 0.5 - T.lampCols / 2) * cw, cy = (row + 0.5 - T.lampRows / 2) * ch;
        const hw = cw * 0.4, hh = ch * 0.38;
        const pt = (sx: number, sy: number): number[] => [
          c[0]! + r[0]! * (cx + sx * hw) + u[0]! * (cy + sy * hh),
          c[1]! + r[1]! * (cx + sx * hw) + u[1]! * (cy + sy * hh),
          c[2]! + r[2]! * (cx + sx * hw) + u[2]! * (cy + sy * hh),
        ];
        flatQuad(b, [...pt(-1, -1), ...pt(1, -1), ...pt(1, 1), ...pt(-1, 1)], f[0]!, f[1]!, f[2]!, white);
      }
    }
  }
  return b;
}

/** BufferGeometry from a soup. */
export function soupGeometry(b: SoupBuilder): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(b.pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(b.nrm), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(b.col), 3));
  if (b.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(b.uv), 2));
  g.computeBoundingSphere();
  return g;
}

// ============================================================ seats (GFX-06 crowd)

/** Seat transforms for the crowd (GFX-06). Arrays have `count` entries. */
export interface SeatLayout {
  count: number;
  /** Seat point on the tread (m): spectators stand on (x, y, z). */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Facing toward the pitch (horizontal unit vector). */
  fx: Float32Array;
  fz: Float32Array;
  /** Stand id (STAND_*). */
  stand: Uint8Array;
  /** Tier (0 lower / near, 1 upper). */
  tier: Uint8Array;
  /** Row from the front of the stand (0 = front row). */
  row: Uint8Array;
}

let seatCache: SeatLayout | null = null;

/** Every seat of the stadium (pure, deterministic; cached: callers must not modify the arrays). */
export function generateSeats(): SeatLayout {
  if (seatCache) return seatCache;
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], fxs: number[] = [], fzs: number[] = [];
  const st: number[] = [], tiers: number[] = [], rws: number[] = [];
  const profiles = [standProfile(PROFILE_MAIN), standProfile(PROFILE_NEAR)];
  const push = (x: number, y: number, z: number, fx: number, fz: number, s: number, tier: number, row: number): void => {
    xs.push(x); ys.push(y); zs.push(z); fxs.push(fx); fzs.push(fz); st.push(s); tiers.push(tier); rws.push(row);
  };
  for (let i = 0; i < STANDS.length; i++) {
    const s = STANDS[i]!;
    const rows = profiles[s.profile]!.rows;
    for (let r = 0; r < rows.length; r += 4) {
      const d = rows[r]!, h = rows[r + 1]!, tier = rows[r + 2]!, row = rows[r + 3]!;
      if (!s.arc) {
        const lx = s.bx - s.ax, lz = s.bz - s.az;
        const L = Math.sqrt(lx * lx + lz * lz);
        const tx = lx / L, tz = lz / L;
        const n = Math.floor((L - 2 * T.seatEndMargin) / T.seatPitch) + 1;
        const start = (L - (n - 1) * T.seatPitch) / 2;
        for (let k = 0; k < n; k++) {
          if (k % T.aisleEvery === T.aisleEvery - 1) continue;
          const sAlong = start + k * T.seatPitch;
          push(s.ax + tx * sAlong + s.nx * d, h, s.az + tz * sAlong + s.nz * d, -s.nx, -s.nz, s.id, tier, row);
        }
      } else {
        const len = Math.abs(s.sweep) * d;
        const n = Math.max(1, Math.floor(len / T.seatPitch));
        for (let k = 0; k < n; k++) {
          const phi = s.phi0 + (s.sweep * (k + 0.5)) / n;
          const c = Math.cos(phi), sn = Math.sin(phi);
          push(s.ax + c * d, h, s.az + sn * d, -c, -sn, s.id, tier, row);
        }
      }
    }
  }
  seatCache = {
    count: xs.length,
    x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs),
    fx: Float32Array.from(fxs), fz: Float32Array.from(fzs),
    stand: Uint8Array.from(st), tier: Uint8Array.from(tiers), row: Uint8Array.from(rws),
  };
  return seatCache;
}

// ============================================================ advertising boards

/** Invented brand words on the boards (original; no real sponsor). Panel order on the LED strip. */
export const BOARD_BRANDS: readonly string[] = Object.freeze(['DOTKICK', 'BLIPPO', 'MOXARI', 'TREVLO', 'ZUBBO', 'GLIMRA', 'FLONDO', 'KWIRL']);
/** Panel colours (CSS): background, word, logo accent. */
const BOARD_STYLE: readonly (readonly [string, string, string])[] = [
  ['#ff6b35', '#ffffff', '#1b1b2a'],
  ['#1e3a8a', '#ffffff', '#38bdf8'],
  ['#111827', '#fbbf24', '#f97316'],
  ['#f8fafc', '#0f766e', '#14b8a6'],
  ['#6d28d9', '#fef08a', '#f0abfc'],
  ['#be123c', '#ffffff', '#fda4af'],
  ['#f5f5f4', '#1f2937', '#ef4444'],
  ['#0284c7', '#0b1020', '#e0f2fe'],
];
/** LED strip texture size (px): panels side by side in the top STRIP_H rows; the rest is the dark board body. */
export const BOARD_TEX_W = 4096;
export const BOARD_TEX_H = 128;
const PANEL_W = BOARD_TEX_W / BOARD_BRANDS.length;
const STRIP_H = 80;
/** v range of the LED strip and v of the dark body (flipY: canvas row 0 is v = 1). */
export const BOARD_STRIP_V0 = 1 - STRIP_H / BOARD_TEX_H;
export const BOARD_STRIP_V1 = 1;
export const BOARD_DARK_V = (BOARD_TEX_H - STRIP_H) / (2 * BOARD_TEX_H);
/** Board length covered by the whole strip (m). */
export const BOARD_STRIP_LENGTH = T.panelLength * BOARD_BRANDS.length;

/** The 2D canvas calls drawBoardStrip uses (a CanvasRenderingContext2D satisfies it; tests pass a recorder). */
export interface Board2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
}

/** Abstract logo k (0..7) centred at (cx, cy), size s (px). Simple original shapes. */
function drawLogo(g: Board2D, k: number, cx: number, cy: number, s: number, fg: string, accent: string): void {
  g.fillStyle = fg;
  g.strokeStyle = fg;
  g.lineWidth = s * 0.14;
  switch (k % 8) {
    case 0: // dot in a ring
      g.beginPath(); g.arc(cx, cy, s * 0.45, 0, Math.PI * 2); g.stroke();
      g.fillStyle = accent; g.beginPath(); g.arc(cx, cy, s * 0.2, 0, Math.PI * 2); g.fill();
      break;
    case 1: // three dots
      for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(cx + i * s * 0.34, cy + (i === 0 ? -s * 0.12 : s * 0.1), s * 0.15, 0, Math.PI * 2); g.fill(); }
      break;
    case 2: // triangle
      g.fillStyle = accent; g.beginPath(); g.moveTo(cx, cy - s * 0.45); g.lineTo(cx + s * 0.45, cy + s * 0.4); g.lineTo(cx - s * 0.45, cy + s * 0.4); g.closePath(); g.fill();
      break;
    case 3: // double chevron
      for (let i = 0; i < 2; i++) {
        const ox = cx - s * 0.2 + i * s * 0.3;
        g.beginPath(); g.moveTo(ox - s * 0.15, cy - s * 0.4); g.lineTo(ox + s * 0.15, cy); g.lineTo(ox - s * 0.15, cy + s * 0.4); g.stroke();
      }
      break;
    case 4: // split circle
      g.beginPath(); g.arc(cx, cy, s * 0.42, Math.PI / 2, Math.PI * 1.5); g.fill();
      g.fillStyle = accent; g.beginPath(); g.arc(cx, cy, s * 0.42, -Math.PI / 2, Math.PI / 2); g.fill();
      break;
    case 5: // diamond
      g.beginPath(); g.moveTo(cx, cy - s * 0.46); g.lineTo(cx + s * 0.34, cy); g.lineTo(cx, cy + s * 0.46); g.lineTo(cx - s * 0.34, cy); g.closePath(); g.fill();
      break;
    case 6: // rising bars
      g.fillStyle = accent;
      for (let i = 0; i < 3; i++) g.fillRect(cx - s * 0.4 + i * s * 0.3, cy + s * 0.4 - s * (0.35 + i * 0.25), s * 0.2, s * (0.35 + i * 0.25));
      break;
    default: // open arc swirl
      g.beginPath(); g.arc(cx, cy, s * 0.4, 0.3, Math.PI * 1.7); g.stroke();
      g.beginPath(); g.arc(cx, cy, s * 0.15, 0, Math.PI * 2); g.fill();
  }
}

/**
 * Draw the LED strip: one panel per BOARD_BRANDS entry (background, abstract logo, bold word) in the top STRIP_H rows of
 * a w x h canvas (w = BOARD_TEX_W scale), then the dark board body below. Pure drawing calls only.
 */
export function drawBoardStrip(g: Board2D, w: number, h: number): void {
  const pw = w / BOARD_BRANDS.length;
  const sh = (STRIP_H / BOARD_TEX_H) * h;
  g.fillStyle = '#20252d';
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < BOARD_BRANDS.length; i++) {
    const [bg, fg, accent] = BOARD_STYLE[i]!;
    const x0 = i * pw;
    g.fillStyle = bg;
    g.fillRect(x0, 0, pw, sh);
    // thin dark seam between panels (reads as separate LED modules)
    g.fillStyle = '#0b0d12';
    g.fillRect(x0, 0, Math.max(1, pw * 0.006), sh);
    const logo = sh * 0.66;
    drawLogo(g, i, x0 + pw * 0.14, sh * 0.5, logo, fg, accent);
    g.fillStyle = fg;
    g.font = `900 ${Math.round(sh * 0.62)}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(BOARD_BRANDS[i]!, x0 + pw * 0.58, sh * 0.54, pw * 0.7);
  }
}

/** The LED strip texture: a canvas in the browser; a plain striped DataTexture without a DOM (Node tests). */
function createBoardTexture(): Texture {
  let tex: Texture | null = null;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = BOARD_TEX_W;
    canvas.height = BOARD_TEX_H;
    const g = canvas.getContext('2d');
    if (g) {
      drawBoardStrip(g, BOARD_TEX_W, BOARD_TEX_H);
      tex = new CanvasTexture(canvas);
    }
  }
  if (!tex) {
    const w = BOARD_BRANDS.length * 2, h = 4;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      const row = Math.floor(i / w);
      const v = row >= 2 ? (i % 2 === 0 ? 230 : 40) : 32;
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    tex = new DataTexture(data, w, h, RGBAFormat);
    tex.flipY = false;
  }
  tex.name = 'stadium-boards';
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = RepeatWrapping;
  tex.wrapT = ClampToEdgeWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Board ring geometry: four thin boxes whose front faces lie exactly on the sim's board lines (|x| = BOARD_X,
 * |z| = BOARD_Z) facing the pitch, T.boardHeight high. Front faces map the LED strip with u running left to right as
 * seen from the pitch (text never mirrored); top and back faces map the dark body. Sidelines own the corners.
 */
export function buildBoardSoup(): SoupBuilder {
  const b = createSoup(true);
  const H = T.boardHeight, D = T.boardDepth;
  const white = [1, 1, 1];
  const dark = [BOARD_DARK_V, BOARD_DARK_V];
  // [front-line origin x, z, along tx, tz (viewer's right), length, inward normal nx, nz]
  const sides: number[][] = [
    [-BOARD_X - D, -BOARD_Z, 1, 0, 2 * (BOARD_X + D), 0, 1], // far sideline, faces +z
    [BOARD_X + D, BOARD_Z, -1, 0, 2 * (BOARD_X + D), 0, -1], // near sideline, faces -z
    [-BOARD_X, BOARD_Z, 0, -1, 2 * BOARD_Z, 1, 0], // west end, faces +x
    [BOARD_X, -BOARD_Z, 0, 1, 2 * BOARD_Z, -1, 0], // east end, faces -x
  ];
  for (let i = 0; i < sides.length; i++) {
    const [ox, oz, tx, tz, L, nx, nz] = sides[i]!;
    const phase = i * 0.37;
    const u0 = phase, u1 = phase + L! / BOARD_STRIP_LENGTH;
    const ex = ox! + tx! * L!, ez = oz! + tz! * L!;
    const bx = -nx! * D, bz = -nz! * D;
    // front (LED)
    flatQuad(b, [ox!, 0, oz!, ex, 0, ez, ex, H, ez, ox!, H, oz!], nx!, 0, nz!, white,
      [u0, BOARD_STRIP_V0, u1, BOARD_STRIP_V0, u1, BOARD_STRIP_V1, u0, BOARD_STRIP_V1]);
    // top
    flatQuad(b, [ox!, H, oz!, ex, H, ez, ex + bx, H, ez + bz, ox! + bx, H, oz! + bz], 0, 1, 0, white, [...dark, ...dark, ...dark, ...dark]);
    // back
    flatQuad(b, [ox! + bx, 0, oz! + bz, ex + bx, 0, ez + bz, ex + bx, H, ez + bz, ox! + bx, H, oz! + bz], -nx!, 0, -nz!, white,
      [...dark, ...dark, ...dark, ...dark]);
  }
  return b;
}

// ============================================================ sky and halos

const SKY_VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const SKY_FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
varying vec3 vDir;
void main() {
  float y = normalize(vDir).y;
  vec3 c = y >= 0.0 ? mix(uHorizon, uTop, pow(clamp(y, 0.0, 1.0), 0.55)) : mix(uHorizon, uBottom, clamp(-y * 6.0, 0.0, 1.0));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;
const HALO_VERTEX = /* glsl */ `
attribute vec2 corner;
uniform float uSize;
varying vec2 vCorner;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xy += corner * uSize;
  vCorner = corner;
  gl_Position = projectionMatrix * mv;
}
`;
const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColour;
uniform float uStrength;
varying vec2 vCorner;
void main() {
  float r = length(vCorner);
  float a = 1.0 - smoothstep(0.0, 1.0, r);
  a = a * a * uStrength;
  gl_FragColor = vec4(uColour * a, 1.0);
  #include <colorspace_fragment>
}
`;

function buildHaloGeometry(): BufferGeometry {
  const tl = towerLayout();
  const n = tl.length / 8;
  const pos = new Float32Array(n * 4 * 3);
  const corner = new Float32Array(n * 4 * 2);
  const idx: number[] = [];
  const cs = [-1, -1, 1, -1, 1, 1, -1, 1];
  for (let i = 0; i < n; i++) {
    const o = i * 8;
    const cx = tl[o + 2]! + tl[o + 5]!, cy = tl[o + 3]! + tl[o + 6]!, cz = tl[o + 4]! + tl[o + 7]!;
    for (let k = 0; k < 4; k++) {
      pos.set([cx, cy, cz], (i * 4 + k) * 3);
      corner[(i * 4 + k) * 2] = cs[k * 2]!;
      corner[(i * 4 + k) * 2 + 1] = cs[k * 2 + 1]!;
    }
    const v = i * 4;
    idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('corner', new BufferAttribute(corner, 2));
  g.setIndex(idx);
  return g;
}

// ============================================================ module

/** Named debug views (eye, look-at) for e2e screenshots. */
export const STADIUM_VIEWS: Readonly<Record<string, readonly [number, number, number, number, number, number]>> = Object.freeze({
  far: [0, 7, 16, 0, 9, -62] as const,
  east: [24, 7, 0, 80, 11, 0] as const,
  west: [-24, 7, 0, -80, 11, 0] as const,
  near: [0, 9, -18, 0, 5, 56] as const,
  corner: [-26, 9, 22, 70, 14, -58] as const,
  aerial: [0, 150, 175, 0, 0, 0] as const,
});

export interface StadiumSnapshot {
  night: boolean;
  visible: boolean;
  /** Stadium meshes drawn (each one draw call). */
  drawCalls: number;
  /** Triangles of the drawn stadium meshes. */
  triangles: number;
  seats: number;
  castShadow: boolean;
  shadowMapSize: number;
  boardOffset: number;
  view: string;
}

/** Debug hook (window.__dotkickStadium). */
export interface StadiumDebug {
  /** Override ctx.camera after the cameras ran with a named view (STADIUM_VIEWS) or '' for off. */
  view(name: string): void;
  snapshot(): StadiumSnapshot;
}

declare global {
  interface Window {
    __dotkickStadium?: StadiumDebug;
  }
}

export interface StadiumModule extends RenderModule {
  readonly sun: DirectionalLight;
  readonly ambient: AmbientLight;
  /** All stadium meshes (hidden outside a match). */
  readonly root: Group;
  readonly stands: Mesh;
  readonly boards: Mesh;
  readonly lamps: Mesh;
  readonly halos: Mesh;
  readonly sky: Mesh;
  readonly ground: Mesh;
  readonly debug: StadiumDebug;
  /** Look applied by the last setMatch (DAY_LOOK until then). */
  readonly look: StadiumLook;
}

function triangleCount(m: Mesh): number {
  const g = m.geometry;
  const idx = g.getIndex();
  return (idx ? idx.count : g.getAttribute('position').count) / 3;
}

export function createStadium(ctx: RenderContext): StadiumModule {
  const root = new Group();
  root.name = 'stadium';
  root.visible = false;

  const groundGeo = new PlaneGeometry(600, 600, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new MeshLambertMaterial({ color: DAY_LOOK.ground });
  const ground = new Mesh(groundGeo, groundMat);
  ground.name = 'stadium-ground';
  ground.position.y = -0.03;

  const standGeo = soupGeometry(buildStandSoup());
  const standMat = new MeshLambertMaterial({ vertexColors: true });
  standMat.name = 'stadium-stands';
  const stands = new Mesh(standGeo, standMat);
  stands.name = 'stadium-stands';

  const boardTex = createBoardTexture();
  const boardGeo = soupGeometry(buildBoardSoup());
  const boardMat = new MeshBasicMaterial({ map: boardTex });
  boardMat.name = 'stadium-boards';
  const boards = new Mesh(boardGeo, boardMat);
  boards.name = 'stadium-boards';

  const lampGeo = soupGeometry(buildLampSoup());
  const lampMat = new MeshBasicMaterial({ color: DAY_LOOK.lampColour });
  lampMat.name = 'stadium-lamps';
  const lamps = new Mesh(lampGeo, lampMat);
  lamps.name = 'stadium-lamps';

  const haloGeo = buildHaloGeometry();
  const haloUniforms = {
    uSize: { value: T.haloSize },
    uColour: { value: new Color(NIGHT_LOOK.lampColour) },
    uStrength: { value: 0 },
  };
  const haloMat = new ShaderMaterial({
    name: 'stadium-halos', uniforms: haloUniforms, vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT,
    transparent: true, depthWrite: false, blending: AdditiveBlending,
  });
  const halos = new Mesh(haloGeo, haloMat);
  halos.name = 'stadium-halos';
  halos.frustumCulled = false; // the vertex shader expands the quads
  halos.renderOrder = 3;
  halos.visible = false;

  const skyGeo = new SphereGeometry(T.skyRadius, 24, 12);
  const skyUniforms = {
    uTop: { value: new Color(DAY_LOOK.skyTop) },
    uHorizon: { value: new Color(DAY_LOOK.skyHorizon) },
    uBottom: { value: new Color(DAY_LOOK.skyBottom) },
  };
  const skyMat = new ShaderMaterial({
    name: 'stadium-sky', uniforms: skyUniforms, vertexShader: SKY_VERTEX, fragmentShader: SKY_FRAGMENT,
    side: BackSide, depthWrite: false,
  });
  const sky = new Mesh(skyGeo, skyMat);
  sky.name = 'stadium-sky';
  sky.frustumCulled = false; // follows the camera
  sky.renderOrder = 1; // after the opaque scene (fills only what is left; writes no depth)

  for (const m of [ground, stands, boards, lamps]) {
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    m.castShadow = false;
    m.receiveShadow = false;
  }
  halos.matrixAutoUpdate = false;
  halos.updateMatrix();
  root.add(ground, stands, boards, lamps, halos, sky);

  // One key light (sun by day, floodlight key at night) high above the near-left of the camera so players are lit on
  // the side the camera sees; one ambient light.
  const sun = new DirectionalLight(DAY_LOOK.sunColour, DAY_LOOK.sunIntensity);
  sun.position.set(-40, 90, 60);
  sun.target.position.set(0, 0, 0);
  sun.shadow.camera.left = -80;
  sun.shadow.camera.right = 80;
  sun.shadow.camera.top = 80;
  sun.shadow.camera.bottom = -80;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 300;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.03;
  const ambient = new AmbientLight(DAY_LOOK.ambientColour, DAY_LOOK.ambientIntensity);
  const background = new Color(0x07070d);

  ctx.scene.add(root);
  ctx.scene.add(sun);
  ctx.scene.add(sun.target);
  ctx.scene.add(ambient);

  let look: StadiumLook = DAY_LOOK;
  let night = false;
  let time = 0;
  let viewName = '';
  let shadowSize = 0;
  const viewTarget = new Vector3();

  function apply(l: StadiumLook): void {
    look = l;
    background.setHex(l.skyHorizon);
    ctx.scene.background = background;
    groundMat.color.setHex(l.ground);
    sun.color.setHex(l.sunColour);
    sun.intensity = l.sunIntensity;
    ambient.color.setHex(l.ambientColour);
    ambient.intensity = l.ambientIntensity;
    skyUniforms.uTop.value.setHex(l.skyTop);
    skyUniforms.uHorizon.value.setHex(l.skyHorizon);
    skyUniforms.uBottom.value.setHex(l.skyBottom);
    lampMat.color.setHex(l.lampColour);
    haloUniforms.uColour.value.setHex(l.lampColour);
    haloUniforms.uStrength.value = l.haloStrength;
    halos.visible = l.haloStrength > 0;
    boardMat.color.setScalar(l.boardBrightness);
  }

  function applyTier(tier: QualityTier): void {
    const p = getTierParams(tier);
    sun.castShadow = p.shadowMap;
    const size = p.shadowMap ? p.shadowMapSize : 0;
    if (size > 0 && size !== shadowSize) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) {
        sun.shadow.map.dispose();
        sun.shadow.map = null;
      }
    }
    shadowSize = size;
    const r = ctx.renderer as WebGLRenderer | null;
    const maxAniso = r && r.capabilities ? r.capabilities.getMaxAnisotropy() : 1;
    const aniso = Math.max(1, Math.min(p.anisotropy, maxAniso));
    if (boardTex.anisotropy !== aniso) {
      boardTex.anisotropy = aniso;
      boardTex.needsUpdate = true;
    }
  }

  function applyView(): void {
    const v = viewName ? STADIUM_VIEWS[viewName] : undefined;
    if (!v) return;
    const cam = ctx.camera;
    cam.position.set(v[0], v[1], v[2]);
    viewTarget.set(v[3], v[4], v[5]);
    cam.lookAt(viewTarget);
    cam.updateMatrixWorld();
    if (cam.fov !== T.debugFovDeg) {
      cam.fov = T.debugFovDeg;
      cam.updateProjectionMatrix();
    }
  }

  const seats = generateSeats();
  const debug: StadiumDebug = {
    view(name: string): void {
      viewName = name && STADIUM_VIEWS[name] ? name : '';
    },
    snapshot(): StadiumSnapshot {
      let calls = 0, tris = 0;
      const list = [ground, stands, boards, lamps, halos, sky];
      for (const m of list) {
        if (!m.visible || !root.visible) continue;
        calls++;
        tris += triangleCount(m);
      }
      return {
        night, visible: root.visible, drawCalls: calls, triangles: tris, seats: seats.count,
        castShadow: sun.castShadow, shadowMapSize: shadowSize, boardOffset: boardTex.offset.x, view: viewName,
      };
    },
  };
  if (typeof window !== 'undefined') window.__dotkickStadium = debug;

  apply(DAY_LOOK);
  ctx.scene.background = background.setHex(0x07070d);
  applyTier(ctx.tier);

  return {
    sun,
    ambient,
    root,
    stands,
    boards,
    lamps,
    halos,
    sky,
    ground,
    debug,
    get look() { return look; },

    setMatch(state: ReadonlySimState, _clubs: readonly Club[]) {
      night = state.config.night === 1;
      apply(lookFor(night));
      applyTier(ctx.tier);
      time = 0;
      boardTex.offset.x = 0;
      root.visible = true;
    },

    update(f: RenderFrame) {
      let dt = f.frame.paused ? 0 : f.frame.dtMs / 1000;
      if (!(dt > 0)) dt = 0;
      if (dt > 0.1) dt = 0.1;
      time += dt;
      if (!ctx.reducedMotion && dt > 0) {
        let o = boardTex.offset.x + (dt * T.boardScroll) / BOARD_STRIP_LENGTH;
        if (o >= 1) o -= Math.floor(o);
        boardTex.offset.x = o;
      }
      applyView();
      sky.position.copy(ctx.camera.position);
    },

    warmUp() {
      const r = ctx.renderer as WebGLRenderer | null;
      if (r && typeof r.initTexture === 'function') r.initTexture(boardTex);
    },

    setQuality(tier: QualityTier) {
      applyTier(tier);
    },

    clearMatch() {
      root.visible = false;
      viewName = '';
      background.setHex(0x07070d);
      ctx.scene.background = background;
    },

    dispose() {
      ctx.scene.remove(root, sun, sun.target, ambient);
      for (const g of [groundGeo, standGeo, boardGeo, lampGeo, haloGeo, skyGeo]) g.dispose();
      for (const m of [groundMat, standMat, boardMat, lampMat, haloMat, skyMat]) m.dispose();
      boardTex.dispose();
      if (sun.shadow.map) sun.shadow.map.dispose();
      sun.dispose();
      ambient.dispose();
      if (ctx.scene.background === background) ctx.scene.background = null;
      if (typeof window !== 'undefined' && window.__dotkickStadium === debug) delete window.__dotkickStadium;
    },
  };
}
