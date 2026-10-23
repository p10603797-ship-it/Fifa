/**
 * [AUD-03] Ball, body and goal-frame sounds (BRIEF section 8 "Kicks scaled by power, post and bar, net, tackles").
 *
 * Every sound is a one-shot synthesised once after unlock into the buffer bank (thump + filtered noise + inharmonic
 * partials, see HIT_SPECS) and played per event through the engine's effects voice pool (capped, voice stealing,
 * same-sound retrigger), so nothing is synthesised per event and sounds never stack.
 * - Kicks: the sample (touch / pass / strike / header / glove) follows the KickKind; gain, pitch and brightness
 *   follow the power (kickCue). First touches, dribble touches and deflections are soft; hand releases are silent.
 * - Bounce by impact speed (quiet below LOCAL_TUNING.minBounceSpeed), post/bar ring, net rustle by ball speed,
 *   tackles (thud + grass scuff), slides (scrape), body contact, keeper gloves.
 * - Stereo pan from the event's pitch x relative to the camera x (setCameraX from the renderer when wired, else
 *   the broadcast camera's follow rule from BRIEF section 8: 70% of the ball x, clamped to +-32 m).
 * The event map (AUD-05) calls these methods; this module has no onEvents of its own.
 */
import { ChallengeKind, KickKind } from '../contracts/enums';
import { clamp01, FilterKind, type MonoSource, NoiseBand, oneShotEnv, oneShotRenderer, Osc, panFor } from './dsp';
import { getAudioServices } from './services';
import type { AudioCtx, AudioModule } from './types';

const LOCAL_TUNING = {
  /** Distance from the camera x that pans fully, m; pan width (0 mono .. 1 hard left/right). */
  panSpan: 30,
  panWidth: 0.7,
  /** Camera x estimate when the renderer does not report one: follow fraction and clamp, m (BRIEF section 8). */
  cameraFollow: 0.7,
  cameraClamp: 32,
  /** Bounces slower than this are silent; full volume at bounceFullSpeed, m/s. */
  minBounceSpeed: 1,
  bounceFullSpeed: 14,
  /** Ball speed for full-volume post/bar and net sounds, m/s. */
  frameFullSpeed: 25,
  netFullSpeed: 25,
  /** Pass kicks above this power use the brighter strike sample. */
  brightPassPower: 0.8,
} as const; // LOCAL_TUNING (non-gameplay: sound effects)

export const SFX_TUNING = LOCAL_TUNING;

export enum SfxSample {
  NONE = -1,
  TOUCH = 0,
  PASS = 1,
  STRIKE = 2,
  HEADER = 3,
  GLOVE = 4,
  BOUNCE = 5,
  POST = 6,
  NET = 7,
  TACKLE = 8,
  SLIDE = 9,
  BODY = 10,
}

export const SFX_SAMPLE_COUNT = 11;

/** Voice-pool group of a sample (whistles use 100+): the same sample within the retrigger window replaces itself. */
export const SFX_GROUP_BASE = 0;

export interface SfxCue {
  sample: SfxSample;
  /** Linear gain 0..1. */
  gain: number;
  /** Playback rate (pitch). */
  rate: number;
  /** Voice priority (higher steals lower). */
  priority: number;
}

export interface SfxStats {
  /** Sounds started per SfxSample. */
  readonly played: Int32Array;
  /** Calls that found no voice / no buffer. */
  dropped: number;
  /** Pan of the latest sound. */
  lastPan: number;
}

export interface SfxModule extends AudioModule {
  /** EventType.KICK: kind, power 0..1, pitch x of the ball. */
  kick(kind: KickKind, power: number, x: number): void;
  /** EventType.BOUNCE: impact speed m/s. */
  bounce(speed: number, x: number): void;
  /** EventType.POST: bar = crossbar, impact speed m/s. */
  frame(bar: boolean, speed: number, x: number): void;
  /** EventType.NET: ball speed m/s. */
  net(speed: number, x: number): void;
  /** EventType.TACKLE: challenge kind, won the ball. */
  tackle(kind: ChallengeKind, won: boolean, x: number): void;
  /** EventType.BODY_CONTACT. */
  body(x: number): void;
  /** Keeper catch / parry / pick-up; strength 0..1. */
  glove(strength: number, x: number): void;
  /** Camera x for panning (renderer hook); NaN = estimate from the ball. */
  setCameraX(x: number): void;
  readonly stats: SfxStats;
}

