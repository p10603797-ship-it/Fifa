/**
 * [QF-2 skeptic] QA-21 / QA-15: GKP-03 come-out start / abort / restart flip-flops that the first QF-2 pass left (its
 * scan used one seed; 26 more matches at Beginner, Professional and Legend still flipped about once in 7 matches).
 * Root cause: the first reachable sample of a bouncing or out-running ball is a knife edge, so TAI-07's interception
 * estimate of a defender (or of the keeper himself) jumped between ~25 ticks and the end of the horizon tick to tick,
 * and GKP-03 started / aborted the rush on alternate ticks (TAI-07's chaser swapped with it: the defender stopped and
 * went again). Fix: GKP-03 judges the start and the keep side of the race with different arrival slacks
 * (steer.ts estimateInterceptSlack; sweeper.ts keepReachSlack / mateNearMissSlack).
 * Fixtures: the tick before the flip, captured with the pre-fix code (serializeState):
 *  - qf-2-rush-flip-mate:   Beginner bot match soak seed 929 #0 (2-minute halves), t 3556: a lofted pass drops 6 m in
 *    front of team 0's box; defender 2 makes its first bounce by 2 ticks or misses it by 1 (estimate 25 <-> 137 ticks).
 *  - qf-2-rush-flip-byline: Professional soak seed 4242 #2 (4-minute halves), t 26300: team 0's keeper out to a ball
 *    rolling to his byline; his own estimate 21-35 ticks <-> "not before it goes out".
 *  - qf-2-rush-flip-1v1: Legend cup soak seed 4242 #1 (4-minute halves), t 19197: team 0's keeper out for a one-on-one
 *    on a through pass; the striker and the covering defender reach it within a tick of each other, so "an opponent
 *    beats every teammate" flipped every other tick (oneOnOneMateStart / oneOnOneMateKeep).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createInterceptEstimate, estimateIntercept, estimateInterceptSlack } from '../../src/ai/steer';
import { LOCAL_TUNING as L_SWEEP } from '../../src/sim/keeper/sweeper';
import { deserializeState } from '../../src/sim/core/serialize';
import { runTicks } from '../harness/scenario';

function fixture(name: string): SimState {
  return deserializeState(readFileSync(new URL(`./fixtures/${name}.state.json`, import.meta.url), 'utf8'));
}

interface RushLog { starts: number; flips: string[]; chaserSwaps: number; endAct: ActionKind }

/** Run `n` ticks and log team `team`'s keeper rush starts, restarts within 3 ticks of an end, and chaser swaps. */
function watchRush(s: SimState, team: number, n: number): RushLog {
  const k = s.teams[team]!.keeperSlot;
  const out: RushLog = { starts: 0, flips: [], chaserSwaps: 0, endAct: ActionKind.NONE };
  let prev = s.players[k]!.act;
  let ended = -1e9;
  let chaser = s.teams[team]!.chaser;
  runTicks(s, n, undefined, {
    check: 'core',
    until: (st) => {
      const a = st.players[k]!.act;
      if (a === ActionKind.GK_RUSH && prev !== ActionKind.GK_RUSH) {
        out.starts++;
        if (st.tick - ended <= 3) out.flips.push(`t${st.tick}: restarted ${st.tick - ended} ticks after it ended`);
      }
      if (a !== ActionKind.GK_RUSH && prev === ActionKind.GK_RUSH) ended = st.tick;
      prev = a;
      const c = st.teams[team]!.chaser;
      if (st.match.phase === MatchPhase.IN_PLAY && c >= 0 && chaser >= 0 && c !== chaser) out.chaserSwaps++;
      chaser = c;
      return false;
    },
  });
  out.endAct = s.players[k]!.act;
  return out;
}

describe('QF-2 GKP-03 come-out hysteresis (real pipeline from captured states)', () => {
  it('glitch: Keeper fights a defender for the same ball — no come-out start / abort / restart while a defender\'s first-bounce reach flickers', () => {
    const s = fixture('qf-2-rush-flip-mate');
    expect(s.ball.owner).toBe(-1);
    const r = watchRush(s, 0, 40);
    expect(r.flips, r.flips.join('\n')).toEqual([]);
    // The pre-fix code started the rush at t 3558, aborted it at 3562 and restarted it at 3565, swapping the chaser
    // between the keeper and defender 2 each time.
    expect(r.chaserSwaps).toBeLessThanOrEqual(2);
  });

  it('GKP-03 come-out never flip-flops: a rush to a ball rolling to his byline is not aborted and restarted while his own reach flickers', () => {
    const s = fixture('qf-2-rush-flip-byline');
    const k = s.teams[0]!.keeperSlot;
    expect(s.players[k]!.act).toBe(ActionKind.GK_RUSH);
    const r = watchRush(s, 0, 40);
    // Pre-fix: aborted at t 26304, restarted at 26305, aborted again at 26306.
    expect(r.flips, r.flips.join('\n')).toEqual([]);
    expect(r.starts).toBe(0);
  });

  it('GKP-03 come-out never flip-flops: a one-on-one is not ended and restarted while a covering defender and the striker tie for the ball', () => {
    const s = fixture('qf-2-rush-flip-1v1');
    const k = s.teams[0]!.keeperSlot;
    expect(s.players[k]!.act).toBe(ActionKind.GK_RUSH);
    const r = watchRush(s, 0, 40);
    // Pre-fix: ended at t 19204, restarted at 19206, ended at 19208.
    expect(r.flips, r.flips.join('\n')).toEqual([]);
    expect(r.starts).toBe(0);
  });

  it('TAI-07 estimateInterceptSlack: slack 0 is exactly estimateIntercept; the defender\'s knife edge is a near miss with slack', () => {
    expect(L_SWEEP.keepReachSlack).toBeGreaterThan(0);
    expect(L_SWEEP.mateNearMissSlack).toBeGreaterThan(0);
    const a = createInterceptEstimate(), b = createInterceptEstimate();
    let compared = 0;
    for (const name of ['qf-2-rush-flip-mate', 'qf-2-rush-flip-byline']) {
      const s = fixture(name);
      for (let step = 0; step < 4; step++) {
        for (let i = 0; i < 22; i++) {
          if (s.players[i]!.active !== 1) continue;
          estimateIntercept(s, i, a);
          estimateInterceptSlack(s, i, 0, b);
          expect([b.ballT, b.playerT, b.x, b.z, b.inHorizon]).toEqual([a.ballT, a.playerT, a.x, a.z, a.inHorizon]);
          compared++;
        }
        runTicks(s, 3);
      }
    }
    expect(compared).toBeGreaterThan(100);
    // t 3557 of the Beginner match: defender 2 misses the first-bounce window by a tick (strict: the end of the
    // horizon), with a 6-tick slack he makes it within 40 ticks.
    const s = fixture('qf-2-rush-flip-mate');
    runTicks(s, 1);
    expect(s.tick).toBe(3557);
    estimateIntercept(s, 2, a);
    estimateInterceptSlack(s, 2, L_SWEEP.mateNearMissSlack, b);
    expect(a.inHorizon).toBe(0);
    expect(b.inHorizon).toBe(1);
    expect(a.ballT - b.ballT).toBeGreaterThan(L_SWEEP.mateNearMissJump);
  });
});
