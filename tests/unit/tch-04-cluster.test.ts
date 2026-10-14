/**
 * TCH-04 defence / keeper button sets and the attack-defence swap (src/input/touch/cluster.ts), driven with synthetic
 * pointer sequences through the pure pointer routing core (TCH-01), the real attack cluster (TCH-03) and the real
 * defence cluster + cluster controller (no DOM). Section 9 "Layout" (the cluster swaps the moment possession changes;
 * a thumb already down keeps its old meaning until it lifts), "Attack buttons" keeper row, "Defence buttons" (every
 * row and column, CLEAR replacing SLIDE), "Touch quality bar", and the section 14 input glitches for the defence set.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import {
  CLUSTER_SLOT, ClusterMode, ClusterSlot, createTouchIntentState, SwipeDir, TouchButtonId, TouchEdge,
  type TouchControl, type TouchIntentState,
} from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import {
  computeClusterLayout, createAttackCluster, createClusterLayout, SLOT_ATTACK_BUTTON, type AttackCluster, type ClusterLayout,
} from '../../src/input/touch/attack';
import { BUTTON_SLOP, TAP_MS } from '../../src/input/touch/button';
import {
  buttonLabel, chooseClusterMode, CLEAR_LABEL, clearanceOn, clusterModeFor, controlledSlot, createClusterController,
  createDefenceCluster, createSlotMeaning, DEFENCE_BUTTONS, DEFENCE_SWIPE_HINTS, defenceSetActive, defenceSwipeHintMask,
  isAttackButton, isDefenceButton, KEEPER_LABELS, SLOT_DEFENCE_BUTTON, slotButton, slotLabel, slotMeaning, swipeVector,
  type ClusterController, type DefenceCluster, type DefenceClusterOptions, type SlotPress,
} from '../../src/input/touch/cluster';
import { createPointerRouter, type PointerRouter } from '../../src/input/touch/pointers';
import { ballEta, LOCAL_TUNING as RESOLVE_TUNING } from '../../src/sim/control/resolveShared';
import { aerialChance } from '../../src/sim/kicks/aerial';
import { makeScenario } from '../harness/scenario';

const W = 1180, H = 820;
const SWIPE = T_TOUCHUI.buttonSwipePt;
const { PASS, THROUGH, SHOOT, SPRINT_SKILL, SPRINT_TACKLE, SLIDE, SWITCH, SECOND_DEF } = TouchButtonId;
const { DOWN, UP, TAP, DOUBLE_TAP, SWIPE: SW, HOLD, CANCEL } = TouchEdge;
const { ATTACK, DEFENCE, KEEPER, SET_PIECE, HIDDEN } = ClusterMode;
const { BIG, LOW, MID, HIGH } = ClusterSlot;
const SLOTS = [BIG, LOW, MID, HIGH] as const;
const DIRS = [SwipeDir.UP, SwipeDir.DOWN, SwipeDir.LEFT, SwipeDir.RIGHT] as const;
const DIR_VEC: Record<number, [number, number]> = {
  [SwipeDir.UP]: [0, -1], [SwipeDir.DOWN]: [0, 1], [SwipeDir.LEFT]: [-1, 0], [SwipeDir.RIGHT]: [1, 0],
};

type Ev = [TouchButtonId, TouchEdge, SwipeDir, ClusterMode];

interface Rig {
  st: TouchIntentState;
  layout: ClusterLayout;
  attack: AttackCluster;
  defence: DefenceCluster;
  ctl: ClusterController;
  router: PointerRouter;
  /** Pointer ids routed to the stand-in stick (left half) and the catch-all pitch-gesture recorder. */
  stick: string[];
  gest: string[];
  at(slot: ClusterSlot): { x: number; y: number };
  events(): Ev[];
  edges(id?: TouchButtonId): TouchEdge[];
  clear(): void;
  /** Mode change as the mapper makes it (TouchIntentState.mode), then a frame (controller update). */
  setMode(mode: ClusterMode, t: number): void;
}

/**
 * The right-hand cluster as index.ts wires it: attack set (TCH-03) + defence set + controller, behind the routing
 * core with a stand-in stick (left half) and a catch-all pitch-gesture control (TCH-01 priority order).
 */
function rig(mode: ClusterMode = ATTACK, opts: DefenceClusterOptions = {}): Rig {
  const st = createTouchIntentState();
  st.mode = mode;
  const layout = computeClusterLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 });
  const attack = createAttackCluster(st, layout, undefined, { hints: opts.hints });
  const defence = createDefenceCluster(st, layout, undefined, opts);
  const ctl = createClusterController({ state: st, attack, defence });
  const stick: string[] = [];
  const gest: string[] = [];
  const recorder = (log: string[], zone: (x: number) => boolean): TouchControl => ({
    hit: (x) => zone(x),
    down: (id) => { log.push(`down#${id}`); },
    move: (id) => { log.push(`move#${id}`); },
    up: (id) => { log.push(`up#${id}`); },
    cancel: (id) => { log.push(`cancel#${id}`); },
    releaseAll: () => { /* nothing held */ },
  });
  const router = createPointerRouter([...ctl.controls, recorder(stick, (x) => x < W / 2), recorder(gest, () => true)]);
  ctl.update(0);
  return {
    st, layout, attack, defence, ctl, router, stick, gest,
    at: (slot) => ({ x: layout.slots[slot].cx, y: layout.slots[slot].cy }),
    events: () => Array.from({ length: st.buttonEventCount }, (_, i) => {
      const e = st.buttonEvents[i]!;
      return [e.button, e.edge, e.dir, e.mode] as Ev;
    }),
    edges: (id) => {
      const out: TouchEdge[] = [];
      for (let i = 0; i < st.buttonEventCount; i++) if (id === undefined || st.buttonEvents[i]!.button === id) out.push(st.buttonEvents[i]!.edge);
      return out;
    },
    clear: () => { st.buttonEventCount = 0; },
    setMode(m, t) {
      st.mode = m;
      ctl.update(t);
    },
  };
}

/** Synthetic pointer paths on a slot centre. */
const path = {
  down(r: Rig, slot: ClusterSlot, pid: number, t: number): number {
    const c = r.at(slot);
    return r.router.down(pid, c.x, c.y, t);
  },
  up(r: Rig, slot: ClusterSlot, pid: number, t: number): void {
    const c = r.at(slot);
    r.router.up(pid, c.x, c.y, t);
  },
  tap(r: Rig, slot: ClusterSlot, t0: number, pid = 1): number {
    path.down(r, slot, pid, t0);
    path.up(r, slot, pid, t0 + 60);
    return t0 + 60;
  },
  /** Swipe of `len` pt in screen direction (vx, vy) in 4 moves, 16 ms apart, then lift. */
  swipe(r: Rig, slot: ClusterSlot, vx: number, vy: number, t0: number, len = SWIPE + 6, pid = 1): number {
    const c = r.at(slot);
    r.router.down(pid, c.x, c.y, t0);
    let t = t0;
    for (let k = 1; k <= 4; k++) {
      t += 16;
      r.router.move(pid, c.x + (vx * len * k) / 4, c.y + (vy * len * k) / 4, t);
    }
    r.router.up(pid, c.x + vx * len, c.y + vy * len, t + 16);
    return t + 16;
  },
  hold(r: Rig, slot: ClusterSlot, ms: number, t0: number, pid = 1): number {
    path.down(r, slot, pid, t0);
    for (let t = t0 + 16; t <= t0 + ms; t += 16) r.ctl.update(t);
    path.up(r, slot, pid, t0 + ms);
    return t0 + ms;
  },
};

/** A SimState with home (side 0) human P1 controlling `slot`. */
function scene(extra: Parameters<typeof makeScenario>[0] = {}, slot = 9): SimState {
  return makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot }], ...extra });
}

// ============================================================ pure mode rules

