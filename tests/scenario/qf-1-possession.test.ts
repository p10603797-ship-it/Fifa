/**
 * [QF-1] QA-11 possession hand-over through the real pipeline: one owner at a time and no ping-pong (the ball flicking
 * A -> B -> A -> B between two players within half a second), in bot matches and when two players arrive at a loose
 * ball together from opposite sides. (A scramble of tackle, blocked pass, loose-ball pick-up between two players a
 * metre apart can take ~1 s, each hand-over with its own cause: that is football, not ping-pong.)
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario, runTicks } from '../harness/scenario';

/** Owner-change tracker: counts A,B,A,B within `window` ticks and same-team hand-overs faster than any pass. */
function tracker(window: number) {
  const hist: { t: number; o: number }[] = [];
  let prev = -1;
  const out = { changes: 0, pingPong: 0, instantTeam: 0, examples: [] as string[] };
  const tick = (s: SimState): void => {
    if (s.match.phase !== MatchPhase.IN_PLAY) { prev = -1; hist.length = 0; return; }
    const o = s.ball.owner;
    if (o >= 0 && o !== prev) {
      out.changes++;
      hist.push({ t: s.tick, o });
      if (hist.length > 4) hist.shift();
      const n = hist.length;
      if (n === 4) {
        const [a, b, c, d] = hist as [typeof hist[0], typeof hist[0], typeof hist[0], typeof hist[0]];
        if (a.o === c.o && b.o === d.o && a.o !== b.o && d.t - a.t <= window) {
          out.pingPong++;
          if (out.examples.length < 5) out.examples.push(`t=${s.tick} ${a.o}@${a.t} ${b.o}@${b.t} ${c.o}@${c.t} ${d.o}@${d.t}`);
        }
      }
      if (n >= 2) {
        const p = hist[n - 2]!;
        if (s.players[p.o]!.team === s.players[o]!.team && s.tick - p.t <= 6) out.instantTeam++;
      }
    }
    if (o >= 0) prev = o;
    // One owner: the owner's slot is active and nobody else claims to dribble it.
    if (o >= 0) expect(s.players[o]!.active).toBe(1);
  };
  return { out, tick };
}

describe('QF-1 QA-11 possession hand-over', { timeout: 600_000 }, () => {
  it('no ping-pong (A, B, A, B within 0.5 s) and no instant same-team hand-over in 3 bot matches (every tick checked)', () => {
    let changes = 0;
    for (let i = 0; i < 3; i++) {
      const config = soakConfig(i, 515, { halfMinutes: 2, cupShare: 0 });
      const t = tracker(30);
      const r = runMatch({ config, checker: 'core', fastCutscenes: true, onTick: (s) => t.tick(s) });
      expect(r.exception).toBeUndefined();
      expect(t.out.examples, `match ${i}`).toEqual([]);
      expect(t.out.pingPong).toBe(0);
      expect(t.out.instantTeam, `match ${i}`).toBe(0);
      changes += t.out.changes;
    }
    expect(changes).toBeGreaterThan(150);
  });

  it('two opponents arriving at a loose ball together from opposite sides: one wins it, no flicking back and forth', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, match: { periodT: 600 } });
      const b = s.ball;
      const z = -12 + seed * 2;
      b.x = 0; b.y = 0.11; b.z = z; b.px = 0; b.py = 0.11; b.pz = z; b.vx = 0; b.vy = 0; b.vz = 0;
      b.owner = -1; b.heldBy = -1; b.lastTouch = -1; b.lastTouchTeam = -1;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        if (p.isKeeper === 1) continue;
        p.x = (p.team === 0 ? -1 : 1) * (20 + (i % 11)); p.z = -25 + (i % 11) * 5; p.vx = 0; p.vz = 0;
      }
      const a = s.players[5]!, d = s.players[16]!;
      a.x = -2.5; a.z = z; a.vx = 4; a.vz = 0; d.x = 2.5; d.z = z; d.vx = -4; d.vz = 0;
      const t = tracker(30);
      runTicks(s, 120, undefined, { check: 'all', until: (st) => { t.tick(st); return false; } });
      expect(t.out.examples, `seed ${seed}`).toEqual([]);
      expect(t.out.changes, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(t.out.changes, `seed ${seed}`).toBeLessThanOrEqual(3);
    }
  });
});
