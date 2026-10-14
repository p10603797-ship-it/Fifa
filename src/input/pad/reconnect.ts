/**
 * [PAD-03] Disconnect / reconnect handling (section 10 "Controller quality bar": "Disconnect mid-match: auto-pause
 * with a reconnect card. Any pad button resumes. Offer to hand that side to touch or the CPU."; glitch list:
 * "controller disconnect during a penalty"). Bindings follow pad identity (PadSlot.key survives a reconnect at a new
 * index, see manager.ts).
 *
 * createReconnectFlow (the state machine, no DOM):
 *  - Listens to the device registry's bound-pad changes (devices.ts onBoundPadChange; they fire inside the pad poll,
 *    which the loop runs in the input pump BEFORE the ticks of that frame). A bound pad that disconnects while a
 *    match is live (session active, not finished) opens a card for its human, unless that human has since used
 *    another of his bound devices (a newer press on another bound pad, a touch or key press): an idle paired pad
 *    that falls asleep while its owner plays on touch never interrupts him.
 *  - Opening a card pauses the session at once as RECONNECT_PAUSER (-2), so no tick ever sees the zeroed pad (a
 *    penalty taker's held Circle is never "released" into a shot, his aim is kept, the restart clock stands still).
 *    -2 instead of the system pauser -1: SessionControl.resume(h) refuses everyone but the pauser, so nothing but
 *    this flow lifts the pause (another player's Options, pause-menu Resume, Back / Escape all stay refused while
 *    the card is up). A pause someone else already held (a player's pause menu, a hidden-page pause) is taken over
 *    and handed back when the last card closes (that player's pause menu returns; never an auto-resume).
 *  - One card per human; several missing humans queue, oldest first. The card reads "Controller N disconnected"
 *    (registry label), then "Controller N reconnected" when that pad is back (same key, any index).
 *  - Any pad button resumes: a press edge (buttons 0..15, never Home / Share) on a connected pad, polled after the
 *    card opened, on the human's own pad (the same one back, or another pad bound to him) or on a pad no other human
 *    is bound to; a pad bound to another human resolves that human's card if he has one, else it is ignored (player 2
 *    mashing his pad never resumes player 1's side). An unbound pad is bound to the human first through the session
 *    hook setHumanDevice(human, ids + pad) (CR); without the hook only the human's own pads count.
 *  - Hand-off: handOff('touch') rebinds the human to ['touch'] (offered when the platform has touch and no other
 *    human is bound to touch: two people cannot share one touch screen, section 11); handOff('cpu') gives that side
 *    to the CPU for the rest of the match (setHumanDevice(human, 'cpu')); later disconnects of that human are ignored.
 *    Both need the session hook (CR); without it the card offers no hand-off.
 *  - The resume press never reaches the game: the session's resume() calls releaseAll() on the input provider, and
 *    the pad mapper suppresses buttons held at releaseAll() until they are physically released.
 *  - When the last card closes the flow resumes (resume(RECONNECT_PAUSER)); if the session refuses (page hidden,
 *    portrait / too small) it retries every update and then shows the pause menu instead (pause(-1)): it never
 *    auto-resumes after those, as the session rules require.
 *  - update(nowMs) once per animation frame (before the input pump is best; installReconnectFlow drives it by rAF
 *    while a card is open): polls the pads (idempotent per timestamp), keeps the pause ours, resolves cards on
 *    presses. Costs one early return per frame while no card is open.
 *
 * createReconnectCard: the DOM card (#ui, above the pause menu) with Touch / CPU buttons (60 pt targets, focusable).
 * installReconnectFlow: flow + card + focus-navigator guard + touch / key activity listeners + rAF driver; returns a
 * handle to dispose. Pad presses on the card never click its buttons (they resume); keyboard and touch operate them.
 *
 * WAVE 0 BASELINE kept: createReconnectWatcher (reports bound pads going away and coming back).
 * App/UI code (not sim): allocation while a card is open is fine; the steady state allocates nothing.
 */

import { MenuAction, type DeviceInfo, type FocusNavigator, type MatchSetup, type PlatformInfo } from '../../contracts/app';
import type { PadBinding, PadBindingListener } from '../devices';
import { padAnyPressedEdge, type PadManager, type PadSlot } from './manager';