describe('TCH-04 cluster mode rules (pure)', () => {
  it('possession rule: own carrier -> ATTACK, opponent carrier -> DEFENCE, own keeper in hands -> KEEPER', () => {
    const s = scene();
    s.ball.owner = 7; s.ball.heldBy = -1;
    expect(chooseClusterMode(s, 0)).toBe(ATTACK);
    expect(chooseClusterMode(s, 1)).toBe(DEFENCE);
    s.ball.owner = 14;
    expect(chooseClusterMode(s, 0)).toBe(DEFENCE);
    expect(chooseClusterMode(s, 1)).toBe(ATTACK);
    s.ball.owner = 0; s.ball.heldBy = 0; // home keeper holds it
    expect(chooseClusterMode(s, 0)).toBe(KEEPER);
    expect(chooseClusterMode(s, 1)).toBe(DEFENCE);
    s.ball.owner = 11; s.ball.heldBy = 11;
    expect(chooseClusterMode(s, 0)).toBe(DEFENCE);
    expect(chooseClusterMode(s, 1)).toBe(KEEPER);
  });

  it('a loose ball belongs to the team that touched it last (no flicker while it is loose, DECISIONS D-012)', () => {
    const s = scene();
    s.ball.owner = -1; s.ball.heldBy = -1;
    s.ball.lastTouchTeam = -1;
    expect(chooseClusterMode(s, 0)).toBe(ATTACK);
    expect(chooseClusterMode(s, 1)).toBe(ATTACK);
    s.ball.lastTouchTeam = 0;
    expect(chooseClusterMode(s, 0)).toBe(ATTACK);
    expect(chooseClusterMode(s, 1)).toBe(DEFENCE);
    s.ball.lastTouchTeam = 1;
    expect(chooseClusterMode(s, 0)).toBe(DEFENCE);
    expect(chooseClusterMode(s, 1)).toBe(ATTACK);
  });

  it('no state or no side: ATTACK; controlledSlot finds the human on that side', () => {
    expect(chooseClusterMode(null, 0)).toBe(ATTACK);
    expect(clusterModeFor(null, 0)).toBe(ATTACK);
    const s = scene();
    expect(chooseClusterMode(s, -1)).toBe(ATTACK);
    expect(controlledSlot(s, 0)).toBe(9);
    expect(controlledSlot(s, 0, 0)).toBe(9);
    expect(controlledSlot(s, 0, 1)).toBe(-1);
    expect(controlledSlot(s, 1)).toBe(-1);
    expect(controlledSlot(null, 0)).toBe(-1);
    expect(controlledSlot(s, -1)).toBe(-1);
  });

  it('cut-scenes and breaks hide the cluster; the shoot-out is a set piece for both sides', () => {
    const s = scene();
    for (const ph of [MatchPhase.PRE_MATCH, MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME,
      MatchPhase.FULL_TIME, MatchPhase.EXTRA_TIME, MatchPhase.POST_MATCH]) {
      s.match.phase = ph;
      expect(clusterModeFor(s, 0), MatchPhase[ph]).toBe(HIDDEN);
      expect(clusterModeFor(s, 1), MatchPhase[ph]).toBe(HIDDEN);
    }
    s.match.phase = MatchPhase.SHOOT_OUT;
    expect(clusterModeFor(s, 0)).toBe(SET_PIECE);
    expect(clusterModeFor(s, 1)).toBe(SET_PIECE);
  });

  it('restarts: the taking side gets the set piece, the other side defends (keeper dive at a penalty)', () => {
    const s = scene();
    s.ball.owner = -1; s.ball.heldBy = -1; s.ball.lastTouchTeam = 0;
    for (const ph of [MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.FREE_KICK]) {
      s.match.phase = ph;
      s.match.restart.team = 1;
      s.match.restart.taken = 0;
      expect(clusterModeFor(s, 1), MatchPhase[ph]).toBe(SET_PIECE);
      expect(clusterModeFor(s, 0), MatchPhase[ph]).toBe(DEFENCE);
      // Once played, the possession rule takes over again (home touched it last here).
      s.match.restart.taken = 1;
      expect(clusterModeFor(s, 0), MatchPhase[ph]).toBe(ATTACK);
    }
    s.match.phase = MatchPhase.PENALTY;
    s.match.restart.team = 1;
    s.match.restart.taken = 0;
    expect(clusterModeFor(s, 1)).toBe(SET_PIECE);
    expect(clusterModeFor(s, 0)).toBe(SET_PIECE);
  });

  it('open play: own keeper in hands -> KEEPER only for the human controlling him (or when none is known)', () => {
    const s = scene({}, 0);
    s.ball.owner = 0; s.ball.heldBy = 0;
    expect(clusterModeFor(s, 0)).toBe(KEEPER);
    expect(clusterModeFor(s, 0, 0)).toBe(KEEPER);
    expect(clusterModeFor(s, 1)).toBe(DEFENCE);
    const t = scene({}, 9);
    t.ball.owner = 0; t.ball.heldBy = 0;
    expect(clusterModeFor(t, 0)).toBe(ATTACK);
    const u = makeScenario({ phase: MatchPhase.IN_PLAY }); // no humans
    u.ball.owner = 0; u.ball.heldBy = 0;
    expect(clusterModeFor(u, 0)).toBe(KEEPER);
    // Plain possession otherwise.
    t.ball.heldBy = -1; t.ball.owner = 15;
    expect(clusterModeFor(t, 0)).toBe(DEFENCE);
    t.ball.owner = 3;
    expect(clusterModeFor(t, 0)).toBe(ATTACK);
  });
});

describe('TCH-04 CLEAR rule (clearanceOn mirrors SIM-15 first-time clearance)', () => {
  const loose = { owner: -1, heldBy: -1, lastTouch: 15, lastTouchTeam: 1, lastTouchTick: -100 };

  it('a loose ground ball about to reach the controlled player in his own third turns CLEAR on', () => {
    const s = scene({
      players: [{ slot: 9, x: -35, z: 0, vx: 0, vz: 0 }],
      ball: { x: -41, y: 0.11, z: 0, vx: 14, vy: 0, vz: 0, grounded: 1, ...loose },
    });
    const eta = ballEta(s, 9);
    expect(eta).toBeGreaterThanOrEqual(0);
    expect(eta).toBeLessThanOrEqual(RESOLVE_TUNING.clearArriveTicks);
    expect(clearanceOn(s, 0)).toBe(true);
    expect(clearanceOn(s, 0, 0)).toBe(true);
    // Not for the other side, nor for a human who is not on it.
    expect(clearanceOn(s, 1)).toBe(false);
    expect(clearanceOn(s, 0, 1)).toBe(false);
  });

  it('a high ball the player can head or volley in his own third turns CLEAR on (not arriving on the ground)', () => {
    const s = scene({
      players: [{ slot: 9, x: -35, z: 0, vx: 0, vz: 0, fx: 1, fz: 0 }],
      ball: { x: -38, y: 3, z: 0, vx: 4, vy: 0, vz: 0, grounded: 0, ...loose },
    });
    expect(ballEta(s, 9) > RESOLVE_TUNING.clearArriveTicks || ballEta(s, 9) < 0).toBe(true);
    expect(aerialChance(s, 9)).toBeGreaterThan(0);
    expect(clearanceOn(s, 0)).toBe(true);
  });

  it('off: outside the own third, ball not arriving, ball owned or held, not in play, no human', () => {
    const arriving = { x: -41, y: 0.11, z: 0, vx: 14, vy: 0, vz: 0, grounded: 1, ...loose };
    // Same arrival in the opponents' third (home attacks +x in the first half).
    const far = scene({ players: [{ slot: 9, x: 35, z: 0, vx: 0, vz: 0 }], ball: { ...arriving, x: 29 } });
    expect(ballEta(far, 9)).toBeGreaterThanOrEqual(0);
    expect(clearanceOn(far, 0)).toBe(false);
    // Rolling away from him.
    const away = scene({ players: [{ slot: 9, x: -35, z: 0, vx: 0, vz: 0 }], ball: { ...arriving, vx: -14 } });
    expect(clearanceOn(away, 0)).toBe(false);
    // Too far away to arrive in time.
    const slow = scene({ players: [{ slot: 9, x: -20, z: 0, vx: 0, vz: 0 }], ball: { ...arriving, x: -50, vx: 3 } });
    expect(clearanceOn(slow, 0)).toBe(false);
    const s = scene({ players: [{ slot: 9, x: -35, z: 0, vx: 0, vz: 0 }], ball: arriving });
    expect(clearanceOn(s, 0)).toBe(true);
    s.ball.owner = 14;
    expect(clearanceOn(s, 0)).toBe(false);
    s.ball.owner = 0; s.ball.heldBy = 0;
    expect(clearanceOn(s, 0)).toBe(false);
    s.ball.owner = -1; s.ball.heldBy = -1;
    s.match.phase = MatchPhase.CORNER;
    expect(clearanceOn(s, 0)).toBe(false);
    s.match.phase = MatchPhase.IN_PLAY;
    s.ball.inNet = 1;
    expect(clearanceOn(s, 0)).toBe(false);
    s.ball.inNet = 0;
    expect(clearanceOn(s, 0)).toBe(true);
    expect(clearanceOn(null, 0)).toBe(false);
    const none = makeScenario({ phase: MatchPhase.IN_PLAY, ball: arriving });
    expect(clearanceOn(none, 0)).toBe(false);
  });
});

