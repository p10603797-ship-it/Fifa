/**
 * [GFX-13] On-pitch aids: which aids show (planAids), the high-ball landing marker against the sim's own ball
 * physics (SIM-01 predictBall / SIM-02 ballStepTick), the off-screen arrow maths against three.js projection, marker
 * sizing, the quad batch, and the module in a headless scene (2 draw calls, colours, shapes, colour-blind labels,
 * screen placement). Glitch-list regressions are named after the glitch. Node only; e2e gfx-13-markers checks pixels.
 */
import { DoubleSide, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, NUM_SLOTS, TICK_HZ } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createBallState, createMatchConfig, type BallState, type SimState } from '../../src/contracts/state';
import { touchZones, type TouchZones } from '../../src/render/camera/broadcast';
import { fillInterp } from '../../src/render/index';
import {
  GLYPH_1, GLYPH_2, HUMAN_COLOURS, SHAPE_ARROW, SHAPE_BADGE, HUMAN_SHAPES, MARKER_TUNING, MARKER_Y, MarkerShape, QuadBatch, aidsActive,
  createAidPlan, createEdgeArrow, createLandingTracker, createMarkers, edgeArrow, landingRadius, liftArrowAboveZones,
  markerUnit, metresPerPx, planAids, updateLanding,
} from '../../src/render/markers';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { copyBallState } from '../../src/sim/ball/flight';
import { ballStepTick } from '../../src/sim/ball/contact';
import { initMatch } from '../../src/sim/init';

const W = 1180, H = 820;

function makeState(): SimState {
  const s = initMatch(createMatchConfig());
  s.match.phase = MatchPhase.IN_PLAY;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.active = 1; p.ctrl = -1;
    p.x = (i < 11 ? -1 : 1) * (4 + (i % 11) * 3); p.z = ((i % 5) - 2) * 6;
  }
  for (let c = 0; c < 4; c++) {
    const k = s.ctrl[c]!;
    k.kind = c < 2 ? ControllerKind.NONE : ControllerKind.CPU; k.side = c < 2 ? -1 : c - 2; k.slot = -1;
    k.nextSwitch = -1; k.powerBtn = 0; k.power = 0; k.receiver = -1;
  }
  const b = s.ball;
  b.x = 0; b.y = BALL_RADIUS; b.z = 0; b.vx = 0; b.vy = 0; b.vz = 0; b.sx = 0; b.sy = 0; b.sz = 0;
  b.owner = -1; b.heldBy = -1; b.passTarget = -1; b.shotBy = -1; b.inNet = 0; b.grounded = 1; b.lastTouchTeam = -1;
  return s;
}

function human(s: SimState, h: number, side: number, slot: number): void {
  const c = s.ctrl[h]!;
  c.kind = ControllerKind.HUMAN; c.side = side; c.slot = slot;
  s.players[slot]!.ctrl = h;
}

function makeCtx(settings: Settings = createDefaultSettings()): RenderContext {
  const cam = new PerspectiveCamera(22, W / H, 2, 600);
  cam.position.set(0, 24, 74);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: cam, settings, clubs: [],
    size: { cssW: W, cssH: H, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED, cameraSettings: { ...settings.camera },
    reducedMotion: false, night: false,
  };
}

