/**
 * [TCH-04] Defence and keeper button sets and the attack-defence swap (section 9 "Layout", "Attack buttons" keeper row,
 * "Defence buttons"):
 *  - Defence set (createDefenceCluster), on the same four slots as the attack set (contracts/touch.ts CLUSTER_SLOT):
 *      | Slot | Button           | Tap                          | Hold                      | Swipe                         |
 *      | BIG  | SPRINT & TACKLE  | stand tackle / push or pull  | sprint, press the carrier | left: hard tackle             |
 *      | HIGH | SLIDE (or CLEAR) | slide tackle (or clearance)  |                           |                               |
 *      | LOW  | SWITCH           | switch to the best defender  |                           | any direction: switch that way|
 *      | MID  | 2ND DEF          | call a second defender       | keep him pressing         | down: keeper rushes out       |
 *    Built on the generic recogniser (button.ts), so every cell reaches the mapper (TCH-07) as TouchButtonEvents (id,
 *    edge, SwipeDir, mode at touch-down). No defence button has a double tap (every quick tap is a TAP). Live (claims
 *    touches) in DEFENCE mode only, unless the caller passes its own `enabled`. Inside overlapping slop the nearest live
 *    button wins. Direction hints (DEFENCE_SWIPE_HINTS) on a T_TOUCHUI.hintHoldMs hold while opts.hints() is true.
 *  - CLEAR replaces SLIDE whenever TouchIntentState.clearOn is set (the mapper writes it; clearanceOn() below is the
 *    pure rule, mirroring SIM-15's first-time clearance: a loose ball arriving at, or a header / volley chance for, the
 *    controlled player in his own third). A SLIDE press remembers whether it went down as CLEAR (pressClear /
 *    DefenceCluster.slideClear) and keeps that meaning and label until it lifts.
 *  - SWITCH swipes carry their direction: the SwipeDir in the event, plus the exact screen-space unit vector of the
 *    swipe (swipeAim(id), matched to the SWIPE event by tMs / seq) so "any direction: switch that way" is not limited
 *    to four directions (the mapper rotates it into pitch space for the right-stick flick).
 *  - Keeper with the ball (KEEPER mode) uses the attack set (TCH-03 keeps it live in KEEPER): PASS throws, THROUGH is a
 *    driven throw, SHOOT is a drop kick, SPRINT & SKILL drops the ball at his feet (KEEPER_LABELS).
 *  - The swap (createClusterController): the cluster swaps the moment TouchIntentState.mode changes (the mapper sets it
 *    each tick; clusterModeFor() is the full pure rule, chooseClusterMode() the open-play possession part). A thumb
 *    already down keeps its old meaning until it lifts: the pointer manager (TCH-01) routes a pointer once, at touch-
 *    down, to the control that claimed it, so the held button keeps receiving it, and every event of the press carries
 *    the TouchButtonId and ClusterMode it had at touch-down; new touches go to the set that is live now. The slot view
 *    (ids / labels / pressed) shows a held press's meaning until it lifts, then the current mode's button (slotMeaning,
 *    pure). On a swap, buttons with no finger down forget their pending first tap (no double tap across possessions).
 *
 * Wiring (TCH-07, index.ts): `createDefenceCluster(state, layout, undefined, { hints: () => t.hintMatchesLeft > 0 })`;
 * `createClusterController({ state, attack, defence })`; call `cluster.update(now)` in pollFrame (before overlay.sync)
 * and before mapper.sample (it advances the hold / hint timers of both sets and refreshes the slot view), and
 * `cluster.sync(now)` in the pointer manager's onChange before overlay.sync (the pressed slot shows in the same frame
 * as the touch-down). The overlay (TCH-09) reads cluster.ids / labels / pressed (version changes whenever one of them
 * does). In mapper.sample, set state.mode from clusterModeFor(ctx.state, ctx.side, ctx.human) and state.clearOn from
 * clearanceOn(ctx.state, ctx.side, ctx.human), and read defence.slideClear for the SLIDE presses drained this sample
 * (a SLIDE that went down as CLEAR is a clearance) before writing the new clearOn.
 * No allocation per pointer event or per update.
 */

