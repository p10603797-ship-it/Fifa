/**
 * [UIX-03] Team and kit select (BRIEF §11 Kick-Off "pick teams, kits", §15 clubs, §12 Dot design system).
 *
 * Layout (original): the home side's panel on the left, the club grid (20 clubs, generated crests from GFX-08
 * crestDataUrl) in the middle, the away side's panel on the right. A panel shows the side's club (crest, name, city,
 * 3-letter code, overall rating as a number and as stars, style, formation), its kit choice (home or away kit, drawn
 * by GFX-08 kitDataUrl) and the result of the automatic clash check (GFX-08 resolveKits, the same check the match
 * uses, including the grass and high-contrast kits).
 *
 * One side is "active" (ember outline): a club picked in the grid goes to it. Picking for home moves the active side
 * to away. A new club starts in its home kit; when the clash check would change a kit, the kit actually worn is
 * selected so the panel shows what will be on the pitch. A clash left by an explicit kit choice is shown as a warning
 * (the match applies the same resolution).
 *
 * Input: touch: tap a side's header to make it active, tap a club, tap a kit; Random picks a club for the active side;
 * Continue goes to the next step of the flow (matchFlow.ts: side select) with the partial MatchSetup (clubs, kits,
 * the clubs' preferred formations). Controller / keyboard: D-pad / arrows browse the grid (spatial focus), Confirm
 * picks, L1 / R1 (Q / E) switch the active side; Back goes back.
 */
import type { AppContext, Screen, ScreenParams } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { KitSlot, Role, TeamStyle } from '../../contracts/enums';
import { getFormation } from '../../data/formations';
import { crestDataUrl, kitDataUrl, resolveKits, type MatchKits } from '../../render/kits';
import { createButton, h, injectStyle, setSelected } from '../components';
import { attachDotField, sharedDotField } from '../dotfield';
import { MODE_LABELS, createFlowTop, createStepDots, goNext, injectFlowStyle, readFlow, type FlowParams } from './matchFlow';

export const RATING_MIN = 62;
export const RATING_MAX = 88;

export const STYLE_LABELS: Readonly<Record<TeamStyle, string>> = {
  [TeamStyle.POSSESSION]: 'Possession',
  [TeamStyle.COUNTER]: 'Counter-attack',
  [TeamStyle.DIRECT]: 'Direct',
  [TeamStyle.HIGH_PRESS]: 'High press',
  [TeamStyle.WING_PLAY]: 'Wing play',
};

/** Short position names (key players). */
export const ROLE_SHORT: Readonly<Record<Role, string>> = {
  [Role.GK]: 'GK', [Role.RB]: 'RB', [Role.CB]: 'CB', [Role.LB]: 'LB', [Role.RWB]: 'RWB', [Role.LWB]: 'LWB', [Role.CDM]: 'DM',
  [Role.CM]: 'CM', [Role.CAM]: 'AM', [Role.RM]: 'RM', [Role.LM]: 'LM', [Role.RW]: 'RW', [Role.LW]: 'LW', [Role.ST]: 'ST', [Role.CF]: 'CF',
};

/** Star rating 1..5 in half steps for an overall rating (62 -> 1, 88 -> 5). */
export function ratingStars(rating: number): number {
  const r = Number.isFinite(rating) ? rating : RATING_MIN;
  const f = (r - RATING_MIN) / (RATING_MAX - RATING_MIN);
  const s = 1 + 4 * (f < 0 ? 0 : f > 1 ? 1 : f);
  return Math.round(s * 2) / 2;
}

export type Side = 0 | 1;

/** Working choice of team select. */
export interface TeamChoice {
  club: [number, number];
  kit: [KitSlot, KitSlot];
}

export interface ClashSummary {
  /** True when no kit had to change. */
  clear: boolean;
  /** One line for the whole fixture. */
  text: string;
  /** Per side: no kit of this side changed. */
  sideClear: [boolean, boolean];
  /** Per side: one short line. */
  side: [string, string];
  kits: MatchKits;
}

function slotName(s: KitSlot): string {
  return s === KitSlot.AWAY ? 'away' : 'home';
}

