/**
 * REVIEW of FND-05 render skeleton (independent reviewer, not the builder). THREE maths only, no WebGL.
 *  - Broadcast camera under MOTION (update(), not snapTo): ball kept above the bottom 15% and out from under the
 *    touch cluster while a fast ball runs to the near touchline / corners, at every camera setting extreme.
 *  - 60 Hz vs 120 Hz: the whole camera (follow, lead, FOV) ends in the same place for the same real time.
 *  - Aspect changes through GameRenderer.resize (4:3 .. 21:9): vertical framing kept, projector round trip holds.
 *  - Renderer lifecycle without WebGL2: render/clearMatch/dispose in any order never throws.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { CameraType, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings, type CameraSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_CAMERA } from '../../src/contracts/tuning';
import { computeClusterLayout } from '../../src/input/touch/attack';
import { createBroadcastCamera, type BroadcastCameraModule } from '../../src/render/camera/broadcast';
import { createGameRenderer, fillInterp } from '../../src/render/index';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

function makeCtx(cssW = 1180, cssH = 820, cam: CameraSettings = createDefaultSettings().camera, reduced = false): RenderContext {
  const settings = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    settings,
    clubs: [],
    size: { cssW, cssH, dpr: 2, scale: 0.75 },
    tier: QualityTier.BALANCED,
    cameraSettings: { ...cam },
    reducedMotion: reduced,
    night: false,
  };
}

interface Sim { s: SimState; frame: RenderFrame }
function simFrame(dtMs: number): Sim {
  const s = initMatch(createMatchConfig()) as SimState;
  const interp = createInterpState();
  const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs, frame: 0, ticks: 1, paused: false }, interp };
  return { s, frame };
}

/** Move the ball (loose, rolling) and push one camera frame. */
function step(cam: BroadcastCameraModule, sim: Sim, x: number, y: number, z: number, vx: number, vz: number): void {
  const b = sim.s.ball;
  b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = 0; b.vz = vz; b.owner = -1; b.heldBy = -1;
  fillInterp(sim.frame.interp, sim.s, sim.s, 1);
  cam.update(sim.frame);
}

describe('REVIEW FND-05 broadcast camera under motion', () => {
  const settingsSweep: [string, CameraSettings, boolean][] = [
    ['default', { type: CameraType.BROADCAST, height: 10, zoom: 10 }, false],
    ['low + zoomed in', { type: CameraType.BROADCAST, height: 0, zoom: 20 }, false],
    ['high + zoomed out', { type: CameraType.BROADCAST, height: 20, zoom: 0 }, false],
    ['close', { type: CameraType.CLOSE, height: 10, zoom: 10 }, false],
    ['wide, reduced motion', { type: CameraType.WIDE, height: 10, zoom: 10 }, true],
  ];
  // A fast ball (25 m/s) run from midfield to the near touchline and on to each near corner, sampled every frame.
  const paths: [string, [number, number, number][]][] = [
    ['to the near touchline', [[0, 0.11, 0], [0, 0.11, 34]]],
    ['to the near right corner', [[0, 0.11, 0], [52.5, 0.11, 34]]],
    ['to the near left corner', [[0, 0.11, 0], [-52.5, 0.11, 34]]],
    ['along the near touchline', [[-50, 0.11, 33.5], [50, 0.11, 33.5]]],
  ];

  for (const [name, cs, reduced] of settingsSweep) {
    it(`ball never in the bottom 15% while moving (${name})`, () => {
      const ctx = makeCtx(1180, 820, cs, reduced);
      const cam = createBroadcastCamera(ctx);
      const p = { x: 0, y: 0 };
      let worst = 0;
      for (const [, pts] of paths) {
        const sim = simFrame(1000 / 60);
        const [a, b] = pts as [[number, number, number], [number, number, number]];
        cam.snapTo(a[0], a[1], a[2], 1);
        const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
        const n = Math.ceil((len / 25) * 60);
        const vx = ((b[0] - a[0]) / len) * 25, vz = ((b[2] - a[2]) / len) * 25;
        for (let i = 0; i <= n + 60; i++) {
          const k = Math.min(1, i / n);
          const moving = i < n;
          step(cam, sim, a[0] + (b[0] - a[0]) * k, 0.11, a[2] + (b[2] - a[2]) * k, moving ? vx : 0, moving ? vz : 0);
          if (cam.pitchToScreen(sim.s.ball.x, 0.11, sim.s.ball.z, p)) worst = Math.max(worst, p.y / ctx.size.cssH);
        }
      }
      expect(worst).toBeLessThanOrEqual(1 - T_CAMERA.ballBottomMargin + 0.002);
    });
  }

  it('the ball never sits under the touch button cluster while moving (default camera, iPad)', () => {
    const ctx = makeCtx();
    const cam = createBroadcastCamera(ctx);
    const layout = computeClusterLayout(1180, 820, { top: 0, right: 0, bottom: 0, left: 0 });
    const p = { x: 0, y: 0 };
    let hits = 0;
    for (const [, pts] of paths) {
      const sim = simFrame(1000 / 60);
      const [a, b] = pts as [[number, number, number], [number, number, number]];
      cam.snapTo(a[0], a[1], a[2], 1);
      const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
      const n = Math.ceil((len / 25) * 60);
      for (let i = 0; i <= n + 60; i++) {
        const k = Math.min(1, i / n);
        step(cam, sim, a[0] + (b[0] - a[0]) * k, 0.11, a[2] + (b[2] - a[2]) * k, 0, 0);
        if (!cam.pitchToScreen(sim.s.ball.x, 0.11, sim.s.ball.z, p)) continue;
        for (const g of layout.slots) if (Math.hypot(p.x - g.cx, p.y - g.cy) < g.r) hits++;
      }
    }
    expect(hits).toBe(0);
  });

  it('60 Hz and 120 Hz give the same camera after the same real time (follow + lead + FOV, moving ball)', () => {
    const run = (hz: number): { x: number; lookX: number; lookZ: number; fov: number } => {
      const ctx = makeCtx();
      const cam = createBroadcastCamera(ctx);
      const sim = simFrame(1000 / hz);
      cam.snapTo(0, 0.11, 0, 1);
      const frames = hz * 2;
      for (let i = 1; i <= frames; i++) {
        const t = i / hz;
        // Ball rolls at 18 m/s toward +x then is lofted (y up to 9 m) - exercises lead and FOV widening.
        const x = Math.min(40, 18 * t);
        const y = t > 1 ? 0.11 + 9 * Math.sin(Math.min(1, t - 1) * Math.PI) : 0.11;
        step(cam, sim, x, y, 10 * t / 2, x < 40 ? 18 : 0, 5);
      }
      return { x: ctx.camera.position.x, lookX: cam.lookX, lookZ: cam.lookZ, fov: ctx.camera.fov };
    };
    const a = run(60), b = run(120);
    expect(Math.abs(a.x - b.x)).toBeLessThan(0.1);
    expect(Math.abs(a.lookX - b.lookX)).toBeLessThan(0.1);
    expect(Math.abs(a.lookZ - b.lookZ)).toBeLessThan(0.1);
    expect(Math.abs(a.fov - b.fov)).toBeLessThan(0.05);
  });

  it('camera stays finite with zero-length frames (paused redraw) and a 100 ms hitch', () => {
    const ctx = makeCtx();
    const cam = createBroadcastCamera(ctx);
    const sim = simFrame(0);
    for (let i = 0; i < 10; i++) step(cam, sim, 20, 0.11, 5, 0, 0);
    sim.frame.frame.dtMs = 100;
    for (let i = 0; i < 10; i++) step(cam, sim, 20, 0.11, 5, 0, 0);
    expect(Number.isFinite(ctx.camera.position.x)).toBe(true);
    expect(Number.isFinite(cam.lookX)).toBe(true);
    expect(Number.isFinite(ctx.camera.fov)).toBe(true);
  });
});

