/**
 * [NET-03] Lobby flow on the in-memory transport (never the network): hello and versions, host settings, team picks,
 * ready flags, start with identical configs on both sides, version mismatch, leave / cancel, plain-language errors,
 * timeouts, a taken code, untrusted input, rematch starts.
 */
import { describe, expect, it } from 'vitest';
import { GAME_VERSION, SIM_VERSION } from '../../src/contracts/constants';
import { ControllerKind, ModeId } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import {
  cleanNickname, createLobby, LOBBY_HELLO, LOBBY_HELLO_TIMEOUT_MS, sanitizeConfig, START_COUNTDOWN_MS, type Lobby, type LobbyError, type LobbyNotice,
  type LobbyOptions,
} from '../../src/net/lobby';
import { createManualClock, createMemoryTransportPair, type MemoryLinkOptions } from '../../src/net/memoryTransport';
import { createEmitter, netError, NET_PROTOCOL_VERSION } from '../../src/net/packet';
import type { ControlMessage, NetTransport, TransportEvent } from '../../src/net/types';

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

function setup(link: MemoryLinkOptions = {}, hostOpts: Partial<LobbyOptions> = {}, guestOpts: Partial<LobbyOptions> = {}) {
  const clock = createManualClock();
  const pair = createMemoryTransportPair({ latencyMs: 20, seed: 3, now: clock.now, schedule: clock.schedule, ...link });
  const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const host = createLobby({ host: true, code: 'ABCDEF', nickname: 'Ana', transport: pair.host, timers, random: seeded(11), clubs: CLUBS, ...hostOpts });
  const guest = createLobby({ host: false, code: 'abc-def', nickname: 'Ben', transport: pair.guest, timers, clubs: CLUBS, ...guestOpts });
  const errors: { host: LobbyError[]; guest: LobbyError[] } = { host: [], guest: [] };
  host.onError((e) => errors.host.push(e));
  guest.onError((e) => errors.guest.push(e));
  const run = async (ms: number, step = 5): Promise<void> => {
    for (let t = 0; t < ms; t += step) {
      clock.advance(step);
      await flush();
    }
  };
  return { clock, pair, host, guest, errors, run, timers };
}

function template() {
  const c = createMatchConfig();
  c.halfMinutes = 5;
  c.night = 1;
  c.offside = 0;
  return c;
}

async function bothReady(h: ReturnType<typeof setup>, homeClub = 2, awayClub = 5) {
  h.host.setConfig(template());
  h.host.setClub(homeClub);
  h.guest.setClub(awayClub);
  await h.run(100);
  h.guest.setReady(true);
  h.host.setReady(true);
}

