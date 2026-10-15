/**
 * [QF-9] SIM-07 first touch and SIM-14 interceptions, Wave 4 round 2: a clean first touch keeps the ball in the
 * receiver's reach at every pace (the settle was planned to reach a spot exactly at the window's end and fired a
 * sprinter's ball 2.6 m clear at 14 m/s), the ballControl curve leaves poor players some clean touches of a hard ball,
 * and fresh shots are blocked by the bodies in their path (they passed through every defender who was not controlled,
 * the chaser or the pass target, while the controlled one "received" any shot within 1.1 m).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_DRIBBLE } from '../../src/contracts/tuning';
import { rngSeed } from '../../src/sim/core/rng';
import { LOCAL_TUNING as TL } from '../../src/sim/defend/tackle';
import { TouchOutcome } from '../../src/sim/players/firstTouch';
import { makeScenario, runTicks } from '../harness/scenario';
import { incoming, OPP, resetPlayer, RECV, RX, RZ, trials } from '../unit/sim-07-helpers';

/** P1 controls slot 9 at (0, 0) moving (vx, vz); everyone else parked; ball arriving from (bx, bz) at (bvx, bvz). */
function receiveScene(vx: number, vz: number, bx: number, bz: number, bvx: number, bvz: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 11, humans: [{ side: 0, slot: 9, autoSwitch: AutoSwitch.OFF }] });
  for (let i = 0; i < 22; i++) {
    if (i === 9) continue;
    const p = s.players[i]!;
    p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  s.tick = 300;
  const p = s.players[9]!;
  p.x = 0; p.z = 0; p.vx = vx; p.vz = vz;
  const sp = Math.hypot(vx, vz);
  if (sp > 0.1) { p.fx = vx / sp; p.fz = vz / sp; } else { p.fx = 1; p.fz = 0; }
  s.attrs[9]!.ballControl = 99;
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = bx; b.y = 0.11; b.z = bz; b.px = bx; b.py = 0.11; b.pz = bz;
  b.vx = bvx; b.vz = bvz; b.vy = 0; b.grounded = 1; b.sx = 0; b.sy = 0; b.sz = 0;
  b.lastKickBy = 6; b.lastKickTeam = 0; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = s.tick - 30;
  b.lastTouch = 6; b.lastTouchTeam = 0; b.lastTouchTick = s.tick - 30; b.touchedTick = s.tick - 30; b.passTarget = 9; b.shotBy = -1;
  return s;
}

describe('QF-9 SIM-07: a clean first touch keeps the ball in his reach at every pace', () => {
  it('table: standing, jogging and sprinting receivers; balls from ahead, the side and behind; the stick held on along his run', () => {
    // [receiver vx, ball start x, z, ball vx, vz, sprint held]
    const rows: [number, number, number, number, number, number][] = [
      [0, 3, 0, -9, 0, 0], [0, 0.4, 3, 0, -10, 0], [0, -3, 0.3, 9, 0, 0],
      [5.2, 4, 0, -8, 0, 0], [5.2, 1, 3, 0, -9, 0], [5.2, -2.5, 0.3, 11, 0, 0],
      [8.8, 3, 0.4, 5.6, 0, 1], [8.8, 2, 3, 2, -9, 1], [8.8, -2.5, 0.3, 14, 0, 1], [9.1, 1.3, 0.2, 5.7, -0.5, 1],
    ];
    for (const [vx, bx, bz, bvx, bvz, sprint] of rows) {
      const name = `v ${vx} ball (${bx}, ${bz}) -> (${bvx}, ${bvz}) sprint ${sprint}`;
      const s = receiveScene(vx, 0, bx, bz, bvx, bvz);
      let touch = -1;
      let worst = 0;
      let lost = false;
      runTicks(s, 90, (_t, _st, out) => {
        out[0]!.mx = 127; out[0]!.mz = 0; out[0]!.buttons = sprint ? Btn.SPRINT : 0;
      }, {
        until: (st) => {
          const p = st.players[9]!;
          if (touch < 0 && p.act === ActionKind.FIRST_TOUCH && p.actA === TouchOutcome.CLEAN) touch = st.tick;
          if (touch < 0) return false;
          const d = Math.hypot(st.ball.x - p.x, st.ball.z - p.z);
          if (d > worst) worst = d;
          if (st.ball.owner !== 9) lost = true;
          return st.tick - touch >= 20;
        },
      });
      expect(touch, name).toBeGreaterThan(0);
      expect(lost, name).toBe(false);
      // Within the sprint dribble's own lead (the ball may run touchAheadSprint ahead of a sprinter), never loose.
      expect(worst, name).toBeLessThan(T_DRIBBLE.touchAheadSprint + 0.1);
      if (sprint === 0) expect(worst, name).toBeLessThan(2);
    }
  });
});

