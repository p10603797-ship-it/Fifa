/**
 * [QF-4] CR for QF-2 (src/sim/kicks/pass.ts kickUpdate, src/sim/kicks/shot.ts shotUpdate, src/sim/kicks/lob.ts):
 * a charged foot kick makes its contact on the very tick the power bar is released. kickUpdate / shotUpdate wait while
 * p.actCharging and strike as soon as it clears (actT >= actContact already, so contact(s, slot, ev) runs that tick).
 * The clip is held at the top of its backswing while charging (GFX-12 ACTION_HOLD), so the render either jumps the
 * leg from the backswing to the ball in one frame (a 0.8-0.9 m limb pop) or shows the strike over two frames with
 * the ball already gone (what it does now: the boot is 0.35-0.47 m from the ball on the contact frame). Of the 6 foot
 * kicks INT-C measures in seed 20261014 (ticks 600-2100), 3 are charged releases: int-c-anim-live's contact median
 * (< 0.25 m) fails on them, at 60 Hz and at 120 Hz (seed 777), with every uncharged kick at 0.08-0.16 m.
 * Proposed fix: when the bar releases (p.actCharging 1 -> 0 with actT >= actContact - releaseStrikeTicks), set
 * p.actContact = p.actT + releaseStrikeTicks (2-3 ticks: ~ACTION_HOLD..contact of the clip at 60 Hz) and keep the
 * ball held at the kicking spot until then; the first-time early release (resolveActions.chargeTick "wind-up done and
 * the ball in reach") can keep its tick, the ball's ETA already gives the strike time. Changes sim timing (hashes).
 * Marked it.fails until QF-2 lands it (then drop .fails).
 */
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

/** Ticks from the release of the power bar to the KICK event, for every charged foot kick in open play. */
function chargedStrikeGaps(seed: number, ticks: number): number[] {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const charging = new Uint8Array(NUM_SLOTS);
  const releasedAt = new Int32Array(NUM_SLOTS).fill(-1);
  const gaps: number[] = [];
  for (let t = 0; t < ticks; t++) {
    step(s, frames, ev);
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK || s.match.phase !== MatchPhase.IN_PLAY) continue;
      const p = s.players[e.a]!;
      if (p.act !== ActionKind.KICK && p.act !== ActionKind.SHOT) continue;
      if (charging[e.a] === 1) gaps.push(0); // still charging last tick: released and struck on this tick
      else if (releasedAt[e.a] >= 0 && p.actT >= p.actContact) gaps.push(s.tick - releasedAt[e.a]!);
    }
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = s.players[i]!;
      const c = p.act !== ActionKind.NONE && p.actCharging === 1 ? 1 : 0;
      if (charging[i] === 1 && c === 0) releasedAt[i] = s.tick;
      if (p.act === ActionKind.NONE) releasedAt[i] = -1;
      charging[i] = c;
    }
  }
  return gaps;
}

describe('QF-4 CR (QF-2): a charged kick strikes the ball after its release, not on the release tick', () => {
  it.fails('every charged foot kick makes contact at least 2 ticks after the power bar is released', () => {
    const gaps = chargedStrikeGaps(20261014, 2100);
    expect(gaps.length).toBeGreaterThan(0);
    for (const g of gaps) expect(g).toBeGreaterThanOrEqual(2);
  }, 60000);
});
