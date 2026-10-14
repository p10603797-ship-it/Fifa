/**
 * [PLT-05] Debug overlay behind a hidden toggle (brief section 4 rule 7): frame-time graph, fps and frame ms, sim and
 * render ms, draw calls, triangles, resolution scale and quality tier, tick and phase, the state hash (recomputed
 * every HASH_EVERY_TICKS ticks) and an input viewer (touch points, pad buttons and axes). Replay save and load live
 * in Settings > Diagnostics (ui/screens/diagnostics.ts), which also has the full input tester.
 *
 * Toggle: the backquote key, or 5 taps in the top-left corner (64 px) within 2 s. The state lives in settings.debug
 * (Diagnostics > Debug overlay flips the same flag), so it survives reloads.
 *
 * Cost: nothing when hidden. update() returns at once; the only listeners are the toggle's keydown and a
 * pointerdown corner-tap check. While visible the text and graph are redrawn at most every REFRESH_MS, the input
 * viewer's pointer listeners are attached, and pads are polled at the redraw only. pointer-events: none, so the
 * overlay never takes a touch from the game.
 */
import type { AppContext, FrameInfo } from '../contracts/app';
import { MatchPhase } from '../contracts/enums';
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

export const REFRESH_MS = 250;
/** The state hash is recomputed when the tick enters a new block of this many ticks. */
export const HASH_EVERY_TICKS = 30;
/** Frame-time graph size (CSS px) and its scale top (ms). */
export const GRAPH_W = 180;
export const GRAPH_H = 44;
export const GRAPH_MAX_MS = 50;

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

// ============================================================ input viewer helpers (shared with the input tester)

/** Minimal Gamepad shape (tests pass plain objects). */
export interface PadLike {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping?: string;
  readonly buttons: readonly { readonly pressed: boolean; readonly value: number }[];
  readonly axes: readonly number[];
}

/** Connected pads from navigator.getGamepads() (empty without the API or when it throws). */
export function readPads(): PadLike[] {
  const out: PadLike[] = [];
  try {
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & { getGamepads?: () => (Gamepad | null)[] }) : null;
    const list = nav && typeof nav.getGamepads === 'function' ? nav.getGamepads() : null;
    if (!list) return out;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (p && p.connected) out.push(p);
    }
  } catch {
    /* no pads */
  }
  return out;
}

/** One line per pad: index, short id, pressed buttons (index or index=value for analog), axes. Pure. */
export function describePad(p: PadLike): string {
  const pressed: string[] = [];
  for (let i = 0; i < p.buttons.length; i++) {
    const b = p.buttons[i]!;
    if (b.pressed) pressed.push(b.value > 0 && b.value < 1 ? `${i}=${b.value.toFixed(2)}` : String(i));
  }
  const axes: string[] = [];
  for (let i = 0; i < p.axes.length; i++) axes.push(((p.axes[i] ?? 0) >= 0 ? '+' : '') + (p.axes[i] ?? 0).toFixed(2));
  const id = p.id.length > 28 ? p.id.slice(0, 28) + '...' : p.id;
  return `pad ${p.index} ${id}${p.mapping === 'standard' ? '' : ' (non-standard)'}  btn [${pressed.join(' ')}]  axes [${axes.join(' ')}]`;
}

export interface PointerPoint { id: number; x: number; y: number; type: string }

/** Tracks active pointers (touch points) from pointer events. */
export interface PointerTracker {
  handle(e: Pick<PointerEvent, 'type' | 'pointerId' | 'clientX' | 'clientY' | 'pointerType'>): void;
  points(): readonly PointerPoint[];
  clear(): void;
}

export function createPointerTracker(): PointerTracker {
  const pts: PointerPoint[] = [];
  return {
    handle(e) {
      const i = pts.findIndex((p) => p.id === e.pointerId);
      if (e.type === 'pointerdown' || (e.type === 'pointermove' && i >= 0)) {
        if (i >= 0) {
          pts[i]!.x = e.clientX;
          pts[i]!.y = e.clientY;
        } else {
          pts.push({ id: e.pointerId, x: e.clientX, y: e.clientY, type: e.pointerType });
        }
      } else if ((e.type === 'pointerup' || e.type === 'pointercancel' || e.type === 'lostpointercapture') && i >= 0) {
        pts.splice(i, 1);
      }
    },
    points: () => pts,
    clear() {
      pts.length = 0;
    },
  };
}

/** Name of a match phase for display. Pure. */
export function phaseName(phase: number): string {
  return MatchPhase[phase] ?? String(phase);
}

/** Bar colour band for a frame interval: 0 = on time (<= 17.5 ms), 1 = late (<= 34 ms), 2 = dropped. Pure. */
export function frameBand(ms: number): 0 | 1 | 2 {
  return ms <= 17.5 ? 0 : ms <= 34 ? 1 : 2;
}

