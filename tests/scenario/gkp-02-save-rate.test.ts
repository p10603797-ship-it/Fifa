/**
 * [GKP-02] Save-rate band (BRIEF section 6: 65-78% of on-target shots saved with equal teams, T_GK.targetSave*).
 * A scripted batch of on-target shots (11-33 m, skewed short; 60% aimed near a post; 50% low / 30% mid / 20% high;
 * 20-32 m/s) against a keeper standing on GKP-01's idealKeeperSpot, through the keeper pipeline (save decision ->
 * actions -> locomotion -> ball -> keeper contacts). Measured rates are printed for the report.
 * A smaller batch through the full step pipeline (all modules, real GKP-05 handling) is printed as well and only
 * sanity-checked, because it depends on every other module's current state.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/keeper/handling', async () => (await import('../unit/gkp-02-handling-mock')).handlingMock());

import { MatchPhase } from '../../src/contracts/enums';
import { T_GK } from '../../src/contracts/tuning';
import { idealKeeperSpot } from '../../src/sim/keeper/positioning';
import { makeScenario, runTicks } from '../harness/scenario';
import { batchShot, depth, KEEPER, keeperScenario, lcg, runShot, shoot, xAt } from '../unit/gkp-02-helpers';
import { BALL_RADIUS, GOAL_HALF_WIDTH, GOAL_HEIGHT } from '../../src/contracts/constants';

function placeKeeper(s: ReturnType<typeof keeperScenario>, u: number, z: number): void {
  const spot = { x: 0, z: 0 };
  s.ball.x = xAt(u); s.ball.z = z;
  idealKeeperSpot(s, 0, spot);
  const k = s.players[KEEPER]!;
  if (spot.x !== 0 || spot.z !== 0) { k.x = spot.x; k.z = spot.z; } else { k.x = xAt(2.5); k.z = z * 0.15; }
}

function batchRate(gk: number, shots: number, seed: number): { rate: number; n: number; catches: number; saves: number } {
  const rnd = lcg(seed);
  let n = 0, saves = 0, catches = 0;
  for (let i = 0; i < shots; i++) {
    const sh = batchShot(rnd);
    const s = keeperScenario({ gk });
    placeKeeper(s, sh.u, sh.z);
    shoot(s, sh);
    const r = runShot(s, 200);
    if (r.outcome !== 'save' && r.outcome !== 'goal') continue; // not on target after all (post, bar)
    n++;
    if (r.outcome === 'save') saves++;
    if (r.caught) catches++;
  }
  return { rate: saves / n, n, catches, saves };
}

describe('GKP-02 save rate', () => {
  it('equal teams: a typical (75) keeper saves 65-78% of on-target shots; better keepers save more', () => {
    const rates: Record<number, number> = {};
    for (const gk of [50, 75, 99]) {
      const b = batchRate(gk, 400, 12345);
      rates[gk] = b.rate;
      console.log(`GKP-02 save rate gk ${gk}: ${(b.rate * 100).toFixed(1)}% of ${b.n} on-target shots (catches ${b.catches} of ${b.saves} saves)`);
    }
    expect(rates[75]!).toBeGreaterThanOrEqual(T_GK.targetSaveMin);
    expect(rates[75]!).toBeLessThanOrEqual(T_GK.targetSaveMax);
    expect(rates[50]!).toBeLessThan(rates[75]!);
    expect(rates[99]!).toBeGreaterThan(rates[75]!);
    // A second, independent batch stays in the band too (not a lucky seed).
    const again = batchRate(75, 300, 777);
    console.log(`GKP-02 save rate gk 75 (seed 777): ${(again.rate * 100).toFixed(1)}% of ${again.n}`);
    expect(again.rate).toBeGreaterThanOrEqual(T_GK.targetSaveMin);
    expect(again.rate).toBeLessThanOrEqual(T_GK.targetSaveMax);
  });

  it('full step pipeline (all modules as they are now): measured and sanity-checked', () => {
    const rnd = lcg(2024);
    let n = 0, saves = 0;
    for (let i = 0; i < 80; i++) {
      const sh = batchShot(rnd);
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 100 + i });
      for (let p = 1; p < 22; p++) if (p !== 11) { s.players[p]!.x = 25 + (p % 4) * 4; s.players[p]!.z = -30 + p * 2.6; }
      s.players[11]!.x = 50; s.players[11]!.z = 0;
      const a = s.attrs[KEEPER]!;
      a.gkDiving = 75; a.gkHandling = 75; a.gkReflexes = 75; a.gkPositioning = 75;
      placeKeeper(s, sh.u, sh.z);
      shoot(s, sh);
      let out = '';
      runTicks(s, 200, undefined, {
        until: (st) => {
          if (st.ball.lastTouch === KEEPER) { out = 'save'; return true; }
          if (st.ball.lastTouch !== 20) { out = 'other'; return true; }
          if (depth(st.ball.x) < -BALL_RADIUS) {
            out = Math.abs(st.ball.z) < GOAL_HALF_WIDTH && st.ball.y < GOAL_HEIGHT ? 'goal' : 'wide';
            return true;
          }
          return false;
        },
      });
      if (out === 'save' || out === 'goal') { n++; if (out === 'save') saves++; }
    }
    const rate = saves / n;
    console.log(`GKP-02 save rate, full pipeline, gk 75: ${(rate * 100).toFixed(1)}% of ${n} on-target shots`);
    expect(n).toBeGreaterThan(40);
    expect(rate).toBeGreaterThan(0.5);
    expect(rate).toBeLessThan(0.92);
  });
});
