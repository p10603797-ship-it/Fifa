/**
 * [QF-6] Online session defects (two real app sessions on the in-memory link, virtual time; tests/net/net-06-harness):
 *  - both sides waiting forever: a friend whose game is held with the link up (system pause, portrait, a page stuck
 *    loading) -> after the rejoin window the waiting side gets Finish against CPU / End match, cleared if frames return;
 *  - the friend resumes (or its pause cap ends) while this page is hidden: this side must not stay in the friend's
 *    pause for good;
 *  - a guest that paused and then reloaded does not leave the host in that pause;
 *  - full time reached while the link is down: the lobby returns to the room (a rematch stays possible);
 *  - quitting the full-time screen tells the online screen (onFinish quit = true), so the room is left on Quit.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { T_NET } from '../../src/contracts/tuning';
import { createOnlinePair, hashState } from './net-06-harness';

type Pair = ReturnType<typeof createOnlinePair>;

const MATCH_MS = 120_000;

async function toFullTime(h: Pair): Promise<void> {
  const ok = await h.runUntil(() => h.host.session.finished && h.guest.session.finished, MATCH_MS);
  expect(ok).toBe(true);
}

function expectInSync(h: Pair): void {
  expect(h.host.state!.tick).toBe(h.guest.state!.tick);
  expect(hashState(h.host.state!)).toBe(hashState(h.guest.state!));
}

describe('QF-6 both sides waiting forever', () => {
  it('glitch: both sides waiting forever — the friend\'s game is held with the link up: after 20 s Finish against CPU is offered, and play goes on if the friend returns', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(1500);
    h.guest.session.setBlocked(true); // portrait lock on the friend's iPad: a system pause there, the link stays up
    await h.run(3000);
    expect(h.host.os!.status.kind).toBe('stalled');
    await h.run(T_NET.rejoinWaitMs - 4000);
    expect(h.host.os!.status.kind).toBe('stalled');
    await h.run(2000);
    // was: 'stalled' for ever, with no way out but the pause menu
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.status.reason).toBe('unresponsive');
    expect(h.host.notices).toContain('Ben is not responding');
    // The friend comes back: the choice disappears by itself and both play on in sync.
    h.guest.session.setBlocked(false);
    expect(h.guest.session.resume(1)).toBe(true);
    await h.run(1000);
    expect(h.host.os!.status.kind).toBe('playing');
    expect(h.host.notices).toContain('Ben is back');
    expect(h.guest.os!.status.kind).toBe('playing');
    // Held again: this time the host finishes against the CPU, and the friend is told at once.
    h.guest.session.setBlocked(true);
    await h.run(T_NET.rejoinWaitMs + 1500);
    expect(h.host.os!.status.reason).toBe('unresponsive');
    expect(h.host.os!.finishAgainstCpu()).toBe(true);
    await h.run(500);
    expect(h.guest.os!.status.kind).toBe('opponent-gone');
    expect(h.guest.os!.status.reason).toBe('quit');
    expect(await h.runUntil(() => h.host.session.finished, MATCH_MS)).toBe(true);
    expect(h.host.state!.match.phase).toBe(MatchPhase.POST_MATCH);
    expect(h.host.errors).toEqual([]);
  }, 90_000);

  it('glitch: both sides waiting forever — a friend whose page never gets past loading: the host gets the choice after the start window', async () => {
    const h = createOnlinePair();
    h.guest.lobby.onStart(() => {
      h.guest.alive = false; // its page hangs right after the start (the link and its pings stay up)
    });
    await h.startMatch();
    await h.run(30_000);
    expect(h.host.os!.status.kind).toBe('stalled'); // the friend may still be loading: not yet
    expect(h.host.state!.tick).toBeLessThanOrEqual(T_NET.delayMax);
    await h.run(16_000);
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.status.reason).toBe('unresponsive');
    h.host.os!.endMatch();
    await h.run(800);
    expect(h.host.session.active).toBe(false);
    expect(h.host.os!.status.kind).toBe('ended');
    expect(h.host.lobby.phase).toBe('closed');
  }, 90_000);

  it('glitch: both sides waiting forever — the friend resumes while this page is hidden: back on a system pause, never stuck in the friend\'s pause', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(800);
    h.guest.session.pause(1);
    await h.run(300);
    expect(h.host.session.pausedBy).toBe(1);
    h.host.session.setHidden(true); // the host switches apps during the friend's pause
    await h.run(500);
    expect(h.guest.session.resume(1)).toBe(true);
    await h.run(T_NET.pauseMaxMs + 5000); // the friend's pause and its cap both end while the host is away
    expect(h.host.session.paused).toBe(true);
    h.host.session.setHidden(false);
    await h.run(200);
    // was: still paused by Ben, whom only Ben could resume -> the host could never play again
    expect(h.host.session.paused).toBe(true);
    expect(h.host.session.pausedBy).toBe(-1);
    expect(h.host.os!.status.kind).toBe('paused');
    expect(h.host.os!.pausesLeftOf).toEqual([3, 2]); // a system pause never counts
    expect(h.host.session.resume(0)).toBe(true);
    await h.run(1500);
    expect(h.host.os!.status.kind).toBe('playing');
    expect(h.guest.os!.status.kind).toBe('playing');
    await toFullTime(h);
    expectInSync(h);
  }, 90_000);

  it('a guest that paused and then reloaded does not leave the host in that pause', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(3000);
    h.guest.session.pause(1);
    await h.run(300);
    expect(h.host.session.pausedBy).toBe(1);
    const fresh = h.reloadGuest();
    const ok = await h.runUntil(() => !!fresh.os && fresh.session.loaded && fresh.os.status.kind !== 'starting', 15_000);
    expect(ok).toBe(true);
    await h.run(1000);
    // was: the host stayed in the dead page's pause until its 30 s cap while the new page waited
    expect(h.host.session.paused).toBe(false);
    expect(h.host.os!.status.kind).toBe('playing');
    expect(fresh.os!.status.kind).toBe('playing');
    await toFullTime(h);
    expectInSync(h);
  }, 90_000);
});

describe('QF-6 full time and the room', () => {
  it('glitch: both sides waiting forever — full time reached while the link is down: the link and the lobby come back, a rematch starts', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    let cut = false;
    h.host.onTick = (s) => {
      if (!cut && s.match.phase === MatchPhase.POST_MATCH) {
        cut = true;
        h.guest.alive = false; // the guest's page is away for its last ticks
      }
    };
    expect(await h.runUntil(() => cut, MATCH_MS)).toBe(true);
    await h.run(200);
    h.room.pair.sever(); // ... and the link drops meanwhile
    await h.run(300);
    h.guest.alive = true;
    expect(await h.runUntil(() => h.guest.session.finished, 15_000)).toBe(true);
    await h.run(3000);
    expectInSync(h);
    // was: the guest finished "disconnected", its lobby stayed in 'playing' for good: no rematch, nothing to tap
    expect(h.guest.lobby.phase).toBe('lobby');
    expect(h.host.lobby.phase).toBe('lobby');
    expect(h.guest.os!.status.kind).toBe('finished');
    await h.rematch();
    expect(h.host.sessions).toHaveLength(2);
    expect(h.host.os!.status.kind).not.toBe('finished');
  }, 120_000);

  it('glitch: both sides waiting forever — full time reached alone after the host vanished: the lobby leaves "playing" when the window ends', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    let cut = false;
    h.host.onTick = (s) => {
      if (!cut && s.match.phase === MatchPhase.POST_MATCH) {
        cut = true;
        h.guest.alive = false;
      }
    };
    expect(await h.runUntil(() => cut, MATCH_MS)).toBe(true);
    await h.run(200); // the host's last frames reach the guest
    h.host.alive = false;
    h.room.pair.host.close(); // the host's page is gone for good
    await h.run(300);
    h.guest.alive = true;
    expect(await h.runUntil(() => h.guest.session.finished, 15_000)).toBe(true);
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.guest.lobby.phase).toBe('playing'); // still re-dialling: the host might need our last frames
    await h.run(T_NET.rejoinWaitMs + 1000);
    expect(h.guest.lobby.phase).toBe('error');
    expect(h.guest.lobby.error).toBe('disconnected');
  }, 120_000);

  it('quitting the full-time screen tells the online screen once (onFinish quit = true)', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await toFullTime(h);
    expect(h.host.finishes).toEqual([expect.objectContaining({ quit: false })]);
    h.host.session.quit();
    // was: nothing (onFinish is called once by the app session), so Quit at full time left the room open behind the
    // main menu and the friend waited in the lobby for good
    expect(h.host.finishes).toHaveLength(2);
    expect(h.host.finishes[1]).toEqual(expect.objectContaining({ quit: true }));
    expect(h.host.finishes[1]!.summary).toEqual(h.host.finishes[0]!.summary);
    h.host.session.quit();
    expect(h.host.finishes).toHaveLength(2);
  }, 90_000);
});
