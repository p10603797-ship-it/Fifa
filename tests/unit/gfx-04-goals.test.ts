/**
 * [GFX-04] Goals and nets with ripple, in Node: ripple maths (decays to exactly zero, bounded, no action ahead of the
 * wave), frame shake maths, net and frame geometry (matches the sim's goal box, edges pinned, shadow drawn first,
 * detail tiers, budgets), impact prediction, and the module in a headless scene driven by NET / POST events and by
 * interpolated ball positions (replays), including a real sim shot into the net. The e2e spec gfx-04-goals checks the
 * pixels.
 */
import { Matrix4, PerspectiveCamera, Scene, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BALL_RADIUS, GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, POST_RADIUS,
} from '../../src/contracts/constants';
import { MatchPhase, QualityTier } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import {
  FRAME_INSTANCES, GOAL_TUNING, RIPPLE_SLOTS, SHEET_BACK, SHEET_ROOF, SHEET_SIDE_NEG, SHEET_SIDE_POS, createGoals,
  createNetGeometry, createNetImpact, goalFrameMatrices, netFragmentShader, netGridSegments, netPinWeight,
  netRippleAmplitude, netVertexShader, predictNetImpact, rippleBound, rippleDisplacement, rippleEnvelope,
  wobbleAmplitude, wobbleSway, writeGoalFrame, writeTube, type GoalsModule,
} from '../../src/render/goals';
import { fillInterp } from '../../src/render/index';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const T = GOAL_TUNING;
const GL = HALF_LENGTH;
const GB = HALF_LENGTH + GOAL_DEPTH;
const GW = GOAL_HALF_WIDTH;
const GH = GOAL_HEIGHT;

function makeCtx(tier = QualityTier.BALANCED, night = false): RenderContext {
  const s = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(22, 1180 / 820, 2, 600),
    settings: s, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier, cameraSettings: { ...s.camera },
    reducedMotion: false, night,
  };
}

/** Minimal EventBuffer over a list of events. */
function eventsOf(list: Partial<SimEvent>[]): EventBuffer {
  const evs: SimEvent[] = list.map((e) => ({ type: EventType.KICK, tick: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0, ...e }));
  return {
    get count() { return evs.length; },
    get: (i: number) => evs[i]!,
    begin() { /* fixed */ },
    emit() { /* fixed */ },
  };
}

interface Rig {
  ctx: RenderContext;
  goals: GoalsModule;
  s: SimState;
  frame: RenderFrame;
  /** Render one frame of dtMs with the interpolated ball at (x, y, z). */
  step(dtMs: number, x?: number, y?: number, z?: number, paused?: boolean): void;
}

function rig(tier = QualityTier.BALANCED): Rig {
  const ctx = makeCtx(tier);
  const goals = createGoals(ctx);
  const s = initMatch(createMatchConfig());
  goals.setMatch!(s, []);
  const interp = createInterpState();
  fillInterp(interp, s, s, 1);
  const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
  return {
    ctx, goals, s, frame,
    step(dtMs, x, y, z, paused = false) {
      if (x !== undefined) { interp.ballX = x; interp.ballY = y!; interp.ballZ = z!; }
      frame.frame.dtMs = dtMs;
      frame.frame.nowMs += dtMs;
      frame.frame.frame++;
      frame.frame.paused = paused;
      goals.update(frame);
    },
  };
}

/** Active ripples (amp != 0) from the shader uniforms. */
function activeRipples(g: GoalsModule): { x: number; y: number; z: number; age: number; amp: number }[] {
  const out: { x: number; y: number; z: number; age: number; amp: number }[] = [];
  const amp = g.uniforms.uAmp.value;
  for (let i = 0; i < RIPPLE_SLOTS; i++) {
    const a = amp.getComponent(i);
    if (a === 0) continue;
    const r = g.uniforms.uRip.value[i]!;
    out.push({ x: r.x, y: r.y, z: r.z, age: r.w, amp: a });
  }
  return out;
}

