/**
 * SIM-06 through the real tick pipeline (step): a human dribbling with the stick (SIM-15 intent -> SIM-04 -> SIM-06),
 * loose-ball pick-up with the team AI chasing, the glitch-list stuck-ball cases with body contact (SIM-05) in play,
 * bot-v-bot invariants and determinism.
 */
import '../../src/sim/actions/dispatch'; // load the action registry first (import-cycle order)
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { AXIS_SCALE, Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_DRIBBLE, T_FEEL } from '../../src/contracts/tuning';
import { hashState } from '../../src/sim/core/hash';
import { LOCAL_TUNING as L } from '../../src/sim/players/possession';
import { makeScenario, runTicks } from '../harness/scenario';

const P1 = 9;

/** IN_PLAY scene with P1 on slot 9 (auto switch off), the away CPU brain off, everyone else parked far away. */
function scene(seed: number, x: number, z: number, feet: boolean): SimState {
  const s = makeScenario({ seed, phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: P1, autoSwitch: AutoSwitch.OFF }] });
  const c3 = s.ctrl[3]!;
  if (c3.slot >= 0 && s.players[c3.slot]!.ctrl === 3) s.players[c3.slot]!.ctrl = -1;
  c3.kind = ControllerKind.NONE; c3.side = -1; c3.slot = -1;
  s.teams[1]!.cpu.active = 0;
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (i === P1) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1, k = i % 11;
    if (k === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; } else { p.x = team === 0 ? -44 : 44; p.z = -30 + k * 5.5; }
    p.vx = 0; p.vz = 0;
  }
  const p = s.players[P1]!;
  p.x = x; p.z = z; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
  if (feet) {
    Object.assign(s.ball, { x: x + 0.5, z, y: 0.11, px: x + 0.5, pz: z, py: 0.11, vx: 0, vy: 0, vz: 0, grounded: 1, owner: P1, heldBy: -1, lastTouch: P1, lastTouchTeam: 0 });
  }
  return s;
}

/** Switch both CPU brains off so the team AI (TAI-07 chaser) drives every player. */
function noCpuBrains(s: SimState): void {
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE; ctl.side = -1; ctl.slot = -1;
  }
  s.teams[0]!.cpu.active = 0;
  s.teams[1]!.cpu.active = 0;
}

describe('SIM-06 in the step pipeline: a human dribbling with the stick', () => {
  it('jog and sprint dribbles keep the ball; the sprint touch runs much further ahead', () => {
    const lead = [0, 0];
    for (const sprint of [0, 1]) {
      const s = scene(3, -25, 5, true);
      let lost = -1;
      const ev = runTicks(s, 300, (_t, _s, out) => { out[0]!.mx = AXIS_SCALE; out[0]!.buttons = sprint ? Btn.SPRINT : 0; }, {
        check: 'core',
        until: (st) => {
          // Lost by his own touches only: [INT-A] with the higher defensive lines the parked away defenders now step up
          // into his path near the end of the run, and a tackle there is not a dribble-mechanics failure.
          if (st.ball.owner !== P1 && lost < 0 && st.ball.lastTouchTeam !== 1) lost = st.tick;
          lead[sprint] = Math.max(lead[sprint]!, st.ball.x - st.players[P1]!.x);
          return false;
        },
      });
      expect(lost, `sprint ${sprint}`).toBe(-1);
      expect(ev.filter((e) => e.type === EventType.KICK && e.b === KickKind.DRIBBLE_TOUCH).length).toBeGreaterThan(sprint ? 2 : 10);
      expect(s.players[P1]!.x).toBeGreaterThan(sprint ? 5 : -5);
    }
    expect(lead[0]).toBeLessThan(1.3 * T_DRIBBLE.touchAheadJog);
    // [FEEL-1] (D-029) a human-controlled dribbler has close control: the sprint touch runs further ahead than the jog
    // touch, but about a stride (T_FEEL.humanTouchAheadSprint 1.45 m), not 2.4 m ahead (was lead[0] + 0.8).
    expect(lead[1]).toBeGreaterThan(lead[0]! + 0.25);
    expect(lead[1]).toBeLessThan(1.25 * T_FEEL.humanTouchAheadSprint);
  });

  it('a 90-degree turn and a stop at a jog keep the ball (stick only)', () => {
    const s = scene(4, -10, 0, true);
    runTicks(s, 360, (t, _s, out) => {
      if (t < 120) out[0]!.mx = AXIS_SCALE;
      else if (t < 240) out[0]!.mz = AXIS_SCALE;
    }, { check: 'core', until: (st) => { expect(st.ball.owner).toBe(P1); return false; } });
    const p = s.players[P1]!;
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(0.05);
    expect(Math.hypot(s.ball.x - p.x, s.ball.z - p.z)).toBeLessThan(T_DRIBBLE.controlRadius);
    expect(s.ball.z).toBeGreaterThan(3); // he went across with it
  });
});

