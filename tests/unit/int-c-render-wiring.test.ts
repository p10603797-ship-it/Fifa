/**
 * [INT-C] Render integration wiring in Node (render/index.ts): GFX-02 tier changes made by the quality module reach
 * every module (QualityHooks.setTier), the Low Power hook records the detector without a second hint path, MSAA only
 * from an explicit QUALITY tier at context creation, WebGL context loss / restore (no drawing while lost, rebuild
 * before the restored notification, contextLost blocks resume), cameraX() for audio panning, and the HUD radar /
 * set-piece framing fixes (ball and taker clear of the bottom-centre radar).
 * There is no WebGL in Node: the renderer core is a fake (GameRendererOptions.createCore) and the scene modules are
 * recording stubs (createModules); cameras, quality and replay are the real modules.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Color, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { HALF_LENGTH, HALF_WIDTH, WORLD_MAX_X } from '../../src/contracts/constants';
import { CameraType, MatchPhase, QualityTier } from '../../src/contracts/enums';
import type { RenderStats } from '../../src/contracts/render';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_CAMERA } from '../../src/contracts/tuning';
import { CLUBS } from '../../src/data/clubs';
import {
  createBroadcastCamera, followX, LOCAL_TUNING as BT, radarZoneMargin, touchZones, type TouchZones,
} from '../../src/render/camera/broadcast';
import { cornerPose, createCinePose, LOCAL_TUNING as CT, takerPose, type CinePose } from '../../src/render/camera/cinematic';
import { crowdLightOf, DAY_LOOK, NIGHT_LOOK } from '../../src/render/stadium';
import { createGameRenderer, fillInterp, msaaAtStart, type DotkickRenderer } from '../../src/render/index';
import { onLowPowerSuspected, resetQualitySession } from '../../src/render/quality';
import type { RebuildReport, RendererCore, RendererCoreOptions } from '../../src/render/renderer';
import { createInterpState, type RenderContext, type RenderFrame, type RenderModule } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

// ------------------------------------------------------------------ fakes

interface FakeThree {
  shadowMap: { enabled: boolean };
  info: { render: { calls: number; triangles: number }; memory: { textures: number; geometries: number } };
  extensions: { has(n: string): boolean };
  domElement: { width: number; height: number };
  draws: number;
  compiles: number;
  render(scene: Scene, camera: PerspectiveCamera): void;
  compile(): void;
  setRenderTarget(): void;
  getRenderTarget(): null;
  clear(): void;
  readRenderTargetPixels(): void;
}

interface FakeCore extends RendererCore {
  log: string[];
  antialias: boolean;
  fireLost(): void;
  fireRestored(): void;
}

function fakeThree(log: string[]): FakeThree {
  return {
    shadowMap: { enabled: false },
    info: { render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } },
    extensions: { has: () => false },
    domElement: { width: 885, height: 615 },
    draws: 0,
    compiles: 0,
    render(scene, camera) {
      this.draws++;
      this.info.render.calls = 12;
      log.push('draw');
      // three.js calls scene.onAfterRender at the end of a draw (GFX-02 measures the frame work with it).
      (scene.onAfterRender as unknown as (...a: unknown[]) => void).call(scene, this, scene, camera, null, null, null);
    },
    compile() { this.compiles++; },
    setRenderTarget() {},
    getRenderTarget() { return null; },
    clear() {},
    readRenderTargetPixels() {},
  };
}

function makeFakeCore(opts: RendererCoreOptions): FakeCore {
  const log: string[] = [];
  const three = fakeThree(log);
  const lostFns: (() => void)[] = [];
  const restoredFns: (() => void)[] = [];
  let lost = false;
  let scale = 0.75;
  const core: FakeCore = {
    log,
    antialias: opts.antialias === true,
    available: true,
    failure: '',
    renderer: three as unknown as WebGLRenderer,
    get lost() { return lost; },
    get scale() { return scale; },
    aspect: 1180 / 820,
    bufferWidth: 885,
    bufferHeight: 615,
    pixelRatio: 0.75,
    lossCount: 0,
    restoreCount: 0,
    resize() { log.push('resize'); },
    setScale(s) { scale = s; },
    onContextLost(fn) { lostFns.push(fn); return () => {}; },
    onContextRestored(fn) { restoredFns.push(fn); return () => {}; },
    readStats(out: RenderStats) { return out; },
    rebuild(): RebuildReport {
      log.push('rebuild');
      return { materials: 3, textures: 2, missingTextures: 0 };
    },
    dispose() {},
    fireLost() {
      lost = true;
      for (const f of lostFns) f();
    },
    fireRestored() {
      lost = false;
      for (const f of restoredFns) f();
    },
  };
  return core;
}

interface Stub extends RenderModule { tiers: QualityTier[]; updates: number }

function stub(): Stub {
  const s: Stub = {
    tiers: [],
    updates: 0,
    update() { s.updates++; },
    setQuality(t) { s.tiers.push(t); },
    dispose() {},
  };
  return s;
}

interface Rig {
  r: DotkickRenderer;
  core: FakeCore;
  stubs: Stub[];
  s: SimState;
  clock: { t: number };
  frame(dtMs: number): void;
}

function rig(settings: Settings = createDefaultSettings()): Rig {
  const clock = { t: 1000 };
  let core: FakeCore | null = null;
  const stubs = [stub(), stub()];
  const r = createGameRenderer({
    createCore: (_c, o) => (core = makeFakeCore(o)),
    createModules: () => stubs,
    quality: { now: () => clock.t, nextFrame: () => Promise.resolve(), hidden: () => false },
  });
  r.init({} as HTMLCanvasElement, settings);
  const s = initMatch(createMatchConfig()) as SimState;
  s.match.phase = MatchPhase.IN_PLAY;
  r.setMatch(s, CLUBS);
  let n = 0;
  return {
    r, core: core!, stubs, s, clock,
    frame(dtMs: number) {
      clock.t += dtMs;
      r.render(s, s, 1, { nowMs: clock.t, dtMs, frame: ++n, ticks: 1, paused: false });
    },
  };
}

afterEach(() => resetQualitySession());

// ------------------------------------------------------------------ quality hooks

describe('INT-C quality wiring (GFX-02 hooks)', () => {
  it('a tier the quality module changes on its own (step down) reaches every module through setTier', () => {
    const st = createDefaultSettings();
    st.graphics.tier = QualityTier.QUALITY;
    const g = rig(st);
    expect(g.r.stats().qualityTier).toBe(QualityTier.QUALITY);
    for (const m of g.stubs) m.tiers.length = 0;
    // 25 fps for 6 s: QUALITY cannot hold 50 fps -> the module steps down by itself (no setQuality call by the app).
    for (let i = 0; i < 150; i++) g.frame(40);
    const applied = g.r.stats().qualityTier;
    expect(applied).toBeLessThan(QualityTier.QUALITY);
    for (const m of g.stubs) {
      expect(m.tiers.length).toBeGreaterThan(0);
      expect(m.tiers[m.tiers.length - 1]).toBe(applied);
    }
    expect((g.core.renderer as unknown as FakeThree).shadowMap.enabled).toBe(false);
  });

  it('setQuality from settings still reaches every module once, resolved', () => {
    const g = rig();
    g.r.setQuality(QualityTier.PERFORMANCE);
    for (const m of g.stubs) expect(m.tiers).toEqual([QualityTier.PERFORMANCE]);
    g.r.setQuality(QualityTier.AUTO); // AUTO before the startup test resolves to BALANCED
    for (const m of g.stubs) expect(m.tiers[1]).toBe(QualityTier.BALANCED);
  });

  it('Low Power: the hook only records the detector; the module-level listener (platform toast path) fires once', () => {
    const g = rig();
    let toasts = 0;
    const off = onLowPowerSuspected(() => { toasts++; });
    try {
      // A steady 30 fps cap with idle frames: the resolution walks down to its floor, then the detector fires.
      for (let i = 0; i < 900 && !g.r.lowPowerSuspected; i++) g.frame(33.3);
      expect(g.r.lowPowerSuspected).toBe(true);
      for (let i = 0; i < 300; i++) g.frame(33.3);
      expect(toasts).toBe(1);
    } finally {
      off();
    }
  });

  it('Low Power: nothing fires once settings.lowPowerHintShown is set', () => {
    const st = createDefaultSettings();
    st.lowPowerHintShown = true;
    const g = rig(st);
    let toasts = 0;
    const off = onLowPowerSuspected(() => { toasts++; });
    try {
      for (let i = 0; i < 900; i++) g.frame(33.3);
      expect(toasts).toBe(0);
      expect(g.r.lowPowerSuspected).toBe(false);
    } finally {
      off();
    }
  });
});

// ------------------------------------------------------------------ MSAA

describe('INT-C MSAA decision (context creation only)', () => {
  it('msaaAtStart: explicit QUALITY only', () => {
    const st = createDefaultSettings();
    for (const [tier, want] of [[QualityTier.AUTO, false], [QualityTier.PERFORMANCE, false], [QualityTier.BALANCED, false], [QualityTier.QUALITY, true]] as const) {
      st.graphics.tier = tier;
      expect(msaaAtStart(st)).toBe(want);
    }
  });

  it('the core is created with antialias for a QUALITY start and never otherwise; switching later does not recreate it', () => {
    const q = createDefaultSettings();
    q.graphics.tier = QualityTier.QUALITY;
    const a = rig(q);
    expect(a.core.antialias).toBe(true);
    expect(a.r.msaa).toBe(true);
    const b = rig();
    expect(b.core.antialias).toBe(false);
    expect(b.r.msaa).toBe(false);
    b.r.setQuality(QualityTier.QUALITY);
    expect(b.r.msaa).toBe(false); // shadow map now, multisampling from the next start
    expect((b.core.renderer as unknown as FakeThree).shadowMap.enabled).toBe(true);
  });

  it('without WebGL2 msaa is false and nothing throws', () => {
    const r = createGameRenderer({
      createCore: () => ({ ...makeFakeCore({}), available: false, renderer: null, failure: 'no webgl2' }),
    });
    const st = createDefaultSettings();
    st.graphics.tier = QualityTier.QUALITY;
    expect(() => r.init({} as HTMLCanvasElement, st)).not.toThrow();
    expect(r.msaa).toBe(false);
    expect(r.contextLost).toBe(false);
  });
});

// ------------------------------------------------------------------ context loss

describe('INT-C WebGL context loss and restore (GFX-01 CRs)', () => {
  it('lost: pause listeners run, contextLost is true and nothing is drawn', () => {
    const g = rig();
    let paused = 0;
    g.r.onContextLost(() => { paused++; });
    g.frame(16.7);
    const three = g.core.renderer as unknown as FakeThree;
    const drawn = three.draws;
    g.core.fireLost();
    expect(paused).toBe(1);
    expect(g.r.contextLost).toBe(true);
    for (let i = 0; i < 5; i++) g.frame(16.7);
    expect(three.draws).toBe(drawn);
  });

  it('restore: modules are rebuilt BEFORE the restored listeners run; contextLost is false only after the rebuild', () => {
    const g = rig();
    const seen: string[] = [];
    g.r.onContextRestored(() => {
      seen.push(`restored lost=${g.r.contextLost} log=${g.core.log.filter((l) => l === 'rebuild' || l === 'resize').join(',')}`);
    });
    g.core.fireLost();
    g.core.log.length = 0;
    g.core.fireRestored();
    expect(seen).toEqual(['restored lost=false log=resize,rebuild']);
    expect(g.r.lastRebuild).toEqual({ materials: 3, textures: 2, missingTextures: 0 });
    const three = g.core.renderer as unknown as FakeThree;
    const before = three.draws;
    g.frame(16.7);
    expect(three.draws).toBe(before + 1);
  });

  it('a restored listener that throws does not stop the others (the error still surfaces)', () => {
    const g = rig();
    const order: number[] = [];
    g.r.onContextRestored(() => { order.push(1); throw new Error('boom'); });
    g.r.onContextRestored(() => { order.push(2); });
    g.core.fireLost();
    expect(() => g.core.fireRestored()).toThrow('boom');
    expect(order).toEqual([1, 2]);
    expect(g.r.contextLost).toBe(false);
  });

  it('warmUp does nothing while the context is lost', async () => {
    const g = rig();
    const three = g.core.renderer as unknown as FakeThree;
    g.core.fireLost();
    const c0 = three.compiles;
    await g.r.warmUp();
    expect(three.compiles).toBe(c0);
  });
});

// ------------------------------------------------------------------ audio camera x

describe('INT-C cameraX() for stereo panning', () => {
  it('follows the broadcast camera along the touchline and stays finite inside the world', () => {
    const g = rig();
    expect(g.r.cameraX()).toBe(0);
    g.s.ball.x = 40; g.s.ball.z = 0; g.s.ball.owner = -1;
    for (let i = 0; i < 300; i++) g.frame(16.7);
    const x = g.r.cameraX();
    expect(Number.isFinite(x)).toBe(true);
    expect(x).toBeGreaterThan(followX(40) - 3);
    expect(x).toBeLessThanOrEqual(WORLD_MAX_X);
    g.s.ball.x = -45;
    for (let i = 0; i < 300; i++) g.frame(16.7);
    expect(g.r.cameraX()).toBeLessThan(followX(-45) + 3);
  });
});

// ------------------------------------------------------------------ framing fixes

function ctxOf(w = 1180, h = 820, settings: Settings = createDefaultSettings()): RenderContext {
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(), settings, clubs: [],
    size: { cssW: w, cssH: h, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
}

/** Screen position (CSS px) of a world point for a cinematic pose (same maths as GFX-15's projector). */
function project(p: CinePose, x: number, y: number, z: number, w: number, h: number): { x: number; y: number } {
  const dx = x - p.x, dy = y - p.y, dz = z - p.z;
  const s = Math.sin(p.yaw), c = Math.cos(p.yaw);
  const fwd = -s * dx - c * dz;
  const right = c * dx - s * dz;
  const depth = fwd * Math.cos(p.pitch) - dy * Math.sin(p.pitch);
  const up = fwd * Math.sin(p.pitch) + dy * Math.cos(p.pitch);
  const t = Math.tan((p.fov * Math.PI) / 360);
  return { x: (0.5 + right / (depth * t * (w / h)) / 2) * w, y: (0.5 - up / (depth * t) / 2) * h };
}

