/**
 * PAD-02: every row of BRIEF section 10 "Movement and dribbling", "Attacking" and "Shooting", plus the controller
 * quality bar lines on modifier combos and input buffering, end to end: mock Standard Gamepad states -> PAD-01 manager
 * -> PAD-02 mapper (two animation frames per tick, 120 Hz) -> InputFrame -> the real step() pipeline (SIM-15 resolver,
 * SIM-16 switching, SIM-13 skills, SIM-05 shield, SIM-12 headers / volleys, TAI-02 / TAI-03, RUL-09 advantage, ...).
 *
 * The kick starters of SIM-08 (pass), SIM-09 (lob), SIM-10 (through) and SIM-11 (shot) are still Wave-0 stubs: they are
 * wrapped (pad-02-fakes.ts) so the resolver's request is recorded (kind + ReqFlag flags) and, while a stub refuses,
 * the action is started minimally (p.act / p.actKick) exactly as requested. Each test is named after its row.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./pad-02-fakes')).wrapPass(await o()));
vi.mock('../../src/sim/kicks/lob', async (o) => (await import('./pad-02-fakes')).wrapLob(await o()));
vi.mock('../../src/sim/kicks/through', async (o) => (await import('./pad-02-fakes')).wrapThrough(await o()));
vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./pad-02-fakes')).wrapShot(await o()));

import { BALL_RADIUS, HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, CardKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { T_INPUT, T_PASS } from '../../src/contracts/tuning';
import { createLaunchSolution, solveLaunchSpin } from '../../src/sim/ball/flight';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { aerialChance } from '../../src/sim/kicks/aerial';
import { startSkill } from '../../src/sim/kicks/skills';
import { LT as RESOLVE_LT } from '../../src/sim/control/resolveShared';
import { resetStarts, STARTS, startsOf, type StartCall } from './pad-02-fakes';
import { all, holdDuring, padMatch, PadButton, scene, tapAt, type PadMatch, type PadScript } from './pad-02-helpers';

const P = 9;
const MODS_FLAGS = ReqFlag.DRIVEN | ReqFlag.LOFTED | ReqFlag.PASS_AND_GO | ReqFlag.LOW;

beforeEach(() => { resetStarts(); });

function skillEvents(m: PadMatch, slot = P): number[] {
  return m.events.filter((e) => e.type === EventType.SKILL && e.a === slot).map((e) => e.b);
}

function firstKick(): StartCall {
  const c = STARTS.find((x) => x.ok === 1 && x.fn !== 'markLowDriven');
  expect(c, 'no kick was started').toBeDefined();
  return c!;
}

/** Set the left stick (screen space) at the start of the given ticks: [tick, x, y][]. */
function stickAt(keys: [number, number, number][]): PadScript {
  return (tick, sub, r) => {
    if (sub !== 0) return;
    for (const [t, x, y] of keys) if (t === tick) r.left(x, y);
  };
}

/** A right-stick path, one entry per animation frame (120 Hz) from tick `from`. */
function rightPath(from: number, path: [number, number][]): PadScript {
  return (tick, sub, r) => {
    const i = (tick - from) * 2 + sub;
    if (i >= 0 && i < path.length) r.right(path[i]![0], path[i]![1]);
    else if (i === path.length) r.right(0, 0);
  };
}

/** A left-stick path, one entry per animation frame from tick `from`. */
function leftPath(from: number, path: [number, number][]): PadScript {
  return (tick, sub, r) => {
    const i = (tick - from) * 2 + sub;
    if (i >= 0 && i < path.length) r.left(path[i]![0], path[i]![1]);
    else if (i === path.length) r.left(0, 0);
  };
}

function repeat(v: [number, number], n: number): [number, number][] {
  return Array.from({ length: n }, () => v);
}

/** Dribble: the controlled player jogs toward +x with the ball for `ticks` (stick fully right). */
function jogWithBall(m: PadMatch, ticks: number): void {
  m.run(ticks, (tick, sub, r) => { if (sub === 0) r.left(1, 0); });
}

// ====================================================================== Movement and dribbling

