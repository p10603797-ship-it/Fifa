/**
 * [GFX-14] Main broadcast camera: readability numbers, follow clamp, turn toward goal, lead direction, framing limits
 * (bottom 15%, touch controls, top, sides) across ball positions / settings / aspects, high balls, restarts, End to End
 * camera + stick rotation, settings sliders, projector round trip, frame-rate independence, robustness, and the
 * section 14 Camera glitch regressions (jitter, snapping at restarts, losing a high ball, dipping below ground or into
 * the stand, ball hidden under touch controls). THREE maths only, no WebGL.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { CameraType, ControllerKind, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings, type CameraSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_BALL, T_CAMERA } from '../../src/contracts/tuning';
import { screenToPitchAxes } from '../../src/input/axes';
import { computeClusterLayout } from '../../src/input/touch/attack';
import {
  LOCAL_TUNING, broadcastRig, cameraEnvelope, createBroadcastCamera, endToEndCamX, followX, leadFor, predictApexY,
  softBand, touchZoneMargin, touchZones, type BroadcastCameraModule, type BroadcastRig, type CameraEnvelope, type TouchZones,
} from '../../src/render/camera/broadcast';
import { projectPitchToScreen, projectScreenToPitch } from '../../src/render/camera/project';
import { createGameRenderer, fillInterp } from '../../src/render/index';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const DEG = Math.PI / 180;
const LIMIT_BOTTOM = 1 - T_CAMERA.ballBottomMargin;
const TYPES = [CameraType.BROADCAST, CameraType.WIDE, CameraType.CLOSE, CameraType.END_TO_END] as const;
const SIDE_TYPES = [CameraType.BROADCAST, CameraType.WIDE, CameraType.CLOSE] as const;

function makeCtx(cssW = 1180, cssH = 820, cs?: Partial<CameraSettings>, reduced = false, settings?: Settings): RenderContext {
  const st = settings ?? createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    settings: st,
    clubs: [],
    size: { cssW, cssH, dpr: 2, scale: 0.75 },
    tier: QualityTier.BALANCED,
    cameraSettings: { type: CameraType.BROADCAST, height: 10, zoom: 10, ...cs },
    reducedMotion: reduced,
    night: false,
  };
}

interface Rig { ctx: RenderContext; cam: BroadcastCameraModule; s: SimState; frame: RenderFrame }

function makeRig(cssW = 1180, cssH = 820, cs?: Partial<CameraSettings>, reduced = false, settings?: Settings, humans = 1): Rig {
  const ctx = makeCtx(cssW, cssH, cs, reduced, settings);
  const cam = createBroadcastCamera(ctx);
  const cfg = createMatchConfig();
  if (humans === 0) cfg.humans = [{ ...cfg.humans[0]!, kind: ControllerKind.NONE, side: -1 }, { ...cfg.humans[1]! }];
  const s = initMatch(cfg) as SimState;
  s.match.phase = MatchPhase.IN_PLAY;
  const frame: RenderFrame = {
    prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState(),
  };
  return { ctx, cam, s, frame };
}

/** Put the ball (loose unless owner given) and push one camera frame. */
function step(r: Rig, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, owner = -1, dtMs = 1000 / 60, ticks = 1): void {
  const b = r.s.ball;
  b.x = x; b.y = y; b.z = z; b.vx = vx; b.vy = vy; b.vz = vz; b.owner = owner; b.heldBy = -1;
  fillInterp(r.frame.interp, r.s, r.s, 1);
  r.frame.frame.dtMs = dtMs;
  r.frame.frame.ticks = ticks;
  r.frame.frame.frame++;
  r.cam.update(r.frame);
}

function settle(r: Rig, x: number, y: number, z: number, owner = -1, frames = 240): void {
  for (let i = 0; i < frames; i++) step(r, x, y, z, 0, 0, 0, owner);
}

const scr = { x: 0, y: 0 };
function screenOf(r: Rig, x: number, y: number, z: number): { x: number; y: number; ok: boolean } {
  const ok = r.cam.pitchToScreen(x, y, z, scr);
  return { x: scr.x, y: scr.y, ok };
}

/** Pitch x where the ground line at z meets screen column sx (bisection). */
function pitchXAtScreenX(cam: BroadcastCameraModule, sx: number, z: number): number {
  const p = { x: 0, y: 0 };
  let lo = -300, hi = 300;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    cam.pitchToScreen(mid, 0, z, p);
    if (p.x < sx) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

function readability(r: Rig, bx = 0, bz = 0): { playerFrac: number; visibleLength: number } {
  const a = screenOf(r, bx, 0, bz), b = screenOf(r, bx, 1.8, bz);
  return {
    playerFrac: (a.y - b.y) / r.ctx.size.cssH,
    visibleLength: pitchXAtScreenX(r.cam, r.ctx.size.cssW, bz) - pitchXAtScreenX(r.cam, 0, bz),
  };
}

/** Forward unit vector of ctx.camera. */
const fwd = new Vector3();
function forwardOf(r: Rig): Vector3 { return r.ctx.camera.getWorldDirection(fwd); }

/** Touch geometry the ball must avoid: real cluster circles (input/touch/attack.ts) and the stick rest box. */
function touchHit(r: Rig, sx: number, sy: number): string {
  const t = r.ctx.settings.controls.touch;
  const W = r.ctx.size.cssW, H = r.ctx.size.cssH;
  const layout = computeClusterLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 }, { spacing: t.spacing, mirror: t.mirror });
  for (const g of layout.slots) if (Math.hypot(sx - g.cx, sy - g.cy) < g.r + 4) return `cluster button at (${g.cx.toFixed(0)}, ${g.cy.toFixed(0)})`;
  const inStickCols = t.mirror ? sx > W - LOCAL_TUNING.stickZoneW : sx < LOCAL_TUNING.stickZoneW;
  if (inStickCols && sy > H - LOCAL_TUNING.stickZoneH) return 'stick zone';
  return '';
}

function framingError(r: Rig, x: number, y: number, z: number): string {
  const p = screenOf(r, x, y, z);
  const W = r.ctx.size.cssW, H = r.ctx.size.cssH;
  if (!p.ok) return 'behind camera';
  if (p.y > H * LIMIT_BOTTOM + 0.5) return `bottom margin (y ${(p.y / H).toFixed(3)})`;
  if (p.y < H * LOCAL_TUNING.ballTopMargin - 0.5) return `top margin (y ${(p.y / H).toFixed(3)})`;
  if (p.x < W * LOCAL_TUNING.ballSideMargin - 0.5 || p.x > W * (1 - LOCAL_TUNING.ballSideMargin) + 0.5) return `side margin (x ${(p.x / W).toFixed(3)})`;
  const hit = touchHit(r, p.x, p.y);
  return hit ? `under touch control: ${hit}` : '';
}

