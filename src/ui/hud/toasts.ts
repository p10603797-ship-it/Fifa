/**
 * [UIX-06] In-match toasts (brief section 12 "Toasts for goals, cards, substitutions and offside"): GOAL (team, scorer,
 * minute, own goal), YELLOW / RED / SECOND YELLOW card (player), SUBSTITUTION (in / out names), OFFSIDE (player),
 * ADVANTAGE (played on / brought back) and FORFEIT. Queued (QUEUE_CAP waiting, the oldest non-goal is dropped when
 * full), one on screen at a time for TOAST_LIFE_MS (goals GOAL_LIFE_MS), sliding in and fading out with CSS keyframes
 * on transform and opacity only.
 *
 * Timing advances by FrameInfo.dtMs on unpaused frames (a paused match freezes the toast; no timers). DOM writes
 * happen only when a toast starts (its texts, team chip and class) and when it starts leaving (class): zero writes on
 * every other frame. Top centre (the HUD lane of brief section 9), clear of the scoreboard on narrow aspect ratios,
 * the touch controls and the safe areas.
 *
 * Pure parts (ToastQueue, toastForEvent) are unit-tested in Node (tests/unit/uix-06-*.test.ts).
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { CardKind } from '../../contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState, SimState } from '../../contracts/state';
import { displayClock } from '../../sim/rules/machine';
import { h, injectStyle } from '../components';
import { HUD_SHARED_CSS, bindLargerHud, minuteLabel } from './hudShared';
import { highContrastOn, kitHex, wornShirts } from './scoreboard';

/** HUD presentation constants (UI timing, not gameplay; no tuning.ts entry needed). */
export const TOAST_TUNING = {
  /** Time on screen per toast including its slide-in and fade-out, ms. */
  lifeMs: 2400,
  /** Goals stay longer, ms. */
  goalLifeMs: 3000,
  /** Forfeit notice, ms. */
  forfeitLifeMs: 3200,
  /** Fade-out at the end of the life, ms (the CSS keyframe duration). */
  outMs: 260,
  /** Slide-in, ms (the CSS keyframe duration). */
  inMs: 220,
  /** Toasts waiting behind the one on screen. */
  queueCap: 4,
} as const;

/** Below this viewport width (CSS px) the toast lane sits under the scoreboard row instead of beside it. */
export const TOAST_NARROW_PX = 1120;
/** Height reserved for the toast lane (hints stack below it), CSS px before the larger-HUD scale. */
export const TOAST_LANE_PX = 80;