describe('PAD-02 §10 Movement and dribbling', () => {
  it('Move player: left stick (stick right = +x, stick up = -z)', () => {
    const s = scene({ ball: 'none' });
    const m = padMatch(s);
    const p = s.players[P]!;
    const x0 = p.x, z0 = p.z;
    m.run(40, stickAt([[2, 1, 0]]));
    expect(p.moveMode).toBe(MoveMode.DIRECT);
    expect(p.ix).toBeCloseTo(1, 6);
    expect(p.x - x0).toBeGreaterThan(1.5);
    expect(Math.abs(p.z - z0)).toBeLessThan(0.2);
    const x1 = p.x;
    m.run(40, stickAt([[s.tick + 1, 0, -1]]));
    expect(p.iz).toBeCloseTo(-1, 6);
    expect(p.z - z0).toBeLessThan(-1.5);
    expect(Math.abs(p.x - x1)).toBeLessThan(1.5);
  });

  it('Sprint: R2 (hold) sets wantSprint past 0.3 and covers more ground than a jog; 0.29 does not sprint', () => {
    const dist = (trigger: number): number => {
      const s = scene({ ball: 'none' });
      const m = padMatch(s);
      const x0 = s.players[P]!.x;
      m.run(90, all(stickAt([[2, 1, 0]]), holdDuring(PadButton.R2, 2, 999, trigger)));
      expect(s.players[P]!.wantSprint).toBe(trigger > 0.3 ? 1 : 0);
      expect(m.frames.at(-1)!.buttons & Btn.SPRINT).toBe(trigger > 0.3 ? Btn.SPRINT : 0);
      return s.players[P]!.x - x0;
    };
    const jog = dist(0);
    expect(dist(0.29)).toBeCloseTo(jog, 6);
    expect(dist(0.31)).toBeGreaterThan(jog + 1);
    expect(dist(1)).toBeGreaterThan(jog + 1);
  });

  it('Shield the ball / jockey: L2 (hold) shields with the ball and jockeys (faces the carrier) without it', () => {
    // Attack: the dribbler starts the SHIELD action while L2 is held and stops it on release.
    const s = scene();
    const m = padMatch(s);
    const p = s.players[P]!;
    m.run(8, holdDuring(PadButton.L2, 3, 10));
    expect(m.frames.at(-1)!.buttons & Btn.SHIELD).toBe(Btn.SHIELD);
    expect(p.act).toBe(ActionKind.SHIELD);
    expect(p.shielding).toBe(1);
    m.run(4, holdDuring(PadButton.L2, 3, 10));
    expect(p.act).not.toBe(ActionKind.SHIELD);
    expect(p.shielding).toBe(0);
    // Defence: L2 held while moving = jockey: he keeps facing the carrier.
    const d = scene({ ball: 'none' });
    const q = d.players[19]!;
    q.x = 16; q.z = 3; q.vx = 0; q.vz = 0;
    const b = d.ball;
    b.x = q.x - 0.5; b.z = q.z; b.px = b.x; b.pz = b.z; b.y = 0.11; b.vx = 0; b.vz = 0; b.grounded = 1;
    b.owner = 19; b.heldBy = -1; b.lastTouch = 19; b.lastTouchTeam = 1;
    const dm = padMatch(d);
    let looks = 0;
    dm.run(20, all(stickAt([[2, 0, 1]]), holdDuring(PadButton.L2, 2, 999)), (st) => {
      // lookX/Z were written at the resolve stage, before the carrier moved this tick.
      const pp = st.players[P]!;
      const qq = st.players[19]!;
      if (pp.lookAt === 1 && Math.hypot(pp.lookX - qq.x, pp.lookZ - qq.z) < 0.5) looks++;
    });
    expect(looks).toBeGreaterThan(15);
  });

  it('Strafe dribble: L1 + left stick (faces the attacked goal, no sprint)', () => {
    const s = scene();
    const m = padMatch(s);
    const p = s.players[P]!;
    m.run(20, all(holdDuring(PadButton.L1, 2, 999), stickAt([[3, 0, -1]])));
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBe(s.teams[0]!.dir * HALF_LENGTH);
    expect(p.lookZ).toBe(0);
    expect(p.wantSprint).toBe(0);
    expect(p.iz).toBeLessThan(-0.9);
    expect(s.teams[0]!.runCallT).toBe(0);
  });

  it('Controlled sprint: R1 (hold) with the ball sprints at a reduced stick', () => {
    const s = scene();
    const m = padMatch(s);
    const p = s.players[P]!;
    m.run(10, all(holdDuring(PadButton.R1, 2, 999), stickAt([[2, 1, 0]])));
    expect(p.wantSprint).toBe(1);
    expect(p.ix).toBeCloseTo(RESOLVE_LT.controlledSprintScale, 6);
    // Without R1 he jogs at the full stick.
    m.run(3, (t, sub, r) => { if (sub === 0) r.release(PadButton.R1); });
    expect(p.wantSprint).toBe(0);
    expect(p.ix).toBeCloseTo(1, 6);
  });

  it('Stop the ball: release left stick + R2 (STOP_BALL)', () => {
    const s = scene();
    const m = padMatch(s);
    jogWithBall(m, 45);
    expect(Math.hypot(s.players[P]!.vx, s.players[P]!.vz)).toBeGreaterThan(RESOLVE_LT.stopMinSpeed);
    expect(s.ball.owner).toBe(P);
    const t = s.tick + 1;
    m.run(6, (tick, sub, r) => { if (tick === t && sub === 0) { r.left(0, 0); r.press(PadButton.R2); } });
    expect(skillEvents(m)).toEqual([SkillMove.STOP_BALL]);
  });

  it('Stop and face goal: release left stick + L1 (STOP_FACE_GOAL, no trigger run)', () => {
    const s = scene();
    const m = padMatch(s);
    jogWithBall(m, 45);
    const t = s.tick + 1;
    m.run(14, all(
      (tick, sub, r) => { if (tick === t && sub === 0) r.left(0, 0); },
      holdDuring(PadButton.L1, t, t + 12),
    ));
    expect(skillEvents(m)).toEqual([SkillMove.STOP_FACE_GOAL]);
    expect(s.teams[0]!.runCallT).toBe(0);
  });

  it('Knock-on: R2 + right-stick flick (KNOCK_ON toward the flick)', () => {
    const s = scene();
    const m = padMatch(s);
    m.run(12, all(holdDuring(PadButton.R2, 2, 999), rightPath(6, [[1, 0], [1, 0], [0.2, 0]])));
    expect(m.frames.filter((f) => (f.buttons & Btn.RS_FLICK) !== 0)).toHaveLength(1);
    expect(skillEvents(m)).toEqual([SkillMove.KNOCK_ON]);
    expect(s.players[P]!.actDirX).toBeGreaterThan(0.9);
  });

  describe('Skill moves: right stick (relative to the way the player faces)', () => {
    const SIDE: [number, number] = [0, 1]; // facing +x: the player's right is +z (screen down)
    const cases: [string, SkillMove, PadScript][] = [
      ['flick left or right: body feint', SkillMove.BODY_FEINT, rightPath(4, repeat(SIDE, 3))],
      ['hold left or right: ball roll', SkillMove.BALL_ROLL, rightPath(4, repeat(SIDE, 40))],
      ['roll from forward to a side: step-over', SkillMove.STEP_OVER,
        rightPath(4, [[1, 0], [1, 0], [0.92, 0.38], [0.7, 0.7], [0.38, 0.92], [0, 1], [0, 1]])],
      ['flick forward then back: heel flick', SkillMove.HEEL_FLICK,
        rightPath(4, [[1, 0], [1, 0], [1, 0], [0, 0], [0, 0], [-1, 0], [-1, 0], [-1, 0]])],
      ['roll from back through a side to forward: roulette', SkillMove.ROULETTE,
        rightPath(4, [[-1, 0], [-1, 0], [-0.7, 0.7], [0, 1], [0.7, 0.7], [1, 0], [1, 0]])],
      ['L1 + R1 + left stick flicked backward: drag-back', SkillMove.DRAG_BACK,
        all(holdDuring(PadButton.L1, 2, 9), holdDuring(PadButton.R1, 2, 9), leftPath(5, repeat([-1, 0], 3)))],
    ];
    for (const [name, move, script] of cases) {
      it(name, () => {
        const s = scene();
        const m = padMatch(s);
        m.run(40, script);
        expect(m.frames.filter((f) => f.skill !== SkillMove.NONE).map((f) => f.skill)).toEqual([move]);
        expect(skillEvents(m)).toEqual([move]);
        expect(STARTS.filter((c) => c.ok === 1)).toHaveLength(0); // no pass / shot from any of it
      });
    }
  });
});