/** Top edge (CSS px) of the HUD radar at the bottom centre (ui/hud/radar.ts geometry, HUD scale 1). */
function radarTop(h: number): number {
  return h - BT.radarBottom - Math.min(BT.radarH, BT.radarMaxVh * h);
}

describe('INT-C framing: ball and taker clear of the HUD radar', () => {
  it('radarZoneMargin covers the bottom-centre radar, fades out to the sides, grows with the larger HUD', () => {
    const z: TouchZones = touchZones(createDefaultSettings(), { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false });
    const centre = radarZoneMargin(590, 1180, 820, z);
    expect(centre).toBeGreaterThan(T_CAMERA.ballBottomMargin);
    expect(centre * 820).toBeGreaterThanOrEqual(820 - radarTop(820));
    expect(radarZoneMargin(150, 1180, 820, z)).toBe(0);
    expect(radarZoneMargin(1030, 1180, 820, z)).toBe(0);
    const big = createDefaultSettings();
    big.accessibility.largerHud = true;
    expect(radarZoneMargin(590, 1180, 820, touchZones(big, z))).toBeGreaterThan(centre);
    // A short 21:9 window: the radar shrinks to its height cap, the zone with it.
    expect(radarZoneMargin(630, 1260, 540, touchZones(createDefaultSettings(), z)) * 540).toBeLessThan(BT.radarMaxVh * 540 + 60);
  });

  it('regression "ball hidden under the HUD radar": a close, zoomed broadcast camera keeps a near-touchline ball above it', () => {
    // Close type, Height and Zoom at 20: the narrowest view, where the bottom margin binds for a ball on the near
    // touchline (the look point follows only part of the ball's z). The lead puts the ball left of centre, over the
    // radar's left half.
    const st = createDefaultSettings();
    st.camera = { type: CameraType.CLOSE, height: 20, zoom: 20 };
    const ctx = ctxOf(1180, 820, st);
    const cam = createBroadcastCamera(ctx);
    const s = initMatch(createMatchConfig()) as SimState;
    s.match.phase = MatchPhase.IN_PLAY;
    cam.setMatch!(s, CLUBS);
    const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
    const out = { x: 0, y: 0 };
    let inColumn = 0;
    for (const bx of [20, 24, 28, 32]) {
      s.ball.x = bx; s.ball.z = HALF_WIDTH - 0.5; s.ball.y = 0.11; s.ball.owner = -1; s.ball.vx = 0; s.ball.vz = 0;
      fillInterp(frame.interp, s, s, 1);
      for (let i = 0; i < 300; i++) { frame.frame.frame++; cam.update(frame); }
      cam.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, out);
      if (Math.abs(out.x - 590) <= BT.radarW / 2 + 10) {
        inColumn++;
        expect(out.y).toBeLessThan(radarTop(820) - 5);
      }
    }
    expect(inColumn).toBeGreaterThan(0);
  });

  it('corner camera: ball at cornerBallY above the radar, taker behind it too, crossbar in view (both ends, both sides)', () => {
    expect(CT.cornerBallY).toBeLessThanOrEqual(0.72);
    const p = createCinePose();
    for (const cx of [-HALF_LENGTH + 0.5, HALF_LENGTH - 0.5]) {
      for (const cz of [-HALF_WIDTH + 0.5, HALF_WIDTH - 0.5]) {
        cornerPose(cx, cz, p);
        const ball = project(p, cx, 0.11, cz, 1180, 820);
        expect(ball.y).toBeLessThan(radarTop(820) - 40);
        // The taker stands ~1 m behind the ball, toward the camera: his feet are lower on screen.
        const l = Math.hypot(p.x - cx, p.z - cz);
        const feet = project(p, cx + ((p.x - cx) / l) * 1, 0, cz + ((p.z - cz) / l) * 1, 1180, 820);
        expect(feet.y).toBeLessThan(radarTop(820));
        const end = cx < 0 ? -1 : 1;
        for (const gz of [-3.66, 3.66]) {
          const bar = project(p, end * HALF_LENGTH, 2.44, gz, 1180, 820);
          expect(bar.y).toBeGreaterThan(0.06 * 820);
          expect(bar.x).toBeGreaterThan(0);
          expect(bar.x).toBeLessThan(1180);
        }
      }
    }
  });

  it('regression "goal kick: the keeper fills the frame and hides the ball": the rig stands off the kick line', () => {
    const p = createCinePose();
    for (const end of [-1, 1]) {
      for (const sz of [-4.58, 4.58]) {
        const sx = end * (HALF_LENGTH - 5.5);
        const aimX = -end * HALF_LENGTH; // up-field
        takerPose(sx, sz, aimX, sz, true, p);
        // [QF-4] The rig now hangs over the goal-line area beside the goal (raised, around the ball); the own goal stays
        // out of view.
        const bar = project(p, end * HALF_LENGTH, 2.44, 0, 1180, 820);
        expect(bar.y > 820 || bar.x < 0 || bar.x > 1180).toBe(true);
        const ball = project(p, sx, 0.11, sz, 1180, 820);
        // The keeper stands ~1.5 m behind the ball on the kick line (between the ball and the goal).
        const taker = project(p, sx + end * 1.5, 1.0, sz, 1180, 820);
        const far = project(p, sx - end * CT.goalKickLook, 0, sz, 1180, 820);
        for (const q of [ball, taker, far]) { expect(q.x).toBeGreaterThan(0); expect(q.x).toBeLessThan(1180); }
        expect(Math.abs(ball.x - taker.x)).toBeGreaterThan(80); // the ball is beside him, not behind his legs
        expect(ball.y).toBeLessThan(radarTop(820));
        expect(far.y).toBeGreaterThan(0.1 * 820);
      }
    }
  });

  it('behind-the-taker camera: the taker behind the ball stays above the radar', () => {
    const p = createCinePose();
    for (const [sx, sz] of [[26, 0], [30, 12], [-28, -9], [41.5, 0]] as const) {
      const aimX = sx > 0 ? HALF_LENGTH : -HALF_LENGTH;
      takerPose(sx, sz, aimX, 0, false, p);
      const l = Math.hypot(p.x - sx, p.z - sz);
      const feet = project(p, sx + ((p.x - sx) / l) * 1.2, 0, sz + ((p.z - sz) / l) * 1.2, 1180, 820);
      expect(feet.y).toBeLessThan(radarTop(820));
      const ball = project(p, sx, 0.11, sz, 1180, 820);
      expect(ball.y).toBeGreaterThan(0.5 * 820);
    }
  });
});

describe('INT-C night look', () => {
  it('regression "night match reads as day": the bowl and crowd are clearly darker than by day, the pitch keeps its key light', () => {
    expect(NIGHT_LOOK.standLight).toBeLessThanOrEqual(0.4);
    const d = crowdLightOf(DAY_LOOK, new Color()), n = crowdLightOf(NIGHT_LOOK, new Color());
    expect(n.r + n.g + n.b).toBeLessThan(0.4 * (d.r + d.g + d.b));
    expect(NIGHT_LOOK.sunIntensity).toBeGreaterThan(0.85 * DAY_LOOK.sunIntensity);
  });
});
