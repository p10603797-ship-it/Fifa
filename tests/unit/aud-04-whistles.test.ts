/**
 * [AUD-04] Whistles and match stings: envelopes per WhistleKind (short for fouls, long for half time, three blasts
 * for full time), the pea-whistle tone (pitch and flutter), stings, and the module on the real engine (one whistle
 * per call, repeats ignored, the full-time sting after the final whistle, the kick-off sting at match start).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WhistleKind } from '../../src/contracts/events';
import { createAudioEngine } from '../../src/audio/engine';
import {
  renderSting, renderWhistle, STING_COUNT, StingKind, stingLength, WHISTLE_KINDS, WHISTLE_SHAPES, WHISTLE_TUNING as T, whistleEnvelope,
  whistleLength, type WhistleModule,
} from '../../src/audio/whistles';
import { makeScenario } from '../harness/scenario';
import { bootRealEngine, sourcesWithLength } from './aud-01-fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SR = 48000;

/** Blasts found in the envelope: [start, end] where it is above half level. */
function blasts(kind: WhistleKind): [number, number][] {
  const out: [number, number][] = [];
  const len = whistleLength(kind);
  let on = -1;
  for (let i = 0; i <= len * 1000; i++) {
    const t = i / 1000;
    const v = whistleEnvelope(kind, t);
    if (v > 0.5 && on < 0) on = t;
    if (v <= 0.5 && on >= 0) {
      out.push([on, t]);
      on = -1;
    }
  }
  return out;
}

function renderKind(kind: WhistleKind): Float32Array {
  const n = Math.round(whistleLength(kind) * SR);
  const ch = new Float32Array(n);
  const r = renderWhistle(kind);
  for (let f = 0; f < n; f += 4096) r([ch], f, Math.min(n, f + 4096), SR);
  return ch;
}

describe('AUD-04 whistle envelopes per kind', () => {
  it('SHORT is one quick blast, START a firmer one, LONG one long blast, FINAL three blasts with the last longest', () => {
    const s = blasts(WhistleKind.SHORT);
    const st = blasts(WhistleKind.START);
    const l = blasts(WhistleKind.LONG);
    const f = blasts(WhistleKind.FINAL);
    expect(s.length).toBe(1);
    expect(st.length).toBe(1);
    expect(l.length).toBe(1);
    expect(f.length).toBe(3);
    const d = (b: [number, number]): number => b[1] - b[0];
    expect(d(s[0]!)).toBeLessThan(0.35);
    expect(d(st[0]!)).toBeGreaterThan(d(s[0]!));
    expect(d(l[0]!)).toBeGreaterThan(1);
    expect(d(l[0]!)).toBeGreaterThan(2 * d(st[0]!));
    expect(d(f[2]!)).toBeGreaterThan(d(f[0]!) * 2);
    expect(d(f[0]!)).toBeCloseTo(d(f[1]!), 2);
  });

  it('starts and ends at zero, is silent between the final blasts, never exceeds 1, ramps (no step)', () => {
    for (const k of WHISTLE_KINDS) {
      expect(whistleEnvelope(k, 0)).toBe(0);
      expect(whistleEnvelope(k, whistleLength(k))).toBe(0);
      expect(whistleEnvelope(k, -1)).toBe(0);
      expect(whistleEnvelope(k, Number.NaN)).toBe(0);
      let prev = 0;
      for (let i = 1; i <= whistleLength(k) * SR; i += 7) {
        const v = whistleEnvelope(k, i / SR);
        expect(v).toBeLessThanOrEqual(1);
        expect(Math.abs(v - prev)).toBeLessThan(0.05); // 7 samples apart: smooth attack/release
        prev = v;
      }
    }
    const sh = WHISTLE_SHAPES[WhistleKind.FINAL];
    const gap = (sh[0]![0] + sh[0]![1] + sh[1]![0]) / 2;
    expect(whistleEnvelope(WhistleKind.FINAL, gap)).toBe(0);
    expect(whistleEnvelope(99 as WhistleKind, 0.1)).toBe(0);
  });

  it('a long blast sags slightly (the referee runs out of breath), never rises', () => {
    const early = whistleEnvelope(WhistleKind.LONG, 0.1);
    const late = whistleEnvelope(WhistleKind.LONG, 1.1);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThan(0.75);
  });
});

