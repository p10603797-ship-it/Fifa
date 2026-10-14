/**
 * [NET-06] Online match session: one match of online 1v1 on top of the lobby (NET-03), the lockstep provider
 * (NET-01, -04, -05) and the app session (contracts/app.ts SessionControl). Brief section 11: "Pausing: 3 pauses each,
 * capped at 30 s. On a disconnect, wait 20 s for a rejoin, then offer the remaining player Finish against CPU or End
 * Match."; a rematch never starts with stale state. Nothing outside src/net imports this except the online screen
 * (NET-07); local play works with src/net removed.
 *
 *   const os = createOnlineSession(ctx, lobby);      // after lobby.waitForStart()
 *   os.start();                                      // ctx.session.start(os.setup()) (+ a rejoin's pause state)
 *   os.onStatus((s) => ...)                          // 'playing' | 'stalled' | 'paused' | 'reconnecting' | ...
 *   os.finishAgainstCpu() / os.endMatch()            // after the 20 s rejoin window ('opponent-gone')
 *
 * Setup: config from the lobby start (same seed both sides), bindings = the local human on every local device
 * (ANY_DEVICE), inputProvider = an OnlineInputProvider wrapping createLockstepProvider({ transport, localHuman:
 * isHost ? 0 : 1, delay: the host's start delay, firstTick 1 }), hooks = the pause rules below, modeData =
 * { kind: 'online', session, pausesLeft: [p1, p2] } (the pause menu shows the counters).
 *
 * Pause (MatchHooks, D-021): either human may pause, 3 times each (T_NET.pausesPerPlayer). A local pause is counted and
 * sent as 'session:pause' { human, used }; the peer applies it with ctx.session.pause(remoteHuman). Only the pauser
 * resumes early ('session:resume'); after 30 s (T_NET.pauseMaxMs) the pauser's side resumes by itself and the other
 * side does the same 2 s later should that message never come. Two pauses at once: the host's wins and the guest's
 * is refunded. System pauses (hidden page, portrait) stay local and never count. During a lockstep pause the sims stop
 * a few ticks apart, which is harmless: frames are indexed by tick.
 *
 * Disconnect: the transport's 'disconnected' starts a 20 s window (T_NET.rejoinWaitMs) in which the guest re-dials and
 * the host listens; the sim simply holds (no frames). When both channels are back each side sends 'session:sync'
 * (pause state and counters) and play continues from the frames both still hold. A guest whose page reloaded
 * rejoins by code: its lobby says hello with the match token, the host restarts the lockstep at its current tick and
 * sends a snapshot in a rejoin start; the new page hard-syncs to it on its first tick. After 20 s the status becomes
 * 'opponent-gone' (also at once when the opponent quits): finishAgainstCpu() hands the absent human to the CPU with
 * Command.HAND_TO_CPU in his frame (D-019, sim/control/handoff.ts) and the match continues locally; endMatch() quits.
 * Repeated failed resyncs (or one that never completes) end the match ('desync').
 *
 * Waiting forever (QF-6): a stall with the link up (the friend's game is held by a system pause, portrait, a page stuck
 * loading) also ends in 'opponent-gone' (reason 'unresponsive') after the rejoin window (T_NET.rejoinWaitMs once the
 * friend's sim has started, startWaitMs while it may still be loading); it clears by itself when frames flow again.
 * A remote pause or its cap that cannot be lifted here (this page is hidden or blocked) is retried every frame and
 * turns into a system pause, so the returning player is never stuck in the friend's pause. Each side announces the
 * match warm-up to the transport (expectBusy) so a long load is not read as a disconnect. A side that reaches full time
 * while the link is down keeps re-dialling until the rejoin window ends (the friend may still need its last frames)
 * and returns its lobby to the room after that; quitting the full-time screen tells opts.onFinish (quit = true).
 *
 * Rematch: every match gets a new session and provider. Messages of the lockstep ('ls:') carry a match tag and input
 * packets from another match are dropped by tick range, so a late packet of the last match never reaches the new one.
 * At full time the provider keeps pumping until the other side holds every frame (provider.drained, ~2 s at most).
 */
import { ANY_DEVICE, createCommandQueue, createLocalInputProvider, mergeInputFrame } from '../app/localInput';
import type { AppContext, MatchHooks, MatchSetup, MatchSummary, SessionControl, TickInputProvider } from '../contracts/app';
import { MAX_HUMANS } from '../contracts/constants';
import { Command, ControllerKind } from '../contracts/enums';
import {
  clearInputFrame, copyInputFrame, createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext,
  type InputSource,
} from '../contracts/input';
import type { MatchConfig, ReadonlySimState, SimState } from '../contracts/state';
import { T_NET } from '../contracts/tuning';
import { copyState } from '../sim/core/clone';
import { hashHex, hashState } from '../sim/core/hash';
import { deserializeState } from '../sim/core/serialize';
import { computeTargetDelay, NET_DELAY_MAX } from './adaptive';
import { encodeSnapshotSync } from './desync';
import type { Lobby, LobbyStart, RejoinPayload } from './lobby';
import { createLockstepProvider, type LockstepProvider } from './lockstep';
import { createEmitter } from './packet';
import type { ControlMessage, InputPacket, NetTransport, TransportEvent } from './types';

const LOCAL_TUNING = {
  /** A stall shows the waiting indicator only after this long (no flicker on one late frame), ms. */
  stallIndicatorMs: 200,
  /** The side that did not pause resumes a remote pause this long after the cap if no resume arrived, ms. */
  pauseGraceMs: 2_000,
  /** Guest: pause between re-dial attempts during the rejoin window, ms. */
  redialMs: 1_500,
  /**
   * Guest: wait this long before the first re-dial, so a host that has not yet noticed the drop (its own silence
   * timeout) does not answer 'room full', ms.
   */
  firstRedialMs: 1_000,
  /** Full time: keep pumping until the other side holds every frame, at most this long, ms. */
  drainMs: 2_000,
  /** Drain pump interval while the app loop no longer pumps, ms. */
  drainPumpMs: 16,
  /** Desyncs within this many ticks after a resync count as failed resyncs. */
  failedResyncWindowTicks: 600,
  /** Failed resyncs that end the match. */
  maxFailedResyncs: 3,
  /**
   * A resync still unfinished after this many ticks of play ends the match (15 s at 60 Hz). Counted in ticks, not
   * time: while the friend's game is held (system pause, hidden) neither side advances and the snapshot cannot be
   * applied yet, which is the unresponsive watchdog's business, not a failed resync.
   */
  resyncTimeoutTicks: 900,
  /** Accept input packets up to this many ticks past our last taken tick (older matches' packets are far beyond). */
  packetTickSlack: 2 * NET_DELAY_MAX + 24,
  /** Delay before closing the room after a mid-match quit, so 'session:quit' reaches the peer first, ms. */
  quitLeaveMs: 400,
  /** A stall before the friend's sim has started (it may still be loading the match) ends in 'unresponsive' after, ms. */
  startWaitMs: 45_000,
  /** Silence grace announced to the transport for the match warm-up (both sides), ms. */
  loadBusyMs: 30_000,
} as const; // TUNING-CR