import { MAX_HUMANS, NUM_SLOTS, slotTeam } from '../../contracts/constants';
import { MatchPhase } from '../../contracts/enums';
import type { ReadonlySimState, SimState } from '../../contracts/state';
import {
  ClusterMode, ClusterSlot, SwipeDir, TouchButtonId, type TouchIntentState,
} from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';
import { ballEta, inOwnThird, LOCAL_TUNING as RESOLVE_TUNING } from '../../sim/control/resolveShared';
import { aerialChance } from '../../sim/kicks/aerial';
import { ATTACK_BUTTONS, SLOT_ATTACK_BUTTON, type AttackCluster, type ClusterLayout, type SwipeLabels } from './attack';
import { LOCAL_TUNING as BUTTON_TUNING, createTouchButton, swipeDir, type TouchButtonControl } from './button';

// ============================================================ mode rules (pure)

/**
 * Open-play possession rule: which button set the right cluster shows for `side` (0 home, 1 away). Own team holds or
 * dribbles the ball -> ATTACK (own keeper holding it in hands -> KEEPER), the opponents -> DEFENCE; a loose ball
 * belongs to the team that touched it last (DECISIONS D-012: possession changes only on a change of team), so the
 * cluster swaps the moment possession changes and does not flicker while a ball is loose. No touch yet -> ATTACK. Pure.
 */
export function chooseClusterMode(state: ReadonlySimState | null, side: number): ClusterMode {
  if (!state || side < 0) return ClusterMode.ATTACK;
  const b = state.ball;
  if (b.heldBy >= 0) return slotTeam(b.heldBy) === side ? ClusterMode.KEEPER : ClusterMode.DEFENCE;
  if (b.owner >= 0) return slotTeam(b.owner) === side ? ClusterMode.ATTACK : ClusterMode.DEFENCE;
  // Loose ball: keep attack unless the opponents touched it last.
  return b.lastTouchTeam >= 0 && b.lastTouchTeam !== side ? ClusterMode.DEFENCE : ClusterMode.ATTACK;
}

/**
 * Player slot controlled by the human on `side`: ctrl[human] when `human` (0 = P1, 1 = P2) is given and plays that side,
 * else the first human controller on that side. -1 when none. Pure.
 */
export function controlledSlot(state: ReadonlySimState | null, side: number, human = -1): number {
  if (!state || side < 0) return -1;
  const lo = human >= 0 ? human : 0;
  const hi = human >= 0 ? human + 1 : MAX_HUMANS;
  for (let h = lo; h < hi && h < MAX_HUMANS; h++) {
    const c = state.ctrl[h];
    if (c && c.side === side && c.slot >= 0 && c.slot < NUM_SLOTS) return c.slot;
  }
  return -1;
}

/**
 * Full cluster-mode rule for the human on `side` (TCH-07 sets TouchIntentState.mode from it each tick). Pure:
 *  - cut-scenes and breaks (PRE_MATCH, GOAL, CELEBRATION, REPLAY, HALF_TIME, FULL_TIME, EXTRA_TIME, POST_MATCH) -> HIDDEN;
 *  - SHOOT_OUT -> SET_PIECE (kicker swipes, keeper dives);
 *  - a restart not yet taken: the taking side -> SET_PIECE; the other side -> SET_PIECE at a PENALTY (keeper dive),
 *    else DEFENCE (it can switch and position its players);
 *  - open play: own keeper holding the ball -> KEEPER when this human controls him (or no controlled player is
 *    known), ATTACK otherwise; else the possession rule (chooseClusterMode).
 */
export function clusterModeFor(state: ReadonlySimState | null, side: number, human = -1): ClusterMode {
  if (!state || side < 0) return ClusterMode.ATTACK;
  const m = state.match;
  switch (m.phase) {
    case MatchPhase.PRE_MATCH:
    case MatchPhase.GOAL:
    case MatchPhase.CELEBRATION:
    case MatchPhase.REPLAY:
    case MatchPhase.HALF_TIME:
    case MatchPhase.FULL_TIME:
    case MatchPhase.EXTRA_TIME:
    case MatchPhase.POST_MATCH:
      return ClusterMode.HIDDEN;
    case MatchPhase.SHOOT_OUT:
      return ClusterMode.SET_PIECE;
    case MatchPhase.KICK_OFF:
    case MatchPhase.THROW_IN:
    case MatchPhase.GOAL_KICK:
    case MatchPhase.CORNER:
    case MatchPhase.FREE_KICK:
    case MatchPhase.PENALTY:
      if (m.restart.taken !== 1) {
        return m.restart.team === side || m.phase === MatchPhase.PENALTY ? ClusterMode.SET_PIECE : ClusterMode.DEFENCE;
      }
      break;
    default:
      break;
  }
  const b = state.ball;
  if (b.heldBy >= 0 && slotTeam(b.heldBy) === side) {
    const slot = controlledSlot(state, side, human);
    return slot < 0 || slot === b.heldBy ? ClusterMode.KEEPER : ClusterMode.ATTACK;
  }
  return chooseClusterMode(state, side);
}

