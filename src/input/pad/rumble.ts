/**
 * [PAD-07] Rumble on goal, post and hard tackle where `vibrationActuator` exists (section 10), behind the
 * settings.controls.pad.rumble toggle. Driven by sim events (ARCHITECTURE rule 4), never feeds back.
 *
 * WAVE 0 BASELINE (FND-05): pulse() plays a dual-rumble effect if supported; onEvents is a stub.
 */

import type { EventBuffer } from '../../contracts/events';
import type { ReadonlySimState } from '../../contracts/state';
import type { PadManager } from './manager';

export interface Rumble {
  /** Consume the events of the latest tick (goal, post, hard tackle) for pads bound to `human`. */
  onEvents(events: EventBuffer, state: ReadonlySimState): void;
  /** Play a rumble on one pad: strong/weak 0..1, duration ms. No-op when unsupported or disabled. */
  pulse(key: string, strong: number, weak: number, ms: number): void;
  setEnabled(on: boolean): void;
}

interface DualRumbleActuator {
  playEffect(type: 'dual-rumble', params: { duration: number; strongMagnitude: number; weakMagnitude: number }): Promise<unknown>;
}

export function createRumble(manager: PadManager, enabled = true): Rumble {
  let on = enabled;
  return {
    onEvents() { /* PAD-07 */ },
    pulse(key, strong, weak, ms) {
      if (!on) return;
      const s = manager.find(key);
      const act = (s?.pad as unknown as { vibrationActuator?: DualRumbleActuator } | null)?.vibrationActuator;
      if (!act || typeof act.playEffect !== 'function') return;
      act.playEffect('dual-rumble', {
        duration: Math.max(0, Math.min(1000, ms)),
        strongMagnitude: Math.max(0, Math.min(1, strong)),
        weakMagnitude: Math.max(0, Math.min(1, weak)),
      }).catch(() => { /* unsupported effect */ });
    },
    setEnabled(v) { on = v; },
  };
}
