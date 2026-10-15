/**
 * QF-3 QA-23 / FIX-06: the section 9 attack-button table, cell by cell, end to end: a real touch gesture on the real
 * touch source (recogniser -> mapper) -> the real sim (SIM-15 resolver, SIM-08..11 kickers, SIM-13 skills). Each cell
 * names the action the sim must start (a flicked swipe = one press with explicit power).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { ClusterSlot } from '../../src/contracts/touch';
import { makeScenario } from '../harness/scenario';
import { centreOn, createTouchRig, type TouchRig } from './qf-3-touch-rig';

const P = 9;

function attack(x = 10, z = 0): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: P }],
    players: [{ slot: P, x, z, fx: 1, fz: 0 }, { slot: 10, x: x + 14, z: z - 6 }],
    ball: { owner: P, x: x + 0.4, y: 0.11, z, lastTouchTeam: 0, lastTouch: P },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  s.attrs[P]!.skillMoves = 5;
  return s;
}

type G = 'tap' | 'double' | 'up' | 'down' | 'left' | 'right';

function gesture(r: TouchRig, slot: ClusterSlot, g: G): void {
  const p = r.slot(slot);
  if (g === 'tap') { r.down(2, p.x, p.y); r.wait(50); r.up(2, p.x, p.y); return; }
  if (g === 'double') {
    r.down(2, p.x, p.y); r.wait(50); r.up(2, p.x, p.y); r.wait(60);
    r.down(2, p.x, p.y); r.wait(50); r.up(2, p.x, p.y);
    return;
  }
  const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[g];
  r.down(2, p.x, p.y);
  r.wait(17); r.move(2, p.x + d[0]! * 14, p.y + d[1]! * 14);
  r.wait(17); r.move(2, p.x + d[0]! * 40, p.y + d[1]! * 40);
  r.wait(17); r.up(2, p.x + d[0]! * 40, p.y + d[1]! * 40);
}

interface Result { act: ActionKind; kind: KickKind; flags: number; skill: SkillMove; lastKick: KickKind }

/** Tick up to n; the first action #9 starts (kick kind, flags, skill) and the last kick kind at the end. */
function run(r: TouchRig, n = 45): Result {
  let first: Result | null = null;
  for (let i = 0; i < n; i++) {
    r.tick();
    const p = r.s.players[P]!;
    if (!first && p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD) {
      first = { act: p.act, kind: p.actKick, flags: p.actA, skill: p.actSkill, lastKick: KickKind.NONE };
    }
  }
  const skillEv = r.events.find((e) => e.type === EventType.SKILL && e.a === P);
  const out = first ?? { act: ActionKind.NONE, kind: KickKind.NONE, flags: 0, skill: SkillMove.NONE, lastKick: KickKind.NONE };
  if (skillEv && out.skill === SkillMove.NONE) out.skill = skillEv.b as SkillMove;
  // #9's own last kick (an opponent may head a dink before the window ends since QF-9's lofted-receiver fix).
  const own = r.events.filter((e) => e.type === EventType.KICK && e.a === P);
  out.lastKick = own.length > 0 ? (own[own.length - 1]!.b as KickKind) : r.s.ball.lastKickKind;
  return out;
}

