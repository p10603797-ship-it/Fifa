/**
 * [NET-06] Online session on the two-peer harness (real app session + sim, in-memory transport, virtual time):
 * a full match in sync, pause rules (3 each, 30 s cap, only the pauser resumes, simultaneous pauses, system pauses),
 * the waiting state during stalls, disconnect + rejoin within 20 s resumes in sync, a reloaded guest rejoins by code,
 * timeout -> Finish against CPU completes the match, End match, opponent quits, an unrecoverable desync ends the match,
 * rematch starts clean (stale packets of the last match never reach the new one).
 */
import { describe, expect, it } from 'vitest';
import { CPU_CONTROLLER_BASE } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { T_NET } from '../../src/contracts/tuning';
import { FRAME_INTS } from '../../src/net/packet';
import { createOnlinePair, hashState } from './net-06-harness';

const MATCH_MS = 120_000;

type Pair = ReturnType<typeof createOnlinePair>;

async function toFullTime(h: Pair): Promise<void> {
  const ok = await h.runUntil(() => h.host.session.finished && h.guest.session.finished, MATCH_MS);
  expect(ok).toBe(true);
}

function expectInSync(h: Pair): void {
  const a = h.host.state!;
  const b = h.guest.state!;
  expect(a.tick).toBe(b.tick);
  expect(hashState(a)).toBe(hashState(b));
}

describe('NET-06 online match through the app session', () => {
  it('plays a full match in lockstep: both reach full time with identical states', async () => {
    const h = createOnlinePair({ hashEvery: 60 });
    await h.startMatch();
    const setup = h.host.session.getSetup()!;
    expect(setup.inputProvider).toBe(h.host.os!.provider);
    expect(setup.bindings).toEqual([{ human: 0, deviceIds: ['*'] }]);
    expect(h.guest.session.getSetup()!.bindings).toEqual([{ human: 1, deviceIds: ['*'] }]);
    expect(setup.config.seed).toBe(h.guest.session.getSetup()!.config.seed);
    expect(setup.hooks?.allowPause).toBeTypeOf('function');
    await toFullTime(h);
    expect(h.host.state!.match.phase).toBe(MatchPhase.POST_MATCH);
    expectInSync(h);
    for (const [t, hh] of h.host.hashes) if (h.guest.hashes.has(t)) expect(h.guest.hashes.get(t)).toBe(hh);
    expect(h.host.os!.stats.desyncs + h.guest.os!.stats.desyncs).toBe(0);
    expect(h.host.os!.stats.hashesCompared).toBeGreaterThan(5);
    expect(h.host.finishes).toEqual([expect.objectContaining({ quit: false })]);
    expect(h.host.finishes[0]!.summary).not.toBeNull();
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.host.statuses).toContain('playing');
    expect(h.host.lobby.phase).toBe('lobby');
    expect(h.guest.lobby.phase).toBe('lobby');
    // Leaving the full-time screen disposes the provider after its drain.
    let drained = false;
    void h.host.os!.whenDrained().then(() => {
      drained = true;
    });
    h.host.session.quit();
    await h.run(DRAIN_WAIT);
    expect(drained).toBe(true);
    expect(h.host.errors).toEqual([]);
    expect(h.guest.errors).toEqual([]);
  }, 60_000);

  it('shows the waiting state while the other side is late, never guessing its input', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(1000);
    h.guest.alive = false; // the guest's page hangs for a second
    const t0 = h.host.state!.tick;
    await h.run(1000);
    expect(h.host.state!.tick - t0).toBeLessThanOrEqual(T_NET.delayMax + 2);
    expect(h.host.os!.status.kind).toBe('stalled');
    expect(h.host.os!.status.waitingMs).toBeGreaterThan(500);
    expect(h.host.os!.provider.waiting).toBe(true);
    h.guest.alive = true;
    await h.run(1000);
    expect(h.host.os!.status.kind).toBe('playing');
    expect(h.host.statuses).toContain('stalled');
    await toFullTime(h);
    expectInSync(h);
  }, 60_000);
});

const DRAIN_WAIT = 2500;

