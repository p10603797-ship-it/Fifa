/**
 * [UIX-11] Practice screen (BRIEF §11 "Practice: Free play against a keeper with no clock, set-piece practice, and a
 * guided tutorial for whichever input device is in use"). Logic: modes/practice.ts (MOD-04).
 *
 * Left: the five entries (Free play, Free kicks, Corners, Penalties, Tutorial). Right: what the selected entry does,
 * the spot picker for free kicks and corners (MOD-04 PRACTICE_SPOTS) and the primary action:
 *  - Free play / Free kicks / Corners / Penalties -> ctx.session.start(buildPracticeSetup(ctx, kind, { spot })). Quitting
 *    the practice from the pause menu comes back here with the same entry and spot selected.
 *  - Tutorial -> the tutorial screen (UIX-12) for the device used last; it starts its own practice session.
 * L1 / R1 (Q / E) step through the entries. Every control is a [data-focus] button of at least 60 pt (touch alone and
 * controller alone; Back always works).
 */
import type { AppContext, Screen, ScreenParams } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import {
  GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH,
  PENALTY_SPOT_DIST,
} from '../../contracts/constants';
import { PracticeKind } from '../../contracts/enums';
import { buildPracticeSetup, clampSpot, PRACTICE_SPOTS, tutorialDeviceFor, type TutorialDevice } from '../../modes/practice';
import { createButton, createSegmented, createSelector, h, injectStyle, setSelected } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import { createFlowTop, injectFlowStyle } from './matchFlow';

export interface PracticeEntry {
  kind: PracticeKind;
  label: string;
  testId: string;
  detail: string;
  action: string;
}

export const PRACTICE_ENTRIES: readonly PracticeEntry[] = [
  {
    kind: PracticeKind.FREE_PLAY, label: 'Free play', testId: 'practice-free-play', action: 'Start free play',
    detail: 'Your whole team against the opposition keeper. No clock, no pressure: dribble, pass and shoot as often as you like.',
  },
  {
    kind: PracticeKind.FREE_KICKS, label: 'Free kicks', testId: 'practice-free-kicks', action: 'Start free kicks',
    detail: 'The same free kick again and again, with a wall and a keeper. Pick the spot, then bend it, drive it or chip it.',
  },
  {
    kind: PracticeKind.CORNERS, label: 'Corners', testId: 'practice-corners', action: 'Start corners',
    detail: 'Corner after corner from the side you choose. Cross to the near or far post, or play it short.',
  },
  {
    kind: PracticeKind.PENALTIES, label: 'Penalties', testId: 'practice-penalties', action: 'Start penalties',
    detail: 'Spot kick after spot kick against the keeper. Pick a corner, set the power, keep your nerve.',
  },
  {
    kind: PracticeKind.TUTORIAL, label: 'Tutorial', testId: 'practice-tutorial', action: 'Open the tutorial',
    detail: 'A guided tour of the controls, step by step, for the device you are using.',
  },
];

const DEVICE_LABEL: Readonly<Record<TutorialDevice, string>> = { touch: 'touch', pad: 'controller', keyboard: 'keyboard' };

/** Last entry and spot (kept while the app runs, so Practice reopens where the player left it). */
const last = { kind: PracticeKind.FREE_PLAY as PracticeKind, spot: 0 };

