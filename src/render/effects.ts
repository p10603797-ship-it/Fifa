/**
 * [GFX-16] Small effects (section 8 "Look"; section 13 budgets and warm-up). Cheap, pooled, preallocated, optional by
 * tier (getTierParams().effectsScale, GFX-02):
 *  - BALL TRAIL on hard shots: a camera-facing ribbon through the ball's last positions (LOCAL_TUNING.trailPoints,
 *    fading over trailLife) while a shot in flight is faster than trailShotSpeed or any loose ball faster than
 *    trailAnySpeed. Off at tiers with effectsScale < trailMinScale (Performance).
 *  - NET-BULGE PUFF: a burst of soft white particles where the ball enters a net (ball.inNet 0 -> +-1), pushed along
 *    the ball's travel; complements the GFX-04 net ripple.
 *  - GRASS KICK-UP on slides: green / earth particles thrown up from the boots while a player slides (act
 *    SLIDE_TACKLE) faster than slideMinSpeed.
 *  - GOAL FLASH: a short, soft full-screen white flash (peak flashPeak, flashTime) on the GOAL event and when a
 *    replayed goal enters the net.
 * Triggers are derived from the frame's state (frame.curr / frame.interp), so replays (GFX-16 replay.ts substitutes
 * the frame) show the same effects; while a replay plays, effect time runs at its slow-motion rate and every replay cut
 * resets the trail and the edge detectors (replayPlaybackOf(ctx).cuts).
 * DRAW CALLS: 0 when idle (everything hidden); at most 3 while effects show (particles: one Points with a pooled
 * buffer of maxParticles x effectsScale; trail: one Mesh; flash: one Mesh). Unlit shaders, no textures.
 * No allocation in update() / onEvents(): typed-array pools, module-level scratch, an xorshift generator in a typed
 * array. warmUp() runs every effect through update() off screen often enough for the JIT to optimise it (shader programs
 * are compiled by the renderer's scene compile, which includes hidden objects).
 * DEBUG: window.__dotkickEffects (this module; snapshot()) for e2e.
 */

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, Mesh, MeshBasicMaterial, PlaneGeometry,
  Points, ShaderMaterial,
} from 'three';
import { NUM_SLOTS } from '../contracts/constants';
import { ActionKind, type QualityTier } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import type { PlayerData } from '../contracts/data';
import { createSimState, type MatchConfig, type ReadonlySimState } from '../contracts/state';
import { T_BALL } from '../contracts/tuning';
import { getTierParams } from './quality';
import { replayPlaybackOf } from './replay';
import { createInterpState, type RenderContext, type RenderFrame, type RenderModule } from './types';

export const LOCAL_TUNING = { // LOCAL_TUNING (non-gameplay: GFX-16 effects, render only)
  /** Particle pool at effectsScale 1 (Quality); tiers scale it by getTierParams().effectsScale. */
  maxParticles: 256,
  // ---- ball trail
  /** A shot in flight (ball.shotBy >= 0) faster than this shows the trail, m/s. */
  trailShotSpeed: 18,
  /** Any loose ball faster than this shows the trail, m/s. */
  trailAnySpeed: 27,
  /** Trail points kept and their lifetime, s. */
  trailPoints: 24,
  trailLife: 0.22,
  /** Ribbon half width at the head, m, and its peak opacity. */
  trailHalfWidth: 0.09,
  trailAlpha: 0.55,
  /** Tiers whose effectsScale is below this draw no trail. */
  trailMinScale: 0.7,
  /** Ball moved further than this in one frame (m): teleport or replay cut, the trail restarts. */
  trailTeleport: 4,
  /** Minimum ball travel between stored trail points, m. */
  trailMinStep: 0.02,
  // ---- net puff
  puffCount: 14,
  /** Burst speed m/s, lifetime s, start size m (grows by puffGrow per s), velocity drag 1/s, opacity. */
  puffSpeed: 3,
  puffLife: 0.55,
  puffSize: 0.28,
  puffGrow: 0.5,
  puffDrag: 4,
  puffAlpha: 0.7,
  // ---- slide grass kick-up
  /** Particles per second while sliding (x effectsScale). */
  slideRate: 70,
  /** Slides slower than this throw no grass, m/s. */
  slideMinSpeed: 1.5,
  /** Lifetime s, size m, upward speed m/s, random horizontal speed m/s, share of the slide speed carried. */
  slideLife: 0.6,
  slideSize: 0.09,
  slideUp: 2.2,
  slideSpread: 1.4,
  slideCarry: 0.3,
  /** Distance ahead of the player's position where the boots touch the grass, m. */
  slideFootAhead: 0.5,
  // ---- goal flash
  flashPeak: 0.32,
  flashTime: 0.4,
  /** Longest real frame time an effect step advances, s. */
  maxStep: 0.1,
  /** warmUp() frames run through update() off screen (loading screen; a few ms). */
  warmUpIterations: 2400,
} as const;