// ============================================================ identities and labels

describe('TCH-04 identities and labels (pure)', () => {
  it('defence buttons sit on the contract slots (SWITCH low, 2ND DEF mid, SLIDE high, SPRINT & TACKLE big)', () => {
    expect(DEFENCE_BUTTONS.map(([slot, id, label]) => [slot, id, label])).toEqual([
      [BIG, SPRINT_TACKLE, 'TACKLE'], [LOW, SWITCH, 'SWITCH'], [MID, SECOND_DEF, '2ND DEF'], [HIGH, SLIDE, 'SLIDE'],
    ]);
    for (const [slot, id] of DEFENCE_BUTTONS) {
      expect(CLUSTER_SLOT[id]).toBe(slot);
      expect(SLOT_DEFENCE_BUTTON[slot]).toBe(id);
    }
    for (let id = PASS; id <= SECOND_DEF; id++) {
      expect(isAttackButton(id) !== isDefenceButton(id)).toBe(true);
      expect(isDefenceButton(id)).toBe(id >= SPRINT_TACKLE);
    }
    expect(isAttackButton(TouchButtonId.PAUSE) || isDefenceButton(TouchButtonId.PAUSE) || isAttackButton(-1)).toBe(false);
    expect(defenceSetActive(DEFENCE)).toBe(true);
    for (const m of [ATTACK, KEEPER, SET_PIECE, HIDDEN]) expect(defenceSetActive(m)).toBe(false);
  });

  it('each mode gives every slot its identity: attack ids in ATTACK / KEEPER / SET_PIECE, defence ids in DEFENCE, none when hidden', () => {
    for (const s of SLOTS) {
      for (const m of [ATTACK, KEEPER, SET_PIECE]) expect(slotButton(m, s)).toBe(SLOT_ATTACK_BUTTON[s]);
      expect(slotButton(DEFENCE, s)).toBe(SLOT_DEFENCE_BUTTON[s]);
      expect(slotButton(HIDDEN, s)).toBe(-1);
      expect(slotLabel(HIDDEN, s, false)).toBe('');
    }
    expect(slotButton(ATTACK, 4 as ClusterSlot)).toBe(-1);
    expect(slotButton(DEFENCE, -1 as ClusterSlot)).toBe(-1);
    expect(SLOTS.map((s) => slotLabel(ATTACK, s, false))).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
    expect(SLOTS.map((s) => slotLabel(SET_PIECE, s, false))).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
    expect(SLOTS.map((s) => slotLabel(DEFENCE, s, false))).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
  });

  it('keeper mode identities: PASS throws, THROUGH is a driven throw, SHOOT a drop kick, SPRINT & SKILL drops the ball', () => {
    expect(buttonLabel(PASS, KEEPER, false)).toBe('THROW');
    expect(buttonLabel(THROUGH, KEEPER, false)).toBe('DRIVEN THROW');
    expect(buttonLabel(SHOOT, KEEPER, false)).toBe('DROP KICK');
    expect(buttonLabel(SPRINT_SKILL, KEEPER, false)).toBe('DROP');
    expect(SLOTS.map((s) => slotButton(KEEPER, s))).toEqual([SPRINT_SKILL, PASS, THROUGH, SHOOT]);
    expect(SLOTS.map((s) => slotLabel(KEEPER, s, true))).toEqual([...KEEPER_LABELS]);
    // The keeper row has no swipes (no hints) and no double tap; KEEPER never relabels a defence button.
    expect(buttonLabel(SLIDE, KEEPER, false)).toBe('SLIDE');
  });

  it('CLEAR replaces SLIDE only: clearOn relabels the high slot in DEFENCE, never SHOOT or another button', () => {
    expect(slotLabel(DEFENCE, HIGH, true)).toBe(CLEAR_LABEL);
    expect(slotLabel(DEFENCE, HIGH, false)).toBe('SLIDE');
    expect(slotLabel(ATTACK, HIGH, true)).toBe('SHOOT');
    expect(slotLabel(KEEPER, HIGH, true)).toBe('DROP KICK');
    for (const s of [BIG, LOW, MID]) expect(slotLabel(DEFENCE, s, true)).toBe(slotLabel(DEFENCE, s, false));
    expect(buttonLabel(-1, DEFENCE, true)).toBe('');
    expect(buttonLabel(99 as TouchButtonId, DEFENCE, true)).toBe('');
    expect(buttonLabel(TouchButtonId.PAUSE, ATTACK, false)).toBe('');
  });

  it('defence swipe table: SPRINT & TACKLE left = hard tackle, SWITCH any direction, 2ND DEF down = keeper rushes out, SLIDE none', () => {
    const bit = (d: SwipeDir): number => 1 << d;
    expect(defenceSwipeHintMask(SPRINT_TACKLE, DEFENCE)).toBe(bit(SwipeDir.LEFT));
    expect(defenceSwipeHintMask(SWITCH, DEFENCE)).toBe(bit(SwipeDir.UP) | bit(SwipeDir.DOWN) | bit(SwipeDir.LEFT) | bit(SwipeDir.RIGHT));
    expect(defenceSwipeHintMask(SECOND_DEF, DEFENCE)).toBe(bit(SwipeDir.DOWN));
    expect(defenceSwipeHintMask(SLIDE, DEFENCE)).toBe(0);
    for (const id of [PASS, THROUGH, SHOOT, SPRINT_SKILL, TouchButtonId.PAUSE]) expect(defenceSwipeHintMask(id, DEFENCE)).toBe(0);
    for (const m of [ATTACK, KEEPER, SET_PIECE, HIDDEN]) expect(defenceSwipeHintMask(SWITCH, m)).toBe(0);
    expect(DEFENCE_SWIPE_HINTS[SPRINT_TACKLE]![SwipeDir.LEFT]).toBe('Hard tackle');
    expect(DEFENCE_SWIPE_HINTS[SECOND_DEF]![SwipeDir.DOWN]).toBe('Keeper rush');
    expect(DEFENCE_SWIPE_HINTS.length).toBe(TouchButtonId.PAUSE + 1);
  });

  it('swipeVector: unit screen vectors (y down) for the four directions, zero for NONE', () => {
    const v = { x: 9, y: 9 };
    for (const d of DIRS) {
      swipeVector(d, v);
      expect([v.x, v.y]).toEqual(DIR_VEC[d]);
    }
    expect(swipeVector(SwipeDir.NONE, v)).toEqual({ x: 0, y: 0 });
  });
});