// ============================================================ Wave 0 watcher (kept)

export interface ReconnectWatcherOptions {
  manager: PadManager;
  /** Device keys bound in the current match. */
  keys: readonly string[];
  /** A bound pad disconnected. */
  onDisconnect(key: string): void;
  /** A bound pad is connected again (same identity, possibly at a new index). */
  onReconnect(key: string): void;
}

export interface ReconnectWatcher {
  /** Keys of bound pads currently disconnected. */
  missing(): string[];
  dispose(): void;
}

export function createReconnectWatcher(opts: ReconnectWatcherOptions): ReconnectWatcher {
  const keys = opts.keys.slice();
  const wasConnected = keys.map((k) => opts.manager.find(k)?.connected ?? false);
  const check = (): void => {
    for (let i = 0; i < keys.length; i++) {
      const s = opts.manager.find(keys[i]!);
      const c = s !== null && s.connected;
      if (c !== wasConnected[i]) {
        wasConnected[i] = c;
        if (c) opts.onReconnect(keys[i]!); else opts.onDisconnect(keys[i]!);
      }
    }
  };
  const unsub = opts.manager.subscribe(check);
  return {
    missing() {
      const out: string[] = [];
      for (let i = 0; i < keys.length; i++) if (!wasConnected[i]) out.push(keys[i]!);
      return out;
    },
    dispose() { unsub(); },
  };
}

// ============================================================ flow

/**
 * Pauser id of the reconnect flow (SessionControl.pause / resume). Negative like the system pauser (-1), so the
 * pause menu says "Game paused", but distinct from it: resume(-1) / resume(0 | 1) are refused while it holds.
 */
export const RECONNECT_PAUSER = -2;
/** Device id of the touch overlay (DeviceRegistry). */
export const TOUCH_DEVICE_ID = 'touch';
/** Device id of the keyboard (DeviceRegistry). */
export const KEYBOARD_DEVICE_ID = 'keyboard';
/** HumanBinding wildcard (app/localInput.ts ANY_DEVICE; repeated here so this module stays free of app imports). */
export const ANY_DEVICE_ID = '*';

export type HandOffTarget = 'touch' | 'cpu';

/**
 * The session as the flow needs it: the contract SessionControl subset, AppSession.finished, and the proposed hook
 * (CR PAD-03): setHumanDevice(human, deviceIds | 'cpu') rebinds a human for the rest of the match (true = done).
 */
export interface ReconnectSession {
  readonly active: boolean;
  readonly paused: boolean;
  readonly pausedBy: number;
  /** AppSession: the match reached POST_MATCH (no pause possible). */
  readonly finished?: boolean;
  pause(byHuman: number): void;
  resume(byHuman: number): boolean;
  getSetup(): MatchSetup | null;
  setHumanDevice?(human: number, devices: readonly string[] | 'cpu'): boolean | void;
}

/** The device registry as the flow needs it (DotkickDeviceRegistry subset, src/input/devices.ts). */
export interface ReconnectDevices {
  readonly pads: PadManager;
  list(): DeviceInfo[];
  boundPads(): PadBinding[];
  onBoundPadChange(fn: PadBindingListener): () => void;
}

export interface ReconnectFlowOptions {
  session: ReconnectSession;
  devices: ReconnectDevices;
  platform?: Pick<PlatformInfo, 'isTouch'> | null;
  /** Pauser id used for the card's pause. Default RECONNECT_PAUSER. */
  pauser?: number;
  /** Errors from the session or registry (the flow keeps going). */
  onError?(err: unknown, where: string): void;
}

/** What the card shows. */
export interface ReconnectCardInfo {
  /** Human index (0 = Player 1, 1 = Player 2). */
  readonly human: number;
  /** The pad that went away and its label ('Controller 1'). */
  readonly deviceId: string;
  readonly label: string;
  /** The pad is connected again (any button continues). */
  readonly reconnected: boolean;
  /** Hand-off buttons offered. */
  readonly canTouch: boolean;
  readonly canCpu: boolean;
  /** Further humans waiting for their own card after this one. */
  readonly more: number;
}

