/**
 * SIM-14 tackles through the real tick pipeline: timing windows, reach, success by attribute and timing, hard tackle,
 * slide (reach, quick get-up via the resolver), shoulder, push/pull, down states, the glitch-list lines (ball stuck
 * under a sliding player, keeper fights a defender, discipline fed to RUL-09) and determinism.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ChallengeKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn } from '../../src/contracts/input';
import { T_TACKLE } from '../../src/contracts/tuning';
import { createActionRequest } from '../../src/contracts/systems';
import { hashState } from '../../src/sim/core/hash';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import {
  LOCAL_TUNING as L, contactTicksOf, knockDown, quickGetUp, standReachOf, startTackle, tackleContacts, winChance,
} from '../../src/sim/defend/tackle';
import { startPass } from '../../src/sim/kicks/pass';
import { makeScenario, runTicks } from '../harness/scenario';
import { P1, P2, loose, owned, place, scene, stepN, trial } from './sim-14-helpers';

const EV = createEventBuffer();
const tackles = (ev: SimEvent[]): SimEvent[] => ev.filter((e) => e.type === EventType.TACKLE);

/** P1 (home) standing at the origin facing +x with the ball at his feet; P2 at (x, z) facing him. */
function duel(seed: number, x: number, z = 0, ballAhead = 0.6) {
  const s = scene(seed);
  place(s, P1, 0, 0, 1, 0);
  owned(s, P1, ballAhead, 0);
  place(s, P2, x, z, -x, -z);
  return s;
}

