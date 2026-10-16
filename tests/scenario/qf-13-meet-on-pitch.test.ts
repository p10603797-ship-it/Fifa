/**
 * [QF-13] SIM-15 meetPoint: the receiver of an overhit lofted pass ran to its landing point beyond the touchline and
 * stood there, 3.9-4.75 m off the pitch (Beginner bot match, soak seed 21 #0, t 12816: 85 ticks). The meeting point
 * (and the overshoot target for a ball rolling away) now stays within the pitch + T_TOUCH.meetPitchMargin: where the
 * ball's track leaves it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_TOUCH } from '../../src/contracts/tuning';
import { MEET, meetPoint } from '../../src/sim/control/resolveShared';
import { deserializeState } from '../../src/sim/core/serialize';
import { makeScenario, runTicks } from '../harness/scenario';

const M = T_TOUCH.meetPitchMargin;

function quiet(seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: 0 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0;
    p.ctrl = -1;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  for (const c of s.ctrl) { c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
  s.tick = 200;
  return s;
}

function off(x: number, z: number): number {
  return Math.max(Math.abs(x) - HALF_LENGTH, Math.abs(z) - HALF_WIDTH, 0);
}

describe('QF-13 SIM-15: the receiver of a ball going out stays on the pitch', () => {
  it('meetPoint of lobs and rolling balls heading over a touchline or goal line stays within the margin (table)', () => {
    let n = 0;
    for (const [bx, bz, vx, vz, vy, y] of [
      [10, 20, 4, 14, 8, 1], [10, -20, 3, -15, 9, 1], [30, 25, 10, 9, 6, 0.5], [40, 0, 14, 2, 7, 1],
      [-40, 5, -15, 3, 8, 1], [20, 30, 2, 6, 0, 0.11], [45, -10, 9, -2, 0, 0.11], [0, 0, 6, 22, 10, 1],
    ] as const) {
      for (const [px, pz] of [[bx + 5, bz], [bx, bz + (bz >= 0 ? 6 : -6)], [bx + 15, bz + 2], [0, 0]] as const) {
        const s = quiet();
        const p = s.players[9]!;
        p.x = px; p.z = Math.max(-HALF_WIDTH, Math.min(HALF_WIDTH, pz));
        const b = s.ball;
        b.owner = -1; b.heldBy = -1; b.x = bx; b.y = y; b.z = bz; b.vx = vx; b.vy = vy; b.vz = vz;
        b.grounded = y < 0.2 ? 1 : 0;
        for (const sprint of [0, 1]) {
          meetPoint(s, 9, sprint);
          n++;
          expect(off(MEET.x, MEET.z), `ball (${bx}, ${bz}) v (${vx}, ${vz}) player (${px}, ${pz})`).toBeLessThanOrEqual(M + 1e-9);
          expect(Number.isFinite(MEET.x + MEET.z)).toBe(true);
        }
      }
    }
    expect(n).toBe(64);
  });

  it('the meeting point of a ball staying in play is unchanged by the clamp (a lob landing inside)', () => {
    const s = quiet();
    const p = s.players[9]!;
    p.x = 8; p.z = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = 0; b.y = 1; b.z = 0; b.vx = 12; b.vy = 8; b.vz = 0; b.grounded = 0;
    meetPoint(s, 9, 0);
    expect(MEET.x).toBeGreaterThan(15);
    expect(MEET.x).toBeLessThan(HALF_LENGTH);
    expect(MEET.z).toBe(0);
  });

  it('glitch: receiver stands off the pitch after an overhit lob — the soak case (Beginner, seed 21 #0, t 12707: a 25 m/s lob across the pitch to the CPU-controlled slot 18)', () => {
    const s = deserializeState(readFileSync(new URL('./fixtures/qf-13-meet-off-pitch.state.json', import.meta.url), 'utf8'));
    expect(s.ball.passTarget).toBe(18);
    let worst = 0, ticks = 0;
    runTicks(s, 260, undefined, {
      until: (st) => {
        if (st.match.phase !== MatchPhase.IN_PLAY) return true;
        ticks++;
        const q = st.players[18]!;
        const o = off(q.x, q.z);
        if (o > worst) worst = o;
        return false;
      },
    });
    expect(ticks).toBeGreaterThan(150); // the ball was in the air (in play) long enough for him to get there
    expect(worst).toBeLessThanOrEqual(M + 0.35); // was 4.75 m
  });

  it('a constructed overhit lob — the idle-stick receiver goes no further than the margin (pipeline, human and CPU-controlled)', () => {
    for (const cpu of [false, true]) {
      for (let seed = 1; seed <= 4; seed++) {
        const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: cpu ? 0 : [{ side: 0, slot: 9, autoSwitch: AutoSwitch.OFF }] });
        for (let i = 0; i < 22; i++) {
          if (i === 9) continue;
          const q = s.players[i]!;
          q.x = i < 11 ? -45 : 45; q.z = -28 + (i % 11) * 5.5; q.vx = 0; q.vz = 0;
        }
        s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
        if (cpu) {
          // The CPU controller holds the receiver of its own pass (its brain off: an idle frame, like TAI-11 branch 1).
          for (const c of s.ctrl) { if (c.slot >= 0) s.players[c.slot]!.ctrl = -1; c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
          const ctl = s.ctrl[2]!;
          ctl.kind = ControllerKind.CPU; ctl.side = 0; ctl.slot = 9; ctl.switchLockT = 999; ctl.autoSwitch = AutoSwitch.OFF;
          s.players[9]!.ctrl = 2;
        }
        const p = s.players[9]!;
        p.x = 18; p.z = 24; p.vx = 0; p.vz = 0;
        const b = s.ball;
        // An overhit lob from slot 6 at (5, 10) toward the touchline: it lands about 4-6 m beyond z = 34.
        b.owner = -1; b.heldBy = -1; b.x = 5; b.y = 0.5; b.z = 10; b.px = b.x; b.py = b.y; b.pz = b.z;
        b.vx = 6 + seed * 0.3; b.vy = 10; b.vz = 14; b.grounded = 0; b.sx = 0; b.sy = 0; b.sz = 0;
        b.lastKickBy = 6; b.lastKickTeam = 0; b.lastKickKind = KickKind.LOB_PASS; b.lastKickTick = s.tick;
        b.lastTouch = 6; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.passTarget = 9; b.shotBy = -1;
        let worst = 0;
        runTicks(s, 240, undefined, {
          until: (st) => {
            if (st.match.phase === MatchPhase.IN_PLAY) {
              const q = st.players[9]!;
              const o = off(q.x, q.z);
              if (o > worst) worst = o;
            }
            return st.match.phase !== MatchPhase.IN_PLAY;
          },
        });
        expect(worst, `${cpu ? 'cpu' : 'human'} seed ${seed}`).toBeLessThanOrEqual(M + 0.35);
      }
    }
  });
});