// ====================================================================== Attacking + Shooting (single presses)

interface ComboRow { row: string; mods: number[]; face: number; fn: string; kind: KickKind; flags: number }

const COMBO_ROWS: ComboRow[] = [
  { row: 'Ground pass / header: Cross', mods: [], face: PadButton.SOUTH, fn: 'startPass', kind: KickKind.GROUND_PASS, flags: 0 },
  { row: 'Lob pass / cross / header: Square', mods: [], face: PadButton.WEST, fn: 'startLob', kind: KickKind.LOB_PASS, flags: 0 },
  { row: 'Through ball: Triangle', mods: [], face: PadButton.NORTH, fn: 'startThrough', kind: KickKind.THROUGH_GROUND, flags: 0 },
  { row: 'Shoot / volley / header: Circle', mods: [], face: PadButton.EAST, fn: 'startShot', kind: KickKind.SHOT_NORMAL, flags: 0 },
  { row: 'Driven ground pass: R1 + Cross', mods: [PadButton.R1], face: PadButton.SOUTH, fn: 'startPass', kind: KickKind.DRIVEN_PASS, flags: ReqFlag.DRIVEN },
  { row: 'Lobbed through ball: L1 + Triangle', mods: [PadButton.L1], face: PadButton.NORTH, fn: 'startThrough', kind: KickKind.THROUGH_LOBBED, flags: 0 },
  { row: 'High lob: L1 + Square', mods: [PadButton.L1], face: PadButton.WEST, fn: 'startLob', kind: KickKind.HIGH_LOB, flags: 0 },
  { row: 'Driven lob / driven cross: L1 + R1 + Square', mods: [PadButton.L1, PadButton.R1], face: PadButton.WEST, fn: 'startLob', kind: KickKind.DRIVEN_LOB, flags: ReqFlag.DRIVEN },
  { row: 'Pass and go: L1 + Cross', mods: [PadButton.L1], face: PadButton.SOUTH, fn: 'startPass', kind: KickKind.GROUND_PASS, flags: ReqFlag.PASS_AND_GO },
  { row: 'Shot (hold for power): Circle', mods: [], face: PadButton.EAST, fn: 'startShot', kind: KickKind.SHOT_NORMAL, flags: 0 },
  { row: 'Finesse shot: R1 + Circle', mods: [PadButton.R1], face: PadButton.EAST, fn: 'startShot', kind: KickKind.SHOT_FINESSE, flags: 0 },
  { row: 'Chip shot: L1 + Circle', mods: [PadButton.L1], face: PadButton.EAST, fn: 'startShot', kind: KickKind.SHOT_CHIP, flags: 0 },
  { row: 'Power shot: L1 + R1 + Circle', mods: [PadButton.L1, PadButton.R1], face: PadButton.EAST, fn: 'startShot', kind: KickKind.SHOT_POWER, flags: 0 },
];

