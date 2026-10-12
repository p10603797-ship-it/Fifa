/**
 * SIM-15 — attack rows (BRIEF §9 Attack buttons, §10 Movement and dribbling / Attacking / Shooting tables), combos at
 * the face press, buffering, power bar, double-tap windows, first-time kicks, aerial balls. Real step() pipeline;
 * starters are recording fakes (tests/scenario/sim-15-fakes.ts) so each row asserts the started kind / flags.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./sim-15-fakes')).mockPass((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/lob', async (o) => (await import('./sim-15-fakes')).mockLob((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/through', async (o) => (await import('./sim-15-fakes')).mockThrough((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./sim-15-fakes')).mockShot((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/aerial', async (o) => (await import('./sim-15-fakes')).mockAerial((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/skills', async (o) => (await import('./sim-15-fakes')).mockSkills((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/defend/tackle', async (o) => (await import('./sim-15-fakes')).mockTackle((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/sweeper', async (o) => (await import('./sim-15-fakes')).mockSweeper((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/keeper/handling', async (o) => (await import('./sim-15-fakes')).mockHandling((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/runs', async (o) => (await import('./sim-15-fakes')).mockRuns((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/support', async (o) => (await import('./sim-15-fakes')).mockSupport((await o()) as Record<string, unknown>));

import { ActionKind, KickKind, SkillMove } from '../../src/contracts/enums';
import { Btn, type InputFrame } from '../../src/contracts/input';
import { MoveMode } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { T_INPUT, T_PASS } from '../../src/contracts/tuning';
import { hashState } from '../../src/sim/core/hash';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { LOCAL_TUNING } from '../../src/sim/control/resolveShared';
import { CALLS, FAKE, calls, resetFakes } from './sim-15-fakes';
import { keepBall, run, scene, type Script } from './sim-15-setup';

const P = 9;
beforeEach(() => resetFakes());

type Step = [number, Partial<InputFrame>];
/** Script from [ticks, frame] steps; the ball is kept at the dribbler's feet. */
function seq(steps: Step[], slot = P): Script {
  const at: Partial<InputFrame>[] = [];
  for (const [n, f] of steps) for (let k = 0; k < n; k++) at.push(f);
  return (i, s) => { if (s.ball.owner === slot || s.ball.owner < 0) keepBallIfOwned(s, slot); return at[i - 1] ?? {}; };
}
function keepBallIfOwned(s: ReturnType<typeof scene>, slot: number): void {
  if (s.ball.owner === slot && s.players[slot]!.act === ActionKind.NONE) keepBall(s, slot);
}
function total(steps: Step[]): number { return steps.reduce((a, [n]) => a + n, 0) + 4; }

interface Row { row: string; steps: Step[]; fn: string; kind: number; flags?: number; last?: boolean }

const PASS = Btn.PASS, SHOOT = Btn.SHOOT, LOB = Btn.LOB, THROUGH = Btn.THROUGH, L1 = Btn.MOD_L, R1 = Btn.MOD_R;

