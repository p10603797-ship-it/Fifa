/**
 * [INT-C] Planted boots in the player model (GFX-07 foot lock + GFX-12 live locomotion cross-fades + GFX-09 lean pivot)
 * with synthetic motion: sharp turns at speed, jog / turn-lean flips, speed changes. Regression for "foot sliding in
 * live play" (BRIEF section 8: run cycles advance with distance so feet do not slide). The live-play numbers come from
 * tests/scenario/int-c-anim-live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { MatchPhase, QualityTier } from '../../src/contracts/enums';
import { AnimId, createPose, PoseIdx } from '../../src/contracts/render';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { applyTurnLean } from '../../src/render/anim/locomotion';
import { poseFnFor } from '../../src/render/anim/mapper';
import { fillInterp } from '../../src/render/index';
import { BODY, createSkeleton, Joint, solvePoseFK } from '../../src/render/players/fk';
import { createPlayerModel, type PlayerModelModule } from '../../src/render/players/model';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { cloneState } from '../../src/sim/core/clone';
import { initMatch } from '../../src/sim/init';

const SLOT = 6;

function rig(): { model: PlayerModelModule; prev: SimState; curr: SimState; f: RenderFrame } {
  const settings = createDefaultSettings();
  const ctx: RenderContext = {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.44, 2, 600),
    settings, clubs: CLUBS, size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
  const model = createPlayerModel(ctx);
  const curr = initMatch(createMatchConfig()) as SimState;
  curr.match.phase = MatchPhase.IN_PLAY;
  curr.attrs[SLOT]!.height = 180;
  model.setMatch!(curr, CLUBS);
  const prev = cloneState(curr);
  const f: RenderFrame = { prev, curr, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
  return { model, prev, curr, f };
}

/** Move SLOT one tick along a path (x, z, heading) and draw one frame. */
function tick(r: ReturnType<typeof rig>, x: number, z: number, hx: number, hz: number, speed: number): void {
  const a = r.prev.players[SLOT]!, b = r.curr.players[SLOT]!;
  a.x = b.x; a.z = b.z; a.vx = b.vx; a.vz = b.vz; a.fx = b.fx; a.fz = b.fz;
  b.x = x; b.z = z; b.vx = hx * speed; b.vz = hz * speed; b.fx = hx; b.fz = hz;
  r.prev.tick = r.curr.tick; r.curr.tick++;
  r.f.frame.frame++; r.f.frame.nowMs += 1000 / 60;
  fillInterp(r.f.interp, r.prev, r.curr, 1);
  r.model.update(r.f);
}

function boot(r: ReturnType<typeof rig>, k: number, out: number[]): void {
  const S = r.model.skeletons[SLOT]!;
  const o = (k < 2 ? Joint.ANKLE_L : Joint.ANKLE_R) * 12;
  const lx = (k & 1) === 0 ? BODY.toeX : BODY.heelX, ly = -BODY.ankleY;
  out[0] = S[o]! * lx + S[o + 3]! * ly + S[o + 9]!;
  out[1] = S[o + 1]! * lx + S[o + 4]! * ly + S[o + 10]!;
  out[2] = S[o + 2]! * lx + S[o + 5]! * ly + S[o + 11]!;
}

/** Slip of planted boot points (world speed / body speed) over a path; returns [median, stationary share]. */
function slipOver(r: ReturnType<typeof rig>, n: number, path: (t: number) => [number, number, number, number, number]): [number, number] {
  const last: (number[] | null)[] = [null, null, null, null];
  const q = [0, 0, 0];
  const ratios: number[] = [];
  for (let t = 0; t < n; t++) {
    const [x, z, hx, hz, v] = path(t);
    tick(r, x, z, hx, hz, v);
    for (let k = 0; k < 4; k++) {
      boot(r, k, q);
      const w = last[k];
      if (w && t > 30 && q[1]! < 0.003 && w[1]! < 0.003) ratios.push((Math.hypot(q[0]! - w[0]!, q[2]! - w[2]!) * 60) / v);
      last[k] = [q[0]!, q[1]!, q[2]!];
    }
  }
  ratios.sort((a, b) => a - b);
  let still = 0;
  for (const x of ratios) if (x < 0.1) still++;
  return [ratios[(ratios.length - 1) >> 1]!, still / ratios.length];
}

