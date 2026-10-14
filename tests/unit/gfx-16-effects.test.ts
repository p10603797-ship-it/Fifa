/**
 * [GFX-16] Small effects: ball trail on hard shots (and only then), net-bulge puff on net entry, grass kick-up on slides
 * (pooled, capped per tier), goal flash, tiers, idle = zero draw calls, replay slow motion / cuts, warm-up, cleanup.
 * THREE scene objects only, no WebGL.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, CameraType, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEffects, LOCAL_TUNING, particleCapFor, trailWanted, type EffectsModule } from '../../src/render/effects';
import { getTierParams } from '../../src/render/quality';
import { replayPlaybackOf } from '../../src/render/replay';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

function makeCtx(tier = QualityTier.BALANCED): RenderContext {
  const cam = new PerspectiveCamera(22, 1180 / 820, 2, 600);
  cam.position.set(0, 24, 74);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: cam, settings: createDefaultSettings(), clubs: [],
    size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier, cameraSettings: { type: CameraType.BROADCAST, height: 10, zoom: 10 },
    reducedMotion: false, night: false,
  };
}

class FakeEvents implements EventBuffer {
  list: SimEvent[] = [];
  get count(): number { return this.list.length; }
  get(i: number): Readonly<SimEvent> { return this.list[i]!; }
  begin(): void { this.list = []; }
  emit(type: EventType, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0): void { this.list.push({ type, tick: 0, a, b, c, d, x, y, z }); }
}

interface Rig { ctx: RenderContext; fx: EffectsModule; s: SimState; f: RenderFrame }

function makeRig(tier = QualityTier.BALANCED): Rig {
  const ctx = makeCtx(tier);
  const fx = createEffects(ctx);
  fx.setQuality!(tier);
  const s = initMatch(createMatchConfig()) as SimState;
  s.match.phase = MatchPhase.IN_PLAY;
  for (let i = 0; i < NUM_SLOTS; i++) { s.players[i]!.vx = 0; s.players[i]!.vz = 0; s.players[i]!.act = ActionKind.NONE; }
  fx.setMatch!(s, []);
  const f: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
  return { ctx, fx, s, f };
}

function frame(r: Rig, dtMs = 1000 / 60): void {
  const it = r.f.interp, s = r.s;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    it.x[i] = p.x; it.z[i] = p.z; it.vx[i] = p.vx; it.vz[i] = p.vz; it.fx[i] = p.fx; it.fz[i] = p.fz;
  }
  it.ballX = s.ball.x; it.ballY = s.ball.y; it.ballZ = s.ball.z;
  r.f.frame.dtMs = dtMs;
  r.fx.update(r.f);
}

function objects(r: Rig): { points: boolean; trail: boolean; flash: boolean } {
  const g = r.ctx.scene.getObjectByName('effects')!;
  return {
    points: g.getObjectByName('fx-particles')!.visible,
    trail: g.getObjectByName('fx-trail')!.visible,
    flash: g.getObjectByName('fx-flash')!.visible,
  };
}

/** Ball flying at speed v along +x (owner none), shot flag optional; advances one frame. */
function flyBall(r: Rig, v: number, shot: boolean): void {
  const b = r.s.ball;
  b.owner = -1; b.heldBy = -1; b.shotBy = shot ? 9 : -1;
  b.vx = v; b.vy = 1; b.vz = 0;
  b.x += v / 60; b.y = 1;
  frame(r);
}

describe('GFX-16 effects: pure rules', () => {
  it('trail only for a hard shot or a very fast loose ball', () => {
    const b = { owner: -1, heldBy: -1, shotBy: 9, vx: LOCAL_TUNING.trailShotSpeed + 1, vy: 0, vz: 0 };
    expect(trailWanted(b)).toBe(true);
    expect(trailWanted({ ...b, vx: LOCAL_TUNING.trailShotSpeed - 1 })).toBe(false);
    expect(trailWanted({ ...b, shotBy: -1 })).toBe(false);
    expect(trailWanted({ ...b, shotBy: -1, vx: LOCAL_TUNING.trailAnySpeed + 1 })).toBe(true);
    expect(trailWanted({ ...b, owner: 4, vx: 40 })).toBe(false);
    expect(trailWanted({ ...b, heldBy: 0, vx: 40 })).toBe(false);
    expect(trailWanted({ ...b, vx: Number.NaN })).toBe(false);
  });

  it('particle cap scales with the tier', () => {
    expect(particleCapFor(getTierParams(QualityTier.QUALITY).effectsScale)).toBe(LOCAL_TUNING.maxParticles);
    expect(particleCapFor(getTierParams(QualityTier.PERFORMANCE).effectsScale)).toBeLessThan(particleCapFor(getTierParams(QualityTier.BALANCED).effectsScale));
    expect(particleCapFor(0)).toBe(0);
    expect(particleCapFor(5)).toBe(LOCAL_TUNING.maxParticles);
  });
});

