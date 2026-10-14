/**
 * [UIX-05] Mode setup (BRIEF §11 Modes, §12 Screens: Mode setup -> Team and kit select -> Side select -> Match
 * settings -> Loading).
 *
 * Layout (original): the list of modes on the left (the one from params.mode selected), a panel on the right with
 * what the selected mode is, the steps that follow and its action:
 *   Kick-Off      -> 'team-select' { mode, setup }   (then side select, match settings)          [mode-continue]
 *   Play a Friend -> Same iPad: 'team-select' { mode: FRIEND_LOCAL, setup }                     [mode-friend-local]
 *                    Online:    'online-lobby' (NET-07)                                          [mode-friend-online]
 *   Shoot-out     -> 'team-select' { mode: SHOOT_OUT, setup }  (match starts in SHOOT_OUT)      [mode-continue]
 *   Cup           -> 'cup' (UIX-11)                                                             [mode-continue]
 *   Practice      -> 'practice' (UIX-11)                                                        [mode-continue]
 * The flow params (matchFlow.ts) start from the saved match defaults.
 *
 * Touch: tap a mode, then its action. Controller / keyboard: the mode list is a vertical focus group; Confirm on a
 * mode selects it and moves focus to its action; the action has the initial focus so Kick-Off from the main menu is
 * one more Confirm. L1 / R1 (Q / E) step through the modes. Back returns to the main menu.
 */
import type { AppContext, Screen, ScreenId, ScreenParams } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import { ModeId } from '../../contracts/enums';
import { createButton, h, injectStyle, setSelected } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import { FLOW_STEPS, STEP_LABELS, createFlowTop, injectFlowStyle, isFlowMode, newFlow, type FlowMode } from './matchFlow';

/** One mode on the mode setup screen. */
export interface ModeEntry {
  readonly mode: ModeId;
  readonly label: string;
  readonly detail: string;
  readonly testId: string;
  /** Screen opened by the action for modes outside the local flow. */
  readonly route?: ScreenId;
  /** Action label. */
  readonly action: string;
}

export const MODE_ENTRIES: readonly ModeEntry[] = [
  {
    mode: ModeId.KICK_OFF, label: 'Kick-Off', testId: 'mode-kickoff', action: 'Choose teams',
    detail: 'You against the CPU. Pick teams and kits, choose your side, then set difficulty, half length and rules.',
  },
  {
    mode: ModeId.FRIEND_LOCAL, label: 'Play a Friend', testId: 'mode-friend', action: 'Same iPad',
    detail: '1v1 with a friend: on this iPad (controller v controller, or touch v controller), or online with a room code.',
  },
  {
    mode: ModeId.SHOOT_OUT, label: 'Shoot-out', testId: 'mode-shootout', action: 'Choose teams',
    detail: 'Straight to penalties. Pick the teams and who takes which side.',
  },
  {
    mode: ModeId.CUP, label: 'Cup', testId: 'mode-cup', route: 'cup', action: 'Open the Cup',
    detail: 'An 8- or 16-team knockout against bots, for one or two players. Progress saves.',
  },
  {
    mode: ModeId.PRACTICE, label: 'Practice', testId: 'mode-practice', route: 'practice', action: 'Open Practice',
    detail: 'Free play against a keeper with no clock, set-piece practice and a guided tutorial.',
  },
];

/** Entry for a mode param (unknown: Kick-Off). */
export function modeEntryFor(mode: unknown): ModeEntry {
  const m = mode === ModeId.FRIEND_ONLINE ? ModeId.FRIEND_LOCAL : mode;
  return MODE_ENTRIES.find((e) => e.mode === m) ?? MODE_ENTRIES[0]!;
}

/** Where the primary action of a mode leads: [screen, params]. Friend online is 'online-lobby'. */
export function modeRoute(ctx: AppContext, mode: ModeId, online = false): [ScreenId, ScreenParams] {
  if (mode === ModeId.FRIEND_LOCAL && online) return ['online-lobby', {}];
  if (isFlowMode(mode)) {
    const flow = newFlow(ctx, mode);
    return [FLOW_STEPS[flow.mode][0]!, { mode: flow.mode, setup: flow.setup }];
  }
  const e = MODE_ENTRIES.find((x) => x.mode === mode);
  return [e?.route ?? 'main', {}];
}

