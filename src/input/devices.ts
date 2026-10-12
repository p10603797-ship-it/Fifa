/**
 * [PAD-01] Device registry (contracts/app.ts DeviceRegistry). Knows which local input devices exist and creates
 * the InputSource for a device bound to a human:
 *  - 'touch'     when the platform has touch (PlatformInfo.isTouch). Its source owns the touch overlay DOM inside
 *                opts.touchRoot: created at match start, removed on dispose (match end). One at a time.
 *  - 'keyboard'  on desktop (not an iPad), or as soon as any key is pressed.
 *  - 'pad:<n>'   only after one of the pad's buttons is pressed (section 3); the key survives a reconnect at a new
 *                index (identity = gamepad.id + index, see pad/manager.ts). Disconnected pads stay listed with
 *                connected = false so bindings and the reconnect card can refer to them.
 * Every source it creates polls the shared pad manager in pollFrame, so pads pressed mid-match are discovered.
 * subscribe() fires when the list changes; lastActive() is the most recently used device (tutorial, glyphs).
 *
 * WAVE 0 BASELINE (FND-05). PAD-01 owns and refines it.
 */

import type { DeviceInfo, DeviceRegistry, PlatformInfo, SettingsStore } from '../contracts/app';
import { PadFamily } from '../contracts/enums';
import { clearInputFrame, type CameraProjector, type InputSource } from '../contracts/input';
import type { ReadonlySimState } from '../contracts/state';
import { createKeyboardSource } from './keyboard';
import { detectPadFamily, padLabel } from './pad/glyphs';
import { getPadManager, type PadManager } from './pad/manager';
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
}

export interface DotkickDeviceRegistry extends DeviceRegistry {
  /** The pad manager this registry follows. */
  readonly pads: PadManager;
  dispose(): void;
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

export function createDeviceRegistry(opts: DeviceRegistryOptions): DotkickDeviceRegistry {
  const pads = opts.pads ?? getPadManager();
  const win = opts.touchRoot.ownerDocument.defaultView ?? window;
  const subs: ((d: DeviceInfo[]) => void)[] = [];
  let keyboardSeen = !opts.platform.isIPad;
  let lastKeyMs = -1;
  let lastTouchMs = -1;
  let touchSource: InputSource | null = null;

  function list(): DeviceInfo[] {
    const out: DeviceInfo[] = [];
    if (opts.platform.isTouch) out.push({ id: 'touch', kind: 'touch', label: 'Touch', family: PadFamily.GENERIC, connected: true });
    if (keyboardSeen) out.push({ id: 'keyboard', kind: 'keyboard', label: 'Keyboard', family: PadFamily.GENERIC, connected: true });
    const slots = pads.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (!s.active) continue;
      out.push({ id: s.key, kind: 'pad', label: padLabel(s.gamepadId), family: detectPadFamily(s.gamepadId), connected: s.connected });
    }
    return out;
  }

  function notify(): void {
    if (subs.length === 0) return;
    const d = list();
    for (let i = 0; i < subs.length; i++) subs[i]!(d);
  }

  const unsubPads = pads.subscribe(notify);
  const onKey = (e: Event): void => {
    lastKeyMs = e.timeStamp || performance.now();
    if (!keyboardSeen) {
      keyboardSeen = true;
      notify();
    }
  };
  const onPointer = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') lastTouchMs = e.timeStamp || performance.now();
  };
  win.addEventListener('keydown', onKey, true);
  win.addEventListener('pointerdown', onPointer, true);

  /** Make every source poll the shared pad manager once per frame (pads pressed mid-match get discovered). */
  function withPadPolling<T extends InputSource>(src: T): T {
    const inner = src.pollFrame?.bind(src);
    src.pollFrame = (nowMs: number): void => {
      pads.poll(nowMs);
      inner?.(nowMs);
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
      if (deviceId.startsWith('pad:')) return createPadSource({ key: deviceId, onPause, manager: pads });
      return withPadPolling(createNullSource(deviceId));
    },
    lastActive(): string | null {
      let id: string | null = null;
      let t = -1;
      if (opts.platform.isTouch && lastTouchMs > t) { id = 'touch'; t = lastTouchMs; }
      if (keyboardSeen && lastKeyMs > t) { id = 'keyboard'; t = lastKeyMs; }
      if (pads.lastActiveKey !== null && pads.lastActiveMs > t) id = pads.lastActiveKey;
      return id;
    },
    dispose() {
      unsubPads();
      win.removeEventListener('keydown', onKey, true);
      win.removeEventListener('pointerdown', onPointer, true);
      touchSource?.dispose();
      touchSource = null;
      subs.length = 0;
    },
  };
}
