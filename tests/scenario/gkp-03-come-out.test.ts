/**
 * [GKP-03] Coming out, stepped through the real pipeline for both keepers and both halves: rushes for through
 * balls he wins, stays home when a defender gets there first (glitch "Keeper fights a defender for the same ball"),
 * one-on-ones (narrow the angle, smother), crosses (claim vs punch), the user rush (hold THROUGH / KEEPER_RUSH,
 * release returns him), never leaving the goal empty for nothing, determinism.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ChallengeKind, GestureKind, KickKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, GestureFlag } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { hashState } from '../../src/sim/core/hash';
import { LOCAL_TUNING as L, RushMode } from '../../src/sim/keeper/sweeper';
import { runTicks } from '../harness/scenario';
import { ENDS, drive, eventsOf, isRushing, offSpot, scene, type Scene } from './gkp-03-helpers';

/** Run n ticks and record the keeper's per-tick action / depth (after each tick). */
function track(sc: Scene, n: number, inputs?: Parameters<typeof runTicks>[2], check: 'none' | 'core' | 'all' = 'core') {
  const acts: number[] = [];
  const modes: number[] = [];
  const depth: number[] = [];
  const ev = runTicks(sc.s, n, inputs, {
    check,
    until: (st) => {
      const k = st.players[sc.keeper]!;
      acts.push(k.act);
      modes.push(k.act === ActionKind.GK_RUSH ? k.actA : -1);
      depth.push(sc.u(k.x));
      return false;
    },
  });
  return { ev, acts, modes, depth };
}

function handsOf(ev: readonly SimEvent[], keeper: number): SimEvent | undefined {
  return ev.find((e) => e.type === EventType.KEEPER_HANDS && e.a === keeper && e.b === 1);
}

/** Through ball toward the box chased by a human-driven striker (the attacking side's P1). */
function throughBall(team: number, swap: boolean, seed = 7): Scene {
  const opp = team === 0 ? 1 : 0;
  const striker = (opp === 0 ? 0 : 11) + 9;
  const sc = scene({ team, swap, seed, humans: [{ side: opp, slot: striker }] });
  sc.place(striker, 31, 3, -3, 0);
  sc.loose(25.5, 5, -9.5, -1, { by: sc.att(8), target: striker });
  return sc;
}

const chaseBall = drive(0, (s) => ({ x: s.ball.x, z: s.ball.z }));

describe('GKP-03 rushes for through balls he can win', () => {
  for (const e of ENDS) {
    it(`comes out and collects a through ball before the striker (${e.name})`, () => {
      const sc = throughBall(e.team, e.swap);
      const { ev, acts, modes } = track(sc, 180, chaseBall);
      const first = acts.findIndex((a) => a === ActionKind.GK_RUSH);
      expect(first).toBeGreaterThanOrEqual(0);
      // As soon as his interception is inside the 2 s prediction horizon.
      expect(first).toBeLessThan(20);
      expect(modes[first]).toBe(RushMode.AI_BALL);
      const hands = handsOf(ev, sc.keeper);
      expect(hands).toBeDefined();
      // The striker never had it.
      expect(ev.filter((x) => x.type === EventType.POSSESSION && x.a === sc.opp)).toHaveLength(0);
      expect(eventsOf(ev, EventType.GOAL)).toHaveLength(0);
      expect(sc.s.ball.heldBy).toBe(sc.keeper);
      // He collected it out in front of his goal (a real rush, not on his line).
      expect(sc.u(hands!.x)).toBeGreaterThan(6);
    });
  }

  it('collects a low ball rolling across the six-yard box with nobody near', () => {
    const sc = scene({ seed: 3 });
    sc.loose(4.5, 14, -0.3, -9, { kind: KickKind.GROUND_CROSS });
    const { ev, acts } = track(sc, 120);
    expect(acts.some((a) => a === ActionKind.GK_RUSH)).toBe(true);
    expect(handsOf(ev, sc.keeper)).toBeDefined();
    expect(sc.s.ball.heldBy).toBe(sc.keeper);
  });

  it('does not come out for a ball he cannot win (the striker is clearly first)', () => {
    const sc = throughBall(0, false);
    sc.place(sc.att(9), 15, 4, -6, 0); // already in the box, running onto it
    sc.loose(14, 5, -3, -0.4, { by: sc.att(8), target: sc.att(9) });
    const { modes } = track(sc, 20, chaseBall);
    expect(modes.some((m) => m === RushMode.AI_BALL)).toBe(false);
  });

  it('ignores a loose ball far from his goal', () => {
    const sc = scene({ seed: 4 });
    sc.loose(55, 0, -4, 0);
    const { acts } = track(sc, 60);
    expect(acts.every((a) => a !== ActionKind.GK_RUSH && a !== ActionKind.GK_PUNCH)).toBe(true);
  });
});

