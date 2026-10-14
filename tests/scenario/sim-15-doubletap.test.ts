/**
 * SIM-15 — double-tap windows, tap grace and first-time charging against REAL kick contact timing: SIM-08 pass.ts is
 * not mocked, so its kickHandler strikes (or whiffs) every KICK action at the real contact tick. LOB / THROUGH
 * starters are recording fakes that begin the same KICK action (wind-up T_PASS.windup), so the real handler times
 * them too. Gap = ticks from the first press to the second press.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/lob', async (o) => (await import('./sim-15-fakes')).mockLob((await o()) as Record<string, unknown>));
vi.mock('../../src/sim/kicks/through', async (o) => (await import('./sim-15-fakes')).mockThrough((await o()) as Record<string, unknown>));

import { ActionKind, AutoSwitch, KickKind } from '../../src/contracts/enums';
import { Btn, createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_INPUT, T_PASS } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { LOCAL_TUNING, pressSlotOf, BI } from '../../src/sim/control/resolveShared';
import { resetFakes } from './sim-15-fakes';
import { scene } from './sim-15-setup';

const P = 9;
const R = 10;

interface Kick { tick: number; slot: number; kind: KickKind }
interface Trace { kicks: Kick[]; leftFeet: number; lastTouch: number }

/** Run n ticks; press(i) gives P1's buttons for tick i. Records every KICK action start and the tick the ball left P. */
function trace(s: SimState, n: number, press: (i: number) => number): Trace {
  const ev = createEventBuffer();
  const t: Trace = { kicks: [], leftFeet: -1, lastTouch: -1 };
  for (let i = 1; i <= n; i++) {
    const f = createInputFrame();
    f.buttons = press(i);
    step(s, [f, createInputFrame()], ev);
    for (let k = 0; k < 22; k++) {
      const p = s.players[k]!;
      if (p.act === ActionKind.KICK && p.actT === 1) t.kicks.push({ tick: s.tick, slot: k, kind: p.actKick });
    }
    if (t.leftFeet < 0 && s.ball.owner !== P) t.leftFeet = s.tick;
  }
  t.lastTouch = s.ball.lastTouch;
  return t;
}

/** P (#9) with the ball at (10, 0) facing +x, receiver #10 at (25, 0). */
function passScene(autoSwitch: AutoSwitch): SimState {
  resetFakes();
  const s = scene({ autoSwitch });
  const r = s.players[R]!;
  r.x = 25; r.z = 0;
  return s;
}

/** First tap on tick 1 (one tick), second tap on tick 1 + gap. */
const taps = (bit: number, gap: number) => (i: number): number => (i === 1 || i === 1 + gap ? bit : 0);