export interface ReconnectFlow {
  /** The card to show now (oldest unresolved disconnect), or null. */
  readonly card: ReconnectCardInfo | null;
  /** True while the flow holds (or still has to hand back) the session pause. */
  readonly holding: boolean;
  /** Humans waiting for a card, oldest first. */
  pending(): number[];
  /** Once per animation frame (rAF time, ms). Cheap no-op while no card is open. */
  update(nowMs: number): void;
  /** Hand the shown card's side to touch or the CPU. False when not offered or refused by the session. */
  handOff(target: HandOffTarget): boolean;
  /** A touch / key press at `ms` (rAF / event time base): decides whether a later pad loss interrupts that human. */
  noteActivity(deviceId: string, ms: number): void;
  /** Card changes (open, reconnect, next card, close). Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

interface Entry {
  human: number;
  deviceId: string;
  reconnected: boolean;
  /** pads.lastPollMs when the card opened: only presses polled after it count. */
  openedAt: number;
}

/** Ids bound to `human` in the setup (empty when none). */
function setupIds(setup: MatchSetup | null, human: number): readonly string[] {
  if (!setup) return [];
  for (let i = 0; i < setup.bindings.length; i++) {
    const b = setup.bindings[i]!;
    if (b.human === human) return b.deviceIds;
  }
  return [];
}

function hasId(ids: readonly string[], id: string): boolean {
  for (let i = 0; i < ids.length; i++) if (ids[i] === id || ids[i] === ANY_DEVICE_ID) return true;
  return false;
}

/** Human bound to pad `key` (live source), -1 if none. */
function ownerOf(bound: readonly PadBinding[], key: string): number {
  for (let i = 0; i < bound.length; i++) if (bound[i]!.deviceId === key) return bound[i]!.human;
  return -1;
}