describe('GKP-03 glitch: Keeper fights a defender for the same ball', () => {
  for (const e of ENDS) {
    it(`stays home when a defender is closer to the through ball (${e.name})`, () => {
      const sc = throughBall(e.team, e.swap);
      const def = sc.mate(3);
      sc.place(def, 10, 3.5);
      const { acts } = track(sc, 90, chaseBall);
      expect(acts.every((a) => a !== ActionKind.GK_RUSH)).toBe(true);
      expect(sc.s.teams[sc.team]!.chaser === def || sc.s.ball.owner === def).toBe(true);
    });
  }

  it('aborts a rush at once when a defender appears on the ball\'s path ahead of him', () => {
    for (const e of ENDS) {
      const sc = throughBall(e.team, e.swap);
      let placed = -1;
      let stopped = -1;
      runTicks(sc.s, 60, (t, s, out) => {
        chaseBall(t, s, out);
        if (placed < 0 && s.players[sc.keeper]!.act === ActionKind.GK_RUSH && s.tick > 25) {
          const b = s.ball;
          sc.place(sc.mate(3), sc.u(b.x) - 3, b.z);
          placed = s.tick;
        }
      }, {
        check: 'core',
        until: (s) => {
          if (placed > 0 && stopped < 0 && s.players[sc.keeper]!.act !== ActionKind.GK_RUSH) stopped = s.tick;
          return false;
        },
      });
      expect(placed, e.name).toBeGreaterThan(0);
      expect(stopped, e.name).toBeGreaterThan(0);
      expect(stopped - placed, e.name).toBeLessThanOrEqual(1);
    }
  });

  it('the keeper and a defender are never both rushing the same loose ball (random loose balls into the box)', () => {
    let rushes = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const r = (k: number): number => ((seed * 7919 + k * 104729) % 1000) / 1000;
      const sc = scene({ seed, team: seed % 2, swap: seed % 3 === 0 });
      const bu = 14 + r(1) * 14, bz = -12 + r(2) * 24;
      sc.loose(bu, bz, -(5 + r(3) * 7), (r(4) - 0.5) * 6);
      for (let n = 1; n <= 3; n++) sc.place(sc.mate(n + 1), 4 + r(5 + n) * 18, -14 + r(9 + n) * 28);
      for (let n = 1; n <= 2; n++) sc.place(sc.att(n + 8), bu + 2 + r(13 + n) * 12, bz - 6 + r(16 + n) * 12, -4, 0);
      let both = 0;
      let worst = 0;
      runTicks(sc.s, 150, undefined, {
        check: 'all',
        until: (s) => {
          const k = s.players[sc.keeper]!;
          const b = s.ball;
          const ai = k.act === ActionKind.GK_RUSH && (k.actA === RushMode.AI_BALL) && k.actB === 0;
          if (ai) rushes++;
          let mateNear = false;
          if (ai && b.owner < 0 && b.heldBy < 0) {
            const dk = Math.hypot(k.x - b.x, k.z - b.z);
            for (let i = 0; i < 22; i++) {
              const q = s.players[i]!;
              if (q.team !== sc.team || q.isKeeper === 1 || q.active !== 1) continue;
              const dq = Math.hypot(q.x - b.x, q.z - b.z);
              if (dq < 1.5 && dq + 1 < dk) mateNear = true;
            }
          }
          both = mateNear ? both + 1 : 0;
          if (both > worst) worst = both;
          return false;
        },
      });
      expect(worst, `seed ${seed}`).toBeLessThanOrEqual(2);
    }
    expect(rushes).toBeGreaterThan(0);
  });

  it('stays home in a one-on-one a defender is engaging', () => {
    const sc = scene({ seed: 9, humans: [{ side: 1, slot: 20 }] });
    sc.place(20, 17, 1, -5, 0);
    sc.owned(20, -0.8);
    sc.place(sc.mate(4), 15.5, 2.2, -4, 0); // tracking him, within reach
    const { acts } = track(sc, 20, drive(0, () => ({ x: sc.x(0), z: 0 })));
    expect(acts.every((a) => a !== ActionKind.GK_RUSH)).toBe(true);
  });
});