function comboScript(r: ComboRow, at = 6, hold = 4): PadScript {
  const mods = r.mods.map((b) => holdDuring(b, at - 2, at + hold + 4));
  return all(...mods, holdDuring(r.face, at, at + hold));
}

describe('PAD-02 §10 Attacking and Shooting: button and combo rows', () => {
  for (const r of COMBO_ROWS) {
    it(r.row, () => {
      const s = scene({ x: 30 });
      const m = padMatch(s);
      let started = -1;
      m.run(12, comboScript(r), (st) => {
        if (started < 0 && st.players[P]!.act !== ActionKind.NONE) started = st.tick;
      });
      const c = firstKick();
      expect([c.fn, c.kind, c.flags & MODS_FLAGS]).toEqual([r.fn, r.kind, r.flags]);
      expect(c.tick).toBe(6); // resolved on the face press tick (modifiers were down since tick 4)
      expect(c.charging).toBe(1); // still held: the power bar charges
      const p = s.players[P]!;
      expect(p.act).toBe(r.fn === 'startShot' ? ActionKind.SHOT : ActionKind.KICK);
      expect(p.actKick).toBe(r.kind);
      expect(started).toBe(6);
      expect(STARTS.filter((x) => x.ok === 1)).toHaveLength(1);
    });
  }

  it('Lob pass / cross: Square in the crossing zone asks SIM-09 for the lob it turns into a cross', () => {
    const s = scene({ x: 42, z: -26 });
    const m = padMatch(s);
    m.run(10, holdDuring(PadButton.WEST, 4, 8));
    const c = firstKick();
    expect([c.fn, c.kind, c.flags & MODS_FLAGS]).toEqual(['startLob', KickKind.LOB_PASS, 0]);
    expect([KickKind.LOB_PASS, KickKind.CROSS]).toContain(s.players[P]!.actKick);
  });

  it('Shot (hold for power): Circle held longer gives more power; a tap a little', () => {
    const power = (hold: number): number => {
      resetStarts();
      const s = scene({ x: 30 });
      const m = padMatch(s);
      let best = 0;
      m.run(hold + 6, holdDuring(PadButton.EAST, 3, 3 + hold), (st) => {
        const p = st.players[P]!;
        if (p.act === ActionKind.SHOT && p.actPower > best) best = p.actPower;
      });
      return best;
    };
    const tap = power(1);
    const half = power(Math.round(T_PASS.powerFillTicks / 2));
    const full = power(T_PASS.powerFillTicks + 4);
    expect(tap).toBeLessThan(0.1);
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(full).toBe(1);
  });

  it('Header (Cross / Square / Circle): a cross at head height is headed (HEADER_PASS / HEADER_SHOT)', () => {
    const cases: [number, KickKind][] = [
      [PadButton.SOUTH, KickKind.HEADER_PASS], [PadButton.WEST, KickKind.HEADER_PASS], [PadButton.EAST, KickKind.HEADER_SHOT],
    ];
    for (const [btn, kind] of cases) {
      const s = aerialScene('header');
      const got = pressOnAerialChance(s, btn);
      expect(got, `button ${btn}`).toEqual({ act: ActionKind.HEADER, kind });
    }
  });

  it('Volley (Circle): a ball arriving at waist height is volleyed (VOLLEY_SHOT)', () => {
    const s = aerialScene('volley');
    expect(pressOnAerialChance(s, PadButton.EAST)).toEqual({ act: ActionKind.VOLLEY, kind: KickKind.VOLLEY_SHOT });
  });
});

