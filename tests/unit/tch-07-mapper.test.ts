/**
 * TCH-07: touch -> InputFrame mapping (section 9 tables), table-driven over synthetic TouchIntentState event sequences:
 * every cell of the attack, keeper and defence button tables and every row of the pitch-gesture table (one test per
 * row), cluster-mode selection, explicit power, power bar for the overlay, edges and spacing, and no stuck bits after
 * a lift, a cancel or releaseAll. Events are pushed at their real times and the mapper is sampled every 1/60 s, like
 * the app loop does.
 */
import { describe, expect, it } from 'vitest';
import { GestureKind, MatchPhase, RestartKind, SkillMove } from '../../src/contracts/enums';
import {
  AXIS_SCALE, Btn, createInputFrame, GestureFlag, quantUnit, type CameraProjector, type InputFrame, type InputSampleContext,
} from '../../src/contracts/input';
import { createDefaultSettings, type TouchSettings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import {
  ClusterMode, createTouchIntentState, pushButtonEvent, pushGestureEvent, SwipeDir, TouchButtonId as TB, TouchEdge as E,
  type TouchGestureEvent, type TouchIntentState,
} from '../../src/contracts/touch';
import { T_INPUT } from '../../src/contracts/tuning';
import {
  createTouchMapper, DOUBLE_TAP_COMMIT_MS, LOCAL_TUNING, tapPulseTicks, type TouchMapper,
} from '../../src/input/touch/mapper';
import { quantStick } from '../../src/input/axes';
import { makeScenario } from '../harness/scenario';

const TICK = 1000 / 60;
const PASS_POWER = quantUnit(LOCAL_TUNING.flickPassPower);
const SHOT_POWER = quantUnit(LOCAL_TUNING.flickShotPower);
const FACE = Btn.PASS | Btn.SHOOT | Btn.LOB | Btn.THROUGH;
const Q = { qx: 0, qy: 0 };

// ------------------------------------------------------------------ states

/** P1 (home, attacking +x) controls #9 who has the ball at (10, 0). */
function attackState(): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 9 }],
    players: [{ slot: 9, x: 10, z: 0 }],
    ball: { owner: 9, x: 10.4, y: 0.11, z: 0 },
  });
}

/** The away #18 has the ball at (-20, 0); P1 controls #4. */
function defenceState(): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: -24, z: 2 }, { slot: 18, x: -20, z: 0 }],
    ball: { owner: 18, lastTouchTeam: 1, x: -19.6, y: 0.11, z: 0 },
  });
}

/** P1's keeper (#0) holds the ball in his hands and P1 controls him. */
function keeperState(): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 0 }],
    players: [{ slot: 0, x: -48, z: 0 }],
    ball: { owner: 0, heldBy: 0, x: -48, y: 1, z: 0 },
  });
}

// ------------------------------------------------------------------ rig

/** Top-down-ish camera: 10 px per metre, centre spot at (600, 400); height moves a point up the screen. */
const K = 10, CX = 600, CY = 400;
const PROJ: CameraProjector = {
  screenToPitch(sx, sy, out) { out.x = (sx - CX) / K; out.z = (sy - CY) / K; return true; },
  pitchToScreen(x, y, z, out) { out.x = CX + x * K; out.y = CY + z * K - y * K; return true; },
  stickRotation: () => 0,
};
const scr = (x: number, z: number): { x: number; y: number } => ({ x: CX + x * K, y: CY + z * K });

interface Rig {
  st: TouchIntentState;
  m: TouchMapper;
  s: SimState;
  ctx: InputSampleContext;
  settings: TouchSettings;
  /** Sample index -> time (ms). */
  i: number;
  sample(): InputFrame;
}

function rig(s: SimState = attackState(), o: { projector?: CameraProjector | null; side?: number; settings?: Partial<TouchSettings>; aim?: { button: number; dx: number; dy: number; tMs: number }; slideClear?: () => boolean } = {}): Rig {
  const st = createTouchIntentState();
  const settings: TouchSettings = { ...createDefaultSettings().controls.touch, ...o.settings };
  const r = { i: 0 } as Rig;
  const m = createTouchMapper(st, {
    now: () => r.i * TICK,
    settings: () => settings,
    swipeAim: o.aim ? () => o.aim! : undefined,
    slideClear: o.slideClear,
  });
  const ctx: InputSampleContext = { tick: 1, human: 0, side: o.side ?? 0, state: s, projector: o.projector === undefined ? PROJ : o.projector };
  const out = createInputFrame();
  Object.assign(r, {
    st, m, s, ctx, settings,
    sample(): InputFrame {
      m.sample(out, ctx);
      r.i++;
      return { ...out };
    },
  });
  return r;
}

type Ev = readonly [t: number, b: TB, e: E, dir?: SwipeDir, mode?: ClusterMode];

/** Push each event when its time comes and sample every tick: frames[i] is the frame sampled at i * TICK ms. */
function play(r: Rig, evs: readonly Ev[], ticks: number, mode: ClusterMode = ClusterMode.ATTACK, onTick?: (i: number) => void): InputFrame[] {
  const frames: InputFrame[] = [];
  let k = 0;
  const base = r.i;
  for (let j = 0; j < ticks; j++) {
    const t = (base + j) * TICK;
    while (k < evs.length && base * TICK + evs[k]![0] <= t + 1e-9) {
      const [et, b, e, dir, md] = evs[k]!;
      pushButtonEvent(r.st, b, e, dir ?? SwipeDir.NONE, base * TICK + et, md ?? mode);
      k++;
    }
    if (onTick) onTick(j);
    frames.push(r.sample());
  }
  return frames;
}

/** Ticks on which every bit of `bits` is set. */
const on = (fs: readonly InputFrame[], bits: number): number[] => fs.flatMap((f, i) => ((f.buttons & bits) === bits ? [i] : []));
/** Ticks with any button. */
const any = (fs: readonly InputFrame[]): number[] => fs.flatMap((f, i) => (f.buttons !== 0 ? [i] : []));
/** Rising edges: [tick, all bits that tick] where a bit rises, a skill / power is set or RS flicks. */
function presses(fs: readonly InputFrame[]): { t: number; bits: number; power: number; skill: SkillMove; ax: number; az: number }[] {
  let prev = 0;
  const r: { t: number; bits: number; power: number; skill: SkillMove; ax: number; az: number }[] = [];
  fs.forEach((f, t) => {
    if ((f.buttons & ~prev) !== 0 || f.skill !== SkillMove.NONE || f.power !== 0) {
      r.push({ t, bits: f.buttons, power: f.power, skill: f.skill, ax: f.ax, az: f.az });
    }
    prev = f.buttons;
  });
  return r;
}
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// Touch scripts (ms from the first sample). Samples are at multiples of 16.67 ms.
const tap = (b: TB, dur = 80): Ev[] => [[0, b, E.DOWN], [dur, b, E.UP], [dur, b, E.TAP]];
const hold = (b: TB): Ev[] => [[0, b, E.DOWN], [170, b, E.HOLD], [505, b, E.UP]];
/** Swipe recognised at 40 ms; the finger lifts 20 ms later (a flick). */
const flick = (b: TB, d: SwipeDir): Ev[] => [[0, b, E.DOWN], [40, b, E.SWIPE, d], [60, b, E.UP]];
/** Swipe recognised at 40 ms; the finger stays down until 505 ms (hold for power). */
const swipeHold = (b: TB, d: SwipeDir): Ev[] => [[0, b, E.DOWN], [40, b, E.SWIPE, d], [505, b, E.UP]];
const doubleTap = (b: TB): Ev[] => [[0, b, E.DOWN], [60, b, E.UP], [60, b, E.TAP], [155, b, E.DOWN], [215, b, E.UP], [215, b, E.DOUBLE_TAP]];

// ------------------------------------------------------------------ attack table

