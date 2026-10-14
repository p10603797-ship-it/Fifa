/**
 * [GFX-02] Dynamic resolution and quality tiers (BRIEF section 13), Low Power Mode detector (section 3).
 *
 * Tiers
 * - settings.graphics.tier: AUTO, PERFORMANCE, BALANCED or QUALITY. getTierParams() is the table other modules read
 *   (shadow map, multisampling, crowd density, net detail, effects budget, anisotropy). QUALITY adds one shadow map
 *   and multisampling; the default tiers have neither (section 13 "Cheap shading").
 * - AUTO: a startup test during the loading screen (warmUp, once per page) renders the match scene off screen: two
 *   unmeasured warm-up draws (shader link, uploads), then up to LOCAL_TUNING.testDurationMs = 2 s of measured draws,
 *   each with a GPU readback, and picks PERFORMANCE / BALANCED / QUALITY from the median frame cost. Until it has run
 *   AUTO means BALANCED. Later matches reuse the result.
 * - Then it adapts: a tier that cannot hold 50 fps (smoothed interval > 20 ms for 2 s) steps down at once. QUALITY
 *   always may step down (also when the player chose it); AUTO also steps BALANCED -> PERFORMANCE once the resolution
 *   is at its floor. AUTO earns a step up with 10 s of headroom at full resolution, never into a tier that already
 *   failed in this page session; the step up is applied on the next loading screen (warmUp, then compiled), because
 *   a higher tier compiles shader variants and rebuilds detail, which would hitch play. An explicit PERFORMANCE or
 *   BALANCED is never changed.
 * - Tier changes the module makes on its own go out through QualityHooks.setTier (index.ts broadcasts them to the
 *   modules' setQuality, see CR in the GFX-02 report); request() returns the resolved tier as before. ctx.tier and
 *   getTierParams() always hold the applied tier. The module also owns renderer.shadowMap.enabled (on at QUALITY);
 *   flipping it marks every scene material for a program rebuild (three.js does not notice the flag by itself).
 *
 * Dynamic resolution (settings.graphics.resolutionScale = 0)
 * - Two smoothed signals (time-based EMA, tau LOCAL_TUNING.smoothTauMs): the rAF interval (FrameInfo.dtMs) and the
 *   CPU frame work, measured from the frame's rAF timestamp to the end of renderer.render (scene.onAfterRender), so
 *   sim + scene update + draw submission.
 * - Slow = interval or work above T_PERF.resDownMs; headroom = interval at the display refresh (no missed vsyncs)
 *   and work below T_PERF.resUpMs (a 60 Hz display never shows an interval below 16.7 ms, so headroom is read
 *   from the work). Between the two nothing changes (hysteresis).
 * - Steps of 0.05 between T_PERF.resScaleMin and resScaleMax (0.6..1.0) on an exact grid, starting at
 *   T_PERF.resScaleInitial (0.75). Down after 0.5 s slow, up after 2 s of headroom, at most one change per second.
 * - No oscillation: an up-step that is followed by a step down within 4 s is a failed probe; it is reverted at once
 *   and further up-steps wait 8 s, doubling per failure (cap 120 s).
 * - The first 1.5 s of each match are observed only (loading hitches). Paused frames and the first frame are
 *   ignored; every interval is clamped to 50 ms before smoothing (a single hitch or hidden-page return moves the
 *   signal a little; a device below 20 fps still reads as slow).
 * - A fixed settings scale (0.6..1.0) is applied as is and the controller stays off. Switching back to automatic
 *   restarts at T_PERF.resScaleInitial. Always read from ctx.settings when request() runs (index.ts replaces
 *   ctx.settings on every settings change and calls request() again when the tier or the fixed scale changes).
 * - The DOM HUD is not touched (native resolution); the scale reaches the canvas through QualityHooks.setScale.
 *
 * Low Power Mode (section 3): a steady ~33 ms interval (low jitter) while the frame work is idle and the resolution
 * is already as low as it goes, for 3 s, fires once: QualityHooks.lowPowerSuspected and onLowPowerSuspected()
 * listeners, unless settings.lowPowerHintShown is already set. The caller shows the hint and sets the flag. It also
 * forgets the AUTO tier failures (the cap made every tier look slow), so AUTO can climb back once the mode is off.
 *
 * Debug: window.__dotkickQuality() returns a QualitySnapshot (tier, scale, signals, startup test, params).
 * No allocation per frame: update() and the onAfterRender hook only touch preallocated state.
 */

import { WebGLRenderTarget, type Material, type Object3D, type Scene, type WebGLRenderer } from 'three';
import { QualityTier } from '../contracts/enums';
import { T_PERF } from '../contracts/tuning';
import type { RenderContext, RenderFrame, RenderModule } from './types';

const LOCAL_TUNING = { // TUNING-CR
  /** Time constant of the frame-interval / frame-work EMAs, ms. */
  smoothTauMs: 250,
  /** Interval and work samples are clamped to this before smoothing (one hitch moves the signal only a little), ms. */
  sampleClampMs: 50,
  /** Accepted samples before any decision. */
  minSamples: 12,
  /** Play time observed without decisions after a match starts or the fixed scale is released, ms. */
  startGraceMs: 1500,
  /** The interval counts as vsync-locked (no missed frames) up to T_PERF.targetFrameMs + this, ms. */
  vsyncToleranceMs: 1,
  /** Dynamic resolution step (fraction of device pixels). */
  resStep: 0.05,
  /** Slow must hold this long before a step down, ms. */
  resDownHoldMs: 500,
  /** Headroom must hold this long before a step up, ms. */
  resUpHoldMs: 2000,
  /** Minimum time between two resolution changes (reverting a failed probe is exempt), ms. */
  resCooldownMs: 1000,
  /** A step down within this time of a step up marks the up-step as a failed probe, ms. */
  probeWindowMs: 4000,
  /** A failed probe is reverted after only this much slow, without waiting for the cooldown, ms. */
  probeRevertHoldMs: 250,
  /**
   * A level the controller had to step down from is not re-entered for this long; doubles each time that level
   * fails again, up to the cap, ms.
   */
  levelBackoffMs: 8000,
  levelBackoffMaxMs: 240000,
  /** Every this long each level forgets one failure, ms. */
  failDecayMs: 300000,
  /** A tier holds 50 fps while the smoothed interval stays at or below this, ms (1000 / 50). */
  tierHoldFrameMs: 20,
  /** Below 50 fps this long -> the tier steps down, ms. */
  tierDownHoldMs: 2000,
  /** AUTO only: headroom at full resolution this long -> the tier steps up, ms. */
  tierUpHoldMs: 10000,
  /** Minimum time between two tier changes, ms. */
  tierCooldownMs: 3000,
  /**
   * Startup test: unmeasured warm-up renders first (shader link, uploads: at most testWarmupFrames or until
   * testWarmupMaxMs), then the measured phase: wall-clock cap (ms), most frames, fewest frames for a verdict.
   */
  testWarmupFrames: 2,
  testWarmupMaxMs: 1500,
  testDurationMs: 2000,
  testMaxSamples: 60,
  testMinSamples: 5,
  /** Startup test median frame cost (render + GPU readback) at or below which QUALITY / BALANCED is picked, ms. */
  testQualityMaxMs: 5,
  testBalancedMaxMs: 11,
  /** Low Power Mode: smoothed interval band of a 30 fps cap (ms), max jitter (ms), max idle work (ms), hold (ms). */
  lowPowerMinMs: 30,
  lowPowerMaxMs: 36.5,
  lowPowerJitterMs: 2.5,
  lowPowerIdleWorkMs: 10,
  lowPowerHoldMs: 3000,
  /** The rAF timestamp is taken as the frame start when update() runs at most this long after it, ms. */
  workLeadMaxMs: 50,
} as const;
export const QUALITY_TUNING = LOCAL_TUNING;

