/**
 * [AUD-02] Crowd bed and reactions (BRIEF section 8 "A crowd bed whose intensity follows the match: build-up in the
 * final third, shots, near misses, goals, lulls"; glitch list "crowd loop clicking").
 *
 * - Bed: two seamless stereo loops rendered once after unlock (bank.ts) from filtered noise: a murmur (babble bands
 *   with syllable-rate wandering levels) and a roar (vowel formants with slow swells). The loop point is
 *   crossfaded inside the buffer (dsp.loopRenderer), so the wrap never clicks. Both loops run from match start to
 *   match end on the crowd bus; their gains (and the roar's brightness) follow the crowd intensity.
 * - Intensity: a target from the match state every frame (crowdTarget: phase lulls, the ball in the final third,
 *   who is attacking, ATTACK_BUILD and reaction boosts), smoothed with a fast rise and a slow fall
 *   (smoothIntensity). AudioParams are moved at most every LOCAL_TUNING.paramInterval with setTargetAtTime.
 * - Reactions: pre-rendered one-shots (ooh, groan, cheer, applause, murmur, boo) on the engine's crowd voice pool,
 *   picked by crowdReaction() from the cue, the team involved and the crowd's perspective: the human's team when
 *   exactly one side has humans, else the home side (the crowd is at the home ground). Goals: a big cheer for the
 *   perspective side, a smaller away-end cheer for the other side.
 * - The event map (AUD-05) calls cue() and attackBuild(); this module has no onEvents of its own.
 * Hot path: update() and cue() allocate nothing except the source node of a reaction that starts.
 */
import { HALF_LENGTH } from '../contracts/constants';
import { ControllerKind, MatchPhase } from '../contracts/enums';
import type { ReadonlySimState } from '../contracts/state';
import {
  clamp01, FilterKind, glide, lerp, loopRenderer, type MonoSource, NoiseBand, oneShotEnv, oneShotRenderer, setNow, Wander,
} from './dsp';
import { getAudioServices } from './services';
import type { AudioCtx, AudioModule } from './types';

const LOCAL_TUNING = {
  /** Bed loop length and loop-point crossfade, s. */
  bedSeconds: 6,
  bedFade: 0.5,
  /** Intensity while the ball is in play far from both goals (0..1). */
  baseInPlay: 0.3,
  /** Extra intensity with the ball at the goal line, scaled by proximity^ballExponent. */
  ballWeight: 0.45,
  ballExponent: 1.5,
  /** |x| where the final third starts, m. */
  finalThirdX: 17.5,
  /** Multiplier when the ball is in the possessing team's own half (defending, not attacking). */
  defendingFactor: 0.6,
  /** Multiplier when the side attacking is not the crowd's side (away end is smaller). */
  awayAttackFactor: 0.8,
  /** Intensity per phase outside open play (lulls and set-piece anticipation). */
  preMatch: 0.3,
  kickOff: 0.35,
  throwIn: 0.3,
  goalKick: 0.25,
  corner: 0.55,
  freeKickBase: 0.3,
  freeKickNearGoal: 0.3,
  penalty: 0.75,
  goal: 0.95,
  celebration: 0.85,
  replay: 0.5,
  halfTime: 0.12,
  fullTime: 0.4,
  extraTimeBreak: 0.2,
  shootOut: 0.6,
  postMatch: 0.15,
  /** Smoothing time constants: rising and falling intensity, s. */
  riseTc: 0.5,
  fallTc: 2,
  /** Boost decay time constant, s; ATTACK_BUILD boost per unit of event intensity. */
  boostTc: 3,
  attackBuildBoost: 0.3,
  /** Bed layer gains: murmur from min to max with intensity; roar = roarMax * intensity^roarExponent. */
  murmurMin: 0.35,
  murmurMax: 0.65,
  roarMax: 0.9,
  roarExponent: 2,
  /** Roar low-pass cutoff from calm to excited, Hz. */
  roarLpMin: 900,
  roarLpMax: 4200,
  /** AudioParam update period and glide time constant, s. */
  paramInterval: 0.08,
  paramTc: 0.12,
  /** Bed fade in at match start and out at match end, s. */
  fadeIn: 1.5,
  fadeOut: 1.2,
  /** The same reaction again within this time only plays when louder, s. */
  reactionCooldown: 0.8,
} as const; // TUNING-CR

