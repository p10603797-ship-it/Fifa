/**
 * [NET-03] Lobby flow (brief section 11): "the host taps Create Room and gets a 6-character code and a share link. The
 * friend enters the code or opens the link. Both pick teams and ready up. The host owns the match settings."
 *
 *   const lobby = createLobby({ host: true, nickname: 'Ana', clubs });          // opens a room (PeerJS, NET_CONFIG)
 *   lobby.code;                                                                  // 'K7QWMZ' -> show it + roomLink()
 *   lobby.setConfig(template); lobby.setClub(3); lobby.setReady(true);
 *   const start = await lobby.waitForStart();                                    // both ready -> host sends the seed
 *   createOnlineSession(ctx, lobby) ... ctx.session.start(session.setup());     // NET-06
 *
 * Phases: 'connecting' (guest dialling) | 'waiting' (host: room open, no friend yet) -> 'lobby' (both present, hello
 * exchanged) -> 'playing' (start sent / received; the session owns disconnects from here) -> matchEnded() -> 'lobby'
 * again for a rematch. 'closed' after leave(); 'error' with a plain-language LobbyError (the online screen shows
 * one sentence per reason, NET-07).
 *
 * Messages on the reliable channel ('lobby:' namespace; every other type is ignored):
 *  - 'lobby:hello'  { nick, game, sim, net, token? }  both sides once the transport opens. GAME_VERSION, SIM_VERSION
 *                   and NET_PROTOCOL_VERSION must match ('version-mismatch' otherwise; the transport handshake checks
 *                   the protocol string first). No hello within helloTimeoutMs -> 'disconnected'.
 *  - 'lobby:state'  { club, ready, prefs, n }  each side's own pick, ready flag and controller preferences; n = starts
 *                   this side has seen (it is back in the lobby after match n). A state of the current match number that
 *                   arrives while this side still plays the last ticks of that match is kept and applied by matchEnded()
 *                   (otherwise a friend who readied up first would look "not ready" here for good).
 *  - 'lobby:config' { config }               host -> guest: the settings template (half length, rules, night...).
 *  - 'lobby:start'  { config, delay, token, n, nick, rejoin? }  host -> guest when both are ready: the final MatchConfig with
 *                   its seed and the start input delay (computeTargetDelay from the measured round trip). Both sides
 *                   start on it (the host on sending, the guest on receipt: about rtt/2 apart). `rejoin` carries the
 *                   snapshot for a guest that reloaded mid-match (NET-06).
 *  - 'lobby:leave'  {}                       the sender is leaving (the transport closes right after).
 *  - 'lobby:reject' { reason }               host -> a guest it cannot take (a match is running and the guest is
 *                   not the one who left it: 'room-full').
 * Untrusted input: every field from the other side is validated (sanitizeConfig, clamped numbers, short strings).
 */
import { GAME_VERSION, SIM_VERSION } from '../contracts/constants';
import type { Club } from '../contracts/data';
import { AssistLevel, AutoSwitch, ControllerKind, KitSlot, MatchPhase, ModeId, PracticeKind } from '../contracts/enums';
import { createMatchConfig, type ControllerConfig, type MatchConfig } from '../contracts/state';
import { T_NET } from '../contracts/tuning';
import { computeTargetDelay } from './adaptive';
import { NET_CONFIG, type NetConfig } from './config';
import { createEmitter, NET_PROTOCOL_VERSION, reasonOf } from './packet';
import { generateRoomCode, normaliseRoomCode, secureRandom } from './roomCode';
import { createPeerTransport } from './transport';
import type { ControlMessage, NetErrorReason, NetTransport, TransportEvent } from './types';