function resetCue(out: SfxCue, sample: SfxSample, gain: number, rate: number, priority: number): SfxCue {
  out.sample = sample;
  out.gain = gain;
  out.rate = rate;
  out.priority = priority;
  return out;
}

/** Sound for a kick (pure): sample by kind, louder/heavier/brighter with power, first touches soft. */
export function kickCue(kind: KickKind, power: number, out: SfxCue): SfxCue {
  const p = clamp01(power);
  switch (kind) {
    case KickKind.NONE:
    case KickKind.THROW_IN:
    case KickKind.GK_THROW:
    case KickKind.GK_DRIVEN_THROW:
    case KickKind.GK_ROLL:
    case KickKind.GK_RELEASE:
      return resetCue(out, SfxSample.NONE, 0, 1, 0);
    case KickKind.GK_PARRY:
    case KickKind.GK_PUNCH:
    case KickKind.GK_TIP:
      return resetCue(out, SfxSample.GLOVE, 0.45 + 0.45 * p, 1, 1.2);
    case KickKind.HEADER_SHOT:
    case KickKind.HEADER_PASS:
      return resetCue(out, SfxSample.HEADER, 0.35 + 0.45 * p, 1.05 - 0.1 * p, 1);
    case KickKind.FIRST_TOUCH:
    case KickKind.DRIBBLE_TOUCH:
    case KickKind.KNOCK_ON:
    case KickKind.SKILL_TOUCH:
    case KickKind.DEFLECTION:
    case KickKind.TACKLE_POKE:
      return resetCue(out, SfxSample.TOUCH, 0.2 + 0.35 * p, 1.05 - 0.1 * p, 0.3);
    case KickKind.SHOT_NORMAL:
    case KickKind.SHOT_FINESSE:
    case KickKind.SHOT_CHIP:
    case KickKind.SHOT_POWER:
    case KickKind.SHOT_LOW_DRIVEN:
    case KickKind.VOLLEY_SHOT:
    case KickKind.PENALTY:
    case KickKind.FREE_KICK_SHOT:
    case KickKind.GK_DROP_KICK:
    case KickKind.GK_DRIVEN_KICK:
    case KickKind.GOAL_KICK:
    case KickKind.CLEARANCE:
      return resetCue(out, SfxSample.STRIKE, 0.5 + 0.5 * p, 1.1 - 0.2 * p, 1.5);
    default:
      // Passes, crosses, through balls, volley passes, kick-off.
      return resetCue(out, p > LOCAL_TUNING.brightPassPower ? SfxSample.STRIKE : SfxSample.PASS, 0.35 + 0.5 * p, 1.12 - 0.2 * p, 1);
  }
}

/** Bounce thud by impact speed (pure); silent below minBounceSpeed. */
export function bounceCue(speed: number, out: SfxCue): SfxCue {
  const T = LOCAL_TUNING;
  if (!Number.isFinite(speed) || speed < T.minBounceSpeed) return resetCue(out, SfxSample.NONE, 0, 1, 0);
  const s = clamp01((speed - T.minBounceSpeed) / (T.bounceFullSpeed - T.minBounceSpeed));
  return resetCue(out, SfxSample.BOUNCE, 0.12 + 0.6 * s, 0.9 + 0.2 * s, 0.5);
}

/** Post or crossbar ring by impact speed (pure); the bar rings a little lower. */
export function frameCue(bar: boolean, speed: number, out: SfxCue): SfxCue {
  const s = clamp01((Number.isFinite(speed) ? speed : 0) / LOCAL_TUNING.frameFullSpeed);
  return resetCue(out, SfxSample.POST, 0.35 + 0.65 * s, bar ? 0.92 : 1, 2);
}

/** Net rustle by ball speed (pure). */
export function netCue(speed: number, out: SfxCue): SfxCue {
  const s = clamp01((Number.isFinite(speed) ? speed : 0) / LOCAL_TUNING.netFullSpeed);
  return resetCue(out, SfxSample.NET, 0.3 + 0.6 * s, 0.95 + 0.1 * s, 2);
}