/** Clash check for a choice: GFX-08 resolveKits (the same check the match runs) plus short summaries. */
export function clashSummary(clubs: readonly Club[], choice: TeamChoice, highContrast = false): ClashSummary {
  const home = clubs[choice.club[0]] ?? null;
  const away = clubs[choice.club[1]] ?? null;
  const kits = resolveKits(home, away, choice.kit[0], choice.kit[1], highContrast);
  const codes = [home?.code ?? 'Home', away?.code ?? 'Away'];
  const side: [string, string] = ['No clash', 'No clash'];
  const sideClear: [boolean, boolean] = [true, true];
  const notes: string[] = [];
  for (const s of [0, 1] as const) {
    let note = '';
    if (kits.fallback[s]) note = 'wear a change kit (both kits clash)';
    else if (kits.slot[s] !== kits.requested[s]) note = `switch to their ${slotName(kits.slot[s])} kit${s === 0 ? ' (too close to the grass)' : ''}`;
    else if (kits.shortsSwapped[s]) note = 'change shorts';
    if (note) {
      sideClear[s] = false;
      side[s] = `Clash: ${note}`;
      notes.push(`${codes[s]} ${note}`);
    }
  }
  const clear = sideClear[0] && sideClear[1];
  return { clear, text: clear ? 'Kits clear: no clash' : `Kit clash: ${notes.join('; ')}`, sideClear, side, kits };
}

/**
 * Pick `clubIdx` for `side`: the side starts in its home kit, then any kit the clash check would change is set to
 * the one actually worn (so the choice shows what is on the pitch). Mutates and returns `choice`.
 */
export function pickClub(clubs: readonly Club[], choice: TeamChoice, side: Side, clubIdx: number, highContrast = false): TeamChoice {
  if (!Number.isInteger(clubIdx) || clubIdx < 0 || clubIdx >= clubs.length) return choice;
  choice.club[side] = clubIdx;
  choice.kit[side] = KitSlot.HOME;
  return settleKits(clubs, choice, highContrast);
}

/** Set each requested kit to the kit the clash check picks (fallback kits keep the request). Mutates `choice`. */
export function settleKits(clubs: readonly Club[], choice: TeamChoice, highContrast = false): TeamChoice {
  const r = resolveKits(clubs[choice.club[0]] ?? null, clubs[choice.club[1]] ?? null, choice.kit[0], choice.kit[1], highContrast);
  for (const s of [0, 1] as const) {
    if (!r.fallback[s] && (r.slot[s] === KitSlot.HOME || r.slot[s] === KitSlot.AWAY)) choice.kit[s] = r.slot[s];
  }
  return choice;
}

/** A random club index other than `avoid` (rand in [0, 1)). */
export function randomClub(count: number, avoid: number, rand: () => number = Math.random): number {
  if (count <= 1) return 0;
  let i = Math.floor(rand() * (count - 1));
  if (i < 0) i = 0;
  if (i >= count - 1) i = count - 2;
  return i >= avoid && avoid >= 0 ? i + 1 : i;
}

/** Write the choice into the flow config (clubs, kits, the clubs' preferred formations). */
export function applyTeamChoice(flow: FlowParams, clubs: readonly Club[], choice: TeamChoice): void {
  const c = flow.setup.config;
  c.homeClub = choice.club[0];
  c.awayClub = choice.club[1];
  c.homeKit = choice.kit[0];
  c.awayKit = choice.kit[1];
  const hc = clubs[c.homeClub], ac = clubs[c.awayClub];
  if (hc) c.homeFormation = hc.formation;
  if (ac) c.awayFormation = ac.formation;
}

function validIdx(clubs: readonly Club[], i: number, def: number): number {
  return Number.isInteger(i) && i >= 0 && i < clubs.length ? i : def;
}

function kitSlot(k: number, def: KitSlot): KitSlot {
  return k === KitSlot.HOME || k === KitSlot.AWAY ? k : def;
}