describe('TCH-07 attack table (ATTACK mode): one test per row', () => {
  it('PASS row: tap / hold = PASS (held while down), up = LOB, down = L1+PASS, left = L1+R1+LOB, right = R1+PASS, double tap = PASS,PASS', () => {
    // Tap: committed at the lift (sample 5), as long as the finger was down (80 ms = 4 ticks), still a tap for the sim.
    let fs = play(rig(), tap(TB.PASS), 20);
    expect(on(fs, Btn.PASS)).toEqual([5, 6, 7, 8]);
    expect(any(fs)).toEqual([5, 6, 7, 8]);
    expect(fs.every((f) => f.power === 0)).toBe(true);
    // Hold: from HOLD (170 ms -> sample 11) until the lift (505 ms -> sample 31).
    fs = play(rig(), hold(TB.PASS), 40);
    expect(on(fs, Btn.PASS)).toEqual(range(11, 30));
    expect(any(fs)).toEqual(range(11, 30));
    // Swipes, flicked: one press with explicit power, exactly the cell's bits.
    const cells: [SwipeDir, number][] = [
      [SwipeDir.UP, Btn.LOB], [SwipeDir.DOWN, Btn.MOD_L | Btn.PASS],
      [SwipeDir.LEFT, Btn.MOD_L | Btn.MOD_R | Btn.LOB], [SwipeDir.RIGHT, Btn.MOD_R | Btn.PASS],
    ];
    for (const [d, bits] of cells) {
      fs = play(rig(), flick(TB.PASS, d), 20);
      expect(presses(fs), `flick ${d}`).toEqual([{ t: 4, bits, power: PASS_POWER, skill: 0, ax: 0, az: 0 }]);
      expect(any(fs), `flick ${d}`).toEqual([4]);
      // Held: the combo is held from the end of the flick window for power (no explicit power).
      fs = play(rig(), swipeHold(TB.PASS, d), 40);
      const p = presses(fs);
      expect(p.length, `hold ${d}`).toBe(1);
      expect(p[0]!.bits, `hold ${d}`).toBe(bits);
      expect(p[0]!.power, `hold ${d}`).toBe(0);
      expect(p[0]!.t * TICK, `hold ${d}`).toBeGreaterThan(40 + LOCAL_TUNING.flickLiftMs);
      expect(on(fs, bits), `hold ${d}`).toEqual(range(p[0]!.t, 30));
    }
    // Double tap: two separate PASS presses, the second at its touch-down, well inside the sim's double-tap window.
    fs = play(rig(), doubleTap(TB.PASS), 24);
    const p = presses(fs);
    expect(p.map((x) => x.bits)).toEqual([Btn.PASS, Btn.PASS]);
    expect(p[1]!.t - p[0]!.t).toBeLessThan(T_INPUT.doubleTapTicks);
    expect(fs[p[1]!.t - 1]!.buttons & Btn.PASS).toBe(0);
  });

  it('THROUGH row: tap / hold = THROUGH, up = L1+THROUGH, down = L1 tap (trigger run), left / right = nothing, double tap = THROUGH,THROUGH', () => {
    let fs = play(rig(), tap(TB.THROUGH), 20);
    expect(any(fs)).toEqual([5, 6, 7, 8]);
    expect(on(fs, Btn.THROUGH)).toEqual([5, 6, 7, 8]);
    fs = play(rig(), hold(TB.THROUGH), 40);
    expect(on(fs, Btn.THROUGH)).toEqual(range(11, 30));
    fs = play(rig(), flick(TB.THROUGH, SwipeDir.UP), 20);
    expect(presses(fs)).toEqual([{ t: 4, bits: Btn.MOD_L | Btn.THROUGH, power: PASS_POWER, skill: 0, ax: 0, az: 0 }]);
    fs = play(rig(), swipeHold(TB.THROUGH, SwipeDir.UP), 40);
    expect(presses(fs)[0]!.bits).toBe(Btn.MOD_L | Btn.THROUGH);
    expect(presses(fs)[0]!.power).toBe(0);
    // Down: an L1 tap (no face button, shorter than a tap) whether or not the finger stays down.
    for (const script of [flick(TB.THROUGH, SwipeDir.DOWN), swipeHold(TB.THROUGH, SwipeDir.DOWN)]) {
      fs = play(rig(), script, 40);
      expect(presses(fs)).toEqual([{ t: 3, bits: Btn.MOD_L, power: 0, skill: 0, ax: 0, az: 0 }]);
      expect(any(fs)).toEqual([3]);
    }
    for (const d of [SwipeDir.LEFT, SwipeDir.RIGHT]) {
      fs = play(rig(), swipeHold(TB.THROUGH, d), 40);
      expect(any(fs), `empty cell ${d}`).toEqual([]);
      expect(fs.every((f) => f.power === 0 && f.skill === 0)).toBe(true);
    }
    fs = play(rig(), doubleTap(TB.THROUGH), 24);
    expect(presses(fs).map((x) => x.bits)).toEqual([Btn.THROUGH, Btn.THROUGH]);
  });

  it('SHOOT row: tap / hold = SHOOT, up = L1+SHOOT (chip), down = R1+SHOOT (finesse), left = SHOOT then PASS (fake), right = L1+R1+SHOOT (power)', () => {
    let fs = play(rig(), tap(TB.SHOOT), 20);
    expect(on(fs, Btn.SHOOT)).toEqual([5, 6, 7, 8]);
    expect(any(fs)).toEqual([5, 6, 7, 8]);
    fs = play(rig(), hold(TB.SHOOT), 40);
    expect(on(fs, Btn.SHOOT)).toEqual(range(11, 30));
    const cells: [SwipeDir, number][] = [
      [SwipeDir.UP, Btn.MOD_L | Btn.SHOOT], [SwipeDir.DOWN, Btn.MOD_R | Btn.SHOOT], [SwipeDir.RIGHT, Btn.MOD_L | Btn.MOD_R | Btn.SHOOT],
    ];
    for (const [d, bits] of cells) {
      fs = play(rig(), flick(TB.SHOOT, d), 20);
      expect(presses(fs), `flick ${d}`).toEqual([{ t: 4, bits, power: SHOT_POWER, skill: 0, ax: 0, az: 0 }]);
      fs = play(rig(), swipeHold(TB.SHOOT, d), 40);
      expect(presses(fs).map((p) => [p.bits, p.power]), `hold ${d}`).toEqual([[bits, 0]]);
    }
    // Fake shot: SHOOT, then PASS on the next tick (SIM-15: PASS during the shot wind-up), whatever the finger does.
    for (const script of [flick(TB.SHOOT, SwipeDir.LEFT), swipeHold(TB.SHOOT, SwipeDir.LEFT)]) {
      fs = play(rig(), script, 40);
      expect(presses(fs).map((p) => [p.t, p.bits])).toEqual([[3, Btn.SHOOT], [4, Btn.PASS]]);
      expect(any(fs)).toEqual([3, 4]);
    }
  });

  it('SPRINT & SKILL row: hold = sprint; tap = the tap skill slot; up / right = their slots; down = knock-on; left = hard stop', () => {
    // Stick released: SPRINT from the tap time (a tap is a skill, and R2 with a released stick would stop the ball).
    let fs = play(rig(), hold(TB.SPRINT_SKILL), 40);
    expect(on(fs, Btn.SPRINT)).toEqual(range(11, 30));
    // Stick pushed: SPRINT at once.
    let r = rig();
    r.st.stickActive = true; r.st.stickX = 1; r.st.stickY = 0;
    fs = play(r, hold(TB.SPRINT_SKILL), 40);
    expect(on(fs, Btn.SPRINT)).toEqual(range(0, 30));
    // Pushing the stick while the finger is still undecided starts the sprint then.
    r = rig();
    fs = play(r, hold(TB.SPRINT_SKILL), 40, ClusterMode.ATTACK, (i) => { if (i === 4) { r.st.stickActive = true; r.st.stickX = 0.8; } });
    expect(on(fs, Btn.SPRINT)).toEqual(range(4, 30));
    // Tap: the tap slot (default step-over), no SPRINT.
    fs = play(rig(), tap(TB.SPRINT_SKILL), 20);
    expect(presses(fs)).toEqual([{ t: 5, bits: 0, power: 0, skill: SkillMove.STEP_OVER, ax: 0, az: 0 }]);
    expect(any(fs)).toEqual([]);
    // Edited slots are used.
    fs = play(rig(attackState(), { settings: { skillTap: SkillMove.BALL_ROLL, skillUp: SkillMove.DRAG_BACK, skillRight: SkillMove.BODY_FEINT } }),
      [...tap(TB.SPRINT_SKILL), ...flick(TB.SPRINT_SKILL, SwipeDir.UP).map(([t, b, e, d]) => [t + 300, b, e, d] as Ev),
        ...flick(TB.SPRINT_SKILL, SwipeDir.RIGHT).map(([t, b, e, d]) => [t + 600, b, e, d] as Ev)], 50);
    expect(presses(fs).map((p) => p.skill)).toEqual([SkillMove.BALL_ROLL, SkillMove.DRAG_BACK, SkillMove.BODY_FEINT]);
    const swipes: [SwipeDir, SkillMove][] = [
      [SwipeDir.UP, SkillMove.ROULETTE], [SwipeDir.RIGHT, SkillMove.HEEL_FLICK], [SwipeDir.DOWN, SkillMove.KNOCK_ON], [SwipeDir.LEFT, SkillMove.HARD_STOP],
    ];
    for (const [d, skill] of swipes) {
      fs = play(rig(), swipeHold(TB.SPRINT_SKILL, d), 40);
      expect(presses(fs), `swipe ${d}`).toEqual([{ t: 3, bits: 0, power: 0, skill, ax: 0, az: 0 }]);
      expect(any(fs), `swipe ${d}: no sprint after a swipe`).toEqual([]);
    }
    // A swipe while sprinting: the skill edge, and the sprint goes on until the lift.
    fs = play(rig(), [[0, TB.SPRINT_SKILL, E.DOWN], [170, TB.SPRINT_SKILL, E.HOLD], [300, TB.SPRINT_SKILL, E.SWIPE, SwipeDir.DOWN], [505, TB.SPRINT_SKILL, E.UP]], 40);
    expect(on(fs, Btn.SPRINT)).toEqual(range(11, 30));
    expect(fs.flatMap((f, i) => (f.skill !== 0 ? [[i, f.skill]] : []))).toEqual([[18, SkillMove.KNOCK_ON]]);
  });

  it('PASS swipe left in the crossing zone = LOB, released, LOB (SIM-15 LOB,LOB ground cross), flicked or held; outside the zone or at a set piece L1+R1+LOB', () => {
    /** #9 on the ball wide in the attacking third (inside geometry.inCrossingZone for +x). */
    const zone = (x = 40, z = 20): SimState => makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x, z }], ball: { owner: 9, x: x + 0.4, y: 0.11, z },
    });
    for (const evs of [flick(TB.PASS, SwipeDir.LEFT), swipeHold(TB.PASS, SwipeDir.LEFT)]) {
      const fs = play(rig(zone()), evs, 40);
      // Committed at the swipe (sample 3): one-tick LOB, one released tick, one-tick LOB; nothing else, no power.
      expect(presses(fs)).toEqual([
        { t: 3, bits: Btn.LOB, power: 0, skill: 0, ax: 0, az: 0 },
        { t: 5, bits: Btn.LOB, power: 0, skill: 0, ax: 0, az: 0 },
      ]);
      expect(any(fs)).toEqual([3, 5]);
      expect(5 - 3).toBeLessThanOrEqual(T_INPUT.doubleTapTicks);
      expect(1).toBeLessThan(T_INPUT.tapTicks); // the first LOB is a tap for the sim
    }
    // Other directions in the zone keep their cells (right = R1+PASS: SIM-15 makes it the low cross there).
    let fs = play(rig(zone()), flick(TB.PASS, SwipeDir.RIGHT), 20);
    expect(presses(fs).map((p) => [p.bits, p.power])).toEqual([[Btn.MOD_R | Btn.PASS, PASS_POWER]]);
    // Central (|z| below the zone) and at a set piece: the driven lob.
    fs = play(rig(zone(40, 5)), flick(TB.PASS, SwipeDir.LEFT), 20);
    expect(presses(fs).map((p) => [p.bits, p.power])).toEqual([[Btn.MOD_L | Btn.MOD_R | Btn.LOB, PASS_POWER]]);
    fs = play(rig(zone()), flick(TB.PASS, SwipeDir.LEFT), 20, ClusterMode.SET_PIECE);
    expect(presses(fs).map((p) => [p.bits, p.power])).toEqual([[Btn.MOD_L | Btn.MOD_R | Btn.LOB, PASS_POWER]]);
    // The defending half's wing is no crossing zone.
    fs = play(rig(zone(-40, 20)), flick(TB.PASS, SwipeDir.LEFT), 20);
    expect(presses(fs).map((p) => p.bits)).toEqual([Btn.MOD_L | Btn.MOD_R | Btn.LOB]);
  });

  it('set pieces (SET_PIECE mode) use the same attack table', () => {
    const fs = play(rig(), [...flick(TB.SHOOT, SwipeDir.DOWN), ...tap(TB.PASS).map(([t, b, e]) => [t + 300, b, e] as Ev)], 40, ClusterMode.SET_PIECE);
    expect(presses(fs).map((p) => [p.bits, p.power])).toEqual([[Btn.MOD_R | Btn.SHOOT, SHOT_POWER], [Btn.PASS, 0]]);
  });
});