// ---------------------------------------------------------------- aerial scenes

const SOL = createLaunchSolution();

/** P1's striker (slot 9) under a cross from teammate 7: a header at (41, 0) or a volley at (38, 2). */
function aerialScene(kind: 'header' | 'volley'): SimState {
  const s = kind === 'header' ? scene({ x: 41, z: 0, ball: 'loose' }) : scene({ x: 38, z: 2, ball: 'loose' });
  // Opponents out of the way (as the SIM-12 aerial tests), keeper on his line.
  for (let i = 12; i < 22; i++) { s.players[i]!.x = -36; s.players[i]!.z = -30 + (i - 11) * 5.5; }
  s.players[11]!.x = 51;
  const [fx, fz, tx, tz, ang] = kind === 'header' ? [38, -28, 42, 0, 0.5] : [28, -18, 39.5, 2, 0.24];
  const crosser = s.players[7]!;
  crosser.x = fx - 0.8; crosser.z = fz;
  solveLaunchSpin(tx - fx, tz - fz, ang, BALL_RADIUS, 0, 0, SOL);
  const b = s.ball;
  b.x = fx; b.y = BALL_RADIUS; b.z = fz; b.px = fx; b.py = BALL_RADIUS; b.pz = fz;
  b.vx = SOL.vx; b.vy = SOL.vy; b.vz = SOL.vz; b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 0; b.bounces = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0;
  b.lastTouch = 7; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
  b.lastKickBy = 7; b.lastKickTeam = 0; b.lastKickKind = KickKind.CROSS; b.lastKickTick = s.tick;
  b.passTarget = -1; b.shotBy = -1;
  return s;
}

/** Press `btn` (held 10 ticks) from the first tick P has an aerial chance; the aerial action he starts. */
function pressOnAerialChance(s: SimState, btn: number): { act: ActionKind; kind: KickKind } | null {
  const m = padMatch(s);
  let from = -1;
  let got: { act: ActionKind; kind: KickKind } | null = null;
  m.run(150, (tick, sub, r, st) => {
    if (sub !== 0) return;
    if (from < 0 && aerialChance(st, P) > 0) { from = tick; r.press(btn); }
    if (from > 0 && tick === from + 10) r.release(btn);
  }, (st) => {
    const p = st.players[P]!;
    if (!got && (p.act === ActionKind.HEADER || p.act === ActionKind.VOLLEY)) got = { act: p.act, kind: p.actKick };
  });
  expect(from).toBeGreaterThan(0);
  return got;
}

// ====================================================================== Attacking: double presses, taps, fakes