describe('GFX-04 ripple maths', () => {
  it('ripple maths decays to zero: exactly 0 before the impact and from rippleDuration on, small well before', () => {
    let peak = 0;
    for (let age = 0.005; age < T.rippleDuration; age += 0.005) {
      for (let r = 0; r <= 6; r += 0.05) peak = Math.max(peak, Math.abs(rippleDisplacement(r, age, 0.4)));
    }
    expect(peak).toBeGreaterThan(0.3); // a real bulge (0.4 m amplitude)
    for (let r = 0; r <= 8; r += 0.1) {
      expect(rippleDisplacement(r, 0, 0.4)).toBe(0);
      expect(rippleDisplacement(r, -0.05, 0.4)).toBe(0); // pending ripple
      expect(rippleDisplacement(r, T.rippleDuration, 0.4)).toBe(0);
      expect(rippleDisplacement(r, T.rippleDuration + 0.5, 0.4)).toBe(0);
      expect(rippleDisplacement(r, 30, 0.4)).toBe(0);
    }
    const maxAt = (age: number): number => {
      let m = 0;
      for (let r = 0; r <= 6; r += 0.02) m = Math.max(m, Math.abs(rippleDisplacement(r, age, 0.4)));
      return m;
    };
    expect(maxAt(0.6)).toBeLessThan(0.25 * peak);
    expect(maxAt(0.9)).toBeLessThan(0.06 * peak);
    expect(maxAt(1.05)).toBeLessThan(0.01 * peak);
  });

  it('the bound holds everywhere, never exceeds amp x (1 + waveShare), and decays monotonically after the bulge peak', () => {
    const amp = -0.3;
    let prev = Infinity;
    for (let age = 0.001; age < T.rippleDuration + 0.1; age += 0.01) {
      const b = rippleBound(age, amp);
      expect(b).toBeLessThanOrEqual(Math.abs(amp) * (1 + T.waveShare) + 1e-12);
      for (let r = 0; r <= 6; r += 0.07) expect(Math.abs(rippleDisplacement(r, age, amp))).toBeLessThanOrEqual(b + 1e-12);
      if (age >= T.bulgeRise) {
        expect(b).toBeLessThanOrEqual(prev + 1e-12);
        prev = b;
      }
    }
    expect(rippleBound(T.rippleDuration, amp)).toBe(0);
  });

  it('sign follows the amplitude; nothing moves ahead of the wave front or far from the bulge', () => {
    expect(rippleDisplacement(0, T.bulgeRise, 0.3)).toBeGreaterThan(0.25);
    expect(rippleDisplacement(0, T.bulgeRise, -0.3)).toBeLessThan(-0.25);
    // 0.2 s after the impact the front is at waveSpeed * 0.2 m; well beyond it and the bulge: still.
    const front = T.waveSpeed * 0.2;
    expect(Math.abs(rippleDisplacement(front + 4 * T.bulgeRadius, 0.2, 0.4))).toBeLessThan(1e-6);
    // The other goal (105 m away) never moves.
    for (let age = 0.01; age < T.rippleDuration; age += 0.05) expect(rippleDisplacement(105, age, 0.45)).toBe(0);
    expect(rippleDisplacement(0.5, 0.3, 0)).toBe(0);
  });

  it('envelope is 1 until the fade starts and continuous down to exactly 0', () => {
    expect(rippleEnvelope(0.01)).toBe(1);
    expect(rippleEnvelope(T.rippleFadeStart)).toBe(1);
    let prev = 1;
    for (let a = T.rippleFadeStart; a < T.rippleDuration; a += 0.001) {
      const e = rippleEnvelope(a);
      expect(prev - e).toBeLessThan(0.01);
      prev = e;
    }
    expect(prev).toBeLessThan(0.001);
    expect(rippleEnvelope(Number.NaN)).toBe(0);
  });

  it('net ripple amplitude grows with ball speed, capped, zero for a trickle', () => {
    expect(netRippleAmplitude(0.5)).toBe(0);
    expect(netRippleAmplitude(Number.NaN)).toBe(0);
    expect(netRippleAmplitude(10)).toBeCloseTo(10 * T.netGain, 9);
    expect(netRippleAmplitude(25)).toBeGreaterThan(netRippleAmplitude(10));
    expect(netRippleAmplitude(80)).toBe(T.netMaxAmp);
  });

  it('frame shake: damped, bounded, exactly 0 after wobbleDuration; the bar shakes more than a post', () => {
    const amp = wobbleAmplitude(1, 20);
    expect(amp).toBeGreaterThan(wobbleAmplitude(0, 20));
    expect(wobbleAmplitude(1, 1000)).toBe(T.wobbleMax);
    expect(wobbleAmplitude(0, -5)).toBe(0);
    let peak = 0;
    for (let a = 0; a < T.wobbleDuration; a += 0.002) {
      const s = wobbleSway(a, amp);
      expect(Math.abs(s)).toBeLessThanOrEqual(amp + 1e-12);
      peak = Math.max(peak, Math.abs(s));
    }
    expect(peak).toBeGreaterThan(0.5 * amp);
    let late = 0;
    for (let a = 0.6; a < T.wobbleDuration; a += 0.002) late = Math.max(late, Math.abs(wobbleSway(a, amp)));
    expect(late).toBeLessThan(0.1 * peak);
    expect(wobbleSway(0, amp)).toBe(0);
    expect(wobbleSway(T.wobbleDuration, amp)).toBe(0);
    expect(wobbleSway(5, amp)).toBe(0);
  });
});