/**
 * CLEAR replaces SLIDE (section 9): in open play, the human's controlled player is about to reach a loose ball (it
 * arrives within SIM-15's clearArriveTicks) or has a header / volley chance at a high one, in his own third. The same
 * condition under which SIM-15 turns a SHOOT press into a first-time clearance, so the label never lies. Pure (the
 * aerial predictor it uses is memoised on the ball state only).
 */
export function clearanceOn(state: ReadonlySimState | null, side: number, human = -1): boolean {
  if (!state || state.match.phase !== MatchPhase.IN_PLAY) return false;
  const b = state.ball;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0) return false;
  const slot = controlledSlot(state, side, human);
  if (slot < 0) return false;
  const s = state as SimState; // the sim helpers are pure; they take the mutable type only
  const p = s.players[slot]!;
  if (p.active !== 1 || !inOwnThird(s, p)) return false;
  const eta = ballEta(s, slot);
  if (eta >= 0 && eta <= RESOLVE_TUNING.clearArriveTicks) return true;
  return aerialChance(s, slot) > 0;
}

// ============================================================ identities and labels (pure)

/** Defence buttons in slot order (BIG, LOW, MID, HIGH) with their TouchButtonId and overlay label. */
export const DEFENCE_BUTTONS: readonly (readonly [ClusterSlot, TouchButtonId, string])[] = [
  [ClusterSlot.BIG, TouchButtonId.SPRINT_TACKLE, 'TACKLE'],
  [ClusterSlot.LOW, TouchButtonId.SWITCH, 'SWITCH'],
  [ClusterSlot.MID, TouchButtonId.SECOND_DEF, '2ND DEF'],
  [ClusterSlot.HIGH, TouchButtonId.SLIDE, 'SLIDE'],
];

/** Defence button in each ClusterSlot (BIG, LOW, MID, HIGH). */
export const SLOT_DEFENCE_BUTTON: readonly TouchButtonId[] = [
  TouchButtonId.SPRINT_TACKLE, TouchButtonId.SWITCH, TouchButtonId.SECOND_DEF, TouchButtonId.SLIDE,
];

/** Label of SLIDE while a first-time clearance is on. */
export const CLEAR_LABEL = 'CLEAR';

/** Keeper-in-hands labels per ClusterSlot (BIG drop at his feet, LOW throw, MID driven throw, HIGH drop kick). */
export const KEEPER_LABELS: readonly string[] = ['DROP', 'THROW', 'DRIVEN THROW', 'DROP KICK'];

/** Plain-word label of each TouchButtonId (attack and defence sets; PAUSE has an icon). */
const BUTTON_LABELS: readonly string[] = (() => {
  const l = new Array<string>(TouchButtonId.PAUSE + 1).fill('');
  for (const [, id, label] of ATTACK_BUTTONS) l[id] = label;
  for (const [, id, label] of DEFENCE_BUTTONS) l[id] = label;
  return l;
})();

/** Whether `id` belongs to the attack set (also used for the keeper row and set pieces). Pure. */
export function isAttackButton(id: TouchButtonId | -1): boolean {
  return id === TouchButtonId.PASS || id === TouchButtonId.THROUGH || id === TouchButtonId.SHOOT || id === TouchButtonId.SPRINT_SKILL;
}

/** Whether `id` belongs to the defence set. Pure. */
export function isDefenceButton(id: TouchButtonId | -1): boolean {
  return id === TouchButtonId.SPRINT_TACKLE || id === TouchButtonId.SLIDE || id === TouchButtonId.SWITCH || id === TouchButtonId.SECOND_DEF;
}

/** Modes in which the defence set is live by default. Pure. */
export function defenceSetActive(mode: ClusterMode): boolean {
  return mode === ClusterMode.DEFENCE;
}