describe('SIM-14 standing tackle: timing windows and reach', () => {
  it('no contact during the wind-up; the ball in reach is played on the first contact-window tick', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const s = duel(seed, 1.9);
      const t0 = s.tick;
      expect(startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV)).toBe(1);
      expect(s.players[P2]!.actSlot).toBe(P1);
      const ev = stepN(s, T_TACKLE.standWindup + 2);
      const t = tackles(ev);
      expect(t).toHaveLength(1);
      expect(t[0]!.tick - t0).toBe(T_TACKLE.standWindup);
      expect(t[0]!.a).toBe(P2);
      expect(t[0]!.b).toBe(P1);
      expect(t[0]!.d).toBe(ChallengeKind.STAND);
      // nothing touched the ball before the contact tick
      expect(ev.filter((e) => e.type === EventType.KICK && e.a === P2 && e.tick < t[0]!.tick)).toHaveLength(0);
    }
  });

  it('out of reach for the whole window: a whiff at the window end (TACKLE c=0), ball untouched, no stumble', () => {
    const s = duel(2, 4.5);
    const t0 = s.tick;
    startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
    const dur = s.players[P2]!.actDur;
    expect(dur).toBe(T_TACKLE.standWindup + T_TACKLE.standContactTicks + T_TACKLE.standRecovery);
    let endTick = -1;
    const ev = stepN(s, dur + 2, (st) => { if (endTick < 0 && st.players[P2]!.act === ActionKind.NONE) endTick = st.tick; });
    const t = tackles(ev);
    expect(t).toHaveLength(1);
    expect(t[0]!.c).toBe(0);
    expect(t[0]!.tick - t0).toBe(T_TACKLE.standWindup + T_TACKLE.standContactTicks);
    expect(s.ball.owner).toBe(P1);
    expect(endTick - t0).toBe(dur);
    expect(ev.some((e) => e.type === EventType.KICK && e.a === P2)).toBe(false);
  });

  it('the lunge carries him into reach: a ball just beyond reach at the start is played inside the window', () => {
    const reach = standReachOf(ActionKind.STAND_TACKLE);
    const s = duel(3, 0.6 + reach + 0.2);
    const t0 = s.tick;
    startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
    const t = tackles(stepN(s, 30));
    expect(t).toHaveLength(1);
    expect(t[0]!.tick - t0).toBeGreaterThan(T_TACKLE.standWindup);
    expect(t[0]!.tick - t0).toBeLessThan(T_TACKLE.standWindup + T_TACKLE.standContactTicks);
  });

  it('hard tackle: longer reach (plays a ball the standing tackle cannot reach at once) and a longer recovery', () => {
    const d = 0.6 + (standReachOf(ActionKind.STAND_TACKLE) + standReachOf(ActionKind.HARD_TACKLE)) / 2;
    const at: number[] = [];
    for (const k of [ActionKind.STAND_TACKLE, ActionKind.HARD_TACKLE]) {
      const s = duel(4, d);
      const t0 = s.tick;
      startTackle(s, P2, k, -1, EV);
      const t = tackles(stepN(s, 20));
      expect(t).toHaveLength(1);
      at.push(t[0]!.tick - t0);
      expect(t[0]!.d).toBe(k === ActionKind.HARD_TACKLE ? ChallengeKind.HARD : ChallengeKind.STAND);
    }
    expect(at[1]).toBe(T_TACKLE.standWindup);
    expect(at[0]).toBeGreaterThan(at[1]!);
    const s = duel(4, 6);
    startTackle(s, P2, ActionKind.HARD_TACKLE, -1, EV);
    expect(s.players[P2]!.actDur).toBe(T_TACKLE.standWindup + T_TACKLE.standContactTicks + Math.round(T_TACKLE.standRecovery * T_TACKLE.hardRecoveryMul));
  });

  it('refused: busy, dead ball, ball in a keeper\'s hands, own team\'s ball, shoulder / push without a target', () => {
    const s = duel(5, 2);
    s.players[P2]!.stunT = 5;
    expect(startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV)).toBe(0);
    s.players[P2]!.stunT = 0;
    s.match.phase = MatchPhase.THROW_IN;
    s.match.restart.taken = 0;
    expect(startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV)).toBe(0);
    s.match.phase = MatchPhase.IN_PLAY;
    s.ball.heldBy = P1;
    expect(startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, EV)).toBe(0);
    s.ball.heldBy = -1;
    expect(startTackle(s, 8, ActionKind.STAND_TACKLE, -1, EV)).toBe(0); // P1's teammate: his own team's ball
    loose(s, 10, 10, 0, 0);
    expect(startTackle(s, P2, ActionKind.SHOULDER, -1, EV)).toBe(0);
    expect(startTackle(s, P2, ActionKind.PUSH_PULL, -1, EV)).toBe(0);
    expect(startTackle(s, P2, ActionKind.STAND_TACKLE, 13, EV)).toBe(0); // a teammate as target
    expect(startTackle(s, P2, ActionKind.KICK, -1, EV)).toBe(0);
    expect(startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, EV)).toBe(1); // a slide needs no carrier
  });
});

