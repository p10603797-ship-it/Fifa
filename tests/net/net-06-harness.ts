/**
 * [NET-06] Two-peer harness for online session tests: each peer is a real app session (src/app/session.ts, null
 * renderer, real sim and stats) driven by a frame loop that mirrors src/app/loop.ts, with a lobby (NET-03) and an
 * online session (NET-06) on the seeded in-memory transport (src/net/memoryTransport.ts) on virtual time. Scripted
 * human inputs (tools/netsim createScriptedSource) play both humans. Never touches the network.
 */
import { beginFrame, createLoopTiming, endFrame, resetLoopTiming, TICK_MS, type LoopTiming } from '../../src/app/loopMath';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import type { AppSession } from '../../src/app/types';
import type { AppContext, DeviceRegistry, MatchSummary, Screen, ScreenId } from '../../src/contracts/app';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createLobby, type Lobby, type LobbyStart } from '../../src/net/lobby';
import {
  createManualClock, createMemoryTransportPair, type ManualClock, type MemoryLinkOptions, type MemoryTransportPair,
} from '../../src/net/memoryTransport';
import { createEmitter } from '../../src/net/packet';
import { createOnlineSession, type OnlineSession, type OnlineSessionOptions, type OnlineStatusKind } from '../../src/net/session';
import type { ControlMessage, InputPacket, NetTransport, TransportEvent } from '../../src/net/types';
import { hashState } from '../../src/sim/core/hash';
import { step } from '../../src/sim/step';
import { createScriptedSource } from '../../tools/netsim';

export const ROOM = 'NETBXX';

export interface Peer {
  idx: number;
  name: string;
  ctx: AppContext;
  session: AppSession;
  lobby: Lobby;
  os: OnlineSession | null;
  sessions: OnlineSession[];
  timing: LoopTiming;
  wasTicking: boolean;
  alive: boolean;
  statuses: OnlineStatusKind[];
  notices: string[];
  finishes: { summary: MatchSummary | null; quit: boolean }[];
  logs: string[];
  errors: unknown[];
  /** Called after every tick (tests perturb state or record hashes). */
  onTick: ((s: SimState) => void) | null;
  /** Tick -> state hash, for comparing the two peers tick by tick. */
  hashes: Map<number, number>;
  readonly state: SimState | null;
}