describe('NET-03 lobby: create, join, pick, ready, start', () => {
  it('host waits with its code; the guest joins and both see each other', async () => {
    const h = setup();
    expect(h.host.phase).toBe('waiting');
    expect(h.host.code).toBe('ABCDEF');
    expect(h.guest.code).toBe('ABCDEF');
    expect(h.guest.phase).toBe('connecting');
    const notes: LobbyNotice[] = [];
    h.host.onNotice((n) => notes.push(n));
    await h.run(200);
    expect(h.host.phase).toBe('lobby');
    expect(h.guest.phase).toBe('lobby');
    expect(h.host.peer?.nickname).toBe('Ben');
    expect(h.guest.peer?.nickname).toBe('Ana');
    expect(notes).toContainEqual({ kind: 'peer-joined', nickname: 'Ben' });
    expect(h.errors).toEqual({ host: [], guest: [] });
  });

  it('host settings and team picks reach the other side; the guest cannot change the settings', async () => {
    const h = setup();
    await h.run(200);
    h.host.setConfig(template());
    h.host.setClub(3);
    h.guest.setClub(7);
    await h.run(100);
    expect(h.guest.config?.halfMinutes).toBe(5);
    expect(h.guest.config?.night).toBe(1);
    expect(h.host.peer?.club).toBe(7);
    expect(h.guest.peer?.club).toBe(3);
    const c = template();
    c.halfMinutes = 9;
    h.guest.setConfig(c);
    await h.run(100);
    expect(h.host.config?.halfMinutes).toBe(5);
    expect(h.guest.config?.halfMinutes).toBe(5);
  });

  it('both ready -> start with identical configs (host home, guest away, seed, delay, token)', async () => {
    const h = setup();
    await h.run(1200); // a few pings: the start delay comes from the measured round trip
    const hs = h.host.waitForStart();
    const gs = h.guest.waitForStart();
    await bothReady(h, 2, 5);
    await h.run(1200);
    const [a, b] = await Promise.all([hs, gs]);
    expect(a.config).toEqual(b.config);
    expect(a.localSide).toBe(0);
    expect(b.localSide).toBe(1);
    expect(a.transport).toBe(h.pair.host);
    expect(b.transport).toBe(h.pair.guest);
    expect(a.config.mode).toBe(ModeId.FRIEND_ONLINE);
    expect(a.config.homeClub).toBe(2);
    expect(a.config.awayClub).toBe(5);
    expect(a.config.homeFormation).toBe(CLUBS[2]!.formation);
    expect(a.config.awayFormation).toBe(CLUBS[5]!.formation);
    expect(a.config.humans.map((x) => [x.kind, x.side])).toEqual([[ControllerKind.HUMAN, 0], [ControllerKind.HUMAN, 1]]);
    expect(a.config.halfMinutes).toBe(5);
    expect(a.config.offside).toBe(0);
    expect(h.host.started?.delay).toBe(h.guest.started?.delay);
    expect(h.host.started?.delay).toBeGreaterThanOrEqual(2);
    expect(h.host.started?.delay).toBeLessThanOrEqual(8);
    expect(h.host.started?.token).toBe(h.guest.started?.token);
    expect(h.host.started?.token).toHaveLength(12);
    expect(h.host.phase).toBe('playing');
    expect(h.guest.phase).toBe('playing');
  });

  it('carries each player\'s own controller preferences into the config', async () => {
    const h = setup({}, { prefs: { assist: 2, autoSwitch: 0, fastPower: 1 } }, { prefs: { assist: 1, autoSwitch: 2, fastPower: 0 } });
    await h.run(200);
    const gs = h.guest.waitForStart();
    await bothReady(h);
    await h.run(1200);
    const s = await gs;
    expect([s.config.humans[0]!.assist, s.config.humans[0]!.autoSwitch, s.config.humans[0]!.fastPower]).toEqual([2, 0, 1]);
    expect([s.config.humans[1]!.assist, s.config.humans[1]!.autoSwitch, s.config.humans[1]!.fastPower]).toEqual([1, 2, 0]);
  });

  it('does not start until both are ready with a club; un-ready cancels', async () => {
    const h = setup();
    await h.run(200);
    let started = 0;
    h.host.onStart(() => started++);
    h.host.setReady(true); // no club yet: refused
    expect(h.host.self.ready).toBe(false);
    h.host.setClub(1);
    h.host.setReady(true);
    await h.run(100);
    expect(started).toBe(0);
    h.guest.setClub(4);
    h.guest.setReady(true);
    await h.run(100);
    expect(h.host.starting).toBe(true);
    expect(h.guest.starting).toBe(true);
    h.guest.setReady(false); // within the start countdown: cancels
    await h.run(1500);
    expect(started).toBe(0);
    expect(h.host.peer?.ready).toBe(false);
    expect(h.host.starting).toBe(false);
    h.guest.setReady(true);
    await h.run(START_COUNTDOWN_MS - 200);
    expect(started).toBe(0);
    await h.run(400);
    expect(started).toBe(1);
  });

  it('rematch: matchEnded() clears the ready flags; the next start has a new seed and n = 2', async () => {
    const h = setup();
    await h.run(200);
    await bothReady(h);
    await h.run(1200);
    const first = h.guest.started!;
    h.host.matchEnded();
    h.guest.matchEnded();
    expect(h.host.phase).toBe('lobby');
    expect(h.host.self.ready).toBe(false);
    await h.run(100);
    expect(h.host.peer?.ready).toBe(false);
    const next = h.guest.waitForStart();
    h.host.setReady(true);
    h.guest.setReady(true);
    await h.run(1200);
    const second = await next;
    expect(h.guest.started!.n).toBe(2);
    expect(first.n).toBe(1);
    expect(second.config.seed).not.toBe(first.config.seed);
    expect(h.host.started!.config).toEqual(second.config);
  });
});

