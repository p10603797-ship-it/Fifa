/**
 * QF-3 QA-28: controller lifecycle under a seeded random storm, through the real pad manager (PAD-01), device registry
 * with bound pad sources (PAD-02 mapper), the PAD-03 reconnect flow and a session double with the real session's
 * pause rules (only the pauser resumes; resume and pause call the provider's releaseAll, as src/app/session.ts does).
 * Two pads with different ids, bound to P1 and P2; random presses, disconnects, reconnects at the same or a NEW index
 * (including the two pads swapping indices), Options presses. Invariants every frame:
 *  - no phantom input: a button in a human's frame is held on (or was pressed since the last sample on) HIS pad;
 *  - no crosstalk: P1 only ever presses Cross / Circle, P2 only Square / Triangle;
 *  - while a bound pad is missing the session stays paused (no tick could see the zeroed pad);
 *  - after the storm, both pads back and a press: the session resumes and each pad drives its own human.
 */
import { describe, expect, it } from 'vitest';
import type { HumanBinding, MatchSetup, PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { Btn, createInputFrame, type InputSource } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createDeviceRegistry } from '../../src/input/devices';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { createReconnectFlow, type ReconnectSession } from '../../src/input/pad/reconnect';
import { initMatch } from '../../src/sim/init';
import { mockPad, setBtn, type MockPad } from './pad-02-helpers';

const ID_A = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)';
const ID_B = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** P1 presses only these standard buttons, P2 only those (crosstalk check). */
const OWN: readonly (readonly number[])[] = [[PadButton.SOUTH, PadButton.EAST], [PadButton.WEST, PadButton.NORTH]];
const BIT: Record<number, number> = { [PadButton.SOUTH]: Btn.PASS, [PadButton.EAST]: Btn.SHOOT, [PadButton.WEST]: Btn.LOB, [PadButton.NORTH]: Btn.THROUGH };
const FOREIGN = [Btn.LOB | Btn.THROUGH, Btn.PASS | Btn.SHOOT];

