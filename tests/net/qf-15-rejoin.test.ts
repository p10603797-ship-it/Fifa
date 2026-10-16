/**
 * [QF-15] Disconnects around the final whistle (QA-42): a guest page that reloads after the host reached full time
 * while the old link was down. The host's lobby was still 'playing' (it keeps the match open for the rejoin window in
 * case the friend needs its last frames), so the new page's hello became a mid-match rejoin request that the finished
 * session refused silently: the new page failed with 'disconnected' (no hello) and "Try again" failed the same way
 * for the whole 20 s window. Now the finished host goes back to the room on that request and the new page joins it.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { createOnlinePair } from './net-06-harness';

describe('QF-15 rejoin after full time', () => {
  it('a guest page that reloads after the host reached full time with the link down joins the room at once and can rematch', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    expect(await h.runUntil(() => h.host.state!.match.phase === MatchPhase.FULL_TIME && h.host.state!.match.phaseT >= 88, 120_000)).toBe(true);
    h.room.pair.sever(); // the guest's page dies a moment before the final whistle; the host still holds enough frames
    expect(await h.runUntil(() => h.host.session.finished, 5000)).toBe(true);
    expect(h.host.lobby.phase).toBe('playing'); // the match stays open for the rejoin window
    const token = h.guest.lobby.started!.token;
    const g = h.reloadGuest(token);
    await h.run(3000); // well inside the 20 s window
    expect(g.lobby.phase).toBe('lobby'); // was: 'error' (disconnected)
    expect(g.lobby.error).toBeNull();
    expect(g.lobby.peer?.nickname).toBe('Ana');
    expect(h.host.lobby.phase).toBe('lobby');
    expect(h.host.lobby.peer?.nickname).toBe('Ben');
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.host.logs.some((l) => l.includes('reloaded after full time'))).toBe(true);
    // Rematch from there: both pick and ready up, a new match starts on both pages.
    g.lobby.setClub(1);
    await h.run(300);
    await h.rematch();
    expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000)).toBe(true);
    await h.run(500);
    expect(h.host.state!.tick).toBe(h.guest.state!.tick);
    expect(h.host.os!.stats.finalCheck).toBe('ok');
    expect(h.guest.os!.stats.finalCheck).toBe('ok');
  }, 120_000);

  it('a stranger (no token) still cannot take over the room of a finished match whose rejoin window is open', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    expect(await h.runUntil(() => h.host.state!.match.phase === MatchPhase.FULL_TIME && h.host.state!.match.phaseT >= 88, 120_000)).toBe(true);
    h.room.pair.sever();
    expect(await h.runUntil(() => h.host.session.finished, 5000)).toBe(true);
    const g = h.reloadGuest('not-the-token');
    await h.run(3000);
    expect(g.lobby.phase).not.toBe('lobby');
    expect(h.host.lobby.phase).toBe('playing');
  }, 120_000);
});
