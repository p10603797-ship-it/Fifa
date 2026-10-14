/**
 * [UIX-10] Half-time screen (over the match) plus the stats helpers shared with the full-time screen.
 *
 * Half time (BRIEF §12 Screens): the score with both crests, the goals so far (scorer and minute), key stats so far
 * (possession, shots, on target, passes, corners, fouls) from the running stats tracker, Continue (sends SKIP into the
 * acting human's next frame; the session returns to the match screen when the sim leaves HALF_TIME) and shortcuts to
 * the pause menu's team management and tactics (openPausePage: the match pauses, so the break waits, and Resume in
 * the pause menu comes back here). Back = Continue. The break also ends by itself when the sim's half-time time runs
 * out (T_RULES.halfTimeTicks); in extra time the title says so.
 *
 * Stats: MatchSummary (contracts/app.ts) comes from the session's stats tracker (MOD-05, src/modes/stats.ts) through
 * AppSession.runtime(); without it (tests, another session) only the score from the state is shown.
 *
 * Shared exports for fullTime.ts: StatRow / statRows (formatted per-team stats), scorersByTeam, pickPlayerOfMatch,
 * clubOf, liveSummary, createScoreHeader, injectBreakStyle.
 */
import type { AppContext, MatchSummary, Screen } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { Command, ModeId, Period } from '../../contracts/enums';
import type { ReadonlySimState } from '../../contracts/state';
import { uiHumanOf } from '../../app/session';
import { crestDataUrl } from '../../render/kits';
import { createButton, h, injectStyle } from '../components';
import { manageableTeams, openPausePage } from './pause';

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

// ============================================================ stats helpers (pure)

export type StatKey =
  | 'possession' | 'shots' | 'onTarget' | 'passes' | 'passAccuracy' | 'tackles' | 'fouls' | 'yellow' | 'red' | 'offsides'
  | 'corners' | 'saves';

export interface StatRow {
  key: StatKey;
  label: string;
  /** Display text per team. */
  home: string;
  away: string;
  /** Numeric values for the comparison bar (same unit for both teams). */
  homeValue: number;
  awayValue: number;
}

/** Every row of the full-time table, in display order. */
export const FULL_STAT_KEYS: readonly StatKey[] = [
  'possession', 'shots', 'onTarget', 'passes', 'passAccuracy', 'tackles', 'fouls', 'yellow', 'red', 'offsides', 'corners', 'saves',
];
/** The half-time subset. */
export const HALF_STAT_KEYS: readonly StatKey[] = ['possession', 'shots', 'onTarget', 'passes', 'corners', 'fouls'];

function pctOf(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 100) : 0;
}

/**
 * Format the summary's team stats as rows. Possession is shown in whole percent that add up to 100; passes as
 * "completed/attempted"; pass accuracy as a percent (0 when no pass was attempted). Pure.
 */