describe('NET-06 pause rules', () => {
  it('3 pauses each; the peer applies them as the pauser; only the pauser resumes; the 4th is refused', async () => {
    const h = createOnlinePair({ hashEvery: 30 });
    await h.startMatch();
    await h.run(500);
    for (let i = 0; i < T_NET.pausesPerPlayer; i++) {
      h.host.session.pause(0);
      expect(h.host.session.paused).toBe(true);
      await h.run(300);
      expect(h.guest.session.paused).toBe(true);
      expect(h.guest.session.pausedBy).toBe(0);
      expect(h.guest.os!.status.kind).toBe('paused');
      expect(h.guest.session.resume(1)).toBe(false); // only the pauser can resume
      expect(h.guest.session.resume(0)).toBe(false); // and not by impersonating him either
      expect(h.guest.session.paused).toBe(true);
      expect(h.host.session.resume(0)).toBe(true);
      await h.run(300);
      expect(h.guest.session.paused).toBe(false);
      await h.run(300);
    }
    expect(h.host.os!.pausesLeft).toBe(0);
    expect(h.guest.os!.pausesLeftOf).toEqual([0, 3]);
    expect(h.host.os!.pausesLeftOf).toEqual([0, 3]);
    expect((h.guest.session.getSetup()!.modeData as { pausesLeft: number[] }).pausesLeft).toEqual([0, 3]);
    h.host.session.pause(0);
    expect(h.host.session.paused).toBe(false);
    expect(h.host.notices).toContain('No pauses left');
    // A local device can never pause as the other human.
    h.guest.session.pause(0);
    expect(h.guest.session.paused).toBe(false);
    // The guest still has its three.
    h.guest.session.pause(1);
    await h.run(300);
    expect(h.host.session.pausedBy).toBe(1);
    expect(h.host.notices.some((n) => n.startsWith('Ben paused (2 left)'))).toBe(true);
    h.guest.session.resume(1);
    await toFullTime(h);
    expectInSync(h);
  }, 60_000);

  it('a pause resumes by itself after 30 s on both sides', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(500);
    h.guest.session.pause(1);
    await h.run(300);
    expect(h.host.session.pausedBy).toBe(1);
    expect(h.host.os!.status.pauseLeftMs).toBeGreaterThan(T_NET.pauseMaxMs - 1000);
    expect(h.guest.os!.status.pauseLeftMs).toBeGreaterThan(T_NET.pauseMaxMs - 1000);
    await h.run(T_NET.pauseMaxMs - 1500);
    expect(h.host.session.paused).toBe(true);
    expect(h.guest.session.paused).toBe(true);
    await h.run(1500);
    expect(h.guest.session.paused).toBe(false);
    expect(h.host.session.paused).toBe(false);
    expect(h.guest.notices).toContain('Pause time is up');
    expect(h.guest.os!.pausesLeftOf).toEqual([3, 2]);
    await h.run(1000);
    expect(h.host.os!.status.kind).toBe('playing');
  }, 60_000);

  it('two pauses at the same moment: the host\'s wins and the guest\'s is refunded', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(500);
    h.host.session.pause(0);
    h.guest.session.pause(1);
    await h.run(300);
    expect(h.host.session.pausedBy).toBe(0);
    expect(h.guest.session.pausedBy).toBe(0);
    expect(h.host.os!.pausesLeftOf).toEqual([2, 3]);
    expect(h.guest.os!.pausesLeftOf).toEqual([2, 3]);
    expect(h.host.session.resume(0)).toBe(true);
    await h.run(300);
    expect(h.guest.session.paused).toBe(false);
    await toFullTime(h);
    expectInSync(h);
  }, 60_000);

  it('system pauses stay local and never count; a friend\'s pause shows once the system pause ends', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(500);
    h.host.session.pause(-1); // page hidden / portrait
    await h.run(600);
    expect(h.guest.session.paused).toBe(false);
    expect(h.guest.os!.status.kind).toBe('stalled');
    h.guest.session.pause(1);
    await h.run(300);
    expect(h.host.session.pausedBy).toBe(-1); // still the system pause
    expect(h.host.session.resume(0)).toBe(true); // anyone lifts a system pause...
    await h.run(50);
    expect(h.host.session.paused).toBe(true); // ...and the friend's pause shows
    expect(h.host.session.pausedBy).toBe(1);
    expect(h.host.os!.pausesLeftOf).toEqual([3, 2]);
    h.guest.session.resume(1);
    await h.run(300);
    expect(h.host.session.paused).toBe(false);
    await toFullTime(h);
    expectInSync(h);
  }, 60_000);
});

