/**
 * [UIX-11] Cup screens (BRIEF §11: "Cup: An 8- or 16-team knockout against bots, for one or two humans. Other ties use
 * a quick ratings-based result. Progress saves."). Logic: modes/cup.ts (MOD-02).
 *
 * One screen, two views:
 *  - New cup (no saved cup, or New cup): size 8 / 16, players (one / two together / two rivals), difficulty, half
 *    length and the club grid (player 1 ember, player 2 cyan; in rivals mode "Picking for" switches the player).
 *    Make the draw -> createCup (saved at once) -> bracket.
 *  - Bracket (a saved cup = Continue): a mirrored bracket (left half flows right, right half flows left, the final in
 *    the middle; results, shoot-outs, winners, human clubs marked), and the next-tie strip: the round, both clubs and
 *    Play match, which starts the tie (MOD-02 nextMatch). When the tie ends, the cup records it, the session is
 *    released and this screen returns with the result card (params.result = { round, tie }); a quit returns with the
 *    tie still to play. When the cup is over the strip shows the champion (and where the human went out) with New
 *    cup.
 * Back: New cup -> the bracket when a cup exists, else the previous screen. Every control is a [data-focus] button of at
 * least 60 pt, so the screen works by touch alone and by controller alone (focus ring, spatial order, Back).
 * Debug / e2e hook: window.__dotkickCup = { state(), simulate() } while mounted (simulate quick-sims the pending human
 * tie); a visible Simulate button appears only with the debug overlay on.
 */
import type { AppContext, Screen, ScreenParams } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { Difficulty } from '../../contracts/enums';
import {
  createCup, isPlayed, loadCup, roundCount, roundName, type CupRun, type CupState, type CupTie,
} from '../../modes/cup';
import { clampHalfMinutes } from '../../modes/setup';
import { closeTopModal, createButton, createSegmented, createSelector, h, injectStyle, openModal, setSelected, showToast } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import { createFlowTop, injectFlowStyle } from './matchFlow';

type Players = 'one' | 'coop' | 'rivals';

interface Draft {
  size: 8 | 16;
  players: Players;
  clubs: [number, number];
  picking: 0 | 1;
  difficulty: Difficulty;
  halfMinutes: number;
}

export interface CupDebugHook {
  state(): CupState | null;
  /** Quick-sim the pending human tie and redraw. False when there is none. */
  simulate(): boolean;
}

declare global {
  interface Window {
    __dotkickCup?: CupDebugHook;
  }
}

const DIFFICULTY_LABELS: readonly string[] = ['Beginner', 'Amateur', 'Semi-pro', 'Professional', 'World class', 'Legend'];
const HALF_OPTIONS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 9, 10];

