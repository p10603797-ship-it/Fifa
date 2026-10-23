/**
 * [TCH-07] Touch -> InputFrame mapping (section 9 tables; contracts/touch.ts flow). Once per tick the mapper reads the
 * TouchIntentState written by the controls and fills one InputFrame. Buttons are positional-semantic (PASS = A,
 * SHOOT = B, LOB = X, THROUGH = Y, MOD_L = L1, MOD_R = R1, SHIELD = L2, SPRINT = R2); the sim (SIM-15) resolves
 * their meaning from context exactly as for a controller, and reads modifier combos at the FACE button's press edge.
 *
 *  1. Cluster mode (TouchIntentState.mode) from the sim each tick: clusterModeFor (TCH-04: cut-scenes HIDDEN, restarts
 *     SET_PIECE for the taking side and at penalties, else DEFENCE; own keeper holding the ball and controlled by this
 *     human KEEPER; possession ATTACK / DEFENCE). A loose ball in open play follows SIM-15's own context rule
 *     (controlContext: our pass in flight, the ball arriving at him, or he is nearer than the opponents -> ATTACK,
 *     else DEFENCE), so the label never lies; a loose-ball change must persist LOCAL_TUNING.looseSwapTicks before the
 *     cluster swaps (no flicker), possession changes swap at once. clearOn = TCH-04 clearanceOn (SIM-15's first-time
 *     clearance condition) while defending.
 *  2. Stick -> mx / mz (screen x -> +x, screen y -> +z, rotated by CameraProjector.stickRotation(); radial
 *     quantisation exactly as axes.ts writeMoveAxes, inlined so no double is boxed per tick).
 *     Stick strafe (double-tap-and-hold) -> MOD_L held in ATTACK once it has lasted LOCAL_TUNING.strafeDelayTicks
 *     (so a double tap on the stick is never an L1 tap = trigger run), with our side on the ball; held at least
 *     T_INPUT.tapTicks once sent; released by a face press that carries no MOD_L of its own (a strafing PASS tap is a
 *     ground pass, not pass and go) until the stick lifts (strafeMod, QF-3 FIX-06). A stick that lifts (or is
 *     cancelled) inside that minimum keeps sending its last axes with MOD_L until both end together: L1 held with the
 *     stick released is "stop and face goal", a 14-tick skill that swallowed the next pass (QF-3 QA-23).
 *  3. Button events -> bits held for the right number of ticks. A button that has tap, hold AND swipe meanings cannot
 *     know which one a touch-down is, and the sim starts a kick at the face press with the modifiers held then, so
 *     those presses are committed when the recogniser (TCH-03) classifies them: a TAP becomes a press as long as the
 *     finger was down (at most T_INPUT.tapTicks - 1 ticks, so the sim also sees a tap), a HOLD becomes the button held
 *     until the finger lifts (power bar), a SWIPE becomes the table cell. Power swipes (pass / through / shot
 *     variants): a finger that lifts within LOCAL_TUNING.flickLiftMs of the swipe is a flick = one press with explicit
 *     frame.power; a finger that stays down holds the combo for power. The second tap of a PASS / THROUGH double tap
 *     is committed at its touch-down so the sim sees PASS,PASS inside its double-tap window. Buttons whose meaning is
 *     known at touch-down (keeper row, SLIDE / CLEAR) press at once. SPRINT (attack) starts at touch-down when the
 *     stick is pushed, else at the tap time (a tap is a skill move; R2 with a released stick would stop the ball).
 *        attack (ATTACK / SET_PIECE)   tap / hold          up              down           left               right
 *        PASS                          PASS                LOB             L1+PASS        L1+R1+LOB (*)      R1+PASS
 *        THROUGH                       THROUGH             L1+THROUGH      L1 tap (run)*  -                  -
 *        SHOOT                         SHOOT               L1+SHOOT        R1+SHOOT       SHOOT then PASS    L1+R1+SHOOT
 *        SPRINT & SKILL                hold R2, tap skill  skillUp         KNOCK_ON       HARD_STOP          skillRight
 *        double tap: PASS,PASS / THROUGH,THROUGH.  (*) only with our side on the ball or our pass in flight (else
 *        SIM-16 reads the L1 press as a switch): otherwise the swipe does nothing.
 *        (*) PASS swipe left by a controlled player inside the crossing zone (geometry.inCrossingZone, ATTACK mode at
 *        touch-down) = ground cross: two LOB taps (LOB one tick, released one tick, LOB one tick: SIM-15 reads LOB,LOB
 *        and converts the first lob's wind-up into GROUND_CROSS; no explicit power, which would end the first kick's
 *        charge and with it the conversion). Outside the zone it stays L1+R1+LOB (driven lob). PASS swipe right in the
 *        zone stays R1+PASS: SIM-15 zoneKind resolves it to the low cross there.
 *        keeper (KEEPER): PASS -> PASS, THROUGH -> R1+PASS, SHOOT -> SHOOT, SPRINT & SKILL -> THROUGH (held while down).
 *        defence: SPRINT & TACKLE tap -> SHOOT, hold -> R2 (from touch-down), swipe left -> R1+SHOOT; SLIDE -> LOB
 *        (CLEAR -> SHOOT, as at touch-down); SWITCH tap -> L1, any swipe -> RS_FLICK with ax / az = the swipe in pitch
 *        space; 2ND DEF tap / hold -> R1, swipe down -> THROUGH held (keeper rush).
 *     A press keeps the meaning it had at touch-down (event mode). CANCEL = release without action: a press that has
 *     not reached the sim is dropped, one that has is released at once. When the sim's context family (attack /
 *     defence, simFamily) changes while presses are down or in flight, they keep their old meaning (voidStale, QF-3
 *     QA-23): unsent actions are dropped, held bits that mean something else held in the new family are released
 *     (THROUGH held in defence rushes the keeper out, PASS contains, R1 is the second defender / a combo modifier),
 *     and the presses commit nothing more. Defending a free kick, SPRINT and THROUGH never go out (the sim reads them
 *     as move the wall / wall jump; touch has no wall controls). Two presses of the same bit are always
 *     separated by one released tick so the sim sees both edges; edges (skill, flick, explicit power) are one per tick.
 *  4. Pitch gestures -> frame gesture fields, one per tick: target = tap point / swipe end projected with
 *     CameraProjector.screenToPitch (gx / gz decimetres), gSlot = the player nearest the target within
 *     LOCAL_TUNING.gestureSlotRadius (teammates incl. the own keeper, or the opposing carrier; measured on the ground
 *     and against the player's body on screen), gdx / gdz = swipe direction in pitch space, gPower = swipe speed,
 *     gCurve, gFlags (FROM_BALL, ON_GOAL = target on the opposition goal mouth, ON_OWN_KEEPER). Rules switched off in
 *     TouchSettings.gestureEnabled are dropped here (in open play, where only match context tells them apart).
 *     During cut-scenes (HIDDEN) any touch (button, stick, pitch, noteTouchDown) sends SKIP instead.
 *  5. PAUSE is handled by the touch source (index.ts) at the lift; its queue events are ignored here.
 *  6. TouchIntentState.power / powerButton for the overlay: the sim's ctrl[human].power and the touch button that
 *     pressed the charging bit (0 / -1 when nothing charges: no stuck power bar).
 * The event queues are drained every sample. No allocation per sample: all state lives in preallocated typed arrays.
 */

import { HALF_LENGTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, NUM_SLOTS, TICK_HZ, WORLD_MAX_X, WORLD_MAX_Z, slotTeam } from '../../contracts/constants';
import { GestureKind, MatchPhase, SkillMove } from '../../contracts/enums';
import {
  AXIS_SCALE, Btn, clearInputFrame, GESTURE_POS_SCALE, GestureFlag, quantUnit, UNIT_SCALE, type CameraProjector, type InputFrame,
  type InputSampleContext,
} from '../../contracts/input';
import type { TouchSettings } from '../../contracts/settings';
import type { SimState } from '../../contracts/state';
import {
  ClusterMode, SwipeDir, TOUCH_BUTTON_COUNT, TouchButtonId, TouchEdge, type TouchButtonEvent, type TouchGestureEvent,
  type TouchIntentState,
} from '../../contracts/touch';
import { T_INPUT, T_TOUCH_MAPPER, T_TOUCHUI } from '../../contracts/tuning';
import { Ctx, controlContext, ourPassInFlight, LOCAL_TUNING as RESOLVE_TUNING } from '../../sim/control/resolveShared';
import { inCrossingZone } from '../../sim/pitch/geometry';
import { writeAimAxes } from '../axes';
import { TAP_MS } from './button';
import { clearanceOn, clusterModeFor, controlledSlot } from './cluster';
import { GestureRule, isGestureRuleOn, type GestureSettings } from './gestures';

/** Mapper constants: contracts/tuning.ts T_TOUCH_MAPPER ([TUN-2]; the old name is kept for importers). */
export const LOCAL_TUNING = T_TOUCH_MAPPER;

/** Sim tick length, ms. */
const TICK_MS = 1000 / TICK_HZ;
/** Longest press (ticks) the sim still reads as a tap. */
const TAP_TICKS_MAX = T_INPUT.tapTicks - 1;
/** The second tap of a double tap is committed at touch-down when it lands this soon after the first lift, ms. */
export const DOUBLE_TAP_COMMIT_MS = Math.min(T_TOUCHUI.doubleTapMs, (T_INPUT.doubleTapTicks - 1) * TICK_MS);

/** The four face bits (Cross, Circle, Square, Triangle positions). */
const FACE_BITS = Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH;
/** Bits whose HELD meaning in defence differs from attack (contain, keeper rush, second defender). */
const HOLD_MEANS_DEFENCE = Btn.PASS | Btn.THROUGH | Btn.MOD_R;
/** Bits whose HELD meaning in attack differs from defence (strafe, controlled sprint / combo modifiers). */
const HOLD_MEANS_ATTACK = Btn.MOD_L | Btn.MOD_R;

