/**
 * [AUD-02..05] Small synthesis toolkit for the sound modules' pre-rendered buffers (bank.ts renderers).
 *
 * Everything here runs at render time (once, after unlock, in chunks), never per sim event. Renderers built from
 * these parts are stateful but only ever called with consecutive sample ranges starting at 0 (the bank's contract),
 * and they reset themselves whenever a render starts again at sample 0, so a buffer renders identically whatever
 * the chunk size. Noise is a seeded xorshift32 (repeatable renders, testable output).
 */
import type { SampleRenderer } from './bank';

export const TAU = Math.PI * 2;

/** Seeded white noise in -1..1 (xorshift32). */
export class Noise {
  private s = 1;
  constructor(private readonly seed: number) {
    this.reset();
  }
  reset(): void {
    const s = this.seed >>> 0;
    this.s = s === 0 ? 0x9e3779b9 : s;
  }
  /** Uniform -1..1. */
  white(): number {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 2147483648 - 1;
  }
  /** Uniform 0..1. */
  unit(): number {
    return (this.white() + 1) * 0.5;
  }
}

export const enum FilterKind {
  LOWPASS = 0,
  HIGHPASS = 1,
  /** Constant 0 dB peak gain band-pass. */
  BANDPASS = 2,
}

/** RBJ biquad (direct form I, double precision state). */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  constructor(public kind: FilterKind, public freq: number, public q: number) {}

  /** Recompute coefficients for `sr` (frequency clamped to a safe 10 Hz .. 0.45 sr). */
  set(sr: number, freq: number = this.freq, q: number = this.q): void {
    this.freq = freq;
    this.q = q;
    const f = Math.min(Math.max(10, freq), 0.45 * sr);
    const w0 = (TAU * f) / sr;
    const cw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.max(0.05, q));
    const a0 = 1 + alpha;
    let b0: number;
    let b1: number;
    let b2: number;
    if (this.kind === FilterKind.LOWPASS) {
      b0 = (1 - cw) / 2;
      b1 = 1 - cw;
      b2 = b0;
    } else if (this.kind === FilterKind.HIGHPASS) {
      b0 = (1 + cw) / 2;
      b1 = -(1 + cw);
      b2 = b0;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  clear(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Seeded noise through one biquad, scaled to unit RMS (measured over a calibration run at reset). */
export class NoiseBand {
  private readonly noise: Noise;
  private readonly filter: Biquad;
  private scale = 1;
  private sr = 48000;
  constructor(seed: number, kind: FilterKind, private readonly freq0: number, private readonly q0: number) {
    this.noise = new Noise(seed);
    this.filter = new Biquad(kind, freq0, q0);
  }
  /** Re-seed, reset the filter to its initial frequency and calibrate. Deterministic. */
  reset(sr: number): void {
    this.sr = sr;
    this.filter.set(sr, this.freq0, this.q0);
    this.noise.reset();
    this.filter.clear();
    let sum = 0;
    const n = 4096;
    for (let i = 0; i < n; i++) {
      const y = this.filter.process(this.noise.white());
      sum += y * y;
    }
    const rms = Math.sqrt(sum / n);
    this.scale = rms > 1e-9 ? 1 / rms : 0;
    this.noise.reset();
    this.filter.clear();
  }
  /** Move the filter (time-varying formants); the calibration scale is kept. */
  setFreq(freq: number): void {
    this.filter.set(this.sr, freq, this.filter.q);
  }
  next(): number {
    return this.filter.process(this.noise.white()) * this.scale;
  }
}

/** Sine oscillator with a phase accumulator (frequency may change every sample without clicks). */
export class Osc {
  private phase = 0;
  constructor(private readonly phase0 = 0) {
    this.phase = phase0;
  }
  reset(): void {
    this.phase = this.phase0;
  }
  next(freq: number, sr: number): number {
    const v = Math.sin(this.phase);
    this.phase += (TAU * freq) / sr;
    if (this.phase > TAU) this.phase -= TAU;
    return v;
  }
}

/** Random slowly varying level in lo..hi: a new target every `minSec..maxSec`, approached with time constant tc. */
export class Wander {
  private readonly noise: Noise;
  private value = 0;
  private target = 0;
  private left = 0;
  private coef = 0;
  private sr = 48000;
  constructor(seed: number, private readonly lo: number, private readonly hi: number, private readonly minSec: number, private readonly maxSec: number, private readonly tc: number) {
    this.noise = new Noise(seed);
  }
  reset(sr: number): void {
    this.sr = sr;
    this.noise.reset();
    this.coef = 1 - Math.exp(-1 / (Math.max(1e-4, this.tc) * sr));
    this.value = this.lo + (this.hi - this.lo) * this.noise.unit();
    this.target = this.value;
    this.left = 0;
  }
  next(): number {
    if (this.left <= 0) {
      this.target = this.lo + (this.hi - this.lo) * this.noise.unit();
      this.left = Math.round((this.minSec + (this.maxSec - this.minSec) * this.noise.unit()) * this.sr);
    }
    this.left--;
    this.value += (this.target - this.value) * this.coef;
    return this.value;
  }
}

/** 0..1 smooth ramp (3x^2 - 2x^3), clamped. */
export function smoothstep(x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * One-shot envelope: smooth attack over `attack` s, flat until `hold` s, then exponential release with time
 * constant `tau`, forced to exactly 0 at `end` (the last ~10% of the tail is faded so the buffer ends silent).
 */
export function oneShotEnv(t: number, attack: number, hold: number, tau: number, end: number): number {
  if (t <= 0 || t >= end) return 0;
  const a = attack > 0 ? smoothstep(t / attack) : 1;
  const r = t <= hold ? 1 : Math.exp(-(t - hold) / Math.max(1e-4, tau));
  const tailStart = end * 0.9;
  const tail = t <= tailStart ? 1 : 1 - smoothstep((t - tailStart) / (end - tailStart));
  return a * r * tail;
}

/** Percussive envelope: linear attack over `attack` s then exp decay `tau`, ending at 0 at `end`. */
export function percEnv(t: number, attack: number, tau: number, end: number): number {
  return oneShotEnv(t, attack, attack, tau, end);
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp01(x: number): number {
  return x !== x ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;
}

/** A per-sample mono generator for a render: reset at sample 0, then next() once per sample. */
export interface MonoSource {
  reset(sr: number): void;
  next(): number;
}

/**
 * A one-shot renderer from per-channel sources (one source per channel; channel c uses sources[c], or the last
 * source when there are fewer sources than channels). Restarts the sources whenever a render begins at sample 0
 * (or in prime(), the bank's step before the first chunk [FIN-A]; the samples are the same).
 */
export function oneShotRenderer(sources: readonly MonoSource[]): SampleRenderer {
  let next = -1;
  /** [FIN-A] prime() reset the sources for this rate and nothing has rendered since. */
  let armedRate = -1;
  const render: SampleRenderer = (out, from, to, sr) => {
    if (!(from === 0 && armedRate === sr) && (from === 0 || from !== next)) {
      for (let s = 0; s < sources.length; s++) sources[s]!.reset(sr);
    }
    armedRate = -1;
    const n = out.length;
    for (let c = 0; c < n; c++) {
      const src = sources[c < sources.length ? c : sources.length - 1]!;
      if (c > 0 && c >= sources.length) {
        const ch0 = out[0]!;
        const ch = out[c]!;
        for (let i = from; i < to; i++) ch[i] = ch0[i]!;
        continue;
      }
      const ch = out[c]!;
      for (let i = from; i < to; i++) ch[i] = src.next();
    }
    next = to;
  };
  // [FIN-A] The sources' reset (a NoiseBand calibrates on 4096 samples) as a bank step of its own, not inside chunk 1.
  render.prime = (_c, _len, sr) => {
    for (let s = 0; s < sources.length; s++) sources[s]!.reset(sr);
    armedRate = sr;
    next = -1;
    return true;
  };
  return render;
}

/**
 * Seamless loop renderer: the buffer of N samples is the source signal g with its loop point crossfaded, so the
 * last sample flows into the first with no discontinuity (glitch list: "crowd loop clicking").
 *
 *   out[k] = g[k + F]                                for k <  N - F
 *   out[k] = g[k + F] * cos(pi/2 u) + g[i] * sin(pi/2 u),  i = k - (N - F), u = (i + 1) / F   for k >= N - F
 *
 * so out[N - 1] = g[F - 1] and out[0] = g[F]: consecutive source samples across the wrap. The equal-power fade keeps
 * the level of uncorrelated noise constant. g[0..F) is generated first and kept in a small prefix buffer, so the
 * whole buffer still renders front to back in consecutive chunks. The prefix is generated by the renderer's prime()
 * in chunk-sized steps when the bank runs it [FIN-A], else at the first chunk; the samples are the same either way.
 */
export function loopRenderer(fadeSec: number, sources: readonly MonoSource[]): SampleRenderer {
  let prefix: Float32Array | null = null;
  let fade = 0;
  let length = 0;
  let chans = 0;
  let rate = 0;
  /** Prefix samples per channel generated so far (each channel's source has advanced this far). */
  let filled = 0;
  /** [FIN-A] prime() finished the prefix and nothing has rendered since: a render from 0 continues from it. */
  let armed = false;
  let next = -1;
  const matches = (c: number, len: number, sr: number): boolean => prefix !== null && chans === c && length === len && rate === sr;
  const setup = (c: number, len: number, sr: number): void => {
    length = len;
    chans = c;
    rate = sr;
    fade = Math.max(1, Math.min(Math.round(fadeSec * sr), Math.floor(len / 2)));
    prefix = new Float32Array(fade * c);
    filled = 0;
    armed = false;
    for (let s = 0; s < sources.length; s++) sources[s]!.reset(sr);
  };
  /** Generate prefix samples [filled, filled + n) of every channel (sources are per channel: same as one go). */
  const fill = (n: number): void => {
    const p = prefix!;
    const end = Math.min(fade, filled + n);
    for (let c = 0; c < chans; c++) {
      if (c > 0 && c >= sources.length) {
        for (let i = filled; i < end; i++) p[i * chans + c] = p[i * chans]!;
      } else {
        const src = sources[Math.min(c, sources.length - 1)]!;
        for (let i = filled; i < end; i++) p[i * chans + c] = src.next();
      }
    }
    filled = end;
  };
  const render: SampleRenderer = (out, from, to, sr) => {
    const nCh = out.length;
    const usePrimed = from === 0 && armed && matches(nCh, out[0]!.length, sr);
    if (!usePrimed && (from === 0 || from !== next || !prefix)) {
      setup(nCh, out[0]!.length, sr);
      fill(fade);
    }
    armed = false;
    const pre = prefix!;
    const start = length - fade;
    for (let c = 0; c < nCh; c++) {
      const ch = out[c]!;
      if (c > 0 && c >= sources.length) {
        const ch0 = out[0]!;
        for (let k = from; k < to; k++) ch[k] = ch0[k]!;
        continue;
      }
      const src = sources[c]!;
      for (let k = from; k < to; k++) {
        const g = src.next();
        if (k < start) {
          ch[k] = g;
        } else {
          const i = k - start;
          const u = ((i + 1) / fade) * (Math.PI / 2);
          ch[k] = g * Math.cos(u) + pre[i * nCh + c]! * Math.sin(u);
        }
      }
    }
    next = to;
  };
  // [FIN-A] The prefix in steps of maxSamples per channel (the bank's chunk), so the first chunk no longer renders
  // half a second of source signal in one go (a 10-25 ms menu frame right after the splash tap).
  // The sources' reset (NoiseBand calibrates on 4096 samples) is about one chunk of work too: a step of its own.
  render.prime = (c, len, sr, maxSamples) => {
    if (armed && matches(c, len, sr)) return true;
    if (!matches(c, len, sr) || filled >= fade || next !== -1) {
      setup(c, len, sr);
      next = -1;
      return false;
    }
    fill(Math.max(1, Math.floor(maxSamples)));
    armed = filled >= fade;
    return armed;
  };
  return render;
}

/** Pan -1..1 for a pitch x seen from a camera at `camX`: (x - camX) / span, clamped, scaled by width. */
export function panFor(x: number, camX: number, span: number, width: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(camX) || !(span > 0)) return 0;
  const p = (x - camX) / span;
  const c = p < -1 ? -1 : p > 1 ? 1 : p;
  return c * clamp01(width);
}

/**
 * Smoothly move an AudioParam toward `v` from time `t` (time constant `tc`), cancelling later automation first so
 * calls never pile up; a plain value write where automation is missing (test fakes, very old browsers).
 */
export function glide(p: AudioParam, v: number, t: number, tc: number): void {
  try {
    if (typeof p.setTargetAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(t);
      p.setTargetAtTime(v, t, Math.max(0.001, tc));
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = v;
}

/** Set an AudioParam to `v` at time `t` now (cancelling later automation); plain write as a fallback. */
export function setNow(p: AudioParam, v: number, t: number): void {
  try {
    if (typeof p.setValueAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = v;
}

/** Start a fresh AudioParam at 0 at time `t` and glide to `v` (time constant `tc`); no cancel (nothing scheduled). */
export function riseFromZero(p: AudioParam, v: number, t: number, tc: number): void {
  try {
    if (typeof p.setValueAtTime === 'function' && typeof p.setTargetAtTime === 'function') {
      p.setValueAtTime(0, t);
      p.setTargetAtTime(v, t, Math.max(0.001, tc));
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = v;
}
