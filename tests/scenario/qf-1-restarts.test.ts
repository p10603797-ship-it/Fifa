/**
 * [QF-1] QA-06 restarts through the real pipeline: regressions for defects found in this wave.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, HALF_WIDTH } from '../../src/contracts/constants';
import { Command, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { AXIS_SCALE, Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { LOCAL_TUNING as THROW } from '../../src/sim/rules/throwin';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

function put(s: SimState, slot: number, x: number, z: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
}

describe('QF-1 QA-06 throw-ins', { timeout: 600_000 }, () => {
  it('a short throw (PASS) never goes to a receiver beyond shortMaxDist, even when SIM-08 prefers a farther open one', () => {
    // Throw-in for team 0 at (10, 34). Slot 2 is 11 m away along the stick; slot 4 is 25 m away in nearly the same
    // direction and wide open (SIM-08 selectReceiver's choice), which only a long throw may reach.
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed: 3 });
    const home: [number, number][] = [[-50, 0], [8, 30.5], [18, 26], [2, 24], [31, 20], [-20, 0], [-10, -10], [0, -20], [20, -5], [25, -15], [-30, 10]];
    const away: [number, number][] = [[50, 0], [11, 32.8], [30, 5], [35, -10], [10, -15], [0, 5], [-5, -25], [40, 15], [25, -25], [-15, 20], [5, 10]];
    for (let i = 0; i < 11; i++) { put(s, i, home[i]![0], home[i]![1]); put(s, 11 + i, away[i]![0], away[i]![1]); }
    s.ball.x = 0; s.ball.y = BALL_RADIUS; s.ball.z = 0; s.ball.px = 0; s.ball.pz = 0; s.ball.vx = 0; s.ball.vz = 0;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    awardRestart(s, RestartKind.THROW_IN, 0, 10, HALF_WIDTH, ev);
    runTicks(s, 200, undefined, { until: (st) => st.match.restart.ready === 1 });
    expect(s.match.restart.ready).toBe(1);
    // The team AI moved everyone during the set-up: put the layout back (the taker stays where RUL-11 put him).
    const taker = s.match.restart.taker;
    for (let i = 0; i < 11; i++) {
      if (i !== taker) put(s, i, home[i]![0], home[i]![1]);
      if (11 + i !== 12) put(s, 11 + i, away[i]![0], away[i]![1]);
    }
    const q = s.players[2]!;
    const dx = q.x - s.ball.x, dz = q.z - s.ball.z;
    const d = Math.hypot(dx, dz);
    let pressed = false;
    runTicks(s, 120, (_t, _st, out) => {
      out[0]!.mx = Math.round((dx / d) * AXIS_SCALE);
      out[0]!.mz = Math.round((dz / d) * AXIS_SCALE);
      if (!pressed) { out[0]!.buttons = Btn.PASS; pressed = true; }
    }, { until: (st) => st.match.restart.taken === 1 });
    expect(s.match.restart.taken).toBe(1);
    const t = s.ball.passTarget;
    expect(t).toBe(2);
    const r = s.players[t]!;
    expect(Math.hypot(r.x - s.ball.x, r.z - s.ball.z)).toBeLessThanOrEqual(THROW.shortMaxDist + 1);
  });
});

describe('QF-1 QA-06 free-kick walls', { timeout: 600_000 }, () => {
  it('goal-line walls (free kicks 5.5 m out, both sides): every invariant holds until the kick is taken and played', () => {
    for (const [seed, z] of [[515, 8.73], [516, -8.5], [517, 6], [518, -4]] as [number, number][]) {
      // Free kick 5.5 m out, wide of the post: the wall goes on the goal line between the posts (RUL-05) where GKP-06
      // also puts the keeper.
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, match: { periodT: 600 } });
      const ev = createEventBuffer();
      ev.begin(s.tick);
      awardRestart(s, RestartKind.FREE_KICK, 0, 47, z, ev);
      expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
      runTicks(s, 400, undefined, { check: 'all', until: (st) => st.match.phase === MatchPhase.IN_PLAY && st.match.phaseT > 60 });
    }
  });
});

describe('QF-1 QA-06 kick-off handed to the CPU', { timeout: 600_000 }, () => {
  it('glitch taker missing — a side handed to the CPU while its human waits at the kick-off takes it normally (no forced kick, no watchdog)', () => {
    for (const handAt of [120, 300, 600]) {
      // Fuzz #49 (seed 202): HAND_TO_CPU 6.5 s into a kick-off made the Default and the forced kick fall in one tick.
      const s = makeScenario({ phase: MatchPhase.PRE_MATCH, humans: [{ side: 0 }], seed: 49 });
      s.match.firstKickoffTeam = 0;
      s.match.kickoffTeam = 0;
      const ev = runTicks(s, 2400, (tick, st, out) => {
        if (st.match.phase === MatchPhase.KICK_OFF && st.match.phaseT === handAt) {
          out[0]!.cmd = Command.HAND_TO_CPU;
          out[0]!.cmdArg = 0;
        }
      }, { check: 'all', until: (st) => st.match.phase === MatchPhase.IN_PLAY && st.match.prevPhase === MatchPhase.KICK_OFF });
      expect(findEvents(ev, EventType.WATCHDOG), `hand-off at ${handAt}`).toEqual([]);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      const kick = findEvents(ev, EventType.KICK, (e) => e.b === KickKind.KICK_OFF);
      expect(kick).toHaveLength(1);
    }
  });
});
