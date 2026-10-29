/**
 * [QF-15] Final-whistle helpers on the two-peer app-session harness (net-06-harness): find the tick of the final
 * whistle (POST_MATCH) of a pair by a dry run (the harness is deterministic: virtual clock, seeded link, seeded
 * inputs), and run the same pair again with one state change on one side at a chosen tick.
 */
import { expect } from 'vitest';
import { TICK_MS } from '../../src/app/loopMath';
import type { SimState } from '../../src/contracts/state';
import { HASH_INTERVAL_TICKS } from '../../src/net/desync';
import { createOnlinePair, hashState, type PairOptions } from './net-06-harness';

export type Pair = ReturnType<typeof createOnlinePair>;

/** POST_MATCH tick of a pair with these options (both sides reach it on the same tick when nothing diverges). */
export async function finalWhistleTick(opts: PairOptions = {}): Promise<number> {
  const h = createOnlinePair(opts);
  await h.startMatch();
  expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000)).toBe(true);
  await h.run(1000); // both final hashes cross the link
  expect(h.host.state!.tick).toBe(h.guest.state!.tick);
  expect(h.host.os!.stats.finalCheck).toBe('ok');
  expect(h.guest.os!.stats.finalCheck).toBe('ok');
  return h.host.state!.tick;
}

/**
 * The last tick whose state the 30-tick exchange hashes before a final whistle at tick `post`: the lockstep hashes the
 * state of tick T when it takes tick T + 1, and nothing takes tick post + 1.
 */
export function lastHashedTick(post: number, interval: number = HASH_INTERVAL_TICKS): number {
  return Math.floor((post - 1) / interval) * interval;
}

export interface NudgeRun {
  h: Pair;
  /** Tick the change was made at (-1: never). */
  hit: number;
  /** Virtual ms from the first side's final whistle until both sides had finished (-1: not both). */
  bothFinishedAfterMs: number;
}

/**
 * Run a pair to full time with `nudge` applied on `who`'s state once, after the step of tick `at` (before the app
 * session looks at the phase), then `tailMs` more.
 */
export async function runWithNudge(opts: PairOptions, who: 'host' | 'guest', at: number, nudge: (s: SimState) => void,
  tailMs = 3000): Promise<NudgeRun> {
  const h = createOnlinePair(opts);
  await h.startMatch();
  let hit = -1;
  const peer = who === 'host' ? h.host : h.guest;
  peer.onTick = (s) => {
    if (hit < 0 && s.tick === at) {
      hit = s.tick;
      nudge(s);
    }
  };
  expect(await h.runUntil(() => h.host.session.finished || h.guest.session.finished, 120_000)).toBe(true);
  const t0 = h.clock.now();
  const both = await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 30_000);
  const bothFinishedAfterMs = both ? h.clock.now() - t0 : -1;
  await h.run(tailMs);
  return { h, hit, bothFinishedAfterMs };
}

/**
 * Like h.runUntil, but checks `pred` after every animation frame instead of every 6: for moments that last only a few
 * frames (e.g. a late side between its final mismatch and the friend's final state, one link latency later).
 */
export async function runUntilEachFrame(h: Pair, pred: () => boolean, maxMs: number): Promise<boolean> {
  const end = h.clock.now() + maxMs;
  while (h.clock.now() < end) {
    if (pred()) return true;
    await h.run(TICK_MS);
  }
  return pred();
}

/** The final verdicts agree with the final states: 'ok' on both sides exactly when both are identical. */
export function expectHonestVerdict(h: Pair): void {
  const hs = h.host.state!;
  const gs = h.guest.state!;
  const same = hs.tick === gs.tick && hashState(hs) === hashState(gs);
  const adopted = h.host.os!.stats.finalAdopted || h.guest.os!.stats.finalAdopted;
  expect(h.host.os!.stats.finalCheck).toBe(h.guest.os!.stats.finalCheck);
  expect(h.host.os!.stats.finalCheck).toBe(same && !adopted ? 'ok' : 'mismatch');
  if (h.host.os!.stats.finalCheck === 'mismatch') {
    expect(h.host.logs.some((l) => l.includes('desync at full time'))).toBe(true);
    expect(h.guest.logs.some((l) => l.includes('desync at full time'))).toBe(true);
    expect(h.host.notices.some((n) => n.includes('did not agree at the final whistle'))).toBe(true);
    expect(h.guest.notices.some((n) => n.includes('did not agree at the final whistle'))).toBe(true);
  }
}

/** Both matches ended the normal way (full-time screens, rooms open for a rematch, never "opponent gone"). */
export function expectCleanFinish(h: Pair): void {
  expect(h.host.session.finished).toBe(true);
  expect(h.guest.session.finished).toBe(true);
  expect(h.host.os!.status.kind).toBe('finished');
  expect(h.guest.os!.status.kind).toBe('finished');
  expect(h.host.lobby.phase).toBe('lobby');
  expect(h.guest.lobby.phase).toBe('lobby');
  expect(h.host.statuses).not.toContain('opponent-gone');
  expect(h.guest.statuses).not.toContain('opponent-gone');
  expect(h.host.statuses).not.toContain('ended');
  expect(h.guest.statuses).not.toContain('ended');
  expect(h.host.errors).toEqual([]);
  expect(h.guest.errors).toEqual([]);
}
