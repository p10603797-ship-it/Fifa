/**
 * [NET-07] Plain-language texts of the online screens (pure parts of src/ui/screens/online.ts): one title and body per
 * failure (brief section 11: "Every failure has a plain-language screen"), the status pill lines, the privacy line,
 * the share-link room on boot. The screens themselves are covered by tests/e2e/net-07-online.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import type { LobbyError } from '../../src/net/lobby';
import type { OnlineStatus } from '../../src/net/session';
import { errorText, ONLINE_ERROR_TEXT, PRIVACY_LINE, shareLinkRoom, statusLine } from '../../src/ui/screens/online';

const REASONS: LobbyError[] = ['broker-unreachable', 'code-not-found', 'room-full', 'version-mismatch', 'blocked', 'disconnected', 'code-taken', 'unsupported'];

function st(over: Partial<OnlineStatus>): OnlineStatus {
  return { kind: 'playing', waitingMs: 0, pausedBy: -1, pauseLeftMs: 0, rejoinLeftMs: 0, reason: null, opponent: 'Ben', ...over };
}

describe('NET-07 plain-language texts', () => {
  it('every failure has its own title and a sentence; none mention internal codes', () => {
    const titles = new Set<string>();
    for (const r of REASONS) {
      const t = errorText(r);
      expect(t.title.length).toBeGreaterThan(5);
      expect(t.body).toMatch(/\.$/);
      expect(`${t.title} ${t.body}`).not.toMatch(/peer-unavailable|ICE|WebRTC|broker-unreachable|null|undefined/);
      titles.add(t.title);
    }
    expect(titles.size).toBe(REASONS.length);
    expect(Object.keys(ONLINE_ERROR_TEXT).sort()).toEqual([...REASONS].sort());
    expect(errorText('blocked').body).toMatch(/same Wi-Fi/);
    expect(errorText('blocked').body).toMatch(/hotspot/);
    expect(errorText('nonsense' as LobbyError)).toEqual(errorText('disconnected'));
  });

  it('the privacy line says what is sent and that the IP address is visible', () => {
    expect(PRIVACY_LINE).toMatch(/IP address/);
    expect(PRIVACY_LINE).toMatch(/nickname and game inputs/);
    expect(PRIVACY_LINE).toMatch(/No chat, no accounts/);
  });

  it('status pill lines for stalls, reconnecting, pauses and the end of the friend', () => {
    expect(statusLine(st({ kind: 'playing' }), 0)).toBe('');
    expect(statusLine(st({ kind: 'stalled', waitingMs: 400 }), 0)).toBe('Waiting for Ben…');
    expect(statusLine(st({ kind: 'reconnecting', rejoinLeftMs: 16_200 }), 0)).toBe('Connection lost · waiting for Ben to rejoin · 17 s');
    expect(statusLine(st({ kind: 'paused', pausedBy: 1, pauseLeftMs: 23_000 }), 0)).toBe('Ben paused · resumes in 23 s');
    expect(statusLine(st({ kind: 'paused', pausedBy: 0, pauseLeftMs: 9_500 }), 0)).toBe('You paused · 10 s left');
    expect(statusLine(st({ kind: 'paused', pausedBy: -1 }), 0)).toBe('');
    expect(statusLine(st({ kind: 'opponent-gone', reason: 'quit' }), 0)).toBe('Ben left the match');
    expect(statusLine(st({ kind: 'opponent-gone', reason: 'disconnected' }), 0)).toBe('Ben did not come back');
    expect(statusLine(st({ kind: 'solo' }), 0)).toBe('Finishing against the CPU');
    expect(statusLine(st({ kind: 'finished' }), 0)).toBe('');
  });

  it('reads the room code of a share link on boot', () => {
    expect(shareLinkRoom('https://dotkick.app/?room=KQZ7MP')).toBe('KQZ7MP');
    expect(shareLinkRoom('https://dotkick.app/')).toBeNull();
  });
});
