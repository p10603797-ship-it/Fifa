/**
 * [QF-14 CR -> owner of tests/scenario/int-c-anim-live.test.ts (GFX-12 / INT-C)] Its first case ("planted boots stay
 * planted ... (60 Hz display)") measures kick-boot contact on the foot kick actions (KICK / SHOT, ball within a boot's
 * reach) of CPU v CPU ticks 600-2100 of seed 20261014 and needs more than 3 of them (`expect(m.kicks).toBeGreaterThan(3)`).
 * QF-14 changed the sim (CPU shot choice, defending, keeper: every state hash moves): that window now holds 2 such
 * kicks, so the case fails with nothing wrong in the renderer. CR: re-pick the seed of that case (line
 * `measure(20261014, 600, 1500, 1)`), e.g. `measure(3, 600, 1500, 1)`: 11 kick actions in the window on the QF-14
 * tree, and the whole case passes with it (run on a scratch copy). This file shows the old seed's window (it.fails:
 * the count is 2) and checks the proposed one.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

/** int-c-anim-live's kick count for `seed`: foot kick actions in live play in ticks [600, 2100), ball in reach. */
function kicksInWindow(seed: number): number {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  let kicks = 0;
  for (let t = 0; t < 2100; t++) {
    step(s, frames, ev);
    if (t < 600 || s.match.phase !== MatchPhase.IN_PLAY) continue;
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK) continue;
      const p = s.players[e.a]!;
      if (p.act !== ActionKind.KICK && p.act !== ActionKind.SHOT) continue;
      if (Math.hypot(e.x - p.x, e.z - p.z) > 1 || e.y > 0.5) continue;
      kicks++;
    }
  }
  return kicks;
}

const SEED_NEW = 3;
const KICKS_NEW = 11;

describe('QF-14 CR: int-c-anim-live 60 Hz case needs a seed with kicks in its window', () => {
  it.fails('seed 20261014, ticks 600-2100: more than 3 foot kick actions (QF-14 tree: 2)', () => {
    expect(kicksInWindow(20261014)).toBeGreaterThan(3);
  });

  it('the proposed seed has more than 3 there', () => {
    expect(kicksInWindow(SEED_NEW)).toBe(KICKS_NEW);
    expect(KICKS_NEW).toBeGreaterThan(3);
  });
});
