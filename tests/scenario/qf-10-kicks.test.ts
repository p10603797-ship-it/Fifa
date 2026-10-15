/**
 * [QF-10] Kicks and actions (FIX-01 / FIX-14 follow-up): charged strikes after the release, foot reach at contact
 * (distance, height, kicking spot), the dinked-pass model at T_BALL.bounceFriction 0.18, and long-ball skip.
 * Regression tests for the QF-10 defects; the QF-4 / QF-1 CR tests (qf-4-cr-charged-strike, qf-1-cr-kick-reach) cover
 * the match-level counts.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { createBallState, type BallState, type SimState } from '../../src/contracts/state';
import { T_BALL, T_PASS } from '../../src/contracts/tuning';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState } from '../../src/sim/ball/flight';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { CHARGE_SEEN, KICK_TUNING, footCanStrike } from '../../src/sim/kicks/kickCommon';
import { LOCAL_TUNING as LT, startPass } from '../../src/sim/kicks/pass';
import { LOCAL_TUNING as SHOT_LT, startShot } from '../../src/sim/kicks/shot';
import { makeScenario, runTicks } from '../harness/scenario';
import { giveBall, MATE_A, MATE_B, PASSER, place, quiet, req, skill, solve } from '../unit/sim-08-helpers';

/** Distance of (x, z) from slot's kicking spot (KICK_TUNING.spotAhead along his facing), m. */
function fromSpot(p: { x: number; z: number; fx: number; fz: number }, x: number, z: number): number {
  const fl = Math.hypot(p.fx, p.fz) || 1;
  return Math.hypot(x - (p.x + (p.fx / fl) * KICK_TUNING.spotAhead), z - (p.z + (p.fz / fl) * KICK_TUNING.spotAhead));
}

/** IN_PLAY with P1 on PASSER (ball at his feet at (0, 0)), teammates ahead, the rest parked deep. */
function live(seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: PASSER }], seed });
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === PASSER) continue;
    place(s, i, (i < 11 ? -22 : 22) + (i % 3), -25 + (i % 11) * 5);
  }
  place(s, PASSER, 0, 0);
  s.players[PASSER]!.ctrl = 0;
  skill(s, PASSER, 85);
  place(s, MATE_A, 16, 6);
  place(s, MATE_B, 14, -9);
  giveBall(s, PASSER);
  return s;
}