/** One step of a ball flight with gravity and quadratic drag (render test double of the sim flight). */
function flightStep(b: { x: number; y: number; z: number; vx: number; vy: number; vz: number }, dt: number): void {
  const v = Math.hypot(b.vx, b.vy, b.vz);
  const k = T_BALL.dragK * v;
  b.vx -= k * b.vx * dt;
  b.vz -= k * b.vz * dt;
  b.vy -= (T_BALL.gravity + k * b.vy) * dt;
  b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
  if (b.y < 0.11) { b.y = 0.11; b.vy = Math.abs(b.vy) * 0.5 < 1 ? 0 : Math.abs(b.vy) * 0.5; }
}

// ---------------------------------------------------------------------------------------------------- readability

describe('GFX-14 readability (section 8: player ~6% of screen height, ~45 m of pitch length visible on an iPad)', () => {
  it('measures the default broadcast camera on an iPad (1180 x 820 CSS px) and reports the values', () => {
    const r = makeRig(1180, 820);
    r.cam.snapTo(0, 0.11, 0, 1);
    const m = readability(r);
    // Settled with play: the same numbers after the camera follows a still ball at the centre spot.
    const r2 = makeRig(1180, 820);
    settle(r2, 0, 0.11, 0);
    const m2 = readability(r2);
    console.log(`[GFX-14 readability] iPad broadcast: player at centre spot ${(m.playerFrac * 100).toFixed(2)}% of screen height, `
      + `${m.visibleLength.toFixed(1)} m of pitch length visible along z = 0 (settled ${(m2.playerFrac * 100).toFixed(2)}%, ${m2.visibleLength.toFixed(1)} m)`);
    expect(m.playerFrac).toBeGreaterThan(0.054);
    expect(m.playerFrac).toBeLessThan(0.066);
    expect(m.visibleLength).toBeGreaterThan(40.5);
    expect(m.visibleLength).toBeLessThan(49.5);
    expect(Math.abs(m2.playerFrac - m.playerFrac)).toBeLessThan(0.002);
    expect(Math.abs(m2.visibleLength - m.visibleLength)).toBeLessThan(1);
  });

  it('reports every camera type; Wide shows more pitch than Broadcast, Close less; End to End player size is readable', () => {
    const vis: number[] = [];
    for (const type of TYPES) {
      const r = makeRig(1180, 820, { type });
      r.cam.snapTo(0, 0.11, 0, 1);
      const m = readability(r);
      vis[type] = m.visibleLength;
      console.log(`[GFX-14 readability] ${CameraType[type]}: player ${(m.playerFrac * 100).toFixed(2)}% of screen height`
        + (type === CameraType.END_TO_END ? ' (at the ball)' : `, ${m.visibleLength.toFixed(1)} m visible`));
      expect(m.playerFrac).toBeGreaterThan(0.035);
      expect(m.playerFrac).toBeLessThan(0.1);
    }
    expect(vis[CameraType.WIDE]!).toBeGreaterThan(vis[CameraType.BROADCAST]! * 1.2);
    expect(vis[CameraType.CLOSE]!).toBeLessThan(vis[CameraType.BROADCAST]! * 0.85);
  });

  it('wider screens show more pitch; narrower windows keep the vertical framing and lose width', () => {
    const base = makeRig(1180, 820);
    base.cam.snapTo(0, 0.11, 0, 1);
    const ipad = readability(base);
    for (const [w, h] of [[1640, 820], [2560, 1080], [1024, 768], [900, 820], [560, 320]] as const) {
      const r = makeRig(w, h);
      r.cam.snapTo(0, 0.11, 0, 1);
      const m = readability(r);
      expect(Math.abs(m.playerFrac - ipad.playerFrac), `${w}x${h}`).toBeLessThan(0.002);
      const ratio = (w / h) / (1180 / 820);
      expect(m.visibleLength / ipad.visibleLength, `${w}x${h}`).toBeGreaterThan(ratio * 0.9);
      expect(m.visibleLength / ipad.visibleLength, `${w}x${h}`).toBeLessThan(ratio * 1.12);
    }
  });
});

// ---------------------------------------------------------------------------------------------------- follow / turn / lead

describe('GFX-14 follow, turn toward goal, lead', () => {
  it('slides along the touchline at 70% of the ball x, clamped to +-32 m; height and distance stay fixed', () => {
    expect(followX(10)).toBeCloseTo(7, 9);
    expect(followX(-20)).toBeCloseTo(-14, 9);
    expect(followX(52.5)).toBe(32);
    expect(followX(-60)).toBe(-32);
    for (const type of SIDE_TYPES) {
      const r = makeRig(1180, 820, { type });
      for (const x of [-60, -45.7, -30, -10, 0, 12, 33, 45.71, 52.5, 61]) {
        settle(r, x, 0.11, 5, -1, 300);
        const p = r.ctx.camera.position;
        expect(p.x, `${CameraType[type]} ball x ${x}`).toBeCloseTo(followX(x), 3);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(T_CAMERA.followClamp + 1e-9);
        expect(p.y).toBeCloseTo(r.cam.rig.height, 9);
        expect(p.z).toBeCloseTo(r.cam.rig.camZ, 9);
      }
    }
  });

  it('square-on at midfield, angled toward the goal near either penalty area (goal mouth in view)', () => {
    const r = makeRig();
    settle(r, 0, 0.11, 0, 9); // home player in possession (attacks +x)
    expect(Math.abs(r.cam.yaw) / DEG).toBeLessThan(5);
    const f0 = forwardOf(r);
    expect(Math.abs(f0.x)).toBeLessThan(Math.sin(5 * DEG));
    for (const dir of [1, -1]) {
      settle(r, dir * 40, 0.11, 8, dir > 0 ? 9 : 20, 300);
      const f = forwardOf(r);
      expect(f.x * dir, `toward ${dir > 0 ? '+x' : '-x'} goal`).toBeGreaterThan(Math.sin(10 * DEG));
      const g = screenOf(r, dir * HALF_LENGTH, 1.2, 0);
      expect(g.ok).toBe(true);
      expect(g.x).toBeGreaterThan(0);
      expect(g.x).toBeLessThan(r.ctx.size.cssW);
      expect(g.y).toBeGreaterThan(0);
      expect(g.y).toBeLessThan(r.ctx.size.cssH);
    }
  });

  it('leads the ball by 3-6 m in the direction of play (possession, restart team, loose ball travel)', () => {
    expect(leadFor(0)).toBe(T_CAMERA.leadMin);
    expect(leadFor(5)).toBeCloseTo((T_CAMERA.leadMin + T_CAMERA.leadMax) / 2, 9);
    expect(leadFor(40)).toBe(T_CAMERA.leadMax);
    expect(leadFor(Number.NaN)).toBe(T_CAMERA.leadMin);
    const r = makeRig();
    // Home (dir +1) in possession, still ball: lead +3 m.
    settle(r, 0, 0.11, 0, 9);
    expect(r.cam.lookX - 0).toBeCloseTo(T_CAMERA.leadMin, 1);
    // Away (dir -1) in possession: the lead swaps to -x.
    settle(r, 0, 0.11, 0, 20, 300);
    expect(r.cam.lookX).toBeCloseTo(-T_CAMERA.leadMin, 1);
    // Dribbling at 10 m/s toward +x with home in possession: lead grows to 6 m (look point ahead of the ball).
    let x = -30;
    for (let i = 0; i < 360; i++) { x += 10 / 60; step(r, x, 0.11, 0, 10, 0, 0, 9); }
    expect(r.cam.lead).toBeGreaterThan(T_CAMERA.leadMax - 0.05);
    expect(r.cam.lead).toBeLessThanOrEqual(T_CAMERA.leadMax + 1e-9);
    // Loose ball travelling fast toward -x: the lead follows the ball's travel.
    for (let i = 0; i < 360; i++) { x -= 20 / 60; step(r, x, 0.11, 0, -20, 0, 0, -1); }
    expect(r.cam.lead).toBeLessThan(-T_CAMERA.leadMax + 0.05);
    // Restart phase: the restart team's attack direction (away, -x) even with the ball not owned.
    r.s.match.phase = MatchPhase.GOAL_KICK;
    r.s.match.restart.team = 0;
    settle(r, -47, 0.11, 0, -1, 300);
    expect(r.cam.lead).toBeCloseTo(T_CAMERA.leadMin, 2);
  });

  it('possession ping-pong shorter than the dwell never swings the lead to the other side', () => {
    const r = makeRig();
    settle(r, 0, 0.11, 0, 9);
    let minLead = Infinity;
    for (let i = 0; i < 360; i++) {
      const owner = Math.floor(i / 12) % 2 === 0 ? 9 : 20; // 0.2 s each (< dwell)
      step(r, 0, 0.11, 0, 0, 0, 0, owner);
      minLead = Math.min(minLead, r.cam.lead);
    }
    expect(minLead).toBeGreaterThan(T_CAMERA.leadMin - 0.01);
  });
});

