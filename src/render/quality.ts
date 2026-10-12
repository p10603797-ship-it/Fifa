/**
 * [GFX-02] Dynamic resolution and quality tiers (section 13).
 * - Auto picks Performance, Balanced or Quality from a 2-second startup test, then adapts.
 * - Dynamic resolution between T_PERF.resScaleMin and resScaleMax from a smoothed frame-time signal with
 *   hysteresis (T_PERF.resUpMs / resDownMs). The DOM HUD stays at native resolution.
 * - Quality may add one shadow map and multisampling and steps down if it cannot hold 50 fps.
 * - settings.graphics.resolutionScale: 0 = automatic (dynamic), else a fixed 0.6..1.0. Always read it from
 *   ctx.settings at the time of use: index.ts replaces ctx.settings on every settings change and calls request()
 *   again when the tier or the fixed scale changes.
 *
 * WAVE 0 STUB (FND-05): AUTO resolves to BALANCED; the scale stays at the fixed setting or
 * T_PERF.resScaleInitial. GFX-02 implements the startup test and the dynamic controller.
 */

import { QualityTier } from '../contracts/enums';
import { T_PERF } from '../contracts/tuning';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export interface QualityHooks {
  /** Apply a 3D resolution scale (GFX-01 RendererCore.setScale). */
  setScale(scale: number): void;
}

export interface QualityModule extends RenderModule {
  /** Resolved tier (never AUTO). */
  readonly tier: QualityTier;
  /** Current 3D resolution scale. */
  readonly scale: number;
  /** Requested tier from settings; returns the resolved tier to broadcast to the other modules. */
  request(tier: QualityTier): QualityTier;
}

/** Resolve a requested tier to a concrete one. AUTO -> BALANCED until the startup test exists (GFX-02). */
export function resolveTier(requested: QualityTier): QualityTier {
  return requested === QualityTier.AUTO ? QualityTier.BALANCED : requested;
}

/** Initial 3D resolution scale from settings (0 = automatic). */
export function initialScale(fixedSetting: number): number {
  if (fixedSetting > 0) return Math.max(T_PERF.resScaleMin, Math.min(T_PERF.resScaleMax, fixedSetting));
  return T_PERF.resScaleInitial;
}

export function createQuality(ctx: RenderContext, hooks: QualityHooks): QualityModule {
  let tier = resolveTier(ctx.settings.graphics.tier);
  let scale = initialScale(ctx.settings.graphics.resolutionScale);
  ctx.tier = tier;
  hooks.setScale(scale);

  return {
    get tier() { return tier; },
    get scale() { return scale; },
    request(t) {
      tier = resolveTier(t);
      ctx.tier = tier;
      const s = initialScale(ctx.settings.graphics.resolutionScale);
      if (s !== scale) {
        scale = s;
        hooks.setScale(scale);
      }
      return tier;
    },
    update(_f: RenderFrame) {
      // GFX-02: smoothed frame time (f.frame.dtMs) -> dynamic resolution with hysteresis.
    },
    dispose() { /* nothing owned */ },
  };
}