const CELLS: [string, ClusterSlot, G, (r: Result) => void, number?][] = [
  ['PASS tap: ground pass', ClusterSlot.LOW, 'tap', (r) => expect(r.kind).toBe(KickKind.GROUND_PASS)],
  ['PASS swipe up: lob pass', ClusterSlot.LOW, 'up', (r) => expect(r.kind).toBe(KickKind.LOB_PASS)],
  ['PASS swipe down: pass and go', ClusterSlot.LOW, 'down', (r) => { expect(r.kind).toBe(KickKind.GROUND_PASS); expect(r.flags & ReqFlag.PASS_AND_GO).toBe(ReqFlag.PASS_AND_GO); }],
  ['PASS swipe left: driven lob', ClusterSlot.LOW, 'left', (r) => expect(r.kind).toBe(KickKind.DRIVEN_LOB)],
  ['PASS swipe right: driven ground pass', ClusterSlot.LOW, 'right', (r) => expect(r.kind).toBe(KickKind.DRIVEN_PASS)],
  ['PASS double-tap: dinked pass', ClusterSlot.LOW, 'double', (r) => expect(r.lastKick).toBe(KickKind.DINKED_PASS)],
  ['THROUGH tap: through ball', ClusterSlot.MID, 'tap', (r) => expect(r.kind).toBe(KickKind.THROUGH_GROUND)],
  ['THROUGH swipe up: lobbed through ball', ClusterSlot.MID, 'up', (r) => expect(r.kind).toBe(KickKind.THROUGH_LOBBED)],
  ['THROUGH double-tap: dinked through ball', ClusterSlot.MID, 'double', (r) => expect(r.lastKick).toBe(KickKind.THROUGH_DINKED)],
  ['SHOOT tap: shot', ClusterSlot.HIGH, 'tap', (r) => expect(r.kind).toBe(KickKind.SHOT_NORMAL), 30],
  ['SHOOT swipe up: chip shot', ClusterSlot.HIGH, 'up', (r) => expect(r.kind).toBe(KickKind.SHOT_CHIP), 30],
  ['SHOOT swipe down: finesse shot', ClusterSlot.HIGH, 'down', (r) => expect(r.kind).toBe(KickKind.SHOT_FINESSE), 30],
  ['SHOOT swipe left: fake shot', ClusterSlot.HIGH, 'left', (r) => expect(r.skill === SkillMove.FAKE_SHOT || r.act === ActionKind.FAKE || r.act === ActionKind.SHOT).toBe(true), 30],
  ['SHOOT swipe right: power shot', ClusterSlot.HIGH, 'right', (r) => expect(r.kind).toBe(KickKind.SHOT_POWER), 30],
  ['SPRINT & SKILL tap: skill (step-over default)', ClusterSlot.BIG, 'tap', (r) => expect(r.skill).toBe(SkillMove.STEP_OVER)],
  ['SPRINT & SKILL swipe up: skill (roulette default)', ClusterSlot.BIG, 'up', (r) => expect(r.skill).toBe(SkillMove.ROULETTE)],
  ['SPRINT & SKILL swipe down: knock-on', ClusterSlot.BIG, 'down', (r) => expect(r.skill === SkillMove.KNOCK_ON || r.kind === KickKind.KNOCK_ON).toBe(true)],
  ['SPRINT & SKILL swipe left: hard stop', ClusterSlot.BIG, 'left', (r) => expect(r.skill).toBe(SkillMove.HARD_STOP)],
  ['SPRINT & SKILL swipe right: skill (heel flick default)', ClusterSlot.BIG, 'right', (r) => expect(r.skill).toBe(SkillMove.HEEL_FLICK)],
];

describe('QF-3 section 9 attack buttons, cell by cell, through the sim', () => {
  for (const [name, slot, g, check, x] of CELLS) {
    it(name, () => {
      const r = createTouchRig(attack(x ?? 10));
      if (x) centreOn(0, 0);
      r.tick(2);
      gesture(r, slot, g);
      check(run(r));
    });
  }

  it('in the crossing zone: PASS swipe up crosses, swipe left is a ground cross, swipe right a low cross', () => {
    for (const [g, kind] of [['up', KickKind.CROSS], ['left', KickKind.GROUND_CROSS], ['right', KickKind.LOW_CROSS]] as const) {
      const r = createTouchRig(attack(40, 25));
      r.tick(2);
      gesture(r, ClusterSlot.LOW, g);
      const res = run(r);
      expect([res.kind, res.lastKick], `swipe ${g}`).toContain(kind);
    }
  });
});

