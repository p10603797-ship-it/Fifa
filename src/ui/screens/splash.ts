/**
 * [UIX-02] Splash: tap (or press) to start. The tap is the user gesture that unlocks audio. Shows an Add to Home
 * Screen hint on iPad in a Safari tab. WAVE 0 version by FND-04.
 */
import type { AppContext, Screen } from '../../contracts/app';
import { UiSound } from '../../contracts/app';
import { GAME_NAME } from '../../contracts/constants';
import { createButton, h, injectStyle } from '../components';

const CSS = `
.screen--splash { cursor: pointer; }
.splash-logo { display:flex; align-items:center; gap: var(--space-4); }
.splash-dot { width: 44px; height: 44px; border-radius: 50%; background: var(--ember); box-shadow: 0 0 40px rgba(255,107,53,.45); }
.splash-name { margin:0; font-size: var(--fs-hero); font-weight: 700; letter-spacing: -0.02em; }
.splash-hint { position:absolute; bottom: calc(var(--safe-bottom, 0px) + var(--space-6)); }
`;

export function createSplashScreen(): Screen {
  let cleanup: (() => void) | null = null;
  return {
    id: 'splash',
    mount(root: HTMLElement, ctx: AppContext) {
      injectStyle('splash', CSS);
      root.classList.add('screen--splash');
      let started = false;
      const start = (): void => {
        if (started) return;
        started = true;
        // Must stay synchronous inside the gesture: the AudioContext is created before any await.
        ctx.audio.unlock().catch(() => undefined);
        ctx.audio.playUi(UiSound.START);
        ctx.router.replace('main');
      };
      root.append(
        h('div', { class: 'splash-logo' }, h('div', { class: 'splash-dot' }), h('h1', { class: 'splash-name', text: GAME_NAME })),
        createButton('Tap to start', start, { testId: 'splash-start', variant: 'primary', autofocus: true }),
      );
      const s = ctx.settings.get();
      if (ctx.platform.isIPad && !ctx.platform.isStandalone && !s.homeScreenHintShown) {
        root.append(h('p', { class: 'ui-note splash-hint', text: 'For full screen: Share, then Add to Home Screen.' }));
      }
      // Tap anywhere; controllers and keyboards confirm the focused button through the menu input.
      const onTap = (): void => start();
      root.addEventListener('click', onTap);
      cleanup = () => {
        root.removeEventListener('click', onTap);
      };
    },
    unmount() {
      cleanup?.();
      cleanup = null;
    },
    onBack() {
      return true;
    },
  };
}