const CSS = `
.hud-toasts { position:absolute; left: 50%; top: calc(var(--safe-top, 0px) + 16px); width: 0; height: 0; }
.hud-toasts[hidden] { display:none; }
.hud-toast { position:absolute; left: 0; top: 0; transform: translate(-50%, 0); display:flex; align-items:center;
  gap: calc(12px * var(--hs)); min-width: calc(220px * var(--hs)); max-width: min(calc(440px * var(--hs)), calc(100vw - 2 * var(--toast-side, 340px)));
  box-sizing: border-box; padding: calc(9px * var(--hs)) calc(16px * var(--hs)) calc(9px * var(--hs)) calc(12px * var(--hs));
  border-radius: calc(12px * var(--hs)); background: rgba(7,7,13,.88); border: 1px solid var(--hairline-strong);
  box-shadow: 0 10px 28px rgba(0,0,0,.35); color: var(--text-1); font-family: var(--font-ui); line-height: 1.15;
  opacity: 0; will-change: transform, opacity; pointer-events: none; }
.hud-toast .ht-chip { flex: none; width: calc(6px * var(--hs)); align-self: stretch; border-radius: 3px; background: var(--text-3); }
.hud-toast .ht-body { display:flex; flex-direction:column; min-width:0; gap: calc(3px * var(--hs)); }
.hud-toast .ht-head { display:flex; align-items:baseline; gap: calc(10px * var(--hs)); }
.hud-toast .ht-title { font-size: calc(13px * var(--hs)); font-weight: 700; letter-spacing: .14em; color: var(--text-1); }
.hud-toast .ht-code { font-size: calc(12px * var(--hs)); font-weight: 600; letter-spacing: .08em; color: var(--text-3); }
.hud-toast .ht-code:empty { display:none; }
.hud-toast .ht-line { font-size: calc(18px * var(--hs)); font-weight: 600; overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-toast .ht-line:empty { display:none; }
.hud-toast .ht-sub { font-size: calc(13px * var(--hs)); color: var(--text-2); overflow:hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-toast .ht-sub:empty { display:none; }
.hud-toast .ht-min { margin-left:auto; flex:none; align-self:center; font-family: var(--font-num); font-variant-numeric: tabular-nums;
  font-size: calc(16px * var(--hs)); font-weight: 600; color: var(--text-2); }
.hud-toast .ht-min:empty { display:none; }
.hud-toast[data-kind="goal"] .ht-title { color: var(--ember); font-size: calc(15px * var(--hs)); }
.hud-toast[data-kind="goal"] { border-color: rgba(255,107,53,.55); }
.hud-toast[data-kind="yellow"] .ht-chip { background: var(--warning); }
.hud-toast[data-kind="red"] .ht-chip { background: var(--error); }
.hud-toast[data-kind="yellow"] .ht-title { color: var(--warning); }
.hud-toast[data-kind="red"] .ht-title { color: var(--error); }
.hud-toast[data-kind="sub"] .ht-line::before { content: '\\25B2  '; color: var(--success); font-size: .7em; }
.hud-toast[data-kind="sub"] .ht-sub::before { content: '\\25BC  '; color: var(--error); font-size: .8em; }
.hud-toast.is-in { animation: hud-toast-in ${TOAST_TUNING.inMs}ms var(--ease, ease-out) both; }
.hud-toast.is-out { animation: hud-toast-out ${TOAST_TUNING.outMs}ms var(--ease-in, ease-in) both; }
@keyframes hud-toast-in { from { opacity: 0; transform: translate(-50%, -14px); } to { opacity: 1; transform: translate(-50%, 0); } }
@keyframes hud-toast-out { from { opacity: 1; transform: translate(-50%, 0); } to { opacity: 0; transform: translate(-50%, -8px); } }
@media (prefers-reduced-motion: reduce) {
  @keyframes hud-toast-in { from { opacity: 0; transform: translate(-50%, 0); } to { opacity: 1; transform: translate(-50%, 0); } }
}
/* Narrow screens: the toast lane moves below the scoreboard row so the two never overlap (hints.ts follows). */
.hud-toasts.hud-lg .hud-toast { --toast-side: 420px; }
@media (max-width: ${TOAST_NARROW_PX}px) {
  .hud-toasts { top: calc(var(--safe-top, 0px) + 16px + 40px * var(--hs) + 12px); }
  /* Clear of the top-right pause button (touch overlay / match screen). */
  .hud-toast, .hud-toasts.hud-lg .hud-toast { --toast-side: 110px; }
}
`;

// ============================================================ pure parts

export type ToastKind = 'goal' | 'yellow' | 'red' | 'sub' | 'offside' | 'advantage' | 'forfeit';

export interface ToastSpec {
  kind: ToastKind;
  /** Small caps headline ('GOAL', 'YELLOW CARD'). */
  title: string;
  /** Team code next to the title ('' for none). */
  code: string;
  /** Main line (scorer, player, player coming on). */
  line: string;
  /** Second line (player going off, detail). */
  sub: string;
  /** Minute label ('23'', '45+2'') or ''. */
  minute: string;
  /** Team whose kit colour the chip shows (-1 none). */
  team: number;
  /** Time on screen, ms. */
  lifeMs: number;
}

/** Changes reported by ToastQueue.advance(). */
export const TOAST_SHOW = 1;
export const TOAST_LEAVE = 2;
export const TOAST_CLEAR = 4;

/**
 * Toast queue: one item on screen, up to `cap` waiting. push() enqueues (dropping the oldest waiting non-goal when
 * full, else the oldest); advance(dt) moves time on and reports what the DOM must do. Pure (no DOM, no clock).
 */
export class ToastQueue<T extends { lifeMs: number; kind?: string }> {
  private readonly waiting: T[] = [];
  private cur: T | null = null;
  private elapsed = 0;
  private leaving = false;
  /** Number of toasts dropped because the queue was full. */
  dropped = 0;

