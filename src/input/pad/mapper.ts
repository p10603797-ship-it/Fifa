/**
 * [PAD-02] Controller -> InputFrame (section 10, EA SPORTS FC 26 Classic layout, bound by POSITION on the Standard
 * Gamepad mapping; InputFrame buttons are positional-semantic, DECISIONS D-004):
 *
 *   index  PlayStation / Xbox   InputFrame
 *   0      Cross / A            Btn.PASS
 *   1      Circle / B           Btn.SHOOT
 *   2      Square / X           Btn.LOB
 *   3      Triangle / Y         Btn.THROUGH
 *   4      L1 / LB              Btn.MOD_L
 *   5      R1 / RB              Btn.MOD_R
 *   6      L2 / LT (> 0.3)      Btn.SHIELD   (analogue trigger, T_PAD.triggerThreshold; PAD-01 release hysteresis)
 *   7      R2 / RT (> 0.3)      Btn.SPRINT
 *   9      Options / Menu       pause (press edge -> onPause), not an InputFrame bit
 *   12-15  D-pad                tactics sequences -> cmd / cmdArg 0 (PAD-04 createPadSequences: the held D-pad bits,
 *                               remapped and suppression-aware, go to updateHeld() every poll; setContext + applyTo
 *                               every sample, so corner tactics apply while the human's own team takes a corner)
 *   left stick                  mx / mz (stick right = +x, stick up = -z, rotated by CameraProjector.stickRotation)
 *   right stick                 ax / az, plus RS_FLICK / RS_HOLD / skill from PAD-05 createRightStick (on a flick or a
 *                               skill sample ax/az carry that direction instead of the raw stick)
 *   8 Create/View, 10/11 L3/R3: unbound. 16 Home and 17 Share belong to iPadOS: never read for a standard pad.
 *
 * Logical actions (PadAction, bit i of the mapper's logical mask) are also the slot order of a custom remap:
 * settings.controls.pad.remaps[gamepad.id][PadAction] = raw button index (0 .. PAD_REMAP_MAX_INDEX - 1, -1 unbound).
 * A remap applies only to a pad whose mapping is not 'standard' (PAD-07's remap screen writes it); a non-standard
 * pad without one is read by the standard positions. Remapped SHIELD / SPRINT keep the analogue threshold.
 *
 * Edges (per pollFrame = per animation frame, sampled once per tick by sample()):
 *  - Every physical press reaches the sim exactly once, in order. A press shorter than a tick is latched and reported
 *    held for one sample; a release + re-press between two samples (button still reported held) is reported as a
 *    release on the next sample and the press on the one after, so double taps are never merged. Presses seen only at
 *    a manager poll that this source did not read (another poller, other timestamp) are recovered from prevPressed.
 *    At most two unreported presses per button are kept (a distinct press needs one sample down and one up, so the
 *    sim can show 30 presses per second; more taps than that within one sample interval merge): button mashing never
 *    queues actions that fire after the player stopped.
 *  - Modifier order: a modifier (L1 / R1) pressed at a LATER poll than a face button whose press is not reported yet
 *    (same sample interval) is reported one sample after that face press, so the sim (which resolves combos at the
 *    face press) sees the face button first ("A modifier combo resolves when the face button is pressed, never when
 *    the modifier is"). Pressed at the same poll or earlier, the modifier is held at the face press (combo).
 *  - Buttons already held before the source first sees its pad (e.g. the press that started the match), anything held
 *    when a lost pad reconnects, and buttons held at releaseAll() (pause, resume, blur, possession swap) are
 *    suppressed until physically released (a button pressed at the very poll the source first reads still counts).
 *    releaseAll() covers the manager's latest poll even when this source has not read it yet (two pads: the first
 *    Options press pauses and the session's releaseAll swallows the second pad's Options of the same poll, so both
 *    players pausing at once never pauses and resumes). The right-stick recogniser is reset then too (sticks ignored
 *    until centred), D-pad sequences and latched commands are dropped.
 *  - Options pauses on its press edge (after the poll's state is stored, so onPause may call releaseAll()).
 * Holds, double taps, combos, buffering and power are resolved in the sim from these edges (SIM-15).
 *
 * Device code (not sim): no allocation per poll or sample; Math and performance.now are fine here.
 */

import {
  AXIS_SCALE, Btn, clearInputFrame, type CameraProjector, type InputFrame, type InputSampleContext, type InputSource,
} from '../../contracts/input';
import type { Settings } from '../../contracts/settings';
import { T_PAD } from '../../contracts/tuning';
import { getPadManager, PAD_BUTTON_COUNT, PAD_TRIGGER_RELEASE, PadButton, type PadManager, type PadSlot } from './manager';
import { createRightStick, type RightStickTracker } from './rightStick';
import { createPadSequences, type PadSequences } from './sequences';