describe('NET-03 lobby: errors and leaving', () => {
  it('version mismatch (transport handshake) -> both lobbies show version-mismatch', async () => {
    const h = setup({ hostVersion: 'a', guestVersion: 'b' });
    const ws = h.guest.waitForStart();
    await h.run(200);
    expect(h.errors.guest).toEqual(['version-mismatch']);
    expect(h.guest.phase).toBe('error');
    expect(h.guest.error).toBe('version-mismatch');
    expect(h.errors.host).toEqual(['version-mismatch']);
    await expect(ws).rejects.toThrow('version-mismatch');
  });

  it('version mismatch in the lobby hello (GAME_VERSION / SIM_VERSION) -> version-mismatch', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 10, now: clock.now, schedule: clock.schedule });
    const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    const host = createLobby({ host: true, code: 'ABCDEF', nickname: 'Ana', transport: pair.host, timers });
    const errs: LobbyError[] = [];
    host.onError((e) => errs.push(e));
    void pair.guest.open('guest', 'ABCDEF');
    for (let i = 0; i < 20; i++) {
      clock.advance(5);
      await flush();
    }
    pair.guest.sendReliable({ type: LOBBY_HELLO, nick: 'Old', game: '0.0.1', sim: SIM_VERSION, net: NET_PROTOCOL_VERSION });
    for (let i = 0; i < 20; i++) {
      clock.advance(5);
      await flush();
    }
    expect(errs).toEqual(['version-mismatch']);
    expect(GAME_VERSION).not.toBe('0.0.1');
  });

  it('code not found, room full, broker unreachable, blocked: plain reasons from the transport', async () => {
    const h = setup({}, {}, { code: 'ZZZZZZ' });
    await h.run(200);
    expect(h.errors.guest).toEqual(['code-not-found']);
    for (const reason of ['room-full', 'broker-unreachable', 'blocked', 'unsupported'] as const) {
      const x = setup({ guestOpenError: reason });
      await x.run(200);
      expect(x.errors.guest).toEqual([reason]);
      expect(x.guest.error).toBe(reason);
    }
  });

  it('guest leaves -> host back to waiting (room stays open) and a new join works', async () => {
    const h = setup();
    await h.run(200);
    const notes: LobbyNotice[] = [];
    h.host.onNotice((n) => notes.push(n));
    h.guest.leave();
    expect(h.guest.phase).toBe('closed');
    await h.run(200);
    expect(h.host.phase).toBe('waiting');
    expect(h.host.peer).toBeNull();
    expect(notes).toContainEqual({ kind: 'peer-left' });
    expect(h.errors.host).toEqual([]);
    // The same endpoint dials again (a friend re-joining the open room).
    void h.pair.guest.reconnect().catch(() => undefined);
    expect(h.pair.host.state).toBe('connecting');
  });

  it('host leaves -> the guest gets a plain disconnected error; waitForStart rejects', async () => {
    const h = setup();
    await h.run(200);
    const ws = h.guest.waitForStart();
    h.host.leave();
    await h.run(200);
    expect(h.errors.guest).toEqual(['disconnected']);
    await expect(ws).rejects.toThrow('disconnected');
  });

  it('no hello from the other side within the timeout -> disconnected', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 10, now: clock.now, schedule: clock.schedule });
    void pair.host.open('host', 'ABCDEF'); // a host page without a lobby (never says hello)
    const timers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
    const guest = createLobby({ host: false, code: 'ABCDEF', nickname: 'Ben', transport: pair.guest, timers });
    const errs: LobbyError[] = [];
    guest.onError((e) => errs.push(e));
    for (let t = 0; t < LOBBY_HELLO_TIMEOUT_MS - 500; t += 50) {
      clock.advance(50);
      await flush();
    }
    expect(errs).toEqual([]);
    for (let t = 0; t < 1000; t += 50) {
      clock.advance(50);
      await flush();
    }
    expect(errs).toEqual(['disconnected']);
  });

  it('host: a taken code is replaced by a new one automatically', async () => {
    const opened: string[] = [];
    let n = 0;
    const fake = (fail: boolean): NetTransport => {
      const ev = createEmitter<TransportEvent>();
      const rel = createEmitter<ControlMessage>();
      return {
        state: 'idle', role: null, rtt: 0, jitter: 0,
        open: (_r, code) => {
          opened.push(code);
          return fail ? Promise.reject(netError('code-taken')) : new Promise<void>(() => undefined);
        },
        reconnect: () => Promise.resolve(), sendInputs() {}, sendReliable() {},
        onInputs: () => () => undefined, onReliable: (fn) => rel.on(fn), onEvent: (fn) => ev.on(fn), close() {},
      };
    };
    const lobby = createLobby({ host: true, nickname: 'Ana', random: seeded(5), createTransport: () => fake(n++ === 0) });
    const first = lobby.code;
    await flush();
    await flush();
    expect(opened).toHaveLength(2);
    expect(opened[0]).toBe(first);
    expect(lobby.code).not.toBe(first);
    expect(opened[1]).toBe(lobby.code);
    expect(lobby.phase).toBe('waiting');
    expect(lobby.error).toBeNull();
  });

  it('host with a fixed code reports code-taken', async () => {
    const lobby = createLobby({
      host: true, nickname: 'Ana', code: 'ABCDEF',
      transport: {
        state: 'idle', role: null, rtt: 0, jitter: 0, open: () => Promise.reject(netError('code-taken')),
        reconnect: () => Promise.resolve(), sendInputs() {}, sendReliable() {}, onInputs: () => () => undefined,
        onReliable: () => () => undefined, onEvent: () => () => undefined, close() {},
      },
    });
    const errs: LobbyError[] = [];
    lobby.onError((e) => errs.push(e));
    await flush();
    expect(errs).toEqual(['code-taken']);
  });

  it('a guest needs a valid code', () => {
    expect(() => createLobby({ host: false, nickname: 'x', code: 'NOPE' })).toThrow(RangeError);
    expect(() => createLobby({ host: false, nickname: 'x' })).toThrow(RangeError);
  });
});

