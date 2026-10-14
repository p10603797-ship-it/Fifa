/**
 * [PAD-01] Device registry (contracts/app.ts DeviceRegistry). Knows which local input devices exist and creates
 * the InputSource for a device bound to a human:
 *  - 'touch'     when the platform has touch (PlatformInfo.isTouch). Its source owns the touch overlay DOM inside
 *                opts.touchRoot: created at match start, removed on dispose (match end). One at a time.
 *  - 'keyboard'  on desktop (not an iPad), or as soon as a key is pressed outside a text field (an iPad's on-screen
 *                keyboard typing a nickname never lists a keyboard).
 *  - 'pad:<n>'   only after one of the pad's buttons is pressed (section 3); the key survives a reconnect at a new
 *                index (identity = gamepad.id + index, see pad/manager.ts). Disconnected pads stay listed with
 *                connected = false so bindings and the reconnect card can refer to them. Pads are listed in the order
 *                they were first pressed and labelled 'Controller 1', 'Controller 2' (side select, section 11:
 *                the list order is Touch, Controller 1, Controller 2, ..., Keyboard);
 *                `family` is the detected family (pad/glyphs.ts) unless settings.controls.pad.familyOverride is set,
 *                and `product` is the friendly product name.
 * Every source it creates polls the shared pad manager in pollFrame, so pads pressed mid-match are discovered.
 * subscribe() fires when the list changes (a pad pressed for the first time, a disconnect or reconnect, the keyboard
 * appearing, the family override changing); lastActive() is the most recently used connected device (tutorial,
 * glyphs, tips).
 *
 * Bound pads (section 10 "Disconnect mid-match: auto-pause with a reconnect card"): a pad with a live InputSource
 * from createSource() is bound to that human for the match. When it disconnects, opts.onPadDisconnect(human, id) and
 * every onBoundPadChange listener run (the session auto-pauses; PAD-03 shows the card); when it comes back (same key,
 * any index) onPadReconnect runs. A pad bound while already disconnected is reported on its source's first frame.
 * Disposing the source unbinds it.
 */

import type { DeviceInfo, DeviceRegistry, PlatformInfo, SettingsStore } from '../contracts/app';
import { PadFamily } from '../contracts/enums';
import { clearInputFrame, type CameraProjector, type InputSource } from '../contracts/input';
import type { Settings } from '../contracts/settings';
import type { ReadonlySimState } from '../contracts/state';
import { createKeyboardSource, isEditableTarget } from './keyboard';
import { detectPadFamily, effectiveFamily, padLabel } from './pad/glyphs';
import { getPadManager, type PadEventKind, type PadManager, type PadSlot } from './pad/manager';
import { createPadSource } from './pad/mapper';
import { createTouchInput } from './touch/index';

export interface DeviceRegistryOptions {
  /** Container for the touch overlay (index.html <div id="touch">). */
  touchRoot: HTMLElement;
  /** Active camera projector (null outside matches / headless). */
  getProjector(): CameraProjector | null;
  /** Current sim state (null outside matches). */
  getState(): ReadonlySimState | null;
  settings: SettingsStore;
  platform: PlatformInfo;
  /** A device asked to pause (Options / Menu, Esc / P, the touch PAUSE button). */
  onPause(human: number): void;
  /** Defaults to the shared pad manager. */
  pads?: PadManager;
  /** A pad bound to `human` (live source) disconnected: auto-pause; PAD-03 shows the reconnect card. */
  onPadDisconnect?(human: number, deviceId: string): void;
  /** A bound pad that had disconnected is back (same device id, possibly at a new index). */
  onPadReconnect?(human: number, deviceId: string): void;
}

/** DeviceInfo plus the friendly product name ('Xbox controller', ...; the label again for touch / keyboard). */
export interface DotkickDeviceInfo extends DeviceInfo {
  product: string;
}

/** A pad with a live InputSource (bound to a human for the current match). */
export interface PadBinding {
  readonly deviceId: string;
  readonly human: number;
  readonly connected: boolean;
}

export type PadBindingListener = (deviceId: string, human: number, connected: boolean) => void;

export interface DotkickDeviceRegistry extends DeviceRegistry {
  /** The pad manager this registry follows. */
  readonly pads: PadManager;
  list(): DotkickDeviceInfo[];
  /** Pads bound by createSource() and not yet disposed, with their connection state. */
  boundPads(): PadBinding[];
  /** Bound-pad disconnects / reconnects (the same moments as opts.onPadDisconnect / onPadReconnect). */
  onBoundPadChange(fn: PadBindingListener): () => void;
  dispose(): void;
}

