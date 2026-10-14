/**
 * [UIX-08] Pause menu (overlay inside the match screen) and team management (BRIEF §12 Screens "Pause menu: resume,
 * team management (formation, substitutions by drag or select-and-swap, stamina shown), tactics, camera, controls,
 * sound, restart, quit"; §5 substitutions; §11 "Either player can pause; only the player who paused can resume or
 * quit").
 *
 * Pages (one panel at a time; Back on a sub-page returns to the main page, Back on the main page resumes):
 *  - main: who paused (`.pause-who`), score and clock, online pause counters when the mode provides them; Resume,
 *    Restart and Quit in the left column (Quit asks to confirm), section tiles on the right.
 *  - team: the XI on a pitch in formation (stamina bars), the bench, the formation picker and the subs left.
 *    Substitutions by drag-and-drop (touch or mouse: drag a substitute onto a player, or a player onto a substitute)
 *    or select-and-swap (tap / Confirm one, then the other). Queued substitutions show as pending (OUT / IN badges,
 *    pending chips; an order made in this pause can be cancelled) until the sim applies them at the next stoppage.
 *  - tactics: the four quick-tactic toggles and the tactical focus. team and tactics manage the team of the acting
 *    human; when both humans play on different sides (local) a tab bar (L1 / R1) switches team.
 *  - camera (type, height, zoom), sound (four volumes): live settings (ctx.settings).
 *  - controls: links to the settings screen (controls tab), the touch layout editor and the controller remap; coming
 *    back to the match reopens this page.
 *  - quick: the compact quick-sub prompt (Command.QUICK_SUB): the four most tired players and the available bench,
 *    select-and-swap or drag, Done (resumes) and a link to full team management. Opening it pauses the match for the
 *    human who asked (local play has no way to navigate an overlay with the pad while it also drives a player).
 *
 * Team orders (formation, focus, tactic toggles, substitutions) are kept in a module-level outbox for the running match
 * (keyed by the session's SimState), not sent into the input queue while paused: the session's command queue holds a
 * few commands per human and the sim reads one command per frame. When play resumes the outbox sends a burst, then
 * one order per animation frame (update), coalesced (a formation picked three times is one command; a toggle switched
 * on and off again is none) and confirmed against the state; an order the sim refused is dropped after
 * LOCAL_TUNING.commandConfirmTicks sim ticks. Leaving the match screen while running flushes the rest at once.
 *
 * Rules: Resume, Restart and Quit belong to the human who paused (any human after a system pause); a refused action
 * says why (refusalMessage) for REFUSAL_NOTE_MS, then the line returns to who paused; the note is reset on show().
 *
 * Extra exports beyond the WAVE 0 API: PauseMenu.onBack / openQuickSub / page, openPausePage (half-time shortcut),
 * mayControlPause, humanForTeam, teamOfHuman, manageableTeams, defaultManagedTeam, encodeSub, the team-orders model
 * (createTeamOrders, teamOrders, resetTeamOrders, reconcileOrders, takeOrders, pumpTeamOrders, effective*, set*,
 * pendingSubList, subsRemaining, subRefusal), tokenPosition, staminaLevel, pauseCountersText, PAUSE_TUNING.
 */
import type { AppContext } from '../../contracts/app';
import { MenuAction, UiSound } from '../../contracts/app';
import { MAX_HUMANS, MAX_SUBS, NUM_SLOTS, PLAYERS_PER_TEAM, SQUAD_SIZE, teamFirstSlot } from '../../contracts/constants';
import { CameraType, Command, ControllerKind, FormationId, MatchPhase, ModeId, Role, TacticalFocus } from '../../contracts/enums';
import { RosterStatus, type ReadonlySimState, type SimState } from '../../contracts/state';
import { uiHumanOf } from '../../app/session';
import { FORMATIONS, formationSwitchMap, getFormation } from '../../data/formations';
import { displayClock } from '../../sim/rules/machine';
import { canRequestSub } from '../../sim/rules/subs';
import {
  createButton, createSegmented, createSelector, createSlider, createTabs, createToggle, h, injectStyle, openModal,
  openModalCount, setSelected, type ModalHandle,
} from '../components';

const LOCAL_TUNING = { // TUNING-CR (menu timing, not gameplay)
  /** Sim ticks a sent team order may take to show in the state before the menu stops waiting for it (1.5 s). */
  commandConfirmTicks: 90,
  /** Team orders handed to the session at once when play resumes; the rest follow one per animation frame. */
  resumeBurst: 4,
  /** Pointer travel that turns a press on a player into a drag, CSS px. */
  dragStartPx: 10,
  /** A pointer click within this time after a drag ended belongs to the drag (ignored), ms. */
  dragClickGuardMs: 400,
  /** Most tired players listed by the quick-sub prompt. */
  quickTired: 4,
} as const;

/** The LOCAL_TUNING block (tests, TUNING-CR review). */
export const PAUSE_TUNING = LOCAL_TUNING;

/** How long a refused-action note stays before the line returns to who paused, ms. */
export const REFUSAL_NOTE_MS = 2500;

export type PauseAction = 'resume' | 'restart' | 'quit';

/**
 * Why an action was refused. A human pause (pausedBy >= 0) can be lifted (or the match restarted / quit) only by that
 * human; a system pause (pausedBy -1) is refused only while the page is hidden or the window is in portrait / too
 * small. Pure.
 */
export function refusalMessage(pausedBy: number, action: PauseAction = 'resume'): string {
  if (pausedBy >= 0) return `Only Player ${pausedBy + 1} can ${action}`;
  return 'Turn to landscape or enlarge the window to resume';
}

/** True when `human` may resume, restart or quit a pause made by `pausedBy` (-1 = system pause: anyone). Pure. */
export function mayControlPause(pausedBy: number, human: number): boolean {
  return pausedBy < 0 || human === pausedBy;
}

// ============================================================ humans and teams (pure)

type RTeam = ReadonlySimState['teams'][number];

/** Human controller index (0 / 1) playing `team`, or -1. */
export function humanForTeam(s: ReadonlySimState, team: number): number {
  for (let hu = 0; hu < MAX_HUMANS; hu++) {
    const c = s.ctrl[hu];
    if (c && c.kind === ControllerKind.HUMAN && c.side === team) return hu;
  }
  return -1;
}

/** Team (0 / 1) of a human controller, or -1. */
export function teamOfHuman(s: ReadonlySimState, human: number): number {
  const c = human >= 0 && human < MAX_HUMANS ? s.ctrl[human] : undefined;
  return c && c.kind === ControllerKind.HUMAN && (c.side === 0 || c.side === 1) ? c.side : -1;
}

/** Teams this menu may manage: every side with a human; online only the acting human's side. Pure. */
export function manageableTeams(s: ReadonlySimState, actingHuman: number, online: boolean): number[] {
  if (online) {
    const t = teamOfHuman(s, actingHuman);
    return t >= 0 ? [t] : [];
  }
  const out: number[] = [];
  for (let t = 0; t < 2; t++) if (humanForTeam(s, t) >= 0) out.push(t);
  return out;
}

/** Team shown first: the acting human's, else the pauser's, else the first side with a human, else -1. Pure. */
export function defaultManagedTeam(s: ReadonlySimState, actingHuman: number, pausedBy: number, online = false): number {
  const teams = manageableTeams(s, actingHuman, online);
  const a = teamOfHuman(s, actingHuman);
  if (a >= 0 && teams.includes(a)) return a;
  const p = teamOfHuman(s, pausedBy);
  if (p >= 0 && teams.includes(p)) return p;
  return teams.length > 0 ? teams[0]! : -1;
}

/** Command.SUBSTITUTE argument: outSlot | inRosterIdx << 8. */
export function encodeSub(outSlot: number, inRoster: number): number {
  return (outSlot & 255) | ((inRoster & 255) << 8);
}

// ============================================================ team orders (outbox, pure)

export const TACTIC_COMMANDS: readonly Command[] = [
  Command.TACTIC_OFFSIDE_TRAP, Command.TACTIC_TEAM_PRESS, Command.TACTIC_EXTRA_STRIKER, Command.TACTIC_GET_IN_BOX,
];
export const TACTIC_LABELS: readonly string[] = ['Offside trap', 'Team press', 'Extra striker', 'Get in the box'];
const TACTIC_HINTS: readonly string[] = [
  'The back line steps up together', 'Two players hunt the ball carrier', 'A midfielder joins the attack',
  'More bodies in the box for crosses',
];
/** Focus commands indexed by TacticalFocus. */
export const FOCUS_COMMANDS: readonly Command[] = [Command.FOCUS_DEFAULT, Command.FOCUS_DEFENDING, Command.FOCUS_ATTACKING];
const FOCUS_OPTIONS = [
  { value: TacticalFocus.DEFAULT, label: 'Balanced', testId: 'pause-focus-0' },
  { value: TacticalFocus.DEFENDING, label: 'Defending', testId: 'pause-focus-1' },
  { value: TacticalFocus.ATTACKING, label: 'Attacking', testId: 'pause-focus-2' },
] as const;

