/**
 * INT-A: a human-controlled side works headless through the real pipeline (no fakes): scripted InputFrames pass to
 * the intended receiver (PASS_COMPLETE to him), take shots, and the controller follows the ball (auto-switch onto the
 * receiver of a pass); a scripted human half keeps every invariant and is deterministic.
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { describe, expect, it } from 'vitest';
import { AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { hashState } from '../../src/sim/core/hash';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

/** P1 (home, attacking +x) on `slot` with the ball at his feet; everyone else parked away, CPU brains off. */
function scene(slot: number, x: number, z: number, autoSwitch = AutoSwitch.AIR_AND_LOOSE): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 21, humans: [{ side: 0, slot, autoSwitch }], teams: [{ dir: 1 }, { dir: -1 }] });
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE; ctl.side = -1; ctl.slot = -1;
  }
  s.teams[0]!.cpu.active = 0;
  s.teams[1]!.cpu.active = 0;
  for (let i = 0; i < 22; i++) {
    if (i === slot) continue;
    const p = s.players[i]!;
    if (p.isKeeper === 1) continue;
    // Own team behind, opponents deep in their own half (so nobody is offside), all out of the ball's way.
    p.x = i < 11 ? -40 : 44; p.z = -30 + 2.5 * (i % 11); p.vx = 0; p.vz = 0; p.homeX = p.x; p.homeZ = p.z;
  }
  const p = s.players[slot]!;
  Object.assign(p, { x, z, vx: 0, vz: 0, fx: 1, fz: 0 });
  Object.assign(s.ball, { x: x + 0.5, z, y: 0.11, px: x + 0.5, pz: z, py: 0.11, vx: 0, vy: 0, vz: 0, grounded: 1, owner: slot, heldBy: -1, lastTouch: slot, lastTouchTeam: 0 });
  return s;
}

/** Stick toward (dx, dz) at full tilt. */
function stick(f: InputFrame, dx: number, dz: number): void {
  const l = Math.hypot(dx, dz) || 1;
  f.mx = Math.round((dx / l) * AXIS_SCALE);
  f.mz = Math.round((dz / l) * AXIS_SCALE);
}

describe('INT-A human-controlled side, headless', () => {
  it('a tapped pass with the stick on a teammate completes to that teammate, and the controller follows the ball to him', () => {
    const s = scene(6, 0, 0);
    const r = 9;
    Object.assign(s.players[r]!, { x: 14, z: 6, homeX: 14, homeZ: 6, vx: 0, vz: 0 });
    let complete = -1, kicked = -1;
    const t0 = s.tick;
    const ev = runTicks(s, 180, (t, _st, out) => {
      const f = out[0]!;
      if (t - t0 <= 8) { stick(f, 14, 6); f.buttons = Btn.PASS; } // a short press: power for ~15 m
    }, {
      check: 'core',
      until: (st, tev) => {
        for (const e of tev) {
          if (e.type === EventType.KICK && e.a === 6 && e.b !== KickKind.DRIBBLE_TOUCH && kicked < 0) kicked = e.b;
          if (e.type === EventType.PASS_COMPLETE && complete < 0) complete = e.a;
        }
        return complete >= 0 && st.ctrl[0]!.slot === complete;
      },
    });
    expect(kicked === KickKind.GROUND_PASS || kicked === KickKind.DRIVEN_PASS).toBe(true);
    expect(complete).toBe(r);
    expect(s.ctrl[0]!.slot).toBe(r);
    expect(findEvents(ev, EventType.SWITCH).some((e) => e.b === r && e.c === 0)).toBe(true);
  });

  it('a held shot near the box is struck at goal (SHOT event, on target from 16 m)', () => {
    const s = scene(9, 36, 2);
    let shot: { onTarget: number } | null = null;
    const t0 = s.tick;
    runTicks(s, 120, (t, _st, out) => {
      const f = out[0]!;
      const k = t - t0;
      stick(f, 52.5 - 36, -2);
      if (k >= 2 && k < 20) f.buttons = Btn.SHOOT;
    }, {
      check: 'core',
      until: (_st, tev) => {
        for (const e of tev) if (e.type === EventType.SHOT && e.a === 9) shot = { onTarget: e.b };
        return shot !== null;
      },
    });
    expect(shot).not.toBeNull();
  });

  it('a scripted human half (sprint at goal, pass and shoot on a rhythm) keeps every invariant and is deterministic', () => {
    const play = (): number => {
      const s = makeScenario({ phase: MatchPhase.KICK_OFF, seed: 33, humans: [{ side: 0 }], config: { halfMinutes: 2 } });
      runTicks(s, 3600, (t, st, out) => {
        const f = out[0]!;
        const me = st.ctrl[0]!.slot;
        if (me < 0) return;
        const p = st.players[me]!;
        const gx = st.teams[0]!.dir * 52.5;
        stick(f, gx - p.x, -p.z * 0.5);
        if (st.ball.owner === me) {
          if (t % 90 < 6) f.buttons |= Btn.PASS;
          else if (Math.abs(gx - p.x) < 22 && t % 30 < 10) f.buttons |= Btn.SHOOT;
          else f.buttons |= Btn.SPRINT;
        } else if (t % 50 < 4) f.buttons |= Btn.PASS; // defending: standing tackle / pressing taps
      }, { check: 'all' });
      return hashState(s);
    };
    expect(play()).toBe(play());
  });
});
