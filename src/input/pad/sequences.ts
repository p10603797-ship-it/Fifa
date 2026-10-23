/**
 * [PAD-04] Device-level sequences (BRIEF section 10 "Tactics, set pieces and menus"): D-pad tactics. A first D-pad
 * press opens a sequence; a second press within T_PAD.dpadSequenceMs of the first completes it:
 *   up    then up / left / right / down  -> TACTIC_OFFSIDE_TRAP / TACTIC_TEAM_PRESS / TACTIC_EXTRA_STRIKER / TACTIC_GET_IN_BOX
 *   right then up / left / right         -> FOCUS_DEFAULT / FOCUS_DEFENDING / FOCUS_ATTACKING
 *   down  then down                      -> QUICK_SUB (the app opens the quick-sub prompt; the sim ignores it)
 *   down  then up / left / right / down  -> CORNER_FAR_POST / CORNER_EDGE_OF_BOX / CORNER_CROWD_KEEPER / CORNER_NEAR_POST
 *                                           instead, while the human's own team takes a corner (isTeamCornerContext)
 * The result is a Command edge written into InputFrame.cmd with cmdArg 0. Button combos and double taps on the face
 * buttons are resolved in the sim from edges (SIM-15); createPressLatch() below keeps every device-level press a
 * separate press edge in the tick stream when a pad is polled faster than the sim ticks.
 *
 * Recogniser rules (deterministic: the same edge stream and timestamps give the same commands):
 *  - Only press edges count; holding a direction never repeats. Other buttons (face, shoulders, sticks) never reach the
 *    recogniser, so they can be pressed between the two D-pad presses freely.
 *  - The sequence kind is decided by the first press and the context at that moment ('tactics', 'focus', 'sub' or
 *    'corner'); D-pad left alone opens nothing. A pending 'corner' sequence is cancelled as soon as the corner
 *    context ends (the corner was taken or the phase changed); a pending 'sub' stays 'sub' if a corner starts.
 *  - The window is inclusive: a second press exactly T_PAD.dpadSequenceMs after the first still completes. Later, the
 *    pending sequence has expired and the press opens a new one. A clock that jumps back by more than the window
 *    cancels the pending one (a small step back, e.g. a rAF stamp after a performance.now stamp, is tolerated).
 *  - A second press that is not a continuation of the pending kind (right then down, down then up outside a corner)
 *    starts a new sequence with that press (or clears the pending one for D-pad left).
 *  - Two or more D-pad edges in the same poll are a diagonal on the rocker, not a deliberate press: ignored.
 *  - After a command the recogniser is idle; the completing press never opens a new sequence.
 *
 * Integration (PAD-02 mapper; same shape as PAD-05 rightStick):
 *   pollFrame / readFrame(nowMs): seq.updatePad(slot | null, nowMs)  // own edge detection on buttons 12..15
 *   sample(out, ctx):             seq.setContext(ctx); seq.applyTo(out)
 *   releaseAll():                 seq.reset()                       // pause, blur, visibility: forget everything
 *   dispose():                    seq.dispose()
 * Edges are detected from the held D-pad bits against the previous call (not slot.prevPressed), so feeding the same
 * poll twice never doubles a press, and after reset() / a reconnect a direction that is still held is not a press.
 * Non-standard pads have no reliable D-pad on 12..15: they produce nothing unless opts.readDpad supplies the bits.
 *
 * HUD (UIX-12): getPadSequencePending(human) / readPadSequenceHud(human, out) give the pending kind per human and
 * PAD_SEQUENCE_MENUS the title and the option labels per kind for the small prompt. setPadSequencesSuspended(true)
 * mutes every recogniser while an in-match overlay is driven by the D-pad (the quick-sub prompt), so navigating it
 * never fires tactics.
 *
 * Device-side code (not sim): no allocation per poll or sample.
 */

import { MAX_HUMANS } from '../../contracts/constants';
import { Command, MatchPhase, RestartKind } from '../../contracts/enums';
import type { InputFrame } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { T_PAD, T_PAD_SEQUENCES } from '../../contracts/tuning';
import { PadButton, type PadSlot } from './manager';