declare global {
  interface Window {
    /** Quality / dynamic resolution state (diagnostics, benchmark, e2e). Set by createQuality. */
    __dotkickQuality?: () => QualitySnapshot;
  }
}

// ============================================================ tier parameters

/** What a resolved tier turns on. Modules read it in setQuality(tier) via getTierParams(tier). */
export interface TierParams {
  readonly tier: QualityTier;
  /** One real-time shadow map (the stadium's directional light, GFX-05). QUALITY only (section 13). */
  readonly shadowMap: boolean;
  /** Shadow map side, px (0 when off). */
  readonly shadowMapSize: number;
  /** Multisample anti-aliasing. QUALITY only; a context-creation attribute (see GFX-02 report CR). */
  readonly msaa: boolean;
  /** MSAA sample count (0 when off). */
  readonly msaaSamples: number;
  /** Fraction of crowd seats drawn, 0..1 (GFX-06). */
  readonly crowdDensity: number;
  /** Crowd idle motion / reactions animated (GFX-06). */
  readonly crowdAnimation: boolean;
  /** Goal net detail (GFX-04): 0 coarse grid, 1 medium, 2 full ripple grid. */
  readonly netDetail: number;
  /** Particle / effect budget multiplier, 0..1 (GFX-16). */
  readonly effectsScale: number;
  /** Texture anisotropy, capped by the GPU (GFX-03 uses the same values). */
  readonly anisotropy: number;
}

function freezeParams(p: TierParams): Readonly<TierParams> {
  return Object.freeze(p);
}

/** Parameters per resolved tier (index = QualityTier; AUTO maps to the BALANCED entry). */
export const TIER_PARAMS: readonly Readonly<TierParams>[] = Object.freeze([
  freezeParams({
    tier: QualityTier.BALANCED, shadowMap: false, shadowMapSize: 0, msaa: false, msaaSamples: 0,
    crowdDensity: 0.75, crowdAnimation: true, netDetail: 1, effectsScale: 0.75, anisotropy: 4,
  }),
  freezeParams({
    tier: QualityTier.PERFORMANCE, shadowMap: false, shadowMapSize: 0, msaa: false, msaaSamples: 0,
    crowdDensity: 0.5, crowdAnimation: false, netDetail: 0, effectsScale: 0.5, anisotropy: 1,
  }),
  freezeParams({
    tier: QualityTier.BALANCED, shadowMap: false, shadowMapSize: 0, msaa: false, msaaSamples: 0,
    crowdDensity: 0.75, crowdAnimation: true, netDetail: 1, effectsScale: 0.75, anisotropy: 4,
  }),
  freezeParams({
    tier: QualityTier.QUALITY, shadowMap: true, shadowMapSize: 1024, msaa: true, msaaSamples: 4,
    crowdDensity: 1, crowdAnimation: true, netDetail: 2, effectsScale: 1, anisotropy: 8,
  }),
]);

let markCount = 0;
function markObjectMaterials(o: Object3D): void {
  const m = (o as Object3D & { material?: Material | Material[] | null }).material;
  if (!m) return;
  if (Array.isArray(m)) {
    for (let i = 0; i < m.length; i++) {
      m[i]!.needsUpdate = true;
      markCount++;
    }
  } else {
    m.needsUpdate = true;
    markCount++;
  }
}

/**
 * Mark every material under `root` for a program rebuild; returns how many were marked. three.js builds programs
 * with or without shadow sampling from renderer.shadowMap.enabled, but it does not notice when that flag flips (only
 * a change of the lights' castShadow does). So a tier change that turns the shadow map on or off calls this. Without
 * it, materials keep sampling a shadow map that is no longer updated, or never sample the new one. Not per frame.
 */
export function markMaterialsForRecompile(root: Object3D): number {
  markCount = 0;
  root.traverse(markObjectMaterials);
  return markCount;
}

/** A valid concrete tier, or AUTO for anything else (corrupt settings, out-of-range numbers). Pure. */
export function sanitizeTier(t: number): QualityTier {
  return t === QualityTier.PERFORMANCE || t === QualityTier.BALANCED || t === QualityTier.QUALITY ? t : QualityTier.AUTO;
}

// ============================================================ page-session state (one GameRenderer per page)

/** Result of the AUTO startup test. */
export interface StartupTestResult {
  /** Frames measured (including the dropped warm-up frames). */
  samples: number;
  /** Frames used for the median. */
  kept: number;
  /** Median frame cost (render + GPU readback), ms (0 when nothing was measured). */
  medianMs: number;
  /** Tier the test points to (BALANCED when inconclusive). */
  tier: QualityTier;
  /** False when too few frames were measured, the test was aborted or failed. */
  conclusive: boolean;
  aborted: boolean;
  /** Wall-clock duration of the warm-up renders, ms. */
  warmupMs: number;
  /** Wall-clock duration of the whole test (warm-up + measured phase), ms. */
  elapsedMs: number;
}