/** Initial choice from the flow config (out-of-range clubs fall back to 0 / 1). */
export function choiceFromFlow(flow: FlowParams, clubs: readonly Club[]): TeamChoice {
  const c = flow.setup.config;
  const home = validIdx(clubs, c.homeClub, 0);
  const away = validIdx(clubs, c.awayClub, clubs.length > 1 ? 1 : 0);
  return { club: [home, away], kit: [kitSlot(c.homeKit, KitSlot.HOME), kitSlot(c.awayKit, KitSlot.AWAY)] };
}

const CSS = `
.ts-layout { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(230px, 280px) minmax(0, 1fr) minmax(230px, 280px);
  gap: var(--space-5); align-items: stretch; width: 100%; max-width: 1400px; margin: 0 auto; }
.ts-side { display: flex; flex-direction: column; align-items: stretch; gap: var(--space-3); min-height: 0; min-width: 0;
  padding: var(--space-4); background: var(--surface-1); border: 1px solid var(--hairline); border-radius: var(--radius-lg);
  transition: border-color var(--dur) var(--ease); }
.ts-side.is-active { border-color: var(--ember); }
.btn.ts-head { justify-content: space-between; min-height: var(--target); padding: 0 var(--space-4); background: var(--surface-2);
  border: 1px solid var(--hairline); }
.ts-head-side { font: 700 var(--fs-sm) / 1 var(--font-ui); letter-spacing: var(--tracking-caps); text-transform: uppercase; }
.ts-head-state { font: 500 var(--fs-xs) / 1 var(--font-ui); color: var(--text-3); }
.ts-side.is-active .ts-head-state { color: var(--ember); }
.ts-body { display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; }
.ts-id { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-3); align-items: center; }
.ts-crest { width: 64px; height: 64px; display: block; }
.ts-name { margin: 0; font: 700 var(--fs-md) / 1.15 var(--font-ui); overflow: hidden; text-overflow: ellipsis;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.ts-city { margin: 2px 0 0; font-size: var(--fs-xs); color: var(--text-3); }
.ts-stats { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); white-space: nowrap; }
.ts-code { font: 600 var(--fs-lg) / 1 var(--font-num); letter-spacing: 0.04em; }
.ts-ovr { font: 500 var(--fs-sm) / 1 var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-2); }
.ts-stars { position: relative; display: inline-block; font-size: 14px; line-height: 1; letter-spacing: 1px; color: var(--hairline-strong); }
.ts-stars-fill { position: absolute; left: 0; top: 0; overflow: hidden; white-space: nowrap; color: var(--text-1); }
.ts-meta { margin: 0; font-size: var(--fs-sm); color: var(--text-2); }
.ts-keys { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: var(--space-2) 0 0; list-style: none; border-top: 1px solid var(--hairline); }
.ts-keys li { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; gap: var(--space-2); align-items: baseline; font-size: var(--fs-xs); color: var(--text-2); }
.ts-keys .pos { font: 600 var(--fs-xs) / 1 var(--font-num); color: var(--text-3); }
.ts-keys .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ts-keys .num { color: var(--text-1); }
.ts-kits { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-2); }
.ts-kit { appearance: none; -webkit-appearance: none; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; min-height: var(--target); padding: var(--space-2); border-radius: var(--radius); background: var(--surface-2);
  border: 1px solid var(--hairline); color: var(--text-2); font: 500 var(--fs-xs) / 1 var(--font-ui); cursor: pointer; }
.ts-kit img { width: 54px; height: 64px; display: block; pointer-events: none; }
.ts-kit[data-selected] { border-color: var(--text-1); color: var(--text-1); background: var(--surface-3); }
.ts-side.is-active .ts-kit[data-selected] { border-color: var(--ember); }
.ts-clash { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); font-size: var(--fs-xs); line-height: 1.3;
  background: var(--success-soft); color: var(--success); }
.ts-clash.is-warn { background: var(--warning-soft); color: var(--warning); }
.ts-grid { display: grid; grid-template-columns: repeat(5, minmax(60px, 1fr)); grid-auto-rows: minmax(var(--target), 128px); gap: var(--space-2);
  align-content: center; min-height: 0; min-width: 0; max-width: 680px; width: 100%; justify-self: center; padding: 4px; overflow: auto; }
.ts-card { position: relative; appearance: none; -webkit-appearance: none; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 4px; min-height: var(--target); min-width: 60px; padding: var(--space-2) 2px; border-radius: var(--radius);
  background: var(--surface-1); border: 1px solid var(--hairline); color: var(--text-1); cursor: pointer;
  transition: transform var(--dur-fast) var(--ease); }
.ts-card:active { transform: scale(0.97); }
.ts-card img { width: 40px; height: 40px; display: block; pointer-events: none; }
.ts-card-code { font: 600 var(--fs-sm) / 1 var(--font-num); letter-spacing: 0.04em; }
.ts-card-ovr { font: 400 var(--fs-xs) / 1 var(--font-num); color: var(--text-3); }
.ts-card.is-home, .ts-card.is-away { border-color: var(--text-2); background: var(--surface-2); }
.ts-card.is-pick-active { border-color: var(--ember); background: var(--ember-tint); }
.ts-badges { position: absolute; top: 4px; left: 4px; right: 4px; display: flex; justify-content: space-between; pointer-events: none; }
.ts-badge { visibility: hidden; min-width: 16px; padding: 2px 4px; border-radius: 6px; font: 700 10px / 1 var(--font-ui);
  background: var(--surface-4); color: var(--text-1); }
.ts-card.is-home .ts-badge--h, .ts-card.is-away .ts-badge--a { visibility: visible; }
.ts-badge.is-active { background: var(--ember); color: var(--text-on-ember); }
@media (max-height: 640px) {
  .ts-crest { width: 48px; height: 48px; }
  .ts-kit img { width: 40px; height: 48px; }
  .ts-side { gap: var(--space-2); padding: var(--space-3); }
  .ts-card img { width: 30px; height: 30px; }
  .ts-city { display: none; }
}
@media (max-height: 720px) {
  .ts-keys { display: none; }
}
@media (max-width: 1100px) {
  .ts-layout { grid-template-columns: minmax(210px, 240px) minmax(0, 1fr) minmax(210px, 240px); gap: var(--space-4); }
}
`;

