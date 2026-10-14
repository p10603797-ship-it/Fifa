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
 * array. warmUp() runs every effect once (shader programs are compiled by the renderer's scene compile).
 */

import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, DynamicDrawUsage, Group, Mesh, MeshBasicMaterial, PlaneGeometry,
  Points, ShaderMaterial,
} from 'three';
import { NUM_SLOTS } from '../contracts/constants';
import { ActionKind, type QualityTier } from '../contracts/enums';
import { EventType, type EventBuffer } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';
import { T_BALL } from '../contracts/tuning';
import { getTierParams } from './quality';
import { replayPlaybackOf } from './replay';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export const LOCAL_TUNING = { // TUNING-CR (GFX-16 effects)
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

// xorshift32 in a typed array (render-only randomness; never boxes).
const RNG = new Uint32Array([0x2545f491]);
function rand(): number {
  let x = RNG[0]!;
  x ^= x << 13; x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5; x >>>= 0;
  RNG[0] = x;
  return x / 4294967296;
}

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
  const uScale = { value: 500.5 };
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
  const uAlpha = { value: 0.5 };
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

  const GRASS = [linear(0x4f8a2e), linear(0x6fa13c), linear(0x3d6e25), linear(0x7a5a35)];
  const PUFF = linear(0xf4f6f8);
  const TRAIL = linear(0xfff6e0);

  // Doubles live in typed arrays (no boxing per frame).
  const F = new Float32Array(4); // 0 flash time left, 1 effects scale
  const slideAcc = new Float32Array(NUM_SLOTS);
  const lastInNet = new Int8Array(1);
  let n = 0;
  let cap = particleCapFor(getTierParams(ctx.tier).effectsScale);
  let trailOn = getTierParams(ctx.tier).effectsScale >= LT.trailMinScale;
  let tHead = 0; // index of the newest trail point
  let tCount = 0;
  let seenCuts = link.cuts;
  let matchOn = false;
  F[1] = getTierParams(ctx.tier).effectsScale;

  function spawn(k: number, x: number, y: number, z: number, vx: number, vy: number, vz: number, lf: number, sz: number,
    r: number, g: number, b: number, a: number): void {
    if (n >= cap) return;
    const i = n++;
    px[i] = x; py[i] = y; pz[i] = z; pvx[i] = vx; pvy[i] = vy; pvz[i] = vz;
    age[i] = 0; life[i] = lf; size0[i] = sz; pr[i] = r; pg[i] = g; pb[i] = b; pa[i] = a; kind[i] = k;
  }

  function spawnPuff(x: number, y: number, z: number, dvx: number, dvy: number, dvz: number): void {
    const l = Math.sqrt(dvx * dvx + dvy * dvy + dvz * dvz);
    const ux = l > 1e-3 ? dvx / l : 0, uy = l > 1e-3 ? dvy / l : 0, uz = l > 1e-3 ? dvz / l : 0;
    const count = Math.max(4, Math.round(LT.puffCount * F[1]!));
    for (let i = 0; i < count; i++) {
      const s = LT.puffSpeed * (0.4 + 0.6 * rand());
      const rx = rand() * 2 - 1, ry = rand() * 2 - 1, rz = rand() * 2 - 1;
      spawn(KIND_PUFF, x, y, z, (ux + rx * 0.8) * s, (uy * 0.5 + ry * 0.6 + 0.2) * s, (uz + rz * 0.8) * s,
        LT.puffLife * (0.7 + 0.3 * rand()), LT.puffSize * (0.7 + 0.6 * rand()), PUFF[0], PUFF[1], PUFF[2], LT.puffAlpha);
    }
  }

  function spawnGrass(x: number, z: number, fx: number, fz: number, speed: number): void {
    const c = GRASS[(rand() * GRASS.length) | 0]!;
    const carry = speed * LT.slideCarry;
    spawn(KIND_GRASS, x + fx * LT.slideFootAhead + (rand() - 0.5) * 0.3, 0.04, z + fz * LT.slideFootAhead + (rand() - 0.5) * 0.3,
      fx * carry + (rand() * 2 - 1) * LT.slideSpread, LT.slideUp * (0.6 + 0.6 * rand()), fz * carry + (rand() * 2 - 1) * LT.slideSpread,
      LT.slideLife * (0.6 + 0.4 * rand()), LT.slideSize * (0.7 + 0.6 * rand()), c[0], c[1], c[2], 1);
  }

  function stepParticles(dt: number): void {
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
    pGeo.setDrawRange(0, n);
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
    points.visible = n > 0;
    // Pixels per metre at 1 m: drawing-buffer height * projection[5] / 2.
    const hPx = ctx.size.cssH * ctx.size.dpr * ctx.size.scale;
    uScale.value = hPx * 0.5 * ctx.camera.projectionMatrix.elements[5]!;
  }

  function resetTrail(): void {
    tCount = 0;
    tHead = 0;
    trail.visible = false;
    tGeo.setDrawRange(0, 0);
  }

  function stepTrail(dt: number, want: boolean, bx: number, by: number, bz: number): void {
    for (let k = 0; k < tCount; k++) hage[(tHead - k + TN) % TN] = hage[(tHead - k + TN) % TN]! + dt;
    while (tCount > 0 && hage[(tHead - tCount + 1 + TN) % TN]! >= LT.trailLife) tCount--;
    if (want) {
      if (tCount > 0) {
        const dx = bx - hx[tHead]!, dy = by - hy[tHead]!, dz = bz - hz[tHead]!;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > LT.trailTeleport * LT.trailTeleport) tCount = 0;
        else if (d2 < LT.trailMinStep * LT.trailMinStep) want = false;
      }
      if (want) {
        tHead = (tHead + 1) % TN;
        hx[tHead] = bx; hy[tHead] = by; hz[tHead] = bz; hage[tHead] = 0;
        if (tCount < TN) tCount++;
      }
    }
    if (tCount < 2) {
      trail.visible = false;
      tGeo.setDrawRange(0, 0);
      return;
    }
    const cx = ctx.camera.position.x, cy = ctx.camera.position.y, cz = ctx.camera.position.z;
    for (let k = 0; k < tCount; k++) {
      const i = (tHead - k + TN) % TN;
      const ia = (tHead - Math.max(0, k - 1) + TN) % TN, ib = (tHead - Math.min(tCount - 1, k + 1) + TN) % TN;
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
      const a = LT.trailAlpha * (1 - u) * (1 - u);
      const c = k * 8;
      tCol[c] = TRAIL[0]; tCol[c + 1] = TRAIL[1]; tCol[c + 2] = TRAIL[2]; tCol[c + 3] = a;
      tCol[c + 4] = TRAIL[0]; tCol[c + 5] = TRAIL[1]; tCol[c + 6] = TRAIL[2]; tCol[c + 7] = a;
    }
    tGeo.setDrawRange(0, (tCount - 1) * 6);
    tPosAttr.needsUpdate = true;
    tColAttr.needsUpdate = true;
    trail.visible = true;
  }

  function triggerFlash(): void {
    F[0] = LT.flashTime;
  }

  function stepFlash(dt: number): void {
    let t = F[0]!;
    if (t > 0) t = Math.max(0, t - dt);
    F[0] = t;
    if (t > 0) {
      const u = t / LT.flashTime; // 1 -> 0
      uAlpha.value = LT.flashPeak * u * u;
      flash.visible = true;
    } else flash.visible = false;
  }

  function resetAll(): void {
    n = 0;
    pGeo.setDrawRange(0, 0);
    points.visible = false;
    resetTrail();
    F[0] = 0;
    flash.visible = false;
    slideAcc.fill(0);
  }

  function update(f: RenderFrame): void {
    if (!matchOn) return;
    const ms = f.frame.dtMs;
    const dt = f.frame.paused || !(ms > 0) ? 0 : Math.min(LT.maxStep, ms / 1000);
    const fxDt = link.playing ? dt * (link.rate > 0 ? link.rate : 1) : dt;
    const s = f.curr, it = f.interp, b = s.ball;
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
      spawnPuff(it.ballX, it.ballY, it.ballZ, b.vx, b.vy, b.vz);
      if (link.playing) triggerFlash();
    }
    lastInNet[0] = inNet;
    // Grass kicked up by slides.
    const rate = LT.slideRate * F[1]!;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || p.act !== ActionKind.SLIDE_TACKLE) { slideAcc[i] = 0; continue; }
      const vx = it.vx[i]!, vz = it.vz[i]!;
      const speed = Math.sqrt(vx * vx + vz * vz);
      if (!(speed >= LT.slideMinSpeed)) { slideAcc[i] = 0; continue; }
      let acc = slideAcc[i]! + rate * fxDt;
      while (acc >= 1) {
        spawnGrass(it.x[i]!, it.z[i]!, it.fx[i]!, it.fz[i]!, speed);
        acc -= 1;
      }
      slideAcc[i] = acc;
    }
    stepParticles(fxDt);
    writeParticles();
    stepTrail(fxDt, trailOn && trailWanted(b), it.ballX, it.ballY, it.ballZ);
    stepFlash(dt);
  }

  const snap: EffectsSnapshot = { particles: 0, particleCap: 0, trailPoints: 0, trailOn: false, flash: 0, drawCalls: 0 };

  const module: EffectsModule = {
    setMatch() {
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
      // Run every effect once (JIT and buffer paths), then clear: the first slide or goal never hitches.
      const keep = cap;
      cap = MAXP;
      spawnPuff(0, 1, 0, 1, 0, 0);
      spawnGrass(0, 0, 1, 0, 5);
      stepParticles(0.016);
      writeParticles();
      tCount = 0;
      stepTrail(0.016, true, 0, 1, 0);
      stepTrail(0.016, true, 0.5, 1, 0);
      triggerFlash();
      stepFlash(0.016);
      cap = keep;
      resetAll();
    },
    setQuality(tier: QualityTier) {
      const sc = getTierParams(tier).effectsScale;
      F[1] = sc;
      cap = particleCapFor(sc);
      if (n > cap) n = cap;
      trailOn = sc >= LT.trailMinScale;
      if (!trailOn) resetTrail();
    },
    clearMatch() {
      resetAll();
      group.visible = false;
      matchOn = false;
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
    },
  };

  if (typeof window !== 'undefined') {
    (window as unknown as { __dotkickEffects?: EffectsModule }).__dotkickEffects = module;
  }
  return module;
}