describe('QF-3 QA-28 controller lifecycle storm', () => {
  it('random presses, disconnects and reconnects at new indices on two pads: no phantom input, no crosstalk, paused while missing', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rand = rng(seed);
      const pads: MockPad[] = [mockPad(0, ID_A), mockPad(1, ID_B)];
      const list: (MockPad | null)[] = [pads[0]!, pads[1]!, null, null];
      const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
      const settings = createDefaultSettings();
      const store: SettingsStore = {
        get: () => settings, update: (m) => m(settings), subscribe: () => () => {}, reset: () => {}, persistent: false,
        loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
      };
      const platform: PlatformInfo = { isIPad: true, isTouch: false, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
      let t = 1000;
      const poll = (): void => { t += 8; mgr.poll(t); };
      const reg = createDeviceRegistry({
        touchRoot: { ownerDocument: { defaultView: null } } as unknown as HTMLElement,
        getProjector: () => null, getState: () => null, settings: store, platform, onPause: () => {}, pads: mgr,
      });
      // Activate both pads (pad:1 = A, pad:2 = B).
      for (const p of pads) { setBtn(p, PadButton.SOUTH, 1); poll(); setBtn(p, PadButton.SOUTH, 0); poll(); }
      const sources: InputSource[] = [reg.createSource('pad:1', 0), reg.createSource('pad:2', 1)];
      const bindings: HumanBinding[] = [{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['pad:2'] }];
      const session: ReconnectSession & { active: boolean; paused: boolean; pausedBy: number } = {
        active: true, paused: false, pausedBy: -1,
        pause(by) {
          if (session.paused) return;
          session.paused = true; session.pausedBy = by;
          for (const s of sources) s.releaseAll();
        },
        resume(by) {
          if (!session.paused) return true;
          if (session.pausedBy !== -1 && by !== session.pausedBy) return false;
          session.paused = false; session.pausedBy = -1;
          for (const s of sources) s.releaseAll();
          return true;
        },
        getSetup: () => ({ config: {} as MatchSetup['config'], bindings }),
      };
      const flow = createReconnectFlow({ session, devices: reg, platform: { isTouch: false } });
      const state = initMatch(createMatchConfig()) as SimState;
      const frame = createInputFrame();
      /** Index in `list` of each pad (-1 = unplugged). */
      const where = [0, 1];
      /** Buttons each pad pressed since the last sample (latched presses may be reported then). */
      const pressedSince = [0, 0];

      for (let f = 0; f < 600; f++) {
        const k = rand();
        const i = rand() < 0.5 ? 0 : 1;
        const p = pads[i]!;
        if (k < 0.05 && where[i]! >= 0) {
          // Unplug (the manager zeroes everything at once).
          list[where[i]!] = null; p.connected = false; where[i] = -1;
          for (const b of p.buttons) { b.pressed = false; b.value = 0; b.touched = false; }
        } else if (k < 0.1 && where[i]! < 0) {
          // Plug back at a free index: the old one, or a new one (both pads may end up swapped).
          let idx = rand() < 0.5 ? i : 1 - i;
          if (list[idx] !== null) idx = list[0] === null ? 0 : list[1] === null ? 1 : list[2] === null ? 2 : 3;
          p.index = idx; p.connected = true; list[idx] = p; where[i] = idx;
        } else if (k < 0.45 && where[i]! >= 0) {
          const b = OWN[i]![rand() < 0.5 ? 0 : 1]!;
          const down = !p.buttons[b]!.pressed;
          setBtn(p, b, down ? 1 : 0);
          if (down) pressedSince[i]! |= BIT[b]!;
        }
        poll();
        flow.update(t);
        // Invariant: a bound pad missing (and in use) => paused. Both are always "in use" here (no other device).
        if (where[0]! < 0 || where[1]! < 0) expect(session.paused, `seed ${seed} frame ${f}: paused while a pad is missing`).toBe(true);
        if (session.paused) continue; // no tick, no sample
        for (let h = 0; h < 2; h++) {
          sources[h]!.pollFrame!(t);
          sources[h]!.sample(frame, { tick: f, human: h, side: h, state, projector: null });
          const held = OWN[h]!.reduce((m, b) => (pads[h]!.buttons[b]!.pressed ? m | BIT[b]! : m), 0);
          const face = frame.buttons & (Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH);
          expect(face & FOREIGN[h]!, `seed ${seed} frame ${f}: crosstalk into P${h + 1}`).toBe(0);
          expect(face & ~(held | pressedSince[h]!), `seed ${seed} frame ${f}: phantom input for P${h + 1}`).toBe(0);
          pressedSince[h] = 0;
        }
      }
      // Both back, any press resumes; each pad drives its own human again.
      for (let i = 0; i < 2; i++) {
        if (where[i]! < 0) {
          const idx = list[i] === null ? i : list[1 - i] === null ? 1 - i : 2;
          pads[i]!.index = idx; pads[i]!.connected = true; list[idx] = pads[i]!; where[i] = idx;
        }
        for (const b of pads[i]!.buttons) { b.pressed = false; b.value = 0; }
      }
      for (let n = 0; n < 4; n++) { poll(); flow.update(t); }
      for (let i = 0; i < 2 && session.paused; i++) {
        setBtn(pads[i]!, PadButton.R1, 1); poll(); flow.update(t);
        setBtn(pads[i]!, PadButton.R1, 0); poll(); flow.update(t);
      }
      expect(session.paused, `seed ${seed}: resumed after both pads are back`).toBe(false);
      for (let h = 0; h < 2; h++) {
        const b = OWN[h]![0]!;
        setBtn(pads[h]!, b, 1); poll();
        // Two samples: when the sim last saw this bit held (before the pause), the first one shows the release so the
        // press is a fresh edge on the second.
        let got = 0;
        for (let n = 0; n < 2; n++) {
          sources[h]!.pollFrame!(t);
          sources[h]!.sample(frame, { tick: 9999 + n, human: h, side: h, state, projector: null });
          got |= frame.buttons;
        }
        expect(got & BIT[b]!, `seed ${seed}: P${h + 1}'s pad drives P${h + 1}`).toBe(BIT[b]!);
        setBtn(pads[h]!, b, 0); poll();
      }
      flow.dispose();
      reg.dispose();
    }
  });
});
