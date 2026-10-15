/**
 * [QF-9 skeptic] Regressions for defects found while re-attacking the first QF-9 pass:
 *  - SIM-16 loose-ball "contest" wait (an opponent reaches the ball clearly first) stranded control: in AIR_AND_LOOSE
 *    (the human default, no carrier rule) it never switched for an opponent's lofted pass at all, and in AUTO it kept a
 *    man 30 m from the play. It now waits only in AUTO and only while the current man is in the play.
 *  - SIM-14 fresh-shot body blocks covered only free defenders: a shot struck while a tackle came in (or past a man
 *    stumbling, getting up, stunned, or one who may not touch the ball yet) passed straight through his body.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { beginAction } from '../../src/sim/actions/dispatch';
import { debugSwitchContest, debugSwitchEff, SWITCH_TUNING } from '../../src/sim/control/switching';
import { makeScenario, runTicks } from '../harness/scenario';

/**
 * Human P1 (side 0) on full-back 2 at (-38, -22); opponent 20 lofts a 30 m pass from (10, 0) to 18, who waits nearer
 * the drop than our midfielder 4 (-25, 6). Nobody's brain runs, so control stays wherever switching leaves it.
 */
function loftedOppPass(mode: AutoSwitch): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4, humans: [{ side: 0, slot: 2, autoSwitch: mode }] });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  for (const c of s.ctrl) if (c.kind === ControllerKind.CPU) { c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
  s.ctrl[0]!.switchLockT = 0;
  s.players[2]!.x = -38; s.players[2]!.z = -22;
  s.players[4]!.x = -25; s.players[4]!.z = 6;
  s.players[18]!.x = -21; s.players[18]!.z = 9;
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = 10; b.y = 0.3; b.z = 0; b.vx = -17; b.vy = 9; b.vz = 5.2; b.grounded = 0;
  b.px = b.x; b.py = b.y; b.pz = b.z; b.sx = 0; b.sy = 0; b.sz = 0;
  b.lastTouch = 20; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 20; b.lastKickTeam = 1;
  b.lastKickTick = s.tick; b.lastKickKind = KickKind.LOB_PASS; b.passTarget = 18; b.shotBy = -1;
  return s;
}

function switchesOf(s: SimState, c: number, ticks: number): string[] {
  const out: string[] = [];
  runTicks(s, ticks, undefined, {
    until: (st, evs) => {
      for (const e of evs) if (e.type === EventType.SWITCH && e.c === c) out.push(`${e.a}->${e.b}`);
      return false;
    },
  });
  return out;
}

describe('QF-9 skeptic SIM-16: the loose-ball contest wait never strands control far from the play', () => {
  it('AIR_AND_LOOSE (the human default): an opponent\'s lofted pass coming down by our midfielder switches to him though their receiver gets there first', () => {
    const s = loftedOppPass(AutoSwitch.AIR_AND_LOOSE);
    // Preconditions: the opponent's receiver is first to it by more than contestTicks; 4 is far quicker than 2.
    const o: number[] = [];
    debugSwitchContest(s, 0, 2, o);
    const eff: number[] = [];
    debugSwitchEff(s, 0, eff);
    expect(o[0]! + SWITCH_TUNING.contestTicks).toBeLessThan(eff[4]!);
    expect(eff[4]!).toBeLessThan(eff[2]!);
    expect(switchesOf(s, 0, 200)).toEqual(['2->4']);
    expect(s.ctrl[0]!.slot).toBe(4);
  });

  it('AUTO: the same pass switches too when the current man is out of the play (beyond contestInPlayTicks of the drop)', () => {
    const s = loftedOppPass(AutoSwitch.AUTO);
    const o: number[] = [];
    debugSwitchContest(s, 0, 2, o);
    expect(o[1]!).toBeGreaterThan(SWITCH_TUNING.contestInPlayTicks);
    expect(switchesOf(s, 0, 200)).toEqual(['2->4']);
  });

  it('AUTO: a goal-side man in the play keeps control while the ball reaches the opponent\'s receiver, for the whole approach', () => {
    // QF-9's case (opponent 17 on the path of a ground pass, our 5 nearer it, 7 goal-side 16 m back), held for 2 s:
    // the in-play test counts from now, so it does not flip to "switch" as the ball closes in on 17 while 7 stands.
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, humans: 0 });
    for (let i = 0; i < 22; i++) {
      const p = s.players[i]!;
      p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0;
      p.ctrl = -1;
    }
    s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
    for (const c of s.ctrl) { c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
    s.tick = 200;
    const ctl = s.ctrl[2]!;
    ctl.kind = ControllerKind.CPU; ctl.side = 0; ctl.slot = 7; ctl.switchLockT = 0; ctl.autoSwitch = AutoSwitch.AUTO;
    s.players[7]!.ctrl = 2;
    s.players[7]!.x = -12; s.players[7]!.z = 0;
    s.players[5]!.x = 3; s.players[5]!.z = 5;
    s.players[17]!.x = 4; s.players[17]!.z = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = 12; b.y = 0.11; b.z = 0; b.vx = -8; b.vz = 0; b.vy = 0; b.grounded = 1;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.lastTouch = 20; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 20; b.lastKickTeam = 1;
    b.lastKickTick = s.tick; b.lastKickKind = KickKind.GROUND_PASS; b.passTarget = 17; b.shotBy = -1;
    const o: number[] = [];
    debugSwitchContest(s, 0, 7, o);
    expect(o[1]!).toBeLessThanOrEqual(SWITCH_TUNING.contestInPlayTicks);
    expect(switchesOf(s, 2, 120)).toEqual([]);
  });
});