const LOCAL_TUNING = {
  /** The other side's 'lobby:hello' must arrive within this after the transport opened, ms. */
  helloTimeoutMs: 10_000,
  /** Host: new codes tried when the broker says a code is taken. */
  codeAttempts: 3,
  /** Guest: 'room-full' retries (a host that has not yet noticed a dropped guest), and the pause between them, ms. */
  roomFullRetries: 3,
  roomFullRetryMs: 2_500,
  /** Both ready -> the host starts after this pause (an un-ready in the meantime cancels: no surprise starts), ms. */
  startCountdownMs: 1_000,
  /** Longest nickname kept, characters. */
  nicknameMax: 16,
  /** Shortest / longest half accepted from the network, minutes (tests use short halves). */
  halfMinutesMin: 0.05,
  halfMinutesMax: 10,
} as const; // TUNING-CR

export const LOBBY_HELLO = 'lobby:hello';
export const LOBBY_STATE = 'lobby:state';
export const LOBBY_CONFIG = 'lobby:config';
export const LOBBY_START = 'lobby:start';
export const LOBBY_LEAVE = 'lobby:leave';
export const LOBBY_REJECT = 'lobby:reject';

export const LOBBY_HELLO_TIMEOUT_MS: number = LOCAL_TUNING.helloTimeoutMs;
export const NICKNAME_MAX: number = LOCAL_TUNING.nicknameMax;
export const START_COUNTDOWN_MS: number = LOCAL_TUNING.startCountdownMs;

export type LobbyError =
  | 'broker-unreachable' | 'code-not-found' | 'room-full' | 'version-mismatch' | 'blocked' | 'disconnected'
  | 'code-taken' | 'unsupported';

export type LobbyPhase = 'connecting' | 'waiting' | 'lobby' | 'playing' | 'closed' | 'error';

/** Controller preferences each player brings (their own assist and auto-switch settings). */
export type ControllerPrefs = Pick<ControllerConfig, 'assist' | 'autoSwitch' | 'fastPower'>;

export interface LobbyPeer {
  nickname: string;
  /** Club index picked, -1 until chosen. */
  club: number;
  ready: boolean;
  /** Controller preferences (assist, auto switch, fast power). */
  prefs?: ControllerPrefs;
}

/** Opaque mid-match rejoin payload (NET-06 session.ts builds and reads it). */
export interface RejoinPayload {
  [field: string]: unknown;
}

/** What both sides start a match with. */
export interface LobbyStart {
  config: MatchConfig;
  transport: NetTransport;
  /** Side the local human plays: the host is home (0), the guest away (1). */
  localSide: number;
  /** Start input delay in ticks, picked by the host from the measured round trip. */
  delay: number;
  /** Per-match secret the guest presents to rejoin after a reload. */
  token: string;
  /** Starts in this lobby so far (1 for the first match, 2 for the rematch...). */
  n: number;
  /** Mid-match rejoin (guest after a reload): the host's snapshot and lockstep restart point. */
  rejoin: RejoinPayload | null;
}

/** Things that happened which are not errors (the online screen shows a short line for each). */
export type LobbyNotice =
  | { kind: 'peer-joined'; nickname: string }
  | { kind: 'peer-left' }
  /** Host: a friend tried to join but the connection could not be made (suggest the same Wi-Fi or a hotspot). */
  | { kind: 'join-blocked' }
  /** Host, during a match: a guest said hello again (it reloaded); the session decides whether to take it back. */
  | { kind: 'rejoin-request'; nickname: string; token: string }
  /** Guest: 'room-full' while a host may still be dropping a stale link; retrying. */
  | { kind: 'retrying'; attempt: number };

export interface Lobby {
  readonly code: string;
  readonly isHost: boolean;
  readonly self: LobbyPeer;
  readonly peer: LobbyPeer | null;
  setClub(club: number): void;
  setReady(ready: boolean): void;
  /** Host only: the settings both sides will play with. */
  setConfig(config: MatchConfig): void;
  onChange(fn: () => void): () => void;
  onError(fn: (err: LobbyError) => void): () => void;
  /** Resolves with the agreed config when both are ready. */
  waitForStart(): Promise<{ config: MatchConfig; transport: NetTransport; localSide: number }>;
  leave(): void;

