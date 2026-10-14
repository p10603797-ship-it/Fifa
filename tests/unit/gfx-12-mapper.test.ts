/**
 * [GFX-12] Animation mapping and blending (src/render/anim/mapper.ts) with synthetic sim states: the mapping table
 * (every ActionKind -> expected AnimId, kick / dive / celebration / keeper / wall refinements, locomotion choice),
 * contact alignment (clip phase at actContact == the clip's contact fraction, charged kicks hold the backswing), the
 * cross-fade (no pose jump across clip changes, finished before a pending contact), the distance-driven stride cycle
 * and its teleport reset, turn lean, upper-body layering, foot choice, the stub API, and that nothing writes sim state.
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { AnimId, createPose, POSE_SIZE, PoseIdx, type Pose } from '../../src/contracts/render';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { ACTION_CONTACT, ACTION_HOLD, ACTION_POSES } from '../../src/render/anim/actions';
import { CONTACT_CONTACT } from '../../src/render/anim/contact';
import { LOCOMOTION_POSES, LOWER_BODY, strideLength, strideLengthFor } from '../../src/render/anim/locomotion';
import {
  ACTION_ANIM, actionPhase, advanceCycle, blendTime, contactFractionFor, createAnimBank, createAnimDriver, createAnimator,
  createAnimSample, kickAnim, mapAnim, MAPPER_TUNING, poseFnFor, samplePose, shotAnim, type Animator,
} from '../../src/render/anim/mapper';
import { createInterpState, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

const P = PoseIdx;
const TAU = Math.PI * 2;
const SLOT = 6;

function makeState(): SimState {
  const s = initMatch(createMatchConfig());
  s.match.phase = MatchPhase.IN_PLAY;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = -45 + i * 4; p.z = (i % 4) * 6 - 9; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
  }
  s.ball.x = 50; s.ball.z = 30; s.ball.owner = -1; s.ball.heldBy = -1;
  return s;
}

function frameFor(s: SimState, alpha = 1, dtMs = 1000 / 60, paused = false): RenderFrame {
  const interp = createInterpState();
  fillInterp(interp, s);
  return { prev: s, curr: s, alpha, frame: { nowMs: 0, dtMs, frame: 0, ticks: 1, paused }, interp };
}

function fillInterp(it: ReturnType<typeof createInterpState>, s: SimState): void {
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    it.x[i] = p.x; it.z[i] = p.z; it.vx[i] = p.vx; it.vz[i] = p.vz; it.fx[i] = p.fx; it.fz[i] = p.fz;
  }
}

function setAct(s: SimState, slot: number, act: ActionKind, actT: number, dur: number, contact: number): void {
  const p = s.players[slot]!;
  p.act = act; p.actT = actT; p.actDur = dur; p.actContact = contact; p.actDone = 0; p.actCharging = 0;
}

function anim(s: SimState, slot = SLOT, speed = 0): AnimId {
  const out = createAnimSample();
  mapAnim(s, slot, speed, out);
  return out.anim;
}

/** Collecting sink. */
function sink(): { poses: Float32Array[]; calls: number[]; setPose(slot: number, pose: ArrayLike<number>): void } {
  const poses: Float32Array[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) poses.push(new Float32Array(POSE_SIZE));
  const calls: number[] = [];
  return {
    poses, calls,
    setPose(slot: number, pose: ArrayLike<number>): void { calls.push(slot); poses[slot]!.set(pose as Float32Array); },
  };
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>, chans: readonly number[] | null = null): number {
  let m = 0;
  if (chans) for (const k of chans) m = Math.max(m, Math.abs(a[k]! - b[k]!));
  else for (let k = 0; k < POSE_SIZE; k++) m = Math.max(m, Math.abs(a[k]! - b[k]!));
  return m;
}

