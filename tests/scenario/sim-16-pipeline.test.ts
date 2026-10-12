/**
 * SIM-16 through the real step() pipeline: SIM-15's resolveControllers calls switchTick(s, c, ev, frame) every tick.
 * Checks that switching inputs and ownership rules work end to end and that the controller invariant (every live
 * controller on a valid player of its side, links consistent, never shared) holds through whole bot and human
 * stretches of play. Depends on the in-progress pipeline modules; failures in other modules surface here too.
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

function controlProblems(s: SimState): string[] {
  const out: string[] = [];
  const owner = new Array<number>(NUM_SLOTS).fill(-1);
  for (let c = 0; c < s.ctrl.length; c++) {
    const ctl = s.ctrl[c]!;
    if (ctl.kind === ControllerKind.NONE || ctl.slot < 0) continue;
    const p = s.players[ctl.slot]!;
    if (p.active !== 1) out.push(`c${c} on inactive ${ctl.slot}`);
    if (p.team !== ctl.side) out.push(`c${c} on other side ${ctl.slot}`);
    if (p.ctrl !== c) out.push(`c${c} slot ${ctl.slot} has ctrl ${p.ctrl}`);
    if (owner[ctl.slot]! >= 0) out.push(`c${c} shares ${ctl.slot} with c${owner[ctl.slot]}`);
    owner[ctl.slot] = c;
  }
  return out;
}

describe('SIM-16 in the step() pipeline', () => {
  it('MOD_L in defence switches through the resolver to the player the marker showed', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 9 }],
      players: [{ slot: 9, x: 25, z: 0 }, { slot: 19, x: -10, z: 0, vx: -4 }, { slot: 3, x: -24, z: 1 }],
      ball: { x: -10.4, z: 0, owner: 19 },
    });
    let marker = -1;
    const ev = runTicks(s, 3, (t, st, out) => {
      if (t === 3) { marker = st.ctrl[0]!.nextSwitch; out[0]!.buttons = Btn.MOD_L; }
    });
    const sw = findEvents(ev, EventType.SWITCH, (e) => e.c === 0);
    expect(marker).toBeGreaterThanOrEqual(0);
    expect(sw.map((e) => [e.a, e.b])).toEqual([[9, marker]]);
    expect(s.ctrl[0]!.slot).toBe(marker);
  });

  it('the controller invariant holds through bot-v-bot and human play (ownership, auto, manual inputs)', () => {
    for (const humans of [0, 1, 2]) {
      const s = makeScenario({ phase: MatchPhase.KICK_OFF, humans, seed: 21 + humans });
      const checker = createInvariantChecker(['controllers']);
      const problems: string[] = [];
      let switches = 0;
      runTicks(s, 1500, (t, st, out) => {
        // Humans press switch / flick now and then and move toward the ball.
        for (let h = 0; h < 2; h++) {
          const f = out[h]!;
          if (t % 47 === 0) f.buttons |= Btn.MOD_L;
          if (t % 71 === 0) { f.buttons |= Btn.RS_FLICK; f.ax = 90; f.az = -60; }
          f.mx = st.ball.x > 0 ? 100 : -100;
        }
      }, {
        until: (st, tickEvents) => {
          for (const e of tickEvents) if (e.type === EventType.SWITCH) switches++;
          for (const p of controlProblems(st)) problems.push(`t=${st.tick} ${p}`);
          for (const p of checker.check(st, null)) problems.push(`t=${st.tick} ${p}`);
          return problems.length > 5;
        },
      });
      expect(problems, `humans=${humans}`).toEqual([]);
      expect(switches).toBeGreaterThan(0);
    }
  }, 120_000);
});
