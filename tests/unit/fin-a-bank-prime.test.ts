/**
 * [FIN-A] item 1 (QF-5 KNOWN_ISSUES "menus drop one frame ... while the crowd-bed loop's crossfade prefix renders"):
 * loopRenderer generated its whole crossfade prefix (bedFade 0.5 s = 24000 samples per channel at 48 kHz) inside the
 * bank's first chunk of each bed loop, about seven chunks of work in one pump step: a 10-25 ms menu frame right after
 * the splash tap. The prefix is now built by SampleRenderer.prime in chunk-sized steps that the bank runs as separate
 * units of work, with the same samples. The bank chunk is 1024 samples (was 4096: cold code made one cost ~11 ms), and a
 * one-shot renderer's source reset is a step of its own too.
 */
import { describe, expect, it } from 'vitest';
import { BANK_TUNING, createBufferBank, JobStatus } from '../../src/audio/bank';
import { renderMurmurBed, renderRoarBed } from '../../src/audio/crowd';
import { loopRenderer, oneShotRenderer, type MonoSource } from '../../src/audio/dsp';
import { asContext, createFakeContext, type FakeBuffer } from './aud-01-fakes';

const SR = 48000;
const BED_SECONDS = 6;
const CHUNK = BANK_TUNING.chunk;

/** A deterministic noise source that counts its samples. */
function counted(seed: number, count: { n: number }): MonoSource {
  let x = seed;
  return {
    reset() { x = seed; },
    next() { count.n++; x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648 - 0.5; },
  };
}

/** Render a renderer in one go into fresh channel arrays (the reference, no bank, no priming). */
function oneGo(r: ReturnType<typeof loopRenderer>, seconds: number, channels: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) out.push(new Float32Array(Math.round(seconds * SR)));
  r(out, 0, out[0]!.length, SR);
  return out;
}

describe('FIN-A: the crowd-bed crossfade prefix renders in chunk-sized steps', () => {
  it('glitch: menu frame drop after the splash tap - no bank pump step does more than one chunk of bed-loop work', () => {
    const count = { n: 0 };
    const bank = createBufferBank(asContext(createFakeContext()));
    const h = bank.define('bed', BED_SECONDS, 2, loopRenderer(0.5, [counted(11, count), counted(29, count)]));
    let steps = 0;
    let worst = 0;
    let done = false;
    while (!done) {
      const before = count.n;
      done = bank.pump(0); // budget 0: exactly one unit of work per pump
      worst = Math.max(worst, count.n - before);
      steps++;
      expect(steps).toBeLessThan(2000);
    }
    expect(bank.status(h)).toBe(JobStatus.DONE);
    // One chunk is CHUNK samples on each of 2 channels; the old first chunk also made the 2 x 24000-sample prefix.
    expect(CHUNK).toBeLessThanOrEqual(1024);
    expect(worst).toBeLessThanOrEqual(2 * CHUNK);
    // Every sample made exactly once: the prefix (2 x 24000) plus the buffer (2 x 6 s).
    expect(count.n).toBe(2 * 24000 + 2 * BED_SECONDS * SR);
  });

  it('the real murmur and roar beds render the same samples through the bank (primed) as in one go', () => {
    for (const make of [renderMurmurBed, renderRoarBed]) {
      const bank = createBufferBank(asContext(createFakeContext()));
      const r = make();
      expect(typeof r.prime).toBe('function');
      const h = bank.define('bed', BED_SECONDS, 2, r);
      let pumps = 0;
      while (!bank.pump(0)) pumps++;
      // The prime steps (the sources' reset, then 24000 / chunk prefix steps) before the chunks of 288000 samples.
      expect(pumps + 1).toBe(1 + Math.ceil(24000 / CHUNK) + Math.ceil(BED_SECONDS * SR / CHUNK));
      const buf = bank.get(h) as unknown as FakeBuffer;
      const ref = oneGo(make(), BED_SECONDS, 2);
      for (let c = 0; c < 2; c++) expect(buf.data[c]!.every((v, i) => v === ref[c]![i]), `channel ${c}`).toBe(true);
    }
  });

  it('priming survives the other entry points: renderNow / flush, a second render from 0, a different length', () => {
    const bank = createBufferBank(asContext(createFakeContext()));
    const h = bank.define('bed', 1, 2, loopRenderer(0.25, [counted(5, { n: 0 }), counted(9, { n: 0 })]));
    expect(bank.renderNow(h)).toBe(true);
    const ref = oneGo(loopRenderer(0.25, [counted(5, { n: 0 }), counted(9, { n: 0 })]), 1, 2);
    const buf = bank.get(h) as unknown as FakeBuffer;
    for (let c = 0; c < 2; c++) expect(buf.data[c]!.every((v, i) => v === ref[c]![i])).toBe(true);

    // A renderer primed for one buffer, then asked for a different length, re-makes its prefix for that buffer.
    const r = loopRenderer(0.25, [counted(5, { n: 0 }), counted(9, { n: 0 })]);
    while (!r.prime!(2, SR, SR, 1000)) { /* prime for a 1 s buffer */ }
    const half = oneGo(r, 0.5, 2);
    const halfRef = oneGo(loopRenderer(0.25, [counted(5, { n: 0 }), counted(9, { n: 0 })]), 0.5, 2);
    for (let c = 0; c < 2; c++) expect(half[c]!.every((v, i) => v === halfRef[c]![i])).toBe(true);
    // And a primed renderer rendered twice from 0 gives the same buffer both times.
    while (!r.prime!(2, SR, SR, 1000)) { /* again */ }
    const a = oneGo(r, 1, 2);
    const b = oneGo(r, 1, 2);
    for (let c = 0; c < 2; c++) expect(a[c]!.every((v, i) => v === b[c]![i] && v === ref[c]![i])).toBe(true);
  });
});

describe('FIN-A: one-shot renderers reset their sources in a bank step of their own', () => {
  it('the first chunk of a one-shot makes only its own samples; the samples equal a one-go render', () => {
    const count = { n: 0, resets: 0 };
    const src = (seed: number): MonoSource => {
      const inner = counted(seed, count);
      return { reset(sr) { count.resets++; inner.reset(sr); }, next: () => inner.next() };
    };
    const bank = createBufferBank(asContext(createFakeContext()));
    const h = bank.define('hit', 0.1, 2, oneShotRenderer([src(3), src(4)]));
    bank.pump(0); // the prime step: resets only
    expect(count.resets).toBe(2);
    expect(count.n).toBe(0);
    bank.pump(0); // first chunk: no second reset
    expect(count.resets).toBe(2);
    expect(count.n).toBe(2 * CHUNK);
    while (!bank.pump(0)) { /* rest */ }
    const buf = bank.get(h) as unknown as FakeBuffer;
    const ref: Float32Array[] = [new Float32Array(0.1 * SR), new Float32Array(0.1 * SR)];
    oneShotRenderer([counted(3, { n: 0 }), counted(4, { n: 0 })])(ref, 0, ref[0]!.length, SR);
    for (let c = 0; c < 2; c++) expect(buf.data[c]!.every((v, i) => v === ref[c]![i])).toBe(true);
  });
});