interface AutoSession {
  /** A conclusive startup test ran in this page session. */
  tested: boolean;
  /** Current AUTO tier (test pick, then adapted). */
  tier: QualityTier;
  /** Bit (1 << tier) per tier AUTO stepped down from: never re-entered automatically. */
  failedMask: number;
  /**
   * Higher tier AUTO earned during play (headroom at full resolution), applied on the next loading screen (warmUp)
   * so its shader compiles never hitch a match. AUTO (0) = none.
   */
  pendingUp: QualityTier;
  test: StartupTestResult | null;
}

const autoSession: AutoSession = {
  tested: false, tier: QualityTier.BALANCED, failedMask: 0, pendingUp: QualityTier.AUTO, test: null,
};
/** tierAdapterStep mask that blocks every step up (a step up is already waiting for the loading screen). */
const ALL_TIERS_MASK = (1 << QualityTier.PERFORMANCE) | (1 << QualityTier.BALANCED) | (1 << QualityTier.QUALITY);
/** Tier applied by the live quality module (getTierParams() default). */
let appliedTier: QualityTier = QualityTier.BALANCED;
const lowPowerListeners: (() => void)[] = [];

/** Tests only: forget the startup test, the AUTO tier and its failures (a fresh page). */
export function resetQualitySession(): void {
  autoSession.tested = false;
  autoSession.tier = QualityTier.BALANCED;
  autoSession.failedMask = 0;
  autoSession.pendingUp = QualityTier.AUTO;
  autoSession.test = null;
  appliedTier = QualityTier.BALANCED;
}

/** Current AUTO state (read-only view for diagnostics and tests). */
export function autoTierState(): Readonly<AutoSession> {
  return autoSession;
}

/**
 * Parameters of `tier`, or of the tier the live quality module applied when omitted. No allocation (shared frozen
 * objects). AUTO and invalid values resolve to the current AUTO tier.
 */
export function getTierParams(tier: QualityTier = appliedTier): Readonly<TierParams> {
  return TIER_PARAMS[resolveTier(tier)]!;
}

/** Resolve a requested tier to a concrete one: AUTO (or an invalid value) -> the AUTO tier (BALANCED until tested). */
export function resolveTier(requested: QualityTier): QualityTier {
  const t = sanitizeTier(requested);
  return t === QualityTier.AUTO ? autoSession.tier : t;
}

/**
 * Subscribe to the one-time Low Power Mode suspicion (any quality module of this page). Returns an unsubscribe
 * function. Listeners run once, when the detector fires and settings.lowPowerHintShown is not set yet.
 */
export function onLowPowerSuspected(fn: () => void): () => void {
  lowPowerListeners.push(fn);
  return () => {
    const i = lowPowerListeners.indexOf(fn);
    if (i >= 0) lowPowerListeners.splice(i, 1);
  };
}

// ============================================================ scale helpers

const STEPS_PER_UNIT = Math.round(1 / LOCAL_TUNING.resStep);
const MIN_STEPS = Math.ceil(T_PERF.resScaleMin * STEPS_PER_UNIT - 1e-9);
const MAX_STEPS = Math.floor(T_PERF.resScaleMax * STEPS_PER_UNIT + 1e-9);

function clampScaleValue(s: number): number {
  return Math.max(T_PERF.resScaleMin, Math.min(T_PERF.resScaleMax, s));
}

/** Fixed scale from the settings value (0 = automatic / invalid). Pure. */
export function fixedScaleOf(setting: number): number {
  return setting > 0 ? clampScaleValue(setting) : 0;
}

/** Initial 3D resolution scale from settings (0 = automatic -> T_PERF.resScaleInitial). Pure. */
export function initialScale(fixedSetting: number): number {
  const f = fixedScaleOf(fixedSetting);
  return f > 0 ? f : T_PERF.resScaleInitial;
}

/** Grid steps of a dynamic scale (scale = steps / STEPS_PER_UNIT), clamped to the range. Pure. */
export function scaleToSteps(scale: number): number {
  const s = Number.isFinite(scale) ? Math.round(scale * STEPS_PER_UNIT) : Math.round(T_PERF.resScaleInitial * STEPS_PER_UNIT);
  return s < MIN_STEPS ? MIN_STEPS : s > MAX_STEPS ? MAX_STEPS : s;
}

// ============================================================ frame signal

/** Smoothed frame-time signals. */
export interface FrameSignal {
  /** Smoothed rAF interval, ms (0 before the first sample). */
  intervalMs: number;
  /** Smoothed absolute deviation of the interval from its mean, ms. */
  jitterMs: number;
  /** Smoothed CPU frame work, ms; -1 until a work sample arrived. */
  workMs: number;
  /** Accepted samples. */
  samples: number;
  /** Samples that carried a work measurement. */
  workSamples: number;
  /** Elapsed time the last pushed sample stands for (clamped interval), ms; 0 when it was dropped. */
  dt: number;
  /** Input of ingestFrameSample: rAF interval and frame work (negative = unknown), ms. */
  inIntervalMs: number;
  inWorkMs: number;
}

export function createFrameSignal(): FrameSignal {
  // Double fields from the start (0.5 / -0.5 placeholders reset below): V8 keeps them unboxed-in-place, so the
  // per-frame writes never allocate.
  const s: FrameSignal = {
    intervalMs: 0.5, jitterMs: 0.5, workMs: -0.5, samples: 0, workSamples: 0, dt: 0.5, inIntervalMs: 0.5, inWorkMs: -0.5,
  };
  resetFrameSignal(s);
  return s;
}

export function resetFrameSignal(s: FrameSignal): void {
  s.intervalMs = 0;
  s.jitterMs = 0;
  s.workMs = -1;
  s.samples = 0;
  s.workSamples = 0;
  s.dt = 0;
}

/**
 * Add one frame from s.inIntervalMs (rAF interval) and s.inWorkMs (CPU work of the frame before it; negative / NaN
 * = unknown). Intervals <= 0 (first frame of the loop) are dropped; long ones (a hidden-page return at the
 * MAX_FRAME_MS clamp, a stall, a device below 20 fps) count as sampleClampMs, so a single one is a bounded hitch
 * while a slow device still reads as slow. Sets s.dt
 * to the elapsed time the sample stands for (clamped interval, ms; 0 when dropped) and returns whether it was
 * accepted. No allocation (doubles stay in fields, never cross a call boundary).
 */
