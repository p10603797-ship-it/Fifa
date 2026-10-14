/**
 * [NET-07] Online screens (brief sections 11 and 12): create / join a room, the lobby, connection status, the waiting
 * indicator during stalls and a plain-language screen for every failure. The only file outside src/net that imports
 * src/net (local play works with the network code removed).
 *
 * Views of the 'online-lobby' screen (one screen, Back always works, every control is a 60 pt focus stop):
 *  - home        nickname, Create room, Join room, a Rejoin button after a reload mid-match, the privacy line.
 *  - join        the 6-character code: six slots, an on-screen keypad (touch and controller; LEFT / RIGHT wrap along
 *                a row) and the hardware keyboard (letters, digits, Backspace, Enter); joins by itself on the 6th
 *                character. ?room=CODE (a share link) or params.room skips straight to joining.
 *  - connecting  "Joining room ABC DEF…" with Cancel.
 *  - lobby       the code large plus the share link with Copy and Share (navigator.share where available), both
 *                nicknames, each player's club, the host's settings (half length, rules, night, replays; read-only
 *                for the guest), Ready, connection quality, status line and the privacy line.
 *  - error       one plain sentence per LobbyError (broker unreachable, code not found, room full, version mismatch,
 *                connection blocked by the network: same Wi-Fi or a phone hotspot, ...) with Try again and Back.
 *
 * The room (lobby + online session) outlives the screen: the match screens replace this one while a match runs, and the
 * full-time "Change teams" button comes back here to the same room for a rematch. During a match a small overlay in #ui
 * shows the waiting / reconnecting / pause pill (createNetIndicator, also exported for the match HUD) and the "Finish
 * against CPU / End match" card after the 20 s rejoin window.
 *
 * Test hook (e2e, never set in production): window.__dotkickNetTest = { createTransport(role), config, code,
 * startCountdownMs } replaces the PeerJS transport (an in-page fake) or the broker settings (a local PeerServer).
 * window.__dotkickOnline exposes a read-only view of the room for tests and diagnostics.
 */
import { UiSound, type AppContext, type Screen, type ScreenParams } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { createMatchConfig, type MatchConfig } from '../../contracts/state';
import { createNetConfig, type NetConfig } from '../../net/config';
import { cleanNickname, createLobby, NICKNAME_MAX, type Lobby, type LobbyError, type LobbyNotice } from '../../net/lobby';
import {
  formatRoomCode, isRoomCodeChar, normaliseRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, roomCodeFromUrl, roomLink, urlWithoutRoom,
} from '../../net/roomCode';
import { createOnlineSession, onlineSupported, type OnlineSession, type OnlineStatus } from '../../net/session';
import { createPeerTransport } from '../../net/transport';
import type { NetTransport } from '../../net/types';
import { attachDotField, sharedDotField } from '../dotfield';
import {
  closeTopModal, copyText, createBackButton, createButton, createSelector, createToggle, h, injectStyle, openModal, showToast,
  type ModalHandle,
} from '../components';

// ============================================================ plain-language texts

export interface ErrorText {
  title: string;
  body: string;
}

/** One title and one plain sentence (or two) per failure (brief section 11: "Every failure has a plain-language screen"). */
export const ONLINE_ERROR_TEXT: Readonly<Record<LobbyError, ErrorText>> = {
  'broker-unreachable': {
    title: 'Can\'t reach the matchmaking server',
    body: 'Check that this iPad is online and try again. The free server that introduces the two devices may also be busy for a moment.',
  },
  'code-not-found': {
    title: 'Room not found',
    body: 'No room has that code. Check the code with your friend, or ask them to create a new room.',
  },
  'room-full': {
    title: 'Room is full',
    body: 'Two players are already in this room. Ask your friend for the code of a new room.',
  },
  'version-mismatch': {
    title: 'Different game versions',
    body: 'You and your friend are running different versions of DotKick. Both of you reload the game to update, then try again.',
  },
  blocked: {
    title: 'The network blocked the connection',
    body: 'Your devices could not connect to each other. Join the same Wi-Fi network, or use a phone hotspot, then try again.',
  },
  disconnected: {
    title: 'Connection lost',
    body: 'Your friend left the room or the connection dropped.',
  },
  'code-taken': {
    title: 'Could not create a room',
    body: 'That room code is already in use. Try again to get a new code.',
  },
  unsupported: {
    title: 'Online play isn\'t available here',
    body: 'This browser cannot make peer-to-peer connections. Update Safari, or play a friend on this iPad instead.',
  },
};

export function errorText(reason: LobbyError): ErrorText {
  return ONLINE_ERROR_TEXT[reason] ?? ONLINE_ERROR_TEXT.disconnected;
}

/** The privacy line (brief section 11; the README explains IP exposure in full). */
export const PRIVACY_LINE =
  'Peer to peer: your friend\'s device connects straight to yours and can see your IP address, so share codes only with people you know. Only your nickname and game inputs are sent. No chat, no accounts.';

/** The room code carried by the page URL (a share link), for the splash / boot to open this screen. */
export function shareLinkRoom(href?: string): string | null {
  const url = href ?? (typeof location !== 'undefined' ? location.href : '');
  return roomCodeFromUrl(url);
}

/** Why the friend is gone, in plain words (the pill and the Finish against CPU / End match card). Pure. */
export function goneTitle(s: Readonly<OnlineStatus>): string {
  if (s.reason === 'quit') return `${s.opponent} left the match`;
  if (s.reason === 'unresponsive') return `${s.opponent} is not responding`;
  return `${s.opponent} did not come back`;
}