/** Label shown for the n-th pad pressed this session (section 11 side select: Controller 1, Controller 2). */
export function padDeviceLabel(ordinal: number): string {
  return ordinal > 0 ? `Controller ${ordinal}` : 'Controller';
}

/** A source that produces neutral frames (unknown device ids never throw). */
function createNullSource(id: string): InputSource {
  return {
    id, kind: 'none',
    sample(out) { clearInputFrame(out); },
    releaseAll() { /* nothing held */ },
    dispose() { /* nothing owned */ },
  };
}

interface MutableBinding {
  deviceId: string;
  human: number;
  connected: boolean;
  /** Bound while disconnected and not reported yet (reported on the source's first frame). */
  reportPending: boolean;
}

function familyOverride(s: Readonly<Settings> | null | undefined): PadFamily {
  const f = s?.controls?.pad?.familyOverride;
  return typeof f === 'number' ? f : PadFamily.AUTO;
}

function byOrdinal(a: PadSlot, b: PadSlot): number {
  return a.ordinal - b.ordinal;
}

export function createDeviceRegistry(opts: DeviceRegistryOptions): DotkickDeviceRegistry {
  const pads = opts.pads ?? getPadManager();
  const win: EventTarget | null = opts.touchRoot.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
  const subs: ((d: DeviceInfo[]) => void)[] = [];
  const bindListeners: PadBindingListener[] = [];
  const bindings: MutableBinding[] = [];
  let keyboardSeen = !opts.platform.isIPad;
  let lastKeyMs = -1;
  let lastTouchMs = -1;
  let touchSource: InputSource | null = null;
  let override = familyOverride(opts.settings.get());
  let disposed = false;

  function list(): DotkickDeviceInfo[] {
    const out: DotkickDeviceInfo[] = [];
    if (opts.platform.isTouch) out.push({ id: 'touch', kind: 'touch', label: 'Touch', product: 'Touch', family: PadFamily.GENERIC, connected: true });
    const active: PadSlot[] = [];
    const slots = pads.slots;
    for (let i = 0; i < slots.length; i++) if (slots[i]!.active) active.push(slots[i]!);
    active.sort(byOrdinal);
    for (let i = 0; i < active.length; i++) {
      const s = active[i]!;
      out.push({
        id: s.key, kind: 'pad', label: padDeviceLabel(s.ordinal), product: padLabel(s.gamepadId),
        family: effectiveFamily(detectPadFamily(s.gamepadId), override), connected: s.connected,
      });
    }
    if (keyboardSeen) out.push({ id: 'keyboard', kind: 'keyboard', label: 'Keyboard', product: 'Keyboard', family: PadFamily.GENERIC, connected: true });
    return out;
  }

  function notify(): void {
    if (subs.length === 0 || disposed) return;
    const d = list();
    const ls = subs.slice();
    let failed = false;
    let firstErr: unknown = null;
    for (let i = 0; i < ls.length; i++) {
      try {
        ls[i]!(d);
      } catch (err) {
        if (!failed) { failed = true; firstErr = err; }
      }
    }
    if (failed) throw firstErr;
  }

  function hasActivePad(): boolean {
    const slots = pads.slots;
    for (let i = 0; i < slots.length; i++) if (slots[i]!.active) return true;
    return false;
  }

  /** Tell the session and listeners that a bound pad went away / came back. Every callback runs; first error rethrown. */
  function reportBinding(b: MutableBinding, connected: boolean): void {
    let failed = false;
    let firstErr: unknown = null;
    const run = (fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        if (!failed) { failed = true; firstErr = err; }
      }
    };
    if (connected) run(() => opts.onPadReconnect?.(b.human, b.deviceId));
    else run(() => opts.onPadDisconnect?.(b.human, b.deviceId));
    const ls = bindListeners.slice();
    for (let i = 0; i < ls.length; i++) run(() => ls[i]!(b.deviceId, b.human, connected));
    if (failed) throw firstErr;
  }

  const onPadEvent = (kind: PadEventKind, slot: PadSlot): void => {
    if (kind !== 'disconnect' && kind !== 'reconnect') return;
    const connected = kind === 'reconnect';
    const snapshot = bindings.slice();
    let failed = false;
    let firstErr: unknown = null;
    for (let i = 0; i < snapshot.length; i++) {
      const b = snapshot[i]!;
      if (b.deviceId !== slot.key || b.connected === connected || bindings.indexOf(b) < 0) continue;
      b.connected = connected;
      if (b.reportPending) {
        // Bound while missing and back before its first frame: nothing to report.
        b.reportPending = false;
        if (connected) continue;
      }
      try {
        reportBinding(b, connected);
      } catch (err) {
        if (!failed) { failed = true; firstErr = err; }
      }
    }
    if (failed) throw firstErr;
  };

  const unsubPads = pads.subscribe(notify);
  const unsubPadEvents = pads.onPadEvent(onPadEvent);
  const unsubSettings = opts.settings.subscribe((s) => {
    const f = familyOverride(s);
    if (f === override) return;
    override = f;
    if (hasActivePad()) notify();
  });

  const onKey = (e: Event): void => {
    if (isEditableTarget(e.target)) return;
    lastKeyMs = e.timeStamp || performance.now();
    if (!keyboardSeen) {
      keyboardSeen = true;
      notify();
    }
  };
  const onPointer = (e: Event): void => {
    const t = (e as PointerEvent).pointerType;
    if (t === 'touch' || t === 'pen') lastTouchMs = e.timeStamp || performance.now();
  };
  win?.addEventListener('keydown', onKey, true);
  win?.addEventListener('pointerdown', onPointer, true);

  /** Make every source poll the shared pad manager once per frame (pads pressed mid-match get discovered). */
  function withPadPolling<T extends InputSource>(src: T): T {
    const inner = src.pollFrame?.bind(src);
    src.pollFrame = (nowMs: number): void => {
      pads.poll(nowMs);
      inner?.(nowMs);
    };
    return src;
  }

  function createBoundPadSource(deviceId: string, human: number, onPause: () => void): InputSource {
    const src = createPadSource({ key: deviceId, onPause, manager: pads, settings: opts.settings });
    const slot = pads.find(deviceId);
    const connected = slot !== null && slot.connected;
    const b: MutableBinding = { deviceId, human, connected, reportPending: !connected };
    bindings.push(b);
    const innerPoll = src.pollFrame?.bind(src);
    src.pollFrame = (nowMs: number): void => {
      if (innerPoll) innerPoll(nowMs);
      else pads.poll(nowMs);
      if (b.reportPending && bindings.indexOf(b) >= 0) {
        b.reportPending = false;
        const s = pads.find(deviceId);
        if (s === null || !s.connected) reportBinding(b, false);
      }
    };
    const innerDispose = src.dispose.bind(src);
    src.dispose = (): void => {
      const i = bindings.indexOf(b);
      if (i >= 0) bindings.splice(i, 1);
      innerDispose();
    };
    return src;
  }

  return {
    pads,
    list,
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    createSource(deviceId: string, human: number): InputSource {
      const onPause = (): void => opts.onPause(human);
      if (deviceId === 'touch') {
        if (touchSource) touchSource.dispose();
        const src = createTouchInput({
          root: opts.touchRoot, getProjector: opts.getProjector, getState: opts.getState, settings: opts.settings,
          platform: opts.platform, onPause,
        });
        const dispose = src.dispose.bind(src);
        src.dispose = (): void => {
          if (touchSource === src) touchSource = null;
          dispose();
        };
        touchSource = src;
        return withPadPolling(src);
      }
      if (deviceId === 'keyboard') return withPadPolling(createKeyboardSource({ onPause }));
      if (deviceId.startsWith('pad:')) return createBoundPadSource(deviceId, human, onPause);
      return withPadPolling(createNullSource(deviceId));
    },
    lastActive(): string | null {
      let id: string | null = null;
      let t = -1;
      if (opts.platform.isTouch && lastTouchMs > t) { id = 'touch'; t = lastTouchMs; }
      if (keyboardSeen && lastKeyMs > t) { id = 'keyboard'; t = lastKeyMs; }
      const slots = pads.slots;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        if (s.active && s.connected && s.lastInputMs > t) { id = s.key; t = s.lastInputMs; }
      }
      return id;
    },
    boundPads(): PadBinding[] {
      const out: PadBinding[] = [];
      for (let i = 0; i < bindings.length; i++) {
        const b = bindings[i]!;
        out.push({ deviceId: b.deviceId, human: b.human, connected: b.connected });
      }
      return out;
    },
    onBoundPadChange(fn: PadBindingListener) {
      bindListeners.push(fn);
      return () => {
        const i = bindListeners.indexOf(fn);
        if (i >= 0) bindListeners.splice(i, 1);
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubPads();
      unsubPadEvents();
      unsubSettings();
      win?.removeEventListener('keydown', onKey, true);
      win?.removeEventListener('pointerdown', onPointer, true);
      touchSource?.dispose();
      touchSource = null;
      subs.length = 0;
      bindListeners.length = 0;
      bindings.length = 0;
    },
  };
}
