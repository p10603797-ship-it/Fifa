/**
 * [QF-4] CR for QF-2 (src/ai/setpieces.ts corner positions / CPU corner take): CPU corners are delivered into a box
 * with almost no attackers in it. At the moment of the corner kick (KICK event in the CORNER phase, CPU v CPU, seeds
 * 1-8, full matches) the kicking team had 0-3 outfield players inside the opponents' penalty area while the defenders
 * had 6-10 there; the kick came at restart.t ~163 (the CPU takes soon after ready while the attackers' scripted runs
 * into the box have barely started). The raised corner camera (GFX-15, BRIEF section 8 "a raised corner view for
 * corners") frames the box, so every corner reads as a cross to nobody; BRIEF section 6 asks for "scripted attacking
 * and defending positions for corners".
 * Proposed fix: hold the CPU corner take until the scripted attacking positions are reached (at least 4 attackers in
 * the box, or a cap of a few seconds), or place the attackers' corner slots at the award so they are in the box by
 * the set-up tick. Changes sim behaviour (hashes).
 * Marked it.fails until QF-2 lands it (then drop .fails). [QF-2 skeptic] Landed: box runners keep running, the cross
 * waits to cpuRestartDelay + 58 and box spots weigh the distance more. Seeds 1-2 now give 3, 3 (at the floor); the
 * mean over 40 matches is 2.1, 3.1 once QF-1 lets the CPU wait longer (QF-2 CR: cpuGraceTicks 60 -> 150).
 * [QF-10] Landed the rules half: RUL-04 / RUL-05 cpuGraceTicks 60 / 75 -> 140 (the fallback and its first retry stay
 * before RUL-11's 4 s CPU watchdog). The floor still needs TAI-13 to wait (QF-11: maxArrivalWait 58 -> ~130): the cross
 * still goes at cpuRestartDelay + 58 with the runners on their way. Seeds 1-2 passed at the floor by chance (3, 3); over
 * seeds 1-8 the round-2 baseline gave 3, 3, 2, 2, 2, 2, 2, 3 (mean 2.4) and the current tree 2, 2, 3, 5, 3, 2 (mean
 * 2.8, seed 1: 2, 2). Marked it.fails again until QF-11 lands maxArrivalWait (then drop .fails; the floor may rise to 4).
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS, HALF_LENGTH } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const BOX_DEPTH = 16.5, BOX_HALF_WIDTH = 20.16;

/** Attackers (kicking team, taker excluded) inside the attacked penalty area at each corner kick of a CPU match. */
function attackersAtCornerKicks(seed: number, want: number): number[] {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const out: number[] = [];
  for (let t = 0; t < 60 * 60 * 12 && out.length < want; t++) {
    const phase = s.match.phase;
    step(s, frames, ev);
    if (s.match.phase === MatchPhase.POST_MATCH) break;
    if (phase !== MatchPhase.CORNER) continue;
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK) continue;
      const team = s.players[e.a]!.team;
      const dir = s.teams[team]!.dir;
      let att = 0;
      for (let k = 0; k < NUM_SLOTS; k++) {
        const p = s.players[k]!;
        if (p.active !== 1 || k === e.a || p.team !== team) continue;
        if (p.x * dir > HALF_LENGTH - BOX_DEPTH && Math.abs(p.z) < BOX_HALF_WIDTH) att++;
      }
      out.push(att);
    }
  }
  return out;
}

describe('QF-4 CR (QF-2): CPU corners are taken with attackers in the box', () => {
  it.fails('at every CPU corner kick at least 3 attackers are inside the penalty area', () => {
    const counts = [...attackersAtCornerKicks(1, 3), ...attackersAtCornerKicks(2, 3)];
    expect(counts.length).toBeGreaterThan(1);
    for (const c of counts) expect(c).toBeGreaterThanOrEqual(3);
  }, 240000);
});