const CSS = `
.ms-layout { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(240px, 0.8fr) minmax(0, 1.2fr);
  gap: var(--space-6); align-items: stretch; width: 100%; max-width: 1100px; margin: 0 auto; }
.ms-list { display: flex; flex-direction: column; gap: var(--space-2); min-height: 0; overflow: auto; padding: 4px; }
.btn.ms-mode { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); text-align: left;
  min-height: var(--target); padding: 0 var(--space-5); background: var(--surface-1); border: 1px solid var(--hairline); }
.btn.ms-mode[data-selected] { border-color: var(--ember); background: var(--ember-tint); }
.ms-mode-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hairline-strong); flex: 0 0 auto; }
.btn.ms-mode[data-selected] .ms-mode-dot { background: var(--ember); }
.ms-panel { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6); min-height: 0; overflow: auto;
  background: var(--surface-1); border: 1px solid var(--hairline); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
.ms-panel h2 { margin: 0; font-size: var(--fs-xl); }
.ms-detail { margin: 0; color: var(--text-2); font-size: var(--fs-md); max-width: 36em; }
.ms-flow { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; }
.ms-flow li { display: flex; align-items: center; gap: var(--space-2); padding: 6px var(--space-3); border-radius: var(--radius-pill);
  border: 1px solid var(--hairline); color: var(--text-2); font-size: var(--fs-sm); }
.ms-flow .num { color: var(--text-3); font-size: var(--fs-xs); }
.ms-actions { margin-top: auto; display: flex; flex-wrap: wrap; gap: var(--space-3); }
.ms-actions .btn { min-width: calc(var(--target) * 3.2); }
@media (max-height: 560px) {
  .ms-panel { padding: var(--space-4); gap: var(--space-3); }
  .ms-panel h2 { font-size: var(--fs-lg); }
  .ms-detail { font-size: var(--fs-sm); }
}
`;

export function createModeSetupScreen(): Screen {
  let detachDots: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  return {
    id: 'mode-setup',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectFlowStyle();
      injectStyle('mode-setup', CSS);
      root.classList.add('flow');
      detachDots = attachDotField(root);
      let current = modeEntryFor(params?.mode);

      const open = (online: boolean): void => {
        const [id, p] = modeRoute(ctx, current.mode, online);
        ctx.router.go(id, p);
      };

      const panel = h('section', { class: 'ms-panel', testId: 'mode-panel', attrs: { 'aria-live': 'polite' } });
      const rows: HTMLButtonElement[] = [];
      let primary: HTMLButtonElement | null = null;

      const renderPanel = (): void => {
        const e = current;
        const parts: Node[] = [h('h2', { text: e.label, testId: 'mode-panel-title' }), h('p', { class: 'ms-detail', text: e.detail })];
        if (isFlowMode(e.mode)) {
          const steps = h('ol', { class: 'ms-flow', attrs: { 'aria-label': 'What follows' } });
          FLOW_STEPS[e.mode as FlowMode].forEach((s, i) => {
            steps.append(h('li', {}, h('span', { class: 'num', text: String(i + 1) }), h('span', { text: STEP_LABELS[s] ?? s })));
          });
          parts.push(h('p', { class: 'eyebrow', text: 'What follows' }), steps);
        }
        const actions = h('div', { class: 'ms-actions' });
        if (e.mode === ModeId.FRIEND_LOCAL) {
          primary = createButton('Same iPad', () => open(false), {
            testId: 'mode-friend-local', variant: 'primary', size: 'lg', ctx, autofocus: true,
            hint: 'Controller v controller, or touch v controller',
          });
          actions.append(primary, createButton('Online', () => open(true), {
            testId: 'mode-friend-online', size: 'lg', ctx, hint: 'Play with a room code',
          }));
        } else {
          primary = createButton(e.action, () => open(false), { testId: 'mode-continue', variant: 'primary', size: 'lg', ctx, autofocus: true });
          actions.append(primary);
        }
        parts.push(actions);
        panel.replaceChildren(...parts);
        for (let i = 0; i < rows.length; i++) setSelected(rows[i]!, MODE_ENTRIES[i] === e);
      };

      const select = (e: ModeEntry, focusAction: boolean): void => {
        current = e;
        renderPanel();
        if (focusAction && primary) ctx.focus.focus(primary);
      };

      const list = h('nav', { class: 'ms-list', attrs: { 'aria-label': 'Modes', 'data-focus-group': 'y' } });
      for (const e of MODE_ENTRIES) {
        const b = createButton(e.label, () => select(e, true), { testId: e.testId, ctx, sound: UiSound.MOVE, extraClass: 'ms-mode' });
        b.replaceChildren(h('span', { text: e.label }), h('span', { class: 'ms-mode-dot', attrs: { 'aria-hidden': 'true' } }));
        rows.push(b);
        list.append(b);
      }
      renderPanel();

      root.append(
        createFlowTop({ ctx, title: 'Choose a mode', eyebrow: 'New match', testId: 'mode-setup-title' }),
        h('div', { class: 'ms-layout' }, list, panel),
      );

      const off = ctx.focus.onAction((a) => {
        if (a !== MenuAction.TAB_PREV && a !== MenuAction.TAB_NEXT) return false;
        const i = MODE_ENTRIES.indexOf(current);
        const n = MODE_ENTRIES.length;
        const j = (i + (a === MenuAction.TAB_NEXT ? 1 : -1) + n) % n;
        try {
          ctx.audio.playUi(UiSound.MOVE);
        } catch {
          /* audio never breaks a menu */
        }
        select(MODE_ENTRIES[j]!, true);
        return true;
      });
      cleanup = off;
    },
    unmount() {
      cleanup?.();
      cleanup = null;
      detachDots?.();
      detachDots = null;
    },
    onFrame(frame) {
      if (detachDots) sharedDotField().frame(frame.nowMs);
    },
  };
}
