/**
 * [GFX-13] Ball and blob shadows (section 8 "Look": "Shadows are blobs or cheap projections"; section 13: no
 * real-time shadow maps at the default tier). The ball is drawn at the interpolated position; its blob shadow
 * sits on the grass under it, growing and fading with height so high balls stay readable. One instanced blob
 * per player too (feet contact reads at broadcast distance).
 *
 * - Ball: a Lambert sphere with a generated panel texture (equirectangular, no assets): a white ball with twelve
 *   "dots" at the icosahedron vertices, alternately ink and ember, each inside a thin grey seam. Original design.
 * - Spin: the orientation integrates one rotation per animation frame (advanceBallSpin). On the ground the ball rolls
 *   without slipping (rotation about up x travel by |travel| / radius, from the interpolated render positions, so a
 *   dribbled ball rolls too) plus the sim's curl spin about +y; in the air it turns with the sim spin (sx, sy, sz).
 *   Per-frame angle clamped (no backwards strobing), placements (restarts, replay cuts) and paused frames do not spin.
 * - Blobs: ball blob diameter and opacity follow ballBlob(height); one InstancedMesh of NUM_SLOTS player blobs sized
 *   by player height; inactive (sent-off) slots collapse to a zero-size blob.
 * - Quality tiers: sphere detail per tier (PERFORMANCE / BALANCED / QUALITY); at QUALITY the ball also casts into
 *   the one shadow map GFX-02 enables (blobs stay as the contact / height cue).
 * Draw calls: 3 (ball, ball blob, player blobs). No allocation in update().
 */

import {
  DataTexture, DynamicDrawUsage, InstancedMesh, LinearFilter, LinearMipmapLinearFilter, Mesh, MeshBasicMaterial,
  MeshLambertMaterial, PlaneGeometry, Quaternion, RGBAFormat, SphereGeometry, SRGBColorSpace,
} from 'three';
import { BALL_RADIUS, NUM_SLOTS } from '../contracts/constants';
import { QualityTier } from '../contracts/enums';
import type { RenderContext, RenderFrame, RenderModule } from './types';

const LOCAL_TUNING = { // TUNING-CR (GFX-13 ball and blob shadows)
  /** Ball blob diameter with the ball on the grass, in ball radii (0.11 m ball -> 0.35 m blob). */
  ballBlobRadii: 3.2,
  /** Ball blob diameter growth per metre of height above resting (1/m): diameter * (1 + k * h). */
  ballBlobGrowPerM: 0.12,
  /** Ball blob opacity on the grass (0..1) and its fade per metre of height (1/m): base / (1 + k * h). */
  ballBlobOpacity: 0.55,
  ballBlobFadePerM: 0.35,
  /** Floor of the ball blob opacity (0..1): a very high ball still shows where it is over the pitch. */
  ballBlobMinOpacity: 0.12,
  /** Player blob diameter for a 180 cm player (m); scales with the player's height. */
  playerBlobSize: 1.15,
  /** Player blob opacity (0..1). */
  playerBlobOpacity: 0.38,
  /** Largest rotation drawn in one frame (rad): a fast roll turns visibly forward instead of strobing backwards. */
  maxSpinStepRad: 1.0,
  /** A ball move longer than this in one frame (m) is a placement (restart, replay cut): not rotated. */
  teleportM: 3,
  /** Ball-centre height (m) below which the ball rolls (rotation from travel) instead of turning with the sim spin. */
  rollHeight: 0.16,
  /** Longest frame step used for the spin (s). */
  maxFrameS: 0.1,
  /** Panel texture size (px, equirectangular 2:1). */
  textureW: 128,
  textureH: 64,
  /** Dot angular radius (rad) and the seam ring around it (rad). */
  dotRadius: 0.3,
  seamWidth: 0.05,
} as const;
export const BALL_TUNING = LOCAL_TUNING;

