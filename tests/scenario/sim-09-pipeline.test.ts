/**
 * [SIM-09] Lobs and crosses in the full pipeline: SIM-15 button routing -> startLob (crossing-zone conversions) ->
 * SIM-08 KICK handler -> solveLob / solveCross -> SIM-01/02 ball; a lob over a defender completed to the receiver; a
 * cross landing on its zone; determinism.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { hashState } from '../../src/sim/core/hash';
import { crossTarget } from '../../src/sim/kicks/lob';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import { giveBall, KICKER, MATE_A, OPP_A, place, skill } from '../unit/sim-09-helpers';

/** IN_PLAY, offside off, no CPU brains; P1 on the kicker at (kx, kz) with the ball; everybody else far away. */
function live(kx: number, kz: number, fx: number, fz: number, seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, config: { offside: 0 }, humans: [{ side: 0, slot: KICKER }] });
  for (let t = 0; t < 2; t++) { const c = s.ctrl[2 + t]!; c.kind = ControllerKind.NONE; c.slot = -1; s.teams[t]!.cpu.active = 0; }
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === KICKER) continue;
    place(s, i, (i < 11 ? -30 : -40) + (i % 3), -25 + (i % 11) * 5);
  }
  place(s, 11, 52, 0);
  place(s, 0, -52, 0);
  s.teams[0]!.dir = 1; s.teams[1]!.dir = -1;
  const l = Math.hypot(fx, fz);
  place(s, KICKER, kx, kz, fx / l, fz / l);
  s.players[KICKER]!.ctrl = 0;
  skill(s, KICKER, 80);
  giveBall(s, KICKER);
  return s;
}

/**
 * Press `buttons` (stick (mx, mz)) once the kicker is free with the ball: `holds` lists [press ticks, gap ticks] pairs
 * (a double tap is two pairs). Stops pressing once he has struck the ball.
 */
function presses(buttons: number, mx: number, mz: number, holds: [number, number][]) {
  let n = 0;
  let started = false;
  const plan: number[] = [];
  for (const [on, off] of holds) { for (let i = 0; i < on; i++) plan.push(1); for (let i = 0; i < off; i++) plan.push(0); }
  return (_t: number, st: SimState, out: InputFrame[]): void => {
    if (st.ball.lastKickBy === KICKER && st.ball.owner !== KICKER) return;
    const f = out[0]!;
    f.mx = mx; f.mz = mz;
    if (!started && !(st.players[KICKER]!.act === ActionKind.NONE && st.ball.owner === KICKER)) return;
    started = true;
    if (n < plan.length && plan[n++] === 1) f.buttons = buttons;
  };
}

function kicksBy(ev: SimEvent[], slot: number): number[] {
  return findEvents(ev, EventType.KICK, (e) => e.a === slot).map((e) => e.b);
}

describe('SIM-09 in the pipeline', () => {
  it('the LOB button family through SIM-15: zone conversions and the outside-the-zone kinds', () => {
    const cases: [string, number, number, number, number, number, [number, number][], KickKind][] = [
      ['LOB in the crossing zone -> CROSS', 38, 26, Btn.LOB, 40, -120, [[3, 0]], KickKind.CROSS],
      ['L1 + R1 + LOB in the zone -> LOW_CROSS', 38, 26, Btn.LOB | Btn.MOD_L | Btn.MOD_R, 40, -120, [[3, 0]], KickKind.LOW_CROSS],
      ['LOB, LOB in the zone -> GROUND_CROSS', 38, 26, Btn.LOB, 40, -120, [[2, 4], [2, 0]], KickKind.GROUND_CROSS],
      ['LOB outside the zone -> LOB_PASS', 0, 0, Btn.LOB, 120, 30, [[3, 0]], KickKind.LOB_PASS],
      ['L1 + LOB -> HIGH_LOB', 0, 0, Btn.LOB | Btn.MOD_L, 120, 30, [[3, 0]], KickKind.HIGH_LOB],
      ['L1 + R1 + LOB outside the zone -> DRIVEN_LOB', 0, 0, Btn.LOB | Btn.MOD_L | Btn.MOD_R, 120, 30, [[3, 0]], KickKind.DRIVEN_LOB],
    ];
    for (const [name, kx, kz, buttons, mx, mz, holds, want] of cases) {
      const s = live(kx, kz, mx, mz);
      place(s, MATE_A, kx + 22, kz > 10 ? 2 : 6);
      const ev = runTicks(s, 90, presses(buttons, mx, mz, holds), { check: 'core', until: (st) => st.ball.lastKickBy === KICKER });
      expect(kicksBy(ev, KICKER), name).toEqual([want]);
    }
  });

  it('a lob over a defender in the lane is completed to the receiver', () => {
    const s = live(0, 0, 1, 0);
    place(s, MATE_A, 26, 4);
    place(s, OPP_A, 12, 2);
    let overDefender = -1;
    const ev = runTicks(s, 300, presses(Btn.LOB, 125, 20, [[12, 0]]), {
      check: 'core',
      until: (st, tev) => {
        const b = st.ball;
        if (b.lastKickBy === KICKER && Math.abs(b.x - 12) < 0.5 && overDefender < 0) overDefender = b.y;
        return tev.some((e) => e.type === EventType.PASS_COMPLETE || e.type === EventType.INTERCEPT);
      },
    });
    expect(kicksBy(ev, KICKER)).toEqual([KickKind.LOB_PASS]);
    expect(overDefender).toBeGreaterThan(3);
    expect(findEvents(ev, EventType.INTERCEPT)).toEqual([]);
    const done = findEvents(ev, EventType.PASS_COMPLETE);
    expect(done.map((e) => [e.a, e.b])).toEqual([[MATE_A, KICKER]]);
    expect(kicksBy(ev, OPP_A)).toEqual([]);
  });

  it('a cross from the wing lands on its zone (penalty spot at mid power)', () => {
    const s = live(37, 27, 0.45, -0.9);
    let target = { x: 0, z: 0 };
    let landed: SimEvent | undefined;
    const ev = runTicks(s, 300, presses(Btn.LOB, 0, 0, [[25, 0]]), {
      until: (st, tev) => {
        if (st.ball.lastKickBy !== KICKER) return false;
        if (target.x === 0) { const p = { x: 0, z: 0 }; crossTarget(st, KICKER, st.players[KICKER]!.actPower, 0, 0, p); target = p; }
        landed = tev.find((e) => e.type === EventType.BOUNCE);
        return landed !== undefined || st.ball.owner >= 0;
      },
    });
    expect(kicksBy(ev, KICKER)).toEqual([KickKind.CROSS]);
    expect(s.ball.passX).toBeCloseTo(target.x, 6);
    expect(s.ball.passZ).toBeCloseTo(target.z, 6);
    expect(target.x).toBeCloseTo(41.5, 6);
    expect(landed).toBeDefined();
    expect(Math.hypot(landed!.x - target.x, landed!.z - target.z)).toBeLessThan(2.5);
  });

  it('is deterministic (same seed and inputs -> same state hash)', () => {
    const go = (): number => {
      const s = live(38, 26, 40, -120, 9);
      place(s, MATE_A, 44, 2);
      runTicks(s, 200, presses(Btn.LOB, 40, -120, [[10, 0]]), { check: 'core' });
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});