describe('GKP-03 one-on-ones', () => {
  for (const e of ENDS) {
    it(`narrows the angle, then smothers the dribbler at his feet (${e.name})`, () => {
      const opp = e.team === 0 ? 1 : 0;
      const striker = (opp === 0 ? 0 : 11) + 9;
      const sc = scene({ team: e.team, swap: e.swap, seed: 5, humans: [{ side: opp, slot: striker }] });
      sc.place(striker, 18.5, 2, -5, 0);
      sc.owned(striker, -0.8, 0, -5, 0);
      const { ev, modes, depth } = track(sc, 160, drive(0, () => ({ x: sc.x(0), z: 0 })));
      const first = modes.findIndex((m) => m === RushMode.AI_ONE_ON_ONE);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(10);
      // He came off his line to narrow the angle.
      expect(Math.max(...depth)).toBeGreaterThan(3);
      const tackle = ev.find((x) => x.type === EventType.TACKLE && x.a === sc.keeper && x.c === 1);
      expect(tackle).toBeDefined();
      expect(tackle!.b).toBe(striker);
      expect(tackle!.d).toBe(ChallengeKind.KEEPER);
      expect(handsOf(ev, sc.keeper)).toBeDefined();
      expect(eventsOf(ev, EventType.GOAL)).toHaveLength(0);
    });
  }

  it('does not come out for a carrier running away from goal or at a tight angle', () => {
    const away = scene({ seed: 6 });
    away.place(20, 15, 2, 6, 0);
    away.owned(20, 0.8, 0, 6, 0);
    const a = track(away, 15);
    expect(a.acts.every((x) => x !== ActionKind.GK_RUSH)).toBe(true);
    const tight = scene({ seed: 6 });
    tight.place(20, 3, 15, -1, -2);
    tight.owned(20, 0, -0.8, 0, -2);
    const t = track(tight, 15);
    expect(t.acts.every((x) => x !== ActionKind.GK_RUSH)).toBe(true);
  });
});

/** Cross from the right wing into the six-yard box (the keeper starts at u 1, z 1). */
function cross(team: number, swap: boolean, seed = 3): Scene {
  const sc = scene({ team, swap, seed, ku: 1, kz: 1 });
  sc.loose(8.5, 26, -3, -17, { y: 0.5, vy: 8.5, kind: KickKind.CROSS, by: sc.att(10) });
  return sc;
}

