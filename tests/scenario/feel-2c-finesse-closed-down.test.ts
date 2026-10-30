/**
 * [FEEL-2C] A human's finesse after a short run, struck at a Professional keeper rushing out at him (D-040). The FEEL-2
 * round-2 skeptic's probe: shooter slot 7 (finishing / long shots / curve / shot power 85, ASSISTED, auto-switch off),
 * everyone else parked, the keeper set at (51.5, 0); he R1-dribbles 5-7 m (straight, or diagonally from 3 m to the
 * side) to a spot 17-19 m out, then shoots with SHOOT held 28 ticks and the stick at goal-line z +-2.2, +-2.8 or +-3.4.
 * At the strike the keeper is 7.5-10.2 m from the ball. D-037's placed finesse (keeper room from 7 m, placed from the
 * stick's ray clamped to the corner) scored 91.5% there against 68.1% for a normal shot (98% in the worst cell, 81-94%
 * with the stick 2.2 m off centre against a normal shot's 6-50%).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AssistLevel, AutoSwitch, Difficulty, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_FEEL2 } from '../../src/contracts/tuning';
import { GOAL_HALF_WIDTH } from '../../src/contracts/constants';
import { shotAimPoint } from '../../src/sim/kicks/shot';
import { makeScenario, runTicks } from '../harness/scenario';

const GX = 52.5;
const SLOT = 7;
const KEEPER = 11;
type K = 'normal' | 'finesse';

function stick(f: InputFrame, dx: number, dz: number): void {
  const l = Math.hypot(dx, dz);
  if (!(l > 1e-9)) return;
  f.mx = Math.round((dx / l) * 127);
  f.mz = Math.round((dz / l) * 127);
}

function park(s: SimState): void {
  for (let i = 0; i < 22; i++) {
    if (i === SLOT || i === 0 || i === KEEPER) continue;
    const p = s.players[i]!;
    if (i < 11) { p.x = -50; p.z = -30 + i * 6; } else { p.x = -45 + (i - 11) * 6; p.z = -33; }
    p.vx = 0; p.vz = 0;
  }
}

function scene(seed: number): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, config: { difficulty: Difficulty.PROFESSIONAL },
    humans: [{ side: 0, slot: SLOT, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
  });
  park(s);
  const a = s.attrs[SLOT]!;
  a.finishing = 85; a.longShots = 85; a.curve = 85; a.shotPower = 85;
  return s;
}

/** Shot from (x, z) at the end of an R1 run from (x - rx, z - rz), the stick at goal-line z = aimZ: goal or not. */
function runShot(k: K, x: number, z: number, rx: number, rz: number, aimZ: number, seed: number): boolean {
  const s = scene(seed);
  const p = s.players[SLOT]!;
  const sx = x - rx, sz = z - rz;
  const rl = Math.hypot(rx, rz);
  const ux = rx / rl, uz = rz / rl;
  p.x = sx; p.z = sz; p.fx = ux; p.fz = uz; p.vx = 0; p.vz = 0;
  const kp = s.players[KEEPER]!;
  kp.x = 51.5; kp.z = 0; kp.vx = 0; kp.vz = 0; kp.fx = -1; kp.fz = 0;
  const bx = sx + ux * 0.5, bz = sz + uz * 0.5;
  Object.assign(s.ball, { x: bx, y: 0.11, z: bz, px: bx, py: 0.11, pz: bz, vx: 0, vy: 0, vz: 0, owner: SLOT, lastTouch: SLOT, lastTouchTeam: 0, heldBy: -1 });
  let kicked = false, press = -1, goal = false;
  runTicks(s, 500, (tk, st, o) => {
    const f = o[0]!;
    if (kicked) return;
    const q = st.players[SLOT]!;
    if (press < 0) {
      if ((q.x - sx) * ux + (q.z - sz) * uz < rl) { stick(f, ux, uz); f.buttons |= Btn.MOD_R; return; }
      press = tk;
    }
    stick(f, GX - q.x, aimZ - q.z);
    if (k === 'finesse') f.buttons |= Btn.MOD_R;
    if (tk - press < 28) f.buttons |= Btn.SHOOT;
  }, {
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.KICK && e.a === SLOT && e.b >= KickKind.SHOT_NORMAL && e.b <= KickKind.SHOT_LOW_DRIVEN) kicked = true;
        if (e.type === EventType.GOAL) { goal = true; return true; }
      }
      if (kicked && st.match.phase !== MatchPhase.IN_PLAY) return true;
      if (kicked && st.ball.x < 38 && st.ball.owner < 0 && Math.hypot(st.ball.vx, st.ball.vz) < 1) return true;
      if (!kicked && st.ball.owner !== SLOT && st.ball.owner >= 0) return true;
      return false;
    },
  });
  return goal;
}