const CSS = `
.screen.cup { justify-content: flex-start; align-items: stretch; gap: var(--space-4); }
.cup-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: var(--space-4); width: 100%; max-width: 1240px;
  margin: 0 auto; }
.cup-new { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(260px, 0.75fr) minmax(0, 1.6fr);
  gap: var(--space-5); width: 100%; max-width: 1240px; margin: 0 auto; }
.cup-settings { display: flex; flex-direction: column; gap: var(--space-3); min-height: 0; overflow: auto; padding: 4px; }
.cup-settings .seg__opt { min-width: 0; flex: 1 1 0; padding: 0 var(--space-3); }
.cup-clubs-panel { display: flex; flex-direction: column; gap: var(--space-3); min-height: 0; padding: 4px; }
.cup-clubs-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; min-height: var(--target); }
.cup-clubs-head .seg { flex-direction: row; align-items: center; gap: var(--space-3); }
.cup-clubs { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: minmax(var(--target), 1fr);
  gap: var(--space-2); overflow: auto; padding: 2px; }
.btn.cup-club { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: var(--space-2);
  min-width: 0; min-height: var(--target); padding: 0 var(--space-3); text-align: left; background: var(--surface-1);
  border: 1px solid var(--hairline); }
.cup-club .cc-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); }
.cup-club .cc-code { font-weight: var(--fw-bold); letter-spacing: 0.04em; }
.cup-club .cc-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.15; }
.cup-club .cc-rating { color: var(--text-3); font-size: var(--fs-xs); }
.btn.cup-club[data-selected] { border-color: var(--ember); background: var(--ember-tint); }
.btn.cup-club.is-p2 { border-color: var(--cyan); background: var(--cyan-tint); }
.btn.cup-club.is-p1.is-p2 { border-color: var(--ember); box-shadow: inset 0 0 0 2px var(--cyan); }
.cup-badge { font: 600 var(--fs-xs) / 1 var(--font-ui); padding: 3px 6px; border-radius: var(--radius-pill); }
.cup-badge.p1 { background: var(--ember); color: var(--text-on-ember); }
.cup-badge.p2 { background: var(--cyan); color: var(--ink); }
.cup-dot { width: 12px; height: 12px; border-radius: 50%; flex: 0 0 auto; box-shadow: 0 0 0 1px var(--hairline-strong); }

.cup-bracket { flex: 1 1 auto; min-height: 0; display: grid; gap: var(--space-3); align-items: stretch; padding: var(--space-3) var(--space-4);
  background: var(--surface-1); border: 1px solid var(--hairline); border-radius: var(--radius-lg); box-shadow: var(--shadow-1); }
.cup-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; gap: var(--space-2); }
.cup-col-head { margin: 0; text-align: center; flex: 0 0 auto; }
.cup-col.is-current .cup-col-head { color: var(--ember-strong); }
.cup-col-ties { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: space-around; gap: var(--space-2); }
.cup-tie { display: flex; flex-direction: column; gap: 2px; padding: 6px var(--space-2); border-radius: var(--radius-sm);
  background: var(--surface-2); border: 1px solid var(--hairline); min-width: 0; }
.cup-tie.is-human { border-color: var(--hairline-strong); }
.cup-tie.is-next { border-color: var(--ember); box-shadow: 0 0 0 1px var(--ember-soft); }
.cup-tie.is-last { border-color: var(--text-3); }
.cup-team { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 6px; font-size: var(--fs-sm);
  color: var(--text-2); min-height: 20px; }
.cup-team .ct-code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0.03em; }
.cup-team.is-winner { color: var(--text-1); font-weight: var(--fw-bold); }
.cup-team.is-out { opacity: 0.55; }
.cup-team.is-p1 .ct-code { color: var(--ember-strong); }
.cup-team.is-p2 .ct-code { color: var(--cyan-strong); }
.cup-team .ct-score { font-size: var(--fs-sm); color: inherit; }
.cup-team .ct-pens { font-size: var(--fs-xs); color: var(--text-3); margin-left: 2px; }
.cup-team.is-tbd { color: var(--text-3); }
.cup-final .cup-tie { padding: var(--space-2) var(--space-3); }
.cup-final .cup-team { font-size: var(--fs-md); }

.cup-strip { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between; gap: var(--space-5); flex-wrap: wrap;
  padding: var(--space-4) var(--space-5); background: var(--surface-2); border: 1px solid var(--hairline); border-radius: var(--radius-lg); }
.cup-strip-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.cup-strip-title { margin: 0; font-size: var(--fs-lg); font-weight: var(--fw-bold); display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.cup-strip-note { margin: 0; color: var(--text-2); font-size: var(--fs-sm); }
.cup-strip-actions { display: flex; gap: var(--space-3); flex-wrap: wrap; }
.cup-strip-actions .btn { min-width: calc(var(--target) * 2.6); }
.cup-result { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; padding: var(--space-2) var(--space-4);
  border-radius: var(--radius); background: var(--surface-1); border: 1px solid var(--hairline); }
.cup-result .num { font-size: var(--fs-md); }
.cup-result.is-good { border-color: var(--success); }
.cup-result.is-bad { border-color: var(--error); }
.cup-champion { color: var(--warning); }
@media (max-height: 600px) {
  .screen.cup { gap: var(--space-2); }
  .cup-body { gap: var(--space-2); }
  .cup-bracket { padding: var(--space-2) var(--space-3); }
  .cup-col-head { display: none; }
  .cup-tie { padding: 2px 6px; }
  .cup-strip { padding: var(--space-2) var(--space-4); }
  .cup-strip-title { font-size: var(--fs-md); }
  .cup-result { display: none; }
  .cup-settings .seg__label { display: none; }
}
`;

function debugOn(ctx: AppContext): boolean {
  try {
    return ctx.diagnostics.debug === true;
  } catch {
    return false;
  }
}

