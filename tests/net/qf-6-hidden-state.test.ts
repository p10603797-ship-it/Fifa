/**
 * [QF-6] Desync hunt: hidden state outside SimState. A guest that reloads mid-match (or hard-syncs to a snapshot) runs
 * the same ticks as the host but with fresh (or diverged) module-level caches in src/sim and src/ai. If any module keeps
 * state across ticks that changes the result, the rejoined guest drifts and the match ends in repeated resyncs.
 *
 * The test runs a host sim on one module instance and a "reloaded page" sim on a FRESH module instance
 * (vi.resetModules + dynamic import), hard-synced to the host's snapshot, then feeds both identical frames and compares
 * hashState every tick. A second case resyncs the guest in place after it has diverged (stale caches, same instance).
 */
import { describe, expect, it, vi } from 'vitest';
import { Command } from '../../src/contracts/enums';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { netsimConfig } from '../../tools/netsim';

type SimMods = {
  initMatch: typeof import('../../src/sim/init').initMatch;
  step: typeof import('../../src/sim/step').step;
  createEventBuffer: typeof import('../../src/sim/core/events').createEventBuffer;
  hashState: typeof import('../../src/sim/core/hash').hashState;
  serializeState: typeof import('../../src/sim/core/serialize').serializeState;
  deserializeState: typeof import('../../src/sim/core/serialize').deserializeState;
  copyState: typeof import('../../src/sim/core/clone').copyState;
  createInputFrame: typeof import('../../src/contracts/input').createInputFrame;
};

async function loadSim(): Promise<SimMods> {
  const [init, stepM, ev, hash, ser, clone, input] = await Promise.all([
    import('../../src/sim/init'), import('../../src/sim/step'), import('../../src/sim/core/events'), import('../../src/sim/core/hash'),
    import('../../src/sim/core/serialize'), import('../../src/sim/core/clone'), import('../../src/contracts/input'),
  ]);
  return {
    initMatch: init.initMatch, step: stepM.step, createEventBuffer: ev.createEventBuffer, hashState: hash.hashState,
    serializeState: ser.serializeState, deserializeState: ser.deserializeState, copyState: clone.copyState,
    createInputFrame: input.createInputFrame,
  };
}

/** Frames that depend on the tick only (identical for every sim): wandering sticks, sprint, taps, cut-scene skips. */
function framesFor(t: number, out: InputFrame[], seed: number): void {
  for (let h = 0; h < 2; h++) {
    const f = out[h]!;
    let x = (Math.imul(t >> 5, 0x9e3779b1) ^ Math.imul(h + 1 + seed, 0x85ebca6b)) >>> 0;
    x ^= x >>> 13;
    x = Math.imul(x, 0xc2b2ae35) >>> 0;
    f.mx = (x & 0xff) - 128;
    f.mz = ((x >>> 8) & 0xff) - 128;
    f.ax = 0;
    f.az = 0;
    f.buttons = ((x >>> 16) & 1 ? Btn.SPRINT : 0) | (t % 2 === 0 ? Btn.SKIP : 0);
    const r = (x >>> 20) & 31;
    if (r === 3 && t % 40 < 6) f.buttons |= Btn.PASS;
    if (r === 7 && t % 50 < 8) f.buttons |= Btn.SHOOT;
    if (r === 11 && t % 60 < 4) f.buttons |= Btn.THROUGH;
    f.cmd = t % 2 === 0 ? Command.SKIP : Command.NONE;
    f.cmdArg = 0;
  }
}

describe('QF-6 desync: no hidden sim state outside SimState', () => {
  it('glitch: desync — a reloaded guest (fresh module state) hard-synced to the host snapshot stays bit-identical', async () => {
    for (const [seed, snapAt] of [[11, 1500], [23, 2700]] as const) {
      const A = await loadSim();
      vi.resetModules();
      const B = await loadSim();
      expect(B.step).not.toBe(A.step); // really a second module instance
      const cfg = netsimConfig({ seed, halfMinutes: 2 });
      const host = A.initMatch(cfg);
      const evA = A.createEventBuffer();
      const evB = B.createEventBuffer();
      const fa = [A.createInputFrame(), A.createInputFrame()];
      const fb = [B.createInputFrame(), B.createInputFrame()];
      for (let t = 1; t <= snapAt; t++) {
        framesFor(t, fa, seed);
        A.step(host, fa, evA);
      }
      const guest: SimState = B.deserializeState(A.serializeState(host));
      expect(B.hashState(guest)).toBe(A.hashState(host));
      let firstBad = -1;
      for (let t = snapAt + 1; t <= snapAt + 1800 && firstBad < 0; t++) {
        framesFor(t, fa, seed);
        framesFor(t, fb, seed);
        A.step(host, fa, evA);
        B.step(guest, fb, evB);
        if (A.hashState(host) !== B.hashState(guest)) firstBad = t;
      }
      expect(firstBad, `seed ${seed}: diverged at tick ${firstBad}`).toBe(-1);
    }
  }, 120_000);

  it('glitch: desync — a guest resynced in place after diverging (stale caches) matches the host from then on', async () => {
    const M = await loadSim();
    for (const seed of [5, 17, 29]) {
      const cfg = netsimConfig({ seed, halfMinutes: 2 });
      const host = M.initMatch(cfg);
      const guest = M.initMatch(cfg);
      const ev = M.createEventBuffer();
      const f = [M.createInputFrame(), M.createInputFrame()];
      const g = [M.createInputFrame(), M.createInputFrame()];
      const T = 900 + seed * 20;
      for (let t = 1; t <= T + 6; t++) {
        framesFor(t, f, seed);
        framesFor(t, g, seed);
        M.step(host, f, ev);
        if (t === T - 240) guest.players[6]!.x += 1.5; // the guest drifts (diverged caches from here on)
        M.step(guest, g, ev);
      }
      // Host snapshot of tick T, applied by the guest after it ran 6 ticks ahead (in place, like applyPending).
      const snapHost = M.initMatch(cfg);
      const ev2 = M.createEventBuffer();
      for (let t = 1; t <= T; t++) {
        framesFor(t, f, seed);
        M.step(snapHost, f, ev2);
      }
      M.copyState(guest, M.deserializeState(M.serializeState(snapHost)));
      expect(guest.tick).toBe(T);
      for (let t = T + 1; t <= T + 1200; t++) {
        framesFor(t, g, seed);
        M.step(guest, g, ev);
        framesFor(t, f, seed);
        if (t > T + 6) M.step(host, f, ev); // the host is at T + 6 already
        if (t >= T + 6 && host.tick === guest.tick) {
          expect(M.hashState(guest), `seed ${seed} tick ${t}`).toBe(M.hashState(host));
        }
      }
    }
  }, 120_000);
});