export function createReconnectFlow(opts: ReconnectFlowOptions): ReconnectFlow {
  const { session, devices } = opts;
  const pads = devices.pads;
  const pauser = opts.pauser ?? RECONNECT_PAUSER;
  const entries: Entry[] = [];
  const subs: (() => void)[] = [];
  /** Humans handed to the CPU this match (their later disconnects are ignored). */
  const cpuHumans: number[] = [];
  /** Last touch / key press time (ms). */
  let lastTouchMs = -Infinity;
  let lastKeyMs = -Infinity;
  /** The session pause is ours (paused as `pauser`). */
  let owned = false;
  /** Pauser whose pause the flow took over (restored when the last card closes), or null. */
  let prior: number | null = null;
  /** The last card closed but the session refused to resume (hidden / blocked): retried by update(). */
  let releasePending = false;
  /** pads.lastPollMs whose presses were already handled. */
  let handledPoll = -Infinity;
  let card: ReconnectCardInfo | null = null;
  let cardKey = '';
  let disposed = false;

  function report(err: unknown, where: string): void {
    try {
      opts.onError?.(err, `reconnect.${where}`);
    } catch {
      /* never let a reporter break the flow */
    }
  }

  function live(): boolean {
    return session.active && session.finished !== true;
  }

  function hook(): ((human: number, d: readonly string[] | 'cpu') => boolean | void) | null {
    return typeof session.setHumanDevice === 'function' ? session.setHumanDevice.bind(session) : null;
  }

  function setup(): MatchSetup | null {
    try {
      return session.getSetup();
    } catch (err) {
      report(err, 'getSetup');
      return null;
    }
  }

  function bound(): PadBinding[] {
    try {
      return devices.boundPads();
    } catch (err) {
      report(err, 'boundPads');
      return [];
    }
  }

  function deviceList(): DeviceInfo[] {
    try {
      return devices.list();
    } catch (err) {
      report(err, 'list');
      return [];
    }
  }

  function labelOf(deviceId: string): string {
    const list = deviceList();
    for (let i = 0; i < list.length; i++) if (list[i]!.id === deviceId) return list[i]!.label;
    const slot = pads.find(deviceId);
    return slot && slot.ordinal > 0 ? `Controller ${slot.ordinal}` : 'Controller';
  }

  /** Touch can take this human's side: touch platform, touch listed, setter present, no other human on touch. */
  function canTouch(human: number): boolean {
    if (!hook() || !opts.platform?.isTouch) return false;
    let listed = false;
    const list = deviceList();
    for (let i = 0; i < list.length; i++) if (list[i]!.id === TOUCH_DEVICE_ID && list[i]!.connected) listed = true;
    if (!listed) return false;
    const s = setup();
    if (!s) return true;
    for (let i = 0; i < s.bindings.length; i++) {
      const b = s.bindings[i]!;
      if (b.human !== human && cpuHumans.indexOf(b.human) < 0 && hasId(b.deviceIds, TOUCH_DEVICE_ID)) return false;
    }
    return true;
  }

  function computeCard(): ReconnectCardInfo | null {
    const e = entries[0];
    if (!e) return null;
    return {
      human: e.human, deviceId: e.deviceId, label: labelOf(e.deviceId), reconnected: e.reconnected,
      canTouch: canTouch(e.human), canCpu: hook() !== null, more: entries.length - 1,
    };
  }

  function refresh(): void {
    const next = computeCard();
    const key = next
      ? `${next.human}|${next.deviceId}|${next.label}|${next.reconnected ? 1 : 0}|${next.canTouch ? 1 : 0}|${next.canCpu ? 1 : 0}|${next.more}`
      : '';
    if (key === cardKey) return;
    cardKey = key;
    card = next;
    const ls = subs.slice();
    for (let i = 0; i < ls.length; i++) {
      try {
        ls[i]!();
      } catch (err) {
        report(err, 'subscriber');
      }
    }
  }

  /**
   * Was `deviceId` this human's device in use? False when another of his bound devices had input after the pad's
   * last input (a newer bound pad, or touch / keyboard bound to him and pressed later).
   */
  function inUse(human: number, deviceId: string): boolean {
    const slot = pads.find(deviceId);
    const padT = slot ? slot.lastInputMs : -Infinity;
    const b = bound();
    for (let i = 0; i < b.length; i++) {
      const x = b[i]!;
      if (x.human !== human || x.deviceId === deviceId || !x.connected) continue;
      const o = pads.find(x.deviceId);
      if (o && o.connected && o.lastInputMs > padT) return false;
    }
    const ids = setupIds(setup(), human);
    if (opts.platform?.isTouch && hasId(ids, TOUCH_DEVICE_ID) && lastTouchMs > padT) return false;
    if (hasId(ids, KEYBOARD_DEVICE_ID) && lastKeyMs > padT) return false;
    return true;
  }

  /** Make sure the session pause is ours (pause, or take over another pauser's pause). */
  function hold(): void {
    if (!live()) return;
    try {
      if (session.paused) {
        const by = session.pausedBy;
        if (by === pauser) {
          owned = true;
          return;
        }
        // Someone else's pause (a player's menu, the system): take it over so only the flow can lift it. Resume and
        // pause run back to back, so no tick runs in between. Refused (hidden / blocked): retried by update().
        if (!session.resume(by)) return;
        if (prior === null) prior = by;
      }
      session.pause(pauser);
      owned = session.paused && session.pausedBy === pauser;
    } catch (err) {
      report(err, 'pause');
    }
  }

  /** The last card closed: lift our pause (restoring a pause we took over). */
  function release(): void {
    releasePending = false;
    if (!owned) {
      prior = null;
      return;
    }
    try {
      if (!session.active || !session.paused || session.pausedBy !== pauser) {
        owned = false;
        prior = null;
        return;
      }
      if (!session.resume(pauser)) {
        releasePending = true;
        return;
      }
      owned = false;
      const p = prior;
      prior = null;
      if (p !== null) session.pause(p);
    } catch (err) {
      report(err, 'resume');
    }
  }

  /** A release the session refused earlier: once it accepts, show the pause menu (never auto-resume). */
  function retryRelease(): void {
    if (!session.active || !session.paused || session.pausedBy !== pauser) {
      releasePending = false;
      owned = false;
      prior = null;
      return;
    }
    try {
      if (!session.resume(pauser)) return;
      releasePending = false;
      owned = false;
      const p = prior;
      prior = null;
      session.pause(p !== null ? p : -1);
    } catch (err) {
      report(err, 'resume');
    }
  }

  function reset(): void {
    entries.length = 0;
    cpuHumans.length = 0;
    owned = false;
    prior = null;
    releasePending = false;
    refresh();
  }

  function entryOf(human: number): Entry | null {
    for (let i = 0; i < entries.length; i++) if (entries[i]!.human === human) return entries[i]!;
    return null;
  }

  function close(e: Entry): void {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
    if (entries.length === 0) release();
    refresh();
  }

  function setHuman(human: number, ids: readonly string[] | 'cpu'): boolean {
    const fn = hook();
    if (!fn) return false;
    try {
      return fn(human, ids) !== false;
    } catch (err) {
      report(err, 'setHumanDevice');
      return false;
    }
  }

  /** A press on pad `key` (owner = human it is bound to, -1 none). Returns true when a card closed. */
  function pressOn(key: string, owner: number): boolean {
    if (owner >= 0) {
      const own = entryOf(owner);
      if (!own) return false;
      close(own);
      return true;
    }
    const e = entries[0];
    if (!e) return false;
    const ids = setupIds(setup(), e.human);
    const next: string[] = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] !== key) next.push(ids[i]!);
    next.push(key);
    if (!setHuman(e.human, next)) return false;
    close(e);
    return true;
  }

  const onBinding: PadBindingListener = (deviceId, human, connected) => {
    if (disposed) return;
    if (!session.active) {
      if (entries.length > 0 || owned) reset();
      return;
    }
    let changed = false;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      if (e.deviceId === deviceId && e.reconnected !== connected) {
        e.reconnected = connected;
        changed = true;
      }
    }
    if (connected || !live() || human < 0 || cpuHumans.indexOf(human) >= 0 || entryOf(human) !== null || !inUse(human, deviceId)) {
      if (changed) refresh();
      return;
    }
    entries.push({ human, deviceId, reconnected: false, openedAt: pads.lastPollMs });
    hold();
    refresh();
  };

  let unsubBinding: (() => void) | null = null;
  try {
    unsubBinding = devices.onBoundPadChange(onBinding);
  } catch (err) {
    report(err, 'onBoundPadChange');
  }

  const flow: ReconnectFlow = {
    get card() {
      return card;
    },
    get holding() {
      return owned || releasePending;
    },
    pending() {
      const out: number[] = [];
      for (let i = 0; i < entries.length; i++) out.push(entries[i]!.human);
      return out;
    },
    update(nowMs: number) {
      if (disposed) return;
      if (entries.length === 0) {
        if (releasePending) retryRelease();
        return;
      }
      if (!live()) {
        reset();
        return;
      }
      try {
        pads.poll(nowMs);
      } catch (err) {
        report(err, 'poll');
      }
      if (entries.length === 0) return;
      hold();
      const pollT = pads.lastPollMs;
      if (pollT === handledPoll) return;
      handledPoll = pollT;
      const slots = pads.slots;
      const b = bound();
      for (let i = 0; i < slots.length && entries.length > 0; i++) {
        const s: PadSlot = slots[i]!;
        if (!s.connected || !s.active || !padAnyPressedEdge(s)) continue;
        const owner = ownerOf(b, s.key);
        const e = owner >= 0 ? entryOf(owner) : entries[0]!;
        if (!e || pollT <= e.openedAt) continue;
        if (pressOn(s.key, owner)) break; // one card per poll: the same press never closes the next card too
      }
      refresh();
    },
    handOff(target: HandOffTarget) {
      const e = entries[0];
      if (!e || disposed) return false;
      if (target === 'touch') {
        if (!canTouch(e.human) || !setHuman(e.human, [TOUCH_DEVICE_ID])) return false;
      } else {
        if (!setHuman(e.human, 'cpu')) return false;
        if (cpuHumans.indexOf(e.human) < 0) cpuHumans.push(e.human);
      }
      close(e);
      return true;
    },
    noteActivity(deviceId: string, ms: number) {
      if (deviceId === TOUCH_DEVICE_ID) {
        if (ms > lastTouchMs) lastTouchMs = ms;
      } else if (deviceId === KEYBOARD_DEVICE_ID) {
        if (ms > lastKeyMs) lastKeyMs = ms;
      }
    },
    subscribe(fn: () => void) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    dispose() {
      if (disposed) return;
      if (entries.length > 0 || releasePending) {
        entries.length = 0;
        release();
      }
      disposed = true;
      unsubBinding?.();
      unsubBinding = null;
      card = null;
      cardKey = '';
      subs.length = 0;
    },
  };
  return flow;
}

