/**
 * [QF-1] CR for QF-2 (src/sim/kicks/pass.ts + shot.ts, outside QF-1's area). A foot kick (KICK / SHOT action) is played
 * with the ball out of the kicker's reach: about 1 kick in 10 in CPU play, mostly GROUND_PASS by the ball's owner with
 * the ball 1.4-2.1 m away (a sprint dribble touch had pushed it 2.4 m ahead when the pass started) or still bouncing at
 * 0.5-0.8 m. pass.ts ballInReach (and shot.ts's copy) returns true for the owner's ball at ANY distance up to
 * T_DRIBBLE.loseRadius, so the contact never waits for the ball; SIM-06's wind-up hold (holdMaxRel 6 m/s over the
 * 8-tick wind-up) cannot bring a ball back from 2.8 m. INT-C reported it (tests/scenario/int-c-anim-live.test.ts
 * outOfReach): no pose can meet such a ball.
 * Proposed fix (pass.ts and the same in shot.ts):
 *   - ballInReach: drop `if (b.owner === slot) return true;` so the owned ball also needs reachRadius (1.2 m) and
 *     reachHeight (0.8 m);
 *   - kickUpdate / shotUpdate grace: for the owner's own ball wait until it is in reach (up to the planned recovery,
 *     not just contactGraceTicks) while kickMove steers the kicker onto the ball (ARRIVE at the ball at jog), then kick;
 *     whiff only when it never comes into reach.
 * Expected after the fix: no foot kick is played with the ball more than reachRadius away or above reachHeight.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { LOCAL_TUNING as PASS_LT } from '../../src/sim/kicks/pass';
import { step } from '../../src/sim/step';

function outOfReachKicks(seed: number, ticks: number): { kicks: number; out: number } {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  let kicks = 0, out = 0;
  for (let t = 0; t < ticks; t++) {
    const before = cloneState(s);
    step(s, frames, ev);
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK || s.match.phase !== MatchPhase.IN_PLAY) continue;
      const p = s.players[e.a]!;
      if (p.act !== ActionKind.KICK && p.act !== ActionKind.SHOT) continue;
      kicks++;
      const q = before.players[e.a]!; // where he stood when the action stage played the ball
      if (Math.hypot(e.x - q.x, e.z - q.z) > PASS_LT.reachRadius + 1e-6 || e.y > PASS_LT.reachHeight + 1e-6) out++;
    }
  }
  return { kicks, out };
}

describe('QF-1 CR (QF-2) foot kicks only within reach', { timeout: 600_000 }, () => {
  it.fails('qf-1-cr: no KICK / SHOT action plays a ball beyond reachRadius / reachHeight in CPU play (3 seeds)', () => {
    let kicks = 0, out = 0;
    for (const seed of [3, 4, 20261014]) {
      const r = outOfReachKicks(seed, 4500);
      kicks += r.kicks;
      out += r.out;
    }
    expect(kicks).toBeGreaterThan(40);
    expect(out).toBe(0);
  });
});
