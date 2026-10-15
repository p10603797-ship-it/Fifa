/**
 * [GKP-05] Catch -> hold -> release through the whole pipeline with the GKP-02 saves: shots and crosses at the keeper
 * (bot keeper and human keeper doing nothing), invariants 'all' every tick. Every catch is released within 6 s, the
 * ball is never in his hands outside his area, never carried over the line, no goal while held.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { T_GK } from '../../src/contracts/tuning';
import { makeScenario, runTicks } from '../harness/scenario';
import { KEEPER, OPP, depth, xAt } from '../unit/gkp-05-helpers';

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

/** Ball struck from (u, z) toward the goal mouth at speed sp with loft vy; keeper on his line area. */
function shotAt(seed: number, human: boolean): SimState {
  const r = rng(seed);
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: human ? [{ side: 0, slot: KEEPER }] : [] });
  for (let i = 1; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -30 + (i % 5) * 4 : 0 + (i % 5) * 4;
    p.z = -25 + (i % 11) * 5;
  }
  const k = s.players[KEEPER]!;
  k.x = xAt(2 + r() * 3); k.z = (r() - 0.5) * 3; k.fx = 1; k.fz = 0;
  const b = s.ball;
  const u = 10 + r() * 14, z = (r() - 0.5) * 16;
  b.x = xAt(u); b.z = z; b.y = BALL_RADIUS + r() * 0.8;
  const tz = (r() - 0.5) * 5;
  const dx = xAt(0) - b.x, dz = tz - z;
  const dl = Math.hypot(dx, dz);
  const sp = 9 + r() * 9;
  b.vx = dx / dl * sp; b.vz = dz / dl * sp; b.vy = r() * 3;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.grounded = 0; b.owner = -1; b.heldBy = -1;
  b.lastKickBy = OPP; b.lastKickTeam = 1; b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick;
  b.lastTouch = OPP; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.shotBy = OPP; b.shotTick = s.tick;
  s.players[OPP]!.lastTouchTick = s.tick;
  return s;
}

describe('GKP-05 catch -> hold -> release (with GKP-02 saves)', () => {
  for (const human of [false, true]) {
    it(`every catch is released within 6 s, in his area, never over his line (${human ? 'human' : 'bot'} keeper)`, () => {
      let catches = 0;
      for (let seed = 1; seed <= 24; seed++) {
        const s = shotAt(seed * 7919, human);
        let pickTick = -1;
        let heldMax = 0;
        let bad = '';
        const ev = runTicks(s, T_GK.maxHoldTicks + 120, undefined, {
          check: 'all',
          until: (st, evs) => {
            for (const e of evs) {
              if (e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 1) pickTick = st.tick;
              if (e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 0 && pickTick >= 0) {
                heldMax = Math.max(heldMax, st.tick - pickTick);
                pickTick = -1;
              }
            }
            if (st.ball.heldBy === KEEPER) {
              if (depth(st.ball.x) <= BALL_RADIUS) bad = `ball over the line at t=${st.tick}`;
              if (pickTick >= 0 && st.tick - pickTick > T_GK.maxHoldTicks) bad = `held too long at t=${st.tick}`;
            }
            return false;
          },
        });
        expect(bad, `seed ${seed}`).toBe('');
        const picks = ev.filter((e) => e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 1).length;
        const drops = ev.filter((e) => e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 0).length;
        catches += picks;
        // [QF-11 skeptic] A catch of a later shot less than maxHoldTicks before the end of the run is still in his hands
        // when the run stops (its hold limit is checked above): only that last one may be unreleased.
        const lastHeld = pickTick >= 0 && s.tick - pickTick <= T_GK.maxHoldTicks ? 1 : 0;
        expect(drops, `seed ${seed}`).toBe(picks - lastHeld);
        expect(heldMax, `seed ${seed}`).toBeLessThanOrEqual(T_GK.maxHoldTicks);
      }
      expect(catches).toBeGreaterThan(4);
    }, 120_000);
  }
});