export const CROWD_TUNING = LOCAL_TUNING;

/** What happened, from the event map's point of view. */
export enum CrowdCue {
  /** team = shooter's team, strength = chance quality (on target, xG). */
  SHOT = 0,
  /** team = shooter's team, strength = closeness. */
  NEAR_MISS = 1,
  /** Post or bar; team = team that struck the ball. */
  WOODWORK = 2,
  /** team = keeper's team, strength = shot speed. */
  SAVE = 3,
  /** team = scoring team. */
  GOAL = 4,
  /** team = offender's team, strength = severity. */
  FOUL = 5,
  /** team = carded player's team, strength 0.5 yellow / 1 red. */
  CARD = 6,
  OFFSIDE = 7,
  /** team = substituting team. */
  SUBSTITUTION = 8,
  /** Shoot-out kick missed; team = kicking team. */
  SHOOTOUT_MISS = 9,
  HALF_TIME = 10,
  FULL_TIME = 11,
}

/** Pre-rendered reaction samples. */
export enum Reaction {
  NONE = -1,
  OOH = 0,
  GROAN = 1,
  CHEER = 2,
  APPLAUSE = 3,
  MURMUR = 4,
  BOO = 5,
}

export const REACTION_COUNT = 6;

export interface ReactionCue {
  reaction: Reaction;
  gain: number;
  rate: number;
  /** Intensity boost added to the bed (decays). */
  boost: number;
}

export interface BedLevels {
  murmur: number;
  roar: number;
  roarCutoff: number;
}

export interface CrowdStats {
  /** Reactions started, per Reaction. */
  readonly reactions: Int32Array;
  /** Reactions skipped by the cooldown. */
  skipped: number;
  /** Times the bed loops were started. */
  bedStarts: number;
}

export interface CrowdModule extends AudioModule {
  /** A crowd reaction to something that happened (called by the event map). strength 0..1. */
  cue(cue: CrowdCue, team: number, strength: number): void;
  /** EventType.ATTACK_BUILD: build-up in the final third (team attacking, intensity 0..1). */
  attackBuild(team: number, intensity: number): void;
  /** Smoothed crowd intensity 0..1. */
  readonly intensity: number;
  /** Latest intensity target 0..1. */
  readonly target: number;
  /** The bed loops are playing. */
  readonly bedRunning: boolean;
  /** Team the crowd supports (0/1). */
  readonly perspective: number;
  readonly stats: CrowdStats;
}

/** The side the crowd supports: the humans' side when exactly one side has humans, else the home side (0). */
export function perspectiveTeam(state: ReadonlySimState | null): number {
  if (!state) return 0;
  let home = false;
  let away = false;
  const n = state.ctrl.length < 2 ? state.ctrl.length : 2;
  for (let i = 0; i < n; i++) {
    const c = state.ctrl[i]!;
    if (c.kind !== ControllerKind.HUMAN) continue;
    if (c.side === 0) home = true;
    else if (c.side === 1) away = true;
  }
  return away && !home ? 1 : 0;
}

/** 0 outside the final third .. 1 at the goal line (either end). */
export function goalProximity(ballX: number): number {
  if (!Number.isFinite(ballX)) return 0;
  const ax = ballX < 0 ? -ballX : ballX;
  return clamp01((ax - LOCAL_TUNING.finalThirdX) / (HALF_LENGTH - LOCAL_TUNING.finalThirdX));
}

/**
 * Intensity target 0..1 (pure). attackTeam = team with (or last touching) the ball, -1 unknown; attackDir = that
 * team's attack direction (+1 attacks +x); boost = decaying extra from ATTACK_BUILD and reactions.
 */
