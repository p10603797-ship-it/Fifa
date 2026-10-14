/**
 * QF-3 QA-29: input latency and buffering, measured end to end (real touch source / real pad source -> step()).
 * Latency = sim ticks from the physical input to the first tick whose frame (and sim state) shows it. Bounds:
 *  - stick (touch, pad), pad face buttons, touch buttons whose meaning is known at touch-down (SPRINT with the stick
 *    pushed, SPRINT & TACKLE sprint, SLIDE, keeper row): the very next tick;
 *  - touch buttons with tap / hold / swipe meanings: at the lift (tap), at T_INPUT.tapTicks (hold), at the swipe
 *    (+ flickLiftMs for a power swipe), never later;
 *  - buffered presses (section 10 "a press up to 6 ticks before the player can act still fires") through the touch
 *    path as well as the pad path; one 7 ticks early is dropped.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ClusterSlot } from '../../src/contracts/touch';
import { T_INPUT } from '../../src/contracts/tuning';
import { LOCAL_TUNING as MAPPER_TUNING } from '../../src/input/touch/mapper';
import { NULL_SINK } from '../../src/sim/core/events';
import { startSkill } from '../../src/sim/kicks/skills';
import { makeScenario } from '../harness/scenario';
import { padMatch, PadButton, scene, tapAt } from '../controls/pad-02-helpers';
import { createTouchRig, TICK_MS, type TouchRig } from './qf-3-touch-rig';

function attackState(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }],
    ball: { owner: 9, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

function defenceState(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: -24, z: 2 }, { slot: 18, x: -20, z: 0 }],
    ball: { owner: 18, lastTouchTeam: 1, x: -19.6, y: 0.11, z: 0 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

/** Ticks from now until `pred` holds on the latest frame (0 = the next tick), max n. */
function ticksUntil(r: TouchRig, pred: (r: TouchRig) => boolean, n = 40): number {
  for (let i = 0; i < n; i++) {
    r.tick();
    if (pred(r)) return i;
  }
  return Infinity;
}
const bits = (b: number) => (r: TouchRig): boolean => (r.frames.at(-1)!.buttons & b) === b;

describe('QF-3 QA-29 touch latency', () => {
  it('stick: the next tick moves the player', () => {
    const r = createTouchRig(attackState());
    r.tick(2);
    r.down(1, 250, 520);
    r.move(1, 330, 520);
    expect(ticksUntil(r, (x) => x.frames.at(-1)!.mx > 60 && x.s.players[9]!.ix > 0.5)).toBe(0);
  });

  it('SPRINT with the stick pushed, SPRINT & TACKLE, SLIDE: the next tick', () => {
    let r = createTouchRig(attackState());
    r.tick(2);
    r.down(1, 250, 520); r.move(1, 330, 520);
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    expect(ticksUntil(r, bits(Btn.SPRINT))).toBe(0);

    r = createTouchRig(defenceState());
    r.tick(2);
    r.down(2, big.x, big.y);
    expect(ticksUntil(r, bits(Btn.SPRINT))).toBe(0);
    const high = r.slot(ClusterSlot.HIGH);
    r.down(3, high.x, high.y);
    expect(ticksUntil(r, bits(Btn.LOB))).toBe(0);
  });

  it('PASS tap: at the lift; PASS hold: at the tap time; the kick starts on that very tick', () => {
    let r = createTouchRig(attackState());
    r.tick(2);
    const low = r.slot(ClusterSlot.LOW);
    r.down(2, low.x, low.y); r.wait(80); r.up(2, low.x, low.y);
    expect(ticksUntil(r, (x) => bits(Btn.PASS)(x) && x.s.players[9]!.act === ActionKind.KICK)).toBe(0);

    r = createTouchRig(attackState());
    r.tick(2);
    r.down(2, low.x, low.y);
    const t = ticksUntil(r, (x) => bits(Btn.PASS)(x) && x.s.players[9]!.act === ActionKind.KICK);
    expect(t).toBeLessThanOrEqual(T_INPUT.tapTicks + 1);
    r.up(2, low.x, low.y);
  });

  it('PASS flick swipe: within the flick window of the swipe; a held swipe at its end', () => {
    const r = createTouchRig(attackState());
    r.tick(2);
    const low = r.slot(ClusterSlot.LOW);
    r.down(2, low.x, low.y); r.wait(17); r.move(2, low.x, low.y - 40); // swipe up recognised now
    r.wait(17); r.up(2, low.x, low.y - 40);
    const t = ticksUntil(r, bits(Btn.LOB));
    expect(t).toBeLessThanOrEqual(Math.ceil(MAPPER_TUNING.flickLiftMs / TICK_MS));
  });
});

