/**
 * TCH-03 touch button recogniser (src/input/touch/button.ts) through the real attack cluster and the pure pointer
 * routing core (TCH-01), with synthetic pointer paths (no DOM). Section 9 "Attack buttons" table (every row and
 * column), "Touch quality bar" (24 pt swipe, slide-off keeps the hold, 250 ms hints) and the section 14 input glitches.
 */
import { describe, expect, it } from 'vitest';
import { Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import {
  ClusterMode, ClusterSlot, createTouchIntentState, SwipeDir, TOUCH_QUEUE_SIZE, TouchButtonId, TouchEdge,
  type TouchControl, type TouchIntentState,
} from '../../src/contracts/touch';
import { T_TOUCHUI } from '../../src/contracts/tuning';
import { computeClusterLayout, createAttackCluster, type AttackCluster, type AttackClusterOptions } from '../../src/input/touch/attack';
import {
  BUTTON_SLOP, classifyRelease, createTouchButton, LOCAL_TUNING, swipeDir, TAP_MS,
} from '../../src/input/touch/button';
import { createTouchMapper } from '../../src/input/touch/mapper';
import { createPointerRouter, type PointerRouter } from '../../src/input/touch/pointers';
import { MatchPhase } from '../../src/contracts/enums';
import { initMatch } from '../../src/sim/init';

const W = 1180, H = 820;
const SWIPE = T_TOUCHUI.buttonSwipePt;
const { PASS, THROUGH, SHOOT, SPRINT_SKILL } = TouchButtonId;
const { DOWN, UP, TAP, DOUBLE_TAP, SWIPE: SW, HOLD, CANCEL } = TouchEdge;

type Ev = [TouchButtonId, TouchEdge, SwipeDir, ClusterMode];

interface Rig {
  st: TouchIntentState;
  cluster: AttackCluster;
  router: PointerRouter;
  gest: string[];
  /** Centre of an attack button. */
  at(id: TouchButtonId): { x: number; y: number };
  events(): Ev[];
  edges(id?: TouchButtonId): TouchEdge[];
  clear(): void;
}

/** Real attack cluster (iPad 1180 x 820) + a catch-all pitch-gesture recorder behind the routing core. */
function rig(opts: AttackClusterOptions = {}, enabled?: () => boolean): Rig {
  const st = createTouchIntentState();
  const layout = computeClusterLayout(W, H, { top: 0, right: 0, bottom: 0, left: 0 });
  const cluster = createAttackCluster(st, layout, enabled, opts);
  const gest: string[] = [];
  const gestures: TouchControl = {
    hit: () => true,
    down: (id) => { gest.push(`down#${id}`); },
    move: (id) => { gest.push(`move#${id}`); },
    up: (id) => { gest.push(`up#${id}`); },
    cancel: (id) => { gest.push(`cancel#${id}`); },
    releaseAll: () => { /* nothing held */ },
  };
  const router = createPointerRouter([...cluster.controls, gestures]);
  const slotOf = (id: TouchButtonId): ClusterSlot => (id === SPRINT_SKILL ? ClusterSlot.BIG : id === PASS ? ClusterSlot.LOW : id === THROUGH ? ClusterSlot.MID : ClusterSlot.HIGH);
  return {
    st, cluster, router, gest,
    at: (id) => ({ x: layout.slots[slotOf(id)].cx, y: layout.slots[slotOf(id)].cy }),
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
  };
}

const DIR_VEC: Record<number, [number, number]> = {
  [SwipeDir.UP]: [0, -1], [SwipeDir.DOWN]: [0, 1], [SwipeDir.LEFT]: [-1, 0], [SwipeDir.RIGHT]: [1, 0],
};

/** Gestures as synthetic pointer paths. Each starts at time t0 on the button centre and returns the end time. */
const path = {
  tap(r: Rig, id: TouchButtonId, t0: number, p = 1): number {
    const c = r.at(id);
    r.router.down(p, c.x, c.y, t0);
    r.router.move(p, c.x + 2, c.y - 1, t0 + 20); // a little thumb roll is still a tap
    r.router.up(p, c.x + 2, c.y - 1, t0 + 60);
    return t0 + 60;
  },
  hold(r: Rig, id: TouchButtonId, t0: number, ms = 600, p = 1): number {
    const c = r.at(id);
    r.router.down(p, c.x, c.y, t0);
    for (let t = 16; t < ms; t += 16) r.cluster.update(t0 + t); // the frame loop
    r.router.up(p, c.x, c.y, t0 + ms);
    return t0 + ms;
  },
  /** A thumb flick of 40 pt over 64 ms, then 300 ms of holding (power), then lift. */
  swipe(r: Rig, id: TouchButtonId, dir: SwipeDir, t0: number, p = 1): number {
    const c = r.at(id);
    const [vx, vy] = DIR_VEC[dir]!;
    r.router.down(p, c.x, c.y, t0);
    for (let k = 1; k <= 4; k++) r.router.move(p, c.x + vx * 10 * k, c.y + vy * 10 * k, t0 + 16 * k);
    for (let t = 80; t < 380; t += 16) r.cluster.update(t0 + t);
    r.router.up(p, c.x + vx * 40, c.y + vy * 40, t0 + 380);
    return t0 + 380;
  },
};

describe('TCH-03 section 9 attack table: every row and column reaches the queue as the right events', () => {
  const rows: TouchButtonId[] = [PASS, THROUGH, SHOOT, SPRINT_SKILL];

  it.each(rows)('%s: tap -> DOWN, UP, TAP (one press, mode ATTACK)', (id) => {
    const r = rig();
    path.tap(r, id, 1000);
    expect(r.events()).toEqual([
      [id, DOWN, SwipeDir.NONE, ClusterMode.ATTACK], [id, UP, SwipeDir.NONE, ClusterMode.ATTACK], [id, TAP, SwipeDir.NONE, ClusterMode.ATTACK],
    ]);
    expect(r.st.held).toBe(0);
    expect(r.gest).toEqual([]);
  });

  it.each(rows)('%s: hold -> DOWN, HOLD (once, past the tap time), UP; held for the whole press (power / sprint)', (id) => {
    const r = rig();
    const c = r.at(id);
    r.router.down(1, c.x, c.y, 1000);
    expect(r.st.held).toBe(1 << id);
    expect(r.st.downAt[id]).toBe(1000);
    for (let t = 1016; t < 1600; t += 16) {
      r.cluster.update(t);
      expect(r.st.held).toBe(1 << id);
    }
    r.router.up(1, c.x, c.y, 1600);
    expect(r.edges()).toEqual([DOWN, HOLD, UP]);
    expect(r.st.held).toBe(0);
    expect(r.st.downAt[id]).toBe(0);
  });

  const swipes: [TouchButtonId, SwipeDir, string][] = [
    [PASS, SwipeDir.UP, 'lob pass (cross in the crossing zone)'],
    [PASS, SwipeDir.DOWN, 'pass and go'],
    [PASS, SwipeDir.LEFT, 'driven lob (ground cross)'],
    [PASS, SwipeDir.RIGHT, 'driven ground pass (low cross)'],
    [THROUGH, SwipeDir.UP, 'lobbed through ball'],
    [THROUGH, SwipeDir.DOWN, 'trigger a teammate\'s run'],
    [SHOOT, SwipeDir.UP, 'chip shot'],
    [SHOOT, SwipeDir.DOWN, 'finesse shot'],
    [SHOOT, SwipeDir.LEFT, 'fake shot'],
    [SHOOT, SwipeDir.RIGHT, 'power shot'],
    [SPRINT_SKILL, SwipeDir.UP, 'skill move'],
    [SPRINT_SKILL, SwipeDir.DOWN, 'knock-on'],
    [SPRINT_SKILL, SwipeDir.LEFT, 'hard stop'],
    [SPRINT_SKILL, SwipeDir.RIGHT, 'skill move'],
  ];
  it.each(swipes)('%s swipe %s (%s) -> DOWN, SWIPE dir while the finger is still down, UP; no HOLD, no TAP', (id, dir) => {
    const r = rig();
    const c = r.at(id);
    const [vx, vy] = DIR_VEC[dir]!;
    r.router.down(1, c.x, c.y, 0);
    r.router.move(1, c.x + vx * 12, c.y + vy * 12, 16);
    expect(r.edges()).toEqual([DOWN]);
    r.router.move(1, c.x + vx * 25, c.y + vy * 25, 32);
    expect(r.events()[1]).toEqual([id, SW, dir, ClusterMode.ATTACK]);
    expect(r.st.held).toBe(1 << id); // the hold continues for power
    for (let t = 48; t < 400; t += 16) r.cluster.update(t);
    r.router.move(1, c.x + vx * 60, c.y + vy * 60, 400); // one swipe per press
    r.router.up(1, c.x + vx * 60, c.y + vy * 60, 420);
    expect(r.edges()).toEqual([DOWN, SW, UP]);
    expect(r.gest).toEqual([]);
  });

  it('THROUGH swipe left / right (empty cells) are still reported as swipes, never as a TAP (the mapper ignores them)', () => {
    for (const dir of [SwipeDir.LEFT, SwipeDir.RIGHT]) {
      const r = rig();
      path.swipe(r, THROUGH, dir, 0);
      expect(r.events().map((e) => [e[1], e[2]])).toEqual([[DOWN, 0], [SW, dir], [UP, 0]]);
    }
  });

  it.each([PASS, THROUGH])('%s: double tap -> TAP then DOUBLE_TAP (dinked pass / dinked through ball)', (id) => {
    const r = rig();
    const t = path.tap(r, id, 1000);
    path.tap(r, id, t + 100);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, UP, DOUBLE_TAP]);
  });

  it.each([SHOOT, SPRINT_SKILL])('%s has no double tap: two quick taps are two TAPs (two shots / two skill moves)', (id) => {
    const r = rig();
    const t = path.tap(r, id, 1000);
    path.tap(r, id, t + 100);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, UP, TAP]);
  });
});