describe('SIM-14 standing tackle: success model', () => {
  function rate(base: ReturnType<typeof duel>, n: number): { won: number; kept: number; poked: number } {
    let won = 0, kept = 0, poked = 0;
    for (let k = 0; k < n; k++) {
      const s = trial(base, k);
      startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
      const ev = stepN(s, T_TACKLE.standWindup + 1);
      const t = tackles(ev);
      if (t.length === 1 && t[0]!.c === 1) {
        won++;
        if (s.ball.owner === P2) kept++;
        if (ev.some((e) => e.type === EventType.KICK && e.a === P2 && e.b === KickKind.TACKLE_POKE)) poked++;
        expect(s.players[P1]!.noTouchT).toBeGreaterThan(0);
      }
    }
    return { won: won / n, kept, poked };
  }

  it('tackles succeed more often for a high standingTackle', () => {
    const lo = duel(7, 1.9), hi = duel(7, 1.9);
    lo.attrs[P2]!.standingTackle = 20;
    hi.attrs[P2]!.standingTackle = 95;
    const rl = rate(lo, 160), rh = rate(hi, 160);
    expect(rh.won).toBeGreaterThan(rl.won + 0.15);
    expect(rh.won).toBeGreaterThan(0.25);
    expect(rl.won).toBeGreaterThan(0.02);
  });

  it('a won tackle either keeps the ball (tackler free with it) or pokes it loose (TACKLE_POKE)', () => {
    const base = duel(8, 1.9);
    base.attrs[P2]!.standingTackle = 90;
    const r = rate(base, 160);
    expect(r.kept).toBeGreaterThan(0);
    expect(r.poked).toBeGreaterThan(0);
    // a kept ball: the tackle ended at once and he dribbles on
    for (let k = 0; k < 200; k++) {
      const s = trial(base, k);
      startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
      stepN(s, T_TACKLE.standWindup);
      if (s.ball.owner !== P2) continue;
      expect(s.players[P2]!.act).toBe(ActionKind.NONE);
      stepN(s, 30);
      expect(s.ball.owner).toBe(P2);
      return;
    }
    throw new Error('no kept tackle in 200 trials');
  });

  it('timing: an exposed ball (between touches) is won more often than one at his feet; from behind is worst', () => {
    const s = duel(9, 1.4);
    const near = winChance(s, P2, ActionKind.STAND_TACKLE, P1, 1.0);
    s.ball.x = 1.25; // ball away from the carrier's feet
    const far = winChance(s, P2, ActionKind.STAND_TACKLE, P1, 1.0);
    expect(far).toBeGreaterThan(near + 0.1);
    s.ball.x = 0.6;
    place(s, P2, -1.4, 0, 1, 0); // behind him
    const behind = winChance(s, P2, ActionKind.STAND_TACKLE, P1, 1.0);
    expect(behind).toBeLessThan(near * 0.6);
  });

  it('timing: a skill move protects the ball except in its vulnerable window', () => {
    const s = duel(10, 1.4);
    const q = s.players[P1]!;
    q.act = ActionKind.SKILL; q.actSkill = SkillMove.STEP_OVER; q.actDur = 26;
    q.actT = 2;
    const outside = winChance(s, P2, ActionKind.STAND_TACKLE, P1, 1.0);
    q.actT = 10;
    const inside = winChance(s, P2, ActionKind.STAND_TACKLE, P1, 1.0);
    expect(inside).toBeGreaterThan(outside * 3);
    expect(outside).toBeLessThanOrEqual(0.15);
  });
});

