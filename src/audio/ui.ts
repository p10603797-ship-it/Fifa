/**
 * [AUD-05] Menu sounds (BRIEF section 8 "menu sounds"): move, confirm, back, error, toggle, start, countdown.
 *
 * - Soft, short tones (sine with a touch of harmonics, a click for toggles) rendered once into the buffer bank at
 *   unlock. They are rendered synchronously right away (bank.renderNow, well under a millisecond) because the splash
 *   tap that unlocks audio also plays UiSound.START.
 * - Played through the engine's menus voice pool (one group per kind, so a repeat replaces instead of stacking).
 * - Debounced per kind (UiDebouncer): key repeat and a focus move that also clicks a stepper give one sound.
 * - Without engine services (a bare AudioCtx) or before a buffer exists it falls back to a one-oscillator blip.
 * Hooks: UI components call AppContext.audio.playUi (src/ui/components.ts); focus moves by direction need the focus
 * navigator's onMove hook wired in boot (change request in the AUD-05 report).
 */
import { UiSound } from '../contracts/app';
import { type MonoSource, Noise, oneShotRenderer, Osc, smoothstep } from './dsp';
import { getAudioServices } from './services';
import type { AudioCtx, UiAudioModule } from './types';

const LOCAL_TUNING = {
  /** Minimum time between two sounds of the same kind, s (index = UiSound). */
  debounce: [0.04, 0.08, 0.08, 0.15, 0.06, 0.3, 0.25],
  /** Playback gain of menu sounds (the menus bus volume applies on top). */
  gain: 1,
} as const; // LOCAL_TUNING (non-gameplay: UI sounds)

export const UI_TUNING = LOCAL_TUNING;

export const UI_SOUNDS = [UiSound.MOVE, UiSound.CONFIRM, UiSound.BACK, UiSound.ERROR, UiSound.TOGGLE, UiSound.START, UiSound.COUNTDOWN] as const;

/** Voice-pool group base (sfx 0..10, whistles 100+). */
export const UI_GROUP_BASE = 200;

export interface UiToneSpec {
  /** [start s, frequency Hz, duration s, amplitude]. */
  notes: readonly (readonly [number, number, number, number])[];
  /** 2nd and 3rd harmonic levels. */
  h2: number;
  h3: number;
  /** Click (noise burst) level at the start. */
  click: number;
  level: number;
}

/** Sound shapes (index = UiSound). */
export const UI_SPECS: readonly UiToneSpec[] = [
  // MOVE: a tiny high tick.
  { notes: [[0, 1320, 0.035, 1]], h2: 0.1, h3: 0, click: 0, level: 0.16 },
  // CONFIRM: two notes up.
  { notes: [[0, 784, 0.07, 0.9], [0.055, 1174.66, 0.09, 1]], h2: 0.12, h3: 0, click: 0, level: 0.2 },
  // BACK: two notes down.
  { notes: [[0, 880, 0.06, 0.9], [0.05, 587.33, 0.08, 1]], h2: 0.12, h3: 0, click: 0, level: 0.18 },
  // ERROR: two low dull pulses.
  { notes: [[0, 220, 0.08, 1], [0.1, 207.65, 0.1, 1]], h2: 0.1, h3: 0.35, click: 0, level: 0.2 },
  // TOGGLE: click with a short tone.
  { notes: [[0, 990, 0.04, 1]], h2: 0.05, h3: 0, click: 0.3, level: 0.17 },
  // START: a bright rising three-note figure.
  { notes: [[0, 523.25, 0.12, 0.8], [0.08, 659.26, 0.12, 0.85], [0.16, 987.77, 0.22, 1]], h2: 0.15, h3: 0, click: 0, level: 0.2 },
  // COUNTDOWN: one clear beep.
  { notes: [[0, 880, 0.12, 1]], h2: 0.1, h3: 0, click: 0, level: 0.2 },
];

export function uiSoundLength(kind: UiSound): number {
  const sp = UI_SPECS[kind] ?? UI_SPECS[0]!;
  let end = 0;
  for (let i = 0; i < sp.notes.length; i++) end = Math.max(end, sp.notes[i]![0] + sp.notes[i]![2]);
  return end + 0.01;
}

