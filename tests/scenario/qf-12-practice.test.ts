/**
 * [QF-12] One implementation of the practice hooks (in the sim) and the app tick as a plain sim step.
 *  - modes/practice re-exports the sim hooks; MOD-04's names (practiceSide / practiceAttemptOver / practiceSpotWorld /
 *    practiceSpotOf) are the sim's practiceTeam / practiceAttemptDone / practiceSpotPoint / practiceSpotIndex.
 *  - PRACTICE_SPOTS (the labels the practice screen shows) and the sim's spot geometry agree for every spot, so the
 *    spot a player picks is the spot the sim awards.
 *  - The app loop's default step is the sim step: a practice match driven through createLoop gives the same hash as
 *    the plain step, and a replay (initMatch + step) of the same inputs reproduces it.
 */
import { describe, expect, it } from 'vitest';
import type { StatsTracker, TickInputProvider } from '../../src/contracts/app';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { MatchPhase, PracticeKind } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createLoop, stepWithModes } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import type { MatchRuntime } from '../../src/app/types';
import * as modes from '../../src/modes/practice';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import * as sim from '../../src/sim/rules/practice';
import { step } from '../../src/sim/step';
import { fakeCtx } from '../unit/mod-01-fakes';

const SET_PIECES = [PracticeKind.FREE_KICKS, PracticeKind.CORNERS, PracticeKind.PENALTIES];

describe('QF-12 practice hooks: one copy, in the sim', () => {
  it('modes/practice re-exports every sim hook and aliases MOD-04 names to them', () => {
    expect(modes.practiceRulesTick).toBe(sim.practiceRulesTick);
    expect(modes.preparePracticeState).toBe(sim.preparePracticeState);
    expect(modes.practiceRestartKind).toBe(sim.practiceRestartKind);
    expect(modes.practiceSpotPoint).toBe(sim.practiceSpotPoint);
    expect(modes.practiceAttemptDone).toBe(sim.practiceAttemptDone);
    expect(modes.practiceTeam).toBe(sim.practiceTeam);
    expect(modes.practiceSide).toBe(sim.practiceTeam);
    expect(modes.practiceAttemptOver).toBe(sim.practiceAttemptDone);
    expect(modes.LOCAL_TUNING.attemptTicks).toBe(sim.LOCAL_TUNING.attemptTicks);
    expect(modes.LOCAL_TUNING.penaltyAttemptTicks).toBe(sim.LOCAL_TUNING.penaltyAttemptTicks);
  });

  it('every PRACTICE_SPOTS entry (screen labels) is the spot the sim awards, both ends', () => {
    for (const kind of SET_PIECES) {
      const list = modes.PRACTICE_SPOTS[kind]!;
      expect(list.length).toBe(sim.practiceSpotTotal(kind));
      expect(modes.practiceSpotCount(kind)).toBe(sim.practiceSpotTotal(kind));
      for (let i = 0; i < list.length; i++) {
        for (const dir of [1, -1]) {
          const out = { x: 0, z: 0 };
          sim.practiceSpotPoint(kind, i, dir, out);
          expect(out.x).toBeCloseTo(dir * (HALF_LENGTH - list[i]!.dist), 9);
          expect(out.z).toBeCloseTo(dir * list[i]!.right, 9);
          const w = modes.practiceSpotWorld(kind, i, dir, { x: 9, z: 9 });
          expect(w).toEqual(out);
        }
      }
    }
  });

  it('the spot chosen on the practice screen is the one the config carries and the sim reads', () => {
    for (const kind of SET_PIECES) {
      const n = modes.practiceSpotCount(kind);
      for (let i = -1; i <= n; i++) {
        const setup = modes.buildPracticeSetup(fakeCtx(), kind, { spot: i, humans: [] });
        const want = i >= 0 && i < n ? i : 0;
        expect(modes.practiceSpotOf(setup.config)).toBe(want);
        expect(sim.practiceSpotIndex(setup.config)).toBe(want);
      }
    }
  });
});

describe('QF-12 app tick = plain sim step', () => {
  function loopRun(kind: PracticeKind, ticks: number): { s: SimState; phases: number[] } {
    const setup = modes.buildPracticeSetup(fakeCtx(), kind, { spot: 1, humans: [] });
    setup.config.seed = 5150;
    const curr = initMatch(setup.config);
    const prev = cloneState(curr);
    const provider: TickInputProvider = {
      waiting: false, ready: () => true, take: () => undefined, pump: () => undefined, releaseAll: () => undefined, dispose: () => undefined,
    };
    const stats: StatsTracker = { reset: () => undefined, onTick: () => undefined, summary: () => null as never };
    const rt: MatchRuntime = { prev, curr, provider, frames: [createInputFrame(), createInputFrame()], events: createEventBuffer(), stats };
    const phases: number[] = [];
    const session = { paused: false, ticking: true, runtime: () => rt, afterTick: () => { phases.push(rt.curr.match.phase); } };
    const noop = (): void => undefined;
    const hud = { mount: noop, setMatch: noop, update: noop, onEvents: noop, setVisible: noop, dispose: noop };
    const audio = {
      unlock: () => Promise.resolve(), unlocked: false, setVolumes: noop, onEvents: noop, update: noop, playUi: noop, matchStart: noop, matchEnd: noop,
      setPaused: noop, suspend: noop, resume: noop,
    };
    const errors: unknown[] = [];
    const loop = createLoop({
      session, renderer: createNullRenderer(), hud, audio, router: { current: 'match', currentScreen: () => null },
      getProjector: () => null, onError: (e) => errors.push(e), raf: () => 1, caf: () => undefined, now: () => 0,
    });
    // 3 ticks per 50 ms frame: no accumulator remainder, exactly `ticks` ticks.
    let t = 0;
    loop.frame(t);
    while (rt.curr.tick < ticks) {
      t += 50;
      loop.frame(t);
    }
    expect(errors).toEqual([]);
    return { s: rt.curr, phases };
  }

  function plainRun(kind: PracticeKind, ticks: number): SimState {
    const setup = modes.buildPracticeSetup(fakeCtx(), kind, { spot: 1, humans: [] });
    setup.config.seed = 5150;
    const s = initMatch(setup.config);
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    while (s.tick < ticks) step(s, frames, ev);
    return s;
  }

  it('stepWithModes is the sim step', () => {
    expect(stepWithModes).toBe(step);
  });

  it('corner practice through the real app loop matches a plain-step replay bit for bit, and corners are awarded', () => {
    const a = loopRun(PracticeKind.CORNERS, 600);
    const b = plainRun(PracticeKind.CORNERS, a.s.tick);
    expect(hashState(a.s)).toBe(hashState(b));
    expect(a.phases.includes(MatchPhase.CORNER)).toBe(true);
    // Every restart the loop entered is the practice corner (no goal kick / throw-in survives the practice rule).
    for (const ph of a.phases) expect([MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.FREE_KICK, MatchPhase.PENALTY]).not.toContain(ph);
  });

  it('free play through the real app loop: initMatch alone fields only the opponent keeper (no app-side prepare)', () => {
    const a = loopRun(PracticeKind.FREE_PLAY, 120);
    let away = 0;
    for (let i = 0; i < a.s.players.length; i++) if (a.s.players[i]!.team === 1 && a.s.players[i]!.active === 1) away++;
    expect(away).toBe(1);
    expect(hashState(a.s)).toBe(hashState(plainRun(PracticeKind.FREE_PLAY, a.s.tick)));
  });
});