/** Button a slot shows in `mode` (-1 when the cluster is hidden). Pure. */
export function slotButton(mode: ClusterMode, slot: ClusterSlot): TouchButtonId | -1 {
  if (slot < ClusterSlot.BIG || slot > ClusterSlot.HIGH) return -1;
  if (mode === ClusterMode.HIDDEN) return -1;
  return mode === ClusterMode.DEFENCE ? SLOT_DEFENCE_BUTTON[slot]! : SLOT_ATTACK_BUTTON[slot]!;
}

/**
 * Label of a press of `id` that went down in `mode` (keeper row in KEEPER mode; CLEAR for SLIDE when `clear`). Pure.
 */
export function buttonLabel(id: TouchButtonId | -1, mode: ClusterMode, clear: boolean): string {
  if (id < 0 || id >= BUTTON_LABELS.length) return '';
  if (mode === ClusterMode.KEEPER && isAttackButton(id)) return KEEPER_LABELS[SLOT_ATTACK_BUTTON.indexOf(id as TouchButtonId)]!;
  if (id === TouchButtonId.SLIDE && clear) return CLEAR_LABEL;
  return BUTTON_LABELS[id]!;
}

/** Label a slot shows in `mode` with no finger on it ('' when hidden). Pure. */
export function slotLabel(mode: ClusterMode, slot: ClusterSlot, clearOn: boolean): string {
  return buttonLabel(slotButton(mode, slot), mode, clearOn);
}

/**
 * Section 9 defence table, swipe column, as plain-word hint labels for the overlay arrows. Indexed by TouchButtonId
 * (SwipeDir order NONE, UP, DOWN, LEFT, RIGHT; '' = the swipe does nothing); null = no swipes.
 */
export const DEFENCE_SWIPE_HINTS: readonly (SwipeLabels | null)[] = [
  null, null, null, null,
  /* SPRINT_TACKLE */ ['', '', '', 'Hard tackle', ''],
  /* SLIDE */ null,
  /* SWITCH */ ['', 'Switch', 'Switch', 'Switch', 'Switch'],
  /* SECOND_DEF */ ['', '', 'Keeper rush', '', ''],
  null,
];

/** Directions with a meaning for a defence press of `id` that went down in `mode`, as a mask of (1 << SwipeDir). Pure. */
export function defenceSwipeHintMask(id: TouchButtonId, mode: ClusterMode): number {
  if (mode !== ClusterMode.DEFENCE) return 0;
  const row = DEFENCE_SWIPE_HINTS[id];
  if (!row) return 0;
  let m = 0;
  for (let d = SwipeDir.UP; d <= SwipeDir.RIGHT; d++) if (row[d] !== '') m |= 1 << d;
  return m;
}

/** Unit screen vector (x right, y down) of a SwipeDir into out ((0, 0) for NONE). Pure. */
export function swipeVector(dir: SwipeDir, out: { x: number; y: number }): { x: number; y: number } {
  out.x = dir === SwipeDir.RIGHT ? 1 : dir === SwipeDir.LEFT ? -1 : 0;
  out.y = dir === SwipeDir.DOWN ? 1 : dir === SwipeDir.UP ? -1 : 0;
  return out;
}

// ============================================================ the swap rule (pure)

/** What a press on a slot means: id and cluster mode at touch-down (pressId -1 = no finger), and its label then. */
export interface SlotPress {
  readonly pressId: TouchButtonId | -1;
  readonly pressMode: ClusterMode;
  /** Label at touch-down when the control records it (defence buttons: CLEAR); else derived from id and mode. */
  readonly pressLabel?: string;
}

/** A slot's current meaning for the overlay. */
export interface SlotMeaning {
  /** Button the slot stands for (-1 = hidden). */
  id: TouchButtonId | -1;
  /** Cluster mode that meaning belongs to (a held press's mode at touch-down, else the current mode). */
  mode: ClusterMode;
  label: string;
  /** A finger is down on this slot. */
  pressed: boolean;
}

export function createSlotMeaning(): SlotMeaning {
  return { id: -1, mode: ClusterMode.ATTACK, label: '', pressed: false };
}

function pressLabelOf(p: SlotPress): string {
  return p.pressLabel ? p.pressLabel : buttonLabel(p.pressId, p.pressMode, false);
}