/** Per-kind debounce (pure bookkeeping): accept() is false within the kind's interval of its last accepted call. */
export class UiDebouncer {
  private readonly last = new Float64Array(UI_SOUNDS.length).fill(-1e9);
  constructor(private readonly intervals: readonly number[] = LOCAL_TUNING.debounce) {}
  accept(kind: UiSound, now: number): boolean {
    if (kind < 0 || kind >= this.last.length || !Number.isFinite(now)) return false;
    const gap = this.intervals[kind] ?? 0.05;
    if (now - this.last[kind]! < gap && now >= this.last[kind]!) return false;
    this.last[kind] = now;
    return true;
  }
  reset(): void {
    this.last.fill(-1e9);
  }
}

class UiToneSource implements MonoSource {
  private readonly oscs: Osc[] = [];
  private readonly noise = new Noise(4242);
  private i = 0;
  private sr = 48000;
  constructor(private readonly spec: UiToneSpec) {
    for (let n = 0; n < spec.notes.length * 3; n++) this.oscs.push(new Osc(0));
  }
  reset(sr: number): void {
    this.sr = sr;
    this.i = 0;
    this.noise.reset();
    for (let n = 0; n < this.oscs.length; n++) this.oscs[n]!.reset();
  }
  next(): number {
    const sp = this.spec;
    const sr = this.sr;
    const t = this.i / sr;
    this.i++;
    let v = 0;
    for (let n = 0; n < sp.notes.length; n++) {
      const note = sp.notes[n]!;
      const u = t - note[0];
      const d = note[2];
      if (u <= 0 || u >= d) continue;
      const env = smoothstep(u / 0.004) * Math.exp(-u / (d / 2.5)) * (1 - smoothstep((u - d * 0.7) / (d * 0.3)));
      const f = note[1];
      const o = this.oscs;
      v += note[3] * env * (o[n * 3]!.next(f, sr) + sp.h2 * o[n * 3 + 1]!.next(2 * f, sr) + sp.h3 * o[n * 3 + 2]!.next(3 * f, sr));
    }
    if (sp.click > 0 && t < 0.006) v += sp.click * this.noise.white() * smoothstep(t / 0.0005) * (1 - t / 0.006);
    return v * sp.level;
  }
}

export function renderUiSound(kind: UiSound) {
  return oneShotRenderer([new UiToneSource(UI_SPECS[kind]!)]);
}

export interface UiStats {
  /** Sounds started per UiSound (buffer or fallback). */
  readonly played: Int32Array;
  /** Calls dropped by the debounce. */
  debounced: number;
  /** Sounds played by the oscillator fallback. */
  fallback: number;
}

export interface UiModule extends UiAudioModule {
  readonly stats: UiStats;
}

export function createUi(ctx: AudioCtx): UiModule {
  const svc = getAudioServices(ctx);
  const bank = svc ? svc.bank : null;
  const handles = new Int32Array(UI_SOUNDS.length).fill(-1);
  if (bank) {
    for (let i = 0; i < UI_SOUNDS.length; i++) {
      const k = UI_SOUNDS[i]!;
      handles[k] = bank.define(`ui.${k}`, uiSoundLength(k), 1, renderUiSound(k));
      bank.renderNow(handles[k]!);
    }
  }
  const debounce = new UiDebouncer();
  const stats: UiStats = { played: new Int32Array(UI_SOUNDS.length), debounced: 0, fallback: 0 };

  /** One oscillator blip (only without services or a buffer). */
  function fallback(kind: UiSound): void {
    const sp = UI_SPECS[kind]!;
    const ac = ctx.ctx;
    const note = sp.notes[sp.notes.length - 1]!;
    const len = uiSoundLength(kind);
    const t = ac.currentTime;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(note[1], t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(sp.level, t + 0.005);
    gain.gain.linearRampToValueAtTime(0, t + len);
    osc.connect(gain);
    gain.connect(ctx.menus);
    osc.start(t);
    osc.stop(t + len + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    stats.fallback++;
    stats.played[kind]!++;
  }

  return {
    stats,
    play(kind) {
      if (UI_SPECS[kind] === undefined) return;
      const ac = ctx.ctx;
      if (ac.state !== 'running') return;
      if (!debounce.accept(kind, ac.currentTime)) {
        stats.debounced++;
        return;
      }
      const buf = bank ? bank.get(handles[kind]!) : null;
      if (svc && buf) {
        if (svc.menus.play(buf, LOCAL_TUNING.gain, 0, 1, 1, UI_GROUP_BASE + kind) >= 0) stats.played[kind]!++;
        return;
      }
      fallback(kind);
    },
    dispose() {
      /* voices belong to the engine's pool; buffers to the bank */
    },
  };
}