describe('GFX-16 effects: module', () => {
  it('idle: nothing visible, zero draw calls', () => {
    const r = makeRig();
    for (let i = 0; i < 30; i++) frame(r);
    expect(r.fx.snapshot().drawCalls).toBe(0);
    expect(objects(r)).toEqual({ points: false, trail: false, flash: false });
  });

  it('ball trail on a hard shot, fading after the ball is caught; none for a soft pass', () => {
    const r = makeRig();
    r.s.ball.x = 0;
    for (let i = 0; i < 20; i++) flyBall(r, 30, true);
    expect(objects(r).trail).toBe(true);
    expect(r.fx.snapshot().trailPoints).toBeGreaterThanOrEqual(2);
    expect(r.fx.snapshot().trailPoints).toBeLessThanOrEqual(LOCAL_TUNING.trailPoints);
    // Keeper catches: no new points, the trail fades within trailLife.
    r.s.ball.heldBy = 0; r.s.ball.owner = 0; r.s.ball.vx = 0;
    for (let i = 0; i < Math.ceil(LOCAL_TUNING.trailLife * 60) + 2; i++) frame(r);
    expect(objects(r).trail).toBe(false);
    // Soft pass.
    for (let i = 0; i < 20; i++) flyBall(r, 12, false);
    expect(objects(r).trail).toBe(false);
  });

  it('a teleporting ball (restart / replay cut) restarts the trail instead of streaking', () => {
    const r = makeRig();
    r.s.ball.x = 0;
    for (let i = 0; i < 10; i++) flyBall(r, 30, true);
    const n = r.fx.snapshot().trailPoints;
    expect(n).toBeGreaterThan(3);
    r.s.ball.x = 40;
    flyBall(r, 30, true);
    expect(r.fx.snapshot().trailPoints).toBe(1);
  });

  it('Performance tier: no trail, fewer particles', () => {
    const r = makeRig(QualityTier.PERFORMANCE);
    for (let i = 0; i < 20; i++) flyBall(r, 30, true);
    expect(objects(r).trail).toBe(false);
    expect(r.fx.snapshot().trailOn).toBe(false);
    expect(r.fx.snapshot().particleCap).toBe(particleCapFor(getTierParams(QualityTier.PERFORMANCE).effectsScale));
  });

  it('net-bulge puff once when the ball enters the net; particles expire', () => {
    const r = makeRig();
    const b = r.s.ball;
    b.x = 52; b.y = 1; b.z = 0; b.vx = 20; b.inNet = 0;
    frame(r);
    expect(r.fx.snapshot().particles).toBe(0);
    b.x = 53; b.inNet = 1;
    frame(r);
    const n = r.fx.snapshot().particles;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(objects(r).points).toBe(true);
    frame(r); // still in the net: no second burst
    expect(r.fx.snapshot().particles).toBeLessThanOrEqual(n);
    for (let i = 0; i < Math.ceil(LOCAL_TUNING.puffLife * 60) + 2; i++) frame(r);
    expect(r.fx.snapshot().particles).toBe(0);
    expect(objects(r).points).toBe(false);
  });

  it('grass kick-up while sliding, grounded, stops with the slide, never above the pool cap', () => {
    const r = makeRig();
    const p = r.s.players[7]!;
    p.x = 10; p.z = 5; p.fx = 1; p.fz = 0; p.vx = 6; p.vz = 0; p.act = ActionKind.SLIDE_TACKLE;
    for (let i = 0; i < 30; i++) frame(r); // 0.5 s
    const expected = LOCAL_TUNING.slideRate * getTierParams(QualityTier.BALANCED).effectsScale * 0.5;
    const n = r.fx.snapshot().particles;
    expect(n).toBeGreaterThan(expected * 0.5);
    expect(n).toBeLessThanOrEqual(Math.ceil(expected) + 1);
    // A slow slide (stopping) throws nothing new.
    p.vx = 0.5;
    for (let i = 0; i < 60; i++) frame(r);
    expect(r.fx.snapshot().particles).toBe(0);
    // Not a slide: nothing.
    p.vx = 6; p.act = ActionKind.NONE;
    for (let i = 0; i < 30; i++) frame(r);
    expect(r.fx.snapshot().particles).toBe(0);
    // Everyone sliding for 2 s: the pool cap holds.
    for (let i = 0; i < NUM_SLOTS; i++) { const q = r.s.players[i]!; q.act = ActionKind.SLIDE_TACKLE; q.vx = 7; }
    for (let i = 0; i < 120; i++) {
      frame(r);
      expect(r.fx.snapshot().particles).toBeLessThanOrEqual(r.fx.snapshot().particleCap);
    }
    expect(r.fx.snapshot().particles).toBeGreaterThan(r.fx.snapshot().particleCap * 0.8); // saturated
  });

  it('goal flash on the GOAL event: soft, short', () => {
    const r = makeRig();
    const ev = new FakeEvents();
    ev.emit(EventType.GOAL, 0, 9, -1, 0);
    r.fx.onEvents!(ev, r.s);
    frame(r);
    expect(objects(r).flash).toBe(true);
    const a = r.fx.snapshot().flash;
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThanOrEqual(LOCAL_TUNING.flashPeak);
    for (let i = 0; i < Math.ceil(LOCAL_TUNING.flashTime * 60) + 1; i++) frame(r);
    expect(objects(r).flash).toBe(false);
  });

  it('all effects at once stay within 3 draw calls', () => {
    const r = makeRig(QualityTier.QUALITY);
    const ev = new FakeEvents();
    ev.emit(EventType.GOAL, 0, 9, -1, 0);
    r.fx.onEvents!(ev, r.s);
    r.s.players[3]!.act = ActionKind.SLIDE_TACKLE; r.s.players[3]!.vx = 6;
    r.s.ball.x = 0;
    for (let i = 0; i < 10; i++) flyBall(r, 30, true);
    expect(r.fx.snapshot().drawCalls).toBe(3);
  });

  it('replays: effect time follows the slow-motion rate; a replay cut resets the trail and detectors', () => {
    const r = makeRig();
    const link = replayPlaybackOf(r.ctx);
    link.playing = true; link.rate = 0.5;
    // A replayed goal: puff + flash. At half speed the puff outlives its normal lifetime (in real time).
    r.s.ball.x = 52; r.s.ball.vx = 20; r.s.ball.inNet = 0; frame(r);
    r.s.ball.x = 53; r.s.ball.inNet = 1;
    frame(r);
    expect(objects(r).flash).toBe(true);
    const frames = Math.ceil(LOCAL_TUNING.puffLife * 60) + 2;
    for (let i = 0; i < frames; i++) frame(r);
    expect(r.fx.snapshot().particles).toBeGreaterThan(0);
    for (let i = 0; i < frames; i++) frame(r);
    expect(r.fx.snapshot().particles).toBe(0);
    // A cut while the ball is in the net does not re-trigger.
    link.cuts++;
    frame(r);
    expect(r.fx.snapshot().particles).toBe(0);
    expect(objects(r).flash).toBe(false);
    // Trail reset on a cut.
    r.s.ball.inNet = 0; r.s.ball.x = 0;
    for (let i = 0; i < 10; i++) flyBall(r, 30, true);
    expect(r.fx.snapshot().trailPoints).toBeGreaterThan(1);
    link.cuts++;
    flyBall(r, 30, true);
    expect(r.fx.snapshot().trailPoints).toBe(1);
    link.playing = false; link.rate = 1;
  });

  it('warmUp leaves nothing behind; clearMatch hides; dispose removes the group', () => {
    const r = makeRig();
    r.fx.warmUp!();
    expect(r.fx.snapshot().particles).toBe(0);
    expect(r.fx.snapshot().drawCalls).toBe(0);
    r.s.players[1]!.act = ActionKind.SLIDE_TACKLE; r.s.players[1]!.vx = 6;
    for (let i = 0; i < 10; i++) frame(r);
    r.fx.clearMatch!();
    expect(r.ctx.scene.getObjectByName('effects')!.visible).toBe(false);
    expect(r.fx.snapshot().particles).toBe(0);
    frame(r); // no match: ignored
    expect(r.fx.snapshot().particles).toBe(0);
    r.fx.dispose();
    expect(r.ctx.scene.getObjectByName('effects')).toBeUndefined();
  });
});
