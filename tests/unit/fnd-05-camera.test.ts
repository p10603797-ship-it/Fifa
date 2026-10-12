/**
 * FND-05: broadcast camera readability and projector round trip (THREE maths only, no WebGL).
 * Section 8: "a player at the centre spot is about 6% of the screen height, and roughly 45 m of the pitch length
 * is visible on an iPad" (2360 x 1640 px = 1180 x 820 CSS px).
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { createDefaultSettings } from '../../src/contracts/settings';
import { QualityTier, CameraType } from '../../src/contracts/enums';
import { T_CAMERA } from '../../src/contracts/tuning';
import {
  broadcastRig, createBroadcastCamera, followX, leadFor, smoothDamp, type BroadcastCameraModule,
} from '../../src/render/camera/broadcast';
import type { RenderContext } from '../../src/render/types';
import { createInterpState, type RenderFrame } from '../../src/render/types';
import { fillInterp } from '../../src/render/index';
import { createMatchConfig } from '../../src/contracts/state';
import { initMatch } from '../../src/sim/init';

function makeCtx(cssW = 1180, cssH = 820): RenderContext {
  const settings = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    settings,
    clubs: [],
    size: { cssW, cssH, dpr: 2, scale: 0.75 },
    tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera },
    reducedMotion: false,
    night: false,
  };
}

/** Pitch x where the z = 0 line meets screen column sx (bisection on pitchToScreen). */
function pitchXAtScreenX(cam: BroadcastCameraModule, sx: number): number {
  const p = { x: 0, y: 0 };
  let lo = -150, hi = 150;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    cam.pitchToScreen(mid, 0, 0, p);
    if (p.x < sx) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function readability(cam: BroadcastCameraModule, ctx: RenderContext): { playerFrac: number; visibleLength: number } {
  const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
  expect(cam.pitchToScreen(0, 0, 0, a)).toBe(true);
  expect(cam.pitchToScreen(0, 1.8, 0, b)).toBe(true);
  const playerFrac = (a.y - b.y) / ctx.size.cssH;
  const visibleLength = pitchXAtScreenX(cam, ctx.size.cssW) - pitchXAtScreenX(cam, 0);
  return { playerFrac, visibleLength };
}

describe('FND-05 broadcast camera', () => {
  it('baseline rig matches T_CAMERA (24 m high, 40 m behind the near touchline, 22 deg)', () => {
    const ctx = makeCtx();
    const rig = broadcastRig(ctx.cameraSettings, false, { height: 0, camZ: 0, fovDeg: 0, smoothTime: 0, widenMax: 0 });
    expect(rig.height).toBeCloseTo(T_CAMERA.height, 6);
    expect(rig.camZ).toBeCloseTo(34 + T_CAMERA.distance, 6);
    expect(rig.fovDeg).toBeCloseTo(T_CAMERA.fovDeg, 6);
    expect(rig.smoothTime).toBeCloseTo(T_CAMERA.smoothTime, 6);
    const cam = createBroadcastCamera(ctx);
    cam.snapTo(0, 0.11, 0, 1);
    expect(ctx.camera.position.y).toBeCloseTo(24, 6);
    expect(ctx.camera.position.z).toBeCloseTo(74, 6);
    expect(ctx.camera.fov).toBeCloseTo(22, 6);
  });

  it('readability on an iPad: player ~6% of screen height, ~45 m of pitch length visible at z = 0', () => {
    const ctx = makeCtx(1180, 820);
    const cam = createBroadcastCamera(ctx);
    cam.snapTo(0, 0.11, 0, 1);
    const r = readability(cam, ctx);
    // Report the measured values (used in the FND-05 report / TUNING note).
    console.log(`[FND-05 camera] player ${(r.playerFrac * 100).toFixed(2)}% of screen height, ${r.visibleLength.toFixed(1)} m visible at z = 0`);
    expect(r.playerFrac).toBeGreaterThan(0.05);
    expect(r.playerFrac).toBeLessThan(0.07);
    expect(r.visibleLength).toBeGreaterThan(40);
    expect(r.visibleLength).toBeLessThan(50);
    // Same framing with the lead toward -x.
    cam.snapTo(0, 0.11, 0, -1);
    const r2 = readability(cam, ctx);
    expect(Math.abs(r2.playerFrac - r.playerFrac)).toBeLessThan(0.002);
    expect(Math.abs(r2.visibleLength - r.visibleLength)).toBeLessThan(0.5);
  });

  it('wider screens show more pitch; the vertical framing stays the same', () => {
    const ipad = makeCtx(1180, 820);
    const wide = makeCtx(1640, 820);
    const c1 = createBroadcastCamera(ipad);
    const c2 = createBroadcastCamera(wide);
    c1.snapTo(0, 0.11, 0, 1);
    c2.snapTo(0, 0.11, 0, 1);
    const r1 = readability(c1, ipad), r2 = readability(c2, wide);
    expect(r2.visibleLength).toBeGreaterThan(r1.visibleLength * 1.3);
    expect(r2.playerFrac).toBeCloseTo(r1.playerFrac, 4);
  });

  it('projector round trip screen -> pitch -> screen and pitch -> screen -> pitch', () => {
    const ctx = makeCtx();
    const cam = createBroadcastCamera(ctx);
    cam.snapTo(20, 0.11, -10, 1);
    const p = { x: 0, z: 0 }, s = { x: 0, y: 0 };
    for (const [sx, sy] of [[100, 700], [590, 410], [1100, 300], [10, 810], [600, 120]] as const) {
      expect(cam.screenToPitch(sx, sy, p)).toBe(true);
      expect(cam.pitchToScreen(p.x, 0, p.z, s)).toBe(true);
      expect(s.x).toBeCloseTo(sx, 3);
      expect(s.y).toBeCloseTo(sy, 3);
    }
    for (const [x, z] of [[0, 0], [30, 20], [-10, -30], [45, 5]] as const) {
      expect(cam.pitchToScreen(x, 0, z, s)).toBe(true);
      expect(cam.screenToPitch(s.x, s.y, p)).toBe(true);
      expect(p.x).toBeCloseTo(x, 3);
      expect(p.z).toBeCloseTo(z, 3);
    }
    // Above the horizon misses the ground; points behind the camera do not project.
    expect(cam.screenToPitch(590, -5000, p)).toBe(false);
    expect(cam.pitchToScreen(0, 24, 200, s)).toBe(false);
    expect(cam.stickRotation()).toBe(0);
  });

  it('follows 70% of ball x clamped to +-32 m and keeps the ball above the bottom 15%', () => {
    expect(followX(10)).toBeCloseTo(7, 6);
    expect(followX(52.5)).toBeCloseTo(32, 6);
    expect(followX(-60)).toBeCloseTo(-32, 6);
    expect(leadFor(0)).toBeCloseTo(T_CAMERA.leadMin, 6);
    expect(leadFor(30)).toBeCloseTo(T_CAMERA.leadMax, 6);
    const ctx = makeCtx();
    const cam = createBroadcastCamera(ctx);
    for (const [bx, bz] of [[0, 34], [52, 34], [-52, 34], [0, -34], [40, 0]] as const) {
      cam.snapTo(bx, 0.11, bz, 1);
      expect(ctx.camera.position.x).toBeCloseTo(followX(bx), 6);
      const s = { x: 0, y: 0 };
      expect(cam.pitchToScreen(bx, 0.11, bz, s)).toBe(true);
      expect(s.y).toBeLessThanOrEqual(ctx.size.cssH * (1 - T_CAMERA.ballBottomMargin) + 0.5);
      expect(s.y).toBeGreaterThan(0);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(ctx.size.cssW);
    }
  });

  it('critically damped smoothing converges without overshoot', () => {
    const vel = new Float64Array(1);
    let x = 0;
    let maxX = 0;
    for (let i = 0; i < 120; i++) {
      x = smoothDamp(x, 10, vel, 0, 0.4, 1 / 60);
      maxX = Math.max(maxX, x);
    }
    expect(x).toBeGreaterThan(9.99);
    expect(maxX).toBeLessThanOrEqual(10 + 1e-9);
    // Same result at 120 Hz over the same real time (frame-rate independent within a few cm).
    const v2 = new Float64Array(1);
    let y = 0;
    for (let i = 0; i < 24; i++) y = smoothDamp(y, 10, v2, 0, 0.4, 1 / 120);
    const v3 = new Float64Array(1);
    let z = 0;
    for (let i = 0; i < 12; i++) z = smoothDamp(z, 10, v3, 0, 0.4, 1 / 60);
    expect(Math.abs(y - z)).toBeLessThan(0.1);
  });

  it('camera settings: zoom and type change the FOV, reduced motion disables widening', () => {
    const out = { height: 0, camZ: 0, fovDeg: 0, smoothTime: 0, widenMax: 0 };
    broadcastRig({ type: CameraType.BROADCAST, height: 10, zoom: 20 }, false, out);
    expect(out.fovDeg).toBeLessThan(T_CAMERA.fovDeg);
    broadcastRig({ type: CameraType.WIDE, height: 10, zoom: 10 }, true, out);
    expect(out.fovDeg).toBeGreaterThan(T_CAMERA.fovDeg);
    expect(out.widenMax).toBe(0);
    expect(out.smoothTime).toBeGreaterThan(T_CAMERA.smoothTime);
    broadcastRig({ type: CameraType.BROADCAST, height: 20, zoom: 10 }, false, out);
    expect(out.height).toBeGreaterThan(T_CAMERA.height);
  });

  it('update() tracks the interpolated ball of a real match state without allocating new objects', () => {
    const ctx = makeCtx();
    const cam = createBroadcastCamera(ctx);
    const s = initMatch(createMatchConfig());
    cam.setMatch!(s, []);
    const interp = createInterpState();
    const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 16.7, frame: 0, ticks: 1, paused: false }, interp };
    s.ball.x = 30; s.ball.z = 10;
    fillInterp(interp, s, s, 1);
    for (let i = 0; i < 180; i++) cam.update(frame);
    expect(ctx.camera.position.x).toBeCloseTo(followX(30), 1);
    const p = { x: 0, y: 0 };
    cam.pitchToScreen(30, 0, 10, p);
    expect(Math.abs(p.x - ctx.size.cssW / 2)).toBeLessThan(ctx.size.cssW * 0.12);
  });
});
