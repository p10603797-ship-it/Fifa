/**
 * FND-05: render helpers that need no WebGL: interpolation, kit clash fallback, instance matrices, goal frame,
 * renderer core fallbacks, and createGameRenderer() without WebGL2 (must not throw; projector still works).
 */
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS, POST_RADIUS } from '../../src/contracts/constants';
import { KitSlot } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { cloneState } from '../../src/sim/core/clone';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { initMatch } from '../../src/sim/init';
import { createGameRenderer, fillInterp } from '../../src/render/index';
import { createInterpState } from '../../src/render/types';
import { CLASH_THRESHOLD, colourDistance, resolveMatchKits } from '../../src/render/kits';
import { writeFacingMatrix } from '../../src/render/players/model';
import { goalFrameMatrices } from '../../src/render/goals';
import { clampScale, effectivePixelRatio } from '../../src/render/renderer';
import { initialScale, resolveTier } from '../../src/render/quality';
import { QualityTier } from '../../src/contracts/enums';
import { mapAnim, createAnimSample, poseFnFor, advanceCycle, createAnimBank } from '../../src/render/anim/mapper';
import { AnimId, createPose, PoseIdx } from '../../src/contracts/render';

function state(): SimState {
  return initMatch(createMatchConfig());
}

describe('FND-05 render helpers', () => {
  it('fillInterp blends positions and re-normalises facing', () => {
    const a = state();
    const b = cloneState(a);
    a.players[3]!.x = 0; b.players[3]!.x = 10;
    a.players[3]!.fx = 1; a.players[3]!.fz = 0;
    b.players[3]!.fx = 0; b.players[3]!.fz = 1;
    a.ball.y = 0.11; b.ball.y = 2.11;
    const it = createInterpState();
    fillInterp(it, a, b, 0.25);
    expect(it.x[3]).toBeCloseTo(2.5, 5);
    expect(Math.hypot(it.fx[3]!, it.fz[3]!)).toBeCloseTo(1, 5);
    expect(it.ballY).toBeCloseTo(0.61, 5);
    // Opposite facings blend to zero: falls back to curr.
    a.players[4]!.fx = 1; a.players[4]!.fz = 0;
    b.players[4]!.fx = -1; b.players[4]!.fz = 0;
    fillInterp(it, a, b, 0.5);
    expect(it.fx[4]).toBe(-1);
    fillInterp(it, a, b, 7); // clamped
    expect(it.x[3]).toBeCloseTo(10, 5);
    expect(it.x.length).toBe(NUM_SLOTS);
  });

  it('kit clash fallback: identical shirts force the away side to change', () => {
    const s = state();
    const clubs = CLUBS.map((c) => ({ ...c }));
    const home = clubs[s.teams[0]!.clubIdx]!;
    const away = clubs[s.teams[1]!.clubIdx]!;
    clubs[away.id] = { ...away, home: { ...away.home }, away: { ...away.away, shirt: home.home.shirt } };
    s.teams[1]!.kit = KitSlot.AWAY;
    const k = resolveMatchKits(s, clubs);
    expect(colourDistance(k.outfield[0].shirt, k.outfield[1].shirt)).toBeGreaterThanOrEqual(CLASH_THRESHOLD);
    expect(k.slot[1]).toBe(KitSlot.HOME);
    // Keepers never match an outfield shirt.
    expect(colourDistance(k.keeper[0].shirt, k.outfield[1].shirt)).toBeGreaterThan(0);
    expect(colourDistance(0xff0000, 0xff0000)).toBe(0);
    expect(colourDistance(0x000000, 0xffffff)).toBeCloseTo(1, 3);
  });

  it('instance matrix: feet on the grass, +x turned to the facing, right hand to +z', () => {
    const arr = new Float32Array(16);
    writeFacingMatrix(arr, 0, 5, -3, 0, 1, 1.1, 0.8);
    const m = new Matrix4().fromArray(arr);
    const p = new Vector3(0, 0, 0).applyMatrix4(m);
    expect(p.x).toBeCloseTo(5, 6); expect(p.y).toBeCloseTo(0, 6); expect(p.z).toBeCloseTo(-3, 6);
    const fwd = new Vector3(1, 0, 0).transformDirection(m);
    expect(fwd.x).toBeCloseTo(0, 6); expect(fwd.z).toBeCloseTo(1, 6);
    const right = new Vector3(0, 0, 1).transformDirection(m);
    expect(right.x).toBeCloseTo(-1, 6); // facing +z, the right hand points to -x
    const top = new Vector3(0, 1.8, 0).applyMatrix4(m);
    expect(top.y).toBeCloseTo(1.8 * 1.1, 6);
  });

  it('goal frame: posts outside the 7.32 m mouth, bar underside at 2.44 m', () => {
    const ms = goalFrameMatrices();
    expect(ms.length).toBe(6);
    const pos = new Vector3();
    pos.setFromMatrixPosition(ms[0]!);
    expect(Math.abs(pos.z)).toBeCloseTo(GOAL_HALF_WIDTH + POST_RADIUS, 6);
    expect(pos.x).toBeCloseTo(-(HALF_LENGTH - POST_RADIUS), 6);
    pos.setFromMatrixPosition(ms[2]!);
    expect(pos.y - POST_RADIUS).toBeCloseTo(GOAL_HEIGHT, 6);
  });

  it('resolution scale and quality fallbacks', () => {
    expect(clampScale(0.75)).toBe(0.75);
    expect(clampScale(2)).toBe(1);
    expect(clampScale(0.1)).toBe(0.6);
    expect(clampScale(Number.NaN)).toBe(0.75);
    expect(effectivePixelRatio(1180, 820, 2, 0.75)).toBeCloseTo(1.5, 6);
    expect(1180 * effectivePixelRatio(1180, 820, 2, 0.75)).toBeCloseTo(1770, 3); // 0.75 of 2360 device px
    expect(5000 * effectivePixelRatio(5000, 3000, 2, 1)).toBeLessThanOrEqual(4096 + 1e-6);
    expect(resolveTier(QualityTier.AUTO)).toBe(QualityTier.BALANCED);
    expect(resolveTier(QualityTier.QUALITY)).toBe(QualityTier.QUALITY);
    expect(initialScale(0)).toBe(0.75);
    expect(initialScale(0.9)).toBe(0.9);
  });

  it('anim mapper stub: idle / jog / sprint and a valid pose function for every clip', () => {
    const s = state();
    const out = createAnimSample();
    mapAnim(s, 3, 0, out);
    expect(out.anim).toBe(AnimId.IDLE);
    mapAnim(s, 3, 4, out);
    expect(out.anim).toBe(AnimId.JOG);
    s.players[3]!.sprinting = 1;
    mapAnim(s, 3, 8, out);
    expect(out.anim).toBe(AnimId.SPRINT);
    const pose = createPose();
    for (let a = 0; a <= AnimId.STRAFE; a++) {
      poseFnFor(a as AnimId)(pose, 0.5, 1, 5, 1, 0);
      for (let i = 0; i < pose.length; i++) expect(Number.isFinite(pose[i]!)).toBe(true);
    }
    poseFnFor(AnimId.JOG)(pose, 0, Math.PI / 2, 5, 1, 0);
    expect(pose[PoseIdx.HIP_L_PITCH]).toBeGreaterThan(0);
    const bank = createAnimBank();
    advanceCycle(bank, 2, 100);
    expect(bank.cycle[2]).toBeGreaterThanOrEqual(0);
    expect(bank.cycle[2]).toBeLessThan(Math.PI * 2);
  });

  it('createGameRenderer without WebGL2: init does not throw, renders nothing, projector works', () => {
    const r = createGameRenderer();
    const canvas = { getContext: () => null, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
    expect(() => r.init(canvas, createDefaultSettings())).not.toThrow();
    expect(r.available).toBe(false);
    expect(r.failure).toMatch(/WebGL 2/);
    const s = state();
    expect(() => r.setMatch(s, CLUBS)).not.toThrow();
    expect(() => r.render(s, s, 0.5, { nowMs: 0, dtMs: 16, frame: 1, ticks: 1, paused: false })).not.toThrow();
    expect(r.startReplay(4)).toBe(false);
    expect(r.replaying).toBe(false);
    const st = r.stats();
    expect(st.drawCalls).toBe(0);
    const p = { x: 0, y: 0 };
    expect(r.projector.pitchToScreen(0, 0, 0, p)).toBe(true);
    const q = { x: 0, z: 0 };
    expect(r.projector.screenToPitch(p.x, p.y, q)).toBe(true);
    expect(q.x).toBeCloseTo(0, 3);
    expect(q.z).toBeCloseTo(0, 3);
    expect(() => r.clearMatch()).not.toThrow();
    expect(() => r.dispose()).not.toThrow();
  });
});