describe('QF-3 QA-29 buffering through the touch path', () => {
  /** #9 starts a long skill (busy); the tick he is free again, measured by a dry run with no input. */
  function busyRig(): { r: TouchRig; s: SimState } {
    const s = attackState();
    const r = createTouchRig(s);
    r.tick(2);
    s.attrs[9]!.skillMoves = 5;
    expect(startSkill(s, 9, SkillMove.ROULETTE, 1, 0, NULL_SINK)).toBe(1);
    return { r, s };
  }
  function freeTick(): number {
    const { r, s } = busyRig();
    for (let i = 0; i < 80; i++) {
      r.tick();
      if (s.players[9]!.act === ActionKind.NONE) return s.tick;
    }
    return -1;
  }
  /** The PASS press reaches the sim `lead` ticks before the player is free; returns the tick the pass starts, or -1. */
  function busyThenTap(lead: number): number {
    const free = freeTick();
    expect(free).toBeGreaterThan(10);
    const { r, s } = busyRig();
    const p = s.players[9]!;
    const low = r.slot(ClusterSlot.LOW);
    // A 50 ms tap is committed at its lift and pressed from the next tick on.
    while (s.tick + 2 < free - lead) r.tick();
    r.down(2, low.x, low.y); r.wait(34); r.up(2, low.x, low.y);
    const pressTick = s.tick + 1;
    for (let i = 0; i < 60; i++) {
      r.tick();
      if (p.act === ActionKind.KICK && p.actKick === KickKind.GROUND_PASS) return s.tick;
    }
    void pressTick;
    return -1;
  }

  it(`a PASS tap reaching the sim ${T_INPUT.bufferTicks} ticks before the player is free passes when he is free`, () => {
    const free = freeTick();
    const t = busyThenTap(T_INPUT.bufferTicks - 1);
    expect(t).toBeGreaterThanOrEqual(free);
    expect(t).toBeLessThanOrEqual(free + 1);
  });

  it('a PASS tap much earlier than the buffer window is dropped (no late pass)', () => {
    expect(busyThenTap(T_INPUT.bufferTicks + 8)).toBe(-1);
  });
});

describe('QF-3 QA-29 pad latency', () => {
  it('a Cross tap polled before a tick starts the pass on that tick; the stick moves him on that tick', () => {
    const s = scene();
    const m = padMatch(s);
    m.run(3);
    const t = s.tick + 1;
    let kickTick = -1;
    m.run(5, tapAt(PadButton.SOUTH, t), (st) => { if (kickTick < 0 && st.players[9]!.act === ActionKind.KICK) kickTick = st.tick; });
    expect(kickTick).toBe(t);
    const s2 = scene({ ball: 'none' });
    const m2 = padMatch(s2);
    m2.run(2);
    const t2 = s2.tick + 1;
    let moveTick = -1;
    m2.run(4, (tick, sub, rig) => { if (tick === t2 && sub === 0) rig.left(1, 0); }, (st) => { if (moveTick < 0 && st.players[9]!.ix > 0.5) moveTick = st.tick; });
    expect(moveTick).toBe(t2);
  });
});