// ============================================================ the swap rule (pure)

describe('TCH-04 swap rule (slotMeaning, pure)', () => {
  const press = (pressId: TouchButtonId | -1, pressMode: ClusterMode, pressLabel?: string): SlotPress => ({ pressId, pressMode, pressLabel });
  const up = press(-1, ATTACK);

  it('no finger down: the slot shows the current mode\'s button (CLEAR when on)', () => {
    const m = createSlotMeaning();
    expect(slotMeaning(DEFENCE, false, BIG, up, up, m)).toEqual({ id: SPRINT_TACKLE, mode: DEFENCE, label: 'TACKLE', pressed: false });
    expect(slotMeaning(DEFENCE, true, HIGH, null, null, m)).toEqual({ id: SLIDE, mode: DEFENCE, label: 'CLEAR', pressed: false });
    expect(slotMeaning(KEEPER, false, LOW, up, null, m)).toEqual({ id: PASS, mode: KEEPER, label: 'THROW', pressed: false });
    expect(slotMeaning(HIDDEN, false, LOW, up, up, m)).toEqual({ id: -1, mode: HIDDEN, label: '', pressed: false });
  });

  it('a thumb already down keeps its old meaning until it lifts (the swapped-out set\'s press is shown)', () => {
    const m = createSlotMeaning();
    // Possession lost while the thumb holds SPRINT: the live set is now defence, the press belongs to attack.
    expect(slotMeaning(DEFENCE, false, BIG, up, press(SPRINT_SKILL, ATTACK), m)).toEqual({ id: SPRINT_SKILL, mode: ATTACK, label: 'SPRINT', pressed: true });
    // Ball won while the thumb holds SLIDE that went down as CLEAR: still CLEAR.
    expect(slotMeaning(ATTACK, false, HIGH, up, press(SLIDE, DEFENCE, 'CLEAR'), m)).toEqual({ id: SLIDE, mode: DEFENCE, label: 'CLEAR', pressed: true });
    // Keeper caught it while PASS was down in open play: PASS, not THROW, until the lift.
    expect(slotMeaning(KEEPER, false, LOW, press(PASS, ATTACK), null, m)).toEqual({ id: PASS, mode: ATTACK, label: 'PASS', pressed: true });
    // And the other way round.
    expect(slotMeaning(ATTACK, false, LOW, press(PASS, KEEPER), null, m).label).toBe('THROW');
  });

  it('two presses on one slot (old thumb + a new finger on the swapped slot): the live set\'s press wins', () => {
    const m = createSlotMeaning();
    expect(slotMeaning(DEFENCE, false, BIG, press(SPRINT_TACKLE, DEFENCE, 'TACKLE'), press(SPRINT_SKILL, ATTACK), m))
      .toEqual({ id: SPRINT_TACKLE, mode: DEFENCE, label: 'TACKLE', pressed: true });
  });
});

// ============================================================ the controller with real pointers