describe('NET-06 disconnect, rejoin, finish against CPU', () => {
  it('disconnect + rejoin within 20 s resumes in sync', async () => {
    const h = createOnlinePair({ hashEvery: 30 });
    await h.startMatch();
    await h.run(3000);
    h.room.pair.configure({ latencyMs: 2500 }); // the link comes back slowly (two crossings: ~5 s)
    h.room.pair.sever();
    await h.run(500);
    expect(h.host.os!.status.kind).toBe('reconnecting');
    expect(h.guest.os!.status.kind).toBe('reconnecting');
    expect(h.host.os!.status.rejoinLeftMs).toBeGreaterThan(T_NET.rejoinWaitMs - 1000);
    const cut = h.host.state!.tick;
    // Pausing is refused while the link is down.
    h.host.session.pause(0);
    expect(h.host.session.paused).toBe(false);
    const back = await h.runUntil(() => h.host.os!.status.kind !== 'reconnecting' && h.guest.os!.status.kind !== 'reconnecting', 15_000);
    expect(back).toBe(true);
    h.room.pair.configure({ latencyMs: 30 });
    expect(h.host.state!.tick - cut).toBeLessThanOrEqual(T_NET.delayMax + 2);
    expect(h.host.notices).toContain('Ben is back');
    expect(h.guest.notices).toContain('Ana is back');
    await toFullTime(h);
    expectInSync(h);
    expect(h.host.os!.stats.desyncs + h.guest.os!.stats.desyncs).toBe(0);
  }, 60_000);

  it('a guest whose page reloads rejoins by code within 20 s and continues in sync from a snapshot', async () => {
    const h = createOnlinePair({ hashEvery: 30 });
    await h.startMatch();
    await h.run(4000);
    const old = h.guest;
    const fresh = h.reloadGuest();
    await h.run(300);
    expect(h.host.statuses).toContain('reconnecting');
    const ok = await h.runUntil(() => !!fresh.os && fresh.session.loaded && fresh.os.status.kind === 'playing', 15_000);
    expect(ok).toBe(true);
    expect(fresh.os!.stats.rejoins).toBe(1);
    expect(h.host.os!.stats.rejoins).toBe(1);
    expect(fresh.lobby.peer?.nickname).toBe('Ana');
    expect(fresh.state!.tick).toBeGreaterThan(200);
    expect(old.alive).toBe(false);
    await toFullTime(h);
    expectInSync(h);
    expect(h.host.os!.stats.desyncs + fresh.os!.stats.desyncs).toBe(0);
  }, 60_000);

  it('a stranger with the code cannot take the seat during a match', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(2000);
    const token = h.guest.lobby.started!.token;
    const stranger = h.reloadGuest('WRONGTOKEN00'); // a page that presents another token
    await h.run(2000);
    expect(stranger.lobby.error).toBe('room-full');
    expect(stranger.os).toBeNull();
    expect(h.host.os!.status.kind).toBe('reconnecting');
    // The refused page let go of the seat: the real guest still rejoins within the window.
    const real = h.reloadGuest(token);
    const ok = await h.runUntil(() => !!real.os && real.session.loaded && real.os.status.kind === 'playing', 10_000);
    expect(ok).toBe(true);
    expect(h.host.os!.status.kind).not.toBe('reconnecting');
  }, 60_000);

  it('no rejoin within 20 s -> opponent gone -> Finish against CPU completes the match', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(3000);
    h.guest.alive = false;
    h.guest.os!.dispose();
    h.room.pair.sever();
    await h.run(500);
    expect(h.host.os!.status.kind).toBe('reconnecting');
    expect(h.host.os!.finishAgainstCpu()).toBe(false); // not before the window is over
    await h.run(T_NET.rejoinWaitMs - 1500);
    expect(h.host.os!.status.kind).toBe('reconnecting');
    await h.run(1500);
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.status.reason).toBe('disconnected');
    expect(h.host.notices).toContain('Ben did not come back');
    expect(h.host.os!.finishAgainstCpu()).toBe(true);
    expect(h.host.os!.provider.mode).toBe('solo');
    await h.run(200);
    const s = h.host.state!;
    expect(s.ctrl[1]!.kind).not.toBe(ControllerKind.HUMAN);
    expect(s.ctrl[CPU_CONTROLLER_BASE + 1]!.kind).toBe(ControllerKind.CPU);
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.HUMAN);
    expect(h.host.os!.status.kind).toBe('solo');
    const ok = await h.runUntil(() => h.host.session.finished, MATCH_MS);
    expect(ok).toBe(true);
    expect(h.host.state!.match.phase).toBe(MatchPhase.POST_MATCH);
    expect(h.host.finishes).toEqual([expect.objectContaining({ quit: false })]);
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.host.lobby.phase).toBe('closed');
    expect(h.host.errors).toEqual([]);
  }, 60_000);

  it('the guest finishes against the CPU when the host does not come back', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(2000);
    h.host.alive = false;
    h.host.os!.dispose();
    h.room.pair.sever();
    await h.run(T_NET.rejoinWaitMs + 1000);
    expect(h.guest.os!.status.kind).toBe('opponent-gone');
    expect(h.guest.os!.finishAgainstCpu()).toBe(true);
    await h.run(200);
    const s = h.guest.state!;
    expect(s.ctrl[0]!.kind).not.toBe(ControllerKind.HUMAN);
    expect(s.ctrl[CPU_CONTROLLER_BASE]!.kind).toBe(ControllerKind.CPU);
    expect(s.ctrl[1]!.kind).toBe(ControllerKind.HUMAN);
    expect(await h.runUntil(() => h.guest.session.finished, MATCH_MS)).toBe(true);
    expect(h.guest.os!.status.kind).toBe('finished');
  }, 60_000);

  it('End match quits to the main menu and closes the room', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(2000);
    h.guest.alive = false;
    h.guest.os!.dispose();
    h.room.pair.sever();
    await h.run(T_NET.rejoinWaitMs + 500);
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    h.host.os!.endMatch();
    await h.run(1000);
    expect(h.host.session.active).toBe(false);
    expect(h.host.ctx.router.current).toBe('main');
    expect(h.host.os!.status.kind).toBe('ended');
    expect(h.host.os!.status.reason).toBe('local');
    expect(h.host.finishes).toEqual([expect.objectContaining({ quit: true })]);
    expect(h.host.lobby.phase).toBe('closed');
  }, 60_000);

  it('the opponent quitting mid-match offers the choice at once (no 20 s wait)', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(2000);
    h.guest.session.quit(); // pause menu -> Quit
    expect(h.guest.os!.status.kind).toBe('ended');
    await h.run(300);
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.status.reason).toBe('quit');
    expect(h.host.notices).toContain('Ben left the match');
    await h.run(1000);
    expect(h.guest.lobby.phase).toBe('closed');
    expect(h.host.os!.status.kind).toBe('opponent-gone');
    expect(h.host.os!.finishAgainstCpu()).toBe(true);
  }, 60_000);

  it('repeated failed resyncs end the match on both sides', async () => {
    const h = createOnlinePair();
    await h.startMatch();
    await h.run(1000);
    h.guest.onTick = (s) => {
      if (s.tick % 45 === 0) s.players[4]!.x += 0.5; // a guest that keeps drifting (a broken build)
    };
    const ok = await h.runUntil(() => h.host.os!.status.kind === 'ended' && h.guest.os!.status.kind === 'ended', 60_000);
    expect(ok).toBe(true);
    expect(h.host.os!.status.reason).toBe('desync');
    expect(h.guest.os!.status.reason).toBe('desync');
    expect(h.host.session.active).toBe(false);
    expect(h.guest.session.active).toBe(false);
  }, 60_000);
});