describe('SIM-15 double-tap window edge with real kick contact timing', () => {
  it('tapGraceTicks is derived from T_INPUT.doubleTapTicks', () => {
    expect(LOCAL_TUNING.tapGraceTicks).toBe(T_INPUT.doubleTapTicks);
  });

  for (const auto of [AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE]) {
    it(`PASS,PASS: every gap 2..T_INPUT.doubleTapTicks converts to DINKED_PASS (autoSwitch ${AutoSwitch[auto]})`, () => {
      for (let gap = 2; gap <= T_INPUT.doubleTapTicks; gap++) {
        const s = passScene(auto);
        const t = trace(s, 30, taps(Btn.PASS, gap));
        expect(t.kicks.map((k) => [k.slot, k.kind]), `gap ${gap}`).toEqual([[P, KickKind.GROUND_PASS], [P, KickKind.DINKED_PASS]]);
        expect(t.kicks[1]!.tick, `gap ${gap}`).toBe(1 + gap);
        expect(t.lastTouch, `gap ${gap}`).toBe(P); // the dinked pass was struck
      }
    });
  }

  it('glitch "double tap 13-15 ticks apart plays a ground pass": the second tap at exactly doubleTapTicks still converts', () => {
    const s = passScene(AutoSwitch.OFF);
    const t = trace(s, 40, taps(Btn.PASS, T_INPUT.doubleTapTicks));
    expect(t.kicks.map((k) => k.kind)).toEqual([KickKind.GROUND_PASS, KickKind.DINKED_PASS]);
  });

  it('a second tap one tick after the window is a fresh press: never dinked (autoSwitch OFF: the passer has no ball)', () => {
    const s = passScene(AutoSwitch.OFF);
    const t = trace(s, 120, taps(Btn.PASS, T_INPUT.doubleTapTicks + 1));
    expect(t.kicks.map((k) => k.kind)).not.toContain(KickKind.DINKED_PASS);
    expect(t.kicks[0]!.kind).toBe(KickKind.GROUND_PASS);
    expect(t.leftFeet).toBe(1 + LOCAL_TUNING.tapGraceTicks); // tapped ground pass struck when the grace ended
  });

  it('glitch "receiver plays a dinked pass nobody asked for": a late second tap after the auto-switch is a plain first-time pass', () => {
    const s = passScene(AutoSwitch.AIR_AND_LOOSE);
    const t = trace(s, 140, taps(Btn.PASS, T_INPUT.doubleTapTicks + 1));
    expect(t.kicks.some((k) => k.kind === KickKind.DINKED_PASS)).toBe(false);
    const recv = t.kicks.filter((k) => k.slot === R);
    expect(recv.map((k) => k.kind)).toEqual([KickKind.GROUND_PASS]);
  });

  it('LOB,LOB at exactly doubleTapTicks converts to GROUND_CROSS', () => {
    const s = passScene(AutoSwitch.OFF);
    const t = trace(s, 30, taps(Btn.LOB, T_INPUT.doubleTapTicks));
    expect(t.kicks.map((k) => k.kind)).toEqual([KickKind.LOB_PASS, KickKind.GROUND_CROSS]);
  });

  it('THROUGH,THROUGH at exactly doubleTapTicks converts to THROUGH_DINKED', () => {
    const s = passScene(AutoSwitch.OFF);
    const t = trace(s, 30, taps(Btn.THROUGH, T_INPUT.doubleTapTicks));
    expect(t.kicks.map((k) => k.kind)).toEqual([KickKind.THROUGH_GROUND, KickKind.THROUGH_DINKED]);
  });

  it('LOB,LOB / THROUGH,THROUGH one tick after the window do not convert', () => {
    for (const bit of [Btn.LOB, Btn.THROUGH]) {
      const s = passScene(AutoSwitch.OFF);
      const t = trace(s, 30, taps(bit, T_INPUT.doubleTapTicks + 1));
      expect(t.kicks.map((k) => k.kind)).not.toContain(bit === Btn.LOB ? KickKind.GROUND_CROSS : KickKind.THROUGH_DINKED);
    }
  });
});

describe('SIM-15 a double tap never spans a change of controlled player', () => {
  it('R1+Cross tapped (driven pass strikes at the wind-up), auto-switch to the receiver, Cross inside the window -> receiver ground pass, not dinked', () => {
    const s = passScene(AutoSwitch.AIR_AND_LOOSE);
    let switchedAt = -1;
    const gap = T_INPUT.doubleTapTicks - 2;
    const ev = createEventBuffer();
    const kicks: Kick[] = [];
    for (let i = 1; i <= 140; i++) {
      const f = createInputFrame();
      if (i === 1) f.buttons = Btn.MOD_R | Btn.PASS;
      if (i === 1 + gap) f.buttons = Btn.PASS;
      step(s, [f, createInputFrame()], ev);
      if (switchedAt < 0 && s.ctrl[0]!.slot === R) switchedAt = s.tick;
      if (i === 1 + gap) {
        expect(s.ctrl[0]!.slot).toBe(R);
        expect(pressSlotOf(s.ctrl[0]!, BI.PASS)).toBe(R);
      }
      for (let k = 0; k < 22; k++) {
        const p = s.players[k]!;
        if (p.act === ActionKind.KICK && p.actT === 1) kicks.push({ tick: s.tick, slot: k, kind: p.actKick });
      }
    }
    expect(switchedAt).toBeGreaterThan(0);
    expect(switchedAt).toBeLessThan(1 + gap); // the switch happened inside the double-tap window
    expect(kicks[0]).toMatchObject({ slot: P, kind: KickKind.DRIVEN_PASS });
    expect(kicks.some((k) => k.kind === KickKind.DINKED_PASS)).toBe(false);
    expect(kicks.filter((k) => k.slot === R).map((k) => k.kind)).toEqual([KickKind.GROUND_PASS]);
  });

  it('the press slot is recorded per button (PASS, LOB, THROUGH) and survives the charge bookkeeping', () => {
    const s = passScene(AutoSwitch.OFF);
    trace(s, 3, (i) => (i === 1 ? Btn.PASS : 0));
    const c = s.ctrl[0]!;
    expect(pressSlotOf(c, BI.PASS)).toBe(P);
    expect(pressSlotOf(c, BI.LOB)).toBe(-1);
    expect(pressSlotOf(c, BI.SHOOT)).toBe(-1);
    expect(c.powerBtn).toBe(Btn.PASS); // tap grace running: charge slot and press slot share seqA
    expect((c.seqA >> 8) & 31).toBe(P + 1);
  });
});