describe('GKP-03 crosses into the goal area: claim or punch', () => {
  for (const e of ENDS) {
    it(`claims an uncontested cross above heads (${e.name})`, () => {
      const sc = cross(e.team, e.swap);
      sc.s.attrs[sc.keeper]!.gkHandling = 99;
      const { ev, acts } = track(sc, 110);
      expect(acts[0]).toBe(ActionKind.GK_PUNCH);
      const hands = handsOf(ev, sc.keeper);
      expect(hands).toBeDefined();
      expect(hands!.y).toBeGreaterThan(L.claimMinY - 0.3);
      expect(sc.s.ball.heldBy).toBe(sc.keeper);
    });

    it(`punches a contested cross away from goal (${e.name})`, () => {
      const sc = cross(e.team, e.swap);
      sc.place(sc.att(9), 5.0, 4.6);
      let vu = 0;
      let punchedAt = -1;
      const ev = runTicks(sc.s, 110, undefined, {
        check: 'core',
        until: (s, tev) => {
          if (tev.some((x) => x.type === EventType.KICK && x.a === sc.keeper && x.b === KickKind.GK_PUNCH)) {
            punchedAt = s.tick;
            vu = sc.dir * s.ball.vx;
          }
          return false;
        },
      });
      expect(punchedAt).toBeGreaterThan(0);
      expect(handsOf(ev, sc.keeper)).toBeUndefined();
      // Punched out: the ball leaves toward the field, away from his goal line, before any header.
      expect(vu).toBeGreaterThan(5);
      expect(eventsOf(ev, EventType.AERIAL).filter((x) => x.tick <= punchedAt)).toHaveLength(0);
      expect(eventsOf(ev, EventType.GOAL)).toHaveLength(0);
    });
  }

  it('better handling catches more uncontested crosses (deterministic over seeds)', () => {
    const rate = (handling: number): number => {
      let caught = 0;
      for (let seed = 1; seed <= 16; seed++) {
        const sc = cross(0, false, seed);
        sc.s.attrs[sc.keeper]!.gkHandling = handling;
        const { ev } = track(sc, 100, undefined, 'none');
        if (handsOf(ev, sc.keeper)) caught++;
      }
      return caught;
    };
    const good = rate(99), poor = rate(1);
    expect(good).toBeGreaterThan(poor);
    expect(good).toBeGreaterThanOrEqual(14);
  });

  it('leaves a low cross to the loose-ball logic and never claims a goal-bound lob', () => {
    const low = scene({ seed: 2 });
    low.loose(5, 20, 0, -12, { y: 0.4, vy: 1.5, kind: KickKind.LOW_CROSS });
    const l = track(low, 5);
    expect(l.acts.every((a) => a !== ActionKind.GK_PUNCH)).toBe(true);
    // A lob dropping under the bar is GKP-02's save, not a claim.
    const lob = scene({ seed: 2, ku: 6 });
    lob.loose(20, 0.5, -12, 0, { y: 1.5, vy: 5.5, kind: KickKind.SHOT_CHIP });
    const g = track(lob, 5);
    expect(g.acts.every((a) => a !== ActionKind.GK_PUNCH)).toBe(true);
  });
});

describe('GKP-03 user rush (hold THROUGH / KEEPER_RUSH in defence)', () => {
  for (const e of ENDS) {
    it(`holding sprints the keeper at the carrier; release returns him toward his line (${e.name})`, () => {
      const opp = e.team === 0 ? 1 : 0;
      const defender = (e.team === 0 ? 0 : 11) + 4;
      const striker = (opp === 0 ? 0 : 11) + 9;
      const sc = scene({
        team: e.team, swap: e.swap, seed: 8, humans: [{ side: e.team, slot: defender }, { side: opp, slot: striker }],
      });
      sc.place(striker, 24, 4);
      sc.owned(striker, -0.6);
      const hold = 80;
      let maxDepth = 0;
      const ev = runTicks(sc.s, 200, (t, s, out) => {
        if (s.tick < hold) out[0]!.buttons |= Btn.THROUGH;
      }, {
        check: 'core',
        until: (s) => {
          const k = s.players[sc.keeper]!;
          if (s.tick === 10) {
            expect(k.act).toBe(ActionKind.GK_RUSH);
            expect(k.actA).toBe(RushMode.USER_HOLD);
          }
          if (s.tick === hold + 1) expect(k.act).not.toBe(ActionKind.GK_RUSH);
          maxDepth = Math.max(maxDepth, sc.u(k.x));
          return false;
        },
      });
      void ev;
      expect(maxDepth).toBeGreaterThan(4.5);
      expect(offSpot(sc.s, sc.team)).toBeLessThan(1.0);
    });
  }
});