describe('NET-06 rematch', () => {
  it('a rematch starts clean: new seed, fresh lockstep and counters, stale packets of the last match ignored', async () => {
    const h = createOnlinePair({ hashEvery: 60 });
    await h.startMatch();
    h.host.session.pause(0);
    await h.run(300);
    h.host.session.resume(0);
    await toFullTime(h);
    expectInSync(h);
    const first = h.host.session.getSetup()!.config.seed;
    const oldOs = h.host.os!;
    const lastTick = h.host.state!.tick;
    await h.rematch();
    expect(h.host.os).not.toBe(oldOs);
    expect(h.host.session.getSetup()!.config.seed).not.toBe(first);
    expect(h.host.session.getSetup()!.config.seed).toBe(h.guest.session.getSetup()!.config.seed);
    expect(h.host.os!.pausesLeftOf).toEqual([3, 3]);
    expect(h.host.state!.tick).toBeLessThan(200);
    // A late packet and a late hash of the previous match arrive now: both are ignored.
    const data = new Int16Array(FRAME_INTS);
    data[0] = 127;
    h.room.pair.guest.sendInputs({ firstTick: lastTick - 5, count: 1, ack: lastTick, tick: lastTick, adv: 0, data });
    h.room.pair.guest.sendReliable({ type: 'ls:hash', tick: 60, hash: 12345, mt: 'm1' });
    await h.run(300);
    expect(h.host.os!.provider.lockstep!.stats.remoteAck).toBeLessThan(400);
    await toFullTime(h);
    expectInSync(h);
    expect(h.host.os!.stats.desyncs + h.guest.os!.stats.desyncs).toBe(0);
    expect(h.host.sessions).toHaveLength(2);
  }, 90_000);
});