describe('QF-10 charged strikes (FIX-01: QF-4 CR charged strike)', () => {
  it('qf-10: a held PASS strikes releaseStrikeTicks after the release, the ball held on the kicking spot until then', () => {
    const s = live();
    let pressed = 0, releaseTick = -1, kickTick = -1, wasCharging = 0, spotD = -1, chargedAtRelease = 0;
    runTicks(s, 120, (_t, st, out) => {
      const f = out[0]!;
      f.mx = 120; f.mz = 45;
      if (st.ball.lastKickBy === PASSER) return;
      if (pressed === 0 && !(st.players[PASSER]!.act === ActionKind.NONE && st.ball.owner === PASSER)) return;
      if (pressed < 30) { f.buttons = Btn.PASS; pressed++; }
    }, {
      check: 'core',
      until: (st, tev) => {
        const p = st.players[PASSER]!;
        const c = p.act === ActionKind.KICK && p.actCharging === 1 ? 1 : 0;
        if (wasCharging === 1 && c === 0 && releaseTick < 0) { releaseTick = st.tick; chargedAtRelease = (p.actA & CHARGE_SEEN) === 0 ? 1 : 0; }
        wasCharging = c;
        for (const e of tev) if (e.type === EventType.KICK && e.a === PASSER) { kickTick = st.tick; spotD = fromSpot(p, e.x, e.z); }
        return kickTick > 0;
      },
    });
    expect(releaseTick).toBeGreaterThan(0);
    expect(chargedAtRelease).toBe(1); // the handler saw the release in that tick (CHARGE_SEEN cleared)
    expect(kickTick - releaseTick).toBe(T_PASS.releaseStrikeTicks);
    expect(spotD).toBeGreaterThanOrEqual(0);
    expect(spotD).toBeLessThan(KICK_TUNING.spotReach);
  });

  it('qf-10: a first-time charged kick of an arriving ball keeps its strike tick (no delay: the ball would run past)', () => {
    const s = quiet();
    const b = s.ball;
    b.owner = -1; b.x = 3.5; b.z = 0; b.px = b.x; b.pz = b.z; b.vx = -7; b.vz = 0; b.y = 0.11; b.vy = 0;
    expect(startPass(s, PASSER, KickKind.GROUND_PASS, req({ power: 0.4, charging: 1, targetSlot: MATE_A }), NULL_SINK)).toBe(1);
    const p = s.players[PASSER]!;
    const ev = createEventBuffer();
    let releaseT = -1, kickT = -1;
    for (let t = 1; t <= 40 && kickT < 0; t++) {
      s.tick++;
      ev.begin(s.tick);
      // The resolver's first-time release: the tick the ball is at his foot.
      if (p.actCharging === 1 && p.actT + 1 >= p.actContact && footCanStrike(s, PASSER, LT.reachRadius, LT.reachHeight)) {
        p.actCharging = 0;
        releaseT = t;
      }
      actionsTick(s, ev);
      for (let i = 0; i < ev.count; i++) if (ev.get(i).type === EventType.KICK) kickT = t;
      ballStepTick(s.ball, null);
    }
    expect(releaseT).toBeGreaterThan(0);
    expect(kickT).toBe(releaseT);
  });

  it('qf-10: a charged set-piece shot (dead ball) also strikes releaseStrikeTicks after the release', () => {
    const s = quiet();
    const b = s.ball;
    b.owner = -1; b.vx = 0; b.vz = 0; // a dead ball at his feet (set-piece style)
    expect(startShot(s, PASSER, KickKind.SHOT_NORMAL, { ...req({ power: 0.3, charging: 1 }) }, NULL_SINK)).toBe(1);
    const p = s.players[PASSER]!;
    const ev = createEventBuffer();
    const release = 20;
    let kickT = -1;
    for (let t = 1; t <= 60 && kickT < 0; t++) {
      s.tick++;
      ev.begin(s.tick);
      if (t === release) p.actCharging = 0;
      actionsTick(s, ev);
      for (let i = 0; i < ev.count; i++) if (ev.get(i).type === EventType.KICK) kickT = t;
    }
    expect(kickT).toBe(release + T_PASS.releaseStrikeTicks);
    expect(SHOT_LT.ownReachWaitTicks).toBeGreaterThan(0);
  });
});

/** Start a pass by PASSER now (his own ball) and step the full pipeline; the KICK and where the ball / he were. */
function passFromOwnBall(ballDx: number, ballDz: number): { kicked: boolean; bodyD: number; spotD: number; y: number; along: number } {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4 });
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === PASSER) continue;
    place(s, i, (i < 11 ? -30 : 30) + (i % 3), -25 + (i % 11) * 5);
  }
  for (let t = 0; t < 2; t++) s.teams[t]!.chaser = -1;
  for (let c = 0; c < s.ctrl.length; c++) s.ctrl[c]!.slot = -1;
  place(s, PASSER, 0, 0);
  place(s, MATE_A, 16, 4);
  giveBall(s, PASSER);
  const b = s.ball;
  b.x = ballDx; b.z = ballDz; b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0;
  expect(startPass(s, PASSER, KickKind.GROUND_PASS, req({ power: 0.5, targetSlot: MATE_A }), NULL_SINK)).toBe(1);
  let prev = cloneState(s);
  let out = { kicked: false, bodyD: -1, spotD: -1, y: -1, along: 0 };
  runTicks(s, 40, undefined, {
    until: (st, tev) => {
      for (const e of tev) {
        if (e.type !== EventType.KICK || e.a !== PASSER) continue;
        const q = prev.players[PASSER]!; // where he stood when the action stage played the ball
        const fl = Math.hypot(q.fx, q.fz) || 1;
        out = {
          kicked: true, bodyD: Math.hypot(e.x - q.x, e.z - q.z), spotD: fromSpot(q, e.x, e.z), y: e.y,
          along: ((e.x - q.x) * q.fx + (e.z - q.z) * q.fz) / fl,
        };
      }
      prev = cloneState(st);
      return out.kicked || st.players[PASSER]!.act === ActionKind.NONE;
    },
  });
  return out;
}