describe('TCH-03 thresholds', () => {
  it('a button swipe is recognised at exactly 24 pt of travel, not below', () => {
    const r = rig();
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 0);
    r.router.move(1, c.x, c.y - (SWIPE - 0.01), 10);
    expect(r.edges()).toEqual([DOWN]);
    r.router.move(1, c.x, c.y - SWIPE, 20);
    expect(r.edges()).toEqual([DOWN, SW]);
    r.router.up(1, c.x, c.y - SWIPE, 30);
    expect(r.edges()).toEqual([DOWN, SW, UP]);
  });

  it('a quick press with less than 24 pt of travel is a tap (no dead band between tap and swipe)', () => {
    const r = rig();
    const c = r.at(SHOOT);
    r.router.down(1, c.x, c.y, 0);
    r.router.move(1, c.x + 23, c.y, 30);
    r.router.up(1, c.x + 23, c.y, 60);
    expect(r.edges()).toEqual([DOWN, UP, TAP]);
  });

  it('travel reported only by the lift still counts as a swipe', () => {
    const r = rig();
    const c = r.at(SHOOT);
    r.router.down(1, c.x, c.y, 0);
    r.router.up(1, c.x + 30, c.y, 40);
    expect(r.events().map((e) => [e[1], e[2]])).toEqual([[DOWN, 0], [SW, SwipeDir.RIGHT], [UP, 0]]);
  });

  it('tap time: a press of TAP_MS is a tap, a longer one is a hold (HOLD emitted before UP even without frames)', () => {
    const r = rig();
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 0);
    r.router.up(1, c.x, c.y, TAP_MS);
    expect(r.edges()).toEqual([DOWN, UP, TAP]);
    r.clear();
    r.router.down(1, c.x, c.y, 5000);
    r.router.up(1, c.x, c.y, 5000 + TAP_MS + 1);
    expect(r.edges()).toEqual([DOWN, HOLD, UP]);
    expect(TAP_MS).toBeCloseTo(10 * 1000 / 60, 9); // T_INPUT.tapTicks at 60 Hz
  });

  it('HOLD: update() emits it once, just past the tap time; a move can emit it too', () => {
    const r = rig();
    const c = r.at(SPRINT_SKILL);
    r.router.down(1, c.x, c.y, 100);
    r.cluster.update(100 + TAP_MS);
    expect(r.edges()).toEqual([DOWN]);
    r.cluster.update(100 + TAP_MS + 1);
    r.cluster.update(100 + TAP_MS + 50);
    expect(r.edges()).toEqual([DOWN, HOLD]);
    expect(r.st.buttonEvents[1]!.tMs).toBe(100 + TAP_MS + 1);
    expect(r.cluster.slot(ClusterSlot.BIG).holding).toBe(true);
    r.router.up(1, c.x, c.y, 900);
    expect(r.edges()).toEqual([DOWN, HOLD, UP]);
    r.clear();
    r.router.down(2, c.x, c.y, 2000);
    r.router.move(2, c.x + 3, c.y, 2000 + TAP_MS + 5);
    expect(r.edges()).toEqual([DOWN, HOLD]);
  });

  it('double-tap window: second touch-down at most doubleTapMs after the first tap lifted', () => {
    const r = rig();
    let t = path.tap(r, PASS, 0);
    path.tap(r, PASS, t + T_TOUCHUI.doubleTapMs);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, UP, DOUBLE_TAP]);
    r.clear();
    t = path.tap(r, PASS, 10_000);
    path.tap(r, PASS, t + T_TOUCHUI.doubleTapMs + 1);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, UP, TAP]);
  });

  it('a third quick tap starts over (TAP, DOUBLE_TAP, TAP); a slow second press is not a double tap', () => {
    const r = rig();
    let t = path.tap(r, THROUGH, 0);
    t = path.tap(r, THROUGH, t + 80);
    path.tap(r, THROUGH, t + 80);
    expect(r.edges().filter((e) => e === TAP || e === DOUBLE_TAP)).toEqual([TAP, DOUBLE_TAP, TAP]);
    r.clear();
    t = path.tap(r, PASS, 10_000);
    path.hold(r, PASS, t + 50, 400);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, HOLD, UP]);
  });

  it('a double tap needs the same button and the same meaning (a possession swap in between breaks it)', () => {
    const r = rig();
    const t = path.tap(r, PASS, 0);
    path.tap(r, THROUGH, t + 50);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, UP, TAP]);
    // Same button, the mode changed between the taps: two single taps; then two taps in the new mode double.
    const st = createTouchIntentState();
    const b = createTouchButton({ state: st, id: PASS, geom: { cx: 100, cy: 100, r: 38 } });
    b.down(1, 100, 100, 0); b.up(1, 100, 100, 40);
    st.mode = ClusterMode.DEFENCE;
    b.down(1, 100, 100, 100); b.up(1, 100, 100, 140);
    b.down(1, 100, 100, 200); b.up(1, 100, 100, 240);
    const edges = Array.from({ length: st.buttonEventCount }, (_, i) => st.buttonEvents[i]!.edge);
    expect(edges).toEqual([DOWN, UP, TAP, DOWN, UP, TAP, DOWN, UP, DOUBLE_TAP]);
  });

  it('pure helpers: swipeDir (ties go horizontal, NaN is NONE) and classifyRelease', () => {
    expect(swipeDir(0, -24, 24)).toBe(SwipeDir.UP);
    expect(swipeDir(0, 24, 24)).toBe(SwipeDir.DOWN);
    expect(swipeDir(-24, 0, 24)).toBe(SwipeDir.LEFT);
    expect(swipeDir(20, -20, 24)).toBe(SwipeDir.RIGHT);
    expect(swipeDir(-17, 17, 24)).toBe(SwipeDir.LEFT);
    expect(swipeDir(16, 16, 24)).toBe(SwipeDir.NONE);
    expect(swipeDir(NaN, 0, 24)).toBe(SwipeDir.NONE);
    expect(classifyRelease(0, TAP_MS, -Infinity, true)).toBe(TAP);
    expect(classifyRelease(0, TAP_MS + 0.5, -Infinity, true)).toBe(-1);
    expect(classifyRelease(400, 450, 100, true)).toBe(DOUBLE_TAP);
    expect(classifyRelease(400, 450, 100, false)).toBe(TAP);
    expect(classifyRelease(401, 450, 100, true)).toBe(TAP);
  });
});

