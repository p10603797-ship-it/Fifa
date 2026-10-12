/**
 * [PAD-03] Disconnect / reconnect handling (section 10 "Controller quality bar"): a pad bound to a side that
 * disconnects mid-match auto-pauses with a reconnect card; any button on that pad resumes; the card offers to
 * hand that side to touch or the CPU. Bindings follow pad identity (PadSlot.key survives a reconnect at a new
 * index, see manager.ts). Glitch list: "controller disconnect during a penalty".
 *
 * WAVE 0 BASELINE (FND-05): a watcher that reports bound pads going away and coming back. PAD-03 adds the
 * pause flow and the hand-over choice (with the app/UI owners).
 */

import type { PadManager } from './manager';

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