const LOCAL_TUNING = T_PAD_SEQUENCES; // [TUN-2] latch timing: contracts/tuning.ts T_PAD_SEQUENCES

/** The LOCAL_TUNING block (read-only; tests). */
export const PAD_SEQUENCE_TUNING = LOCAL_TUNING;

/** D-pad direction indices = bit numbers in the dpadEdges / held masks (standard buttons 12..15 minus 12). */
export const DpadDir = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3 } as const;
export type DpadDir = (typeof DpadDir)[keyof typeof DpadDir];

/** D-pad bits in the dpadEdges / held masks. */
export const DpadBit = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8 } as const;
export const DPAD_MASK = 15;

/** Sequence kinds for the HUD prompt. */
export type PadSequenceKind = 'tactics' | 'focus' | 'sub' | 'corner';

const MODE_NONE = -1;
const MODE_TACTICS = 0;
const MODE_FOCUS = 1;
const MODE_SUB = 2;
const MODE_CORNER = 3;
const KIND_NAMES: readonly PadSequenceKind[] = ['tactics', 'focus', 'sub', 'corner'];

/** Command per (mode * 4 + second direction); NONE = not a continuation. Directions: up, down, left, right. */
const SEQ_TABLE: readonly Command[] = [
  Command.TACTIC_OFFSIDE_TRAP, Command.TACTIC_GET_IN_BOX, Command.TACTIC_TEAM_PRESS, Command.TACTIC_EXTRA_STRIKER,
  Command.FOCUS_DEFAULT, Command.NONE, Command.FOCUS_DEFENDING, Command.FOCUS_ATTACKING,
  Command.NONE, Command.QUICK_SUB, Command.NONE, Command.NONE,
  Command.CORNER_FAR_POST, Command.CORNER_NEAR_POST, Command.CORNER_EDGE_OF_BOX, Command.CORNER_CROWD_KEEPER,
];

function modeFor(dir: number, corner: boolean): number {
  switch (dir) {
    case DpadDir.UP: return MODE_TACTICS;
    case DpadDir.RIGHT: return MODE_FOCUS;
    case DpadDir.DOWN: return corner ? MODE_CORNER : MODE_SUB;
    default: return MODE_NONE;
  }
}