describe('PAD-02 §10 Attacking: double presses, taps and fakes', () => {
  const doubles: [string, number, KickKind, KickKind, number][] = [
    ['Lofted ground pass: Cross, Cross', PadButton.SOUTH, KickKind.GROUND_PASS, KickKind.DINKED_PASS, ReqFlag.LOFTED],
    ['Lofted through ball: Triangle, Triangle', PadButton.NORTH, KickKind.THROUGH_GROUND, KickKind.THROUGH_DINKED, ReqFlag.LOFTED],
    ['Ground cross: Square, Square', PadButton.WEST, KickKind.LOB_PASS, KickKind.GROUND_CROSS, 0],
  ];
  for (const [row, btn, first, second, flag] of doubles) {
    it(row, () => {
      const s = scene({ x: 30 });
      const m = padMatch(s);
      m.run(14, all(tapAt(btn, 4), tapAt(btn, 8)));
      const calls = STARTS.filter((c) => c.ok === 1);
      expect(calls.map((c) => c.kind)).toEqual([first, second]);
      expect(calls[1]!.flags & MODS_FLAGS).toBe(flag);
      expect(s.players[P]!.actKick).toBe(second);
      // Both taps reached the sim as separate presses.
      const presses = m.frames.filter((f, i) => (f.buttons & (1 << btn)) !== 0 && (i === 0 || (m.frames[i - 1]!.buttons & (1 << btn)) === 0));
      expect(presses).toHaveLength(2);
    });
  }

  it('Lofted ground pass: Cross, Cross with both taps inside ONE tick interval at 120 Hz still double-taps', () => {
    const s = scene({ x: 30 });
    const m = padMatch(s);
    // Tap 1 at tick 4; tap 2 released and re-pressed between the samples of ticks 6 and 7.
    m.run(14, all(holdDuring(PadButton.SOUTH, 4, 6), (tick, sub, r) => {
      if (tick === 6 && sub === 1) r.press(PadButton.SOUTH);
      if (tick === 7 && sub === 1) r.release(PadButton.SOUTH);
    }));
    expect(STARTS.filter((c) => c.ok === 1).map((c) => c.kind)).toEqual([KickKind.GROUND_PASS, KickKind.DINKED_PASS]);
  });

  it('Trigger a run: L1 (tap)', () => {
    const s = scene({ x: 20 });
    const m = padMatch(s);
    m.run(10, tapAt(PadButton.L1, 4));
    expect(s.teams[0]!.runSlot).toBeGreaterThanOrEqual(0);
    expect(s.teams[0]!.runCallT).toBeGreaterThan(0);
    expect(STARTS.filter((c) => c.ok === 1)).toHaveLength(0);
    // A held L1 (strafe dribble) is not a tap: no run.
    const h = scene({ x: 20 });
    padMatch(h).run(30, holdDuring(PadButton.L1, 4, 4 + T_INPUT.tapTicks + 4));
    expect(h.teams[0]!.runCallT).toBe(0);
  });

  it('Call for support: R1 (tap)', () => {
    const s = scene({ x: 20 });
    const mate = s.players[7]!;
    mate.x = 12; mate.z = 8;
    const m = padMatch(s);
    m.run(10, tapAt(PadButton.R1, 4));
    expect(s.teams[0]!.supportSlot).toBeGreaterThanOrEqual(0);
    expect(s.teams[0]!.supportCallT).toBeGreaterThan(0);
    expect(STARTS.filter((c) => c.ok === 1)).toHaveLength(0);
  });

  for (const [row, first, kind] of [
    ['Fake shot: Circle, then Cross', PadButton.EAST, KickKind.SHOT_NORMAL],
    ['Fake pass: Square, then Cross', PadButton.WEST, KickKind.LOB_PASS],
  ] as [string, number, KickKind][]) {
    it(row, () => {
      const s = scene({ x: 30 });
      const m = padMatch(s);
      m.run(12, all(holdDuring(first, 4, 9), tapAt(PadButton.SOUTH, 7)));
      expect(STARTS.filter((c) => c.ok === 1).map((c) => c.kind)).toEqual([kind]); // no pass from the Cross
      expect(skillEvents(m)).toEqual([SkillMove.FAKE_SHOT]);
      expect(s.players[P]!.act).toBe(ActionKind.FAKE);
    });
  }

  it('Cancel advantage: L2 + R2', () => {
    const run = (script: PadScript): { ev: SimEvent[]; phase: MatchPhase } => {
      const s = scene({ x: 20 });
      const a = s.match.advantage;
      a.active = 1; a.team = 0; a.offender = 14; a.victim = P; a.x = 18; a.z = 1; a.startTick = s.tick;
      a.card = CardKind.NONE; a.penalty = 0;
      const m = padMatch(s);
      m.run(10, script);
      return { ev: m.events.filter((e) => e.type === EventType.ADVANTAGE), phase: s.match.phase };
    };
    const both = run(all(holdDuring(PadButton.L2, 5, 9), holdDuring(PadButton.R2, 5, 9)));
    expect(both.ev.map((e) => [e.a, e.b])).toEqual([[2, 0]]);
    expect(both.phase).toBe(MatchPhase.FREE_KICK);
    // Completing the pair later (R2 while L2 is held) also cancels; either trigger alone does not.
    const late = run(all(holdDuring(PadButton.L2, 3, 9), holdDuring(PadButton.R2, 6, 9)));
    expect(late.ev.map((e) => e.a)).toEqual([2]);
    expect(run(holdDuring(PadButton.L2, 3, 9)).ev).toEqual([]);
    expect(run(holdDuring(PadButton.R2, 3, 9)).ev).toEqual([]);
  });
});