describe('TCH-03 slide-off, drift and late swipes', () => {
  it('a thumb that slides off a held button keeps the hold until it lifts (slow slide: no swipe)', () => {
    const r = rig();
    const c = r.at(SPRINT_SKILL);
    r.router.down(1, c.x, c.y, 0);
    // 50 pt/s drift for 4 s: ends 200 pt away, over the pitch.
    for (let t = 16; t <= 4000; t += 16) {
      r.router.move(1, c.x - t * 0.05, c.y - t * 0.0125, t);
      r.cluster.update(t);
    }
    const sprint = r.cluster.slot(ClusterSlot.BIG);
    expect(sprint.hit(c.x - 200, c.y - 50)).toBe(false); // far off the button
    expect(r.st.held).toBe(1 << SPRINT_SKILL);
    expect(r.edges()).toEqual([DOWN, HOLD]); // sprinting never turns into a skill move by drift
    r.router.up(1, c.x - 200, c.y - 50, 4016);
    expect(r.edges()).toEqual([DOWN, HOLD, UP]);
    expect(r.st.held).toBe(0);
    expect(r.gest).toEqual([]);
  });

  it('a fast slide off the button is a swipe and the hold still continues until the lift', () => {
    const r = rig();
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 0);
    r.router.move(1, c.x - 150, c.y, 50);
    expect(r.events()[1]).toEqual([PASS, SW, SwipeDir.LEFT, ClusterMode.ATTACK]);
    r.router.move(1, c.x - 400, c.y - 200, 300);
    expect(r.st.held).toBe(1 << PASS);
    r.router.up(1, c.x - 400, c.y - 200, 700);
    expect(r.edges()).toEqual([DOWN, SW, UP]);
  });

  it('hold, then a flick: the swipe is measured from where the still finger was (DOWN, HOLD, SWIPE, UP)', () => {
    const r = rig();
    const c = r.at(SHOOT);
    r.router.down(1, c.x, c.y, 0);
    for (let t = 16; t < 2000; t += 16) r.cluster.update(t);
    r.router.move(1, c.x + 10, c.y, 2000);
    r.router.move(1, c.x + 20, c.y, 2016);
    expect(r.edges()).toEqual([DOWN, HOLD]);
    r.router.move(1, c.x + 26, c.y, 2032);
    expect(r.events()[2]).toEqual([SHOOT, SW, SwipeDir.RIGHT, ClusterMode.ATTACK]);
    r.router.up(1, c.x + 30, c.y, 2100);
    expect(r.edges()).toEqual([DOWN, HOLD, SW, UP]);
  });

  it('a main-thread stall between the touch-down and the first move still reads the swipe', () => {
    const r = rig();
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 0);
    r.router.move(1, c.x, c.y - 40, LOCAL_TUNING.swipeWindowMs + 200);
    expect(r.events().slice(-1)[0]).toEqual([PASS, SW, SwipeDir.UP, ClusterMode.ATTACK]);
  });

  it('500 Hz moves (more than the path buffer holds) still measure a slow swipe over the whole window', () => {
    const r = rig();
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 0);
    // 2 ms apart for 280 ms: 140 moves drifting 0.1 pt each (14 pt down), then a short move left.
    for (let k = 1; k <= 140; k++) r.router.move(1, c.x, c.y + k * 0.1, k * 2);
    r.router.move(1, c.x - 15, c.y + 14, 282);
    expect(r.edges()).toEqual([DOWN, HOLD]);
    // 26 pt from the touch-down point (280 ms ago, inside the window): the swipe counts from there.
    r.router.move(1, c.x - 22, c.y + 14, 284);
    expect(r.events().slice(-1)[0]).toEqual([PASS, SW, SwipeDir.LEFT, ClusterMode.ATTACK]);
  });
});