export function statRows(summary: MatchSummary, keys: readonly StatKey[] = FULL_STAT_KEYS): StatRow[] {
  const [a, b] = summary.teams;
  const pa = Math.round((Number.isFinite(a.possession) ? Math.min(1, Math.max(0, a.possession)) : 0.5) * 100);
  const out: StatRow[] = [];
  for (const key of keys) {
    switch (key) {
      case 'possession':
        out.push({ key, label: 'Possession', home: `${pa}%`, away: `${100 - pa}%`, homeValue: pa, awayValue: 100 - pa });
        break;
      case 'shots':
        out.push({ key, label: 'Shots', home: String(a.shots), away: String(b.shots), homeValue: a.shots, awayValue: b.shots });
        break;
      case 'onTarget':
        out.push({ key, label: 'On target', home: String(a.shotsOnTarget), away: String(b.shotsOnTarget), homeValue: a.shotsOnTarget, awayValue: b.shotsOnTarget });
        break;
      case 'passes':
        out.push({
          key, label: 'Passes', home: `${a.passesCompleted}/${a.passes}`, away: `${b.passesCompleted}/${b.passes}`,
          homeValue: a.passes, awayValue: b.passes,
        });
        break;
      case 'passAccuracy': {
        const x = pctOf(a.passesCompleted, a.passes);
        const y = pctOf(b.passesCompleted, b.passes);
        out.push({ key, label: 'Pass accuracy', home: `${x}%`, away: `${y}%`, homeValue: x, awayValue: y });
        break;
      }
      case 'tackles':
        out.push({ key, label: 'Tackles', home: String(a.tackles), away: String(b.tackles), homeValue: a.tackles, awayValue: b.tackles });
        break;
      case 'fouls':
        out.push({ key, label: 'Fouls', home: String(a.fouls), away: String(b.fouls), homeValue: a.fouls, awayValue: b.fouls });
        break;
      case 'yellow':
        out.push({ key, label: 'Yellow cards', home: String(a.yellow), away: String(b.yellow), homeValue: a.yellow, awayValue: b.yellow });
        break;
      case 'red':
        out.push({ key, label: 'Red cards', home: String(a.red), away: String(b.red), homeValue: a.red, awayValue: b.red });
        break;
      case 'offsides':
        out.push({ key, label: 'Offsides', home: String(a.offsides), away: String(b.offsides), homeValue: a.offsides, awayValue: b.offsides });
        break;
      case 'corners':
        out.push({ key, label: 'Corners', home: String(a.corners), away: String(b.corners), homeValue: a.corners, awayValue: b.corners });
        break;
      case 'saves':
        out.push({ key, label: 'Saves', home: String(a.saves), away: String(b.saves), homeValue: a.saves, awayValue: b.saves });
        break;
    }
  }
  return out;
}

/** Share of the comparison bar for the home side, 0..1 (0.5 when both are 0). Pure. */
export function homeShare(row: Pick<StatRow, 'homeValue' | 'awayValue'>): number {
  const t = row.homeValue + row.awayValue;
  return t > 0 ? row.homeValue / t : 0.5;
}

export interface ScorerLine {
  text: string;
  minute: number;
  ownGoal: boolean;
}

/**
 * Goals per scoring team, in match order: "Name 23'" ("(og)" for an own goal, which counts for `team`). Goals by the
 * same player are listed once with every minute ("Name 12', 67'"). Pure.
 */
export function scorersByTeam(summary: MatchSummary, nameOf: (team: number, rosterIdx: number) => string): [ScorerLine[], ScorerLine[]] {
  const out: [ScorerLine[], ScorerLine[]] = [[], []];
  const index: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
  for (const g of summary.goals) {
    const team = g.team === 1 ? 1 : 0;
    // An own goal is scored by a player of the other team.
    const playerTeam = g.ownGoal ? 1 - team : team;
    const name = g.rosterIdx >= 0 ? nameOf(playerTeam, g.rosterIdx) : 'Unknown';
    const key = `${playerTeam}:${g.rosterIdx}:${g.ownGoal ? 1 : 0}`;
    const min = Math.max(1, Math.floor(g.minute));
    const at = index[team].get(key);
    if (at !== undefined) {
      const line = out[team][at]!;
      line.text = line.text.replace(/( \(og\))?$/, `, ${min}'$1`);
      continue;
    }
    index[team].set(key, out[team].length);
    out[team].push({ text: `${name} ${min}'${g.ownGoal ? ' (og)' : ''}`, minute: min, ownGoal: g.ownGoal });
  }
  return out;
}

export interface PlayerOfMatch {
  team: number;
  rosterIdx: number;
  goals: number;
  assists: number;
  /** 0..10 match rating, or null when the tracker does not rate players. */
  rating: number | null;
  /** True when the tracker named him; false when derived here from goals and assists. */
  official: boolean;
}

/**
 * Player of the match: the tracker's pick (MOD-05), else the best rated player, else the player with the most goals
 * (then assists; own goals do not count), preferring the winning side on a tie. null when nobody stands out. Pure.
 */