// ============================================================ card text (pure)

export interface ReconnectCardText {
  /** 'Player 1' / 'Player 2'. */
  player: string;
  title: string;
  body: string;
  /** Footer for further missing controllers ('' when none). */
  more: string;
}

/** Text of the card for `info`. Pure. */
export function reconnectCardText(info: ReconnectCardInfo): ReconnectCardText {
  const offer = info.canTouch || info.canCpu;
  const body = info.reconnected
    ? (offer ? 'Press any button to continue, or hand this side to:' : 'Press any button to continue.')
    : (offer ? 'Press any button on a controller to continue, or hand this side to:' : 'Press any button on a controller to continue.');
  return {
    player: `Player ${info.human + 1}`,
    title: `${info.label} ${info.reconnected ? 'reconnected' : 'disconnected'}`,
    body,
    more: info.more > 0 ? (info.more === 1 ? 'Another controller is also disconnected.' : `${info.more} more controllers are also disconnected.`) : '',
  };
}

// ============================================================ DOM card

const CARD_CSS = `
.reconnect-scrim { position:absolute; inset:0; z-index:80; display:flex; align-items:center; justify-content:center;
  padding: calc(var(--safe-top, 0px) + 24px) calc(var(--safe-right, 0px) + 24px) calc(var(--safe-bottom, 0px) + 24px)
  calc(var(--safe-left, 0px) + 24px); box-sizing:border-box; background: var(--scrim, rgba(7,7,13,.78)); pointer-events:auto;
  touch-action:none; }
.reconnect-scrim[hidden] { display:none; }
.reconnect-panel { display:flex; flex-direction:column; gap: var(--space-4, 16px); width:min(560px, 100%); box-sizing:border-box;
  padding: var(--space-6, 32px); border-radius: var(--radius-lg, 22px); background: var(--surface-2, #14141c);
  border: 1px solid var(--hairline-strong, rgba(255,255,255,.16)); color: var(--text-1, #f7f0ee); }
.reconnect-player { margin:0; font-size: var(--fs-sm, 15px); color: var(--text-2, #cbc2bf); letter-spacing:.04em; }
.reconnect-player.p1 { color: var(--p1, #ff6b35); } .reconnect-player.p2 { color: var(--p2, #3ad0e0); }
.reconnect-title { margin:0; font-size: var(--fs-lg, 24px); }
.reconnect-body { margin:0; color: var(--text-2, #cbc2bf); font-size: var(--fs-md, 18px); }
.reconnect-actions { display:flex; flex-wrap:wrap; gap: var(--space-3, 12px); }
.reconnect-actions[hidden] { display:none; }
.reconnect-actions .btn { min-height: var(--target, 60px); min-width: 140px; }
.reconnect-actions .btn[hidden] { display:none; }
.reconnect-more { margin:0; color: var(--text-3, #9f9693); font-size: var(--fs-sm, 15px); }
.reconnect-more[hidden] { display:none; }
`;

