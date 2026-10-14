/**
 * [QF-5] Second QA pass, audio lifecycle (QA-41): randomized hide / show / pause / interruption sequences on a
 * WebKit-like fake context whose suspend() and resume() settle later, in call order. Real engine + real modules.
 * Invariants: while the page is hidden nothing is heard; once the page is visible and the OS lets go, sound comes back
 * without any gesture (controller-only players), and the output is up.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createAudioEngine } from '../../src/audio/engine';
import { initMatch } from '../../src/sim/init';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { asContext, bootRealEngine, createFakeContext, createFakeWindow, flush, type FakeContext } from './aud-01-fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** xorshift32 for reproducible sequences. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/**
 * Make suspend() / resume() asynchronous like WebKit: each call queues a task; settle(n) runs up to n tasks in call
 * order. While the OS holds an interruption, resume tasks wait (they settle once it ends).
 */
function webkitLike(ac: FakeContext) {
  const tasks: { kind: 'suspend' | 'resume'; done: () => void }[] = [];
  let interrupted = false;
  /** iOS zombie: 'running' with a clock that does not move, until the context is suspended once (a restart). */
  let frozen = false;
  ac.advance = (dt: number) => {
    if (ac.state === 'running' && !frozen) ac.currentTime += dt;
  };
  ac.suspend = vi.fn(() => new Promise<void>((resolve) => { tasks.push({ kind: 'suspend', done: resolve }); }));
  ac.resume = vi.fn(() => new Promise<void>((resolve) => { tasks.push({ kind: 'resume', done: resolve }); }));
  const settle = (n = Infinity): void => {
    let k = 0;
    while (tasks.length > 0 && k < n) {
      const t = tasks[0]!;
      if (t.kind === 'resume' && interrupted) break;
      tasks.shift();
      k++;
      if (t.kind === 'suspend') frozen = false;
      if (ac.state !== 'closed') ac.setState(t.kind === 'resume' ? 'running' : 'suspended');
      t.done();
    }
  };
  return {
    settle,
    pending: () => tasks.length,
    interrupt(): void {
      interrupted = true;
      ac.setState('interrupted');
    },
    freeze(): void {
      frozen = true;
    },
    get frozen() { return frozen; },
    endInterruption(to: 'suspended' | 'running'): void {
      interrupted = false;
      ac.setState(to);
    },
    get interrupted() { return interrupted; },
  };
}

function matchState() {
  const config = createMatchConfig();
  config.seed = 5;
  return initMatch(config, CLUBS);
}

describe('QF-5 verify: audio lifecycle fuzz on a WebKit-like context', () => {
  it('glitch: silent after returning from the background - 300 random hide / show / pause / interruption / frozen-clock sequences always come back without a tap', { timeout: 120_000 }, async () => {
    const failures: string[] = [];
    // One engine for every sequence (pre-rendering the bank takes ~0.5 s): each sequence starts where the last ended.
    const { ac, engine, win, errors } = await bootRealEngine({ createEngine: createAudioEngine });
    const wk = webkitLike(ac);
    const s = matchState();
    engine.matchStart(s);
    for (let seed = 1; seed <= 300 && failures.length === 0; seed++) {
      const r = rng(seed * 2654435761);
      let hidden = false;
      let paused = false;
      const log: string[] = [];
      const frame = (): void => {
        ac.advance(1 / 60);
        if (!hidden) engine.update(s, 1 / 60); // the loop stops while hidden
      };
      for (let step = 0; step < 40; step++) {
        const p = r();
        if (p < 0.22) {
          hidden = !hidden;
          log.push(hidden ? 'hide' : 'show');
          if (hidden) engine.suspend();
          else engine.resume();
        } else if (p < 0.32) {
          paused = !paused;
          log.push(paused ? 'pause' : 'unpause');
          engine.setPaused(paused);
        } else if (p < 0.38 && !wk.interrupted) {
          log.push('interrupt');
          wk.interrupt();
        } else if (p < 0.46 && wk.interrupted) {
          const to = r() < 0.5 ? 'suspended' : 'running';
          log.push(`end-interruption:${to}`);
          wk.endInterruption(to);
        } else if (p < 0.70) {
          const n = 1 + Math.floor(r() * 3);
          log.push(`settle${n}`);
          wk.settle(n);
        } else if (p < 0.72) {
          log.push('freeze');
          wk.freeze();
        } else if (p < 0.75) {
          // The OS resumes the context on its own (e.g. after a route change) - also while hidden.
          log.push('os-run');
          if (!wk.interrupted) ac.setState('running');
        } else {
          const n = 1 + Math.floor(r() * 30);
          log.push(`frames${n}`);
          for (let i = 0; i < n; i++) frame();
        }
        await flush();
      }
      // Hidden: settle everything; nothing may be heard in the background.
      if (hidden) {
        wk.settle();
        await flush();
        for (let i = 0; i < 30; i++) frame();
        await flush();
        wk.settle();
        await flush();
        const heard = ac.state === 'running' && engine.info().outputUp;
        if (heard) failures.push(`seed ${seed}: heard while hidden after ${log.join(' ')} (${JSON.stringify(engine.info().state)})`);
        engine.resume();
        hidden = false;
        log.push('show');
      }
      // Visible, the OS lets go, no gesture ever: within 5 s of frames the sound is back.
      if (wk.interrupted) wk.endInterruption('suspended');
      for (let i = 0; i < 300; i++) {
        frame();
        if (i % 7 === 0) wk.settle();
        await flush();
      }
      wk.settle();
      await flush();
      frame();
      const info = engine.info();
      const t0 = ac.currentTime;
      frame();
      const clockMoves = ac.currentTime > t0;
      if (!(ac.state === 'running' && info.outputUp && info.wanted && clockMoves)) {
        failures.push(`seed ${seed}: silent after ${log.join(' ')} -> state ${ac.state}, outputUp ${info.outputUp}, clock moves ${clockMoves}, armed ${win.armed()}`);
      }
      if (paused) engine.setPaused(false);
      if (errors.length > 0) failures.push(`seed ${seed}: module errors ${errors.join('; ')}`);
    }
    engine.dispose();
    expect(failures).toEqual([]);
  });
});