// §10 Attacking + Shooting tables, and the §9 attack buttons (touch maps each cell onto the same bits — TCH-07).
const ATTACK_ROWS: Row[] = [
  { row: '§10 Ground pass / §9 PASS tap: Cross/A', steps: [[4, { buttons: PASS }]], fn: 'startPass', kind: KickKind.GROUND_PASS },
  { row: '§10 Driven ground pass / §9 PASS swipe right: R1 + Cross', steps: [[4, { buttons: R1 | PASS }]], fn: 'startPass', kind: KickKind.DRIVEN_PASS, flags: ReqFlag.DRIVEN },
  { row: '§10 Lofted ground pass / §9 PASS double-tap: Cross, Cross', steps: [[3, { buttons: PASS }], [3, {}], [3, { buttons: PASS }]], fn: 'startPass', kind: KickKind.DINKED_PASS, flags: ReqFlag.LOFTED, last: true },
  { row: '§10 Pass and go / §9 PASS swipe down: L1 + Cross', steps: [[4, { buttons: L1 | PASS }]], fn: 'startPass', kind: KickKind.GROUND_PASS, flags: ReqFlag.PASS_AND_GO },
  { row: '§10 Lob pass / cross / §9 PASS swipe up: Square/X', steps: [[4, { buttons: LOB }]], fn: 'startLob', kind: KickKind.LOB_PASS },
  { row: '§10 High lob: L1 + Square', steps: [[4, { buttons: L1 | LOB }]], fn: 'startLob', kind: KickKind.HIGH_LOB },
  { row: '§10 Driven lob / driven cross / §9 PASS swipe left: L1 + R1 + Square', steps: [[4, { buttons: L1 | R1 | LOB }]], fn: 'startLob', kind: KickKind.DRIVEN_LOB, flags: ReqFlag.DRIVEN },
  { row: '§10 Ground cross: Square, Square', steps: [[3, { buttons: LOB }], [2, {}], [3, { buttons: LOB }]], fn: 'startLob', kind: KickKind.GROUND_CROSS, last: true },
  { row: '§10 Through ball / §9 THROUGH tap: Triangle/Y', steps: [[4, { buttons: THROUGH }]], fn: 'startThrough', kind: KickKind.THROUGH_GROUND },
  { row: '§10 Lobbed through ball / §9 THROUGH swipe up: L1 + Triangle', steps: [[4, { buttons: L1 | THROUGH }]], fn: 'startThrough', kind: KickKind.THROUGH_LOBBED },
  { row: '§10 Lofted through ball / §9 THROUGH double-tap: Triangle, Triangle', steps: [[2, { buttons: THROUGH }], [4, {}], [2, { buttons: THROUGH }]], fn: 'startThrough', kind: KickKind.THROUGH_DINKED, flags: ReqFlag.LOFTED, last: true },
  { row: '§10 Shot / §9 SHOOT tap: Circle/B', steps: [[4, { buttons: SHOOT }]], fn: 'startShot', kind: KickKind.SHOT_NORMAL },
  { row: '§10 Finesse shot / §9 SHOOT swipe down: R1 + Circle', steps: [[4, { buttons: R1 | SHOOT }]], fn: 'startShot', kind: KickKind.SHOT_FINESSE },
  { row: '§10 Chip shot / §9 SHOOT swipe up: L1 + Circle', steps: [[4, { buttons: L1 | SHOOT }]], fn: 'startShot', kind: KickKind.SHOT_CHIP },
  { row: '§10 Power shot / §9 SHOOT swipe right: L1 + R1 + Circle', steps: [[4, { buttons: L1 | R1 | SHOOT }]], fn: 'startShot', kind: KickKind.SHOT_POWER },
];

describe('SIM-15 attack rows (owner with the ball at his feet)', () => {
  for (const r of ATTACK_ROWS) {
    it(r.row, () => {
      const s = scene();
      run(s, total(r.steps) + 10, seq(r.steps));
      const c = calls(r.fn).filter((x) => x.slot === P);
      expect(c.length).toBeGreaterThan(0);
      const hit = r.last ? c[c.length - 1]! : c[0]!;
      expect(hit.kind).toBe(r.kind);
      if (r.flags) expect(hit.flags & r.flags).toBe(r.flags);
      expect(hit.assist).toBe(s.ctrl[0]!.assist);
    });
  }

  it('§10 Low driven shot: Circle, then tap Circle again during power-up -> SIM-11 markLowDriven', () => {
    const s = scene();
    run(s, 40, seq([[20, { buttons: SHOOT }], [2, {}], [2, { buttons: SHOOT }]]));
    expect(calls('startShot')).toHaveLength(1);
    expect(calls('markLowDriven')).toHaveLength(1);
    expect(calls('markLowDriven')[0]!.tick).toBe(23);
  });

  it('§10 Fake shot: Circle then Cross during the wind-up -> SIM-13 startFake', () => {
    const s = scene();
    run(s, 12, seq([[3, { buttons: SHOOT }], [1, {}], [2, { buttons: PASS }]]));
    expect(calls('startShot')).toHaveLength(1);
    expect(calls('startFake')).toHaveLength(1);
    expect(calls('startPass', false)).toHaveLength(0);
    expect(s.players[P]!.act).toBe(ActionKind.FAKE);
  });

  it('§10 Fake pass: Square then Cross during the wind-up -> SIM-13 startFake', () => {
    const s = scene();
    run(s, 12, seq([[3, { buttons: LOB }], [1, {}], [2, { buttons: PASS }]]));
    expect(calls('startLob')).toHaveLength(1);
    expect(calls('startFake')).toHaveLength(1);
  });

  it('§9 SHOOT swipe left (touch fake shot = SHOOT then PASS) -> fake', () => {
    const s = scene();
    run(s, 10, seq([[1, { buttons: SHOOT }], [1, { buttons: PASS }]]));
    expect(calls('startFake')).toHaveLength(1);
  });

  it('§10 Trigger a run: L1 tap -> TAI-03 triggerRun; §9 THROUGH swipe down maps to the same tap', () => {
    const s = scene();
    run(s, 8, seq([[3, { buttons: L1 }]]));
    expect(calls('triggerRun')).toHaveLength(1);
    expect(calls('triggerRun')[0]!.arg).toBe(0);
    expect(CALLS.filter((c) => c.fn.startsWith('start'))).toHaveLength(0);
  });

  it('§10 Call for support: R1 tap -> TAI-02 callSupport', () => {
    const s = scene();
    run(s, 8, seq([[3, { buttons: R1 }]]));
    expect(calls('callSupport')).toHaveLength(1);
    expect(calls('triggerRun')).toHaveLength(0);
  });

  it('a held modifier (not a tap) neither triggers a run nor calls support', () => {
    const s = scene();
    run(s, 30, seq([[T_INPUT.tapTicks + 2, { buttons: L1 | R1 }]]));
    expect(calls('triggerRun')).toHaveLength(0);
    expect(calls('callSupport')).toHaveLength(0);
  });
});

