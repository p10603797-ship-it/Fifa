/**
 * SIM-15 — commands, headless skip, set-piece / shoot-out routing, cut-scenes, CPU controllers through the same
 * path, determinism (incl. a mid-run clone: no hidden module state), per-tick budget, allocation, hostile input.
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
vi.mock('../../src/ai/tactics', async (o) => (await import('./sim-15-fakes')).mockTactics((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/rules/subs', async (o) => (await import('./sim-15-fakes')).mockSubs((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/rules/restart', async (o) => (await import('./sim-15-fakes')).mockRestart((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/rules/shootout', async (o) => (await import('./sim-15-fakes')).mockShootout((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/cpu/carrier', async (o) => (await import('./sim-15-fakes')).mockCpuCarrier((await o()) as Record<string, unknown>));
vi.mock('../../src/ai/cpu/defending', async (o) => (await import('./sim-15-fakes')).mockCpuDefending((await o()) as Record<string, unknown>));

import { ActionKind, Command, ControllerKind, GestureKind, KickKind, MatchPhase, RestartKind, SkillMove } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { T_PASS } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { step } from '../../src/sim/step';
import { chargeSlotOf } from '../../src/sim/control/resolveShared';
import { makeScenario } from '../harness/scenario';
import { CALLS, FAKE, calls, resetFakes } from './sim-15-fakes';
import { keepBall, run, scene } from './sim-15-setup';

beforeEach(() => resetFakes());

describe('SIM-15 commands', () => {
  it('tactics, focus, formation and corner tactics -> TAI-14 applyCommand for the controller side', () => {
    const s = scene();
    const cmds = [Command.TACTIC_TEAM_PRESS, Command.FOCUS_ATTACKING, Command.SET_FORMATION, Command.CORNER_FAR_POST, Command.SWAP_POSITIONS];
    run(s, cmds.length * 2, (i) => (i % 2 === 1 ? { cmd: cmds[(i - 1) / 2]!, cmdArg: i } : {}));
    const c = calls('applyCommand');
    expect(c.map((x) => x.kind)).toEqual(cmds);
    expect(c.every((x) => x.arg === 0)).toBe(true);
    expect(c.map((x) => x.arg2)).toEqual([1, 3, 5, 7, 9]);
  });
  it('Command.SUBSTITUTE -> RUL-10 requestSub(team, outSlot, inRoster)', () => {
    const s = scene();
    run(s, 1, () => ({ cmd: Command.SUBSTITUTE, cmdArg: 4 | (13 << 8) }));
    const c = calls('requestSub');
    expect(c).toHaveLength(1);
    expect([c[0]!.kind, c[0]!.slot, c[0]!.arg]).toEqual([0, 4, 13]);
  });
  it('QUICK_SUB is app-level (no sim effect); an out-of-range command is ignored', () => {
    const s = scene();
    run(s, 2, (i) => (i === 1 ? { cmd: Command.QUICK_SUB } : { cmd: 99 as Command }));
    expect(CALLS).toHaveLength(0);
  });
  it('Command.SKIP is OR-ed into ctrl.buttons as a Btn.SKIP edge for RUL-01', () => {
    const s = scene();
    run(s, 1, () => ({ cmd: Command.SKIP }));
    expect(s.ctrl[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    expect(s.ctrl[0]!.prevButtons & Btn.SKIP).toBe(0);
    run(s, 1, () => ({}));
    expect(s.ctrl[0]!.buttons & Btn.SKIP).toBe(0);
  });
  it('no HUMAN controllers: humanFrames[0] buttons (SKIP) still recorded into s.ctrl[0] (headless fast-forward)', () => {
    const s = makeScenario({ phase: MatchPhase.CELEBRATION, humans: 0 });
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.NONE);
    const ev = createEventBuffer();
    const f = createInputFrame();
    f.buttons = Btn.SKIP;
    step(s, [f], ev);
    expect(s.ctrl[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    const g = createInputFrame();
    g.cmd = Command.SKIP;
    step(s, [g], ev);
    expect(s.ctrl[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    expect(s.ctrl[0]!.slot).toBe(-1);
    step(s, [], ev);
    expect(s.ctrl[0]!.buttons).toBe(0);
  });
});

describe('SIM-15 restart, shoot-out and cut-scene routing', () => {
  function twoHumans(phase: MatchPhase): SimState {
    const s = scene({ p2Slot: 20, phase });
    s.match.restart.kind = phase === MatchPhase.CORNER ? RestartKind.CORNER : RestartKind.NONE;
    s.match.restart.team = 0;
    s.match.restart.taker = 9;
    return s;
  }
  it('restart phases route both sides\' frames to SETPIECE_INPUT[restart.kind] and nothing else', () => {
    const s = twoHumans(MatchPhase.CORNER);
    run(s, 1, (_i, _st, _f, f2) => { f2.buttons = Btn.THROUGH; return { buttons: Btn.LOB | Btn.MOD_L }; });
    const c = calls('setPieceInput');
    expect(c.map((x) => [x.kind, x.arg, x.arg2])).toEqual([[RestartKind.CORNER, 0, Btn.LOB | Btn.MOD_L], [RestartKind.CORNER, 1, Btn.THROUGH]]);
    expect(CALLS.filter((x) => x.fn.startsWith('start'))).toHaveLength(0);
  });
  it('a restart phase with restart.kind unset uses the phase\'s kind', () => {
    const s = twoHumans(MatchPhase.THROW_IN);
    run(s, 1);
    expect(calls('setPieceInput').map((x) => x.kind)).toEqual([RestartKind.THROW_IN, RestartKind.THROW_IN]);
  });
  it('SHOOT_OUT routes every controller to RUL-07 shootoutInput', () => {
    const s = twoHumans(MatchPhase.SHOOT_OUT);
    run(s, 1, () => ({ buttons: Btn.SHOOT }));
    expect(calls('shootoutInput').map((x) => x.arg)).toEqual([0, 1]);
    expect(calls('startShot', false)).toHaveLength(0);
  });
  it('cut-scenes: inputs start nothing, a running charge is released, the stale stick intent stops', () => {
    const s = scene({ phase: MatchPhase.IN_PLAY });
    run(s, 5, (_i, st) => { keepBall(st, 9); return { buttons: Btn.SHOOT, mx: 127 }; });
    expect(s.players[9]!.actCharging).toBe(1);
    s.match.phase = MatchPhase.GOAL;
    s.match.phaseT = 0;
    run(s, 1, () => ({ buttons: Btn.SHOOT | Btn.PASS, mx: 127 }));
    expect(s.players[9]!.actCharging).toBe(0);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
    expect(calls('startPass', false)).toHaveLength(0);
    expect(calls('setPieceInput')).toHaveLength(0);
  });
  it('outside play a stale DIRECT stick intent is stopped (players never keep running)', () => {
    const s = twoHumans(MatchPhase.CORNER);
    const p = s.players[9]!;
    p.moveMode = MoveMode.DIRECT; p.ix = 1; p.iz = 0; p.wantSprint = 1;
    run(s, 1);
    expect(p.moveMode).toBe(MoveMode.STOP);
    expect(p.wantSprint).toBe(0);
  });
  it('a charging set-piece kick started by the restart module gets the power bar of the pressed button', () => {
    const s = twoHumans(MatchPhase.CORNER);
    const p = s.players[9]!;
    // Simulate RUL-04 starting a charging cross on the press tick.
    run(s, 1, (_i, st) => { const q = st.players[9]!; q.act = ActionKind.KICK; q.actT = 0; q.actDur = 40; q.actCharging = 1; q.actKick = KickKind.CROSS; return { buttons: Btn.LOB }; });
    expect(s.ctrl[0]!.powerBtn).toBe(Btn.LOB);
    expect(chargeSlotOf(s.ctrl[0]!)).toBe(9);
    run(s, 5, () => ({ buttons: Btn.LOB }));
    expect(p.actPower).toBeCloseTo(6 / T_PASS.powerFillTicks, 9);
    run(s, 1, () => ({}));
    expect(p.actCharging).toBe(0); // released at once: no double-tap grace at set pieces
    expect(s.ctrl[0]!.powerBtn).toBe(0);
  });
  it('a set-piece kick of the dead ball (loose, in reach) keeps filling past its wind-up (the first-time cut is open play only)', () => {
    const s = twoHumans(MatchPhase.CORNER);
    const p = s.players[9]!;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = p.x + 0.4; b.z = p.z; b.y = 0.11; b.vx = 0; b.vz = 0; b.px = b.x; b.pz = b.z;
    run(s, 1, (_i, st) => {
      const q = st.players[9]!;
      q.act = ActionKind.KICK; q.actT = 0; q.actDur = 60; q.actContact = 8; q.actDone = 0; q.actCharging = 1; q.actKick = KickKind.CROSS;
      return { buttons: Btn.LOB };
    });
    run(s, 20, () => ({ buttons: Btn.LOB }));
    expect(p.actT).toBeGreaterThan(p.actContact);
    expect(p.actCharging).toBe(1);
    expect(p.actPower).toBeCloseTo(21 / T_PASS.powerFillTicks, 9);
  });
});

describe('SIM-15 edges for other modules', () => {
  it('§10 Cancel advantage (L2 + R2): the press edge is visible in ctrl.buttons / prevButtons for RUL-09', () => {
    const s = scene();
    run(s, 1, () => ({}));
    run(s, 1, () => ({ buttons: Btn.SHIELD | Btn.SPRINT }));
    const c = s.ctrl[0]!;
    expect(c.buttons & (Btn.SHIELD | Btn.SPRINT)).toBe(Btn.SHIELD | Btn.SPRINT);
    expect(c.prevButtons & (Btn.SHIELD | Btn.SPRINT)).toBe(0);
    expect(c.holdT[6]).toBe(1);
    expect(c.holdT[7]).toBe(1);
    expect(c.pressTick[7]).toBe(s.tick);
  });
  it('glitch "Input: power bar stuck full": control switched away from a charging player releases his charge', () => {
    const s = scene();
    const t = s.players[10]!; t.x = 14; t.z = 3;
    run(s, 6, (_i, st) => { keepBall(st, 9); return { buttons: Btn.SHOOT }; });
    expect(s.players[9]!.actCharging).toBe(1);
    expect(s.ctrl[0]!.powerBtn).toBe(Btn.SHOOT);
    // The ball goes to teammate 10: SIM-16 moves control to the new carrier.
    run(s, 2, (i, st) => { if (i === 1) keepBall(st, 10); return { buttons: Btn.SHOOT }; });
    expect(s.ctrl[0]!.slot).toBe(10);
    expect(s.players[9]!.actCharging).toBe(0);
    expect(s.ctrl[0]!.powerBtn).toBe(0);
    expect(calls('startShot').filter((x) => x.slot === 10)).toHaveLength(0); // the held button never re-fires
  });
});

describe('SIM-15 CPU controllers use the same path', () => {
  it('a CPU brain frame (teams[t].cpu.out) is resolved like a human frame, with ReqFlag.CPU', () => {
    const s = scene({ cpu: true, slot: 9, x: -20 });
    const q = s.players[20]!; q.x = 20; q.z = 0;
    keepBall(s, 20);
    s.ball.lastTouchTeam = 1; s.ball.lastTouch = 20;
    FAKE.cpuButtons = Btn.SHOOT;
    run(s, 3, (_i, st) => { keepBall(st, 20); });
    const c = calls('startShot').filter((x) => x.slot === 20);
    expect(c).toHaveLength(1);
    expect(c[0]!.flags & ReqFlag.CPU).toBe(ReqFlag.CPU);
    expect(c[0]!.kind).toBe(KickKind.SHOT_NORMAL);
    expect(s.ctrl[3]!.slot).toBe(20);
  });
});

describe('SIM-15 determinism and state', () => {
  function script(i: number, f: InputFrame): void {
    const r = (i * 2654435761) >>> 0;
    f.buttons = (r >>> 5) & 0x7ff;
    f.mx = ((r >>> 11) & 0xff) - 128;
    f.mz = ((r >>> 19) & 0xff) - 128;
    f.ax = ((r >>> 3) & 0xff) - 128;
    if (i % 23 === 0) { f.gesture = GestureKind.TAP; f.gx = 250; f.gz = 50; f.gSlot = 10; }
    if (i % 41 === 0) f.skill = SkillMove.BODY_FEINT;
    if (i % 59 === 0) f.power = 90;
  }
  function advance(s: SimState, from: number, n: number, out: number[]): void {
    const ev = createEventBuffer();
    const f = createInputFrame();
    const g = createInputFrame();
    for (let i = from; i < from + n; i++) {
      Object.assign(f, createInputFrame());
      script(i, f);
      if (i % 17 === 0 && s.ball.owner < 0) keepBall(s, 9);
      step(s, [f, g], ev);
      out.push(hashState(s));
    }
  }
  it('a clone taken mid-run continues bit-identically (all resolver state lives in SimState)', () => {
    const a = scene({ seed: 3 });
    const pre: number[] = [];
    advance(a, 1, 90, pre);
    const b = cloneState(a);
    const ha: number[] = [];
    const hb: number[] = [];
    advance(a, 91, 150, ha);
    advance(b, 91, 150, hb);
    expect(hb).toEqual(ha);
  });
});

describe('SIM-15 hostile input', () => {
  it('random, out-of-range and non-finite frames never throw or leave non-finite / stuck resolver state', () => {
    const s = scene({ p2Slot: 20, seed: 5 });
    const ev = createEventBuffer();
    const bad = [NaN, Infinity, -Infinity, 1e12, -1e12, 300, -300, 127, -127, 0, 3.7];
    let r = 99;
    const rnd = (): number => { r = (r * 1664525 + 1013904223) >>> 0; return r; };
    const pick = (): number => bad[rnd() % bad.length]!;
    const chargeRun = new Array<number>(22).fill(0);
    for (let i = 0; i < 2500; i++) {
      const fr: InputFrame[] = [createInputFrame(), createInputFrame()];
      for (const f of fr) {
        f.buttons = rnd() % 3 === 0 ? 0x7ff : rnd() & 0xffff;
        f.mx = pick(); f.mz = pick(); f.ax = pick(); f.az = pick(); f.power = pick(); f.curve = pick();
        f.skill = (rnd() % 16) as SkillMove; f.cmd = (rnd() % 20 === 0 ? Command.SKIP : 0) as Command; f.cmdArg = pick();
        f.gesture = (rnd() % 9) as GestureKind; f.gx = pick(); f.gz = pick(); f.gSlot = pick(); f.gdx = pick(); f.gdz = pick();
        f.gPower = pick(); f.gCurve = pick(); f.gFlags = pick();
      }
      if (i % 50 === 0 && s.match.phase === MatchPhase.IN_PLAY) keepBall(s, i % 100 === 0 ? 9 : 20);
      expect(() => step(s, rnd() % 10 === 0 ? [] : fr, ev)).not.toThrow();
      for (const c of s.ctrl) {
        for (const v of [c.mx, c.mz, c.power, c.bufArg, c.bufAction, c.bufExpire, c.seqA, c.seqB, c.stickIdleT, ...c.holdT]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(Math.hypot(c.mx, c.mz)).toBeLessThanOrEqual(1 + 1e-9);
        expect(c.power).toBeGreaterThanOrEqual(0);
        expect(c.power).toBeLessThanOrEqual(1);
      }
      for (let k = 0; k < 22; k++) {
        const p = s.players[k]!;
        expect(Number.isFinite(p.ix) && Number.isFinite(p.iz) && Number.isFinite(p.actPower)).toBe(true);
        chargeRun[k] = p.actCharging === 1 ? chargeRun[k]! + 1 : 0;
        expect(chargeRun[k]).toBeLessThanOrEqual(120);
      }
    }
  });
});