function hex(rgb: number | undefined): string {
  return `#${((rgb ?? 0x888888) & 0xffffff).toString(16).padStart(6, '0')}`;
}

function clubCode(clubs: readonly Club[], c: number): string {
  return clubs[c]?.code ?? (c < 0 ? 'TBD' : '???');
}

function clubName(clubs: readonly Club[], c: number): string {
  return clubs[c]?.name ?? 'To be decided';
}

/** Short column label. */
export function shortRoundName(size: 8 | 16, r: number): string {
  const left = roundCount(size) - r;
  return left <= 1 ? 'Final' : left === 2 ? 'Semis' : left === 3 ? 'Quarters' : 'Last 16';
}

/** Human index (0 / 1) whose club this is, or -1. */
function humanOf(state: Readonly<CupState>, club: number): number {
  if (club < 0) return -1;
  const i = state.humanClubs.indexOf(club);
  return i < 0 ? -1 : state.coop ? 0 : i;
}

/** Score line of a played tie, e.g. "2-1", "1-1 aet, 4-3 pens". */
export function tieScore(t: Readonly<CupTie>): string {
  if (!isPlayed(t)) return 'v';
  let s = `${t.homeGoals}-${t.awayGoals}`;
  if (t.shootout) s += `, ${t.shootout[0]}-${t.shootout[1]} pens`;
  else if (t.extraTime) s += ' aet';
  return s;
}

/** Round in which `club` went out, or -1 (still in / champion). */
export function exitRound(state: Readonly<CupState>, club: number): number {
  for (let r = 0; r < state.rounds.length; r++) {
    for (const t of state.rounds[r]!) if (isPlayed(t) && (t.home === club || t.away === club) && t.winner !== club) return r;
  }
  return -1;
}