const LT = LOCAL_TUNING;
const MAXP = LT.maxParticles;
const TN = LT.trailPoints;
const KIND_GRASS = 0, KIND_PUFF = 1;

/** Effects state for diagnostics, tests and e2e. */
export interface EffectsSnapshot {
  particles: number;
  particleCap: number;
  trailPoints: number;
  trailOn: boolean;
  flash: number;
  drawCalls: number;
}

export interface EffectsModule extends RenderModule {
  snapshot(out?: EffectsSnapshot): EffectsSnapshot;
}

/** True when the ball qualifies for the trail (loose, fast, a hard shot or any very fast ball). Pure. */
export function trailWanted(b: { owner: number; heldBy: number; shotBy: number; vx: number; vy: number; vz: number }): boolean {
  if (b.owner >= 0 || b.heldBy >= 0) return false;
  const s2 = b.vx * b.vx + b.vy * b.vy + b.vz * b.vz;
  if (!(s2 === s2)) return false;
  return s2 >= LT.trailAnySpeed * LT.trailAnySpeed || (b.shotBy >= 0 && s2 >= LT.trailShotSpeed * LT.trailShotSpeed);
}

/** Particle cap for an effects scale (tier). Pure. */
export function particleCapFor(effectsScale: number): number {
  const s = effectsScale > 0 ? Math.min(1, effectsScale) : 0;
  return Math.round(MAXP * s);
}

// Render-only randomness: a table of xorshift32 values in [0, 1), read inline (a call returning a double can box).
const RMASK = 4095;
const RT = new Float32Array(RMASK + 1);
{
  let x = 0x2545f491;
  for (let i = 0; i <= RMASK; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    RT[i] = x / 4294967296;
  }
}

// Per-frame doubles pass between stages through IO (no double crosses a call boundary: zero allocation).
const IO_DT = 0, IO_FXDT = 1, IO_BX = 2, IO_BY = 3, IO_BZ = 4, IO_VX = 5, IO_VY = 6, IO_VZ = 7, IO_PX = 8, IO_PZ = 9,
  IO_FX = 10, IO_FZ = 11, IO_SPEED = 12, IO_SCALE = 13, IO_FLASH = 14;
// Spawn parameters.
const SP_X = 0, SP_Y = 1, SP_Z = 2, SP_VX = 3, SP_VY = 4, SP_VZ = 5, SP_LIFE = 6, SP_SIZE = 7, SP_R = 8, SP_G = 9, SP_B = 10,
  SP_A = 11;