export interface ReconnectCardOptions {
  /** Parent element (#ui: above the screens and the pause menu). */
  root: HTMLElement;
  flow: ReconnectFlow;
  /** The card is pushed as the top focus root while shown (keyboard / focus ring on its buttons). */
  focus?: FocusNavigator | null;
}

export interface ReconnectCard {
  readonly visible: boolean;
  /** The card element (null after dispose). */
  readonly element: HTMLElement | null;
  /** Keep the card the top focus root (the pause menu attaches itself after the card opened). */
  ensureFocusTop(): void;
  dispose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string, testId?: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (testId) e.dataset.testid = testId;
  return e;
}

function button(doc: Document, label: string, testId: string, onSelect: () => void): HTMLButtonElement {
  const b = el(doc, 'button', 'btn btn--secondary', testId);
  b.type = 'button';
  b.textContent = label;
  b.dataset.focus = '';
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (!b.hidden && !b.disabled) onSelect();
  });
  return b;
}

/** The reconnect card (DOM). Writes the DOM only when the card changes. */
export function createReconnectCard(opts: ReconnectCardOptions): ReconnectCard {
  const doc = opts.root.ownerDocument;
  if (!doc.getElementById('style-reconnect')) {
    const st = doc.createElement('style');
    st.id = 'style-reconnect';
    st.textContent = CARD_CSS;
    doc.head.appendChild(st);
  }
  const scrim = el(doc, 'div', 'reconnect-scrim', 'reconnect-card');
  scrim.setAttribute('role', 'alertdialog');
  scrim.setAttribute('aria-modal', 'true');
  scrim.setAttribute('aria-labelledby', 'reconnect-title');
  scrim.setAttribute('aria-describedby', 'reconnect-body');
  const panel = el(doc, 'div', 'reconnect-panel');
  const player = el(doc, 'p', 'reconnect-player', 'reconnect-player');
  const title = el(doc, 'h2', 'reconnect-title', 'reconnect-title');
  title.id = 'reconnect-title';
  const body = el(doc, 'p', 'reconnect-body', 'reconnect-body');
  body.id = 'reconnect-body';
  const actions = el(doc, 'div', 'reconnect-actions');
  actions.setAttribute('data-focus-group', 'x');
  const touchBtn = button(doc, 'Touch', 'reconnect-touch', () => { opts.flow.handOff('touch'); });
  const cpuBtn = button(doc, 'CPU', 'reconnect-cpu', () => { opts.flow.handOff('cpu'); });
  actions.append(touchBtn, cpuBtn);
  const more = el(doc, 'p', 'reconnect-more', 'reconnect-more');
  panel.append(player, title, body, actions, more);
  scrim.append(panel);
  scrim.hidden = true;
  opts.root.append(scrim);

  let visible = false;
  let disposed = false;
  let shownKey = '';

  function attach(): void {
    try {
      opts.focus?.attach(scrim);
    } catch {
      /* focus navigator not ready */
    }
  }

  function detach(): void {
    try {
      opts.focus?.detach(scrim);
    } catch {
      /* ignore */
    }
  }

  function render(): void {
    if (disposed) return;
    const c = opts.flow.card;
    if (!c) {
      if (visible) {
        visible = false;
        shownKey = '';
        scrim.hidden = true;
        detach();
      }
      return;
    }
    const t = reconnectCardText(c);
    const key = `${c.human}|${t.title}|${t.body}|${t.more}|${c.canTouch ? 1 : 0}|${c.canCpu ? 1 : 0}`;
    if (key !== shownKey) {
      shownKey = key;
      player.textContent = t.player;
      player.className = `reconnect-player ${c.human === 0 ? 'p1' : c.human === 1 ? 'p2' : ''}`;
      title.textContent = t.title;
      body.textContent = t.body;
      touchBtn.hidden = !c.canTouch;
      cpuBtn.hidden = !c.canCpu;
      actions.hidden = !c.canTouch && !c.canCpu;
      more.textContent = t.more;
      more.hidden = t.more === '';
      scrim.dataset.human = String(c.human);
      scrim.dataset.device = c.deviceId;
      scrim.dataset.reconnected = c.reconnected ? '1' : '0';
      if (visible) attach(); // buttons changed: re-pick the focused one inside the card
    }
    if (!visible) {
      visible = true;
      scrim.hidden = false;
      attach();
    }
  }

  const unsub = opts.flow.subscribe(render);
  render();

  return {
    get visible() {
      return visible;
    },
    get element() {
      return disposed ? null : scrim;
    },
    ensureFocusTop() {
      if (!visible || !opts.focus) return;
      const cur = (opts.focus as Partial<{ current: HTMLElement | null }>).current;
      if (cur !== undefined && cur !== null && scrim.contains(cur)) return;
      if (cur === null && (touchBtn.hidden && cpuBtn.hidden)) return; // nothing focusable: already top (or no ring)
      attach();
    },
    dispose() {
      if (disposed) return;
      unsub();
      if (visible) detach();
      visible = false;
      disposed = true;
      scrim.remove();
    },
  };
}