describe('GKP-03 user rush by touch gesture and on a human-controlled keeper', () => {
  it('tap on your own keeper when defending (gesture) rushes him out for a moment, then he returns', () => {
    const sc = scene({ seed: 8, humans: [{ side: 0, slot: 4 }, { side: 1, slot: 20 }] });
    sc.place(20, 26, 3);
    sc.owned(20, -0.6);
    let started = -1, ended = -1;
    runTicks(sc.s, 260, (t, s, out) => {
      if (t === 3) {
        const f = out[0]!;
        f.gesture = GestureKind.TAP; f.gSlot = sc.keeper; f.gFlags = GestureFlag.ON_OWN_KEEPER;
        f.gx = Math.round(s.players[sc.keeper]!.x * 10); f.gz = Math.round(s.players[sc.keeper]!.z * 10);
      }
    }, {
      check: 'core',
      until: (s) => {
        const k = s.players[sc.keeper]!;
        if (started < 0 && k.act === ActionKind.GK_RUSH) {
          started = s.tick;
          expect(k.actA).toBe(RushMode.USER_TIMED);
        }
        if (started > 0 && ended < 0 && k.act !== ActionKind.GK_RUSH) ended = s.tick;
        return false;
      },
    });
    expect(started).toBeGreaterThan(0);
    // userTimedTicks handler updates; the tick it started in (resolver stage) counts as the first.
    expect(ended - started).toBe(L.userTimedTicks - 1);
    expect(offSpot(sc.s, sc.team)).toBeLessThan(1.0);
  });

  it('holding THROUGH turns an AI one-on-one into the user\'s rush: he sprints at the carrier', () => {
    const sc = scene({ seed: 9, humans: [{ side: 0, slot: 4 }, { side: 1, slot: 20 }] });
    sc.place(20, 16, 2, -1, 0);
    sc.owned(20, -0.8, 0, -1, 0);
    const ai = track(sc, 10);
    expect(ai.modes.some((m) => m === RushMode.AI_ONE_ON_ONE)).toBe(true);
    let closest = 1e9;
    const held = runTicks(sc.s, 150, (_t, _s, out) => { out[0]!.buttons |= Btn.THROUGH; }, {
      check: 'core',
      until: (s) => {
        const k = s.players[sc.keeper]!;
        if (s.tick === 12) expect(k.actA).toBe(RushMode.USER_HOLD);
        closest = Math.min(closest, Math.hypot(k.x - s.ball.x, k.z - s.ball.z));
        return false;
      },
    });
    // Sprinting at the carrier (the narrowing spot would keep him about 6 m away): he gets to the ball.
    expect(closest).toBeLessThan(L.smotherStartDist + 0.5);
    expect(held.some((e) => e.type === EventType.TACKLE && e.a === sc.keeper) || sc.s.ball.heldBy === sc.keeper).toBe(true);
  });
});

