/**
 * INT-B audio wiring: AudioEngineImpl.setCameraX forwards the renderer's broadcast camera x to the sfx module (AUD-03
 * stereo panning), keeps a value set before unlock for the module created at unlock, skips repeats (per-frame call),
 * and treats non-finite values as "estimate from the ball" (NaN).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SfxModule } from '../../src/audio/sfx';

const made: { sfx: SfxModule | null; calls: number[] } = { sfx: null, calls: [] };

vi.mock('../../src/audio/sfx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/sfx')>();
  return {
    ...actual,
    createSfx: (c: Parameters<typeof actual.createSfx>[0]) => {
      const m = actual.createSfx(c);
      const inner = m.setCameraX.bind(m);
      m.setCameraX = (x: number) => {
        made.calls.push(x);
        inner(x);
      };
      made.sfx = m;
      return m;
    },
  };
});

const { createAudioEngine } = await import('../../src/audio/engine');
const { asContext, createFakeContext, createFakeWindow } = await import('./aud-01-fakes');
const { createSettingsStore } = await import('../../src/platform/settingsStore');
const { createMemoryStorage } = await import('../../src/platform/storage');

afterEach(() => {
  vi.unstubAllGlobals();
  made.sfx = null;
  made.calls.length = 0;
});

describe('INT-B AudioEngineImpl.setCameraX (renderer camera x -> sfx panning)', () => {
  it('keeps a camera x set before unlock and hands it to the sfx module created at unlock', async () => {
    vi.stubGlobal('window', createFakeWindow());
    const ac = createFakeContext();
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => asContext(ac), now: () => 0 });
    engine.setCameraX(12); // no context yet: nothing to forward, never throws
    expect(made.sfx).toBeNull();
    await engine.unlock();
    expect(made.sfx).not.toBeNull();
    expect(made.calls).toEqual([12]);
    engine.dispose();
  });

  it('forwards changes only (a per-frame call with the same x does nothing) and maps non-finite to NaN', async () => {
    vi.stubGlobal('window', createFakeWindow());
    const ac = createFakeContext();
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => asContext(ac), now: () => 0 });
    await engine.unlock();
    made.calls.length = 0;
    engine.setCameraX(-20);
    engine.setCameraX(-20);
    engine.setCameraX(5.5);
    expect(made.calls).toEqual([-20, 5.5]);
    engine.setCameraX(Number.POSITIVE_INFINITY);
    engine.setCameraX(Number.NaN);
    expect(made.calls).toHaveLength(3);
    expect(Number.isNaN(made.calls[2]!)).toBe(true);
    engine.dispose();
    engine.setCameraX(3); // after dispose: no module, no throw
    expect(made.calls).toHaveLength(3);
  });

  it('a throwing sfx module is reported as a module failure, never thrown at the app loop', async () => {
    vi.stubGlobal('window', createFakeWindow());
    const ac = createFakeContext();
    const errors: string[] = [];
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), {
      createContext: () => asContext(ac), now: () => 0, onModuleError: (e, where) => errors.push(`${where}: ${String(e)}`),
    });
    await engine.unlock();
    made.sfx!.setCameraX = () => { throw new Error('pan broke'); };
    expect(() => engine.setCameraX(1)).not.toThrow();
    expect(errors.some((e) => e.includes('setCameraX'))).toBe(true);
    engine.dispose();
  });
});