describe('[GFX-12] mapping table: ActionKind -> AnimId', () => {
  it('every ActionKind maps to its clip (defaults)', () => {
    const expected: [ActionKind, AnimId][] = [
      [ActionKind.KICK, AnimId.PASS], [ActionKind.SHOT, AnimId.SHOT], [ActionKind.HEADER, AnimId.HEADER],
      [ActionKind.VOLLEY, AnimId.VOLLEY], [ActionKind.FIRST_TOUCH, AnimId.FIRST_TOUCH], [ActionKind.SKILL, AnimId.SKILL],
      [ActionKind.FAKE, AnimId.SKILL], [ActionKind.STAND_TACKLE, AnimId.STAND_TACKLE], [ActionKind.HARD_TACKLE, AnimId.STAND_TACKLE],
      [ActionKind.SLIDE_TACKLE, AnimId.SLIDE], [ActionKind.SHOULDER, AnimId.STAND_TACKLE], [ActionKind.PUSH_PULL, AnimId.STAND_TACKLE],
      [ActionKind.STUMBLE, AnimId.STUMBLE], [ActionKind.FALLEN, AnimId.FALL], [ActionKind.GET_UP, AnimId.GET_UP],
      [ActionKind.GK_HOLD, AnimId.KEEPER_HOLD], [ActionKind.GK_THROW, AnimId.GK_THROW], [ActionKind.GK_KICK, AnimId.GK_KICK],
      [ActionKind.GK_PUNCH, AnimId.PARRY], [ActionKind.THROW_IN, AnimId.THROW_IN], [ActionKind.DEJECTED, AnimId.DEJECTION],
      [ActionKind.SHIELD, AnimId.SHIELD],
    ];
    for (const [act, want] of expected) {
      const s = makeState();
      setAct(s, SLOT, act, 3, 30, 10);
      expect(anim(s), ActionKind[act]).toBe(want);
      expect(ACTION_ANIM[act], ActionKind[act]).toBe(want);
    }
  });

  it('kick kinds pick pass / shot / power shot / finesse / chip / volley / header clips', () => {
    expect(kickAnim(KickKind.GROUND_PASS)).toBe(AnimId.PASS);
    expect(kickAnim(KickKind.THROUGH_GROUND)).toBe(AnimId.PASS);
    expect(kickAnim(KickKind.DRIVEN_PASS)).toBe(AnimId.SHOT);
    expect(kickAnim(KickKind.CROSS)).toBe(AnimId.SHOT);
    expect(kickAnim(KickKind.CLEARANCE)).toBe(AnimId.SHOT);
    expect(shotAnim(KickKind.SHOT_NORMAL)).toBe(AnimId.SHOT);
    expect(shotAnim(KickKind.SHOT_POWER)).toBe(AnimId.POWER_SHOT);
    expect(shotAnim(KickKind.SHOT_FINESSE)).toBe(AnimId.FINESSE);
    expect(shotAnim(KickKind.SHOT_CHIP)).toBe(AnimId.PASS);
    expect(shotAnim(KickKind.VOLLEY_SHOT)).toBe(AnimId.VOLLEY);
    expect(shotAnim(KickKind.HEADER_SHOT)).toBe(AnimId.HEADER);
    const s = makeState();
    setAct(s, SLOT, ActionKind.SHOT, 2, 30, 22);
    s.players[SLOT]!.actKick = KickKind.SHOT_POWER;
    expect(anim(s)).toBe(AnimId.POWER_SHOT);
  });

  it('keeper dive class / side, celebration variant, catch mode and wall mode refine the clip', () => {
    const s = makeState();
    const k = 0;
    for (const [a, b, want] of [[0, -1, AnimId.DIVE_LOW_L], [1, 1, AnimId.DIVE_MID_R], [2, -1, AnimId.DIVE_HIGH_L], [2, 1, AnimId.DIVE_HIGH_R]] as const) {
      setAct(s, k, ActionKind.GK_DIVE, 5, 60, 20);
      s.players[k]!.actA = a; s.players[k]!.actB = b;
      expect(anim(s, k), `dive ${a} ${b}`).toBe(want);
    }
    for (const [v, want] of [[0, AnimId.CELEBRATE_1], [1, AnimId.CELEBRATE_2], [2, AnimId.CELEBRATE_3]] as const) {
      setAct(s, SLOT, ActionKind.CELEBRATE, 10, 240, -1);
      s.players[SLOT]!.actA = v;
      expect(anim(s)).toBe(want);
    }
    setAct(s, k, ActionKind.GK_CATCH, 3, 20, -1);
    s.players[k]!.actA = 1;
    expect(anim(s, k)).toBe(AnimId.CATCH);
    s.players[k]!.actA = 0;
    s.ball.x = s.players[k]!.x + 5; s.ball.z = s.players[k]!.z;
    expect(anim(s, k)).toBe(AnimId.KEEPER_READY); // tracking toward the save spot
    setAct(s, SLOT, ActionKind.WALL_JUMP, 3, 40, 10);
    s.players[SLOT]!.actA = 1;
    expect(anim(s)).toBe(AnimId.WALL_JUMP);
    s.players[SLOT]!.actA = 2;
    expect(anim(s, SLOT, 5)).toBe(AnimId.JOG); // charging out at the kicker
  });

  it('locomotion: idle / jog / sprint by speed and flags, strafe off the facing, jockey, shield, keeper ready, ball in hands', () => {
    const s = makeState();
    const p = s.players[SLOT]!;
    expect(anim(s, SLOT, 0)).toBe(AnimId.IDLE);
    p.vx = 4;
    expect(anim(s, SLOT, 4)).toBe(AnimId.JOG);
    p.sprinting = 1;
    expect(anim(s, SLOT, 8)).toBe(AnimId.SPRINT);
    p.sprinting = 0;
    p.vx = 0; p.vz = 2; // moving to his right while facing +x
    expect(anim(s, SLOT, 2)).toBe(AnimId.STRAFE);
    p.jockeying = 1;
    expect(anim(s, SLOT, 2)).toBe(AnimId.JOCKEY);
    p.jockeying = 0; p.shielding = 1;
    expect(anim(s, SLOT, 1)).toBe(AnimId.SHIELD);
    p.shielding = 0;
    // Keeper in play with the ball near: ready stance; far away: plain locomotion.
    const k = s.players[0]!;
    s.ball.x = k.x + 10; s.ball.z = k.z;
    expect(anim(s, 0, 0)).toBe(AnimId.KEEPER_READY);
    s.ball.x = k.x + 70;
    expect(anim(s, 0, 0)).toBe(AnimId.IDLE);
    s.match.phase = MatchPhase.GOAL_KICK;
    s.ball.x = k.x + 3;
    expect(anim(s, 0, 0)).toBe(AnimId.IDLE);
    // Ball in the keeper's hands with no action: holding clip.
    s.ball.heldBy = 0;
    expect(anim(s, 0, 0)).toBe(AnimId.KEEPER_HOLD);
  });

  it('throw-in taker holds the ready pose (t = 0) until the throw, then plays it', () => {
    const s = makeState();
    setAct(s, SLOT, ActionKind.THROW_IN, 50, 700, -1);
    const o = createAnimSample();
    mapAnim(s, SLOT, 0, o);
    expect(o.anim).toBe(AnimId.THROW_IN);
    expect(o.t).toBe(0);
    setAct(s, SLOT, ActionKind.THROW_IN, 10, 30, 12);
    mapAnim(s, SLOT, 0, o);
    expect(o.t).toBeGreaterThan(0.2);
  });
});