  // ---- NET-03 additions
  readonly phase: LobbyPhase;
  readonly error: LobbyError | null;
  /** Both players are ready: the match starts in a moment (START_COUNTDOWN_MS on the host). */
  readonly starting: boolean;
  /** The host's settings template (the guest sees the host's), null until set / received. */
  readonly config: MatchConfig | null;
  /** The transport in use (replaced when the host retries a taken code). */
  readonly transport: NetTransport;
  /** The latest start (null before the first). */
  readonly started: LobbyStart | null;
  /** Every start (rematches too). */
  onStart(fn: (start: LobbyStart) => void): () => void;
  onNotice(fn: (notice: LobbyNotice) => void): () => void;
  /** Back from a match: both ready flags cleared, phase 'lobby' (or 'waiting' when the friend is gone). */
  matchEnded(): void;
  /** Host, mid-match: send a rejoin start to a guest that reloaded (NET-06). */
  sendRejoin(config: MatchConfig, delay: number, rejoin: RejoinPayload): void;
  /** Host, mid-match: refuse a guest. */
  reject(reason: LobbyError): void;
}

export interface LobbyTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LobbyOptions {
  host: boolean;
  /** Guest: the code to join (normalised). Host: a fixed code (default a random one). */
  code?: string;
  nickname: string;
  /** Transport for the first attempt (tests inject an in-memory one). */
  transport?: NetTransport;
  /** Transport factory for (re)tries (default createPeerTransport(config)). */
  createTransport?: () => NetTransport;
  /** Broker / ICE settings for the default transport (default NET_CONFIG). */
  config?: NetConfig;
  /** Clubs (formations of the picked clubs go into the final config; club indices are range-checked). */
  clubs?: readonly Club[];
  /** This player's controller preferences (assist, auto switch, fast power). */
  prefs?: Partial<ControllerPrefs>;
  /** Guest: rejoin token stored by a page that was in a match in this room (reload rejoin). */
  rejoinToken?: string;
  /** Random source in [0, 1) for codes, seeds and tokens (default crypto.getRandomValues). */
  random?: () => number;
  timers?: LobbyTimers;
  helloTimeoutMs?: number;
  /** Host: pause between both ready and the start, ms (default START_COUNTDOWN_MS). */
  startCountdownMs?: number;
  /** Diagnostics.log compatible. */
  log?: (kind: string, message: string, data?: unknown) => void;
}

const defaultTimers: LobbyTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Control, zero-width and bidi characters (never shown in a nickname). */
// eslint-disable-next-line no-control-regex
const NICK_STRIP = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g;

/** Plain-language nickname: trimmed, control characters removed, at most NICKNAME_MAX characters, never empty. */
export function cleanNickname(v: unknown, fallback = 'Player'): string {
  if (typeof v !== 'string') return fallback;
  const s = v.replace(NICK_STRIP, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s).slice(0, LOCAL_TUNING.nicknameMax).join('');
  return chars.length > 0 ? chars : fallback;
}

function intIn(v: unknown, min: number, max: number, def: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : def;
}

function prefsOf(v: unknown, def: ControllerPrefs): ControllerPrefs {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  return {
    assist: intIn(o.assist, AssistLevel.ASSISTED, AssistLevel.MANUAL, def.assist) as AssistLevel,
    autoSwitch: intIn(o.autoSwitch, AutoSwitch.OFF, AutoSwitch.AUTO, def.autoSwitch) as AutoSwitch,
    fastPower: intIn(o.fastPower, 0, 1, def.fastPower),
  };
}

const DEFAULT_PREFS: ControllerPrefs = { assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 };

/**
 * A MatchConfig from untrusted data (the network), or null when it is not one: every field must be a finite number
 * in range; clubs must index `clubCount` clubs when given. Returns a fresh object (never the input).
 */