export function crowdTarget(phase: MatchPhase, ballX: number, attackTeam: number, attackDir: number, perspective: number, boost: number): number {
  const T = LOCAL_TUNING;
  let v: number;
  switch (phase) {
    case MatchPhase.IN_PLAY: {
      const prox = goalProximity(ballX);
      let w = Math.pow(prox, T.ballExponent) * T.ballWeight;
      if (attackTeam === 0 || attackTeam === 1) {
        const attacking = (ballX > 0 ? 1 : -1) === (attackDir < 0 ? -1 : 1);
        if (!attacking) w *= T.defendingFactor;
        if (attackTeam !== perspective) w *= T.awayAttackFactor;
      }
      v = T.baseInPlay + w;
      break;
    }
    case MatchPhase.PRE_MATCH: v = T.preMatch; break;
    case MatchPhase.KICK_OFF: v = T.kickOff; break;
    case MatchPhase.THROW_IN: v = T.throwIn; break;
    case MatchPhase.GOAL_KICK: v = T.goalKick; break;
    case MatchPhase.CORNER: v = T.corner; break;
    case MatchPhase.FREE_KICK: v = T.freeKickBase + T.freeKickNearGoal * goalProximity(ballX); break;
    case MatchPhase.PENALTY: v = T.penalty; break;
    case MatchPhase.GOAL: v = T.goal; break;
    case MatchPhase.CELEBRATION: v = T.celebration; break;
    case MatchPhase.REPLAY: v = T.replay; break;
    case MatchPhase.HALF_TIME: v = T.halfTime; break;
    case MatchPhase.FULL_TIME: v = T.fullTime; break;
    case MatchPhase.EXTRA_TIME: v = T.extraTimeBreak; break;
    case MatchPhase.SHOOT_OUT: v = T.shootOut; break;
    case MatchPhase.POST_MATCH: v = T.postMatch; break;
    default: v = T.baseInPlay;
  }
  // Lulls stay lulls: boosts lift open play and set pieces, not the breaks.
  const lull = phase === MatchPhase.HALF_TIME || phase === MatchPhase.POST_MATCH || phase === MatchPhase.EXTRA_TIME;
  if (!lull && Number.isFinite(boost) && boost > 0) v += boost;
  return clamp01(v);
}

/** One smoothing step toward `target` (rise and fall time constants, s). Pure; non-finite input keeps `cur`. */
export function smoothIntensity(cur: number, target: number, dt: number, riseTc: number = LOCAL_TUNING.riseTc, fallTc: number = LOCAL_TUNING.fallTc): number {
  const c = clamp01(cur);
  if (!Number.isFinite(target) || !Number.isFinite(dt) || dt <= 0) return c;
  const tc = target > c ? riseTc : fallTc;
  const k = 1 - Math.exp(-dt / Math.max(1e-4, tc));
  return clamp01(c + (clamp01(target) - c) * k);
}

/** Bed gains and roar brightness for an intensity (pure). */
export function bedLevels(intensity: number, out: BedLevels): BedLevels {
  const T = LOCAL_TUNING;
  const i = clamp01(intensity);
  out.murmur = lerp(T.murmurMin, T.murmurMax, i);
  out.roar = T.roarMax * Math.pow(i, T.roarExponent);
  out.roarCutoff = lerp(T.roarLpMin, T.roarLpMax, i);
  return out;
}