export function ingestFrameSample(s: FrameSignal): boolean {
  const intervalMs = s.inIntervalMs;
  if (!(intervalMs > 0)) {
    s.dt = 0;
    return false;
  }
  const clampMs = LOCAL_TUNING.sampleClampMs;
  const dt = intervalMs > clampMs ? clampMs : intervalMs;
  // Every frame weighs the same (the mean interval is 1000 / fps; weighting by the frame's own length would count
  // a missed frame twice), with the time constant in wall time: alpha from the smoothed interval, so 60 Hz and
  // 120 Hz forget at the same rate. The first samples average (1 / n): a hitchy first frame does not dominate.
  const ref = s.samples > 0 ? s.intervalMs : dt;
  const ta = 1 - Math.exp(-ref / LOCAL_TUNING.smoothTauMs);
  const a = s.samples > 0 && 1 / (s.samples + 1) > ta ? 1 / (s.samples + 1) : ta;
  if (s.samples === 0) {
    s.intervalMs = dt;
    s.jitterMs = 0;
  } else {
    const dev = dt > s.intervalMs ? dt - s.intervalMs : s.intervalMs - dt;
    s.jitterMs += (dev - s.jitterMs) * a;
    s.intervalMs += (dt - s.intervalMs) * a;
  }
  const workMs = s.inWorkMs;
  if (workMs >= 0) {
    const w = workMs > clampMs ? clampMs : workMs;
    s.workSamples++;
    const wa = 1 / s.workSamples > ta ? 1 / s.workSamples : ta;
    s.workMs = s.workMs < 0 ? w : s.workMs + (w - s.workMs) * wa;
  }
  s.samples++;
  s.dt = dt;
  return true;
}

/** ingestFrameSample with explicit values (tools and tests). Returns s.dt (0 when the sample was dropped). */
export function pushFrameSample(s: FrameSignal, intervalMs: number, workMs: number): number {
  s.inIntervalMs = intervalMs;
  s.inWorkMs = workMs;
  ingestFrameSample(s);
  return s.dt;
}

/** Over budget: missed frames or CPU work beyond the down threshold. Pure. */
export function signalSlow(s: FrameSignal): boolean {
  return s.intervalMs > T_PERF.resDownMs || s.workMs > T_PERF.resDownMs;
}

/**
 * Headroom: no missed vsyncs (interval at the target refresh or faster) and CPU work below the up threshold. Without
 * a work measurement only a high-refresh display (interval < resUpMs) shows headroom. Pure.
 */
export function signalHeadroom(s: FrameSignal): boolean {
  if (s.intervalMs > T_PERF.targetFrameMs + LOCAL_TUNING.vsyncToleranceMs) return false;
  return s.workMs >= 0 ? s.workMs < T_PERF.resUpMs : s.intervalMs < T_PERF.resUpMs;
}

// ============================================================ dynamic resolution controller

export interface ResController {
  /** Dynamic scale in grid steps (scale = steps / STEPS_PER_UNIT). */
  steps: number;
  /** Fixed scale from settings (0 = dynamic: the controller acts). */
  fixed: number;
  /** Elapsed play time (sum of accepted samples), ms. */
  t: number;
  /** No decisions before this time, ms. */
  quietUntil: number;
  downHold: number;
  upHold: number;
  lastChangeT: number;
  /** Direction of the last change: +1 up, -1 down, 0 none (or settled after a configuration change). */
  lastDir: number;
  /** Per level (index = steps): step-downs from that level (decaying), and until when up-steps into it wait. */
  fails: Uint8Array;
  blockedUntil: Float64Array;
  /** Next failure decay, ms. */
  decayAt: number;
  /** Counters for diagnostics and tests. */
  changes: number;
  failedProbes: number;
}

export function createResController(initial: number = T_PERF.resScaleInitial, fixed = 0): ResController {
  return {
    steps: scaleToSteps(initial), fixed: fixedScaleOf(fixed), t: 0, quietUntil: 0, downHold: 0, upHold: 0,
    lastChangeT: -1e12, lastDir: 0, fails: new Uint8Array(MAX_STEPS + 2), blockedUntil: new Float64Array(MAX_STEPS + 2),
    decayAt: LOCAL_TUNING.failDecayMs, changes: 0, failedProbes: 0,
  };
}

/** Current scale of the controller (fixed or dynamic). Pure. */
export function resScale(c: ResController): number {
  return c.fixed > 0 ? c.fixed : c.steps / STEPS_PER_UNIT;
}

/** Dynamic scale at its floor, or a fixed scale (nothing more the controller can lower). */
export function resAtFloor(c: ResController): boolean {
  return c.fixed > 0 || c.steps <= MIN_STEPS;
}

/** Dynamic scale at its ceiling, or a fixed scale. */
export function resAtCeiling(c: ResController): boolean {
  return c.fixed > 0 || c.steps >= MAX_STEPS;
}

/** Observe only for `ms` of play (match start, configuration change). Holds restart. */
export function resQuiet(c: ResController, ms: number): void {
  c.quietUntil = c.t + ms;
  c.downHold = 0;
  c.upHold = 0;
}

/** Something changed the frame cost (tier, window size): holds restart and a cooldown begins. */
export function resSettle(c: ResController): void {
  c.downHold = 0;
  c.upHold = 0;
  c.lastChangeT = c.t;
  c.lastDir = 0;
}

/** Forget every level failure (new conditions: tier or window changed). */
export function resForgetFailures(c: ResController): void {
  c.fails.fill(0);
  c.blockedUntil.fill(0);
}

/**
 * Advance the controller by the signal's last accepted sample (s.dt ms). Returns -1 (stepped down), +1 (up) or 0.
 * No allocation.
 * - Down after resDownHoldMs of slow, at most one change per resCooldownMs; a step up that turns slow within
 *   probeWindowMs (a failed probe) is reverted after probeRevertHoldMs, cooldown or not.
 * - Each step down from a level blocks up-steps into that level for levelBackoffMs, doubling per failure of that
 *   level (cap levelBackoffMaxMs; one failure forgotten per failDecayMs): repeated probes of a level that cannot
 *   hold get exponentially rarer, so the scale never oscillates.
 * - Up after resUpHoldMs of headroom, cooldown and level block permitting.
 */