// ---------------------------------------------------------------------------------------------------- framing limits

describe('GFX-14 framing limits across ball positions, settings and aspects', () => {
  it('soft band is C1, strictly inside the limits, identity in the middle', () => {
    const lo = -1, hi = 1, k = 0.2;
    expect(softBand(0, lo, hi, k)).toBe(0);
    expect(softBand(0.79, lo, hi, k)).toBe(0.79);
    for (const v of [-3, -1, -0.81, 0.81, 1, 3]) {
      const y = softBand(v, lo, hi, k);
      expect(y).toBeGreaterThan(lo);
      expect(y).toBeLessThan(hi);
    }
    // Far outside it saturates at the limit (floating point), never beyond.
    for (const v of [-1e6, -50, 50, 1e6]) {
      const y = softBand(v, lo, hi, k);
      expect(y).toBeGreaterThanOrEqual(lo);
      expect(y).toBeLessThanOrEqual(hi);
    }
    const e = 1e-6;
    for (const edge of [lo + k, hi - k]) {
      expect(softBand(edge - e, lo, hi, k)).toBeCloseTo(softBand(edge + e, lo, hi, k), 5);
      const d1 = (softBand(edge - e, lo, hi, k) - softBand(edge - 2 * e, lo, hi, k)) / e;
      expect(d1).toBeCloseTo(1, 3);
    }
  });

  it('static balls everywhere (on and off the pitch): above the bottom 15%, clear of the touch controls, inside top and sides', () => {
    const sliders: [number, number][] = [[10, 10], [0, 0], [20, 20], [0, 20], [20, 0]];
    const aspects: [number, number][] = [[1180, 820], [1024, 768], [1600, 686], [2560, 1080], [820, 1180]];
    let checked = 0;
    const fails: string[] = [];
    for (const type of TYPES) {
      for (const [height, zoom] of sliders) {
        for (const [w, h] of aspects) {
          const r = makeRig(w, h, { type, height, zoom });
          for (let x = -56; x <= 56; x += 8) {
            for (let z = -38; z <= 38; z += 7.6) {
              r.cam.snapTo(x, 0.11, z, x >= 0 ? 1 : -1);
              step(r, x, 0.11, z);
              const err = framingError(r, x, 0.11, z);
              checked++;
              if (err && fails.length < 10) fails.push(`${CameraType[type]} h${height} z${zoom} ${w}x${h} ball (${x}, ${z.toFixed(1)}): ${err}`);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(9000);
    expect(fails).toEqual([]);
  });

  it('touch zones follow the controls settings: spacing, button scale and mirroring', () => {
    const z: TouchZones = { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false };
    const def = createDefaultSettings();
    touchZones(def, z);
    // Covers the real default cluster (computeClusterLayout) plus the pad.
    const lay = computeClusterLayout(1180, 820, { top: 0, right: 0, bottom: 0, left: 0 });
    let top = Infinity, left = Infinity;
    for (const g of lay.slots) { top = Math.min(top, g.cy - g.r); left = Math.min(left, g.cx - g.r); }
    expect(820 - z.clusterH).toBeLessThanOrEqual(top - LOCAL_TUNING.zonePad + 1e-6);
    expect(1180 - z.clusterW).toBeLessThanOrEqual(left - LOCAL_TUNING.zonePad + 1e-6);
    const base = z.clusterH;
    const wide = createDefaultSettings();
    wide.controls.touch.spacing = 1.6;
    expect(touchZones(wide, z).clusterH).toBeGreaterThan(base);
    const big = createDefaultSettings();
    big.controls.touch.layout = { '3': { dx: 40, dy: 300, scale: 1.4 } };
    expect(touchZones(big, z).clusterH).toBeGreaterThanOrEqual(300 + 96 * 1.4);
    const mir = createDefaultSettings();
    mir.controls.touch.mirror = true;
    touchZones(mir, z);
    expect(z.mirror).toBe(true);
    // Margins: full inside the zone columns, zero in the middle, smooth ramps, mirrored.
    touchZones(def, z);
    expect(touchZoneMargin(1170, 1180, 820, z)).toBeCloseTo(z.clusterH / 820, 9);
    expect(touchZoneMargin(10, 1180, 820, z)).toBeCloseTo(z.stickH / 820, 9);
    expect(touchZoneMargin(590, 1180, 820, z)).toBe(0);
    z.mirror = true;
    expect(touchZoneMargin(10, 1180, 820, z)).toBeCloseTo(z.clusterH / 820, 9);
    expect(touchZoneMargin(1170, 1180, 820, z)).toBeCloseTo(z.stickH / 820, 9);
    z.mirror = false;
    let prev = touchZoneMargin(600, 1180, 820, z);
    for (let sx = 600; sx <= 1180; sx += 2) {
      const m = touchZoneMargin(sx, 1180, 820, z);
      expect(m).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(m - prev).toBeLessThan(0.02);
      prev = m;
    }
    // Never more than zoneMaxFrac of a short window.
    expect(touchZoneMargin(1170, 1180, 300, z)).toBeLessThanOrEqual(LOCAL_TUNING.zoneMaxFrac);
  });

  it('a ball near the centre needs no correction: the final pose looks at the smoothed look point', () => {
    const r = makeRig();
    r.cam.snapTo(5, 0.11, -6, 1);
    const p = new Vector3();
    // Ray through the screen centre hits the ground at the look point.
    const out = { x: 0, z: 0 };
    expect(r.cam.screenToPitch(590, 410, out)).toBe(true);
    expect(out.x).toBeCloseTo(r.cam.lookX, 6);
    expect(out.z).toBeCloseTo(r.cam.lookZ, 6);
    expect(r.cam.tilt).toBe(0);
    p.set(0, 0, 0);
  });
});

// ---------------------------------------------------------------------------------------------------- projector + E2E

describe('GFX-14 projector and End to End camera', () => {
  it('projector round trip screen -> pitch -> screen and pitch -> screen -> pitch for every type', () => {
    for (const type of TYPES) {
      for (const humSide of [0, 1]) {
        const r = makeRig(1180, 820, { type });
        r.s.ctrl[0]!.side = humSide;
        settle(r, 15, 0.11, -8, -1, 30);
        const p = { x: 0, z: 0 }, s = { x: 0, y: 0 };
        for (const [sx, sy] of [[100, 700], [590, 410], [1100, 300], [10, 810], [600, 200]] as const) {
          expect(r.cam.screenToPitch(sx, sy, p), `${CameraType[type]} (${sx}, ${sy})`).toBe(true);
          expect(r.cam.pitchToScreen(p.x, 0, p.z, s)).toBe(true);
          expect(s.x).toBeCloseTo(sx, 3);
          expect(s.y).toBeCloseTo(sy, 3);
        }
        for (const [x, z] of [[15, -8], [25, 0], [5, -20], [20, 5]] as const) {
          expect(r.cam.pitchToScreen(x, 0, z, s)).toBe(true);
          expect(r.cam.screenToPitch(s.x, s.y, p)).toBe(true);
          expect(p.x).toBeCloseTo(x, 3);
          expect(p.z).toBeCloseTo(z, 3);
        }
        // Above the horizon misses the ground.
        expect(r.cam.screenToPitch(590, -5000, p)).toBe(false);
      }
    }
  });

  it('the projector matches the shared project.ts maths exactly (ctx.camera matrices)', () => {
    for (const type of TYPES) {
      const r = makeRig(1024, 768, { type });
      settle(r, -25, 6, 12, -1, 20);
      const a = { x: 0, y: 0 }, b = { x: 0, y: 0 }, pa = { x: 0, z: 0 }, pb = { x: 0, z: 0 };
      for (const [x, y, z] of [[-25, 6, 12], [0, 0, 0], [40, 2, -30], [-60, 0, 44], [0, 30, 80], [0, 24, 300]] as const) {
        const okA = r.cam.pitchToScreen(x, y, z, a), okB = projectPitchToScreen(r.ctx.camera, 1024, 768, x, y, z, b);
        expect(okA).toBe(okB);
        if (okA) { expect(a.x).toBeCloseTo(b.x, 6); expect(a.y).toBeCloseTo(b.y, 6); }
      }
      for (const [sx, sy] of [[0, 0], [512, 384], [1023, 767], [100, -50], [900, 700]] as const) {
        const okA = r.cam.screenToPitch(sx, sy, pa), okB = projectScreenToPitch(r.ctx.camera, 1024, 768, sx, sy, pb);
        expect(okA).toBe(okB);
        if (okA) { expect(pa.x).toBeCloseTo(pb.x, 5); expect(pa.z).toBeCloseTo(pb.z, 5); }
      }
    }
  });

  it('stickRotation: 0 for Broadcast / Wide / Close, +-pi/2 for End to End by the human team attack direction', () => {
    for (const type of SIDE_TYPES) {
      const r = makeRig(1180, 820, { type });
      settle(r, 0, 0.11, 0, -1, 2);
      expect(r.cam.stickRotation()).toBe(0);
    }
    // P1 home, home attacks +x.
    const r = makeRig(1180, 820, { type: CameraType.END_TO_END });
    r.cam.setMatch!(r.s, []);
    expect(r.s.teams[0]!.dir).toBe(1);
    expect(r.cam.stickRotation()).toBeCloseTo(Math.PI / 2, 12);
    // P1 away: away attacks -x.
    const r2 = makeRig(1180, 820, { type: CameraType.END_TO_END });
    r2.s.ctrl[0]!.side = 1;
    r2.cam.setMatch!(r2.s, []);
    expect(r2.cam.stickRotation()).toBeCloseTo(-Math.PI / 2, 12);
    // Online override: the local human is the away side.
    r.cam.setViewTeam(1);
    settle(r, 0, 0.11, 0, -1, 2);
    expect(r.cam.stickRotation()).toBeCloseTo(-Math.PI / 2, 12);
    r.cam.setViewTeam(-1);
    settle(r, 0, 0.11, 0, -1, 2);
    expect(r.cam.stickRotation()).toBeCloseTo(Math.PI / 2, 12);
    // Bot v bot: home's direction.
    const r3 = makeRig(1180, 820, { type: CameraType.END_TO_END }, false, undefined, 0);
    r3.cam.setMatch!(r3.s, []);
    expect(r3.cam.stickRotation()).toBeCloseTo(Math.PI / 2, 12);
  });

  it('End to End: stick up moves toward the attacked goal and up the screen; stick right moves right on screen', () => {
    for (const side of [0, 1]) {
      const r = makeRig(1180, 820, { type: CameraType.END_TO_END });
      r.s.ctrl[0]!.side = side;
      r.cam.setMatch!(r.s, []);
      settle(r, 0, 0.11, 0, -1, 120);
      const rot = r.cam.stickRotation();
      const up = { x: 0, y: 0 }, right = { x: 0, y: 0 };
      screenToPitchAxes(0, -1, rot, up);
      screenToPitchAxes(1, 0, rot, right);
      const dir = r.s.teams[side]!.dir;
      expect(up.x * dir).toBeCloseTo(1, 9);
      const a = screenOf(r, 0, 0, 0);
      const u = screenOf(r, up.x * 5, 0, up.y * 5);
      const rr = screenOf(r, right.x * 5, 0, right.y * 5);
      expect(u.y).toBeLessThan(a.y - 10);
      expect(Math.abs(u.x - a.x)).toBeLessThan(2);
      expect(rr.x).toBeGreaterThan(a.x + 10);
      // The camera sits behind the ball relative to the attack, looking along x.
      expect((r.ctx.camera.position.x - 0) * dir).toBeLessThan(-10);
      expect(Math.abs(r.ctx.camera.getWorldDirection(fwd).z)).toBeLessThan(1e-6);
    }
  });

  it('End to End: one clean cut when the view team changes ends at half-time', () => {
    const r = makeRig(1180, 820, { type: CameraType.END_TO_END });
    r.cam.setMatch!(r.s, []);
    settle(r, 10, 0.11, 0, -1, 60);
    const cuts = r.cam.cuts;
    const before = r.ctx.camera.position.x;
    r.s.teams[0]!.dir = -1;
    r.s.teams[1]!.dir = 1;
    step(r, 10, 0.11, 0);
    expect(r.cam.cuts).toBe(cuts + 1);
    expect(r.cam.stickRotation()).toBeCloseTo(-Math.PI / 2, 12);
    expect(r.ctx.camera.position.x).toBeCloseTo(endToEndCamX(10, -1, r.cam.rig.back!), 6);
    expect(r.ctx.camera.position.x).toBeGreaterThan(before);
    settle(r, 10, 0.11, 0, -1, 30);
    expect(r.cam.cuts).toBe(cuts + 1);
  });
});

// ---------------------------------------------------------------------------------------------------- settings

describe('GFX-14 settings: type, Height and Zoom sliders 0-20, reduced camera motion', () => {
  const rig = (): BroadcastRig => ({ height: 0, camZ: 0, fovDeg: 0, smoothTime: 0, widenMax: 0 });

  it('baseline at 10 / 10 is T_CAMERA; Height raises the camera, Zoom narrows the FOV, monotonic over 0..20', () => {
    const o = broadcastRig({ type: CameraType.BROADCAST, height: 10, zoom: 10 }, false, rig());
    expect(o.height).toBeCloseTo(T_CAMERA.height, 9);
    expect(o.camZ).toBeCloseTo(34 + T_CAMERA.distance, 9);
    expect(o.fovDeg).toBeCloseTo(T_CAMERA.fovDeg, 9);
    expect(o.endToEnd).toBe(false);
    for (const type of TYPES) {
      let lastH = -Infinity, lastF = Infinity;
      for (let v = 0; v <= 20; v++) {
        const h = broadcastRig({ type, height: v, zoom: 10 }, false, rig());
        const z = broadcastRig({ type, height: 10, zoom: v }, false, rig());
        expect(h.height).toBeGreaterThan(lastH);
        expect(z.fovDeg).toBeLessThan(lastF);
        expect(h.height).toBeGreaterThan(5);
        expect(z.fovDeg).toBeGreaterThan(10);
        expect(z.fovDeg).toBeLessThan(60);
        lastH = h.height; lastF = z.fovDeg;
      }
    }
    // Out-of-range and non-finite sliders clamp to the ends / the baseline.
    expect(broadcastRig({ type: CameraType.BROADCAST, height: 99, zoom: -5 }, false, rig()).height)
      .toBeCloseTo(broadcastRig({ type: CameraType.BROADCAST, height: 20, zoom: 0 }, false, rig()).height, 9);
    expect(broadcastRig({ type: CameraType.BROADCAST, height: Number.NaN, zoom: Number.NaN }, false, rig()).fovDeg).toBeCloseTo(T_CAMERA.fovDeg, 9);
  });

  it('sliders change what the player sees: zooming in enlarges players, raising the camera steepens the view', () => {
    let lastFrac = 0;
    for (const zoom of [0, 5, 10, 15, 20]) {
      const r = makeRig(1180, 820, { zoom });
      r.cam.snapTo(0, 0.11, 0, 1);
      const m = readability(r);
      expect(m.playerFrac).toBeGreaterThan(lastFrac);
      lastFrac = m.playerFrac;
    }
    let lastPitch = 0;
    for (const height of [0, 10, 20]) {
      const r = makeRig(1180, 820, { height });
      r.cam.snapTo(0, 0.11, 0, 1);
      expect(r.cam.pitch).toBeGreaterThan(lastPitch);
      lastPitch = r.cam.pitch;
    }
  });

  it('setSettings applies at once (a cut), keeps the follow, and switches the stick rotation with End to End', () => {
    const r = makeRig();
    settle(r, 20, 0.11, 0, 9, 120);
    const cuts = r.cam.cuts;
    r.ctx.cameraSettings = { type: CameraType.CLOSE, height: 20, zoom: 15 };
    r.cam.setSettings(r.ctx.cameraSettings, false);
    expect(r.cam.cuts).toBe(cuts + 1);
    expect(r.ctx.camera.position.y).toBeCloseTo(r.cam.rig.height, 9);
    expect(r.ctx.camera.fov).toBeCloseTo(r.cam.rig.fovDeg, 9);
    expect(r.ctx.camera.position.x).toBeCloseTo(followX(20), 6);
    expect(framingError(r, 20, 0.11, 0)).toBe('');
    r.ctx.cameraSettings = { type: CameraType.END_TO_END, height: 10, zoom: 10 };
    r.cam.setSettings(r.ctx.cameraSettings, false);
    expect(r.cam.stickRotation()).toBeCloseTo(Math.PI / 2, 12);
    expect(framingError(r, 20, 0.11, 0)).toBe('');
    r.ctx.cameraSettings = { type: CameraType.BROADCAST, height: 10, zoom: 10 };
    r.cam.setSettings(r.ctx.cameraSettings, false);
    expect(r.cam.stickRotation()).toBe(0);
    expect(r.ctx.camera.position.z).toBeCloseTo(74, 9);
  });

  it('reduced camera motion: slower smoothing, no FOV widening, cuts instead of long glides', () => {
    const o = broadcastRig({ type: CameraType.BROADCAST, height: 10, zoom: 10 }, true, rig());
    expect(o.widenMax).toBe(0);
    expect(o.smoothTime).toBeGreaterThan(T_CAMERA.smoothTime);
    const run = (reduced: boolean): { moved: number; fov: number; cuts: number } => {
      const r = makeRig(1180, 820, {}, reduced);
      settle(r, 0, 0.11, 0, -1, 30);
      for (let i = 0; i < 18; i++) step(r, 30, 0.11, 0, 0, 0, 0, -1); // a 30 m jump: both cut
      const c0 = r.cam.cuts;
      settle(r, 30, 0.11, 0, -1, 30);
      const x0 = r.ctx.camera.position.x;
      // Smooth move: ball rolls 15 m to the right in 0.5 s, then the camera follows for 0.3 s.
      for (let i = 1; i <= 30; i++) step(r, 30 + i * 0.5, 0.11, 0, 30, 0, 0);
      for (let i = 0; i < 18; i++) step(r, 45, 0.11, 0);
      const moved = r.ctx.camera.position.x - x0;
      // A high fast ball for widening (rises 0.25 m per frame, then hangs).
      for (let i = 0; i < 90; i++) step(r, 45, Math.min(14, 0.11 + i * 0.25), 0, 30, 0, 0);
      const fov = r.ctx.camera.fov;
      // A 14 m restart placement.
      step(r, 31, 0.11, 0);
      return { moved, fov, cuts: r.cam.cuts - c0 };
    };
    const n = run(false), red = run(true);
    expect(red.moved).toBeLessThan(n.moved);
    expect(n.fov).toBeGreaterThan(T_CAMERA.fovDeg + 2);
    expect(n.fov).toBeLessThanOrEqual(T_CAMERA.fovDeg + T_CAMERA.fovWidenMax + 1e-6);
    expect(red.fov).toBeCloseTo(T_CAMERA.fovDeg, 6);
    expect(n.cuts).toBe(0); // glides
    expect(red.cuts).toBe(1); // cuts
  });
});

// ---------------------------------------------------------------------------------------------------- motion

describe('GFX-14 motion: smoothing, FOV widening, frame-rate independence, robustness', () => {
  it('FOV widens up to 4 deg for high or fast balls and returns', () => {
    const r = makeRig();
    settle(r, 0, 0.11, 0);
    expect(r.ctx.camera.fov).toBeCloseTo(T_CAMERA.fovDeg, 6);
    for (let i = 0; i < 240; i++) step(r, 0, Math.min(20, 0.11 + i * 0.3), 0);
    expect(r.ctx.camera.fov).toBeGreaterThan(T_CAMERA.fovDeg + T_CAMERA.fovWidenMax - 0.05);
    expect(r.ctx.camera.fov).toBeLessThanOrEqual(T_CAMERA.fovDeg + T_CAMERA.fovWidenMax + 1e-9);
    settle(r, 0, 0.11, 0, -1, 240);
    expect(r.ctx.camera.fov).toBeCloseTo(T_CAMERA.fovDeg, 3);
    for (let i = 0; i < 120; i++) step(r, 0, 0.11, 0, 40, 0, 0);
    expect(r.ctx.camera.fov).toBeGreaterThan(T_CAMERA.fovDeg + T_CAMERA.fovWidenMax - 0.05);
  });

  it('critically damped: follows a ball run without overshoot and settles ~0.4 s-scale after it stops', () => {
    const r = makeRig();
    settle(r, 0, 0.11, 0);
    const target = followX(20);
    let maxX = -Infinity, at400 = 0, at1200 = 0;
    // Ball runs 0 -> 20 m at 30 m/s (40 frames), then stops.
    for (let i = 1; i <= 160; i++) {
      const x = Math.min(20, i * 0.5);
      step(r, x, 0.11, 0, x < 20 ? 30 : 0, 0, 0);
      const cx = r.ctx.camera.position.x;
      maxX = Math.max(maxX, cx);
      if (i === 40 + 24) at400 = cx;
      if (i === 40 + 72) at1200 = cx;
    }
    expect(maxX).toBeLessThanOrEqual(target + 1e-6);
    expect(at400 / target).toBeGreaterThan(0.7);
    expect(at400 / target).toBeLessThan(0.98);
    expect(at1200 / target).toBeGreaterThan(0.98);
  });

  it('60 Hz and 120 Hz give the same camera after the same real time (follow, lead, tilt, FOV, E2E)', () => {
    for (const type of [CameraType.BROADCAST, CameraType.END_TO_END]) {
      const run = (hz: number): number[] => {
        const r = makeRig(1180, 820, { type });
        r.cam.snapTo(0, 0.11, 0, 1);
        const b = { x: 0, y: 0.11, z: 0, vx: 18, vy: 0, vz: 4 };
        for (let i = 1; i <= hz * 3; i++) {
          if (i === hz) { b.vy = 16; b.vx = 20; }
          flightStep(b, 1 / hz);
          step(r, b.x, b.y, b.z, b.vx, b.vy, b.vz, -1, 1000 / hz, i % (hz / 60) === 0 ? 1 : 0);
        }
        return [r.ctx.camera.position.x, r.ctx.camera.position.z, r.cam.lookX, r.cam.lookZ, r.ctx.camera.fov, r.cam.yaw, r.cam.pitch];
      };
      const a = run(60), b = run(120);
      for (let k = 0; k < a.length; k++) expect(Math.abs(a[k]! - b[k]!), `${CameraType[type]} channel ${k}`).toBeLessThan(k >= 5 ? 0.01 : 0.15);
    }
  });

  it('stays finite with NaN / infinite inputs, zero-length frames, 100 ms hitches and degenerate windows', () => {
    for (const [w, h] of [[1180, 820], [1, 1], [4000, 200]] as const) {
      const r = makeRig(w, h);
      step(r, Number.NaN, Number.NaN, Number.NaN);
      step(r, Infinity, -Infinity, 1e30, 1e9, Number.NaN, -1e9);
      step(r, 10, 0.11, 0, 0, 0, 0, -1, 0, 0);
      step(r, 10, 0.11, 0, 0, 0, 0, -1, 100, 3);
      step(r, 10, 0.11, 0, 0, 0, 0, -1, Number.NaN, Number.NaN);
      r.cam.resize!();
      const c = r.ctx.camera;
      for (const v of [c.position.x, c.position.y, c.position.z, c.quaternion.x, c.quaternion.w, c.fov, r.cam.lookX, r.cam.lookZ, r.cam.yaw, r.cam.pitch]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(c.position.y).toBeGreaterThan(5);
    }
  });

  it('match lifecycle: setMatch snaps to the kick-off, snap() jumps to the target, clearMatch then a new match', () => {
    const r = makeRig();
    r.cam.setMatch!(r.s, []);
    expect(r.ctx.camera.position.x).toBeCloseTo(followX(r.s.ball.x), 9);
    for (let i = 0; i < 10; i++) step(r, 30, 0.11, 0, 5, 0, 0);
    r.cam.snap();
    expect(r.ctx.camera.position.x).toBeCloseTo(followX(30), 9);
    r.cam.clearMatch!();
    r.s.ball.x = -20;
    r.cam.setMatch!(r.s, []);
    expect(r.ctx.camera.position.x).toBeCloseTo(followX(-20), 9);
    r.cam.dispose();
    expect(r.cam.active).toBe(false);
    const before = r.ctx.camera.position.x;
    step(r, 40, 0.11, 0);
    expect(r.ctx.camera.position.x).toBe(before);
  });

  it('GameRenderer projector uses the broadcast camera (End to End stick rotation through setCamera)', () => {
    const g = createGameRenderer();
    g.resize(1180, 820, 2);
    expect(g.projector.stickRotation()).toBe(0);
    g.setCamera({ type: CameraType.END_TO_END, height: 10, zoom: 10 }, false);
    expect(Math.abs(g.projector.stickRotation())).toBeCloseTo(Math.PI / 2, 12);
    const p = { x: 0, y: 0 };
    expect(g.projector.pitchToScreen(0, 0, 0, p)).toBe(true);
    g.setCamera({ type: CameraType.BROADCAST, height: 10, zoom: 10 }, false);
    expect(g.projector.stickRotation()).toBe(0);
    g.dispose();
  });
});

// ---------------------------------------------------------------------------------------------------- glitch list: Camera

describe('GFX-14 glitch list: Camera', () => {
  it('Camera glitch: jitter - still ball with interpolation noise, weaving dribble with uneven frame pacing', () => {
    // 1) Still ball, +-2 cm per-frame noise: the camera barely moves.
    const r = makeRig();
    settle(r, 12, 0.11, 6, 9);
    const p0 = r.ctx.camera.position.clone();
    const y0 = r.cam.yaw, t0 = r.cam.pitch;
    let maxAng = 0, maxPos = 0;
    for (let i = 0; i < 600; i++) {
      const n = ((i * 7919) % 13) / 13 - 0.5;
      step(r, 12 + 0.04 * n, 0.11, 6 - 0.04 * n, 0, 0, 0, 9);
      maxAng = Math.max(maxAng, Math.abs(r.cam.yaw - y0), Math.abs(r.cam.pitch - t0));
      maxPos = Math.max(maxPos, r.ctx.camera.position.distanceTo(p0));
    }
    expect(maxAng / DEG).toBeLessThan(0.02);
    expect(maxPos).toBeLessThan(0.02);
    // 2) Weaving dribble across the near side with 120 Hz render, 60 Hz sim and +-25% frame-time jitter: the camera's
    // angular velocity never reverses frame to frame (no oscillation) and its angular acceleration stays bounded.
    for (const type of [CameraType.BROADCAST, CameraType.CLOSE, CameraType.END_TO_END]) {
      const q = makeRig(1180, 820, { type, zoom: type === CameraType.CLOSE ? 20 : 10 });
      const path = (t: number): [number, number] => [-30 + 7 * t, 28 + 4 * Math.sin(t * 1.3)];
      q.cam.snapTo(-30, 0.11, 28, 1);
      let t = 0, prevYaw = q.cam.yaw, prevPitch = q.cam.pitch, prevWy = 0, prevWp = 0, prevDt = 1 / 120;
      let flips = 0, maxAcc = 0;
      for (let i = 0; i < 900; i++) {
        const dt = (1 / 120) * (1 + 0.25 * Math.sin(i * 2.3));
        t += dt;
        const [x, z] = path(t);
        const [x2, z2] = path(t + 0.01);
        step(q, x, 0.11, z, (x2 - x) * 100, 0, (z2 - z) * 100, 9, dt * 1000, i % 2);
        const wy = (q.cam.yaw - prevYaw) / dt, wp = (q.cam.pitch - prevPitch) / dt;
        if (i > 60) {
          const acc = Math.max(Math.abs(wy - prevWy), Math.abs(wp - prevWp)) / ((dt + prevDt) / 2);
          maxAcc = Math.max(maxAcc, acc);
          if ((wy > 1e-3 && prevWy < -1e-3) || (wy < -1e-3 && prevWy > 1e-3)) flips++;
          if ((wp > 1e-3 && prevWp < -1e-3) || (wp < -1e-3 && prevWp > 1e-3)) flips++;
        }
        prevYaw = q.cam.yaw; prevPitch = q.cam.pitch; prevWy = wy; prevWp = wp; prevDt = dt;
        expect(framingError(q, x, 0.11, z), `${CameraType[type]} t ${t.toFixed(2)}`).toBe('');
      }
      expect(flips, CameraType[type]).toBeLessThanOrEqual(4);
      expect(maxAcc, CameraType[type]).toBeLessThan(1); // rad/s^2 (measured ~0.1; one 0.5 deg snap at 120 Hz reads ~100)
    }
  });

  it('Camera glitch: snapping at restarts - placements glide (no jump), long ones cut once (no fly-over)', () => {
    const maxStep = (r: Rig, frames: number, x: number, y: number, z: number): { pos: number; ang: number } => {
      let pos = 0, ang = 0;
      let px = r.ctx.camera.position.clone(), pf = forwardOf(r).clone();
      for (let i = 0; i < frames; i++) {
        step(r, x, y, z);
        pos = Math.max(pos, r.ctx.camera.position.distanceTo(px));
        ang = Math.max(ang, forwardOf(r).angleTo(pf));
        px = r.ctx.camera.position.clone(); pf = forwardOf(r).clone();
      }
      return { pos, ang };
    };
    // Throw-in at the near touchline: the ball rolled out to z = 37.5 and is placed in the taker's hands at z = 34.
    for (const type of TYPES) {
      const r = makeRig(1180, 820, { type, zoom: 20 });
      settle(r, 20, 0.11, 37.5, -1, 120);
      const cuts = r.cam.cuts;
      const m = maxStep(r, 90, 20.4, 2.2, 34.3);
      expect(r.cam.cuts, CameraType[type]).toBe(cuts);
      expect(m.ang / DEG, `${CameraType[type]} angle step`).toBeLessThan(0.6);
      expect(m.pos, `${CameraType[type]} position step`).toBeLessThan(0.35);
      expect(framingError(r, 20.4, 2.2, 34.3), CameraType[type]).toBe('');
    }
    // Goal kick and corner placements (5-14 m): glide.
    for (const [ox, oz, nx, nz] of [[54, 12, 47, 9.16], [54, -22, 52.5, -34], [-55, 30, -52.5, 34]] as const) {
      const r = makeRig();
      settle(r, ox, 0.11, oz, -1, 120);
      const cuts = r.cam.cuts;
      const m = maxStep(r, 120, nx, 0.11, nz);
      expect(r.cam.cuts).toBe(cuts);
      expect(m.ang / DEG).toBeLessThan(0.8);
      expect(framingError(r, nx, 0.11, nz)).toBe('');
    }
    // Kick-off after a goal: the ball goes from the net to the centre spot: exactly one cut, already framed after it.
    const r = makeRig();
    settle(r, 53.5, 1, 1, -1, 120);
    const cuts = r.cam.cuts;
    step(r, 0, 0.11, 0);
    expect(r.cam.cuts).toBe(cuts + 1);
    expect(r.ctx.camera.position.x).toBeCloseTo(followX(0), 9);
    const m = maxStep(r, 60, 0, 0.11, 0);
    expect(r.cam.cuts).toBe(cuts + 1);
    expect(m.pos).toBeLessThan(0.05);
    expect(m.ang / DEG).toBeLessThan(0.2);
    // Real interpolation: prev at the old spot, curr at the new spot (alpha sweeps across the jump in one tick).
    const q = makeRig();
    settle(q, 20, 0.11, 37, -1, 60);
    const prev = initMatch(createMatchConfig()) as SimState;
    prev.ball.x = 20; prev.ball.y = 0.11; prev.ball.z = 37;
    q.s.ball.x = 20.5; q.s.ball.y = 2.2; q.s.ball.z = 34.2;
    q.frame.prev = prev;
    const c0 = q.cam.cuts;
    let maxAng = 0, pf = forwardOf(q).clone();
    for (const a of [0.25, 0.5, 0.75, 1]) {
      fillInterp(q.frame.interp, prev, q.s, a);
      q.frame.frame.ticks = a === 0.25 ? 1 : 0;
      q.cam.update(q.frame);
      maxAng = Math.max(maxAng, forwardOf(q).angleTo(pf));
      pf = forwardOf(q).clone();
    }
    expect(q.cam.cuts).toBe(c0);
    expect(maxAng / DEG).toBeLessThan(0.6);
  });

  it('Camera glitch: losing a high ball - lofted clearances, long balls, crosses and steepling balls stay framed', () => {
    expect(predictApexY(0.11, 0)).toBe(0.11);
    expect(predictApexY(0.11, 20)).toBeGreaterThan(14);
    expect(predictApexY(0.11, 20)).toBeLessThan(0.11 + (20 * 20) / (2 * T_BALL.gravity));
    const kicks: [string, number, number, number, number, number, number][] = [
      ['clearance from own box', -40, 0, 22, 20, 0, -2],
      ['long diagonal to the near side', -10, -25, 24, 14, 0, 18],
      ['cross from the byline', 48, 30, -6, 12, 0, -14],
      ['steepling ball at the far touchline', 10, -30, 2, 26, 0, 1],
      ['goal kick', -47, 5, 26, 18, 0, 3],
      ['high ball straight at the camera side', 0, -10, 0, 22, 0, 16],
    ];
    const fails: string[] = [];
    for (const type of TYPES) {
      for (const [w, h] of [[1180, 820], [1024, 768]] as const) {
        for (const [name, x, z, vx, vy, , vz] of kicks) {
          const r = makeRig(w, h, { type });
          r.cam.snapTo(x, 0.11, z, vx >= 0 ? 1 : -1);
          const b = { x, y: 0.11, z, vx, vy, vz };
          let tiltBeforeApex = 0;
          for (let i = 0; i < 300; i++) {
            flightStep(b, 1 / 60);
            b.x = Math.max(-60, Math.min(60, b.x)); b.z = Math.max(-42, Math.min(42, b.z));
            step(r, b.x, b.y, b.z, b.vx, b.vy, b.vz);
            if (b.vy > 4) tiltBeforeApex = Math.max(tiltBeforeApex, r.cam.tilt);
            const err = framingError(r, b.x, b.y, b.z);
            if (err && fails.length < 10) fails.push(`${CameraType[type]} ${w}x${h} ${name} t ${(i / 60).toFixed(2)} ball (${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}): ${err}`);
          }
          // The steepling ball's apex (~24 m) is above the untilted view: the camera tilts up while the ball still rises.
          if (type === CameraType.BROADCAST && name.startsWith('steepling')) expect(tiltBeforeApex, `${name}: tilts up before the apex`).toBeGreaterThan(0.01);
        }
      }
    }
    expect(fails).toEqual([]);
  });

  it('Camera glitch: dipping below ground or into the stand - the camera stays in its envelope over every setting', () => {
    const env: CameraEnvelope = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
    const pts: [number, number, number][] = [
      [0, 0.11, 0], [-60, 0.11, 42], [60, 0.11, -42], [-52.5, 0.11, 34], [52.5, 0.11, -34], [52.5, 25, 0], [-52.5, 2, 0], [0, 40, 40],
    ];
    const corner = new Vector3();
    for (const type of TYPES) {
      cameraEnvelope(type, env);
      expect(env.minY).toBeGreaterThan(10);
      expect(Math.abs(env.maxX)).toBeLessThanOrEqual(HALF_LENGTH + LOCAL_TUNING.e2eOverrun);
      for (const [height, zoom] of [[0, 0], [0, 20], [20, 20], [10, 10]] as const) {
        for (const side of [0, 1]) {
          const r = makeRig(1180, 820, { type, height, zoom });
          r.s.ctrl[0]!.side = side;
          r.cam.setMatch!(r.s, []);
          for (const [x, y, z] of pts) {
            r.cam.snapTo(x, y, z, 1);
            for (let i = 0; i < 90; i++) {
              step(r, x, y, z, 0, 0, 0);
              const c = r.ctx.camera;
              const p = c.position;
              const tag = `${CameraType[type]} h${height} z${zoom} side ${side} ball (${x}, ${y}, ${z})`;
              expect(p.x, tag).toBeGreaterThanOrEqual(env.minX - 1e-9);
              expect(p.x, tag).toBeLessThanOrEqual(env.maxX + 1e-9);
              expect(p.y, tag).toBeGreaterThanOrEqual(env.minY - 1e-9);
              expect(p.y, tag).toBeLessThanOrEqual(env.maxY + 1e-9);
              expect(p.z, tag).toBeGreaterThanOrEqual(env.minZ - 1e-9);
              expect(p.z, tag).toBeLessThanOrEqual(env.maxZ + 1e-9);
              if (i === 89) {
                // The near-plane rectangle stays above the ground.
                for (const [nx, ny] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
                  corner.set(nx, ny, -1).unproject(c);
                  expect(corner.y, tag).toBeGreaterThan(1);
                }
              }
            }
          }
        }
      }
    }
    // End to End camera x clamp.
    expect(endToEndCamX(-52.5, 1, 26)).toBe(-(HALF_LENGTH + LOCAL_TUNING.e2eOverrun));
    expect(endToEndCamX(52.5, -1, 26)).toBe(HALF_LENGTH + LOCAL_TUNING.e2eOverrun);
    expect(endToEndCamX(0, 1, 26)).toBe(-26);
  });

  it('Camera glitch: ball hidden under touch controls - fast balls into the corners with default, spaced and mirrored controls', () => {
    const paths: [number, number, number, number][] = [
      [0, 0, 52.5, 34], [0, 0, -52.5, 34], [-50, 33.5, 50, 33.5], [50, 33.5, -50, 33.5], [30, -20, -40, 37], [-52, 0, 52, 34],
      [40, 30, 52, 20], [-40, 30, -52, 20],
    ];
    const variants: [string, (s: Settings) => void][] = [
      ['default', () => { /* defaults */ }],
      ['mirrored', (s) => { s.controls.touch.mirror = true; }],
      ['spaced', (s) => { s.controls.touch.spacing = 1.5; }],
    ];
    const fails: string[] = [];
    let frames = 0;
    for (const [vname, mut] of variants) {
      for (const type of TYPES) {
        for (const [w, h] of [[1180, 820], [1024, 768], [1366, 1024]] as const) {
          for (const dir of [1, -1]) {
            const st = createDefaultSettings();
            mut(st);
            const r = makeRig(w, h, { type }, false, st);
            for (const [ax, az, bx, bz] of paths) {
              r.cam.snapTo(ax, 0.11, az, dir);
              const len = Math.hypot(bx - ax, bz - az);
              const n = Math.ceil((len / 28) * 60);
              const vx = ((bx - ax) / len) * 28, vz = ((bz - az) / len) * 28;
              for (let i = 0; i <= n + 60; i++) {
                const k = Math.min(1, i / n);
                const x = ax + (bx - ax) * k, z = az + (bz - az) * k;
                step(r, x, 0.11, z, i < n ? vx : 0, 0, i < n ? vz : 0, dir > 0 ? 9 : 20);
                frames++;
                const err = framingError(r, x, 0.11, z);
                if (err && fails.length < 10) fails.push(`${vname} ${CameraType[type]} ${w}x${h} dir ${dir} ball (${x.toFixed(1)}, ${z.toFixed(1)}): ${err}`);
              }
            }
          }
        }
      }
    }
    expect(frames).toBeGreaterThan(20000);
    expect(fails).toEqual([]);
  });
});
