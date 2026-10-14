/**
 * [QF-4] QA-32 / FIX-08 animation regressions in live play (real sim, CPU v CPU; real GFX-07 model + GFX-12 driver, as
 * render/index.ts draws them, no WebGL), measured in the world like the e2e checks:
 *  - no visible limb teleports: no joint moves more than 0.45 m per drawn frame relative to the pelvis (GFX-12 e2e "no
 *    joint pops" failed at 0.55: a charged kick's strike squeezed into its release tick, compressed follow-throughs);
 *  - ball contact (INT-C: "dribble touches and first touches have no boot contact"): kicks meet the ball the sim kicks,
 *    dribble touches and first touches reach it, A/B against the reach switched off in the same process;
 *  - sharp turns (> 4 rad/s): planted boots stay planted (INT-C: "sharp turns still slip").
 * Plus focused animator cases: the charged-kick release strike and the kick reach toward off-spot balls.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, ControllerKind, KickKind, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { AnimId, createPose, POSE_SIZE } from '../../src/contracts/render';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { ACTION_CONTACT, ACTION_HOLD, ACTION_POSES } from '../../src/render/anim/actions';
import { createAnimator } from '../../src/render/anim/mapper';
import { kickReach, RCH, REACH_BALL, REACH_SWITCH } from '../../src/render/anim/reach';
import { fillInterp } from '../../src/render/index';
import { BODY, createSkeleton, Joint, solvePoseFK } from '../../src/render/players/fk';
import { createPlayerModel } from '../../src/render/players/model';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const TOE = [0.2, -0.08], HEEL = [-0.07, -0.08];

function wp(S: Float64Array, j: number, lx: number, ly: number, out: number[]): void {
  const o = j * 12;
  out[0] = S[o]! * lx + S[o + 3]! * ly + S[o + 9]!;
  out[1] = S[o + 1]! * lx + S[o + 4]! * ly + S[o + 10]!;
  out[2] = S[o + 2]! * lx + S[o + 5]! * ly + S[o + 11]!;
}

interface Live {
  /** Contact distances (m) per "Action/KickKind" of KICK events. */
  contact: Record<string, number[]>;
  pops: number;
  popMax: number;
  popAt: string;
  /** Planted-boot slip ratios of turns faster than 4 rad/s and of everything. */
  slipSharp: number[];
  slipAll: number[];
}