/** InputFrame bit for each touch button in the attack cluster (0 = no direct bit). Indexed by TouchButtonId. */
export const TOUCH_HOLD_BITS: readonly number[] = [
  /* PASS */ Btn.PASS,
  /* THROUGH */ Btn.THROUGH,
  /* SHOOT */ Btn.SHOOT,
  /* SPRINT_SKILL */ Btn.SPRINT,
  /* SPRINT_TACKLE */ Btn.SPRINT,
  /* SLIDE */ Btn.LOB,
  /* SWITCH */ Btn.MOD_L,
  /* SECOND_DEF */ Btn.MOD_R,
  /* PAUSE */ 0,
];

/** Buttons whose touch-down the Wave 0 baseline latched (kept for latchedDownMask). */
const LATCH_MASK = (1 << TouchButtonId.PASS) | (1 << TouchButtonId.THROUGH) | (1 << TouchButtonId.SHOOT)
  | (1 << TouchButtonId.SLIDE) | (1 << TouchButtonId.SWITCH) | (1 << TouchButtonId.SECOND_DEF);

/** Btn bits for a held-button mask (bit = TouchButtonId), plain hold meanings. Pure. */
export function heldToButtons(held: number): number {
  let bits = 0;
  for (let i = 0; i < TOUCH_HOLD_BITS.length; i++) if (held & (1 << i)) bits |= TOUCH_HOLD_BITS[i]!;
  return bits;
}

/**
 * Latched presses in a button event queue, as a mask over TouchButtonId (LATCH_MASK buttons): a DOWN arms its button,
 * an UP commits the armed press, a CANCEL disarms it; a press still armed at the end is committed. Pure; no
 * allocation. (Wave 0 helper, kept for its tests; the mapper now resolves presses per section 9 cell.)
 */
export function latchedDownMask(events: readonly TouchButtonEvent[], count: number): number {
  let armed = 0;
  let latched = 0;
  for (let i = 0; i < count; i++) {
    const e = events[i]!;
    const bit = 1 << e.button;
    if ((LATCH_MASK & bit) === 0) continue;
    if (e.edge === TouchEdge.DOWN) armed |= bit;
    else if (e.edge === TouchEdge.UP) { latched |= armed & bit; armed &= ~bit; }
    else if (e.edge === TouchEdge.CANCEL) armed &= ~bit;
  }
  return latched | armed;
}

// ============================================================ section 9 tables (pure data)

/** What a button swipe does. */
export const SwipeCell = {
  /** Empty cell: the press does nothing. */
  NONE: 0,
  /** A kick combo with power: flick = explicit power, held = power bar. */
  POWER: 1,
  /** A one-tick press (trigger run, hard tackle). */
  PULSE: 2,
  /** Fake shot: SHOOT, then PASS on the next tick (SIM-15: PASS during the shot wind-up). */
  FAKE: 3,
  /** Skill move edge (frame.skill). */
  SKILL: 4,
  /** Directional switch: RS_FLICK with ax / az. */
  FLICK: 5,
  /** Held while the finger is down (keeper rush). */
  HOLD: 6,
  /** Two one-tick presses of the bits with one released tick between them (a double tap: LOB,LOB ground cross). */
  DOUBLE: 7,
} as const;
export type SwipeCell = (typeof SwipeCell)[keyof typeof SwipeCell];

/** Swipe row of a button: [cell, bits] per SwipeDir (NONE, UP, DOWN, LEFT, RIGHT). */
type SwipeRow = readonly (readonly [SwipeCell, number])[];
const NO: readonly [SwipeCell, number] = [SwipeCell.NONE, 0];

/** Attack table swipe cells (ATTACK / SET_PIECE), indexed by TouchButtonId then SwipeDir; null = no swipes. */
export const ATTACK_SWIPES: readonly (SwipeRow | null)[] = [
  /* PASS */ [NO, [SwipeCell.POWER, Btn.LOB], [SwipeCell.POWER, Btn.MOD_L | Btn.PASS],
    [SwipeCell.POWER, Btn.MOD_L | Btn.MOD_R | Btn.LOB], [SwipeCell.POWER, Btn.MOD_R | Btn.PASS]],
  /* THROUGH */ [NO, [SwipeCell.POWER, Btn.MOD_L | Btn.THROUGH], [SwipeCell.PULSE, Btn.MOD_L], NO, NO],
  /* SHOOT */ [NO, [SwipeCell.POWER, Btn.MOD_L | Btn.SHOOT], [SwipeCell.POWER, Btn.MOD_R | Btn.SHOOT],
    [SwipeCell.FAKE, Btn.SHOOT], [SwipeCell.POWER, Btn.MOD_L | Btn.MOD_R | Btn.SHOOT]],
  /* SPRINT_SKILL (bits = SkillMove; 0 = the settings slot) */ [NO, [SwipeCell.SKILL, 0], [SwipeCell.SKILL, SkillMove.KNOCK_ON],
    [SwipeCell.SKILL, SkillMove.HARD_STOP], [SwipeCell.SKILL, 0]],
  null, null, null, null, null,
];

/** PASS swipe left inside the crossing zone (ATTACK mode): LOB,LOB = ground cross (lead decision on SIM-15's CR). */
export const PASS_LEFT_ZONE_CELL: readonly [SwipeCell, number] = [SwipeCell.DOUBLE, Btn.LOB];

/**
 * Attack-table cell of a swipe on button `id` (ATTACK / SET_PIECE); `crossZone` = the press is an ATTACK-mode press by
 * a controlled player inside the crossing zone (only PASS swipe left changes there). Pure.
 */
export function attackSwipeCell(id: TouchButtonId, dir: SwipeDir, crossZone: boolean): readonly [SwipeCell, number] {
  if (crossZone && id === TouchButtonId.PASS && dir === SwipeDir.LEFT) return PASS_LEFT_ZONE_CELL;
  const row = ATTACK_SWIPES[id];
  return (row && row[dir]) || NO;
}

/** Defence table swipe cells, indexed by TouchButtonId then SwipeDir; null = no swipes. */
export const DEFENCE_SWIPES: readonly (SwipeRow | null)[] = [
  null, null, null, null,
  /* SPRINT_TACKLE */ [NO, NO, NO, [SwipeCell.PULSE, Btn.MOD_R | Btn.SHOOT], NO],
  /* SLIDE */ null,
  /* SWITCH */ [NO, [SwipeCell.FLICK, Btn.RS_FLICK], [SwipeCell.FLICK, Btn.RS_FLICK], [SwipeCell.FLICK, Btn.RS_FLICK],
    [SwipeCell.FLICK, Btn.RS_FLICK]],
  /* SECOND_DEF */ [NO, NO, [SwipeCell.HOLD, Btn.THROUGH], NO, NO],
  null,
];

/** Tap / hold bits of each button in the attack table (SPRINT & SKILL: hold only). Indexed by TouchButtonId. */
export const ATTACK_PRESS_BITS: readonly number[] = [Btn.PASS, Btn.THROUGH, Btn.SHOOT, Btn.SPRINT, 0, 0, 0, 0, 0];

/** Keeper-with-the-ball row (section 9): PASS throw, THROUGH driven throw, SHOOT drop kick, SPRINT & SKILL drop. */
export const KEEPER_PRESS_BITS: readonly number[] = [Btn.PASS, Btn.MOD_R | Btn.PASS, Btn.SHOOT, Btn.THROUGH, 0, 0, 0, 0, 0];

/** Defence tap bits (SPRINT & TACKLE tackle, SLIDE slide, SWITCH change player, 2ND DEF second defender). */
export const DEFENCE_TAP_BITS: readonly number[] = [0, 0, 0, 0, Btn.SHOOT, Btn.LOB, Btn.MOD_L, Btn.MOD_R, 0];

/** Defence hold bits (SPRINT & TACKLE sprint / press, 2ND DEF keep him pressing). */
export const DEFENCE_HOLD_BITS: readonly number[] = [0, 0, 0, 0, Btn.SPRINT, Btn.LOB, 0, Btn.MOD_R, 0];

/** How a button behaves (per press, from its id and its mode at touch-down). */
const Row = {
  NONE: 0,
  /** Known at touch-down: held while the finger is down (keeper row, SLIDE / CLEAR). */
  IMMEDIATE: 1,
  /** PASS / THROUGH / SHOOT in the attack table: tap, hold, swipe, double tap. */
  KICK: 2,
  /** SPRINT & SKILL: hold sprint, tap / swipe skill. */
  SPRINT_SKILL: 3,
  /** SPRINT & TACKLE: sprint from touch-down, tap tackle, swipe left hard tackle. */
  TACKLE: 4,
  /** SWITCH: tap change player, swipe directional switch. */
  SWITCH: 5,
  /** 2ND DEF: tap / hold second defender, swipe down keeper rush. */
  SECOND_DEF: 6,
} as const;

function rowOf(id: number, mode: number): number {
  switch (id) {
    case TouchButtonId.PASS:
    case TouchButtonId.THROUGH:
    case TouchButtonId.SHOOT:
      return mode === ClusterMode.KEEPER ? Row.IMMEDIATE : Row.KICK;
    case TouchButtonId.SPRINT_SKILL:
      return mode === ClusterMode.KEEPER ? Row.IMMEDIATE : Row.SPRINT_SKILL;
    case TouchButtonId.SPRINT_TACKLE: return Row.TACKLE;
    case TouchButtonId.SLIDE: return Row.IMMEDIATE;
    case TouchButtonId.SWITCH: return Row.SWITCH;
    case TouchButtonId.SECOND_DEF: return Row.SECOND_DEF;
    default: return Row.NONE;
  }
}

