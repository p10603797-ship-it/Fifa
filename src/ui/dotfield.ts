/**
 * [UIX-01] The signature animated dot field behind the menus (brief section 12 "Visual identity": an animated
 * dot-field canvas behind the menus that stops completely during matches so it never costs a frame).
 *
 * Look: a calm dot-matrix grid in the ink that drifts slowly under a travelling brightness wave, plus a sparse layer of
 * larger floating dots (a few in ember) at two depths. Focus changes give a parallax response: the layers slide
 * against the focused control's position at different depths and a soft ember glow follows the focus.
 *
 * Driving: no requestAnimationFrame and no timers of its own (brief section 13 "One loop"). The app loop calls the
 * mounted screen's onFrame; a menu screen forwards it to frame(nowMs). Drawing is capped at 30 fps; with
 * prefers-reduced-motion the field is drawn still and redrawn only on resize or focus changes.
 *
 * Stopping: the field draws only while it is mounted, active and the app is not in a match. It hides its canvas and
 * draws nothing (a) after setActive(false) until setActive(true), (b) after unmount, (c) while <body> has the
 * match-active or in-match class (the session sets them), even if a menu shown over a match keeps calling frame().
 *
 * Use: wrap a menu screen factory with withDotField(factory) (one shared canvas moves between screens), or call
 * attachDotField(root) in mount and forward onFrame. sharedDotField() is also on window.__dotkickDotField for tests
 * and the debug overlay (stats: frames, draws, visible...).
 *
 * UI code: allocation happens only on mount and resize (typed arrays, colour strings); frame() allocates nothing.
 */
import type { FrameInfo, Screen, ScreenFactory } from '../contracts/app';

/** Visual constants (UI only, not gameplay tuning). Units in comments. */
export const DOTFIELD = {
  /** Draw-rate cap, frames per second. */
  fps: 30,
  /** Timing slack so 60 / 120 Hz frames land on a steady 30 fps cadence, ms. */
  slackMs: 2,
  /** Longest animation step after a stall or a hidden page, s. */
  maxStepS: 0.1,
  /** Canvas resolution cap, device px per CSS px. */
  maxDpr: 2,
  /** Grid pitch when the --dot-spacing token is missing, CSS px. */
  spacingPx: 26,
  /** Grid dot radius, CSS px. */
  gridRadiusPx: 1.05,
  /** Grid dot alpha at the low and high point of the brightness wave. */
  gridAlphaLo: 0.07,
  gridAlphaHi: 0.26,
  /** Grid drift velocity, CSS px/s. */
  gridDriftX: 2.2,
  gridDriftY: -1.1,
  /** One floating dot per this many grid cells. */
  floaterEvery: 6,
  /** Share of floaters on the near layer (the rest are mid). */
  nearShare: 0.3,
  /** Share of near floaters drawn in ember. */
  emberShare: 0.22,
  /** Floater radius, mid / near layer, CSS px. */
  midRadiusPx: 1.6,
  nearRadiusPx: 2.4,
  /** Floater alpha, mid / near layer. */
  midAlpha: 0.26,
  nearAlpha: 0.48,
  /** Floater drift velocity, mid and near layer, CSS px/s. */
  midDriftX: 5,
  midDriftY: -2.6,
  nearDriftX: 9,
  nearDriftY: -4.4,
  /** Floater wobble amplitude, CSS px. */
  wobblePx: 2.6,
  /** Largest parallax shift of the grid, mid and near layers at the screen edge, CSS px. */
  parallaxGridPx: 6,
  parallaxMidPx: 14,
  parallaxNearPx: 24,
  /** Parallax and glow easing time constant, s. */
  easeTauS: 0.4,
  /** Ember glow around the focused control: radius in CSS px and peak alpha. */
  glowRadiusPx: 240,
  glowAlpha: 0.2,
  /** Grid dots inside the glow take an ember tint above this glow strength (0..1). */
  tintThreshold: 0.3,
  /** Brightness wave: speed in rad/s, spatial frequency in rad per CSS px. */
  waveSpeed: 0.45,
  waveScale: 0.0055,
} as const;

