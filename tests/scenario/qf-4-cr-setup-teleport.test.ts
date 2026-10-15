/**
 * [QF-4] CR for QF-1 (src/sim/rules/restart.ts restartTick / legalizePositions, D-008): at t = restartSetupTicks
 * every player not yet legal is teleported to a legal spot, and the taker to the ball. D-008 says the teleport is
 * "hidden by the restart camera cut", but throw-ins and free kicks away from goal have no set-piece camera (GFX-15
 * shows them on the main broadcast camera, by design) and the render draws a jump of more than 1 m in one tick at the
 * new spot (render/index.ts snapTeleports: halfway slides were worse). Measured over CPU matches (seeds 1-6, 3-minute
 * halves): at throw-in set-ups 68 of 70 had a player moved > 2 m in one tick, up to 13.9 m; at free kicks the taker
 * was moved up to 61 m to the ball, all on the main camera, in view.
 * Proposed fix: walk them there during the set-up delay instead (steer illegal players and the taker toward their
 * legal spot / the ball from t = 0 like the ready-phase push, and only teleport whoever is still off by more than a
 * step at t = restartSetupTicks, or extend the set-up until they arrive, capped). The set-piece kinds with a camera cut
 * (corner, goal kick, penalty, free kick near goal) may keep the teleport (GFX-15 cuts on the set-up tick). Changes sim
 * timing (hashes).
 * Marked it.fails until QF-1 lands it (then drop .fails).
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

/** Largest one-tick player move (m) on each throw-in set-up tick (restart.ready 0 -> 1) of a CPU match. */
function throwInSetupJumps(seed: number, want: number): number[] {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.halfMinutes = 3 as never;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const curr = initMatch(cfg) as SimState;
  const prev = cloneState(curr);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const jumps: number[] = [];
  for (let t = 0; t < 60 * 60 * 7 && jumps.length < want; t++) {
    copyState(prev, curr);
    step(curr, frames, ev);
    if (curr.match.phase === MatchPhase.POST_MATCH) break;
    if (curr.match.restart.kind !== RestartKind.THROW_IN || prev.match.restart.ready !== 0 || curr.match.restart.ready !== 1) continue;
    let worst = 0;
    for (let i = 0; i < NUM_SLOTS; i++) {
      const a = prev.players[i]!, b = curr.players[i]!;
      if (a.active !== 1 || b.active !== 1) continue;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d > worst) worst = d;
    }
    jumps.push(worst);
  }
  return jumps;
}

describe('QF-4 CR (QF-1): restart set-ups shown on the main camera do not teleport players', () => {
  it('at a throw-in set-up no player moves more than 1 m in one tick (they walk to legal spots)', () => {
    // [QF-10] Seeds until 6 set-ups are seen: one 3-minute-half match may have only 2 throw-ins (sim changes move the
    // count), which made the sample-size floor flaky.
    const jumps: number[] = [];
    for (let seed = 1; seed <= 4 && jumps.length < 6; seed++) jumps.push(...throwInSetupJumps(seed, 6 - jumps.length));
    expect(jumps.length).toBeGreaterThan(2);
    for (const j of jumps) expect(j).toBeLessThan(1);
  }, 120000);
});