/** Which reaction a cue gets, how loud, and the intensity boost (pure). */
export function crowdReaction(cue: CrowdCue, team: number, strength: number, perspective: number, out: ReactionCue): ReactionCue {
  const s = clamp01(strength);
  const ours = team === perspective;
  out.reaction = Reaction.NONE;
  out.gain = 0;
  out.rate = 1;
  out.boost = 0;
  switch (cue) {
    case CrowdCue.SHOT:
      out.reaction = Reaction.OOH;
      out.gain = (ours ? 0.6 : 0.38) * (0.5 + 0.5 * s);
      out.rate = 1 + 0.06 * s;
      out.boost = 0.1 + 0.25 * s;
      break;
    case CrowdCue.NEAR_MISS:
      out.reaction = ours ? Reaction.GROAN : Reaction.MURMUR;
      out.gain = ours ? 0.7 * (0.6 + 0.4 * s) : 0.35;
      out.boost = 0.2;
      break;
    case CrowdCue.WOODWORK:
      out.reaction = ours ? Reaction.GROAN : Reaction.OOH;
      out.gain = ours ? 0.85 : 0.6;
      out.boost = 0.3;
      break;
    case CrowdCue.SAVE:
      out.reaction = ours ? Reaction.APPLAUSE : Reaction.GROAN;
      out.gain = (ours ? 0.55 : 0.5) * (0.5 + 0.5 * s);
      out.boost = 0.2;
      break;
    case CrowdCue.GOAL:
      out.reaction = Reaction.CHEER;
      out.gain = ours ? 1 : 0.4;
      out.rate = ours ? 1 : 1.04;
      out.boost = ours ? 0.8 : 0.3;
      break;
    case CrowdCue.FOUL:
      // The crowd boos fouls on its own players and murmurs at its own side's fouls.
      out.reaction = ours ? Reaction.MURMUR : Reaction.BOO;
      out.gain = ours ? 0.3 : 0.4 * (0.6 + 0.4 * s);
      break;
    case CrowdCue.CARD:
      out.reaction = ours ? Reaction.BOO : Reaction.MURMUR;
      out.gain = (ours ? 0.5 : 0.45) * (0.5 + 0.5 * s);
      break;
    case CrowdCue.OFFSIDE:
      out.reaction = Reaction.MURMUR;
      out.gain = 0.25;
      break;
    case CrowdCue.SUBSTITUTION:
      out.reaction = Reaction.APPLAUSE;
      out.gain = ours ? 0.3 : 0.15;
      break;
    case CrowdCue.SHOOTOUT_MISS:
      out.reaction = ours ? Reaction.GROAN : Reaction.CHEER;
      out.gain = ours ? 0.8 : 0.6;
      out.boost = 0.2;
      break;
    case CrowdCue.HALF_TIME:
      out.reaction = Reaction.APPLAUSE;
      out.gain = 0.5;
      break;
    case CrowdCue.FULL_TIME:
      out.reaction = Reaction.APPLAUSE;
      out.gain = 0.7;
      break;
    default:
      break;
  }
  return out;
}

// ------------------------------------------------------------------ synthesis (render time only)

/** Murmur bed: babble bands with syllable-rate wandering levels plus a low rumble. */
class MurmurSource implements MonoSource {
  private readonly bands: NoiseBand[] = [];
  private readonly levels: Wander[] = [];
  private readonly rumble: NoiseBand;
  constructor(seed: number) {
    const centres = [320, 450, 610, 820, 1100];
    for (let i = 0; i < centres.length; i++) {
      this.bands.push(new NoiseBand(seed + 101 * i, FilterKind.BANDPASS, centres[i]!, 1.8));
      this.levels.push(new Wander(seed + 977 * i + 7, 0.2, 1, 0.08, 0.35, 0.03));
    }
    this.rumble = new NoiseBand(seed + 5003, FilterKind.LOWPASS, 180, 0.7);
  }
  reset(sr: number): void {
    for (let i = 0; i < this.bands.length; i++) {
      this.bands[i]!.reset(sr);
      this.levels[i]!.reset(sr);
    }
    this.rumble.reset(sr);
  }
  next(): number {
    let v = 0;
    for (let i = 0; i < this.bands.length; i++) v += this.bands[i]!.next() * this.levels[i]!.next();
    return v * 0.07 + this.rumble.next() * 0.05;
  }
}