/** Draw the frame-time ring (oldest left) as bars into a 2D context of w x h device px. */
export function drawFrameGraph(g: CanvasRenderingContext2D, w: number, h: number, times: ArrayLike<number>, head: number): void {
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(244,241,236,0.06)';
  g.fillRect(0, 0, w, h);
  const n = times.length;
  if (n === 0) return;
  const bw = w / n;
  const colours = ['#3ddc84', '#ffb020', '#ff4d4d'];
  for (let i = 0; i < n; i++) {
    const v = times[(head + i) % n]!;
    if (!(v > 0)) continue;
    const bh = Math.min(h, (v / GRAPH_MAX_MS) * h);
    g.fillStyle = colours[frameBand(v)]!;
    g.fillRect(i * bw, h - bh, Math.max(1, bw - 0.5), bh);
  }
  g.fillStyle = 'rgba(244,241,236,0.35)';
  for (const ms of [16.7, 33.3]) g.fillRect(0, Math.round(h - (ms / GRAPH_MAX_MS) * h), w, 1);
}

// ============================================================ overlay

export function installDebugOverlay(ctx: AppContext, sources: DebugOverlaySources): DebugOverlay {
  const el = h('div', { class: 'debug-overlay', testId: 'debug-overlay' });
  el.style.cssText =
    'position:fixed;left:50%;transform:translateX(-50%);top:calc(env(safe-area-inset-top,0px) + 62px);z-index:50;' +
    'pointer-events:none;font:12px/1.35 var(--font-num, monospace);color:#f4f1ec;background:rgba(7,7,13,.78);' +
    'border:1px solid rgba(244,241,236,.12);border-radius:8px;padding:6px 10px;white-space:pre;max-width:calc(100vw - 32px);overflow:hidden;';
  const canvas = h('canvas', { testId: 'debug-graph' });
  canvas.style.cssText = `display:block;width:${GRAPH_W}px;height:${GRAPH_H}px;margin-bottom:4px;pointer-events:none;`;
  const text = h('div', { testId: 'debug-text' });
  el.append(canvas, text);
  el.hidden = true;
  document.body.appendChild(el);
  let visible = false;
  let lastDraw = -Infinity;
  let hashText = 'n/a';
  let hashBlock = -1;
  let hashConfig: unknown = null;
  const taps = createCornerTapDetector();
  const pointers = createPointerTracker();
  const onPointerMove = (e: PointerEvent): void => pointers.handle(e);

  function attachViewer(on: boolean): void {
    const types = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const;
    for (const t of types) {
      if (on) window.addEventListener(t, onPointerMove, { capture: true, passive: true });
      else window.removeEventListener(t, onPointerMove, { capture: true });
    }
    if (!on) pointers.clear();
  }

  function apply(on: boolean): void {
    if (on === visible) return;
    visible = on;
    el.hidden = !on;
    lastDraw = -Infinity;
    hashBlock = -1;
    attachViewer(on);
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

  function drawGraph(f: FrameStats): void {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.round(GRAPH_W * dpr);
    const hh = Math.round(GRAPH_H * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== hh) canvas.height = hh;
    let g: CanvasRenderingContext2D | null;
    try {
      g = canvas.getContext('2d');
    } catch {
      g = null;
    }
    if (g) drawFrameGraph(g, w, hh, f.frameTimes, f.head);
  }

  function draw(): void {
    const f = sources.frameStats();
    const r = sources.rendererStats();
    const s = sources.state();
    const lines: string[] = [];
    if (f) {
      drawGraph(f);
      lines.push(`fps ${f.fps.toFixed(0)}  frame ${f.frameMs.toFixed(1)} ms  ticks ${f.ticks}${f.stalled ? '  WAITING' : ''}`);
      lines.push(`sim ${f.simMsEma.toFixed(2)} ms (max ${f.simMsMax.toFixed(2)})  render ${f.renderMsEma.toFixed(2)} ms (max ${f.renderMsMax.toFixed(2)})`);
    }
    if (r) lines.push(`draw ${r.drawCalls}  tris ${r.triangles}  tex ${r.textures}  geo ${r.geometries}  res ${r.resolutionScale.toFixed(2)}  tier ${r.qualityTier}`);
    if (s) {
      const block = Math.floor(s.tick / HASH_EVERY_TICKS);
      if (block !== hashBlock || s.config !== hashConfig) {
        hashBlock = block;
        hashConfig = s.config;
        try {
          hashText = `${hashHex(hashState(s as unknown as SimState))} @${s.tick}`;
        } catch {
          hashText = 'n/a';
        }
      }
      lines.push(`tick ${s.tick}  phase ${phaseName(s.match.phase)}  ball owner ${s.ball.owner}  hash ${hashText}`);
    }
    const pts = pointers.points();
    let touchLine = `touch ${pts.length}`;
    for (let i = 0; i < pts.length && i < 6; i++) touchLine += `  #${pts[i]!.id} ${Math.round(pts[i]!.x)},${Math.round(pts[i]!.y)}`;
    lines.push(touchLine);
    const pads = readPads();
    if (pads.length === 0) lines.push('pads none');
    for (const p of pads) lines.push(describePad(p));
    text.textContent = lines.join('\n');
  }

  return {
    update(frame) {
      if (!visible) return;
      if (frame.nowMs - lastDraw < REFRESH_MS) return;
      lastDraw = frame.nowMs;
      try {
        draw();
      } catch (err) {
        text.textContent = `debug overlay: ${String(err)}`;
      }
    },
    toggle,
    get visible() {
      return visible;
    },
    dispose() {
      unsubscribe();
      attachViewer(false);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('pointerdown', onPointer, true);
      el.remove();
    },
  };
}