/**
 * The swap rule for one slot (pure). A thumb already down keeps its old meaning until it lifts: the slot shows the
 * press that is down on it (`live` = the press of the set that claims touches now, preferred; `other` = the press of
 * the set that was swapped out), with the id, mode and label it had at touch-down. With no finger down it shows the
 * current mode's button (CLEAR for SLIDE when clearOn). Writes into out.
 */
export function slotMeaning(
  mode: ClusterMode, clearOn: boolean, slot: ClusterSlot, live: SlotPress | null, other: SlotPress | null, out: SlotMeaning,
): SlotMeaning {
  const p = live && live.pressId !== -1 ? live : other && other.pressId !== -1 ? other : null;
  if (p) {
    out.id = p.pressId;
    out.mode = p.pressMode;
    out.label = pressLabelOf(p);
    out.pressed = true;
  } else {
    out.id = slotButton(mode, slot);
    out.mode = mode;
    out.label = out.id === -1 ? '' : buttonLabel(out.id, mode, clearOn);
    out.pressed = false;
  }
  return out;
}

// ============================================================ defence buttons

/** Exact direction of a button swipe. */
export interface SwipeAim {
  /** Button that swiped (-1 = none yet) and its cluster mode at touch-down. */
  button: TouchButtonId | -1;
  mode: ClusterMode;
  dir: SwipeDir;
  /** Unit travel vector, screen space (x right, y down); its dominant axis is always `dir`. */
  dx: number;
  dy: number;
  /** Time of the SWIPE event (equals its TouchButtonEvent.tMs), ms. */
  tMs: number;
  /** Increments with every recognised swipe of this button. */
  seq: number;
}

/** A defence button: the generic recogniser plus what the press meant at touch-down and the exact swipe vector. */
export interface DefenceButtonControl extends TouchButtonControl {
  /** Label of the current press as at touch-down ('' when up): CLEAR stays CLEAR until the thumb lifts. */
  readonly pressLabel: string;
  /** The current (or, once lifted, the last) press went down while CLEAR replaced SLIDE. */
  readonly pressClear: boolean;
  /** The latest recognised swipe of this button. */
  readonly aim: Readonly<SwipeAim>;
}

export interface DefenceClusterOptions {
  /** Direction hints on a 250 ms hold (index.ts: () => settings.controls.touch.hintMatchesLeft > 0). Default off. */
  hints?(): boolean;
}

export interface DefenceCluster {
  /** Controls in hit-test order (small buttons first so overlapping slop favours them, then BIG). */
  readonly controls: readonly DefenceButtonControl[];
  /** Copy a new layout into the buttons' geometry. */
  relayout(layout: ClusterLayout): void;
  /** Advance hold / hint timers of every button (call once per animation frame and before each sample). */
  update(tMs: number): void;
  /** Buttons showing direction hints now, as a mask over TouchButtonId (arrows: defenceSwipeHintMask of the press). */
  readonly hintMask: number;
  /** The control in a slot. */
  slot(slot: ClusterSlot): DefenceButtonControl;
  /** Whether a button would claim touches now. */
  live(id: TouchButtonId): boolean;
  /** Latest recognised swipe of a defence button (SWITCH: switch that way); a NONE record for other ids. */
  swipeAim(id: TouchButtonId): Readonly<SwipeAim>;
  /** The current (or last) SLIDE press went down as CLEAR (the mapper turns it into a clearance). */
  readonly slideClear: boolean;
}

const noDoubleTap = (): boolean => false;
/** Hit-test order: HIGH, MID, LOW, BIG. */
const ORDER: readonly ClusterSlot[] = [ClusterSlot.HIGH, ClusterSlot.MID, ClusterSlot.LOW, ClusterSlot.BIG];
const NONE_AIM: Readonly<SwipeAim> = Object.freeze({ button: -1, mode: ClusterMode.ATTACK, dir: SwipeDir.NONE, dx: 0, dy: 0, tMs: 0, seq: 0 });

interface DefenceButtonSpec {
  state: TouchIntentState;
  id: TouchButtonId;
  geom: { cx: number; cy: number; r: number };
  enabled(): boolean;
  claim(x: number, y: number): boolean;
  hint(id: TouchButtonId, mode: ClusterMode): boolean;
}