describe('SIM-15 combos resolve at the FACE button press', () => {
  it('modifier pressed alone starts nothing', () => {
    const s = scene();
    run(s, 12, seq([[12, { buttons: R1 }]]));
    expect(CALLS.filter((c) => c.fn.startsWith('start'))).toHaveLength(0);
  });
  it('modifier pressed after the face button does not change the started kind', () => {
    const s = scene();
    run(s, 12, seq([[1, { buttons: PASS }], [6, { buttons: PASS | R1 }]]));
    expect(calls('startPass').map((c) => c.kind)).toEqual([KickKind.GROUND_PASS]);
  });
  it('modifier held before, face pressed later: combo at the face press tick', () => {
    const s = scene();
    run(s, 12, seq([[4, { buttons: R1 }], [3, { buttons: R1 | PASS }]]));
    const c = calls('startPass');
    expect(c.map((x) => x.kind)).toEqual([KickKind.DRIVEN_PASS]);
    expect(c[0]!.tick).toBe(5);
    expect(calls('callSupport')).toHaveLength(0); // the modifier was used in a combo
  });
  it('modifier and face pressed in the same tick combine', () => {
    const s = scene();
    run(s, 8, seq([[3, { buttons: L1 | SHOOT }]]));
    expect(calls('startShot').map((c) => c.kind)).toEqual([KickKind.SHOT_CHIP]);
    expect(calls('triggerRun')).toHaveLength(0);
  });
});

describe('SIM-15 input buffering (T_INPUT.bufferTicks)', () => {
  function busy(s: ReturnType<typeof scene>, ticks: number): void {
    const p = s.players[P]!;
    p.act = ActionKind.SKILL; p.actT = 0; p.actDur = ticks; p.actContact = -1; p.actDone = 0;
  }
  it('a press up to 6 ticks before the player can act still fires', () => {
    const s = scene();
    busy(s, T_INPUT.bufferTicks);
    run(s, 14, seq([[2, { buttons: PASS }]]));
    const c = calls('startPass');
    expect(c).toHaveLength(1);
    expect(c[0]!.tick - 1).toBe(T_INPUT.bufferTicks);
    expect(c[0]!.charging).toBe(0);
    expect(c[0]!.power).toBeCloseTo(2 / T_PASS.powerFillTicks, 9);
  });
  it('a press 7 ticks before the player can act is dropped', () => {
    const s = scene();
    busy(s, T_INPUT.bufferTicks + 1);
    run(s, 16, seq([[2, { buttons: PASS }]]));
    expect(calls('startPass')).toHaveLength(0);
  });
  it('a still-held buffered press starts charging with the power of its hold time', () => {
    const s = scene();
    busy(s, 3);
    run(s, 4, seq([[10, { buttons: SHOOT }]]));
    const c = calls('startShot');
    expect(c).toHaveLength(1);
    expect(c[0]!.charging).toBe(1);
    expect(c[0]!.power).toBeCloseTo(4 / T_PASS.powerFillTicks, 9);
  });
  it('a newer press replaces the buffered one', () => {
    const s = scene();
    busy(s, 4);
    run(s, 10, seq([[1, { buttons: PASS }], [1, {}], [1, { buttons: THROUGH }]]));
    expect(calls('startPass')).toHaveLength(0);
    expect(calls('startThrough')).toHaveLength(1);
  });
});