/** Neutral and ember alpha buckets (one fill per bucket per frame). */
const NEUTRAL_BUCKETS = 6;
const NEUTRAL_MAX_ALPHA = 0.6;
const EMBER_BUCKETS = 4;
const BUCKETS = NEUTRAL_BUCKETS + EMBER_BUCKETS;
const TAU = Math.PI * 2;

export interface DotField {
  /** Attach the canvas under root (behind the screen content). Moves the canvas when it was under another root. */
  mount(root: HTMLElement): void;
  /** Detach from root (from the current root when omitted): hide the canvas and stop drawing. */
  unmount(root?: HTMLElement): void;
  /** Advance one animation frame (called from a menu screen's onFrame). */
  frame(nowMs: number): void;
  /** Stop drawing (match start) / resume drawing (back in menus). */
  setActive(active: boolean): void;
  /** Debug counters (tests, debug overlay). */
  readonly stats: DotFieldStats;
  dispose(): void;
}

export interface DotFieldStats {
  /** frame() calls. */
  frames: number;
  /** Frames actually drawn. */
  draws: number;
  mounted: boolean;
  active: boolean;
  /** True while <body> says a match is on screen. */
  blocked: boolean;
  /** Canvas shown. */
  visible: boolean;
  /** Dots in the current layout (grid + floaters). */
  dots: number;
  /** Canvas size, CSS px. */
  width: number;
  height: number;
  /** Eased parallax position (-0.5..0.5 per axis, focus relative to the screen centre). */
  parallaxX: number;
  parallaxY: number;
}

// ============================================================ pure helpers (unit-tested)

/** True when a 30 fps cadence wants a new drawing at nowMs (lastMs < 0: nothing drawn yet). */
export function shouldDraw(nowMs: number, lastMs: number, fps: number = DOTFIELD.fps, slackMs: number = DOTFIELD.slackMs): boolean {
  if (lastMs < 0 || nowMs < lastMs) return true;
  return nowMs - lastMs >= 1000 / fps - slackMs;
}

/** Exponential approach of cur toward target over dtS with time constant tauS (frame-rate independent). */
export function easeToward(cur: number, target: number, dtS: number, tauS: number): number {
  if (tauS <= 0 || dtS <= 0) return dtS <= 0 ? cur : target;
  return target + (cur - target) * Math.exp(-dtS / tauS);
}

/** Focus centre relative to the screen centre, each axis clamped to -0.5..0.5. */
export function focusOffset(cx: number, cy: number, width: number, height: number): { x: number; y: number } {
  const clamp = (v: number): number => (v < -0.5 ? -0.5 : v > 0.5 ? 0.5 : v);
  return { x: width > 0 ? clamp(cx / width - 0.5) : 0, y: height > 0 ? clamp(cy / height - 0.5) : 0 };
}

/** v wrapped into [lo, lo + span). */
export function wrapInto(v: number, lo: number, span: number): number {
  return v - span * Math.floor((v - lo) / span);
}

/** Neutral alpha bucket 0..NEUTRAL_BUCKETS-1 for alpha a. */
export function neutralBucket(a: number): number {
  const b = Math.floor((a / NEUTRAL_MAX_ALPHA) * NEUTRAL_BUCKETS);
  return b < 0 ? 0 : b >= NEUTRAL_BUCKETS ? NEUTRAL_BUCKETS - 1 : b;
}

/** Ember bucket NEUTRAL_BUCKETS..BUCKETS-1 for strength s (0..1). */
export function emberBucket(s: number): number {
  const b = Math.floor(s * EMBER_BUCKETS);
  return NEUTRAL_BUCKETS + (b < 0 ? 0 : b >= EMBER_BUCKETS ? EMBER_BUCKETS - 1 : b);
}

/** Alpha drawn for a bucket. */
export function bucketAlpha(bucket: number): number {
  if (bucket < NEUTRAL_BUCKETS) return ((bucket + 0.5) / NEUTRAL_BUCKETS) * NEUTRAL_MAX_ALPHA;
  return 0.35 + ((bucket - NEUTRAL_BUCKETS) / (EMBER_BUCKETS - 1)) * 0.6;
}