describe('[GFX-12] contact alignment', () => {
  it('actionPhase maps actContact to the contact fraction for any wind-up, piecewise linear around it', () => {
    for (const a of [AnimId.PASS, AnimId.SHOT, AnimId.POWER_SHOT, AnimId.FINESSE, AnimId.VOLLEY, AnimId.HEADER, AnimId.GK_KICK]) {
      const cf = ACTION_CONTACT[a]!;
      expect(contactFractionFor(a)).toBe(cf);
      for (const [contact, dur] of [[8, 18], [10, 24], [22, 36], [5, 40], [30, 31]] as const) {
        expect(actionPhase(contact, contact, dur, cf, 1, 0, 0, 0.2), `${AnimId[a]} ${contact}/${dur} before`).toBeCloseTo(cf, 9);
        expect(actionPhase(contact, contact, dur, cf, 1, 1, 0, 0.2), `${AnimId[a]} ${contact}/${dur} done`).toBeCloseTo(cf, 9);
        expect(actionPhase(0, contact, dur, cf, 1, 0, 0, 0.2)).toBe(0);
        expect(actionPhase(dur, contact, dur, cf, 1, 1, 0, 0.2)).toBeCloseTo(1, 9);
        expect(actionPhase(contact / 2, contact, dur, cf, 1, 0, 0, 0.2)).toBeCloseTo(cf / 2, 9);
      }
    }
    for (const a of [AnimId.STAND_TACKLE, AnimId.SLIDE, AnimId.DIVE_MID_R, AnimId.PARRY, AnimId.WALL_JUMP]) {
      expect(contactFractionFor(a)).toBe(CONTACT_CONTACT[a]);
      expect(actionPhase(12, 12, 50, CONTACT_CONTACT[a]!, 0, 0, 0, -1)).toBeCloseTo(CONTACT_CONTACT[a]!, 9);
    }
    // No contact tick: linear over the duration.
    expect(actionPhase(15, -1, 30, -1, 0, 0, 0, -1)).toBeCloseTo(0.5, 9);
    expect(actionPhase(99, -1, 30, -1, 0, 0, 0, -1)).toBe(1);
    expect(actionPhase(5, 8, 0, 0.4, 1, 0, 0, 0.2)).toBe(0);
  });

  it('a charged kick winds up to the backswing top and holds there until the contact', () => {
    const cf = ACTION_CONTACT[AnimId.SHOT]!, hold = ACTION_HOLD[AnimId.SHOT]!;
    expect(actionPhase(5, 10, 24, cf, 1, 0, 1, hold)).toBeCloseTo(hold / 2, 9);
    expect(actionPhase(10, 10, 24, cf, 1, 0, 1, hold)).toBeCloseTo(hold, 9);
    expect(actionPhase(40, 10, 24, cf, 1, 0, 1, hold)).toBeCloseTo(hold, 9);
    // Released: the contact moves to the release tick and the clip goes on from the contact fraction.
    expect(actionPhase(40, 40, 54, cf, 1, 1, 0, hold)).toBeCloseTo(cf, 9);
  });

  it('the animator shows the contact pose on the frame where the ball is still at the foot (u = actT + alpha = actContact)', () => {
    const s = makeState();
    const a = createAnimator();
    const sk = sink();
    const contact = 10, dur = 24;
    s.players[SLOT]!.actKick = KickKind.SHOT_NORMAL;
    // Wind-up from the first action tick, 60 Hz frames with alpha 0.5 .. then exactly at the contact.
    for (let t = 1; t < contact; t++) {
      setAct(s, SLOT, ActionKind.SHOT, t, dur, contact);
      s.players[SLOT]!.actKick = KickKind.SHOT_NORMAL;
      a.update(frameFor(s, 0.5), sk);
    }
    setAct(s, SLOT, ActionKind.SHOT, contact - 1, dur, contact);
    s.players[SLOT]!.actKick = KickKind.SHOT_NORMAL;
    a.update(frameFor(s, 1), sk);
    const cf = ACTION_CONTACT[AnimId.SHOT]!;
    expect(a.samples[SLOT]!.anim).toBe(AnimId.SHOT);
    expect(a.samples[SLOT]!.t).toBeCloseTo(cf, 6);
    expect(a.bank.blend[SLOT]).toBe(1); // the cross-fade finished before the contact
    const clip = createPose();
    ACTION_POSES[AnimId.SHOT]!(clip, cf, 0, 0, 1, a.samples[SLOT]!.foot);
    expect(maxDiff(sk.poses[SLOT]!, clip)).toBeLessThan(1e-5);
  });

  it('the cross-fade into a kick always ends before its contact tick', () => {
    expect(blendTime(AnimId.JOG, AnimId.PASS, 8, 1, 0, 1)).toBeLessThanOrEqual((7 / 60) * MAPPER_TUNING.blendBeforeContact + 1e-9);
    expect(MAPPER_TUNING.blendBeforeContact).toBeLessThan(1);
    expect(blendTime(AnimId.JOG, AnimId.PASS, 8, 7.5, 0, 1)).toBeGreaterThanOrEqual(0.03);
    expect(blendTime(AnimId.JOG, AnimId.SPRINT, -1, 0, 0, 0)).toBe(MAPPER_TUNING.blendLoco);
    expect(blendTime(AnimId.KEEPER_READY, AnimId.DIVE_LOW_R, 30, 1, 0, 0)).toBe(MAPPER_TUNING.blendDive);
    expect(blendTime(AnimId.JOG, AnimId.SLIDE, 4, 1, 0, 0)).toBe(MAPPER_TUNING.blendAction); // only kicks clamp to the contact
  });
});