const STAR_TEXT = '★★★★★';

function starsEl(rating: number): HTMLElement {
  const s = ratingStars(rating);
  const fill = h('span', { class: 'ts-stars-fill', text: STAR_TEXT });
  fill.style.width = `${(s / 5) * 100}%`;
  return h('span', { class: 'ts-stars', attrs: { role: 'img', 'aria-label': `${s} of 5 stars` } }, STAR_TEXT, fill);
}

/** The club's best three players (overall), for the panel. */
export function keyPlayers(club: Club, n = 3): Club['squad'] {
  return (club.squad ?? []).slice().sort((a, b) => b.overall - a.overall).slice(0, n);
}

function keyPlayersEl(club: Club): HTMLElement {
  const ul = h('ul', { class: 'ts-keys', attrs: { 'aria-label': 'Key players' } });
  for (const p of keyPlayers(club)) {
    ul.append(h('li', {}, h('span', { class: 'pos', text: ROLE_SHORT[p.pos] ?? '' }), h('span', { class: 'nm', text: p.name }), h('span', { class: 'num', text: String(p.overall) })));
  }
  return ul;
}

interface SideView {
  root: HTMLElement;
  head: HTMLButtonElement;
  body: HTMLElement;
  kitBtns: [HTMLButtonElement, HTMLButtonElement];
  clash: HTMLElement;
}