describe('GFX-04 geometry', () => {
  it('goal frame: posts outside the 7.32 m mouth, bar underside at 2.44 m (FND-05 contract)', () => {
    const ms = goalFrameMatrices();
    expect(ms.length).toBe(6);
    const pos = new Vector3();
    pos.setFromMatrixPosition(ms[0]!);
    expect(pos.z).toBeCloseTo(-(GW + POST_RADIUS), 6);
    expect(pos.x).toBeCloseTo(-(HALF_LENGTH - POST_RADIUS), 6);
    pos.setFromMatrixPosition(ms[2]!);
    expect(pos.y - POST_RADIUS).toBeCloseTo(GH, 6);
    pos.setFromMatrixPosition(ms[4]!);
    expect(pos.z).toBeCloseTo(GW + POST_RADIUS, 6);
    expect(pos.x).toBeCloseTo(HALF_LENGTH - POST_RADIUS, 6);
  });

  it('writeTube maps the unit cylinder onto the segment with the radius, no shear', () => {
    const arr = new Float32Array(16);
    writeTube(arr, 0, 1, 2, 3, 4, 6, 3, 0.1, 0.5, 0);
    const m = new Matrix4().fromArray(arr);
    const a = new Vector3(0, -0.5, 0).applyMatrix4(m);
    const b = new Vector3(0, 0.5, 0).applyMatrix4(m);
    // Extended 0.5 beyond A along the segment direction (0.6, 0.8, 0).
    expect(a.x).toBeCloseTo(1 - 0.3, 5); expect(a.y).toBeCloseTo(2 - 0.4, 5); expect(a.z).toBeCloseTo(3, 5);
    expect(b.x).toBeCloseTo(4, 5); expect(b.y).toBeCloseTo(6, 5);
    const c0 = new Vector3(arr[0], arr[1], arr[2]), c1 = new Vector3(arr[4], arr[5], arr[6]), c2 = new Vector3(arr[8], arr[9], arr[10]);
    expect(c0.length()).toBeCloseTo(0.1, 6);
    expect(c2.length()).toBeCloseTo(0.1, 6);
    expect(c1.length()).toBeCloseTo(5.5, 5);
    expect(c0.dot(c1)).toBeCloseTo(0, 5); expect(c0.dot(c2)).toBeCloseTo(0, 6); expect(c1.dot(c2)).toBeCloseTo(0, 5);
    expect(new Vector3().crossVectors(c0, c1).dot(c2)).toBeGreaterThan(0); // right-handed (no mirrored normals)
    for (const d of [[0, 0, 1], [1, 0, 0], [0, -1, 0], [0.3, 0.2, -0.9]]) {
      writeTube(arr, 0, 0, 0, 0, d[0]!, d[1]!, d[2]!, 0.05);
      const k0 = new Vector3(arr[0], arr[1], arr[2]), k1 = new Vector3(arr[4], arr[5], arr[6]), k2 = new Vector3(arr[8], arr[9], arr[10]);
      expect(Math.abs(k0.dot(k1)) + Math.abs(k0.dot(k2)) + Math.abs(k1.dot(k2))).toBeLessThan(1e-6);
      expect(new Vector3().crossVectors(k0, k1).dot(k2)).toBeGreaterThan(0);
    }
  });

  it('frame at rest: posts stand on the goal line from the ground to the bar top; supports frame the net box outside it', () => {
    const arr = new Float32Array(FRAME_INSTANCES * 16);
    writeGoalFrame(arr, 0, 0);
    const end = (i: number, s: number): Vector3 => new Vector3(0, s * 0.5, 0).applyMatrix4(new Matrix4().fromArray(arr, i * 16));
    for (const [i, e, side] of [[0, -1, -1], [1, -1, 1], [3, 1, -1], [4, 1, 1]] as const) {
      const base = end(i, -1), top = end(i, 1);
      expect(base.y).toBeCloseTo(0, 6);
      expect(top.y).toBeCloseTo(GH + 2 * POST_RADIUS, 6);
      expect(base.x).toBeCloseTo(e * (GL - POST_RADIUS), 5);
      expect(base.z).toBeCloseTo(side * (GW + POST_RADIUS), 5);
      // Inner face of the post at |z| = GW, back of the post on the goal line.
      expect(Math.abs(base.z) - POST_RADIUS).toBeCloseTo(GW, 5);
      expect(Math.abs(base.x) + POST_RADIUS).toBeCloseTo(GL, 5);
    }
    // Every support tube stays outside the sim's net box (the ball never meets a support inside the net).
    for (let i = 6; i < FRAME_INSTANCES; i++) {
      const m = new Matrix4().fromArray(arr, i * 16);
      for (let s = -0.5; s <= 0.5; s += 0.05) {
        const p = new Vector3(0, s, 0).applyMatrix4(m);
        const u = Math.abs(p.x);
        const insideBox = u > GL && u < GB - 1e-6 && Math.abs(p.z) < GW - 1e-6 && p.y < GH - 1e-6 && p.y > 0.03;
        expect(insideBox, `support ${i} at ${p.toArray().map((v) => v.toFixed(3))}`).toBe(false);
      }
    }
  });

  it('frame sway rotates the goal about the goal line: tops move into the goal, bases and the back frame stay', () => {
    const rest = new Float32Array(FRAME_INSTANCES * 16);
    const sw = new Float32Array(FRAME_INSTANCES * 16);
    writeGoalFrame(rest, 0, 0);
    writeGoalFrame(sw, 0, 0.05);
    const pt = (arr: Float32Array, i: number, s: number): Vector3 => new Vector3(0, s, 0).applyMatrix4(new Matrix4().fromArray(arr, i * 16));
    // +x goal post: base fixed, top moves +x by sway * height / GH.
    expect(pt(sw, 3, -0.5).distanceTo(pt(rest, 3, -0.5))).toBeLessThan(1e-4);
    expect(pt(sw, 3, 0.5).x - pt(rest, 3, 0.5).x).toBeCloseTo(0.05 * (GH + 2 * POST_RADIUS) / GH, 4);
    // Bar moves with the tops.
    expect(pt(sw, 5, 0).x - pt(rest, 5, 0).x).toBeCloseTo(0.05 * (GH + POST_RADIUS) / GH, 4);
    // Back frame (rear bars, uprights, ground side bars) unchanged; roof side bars keep their back end.
    for (const i of [14, 15, 16, 17, 20, 21]) for (let k = 0; k < 16; k++) expect(sw[i * 16 + k]).toBeCloseTo(rest[i * 16 + k]!, 5);
    for (const i of [18, 19]) expect(pt(sw, i, 0.5).distanceTo(pt(rest, i, 0.5))).toBeLessThan(1e-4);
    // The -x goal is untouched; a -x sway moves its tops toward -x (into that goal).
    for (let k = 0; k < 6 * 16; k++) if (k < 3 * 16) expect(sw[k]).toBeCloseTo(rest[k]!, 6);
    writeGoalFrame(sw, 0.05, 0);
    expect(pt(sw, 0, 0.5).x).toBeLessThan(pt(rest, 0, 0.5).x - 0.04);
  });

  it('net sheets lie on the sim goal box with outward normals; every sheet edge is pinned; the shadow draws first', () => {
    for (const step of T.netStep) {
      const geo = createNetGeometry(step);
      const pos = geo.getAttribute('position');
      const nrm = geo.getAttribute('normal');
      const grid = geo.getAttribute('aGrid');
      const pin = geo.getAttribute('aPin');
      const idx = geo.getIndex()!;
      let shadowVerts = 0;
      let edgeVerts = 0;
      let interiorFull = 0;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const p = pin.getX(i);
        if (p < 0) { shadowVerts++; expect(y).toBeCloseTo(T.shadowY, 6); continue; }
        const u = Math.abs(x);
        expect(u).toBeGreaterThanOrEqual(GL - 1e-5);
        expect(u).toBeLessThanOrEqual(GB + 1e-5);
        expect(Math.abs(z)).toBeLessThanOrEqual(GW + 1e-5);
        expect(y).toBeGreaterThanOrEqual(-1e-6);
        expect(y).toBeLessThanOrEqual(GH + 1e-5);
        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
        // On the plane its normal names, the normal points out of the box.
        if (Math.abs(nx) > 0.5) { expect(u).toBeCloseTo(GB, 5); expect(nx * Math.sign(x)).toBe(1); }
        else if (ny > 0.5) expect(y).toBeCloseTo(GH, 5);
        else { expect(Math.abs(nz)).toBe(1); expect(z * nz).toBeCloseTo(GW, 5); }
        // Pin: 0 on any edge of the box (posts, bar, back frame, ground).
        const onEdge = Math.abs(u - GL) < 1e-4 || Math.abs(u - GB) < 1e-4 || y < 1e-4 || Math.abs(y - GH) < 1e-4
          ? (Math.abs(nx) > 0.5 ? Math.abs(Math.abs(z) - GW) < 1e-4 || y < 1e-4 || Math.abs(y - GH) < 1e-4 : true)
          : Math.abs(Math.abs(z) - GW) < 1e-4;
        if (onEdge) { edgeVerts++; expect(p).toBe(0); }
        if (p === 1) interiorFull++;
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
        expect(grid.getX(i)).toBeGreaterThanOrEqual(-1e-5);
      }
      expect(shadowVerts).toBe(8);
      expect(edgeVerts).toBeGreaterThan(40);
      expect(interiorFull).toBeGreaterThan(0);
      // The first 4 triangles (2 per goal) are the shadows: drawn under the cords in the same draw call.
      for (let k = 0; k < 12; k++) expect(pin.getX(idx.getX(k))).toBe(-1);
      for (let k = 12; k < idx.count; k++) expect(pin.getX(idx.getX(k))).toBeGreaterThanOrEqual(0);
      geo.dispose();
    }
  });

  it('net detail tiers: denser grids at higher detail, a ~24 x 10 back grid at medium, within the triangle budget', () => {
    const tris = T.netStep.map((s) => createNetGeometry(s).getIndex()!.count / 3);
    expect(tris[0]).toBeLessThan(tris[1]!);
    expect(tris[1]).toBeLessThan(tris[2]!);
    expect(tris[2]).toBeLessThan(12000); // both goals; the frame budget is 200k
    const mid = netGridSegments(T.netStep[1]!);
    expect(mid.back[0]).toBeGreaterThanOrEqual(24);
    expect(mid.back[1]).toBeGreaterThanOrEqual(8);
    // Vertex spacing small enough for the ring wave at full detail (>= 6 vertices per wavelength).
    expect(T.netStep[2]!).toBeLessThanOrEqual(T.waveLength / 6);
  });

  it('pin weight: 0 on the edge, smooth, 1 from pinDist in', () => {
    expect(netPinWeight(0)).toBe(0);
    expect(netPinWeight(T.pinDist)).toBe(1);
    expect(netPinWeight(5)).toBe(1);
    expect(netPinWeight(T.pinDist / 2)).toBeCloseTo(0.5, 6);
  });

  it('shaders: the vertex shader evaluates the same ripple constants, sums every slot, and the fragment converts colour space', () => {
    const vs = netVertexShader();
    expect(vs).toContain(`uniform vec4 uRip[${RIPPLE_SLOTS}]`);
    for (let i = 0; i < RIPPLE_SLOTS; i++) expect(vs).toContain(`uRip[${i}]`);
    for (const v of [T.rippleDuration, T.rippleFadeStart, T.bulgeRise, T.waveSpeed, T.waveDecay, T.waveFalloff, T.waveFront, T.waveShare]) {
      expect(vs).toContain(String(v));
    }
    expect(vs).toContain(String((2 * Math.PI) / T.waveLength));
    expect(vs).not.toMatch(/\d\.(?!\d)/); // every float literal is well formed (no "1." without digits)
    const fs = netFragmentShader();
    expect(fs).toContain('#include <colorspace_fragment>');
    expect(fs).toContain('dFdx');
  });
});