  constructor(private readonly cap: number = TOAST_TUNING.queueCap, private readonly outMs: number = TOAST_TUNING.outMs) {}

  get current(): T | null {
    return this.cur;
  }

  get pending(): number {
    return this.waiting.length;
  }

  /** True once the current toast has started its fade-out. */
  get isLeaving(): boolean {
    return this.leaving;
  }

  push(item: T): void {
    if (this.waiting.length >= this.cap) {
      let drop = -1;
      for (let i = 0; i < this.waiting.length; i++) {
        if (this.waiting[i]!.kind !== 'goal') {
          drop = i;
          break;
        }
      }
      if (drop < 0 && item.kind !== 'goal') {
        this.dropped++;
        return;
      }
      this.waiting.splice(drop < 0 ? 0 : drop, 1);
      this.dropped++;
    }
    this.waiting.push(item);
  }

  /** Advance by dtMs (ignored when not finite or negative). Returns TOAST_* bits for the DOM. */
  advance(dtMs: number): number {
    const dt = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : 0;
    let out = 0;
    if (this.cur) {
      this.elapsed += dt;
      const life = this.cur.lifeMs;
      if (!this.leaving && this.elapsed >= life - this.outMs) {
        this.leaving = true;
        out |= TOAST_LEAVE;
      }
      if (this.elapsed >= life) {
        this.cur = null;
        this.leaving = false;
        this.elapsed = 0;
        if (this.waiting.length === 0) out |= TOAST_CLEAR;
        out &= ~TOAST_LEAVE;
      }
    }
    if (!this.cur && this.waiting.length > 0) {
      this.cur = this.waiting.shift()!;
      this.elapsed = 0;
      this.leaving = false;
      out = (out & ~TOAST_CLEAR) | TOAST_SHOW;
    }
    return out;
  }

  clear(): void {
    this.waiting.length = 0;
    this.cur = null;
    this.elapsed = 0;
    this.leaving = false;
  }
}

/** Display name of the player in a slot ('' when unknown). */
export function playerName(state: ReadonlySimState, slot: number): string {
  if (!(slot >= 0 && slot < state.players.length)) return '';
  const p = state.players[slot]!;
  return rosterName(state, p.team, p.rosterIdx);
}

/** Short (HUD) name of a squad member ('' when unknown). */
export function rosterName(state: ReadonlySimState, team: number, rosterIdx: number): string {
  const squad = state.squads[team];
  const d = squad && rosterIdx >= 0 ? squad[rosterIdx] : undefined;
  if (!d) return '';
  return (d.short || d.name || '').toUpperCase();
}

function code(clubs: readonly Club[], state: ReadonlySimState, team: number): string {
  if (team !== 0 && team !== 1) return '';
  return clubs[state.teams[team]!.clubIdx]?.code ?? '';
}

const clockScratch = { min: 0, sec: 0, added: 0, period: 0 };

/** Minute label for the current state. */
export function currentMinute(state: ReadonlySimState): string {
  displayClock(state as unknown as SimState, clockScratch);
  return minuteLabel(clockScratch.min, clockScratch.sec, clockScratch.period);
}

/**
 * The toast for one sim event, or null when the event has none. `outRoster` is the roster index of the player who
 * went off for SUBSTITUTION events when the event itself does not carry it (d), -1 when unknown. Allocates (events
 * are rare).
 */