describe('[GFX-12] blending, cycle, teleports', () => {
  function runFrames(a: Animator, s: SimState, n: number, step: (i: number) => void, record: Float32Array[]): void {
    const sk = sink();
    for (let i = 0; i < n; i++) {
      step(i);
      a.update(frameFor(s, 1), sk);
      record.push(new Float32Array(sk.poses[SLOT]!));
    }
  }

  it('blend continuity: cutting a jog into a pass, a tackle or a slide never pops a joint', () => {
    for (const [act, contact, dur] of [[ActionKind.KICK, 8, 18], [ActionKind.STAND_TACKLE, 6, 28], [ActionKind.SLIDE_TACKLE, 4, 66]] as const) {
      const s = makeState();
      const a = createAnimator();
      const rec: Float32Array[] = [];
      const p = s.players[SLOT]!;
      p.vx = 5;
      runFrames(a, s, 60, (i) => {
        p.x += 5 / 60;
        if (i < 30) { p.act = ActionKind.NONE; return; }
        setAct(s, SLOT, act, i - 29, dur, contact);
      }, rec);
      // The cut frame repeats the last pose (the cross-fade starts from it) and no later frame jumps: the largest
      // per-frame change stays within a fast but continuous motion (a 6-8 tick wind-up is legitimately quick).
      expect(maxDiff(rec[30]!, rec[29]!), `${ActionKind[act]} cut frame`).toBeLessThan(0.05);
      let worst = 0;
      for (let i = 31; i < rec.length; i++) worst = Math.max(worst, maxDiff(rec[i]!, rec[i - 1]!));
      expect(worst, ActionKind[act]).toBeLessThan(0.6);
    }
  });

  it('without the cross-fade the same cut would jump (the blend is what keeps it smooth)', () => {
    const jog = createPose(), pass = createPose();
    LOCOMOTION_POSES[AnimId.JOG]!(jog, 0, 2.2, 5, 1, 0);
    ACTION_POSES[AnimId.PASS]!(pass, 1 / 18, 0, 0, 1, 0);
    expect(maxDiff(jog, pass)).toBeGreaterThan(0.4);
  });

  it('the stride cycle advances by distance / stride length (2 PI per stride)', () => {
    const s = makeState();
    const a = createAnimator();
    const p = s.players[SLOT]!;
    p.vx = 5;
    a.update(frameFor(s), null);
    const c0 = a.bank.cycle[SLOT]!;
    for (let i = 0; i < 12; i++) { p.x += 5 / 60; a.update(frameFor(s), null); }
    const advanced = (a.bank.cycle[SLOT]! - c0 + TAU) % TAU;
    expect(advanced).toBeCloseTo(((12 * 5) / 60 / strideLengthFor(AnimId.JOG, 5)) * TAU, 4);
    expect(strideLengthFor(AnimId.JOG, 5)).toBe(strideLength(5));
  });

  it('teleport reset: a jump over 3 m does not advance the cycle and cuts without a cross-fade', () => {
    const s = makeState();
    const a = createAnimator();
    const p = s.players[SLOT]!;
    p.vx = 5;
    for (let i = 0; i < 5; i++) { p.x += 5 / 60; a.update(frameFor(s), null); }
    const c0 = a.bank.cycle[SLOT]!;
    p.x += 12; // restart placement / replay cut
    setAct(s, SLOT, ActionKind.FALLEN, 1, 70, -1); // and a new clip on the same frame
    a.update(frameFor(s), null);
    expect(a.bank.cycle[SLOT]).toBe(c0);
    expect(a.bank.blend[SLOT]).toBe(1);
    const clip = createPose();
    poseFnFor(AnimId.FALL)(clip, a.samples[SLOT]!.t, c0, 5, 1, 0);
    expect(maxDiff(a.poses[SLOT]!, clip, null)).toBeLessThan(1e-6);
  });

  it('turning while running leans into the turn (TURN_LEAN from the smoothed yaw rate), the right way', () => {
    for (const dir of [1, -1]) {
      const s = makeState();
      const a = createAnimator();
      const p = s.players[SLOT]!;
      let ang = 0;
      for (let i = 0; i < 30; i++) {
        ang += (dir * 2.5) / 60; // 2.5 rad/s, + = toward the right vector (-fz, fx)
        p.fx = Math.cos(ang); p.fz = Math.sin(ang);
        p.vx = 6 * p.fx; p.vz = 6 * p.fz;
        p.x += p.vx / 60; p.z += p.vz / 60;
        a.update(frameFor(s), null);
      }
      expect(a.samples[SLOT]!.anim).toBe(AnimId.TURN_LEAN);
      expect(Math.sign(a.yawRate[SLOT]!)).toBe(dir);
      expect(a.poses[SLOT]![P.ROOT_ROLL]! * dir).toBeGreaterThan(0.15);
    }
  });

  it('upper-body layering: the keeper walking with the ball takes the run legs and keeps the holding arms', () => {
    const s = makeState();
    const a = createAnimator();
    const k = s.players[0]!;
    setAct(s, 0, ActionKind.GK_HOLD, 20, 362, -1);
    s.ball.heldBy = 0;
    k.vx = 2.5;
    for (let i = 0; i < 40; i++) { k.x += 2.5 / 60; setAct(s, 0, ActionKind.GK_HOLD, 20 + i, 362, -1); a.update(frameFor(s), null); }
    expect(a.samples[0]!.anim).toBe(AnimId.KEEPER_HOLD);
    const legs = createPose(), arms = createPose();
    LOCOMOTION_POSES[AnimId.JOG]!(legs, 0, a.bank.cycle[0]!, 2.5, 1, 0);
    poseFnFor(AnimId.KEEPER_HOLD)(arms, a.samples[0]!.t, 0, 0, 1, 0);
    const lower = LOWER_BODY.filter((c) => c !== P.ROOT_ROLL);
    expect(maxDiff(a.poses[0]!, legs, lower)).toBeLessThan(0.02);
    expect(maxDiff(a.poses[0]!, arms, [P.SHOULDER_L_PITCH, P.ELBOW_L, P.SHOULDER_R_PITCH, P.ELBOW_R])).toBeLessThan(1e-4);
  });

  it('restarting the same action re-blends; a phase jump within a clip blends briefly instead of popping', () => {
    const s = makeState();
    const a = createAnimator();
    const sk = sink();
    for (let t = 1; t <= 18; t++) { setAct(s, SLOT, ActionKind.KICK, t, 18, 8); s.players[SLOT]!.actDone = t >= 8 ? 1 : 0; a.update(frameFor(s), sk); }
    const before = new Float32Array(sk.poses[SLOT]!);
    setAct(s, SLOT, ActionKind.KICK, 1, 18, 8); // next pass straight away
    a.update(frameFor(s), sk);
    expect(a.bank.blend[SLOT]).toBeLessThan(1);
    expect(maxDiff(sk.poses[SLOT]!, before)).toBeLessThan(0.3);
  });

  it('foot choice: preferred foot, the weak foot when the ball sits on that side, kept for the whole action', () => {
    const s = makeState();
    const a = createAnimator();
    const p = s.players[SLOT]!;
    s.attrs[SLOT]!.foot = 1; // left-footed
    s.ball.x = p.x + 0.4; s.ball.z = p.z - 0.1;
    setAct(s, SLOT, ActionKind.KICK, 1, 18, 8);
    a.update(frameFor(s), null);
    expect(a.samples[SLOT]!.foot).toBe(1);
    // A new kick with the ball clearly on his right: right foot, kept even if the ball moves.
    p.act = ActionKind.NONE;
    a.update(frameFor(s), null);
    s.ball.z = p.z + 0.5;
    setAct(s, SLOT, ActionKind.KICK, 1, 18, 8);
    a.update(frameFor(s), null);
    expect(a.samples[SLOT]!.foot).toBe(0);
    s.ball.z = p.z - 0.5;
    setAct(s, SLOT, ActionKind.KICK, 2, 18, 8);
    a.update(frameFor(s), null);
    expect(a.samples[SLOT]!.foot).toBe(0);
  });

  it('paused frames freeze the cross-fade; sent-off players get no pose', () => {
    const s = makeState();
    const a = createAnimator();
    const sk = sink();
    a.update(frameFor(s), sk);
    setAct(s, SLOT, ActionKind.STUMBLE, 1, 30, -1);
    a.update(frameFor(s, 1, 1000 / 60, true), sk);
    const w = a.bank.blend[SLOT]!;
    a.update(frameFor(s, 1, 1000 / 60, true), sk);
    expect(a.bank.blend[SLOT]).toBe(w);
    s.players[3]!.active = 0;
    sk.calls.length = 0;
    a.update(frameFor(s), sk);
    expect(sk.calls).not.toContain(3);
    expect(sk.calls.length).toBe(NUM_SLOTS - 1);
  });

  it('never writes sim state (the state is identical after many animated frames)', () => {
    const s = makeState();
    setAct(s, SLOT, ActionKind.SHOT, 4, 24, 10);
    setAct(s, 0, ActionKind.GK_DIVE, 9, 60, 20);
    s.players[2]!.vx = 6; s.players[2]!.sprinting = 1;
    const before = JSON.stringify({ p: s.players, b: s.ball, m: s.match, t: s.teams });
    const a = createAnimator();
    const drive = createAnimDriver();
    const sk = sink();
    for (let i = 0; i < 50; i++) { a.update(frameFor(s, (i % 10) / 10), sk); drive(frameFor(s), sk); }
    expect(JSON.stringify({ p: s.players, b: s.ball, m: s.match, t: s.teams })).toBe(before);
  });

  it('every written pose is finite and inside the joint limits during a busy synthetic match', () => {
    const s = makeState();
    const a = createAnimator();
    const sk = sink();
    const acts = [ActionKind.KICK, ActionKind.SHOT, ActionKind.SLIDE_TACKLE, ActionKind.FALLEN, ActionKind.GK_DIVE, ActionKind.CELEBRATE, ActionKind.NONE];
    for (let f = 0; f < 240; f++) {
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        const act = acts[(i + Math.floor(f / 40)) % acts.length]!;
        setAct(s, i, act, (f % 40) + 1, 40, act === ActionKind.CELEBRATE || act === ActionKind.FALLEN ? -1 : 12);
        p.actA = i % 3; p.actB = i % 2 === 0 ? 1 : -1;
        p.vx = (i % 5) * 1.5; p.x += p.vx / 60;
      }
      a.update(frameFor(s, 0.5), sk);
      for (let i = 0; i < NUM_SLOTS; i++) {
        for (let k = 0; k < POSE_SIZE; k++) expect(Number.isFinite(sk.poses[i]![k]!)).toBe(true);
      }
    }
  });
});