/** Integer hash -> 0..1 (stable layout without Math.random: same dots on every visit). */
export function hash01(a: number, b: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Layout of the floating dots for a canvas of w x h CSS px. */
export interface FloaterLayout {
  count: number;
  /** Base positions inside the wrap tile, CSS px. */
  x: Float32Array;
  y: Float32Array;
  phase: Float32Array;
  /** 1 = mid, 2 = near. */
  layer: Uint8Array;
  ember: Uint8Array;
  /** Wrap tile: x in [-margin, w + margin), same for y. */
  margin: number;
  spanX: number;
  spanY: number;
}

/** Deterministic floater layout (one per DOTFIELD.floaterEvery grid cells). */
export function buildFloaters(w: number, h: number, spacing: number): FloaterLayout {
  const margin = DOTFIELD.parallaxNearPx + DOTFIELD.wobblePx + spacing;
  const spanX = Math.max(1, w + 2 * margin);
  const spanY = Math.max(1, h + 2 * margin);
  const cells = Math.ceil(spanX / spacing) * Math.ceil(spanY / spacing);
  const count = Math.max(0, Math.floor(cells / DOTFIELD.floaterEvery));
  const out: FloaterLayout = {
    count, margin, spanX, spanY,
    x: new Float32Array(count), y: new Float32Array(count), phase: new Float32Array(count),
    layer: new Uint8Array(count), ember: new Uint8Array(count),
  };
  for (let i = 0; i < count; i++) {
    out.x[i] = -margin + hash01(i, 1) * spanX;
    out.y[i] = -margin + hash01(i, 2) * spanY;
    out.phase[i] = hash01(i, 3) * TAU;
    const near = hash01(i, 4) < DOTFIELD.nearShare;
    out.layer[i] = near ? 2 : 1;
    out.ember[i] = near && hash01(i, 5) < DOTFIELD.emberShare ? 1 : 0;
  }
  return out;
}

/** Grid rows / columns covering w x h with a margin for drift and parallax (hexagonal rows: odd rows shift half a pitch). */
export function gridSize(w: number, h: number, spacing: number): { cols: number; rows: number; rowStep: number } {
  const rowStep = spacing * 0.8660254;
  const extra = DOTFIELD.parallaxGridPx * 2 + spacing * 2;
  return { cols: Math.ceil((w + extra) / spacing) + 1, rows: Math.ceil((h + extra) / rowStep) + 2, rowStep };
}

function parseRgb(css: string, fallback: [number, number, number]): [number, number, number] {
  const s = css.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const t = m[1]!;
    return [parseInt(t[0]! + t[0]!, 16), parseInt(t[1]! + t[1]!, 16), parseInt(t[2]! + t[2]!, 16)];
  }
  const r = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(s);
  if (r) return [Number(r[1]), Number(r[2]), Number(r[3])];
  return fallback;
}

/** The fill style of every bucket for the given dot / accent colours. */
export function bucketStyles(dotCss: string, accentCss: string): string[] {
  const d = parseRgb(dotCss, [247, 240, 238]);
  const e = parseRgb(accentCss, [255, 107, 53]);
  const out: string[] = [];
  for (let b = 0; b < BUCKETS; b++) {
    const c = b < NEUTRAL_BUCKETS ? d : e;
    out.push(`rgba(${c[0]}, ${c[1]}, ${c[2]}, ${bucketAlpha(b).toFixed(3)})`);
  }
  return out;
}

// ============================================================ the field

export interface DotFieldOptions {
  /** Document to use (tests pass a fake). Default: the global document. */
  doc?: Document | null;
}

type Ctx2D = CanvasRenderingContext2D;

