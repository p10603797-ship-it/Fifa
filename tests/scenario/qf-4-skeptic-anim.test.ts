/**
 * [QF-4 skeptic] QA-32 / FIX-08 animation regressions found from angles the first QF-4 pass did not measure. Driven
 * with scripted sim states through the real GFX-07 model + GFX-12 driver (as render/index.ts draws them, no WebGL), so
 * they do not depend on how often the (still changing) CPU happens to head, throw or receive:
 *  - foot sliding during ACTIONS on the run: the first pass measured planted-boot slip only with no action. Full-body
 *    clips keep their legs planted in model space, so with the body moving the planted boot skated at body speed (live
 *    seed 4 before the fix: first touches p50 4.9 m/s, headers 4.3, throw-in walk 3.4). First touches, headers and
 *    throw-ins on the run now take the run cycle's legs (anim/mapper.ts runLegsUnder; fades between run legs stay
 *    live), and an action (no foot lock) eases the lock's offset back over 0.45 s
 *    (players/model.ts lockReturnAction) instead of lurching the body forward up to 0.3 m in 0.08 s as it starts.
 *    Foot kicks keep their clip legs (the swing needs them): KNOWN_ISSUES candidate.
 *  - first touches at the sim's receive radius: with QF-2's faster passes (7-12 m/s arrivals) most first touches happen
 *    1.0-1.1 m from the player and the touch reach (capped 0.6 m, faded in over 0.08 s) left the boot 0.5-1 m short
 *    (live median 0.49 m); now a 0.85 m cap and a 0.12 s lead (anim/reach.ts, mapper.ts touchIn).
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_TOUCH } from '../../src/contracts/tuning';
import { CLUBS } from '../../src/data/clubs';
import { fillInterp } from '../../src/render/index';
import { Joint } from '../../src/render/players/fk';
import { createPlayerModel } from '../../src/render/players/model';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { initMatch } from '../../src/sim/init';

const TOE = [0.2, -0.08], HEEL = [-0.07, -0.08];
const SLOT = 6;

function wp(S: Float64Array, j: number, lx: number, ly: number, out: number[]): void {
  const o = j * 12;
  out[0] = S[o]! * lx + S[o + 3]! * ly + S[o + 9]!;
  out[1] = S[o + 1]! * lx + S[o + 4]! * ly + S[o + 10]!;
  out[2] = S[o + 2]! * lx + S[o + 5]! * ly + S[o + 11]!;
}

/** Model + scripted state: everyone standing apart, SLOT on the move; step(edit) advances one tick and draws a frame. */
function rig(): { curr: SimState; step: (edit: (s: SimState, t: number) => void) => Float64Array } {
  const curr = initMatch(createMatchConfig()) as SimState;
  curr.match.phase = MatchPhase.IN_PLAY;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = curr.players[i]!;
    p.x = -45 + i * 4; p.z = (i % 4) * 6 - 20; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0; p.act = ActionKind.NONE;
  }
  curr.attrs[SLOT]!.height = 180;
  curr.ball.x = 40; curr.ball.z = 30; curr.ball.y = 0.11; curr.ball.owner = -1; curr.ball.heldBy = -1;
  const prev = cloneState(curr);
  const settings = createDefaultSettings();
  const ctx: RenderContext = {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.44, 2, 600),
    settings, clubs: CLUBS, size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
  const model = createPlayerModel(ctx);
  model.setMatch!(curr, CLUBS);
  const f: RenderFrame = { prev, curr, alpha: 0, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
  let t = 0;
  return {
    curr,
    step(edit) {
      copyState(prev, curr);
      curr.tick++;
      edit(curr, t++);
      f.frame.frame++; f.frame.nowMs += 1000 / 60;
      fillInterp(f.interp, prev, curr, 0);
      model.update(f);
      return model.skeletons[SLOT]!;
    },
  };
}

/**
 * Planted-boot speeds (m/s) of SLOT while he runs at `speed` through action `act` (dur ticks, contact tick), and over
 * the same number of ticks of plain running just before it (the run gait's own toe-off / touch-down readings).
 */
function actionSlip(act: ActionKind, kick: KickKind, speed: number, dur: number, contact: number): { act: number[]; run: number[] } {
  const g = rig();
  const q = [0, 0, 0];
  const last: (number[] | null)[] = [null, null, null, null];
  const out: number[] = [], run: number[] = [];
  const p = g.curr.players[SLOT]!;
  p.x = -30; p.z = 0;
  const pre = 240, total = pre + dur;
  for (let k = 0; k < total + 20; k++) {
    const sk = g.step((s, t) => {
      const pl = s.players[SLOT]!;
      pl.vx = speed; pl.vz = 0; pl.fx = 1; pl.fz = 0; pl.sprinting = speed > 6 ? 1 : 0;
      pl.x += speed / 60;
      if (t >= pre && t < total) {
        const at = t - pre;
        pl.act = act; pl.actKick = kick; pl.actT = at; pl.actDur = dur; pl.actContact = contact;
        pl.actCharging = 0; pl.actDone = contact >= 0 && at >= contact ? 1 : 0;
      } else {
        pl.act = ActionKind.NONE; pl.actT = 0; pl.actContact = -1; pl.actDone = 0;
      }
    });
    const inAct = k >= pre && k < total, inRun = k >= pre - 3 * dur && k < pre;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const fp = b === 0 ? TOE : HEEL;
      wp(sk, a === 0 ? Joint.ANKLE_L : Joint.ANKLE_R, fp[0]!, fp[1]!, q);
      const was = last[a * 2 + b];
      if (was && q[1]! < 0.003 && was[1]! < 0.003) {
        const v = Math.hypot(q[0]! - was[0]!, q[2]! - was[2]!) * 60;
        if (inAct) out.push(v);
        else if (inRun) run.push(v);
      }
      last[a * 2 + b] = [q[0]!, q[1]!, q[2]!];
    }
  }
  return { act: out, run };
}