export interface PairOptions {
  link?: MemoryLinkOptions;
  /** Template overrides (default: 0.1-minute halves, no replays). */
  config?: Partial<MatchConfig>;
  inputs?: 'random' | 'idle';
  session?: Partial<OnlineSessionOptions>;
  /** Record a hash every N ticks (0 = off). */
  hashEvery?: number;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function fakeDevices(): DeviceRegistry {
  return {
    list: () => [], subscribe: () => () => undefined,
    createSource: () => {
      throw new Error('no devices in the harness');
    },
    lastActive: () => null,
  };
}

/** A host transport whose guest link can be replaced (a guest page that reloads dials the room again). */
export interface SwitchableHost {
  host: NetTransport;
  /** Every expectBusy(ms) the host side announced (the in-memory link itself has no silence timeout). */
  readonly busy: number[];
  readonly pair: MemoryTransportPair;
  /** The guest page reloads: the old link dies, a new guest endpoint can dial the same room. Returns it. */
  reload(): NetTransport;
}

export function createSwitchableHost(makePair: () => MemoryTransportPair): SwitchableHost {
  let pair = makePair();
  const inputs = createEmitter<InputPacket>();
  const reliable = createEmitter<ControlMessage>();
  const events = createEmitter<TransportEvent>();
  let subs: (() => void)[] = [];
  const bind = (p: MemoryTransportPair): void => {
    for (const u of subs) u();
    subs = [p.host.onInputs((x) => inputs.emit(x)), p.host.onReliable((m) => reliable.emit(m)), p.host.onEvent((e) => events.emit(e))];
  };
  bind(pair);
  const busy: number[] = [];
  const host: NetTransport = {
    get state() { return pair.host.state; },
    get role() { return pair.host.role; },
    get rtt() { return pair.host.rtt; },
    get jitter() { return pair.host.jitter; },
    open: (r, c) => pair.host.open(r, c),
    reconnect: () => pair.host.reconnect(),
    sendInputs: (p) => pair.host.sendInputs(p),
    sendReliable: (m) => pair.host.sendReliable(m),
    onInputs: (fn) => inputs.on(fn),
    onReliable: (fn) => reliable.on(fn),
    onEvent: (fn) => events.on(fn),
    close: () => pair.host.close(),
    expectBusy: (ms) => {
      busy.push(ms);
    },
  };
  return {
    host,
    busy,
    get pair() { return pair; },
    reload() {
      const old = pair;
      old.sever();
      pair = makePair();
      bind(pair);
      void pair.host.open('host', ROOM).catch(() => undefined);
      return pair.guest;
    },
  };
}

export function harnessConfig(over: Partial<MatchConfig> = {}): MatchConfig {
  const c = createMatchConfig();
  c.halfMinutes = 0.1;
  c.replaySeconds = 0;
  return { ...c, ...over };
}

export function createOnlinePair(opts: PairOptions = {}) {
  const clock: ManualClock = createManualClock(1000);
  const linkOpts: MemoryLinkOptions = { latencyMs: 30, jitterMs: 5, seed: 9, ...opts.link, now: clock.now, schedule: clock.schedule };
  const room = createSwitchableHost(() => createMemoryTransportPair(linkOpts));
  const lobbyTimers = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const sessionTimers = { now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout };
  const inputs = opts.inputs ?? 'random';
  const hashEvery = opts.hashEvery ?? 0;
  let seedCounter = 0;

  function makePeer(idx: number, transport: NetTransport, rejoinToken?: string): Peer {
    const noop = (): void => undefined;
    const peer = {} as Peer;
    const root = { appendChild: noop } as unknown as HTMLElement;
    const focus = { attach: noop, detach: noop, handle: noop, focus: noop, onAction: () => noop };
    const router = createRouter(root, () => peer.ctx ?? ({ focus } as unknown as AppContext), { listen: false, createContainer: () => ({ remove() {} }) as unknown as HTMLElement });
    for (const id of ['main', 'loading', 'match', 'half-time', 'full-time', 'online-lobby', 'recovery'] as ScreenId[]) {
      router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
    }
    router.go('main');
    const hud = { mount: noop, setMatch: noop, update: noop, onEvents: noop, setVisible: noop, dispose: noop };
    const audio = {
      unlock: () => Promise.resolve(), unlocked: true, setVolumes: noop, onEvents: noop, update: noop, playUi: noop,
      matchStart: noop, matchEnd: noop, setPaused: noop, suspend: noop, resume: noop,
    };
    const logs: string[] = [];
    const errors: unknown[] = [];
    const diagnostics = {
      log: (kind: string, message: string) => logs.push(`${kind}: ${message}`), recent: () => logs, debug: false, setDebug: noop,
      report: () => logs.join('\n'),
    };
    const devices = fakeDevices();
    const session = createSession({
      router, renderer: createNullRenderer(), hud, audio, devices, diagnostics, clubs: CLUBS, getProjector: () => null,
      yieldFrame: () => Promise.resolve(), now: clock.now, newSeed: () => ++seedCounter,
      onError: (err, where) => errors.push(`${where}: ${String(err)}`),
    });
    const ctx = { router, session, devices, diagnostics, clubs: CLUBS, focus } as unknown as AppContext;
    const lobby = createLobby({
      host: idx === 0, code: ROOM, nickname: idx === 0 ? 'Ana' : 'Ben', transport, timers: lobbyTimers, clubs: CLUBS,
      random: mulberry(77 + idx + seedCounter), startCountdownMs: 0, rejoinToken,
    });
    Object.assign(peer, {
      idx, name: idx === 0 ? 'host' : 'guest', ctx, session, lobby, os: null, sessions: [], timing: createLoopTiming(), wasTicking: false,
      alive: true, statuses: [], notices: [], finishes: [], logs, errors, onTick: null, hashes: new Map<number, number>(),
    });
    Object.defineProperty(peer, 'state', { get: () => session.getState() as SimState | null });
    lobby.onStart((start: LobbyStart) => {
      void start;
      peer.os?.dispose();
      const os = createOnlineSession(ctx, lobby, {
        localSources: [createScriptedSource(1000 + idx * 17 + lobby.started!.n, inputs)],
        timers: sessionTimers,
        onFinish: (summary, quit) => peer.finishes.push({ summary, quit }),
        ...opts.session,
      });
      os.onStatus((s) => peer.statuses.push(s.kind));
      os.onNotice((t) => peer.notices.push(t));
      peer.os = os;
      peer.sessions.push(os);
      os.start();
    });
    return peer;
  }

  const host = makePeer(0, room.host);
  let guest = makePeer(1, room.pair.guest);
  const peers = (): Peer[] => [host, guest];

  function frame(p: Peer, now: number): void {
    if (!p.alive) return;
    const rt = p.session.runtime();
    if (rt) rt.provider.pump(now);
    if (p.session.ticking && rt) {
      if (!p.wasTicking) resetLoopTiming(p.timing);
      p.wasTicking = true;
      const due = beginFrame(p.timing, now);
      let ran = 0;
      let stalled = false;
      while (ran < due) {
        const next = rt.curr.tick + 1;
        if (!rt.provider.ready(next)) {
          stalled = true;
          break;
        }
        rt.provider.take(next, rt.frames, rt.curr);
        step(rt.curr, rt.frames, rt.events);
        ran++;
        if (hashEvery > 0 && rt.curr.tick % hashEvery === 0) p.hashes.set(rt.curr.tick, hashState(rt.curr));
        p.onTick?.(rt.curr);
        rt.stats.onTick(rt.curr, rt.events);
        p.session.afterTick(rt);
        if (!p.session.ticking) break;
      }
      endFrame(p.timing, ran, stalled);
    } else {
      p.wasTicking = false;
    }
  }

  /** Run both peers for `ms` of virtual time in animation frames. */
  async function run(ms: number): Promise<void> {
    const end = clock.now() + ms;
    while (clock.now() < end) {
      clock.advance(TICK_MS);
      for (const p of peers()) frame(p, clock.now());
      await flush();
      for (let i = 0; i < 1000 && peers().some((p) => p.os?.provider.lockstep?.guard.busy); i++) await settle();
    }
  }

  async function runUntil(pred: () => boolean, maxMs: number): Promise<boolean> {
    const end = clock.now() + maxMs;
    while (clock.now() < end) {
      if (pred()) return true;
      await run(TICK_MS * 6);
    }
    return pred();
  }

  /** Lobby handshake, settings, picks and ready on both sides; resolves once both matches are loaded. */
  async function startMatch(): Promise<void> {
    await runUntil(() => host.lobby.phase === 'lobby' && guest.lobby.phase === 'lobby', 5000);
    if (!host.lobby.config) host.lobby.setConfig(harnessConfig(opts.config));
    host.lobby.setClub(0);
    guest.lobby.setClub(1);
    await run(200);
    host.lobby.setReady(true);
    guest.lobby.setReady(true);
    const ok = await runUntil(() => !!host.os && !!guest.os && host.session.loaded && guest.session.loaded, 5000);
    if (!ok) throw new Error(`match did not start: host ${host.lobby.phase} guest ${guest.lobby.phase}`);
  }

  /** Both sides ready again in the lobby (after a match): rematch. */
  async function rematch(): Promise<void> {
    host.lobby.setReady(true);
    guest.lobby.setReady(true);
    const before = [host.sessions.length, guest.sessions.length];
    const ok = await runUntil(() => host.sessions.length > before[0]! && guest.sessions.length > before[1]! && host.session.loaded &&
      guest.session.loaded, 5000);
    if (!ok) throw new Error('rematch did not start');
  }

  /** The guest page reloads: its old page stops, a fresh page joins the room with the stored token. */
  function reloadGuest(withToken?: string): Peer {
    const token = withToken ?? guest.lobby.started?.token;
    guest.alive = false;
    guest.os?.dispose();
    const t = room.reload();
    guest = makePeer(1, t, token);
    return guest;
  }

  return {
    clock, room, get host() { return host; }, get guest() { return guest; }, peers, run, runUntil, startMatch, rematch, reloadGuest,
    frame,
  };
}

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

export { hashState };