describe('SIM-15 power bar', () => {
  it('hold fills actPower by 1/powerFillTicks per tick; release stops charging', () => {
    const s = scene();
    const seen: number[] = [];
    run(s, 25, (i, st) => {
      if (st.ball.owner === P) keepBall(st, P);
      if (i >= 2 && i <= 21) seen.push(st.players[P]!.actPower);
      return i <= 20 ? { buttons: PASS } : {};
    });
    const p = s.players[P]!;
    expect(seen[0]).toBeCloseTo(1 / T_PASS.powerFillTicks, 9);
    expect(seen[19]).toBeCloseTo(20 / T_PASS.powerFillTicks, 9);
    expect(p.actCharging).toBe(0);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
  });
  it('fast power bar setting fills in powerFillTicksFast', () => {
    const s = scene({ fastPower: 1 });
    run(s, T_PASS.powerFillTicksFast, seq([[60, { buttons: SHOOT }]]));
    expect(s.players[P]!.actPower).toBeCloseTo(1, 9);
    expect(s.ctrl[0]!.power).toBeCloseTo(1, 9);
    expect(s.ctrl[0]!.powerBtn).toBe(Btn.SHOOT);
  });
  it('ctrl.power mirrors the bar for the HUD while charging', () => {
    const s = scene();
    run(s, 10, seq([[20, { buttons: SHOOT }]]));
    expect(s.ctrl[0]!.power).toBeCloseTo(10 / T_PASS.powerFillTicks, 9);
  });
  it('explicit frame.power (touch swipe) sets power directly with charging 0', () => {
    const s = scene();
    run(s, 4, seq([[1, { buttons: SHOOT, power: 100 }]]));
    const c = calls('startShot')[0]!;
    expect(c.charging).toBe(0);
    expect(c.power).toBeCloseTo(100 / 127, 9);
    expect(s.players[P]!.actCharging).toBe(0);
    expect(s.players[P]!.actPower).toBeCloseTo(100 / 127, 9);
  });
  it('glitch "Input: power bar stuck full": a button held forever auto-releases the charge', () => {
    const s = scene();
    let maxCharge = 0;
    let run1 = 0;
    run(s, 300, (_i, st) => {
      if (st.ball.owner === P && st.players[P]!.act === ActionKind.NONE) keepBall(st, P);
      run1 = st.players[P]!.actCharging === 1 ? run1 + 1 : 0;
      if (run1 > maxCharge) maxCharge = run1;
      return { buttons: PASS };
    });
    expect(maxCharge).toBeLessThanOrEqual(T_PASS.powerFillTicks + LOCAL_TUNING.chargeAfterFullTicks + 1);
    expect(s.players[P]!.actCharging).toBe(0);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
    expect(s.ctrl[0]!.power).toBe(0);
    expect(calls('startPass')).toHaveLength(1); // held button never re-fires
  });
  it('a tapped kick keeps charging (power frozen) through the double-tap grace, then releases', () => {
    const s = scene();
    const charging: number[] = [];
    run(s, 16, (i, st) => {
      if (st.ball.owner === P && st.players[P]!.act === ActionKind.NONE) keepBall(st, P);
      charging.push(st.players[P]!.actCharging);
      return i <= 3 ? { buttons: PASS } : {};
    });
    // charging[i] is the state before tick i+1: pressed at tick 1, grace until tick 1 + tapGraceTicks.
    expect(charging[LOCAL_TUNING.tapGraceTicks - 1]).toBe(1);
    expect(charging[LOCAL_TUNING.tapGraceTicks + 1]).toBe(0);
    expect(s.players[P]!.actPower).toBeCloseTo(3 / T_PASS.powerFillTicks, 9);
  });
});