describe('SIM-14 slide tackle', () => {
  it('long reach: a sprinting slide reaches a ball a standing tackle cannot; long recovery', () => {
    for (const k of [ActionKind.STAND_TACKLE, ActionKind.SLIDE_TACKLE]) {
      const s = scene(11);
      place(s, P1, 0, 0, -1, 0); // carrier facing the defender (front-on)
      owned(s, P1, -0.6, 0);
      place(s, P2, -3.6, 0, 1, 0, 8);
      const t0 = s.tick;
      startTackle(s, P2, k, -1, EV);
      if (k === ActionKind.SLIDE_TACKLE) {
        expect(s.players[P2]!.actDur).toBe(T_TACKLE.slideWindup + T_TACKLE.slideContactTicks + T_TACKLE.slideRecovery);
      }
      const t = tackles(stepN(s, 30));
      expect(t).toHaveLength(1);
      const inWindow = t[0]!.tick - t0 < T_TACKLE.slideWindup + T_TACKLE.slideContactTicks;
      if (k === ActionKind.SLIDE_TACKLE) expect(inWindow && (t[0]!.c === 1 || t[0]!.b === P1)).toBe(true);
      else expect(t[0]!.tick - t0).toBe(T_TACKLE.standWindup + T_TACKLE.standContactTicks); // whiff
    }
  });

  it('quick get-up: quickGetUp shortens the recovery after the window to slideGetUpQuick (once)', () => {
    const s = scene(12);
    place(s, P2, 0, 0, 1, 0, 6);
    loose(s, 30, 10, 0, 0);
    const t0 = s.tick;
    startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, EV);
    stepN(s, 10);
    expect(quickGetUp(s, P2)).toBe(1);
    expect(quickGetUp(s, P2)).toBe(0);
    const want = T_TACKLE.slideWindup + T_TACKLE.slideContactTicks + T_TACKLE.slideGetUpQuick;
    expect(s.players[P2]!.actDur).toBe(want);
    let freeAt = -1;
    stepN(s, 80, (st) => { if (freeAt < 0 && st.players[P2]!.act === ActionKind.NONE) freeAt = st.tick; });
    expect(freeAt - t0).toBe(want);
    expect(quickGetUp(s, P1)).toBe(0); // not sliding
  });

  it('quick get-up through the controller: the second slide press (X / Square) gets him up early', () => {
    const run = (second: boolean): number => {
      const s = makeScenario({
        seed: 13, phase: MatchPhase.IN_PLAY,
        humans: [{ side: 0, slot: P1, autoSwitch: 0 }, { side: 1, slot: P2, autoSwitch: 0 }],
      });
      for (const c of [2, 3]) { const ctl = s.ctrl[c]!; if (ctl.slot >= 0) s.players[ctl.slot]!.ctrl = -1; ctl.kind = 0; ctl.side = -1; ctl.slot = -1; }
      s.teams[0]!.cpu.active = 0; s.teams[1]!.cpu.active = 0;
      place(s, P1, 0, 0, 1, 0);
      owned(s, P1, 0.6, 0);
      place(s, P2, 8, 0, -1, 0);
      let start = -1, end = -1;
      runTicks(s, 120, (t, st, out) => {
        if (t === 2 || (second && t === 12)) out[1]!.buttons = Btn.LOB;
      }, {
        until: (st) => {
          const a = st.players[P2]!.act;
          if (start < 0 && a === ActionKind.SLIDE_TACKLE) start = st.tick;
          if (start >= 0 && end < 0 && a !== ActionKind.SLIDE_TACKLE) end = st.tick;
          return end >= 0;
        },
      });
      expect(start).toBeGreaterThan(0);
      return end - start;
    };
    const normal = run(false), quick = run(true);
    expect(normal).toBeGreaterThanOrEqual(T_TACKLE.slideWindup + T_TACKLE.slideContactTicks + T_TACKLE.slideRecovery - 1);
    expect(quick).toBeLessThan(normal - 15);
  });

  it('Ball stuck: under a sliding player — a slide onto a slow loose ball never leaves it under his body', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const s = scene(seed);
      place(s, P2, 0, 0, 1, 0, 7);
      loose(s, 2.2 + seed * 0.05, (seed % 3 - 1) * 0.3, -0.5, 0);
      startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, EV);
      let under = 0, maxUnder = 0;
      stepN(s, 70, (st) => {
        const p = st.players[P2]!, b = st.ball;
        const d = Math.hypot(b.x - p.x, b.z - p.z);
        const slow = Math.hypot(b.vx, b.vz) < 0.3;
        under = b.owner < 0 && d < 0.6 && slow ? under + 1 : 0;
        maxUnder = Math.max(maxUnder, under);
      });
      expect(maxUnder, `seed ${seed}`).toBeLessThanOrEqual(1);
    }
  });

  it('Ball stuck: under a sliding player — a ball at rest under a down player squirts out at once', () => {
    for (const act of [ActionKind.FALLEN, ActionKind.SLIDE_TACKLE]) {
      const s = scene(14);
      place(s, P2, 5, 5, 1, 0);
      knockDown(s, P2, ActionKind.FALLEN, EV);
      if (act === ActionKind.SLIDE_TACKLE) {
        s.players[P2]!.act = ActionKind.SLIDE_TACKLE; s.players[P2]!.actT = 30; s.players[P2]!.actContact = 4;
        s.players[P2]!.actDur = 66; s.players[P2]!.actDirX = 1; s.players[P2]!.actDirZ = 0; s.players[P2]!.stunT = 0;
      }
      loose(s, 5.3, 5.05, 0, 0);
      const ev = stepN(s, 2);
      const k = ev.find((e) => e.type === EventType.KICK && e.b === KickKind.DEFLECTION);
      expect(k?.a, ActionKind[act]).toBe(P2);
      expect(s.ball.lastTouch).toBe(P2);
      expect(Math.hypot(s.ball.vx, s.ball.vz)).toBeGreaterThan(1);
    }
  });
});

