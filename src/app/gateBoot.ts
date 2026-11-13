/**
 * [GATE] Runs the game behind the password lock (D-047, D-048). src/main.ts calls startBehindGate(start) instead of boot():
 * an unlocked device starts at once, in the same tick (no extra wait, no visible lock); otherwise the lock screen
 * (src/ui/screens/gate.ts) blocks everything until a code is accepted, then removes itself and calls `start`, so
 * boot goes exactly where it would have gone (splash, a `?room=` join link, `?bench=1`).
 *
 * The lock checks passwords with the online checker (src/app/gateOnline.ts, GATE_SERVER_URL), which is created but
 * contacted only when a password is submitted; an unlocked device makes no request at all. The e2e test hook
 * (src/app/gate.ts readTestHook) can point it at another server or swap in the local redeemer with test hashes.
 *
 * After a successful unlock, navigator.storage.persist() is requested when the browser has it (best effort; it asks
 * the browser not to evict this site's storage, which holds the unlock).
 */
import { GATE_SERVER_TIMEOUT_MS, GATE_SERVER_URL } from '../data/gateConfig';
import { createSafeStorage, type KeyValueStorage } from '../platform/storage';
import { mountGateScreen } from '../ui/screens/gate';
import { createGate, createLocalRedeemer, readTestHook, type CodeRedeemer, type Gate } from './gate';
import { createOnlineRedeemer } from './gateOnline';

export interface GateBootOptions {
  /** Default: safe storage over localStorage. */
  storage?: KeyValueStorage;
  /** Default: #ui (created when missing). */
  root?: HTMLElement;
}

/** Which redeemer the lock uses, and why (tests read it). */
export interface BootRedeemer {
  kind: 'online' | 'local';
  /** The checker's URL ('online'). */
  url: string | null;
  redeemer: CodeRedeemer;
}

/**
 * The online checker at GATE_SERVER_URL, unless the e2e test hook says otherwise: its serverUrl replaces the URL;
 * hashes alone select the local redeemer with those hashes. An empty server URL (a fork without a checker) also falls
 * back to the local redeemer, which then accepts nothing.
 */
export function chooseRedeemer(storage: KeyValueStorage, serverUrl: string = GATE_SERVER_URL): BootRedeemer {
  const hook = readTestHook();
  const url = hook?.serverUrl ?? (hook?.hashes ? null : serverUrl || null);
  if (url) return { kind: 'online', url, redeemer: createOnlineRedeemer({ url, storage, timeoutMs: GATE_SERVER_TIMEOUT_MS }) };
  return { kind: 'local', url: null, redeemer: createLocalRedeemer({ storage, hashes: hook?.hashes ?? [] }) };
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
  const gate = createGate({ storage, redeemer: chooseRedeemer(storage).redeemer });
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