/** Tackle / challenge sound (pure). */
export function tackleCue(kind: ChallengeKind, won: boolean, out: SfxCue): SfxCue {
  switch (kind) {
    case ChallengeKind.SLIDE:
      return resetCue(out, SfxSample.SLIDE, 0.6, 1, 1);
    case ChallengeKind.SHOULDER:
    case ChallengeKind.KEEPER:
      return resetCue(out, SfxSample.BODY, 0.55, 1, 1);
    case ChallengeKind.PUSH_PULL:
      return resetCue(out, SfxSample.BODY, 0.35, 1.08, 0.8);
    default:
      return resetCue(out, SfxSample.TACKLE, won ? 0.6 : 0.45, won ? 1 : 1.05, 1);
  }
}

/** Camera x estimate from the ball (BRIEF section 8 broadcast follow). */
export function estimateCameraX(ballX: number): number {
  if (!Number.isFinite(ballX)) return 0;
  const c = ballX * LOCAL_TUNING.cameraFollow;
  const m = LOCAL_TUNING.cameraClamp;
  return c < -m ? -m : c > m ? m : c;
}

// ------------------------------------------------------------------ synthesis (render time only)

export interface NoiseLayer {
  kind: FilterKind;
  freq: number;
  /** Frequency at the end of the sound (glide), Hz; 0 = fixed. */
  freqEnd: number;
  q: number;
  attack: number;
  hold: number;
  tau: number;
  gain: number;
  /** Amplitude rattle rate (Hz) and depth 0..1 (net mesh). */
  rattleHz: number;
  rattleDepth: number;
}

export interface HitSpec {
  dur: number;
  /** Thump: sine gliding from f0 to f1 (glide time constant), decay tau, gain (0 = none). */
  thumpF0: number;
  thumpF1: number;
  thumpGlide: number;
  thumpTau: number;
  thumpGain: number;
  noise: readonly NoiseLayer[];
  /** Inharmonic partials (metal ring): base frequency, ratios, amplitudes, decay taus, overall gain. */
  ringF0: number;
  ringRatios: readonly number[];
  ringAmps: readonly number[];
  ringTaus: readonly number[];
  ringGain: number;
}

function nl(kind: FilterKind, freq: number, q: number, attack: number, hold: number, tau: number, gain: number, freqEnd = 0, rattleHz = 0, rattleDepth = 0): NoiseLayer {
  return { kind, freq, freqEnd, q, attack, hold, tau, gain, rattleHz, rattleDepth };
}

const NO_RING = { ringF0: 0, ringRatios: [], ringAmps: [], ringTaus: [], ringGain: 0 };
const BP = FilterKind.BANDPASS;
const LP = FilterKind.LOWPASS;
const HP = FilterKind.HIGHPASS;

