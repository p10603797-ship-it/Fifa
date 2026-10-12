/**
 * SIM-15 — defence rows (BRIEF §9 Defence buttons, §10 Defending table) and goalkeeper-with-the-ball rows (§10
 * Goalkeeper with the ball, §9 keeper touch mapping). Real step() pipeline; starters are recording fakes.
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

import { ActionKind, KickKind } from '../../src/contracts/enums';
import { Btn, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { T_PASS } from '../../src/contracts/tuning';
import { LOCAL_TUNING } from '../../src/sim/control/resolveShared';
import { CALLS, calls, resetFakes } from './sim-15-fakes';
import { run, scene } from './sim-15-setup';

const D = 5; // P1's defender
const C = 20; // opponent carrier
const PASS = Btn.PASS, SHOOT = Btn.SHOOT, LOB = Btn.LOB, THROUGH = Btn.THROUGH, R1 = Btn.MOD_R;
beforeEach(() => resetFakes());

interface Pos { x: number; z: number; vx?: number; vz?: number }
/** P1 defends with slot 5; opponent 20 carries the ball (team 1 attacks -x). Positions re-applied every tick. */
function defScene(d: Pos, c: Pos): SimState {
  const s = scene({ slot: D, x: d.x, z: d.z, vx: d.vx ?? 0, vz: d.vz ?? 0, ball: 'none' });
  place(s, d, c);
  return s;
}
function place(s: SimState, d: Pos, c: Pos): void {
  const p = s.players[D]!;
  const q = s.players[C]!;
  q.x = c.x; q.z = c.z; q.vx = c.vx ?? 0; q.vz = c.vz ?? 0; q.fx = -1; q.fz = 0;
  if (p.act === ActionKind.NONE) { p.x = d.x; p.z = d.z; p.vx = d.vx ?? 0; p.vz = d.vz ?? 0; }
  const b = s.ball;
  b.x = q.x - 0.5; b.z = q.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = q.vx; b.vz = q.vz; b.vy = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 1;
}
function hold(s: SimState, n: number, d: Pos, c: Pos, frames: (i: number) => Partial<InputFrame>): void {
  run(s, n, (i, st) => { place(st, d, c); return frames(i); });
}