/** Current value (0 / 1) of quick tactic i (TACTIC_COMMANDS order). */
export function tacticValue(t: RTeam, i: number): number {
  switch (i) {
    case 0: return t.offsideTrap ? 1 : 0;
    case 1: return t.teamPress ? 1 : 0;
    case 2: return t.extraStriker ? 1 : 0;
    default: return t.getInBox ? 1 : 0;
  }
}

export interface PendingSub {
  out: number;
  inRoster: number;
  /** Sim tick when it was handed to the session, -1 = not sent yet (cancellable). */
  sentTick: number;
}

/** What the player asked for one team and the sim does not show yet. -1 = nothing asked. */
export interface TeamOrders {
  formation: number;
  formationSent: number;
  focus: number;
  focusSent: number;
  tactics: number[];
  tacticsSent: number[];
  subs: PendingSub[];
}

export function createTeamOrders(): TeamOrders {
  return { formation: -1, formationSent: -1, focus: -1, focusSent: -1, tactics: [-1, -1, -1, -1], tacticsSent: [-1, -1, -1, -1], subs: [] };
}

function simQueueLen(t: RTeam): number {
  const cap = Math.min(t.subOut.length, t.subIn.length);
  const n = t.subCount | 0;
  return n < 0 ? 0 : n > cap ? cap : n;
}

function inSimQueue(t: RTeam, out: number, inRoster: number): boolean {
  const n = simQueueLen(t);
  for (let i = 0; i < n; i++) if (t.subOut[i] === out && t.subIn[i] === inRoster) return true;
  return false;
}

/** Drop orders the state now shows (or that the sim refused: sent more than confirmTicks ago and still not shown). */
export function reconcileOrders(o: TeamOrders, t: RTeam, tick: number, confirmTicks: number = LOCAL_TUNING.commandConfirmTicks): void {
  const late = (sent: number): boolean => sent >= 0 && tick - sent >= confirmTicks;
  if (o.formation >= 0 && (t.formation === o.formation || late(o.formationSent))) {
    o.formation = -1;
    o.formationSent = -1;
  }
  if (o.focus >= 0 && (t.focus === o.focus || late(o.focusSent))) {
    o.focus = -1;
    o.focusSent = -1;
  }
  for (let i = 0; i < TACTIC_COMMANDS.length; i++) {
    if (o.tactics[i]! >= 0 && (tacticValue(t, i) === o.tactics[i] || late(o.tacticsSent[i]!))) {
      o.tactics[i] = -1;
      o.tacticsSent[i] = -1;
    }
  }
  for (let k = o.subs.length - 1; k >= 0; k--) {
    const sub = o.subs[k]!;
    if (inSimQueue(t, sub.out, sub.inRoster) || t.roster[sub.inRoster] !== RosterStatus.BENCH || late(sub.sentTick)) o.subs.splice(k, 1);
  }
}

export interface OrderCommand {
  cmd: Command;
  arg: number;
}

/** Collect up to `max` orders not sent yet that the state does not show (substitutions first); marks them sent. */
export function takeOrders(o: TeamOrders, t: RTeam, tick: number, max: number, out: OrderCommand[]): number {
  let n = 0;
  for (const sub of o.subs) {
    if (n >= max) return n;
    if (sub.sentTick >= 0) continue;
    out.push({ cmd: Command.SUBSTITUTE, arg: encodeSub(sub.out, sub.inRoster) });
    sub.sentTick = tick;
    n++;
  }
  if (n < max && o.formation >= 0 && o.formationSent < 0 && t.formation !== o.formation) {
    out.push({ cmd: Command.SET_FORMATION, arg: o.formation });
    o.formationSent = tick;
    n++;
  }
  if (n < max && o.focus >= 0 && o.focusSent < 0 && t.focus !== o.focus) {
    out.push({ cmd: FOCUS_COMMANDS[o.focus] ?? Command.FOCUS_DEFAULT, arg: 0 });
    o.focusSent = tick;
    n++;
  }
  for (let i = 0; i < TACTIC_COMMANDS.length && n < max; i++) {
    if (o.tactics[i]! >= 0 && o.tacticsSent[i]! < 0 && tacticValue(t, i) !== o.tactics[i]) {
      out.push({ cmd: TACTIC_COMMANDS[i]!, arg: 0 });
      o.tacticsSent[i] = tick;
      n++;
    }
  }
  return n;
}

export function effectiveFormation(o: TeamOrders, t: RTeam): FormationId {
  return (o.formation >= 0 ? o.formation : t.formation) as FormationId;
}
export function effectiveFocus(o: TeamOrders, t: RTeam): TacticalFocus {
  return (o.focus >= 0 ? o.focus : t.focus) as TacticalFocus;
}
export function effectiveTactic(o: TeamOrders, t: RTeam, i: number): number {
  return o.tactics[i]! >= 0 ? o.tactics[i]! : tacticValue(t, i);
}
export function setFormationOrder(o: TeamOrders, t: RTeam, f: number): void {
  o.formation = f === t.formation ? -1 : f;
  o.formationSent = -1;
}
export function setFocusOrder(o: TeamOrders, t: RTeam, f: number): void {
  o.focus = f === t.focus ? -1 : f;
  o.focusSent = -1;
}
export function setTacticOrder(o: TeamOrders, t: RTeam, i: number, v: number): void {
  const nv = v ? 1 : 0;
  o.tactics[i] = nv === tacticValue(t, i) ? -1 : nv;
  o.tacticsSent[i] = -1;
}

export interface PendingView {
  out: number;
  inRoster: number;
  /** True once the sim holds it (it can no longer be cancelled). */
  queued: boolean;
  /** Index into TeamOrders.subs for a local order, else -1. */
  local: number;
}

/** Substitutions waiting for a stoppage: the sim's queue, then this menu's orders. */
export function pendingSubList(o: TeamOrders, t: RTeam): PendingView[] {
  const out: PendingView[] = [];
  const n = simQueueLen(t);
  for (let i = 0; i < n; i++) out.push({ out: t.subOut[i]!, inRoster: t.subIn[i]!, queued: true, local: -1 });
  o.subs.forEach((sub, i) => {
    if (!inSimQueue(t, sub.out, sub.inRoster)) out.push({ out: sub.out, inRoster: sub.inRoster, queued: false, local: i });
  });
  return out;
}

/** Substitutions still available: MAX_SUBS - used - queued in the sim - ordered here. */
export function subsRemaining(o: TeamOrders, t: RTeam): number {
  let local = 0;
  for (const sub of o.subs) if (!inSimQueue(t, sub.out, sub.inRoster)) local++;
  const n = MAX_SUBS - t.subsUsed - simQueueLen(t) - local;
  return n > 0 ? n : 0;
}

/** Why `inRoster` may not replace the player in `outSlot` right now ('' = allowed). Pure. */
export function subRefusal(s: ReadonlySimState, team: number, outSlot: number, inRoster: number, o: TeamOrders): string {
  if (team !== 0 && team !== 1) return 'No team to manage';
  const m = s.match;
  if (m.finished === 1 || m.forfeitTeam >= 0 || m.phase === MatchPhase.SHOOT_OUT || m.phase === MatchPhase.POST_MATCH) {
    return 'Substitutions are closed';
  }
  const t = s.teams[team]!;
  if (subsRemaining(o, t) <= 0) return 'No substitutions left';
  const first = teamFirstSlot(team);
  if (!(outSlot >= first && outSlot < first + PLAYERS_PER_TEAM)) return 'Pick a player on the pitch';
  const p = s.players[outSlot]!;
  if (p.active !== 1 || t.roster[p.rosterIdx] !== RosterStatus.PLAYING) return 'Pick a player on the pitch';
  if (!(inRoster >= 0 && inRoster < SQUAD_SIZE)) return 'Pick a substitute';
  const st = t.roster[inRoster];
  if (st === RosterStatus.SUBBED_OFF) return 'A substituted player cannot return';
  if (st === RosterStatus.SENT_OFF) return 'A sent-off player cannot play';
  if (st !== RosterStatus.BENCH) return 'Already on the pitch';
  for (const pv of pendingSubList(o, t)) {
    if (pv.out === outSlot) return 'That player is already coming off';
    if (pv.inRoster === inRoster) return 'That substitute is already coming on';
  }
  const outKeeper = outSlot === t.keeperSlot || p.isKeeper === 1;
  const inKeeper = s.squads[team]?.[inRoster]?.pos === Role.GK;
  if (outKeeper && !inKeeper) return 'Only a keeper can replace the keeper';
  if (!outKeeper && inKeeper) return 'A keeper can only replace the keeper';
  if (canRequestSub(s as unknown as SimState, team, outSlot, inRoster) !== 1) return 'Not allowed right now';
  return '';
}

// ---------------------------------------------------------------- module-level store (one match at a time)

const ORDERS: { state: unknown; teams: [TeamOrders, TeamOrders] } = { state: null, teams: [createTeamOrders(), createTeamOrders()] };