describe('QF-3 section 9 defence buttons, cell by cell, through the sim', () => {
  /** P1 on #4 goal-side of the away carrier #18 at (cx, 0), the carrier kept still before each tick. */
  function defence(dx: number, cx = -22.6): { r: TouchRig; pin: () => void } {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
      players: [{ slot: 4, x: dx, z: 0, fx: 1, fz: 0 }, { slot: 18, x: cx, z: 0, fx: -1, fz: 0 }, { slot: 5, x: -10, z: -15 }],
      ball: { owner: 18, lastTouchTeam: 1, lastTouch: 18, x: cx - 0.5, y: 0.11, z: 0 },
    });
    for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
    const r = createTouchRig(s);
    const pin = (): void => {
      const q = s.players[18]!;
      if (s.ball.owner !== 18) return;
      q.x = cx; q.z = 0; q.vx = 0; q.vz = 0; s.ball.x = cx - 0.5; s.ball.z = 0; s.ball.vx = 0; s.ball.vz = 0;
    };
    return { r, pin };
  }
  /** Tick with the carrier pinned; the actions slot `slot` went through. */
  function acts(r: TouchRig, pin: () => void, slot: number, n = 20): Set<ActionKind> {
    const seen = new Set<ActionKind>();
    for (let i = 0; i < n; i++) { pin(); r.tick(); seen.add(r.s.players[slot]!.act); }
    return seen;
  }

  it('SPRINT & TACKLE tap: standing tackle (goal-side)', () => {
    const { r, pin } = defence(-24);
    r.tick(2);
    gesture(r, ClusterSlot.BIG, 'tap');
    expect(acts(r, pin, 4).has(ActionKind.STAND_TACKLE)).toBe(true);
  });

  it('SPRINT & TACKLE swipe left: hard tackle', () => {
    const { r, pin } = defence(-24);
    r.tick(2);
    gesture(r, ClusterSlot.BIG, 'left');
    expect(acts(r, pin, 4).has(ActionKind.HARD_TACKLE)).toBe(true);
  });

  it('SLIDE tap: slide tackle', () => {
    const { r, pin } = defence(-25);
    r.tick(2);
    gesture(r, ClusterSlot.HIGH, 'tap');
    expect(acts(r, pin, 4).has(ActionKind.SLIDE_TACKLE)).toBe(true);
  });

  it('SWITCH tap: switch to the best-placed defender; SWITCH swipe: switch that way', () => {
    let { r } = defence(-24);
    r.tick(2);
    gesture(r, ClusterSlot.LOW, 'tap');
    r.tick(4);
    expect(r.s.ctrl[0]!.slot).not.toBe(4);
    ({ r } = defence(-24));
    r.tick(2);
    // Teammate #5 is up (-z) and to the right (+x) of #4: swipe up switches to someone that way.
    gesture(r, ClusterSlot.LOW, 'up');
    r.tick(4);
    const c = r.s.ctrl[0]!.slot;
    expect(c).not.toBe(4);
    expect(r.s.players[c]!.z).toBeLessThan(r.s.players[4]!.z);
  });

  it('2ND DEF tap: a second defender is called; swipe down: the keeper rushes out', () => {
    let { r, pin } = defence(-24);
    r.tick(2);
    gesture(r, ClusterSlot.MID, 'tap');
    acts(r, pin, 4, 8);
    expect(r.s.ctrl[0]!.secondDef).toBeGreaterThanOrEqual(0);
    ({ r, pin } = defence(-24, -40));
    r.tick(2);
    const p = r.slot(ClusterSlot.MID);
    r.down(2, p.x, p.y); r.wait(17); r.move(2, p.x, p.y + 14); r.wait(17); r.move(2, p.x, p.y + 40);
    const seen = acts(r, pin, 0, 15);
    r.up(2, p.x, p.y + 40);
    expect(seen.has(ActionKind.GK_RUSH)).toBe(true);
  });
});

describe('QF-3 section 9 CLEAR replaces SLIDE', () => {
  it('a loose ball arriving in his own third: the defence set shows CLEAR, and the tap clears it upfield', () => {
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
      players: [{ slot: 4, x: -40, z: 0, fx: 1, fz: 0 }],
      ball: { owner: -1, x: -33, y: 0.11, z: 0, vx: -9, vz: 0, lastTouchTeam: 1, lastTouch: 18, passTarget: -1 },
    });
    for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
    const r = createTouchRig(s);
    for (let i = 0; i < 60 && !r.st.clearOn; i++) r.tick();
    expect(r.st.clearOn).toBe(true);
    expect(r.src.cluster.labels[ClusterSlot.HIGH]).toBe('CLEAR');
    gesture(r, ClusterSlot.HIGH, 'tap');
    let cleared = false;
    for (let i = 0; i < 40 && !cleared; i++) { r.tick(); cleared = s.ball.lastKickKind === KickKind.CLEARANCE; }
    expect(cleared).toBe(true);
    expect(s.ball.vx).toBeGreaterThan(3);
  });
});