/** Roar bed: an "ahh" from three formants with slow swells and a touch of hiss. */
class RoarSource implements MonoSource {
  private readonly f1: NoiseBand;
  private readonly f2: NoiseBand;
  private readonly f3: NoiseBand;
  private readonly hiss: NoiseBand;
  private readonly swell: Wander;
  constructor(seed: number) {
    this.f1 = new NoiseBand(seed + 11, FilterKind.BANDPASS, 700, 3);
    this.f2 = new NoiseBand(seed + 23, FilterKind.BANDPASS, 1150, 4);
    this.f3 = new NoiseBand(seed + 37, FilterKind.BANDPASS, 2500, 5);
    this.hiss = new NoiseBand(seed + 41, FilterKind.HIGHPASS, 3000, 0.7);
    this.swell = new Wander(seed + 59, 0.7, 1, 0.4, 1.2, 0.25);
  }
  reset(sr: number): void {
    this.f1.reset(sr);
    this.f2.reset(sr);
    this.f3.reset(sr);
    this.hiss.reset(sr);
    this.swell.reset(sr);
  }
  next(): number {
    const v = this.f1.next() + 0.6 * this.f2.next() + 0.3 * this.f3.next();
    return v * 0.09 * this.swell.next() + this.hiss.next() * 0.02;
  }
}

/** Shape of one crowd reaction. */
export interface CrowdVoiceSpec {
  dur: number;
  attack: number;
  hold: number;
  tau: number;
  /** Formant 1 and 2 start/end frequencies (Hz) and formant 3 (Hz). */
  f1a: number;
  f1b: number;
  f2a: number;
  f2b: number;
  f3: number;
  /** Level of the vowel part, rumble part and applause part (unit-RMS components). */
  vowel: number;
  rumble: number;
  claps: number;
  /** Claps per second and when they start, s. */
  clapRate: number;
  clapStart: number;
}

/** A crowd reaction: a vowel from formant-filtered noise (gliding formants), rumble and applause. */
class CrowdVoiceSource implements MonoSource {
  private readonly f1: NoiseBand;
  private readonly f2: NoiseBand;
  private readonly f3: NoiseBand;
  private readonly rumble: NoiseBand;
  private readonly clapNoise: NoiseBand;
  private readonly swell: Wander;
  private i = 0;
  private sr = 48000;
  private clapEnergy = 0;
  private clapDecay = 0;
  private readonly clapSeed: number;
  private clapState = 1;
  constructor(private readonly spec: CrowdVoiceSpec, seed: number) {
    this.f1 = new NoiseBand(seed + 3, FilterKind.BANDPASS, spec.f1a, 3.5);
    this.f2 = new NoiseBand(seed + 5, FilterKind.BANDPASS, spec.f2a, 5);
    this.f3 = new NoiseBand(seed + 7, FilterKind.BANDPASS, spec.f3, 6);
    this.rumble = new NoiseBand(seed + 9, FilterKind.LOWPASS, 260, 0.7);
    this.clapNoise = new NoiseBand(seed + 13, FilterKind.BANDPASS, 1800, 1.2);
    this.swell = new Wander(seed + 17, 0.75, 1, 0.1, 0.3, 0.08);
    this.clapSeed = (seed * 2654435761) >>> 0 || 1;
  }
  reset(sr: number): void {
    this.sr = sr;
    this.i = 0;
    this.f1.reset(sr);
    this.f2.reset(sr);
    this.f3.reset(sr);
    this.rumble.reset(sr);
    this.clapNoise.reset(sr);
    this.swell.reset(sr);
    this.clapEnergy = 0;
    this.clapDecay = Math.exp(-1 / (0.005 * sr));
    this.clapState = this.clapSeed;
  }
  private rand(): number {
    let x = this.clapState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.clapState = x >>> 0;
    return this.clapState / 4294967296;
  }
  next(): number {
    const sp = this.spec;
    const t = this.i / this.sr;
    if ((this.i & 31) === 0) {
      const u = t / sp.dur;
      this.f1.setFreq(lerp(sp.f1a, sp.f1b, u));
      this.f2.setFreq(lerp(sp.f2a, sp.f2b, u));
    }
    this.i++;
    const env = oneShotEnv(t, sp.attack, sp.hold, sp.tau, sp.dur);
    const vowel = (this.f1.next() + 0.6 * this.f2.next() + 0.25 * this.f3.next()) * this.swell.next();
    let v = vowel * sp.vowel + this.rumble.next() * sp.rumble;
    if (sp.claps > 0 && t >= sp.clapStart) {
      if (this.rand() < sp.clapRate / this.sr) this.clapEnergy += 0.5 + 0.5 * this.rand();
      this.clapEnergy *= this.clapDecay;
      v += this.clapNoise.next() * this.clapEnergy * sp.claps;
    }
    return v * env;
  }
}

