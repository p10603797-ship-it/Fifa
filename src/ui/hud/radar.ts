/**
 * [UIX-07] Radar (brief section 12: "Radar bottom centre, with a toggle"; "draw the radar on a small 2D canvas at
 * 20 Hz"): a small canvas with the pitch outline (pre-rendered once per size), both teams' players as dots in their
 * kit colours (squares for the away side with colour-blind-safe markers; fixed light / amber with high-contrast kits),
 * the ball, and rings on the players the humans control (P1 ember, P2 cyan).
 *
 * The broadcast camera looks across the pitch from the +z touchline, so the radar keeps that view: +x right, +z down
 * (pitchToRadar / radarToPitch, unit-tested both ways). Redraws at most every REDRAW_MS of unpaused frame time and
 * only when the sim advanced; canvas drawing is not a DOM write, and the DOM is written only when the radar is shown
 * or hidden (radar preference from hudShared.ts: settings / pause menus toggle it; the touch layer sits above the
 * HUD so a tap cannot reach it) or resized for the larger-HUD setting. No allocation per redraw.
 *
 * [QF-7R] The marks (dots, squares, rings, ball) are pre-rendered sprites (rebuilt when the size, the colours or the
 * markers change) stamped at whole device pixels: every number a redraw passes to the canvas is a small integer. A
 * fractional number passed to a canvas method is a heap allocation in the browser (the binding boxes it), and the
 * arc() / fillRect() per player redraw cost ~70 of them (~1 KB) twenty times a second.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { ControllerKind } from '../../contracts/enums';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { h, injectStyle } from '../components';
import { HUD_LARGE_SCALE, HUD_SHARED_CSS, bindLargerHud, onRadarPref, radarEnabled } from './hudShared';
import { kitHex, wornShirts } from './scoreboard';

/** Radar presentation constants (UI, not gameplay; no tuning.ts entry needed). */
export const RADAR_TUNING = {
  /** Canvas size in CSS px at HUD scale 1. */
  width: 168,
  height: 110,
  /** Inner margin between the canvas edge and the pitch lines, CSS px. */
  pad: 6,
  /** Minimum time between redraws (20 Hz), ms. */
  redrawMs: 50,
  /** Dot radius, ball radius and controlled-player ring radius, CSS px at scale 1. */
  dotR: 2.7,
  ballR: 2.3,
  ringR: 5.2,
  /** Gap between the bottom safe edge and the radar, CSS px. */
  bottom: 16,
  /** Device pixel ratio cap for the canvas backing store. */
  maxDpr: 2,
  /** The canvas is never taller than this fraction of the viewport height (21:9 screens keep the ball region clear). */
  maxVh: 0.19,
} as const;

/**
 * Radar canvas size (CSS px, whole pixels) for a HUD scale and viewport height: the tuned size times the scale,
 * shrunk (aspect kept) so its height stays within RADAR_TUNING.maxVh of the viewport. Pure.
 */
export function radarCanvasSize(hs: number, viewportH: number, out: { w: number; h: number }): { w: number; h: number } {
  const T = RADAR_TUNING;
  let k = hs > 0 ? hs : 1;
  if (viewportH > 0 && T.height * k > T.maxVh * viewportH) k = (T.maxVh * viewportH) / T.height;
  out.w = Math.round(T.width * k);
  out.h = Math.round(T.height * k);
  return out;
}

/** Pitch half-length and half-width, m (105 x 68). */
const HALF_L = 52.5;
const HALF_W = 34;

const CSS = `
.hud-radar { position:absolute; left: 50%; bottom: calc(var(--safe-bottom, 0px) + ${RADAR_TUNING.bottom}px);
  transform: translateX(-50%); padding: calc(4px * var(--hs)); border-radius: calc(12px * var(--hs));
  background: rgba(7,7,13,.62); border: 1px solid var(--hairline); line-height: 0; }
.hud-radar[hidden] { display:none; }
.hud-radar canvas { display:block; }
`;