/** Sample shapes (index = SfxSample). */
export const HIT_SPECS: readonly HitSpec[] = [
  // TOUCH: soft thump with a little leather click.
  { dur: 0.09, thumpF0: 180, thumpF1: 90, thumpGlide: 0.02, thumpTau: 0.018, thumpGain: 0.55, noise: [nl(BP, 2200, 1, 0.001, 0.001, 0.004, 0.08)], ...NO_RING },
  // PASS: firmer thump and slap.
  { dur: 0.14, thumpF0: 150, thumpF1: 70, thumpGlide: 0.025, thumpTau: 0.03, thumpGain: 0.6, noise: [nl(BP, 1600, 0.9, 0.001, 0.002, 0.008, 0.12)], ...NO_RING },
  // STRIKE: heavy thump and bright crack.
  {
    dur: 0.22, thumpF0: 120, thumpF1: 50, thumpGlide: 0.03, thumpTau: 0.045, thumpGain: 0.58,
    noise: [nl(BP, 2800, 0.8, 0.0005, 0.002, 0.01, 0.16), nl(HP, 5000, 0.7, 0.0005, 0.001, 0.004, 0.06)], ...NO_RING,
  },
  // HEADER: duller, higher thud.
  { dur: 0.12, thumpF0: 220, thumpF1: 120, thumpGlide: 0.02, thumpTau: 0.025, thumpGain: 0.6, noise: [nl(LP, 900, 0.7, 0.001, 0.002, 0.012, 0.1)], ...NO_RING },
  // GLOVE: slap and a soft thud.
  { dur: 0.12, thumpF0: 140, thumpF1: 110, thumpGlide: 0.02, thumpTau: 0.025, thumpGain: 0.35, noise: [nl(BP, 1200, 1.2, 0.001, 0.003, 0.015, 0.2)], ...NO_RING },
  // BOUNCE: soft low thud.
  { dur: 0.12, thumpF0: 110, thumpF1: 70, thumpGlide: 0.02, thumpTau: 0.03, thumpGain: 0.6, noise: [nl(LP, 600, 0.7, 0.001, 0.002, 0.01, 0.05)], ...NO_RING },
  // POST: metallic ring with a short inharmonic decay.
  {
    dur: 1.4, thumpF0: 90, thumpF1: 80, thumpGlide: 0.02, thumpTau: 0.02, thumpGain: 0.35,
    noise: [nl(BP, 3000, 1, 0.0005, 0.001, 0.003, 0.12)],
    ringF0: 540, ringRatios: [1, 2.32, 4.25, 6.63, 9.38, 13.1], ringAmps: [1, 0.6, 0.45, 0.3, 0.2, 0.12],
    ringTaus: [0.9, 0.6, 0.4, 0.25, 0.15, 0.1], ringGain: 0.17,
  },
  // NET: mesh swish and rustle.
  {
    dur: 0.7, thumpF0: 0, thumpF1: 0, thumpGlide: 0.02, thumpTau: 0.02, thumpGain: 0,
    noise: [nl(BP, 3500, 0.8, 0.015, 0.08, 0.18, 0.12, 2600, 28, 0.4), nl(BP, 1200, 1, 0.02, 0.06, 0.2, 0.07, 900)], ...NO_RING,
  },
  // TACKLE: thud and grass scuff.
  { dur: 0.25, thumpF0: 90, thumpF1: 55, thumpGlide: 0.03, thumpTau: 0.04, thumpGain: 0.7, noise: [nl(BP, 2000, 0.7, 0.01, 0.02, 0.05, 0.1)], ...NO_RING },
  // SLIDE: soft thud then a grass scrape.
  {
    dur: 0.55, thumpF0: 85, thumpF1: 60, thumpGlide: 0.03, thumpTau: 0.03, thumpGain: 0.45,
    noise: [nl(BP, 1800, 0.9, 0.04, 0.2, 0.12, 0.12, 1200, 11, 0.25)], ...NO_RING,
  },
  // BODY: thud and cloth.
  { dur: 0.14, thumpF0: 100, thumpF1: 80, thumpGlide: 0.02, thumpTau: 0.03, thumpGain: 0.6, noise: [nl(BP, 900, 0.8, 0.002, 0.004, 0.02, 0.08)], ...NO_RING },
];

const SAMPLE_IDS = ['sfx.touch', 'sfx.pass', 'sfx.strike', 'sfx.header', 'sfx.glove', 'sfx.bounce', 'sfx.post', 'sfx.net', 'sfx.tackle', 'sfx.slide', 'sfx.body'] as const;