/** Bits of a press known at touch-down (keeper row; SLIDE, or SHOOT when it went down as CLEAR). Pure. */
export function immediateBits(id: TouchButtonId, mode: ClusterMode, clear: boolean): number {
  if (id === TouchButtonId.SLIDE) return clear ? Btn.SHOOT : Btn.LOB;
  return mode === ClusterMode.KEEPER ? KEEPER_PRESS_BITS[id] ?? 0 : 0;
}

/** Press length (ticks) the sim sees for a tap that lasted durMs: as long as the finger was down, still a tap. Pure. */
export function tapPulseTicks(durMs: number): number {
  const t = Math.floor((Number.isFinite(durMs) ? durMs : 0) / TICK_MS);
  return t < 1 ? 1 : t > TAP_TICKS_MAX ? TAP_TICKS_MAX : t;
}

/** Ticks for a press that was held durMs (at least one). Pure. */
function heldTicks(durMs: number): number {
  const t = Math.floor((Number.isFinite(durMs) ? durMs : 0) / TICK_MS);
  return t < 1 ? 1 : t;
}

/** Skill of a SPRINT & SKILL swipe (settings slots for up / right; KNOCK_ON down; HARD_STOP left). Pure. */
export function skillForSwipe(dir: SwipeDir, touch: Readonly<Pick<TouchSettings, 'skillUp' | 'skillRight'>> | null | undefined): SkillMove {
  switch (dir) {
    case SwipeDir.UP: return validSkill(touch?.skillUp, SkillMove.ROULETTE);
    case SwipeDir.RIGHT: return validSkill(touch?.skillRight, SkillMove.HEEL_FLICK);
    case SwipeDir.DOWN: return SkillMove.KNOCK_ON;
    case SwipeDir.LEFT: return SkillMove.HARD_STOP;
    default: return SkillMove.NONE;
  }
}

function validSkill(v: SkillMove | undefined, dflt: SkillMove): SkillMove {
  return typeof v === 'number' && v > SkillMove.NONE && v <= SkillMove.HARD_STOP && v === Math.floor(v) ? v : dflt;
}

// ============================================================ the mapper

export interface TouchMapperOptions {
  /** Live touch settings (skill slots, gesture rules). Default: section 9 defaults. */
  settings?(): Readonly<TouchSettings> | null | undefined;
  /**
   * Clock in the pointer events' time base (ms; the touch source passes the pointer manager's). Used for the flick
   * window of power swipes. Default: estimated from the latest event time plus one tick per sample.
   */
  now?(): number;
  /** Exact screen-space unit vector of a recognised swipe (TCH-04 DefenceCluster.swipeAim), matched by button + tMs. */
  swipeAim?(id: TouchButtonId): Readonly<{ button: number; dx: number; dy: number; tMs: number }> | null;
  /**
   * The current (or last) SLIDE press went down while CLEAR replaced SLIDE (TCH-04 DefenceCluster.slideClear), read
   * for each SLIDE touch-down drained. Default: TouchIntentState.clearOn as it was when the touch landed.
   */
  slideClear?(): boolean;
}

export interface TouchMapper {
  /** Fill `out` for the coming tick from the intent state; drains the event queues. No allocation. */
  sample(out: InputFrame, ctx: InputSampleContext): void;
  /** Forget every press, scheduled press, gesture and timer (releaseAll): the next sample sends nothing held. */
  reset(): void;
  /** A finger touched the screen anywhere (pointer manager onDown): during cut-scenes the next tick sends SKIP. */
  noteTouchDown(): void;
}

/** Press states per button. */
const P_IDLE = 0;
/** Down, not classified yet (tap / hold / swipe). */
const P_PENDING = 1;
/** Power swipe recognised, waiting to see whether the finger lifts (flick) or stays (hold). */
const P_SWIPED = 2;
/** Classified: its action is scheduled (and possibly held until the lift). */
const P_ACTIVE = 3;
/** Voided: the sim context family changed while the finger was down; nothing more until it lifts (QF-3 QA-23). */
const P_VOID = 4;

/** Sim context families (what the sim makes of held buttons): unknown / attack (incl. keeper, own set piece) / defence. */
const FAM_NONE = -1;
const FAM_ATTACK = 0;
const FAM_DEFENCE = 1;

/** Action pool size (held presses + pulses + edges in flight). */
const POOL = 32;
/** Gestures waiting for their tick. */
const GQ = 8;
/** Owner id of SKIP pulses. */
const SKIP_OWNER = -1;
const OPEN = Infinity;

const DEFAULT_SKILL_TAP = SkillMove.STEP_OVER;