// ============================================================ coordinate mapping (pure)

export interface RadarLayout {
  /** Canvas size, CSS px. */
  w: number;
  h: number;
  /** Pixels per metre. */
  scale: number;
  /** Canvas position of the centre spot, CSS px. */
  cx: number;
  cy: number;
}

/** Fit the 105 x 68 pitch (aspect kept) inside a w x h canvas with `pad` px margins. Pure. */
export function radarLayout(w: number, h: number, pad: number = RADAR_TUNING.pad, out?: RadarLayout): RadarLayout {
  const o = out ?? { w: 0, h: 0, scale: 1, cx: 0, cy: 0 };
  const iw = Math.max(1, w - 2 * pad);
  const ih = Math.max(1, h - 2 * pad);
  const sx = iw / (2 * HALF_L);
  const sz = ih / (2 * HALF_W);
  o.w = w;
  o.h = h;
  o.scale = sx < sz ? sx : sz;
  o.cx = w / 2;
  o.cy = h / 2;
  return o;
}

/** Pitch (x, z) metres -> radar canvas CSS px, clamped to the canvas. +x right, +z down (broadcast view). Pure. */
export function pitchToRadar(L: Readonly<RadarLayout>, x: number, z: number, out: { x: number; y: number }): { x: number; y: number } {
  const fx = Number.isFinite(x) ? x : 0;
  const fz = Number.isFinite(z) ? z : 0;
  let rx = L.cx + fx * L.scale;
  let ry = L.cy + fz * L.scale;
  rx = rx < 0 ? 0 : rx > L.w ? L.w : rx;
  ry = ry < 0 ? 0 : ry > L.h ? L.h : ry;
  out.x = rx;
  out.y = ry;
  return out;
}

/** Radar canvas CSS px -> pitch (x, z) metres (inverse of pitchToRadar inside the canvas). Pure. */
export function radarToPitch(L: Readonly<RadarLayout>, rx: number, ry: number, out: { x: number; z: number }): { x: number; z: number } {
  const s = L.scale > 0 ? L.scale : 1;
  out.x = (rx - L.cx) / s;
  out.z = (ry - L.cy) / s;
  return out;
}

/** Relative luminance (0..1) of 0xRRGGBB, for the dot outline choice. Pure. */
export function luminance(rgb: number): number {
  const ch = (v: number): number => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((rgb >> 16) & 255) + 0.7152 * ch((rgb >> 8) & 255) + 0.0722 * ch(rgb & 255);
}

// ============================================================ part

interface RadarCanvasDebug {
  /** Redraw count (an expando property, not an attribute: reading it in tests never mutates the DOM). */
  __radarDraws?: number;
}

/** Mark sprites: home dot, away dot, away square (colour-blind markers), P1 / P2 rings, ball. */
const SPR_HOME = 0;
const SPR_AWAY = 1;
const SPR_AWAY_SQUARE = 2;
const SPR_RING_P1 = 3;
const SPR_RING_P2 = 4;
const SPR_BALL = 5;

function cssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export function createRadar(): HudPart {
  let root: HTMLElement | null = null;
  let canvas: (HTMLCanvasElement & RadarCanvasDebug) | null = null;
  let g: CanvasRenderingContext2D | null = null;
  let pitchLayer: HTMLCanvasElement | null = null;
  let ctxRef: AppContext | null = null;
  let unbindLarge: (() => void) | null = null;
  let unPref: (() => void) | null = null;
  let unSettings: (() => void) | null = null;
  const L: RadarLayout = radarLayout(RADAR_TUNING.width, RADAR_TUNING.height);
  const pt = { x: 0, y: 0 };
  let dpr = 1;
  let hs = 1;
  const size = { w: 0, h: 0 };
  let shownW = -1;
  let shownH = -1;
  /** Size of the dots and rings relative to the tuned canvas (HUD scale, viewport cap). */
  let markScale = 1;
  const onWindowResize = (): void => resize();
  let enabled = true;
  let visible = false;
  let shownHidden: boolean | null = null;
  /** Unpaused frame time since the last redraw, ms ([QF-7R] a typed array, not a closure variable: written every frame). */
  const acc = new Float64Array(1);
  let lastTick = -1;
  // [QF-7R] Mark sprites (SPR_*), each a square canvas `sprSize[k]` device px wide, centred on its middle pixel corner.
  const sprites: (HTMLCanvasElement | null)[] = [null, null, null, null, null, null];
  const sprSize = new Int32Array(6);
  let spritesDirty = true;
  let dirty = true;
  const fill: [string, string] = ['#f7f0ee', '#fbc547'];
  const stroke: [string, string] = ['rgba(7,7,13,.9)', 'rgba(7,7,13,.9)'];
  let squaresAway = false;
  let p1 = '#ff6b35';
  let p2 = '#3ed1f6';
  let clubsRef: readonly Club[] = [];
  let wornCache: [number, number] | null = null;
  let lastState: ReadonlySimState | null = null;

  function syncHidden(): void {
    const hide = !(enabled && visible);
    if (hide === shownHidden || !root) return;
    shownHidden = hide;
    root.hidden = hide;
    if (!hide) dirty = true;
  }

  function resize(): void {
    if (!canvas) return;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    radarCanvasSize(hs, vh, size);
    const w = size.w;
    const hgt = size.h;
    const r = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
    const d = r > RADAR_TUNING.maxDpr ? RADAR_TUNING.maxDpr : r;
    if (w === shownW && hgt === shownH && d === dpr) return;
    shownW = w;
    shownH = hgt;
    dpr = d;
    markScale = w / RADAR_TUNING.width;
    spritesDirty = true;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(hgt * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${hgt}px`;
    radarLayout(w, hgt, (RADAR_TUNING.pad * w) / RADAR_TUNING.width, L);
    buildPitchLayer();
    dirty = true;
  }

  function buildPitchLayer(): void {
    if (typeof document === 'undefined') return;
    const c = pitchLayer ?? document.createElement('canvas');
    pitchLayer = c;
    c.width = Math.round(L.w * dpr);
    c.height = Math.round(L.h * dpr);
    const q = c.getContext('2d');
    if (!q) return;
    q.setTransform(dpr, 0, 0, dpr, 0, 0);
    q.clearRect(0, 0, L.w, L.h);
    const s = L.scale;
    const x0 = L.cx - HALF_L * s;
    const z0 = L.cy - HALF_W * s;
    q.fillStyle = 'rgba(255,255,255,0.035)';
    q.fillRect(x0, z0, 2 * HALF_L * s, 2 * HALF_W * s);
    q.strokeStyle = 'rgba(247,240,238,0.34)';
    q.lineWidth = 1;
    q.strokeRect(x0 + 0.5, z0 + 0.5, 2 * HALF_L * s - 1, 2 * HALF_W * s - 1);
    q.beginPath();
    q.moveTo(L.cx, z0);
    q.lineTo(L.cx, z0 + 2 * HALF_W * s);
    q.stroke();
    q.beginPath();
    q.arc(L.cx, L.cy, 9.15 * s, 0, Math.PI * 2);
    q.stroke();
    // Penalty areas (16.5 m deep, 40.32 m wide) and goal areas (5.5 m x 18.32 m).
    const box = (depth: number, width: number): void => {
      q.strokeRect(x0, L.cy - (width / 2) * s, depth * s, width * s);
      q.strokeRect(x0 + 2 * HALF_L * s - depth * s, L.cy - (width / 2) * s, depth * s, width * s);
    };
    box(16.5, 40.32);
    box(5.5, 18.32);
  }

  function setColours(state: ReadonlySimState): void {
    const s = ctxRef?.settings.get();
    const hc = !!s?.accessibility?.highContrastKits;
    squaresAway = !!s?.accessibility?.colourBlindMarkers;
    // [QF-12] The shirts the players wear (clash check, fallback kits), not the requested kit slots. Resolved once per
    // match (setMatch clears the cache): settings changes (volume sliders) re-colour without redoing the clash check.
    if (!hc && !wornCache) wornCache = wornShirts(state, clubsRef);
    const worn = hc ? null : wornCache;
    for (let t = 0; t < 2; t++) {
      if (hc || !worn) {
        fill[t] = t === 0 ? '#f7f0ee' : '#fbc547';
        stroke[t] = 'rgba(7,7,13,.9)';
      } else {
        const shirt = worn[t]!;
        fill[t] = kitHex(shirt);
        stroke[t] = luminance(shirt) < 0.09 ? 'rgba(247,240,238,.85)' : 'rgba(7,7,13,.9)';
      }
    }
    spritesDirty = true;
    dirty = true;
  }

  /**
   * Draw one mark sprite: a circle (or a square when `square`) of radius `r` CSS px, filled with `fillStyle` (null =
   * ring only) and outlined `lineW` CSS px wide, on a canvas of whole device pixels centred on its middle.
   */
  function buildSprite(k: number, r: number, lineW: number, fillStyle: string | null, strokeStyle: string, square: boolean): void {
    const c = sprites[k] ?? document.createElement('canvas');
    sprites[k] = c;
    const half = Math.ceil((r + lineW) * dpr) + 1;
    sprSize[k] = 2 * half;
    c.width = 2 * half;
    c.height = 2 * half;
    const q = c.getContext('2d');
    if (!q) {
      sprites[k] = null;
      return;
    }
    q.setTransform(dpr, 0, 0, dpr, 0, 0);
    q.clearRect(0, 0, (2 * half) / dpr, (2 * half) / dpr);
    const m = half / dpr;
    q.lineWidth = lineW;
    q.strokeStyle = strokeStyle;
    if (square) {
      q.fillStyle = fillStyle ?? 'transparent';
      q.fillRect(m - r, m - r, r * 2, r * 2);
      q.strokeRect(m - r, m - r, r * 2, r * 2);
      return;
    }
    q.beginPath();
    q.arc(m, m, r, 0, Math.PI * 2);
    if (fillStyle !== null) {
      q.fillStyle = fillStyle;
      q.fill();
    }
    q.stroke();
  }

  function buildSprites(): void {
    spritesDirty = false;
    if (typeof document === 'undefined') return;
    const dotR = RADAR_TUNING.dotR * markScale;
    buildSprite(SPR_HOME, dotR, 1, fill[0], stroke[0], false);
    buildSprite(SPR_AWAY, dotR, 1, fill[1], stroke[1], false);
    buildSprite(SPR_AWAY_SQUARE, dotR, 1, fill[1], stroke[1], true);
    buildSprite(SPR_RING_P1, RADAR_TUNING.ringR * markScale, 2 * markScale, null, p1, false);
    buildSprite(SPR_RING_P2, RADAR_TUNING.ringR * markScale, 2 * markScale, null, p2, false);
    buildSprite(SPR_BALL, RADAR_TUNING.ballR * markScale, 1, '#ffffff', 'rgba(7,7,13,.95)', false);
  }

  /** Stamp sprite k centred at radar point pt (CSS px), snapped to whole device pixels: integers only. */
  function stamp(gc: CanvasRenderingContext2D, k: number): void {
    const s = sprites[k];
    if (!s) return;
    const half = sprSize[k]! >> 1;
    gc.drawImage(s, ((pt.x * dpr + 0.5) | 0) - half, ((pt.y * dpr + 0.5) | 0) - half);
  }

  function draw(state: ReadonlySimState): void {
    if (!g || !canvas) return;
    if (spritesDirty) buildSprites();
    // Device pixels, identity transform: the backing store and the pitch layer are whole device pixels.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (pitchLayer) g.drawImage(pitchLayer, 0, 0);
    const players = state.players;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.active !== 1) continue;
      pitchToRadar(L, p.x, p.z, pt);
      stamp(g, p.team !== 1 ? SPR_HOME : squaresAway ? SPR_AWAY_SQUARE : SPR_AWAY);
    }
    // Controlled players (humans only): a ring in the player colour.
    for (let c = 0; c < 2; c++) {
      const ctrl = state.ctrl[c];
      if (!ctrl || ctrl.kind !== ControllerKind.HUMAN || ctrl.slot < 0 || ctrl.slot >= players.length) continue;
      const p = players[ctrl.slot]!;
      pitchToRadar(L, p.x, p.z, pt);
      stamp(g, c === 0 ? SPR_RING_P1 : SPR_RING_P2);
    }
    const b = state.ball;
    pitchToRadar(L, b.x, b.z, pt);
    stamp(g, SPR_BALL);
    canvas.__radarDraws = (canvas.__radarDraws ?? 0) + 1;
  }

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      injectStyle('hud-shared', HUD_SHARED_CSS);
      injectStyle('hud-radar', CSS);
      ctxRef = ctx;
      canvas = h('canvas', { testId: 'radar-canvas', attrs: { 'aria-hidden': 'true' } });
      try {
        g = canvas.getContext('2d');
      } catch {
        g = null;
      }
      root = h('div', { class: 'hud-part hud-radar', testId: 'hud-radar', attrs: { role: 'img', 'aria-label': 'Radar' } }, canvas);
      root.hidden = true;
      shownHidden = true;
      parent.append(root);
      p1 = cssVar('--p1', p1);
      p2 = cssVar('--p2', p2);
      spritesDirty = true;
      enabled = radarEnabled(ctx.settings);
      unbindLarge = bindLargerHud(ctx, root, (large) => {
        hs = large ? HUD_LARGE_SCALE : 1;
        resize();
      });
      if (!pitchLayer) resize();
      if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);
      unPref = onRadarPref((on) => {
        enabled = on;
        syncHidden();
      });
      try {
        // Accessibility toggles (high-contrast kits, colour-blind markers) apply mid-match, e.g. from the pause menu.
        unSettings = ctx.settings.subscribe(() => {
          if (lastState) setColours(lastState);
        });
      } catch {
        unSettings = null;
      }
      syncHidden();
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      clubsRef = clubs;
      wornCache = null;
      lastState = state;
      lastTick = -1;
      acc[0] = RADAR_TUNING.redrawMs;
      if (ctxRef) enabled = radarEnabled(ctxRef.settings);
      setColours(state);
      syncHidden();
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void projector;
      if (!enabled || !visible || !g) return;
      if (!frame.paused) acc[0] = acc[0]! + (frame.dtMs > 0 ? frame.dtMs : 0);
      const a = acc[0]!;
      if (a < RADAR_TUNING.redrawMs && !dirty) return;
      if (state.tick === lastTick && !dirty) return;
      acc[0] = a >= 2 * RADAR_TUNING.redrawMs ? 0 : a % RADAR_TUNING.redrawMs;
      lastTick = state.tick;
      lastState = state;
      dirty = false;
      draw(state);
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      void events;
      void state;
    },
    setVisible(v: boolean) {
      visible = v;
      if (v && lastState && ctxRef) setColours(lastState);
      syncHidden();
    },
    dispose() {
      unbindLarge?.();
      unPref?.();
      unSettings?.();
      unbindLarge = unPref = unSettings = null;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      shownW = shownH = -1;
      root?.remove();
      root = canvas = null;
      g = null;
      pitchLayer = null;
      sprites.fill(null);
      spritesDirty = true;
      ctxRef = null;
      lastState = null;
    },
  };
}