export function resControllerStep(c: ResController, s: FrameSignal): number {
  const T = LOCAL_TUNING;
  const dt = s.dt;
  if (!(dt > 0)) return 0;
  c.t += dt;
  if (c.t >= c.decayAt) {
    c.decayAt = c.t + T.failDecayMs;
    for (let i = MIN_STEPS; i <= MAX_STEPS; i++) if (c.fails[i]! > 0) c.fails[i]!--;
  }
  if (c.fixed > 0 || c.t < c.quietUntil || s.samples < T.minSamples) {
    c.downHold = 0;
    c.upHold = 0;
    return 0;
  }
  const slow = signalSlow(s);
  const fast = !slow && signalHeadroom(s);
  c.downHold = slow && c.steps > MIN_STEPS ? c.downHold + dt : 0;
  c.upHold = fast && c.steps < MAX_STEPS && c.t >= c.blockedUntil[c.steps + 1]! ? c.upHold + dt : 0;
  const since = c.t - c.lastChangeT;
  const probing = c.lastDir > 0 && since <= T.probeWindowMs;
  const cooled = since >= T.resCooldownMs;
  if ((probing && c.downHold >= T.probeRevertHoldMs) || (cooled && c.downHold >= T.resDownHoldMs)) {
    const from = c.steps;
    const n = c.fails[from]! < 16 ? c.fails[from]! + 1 : 16;
    c.fails[from] = n;
    let backoff = T.levelBackoffMs;
    for (let i = 1; i < n && backoff < T.levelBackoffMaxMs; i++) backoff *= 2;
    c.blockedUntil[from] = c.t + (backoff < T.levelBackoffMaxMs ? backoff : T.levelBackoffMaxMs);
    if (probing) c.failedProbes++;
    c.steps--;
    c.lastDir = -1;
    c.lastChangeT = c.t;
    c.downHold = 0;
    c.upHold = 0;
    c.changes++;
    return -1;
  }
  if (cooled && c.upHold >= T.resUpHoldMs) {
    c.steps++;
    c.lastDir = 1;
    c.lastChangeT = c.t;
    c.downHold = 0;
    c.upHold = 0;
    c.changes++;
    return 1;
  }
  return 0;
}

// ============================================================ tier adaptation

export interface TierAdapter {
  t: number;
  quietUntil: number;
  downHold: number;
  upHold: number;
  lastChangeT: number;
  changes: number;
}

export function createTierAdapter(): TierAdapter {
  return { t: 0, quietUntil: 0, downHold: 0, upHold: 0, lastChangeT: -1e12, changes: 0 };
}

export function tierQuiet(a: TierAdapter, ms: number): void {
  a.quietUntil = a.t + ms;
  a.downHold = 0;
  a.upHold = 0;
}

/**
 * Advance the tier adaptation by the signal's last accepted sample (s.dt). `tier` is the applied tier, `requested` the
 * settings tier, `failedMask` the tiers AUTO must not step up into (bit 1 << tier: the ones that already failed; the
 * module passes every bit while a step up waits for the loading screen). Returns the tier the adaptation wants
 * (unchanged most of the time); the module applies a step down at once and defers a step up to the next warmUp.
 * - QUALITY (requested or AUTO) steps down when it cannot hold 50 fps for tierDownHoldMs.
 * - AUTO also steps BALANCED -> PERFORMANCE when the resolution cannot go lower.
 * - AUTO steps up after tierUpHoldMs of headroom at full resolution, never into a failed tier.
 * - Explicit PERFORMANCE / BALANCED never change.
 */
export function tierAdapterStep(
  a: TierAdapter, tier: QualityTier, requested: QualityTier, failedMask: number, s: FrameSignal,
  scaleFloor: boolean, scaleCeiling: boolean,
): QualityTier {
  const dt = s.dt;
  if (!(dt > 0)) return tier;
  a.t += dt;
  if (a.t < a.quietUntil || s.samples < LOCAL_TUNING.minSamples || tier === QualityTier.AUTO) {
    a.downHold = 0;
    a.upHold = 0;
    return tier;
  }
  const auto = requested === QualityTier.AUTO;
  const canDown = tier === QualityTier.QUALITY || (auto && tier === QualityTier.BALANCED && scaleFloor);
  a.downHold = canDown && s.intervalMs > LOCAL_TUNING.tierHoldFrameMs ? a.downHold + dt : 0;
  const next = tier + 1;
  const canUp = auto && tier < QualityTier.QUALITY && (failedMask & (1 << next)) === 0 && scaleCeiling;
  a.upHold = canUp && !signalSlow(s) && signalHeadroom(s) ? a.upHold + dt : 0;
  if (a.t - a.lastChangeT < LOCAL_TUNING.tierCooldownMs) return tier;
  if (a.downHold >= LOCAL_TUNING.tierDownHoldMs) {
    a.downHold = 0;
    a.upHold = 0;
    a.lastChangeT = a.t;
    a.changes++;
    return (tier - 1) as QualityTier;
  }
  if (a.upHold >= LOCAL_TUNING.tierUpHoldMs) {
    a.downHold = 0;
    a.upHold = 0;
    a.lastChangeT = a.t;
    a.changes++;
    return next as QualityTier;
  }
  return tier;
}

// ============================================================ Low Power Mode detector

export interface LowPowerDetector {
  holdMs: number;
  fired: boolean;
}

export function createLowPowerDetector(): LowPowerDetector {
  return { holdMs: 0, fired: false };
}

/**
 * Low Power Mode caps Safari at 30 fps: a steady ~33 ms interval (low jitter) while the frame work is small and the
 * resolution is already as low as it goes (`settled`: lowering it was tried, or the scale is fixed). Returns true
 * exactly once, when the condition held for lowPowerHoldMs (advanced by the signal's last sample, s.dt). No allocation.
 */
export function lowPowerStep(d: LowPowerDetector, s: FrameSignal, settled: boolean): boolean {
  const dt = s.dt;
  if (d.fired || !(dt > 0)) return false;
  const T = LOCAL_TUNING;
  const ok = settled && s.samples >= T.minSamples && s.workMs >= 0 && s.workMs <= T.lowPowerIdleWorkMs
    && s.intervalMs >= T.lowPowerMinMs && s.intervalMs <= T.lowPowerMaxMs && s.jitterMs <= T.lowPowerJitterMs;
  d.holdMs = ok ? d.holdMs + dt : 0;
  if (d.holdMs >= T.lowPowerHoldMs) {
    d.fired = true;
    return true;
  }
  return false;
}