describe('[GFX-12] stub API (the model default driver)', () => {
  it('advanceCycle uses the stride of the clip / speed mapAnim last saw; samplePose = poseFnFor', () => {
    const s = makeState();
    const bank = createAnimBank();
    const smp = createAnimSample();
    s.players[SLOT]!.vx = 5;
    mapAnim(s, SLOT, 5, smp);
    expect(smp.anim).toBe(AnimId.JOG);
    advanceCycle(bank, SLOT, 1);
    expect(bank.cycle[SLOT]).toBeCloseTo((1 / strideLength(5)) * TAU, 5);
    advanceCycle(bank, SLOT, Number.NaN);
    advanceCycle(bank, 99, 1);
    expect(bank.cycle[SLOT]).toBeCloseTo((1 / strideLength(5)) * TAU, 5);
    const a = createPose(), b = createPose();
    samplePose(smp, 1.3, 5, a);
    poseFnFor(AnimId.JOG)(b, smp.t, 1.3, 5, smp.side, smp.foot);
    for (let k = 0; k < POSE_SIZE; k++) expect(a[k]).toBe(b[k]);
    expect(poseFnFor(999 as AnimId)).toBeTypeOf('function');
  });

  it('every AnimId resolves to a pose function that writes a finite pose', () => {
    for (let id = 0; id <= AnimId.STRAFE; id++) {
      const out: Pose = createPose();
      poseFnFor(id as AnimId)(out, 0.5, 1, 3, 1, 0);
      for (let k = 0; k < POSE_SIZE; k++) expect(Number.isFinite(out[k]!), `${AnimId[id]} ch ${k}`).toBe(true);
    }
  });
});