describe('NET-03 lobby: untrusted input', () => {
  it('sanitizeConfig accepts a real config and rejects malformed ones', () => {
    const c = createMatchConfig();
    const ok = sanitizeConfig(JSON.parse(JSON.stringify(c)), CLUBS.length);
    expect(ok).toEqual(c);
    expect(ok).not.toBe(c);
    const bad: unknown[] = [
      null, 42, {}, { ...c, seed: -1 }, { ...c, seed: 1.5 }, { ...c, homeClub: CLUBS.length }, { ...c, halfMinutes: 0 },
      { ...c, halfMinutes: 99 }, { ...c, night: 2 }, { ...c, humans: [] }, { ...c, humans: [c.humans[0], { kind: 9, side: 0 }] },
      { ...c, difficulty: 'hard' }, { ...c, replaySeconds: 60 }, { ...c, offside: Number.NaN },
    ];
    for (const b of bad) expect(sanitizeConfig(b, CLUBS.length)).toBeNull();
  });

  it('nicknames are trimmed, stripped of control characters and capped', () => {
    expect(cleanNickname('  Ana  ')).toBe('Ana');
    expect(cleanNickname(`A${String.fromCharCode(0)}n${String.fromCharCode(0x202e)}a`)).toBe('Ana');
    expect(cleanNickname('x'.repeat(40))).toHaveLength(16);
    expect(cleanNickname('', 'Guest')).toBe('Guest');
    expect(cleanNickname(7, 'Guest')).toBe('Guest');
  });

  it('a club index out of range from the other side is ignored; a bad start config is a version mismatch', async () => {
    const h = setup();
    await h.run(200);
    h.pair.guest.sendReliable({ type: 'lobby:state', club: 9999, ready: true });
    await h.run(100);
    expect(h.host.peer?.club).toBe(-1);
    h.pair.host.sendReliable({ type: 'lobby:start', config: { seed: 'x' }, delay: 3, token: 't', n: 1 });
    await h.run(100);
    expect(h.errors.guest).toEqual(['version-mismatch']);
  });
});

/** Keep the type import used. */
export type _L = Lobby;