export function createCupScreen(): Screen {
  let ctxRef: AppContext | null = null;
  let rootRef: HTMLElement | null = null;
  let detachDots: (() => void) | null = null;
  let view: 'new' | 'bracket' = 'new';
  let run: CupRun | null = null;
  let lastResult: { round: number; tie: number } | null = null;
  let draft: Draft | null = null;

  function play(ctx: AppContext): void {
    if (!run) return;
    const at = run.pendingTie();
    const setup = run.nextMatch({
      onFinished: (_summary, quit) => {
        if (!quit) {
          // Release the finished match (renderer, HUD, inputs); quit() also resets the router to main...
          try {
            ctx.session.quit();
          } catch {
            /* already released */
          }
        }
        // ...and the cup comes back on top of it, with the result of the tie just played.
        ctx.router.go('cup', quit ? {} : { result: at });
      },
    });
    if (!setup) {
      render();
      return;
    }
    ctx.audio.unlock().catch(() => undefined);
    ctx.session.start(setup);
  }

  function makeDraw(ctx: AppContext): void {
    const d = draft!;
    if (d.players === 'rivals' && d.clubs[0] === d.clubs[1]) {
      showToast('Pick a different club for each player', { kind: 'warning' });
      return;
    }
    run = createCup(ctx, {
      size: d.size,
      humanClubs: d.players === 'rivals' ? [d.clubs[0], d.clubs[1]] : [d.clubs[0]],
      coop: d.players === 'coop',
      humans: d.players === 'one' ? 1 : 2,
      difficulty: d.difficulty,
      halfMinutes: d.halfMinutes,
    });
    lastResult = null;
    view = 'bracket';
    render();
  }

  function confirmNewCup(ctx: AppContext): void {
    if (!run || run.state.finished) {
      openNew(ctx);
      return;
    }
    openModal(ctx, {
      title: 'Start a new cup?',
      body: 'The cup in progress will be replaced when you make the new draw.',
      testId: 'cup-new-confirm',
      actions: [
        { label: 'Keep playing', testId: 'cup-new-cancel' },
        { label: 'New cup', primary: true, testId: 'cup-new-ok', onSelect: () => openNew(ctx) },
      ],
    });
  }

  function openNew(ctx: AppContext): void {
    if (!draft) openNewDraft(ctx);
    view = 'new';
    render();
  }

  // ------------------------------------------------------------ new cup view

  function renderNew(ctx: AppContext, root: HTMLElement): void {
    const d = draft!;
    const clubs = ctx.clubs;
    const grid = h('div', { class: 'cup-clubs', testId: 'cup-clubs', attrs: { 'data-focus-group': 'both', role: 'group', 'aria-label': 'Clubs' } });
    const clubButtons: HTMLButtonElement[] = [];
    const paint = (): void => {
      for (let i = 0; i < clubButtons.length; i++) {
        const b = clubButtons[i]!;
        const p1 = d.clubs[0] === i;
        const p2 = d.players === 'rivals' && d.clubs[1] === i;
        setSelected(b, p1);
        b.classList.toggle('is-p1', p1);
        b.classList.toggle('is-p2', p2);
        const badge = b.querySelector('.cup-badge-slot')!;
        badge.replaceChildren(
          ...(p1 ? [h('span', { class: 'cup-badge p1', text: d.players === 'one' ? 'You' : d.players === 'coop' ? 'P1+P2' : 'P1' })] : []),
          ...(p2 ? [h('span', { class: 'cup-badge p2', text: 'P2' })] : []),
        );
        if (!p1 && !p2) badge.append(h('span', { class: 'cc-rating num', text: String(clubs[i]?.rating ?? '') }));
      }
    };
    clubs.forEach((club, i) => {
      const b = createButton(club.name, () => {
        // Rivals: picking the other player's club swaps the two picks.
        const p = d.players === 'rivals' ? d.picking : 0;
        const prev = d.clubs[p];
        d.clubs[p] = i;
        if (d.players === 'rivals' && d.clubs[1 - p] === i) d.clubs[1 - p] = prev;
        paint();
      }, { testId: `cup-club-${club.code.toLowerCase()}`, ctx, extraClass: 'cup-club', ariaLabel: `${club.name}, rating ${club.rating}` });
      b.replaceChildren(
        h('span', { class: 'cup-dot', attrs: { style: `background:${hex(club.home.shirt)}`, 'aria-hidden': 'true' } }),
        h('span', { class: 'cc-text' }, h('span', { class: 'cc-code', text: club.code }), h('span', { class: 'cc-name', text: club.name })),
        h('span', { class: 'cup-badge-slot' }),
      );
      clubButtons.push(b);
      grid.append(b);
    });

    const pickingHost = h('div', { class: 'cup-picking' });
    const renderPicking = (): void => {
      pickingHost.replaceChildren();
      if (d.players !== 'rivals') {
        pickingHost.append(h('p', { class: 'eyebrow', text: d.players === 'coop' ? 'Your club (both players)' : 'Your club' }));
        return;
      }
      pickingHost.append(createSegmented<number>('Picking for', [
        { value: 0, label: 'Player 1', testId: 'cup-pick-p1' },
        { value: 1, label: 'Player 2', testId: 'cup-pick-p2' },
      ], d.picking, (v) => {
        d.picking = v === 1 ? 1 : 0;
      }, { ctx, testId: 'cup-picking' }).el);
    };

    const settings = h(
      'section',
      { class: 'cup-settings', attrs: { 'aria-label': 'Cup settings' } },
      createSegmented<number>('Teams', [
        { value: 8, label: '8 teams', testId: 'cup-size-8' },
        { value: 16, label: '16 teams', testId: 'cup-size-16' },
      ], d.size, (v) => {
        d.size = v === 16 ? 16 : 8;
      }, { ctx, testId: 'cup-size' }).el,
      createSegmented<Players>('Players', [
        { value: 'one', label: 'One', testId: 'cup-players-one' },
        { value: 'coop', label: 'Two, together', testId: 'cup-players-coop' },
        { value: 'rivals', label: 'Two, rivals', testId: 'cup-players-rivals' },
      ], d.players, (v) => {
        d.players = v;
        d.picking = 0;
        if (v === 'rivals' && d.clubs[1] === d.clubs[0]) d.clubs[1] = (d.clubs[0] + 1) % Math.max(1, clubs.length);
        renderPicking();
        paint();
      }, { ctx, testId: 'cup-players' }).el,
      createSelector<number>('Difficulty', DIFFICULTY_LABELS.map((label, value) => ({ value, label })), d.difficulty, (v) => {
        d.difficulty = v as Difficulty;
      }, { ctx, testId: 'cup-difficulty', wrap: false }).el,
      createSelector<number>('Half length', HALF_OPTIONS.map((v) => ({ value: v, label: `${v} min` })), d.halfMinutes, (v) => {
        d.halfMinutes = v;
      }, { ctx, testId: 'cup-half', wrap: false }).el,
    );

    renderPicking();
    paint();
    const draw = createButton('Make the draw', () => makeDraw(ctx), { testId: 'cup-draw', variant: 'primary', ctx, autofocus: true });
    root.append(
      createFlowTop({
        ctx, title: 'New cup', eyebrow: 'Cup', testId: 'cup-title', actions: [draw],
        onBack: () => back(ctx),
      }),
      h('div', { class: 'cup-new', testId: 'cup-new' }, settings, h('section', { class: 'cup-clubs-panel' }, h('div', { class: 'cup-clubs-head' }, pickingHost), grid)),
    );
  }

  // ------------------------------------------------------------ bracket view

  function teamRow(ctx: AppContext, state: CupState, t: CupTie, side: 0 | 1): HTMLElement {
    const club = side === 0 ? t.home : t.away;
    const played = isPlayed(t);
    const hum = humanOf(state, club);
    const cls = ['cup-team'];
    if (club < 0) cls.push('is-tbd');
    if (played) cls.push(t.winner === club ? 'is-winner' : 'is-out');
    if (hum === 0) cls.push('is-p1');
    if (hum === 1) cls.push('is-p2');
    const score = h('span', { class: 'ct-score num', text: played ? String(side === 0 ? t.homeGoals : t.awayGoals) : '' });
    if (played && t.shootout) score.append(h('span', { class: 'ct-pens num', text: `(${t.shootout[side]})` }));
    return h(
      'div',
      { class: cls.join(' ') },
      h('span', { class: 'cup-dot', attrs: { style: `background:${club >= 0 ? hex(ctx.clubs[club]?.home.shirt) : 'transparent'}`, 'aria-hidden': 'true' } }),
      h('span', { class: 'ct-code', text: clubCode(ctx.clubs, club) }),
      score,
    );
  }

  function tieEl(ctx: AppContext, state: CupState, r: number, i: number): HTMLElement {
    const t = state.rounds[r]![i]!;
    const pending = run?.pendingTie();
    const cls = ['cup-tie'];
    if (state.humanClubs.includes(t.home) || state.humanClubs.includes(t.away)) cls.push('is-human');
    if (pending && pending.round === r && pending.tie === i) cls.push('is-next');
    if (lastResult && lastResult.round === r && lastResult.tie === i) cls.push('is-last');
    const label = isPlayed(t)
      ? `${clubName(ctx.clubs, t.home)} ${tieScore(t)} ${clubName(ctx.clubs, t.away)}`
      : `${clubName(ctx.clubs, t.home)} v ${clubName(ctx.clubs, t.away)}`;
    return h('div', { class: cls.join(' '), testId: `cup-tie-${r}-${i}`, attrs: { role: 'listitem', 'aria-label': label } },
      teamRow(ctx, state, t, 0), teamRow(ctx, state, t, 1));
  }

  function column(ctx: AppContext, state: CupState, r: number, from: number, to: number): HTMLElement {
    const ties = h('div', { class: 'cup-col-ties', attrs: { role: 'list' } });
    for (let i = from; i < to; i++) ties.append(tieEl(ctx, state, r, i));
    const col = h('div', { class: 'cup-col', testId: `cup-col-${r}-${from}` }, h('p', { class: 'cup-col-head eyebrow', text: shortRoundName(state.size, r) }), ties);
    if (!state.finished && state.round === r) col.classList.add('is-current');
    if (r === state.rounds.length - 1) col.classList.add('cup-final');
    return col;
  }

  function bracketEl(ctx: AppContext, state: CupState): HTMLElement {
    const R = state.rounds.length;
    const cols: HTMLElement[] = [];
    for (let r = 0; r < R - 1; r++) cols.push(column(ctx, state, r, 0, state.rounds[r]!.length / 2));
    cols.push(column(ctx, state, R - 1, 0, 1));
    for (let r = R - 2; r >= 0; r--) cols.push(column(ctx, state, r, state.rounds[r]!.length / 2, state.rounds[r]!.length));
    const el = h('section', { class: 'cup-bracket', testId: 'cup-bracket', attrs: { 'aria-label': 'Bracket' } }, ...cols);
    el.style.gridTemplateColumns = `repeat(${cols.length}, minmax(0, 1fr))`;
    return el;
  }

  function humanLabel(state: CupState, club: number): string {
    const hum = humanOf(state, club);
    if (hum < 0) return '';
    if ((state.humans ?? 1) < 2) return 'You';
    return state.coop ? 'P1+P2' : hum === 0 ? 'P1' : 'P2';
  }

  function resultCard(ctx: AppContext, state: CupState): HTMLElement | null {
    if (!lastResult) return null;
    const t = state.rounds[lastResult.round]?.[lastResult.tie];
    if (!t || !isPlayed(t)) return null;
    const won = state.humanClubs.includes(t.winner);
    const bothHuman = state.humanClubs.includes(t.home) && state.humanClubs.includes(t.away);
    const verdict = bothHuman
      ? `${humanLabel(state, t.winner)} through`
      : won ? (lastResult.round === state.rounds.length - 1 ? 'Cup won' : 'Through to the next round') : 'Knocked out';
    return h(
      'div',
      { class: `cup-result ${won ? 'is-good' : 'is-bad'}`, testId: 'cup-result', attrs: { 'aria-live': 'polite' } },
      h('span', { class: 'eyebrow', text: `${roundName(state.size, lastResult.round)} · full time` }),
      h('span', { class: 'num', text: `${clubCode(ctx.clubs, t.home)} ${tieScore(t)} ${clubCode(ctx.clubs, t.away)}` }),
      h('strong', { text: verdict }),
    );
  }

  function stripEl(ctx: AppContext, state: CupState): { el: HTMLElement; primary: HTMLButtonElement | null } {
    const actions = h('div', { class: 'cup-strip-actions' });
    const text = h('div', { class: 'cup-strip-text' });
    let primary: HTMLButtonElement | null;
    const newCup = (variant: 'primary' | 'secondary'): HTMLButtonElement =>
      createButton('New cup', () => confirmNewCup(ctx), { testId: 'cup-new', variant, ctx });
    const pending = run?.pendingTie() ?? null;
    if (state.finished) {
      const champ = state.champion ?? -1;
      const hum = humanLabel(state, champ);
      text.append(
        h('p', { class: 'eyebrow', text: 'Cup over' }),
        h('h2', { class: 'cup-strip-title', testId: 'cup-champion' },
          h('span', { class: 'cup-champion', text: 'Champions' }), h('span', { text: clubName(ctx.clubs, champ) }),
          ...(hum ? [h('span', { class: `cup-badge ${hum === 'P2' ? 'p2' : 'p1'}`, text: hum })] : [])),
      );
      const notes: string[] = [];
      if (hum) notes.push((state.humans ?? 1) < 2 ? 'You won the cup.' : `${hum} won the cup.`);
      for (const c of state.humanClubs) {
        const r = exitRound(state, c);
        if (r >= 0) notes.push(`${humanLabel(state, c) === 'You' ? 'You' : `${humanLabel(state, c)} (${clubCode(ctx.clubs, c)})`} went out in the ${roundName(state.size, r).toLowerCase()}.`);
      }
      text.append(h('p', { class: 'cup-strip-note', text: notes.join(' ') }));
      primary = newCup('primary');
      primary.dataset.focusDefault = '';
      actions.append(primary);
    } else if (pending) {
      const t = state.rounds[pending.round]![pending.tie]!;
      const side = (club: number): Node[] => {
        const lab = humanLabel(state, club);
        const parts: Node[] = [h('span', { text: clubName(ctx.clubs, club) })];
        if (lab) parts.push(h('span', { class: `cup-badge ${lab === 'P2' ? 'p2' : 'p1'}`, text: lab }));
        return parts;
      };
      const title = h('h2', { class: 'cup-strip-title', testId: 'cup-next-tie' },
        ...side(t.home), h('span', { class: 'cup-strip-note', text: 'v' }), ...side(t.away));
      text.append(
        h('p', { class: 'eyebrow', text: `${roundName(state.size, pending.round)} · next tie` }),
        title,
        h('p', { class: 'cup-strip-note', text: `${state.halfMinutes ?? 4}-minute halves · ${DIFFICULTY_LABELS[state.difficulty ?? 3] ?? ''} · extra time and penalties if level` }),
      );
      primary = createButton('Play match', () => play(ctx), { testId: 'cup-play', variant: 'primary', size: 'lg', ctx, autofocus: true });
      actions.append(primary);
      if (debugOn(ctx)) {
        actions.append(createButton('Simulate', () => simulate(), { testId: 'cup-simulate', ctx }));
      }
      actions.append(newCup('secondary'));
    } else {
      text.append(h('p', { class: 'cup-strip-note', text: 'Waiting for the other results.' }));
      primary = createButton('Continue', () => {
        run?.simulateRest();
        render();
      }, { testId: 'cup-continue', variant: 'primary', ctx, autofocus: true });
      actions.append(primary, newCup('secondary'));
    }
    const res = resultCard(ctx, state);
    const el = h('section', { class: 'cup-strip', testId: 'cup-strip' }, text, ...(res ? [res] : []), actions);
    return { el, primary };
  }

  function renderBracket(ctx: AppContext, root: HTMLElement): void {
    const state = run!.state;
    const strip = stripEl(ctx, state);
    const title = state.finished ? 'Cup over' : roundName(state.size, state.round);
    root.append(
      createFlowTop({ ctx, title, eyebrow: `Cup · ${state.size} teams`, testId: 'cup-title', onBack: () => back(ctx) }),
      h('div', { class: 'cup-body' }, bracketEl(ctx, state), strip.el),
    );
    if (strip.primary) {
      const p = strip.primary;
      requestAnimationFrame(() => {
        if (p.isConnected) ctx.focus.focus(p);
      });
    }
  }

  function render(): void {
    const ctx = ctxRef;
    const root = rootRef;
    if (!ctx || !root) return;
    closeTopModal();
    root.replaceChildren();
    if (detachDots) {
      detachDots();
      detachDots = attachDotField(root);
    }
    root.dataset.view = view;
    if (view === 'bracket' && run) renderBracket(ctx, root);
    else {
      if (!draft) openNewDraft(ctx);
      renderNew(ctx, root);
    }
  }

  function openNewDraft(ctx: AppContext): void {
    const m = ctx.settings.get().match;
    const n = ctx.clubs.length;
    const c0 = m.homeClub >= 0 && m.homeClub < n ? m.homeClub : 0;
    let c1 = m.awayClub >= 0 && m.awayClub < n ? m.awayClub : 1;
    if (c1 === c0) c1 = (c0 + 1) % Math.max(1, n);
    draft = { size: 8, players: 'one', clubs: [c0, c1], picking: 0, difficulty: m.difficulty, halfMinutes: clampHalfMinutes(m.halfMinutes) };
  }

  function simulate(): boolean {
    if (!run) return false;
    const at = run.pendingTie();
    if (!at || !run.simulateHumanTie()) return false;
    lastResult = at;
    render();
    return true;
  }

  /** Back inside the screen: New cup -> bracket when a cup exists. Returns true when handled. */
  function back(ctx: AppContext): boolean {
    if (view === 'new' && run) {
      view = 'bracket';
      render();
      return true;
    }
    ctx.router.back();
    return true;
  }

  return {
    id: 'cup',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectFlowStyle();
      injectStyle('cup', CSS);
      ctxRef = ctx;
      rootRef = root;
      root.classList.add('flow', 'cup');
      detachDots = attachDotField(root);
      run = loadCup(ctx);
      const res = params?.result as { round?: unknown; tie?: unknown } | null | undefined;
      lastResult = res && typeof res.round === 'number' && typeof res.tie === 'number' ? { round: res.round, tie: res.tie } : null;
      draft = null;
      view = run && params?.view !== 'new' ? 'bracket' : 'new';
      render();
      if (typeof window !== 'undefined') {
        window.__dotkickCup = { state: () => run?.state ?? null, simulate };
      }
    },
    unmount() {
      if (typeof window !== 'undefined' && window.__dotkickCup?.simulate === simulate) delete window.__dotkickCup;
      detachDots?.();
      detachDots = null;
      ctxRef = null;
      rootRef = null;
    },
    onBack() {
      if (closeTopModal()) return true;
      if (view === 'new' && run) {
        view = 'bracket';
        render();
        return true;
      }
      return false;
    },
    onFrame(frame) {
      if (detachDots) sharedDotField().frame(frame.nowMs);
    },
  };
}
