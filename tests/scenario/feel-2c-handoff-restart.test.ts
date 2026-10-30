/**
 * [FEEL-2C] A side handed to its CPU (Command.HAND_TO_CPU, a pad disconnect) in the middle of its own restart.
 * Fuzz seed 3 #33 (cc2c605): the human dawdled at a free kick, chose a new taker 10 m away ("choose the taker", SPRINT)
 * with half a second of the 12 s timeout left, then handed the side to the CPU. The timeout was held for the running
 * taker and fell due the tick he reached the spot, before the CPU could act: the "CPU never acted" watchdog fired
 * (WATCHDOG RESTART_BLOCKED) and the kind's Default took the kick.
 */
import { describe, expect, it } from 'vitest';
import { Command, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { T_RESTART, T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { ShootoutSub } from '../../src/sim/rules/shootout';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import { shootoutScenario, untilSub } from './rul-07-helpers';

describe('FEEL-2C restart handed to the CPU', { timeout: 600_000 }, () => {
  it('glitch CPU never acted — a free kick handed to the CPU while a newly chosen taker runs in is taken by the CPU without a watchdog', () => {
    let swapped = 0;
    for (const [seed, x, z, swapAt] of [
      [33, 10, 12, 40], [34, 5, -20, 25], [35, 20, 25, 60], [36, -10, 5, 30], [37, 15, -8, 3],
    ] as [number, number, number, number][]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed, match: { periodT: 600 } });
      const ev = createEventBuffer();
      ev.begin(s.tick);
      awardRestart(s, RestartKind.FREE_KICK, 0, x, z, ev);
      expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
      runTicks(s, 1500, undefined, { until: (st) => st.match.restart.ready === 1 && st.match.restart.timeoutT <= swapAt });
      expect(s.match.restart.ready, `seed ${seed}`).toBe(1);
      const before = s.match.restart.taker;
      // Choose the taker (SPRINT edge), then hand the side to the CPU on the next tick while the new taker runs in.
      runTicks(s, 1, (_t, _st, out) => { out[0]!.buttons = Btn.SPRINT; });
      const after = s.match.restart.taker;
      if (after !== before) {
        swapped++;
        const p = s.players[after]!;
        expect(Math.hypot(p.x - s.match.restart.x, p.z - s.match.restart.z), `seed ${seed} new taker runs in`).toBeGreaterThan(2);
      }
      runTicks(s, 1, (_t, _st, out) => { out[0]!.cmd = Command.HAND_TO_CPU; out[0]!.cmdArg = 0; });
      expect(s.ctrl[0]!.kind).not.toBe(1);
      const evs = runTicks(s, 1500, undefined, {
        check: 'all', until: (st) => st.match.phase === MatchPhase.IN_PLAY && st.match.prevPhase === MatchPhase.FREE_KICK,
      });
      expect(findEvents(evs, EventType.WATCHDOG), `seed ${seed}`).toEqual([]);
      expect(s.match.phase, `seed ${seed}`).toBe(MatchPhase.IN_PLAY);
      expect(s.match.restart.taken).toBe(1);
    }
    // The case only bites when the swap really happened (a taker running in under the held timeout).
    expect(swapped).toBeGreaterThanOrEqual(3);
  });

  it('glitch CPU never acted — a restart handed to the CPU with its timeout nearly gone gets the CPU take window again', () => {
    for (const [kind, x, z] of [
      [RestartKind.FREE_KICK, 0, 10], [RestartKind.CORNER, 52.5, 34], [RestartKind.GOAL_KICK, -47, 9],
    ] as [RestartKind, number, number][]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed: 41 + kind, match: { periodT: 600 } });
      const ev = createEventBuffer();
      ev.begin(s.tick);
      awardRestart(s, kind, 0, x, z, ev);
      runTicks(s, 1500, undefined, { until: (st) => st.match.restart.ready === 1 && st.match.restart.timeoutT <= 2 });
      expect(s.match.restart.taken, `kind ${kind}`).toBe(0);
      runTicks(s, 1, (_t, _st, out) => { out[0]!.cmd = Command.HAND_TO_CPU; out[0]!.cmdArg = 0; });
      expect(s.match.restart.timeoutT, `kind ${kind}`).toBeGreaterThanOrEqual(T_RESTART.cpuTakeTimeoutTicks - 1);
      const evs = runTicks(s, 900, undefined, { check: 'all', until: (st) => st.match.restart.taken === 1 && st.match.phase === MatchPhase.IN_PLAY });
      expect(findEvents(evs, EventType.WATCHDOG), `kind ${kind}`).toEqual([]);
      expect(s.match.phase, `kind ${kind}`).toBe(MatchPhase.IN_PLAY);
    }
  });

  it('glitch forced shoot-out kick — a shoot-out kicker handed to the CPU after a long human aim gets the CPU kick, not the safety net', () => {
    // Without the fix: handed over after 6 s of aiming (cpuTimeoutTicks + defaultGraceTicks) the kick was forced through
    // applyKick (it can miss) with a WATCHDOG RESTART_BLOCKED the same tick; between 4 and 6 s the Default fired at once.
    for (const handAt of [100, 300, 400, 600, 700]) {
      const s = shootoutScenario(5, [{ side: 0 }]);
      untilSub(s, ShootoutSub.AIM, 3000, undefined, 0);
      let handTick = -1;
      const evs = runTicks(s, 2000, (tick, st, out) => {
        const so = st.match.shootout;
        if (so.sub === ShootoutSub.AIM && so.subT === handAt - 1 && st.ctrl[0]!.kind !== 0) {
          out[0]!.cmd = Command.HAND_TO_CPU; out[0]!.cmdArg = 0; handTick = tick;
        }
      }, { check: 'all', until: (st) => st.match.shootout.sub === ShootoutSub.RESULT });
      expect(s.ctrl[0]!.kind, `hand-off at ${handAt}`).toBe(0);
      expect(findEvents(evs, EventType.WATCHDOG), `hand-off at ${handAt}`).toEqual([]);
      const kicks = findEvents(evs, EventType.KICK);
      expect(kicks.length, `hand-off at ${handAt}`).toBeGreaterThanOrEqual(1);
      expect(handTick, `hand-off at ${handAt}`).toBeGreaterThan(0);
      // The CPU kicks after its own plan (cpuRestartDelay at least), not on the hand-off tick.
      expect(kicks[0]!.tick - handTick, `hand-off at ${handAt}`).toBeGreaterThanOrEqual(T_RULES.cpuRestartDelay);
    }
  });
});