/** Short status line for the match pill / HUD indicator ('' = hidden). Pure. */
export function statusLine(s: Readonly<OnlineStatus>, localHuman: number): string {
  const secs = (ms: number): number => Math.max(0, Math.ceil(ms / 1000));
  switch (s.kind) {
    case 'stalled':
      return `Waiting for ${s.opponent}…`;
    case 'reconnecting':
      return `Connection lost · waiting for ${s.opponent} to rejoin · ${secs(s.rejoinLeftMs)} s`;
    case 'paused':
      if (s.pausedBy < 0) return '';
      if (s.pausedBy === localHuman) return `You paused · ${secs(s.pauseLeftMs)} s left`;
      return `${s.opponent} paused · resumes in ${secs(s.pauseLeftMs)} s`;
    case 'opponent-gone':
      return goneTitle(s);
    case 'solo':
      return 'Finishing against the CPU';
    default:
      return '';
  }
}

// ============================================================ HUD indicator

export interface NetIndicator {
  readonly el: HTMLElement;
  /** Show the status (DOM writes only when the text changes). */
  update(status: Readonly<OnlineStatus>, localHuman: number): void;
  /** A short notice for a couple of seconds ("No pauses left"). */
  notify(text: string, nowMs: number): void;
  dispose(): void;
}

const NOTICE_MS = 2600;

/** Small DOM pill for the waiting / reconnecting / pause state; the match HUD may mount `el` where it likes. */
export function createNetIndicator(): NetIndicator {
  const dot = h('span', { class: 'net-pill__dot', attrs: { 'aria-hidden': 'true' } });
  const text = h('span', { class: 'net-pill__text' });
  const el = h('div', { class: 'net-pill', testId: 'net-indicator', attrs: { role: 'status', 'aria-live': 'polite' } }, dot, text);
  let shown = '';
  let kind = '';
  let notice = '';
  let noticeUntil = 0;
  const write = (t: string, k: string): void => {
    if (t !== shown) {
      shown = t;
      text.textContent = t;
      el.classList.toggle('is-on', t.length > 0);
    }
    if (k !== kind) {
      if (kind) el.classList.remove(`net-pill--${kind}`);
      kind = k;
      if (k) el.classList.add(`net-pill--${k}`);
      el.dataset.kind = k;
    }
  };
  return {
    el,
    update(s, localHuman) {
      const now = typeof performance !== 'undefined' ? performance.now() : 0;
      const line = statusLine(s, localHuman);
      if (line) write(line, s.kind);
      else if (notice && now < noticeUntil) write(notice, 'notice');
      else {
        notice = '';
        write('', '');
      }
    },
    notify(t, nowMs) {
      notice = t;
      noticeUntil = nowMs + NOTICE_MS;
      write(t, 'notice');
    },
    dispose() {
      el.remove();
    },
  };
}

// ============================================================ test hook

/** e2e hook: an in-page transport or broker settings instead of the public PeerJS broker. */
export interface NetTestHook {
  createTransport?: (role: 'host' | 'guest') => NetTransport;
  config?: Partial<NetConfig>;
  code?: string;
  startCountdownMs?: number;
  /** Read by test transports only: make the next open() fail with this reason. */
  failOpen?: string;
}

export interface OnlineDebugView {
  phase(): string | null;
  code(): string | null;
  isHost(): boolean | null;
  peer(): string | null;
  status(): string | null;
  stats(): OnlineSession['stats'] | null;
  session(): OnlineSession | null;
  /** The room's lobby (tests shorten the host's settings through it). */
  lobby(): Lobby | null;
}

declare global {
  interface Window {
    __dotkickNetTest?: NetTestHook;
    __dotkickOnline?: OnlineDebugView;
  }
}

function testHook(): NetTestHook | null {
  return typeof window !== 'undefined' && window.__dotkickNetTest ? window.__dotkickNetTest : null;
}

// ============================================================ the room (outlives the screen)

const REJOIN_KEY = 'dotkick-net-rejoin';
const REJOIN_MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface RejoinRecord {
  code: string;
  token: string;
  at: number;
}

