/**
 * [UIX-02] Main menu. WAVE 0 version by FND-04: Kick-Off starts the default local match (modes/setup.ts
 * defaultSetup); the other entries open their (placeholder) screens.
 */
import type { AppContext, Screen } from '../../contracts/app';
import { GAME_NAME } from '../../contracts/constants';
import { defaultSetup } from '../../modes/setup';
import { createButton, h, injectStyle } from '../components';

const CSS = `
.main-menu { display:grid; grid-template-columns: repeat(2, minmax(200px, 1fr)); gap: var(--space-4); }
.main-menu .btn--primary { grid-column: 1 / -1; min-height: 76px; font-size: var(--fs-lg); }
.main-brand { display:flex; align-items:center; gap: var(--space-3); }
.main-dot { width: 22px; height: 22px; border-radius: 50%; background: var(--ember); }
`;

export function createMainScreen(): Screen {
  return {
    id: 'main',
    mount(root: HTMLElement, ctx: AppContext) {
      injectStyle('main-menu', CSS);
      const go = (id: Parameters<AppContext['router']['go']>[0]) => () => ctx.router.go(id);
      const kickOff = (): void => {
        if (ctx.session.active) return;
        ctx.audio.unlock().catch(() => undefined);
        ctx.session.start(defaultSetup(ctx));
      };
      const grid = h(
        'div',
        { class: 'main-menu' },
        createButton('Kick-Off', kickOff, { testId: 'main-kickoff', variant: 'primary', autofocus: true, ctx }),
        createButton('Modes', go('mode-setup'), { testId: 'main-modes', ctx }),
        createButton('Practice', go('practice'), { testId: 'main-practice', ctx }),
        createButton('Cup', go('cup'), { testId: 'main-cup', ctx }),
        createButton('Online', go('online-lobby'), { testId: 'main-online', ctx }),
        createButton('Settings', go('settings'), { testId: 'main-settings', ctx }),
        createButton('Diagnostics', go('diagnostics'), { testId: 'main-diagnostics', ctx }),
      );
      root.append(
        h('div', { class: 'main-brand' }, h('div', { class: 'main-dot' }), h('h1', { class: 'ui-title', text: GAME_NAME, testId: 'main-title' })),
        grid,
      );
    },
    unmount() {
      /* DOM is removed by the router */
    },
    onBack() {
      return true; // root screen
    },
  };
}