export function createDotField(opts: DotFieldOptions = {}): DotField {
  const doc: Document | null = opts.doc !== undefined ? opts.doc : typeof document !== 'undefined' ? document : null;
  const stats: DotFieldStats = {
    frames: 0, draws: 0, mounted: false, active: true, blocked: false, visible: false, dots: 0, width: 0, height: 0,
    parallaxX: 0, parallaxY: 0,
  };
  let canvas: HTMLCanvasElement | null = null;
  let ctx: Ctx2D | null = null;
  let glowSprite: HTMLCanvasElement | null = null;
  let unusable = false;
  let owner: HTMLElement | null = null;
  let active = true;
  let disposed = false;

  // layout
  let cssW = 0, cssH = 0, dpr = 1, spacing: number = DOTFIELD.spacingPx;
  let floaters: FloaterLayout | null = null;
  let grid = { cols: 0, rows: 0, rowStep: 1 };
  let px = new Float32Array(0), py = new Float32Array(0), pr = new Float32Array(0);
  let pb = new Uint8Array(0);
  let styles: string[] = bucketStyles('#f7f0ee', '#ff6b35');
  let colourKey = '';

  // animation
  let t = 0;
  let lastDraw = -1;
  let lastFrameNow = Number.NaN;
  let dirty = true;
  let parX = 0, parY = 0, tgtX = 0, tgtY = 0;
  let glowX = 0, glowY = 0, glowS = 0, glowTarget = 0, glowTX = 0, glowTY = 0, glowPlaced = false;
  let focusEl: Element | null = null;
  let focusDirty = true;
  let reduced: MediaQueryList | null = null;

  // Keyboard / pad focus moves native focus (focusin); a touch press only moves [data-focused] (the navigator's
  // pointerdown handler on window runs before this document listener), so both mark the target for re-reading.
  const onFocusIn = (e: Event): void => {
    const t = e.target as Element | null;
    focusEl = t && typeof t.getBoundingClientRect === 'function' ? t : null;
    focusDirty = true;
  };
  const onPointerDown = (): void => {
    focusDirty = true;
  };

  function view(): (Window & typeof globalThis) | null {
    return (doc?.defaultView as (Window & typeof globalThis) | null | undefined) ?? null;
  }

  function isBlocked(): boolean {
    const body = doc?.body;
    if (!body || !body.classList) return false;
    return body.classList.contains('match-active') || body.classList.contains('in-match');
  }

  /**
   * Show / hide the canvas. The owner carries .has-dotfield only while the field is visible: that class swaps the
   * screen's static CSS dots for the plain ink the canvas draws on, so a hidden field (in a match, under an overlay
   * screen's scrim) leaves the screen's own background alone.
   */
  function setVisible(v: boolean): void {
    stats.visible = v;
    if (canvas && canvas.hidden === v) canvas.hidden = !v;
    try {
      owner?.classList?.toggle('has-dotfield', v);
    } catch {
      /* a fake root */
    }
  }

  function refreshVisibility(force = false): boolean {
    stats.blocked = isBlocked();
    const v = owner !== null && active && !stats.blocked && ctx !== null;
    if (force || v !== stats.visible || (canvas && canvas.hidden === v)) setVisible(v);
    return v;
  }

  function ensureCanvas(): boolean {
    if (canvas) return ctx !== null;
    if (unusable || !doc || typeof doc.createElement !== 'function') return false;
    try {
      const c = doc.createElement('canvas');
      const g = typeof c.getContext === 'function' ? (c.getContext('2d', { alpha: true }) as Ctx2D | null) : null;
      if (!g) {
        unusable = true;
        return false;
      }
      c.className = 'dotfield';
      c.setAttribute('aria-hidden', 'true');
      c.hidden = true;
      canvas = c;
      ctx = g;
      return true;
    } catch {
      unusable = true;
      return false;
    }
  }

  function readTokens(root: HTMLElement): void {
    const v = view();
    if (!v || typeof v.getComputedStyle !== 'function') return;
    try {
      const cs = v.getComputedStyle(root);
      const dot = cs.getPropertyValue('--dot-color').trim() || cs.getPropertyValue('--text-1').trim() || '#f7f0ee';
      const acc = cs.getPropertyValue('--dot-accent').trim() || cs.getPropertyValue('--ember').trim() || '#ff6b35';
      const sp = parseFloat(cs.getPropertyValue('--dot-spacing'));
      if (Number.isFinite(sp) && sp >= 8 && sp <= 200 && sp !== spacing) {
        spacing = sp;
        floaters = null; // relayout on the next frame
      }
      const key = `${dot}|${acc}`;
      if (key !== colourKey) {
        colourKey = key;
        styles = bucketStyles(dot, acc);
        glowSprite = makeGlowSprite(acc);
      }
    } catch {
      /* defaults stay */
    }
  }

  function makeGlowSprite(accentCss: string): HTMLCanvasElement | null {
    if (!doc) return null;
    try {
      const s = doc.createElement('canvas');
      s.width = 128;
      s.height = 128;
      const g = s.getContext('2d');
      if (!g) return null;
      const e = parseRgb(accentCss, [255, 107, 53]);
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      grad.addColorStop(0, `rgba(${e[0]}, ${e[1]}, ${e[2]}, 1)`);
      grad.addColorStop(0.45, `rgba(${e[0]}, ${e[1]}, ${e[2]}, 0.35)`);
      grad.addColorStop(1, `rgba(${e[0]}, ${e[1]}, ${e[2]}, 0)`);
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      return s;
    } catch {
      return null;
    }
  }

  /** Match the canvas to the window; returns true when the layout changed. */
  function syncSize(): boolean {
    const v = view();
    const w = v ? v.innerWidth : 0;
    const h = v ? v.innerHeight : 0;
    const r = Math.min(DOTFIELD.maxDpr, Math.max(1, v && v.devicePixelRatio ? v.devicePixelRatio : 1));
    if (w === cssW && h === cssH && r === dpr && floaters) return false;
    cssW = w;
    cssH = h;
    dpr = r;
    stats.width = w;
    stats.height = h;
    if (canvas) {
      canvas.width = Math.max(1, Math.round(w * r));
      canvas.height = Math.max(1, Math.round(h * r));
    }
    grid = gridSize(w, h, spacing);
    floaters = buildFloaters(w, h, spacing);
    const n = grid.cols * grid.rows + floaters.count;
    if (px.length < n) {
      px = new Float32Array(n);
      py = new Float32Array(n);
      pr = new Float32Array(n);
      pb = new Uint8Array(n);
    }
    stats.dots = n;
    focusDirty = true;
    return true;
  }

  function updateFocusTarget(): void {
    focusDirty = false;
    // The navigator's [data-focused] element is the truth; the last focusin target is the fallback.
    let el: Element | null = owner && typeof owner.querySelector === 'function' ? owner.querySelector('[data-focused]') : null;
    if (!el && focusEl && focusEl.isConnected && owner && owner.contains(focusEl)) el = focusEl;
    if (!el || typeof (el as HTMLElement).getBoundingClientRect !== 'function') {
      tgtX = 0;
      tgtY = 0;
      glowTarget = 0;
      return;
    }
    const r = (el as HTMLElement).getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) {
      glowTarget = 0;
      return;
    }
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const o = focusOffset(cx, cy, cssW, cssH);
    tgtX = o.x;
    tgtY = o.y;
    glowTX = cx;
    glowTY = cy;
    glowTarget = 1;
    if (!glowPlaced) {
      glowX = cx;
      glowY = cy;
      glowPlaced = true;
    }
  }

  function draw(): void {
    const g = ctx!;
    const fl = floaters!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const R = DOTFIELD.glowRadiusPx;
    const glowA = glowS * DOTFIELD.glowAlpha;
    if (glowA > 0.005 && glowSprite) {
      g.globalAlpha = glowA;
      g.drawImage(glowSprite, glowX - R, glowY - R, R * 2, R * 2);
      g.globalAlpha = 1;
    }
    const R2 = R * R;
    const tint = glowS > 0.01;

    let n = 0;
    // Grid layer: regular hexagonal rows, drifting and wrapping by whole pitches (seamless).
    const S = spacing, rowStep = grid.rowStep;
    const ox = wrapInto(t * DOTFIELD.gridDriftX - parX * DOTFIELD.parallaxGridPx * 2, 0, S);
    const oy = wrapInto(t * DOTFIELD.gridDriftY - parY * DOTFIELD.parallaxGridPx * 2, 0, rowStep * 2);
    const waveT = t * DOTFIELD.waveSpeed;
    const k = DOTFIELD.waveScale;
    const aLo = DOTFIELD.gridAlphaLo, aSpan = DOTFIELD.gridAlphaHi - DOTFIELD.gridAlphaLo;
    for (let row = 0; row < grid.rows; row++) {
      const y = oy + (row - 2) * rowStep;
      const shift = (row & 1) === 1 ? S * 0.5 : 0;
      for (let col = 0; col < grid.cols; col++) {
        const x = ox + shift + (col - 1) * S;
        const w = 0.5 + 0.5 * Math.sin(waveT - (x * 0.8 + y) * k);
        let b = neutralBucket(aLo + aSpan * w * w);
        if (tint) {
          const dx = x - glowX, dy = y - glowY;
          const d2 = dx * dx + dy * dy;
          if (d2 < R2) {
            const s = (1 - d2 / R2) * glowS;
            if (s > DOTFIELD.tintThreshold) b = emberBucket((s - DOTFIELD.tintThreshold) / (1 - DOTFIELD.tintThreshold) * 0.5);
          }
        }
        px[n] = x;
        py[n] = y;
        pr[n] = DOTFIELD.gridRadiusPx;
        pb[n] = b;
        n++;
      }
    }
    // Floaters: two depths, drifting, wobbling, wrapping inside the margin tile.
    const lo = -fl.margin;
    for (let i = 0; i < fl.count; i++) {
      const near = fl.layer[i] === 2;
      const ph = fl.phase[i]!;
      const par = near ? DOTFIELD.parallaxNearPx : DOTFIELD.parallaxMidPx;
      let x = fl.x[i]! + t * (near ? DOTFIELD.nearDriftX : DOTFIELD.midDriftX) - parX * par * 2;
      let y = fl.y[i]! + t * (near ? DOTFIELD.nearDriftY : DOTFIELD.midDriftY) - parY * par * 2;
      x = wrapInto(x, lo, fl.spanX) + DOTFIELD.wobblePx * Math.sin(t * 0.6 + ph);
      y = wrapInto(y, lo, fl.spanY) + DOTFIELD.wobblePx * Math.cos(t * 0.45 + ph * 1.7);
      const pulse = 0.7 + 0.3 * Math.sin(t * 0.8 + ph * 2);
      px[n] = x;
      py[n] = y;
      pr[n] = near ? DOTFIELD.nearRadiusPx : DOTFIELD.midRadiusPx;
      pb[n] = fl.ember[i] === 1 ? emberBucket(pulse) : neutralBucket((near ? DOTFIELD.nearAlpha : DOTFIELD.midAlpha) * pulse);
      n++;
    }
    // One path and one fill per bucket.
    for (let b = 0; b < BUCKETS; b++) {
      let any = false;
      for (let i = 0; i < n; i++) {
        if (pb[i] !== b) continue;
        if (!any) {
          g.beginPath();
          any = true;
        }
        const x = px[i]!, y = py[i]!, r = pr[i]!;
        if (x < -r || y < -r || x > cssW + r || y > cssH + r) continue;
        g.moveTo(x + r, y);
        g.arc(x, y, r, 0, TAU);
      }
      if (any) {
        g.fillStyle = styles[b]!;
        g.fill();
      }
    }
  }

  const field: DotField = {
    stats,
    mount(root) {
      if (disposed || !root) return;
      if (!ensureCanvas()) {
        owner = root;
        stats.mounted = true;
        return;
      }
      if (owner && owner !== root) owner.classList?.remove('has-dotfield');
      owner = root;
      stats.mounted = true;
      try {
        if (canvas!.parentNode !== root || root.firstChild !== canvas) root.insertBefore(canvas!, root.firstChild);
      } catch {
        /* a fake root */
      }
      readTokens(root);
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('focusin', onFocusIn, true);
        doc.addEventListener('pointerdown', onPointerDown, true);
      }
      const v = view();
      if (!reduced && v && typeof v.matchMedia === 'function') {
        try {
          reduced = v.matchMedia('(prefers-reduced-motion: reduce)');
        } catch {
          reduced = null;
        }
      }
      focusEl = doc?.activeElement ?? null;
      focusDirty = true;
      dirty = true;
      lastDraw = -1;
      refreshVisibility(true);
    },
    unmount(root) {
      if (root && root !== owner) return;
      const r = owner;
      owner = null;
      stats.mounted = false;
      if (doc && typeof doc.removeEventListener === 'function') {
        doc.removeEventListener('focusin', onFocusIn, true);
        doc.removeEventListener('pointerdown', onPointerDown, true);
      }
      focusEl = null;
      glowPlaced = false;
      glowS = 0;
      setVisible(false);
      try {
        r?.classList?.remove('has-dotfield');
        if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      } catch {
        /* already gone */
      }
    },
    frame(nowMs) {
      stats.frames++;
      if (disposed || !owner || !ctx) return;
      if (!refreshVisibility()) {
        lastDraw = -1;
        return;
      }
      if (nowMs === lastFrameNow) return;
      lastFrameNow = nowMs;
      const still = reduced !== null && reduced.matches;
      // A resize clears the canvas bitmap: draw at once. Otherwise animate on the 30 fps cadence (a focus change
      // waits for the next slot), or, with reduced motion, redraw only when something changed.
      const resized = syncSize();
      if (focusDirty) {
        updateFocusTarget();
        dirty = true;
      }
      if (!resized) {
        if (still) {
          if (!dirty) return;
        } else if (!shouldDraw(nowMs, lastDraw)) {
          return;
        }
      }
      const dtS = lastDraw < 0 ? 0 : Math.min(DOTFIELD.maxStepS, Math.max(0, (nowMs - lastDraw) / 1000));
      if (still) {
        parX = tgtX;
        parY = tgtY;
        glowS = glowTarget;
        glowX = glowTX;
        glowY = glowTY;
      } else {
        t += dtS;
        parX = easeToward(parX, tgtX, dtS, DOTFIELD.easeTauS);
        parY = easeToward(parY, tgtY, dtS, DOTFIELD.easeTauS);
        glowS = easeToward(glowS, glowTarget, dtS, DOTFIELD.easeTauS);
        glowX = easeToward(glowX, glowTX, dtS, DOTFIELD.easeTauS * 0.6);
        glowY = easeToward(glowY, glowTY, dtS, DOTFIELD.easeTauS * 0.6);
      }
      stats.parallaxX = parX;
      stats.parallaxY = parY;
      draw();
      stats.draws++;
      lastDraw = nowMs;
      dirty = false;
    },
    setActive(on) {
      active = on;
      stats.active = on;
      if (on) {
        dirty = true;
        lastDraw = -1;
      }
      refreshVisibility();
    },
    dispose() {
      field.unmount();
      disposed = true;
      canvas = null;
      ctx = null;
      glowSprite = null;
    },
  };
  return field;
}

