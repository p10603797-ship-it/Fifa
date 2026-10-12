/**
 * [UIX-06] Scoreboard (top left): 3-letter team codes, score, clock (scaled to 45:00 halves via displayClock) and
 * added time. WAVE 0 version by FND-04. Writes to the DOM only when a displayed value changes; no allocation per
 * frame except the clock string once per displayed second.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState, SimState } from '../../contracts/state';
import { displayClock } from '../../sim/rules/machine';
import { h, injectStyle } from '../components';

const CSS = `
.hud-scoreboard { position:absolute; left: calc(var(--safe-left, 0px) + var(--gesture-margin, 24px));
  top: calc(var(--safe-top, 0px) + 16px); display:flex; align-items:stretch; height: 40px; border-radius: 10px;
  overflow:hidden; background: rgba(7,7,13,.82); border: 1px solid var(--hairline); font-family: var(--font-ui);
  color: var(--text-1); font-size: 17px; font-weight: 700; letter-spacing: .04em; }
.hud-scoreboard > span { display:flex; align-items:center; padding: 0 10px; }
.hud-scoreboard .sb-kit { width: 5px; padding:0; }
.hud-scoreboard .sb-score { font-family: var(--font-num); font-variant-numeric: tabular-nums; background: var(--surface-3); }
.hud-scoreboard .sb-clock { font-family: var(--font-num); font-variant-numeric: tabular-nums; font-weight: 500; color: var(--text-2); }
.hud-scoreboard .sb-added { font-family: var(--font-num); color: var(--ember); padding-left: 0; }
.hud-scoreboard .sb-added:empty { display:none; }
`;

function hex(rgb: number): string {
  return '#' + (rgb & 0xffffff).toString(16).padStart(6, '0');
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function createScoreboard(): HudPart {
  let homeCode: HTMLElement | null = null;
  let awayCode: HTMLElement | null = null;
  let homeKit: HTMLElement | null = null;
  let awayKit: HTMLElement | null = null;
  let score: HTMLElement | null = null;
  let clockEl: HTMLElement | null = null;
  let addedEl: HTMLElement | null = null;
  let root: HTMLElement | null = null;
  const clock = { min: 0, sec: 0, added: 0, period: 0 };
  let shownHome = -1;
  let shownAway = -1;
  let shownMin = -1;
  let shownSec = -1;
  let shownAdded = -1;

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      void ctx;
      injectStyle('hud-scoreboard', CSS);
      homeKit = h('span', { class: 'sb-kit' });
      homeCode = h('span', { class: 'sb-code', text: '---', testId: 'sb-home' });
      score = h('span', { class: 'sb-score', text: '0-0', testId: 'sb-score' });
      awayCode = h('span', { class: 'sb-code', text: '---', testId: 'sb-away' });
      awayKit = h('span', { class: 'sb-kit' });
      clockEl = h('span', { class: 'sb-clock', text: '00:00', testId: 'sb-clock' });
      addedEl = h('span', { class: 'sb-added', text: '' });
      root = h('div', { class: 'hud-scoreboard', testId: 'hud-scoreboard' }, homeKit, homeCode, score, awayCode, awayKit, clockEl, addedEl);
      parent.append(root);
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      const home = clubs[state.teams[0]!.clubIdx];
      const away = clubs[state.teams[1]!.clubIdx];
      if (homeCode) homeCode.textContent = home?.code ?? 'HOM';
      if (awayCode) awayCode.textContent = away?.code ?? 'AWY';
      if (homeKit && home) homeKit.style.background = hex(home.home.shirt);
      if (awayKit && away) awayKit.style.background = hex(away.away.shirt);
      shownHome = shownAway = shownMin = shownSec = shownAdded = -1;
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void frame;
      void projector;
      const g0 = state.teams[0]!.goals;
      const g1 = state.teams[1]!.goals;
      if (g0 !== shownHome || g1 !== shownAway) {
        shownHome = g0;
        shownAway = g1;
        if (score) score.textContent = `${g0}-${g1}`;
      }
      displayClock(state as unknown as SimState, clock);
      const min = Math.floor(clock.min);
      const sec = Math.floor(clock.sec);
      if (min !== shownMin || sec !== shownSec) {
        shownMin = min;
        shownSec = sec;
        if (clockEl) clockEl.textContent = pad2(min) + ':' + pad2(sec);
      }
      const added = Math.floor(clock.added);
      if (added !== shownAdded) {
        shownAdded = added;
        if (addedEl) addedEl.textContent = added > 0 ? '+' + added : '';
      }
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      void events;
      void state;
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
    },
    dispose() {
      root?.remove();
      root = homeCode = awayCode = homeKit = awayKit = score = clockEl = addedEl = null;
    },
  };
}