describe('SIM-06 in the step pipeline: loose balls', () => {
  it('a slow ball rolling to a standing opponent is picked up by him (POSSESSION once, ball controlled)', () => {
    const s = scene(5, -30, 0, false);
    const o = s.players[15]!;
    o.x = 0; o.z = 0;
    Object.assign(s.ball, { x: -4, z: 0, px: -4, pz: 0, y: 0.11, vx: 5, vz: 0, vy: 0, owner: -1, heldBy: -1, lastTouch: 4, lastTouchTeam: 0 });
    const ev = runTicks(s, 90, undefined, { check: 'core' });
    expect(s.ball.owner).toBe(15);
    expect(ev.filter((e) => e.type === EventType.POSSESSION)).toEqual([expect.objectContaining({ a: 1, b: 15 })]);
    expect(Math.hypot(s.ball.x - o.x, s.ball.z - o.z)).toBeLessThan(T_DRIBBLE.loseRadius);
  });

  it('a loose ball in open play is collected by the team AI chaser (the pick-up closes the chase)', () => {
    for (const seed of [1, 2, 3]) {
      const s = makeScenario({ seed, phase: MatchPhase.IN_PLAY });
      noCpuBrains(s); // the team AI moves everyone (CPU brains would hold their player still until TAI-08 lands)
      Object.assign(s.ball, { x: 6, z: -8, px: 6, pz: -8, y: 0.11, vx: 1.5, vz: 0.5, vy: 0, owner: -1, heldBy: -1 });
      let got = -1;
      runTicks(s, 600, undefined, { check: 'core', until: (st) => { if (st.ball.owner >= 0) got = st.ball.owner; return got >= 0; } });
      expect(got, `seed ${seed}`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('SIM-06 glitch list through the pipeline (bodies in contact)', () => {
  it('glitch "Ball stuck: between two players" - two players pressing into a ball at rest between them: someone takes it', () => {
    for (const seed of [1, 2]) {
      const s = scene(seed, -30, 10, false);
      const a = s.players[7]!, b = s.players[16]!;
      a.x = -1; a.z = 0; b.x = 1; b.z = 0;
      Object.assign(s.ball, { x: 0, z: 0, px: 0, pz: 0, y: 0.11, vx: 0, vz: 0, vy: 0, owner: -1, heldBy: -1, idleT: 0 });
      runTicks(s, 30, undefined, { check: 'core' });
      expect([7, 16]).toContain(s.ball.owner);
    }
  });

  it('glitch "Ball stuck: between two players" - both down on it (fallen): it squirts out and play goes on', () => {
    const s = scene(2, -30, 10, false);
    noCpuBrains(s);
    const a = s.players[7]!, b = s.players[16]!;
    for (const [p, x] of [[a, -0.45], [b, 0.45]] as const) {
      p.x = x; p.z = 0; p.vx = 0; p.vz = 0; p.stunT = 100_000;
      p.act = ActionKind.FALLEN; p.actT = 0; p.actDur = 100_000; p.actContact = -1; p.moveMode = MoveMode.LOCKED;
    }
    Object.assign(s.ball, { x: 0, z: 0, px: 0, pz: 0, y: 0.11, vx: 0, vz: 0, vy: 0, owner: -1, heldBy: -1, idleT: 0, lastTouch: 7, lastTouchTeam: 0 });
    let movedAt = -1;
    runTicks(s, 400, undefined, {
      check: 'core',
      until: (st) => {
        if (movedAt < 0 && Math.hypot(st.ball.vx, st.ball.vz) > 0.5) movedAt = st.tick;
        return st.ball.owner >= 0;
      },
    });
    expect(movedAt).toBeGreaterThan(0);
    expect(movedAt).toBeLessThanOrEqual(L.stuckTicks + 5);
    expect(s.ball.owner).toBeGreaterThanOrEqual(0); // the chasers collect it once it is free
    expect([7, 16]).not.toContain(s.ball.owner);
  });

  it('glitch "Ball stuck: under a sliding player" - a slider lying on the ball does not freeze play', () => {
    for (const act of [ActionKind.SLIDE_TACKLE, ActionKind.FALLEN]) {
      const s = scene(3, -30, 10, false);
      noCpuBrains(s);
      const slider = s.players[16]!;
      slider.x = 0; slider.z = 0; slider.fx = 1; slider.fz = 0;
      slider.act = act; slider.actT = 0; slider.actDur = 100_000; slider.actContact = -1; slider.moveMode = MoveMode.LOCKED;
      slider.stunT = act === ActionKind.FALLEN ? 100_000 : 0;
      Object.assign(s.ball, { x: 0.05, z: 0.02, px: 0.05, pz: 0.02, y: 0.11, vx: 0, vz: 0, vy: 0, owner: -1, heldBy: -1, idleT: 0, lastTouch: 16, lastTouchTeam: 1 });
      const ev: SimEvent[] = runTicks(s, 900, undefined, { check: 'core', until: (st) => st.ball.owner >= 0 });
      expect(s.ball.owner, ActionKind[act]).toBeGreaterThanOrEqual(0);
      expect(s.ball.owner).not.toBe(16);
      expect(ev.filter((e) => e.type === EventType.WATCHDOG)).toHaveLength(0);
    }
  });
});

describe('SIM-06 bot v bot', () => {
  it('core invariants hold; a loose slow ball near bodies never sits untouched past the squirt time; deterministic', () => {
    const run = (seed: number): number => {
      const s = makeScenario({ seed, phase: MatchPhase.KICK_OFF });
      runTicks(s, 2400, undefined, {
        check: 'core',
        until: (st) => {
          const b = st.ball;
          if (st.match.phase === MatchPhase.IN_PLAY && b.owner < 0 && b.heldBy < 0 && b.y <= T_DRIBBLE.controlHeight &&
            Math.hypot(b.vx, b.vz) < L.stuckSpeed) {
            let near = false;
            for (let i = 0; i < NUM_SLOTS; i++) {
              const p = st.players[i]!;
              if (p.active === 1 && Math.hypot(p.x - b.x, p.z - b.z) < L.stuckRadius) near = true;
            }
            if (near) expect(b.idleT, `seed ${seed} tick ${st.tick}`).toBeLessThanOrEqual(L.stuckTicks + 1);
          }
          return false;
        },
      });
      return hashState(s);
    };
    for (const seed of [1, 7]) expect(run(seed)).toBe(run(seed));
  });
});
