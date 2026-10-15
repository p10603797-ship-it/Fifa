/**
 * [QF-10, second pass] Regression tests for the defects the skeptic pass found in the area (kicks / actions / rules):
 *  - walked set-ups (throw-ins, free kicks away from goal) placed a taker who was still running in from 22-36 m at the
 *    180-tick set-up cap: a 6-25 m teleport on the main camera. The set-up now waits for a taker still closing on his
 *    spot up to setupExtendMaxTicks (270); stragglers who are not the running taker are still placed at
 *    setupStragglerMaxTicks (180).
 *  - the free kick moved clear of the fouled player (downClear) could cross a penalty-area line: a foul just outside the
 *    box became a free kick inside it.
 */
import { describe, expect, it } from 'vitest';
import {
  HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PLAYERS_PER_TEAM,
} from '../../src/contracts/constants';
import { ActionKind, ControllerKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { knockDown } from '../../src/sim/defend/tackle';
import { initMatch } from '../../src/sim/init';
import { LOCAL_TUNING as FK_LT } from '../../src/sim/rules/freekick';
import { awardRestart, isWalkedSetup, LOCAL_TUNING as RESTART_LT } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';

/** CPU v CPU match `seed` (3-minute halves) stepped until it is in play past tick `from`. */
function inPlay(seed: number, from = 900): { s: SimState; step1: () => void } {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.halfMinutes = 3 as never;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const step1 = (): void => { step(s, frames, ev); };
  while (s.tick < from || s.match.phase !== MatchPhase.IN_PLAY) step1();
  return { s, step1 };
}

/** Distance from (x, z) to the nearest active outfield player of `team`. */
function nearestOutfield(s: SimState, team: number, x: number, z: number): number {
  let best = 1e9;
  for (let i = team * PLAYERS_PER_TEAM; i < (team + 1) * PLAYERS_PER_TEAM; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    best = Math.min(best, Math.hypot(p.x - x, p.z - z));
  }
  return best;
}

/**
 * Award `kind` to `team` at the first spot of `spots` whose nearest outfield taker stands between lo and hi m away, run
 * the set-up to the kick: the largest one-tick move of any player (m), the ticks from the award to ready, and whether a
 * walked set-up was found at all.
 */
function farTakerSetup(seed: number, kind: RestartKind, spots: readonly (readonly [number, number])[], lo: number, hi: number):
  { found: boolean; maxStep: number; readyAfter: number; d0: number } {
  const { s, step1 } = inPlay(seed);
  for (const team of [0, 1]) {
    for (const [x, z] of spots) {
      const d0 = nearestOutfield(s, team, x, z);
      if (d0 < lo || d0 > hi) continue;
      const t = cloneState(s);
      awardRestart(t, kind, team, x, z, NULL_SINK);
      if (t.match.restart.kind !== kind || !isWalkedSetup(t)) continue;
      copyState(s, t);
      const r = s.match.restart;
      const prev = cloneState(s);
      let maxStep = 0, readyAfter = -1;
      for (let k = 1; k <= 900 && r.taken === 0 && s.match.phase !== MatchPhase.IN_PLAY; k++) {
        copyState(prev, s);
        step1();
        for (let i = 0; i < NUM_SLOTS; i++) {
          const a = prev.players[i]!, b = s.players[i]!;
          if (a.active === 1 && b.active === 1) maxStep = Math.max(maxStep, Math.hypot(b.x - a.x, b.z - a.z));
        }
        if (readyAfter < 0 && r.ready === 1) readyAfter = k;
      }
      return { found: true, maxStep, readyAfter, d0 };
    }
  }
  return { found: false, maxStep: 0, readyAfter: -1, d0: -1 };
}

describe('QF-10 skeptic: walked set-ups wait for a taker still running in', () => {
  it('qf-10: glitch set-up teleport - a throw-in taker starting 22-28 m away runs in, nobody moves 1 m in a tick', () => {
    const spots: [number, number][] = [];
    for (let x = -50; x <= 50; x += 2) { spots.push([x, HALF_WIDTH]); spots.push([x, -HALF_WIDTH]); }
    let found = 0;
    for (const seed of [1, 2, 3]) {
      const r = farTakerSetup(seed, RestartKind.THROW_IN, spots, 22, 28);
      if (!r.found) continue;
      found++;
      expect(r.maxStep).toBeLessThan(1);
      expect(r.readyAfter).toBeGreaterThan(T_RULES.restartSetupTicks + RESTART_LT.setupStragglerMaxTicks - 60);
      expect(r.readyAfter).toBeLessThanOrEqual(T_RULES.restartSetupTicks + RESTART_LT.setupExtendMaxTicks + 1);
    }
    expect(found).toBeGreaterThan(1);
  }, 120_000);

  it('qf-10: glitch set-up teleport - a far free-kick taker starting 26-32 m away runs in, nobody moves 1 m in a tick', () => {
    const spots: [number, number][] = [];
    for (let x = -48; x <= 48; x += 4) for (let z = -30; z <= 30; z += 6) spots.push([x, z]);
    let found = 0;
    for (const seed of [1, 2, 3]) {
      const r = farTakerSetup(seed, RestartKind.FREE_KICK, spots, 26, 32);
      if (!r.found) continue;
      found++;
      expect(r.d0).toBeGreaterThan(FK_LT.takerWalkMaxDist); // nobody nearer: the nearest runs in
      expect(r.maxStep).toBeLessThan(1);
      expect(r.readyAfter).toBeLessThanOrEqual(T_RULES.restartSetupTicks + RESTART_LT.setupExtendMaxTicks + 1);
    }
    expect(found).toBeGreaterThan(1);
  }, 120_000);

  it('qf-10: the longer wait for a running taker keeps a human timeout and its Default inside the throw-in phase limit', () => {
    // ready (award + restartSetupTicks + setupExtendMaxTicks at the latest) + 12 s timeout + the Default grace
    const latest = T_RULES.restartSetupTicks + RESTART_LT.setupExtendMaxTicks + T_RULES.restartTimeoutTicks + RESTART_LT.defaultGraceTicks;
    expect(latest).toBeLessThan(T_RULES.phaseMaxTicks[MatchPhase.THROW_IN]! - 20);
    expect(latest).toBeLessThan(T_RULES.phaseMaxTicks[MatchPhase.FREE_KICK]! - 20);
    expect(RESTART_LT.setupExtendMaxTicks).toBeGreaterThanOrEqual(RESTART_LT.setupStragglerMaxTicks);
  });
});

describe('QF-10 skeptic: the free kick moved off the fouled player stays on its side of the area line', () => {
  it('qf-10: a foul just outside the penalty area is not moved inside it (or out of the own area)', () => {
    const cases: [number, number, number][] = [
      // [attacked end: 1 = the area the team attacks, -1 = its own], depth from the goal line (m), |z| (m)
      [1, 8, PENALTY_AREA_HALF_WIDTH + 0.5],
      [1, 12, PENALTY_AREA_HALF_WIDTH + 0.9],
      [1, PENALTY_AREA_DEPTH + 0.6, 6],
      [-1, 8, PENALTY_AREA_HALF_WIDTH - 0.5],
      [-1, PENALTY_AREA_DEPTH - 0.5, 4],
    ];
    for (const [end, depth, az] of cases) {
      for (const sz of [1, -1]) {
        const { s } = inPlay(4);
        const dir = s.teams[0]!.dir;
        const gx = end * dir * HALF_LENGTH;
        const x = gx - end * dir * depth, z = sz * az;
        const vic = 7;
        const p = s.players[vic]!;
        p.x = x; p.z = z; p.vx = 0; p.vz = 0;
        knockDown(s, vic, ActionKind.FALLEN, NULL_SINK);
        const inside = (px: number, pz: number): boolean =>
          Math.abs(px - gx) <= PENALTY_AREA_DEPTH && Math.abs(pz) <= PENALTY_AREA_HALF_WIDTH;
        awardRestart(s, RestartKind.FREE_KICK, 0, x, z, NULL_SINK);
        const r = s.match.restart;
        expect(r.kind).toBe(RestartKind.FREE_KICK);
        expect(inside(r.x, r.z)).toBe(inside(x, z));
        expect(Math.hypot(r.x - p.x, r.z - p.z)).toBeGreaterThanOrEqual(FK_LT.downClear - 1e-6);
      }
    }
  });
});