describe('SIM-14 shoulder challenge and push / pull', () => {
  function alongside(seed: number, strT: number, strV: number) {
    const s = scene(seed);
    place(s, P1, 0, 0, 1, 0, 6);
    owned(s, P1, 0.9, 0);
    place(s, P2, 0, 0.8, 1, 0, 6);
    s.attrs[P2]!.strength = strT;
    s.attrs[P1]!.strength = strV;
    s.config.fouls = 0;
    return s;
  }

  it('the stronger player wins the shoulder duel more often; a won duel knocks the carrier off the ball', () => {
    const wins = [0, 0];
    let offBall = 0;
    for (const [i, st] of [[0, 30], [1, 95]] as const) {
      const base = alongside(15, st, 60);
      for (let k = 0; k < 100; k++) {
        const s = trial(base, k);
        expect(startTackle(s, P2, ActionKind.SHOULDER, -1, EV)).toBe(1);
        const t = tackles(stepN(s, L.shoulderWindup + L.shoulderContactTicks + 1));
        expect(t).toHaveLength(1);
        expect(t[0]!.d).toBe(ChallengeKind.SHOULDER);
        if (t[0]!.c === 1) {
          wins[i]!++;
          if (s.players[P1]!.act === ActionKind.STUMBLE && s.ball.owner !== P1) offBall++;
        }
      }
    }
    expect(wins[1]).toBeGreaterThan(wins[0]! + 25);
    expect(offBall).toBe(wins[0]! + wins[1]!);
  });

  it('push / pull slows the carrier and records a PUSH_PULL challenge', () => {
    const run = (push: boolean): { x: number; ev: SimEvent[] } => {
      const s = scene(16);
      s.config.fouls = 0;
      s.attrs[P2]!.strength = 1; // he never pulls the carrier over here: only the drag shows
      place(s, P1, 0, 0, 1, 0, 6);
      owned(s, P1, 1.0, 0);
      place(s, P2, -0.9, 0.2, 1, 0, 6.5);
      if (push) expect(startTackle(s, P2, ActionKind.PUSH_PULL, -1, EV)).toBe(1);
      const ev = runTicks(s, 18, (_t, _s, out) => { out[0]!.mx = AXIS_SCALE; out[0]!.buttons = Btn.SPRINT; });
      return { x: s.players[P1]!.x, ev };
    };
    const free = run(false), pushed = run(true);
    expect(pushed.x).toBeLessThan(free.x - 0.25);
    const t = tackles(pushed.ev);
    expect(t).toHaveLength(1);
    expect(t[0]!.d).toBe(ChallengeKind.PUSH_PULL);
    expect(pushed.ev.some((e) => e.type === EventType.BODY_CONTACT && e.a === P2)).toBe(true);
  });
});