export function sanitizeConfig(raw: unknown, clubCount = Infinity): MatchConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const base = createMatchConfig();
  const out = createMatchConfig();
  const keys = Object.keys(base) as (keyof MatchConfig)[];
  for (const k of keys) {
    if (k === 'humans') continue;
    const v = r[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    (out as unknown as Record<string, number>)[k] = v;
  }
  const maxClub = Number.isFinite(clubCount) ? clubCount - 1 : 0xffff;
  if (!Number.isInteger(out.seed) || out.seed < 0 || out.seed > 0xffffffff) return null;
  if (!Number.isInteger(out.homeClub) || out.homeClub < 0 || out.homeClub > maxClub) return null;
  if (!Number.isInteger(out.awayClub) || out.awayClub < 0 || out.awayClub > maxClub) return null;
  if (out.halfMinutes < LOCAL_TUNING.halfMinutesMin || out.halfMinutes > LOCAL_TUNING.halfMinutesMax) return null;
  if (out.replaySeconds < 0 || out.replaySeconds > 12) return null;
  for (const k of ['seed', 'mode', 'homeKit', 'awayKit', 'homeFormation', 'awayFormation', 'cupRules', 'night', 'offside', 'fouls',
    'difficulty', 'practice', 'startPhase'] as const) {
    if (!Number.isInteger(out[k]) || out[k] < 0) return null;
  }
  for (const k of ['cupRules', 'night', 'offside', 'fouls'] as const) if (out[k] > 1) return null;
  const hs = r.humans;
  if (!Array.isArray(hs) || hs.length !== 2) return null;
  out.humans = [];
  for (let i = 0; i < 2; i++) {
    const hc = hs[i] as Record<string, unknown> | null;
    if (!hc || typeof hc !== 'object') return null;
    const kind = intIn(hc.kind, ControllerKind.NONE, ControllerKind.CPU, -1);
    const side = intIn(hc.side, -1, 1, -9);
    if (kind < 0 || side === -9) return null;
    out.humans.push({ kind: kind as ControllerKind, side, ...prefsOf(hc, DEFAULT_PREFS) });
  }
  return out;
}

function copyConfig(c: MatchConfig): MatchConfig {
  return { ...c, humans: c.humans.map((hc) => ({ ...hc })) };
}

function randomToken(random: () => number): string {
  return generateRoomCode(random) + generateRoomCode(random);
}

/**
 * Open a room (host) or join one (guest). The returned lobby is live at once: phase 'waiting' (host) or 'connecting'
 * (guest); errors arrive through onError and `error`.
 */