/** The orders of `team` for the match whose state is `s` (a new state starts empty). */
export function teamOrders(s: ReadonlySimState, team: number): TeamOrders {
  if (ORDERS.state !== s) {
    ORDERS.state = s;
    ORDERS.teams = [createTeamOrders(), createTeamOrders()];
  }
  return ORDERS.teams[team === 1 ? 1 : 0];
}

/** Forget every order (tests). */
export function resetTeamOrders(): void {
  ORDERS.state = null;
  ORDERS.teams = [createTeamOrders(), createTeamOrders()];
}

const pumpScratch: OrderCommand[] = [];

/**
 * Reconcile both teams' orders with the state and hand up to `max` unsent ones to `send` (through the human playing
 * that team; a team without a human drops its orders). Returns the number sent.
 */
export function pumpTeamOrders(s: ReadonlySimState, send: (human: number, cmd: Command, arg: number) => void, max: number): number {
  let sent = 0;
  for (let team = 0; team < 2; team++) {
    const o = teamOrders(s, team);
    const t = s.teams[team]!;
    reconcileOrders(o, t, s.tick);
    const human = humanForTeam(s, team);
    if (human < 0) {
      Object.assign(o, createTeamOrders());
      continue;
    }
    if (sent >= max) continue;
    pumpScratch.length = 0;
    takeOrders(o, t, s.tick, max - sent, pumpScratch);
    for (const c of pumpScratch) {
      send(human, c.cmd, c.arg);
      sent++;
    }
  }
  pumpScratch.length = 0;
  return sent;
}

// ============================================================ view helpers (pure)

const ROLE_LABEL: readonly string[] = ['GK', 'RB', 'CB', 'LB', 'RWB', 'LWB', 'CDM', 'CM', 'CAM', 'RM', 'LM', 'RW', 'LW', 'ST', 'CF'];

/**
 * Where a formation slot sits on the team-management pitch, in percent of its box (team attacking to the right, its
 * right flank at the bottom). The neutral shapes live in the team's own half, so their x range is stretched over the
 * pitch; the keeper stands at the left goal.
 */
export function tokenPosition(formation: FormationId, idx: number): { left: number; top: number } {
  const sl = getFormation(formation).slots[idx] ?? getFormation(formation).slots[0]!;
  if (idx === 0 || sl.role === Role.GK) return { left: 7, top: 50 };
  const fx = (sl.nx - -0.56) / (-0.02 - -0.56);
  const fz = (sl.nz - -0.8) / 1.6;
  const cl = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  return { left: 21 + cl(fx) * 71, top: 7 + cl(fz) * 86 };
}

/** Stamina band for the bar colour. */
export function staminaLevel(v: number): 'high' | 'mid' | 'low' {
  return v >= 0.65 ? 'high' : v >= 0.35 ? 'mid' : 'low';
}

/**
 * Online pause counters from the mode payload (NET-06 provides `pausesLeft`, a number or one per human), or ''.
 * Duck-typed: src/net is not imported outside the online screen.
 */
export function pauseCountersText(modeData: unknown): string {
  if (!modeData || typeof modeData !== 'object') return '';
  const v = (modeData as { pausesLeft?: unknown }).pausesLeft;
  if (typeof v === 'number' && Number.isFinite(v)) return `Pauses left: ${Math.max(0, Math.floor(v))}`;
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return (v as number[]).map((x, i) => `P${i + 1} pauses left: ${Math.max(0, Math.floor(x))}`).join(' · ');
  }
  return '';
}

const clockScratch = { min: 0, sec: 0, added: 0, period: 0 };

function matchLine(ctx: AppContext, s: ReadonlySimState): string {
  const home = ctx.clubs[s.teams[0]!.clubIdx]?.code ?? 'HOM';
  const away = ctx.clubs[s.teams[1]!.clubIdx]?.code ?? 'AWY';
  let clock: string;
  try {
    displayClock(s as unknown as SimState, clockScratch);
    clock = `  ·  ${clockScratch.min}'${clockScratch.added > 0 ? ` +${clockScratch.added}` : ''}`;
  } catch {
    clock = '';
  }
  return `${home}  ${s.teams[0]!.goals} - ${s.teams[1]!.goals}  ${away}${clock}`;
}

const CAMERA_OPTIONS = [
  { value: CameraType.BROADCAST, label: 'Broadcast' },
  { value: CameraType.WIDE, label: 'Wide' },
  { value: CameraType.CLOSE, label: 'Close' },
  { value: CameraType.END_TO_END, label: 'End to end' },
] as const;

// ============================================================ next page request (half-time shortcut, settings return)

export type PausePage = 'main' | 'team' | 'tactics' | 'camera' | 'controls' | 'sound' | 'quick';

let pendingPage: PausePage | null = null;

/**
 * Open the pause menu at `page` for the acting human: pauses the match (the session then shows the match screen with
 * this menu). The half-time screen uses it for its substitutions / tactics shortcut (the break is frozen meanwhile and
 * Resume returns to it). Returns false when the match cannot pause (no match, finished).
 */
export function openPausePage(ctx: AppContext, page: PausePage): boolean {
  const s = ctx.session;
  if (!s.active) return false;
  pendingPage = page;
  if (!s.paused) s.pause(uiHumanOf(ctx));
  if (!s.paused) {
    pendingPage = null;
    return false;
  }
  return true;
}

// ============================================================ styles