const PARTICLE_VERT = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
uniform float uScale;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 96.0);
}`;
const PARTICLE_FRAG = /* glsl */ `
varying vec4 vColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a * (1.0 - r2 * 4.0));
  #include <colorspace_fragment>
}`;
const FLASH_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const FLASH_FRAG = /* glsl */ `
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(1.0, 0.98, 0.92, uAlpha);
  #include <colorspace_fragment>
}`;

/**
 * A float uniform with its own hidden class: `{ value }` literals share one map with every three.js uniform, whose
 * `value` field holds objects, so a double stored into such a literal is boxed (one allocation per frame).
 */
class FloatUniform {
  // Initialised with a double (an uninitialised ES2022 field starts as undefined: tagged, boxing every store).
  value = 0.5;
  constructor(v: number) { this.value = v; }
}

/** Linear RGB of an sRGB hex colour. */
function linear(hex: number): [number, number, number] {
  const c = new Color().setHex(hex);
  return [c.r, c.g, c.b];
}

export function createEffects(ctx: RenderContext): EffectsModule {
  const link = replayPlaybackOf(ctx);
  const group = new Group();
  group.name = 'effects';
  group.visible = false;
  group.matrixAutoUpdate = false;

  // ---- particles (pool)
  const px = new Float32Array(MAXP), py = new Float32Array(MAXP), pz = new Float32Array(MAXP);
  const pvx = new Float32Array(MAXP), pvy = new Float32Array(MAXP), pvz = new Float32Array(MAXP);
  const age = new Float32Array(MAXP), life = new Float32Array(MAXP), size0 = new Float32Array(MAXP);
  const pr = new Float32Array(MAXP), pg = new Float32Array(MAXP), pb = new Float32Array(MAXP), pa = new Float32Array(MAXP);
  const kind = new Uint8Array(MAXP);
  const posArr = new Float32Array(MAXP * 3), colArr = new Float32Array(MAXP * 4), sizeArr = new Float32Array(MAXP);
  const pGeo = new BufferGeometry();
  const posAttr = new BufferAttribute(posArr, 3).setUsage(DynamicDrawUsage);
  const colAttr = new BufferAttribute(colArr, 4).setUsage(DynamicDrawUsage);
  const sizeAttr = new BufferAttribute(sizeArr, 1).setUsage(DynamicDrawUsage);
  pGeo.setAttribute('position', posAttr);
  pGeo.setAttribute('aColor', colAttr);
  pGeo.setAttribute('aSize', sizeAttr);
  pGeo.setDrawRange(0, 0);
  const uScale = new FloatUniform(500.5);
  const pMat = new ShaderMaterial({
    name: 'fx-particles', vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, uniforms: { uScale },
    transparent: true, depthWrite: false,
  });
  const points = new Points(pGeo, pMat);
  points.name = 'fx-particles';
  points.frustumCulled = false;
  points.visible = false;
  points.renderOrder = 5;
  group.add(points);

  // ---- trail ribbon
  const hx = new Float32Array(TN), hy = new Float32Array(TN), hz = new Float32Array(TN), hage = new Float32Array(TN);
  const tPos = new Float32Array(TN * 2 * 3), tCol = new Float32Array(TN * 2 * 4);
  const tIdx = new Uint16Array((TN - 1) * 6);
  for (let i = 0; i < TN - 1; i++) {
    const a = i * 2, o = i * 6;
    tIdx[o] = a; tIdx[o + 1] = a + 1; tIdx[o + 2] = a + 2;
    tIdx[o + 3] = a + 1; tIdx[o + 4] = a + 3; tIdx[o + 5] = a + 2;
  }
  const tGeo = new BufferGeometry();
  const tPosAttr = new BufferAttribute(tPos, 3).setUsage(DynamicDrawUsage);
  const tColAttr = new BufferAttribute(tCol, 4).setUsage(DynamicDrawUsage);
  tGeo.setAttribute('position', tPosAttr);
  tGeo.setAttribute('color', tColAttr);
  tGeo.setIndex(new BufferAttribute(tIdx, 1));
  tGeo.setDrawRange(0, 0);
  const tMat = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: DoubleSide });
  tMat.name = 'fx-trail';
  const trail = new Mesh(tGeo, tMat);
  trail.name = 'fx-trail';
  trail.frustumCulled = false;
  trail.visible = false;
  trail.renderOrder = 4;
  group.add(trail);

  // ---- goal flash (clip-space quad)
  const uAlpha = new FloatUniform(0.5);
  const fMat = new ShaderMaterial({
    name: 'fx-flash', vertexShader: FLASH_VERT, fragmentShader: FLASH_FRAG, uniforms: { uAlpha },
    transparent: true, depthTest: false, depthWrite: false,
  });
  const flash = new Mesh(new PlaneGeometry(2, 2), fMat);
  flash.name = 'fx-flash';
  flash.frustumCulled = false;
  flash.visible = false;
  flash.renderOrder = 1000;
  group.add(flash);

  ctx.scene.add(group);

  const GRASS = new Float32Array(12);
  {
    const g = [0x4f8a2e, 0x6fa13c, 0x3d6e25, 0x7a5a35];
    for (let i = 0; i < 4; i++) { const c = linear(g[i]!); GRASS[i * 3] = c[0]; GRASS[i * 3 + 1] = c[1]; GRASS[i * 3 + 2] = c[2]; }
  }
  const PUFF = new Float32Array(linear(0xf4f6f8));
  const TRAIL = new Float32Array(linear(0xfff6e0));

  const IO = new Float64Array(16);
  const SP = new Float64Array(12);
  const slideAcc = new Float32Array(NUM_SLOTS);
  const lastInNet = new Int8Array(1);
  // Small integers only below.
  let n = 0;
  const RI = new Int32Array(1); // random table cursor
  let cap = particleCapFor(getTierParams(ctx.tier).effectsScale);
  let trailOn = getTierParams(ctx.tier).effectsScale >= LT.trailMinScale;
  let tHead = 0; // index of the newest trail point
  let tCount = 0;
  let seenCuts = link.cuts;
  let matchOn = false;
  /** State of the latest setMatch, used once by warmUp() to build a private warm-up state (then dropped). */
  let warmSrc: ReadonlySimState | null = null;
  IO[IO_SCALE] = getTierParams(ctx.tier).effectsScale;

  /** Spawn one particle of kind k from the SP parameters (dropped when the tier's pool is full). Random values are
   *  read inline from RT: RT[RI[0] = (RI[0]! + 1) & RMASK]. */
  function spawnSP(k: number): void {
    if (n >= cap) return;
    const i = n++;
    px[i] = SP[SP_X]!; py[i] = SP[SP_Y]!; pz[i] = SP[SP_Z]!;
    pvx[i] = SP[SP_VX]!; pvy[i] = SP[SP_VY]!; pvz[i] = SP[SP_VZ]!;
    age[i] = 0; life[i] = SP[SP_LIFE]!; size0[i] = SP[SP_SIZE]!;
    pr[i] = SP[SP_R]!; pg[i] = SP[SP_G]!; pb[i] = SP[SP_B]!; pa[i] = SP[SP_A]!; kind[i] = k;
  }

  /** Puff at IO ball position pushed along IO ball velocity. */
  function spawnPuff(): void {
    const dvx = IO[IO_VX]!, dvy = IO[IO_VY]!, dvz = IO[IO_VZ]!;
    const l = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    const ux = l > 1e-3 ? dvx / l : 0, uy = l > 1e-3 ? dvy / l : 0, uz = l > 1e-3 ? dvz / l : 0;
    const count = Math.max(4, Math.round(LT.puffCount * IO[IO_SCALE]!));
    for (let i = 0; i < count; i++) {
      const sp = LT.puffSpeed * (0.4 + 0.6 * RT[RI[0] = (RI[0]! + 1) & RMASK]!);
      const rx = RT[RI[0] = (RI[0]! + 1) & RMASK]! * 2 - 1, ry = RT[RI[0] = (RI[0]! + 1) & RMASK]! * 2 - 1, rz = RT[RI[0] = (RI[0]! + 1) & RMASK]! * 2 - 1;
      SP[SP_X] = IO[IO_BX]!; SP[SP_Y] = IO[IO_BY]!; SP[SP_Z] = IO[IO_BZ]!;
      SP[SP_VX] = (ux + rx * 0.8) * sp; SP[SP_VY] = (uy * 0.5 + ry * 0.6 + 0.2) * sp; SP[SP_VZ] = (uz + rz * 0.8) * sp;
      SP[SP_LIFE] = LT.puffLife * (0.7 + 0.3 * RT[RI[0] = (RI[0]! + 1) & RMASK]!);
      SP[SP_SIZE] = LT.puffSize * (0.7 + 0.6 * RT[RI[0] = (RI[0]! + 1) & RMASK]!);
      SP[SP_R] = PUFF[0]!; SP[SP_G] = PUFF[1]!; SP[SP_B] = PUFF[2]!; SP[SP_A] = LT.puffAlpha;
      spawnSP(KIND_PUFF);
    }
  }

  /** One grass particle from the boots of the slider at IO_PX / IO_PZ facing IO_FX / IO_FZ at IO_SPEED. */
  function spawnGrass(): void {
    const c = ((RT[RI[0] = (RI[0]! + 1) & RMASK]! * 4) | 0) * 3;
    const fx = IO[IO_FX]!, fz = IO[IO_FZ]!;
    const carry = IO[IO_SPEED]! * LT.slideCarry;
    SP[SP_X] = IO[IO_PX]! + fx * LT.slideFootAhead + (RT[RI[0] = (RI[0]! + 1) & RMASK]! - 0.5) * 0.3;
    SP[SP_Y] = 0.04;
    SP[SP_Z] = IO[IO_PZ]! + fz * LT.slideFootAhead + (RT[RI[0] = (RI[0]! + 1) & RMASK]! - 0.5) * 0.3;
    SP[SP_VX] = fx * carry + (RT[RI[0] = (RI[0]! + 1) & RMASK]! * 2 - 1) * LT.slideSpread;
    SP[SP_VY] = LT.slideUp * (0.6 + 0.6 * RT[RI[0] = (RI[0]! + 1) & RMASK]!);
    SP[SP_VZ] = fz * carry + (RT[RI[0] = (RI[0]! + 1) & RMASK]! * 2 - 1) * LT.slideSpread;
    SP[SP_LIFE] = LT.slideLife * (0.6 + 0.4 * RT[RI[0] = (RI[0]! + 1) & RMASK]!);
    SP[SP_SIZE] = LT.slideSize * (0.7 + 0.6 * RT[RI[0] = (RI[0]! + 1) & RMASK]!);
    SP[SP_R] = GRASS[c]!; SP[SP_G] = GRASS[c + 1]!; SP[SP_B] = GRASS[c + 2]!; SP[SP_A] = 1;
    spawnSP(KIND_GRASS);
  }

  /** Integrate particles over IO_FXDT; expired ones are swap-removed (the pool stays packed). */
  function stepParticles(): void {
    const dt = IO[IO_FXDT]!;
    const g = T_BALL.gravity;
    const drag = Math.max(0, 1 - LT.puffDrag * dt);
    let i = 0;
    while (i < n) {
      const a = age[i]! + dt;
      if (a >= life[i]!) {
        const j = --n;
        px[i] = px[j]!; py[i] = py[j]!; pz[i] = pz[j]!; pvx[i] = pvx[j]!; pvy[i] = pvy[j]!; pvz[i] = pvz[j]!;
        age[i] = age[j]!; life[i] = life[j]!; size0[i] = size0[j]!;
        pr[i] = pr[j]!; pg[i] = pg[j]!; pb[i] = pb[j]!; pa[i] = pa[j]!; kind[i] = kind[j]!;
        continue;
      }
      age[i] = a;
      if (kind[i] === KIND_GRASS) {
        pvy[i] = pvy[i]! - g * dt;
      } else {
        pvx[i] = pvx[i]! * drag; pvy[i] = pvy[i]! * drag; pvz[i] = pvz[i]! * drag;
      }
      px[i] = px[i]! + pvx[i]! * dt;
      let y = py[i]! + pvy[i]! * dt;
      if (y < 0.02) { y = 0.02; pvy[i] = 0; pvx[i] = pvx[i]! * 0.5; pvz[i] = pvz[i]! * 0.5; }
      py[i] = y;
      pz[i] = pz[i]! + pvz[i]! * dt;
      i++;
    }
  }

  function writeParticles(): void {
    for (let i = 0; i < n; i++) {
      const o3 = i * 3, o4 = i * 4;
      posArr[o3] = px[i]!; posArr[o3 + 1] = py[i]!; posArr[o3 + 2] = pz[i]!;
      const t = age[i]! / life[i]!;
      const fade = 1 - t;
      colArr[o4] = pr[i]!; colArr[o4 + 1] = pg[i]!; colArr[o4 + 2] = pb[i]!;
      colArr[o4 + 3] = pa[i]! * (kind[i] === KIND_PUFF ? fade * fade : fade);
      sizeArr[i] = size0[i]! + (kind[i] === KIND_PUFF ? LT.puffGrow * age[i]! : 0);
    }
    pGeo.drawRange.count = n;
    if (n > 0) {
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
      sizeAttr.needsUpdate = true;
      // Pixels per metre at 1 m: drawing-buffer height * projection[5] / 2.
      uScale.value = ctx.size.cssH * ctx.size.dpr * ctx.size.scale * 0.5 * ctx.camera.projectionMatrix.elements[5]!;
    }
    points.visible = n > 0;
  }

  function resetTrail(): void {
    tCount = 0;
    tHead = 0;
    trail.visible = false;
    tGeo.drawRange.count = 0;
  }

  /** Age the trail by IO_FXDT, add the IO ball position when `want`, rebuild the ribbon facing the camera. */
  function stepTrail(want: boolean): void {
    const dt = IO[IO_FXDT]!;
    for (let k = 0; k < tCount; k++) {
      const i = (tHead - k + TN) % TN;
      hage[i] = hage[i]! + dt;
    }
    while (tCount > 0 && hage[(tHead - tCount + 1 + TN) % TN]! >= LT.trailLife) tCount--;
    if (want) {
      const bx = IO[IO_BX]!, by = IO[IO_BY]!, bz = IO[IO_BZ]!;
      let add = true;
      if (tCount > 0) {
        const dx = bx - hx[tHead]!, dy = by - hy[tHead]!, dz = bz - hz[tHead]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > LT.trailTeleport * LT.trailTeleport) tCount = 0;
        else if (d2 < LT.trailMinStep * LT.trailMinStep) add = false;
      }
      if (add) {
        tHead = (tHead + 1) % TN;
        hx[tHead] = bx; hy[tHead] = by; hz[tHead] = bz; hage[tHead] = 0;
        if (tCount < TN) tCount++;
      }
    }
    if (tCount < 2) {
      trail.visible = false;
      tGeo.drawRange.count = 0;
      return;
    }
    const cp = ctx.camera.position;
    const cx = cp.x, cy = cp.y, cz = cp.z;
    for (let k = 0; k < tCount; k++) {
      const i = (tHead - k + TN) % TN;
      const ia = (tHead - (k > 0 ? k - 1 : 0) + TN) % TN, ib = (tHead - (k + 1 < tCount ? k + 1 : tCount - 1) + TN) % TN;
      const tx = hx[ia]! - hx[ib]!, ty = hy[ia]! - hy[ib]!, tz = hz[ia]! - hz[ib]!;
      const vx = cx - hx[i]!, vy = cy - hy[i]!, vz = cz - hz[i]!;
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
      const u = Math.min(1, hage[i]! / LT.trailLife);
      const w = sl > 1e-6 ? (LT.trailHalfWidth * (1 - u * 0.7)) / sl : 0;
      sx *= w; sy *= w; sz *= w;
      const o = k * 6;
      tPos[o] = hx[i]! + sx; tPos[o + 1] = hy[i]! + sy; tPos[o + 2] = hz[i]! + sz;
      tPos[o + 3] = hx[i]! - sx; tPos[o + 4] = hy[i]! - sy; tPos[o + 5] = hz[i]! - sz;
      const al = LT.trailAlpha * (1 - u) * (1 - u);
      const c = k * 8;
      tCol[c] = TRAIL[0]!; tCol[c + 1] = TRAIL[1]!; tCol[c + 2] = TRAIL[2]!; tCol[c + 3] = al;
      tCol[c + 4] = TRAIL[0]!; tCol[c + 5] = TRAIL[1]!; tCol[c + 6] = TRAIL[2]!; tCol[c + 7] = al;
    }
    tGeo.drawRange.count = (tCount - 1) * 6;
    tPosAttr.needsUpdate = true;
    tColAttr.needsUpdate = true;
    trail.visible = true;
  }

  function triggerFlash(): void {
    IO[IO_FLASH] = LT.flashTime;
  }

  /** Flash decay over IO_DT (real time). */
  function stepFlash(): void {
    let t = IO[IO_FLASH]!;
    if (!(t > 0)) {
      flash.visible = false;
      return;
    }
    t = Math.max(0, t - IO[IO_DT]!);
    IO[IO_FLASH] = t;
    if (t > 0) {
      const u = t / LT.flashTime; // 1 -> 0
      uAlpha.value = LT.flashPeak * u * u;
      flash.visible = true;
    } else flash.visible = false;
  }

  function resetAll(): void {
    n = 0;
    pGeo.drawRange.count = 0;
    points.visible = false;
    resetTrail();
    IO[IO_FLASH] = 0;
    flash.visible = false;
    slideAcc.fill(0);
  }

  function update(f: RenderFrame): void {
    if (!matchOn) return;
    const ms = f.frame.dtMs;
    const dt = f.frame.paused || !(ms > 0) ? 0 : Math.min(LT.maxStep, ms / 1000);
    const fxDt = link.playing ? dt * (link.rate > 0 ? link.rate : 1) : dt;
    IO[IO_DT] = dt;
    IO[IO_FXDT] = fxDt;
    const s = f.curr, it = f.interp, b = s.ball;
    IO[IO_BX] = it.ballX; IO[IO_BY] = it.ballY; IO[IO_BZ] = it.ballZ;
    IO[IO_VX] = b.vx; IO[IO_VY] = b.vy; IO[IO_VZ] = b.vz;
    const inNet = b.inNet < 0 ? -1 : b.inNet > 0 ? 1 : 0;
    if (link.cuts !== seenCuts) {
      // Replay start / angle change / end: the ball and players jump. Restart the trail and the edge detectors.
      seenCuts = link.cuts;
      resetTrail();
      lastInNet[0] = inNet;
      slideAcc.fill(0);
    }
    // Net-bulge puff (and the replayed goal's flash) when the ball enters a net.
    if (inNet !== 0 && lastInNet[0] === 0) {
      spawnPuff();
      if (link.playing) triggerFlash();
    }
    lastInNet[0] = inNet;
    // Grass kicked up by slides.
    const rate = LT.slideRate * IO[IO_SCALE]!;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || p.act !== ActionKind.SLIDE_TACKLE) { slideAcc[i] = 0; continue; }
      const vx = it.vx[i]!, vz = it.vz[i]!;
      const speed = Math.sqrt(vx * vx + vz * vz);
      if (!(speed >= LT.slideMinSpeed)) { slideAcc[i] = 0; continue; }
      let acc = slideAcc[i]! + rate * fxDt;
      if (acc >= 1) {
        IO[IO_PX] = it.x[i]!; IO[IO_PZ] = it.z[i]!; IO[IO_FX] = it.fx[i]!; IO[IO_FZ] = it.fz[i]!; IO[IO_SPEED] = speed;
        while (acc >= 1) {
          spawnGrass();
          acc -= 1;
        }
      }
      slideAcc[i] = acc;
    }
    stepParticles();
    writeParticles();
    stepTrail(trailOn && trailWanted(b));
    stepFlash();
  }

  const snap: EffectsSnapshot = { particles: 0, particleCap: 0, trailPoints: 0, trailOn: false, flash: 0, drawCalls: 0 };

  const module: EffectsModule = {
    setMatch(state: ReadonlySimState) {
      warmSrc = state;
      resetAll();
      lastInNet[0] = 0;
      seenCuts = link.cuts;
      group.visible = true;
      matchOn = true;
    },
    update,
    onEvents(events: EventBuffer, _state: ReadonlySimState) {
      if (!matchOn) return;
      for (let i = 0; i < events.count; i++) if (events.get(i).type === EventType.GOAL) triggerFlash();
    },
    warmUp() {
      // Run every effect through the real update() (off screen, a few ms while loading) on a private state: a slide, a
      // hard shot, the ball entering a net and the flash, often enough for the JIT to optimise the whole path; then
      // clear. The first slide, goal or hard shot of a match never hitches and never allocates (section 13 "Warm-up").
      const src = warmSrc;
      warmSrc = null;
      const wasOn = matchOn;
      const keep = cap;
      cap = MAXP;
      matchOn = true;
      if (src) {
        const ws = createSimState(src.config as unknown as MatchConfig, src.squads as unknown as PlayerData[][]);
        const frame: RenderFrame = {
          prev: ws, curr: ws, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
        };
        const it = frame.interp, b = ws.ball;
        for (let i = 0; i < LT.warmUpIterations; i++) {
          const k = i % 120;
          b.owner = -1; b.heldBy = -1; b.shotBy = k < 60 ? 9 : -1;
          b.vx = k < 60 ? 30.5 : 6.5; b.vy = 1.5; b.vz = 0.5;
          b.inNet = k > 100 ? 1 : 0;
          it.ballX = -20 + k * 0.5; it.ballY = 1.25; it.ballZ = 0.5;
          for (let p = 0; p < NUM_SLOTS; p++) {
            const pl = ws.players[p]!;
            pl.active = 1;
            pl.act = p === 3 && k < 50 ? ActionKind.SLIDE_TACKLE : ActionKind.NONE;
            it.x[p] = p * 2.5 - 25; it.z[p] = 1.5; it.vx[p] = 6.5; it.vz[p] = 0.5; it.fx[p] = 1; it.fz[p] = 0;
          }
          if (k === 101) triggerFlash();
          update(frame);
        }
      }
      // The event-time paths (puff, flash) run rarely in update(): exercise them directly as well.
      IO[IO_VX] = 1; IO[IO_VY] = 0.5; IO[IO_VZ] = 0.25;
      IO[IO_PX] = 0.5; IO[IO_PZ] = 0.5; IO[IO_FX] = 1; IO[IO_FZ] = 0; IO[IO_SPEED] = 5.5;
      IO[IO_DT] = IO[IO_FXDT] = 0.016;
      for (let i = 0; i < LT.warmUpIterations; i++) {
        IO[IO_BX] = (i % 40) * 0.5; IO[IO_BY] = 1.5; IO[IO_BZ] = 0.5;
        if ((i & 1) === 0) spawnPuff();
        spawnGrass();
        stepParticles();
        writeParticles();
        if ((i % 40) === 0) tCount = 0;
        stepTrail(true);
        if ((i & 63) === 0) triggerFlash();
        stepFlash();
      }
      cap = keep;
      matchOn = wasOn;
      resetAll();
      lastInNet[0] = 0;
    },
    setQuality(tier: QualityTier) {
      const sc = getTierParams(tier).effectsScale;
      IO[IO_SCALE] = sc;
      cap = particleCapFor(sc);
      if (n > cap) n = cap;
      trailOn = sc >= LT.trailMinScale;
      if (!trailOn) resetTrail();
    },
    clearMatch() {
      resetAll();
      group.visible = false;
      matchOn = false;
      warmSrc = null;
    },
    snapshot(out?: EffectsSnapshot): EffectsSnapshot {
      const o = out ?? snap;
      o.particles = n;
      o.particleCap = cap;
      o.trailPoints = tCount;
      o.trailOn = trailOn;
      o.flash = flash.visible ? uAlpha.value : 0;
      o.drawCalls = (points.visible ? 1 : 0) + (trail.visible ? 1 : 0) + (flash.visible ? 1 : 0);
      return o;
    },
    dispose() {
      ctx.scene.remove(group);
      pGeo.dispose(); pMat.dispose();
      tGeo.dispose(); tMat.dispose();
      flash.geometry.dispose(); fMat.dispose();
      matchOn = false;
      if (typeof window !== 'undefined') {
        const w = window as unknown as { __dotkickEffects?: EffectsModule };
        if (w.__dotkickEffects === module) delete w.__dotkickEffects;
      }
    },
  };

  if (typeof window !== 'undefined') {
    (window as unknown as { __dotkickEffects?: EffectsModule }).__dotkickEffects = module;
  }
  return module;
}