// ============================================================ install

export interface InstallReconnectOptions extends ReconnectFlowOptions {
  /** Where the card goes (#ui). Null: no card (headless). */
  root?: HTMLElement | null;
  focus?: FocusNavigator | null;
  /** Touch / key activity is heard here (window). Default: the root's window. */
  eventTarget?: EventTarget | null;
  /**
   * Drive flow.update by requestAnimationFrame while a card is open (default true when rAF exists). The app loop may
   * call handle.update(nowMs) itself (before the input pump); both together are harmless.
   */
  autoFrame?: boolean;
}

export interface ReconnectHandle {
  readonly flow: ReconnectFlow;
  readonly card: ReconnectCard | null;
  /** Per animation frame (optional when autoFrame is on): flow.update + focus upkeep. */
  update(nowMs: number): void;
  dispose(): void;
}

/** True when a connected pad has a fresh press at the latest poll (menu actions of that poll came from a pad). */
function anyPadPress(pads: PadManager): boolean {
  const slots = pads.slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    if (s.connected && s.active && padAnyPressedEdge(s)) return true;
  }
  return false;
}

/**
 * Install the reconnect flow for the app (boot): flow + card in `root` + focus guard + touch / key activity + rAF
 * driver. While a card is shown, menu actions that come from a pad press are consumed (that press resumes through
 * the flow and must never click a card button or the pause menu under it), and Back / tab switches are consumed;
 * keyboard directions and Confirm drive the card's buttons.
 */
