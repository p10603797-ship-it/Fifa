/**
 * RUL-02 throw-ins in the complete pipeline: real team AI (shape, support, chasers, set-piece positions), CPU brains,
 * switching, contacts, rules and the watchdog, with every invariant checked each tick. Balls are sent over a
 * touchline from open play at different places, by either team, on both touchlines, across seeds: the right team
 * throws, its CPU (or human) completes the throw-in without a watchdog intervention, play resumes and the thrower is
 * back on the pitch.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, DT, HALF_LENGTH, HALF_WIDTH, teamFirstSlot } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createBallState, type SimState } from '../../src/contracts/state';
import { ballAirStep } from '../../src/sim/ball/flight';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { BALL_OUT_Z } from '../../src/sim/pitch/geometry';
import { LOCAL_TUNING as RUL11_TUNING } from '../../src/sim/rules/restart';
import { LOCAL_TUNING } from '../../src/sim/rules/throwin';
import { step } from '../../src/sim/step';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';

type Inputs = (tick: number, s: SimState, out: InputFrame[]) => void;

function run(s: SimState, n: number, inputs?: Inputs, until?: (s: SimState, ev: readonly SimEvent[]) => boolean): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker('all');
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    for (const f of frames) Object.assign(f, createInputFrame());
    inputs?.(s.tick + 1, s, frames);
    step(s, frames, events);
    const tickEv = events.toArray();
    all.push(...tickEv);
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until?.(s, tickEv)) break;
  }
  return all;
}

/** First landing of the ball as it flies now if nobody touches it (SIM-01 air physics). */
function untouchedLanding(s: SimState): { x: number; z: number } {
  const b = createBallState();
  const o = s.ball;
  b.x = o.x; b.y = o.y; b.z = o.z; b.vx = o.vx; b.vy = o.vy; b.vz = o.vz; b.sx = o.sx; b.sy = o.sy; b.sz = o.sz;
  for (let i = 0; i < 600; i++) {
    const px = b.x, py = b.y, pz = b.z;
    ballAirStep(b, DT);
    if (b.y <= BALL_RADIUS && b.vy < 0) {
      const f = (py - BALL_RADIUS) / (py - b.y);
      return { x: px + (b.x - px) * f, z: pz + (b.z - pz) * f };
    }
  }
  return { x: b.x, z: b.z };
}

const ofType = (ev: readonly SimEvent[], t: EventType): SimEvent[] => ev.filter((e) => e.type === t);

/** Open play, then the ball rolls over the touchline at (x, side) off a player of `lastTeam`. */
function outOverTouchline(seed: number, x: number, side: number, lastTeam: number, humans: ScenarioHuman[] = []): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans });
  run(s, 30); // let the team AI settle
  const b = s.ball;
  b.owner = -1; b.heldBy = -1;
  b.x = x; b.y = BALL_RADIUS; b.z = side * (HALF_WIDTH - 0.4);
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = 0; b.vy = 0; b.vz = side * 5; b.grounded = 1;
  const toucher = teamFirstSlot(lastTeam) + 6;
  b.lastTouch = toucher; b.lastTouchTeam = lastTeam; b.lastTouchTick = s.tick;
  b.lastKickBy = toucher; b.lastKickTeam = lastTeam; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = s.tick;
  return s;
}

