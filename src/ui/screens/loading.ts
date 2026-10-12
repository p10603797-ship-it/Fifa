/**
 * [UIX-05] Loading screen with control tips, shown while the session builds the match and the renderer warms up.
 * Back cancels the match. WAVE 0 version by FND-04.
 */
import type { AppContext, MatchSetup, Screen, ScreenParams } from '../../contracts/app';
import { h, injectStyle } from '../components';

const CSS = `
.loading-dots { display:flex; gap: 10px; }
.loading-dots span { width: 12px; height: 12px; border-radius: 50%; background: var(--ember); opacity: .25;
  animation: loading-pulse 1s infinite var(--ease); }
.loading-dots span:nth-child(2) { animation-delay: .15s; }
.loading-dots span:nth-child(3) { animation-delay: .3s; }
@keyframes loading-pulse { 50% { opacity: 1; transform: scale(1.15); } }
@media (prefers-reduced-motion: reduce) { .loading-dots span { animation: none; opacity: .8; } }
`;

const TIPS: Record<'touch' | 'pad' | 'keyboard', readonly string[]> = {
  touch: [
    'Touch: drag anywhere on the left half to run. Push further to sprint.',
    'Touch: Pass, Through and Shoot sit around the big button on the right.',
    'Touch: on defence the big button tackles; hold it to press.',
  ],
  pad: [
    'Controller: Cross / A passes, Circle / B shoots, Triangle / Y plays a through ball.',
    'Controller: hold R2 / RT to sprint; L1 / LB switches player on defence.',
    'Controller: Options / Menu pauses at any time.',
  ],
  keyboard: [
    'Keyboard: arrow keys or WASD to move, Escape to pause.',
    'Keyboard: see the README for the full key list.',
  ],
};

/** A control tip for the most recently used device kind. */
export function controlTip(ctx: AppContext, index: number): string {
  let kind: 'touch' | 'pad' | 'keyboard' = ctx.platform.isTouch ? 'touch' : 'keyboard';
  try {
    const last = ctx.devices.lastActive();
    const info = last ? ctx.devices.list().find((d) => d.id === last) : undefined;
    if (info) kind = info.kind;
  } catch {
    /* registry unavailable */
  }
  const list = TIPS[kind];
  return list[Math.abs(index) % list.length]!;
}

export function createLoadingScreen(): Screen {
  let ctxRef: AppContext | null = null;
  return {
    id: 'loading',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectStyle('loading', CSS);
      ctxRef = ctx;
      const setup = params.setup as MatchSetup | undefined;
      const home = setup ? ctx.clubs[setup.config.homeClub] : undefined;
      const away = setup ? ctx.clubs[setup.config.awayClub] : undefined;
      root.append(
        h('h1', { class: 'ui-title', text: home && away ? `${home.name} v ${away.name}` : 'Loading match', testId: 'loading-title' }),
        h('div', { class: 'loading-dots', attrs: { 'aria-hidden': 'true' } }, h('span'), h('span'), h('span')),
        h('p', { class: 'ui-subtitle', text: controlTip(ctx, setup ? setup.config.seed : 0) }),
      );
    },
    unmount() {
      ctxRef = null;
    },
    onBack() {
      ctxRef?.session.quit();
      return true;
    },
  };
}