describe('TCH-04 attack-defence swap through the pointer router (thumb down keeps its meaning)', () => {
  it('possession lost mid-sprint: the held SPRINT stays SPRINT (events, held bit, label) until it lifts; new touches defend', () => {
    const r = rig(ATTACK);
    const sprintIdx = r.router.controls.indexOf(r.attack.slot(BIG));
    expect(path.down(r, BIG, 1, 1000)).toBe(sprintIdx);
    r.ctl.update(1000);
    expect(r.ctl.labels[BIG]).toBe('SPRINT');
    expect(r.ctl.pressed).toBe(1 << BIG);
    r.setMode(DEFENCE, 1050); // the mapper saw the turnover
    expect(r.ctl.swaps).toBe(1);
    expect(r.ctl.mode).toBe(DEFENCE);
    // The held slot still means SPRINT; the others swapped at once.
    expect([...r.ctl.ids]).toEqual([SPRINT_SKILL, SWITCH, SECOND_DEF, SLIDE]);
    expect([...r.ctl.labels]).toEqual(['SPRINT', 'SWITCH', '2ND DEF', 'SLIDE']);
    expect([...r.ctl.modes]).toEqual([ATTACK, DEFENCE, DEFENCE, DEFENCE]);
    expect(r.st.held).toBe(1 << SPRINT_SKILL);
    // The pointer stays with the attack button: HOLD and a swipe left are SPRINT & SKILL's (hard stop), not a hard tackle.
    r.ctl.update(1000 + TAP_MS + 20);
    const c = r.at(BIG);
    r.router.move(1, c.x - SWIPE - 4, c.y, 1300);
    expect(r.router.ownerOf(1)).toBe(sprintIdx);
    // A second finger on LOW is SWITCH (the live set).
    expect(path.down(r, LOW, 2, 1320)).toBe(r.router.controls.indexOf(r.defence.slot(LOW)));
    path.up(r, LOW, 2, 1380);
    r.router.up(1, c.x - SWIPE - 4, c.y, 1400);
    expect(r.events()).toEqual([
      [SPRINT_SKILL, DOWN, 0, ATTACK],
      [SPRINT_SKILL, HOLD, 0, ATTACK],
      [SPRINT_SKILL, SW, SwipeDir.LEFT, ATTACK],
      [SWITCH, DOWN, 0, DEFENCE],
      [SWITCH, UP, 0, DEFENCE],
      [SWITCH, TAP, 0, DEFENCE],
      [SPRINT_SKILL, UP, 0, ATTACK],
    ]);
    expect(r.st.held).toBe(0);
    // Lifted: the slot now shows the current meaning, and the next touch there tackles.
    r.ctl.update(1410);
    expect([...r.ctl.labels]).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
    expect(r.ctl.pressed).toBe(0);
    r.clear();
    path.tap(r, BIG, 1500, 3);
    expect(r.events()).toEqual([[SPRINT_TACKLE, DOWN, 0, DEFENCE], [SPRINT_TACKLE, UP, 0, DEFENCE], [SPRINT_TACKLE, TAP, 0, DEFENCE]]);
  });

  it('ball won while pressing: the held SPRINT & TACKLE and 2ND DEF keep their defence meaning; PASS goes to attack', () => {
    const r = rig(DEFENCE);
    path.down(r, BIG, 1, 1000);
    path.down(r, MID, 2, 1010);
    r.ctl.update(1000 + TAP_MS + 30); // both holding (sprint + keep the second defender pressing)
    expect(r.st.held).toBe((1 << SPRINT_TACKLE) | (1 << SECOND_DEF));
    r.setMode(ATTACK, 1200);
    expect([...r.ctl.labels]).toEqual(['TACKLE', 'PASS', '2ND DEF', 'SHOOT']);
    expect([...r.ctl.ids]).toEqual([SPRINT_TACKLE, PASS, SECOND_DEF, SHOOT]);
    expect(r.ctl.pressed).toBe((1 << BIG) | (1 << MID));
    r.clear();
    path.tap(r, LOW, 1220, 3);
    path.up(r, MID, 2, 1300);
    path.up(r, BIG, 1, 1320);
    expect(r.events()).toEqual([
      [PASS, DOWN, 0, ATTACK], [PASS, UP, 0, ATTACK], [PASS, TAP, 0, ATTACK],
      [SECOND_DEF, UP, 0, DEFENCE],
      [SPRINT_TACKLE, UP, 0, DEFENCE],
    ]);
    r.ctl.update(1330);
    expect([...r.ctl.labels]).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
  });

  it('a new finger on a slot whose old thumb is still down gets the new meaning; the slot shows the live press', () => {
    const r = rig(ATTACK);
    path.down(r, BIG, 1, 1000);
    r.setMode(DEFENCE, 1050);
    const c = r.at(BIG);
    expect(r.router.down(2, c.x + 5, c.y + 5, 1060)).toBe(r.router.controls.indexOf(r.defence.slot(BIG)));
    r.ctl.update(1070);
    expect(r.st.held).toBe((1 << SPRINT_SKILL) | (1 << SPRINT_TACKLE));
    expect(r.ctl.labels[BIG]).toBe('TACKLE');
    path.up(r, BIG, 2, 1100);
    r.ctl.update(1110);
    expect(r.ctl.labels[BIG]).toBe('SPRINT'); // the old thumb is still down
    path.up(r, BIG, 1, 1200);
    r.ctl.update(1210);
    expect(r.ctl.labels[BIG]).toBe('TACKLE');
  });

  it('keeper catches it: the cluster swaps to the keeper row; a thumb down keeps PASS until it lifts', () => {
    const r = rig(ATTACK);
    path.down(r, LOW, 1, 1000);
    r.setMode(KEEPER, 1050);
    expect([...r.ctl.labels]).toEqual(['DROP', 'PASS', 'DRIVEN THROW', 'DROP KICK']);
    path.up(r, LOW, 1, 1100);
    r.ctl.update(1110);
    expect([...r.ctl.labels]).toEqual([...KEEPER_LABELS]);
    expect([...r.ctl.ids]).toEqual([SPRINT_SKILL, PASS, THROUGH, SHOOT]);
    r.clear();
    // Keeper row: every press carries KEEPER; two quick taps are two throws (no double tap), any travel is no hint.
    path.tap(r, LOW, 1200);
    path.tap(r, LOW, 1300);
    path.tap(r, MID, 1400);
    path.tap(r, HIGH, 1500);
    path.tap(r, BIG, 1600);
    const taps = r.events().filter((e) => e[1] === TAP || e[1] === DOUBLE_TAP);
    expect(taps).toEqual([
      [PASS, TAP, 0, KEEPER], [PASS, TAP, 0, KEEPER], [THROUGH, TAP, 0, KEEPER], [SHOOT, TAP, 0, KEEPER], [SPRINT_SKILL, TAP, 0, KEEPER],
    ]);
    // The keeper releases it: back to open play.
    r.setMode(ATTACK, 1700);
    expect([...r.ctl.labels]).toEqual(['SPRINT', 'PASS', 'THROUGH', 'SHOOT']);
  });

  it('hidden (cut-scene): the slots show nothing and claim nothing (taps fall through to the pitch = skip); a held thumb keeps its press', () => {
    const r = rig(ATTACK);
    path.down(r, BIG, 1, 1000);
    r.setMode(HIDDEN, 1050);
    expect([...r.ctl.ids]).toEqual([SPRINT_SKILL, -1, -1, -1]);
    expect([...r.ctl.labels]).toEqual(['SPRINT', '', '', '']);
    expect(path.down(r, HIGH, 2, 1060)).toBe(r.router.controls.length - 1); // the pitch-gesture control
    expect(r.gest).toEqual(['down#2']);
    path.up(r, BIG, 1, 1100);
    r.ctl.update(1110);
    expect([...r.ctl.labels]).toEqual(['', '', '', '']);
    expect(r.st.held).toBe(0);
  });

  it('only the live set claims touches: attack in ATTACK / KEEPER / SET_PIECE, defence in DEFENCE', () => {
    for (const m of [ATTACK, KEEPER, SET_PIECE, DEFENCE, HIDDEN]) {
      const r = rig(m);
      for (const s of SLOTS) {
        const c = r.at(s);
        const a = r.attack.slot(s).hit(c.x, c.y);
        const d = r.defence.slot(s).hit(c.x, c.y);
        expect(d, `${ClusterMode[m]} slot ${s}`).toBe(m === DEFENCE);
        expect(a, `${ClusterMode[m]} slot ${s}`).toBe(m === ATTACK || m === KEEPER || m === SET_PIECE);
        expect(r.defence.live(SLOT_DEFENCE_BUTTON[s]!)).toBe(m === DEFENCE);
      }
    }
    // A caller-supplied rule replaces the default.
    const st = createTouchIntentState();
    st.mode = ATTACK;
    const layout = computeClusterLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 });
    let on = true;
    const d = createDefenceCluster(st, layout, () => on);
    const c = layout.slots[LOW];
    expect(d.slot(LOW).hit(c.cx, c.cy)).toBe(true);
    on = false;
    expect(d.slot(LOW).hit(c.cx, c.cy)).toBe(false);
  });

  it('no double tap across a swap: a lifted thumb starts fresh in the new possession', () => {
    const control = rig(ATTACK);
    path.tap(control, LOW, 1000);
    control.ctl.update(1100);
    path.tap(control, LOW, 1200);
    expect(control.edges(PASS)).toContain(DOUBLE_TAP); // baseline: PASS has a double tap
    const r = rig(ATTACK);
    path.tap(r, LOW, 1000);
    r.setMode(DEFENCE, 1080);
    r.setMode(ATTACK, 1150);
    path.tap(r, LOW, 1200);
    expect(r.edges(PASS).filter((e) => e === TAP || e === DOUBLE_TAP)).toEqual([TAP, TAP]);
  });

  it('slot view: version changes only when ids / labels / pressed change; slot() copies the view', () => {
    const r = rig(DEFENCE);
    const v0 = r.ctl.version;
    r.ctl.update(10);
    r.ctl.sync(11);
    expect(r.ctl.version).toBe(v0);
    path.down(r, LOW, 1, 20);
    r.ctl.sync(20);
    expect(r.ctl.version).toBe(v0 + 1);
    const m = r.ctl.slot(LOW, createSlotMeaning());
    expect(m).toEqual({ id: SWITCH, mode: DEFENCE, label: 'SWITCH', pressed: true });
    path.up(r, LOW, 1, 40);
    r.ctl.sync(41);
    expect(r.ctl.version).toBe(v0 + 2);
    r.st.clearOn = true;
    r.ctl.sync(50);
    expect(r.ctl.version).toBe(v0 + 3);
    expect(r.ctl.labels[HIGH]).toBe('CLEAR');
    r.setMode(ATTACK, 60);
    expect(r.ctl.version).toBe(v0 + 4);
    expect(r.ctl.swaps).toBe(1);
    r.ctl.sync(61);
    expect(r.ctl.version).toBe(v0 + 4);
  });

  it('relayout moves both sets; hit tests follow the new geometry', () => {
    const r = rig(DEFENCE);
    const l = computeClusterLayout(1024, 768, { top: 0, right: 40, bottom: 20, left: 0 }, { mirror: true });
    r.ctl.relayout(l);
    for (const s of SLOTS) {
      expect({ ...r.defence.slot(s).geom }).toEqual(l.slots[s]);
      expect({ ...r.attack.slot(s).geom }).toEqual(l.slots[s]);
      expect(r.defence.slot(s).hit(l.slots[s].cx, l.slots[s].cy)).toBe(true);
    }
  });

  it('inside overlapping slop the nearest live defence button wins', () => {
    const st = createTouchIntentState();
    st.mode = DEFENCE;
    const l = createClusterLayout();
    const g = (s: ClusterSlot, cx: number, cy: number, r: number): void => { l.slots[s].cx = cx; l.slots[s].cy = cy; l.slots[s].r = r; };
    g(HIGH, 500, 500, 38);
    g(MID, 500 + 76 + 10, 500, 38); // rims 10 px apart: the 8 px slops overlap
    g(LOW, 100, 100, 38);
    g(BIG, 900, 700, 48);
    const d = createDefenceCluster(st, l);
    const router = createPointerRouter(d.controls);
    // 6 px outside SLIDE's rim, 4 px outside 2ND DEF's: 2ND DEF.
    expect(router.down(1, 544, 500, 0)).toBe(d.controls.indexOf(d.slot(MID)));
    // 3 px outside SLIDE's rim, 7 px outside 2ND DEF's: SLIDE.
    expect(router.down(2, 541, 500, 0)).toBe(d.controls.indexOf(d.slot(HIGH)));
    // Beyond the slop of both: nobody.
    expect(d.slot(HIGH).hit(500, 500 - 38 - BUTTON_SLOP - 1)).toBe(false);
    expect(d.slot(HIGH).hit(500, 500 - 38 - BUTTON_SLOP + 1)).toBe(true);
  });
});