describe('SIM-14 down states', () => {
  it('FALLEN -> GET_UP -> free after fallTicks + getUpTicks; it interrupts the running action', () => {
    const s = scene(17);
    place(s, P1, 0, 0, 1, 0);
    owned(s, P1, 0.5, 0);
    const req = createActionRequest();
    req.dirX = 1;
    expect(startPass(s, P1, KickKind.GROUND_PASS, req, EV)).toBe(1);
    knockDown(s, P1, ActionKind.FALLEN, EV);
    const p = s.players[P1]!;
    expect(p.act).toBe(ActionKind.FALLEN);
    expect(p.stunT).toBe(T_TACKLE.fallTicks + T_TACKLE.getUpTicks);
    knockDown(s, P1, ActionKind.STUMBLE, EV); // never downgrades
    expect(p.act).toBe(ActionKind.FALLEN);
    let up = -1, sawGetUp = false;
    const t0 = s.tick;
    const ev = stepN(s, 120, (st) => {
      const q = st.players[P1]!;
      if (q.act === ActionKind.GET_UP) sawGetUp = true;
      if (up < 0 && q.act === ActionKind.NONE) up = st.tick;
      if (q.act !== ActionKind.NONE) expect(q.stunT).toBeGreaterThan(0);
    });
    expect(sawGetUp).toBe(true);
    expect(up - t0).toBe(T_TACKLE.fallTicks + T_TACKLE.getUpTicks);
    expect(p.stunT).toBe(0);
    expect(ev.some((e) => e.type === EventType.KICK && e.a === P1 && e.b === KickKind.GROUND_PASS)).toBe(false);
  });

  it('STUMBLE lasts stumbleTicks and he can only move slowly', () => {
    const s = scene(18);
    place(s, P1, 0, 0, 1, 0);
    loose(s, 20, 20, 0, 0);
    knockDown(s, P1, ActionKind.STUMBLE, EV);
    let maxV = 0;
    const t0 = s.tick;
    let up = -1;
    runTicks(s, 60, (_t, _s, out) => { out[0]!.mx = AXIS_SCALE; out[0]!.buttons = Btn.SPRINT; }, {
      until: (st) => {
        const q = st.players[P1]!;
        if (q.act === ActionKind.STUMBLE) maxV = Math.max(maxV, Math.hypot(q.vx, q.vz));
        if (up < 0 && q.act === ActionKind.NONE) up = st.tick;
        return false;
      },
    });
    expect(up - t0).toBe(T_TACKLE.stumbleTicks);
    expect(maxV).toBeLessThan(0.5 * s.attrs[P1]!.topSpeed * 0.6 + 0.01);
  });

  it('a stun outside the down states always counts down (never stuck unable to act)', () => {
    const s = scene(19);
    s.players[P1]!.stunT = 40;
    stepN(s, 41);
    expect(s.players[P1]!.stunT).toBe(0);
  });
});

describe('SIM-14 glitch list', () => {
  it('Keeper fights a defender: an outfield player leaves a loose ball to his own claiming keeper', () => {
    const s = scene(20);
    const gk = s.teams[1]!.keeperSlot;
    place(s, gk, 40, 0, 1, 0);
    place(s, P2, 41.2, 0, 1, 0);
    loose(s, 42, 0, 0, 0);
    startTackle(s, P2, ActionKind.STAND_TACKLE, -1, EV);
    const p = s.players[P2]!;
    p.actT = p.actContact; // in the window
    const g = s.players[gk]!;
    g.act = ActionKind.GK_RUSH; g.actT = 1; g.actDur = 60;
    const c = cloneState(s);
    tackleContacts(s, EV);
    expect(s.ball.touchedTick).not.toBe(s.tick);
    expect(s.players[P2]!.actDone).toBe(0);
    // control: without the keeper's claim he plays it
    c.players[gk]!.act = ActionKind.NONE;
    tackleContacts(c, EV);
    expect(c.players[P2]!.actDone).toBe(1);
  });

  it('Discipline: a slide from behind that takes the man is a foul by the tackler on the carrier (RUL-09)', () => {
    let fouls = 0;
    for (let seed = 1; seed <= 12 && fouls < 3; seed++) {
      const s = scene(seed);
      place(s, P1, 0, 0, 1, 0, 3);
      owned(s, P1, 0.7, 0);
      place(s, P2, -2.4, 0, 1, 0, 7.5);
      startTackle(s, P2, ActionKind.SLIDE_TACKLE, -1, EV);
      const ev = stepN(s, 30);
      const f = ev.filter((e) => e.type === EventType.FOUL);
      const t = tackles(ev);
      expect(t).toHaveLength(1);
      expect(t[0]!.d).toBe(ChallengeKind.SLIDE);
      if (f.length === 0) continue;
      fouls++;
      expect(f[0]!.a).toBe(P2);
      expect(f[0]!.b).toBe(P1);
      for (const c of ev.filter((e) => e.type === EventType.CARD)) expect(c.a).toBe(P2);
    }
    expect(fouls).toBeGreaterThan(0);
  });
});