// ------------------------------------------------------------------ keeper row

describe('TCH-07 keeper row (KEEPER mode): PASS throw, THROUGH driven throw, SHOOT drop kick, SPRINT & SKILL drop', () => {
  const rows: [TB, number][] = [
    [TB.PASS, Btn.PASS], [TB.THROUGH, Btn.MOD_R | Btn.PASS], [TB.SHOOT, Btn.SHOOT], [TB.SPRINT_SKILL, Btn.THROUGH],
  ];
  for (const [b, bits] of rows) {
    it(`keeper ${TB[b]} -> ${bits} at touch-down, held while the finger is down (power), no swipe variants`, () => {
      let fs = play(rig(keeperState()), tap(b), 20, ClusterMode.KEEPER);
      expect(presses(fs)).toEqual([{ t: 0, bits, power: 0, skill: 0, ax: 0, az: 0 }]);
      expect(on(fs, bits)).toEqual([0, 1, 2, 3, 4]);
      expect(any(fs)).toEqual([0, 1, 2, 3, 4]);
      fs = play(rig(keeperState()), swipeHold(b, SwipeDir.UP), 40, ClusterMode.KEEPER);
      expect(presses(fs).map((p) => p.bits)).toEqual([bits]);
      expect(on(fs, bits)).toEqual(range(0, 30));
    });
  }
});

// ------------------------------------------------------------------ defence table

