/**
 * [UIX-05] Loading screen with control tips (BRIEF §12 Screens: "Loading with control tips"). The session
 * (app/session.ts) shows it with { setup } while it builds the match and the renderer warms up, and replaces it with
 * 'match' the moment the match is ready: this screen never waits on its own (no minimum time, no "press to start").
 * Back cancels the match (session.quit, back to the main menu).
 *
 * Shows the fixture (crests, codes, P1 / P2 or CPU per side), a progress bar (an eased estimate that never reaches
 * the end before the match is ready; drawn with transform only and written only when it moves) and control tips
 * for the device player 1 uses (the first device of human 0's binding, else the most recently used one): touch tips,
 * controller tips with the pad family's button glyphs (PAD-07 pad/glyphs.ts) or keyboard tips. Tips rotate every
 * TIP_MS with an opacity / transform fade.
 */
import type { AppContext, DeviceInfo, FrameInfo, MatchSetup, Screen, ScreenParams } from '../../contracts/app';
import { ControllerKind, PadFamily } from '../../contracts/enums';
import { buttonLabel, glyph } from '../../input/pad/glyphs';
import { PadButton } from '../../input/pad/manager';
import { crestDataUrl } from '../../render/kits';
import { h, injectStyle } from '../components';

/** Time each tip stays on screen, ms. */
export const TIP_MS = 4200;
/** Time constant of the progress estimate, ms (63 % after this long). */
export const PROGRESS_TAU_MS = 900;
/** The estimate never passes this before the match is ready. */
export const PROGRESS_CAP = 0.92;

export type TipKind = 'touch' | 'pad' | 'keyboard';
/** A tip: text runs and pad buttons (standard-mapping indices, drawn as the family's glyph). */
export type TipPart = string | { btn: number };
export type Tip = readonly TipPart[];

const B = PadButton;

export const TIPS: Readonly<Record<TipKind, readonly Tip[]>> = {
  touch: [
    ['Drag anywhere on the left half to run; push further to sprint. Let go to stop.'],
    ['PASS, THROUGH and SHOOT fan out around the big button; hold any of them for more power.'],
    ['Swipe a button for its variant: SHOOT up chips the keeper, down curls a finesse shot.'],
    ['On defence the big button tackles when you are goal-side; hold it to sprint and press.'],
    ['Tap the pitch to pass to that spot, or swipe from a player toward goal to shoot.'],
  ],
  pad: [
    [{ btn: B.SOUTH }, ' ground pass, ', { btn: B.WEST }, ' lob or cross, ', { btn: B.NORTH }, ' through ball, ', { btn: B.EAST }, ' shoot.'],
    ['Hold ', { btn: B.R2 }, ' to sprint; hold ', { btn: B.L2 }, ' to shield the ball or jockey.'],
    [{ btn: B.R1 }, ' + ', { btn: B.EAST }, ' finesse shot; ', { btn: B.L1 }, ' + ', { btn: B.EAST }, ' chip shot.'],
    ['On defence ', { btn: B.L1 }, ' switches player, ', { btn: B.EAST }, ' tackles, ', { btn: B.WEST }, ' slides, hold ', { btn: B.SOUTH }, ' to contain.'],
    [{ btn: B.START }, ' pauses. Only the player who paused can resume.'],
  ],
  keyboard: [
    ['Arrow keys or WASD move; hold Shift to sprint.'],
    ['J passes, U lobs or crosses, I plays a through ball, K shoots.'],
    ['Q switches player on defence; K tackles; C shields the ball.'],
    ['Escape or P pauses the match.'],
  ],
};

/** Device of player 1: the first device of human 0's binding (wildcards skipped), else the most recently used. */
export function playerDevice(ctx: AppContext, setup: MatchSetup | null | undefined): DeviceInfo | null {
  let list: DeviceInfo[] = [];
  try {
    list = ctx.devices.list();
  } catch {
    /* registry unavailable */
  }
  if (setup) {
    const b = setup.bindings.slice().sort((x, y) => x.human - y.human)[0];
    if (b) {
      for (const id of b.deviceIds) {
        const d = list.find((x) => x.id === id);
        if (d) return d;
      }
    }
  }
  try {
    const last = ctx.devices.lastActive();
    const d = last ? list.find((x) => x.id === last) : undefined;
    if (d) return d;
  } catch {
    /* registry unavailable */
  }
  return null;
}