/** One hit sound: thump + noise layers + ring partials, each with its own envelope. */
class HitSource implements MonoSource {
  private readonly thump = new Osc(0);
  private readonly bands: NoiseBand[] = [];
  private readonly ring: Osc[] = [];
  private readonly rattle: Osc[] = [];
  private i = 0;
  private sr = 48000;
  constructor(private readonly spec: HitSpec, seed: number) {
    for (let k = 0; k < spec.noise.length; k++) {
      const n = spec.noise[k]!;
      this.bands.push(new NoiseBand(seed + 17 * k, n.kind, n.freq, n.q));
      this.rattle.push(new Osc(0));
    }
    for (let k = 0; k < spec.ringRatios.length; k++) this.ring.push(new Osc(k * 0.7));
  }
  reset(sr: number): void {
    this.sr = sr;
    this.i = 0;
    this.thump.reset();
    for (let k = 0; k < this.bands.length; k++) {
      this.bands[k]!.reset(sr);
      this.rattle[k]!.reset();
    }
    for (let k = 0; k < this.ring.length; k++) this.ring[k]!.reset();
  }
  next(): number {
    const sp = this.spec;
    const sr = this.sr;
    const t = this.i / sr;
    const update = (this.i & 31) === 0;
    this.i++;
    if (t >= sp.dur) return 0;
    let v = 0;
    if (sp.thumpGain > 0) {
      const f = sp.thumpF1 + (sp.thumpF0 - sp.thumpF1) * Math.exp(-t / sp.thumpGlide);
      v += this.thump.next(f, sr) * sp.thumpGain * oneShotEnv(t, 0.001, 0.001, sp.thumpTau, sp.dur);
    }
    for (let k = 0; k < sp.noise.length; k++) {
      const n = sp.noise[k]!;
      const b = this.bands[k]!;
      if (update && n.freqEnd > 0) b.setFreq(n.freq + (n.freqEnd - n.freq) * (t / sp.dur));
      let a = n.gain * oneShotEnv(t, n.attack, n.hold, n.tau, sp.dur);
      if (n.rattleDepth > 0) a *= 1 - n.rattleDepth * (0.5 + 0.5 * this.rattle[k]!.next(n.rattleHz, sr));
      v += b.next() * a;
    }
    if (sp.ringGain > 0) {
      let r = 0;
      for (let k = 0; k < this.ring.length; k++) {
        r += this.ring[k]!.next(sp.ringF0 * sp.ringRatios[k]!, sr) * sp.ringAmps[k]! * Math.exp(-t / sp.ringTaus[k]!);
      }
      v += r * sp.ringGain * oneShotEnv(t, 0.0005, 0.0005, 10, sp.dur);
    }
    return v;
  }
}

/** Renderer of a sample (exported for tests). */
export function renderHit(sample: SfxSample) {
  return oneShotRenderer([new HitSource(HIT_SPECS[sample]!, 211 + 13 * sample)]);
}

// ------------------------------------------------------------------ module

export function createSfx(ctx: AudioCtx): SfxModule {
  const svc = getAudioServices(ctx);
  const bank = svc ? svc.bank : null;
  const handles = new Int32Array(SFX_SAMPLE_COUNT).fill(-1);
  if (bank) for (let s = 0; s < SFX_SAMPLE_COUNT; s++) handles[s] = bank.define(SAMPLE_IDS[s]!, HIT_SPECS[s]!.dur, 1, renderHit(s));
  const cue: SfxCue = { sample: SfxSample.NONE, gain: 0, rate: 1, priority: 0 };
  const stats: SfxStats = { played: new Int32Array(SFX_SAMPLE_COUNT), dropped: 0, lastPan: 0 };
  /** [camera x from the renderer (NaN = none), estimate from the ball]: a typed array (no boxing per frame). */
  const cam = new Float64Array([Number.NaN, 0]);

  function play(c: SfxCue, x: number): void {
    const s = c.sample;
    if (s === SfxSample.NONE || !(c.gain > 0)) return;
    if (!svc || !bank) {
      stats.dropped++;
      return;
    }
    const camX = Number.isFinite(cam[0]!) ? cam[0]! : cam[1]!;
    const pan = panFor(x, camX, LOCAL_TUNING.panSpan, LOCAL_TUNING.panWidth);
    const v = svc.effects.play(bank.get(handles[s]!), c.gain, pan, c.rate, c.priority, SFX_GROUP_BASE + s);
    if (v < 0) {
      stats.dropped++;
      return;
    }
    stats.played[s]!++;
    stats.lastPan = pan;
  }

  return {
    stats,
    kick(kind, power, x) {
      play(kickCue(kind, power, cue), x);
    },
    bounce(speed, x) {
      play(bounceCue(speed, cue), x);
    },
    frame(bar, speed, x) {
      play(frameCue(bar, speed, cue), x);
    },
    net(speed, x) {
      play(netCue(speed, cue), x);
    },
    tackle(kind, won, x) {
      play(tackleCue(kind, won, cue), x);
    },
    body(x) {
      play(resetCue(cue, SfxSample.BODY, 0.45, 1, 0.8), x);
    },
    glove(strength, x) {
      play(resetCue(cue, SfxSample.GLOVE, 0.4 + 0.5 * clamp01(strength), 1, 1.2), x);
    },
    setCameraX(x) {
      cam[0] = Number.isFinite(x) ? x : Number.NaN;
    },
    update(state) {
      if (state) cam[1] = estimateCameraX(state.ball.x);
    },
    dispose() {
      /* voices belong to the engine's pool; buffers to the bank */
    },
  };
}
