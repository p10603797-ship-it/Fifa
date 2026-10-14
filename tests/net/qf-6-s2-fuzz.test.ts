/**
 * [QF-6, second pass] Hostile or garbled control traffic (the first pass fuzzed input packets only): random messages of
 * every namespace with random field values, delivered to a guest in a running match. No handler (lobby, session,
 * lockstep, delay agreement, desync guard) may throw, and the match must not be ended or knocked out of step by
 * messages that are not well-formed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlMessage } from '../../src/net/types';
import { createOnlinePair, hashState } from './net-06-harness';

const TYPES = [
  'lobby:hello', 'lobby:state', 'lobby:config', 'lobby:leave', 'lobby:reject', 'lobby:x',
  'session:pause', 'session:resume', 'session:sync', 'session:final', 'session:x',
  'ls:hash', 'ls:snap', 'ls:snap-ok', 'ls:delay', 'ls:target', 'ls:x', 'x', '',
];
const FIELDS = ['human', 'used', 'paused', 'tick', 'h', 'e', 'z', 'i', 'n', 'codec', 'data', 'delay', 'at', 'target', 'mt',
  'club', 'ready', 'prefs', 'nick', 'game', 'sim', 'net', 'token', 'config', 'reason', 'withdrawn', 're', 'ok', 'seed'];

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function value(r: () => number): unknown {
  const k = Math.floor(r() * 12);
  switch (k) {
    case 0: return null;
    case 1: return -1;
    case 2: return 1e300;
    case 3: return Math.floor(r() * 4000);
    case 4: return 0.5;
    case 5: return 'm1';
    case 6: return 'x'.repeat(Math.floor(r() * 40));
    case 7: return [1, 'a', null];
    case 8: return { a: 1 };
    case 9: return true;
    case 10: return 'json';
    default: return Math.floor(r() * 3) - 1;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QF-6 second pass: hostile control messages', () => {
  it('2,000 random control messages into a running match: nothing throws, the match stays in step', async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    const h = createOnlinePair({ config: { halfMinutes: 0.2 } });
    await h.startMatch();
    await h.run(1500);
    const r = mulberry(4242);
    // Messages that are well-formed and legitimately change the match (a real pause, a valid lobby leave mid-match,
    // a valid resync from the host) are left out: this is about garbage, not about a hostile host's valid orders.
    const legit = (m: ControlMessage): boolean =>
      (m.type === 'session:pause' && m.human === 0) || m.type === 'lobby:leave' || m.type === 'lobby:reject' ||
      (m.type === 'session:resume' && m.human === 0);
    let sent = 0;
    for (let round = 0; round < 40; round++) {
      for (let k = 0; k < 50; k++) {
        const m: ControlMessage = { type: TYPES[Math.floor(r() * TYPES.length)]! };
        const nf = Math.floor(r() * 6);
        for (let f = 0; f < nf; f++) m[FIELDS[Math.floor(r() * FIELDS.length)]!] = value(r);
        if (legit(m)) continue;
        h.room.pair.host.sendReliable(m);
        sent++;
      }
      await h.run(100);
    }
    expect(sent).toBeGreaterThan(1500);
    await h.run(1000);
    expect(errors).toEqual([]);
    expect(h.guest.errors).toEqual([]);
    expect(h.host.errors).toEqual([]);
    expect(h.guest.os!.status.kind).not.toBe('ended');
    expect(h.guest.lobby.phase).toBe('playing');
    const ok = await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000);
    expect(ok).toBe(true);
    expect(h.host.state!.tick).toBe(h.guest.state!.tick);
    expect(hashState(h.host.state!)).toBe(hashState(h.guest.state!));
    expect(errors).toEqual([]);
  }, 150_000);
});
