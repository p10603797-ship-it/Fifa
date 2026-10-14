/**
 * [QF-1 skeptic] A pass that dies short of its receiver. ball.passTarget used to stay set until somebody took the
 * ball, so "our pass in flight" lasted forever: SIM-16 kept the user locked on the receiver (no manual switch) and
 * TAI-07's receiver claim kept every AI teammate off the ball, also the one standing next to it (fuzz seed 919 #14:
 * a weak pass stopped 17 m from a receiver steered elsewhere, BALL_UNTOUCHED 8 s later). sim/step now ends a pass
 * whose ball has lain T_RULES.passDeadTicks while the receiver is not closing in on it.
 */
import { describe, expect, it } from 'vitest';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { canManualSwitch } from '../../src/sim/control/switching';
import { fuzzJobs } from '../../tools/fuzz';
import { runJob } from '../../tools/lib/jobs';
import { findEvents, makeScenario, runTicks, type ScenarioInputs } from '../harness/scenario';

/** Team 0 (human on slot 3) has just played a pass to slot 3 that stopped at (bx, bz); team 1 is far upfield. */
function deadPass(receiver: { x: number; z: number }, mate: { x: number; z: number } | null, seed = 7): SimState {
  const bx = -20, bz = 4;
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, humans: [{ side: 0, slot: 3 }], match: { periodT: 1200 },
    ball: {
      x: bx, y: 0.11, z: bz, vx: 0, vy: 0, vz: 0, owner: -1, heldBy: -1, lastTouch: 7, lastTouchTeam: 0, lastTouchTick: 0,
      lastKickBy: 7, lastKickTeam: 0, lastKickKind: KickKind.GROUND_PASS, lastKickTick: 0, passTarget: 3,
      passX: receiver.x, passZ: receiver.z, idleT: 0,
    },
  });
  // Everyone else well away from the ball: team 0 behind the play, team 1 deep in its own half.
  for (let i = 1; i < 11; i++) { const p = s.players[i]!; p.x = -38 + (i % 3); p.z = -30 + i * 5; p.vx = 0; p.vz = 0; }
  for (let i = 11; i < 22; i++) { const p = s.players[i]!; p.x = 32 + (i % 4) * 2; p.z = -25 + (i - 11) * 5; p.vx = 0; p.vz = 0; }
  const r = s.players[3]!; r.x = receiver.x; r.z = receiver.z;
  if (mate) { const m = s.players[2]!; m.x = mate.x; m.z = mate.z; }
  s.players[7]!.lastTouchTick = 0;
  return s;
}

/** The user steers his receiver along the touchline, away from the ball. */
const steerAway: ScenarioInputs = (_t, _s, out) => { out[0]!.mx = 0; out[0]!.mz = 127; };

describe('QF-1 skeptic: a pass that died short of its receiver', { timeout: 600_000 }, () => {
  it('glitch two teammates chase or nobody does — a dead pass 17 m from a receiver steered elsewhere is played by the teammate 4 m from it (no watchdog)', () => {
    for (const seed of [7, 8, 9]) {
      const s = deadPass({ x: -20, z: 21 }, { x: -20, z: 0 }, seed);
      let clearedAt = -1;
      const start = s.tick;
      const ev = runTicks(s, 360, steerAway, {
        check: 'core',
        until: (st) => {
          if (clearedAt < 0 && st.ball.passTarget === -1) clearedAt = st.tick - start;
          return st.ball.lastTouchTick > start;
        },
      });
      expect(findEvents(ev, EventType.WATCHDOG), `seed ${seed}`).toEqual([]);
      expect(s.ball.lastTouchTick, `seed ${seed}: nobody played the dead pass`).toBeGreaterThan(start);
      expect(s.ball.lastTouch).not.toBe(3);
      expect(s.players[s.ball.lastTouch]!.team).toBe(0);
      expect(clearedAt).toBeGreaterThanOrEqual(T_RULES.passDeadTicks);
      expect(clearedAt).toBeLessThanOrEqual(T_RULES.passDeadTicks + 2);
    }
  });

  it('once the pass is dead the user may switch away from the receiver (manual switch available again)', () => {
    const s = deadPass({ x: -20, z: 21 }, { x: -20, z: 0 });
    runTicks(s, 2, steerAway);
    expect(s.ball.passTarget).toBe(3);
    expect(canManualSwitch(s, 0)).toBe(false); // our pass in flight: attack context
    runTicks(s, T_RULES.passDeadTicks, steerAway);
    expect(s.ball.passTarget).toBe(-1);
    if (s.ball.owner < 0) expect(canManualSwitch(s, 0)).toBe(true);
  });

  it('a receiver walking onto a pass that stopped short keeps it and collects it (idle stick: the meet run)', () => {
    const s = deadPass({ x: -20, z: 12 }, null);
    let lostAt = -1;
    runTicks(s, 300, undefined, {
      check: 'core',
      until: (st) => {
        if (lostAt < 0 && st.ball.passTarget === -1 && st.ball.owner < 0) lostAt = st.tick;
        return st.ball.owner >= 0;
      },
    });
    expect(lostAt).toBe(-1);
    expect(s.ball.owner).toBe(3);
  });

  it('fuzz seed 919 #14 (p1-vs-p2, skipSpam / idle): no BALL_UNTOUCHED watchdog', () => {
    const [job] = fuzzJobs({
      matches: 1, workers: 1, seed: 919, enforce: 'all', halfMinutes: 2, json: null, maxReplays: 0, only: 14, quiet: true,
      jobTimeoutSeconds: null,
    });
    const r = runJob(job!, { replayDir: '', replayPrefix: 'qf-1-skeptic', replayBudget: () => false });
    expect(r.watchdogReasons).toEqual({});
    expect(r.reasons).toEqual([]);
  });
});