/** Live CPU v CPU play from tick 600 for `ticks` ticks at `fpt` drawn frames per tick. */
function live(seed: number, ticks: number, fpt: number): Live {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const curr = initMatch(cfg) as SimState;
  const prev = cloneState(curr);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const settings = createDefaultSettings();
  const ctx: RenderContext = {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.44, 2, 600),
    settings, clubs: CLUBS, size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
  const model = createPlayerModel(ctx);
  model.setMatch!(curr, CLUBS);
  const f: RenderFrame = { prev, curr, alpha: 0, frame: { nowMs: 0, dtMs: 1000 / (60 * fpt), frame: 0, ticks: 0, paused: false }, interp: createInterpState() };
  const q = [0, 0, 0];
  const out: Live = { contact: {}, pops: 0, popMax: 0, popAt: '', slipSharp: [], slipAll: [] };
  const prevJ = new Float64Array(NUM_SLOTS * 13 * 3).fill(NaN);
  const last: (number[] | null)[] = Array.from({ length: NUM_SLOTS * 4 }, () => null);
  for (let t = 0; t < 600 + ticks; t++) {
    copyState(prev, curr);
    step(curr, frames, ev);
    const isLive = t >= 600 && curr.match.phase === MatchPhase.IN_PLAY;
    const pend: { slot: number; x: number; y: number; z: number; key: string }[] = [];
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK || t < 600) continue;
      pend.push({ slot: e.a, x: e.x, y: e.y, z: e.z, key: `${ActionKind[curr.players[e.a]!.act]}/${KickKind[e.b]}` });
    }
    if (t < 570) continue;
    for (let k = 0; k < fpt; k++) {
      f.alpha = k / fpt; f.frame.frame++; f.frame.nowMs += f.frame.dtMs; f.frame.ticks = k === 0 ? 1 : 0;
      fillInterp(f.interp, prev, curr, f.alpha);
      model.update(f);
      if (k === 0) {
        for (const kk of pend) {
          let best = Infinity;
          for (const j of [Joint.ANKLE_L, Joint.ANKLE_R]) for (const fp of [TOE, HEEL]) {
            wp(model.skeletons[kk.slot]!, j, fp[0]!, fp[1]!, q);
            best = Math.min(best, Math.hypot(q[0]! - kk.x, q[1]! - kk.y, q[2]! - kk.z));
          }
          (out.contact[kk.key] ??= []).push(best);
        }
      }
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = curr.players[i]!;
        if (p.active !== 1) continue;
        const sk = model.skeletons[i]!;
        const ex = [sk[0]!, sk[1]!, sk[2]!], ey = [sk[3]!, sk[4]!, sk[5]!], ez = [sk[6]!, sk[7]!, sk[8]!];
        const k2 = ex[0] * ex[0] + ex[1] * ex[1] + ex[2] * ex[2];
        for (let j = 1; j < 13; j++) {
          const wx = sk[j * 12 + 9]! - sk[9]!, wy = sk[j * 12 + 10]! - sk[10]!, wz = sk[j * 12 + 11]! - sk[11]!;
          const rx = (wx * ex[0] + wy * ex[1] + wz * ex[2]) / k2, ry = (wx * ey[0] + wy * ey[1] + wz * ey[2]) / k2;
          const rz = (wx * ez[0] + wy * ez[1] + wz * ez[2]) / k2;
          const o = (i * 13 + j) * 3;
          if (isLive && prevJ[o] === prevJ[o]) {
            const d = Math.hypot(rx - prevJ[o]!, ry - prevJ[o + 1]!, rz - prevJ[o + 2]!);
            if (d > 0.45) out.pops++;
            if (d > out.popMax) { out.popMax = d; out.popAt = `tick ${curr.tick} slot ${i} joint ${j} act ${ActionKind[p.act]}`; }
          }
          prevJ[o] = rx; prevJ[o + 1] = ry; prevJ[o + 2] = rz;
        }
        const speed = Math.hypot(f.interp.vx[i]!, f.interp.vz[i]!);
        const pp = prev.players[i]!;
        const omega = Math.abs(Math.atan2(pp.fx * p.fz - pp.fz * p.fx, pp.fx * p.fx + pp.fz * p.fz)) * 60;
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
          const key = i * 4 + a * 2 + b;
          const fp = b === 0 ? TOE : HEEL;
          wp(sk, a === 0 ? Joint.ANKLE_L : Joint.ANKLE_R, fp[0]!, fp[1]!, q);
          const was = last[key];
          if (was && isLive && speed > 2 && p.act === ActionKind.NONE && q[1]! < 0.003 && was[1]! < 0.003) {
            const r = (Math.hypot(q[0]! - was[0]!, q[2]! - was[2]!) * 60 * fpt) / speed;
            out.slipAll.push(r);
            if (omega > 4) out.slipSharp.push(r);
          }
          last[key] = [q[0]!, q[1]!, q[2]!];
        }
      }
    }
  }
  return out;
}