const CSS = `
.screen.practice { justify-content: flex-start; align-items: stretch; gap: var(--space-4); }
.pr-layout { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(240px, 0.8fr) minmax(0, 1.2fr);
  gap: var(--space-6); align-items: stretch; width: 100%; max-width: 1100px; margin: 0 auto; }
.pr-list { display: flex; flex-direction: column; gap: var(--space-2); min-height: 0; overflow: auto; padding: 4px; }
.btn.pr-entry { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); text-align: left;
  min-height: var(--target); padding: 0 var(--space-5); background: var(--surface-1); border: 1px solid var(--hairline); }
.btn.pr-entry[data-selected] { border-color: var(--ember); background: var(--ember-tint); }
.pr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hairline-strong); flex: 0 0 auto; }
.btn.pr-entry[data-selected] .pr-dot { background: var(--ember); }
.pr-panel { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-6); min-height: 0; overflow: auto;
  background: var(--surface-1); border: 1px solid var(--hairline); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
.pr-panel h2 { margin: 0; font-size: var(--fs-xl); }
.pr-detail { margin: 0; color: var(--text-2); font-size: var(--fs-md); max-width: 36em; }
.pr-note { margin: 0; color: var(--text-3); font-size: var(--fs-sm); }
.pr-map { width: 100%; max-width: 420px; height: auto; max-height: 34vh; align-self: flex-start; }
.pr-map .ln { fill: none; stroke: var(--hairline-strong); stroke-width: 0.35; }
.pr-map .turf { fill: var(--surface-2); stroke: none; }
.pr-map .goal { fill: none; stroke: var(--text-3); stroke-width: 0.5; }
.pr-map .spot { fill: var(--ember); }
.pr-map .ring { fill: none; stroke: var(--ember); stroke-width: 0.4; opacity: 0.6; }
.pr-map .gk { fill: var(--text-2); }
.pr-map .mate { fill: var(--ember); opacity: 0.55; }
.pr-actions { margin-top: auto; display: flex; flex-wrap: wrap; gap: var(--space-3); }
.pr-actions .btn { min-width: calc(var(--target) * 3.2); }
@media (max-height: 600px) {
  .pr-panel { padding: var(--space-4); gap: var(--space-3); }
  .pr-panel h2 { font-size: var(--fs-lg); }
  .pr-detail { font-size: var(--fs-sm); }
  .pr-note { display: none; }
  .pr-map { display: none; }
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k of Object.keys(attrs)) el.setAttribute(k, String(attrs[k]));
  return el;
}

/**
 * Top-down map of the attacking half (goal on the right; the attacker's right is down) with the practice spot for set
 * pieces, or the lone keeper for free play. Decorative (aria-hidden); the spot picker carries the information.
 */
export function practiceMap(kind: PracticeKind, spot: number): SVGElement | null {
  if (kind === PracticeKind.TUTORIAL || typeof document === 'undefined') return null;
  const L = HALF_LENGTH;
  const W = HALF_WIDTH;
  const root = svg('svg', { class: 'pr-map', viewBox: `-2 ${-W - 2} ${L + 6} ${2 * W + 4}`, 'aria-hidden': 'true', 'data-testid': 'practice-map' });
  root.append(
    svg('rect', { class: 'turf', x: 0, y: -W, width: L, height: 2 * W, rx: 1 }),
    svg('rect', { class: 'ln', x: 0, y: -W, width: L, height: 2 * W }),
    svg('rect', { class: 'ln', x: L - PENALTY_AREA_DEPTH, y: -PENALTY_AREA_HALF_WIDTH, width: PENALTY_AREA_DEPTH, height: 2 * PENALTY_AREA_HALF_WIDTH }),
    svg('rect', { class: 'ln', x: L - GOAL_AREA_DEPTH, y: -GOAL_AREA_HALF_WIDTH, width: GOAL_AREA_DEPTH, height: 2 * GOAL_AREA_HALF_WIDTH }),
    svg('path', { class: 'ln', d: `M 0 -9.15 A 9.15 9.15 0 0 1 0 9.15` }),
    svg('path', { class: 'ln', d: `M ${L - PENALTY_AREA_DEPTH} -7.3 A 9.15 9.15 0 0 0 ${L - PENALTY_AREA_DEPTH} 7.3` }),
    svg('circle', { class: 'ln', cx: L - PENALTY_SPOT_DIST, cy: 0, r: 0.4 }),
    svg('rect', { class: 'goal', x: L, y: -GOAL_HALF_WIDTH, width: 2, height: 2 * GOAL_HALF_WIDTH }),
    svg('circle', { class: 'gk', cx: L - 1, cy: 0, r: 1.3 }),
  );
  const sp = PRACTICE_SPOTS[kind]?.[clampSpot(kind, spot)];
  if (sp) {
    const x = Math.min(L, L - sp.dist);
    const y = Math.max(-W, Math.min(W, sp.right));
    root.append(svg('circle', { class: 'ring', cx: x, cy: y, r: 3.2 }), svg('circle', { class: 'spot', cx: x, cy: y, r: 1.2 }));
  } else if (kind === PracticeKind.FREE_PLAY) {
    for (const [x, y] of [[8, -14], [14, 4], [22, -6], [26, 14], [34, 0]] as const) root.append(svg('circle', { class: 'mate', cx: x, cy: y, r: 1.1 }));
    root.append(svg('circle', { class: 'spot', cx: 0.8, cy: 0, r: 0.9 }));
  }
  return root;
}

/** Entry for a kind (unknown: Free play). */
export function practiceEntryFor(kind: unknown): PracticeEntry {
  return PRACTICE_ENTRIES.find((e) => e.kind === kind) ?? PRACTICE_ENTRIES[0]!;
}

export function createPracticeScreen(): Screen {
  let detachDots: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  return {
    id: 'practice',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectFlowStyle();
      injectStyle('practice', CSS);
      root.classList.add('flow', 'practice');
      detachDots = attachDotField(root);
      let current = practiceEntryFor(params?.kind ?? last.kind);
      let spot = clampSpot(current.kind, typeof params?.spot === 'number' ? params.spot : last.spot);

      const start = (): void => {
        const kind = current.kind;
        last.kind = kind;
        last.spot = spot;
        if (kind === PracticeKind.TUTORIAL) {
          ctx.router.go('tutorial', { device: tutorialDeviceFor(ctx.devices) });
          return;
        }
        const setup = buildPracticeSetup(ctx, kind, { spot });
        const chosen = spot;
        setup.onFinish = () => {
          // Quit from the pause menu (practice has no full time): back here with the same choice.
          ctx.router.go('practice', { kind, spot: chosen });
        };
        ctx.audio.unlock().catch(() => undefined);
        ctx.session.start(setup);
      };

      const panel = h('section', { class: 'pr-panel', testId: 'practice-panel', attrs: { 'aria-live': 'polite' } });
      const rows: HTMLButtonElement[] = [];
      let primary: HTMLButtonElement | null = null;

      const renderPanel = (): void => {
        const e = current;
        const parts: Node[] = [h('h2', { text: e.label, testId: 'practice-panel-title' }), h('p', { class: 'pr-detail', text: e.detail })];
        const spots = PRACTICE_SPOTS[e.kind];
        let map = practiceMap(e.kind, spot);
        if (map) parts.push(map);
        if (spots && spots.length > 1) {
          const options = spots.map((sp, i) => ({ value: i, label: sp.label, testId: `practice-spot-${sp.id}` }));
          const onSpot = (v: number): void => {
            spot = clampSpot(e.kind, v);
            const next = practiceMap(e.kind, spot);
            if (map && next) {
              map.replaceWith(next);
              map = next;
            }
          };
          parts.push(spots.length <= 3
            ? createSegmented<number>('Spot', options, spot, onSpot, { ctx, testId: 'practice-spot' }).el
            : createSelector<number>('Spot', options, spot, onSpot, { ctx, testId: 'practice-spot' }).el);
        }
        if (e.kind === PracticeKind.TUTORIAL) {
          parts.push(h('p', { class: 'pr-note', text: `Using ${DEVICE_LABEL[tutorialDeviceFor(ctx.devices)]} controls.` }));
        } else {
          parts.push(h('p', { class: 'pr-note', text: 'Quit from the pause menu to come back here.' }));
        }
        primary = createButton(e.action, start, { testId: 'practice-start', variant: 'primary', size: 'lg', ctx, autofocus: true });
        parts.push(h('div', { class: 'pr-actions' }, primary));
        panel.replaceChildren(...parts);
        for (let i = 0; i < rows.length; i++) setSelected(rows[i]!, PRACTICE_ENTRIES[i] === e);
      };

      const select = (e: PracticeEntry, focusAction: boolean): void => {
        if (e !== current) spot = 0;
        current = e;
        renderPanel();
        if (focusAction && primary) ctx.focus.focus(primary);
      };

      const list = h('nav', { class: 'pr-list', attrs: { 'aria-label': 'Practice', 'data-focus-group': 'y' } });
      for (const e of PRACTICE_ENTRIES) {
        const b = createButton(e.label, () => select(e, true), { testId: e.testId, ctx, sound: UiSound.MOVE, extraClass: 'pr-entry' });
        b.replaceChildren(h('span', { text: e.label }), h('span', { class: 'pr-dot', attrs: { 'aria-hidden': 'true' } }));
        rows.push(b);
        list.append(b);
      }
      renderPanel();

      root.append(
        createFlowTop({ ctx, title: 'Practice', eyebrow: 'Train', testId: 'practice-title' }),
        h('div', { class: 'pr-layout' }, list, panel),
      );

      cleanup = ctx.focus.onAction((a) => {
        if (a !== MenuAction.TAB_PREV && a !== MenuAction.TAB_NEXT) return false;
        const i = PRACTICE_ENTRIES.indexOf(current);
        const n = PRACTICE_ENTRIES.length;
        const j = (i + (a === MenuAction.TAB_NEXT ? 1 : -1) + n) % n;
        try {
          ctx.audio.playUi(UiSound.MOVE);
        } catch {
          /* audio never breaks a menu */
        }
        select(PRACTICE_ENTRIES[j]!, true);
        return true;
      });
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