export const SESSION_PAUSE = 'session:pause';
export const SESSION_RESUME = 'session:resume';
export const SESSION_SYNC = 'session:sync';
export const SESSION_QUIT = 'session:quit';
export const SESSION_END = 'session:end';
/** { tick, h, mt }: the hash of this side's final (POST_MATCH) state, compared at full time. */
export const SESSION_FINAL = 'session:final';

export const STALL_INDICATOR_MS: number = LOCAL_TUNING.stallIndicatorMs;
export const DRAIN_MS: number = LOCAL_TUNING.drainMs;

export type OnlineStatusKind =
  /** Setup built, the match is loading. */
  | 'starting'
  | 'playing'
  /** Waiting for the other side's input (the lockstep holds the sim; show the small indicator). */
  | 'stalled'
  | 'paused'
  /** Connection lost: the 20 s rejoin window. */
  | 'reconnecting'
  /** Rejoin window over, or the opponent quit: offer Finish against CPU / End match. */
  | 'opponent-gone'
  /** Finishing against the CPU. */
  | 'solo'
  /** Full time reached. */
  | 'finished'
  /** Over early (quit, End match, unrecoverable desync). */
  | 'ended';

/** 'unresponsive': the link is up but the friend's game stopped sending inputs for the whole rejoin window. */
export type OnlineEndReason = 'disconnected' | 'quit' | 'desync' | 'local' | 'unresponsive' | null;

export interface OnlineStatus {
  kind: OnlineStatusKind;
  /** How long the current stall has lasted, ms ('stalled'). */
  waitingMs: number;
  /** Human who paused, -1 for a system pause ('paused'). */
  pausedBy: number;
  /** Until a human pause resumes by itself, ms ('paused'; 0 for a system pause). */
  pauseLeftMs: number;
  /** Left of the rejoin window, ms ('reconnecting'). */
  rejoinLeftMs: number;
  /** Why the opponent is gone or the match ended early. */
  reason: OnlineEndReason;
  /** The opponent's nickname. */
  opponent: string;
}

export interface OnlineStats {
  lastTaken: number;
  delay: number;
  stalls: number;
  maxStallMs: number;
  desyncs: number;
  resyncs: number;
  verified: number;
  hashesCompared: number;
  failedResyncs: number;
  rejoins: number;
  /**
   * Full-time check: the hashes of both final states ('pending' until both are known). The 30-tick hash exchange never
   * sees the last ticks (the app stops ticking at POST_MATCH), so a divergence there would otherwise go unnoticed.
   */
  finalCheck: 'pending' | 'ok' | 'mismatch';
}

/** The TickInputProvider of an online match (lockstep, then local play after Finish against CPU). */
export interface OnlineInputProvider extends TickInputProvider {
  queueCommand(human: number, cmd: Command, arg: number): void;
  readonly waitingMs: number;
  /** 'lockstep' | 'solo' (after Finish against CPU) | 'ended'. */
  readonly mode: 'lockstep' | 'solo' | 'ended';
  /** The lockstep provider in use (null after Finish against CPU). */
  readonly lockstep: LockstepProvider | null;
  /** Camera projector for gesture sources (the app session may hand it over). */
  setProjector(get: () => CameraProjector | null): void;
}

export interface OnlineSession {
  readonly lobby: Lobby;
  /** Build the setup once the lobby has started. */
  setup(): MatchSetup;
  readonly pausesLeft: number;
  dispose(): void;

  // ---- NET-06 additions
  readonly localHuman: number;
  readonly remoteHuman: number;
  /** Pauses left per human [P1, P2]. */
  readonly pausesLeftOf: readonly number[];
  readonly status: Readonly<OnlineStatus>;
  readonly provider: OnlineInputProvider;
  readonly stats: OnlineStats;
  /** ctx.session.start(setup()) plus the pause state a rejoin start carries. */
  start(): void;
  /** 'opponent-gone' -> the absent human's side goes to the CPU and the match continues here. False otherwise. */
  finishAgainstCpu(): boolean;
  /** End the match now (quits to the main menu and closes the room). */
  endMatch(): void;
  /** Status kind changes. */
  onStatus(fn: (s: Readonly<OnlineStatus>) => void): () => void;
  /** Every pump (once per animation frame while the match exists): countdowns. The object is reused. */
  onFrame(fn: (s: Readonly<OnlineStatus>) => void): () => void;
  /** Short plain-language lines ("No pauses left", "Ana paused (2 left)"). */
  onNotice(fn: (text: string) => void): () => void;
  /** Resolves when the provider is disposed (after its full-time drain). */
  whenDrained(): Promise<void>;
}

export interface SessionTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OnlineSessionOptions {
  /** Local input sources (owned by the session). Default: every local device bound to the local human. */
  localSources?: InputSource[];
  timers?: SessionTimers;
  pausesPerPlayer?: number;
  pauseMaxMs?: number;
  rejoinWaitMs?: number;
  /** Lockstep options passed through (tests). */
  adaptive?: boolean;
  timeSync?: boolean;
  /**
   * Also called with the summary when the match reaches full time or is quit, and once more (quit = true) when the app
   * session is quit from the full-time screen (Quit or Rematch: the online screen leaves the room unless it comes back).
   */
  onFinish?: (summary: MatchSummary | null, quit: boolean) => void;
  /** Diagnostics.log compatible (default ctx.diagnostics.log). */
  log?: (kind: string, message: string, data?: unknown) => void;
}

