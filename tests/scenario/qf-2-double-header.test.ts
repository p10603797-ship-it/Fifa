/**
 * [QF-2 skeptic] QA-15 / QA-16: two teammates going up for the same header. An AI defender starts a SIM-12 header
 * attempt on a dropping ball in his own third; SIM-16 auto-switches the CPU controller to another defender; after the
 * reaction delay TAI-11 maybeClear presses SHOOT for him (an aerial chance in the own third) and SIM-15 starts a second
 * attempt on the same flight: both run to the same spot, jump together and collide (then stay locked together, the
 * velocity flipping each tick). About 10 a match at every level (30 bot matches, soak seed 5151). Fix: maybeClear
 * presses nothing while a teammate has an open attempt on the ball's current flight (defending.ts mateOnFlight).
 * Fixtures (serializeState, pre-fix code): Professional soak seed 5151 #0 (4-minute halves) at t 4578 (team 0's
 * second attempt came at 4584) and t 893 (team 1's at 897).
 * The same can happen to a human (SIM-16 switches him off the defender who is going up, he presses for the new one):
 * SIM-12 startAerial now ends an AI-driven teammate's open attempt on the flight (aerial.ts yieldTeammates).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createActionRequest } from '../../src/contracts/systems';
import { createEventBuffer } from '../../src/sim/core/events';
import { deserializeState } from '../../src/sim/core/serialize';
import { aerialChance, startHeader } from '../../src/sim/kicks/aerial';
import { runTicks } from '../harness/scenario';

function fixture(name: string): SimState {
  return deserializeState(readFileSync(new URL(`./fixtures/${name}.state.json`, import.meta.url), 'utf8'));
}

/** Most open header / volley attempts one team has on the ball's current flight over `n` ticks. */
function worstAttempts(s: SimState, n: number): { worst: number; first: string } {
  let worst = 0;
  let first = '';
  runTicks(s, n, undefined, {
    check: 'core',
    until: (st) => {
      for (let t = 0; t < 2; t++) {
        let k = 0;
        let who = '';
        for (let i = t * 11; i < t * 11 + 11; i++) {
          const q = st.players[i]!;
          if ((q.act === ActionKind.HEADER || q.act === ActionKind.VOLLEY) && q.actDone === 0 && q.actB === st.ball.lastTouchTick) {
            k++;
            who += ` ${i}(ctrl ${q.ctrl})`;
          }
        }
        if (k > worst) { worst = k; first = `t${st.tick} team ${t}:${who}`; }
      }
      return false;
    },
  });
  return { worst, first };
}

describe('QF-2 one header attempt per team on a flight (real pipeline from captured states)', () => {
  it('glitch: Two teammates chase the same ball — the CPU never sends a second defender up for a header a teammate already attempts (team 0)', () => {
    const r = worstAttempts(fixture('qf-2-double-header-t0'), 40);
    expect(r.worst, r.first).toBe(1);
  });

  it('glitch: Two teammates chase the same ball — the CPU never sends a second defender up for a header a teammate already attempts (team 1)', () => {
    const r = worstAttempts(fixture('qf-2-double-header-t1'), 40);
    expect(r.worst, r.first).toBe(1);
  });

  it('glitch: Two teammates chase the same ball — a controlled player\'s header press takes the flight from the AI teammate going up for it', () => {
    const s = fixture('qf-2-double-header-t0');
    runTicks(s, 6, undefined, { check: 'core' });
    expect(s.tick).toBe(4584);
    const ai = s.players[10]!;
    expect(ai.act).toBe(ActionKind.HEADER);
    expect(ai.actDone).toBe(0);
    expect(ai.ctrl).toBeLessThan(0);
    expect(aerialChance(s, 8)).toBeGreaterThan(0);
    // The press SIM-15 would turn into a headed clearance for the controlled defender 8.
    const req = createActionRequest();
    req.power = 0.5;
    expect(startHeader(s, 8, KickKind.HEADER_PASS, req, createEventBuffer())).toBe(1);
    expect(s.players[8]!.act).toBe(ActionKind.HEADER);
    expect(ai.actDone).toBe(1);
    const r = worstAttempts(s, 40);
    expect(r.worst, r.first).toBe(1);
  });
});