/** Height of shadow decals above the grass (m), above the pitch plane to avoid z-fighting. */
export const SHADOW_Y = 0.02;

/** Sphere detail [widthSegments, heightSegments] per QualityTier (index; AUTO uses the BALANCED entry). */
export const BALL_SEGMENTS: readonly (readonly [number, number])[] = [[20, 14], [12, 8], [20, 14], [28, 20]];

/** Panel colours (sRGB hex) by ballPanelAt code: 0 white, 1 ink dot, 2 ember dot, 3 seam. */
export const BALL_PANEL_COLOURS: readonly number[] = [0xf4f4f0, 0x1a1a24, 0xff6b35, 0xb4b4be];

export interface BallModule extends RenderModule {
  readonly ball: Mesh;
  readonly shadow: Mesh;
  readonly playerShadows: InstancedMesh;
  /** Ball orientation state (diagnostics, tests). */
  readonly spin: Readonly<BallSpin>;
}

// ============================================================ panel texture

const PHI = (1 + Math.sqrt(5)) / 2;
/** Unit directions of the 12 icosahedron vertices (dot centres). Even index = ink, odd = ember. */
export const BALL_DOTS: Float64Array = (() => {
  const raw = [
    0, 1, PHI, 0, -1, PHI, 0, 1, -PHI, 0, -1, -PHI,
    1, PHI, 0, -1, PHI, 0, 1, -PHI, 0, -1, -PHI, 0,
    PHI, 0, 1, -PHI, 0, 1, PHI, 0, -1, -PHI, 0, -1,
  ];
  const out = new Float64Array(36);
  const l = Math.sqrt(1 + PHI * PHI);
  for (let i = 0; i < 36; i++) out[i] = raw[i]! / l;
  return out;
})();

const COS_DOT = Math.cos(LOCAL_TUNING.dotRadius);
const COS_SEAM = Math.cos(LOCAL_TUNING.dotRadius + LOCAL_TUNING.seamWidth);

/**
 * Panel code at the unit direction (nx, ny, nz) on the ball: 1 ink dot, 2 ember dot (alternating over BALL_DOTS),
 * 3 the grey seam ring around a dot, 0 white. Pure.
 */
export function ballPanelAt(nx: number, ny: number, nz: number): number {
  let best = -2;
  let bi = 0;
  for (let i = 0; i < 12; i++) {
    const d = BALL_DOTS[i * 3]! * nx + BALL_DOTS[i * 3 + 1]! * ny + BALL_DOTS[i * 3 + 2]! * nz;
    if (d > best) { best = d; bi = i; }
  }
  if (best >= COS_DOT) return (bi & 1) === 0 ? 1 : 2;
  if (best >= COS_SEAM) return 3;
  return 0;
}

/**
 * Generated equirectangular panel texture for a SphereGeometry (its UVs: u = phi / 2pi, v = 1 - theta / pi;
 * direction (-cos phi sin theta, cos theta, sin phi sin theta)). Each texel takes the panel colour at its centre.
 * sRGB colour space, mipmapped (the ball is ~10 px at broadcast distance).
 */
