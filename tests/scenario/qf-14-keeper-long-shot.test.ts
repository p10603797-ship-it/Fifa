/**
 * [QF-14] GKP-01 / GKP-02 against a full-power long shot. With the rushed taps gone (qf-14-rushed-shot) the CPU's long
 * shots are struck at 24-28 m/s and rise to 4-5 m (an aimed long shot climbs to carry, up to T_SHOT.maxAimedElevation),
 * then dip under the bar: 10 goals from 80 shots from 28 m and more in 25 Professional matches (real football: about
 * 3%). The keeper stood T_GK.depthFar 4.5 m off his line for a ball 28 m+ out, the ball went over him above his reach,
 * he shuffled across at the jog jockey cap (about 2 m/s) and made a hopeless dive where he stood while it dropped in
 * behind him. Now he stands depthFar 3 m off, tracks a shot's path at the sprint jockey cap, and drops back toward a
 * ball that comes down behind his plane (saveKinematics dropBack / trackSprint).
 */
import { describe, expect, it } from 'vitest';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createBallState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_GK } from '../../src/contracts/tuning';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { LOCAL_TUNING as KIN } from '../../src/sim/keeper/saveKinematics';
import { runTicks } from '../harness/scenario';
import { giveBall, KEEPER, place, SHOOTER, shootScene, skill } from '../unit/sim-11-helpers';

const GX = HALF_LENGTH;
const FLY = createBallState();
const LAUNCH = createKickLaunch();

/** Where an untouched ball launched from (x, z) at speed v, elevation el toward (GX, aimZ) crosses the goal line. */
function crossing(x: number, z: number, v: number, el: number, aimZ: number): { y: number; z: number } | null {
  const b = FLY;
  copyBallState(createBallState(), b);
  const dx = GX - x, dz = aimZ - z, l = Math.hypot(dx, dz);
  const h = v * Math.cos(el);
  b.x = x; b.z = z; b.y = 0.11; b.vx = (h * dx) / l; b.vz = (h * dz) / l; b.vy = v * Math.sin(el); b.grounded = 0;
  for (let t = 0; t < 400; t++) {
    const px = b.x, py = b.y, pz = b.z;
    ballStepTick(b, null);
    if (b.x >= GX) {
      const f = (GX - px) / (b.x - px);
      return { y: py + (b.y - py) * f, z: pz + (b.z - pz) * f };
    }
  }
  return null;
}

/** A long shot from (x, z): the keeper settles for 90 ticks while the shooter holds the ball, then it is struck. */
function longShot(x: number, z: number, v: number, el: number, aimZ: number, seed: number): 'goal' | 'kept' | 'other' {
  const s = shootScene(x, z, seed);
  skill(s, SHOOTER, 85);
  s.attrs[KEEPER]!.gkReflexes = 75; s.attrs[KEEPER]!.gkDiving = 75; s.attrs[KEEPER]!.gkHandling = 75;
  s.attrs[KEEPER]!.gkPositioning = 75;
  // Let GKP-01 position him for a ball this far out (the shooter keeps it at his feet, standing).
  runTicks(s, 90, (_t, st) => { giveBall(st, SHOOTER); place(st, SHOOTER, x, z, 1, 0); st.ball.owner = SHOOTER; });
  const b = s.ball;
  b.x = x + 0.5; b.z = z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0;
  const dx = GX - b.x, dz = aimZ - b.z, l = Math.hypot(dx, dz);
  const h = v * Math.cos(el);
  const L = LAUNCH;
  L.vx = (h * dx) / l; L.vz = (h * dz) / l; L.vy = v * Math.sin(el); L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = KickKind.SHOT_NORMAL; L.target = -1; L.tx = GX; L.tz = aimZ; L.onTarget = 1;
  applyKick(s, SHOOTER, L, 0.85, NULL_SINK);
  let out: 'goal' | 'kept' | 'other' = 'other';
  runTicks(s, 200, undefined, {
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.GOAL) { out = 'goal'; return true; }
        if (e.type === EventType.SAVE || e.type === EventType.KEEPER_HANDS) { out = 'kept'; return true; }
      }
      if (st.ball.lastTouch === KEEPER) { out = 'kept'; return true; }
      return st.match.phase !== MatchPhase.IN_PLAY;
    },
  });
  return out;
}

describe('QF-14 keeper against a dipping long shot', () => {
  it('reads the tables (depthFar 3 m, drop back and sprint tracking on)', () => {
    expect(T_GK.depthFar).toBeLessThanOrEqual(3.2);
    expect(KIN.dropBack).toBe(1);
    expect(KIN.trackSprint).toBe(1);
    expect(NUM_SLOTS).toBe(22);
  });

  it('glitch: keeper lobbed off his line by a long shot — dipping 28-34 m shots under the bar are kept', () => {
    let n = 0, goals = 0, kept = 0;
    let seed = 1;
    for (const d of [29, 32, 35]) {
      for (const z of [-8, 0, 8]) {
        for (const aimZ of [-2.6, 2.6]) {
          for (const [v, el] of [[25, 0.36], [27, 0.31]] as const) {
            const x = GX - d;
            const c = crossing(x + 0.5, z, v, el, aimZ);
            // Only shots that would go in untouched, dipping in under the bar (the case that beat him).
            if (!c || c.y > GOAL_HEIGHT - 0.3 || c.y < 0.9 || Math.abs(c.z) > GOAL_HALF_WIDTH - 0.2) continue;
            const r = longShot(x, z, v, el, aimZ, seed++);
            n++;
            if (r === 'goal') goals++;
            if (r === 'kept') kept++;
          }
        }
      }
    }
    expect(n).toBeGreaterThanOrEqual(12);
    expect(goals / n).toBeLessThanOrEqual(0.1);
    expect(kept).toBeGreaterThanOrEqual(n - goals - 2);
  });
});
