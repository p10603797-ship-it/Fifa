/**
 * [AUD-01] Voice allocator and voice pools: a fixed number of one-shot voices per bus, stealing the oldest (lowest
 * priority first), same-group retrigger, fades on steal and stop. Glitch list: "sounds stacking after a pause".
 */
import { describe, expect, it } from 'vitest';
import { createVoicePool, NO_GROUP, VOICE_TUNING, VoiceAllocator } from '../../src/audio/voices';
import { asContext, createFakeContext, FakeBuffer, type FakeGain } from './aud-01-fakes';

describe('AUD-01 VoiceAllocator', () => {
  it('uses free voices first, lowest index first', () => {
    const a = new VoiceAllocator(4);
    expect(a.acquire(0, 1)).toBe(0);
    expect(a.acquire(0, 1)).toBe(1);
    expect(a.acquire(0, 1)).toBe(2);
    expect(a.stolen).toBe(0);
    expect(a.active(0.5)).toBe(3);
  });

  it('when full, steals the oldest voice of equal priority', () => {
    const a = new VoiceAllocator(3);
    a.acquire(0.0, 5);
    a.acquire(0.1, 5);
    a.acquire(0.2, 5);
    const v = a.acquire(0.3, 5);
    expect(v).toBe(0);
    expect(a.stolen).toBe(1);
    expect(a.steals).toBe(1);
    // Next oldest is voice 1.
    expect(a.acquire(0.4, 5)).toBe(1);
    expect(a.active(0.5)).toBe(3);
  });

  it('steals the lowest priority first, and a lower-priority sound never steals a higher one (dropped)', () => {
    const a = new VoiceAllocator(3);
    a.acquire(0.0, 5, 2); // oldest but important
    a.acquire(0.1, 5, 0);
    a.acquire(0.2, 5, 1);
    expect(a.acquire(0.3, 5, 1)).toBe(1); // priority 0 goes first even though voice 0 is older
    // Now priorities are 2, 1, 1: a priority-0 request may steal nothing.
    expect(a.acquire(0.4, 5, 0)).toBe(-1);
    expect(a.drops).toBe(1);
    // A priority-2 request steals the oldest of the lowest (voice 2 started at 0.2, voice 1 at 0.3).
    expect(a.acquire(0.5, 5, 2)).toBe(2);
  });

  it('a same-group sound within the retrigger window replaces the previous one instead of stacking', () => {
    const a = new VoiceAllocator(8);
    const g = 7;
    const v0 = a.acquire(1.0, 0.5, 0, g);
    const v1 = a.acquire(1.0 + VOICE_TUNING.retriggerWindow / 2, 0.5, 0, g);
    expect(v1).toBe(v0);
    expect(a.stolen).toBe(1);
    expect(a.retriggers).toBe(1);
    expect(a.active(1.1)).toBe(1);
    // Outside the window: a second voice.
    const v2 = a.acquire(1.0 + VOICE_TUNING.retriggerWindow * 3, 0.5, 0, g);
    expect(v2).not.toBe(v0);
    expect(a.active(1.2)).toBe(2);
    // NO_GROUP never retriggers.
    const v3 = a.acquire(1.2, 0.5, 0, NO_GROUP);
    const v4 = a.acquire(1.2, 0.5, 0, NO_GROUP);
    expect(v3).not.toBe(v4);
  });

  it('finished voices are free again', () => {
    const a = new VoiceAllocator(2);
    a.acquire(0, 0.1);
    a.acquire(0, 0.2);
    expect(a.active(0.15)).toBe(1);
    expect(a.acquire(0.15, 0.1)).toBe(0);
    expect(a.stolen).toBe(0);
  });

  it('fading voices are stolen first and release frees a voice', () => {
    const a = new VoiceAllocator(2);
    a.acquire(0, 5, 3);
    a.acquire(0.1, 5, 3);
    a.fadeOut(1, 0.2);
    expect(a.acquire(0.15, 1, 0)).toBe(1);
    a.release(0);
    expect(a.acquire(0.16, 1, 0)).toBe(0);
    expect(a.stolen).toBe(0);
  });

  it('survives hostile inputs (zero capacity, NaN times, negative durations)', () => {
    const z = new VoiceAllocator(0);
    expect(z.acquire(0, 1)).toBe(-1);
    const n = new VoiceAllocator(Number.NaN);
    expect(n.capacity).toBe(0);
    const a = new VoiceAllocator(2);
    const v = a.acquire(Number.NaN, Number.NaN, Number.NaN, NO_GROUP, Number.NaN);
    expect(v).toBe(0);
    expect(Number.isFinite(a.end[v]!)).toBe(true);
    // A zero-length sound is over at once: its voice is free again.
    expect(a.acquire(-5, -1)).toBe(0);
    expect(a.acquire(0, 1)).toBe(0);
    expect(a.acquire(0, 1)).toBe(1);
    for (let i = 0; i < 2; i++) {
      expect(Number.isFinite(a.start[i]!)).toBe(true);
      expect(Number.isFinite(a.end[i]!)).toBe(true);
    }
  });
});