describe('SIM-15 §10 Defending / §9 Defence buttons', () => {
  it('§10 Tackle when goal-side / §9 SPRINT & TACKLE tap: Circle -> standing tackle', () => {
    const d = { x: -20, z: 0 }, c = { x: -18.6, z: 0, vx: -4 };
    const s = defScene(d, c);
    hold(s, 3, d, c, (i) => (i === 1 ? { buttons: SHOOT } : {}));
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.STAND_TACKLE]);
    expect(calls('startShot', false)).toHaveLength(0);
  });
  it('§10 push or pull when chasing: Circle from behind -> PUSH_PULL', () => {
    const d = { x: -15, z: 0, vx: -6 }, c = { x: -16.5, z: 0, vx: -6 };
    const s = defScene(d, c);
    hold(s, 3, d, c, (i) => (i === 1 ? { buttons: SHOOT } : {}));
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.PUSH_PULL]);
  });
  it('§10 shoulder challenge when running alongside: Circle -> SHOULDER', () => {
    const d = { x: -16.5, z: 1.0, vx: -6 }, c = { x: -16.5, z: 0, vx: -6 };
    const s = defScene(d, c);
    hold(s, 3, d, c, (i) => (i === 1 ? { buttons: SHOOT } : {}));
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.SHOULDER]);
  });
  it('§10 clearance by context / §9 CLEAR: Circle on a loose ball arriving in the own third -> startClearance', () => {
    const s = scene({ slot: D, x: -40, z: 0, ball: 'none' });
    const b = s.ball;
    b.owner = -1; b.x = -37; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = 0; b.vx = -10; b.vz = 0; b.grounded = 1;
    b.lastTouch = C; b.lastTouchTeam = 1; b.passTarget = 18; b.lastKickTeam = 1;
    run(s, 3, (i) => (i === 1 ? { buttons: SHOOT } : {}));
    const c = calls('startClearance');
    expect(c.map((x) => x.kind)).toEqual([KickKind.CLEARANCE]);
    expect(c[0]!.flags & ReqFlag.FIRST_TIME).toBe(ReqFlag.FIRST_TIME);
    expect(calls('startShot', false)).toHaveLength(0);
  });
  it('§10 Hard tackle / §9 SPRINT & TACKLE swipe left: R1 + Circle -> HARD_TACKLE', () => {
    const d = { x: -15, z: 0, vx: -6 }, c = { x: -16.5, z: 0, vx: -6 };
    const s = defScene(d, c);
    hold(s, 3, d, c, (i) => (i === 1 ? { buttons: R1 | SHOOT } : {}));
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.HARD_TACKLE]);
  });
  it('§10 Slide tackle / §9 SLIDE: Square -> SLIDE_TACKLE', () => {
    const d = { x: -20, z: 0 }, c = { x: -17, z: 0, vx: -4 };
    const s = defScene(d, c);
    hold(s, 3, d, c, (i) => (i <= 2 ? { buttons: LOB } : {}));
    expect(calls('startTackle').map((x) => x.kind)).toEqual([ActionKind.SLIDE_TACKLE]);
    expect(calls('startLob', false)).toHaveLength(0);
  });
  it('§10 Quick get-up after a slide: Square again -> SIM-14 quickGetUp (no second slide)', () => {
    const d = { x: -20, z: 0 }, c = { x: -17, z: 0, vx: -4 };
    const s = defScene(d, c);
    hold(s, 14, d, c, (i) => (i <= 2 || (i >= 10 && i <= 11) ? { buttons: LOB } : {}));
    expect(calls('startTackle')).toHaveLength(1);
    expect(calls('quickGetUp')).toHaveLength(1);
    expect(calls('quickGetUp')[0]!.tick).toBe(10);
  });
  it('§10 Contain: Cross hold -> shadow the carrier goal-side at ~2 m, facing him', () => {
    const d = { x: -26, z: 3 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 2, d, c, () => ({ buttons: PASS }));
    const p = s.players[D]!;
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    // carrier placed at (-18, 0) before each tick: shadow point 2 m toward the own goal (-52.5, 0)
    expect(p.tgtX).toBeCloseTo(-18 - LOCAL_TUNING.containDist, 9);
    expect(p.tgtZ).toBeCloseTo(0, 9);
    expect(p.lookAt).toBe(1);
    expect([p.lookX, p.lookZ]).toEqual([-18, 0]);
    expect(calls('startPass', false)).toHaveLength(0);
  });
  it('§10 Teammate contain (second defender): R1 hold -> ctrl.secondDef = best helper while held', () => {
    const d = { x: -26, z: 3 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    const h = s.players[6]!; h.x = -24; h.z = -4;
    hold(s, 30, d, c, (i) => (i <= 20 ? { buttons: R1 } : {}));
    // after a long hold is released the call ends
    expect(s.ctrl[0]!.secondDef).toBe(-1);
    resetFakes();
    const s2 = defScene(d, c);
    const h2 = s2.players[6]!; h2.x = -24; h2.z = -4;
    hold(s2, 5, d, c, () => ({ buttons: R1 }));
    expect(s2.ctrl[0]!.secondDef).toBe(6);
    expect(calls('callSupport')).toHaveLength(0);
  });
  it('§9 2ND DEF tap: a tapped second defender keeps pressing for a while, then stops', () => {
    const d = { x: -26, z: 3 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    const h = s.players[6]!; h.x = -24; h.z = -4;
    hold(s, 10, d, c, (i) => (i <= 3 ? { buttons: R1 } : {}));
    expect(s.ctrl[0]!.secondDef).toBe(6);
    hold(s, LOCAL_TUNING.secondDefTapTicks, d, c, () => ({}));
    expect(s.ctrl[0]!.secondDef).toBe(-1);
  });
  it('§10 Jockey: L2 hold -> face the carrier and strafe with the stick, no sprint', () => {
    const d = { x: -24, z: 0 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 2, d, c, () => ({ buttons: Btn.SHIELD, mz: 127 }));
    const p = s.players[D]!;
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBe(-18);
    expect(p.wantSprint).toBe(0);
    expect(p.iz).toBeCloseTo(1, 9);
    expect(p.act).toBe(ActionKind.NONE);
  });
  it('§10 Sprint jockey: L2 + R2 -> jockey with sprint', () => {
    const d = { x: -24, z: 0 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 2, d, c, () => ({ buttons: Btn.SHIELD | Btn.SPRINT, mx: -127 }));
    const p = s.players[D]!;
    expect(p.lookAt).toBe(1);
    expect(p.wantSprint).toBe(1);
  });
  it('§10 Rush the keeper out / §9 2ND DEF swipe down: Triangle hold -> GKP-03 startKeeperRush', () => {
    const d = { x: -24, z: 0 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 4, d, c, () => ({ buttons: THROUGH }));
    const r = calls('startKeeperRush');
    expect(r).toHaveLength(1);
    expect(r[0]!.slot).toBe(s.teams[0]!.keeperSlot);
    expect(calls('startThrough', false)).toHaveLength(0);
  });
  it('§10 Change player / §9 SWITCH tap: L1 in defence switches (SIM-16), never a trigger run', () => {
    const d = { x: -10, z: 10 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    const h = s.players[6]!; h.x = -24; h.z = 0;
    hold(s, 4, d, c, (i) => (i <= 2 ? { buttons: Btn.MOD_L } : {}));
    expect(s.ctrl[0]!.slot).not.toBe(D);
    expect(calls('triggerRun')).toHaveLength(0);
  });
  it('§10 Change player (directional) / §9 SWITCH swipe: right-stick flick passes its direction to SIM-16', () => {
    const d = { x: -20, z: 0 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    const up = s.players[6]!; up.x = -20; up.z = -12;
    const down = s.players[7]!; down.x = -20; down.z = 12;
    hold(s, 2, d, c, (i) => (i === 1 ? { buttons: Btn.RS_FLICK, ax: 0, az: 127 } : {}));
    expect(s.ctrl[0]!.slot).toBe(7);
    expect(calls('startSkill', false)).toHaveLength(0); // no knock-on in defence
  });
  it('§9 "moving the stick near the carrier without sprinting contains him automatically (jockey)"', () => {
    const d = { x: -21, z: 0 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 2, d, c, () => ({ mx: 90 }));
    const p = s.players[D]!;
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBe(-18);
    // ... but not when sprinting, and not from behind
    resetFakes();
    const s2 = defScene(d, c);
    hold(s2, 2, d, c, () => ({ mx: 90, buttons: Btn.SPRINT }));
    expect(s2.players[D]!.lookAt).toBe(0);
    const d3 = { x: -15, z: 0 };
    const s3 = defScene(d3, c);
    hold(s3, 2, d3, c, () => ({ mx: -90 }));
    expect(s3.players[D]!.lookAt).toBe(0);
  });
  it('§9 SPRINT & TACKLE hold: sprint and press the carrier when close (stick released)', () => {
    const d = { x: -26, z: 3 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 2, d, c, () => ({ buttons: Btn.SPRINT }));
    const p = s.players[D]!;
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.wantSprint).toBe(1);
    expect(Math.hypot(p.tgtX - -18, p.tgtZ - 0)).toBeCloseTo(LOCAL_TUNING.pressDist, 6);
  });
  it('defence: Cross and Triangle never start passes or through balls', () => {
    const d = { x: -24, z: 0 }, c = { x: -18, z: 0, vx: -3 };
    const s = defScene(d, c);
    hold(s, 6, d, c, (i) => (i <= 2 ? { buttons: PASS } : i <= 4 ? { buttons: THROUGH } : {}));
    expect(CALLS.filter((x) => x.fn === 'startPass' || x.fn === 'startThrough')).toHaveLength(0);
  });
});

describe('SIM-15 §10 Goalkeeper with the ball', () => {
  const K = 0;
  function keeperScene(): SimState {
    const s = scene({ slot: K, x: -48, z: 0, ball: 'none' });
    const b = s.ball;
    b.owner = K; b.heldBy = K; b.x = -47.6; b.z = 0; b.y = 1.2; b.vx = 0; b.vz = 0; b.vy = 0; b.lastTouch = K; b.lastTouchTeam = 0;
    const p = s.players[K]!;
    p.act = ActionKind.GK_HOLD; p.actT = 0; p.actDur = 600; p.actContact = -1;
    return s;
  }
  const rows: { row: string; buttons: number; kind: KickKind; charging?: number }[] = [
    { row: 'Throw or pass / §9 keeper PASS: Cross', buttons: PASS, kind: KickKind.GK_THROW, charging: 1 },
    { row: 'Driven throw / §9 keeper THROUGH (= R1 + Cross): R1 + Cross', buttons: R1 | PASS, kind: KickKind.GK_DRIVEN_THROW, charging: 1 },
    { row: 'Drop kick / §9 keeper SHOOT: Circle', buttons: SHOOT, kind: KickKind.GK_DROP_KICK, charging: 1 },
    { row: 'Drop kick: Square', buttons: LOB, kind: KickKind.GK_DROP_KICK, charging: 1 },
    { row: 'Driven kick: R1 + Square', buttons: R1 | LOB, kind: KickKind.GK_DRIVEN_KICK, charging: 1 },
    { row: 'Drop the ball / §9 keeper SPRINT & SKILL (= Triangle): Triangle', buttons: THROUGH, kind: KickKind.GK_RELEASE, charging: 0 },
  ];
  for (const r of rows) {
    it(`§10 ${r.row} -> GKP-05 startKeeperRelease`, () => {
      const s = keeperScene();
      run(s, 3, (i) => (i <= 2 ? { buttons: r.buttons } : {}));
      const c = calls('startKeeperRelease');
      expect(c.map((x) => x.kind)).toEqual([r.kind]);
      expect(c[0]!.slot).toBe(K);
      if (r.charging !== undefined) expect(c[0]!.charging).toBe(r.charging);
      expect(CALLS.filter((x) => x.fn === 'startPass' || x.fn === 'startShot' || x.fn === 'startLob' || x.fn === 'startThrough')).toHaveLength(0);
    });
  }
  it('keeper throw: hold for power', () => {
    const s = keeperScene();
    run(s, 12, () => ({ buttons: PASS }));
    expect(s.players[K]!.actCharging).toBe(1);
    expect(s.players[K]!.actPower).toBeCloseTo(12 / T_PASS.powerFillTicks, 9);
  });
  it('§10 Pick up the ball: R1 tap with the ball at his feet inside the area -> GKP-05 keeperPickUp', () => {
    const s = scene({ slot: K, x: -46, z: 0 }); // ball at feet
    run(s, 4, (i) => (i <= 2 ? { buttons: R1 } : {}));
    expect(calls('keeperPickUp')).toHaveLength(1);
    expect(calls('callSupport')).toHaveLength(0);
  });
});