// ====================================================================== Shooting: low driven

describe('PAD-02 §10 Shooting: low driven shot', () => {
  const lowDriven = (): boolean => {
    if (startsOf('markLowDriven').length > 0) return true;
    return STARTS.some((c) => c.ok === 1 && c.kind === KickKind.SHOT_LOW_DRIVEN && (c.flags & ReqFlag.LOW) !== 0);
  };

  it('Low driven shot: Circle, then tap Circle again during power-up', () => {
    const s = scene({ x: 30 });
    const m = padMatch(s);
    // Hold Circle (power-up) for 12 ticks, release, tap again within the grace window.
    m.run(24, all(holdDuring(PadButton.EAST, 3, 15), tapAt(PadButton.EAST, 17)));
    expect(firstKick().kind).toBe(KickKind.SHOT_NORMAL);
    expect(lowDriven()).toBe(true);
    if (startsOf('markLowDriven').length === 0) expect(s.players[P]!.actKick).toBe(KickKind.SHOT_LOW_DRIVEN);
  });

  it('Low driven shot: two quick Circle taps (both inside the tap window)', () => {
    const s = scene({ x: 30 });
    const m = padMatch(s);
    m.run(14, all(tapAt(PadButton.EAST, 4), tapAt(PadButton.EAST, 7)));
    expect(firstKick().kind).toBe(KickKind.SHOT_NORMAL);
    expect(lowDriven()).toBe(true);
  });

  it('a single held Circle is a normal shot (no low driven)', () => {
    const s = scene({ x: 30 });
    padMatch(s).run(30, holdDuring(PadButton.EAST, 3, 20));
    expect(firstKick().kind).toBe(KickKind.SHOT_NORMAL);
    expect(lowDriven()).toBe(false);
  });
});

// ====================================================================== Controller quality bar

describe('PAD-02 §10 quality bar: "A modifier combo resolves when the face button is pressed, never when the modifier is"', () => {
  const shotKind = (script: PadScript): KickKind => {
    resetStarts();
    const s = scene({ x: 30 });
    padMatch(s).run(14, script);
    return firstKick().kind;
  };

  it('R1 pressed while Circle is already held does not turn the shot into a finesse shot', () => {
    expect(shotKind(all(holdDuring(PadButton.EAST, 4, 10), holdDuring(PadButton.R1, 5, 12)))).toBe(KickKind.SHOT_NORMAL);
  });

  it('R1 pressed one animation frame after Circle inside the same tick does not combo either (mapper keeps the order)', () => {
    expect(shotKind(all(holdDuring(PadButton.EAST, 4, 10), (tick, sub, r) => { if (tick === 4 && sub === 1) r.press(PadButton.R1); })))
      .toBe(KickKind.SHOT_NORMAL);
  });

  it('R1 held at the Circle press (pressed before, or in the same poll) is a finesse shot', () => {
    expect(shotKind(all(holdDuring(PadButton.R1, 3, 12), holdDuring(PadButton.EAST, 4, 10)))).toBe(KickKind.SHOT_FINESSE);
    expect(shotKind(all(holdDuring(PadButton.R1, 4, 12), holdDuring(PadButton.EAST, 4, 10)))).toBe(KickKind.SHOT_FINESSE);
    expect(shotKind(all((tick, sub, r) => { if (tick === 4 && sub === 0) r.press(PadButton.L1); }, (tick, sub, r) => {
      if (tick === 4 && sub === 1) r.press(PadButton.EAST);
      if (tick === 9 && sub === 0) { r.release(PadButton.EAST); r.release(PadButton.L1); }
    }))).toBe(KickKind.SHOT_CHIP);
  });

  it('a modifier released before the face press is not part of the combo, and pressing a modifier alone starts nothing', () => {
    expect(shotKind(all(holdDuring(PadButton.L1, 2, 4), holdDuring(PadButton.EAST, 6, 10)))).toBe(KickKind.SHOT_NORMAL);
    resetStarts();
    const s = scene({ x: 30 });
    padMatch(s).run(20, all(holdDuring(PadButton.L1, 3, 15), holdDuring(PadButton.R1, 4, 15)));
    expect(STARTS.filter((c) => c.ok === 1)).toHaveLength(0);
  });
});