describe('TCH-03 cancel and release', () => {
  it('glitch: stuck sprint or stick after pointercancel - a cancelled SPRINT hold releases at once without an action', () => {
    const r = rig();
    const c = r.at(SPRINT_SKILL);
    r.router.down(1, c.x, c.y, 0);
    for (let t = 16; t < 400; t += 16) r.cluster.update(t);
    expect(r.st.held).toBe(1 << SPRINT_SKILL);
    r.router.cancel(1, 400);
    expect(r.st.held).toBe(0);
    expect(r.st.downAt[SPRINT_SKILL]).toBe(0);
    expect(r.edges()).toEqual([DOWN, HOLD, CANCEL]);
    // The cancelled finger lifts later: nothing comes back.
    r.router.move(1, c.x + 50, c.y, 420);
    r.router.up(1, c.x + 50, c.y, 440);
    r.cluster.update(500);
    expect(r.edges()).toEqual([DOWN, HOLD, CANCEL]);
    expect(r.st.held).toBe(0);
    // And the button works normally afterwards.
    path.tap(r, SPRINT_SKILL, 1000, 2);
    expect(r.edges().slice(3)).toEqual([DOWN, UP, TAP]);
  });

  it('a quick cancel (system gesture starting on the button) is never a tap; it forgets a pending first tap', () => {
    const r = rig();
    const c = r.at(PASS);
    const t = path.tap(r, PASS, 0);
    r.router.down(1, c.x, c.y, t + 30);
    r.router.cancel(1, t + 40);
    path.tap(r, PASS, t + 80);
    expect(r.edges()).toEqual([DOWN, UP, TAP, DOWN, CANCEL, DOWN, UP, TAP]);
  });

  it('releaseAll (blur, pause, visibility) cancels every held button; idle buttons forget a pending tap', () => {
    const r = rig();
    const t = path.tap(r, THROUGH, 0);
    const a = r.at(PASS), b = r.at(SHOOT), s = r.at(SPRINT_SKILL);
    r.router.down(1, a.x, a.y, t + 10);
    r.router.down(2, b.x, b.y, t + 11);
    r.router.down(3, s.x, s.y, t + 12);
    expect(r.st.held).toBe((1 << PASS) | (1 << SHOOT) | (1 << SPRINT_SKILL));
    r.clear();
    expect(r.router.releaseAll(t + 20)).toBe(3);
    expect(r.st.held).toBe(0);
    expect(r.edges().sort()).toEqual([CANCEL, CANCEL, CANCEL]);
    r.clear();
    path.tap(r, THROUGH, t + 30); // inside the window of the first THROUGH tap, but releaseAll forgot it
    expect(r.edges()).toEqual([DOWN, UP, TAP]);
  });

  it('glitch: power bar stuck full - held bit and downAt clear on up, cancel and releaseAll; the mapper sees nothing after', () => {
    const r = rig();
    const mapper = createTouchMapper(r.st);
    const out = createInputFrame();
    // INT-B: live open play with our side on the ball (a fresh initMatch is PRE_MATCH = cut-scene, where TCH-07 turns
    // every touch into SKIP).
    const live = initMatch(createMatchConfig()) as SimState;
    live.match.phase = MatchPhase.IN_PLAY;
    live.ball.owner = live.ctrl[0]!.slot >= 0 ? live.ctrl[0]!.slot : 9;
    const ctx: InputSampleContext = { tick: 1, human: 0, side: 0, state: live, projector: null };
    const c = r.at(SHOOT);
    let t0 = 100;
    for (const end of ['up', 'cancel', 'releaseAll'] as const) {
      r.router.down(1, c.x, c.y, t0);
      for (let t = 16; t < 1500; t += 16) r.cluster.update(t0 + t);
      mapper.sample(out, ctx);
      expect(out.buttons & Btn.SHOOT).toBe(Btn.SHOOT);
      expect(r.st.downAt[SHOOT]).toBe(t0);
      if (end === 'up') r.router.up(1, c.x, c.y, t0 + 1500);
      else if (end === 'cancel') r.router.cancel(1, t0 + 1500);
      else r.router.releaseAll(t0 + 1500);
      t0 += 5000;
      expect(r.st.held).toBe(0);
      expect(r.st.downAt.every((v) => v === 0)).toBe(true);
      mapper.sample(out, ctx); // drains the lift
      mapper.sample(out, ctx);
      expect(out.buttons).toBe(0);
    }
  });
});