export function createTouchMapper(state: TouchIntentState, opts: TouchMapperOptions = {}): TouchMapper {
  const st = state;
  const B = TOUCH_BUTTON_COUNT;

  // ---- press records, indexed by TouchButtonId
  const pState = new Uint8Array(B);
  const pMode = new Uint8Array(B);
  const pClear = new Uint8Array(B);
  const pDownMs = new Float64Array(B);
  const pSwipeMs = new Float64Array(B);
  const pSwipeBits = new Int32Array(B);
  const pSwipePower = new Int32Array(B);
  /** Open (held) action of the press: pool index and generation (-1 = none). */
  const pAct = new Int32Array(B).fill(-1);
  const pActGen = new Int32Array(B);
  /** 1 = the last UP ended a known press (its TAP / DOUBLE_TAP is redundant); 2 = an UP without a press (lost DOWN). */
  const pAfterUp = new Uint8Array(B);
  /** Last committed tap of a KICK row (for the double tap): lift time, mode, valid. */
  const tapUpMs = new Float64Array(B);
  const tapMode = new Uint8Array(B);
  const tapValid = new Uint8Array(B);
  /** Sim context family of the press at its touch-down (FAM_*), followed while its meaning stays the same. */
  const pFam = new Int8Array(B);
  /** SPRINT rows whose context family changed while down: the sprint hold stays, the tap / swipe meaning is void. */
  const pNoTap = new Uint8Array(B);

  // ---- action pool (sample-indexed timeline)
  const aUsed = new Uint8Array(POOL);
  const aGen = new Int32Array(POOL);
  const aOwner = new Int8Array(POOL);
  const aBits = new Int32Array(POOL);
  const aStart = new Float64Array(POOL);
  const aEnd = new Float64Array(POOL);
  const aCommitMs = new Float64Array(POOL);
  const aPower = new Int32Array(POOL);
  const aSkill = new Int32Array(POOL);
  const aFlick = new Uint8Array(POOL);
  const aAx = new Int32Array(POOL);
  const aAz = new Int32Array(POOL);
  /** Sim context family of the press each action belongs to (FAM_*; FAM_NONE = not a button press: SKIP). */
  const aFam = new Int8Array(POOL);
  let gen = 0;

  // ---- gesture FIFO (pitch-space, ready for the frame)
  const gKind = new Int32Array(GQ);
  const gX = new Int32Array(GQ);
  const gZ = new Int32Array(GQ);
  const gSlotQ = new Int32Array(GQ);
  const gDx = new Int32Array(GQ);
  const gDz = new Int32Array(GQ);
  const gPow = new Int32Array(GQ);
  const gCur = new Int32Array(GQ);
  const gFl = new Int32Array(GQ);
  let gHead = 0;
  let gCount = 0;

  // ---- sample state
  /** Samples taken (the action timeline's clock). */
  let n = 0;
  /** Bits sent on the previous sample. */
  let lastOut = 0;
  /** Touch button that last pressed each Btn bit (power bar owner), -1 = none. */
  const bitSource = new Int8Array(11).fill(-1);
  let lastPowerButton = -1;
  let strafeTicks = 0;
  /** Consecutive samples the stick strafe has sent MOD_L (0 = not sending). */
  let strafeOn = 0;
  /** A face press went out during this strafe hold: no MOD_L until the stick lifts (QF-3 FIX-06). */
  let strafeSpent = false;
  /** Last stick axes the strafe sent (held through its MOD_L minimum after the stick ends, QF-3 QA-23). */
  let strafeMx = 0;
  let strafeMz = 0;
  /** Sim context family this sample (FAM_*), and consecutive samples a loose ball has read as ours (simFamily). */
  let curFam = FAM_NONE;
  let looseAttackN = 0;
  let prevStick = false;
  let touchDown = false;
  let modeInit = false;
  let modeCand = -1;
  let modeCandSince = 0;
  /** Latest event time seen and the sample it was seen at (estimated clock). */
  const T = { lastMs: 0.5, lastN: 0.5, now: 0.5 };
  T.lastMs = 0; T.lastN = 0; T.now = 0;

  // ---- scratch
  const P0 = { x: 0.5, z: 0.5 };
  const P1 = { x: 0.5, z: 0.5 };
  const S0 = { x: 0.5, y: 0.5 };
  const S1 = { x: 0.5, y: 0.5 };
  const AIM = { ax: 0, az: 0 };
  const G = { kind: 0, gx: 0, gz: 0, gSlot: -1, gdx: 0, gdz: 0, gPower: 0, gCurve: 0, gFlags: 0 };
  const SC = { x: 0.5, y: 0.5 };
  /** Gesture target: ground point (m) and screen point (px). */
  const TG = { x: 0.5, z: 0.5, sx: 0.5, sy: 0.5 };
  /** Distance results (m). */
  const R = { d: 0.5, best: 0.5 };
  /** Swipe direction / speed work values. */
  const W = { dx: 0.5, dz: 0.5, m: 0.5, v: 0.5 };
  const QUAD_X = new Float64Array(4);
  const QUAD_Y = new Float64Array(4);
  const aimFrame = { ax: 0, az: 0 } as unknown as InputFrame;

  const settingsOf = (): Readonly<TouchSettings> | null => (opts.settings ? opts.settings() ?? null : null);

  // ================================================================ action pool

  function freeAction(i: number): void {
    aUsed[i] = 0;
  }

  /**
   * Schedule `bits` (+ first-tick payloads) for `ticks` samples (0 = open: until closed) starting at this sample +
   * delay. Same-owner presses of the same bits are cut to leave one released tick; a bit sent on the previous sample
   * by anyone delays the start one tick (the sim needs an edge); one power / skill / flick per tick. Returns the pool
   * index or -1 when full.
   */
  function schedule(owner: number, bits: number, ticks: number, commitMs: number, delay: number, power: number, skill: number, flick: number, ax: number, az: number): number {
    let start = n + delay;
    if (bits !== 0) {
      for (let i = 0; i < POOL; i++) {
        if (aUsed[i] === 0 || aOwner[i] !== owner || (aBits[i]! & bits) === 0 || !(aEnd[i]! > n)) continue;
        const keep = aStart[i]! + 1 > n ? aStart[i]! + 1 : n;
        if (aEnd[i]! > keep) aEnd[i] = keep;
        if (start < aEnd[i]! + 1) start = aEnd[i]! + 1;
      }
      if ((lastOut & bits) !== 0 && start < n + 1) start = n + 1;
      // Another button's timed press of the same bit still to come or running: go after it (an open hold of another
      // button cannot be waited for; the presses merge).
      for (let pass = 0; pass < POOL; pass++) {
        let moved = false;
        for (let i = 0; i < POOL; i++) {
          if (aUsed[i] === 0 || aOwner[i] === owner || (aBits[i]! & bits) === 0) continue;
          const end = aEnd[i]!;
          if (end === OPEN || !(end >= start) || !(end > n)) continue;
          start = end + 1;
          moved = true;
        }
        if (!moved) break;
      }
    }
    if (power !== 0 || skill !== 0 || flick !== 0) {
      for (let guard = 0; guard < POOL; guard++) {
        let clash = false;
        for (let i = 0; i < POOL; i++) {
          if (aUsed[i] === 0 || aStart[i] !== start) continue;
          if ((power !== 0 && aPower[i] !== 0) || (skill !== 0 && aSkill[i] !== 0) || (flick !== 0 && aFlick[i] !== 0)) { clash = true; break; }
        }
        if (!clash) break;
        start++;
      }
    }
    let slot = -1;
    for (let i = 0; i < POOL; i++) if (aUsed[i] === 0) { slot = i; break; }
    if (slot < 0) return -1;
    gen++;
    aUsed[slot] = 1;
    aGen[slot] = gen;
    aOwner[slot] = owner;
    aBits[slot] = bits;
    aStart[slot] = start;
    aEnd[slot] = ticks > 0 ? start + ticks : OPEN;
    aCommitMs[slot] = commitMs;
    aPower[slot] = power;
    aSkill[slot] = skill;
    aFlick[slot] = flick;
    aAx[slot] = ax;
    aAz[slot] = az;
    aFam[slot] = owner >= 0 && owner < B ? pFam[owner]! : FAM_NONE;
    return slot;
  }

  function pulse(owner: number, bits: number, ticks: number, commitMs: number, delay: number): void {
    schedule(owner, bits, ticks, commitMs, delay, 0, 0, 0, 0, 0);
  }

  /** Open (held) action for the press on button b. */
  function openHold(b: number, bits: number, commitMs: number): void {
    closeHold(b, commitMs, false);
    const i = schedule(b, bits, 0, commitMs, 0, 0, 0, 0, 0, 0);
    if (i >= 0) {
      pAct[b] = i;
      pActGen[b] = aGen[i]!;
    }
  }

  /**
   * End the press's open action: one that has reached the sim stops now; one that has not is dropped when `drop`
   * (cancel, a tap that means something else) or else keeps the length the finger was down since it was committed.
   */
  function closeHold(b: number, upMs: number, drop: boolean): void {
    const i = pAct[b]!;
    pAct[b] = -1;
    if (i < 0 || aUsed[i] === 0 || aGen[i] !== pActGen[b]) return;
    if (aStart[i]! < n) {
      if (aEnd[i]! > n) aEnd[i] = n;
    } else if (drop) {
      freeAction(i);
    } else {
      aEnd[i] = aStart[i]! + heldTicks(upMs - aCommitMs[i]!);
    }
  }

  function hasHold(b: number): boolean {
    const i = pAct[b]!;
    return i >= 0 && aUsed[i] === 1 && aGen[i] === pActGen[b];
  }

  // ================================================================ press handling

  function stickPushed(): boolean {
    if (!st.stickActive) return false;
    const x = st.stickX, y = st.stickY;
    return x * x + y * y > T_INPUT.stickIdle * T_INPUT.stickIdle;
  }

  function flickPowerOf(b: number): number {
    return quantUnit(b === TouchButtonId.SHOOT ? LOCAL_TUNING.flickShotPower : LOCAL_TUNING.flickPassPower);
  }

  /** A tap on button b (the press lasted durMs) by its row. */
  function commitTap(b: number, mode: number, durMs: number, tMs: number): void {
    switch (rowOf(b, mode)) {
      case Row.KICK:
        pulse(b, ATTACK_PRESS_BITS[b]!, tapPulseTicks(durMs), tMs, 0);
        break;
      case Row.SPRINT_SKILL: {
        if (pNoTap[b] === 1) { closeHold(b, tMs, false); break; }
        closeHold(b, tMs, true);
        const t = settingsOf();
        schedule(b, 0, 1, tMs, 0, 0, validSkill(t?.skillTap, DEFAULT_SKILL_TAP), 0, 0, 0);
        break;
      }
      case Row.TACKLE:
        if (pNoTap[b] === 1) { closeHold(b, tMs, false); break; }
        closeHold(b, tMs, true);
        pulse(b, Btn.SHOOT, tapPulseTicks(durMs), tMs, 0);
        break;
      case Row.SWITCH:
        pulse(b, Btn.MOD_L, tapPulseTicks(durMs), tMs, 0);
        break;
      case Row.SECOND_DEF:
        closeHold(b, tMs, false);
        pulse(b, Btn.MOD_R, tapPulseTicks(durMs), tMs, 0);
        break;
      case Row.IMMEDIATE:
        pulse(b, immediateBits(b as TouchButtonId, mode as ClusterMode, pClear[b] === 1), tapPulseTicks(durMs), tMs, 0);
        break;
      default:
        break;
    }
  }

  function onDown(b: number, mode: number, tMs: number, prevClear: boolean, hiddenNow: boolean): void {
    // A press whose lift was lost: end it first (release without action).
    if (pState[b] !== P_IDLE) closeHold(b, tMs, true);
    pState[b] = P_PENDING;
    pMode[b] = mode;
    pDownMs[b] = tMs;
    pFam[b] = curFam;
    pNoTap[b] = 0;
    pClear[b] = b === TouchButtonId.SLIDE && (opts.slideClear ? opts.slideClear() : prevClear) ? 1 : 0;
    pAfterUp[b] = 0;
    if (mode === ClusterMode.HIDDEN || hiddenNow) {
      pState[b] = P_ACTIVE; // cut-scene: the touch only skips
      return;
    }
    switch (rowOf(b, mode)) {
      case Row.IMMEDIATE:
        openHold(b, immediateBits(b as TouchButtonId, mode as ClusterMode, pClear[b] === 1), tMs);
        pState[b] = P_ACTIVE;
        break;
      case Row.TACKLE:
        openHold(b, Btn.SPRINT, tMs);
        break;
      case Row.SPRINT_SKILL:
        if (stickPushed()) openHold(b, Btn.SPRINT, tMs);
        break;
      case Row.KICK:
        // Second tap of a double tap: press at once so the sim sees PASS,PASS inside its window.
        if (mode === ClusterMode.ATTACK && tapValid[b] === 1 && tapMode[b] === mode &&
            (b === TouchButtonId.PASS || b === TouchButtonId.THROUGH) && tMs - tapUpMs[b]! <= DOUBLE_TAP_COMMIT_MS && tMs >= tapUpMs[b]!) {
          tapValid[b] = 0;
          openHold(b, ATTACK_PRESS_BITS[b]!, tMs);
          pState[b] = P_ACTIVE;
        }
        break;
      default:
        break;
    }
  }

  function onHold(b: number, tMs: number): void {
    if (pState[b] !== P_PENDING) return;
    const mode = pMode[b]!;
    switch (rowOf(b, mode)) {
      case Row.KICK:
        tapValid[b] = 0;
        openHold(b, ATTACK_PRESS_BITS[b]!, tMs);
        pState[b] = P_ACTIVE;
        break;
      case Row.SPRINT_SKILL:
        if (!hasHold(b)) openHold(b, Btn.SPRINT, tMs);
        pState[b] = P_ACTIVE;
        break;
      case Row.TACKLE:
        pState[b] = P_ACTIVE;
        break;
      case Row.SECOND_DEF:
        openHold(b, Btn.MOD_R, tMs);
        pState[b] = P_ACTIVE;
        break;
      default:
        break; // SWITCH: a swipe or the lift still decides
    }
  }

  /** The controlled player is inside the crossing zone of the goal he attacks (PASS swipe left = ground cross). */
  function inCrossZone(ctx: InputSampleContext): boolean {
    const s = ctx.state;
    if (!s) return false;
    const slot = controlledSlot(s, ctx.side, ctx.human);
    if (slot < 0) return false;
    const p = s.players[slot]!;
    const team = s.teams[p.team];
    return p.active === 1 && !!team && inCrossingZone(p.x, p.z, team.dir);
  }

  function onSwipe(b: number, dir: SwipeDir, tMs: number, ctx: InputSampleContext): void {
    const ps = pState[b]!;
    if (ps === P_IDLE || ps === P_SWIPED || ps === P_VOID) return;
    const mode = pMode[b]!;
    const row = rowOf(b, mode);
    if (pNoTap[b] === 1) { pState[b] = P_ACTIVE; return; } // a SPRINT row across a context change: sprint only
    if (dir < SwipeDir.UP || dir > SwipeDir.RIGHT) return;
    switch (row) {
      case Row.KICK: {
        if (ps !== P_PENDING) return; // already pressed (hold / second tap): the kick has started
        tapValid[b] = 0;
        const zone = mode === ClusterMode.ATTACK && b === TouchButtonId.PASS && dir === SwipeDir.LEFT && inCrossZone(ctx);
        const cell = attackSwipeCell(b as TouchButtonId, dir, zone);
        pState[b] = P_ACTIVE;
        if (cell[0] === SwipeCell.POWER) {
          pState[b] = P_SWIPED;
          pSwipeMs[b] = tMs;
          pSwipeBits[b] = cell[1];
          pSwipePower[b] = flickPowerOf(b);
        } else if (cell[0] === SwipeCell.PULSE) {
          // THROUGH swipe down = an L1 tap ("trigger a teammate's run"). Without our side on the ball (a loose ball
          // the cluster already shows as ours) SIM-16 reads that L1 press as "change player" and no run can start,
          // so the swipe does nothing rather than switch away from the player the ball is coming to (QF-3 FIX-06).
          if (cell[1] !== Btn.MOD_L || ownBallOrPass(ctx)) pulse(b, cell[1], 1, tMs, 0);
        } else if (cell[0] === SwipeCell.FAKE) {
          pulse(b, Btn.SHOOT, 1, tMs, 0);
          pulse(b, Btn.PASS, 1, tMs, 1);
        } else if (cell[0] === SwipeCell.DOUBLE) {
          // schedule() leaves exactly one released tick between two same-owner presses of a bit: down, up, down.
          pulse(b, cell[1], 1, tMs, 0);
          pulse(b, cell[1], 1, tMs, 0);
        }
        return;
      }
      case Row.SPRINT_SKILL: {
        if (ps === P_ACTIVE && !hasHold(b)) return;
        pState[b] = P_ACTIVE;
        schedule(b, 0, 1, tMs, 0, 0, skillForSwipe(dir, settingsOf()), 0, 0, 0);
        return;
      }
      case Row.TACKLE: {
        pState[b] = P_ACTIVE;
        if (dir === SwipeDir.LEFT) pulse(b, Btn.MOD_R | Btn.SHOOT, 1, tMs, 0);
        return;
      }
      case Row.SWITCH: {
        if (ps !== P_PENDING) return;
        pState[b] = P_ACTIVE;
        swipeAimInto(b, dir, tMs, ctx.projector);
        schedule(b, Btn.RS_FLICK, 1, tMs, 0, 0, 0, 1, AIM.ax, AIM.az);
        return;
      }
      case Row.SECOND_DEF: {
        if (dir === SwipeDir.DOWN) {
          closeHold(b, tMs, false);
          openHold(b, Btn.THROUGH, tMs);
          pState[b] = P_ACTIVE;
        } else if (ps === P_PENDING) {
          pState[b] = P_ACTIVE;
        }
        return;
      }
      default:
        return;
    }
  }

  /** Pitch-space aim (AIM.ax / az, -127..127) of a swipe on b: the exact vector when known, else its direction. */
  function swipeAimInto(b: number, dir: SwipeDir, tMs: number, projector: CameraProjector | null): void {
    let dx = dir === SwipeDir.RIGHT ? 1 : dir === SwipeDir.LEFT ? -1 : 0;
    let dy = dir === SwipeDir.DOWN ? 1 : dir === SwipeDir.UP ? -1 : 0;
    const aim = opts.swipeAim ? opts.swipeAim(b as TouchButtonId) : null;
    if (aim && aim.button === b && aim.tMs === tMs && Number.isFinite(aim.dx) && Number.isFinite(aim.dy) &&
        aim.dx * aim.dx + aim.dy * aim.dy > 1e-6) {
      dx = aim.dx;
      dy = aim.dy;
    }
    const m = Math.sqrt(dx * dx + dy * dy);
    writeAimAxes(aimFrame, dx / m, dy / m, projector);
    AIM.ax = aimFrame.ax;
    AIM.az = aimFrame.az;
  }

  function onUp(b: number, tMs: number): void {
    const ps = pState[b]!;
    if (ps === P_IDLE) {
      pAfterUp[b] = 2;
      return;
    }
    const mode = pMode[b]!;
    const dur = tMs - pDownMs[b]!;
    if (ps === P_PENDING) {
      const tap = dur <= TAP_MS;
      const row = rowOf(b, mode);
      if (tap) {
        commitTap(b, mode, dur, tMs);
        if (row === Row.KICK) {
          tapValid[b] = 1;
          tapUpMs[b] = tMs;
          tapMode[b] = mode;
        }
      } else if (row === Row.KICK) {
        // Its HOLD was lost (queue overflow): a hold of that length.
        pulse(b, ATTACK_PRESS_BITS[b]!, heldTicks(dur), tMs, 0);
      } else if (row === Row.SPRINT_SKILL && !hasHold(b)) {
        pulse(b, Btn.SPRINT, heldTicks(dur), tMs, 0);
      } else if (row === Row.SECOND_DEF) {
        pulse(b, Btn.MOD_R, heldTicks(dur), tMs, 0);
      } else if (row === Row.SWITCH) {
        pulse(b, Btn.MOD_L, 1, tMs, 0);
      }
      closeHold(b, tMs, false);
    } else if (ps === P_VOID) {
      closeHold(b, tMs, false);
    } else if (ps === P_SWIPED) {
      const after = tMs - pSwipeMs[b]!;
      if (after <= LOCAL_TUNING.flickLiftMs) schedule(b, pSwipeBits[b]!, 1, tMs, 0, pSwipePower[b]!, 0, 0, 0, 0);
      else pulse(b, pSwipeBits[b]!, heldTicks(after - LOCAL_TUNING.flickLiftMs), tMs, 0);
    } else {
      closeHold(b, tMs, false);
    }
    pState[b] = P_IDLE;
    pAfterUp[b] = 1;
  }

  function onTapEdge(b: number, mode: number, tMs: number): void {
    if (pAfterUp[b] === 2) commitTap(b, mode, 0, tMs); // its DOWN was lost: a minimal tap
    pAfterUp[b] = 0;
  }

  function onCancel(b: number, tMs: number): void {
    closeHold(b, tMs, true);
    pState[b] = P_IDLE;
    pAfterUp[b] = 0;
    tapValid[b] = 0;
  }

  /** Per-sample timers: power swipes past the flick window hold the combo; SPRINT & SKILL sprints once the stick is pushed. */
  function timers(now: number): void {
    for (let b = 0; b < B; b++) {
      const ps = pState[b]!;
      if (ps === P_SWIPED) {
        if (now - pSwipeMs[b]! > LOCAL_TUNING.flickLiftMs) {
          openHold(b, pSwipeBits[b]!, now);
          pState[b] = P_ACTIVE;
        }
      } else if (ps === P_PENDING && b === TouchButtonId.SPRINT_SKILL && rowOf(b, pMode[b]!) === Row.SPRINT_SKILL &&
          !hasHold(b) && stickPushed()) {
        openHold(b, Btn.SPRINT, now);
      }
    }
  }

  /**
   * What the sim makes of held buttons for this human on the coming tick (FAM_*): in open play SIM-15's context for
   * the controlled player (controlContext: ATTACK / KEEPER -> attack, DEFENCE -> defence, read from the same state the
   * sim resolves the coming tick from); at a restart not yet taken the taking side (and both sides at a penalty or a
   * shoot-out) -> attack, the other side -> defence; cut-scenes, taken restarts and no controlled player -> unknown.
   */
  function simFamily(ctx: InputSampleContext): number {
    const s = ctx.state;
    if (!s) return FAM_NONE;
    const m = s.match;
    const ph = m.phase;
    if (ph !== MatchPhase.IN_PLAY) looseAttackN = 0;
    if (ph === MatchPhase.SHOOT_OUT) return FAM_ATTACK;
    if (ph === MatchPhase.KICK_OFF || ph === MatchPhase.THROW_IN || ph === MatchPhase.GOAL_KICK || ph === MatchPhase.CORNER ||
        ph === MatchPhase.FREE_KICK || ph === MatchPhase.PENALTY) {
      if (m.restart.taken === 1) return FAM_NONE;
      return m.restart.team === ctx.side || ph === MatchPhase.PENALTY ? FAM_ATTACK : FAM_DEFENCE;
    }
    if (ph !== MatchPhase.IN_PLAY) return FAM_NONE;
    const slot = controlledSlot(s, ctx.side, ctx.human);
    if (slot < 0 || s.players[slot]!.active !== 1) return FAM_NONE;
    if (controlContext(s as SimState, slot) === Ctx.DEFENCE) {
      looseAttackN = 0;
      return FAM_DEFENCE;
    }
    // A loose ball read as ours (arriving at him / he is nearer) can waver back: a change toward attack counts once it
    // has lasted LOCAL_TUNING.looseSwapTicks (like the cluster swap); our ball or our pass in flight counts at once.
    // A change toward defence always counts at once (THROUGH held there rushes the keeper out on that very tick).
    if (ownBallOrPass(ctx)) {
      looseAttackN = 0;
      return FAM_ATTACK;
    }
    looseAttackN++;
    return looseAttackN >= LOCAL_TUNING.looseSwapTicks || curFam !== FAM_DEFENCE ? FAM_ATTACK : FAM_DEFENCE;
  }

  /**
   * Section 9: "A thumb already down keeps its old meaning until it lifts." The sim reads every press by its context
   * at that tick, and HELD buttons tick by tick: THROUGH held in defence rushes the keeper out, PASS held contains, R1
   * held calls the second defender; in attack R1 held is a controlled sprint and the driven / finesse modifier of the
   * next face press, L1 held the strafe; a SHOOT press is a shot in attack and a tackle in defence. So when the sim
   * context family changes while touch presses are in flight (QF-3 QA-23):
   *  - a scheduled action not sent yet is dropped (its press would arrive with the other meaning: a TACKLE tap's SHOOT
   *    after the ball was won is a shot, a PASS tap after it was stolen a contain);
   *  - a sent action stops sending the bits that mean something else held in the new family (HOLD_MEANS_*), except a
   *    modifier held on its own, which keeps its edge T_INPUT.tapTicks long first (a shorter one is an L1 / R1 tap =
   *    trigger run, call for support, timed second defender). Bits whose held meaning is the same stay: SPRINT, and
   *    SHOOT / LOB / L1 in defence, so a kick still charging (a first-time shot whose loose-ball context wavers) keeps
   *    its power bar;
   *  - presses still down are voided: their tap / hold / swipe commits nothing more (P_VOID); SPRINT rows keep their
   *    sprint hold (R2 is sprint in both) and only lose their tap / swipe meaning.
   */
  function voidStale(fam: number): void {
    if (fam === FAM_NONE) return;
    const strip = fam === FAM_DEFENCE ? HOLD_MEANS_DEFENCE : HOLD_MEANS_ATTACK;
    for (let i = 0; i < POOL; i++) {
      if (aUsed[i] === 0 || aFam[i] === FAM_NONE || aFam[i] === fam) continue;
      aFam[i] = fam;
      if (aStart[i]! >= n) { freeAction(i); continue; }
      const ab = aBits[i]!;
      if ((ab & strip) === 0) continue;
      if ((ab & FACE_BITS) === 0 && (ab & ~strip & ~(Btn.MOD_L | Btn.MOD_R)) === 0) {
        // A modifier on its own: release it no sooner than a tap's length after its press.
        const minEnd = aStart[i]! + T_INPUT.tapTicks;
        if (aEnd[i]! > minEnd) aEnd[i] = minEnd > n ? minEnd : n;
        else if (aEnd[i]! < minEnd) aEnd[i] = minEnd;
      } else {
        aBits[i] = ab & ~strip;
      }
    }
    for (let b = 0; b < B; b++) {
      if (pState[b] === P_IDLE) continue;
      if (pFam[b] === FAM_NONE) { pFam[b] = fam; continue; }
      if (pFam[b] === fam) continue;
      pFam[b] = fam;
      tapValid[b] = 0;
      const row = rowOf(b, pMode[b]!);
      if (row === Row.SPRINT_SKILL || row === Row.TACKLE) pNoTap[b] = 1;
      else pState[b] = P_VOID;
    }
  }

  /** The human's side defends a free kick not taken yet (the wall is set; RUL-05 defendInput reads R2 / L2 / Y). */
  function defendingFreeKick(ctx: InputSampleContext): boolean {
    const s = ctx.state;
    if (!s) return false;
    const m = s.match;
    return m.phase === MatchPhase.FREE_KICK && m.restart.taken !== 1 && m.restart.team !== ctx.side;
  }

  /** Our side has the ball (owner / keeper's hands) or our pass is in flight: SIM-16's attack context. */
  function ownBallOrPass(ctx: InputSampleContext): boolean {
    const s = ctx.state;
    if (!s) return false;
    const b = s.ball;
    const h = b.heldBy >= 0 ? b.heldBy : b.owner;
    if (h >= 0 && h < NUM_SLOTS) return slotTeam(h) === ctx.side;
    return ourPassInFlight(s as SimState, ctx.side);
  }

  /** A press of only MOD_L (no face bit) is scheduled for a later sample (it needs its own press edge). */
  function pureModLPending(): boolean {
    for (let i = 0; i < POOL; i++) {
      if (aUsed[i] === 0 || aStart[i]! <= n) continue;
      const ab = aBits[i]!;
      if ((ab & Btn.MOD_L) !== 0 && (ab & FACE_BITS) === 0) return true;
    }
    return false;
  }

  /**
   * Does the stick strafe (double-tap and hold, section 9) send MOD_L this sample? `actBits` = the scheduled presses'
   * bits for this sample. MOD_L is the strafe-dribble modifier, but it is also L1 for the sim, so (QF-3 FIX-06):
   *  - it starts once the strafe has lasted strafeDelayTicks, only while our side has the ball or our pass is in
   *    flight (SIM-16 reads a MOD_L press without that as "change player");
   *  - once sent it stays at least T_INPUT.tapTicks samples (a shorter MOD_L is an L1 tap = trigger a run);
   *  - a face press that does not carry MOD_L itself (PASS / SHOOT / THROUGH tap, hold, double tap) releases it on
   *    that very sample and the strafe sends no MOD_L again until the stick lifts: a strafing PASS tap is a ground
   *    pass, never pass and go (L1 + Cross), a SHOOT tap a shot, never a chip (the sim reads combos at the face press;
   *    the face press in the same sample marks the released MOD_L as used, so it is no trigger-run tap either);
   *  - a button's own MOD_L-only press waiting for its edge (THROUGH swipe down) releases it a sample early.
   */
  function strafeMod(ctx: InputSampleContext, strafeHeld: boolean, actBits: number): boolean {
    let on = strafeHeld && !strafeSpent && strafeTicks > LOCAL_TUNING.strafeDelayTicks && (strafeOn > 0 || ownBallOrPass(ctx));
    if (!on && strafeOn > 0 && strafeOn < T_INPUT.tapTicks) on = true;
    if (!on || (actBits & Btn.MOD_L) !== 0) return on;
    if ((actBits & FACE_BITS & ~lastOut) !== 0) {
      if (strafeHeld) strafeSpent = true;
      return false;
    }
    return !pureModLPending();
  }

  /**
   * Stick -> out.mx / out.mz: axes.ts writeMoveAxes (rotate by the camera's stick rotation, clamp the magnitude to 1,
   * round, truncate when rounding pushes past the rim), reading the intent fields directly so no double crosses a call.
   */
  function writeStick(out: InputFrame, projector: CameraProjector | null): void {
    let x = st.stickX, y = st.stickY;
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(y)) y = 0;
    const rot = projector ? projector.stickRotation() : 0;
    if (rot !== 0 && Number.isFinite(rot)) {
      const c = Math.cos(rot), sn = Math.sin(rot);
      const rx = c * x - sn * y;
      y = sn * x + c * y;
      x = rx;
    }
    const m = Math.sqrt(x * x + y * y);
    if (m > 1) { x /= m; y /= m; }
    let qx = Math.round(x * AXIS_SCALE);
    let qy = Math.round(y * AXIS_SCALE);
    if (qx * qx + qy * qy > AXIS_SCALE * AXIS_SCALE) {
      qx = Math.trunc(x * AXIS_SCALE);
      qy = Math.trunc(y * AXIS_SCALE);
    }
    out.mx = qx === 0 ? 0 : qx;
    out.mz = qy === 0 ? 0 : qy;
  }

  // ================================================================ gestures

  function pushGesture(): void {
    if (gCount >= GQ) { gHead = (gHead + 1) % GQ; gCount--; }
    const i = (gHead + gCount) % GQ;
    gKind[i] = G.kind; gX[i] = G.gx; gZ[i] = G.gz; gSlotQ[i] = G.gSlot; gDx[i] = G.gdx; gDz[i] = G.gdz;
    gPow[i] = G.gPower; gCur[i] = G.gCurve; gFl[i] = G.gFlags;
    gCount++;
  }

  /**
   * How far player i is from the target, m, into R.d: the ground point TG.x / TG.z, or (players within
   * gestureBodySearchM of it) the screen point TG.sx / TG.sy against his body drawn on screen. Reads scratch fields
   * only, so no double crosses a call.
   */
  function playerDist(s: SimState, i: number, proj: CameraProjector): void {
    const q = s.players[i]!;
    const dx = q.x - TG.x, dz = q.z - TG.z;
    R.d = Math.sqrt(dx * dx + dz * dz);
    if (!(R.d <= LOCAL_TUNING.gestureBodySearchM)) return;
    const h = LOCAL_TUNING.gestureBodyHeight;
    if (!proj.pitchToScreen(q.x, 0, q.z, S0) || !proj.pitchToScreen(q.x, h, q.z, S1)) return;
    const vx = S1.x - S0.x, vy = S1.y - S0.y;
    const l2 = vx * vx + vy * vy;
    if (!(l2 > 1) || !Number.isFinite(l2)) return;
    let t = ((TG.sx - S0.x) * vx + (TG.sy - S0.y) * vy) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = S0.x + vx * t - TG.sx, ey = S0.y + vy * t - TG.sy;
    const ds = Math.sqrt(ex * ex + ey * ey) / (Math.sqrt(l2) / h);
    if (ds < R.d) R.d = ds;
  }

  /** gSlot: the player nearest the target within gestureSlotRadius (own team, or the opposing ball carrier). */
  function nearestSlot(s: SimState, side: number, proj: CameraProjector): number {
    let best = -1;
    R.best = LOCAL_TUNING.gestureSlotRadius;
    const first = side === 0 ? 0 : 11;
    for (let i = first; i < first + 11; i++) {
      if (s.players[i]!.active !== 1) continue;
      playerDist(s, i, proj);
      if (R.d <= R.best) { R.best = R.d; best = i; }
    }
    const c = s.ball.owner;
    if (c >= 0 && c < NUM_SLOTS && s.ball.heldBy < 0 && slotTeam(c) !== side && s.players[c]!.active === 1) {
      playerDist(s, c, proj);
      if (R.d <= R.best) best = c;
    }
    return best;
  }

  /** Is the target (screen TG.sx / TG.sy; ground TG.x / TG.z) on the goal mouth of the goal that `dir` attacks? */
  function onGoal(dir: number, proj: CameraProjector): boolean {
    const u = (dir >= 0 ? 1 : -1) * TG.x;
    if (u >= HALF_LENGTH - LOCAL_TUNING.goalFrontM && u <= HALF_LENGTH + LOCAL_TUNING.goalBehindM &&
        Math.abs(TG.z) <= GOAL_HALF_WIDTH + LOCAL_TUNING.goalMarginM) return true;
    const ux = u - HALF_LENGTH;
    if (!(ux * ux + TG.z * TG.z <= LOCAL_TUNING.goalSearchM * LOCAL_TUNING.goalSearchM)) return false;
    // The goal frame on screen (posts and bar), with a margin.
    const gx = dir >= 0 ? HALF_LENGTH : -HALF_LENGTH;
    const zs = GOAL_HALF_WIDTH;
    let ok = proj.pitchToScreen(gx, 0, -zs, SC);
    QUAD_X[0] = SC.x; QUAD_Y[0] = SC.y;
    ok = ok && proj.pitchToScreen(gx, 0, zs, SC);
    QUAD_X[1] = SC.x; QUAD_Y[1] = SC.y;
    ok = ok && proj.pitchToScreen(gx, GOAL_HEIGHT, zs, SC);
    QUAD_X[2] = SC.x; QUAD_Y[2] = SC.y;
    ok = ok && proj.pitchToScreen(gx, GOAL_HEIGHT, -zs, SC);
    QUAD_X[3] = SC.x; QUAD_Y[3] = SC.y;
    if (!ok) return false;
    let area = 0;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      area += QUAD_X[k]! * QUAD_Y[j]! - QUAD_X[j]! * QUAD_Y[k]!;
    }
    if (!(Math.abs(area) > 1e-6)) return false;
    const orient = area > 0 ? 1 : -1;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) & 3;
      const ex = QUAD_X[j]! - QUAD_X[k]!, ey = QUAD_Y[j]! - QUAD_Y[k]!;
      const len = Math.sqrt(ex * ex + ey * ey);
      if (!(len > 1e-6)) return false;
      const sd = (orient * (ex * (TG.sy - QUAD_Y[k]!) - ey * (TG.sx - QUAD_X[k]!))) / len;
      if (sd < -LOCAL_TUNING.goalMarginPx) return false;
    }
    return true;
  }

  /** Section 9 gesture rule a gesture means in open play (null = not one of the toggled rules). */
  function ruleOf(s: SimState, side: number, human: number): GestureRule | null {
    const slot = controlledSlot(s, side, human);
    if (slot < 0) return null;
    const p = s.players[slot]!;
    const cls = controlContext(s, slot);
    const kind = G.kind;
    const swipe = kind === GestureKind.SWIPE || kind === GestureKind.CURVED_SWIPE || kind === GestureKind.BACK_FORTH_SWIPE;
    const dir = s.teams[p.team]!.dir;
    const gx = G.gx / 10, gz = G.gz / 10;
    if (cls === Ctx.KEEPER) return null;
    if (cls === Ctx.ATTACK) {
      if (swipe) {
        if (dir * p.x < 0) return GestureRule.CLEAR;
        return kind === GestureKind.CURVED_SWIPE ? GestureRule.FINESSE
          : kind === GestureKind.BACK_FORTH_SWIPE ? GestureRule.POWER : GestureRule.SHOT;
      }
      const goal = (G.gFlags & GestureFlag.ON_GOAL) !== 0;
      if (kind === GestureKind.DOUBLE_TAP) {
        if (inCrossingZone(p.x, p.z, dir)) {
          const sx = dir * (HALF_LENGTH - RESOLVE_TUNING.crossPostDepth);
          const r = RESOLVE_TUNING.crossPostRadius;
          const dzA = gz - GOAL_HALF_WIDTH, dzB = gz + GOAL_HALF_WIDTH, dx = gx - sx;
          const near = Math.min(dzA * dzA, dzB * dzB) + dx * dx;
          if (goal || near <= r * r) return GestureRule.CROSS;
        }
        return goal ? GestureRule.CHIP : GestureRule.LOBBED;
      }
      if (kind !== GestureKind.TAP) return null;
      if (goal) return GestureRule.CHIP;
      // Through ball when the tap is clearly ahead of the teammate it means (SIM-15's rule), else pass to feet.
      let t = G.gSlot >= 0 && G.gSlot !== slot && slotTeam(G.gSlot) === p.team ? G.gSlot : -1;
      if (t < 0) {
        let bestD = RESOLVE_TUNING.tapSpaceRadius * RESOLVE_TUNING.tapSpaceRadius;
        const first = p.team === 0 ? 0 : 11;
        for (let i = first; i < first + 11; i++) {
          const q = s.players[i]!;
          if (i === slot || q.active !== 1) continue;
          const d = (q.x - gx) * (q.x - gx) + (q.z - gz) * (q.z - gz);
          if (d < bestD) { bestD = d; t = i; }
        }
      }
      if (t >= 0 && dir * (gx - s.players[t]!.x) > RESOLVE_TUNING.tapThroughLead) return GestureRule.THROUGH;
      return GestureRule.PASS;
    }
    // Defence.
    if (swipe) return GestureRule.SLIDE;
    if (kind === GestureKind.DOUBLE_TAP) return GestureRule.SECOND_DEF;
    if (kind !== GestureKind.TAP) return null;
    if ((G.gFlags & GestureFlag.ON_OWN_KEEPER) !== 0) return GestureRule.KEEPER_RUSH;
    if (G.gSlot >= 0 && G.gSlot === s.ball.owner && slotTeam(G.gSlot) !== p.team) return GestureRule.PRESS;
    if (G.gSlot >= 0 && slotTeam(G.gSlot) === p.team) return GestureRule.SWITCH;
    return null;
  }

  /**
   * Convert a screen gesture into G (pitch space). False when it cannot be mapped or its rule is switched off. Works
   * on scratch fields (TG, W, P0, P1) so no double crosses an internal call; the projector calls are the only ones
   * that take coordinates.
   */
  function convertGesture(g: TouchGestureEvent, ctx: InputSampleContext): boolean {
    const proj = ctx.projector;
    const s = ctx.state;
    const kind = g.kind;
    if (!proj || !s || !(kind >= GestureKind.TAP && kind <= GestureKind.BACK_FORTH_SWIPE)) return false;
    const tap = kind === GestureKind.TAP || kind === GestureKind.DOUBLE_TAP;
    const okS = Number.isFinite(g.sx) && Number.isFinite(g.sy) && proj.screenToPitch(g.sx, g.sy, P0);
    const okE = !tap && Number.isFinite(g.ex) && Number.isFinite(g.ey) && proj.screenToPitch(g.ex, g.ey, P1);
    if (tap ? okS : okE) {
      TG.x = tap ? P0.x : P1.x; TG.z = tap ? P0.z : P1.z;
      TG.sx = tap ? g.sx : g.ex; TG.sy = tap ? g.sy : g.ey;
    } else if (!tap && okS) {
      // The swipe ended above the horizon: aim from its start.
      TG.x = P0.x; TG.z = P0.z; TG.sx = g.sx; TG.sy = g.sy;
    } else {
      return false;
    }
    if (!Number.isFinite(TG.x) || !Number.isFinite(TG.z)) return false;
    const mx = WORLD_MAX_X * GESTURE_POS_SCALE, mz = WORLD_MAX_Z * GESTURE_POS_SCALE;
    G.kind = kind;
    G.gx = clampInt(Math.round(TG.x * GESTURE_POS_SCALE), -mx, mx);
    G.gz = clampInt(Math.round(TG.z * GESTURE_POS_SCALE), -mz, mz);
    G.gdx = 0; G.gdz = 0; G.gPower = 0; G.gCurve = 0;
    if (!tap) {
      W.dx = 0; W.dz = 0;
      if (okS && okE) { W.dx = P1.x - P0.x; W.dz = P1.z - P0.z; }
      if (!(W.dx * W.dx + W.dz * W.dz > 1e-6) || !Number.isFinite(W.dx) || !Number.isFinite(W.dz)) {
        // Screen direction rotated like the stick.
        const sx = Number.isFinite(g.ex - g.sx) ? g.ex - g.sx : 0;
        const sy = Number.isFinite(g.ey - g.sy) ? g.ey - g.sy : 0;
        const rot = proj.stickRotation();
        const c = Number.isFinite(rot) ? Math.cos(rot) : 1, sn = Number.isFinite(rot) ? Math.sin(rot) : 0;
        W.dx = c * sx - sn * sy;
        W.dz = sn * sx + c * sy;
      }
      W.m = Math.sqrt(W.dx * W.dx + W.dz * W.dz);
      if (W.m > 1e-9 && Number.isFinite(W.m)) {
        // Unit direction, radially quantised (axes.ts quantStick).
        const ux = W.dx / W.m, uz = W.dz / W.m;
        let qx = Math.round(ux * AXIS_SCALE), qz = Math.round(uz * AXIS_SCALE);
        if (qx * qx + qz * qz > AXIS_SCALE * AXIS_SCALE) { qx = Math.trunc(ux * AXIS_SCALE); qz = Math.trunc(uz * AXIS_SCALE); }
        G.gdx = qx === 0 ? 0 : qx;
        G.gdz = qz === 0 ? 0 : qz;
      }
      const vx = Number.isFinite(g.vx) ? g.vx : 0, vy = Number.isFinite(g.vy) ? g.vy : 0;
      W.v = Math.sqrt(vx * vx + vy * vy) / LOCAL_TUNING.gestureFullSpeed;
      if (!(W.v >= LOCAL_TUNING.gestureMinPower)) W.v = LOCAL_TUNING.gestureMinPower;
      if (W.v > 1) W.v = 1;
      const pw = Math.round(W.v * UNIT_SCALE);
      G.gPower = pw < 1 ? 1 : pw;
      const cv = Number.isFinite(g.curve) ? g.curve : 0;
      const qc = Math.round(cv * AXIS_SCALE);
      G.gCurve = qc > AXIS_SCALE ? AXIS_SCALE : qc < -AXIS_SCALE ? -AXIS_SCALE : qc === 0 ? 0 : qc;
    }
    const side = ctx.side === 1 ? 1 : 0;
    G.gSlot = nearestSlot(s, side, proj);
    let flags = g.fromBall ? GestureFlag.FROM_BALL : 0;
    const team = s.teams[side];
    if (team && onGoal(team.dir, proj)) flags |= GestureFlag.ON_GOAL;
    if (team && G.gSlot >= 0 && G.gSlot === team.keeperSlot) flags |= GestureFlag.ON_OWN_KEEPER;
    G.gFlags = flags;
    if (s.match.phase === MatchPhase.IN_PLAY) {
      const rule = ruleOf(s, side, ctx.human);
      if (rule !== null && !isGestureRuleOn(settingsOf() as GestureSettings | null, rule)) return false;
    }
    return true;
  }

  // ================================================================ cluster mode

  function updateMode(ctx: InputSampleContext): void {
    const s = ctx.state;
    if (!s) return;
    const side = ctx.side;
    let raw = clusterModeFor(s, side, ctx.human) as number;
    const b = s.ball;
    const loose = b.owner < 0 && b.heldBy < 0;
    const open = loose && (raw === ClusterMode.ATTACK || raw === ClusterMode.DEFENCE) &&
      (s.match.phase === MatchPhase.IN_PLAY || s.match.restart.taken === 1);
    const clear = clearanceOn(s, side, ctx.human);
    if (open) {
      const slot = controlledSlot(s, side, ctx.human);
      if (slot >= 0 && s.players[slot]!.active === 1) {
        raw = controlContext(s as SimState, slot) === Ctx.DEFENCE ? ClusterMode.DEFENCE : ClusterMode.ATTACK;
        // The opponents' ball arriving at him in his own third: the defence set with CLEAR (section 9).
        if (raw === ClusterMode.ATTACK && clear && b.lastTouchTeam >= 0 && b.lastTouchTeam !== side) raw = ClusterMode.DEFENCE;
      }
    }
    if (!modeInit) {
      modeInit = true;
      st.mode = raw as ClusterMode;
      modeCand = -1;
    } else if (raw === st.mode) {
      modeCand = -1;
    } else if (open) {
      if (modeCand !== raw) { modeCand = raw; modeCandSince = n; }
      if (n - modeCandSince >= LOCAL_TUNING.looseSwapTicks) { st.mode = raw as ClusterMode; modeCand = -1; }
    } else {
      st.mode = raw as ClusterMode;
      modeCand = -1;
    }
    st.clearOn = st.mode === ClusterMode.DEFENCE && clear;
  }

  // ================================================================ sample

  function drainButtons(ctx: InputSampleContext, prevClear: boolean, hidden: boolean): boolean {
    let anyDown = false;
    const count = Math.min(st.buttonEventCount, st.buttonEvents.length);
    for (let k = 0; k < count; k++) {
      const e = st.buttonEvents[k]!;
      const b = e.button;
      if (!(b >= 0 && b < B) || b === TouchButtonId.PAUSE) continue;
      const t = Number.isFinite(e.tMs) ? e.tMs : T.lastMs;
      if (t > T.lastMs) { T.lastMs = t; T.lastN = n; }
      switch (e.edge) {
        case TouchEdge.DOWN: anyDown = true; onDown(b, e.mode, t, prevClear, hidden); break;
        case TouchEdge.HOLD: onHold(b, t); break;
        case TouchEdge.SWIPE: onSwipe(b, e.dir, t, ctx); break;
        case TouchEdge.UP: onUp(b, t); break;
        case TouchEdge.TAP:
        case TouchEdge.DOUBLE_TAP: onTapEdge(b, e.mode, t); break;
        case TouchEdge.CANCEL: onCancel(b, t); break;
        default: break;
      }
    }
    st.buttonEventCount = 0;
    return anyDown;
  }

  function drainGestures(ctx: InputSampleContext, hidden: boolean): boolean {
    let any = false;
    const count = Math.min(st.gestureEventCount, st.gestureEvents.length);
    for (let k = 0; k < count; k++) {
      const g = st.gestureEvents[k]!;
      any = true;
      if (Number.isFinite(g.tMs) && g.tMs > T.lastMs) { T.lastMs = g.tMs; T.lastN = n; }
      if (hidden) continue;
      if (convertGesture(g, ctx)) pushGesture();
    }
    st.gestureEventCount = 0;
    return any;
  }

  function writePower(ctx: InputSampleContext): void {
    const s = ctx.state;
    const c = s && ctx.human >= 0 ? s.ctrl[ctx.human] : undefined;
    const v = c ? c.power : 0;
    const power = Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
    let btn = -1;
    if (c && c.powerBtn !== 0) {
      for (let i = 0; i < 11; i++) {
        if (c.powerBtn === 1 << i) { btn = bitSource[i]!; break; }
      }
      if (btn >= 0) lastPowerButton = btn;
    } else if (power > 0) {
      btn = lastPowerButton;
    }
    if (power <= 0) {
      btn = -1;
      if (!c || c.powerBtn === 0) lastPowerButton = -1;
    }
    st.power = btn >= 0 ? power : 0;
    st.powerButton = btn >= 0 ? (btn as TouchButtonId) : -1;
  }

  return {
    sample(out, ctx) {
      clearInputFrame(out);
      const prevMode = st.mode;
      const prevClear = st.clearOn;
      const hidden = modeInit && prevMode === ClusterMode.HIDDEN;
      curFam = simFamily(ctx);

      // 3 / 4: drain the queues (presses keep the meaning they had at touch-down).
      const anyDown = drainButtons(ctx, prevClear, hidden);
      const anyGesture = drainGestures(ctx, hidden);
      const stickNow = st.stickActive;
      if (hidden && (anyDown || anyGesture || touchDown || (stickNow && !prevStick))) {
        pulse(SKIP_OWNER, Btn.SKIP, 1, T.lastMs, 0);
      }
      touchDown = false;
      prevStick = stickNow;
      T.now = opts.now ? opts.now() : T.lastMs + (n - T.lastN) * TICK_MS;
      if (!Number.isFinite(T.now)) T.now = T.lastMs;
      timers(T.now);

      // 1: cluster mode and CLEAR for the next touches; presses whose sim context changed while down are voided.
      updateMode(ctx);
      voidStale(curFam);

      // 2: stick (the strafe's MOD_L is added after the scheduled presses, below).
      if (stickNow) writeStick(out, ctx.projector);
      let bits = 0;
      const strafeHeld = stickNow && st.stickStrafe && st.mode === ClusterMode.ATTACK;
      if (strafeHeld) {
        strafeTicks++;
      } else {
        strafeTicks = 0;
        strafeSpent = false;
      }

      // 3: scheduled presses for this tick.
      for (let i = 0; i < POOL; i++) {
        if (aUsed[i] === 0 || aStart[i]! > n) continue;
        if (!(aEnd[i]! > n)) { freeAction(i); continue; }
        const ab = aBits[i]!;
        bits |= ab;
        if (aStart[i] === n) {
          if (aPower[i] !== 0 && out.power === 0) out.power = aPower[i]!;
          if (aSkill[i] !== 0 && out.skill === SkillMove.NONE) out.skill = aSkill[i] as SkillMove;
          if (aFlick[i] !== 0) { out.ax = aAx[i]!; out.az = aAz[i]!; }
          if (aOwner[i]! >= 0) {
            for (let k = 0; k < 4; k++) if ((ab & (1 << k)) !== 0) bitSource[k] = aOwner[i]!;
          }
        }
        if (!(aEnd[i]! > n + 1)) freeAction(i);
      }
      // Defending a free kick, the sim reads R2 / L2 as "move the wall" and Triangle as "wall jump" (section 10). Touch
      // has no wall controls (section 9): SPRINT & TACKLE's R2 slid the wall one way only (and every tackle tap nudged
      // it; defenders cannot sprint there) and a 2ND DEF swipe down (keeper rush) jumped the wall. Neither goes out.
      if (defendingFreeKick(ctx)) bits &= ~(Btn.SPRINT | Btn.THROUGH);
      if (strafeMod(ctx, strafeHeld, bits)) {
        bits |= Btn.MOD_L;
        strafeOn++;
        if (strafeHeld) {
          strafeMx = out.mx;
          strafeMz = out.mz;
        } else if (!stickNow) {
          // The stick lifted (or was cancelled) before the strafe's MOD_L lasted T_INPUT.tapTicks: MOD_L stays to its
          // minimum (else an L1 tap = trigger run) and so does the strafe's last stick, because L1 held with the stick
          // released is "stop and face goal" (a 14-tick skill that swallowed the next pass). Both end together, like a
          // long strafe's lift: a plain stop, no action (QF-3 QA-23).
          out.mx = strafeMx;
          out.mz = strafeMz;
        }
      } else {
        strafeOn = 0;
      }
      out.buttons = bits;
      lastOut = bits;

      // 4: one gesture per tick.
      if (gCount > 0) {
        const i = gHead;
        out.gesture = gKind[i] as GestureKind;
        out.gx = gX[i]!; out.gz = gZ[i]!; out.gSlot = gSlotQ[i]!;
        out.gdx = gDx[i]!; out.gdz = gDz[i]!; out.gPower = gPow[i]!; out.gCurve = gCur[i]!; out.gFlags = gFl[i]!;
        gHead = (gHead + 1) % GQ;
        gCount--;
      }

      // 6: power bar for the overlay.
      writePower(ctx);
      n++;
    },
    reset() {
      for (let b = 0; b < B; b++) {
        pState[b] = P_IDLE;
        pAct[b] = -1;
        pAfterUp[b] = 0;
        tapValid[b] = 0;
        pNoTap[b] = 0;
      }
      aUsed.fill(0);
      gHead = 0;
      gCount = 0;
      looseAttackN = 0;
      strafeTicks = 0;
      strafeOn = 0;
      strafeSpent = false;
      touchDown = false;
      bitSource.fill(-1);
      lastPowerButton = -1;
      st.power = 0;
      st.powerButton = -1;
    },
    noteTouchDown() {
      touchDown = true;
    },
  };
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