/**
 * One defence button: createTouchButton plus a mirror of its recent finger path (same sampling and window as
 * button.ts) so the exact vector of the swipe it recognises can be reported, and the label / CLEAR of the press.
 */
function createDefenceButton(spec: DefenceButtonSpec): DefenceButtonControl {
  const st = spec.state;
  const inner = createTouchButton({
    state: st, id: spec.id, geom: spec.geom, enabled: spec.enabled, claim: spec.claim, doubleTap: noDoubleTap, hint: spec.hint,
  });
  const N = BUTTON_TUNING.pathSamples;
  const WINDOW = BUTTON_TUNING.swipeWindowMs;
  const MIN_GAP = WINDOW / (N - 4);
  const THRESHOLD = T_TOUCHUI.buttonSwipePt;
  const px = new Float64Array(N);
  const py = new Float64Array(N);
  const pt = new Float64Array(N);
  let head = 0;
  let count = 0;
  let pressLabel = '';
  let pressClear = false;
  const aim: SwipeAim = { button: -1, mode: ClusterMode.ATTACK, dir: SwipeDir.NONE, dx: 0, dy: 0, tMs: 0, seq: 0 };
  const V = { x: 0, y: 0 };

  function push(x: number, y: number, t: number): void {
    if (count > 0 && t - pt[(head - 1 + N) % N]! < MIN_GAP) return;
    px[head] = x; py[head] = y; pt[head] = t;
    head = (head + 1) % N;
    if (count < N) count++;
  }

  /** Travel to (x, y) from the oldest recent sample at least THRESHOLD away (button.ts detectSwipe), into V. */
  function travel(x: number, y: number, t: number): boolean {
    const from = t - WINDOW;
    let k = count;
    while (k > 1 && pt[(head - k + 1 + N) % N]! < from) k--;
    for (; k >= 1; k--) {
      const i = (head - k + N) % N;
      const dx = x - px[i]!, dy = y - py[i]!;
      if (dx * dx + dy * dy >= THRESHOLD * THRESHOLD) {
        V.x = dx; V.y = dy;
        return true;
      }
    }
    return false;
  }

  /** After forwarding a move / lift: record the swipe the recogniser just made, else keep tracking the path. */
  function observe(before: SwipeDir, id: TouchButtonId | -1, mode: ClusterMode, x: number, y: number, t: number): void {
    if (before !== SwipeDir.NONE || id === -1) return;
    const d = inner.swipe;
    if (d === SwipeDir.NONE) {
      if (Number.isFinite(x) && Number.isFinite(y)) push(x, y, t);
      return;
    }
    // Exact vector when it agrees with the recogniser's direction (it always does unless the paths diverged).
    if (!(travel(x, y, t) && swipeDir(V.x, V.y, THRESHOLD) === d)) swipeVector(d, V);
    const len = Math.sqrt(V.x * V.x + V.y * V.y);
    aim.button = id;
    aim.mode = mode;
    aim.dir = d;
    aim.dx = V.x / len;
    aim.dy = V.y / len;
    aim.tMs = t;
    aim.seq++;
  }

  return {
    get id() { return inner.id; },
    get pointerId() { return inner.pointerId; },
    geom: inner.geom,
    get pressId() { return inner.pressId; },
    get pressMode() { return inner.pressMode; },
    get swipe() { return inner.swipe; },
    get holding() { return inner.holding; },
    get hint() { return inner.hint; },
    get pressLabel() { return inner.pressId === -1 ? '' : pressLabel; },
    get pressClear() { return pressClear; },
    aim,
    hit: (x, y) => inner.hit(x, y),
    down(pointer, x, y, t) {
      const fresh = inner.pointerId === -1;
      inner.down(pointer, x, y, t);
      if (!fresh || inner.pointerId !== pointer) return; // a second finger on a held button is swallowed
      pressClear = inner.pressId === TouchButtonId.SLIDE && st.clearOn;
      pressLabel = buttonLabel(inner.pressId, inner.pressMode, pressClear);
      count = 0;
      push(x, y, t);
    },
    move(pointer, x, y, t) {
      if (pointer !== inner.pointerId) return;
      const before = inner.swipe;
      const id = inner.pressId, mode = inner.pressMode;
      inner.move(pointer, x, y, t);
      observe(before, id, mode, x, y, t);
    },
    up(pointer, x, y, t) {
      if (pointer !== inner.pointerId) return;
      const before = inner.swipe;
      const id = inner.pressId, mode = inner.pressMode;
      inner.up(pointer, x, y, t);
      observe(before, id, mode, x, y, t);
      count = 0;
    },
    cancel(pointer, t) {
      if (pointer !== inner.pointerId) return;
      inner.cancel(pointer, t);
      count = 0;
    },
    releaseAll(t) {
      inner.releaseAll(t);
      count = 0;
    },
    update: (t) => inner.update(t),
    setId: (next) => inner.setId(next),
  };
}

