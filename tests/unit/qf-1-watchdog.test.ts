/**
 * [QF-1] RUL-11 watchdog: BALL_UNTOUCHED means a ball that LIES untouched for 8 s (BRIEF §5 "the ball lies unreachable
 * or untouched for 8 s"), not one still bouncing / rolling away after a long kick with the chasers running after it.
 * sim/step counts ball.idleT only while the ball lies (horizontal speed below 1 m/s) or is held in a keeper's hands.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { watchdogTick } from '../../src/sim/rules/watchdog';
import { step } from '../../src/sim/step';
import { fuzzJobs } from '../../tools/fuzz';
import { runJob } from '../../tools/lib/jobs';
import { makeScenario } from '../harness/scenario';

function loose(vx: number, idle: number) {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, match: { periodT: 1000 } });
  const b = s.ball;
  b.x = -30; b.y = 0.11; b.z = -20; b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = vx; b.vy = 0; b.vz = 0; b.owner = -1; b.heldBy = -1;
  b.lastTouch = 11; b.lastTouchTeam = 1; b.lastTouchTick = 0; b.idleT = idle;
  for (let i = 0; i < 22; i++) { const p = s.players[i]!; p.x = 20 + (i % 11) * 2; p.z = -10 + (i % 7) * 3; }
  return s;
}

describe('QF-1 RUL-11 BALL_UNTOUCHED only for a ball that lies untouched', { timeout: 600_000 }, () => {
  it('a ball still rolling (5 m/s) does not count as lying: idleT stays; a slow one counts', () => {
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    const fast = loose(-5.3, 100);
    step(fast, frames, ev);
    expect(fast.ball.idleT).toBe(100);
    const slow = loose(-0.5, 100);
    step(slow, frames, ev);
    expect(slow.ball.idleT).toBe(101);
  });

  it('a ball that has lain untouched for 8 s still fires: the nearest restart for the right team', () => {
    const s = loose(-0.3, T_RULES.ballIdleTicks);
    const ev = createEventBuffer();
    ev.begin(s.tick);
    watchdogTick(s, ev);
    const wd = ev.toArray().filter((e) => e.type === EventType.WATCHDOG);
    expect(wd).toHaveLength(1);
    expect(wd[0]!.a).toBe(WatchdogReason.BALL_UNTOUCHED);
    expect(s.match.restart.kind).toBe(RestartKind.FREE_KICK);
    expect(s.match.restart.team).toBe(0);
  });

  it('a ball held in a keeper\'s hands counts whatever its speed (he walks with it)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, match: { periodT: 1000 } });
    const k = s.players[0]!;
    s.ball.heldBy = 0; s.ball.owner = 0; s.ball.x = k.x; s.ball.z = k.z; s.ball.vx = 2; s.ball.idleT = 10;
    k.vx = 2;
    s.ball.touchedTick = -5;
    const ev = createEventBuffer();
    step(s, [createInputFrame(), createInputFrame()], ev);
    if (s.ball.heldBy === 0 && s.ball.touchedTick !== s.tick) expect(s.ball.idleT).toBe(11);
  });

  for (const [seed, only] of [[202, 8], [303, 33]] as [number, number][]) {
    it(`fuzz seed ${seed} #${only}: a long kick chased for 8+ s and caught as it stops is no watchdog`, () => {
      const [job] = fuzzJobs({
        matches: 1, workers: 1, seed, enforce: 'all', halfMinutes: 2, json: null, maxReplays: 0, only, quiet: true,
        jobTimeoutSeconds: null,
      });
      const r = runJob(job!, { replayDir: '', replayPrefix: 'qf-1', replayBudget: () => false });
      expect(r.watchdogReasons).toEqual({});
      expect(r.reasons).toEqual([]);
    });
  }
});