describe('QF-9 SIM-07: first touch depends on ball control, and poor players miscontrol often, not always (section 6, DAT-05)', () => {
  const N = 300;
  const clean = (control: number, speed: number, cond: 'face' | 'behind' | 'press'): number => {
    const c = trials(N, (s) => {
      s.attrs[RECV]!.ballControl = control;
      incoming(s, RECV, { speed, face: cond !== 'behind' });
      if (cond === 'behind') { s.players[RECV]!.fx = -1; s.players[RECV]!.fz = 0; }
      if (cond === 'press') resetPlayer(s, OPP, RX - 0.5, RZ + 1.2); else resetPlayer(s, OPP, -40, 25);
    });
    return c.clean / N;
  };

  it('a 40-control player takes some clean touches of a 20 m/s ball (was none), fewer than a 65 and a 90', () => {
    for (const cond of ['face', 'behind', 'press'] as const) {
      const lo = clean(40, 20, cond), mid = clean(65, 20, cond), hi = clean(90, 20, cond);
      expect(lo, `40 ${cond}`).toBeGreaterThan(0.02);
      expect(lo, `40 ${cond}`).toBeLessThan(0.6);
      expect(mid, `65 ${cond}`).toBeGreaterThan(lo);
      expect(hi, `90 ${cond}`).toBeGreaterThan(mid);
    }
    expect(clean(40, 20, 'face')).toBeGreaterThan(0.25);
    // Soft passes stay clean for everyone (SIM-07: a 7 m/s pass is always controlled).
    expect(clean(40, 7, 'face')).toBe(1);
  });
});

/** A 25 m/s shot along z = 0 from (30.6, 0.3) toward the goal at +x, by slot 9 of team 0. */
function shotScene(y: number, vy: number, speed = 25): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, humans: 0 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -40 + i : -5 + (i - 11); p.z = -30 + i * 2.5; p.vx = 0; p.vz = 0;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  for (const c of s.ctrl) { c.kind = ControllerKind.NONE; c.slot = -1; }
  for (const p of s.players) p.ctrl = -1;
  s.tick = 500;
  const k = s.players[11]!; k.x = 52; k.z = 0;
  s.players[9]!.x = 30; s.players[9]!.z = 0;
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = 30.6; b.z = 0; b.y = y; b.px = b.x; b.pz = 0; b.py = y;
  b.vx = speed; b.vz = 0; b.vy = vy; b.grounded = 0;
  b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 9; b.lastKickTeam = 0;
  b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick; b.shotBy = 9; b.passTarget = -1;
  return s;
}

/** Run the shot until it is past x = 42; defender `d` held at (37, dz) facing it. Returns who touched it first. */
function fire(s: SimState, d: number, dz: number, ctrl = false): { touched: number; firstTouch: boolean; intercept: boolean } {
  if (ctrl) { const c = s.ctrl[3]!; c.kind = ControllerKind.CPU; c.side = 1; c.slot = d; s.players[d]!.ctrl = 3; }
  let touched = -1, firstTouch = false, intercept = false;
  runTicks(s, 20, (_t, st) => {
    const q = st.players[d]!;
    q.x = 37; q.z = dz; q.vx = 0; q.vz = 0; q.fx = -1; q.fz = 0;
  }, {
    until: (st, evs) => {
      for (const e of evs) {
        if (e.type === EventType.KICK && e.b === KickKind.FIRST_TOUCH && e.a === d) firstTouch = true;
        if (e.type === EventType.INTERCEPT && e.a === d) intercept = true;
      }
      if (st.ball.lastTouch !== 9 && touched < 0) touched = st.ball.lastTouch;
      return st.ball.x > 42;
    },
  });
  return { touched, firstTouch, intercept };
}

describe('QF-9 SIM-14: bodies block fresh shots', () => {
  it('a low and a chest-high shot into a defender who is neither controlled nor the chaser are blocked by his body', () => {
    for (const [y, vy] of [[0.3, 1.2], [1.3, 0.6]] as const) {
      const r = fire(shotScene(y, vy), 15, 0.1);
      expect(r.touched, `y ${y}`).toBe(15); // (a chest-high one may be met by SIM-12's aerial contact first)
      if (y < 1) expect(r.intercept, `y ${y}`).toBe(true);
    }
  });

  it('a shot over his head (above shotBlockHeight) is not blocked', () => {
    const r = fire(shotScene(2.6, 0.5), 15, 0.1);
    expect(r.touched).not.toBe(15);
    expect(TL.shotBlockHeight).toBeLessThan(2.6);
  });

  it('the controlled defender beside a 25 m/s shot never takes it with a SIM-07 first touch (block or miss, by SIM-14)', () => {
    let blocks = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const s = shotScene(0.3, 1.2);
      rngSeed(s.rng, seed * 7919); // vary the interception roll
      const r = fire(s, 15, 0.9, true);
      expect(r.firstTouch, `seed ${seed}`).toBe(false);
      if (r.touched === 15) { expect(r.intercept).toBe(true); blocks++; }
    }
    expect(blocks).toBeGreaterThan(0);
    expect(blocks).toBeLessThan(24); // a stretched leg against a 25 m/s shot is far from certain
  });
});