/**
 * Build the four defence buttons (SPRINT & TACKLE, SLIDE / CLEAR, SWITCH, 2ND DEF) on the layout's slots. `enabled`,
 * when given, decides when the defence set is live (it replaces the default rule defenceSetActive(state.mode)).
 */
export function createDefenceCluster(
  state: TouchIntentState, layout: ClusterLayout, enabled?: () => boolean, opts: DefenceClusterOptions = {},
): DefenceCluster {
  const controls: DefenceButtonControl[] = [];
  const bySlot: DefenceButtonControl[] = [];
  const live = (_id: TouchButtonId): boolean => (enabled ? enabled() : defenceSetActive(state.mode));
  /** Distance from (x, y) to a button's rim (negative inside). */
  const rim = (b: TouchButtonControl, x: number, y: number): number => {
    const dx = x - b.geom.cx, dy = y - b.geom.cy;
    return Math.sqrt(dx * dx + dy * dy) - b.geom.r;
  };
  const hint = (id: TouchButtonId, mode: ClusterMode): boolean => !!opts.hints && opts.hints() && defenceSwipeHintMask(id, mode) !== 0;

  for (let k = 0; k < ORDER.length; k++) {
    const slot = ORDER[k]!;
    const id = SLOT_DEFENCE_BUTTON[slot]!;
    const src = layout.slots[slot];
    let self: DefenceButtonControl | null = null;
    const btn = createDefenceButton({
      state,
      id,
      geom: { cx: src.cx, cy: src.cy, r: src.r },
      enabled: () => live(id),
      // Inside overlapping slop the nearest live button (by distance to its rim) wins.
      claim: (x, y) => {
        const mine = rim(self!, x, y);
        if (mine <= 0) return true;
        for (let j = 0; j < controls.length; j++) {
          const o = controls[j]!;
          if (o === self || !live(o.id)) continue;
          if (rim(o, x, y) < mine) return false;
        }
        return true;
      },
      hint,
    });
    self = btn;
    controls.push(btn);
    bySlot[slot] = btn;
  }
  const slide = bySlot[ClusterSlot.HIGH]!;
  return {
    controls,
    relayout(l) {
      for (let i = 0; i < controls.length; i++) {
        const src = l.slots[ORDER[i]!];
        const g = controls[i]!.geom;
        g.cx = src.cx; g.cy = src.cy; g.r = src.r;
      }
    },
    update(t) {
      for (let i = 0; i < controls.length; i++) controls[i]!.update(t);
    },
    get hintMask() {
      let m = 0;
      for (let i = 0; i < controls.length; i++) {
        const c = controls[i]!;
        if (c.hint && c.pressId !== -1) m |= 1 << c.pressId;
      }
      return m;
    },
    slot: (s) => bySlot[s]!,
    live,
    swipeAim(id) {
      for (let i = 0; i < controls.length; i++) if (controls[i]!.id === id) return controls[i]!.aim;
      return NONE_AIM;
    },
    get slideClear() { return slide.pressClear; },
  };
}

// ============================================================ the cluster controller (swap view)

/** The attack set as the controller needs it (TCH-03 AttackCluster). */
export type ClusterAttackSet = Pick<AttackCluster, 'controls' | 'relayout' | 'update' | 'hintMask' | 'slot' | 'live'>;

export interface ClusterControllerOptions {
  state: TouchIntentState;
  attack: ClusterAttackSet;
  defence: DefenceCluster;
}