describe('GKP-03 never leaves the goal empty for nothing', () => {
  for (const e of ENDS) {
    it(`a rush ends the tick his team wins the ball and he returns to his spot (${e.name})`, () => {
      const sc = throughBall(e.team, e.swap);
      let given = -1;
      let stopped = -1;
      let back = Infinity;
      runTicks(sc.s, 240, (t, s, out) => {
        if (given < 0 && s.players[sc.keeper]!.act === ActionKind.GK_RUSH && s.tick > 30) {
          // A defender wins it at the edge of the box.
          const d = sc.mate(3);
          sc.place(d, sc.u(s.ball.x) + 0.5, s.ball.z);
          sc.owned(d, -0.6);
          given = s.tick;
        }
        if (given < 0) chaseBall(t, s, out);
      }, {
        check: 'core',
        until: (s) => {
          if (given > 0 && stopped < 0 && s.players[sc.keeper]!.act !== ActionKind.GK_RUSH) stopped = s.tick;
          if (stopped > 0 && s.tick - stopped <= 90) back = Math.min(back, offSpot(s, sc.team));
          return false;
        },
      });
      expect(given, e.name).toBeGreaterThan(0);
      expect(stopped - given, e.name).toBeLessThanOrEqual(1);
      expect(isRushing(sc.s, sc.keeper)).toBe(false);
      // [QF-2] Back on his spot within 1.5 s of the rush ending (was: at tick 240, but the CPU defender now often plays
      // the ball back to him in that time, and he is out receiving the back-pass when the run stops).
      expect(back, e.name).toBeLessThan(1.0);
    });
  }

  it('a carrier who turns back out of the box ends the one-on-one and the keeper returns', () => {
    const sc = scene({ seed: 5, humans: [{ side: 1, slot: 20 }] });
    sc.place(20, 18, 2, -5, 0);
    sc.owned(20, -0.8, 0, -5, 0);
    let out = false;
    const toGoal = drive(0, () => ({ x: sc.x(0), z: 0 }));
    const away = drive(0, () => ({ x: sc.x(45), z: 2 }));
    const ev = runTicks(sc.s, 260, (t, s, o) => {
      if (s.tick === 25) {
        // He turns back with the ball (it is at his feet, played away from goal).
        const p = s.players[20]!;
        sc.place(20, sc.u(p.x), p.z, 4, 0);
        sc.owned(20, 0.8, 0, 5, 0);
      }
      (s.tick < 25 ? toGoal : away)(t, s, o);
    }, {
      check: 'core',
      until: (s) => { if (isRushing(s, sc.keeper)) out = true; return false; },
    });
    expect(out).toBe(true);
    expect(isRushing(sc.s, sc.keeper)).toBe(false);
    expect(offSpot(sc.s, sc.team)).toBeLessThan(1.0);
    expect(eventsOf(ev, EventType.GOAL)).toHaveLength(0);
  });

  it('a claim he misses (the ball touched before take-off) is cancelled and he returns', () => {
    const sc = cross(0, false);
    let cancelled = -1;
    runTicks(sc.s, 200, (t, s) => {
      // A teammate's flick changes the flight early.
      if (s.tick === 20) {
        const b = s.ball;
        b.lastTouch = sc.mate(5); b.lastTouchTeam = sc.team; b.lastTouchTick = s.tick; b.vz = 8; b.vx = sc.vx(10);
      }
    }, {
      check: 'core',
      until: (s) => {
        if (cancelled < 0 && s.tick > 20 && s.players[sc.keeper]!.act !== ActionKind.GK_PUNCH) cancelled = s.tick;
        return false;
      },
    });
    expect(cancelled).toBeGreaterThan(0);
    expect(cancelled - 20).toBeLessThanOrEqual(2);
    expect(offSpot(sc.s, sc.team)).toBeLessThan(1.5);
  });
});

describe('GKP-03 determinism', () => {
  it('identical runs give identical hashes every tick (through ball, one-on-one, cross)', () => {
    const builds: (() => { sc: Scene; inputs?: Parameters<typeof runTicks>[2] })[] = [
      () => ({ sc: throughBall(1, true, 11), inputs: chaseBall }),
      () => {
        const sc = scene({ seed: 12, humans: [{ side: 1, slot: 20 }] });
        sc.place(20, 18.5, 2, -5, 0); sc.owned(20, -0.8, 0, -5, 0);
        return { sc, inputs: drive(0, () => ({ x: sc.x(0), z: 0 })) };
      },
      () => ({ sc: cross(0, false, 13) }),
    ];
    for (const build of builds) {
      const hashes = (): number[] => {
        const { sc, inputs } = build();
        const h: number[] = [];
        runTicks(sc.s, 160, inputs, { until: (s: SimState) => { h.push(hashState(s)); return false; } });
        return h;
      };
      expect(hashes()).toEqual(hashes());
    }
  });
});