const LOCAL_TUNING = {
  /** sample() polls the pads itself when nobody polled them for longer than this (pollFrame not called), ms. */
  fallbackPollMs: 12,
} as const; // TUNING-CR (device timing, not gameplay): T_PAD.fallbackPollMs

/** The LOCAL_TUNING block (read-only; tests and the lead's TUNING-CR review). */
export const MAPPER_TUNING = LOCAL_TUNING;

/** Logical pad actions: bit i of the mapper's logical mask, and the slot order of a custom remap array. */
export const PadAction = {
  PASS: 0, SHOOT: 1, LOB: 2, THROUGH: 3, MOD_L: 4, MOD_R: 5, SHIELD: 6, SPRINT: 7,
  PAUSE: 8, DPAD_UP: 9, DPAD_DOWN: 10, DPAD_LEFT: 11, DPAD_RIGHT: 12,
} as const;

/** Number of PadAction entries (length of a remap array). */
export const PAD_ACTION_COUNT = 13;

/** Standard Gamepad button index per PadAction (the default binding). */
export const PAD_STANDARD_INDEX: readonly number[] = [
  PadButton.SOUTH, PadButton.EAST, PadButton.WEST, PadButton.NORTH, PadButton.L1, PadButton.R1, PadButton.L2, PadButton.R2,
  PadButton.START, PadButton.DPAD_UP, PadButton.DPAD_DOWN, PadButton.DPAD_LEFT, PadButton.DPAD_RIGHT,
];

/** InputFrame Btn bit per PadAction 0..7 (PASS .. SPRINT). */
export const PAD_ACTION_BITS: readonly number[] = [
  Btn.PASS, Btn.SHOOT, Btn.LOB, Btn.THROUGH, Btn.MOD_L, Btn.MOD_R, Btn.SHIELD, Btn.SPRINT,
];

/** Standard button index -> Btn bit for the digital face/shoulder buttons (indices 0..5). */
export const PAD_BUTTON_BITS: readonly number[] = PAD_ACTION_BITS.slice(0, 6);

/** Raw button indices a remap may name: 0 .. PAD_REMAP_MAX_INDEX - 1. */
export const PAD_REMAP_MAX_INDEX = 32;

/** Logical bits 0..7 (the eight InputFrame buttons). */
const BTN8 = 0xff;
const FACE_LOGICAL = (1 << PadAction.PASS) | (1 << PadAction.SHOOT) | (1 << PadAction.LOB) | (1 << PadAction.THROUGH);
const MOD_LOGICAL = (1 << PadAction.MOD_L) | (1 << PadAction.MOD_R);
const PAUSE_LOGICAL = 1 << PadAction.PAUSE;

/** Btn bits for a pad slot's current state by the standard positions (pure, no allocation). */
export function mapPadButtons(s: Readonly<PadSlot>): number {
  let bits = 0;
  for (let a = 0; a < PAD_ACTION_BITS.length; a++) {
    if ((s.pressed & (1 << PAD_STANDARD_INDEX[a]!)) !== 0) bits |= PAD_ACTION_BITS[a]!;
  }
  return bits;
}

/** Logical mask (PadAction bits 0..7) -> InputFrame Btn bits. */
export function logicalToButtons(mask: number): number {
  let bits = 0;
  for (let a = 0; a < PAD_ACTION_BITS.length; a++) if ((mask & (1 << a)) !== 0) bits |= PAD_ACTION_BITS[a]!;
  return bits;
}

/** Valid raw button index for a remap entry, else -1. */
function rawIndex(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < PAD_REMAP_MAX_INDEX ? v : -1;
}

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Raw button index per PadAction for a pad into `out` (length >= PAD_ACTION_COUNT): the custom remap saved for its
 * gamepad.id when the pad has no standard mapping (entries missing, not integers or out of range are unbound: -1),
 * else the standard positions. Returns true when a remap was applied. Pure, no allocation.
 */
export function resolvePadRemap(
  remaps: Readonly<Record<string, readonly number[]>> | null | undefined, gamepadId: string, standard: boolean,
  out: Int16Array | number[],
): boolean {
  let list: unknown = null;
  if (!standard && remaps !== null && typeof remaps === 'object' && hasOwn.call(remaps, gamepadId)) {
    list = (remaps as Record<string, unknown>)[gamepadId];
  }
  if (!Array.isArray(list)) {
    for (let a = 0; a < PAD_ACTION_COUNT; a++) out[a] = PAD_STANDARD_INDEX[a]!;
    return false;
  }
  const arr = list as readonly unknown[];
  for (let a = 0; a < PAD_ACTION_COUNT; a++) out[a] = a < arr.length ? rawIndex(arr[a]) : -1;
  return true;
}