function median(v: readonly number[] | undefined): number {
  if (!v || v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[(s.length - 1) >> 1]!;
}

function share(v: readonly number[], below: number): number {
  let n = 0;
  for (const x of v) if (x < below) n++;
  return v.length ? n / v.length : NaN;
}

describe('QF-4 QA-32 animation in live play', () => {
  it('glitch: visible limb teleports - no joint moves more than 0.45 m per frame relative to the pelvis (60 Hz); sharp turns keep planted boots', () => {
    const m = live(20261014, 2400, 1);
    console.log('QF-4 anim 60 Hz', JSON.stringify({ pops: m.pops, popMax: m.popMax, popAt: m.popAt,
      slipAll: median(m.slipAll), slipSharp: median(m.slipSharp), sharpStill: share(m.slipSharp, 0.1), n: m.slipSharp.length }));
    expect(m.pops, `worst ${m.popMax.toFixed(2)} m at ${m.popAt}`).toBe(0);
    // INT-C: "sharp turns (> 2 rad/s) still slip". Before QF-4 the > 4 rad/s frames read p50 0.14, stationary 0.45.
    expect(m.slipSharp.length).toBeGreaterThan(1000);
    expect(median(m.slipSharp)).toBeLessThan(0.09);
    expect(share(m.slipSharp, 0.1)).toBeGreaterThan(0.55);
    expect(median(m.slipAll)).toBeLessThan(0.08);
    expect(share(m.slipAll, 0.1)).toBeGreaterThan(0.6);
  });

  it('120 Hz display: no joint pops either', () => {
    const m = live(777, 1200, 2);
    console.log('QF-4 anim 120 Hz', JSON.stringify({ pops: m.pops, popMax: m.popMax, popAt: m.popAt }));
    expect(m.pops, `worst ${m.popMax.toFixed(2)} m at ${m.popAt}`).toBe(0);
  });

  it('ball contact: kicks meet the ball, dribble touches and first touches reach it (A/B against the reach switched off)', () => {
    const on = live(4, 2400, 1);
    const sw = { ...REACH_SWITCH };
    REACH_SWITCH.kick = 0; REACH_SWITCH.touch = 0; REACH_SWITCH.align = 0;
    let off: Live;
    try { off = live(4, 2400, 1); } finally { Object.assign(REACH_SWITCH, sw); }
    const kick = (L: Live): number[] => [...(L.contact['KICK/GROUND_PASS'] ?? []), ...(L.contact['KICK/CROSS'] ?? []), ...(L.contact['SHOT/SHOT_NORMAL'] ?? [])];
    const summary = {
      kickOn: median(kick(on)), kickOff: median(kick(off)),
      dribbleOn: median(on.contact['NONE/DRIBBLE_TOUCH']), dribbleOff: median(off.contact['NONE/DRIBBLE_TOUCH']),
      firstOn: median(on.contact['FIRST_TOUCH/FIRST_TOUCH']), firstOff: median(off.contact['FIRST_TOUCH/FIRST_TOUCH']),
    };
    console.log('QF-4 contact', JSON.stringify(summary));
    expect(kick(on).length).toBeGreaterThan(5);
    expect(summary.kickOn).toBeLessThan(0.2);
    expect(summary.kickOn).toBeLessThanOrEqual(summary.kickOff + 0.02);
    // INT-C: dribble touches and first touches 0.3-1 m from the boot.
    expect((on.contact['NONE/DRIBBLE_TOUCH'] ?? []).length).toBeGreaterThan(20);
    expect(summary.dribbleOn).toBeLessThan(0.32);
    expect(summary.dribbleOn).toBeLessThan(summary.dribbleOff * 0.75);
    expect((on.contact['FIRST_TOUCH/FIRST_TOUCH'] ?? []).length).toBeGreaterThan(8);
    expect(summary.firstOn).toBeLessThan(0.55);
    expect(summary.firstOn).toBeLessThan(summary.firstOff * 0.75);
  });
});

describe('QF-4 QA-32 animator: strikes and reach', () => {
  function state(): SimState {
    const s = initMatch(createMatchConfig()) as SimState;
    s.match.phase = MatchPhase.IN_PLAY;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      p.x = -45 + i * 4; p.z = (i % 4) * 6 - 9; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0; p.act = ActionKind.NONE;
    }
    return s;
  }
  function frame(s: SimState, alpha = 0): RenderFrame {
    const it = createInterpState();
    fillInterp(it, s, s, 1);
    return { prev: s, curr: s, alpha, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: it };
  }
  const SLOT = 6;

  it('a charged kick released shows its strike over two frames (no pop) and then the contact pose', () => {
    const s = state();
    const a = createAnimator();
    const p = s.players[SLOT]!;
    s.ball.x = p.x + 0.4; s.ball.z = p.z + 0.1; s.ball.y = 0.11; s.ball.owner = SLOT; s.ball.heldBy = -1;
    const poses: Float32Array[] = [];
    const sink = { setPose(slot: number, pose: ArrayLike<number>): void { if (slot === SLOT) poses.push(new Float32Array(pose as Float32Array)); } };
    // Wind-up (8 ticks), charging until tick 30, released: the sim kicks on the release tick (contact = actT).
    for (let t = 1; t <= 34; t++) {
      p.act = ActionKind.KICK; p.actKick = KickKind.DRIVEN_PASS; p.actT = t; p.actDur = t <= 30 ? 19 : 41;
      p.actContact = t <= 30 ? 8 : 30; p.actCharging = t < 30 ? 1 : 0; p.actDone = t >= 30 ? 1 : 0;
      a.update(frame(s), sink);
    }
    const cf = ACTION_CONTACT[AnimId.SHOT]!, hold = ACTION_HOLD[AnimId.SHOT]!;
    // Frames 0..28 charging at the backswing top; frame 29 (release) half way; frame 30 at the contact phase.
    expect(a.samples[SLOT]!.anim).toBe(AnimId.SHOT);
    const sk0 = createSkeleton(), sk1 = createSkeleton();
    let worst = 0;
    for (let i = 20; i < poses.length; i++) {
      solvePoseFK(poses[i - 1]!, sk0);
      solvePoseFK(poses[i]!, sk1);
      for (let j = 1; j < 13; j++) {
        const o = j * 12;
        worst = Math.max(worst, Math.hypot(sk1[o + 9]! - sk1[9]! - sk0[o + 9]! + sk0[9]!, sk1[o + 10]! - sk1[10]! - sk0[o + 10]! + sk0[10]!,
          sk1[o + 11]! - sk1[11]! - sk0[o + 11]! + sk0[11]!));
      }
    }
    expect(worst).toBeLessThan(0.45);
    expect(hold).toBeLessThan(cf);
  });

  it('kick reach: the boot meets balls off the clip\'s spot (to the side, further ahead, closer), both feet', () => {
    const PP = createPose();
    const sk = createSkeleton();
    for (const anim of [AnimId.PASS, AnimId.SHOT, AnimId.FINESSE]) {
      for (const foot of [0, 1]) {
        const mz = foot === 1 ? -1 : 1;
        const bx = REACH_BALL[anim * 3]!, by = REACH_BALL[anim * 3 + 1]!, bz = REACH_BALL[anim * 3 + 2]! * mz;
        for (const [dx, dz] of [[0, 0], [0.25, 0], [-0.12, 0], [0, 0.3 * mz], [0, -0.15 * mz], [0.2, 0.25 * mz]]) {
          const pose = createPose();
          // Contact pose of the clip, then the reach toward the moved ball.
          ACTION_POSES[anim]!(pose, ACTION_CONTACT[anim]!, 0, 0, 1, foot);
          for (let c = 0; c < POSE_SIZE; c++) PP[c] = pose[c]!;
          RCH[0] = bx + dx; RCH[1] = by; RCH[2] = bz + dz; RCH[3] = 1;
          kickReach(PP, anim, foot);
          solvePoseFK(PP, sk);
          const j = foot === 1 ? Joint.ANKLE_L : Joint.ANKLE_R;
          const o = j * 12;
          const tx = sk[o]! * BODY.toeX + sk[o + 3]! * -BODY.ankleY + sk[o + 9]!;
          const ty = sk[o + 1]! * BODY.toeX + sk[o + 4]! * -BODY.ankleY + sk[o + 10]!;
          const tz = sk[o + 2]! * BODY.toeX + sk[o + 5]! * -BODY.ankleY + sk[o + 11]!;
          const d = Math.hypot(tx - RCH[0]!, ty - RCH[1]!, tz - RCH[2]!);
          expect(d, `${AnimId[anim]} foot ${foot} ball offset ${dx},${dz}`).toBeLessThan(0.16);
        }
      }
    }
  });
});