describe('AUD-04 pea whistle tone', () => {
  it('sounds at about 2.5-3.5 kHz with flutter, below full scale, silent between blasts', () => {
    for (const k of WHISTLE_KINDS) {
      const ch = renderKind(k);
      const [s0, d0] = WHISTLE_SHAPES[k][0]!;
      const a = Math.round((s0 + 0.05) * SR);
      const b = Math.round((s0 + d0 - 0.06) * SR);
      // Pitch from zero crossings.
      let zc = 0;
      for (let i = a + 1; i < b; i++) if ((ch[i - 1]! < 0) !== (ch[i]! < 0)) zc++;
      const hz = zc / 2 / ((b - a) / SR);
      expect(hz, `kind ${k}`).toBeGreaterThan(2500);
      expect(hz, `kind ${k}`).toBeLessThan(3500);
      // Flutter: the short-window level wobbles (amplitude modulation), it is not a flat sine.
      const win = Math.round(SR / 400);
      const levels: number[] = [];
      for (let i = a; i + win < b; i += win) {
        let e = 0;
        for (let j = i; j < i + win; j++) e += ch[j]! * ch[j]!;
        levels.push(Math.sqrt(e / win));
      }
      const mean = levels.reduce((x, y) => x + y, 0) / levels.length;
      const sd = Math.sqrt(levels.reduce((x, y) => x + (y - mean) ** 2, 0) / levels.length);
      expect(sd / mean, `kind ${k}`).toBeGreaterThan(0.05);
      let peak = 0;
      for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!));
      expect(peak).toBeLessThan(1);
      expect(peak).toBeGreaterThan(0.2);
      expect(ch[0]).toBe(0);
      expect(Math.abs(ch[ch.length - 1]!)).toBeLessThan(1e-6);
    }
    const fin = renderKind(WhistleKind.FINAL);
    const sh = WHISTLE_SHAPES[WhistleKind.FINAL];
    const gapAt = Math.round(((sh[0]![0] + sh[0]![1] + sh[1]![0]) / 2) * SR);
    expect(fin[gapAt]).toBe(0);
  });

  it('stings are short, subtle, finite and end in silence', () => {
    for (let k = 0; k < STING_COUNT; k++) {
      const len = stingLength(k);
      expect(len).toBeLessThan(2);
      const n = Math.round(len * SR);
      const ch = new Float32Array(n);
      renderSting(k)([ch], 0, n, SR);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(ch[i]!)).toBe(true);
        peak = Math.max(peak, Math.abs(ch[i]!));
      }
      expect(peak).toBeGreaterThan(0.1);
      expect(peak).toBeLessThan(0.6);
      expect(Math.abs(ch[n - 1]!)).toBeLessThan(1e-3);
    }
  });
});

describe('AUD-04 whistles module on the engine', () => {
  it('each kind plays its own buffer once; a repeat within the window is ignored; later it plays again', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const wh = boot.engine.services!.modules.whistles as WhistleModule;
    for (const k of WHISTLE_KINDS) {
      wh.whistle(k);
      expect(wh.stats.whistles[k], `kind ${k}`).toBe(1);
      expect(sourcesWithLength(boot.ac, Math.round(whistleLength(k) * SR)).length).toBeGreaterThanOrEqual(1);
    }
    wh.whistle(WhistleKind.SHORT);
    expect(wh.stats.whistles[WhistleKind.SHORT]).toBe(1);
    expect(wh.stats.repeats).toBe(1);
    boot.ac.advance(T.repeatWindow + 0.05);
    wh.whistle(WhistleKind.SHORT);
    expect(wh.stats.whistles[WhistleKind.SHORT]).toBe(2);
    wh.whistle(42 as WhistleKind);
    expect(boot.errors).toEqual([]);
    boot.engine.dispose();
  });

  it('the final whistle is followed by the full-time sting after its last blast', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const wh = boot.engine.services!.modules.whistles as WhistleModule;
    const t0 = boot.ac.currentTime;
    wh.whistle(WhistleKind.FINAL);
    expect(wh.stats.stings[StingKind.FULL_TIME]).toBe(1);
    const sting = sourcesWithLength(boot.ac, Math.round(stingLength(StingKind.FULL_TIME) * SR));
    expect(sting.length).toBe(1);
    expect(sting[0]!.startedAt).toBeGreaterThanOrEqual(t0 + whistleLength(WhistleKind.FINAL));
    boot.engine.dispose();
  });

  it('match start plays the kick-off sting; a goal sting on request; pause stops pending stings', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const wh = boot.engine.services!.modules.whistles as WhistleModule;
    boot.engine.matchStart(makeScenario());
    expect(wh.stats.stings[StingKind.KICK_OFF]).toBe(1);
    wh.sting(StingKind.GOAL);
    expect(wh.stats.stings[StingKind.GOAL]).toBe(1);
    // A delayed sting that has not started yet is stopped by the pause (nothing bursts out afterwards).
    wh.whistle(WhistleKind.FINAL);
    const sting = sourcesWithLength(boot.ac, Math.round(stingLength(StingKind.FULL_TIME) * SR))[0]!;
    boot.engine.setPaused(true);
    expect(sting.stoppedAt).toBeGreaterThanOrEqual(0);
    expect(sting.stoppedAt).toBeLessThan(sting.startedAt);
    expect(boot.errors).toEqual([]);
    boot.engine.dispose();
  });
});
