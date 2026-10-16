/**
 * [QF-14 CR -> owner of tests/scenario/qf-4-anim.test.ts (QF-4 / GFX-12)] Its case "ball contact: kicks meet the
 * ball, dribble touches and first touches reach it (A/B against the reach switched off)" renders CPU v CPU ticks
 * 600-3000 of seed 8 (`live(8, 2400, 1)`, twice) and needs more than 8 first touches there
 * (`expect((on.contact['FIRST_TOUCH/FIRST_TOUCH'] ?? []).length).toBeGreaterThan(8)`). QF-14 changed the sim (CPU shot
 * choice, defending, keepers: every state hash moves): seed 8 now has 7 first touches in that window, so the case fails
 * with nothing wrong in the animator. CR: re-pick the seed (both `live(8, 2400, 1)` calls), e.g. `live(1, 2400, 1)`:
 * 14 kicks, 60 dribble touches, 17 first touches in the window on the QF-14 tree, and the whole case passes with it
 * (run on a scratch copy). This file shows the old seed's count (it.fails) and checks the proposed one; sim only.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

/** qf-4-anim's KICK event counts by `ACTION/KICK_KIND` in ticks [600, 3000) of `seed`. */
function counts(seed: number): Record<string, number> {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const c: Record<string, number> = {};
  for (let t = 0; t < 3000; t++) {
    step(s, frames, ev);
    if (t < 600) continue;
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK) continue;
      const k = `${ActionKind[s.players[e.a]!.act]}/${KickKind[e.b]}`;
      c[k] = (c[k] ?? 0) + 1;
    }
  }
  return c;
}

describe('QF-14 CR: qf-4-anim ball-contact case needs a seed with first touches in its window', () => {
  it.fails('seed 8, ticks 600-3000: more than 8 first touches (QF-14 tree: 7)', () => {
    expect(counts(8)['FIRST_TOUCH/FIRST_TOUCH'] ?? 0).toBeGreaterThan(8);
  });

  it('the proposed seed 1 has enough kicks, dribble touches and first touches', () => {
    const c = counts(1);
    expect((c['KICK/GROUND_PASS'] ?? 0) + (c['KICK/CROSS'] ?? 0) + (c['SHOT/SHOT_NORMAL'] ?? 0)).toBeGreaterThan(5);
    expect(c['NONE/DRIBBLE_TOUCH'] ?? 0).toBeGreaterThan(20);
    expect(c['FIRST_TOUCH/FIRST_TOUCH'] ?? 0).toBeGreaterThan(8);
  });
});
