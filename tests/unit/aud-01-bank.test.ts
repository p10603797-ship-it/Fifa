/**
 * [AUD-01] Buffer bank: pre-rendering of generated buffers after unlock, in chunks within a per-frame budget (no
 * hitch), identical to a one-shot render, sanitised, with failures isolated; offline (graph) renders one at a time.
 */
import { describe, expect, it, vi } from 'vitest';
import { BANK_TUNING, createBufferBank, JobStatus, sanitizeRange, type SampleRenderer } from '../../src/audio/bank';
import { asContext, createFakeContext, FakeBuffer, flush } from './aud-01-fakes';

/** A deterministic renderer that depends only on the sample index (chunk-boundary safe). */
const tone: SampleRenderer = (out, from, to, sr) => {
  for (let c = 0; c < out.length; c++) {
    const ch = out[c]!;
    for (let i = from; i < to; i++) ch[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / sr + c);
  }
};

describe('AUD-01 buffer bank', () => {
  it('chunked rendering gives exactly the same samples as rendering in one go', () => {
    const ac = createFakeContext();
    const bank = createBufferBank(asContext(ac), { chunk: 1000 });
    const h = bank.define('tone', 0.5, 2, tone);
    expect(bank.get(h)).toBeNull();
    let pumps = 0;
    while (!bank.pump(0)) pumps++; // budget 0: exactly one chunk per pump
    expect(pumps).toBe(Math.ceil(24000 / 1000) - 1);
    const buf = bank.get(h) as unknown as FakeBuffer;
    expect(buf).not.toBeNull();
    expect(buf.length).toBe(24000);
    const ref = [new Float32Array(24000), new Float32Array(24000)];
    tone(ref, 0, 24000, 48000);
    expect(Array.from(buf.data[0]!)).toEqual(Array.from(ref[0]!));
    expect(Array.from(buf.data[1]!)).toEqual(Array.from(ref[1]!));
  });

  it('pump stays within its time budget and always makes progress (no frame hitch)', () => {
    const ac = createFakeContext();
    let t = 0;
    const render = vi.fn<SampleRenderer>((out, from, to) => {
      t += 0.5; // each chunk costs 0.5 ms
      out[0]!.fill(0.1, from, to);
    });
    const bank = createBufferBank(asContext(ac), { now: () => t, chunk: 4800 });
    bank.define('long', 2, 1, render); // 96000 samples -> 20 chunks
    const start = t;
    bank.pump(2);
    // 2 ms budget at 0.5 ms per chunk: at most 2/0.5 + 1 chunks (the check runs before each further chunk).
    expect(render.mock.calls.length).toBeLessThanOrEqual(5);
    expect(t - start).toBeLessThanOrEqual(2.5);
    // A tiny budget still renders one chunk per frame.
    const before = render.mock.calls.length;
    bank.pump(0.0001);
    expect(render.mock.calls.length).toBe(before + 1);
    let frames = 0;
    while (!bank.pump(2)) frames++;
    expect(render.mock.calls.length).toBe(20);
    expect(frames).toBeLessThan(10);
    expect(bank.pending).toBe(0);
  });

  it('renders in definition order; the same id returns the same handle; unknown handles are null', () => {
    const ac = createFakeContext();
    const bank = createBufferBank(asContext(ac), { chunk: 100000 });
    const a = bank.define('a', 0.1, 1, tone);
    const b = bank.define('b', 0.1, 1, tone);
    expect(bank.define('a', 5, 2, tone)).toBe(a);
    expect(bank.handle('b')).toBe(b);
    expect(bank.handle('zzz')).toBe(-1);
    expect(bank.pending).toBe(2);
    bank.pump(0);
    expect(bank.status(a)).toBe(JobStatus.DONE);
    expect(bank.status(b)).toBe(JobStatus.PENDING);
    bank.pump(0);
    expect(bank.status(b)).toBe(JobStatus.DONE);
    expect(bank.get(99)).toBeNull();
    expect(bank.get(-1)).toBeNull();
    expect(bank.status(99)).toBe(-1);
  });

  it('non-finite and out-of-range samples are sanitised (a NaN must never reach the graph)', () => {
    const ac = createFakeContext();
    const bank = createBufferBank(asContext(ac));
    const h = bank.define('bad', 0.001, 1, (out, from, to) => {
      for (let i = from; i < to; i++) out[0]![i] = [Number.NaN, Number.POSITIVE_INFINITY, -7, 3, 0.25][i % 5]!;
    });
    bank.flush();
    const d = (bank.get(h) as unknown as FakeBuffer).data[0]!;
    expect(Array.from(d.slice(0, 5))).toEqual([0, 0, -1, 1, 0.25]);
    const raw = new Float32Array([Number.NEGATIVE_INFINITY, 2, -0.5]);
    sanitizeRange(raw, 0, 3);
    expect(Array.from(raw)).toEqual([0, 1, -0.5]);
  });

  it('a renderer that throws fails only its own buffer and is reported', () => {
    const ac = createFakeContext();
    const errors: string[] = [];
    const bank = createBufferBank(asContext(ac), { onError: (_e, id) => errors.push(id) });
    const bad = bank.define('bad', 0.1, 1, () => {
      throw new Error('synth bug');
    });
    const good = bank.define('good', 0.1, 1, tone);
    bank.flush();
    expect(bank.get(bad)).toBeNull();
    expect(bank.status(bad)).toBe(JobStatus.FAILED);
    expect(bank.get(good)).not.toBeNull();
    expect(bank.failed).toBe(1);
    expect(bank.pending).toBe(0);
    expect(errors).toEqual(['bad']);
  });

  it('a context whose buffers cannot be created fails the jobs without throwing', () => {
    const ac = createFakeContext();
    ac.createBuffer = vi.fn(() => ({}) as FakeBuffer);
    const bank = createBufferBank(asContext(ac));
    const h = bank.define('x', 0.1, 1, tone);
    expect(() => bank.flush()).not.toThrow();
    expect(bank.status(h)).toBe(JobStatus.FAILED);
  });

  it('lengths are clamped (memory guard) and a missing sample rate falls back', () => {
    const ac = createFakeContext();
    (ac as { sampleRate: number }).sampleRate = Number.NaN;
    const bank = createBufferBank(asContext(ac), { chunk: 1e9 });
    expect(bank.sampleRate).toBe(BANK_TUNING.fallbackRate);
    const h = bank.define('huge', 1e6, 9, (out, from, to) => out[0]!.fill(0, from, to));
    const z = bank.define('zero', -1, 1, (out, from, to) => out[0]!.fill(0, from, to));
    bank.flush();
    const buf = bank.get(h) as unknown as FakeBuffer;
    expect(buf.length).toBe(BANK_TUNING.maxSeconds * BANK_TUNING.fallbackRate);
    expect(buf.numberOfChannels).toBe(2);
    expect((bank.get(z) as unknown as FakeBuffer).length).toBe(1);
  });

  it('offline graph renders run one at a time and deliver their buffer (promise and oncomplete styles)', async () => {
    const ac = createFakeContext();
    const resolvers: ((b: AudioBuffer) => void)[] = [];
    const made: { oncomplete: ((e: { renderedBuffer: AudioBuffer }) => void) | null; legacy: boolean }[] = [];
    const createOffline = vi.fn((ch: number, len: number, sr: number) => {
      const legacy = made.length === 1;
      const oc = {
        legacy,
        oncomplete: null as ((e: { renderedBuffer: AudioBuffer }) => void) | null,
        length: len,
        startRendering: () => {
          if (legacy) return undefined;
          return new Promise<AudioBuffer>((res) => resolvers.push(res));
        },
        sr,
        ch,
      };
      made.push(oc);
      return oc as unknown as OfflineAudioContext;
    });
    const bank = createBufferBank(asContext(ac), { createOffline });
    const build = vi.fn();
    const g1 = bank.defineGraph('g1', 0.2, 1, build);
    const g2 = bank.defineGraph('g2', 0.2, 2, build);
    const js = bank.define('js', 0.01, 1, tone);
    bank.pump(5);
    // One offline render at a time; JS jobs are not blocked by it.
    expect(createOffline).toHaveBeenCalledTimes(1);
    expect(createOffline).toHaveBeenCalledWith(1, 9600, 48000);
    expect(bank.status(g1)).toBe(JobStatus.RENDERING);
    expect(bank.get(js)).not.toBeNull();
    bank.pump(5);
    expect(createOffline).toHaveBeenCalledTimes(1);
    resolvers[0]!(new FakeBuffer(1, 9600, 48000) as unknown as AudioBuffer);
    await flush();
    expect(bank.get(g1)).not.toBeNull();
    bank.pump(5);
    expect(createOffline).toHaveBeenCalledTimes(2);
    // Legacy WebKit: startRendering returns nothing and fires oncomplete.
    made[1]!.oncomplete!({ renderedBuffer: new FakeBuffer(2, 9600, 48000) as unknown as AudioBuffer });
    expect(bank.get(g2)).not.toBeNull();
    expect(bank.pending).toBe(0);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('without OfflineAudioContext a graph job fails cleanly; a throwing build fails only itself', () => {
    const ac = createFakeContext();
    const errors: string[] = [];
    const none = createBufferBank(asContext(ac), { createOffline: () => null, onError: (_e, id) => errors.push(id) });
    const h = none.defineGraph('g', 0.1, 1, () => undefined);
    none.pump(1);
    expect(none.status(h)).toBe(JobStatus.FAILED);
    const thrower = createBufferBank(asContext(ac), {
      createOffline: () => ({ startRendering: () => new Promise(() => undefined) }) as unknown as OfflineAudioContext,
      onError: (_e, id) => errors.push(id),
    });
    const t = thrower.defineGraph('t', 0.1, 1, () => {
      throw new Error('graph bug');
    });
    const ok = thrower.define('ok', 0.01, 1, tone);
    thrower.pump(1);
    expect(thrower.status(t)).toBe(JobStatus.FAILED);
    expect(thrower.get(ok)).not.toBeNull();
    expect(errors).toEqual(['g', 't']);
  });

  it('dispose drops everything; later calls are inert', () => {
    const ac = createFakeContext();
    const bank = createBufferBank(asContext(ac));
    const h = bank.define('a', 0.1, 1, tone);
    bank.flush();
    bank.dispose();
    expect(bank.get(h)).toBeNull();
    expect(bank.pending).toBe(0);
    expect(bank.pump(1)).toBe(true);
    expect(bank.define('b', 0.1, 1, tone)).toBe(-1);
  });
});