function readRejoin(): RejoinRecord | null {
  try {
    const raw = sessionStorage.getItem(REJOIN_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<RejoinRecord>;
    if (typeof r.code !== 'string' || typeof r.token !== 'string' || typeof r.at !== 'number') return null;
    if (!normaliseRoomCode(r.code) || Date.now() - r.at > REJOIN_MAX_AGE_MS) return null;
    return { code: r.code, token: r.token, at: r.at };
  } catch {
    return null;
  }
}

function writeRejoin(r: RejoinRecord | null): void {
  try {
    if (r) sessionStorage.setItem(REJOIN_KEY, JSON.stringify(r));
    else sessionStorage.removeItem(REJOIN_KEY);
  } catch {
    /* storage blocked: rejoin after a reload just will not be offered */
  }
}

function clearRoomFromUrl(): void {
  try {
    if (roomCodeFromUrl(location.href)) history.replaceState(history.state, '', urlWithoutRoom(location.href));
  } catch {
    /* no history API */
  }
}

interface Room {
  ctx: AppContext;
  lobby: Lobby;
  os: OnlineSession | null;
  overlay: MatchOverlay | null;
  unsubs: (() => void)[];
  /** The screen is mounted (a full-time Quit without coming back here leaves the room). */
  screenMounted: boolean;
  /** The lobby closed (left, or Finish against CPU) while its match may still be running. */
  closed: boolean;
}

let room: Room | null = null;
/** The screen currently mounted (it re-renders on room changes). */
let activeView: { render(): void } | null = null;

function defaultTemplate(ctx: AppContext): MatchConfig {
  const c = createMatchConfig();
  const m = ctx.settings.get().match;
  c.halfMinutes = Math.max(2, Math.min(10, Math.round(m.halfMinutes || 4)));
  c.offside = m.offside ? 1 : 0;
  c.fouls = m.fouls ? 1 : 0;
  c.night = m.night ? 1 : 0;
  c.replaySeconds = m.replays ? 8 : 0;
  c.difficulty = m.difficulty;
  return c;
}

function nicknameOf(ctx: AppContext): string {
  try {
    return cleanNickname(ctx.settings.get().nickname, '');
  } catch {
    return '';
  }
}

function randomNickname(): string {
  return `Player ${100 + Math.floor(Math.random() * 900)}`;
}

function openRoom(ctx: AppContext, host: boolean, code?: string): Room {
  leaveRoom();
  const hook = testHook();
  const s = ctx.settings.get();
  const rejoin = !host && code ? readRejoin() : null;
  const factory = hook?.createTransport
    ? () => hook.createTransport!(host ? 'host' : 'guest')
    : () => createPeerTransport(createNetConfig(hook?.config ?? {}));
  const lobby = createLobby({
    host,
    code: host ? hook?.code ?? code : code,
    nickname: nicknameOf(ctx) || randomNickname(),
    createTransport: factory,
    clubs: ctx.clubs,
    prefs: { assist: s.controls.assist, autoSwitch: s.controls.autoSwitch, fastPower: s.controls.touch?.fastPowerBar ? 1 : 0 },
    rejoinToken: rejoin && rejoin.code === code ? rejoin.token : undefined,
    startCountdownMs: hook?.startCountdownMs,
    log: (kind, message, data) => {
      try {
        ctx.diagnostics.log(kind, message, data);
      } catch {
        /* diagnostics never break the lobby */
      }
    },
  });
  const r: Room = { ctx, lobby, os: null, overlay: null, unsubs: [], screenMounted: true, closed: false };
  room = r;
  if (host) {
    lobby.setConfig(defaultTemplate(ctx));
    lobby.setClub(clampClub(ctx.clubs, s.match.homeClub));
  } else {
    lobby.setClub(clampClub(ctx.clubs, s.match.awayClub));
  }
  r.unsubs.push(
    lobby.onChange(() => {
      if (lobby.phase === 'closed') roomClosed(r);
      activeView?.render();
    }),
    lobby.onError(() => activeView?.render()),
    lobby.onNotice((n) => onLobbyNotice(r, n)),
    lobby.onStart(() => startMatch(r)),
  );
  return r;
}

function clampClub(clubs: readonly Club[], i: number): number {
  return Number.isInteger(i) && i >= 0 && i < clubs.length ? i : 0;
}

function onLobbyNotice(r: Room, n: LobbyNotice): void {
  if (room !== r || !r.screenMounted) return;
  // (A friend joining shows in the lobby itself: the friend card fills in.)
  if (n.kind === 'peer-left') showToast('Your friend left the room', { kind: 'warning', testId: 'net-toast' });
  else if (n.kind === 'join-blocked') {
    showToast('A friend tried to join but the network blocked it: try the same Wi-Fi or a phone hotspot', { kind: 'warning', testId: 'net-toast' });
  } else if (n.kind === 'retrying') showToast('The room is busy, trying again…', { kind: 'info', testId: 'net-toast' });
}

/** The room's match is still being played here (finishing against the CPU after the room closed). */
function matchRunning(r: Room): boolean {
  const os = r.os;
  if (!os) return false;
  const k = os.status.kind;
  return k !== 'finished' && k !== 'ended' && r.ctx.session.active && r.ctx.session.getSetup()?.inputProvider === os.provider;
}

function roomClosed(r: Room): void {
  if (room !== r) return;
  if (!r.closed) {
    r.closed = true;
    for (const u of r.unsubs) u();
    r.unsubs.length = 0;
    writeRejoin(null);
    clearRoomFromUrl();
  }
  if (matchRunning(r)) return; // keep the session and its overlay until that match is over
  finalizeRoom(r);
}

function finalizeRoom(r: Room): void {
  if (room !== r) return;
  for (const u of r.unsubs) u();
  r.unsubs.length = 0;
  r.overlay?.dispose();
  r.overlay = null;
  const os = r.os;
  r.os = null;
  if (os) void os.whenDrained().then(() => os.dispose());
  room = null;
  writeRejoin(null);
  clearRoomFromUrl();
}

/** Leave the current room (tell the friend, close the connection). */
function leaveRoom(): void {
  const r = room;
  if (!r) return;
  if (r.lobby.phase !== 'closed') r.lobby.leave();
  roomClosed(r);
  if (room === r && r.closed && !matchRunning(r)) finalizeRoom(r);
}

function startMatch(r: Room): void {
  if (room !== r) return;
  const ctx = r.ctx;
  r.os?.dispose();
  r.overlay?.dispose();
  const os: OnlineSession = createOnlineSession(ctx, r.lobby, {
    onFinish: (_summary, quit) => {
      if (!quit || room !== r) return;
      if (r.closed) {
        finalizeRoom(r); // a match finished against the CPU (or ended) after the room had closed
        return;
      }
      // Full time, then Quit (main menu) or Rematch (back here): leave the room unless this screen comes back. Wait for
      // the provider's drain first (a friend a few ticks behind still needs our last frames). A finished match leaves
      // even while its lobby still waits for the link (lobby 'playing'); a mid-match quit closes the room itself.
      r.screenMounted = false;
      const finishedMatch = os.status.kind === 'finished';
      void os.whenDrained().then(() => {
        if (room === r && !r.screenMounted && (r.lobby.phase !== 'playing' || finishedMatch)) leaveRoom();
      });
    },
  });
  r.os = os;
  if (!r.lobby.isHost && r.lobby.started) writeRejoin({ code: r.lobby.code, token: r.lobby.started.token, at: Date.now() });
  r.overlay = createMatchOverlay(ctx, os);
  os.onStatus((s) => {
    if (s.kind === 'finished') writeRejoin(null);
    if (s.kind === 'ended' && s.reason === 'desync') {
      showToast('The two games got out of step and could not recover, so the match was ended.', { kind: 'error', testId: 'net-toast', lifeMs: 6000 });
    }
  });
  os.start();
}

function exposeDebug(): void {
  if (typeof window === 'undefined') return;
  window.__dotkickOnline = {
    phase: () => room?.lobby.phase ?? null,
    code: () => room?.lobby.code ?? null,
    isHost: () => (room ? room.lobby.isHost : null),
    peer: () => room?.lobby.peer?.nickname ?? null,
    status: () => room?.os?.status.kind ?? null,
    stats: () => room?.os?.stats ?? null,
    session: () => room?.os ?? null,
    lobby: () => room?.lobby ?? null,
  };
}

exposeDebug();

// ============================================================ match overlay

interface MatchOverlay {
  dispose(): void;
}

function createMatchOverlay(ctx: AppContext, os: OnlineSession): MatchOverlay {
  const host = (typeof document !== 'undefined' && document.getElementById('ui')) || document.body;
  const root = h('div', { class: 'net-overlay', testId: 'net-overlay' });
  const pill = createNetIndicator();
  root.append(pill.el);
  host.append(root);
  let modal: ModalHandle | null = null;
  const local = os.localHuman;
  const closeModal = (): void => {
    modal?.close();
    modal = null;
  };
  const showGone = (s: Readonly<OnlineStatus>): void => {
    if (modal?.open) return;
    modal = openModal(ctx, {
      host: root,
      title: goneTitle(s),
      body: s.reason === 'unresponsive'
        ? 'Their game stopped sending moves. If they come back, play goes on by itself. Or finish the match against the CPU, or end it here.'
        : 'Finish the match against the CPU, or end it here.',
      dismissible: false,
      testId: 'net-gone',
      actions: [
        { label: 'Finish against CPU', primary: true, testId: 'net-finish-cpu', onSelect: () => os.finishAgainstCpu() },
        { label: 'End match', variant: 'danger', testId: 'net-end-match', onSelect: () => os.endMatch() },
      ],
    });
  };
  const unsubs = [
    os.onFrame((s) => pill.update(s, local)),
    os.onStatus((s) => {
      pill.update(s, local);
      if (s.kind === 'opponent-gone') showGone(s);
      else closeModal();
    }),
    os.onNotice((t) => pill.notify(t, typeof performance !== 'undefined' ? performance.now() : 0)),
  ];
  return {
    dispose() {
      for (const u of unsubs) u();
      closeModal();
      pill.dispose();
      root.remove();
    },
  };
}

// ============================================================ the screen

type View = 'home' | 'join' | 'connecting' | 'lobby' | 'error';

const CSS = `
.net-screen { justify-content: flex-start; gap: var(--space-4); }
.net-screen .ui-title { margin-top: var(--space-2); }
.net-home { display: flex; flex-direction: column; gap: var(--space-4); align-items: stretch; width: min(520px, 90vw); margin: auto 0; }
.net-field { display: flex; flex-direction: column; gap: var(--space-2); }
.net-field label { font-size: var(--fs-sm); color: var(--text-2); }
.net-input { min-height: var(--target); box-sizing: border-box; padding: 0 var(--space-4); border-radius: var(--radius);
  background: var(--surface-2); color: var(--text-1); border: var(--line) solid var(--hairline-strong); font: var(--fw-medium) var(--fs-md) / 1 var(--font-ui);
  -webkit-user-select: text; user-select: text; touch-action: manipulation; }
.net-input:focus { outline: none; border-color: var(--ember); }
.net-privacy { margin: 0; font-size: var(--fs-xs); color: var(--text-3); text-align: center; max-width: 46em; line-height: var(--lh); }
.net-slots { display: flex; gap: var(--space-2); justify-content: center; }
.net-slot { width: 64px; height: 76px; display: flex; align-items: center; justify-content: center; border-radius: var(--radius);
  background: var(--surface-2); border: var(--line) solid var(--hairline-strong); font: var(--fw-num-bold) 40px / 1 var(--font-num); color: var(--text-1); }
.net-slot.is-next { border-color: var(--ember); box-shadow: 0 0 0 2px var(--ember-soft); }
.net-slot--gap { margin-left: var(--space-4); }
.net-keypad { display: grid; grid-template-columns: repeat(11, minmax(56px, 66px)); gap: var(--space-2); justify-content: center; }
.net-keypad .btn { min-width: 0; padding: 0; font: var(--fw-num-bold) var(--fs-lg) / 1 var(--font-num); }
.net-keypad .net-key--wide { grid-column: span 2; font: var(--fw-medium) var(--fs-sm) / 1 var(--font-ui); }
.net-connecting { display: flex; flex-direction: column; align-items: center; gap: var(--space-5); margin: auto 0; }
.net-spinner { display: flex; gap: 10px; }
.net-spinner span { width: 12px; height: 12px; border-radius: 50%; background: var(--ember); animation: net-bounce 1.2s var(--ease) infinite; }
.net-spinner span:nth-child(2) { animation-delay: 0.15s; }
.net-spinner span:nth-child(3) { animation-delay: 0.3s; }
@keyframes net-bounce { 0%, 80%, 100% { transform: scale(0.5); opacity: 0.4; } 40% { transform: scale(1); opacity: 1; } }
.net-lobby { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: var(--space-5); width: min(1040px, 94vw);
  min-height: 0; flex: 1 1 auto; }
.net-col { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; min-height: 0; }
.net-code-card { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); border-radius: var(--radius-lg);
  background: var(--surface-1); border: var(--line) solid var(--hairline); }
.net-code { font: var(--fw-num-bold) 56px / 1 var(--font-num); letter-spacing: 0.08em; color: var(--text-1); }
.net-link { font: 13px / 1.3 var(--font-num); color: var(--text-2); word-break: break-all; -webkit-user-select: text; user-select: text; }
.net-share { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.net-players { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.net-player { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); border-radius: var(--radius-lg);
  background: var(--surface-1); border: var(--line) solid var(--hairline); min-width: 0; }
.net-player--p1 { border-color: var(--p1-soft); }
.net-player--p2 { border-color: var(--p2-soft); }
.net-player__who { font: var(--fw-bold) var(--fs-xs) / 1 var(--font-ui); letter-spacing: var(--tracking-caps); text-transform: uppercase; }
.net-player--p1 .net-player__who { color: var(--p1); }
.net-player--p2 .net-player__who { color: var(--p2); }
.net-player__name { font-size: var(--fs-md); font-weight: var(--fw-bold); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.net-player__club { font-size: var(--fs-sm); color: var(--text-2); min-height: 1.3em; }
.net-badge { align-self: flex-start; padding: 4px 10px; border-radius: var(--radius-pill); font-size: var(--fs-xs); font-weight: var(--fw-bold);
  background: var(--surface-3); color: var(--text-2); }
.net-badge.is-ready { background: var(--success-soft); color: var(--success); }
.net-status { margin: 0; font-size: var(--fs-sm); color: var(--text-2); min-height: 1.3em; }
.net-quality { font: 12px / 1 var(--font-num); color: var(--text-3); }
.net-settings { display: flex; flex-direction: column; gap: var(--space-2); }
.net-settings-ro { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-4); border-radius: var(--radius-lg);
  background: var(--surface-1); border: var(--line) solid var(--hairline); font-size: var(--fs-sm); color: var(--text-2); }
.net-settings-ro b { color: var(--text-1); font-weight: var(--fw-medium); }
.net-error { display: flex; flex-direction: column; align-items: center; gap: var(--space-4); margin: auto 0; max-width: 40em; text-align: center; }
.net-error__icon { width: 56px; height: 56px; border-radius: 50%; border: 3px solid var(--error); display: flex; align-items: center; justify-content: center;
  color: var(--error); font: var(--fw-bold) 30px / 1 var(--font-ui); }
.net-overlay { position: absolute; inset: 0; pointer-events: none; z-index: var(--z-toast); }
.net-overlay > .modal-scrim { pointer-events: auto; }
.net-pill { position: absolute; top: calc(var(--safe-top, 0px) + var(--space-4)); left: 50%; display: flex; align-items: center; gap: var(--space-2);
  max-width: min(640px, 70vw); padding: 8px 16px; border-radius: var(--radius-pill); background: rgba(7, 7, 13, 0.82);
  border: var(--line) solid var(--hairline-strong); color: var(--text-1); font: var(--fw-medium) var(--fs-sm) / 1.2 var(--font-ui);
  transform: translate(-50%, -8px); opacity: 0; transition: opacity var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease); pointer-events: none; }
.net-pill.is-on { opacity: 1; transform: translate(-50%, 0); }
.net-pill__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--warning); flex: 0 0 auto; animation: net-pulse 1s ease-in-out infinite; }
.net-pill--reconnecting .net-pill__dot, .net-pill--opponent-gone .net-pill__dot { background: var(--error); }
.net-pill--paused .net-pill__dot, .net-pill--notice .net-pill__dot { background: var(--cyan); animation: none; }
.net-pill__text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@keyframes net-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
@media (max-width: 900px) {
  .net-lobby { grid-template-columns: 1fr; overflow-y: auto; }
  .net-keypad { grid-template-columns: repeat(8, minmax(52px, 62px)); }
}
@media (max-height: 700px) {
  .net-code { font-size: 40px; }
  .net-slot { height: 64px; width: 54px; font-size: 32px; }
  .net-screen { gap: var(--space-3); }
}
`;

/** Join codes: keypad order (the alphabet: 23 letters then 8 digits). */
const KEYS = ROOM_CODE_ALPHABET.split('');

export function createOnlineScreen(): Screen {
  let ctxRef: AppContext | null = null;
  let rootEl: HTMLElement | null = null;
  let detachField: (() => void) | null = null;
  let view: View = 'home';
  let typed = '';
  let lastJoin = '';
  let lastWasHost = false;
  let keyHandler: ((e: KeyboardEvent) => void) | null = null;
  let qualityEl: HTMLElement | null = null;
  let lastQuality = '';
  let lastQualityAt = 0;
  const renderer = { render: () => render() };

  function setView(v: View): void {
    view = v;
    render();
  }

  function currentView(): View {
    if (unsupported) return 'error';
    if (room && !room.closed) return lobbyView(room);
    return view === 'join' ? 'join' : 'home';
  }

  function lobbyView(r: Room): View {
    switch (r.lobby.phase) {
      case 'error': return 'error';
      case 'connecting': return 'connecting';
      case 'waiting':
      case 'lobby':
      case 'playing': return 'lobby';
      default: return 'home';
    }
  }

  function create(): void {
    const ctx = ctxRef!;
    if (!ensureSupported()) return;
    saveNickname();
    lastWasHost = true;
    openRoom(ctx, true);
    setView('lobby');
  }

  function join(code: string): void {
    const ctx = ctxRef!;
    const c = normaliseRoomCode(code);
    if (!c) return;
    if (!ensureSupported()) return;
    saveNickname();
    lastWasHost = false;
    lastJoin = c;
    openRoom(ctx, false, c);
    setView('connecting');
  }

  function retry(): void {
    const r = room;
    const host = r ? r.lobby.isHost : lastWasHost;
    const code = r && !r.lobby.isHost ? r.lobby.code : lastJoin;
    leaveRoom();
    if (host) create();
    else if (code) join(code);
    else setView('home');
  }

  let unsupported = false;
  function ensureSupported(): boolean {
    if (testHook()?.createTransport || onlineSupported()) return true;
    unsupported = true;
    setView('error');
    return false;
  }

  function saveNickname(): void {
    const ctx = ctxRef;
    const input = rootEl?.querySelector<HTMLInputElement>('[data-testid="net-nickname"]');
    if (!ctx || !input) return;
    const name = cleanNickname(input.value, '');
    try {
      ctx.settings.update((s) => {
        s.nickname = name;
      });
    } catch {
      /* settings unavailable: the lobby uses a random name */
    }
  }

  // ---------------------------------------------------------------- views
  function renderHome(root: HTMLElement, ctx: AppContext): void {
    root.append(h('h1', { class: 'ui-title', text: 'Play online', testId: 'online-lobby-title' }));
    const col = h('div', { class: 'net-home' });
    const input = h('input', {
      class: 'net-input', testId: 'net-nickname',
      attrs: { type: 'text', maxlength: String(NICKNAME_MAX), autocomplete: 'nickname', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Nickname' },
    });
    input.value = nicknameOf(ctx) || randomNickname();
    input.dataset.focus = '';
    input.addEventListener('change', () => saveNickname());
    col.append(h('div', { class: 'net-field' }, h('label', { text: 'Your nickname (your friend sees it)' }), input));
    const rj = readRejoin();
    if (rj) {
      col.append(createButton(`Rejoin match ${formatRoomCode(rj.code)}`, () => join(rj.code), {
        testId: 'net-rejoin', variant: 'primary', size: 'lg', ctx, autofocus: true, hint: 'Back into the match you were playing',
      }));
    }
    col.append(
      createButton('Create room', create, { testId: 'net-create', variant: rj ? 'secondary' : 'primary', size: 'lg', ctx, autofocus: !rj, hint: 'Get a code to send to a friend' }),
      createButton('Join room', () => {
        typed = '';
        setView('join');
      }, { testId: 'net-join', size: 'lg', ctx, hint: 'Enter the code from your friend' }),
    );
    root.append(col, h('p', { class: 'net-privacy', text: PRIVACY_LINE, testId: 'net-privacy' }));
  }

  function renderJoin(root: HTMLElement, ctx: AppContext): void {
    root.append(h('h1', { class: 'ui-title', text: 'Join a room', testId: 'online-lobby-title' }));
    const slots = h('div', { class: 'net-slots', testId: 'net-code-slots', attrs: { 'aria-label': `Room code ${typed}` } });
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      const s = h('div', { class: `net-slot${i === 3 ? ' net-slot--gap' : ''}${i === typed.length ? ' is-next' : ''}`, text: typed[i] ?? '' });
      slots.append(s);
    }
    const pad = h('div', { class: 'net-keypad', testId: 'net-keypad', attrs: { 'data-focus-group': 'x' } });
    KEYS.forEach((k, i) => {
      pad.append(createButton(k, () => typeChar(k), { testId: `net-key-${k}`, ctx, sound: UiSound.MOVE, autofocus: i === 0 }));
    });
    pad.append(createButton('Delete', () => {
      typed = typed.slice(0, -1);
      render();
    }, { testId: 'net-key-del', ctx, extraClass: 'net-key--wide', ariaLabel: 'Delete last character' }));
    pad.append(createButton('Join', () => join(typed), { testId: 'net-key-join', ctx, variant: 'primary', extraClass: 'net-key--wide', disabled: typed.length !== ROOM_CODE_LENGTH }));
    root.append(slots, pad, h('p', { class: 'ui-note', text: 'Enter the 6-character code from your friend, or open the link they sent.' }));
  }

  function typeChar(k: string): void {
    if (typed.length >= ROOM_CODE_LENGTH || !isRoomCodeChar(k)) return;
    typed += k.toUpperCase();
    if (typed.length === ROOM_CODE_LENGTH) join(typed);
    else render();
  }

  function renderConnecting(root: HTMLElement, ctx: AppContext): void {
    const r = room;
    const label = r && !r.lobby.isHost ? `Joining room ${formatRoomCode(r.lobby.code)}…` : 'Creating a room…';
    root.append(h('h1', { class: 'ui-title', text: 'Play online', testId: 'online-lobby-title' }));
    root.append(h('div', { class: 'net-connecting', testId: 'net-connecting' },
      h('div', { class: 'net-spinner', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
      h('p', { class: 'ui-subtitle', text: label }),
      createButton('Cancel', () => {
        leaveRoom();
        setView('home');
      }, { testId: 'net-cancel', ctx, autofocus: true })));
  }

  function renderError(root: HTMLElement, ctx: AppContext): void {
    const reason: LobbyError = unsupported ? 'unsupported' : room?.lobby.error ?? 'disconnected';
    const t = errorText(reason);
    root.append(h('div', { class: 'net-error', testId: `net-error-${reason}` },
      h('div', { class: 'net-error__icon', text: '!', attrs: { 'aria-hidden': 'true' } }),
      h('h1', { class: 'ui-title', text: t.title, testId: 'net-error-title' }),
      h('p', { class: 'ui-subtitle', text: t.body, testId: 'net-error-body' }),
      h('div', { class: 'ui-row' },
        reason === 'unsupported' ? null : createButton('Try again', () => retry(), { testId: 'net-retry', variant: 'primary', ctx, autofocus: true }),
        createButton('Back', () => {
          unsupported = false;
          leaveRoom();
          setView('home');
        }, { testId: 'net-error-back', ctx, autofocus: reason === 'unsupported' }))));
  }

  function renderLobby(root: HTMLElement, ctx: AppContext, r: Room): void {
    const lobby = r.lobby;
    const clubs = ctx.clubs;
    const clubName = (i: number): string => (i >= 0 && clubs[i] ? clubs[i]!.name : 'Choosing a club…');
    root.append(h('h1', { class: 'ui-title', text: lobby.isHost ? 'Your room' : 'Room', testId: 'online-lobby-title' }));
    const grid = h('div', { class: 'net-lobby', testId: 'net-lobby' });
    const left = h('div', { class: 'net-col' });
    const right = h('div', { class: 'net-col ui-scroll' });

    // Code + share link
    const codeCard = h('div', { class: 'net-code-card' },
      h('span', { class: 'eyebrow', text: 'Room code' }),
      h('span', { class: 'net-code', text: formatRoomCode(lobby.code), testId: 'net-room-code', attrs: { 'aria-label': `Room code ${lobby.code.split('').join(' ')}` } }));
    if (lobby.isHost) {
      const link = roomLink(lobby.code, typeof location !== 'undefined' ? location.href : 'https://dotkick.app/');
      codeCard.append(h('span', { class: 'net-link', text: link, testId: 'net-room-link' }));
      const share = h('div', { class: 'net-share' });
      share.append(createButton('Copy link', () => {
        void copyText(link).then((ok) => showToast(ok ? 'Link copied' : 'Could not copy: write the code down instead', { kind: ok ? 'success' : 'warning', testId: 'net-toast' }));
      }, { testId: 'net-copy', ctx }));
      const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { share?: (d: ShareData) => Promise<void> }) : null;
      if (nav && typeof nav.share === 'function') {
        share.append(createButton('Share…', () => {
          nav.share!({ title: 'DotKick', text: `Play DotKick with me: room ${formatRoomCode(lobby.code)}`, url: link }).catch(() => undefined);
        }, { testId: 'net-share', ctx }));
      }
      codeCard.append(share);
    }
    left.append(codeCard);

    // Players
    const me = lobby.self;
    const peer = lobby.peer;
    const meIdx = lobby.isHost ? 0 : 1;
    const card = (who: string, idx: number, name: string, club: string, ready: boolean | null, testId: string): HTMLElement =>
      h('div', { class: `net-player net-player--p${idx + 1}`, testId },
        h('span', { class: 'net-player__who', text: who }),
        h('span', { class: 'net-player__name', text: name }),
        h('span', { class: 'net-player__club', text: club }),
        ready === null ? null : h('span', { class: `net-badge${ready ? ' is-ready' : ''}`, text: ready ? 'Ready' : 'Not ready' }));
    const meCard = card(`You · ${meIdx === 0 ? 'Home' : 'Away'}`, meIdx, me.nickname, clubName(me.club), me.ready, 'net-me');
    const peerCard = peer
      ? card(`Friend · ${meIdx === 0 ? 'Away' : 'Home'}`, 1 - meIdx, peer.nickname, clubName(peer.club), peer.ready, 'net-peer')
      : card('Friend', 1 - meIdx, lobby.isHost ? 'Waiting for a friend…' : 'Host', lobby.isHost ? 'Send them the code or the link' : '', null, 'net-peer');
    const players = h('div', { class: 'net-players' });
    if (meIdx === 0) players.append(meCard, peerCard);
    else players.append(peerCard, meCard);
    left.append(players);

    // Own club + ready
    const options = clubs.map((c, i) => ({ value: i, label: c.name, testId: `net-club-${c.code.toLowerCase()}` }));
    if (options.length > 0) {
      left.append(createSelector('Your club', options, Math.max(0, me.club), (v) => lobby.setClub(v), { testId: 'net-club', ctx }).el);
    }
    const ready = createButton(me.ready ? 'Not ready' : 'Ready', () => lobby.setReady(!lobby.self.ready), {
      testId: 'net-ready', variant: me.ready ? 'secondary' : 'primary', size: 'lg', ctx, autofocus: true,
      disabled: !peer || lobby.phase !== 'lobby', hint: me.ready ? 'Tap to change your mind' : 'When you have picked your club',
    });
    left.append(ready);
    left.append(h('p', { class: 'net-status', testId: 'net-status', text: lobbyStatus(lobby) }));
    qualityEl = h('span', { class: 'net-quality', testId: 'net-quality' });
    lastQuality = '';
    left.append(qualityEl);

    // Settings
    const cfg = lobby.config ?? defaultTemplate(ctx);
    if (lobby.isHost) {
      const set = (mut: (c: MatchConfig) => void): void => {
        const c = { ...(lobby.config ?? defaultTemplate(ctx)) };
        mut(c);
        lobby.setConfig(c);
      };
      const halves = [];
      for (let m = 2; m <= 10; m++) halves.push({ value: m, label: `${m} min`, testId: `net-half-${m}` });
      right.append(h('div', { class: 'net-settings', testId: 'net-settings' },
        h('span', { class: 'eyebrow', text: 'Match settings (you choose)' }),
        createSelector('Half length', halves, Math.round(cfg.halfMinutes), (v) => set((c) => { c.halfMinutes = v; }), { testId: 'net-set-half', ctx }).el,
        createToggle('Offside', cfg.offside === 1, (v) => set((c) => { c.offside = v ? 1 : 0; }), { testId: 'net-set-offside', ctx }).el,
        createToggle('Fouls and cards', cfg.fouls === 1, (v) => set((c) => { c.fouls = v ? 1 : 0; }), { testId: 'net-set-fouls', ctx }).el,
        createToggle('Cup rules', cfg.cupRules === 1, (v) => set((c) => { c.cupRules = v ? 1 : 0; }), { testId: 'net-set-cup', ctx, hint: 'Extra time and penalties if level' }).el,
        createToggle('Night match', cfg.night === 1, (v) => set((c) => { c.night = v ? 1 : 0; }), { testId: 'net-set-night', ctx }).el,
        createToggle('Goal replays', cfg.replaySeconds > 0, (v) => set((c) => { c.replaySeconds = v ? 8 : 0; }), { testId: 'net-set-replays', ctx }).el,
      ));
    } else {
      const on = (v: number): string => (v ? 'On' : 'Off');
      const row = (label: string, value: string): HTMLElement => h('span', {}, `${label}: `, h('b', { text: value }));
      right.append(h('div', { class: 'net-settings-ro', testId: 'net-settings' },
        h('span', { class: 'eyebrow', text: 'Match settings (the host chooses)' }),
        lobby.config ? null : h('span', { text: 'Waiting for the host…' }),
        row('Half length', `${Math.round(cfg.halfMinutes)} min`),
        row('Offside', on(cfg.offside)),
        row('Fouls and cards', on(cfg.fouls)),
        row('Cup rules', on(cfg.cupRules)),
        row('Night match', on(cfg.night)),
        row('Goal replays', on(cfg.replaySeconds > 0 ? 1 : 0))));
    }
    right.append(h('p', { class: 'net-privacy', text: PRIVACY_LINE, testId: 'net-privacy' }));
    grid.append(left, right);
    root.append(grid);
  }

  function lobbyStatus(lobby: Lobby): string {
    const peer = lobby.peer;
    if (lobby.phase === 'playing') return 'Starting the match…';
    if (!peer) return lobby.isHost ? 'Waiting for your friend to join with the code.' : 'Waiting for the host…';
    if (lobby.starting) return 'Both ready: starting…';
    if (lobby.self.club < 0) return 'Pick your club.';
    if (!lobby.self.ready) return peer.ready ? `${peer.nickname} is ready. Tap Ready when you are.` : 'Pick your club, then tap Ready.';
    return `Waiting for ${peer.nickname} to get ready.`;
  }

  function render(): void {
    const root = rootEl;
    const ctx = ctxRef;
    if (!root || !ctx) return;
    const v = currentView();
    const sameView = v === view && root.dataset.view === v;
    view = v;
    // Re-rendering the same view keeps the focused control (a controller user changing settings stays where he is).
    const focusedId = sameView ? root.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null : null;
    // Keep the dot field canvas; replace everything else.
    for (const child of Array.from(root.children)) if (!child.classList.contains('dotfield')) child.remove();
    root.append(createBackButton(ctx)); // router.back() asks onBack() first
    const r = room;
    if (v === 'home') renderHome(root, ctx);
    else if (v === 'join') renderJoin(root, ctx);
    else if (v === 'connecting') renderConnecting(root, ctx);
    else if (v === 'error') renderError(root, ctx);
    else if (v === 'lobby' && r) renderLobby(root, ctx, r);
    root.dataset.view = v;
    if (focusedId) {
      const el = root.querySelector<HTMLElement>(`[data-testid="${focusedId}"]`);
      if (el && !(el as HTMLButtonElement).disabled) {
        try {
          ctx.focus.focus(el);
        } catch {
          /* no navigator */
        }
      }
    }
  }

  /**
   * Back (router.back asks this first): join -> home, lobby / connecting -> leave the room (asks first when a friend is
   * there), error -> home; false on the home view (the router returns to the menu).
   */
  function back(): boolean {
    if (closeTopModal()) return true;
    const ctx = ctxRef;
    const r = room;
    if (view === 'join') {
      setView('home');
      return true;
    }
    if (view === 'error') {
      unsupported = false;
      leaveRoom();
      setView('home');
      return true;
    }
    if (r && (view === 'lobby' || view === 'connecting')) {
      if (r.lobby.peer && r.lobby.phase === 'lobby' && ctx) {
        openModal(ctx, {
          title: 'Leave the room?',
          body: `${r.lobby.peer.nickname} will see that you left.`,
          testId: 'net-leave-confirm',
          actions: [
            { label: 'Leave', variant: 'danger', testId: 'net-leave-yes', onSelect: () => { leaveRoom(); setView('home'); } },
            { label: 'Stay', primary: true, testId: 'net-leave-no' },
          ],
        });
        return true;
      }
      leaveRoom();
      setView('home');
      return true;
    }
    return false; // home: the router goes back to the menu
  }

  return {
    id: 'online-lobby',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      ctxRef = ctx;
      rootEl = root;
      injectStyle('net-07', CSS);
      root.classList.add('net-screen');
      detachField = attachDotField(root);
      activeView = renderer;
      exposeDebug();
      unsupported = false;
      if (room && room.closed && !matchRunning(room)) finalizeRoom(room);
      if (room && room.closed) {
        view = 'home'; // (cannot happen while its match runs: the match screens are up)
      } else if (room) {
        room.screenMounted = true;
        if (room.ctx !== ctx) room.ctx = ctx;
        view = 'lobby';
      } else {
        const fromParam = typeof params?.room === 'string' ? normaliseRoomCode(params.room) : null;
        const code = fromParam ?? shareLinkRoom();
        if (code) {
          lastJoin = code;
          view = 'connecting';
          if (!(testHook()?.createTransport || onlineSupported())) unsupported = true;
          else openRoom(ctx, false, code);
        } else view = 'home';
      }
      keyHandler = (e: KeyboardEvent): void => {
        if (view !== 'join' || e.metaKey || e.ctrlKey || e.altKey) return;
        const t = e.target as HTMLElement | null;
        if (t && t.closest && t.closest('input, textarea')) return;
        if (e.key.length === 1 && isRoomCodeChar(e.key)) {
          e.stopImmediatePropagation();
          e.preventDefault();
          if (!e.repeat) typeChar(e.key);
        } else if (e.key === 'Backspace' && typed.length > 0) {
          e.stopImmediatePropagation();
          e.preventDefault();
          typed = typed.slice(0, -1);
          render();
        } else if (e.key === 'Enter' && typed.length === ROOM_CODE_LENGTH) {
          e.stopImmediatePropagation();
          e.preventDefault();
          join(typed);
        }
      };
      window.addEventListener('keydown', keyHandler, true);
      render();
    },
    unmount() {
      if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
      keyHandler = null;
      if (activeView === renderer) activeView = null;
      detachField?.();
      detachField = null;
      const r = room;
      // Leaving the screen for anything but the match ends the room (the match screens take over while it plays).
      if (r && r.lobby.phase !== 'playing') leaveRoom();
      else if (r) r.screenMounted = false;
      rootEl = null;
      ctxRef = null;
      qualityEl = null;
    },
    onBack() {
      return back();
    },
    onFrame(frame) {
      if (detachField) sharedDotField().frame(frame.nowMs);
      const r = room;
      if (qualityEl && r && frame.nowMs - lastQualityAt > 1000) {
        lastQualityAt = frame.nowMs;
        const t = r.lobby.transport;
        const q = t.state === 'open' ? (t.rtt > 0 ? `Connected · ${Math.round(t.rtt)} ms round trip` : 'Connected') : r.lobby.phase === 'waiting' ? 'Room open' : '';
        if (q !== lastQuality) {
          lastQuality = q;
          qualityEl.textContent = q;
        }
      }
    },
  };
}