/** True when this browser can attempt online play (WebRTC data channels present). */
export function onlineSupported(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

const defaultTimers: SessionTimers = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface MutableSampleContext {
  tick: number;
  human: number;
  side: number;
  state: SimState;
  projector: CameraProjector | null;
}

/** A local input provider (every device bound to `human`) as one InputSource for the lockstep. */
function providerSource(lp: TickInputProvider, human: number): InputSource {
  const frames: InputFrame[] = [];
  for (let h = 0; h < MAX_HUMANS; h++) frames.push(createInputFrame());
  return {
    id: 'online-local',
    kind: 'net',
    sample(out, sctx) {
      lp.take(sctx.tick, frames, sctx.state);
      copyInputFrame(out, frames[human]!);
    },
    pollFrame(nowMs) {
      lp.pump(nowMs);
    },
    releaseAll() {
      lp.releaseAll();
    },
    dispose() {
      lp.dispose();
    },
  };
}

/** A non-owning view of `src` (the lockstep disposes its sources; the session keeps them for Finish against CPU). */
function borrowed(src: InputSource): InputSource {
  const view: InputSource = {
    id: src.id,
    kind: src.kind,
    sample: (out, sctx) => src.sample(out, sctx),
    releaseAll: () => src.releaseAll(),
    dispose: () => undefined,
  };
  if (src.pollFrame) (view as { pollFrame?: (n: number) => void }).pollFrame = (n: number) => src.pollFrame!(n);
  return view;
}

/**
 * The transport as one match sees it: 'ls:' control messages are tagged with the match tag (others' are dropped) and
 * input packets far outside this match's tick range are dropped (a previous match's late resends).
 */
interface MatchTransport extends NetTransport {
  tag: string;
  lastTaken: number;
}

function createMatchTransport(tr: NetTransport, tag: string, firstTick: number): MatchTransport {
  const slack = LOCAL_TUNING.packetTickSlack;
  const view: MatchTransport = {
    tag,
    lastTaken: firstTick - 1,
    get state() { return tr.state; },
    get role() { return tr.role; },
    get rtt() { return tr.rtt; },
    get jitter() { return tr.jitter; },
    open: (role, code) => tr.open(role, code),
    reconnect: () => tr.reconnect(),
    sendInputs: (p) => tr.sendInputs(p),
    sendReliable(m) {
      tr.sendReliable(m.type.startsWith('ls:') ? { ...m, mt: view.tag } : m);
    },
    onInputs(fn) {
      return tr.onInputs((p: InputPacket) => {
        const lim = view.lastTaken + slack;
        if (p.tick > lim || p.ack > lim || p.firstTick > lim + slack) return;
        fn(p);
      });
    },
    onReliable(fn) {
      return tr.onReliable((m: ControlMessage) => {
        if (m.type.startsWith('ls:') && m.mt !== view.tag) return;
        fn(m);
      });
    },
    onEvent: (fn) => tr.onEvent(fn),
    close: () => undefined,
  };
  return view;
}

function intIn(v: unknown, min: number, max: number, def: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def;
}

export function createOnlineSession(ctx: AppContext, lobby: Lobby, opts: OnlineSessionOptions = {}): OnlineSession {
  const start: LobbyStart | null = lobby.started;
  if (!start) throw new Error('createOnlineSession: the lobby has not started a match');
  const transport = start.transport;
  const local = lobby.isHost ? 0 : 1;
  const remote = 1 - local;
  const timers = opts.timers ?? defaultTimers;
  const pausesPer = opts.pausesPerPlayer ?? T_NET.pausesPerPlayer;
  const pauseMaxMs = opts.pauseMaxMs ?? T_NET.pauseMaxMs;
  const rejoinWaitMs = opts.rejoinWaitMs ?? T_NET.rejoinWaitMs;
  const log = opts.log ?? ((kind: string, message: string, data?: unknown) => {
    try {
      ctx.diagnostics.log(kind, message, data);
    } catch {
      /* diagnostics never break play */
    }
  });
  const config: MatchConfig = { ...start.config, humans: start.config.humans.map((hc) => ({ ...hc })) };
  const opponentName = (): string => lobby.peer?.nickname ?? (local === 0 ? 'Guest' : 'Host');

  // ---------------------------------------------------------------- state
  const used = [0, 0];
  let projectorGet: (() => CameraProjector | null) | null = null;
  let finished = false;
  let ended = false;
  let endReason: OnlineEndReason = null;
  let connLost = false;
  let gone = false;
  let goneReason: OnlineEndReason = null;
  let rejoinDeadline = 0;
  let rejoinTimer: unknown = null;
  let redialTimer: unknown = null;
  let pauseTimer: unknown = null;
  let pauseDeadline = 0;
  let pauseOwner = -1;
  let remotePausePending = false;
  /** Who holds the current pause as the hooks saw it (-1 system, -2 none). */
  let pauser = -2;
  let internal = 0;
  let internalQuit = false;
  let disposed = false;
  let built: MatchSetup | null = null;
  let lastKind: OnlineStatusKind = 'starting';
  let failedResyncs = 0;
  let seenDesyncs = 0;
  let resyncSinceTick = -1;
  let rejoins = 0;
  /** Since when (app loop time) no tick was taken while this side wanted to tick, and the tick it is stuck on. */
  let progressAt = -1;
  let progressTick = -1;
  /** The friend's pause ended but this session refused to lift it (page hidden / blocked): retry every frame. */
  let liftRemotePause = false;
  /** lastTaken when the friend was declared unresponsive (it is back once a later tick is taken). */
  let unresponsiveAt = -1;
  /** Full time was reached while the link was down: return the lobby to the room once it is back (or given up). */
  let matchEndPending = false;
  let finishSummary: MatchSummary | null = null;
  let quitNotified = false;
  let loadAnnounced = false;
  let finalLocal: { tick: number; h: number } | null = null;
  let finalRemote: { tick: number; h: number } | null = null;
  let finalCheck: 'pending' | 'ok' | 'mismatch' = 'pending';
  const status: OnlineStatus = {
    kind: 'starting', waitingMs: 0, pausedBy: -1, pauseLeftMs: 0, rejoinLeftMs: 0, reason: null, opponent: opponentName(),
  };
  const statusEvents = createEmitter<Readonly<OnlineStatus>>();
  const frameEvents = createEmitter<Readonly<OnlineStatus>>();
  const notices = createEmitter<string>();
  const notice = (text: string): void => notices.emit(text);

  // ---------------------------------------------------------------- local input
  const sources: InputSource[] = opts.localSources
    ? opts.localSources.slice()
    : [providerSource(createLocalInputProvider([{ human: local, deviceIds: [ANY_DEVICE] }], ctx.devices,
      () => ctx.session.getState(), () => (projectorGet ? projectorGet() : null),
      { onError: (err, where) => log('net', `local input ${where}: ${String(err)}`) }), local)];
  const soloQueue = createCommandQueue();
  const scratch = createInputFrame();
  const sampleCtx: MutableSampleContext = { tick: 0, human: local, side: -1, state: null as unknown as SimState, projector: null };

  // ---------------------------------------------------------------- lockstep
  const rejoinIn = start.rejoin;
  let firstTick = 1;
  let pendingSnapshot: SimState | null = null;
  let initialRemotePause = false;
  let tag = `m${start.n}`;
  if (rejoinIn) {
    const snapTick = intIn(rejoinIn.tick, 0, 0x7fffffff, -1);
    const chunks = Array.isArray(rejoinIn.chunks) ? rejoinIn.chunks.filter((c): c is string => typeof c === 'string') : [];
    try {
      if (snapTick < 0 || rejoinIn.codec !== 'json') throw new Error('bad rejoin payload');
      pendingSnapshot = deserializeState(chunks.join(''));
      if (pendingSnapshot.tick !== snapTick) throw new Error('rejoin snapshot tick mismatch');
      firstTick = snapTick + 1;
      tag = typeof rejoinIn.tag === 'string' ? rejoinIn.tag.slice(0, 32) : tag;
      const u = Array.isArray(rejoinIn.used) ? rejoinIn.used : [];
      used[0] = intIn(u[0], 0, pausesPer, 0);
      used[1] = intIn(u[1], 0, pausesPer, 0);
      initialRemotePause = rejoinIn.paused === true;
      rejoins++;
    } catch (err) {
      log('net', `rejoin start ignored: ${String(err)}`);
      pendingSnapshot = null;
      firstTick = 1;
    }
  }
  const view = createMatchTransport(transport, tag, firstTick);
  const proxies = sources.map(borrowed);
  let mode: 'lockstep' | 'solo' | 'ended' = 'lockstep';
  let inner: LockstepProvider | null = makeLockstep(firstTick, start.delay);
  let lastTaken = firstTick - 1;

  function makeLockstep(first: number, delay: number): LockstepProvider {
    view.lastTaken = first - 1;
    return createLockstepProvider({
      transport: view,
      localHuman: local,
      localSources: proxies,
      delay,
      firstTick: first,
      isHost: local === 0,
      adaptive: opts.adaptive,
      timeSync: opts.timeSync,
      getProjector: () => (projectorGet ? projectorGet() : null),
      log,
      onResync: (tick, fromTick) => log('net', `resync: state replaced by the host's tick ${tick} (was ${fromTick})`),
    });
  }

  // ---------------------------------------------------------------- status
  function computeStatus(): OnlineStatus {
    const s = status;
    const sess = ctx.session;
    const now = timers.now(); // the clock the deadlines were set with
    s.opponent = opponentName();
    s.waitingMs = 0;
    s.pauseLeftMs = 0;
    s.rejoinLeftMs = 0;
    s.pausedBy = sess.paused ? sess.pausedBy : -1;
    s.reason = ended ? endReason : gone ? goneReason : null;
    let k: OnlineStatusKind;
    if (ended) k = 'ended';
    else if (finished) k = 'finished';
    else if (gone) k = 'opponent-gone';
    else if (connLost) {
      k = 'reconnecting';
      s.rejoinLeftMs = Math.max(0, rejoinDeadline - now);
    } else if (sess.active && sess.paused) {
      k = 'paused';
      if (pauseOwner >= 0 && sess.pausedBy === pauseOwner) s.pauseLeftMs = Math.max(0, pauseDeadline - now);
    } else if (mode === 'solo') k = 'solo';
    else if (inner && inner.waiting && inner.waitingMs >= LOCAL_TUNING.stallIndicatorMs) {
      k = 'stalled';
      s.waitingMs = inner.waitingMs;
    } else if (!built || !sess.active || lastTaken < firstTick) k = 'starting';
    else k = 'playing';
    s.kind = k;
    return s;
  }

  function refresh(): void {
    computeStatus();
    if (status.kind !== lastKind) {
      lastKind = status.kind;
      statusEvents.emit(status);
    }
  }

  // ---------------------------------------------------------------- pause protocol
  function withInternal(fn: () => void): void {
    internal++;
    try {
      fn();
    } finally {
      internal--;
    }
  }

  function send(msg: ControlMessage): void {
    if (transport.state === 'open') transport.sendReliable(msg);
  }

  function clearPauseCap(): void {
    if (pauseTimer !== null) timers.clearTimeout(pauseTimer);
    pauseTimer = null;
    pauseOwner = -1;
  }

  function armPauseCap(human: number): void {
    clearPauseCap();
    pauseOwner = human;
    pauseDeadline = timers.now() + pauseMaxMs;
    const wait = pauseMaxMs + (human === local ? 0 : LOCAL_TUNING.pauseGraceMs);
    pauseTimer = timers.setTimeout(() => {
      pauseTimer = null;
      autoResume(human);
    }, wait);
  }

  function autoResume(human: number): void {
    const sess = ctx.session;
    if (!sess.active || !sess.paused || sess.pausedBy !== human) return;
    if (human === local) {
      if (sess.resume(local)) notice('Pause time is up');
    } else {
      withInternal(() => sess.resume(remote));
      if (!sess.paused) notice('Pause time is up');
      else if (sess.pausedBy === remote) liftRemotePause = true; // hidden / blocked here: lift it when possible
    }
    refresh();
  }

  function applyRemotePause(u: number): void {
    const sess = ctx.session;
    if (sess.paused) {
      if (sess.pausedBy === remote) {
        used[remote] = Math.max(used[remote]!, u);
        return;
      }
      if (sess.pausedBy === local) {
        if (local === 0) return; // both paused at once: the host's pause wins (the guest refunds its own)
        used[remote] = Math.max(used[remote]!, u);
        used[local] = Math.max(0, used[local]! - 1);
        clearPauseCap();
        withInternal(() => {
          sess.resume(local);
          sess.pause(remote);
        });
      } else {
        used[remote] = Math.max(used[remote]!, u);
        remotePausePending = true; // a system pause is showing: apply the other player's pause when it ends
        return;
      }
    } else {
      used[remote] = Math.max(used[remote]!, u);
      withInternal(() => sess.pause(remote));
    }
    if (sess.paused && sess.pausedBy === remote) {
      armPauseCap(remote);
      notice(`${opponentName()} paused (${Math.max(0, pausesPer - used[remote]!)} left)`);
    }
  }

  function applyRemoteResume(): void {
    remotePausePending = false;
    const sess = ctx.session;
    if (sess.paused && sess.pausedBy === remote) {
      withInternal(() => sess.resume(remote));
      if (pauseOwner === remote) clearPauseCap();
      // The app session refuses to resume while the page is hidden or blocked: without a retry this side would stay in
      // the friend's pause for good (only the pauser may resume it), and the friend would wait for us forever.
      if (sess.paused && sess.pausedBy === remote) liftRemotePause = true;
    }
  }

  /** Retry lifting the friend's ended pause; it becomes a system pause so the returning player resumes when ready. */
  function retryLiftRemotePause(): void {
    const sess = ctx.session;
    if (!sess.active || !sess.paused || sess.pausedBy !== remote) {
      liftRemotePause = false;
      return;
    }
    withInternal(() => {
      if (sess.resume(remote)) sess.pause(-1);
    });
    if (!(sess.paused && sess.pausedBy === remote)) {
      liftRemotePause = false;
      log('net', 'the friend\'s pause ended while this page was away: now a system pause');
      refresh();
    }
  }

  const hooks: MatchHooks = {
    allowPause(byHuman, pausing) {
      if (internal > 0 || byHuman < 0) return true;
      if (mode !== 'lockstep' || finished || ended) return true; // finishing against the CPU: local rules
      if (byHuman !== local) return false; // the other human's pauses only arrive over the network
      if (!pausing) return true; // the app session already lets only the pauser resume
      if (connLost || gone) {
        notice(goneReason === 'unresponsive' ? `Pausing is not possible while ${opponentName()} is not responding`
          : 'Pausing is not possible while the connection is down');
        return false;
      }
      if (used[local]! >= pausesPer) {
        notice('No pauses left');
        return false;
      }
      return true;
    },
    onPauseChange(paused, byHuman) {
      // Who held the pause that just ended (resume reports the human who lifted it, which for a system pause may be
      // anyone).
      const was = pauser;
      pauser = paused ? byHuman : -2;
      if (internal > 0) {
        refresh();
        return;
      }
      const live = mode === 'lockstep' && !finished && !ended;
      if (paused && byHuman === local && live) {
        used[local]!++;
        send({ type: SESSION_PAUSE, human: local, used: used[local] });
        armPauseCap(local);
      } else if (!paused && was === local && live) {
        send({ type: SESSION_RESUME, human: local });
        if (pauseOwner === local) clearPauseCap();
      } else if (!paused && was === -1 && remotePausePending && mode === 'lockstep') {
        // A system pause ended while the other player had paused: their pause shows now.
        timers.setTimeout(() => {
          if (!remotePausePending || disposed) return;
          remotePausePending = false;
          applyRemotePause(used[remote]!);
          refresh();
        }, 0);
      }
      refresh();
    },
    onQuit() {
      if (internalQuit) return;
      if (finished && !quitNotified) {
        // Leaving the full-time screen (Quit or Rematch): the online screen decides whether the room stays.
        quitNotified = true;
        callOnFinish(finishSummary, true);
        return;
      }
      if (finished || ended) return;
      // Quit from the pause menu mid-match: tell the peer (it may finish against the CPU), then close the room.
      ended = true;
      endReason = 'local';
      send({ type: SESSION_QUIT });
      leaveRoomSoon(LOCAL_TUNING.quitLeaveMs);
      refresh();
    },
  };

  // ---------------------------------------------------------------- disconnect / rejoin
  function clearTimer(h: unknown): null {
    if (h !== null) timers.clearTimeout(h);
    return null;
  }

  function onLinkLost(): void {
    if (mode !== 'lockstep' || finished || ended || disposed) return;
    if (!connLost) {
      connLost = true;
      if (!gone) {
        rejoinDeadline = timers.now() + rejoinWaitMs;
        rejoinTimer = clearTimer(rejoinTimer);
        rejoinTimer = timers.setTimeout(onRejoinTimeout, rejoinWaitMs);
      }
      log('net', `connection lost at tick ${lastTaken}; waiting ${rejoinWaitMs} ms for a rejoin`);
    }
    redialTimer = clearTimer(redialTimer);
    if (local === 0) redial();
    else redialTimer = timers.setTimeout(redial, LOCAL_TUNING.firstRedialMs);
    refresh();
  }

  function redial(): void {
    if (!connLost || disposed || mode !== 'lockstep' || ended) return; // also after full time: the friend may need our last frames
    redialTimer = clearTimer(redialTimer);
    transport.reconnect().then(
      () => undefined, // the 'connected' event does the rest
      (err: unknown) => {
        if (!connLost || disposed || mode !== 'lockstep') return;
        log('net', `rejoin attempt failed: ${String(err instanceof Error ? err.message : err)}`);
        const st = transport.state;
        if (local === 1 || (st !== 'closed' && st !== 'failed')) redialTimer = timers.setTimeout(redial, LOCAL_TUNING.redialMs);
      },
    );
  }

  function onRejoinTimeout(): void {
    rejoinTimer = null;
    if (!connLost || disposed || ended) return;
    if (finished) {
      connLost = false;
      redialTimer = clearTimer(redialTimer);
      endPendingMatch();
      return;
    }
    gone = true;
    goneReason = 'disconnected';
    notice(`${opponentName()} did not come back`);
    refresh();
  }

  function endPendingMatch(): void {
    if (!matchEndPending) return;
    matchEndPending = false;
    lobby.matchEnded();
  }

  function onLinkUp(): void {
    if (mode !== 'lockstep' || ended || disposed) return;
    // Tell the other side our pause state; the link counts as restored when theirs arrives (a guest whose page
    // reloaded says hello instead and gets a rejoin start). Also after full time: the friend may still be playing
    // its last ticks and waits for this message to leave its rejoin window.
    const paused = !finished && ctx.session.paused && ctx.session.pausedBy === local;
    send({ type: SESSION_SYNC, paused, used: used[local], tick: lastTaken });
    sendFinal(); // (again) after a drop at full time
  }

  function sendFinal(): void {
    if (finalLocal) send({ type: SESSION_FINAL, tick: finalLocal.tick, h: finalLocal.h, mt: view.tag });
  }

  function onRemoteFinal(m: ControlMessage): void {
    if (m.mt !== view.tag || typeof m.tick !== 'number' || typeof m.h !== 'number') return;
    finalRemote = { tick: m.tick, h: m.h >>> 0 };
    compareFinal();
  }

  /** Both final states known: they must be identical (same tick, same hash). */
  function compareFinal(): void {
    if (!finalLocal || !finalRemote || finalCheck !== 'pending') return;
    if (finalLocal.tick === finalRemote.tick && finalLocal.h === finalRemote.h) {
      finalCheck = 'ok';
      return;
    }
    finalCheck = 'mismatch';
    const st = ctx.session.getState();
    const from = Math.max(firstTick, Math.min(finalLocal.tick, finalRemote.tick) - 30);
    log('net', `desync at full time (seed ${config.seed}): local tick ${finalLocal.tick} ${hashHex(finalLocal.h)} != remote tick ` +
      `${finalRemote.tick} ${hashHex(finalRemote.h)}`, {
      seed: config.seed, local: finalLocal, remote: finalRemote, score: st ? [st.teams[0]!.goals, st.teams[1]!.goals] : null,
      inputs: inner ? inner.describeInputs(from, finalLocal.tick) : null,
    });
    notice('The two games did not agree at the final whistle (a sync error); a report was saved');
  }

  function onSync(m: ControlMessage): void {
    if (mode !== 'lockstep' || ended) return;
    if (finished) {
      restoreLink();
      endPendingMatch();
      refresh();
      return;
    }
    const wasLost = connLost || gone;
    restoreLink();
    used[remote] = Math.max(used[remote]!, intIn(m.used, 0, pausesPer, 0));
    const sess = ctx.session;
    if (m.paused === true) applyRemotePause(used[remote]!);
    else if (sess.paused && sess.pausedBy === remote) applyRemoteResume();
    if (wasLost) notice(`${opponentName()} is back`);
    refresh();
  }

  function restoreLink(): void {
    if (!connLost && !gone) return;
    connLost = false;
    gone = false;
    goneReason = null;
    rejoinTimer = clearTimer(rejoinTimer);
    redialTimer = clearTimer(redialTimer);
    log('net', `connection restored at tick ${lastTaken}`);
  }

  /** Host: the guest's page reloaded and it said hello with the match token: restart the lockstep here and send it a snapshot. */
  function onRejoinRequest(token: string): void {
    if (local !== 0 || mode !== 'lockstep' || finished || ended || disposed) return;
    if (!token || token !== start!.token) {
      log('net', 'a different guest tried to join during the match: refused');
      lobby.reject('room-full');
      return;
    }
    const st = ctx.session.getState() as SimState | null;
    if (!st || !inner) return;
    // The old page's pause died with it (the new page starts unpaused): never keep waiting on it.
    remotePausePending = false;
    if (ctx.session.paused && ctx.session.pausedBy === remote) applyRemoteResume();
    const t = st.tick;
    const delay = transport.rtt > 0 ? computeTargetDelay(transport.rtt, transport.jitter) : start!.delay;
    inner.dispose();
    rejoins++;
    view.tag = `m${start!.n}r${rejoins}`;
    inner = makeLockstep(t + 1, delay);
    lastTaken = t;
    const snap = encodeSnapshotSync(st);
    const payload: RejoinPayload = {
      tick: t, codec: snap.codec, chunks: snap.chunks, tag: view.tag, used: [used[0], used[1]],
      paused: ctx.session.paused && ctx.session.pausedBy === local,
    };
    lobby.sendRejoin(config, delay, payload);
    restoreLink();
    log('net', `guest rejoined after a reload: lockstep restarted at tick ${t + 1} (delay ${delay})`);
    notice(`${opponentName()} is back`);
    refresh();
  }

  function onOpponentLeft(reason: OnlineEndReason): void {
    if (mode !== 'lockstep' || finished || ended || disposed) return;
    gone = true;
    goneReason = reason;
    connLost = false;
    rejoinTimer = clearTimer(rejoinTimer);
    redialTimer = clearTimer(redialTimer);
    remotePausePending = false;
    if (ctx.session.paused && ctx.session.pausedBy === remote) applyRemoteResume();
    notice(reason === 'quit' ? `${opponentName()} left the match` : `${opponentName()} ended the match`);
    refresh();
  }

  // ---------------------------------------------------------------- transport + lobby listeners
  const unsubs: (() => void)[] = [
    transport.onEvent((e: TransportEvent) => {
      if (e.type === 'disconnected') onLinkLost();
      else if (e.type === 'connected') onLinkUp();
    }),
    transport.onReliable((m: ControlMessage) => {
      if (disposed || typeof m.type !== 'string' || !m.type.startsWith('session:')) return;
      switch (m.type) {
        case SESSION_PAUSE:
          if (m.human === remote && mode === 'lockstep' && !finished && !ended) {
            applyRemotePause(intIn(m.used, 0, pausesPer, used[remote]! + 1));
            refresh();
          }
          break;
        case SESSION_RESUME:
          if (m.human === remote) {
            applyRemoteResume();
            refresh();
          }
          break;
        case SESSION_SYNC:
          onSync(m);
          break;
        case SESSION_QUIT:
          onOpponentLeft('quit');
          break;
        case SESSION_FINAL:
          onRemoteFinal(m);
          break;
        case SESSION_END:
          if (m.reason === 'desync') endMatch('desync', false);
          else onOpponentLeft('quit');
          break;
        default:
          break;
      }
    }),
    lobby.onNotice((n) => {
      if (n.kind === 'rejoin-request') onRejoinRequest(n.token);
      else if (n.kind === 'peer-left') onOpponentLeft('quit');
    }),
  ];

  // ---------------------------------------------------------------- the provider
  let drainTimer: unknown = null;
  let providerDisposed = false;
  let drainedResolve: (() => void) | null = null;
  const drainedPromise = new Promise<void>((resolve) => {
    drainedResolve = resolve;
  });

  function takeSolo(frames: InputFrame[], state: SimState): void {
    for (let h = 0; h < frames.length; h++) {
      const f = frames[h];
      if (f) clearInputFrame(f);
    }
    const out = frames[local];
    if (out) {
      sampleCtx.tick = state.tick + 1;
      sampleCtx.state = state;
      const ctrl = state.ctrl[local];
      sampleCtx.side = ctrl ? ctrl.side : -1;
      sampleCtx.projector = projectorGet ? projectorGet() : null;
      for (let i = 0; i < sources.length; i++) {
        clearInputFrame(scratch);
        try {
          sources[i]!.sample(scratch, sampleCtx as InputSampleContext);
        } catch (err) {
          log('net', `input source ${sources[i]!.id} failed: ${String(err)}`);
          continue;
        }
        mergeInputFrame(out, scratch);
      }
    }
    soloQueue.applyTo(frames);
    // The absent human's side goes to its CPU brain (D-019): the command stays in his frame until the sim took it.
    const absent = frames[remote];
    const ctl = state.ctrl[remote];
    if (absent && ctl && ctl.kind === ControllerKind.HUMAN) {
      absent.cmd = Command.HAND_TO_CPU;
      absent.cmdArg = remote;
    }
  }

  function finalizeProvider(): void {
    drainTimer = clearTimer(drainTimer);
    if (inner) {
      inner.dispose();
      inner = null;
    }
    for (const s of sources) {
      try {
        s.dispose();
      } catch (err) {
        log('net', `input source ${s.id} dispose failed: ${String(err)}`);
      }
    }
    sources.length = 0;
    soloQueue.clear();
    const r = drainedResolve;
    drainedResolve = null;
    r?.();
  }

  function checkResyncs(): void {
    if (!inner || mode !== 'lockstep' || finished || ended) return;
    const g = inner.guard;
    if (g.desyncs > seenDesyncs) {
      if (g.lastResyncTick >= 0 && lastTaken - g.lastResyncTick < LOCAL_TUNING.failedResyncWindowTicks) failedResyncs++;
      seenDesyncs = g.desyncs;
    }
    if (g.resyncing) {
      if (resyncSinceTick < 0) resyncSinceTick = lastTaken;
      else if (lastTaken - resyncSinceTick > LOCAL_TUNING.resyncTimeoutTicks) failedResyncs = LOCAL_TUNING.maxFailedResyncs;
    } else resyncSinceTick = -1;
    if (failedResyncs >= LOCAL_TUNING.maxFailedResyncs) {
      log('net', `ending the match: ${failedResyncs} failed resyncs`, g.reports);
      endMatch('desync', true);
    }
  }

  const provider: OnlineInputProvider = {
    get waiting() {
      return mode === 'lockstep' && inner !== null && inner.waiting;
    },
    get waitingMs() {
      return mode === 'lockstep' && inner !== null ? inner.waitingMs : 0;
    },
    get mode() {
      return mode;
    },
    get lockstep() {
      return inner;
    },
    setProjector(get) {
      projectorGet = get;
    },
    ready(tick) {
      if (mode === 'solo') return true;
      if (mode !== 'lockstep' || !inner || providerDisposed) return false;
      return inner.ready(pendingSnapshot ? firstTick : tick);
    },
    take(tick, frames, state: ReadonlySimState) {
      const s = state as unknown as SimState;
      if (pendingSnapshot) {
        copyState(s, pendingSnapshot); // a reloaded guest's first tick: hard-sync to the host's snapshot
        pendingSnapshot = null;
        log('net', `rejoined: state set to the host's tick ${s.tick}`);
      }
      if (mode === 'solo') {
        takeSolo(frames, s);
        lastTaken = s.tick + 1;
        return;
      }
      if (!inner) throw new Error('online provider: take() after the lockstep ended');
      inner.take(tick, frames, s);
      lastTaken = s.tick + 1;
      view.lastTaken = lastTaken;
    },
    pump(nowMs) {
      if (providerDisposed) return;
      if (mode === 'lockstep' && inner) inner.pump(nowMs);
      else if (mode === 'solo') {
        for (let i = 0; i < sources.length; i++) {
          const src = sources[i]!;
          if (!src.pollFrame) continue;
          try {
            src.pollFrame(nowMs);
          } catch (err) {
            log('net', `input source ${src.id} poll failed: ${String(err)}`);
          }
        }
      }
      if (!loadAnnounced) {
        loadAnnounced = true;
        transport.expectBusy?.(0); // loaded: our warm-up is over (the friend's own grace stays until it says so)
      }
      if (liftRemotePause) retryLiftRemotePause();
      checkResyncs();
      checkUnresponsive(nowMs);
      refresh();
      frameEvents.emit(status);
    },
    queueCommand(human, cmd, arg) {
      if (human !== local || cmd === Command.NONE) return;
      if (mode === 'solo') soloQueue.push(local, cmd, arg);
      else if (inner) inner.queueCommand(human, cmd, arg);
    },
    releaseAll() {
      for (const s of sources) {
        try {
          s.releaseAll();
        } catch (err) {
          log('net', `input source ${s.id} releaseAll failed: ${String(err)}`);
        }
      }
    },
    dispose() {
      if (providerDisposed) return;
      providerDisposed = true;
      const lk = inner;
      if (lk && mode === 'lockstep' && finished && !lk.drained && transport.state === 'open') {
        // Full time: the other side may still need our last frames; keep pumping for a moment.
        const until = timers.now() + LOCAL_TUNING.drainMs;
        const step = (): void => {
          drainTimer = null;
          const now = timers.now();
          lk.pump(now);
          if (lk.drained || now >= until || transport.state !== 'open') finalizeProvider();
          else drainTimer = timers.setTimeout(step, LOCAL_TUNING.drainPumpMs);
        };
        drainTimer = timers.setTimeout(step, LOCAL_TUNING.drainPumpMs);
        return;
      }
      finalizeProvider();
    },
  };

  // ---------------------------------------------------------------- ending
  let leaveTimer: unknown = null;
  function leaveRoomSoon(ms: number): void {
    if (leaveTimer !== null) return;
    leaveTimer = timers.setTimeout(() => {
      leaveTimer = null;
      lobby.leave();
    }, ms);
  }

  function endMatch(reason: OnlineEndReason, tellPeer: boolean): void {
    if (ended || disposed) return;
    const wasFinished = finished;
    ended = true;
    endReason = reason;
    if (tellPeer && !wasFinished) send({ type: SESSION_END, reason });
    clearPauseCap();
    rejoinTimer = clearTimer(rejoinTimer);
    redialTimer = clearTimer(redialTimer);
    if (mode === 'lockstep') mode = 'ended';
    refresh();
    if (ctx.session.active && !wasFinished) {
      internalQuit = true;
      try {
        ctx.session.quit();
      } finally {
        internalQuit = false;
      }
    }
    leaveRoomSoon(tellPeer ? LOCAL_TUNING.quitLeaveMs : 0);
  }

  // ---------------------------------------------------------------- setup
  function callOnFinish(summary: MatchSummary | null, quit: boolean): void {
    if (!opts.onFinish) return;
    try {
      opts.onFinish(summary, quit);
    } catch (err) {
      log('error', `online onFinish: ${String(err)}`);
    }
  }

  function onFinish(summary: MatchSummary | null, quit: boolean): void {
    if (!quit) {
      finished = true;
      finishSummary = summary;
      clearPauseCap();
      liftRemotePause = false;
      progressAt = -1;
      if (gone) {
        gone = false;
        goneReason = null;
      }
      if (mode === 'lockstep') {
        const fs = ctx.session.getState();
        if (fs) {
          finalLocal = { tick: fs.tick, h: hashState(fs as SimState) };
          sendFinal();
          compareFinal();
        }
        if (connLost && rejoinTimer !== null) {
          // The link is down: keep re-dialling for the rest of the window (the friend may need our last frames), then
          // hand the lobby back (matchEnded() at restore or at the end of the window). Leaving it in 'playing' for
          // good made a rematch impossible.
          matchEndPending = true;
        } else {
          connLost = false;
          rejoinTimer = clearTimer(rejoinTimer);
          redialTimer = clearTimer(redialTimer);
          lobby.matchEnded();
        }
      }
      refresh();
    } else {
      quitNotified = true;
    }
    callOnFinish(summary, quit);
  }

  /**
   * Both sides waiting forever: the link is up but no frames come (the friend's game is held by a system pause, a
   * portrait lock or a page stuck loading). After the rejoin window the friend counts as gone ('unresponsive'); the
   * state clears by itself when frames flow again.
   */
  function checkUnresponsive(now: number): void {
    if (!inner || mode !== 'lockstep' || finished || ended || connLost) {
      progressAt = -1;
      return;
    }
    if (gone) {
      // A tick past the one we got stuck on means the friend generated new frames: it is playing again.
      if (goneReason === 'unresponsive' && lastTaken > unresponsiveAt) {
        gone = false;
        goneReason = null;
        progressAt = -1;
        log('net', `${opponentName()} responds again at tick ${lastTaken}`);
        notice(`${opponentName()} is back`);
      }
      return;
    }
    const sess = ctx.session as SessionControl & { ticking?: boolean };
    const ticking = typeof sess.ticking === 'boolean' ? sess.ticking : sess.active && !sess.paused;
    // Measured as "no tick taken while this side wants to tick" (a side that runs slightly ahead may end most frames
    // waiting for the next frame and still make progress: that is not a stall).
    if (!ticking || progressAt < 0 || lastTaken !== progressTick) {
      progressAt = now;
      progressTick = lastTaken;
      return;
    }
    const friendStarted = lastTaken >= firstTick + NET_DELAY_MAX;
    const limit = friendStarted ? rejoinWaitMs : Math.max(rejoinWaitMs, LOCAL_TUNING.startWaitMs);
    if (now - progressAt < limit) return;
    log('net', `no input from ${opponentName()} for ${Math.round(now - progressAt)} ms at tick ${lastTaken} with the link up`);
    gone = true;
    goneReason = 'unresponsive';
    unresponsiveAt = lastTaken;
    progressAt = -1;
    remotePausePending = false;
    notice(`${opponentName()} is not responding`);
  }

  const modeData = {
    kind: 'online' as const,
    get session(): OnlineSession {
      return session;
    },
    get pausesLeft(): number[] {
      return [Math.max(0, pausesPer - used[0]!), Math.max(0, pausesPer - used[1]!)];
    },
  };

  const session: OnlineSession = {
    lobby,
    localHuman: local,
    remoteHuman: remote,
    provider,
    get pausesLeft() {
      return Math.max(0, pausesPer - used[local]!);
    },
    get pausesLeftOf() {
      return [Math.max(0, pausesPer - used[0]!), Math.max(0, pausesPer - used[1]!)];
    },
    get status() {
      return computeStatus();
    },
    get stats(): OnlineStats {
      const st = inner?.stats;
      const g = inner?.guard.stats;
      return {
        lastTaken, delay: inner ? inner.delay : 0, stalls: st?.stalls ?? 0, maxStallMs: st?.maxStallMs ?? 0,
        desyncs: g?.desyncs ?? 0, resyncs: g?.resyncs ?? 0, verified: g?.verified ?? 0, hashesCompared: g?.hashesCompared ?? 0,
        failedResyncs, rejoins, finalCheck,
      };
    },
    setup() {
      if (built) return built;
      built = {
        config: { ...config, humans: config.humans.map((hc) => ({ ...hc })) },
        bindings: [{ human: local, deviceIds: [ANY_DEVICE] }],
        hooks,
        modeData,
        onFinish,
        inputProvider: provider,
      };
      return built;
    },
    start() {
      // The warm-up after this may block the main thread for seconds: do not let either side read it as a disconnect.
      transport.expectBusy?.(LOCAL_TUNING.loadBusyMs);
      ctx.session.start(session.setup());
      if (initialRemotePause) {
        initialRemotePause = false;
        applyRemotePause(used[remote]!);
      }
      refresh();
    },
    finishAgainstCpu() {
      if (!gone || mode !== 'lockstep' || finished || ended || disposed) return false;
      mode = 'solo';
      gone = false;
      connLost = false;
      rejoinTimer = clearTimer(rejoinTimer);
      redialTimer = clearTimer(redialTimer);
      remotePausePending = false;
      clearPauseCap();
      if (inner) {
        inner.dispose(); // its sources are borrowed views: the local devices stay alive
        inner = null;
      }
      if (ctx.session.paused && ctx.session.pausedBy === remote) {
        withInternal(() => ctx.session.resume(remote));
        if (ctx.session.paused && ctx.session.pausedBy === remote) liftRemotePause = true;
      }
      log('net', `finishing against the CPU from tick ${lastTaken + 1} (human ${remote} -> CPU)`);
      // The room closes (nobody can rejoin a match that is no longer in lockstep); tell a friend who may still be
      // there first, so it gets its own Finish against CPU / End match at once instead of a 20 s rejoin wait.
      send({ type: SESSION_QUIT });
      leaveRoomSoon(LOCAL_TUNING.quitLeaveMs);
      refresh();
      return true;
    },
    endMatch() {
      endMatch('local', true);
    },
    onStatus: (fn) => statusEvents.on(fn),
    onFrame: (fn) => frameEvents.on(fn),
    onNotice: (fn) => notices.on(fn),
    whenDrained: () => drainedPromise,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const u of unsubs) u();
      unsubs.length = 0;
      clearPauseCap();
      rejoinTimer = clearTimer(rejoinTimer);
      redialTimer = clearTimer(redialTimer);
      if (!providerDisposed && !(ctx.session.active && ctx.session.getSetup() === built)) provider.dispose();
      statusEvents.clear();
      frameEvents.clear();
      notices.clear();
    },
  };
  refresh();
  return session;
}