describe('TCH-07 defence table (DEFENCE mode): one test per row', () => {
  const D = ClusterMode.DEFENCE;
  it('SPRINT & TACKLE: tap = SHOOT (tackle), hold = SPRINT from touch-down, swipe left = R1+SHOOT (hard tackle)', () => {
    let fs = play(rig(defenceState()), tap(TB.SPRINT_TACKLE), 20, D);
    expect(on(fs, Btn.SHOOT)).toEqual([5, 6, 7, 8]);
    expect(on(fs, Btn.SPRINT)).toEqual([0, 1, 2, 3, 4]); // pressing while the thumb decides
    expect(presses(fs).filter((p) => (p.bits & FACE) !== 0).map((p) => p.bits)).toEqual([Btn.SHOOT]);
    // A tap that starts and ends between two ticks is only the tackle.
    fs = play(rig(defenceState()), [[5, TB.SPRINT_TACKLE, E.DOWN], [12, TB.SPRINT_TACKLE, E.UP], [12, TB.SPRINT_TACKLE, E.TAP]], 10, D);
    expect(any(fs)).toEqual([1]);
    expect(fs[1]!.buttons).toBe(Btn.SHOOT);
    fs = play(rig(defenceState()), hold(TB.SPRINT_TACKLE), 40, D);
    expect(on(fs, Btn.SPRINT)).toEqual(range(0, 30));
    expect(on(fs, Btn.SHOOT)).toEqual([]);
    fs = play(rig(defenceState()), swipeHold(TB.SPRINT_TACKLE, SwipeDir.LEFT), 40, D);
    expect(on(fs, Btn.MOD_R | Btn.SHOOT)).toEqual([3]);
    expect(presses(fs).filter((p) => (p.bits & FACE) !== 0).map((p) => p.bits)).toEqual([Btn.SPRINT | Btn.MOD_R | Btn.SHOOT]);
    for (const d of [SwipeDir.UP, SwipeDir.DOWN, SwipeDir.RIGHT]) {
      fs = play(rig(defenceState()), swipeHold(TB.SPRINT_TACKLE, d), 40, D);
      expect(on(fs, Btn.SHOOT), `swipe ${d}`).toEqual([]);
    }
  });

  it('SLIDE: LOB (slide tackle) at touch-down; CLEAR (a SLIDE press that went down while clearOn) = SHOOT', () => {
    let fs = play(rig(defenceState()), tap(TB.SLIDE), 20, D);
    expect(presses(fs)).toEqual([{ t: 0, bits: Btn.LOB, power: 0, skill: 0, ax: 0, az: 0 }]);
    expect(any(fs)).toEqual([0, 1, 2, 3, 4]);
    const r = rig(defenceState());
    r.st.clearOn = true; // CLEAR shown when the finger went down
    fs = play(r, tap(TB.SLIDE), 20, D);
    expect(presses(fs).map((p) => [p.t, p.bits])).toEqual([[0, Btn.SHOOT]]);
    expect(on(fs, Btn.LOB)).toEqual([]);
    // Wired to TCH-04 DefenceCluster.slideClear (index.ts): the press's own CLEAR flag decides, not the live clearOn.
    let r2 = rig(defenceState(), { slideClear: () => true });
    fs = play(r2, tap(TB.SLIDE), 20, D);
    expect(presses(fs).map((p) => [p.t, p.bits])).toEqual([[0, Btn.SHOOT]]);
    r2 = rig(defenceState(), { slideClear: () => false });
    r2.st.clearOn = true;
    fs = play(r2, tap(TB.SLIDE), 20, D);
    expect(presses(fs).map((p) => [p.t, p.bits])).toEqual([[0, Btn.LOB]]);
  });

  it('SWITCH: tap = L1 (change player); a swipe in any direction = RS_FLICK toward it in pitch space', () => {
    let fs = play(rig(defenceState()), tap(TB.SWITCH), 20, D);
    expect(any(fs)).toEqual([5, 6, 7, 8]);
    expect(on(fs, Btn.MOD_L)).toEqual([5, 6, 7, 8]);
    expect(4).toBeLessThan(T_INPUT.tapTicks);
    const dirs: [SwipeDir, number, number][] = [
      [SwipeDir.UP, 0, -AXIS_SCALE], [SwipeDir.DOWN, 0, AXIS_SCALE], [SwipeDir.LEFT, -AXIS_SCALE, 0], [SwipeDir.RIGHT, AXIS_SCALE, 0],
    ];
    for (const [d, ax, az] of dirs) {
      fs = play(rig(defenceState()), swipeHold(TB.SWITCH, d), 40, D);
      expect(presses(fs), `swipe ${d}`).toEqual([{ t: 3, bits: Btn.RS_FLICK, power: 0, skill: 0, ax, az }]);
      expect(any(fs)).toEqual([3]);
    }
    // The exact swipe vector (TCH-04 swipeAim), rotated like the stick by the camera.
    const rot: CameraProjector = { ...PROJ, stickRotation: () => Math.PI / 2 };
    const r = rig(defenceState(), { projector: rot, aim: { button: TB.SWITCH, dx: Math.SQRT1_2, dy: -Math.SQRT1_2, tMs: 40 } });
    fs = play(r, swipeHold(TB.SWITCH, SwipeDir.RIGHT), 10, D);
    const f = fs[3]!;
    expect(f.buttons).toBe(Btn.RS_FLICK);
    // Screen (0.71, -0.71) rotated +90 degrees -> pitch (0.71, 0.71), radially quantised.
    quantStick(Math.SQRT1_2, Math.SQRT1_2, Q);
    expect([f.ax, f.az]).toEqual([Q.qx, Q.qy]);
    expect(Q.qx).toBeGreaterThanOrEqual(89);
    // A long press without a swipe still switches at the lift.
    fs = play(rig(defenceState()), [[0, TB.SWITCH, E.DOWN], [170, TB.SWITCH, E.HOLD], [400, TB.SWITCH, E.UP]], 30, D);
    expect(presses(fs).map((p) => p.bits)).toEqual([Btn.MOD_L]);
  });

  it('2ND DEF: tap = R1 tap (call him), hold = R1 held (keep him pressing), swipe down = THROUGH held (keeper rush)', () => {
    let fs = play(rig(defenceState()), tap(TB.SECOND_DEF), 20, D);
    expect(on(fs, Btn.MOD_R)).toEqual([5, 6, 7, 8]);
    expect(any(fs)).toEqual([5, 6, 7, 8]);
    fs = play(rig(defenceState()), hold(TB.SECOND_DEF), 40, D);
    expect(on(fs, Btn.MOD_R)).toEqual(range(11, 30));
    fs = play(rig(defenceState()), swipeHold(TB.SECOND_DEF, SwipeDir.DOWN), 40, D);
    expect(on(fs, Btn.THROUGH)).toEqual(range(3, 30));
    expect(any(fs)).toEqual(range(3, 30));
    // Held first, then swiped down: R1 ends, the keeper rush is held until the lift.
    fs = play(rig(defenceState()), [[0, TB.SECOND_DEF, E.DOWN], [170, TB.SECOND_DEF, E.HOLD], [300, TB.SECOND_DEF, E.SWIPE, SwipeDir.DOWN], [505, TB.SECOND_DEF, E.UP]], 40, D);
    expect(on(fs, Btn.MOD_R)).toEqual(range(11, 17));
    expect(on(fs, Btn.THROUGH)).toEqual(range(18, 30));
    for (const d of [SwipeDir.UP, SwipeDir.LEFT, SwipeDir.RIGHT]) {
      fs = play(rig(defenceState()), swipeHold(TB.SECOND_DEF, d), 40, D);
      expect(any(fs), `swipe ${d}`).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------ meaning, edges, release

describe('TCH-07 press rules: meaning at touch-down, edges, explicit power, release', () => {
  it('a press keeps the meaning it had at touch-down even after the cluster swaps', () => {
    // The DOWN went down in ATTACK; the state is now a defence: the PASS hold is still PASS.
    const fs = play(rig(defenceState()), hold(TB.PASS), 40, ClusterMode.ATTACK);
    expect(on(fs, Btn.PASS)).toEqual(range(11, 30));
  });

  it('explicit power is sent on the press tick only, and only for flicks', () => {
    const fs = play(rig(), flick(TB.PASS, SwipeDir.UP), 20);
    expect(fs.map((f) => f.power)).toEqual(fs.map((_, i) => (i === 4 ? PASS_POWER : 0)));
    const held = play(rig(), swipeHold(TB.PASS, SwipeDir.UP), 40);
    expect(held.every((f) => f.power === 0)).toBe(true);
  });

  it('tap length: as long as the finger was down, at least one tick, never a hold for the sim', () => {
    expect(tapPulseTicks(5)).toBe(1);
    expect(tapPulseTicks(50)).toBe(3);
    expect(tapPulseTicks(10_000)).toBe(T_INPUT.tapTicks - 1);
    expect(tapPulseTicks(Number.NaN)).toBe(1);
    // A real quick tap between two ticks is still reported (one tick).
    const fs = play(rig(), [[3, TB.SHOOT, E.DOWN], [10, TB.SHOOT, E.UP], [10, TB.SHOOT, E.TAP]], 6);
    expect(any(fs)).toEqual([1]);
  });

  it('two presses of the same bit always have a released tick between them (the sim sees both edges)', () => {
    // Stall: both taps of a double tap arrive in one drain.
    const r = rig();
    for (const [t, b, e] of doubleTap(TB.PASS)) pushButtonEvent(r.st, b, e, SwipeDir.NONE, t, ClusterMode.ATTACK);
    let fs = play(r, [], 10);
    expect(presses(fs).map((p) => p.bits)).toEqual([Btn.PASS, Btn.PASS]);
    expect(fs[0]!.buttons).toBe(Btn.PASS);
    expect(fs[1]!.buttons).toBe(0);
    // Two different buttons pressing SHOOT back to back (tackle tap, then CLEAR).
    const r2 = rig(defenceState());
    fs = play(r2, [[0, TB.SPRINT_TACKLE, E.DOWN], [20, TB.SPRINT_TACKLE, E.UP], [20, TB.SPRINT_TACKLE, E.TAP], [30, TB.SLIDE, E.DOWN], [200, TB.SLIDE, E.UP]],
      20, ClusterMode.DEFENCE, (i) => { if (i === 2) r2.st.clearOn = true; }); // CLEAR showing when the SLIDE finger lands
    expect(on(fs, Btn.SHOOT)).toEqual([2, ...range(4, 11)]);
  });

  it('one skill edge per tick: two swipes in one drain go out on consecutive ticks', () => {
    const r = rig();
    for (const [t, b, e, d] of [...tap(TB.SPRINT_SKILL, 40), ...flick(TB.SPRINT_SKILL, SwipeDir.LEFT).map(([t, b, e, d]) => [t + 50, b, e, d] as Ev)]) {
      pushButtonEvent(r.st, b, e, d ?? SwipeDir.NONE, t, ClusterMode.ATTACK);
    }
    const fs = play(r, [], 5);
    expect(fs.map((f) => f.skill)).toEqual([SkillMove.STEP_OVER, SkillMove.HARD_STOP, 0, 0, 0]);
  });

  it('the second tap of a double tap is pressed at touch-down only inside the sim double-tap window', () => {
    expect(DOUBLE_TAP_COMMIT_MS).toBeLessThan(T_INPUT.doubleTapTicks * TICK);
    // A second tap after the window is an ordinary (deferred) press: a swipe there is a swipe.
    const late = DOUBLE_TAP_COMMIT_MS + 40;
    const fs = play(rig(), [[0, TB.PASS, E.DOWN], [60, TB.PASS, E.UP], [60, TB.PASS, E.TAP],
      [60 + late, TB.PASS, E.DOWN], [100 + late, TB.PASS, E.SWIPE, SwipeDir.UP], [120 + late, TB.PASS, E.UP]], 40);
    expect(presses(fs).map((p) => p.bits)).toEqual([Btn.PASS, Btn.LOB]);
    // No double tap across a swap of meaning (first tap ATTACK, second SET_PIECE).
    const fs2 = play(rig(), [[0, TB.PASS, E.DOWN, 0, ClusterMode.ATTACK], [60, TB.PASS, E.UP, 0, ClusterMode.ATTACK], [60, TB.PASS, E.TAP, 0, ClusterMode.ATTACK],
      [155, TB.PASS, E.DOWN, 0, ClusterMode.SET_PIECE], [195, TB.PASS, E.SWIPE, SwipeDir.UP, ClusterMode.SET_PIECE], [215, TB.PASS, E.UP, 0, ClusterMode.SET_PIECE]], 30);
    expect(presses(fs2).map((p) => p.bits)).toEqual([Btn.PASS, Btn.LOB]);
  });

  it('CANCEL = release without action: an undecided press does nothing, a held one stops at once', () => {
    for (const b of [TB.PASS, TB.THROUGH, TB.SHOOT, TB.SPRINT_SKILL, TB.SPRINT_TACKLE, TB.SLIDE, TB.SWITCH, TB.SECOND_DEF]) {
      const mode = b === TB.SPRINT_TACKLE || b === TB.SLIDE || b === TB.SWITCH || b === TB.SECOND_DEF ? ClusterMode.DEFENCE : ClusterMode.ATTACK;
      // Down + cancel between two ticks (an iPadOS system gesture that starts on the button).
      let fs = play(rig(), [[2, b, E.DOWN], [6, b, E.CANCEL]], 10, mode);
      expect(any(fs), `${TB[b]} down+cancel`).toEqual([]);
      expect(fs.every((f) => f.skill === 0 && f.power === 0)).toBe(true);
      // Held, then cancelled.
      fs = play(rig(), [[0, b, E.DOWN], [170, b, E.HOLD], [300, b, E.CANCEL]], 30, mode);
      const last = any(fs).pop() ?? -1;
      expect(last, `${TB[b]} hold+cancel`).toBeLessThan(18);
      // Swiped (power swipe waiting for its lift), then cancelled.
      fs = play(rig(), [[0, b, E.DOWN], [40, b, E.SWIPE, SwipeDir.UP], [60, b, E.CANCEL]], 20, mode);
      if (b === TB.PASS || b === TB.THROUGH || b === TB.SHOOT) expect(any(fs), `${TB[b]} swipe+cancel`).toEqual([]);
    }
  });

  it('glitch: stuck sprint or stick after pointercancel - SPRINT and the stick drop on the next tick', () => {
    const r = rig();
    r.st.stickActive = true; r.st.stickX = 1; r.st.stickY = 0;
    let fs = play(r, [[0, TB.SPRINT_SKILL, E.DOWN]], 30);
    expect(fs[29]!.buttons).toBe(Btn.SPRINT);
    expect(fs[29]!.mx).toBe(AXIS_SCALE);
    // pointercancel: the stick resets itself (TCH-02), the button sends CANCEL (TCH-03).
    r.st.stickActive = false; r.st.stickX = 0;
    pushButtonEvent(r.st, TB.SPRINT_SKILL, E.CANCEL, SwipeDir.NONE, 30 * TICK, ClusterMode.ATTACK);
    fs = play(r, [], 10);
    expect(fs.every((f) => f.buttons === 0 && f.mx === 0 && f.mz === 0)).toBe(true);
  });

  it('reset (releaseAll) mid-hold, mid-swipe and with presses scheduled: nothing is sent afterwards', () => {
    const r = rig();
    play(r, [[0, TB.SHOOT, E.DOWN], [170, TB.SHOOT, E.HOLD], [180, TB.PASS, E.DOWN], [200, TB.PASS, E.SWIPE, SwipeDir.UP],
      [190, TB.SPRINT_SKILL, E.DOWN]], 13);
    // Queue a tap that would be sent later, then release everything.
    for (const [t, b, e] of tap(TB.THROUGH)) pushButtonEvent(r.st, b, e, SwipeDir.NONE, 220 + t, ClusterMode.ATTACK);
    r.m.reset();
    r.st.buttonEventCount = 0;
    const fs = play(r, [], 40);
    expect(fs.every((f) => f.buttons === 0 && f.power === 0 && f.skill === 0 && f.gesture === GestureKind.NONE)).toBe(true);
    // And the next press works normally.
    const after = play(r, tap(TB.PASS), 12);
    expect(presses(after).map((p) => p.bits)).toEqual([Btn.PASS]);
  });

  it('glitch: power bar stuck full - the overlay power follows the sim and drops to 0 / no button when nothing charges', () => {
    const r = rig();
    play(r, hold(TB.PASS).slice(0, 2), 14);
    const c = r.s.ctrl[0]!;
    c.powerBtn = Btn.PASS; c.power = 0.6;
    r.sample();
    expect(r.st.power).toBeCloseTo(0.6, 9);
    expect(r.st.powerButton).toBe(TB.PASS);
    // Released, the kick still running: the sim mirrors its power; the bar stays on PASS.
    c.powerBtn = 0; c.power = 0.6;
    r.sample();
    expect(r.st.powerButton).toBe(TB.PASS);
    c.power = 0;
    r.sample();
    expect(r.st.power).toBe(0);
    expect(r.st.powerButton).toBe(-1);
    // A charge this touch source did not press (another device): no bar on a touch button.
    c.powerBtn = Btn.LOB; c.power = 0.4;
    r.sample();
    expect(r.st.powerButton).toBe(-1);
    expect(r.st.power).toBe(0);
    // The keeper's driven throw (THROUGH button -> R1+PASS) charges PASS: the bar shows on THROUGH.
    const k = rig(keeperState());
    play(k, [[0, TB.THROUGH, E.DOWN, 0, ClusterMode.KEEPER]], 3, ClusterMode.KEEPER);
    k.s.ctrl[0]!.powerBtn = Btn.PASS; k.s.ctrl[0]!.power = 0.3;
    k.sample();
    expect(k.st.powerButton).toBe(TB.THROUGH);
    k.m.reset();
    expect(k.st.power).toBe(0);
    expect(k.st.powerButton).toBe(-1);
  });

  it('PAUSE events are ignored by the mapper (the touch source handles the button)', () => {
    const fs = play(rig(), tap(TB.PAUSE), 12);
    expect(any(fs)).toEqual([]);
  });

  it('lost events: an UP + TAP whose DOWN was dropped (queue overflow) is still a tap; a DOWN over a stuck press restarts it', () => {
    let fs = play(rig(), [[10, TB.PASS, E.UP], [10, TB.PASS, E.TAP]], 6);
    expect(presses(fs).map((p) => p.bits)).toEqual([Btn.PASS]);
    fs = play(rig(), [[0, TB.SHOOT, E.DOWN], [170, TB.SHOOT, E.HOLD], [300, TB.SHOOT, E.DOWN], [380, TB.SHOOT, E.UP], [380, TB.SHOOT, E.TAP]], 30);
    expect(presses(fs).map((p) => p.bits)).toEqual([Btn.SHOOT, Btn.SHOOT]);
    expect(any(fs).pop()).toBeLessThan(28);
  });
});

// ------------------------------------------------------------------ stick

describe('TCH-07 stick', () => {
  it('stick -> mx / mz (screen x -> +x, screen y -> +z), rotated by the projector; zero when released', () => {
    const r = rig();
    r.st.stickActive = true; r.st.stickX = 0.5; r.st.stickY = -1;
    let f = r.sample();
    quantStick(0.5, -1, Q);
    expect([f.mx, f.mz]).toEqual([Q.qx, Q.qy]);
    expect(f.mx).toBeGreaterThan(50);
    expect(f.mz).toBeLessThan(-110);
    expect(f.mx * f.mx + f.mz * f.mz).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    const r2 = rig(attackState(), { projector: { ...PROJ, stickRotation: () => Math.PI / 2 } });
    r2.st.stickActive = true; r2.st.stickX = 1; r2.st.stickY = 0;
    f = r2.sample();
    expect(f.mx).toBe(0);
    expect(f.mz).toBe(AXIS_SCALE);
    r2.st.stickActive = false;
    f = r2.sample();
    expect([f.mx, f.mz]).toEqual([0, 0]);
  });

  it('stick strafe -> MOD_L held in ATTACK once it has lasted the strafe delay; released with the stick; never in defence', () => {
    const r = rig();
    r.st.stickActive = true; r.st.stickStrafe = true; r.st.stickX = 0.5;
    const fs = play(r, [], 30);
    expect(on(fs, Btn.MOD_L)).toEqual(range(LOCAL_TUNING.strafeDelayTicks, 29));
    r.st.stickActive = false; r.st.stickStrafe = false;
    expect(r.sample().buttons).toBe(0);
    // A double tap on the stick (strafe shorter than a tap) never sends an L1 tap.
    r.st.stickActive = true; r.st.stickStrafe = true;
    const short = play(r, [], LOCAL_TUNING.strafeDelayTicks - 1);
    expect(any(short)).toEqual([]);
    const d = rig(defenceState());
    d.st.stickActive = true; d.st.stickStrafe = true; d.st.stickX = 0.5;
    expect(any(play(d, [], 30))).toEqual([]);
  });
});

// ------------------------------------------------------------------ cluster mode

describe('TCH-07 cluster mode selection', () => {
  const modeOf = (s: SimState, side = 0, n = 1): ClusterMode => {
    const r = rig(s, { side });
    for (let i = 0; i < n; i++) r.sample();
    return r.st.mode;
  };

  it('own possession -> ATTACK; opponents -> DEFENCE; own keeper holding, this human controls him -> KEEPER, else ATTACK', () => {
    expect(modeOf(attackState())).toBe(ClusterMode.ATTACK);
    expect(modeOf(defenceState())).toBe(ClusterMode.DEFENCE);
    expect(modeOf(keeperState())).toBe(ClusterMode.KEEPER);
    const s = keeperState();
    s.ctrl[0]!.slot = 5; s.players[0]!.ctrl = -1; s.players[5]!.ctrl = 0;
    expect(modeOf(s)).toBe(ClusterMode.ATTACK);
    // The away human sees the mirror image.
    expect(modeOf(makeScenario({ phase: MatchPhase.IN_PLAY, humans: 2, ball: { owner: 9, x: 0, z: 0 } }), 1)).toBe(ClusterMode.DEFENCE);
  });

  it('restarts: the taking side -> SET_PIECE, the other side -> DEFENCE (SET_PIECE at a penalty); cut-scenes -> HIDDEN', () => {
    const fk = (team: number, phase = MatchPhase.FREE_KICK, kind = RestartKind.FREE_KICK): SimState => makeScenario({
      phase, humans: [{ side: 0, slot: 9 }], match: { restart: { kind, team, taken: 0 } as SimState['match']['restart'] },
    });
    expect(modeOf(fk(0))).toBe(ClusterMode.SET_PIECE);
    expect(modeOf(fk(1))).toBe(ClusterMode.DEFENCE);
    expect(modeOf(fk(1, MatchPhase.PENALTY, RestartKind.PENALTY))).toBe(ClusterMode.SET_PIECE);
    expect(modeOf(fk(0, MatchPhase.CORNER, RestartKind.CORNER))).toBe(ClusterMode.SET_PIECE);
    for (const phase of [MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME]) {
      expect(modeOf(makeScenario({ phase, humans: [{ side: 0, slot: 9 }] })), MatchPhase[phase]).toBe(ClusterMode.HIDDEN);
    }
  });

  it('loose ball: the sim context decides (nearer / arriving -> ATTACK, opponent nearer -> DEFENCE) after a short hold; possession swaps at once', () => {
    const s = attackState();
    const r = rig(s);
    r.sample();
    expect(r.st.mode).toBe(ClusterMode.ATTACK);
    // The ball runs loose next to an opponent, far from #9.
    s.ball.owner = -1; s.ball.lastTouchTeam = 0;
    s.ball.x = 30; s.ball.z = 10; s.ball.vx = 0; s.ball.vz = 0;
    s.players[15]!.x = 30.5; s.players[15]!.z = 10;
    const modes: ClusterMode[] = [];
    for (let i = 0; i < LOCAL_TUNING.looseSwapTicks + 2; i++) { r.sample(); modes.push(r.st.mode); }
    expect(modes.slice(0, LOCAL_TUNING.looseSwapTicks)).toEqual(new Array(LOCAL_TUNING.looseSwapTicks).fill(ClusterMode.ATTACK));
    expect(modes[modes.length - 1]).toBe(ClusterMode.DEFENCE);
    // A flicker shorter than the hold does not swap back.
    s.players[15]!.x = 60; s.players[9]!.x = 30.2; s.players[9]!.z = 10;
    r.sample(); r.sample();
    s.players[15]!.x = 30.5; s.players[9]!.x = 10; s.players[9]!.z = 0;
    for (let i = 0; i < LOCAL_TUNING.looseSwapTicks + 2; i++) { r.sample(); expect(r.st.mode).toBe(ClusterMode.DEFENCE); }
    // Possession: #9 wins it -> ATTACK on the very next tick.
    s.ball.owner = 9;
    r.sample();
    expect(r.st.mode).toBe(ClusterMode.ATTACK);
    s.ball.owner = 15;
    r.sample();
    expect(r.st.mode).toBe(ClusterMode.DEFENCE);
  });

  it('CLEAR: the opponents\' loose ball arriving at the controlled player in his own third shows the defence set with clearOn', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY,
      humans: [{ side: 0, slot: 4 }],
      players: [{ slot: 4, x: -40, z: 0 }, { slot: 18, x: -20, z: 15 }],
      ball: { owner: -1, lastTouchTeam: 1, x: -37, y: 0.11, z: 0, vx: -10, vz: 0, grounded: 1 },
    });
    const r = rig(s);
    for (let i = 0; i < LOCAL_TUNING.looseSwapTicks + 2; i++) r.sample();
    expect(r.st.mode).toBe(ClusterMode.DEFENCE);
    expect(r.st.clearOn).toBe(true);
    // Our own pass to him: the attack set, no CLEAR.
    s.ball.lastTouchTeam = 0;
    for (let i = 0; i < LOCAL_TUNING.looseSwapTicks + 2; i++) r.sample();
    expect(r.st.mode).toBe(ClusterMode.ATTACK);
    expect(r.st.clearOn).toBe(false);
  });
});

// ------------------------------------------------------------------ gestures

function gesture(kind: GestureKind, a: { x: number; y: number }, b: { x: number; y: number } = a, o: Partial<TouchGestureEvent> = {}): TouchGestureEvent {
  return { kind, sx: a.x, sy: a.y, ex: b.x, ey: b.y, vx: 0, vy: 0, curve: 0, tMs: 0, fromBall: false, ...o };
}

/** Attack: #9 on the ball at (10, 0); teammate #7 at (20, 5); keeper #0 at (-50, 0); opponent #15 at (14, -6). */
function gAttack(): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 9 }],
    players: [{ slot: 9, x: 10, z: 0 }, { slot: 7, x: 20, z: 5 }, { slot: 0, x: -50, z: 0 }, { slot: 15, x: 14, z: -6 }],
    ball: { owner: 9, x: 10.4, y: 0.11, z: 0 },
  });
}

