/**
 * [QF-9] Wave 4 round 2 regressions in src/sim/control (SIM-15 resolver, SIM-16 switching): the lofted-ball meeting
 * point, auto-switching away from the man the ball comes to (a ball rolling into him, a header / clearance / tackle he
 * is committed to), auto-switching on a fresh face-press frame and a buffered press carried over to the new man, and
 * the loose-ball switch an opponent's receiver makes pointless (it flipped straight back once he controlled it).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_BALL, T_PLAYER, T_TOUCH } from '../../src/contracts/tuning';
import { beginAction } from '../../src/sim/actions/dispatch';
import { LT, MEET, meetPoint } from '../../src/sim/control/resolveShared';
import { debugSwitchEff, SWITCH_TUNING } from '../../src/sim/control/switching';
import { LOCAL_TUNING as LOCO } from '../../src/sim/players/locomotion';
import { makeScenario, runTicks } from '../harness/scenario';

/** Everybody parked far away; no CPU brains; no controllers unless given. */
function quiet(seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: 0 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0;
    p.ctrl = -1;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  for (const c of s.ctrl) { c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
  s.tick = 200;
  return s;
}

/** CPU controller of `side` (controller 2 + side) on `slot`, its brain off so the test writes its frame. */
function cpuOn(s: SimState, side: number, slot: number): number {
  const c = 2 + side;
  const ctl = s.ctrl[c]!;
  ctl.kind = ControllerKind.CPU; ctl.side = side; ctl.slot = slot; ctl.switchLockT = 0; ctl.autoSwitch = AutoSwitch.AUTO;
  s.players[slot]!.ctrl = c;
  return c;
}

/** LT.meetMaxHeight (T_TOUCH.trapHeight): a lofted ball above this is over his head. */
const HEAD = T_TOUCH.trapHeight;

/** Ball height of a free flight (no drag) after t s. */
const yAt = (y: number, vy: number, t: number): number => y + vy * t - 0.5 * T_BALL.gravity * t * t;

describe('QF-9 SIM-15 meetPoint: a lofted ball is met where it comes down', () => {
  it('the meeting point of a lob flying over him lies where the ball is back below meetMaxHeight', () => {
    const s = quiet();
    const p = s.players[9]!;
    p.x = 8; p.z = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = 0; b.y = 1; b.z = 0; b.vx = 12; b.vy = 8; b.vz = 0; b.grounded = 0;
    meetPoint(s, 9, 0);
    // Where along the track the ball is and how high it is there.
    const t = (MEET.x - b.x) / b.vx;
    expect(LT.meetMaxHeight).toBe(HEAD);
    expect(yAt(b.y, b.vy, t)).toBeLessThanOrEqual(HEAD + 1e-9);
    expect(MEET.x).toBeGreaterThan(15); // not 6 m out under the rising ball (the old ground-track answer)
    // CPU-controlled: the same (he cannot count on a header being started for him).
    const humanX = MEET.x;
    cpuOn(s, 0, 9);
    meetPoint(s, 9, 0);
    expect(MEET.x).toBe(humanX);
    s.players[9]!.ctrl = -1;
    // A ground ball is unaffected: the first reachable point of its rolling track.
    b.y = 0.11; b.vy = 0; b.grounded = 1; b.vx = 8;
    meetPoint(s, 9, 0);
    expect(MEET.x).toBeLessThan(8);
  });

  it('every sample it may pick is reachable in time or the last one, never one still above head height', () => {
    // Table: launch speeds and angles of lobs and keeper throws, receivers ahead, under and behind the landing spot.
    for (const [vx, vy] of [[10, 9], [14, 7], [18, 6], [8, 12]] as const) {
      for (const px of [4, 10, 16, 22]) {
        const s = quiet();
        const p = s.players[9]!;
        p.x = px; p.z = 1;
        const b = s.ball;
        b.owner = -1; b.heldBy = -1; b.x = 0; b.y = 1.2; b.z = 0; b.vx = vx; b.vy = vy; b.vz = 0; b.grounded = 0;
        meetPoint(s, 9, 0);
        const t = (MEET.x - b.x) / vx;
        const last = Math.abs(t - LT.receiveLookAheadSec) < 1e-9;
        if (!last) expect(yAt(b.y, vy, t), `vx ${vx} vy ${vy} px ${px}`).toBeLessThanOrEqual(HEAD + 1e-9);
      }
    }
  });

  it('an idle-stick human receiver of a lob runs to where it lands and takes it (pipeline)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 5, humans: [{ side: 0, slot: 9, autoSwitch: AutoSwitch.AIR_AND_LOOSE }] });
    for (let i = 0; i < 22; i++) {
      if (i === 9) continue;
      const p = s.players[i]!;
      p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
    }
    s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
    const p = s.players[9]!;
    p.x = 6; p.z = 2; p.vx = 0; p.vz = 0;
    const b = s.ball;
    // A lob from slot 6 at (-10, 0) dropping around x = 13..15.
    b.owner = -1; b.heldBy = -1; b.x = -10; b.y = 0.5; b.z = 0; b.px = b.x; b.py = b.y; b.pz = b.z;
    b.vx = 13; b.vy = 9; b.vz = 0.15; b.grounded = 0; b.sx = 0; b.sy = 0; b.sz = 0;
    b.lastKickBy = 6; b.lastKickTeam = 0; b.lastKickKind = KickKind.LOB_PASS; b.lastKickTick = s.tick;
    b.lastTouch = 6; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.passTarget = 9; b.shotBy = -1;
    let under = 0;
    runTicks(s, 200, undefined, {
      until: (st) => {
        const q = st.players[9]!;
        // While the ball is still high and rising / far, he never stops under its early track (x < 9).
        if (st.ball.owner < 0 && st.ball.y > 3 && q.moveMode === MoveMode.ARRIVE && q.tgtX < 9) under++;
        return st.ball.owner >= 0 || st.ball.lastTouch !== 6;
      },
    });
    expect(under).toBe(0);
    expect(s.ball.lastTouch).toBe(9);
  });
});