/** A 25 m/s low shot along z = 0 from (30.6, 0) at defender 15 standing on its line at (37, 0.1) in state `act`. */
function shotAt(act: ActionKind, actT: number, opts: { stun?: number; noTouch?: number; speed?: number } = {}): { touched: number; owner: number; kind: KickKind } {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, humans: 0 });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = i < 11 ? -40 + i : -5 + (i - 11); p.z = -30 + i * 2.5; p.vx = 0; p.vz = 0;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  for (const c of s.ctrl) { c.kind = ControllerKind.NONE; c.slot = -1; }
  for (const p of s.players) p.ctrl = -1;
  s.players[11]!.x = 52; s.players[11]!.z = 0;
  s.players[9]!.x = 30; s.players[9]!.z = 0;
  const sp = opts.speed ?? 25;
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = 30.6; b.z = 0; b.y = 0.3; b.px = b.x; b.pz = 0; b.py = 0.3;
  b.vx = sp; b.vz = 0; b.vy = 0; b.grounded = 0;
  b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 9; b.lastKickTeam = 0;
  b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick; b.shotBy = 9; b.passTarget = -1;
  const q = s.players[15]!;
  q.x = 37; q.z = 0.1; q.vx = 0; q.vz = 0; q.fx = -1; q.fz = 0;
  if (act !== ActionKind.NONE) { beginAction(q, act, 90, 10); q.actT = actT; q.actDone = 1; }
  q.stunT = opts.stun ?? 0;
  q.noTouchT = opts.noTouch ?? 0;
  let touched = -1, owner = -1, kind = KickKind.NONE;
  runTicks(s, 90, (_t, st) => { const d = st.players[15]!; d.x = 37; d.z = 0.1; d.vx = 0; d.vz = 0; }, {
    until: (st) => {
      if (st.ball.lastTouch !== 9 && touched < 0) { touched = st.ball.lastTouch; owner = st.ball.owner; kind = st.ball.lastKickKind; }
      return touched >= 0 || st.ball.x > 42;
    },
  });
  return { touched, owner, kind };
}

describe('QF-9 skeptic SIM-14: a fresh shot is stopped by a busy defender\'s body too', () => {
  it('table: a slide tackle gliding, a standing tackle recovering, stumbling, getting up, stunned, barred from touching: the shot comes off him', () => {
    const rows: [string, ActionKind, number, { stun?: number; noTouch?: number }][] = [
      ['slide tackle glide', ActionKind.SLIDE_TACKLE, 30, {}],
      ['stand tackle recovery', ActionKind.STAND_TACKLE, 20, {}],
      ['stumble', ActionKind.STUMBLE, 5, {}],
      ['get up', ActionKind.GET_UP, 5, {}],
      ['stunned', ActionKind.NONE, 0, { stun: 40 }],
      ['noTouchT', ActionKind.NONE, 0, { noTouch: 40 }],
    ];
    for (const [name, act, t, o] of rows) {
      const r = shotAt(act, t, o);
      expect(r.touched, name).toBe(15);
      expect(r.kind, name).toBe(KickKind.DEFLECTION);
      expect(r.owner, name).toBe(-1); // off his body, never trapped by a busy man
    }
  });

  it('a gentle shot at a man in a tackle recovery is deflected, not trapped (a free man traps it)', () => {
    const busy = shotAt(ActionKind.STAND_TACKLE, 20, { speed: 12 });
    expect(busy.touched).toBe(15);
    expect(busy.owner).toBe(-1);
    const free = shotAt(ActionKind.NONE, 0, { speed: 12 });
    expect(free.touched).toBe(15);
    expect(free.owner).toBe(15);
  });

  it('a man lying FALLEN is no upright body: the shot is not blocked by his circle', () => {
    expect(shotAt(ActionKind.FALLEN, 5).touched).toBe(-1);
  });
});