export function installReconnectFlow(opts: InstallReconnectOptions): ReconnectHandle {
  const flow = createReconnectFlow(opts);
  const card = opts.root ? createReconnectCard({ root: opts.root, flow, focus: opts.focus ?? null }) : null;
  const pads = opts.devices.pads;
  const disposers: (() => void)[] = [];
  let disposed = false;

  const unsubAction = opts.focus?.onAction((a: MenuAction) => {
    if (!flow.card) return false;
    card?.ensureFocusTop();
    if (anyPadPress(pads)) return true;
    if (a === MenuAction.BACK || a === MenuAction.TAB_PREV || a === MenuAction.TAB_NEXT || a === MenuAction.START) return true;
    return false;
  });
  if (unsubAction) disposers.push(unsubAction);

  const target: EventTarget | null = opts.eventTarget !== undefined
    ? opts.eventTarget
    : opts.root?.ownerDocument?.defaultView ?? null;
  if (target) {
    const onPointer = (e: Event): void => {
      const t = (e as PointerEvent).pointerType;
      if (t === 'touch' || t === 'pen') flow.noteActivity(TOUCH_DEVICE_ID, e.timeStamp);
    };
    const onKey = (e: Event): void => {
      const k = e as KeyboardEvent;
      if (k.repeat) return;
      const t = k.target as HTMLElement | null;
      if (t && typeof t.closest === 'function' && t.closest('input, textarea, select, [contenteditable="true"]')) return;
      flow.noteActivity(KEYBOARD_DEVICE_ID, e.timeStamp);
    };
    target.addEventListener('pointerdown', onPointer, true);
    target.addEventListener('keydown', onKey, true);
    disposers.push(() => {
      target.removeEventListener('pointerdown', onPointer, true);
      target.removeEventListener('keydown', onKey, true);
    });
  }

  const update = (nowMs: number): void => {
    if (disposed) return;
    flow.update(nowMs);
    if (flow.card) card?.ensureFocusTop();
  };

  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
  const caf = typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null;
  const auto = (opts.autoFrame ?? true) && raf !== null;
  let rafId = 0;
  const frame = (t: number): void => {
    rafId = 0;
    if (disposed) return;
    update(t);
    if (flow.card || flow.holding) rafId = raf!(frame);
  };
  if (auto) {
    disposers.push(flow.subscribe(() => {
      if (!disposed && rafId === 0 && (flow.card || flow.holding)) rafId = raf!(frame);
    }));
  }

  return {
    flow,
    card,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rafId !== 0 && caf) caf(rafId);
      rafId = 0;
      for (const d of disposers.splice(0).reverse()) {
        try {
          d();
        } catch {
          /* keep disposing */
        }
      }
      card?.dispose();
      flow.dispose();
    },
  };
}
