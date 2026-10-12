/**
 * [UIX-10] Full-time screen. WAVE 0 version by FND-04.
 * params.final false (FULL_TIME phase): score + Continue (SKIP). params.final true (after POST_MATCH): score,
 * basic stats from params.summary, Rematch / Change Teams / Quit. UIX-10 adds full stats and player of the match.
 */
import type { AppContext, MatchSummary, Screen, ScreenParams } from '../../contracts/app';
import { createButton, h, injectStyle } from '../components';
import { scoreLine, sendSkip } from './halfTime';

const CSS = `
.ft-stats { display:grid; grid-template-columns: 1fr auto 1fr; gap: var(--space-2) var(--space-5); font-size: var(--fs-sm); }
.ft-stats .l { text-align:right; } .ft-stats .m { color: var(--text-3); text-align:center; }
`;

function statsGrid(summary: MatchSummary): HTMLElement {
  const grid = h('div', { class: 'ft-stats num', testId: 'ft-stats' });
  const [a, b] = summary.teams;
  const rows: [string, string, string][] = [
    [String(a.shots), 'Shots', String(b.shots)],
    [String(a.shotsOnTarget), 'On target', String(b.shotsOnTarget)],
    [`${Math.round(a.possession * 100)}%`, 'Possession', `${Math.round(b.possession * 100)}%`],
  ];
  for (const [l, m, r] of rows) grid.append(h('span', { class: 'l', text: l }), h('span', { class: 'm', text: m }), h('span', { text: r }));
  return grid;
}

export function createFullTimeScreen(): Screen {
  let ctxRef: AppContext | null = null;
  let final = false;
  return {
    id: 'full-time',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectStyle('full-time', CSS);
      ctxRef = ctx;
      final = params.final === true;
      root.classList.add('screen--overlay');
      root.append(
        h('h1', { class: 'ui-title', text: 'Full time', testId: 'full-time-title' }),
        h('p', { class: 'ui-subtitle num', text: scoreLine(ctx), testId: 'full-time-score' }),
      );
      if (!final) {
        root.append(createButton('Continue', () => sendSkip(ctx), { testId: 'ft-continue', variant: 'primary', autofocus: true, ctx }));
        return;
      }
      const summary = (params.summary as MatchSummary | null | undefined) ?? null;
      if (summary) root.append(statsGrid(summary));
      root.append(
        h(
          'div',
          { class: 'ui-row' },
          createButton('Rematch', () => ctx.session.restart(), { testId: 'ft-rematch', variant: 'primary', autofocus: true, ctx }),
          createButton('Change teams', () => {
            ctx.session.quit();
            ctx.router.go('team-select');
          }, { testId: 'ft-change-teams', ctx }),
          createButton('Quit', () => ctx.session.quit(), { testId: 'ft-quit', ctx }),
        ),
      );
    },
    unmount() {
      ctxRef = null;
    },
    onBack() {
      const ctx = ctxRef;
      if (!ctx) return false;
      if (final) ctx.session.quit();
      else sendSkip(ctx);
      return true;
    },
  };
}