describe('QF-9 SIM-15 meetPoint: a steady target for a ball peaking near head height', () => {
  it('a dink peaking above the limit (1.9-2.8 m): the idle receiver\'s meeting target never jumps back and forth', () => {
    // The 0.125 s sampling grid against a ball peaking right at the height limit flipped his target 2 m back and forth
    // every few ticks (and he stood still while an opponent headed it: qf-3 THROUGH double-tap). The exact crossing
    // points are on the track, so the target only drifts.
    for (const vy of [5.9, 6.5, 7.2]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 6, humans: [{ side: 0, slot: 10, autoSwitch: AutoSwitch.AIR_AND_LOOSE }] });
      for (let i = 0; i < 22; i++) {
        if (i === 10) continue;
        const p = s.players[i]!;
        p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
      }
      s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
      const r = s.players[10]!;
      r.x = 22; r.z = -2.5; r.vx = 0; r.vz = 0;
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 8; b.y = 0.3; b.z = 0; b.px = b.x; b.py = b.y; b.pz = b.z;
      b.vx = 17; b.vy = vy; b.vz = -0.3; b.grounded = 0; b.sx = 0; b.sy = 0; b.sz = 0;
      b.lastKickBy = 9; b.lastKickTeam = 0; b.lastKickKind = KickKind.THROUGH_DINKED; b.lastKickTick = s.tick;
      b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.passTarget = 10; b.shotBy = -1;
      let prev = NaN, prevStep = 0, flips = 0;
      runTicks(s, 60, undefined, {
        until: (st) => {
          const q = st.players[10]!;
          // While the ball is on its way to him (once it is past him, the target moves on with it: a new chase).
          if (st.ball.x > q.x - 0.5) return true;
          if (q.moveMode === MoveMode.ARRIVE) {
            if (prev === prev) {
              const step = q.tgtX - prev;
              if (Math.abs(step) > 0.5) { if (prevStep !== 0 && Math.sign(step) !== Math.sign(prevStep)) flips++; prevStep = step; }
            }
            prev = q.tgtX;
          }
          return st.ball.owner >= 0 || st.ball.lastTouch !== 9;
        },
      });
      expect(flips, `vy ${vy}`).toBe(0);
    }
  });
});