describe('TCH-03 meaning at touch-down, multi-touch, routing', () => {
  it('a thumb keeps its meaning until it lifts: every event of the press carries the mode it had at DOWN', () => {
    const r = rig();
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 0);
    r.st.mode = ClusterMode.DEFENCE; // possession lost mid-press: the cluster swaps
    r.router.move(1, c.x, c.y - 30, 20);
    r.cluster.update(400);
    r.router.up(1, c.x, c.y - 30, 500);
    expect(r.events()).toEqual([
      [PASS, DOWN, 0, ClusterMode.ATTACK], [PASS, SW, SwipeDir.UP, ClusterMode.ATTACK], [PASS, UP, 0, ClusterMode.ATTACK],
    ]);
    // The next touch on that spot belongs to the defence set: the attack button no longer claims it.
    r.clear();
    r.router.down(2, c.x, c.y, 600);
    expect(r.edges()).toEqual([]);
    expect(r.gest).toEqual(['down#2']);
  });

  it('setId retargets the button for the next press only (cluster identity swap never re-interprets a held thumb)', () => {
    const st = createTouchIntentState();
    const b = createTouchButton({ state: st, id: TouchButtonId.SWITCH, geom: { cx: 100, cy: 100, r: 38 } });
    b.down(1, 100, 100, 0);
    b.setId(TouchButtonId.PASS);
    expect(b.id).toBe(TouchButtonId.PASS);
    expect(b.pressId).toBe(TouchButtonId.SWITCH);
    expect(st.held).toBe(1 << TouchButtonId.SWITCH);
    b.up(1, 100, 100, 50);
    expect(st.held).toBe(0);
    b.down(2, 100, 100, 1000);
    expect(st.held).toBe(1 << TouchButtonId.PASS);
    b.up(2, 100, 100, 1040);
    const ids = Array.from({ length: st.buttonEventCount }, (_, i) => [st.buttonEvents[i]!.button, st.buttonEvents[i]!.edge]);
    expect(ids).toEqual([
      [TouchButtonId.SWITCH, DOWN], [TouchButtonId.SWITCH, UP], [TouchButtonId.SWITCH, TAP],
      [TouchButtonId.PASS, DOWN], [TouchButtonId.PASS, UP], [TouchButtonId.PASS, TAP],
    ]);
  });

  it('five simultaneous touches: four buttons and the pitch each keep their own finger; lifts are independent', () => {
    const r = rig();
    const ids = [SPRINT_SKILL, PASS, THROUGH, SHOOT];
    ids.forEach((id, k) => { const c = r.at(id); r.router.down(k + 1, c.x, c.y, k); });
    r.router.down(5, 500, 300, 5);
    expect(r.st.held).toBe((1 << PASS) | (1 << THROUGH) | (1 << SHOOT) | (1 << SPRINT_SKILL));
    expect(r.gest).toEqual(['down#5']);
    const p = r.at(PASS);
    r.router.move(2, p.x, p.y - 40, 30); // PASS swipes up
    r.router.up(4, r.at(SHOOT).x, r.at(SHOOT).y, 40); // SHOOT tapped
    expect(r.st.held).toBe((1 << PASS) | (1 << THROUGH) | (1 << SPRINT_SKILL));
    for (let t = 50; t < 600; t += 16) r.cluster.update(t);
    expect(r.edges(SPRINT_SKILL)).toEqual([DOWN, HOLD]);
    expect(r.edges(THROUGH)).toEqual([DOWN, HOLD]);
    expect(r.edges(PASS)).toEqual([DOWN, SW]);
    expect(r.edges(SHOOT)).toEqual([DOWN, UP, TAP]);
    r.router.releaseAll(700);
    expect(r.st.held).toBe(0);
    expect(r.gest).toEqual(['down#5', 'cancel#5']);
  });

  it('a second finger landing on a held button is swallowed (no second press, never a pitch gesture)', () => {
    const r = rig();
    const c = r.at(SHOOT);
    r.router.down(1, c.x, c.y, 0);
    r.router.down(2, c.x + 5, c.y + 5, 10);
    r.router.move(2, c.x + 80, c.y, 20);
    r.router.up(2, c.x + 80, c.y, 30);
    expect(r.edges()).toEqual([DOWN]);
    expect(r.gest).toEqual([]);
    expect(r.st.held).toBe(1 << SHOOT);
    r.router.up(1, c.x, c.y, 60);
    expect(r.edges()).toEqual([DOWN, UP, TAP]);
  });

  it('glitch: button swipe read as a pitch gesture - a swipe that starts on a button stays a button swipe', () => {
    const r = rig();
    const c = r.at(SHOOT);
    r.router.down(1, c.x, c.y, 0);
    for (let k = 1; k <= 20; k++) r.router.move(1, c.x - k * 30, c.y - k * 15, k * 16);
    r.router.up(1, c.x - 600, c.y - 300, 340);
    expect(r.gest).toEqual([]);
    expect(r.events()[1]).toEqual([SHOOT, SW, SwipeDir.LEFT, ClusterMode.ATTACK]);
    expect(r.edges()).toEqual([DOWN, SW, UP]);
  });

  it('queue overflow keeps the newest events and never throws', () => {
    const r = rig();
    for (let k = 0; k < TOUCH_QUEUE_SIZE; k++) path.tap(r, SHOOT, k * 1000);
    expect(r.st.buttonEventCount).toBe(TOUCH_QUEUE_SIZE);
    expect(r.edges().slice(-3)).toEqual([DOWN, UP, TAP]);
  });

  it('slop: a near miss within BUTTON_SLOP counts, beyond it does not (isolated button)', () => {
    const st = createTouchIntentState();
    const b = createTouchButton({ state: st, id: PASS, geom: { cx: 500, cy: 500, r: 38 } });
    expect(b.hit(500 + 38 + BUTTON_SLOP, 500)).toBe(true);
    expect(b.hit(500 + 38 + BUTTON_SLOP + 0.5, 500)).toBe(false);
    expect(b.hit(NaN, 500)).toBe(false);
  });
});