/** Tip set for player 1's device (touch on a touch device when nothing better is known, else keyboard). */
export function tipKindFor(ctx: AppContext, setup: MatchSetup | null | undefined): TipKind {
  const d = playerDevice(ctx, setup);
  if (d) return d.kind;
  return ctx.platform.isTouch ? 'touch' : 'keyboard';
}

/** Plain text of a tip with the family's button names (also the accessible text). */
export function tipText(tip: Tip, family: PadFamily = PadFamily.XBOX): string {
  let s = '';
  for (const p of tip) s += typeof p === 'string' ? p : buttonLabel(family, p.btn);
  return s;
}

/** A control tip (plain text) for player 1's device of the setup, else the most recently used device. */
export function controlTip(ctx: AppContext, index: number, setup?: MatchSetup | null): string {
  const kind = tipKindFor(ctx, setup);
  const list = TIPS[kind];
  const fam = playerDevice(ctx, setup)?.family ?? PadFamily.XBOX;
  return tipText(list[Math.abs(Math.trunc(index)) % list.length]!, fam);
}

/** Progress estimate 0..PROGRESS_CAP for the time since loading started (ms). Pure, monotonic. */
export function loadingProgress(elapsedMs: number): number {
  const t = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  return PROGRESS_CAP * (1 - Math.exp(-t / PROGRESS_TAU_MS));
}

const CSS = `
.screen.ld { gap: var(--space-6); }
.ld-fixture { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: var(--space-6);
  width: min(760px, 100%); }
.ld-team { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); min-width: 0; text-align: center; }
.ld-team img { width: 88px; height: 88px; display: block; }
.ld-code { font: 600 var(--fs-xl) / 1 var(--font-num); letter-spacing: 0.04em; }
.ld-name { font-size: var(--fs-sm); color: var(--text-2); max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-who { font: 700 var(--fs-xs) / 1 var(--font-ui); letter-spacing: 0.06em; color: var(--text-3); }
.ld-who .p1 { color: var(--p1); }
.ld-who .p2 { color: var(--p2); }
.ld-vs { font-size: var(--fs-md); color: var(--text-3); }
.ld-bar { width: min(420px, 80%); height: 4px; border-radius: 2px; background: var(--surface-3); overflow: hidden; }
.ld-bar-fill { height: 100%; background: var(--ember); transform-origin: left center; transform: scaleX(0); }
.ld-tip { display: flex; flex-direction: column; align-items: center; gap: var(--space-3); max-width: 44em; min-height: 96px; }
.ld-tip-text { margin: 0; font-size: var(--fs-md); line-height: 1.5; color: var(--text-1); text-align: center;
  animation: ld-tip-in var(--dur-slow) var(--ease); }
.ld-glyph { display: inline-flex; vertical-align: -0.35em; width: 1.6em; height: 1.6em; margin: 0 2px; }
.ld-glyph svg { width: 100%; height: 100%; }
@keyframes ld-tip-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .ld-tip-text { animation: none; } }
@media (max-height: 560px) {
  .screen.ld { gap: var(--space-4); }
  .ld-team img { width: 56px; height: 56px; }
  .ld-code { font-size: var(--fs-lg); }
}
`;

function whoPlays(setup: MatchSetup, side: number): HTMLElement {
  const el = h('span', { class: 'ld-who' });
  const parts: HTMLElement[] = [];
  setup.config.humans.forEach((hc, i) => {
    if (hc.kind === ControllerKind.HUMAN && hc.side === side) parts.push(h('span', { class: i === 0 ? 'p1' : 'p2', text: `P${i + 1}` }));
  });
  if (parts.length === 0) el.textContent = 'CPU';
  else parts.forEach((p, i) => el.append(...(i > 0 ? [' + ', p] : [p])));
  return el;
}