/** Reaction shapes (index = Reaction). Levels give roughly 0.12-0.2 RMS at the peak. */
export const REACTION_SPECS: readonly CrowdVoiceSpec[] = [
  // OOH: a rising "oooOH" swell as the shot flies.
  { dur: 1.8, attack: 0.45, hold: 0.6, tau: 0.45, f1a: 360, f1b: 430, f2a: 780, f2b: 920, f3: 2300, vowel: 0.11, rumble: 0.03, claps: 0, clapRate: 0, clapStart: 0 },
  // GROAN: "aaah-ohh" falling away.
  { dur: 2, attack: 0.08, hold: 0.35, tau: 0.6, f1a: 760, f1b: 420, f2a: 1250, f2b: 800, f3: 2400, vowel: 0.11, rumble: 0.04, claps: 0, clapRate: 0, clapStart: 0 },
  // CHEER: a big "ahh" roar with applause underneath.
  { dur: 4.5, attack: 0.15, hold: 2.4, tau: 0.8, f1a: 740, f1b: 700, f2a: 1200, f2b: 1300, f3: 2600, vowel: 0.12, rumble: 0.05, claps: 0.045, clapRate: 260, clapStart: 0.6 },
  // APPLAUSE: claps with a soft vowel bed.
  { dur: 3, attack: 0.3, hold: 1.6, tau: 0.5, f1a: 600, f1b: 600, f2a: 1100, f2b: 1100, f3: 2500, vowel: 0.025, rumble: 0.02, claps: 0.06, clapRate: 360, clapStart: 0 },
  // MURMUR: a low excited murmur.
  { dur: 1.6, attack: 0.25, hold: 0.45, tau: 0.45, f1a: 460, f1b: 440, f2a: 920, f2b: 880, f3: 2200, vowel: 0.07, rumble: 0.04, claps: 0, clapRate: 0, clapStart: 0 },
  // BOO: a low "ooo".
  { dur: 2, attack: 0.2, hold: 1, tau: 0.45, f1a: 340, f1b: 300, f2a: 660, f2b: 600, f3: 2200, vowel: 0.1, rumble: 0.04, claps: 0, clapRate: 0, clapStart: 0 },
];

const REACTION_IDS = ['crowd.ooh', 'crowd.groan', 'crowd.cheer', 'crowd.applause', 'crowd.murmur', 'crowd.boo'] as const;

/** Bed loop renderers (exported for the loop-continuity tests). */
export function renderMurmurBed() {
  return loopRenderer(LOCAL_TUNING.bedFade, [new MurmurSource(1009), new MurmurSource(7919)]);
}
export function renderRoarBed() {
  return loopRenderer(LOCAL_TUNING.bedFade, [new RoarSource(3301), new RoarSource(6553)]);
}
export function renderReaction(r: Reaction) {
  const spec = REACTION_SPECS[r]!;
  return oneShotRenderer([new CrowdVoiceSource(spec, 4001 + 31 * r), new CrowdVoiceSource(spec, 9001 + 37 * r)]);
}

// ------------------------------------------------------------------ module

/** Loop sources disconnect themselves once stopped (assigned by reference: no closure). */
function disconnectSelf(this: AudioScheduledSourceNode): void {
  try {
    this.disconnect();
  } catch {
    /* already disconnected */
  }
}