export function createTeamSelectScreen(): Screen {
  let detachDots: (() => void) | null = null;
  let cleanup: (() => void) | null = null;
  return {
    id: 'team-select',
    mount(root: HTMLElement, ctx: AppContext, params: ScreenParams) {
      injectFlowStyle();
      injectStyle('team-select', CSS);
      root.classList.add('flow');
      detachDots = attachDotField(root);
      const clubs = ctx.clubs;
      const flow = readFlow(ctx, params);
      const highContrast = (): boolean => !!ctx.settings.get().accessibility?.highContrastKits;
      const choice = choiceFromFlow(flow, clubs);
      let active: Side = 0;
      const sound = (k: UiSound): void => {
        try {
          ctx.audio.playUi(k);
        } catch {
          /* audio never breaks a menu */
        }
      };

      // ---- grid
      const cards: HTMLButtonElement[] = [];
      const grid = h('div', { class: 'ts-grid', testId: 'ts-grid', attrs: { role: 'listbox', 'aria-label': 'Clubs', 'data-focus-group': 'none' } });
      clubs.forEach((club, i) => {
        const img = h('img', { attrs: { src: crestDataUrl(club), alt: '', draggable: 'false' } });
        const card = h(
          'button',
          { class: 'ts-card', testId: `ts-club-${i}`, attrs: { role: 'option', 'aria-label': `${club.name}, ${club.code}, overall ${club.rating}` } },
          h('span', { class: 'ts-badges', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'ts-badge ts-badge--h', text: 'H' }), h('span', { class: 'ts-badge ts-badge--a', text: 'A' })),
          img,
          h('span', { class: 'ts-card-code', text: club.code }),
          h('span', { class: 'ts-card-ovr', text: String(club.rating) }),
        );
        card.type = 'button';
        card.dataset.focus = '';
        card.addEventListener('click', (e) => {
          e.preventDefault();
          sound(UiSound.CONFIRM);
          pick(i);
        });
        cards.push(card);
        grid.append(card);
      });

      // ---- side panels
      const makeSide = (side: Side): SideView => {
        const head = createButton(side === 0 ? 'Home' : 'Away', () => setActive(side, true), {
          testId: `ts-side-${side === 0 ? 'home' : 'away'}`, ctx, sound: UiSound.MOVE, extraClass: 'ts-head',
        });
        head.replaceChildren(h('span', { class: 'ts-head-side', text: side === 0 ? 'Home' : 'Away' }), h('span', { class: 'ts-head-state' }));
        const kitBtn = (slot: KitSlot): HTMLButtonElement => {
          const b = h('button', { class: 'ts-kit', testId: `ts-kit-${side === 0 ? 'home' : 'away'}-${slot === KitSlot.HOME ? 'home' : 'away'}`, attrs: { role: 'radio' } });
          b.type = 'button';
          b.dataset.focus = '';
          b.addEventListener('click', (e) => {
            e.preventDefault();
            if (choice.kit[side] === slot) return;
            choice.kit[side] = slot;
            sound(UiSound.TOGGLE);
            commit();
          });
          return b;
        };
        const kitBtns: [HTMLButtonElement, HTMLButtonElement] = [kitBtn(KitSlot.HOME), kitBtn(KitSlot.AWAY)];
        const body = h('div', { class: 'ts-body' });
        const clash = h('p', { class: 'ts-clash', testId: `ts-clash-${side === 0 ? 'home' : 'away'}`, attrs: { 'aria-live': 'polite' } });
        const kits = h('div', { class: 'ts-kits', attrs: { role: 'radiogroup', 'aria-label': 'Kit', 'data-focus-group': 'x' } }, ...kitBtns);
        const rootEl = h('section', { class: 'ts-side', testId: `ts-panel-${side === 0 ? 'home' : 'away'}` }, head, body, h('p', { class: 'eyebrow', text: 'Kit' }), kits, clash);
        return { root: rootEl, head, body, kitBtns, clash };
      };
      const sides: [SideView, SideView] = [makeSide(0), makeSide(1)];

      const renderSide = (side: Side, summary: ClashSummary): void => {
        const v = sides[side];
        const club = clubs[choice.club[side]];
        v.root.classList.toggle('is-active', active === side);
        (v.head.lastChild as HTMLElement).textContent = active === side ? 'Choosing' : 'Change';
        v.head.setAttribute('aria-pressed', active === side ? 'true' : 'false');
        if (!club) {
          v.body.replaceChildren();
          return;
        }
        v.body.replaceChildren(
          h('div', { class: 'ts-id' },
            h('img', { class: 'ts-crest', attrs: { src: crestDataUrl(club), alt: `${club.name} crest`, draggable: 'false' } }),
            h('div', {}, h('h2', { class: 'ts-name', text: club.name, testId: `ts-name-${side === 0 ? 'home' : 'away'}` }), h('p', { class: 'ts-city', text: club.city }))),
          h('div', { class: 'ts-stats' }, h('span', { class: 'ts-code', text: club.code }), starsEl(club.rating), h('span', { class: 'ts-ovr', text: `OVR ${club.rating}` })),
          h('p', { class: 'ts-meta', text: `${STYLE_LABELS[club.style] ?? 'Balanced'} · ${getFormation(club.formation).name}` }),
          keyPlayersEl(club),
        );
        const kitsOf: [typeof club.home, typeof club.away] = [club.home, club.away];
        v.kitBtns.forEach((b, i) => {
          const slot = i === 0 ? KitSlot.HOME : KitSlot.AWAY;
          b.replaceChildren(h('img', { attrs: { src: kitDataUrl(kitsOf[i]!), alt: '', draggable: 'false' } }), h('span', { text: i === 0 ? 'Home kit' : 'Away kit' }));
          b.setAttribute('aria-label', `${club.code} ${i === 0 ? 'home' : 'away'} kit`);
          b.setAttribute('aria-checked', choice.kit[side] === slot ? 'true' : 'false');
          setSelected(b, choice.kit[side] === slot);
        });
        v.clash.textContent = summary.side[side];
        v.clash.classList.toggle('is-warn', !summary.sideClear[side]);
      };

      const render = (): void => {
        const summary = clashSummary(clubs, choice, highContrast());
        renderSide(0, summary);
        renderSide(1, summary);
        cards.forEach((c, i) => {
          const isH = choice.club[0] === i, isA = choice.club[1] === i;
          c.classList.toggle('is-home', isH);
          c.classList.toggle('is-away', isA);
          c.classList.toggle('is-pick-active', choice.club[active] === i);
          c.setAttribute('aria-selected', isH || isA ? 'true' : 'false');
          (c.querySelector('.ts-badge--h') as HTMLElement).classList.toggle('is-active', active === 0);
          (c.querySelector('.ts-badge--a') as HTMLElement).classList.toggle('is-active', active === 1);
        });
      };

      /** Store the working choice in this screen's flow (Back to this screen shows it again). */
      const commit = (): void => {
        applyTeamChoice(flow, clubs, choice);
        render();
      };

      const setActive = (side: Side, focusPick: boolean): void => {
        active = side;
        render();
        if (focusPick) {
          const c = cards[choice.club[side]];
          if (c) ctx.focus.focus(c);
        }
      };

      const pick = (i: number): void => {
        const side = active;
        pickClub(clubs, choice, side, i, highContrast());
        if (side === 0) active = 1;
        commit();
      };

      const random = (): void => {
        const i = randomClub(clubs.length, choice.club[active === 0 ? 1 : 0]);
        const side = active;
        pickClub(clubs, choice, side, i, highContrast());
        commit();
        const c = cards[i];
        if (c) ctx.focus.focus(c);
      };

      const randomBtn = createButton('Random', random, { testId: 'ts-random', ctx, sound: UiSound.MOVE, glyph: '⚄' });
      const cont = createButton('Continue', () => {
        applyTeamChoice(flow, clubs, choice);
        goNext(ctx, 'team-select', flow);
      }, { testId: 'team-continue', variant: 'primary', ctx });

      const homeCard = cards[choice.club[0]];
      if (homeCard) homeCard.dataset.focusDefault = '';

      root.append(
        createFlowTop({
          ctx, title: 'Teams and kits', eyebrow: MODE_LABELS[flow.mode], testId: 'team-select-title',
          steps: createStepDots(flow.mode, 'team-select'), actions: [randomBtn, cont],
        }),
        h('div', { class: 'ts-layout' }, sides[0].root, grid, sides[1].root),
      );
      applyTeamChoice(flow, clubs, choice);
      render();

      const off = ctx.focus.onAction((a) => {
        if (a === MenuAction.TAB_PREV || a === MenuAction.TAB_NEXT) {
          sound(UiSound.MOVE);
          setActive(active === 0 ? 1 : 0, false);
          return true;
        }
        return false;
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
