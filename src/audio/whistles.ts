/**
 * [AUD-04] Referee whistles and match stings (BRIEF section 8 "whistles (short for fouls, long for half time and
 * full time)").
 *
 * - Pea whistle synth, rendered once per WhistleKind after unlock: a ~2.9 kHz tone with a soft second harmonic, the
 *   pea's flutter as FM + AM at ~36-42 Hz, a small pitch scoop at each blast onset and breath noise around the
 *   tone. Blast patterns (WHISTLE_SHAPES): SHORT one quick blast (fouls, restarts), START a firmer blast (kick-off),
 *   LONG one long blast (half time), FINAL three blasts, the last one long (full time).
 * - Stings: short original bell-like motifs (kick-off, goal, full time), subtle, on the effects bus; no music loops.
 *   The kick-off sting plays on matchStart, the goal sting on GOAL (via the event map), the full-time sting right
 *   after the final whistle's last blast.
 * - Each whistle kind is ignored when it repeats within LOCAL_TUNING.repeatWindow (one call, one whistle).
 * The event map (AUD-05) calls whistle() and sting(); this module has no onEvents of its own.
 */
import { WhistleKind } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';
import { FilterKind, type MonoSource, NoiseBand, oneShotRenderer, Osc, smoothstep } from './dsp';
import { getAudioServices } from './services';
import type { AudioCtx, AudioModule } from './types';

const LOCAL_TUNING = {
  /** Whistle tone, Hz, per WhistleKind (SHORT, START, LONG, FINAL). */
  toneHz: [2900, 3000, 2850, 2900],
  /** Pea flutter rate (Hz), FM depth (Hz) and AM depth (0..1). */
  flutterHz: 38,
  flutterFm: 120,
  flutterAm: 0.35,
  /** Onset pitch scoop: Hz below the tone at the blast start, recovering with this time constant (s). */
  scoopHz: 180,
  scoopTc: 0.025,
  /** Blast attack and release, s. */
  attack: 0.015,
  release: 0.05,
  /** Level of the whistle buffer, breath noise and 2nd harmonic (linear). */
  level: 0.32,
  breath: 0.08,
  harmonic: 0.15,
  /** Same whistle kind again within this time is ignored, s. */
  repeatWindow: 0.5,
  /** Gap after the final whistle's last blast before the full-time sting, s. */
  fullTimeStingGap: 0.15,
  /** Playback gains of whistles and stings; random pitch spread of whistles (fraction). */
  whistleGain: 0.9,
  stingGain: 0.55,
  pitchSpread: 0.015,
} as const; // LOCAL_TUNING (non-gameplay: whistle audio)

export const WHISTLE_TUNING = LOCAL_TUNING;

/** Blasts per kind: [start s, duration s]. */
export const WHISTLE_SHAPES: Readonly<Record<WhistleKind, readonly (readonly [number, number])[]>> = {
  [WhistleKind.SHORT]: [[0, 0.26]],
  [WhistleKind.START]: [[0, 0.55]],
  [WhistleKind.LONG]: [[0, 1.3]],
  [WhistleKind.FINAL]: [[0, 0.38], [0.56, 0.38], [1.12, 1.15]],
};

export const WHISTLE_KINDS = [WhistleKind.SHORT, WhistleKind.START, WhistleKind.LONG, WhistleKind.FINAL] as const;

/** Buffer length of a whistle kind, s (last blast end plus a short silent tail). */
export function whistleLength(kind: WhistleKind): number {
  const sh = WHISTLE_SHAPES[kind] ?? WHISTLE_SHAPES[WhistleKind.SHORT];
  const last = sh[sh.length - 1]!;
  return last[0] + last[1] + 0.05;
}

/**
 * Whistle amplitude 0..1 at time t (pure): a smooth attack and release per blast, with a slight sag over a long
 * blast (the referee's breath). 0 between blasts and outside them.
 */
export function whistleEnvelope(kind: WhistleKind, t: number): number {
  const sh = WHISTLE_SHAPES[kind];
  if (!sh || !Number.isFinite(t)) return 0;
  const A = LOCAL_TUNING.attack;
  const R = LOCAL_TUNING.release;
  for (let i = 0; i < sh.length; i++) {
    const s = sh[i]![0];
    const d = sh[i]![1];
    if (t <= s || t >= s + d) continue;
    const u = t - s;
    const a = smoothstep(u / A);
    const r = 1 - smoothstep((u - (d - R)) / R);
    const sag = 1 - 0.15 * (u / d);
    return a * r * sag;
  }
  return 0;
}