describe('QF-5 verify: every pre-rendered sound at the sample rates an iPad can run', () => {
  it('glitch: crowd loop clicking - at 8 to 96 kHz (Bluetooth headsets, interfaces) no buffer has NaN or clips and the bed loops wrap seamlessly', { timeout: 120_000 }, async () => {
    const bad: string[] = [];
    for (const rate of [8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]) {
      vi.stubGlobal('window', createFakeWindow());
      const ac = createFakeContext();
      ac.sampleRate = rate;
      const errors: string[] = [];
      const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), {
        createContext: () => asContext(ac), now: () => 0, onModuleError: (e, w) => errors.push(`${w}: ${String(e)}`),
      });
      await engine.unlock();
      await flush();
      const bank = engine.services!.bank;
      bank.flush();
      if (bank.failed > 0 || errors.length > 0) bad.push(`@${rate}: ${bank.failed} failed, ${errors.join('; ')}`);
      for (const b of ac.created.buffers) {
        const bb = b as unknown as { getChannelData(c: number): Float32Array; numberOfChannels: number; length: number; sampleRate: number };
        if (bb.sampleRate !== rate && bb.length > 1) bad.push(`@${rate}: a buffer at ${bb.sampleRate} Hz`);
        for (let c = 0; c < bb.numberOfChannels; c++) {
          const ch = bb.getChannelData(c);
          let peak = 0;
          let nan = 0;
          for (let i = 0; i < ch.length; i++) {
            const v = ch[i]!;
            if (!Number.isFinite(v)) nan++;
            else if (Math.abs(v) > peak) peak = Math.abs(v);
          }
          if (nan > 0 || peak > 1.0001) bad.push(`@${rate}: buffer of ${bb.length} ch${c}: ${nan} NaN, peak ${peak}`);
        }
      }
      for (const id of ['crowd.bed.murmur', 'crowd.bed.roar']) {
        const buf = bank.get(bank.handle(id)) as unknown as { getChannelData(c: number): Float32Array; numberOfChannels: number };
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const ch = buf.getChannelData(c);
          let sum = 0;
          for (let i = 1; i < ch.length; i++) {
            const d = ch[i]! - ch[i - 1]!;
            sum += d * d;
          }
          const typical = Math.sqrt(sum / (ch.length - 1));
          const wrap = Math.abs(ch[ch.length - 1]! - ch[0]!);
          if (wrap > 4 * typical) bad.push(`@${rate}: ${id} seam ${wrap} vs typical step ${typical}`);
        }
      }
      engine.dispose();
      vi.unstubAllGlobals();
    }
    expect(bad).toEqual([]);
  });
});