describe('GFX-04 impact prediction', () => {
  const out = createNetImpact();
  it('a straight shot meets the back net at its own height', () => {
    predictNetImpact(1, GL + 0.2, 1.2, 0.5, 25, 0, 0, out);
    expect(out.sheet).toBe(SHEET_BACK);
    expect(out.x).toBeCloseTo(GB, 6);
    expect(out.y).toBeCloseTo(1.2, 6);
    expect(out.z).toBeCloseTo(0.5, 6);
    expect(out.t).toBeCloseTo((GB - BALL_RADIUS - GL - 0.2) / 25, 6);
    predictNetImpact(-1, -(GL + 0.2), 1.2, 0.5, -25, 0, 0, out);
    expect(out.x).toBeCloseTo(-GB, 6);
  });

  it('angled shots meet the side netting or the roof; a falling ball rolls on the ground', () => {
    predictNetImpact(1, GL + 0.2, 1, 3, 10, 0, 10, out);
    expect(out.sheet).toBe(SHEET_SIDE_POS);
    expect(out.z).toBe(GW);
    expect(out.x).toBeGreaterThan(GL);
    expect(out.x).toBeLessThan(GB);
    predictNetImpact(-1, -(GL + 0.2), 1, -3, -10, 0, -10, out);
    expect(out.sheet).toBe(SHEET_SIDE_NEG);
    expect(out.z).toBe(-GW);
    predictNetImpact(1, GL + 0.2, 2.2, 0, 10, 8, 0, out);
    expect(out.sheet).toBe(SHEET_ROOF);
    expect(out.y).toBe(GH);
    predictNetImpact(1, GL + 0.2, 0.5, 0, 20, -12, 0, out);
    expect(out.sheet).toBe(SHEET_BACK);
    expect(out.y).toBeCloseTo(BALL_RADIUS, 6);
  });

  it('a ball not moving into any sheet marks the back net at its own place; results stay on the net', () => {
    predictNetImpact(1, GL + 0.5, 0.11, 1, 0, 0, 0, out);
    expect(out.sheet).toBe(SHEET_BACK);
    expect(out.t).toBe(0);
    expect(out.x).toBe(GB);
    for (let i = 0; i < 200; i++) {
      const vx = Math.cos(i) * 20, vy = Math.sin(i * 1.3) * 10, vz = Math.sin(i * 0.7) * 15;
      predictNetImpact(1, GL + 0.15 + (i % 7) * 0.2, 0.11 + (i % 5) * 0.4, (i % 9) - 4, vx, vy, vz, out);
      expect(out.x).toBeGreaterThanOrEqual(GL); expect(out.x).toBeLessThanOrEqual(GB);
      expect(Math.abs(out.z)).toBeLessThanOrEqual(GW);
      expect(out.y).toBeGreaterThanOrEqual(0); expect(out.y).toBeLessThanOrEqual(GH);
      expect(out.t).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('GFX-04 goals module (headless scene)', () => {
  it('two meshes, two draw calls, 22 frame instances; hidden until a match; dispose removes them', () => {
    const ctx = makeCtx();
    const g = createGoals(ctx);
    expect(ctx.scene.children).toContain(g.frame);
    expect(ctx.scene.children).toContain(g.net);
    expect(g.frame.visible).toBe(false);
    expect(g.net.visible).toBe(false);
    expect(g.debug.snapshot().drawCalls).toBe(0);
    g.setMatch!(initMatch(createMatchConfig()), []);
    const snap = g.debug.snapshot();
    expect(snap.drawCalls).toBe(2);
    expect(snap.drawCalls).toBeLessThanOrEqual(6);
    expect(snap.frameInstances).toBe(FRAME_INSTANCES);
    expect(g.frame.instanceColor).not.toBeNull();
    expect(g.frame.material).toHaveProperty('isMeshLambertMaterial', true);
    expect(g.net.material).toHaveProperty('transparent', true);
    expect(g.net.material).toHaveProperty('depthWrite', false);
    const frameTris = 22 * (12 * 2 + 12 * 2);
    expect(frameTris + snap.netTriangles).toBeLessThan(15000);
    g.clearMatch!();
    expect(g.frame.visible).toBe(false);
    g.dispose();
    expect(ctx.scene.children).not.toContain(g.frame);
    expect(ctx.scene.children).not.toContain(g.net);
  });

  it('NET event: an outward ripple scheduled at the predicted impact, grows, then decays to zero and frees its slot', () => {
    const r = rig();
    const b = r.s.ball;
    b.vx = 24; b.vy = 1; b.vz = 2;
    r.goals.onEvents!(eventsOf([{ type: EventType.NET, a: 1, c: 24.2, x: GL + 0.12, y: 1.1, z: 0.4 }]), r.s);
    r.step(0, GL + 0.12, 1.1, 0.4); // uniforms written, no time passes
    let rs = activeRipples(r.goals);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.amp).toBeCloseTo(netRippleAmplitude(24.2), 6);
    expect(rs[0]!.amp).toBeGreaterThan(0.3);
    expect(rs[0]!.x).toBeCloseTo(GB, 5);
    expect(rs[0]!.age).toBeLessThan(0); // pending until the ball gets there
    expect(rs[0]!.age).toBeGreaterThanOrEqual(-T.impactDelayMax);
    expect(rs[0]!.y).toBeGreaterThan(1.1);
    expect(rs[0]!.z).toBeGreaterThan(0.4);
    for (let i = 0; i < 12; i++) r.step(1000 / 60, GL + 1.2, 1.1, 0.5);
    rs = activeRipples(r.goals);
    expect(rs[0]!.age).toBeGreaterThan(0.05);
    for (let i = 0; i < 70; i++) r.step(1000 / 60, GL + 1.2, 0.11, 0.5);
    expect(activeRipples(r.goals)).toHaveLength(0);
    const amp = r.goals.uniforms.uAmp.value;
    expect([amp.x, amp.y, amp.z, amp.w]).toEqual([0, 0, 0, 0]);
  });

  it('a slow ball trickling over the line does not ripple; the goal at -x ripples its own net', () => {
    const r = rig();
    r.goals.onEvents!(eventsOf([{ type: EventType.NET, a: 1, c: 0.8, x: GL + 0.12, y: 0.11, z: 0 }]), r.s);
    r.step(16);
    expect(activeRipples(r.goals)).toHaveLength(0);
    const b = r.s.ball;
    b.vx = -15; b.vy = 0; b.vz = -6;
    r.goals.onEvents!(eventsOf([{ type: EventType.NET, a: -1, c: 16, x: -(GL + 0.12), y: 0.6, z: -2 }]), r.s);
    r.step(16);
    const rs = activeRipples(r.goals);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.x).toBeLessThan(-GL);
  });

  it('paused frames freeze the ripple; dtMs 0 frames do not advance it', () => {
    const r = rig();
    r.s.ball.vx = 20;
    r.goals.onEvents!(eventsOf([{ type: EventType.NET, a: 1, c: 20, x: GL + 0.12, y: 1, z: 0 }]), r.s);
    for (let i = 0; i < 10; i++) r.step(1000 / 60);
    const age = activeRipples(r.goals)[0]!.age;
    for (let i = 0; i < 100; i++) r.step(1000 / 60, undefined, undefined, undefined, true);
    for (let i = 0; i < 10; i++) r.step(0);
    expect(activeRipples(r.goals)[0]!.age).toBe(age);
  });

  it('replays: the interpolated ball crossing into the net ripples without an event; event + crossing ripple once', () => {
    const r = rig();
    // Live: NET event, then the interpolated ball crosses a frame later -> one ripple.
    r.step(16, GL - 2, 1, 0);
    r.s.ball.vx = 25;
    r.goals.onEvents!(eventsOf([{ type: EventType.NET, a: 1, c: 25, x: GL + 0.15, y: 1, z: 0 }]), r.s);
    r.step(16, GL - 0.3, 1, 0);
    r.step(16, GL + 0.15, 1, 0);
    r.step(16, GL + 0.5, 1, 0);
    expect(activeRipples(r.goals)).toHaveLength(1);
    // Replay of the same goal later (no events): the ball path alone ripples the net again.
    for (let i = 0; i < 90; i++) r.step(16, GL + 0.6, 0.11, 0);
    expect(activeRipples(r.goals)).toHaveLength(0);
    r.step(16, 30, 0.11, 0); // replay starts: a jump (teleport) -> nothing
    expect(activeRipples(r.goals)).toHaveLength(0);
    for (let x = 30; x < GL + 0.4; x += 0.4) r.step(16, x, 0.9, 1);
    const rs = activeRipples(r.goals);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.amp).toBeCloseTo(netRippleAmplitude(0.4 / 0.016), 2);
    expect(rs[0]!.x).toBeCloseTo(GB, 5);
  });

  it('side netting hit from outside: an inward ripple on that sheet, once per contact (no spam while resting)', () => {
    const r = rig();
    // Ball moving -z into the outside of the +z side netting of the +x goal.
    const x = GL + 1, y = 0.8;
    r.step(16, x, y, GW + 1.2);
    for (let z = GW + 1.2; z > GW + BALL_RADIUS; z -= 0.2) r.step(16, x, y, z);
    r.step(16, x, y, GW + BALL_RADIUS);
    let rs = activeRipples(r.goals);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.amp).toBeLessThan(0); // pushed into the goal
    expect(rs[0]!.z).toBe(GW);
    expect(rs[0]!.age).toBe(0);
    // Resting against it for a second: no new ripple.
    for (let i = 0; i < 60; i++) r.step(16, x, y, GW + BALL_RADIUS);
    rs = activeRipples(r.goals);
    expect(rs.length).toBeLessThanOrEqual(1);
    // Roof from above: a ball dropping on the roof pushes it down (inward).
    for (let i = 0; i < 80; i++) r.step(16, 0, 0.11, 0);
    r.step(16, GL + 1, GH + 1.5, -1);
    for (let yy = GH + 1.5; yy > GH + BALL_RADIUS; yy -= 0.15) r.step(16, GL + 1, yy, -1);
    r.step(16, GL + 1, GH + BALL_RADIUS, -1);
    rs = activeRipples(r.goals);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.y).toBe(GH);
    expect(rs[0]!.amp).toBeLessThan(0);
  });

  it('a restart that sweeps the interpolated ball through the goal (teleport) never ripples', () => {
    const r = rig();
    r.step(16, GB + 1, 0.11, 1); // behind the goal (goal kick)
    r.step(16, (GB + 1 + 47) / 2, 0.11, 1); // interpolated midway through the net box
    r.step(16, 47, 0.11, 1);
    for (let i = 0; i < 10; i++) r.step(16, 47, 0.11, 1);
    expect(activeRipples(r.goals)).toHaveLength(0);
  });

  it('POST event: the hit goal frame shakes, the net front follows (uSway) and shivers; all back to rest exactly', () => {
    const r = rig();
    const rest = Float32Array.from(r.goals.frame.instanceMatrix.array as Float32Array);
    r.goals.onEvents!(eventsOf([{ type: EventType.POST, a: 1, b: 1, c: 18, x: GL - 0.2, y: GH + 0.1, z: 1 }]), r.s);
    let maxSway = 0;
    let moved = false;
    for (let i = 0; i < 20; i++) {
      r.step(1000 / 60);
      const sw = r.goals.uniforms.uSway.value;
      expect(sw.x).toBe(0);
      maxSway = Math.max(maxSway, Math.abs(sw.y));
      const arr = r.goals.frame.instanceMatrix.array as Float32Array;
      if (Math.abs(arr[5 * 16 + 12]! - rest[5 * 16 + 12]!) > 0.005) moved = true;
      // The -x goal never moves.
      for (let k = 0; k < 3 * 16; k++) expect(arr[k]).toBe(rest[k]);
    }
    expect(maxSway).toBeGreaterThan(0.5 * wobbleAmplitude(1, 18));
    expect(moved).toBe(true);
    expect(r.goals.debug.snapshot().sway[1]).not.toBe(0);
    const rs = activeRipples(r.goals);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.amp).toBeCloseTo(Math.min(T.postRippleMax, 18 * T.postRippleGain), 6);
    for (let i = 0; i < 60; i++) r.step(1000 / 60);
    expect(r.goals.uniforms.uSway.value.y).toBe(0);
    expect(Array.from(r.goals.frame.instanceMatrix.array as Float32Array)).toEqual(Array.from(rest));
  });

  it('ripple pool: more impacts than slots replace the oldest; clearMatch resets everything', () => {
    const r = rig();
    for (let i = 0; i < RIPPLE_SLOTS + 2; i++) {
      r.goals.onEvents!(eventsOf([{ type: EventType.POST, a: 1, b: 0, c: 10 + i, x: GL, y: 1, z: i * 0.5 - 1 }]), r.s);
      r.step(50);
    }
    const rs = activeRipples(r.goals);
    expect(rs).toHaveLength(RIPPLE_SLOTS);
    const zs = rs.map((x) => x.z).sort((a, b) => a - b);
    expect(zs).toEqual([0, 0.5, 1, 1.5]); // the two oldest (z = -1, -0.5) were replaced
    r.goals.clearMatch!();
    r.step(16);
    expect(activeRipples(r.goals)).toHaveLength(0);
    expect(r.goals.uniforms.uSway.value.y).toBe(0);
  });

  it('quality tiers: net detail follows the tier (coarse at PERFORMANCE, full at QUALITY); frame casts shadows only with a shadow map', () => {
    const ctx = makeCtx(QualityTier.PERFORMANCE);
    const g = createGoals(ctx);
    const v0 = g.debug.snapshot().netVertices;
    expect(g.debug.snapshot().netDetail).toBe(0);
    expect(g.frame.castShadow).toBe(false);
    g.setQuality!(QualityTier.QUALITY);
    const s2 = g.debug.snapshot();
    expect(s2.netDetail).toBe(2);
    expect(s2.netVertices).toBeGreaterThan(v0);
    expect(g.net.geometry.getAttribute('position').count).toBe(s2.netVertices);
    expect(g.frame.castShadow).toBe(true);
    g.setQuality!(QualityTier.BALANCED);
    expect(g.debug.snapshot().netDetail).toBe(1);
    expect(g.frame.castShadow).toBe(false);
    g.dispose();
  });

  it('night match dims the net colour; day is white', () => {
    const day = createGoals(makeCtx());
    day.setMatch!(initMatch(createMatchConfig()), []);
    const ctxN = makeCtx(QualityTier.BALANCED, true);
    const night = createGoals(ctxN);
    night.setMatch!(initMatch(createMatchConfig()), []);
    expect(day.uniforms.uColour.value.r).toBeCloseTo(1, 6);
    expect(night.uniforms.uColour.value.r).toBeLessThan(day.uniforms.uColour.value.r);
    day.dispose(); night.dispose();
  });

  it('debug close-up points ctx.camera into the chosen goal after the cameras ran; off again with 0', () => {
    const r = rig();
    r.goals.debug.closeUp(1);
    r.step(16);
    const cam = r.ctx.camera;
    expect(cam.position.x).toBeLessThan(GL);
    expect(cam.position.z).toBeGreaterThan(0);
    const dir = new Vector3();
    cam.getWorldDirection(dir);
    expect(dir.x).toBeGreaterThan(0.3);
    r.goals.debug.closeUp(0);
    cam.position.set(1, 2, 3);
    r.step(16);
    expect(cam.position.toArray()).toEqual([1, 2, 3]);
  });
});