describe('INT-C planted boots (regression: foot sliding in live play)', () => {
  it('a sharp curve at 6 m/s (2.5 rad/s, turn lean on): planted boots stay put', () => {
    const r = rig();
    const R = 6 / 2.5;
    const [p50, still] = slipOver(r, 600, (t) => {
      const a = (t / 60) * 2.5;
      return [R * Math.sin(a), R - R * Math.cos(a), Math.cos(a), Math.sin(a), 6];
    });
    expect(p50).toBeLessThan(0.08);
    expect(still).toBeGreaterThan(0.6);
  });

  it('weaving (yaw rate swinging +-1.5 rad/s, jog / turn lean flipping) at 5 m/s', () => {
    const r = rig();
    let x = 0, z = 0, h = 0;
    const [p50, still] = slipOver(r, 900, (t) => {
      h += (1.5 * Math.sin((t / 60) * 2.2)) / 60;
      x += (Math.cos(h) * 5) / 60; z += (Math.sin(h) * 5) / 60;
      return [x, z, Math.cos(h), Math.sin(h), 5];
    });
    expect(p50).toBeLessThan(0.08);
    expect(still).toBeGreaterThan(0.6);
  });

  it('the lock never pulls the body far from the sim position and lets go when the player stops or teleports', () => {
    const r = rig();
    let x = 0, z = 0, h = 0;
    for (let t = 0; t < 400; t++) {
      h += 3 / 60;
      x += (Math.cos(h) * 7) / 60; z += (Math.sin(h) * 7) / 60;
      tick(r, x, z, Math.cos(h), Math.sin(h), 7);
      // Root (pelvis) within the lock cap plus the pose's own root offsets (lean shift and stride sway).
      const S = r.model.skeletons[SLOT]!;
      const pose = r.model.poses[SLOT]!;
      const own = Math.hypot(pose[PoseIdx.ROOT_FWD]!, pose[PoseIdx.ROOT_SIDE]!);
      expect(Math.hypot(S[9]! - x, S[11]! - z)).toBeLessThan(0.3 + own + 0.02);
    }
    // Standing still: back on the sim position within half a second.
    for (let t = 0; t < 60; t++) tick(r, x, z, Math.cos(h), Math.sin(h), 0);
    const S = r.model.skeletons[SLOT]!;
    const pose = r.model.poses[SLOT]!;
    expect(Math.hypot(S[9]! - x, S[11]! - z)).toBeLessThan(Math.hypot(pose[PoseIdx.ROOT_FWD]!, pose[PoseIdx.ROOT_SIDE]!) + 0.01);
    // A teleport (restart placement) drops the lock at once.
    for (let t = 0; t < 30; t++) { h += 3 / 60; x += (Math.cos(h) * 7) / 60; z += (Math.sin(h) * 7) / 60; tick(r, x, z, Math.cos(h), Math.sin(h), 7); }
    tick(r, 20, -10, 1, 0, 0);
    const S2 = r.model.skeletons[SLOT]!;
    const p2 = r.model.poses[SLOT]!;
    expect(Math.hypot(S2[9]! - 20, S2[11]! + 10)).toBeLessThan(Math.hypot(p2[PoseIdx.ROOT_FWD]!, p2[PoseIdx.ROOT_SIDE]!) + 0.01);
  });

  it('turn lean pivots at the feet: leaning a jog pose does not move its planted toe', () => {
    const jog = poseFnFor(AnimId.JOG)!;
    const sk = createSkeleton();
    const base = createPose(), leant = createPose();
    for (const cycle of [0.4, 1.2, 3.6, 4.4]) {
      jog(base, 0, cycle, 6, 1, 0);
      jog(leant, 0, cycle, 6, 1, 0);
      applyTurnLean(leant, 0.3);
      for (const j of [Joint.ANKLE_L, Joint.ANKLE_R]) {
        solvePoseFK(base, sk);
        const o = j * 12;
        const bz = sk[o + 2]! * BODY.toeX + sk[o + 5]! * -BODY.ankleY + sk[o + 11]!;
        const by = sk[o + 1]! * BODY.toeX + sk[o + 4]! * -BODY.ankleY + sk[o + 10]!;
        solvePoseFK(leant, sk);
        const lz = sk[o + 2]! * BODY.toeX + sk[o + 5]! * -BODY.ankleY + sk[o + 11]!;
        // A boot on the grass stays within a few cm sideways (the roll pivots at the ground, not at the pelvis).
        if (by < 0.01) expect(Math.abs(lz - bz)).toBeLessThan(0.05);
      }
    }
  });
});