/** Defence: the away #18 dribbles at (-20, 0); P1 controls #4 at (-26, 3); teammate #3 at (-30, -12); keeper #0 at (-50, 0). */
function gDefence(): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: -26, z: 3 }, { slot: 3, x: -30, z: -12 }, { slot: 0, x: -50, z: 0 }, { slot: 18, x: -20, z: 0 }],
    ball: { owner: 18, lastTouchTeam: 1, x: -19.6, y: 0.11, z: 0 },
  });
}

function gestureFrame(s: SimState, g: TouchGestureEvent, settings?: Partial<TouchSettings>): InputFrame {
  const r = rig(s, { settings });
  r.sample();
  pushGestureEvent(r.st, g);
  return r.sample();
}

describe('TCH-07 pitch gesture table: one test per row', () => {
  it('tap a teammate (or just behind him) -> TAP on his feet, gSlot = him', () => {
    let f = gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(20, 5)));
    expect([f.gesture, f.gSlot, f.gx, f.gz, f.gdx, f.gdz, f.gPower]).toEqual([GestureKind.TAP, 7, 200, 50, 0, 0, 0]);
    f = gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(19, 5.5)));
    expect(f.gSlot).toBe(7);
  });

  it('tap the space in front of a teammate -> TAP at that point (no player there: gSlot -1, the sim picks the teammate)', () => {
    const f = gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(26, 5)));
    expect([f.gesture, f.gSlot, f.gx, f.gz]).toEqual([GestureKind.TAP, -1, 260, 50]);
  });

  it('double-tap either of those -> DOUBLE_TAP (the lobbed version)', () => {
    const f = gestureFrame(gAttack(), gesture(GestureKind.DOUBLE_TAP, scr(20, 5)));
    expect([f.gesture, f.gSlot]).toEqual([GestureKind.DOUBLE_TAP, 7]);
  });

  it('in the crossing zone, double-tap toward a post -> DOUBLE_TAP at that post', () => {
    const s = gAttack();
    s.players[9]!.x = 35; s.players[9]!.z = 25; s.ball.x = 35.3; s.ball.z = 25;
    const f = gestureFrame(s, gesture(GestureKind.DOUBLE_TAP, scr(48, 3.5)));
    expect([f.gesture, f.gx, f.gz]).toEqual([GestureKind.DOUBLE_TAP, 480, 35]);
  });

  it('swipe toward goal -> SWIPE along it in pitch space; a faster swipe has more gPower', () => {
    const slow = gestureFrame(gAttack(), gesture(GestureKind.SWIPE, scr(12, 0), scr(30, 0), { vx: 1.2, vy: 0 }));
    expect([slow.gesture, slow.gdx, slow.gdz]).toEqual([GestureKind.SWIPE, AXIS_SCALE, 0]);
    expect([slow.gx, slow.gz]).toEqual([300, 0]);
    const fast = gestureFrame(gAttack(), gesture(GestureKind.SWIPE, scr(12, 0), scr(30, 0), { vx: 2.7, vy: 0.3 }));
    expect(fast.gPower).toBeGreaterThan(slow.gPower);
    expect(slow.gPower).toBe(quantUnit(1.2 / LOCAL_TUNING.gestureFullSpeed));
    const crawl = gestureFrame(gAttack(), gesture(GestureKind.SWIPE, scr(12, 0), scr(30, 0), { vx: 0.01 }));
    expect(crawl.gPower).toBe(quantUnit(LOCAL_TUNING.gestureMinPower));
  });

  it('curved swipe toward goal -> CURVED_SWIPE with gCurve (clockwise on screen = curls to the kicker\'s right, +z going +x)', () => {
    const f = gestureFrame(gAttack(), gesture(GestureKind.CURVED_SWIPE, scr(12, 0), scr(30, 2), { vx: 2, curve: 0.6 }));
    expect([f.gesture, f.gCurve]).toEqual([GestureKind.CURVED_SWIPE, Math.round(0.6 * AXIS_SCALE)]);
    expect(f.gdx).toBeGreaterThan(120);
  });

  it('tap on the goal -> TAP flagged ON_GOAL (chip); a tap wide of the goal is not', () => {
    let f = gestureFrame(gAttack(), gesture(GestureKind.TAP, { x: CX + 52.5 * K, y: CY - 12 }));
    expect(f.gesture).toBe(GestureKind.TAP);
    expect(f.gFlags & GestureFlag.ON_GOAL).toBe(GestureFlag.ON_GOAL);
    f = gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(52, 14)));
    expect(f.gFlags & GestureFlag.ON_GOAL).toBe(0);
    // The goal frame seen from a low camera: the crossbar projects far behind the goal on the ground, yet it is on goal.
    const low: CameraProjector = {
      screenToPitch(sx, sy, out) { out.z = (sy - CY) / (0.3 * K); out.x = (sx - CX - out.z * 0.2 * K) / K; return true; },
      pitchToScreen(x, y, z, out) { out.x = CX + x * K + z * 0.2 * K; out.y = CY + z * 0.3 * K - y * 2 * K; return true; },
      stickRotation: () => 0,
    };
    const r = rig(gAttack(), { projector: low });
    r.sample();
    pushGestureEvent(r.st, gesture(GestureKind.TAP, { x: CX + 52.5 * K, y: CY - 2.3 * 2 * K }));
    f = r.sample();
    expect(Math.abs(f.gz)).toBeGreaterThan(100); // ground point 10+ m off the goal...
    expect(f.gFlags & GestureFlag.ON_GOAL).toBe(GestureFlag.ON_GOAL); // ...but the tap is on the frame
  });

  it('quick back-and-forth swipe toward goal -> BACK_FORTH_SWIPE along its main stroke', () => {
    const f = gestureFrame(gAttack(), gesture(GestureKind.BACK_FORTH_SWIPE, scr(14, 0), scr(28, 0), { vx: 2.5 }));
    expect([f.gesture, f.gdx, f.gdz]).toEqual([GestureKind.BACK_FORTH_SWIPE, AXIS_SCALE, 0]);
    expect(f.gPower).toBeGreaterThan(0);
  });

  it('tap the opposing ball carrier -> TAP with gSlot = the carrier', () => {
    const f = gestureFrame(gDefence(), gesture(GestureKind.TAP, scr(-20.4, 0.5)));
    expect([f.gesture, f.gSlot]).toEqual([GestureKind.TAP, 18]);
    // Other opponents are never a gesture target.
    const a = gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(14, -6)));
    expect(a.gSlot).toBe(-1);
  });

  it('swipe in your own half without the ball -> SWIPE there (slide tackle)', () => {
    const f = gestureFrame(gDefence(), gesture(GestureKind.SWIPE, scr(-26, 3), scr(-20, 0), { vx: 1.5 }));
    expect(f.gesture).toBe(GestureKind.SWIPE);
    expect(f.gdx).toBeGreaterThan(100);
    expect(f.gdz).toBeLessThan(0);
  });

  it('swipe in your own half with the ball -> SWIPE (clearance)', () => {
    const s = gAttack();
    s.players[9]!.x = -30; s.ball.x = -29.6;
    const f = gestureFrame(s, gesture(GestureKind.SWIPE, scr(-30, 0), scr(-10, -10), { vx: 2 }));
    expect(f.gesture).toBe(GestureKind.SWIPE);
    expect(f.gdx).toBeGreaterThan(0);
  });

  it('double-tap the pitch when defending -> DOUBLE_TAP (second defender)', () => {
    const f = gestureFrame(gDefence(), gesture(GestureKind.DOUBLE_TAP, scr(0, 20)));
    expect([f.gesture, f.gSlot]).toEqual([GestureKind.DOUBLE_TAP, -1]);
  });

  it('tap your keeper when defending -> TAP flagged ON_OWN_KEEPER, gSlot = the keeper', () => {
    const f = gestureFrame(gDefence(), gesture(GestureKind.TAP, scr(-50, 0.8)));
    expect([f.gesture, f.gSlot]).toEqual([GestureKind.TAP, 0]);
    expect(f.gFlags & GestureFlag.ON_OWN_KEEPER).toBe(GestureFlag.ON_OWN_KEEPER);
  });

  it('tap a teammate when defending -> TAP with gSlot = him (switch)', () => {
    const f = gestureFrame(gDefence(), gesture(GestureKind.TAP, scr(-30, -12)));
    expect([f.gesture, f.gSlot]).toEqual([GestureKind.TAP, 3]);
    expect(f.gFlags).toBe(0);
  });
});