export function toastForEvent(e: Readonly<SimEvent>, state: ReadonlySimState, clubs: readonly Club[], outRoster = -1): ToastSpec | null {
  const T = TOAST_TUNING;
  switch (e.type) {
    case EventType.GOAL: {
      const team = e.a;
      const own = e.d === 1;
      const name = playerName(state, e.b);
      return {
        kind: 'goal', title: 'GOAL', code: code(clubs, state, team), line: name ? (own ? `${name} (OG)` : name) : own ? 'OWN GOAL' : '',
        sub: '', minute: currentMinute(state), team, lifeMs: T.goalLifeMs,
      };
    }
    case EventType.CARD: {
      const slot = e.a;
      const p = slot >= 0 && slot < state.players.length ? state.players[slot]! : null;
      const team = p ? p.team : -1;
      const kind: ToastKind = e.b === CardKind.YELLOW ? 'yellow' : 'red';
      if (e.b !== CardKind.YELLOW && e.b !== CardKind.RED && e.b !== CardKind.SECOND_YELLOW) return null;
      const title = e.b === CardKind.YELLOW ? 'YELLOW CARD' : e.b === CardKind.RED ? 'RED CARD' : 'SECOND YELLOW';
      return {
        kind, title, code: code(clubs, state, team), line: playerName(state, slot),
        sub: e.b === CardKind.SECOND_YELLOW ? 'Sent off' : e.b === CardKind.RED ? 'Sent off' : '', minute: currentMinute(state),
        team, lifeMs: T.lifeMs,
      };
    }
    case EventType.SUBSTITUTION: {
      const team = e.a;
      if (team !== 0 && team !== 1) return null;
      const inName = rosterName(state, team, e.c);
      const squadLen = state.squads[team]?.length ?? 0;
      const out = e.d >= 0 && e.d < squadLen && e.d !== e.c ? e.d : outRoster;
      const outName = out >= 0 && out !== e.c ? rosterName(state, team, out) : '';
      return { kind: 'sub', title: 'SUBSTITUTION', code: code(clubs, state, team), line: inName, sub: outName, minute: '', team, lifeMs: T.lifeMs };
    }
    case EventType.OFFSIDE: {
      const slot = e.a;
      const team = slot >= 0 && slot < state.players.length ? state.players[slot]!.team : -1;
      return { kind: 'offside', title: 'OFFSIDE', code: code(clubs, state, team), line: playerName(state, slot), sub: '', minute: '', team, lifeMs: T.lifeMs };
    }
    case EventType.ADVANTAGE: {
      if (e.a === 0) return null;
      const team = e.b === 0 || e.b === 1 ? e.b : -1;
      return {
        kind: 'advantage', title: 'ADVANTAGE', code: code(clubs, state, team), line: e.a === 2 ? 'Brought back' : 'Play on',
        sub: e.a === 2 ? 'Free kick for the foul' : '', minute: '', team, lifeMs: T.lifeMs,
      };
    }
    case EventType.FORFEIT: {
      const team = e.a === 0 || e.a === 1 ? e.a : -1;
      const club = team >= 0 ? clubs[state.teams[team]!.clubIdx] : undefined;
      return {
        kind: 'forfeit', title: 'FORFEIT', code: code(clubs, state, team), line: club ? `${club.name} forfeit` : 'Match forfeited',
        sub: '', minute: '', team, lifeMs: T.forfeitLifeMs,
      };
    }
    default:
      return null;
  }
}

// ============================================================ part

