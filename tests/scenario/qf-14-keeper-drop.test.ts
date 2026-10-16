/**
 * [QF-14 resume] GKP-02 against a ball that loops over a keeper off his line (a chip, a lob, a dipping long shot after
 * he came out). Two planning defects in `planIntercept` (src/sim/keeper/saves.ts):
 *  - The standing save added the step allowance (up to stepMax 0.8 m, a horizontal step) to the 3D distance from the
 *    standing capsule, so a ball up to 0.8 m above his standing reach (3.1 m high for a 1.88 m keeper) counted as a
 *    standing catch a second ahead: he set himself under it (GK_CATCH CATCH_STAND, `actCurve` = the planned ball
 *    height) and watched it go over him, with no dive or drop back while there was still time.
 *  - The drop back (CATCH_DROP) is re-planned every tick, and every re-plan assumed he set off from rest after
 *    dropSlackTicks again: two ticks in, the spot he was backpedalling to no longer counted as reachable, so the target
 *    jumped or he gave the drop up for a track / hopeless dive where he was.
 * In this grid (a 75-rated keeper put 4.5 / 5.5 m off his line, lobs that pass over him and come down under the bar)
 * 87 of 172 went in before, 76 with the step fix alone, 82 with the drop fix alone, 69 with both.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createBallState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { standTop } from '../../src/sim/keeper/saveKinematics';
import { runTicks } from '../harness/scenario';
import { giveBall, KEEPER, place, SHOOTER, shootScene, skill } from '../unit/sim-11-helpers';

const GX = HALF_LENGTH;
const FB = createBallState();
const LAUNCH = createKickLaunch();
const CATCH_STAND = 1;
const CATCH_DROP = 3;

/** Untouched path from (x, z): height where it passes depth k0, and where it crosses the goal line. */
function path(x: number, z: number, v: number, el: number, aimZ: number, k0: number): { yk: number; y: number; z: number } | null {
  copyBallState(createBallState(), FB);
  const dx = GX - x, dz = aimZ - z, l = Math.hypot(dx, dz), h = v * Math.cos(el);
  FB.x = x; FB.z = z; FB.y = 0.11; FB.vx = (h * dx) / l; FB.vz = (h * dz) / l; FB.vy = v * Math.sin(el); FB.grounded = 0;
  let yk = -1;
  for (let t = 0; t < 400; t++) {
    const px = FB.x, py = FB.y, pz = FB.z;
    ballStepTick(FB, null);
    if (yk < 0 && FB.x >= GX - k0) yk = py;
    if (FB.x >= GX) { const f = (GX - px) / (FB.x - px); return { yk, y: py + (FB.y - py) * f, z: pz + (FB.z - pz) * f }; }
  }
  return null;
}

interface Grid { n: number; goals: number; standHigh: number; drops: number; dropJumps: number }

/** Lobs over a keeper standing k0 m off his line (put there just before the kick). */
function grid(k0s: readonly number[]): Grid {
  const r: Grid = { n: 0, goals: 0, standHigh: 0, drops: 0, dropJumps: 0 };
  let seed = 1;
  for (const k0 of k0s) {
    for (const d of [18, 22, 26, 30, 34]) for (const z of [-8, 0, 8]) for (const aimZ of [-2.6, 0, 2.6]) {
      for (const v of [14, 17, 20, 23, 26]) for (const el of [0.3, 0.38, 0.46, 0.54]) {
        const x = GX - d;
        const c = path(x + 0.5, z, v, el, aimZ, k0);
        // In under the bar, and over his head where it passes him.
        if (!c || c.y > GOAL_HEIGHT - 0.25 || c.y < 0.3 || Math.abs(c.z) > GOAL_HALF_WIDTH - 0.2 || c.yk < 2.4) continue;
        const s = shootScene(x, z, seed++);
        skill(s, SHOOTER, 85);
        const ka = s.attrs[KEEPER]!;
        ka.gkReflexes = 75; ka.gkDiving = 75; ka.gkHandling = 75; ka.gkPositioning = 75;
        runTicks(s, 90, (_t, st) => { giveBall(st, SHOOTER); place(st, SHOOTER, x, z, 1, 0); st.ball.owner = SHOOTER; });
        const kp = s.players[KEEPER]!;
        kp.x = GX - k0; kp.z = 0; kp.vx = 0; kp.vz = 0;
        const top = standTop(ka);
        const b = s.ball;
        b.x = x + 0.5; b.z = z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0;
        const dx = GX - b.x, dz = aimZ - b.z, l = Math.hypot(dx, dz), h = v * Math.cos(el);
        const L = LAUNCH;
        L.vx = (h * dx) / l; L.vz = (h * dz) / l; L.vy = v * Math.sin(el); L.sx = 0; L.sy = 0; L.sz = 0;
        L.kind = KickKind.SHOT_NORMAL; L.target = -1; L.tx = GX; L.tz = aimZ; L.onTarget = 1;
        applyKick(s, SHOOTER, L, 0.85, NULL_SINK);
        r.n++;
        let goal = false, high = false, dropped = false, prevDrop = false, px = 0, pz = 0;
        runTicks(s, 300, undefined, {
          check: 'all',
          until: (st, ev) => {
            const k = st.players[KEEPER]!;
            if (k.act === ActionKind.GK_CATCH && k.actA === CATCH_STAND && k.actCurve > top + 0.05) high = true;
            const isDrop = k.act === ActionKind.GK_CATCH && k.actA === CATCH_DROP;
            if (isDrop) dropped = true;
            if (isDrop && prevDrop && Math.hypot(k.actX - px, k.actZ - pz) > 0.3) r.dropJumps++;
            prevDrop = isDrop; px = k.actX; pz = k.actZ;
            for (const e of ev) {
              if (e.type === EventType.GOAL) { goal = true; return true; }
              if (e.type === EventType.SAVE || e.type === EventType.KEEPER_HANDS) return true;
            }
            if (st.ball.lastTouch === KEEPER) return true;
            return st.match.phase !== MatchPhase.IN_PLAY;
          },
        });
        if (goal) r.goals++;
        if (high) r.standHigh++;
        if (dropped) r.drops++;
      }
    }
  }
  if (process.env.QF14_REPORT) console.log(`keeper drop grid ${k0s.join('/')}: ${JSON.stringify(r)}`);
  return r;
}

describe('QF-14 GKP-02: a ball looping over a keeper off his line', () => {
  const g = grid([4.5, 5.5]);

  it('glitch: keeper sets himself under a lob that goes over his head — a standing catch is planned only within his standing reach', () => {
    expect(g.n).toBeGreaterThanOrEqual(150);
    // Before: 61 of these lobs had him set for a standing catch of a ball up to 0.8 m over his reach.
    expect(g.standHigh).toBe(0);
  });

  it('glitch: keeper gives up backpedalling under a lob — the drop-back spot holds and more of these lobs are kept', () => {
    expect(g.drops).toBeGreaterThanOrEqual(60);
    // Before: the spot jumped by 0.5-0.6 m mid-drop (6 times) as each re-plan restarted him from rest.
    expect(g.dropJumps).toBe(0);
    // 87 of 172 went in before, 76 / 82 with only the step / only the drop fix, 69 with both.
    expect(g.goals).toBeLessThanOrEqual(73);
  });
});