function buffer(seconds: number): AudioBuffer {
  return new FakeBuffer(1, Math.round(seconds * 48000), 48000) as unknown as AudioBuffer;
}

function poolHarness(capacity: number, pan = true) {
  const ac = createFakeContext({ pan, state: 'running' });
  const bus = ac.createGain();
  const pool = createVoicePool(asContext(ac), bus as unknown as AudioNode, capacity);
  const voiceGains = ac.created.gains.slice(1) as FakeGain[];
  return { ac, bus, pool, voiceGains };
}

describe('AUD-01 voice pool (Web Audio)', () => {
  it('voice cap: 40 sounds at once never sound more than the cap; stolen sounds are stopped', () => {
    const { ac, pool } = poolHarness(6);
    expect(pool.capacity).toBe(6);
    const b = buffer(0.5);
    for (let i = 0; i < 40; i++) {
      ac.currentTime = 1 + i * 0.001;
      expect(pool.play(b, 1, 0, 1, 0, NO_GROUP)).toBeGreaterThanOrEqual(0);
      expect(pool.active()).toBeLessThanOrEqual(6);
    }
    expect(pool.active()).toBe(6);
    const srcs = ac.created.sources;
    expect(srcs).toHaveLength(40);
    // Every source but the last six was stopped by a steal.
    const stopped = srcs.filter((s) => s.stopCalls > 0).length;
    expect(stopped).toBe(34);
    expect(pool.allocator.steals).toBe(34);
    // After the sounds end every voice is free.
    ac.currentTime = 10;
    expect(pool.active()).toBe(0);
  });

  it('a stolen voice fades out (no click) and the new sound starts after the fade', () => {
    const { ac, pool, voiceGains } = poolHarness(1);
    const b = buffer(1);
    ac.currentTime = 2;
    pool.play(b, 0.8);
    ac.currentTime = 2.3;
    pool.play(b, 0.5);
    const [first, second] = ac.created.sources;
    expect(first!.stoppedAt).toBeCloseTo(2.3 + VOICE_TUNING.stealFade, 9);
    expect(second!.startedAt).toBeCloseTo(2.3 + VOICE_TUNING.stealFade, 9);
    const g = voiceGains[0]!.gain;
    // During the fade the gain moves gradually from 0.8 to 0 (largest per-sample step is tiny).
    expect(g.valueAt(2.3)).toBeCloseTo(0.8, 6);
    expect(g.valueAt(2.3 + VOICE_TUNING.stealFade / 2)).toBeCloseTo(0.4, 2);
    expect(g.maxStep(2.3, 2.3 + VOICE_TUNING.stealFade - 1e-6)).toBeLessThan(0.01);
    // The new sound plays at its own gain.
    expect(g.valueAt(2.3 + VOICE_TUNING.stealFade + 0.01)).toBeCloseTo(0.5, 6);
  });

  it('stopAll fades every voice out and frees them after the fade', () => {
    const { ac, pool, voiceGains } = poolHarness(4);
    const b = buffer(2);
    ac.currentTime = 1;
    for (let i = 0; i < 4; i++) pool.play(b, 1);
    expect(pool.active()).toBe(4);
    pool.stopAll(0.05);
    for (const s of ac.created.sources) expect(s.stoppedAt).toBeCloseTo(1.05, 9);
    for (const g of voiceGains) {
      expect(g.gain.valueAt(1.0)).toBeCloseTo(1, 6);
      expect(g.gain.valueAt(1.05)).toBeCloseTo(0, 6);
      expect(g.gain.maxStep(1, 1.05)).toBeLessThan(0.01);
    }
    ac.currentTime = 1.06;
    expect(pool.active()).toBe(0);
    // Playing again works on the faded voices without stealing.
    expect(pool.play(b, 1)).toBeGreaterThanOrEqual(0);
    expect(pool.allocator.stolen).toBe(0);
  });

  it('steady state creates only the source node of each sound (no gain/panner per play)', () => {
    const { ac, pool } = poolHarness(8);
    const gainsBefore = ac.created.gains.length;
    const pannersBefore = ac.created.panners.length;
    expect(pannersBefore).toBe(8);
    const b = buffer(0.1);
    for (let i = 0; i < 100; i++) {
      ac.currentTime = i * 0.02;
      pool.play(b, 1, (i % 3) - 1, 1 + (i % 2) * 0.1);
    }
    expect(ac.created.gains.length).toBe(gainsBefore);
    expect(ac.created.panners.length).toBe(pannersBefore);
    expect(ac.created.sources.length).toBe(100);
    // Each source disconnects itself when it ends (handler shared, not a closure per sound).
    const h = ac.created.sources[0]!.onended;
    expect(typeof h).toBe('function');
    expect(ac.created.sources[99]!.onended).toBe(h);
    h!.call(ac.created.sources[0]);
    expect(ac.created.sources[0]!.disconnected).toBe(1);
  });

  it('pans, pitches and delays; hostile parameters are sanitised', () => {
    const { ac, pool } = poolHarness(4);
    ac.currentTime = 3;
    const v = pool.play(buffer(1), Number.NaN, 7, Number.POSITIVE_INFINITY, 0, NO_GROUP, 0.25);
    expect(v).toBe(0);
    const src = ac.created.sources[0]!;
    expect(src.startedAt).toBeCloseTo(3.25, 9);
    expect(src.playbackRate.value).toBe(1); // non-finite rate -> 1
    const panner = ac.created.panners[0]!;
    expect(panner.pan.valueAt(3.3)).toBe(1); // clamped
    // Gain NaN -> 1.
    const gain = ac.created.gains[1]!;
    expect(gain.gain.valueAt(3.3)).toBe(1);
    // Rate 2 halves the voice time.
    ac.currentTime = 5;
    const v2 = pool.play(buffer(1), 1, 0, 2);
    expect(pool.allocator.end[v2]! - pool.allocator.start[v2]!).toBeCloseTo(0.5, 9);
  });

  it('works without StereoPannerNode; null buffers, closed contexts and disposed pools play nothing', () => {
    const { ac, pool, bus } = poolHarness(2, false);
    expect(ac.created.panners).toHaveLength(0);
    // Voices connect straight to the bus.
    expect(ac.created.gains[1]!.outputs[0]).toBe(bus);
    expect(pool.play(null)).toBe(-1);
    ac.state = 'closed';
    expect(pool.play(buffer(0.1))).toBe(-1);
    ac.state = 'running';
    expect(pool.play(buffer(0.1))).toBe(0);
    pool.stopAll();
    pool.dispose();
    expect(pool.play(buffer(0.1))).toBe(-1);
    expect(pool.active()).toBe(0);
  });

  it('glitch: sounds stacking after a pause — nothing is queued while the context is suspended or interrupted', () => {
    const { ac, pool } = poolHarness(8);
    const b = buffer(0.3);
    ac.currentTime = 4;
    for (const state of ['suspended', 'interrupted']) {
      ac.state = state;
      for (let i = 0; i < 20; i++) expect(pool.play(b, 1)).toBe(-1);
    }
    expect(ac.created.sources).toHaveLength(0);
    ac.state = 'running';
    expect(pool.active()).toBe(0);
    expect(pool.play(b, 1)).toBe(0);
    expect(pool.active()).toBe(1);
  });

  it('a same-group retrigger restarts the sound on the same voice (identical events a tick apart do not double up)', () => {
    const { ac, pool } = poolHarness(8);
    const b = buffer(0.4);
    ac.currentTime = 1;
    const v0 = pool.play(b, 1, 0, 1, 0, 3);
    ac.currentTime = 1 + 1 / 60 / 2;
    const v1 = pool.play(b, 1, 0, 1, 0, 3);
    expect(v1).toBe(v0);
    expect(pool.active()).toBe(1);
    expect(ac.created.sources[0]!.stopCalls).toBe(1);
  });
});