export function createToasts(): HudPart {
  let root: HTMLElement | null = null;
  let el: HTMLElement | null = null;
  let chip: HTMLElement | null = null;
  let titleEl: HTMLElement | null = null;
  let codeEl: HTMLElement | null = null;
  let lineEl: HTMLElement | null = null;
  let subEl: HTMLElement | null = null;
  let minEl: HTMLElement | null = null;
  let unbindLarge: (() => void) | null = null;
  let clubs: readonly Club[] = [];
  let teamColor: [string, string] = ['', ''];
  let ctxRef: AppContext | null = null;
  let matchState: ReadonlySimState | null = null;
  /** High-contrast setting teamColor was resolved for (null = not resolved yet). */
  let colorHc: boolean | null = null;
  /** Roster index per slot as of the last frame (names the player going off when the event lacks it). */
  const rosterBySlot: number[] = [];
  const queue = new ToastQueue<ToastSpec>();
  let cls = 'hud-toast';

  /** Write the toast's class only when it changes (MutationObserver sees every write, even an equal one). */
  function setCls(v: string): void {
    if (v === cls || !el) return;
    cls = v;
    el.className = v;
  }

  /**
   * [QF-12] Chip colours = the shirts worn on the pitch (wornShirts: clash check, fallback kits), with the high-contrast
   * kits when that setting is on (the renderer swaps kits live, so it is read when a toast shows). Allocates only when
   * the setting differs from the last resolve.
   */
  function teamColors(): [string, string] {
    const hc = highContrastOn(ctxRef);
    if (colorHc !== hc && matchState) {
      colorHc = hc;
      const worn = wornShirts(matchState, clubs, hc);
      teamColor = [worn ? kitHex(worn[0]) : '', worn ? kitHex(worn[1]) : ''];
    }
    return teamColor;
  }

  function show(t: ToastSpec): void {
    if (!el) return;
    if (titleEl) titleEl.textContent = t.title;
    if (codeEl) codeEl.textContent = t.code;
    if (lineEl) lineEl.textContent = t.line;
    if (subEl) subEl.textContent = t.sub;
    if (minEl) minEl.textContent = t.minute;
    if (chip) chip.style.background = t.team === 0 || t.team === 1 ? teamColors()[t.team] || '' : '';
    el.dataset.kind = t.kind;
    // The queue always fades a toast out before the next one starts, so the class goes is-out -> is-in and the
    // animation-name change restarts the slide-in.
    setCls('hud-toast is-in');
    el.setAttribute('aria-label', `${t.title} ${t.code} ${t.line} ${t.sub} ${t.minute}`.replace(/\s+/g, ' ').trim());
  }

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      ctxRef = ctx;
      injectStyle('hud-shared', HUD_SHARED_CSS);
      injectStyle('hud-toasts', CSS);
      chip = h('span', { class: 'ht-chip' });
      titleEl = h('span', { class: 'ht-title', testId: 'toast-title' });
      codeEl = h('span', { class: 'ht-code' });
      lineEl = h('span', { class: 'ht-line', testId: 'toast-line' });
      subEl = h('span', { class: 'ht-sub', testId: 'toast-sub' });
      minEl = h('span', { class: 'ht-min', testId: 'toast-minute' });
      el = h('div', { class: 'hud-toast', testId: 'hud-toast', attrs: { role: 'status' } },
        chip, h('div', { class: 'ht-body' }, h('div', { class: 'ht-head' }, titleEl, codeEl), lineEl, subEl), minEl);
      root = h('div', { class: 'hud-part hud-toasts', testId: 'hud-toasts', attrs: { 'aria-live': 'polite' } }, el);
      parent.append(root);
      unbindLarge = bindLargerHud(ctx, root);
    },
    setMatch(state: ReadonlySimState, cl: readonly Club[]) {
      clubs = cl;
      // [QF-12] The shirts the players wear (clash check, fallback kits, high contrast), not the requested kit slots.
      matchState = state;
      colorHc = null;
      teamColors();
      rosterBySlot.length = state.players.length;
      for (let i = 0; i < state.players.length; i++) rosterBySlot[i] = state.players[i]!.rosterIdx;
      queue.clear();
      setCls('hud-toast');
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void projector;
      const players = state.players;
      for (let i = 0; i < players.length; i++) {
        const r = players[i]!.rosterIdx;
        if (rosterBySlot[i] !== r) rosterBySlot[i] = r;
      }
      if (frame.paused) return;
      const change = queue.advance(frame.dtMs);
      if (change === 0 || !el) return;
      if (change & TOAST_SHOW) {
        const t = queue.current;
        if (t) show(t);
      } else if (change & TOAST_LEAVE) {
        setCls('hud-toast is-out');
      } else if (change & TOAST_CLEAR) {
        setCls('hud-toast is-out');
      }
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      for (let i = 0; i < events.count; i++) {
        const e = events.get(i);
        const t = e.type;
        if (t !== EventType.GOAL && t !== EventType.CARD && t !== EventType.SUBSTITUTION && t !== EventType.OFFSIDE &&
          t !== EventType.ADVANTAGE && t !== EventType.FORFEIT) continue;
        const outRoster = t === EventType.SUBSTITUTION && e.b >= 0 && e.b < rosterBySlot.length ? rosterBySlot[e.b]! : -1;
        const spec = toastForEvent(e, state, clubs, outRoster);
        if (spec) queue.push(spec);
      }
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
    },
    dispose() {
      unbindLarge?.();
      unbindLarge = null;
      queue.clear();
      root?.remove();
      root = el = chip = titleEl = codeEl = lineEl = subEl = minEl = null;
      ctxRef = null;
      matchState = null;
      colorHc = null;
    },
  };
}