// ============================================================ startup test

/**
 * Pick a tier from measured startup-test frame costs (warm-up frames already excluded). `timedOut`: the wall-clock
 * cap ended the measured phase (slow device). Pure.
 */
export function pickTierFromSamples(
  samples: ArrayLike<number>, count: number, timedOut = false,
): { tier: QualityTier; medianMs: number; kept: number; conclusive: boolean } {
  const n = Math.max(0, Math.min(count, samples.length));
  const kept: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = samples[i]!;
    if (Number.isFinite(v) && v >= 0) kept.push(v);
  }
  if (kept.length === 0) return { tier: QualityTier.BALANCED, medianMs: 0, kept: 0, conclusive: false };
  kept.sort((x, y) => x - y);
  const mid = kept.length >> 1;
  const median = kept.length % 2 === 1 ? kept[mid]! : (kept[mid - 1]! + kept[mid]!) * 0.5;
  const tier = median <= LOCAL_TUNING.testQualityMaxMs ? QualityTier.QUALITY
    : median <= LOCAL_TUNING.testBalancedMaxMs ? QualityTier.BALANCED : QualityTier.PERFORMANCE;
  // Too few frames is inconclusive, unless the cap ended the test because the frames were that slow.
  const conclusive = kept.length >= LOCAL_TUNING.testMinSamples
    || (timedOut && kept.length >= 2 && tier === QualityTier.PERFORMANCE);
  return { tier: conclusive ? tier : QualityTier.BALANCED, medianMs: median, kept: kept.length, conclusive };
}

/** What the startup test needs from the renderer and the page (injected in Node tests). */
export interface StartupProbe {
  /** Render one representative frame and wait for the GPU (readback). May throw (test becomes inconclusive). */
  renderOnce(): void;
  now(): number;
  /** Wait for the next animation frame (with a timeout fallback). */
  nextFrame(): Promise<void>;
  /** True when the test must stop (page hidden, match quit, module disposed). */
  aborted(): boolean;
}

/**
 * Run the startup test: warm-up renders (not measured: the first draws link shaders and upload buffers), then one
 * measured frame per animation frame until testDurationMs of wall time or testMaxSamples frames, then pick a tier.
 * Never throws.
 */
export async function runStartupTest(probe: StartupProbe): Promise<StartupTestResult> {
  const T = LOCAL_TUNING;
  const buf = new Float64Array(T.testMaxSamples);
  let n = 0;
  let aborted = false;
  let timedOut = false;
  let failed = false;
  const t0 = probe.now();
  let tw = t0;
  try {
    for (let w = 0; w < T.testWarmupFrames; w++) {
      await probe.nextFrame();
      if (probe.aborted()) { aborted = true; break; }
      probe.renderOnce();
      if (probe.now() - t0 >= T.testWarmupMaxMs) break;
    }
    tw = probe.now();
    while (!aborted && n < T.testMaxSamples) {
      await probe.nextFrame();
      if (probe.aborted()) { aborted = true; break; }
      if (probe.now() - tw >= T.testDurationMs) { timedOut = true; break; }
      const a = probe.now();
      probe.renderOnce();
      buf[n++] = probe.now() - a;
    }
  } catch {
    failed = true;
  }
  const end = probe.now();
  const warmupMs = (aborted || failed) && tw === t0 ? end - t0 : tw - t0;
  const elapsedMs = end - t0;
  if (aborted || failed) {
    return { samples: n, kept: 0, medianMs: 0, tier: QualityTier.BALANCED, conclusive: false, aborted, warmupMs, elapsedMs };
  }
  const pick = pickTierFromSamples(buf, n, timedOut);
  return {
    samples: n, kept: pick.kept, medianMs: pick.medianMs, tier: pick.tier, conclusive: pick.conclusive, aborted: false,
    warmupMs, elapsedMs,
  };
}

// ============================================================ module

export interface QualityHooks {
  /** Apply a 3D resolution scale (GFX-01 RendererCore.setScale). */
  setScale(scale: number): void;
  /**
   * The module changed the applied tier on its own (startup test pick, step down / up). index.ts broadcasts it to
   * the other modules' setQuality. [CR index.ts] Not called for request(): its return value is broadcast instead.
   */
  setTier?(tier: QualityTier): void;
  /** Low Power Mode suspected (at most once, only while settings.lowPowerHintShown is false). */
  lowPowerSuspected?(): void;
}

/** Injected environment (Node tests). Defaults: performance.now, rAF with a 100 ms timeout, document.hidden. */
export interface QualityOptions {
  now?: () => number;
  nextFrame?: () => Promise<void>;
  hidden?: () => boolean;
}

/** Debug view of the module (window.__dotkickQuality). */
export interface QualitySnapshot {
  requested: QualityTier;
  tier: QualityTier;
  scale: number;
  /** Fixed settings scale (0 = dynamic). */
  fixedScale: number;
  intervalMs: number;
  workMs: number;
  jitterMs: number;
  fps: number;
  samples: number;
  scaleChanges: number;
  failedProbes: number;
  tierChanges: number;
  autoFailedMask: number;
  /** Higher tier AUTO earned during play, applied on the next loading screen (AUTO = none). */
  pendingTier: QualityTier;
  lowPowerSuspected: boolean;
  startupTest: StartupTestResult | null;
  testRunning: boolean;
  shadowMapEnabled: boolean;
  params: Readonly<TierParams>;
}

export interface QualityModule extends RenderModule {
  /** Resolved tier (never AUTO). */
  readonly tier: QualityTier;
  /** Current 3D resolution scale. */
  readonly scale: number;
  /** Tier requested by the settings (may be AUTO). */
  readonly requested: QualityTier;
  /** Parameters of the applied tier. */
  readonly params: Readonly<TierParams>;
  /** Low Power Mode detector fired. */
  readonly lowPowerSuspected: boolean;
  /** Last startup test of this page (null before one ran). */
  readonly startupTest: StartupTestResult | null;
  /** Requested tier from settings; returns the resolved tier to broadcast to the other modules. */
  request(tier: QualityTier): QualityTier;
  /** Debug snapshot (not per frame). */
  snapshot(): QualitySnapshot;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function defaultNextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 100);
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish);
  });
}

function defaultHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