function finite01(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Analogue value 0..1 of raw button `raw` (a digital press with value 0 reads 1). */
function rawValue(s: Readonly<PadSlot>, raw: number): number {
  if (raw < PAD_BUTTON_COUNT) return s.value[raw]!;
  const btns = s.pad ? s.pad.buttons : null;
  if (!btns || raw >= btns.length) return 0;
  const b = btns[raw] as GamepadButton | number | null | undefined;
  if (typeof b === 'number') return finite01(b);
  if (!b) return 0;
  const v = finite01(b.value);
  return b.pressed === true && v === 0 ? 1 : v;
}

/** Digital state of raw button `raw` (manager bit below PAD_BUTTON_COUNT, else the Gamepad snapshot). */
function rawPressed(s: Readonly<PadSlot>, raw: number): boolean {
  if (raw < PAD_BUTTON_COUNT) return (s.pressed & (1 << raw)) !== 0;
  const btns = s.pad ? s.pad.buttons : null;
  if (!btns || raw >= btns.length) return false;
  const b = btns[raw] as GamepadButton | number | null | undefined;
  if (typeof b === 'number') return b > 0.5;
  return !!b && b.pressed === true;
}

/** Output of readLogical (scratch; read right after the call). */
const LOGICAL = { down: 0, prev: 0, hist: 0 };

/**
 * Logical state of a slot under binding `idx` (raw index per PadAction): LOGICAL.down = held now, LOGICAL.prev = held
 * at the manager's previous poll, LOGICAL.hist = bits that have that manager history. Bits without it (raw indices
 * past PAD_BUTTON_COUNT, analogue actions on a non-trigger index) report the source's own previous state `mine` as
 * prev. SHIELD / SPRINT engage past T_PAD.triggerThreshold and release at PAD_TRIGGER_RELEASE (the manager applies
 * the same hysteresis on L2 / R2).
 */
function readLogical(s: Readonly<PadSlot>, idx: Int16Array, mine: number): void {
  let down = 0;
  let prev = 0;
  let hist = 0;
  for (let a = 0; a < PAD_ACTION_COUNT; a++) {
    const raw = idx[a]!;
    if (raw < 0) continue;
    const bit = 1 << a;
    const analog = a === PadAction.SHIELD || a === PadAction.SPRINT;
    if (raw < PAD_BUTTON_COUNT && (!analog || raw === PadButton.L2 || raw === PadButton.R2)) {
      hist |= bit;
      if ((s.pressed & (1 << raw)) !== 0) down |= bit;
      if ((s.prevPressed & (1 << raw)) !== 0) prev |= bit;
      continue;
    }
    const was = (mine & bit) !== 0;
    if (was) prev |= bit;
    if (analog) {
      if (rawValue(s, raw) > (was ? PAD_TRIGGER_RELEASE : T_PAD.triggerThreshold)) down |= bit;
    } else if (rawPressed(s, raw)) {
      down |= bit;
    }
  }
  LOGICAL.down = down;
  LOGICAL.prev = prev;
  LOGICAL.hist = hist;
}

/** Stick scratch (initialised with doubles so V8 keeps the fields unboxed) and quantised output. */
const SC = { x: 0.5, y: 0.5 };
const QS = { qx: 0, qy: 0 };

/** Quantise SC (a pitch vector, magnitude clamped to 1) into QS exactly like axes.ts quantStick. */
function quantScratch(): void {
  let fx = Number.isFinite(SC.x) ? SC.x : 0;
  let fy = Number.isFinite(SC.y) ? SC.y : 0;
  const m = Math.sqrt(fx * fx + fy * fy);
  if (m > 1) { fx /= m; fy /= m; }
  let qx = Math.round(fx * AXIS_SCALE);
  let qy = Math.round(fy * AXIS_SCALE);
  if (qx * qx + qy * qy > AXIS_SCALE * AXIS_SCALE) {
    qx = Math.trunc(fx * AXIS_SCALE);
    qy = Math.trunc(fy * AXIS_SCALE);
  }
  QS.qx = qx === 0 ? 0 : qx;
  QS.qy = qy === 0 ? 0 : qy;
}

/**
 * Both sticks of a slot (screen space, dead-zoned) -> mx/mz and ax/az in pitch space with the camera's stick rotation;
 * the same numbers as axes.ts writeMoveAxes / writeAimAxes, computed inline (no double crosses a call boundary, so
 * V8 allocates nothing either).
 */
export function writePadSticks(out: InputFrame, s: Readonly<PadSlot>, projector: CameraProjector | null): void {
  const rot = projector ? projector.stickRotation() : 0;
  if (rot === 0) {
    SC.x = s.lx; SC.y = s.ly;
    quantScratch();
    out.mx = QS.qx; out.mz = QS.qy;
    SC.x = s.rx; SC.y = s.ry;
    quantScratch();
    out.ax = QS.qx; out.az = QS.qy;
    return;
  }
  const c = Math.cos(rot), n = Math.sin(rot);
  SC.x = c * s.lx - n * s.ly; SC.y = n * s.lx + c * s.ly;
  quantScratch();
  out.mx = QS.qx; out.mz = QS.qy;
  SC.x = c * s.rx - n * s.ry; SC.y = n * s.rx + c * s.ry;
  quantScratch();
  out.ax = QS.qx; out.az = QS.qy;
}

/** Settings access the mapper needs (a SettingsStore satisfies it). */
export interface PadSettingsSource {
  get(): Readonly<Settings>;
}

export interface PadSourceOptions {
  /** Device key ('pad:<n>') of the PadSlot to read. */
  key: string;
  /** Called on an Options / Menu press. */
  onPause(): void;
  /** Defaults to the shared page manager. */
  manager?: PadManager;
  /** Clock for the fallback poll when pollFrame is not called (defaults to performance.now). */
  now?: () => number;
  /** Settings for custom remaps of non-standard pads (settings.controls.pad.remaps). None: standard positions. */
  settings?: PadSettingsSource | null;
  /** Right-stick recogniser (PAD-05). Defaults to a new createRightStick(). */
  rightStick?: RightStickTracker;
  /** D-pad sequence recogniser (PAD-04). Defaults to a new createPadSequences(). */
  sequences?: PadSequences;
}

export interface PadInputSource extends InputSource {
  readonly key: string;
  /** The right-stick recogniser this source feeds (debug input viewer). */
  readonly rightStick: RightStickTracker;
  /** The D-pad sequence recogniser this source feeds (HUD hint: sequences.pending). */
  readonly sequences: PadSequences;
  /** Whether the pad is read through a custom remap (non-standard mapping with a saved remap). */
  readonly remapped: boolean;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export function createPadSource(opts: PadSourceOptions): PadInputSource {
  const manager = opts.manager ?? getPadManager();
  const now = opts.now ?? defaultNow;
  const settings = opts.settings ?? null;
  const rs = opts.rightStick ?? createRightStick();
  const seq = opts.sequences ?? createPadSequences();
  /** Raw button index per PadAction for the current pad. */
  const idx = new Int16Array(PAD_ACTION_COUNT);
  for (let a = 0; a < PAD_ACTION_COUNT; a++) idx[a] = PAD_STANDARD_INDEX[a]!;

  let disposed = false;
  /** The pad has been seen connected since the source was created / since its last disconnect. */
  let primed = false;
  /** manager.lastPollMs of the last poll this source read (a typed slot: V8 keeps the double unboxed). */
  const seenPoll = new Float64Array(1);
  seenPoll[0] = Number.NaN;
  /** Logical bits held at the last poll read. */
  let mine = 0;
  /** Logical bits ignored until physically released (held at priming / releaseAll). */
  let suppress = 0;
  /** Unreported press edges per button (bits 0..7): at least one / two. */
  let pend1 = 0;
  let pend2 = 0;
  /** Modifier presses held back (pressed while an earlier face press was still unreported) ... */
  let defer = 0;
  /** ... until these face presses have been reported. */
  let deferFace = 0;
  /** Buttons (logical 0..7) reported by the last sample. */
  let reported = 0;
  let remapped = false;
  /** The pad was lost (disconnect) since the source was created: at the reconnect nothing held counts as fresh. */
  let rejoin = false;

  function clearEdges(): void {
    pend1 = 0;
    pend2 = 0;
    defer = 0;
    deferFace = 0;
  }

  function lostPad(): void {
    if (!primed) return;
    primed = false;
    rejoin = true;
    mine = 0;
    suppress = 0;
    reported = 0;
    seenPoll[0] = Number.NaN;
    clearEdges();
    rs.reset();
    seq.reset();
  }

  function bind(s: Readonly<PadSlot>): void {
    const st = !s.standard && settings ? settings.get() : null;
    const remaps = st && st.controls && st.controls.pad ? st.controls.pad.remaps : null;
    remapped = resolvePadRemap(remaps, s.gamepadId, s.standard, idx);
  }

  /** Read the manager's latest poll if this source has not yet (edges, latches, sticks, D-pad, pause). */
  function ingest(): PadSlot | null {
    const s = manager.find(opts.key);
    if (!s || !s.connected) {
      lostPad();
      return null;
    }
    const pollMs = manager.lastPollMs;
    if (primed && pollMs === seenPoll[0]) return s;
    seenPoll[0] = pollMs;
    bind(s);
    readLogical(s, idx, mine);
    const down = LOGICAL.down;
    const prev = LOGICAL.prev;
    let edge: number;
    if (!primed) {
      // First sight of the pad (source created or pad joined): a button pressed at this very poll is a press; one
      // already held before it (the press that started the match, ...) waits for a release, as do buttons with no
      // history and anything held at a reconnect (the manager restarts a reconnected pad's history). The sticks wait
      // for the centre.
      primed = true;
      edge = rejoin ? 0 : down & ~prev & LOGICAL.hist;
      suppress = down & ~edge;
      reported = 0;
      clearEdges();
      rs.reset();
      seq.reset();
    } else {
      // A suppressed button is re-armed once seen up (now, or at a poll in between).
      suppress &= down & prev;
      edge = ((down & ~prev) | (prev & ~mine)) & ~suppress;
    }
    mine = down;
    const e8 = edge & BTN8;
    if (e8 !== 0) {
      // A modifier pressed after a face press that is not reported yet waits for it (a face pressed at this same
      // poll is simultaneous: combo).
      const mods = e8 & MOD_LOGICAL;
      const waiting = pend1 & FACE_LOGICAL;
      if (mods !== 0 && waiting !== 0) {
        defer |= mods;
        deferFace |= waiting;
      }
      pend2 |= pend1 & e8;
      pend1 |= e8;
    }
    rs.updatePad(s, logicalToButtons(down & ~suppress & BTN8), pollMs);
    seq.updateHeld(((down & ~suppress) >> PadAction.DPAD_UP) & 15, pollMs);
    if ((edge & PAUSE_LOGICAL) !== 0) opts.onPause();
    return s;
  }

  /** Buttons for this sample from the latches (consumes them). */
  function takeButtons(): number {
    const held = mine & ~suppress & BTN8;
    const ready = pend1 & ~defer;
    // Reported held with a newer press waiting: show the release first (the press follows next sample).
    let out = reported & ~pend1 & held;
    const fire = ~reported & ready & BTN8;
    out |= fire;
    pend1 = (pend1 & ~fire) | (pend2 & fire);
    pend2 &= ~fire;
    // Deferred modifiers go one sample after the face presses they waited for have been reported.
    if ((pend1 & deferFace) === 0) {
      defer = 0;
      deferFace = 0;
    }
    reported = out;
    return logicalToButtons(out);
  }

  const api: PadInputSource = {
    id: opts.key,
    key: opts.key,
    kind: 'pad',
    rightStick: rs,
    sequences: seq,
    get remapped() { return remapped; },
    pollFrame(nowMs: number) {
      if (disposed) return;
      manager.poll(nowMs);
      ingest();
    },
    sample(out: InputFrame, ctx: InputSampleContext) {
      clearInputFrame(out);
      if (disposed) return;
      // Fallback when nobody polled this frame (keeps pads alive; never double-polls within fallbackPollMs).
      const t = now();
      if (manager.lastPollMs < 0 || t - manager.lastPollMs > LOCAL_TUNING.fallbackPollMs) manager.poll(t);
      const s = ingest();
      if (!s) {
        reported = 0;
        return;
      }
      writePadSticks(out, s, ctx.projector);
      out.buttons = takeButtons();
      rs.setContext(ctx);
      rs.applyTo(out);
      seq.setContext(ctx);
      seq.applyTo(out);
    },
    releaseAll() {
      clearEdges();
      const s = disposed ? null : manager.find(opts.key);
      if (s && s.connected) {
        // Everything held at the manager's latest poll waits for a physical release, even when this source has not
        // read that poll yet (another source's onPause paused the match first, or another poller ran): the poll
        // counts as read, so its presses (Options included: no second pause) are dropped. Primes a fresh source.
        const was = primed ? mine : 0;
        bind(s);
        readLogical(s, idx, was);
        suppress = was | LOGICAL.down;
        mine = LOGICAL.down;
        seenPoll[0] = manager.lastPollMs;
        if (!primed) {
          primed = true;
          reported = 0;
        }
      } else {
        suppress = 0;
      }
      rs.reset();
      seq.reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearEdges();
      suppress = 0;
      reported = 0;
      rs.reset();
      seq.dispose();
    },
  };
  return api;
}