describe('RUL-02 throw-ins in the complete pipeline', () => {
  const cases: [number, number, number, number][] = [
    // seed, x, side, last touch team
    [1, -30, 1, 0], [2, 0, -1, 1], [3, 25, 1, 1], [4, 48, -1, 0], [5, -51, 1, 1], [6, 12, -1, 0],
  ];
  for (const [seed, x, side, lastTeam] of cases) {
    it(`bot v bot, seed ${seed}: out at x=${x} on the ${side > 0 ? 'near' : 'far'} touchline off team ${lastTeam} -> team ${1 - lastTeam} throws, play resumes`, () => {
      const s = outOverTouchline(seed, x, side, lastTeam);
      const team = 1 - lastTeam;
      const ev = run(s, 400, undefined, (st, e) => e.some((k) => k.type === EventType.KICK && k.b === KickKind.THROW_IN));
      const awards = ofType(ev, EventType.RESTART_AWARDED);
      expect(awards).toHaveLength(1);
      expect([awards[0]!.a, awards[0]!.b]).toEqual([RestartKind.THROW_IN, team]);
      const kicks = ev.filter((k) => k.type === EventType.KICK && k.b === KickKind.THROW_IN);
      expect(kicks).toHaveLength(1);
      const t = kicks[0]!.a;
      expect(t).toBe(s.match.restart.taker);
      expect(s.players[t]!.team).toBe(team);
      expect(s.players[t]!.isKeeper).toBe(0);
      // Taken by the CPU side (its brain's own input or RUL-02's CPU fallback) before RUL-11's CPU timeout.
      expect(kicks[0]!.tick - awards[0]!.tick).toBeLessThan(T_RULES.restartSetupTicks + RUL11_TUNING.cpuTakeTimeoutTicks);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(Math.abs(s.ball.z)).toBeLessThanOrEqual(BALL_OUT_Z);
      // Thrown to a teammate, or (a CPU long throw into space) to a point inside the pitch.
      const q = s.ball.passTarget;
      if (q >= 0) {
        expect(s.players[q]!.team).toBe(team);
        expect(s.players[q]!.isKeeper).toBe(0);
      }
      expect(Math.abs(s.ball.passX)).toBeLessThan(HALF_LENGTH);
      expect(Math.abs(s.ball.passZ)).toBeLessThan(HALF_WIDTH);
      // Play goes on: no watchdog, the thrower is back on the pitch and free.
      const after = run(s, 90);
      expect(ofType(ev, EventType.WATCHDOG)).toHaveLength(0);
      expect(ofType(after, EventType.WATCHDOG)).toHaveLength(0);
      const p = s.players[t]!;
      expect(Math.abs(p.z)).toBeLessThan(HALF_WIDTH);
      expect(p.act === ActionKind.THROW_IN).toBe(false);
    });
  }

  it('a human throw-in with the real team AI: PASS throws to a teammate, the ball comes down at the throw\'s target', () => {
    const s = outOverTouchline(7, 5, 1, 1, [{ side: 0 }]);
    let ready = -1;
    let landed = false;
    let land = { x: NaN, z: NaN };
    let kickTick = -1;
    let target = { x: NaN, z: NaN, slot: -1 };
    let firstTouch = { slot: -1, dist: NaN };
    let predicted = { x: NaN, z: NaN };
    run(s, 600, (tick, st, out) => {
      if (ready < 0 && st.match.phase === MatchPhase.THROW_IN && st.match.restart.ready === 1) ready = tick;
      if (ready > 0 && tick === ready + 10) out[0]!.buttons = Btn.PASS;
    }, (st, e) => {
      if (kickTick < 0 && e.some((k) => k.type === EventType.KICK && k.b === KickKind.THROW_IN)) {
        kickTick = st.tick;
        target = { x: st.ball.passX, z: st.ball.passZ, slot: st.ball.passTarget };
        predicted = untouchedLanding(st);
        return false;
      }
      if (kickTick > 0 && st.ball.lastTouchTick > kickTick) { // played before it landed
        const p = st.players[st.ball.lastTouch]!;
        firstTouch = { slot: st.ball.lastTouch, dist: Math.hypot(p.x - target.x, p.z - target.z) };
        return true;
      }
      if (kickTick > 0 && (st.ball.bounces > 0 || st.ball.grounded === 1)) {
        landed = true;
        land = { x: st.ball.x, z: st.ball.z };
        return true;
      }
      return false;
    });
    expect(kickTick).toBeGreaterThan(0);
    expect(kickTick - ready).toBe(10 + LOCAL_TUNING.windupTicks - 1);
    expect(target.slot).toBeGreaterThanOrEqual(0); // the best teammate within throwing range
    expect(s.players[target.slot]!.team).toBe(0);
    // The throw comes down on its target (exact flight from the release, whoever plays it first).
    expect(Math.hypot(predicted.x - target.x, predicted.z - target.z)).toBeLessThan(1.0);
    if (landed) expect(Math.hypot(land.x - target.x, land.z - target.z)).toBeLessThan(1.0);
    else expect(firstTouch.slot).toBeGreaterThanOrEqual(0); // played in the air first (received or intercepted)
  });
});