/** P1 controls 10 at (px, pz), idle stick; our 9's ground pass from (0, 0) along +x at `speed` (10 the target). */
function firmPass(speed: number, px: number, pz: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 6, humans: [{ side: 0, slot: 10, autoSwitch: AutoSwitch.AIR_AND_LOOSE }] });
  for (let i = 0; i < 22; i++) {
    if (i === 10) continue;
    const p = s.players[i]!;
    p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
  }
  s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
  const r = s.players[10]!;
  r.x = px; r.z = pz; r.vx = 0; r.vz = 0; r.fx = -1; r.fz = 0;
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = 0; b.y = 0.11; b.z = 0; b.px = 0; b.py = 0.11; b.pz = 0;
  b.vx = speed; b.vy = 0; b.vz = 0; b.grounded = 1; b.sx = 0; b.sy = 0; b.sz = 0;
  b.lastKickBy = 9; b.lastKickTeam = 0; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = s.tick;
  b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.passTarget = 10; b.shotBy = -1;
  return s;
}

describe('QF-9 skeptic SIM-15: the idle receiver\'s meeting target holds still while a firm pass comes', () => {
  it('glitch: Players orbit or jitter around a target — an idle receiver of a 15-21 m/s pass never steps to and fro', () => {
    // The meeting point was sampled every meetStepSec from now: the target crept on with the ball (0.2-0.25 m a tick)
    // and was thrown back by v x meetStepSec every 7-8 ticks; a receiver beside the line reversed 3-11 times per pass.
    let backJumps = 0;
    for (const speed of [15, 18, 21]) {
      for (const [px, pz] of [[12, 2.5], [18, 5], [24, 5], [30, 8], [21, 0.5]] as const) {
        const s = firmPass(speed, px, pz);
        let rev = 0, prevVx = 0, prevT = NaN;
        runTicks(s, 180, undefined, {
          until: (st) => {
            const q = st.players[10]!;
            if (st.ball.x > q.x + 1) return true; // past him: a new chase
            if (Math.abs(q.vx) > 0.3 && Math.abs(prevVx) > 0.3 && Math.sign(q.vx) !== Math.sign(prevVx)) rev++;
            if (Math.abs(q.vx) > 0.3) prevVx = q.vx;
            if (prevT === prevT && q.tgtX - prevT < -0.5) backJumps++;
            prevT = q.tgtX;
            return st.ball.lastTouch !== 9 || st.ball.owner >= 0;
          },
        });
        expect(rev, `${speed} m/s at (${px}, ${pz})`).toBeLessThanOrEqual(1);
      }
    }
    expect(backJumps).toBe(0); // the sawtooth: the target thrown back toward the ball every 7-8 ticks
  });
});

describe('QF-9 skeptic SIM-15: a first-time press for a receiver running onto the pass strikes it', () => {
  /** P1's 9 at (10, 0) running at the ball (stick +x) as our pass rolls at him from 16 m; PASS / SHOOT pressed early. */
  function runOnto(bv: number, sprint: boolean, btn: number): { firstTouch: number; struck: number; kind: KickKind } {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 7, humans: [{ side: 0, slot: 9, autoSwitch: AutoSwitch.OFF }] });
    for (let i = 0; i < 22; i++) {
      if (i === 9) continue;
      const p = s.players[i]!;
      p.x = i < 11 ? -44 : 44; p.z = -30 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
    }
    s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
    const p = s.players[9]!;
    p.x = 10; p.z = 0; p.vx = 3; p.vz = 0; p.fx = 1; p.fz = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = 26; b.z = 0.3; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y;
    b.vx = -bv; b.vz = 0; b.vy = 0; b.grounded = 1; b.sx = 0; b.sy = 0; b.sz = 0;
    b.passTarget = 9; b.lastTouchTeam = 0; b.lastTouch = 7; b.lastKickTeam = 0; b.lastKickBy = 7;
    b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = s.tick; b.lastTouchTick = s.tick; b.shotBy = -1;
    let firstTouch = -1, struck = -1, kind = KickKind.NONE;
    const t0 = s.tick;
    runTicks(s, 90, (t, _st, out) => {
      out[0]!.mx = 127; out[0]!.mz = 0;
      out[0]!.buttons = (t === t0 + 3 ? btn : 0) | (sprint ? Btn.SPRINT : 0);
    }, {
      until: (st) => {
        const q = st.players[9]!;
        if (q.act === ActionKind.FIRST_TOUCH && firstTouch < 0) firstTouch = st.tick;
        if (struck < 0 && st.ball.lastTouch === 9) { struck = st.tick; kind = st.ball.lastKickKind; }
        return struck >= 0;
      },
    });
    return { firstTouch, struck, kind };
  }

  it('table: 11-17 m/s passes, jogging and sprinting onto them, PASS and SHOOT: struck first time, never whiffed or trapped', () => {
    // The timing (ballEta) counted to his centre and ignored his run: the press fired so late that the ball ran past the
    // kick (7 of 12 cases) or SIM-07 trapped it first. Now ballReachEta: to his reach, with his run.
    for (const bv of [11, 14, 17]) {
      for (const sprint of [false, true]) {
        for (const [btn, want] of [[Btn.PASS, KickKind.GROUND_PASS], [Btn.SHOOT, KickKind.SHOT_NORMAL]] as const) {
          const name = `${bv} m/s sprint ${sprint} ${btn === Btn.PASS ? 'PASS' : 'SHOOT'}`;
          const r = runOnto(bv, sprint, btn);
          expect(r.struck, name).toBeGreaterThan(0);
          expect(r.kind, name).toBe(want);
          expect(r.firstTouch, name).toBe(-1);
        }
      }
    }
  });
});