describe('SIM-15 tap grace only where a second press can convert', () => {
  it('a tapped R1+Cross (driven pass, no double-tap version) strikes at the wind-up, no grace delay', () => {
    const s = passScene(AutoSwitch.OFF);
    const t = trace(s, 30, (i) => (i === 1 ? Btn.MOD_R | Btn.PASS : 0));
    expect(t.kicks.map((k) => k.kind)).toEqual([KickKind.DRIVEN_PASS]);
    expect(t.leftFeet).toBe(T_PASS.windup); // started on tick 1 (actT 1), contact at actT = windup
  });
  it('a tapped Cross (ground pass) keeps the grace and strikes at press + doubleTapTicks', () => {
    const s = passScene(AutoSwitch.OFF);
    const t = trace(s, 30, (i) => (i === 1 ? Btn.PASS : 0));
    expect(t.leftFeet).toBe(1 + T_INPUT.doubleTapTicks);
    expect(s.players[P]!.actCharging).toBe(0);
  });
});

describe('SIM-15 first-time kicks: the charge ends when the ball arrives', () => {
  /** Ball rolling at 14 m/s toward P from 12 m (our pass, P the target); P1 presses PASS from `at` for `hold` ticks. */
  function firstTime(at: number, hold: number): { s: SimState; t: Trace } {
    resetFakes();
    const s = scene({ ball: 'none', autoSwitch: AutoSwitch.OFF });
    const p = s.players[P]!;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = p.x + 12; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y;
    b.vx = -14; b.vz = 0; b.vy = 0; b.grounded = 1;
    b.passTarget = P; b.lastTouchTeam = 0; b.lastTouch = 7; b.lastKickTeam = 0;
    const t = trace(s, 70, (i) => (i >= at && i < at + hold ? Btn.PASS : 0));
    return { s, t };
  }

  it('glitch "first-time pass whiffs while the button is held": a press held past the arrival still strikes the ball', () => {
    for (const at of [42, 43, 44]) {
      const { s, t } = firstTime(at, 20);
      expect(t.kicks.filter((k) => k.slot === P).map((k) => k.kind), `press at ${at}`).toEqual([KickKind.GROUND_PASS]);
      expect(t.lastTouch, `press at ${at}`).toBe(P);
      expect(s.ball.vx, `press at ${at}`).toBeGreaterThan(-5); // played on, not rolling past at -14 m/s
    }
  });

  it('a tapped first-time pass gets no tap grace: it strikes as the ball arrives, same tick as an untimed press', () => {
    const early = firstTime(30, 2); // released long before the launch: no charge at all
    const late = firstTime(42, 2); // launched while held (charging), then released
    expect(late.t.kicks[0]!.tick).toBe(early.t.kicks[0]!.tick);
    expect(late.t.lastTouch).toBe(P);
    expect(late.s.ball.vx).toBeCloseTo(early.s.ball.vx, 6);
  });
});