// ============================================================ shared field and screen helpers

declare global {
  interface Window {
    /** The shared menu dot field (tests, debug overlay). */
    __dotkickDotField?: DotField;
  }
}

let shared: DotField | null = null;

/** The one dot field the menus share (created on first use). */
export function sharedDotField(): DotField {
  if (!shared) {
    shared = createDotField();
    if (typeof window !== 'undefined') window.__dotkickDotField = shared;
  }
  return shared;
}

/** Attach the shared dot field to a screen root; returns the detach function (call it from unmount). */
export function attachDotField(root: HTMLElement, field: DotField = sharedDotField()): () => void {
  field.mount(root);
  return () => field.unmount(root);
}

/**
 * Wrap a menu screen factory so the shared dot field sits behind it and animates from the app loop: mounted before
 * the screen's content, driven by onFrame, detached on unmount. Back and onFrame of the wrapped screen still run.
 */
export function withDotField(factory: ScreenFactory, getField: () => DotField = sharedDotField): ScreenFactory {
  return () => {
    const inner = factory();
    let detach: (() => void) | null = null;
    let field: DotField | null = null;
    const screen: Screen = {
      id: inner.id,
      mount(root, ctx, params) {
        field = getField();
        detach = attachDotField(root, field);
        inner.mount(root, ctx, params);
      },
      unmount() {
        try {
          inner.unmount();
        } finally {
          detach?.();
          detach = null;
          field = null;
        }
      },
      onBack() {
        return inner.onBack ? inner.onBack() : false;
      },
      onFrame(frame: FrameInfo) {
        field?.frame(frame.nowMs);
        inner.onFrame?.(frame);
      },
    };
    return screen;
  };
}