// ============================================================ the defence table

describe('TCH-04 section 9 defence table reaches the queue (tap / hold / swipe)', () => {
  it('SPRINT & TACKLE: tap = tackle, hold = sprint / press (held bit), swipe left = hard tackle', () => {
    const r = rig(DEFENCE);
    path.tap(r, BIG, 1000);
    expect(r.events()).toEqual([[SPRINT_TACKLE, DOWN, 0, DEFENCE], [SPRINT_TACKLE, UP, 0, DEFENCE], [SPRINT_TACKLE, TAP, 0, DEFENCE]]);
    r.clear();
    path.down(r, BIG, 1, 2000);
    r.ctl.update(2000 + TAP_MS + 1);
    expect(r.st.held).toBe(1 << SPRINT_TACKLE);
    expect(r.st.downAt[SPRINT_TACKLE]).toBe(2000);
    expect(r.edges()).toEqual([DOWN, HOLD]);
    path.up(r, BIG, 1, 2600);
    expect(r.edges()).toEqual([DOWN, HOLD, UP]);
    r.clear();
    path.swipe(r, BIG, -1, 0, 3000);
    expect(r.events()).toEqual([[SPRINT_TACKLE, DOWN, 0, DEFENCE], [SPRINT_TACKLE, SW, SwipeDir.LEFT, DEFENCE], [SPRINT_TACKLE, UP, 0, DEFENCE]]);
  });

  it('SLIDE: tap = slide tackle; 2ND DEF: tap = call, hold = keep pressing, swipe down = keeper rushes out', () => {
    const r = rig(DEFENCE);
    path.tap(r, HIGH, 1000);
    expect(r.events()).toEqual([[SLIDE, DOWN, 0, DEFENCE], [SLIDE, UP, 0, DEFENCE], [SLIDE, TAP, 0, DEFENCE]]);
    r.clear();
    path.tap(r, MID, 2000);
    expect(r.edges(SECOND_DEF)).toEqual([DOWN, UP, TAP]);
    r.clear();
    path.hold(r, MID, 900, 3000);
    expect(r.edges(SECOND_DEF)).toEqual([DOWN, HOLD, UP]);
    r.clear();
    path.swipe(r, MID, 0, 1, 5000);
    expect(r.events()).toEqual([[SECOND_DEF, DOWN, 0, DEFENCE], [SECOND_DEF, SW, SwipeDir.DOWN, DEFENCE], [SECOND_DEF, UP, 0, DEFENCE]]);
  });

  it('no defence button has a double tap: two quick taps are two taps', () => {
    for (const s of SLOTS) {
      const r = rig(DEFENCE);
      path.tap(r, s, 1000);
      path.tap(r, s, 1100);
      expect(r.edges().filter((e) => e === TAP || e === DOUBLE_TAP), `slot ${s}`).toEqual([TAP, TAP]);
    }
  });
});

describe('TCH-04 SWITCH swipes carry their direction', () => {
  it('a swipe in each direction is a SWITCH swipe that way: SwipeDir in the event and the exact unit vector in swipeAim', () => {
    const r = rig(DEFENCE);
    let t = 1000;
    let seq = r.defence.swipeAim(SWITCH).seq;
    for (const d of DIRS) {
      r.clear();
      const [vx, vy] = DIR_VEC[d]!;
      t = path.swipe(r, LOW, vx, vy, t) + 100;
      const sw = r.events().filter((e) => e[1] === SW);
      expect(sw).toEqual([[SWITCH, SW, d, DEFENCE]]);
      const aim = r.defence.swipeAim(SWITCH);
      expect(aim.button).toBe(SWITCH);
      expect(aim.mode).toBe(DEFENCE);
      expect(aim.dir).toBe(d);
      expect(aim.dx).toBeCloseTo(vx, 9);
      expect(aim.dy).toBeCloseTo(vy, 9);
      expect(aim.seq).toBe(++seq);
      // Matched to its event by time.
      const e = r.st.buttonEvents.slice(0, r.st.buttonEventCount).find((x) => x.edge === SW)!;
      expect(aim.tMs).toBe(e.tMs);
      expect(r.edges(SWITCH)).not.toContain(TAP);
    }
  });

  it('any direction: a diagonal swipe reports its dominant SwipeDir and its exact angle', () => {
    const r = rig(DEFENCE);
    const cases: [number, SwipeDir][] = [[-30, SwipeDir.RIGHT], [-60, SwipeDir.UP], [135, SwipeDir.LEFT], [100, SwipeDir.DOWN], [-170, SwipeDir.LEFT]];
    let t = 1000;
    for (const [deg, dir] of cases) {
      const a = (deg * Math.PI) / 180;
      const vx = Math.cos(a), vy = Math.sin(a);
      r.clear();
      t = path.swipe(r, LOW, vx, vy, t, 40) + 100;
      expect(r.events().filter((e) => e[1] === SW), `${deg} deg`).toEqual([[SWITCH, SW, dir, DEFENCE]]);
      const aim = r.defence.swipeAim(SWITCH);
      expect(aim.dx).toBeCloseTo(vx, 6);
      expect(aim.dy).toBeCloseTo(vy, 6);
      expect(Math.hypot(aim.dx, aim.dy)).toBeCloseTo(1, 9);
    }
  });

  it('a flick after a still hold, and a swipe seen only at the lift, still carry the exact direction', () => {
    const r = rig(DEFENCE);
    const c = r.at(LOW);
    r.router.down(1, c.x, c.y, 1000);
    r.ctl.update(1400); // still finger: HOLD
    r.router.move(1, c.x + 18, c.y - 24, 1420); // flick up-right: dominant up
    r.router.up(1, c.x + 18, c.y - 24, 1440);
    expect(r.edges(SWITCH)).toEqual([DOWN, HOLD, SW, UP]);
    let aim = r.defence.swipeAim(SWITCH);
    expect(aim.dir).toBe(SwipeDir.UP);
    expect(aim.dx).toBeCloseTo(0.6, 9);
    expect(aim.dy).toBeCloseTo(-0.8, 9);
    r.clear();
    r.router.down(2, c.x, c.y, 2000);
    r.router.up(2, c.x - 30, c.y + 40, 2080); // no moves, travel reported by the lift
    expect(r.events()).toEqual([[SWITCH, DOWN, 0, DEFENCE], [SWITCH, SW, SwipeDir.DOWN, DEFENCE], [SWITCH, UP, 0, DEFENCE]]);
    aim = r.defence.swipeAim(SWITCH);
    expect(aim.dx).toBeCloseTo(-0.6, 9);
    expect(aim.dy).toBeCloseTo(0.8, 9);
    expect(aim.tMs).toBe(2080);
  });

  it('below 24 pt it is a tap (switch to the best-placed defender) and the last aim is untouched; other ids have no aim', () => {
    const r = rig(DEFENCE);
    path.swipe(r, LOW, 1, 0, 1000);
    const seq = r.defence.swipeAim(SWITCH).seq;
    r.clear();
    path.swipe(r, LOW, 0, 1, 2000, SWIPE - 6);
    expect(r.edges(SWITCH)).toEqual([DOWN, UP, TAP]);
    expect(r.defence.swipeAim(SWITCH).seq).toBe(seq);
    expect(r.defence.swipeAim(SWITCH).dir).toBe(SwipeDir.RIGHT);
    expect(r.defence.swipeAim(PASS).dir).toBe(SwipeDir.NONE);
    expect(r.defence.swipeAim(PASS).button).toBe(-1);
    // Each button keeps its own aim.
    path.swipe(r, BIG, -1, 0, 3000);
    expect(r.defence.swipeAim(SPRINT_TACKLE).dir).toBe(SwipeDir.LEFT);
    expect(r.defence.swipeAim(SWITCH).dir).toBe(SwipeDir.RIGHT);
  });

  it('irregular paths (jitter, stalls, 500 Hz and 30 Hz moves): the reported vector always agrees with the event direction', () => {
    const r = rig(DEFENCE);
    const c = r.at(LOW);
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    let t = 1000;
    let swipes = 0;
    for (let press = 0; press < 400; press++) {
      r.clear();
      let x = c.x + (rnd() - 0.5) * 60, y = c.y + (rnd() - 0.5) * 60;
      r.router.down(1, x, y, t);
      const heading = rnd() * 2 * Math.PI;
      const moves = 1 + Math.floor(rnd() * 25);
      for (let k = 0; k < moves; k++) {
        t += rnd() < 0.1 ? 200 + rnd() * 300 : 2 + rnd() * 33;
        const step = rnd() * 9;
        x += Math.cos(heading) * step + (rnd() - 0.5) * 4;
        y += Math.sin(heading) * step + (rnd() - 0.5) * 4;
        r.router.move(1, x, y, t);
      }
      t += 10;
      r.router.up(1, x, y, t);
      const sw = r.events().filter((e) => e[1] === SW);
      if (sw.length === 0) continue;
      swipes++;
      expect(sw.length).toBe(1);
      const aim = r.defence.swipeAim(SWITCH);
      expect(aim.dir).toBe(sw[0]![2]);
      expect(Math.hypot(aim.dx, aim.dy)).toBeCloseTo(1, 9);
      const dominant = Math.abs(aim.dx) >= Math.abs(aim.dy)
        ? (aim.dx > 0 ? SwipeDir.RIGHT : SwipeDir.LEFT)
        : (aim.dy > 0 ? SwipeDir.DOWN : SwipeDir.UP);
      expect(dominant).toBe(aim.dir);
      t += 400;
    }
    expect(swipes).toBeGreaterThan(100);
  });

  it('a swipe that starts on SWITCH is a button swipe, never a pitch gesture, even when it ends on the pitch', () => {
    const r = rig(DEFENCE);
    path.swipe(r, LOW, -1, 0, 1000, 300);
    expect(r.gest).toEqual([]);
    expect(r.stick).toEqual([]);
    expect(r.events().filter((e) => e[1] === SW)).toEqual([[SWITCH, SW, SwipeDir.LEFT, DEFENCE]]);
  });
});