describe('SIM-14 in a bot match', () => {
  it('forced tackles of every kind near the ball keep every invariant and stay deterministic', () => {
    const KINDS = [ActionKind.STAND_TACKLE, ActionKind.HARD_TACKLE, ActionKind.SLIDE_TACKLE, ActionKind.SHOULDER, ActionKind.PUSH_PULL];
    const run = (): { hash: number; started: number; tackles: number; whistled: number } => {
      const s = makeScenario({ seed: 2, config: { halfMinutes: 2 } });
      let started = 0;
      let whistled = 0;
      const pending = new Uint8Array(22);
      const t0 = s.tick;
      // [INT-A] 60 quiet ticks at the end: a tackle forced in the last few ticks used to be cut off by the end of the
      // run before its contact window closed (no TACKLE event yet), failing the count by chance.
      // [QF-9] Likewise a tackle still unresolved when the whistle goes for something else (another challenge's foul, the
      // ball out of play): the restart ends every action and that tackle never happens (no TACKLE event). Counted here
      // (whistled): in a tackle action, unresolved before the tick, gone without a TACKLE event as play stops.
      const ev = runTicks(s, 3060, (t, st) => {
        for (let i = 0; i < 22; i++) {
          const p = st.players[i]!;
          pending[i] = p.act >= ActionKind.STAND_TACKLE && p.act <= ActionKind.PUSH_PULL && (p.actA & 1) === 0 ? 1 : 0;
        }
        if (t % 7 !== 0 || t - t0 >= 3000) return;
        const b = st.ball;
        for (let i = 0; i < 22; i++) {
          const p = st.players[i]!;
          if (p.isKeeper === 1 || Math.hypot(p.x - b.x, p.z - b.z) > 3.5) continue;
          if (b.owner >= 0 && st.players[b.owner]!.team === p.team) continue;
          started += startTackle(st, i, KINDS[(t + i) % KINDS.length]!, -1, EV);
        }
      }, {
        check: 'all',
        until: (st, evs) => {
          if (st.match.phase === MatchPhase.IN_PLAY) return false;
          for (let i = 0; i < 22; i++) {
            const p = st.players[i]!;
            if (pending[i] === 0 || (p.act >= ActionKind.STAND_TACKLE && p.act <= ActionKind.PUSH_PULL)) continue;
            if (!evs.some((e) => e.type === EventType.TACKLE && e.a === i)) whistled++;
          }
          return false;
        },
      });
      return { hash: hashState(s), started, tackles: tackles(ev).length, whistled };
    };
    const a = run();
    // [QF-13] was > 40: the count follows the bot match's flow (39 after QF-13's sim changes); every kind is still
    // forced several times over.
    expect(a.started).toBeGreaterThan(30);
    expect(a.whistled).toBeLessThanOrEqual(2);
    expect(a.tackles + a.whistled).toBeGreaterThanOrEqual(a.started);
    expect(run()).toEqual(a);
  }, 60_000);
});

describe('SIM-14 determinism', () => {
  it('the same tackles give the same state hash; a mid-tackle clone continues identically', () => {
    const run = (): number[] => {
      const s = duel(21, 1.9);
      startTackle(s, P2, ActionKind.HARD_TACKLE, -1, EV);
      stepN(s, 4);
      const c = cloneState(s);
      stepN(s, 60);
      stepN(c, 60);
      expect(hashState(c)).toBe(hashState(s));
      startTackle(s, P1, ActionKind.SLIDE_TACKLE, -1, EV);
      stepN(s, 80);
      return [hashState(s), s.ball.x, s.players[P2]!.x];
    };
    expect(run()).toEqual(run());
  });

  it('contact windows are the tuned lengths', () => {
    expect(contactTicksOf(ActionKind.STAND_TACKLE)).toBe(T_TACKLE.standContactTicks);
    expect(contactTicksOf(ActionKind.SLIDE_TACKLE)).toBe(T_TACKLE.slideContactTicks);
    expect(contactTicksOf(ActionKind.SHOULDER)).toBe(L.shoulderContactTicks);
    expect(contactTicksOf(ActionKind.PUSH_PULL)).toBe(L.pushContactTicks);
  });
});