export function pickPlayerOfMatch(summary: MatchSummary): PlayerOfMatch | null {
  const stat = (team: number, roster: number) => summary.players.find((p) => p.team === team && p.rosterIdx === roster);
  const count = (team: number, roster: number): { goals: number; assists: number } => {
    let goals = 0;
    let assists = 0;
    for (const g of summary.goals) {
      if (g.ownGoal || g.team !== team) continue;
      if (g.rosterIdx === roster) goals++;
      if (g.assistRosterIdx === roster) assists++;
    }
    return { goals, assists };
  };
  const pm = summary.playerOfMatch;
  if (pm && (pm.team === 0 || pm.team === 1) && pm.rosterIdx >= 0) {
    const ps = stat(pm.team, pm.rosterIdx);
    const c = count(pm.team, pm.rosterIdx);
    return { team: pm.team, rosterIdx: pm.rosterIdx, goals: ps?.goals ?? c.goals, assists: ps?.assists ?? c.assists, rating: ps ? ps.rating : null, official: true };
  }
  if (summary.players.length > 0) {
    let best = summary.players[0]!;
    for (const p of summary.players) {
      if (p.rating > best.rating || (p.rating === best.rating && p.team === summary.winner && best.team !== summary.winner)) best = p;
    }
    if (best.rating > 0) return { team: best.team, rosterIdx: best.rosterIdx, goals: best.goals, assists: best.assists, rating: best.rating, official: false };
  }
  let pick: PlayerOfMatch | null = null;
  let pickScore = 0;
  const seen = new Set<string>();
  for (const g of summary.goals) {
    for (const [team, roster] of [[g.team, g.rosterIdx], [g.team, g.assistRosterIdx]] as const) {
      if (g.ownGoal || roster < 0 || (team !== 0 && team !== 1)) continue;
      const key = `${team}:${roster}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const c = count(team, roster);
      const score = c.goals * 2 + c.assists;
      const better = score > pickScore || (score === pickScore && pick !== null && team === summary.winner && pick.team !== summary.winner);
      if (score > 0 && (pick === null || better)) {
        pick = { team, rosterIdx: roster, goals: c.goals, assists: c.assists, rating: null, official: false };
        pickScore = score;
      }
    }
  }
  return pick;
}

// ============================================================ app helpers

/** Club of a team in the running (or just finished) match: from the state, else from the setup. */
export function clubOf(ctx: AppContext, team: number): Club | undefined {
  const s = ctx.session.getState();
  if (s) return ctx.clubs[s.teams[team === 1 ? 1 : 0]!.clubIdx];
  const cfg = ctx.session.getSetup()?.config;
  return cfg ? ctx.clubs[team === 1 ? cfg.awayClub : cfg.homeClub] : undefined;
}

/** Display name of a squad member (state squads first, then the club data). */
export function playerName(ctx: AppContext, team: number, rosterIdx: number, s: ReadonlySimState | null = ctx.session.getState()): string {
  const d = s?.squads[team]?.[rosterIdx] ?? clubOf(ctx, team)?.squad[rosterIdx];
  return d ? d.name : `Player ${rosterIdx + 1}`;
}

/** The running match's stats so far (AppSession.runtime().stats), or null. */
export function liveSummary(ctx: AppContext): MatchSummary | null {
  const r = (ctx.session as unknown as { runtime?: () => { curr: ReadonlySimState; stats: { summary(s: ReadonlySimState): MatchSummary } } | null }).runtime;
  if (typeof r !== 'function') return null;
  try {
    const rt = r.call(ctx.session);
    return rt ? rt.stats.summary(rt.curr) : null;
  } catch {
    return null;
  }
}

// ============================================================ shared DOM

const CSS = `
.brk { justify-content:center; }
.brk-panel { box-sizing:border-box; width: min(820px, 100%); max-height:100%; overflow-y:auto; display:flex; flex-direction:column;
  gap: var(--space-5); padding: var(--space-6); background: var(--surface-1); border: var(--line) solid var(--hairline);
  border-radius: var(--radius-lg); box-shadow: var(--shadow-2); }
.brk-eyebrow { margin:0; text-align:center; }
.brk-score { display:grid; grid-template-columns: 1fr auto 1fr; align-items:center; gap: var(--space-5); }
.brk-team { display:flex; align-items:center; gap: var(--space-4); min-width:0; }
.brk-team--home { justify-content:flex-end; text-align:right; }
.brk-team__crest { width:56px; height:56px; flex: 0 0 auto; }
.brk-team__text { display:flex; flex-direction:column; gap:2px; min-width:0; }
.brk-team__code { font: var(--fw-num-bold) var(--fs-lg) / 1 var(--font-num); letter-spacing: 0.04em; }
.brk-team__name { font-size: var(--fs-sm); color: var(--text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.brk-team.is-loser .brk-team__code { color: var(--text-2); }
.brk-goals { font: var(--fw-num-bold) var(--fs-hero) / 1 var(--font-num); font-variant-numeric: tabular-nums; letter-spacing: -0.02em;
  display:flex; gap: var(--space-4); align-items:center; }
.brk-goals__sep { color: var(--text-3); font-weight: var(--fw-num); }
.brk-result { margin:0; text-align:center; font: var(--fw-num) var(--fs-sm) / 1.3 var(--font-num); color: var(--text-2); }
.brk-scorers { display:grid; grid-template-columns: 1fr 1fr; gap: var(--space-2) var(--space-7); font-size: var(--fs-sm); color: var(--text-2); }
.brk-scorers__col { display:flex; flex-direction:column; gap: 4px; min-width:0; }
.brk-scorers__col--home { text-align:right; }
.brk-scorers__col span { font-variant-numeric: tabular-nums; }
.brk-stats { display:flex; flex-direction:column; gap: var(--space-3); }
.brk-stat { display:grid; grid-template-columns: 5.5em 1fr 5.5em; align-items:center; gap: 4px var(--space-4); }
.brk-stat__v { font: var(--fw-num-bold) var(--fs-md) / 1 var(--font-num); font-variant-numeric: tabular-nums; }
.brk-stat__v--home { text-align:right; }
.brk-stat__label { text-align:center; font-size: var(--fs-sm); color: var(--text-2); }
.brk-stat__bar { grid-column: 1 / -1; display:flex; gap: 3px; height: 4px; }
.brk-stat__half { position:relative; flex: 1 1 0; background: var(--surface-3); border-radius: 2px; overflow:hidden; }
.brk-stat__fill { position:absolute; inset:0; transform-origin: 100% 50%; background: var(--text-2); }
.brk-stat__half--away .brk-stat__fill { transform-origin: 0 50%; background: var(--text-3); }
.brk-actions { display:flex; gap: var(--space-4); justify-content:center; flex-wrap:wrap; }
.brk-actions .btn { min-width: 200px; }
@media (max-height: 640px) {
  .brk-panel { padding: var(--space-4); gap: var(--space-3); }
  .brk-goals { font-size: var(--fs-xl); }
  .brk-team__crest { width:40px; height:40px; }
}
`;

export function injectBreakStyle(): void {
  injectStyle('break-screens', CSS);
}

/** Crests, codes, names and the score; `winner` 0 / 1 dims the other side. */
export function createScoreHeader(ctx: AppContext, goals: readonly [number, number], winner = -1, testId = 'brk-score'): HTMLElement {
  const side = (team: number): HTMLElement => {
    const club = clubOf(ctx, team);
    const crest = h('img', { class: 'brk-team__crest', attrs: { alt: '', 'aria-hidden': 'true' } });
    try {
      if (club) crest.src = crestDataUrl(club);
    } catch {
      /* crest art is optional */
    }
    const text = h('span', { class: 'brk-team__text' },
      h('span', { class: 'brk-team__code', text: club?.code ?? (team === 0 ? 'HOM' : 'AWY') }),
      h('span', { class: 'brk-team__name', text: club?.name ?? '' }));
    const el = h('div', { class: `brk-team brk-team--${team === 0 ? 'home' : 'away'}`, testId: `brk-team-${team}` });
    if (winner >= 0 && winner !== team) el.classList.add('is-loser');
    if (team === 0) el.append(text, crest);
    else el.append(crest, text);
    return el;
  };
  return h(
    'div',
    { class: 'brk-score', testId, attrs: { 'aria-label': `${clubOf(ctx, 0)?.name ?? 'Home'} ${goals[0]}, ${clubOf(ctx, 1)?.name ?? 'Away'} ${goals[1]}` } },
    side(0),
    h('div', { class: 'brk-goals num' },
      h('span', { text: String(goals[0]), testId: 'brk-goals-0' }),
      h('span', { class: 'brk-goals__sep', text: '–' }),
      h('span', { text: String(goals[1]), testId: 'brk-goals-1' })),
    side(1),
  );
}

/** Scorer columns under the score (empty element when nobody scored). */
export function createScorers(ctx: AppContext, summary: MatchSummary | null): HTMLElement {
  const box = h('div', { class: 'brk-scorers', testId: 'brk-scorers' });
  if (!summary || summary.goals.length === 0) return box;
  const s = ctx.session.getState();
  const cols = scorersByTeam(summary, (team, roster) => playerName(ctx, team, roster, s));
  for (let t = 0; t < 2; t++) {
    const col = h('div', { class: `brk-scorers__col brk-scorers__col--${t === 0 ? 'home' : 'away'}`, testId: `brk-scorers-${t}` });
    for (const line of cols[t]!) col.append(h('span', { text: line.text }));
    box.append(col);
  }
  return box;
}

/** Comparison rows (value | label | value, with a two-sided bar). */
export function createStatList(rows: readonly StatRow[], testId: string): HTMLElement {
  const box = h('div', { class: 'brk-stats', testId });
  for (const r of rows) {
    const share = homeShare(r);
    const fillH = h('span', { class: 'brk-stat__fill' });
    const fillA = h('span', { class: 'brk-stat__fill' });
    const tot = r.homeValue + r.awayValue;
    fillH.style.transform = `scaleX(${(tot > 0 ? share : 0).toFixed(3)})`;
    fillA.style.transform = `scaleX(${(tot > 0 ? 1 - share : 0).toFixed(3)})`;
    box.append(
      h(
        'div',
        { class: 'brk-stat', testId: `stat-${r.key}` },
        h('span', { class: 'brk-stat__v brk-stat__v--home', text: r.home, testId: `stat-${r.key}-home` }),
        h('span', { class: 'brk-stat__label', text: r.label }),
        h('span', { class: 'brk-stat__v', text: r.away, testId: `stat-${r.key}-away` }),
        h('span', { class: 'brk-stat__bar', attrs: { 'aria-hidden': 'true' } },
          h('span', { class: 'brk-stat__half brk-stat__half--home' }, fillH),
          h('span', { class: 'brk-stat__half brk-stat__half--away' }, fillA)),
      ),
    );
  }
  return box;
}

// ============================================================ screen

export function createHalfTimeScreen(): Screen {
  let ctxRef: AppContext | null = null;
  return {
    id: 'half-time',
    mount(root: HTMLElement, ctx: AppContext) {
      injectBreakStyle();
      ctxRef = ctx;
      root.classList.add('screen--overlay', 'brk');
      const s = ctx.session.getState();
      const summary = liveSummary(ctx);
      const goals: [number, number] = s ? [s.teams[0]!.goals, s.teams[1]!.goals] : summary ? [summary.teams[0].goals, summary.teams[1].goals] : [0, 0];
      const extra = !!s && s.match.period >= Period.ET_FIRST;
      const panel = h(
        'div',
        { class: 'brk-panel', testId: 'half-time-panel' },
        h('h1', { class: 'brk-eyebrow eyebrow', text: extra ? 'Extra time · half time' : 'Half time', testId: 'half-time-title' }),
        createScoreHeader(ctx, goals, -1, 'half-time-score'),
        createScorers(ctx, summary),
      );
      if (summary) panel.append(createStatList(statRows(summary, HALF_STAT_KEYS), 'ht-stats'));
      const actions = h(
        'div',
        { class: 'brk-actions' },
        createButton(extra ? 'Continue' : 'Second half', () => sendSkip(ctx), { testId: 'ht-continue', variant: 'primary', autofocus: true, ctx }),
      );
      const canManage = !!s && manageableTeams(s, uiHumanOf(ctx), ctx.session.getSetup()?.config.mode === ModeId.FRIEND_ONLINE).length > 0;
      if (canManage) {
        actions.append(
          createButton('Substitutions', () => openPausePage(ctx, 'team'), { testId: 'ht-team', hint: 'Formation and changes', ctx }),
          createButton('Tactics', () => openPausePage(ctx, 'tactics'), { testId: 'ht-tactics', hint: 'Quick tactics, focus', ctx }),
        );
      }
      panel.append(actions);
      root.append(panel);
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