export function createLobby(opts: LobbyOptions): Lobby {
  const isHost = !!opts.host;
  const random = opts.random ?? secureRandom;
  const timers = opts.timers ?? defaultTimers;
  const helloTimeoutMs = opts.helloTimeoutMs ?? LOCAL_TUNING.helloTimeoutMs;
  const countdownMs = Math.max(0, opts.startCountdownMs ?? LOCAL_TUNING.startCountdownMs);
  const clubs = opts.clubs ?? null;
  const log = opts.log;
  const factory = opts.createTransport ?? (opts.transport ? null : () => createPeerTransport(opts.config ?? NET_CONFIG));

  let code: string;
  if (opts.code !== undefined) {
    const c = normaliseRoomCode(opts.code);
    if (!c) throw new RangeError(`createLobby: invalid room code ${JSON.stringify(opts.code)}`);
    code = c;
  } else if (!isHost) {
    throw new RangeError('createLobby: a guest needs a room code');
  } else {
    code = generateRoomCode(random);
  }
  const fixedCode = opts.code !== undefined;

  const self: LobbyPeer = { nickname: cleanNickname(opts.nickname), club: -1, ready: false, prefs: prefsOf(opts.prefs, DEFAULT_PREFS) };
  let peer: LobbyPeer | null = null;
  let phase: LobbyPhase = isHost ? 'waiting' : 'connecting';
  let error: LobbyError | null = null;
  let template: MatchConfig | null = null;
  let started: LobbyStart | null = null;
  let starts = 0;
  let transport: NetTransport = opts.transport ?? factory!();
  let unsubs: (() => void)[] = [];
  let helloTimer: unknown = null;
  let retryTimer: unknown = null;
  let startTimer: unknown = null;
  let helloSent = false;
  let codeAttempts = 1;
  let fullRetries = 0;
  let closed = false;
  /** The friend's post-match state that arrived while this side was still playing (applied by matchEnded). */
  let earlyState: ControlMessage | null = null;

  const changes = createEmitter<void>();
  const errors = createEmitter<LobbyError>();
  const startEvents = createEmitter<LobbyStart>();
  const notices = createEmitter<LobbyNotice>();
  let waiters: { resolve: (s: LobbyStart) => void; reject: (e: Error) => void }[] = [];

  const changed = (): void => changes.emit();
  const clearHello = (): void => {
    if (helloTimer !== null) timers.clearTimeout(helloTimer);
    helloTimer = null;
  };

  function fail(reason: LobbyError, detail?: string): void {
    if (closed || phase === 'error') return;
    log?.('net', `lobby error: ${reason}${detail ? ` (${detail})` : ''}`);
    phase = 'error';
    error = reason;
    clearHello();
    cancelCountdown();
    // A failed lobby lets go of the connection at once (a refused guest must not keep the host's only seat).
    for (const u of unsubs) u();
    unsubs = [];
    try {
      transport.close();
    } catch {
      /* already closed */
    }
    const ws = waiters;
    waiters = [];
    for (const w of ws) w.reject(new Error(reason));
    errors.emit(reason);
    changed();
  }

  function send(msg: ControlMessage): void {
    if (transport.state === 'open') transport.sendReliable(msg);
  }

  function sendState(): void {
    send({ type: LOBBY_STATE, club: self.club, ready: self.ready, prefs: self.prefs, n: starts });
  }

  function sendHello(): void {
    helloSent = true;
    const msg: ControlMessage = { type: LOBBY_HELLO, nick: self.nickname, game: GAME_VERSION, sim: SIM_VERSION, net: NET_PROTOCOL_VERSION };
    if (!isHost && opts.rejoinToken) msg.token = opts.rejoinToken;
    send(msg);
    clearHello();
    helloTimer = timers.setTimeout(() => {
      helloTimer = null;
      if (phase === 'connecting' || (isHost && phase === 'waiting' && transport.state === 'open')) fail('disconnected', 'no hello');
    }, helloTimeoutMs);
  }

  function onOpened(): void {
    if (closed) return;
    log?.('net', `lobby: transport open as ${isHost ? 'host' : 'guest'} (${code})`);
    fullRetries = 0;
    sendHello();
  }

  function onHello(m: ControlMessage): void {
    const versionsMatch = m.game === GAME_VERSION && m.sim === SIM_VERSION && m.net === NET_PROTOCOL_VERSION;
    if (!versionsMatch) {
      fail('version-mismatch', `remote ${String(m.game)}/${String(m.sim)}/${String(m.net)}`);
      return;
    }
    const nickname = cleanNickname(m.nick, isHost ? 'Guest' : 'Host');
    clearHello();
    if (phase === 'playing') {
      // Host: a guest said hello mid-match -> it reloaded; the session (NET-06) decides. Guest: the host's lobby is
      // back in the room after its full time and lost the link meanwhile; answer so it sees us again (we are still
      // finishing our last ticks: matchEnded() brings us to the lobby).
      if (isHost) notices.emit({ kind: 'rejoin-request', nickname, token: typeof m.token === 'string' ? m.token.slice(0, 64) : '' });
      else sendHello();
      return;
    }
    if (!helloSent) sendHello();
    const fresh = peer === null;
    peer = { nickname, club: -1, ready: false, prefs: { ...DEFAULT_PREFS } };
    self.ready = false;
    phase = 'lobby';
    sendState();
    if (isHost && template) send({ type: LOBBY_CONFIG, config: template });
    if (fresh) notices.emit({ kind: 'peer-joined', nickname });
    changed();
  }

  function applyState(p: LobbyPeer, m: ControlMessage): void {
    const maxClub = clubs ? clubs.length - 1 : 0xffff;
    p.club = intIn(m.club, -1, maxClub, -1);
    p.ready = m.ready === true;
    p.prefs = prefsOf(m.prefs, DEFAULT_PREFS);
  }

  function onState(m: ControlMessage): void {
    if (!peer) return;
    if (phase === 'playing') {
      // The friend finished this match first and is back in the lobby (picks, maybe ready): keep it for matchEnded().
      if (starts > 0 && intIn(m.n, 0, 1_000_000, -1) >= starts) earlyState = m;
      return;
    }
    applyState(peer, m);
    changed();
    maybeStart();
  }

  function onConfig(m: ControlMessage): void {
    if (isHost) return;
    const c = sanitizeConfig(m.config, clubs ? clubs.length : Infinity);
    if (!c) {
      fail('version-mismatch', 'bad config');
      return;
    }
    template = c;
    changed();
  }

  function finalConfig(): MatchConfig {
    const c = copyConfig(template ?? createMatchConfig());
    c.mode = ModeId.FRIEND_ONLINE;
    c.seed = Math.floor(random() * 0x100000000) >>> 0;
    c.homeClub = self.club;
    c.awayClub = peer!.club;
    c.homeKit = KitSlot.HOME;
    c.awayKit = KitSlot.AWAY;
    if (clubs) {
      const hc = clubs[c.homeClub];
      const ac = clubs[c.awayClub];
      if (hc) c.homeFormation = hc.formation;
      if (ac) c.awayFormation = ac.formation;
    }
    c.humans = [
      { kind: ControllerKind.HUMAN, side: 0, ...prefsOf(self.prefs, DEFAULT_PREFS) },
      { kind: ControllerKind.HUMAN, side: 1, ...prefsOf(peer!.prefs, DEFAULT_PREFS) },
    ];
    c.practice = PracticeKind.NONE;
    c.startPhase = MatchPhase.KICK_OFF;
    return c;
  }

  function startDelay(): number {
    if (!(transport.rtt > 0)) return T_NET.delayInitial;
    return computeTargetDelay(transport.rtt, transport.jitter);
  }

  function emitStart(s: LobbyStart): void {
    started = s;
    phase = 'playing';
    earlyState = null;
    const ws = waiters;
    waiters = [];
    for (const w of ws) w.resolve(s);
    startEvents.emit(s);
    changed();
  }

  function canStart(): boolean {
    return phase === 'lobby' && peer !== null && self.ready && peer.ready && self.club >= 0 && peer.club >= 0 &&
      transport.state === 'open';
  }

  function cancelCountdown(): void {
    if (startTimer !== null) timers.clearTimeout(startTimer);
    startTimer = null;
  }

  /** Host: both ready -> start after the countdown, if both are still ready then. */
  function maybeStart(): void {
    if (!isHost) return;
    if (!canStart()) {
      cancelCountdown();
      return;
    }
    if (startTimer !== null) return;
    startTimer = timers.setTimeout(() => {
      startTimer = null;
      if (!closed && canStart()) doStart();
    }, countdownMs);
  }

  function doStart(): void {
    const config = finalConfig();
    const delay = startDelay();
    const token = randomToken(random);
    starts++;
    send({ type: LOBBY_START, config, delay, token, n: starts, nick: self.nickname });
    log?.('net', `lobby: start seed ${config.seed} delay ${delay} (rtt ${transport.rtt.toFixed(0)} ms)`);
    emitStart({ config, transport, localSide: 0, delay, token, n: starts, rejoin: null });
  }

  function onStart(m: ControlMessage): void {
    if (isHost) return;
    if (phase === 'playing' && !m.rejoin) return;
    const config = sanitizeConfig(m.config, clubs ? clubs.length : Infinity);
    if (!config) {
      fail('version-mismatch', 'bad start config');
      return;
    }
    const delay = intIn(m.delay, T_NET.delayMin, T_NET.delayMax, T_NET.delayInitial);
    const token = typeof m.token === 'string' ? m.token.slice(0, 64) : '';
    starts = intIn(m.n, 1, 1_000_000, starts + 1);
    const rejoin = m.rejoin && typeof m.rejoin === 'object' ? (m.rejoin as RejoinPayload) : null;
    if (!peer) peer = { nickname: cleanNickname(m.nick, 'Host'), club: config.homeClub, ready: true, prefs: { ...DEFAULT_PREFS } };
    clearHello();
    emitStart({ config, transport, localSide: 1, delay, token, n: starts, rejoin });
  }

  function onLeave(): void {
    if (phase === 'playing') {
      notices.emit({ kind: 'peer-left' });
      return;
    }
    peerGone();
  }

  /** The friend left or dropped outside a match. */
  function peerGone(): void {
    const had = peer !== null;
    peer = null;
    self.ready = false;
    cancelCountdown();
    if (isHost) {
      if (phase === 'lobby' || phase === 'waiting') {
        phase = 'waiting';
        helloSent = false;
        if (had) notices.emit({ kind: 'peer-left' });
        changed();
        listenForGuest();
      }
    } else {
      fail('disconnected', 'host left');
    }
  }

  /** Host: keep the room open for the next guest (or the same one rejoining). */
  function listenForGuest(): void {
    if (closed || !isHost) return;
    transport.reconnect().catch((err: unknown) => {
      if (!closed && phase === 'waiting') fail(reasonOf(err) as LobbyError, 'room lost');
    });
  }

  function onReliable(m: ControlMessage): void {
    if (closed || typeof m.type !== 'string' || !m.type.startsWith('lobby:')) return;
    switch (m.type) {
      case LOBBY_HELLO: onHello(m); break;
      case LOBBY_STATE: onState(m); break;
      case LOBBY_CONFIG: onConfig(m); break;
      case LOBBY_START: onStart(m); break;
      case LOBBY_LEAVE: onLeave(); break;
      case LOBBY_REJECT: if (!isHost) fail(isRejectReason(m.reason) ? m.reason : 'room-full', 'rejected'); break;
      default: break;
    }
  }

  function onEvent(e: TransportEvent): void {
    if (closed) return;
    if (e.type === 'disconnected') {
      if (phase === 'playing') return; // the session (NET-06) owns disconnects during a match
      if (phase === 'lobby' || (isHost && phase === 'waiting')) peerGone();
      else if (!isHost && phase === 'connecting' && helloSent) fail('disconnected');
    } else if (e.type === 'connected') {
      if (phase === 'playing') return;
      if (isHost && phase === 'waiting') onOpened();
    } else if (e.type === 'error') {
      if (isHost && e.reason === 'blocked' && transport.state !== 'failed') notices.emit({ kind: 'join-blocked' });
    }
  }

  function attach(t: NetTransport): void {
    for (const u of unsubs) u();
    unsubs = [t.onReliable(onReliable), t.onEvent(onEvent)];
  }

  function open(): void {
    attach(transport);
    const t = transport;
    t.open(isHost ? 'host' : 'guest', code).then(
      () => {
        if (t !== transport || closed) return;
        if (!isHost) onOpened();
        // Host: the 'connected' event already said hello (it fires before open() resolves).
        else if (!helloSent) onOpened();
      },
      (err: unknown) => {
        if (t !== transport || closed) return;
        const reason = reasonOf(err) as LobbyError;
        if (isHost && reason === 'code-taken' && !fixedCode && factory && codeAttempts < LOCAL_TUNING.codeAttempts) {
          codeAttempts++;
          code = generateRoomCode(random);
          log?.('net', `lobby: code taken, trying ${code}`);
          try {
            t.close();
          } catch {
            /* already failed */
          }
          transport = factory();
          changed();
          open();
          return;
        }
        if (!isHost && reason === 'room-full' && factory && fullRetries < LOCAL_TUNING.roomFullRetries) {
          fullRetries++;
          notices.emit({ kind: 'retrying', attempt: fullRetries });
          retryTimer = timers.setTimeout(() => {
            retryTimer = null;
            if (closed || t !== transport) return;
            try {
              t.close();
            } catch {
              /* already failed */
            }
            transport = factory();
            open();
          }, LOCAL_TUNING.roomFullRetryMs);
          return;
        }
        fail(reason, err instanceof Error ? err.message : String(err));
      },
    );
  }

  const lobby: Lobby = {
    get code() { return code; },
    isHost,
    self,
    get peer() { return peer; },
    get phase() { return phase; },
    get error() { return error; },
    get starting() { return phase === 'lobby' && peer !== null && self.ready && peer.ready && self.club >= 0 && peer.club >= 0; },
    get config() { return template; },
    get transport() { return transport; },
    get started() { return started; },
    setClub(club) {
      const maxClub = clubs ? clubs.length - 1 : 0xffff;
      const c = intIn(club, -1, maxClub, self.club);
      if (c === self.club || phase === 'playing') return;
      self.club = c;
      if (self.club < 0) self.ready = false;
      sendState();
      changed();
      maybeStart();
    },
    setReady(ready) {
      const r = !!ready && self.club >= 0;
      if (r === self.ready || phase === 'playing') return;
      self.ready = r;
      sendState();
      changed();
      maybeStart();
    },
    setConfig(config) {
      if (!isHost) return;
      template = copyConfig(config);
      send({ type: LOBBY_CONFIG, config: template });
      changed();
    },
    onChange: (fn) => changes.on(fn),
    onError: (fn) => errors.on(fn),
    onStart: (fn) => startEvents.on(fn),
    onNotice: (fn) => notices.on(fn),
    waitForStart() {
      if (phase === 'error' || phase === 'closed') return Promise.reject(new Error(error ?? 'disconnected'));
      return new Promise<LobbyStart>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    matchEnded() {
      if (closed || phase !== 'playing') return;
      self.ready = false;
      if (peer) peer.ready = false;
      const early = earlyState;
      earlyState = null;
      if (transport.state === 'open' && peer) {
        phase = 'lobby';
        if (early) applyState(peer, early);
        sendState();
        changed();
        maybeStart();
        return;
      } else if (isHost) {
        peer = null;
        phase = 'waiting';
        helloSent = false;
        listenForGuest();
      } else {
        phase = 'lobby';
        fail('disconnected', 'host gone after the match');
        return;
      }
      changed();
    },
    sendRejoin(config, delay, rejoin) {
      if (!isHost || transport.state !== 'open') return;
      const token = started?.token ?? randomToken(random);
      send({ type: LOBBY_START, config, delay, token, n: starts, rejoin, nick: self.nickname });
    },
    reject(reason) {
      if (isHost) send({ type: LOBBY_REJECT, reason });
    },
    leave() {
      if (closed) return;
      send({ type: LOBBY_LEAVE });
      closed = true;
      clearHello();
      cancelCountdown();
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      retryTimer = null;
      for (const u of unsubs) u();
      unsubs = [];
      try {
        transport.close();
      } catch {
        /* closing twice is fine */
      }
      const ws = waiters;
      waiters = [];
      for (const w of ws) w.reject(new Error('disconnected'));
      phase = 'closed';
      changed();
    },
  };

  open();
  return lobby;
}

function isRejectReason(v: unknown): v is LobbyError {
  return typeof v === 'string' && ['room-full', 'version-mismatch', 'disconnected', 'code-not-found'].includes(v);
}

/** The reason as a LobbyError (unknown values read as 'disconnected'). */
export function lobbyErrorOf(reason: NetErrorReason | string): LobbyError {
  return reasonOf(new Error(reason)) as LobbyError;
}

