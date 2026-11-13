/**
 * [GATE] Runs the game behind the password lock (D-047). src/main.ts calls startBehindGate(start) instead of boot():
 * an unlocked device starts at once, in the same tick (no extra wait, no visible lock); otherwise the lock screen
 * (src/ui/screens/gate.ts) blocks everything until a code is accepted, then removes itself and calls `start`, so
 * boot goes exactly where it would have gone (splash, a `?room=` join link, `?bench=1`).
 *
 * After a successful unlock, navigator.storage.persist() is requested when the browser has it (best effort; it asks
 * the browser not to evict this site's storage, which holds the unlock).
 */
import { GATE_CODE_HASHES } from '../data/gateCodes';
import { createSafeStorage, type KeyValueStorage } from '../platform/storage';
import { mountGateScreen } from '../ui/screens/gate';
import { acceptedHashes, createGate, createLocalRedeemer, type Gate } from './gate';

export interface GateBootOptions {
  /** Default: safe storage over localStorage. */
  storage?: KeyValueStorage;
  /** Default: #ui (created when missing). */
  root?: HTMLElement;
}

export interface GateBootHandle {
  readonly gate: Gate;
  /** True while the lock screen is up. */
  readonly locked: boolean;
  dispose(): void;
}

/** Ask the browser to keep this site's storage (ignored where missing or refused). */
export function requestPersistentStorage(): void {
  try {
    const sm = (navigator as { storage?: { persist?: () => Promise<boolean> } }).storage;
    if (sm && typeof sm.persist === 'function') void sm.persist().catch(() => undefined);
  } catch {
    /* best effort */
  }
}

function uiRoot(): HTMLElement {
  let el = document.getElementById('ui');
  if (!el) {
    el = document.createElement('div');
    el.id = 'ui';
    document.body.appendChild(el);
  }
  return el;
}

/** Start the game now when this device is unlocked, else after the lock screen accepts a code. */
export function startBehindGate(start: () => void, opts: GateBootOptions = {}): GateBootHandle {
  const storage = opts.storage ?? createSafeStorage();
  const gate = createGate({ storage, redeemer: createLocalRedeemer({ storage, hashes: acceptedHashes(GATE_CODE_HASHES) }) });
  if (gate.isUnlocked()) {
    start();
    return { gate, locked: false, dispose: () => undefined };
  }
  let locked = true;
  const screen = mountGateScreen(opts.root ?? uiRoot(), {
    gate,
    onRedeemed: () => requestPersistentStorage(),
    onUnlocked: () => {
      locked = false;
      start();
    },
  });
  return {
    gate,
    get locked() {
      return locked;
    },
    dispose() {
      screen.dispose();
    },
  };
}