describe('QF-9 SIM-16: never switches away from the player about to receive', () => {
  it('glitch: Switching switches away from the player about to receive — a loose ball rolling into the CPU-controlled man keeps him', () => {
    // A loose ground ball (last touched by an opponent) 1.1 m from defender 7, passing 0.9 m from him; teammate 5 is
    // nearer the ball's later track. The touch is SIM-07's next tick: no switch to 5 and back.
    const s = quiet();
    const c = cpuOn(s, 0, 7);
    const p7 = s.players[7]!, p5 = s.players[5]!;
    // The geometry of soak seed 1 match 3 t 22665 (qf-2-cr-switch-receiver), relative to the ball.
    p7.x = 0; p7.z = 0; p7.vx = -2.3; p7.vz = 2.84; p7.fx = -0.63; p7.fz = 0.78;
    p5.x = 5.13; p5.z = 5.97; p5.vx = 2.93; p5.vz = -2.77; p5.fx = 0.73; p5.fz = -0.69; // by the arrival model alone, quicker
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = -0.94; b.y = 0.11; b.z = 0.63; b.vx = 8.32; b.vz = -1.29; b.vy = 0; b.grounded = 1;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    // A deflection (not an untouched pass, which would be SIM-14's interception roll): SIM-07 gives him the touch.
    b.lastTouch = 16; b.lastTouchTeam = 1; b.lastTouchTick = s.tick - 5; b.lastKickBy = 16; b.lastKickTeam = 1;
    b.lastKickTick = s.tick - 5; b.lastKickKind = KickKind.DEFLECTION; b.passTarget = -1; b.shotBy = -1;
    s.teams[0]!.chaser = 7;
    const eff: number[] = [];
    debugSwitchEff(s, 0, eff);
    expect(eff[5]! + Math.max(SWITCH_TUNING.autoMarginTicks, SWITCH_TUNING.autoMarginFrac * eff[7]!)).toBeLessThan(eff[7]!);
    const away: number[] = [];
    runTicks(s, 3, undefined, {
      until: (st, evs) => {
        for (const e of evs) if (e.type === EventType.SWITCH && e.c === c && e.a === 7) away.push(e.b);
        return false;
      },
    });
    expect(away).toEqual([]);
    expect(s.ball.lastTouch).toBe(7);
  });

  it('glitch: Switching switches away from the player about to receive — never away from a header, clearance or tackle he is committed to', () => {
    // Defender 7 in each committed action, a loose high ball nearer teammate 5's run: the CPU controller stays on 7.
    const acts = [ActionKind.HEADER, ActionKind.KICK, ActionKind.STAND_TACKLE, ActionKind.SLIDE_TACKLE];
    for (const act of acts) {
      const s = quiet();
      const c = cpuOn(s, 0, 7);
      const p7 = s.players[7]!, p5 = s.players[5]!;
      p7.x = 0; p7.z = 0;
      p5.x = 14; p5.z = 0;
      beginAction(p7, act, 40, 30);
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 3; b.y = 0.11; b.z = 0; b.vx = 9; b.vz = 0; b.vy = 0; b.grounded = 1;
      b.px = b.x; b.py = b.y; b.pz = b.z;
      b.lastTouch = 16; b.lastTouchTeam = 1; b.lastTouchTick = s.tick - 2; b.lastKickBy = 16; b.lastKickTeam = 1;
      b.lastKickTick = s.tick - 2; b.lastKickKind = KickKind.CLEARANCE; b.passTarget = -1; b.shotBy = -1;
      // One tick: the switch decision of the tick the action is running (a synthetic header with no ball to meet is
      // ended by its own handler afterwards, and then switching away is right).
      const ev = runTicks(s, 1);
      expect(ev.filter((e) => e.type === EventType.SWITCH && e.c === c), ActionKind[act]).toEqual([]);
      // Control: the same ball with 7 idle switches to 5 (he is beaten to it by far).
      const s2 = quiet();
      const c2 = cpuOn(s2, 0, 7);
      s2.players[7]!.x = 0; s2.players[5]!.x = 14; s2.players[5]!.z = 0;
      Object.assign(s2.ball, { owner: -1, heldBy: -1, x: 3, y: 0.11, z: 0, vx: 9, vz: 0, vy: 0, grounded: 1, px: 3, py: 0.11, pz: 0,
        lastTouch: 16, lastTouchTeam: 1, lastTouchTick: s2.tick - 2, lastKickBy: 16, lastKickTeam: 1, lastKickTick: s2.tick - 2,
        lastKickKind: KickKind.CLEARANCE, passTarget: -1, shotBy: -1 });
      const ev2 = runTicks(s2, 1);
      expect(ev2.some((e) => e.type === EventType.SWITCH && e.c === c2 && e.b === 5), `control ${ActionKind[act]}`).toBe(true);
    }
  });

  it('a loose ball an opponent reaches clearly first does not move control off the goal-side man', () => {
    // Opponent 17 stands on the ball's path 4 m away (he will have it); our 5 is the nearest of us to the ball's later
    // track, 7 is goal-side. The loose-ball rule waits: it used to switch to 5, then back to 7 once 17 controlled it.
    const s = quiet();
    const c = cpuOn(s, 0, 7);
    const p7 = s.players[7]!, p5 = s.players[5]!, q = s.players[17]!;
    p7.x = -12; p7.z = 0;
    p5.x = 3; p5.z = 5;
    q.x = 4; q.z = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = 12; b.y = 0.11; b.z = 0; b.vx = -8; b.vz = 0; b.vy = 0; b.grounded = 1;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.lastTouch = 20; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 20; b.lastKickTeam = 1;
    b.lastKickTick = s.tick; b.lastKickKind = KickKind.GROUND_PASS; b.passTarget = 17; b.shotBy = -1;
    const ev = runTicks(s, 30, undefined, { until: (st) => st.ball.owner >= 0 });
    expect(ev.filter((e) => e.type === EventType.SWITCH && e.c === c && e.a === 7 && e.b === 5)).toEqual([]);
    expect(SWITCH_TUNING.contestTicks).toBeLessThan(T_TOUCH.firstTouchTicks);
  });
});