describe('REVIEW FND-05 GameRenderer resize and projector (no WebGL)', () => {
  function frac(r: ReturnType<typeof createGameRenderer>, h: number): number {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    r.projector.pitchToScreen(0, 0, 0, a);
    r.projector.pitchToScreen(0, 1.8, 0, b);
    return (a.y - b.y) / h;
  }

  it('4:3 .. 21:9 windows keep the vertical framing; the projector round-trips after every resize', () => {
    const r = createGameRenderer();
    r.resize(1180, 820, 2);
    const ipad = frac(r, 820);
    expect(ipad).toBeGreaterThan(0.054); // "about 6%" (+-10%)
    expect(ipad).toBeLessThan(0.066);
    const p = { x: 0, z: 0 }, s = { x: 0, y: 0 };
    for (const [w, h] of [[1024, 768], [1366, 1024], [1600, 686], [2560, 1080], [560, 320], [1180, 820]] as const) {
      r.resize(w, h, 1);
      expect(Math.abs(frac(r, h) - ipad)).toBeLessThan(0.002);
      for (const [x, z] of [[0, 0], [-30, 25], [40, -20]] as const) {
        expect(r.projector.pitchToScreen(x, 0, z, s)).toBe(true);
        expect(r.projector.screenToPitch(s.x, s.y, p)).toBe(true);
        expect(p.x).toBeCloseTo(x, 2);
        expect(p.z).toBeCloseTo(z, 2);
      }
      // Centre spot stays on screen.
      r.projector.pitchToScreen(0, 0, 0, s);
      expect(s.x).toBeGreaterThan(0);
      expect(s.x).toBeLessThan(w);
      expect(s.y).toBeGreaterThan(0);
      expect(s.y).toBeLessThan(h);
    }
    r.dispose();
  });

  it('render/clearMatch/setMatch/dispose in any order never throw without WebGL2', () => {
    const r = createGameRenderer();
    const s = initMatch(createMatchConfig()) as SimState;
    const info = { nowMs: 0, dtMs: 16, frame: 1, ticks: 1, paused: false };
    expect(() => {
      r.render(s, s, 0.5, info); // before init
      r.clearMatch();
      r.stopReplay();
      expect(r.startReplay(5)).toBe(false);
      r.dispose();
      r.dispose(); // twice
      r.render(s, s, 0.5, info); // after dispose
      r.resize(800, 600, 1);
    }).not.toThrow();
    expect(r.stats().drawCalls).toBe(0);
  });
});
