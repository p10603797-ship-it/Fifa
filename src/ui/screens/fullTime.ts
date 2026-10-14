/**
 * [UIX-10] Full-time screen (BRIEF §12 Screens "Full time (stats, player of the match, Rematch, Change Teams, Quit)").
 *
 * params.final false (FULL_TIME phase, over the match): the score, the scorers and Continue (SKIP; Back too).
 * params.final true (after POST_MATCH, params.summary = MatchSummary from the session's stats tracker, MOD-05):
 *  - the final score with crests (the loser dimmed), the result line (after extra time, penalties "4-3", forfeit),
 *    scorers with minutes per team;
 *  - the stats table: possession, shots, on target, passes (completed/attempted), pass accuracy, tackles, fouls,
 *    yellow and red cards, offsides, corners, saves (each with a comparison bar);
 *  - the player of the match card (the tracker's pick; while the tracker does not rate players, the best scorer /
 *    assister is shown and labelled as derived from goals);
 *  - Rematch (session.restart(): same setup, new seed), Change Teams (team select in the same mode, starting from this
 *    match's setup with a fresh seed), Quit (main menu). Back = Quit. A custom input provider (online) cannot restart,
 *    so Rematch is hidden there and Change Teams leads to the online lobby; the cup continues to the cup screen
 *    (normally setup.onFinish already navigated there and this screen is not shown at all).
 * Without a summary (tests, a tracker failure) the score from the state is shown and the table is left out.
 */
import type { AppContext, MatchSummary, Screen, ScreenParams } from '../../contracts/app';
import { ModeId, Period } from '../../contracts/enums';
import { newMatchSeed } from '../../app/session';
import { createButton, h, injectStyle } from '../components';
import {
  clubOf, createScoreHeader, createScorers, createStatList, injectBreakStyle, liveSummary, pickPlayerOfMatch, playerName,
  scoreLine, sendSkip, statRows, FULL_STAT_KEYS,
} from './halfTime';
import { cloneSetup, isFlowMode } from './matchFlow';

export { scoreLine };

const CSS = `
.ft-panel { width: min(1080px, 100%); overflow:hidden; }
.ft-panel .ft-grid { flex: 1 1 auto; min-height:0; overflow-y:auto; padding: 2px; }
.ft-panel .brk-actions { flex: 0 0 auto; }
.ft-grid { display:grid; grid-template-columns: minmax(0, 1.6fr) minmax(240px, 1fr); gap: var(--space-6); align-items:start; }
.ft-grid--solo { grid-template-columns: minmax(0, 1fr); }
.ft-stats .brk-stats { gap: var(--space-2); }
.ft-potm { display:flex; flex-direction:column; gap: var(--space-2); padding: var(--space-5); border-radius: var(--radius);
  background: var(--surface-2); border: var(--line) solid var(--hairline); }
.ft-potm__name { margin:0; font-size: var(--fs-lg); font-weight: var(--fw-bold); line-height: var(--lh-tight); }
.ft-potm__club { margin:0; font: var(--fw-num) var(--fs-sm) / 1.3 var(--font-num); color: var(--text-2); }
.ft-potm__line { margin:0; font: var(--fw-num-bold) var(--fs-md) / 1.3 var(--font-num); font-variant-numeric: tabular-nums; }
.ft-potm__note { margin:0; font-size: var(--fs-xs); color: var(--text-3); }
.ft-potm__shirt { font: var(--fw-num-bold) var(--fs-hero) / 1 var(--font-num); color: var(--ember); }
@media (max-width: 900px) { .ft-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-height: 640px) { .ft-potm__shirt { font-size: var(--fs-xl); } }
@media (max-height: 780px) and (min-width: 1200px) {
  .ft-stats .brk-stats { display:grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: var(--space-3) var(--space-6); }
}
`;

/** Result line under the score: forfeit, penalties, after extra time, or ''. Pure. */
export function resultLine(summary: MatchSummary, codes: readonly [string, string], afterExtraTime: boolean): string {
  if (summary.forfeit === 0 || summary.forfeit === 1) return `${codes[summary.forfeit]} forfeited`;
  if (summary.shootout) {
    const [a, b] = summary.shootout;
    const w = a > b ? codes[0] : b > a ? codes[1] : '';
    return `Penalties ${a}-${b}${w ? `, ${w} win` : ''}`;
  }
  return afterExtraTime ? 'After extra time' : '';
}

export interface FinalActions {
  rematch: boolean;
  changeTeams: 'team-select' | 'online-lobby' | null;
  cup: boolean;
}

/** Which buttons the final screen offers for a setup's mode (online / custom provider cannot restart). Pure. */
export function finalActions(mode: ModeId | null, customProvider: boolean): FinalActions {
  if (mode === ModeId.CUP) return { rematch: false, changeTeams: null, cup: true };
  if (mode === ModeId.FRIEND_ONLINE || customProvider) return { rematch: false, changeTeams: 'online-lobby', cup: false };
  return { rematch: true, changeTeams: 'team-select', cup: false };
}