function isDir(v: number): boolean {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/** Sequence kind a first press of `dir` opens (`corner`: the human's team takes a corner), or null (left, invalid). */
export function padSequenceKindFor(dir: number, corner: boolean): PadSequenceKind | null {
  const m = isDir(dir) ? modeFor(dir, corner) : MODE_NONE;
  return m < 0 ? null : KIND_NAMES[m]!;
}

/** Command completed by `first` then `second` (DpadDir indices), Command.NONE when the pair is not a sequence. */
export function padSequenceCommand(first: number, second: number, corner: boolean): Command {
  if (!isDir(first) || !isDir(second)) return Command.NONE;
  const m = modeFor(first, corner);
  return m < 0 ? Command.NONE : SEQ_TABLE[m * 4 + second]!;
}

// ---------------------------------------------------------------- HUD labels

export interface PadSequenceOption {
  /** Second press. */
  readonly dir: DpadDir;
  readonly cmd: Command;
  readonly label: string;
}

export interface PadSequenceMenu {
  readonly kind: PadSequenceKind;
  readonly title: string;
  /** First press that opens it. */
  readonly first: DpadDir;
  /** In BRIEF order (up, left, right, down), only the valid continuations. */
  readonly options: readonly PadSequenceOption[];
}

function menu(kind: PadSequenceKind, title: string, first: DpadDir, labels: readonly [DpadDir, string][]): PadSequenceMenu {
  const corner = kind === 'corner';
  const options: PadSequenceOption[] = [];
  for (let i = 0; i < labels.length; i++) {
    const [dir, label] = labels[i]!;
    options.push({ dir, cmd: padSequenceCommand(first, dir, corner), label });
  }
  return { kind, title, first, options };
}

/** Title and options per kind for the HUD prompt (BRIEF section 10 wording). */
export const PAD_SEQUENCE_MENUS: Readonly<Record<PadSequenceKind, PadSequenceMenu>> = {
  tactics: menu('tactics', 'Quick tactics', DpadDir.UP, [
    [DpadDir.UP, 'Offside trap'], [DpadDir.LEFT, 'Team press'], [DpadDir.RIGHT, 'Extra striker'], [DpadDir.DOWN, 'Get in the box'],
  ]),
  focus: menu('focus', 'Tactical focus', DpadDir.RIGHT, [
    [DpadDir.UP, 'Default'], [DpadDir.LEFT, 'Defending'], [DpadDir.RIGHT, 'Attacking'],
  ]),
  sub: menu('sub', 'Quick substitution', DpadDir.DOWN, [[DpadDir.DOWN, 'Quick sub']]),
  corner: menu('corner', 'Corner tactics', DpadDir.DOWN, [
    [DpadDir.UP, 'Far post'], [DpadDir.LEFT, 'Edge of box'], [DpadDir.RIGHT, 'Crowd the keeper'], [DpadDir.DOWN, 'Near post'],
  ]),
};

// ---------------------------------------------------------------- context

/**
 * True while team `side` takes a corner that has not been played yet (phase CORNER, restart kind CORNER, taken 0):
 * the D-pad down sequences are corner tactics then. False for the defending side, any other phase, a missing state
 * or a side that is not 0 / 1.
 */
export function isTeamCornerContext(state: ReadonlySimState | null | undefined, side: number): boolean {
  if (!state || (side !== 0 && side !== 1)) return false;
  const m = state.match;
  if (!m || m.phase !== MatchPhase.CORNER) return false;
  const r = m.restart;
  return !!r && r.kind === RestartKind.CORNER && r.taken === 0 && r.team === side;
}

/** Held D-pad bits of a pad (bit 0 up, 1 down, 2 left, 3 right); 0 for a pad without the standard mapping. */
export function padDpadBits(slot: Readonly<PadSlot>): number {
  return slot.standard ? (slot.pressed >>> PadButton.DPAD_UP) & DPAD_MASK : 0;
}

// ---------------------------------------------------------------- HUD bridge (per human)

export interface PadSequenceHudState {
  /** Pending sequence of that human, null when none. */
  kind: PadSequenceKind | null;
  /** Timestamp of the first press (ms, the pad poll clock), -1 when none. */
  sinceMs: number;
  /** Window for the second press (T_PAD.dpadSequenceMs). */
  windowMs: number;
}

const HUD_KIND: (PadSequenceKind | null)[] = [];
const HUD_SINCE: number[] = [];
const HUD_WINDOW: number[] = [];
const HUD_OWNER: (object | null)[] = [];
for (let h = 0; h < MAX_HUMANS; h++) {
  HUD_KIND.push(null);
  HUD_SINCE.push(-1);
  HUD_WINDOW.push(T_PAD.dpadSequenceMs);
  HUD_OWNER.push(null);
}

function validHuman(h: number): boolean {
  return Number.isInteger(h) && h >= 0 && h < MAX_HUMANS;
}

/** Pending D-pad sequence of `human` (0 = P1, 1 = P2) for the HUD prompt, null when none. */
export function getPadSequencePending(human: number): PadSequenceKind | null {
  return validHuman(human) ? HUD_KIND[human]! : null;
}

/** Fill `out` with the pending sequence of `human` (no allocation). */
export function readPadSequenceHud(human: number, out: PadSequenceHudState): PadSequenceHudState {
  if (validHuman(human) && HUD_KIND[human] !== null) {
    out.kind = HUD_KIND[human]!;
    out.sinceMs = HUD_SINCE[human]!;
    out.windowMs = HUD_WINDOW[human]!;
  } else {
    out.kind = null;
    out.sinceMs = -1;
    out.windowMs = T_PAD.dpadSequenceMs;
  }
  return out;
}

/** Clear every published pending sequence (match end, suspension). Recognisers republish on their next change. */
export function clearPadSequenceHud(): void {
  for (let h = 0; h < MAX_HUMANS; h++) {
    HUD_KIND[h] = null;
    HUD_SINCE[h] = -1;
    HUD_WINDOW[h] = T_PAD.dpadSequenceMs;
    HUD_OWNER[h] = null;
  }
}

let suspended = false;

/**
 * Mute every D-pad recogniser (true) while an in-match overlay is navigated with the D-pad, e.g. the quick-sub prompt.
 * While muted nothing is pending or produced and held directions are tracked, so un-muting never fires a press that
 * was made for the overlay.
 */
export function setPadSequencesSuspended(on: boolean): void {
  suspended = on;
  if (on) clearPadSequenceHud();
}

export function padSequencesSuspended(): boolean {
  return suspended;
}

// ---------------------------------------------------------------- recogniser

/** What setContext reads (an InputSampleContext fits). */
export interface PadSequenceContext {
  readonly state: ReadonlySimState | null | undefined;
  readonly side: number;
  readonly human: number;
}

export interface PadSequencesOptions {
  /** Window for the second press, ms. Default T_PAD.dpadSequenceMs. */
  windowMs?: number;
  /** Held D-pad bits for a pad (bit 0 up, 1 down, 2 left, 3 right). Default padDpadBits (standard mapping only). */
  readDpad?: (slot: Readonly<PadSlot>) => number;
}

export interface PadSequences {
  /**
   * Feed D-pad press edges for this frame (bit 0 up, 1 down, 2 left, 3 right) and whether a corner is being taken.
   * Returns the Command completed this frame, or Command.NONE.
   */
  update(dpadEdges: number, nowMs: number, cornerContext: boolean): Command;
  /** First press of a sequence waiting for the second (for a HUD hint), -1 none. A DpadDir index (0 up, 1 down, 3 right). */
  readonly pending: number;
  reset(): void;

  /** Timestamp (ms) of the pending first press, -1 none. */
  readonly pendingSinceMs: number;
  /** Second-press window, ms. */
  readonly windowMs: number;
  /** Pending sequence kind, null none. With nowMs, a sequence whose window has passed reads null already. */
  getPending(nowMs?: number): PadSequenceKind | null;
  /** Time left for the second press, ms (0 when nothing is pending). */
  remainingMs(nowMs: number): number;
  /**
   * Device poll with the HELD D-pad bits (keyboards and custom sources): detects press edges against the previous
   * call, runs update() with the context from setContext() and latches a completed command for applyTo().
   */
  updateHeld(dpadHeld: number, nowMs: number): Command;
  /** Device poll for a pad slot (null or disconnected: everything is reset). */
  updatePad(slot: Readonly<PadSlot> | null, nowMs: number): Command;
  /** Per sample: corner context (ctx.state, ctx.side) and the human whose HUD prompt this recogniser drives. */
  setContext(ctx: PadSequenceContext): void;
  /** Per sample: write the oldest latched command into out.cmd / out.cmdArg (0) when out.cmd is still NONE. */
  applyTo(out: InputFrame): void;
  /** reset() and stop publishing to the HUD. */
  dispose(): void;
}

const QUEUE = 4;

class PadSequenceRecogniser implements PadSequences {
  readonly windowMs: number;
  private readonly readDpad: (slot: Readonly<PadSlot>) => number;
  private mode = MODE_NONE;
  private first = -1;
  private since = -1;
  private prevHeld = 0;
  private synced = false;
  private corner = false;
  private human = -1;
  private readonly qCmd = new Int32Array(QUEUE);
  private readonly qMs = new Float64Array(QUEUE);
  private qHead = 0;
  private qLen = 0;

  constructor(opts: PadSequencesOptions) {
    const w = opts.windowMs;
    this.windowMs = typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : T_PAD.dpadSequenceMs;
    this.readDpad = opts.readDpad ?? padDpadBits;
  }

  get pending(): number { return this.first; }
  get pendingSinceMs(): number { return this.since; }

  getPending(nowMs?: number): PadSequenceKind | null {
    if (this.mode < 0) return null;
    if (nowMs !== undefined && this.expired(nowMs)) return null;
    return KIND_NAMES[this.mode]!;
  }

  remainingMs(nowMs: number): number {
    if (this.mode < 0 || !Number.isFinite(nowMs) || this.expired(nowMs)) return 0;
    const r = this.windowMs - (nowMs - this.since);
    return r > this.windowMs ? this.windowMs : r;
  }

  update(dpadEdges: number, nowMs: number, cornerContext: boolean): Command {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return Command.NONE;
    if (this.mode >= 0 && (this.expired(nowMs) || (this.mode === MODE_CORNER && !cornerContext))) this.clear();
    const e = dpadEdges & DPAD_MASK;
    if (e === 0 || (e & (e - 1)) !== 0) { // nothing, or a diagonal (two edges in one poll)
      this.publish();
      return Command.NONE;
    }
    const dir = e === DpadBit.UP ? DpadDir.UP : e === DpadBit.DOWN ? DpadDir.DOWN : e === DpadBit.LEFT ? DpadDir.LEFT : DpadDir.RIGHT;
    if (this.mode >= 0) {
      const cmd = SEQ_TABLE[this.mode * 4 + dir]!;
      if (cmd !== Command.NONE) {
        this.clear();
        this.publish();
        return cmd;
      }
    }
    // Idle, or not a continuation of the pending kind: this press opens a new sequence (left opens none).
    const m = modeFor(dir, cornerContext);
    if (m < 0) {
      this.clear();
    } else {
      this.mode = m;
      this.first = dir;
      this.since = nowMs;
    }
    this.publish();
    return Command.NONE;
  }

  updateHeld(dpadHeld: number, nowMs: number): Command {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return Command.NONE;
    const held = dpadHeld & DPAD_MASK;
    if (suspended) {
      this.prevHeld = held;
      this.synced = true;
      this.qLen = 0;
      this.clear();
      this.publish();
      return Command.NONE;
    }
    let edges = 0;
    if (this.synced) edges = held & ~this.prevHeld;
    this.prevHeld = held;
    this.synced = true;
    // Drop a latched command nobody sampled in time (ticks stopped).
    while (this.qLen > 0 && nowMs - this.qMs[this.qHead]! > LOCAL_TUNING.latchMaxMs) this.pop();
    const cmd = this.update(edges, nowMs, this.corner);
    if (cmd !== Command.NONE) this.push(cmd, nowMs);
    return cmd;
  }

  updatePad(slot: Readonly<PadSlot> | null, nowMs: number): Command {
    if (!slot || !slot.connected) {
      this.reset();
      return Command.NONE;
    }
    return this.updateHeld(this.readDpad(slot), nowMs);
  }

  setContext(ctx: PadSequenceContext): void {
    this.corner = isTeamCornerContext(ctx.state, ctx.side);
    const h = validHuman(ctx.human) ? ctx.human : -1;
    if (h !== this.human) {
      this.unpublish();
      this.human = h;
    }
    if (this.mode === MODE_CORNER && !this.corner) this.clear();
    this.publish();
  }

  applyTo(out: InputFrame): void {
    if (this.qLen === 0) return;
    if (suspended) {
      this.qLen = 0;
      return;
    }
    if (out.cmd !== Command.NONE) return; // keep it for the next frame
    out.cmd = this.qCmd[this.qHead]! as Command;
    out.cmdArg = 0;
    this.pop();
  }

  reset(): void {
    this.clear();
    this.qLen = 0;
    this.qHead = 0;
    this.synced = false;
    this.prevHeld = 0;
    this.publish();
  }

  dispose(): void {
    this.reset();
    this.unpublish();
    this.human = -1;
    this.corner = false;
  }

  /** Past the window. A small step back (rAF vs performance.now stamps) is tolerated; a jump back beyond it expires. */
  private expired(nowMs: number): boolean {
    const dt = nowMs - this.since;
    return dt > this.windowMs || dt < -this.windowMs;
  }

  private clear(): void {
    this.mode = MODE_NONE;
    this.first = -1;
    this.since = -1;
  }

  private push(cmd: Command, nowMs: number): void {
    if (this.qLen === QUEUE) this.pop(); // cannot happen at human speed; keep the newest
    const i = (this.qHead + this.qLen) % QUEUE;
    this.qCmd[i] = cmd;
    this.qMs[i] = nowMs;
    this.qLen++;
  }

  private pop(): void {
    this.qHead = (this.qHead + 1) % QUEUE;
    this.qLen--;
  }

  private publish(): void {
    const h = this.human;
    if (h < 0) return;
    if (this.mode >= 0 && !suspended) {
      HUD_KIND[h] = KIND_NAMES[this.mode]!;
      HUD_SINCE[h] = this.since;
      HUD_WINDOW[h] = this.windowMs;
      HUD_OWNER[h] = this;
    } else if (HUD_OWNER[h] === this) {
      this.unpublish();
    }
  }

  private unpublish(): void {
    const h = this.human;
    if (h < 0 || HUD_OWNER[h] !== this) return;
    HUD_KIND[h] = null;
    HUD_SINCE[h] = -1;
    HUD_WINDOW[h] = T_PAD.dpadSequenceMs;
    HUD_OWNER[h] = null;
  }
}

export function createPadSequences(opts: PadSequencesOptions = {}): PadSequences {
  return new PadSequenceRecogniser(opts);
}

// ---------------------------------------------------------------- double-press latch

/**
 * Device-level double-press latch for any button bitmask (PAD-02 face buttons, keyboard keys). Pads are polled once
 * per animation frame (120 Hz on ProMotion iPads) but sampled once per sim tick (60 Hz): a tap that starts and ends
 * between two samples, or a release + re-press between two samples, would otherwise be merged into one press or a
 * hold. The latch queues press edges per bit and reports each as its own press edge: at least one sample down and,
 * between two presses, at least one sample up. With nothing queued the physical state is reported.
 */
export interface PressLatch {
  /** Device poll: bits physically down now. New press edges are queued (at most pressQueueMax per bit). */
  poll(down: number): void;
  /** Once per tick: the bits to report. */
  sample(): number;
  /** Forget queued presses; bits down at the last poll stay suppressed until released (releaseAll). */
  reset(): void;
  /** Presses queued for bit index b (tests, debug). */
  queued(b: number): number;
}

class PressLatchImpl implements PressLatch {
  private readonly count = new Uint8Array(32);
  /** Bits with count > 0. */
  private queuedMask = 0;
  /** Physical bits at the last poll, minus suppressed ones. */
  private live = 0;
  private raw = 0;
  private suppress = 0;
  /** Bits reported by the last sample. */
  private out = 0;

  poll(down: number): void {
    const d = down | 0;
    this.raw = d;
    this.suppress &= d; // a suppressed bit re-arms once it is physically released
    const live = d & ~this.suppress;
    let edges = live & ~this.live;
    this.live = live;
    while (edges !== 0) {
      const b = 31 - Math.clz32(edges);
      edges &= ~(1 << b);
      const c = this.count[b]!;
      if (c < LOCAL_TUNING.pressQueueMax) this.count[b] = c + 1;
      this.queuedMask |= 1 << b;
    }
  }

  sample(): number {
    let res = this.live & ~this.queuedMask;
    let q = this.queuedMask;
    while (q !== 0) {
      const b = 31 - Math.clz32(q);
      const bit = 1 << b;
      q &= ~bit;
      if ((this.out & bit) !== 0) continue; // was reported down: one sample up first (a gap between two presses)
      res |= bit;
      const c = this.count[b]! - 1;
      this.count[b] = c;
      if (c === 0) this.queuedMask &= ~bit;
    }
    this.out = res;
    return res;
  }

  reset(): void {
    this.count.fill(0);
    this.queuedMask = 0;
    this.suppress = this.raw;
    this.live = 0;
    this.out = 0;
  }

  queued(b: number): number {
    return Number.isInteger(b) && b >= 0 && b < 32 ? this.count[b]! : 0;
  }
}

export function createPressLatch(): PressLatch {
  return new PressLatchImpl();
}