describe('QF-1 skeptic: a ball a player keeps still at his feet is not lying untouched', { timeout: 600_000 }, () => {
  it('glitch ball stuck between two players — an owner who stood 9 s with the ball still at his feet and is then knocked down leaves a loose ball, not an instant BALL_UNTOUCHED', () => {
    for (const lead of [0.8, 0.88]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4, humans: [{ side: 0, slot: 9 }], match: { periodT: 1000 } });
      for (let i = 0; i < 22; i++) {
        const q = s.players[i]!;
        q.x = i < 11 ? -45 + (i % 11) : 48 - (i % 11) * 0.3; q.z = -25 + (i % 11) * 5; q.vx = 0; q.vz = 0;
      }
      const p = s.players[9]!; p.x = -30; p.z = 20; p.fx = 1; p.fz = 0;
      // He holds the ball still at the edge of his reach (a standing owner leaves a ball at rest at his feet alone).
      const b = s.ball;
      b.x = p.x + lead; b.y = 0.11; b.z = p.z; b.px = b.x; b.py = b.y; b.pz = b.z; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
      b.owner = 9; b.ownerT = 0; b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = 0; b.idleT = 0;
      const held = runTicks(s, 540, undefined, { check: 'core', until: (st) => st.ball.owner !== 9 });
      expect(s.ball.owner, `lead ${lead}: still his`).toBe(9);
      expect(findEvents(held, EventType.WATCHDOG)).toEqual([]);
      expect(s.ball.idleT, 'an owned ball does not age').toBe(0);
      p.stunT = 40; // knocked down (a foul or a shove that does not touch the ball): possession is released
      const after = runTicks(s, 30, undefined, { check: 'core' });
      expect(findEvents(after, EventType.WATCHDOG), `lead ${lead}`).toEqual([]);
    }
  });
});

describe('QF-1 skeptic: a lying loose ball near a user who has let go of the stick', { timeout: 600_000 }, () => {
  /** Team 0's user (slot 4, stick released) 10.9 m from a still ball, an AI teammate 11 m from it, team 1 far away. */
  function idleUser(): SimState {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 12, humans: [{ side: 0, slot: 4 }], match: { periodT: 1500 } });
    for (let i = 0; i < 22; i++) {
      const p = s.players[i]!;
      p.x = i < 11 ? -40 + (i % 11) : 45 - (i % 11) * 0.5; p.z = -28 + (i % 11) * 5; p.vx = 0; p.vz = 0;
    }
    const b = s.ball;
    b.x = 10; b.y = 0.11; b.z = 0; b.px = b.x; b.py = b.y; b.pz = b.z; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
    b.owner = -1; b.heldBy = -1; b.lastTouch = 17; b.lastTouchTeam = 1; b.lastTouchTick = 0; b.idleT = 0; b.passTarget = -1;
    const me = s.players[4]!; me.x = 10 - 10.9; me.z = 0;
    const mate = s.players[3]!; mate.x = 10; mate.z = 11;
    return s;
  }

  it('glitch two teammates chase or nobody does — the controlled chaser of an idle user walks to a ball lying loose (team 0 plays it first, no watchdog)', () => {
    const s = idleUser();
    const start = s.tick;
    const ev = runTicks(s, 240, undefined, { check: 'core', until: (st) => st.ball.lastTouchTick > start });
    expect(findEvents(ev, EventType.WATCHDOG)).toEqual([]);
    expect(s.ball.lastTouchTick).toBeGreaterThan(start);
    expect(s.ball.lastTouchTeam).toBe(0);
  });

  it('a user holding the stick keeps his player: no walk to the ball while he steers elsewhere', () => {
    const s = idleUser();
    runTicks(s, 150, steerAway);
    const c = s.ctrl[0]!.slot;
    const p = s.players[c]!;
    // He runs where the stick says (+z), not at the ball.
    expect(p.vz).toBeGreaterThan(1);
  });

  it('fuzz seed 2027 #78 (p1-vs-p2, neutral / mash, cup): no BALL_UNTOUCHED watchdog', () => {
    const [job] = fuzzJobs({
      matches: 1, workers: 1, seed: 2027, enforce: 'all', halfMinutes: 2, json: null, maxReplays: 0, only: 78, quiet: true,
      jobTimeoutSeconds: null,
    });
    const r = runJob(job!, { replayDir: '', replayPrefix: 'qf-1-skeptic', replayBudget: () => false });
    expect(r.watchdogReasons).toEqual({});
    expect(r.reasons).toEqual([]);
  });
});