export interface ClusterController {
  readonly attack: ClusterAttackSet;
  readonly defence: DefenceCluster;
  /** Every slot control (attack then defence, each in hit-test order) for the pointer manager. */
  readonly controls: readonly TouchButtonControl[];
  /** TouchIntentState.mode as of the last update / sync. */
  readonly mode: ClusterMode;
  /** Per ClusterSlot: the button the slot stands for now (-1 hidden), its mode, label and whether a finger is down. */
  readonly ids: readonly (TouchButtonId | -1)[];
  readonly modes: readonly ClusterMode[];
  readonly labels: readonly string[];
  /** Mask over ClusterSlot of slots with a finger down. */
  readonly pressed: number;
  /** Increments whenever ids / modes / labels / pressed change (the overlay rewrites the DOM only then). */
  readonly version: number;
  /** Mode changes seen. */
  readonly swaps: number;
  /** Buttons showing direction hints now (both sets), as a mask over TouchButtonId. */
  readonly hintMask: number;
  /** Advance the hold / hint timers of both sets, then sync(). Call once per animation frame and before each sample. */
  update(tMs: number): void;
  /** Apply a mode change (idle buttons forget a pending first tap) and refresh the slot view. Cheap. */
  sync(tMs: number): void;
  /** Copy a new layout into both sets. */
  relayout(layout: ClusterLayout): void;
  /** Slot meaning into out (as of the last sync). */
  slot(slot: ClusterSlot, out: SlotMeaning): SlotMeaning;
}

/**
 * The cluster controller: the four slots and their two button sets (attack / keeper / set piece from TCH-03, defence
 * from this module). Which set claims new touches follows TouchIntentState.mode at once (each set's live rule); a
 * finger already down stays with the button it landed on and keeps that meaning until it lifts; the slot view
 * (ids, labels, pressed) applies the swap rule (slotMeaning).
 */
export function createClusterController(opts: ClusterControllerOptions): ClusterController {
  const st = opts.state;
  const attack = opts.attack;
  const defence = opts.defence;
  const controls: TouchButtonControl[] = [...attack.controls, ...defence.controls];
  const ids: (TouchButtonId | -1)[] = [-1, -1, -1, -1];
  const modes: ClusterMode[] = [ClusterMode.ATTACK, ClusterMode.ATTACK, ClusterMode.ATTACK, ClusterMode.ATTACK];
  const labels: string[] = ['', '', '', ''];
  const M = createSlotMeaning();
  let pressed = 0;
  let version = 0;
  let swaps = 0;
  let lastMode = -1;

  function sync(t: number): void {
    const mode = st.mode;
    if (mode !== lastMode) {
      if (lastMode !== -1) {
        swaps++;
        // A lifted thumb starts fresh in the new possession: no double tap across a swap.
        for (let i = 0; i < controls.length; i++) {
          const c = controls[i]!;
          if (c.pointerId === -1) c.releaseAll(t);
        }
      }
      lastMode = mode;
    }
    let pm = 0;
    let changed = false;
    for (let s = ClusterSlot.BIG; s <= ClusterSlot.HIGH; s++) {
      const a = attack.slot(s);
      const d = defence.slot(s);
      const defenceLive = defence.live(d.id);
      const attackLive = attack.live(a.id);
      const livePress = defenceLive && !attackLive ? d : a;
      const otherPress = livePress === a ? d : a;
      slotMeaning(mode, st.clearOn, s, livePress, otherPress, M);
      if (M.pressed) pm |= 1 << s;
      if (ids[s] !== M.id || modes[s] !== M.mode || labels[s] !== M.label) {
        ids[s] = M.id;
        modes[s] = M.mode;
        labels[s] = M.label;
        changed = true;
      }
    }
    if (pm !== pressed) {
      pressed = pm;
      changed = true;
    }
    if (changed) version++;
  }

  return {
    attack,
    defence,
    controls,
    get mode() { return lastMode === -1 ? st.mode : (lastMode as ClusterMode); },
    ids,
    modes,
    labels,
    get pressed() { return pressed; },
    get version() { return version; },
    get swaps() { return swaps; },
    get hintMask() { return attack.hintMask | defence.hintMask; },
    update(t) {
      attack.update(t);
      defence.update(t);
      sync(t);
    },
    sync,
    relayout(l) {
      attack.relayout(l);
      defence.relayout(l);
    },
    slot(s, out) {
      out.id = ids[s]!;
      out.mode = modes[s]!;
      out.label = labels[s]!;
      out.pressed = (pressed & (1 << s)) !== 0;
      return out;
    },
  };
}