describe('QF-9 skeptic SIM-15: a first-time clearance with the stick released meets the ball', () => {
  /** P1 (side 1) on defender 16 at (30, off) running (pvx, pvz) in his own third; an opponent's pass along z = 0. */
  function clearance(pvx: number, pvz: number, off: number, bv: number, bx: number): { started: number; struck: number; kind: KickKind } {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 5, humans: [{ side: 1, slot: 16, autoSwitch: AutoSwitch.OFF }] });
    for (let i = 0; i < 22; i++) {
      if (i === 16) continue;
      const p = s.players[i]!;
      p.x = i < 11 ? -45 : 45; p.z = -28 + (i % 11) * 5.5; p.vx = 0; p.vz = 0;
    }
    s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
    for (const c of s.ctrl) if (c.kind === ControllerKind.CPU) { if (c.slot >= 0) s.players[c.slot]!.ctrl = -1; c.kind = ControllerKind.NONE; c.slot = -1; c.side = -1; }
    const d = s.players[16]!;
    d.x = 30; d.z = off; d.vx = pvx; d.vz = pvz;
    const sp = Math.hypot(pvx, pvz);
    d.fx = pvx / sp; d.fz = pvz / sp;
    s.players[9]!.x = 44; s.players[9]!.z = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = bx; b.y = 0.11; b.z = 0; b.px = b.x; b.py = b.y; b.pz = 0;
    b.vx = bv; b.vz = 0; b.vy = 0; b.grounded = 1; b.sx = 0; b.sy = 0; b.sz = 0;
    b.lastTouch = 5; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 5; b.lastKickTeam = 0;
    b.lastKickKind = KickKind.DRIVEN_PASS; b.lastKickTick = s.tick; b.passTarget = 9; b.shotBy = -1;
    let started = -1, struck = -1, kind = KickKind.NONE;
    const t0 = s.tick;
    runTicks(s, 60, (t, _st, out) => { out[0]!.buttons = t === t0 + 1 ? Btn.SHOOT : 0; }, {
      until: (st) => {
        if (st.players[16]!.act === ActionKind.KICK && started < 0) started = st.tick - t0;
        if (st.ball.lastTouch === 16 && struck < 0) { struck = st.tick - t0; kind = st.ball.lastKickKind; }
        return struck >= 0 || st.ball.x > 40;
      },
    });
    return { started, struck, kind };
  }

  it('table: a defender running diagonally onto a 9-20 m/s pass presses SHOOT in his own third: the clearance strikes it', () => {
    // During the wind-up he coasted on his last run (DIRECT, no intent) off the ball's line, facing that run, and the
    // ball passed ~1 m from his kicking spot (a first-time clearance whiffed; a quarter of all first-time kicks in CPU
    // matches whiffed). Now he meets the ball's path facing it, like the idle receiver of our pass.
    for (const [pvx, pvz, off, bv, bx] of [[-7, 2.5, 0.2, 20, 22], [-7, 2.5, 0.2, 14, 24], [-7, 2.5, 0.5, 9, 26], [-4, 0, 0.5, 20, 22]] as const) {
      const name = `run ${pvx},${pvz} offset ${off} ball ${bv} m/s`;
      const r = clearance(pvx, pvz, off, bv, bx);
      expect(r.started, name).toBeGreaterThan(0);
      expect(r.struck, name).toBeGreaterThan(0);
      expect(r.kind, name).toBe(KickKind.CLEARANCE);
    }
  });
});