function median(v: readonly number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[(s.length - 1) >> 1]! : NaN;
}

describe('QF-4 skeptic QA-32: actions on the run', () => {
  it('glitch: foot sliding - first touches, headers and throw-ins on the run keep planted boots (no skating at body speed)', () => {
    const cases: [string, ActionKind, KickKind, number, number][] = [
      ['first touch', ActionKind.FIRST_TOUCH, KickKind.FIRST_TOUCH, 12, 3],
      ['header', ActionKind.HEADER, KickKind.HEADER_PASS, 20, 8],
      ['throw-in walk', ActionKind.THROW_IN, KickKind.THROW_IN, 30, -1],
    ];
    for (const speed of [3, 5.5]) {
      for (const [name, act, kick, dur, contact] of cases) {
        const r = actionSlip(act, kick, speed, dur, contact);
        const tag = `${name} at ${speed} m/s`;
        expect(r.act.length, `${tag}: planted-boot frames`).toBeGreaterThan(4);
        // Before: the planted boot moved with the body (median ~speed: 2.7-5.4 m/s here); the body also lurched forward
        // as the action began (the foot lock's offset dropped in 0.08 s). Now the action reads like the run around it.
        const am = median(r.act), rm = median(r.run);
        expect(am, `${tag}: median planted-boot speed ${am.toFixed(2)} m/s (run ${rm.toFixed(2)}) ${JSON.stringify(r.act.map((x) => +x.toFixed(1)))}`)
          .toBeLessThan(Math.max(0.35 * speed, rm * 1.5 + 0.4));
      }
    }
  });

  it('a first touch at the receive radius: the boot meets a pass met 1.0-1.1 m out', () => {
    // The sim's first touch comes when the ball enters the receive radius (T_TOUCH.receiveRadius).
    const R = T_TOUCH.receiveRadius;
    const res: number[] = [];
    const tags: string[] = [];
    // [ball from (deg off his facing, + = his right), ball speed, his speed]
    const cases: [number, number, number][] = [[0, 9, 2], [30, 9, 3], [-45, 10, 4], [60, 8, 2], [90, 9, 3], [-90, 11, 5], [120, 8, 2], [20, 12, 5]];
    for (const [deg, speed, run] of cases) {
      const g = rig();
      const p = g.curr.players[SLOT]!;
      p.x = 0; p.z = 0;
      const q = [0, 0, 0];
      const a = (deg * Math.PI) / 180;
      // He runs along +x; the ball comes from direction a (model: +x forward, +z his right) and passes 0.1 m beside him.
      const dx = Math.cos(a), dz = Math.sin(a);
      let bx = 14 * dx, bz = 14 * dz + 0.1, touched = false, best = NaN;
      for (let k = 0; k < 300 && !touched; k++) {
        const sk = g.step((s) => {
          const pl = s.players[SLOT]!;
          pl.vx = run; pl.vz = 0; pl.fx = 1; pl.fz = 0; pl.x += run / 60;
          const b = s.ball;
          // Aimed at where he will be: the ball travels toward his position, led by his run.
          const tx = pl.x + run * 0.25 - bx, tz = pl.z - bz, tl = Math.hypot(tx, tz) || 1;
          b.vx = (tx / tl) * speed; b.vz = (tz / tl) * speed; b.vy = 0;
          bx += b.vx / 60; bz += b.vz / 60;
          b.x = bx; b.z = bz; b.y = 0.11; b.owner = -1; b.heldBy = -1; b.passTarget = SLOT;
          if (Math.hypot(b.x - pl.x, b.z - pl.z) <= R) {
            pl.act = ActionKind.FIRST_TOUCH; pl.actKick = KickKind.FIRST_TOUCH; pl.actT = 0; pl.actDur = 12; pl.actContact = 0; pl.actDone = 1;
            b.lastTouch = SLOT; b.lastTouchTick = s.tick;
            touched = true;
          }
        });
        if (touched) {
          const b = g.curr.ball;
          best = Infinity;
          for (const j of [Joint.ANKLE_L, Joint.ANKLE_R]) for (const fp of [TOE, HEEL]) {
            wp(sk, j, fp[0]!, fp[1]!, q);
            best = Math.min(best, Math.hypot(q[0]! - b.x, q[1]! - b.y, q[2]! - b.z));
          }
        }
      }
      expect(touched, `from ${deg} deg`).toBe(true);
      res.push(best);
      tags.push(`${deg}deg ${speed}m/s run ${run}: ${best.toFixed(2)}`);
    }
    console.log('QF-4 skeptic edge first touches', tags.join(' | '));
    // Before: median 0.45 m, worst 1.21 m (a pass across him at 9 m/s). The hardest case left (a 12 m/s pass nearly head
    // on while he runs at 5 m/s: 17 m/s closing) reads ~0.65 m.
    expect(median(res), tags.join(' | ')).toBeLessThan(0.3);
    expect(Math.max(...res), tags.join(' | ')).toBeLessThan(0.7);
  });
});