describe('PAD-02 §10 quality bar: "Input buffering: a press up to 6 ticks before the player can act still fires"', () => {
  /** P busy with a stop-the-ball move (SIM-13, fixed length, ball kept at his feet); the tick he is free again. */
  function busyScene(): { s: SimState; free: number } {
    const s = scene({ x: 20 });
    expect(startSkill(s, P, SkillMove.STOP_BALL, 0, 0, createEventBuffer())).toBe(1);
    const probe = cloneState(s);
    const pm = padMatch(probe);
    let free = -1;
    pm.run(40, undefined, (st) => { if (free < 0 && st.players[P]!.act === ActionKind.NONE) free = st.tick + 1; });
    expect(free).toBeGreaterThan(s.tick + 6);
    return { s, free };
  }

  function passTickWithTapAt(lead: number): number {
    const { s, free } = busyScene();
    resetStarts();
    const m = padMatch(s);
    m.run(free - s.tick + 10, tapAt(PadButton.SOUTH, free - lead));
    const c = STARTS.find((x) => x.ok === 1 && x.fn === 'startPass');
    return c ? c.tick - free : -999;
  }

  it(`a Cross tap ${T_INPUT.bufferTicks} ticks before the player is free passes on the first free tick`, () => {
    expect(T_INPUT.bufferTicks).toBe(6);
    expect(passTickWithTapAt(T_INPUT.bufferTicks)).toBe(0);
    expect(passTickWithTapAt(1)).toBe(0);
  });

  it(`a Cross tap ${T_INPUT.bufferTicks + 1} ticks before is dropped (no late pass)`, () => {
    expect(passTickWithTapAt(T_INPUT.bufferTicks + 1)).toBe(-999);
  });
});

describe('PAD-02 input glitches through the pad', () => {
  it('Input glitch: power bar stuck full: Circle held for 5 s still ends the charge (shot released, bar empty)', () => {
    const s = scene({ x: 30 });
    const m = padMatch(s);
    m.run(300, holdDuring(PadButton.EAST, 3, 999));
    expect(m.frames.at(-1)!.buttons & Btn.SHOOT).toBe(Btn.SHOOT); // still physically held
    expect(startsOf('startShot')).toHaveLength(1);
    expect(s.players[P]!.act).not.toBe(ActionKind.SHOT);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
    expect(s.ctrl[0]!.power).toBe(0);
  });

  it('Input glitch: no stuck sprint after pause (releaseAll with R2 held): the sim sees R2 released until re-pressed', () => {
    const s = scene({ ball: 'none' });
    const m = padMatch(s);
    m.run(10, all(stickAt([[2, 1, 0]]), holdDuring(PadButton.R2, 2, 999)));
    expect(s.players[P]!.wantSprint).toBe(1);
    m.rig.src.releaseAll(); // session.pause() / resume()
    m.run(10);
    expect(s.players[P]!.wantSprint).toBe(0);
    expect(m.frames.at(-1)!.buttons & Btn.SPRINT).toBe(0);
    m.run(4, (tick, sub, r) => { if (sub === 0) r.release(PadButton.R2); });
    m.run(4, (tick, sub, r) => { if (sub === 0) r.press(PadButton.R2); });
    expect(s.players[P]!.wantSprint).toBe(1);
  });
});

// ====================================================================== determinism end to end

describe('PAD-02 determinism: pad session -> mapper -> step', () => {
  it('the same pad state sequence gives the same frames and the same state hash', () => {
    const session = (): { hash: number; frames: string } => {
      resetStarts();
      const s = scene({ x: 10 });
      const m = padMatch(s);
      m.run(180, all(
        stickAt([[2, 1, 0], [40, 0.6, -0.8], [80, -0.2, 1], [120, 0, 0]]),
        holdDuring(PadButton.R2, 10, 60),
        rightPath(70, [[0, 1], [0, 1], [0, 1]]),
        tapAt(PadButton.SOUTH, 130),
        tapAt(PadButton.L1, 150),
      ));
      return { hash: hashState(s), frames: JSON.stringify(m.frames) };
    };
    const a = session();
    const b = session();
    expect(b.frames).toBe(a.frames);
    expect(b.hash).toBe(a.hash);
  });
});