const CSS = `
.pause-overlay { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; box-sizing:border-box;
  padding: calc(var(--safe-top, 0px) + var(--space-5)) calc(var(--safe-right, 0px) + var(--space-5))
    calc(var(--safe-bottom, 0px) + var(--space-5)) calc(var(--safe-left, 0px) + var(--space-5));
  background: var(--scrim); pointer-events:auto; z-index: var(--z-content); }
.pause-overlay[hidden] { display:none; }
.pause-who { margin:0; color: var(--text-2); font-size: var(--fs-sm); }
.pause-who.p1 { color: var(--p1); } .pause-who.p2 { color: var(--p2); }
.pause-who.is-note { color: var(--warning); }
.pause-panel { box-sizing:border-box; max-width:100%; max-height:100%; display:flex; flex-direction:column; gap: var(--space-4);
  background: var(--surface-1); border: var(--line) solid var(--hairline); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-2); padding: var(--space-6); }
.pause-main { width: min(860px, 100%); flex-direction:row; gap: var(--space-6); }
.pause-main__left { flex: 0 0 300px; display:flex; flex-direction:column; gap: var(--space-3); min-width:0; }
.pause-main__left .btn { width:100%; }
.pause-main__head { display:flex; flex-direction:column; gap: var(--space-2); margin-bottom: var(--space-2); }
.pause-title { margin:0; font-size: var(--fs-xl); font-weight: var(--fw-bold); line-height: var(--lh-tight); }
.pause-score { margin:0; font: var(--fw-num-bold) var(--fs-md) / 1.2 var(--font-num); font-variant-numeric: tabular-nums;
  color: var(--text-1); letter-spacing: 0.02em; }
.pause-counters { margin:0; font: var(--fw-num) var(--fs-xs) / 1.3 var(--font-num); color: var(--text-3); }
.pause-main__gap { flex: 1 1 auto; min-height: var(--space-2); }
.pause-tiles { flex: 1 1 auto; display:grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); align-content:start; min-width:0; }
.pause-tiles .btn { width:100%; min-height: var(--target-lg); justify-content:flex-start; text-align:left; }
.pause-tiles .pause-tile--wide { grid-column: 1 / -1; }
.pause-sub { width: min(720px, 100%); }
.pause-sub--wide { width: min(1120px, 100%); height: min(780px, 100%); }
.pause-sub--quick { width: min(760px, 100%); }
.pause-head { display:flex; align-items:center; gap: var(--space-4); flex-wrap:wrap; }
.pause-head .pause-back { min-width: calc(var(--target) * 1.6); }
.pause-head__title { margin:0; font-size: var(--fs-lg); font-weight: var(--fw-bold); flex: 1 1 auto; }
.pause-head__info { display:flex; align-items:center; gap: var(--space-4); flex-wrap:wrap; }
.pause-head .sel { width:auto; min-width: 280px; background: var(--surface-2); }
.pause-pill { font: var(--fw-num-bold) var(--fs-sm) / 1 var(--font-num); font-variant-numeric: tabular-nums; color: var(--text-1);
  padding: var(--space-2) var(--space-3); border: var(--line) solid var(--hairline-strong); border-radius: var(--radius-pill); white-space:nowrap; }
.pause-body { display:flex; flex-direction:column; gap: var(--space-3); overflow-y:auto; min-height:0; padding: 2px; }
.pause-body .seg, .pause-body .ctl { width:100%; }
.pause-msg { margin:0; min-height: 1.3em; font-size: var(--fs-sm); color: var(--text-2); }
.pause-msg.is-error { color: var(--error); } .pause-msg.is-ok { color: var(--success); }
.pause-tabs.tabs { width:auto; border-bottom:0; }

/* team management */
.tm-body { flex: 1 1 auto; min-height:0; display:grid; grid-template-columns: minmax(0, 1.75fr) minmax(250px, 1fr); gap: var(--space-5); }
.tm-left { display:grid; grid-template-rows: minmax(0, 1fr) auto; gap: var(--space-3); min-height:0; }
.tm-side { display:flex; flex-direction:column; gap: var(--space-4); min-height:0; overflow-y:auto; padding: 2px; }
.tm-side .tm-bench { overflow:visible; padding:0; }
.tm-pend { display:flex; flex-direction:column; gap: var(--space-2); }
.tm-side .tm-chips { flex-direction:column; }
.tm-side .tm-chip { border-radius: var(--radius); padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3); }
.tm-side .tm-chip > span:first-child { flex: 1 1 auto; min-width:0; }
.tm-pitch { position:relative; align-self:center; width:100%; max-height:100%; aspect-ratio: 105 / 68; min-height: 260px;
  border-radius: var(--radius); background:
    linear-gradient(90deg, transparent calc(50% - 0.5px), var(--hairline-strong) calc(50% - 0.5px), var(--hairline-strong) calc(50% + 0.5px), transparent calc(50% + 0.5px)),
    var(--surface-2);
  border: var(--line) solid var(--hairline-strong); overflow:hidden; }
.tm-pitch::before { content:''; position:absolute; left:50%; top:50%; width:17%; aspect-ratio:1; transform: translate(-50%, -50%);
  border: var(--line) solid var(--hairline-strong); border-radius:50%; }
.tm-pitch::after { content:''; position:absolute; left:0; top:20.5%; width:15.7%; height:59%; border: var(--line) solid var(--hairline-strong);
  border-left:0; }
.tm-pitch__box { position:absolute; right:0; top:20.5%; width:15.7%; height:59%; border: var(--line) solid var(--hairline-strong); border-right:0; }
.tm-tok { position:absolute; transform: translate(-50%, -50%); width: 72px; min-height: var(--target); box-sizing:border-box;
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:2px; padding: 6px 4px 7px;
  border-radius: var(--radius-sm); border: var(--line) solid var(--hairline-strong); background: var(--surface-3); color: var(--text-1);
  font: var(--fw-medium) var(--fs-xs) / 1.1 var(--font-ui); cursor:pointer; touch-action:none; user-select:none; -webkit-user-select:none; }
.tm-tok__num { font: var(--fw-num-bold) var(--fs-md) / 1 var(--font-num); font-variant-numeric: tabular-nums; }
.tm-tok__name { max-width: 64px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color: var(--text-2); }
.tm-tok__role { position:absolute; top:-9px; left:50%; transform: translateX(-50%); font: var(--fw-num) 10px / 1 var(--font-num);
  color: var(--text-3); background: var(--surface-1); padding: 2px 5px; border-radius: var(--radius-pill); border: var(--line) solid var(--hairline); }
.p1 .tm-tok { border-color: rgba(255, 107, 53, 0.45); } .p2 .tm-tok { border-color: rgba(62, 209, 246, 0.45); }
.tm-sta { display:block; width: 52px; height: 4px; border-radius: 2px; background: var(--surface-1); overflow:hidden; }
.tm-sta__fill { display:block; width:100%; height:100%; transform-origin: 0 50%; background: var(--success); }
.tm-sta--mid .tm-sta__fill { background: var(--warning); } .tm-sta--low .tm-sta__fill { background: var(--error); }
.tm-badge { position:absolute; top:-8px; right:-8px; font: var(--fw-num-bold) 10px / 1 var(--font-num); padding: 3px 5px;
  border-radius: var(--radius-pill); background: var(--warning); color: var(--ink); }
.tm-badge--in { background: var(--success); }
.tm-tok[data-selected], .tm-row[data-selected] { border-color: var(--ember); box-shadow: 0 0 0 1px var(--ember), 0 0 18px var(--ember-glow); }
.tm-tok.is-pending, .tm-row.is-pending { border-style: dashed; }
.tm-tok.is-target, .tm-row.is-target { border-color: var(--ember-strong); }
.tm-tok.is-drop, .tm-row.is-drop { background: var(--ember-soft); }
.tm-tok.is-dragging, .tm-row.is-dragging { opacity: 0.45; }
.tm-bench { display:flex; flex-direction:column; gap: var(--space-2); min-height:0; overflow-y:auto; padding: 2px; }
.tm-bench__title { margin: 0 0 var(--space-1); }
.tm-row { position:relative; display:flex; align-items:center; gap: var(--space-3); width:100%; min-height: var(--target); box-sizing:border-box;
  padding: var(--space-2) var(--space-4); border-radius: var(--radius); border: var(--line) solid var(--hairline); background: var(--surface-2);
  color: var(--text-1); font: var(--fw-medium) var(--fs-sm) / 1.2 var(--font-ui); text-align:left; cursor:pointer; touch-action: pan-y;
  user-select:none; -webkit-user-select:none; }
.tm-row[disabled] { opacity: 0.45; cursor:default; }
.tm-row__num { flex: 0 0 2.2em; font: var(--fw-num-bold) var(--fs-md) / 1 var(--font-num); font-variant-numeric: tabular-nums; }
.tm-row__text { flex: 1 1 auto; display:flex; flex-direction:column; gap:2px; min-width:0; }
.tm-row__name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tm-row__detail { font-size: var(--fs-xs); color: var(--text-3); font-weight: var(--fw-regular); }
.tm-row .tm-badge { position:static; }
.tm-foot { display:flex; flex-direction:column; gap: var(--space-2); }
.tm-chips { display:flex; flex-wrap:wrap; gap: var(--space-2); }
.tm-chip { display:inline-flex; align-items:center; gap: var(--space-2); min-height: 40px; padding: 0 var(--space-3);
  border-radius: var(--radius-pill); border: var(--line) dashed var(--warning); color: var(--text-1); font-size: var(--fs-xs); }
.tm-chip .btn { min-height: var(--target); min-width: var(--target); padding:0; }
.tm-ghost { position:fixed; left:0; top:0; z-index: var(--z-toast); pointer-events:none; padding: var(--space-2) var(--space-4);
  border-radius: var(--radius); background: var(--surface-4); border: var(--line) solid var(--ember); color: var(--text-1);
  font: var(--fw-medium) var(--fs-sm) / 1.2 var(--font-ui); box-shadow: var(--shadow-2); white-space:nowrap; }
.tm-quick { display:grid; grid-template-columns: 1fr 1fr; gap: var(--space-5); min-height:0; }
.tm-quick .tm-bench { overflow-y:auto; }
.pause-actions { display:flex; gap: var(--space-3); justify-content:flex-end; flex-wrap:wrap; }
@media (max-height: 640px) {
  .pause-panel { padding: var(--space-4); gap: var(--space-3); }
  .pause-main__head { margin-bottom:0; }
  .pause-title { font-size: var(--fs-lg); }
  .pause-tiles .btn { min-height: var(--target); }
  .tm-pitch { min-height: 220px; }
  .tm-body { gap: var(--space-3); }
}
@media (max-width: 900px) {
  .pause-main { flex-direction:column; }
  .pause-main__left { flex-basis:auto; }
}
`;

// ============================================================ the menu

export interface PauseMenu {
  mount(root: HTMLElement, ctx: AppContext): void;
  show(): void;
  hide(): void;
  /** Every frame from the match screen (rAF time, ms): expires the refusal note, sends team orders while running and
   *  opens the quick-sub prompt when a human's frame carried Command.QUICK_SUB. Writes the DOM only on change. */
  update(nowMs: number): void;
  readonly visible: boolean;
  /** The page shown while visible. */
  readonly page: PausePage;
  /** Back while visible: closes a dialog or a sub-page (true = handled); false on the main page (resume). */
  onBack(): boolean;
  /** Quick-sub prompt for `human` (pauses the match for him when running). */
  openQuickSub(human: number): void;
  dispose(): void;
}

type Sel = { kind: 'xi'; slot: number } | { kind: 'bench'; roster: number };

interface DragState {
  id: number;
  src: Sel;
  srcEl: HTMLElement;
  x0: number;
  y0: number;
  active: boolean;
  ghost: HTMLElement | null;
  over: HTMLElement | null;
}