describe('SIM-15 double-tap windows', () => {
  it('a second press inside T_INPUT.doubleTapTicks while the first still winds up converts', () => {
    const s = scene();
    run(s, 20, seq([[2, { buttons: PASS }], [8, {}], [2, { buttons: PASS }]]));
    expect(calls('startPass').map((c) => c.kind)).toEqual([KickKind.GROUND_PASS, KickKind.DINKED_PASS]);
  });
  it('a second press after the window is a new press, not a conversion', () => {
    const s = scene();
    run(s, 40, (i, st) => {
      if (st.ball.owner === P && st.players[P]!.act === ActionKind.NONE) keepBall(st, P);
      return i <= 2 || (i >= T_INPUT.doubleTapTicks + 4 && i <= T_INPUT.doubleTapTicks + 5) ? { buttons: PASS } : {};
    });
    expect(calls('startPass').map((c) => c.kind)).not.toContain(KickKind.DINKED_PASS);
  });
  it('a held first press (not a tap) cannot be doubled after its release', () => {
    const s = scene();
    run(s, 30, seq([[12, { buttons: PASS }], [1, {}], [2, { buttons: PASS }]]));
    expect(calls('startPass')[0]!.kind).toBe(KickKind.GROUND_PASS);
    expect(calls('startPass').map((c) => c.kind)).not.toContain(KickKind.DINKED_PASS);
  });
});

describe('SIM-15 §10 Movement and dribbling rows', () => {
  it('Move player: left stick -> DIRECT intent', () => {
    const s = scene();
    run(s, 2, seq([[2, { mx: 127, mz: 0 }]]));
    const p = s.players[P]!;
    expect(p.moveMode).toBe(MoveMode.DIRECT);
    expect(p.ix).toBeCloseTo(1, 9);
    expect(p.wantSprint).toBe(0);
  });
  it('partial tilt gives a proportional intent; below T_INPUT.stickIdle counts as released', () => {
    const s = scene();
    run(s, 1, seq([[1, { mx: 64 }]]));
    expect(s.players[P]!.ix).toBeCloseTo(64 / 127, 9);
    run(s, 1, () => ({ mx: 10 }));
    expect(s.players[P]!.ix).toBe(0);
  });
  it('Sprint: R2 hold -> wantSprint', () => {
    const s = scene();
    run(s, 2, seq([[2, { mx: 127, buttons: Btn.SPRINT }]]));
    expect(s.players[P]!.wantSprint).toBe(1);
  });
  it('Shield the ball: L2 hold with the ball -> SHIELD action, facing the nearest opponent', () => {
    const s = scene();
    const o = s.players[15]!; o.x = 13; o.z = 1;
    run(s, 5, seq([[5, { buttons: Btn.SHIELD }]]));
    const p = s.players[P]!;
    expect(p.act).toBe(ActionKind.SHIELD);
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBeCloseTo(s.players[15]!.x, 6);
    expect(p.actT).toBeLessThanOrEqual(p.actDur);
    run(s, 4, () => ({}));
    expect(s.players[P]!.act).toBe(ActionKind.NONE);
  });
  it('a face press while shielding ends the shield and starts the kick', () => {
    const s = scene();
    run(s, 8, seq([[4, { buttons: Btn.SHIELD }], [2, { buttons: Btn.SHIELD | PASS }]]));
    expect(calls('startPass')).toHaveLength(1);
  });
  it('Strafe dribble: L1 + left stick -> faces the attacked goal', () => {
    const s = scene();
    run(s, 3, seq([[3, { buttons: L1, mz: 127 }]]));
    const p = s.players[P]!;
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBe(s.teams[0]!.dir * 52.5);
    expect(p.iz).toBeCloseTo(1, 9);
  });
  it('Controlled sprint: R1 hold -> sprint at a reduced stick scale', () => {
    const s = scene();
    run(s, 3, seq([[3, { buttons: R1, mx: 127 }]]));
    const p = s.players[P]!;
    expect(p.wantSprint).toBe(1);
    expect(p.ix).toBeCloseTo(LOCAL_TUNING.controlledSprintScale, 9);
  });
  it('Stop the ball: release left stick + R2 -> STOP_BALL', () => {
    const s = scene({ vx: 6 });
    run(s, 12, (i, st) => {
      keepBall(st, P);
      if (i <= 6) { st.players[P]!.vx = 6; return { mx: 127, buttons: Btn.SPRINT }; }
      return { buttons: Btn.SPRINT };
    });
    const c = calls('startSkill');
    expect(c.map((x) => x.kind)).toEqual([SkillMove.STOP_BALL]);
  });
  it('Stop and face goal: release left stick + L1 -> STOP_FACE_GOAL (after the combo window)', () => {
    const s = scene({ vx: 5 });
    run(s, 14, (i, st) => {
      keepBall(st, P);
      if (st.players[P]!.act === ActionKind.NONE) st.players[P]!.vx = 5;
      if (i <= 3) return { mx: 127 };
      return { buttons: L1 };
    });
    const c = calls('startSkill');
    expect(c.map((x) => x.kind)).toEqual([SkillMove.STOP_FACE_GOAL]);
    expect(c[0]!.tick).toBe(3 + LOCAL_TUNING.stopHoldTicks);
    expect(calls('triggerRun')).toHaveLength(0);
  });
  it('Knock-on: R2 + right-stick flick -> KNOCK_ON toward the flick', () => {
    const s = scene();
    run(s, 4, seq([[2, { buttons: Btn.SPRINT, mx: 127 }], [1, { buttons: Btn.SPRINT | Btn.RS_FLICK, ax: 0, az: 127 }]]));
    const c = calls('startSkill');
    expect(c).toHaveLength(1);
    expect(c[0]!.kind).toBe(SkillMove.KNOCK_ON);
    expect([c[0]!.arg, c[0]!.arg2]).toEqual([0, 1]);
  });
  it('Skill moves: frame.skill (right-stick patterns / SPRINT & SKILL tap) -> startSkill toward the stick', () => {
    const s = scene();
    run(s, 2, seq([[1, { skill: SkillMove.STEP_OVER, mz: -127 }]]));
    const c = calls('startSkill');
    expect(c.map((x) => x.kind)).toEqual([SkillMove.STEP_OVER]);
    expect(c[0]!.arg2).toBeCloseTo(-1, 9);
  });
  it('§9 SPRINT & SKILL swipe down (knock-on) and swipe left (hard stop) arrive as frame.skill', () => {
    const s = scene();
    run(s, 2, seq([[1, { skill: SkillMove.KNOCK_ON }]]));
    expect(calls('startSkill').map((x) => x.kind)).toEqual([SkillMove.KNOCK_ON]);
    resetFakes();
    const s2 = scene();
    run(s2, 2, seq([[1, { skill: SkillMove.HARD_STOP }]]));
    expect(calls('startSkill').map((x) => x.kind)).toEqual([SkillMove.HARD_STOP]);
  });
  it('glitch "Input: stuck sprint or stick after pointercancel": frames dropping to nothing stop sprint and stick', () => {
    const s = scene();
    run(s, 5, seq([[5, { mx: 127, buttons: Btn.SPRINT }]]));
    expect(s.players[P]!.wantSprint).toBe(1);
    const ev = createEventBuffer();
    step(s, [], ev); // no frames at all (device gone)
    const p = s.players[P]!;
    expect(p.wantSprint).toBe(0);
    expect(p.ix).toBe(0);
    expect(p.iz).toBe(0);
    expect(s.ctrl[0]!.buttons).toBe(0);
  });
});