/** Team select again in the same mode, from this match's setup (fresh seed), after leaving the session. */
export function changeTeams(ctx: AppContext, target: 'team-select' | 'online-lobby' = 'team-select'): void {
  const setup = ctx.session.getSetup();
  const mode = setup?.config.mode;
  let params: ScreenParams = {};
  if (target === 'team-select' && setup && isFlowMode(mode)) {
    const copy = cloneSetup(setup);
    copy.config.seed = newMatchSeed() >>> 0;
    delete copy.inputProvider;
    params = { mode, setup: copy };
  }
  ctx.session.quit();
  ctx.router.go(target, params);
}

function potmCard(ctx: AppContext, summary: MatchSummary): HTMLElement | null {
  const pick = pickPlayerOfMatch(summary);
  if (!pick) return null;
  const s = ctx.session.getState();
  const club = clubOf(ctx, pick.team);
  const data = s?.squads[pick.team]?.[pick.rosterIdx] ?? club?.squad[pick.rosterIdx];
  const parts: string[] = [];
  if (pick.goals > 0) parts.push(`${pick.goals} goal${pick.goals === 1 ? '' : 's'}`);
  if (pick.assists > 0) parts.push(`${pick.assists} assist${pick.assists === 1 ? '' : 's'}`);
  if (pick.rating !== null) parts.push(`rating ${pick.rating.toFixed(1)}`);
  return h(
    'div',
    { class: 'ft-potm', testId: 'ft-potm' },
    h('span', { class: 'eyebrow', text: 'Player of the match' }),
    h('span', { class: 'ft-potm__shirt', text: String(data?.shirt ?? pick.rosterIdx + 1), attrs: { 'aria-hidden': 'true' } }),
    h('p', { class: 'ft-potm__name', text: playerName(ctx, pick.team, pick.rosterIdx, s), testId: 'ft-potm-name' }),
    h('p', { class: 'ft-potm__club', text: club ? `${club.code}  ${club.name}` : '' }),
    parts.length > 0 ? h('p', { class: 'ft-potm__line', text: parts.join(' · '), testId: 'ft-potm-line' }) : null,
    pick.official ? null : h('p', { class: 'ft-potm__note', text: 'Picked on goals and assists' }),
  );
}

export function createFullTimeScreen(): Screen {
  let ctxRef: AppContext | null = null;
  let final = false;
  return {
    id: 'full-time',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectBreakStyle();
      injectStyle('full-time', CSS);
      ctxRef = ctx;
      final = params.final === true;
      root.classList.add('screen--overlay', 'brk');
      const s = ctx.session.getState();
      const given = (params.summary as MatchSummary | null | undefined) ?? null;
      const summary = given ?? liveSummary(ctx);
      const goals: [number, number] = summary
        ? [summary.teams[0].goals, summary.teams[1].goals]
        : s ? [s.teams[0]!.goals, s.teams[1]!.goals] : [0, 0];
      const panel = h('div', { class: 'brk-panel ft-panel', testId: final ? 'full-time-panel' : 'full-time-interim' });
      panel.append(
        h('h1', { class: 'brk-eyebrow eyebrow', text: 'Full time', testId: 'full-time-title' }),
        createScoreHeader(ctx, goals, final && summary ? summary.winner : -1, 'full-time-score'),
      );
      if (summary) {
        const codes: [string, string] = [clubOf(ctx, 0)?.code ?? 'HOM', clubOf(ctx, 1)?.code ?? 'AWY'];
        const line = resultLine(summary, codes, !!s && s.match.period >= Period.ET_FIRST && s.match.period < Period.SHOOT_OUT);
        if (line) panel.append(h('p', { class: 'brk-result', text: line, testId: 'ft-result' }));
      }
      panel.append(createScorers(ctx, summary));
      if (!final) {
        panel.append(h('div', { class: 'brk-actions' },
          createButton('Continue', () => sendSkip(ctx), { testId: 'ft-continue', variant: 'primary', autofocus: true, ctx })));
        root.append(panel);
        return;
      }
      if (given) {
        const stats = h('div', { class: 'ft-stats', testId: 'ft-stats' }, createStatList(statRows(given, FULL_STAT_KEYS), 'ft-stat-list'));
        const card = potmCard(ctx, given);
        panel.append(h('div', { class: `ft-grid${card ? '' : ' ft-grid--solo'}` }, stats, card));
      }
      const setup = ctx.session.getSetup();
      const acts = finalActions(setup ? setup.config.mode : null, !!setup?.inputProvider);
      const row = h('div', { class: 'brk-actions' });
      if (acts.cup) {
        row.append(createButton('Continue', () => {
          ctx.session.quit();
          ctx.router.go('cup');
        }, { testId: 'ft-cup', variant: 'primary', autofocus: true, ctx }));
      }
      if (acts.rematch) {
        row.append(createButton('Rematch', () => ctx.session.restart(), { testId: 'ft-rematch', variant: 'primary', autofocus: true, ctx, hint: 'Same teams, new kick-off' }));
      }
      if (acts.changeTeams) {
        const target = acts.changeTeams;
        row.append(createButton('Change teams', () => changeTeams(ctx, target), { testId: 'ft-change-teams', ctx, hint: 'Pick new teams and kits' }));
      }
      row.append(createButton('Quit', () => ctx.session.quit(), { testId: 'ft-quit', ctx, hint: 'Back to the main menu', autofocus: !acts.cup && !acts.rematch }));
      panel.append(row);
      root.append(panel);
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