/** Runtime access the SessionControl contract does not name (app/types.ts AppSession.runtime). */
type RuntimeLike = { curr: ReadonlySimState; frames: readonly { cmd: number }[] };
function runtimeOf(ctx: AppContext): RuntimeLike | null {
  const r = (ctx.session as unknown as { runtime?: () => RuntimeLike | null }).runtime;
  if (typeof r !== 'function') return null;
  try {
    return r.call(ctx.session) ?? null;
  } catch {
    return null;
  }
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function createPauseMenu(): PauseMenu {
  let ctx: AppContext | null = null;
  let el: HTMLElement | null = null;
  let who: HTMLElement | null = null;
  let msgEl: HTMLElement | null = null;
  let visible = false;
  let page: PausePage = 'main';
  /** performance.now() time at which the refusal note expires; 0 = no note shown. */
  let noteUntil = 0;
  let unsubAction: (() => void) | null = null;
  let keyListening = false;
  let quitModal: ModalHandle | null = null;
  let managed = -1;
  let sel: Sel | null = null;
  let message = '';
  let messageKind: 'info' | 'error' | 'ok' = 'info';
  let drag: DragState | null = null;
  let dragEndedAt = -Infinity;
  let lastQuickTick = -1;
  let quickHuman = -1;

  const now = (): number => (typeof performance !== 'undefined' ? performance.now() : 0);
  const state = (): ReadonlySimState | null => (ctx ? ctx.session.getState() : null);
  const online = (): boolean => ctx?.session.getSetup()?.config.mode === ModeId.FRIEND_ONLINE;
  const send = (human: number, cmd: Command, arg: number): void => ctx?.session.queueCommand(human, cmd, arg);
  const play = (k: UiSound): void => {
    try {
      ctx?.audio.playUi(k);
    } catch {
      /* audio never breaks a menu */
    }
  };

  // ------------------------------------------------------------ who paused / notes

  function describePauser(): void {
    noteUntil = 0;
    if (!who || !ctx) return;
    const by = ctx.session.pausedBy;
    who.className = 'pause-who' + (by === 0 ? ' p1' : by === 1 ? ' p2' : '');
    who.textContent = by >= 0 ? `Paused by Player ${by + 1}` : 'Game paused';
  }

  function showRefusal(action: PauseAction): void {
    if (!ctx) return;
    play(UiSound.ERROR);
    const text = refusalMessage(ctx.session.pausedBy, action);
    if (who && page === 'main') {
      who.className = 'pause-who is-note';
      who.textContent = text;
      noteUntil = now() + REFUSAL_NOTE_MS;
    } else {
      setMessage(text, 'error');
    }
  }

  function setMessage(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
    message = text;
    messageKind = kind;
    if (msgEl) {
      msgEl.textContent = text;
      msgEl.className = 'pause-msg' + (kind === 'error' ? ' is-error' : kind === 'ok' ? ' is-ok' : '');
    }
  }

  // ------------------------------------------------------------ actions

  function acting(): number {
    return ctx ? uiHumanOf(ctx) : -1;
  }

  function doResume(): void {
    const c = ctx;
    if (!c) return;
    if (!c.session.resume(acting())) {
      showRefusal('resume');
      return;
    }
    const s = c.session.getState();
    if (s) pumpTeamOrders(s, send, LOCAL_TUNING.resumeBurst);
  }

  function doRestart(): void {
    const c = ctx;
    if (!c) return;
    if (!mayControlPause(c.session.pausedBy, acting())) {
      showRefusal('restart');
      return;
    }
    c.session.restart();
  }

  function doQuit(): void {
    const c = ctx;
    if (!c) return;
    if (!mayControlPause(c.session.pausedBy, acting())) {
      showRefusal('quit');
      return;
    }
    quitModal?.close();
    quitModal = openModal(c, {
      title: 'Quit this match?',
      body: 'The match ends here and its result is not kept.',
      testId: 'pause-quit-dialog',
      actions: [
        { label: 'Quit match', variant: 'danger', testId: 'pause-quit-confirm', onSelect: () => {
          if (!ctx) return;
          // The pauser rule holds at the moment of the final choice too.
          if (!mayControlPause(ctx.session.pausedBy, acting())) {
            showRefusal('quit');
            return;
          }
          ctx.session.quit();
        } },
        { label: 'Keep playing', primary: true, testId: 'pause-quit-cancel' },
      ],
      onClose: () => {
        quitModal = null;
      },
    });
  }

  /** Leave the match screen for another screen; coming back reopens `returnTo`. */
  function leaveTo(id: 'settings' | 'controls-editor' | 'remap', returnTo: PausePage, params?: Record<string, unknown>): void {
    pendingPage = returnTo;
    ctx?.router.go(id, params ?? {});
  }

  // ------------------------------------------------------------ pages

  function goPage(p: PausePage): void {
    setPage(p);
  }

  function setPage(p: PausePage): void {
    if (!el || !ctx) return;
    cancelDrag();
    if (p !== page) {
      sel = null;
      message = '';
      messageKind = 'info';
    }
    page = p;
    if (p === 'team' || p === 'tactics' || p === 'quick') {
      const s = state();
      const teams = s ? manageableTeams(s, acting(), online()) : [];
      if (!teams.includes(managed)) {
        const pref = p === 'quick' && quickHuman >= 0 ? quickHuman : acting();
        managed = s ? defaultManagedTeam(s, pref, ctx.session.pausedBy, online()) : -1;
      }
    }
    render(true);
  }

  function render(focusDefault: boolean): void {
    if (!el || !ctx) return;
    const prevFocus = focusDefault ? null : (el.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);
    el.dataset.page = page;
    who = null;
    msgEl = null;
    let panel: HTMLElement;
    switch (page) {
      case 'team': panel = teamPage(false); break;
      case 'quick': panel = teamPage(true); break;
      case 'tactics': panel = tacticsPage(); break;
      case 'camera': panel = cameraPage(); break;
      case 'controls': panel = controlsPage(); break;
      case 'sound': panel = soundPage(); break;
      default: panel = mainPage(); break;
    }
    el.replaceChildren(panel);
    if (page === 'main') describePauser();
    if (!visible || openModalCount() > 0) return;
    const target =
      (prevFocus ? el.querySelector<HTMLElement>(`[data-testid="${prevFocus}"]`) : null) ??
      el.querySelector<HTMLElement>('[data-focus-default]') ??
      el.querySelector<HTMLElement>('[data-focus]');
    if (target) {
      try {
        ctx.focus.focus(target);
      } catch {
        /* navigator not ready */
      }
    }
  }

  function mainPage(): HTMLElement {
    const c = ctx!;
    const s = state();
    who = h('p', { class: 'pause-who', text: '' });
    const head = h('div', { class: 'pause-main__head' }, h('h2', { class: 'pause-title', text: 'Paused' }), who);
    if (s) head.append(h('p', { class: 'pause-score num', text: matchLine(c, s), testId: 'pause-score' }));
    const counters = pauseCountersText(c.session.getSetup()?.modeData);
    if (counters) head.append(h('p', { class: 'pause-counters', text: counters, testId: 'pause-counters' }));
    const phase = s?.match.phase;
    const left = h(
      'div',
      { class: 'pause-main__left', attrs: { 'data-focus-group': 'y' } },
      head,
      createButton(phase === MatchPhase.HALF_TIME ? 'Back to half time' : 'Resume', doResume, {
        testId: 'pause-resume', variant: 'primary', size: 'lg', autofocus: true, ctx: c,
      }),
      h('div', { class: 'pause-main__gap' }),
      createButton('Restart match', doRestart, { testId: 'pause-restart', ctx: c }),
      createButton('Quit to menu', doQuit, { testId: 'pause-quit', variant: 'danger', ctx: c }),
    );
    const manage = s !== null && manageableTeams(s, acting(), online()).length > 0;
    const tiles = h(
      'div',
      { class: 'pause-tiles', attrs: { 'data-focus-group': 'none' } },
      createButton('Team management', () => goPage('team'), {
        testId: 'pause-team', hint: manage ? 'Formation, substitutions, stamina' : 'Lineups and stamina', ctx: c,
        extraClass: 'pause-tile--wide', disabled: s === null,
      }),
      createButton('Tactics', () => goPage('tactics'), { testId: 'pause-tactics', hint: 'Quick tactics, focus', ctx: c, disabled: !manage }),
      createButton('Camera', () => goPage('camera'), { testId: 'pause-camera', hint: 'Type, height, zoom', ctx: c }),
      createButton('Controls', () => goPage('controls'), { testId: 'pause-controls', hint: 'Touch, controller, remap', ctx: c }),
      createButton('Sound', () => goPage('sound'), { testId: 'pause-sound', hint: 'Volumes', ctx: c }),
    );
    return h('div', { class: 'pause-panel pause-main', testId: 'pause-page-main' }, left, tiles);
  }

  function subHead(title: string, ...info: (Node | null)[]): HTMLElement {
    const c = ctx!;
    const back = createButton('Back', () => goPage('main'), {
      testId: 'pause-back', variant: 'ghost', sound: UiSound.BACK, ctx: c, extraClass: 'pause-back', ariaLabel: 'Back to the pause menu',
    });
    const infoBox = h('div', { class: 'pause-head__info' });
    for (const n of info) if (n) infoBox.append(n);
    return h('div', { class: 'pause-head' }, back, h('h2', { class: 'pause-head__title', text: title }), infoBox);
  }

  function teamTabs(): HTMLElement | null {
    const s = state();
    if (!s || !ctx) return null;
    const teams = manageableTeams(s, acting(), online());
    if (teams.length < 2) return null;
    const tabs = createTabs(
      teams.map((t) => ({ id: String(t), label: ctx!.clubs[s.teams[t]!.clubIdx]?.code ?? (t === 0 ? 'HOME' : 'AWAY'), testId: `pause-team-${t}` })),
      String(managed),
      (id) => {
        managed = Number(id);
        sel = null;
        setMessage('');
        render(false);
      },
      { ctx, ariaLabel: 'Team', testId: 'pause-team-tabs' },
    );
    tabs.el.classList.add('pause-tabs');
    return tabs.el;
  }

  function msgLine(): HTMLElement {
    msgEl = h('p', { class: 'pause-msg', testId: 'pause-sub-note', attrs: { role: 'status', 'aria-live': 'polite' } });
    setMessage(message, messageKind);
    return msgEl;
  }

  // ------------------------------------------------------------ team management

  function nameOf(s: ReadonlySimState, team: number, roster: number): { shirt: number; short: string; name: string; pos: Role } {
    const d = s.squads[team]?.[roster];
    return { shirt: d?.shirt ?? roster + 1, short: d?.short ?? `#${roster + 1}`, name: d?.name ?? `Player ${roster + 1}`, pos: d?.pos ?? Role.CM };
  }

  function select(next: Sel): void {
    const s = state();
    if (!s || managed < 0) return;
    if (sel && sel.kind === next.kind && (sel.kind === 'xi' ? sel.slot === (next as { slot: number }).slot : sel.roster === (next as { roster: number }).roster)) {
      sel = null;
      play(UiSound.TOGGLE);
      setMessage('');
      render(false);
      return;
    }
    if (sel && sel.kind !== next.kind) {
      const out = sel.kind === 'xi' ? sel.slot : (next as { slot: number }).slot;
      const inR = sel.kind === 'bench' ? sel.roster : (next as { roster: number }).roster;
      trySub(out, inR);
      return;
    }
    sel = next;
    play(UiSound.TOGGLE);
    const s2 = state()!;
    if (next.kind === 'xi') {
      const p = s2.players[next.slot]!;
      setMessage(`${nameOf(s2, managed, p.rosterIdx).short} selected: now pick a substitute`);
    } else {
      setMessage(`${nameOf(s2, managed, next.roster).short} selected: now pick the player to replace`);
    }
    render(false);
  }

  function trySub(outSlot: number, inRoster: number): boolean {
    const s = state();
    if (!s || managed < 0) return false;
    const o = teamOrders(s, managed);
    const why = subRefusal(s, managed, outSlot, inRoster, o);
    sel = null;
    if (why) {
      play(UiSound.ERROR);
      setMessage(why, 'error');
      render(false);
      return false;
    }
    o.subs.push({ out: outSlot, inRoster, sentTick: -1 });
    play(UiSound.CONFIRM);
    const pIn = nameOf(s, managed, inRoster);
    const pOut = nameOf(s, managed, s.players[outSlot]!.rosterIdx);
    setMessage(`${pIn.short} on for ${pOut.short}: pending, applies at the next stoppage`, 'ok');
    render(false);
    return true;
  }

  function cancelSub(localIdx: number): void {
    const s = state();
    if (!s || managed < 0) return;
    const o = teamOrders(s, managed);
    const sub = o.subs[localIdx];
    if (!sub || sub.sentTick >= 0) return;
    o.subs.splice(localIdx, 1);
    play(UiSound.BACK);
    setMessage('Substitution cancelled');
    render(false);
  }

  function token(s: ReadonlySimState, slot: number, formation: FormationId, pend: PendingView[], readOnly: boolean, tired = false): HTMLElement {
    const t = s.teams[managed]!;
    const p = s.players[slot]!;
    const info = nameOf(s, managed, p.rosterIdx);
    let idx = p.formIdx;
    if (formation !== t.formation) idx = formationSwitchMap(t.formation as FormationId, formation)[p.formIdx] ?? p.formIdx;
    const isKeeper = slot === t.keeperSlot || p.isKeeper === 1;
    if (isKeeper) idx = 0;
    const role = isKeeper ? Role.GK : (getFormation(formation).slots[idx]?.role ?? p.role);
    const pending = pend.some((pv) => pv.out === slot);
    const lvl = staminaLevel(p.stamina);
    const fill = h('span', { class: 'tm-sta__fill' });
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, p.stamina)).toFixed(3)})`;
    const b = h(
      'button',
      {
        class: tired ? 'tm-row' : 'tm-tok',
        testId: `pause-xi-${slot}`,
        attrs: {
          'data-drop': 'xi', 'data-slot': String(slot),
          'aria-label': `${info.shirt} ${info.name}, ${ROLE_LABEL[role] ?? ''}, stamina ${Math.round(p.stamina * 100)}%${pending ? ', coming off' : ''}`,
        },
      },
    );
    if (tired) {
      b.append(
        h('span', { class: 'tm-row__num', text: String(info.shirt) }),
        h('span', { class: 'tm-row__text' }, h('span', { class: 'tm-row__name', text: info.name }), h('span', { class: 'tm-row__detail', text: `${ROLE_LABEL[role] ?? ''} · stamina ${Math.round(p.stamina * 100)}%` })),
        h('span', { class: `tm-sta tm-sta--${lvl}` }, fill),
      );
    } else {
      const pos = tokenPosition(formation, idx);
      b.style.left = `${pos.left}%`;
      b.style.top = `${pos.top}%`;
      b.append(
        h('span', { class: 'tm-tok__role', text: ROLE_LABEL[role] ?? '' }),
        h('span', { class: 'tm-tok__num', text: String(info.shirt) }),
        h('span', { class: 'tm-tok__name', text: info.short }),
        h('span', { class: `tm-sta tm-sta--${lvl}` }, fill),
      );
    }
    if (pending) {
      b.classList.add('is-pending');
      b.append(h('span', { class: 'tm-badge', text: 'OUT' }));
    }
    b.type = 'button';
    b.dataset.focus = '';
    if (sel?.kind === 'xi' && sel.slot === slot) setSelected(b, true);
    if (readOnly) {
      b.disabled = true;
    } else {
      wireItem(b, { kind: 'xi', slot }, `${info.shirt} ${info.short}`);
    }
    return b;
  }

  function benchRow(s: ReadonlySimState, roster: number, pend: PendingView[], readOnly: boolean): HTMLElement {
    const t = s.teams[managed]!;
    const info = nameOf(s, managed, roster);
    const st = t.roster[roster];
    const pending = pend.some((pv) => pv.inRoster === roster);
    const detail =
      st === RosterStatus.SUBBED_OFF ? 'Substituted, cannot return'
        : st === RosterStatus.SENT_OFF ? 'Sent off'
          : `${ROLE_LABEL[info.pos] ?? ''} · fresh`;
    const b = h(
      'button',
      {
        class: 'tm-row',
        testId: `pause-bench-${roster}`,
        attrs: { 'data-drop': 'bench', 'data-roster': String(roster), 'aria-label': `${info.shirt} ${info.name}, ${detail}${pending ? ', coming on' : ''}` },
      },
      h('span', { class: 'tm-row__num', text: String(info.shirt) }),
      h('span', { class: 'tm-row__text' }, h('span', { class: 'tm-row__name', text: info.name }), h('span', { class: 'tm-row__detail', text: detail })),
    );
    if (st === RosterStatus.BENCH && !pending) {
      const fill = h('span', { class: 'tm-sta__fill' });
      b.append(h('span', { class: 'tm-sta tm-sta--high' }, fill));
    }
    if (pending) {
      b.classList.add('is-pending');
      b.append(h('span', { class: 'tm-badge tm-badge--in', text: 'IN' }));
    }
    b.type = 'button';
    b.dataset.focus = '';
    if (sel?.kind === 'bench' && sel.roster === roster) setSelected(b, true);
    if (readOnly || st !== RosterStatus.BENCH || pending) {
      b.disabled = true;
    } else {
      wireItem(b, { kind: 'bench', roster }, `${info.shirt} ${info.short}`);
    }
    return b;
  }

  function teamPage(quick: boolean): HTMLElement {
    const c = ctx!;
    const s = state();
    if (!s) {
      return h('div', { class: 'pause-panel pause-sub', testId: 'pause-page-team' }, subHead('Team management'), h('p', { class: 'pause-msg', text: 'No match running' }));
    }
    const teams = manageableTeams(s, acting(), online());
    const readOnly = managed < 0 || !teams.includes(managed);
    const team = managed >= 0 ? managed : 0;
    if (managed < 0) managed = team;
    const t = s.teams[team]!;
    const o = teamOrders(s, team);
    reconcileOrders(o, t, s.tick);
    const formation = effectiveFormation(o, t);
    const pend = pendingSubList(o, t);
    const left = subsRemaining(o, t);
    const humanTeam = humanForTeam(s, team);
    const subsPill = h('span', { class: 'pause-pill', text: `Subs left ${left}/${MAX_SUBS}`, testId: 'pause-subs-left' });
    const first = teamFirstSlot(team);

    const benchList = h('div', { class: 'tm-bench', testId: 'pause-bench', attrs: { 'data-focus-group': 'none' } });
    benchList.append(h('h3', { class: 'tm-bench__title eyebrow', text: quick ? 'Substitutes' : 'Bench' }));
    for (let r = 0; r < SQUAD_SIZE; r++) {
      const st = t.roster[r];
      if (st === RosterStatus.PLAYING) continue;
      if (quick && (st !== RosterStatus.BENCH || pend.some((pv) => pv.inRoster === r))) continue;
      benchList.append(benchRow(s, r, pend, readOnly));
    }

    const chips = h('div', { class: 'tm-chips', testId: 'pause-pending' });
    for (const pv of pend) {
      const pIn = nameOf(s, team, pv.inRoster);
      const outP = pv.out >= 0 && pv.out < NUM_SLOTS ? s.players[pv.out] : undefined;
      const pOut = nameOf(s, team, outP ? outP.rosterIdx : 0);
      const chip = h('span', { class: 'tm-chip', testId: `pause-pending-${pv.inRoster}` }, h('span', { text: `${pOut.shirt} ${pOut.short}  →  ${pIn.shirt} ${pIn.short}` }), h('span', { class: 'tm-row__detail', text: pv.queued ? 'at the next stoppage' : 'pending' }));
      if (pv.local >= 0 && !pv.queued && (o.subs[pv.local]?.sentTick ?? 0) < 0 && !readOnly) {
        const li = pv.local;
        chip.append(createButton('×', () => cancelSub(li), { testId: `pause-pending-cancel-${pv.inRoster}`, variant: 'ghost', ariaLabel: `Cancel ${pIn.short} for ${pOut.short}`, ctx: c, sound: UiSound.BACK }));
      }
      chips.append(chip);
    }

    if (quick) {
      const tired: number[] = [];
      for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
        const p = s.players[i]!;
        if (p.active === 1 && t.roster[p.rosterIdx] === RosterStatus.PLAYING) tired.push(i);
      }
      tired.sort((a, b) => s.players[a]!.stamina - s.players[b]!.stamina || a - b);
      const tiredList = h('div', { class: 'tm-bench', testId: 'pause-tired', attrs: { 'data-focus-group': 'y' } });
      tiredList.append(h('h3', { class: 'tm-bench__title eyebrow', text: 'Most tired' }));
      for (const slot of tired.slice(0, LOCAL_TUNING.quickTired)) tiredList.append(token(s, slot, formation, pend, readOnly, true));
      const done = createButton('Done', doResume, { testId: 'pause-quick-done', variant: 'primary', autofocus: true, ctx: c });
      const more = createButton('Team management', () => goPage('team'), { testId: 'pause-quick-more', ctx: c });
      return h(
        'div',
        { class: `pause-panel pause-sub pause-sub--quick${humanTeam === 1 ? ' p2' : humanTeam === 0 ? ' p1' : ''}`, testId: 'pause-page-quick' },
        h('div', { class: 'pause-head' }, h('h2', { class: 'pause-head__title', text: 'Quick sub' }), h('div', { class: 'pause-head__info' }, subsPill)),
        h('div', { class: 'tm-quick pause-body' }, tiredList, benchList),
        h('div', { class: 'tm-foot' }, chips, msgLine()),
        h('div', { class: 'pause-actions' }, more, done),
      );
    }

    const pitch = h('div', { class: 'tm-pitch', testId: 'pause-pitch' }, h('span', { class: 'tm-pitch__box', attrs: { 'aria-hidden': 'true' } }));
    for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
      const p = s.players[i]!;
      if (p.active !== 1 || t.roster[p.rosterIdx] !== RosterStatus.PLAYING) continue;
      pitch.append(token(s, i, formation, pend, readOnly));
    }
    const formSel = readOnly
      ? h('span', { class: 'pause-pill', text: getFormation(formation).name, testId: 'pause-formation' })
      : createSelector(
        o.formation >= 0 ? 'Formation (pending)' : 'Formation',
        FORMATIONS.map((f) => ({ value: f.id, label: f.name })),
        formation,
        (v) => {
          const s2 = state();
          if (!s2) return;
          setFormationOrder(teamOrders(s2, team), s2.teams[team]!, v);
          setMessage(v === s2.teams[team]!.formation ? '' : `${getFormation(v).name}: applies when play resumes`, 'ok');
          render(false);
        },
        { testId: 'pause-formation', ctx: c },
      ).el;
    if (!readOnly && message === '') {
      message = left > 0 ? 'Drag a substitute onto a player, or select one and then the other.' : 'No substitutions left.';
      messageKind = 'info';
    }
    const club = ctx!.clubs[t.clubIdx];
    return h(
      'div',
      { class: `pause-panel pause-sub pause-sub--wide${humanTeam === 1 ? ' p2' : humanTeam === 0 ? ' p1' : ''}`, testId: 'pause-page-team' },
      subHead(club ? club.name : 'Team management', teamTabs(), formSel, subsPill),
      h(
        'div',
        { class: 'tm-body' },
        h('div', { class: 'tm-left' }, pitch, msgLine()),
        h(
          'div',
          { class: 'tm-side', attrs: { 'data-focus-group': 'y' } },
          pend.length > 0 ? h('div', { class: 'tm-pend' }, h('h3', { class: 'tm-bench__title eyebrow', text: 'Pending' }), chips) : null,
          benchList,
        ),
      ),
    );
  }

  // ------------------------------------------------------------ drag and drop (touch or mouse) + select-and-swap

  function wireItem(b: HTMLElement, src: Sel, label: string): void {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      if ((b as HTMLButtonElement).disabled) return;
      // A pointer click right after a drag belongs to the drag; controller / keyboard clicks (detail 0) always count.
      if (e.detail > 0 && now() - dragEndedAt < LOCAL_TUNING.dragClickGuardMs) return;
      select(src);
    });
    b.addEventListener('pointerdown', (e) => {
      if ((b as HTMLButtonElement).disabled || drag) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      drag = { id: e.pointerId, src, srcEl: b, x0: e.clientX, y0: e.clientY, active: false, ghost: null, over: null };
      b.dataset.dragLabel = label;
    });
  }

  function dropTargetAt(x: number, y: number): HTMLElement | null {
    if (!drag || typeof document === 'undefined') return null;
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const t = hit?.closest<HTMLElement>('[data-drop]') ?? null;
    if (!t || !el?.contains(t) || (t as HTMLButtonElement).disabled) return null;
    const want = drag.src.kind === 'xi' ? 'bench' : 'xi';
    return t.dataset.drop === want ? t : null;
  }

  function onPointerMove(e: PointerEvent): void {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x0;
    const dy = e.clientY - d.y0;
    if (!d.active) {
      if (dx * dx + dy * dy < LOCAL_TUNING.dragStartPx * LOCAL_TUNING.dragStartPx) return;
      d.active = true;
      d.srcEl.classList.add('is-dragging');
      const want = d.src.kind === 'xi' ? 'bench' : 'xi';
      el?.querySelectorAll<HTMLElement>(`[data-drop="${want}"]:not([disabled])`).forEach((n) => n.classList.add('is-target'));
      d.ghost = h('div', { class: 'tm-ghost', text: d.srcEl.dataset.dragLabel ?? '', testId: 'pause-drag-ghost' });
      el?.append(d.ghost);
    }
    if (e.cancelable) e.preventDefault();
    if (d.ghost) d.ghost.style.transform = `translate3d(${Math.round(e.clientX - 40)}px, ${Math.round(e.clientY - 44)}px, 0)`;
    const over = dropTargetAt(e.clientX, e.clientY);
    if (over !== d.over) {
      d.over?.classList.remove('is-drop');
      over?.classList.add('is-drop');
      d.over = over;
    }
  }

  function onPointerUp(e: PointerEvent): void {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    if (!d.active) {
      drag = null;
      return;
    }
    const target = dropTargetAt(e.clientX, e.clientY);
    cancelDrag();
    dragEndedAt = now();
    if (!target) return;
    if (d.src.kind === 'bench') trySub(Number(target.dataset.slot), d.src.roster);
    else trySub(d.src.slot, Number(target.dataset.roster));
  }

  function cancelDrag(): void {
    const d = drag;
    drag = null;
    if (!d) return;
    d.ghost?.remove();
    d.srcEl.classList.remove('is-dragging');
    el?.querySelectorAll<HTMLElement>('.is-target, .is-drop').forEach((n) => n.classList.remove('is-target', 'is-drop'));
  }

  function onPointerCancel(e: PointerEvent): void {
    if (drag && e.pointerId === drag.id) cancelDrag();
  }

  // ------------------------------------------------------------ tactics, camera, controls, sound

  function tacticsPage(): HTMLElement {
    const c = ctx!;
    const s = state();
    const body = h('div', { class: 'pause-body', attrs: { 'data-focus-group': 'none' } });
    if (!s || managed < 0) {
      body.append(h('p', { class: 'pause-msg', text: 'No team to manage' }));
      return h('div', { class: 'pause-panel pause-sub', testId: 'pause-page-tactics' }, subHead('Tactics'), body);
    }
    const team = managed;
    const t = s.teams[team]!;
    const o = teamOrders(s, team);
    reconcileOrders(o, t, s.tick);
    body.append(
      createSegmented('Focus', FOCUS_OPTIONS, effectiveFocus(o, t), (v) => {
        const s2 = state();
        if (s2) setFocusOrder(teamOrders(s2, team), s2.teams[team]!, v);
      }, { ctx: c, testId: 'pause-focus' }).el,
    );
    for (let i = 0; i < TACTIC_COMMANDS.length; i++) {
      body.append(
        createToggle(TACTIC_LABELS[i]!, effectiveTactic(o, t, i) === 1, (v) => {
          const s2 = state();
          if (s2) setTacticOrder(teamOrders(s2, team), s2.teams[team]!, i, v ? 1 : 0);
        }, { ctx: c, testId: `pause-tactic-${i}`, hint: TACTIC_HINTS[i] }).el,
      );
    }
    body.append(h('p', { class: 'ui-note', text: 'Changes apply when play resumes.' }));
    return h('div', { class: 'pause-panel pause-sub', testId: 'pause-page-tactics' }, subHead('Tactics', teamTabs()), body);
  }

  function cameraPage(): HTMLElement {
    const c = ctx!;
    const cam = c.settings.get().camera;
    const body = h(
      'div',
      { class: 'pause-body', attrs: { 'data-focus-group': 'none' } },
      createSelector('Camera', CAMERA_OPTIONS, cam.type, (v) => c.settings.update((st) => {
        st.camera.type = v;
      }), { ctx: c, testId: 'pause-camera-type' }).el,
      createSlider('Height', cam.height, (v) => c.settings.update((st) => {
        st.camera.height = v;
      }), { min: 0, max: 20, step: 1, ctx: c, testId: 'pause-camera-height' }).el,
      createSlider('Zoom', cam.zoom, (v) => c.settings.update((st) => {
        st.camera.zoom = v;
      }), { min: 0, max: 20, step: 1, ctx: c, testId: 'pause-camera-zoom' }).el,
    );
    return h('div', { class: 'pause-panel pause-sub', testId: 'pause-page-camera' }, subHead('Camera'), body);
  }

  function controlsPage(): HTMLElement {
    const c = ctx!;
    const body = h(
      'div',
      { class: 'pause-body', attrs: { 'data-focus-group': 'y' } },
      createButton('Control settings', () => leaveTo('settings', 'controls', { tab: 'controls' }), {
        testId: 'pause-open-settings', hint: 'Assistance, auto-switch, touch options, controller', ctx: c, autofocus: true,
      }),
      createButton('Touch layout', () => leaveTo('controls-editor', 'controls'), {
        testId: 'pause-open-editor', hint: 'Move and resize the touch buttons', ctx: c,
      }),
      createButton('Controller remap', () => leaveTo('remap', 'controls'), {
        testId: 'pause-open-remap', hint: 'For controllers without the standard layout', ctx: c,
      }),
    );
    return h('div', { class: 'pause-panel pause-sub', testId: 'pause-page-controls' }, subHead('Controls'), body);
  }

  function soundPage(): HTMLElement {
    const c = ctx!;
    const a = c.settings.get().audio;
    const vol = (label: string, key: 'master' | 'crowd' | 'effects' | 'menus'): HTMLElement =>
      createSlider(label, a[key], (v) => c.settings.update((st) => {
        st.audio[key] = v;
      }), { min: 0, max: 1, step: 0.05, ctx: c, testId: `pause-vol-${key}` }).el;
    const body = h(
      'div',
      { class: 'pause-body', attrs: { 'data-focus-group': 'none' } },
      vol('Master', 'master'), vol('Crowd', 'crowd'), vol('Effects', 'effects'), vol('Menus', 'menus'),
    );
    return h('div', { class: 'pause-panel pause-sub', testId: 'pause-page-sound' }, subHead('Sound'), body);
  }

  // ------------------------------------------------------------ Back

  function handleBack(): boolean {
    if (!visible) return false;
    if (openModalCount() > 0) return false;
    if (drag) {
      cancelDrag();
      return true;
    }
    if (page === 'quick') {
      play(UiSound.BACK);
      doResume();
      return true;
    }
    if (page !== 'main') {
      play(UiSound.BACK);
      const from = page;
      setPage('main');
      const tile = el?.querySelector<HTMLElement>(`[data-testid="pause-${from}"]`);
      if (tile && ctx) {
        try {
          ctx.focus.focus(tile);
        } catch {
          /* ignore */
        }
      }
      return true;
    }
    return false;
  }

  // Escape / Backspace on a sub-page: handled here before the router sees it (the router would resume the match).
  const onKey = (e: KeyboardEvent): void => {
    if (!visible || (e.key !== 'Escape' && e.key !== 'Backspace')) return;
    if (page === 'main' || openModalCount() > 0) return;
    if (e.key === 'Backspace' && isEditable(e.target)) return;
    e.stopImmediatePropagation();
    if (e.cancelable) e.preventDefault();
    if (e.repeat) return;
    handleBack();
  };

  function listen(on: boolean): void {
    if (typeof window === 'undefined' || on === keyListening) return;
    keyListening = on;
    if (on) window.addEventListener('keydown', onKey, true);
    else window.removeEventListener('keydown', onKey, true);
  }

  // ------------------------------------------------------------ quick sub detection

  function watchQuickSub(): void {
    const c = ctx;
    if (!c || c.session.paused) return;
    const rt = runtimeOf(c);
    if (!rt) return;
    const tick = rt.curr.tick;
    if (tick === lastQuickTick) return;
    lastQuickTick = tick;
    if (rt.curr.match.finished === 1) return;
    for (let hu = 0; hu < MAX_HUMANS; hu++) {
      if (rt.frames[hu]?.cmd === Command.QUICK_SUB) {
        api.openQuickSub(hu);
        return;
      }
    }
  }

  const api: PauseMenu = {
    mount(root, c) {
      injectStyle('pause', CSS);
      ctx = c;
      el = h('div', { class: 'pause-overlay', testId: 'pause-menu', attrs: { role: 'dialog', 'aria-label': 'Paused' } });
      el.hidden = true;
      el.addEventListener('pointermove', onPointerMove);
      el.addEventListener('pointerup', onPointerUp);
      el.addEventListener('pointercancel', onPointerCancel);
      root.append(el);
    },
    show() {
      if (!ctx || !el || visible) return;
      visible = true;
      el.hidden = false;
      const want = pendingPage;
      pendingPage = null;
      page = 'main';
      sel = null;
      message = '';
      noteUntil = 0;
      try {
        ctx.focus.attach(el);
      } catch {
        /* focus navigator not ready */
      }
      setPage(want ?? 'main');
      try {
        unsubAction?.();
        unsubAction = ctx.focus.onAction((a) => {
          if (!visible) return false;
          if (a === MenuAction.BACK) return handleBack();
          return false;
        });
      } catch {
        unsubAction = null;
      }
      listen(true);
    },
    hide() {
      if (!ctx || !el || !visible) return;
      visible = false;
      cancelDrag();
      quitModal?.close();
      quitModal = null;
      el.hidden = true;
      el.replaceChildren();
      who = null;
      msgEl = null;
      page = 'main';
      quickHuman = -1;
      unsubAction?.();
      unsubAction = null;
      listen(false);
      try {
        ctx.focus.detach(el);
      } catch {
        /* ignore */
      }
    },
    update(nowMs) {
      if (noteUntil !== 0 && nowMs >= noteUntil && ctx) {
        if (page === 'main') describePauser();
        else noteUntil = 0;
      }
      const c = ctx;
      if (!c || c.session.paused) return;
      const s = c.session.getState();
      if (s) pumpTeamOrders(s, send, 1);
      watchQuickSub();
    },
    get visible() {
      return visible;
    },
    get page() {
      return page;
    },
    onBack() {
      return handleBack();
    },
    openQuickSub(human) {
      const c = ctx;
      if (!c) return;
      const s = c.session.getState();
      if (!s || s.match.finished === 1 || teamOfHuman(s, human) < 0) return;
      quickHuman = human;
      if (visible) {
        managed = teamOfHuman(s, human);
        setPage('quick');
        return;
      }
      pendingPage = 'quick';
      managed = teamOfHuman(s, human);
      if (!c.session.paused) c.session.pause(human);
      if (!c.session.paused) {
        pendingPage = null;
        quickHuman = -1;
      }
    },
    dispose() {
      cancelDrag();
      quitModal?.close();
      quitModal = null;
      listen(false);
      unsubAction?.();
      unsubAction = null;
      const c = ctx;
      if (c) {
        // Leaving the match screen while play runs (half-time, full-time): hand every remaining order over now.
        // While paused (settings, remap) the orders wait in the module store for the menu that comes back.
        const s = c.session.getState();
        if (s && !c.session.paused) pumpTeamOrders(s, send, Number.POSITIVE_INFINITY);
      }
      if (visible && c && el) {
        try {
          c.focus.detach(el);
        } catch {
          /* ignore */
        }
      }
      el?.remove();
      el = null;
      ctx = null;
      who = null;
      msgEl = null;
      visible = false;
      noteUntil = 0;
      page = 'main';
    },
  };
  return api;
}