function stopSource(s: AudioBufferSourceNode | null, at: number): void {
  if (!s) return;
  s.onended = disconnectSelf;
  try {
    s.stop(at);
  } catch {
    /* not started */
  }
}

function safeConnect(a: AudioNode, b: AudioNode): void {
  try {
    a.connect(b);
  } catch {
    /* fake / closed context */
  }
}

export function createCrowd(ctx: AudioCtx): CrowdModule {
  const T = LOCAL_TUNING;
  const ac = ctx.ctx;
  const svc = getAudioServices(ctx);
  const bank = svc ? svc.bank : null;
  const bedMurmur = bank ? bank.define('crowd.bed.murmur', T.bedSeconds, 2, renderMurmurBed()) : -1;
  const bedRoar = bank ? bank.define('crowd.bed.roar', T.bedSeconds, 2, renderRoarBed()) : -1;
  const reactionHandles = new Int32Array(REACTION_COUNT).fill(-1);
  if (bank) for (let r = 0; r < REACTION_COUNT; r++) reactionHandles[r] = bank.define(REACTION_IDS[r]!, REACTION_SPECS[r]!.dur, 2, renderReaction(r));

  // Persistent bed graph (created once, at unlock): murmur gain -> bus; roar -> low-pass -> roar gain -> bus.
  const murmurGain = ac.createGain();
  murmurGain.gain.value = 0;
  const roarGain = ac.createGain();
  roarGain.gain.value = 0;
  let roarFilter: BiquadFilterNode | null = null;
  if (typeof (ac as Partial<AudioContext>).createBiquadFilter === 'function') {
    try {
      roarFilter = ac.createBiquadFilter();
      roarFilter.type = 'lowpass';
      roarFilter.frequency.value = T.roarLpMin;
      roarFilter.Q.value = 0.5;
    } catch {
      roarFilter = null;
    }
  }
  if (roarFilter) safeConnect(roarFilter, roarGain);
  safeConnect(murmurGain, ctx.crowd);
  safeConnect(roarGain, ctx.crowd);

  let murmurSrc: AudioBufferSourceNode | null = null;
  let roarSrc: AudioBufferSourceNode | null = null;
  let running = false;
  let inMatch = false;
  let paused = false;
  let intensity = 0;
  let target = 0;
  let boost = 0;
  let paramClock = 0;
  let perspective = 0;
  const levels: BedLevels = { murmur: 0, roar: 0, roarCutoff: T.roarLpMin };
  const reaction: ReactionCue = { reaction: Reaction.NONE, gain: 0, rate: 1, boost: 0 };
  const lastAt = new Float64Array(REACTION_COUNT).fill(-1e9);
  const lastGain = new Float64Array(REACTION_COUNT);
  const stats: CrowdStats = { reactions: new Int32Array(REACTION_COUNT), skipped: 0, bedStarts: 0 };

  function makeLoop(buf: AudioBuffer, dest: AudioNode, offset: number): AudioBufferSourceNode | null {
    try {
      const s = ac.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.connect(dest);
      s.start(ac.currentTime, offset % Math.max(0.001, buf.duration));
      return s;
    } catch {
      return null;
    }
  }

  function stopLoops(at: number): void {
    stopSource(murmurSrc, at);
    stopSource(roarSrc, at);
    murmurSrc = null;
    roarSrc = null;
    running = false;
  }

  /** Start the loops when the match is on, the context runs and both buffers are rendered. */
  function tryStartBed(): void {
    if (running || !bank || ac.state !== 'running') return;
    const m = bank.get(bedMurmur);
    const r = bank.get(bedRoar);
    if (!m || !r) return;
    const t = ac.currentTime;
    setNow(murmurGain.gain, 0, t);
    setNow(roarGain.gain, 0, t);
    murmurSrc = makeLoop(m, murmurGain, 0);
    // A different offset so the two loops' wrap points never coincide.
    roarSrc = makeLoop(r, roarFilter ?? roarGain, T.bedSeconds * 0.5);
    running = murmurSrc !== null || roarSrc !== null;
    if (running) {
      stats.bedStarts++;
      bedLevels(intensity, levels);
      // Fade in: a glide with a time constant of a third of the fade reaches ~95% by the end.
      glide(murmurGain.gain, levels.murmur, t, T.fadeIn / 3);
      glide(roarGain.gain, levels.roar, t, T.fadeIn / 3);
      paramClock = -T.fadeIn; // leave the fade alone until it is nearly done
    }
  }

  function fadeOutBed(): void {
    if (!running) return;
    const t = ac.currentTime;
    glide(murmurGain.gain, 0, t, T.fadeOut / 4);
    glide(roarGain.gain, 0, t, T.fadeOut / 4);
    stopLoops(t + T.fadeOut);
  }

  function applyLevels(): void {
    bedLevels(intensity, levels);
    const t = ac.currentTime;
    glide(murmurGain.gain, levels.murmur, t, T.paramTc);
    glide(roarGain.gain, levels.roar, t, T.paramTc);
    if (roarFilter) glide(roarFilter.frequency, levels.roarCutoff, t, T.paramTc);
  }

  const mod: CrowdModule = {
    get intensity() {
      return intensity;
    },
    get target() {
      return target;
    },
    get bedRunning() {
      return running;
    },
    get perspective() {
      return perspective;
    },
    stats,
    cue(cue, team, strength) {
      if (paused) return;
      crowdReaction(cue, team, strength, perspective, reaction);
      const r = reaction.reaction;
      if (r === Reaction.NONE || !(reaction.gain > 0)) return;
      if (reaction.boost > 0) boost = boost + reaction.boost > 1 ? 1 : boost + reaction.boost;
      const now = ac.currentTime;
      if (now - lastAt[r]! < T.reactionCooldown && reaction.gain <= lastGain[r]!) {
        stats.skipped++;
        return;
      }
      if (!svc) return;
      const v = svc.crowd.play(bank ? bank.get(reactionHandles[r]!) : null, reaction.gain, 0, reaction.rate, reaction.gain, r);
      if (v >= 0) {
        lastAt[r] = now;
        lastGain[r] = reaction.gain;
        stats.reactions[r]!++;
      }
    },
    attackBuild(team, value) {
      void team;
      const b = T.attackBuildBoost * clamp01(value);
      if (b > boost) boost = b;
    },
    update(state, dtSec) {
      const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 0;
      if (!state || !inMatch) {
        if (running) fadeOutBed();
        target = 0;
        intensity = smoothIntensity(intensity, 0, dt);
        return;
      }
      boost *= Math.exp(-dt / T.boostTc);
      const b = state.ball;
      let team = -1;
      if (b.owner >= 0 && b.owner < state.players.length) team = state.players[b.owner]!.team;
      else if (b.lastTouchTeam === 0 || b.lastTouchTeam === 1) team = b.lastTouchTeam;
      const dir = team === 0 || team === 1 ? state.teams[team]!.dir : 1;
      target = crowdTarget(state.match.phase, b.x, team, dir, perspective, boost);
      intensity = smoothIntensity(intensity, target, dt);
      if (!running) {
        tryStartBed();
        return;
      }
      paramClock += dt;
      if (paramClock >= T.paramInterval) {
        paramClock = 0;
        applyLevels();
      }
    },
    setPaused(p) {
      paused = p;
    },
    matchStart(state) {
      inMatch = true;
      perspective = perspectiveTeam(state);
      boost = 0;
      intensity = crowdTarget(state.match.phase, state.ball.x, -1, 1, perspective, 0);
      target = intensity;
      lastAt.fill(-1e9);
      tryStartBed();
    },
    matchEnd() {
      inMatch = false;
      fadeOutBed();
    },
    dispose() {
      stopLoops(ac.currentTime);
      try {
        murmurGain.disconnect();
        roarGain.disconnect();
        roarFilter?.disconnect();
      } catch {
        /* ignore */
      }
    },
  };
  return mod;
}