describe('TCH-03 direction hints on a 250 ms hold', () => {
  it('hint shows at hintHoldMs while hints are on, hides on the swipe and on the lift', () => {
    const r = rig({ hints: () => true });
    const c = r.at(PASS);
    r.router.down(1, c.x, c.y, 1000);
    r.cluster.update(1000 + T_TOUCHUI.hintHoldMs - 1);
    expect(r.cluster.hintMask).toBe(0);
    r.cluster.update(1000 + T_TOUCHUI.hintHoldMs);
    expect(r.cluster.hintMask).toBe(1 << PASS);
    expect(r.cluster.slot(ClusterSlot.LOW).hint).toBe(true);
    r.router.move(1, c.x, c.y - 30, 1300); // the player follows the arrow
    expect(r.cluster.hintMask).toBe(0);
    expect(r.events().slice(-1)[0]).toEqual([PASS, SW, SwipeDir.UP, ClusterMode.ATTACK]);
    r.router.up(1, c.x, c.y - 30, 1400);
    r.clear();
    // Held to the end without a swipe: the hint goes with the lift.
    path.hold(r, SPRINT_SKILL, 5000, 260);
    expect(r.cluster.hintMask).toBe(0);
    const s = r.at(SPRINT_SKILL);
    r.router.down(2, s.x, s.y, 9000);
    r.cluster.update(9300);
    expect(r.cluster.hintMask).toBe(1 << SPRINT_SKILL);
    r.router.cancel(2, 9310);
    expect(r.cluster.hintMask).toBe(0);
  });

  it('no hints once the hint matches are used up (hints() false), in keeper mode, or on a short press', () => {
    let on = false;
    const r = rig({ hints: () => on });
    const c = r.at(SHOOT);
    r.router.down(1, c.x, c.y, 0);
    r.cluster.update(1000);
    expect(r.cluster.hintMask).toBe(0);
    r.router.up(1, c.x, c.y, 1000);
    on = true;
    r.st.mode = ClusterMode.KEEPER; // the keeper row is tap only
    r.router.down(2, c.x, c.y, 2000);
    r.cluster.update(3000);
    expect(r.cluster.hintMask).toBe(0);
    r.router.up(2, c.x, c.y, 3000);
    r.st.mode = ClusterMode.ATTACK;
    path.tap(r, SHOOT, 4000);
    r.cluster.update(4400);
    expect(r.cluster.hintMask).toBe(0);
  });

  it('two held buttons can show hints together', () => {
    const r = rig({ hints: () => true });
    const a = r.at(THROUGH), b = r.at(SPRINT_SKILL);
    r.router.down(1, a.x, a.y, 0);
    r.router.down(2, b.x, b.y, 0);
    r.cluster.update(300);
    expect(r.cluster.hintMask).toBe((1 << THROUGH) | (1 << SPRINT_SKILL));
  });
});