describe('TCH-04 CLEAR replaces SLIDE', () => {
  it('clearOn toggles the high slot label between SLIDE and CLEAR in DEFENCE', () => {
    const r = rig(DEFENCE);
    expect(r.ctl.labels[HIGH]).toBe('SLIDE');
    r.st.clearOn = true;
    r.ctl.update(10);
    expect(r.ctl.labels[HIGH]).toBe('CLEAR');
    expect(r.ctl.ids[HIGH]).toBe(SLIDE);
    r.st.clearOn = false;
    r.ctl.update(20);
    expect(r.ctl.labels[HIGH]).toBe('SLIDE');
    // In attack the high slot is SHOOT whatever clearOn says.
    r.st.clearOn = true;
    r.setMode(ATTACK, 30);
    expect(r.ctl.labels[HIGH]).toBe('SHOOT');
  });

  it('a press that went down as CLEAR stays CLEAR until it lifts (label and slideClear), then the slot follows clearOn', () => {
    const r = rig(DEFENCE);
    r.st.clearOn = true;
    path.down(r, HIGH, 1, 1000);
    const slide = r.defence.slot(HIGH);
    expect(slide.pressClear).toBe(true);
    expect(slide.pressLabel).toBe('CLEAR');
    expect(r.defence.slideClear).toBe(true);
    r.st.clearOn = false; // the chance passed while the thumb is down
    r.ctl.update(1050);
    expect(r.ctl.labels[HIGH]).toBe('CLEAR');
    path.up(r, HIGH, 1, 1080);
    // The events are SLIDE's; the mapper reads slideClear for this press (still true after the lift).
    expect(r.events()).toEqual([[SLIDE, DOWN, 0, DEFENCE], [SLIDE, UP, 0, DEFENCE], [SLIDE, TAP, 0, DEFENCE]]);
    expect(r.defence.slideClear).toBe(true);
    expect(slide.pressLabel).toBe('');
    r.ctl.update(1090);
    expect(r.ctl.labels[HIGH]).toBe('SLIDE');
    // A plain slide afterwards.
    path.tap(r, HIGH, 1200);
    expect(r.defence.slideClear).toBe(false);
  });

  it('a SLIDE press stays SLIDE when CLEAR comes on mid-press; possession won mid-CLEAR keeps CLEAR until the lift', () => {
    const r = rig(DEFENCE);
    path.down(r, HIGH, 1, 1000);
    r.st.clearOn = true;
    r.ctl.update(1050);
    expect(r.ctl.labels[HIGH]).toBe('SLIDE');
    expect(r.defence.slideClear).toBe(false);
    path.up(r, HIGH, 1, 1080);
    r.ctl.update(1090);
    expect(r.ctl.labels[HIGH]).toBe('CLEAR');
    path.down(r, HIGH, 2, 1200);
    r.setMode(ATTACK, 1210);
    expect(r.ctl.labels[HIGH]).toBe('CLEAR');
    expect(r.ctl.modes[HIGH]).toBe(DEFENCE);
    path.up(r, HIGH, 2, 1250);
    r.ctl.update(1260);
    expect(r.ctl.labels[HIGH]).toBe('SHOOT');
    expect(r.defence.slideClear).toBe(true);
  });

  it('only SLIDE records CLEAR: other defence presses while clearOn are not clearances', () => {
    const r = rig(DEFENCE);
    r.st.clearOn = true;
    for (const s of [BIG, LOW, MID]) {
      path.down(r, s, 1, 1000);
      expect(r.defence.slot(s).pressClear).toBe(false);
      expect(r.defence.slot(s).pressLabel).toBe(slotLabel(DEFENCE, s, false));
      path.up(r, s, 1, 1050);
    }
  });
});

describe('TCH-04 direction hints on a 250 ms hold', () => {
  it('defence buttons with swipes show hints while hints are on; SLIDE never; keeper row never', () => {
    const r = rig(DEFENCE, { hints: () => true });
    for (const [s, id, want] of [[BIG, SPRINT_TACKLE, true], [LOW, SWITCH, true], [MID, SECOND_DEF, true], [HIGH, SLIDE, false]] as const) {
      path.down(r, s, 1, 1000);
      r.ctl.update(1000 + T_TOUCHUI.hintHoldMs - 10);
      expect(r.defence.hintMask).toBe(0);
      r.ctl.update(1000 + T_TOUCHUI.hintHoldMs);
      expect(r.defence.hintMask, `${TouchButtonId[id]}`).toBe(want ? 1 << id : 0);
      expect(r.ctl.hintMask).toBe(r.defence.hintMask);
      path.up(r, s, 1, 1400);
      expect(r.defence.hintMask).toBe(0);
    }
    const off = rig(DEFENCE, { hints: () => false });
    path.down(off, LOW, 1, 1000);
    off.ctl.update(1400);
    expect(off.ctl.hintMask).toBe(0);
    const keeper = rig(KEEPER, { hints: () => true });
    path.down(keeper, LOW, 1, 1000);
    keeper.ctl.update(1400);
    expect(keeper.ctl.hintMask).toBe(0);
  });

  it('a held attack thumb keeps its own hints across a swap (both sets combine in the controller mask)', () => {
    const r = rig(ATTACK, { hints: () => true });
    path.down(r, LOW, 1, 1000); // PASS
    r.setMode(DEFENCE, 1100);
    path.down(r, BIG, 2, 1100); // SPRINT & TACKLE
    r.ctl.update(1400);
    expect(r.ctl.hintMask).toBe((1 << PASS) | (1 << SPRINT_TACKLE));
  });
});