describe('SIM-15 loose balls: first-time kicks and aerial balls', () => {
  function incoming(s: ReturnType<typeof scene>, dist: number, speed: number, y = 0.11): void {
    const p = s.players[P]!;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = p.x + dist; b.z = p.z; b.y = y; b.px = b.x; b.pz = b.z; b.py = y;
    b.vx = -speed; b.vz = 0; b.vy = 0; b.grounded = y <= 0.12 ? 1 : 0;
    b.passTarget = P; b.lastTouchTeam = 0; b.lastTouch = 7; b.lastKickTeam = 0;
  }
  it('§10 first-time: a SHOOT held while the pass travels starts SHOT with FIRST_TIME as it arrives', () => {
    const s = scene({ ball: 'none' });
    incoming(s, 14, 14);
    let callTick = -1;
    let distAtCall = -1;
    run(s, 70, (_i, st) => {
      const c = calls('startShot');
      if (c.length > 0 && callTick < 0) {
        callTick = c[0]!.tick;
        distAtCall = Math.abs(st.ball.x - st.players[P]!.x);
      }
      return { buttons: SHOOT };
    });
    const c = calls('startShot');
    expect(c).toHaveLength(1);
    expect(c[0]!.flags & ReqFlag.FIRST_TIME).toBe(ReqFlag.FIRST_TIME);
    expect(c[0]!.charging).toBe(1);
    expect(c[0]!.tick).toBeGreaterThan(1);
    expect(distAtCall).toBeGreaterThan(0.5);
  });
  it('a tapped PASS while the pass travels still plays it first time on arrival', () => {
    const s = scene({ ball: 'none' });
    incoming(s, 12, 12);
    run(s, 90, (i) => (i <= 2 ? { buttons: PASS } : {}));
    const c = calls('startPass');
    expect(c).toHaveLength(1);
    expect(c[0]!.flags & ReqFlag.FIRST_TIME).toBe(ReqFlag.FIRST_TIME);
    expect(c[0]!.charging).toBe(0);
    expect(c[0]!.tick).toBeGreaterThan(5);
  });
  it('§10 header: Cross with a header chance -> HEADER_PASS; Circle -> HEADER_SHOT', () => {
    FAKE.aerial = 1;
    const s = scene({ ball: 'none' });
    incoming(s, 3, 6, 1.9);
    run(s, 2, () => ({ buttons: PASS }));
    expect(calls('startHeader').map((c) => c.kind)).toEqual([KickKind.HEADER_PASS]);
    resetFakes();
    FAKE.aerial = 1;
    const s2 = scene({ ball: 'none' });
    incoming(s2, 3, 6, 1.9);
    run(s2, 2, () => ({ buttons: SHOOT }));
    expect(calls('startHeader').map((c) => c.kind)).toEqual([KickKind.HEADER_SHOT]);
  });
  it('§10 lob/cross button heads too (Square: "Lob pass / cross / header")', () => {
    FAKE.aerial = 1;
    const s = scene({ ball: 'none' });
    incoming(s, 3, 6, 1.9);
    run(s, 2, () => ({ buttons: LOB }));
    expect(calls('startHeader').map((c) => c.kind)).toEqual([KickKind.HEADER_PASS]);
  });
  it('§10 volley: Circle with a volley chance -> VOLLEY_SHOT', () => {
    FAKE.aerial = 2;
    const s = scene({ ball: 'none' });
    incoming(s, 3, 6, 0.9);
    run(s, 2, () => ({ buttons: SHOOT }));
    expect(calls('startVolley').map((c) => c.kind)).toEqual([KickKind.VOLLEY_SHOT]);
    expect(calls('startVolley')[0]!.flags & ReqFlag.FIRST_TIME).toBe(ReqFlag.FIRST_TIME);
  });
  it('the intended receiver runs toward a ball played straight at him (meets it, does not wait)', () => {
    const s = scene({ ball: 'none' });
    incoming(s, 25, 12);
    run(s, 1, () => ({}));
    const p = s.players[P]!;
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.tgtX).toBeGreaterThan(p.x + 2);
    expect(Math.abs(p.tgtZ - p.z)).toBeLessThan(0.5);
  });
  it('the intended receiver moves to meet the ball until the user steers him', () => {
    const s = scene({ ball: 'none' });
    incoming(s, 20, 10);
    s.ball.z = 4; s.ball.pz = 4;
    run(s, 2, () => ({}));
    const p = s.players[P]!;
    expect(s.ctrl[0]!.receiver).toBe(P);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    run(s, 1, () => ({ mz: -127 }));
    expect(s.ctrl[0]!.receiver).toBe(-1);
    expect(s.players[P]!.moveMode).toBe(MoveMode.DIRECT);
  });
});

describe('SIM-15 determinism', () => {
  function scripted(): number[] {
    resetFakes();
    const s = scene({ seed: 11 });
    const hashes: number[] = [];
    let r = 12345;
    run(s, 240, (i, st) => {
      r = (r * 1103515245 + 12345) >>> 0;
      hashes.push(hashState(st));
      if (i % 37 === 0 && st.ball.owner < 0) keepBall(st, P);
      return { buttons: (r >>> 8) & 0xff, mx: ((r >>> 16) & 0xff) - 128, mz: ((r >>> 4) & 0xff) - 128, skill: i % 50 === 0 ? SkillMove.BODY_FEINT : 0 };
    });
    hashes.push(hashState(s));
    return hashes;
  }
  it('same inputs give identical state hashes every tick', () => {
    expect(scripted()).toEqual(scripted());
  });
});
