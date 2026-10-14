/**
 * [GFX-15] Set-piece, intro and replay cameras: the director's decision table per phase / restart, shot framing
 * (behind the taker for free kicks near goal, penalties and goal kicks; raised corner view; establishing orbit; replay
 * side and behind-goal angles) across spots, ends and aspects, cut-or-blend switching (blend <= 0.3 s, cuts for big
 * moves, cuts only with reduced motion, never a fly across the pitch), the projector and stick rotation following the
 * active camera ("up" aims toward goal behind the taker), skippable establishing shots and replay angles driven by the
 * GFX-16 playback. THREE maths only, no WebGL.
 */
import { describe, expect, it } from 'vitest';
import { Euler, PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import {
  GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_SPOT_DIST, TICK_HZ,
} from '../../src/contracts/constants';
import { CameraType, MatchPhase, QualityTier, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_CAMERA } from '../../src/contracts/tuning';
import { screenToPitchAxes } from '../../src/input/axes';
import { createBroadcastCamera, touchZoneMargin, touchZones, type BroadcastCameraModule } from '../../src/render/camera/broadcast';
import {
  blendWeight, canBlend, chooseShot, CineShot, cornerPose, createCinematicCamera, createCinePose, createDirectorInput,
  establishingPose, LOCAL_TUNING, mixPose, poseAngle, poseDistance, replayGoalPose, replaySidePose, rotatesStick,
  stickRotationForYaw, takerPose, type CinematicCameraModule, type CinePose, type DirectorInput,
} from '../../src/render/camera/cinematic';
import { projectPitchToScreen } from '../../src/render/camera/project';
import { fillInterp } from '../../src/render/index';
import { createReplay, ReplayAngle, replayPlaybackOf, type ReplayModule } from '../../src/render/replay';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const LT = LOCAL_TUNING;
const ASPECTS: [number, number][] = [[1180, 820], [1024, 768], [1366, 768]];

function makeCtx(w = 1180, h = 820, reduced = false): RenderContext {
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(), settings: createDefaultSettings(),
    clubs: [], size: { cssW: w, cssH: h, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { type: CameraType.BROADCAST, height: 10, zoom: 10 }, reducedMotion: reduced, night: false,
  };
}

/** A camera placed at a pose (for projection checks). */
function camFor(p: CinePose, w: number, h: number): PerspectiveCamera {
  const c = new PerspectiveCamera(p.fov, w / h, 2, 600);
  c.position.set(p.x, p.y, p.z);
  c.quaternion.setFromEuler(new Euler(-p.pitch, p.yaw, 0, 'YXZ'));
  c.updateMatrixWorld(true);
  c.updateProjectionMatrix();
  return c;
}

/** Screen fraction (0..1 both axes, y down) of a world point; null when behind the camera. */
function screen(p: CinePose, w: number, h: number, x: number, y: number, z: number): { x: number; y: number } | null {
  const o = { x: 0, y: 0 };
  if (!projectPitchToScreen(camFor(p, w, h), w, h, x, y, z, o)) return null;
  return { x: o.x / w, y: o.y / h };
}

function inView(q: { x: number; y: number } | null, m = 0.02): boolean {
  return q !== null && q.x >= m && q.x <= 1 - m && q.y >= m && q.y <= 1 - m;
}

function insideLimits(p: CinePose): boolean {
  return Math.abs(p.x) <= LT.maxX + 1e-9 && Math.abs(p.z) <= LT.maxZ + 1e-9 && p.y >= LT.minY - 1e-9 && p.y < 40;
}

function goalVisible(p: CinePose, end: number, w: number, h: number): boolean {
  const gx = end * HALF_LENGTH;
  return inView(screen(p, w, h, gx, 0, -GOAL_HALF_WIDTH)) && inView(screen(p, w, h, gx, 0, GOAL_HALF_WIDTH))
    && inView(screen(p, w, h, gx, GOAL_HEIGHT, -GOAL_HALF_WIDTH)) && inView(screen(p, w, h, gx, GOAL_HEIGHT, GOAL_HALF_WIDTH));
}

const zones = touchZones(createDefaultSettings(), { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false });
/** Ball above the bottom 15% and clear of the touch controls. */
function ballClear(q: { x: number; y: number } | null, w: number, h: number): boolean {
  if (!q) return false;
  const margin = Math.max(T_CAMERA.ballBottomMargin, touchZoneMargin(q.x * w, w, h, zones));
  return q.y <= 1 - margin && q.y >= 0.1 && q.x >= 0.05 && q.x <= 0.95;
}

/** Stick "up" (screen y down) mapped to pitch through the rotation. */
function stickUp(rot: number): { x: number; z: number } {
  const o = { x: 0, y: 0 };
  screenToPitchAxes(0, -1, rot, o);
  return { x: o.x, z: o.y };
}

class FakeEvents implements EventBuffer {
  list: SimEvent[] = [];
  get count(): number { return this.list.length; }
  get(i: number): Readonly<SimEvent> { return this.list[i]!; }
  begin(): void { this.list = []; }
  emit(type: EventType, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0): void { this.list.push({ type, tick: 0, a, b, c, d, x, y, z }); }
}

// ====================================================================================== decision table

describe('GFX-15 director decision table', () => {
  const base = (patch: Partial<DirectorInput>): DirectorInput => ({ ...createDirectorInput(), ...patch });

  it('per phase', () => {
    const want: Record<number, CineShot> = {
      [MatchPhase.PRE_MATCH]: CineShot.ESTABLISHING,
      [MatchPhase.KICK_OFF]: CineShot.NONE,
      [MatchPhase.IN_PLAY]: CineShot.NONE,
      [MatchPhase.THROW_IN]: CineShot.NONE,
      [MatchPhase.GOAL_KICK]: CineShot.BEHIND_TAKER,
      [MatchPhase.CORNER]: CineShot.CORNER,
      [MatchPhase.PENALTY]: CineShot.BEHIND_TAKER,
      [MatchPhase.GOAL]: CineShot.NONE,
      [MatchPhase.CELEBRATION]: CineShot.NONE,
      [MatchPhase.REPLAY]: CineShot.NONE,
      [MatchPhase.HALF_TIME]: CineShot.ESTABLISHING,
      [MatchPhase.FULL_TIME]: CineShot.ESTABLISHING,
      [MatchPhase.EXTRA_TIME]: CineShot.ESTABLISHING,
      [MatchPhase.SHOOT_OUT]: CineShot.BEHIND_TAKER,
      [MatchPhase.POST_MATCH]: CineShot.ESTABLISHING,
    };
    for (const [ph, shot] of Object.entries(want)) expect(chooseShot(base({ phase: Number(ph) })), `phase ${ph}`).toBe(shot);
  });

  it('free kicks: behind the taker near goal, main camera further out', () => {
    expect(chooseShot(base({ phase: MatchPhase.FREE_KICK, goalDist: 20 }))).toBe(CineShot.BEHIND_TAKER);
    expect(chooseShot(base({ phase: MatchPhase.FREE_KICK, goalDist: LT.fkNearGoal }))).toBe(CineShot.BEHIND_TAKER);
    expect(chooseShot(base({ phase: MatchPhase.FREE_KICK, goalDist: LT.fkNearGoal + 0.1 }))).toBe(CineShot.NONE);
    expect(chooseShot(base({ phase: MatchPhase.FREE_KICK, goalDist: 70 }))).toBe(CineShot.NONE);
  });

  it('replays override every phase; establishing requests and skips', () => {
    for (let ph = 0; ph <= MatchPhase.POST_MATCH; ph++) {
      expect(chooseShot(base({ phase: ph, replayPlaying: true, replayAngle: ReplayAngle.SIDE }))).toBe(CineShot.REPLAY_SIDE);
      expect(chooseShot(base({ phase: ph, replayPlaying: true, replayAngle: ReplayAngle.BEHIND_GOAL }))).toBe(CineShot.REPLAY_GOAL);
    }
    expect(chooseShot(base({ phase: MatchPhase.KICK_OFF, establishing: true }))).toBe(CineShot.ESTABLISHING);
    expect(chooseShot(base({ phase: MatchPhase.KICK_OFF, establishing: true, skipped: true }))).toBe(CineShot.NONE);
    expect(chooseShot(base({ phase: MatchPhase.PRE_MATCH, skipped: true }))).toBe(CineShot.NONE);
    expect(chooseShot(base({ phase: MatchPhase.IN_PLAY, holdShot: true }))).toBe(CineShot.BEHIND_TAKER);
  });

  it('stick rotation only for the behind-the-taker style views', () => {
    expect(rotatesStick(CineShot.BEHIND_TAKER)).toBe(true);
    expect(rotatesStick(CineShot.CORNER)).toBe(true);
    for (const s of [CineShot.NONE, CineShot.ESTABLISHING, CineShot.REPLAY_SIDE, CineShot.REPLAY_GOAL]) expect(rotatesStick(s)).toBe(false);
    expect(stickRotationForYaw(0)).toBe(0);
    expect(stickRotationForYaw(-Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
    expect(Math.abs(stickRotationForYaw(7))).toBeLessThanOrEqual(Math.PI);
  });
});

// ====================================================================================== shot framing

describe('GFX-15 shot framing', () => {
  it('behind the taker (free kicks near goal): ball low-centre and clear of the controls, the whole goal in view', () => {
    let n = 0;
    for (const end of [1, -1]) {
      for (let d = 12; d <= LT.fkNearGoal; d += 4) {
        for (let ang = -60; ang <= 60; ang += 15) {
          const a = (ang * Math.PI) / 180;
          const sx = end * (HALF_LENGTH - d * Math.cos(a)), sz = d * Math.sin(a);
          if (Math.abs(sz) > HALF_WIDTH - 1 || Math.abs(sx) > HALF_LENGTH - 1) continue;
          const p = takerPose(sx, sz, end * HALF_LENGTH, 0, false, createCinePose());
          expect(insideLimits(p)).toBe(true);
          // Behind the ball: further from the goal than the ball.
          expect(Math.hypot(p.x - end * HALF_LENGTH, p.z)).toBeGreaterThan(Math.hypot(sx - end * HALF_LENGTH, sz));
          for (const [w, h] of ASPECTS) {
            const ball = screen(p, w, h, sx, 0.11, sz);
            expect(ballClear(ball, w, h), `ball ${sx.toFixed(1)},${sz.toFixed(1)} ${w}x${h} ${JSON.stringify(ball)}`).toBe(true);
            expect(goalVisible(p, end, w, h), `goal from ${sx.toFixed(1)},${sz.toFixed(1)} ${w}x${h}`).toBe(true);
          }
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(40);
  });

  it('penalties at both ends', () => {
    for (const end of [1, -1]) {
      const sx = end * (HALF_LENGTH - PENALTY_SPOT_DIST);
      const p = takerPose(sx, 0, end * HALF_LENGTH, 0, false, createCinePose());
      expect(p.z).toBeCloseTo(0, 9);
      for (const [w, h] of ASPECTS) {
        const ball = screen(p, w, h, sx, 0.11, 0)!;
        expect(ballClear(ball, w, h)).toBe(true);
        expect(ball.x).toBeCloseTo(0.5, 6);
        expect(goalVisible(p, end, w, h)).toBe(true);
      }
    }
  });

  it('goal kicks: in front of the own goal (frame behind the camera), ball and the pitch ahead in view', () => {
    for (const end of [1, -1]) {
      for (const z of [-9.16, -4.6, 0, 4.6, 9.16]) {
        const sx = end * (HALF_LENGTH - 5.5);
        const p = takerPose(sx, z, -end * HALF_LENGTH, 0, true, createCinePose());
        expect(Math.abs(p.x)).toBeLessThanOrEqual(HALF_LENGTH - LT.goalKickLineInset + 1e-9);
        expect(insideLimits(p)).toBe(true);
        for (const [w, h] of ASPECTS) {
          expect(ballClear(screen(p, w, h, sx, 0.11, z), w, h)).toBe(true);
          // 40 m up-field and the halfway line's centre are visible.
          expect(inView(screen(p, w, h, sx - end * 40, 0, z))).toBe(true);
          expect(inView(screen(p, w, h, 0, 0, 0))).toBe(true);
          // The own goal (posts) is behind the camera: never in view.
          expect(inView(screen(p, w, h, end * HALF_LENGTH, 1, GOAL_HALF_WIDTH), 0)).toBe(false);
        }
        // "Up" on the stick aims up-field.
        const up = stickUp(stickRotationForYaw(p.yaw));
        expect(up.x * -end).toBeGreaterThan(0.95);
      }
    }
  });

  it('raised corner view: ball low and clear, the goal mouth and the penalty spot in view, all four corners', () => {
    for (const ex of [1, -1]) {
      for (const ez of [1, -1]) {
        const cx = ex * (HALF_LENGTH - 0.6), cz = ez * (HALF_WIDTH - 0.6);
        const p = cornerPose(cx, cz, createCinePose());
        expect(insideLimits(p)).toBe(true);
        expect(p.y).toBeGreaterThanOrEqual(5); // raised
        // Outside the pitch, behind the flag.
        expect(Math.abs(p.z) > HALF_WIDTH || Math.abs(p.x) > HALF_LENGTH).toBe(true);
        for (const [w, h] of ASPECTS) {
          expect(ballClear(screen(p, w, h, cx, 0.11, cz), w, h), `corner ${ex},${ez} ${w}x${h}`).toBe(true);
          expect(goalVisible(p, ex, w, h)).toBe(true);
          expect(inView(screen(p, w, h, ex * (HALF_LENGTH - PENALTY_SPOT_DIST), 0, 0))).toBe(true);
        }
      }
    }
  });

  it('establishing orbit: inside the bowl, centre spot centred, slow, still with reduced motion', () => {
    const a = createCinePose(), b = createCinePose();
    for (const dir of [1, -1]) {
      for (let t = 0; t <= 8; t += 0.5) {
        establishingPose(t, dir, false, a);
        expect(insideLimits(a)).toBe(true);
        const c = screen(a, 1180, 820, 0, 0, 0)!;
        expect(c.x).toBeCloseTo(0.5, 6);
        expect(c.y).toBeCloseTo(0.5, 6);
        establishingPose(t + 1 / 60, dir, false, b);
        expect(poseDistance(a, b)).toBeLessThan(0.25); // < 15 m/s
      }
      establishingPose(0, dir, true, a);
      establishingPose(5, dir, true, b);
      expect(poseDistance(a, b)).toBe(0);
    }
  });

  it('replay angles keep the ball centred and stay inside the limits', () => {
    const p = createCinePose();
    for (const end of [1, -1]) {
      for (const [bx, by, bz] of [[0, 0.11, 0], [end * 40, 2, 20], [end * 52, 1, -3], [end * 30, 8, -30]] as const) {
        replaySidePose(bx, by, bz, end, p);
        expect(insideLimits(p)).toBe(true);
        let q = screen(p, 1180, 820, bx, by, bz)!;
        expect(Math.abs(q.x - 0.5)).toBeLessThan(0.01);
        expect(Math.abs(q.y - 0.5)).toBeLessThan(0.01);
        expect(p.fov).toBeGreaterThanOrEqual(LT.replayFovMin);
        expect(p.fov).toBeLessThanOrEqual(LT.replayFovMax);
        replayGoalPose(bx, by, bz, end, 1, p);
        expect(insideLimits(p)).toBe(true);
        expect(Math.abs(p.x)).toBeGreaterThan(HALF_LENGTH + 2); // behind the goal (and its net)
        expect(p.y).toBeLessThan(GOAL_HEIGHT + 1.5); // low: just above the bar
        q = screen(p, 1180, 820, bx, by, bz)!;
        expect(Math.abs(q.x - 0.5)).toBeLessThan(0.01);
      }
    }
  });

  it('stick "up" aims toward goal behind the taker (both ends, wide angles)', () => {
    for (const end of [1, -1]) {
      for (const sz of [-20, 0, 15]) {
        const sx = end * (HALF_LENGTH - 22);
        const p = takerPose(sx, sz, end * HALF_LENGTH, 0, false, createCinePose());
        const up = stickUp(stickRotationForYaw(p.yaw));
        const gx = end * HALF_LENGTH - sx, gz = -sz, gl = Math.hypot(gx, gz);
        expect(up.x * gx / gl + up.z * gz / gl).toBeGreaterThan(0.999);
      }
    }
  });

  it('blend helpers: smoothstep weight, short-arc yaw, cut thresholds', () => {
    expect(blendWeight(0, 0.25)).toBe(0);
    expect(blendWeight(0.125, 0.25)).toBeCloseTo(0.5, 12);
    expect(blendWeight(0.3, 0.25)).toBe(1);
    expect(blendWeight(0.1, 0)).toBe(1);
    const a = { ...createCinePose(), yaw: Math.PI - 0.1 }, b = { ...createCinePose(), yaw: -Math.PI + 0.1 };
    const m = mixPose(a, b, 0.5, createCinePose());
    expect(Math.abs(Math.abs(m.yaw) - Math.PI)).toBeLessThan(1e-9);
    const p1 = takerPose(30, 5, HALF_LENGTH, 0, false, createCinePose());
    const p2 = takerPose(32, 4, HALF_LENGTH, 0, false, createCinePose());
    expect(canBlend(p1, p2)).toBe(true);
    const corner = cornerPose(HALF_LENGTH, HALF_WIDTH, createCinePose());
    expect(canBlend(p1, corner)).toBe(false);
    expect(poseAngle(p1, p1)).toBeCloseTo(0, 6);
    expect(T_CAMERA.blendTime).toBeLessThan(0.3);
  });
});

// ====================================================================================== module

interface Rig {
  ctx: RenderContext;
  bc: BroadcastCameraModule;
  cine: CinematicCameraModule;
  rep: ReplayModule;
  s: SimState;
  f: RenderFrame;
  ev: FakeEvents;
}

function makeRig(reduced = false): Rig {
  const ctx = makeCtx(1180, 820, reduced);
  const bc = createBroadcastCamera(ctx);
  const cine = createCinematicCamera(ctx);
  cine.setSettings(ctx.cameraSettings, reduced);
  bc.setSettings(ctx.cameraSettings, reduced);
  const rep = createReplay(ctx);
  const s = initMatch(createMatchConfig()) as SimState;
  s.match.phase = MatchPhase.IN_PLAY;
  bc.setMatch!(s, []);
  cine.setMatch!(s, []);
  rep.setMatch!(s, []);
  const f: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
  return { ctx, bc, cine, rep, s, f, ev: new FakeEvents() };
}

/** One frame in index.ts order: interp, replay, broadcast, cinematic. */
function frame(r: Rig, dtMs = 1000 / 60): void {
  r.f.prev = r.s; r.f.curr = r.s; r.f.alpha = 1;
  fillInterp(r.f.interp, r.s, r.s, 1);
  r.f.frame.dtMs = dtMs;
  r.f.frame.frame++;
  r.rep.update(r.f);
  r.bc.update(r.f);
  r.cine.update(r.f);
}

function events(r: Rig, ...evs: [EventType, number, number][]): void {
  r.ev.begin();
  for (const [t, a, b] of evs) r.ev.emit(t, a, b);
  r.cine.onEvents!(r.ev, r.s);
  r.bc.onEvents?.(r.ev, r.s);
  r.rep.onEvents!(r.ev, r.s);
}

function award(r: Rig, phase: MatchPhase, kind: RestartKind, team: number, x: number, z: number): void {
  const m = r.s.match;
  const from = m.phase;
  m.phase = phase;
  m.restart.kind = kind; m.restart.team = team; m.restart.x = x; m.restart.z = z; m.restart.taken = 0; m.restart.ready = 0;
  const b = r.s.ball;
  b.x = x; b.y = 0.11; b.z = z; b.vx = b.vy = b.vz = 0; b.owner = -1; b.shotBy = -1;
  events(r, [EventType.RESTART_AWARDED, kind, team], [EventType.PHASE_CHANGE, from, phase]);
}

function camPos(r: Rig): [number, number, number] {
  const p = r.ctx.camera.position;
  return [p.x, p.y, p.z];
}

describe('GFX-15 camera director in the frame pipeline', () => {
  it('in play: idle, the broadcast camera drives and the stick is unrotated', () => {
    const r = makeRig();
    for (let i = 0; i < 30; i++) frame(r);
    expect(r.cine.active).toBe(false);
    expect(r.cine.shot).toBe(CineShot.NONE);
    expect(r.cine.stickRotation()).toBe(0);
  });

  it('free kick near goal: cut to behind the taker; projector and stick follow; back to broadcast after the kick', () => {
    const r = makeRig();
    frame(r);
    r.s.teams[0]!.dir = 1;
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 30, 8);
    const cuts0 = r.cine.cuts;
    frame(r);
    expect(r.cine.active).toBe(true);
    expect(r.cine.shot).toBe(CineShot.BEHIND_TAKER);
    expect(r.cine.cuts).toBe(cuts0 + 1);
    expect(r.cine.blending).toBe(false);
    const want = takerPose(30, 8, HALF_LENGTH, 0, false, createCinePose());
    expect(poseDistance(r.cine.pose, want)).toBeLessThan(1e-6);
    expect(camPos(r)[0]).toBeCloseTo(want.x, 6);
    // Projector round trip on the active camera: the ball's screen point maps back to the ball.
    const sp = { x: 0, y: 0 }, pp = { x: 0, z: 0 };
    expect(r.cine.pitchToScreen(30, 0, 8, sp)).toBe(true);
    expect(r.cine.screenToPitch(sp.x, sp.y, pp)).toBe(true);
    expect(pp.x).toBeCloseTo(30, 3);
    expect(pp.z).toBeCloseTo(8, 3);
    // Stick "up" toward goal.
    const up = stickUp(r.cine.stickRotation());
    const gl = Math.hypot(HALF_LENGTH - 30, -8);
    expect(up.x * (HALF_LENGTH - 30) / gl + up.z * -8 / gl).toBeGreaterThan(0.999);
    for (let i = 0; i < 60; i++) frame(r);
    expect(r.cine.shot).toBe(CineShot.BEHIND_TAKER);
    // Taken as a pass: straight back to the broadcast camera.
    r.s.match.phase = MatchPhase.IN_PLAY;
    r.s.ball.shotBy = -1;
    frame(r);
    expect(r.cine.active).toBe(false);
    expect(r.cine.stickRotation()).toBe(0);
  });

  it('a free-kick shot holds the behind view while in flight, at most shotHold', () => {
    const r = makeRig();
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 28, -6);
    for (let i = 0; i < 10; i++) frame(r);
    r.s.match.phase = MatchPhase.IN_PLAY;
    r.s.ball.shotBy = 9;
    let held = 0;
    for (let i = 0; i < 200 && r.cine.active; i++) { frame(r); if (r.cine.active) held++; }
    expect(held / 60).toBeGreaterThan(LT.shotHold - 0.1);
    expect(held / 60).toBeLessThanOrEqual(LT.shotHold + 0.05);
    expect(r.cine.active).toBe(false);
    // Saved / touched: the hold ends at once.
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 28, -6);
    for (let i = 0; i < 10; i++) frame(r);
    r.s.match.phase = MatchPhase.IN_PLAY;
    r.s.ball.shotBy = 9;
    frame(r);
    expect(r.cine.active).toBe(true);
    r.s.ball.shotBy = -1;
    frame(r);
    expect(r.cine.active).toBe(false);
  });

  it('far free kick and throw-in keep the main camera; corner gets the raised corner view', () => {
    const r = makeRig();
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, -10, 0);
    frame(r);
    expect(r.cine.active).toBe(false);
    award(r, MatchPhase.THROW_IN, RestartKind.THROW_IN, 1, 10, HALF_WIDTH);
    frame(r);
    expect(r.cine.active).toBe(false);
    award(r, MatchPhase.CORNER, RestartKind.CORNER, 0, HALF_LENGTH - 0.6, -(HALF_WIDTH - 0.6));
    frame(r);
    expect(r.cine.shot).toBe(CineShot.CORNER);
    expect(poseDistance(r.cine.pose, cornerPose(HALF_LENGTH - 0.6, -(HALF_WIDTH - 0.6), createCinePose()))).toBeLessThan(1e-6);
    expect(r.cine.stickRotation()).not.toBe(0);
    award(r, MatchPhase.GOAL_KICK, RestartKind.GOAL_KICK, 1, HALF_LENGTH - 5.5, 4.6);
    frame(r);
    expect(r.cine.shot).toBe(CineShot.BEHIND_TAKER);
    expect(Math.abs(camPos(r)[0])).toBeLessThan(HALF_LENGTH);
    award(r, MatchPhase.PENALTY, RestartKind.PENALTY, 0, HALF_LENGTH - PENALTY_SPOT_DIST, 0);
    frame(r);
    expect(r.cine.shot).toBe(CineShot.BEHIND_TAKER);
  });

  it('a small change of shot blends in under 0.3 s; reduced motion cuts', () => {
    for (const reduced of [false, true]) {
      const r = makeRig(reduced);
      award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 30, 8);
      for (let i = 0; i < 20; i++) frame(r);
      const p0 = { ...r.cine.pose };
      // Re-awarded 2 m away (a new restart): close poses.
      award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 31.5, 6.8);
      const target = takerPose(31.5, 6.8, HALF_LENGTH, 0, false, createCinePose());
      expect(canBlend(p0, target)).toBe(true);
      const blends0 = r.cine.blends;
      frame(r);
      if (reduced) {
        expect(r.cine.blending).toBe(false);
        expect(poseDistance(r.cine.pose, target)).toBeLessThan(1e-6);
        continue;
      }
      expect(r.cine.blends).toBe(blends0 + 1);
      expect(r.cine.blending).toBe(true);
      let frames = 1;
      let mid = false;
      while (r.cine.blending && frames < 100) {
        const d0 = poseDistance(r.cine.pose, p0), d1 = poseDistance(r.cine.pose, target);
        if (d0 > 0.1 && d1 > 0.1) mid = true;
        frame(r);
        frames++;
      }
      expect(mid).toBe(true);
      expect(frames / 60).toBeLessThanOrEqual(0.3);
      expect(frames / 60).toBeGreaterThanOrEqual(T_CAMERA.blendTime - 0.02);
      expect(poseDistance(r.cine.pose, target)).toBeLessThan(1e-6);
    }
  });

  it('never flies across the pitch: every frame either moves a little or is a counted cut', () => {
    const r = makeRig();
    let last = camPos(r);
    let lastCuts = r.cine.cuts + r.bc.cuts;
    const check = (): void => {
      const now = camPos(r);
      const moved = Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2]);
      const cuts = r.cine.cuts + r.bc.cuts;
      if (cuts === lastCuts) expect(moved, `moved ${moved.toFixed(2)} m without a cut`).toBeLessThan(LT.blendMaxDist * 0.6);
      last = now;
      lastCuts = cuts;
    };
    const run = (n: number): void => { for (let i = 0; i < n; i++) { frame(r); check(); } };
    run(30);
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 30, 8); run(40);
    r.s.match.phase = MatchPhase.IN_PLAY; r.s.ball.shotBy = 9; run(100);
    award(r, MatchPhase.CORNER, RestartKind.CORNER, 0, HALF_LENGTH - 0.6, HALF_WIDTH - 0.6); run(40);
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 31, 7); run(40);
    award(r, MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0, 32, 6); run(40);
    award(r, MatchPhase.GOAL_KICK, RestartKind.GOAL_KICK, 0, -(HALF_LENGTH - 5.5), -4.6); run(40);
    r.s.match.phase = MatchPhase.IN_PLAY; run(40);
    award(r, MatchPhase.PENALTY, RestartKind.PENALTY, 1, -(HALF_LENGTH - PENALTY_SPOT_DIST), 0); run(40);
    r.s.match.phase = MatchPhase.HALF_TIME; events(r, [EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.HALF_TIME]); run(120);
    r.s.match.phase = MatchPhase.KICK_OFF; run(40);
  });

  it('establishing shots: pre-match orbit, skippable, request for kick-off ends when the kick-off is ready', () => {
    const r = makeRig();
    r.s.match.phase = MatchPhase.PRE_MATCH;
    frame(r);
    expect(r.cine.shot).toBe(CineShot.ESTABLISHING);
    expect(r.cine.active).toBe(true);
    const p0 = { ...r.cine.pose };
    for (let i = 0; i < 60; i++) frame(r);
    expect(poseDistance(p0, r.cine.pose)).toBeGreaterThan(1); // it orbits
    expect(insideLimits(r.cine.pose)).toBe(true);
    expect(r.cine.stickRotation()).toBe(0);
    r.cine.skip();
    frame(r);
    expect(r.cine.active).toBe(false);
    // Skip lasts for that phase only.
    r.s.match.phase = MatchPhase.HALF_TIME;
    frame(r);
    expect(r.cine.shot).toBe(CineShot.ESTABLISHING);
    // Kick-off request.
    r.s.match.phase = MatchPhase.KICK_OFF;
    r.s.match.restart.ready = 0;
    frame(r);
    expect(r.cine.active).toBe(false);
    expect(r.cine.establishing('kickoff')).toBe(true);
    frame(r);
    expect(r.cine.shot).toBe(CineShot.ESTABLISHING);
    r.s.match.restart.ready = 1;
    frame(r);
    expect(r.cine.active).toBe(false);
    // Time limit.
    r.s.match.restart.ready = 0;
    r.cine.establishing('kickoff');
    for (let i = 0; i < (LT.establishingMax + 0.2) * 60; i++) frame(r);
    expect(r.cine.active).toBe(false);
    // Full time.
    r.s.match.phase = MatchPhase.FULL_TIME;
    frame(r);
    expect(r.cine.shot).toBe(CineShot.ESTABLISHING);
    // Not available without a match.
    const c2 = createCinematicCamera(makeCtx());
    expect(c2.establishing('fulltime')).toBe(false);
  });

  it('reduced motion: the establishing shot holds still', () => {
    const r = makeRig(true);
    r.s.match.phase = MatchPhase.PRE_MATCH;
    frame(r);
    const p0 = { ...r.cine.pose };
    for (let i = 0; i < 90; i++) frame(r);
    expect(poseDistance(p0, r.cine.pose)).toBe(0);
  });

  it('goal replay: side angle then behind-goal angle (cuts), tracking the replayed ball; ends with the replay', () => {
    const r = makeRig();
    const s = r.s;
    // 9 s of play with the ball running into the +x goal, then the goal phase.
    for (let t = 1; t <= 540; t++) {
      s.tick = t;
      s.match.phase = MatchPhase.IN_PLAY;
      s.ball.x = -30 + t * 0.15; s.ball.z = 3 - t * 0.005; s.ball.y = 0.11; s.ball.vx = 9;
      for (let i = 0; i < NUM_SLOTS; i++) { s.players[i]!.x = -50 + i * 4 + t * 0.03; s.players[i]!.z = (i % 5) * 3; }
      frame(r);
    }
    s.match.goalTick = 540;
    for (let t = 541; t <= 600; t++) { s.tick = t; s.match.phase = MatchPhase.GOAL; s.ball.x = Math.min(53.5, s.ball.x + 0.15); s.ball.inNet = s.ball.x > HALF_LENGTH ? 1 : 0; frame(r); }
    for (let t = 601; t <= 840; t++) { s.tick = t; s.match.phase = MatchPhase.CELEBRATION; frame(r); }
    s.tick++;
    s.match.phase = MatchPhase.REPLAY;
    events(r, [EventType.PHASE_CHANGE, MatchPhase.CELEBRATION, MatchPhase.REPLAY]);
    const link = replayPlaybackOf(r.ctx);
    expect(link.playing).toBe(true);
    const cuts0 = r.cine.cuts;
    frame(r);
    expect(r.cine.shot).toBe(CineShot.REPLAY_SIDE);
    expect(r.cine.cuts).toBe(cuts0 + 1);
    let sawGoalAngle = false;
    const total = Math.ceil(r.rep.plan.wall * 60);
    for (let i = 0; i < total; i++) {
      frame(r);
      const it = r.f.interp;
      const q = { x: 0, y: 0 };
      expect(r.cine.pitchToScreen(it.ballX, it.ballY, it.ballZ, q)).toBe(true);
      // The replayed ball stays well inside the frame (smoothed look point).
      expect(q.x / 1180).toBeGreaterThan(0.2);
      expect(q.x / 1180).toBeLessThan(0.8);
      expect(q.y / 820).toBeGreaterThan(0.15);
      expect(q.y / 820).toBeLessThan(0.85);
      expect(insideLimits(r.cine.pose)).toBe(true);
      if (r.cine.shot === CineShot.REPLAY_GOAL && !sawGoalAngle) {
        sawGoalAngle = true;
        expect(r.cine.cuts).toBe(cuts0 + 2);
        expect(r.cine.pose.x).toBeGreaterThan(HALF_LENGTH);
      }
    }
    expect(sawGoalAngle).toBe(true);
    // Skip: the sim leaves REPLAY.
    s.match.phase = MatchPhase.KICK_OFF;
    events(r, [EventType.PHASE_CHANGE, MatchPhase.REPLAY, MatchPhase.KICK_OFF]);
    frame(r);
    expect(r.cine.active).toBe(false);
    expect(r.cine.shot).toBe(CineShot.NONE);
    expect(TICK_HZ).toBe(60);
  });

  it('shoot-out: behind the kicker at the end the ball is at', () => {
    const r = makeRig();
    r.s.match.phase = MatchPhase.SHOOT_OUT;
    r.s.ball.x = -(HALF_LENGTH - PENALTY_SPOT_DIST); r.s.ball.z = 0;
    frame(r);
    expect(r.cine.shot).toBe(CineShot.BEHIND_TAKER);
    expect(r.cine.pose.x).toBeGreaterThan(r.s.ball.x); // behind the ball, away from the -x goal
    const up = stickUp(r.cine.stickRotation());
    expect(up.x).toBeLessThan(-0.999);
  });

  it('resize while active keeps the projection current; clearMatch deactivates', () => {
    const r = makeRig();
    award(r, MatchPhase.PENALTY, RestartKind.PENALTY, 0, HALF_LENGTH - PENALTY_SPOT_DIST, 0);
    frame(r);
    r.ctx.size.cssW = 1024; r.ctx.size.cssH = 768;
    r.cine.resize!();
    expect(r.ctx.camera.aspect).toBeCloseTo(1024 / 768, 9);
    const sp = { x: 0, y: 0 };
    expect(r.cine.pitchToScreen(HALF_LENGTH - PENALTY_SPOT_DIST, 0.11, 0, sp)).toBe(true);
    expect(sp.x / 1024).toBeCloseTo(0.5, 3);
    r.cine.clearMatch!();
    expect(r.cine.active).toBe(false);
    frame(r);
    expect(r.cine.active).toBe(false);
  });
});