describe('QF-10 foot reach at contact (FIX-01: QF-1 CR kick reach)', () => {
  it('qf-10: his own ball pushed 2 m ahead is not passed from 2 m: the contact waits until SIM-06 has it on the kicking spot', () => {
    const r = passFromOwnBall(2.1, 0);
    expect(r.kicked).toBe(true);
    expect(r.bodyD).toBeLessThanOrEqual(LT.reachRadius);
    expect(r.spotD).toBeLessThanOrEqual(KICK_TUNING.spotReach + 1e-9);
  });

  it('qf-10: his own ball behind him is never kicked through his body', () => {
    for (const [dx, dz] of [[-0.7, 0], [-0.5, 0.4], [0.1, -0.9]] as const) {
      const r = passFromOwnBall(dx, dz);
      if (!r.kicked) continue; // a whiff is acceptable; a kick through the body is not
      expect(r.spotD).toBeLessThanOrEqual(KICK_TUNING.spotReach + 1e-9);
      expect(r.along).toBeGreaterThan(-0.45);
    }
  });

  it('qf-10: footCanStrike needs the ball low, near the body and near the kicking spot (also his own ball)', () => {
    const s = quiet();
    const p = s.players[PASSER]!; // at (0, 0) facing +x, owner of the ball
    const b = s.ball;
    const at = (x: number, z: number, y = 0.11): boolean => { b.x = x; b.z = z; b.y = y; return footCanStrike(s, PASSER, LT.reachRadius, LT.reachHeight); };
    expect(b.owner).toBe(PASSER);
    expect(at(0.5, 0)).toBe(true);
    expect(at(1.1, 0.3)).toBe(true);
    expect(at(1.9, 0)).toBe(false); // own ball a touch ahead: beyond reachRadius
    expect(at(-0.6, 0)).toBe(false); // behind him: beyond the kicking spot's reach
    expect(at(0.5, 0, 0.9)).toBe(false); // too high
    p.fx = 0; p.fz = 0; // no facing: the body distance decides
    expect(at(-0.6, 0)).toBe(true);
  });
});

describe('QF-10 dinked passes and long balls at bounceFriction 0.18 (FIX-14 follow-up)', () => {
  it('qf-10: dinked passes arrive within 0.6 m/s of the plan on a 1 m grid (6-45 m, five powers)', () => {
    let bad = 0, worst = 0;
    for (let D = 6; D <= 45; D += 1) {
      for (const power of [0, 0.25, 0.5, 0.75, 1]) {
        const s = quiet();
        skill(s, PASSER, 99);
        place(s, MATE_A, D, 0);
        const l = solve(s, KickKind.DINKED_PASS, { power, targetSlot: MATE_A })!;
        const plan = LT.dinkArriveMin + (LT.dinkArriveMax - LT.dinkArriveMin) * Math.max(power, LT.minPower);
        const b: BallState = createBallState();
        copyBallState(b, s.ball);
        b.vx = Math.hypot(l.vx, l.vz); b.vz = 0; b.vy = l.vy; b.owner = -1; b.grounded = 0;
        let at = -1;
        for (let i = 0; i < 600 && at < 0; i++) {
          ballStepTick(b, null);
          if (b.x >= D) at = Math.hypot(b.vx, b.vz);
        }
        const e = Math.abs(at - plan);
        if (e > 0.6) bad++;
        if (e > worst) worst = e;
      }
    }
    expect(bad).toBe(0);
    expect(worst).toBeLessThan(0.6);
  });

  it('qf-10: a long lob skips at most ~41 m after its first bounce (was 37-47 m at bounceFriction 0.12)', () => {
    expect(T_BALL.bounceFriction).toBeGreaterThanOrEqual(0.18);
    for (const [v, a] of [[20, 0.62], [25, 0.62], [28, 0.45], [30, 0.35]] as const) {
      const b = createBallState();
      b.x = -40; b.y = 0.11; b.vx = v * Math.cos(a); b.vy = v * Math.sin(a); b.owner = -1; b.heldBy = -1; b.grounded = 0;
      let first = -1;
      for (let i = 0; i < 1500; i++) {
        const n = b.bounces;
        ballStepTick(b, null);
        if (first < 0 && b.bounces > n) first = b.x;
        if (b.grounded === 1 && b.vx * b.vx < 0.01) break;
      }
      expect(first).toBeGreaterThan(-40);
      expect(b.x - first).toBeLessThan(41.5);
    }
  });
});