/** Start time of the blast containing t, or -1 (pure). */
function blastStart(kind: WhistleKind, t: number): number {
  const sh = WHISTLE_SHAPES[kind];
  for (let i = 0; i < sh.length; i++) if (t >= sh[i]![0] && t < sh[i]![0] + sh[i]![1]) return sh[i]![0];
  return -1;
}

/** Pea whistle: tone with flutter FM/AM, onset scoop, soft 2nd harmonic, breath noise. */
class WhistleSource implements MonoSource {
  private readonly tone = new Osc(0);
  private readonly harm = new Osc(0.5);
  private readonly flutter = new Osc(0);
  private readonly drift = new Osc(1.1);
  private readonly breath: NoiseBand;
  private i = 0;
  private sr = 48000;
  constructor(private readonly kind: WhistleKind) {
    this.breath = new NoiseBand(7001 + 13 * kind, FilterKind.BANDPASS, LOCAL_TUNING.toneHz[kind] ?? 2900, 2);
  }
  reset(sr: number): void {
    this.sr = sr;
    this.i = 0;
    this.tone.reset();
    this.harm.reset();
    this.flutter.reset();
    this.drift.reset();
    this.breath.reset(sr);
  }
  next(): number {
    const T = LOCAL_TUNING;
    const sr = this.sr;
    const t = this.i / sr;
    this.i++;
    const env = whistleEnvelope(this.kind, t);
    // Keep the oscillators running between blasts so each blast starts mid-cycle (no phase reset click).
    const rate = T.flutterHz + 4 * this.drift.next(1.3, sr);
    const fl = this.flutter.next(rate, sr);
    if (env === 0) {
      this.breath.next();
      return 0;
    }
    const s0 = blastStart(this.kind, t);
    const scoop = s0 >= 0 ? T.scoopHz * Math.exp(-(t - s0) / T.scoopTc) : 0;
    const f = (T.toneHz[this.kind] ?? 2900) - scoop + T.flutterFm * fl;
    const am = 1 - T.flutterAm * (0.5 + 0.5 * fl);
    const v = this.tone.next(f, sr) + T.harmonic * this.harm.next(2 * f, sr);
    return T.level * env * (v * am + T.breath * this.breath.next());
  }
}

export function renderWhistle(kind: WhistleKind) {
  return oneShotRenderer([new WhistleSource(kind)]);
}

// ------------------------------------------------------------------ stings

export enum StingKind {
  KICK_OFF = 0,
  GOAL = 1,
  FULL_TIME = 2,
}

export const STING_COUNT = 3;

/** Notes per sting: [start s, frequency Hz, duration s, amplitude]. Original short motifs. */
export const STING_NOTES: readonly (readonly (readonly [number, number, number, number])[])[] = [
  // KICK_OFF: a rising fifth.
  [[0, 392, 0.5, 0.8], [0.16, 587.33, 0.7, 1]],
  // GOAL: a quick major arpeggio up to the octave.
  [[0, 523.25, 0.9, 0.8], [0.09, 659.26, 0.9, 0.8], [0.18, 783.99, 1, 0.9], [0.27, 1046.5, 1.1, 1]],
  // FULL_TIME: a falling line that settles on a chord.
  [[0, 783.99, 0.6, 0.8], [0.22, 659.26, 0.6, 0.8], [0.44, 523.25, 1, 1], [0.44, 392, 1, 0.6]],
];

const STING_LEVEL = 0.18;

export function stingLength(kind: StingKind): number {
  const notes = STING_NOTES[kind] ?? STING_NOTES[0]!;
  let end = 0;
  for (let i = 0; i < notes.length; i++) end = Math.max(end, notes[i]![0] + notes[i]![2]);
  return end + 0.02;
}