function renderTip(tip: Tip, family: PadFamily): HTMLElement {
  const p = h('p', { class: 'ld-tip-text', testId: 'loading-tip', attrs: { 'aria-label': tipText(tip, family) } });
  for (const part of tip) {
    if (typeof part === 'string') {
      p.append(part);
      continue;
    }
    const g = glyph(family, part.btn);
    const s = h('span', { class: 'ld-glyph', attrs: { 'aria-hidden': 'true', title: g.label } });
    s.innerHTML = g.svg;
    p.append(s);
  }
  return p;
}

export function createLoadingScreen(): Screen {
  let ctxRef: AppContext | null = null;
  let tick: ((f: FrameInfo) => void) | null = null;
  return {
    id: 'loading',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectStyle('loading', CSS);
      root.classList.add('ld');
      ctxRef = ctx;
      const setup = (params?.setup as MatchSetup | undefined) ?? null;
      const home = setup ? ctx.clubs[setup.config.homeClub] : undefined;
      const away = setup ? ctx.clubs[setup.config.awayClub] : undefined;
      const kind = tipKindFor(ctx, setup);
      const device = playerDevice(ctx, setup);
      const family = device && device.kind === 'pad' ? device.family : PadFamily.XBOX;
      const tips = TIPS[kind];
      const first = setup ? setup.config.seed >>> 0 : 0;

      const team = (club: typeof home, side: number): HTMLElement =>
        h('div', { class: 'ld-team' },
          club ? h('img', { attrs: { src: crestDataUrl(club), alt: '', draggable: 'false' } }) : null,
          h('span', { class: 'ld-code', text: club ? club.code : side === 0 ? 'HOME' : 'AWAY' }),
          h('span', { class: 'ld-name', text: club ? club.name : '' }),
          setup ? whoPlays(setup, side) : null);

      const fill = h('div', { class: 'ld-bar-fill' });
      const bar = h('div', { class: 'ld-bar', testId: 'loading-progress', attrs: { role: 'progressbar', 'aria-label': 'Loading', 'aria-valuemin': '0', 'aria-valuemax': '100' } }, fill);
      const tipBox = h('div', { class: 'ld-tip', attrs: { 'aria-live': 'polite' } }, h('p', { class: 'eyebrow', text: kind === 'pad' ? 'Controller tips' : kind === 'touch' ? 'Touch tips' : 'Keyboard tips', testId: 'loading-tip-kind' }));
      let tipIdx = -1;
      const showTip = (i: number): void => {
        tipIdx = i;
        const old = tipBox.querySelector('.ld-tip-text');
        const el = renderTip(tips[i % tips.length]!, family);
        el.dataset.kind = kind;
        if (old) old.replaceWith(el);
        else tipBox.append(el);
      };
      showTip(first % tips.length);

      root.append(
        h('h1', { class: 'ui-title', text: home && away ? `${home.name} v ${away.name}` : 'Loading match', testId: 'loading-title', attrs: { style: 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)' } }),
        h('div', { class: 'ld-fixture' }, team(home, 0), h('span', { class: 'ld-vs', text: 'v' }), team(away, 1)),
        bar,
        tipBox,
      );

      let t0 = -1;
      let shown = -1;
      let step = 0;
      tick = (f) => {
        if (t0 < 0) t0 = f.nowMs;
        const el = f.nowMs - t0;
        const loaded = (ctx.session as unknown as { loaded?: boolean }).loaded === true;
        const p = loaded ? 1 : loadingProgress(el);
        if (Math.abs(p - shown) >= 0.005) {
          shown = p;
          fill.style.transform = `scaleX(${p.toFixed(3)})`;
          bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
        }
        const s = Math.floor(el / TIP_MS);
        if (s !== step) {
          step = s;
          showTip((tipIdx + 1) % tips.length);
        }
      };
    },
    unmount() {
      ctxRef = null;
      tick = null;
    },
    onBack() {
      ctxRef?.session.quit();
      return true;
    },
    onFrame(frame) {
      tick?.(frame);
    },
  };
}
