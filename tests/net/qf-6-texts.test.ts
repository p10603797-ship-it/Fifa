/**
 * [QF-6] Plain-language lines for the new "friend is not responding" state (online screen pill and card).
 */
import { describe, expect, it } from 'vitest';
import type { OnlineStatus } from '../../src/net/session';
import { goneTitle, statusLine } from '../../src/ui/screens/online';

const base: OnlineStatus = { kind: 'opponent-gone', waitingMs: 0, pausedBy: -1, pauseLeftMs: 0, rejoinLeftMs: 0, reason: null, opponent: 'Ben' };

describe('QF-6 online texts', () => {
  it('glitch: both sides waiting forever — the waiting side is told plainly why the choice appears', () => {
    expect(goneTitle({ ...base, reason: 'unresponsive' })).toBe('Ben is not responding');
    expect(statusLine({ ...base, reason: 'unresponsive' }, 0)).toBe('Ben is not responding');
    expect(goneTitle({ ...base, reason: 'quit' })).toBe('Ben left the match');
    expect(goneTitle({ ...base, reason: 'disconnected' })).toBe('Ben did not come back');
    expect(statusLine({ ...base, kind: 'stalled', waitingMs: 900 }, 0)).toBe('Waiting for Ben…');
  });
});