export function createBallTexture(w: number = LOCAL_TUNING.textureW, h: number = LOCAL_TUNING.textureH): DataTexture {
  const data = new Uint8Array(w * h * 4);
  for (let j = 0; j < h; j++) {
    const theta = (1 - (j + 0.5) / h) * Math.PI;
    const st = Math.sin(theta);
    const ct = Math.cos(theta);
    for (let i = 0; i < w; i++) {
      const phi = ((i + 0.5) / w) * 2 * Math.PI;
      const code = ballPanelAt(-Math.cos(phi) * st, ct, Math.sin(phi) * st);
      const c = BALL_PANEL_COLOURS[code]!;
      const o = (j * w + i) * 4;
      data[o] = (c >> 16) & 255; data[o + 1] = (c >> 8) & 255; data[o + 2] = c & 255; data[o + 3] = 255;
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat);
  tex.colorSpace = SRGBColorSpace;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Radial alpha blob texture (generated, no assets). */
export function createBlobTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
      const a = d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
      const i = (y * size + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ============================================================ blob + spin maths

export interface BlobLook {
  /** Input: height of the ball's bottom above the grass (m). */
  h: number;
  /** Blob diameter (m). */
  size: number;
  /** Blob opacity 0..1. */
  opacity: number;
}

/** ballBlob on out.h (per-frame form: no double crosses a call boundary). */
function blobFromHeight(out: BlobLook): void {
  const h = out.h;
  const hh = h > 0 && h - h === 0 ? h : 0;
  out.size = BALL_RADIUS * LOCAL_TUNING.ballBlobRadii * (1 + hh * LOCAL_TUNING.ballBlobGrowPerM);
  const o = LOCAL_TUNING.ballBlobOpacity / (1 + hh * LOCAL_TUNING.ballBlobFadePerM);
  out.opacity = o > LOCAL_TUNING.ballBlobMinOpacity ? o : LOCAL_TUNING.ballBlobMinOpacity;
}

/** Ball blob for a ball whose bottom is `h` metres above the grass (negative / junk = 0). Pure, no allocation. */
export function ballBlob(h: number, out: BlobLook): BlobLook {
  out.h = h;
  blobFromHeight(out);
  return out;
}

/** Ball orientation carried between animation frames. */
export interface BallSpin {
  q: Quaternion;
  lastX: number;
  lastY: number;
  lastZ: number;
  /** False until the first frame (and after reset): the first frame only records the position. */
  has: boolean;
}

export function createBallSpin(): BallSpin {
  return { q: new Quaternion(), lastX: 0, lastY: 0, lastZ: 0, has: false };
}

export function resetBallSpin(st: BallSpin): void {
  st.q.identity();
  st.has = false;
}

/** stepBallSpin registers: inputs x, y, z, sx, sy, sz, dt, held (0/1); output angle (rad). */
export const SPIN_X = 0, SPIN_Y = 1, SPIN_Z = 2, SPIN_SX = 3, SPIN_SY = 4, SPIN_SZ = 5, SPIN_DT = 6, SPIN_HELD = 7;
export const SPIN_ANGLE = 8;
export function createSpinIo(): Float64Array {
  return new Float64Array(9);
}

function finiteOr0(v: number): number {
  return v - v === 0 ? v : 0;
}

/**
 * advanceBallSpin on registers (io, see SPIN_*): the per-frame form, so no double crosses a call boundary (V8 boxes
 * those when it does not inline the call). Writes the applied angle to io[SPIN_ANGLE].
 */
export function stepBallSpin(st: BallSpin, io: Float64Array): void {
  const x = io[SPIN_X]!, y = io[SPIN_Y]!, z = io[SPIN_Z]!, dt = io[SPIN_DT]!;
  let angle = 0;
  if (st.has && io[SPIN_HELD]! === 0 && dt > 0) {
    const dx = x - st.lastX;
    const dy = y - st.lastY;
    const dz = z - st.lastZ;
    const tele = LOCAL_TUNING.teleportM;
    if (dx * dx + dy * dy + dz * dz <= tele * tele) {
      let ax: number, ay: number, az: number;
      if (y < LOCAL_TUNING.rollHeight) {
        ax = dz / BALL_RADIUS;
        ay = finiteOr0(io[SPIN_SY]!) * dt;
        az = -dx / BALL_RADIUS;
      } else {
        ax = finiteOr0(io[SPIN_SX]!) * dt;
        ay = finiteOr0(io[SPIN_SY]!) * dt;
        az = finiteOr0(io[SPIN_SZ]!) * dt;
      }
      const l = Math.sqrt(ax * ax + ay * ay + az * az);
      if (l > 1e-9 && l - l === 0) {
        angle = l < LOCAL_TUNING.maxSpinStepRad ? l : LOCAL_TUNING.maxSpinStepRad;
        // dq = rotation by `angle` about (ax, ay, az) / l; q = dq * q (world-space rotation), renormalised.
        const hs = Math.sin(angle * 0.5) / l;
        const bx = ax * hs, by = ay * hs, bz = az * hs, bw = Math.cos(angle * 0.5);
        const q = st.q;
        const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
        let nx = bx * qw + bw * qx + by * qz - bz * qy;
        let ny = by * qw + bw * qy + bz * qx - bx * qz;
        let nz = bz * qw + bw * qz + bx * qy - by * qx;
        let nw = bw * qw - bx * qx - by * qy - bz * qz;
        const n = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
        if (n > 0) { nx /= n; ny /= n; nz /= n; nw /= n; }
        q.set(nx, ny, nz, nw);
      }
    }
  }
  if (x - x === 0 && y - y === 0 && z - z === 0) {
    st.lastX = x; st.lastY = y; st.lastZ = z;
    st.has = true;
  }
  io[SPIN_ANGLE] = angle;
}

const SPIN_IO = createSpinIo();

/**
 * Advance the ball orientation by one animation frame to the ball centre (x, y, z), with the sim spin (sx, sy, sz)
 * in rad/s on world axes and the frame step dt (s; 0 when paused). Rolling (y below rollHeight): rotation vector
 * (up x travel) / radius + (0, sy * dt, 0). Airborne: spin * dt. Held in hands, paused, the first frame or a jump
 * longer than teleportM: no rotation. The angle is clamped to maxSpinStepRad. Returns the angle applied (rad).
 */
export function advanceBallSpin(
  st: BallSpin, x: number, y: number, z: number, sx: number, sy: number, sz: number, dt: number, held: boolean,
): number {
  const io = SPIN_IO;
  io[SPIN_X] = x; io[SPIN_Y] = y; io[SPIN_Z] = z; io[SPIN_SX] = sx; io[SPIN_SY] = sy; io[SPIN_SZ] = sz;
  io[SPIN_DT] = dt; io[SPIN_HELD] = held ? 1 : 0;
  stepBallSpin(st, io);
  return io[SPIN_ANGLE]!;
}

/** Sphere detail for a tier (AUTO / unknown -> BALANCED). */
function segmentsFor(tier: QualityTier): readonly [number, number] {
  return BALL_SEGMENTS[tier] ?? BALL_SEGMENTS[QualityTier.BALANCED]!;
}

// ============================================================ module

export function createBall(ctx: RenderContext): BallModule {
  const geos: (SphereGeometry | null)[] = [null, null, null, null];
  const geoFor = (tier: QualityTier): SphereGeometry => {
    const t = tier >= QualityTier.PERFORMANCE && tier <= QualityTier.QUALITY ? tier : QualityTier.BALANCED;
    let g = geos[t];
    if (!g) {
      const [ws, hs] = segmentsFor(t);
      g = new SphereGeometry(BALL_RADIUS, ws, hs);
      geos[t] = g;
    }
    return g;
  };
  const ballTex = createBallTexture();
  const ballMat = new MeshLambertMaterial({ color: 0xffffff, map: ballTex, emissive: 0x2a2a2a });
  const ball = new Mesh(geoFor(ctx.tier), ballMat);
  ball.name = 'ball';
  ball.visible = false;
  ball.renderOrder = 1;
  ball.castShadow = ctx.tier === QualityTier.QUALITY;

  const blobTex = createBlobTexture();
  const quad = new PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  const shadowMat = new MeshBasicMaterial({
    color: 0x000000, map: blobTex, transparent: true, opacity: LOCAL_TUNING.ballBlobOpacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const shadow = new Mesh(quad, shadowMat);
  shadow.name = 'ball-shadow';
  shadow.visible = false;
  shadow.renderOrder = 1;

  const playerShadowMat = new MeshBasicMaterial({
    color: 0x000000, map: blobTex, transparent: true, opacity: LOCAL_TUNING.playerBlobOpacity, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const playerShadows = new InstancedMesh(quad, playerShadowMat, NUM_SLOTS);
  playerShadows.name = 'player-shadows';
  playerShadows.instanceMatrix.setUsage(DynamicDrawUsage);
  playerShadows.frustumCulled = false;
  playerShadows.visible = false;
  playerShadows.renderOrder = 1;
  const m = playerShadows.instanceMatrix.array as Float32Array;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const o = i * 16;
    m.fill(0, o, o + 16);
    m[o + 15] = 1;
  }

  ctx.scene.add(ball);
  ctx.scene.add(shadow);
  ctx.scene.add(playerShadows);

  const spin = createBallSpin();
  const spinIo = createSpinIo();
  const blob: BlobLook = { h: 0, size: 0, opacity: 0 };
  let active = false;

  return {
    ball,
    shadow,
    playerShadows,
    spin,
    setMatch() {
      active = true;
      ball.visible = true;
      shadow.visible = true;
      playerShadows.visible = true;
      resetBallSpin(spin);
      ball.quaternion.identity();
    },
    update(f: RenderFrame) {
      const it = f.interp;
      const b = f.curr.ball;
      ball.position.set(it.ballX, it.ballY, it.ballZ);
      const fr = f.frame;
      let dt = fr.paused ? 0 : fr.dtMs / 1000;
      if (!(dt > 0)) dt = 0;
      else if (dt > LOCAL_TUNING.maxFrameS) dt = LOCAL_TUNING.maxFrameS;
      spinIo[SPIN_X] = it.ballX; spinIo[SPIN_Y] = it.ballY; spinIo[SPIN_Z] = it.ballZ;
      spinIo[SPIN_SX] = b.sx; spinIo[SPIN_SY] = b.sy; spinIo[SPIN_SZ] = b.sz;
      spinIo[SPIN_DT] = dt; spinIo[SPIN_HELD] = b.heldBy >= 0 ? 1 : 0;
      stepBallSpin(spin, spinIo);
      ball.quaternion.copy(spin.q);

      // Ball blob: hidden when the ball is below the grass (tests sink it out of view).
      blob.h = it.ballY - BALL_RADIUS;
      blobFromHeight(blob);
      shadow.visible = active && it.ballY > -BALL_RADIUS;
      shadow.position.set(it.ballX, SHADOW_Y + 0.002, it.ballZ);
      shadow.scale.set(blob.size, 1, blob.size);
      shadowMat.opacity = blob.opacity;

      const s = f.curr;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const o = i * 16;
        const hcm = s.attrs[i]!.height;
        const size = s.players[i]!.active === 1
          ? LOCAL_TUNING.playerBlobSize * (hcm > 100 && hcm < 230 ? hcm / 180 : 1)
          : 0;
        m[o] = size; m[o + 5] = 1; m[o + 10] = size;
        m[o + 12] = it.x[i]!; m[o + 13] = SHADOW_Y; m[o + 14] = it.z[i]!;
      }
      playerShadows.instanceMatrix.needsUpdate = true;
    },
    setQuality(tier: QualityTier) {
      ball.geometry = geoFor(tier);
      ball.castShadow = tier === QualityTier.QUALITY;
    },
    clearMatch() {
      active = false;
      ball.visible = false;
      shadow.visible = false;
      playerShadows.visible = false;
    },
    dispose() {
      ctx.scene.remove(ball, shadow, playerShadows);
      for (let i = 0; i < geos.length; i++) geos[i]?.dispose();
      ballMat.dispose(); ballTex.dispose();
      quad.dispose(); shadowMat.dispose(); playerShadowMat.dispose(); blobTex.dispose();
      playerShadows.dispose();
    },
  };
}