// ============================================================ release, glitches, multi-touch

describe('TCH-04 release and the section 14 input glitches (defence set)', () => {
  it('glitch: stuck sprint or stick after pointercancel - a cancelled SPRINT & TACKLE hold releases at once without an action', () => {
    const r = rig(DEFENCE);
    path.down(r, BIG, 1, 1000);
    r.ctl.update(1000 + TAP_MS + 10);
    expect(r.st.held).toBe(1 << SPRINT_TACKLE);
    r.router.cancel(1, 1300);
    expect(r.st.held).toBe(0);
    expect(r.st.downAt[SPRINT_TACKLE]).toBe(0);
    expect(r.edges()).toEqual([DOWN, HOLD, CANCEL]);
    r.ctl.update(1310);
    expect(r.ctl.pressed).toBe(0);
    // A quick cancel is never a tap (system gesture starting on SLIDE).
    r.clear();
    path.down(r, HIGH, 2, 2000);
    r.router.cancel(2, 2020);
    expect(r.edges()).toEqual([DOWN, CANCEL]);
  });

  it('glitch: stuck sprint after blur mid-swap - releaseAll cancels the swapped-out thumb and the live set alike', () => {
    const r = rig(ATTACK);
    path.down(r, BIG, 1, 1000); // SPRINT (attack)
    r.setMode(DEFENCE, 1050);
    path.down(r, MID, 2, 1060); // 2ND DEF (defence)
    path.down(r, LOW, 3, 1070); // SWITCH
    expect(r.st.held).toBe((1 << SPRINT_SKILL) | (1 << SECOND_DEF) | (1 << SWITCH));
    expect(r.router.releaseAll(1100)).toBe(3);
    expect(r.st.held).toBe(0);
    for (const id of [SPRINT_SKILL, SECOND_DEF, SWITCH]) expect(r.st.downAt[id]).toBe(0);
    expect(r.events().filter((e) => e[1] === CANCEL)).toEqual([[SPRINT_SKILL, CANCEL, 0, ATTACK], [SECOND_DEF, CANCEL, 0, DEFENCE], [SWITCH, CANCEL, 0, DEFENCE]]);
    r.ctl.update(1110);
    expect(r.ctl.pressed).toBe(0);
    expect([...r.ctl.labels]).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
  });

  it('glitch: power bar stuck full - held bit and downAt clear on up, cancel and releaseAll for every defence button', () => {
    for (const s of SLOTS) {
      const r = rig(DEFENCE);
      const id = SLOT_DEFENCE_BUTTON[s]!;
      path.hold(r, s, 700, 1000);
      expect(r.st.held).toBe(0);
      expect(r.st.downAt[id]).toBe(0);
      path.down(r, s, 2, 2000);
      expect(r.st.downAt[id]).toBe(2000);
      r.router.cancel(2, 2100);
      expect(r.st.held | r.st.downAt[id]!).toBe(0);
      path.down(r, s, 3, 3000);
      r.router.releaseAll(3100);
      expect(r.st.held | r.st.downAt[id]!).toBe(0);
    }
  });

  it('glitch: button swipe read as a pitch gesture - every defence swipe stays a button swipe', () => {
    const r = rig(DEFENCE);
    let t = 1000;
    for (const s of SLOTS) {
      for (const d of DIRS) {
        r.clear();
        t = path.swipe(r, s, DIR_VEC[d]![0], DIR_VEC[d]![1], t, 120) + 50;
        expect(r.events().filter((e) => e[1] === SW)).toEqual([[SLOT_DEFENCE_BUTTON[s]!, SW, d, DEFENCE]]);
      }
    }
    expect(r.gest).toEqual([]);
    expect(r.stick).toEqual([]);
  });

  it('a thumb that slides off a held defence button keeps the hold until it lifts (slow slide: no swipe)', () => {
    const r = rig(DEFENCE);
    const c = r.at(BIG);
    r.router.down(1, c.x, c.y, 1000);
    let t = 1000;
    for (let k = 1; k <= 40; k++) { t += 50; r.router.move(1, c.x - k * 3, c.y - k, t); } // 120 px over 2 s
    expect(r.defence.slot(BIG).hit(c.x - 120, c.y - 40)).toBe(false);
    expect(r.st.held).toBe(1 << SPRINT_TACKLE);
    r.router.up(1, c.x - 120, c.y - 40, t + 10);
    expect(r.edges()).toEqual([DOWN, HOLD, UP]);
    expect(r.st.held).toBe(0);
  });

  it('five simultaneous touches: the stick and the four defence buttons each keep their own finger', () => {
    const r = rig(DEFENCE);
    expect(r.router.down(9, 200, 600, 1000)).toBe(r.router.controls.length - 2); // the stick (left half)
    for (let k = 0; k < 4; k++) path.down(r, SLOTS[k]!, 1 + k, 1001 + k);
    expect(r.st.held).toBe((1 << SPRINT_TACKLE) | (1 << SWITCH) | (1 << SECOND_DEF) | (1 << SLIDE));
    r.ctl.sync(1010);
    expect(r.ctl.pressed).toBe(0b1111);
    // Possession changes with five fingers down: nothing is re-routed or re-interpreted.
    r.setMode(ATTACK, 1020);
    expect([...r.ctl.labels]).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
    path.up(r, MID, 3, 1100);
    expect(r.st.held).toBe((1 << SPRINT_TACKLE) | (1 << SWITCH) | (1 << SLIDE));
    r.ctl.update(1110);
    expect([...r.ctl.labels]).toEqual(['TACKLE', 'SWITCH', 'THROUGH', 'SLIDE']);
    r.router.up(9, 200, 600, 1120);
    expect(r.stick).toEqual(['down#9', 'up#9']);
    for (const k of [0, 1, 3]) path.up(r, SLOTS[k]!, 1 + k, 1130);
    expect(r.st.held).toBe(0);
    expect(r.gest).toEqual([]);
  });

  it('a second finger landing on a held defence button is swallowed (no second press, never a pitch gesture)', () => {
    const r = rig(DEFENCE);
    path.down(r, LOW, 1, 1000);
    const idx = r.router.controls.indexOf(r.defence.slot(LOW));
    expect(path.down(r, LOW, 2, 1010)).toBe(idx);
    path.up(r, LOW, 2, 1050);
    expect(r.st.held).toBe(1 << SWITCH);
    path.up(r, LOW, 1, 1060);
    expect(r.edges()).toEqual([DOWN, UP, TAP]);
    expect(r.gest).toEqual([]);
  });

  it('possession flips on every tick while fingers come and go: labels always match the live set once lifted, nothing sticks', () => {
    const r = rig(ATTACK);
    let t = 1000;
    for (let i = 0; i < 200; i++) {
      const mode = [ATTACK, DEFENCE, KEEPER, DEFENCE, SET_PIECE, HIDDEN][i % 6]!;
      r.setMode(mode, t);
      const s = SLOTS[i % 4]!;
      if (i % 3 === 0) path.down(r, s, 100 + (i % 4), t);
      if (i % 3 === 2) for (let k = 0; k < 4; k++) path.up(r, SLOTS[k]!, 100 + k, t);
      t += 17;
      r.clear();
    }
    r.router.releaseAll(t);
    r.setMode(DEFENCE, t + 1);
    expect(r.st.held).toBe(0);
    expect(r.ctl.pressed).toBe(0);
    expect([...r.ctl.labels]).toEqual(['TACKLE', 'SWITCH', '2ND DEF', 'SLIDE']);
    for (const s of SLOTS) {
      expect(r.attack.slot(s).pressId).toBe(-1);
      expect(r.defence.slot(s).pressId).toBe(-1);
    }
  });
});