const SPOTS: readonly (readonly [number, number])[] = [[34, 0], [35, -2], [36, 1]];
const RUNS: readonly (readonly [number, number])[] = [[5, 0], [6, 3], [6, -3], [7, 0]];
const AIMS = [3.4, -3.4, 2.8, -2.8, 2.2, -2.2];
const SEEDS = [201, 202, 203, 204, 205, 206, 207, 208];

function spotRate(k: K, x: number, z: number): number {
  let g = 0, n = 0;
  for (const [rx, rz] of RUNS) for (const aim of AIMS) for (const seed of SEEDS) { n++; if (runShot(k, x, z, rx, rz, aim, seed)) g++; }
  return g / n;
}

describe('FEEL-2C: a finesse closed down by a rushing Professional keeper', { timeout: 600_000 }, () => {
  it('glitch finesse hot zone — after a 5-7 m run, central 17-19 m, the finesse is no near-certain goal and stays near a normal shot', () => {
    const f = SPOTS.map(([x, z]) => spotRate('finesse', x, z));
    const n = SPOTS.map(([x, z]) => spotRate('normal', x, z));
    const fin = f.reduce((a, b) => a + b, 0) / f.length, nor = n.reduce((a, b) => a + b, 0) / n.length;
    console.log(`FEEL-2C hot zone (n=576 each): finesse ${(100 * fin).toFixed(1)}% [${f.map((v) => (100 * v).toFixed(0)).join('/')}], normal ${(100 * nor).toFixed(1)}% [${n.map((v) => (100 * v).toFixed(0)).join('/')}]`);
    // Measured finesse 70.1% (73 / 65 / 72 by spot) v normal 68.1% (54 / 70 / 80); D-037: 91.1 v 68.1% (93 / 92 / 89).
    expect(fin).toBeLessThan(0.75);
    expect(fin).toBeLessThanOrEqual(nor + 0.15);
    for (const v of f) expect(v).toBeLessThan(0.8);
  });

  it('with no room the placed finesse is aimed where a normal shot with the same stick goes, beyond the post too; with full room in the corner', () => {
    const corner = GOAL_HALF_WIDTH - T_FEEL2.finesseInset;
    const aim = { x: 0, y: 0, z: 0 };
    const zAt = (kind: KickKind, keeperX: number, aimZ: number): number => {
      const s = scene(1);
      const p = s.players[SLOT]!;
      p.x = 36; p.z = 0; p.fx = 1; p.fz = 0;
      Object.assign(s.ball, { x: 36.5, y: 0.11, z: 0, owner: SLOT, lastTouch: SLOT, lastTouchTeam: 0, heldBy: -1 });
      const k = s.players[KEEPER]!;
      k.x = keeperX; k.z = 0;
      p.act = ActionKind.SHOT;
      p.actKick = kind;
      shotAimPoint(s, SLOT, GX - 36.5, aimZ, 0.7, AssistLevel.ASSISTED, aim);
      return aim.z;
    };
    const closed = 36.5 + T_FEEL2.placedKeeperNear - 0.5; // keeper inside placedKeeperNear of the ball: no room
    const open = 36.5 + T_FEEL2.placedKeeperFar + 1; // full room (set on his line)
    for (const aimZ of [2.2, 2.8, 3.4, 4.2, -2.2, -3.4, -4.2]) {
      const zF = zAt(KickKind.SHOT_FINESSE, closed, aimZ), zN = zAt(KickKind.SHOT_NORMAL, closed, aimZ);
      // D-037 placed it from the stick's ray clamped to the corner: 2.2 (normal 3.11, out of the keeper's cover), and
      // the exact corner 3.16 from a stick at 3.4 / 4.2 whatever the keeper did.
      expect(zF, `stick ${aimZ}, no room`).toBeCloseTo(zN, 9);
      expect(Math.abs(zAt(KickKind.SHOT_FINESSE, open, aimZ)), `stick ${aimZ}, full room`).toBeCloseTo(corner, 9);
    }
  });
});