describe('QF-9 SIM-16: a face press belongs to the player it was made for', () => {
  /** CPU controller on defender 15 in his own third; a loose aerial ball arriving at him; teammate 14 nearer its end. */
  function pressScene(): { s: SimState; c: number } {
    const s = quiet(9);
    const c = cpuOn(s, 1, 15);
    const p15 = s.players[15]!, p14 = s.players[14]!;
    p15.x = 40; p15.z = 0; p15.fx = -1;
    p14.x = 20; p14.z = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = 36; b.y = 2.5; b.z = 0; b.vx = -9; b.vy = 1; b.vz = 0; b.grounded = 0;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.lastTouch = 4; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 4; b.lastKickTeam = 0;
    b.lastKickTick = s.tick; b.lastKickKind = KickKind.THROW_IN; b.passTarget = -1; b.shotBy = -1;
    return { s, c };
  }

  it('no auto-switch on a frame with a fresh face press (the press is resolved for the controlled man)', () => {
    // A human in AUTO on 15 (side 1), the loose ball far nearer 14: without a press the switch comes on the first tick;
    // with SHOOT pressed on that tick it waits (the press is 15's), and the buffered press dies with the later switch.
    const build = (): SimState => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4, humans: [{ side: 1, slot: 15, autoSwitch: AutoSwitch.AUTO }] });
      for (let i = 0; i < 22; i++) {
        const p = s.players[i]!;
        p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
      }
      s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
      s.ctrl[0]!.switchLockT = 0;
      s.players[15]!.x = 50; s.players[15]!.z = 25;
      s.players[14]!.x = 14; s.players[14]!.z = 0;
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 18; b.y = 0.11; b.z = 0; b.vx = -4; b.vy = 0; b.vz = 0; b.grounded = 1;
      b.px = b.x; b.py = b.y; b.pz = b.z;
      b.lastTouch = 4; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 4; b.lastKickTeam = 0;
      b.lastKickTick = s.tick; b.lastKickKind = KickKind.GROUND_PASS; b.passTarget = -1; b.shotBy = -1;
      return s;
    };
    const first = (s: SimState, press: number): number => {
      const t1 = s.tick + 1;
      let sw = -1;
      runTicks(s, 3, (t, _st, out) => { if (t === t1) out[0]!.buttons = press; }, {
        until: (st, evs) => {
          for (const e of evs) if (e.type === EventType.SWITCH && e.c === 0 && sw < 0) sw = st.tick - t1;
          return false;
        },
      });
      return sw;
    };
    expect(first(build(), 0)).toBe(0); // control: switches on the first tick
    const s = build();
    expect(first(s, Btn.SHOOT)).toBeGreaterThan(0); // the press frame keeps 15
    expect(s.ctrl[0]!.bufAction % 16).toBe(0); // and the press did not survive the switch
    expect(s.players[14]!.act).toBe(ActionKind.NONE);
  });

  it('a press buffered for the man control leaves is dropped by an automatic switch (no header shot by the new man)', () => {
    // The real case: fixtures/qf-2-switch-press.state.json (qf-2-cr-switch-press). Here the mechanism directly: a
    // buffered SHOOT for 15, then an auto-switch to 14 -> the buffer is empty and 14 starts no action.
    const { s, c } = pressScene();
    const ctl = s.ctrl[c]!;
    ctl.bufAction = 2; ctl.bufArg = 0; ctl.bufExpire = s.tick + 6; // BufCode.SHOOT
    // 15 cannot get there before 14 by far: move him away so the loose-ball rule switches.
    s.players[15]!.x = 50; s.players[15]!.z = 25;
    s.ball.x = 18; s.ball.y = 0.11; s.ball.vy = 0; s.ball.grounded = 1; s.ball.vx = -4; s.ball.px = 18; s.ball.py = 0.11;
    s.ball.lastTouch = 16; s.ball.lastTouchTeam = 1; s.ball.lastKickBy = 16; s.ball.lastKickTeam = 1;
    let switched = false;
    runTicks(s, 4, undefined, {
      until: (st, evs) => {
        for (const e of evs) if (e.type === EventType.SWITCH && e.c === c && e.a === 15 && e.b === 14) switched = true;
        return switched;
      },
    });
    expect(switched).toBe(true);
    expect(ctl.bufAction).toBe(0);
    expect(s.players[14]!.act === ActionKind.SHOT || s.players[14]!.act === ActionKind.HEADER).toBe(false);
  });
});

describe('QF-9 constants moved into contracts/tuning.ts', () => {
  it('locomotion and the meet run read T_PLAYER.staminaRefHalfMinutes and T_TOUCH.meet* directly', () => {
    expect((LOCO as Record<string, unknown>).staminaRefHalfMinutes).toBeUndefined();
    for (const k of ['meetOvershootMinSpeed', 'meetOvershootSec', 'meetOvershootMin', 'meetOvershootMax', 'meetCatchDist']) {
      expect((LT as Record<string, unknown>)[k], k).toBeUndefined();
      expect((T_TOUCH as Record<string, unknown>)[k], k).toBeTypeOf('number');
    }
    expect(T_PLAYER.staminaRefHalfMinutes).toBe(4);
  });
});
