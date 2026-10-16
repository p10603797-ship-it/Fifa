/**
 * [QF-14] GKP-02 hopeless dive timing. A lob or dipping shot that passes just over the keeper's dive top near him (he
 * cannot reach it: no standing, diving or drop-back plan) gets a despairing GK_DIVE timed so its full stretch meets the
 * ball's arrival. The timing used the ticks of a full-reach dive while the dive itself went to the (nearer) sample: a
 * short dive that was over 10-20 ticks before the ball came, so he lay on the grass while it floated over him (31 of 80
 * such dives in this grid more than 6 ticks early). Now the timing is that of the dive he makes.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createBallState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { runTicks } from '../harness/scenario';
import { giveBall, KEEPER, place, SHOOTER, shootScene } from '../unit/sim-11-helpers';

const GX = HALF_LENGTH;
const FB = createBallState();
const LAUNCH = createKickLaunch();

/** Untouched path from (x, z): height where it passes the keeper's x (if within 2.6 m of him sideways), and whether
 *  it goes in under the bar. */
function path(x: number, z: number, v: number, el: number, aimZ: number, kx: number, kz: number): { yk: number; inGoal: boolean } {
  copyBallState(createBallState(), FB);
  const dx = GX - x, dz = aimZ - z, l = Math.hypot(dx, dz), h = v * Math.cos(el);
  FB.x = x; FB.z = z; FB.y = 0.11; FB.vx = (h * dx) / l; FB.vz = (h * dz) / l; FB.vy = v * Math.sin(el); FB.grounded = 0;
  let yk = -1;
  for (let t = 0; t < 300; t++) {
    const px = FB.x, py = FB.y, pz = FB.z;
    ballStepTick(FB, null);
    if (yk < 0 && FB.x >= kx) { if (Math.abs(pz - kz) > 2.6) return { yk: -1, inGoal: false }; yk = py; }
    if (FB.x >= GX) {
      const f = (GX - px) / (FB.x - px);
      return { yk, inGoal: py + (FB.y - py) * f < 2.3 && Math.abs(pz + (FB.z - pz) * f) < 3.4 };
    }
  }
  return { yk, inGoal: false };
}

interface DiveTiming { dived: boolean; gap: number }

/** One lob past a set keeper: (dive start + its contact tick) - (tick the ball reaches his x), for a dive he made at
 *  a ball he never touched before it got there; null when the case does not apply. */
function lob(d: number, z: number, aimZ: number, v: number, el: number, seed: number): DiveTiming | null {
  const x = GX - d;
  const s = shootScene(x, z, seed);
  runTicks(s, 90, (_t, st) => { giveBall(st, SHOOTER); place(st, SHOOTER, x, z, 1, 0); st.ball.owner = SHOOTER; });
  const k = s.players[KEEPER]!;
  const p = path(x + 0.5, z, v, el, aimZ, k.x, k.z);
  // Over his dive top where it passes him, then under the bar: the case with no reachable plan.
  if (!p.inGoal || p.yk < 2.25 || p.yk > 3.0) return null;
  const b = s.ball;
  b.x = x + 0.5; b.z = z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0;
  const dx = GX - b.x, dz = aimZ - b.z, l = Math.hypot(dx, dz), h = v * Math.cos(el);
  const L = LAUNCH;
  L.vx = (h * dx) / l; L.vz = (h * dz) / l; L.vy = v * Math.sin(el); L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = KickKind.SHOT_NORMAL; L.target = -1; L.tx = GX; L.tz = aimZ; L.onTarget = 1;
  applyKick(s, SHOOTER, L, 0.6, NULL_SINK);
  let start = -1, contact = 0, kx = 0, arrive = -1, touchedFirst = false;
  runTicks(s, 200, undefined, {
    until: (st, ev) => {
      const kk = st.players[KEEPER]!;
      if (start < 0 && kk.act === ActionKind.GK_DIVE) { start = st.tick; contact = kk.actContact; kx = kk.x; }
      if (start >= 0 && arrive < 0 && st.ball.x >= kx) arrive = st.tick;
      if (ev.some((e) => e.type === EventType.GOAL)) return true;
      if (st.ball.lastTouch === KEEPER) { if (arrive < 0) touchedFirst = true; return true; }
      return st.match.phase !== MatchPhase.IN_PLAY;
    },
  });
  if (start < 0 || arrive < 0 || touchedFirst) return { dived: false, gap: 0 };
  return { dived: true, gap: start - 1 + contact - arrive };
}

describe('QF-14 GKP-02 hopeless dive at a lob just over the keeper', () => {
  it('glitch: keeper dives early at a lob and lies down as it floats over him — the dive meets the ball\'s arrival', () => {
    let cases = 0, dives = 0, early = 0;
    const gaps: number[] = [];
    let seed = 500;
    for (const d of [12, 15, 18, 21]) for (const z of [-12, -6, 0, 6, 12]) for (const aimZ of [-3.2, -2, 2, 3.2]) {
      for (const v of [13, 15, 17, 19]) for (const el of [0.32, 0.38, 0.44, 0.5]) {
        const r = lob(d, z, aimZ, v, el, seed++);
        if (!r) continue;
        cases++;
        if (!r.dived) continue;
        dives++;
        gaps.push(r.gap);
        if (r.gap < -6) early++;
      }
    }
    expect(cases).toBeGreaterThanOrEqual(40);
    expect(dives, `gaps ${gaps.join(',')}`).toBeGreaterThanOrEqual(12);
    // Full stretch within 6 ticks of the ball's arrival (before: a third of these dives 7-25 ticks early).
    expect(early, `gaps ${gaps.join(',')}`).toBeLessThanOrEqual(1);
  }, 120000);
});
