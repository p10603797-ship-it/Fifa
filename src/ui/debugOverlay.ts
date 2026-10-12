/**
 * [PLT-05] Debug overlay behind a hidden toggle (ARCHITECTURE rule 7). WAVE 0 version by FND-04: fps, frame ms,
 * sim / render ms, draw calls, triangles, tick, phase and state hash, refreshed at 4 Hz while visible.
 * PLT-05 adds the frame-time graph, input viewer and replay save/load.
 *
 * Toggle: the backquote key, or 5 taps in the top-left corner within 2 s. The state lives in settings.debug.
 */
import type { AppContext, FrameInfo } from '../contracts/app';
import type { RenderStats } from '../contracts/render';
import type { ReadonlySimState, SimState } from '../contracts/state';
import type { FrameStats } from '../app/types';
import { hashHex, hashState } from '../sim/core/hash';
import { h } from './components';

export interface DebugOverlaySources {
  frameStats(): FrameStats | null;
  rendererStats(): RenderStats | null;
  state(): ReadonlySimState | null;
}

export interface DebugOverlay {
  /** Call every animation frame; redraws at most every REFRESH_MS while visible. */
  update(frame: FrameInfo): void;
  toggle(): void;
  readonly visible: boolean;
  dispose(): void;
}

export interface CornerTapDetector {
  /** Feed a pointer-down; returns true when this tap completes the sequence (and resets it). */
  tap(x: number, y: number, tMs: number): boolean;
  reset(): void;
}

const REFRESH_MS = 250;

/** Pure detector for N taps inside the top-left `size` px square within `windowMs`. */
export function createCornerTapDetector(opts: { taps?: number; windowMs?: number; size?: number } = {}): CornerTapDetector {
  const need = opts.taps ?? 5;
  const windowMs = opts.windowMs ?? 2000;
  const size = opts.size ?? 64;
  const times: number[] = [];
  return {
    tap(x, y, tMs) {
      if (x > size || y > size) {
        times.length = 0;
        return false;
      }
      times.push(tMs);
      while (times.length > 0 && tMs - times[0]! > windowMs) times.shift();
      if (times.length >= need) {
        times.length = 0;
        return true;
      }
      return false;
    },
    reset() {
      times.length = 0;
    },
  };
}

export function installDebugOverlay(ctx: AppContext, sources: DebugOverlaySources): DebugOverlay {
  const el = h('div', { class: 'debug-overlay', testId: 'debug-overlay' });
  el.style.cssText =
    'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 62px);z-index:50;' +
    'pointer-events:none;font:12px/1.35 var(--font-num, monospace);color:#f4f1ec;background:rgba(7,7,13,.78);' +
    'border:1px solid rgba(244,241,236,.12);border-radius:8px;padding:6px 10px;white-space:pre;';
  el.hidden = true;
  document.body.appendChild(el);
  let visible = false;
  let lastDraw = -Infinity;
  const taps = createCornerTapDetector();

  function apply(on: boolean): void {
    visible = on;
    el.hidden = !on;
    lastDraw = -Infinity;
  }
  apply(ctx.settings.get().debug);
  const unsubscribe = ctx.settings.subscribe((s) => {
    if (s.debug !== visible) apply(s.debug);
  });

  const toggle = (): void => {
    ctx.diagnostics.setDebug(!ctx.diagnostics.debug);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Backquote' || e.key === '`') {
      if (!e.repeat) toggle();
    }
  };
  const onPointer = (e: PointerEvent): void => {
    if (taps.tap(e.clientX, e.clientY, e.timeStamp)) toggle();
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('pointerdown', onPointer, true);

  function draw(): void {
    const f = sources.frameStats();
    const r = sources.rendererStats();
    const s = sources.state();
    const lines: string[] = [];
    if (f) {
      lines.push(`fps ${f.fps.toFixed(0)}  frame ${f.frameMs.toFixed(1)} ms  ticks ${f.ticks}${f.stalled ? '  WAITING' : ''}`);
      lines.push(`sim ${f.simMsEma.toFixed(2)} ms (max ${f.simMsMax.toFixed(2)})  render ${f.renderMsEma.toFixed(2)} ms (max ${f.renderMsMax.toFixed(2)})`);
    }
    if (r) lines.push(`draw ${r.drawCalls}  tris ${r.triangles}  tex ${r.textures}  geo ${r.geometries}  res ${r.resolutionScale.toFixed(2)}  tier ${r.qualityTier}`);
    if (s) {
      let hash = 'n/a';
      try {
        hash = hashHex(hashState(s as unknown as SimState));
      } catch {
        /* hash unavailable */
      }
      lines.push(`tick ${s.tick}  phase ${s.match.phase}  ball owner ${s.ball.owner}  hash ${hash}`);
    }
    el.textContent = lines.join('\n');
  }

  return {
    update(frame) {
      if (!visible) return;
      if (frame.nowMs - lastDraw < REFRESH_MS) return;
      lastDraw = frame.nowMs;
      draw();
    },
    toggle,
    get visible() {
      return visible;
    },
    dispose() {
      unsubscribe();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      el.remove();
    },
  };
}