/** Bell-like notes: fundamental plus quickly decaying 2nd and slightly sharp 3rd partials. */
class StingSource implements MonoSource {
  private readonly oscs: Osc[] = [];
  private i = 0;
  private sr = 48000;
  constructor(private readonly kind: StingKind) {
    const notes = STING_NOTES[kind]!;
    for (let n = 0; n < notes.length * 3; n++) this.oscs.push(new Osc(0));
  }
  reset(sr: number): void {
    this.sr = sr;
    this.i = 0;
    for (let n = 0; n < this.oscs.length; n++) this.oscs[n]!.reset();
  }
  next(): number {
    const sr = this.sr;
    const t = this.i / sr;
    this.i++;
    const notes = STING_NOTES[this.kind]!;
    let v = 0;
    for (let n = 0; n < notes.length; n++) {
      const [s, f, d, a] = notes[n]!;
      const u = t - s;
      if (u <= 0 || u >= d) continue;
      const env = smoothstep(u / 0.005) * Math.exp(-u / (d / 3)) * (1 - smoothstep((u - d * 0.85) / (d * 0.15)));
      const o = this.oscs;
      const tone = o[n * 3]!.next(f, sr) + 0.3 * Math.exp(-u / 0.15) * o[n * 3 + 1]!.next(2 * f, sr) + 0.12 * Math.exp(-u / 0.08) * o[n * 3 + 2]!.next(3.01 * f, sr);
      v += a * env * tone;
    }
    return v * STING_LEVEL;
  }
}

export function renderSting(kind: StingKind) {
  return oneShotRenderer([new StingSource(kind)]);
}

// ------------------------------------------------------------------ module

/** Voice-pool groups (sfx uses 0..10). */
export const WHISTLE_GROUP = 100;
export const STING_GROUP = 101;

export interface WhistleStats {
  /** Whistles started per WhistleKind. */
  readonly whistles: Int32Array;
  /** Stings started per StingKind. */
  readonly stings: Int32Array;
  /** Whistles ignored as repeats within the window. */
  repeats: number;
}

export interface WhistleModule extends AudioModule {
  whistle(kind: WhistleKind): void;
  /** Play a sting, optionally `delay` seconds from now. */
  sting(kind: StingKind, delay?: number): void;
  readonly stats: WhistleStats;
}

export function createWhistles(ctx: AudioCtx): WhistleModule {
  const T = LOCAL_TUNING;
  const svc = getAudioServices(ctx);
  const bank = svc ? svc.bank : null;
  const whistleHandles = new Int32Array(4).fill(-1);
  const stingHandles = new Int32Array(STING_COUNT).fill(-1);
  if (bank) {
    for (let i = 0; i < WHISTLE_KINDS.length; i++) {
      const k = WHISTLE_KINDS[i]!;
      whistleHandles[k] = bank.define(`whistle.${k}`, whistleLength(k), 1, renderWhistle(k));
    }
    for (let k = 0; k < STING_COUNT; k++) stingHandles[k] = bank.define(`sting.${k}`, stingLength(k), 1, renderSting(k));
  }
  const lastAt = new Float64Array(4).fill(-1e9);
  const stats: WhistleStats = { whistles: new Int32Array(4), stings: new Int32Array(STING_COUNT), repeats: 0 };
  const seed = new Uint32Array([0x2545f491]);

  /** Playback-rate jitter so repeated whistles are not identical (xorshift32 in a typed array: no boxing). */
  function spread(): number {
    let x = seed[0]!;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    seed[0] = x;
    return 1 + T.pitchSpread * ((seed[0]! / 4294967296) * 2 - 1);
  }

  const mod: WhistleModule = {
    stats,
    whistle(kind) {
      if (kind !== WhistleKind.SHORT && kind !== WhistleKind.START && kind !== WhistleKind.LONG && kind !== WhistleKind.FINAL) return;
      const now = ctx.ctx.currentTime;
      if (now - lastAt[kind]! < T.repeatWindow) {
        stats.repeats++;
        return;
      }
      if (!svc || !bank) return;
      const v = svc.effects.play(bank.get(whistleHandles[kind]!), T.whistleGain, 0, spread(), 3, WHISTLE_GROUP);
      if (v < 0) return;
      lastAt[kind] = now;
      stats.whistles[kind]!++;
      if (kind === WhistleKind.FINAL) mod.sting(StingKind.FULL_TIME, whistleLength(WhistleKind.FINAL) + T.fullTimeStingGap);
    },
    sting(kind, delay = 0) {
      if (!svc || !bank || kind < 0 || kind >= STING_COUNT) return;
      const v = svc.effects.play(bank.get(stingHandles[kind]!), T.stingGain, 0, 1, 2.5, STING_GROUP, delay);
      if (v >= 0) stats.stings[kind]!++;
    },
    matchStart(state: ReadonlySimState) {
      void state;
      lastAt.fill(-1e9);
      mod.sting(StingKind.KICK_OFF);
    },
    dispose() {
      /* voices belong to the engine's pool; buffers to the bank */
    },
  };
  return mod;
}