type AfterRenderFn = Object3D['onAfterRender'];
type ChainFn = (this: unknown, a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, g: unknown) => void;

export function createQuality(ctx: RenderContext, hooks: QualityHooks, opts: QualityOptions = {}): QualityModule {
  const now = opts.now ?? defaultNow;
  const nextFrame = opts.nextFrame ?? defaultNextFrame;
  const hidden = opts.hidden ?? defaultHidden;

  let requested = sanitizeTier(ctx.settings.graphics.tier);
  let tier = resolveTier(requested);
  const sig = createFrameSignal();
  const res = createResController(T_PERF.resScaleInitial, ctx.settings.graphics.resolutionScale);
  const adapt = createTierAdapter();
  const lowPower = createLowPowerDetector();
  let scale = resScale(res);
  let disposed = false;
  let testRunning = false;
  let abortTest = false;
  let lastTest: StartupTestResult | null = autoSession.test;
  let lastCssW = ctx.size.cssW, lastCssH = ctx.size.cssH, lastDpr = ctx.size.dpr;

  // CPU frame work: from the frame start (rAF timestamp, or update() entry) to the end of renderer.render.
  // Doubles live in a typed array (closure variables holding doubles would box on every write).
  let frameOpen = false;
  let workValid = false;
  const FW_START = 0, FW_WORK = 1;
  const fw = new Float64Array(2);

  function applyTier(t: QualityTier): void {
    ctx.tier = t;
    appliedTier = t;
    const r = ctx.renderer as WebGLRenderer | null;
    const on = TIER_PARAMS[t]!.shadowMap;
    if (r && r.shadowMap && r.shadowMap.enabled !== on) {
      r.shadowMap.enabled = on;
      markMaterialsForRecompile(ctx.scene);
    }
  }

  function applyScale(): void {
    const s = resScale(res);
    if (s === scale) return;
    scale = s;
    hooks.setScale(s);
  }

  /**
   * The module changes the tier on its own (not through request()). `failed`: the old tier could not hold 50 fps
   * (AUTO never re-enters it); false for the startup test's pick.
   */
  function changeTier(next: QualityTier, failed: boolean): void {
    if (next === tier) return;
    if (requested === QualityTier.AUTO) {
      if (failed) autoSession.failedMask |= 1 << tier;
      autoSession.tier = next;
      autoSession.pendingUp = QualityTier.AUTO; // a step down or a new pick supersedes an earned step up
    }
    tier = next;
    applyTier(tier);
    resSettle(res);
    resForgetFailures(res); // level failures were measured with the other tier's cost
    hooks.setTier?.(tier);
  }

  function fireLowPower(): void {
    if (ctx.settings.lowPowerHintShown) return;
    // Once per page, so the copy is fine; a listener that throws must not break the frame or the other listeners.
    const list = lowPowerListeners.slice();
    if (hooks.lowPowerSuspected) list.unshift(hooks.lowPowerSuspected);
    for (let i = 0; i < list.length; i++) {
      try {
        list[i]!();
      } catch (err) {
        console.error('[quality] low power listener failed', err);
      }
    }
  }

  /** One frame from sig.inIntervalMs / sig.inWorkMs. */
  function ingest(): void {
    if (!ingestFrameSample(sig)) return;
    if (resControllerStep(res, sig) !== 0) applyScale();
    const upMask = autoSession.pendingUp !== QualityTier.AUTO ? ALL_TIERS_MASK : autoSession.failedMask;
    const nt = tierAdapterStep(adapt, tier, requested, upMask, sig, resAtFloor(res), resAtCeiling(res));
    // Down at once (the match cannot hold 50 fps); up only on the next loading screen: a higher tier compiles shader
    // variants and rebuilds crowd / net detail, which would hitch play.
    if (nt < tier) changeTier(nt, true);
    else if (nt > tier) autoSession.pendingUp = nt;
    if (lowPowerStep(lowPower, sig, resAtFloor(res))) {
      // A 30 fps cap makes every tier look too slow. The tiers AUTO stepped down from under it did not really fail:
      // forget them, so turning Low Power Mode off lets AUTO earn them back (a step up still needs real headroom
      // at full resolution, so a device that is truly this slow never flips).
      autoSession.failedMask = 0;
      fireLowPower();
    }
  }

  // scene.onAfterRender marks the end of the frame's draw (chained with any handler already installed).
  const scene: Scene = ctx.scene;
  let prevAfter: AfterRenderFn = scene.onAfterRender;
  const afterRender = function (this: unknown, a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, g: unknown): void {
    (prevAfter as unknown as ChainFn).call(this, a, b, c, d, e, g);
    if (!frameOpen) return;
    frameOpen = false;
    fw[FW_WORK] = now() - fw[FW_START]!;
    if (!(fw[FW_WORK]! >= 0)) fw[FW_WORK] = 0;
    workValid = true;
  } as unknown as AfterRenderFn;
  scene.onAfterRender = afterRender;

  applyTier(tier);
  hooks.setScale(scale);

  const snap: QualitySnapshot = {
    requested, tier, scale, fixedScale: res.fixed, intervalMs: 0, workMs: -1, jitterMs: 0, fps: 0, samples: 0,
    scaleChanges: 0, failedProbes: 0, tierChanges: 0, autoFailedMask: 0, pendingTier: QualityTier.AUTO,
    lowPowerSuspected: false, startupTest: null,
    testRunning: false, shadowMapEnabled: false, params: TIER_PARAMS[tier]!,
  };

  function compileScene(): void {
    const r = ctx.renderer as WebGLRenderer | null;
    if (!r || typeof r.compile !== 'function') return;
    try {
      r.compile(ctx.scene, ctx.camera); // programs for the new tier before the first frame
    } catch {
      /* compiled lazily on first use */
    }
  }

  /** Loading screen: apply the higher tier AUTO earned during play (see AutoSession.pendingUp). */
  function applyPendingUp(): void {
    const up = autoSession.pendingUp;
    if (up === QualityTier.AUTO) return;
    autoSession.pendingUp = QualityTier.AUTO;
    if (disposed || requested !== QualityTier.AUTO || up <= tier || (autoSession.failedMask & (1 << up)) !== 0) return;
    changeTier(up, false);
    compileScene();
  }

  /** The AUTO startup test (once per page; again on the next match when it was inconclusive). */
  async function startupTest(): Promise<void> {
    const r = ctx.renderer as WebGLRenderer | null;
    if (!r || typeof r.render !== 'function' || typeof r.readRenderTargetPixels !== 'function') return;
    if (hidden()) return;
    testRunning = true;
    abortTest = false;
    frameOpen = false;
    let rt: WebGLRenderTarget | null = null;
    try {
      const w = Math.max(1, Math.floor(r.domElement ? r.domElement.width : 1));
      const h = Math.max(1, Math.floor(r.domElement ? r.domElement.height : 1));
      rt = new WebGLRenderTarget(w, h, { depthBuffer: true, stencilBuffer: false });
      const target = rt;
      const pixel = new Uint8Array(4);
      const result = await runStartupTest({
        renderOnce() {
          const prev = r.getRenderTarget();
          r.setRenderTarget(target);
          try {
            r.render(ctx.scene, ctx.camera);
            r.readRenderTargetPixels(target, 0, 0, 1, 1, pixel); // waits for the GPU
          } finally {
            r.setRenderTarget(prev);
          }
        },
        now,
        nextFrame,
        aborted: () => abortTest || disposed || hidden(),
      });
      lastTest = result;
      autoSession.test = result;
      if (result.conclusive) {
        autoSession.tested = true;
        autoSession.tier = result.tier;
        autoSession.failedMask = 0;
        autoSession.pendingUp = QualityTier.AUTO;
        if (!disposed && requested === QualityTier.AUTO && result.tier !== tier) {
          changeTier(result.tier, false);
          compileScene();
        }
      }
    } catch {
      // Render target creation failed: keep the current tier, try again on the next match.
    } finally {
      rt?.dispose();
      testRunning = false;
      frameOpen = false;
    }
  }

  const mod: QualityModule = {
    get tier() { return tier; },
    get scale() { return scale; },
    get requested() { return requested; },
    get params() { return TIER_PARAMS[tier]!; },
    get lowPowerSuspected() { return lowPower.fired; },
    get startupTest() { return lastTest; },

    request(t: QualityTier): QualityTier {
      const req = sanitizeTier(t);
      if (req !== requested) {
        requested = req;
        const next = req === QualityTier.AUTO ? autoSession.tier : req;
        if (next !== tier) {
          resSettle(res);
          resForgetFailures(res);
        }
        tier = next;
        tierQuiet(adapt, 0);
      }
      applyTier(tier);
      const fixed = fixedScaleOf(ctx.settings.graphics.resolutionScale);
      if (fixed !== res.fixed) {
        const wasFixed = res.fixed > 0;
        res.fixed = fixed;
        if (fixed === 0 && wasFixed) {
          // Back to automatic: restart from the initial scale and observe before adapting.
          res.steps = scaleToSteps(T_PERF.resScaleInitial);
          res.lastDir = 0;
          resQuiet(res, LOCAL_TUNING.startGraceMs);
        }
        resSettle(res);
      }
      applyScale();
      return tier;
    },

    setMatch() {
      resetFrameSignal(sig);
      resQuiet(res, LOCAL_TUNING.startGraceMs);
      tierQuiet(adapt, LOCAL_TUNING.startGraceMs);
      lowPower.holdMs = 0;
      frameOpen = false;
      workValid = false;
      abortTest = false;
    },

    async warmUp() {
      if (disposed || testRunning || requested !== QualityTier.AUTO) return;
      if (!autoSession.tested) await startupTest();
      applyPendingUp();
    },

    update(f: RenderFrame) {
      if (scene.onAfterRender !== afterRender) {
        // Someone replaced the hook: chain theirs and take the end-of-draw mark back.
        prevAfter = scene.onAfterRender;
        scene.onAfterRender = afterRender;
      }
      const fi = f.frame;
      fw[FW_START] = now();
      if (!fi.paused) {
        sig.inIntervalMs = fi.dtMs;
        sig.inWorkMs = workValid ? fw[FW_WORK]! : -1;
        ingest();
      }
      workValid = false;
      if (fi.paused) {
        frameOpen = false;
      } else {
        // The frame started at its rAF timestamp when update() runs shortly after it (same clock), else now.
        const lead = fw[FW_START]! - fi.nowMs;
        if (lead >= 0 && lead <= LOCAL_TUNING.workLeadMaxMs) fw[FW_START] = fi.nowMs;
        frameOpen = true;
      }
    },

    resize() {
      const sz = ctx.size;
      if (sz.cssW === lastCssW && sz.cssH === lastCssH && sz.dpr === lastDpr) return; // our own scale change
      lastCssW = sz.cssW;
      lastCssH = sz.cssH;
      lastDpr = sz.dpr;
      resSettle(res); // the window changed the frame cost: fresh holds, a cooldown, failures forgotten
      resForgetFailures(res);
    },

    clearMatch() {
      abortTest = true;
      frameOpen = false;
      workValid = false;
    },

    snapshot(): QualitySnapshot {
      snap.requested = requested;
      snap.tier = tier;
      snap.scale = scale;
      snap.fixedScale = res.fixed;
      snap.intervalMs = sig.intervalMs;
      snap.workMs = sig.workMs;
      snap.jitterMs = sig.jitterMs;
      snap.fps = sig.intervalMs > 0 ? 1000 / sig.intervalMs : 0;
      snap.samples = sig.samples;
      snap.scaleChanges = res.changes;
      snap.failedProbes = res.failedProbes;
      snap.tierChanges = adapt.changes;
      snap.autoFailedMask = autoSession.failedMask;
      snap.pendingTier = autoSession.pendingUp;
      snap.lowPowerSuspected = lowPower.fired;
      snap.startupTest = lastTest;
      snap.testRunning = testRunning;
      const r = ctx.renderer as WebGLRenderer | null;
      snap.shadowMapEnabled = !!(r && r.shadowMap && r.shadowMap.enabled);
      snap.params = TIER_PARAMS[tier]!;
      return snap;
    },

    dispose() {
      disposed = true;
      abortTest = true;
      frameOpen = false;
      if (scene.onAfterRender === afterRender) scene.onAfterRender = prevAfter;
      if (typeof window !== 'undefined' && window.__dotkickQuality === debugFn) delete window.__dotkickQuality;
    },
  };

  const debugFn = (): QualitySnapshot => mod.snapshot();
  if (typeof window !== 'undefined') window.__dotkickQuality = debugFn;
  return mod;
}
