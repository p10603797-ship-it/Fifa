/**
 * [UIX-10] Half-time screen (over the match). WAVE 0 version by FND-04: score and Continue, which sends SKIP into
 * the acting human's next frame; the session returns to the match screen when the sim leaves HALF_TIME.
 * UIX-10 adds first-half stats.
 */
import type { AppContext, Screen } from '../../contracts/app';
import { Command } from '../../contracts/enums';
import { uiHumanOf } from '../../app/session';
import { createButton, h } from '../components';

/** "AAA 1 - 0 BBB" for the current match, or '' outside a match. */
export function scoreLine(ctx: AppContext): string {
  const s = ctx.session.getState();
  if (!s) return '';
  const home = ctx.clubs[s.teams[0]!.clubIdx];
  const away = ctx.clubs[s.teams[1]!.clubIdx];
  return `${home?.code ?? 'HOM'}  ${s.teams[0]!.goals} - ${s.teams[1]!.goals}  ${away?.code ?? 'AWY'}`;
}

/** Skip the current cut-scene (half-time, full-time interim) for the acting human. */
export function sendSkip(ctx: AppContext): void {
  const h0 = uiHumanOf(ctx);
  ctx.session.queueCommand(h0 >= 0 ? h0 : 0, Command.SKIP, 0);
}

export function createHalfTimeScreen(): Screen {
  let ctxRef: AppContext | null = null;
  return {
    id: 'half-time',
    mount(root: HTMLElement, ctx: AppContext) {
      ctxRef = ctx;
      root.classList.add('screen--overlay');
      root.append(
        h('h1', { class: 'ui-title', text: 'Half time', testId: 'half-time-title' }),
        h('p', { class: 'ui-subtitle num', text: scoreLine(ctx), testId: 'half-time-score' }),
        createButton('Continue', () => sendSkip(ctx), { testId: 'ht-continue', variant: 'primary', autofocus: true, ctx }),
      );
    },
    unmount() {
      ctxRef = null;
    },
    onBack() {
      if (ctxRef) sendSkip(ctxRef);
      return true;
    },
  };
}