describe('GFX-04 scenario: a real shot into the net', () => {
  it('the sim NET event of a shot ripples the net where the ball goes; the ripple dies within ~1.1 s', () => {
    const ctx = makeCtx();
    const goals = createGoals(ctx);
    const s = initMatch(createMatchConfig());
    s.match.phase = MatchPhase.IN_PLAY;
    for (const p of s.players) { p.x = -30; p.z = 30; } // out of the way
    const b = s.ball;
    b.x = 44; b.y = 0.6; b.z = -1; b.vx = 26; b.vy = 2.5; b.vz = -1.5; b.owner = -1; b.heldBy = -1; b.grounded = 0;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    goals.setMatch!(s, []);
    const prev = cloneState(s);
    const interp = createInterpState();
    const frame: RenderFrame = { prev, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
    const events = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    let netEvent: SimEvent | null = null;
    let firstRipple: { x: number; y: number; z: number; amp: number } | null = null;
    let lastActiveTick = -1;
    let netTick = -1;
    for (let t = 0; t < 150; t++) {
      copyState(prev, s);
      step(s, frames, events);
      for (let i = 0; i < events.count; i++) {
        const e = events.get(i);
        if (e.type === EventType.NET && !netEvent) { netEvent = { ...e }; netTick = t; }
      }
      goals.onEvents!(events, s);
      fillInterp(interp, prev, s, 1);
      frame.frame.nowMs += 1000 / 60;
      goals.update(frame);
      const rs = activeRipples(goals);
      if (rs.length > 0) {
        lastActiveTick = t;
        if (!firstRipple) firstRipple = rs[0]!;
      }
    }
    expect(netEvent, 'the shot entered the net').not.toBeNull();
    expect(netEvent!.a).toBe(1);
    expect(firstRipple).not.toBeNull();
    expect(firstRipple!.amp).toBeGreaterThan(0.2);
    // On the back net (the shot was nearly straight), near the ball's line.
    expect(firstRipple!.x).toBeCloseTo(GB, 4);
    expect(Math.abs(firstRipple!.z - netEvent!.z)).toBeLessThan(1);
    expect(firstRipple!.y).toBeGreaterThan(0);
    expect(firstRipple!.y).toBeLessThan(GH);
    // Gone ~rippleDuration (+ impact delay) after the event: decays to zero.
    expect(lastActiveTick - netTick).toBeLessThanOrEqual(Math.ceil((T.rippleDuration + T.impactDelayMax) * 60) + 1);
    expect(lastActiveTick).toBeLessThan(149);
    goals.dispose();
  });
});