describe('TCH-07 gesture mapping details', () => {
  it('a tap on a player\'s body on screen hits him although its ground point is more than 1.5 m away', () => {
    // #7 at (20, 5): his head is drawn 18 px above his feet; a tap at chest height lands 1.4..1.8 m behind him on the ground.
    const f = gestureFrame(gAttack(), gesture(GestureKind.TAP, { x: CX + 20 * K, y: CY + 5 * K - 16 }));
    expect(f.gz).toBe(34);
    expect(f.gSlot).toBe(7);
  });

  it('FROM_BALL is passed through; positions are clamped to the world', () => {
    const f = gestureFrame(gAttack(), gesture(GestureKind.SWIPE, scr(10.4, 0), { x: 99_999, y: CY }, { vx: 2, fromBall: true }));
    expect(f.gFlags & GestureFlag.FROM_BALL).toBe(GestureFlag.FROM_BALL);
    expect(f.gx).toBe(620);
    expect(f.gdx).toBe(AXIS_SCALE);
  });

  it('rules switched off in settings are dropped (only the matching rule), the master switch drops all in open play', () => {
    const off = { gestureEnabled: { passToFeet: false } };
    expect(gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(20, 5)), off).gesture).toBe(GestureKind.NONE);
    expect(gestureFrame(gAttack(), gesture(GestureKind.TAP, scr(26, 5)), off).gesture).toBe(GestureKind.TAP); // through ball
    expect(gestureFrame(gAttack(), gesture(GestureKind.TAP, { x: CX + 52.5 * K, y: CY - 12 }), off).gesture).toBe(GestureKind.TAP); // chip
    expect(gestureFrame(gAttack(), gesture(GestureKind.SWIPE, scr(12, 0), scr(30, 0), { vx: 2 }), { gestureEnabled: { shot: false } }).gesture)
      .toBe(GestureKind.NONE);
    expect(gestureFrame(gDefence(), gesture(GestureKind.TAP, scr(-50, 0.8)), { gestureEnabled: { keeperRush: false } }).gesture).toBe(GestureKind.NONE);
    expect(gestureFrame(gDefence(), gesture(GestureKind.TAP, scr(-30, -12)), { gestureEnabled: { keeperRush: false } }).gesture).toBe(GestureKind.TAP);
    expect(gestureFrame(gDefence(), gesture(GestureKind.DOUBLE_TAP, scr(0, 20)), { gestures: false }).gesture).toBe(GestureKind.NONE);
    // Set pieces are not filtered (corner / free-kick swipes from the ball).
    const fk = makeScenario({ phase: MatchPhase.FREE_KICK, humans: [{ side: 0, slot: 9 }], match: { restart: { kind: RestartKind.FREE_KICK, team: 0, taken: 0 } as SimState['match']['restart'] } });
    expect(gestureFrame(fk, gesture(GestureKind.SWIPE, scr(0, 0), scr(20, 0), { vx: 2, fromBall: true }), { gestureEnabled: { shot: false } }).gesture).toBe(GestureKind.SWIPE);
  });

  it('one gesture per tick, in order; none without a projector', () => {
    const r = rig(gAttack());
    r.sample();
    pushGestureEvent(r.st, gesture(GestureKind.TAP, scr(20, 5)));
    pushGestureEvent(r.st, gesture(GestureKind.DOUBLE_TAP, scr(26, 5)));
    const a = r.sample(), b = r.sample(), c = r.sample();
    expect([a.gesture, b.gesture, c.gesture]).toEqual([GestureKind.TAP, GestureKind.DOUBLE_TAP, GestureKind.NONE]);
    expect([a.gx, b.gx]).toEqual([200, 260]);
    expect(r.st.gestureEventCount).toBe(0);
    const h = rig(gAttack(), { projector: null });
    h.sample();
    pushGestureEvent(h.st, gesture(GestureKind.TAP, scr(20, 5)));
    expect(h.sample().gesture).toBe(GestureKind.NONE);
  });

  it('cut-scenes (HIDDEN): any touch -> SKIP for one tick (a new edge per touch), never a gesture or a press', () => {
    const s = makeScenario({ phase: MatchPhase.CELEBRATION, humans: [{ side: 0, slot: 9 }] });
    const r = rig(s);
    r.sample();
    expect(r.st.mode).toBe(ClusterMode.HIDDEN);
    pushGestureEvent(r.st, gesture(GestureKind.TAP, scr(20, 5)));
    let fs = play(r, [], 3);
    expect(fs.map((f) => f.buttons)).toEqual([Btn.SKIP, 0, 0]);
    expect(fs.every((f) => f.gesture === GestureKind.NONE)).toBe(true);
    // Stick touch, button touch and a bare touch-down (pointer manager onDown) each skip.
    r.st.stickActive = true;
    fs = play(r, [], 2);
    expect(fs.map((f) => f.buttons)).toEqual([Btn.SKIP, 0]);
    fs = play(r, [[0, TB.PASS, E.DOWN, 0, ClusterMode.HIDDEN], [100, TB.PASS, E.UP, 0, ClusterMode.HIDDEN]], 10);
    expect(fs.map((f) => f.buttons & Btn.SKIP)).toEqual([Btn.SKIP, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(fs.every((f) => (f.buttons & ~Btn.SKIP) === 0)).toBe(true);
    r.m.noteTouchDown();
    expect(r.sample().buttons).toBe(Btn.SKIP);
    r.m.noteTouchDown();
    expect(r.sample().buttons).toBe(0); // the bit must drop between two skips...
    expect(r.sample().buttons).toBe(Btn.SKIP); // ...and the second touch still skips
    // Outside cut-scenes a touch-down sends nothing by itself.
    const a = rig(gAttack());
    a.sample();
    a.m.noteTouchDown();
    expect(a.sample().buttons).toBe(0);
  });
});