function frame(s: SimState, nowMs = 0): RenderFrame {
  const interp = createInterpState();
  fillInterp(interp, s, s, 1);
  return { prev: s, curr: s, alpha: 1, frame: { nowMs, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
}

function toScreen(cam: PerspectiveCamera, x: number, y: number, z: number): { x: number; y: number } {
  const v = new Vector3(x, y, z).project(cam);
  return { x: (v.x + 1) * 0.5 * W, y: (1 - v.y) * 0.5 * H };
}

// ======================================================================== plan

describe('GFX-13 aids plan', () => {
  it('aids show in play and restart phases only', () => {
    const on = [MatchPhase.KICK_OFF, MatchPhase.IN_PLAY, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER,
      MatchPhase.FREE_KICK, MatchPhase.PENALTY, MatchPhase.SHOOT_OUT];
    const off = [MatchPhase.PRE_MATCH, MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME,
      MatchPhase.FULL_TIME, MatchPhase.EXTRA_TIME, MatchPhase.POST_MATCH];
    for (const p of on) expect(aidsActive(p), MatchPhase[p]).toBe(true);
    for (const p of off) expect(aidsActive(p), MatchPhase[p]).toBe(false);
  });

  it('one marker per human on his controlled player; CPU brains and empty controllers get none', () => {
    const s = makeState();
    human(s, 0, 0, 9);
    human(s, 1, 1, 20);
    s.ctrl[2]!.slot = 3; s.ctrl[3]!.slot = 14; // CPU brains: no markers
    const p = planAids(s, createAidPlan());
    expect(p.active).toBe(true);
    expect(p.humans.map((h) => h.slot)).toEqual([9, 20]);
    s.ctrl[1]!.kind = ControllerKind.NONE;
    planAids(s, p);
    expect(p.humans[1]!.slot).toBe(-1);
    s.match.phase = MatchPhase.CELEBRATION;
    planAids(s, p);
    expect(p.active).toBe(false);
    expect(p.humans[0]!.slot).toBe(-1);
  });

  it('glitch: switching lands on a sent-off or substituted player - no marker, faint marker or ring on an inactive slot', () => {
    const s = makeState();
    human(s, 0, 0, 9);
    s.ctrl[0]!.nextSwitch = 7;
    s.ball.passTarget = 7; s.ball.lastTouchTeam = 0;
    s.players[7]!.active = 0; // sent off
    const p = planAids(s, createAidPlan());
    expect(p.humans[0]!.next).toBe(-1);
    expect(p.receiver).toBe(-1);
    s.players[9]!.active = 0; // the controlled slot itself is empty
    planAids(s, p);
    expect(p.humans[0]!.slot).toBe(-1);
    // Junk slots never index outside the players array.
    s.players[9]!.active = 1;
    for (const junk of [-1, 22, 99, 2.5, Number.NaN]) {
      s.ctrl[0]!.nextSwitch = junk;
      s.ball.passTarget = junk;
      planAids(s, p);
      expect(p.humans[0]!.next).toBe(-1);
      expect(p.receiver).toBe(-1);
    }
  });

  it('faint next-switch marker: an active teammate only, never the controlled player or the other human\'s player', () => {
    const s = makeState();
    human(s, 0, 0, 9);
    human(s, 1, 0, 10); // co-op on the same side
    const p = createAidPlan();
    s.ctrl[0]!.nextSwitch = 6;
    expect(planAids(s, p).humans[0]!.next).toBe(6);
    s.ctrl[0]!.nextSwitch = 9;
    expect(planAids(s, p).humans[0]!.next).toBe(-1);
    s.ctrl[0]!.nextSwitch = 10;
    expect(planAids(s, p).humans[0]!.next).toBe(-1);
    s.ctrl[0]!.nextSwitch = 15; // opponent
    expect(planAids(s, p).humans[0]!.next).toBe(-1);
  });

  it('glitch: power bar stuck full - the bar shows only while a button charges and hides on release', () => {
    const s = makeState();
    human(s, 0, 0, 9);
    const c = s.ctrl[0]!;
    const p = createAidPlan();
    c.powerBtn = 0; c.power = 1; // released with a full value left over
    expect(planAids(s, p).humans[0]!.power).toBe(-1);
    c.powerBtn = 1; c.power = 0.62;
    expect(planAids(s, p).humans[0]!.power).toBeCloseTo(0.62, 9);
    c.power = 1.7;
    expect(planAids(s, p).humans[0]!.power).toBe(1);
    c.power = Number.NaN;
    expect(planAids(s, p).humans[0]!.power).toBe(0);
    c.powerBtn = 0;
    expect(planAids(s, p).humans[0]!.power).toBe(-1);
  });

  it('receiver ring: our loose pass to an active teammate on a human side; not after an opponent touch, a reception or for CPU passes', () => {
    const s = makeState();
    human(s, 0, 0, 9);
    const b = s.ball;
    b.passTarget = 7; b.lastTouchTeam = 0; b.y = 1; b.vx = 12;
    const p = createAidPlan();
    planAids(s, p);
    expect(p.receiver).toBe(7);
    expect(p.receiverHuman).toBe(0);
    b.lastTouchTeam = 1; // deflected by an opponent
    expect(planAids(s, p).receiver).toBe(-1);
    b.lastTouchTeam = 0; b.owner = 7; // received
    expect(planAids(s, p).receiver).toBe(-1);
    b.owner = -1; b.heldBy = 11; // keeper caught it
    expect(planAids(s, p).receiver).toBe(-1);
    b.heldBy = -1; b.inNet = 1;
    expect(planAids(s, p).receiver).toBe(-1);
    b.inNet = 0; b.passTarget = 15; b.lastTouchTeam = 1; // CPU side pass, no human on team 1
    expect(planAids(s, p).receiver).toBe(-1);
  });

  it('receiver ring colour: the human whose ctrl.receiver is the target (co-op), else the first human on the side', () => {
    const s = makeState();
    human(s, 0, 0, 9);
    human(s, 1, 0, 10);
    s.ball.passTarget = 6; s.ball.lastTouchTeam = 0;
    const p = createAidPlan();
    expect(planAids(s, p).receiverHuman).toBe(0);
    s.ctrl[1]!.receiver = 6;
    expect(planAids(s, p).receiverHuman).toBe(1);
    // A human on the other side receives in his own colour.
    const s2 = makeState();
    human(s2, 0, 0, 9);
    human(s2, 1, 1, 20);
    s2.ball.passTarget = 17; s2.ball.lastTouchTeam = 1;
    expect(planAids(s2, p).receiverHuman).toBe(1);
  });
});

// ======================================================================== landing marker

/** Lofted ball from (x0, z0) with velocity (vx, vy, vz), kicked at tick `tick`. */
function loft(s: SimState, vx: number, vy: number, vz: number, sx = 0, sz = 0): void {
  const b = s.ball;
  b.x = -10; b.y = BALL_RADIUS; b.z = 4; b.vx = vx; b.vy = vy; b.vz = vz; b.sx = sx; b.sy = 0; b.sz = sz;
  b.grounded = 0; b.bounces = 0; b.owner = -1; b.heldBy = -1; b.shotBy = -1; b.inNet = 0;
  b.lastKickTick = s.tick; b.touchedTick = s.tick; b.lastTouchTeam = 0;
}

/** Step the ball with the sim's own per-tick physics (SIM-02 ballStepTick) and advance the tick. */
function stepBall(s: SimState): void {
  const b = s.ball;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  ballStepTick(b, null);
  s.tick++;
}

describe('GFX-13 high-ball landing marker', () => {
  it('landing point maths: the marker is exactly where and when the sim ball first comes down to 0.5 m', () => {
    const s = makeState();
    s.tick = 500;
    loft(s, 16, 11, 3, 0, 6);
    const t = createLandingTracker();
    expect(updateLanding(t, s)).toBe(true);
    expect(t.apex).toBeGreaterThan(MARKER_TUNING.highBallApex);
    // Fly the real ball and find the first descending sample at or below 0.5 m.
    const b: BallState = createBallState();
    copyBallState(b, s.ball);
    let above = b.y > 0.5, landTick = -1;
    for (let k = 1; k <= 180 && landTick < 0; k++) {
      ballStepTick(b, null);
      if (b.y > 0.5) above = true;
      else if (above) landTick = 500 + k;
    }
    expect(landTick).toBe(t.landTick);
    expect(t.x).toBe(b.x);
    expect(t.z).toBe(b.z);
    expect(t.x).toBeGreaterThan(-10 + 10); // carried well down the pitch
  });

  it('follows the flight without re-predicting, then hides on landing', () => {
    const s = makeState();
    s.tick = 100;
    loft(s, 14, 12, -2);
    const t = createLandingTracker();
    updateLanding(t, s);
    const land = t.landTick, x = t.x, z = t.z;
    let shown = 0;
    while (s.tick < land) {
      stepBall(s);
      const on = updateLanding(t, s);
      if (s.tick < land) {
        expect(on, `tick ${s.tick}`).toBe(true);
        expect(t.x).toBe(x);
        expect(t.z).toBe(z);
        shown++;
      }
    }
    expect(shown).toBe(land - 101);
    expect(t.show).toBe(false); // landed
    expect(t.predictions).toBe(1); // one prediction for the whole flight, not one per frame
    // After the bounce the next flight is predicted once; it shows again only if that bounce is itself a high ball.
    for (let i = 0; i < 30; i++) {
      stepBall(s);
      if (updateLanding(t, s)) {
        expect(t.bounces).toBeGreaterThan(0);
        expect(t.apex).toBeGreaterThanOrEqual(MARKER_TUNING.highBallApex);
        expect(t.landTick).toBeGreaterThan(land);
      }
    }
    expect(t.predictions).toBeLessThanOrEqual(3);
  });

  it('a low driven ball (apex under 2 m), a shot, a ball in hands / owned / in the net or a non-play phase get no marker', () => {
    const s = makeState();
    const t = createLandingTracker();
    loft(s, 22, 3, 0);
    expect(updateLanding(t, s)).toBe(false);
    loft(s, 14, 12, 0);
    expect(updateLanding(t, s)).toBe(true);
    s.ball.shotBy = 9;
    expect(updateLanding(t, s)).toBe(false);
    s.ball.shotBy = -1; s.ball.heldBy = 0; s.ball.owner = 0;
    expect(updateLanding(t, s)).toBe(false);
    s.ball.heldBy = -1; s.ball.owner = -1; s.ball.inNet = 1;
    expect(updateLanding(t, s)).toBe(false);
    s.ball.inNet = 0; s.match.phase = MatchPhase.GOAL;
    expect(updateLanding(t, s)).toBe(false);
    s.match.phase = MatchPhase.IN_PLAY;
    expect(updateLanding(t, s)).toBe(true);
    // Resting ball: nothing to predict.
    const r = makeState();
    expect(updateLanding(createLandingTracker(), r)).toBe(false);
  });

  it('re-predicts on a touch, when the ball strays from the path, and on a rewind (replay / new state)', () => {
    const s = makeState();
    s.tick = 200;
    loft(s, 14, 12, 0);
    const t = createLandingTracker();
    updateLanding(t, s);
    for (let i = 0; i < 10; i++) { stepBall(s); updateLanding(t, s); }
    expect(t.predictions).toBe(1);
    const x0 = t.x;
    // A header redirects the ball (contact bookkeeping changes touchedTick).
    s.ball.vx = -8; s.ball.vy = 6; s.ball.touchedTick = s.tick;
    updateLanding(t, s);
    expect(t.predictions).toBe(2);
    expect(t.x).toBeLessThan(x0);
    // Moved without bookkeeping: strays from the predicted path.
    stepBall(s); updateLanding(t, s);
    expect(t.predictions).toBe(2);
    s.ball.z += 3;
    updateLanding(t, s);
    expect(t.predictions).toBe(3);
    // Rewind.
    s.tick -= 50;
    updateLanding(t, s);
    expect(t.predictions).toBe(4);
  });

  it('a flight longer than the 3 s horizon re-predicts every few ticks until the landing comes into range', () => {
    const s = makeState();
    s.tick = 0;
    loft(s, 6, 30, 0); // ~6 s hang
    const t = createLandingTracker();
    expect(updateLanding(t, s)).toBe(false);
    expect(t.found).toBe(false);
    let firstShow = -1;
    for (let i = 0; i < 400 && firstShow < 0; i++) {
      stepBall(s);
      if (updateLanding(t, s)) firstShow = s.tick;
    }
    expect(firstShow).toBeGreaterThan(0);
    expect(t.predictions).toBeLessThan(400 / MARKER_TUNING.predictRefreshTicks + 4);
  });

  it('landing ring shrinks from far to near radius as the landing approaches', () => {
    expect(landingRadius(10)).toBe(MARKER_TUNING.landRadiusFar);
    expect(landingRadius(0)).toBe(MARKER_TUNING.landRadiusNear);
    expect(landingRadius(-1)).toBe(MARKER_TUNING.landRadiusNear);
    expect(landingRadius(Number.NaN)).toBe(MARKER_TUNING.landRadiusNear);
    expect(landingRadius(0.3)).toBeLessThan(landingRadius(0.9));
  });
});

// ======================================================================== off-screen arrow maths

describe('GFX-13 off-screen arrow maths', () => {
  const cam = makeCtx().camera;
  const view = (x: number, y: number, z: number): Vector3 => new Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse);
  const pe = cam.projectionMatrix.elements;

  it('on-screen targets show no arrow; the projection matches three.js Vector3.project', () => {
    const a = createEdgeArrow();
    for (const [x, z] of [[0, 0], [10, 5], [-12, -20], [15, 25]] as const) {
      const v = view(x, 0, z);
      expect(edgeArrow(v.x, v.y, v.z, cam.near, pe, W, H, 30, a)).toBe(false);
      const p = toScreen(cam, x, 0, z);
      expect(p.x > 0 && p.x < W && p.y > 0 && p.y < H).toBe(true);
    }
  });

  it('a ball off the right edge: arrow on the right inset edge, on the ray from the screen centre, pointing right', () => {
    const a = createEdgeArrow();
    const v = view(50, 0.11, 6);
    expect(edgeArrow(v.x, v.y, v.z, cam.near, pe, W, H, 30, a)).toBe(true);
    const p = toScreen(cam, 50, 0.11, 6);
    expect(p.x).toBeGreaterThan(W);
    expect(a.x).toBeCloseTo(W - 30, 6);
    expect(a.dx).toBeGreaterThan(0.9);
    // Collinear with the centre and the projected ball.
    const cross = (a.x - W / 2) * (p.y - H / 2) - (a.y - H / 2) * (p.x - W / 2);
    expect(Math.abs(cross)).toBeLessThan(1e-6 * W * H);
    expect(Math.hypot(a.dx, a.dy)).toBeCloseTo(1, 9);
  });

  it('glitch: camera losing a high ball - a ball above the top of the screen gets an arrow on the top edge pointing up', () => {
    const a = createEdgeArrow();
    const v = view(3, 45, 0);
    expect(toScreen(cam, 3, 45, 0).y).toBeLessThan(0);
    expect(edgeArrow(v.x, v.y, v.z, cam.near, pe, W, H, 30, a)).toBe(true);
    expect(a.y).toBeCloseTo(30, 6);
    expect(a.dy).toBeLessThan(-0.9);
    expect(a.x).toBeGreaterThan(30);
    expect(a.x).toBeLessThan(W - 30);
  });

  it('a target behind the camera points by its view-plane offset; straight behind points down', () => {
    const a = createEdgeArrow();
    // Behind and to the right of the camera.
    const v = view(30, 24, 120);
    expect(v.z).toBeGreaterThan(0);
    expect(edgeArrow(v.x, v.y, v.z, cam.near, pe, W, H, 30, a)).toBe(true);
    expect(a.dx).toBeGreaterThan(0);
    expect(edgeArrow(0, 0, 5, cam.near, pe, W, H, 30, a)).toBe(true);
    expect(a.dx).toBe(0);
    expect(a.dy).toBe(1);
    expect(a.y).toBeCloseTo(H - 30, 6);
  });

  it('corners clamp to the inset rectangle; junk input and empty viewports show nothing', () => {
    const a = createEdgeArrow();
    const v = view(80, 30, -60);
    expect(edgeArrow(v.x, v.y, v.z, cam.near, pe, W, H, 30, a)).toBe(true);
    expect(a.x).toBeGreaterThanOrEqual(30 - 1e-9);
    expect(a.x).toBeLessThanOrEqual(W - 30 + 1e-9);
    expect(a.y).toBeGreaterThanOrEqual(30 - 1e-9);
    expect(a.y).toBeLessThanOrEqual(H - 30 + 1e-9);
    expect(Math.abs(a.x - 30) < 1e-6 || Math.abs(a.x - (W - 30)) < 1e-6 || Math.abs(a.y - 30) < 1e-6 || Math.abs(a.y - (H - 30)) < 1e-6).toBe(true);
    expect(edgeArrow(Number.NaN, 0, -10, cam.near, pe, W, H, 30, a)).toBe(false);
    expect(edgeArrow(100, 0, -10, cam.near, pe, 0, H, 30, a)).toBe(false);
    expect(a.show).toBe(false);
  });

  it('glitch: ball hidden under touch controls - a bottom-edge arrow rises above the button cluster and stick zones', () => {
    const zones: TouchZones = touchZones(createDefaultSettings(), { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false });
    const a = createEdgeArrow();
    // Bottom right (button cluster).
    a.show = true; a.x = W - 60; a.y = H - 30; a.dx = 0.2; a.dy = 0.98;
    liftArrowAboveZones(a, W, H, 30, zones);
    expect(a.y).toBeLessThanOrEqual(H - 30 - zones.clusterH * 0.99);
    // Bottom left (stick zone).
    a.x = 40; a.y = H - 30;
    liftArrowAboveZones(a, W, H, 30, zones);
    expect(a.y).toBeLessThan(H - 30);
    // Bottom centre, clear of both: unchanged.
    a.x = W / 2; a.y = H - 30;
    liftArrowAboveZones(a, W, H, 30, zones);
    expect(a.y).toBe(H - 30);
  });

  it('marker size: ~0.8 m at broadcast distance, clamped to 20..40 CSS px when near or far', () => {
    const pe5 = pe[5]!;
    const at = (d: number): number => markerUnit(d, pe5, H, 0.8, 20, 40) / metresPerPx(d, pe5, H);
    expect(at(60)).toBeGreaterThan(20);
    expect(at(60)).toBeLessThan(40);
    expect(markerUnit(60, pe5, H, 0.8, 20, 40)).toBeCloseTo(0.8, 9);
    expect(at(5)).toBeCloseTo(40, 9);
    expect(at(400)).toBeCloseTo(20, 9);
  });
});

// ======================================================================== quad batch

describe('GFX-13 quad batch', () => {
  it('writes quads with a static two-triangle index, sets the draw range, and ignores writes past capacity', () => {
    const bt = new QuadBatch(2);
    const idx = bt.geometry.index!.array;
    expect(Array.from(idx)).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    bt.begin();
    for (let q = 0; q < 3; q++) {
      for (let k = 0; k < 4; k++) bt.corner(k, q, k, 0);
      expect(bt.commit(10, 20, 30, 40)).toBe(q < 2);
    }
    bt.end();
    expect(bt.quads).toBe(2);
    expect(bt.geometry.drawRange.count).toBe(12);
    expect(bt.position[12 + 3]).toBe(1); // quad 1, corner 1, x
    expect(Array.from(bt.colour.slice(16, 20))).toEqual([10, 20, 30, 40]);
    bt.begin(); bt.end();
    expect(bt.geometry.drawRange.count).toBe(0);
    bt.dispose();
  });
});

// ======================================================================== module (headless)

describe('GFX-13 markers module (headless)', () => {
  function setup(cb = false): { ctx: RenderContext; s: SimState; mod: ReturnType<typeof createMarkers> } {
    const settings = createDefaultSettings();
    settings.accessibility.colourBlindMarkers = cb;
    const ctx = makeCtx(settings);
    const s = makeState();
    human(s, 0, 0, 9);
    human(s, 1, 1, 20);
    s.players[9]!.x = -6; s.players[9]!.z = 4;
    s.players[20]!.x = 8; s.players[20]!.z = -3;
    const mod = createMarkers(ctx);
    mod.setMatch!(s, []);
    return { ctx, s, mod };
  }

  function colours(mod: ReturnType<typeof createMarkers>, which: 'ground' | 'overlay'): Set<string> {
    const g = (which === 'ground' ? mod.ground : mod.overlay).geometry;
    const c = g.attributes.color!.array as Uint8Array;
    const out = new Set<string>();
    for (let v = 0; v < g.drawRange.count / 6 * 4; v++) out.add(`${c[v * 4]},${c[v * 4 + 1]},${c[v * 4 + 2]}`);
    return out;
  }

  it('two drawables (ground + overlay batches), one draw call each; hidden when nothing shows', () => {
    const { ctx, s, mod } = setup();
    expect(ctx.scene.children.filter((c) => c instanceof Mesh)).toHaveLength(2);
    // A transparent double-sided material is drawn in two passes by three.js unless forced to a single pass.
    for (const m of [mod.ground, mod.overlay]) {
      const mat = m.material as MeshBasicMaterial;
      expect(mat.transparent).toBe(true);
      expect(mat.side !== DoubleSide || mat.forceSinglePass).toBe(true);
    }
    s.ctrl[0]!.kind = ControllerKind.NONE;
    s.ctrl[1]!.kind = ControllerKind.NONE;
    mod.update(frame(s));
    expect(mod.ground.visible).toBe(false);
    expect(mod.overlay.visible).toBe(false);
  });

  it('controlled players: ember and cyan rings and overhead shapes; the marker sits above the head on screen, 20..40 px wide', () => {
    const { ctx, s, mod } = setup();
    mod.update(frame(s));
    expect(mod.ground.visible && mod.overlay.visible).toBe(true);
    // 32 ring quads per human; chevron (2 quads) and diamond (1 quad), each with a drop shadow.
    expect(mod.ground.geometry.drawRange.count / 6).toBe(64);
    expect(mod.overlay.geometry.drawRange.count / 6).toBe(2 * 2 + 1 * 2);
    const gc = colours(mod, 'ground');
    expect(gc.size).toBe(2);
    // Overlay corner positions of the P1 chevron (quads 2..3 after its 2 shadow quads) project above the head.
    const pos = mod.overlay.geometry.attributes.position!.array as Float32Array;
    const ht = s.attrs[9]!.height / 180;
    const head = toScreen(ctx.camera, -6, 1.9 * ht, 4);
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let v = 8; v < 16; v++) {
      const p = toScreen(ctx.camera, pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    expect(maxY).toBeLessThan(head.y); // whole marker above the top of the head
    const tip = toScreen(ctx.camera, -6, MARKER_Y * ht, 4);
    expect(maxY).toBeCloseTo(tip.y, 3); // tip at MARKER_Y
    expect(maxX - minX).toBeGreaterThanOrEqual(MARKER_TUNING.markerMinPx - 0.5);
    expect(maxX - minX).toBeLessThanOrEqual(MARKER_TUNING.markerMaxPx + 0.5);
    expect(HUMAN_SHAPES).toEqual([MarkerShape.CHEVRON, MarkerShape.DIAMOND]);
    expect(HUMAN_COLOURS).toEqual([0xff6b35, 0x35d0ff]);
  });

  it('colour-blind mode adds the "1" / "2" labels and a dashed ring for P2', () => {
    const a = setup(false);
    a.mod.update(frame(a.s));
    const g0 = a.mod.ground.geometry.drawRange.count / 6, o0 = a.mod.overlay.geometry.drawRange.count / 6;
    const b = setup(true);
    b.mod.update(frame(b.s));
    expect(b.mod.ground.geometry.drawRange.count / 6).toBe(g0 - 32 + 8); // P2: 8 dashes instead of a 32-quad ring
    const glyphQuads = (GLYPH_1.length + GLYPH_2.length) / 8;
    expect(b.mod.overlay.geometry.drawRange.count / 6).toBe(o0 + 2 * glyphQuads);
    // Settings changes take effect on the next frame (ctx.settings is replaced by index.ts).
    const s2 = createDefaultSettings();
    b.ctx.settings = s2;
    b.mod.onSettings?.(s2);
    b.mod.update(frame(b.s));
    expect(b.mod.overlay.geometry.drawRange.count / 6).toBe(o0);
  });

  it('receiver ring, faint next-switch marker, power bar and landing target all draw; shots draw no target', () => {
    const { s, mod } = setup();
    mod.update(frame(s));
    const g0 = mod.ground.geometry.drawRange.count / 6, o0 = mod.overlay.geometry.drawRange.count / 6;
    s.ctrl[0]!.nextSwitch = 6;
    s.ctrl[0]!.powerBtn = 1; s.ctrl[0]!.power = 0.5;
    s.ball.passTarget = 7; s.ball.lastTouchTeam = 0;
    loft(s, 12, 11, 0);
    mod.update(frame(s, 250));
    expect(mod.landing.show).toBe(true);
    expect(mod.plan.receiver).toBe(7);
    // ground: + receiver (32 + 4 ticks) + landing (outline 32 + ring 32 + dot 16 + 4 ticks)
    expect(mod.ground.geometry.drawRange.count / 6).toBe(g0 + 36 + 84);
    // overlay: + faint chevron (2 + 2 shadow) + power bar (frame, background, fill)
    expect(mod.overlay.geometry.drawRange.count / 6).toBe(o0 + 4 + 3);
    s.ball.shotBy = 9;
    mod.update(frame(s, 300));
    expect(mod.landing.show).toBe(false);
    const pos = mod.ground.geometry.attributes.position!.array as Float32Array;
    for (let i = 0; i < mod.ground.geometry.drawRange.count / 6 * 12; i++) expect(Number.isFinite(pos[i]!)).toBe(true);
  });

  it('off-screen ball: an arrow on the screen edge pointing at it, drawn at a constant ~30 px', () => {
    const { ctx, s, mod } = setup();
    mod.update(frame(s));
    const o0 = mod.overlay.geometry.drawRange.count / 6;
    s.ball.x = 52; s.ball.z = 5;
    mod.update(frame(s));
    expect(mod.arrow.show).toBe(true);
    expect(mod.arrow.x).toBeCloseTo(W - MARKER_TUNING.arrowInset, 6);
    const n = mod.overlay.geometry.drawRange.count / 6;
    expect(n).toBeGreaterThan(o0);
    // An ink badge, then the white arrow inside it; both project around the arrow centre, within ~arrowPx.
    const badgeQuads = SHAPE_BADGE.length / 8, arrowQuads = SHAPE_ARROW.length / 8;
    expect(n - o0).toBe(badgeQuads + arrowQuads);
    const pos = mod.overlay.geometry.attributes.position!.array as Float32Array;
    const col = mod.overlay.geometry.attributes.color!.array as Uint8Array;
    const spread = (q0: number, q1: number): number => {
      let maxD = 0;
      for (let v = q0 * 4; v < q1 * 4; v++) {
        const p = toScreen(ctx.camera, pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
        maxD = Math.max(maxD, Math.hypot(p.x - mod.arrow.x, p.y - mod.arrow.y));
      }
      return maxD;
    };
    const arrowD = spread(o0 + badgeQuads, n);
    expect(arrowD).toBeGreaterThan(MARKER_TUNING.arrowPx * 0.4);
    expect(arrowD).toBeLessThan(MARKER_TUNING.arrowPx * 0.9);
    // The badge surrounds the arrow (its rim lies outside every arrow corner) and is dark; the arrow is white.
    expect(spread(o0, o0 + badgeQuads)).toBeGreaterThan(arrowD);
    expect(col[o0 * 16]! + col[o0 * 16 + 1]! + col[o0 * 16 + 2]!).toBeLessThan(30);
    expect(col[(o0 + badgeQuads) * 16]).toBe(255);
    // Back on screen: no arrow.
    s.ball.x = 0;
    mod.update(frame(s));
    expect(mod.arrow.show).toBe(false);
  });

  it('nothing in goal / celebration / replay phases; clearMatch hides; dispose removes both meshes', () => {
    const { ctx, s, mod } = setup();
    s.match.phase = MatchPhase.REPLAY;
    s.ball.x = 52;
    mod.update(frame(s));
    expect(mod.ground.visible || mod.overlay.visible).toBe(false);
    s.match.phase = MatchPhase.IN_PLAY;
    mod.update(frame(s));
    expect(mod.overlay.visible).toBe(true);
    mod.clearMatch!();
    expect(mod.ground.visible || mod.overlay.visible).toBe(false);
    mod.update(frame(s));
    expect(mod.ground.visible || mod.overlay.visible).toBe(false);
    mod.dispose();
    expect(ctx.scene.children.filter((c) => c instanceof Mesh)).toHaveLength(0);
  });

  it('landing target timing: the ring radius tracks the seconds left to landing', () => {
    const { s, mod } = setup();
    s.tick = 1000;
    loft(s, 12, 11, 0);
    mod.update(frame(s));
    const left = (mod.landing.landTick - s.tick) / TICK_HZ; // alpha 1: the frame shows tick s.tick
    expect(left).toBeGreaterThan(0.5);
    expect(mod.landing.radius).toBeCloseTo(landingRadius(left), 9);
    expect(mod.landing.radius).toBeGreaterThan(MARKER_TUNING.landRadiusNear);
    // Fly on: the ring shrinks toward the near radius as the landing approaches.
    let last = mod.landing.radius;
    while (s.tick < mod.landing.landTick - 1) {
      stepBall(s);
      mod.update(frame(s));
      expect(mod.landing.radius).toBeLessThanOrEqual(last + 1e-12);
      last = mod.landing.radius;
    }
    expect(last).toBeLessThan(MARKER_TUNING.landRadiusNear + 0.05);
  });
});
