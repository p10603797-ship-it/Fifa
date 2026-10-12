/**
 * TAI-07: arrival steering (executeJobs, arrive). Intent-level unit tests plus closed-loop tests that run the
 * real SIM-04 locomotion (and SIM-05 bodies) on the intents. Glitch regressions:
 * "Players: orbit or jitter around a target", "Players: run in place against each other".
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { BOARD_X, BOARD_Z, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { ActionKind, AiJob, MatchPhase } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { assignJob, resetJobs } from '../../src/ai/jobs';
import { arrive, executeJobs, isMovementLocked, STEER_TUNING } from '../../src/ai/steer';
import { locomotionTick } from '../../src/sim/players/locomotion';
import { bodyContactTick } from '../../src/sim/players/bodies';
import { makeScenario } from '../harness/scenario';

const ev: EventSink = { emit() { /* discard */ } };
const LT = STEER_TUNING;

/** IN_PLAY state with the ball owned by a far-away keeper (no chaser logic involved) and everyone parked. */
function steerState(): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, z: 30 } });
  for (let t = 0; t < 2; t++) {
    for (let k = 1; k < PLAYERS_PER_TEAM; k++) {
      const p = s.players[teamFirstSlot(t) + k]!;
      p.x = t === 0 ? -50 : 50; p.z = -30 + 6 * (k - 1);
      p.vx = 0; p.vz = 0; p.fx = t === 0 ? 1 : -1; p.fz = 0;
      p.homeX = p.x; p.homeZ = p.z;
    }
  }
  return s;
}

function put(s: SimState, slot: number, x: number, z: number, vx = 0, vz = 0): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = vx; p.vz = vz; p.homeX = x; p.homeZ = z;
  const l = Math.sqrt(vx * vx + vz * vz);
  if (l > 0) { p.fx = vx / l; p.fz = vz / l; }
}

/**
 * Closed loop: per tick reset jobs, let `jobs` assign the jobs under test, executeJobs, then SIM-04 locomotion and
 * SIM-05 bodies. `each` observes the state after the tick.
 */
function run(s: SimState, ticks: number, jobs: (k: number) => void, each?: (k: number) => void): void {
  for (let k = 0; k < ticks; k++) {
    s.tick++;
    resetJobs(s, 0);
    resetJobs(s, 1);
    jobs(k);
    executeJobs(s, 0, ev);
    executeJobs(s, 1, ev);
    locomotionTick(s, ev);
    bodyContactTick(s, ev);
    if (each) each(k);
  }
}

const speedOf = (s: SimState, slot: number): number => Math.hypot(s.players[slot]!.vx, s.players[slot]!.vz);

describe('TAI-07 executeJobs: intents', () => {
  it('turns the final job into an ARRIVE intent with the job target and speed cap, and counts jobT', () => {
    const s = steerState();
    put(s, 5, -20, 0);
    const top = s.attrs[5]!.topSpeed;
    for (let k = 0; k < 3; k++) {
      s.tick++;
      resetJobs(s, 0);
      assignJob(s, 5, AiJob.SUPPORT, -10, 4, top * 0.5, -1);
      executeJobs(s, 0, ev);
    }
    const p = s.players[5]!;
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.tgtX).toBe(-10);
    expect(p.tgtZ).toBe(4);
    expect(p.tgtSpeed).toBeCloseTo(top * 0.5, 9);
    expect(p.wantSprint).toBe(0);
    expect(p.lookAt).toBe(0); // far from the spot: run facing forward
    expect(p.jobT).toBe(2);
    expect(p.lookX).toBe(s.ball.x);
    expect(p.lookZ).toBe(s.ball.z);
  });

  it('leaves players whose action locks movement alone (LOCKED or a non-moving action), but still counts jobT', () => {
    const s = steerState();
    put(s, 5, -20, 0);
    const p = s.players[5]!;
    Object.assign(p, { act: ActionKind.KICK, actT: 1, actDur: 20, moveMode: MoveMode.LOCKED, tgtX: 7, tgtZ: 7 });
    expect(isMovementLocked(p)).toBe(true);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.SUPPORT, -10, 4, 5, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.LOCKED);
    const jt = p.jobT;
    // A non-moving action that has not set LOCKED is respected too.
    Object.assign(p, { act: ActionKind.SLIDE_TACKLE, moveMode: MoveMode.DIRECT });
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.SUPPORT, -10, 4, 5, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.DIRECT);
    expect(p.jobT).toBe(jt + 1);
    // Moving actions (shield, stumble, first touch) still get steering.
    for (const a of [ActionKind.SHIELD, ActionKind.STUMBLE, ActionKind.FIRST_TOUCH, ActionKind.NONE]) {
      Object.assign(p, { act: a, moveMode: MoveMode.STOP });
      expect(isMovementLocked(p)).toBe(false);
      s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.SUPPORT, -10, 4, 5, -1); executeJobs(s, 0, ev);
      expect(p.moveMode).toBe(MoveMode.ARRIVE);
    }
  });

  it('never touches controlled players or keepers', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 7 }] });
    const p7 = s.players[7]!;
    const k = s.players[0]!;
    p7.moveMode = MoveMode.DIRECT; p7.ix = 0.5;
    k.moveMode = MoveMode.STOP;
    s.tick++; resetJobs(s, 0); executeJobs(s, 0, ev);
    expect(p7.moveMode).toBe(MoveMode.DIRECT);
    expect(p7.ix).toBe(0.5);
    expect(k.moveMode).toBe(MoveMode.STOP);
  });

  it('sprints for urgent jobs beyond sprintDistUrgent and calm jobs (above jog) beyond sprintDistCalm, with hysteresis', () => {
    const s = steerState();
    const top = s.attrs[5]!.topSpeed;
    const jog = top * T_PLAYER.jogFraction;
    const p = s.players[5]!;
    const at = (job: AiJob, d: number, speed: number): void => {
      put(s, 5, -d, 0);
      s.tick++; resetJobs(s, 0); assignJob(s, 5, job, 0, 0, speed, -1); executeJobs(s, 0, ev);
    };
    p.wantSprint = 0;
    at(AiJob.PRESS, LT.sprintDistUrgent + 1, top);
    expect(p.wantSprint).toBe(1);
    expect(p.tgtSpeed).toBeCloseTo(top, 9);
    at(AiJob.PRESS, LT.sprintDistUrgent * 0.75, top); // inside, but above half: keeps sprinting
    expect(p.wantSprint).toBe(1);
    at(AiJob.PRESS, LT.sprintDistUrgent * 0.4, top);
    expect(p.wantSprint).toBe(0);
    at(AiJob.PRESS, LT.sprintDistUrgent * 0.75, top); // not sprinting: does not restart inside the threshold
    expect(p.wantSprint).toBe(0);
    expect(p.tgtSpeed).toBeCloseTo(top, 9); // urgent jobs keep their cap (arrival braking slows them)
    // Urgent job asking for jog speed or less: never sprints.
    at(AiJob.RECOVER, 30, jog);
    expect(p.wantSprint).toBe(0);
    // Calm job above jog (e.g. a called supporter): sprint flag only further away; the cap is always honoured.
    at(AiJob.SUPPORT, LT.sprintDistCalm + 2, top * 0.9);
    expect(p.wantSprint).toBe(1);
    expect(p.tgtSpeed).toBeCloseTo(top * 0.9, 9);
    at(AiJob.SUPPORT, LT.sprintDistCalm * 0.4, top * 0.9);
    expect(p.wantSprint).toBe(0);
    expect(p.tgtSpeed).toBeCloseTo(top * 0.9, 9);
    at(AiJob.HOLD_SHAPE, 30, jog);
    expect(p.wantSprint).toBe(0);
    expect(p.tgtSpeed).toBeCloseTo(jog, 9);
    // A cap above top speed is clamped; a NaN cap falls back to jog.
    at(AiJob.CHASE_LOOSE, 20, top * 3);
    expect(p.tgtSpeed).toBeCloseTo(top, 9);
    at(AiJob.SUPPORT, 20, Number.NaN);
    expect(p.tgtSpeed).toBeCloseTo(jog, 9);
  });

  it('dead zone: a player at rest near a positional target holds (STOP) facing the ball; a moving one keeps arriving', () => {
    const s = steerState();
    const p = s.players[5]!;
    put(s, 5, 0.3, 0);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.HOLD_SHAPE, 0, 0, 5, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.STOP);
    expect(p.lookAt).toBe(1);
    expect(p.wantSprint).toBe(0);
    // Moving in (even slowly): keep arriving so the player finishes the move instead of stopping short.
    put(s, 5, 0.3, 0, -0.3, 0);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.HOLD_SHAPE, 0, 0, 5, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    // Outside the dead zone at rest: arrive.
    put(s, 5, LT.deadZone + 0.1, 0);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.HOLD_SHAPE, 0, 0, 5, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.lookAt).toBe(1); // close to the spot: faces play
    // Ball jobs never hold in the dead zone.
    put(s, 5, 0.3, 0);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.CHASE_LOOSE, 0, 0, 8, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
  });

  it('set-piece positions are exact: no dead zone or occupied-spot hold, and the player settles still on the spot', () => {
    const s = steerState();
    const p = s.players[5]!;
    put(s, 5, 0.3, 0);
    put(s, 15, 0.6, 0.3); // someone right next to the spot
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.SET_PIECE, 0, 0, 5, -1); executeJobs(s, 0, ev);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    put(s, 15, 50, 0);
    put(s, 5, -7, 2);
    let late = 0;
    run(s, 480, () => { assignJob(s, 5, AiJob.SET_PIECE, 0, 0, 5, -1); }, (k) => { if (k >= 300) late = Math.max(late, speedOf(s, 5)); });
    expect(Math.hypot(p.x, p.z)).toBeLessThan(T_PLAYER.arriveStop);
    expect(late).toBeLessThan(0.01);
  });

  it('sanitises targets: clamped inside the boards, a NaN target holds the current position', () => {
    const s = steerState();
    const p = s.players[5]!;
    put(s, 5, 10, 0);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.SUPPORT, 500, -500, 5, -1); executeJobs(s, 0, ev);
    expect(p.tgtX).toBeLessThan(BOARD_X);
    expect(p.tgtZ).toBeGreaterThan(-BOARD_Z);
    s.tick++; resetJobs(s, 0); assignJob(s, 5, AiJob.SUPPORT, Number.NaN, Number.NaN, 5, -1); executeJobs(s, 0, ev);
    expect(p.tgtX).toBe(10);
    expect(p.tgtZ).toBe(0);
    expect(p.moveMode).toBe(MoveMode.STOP);
  });
});

describe('TAI-07 arrive()', () => {
  it('writes a plain ARRIVE intent, clamps target and speed, sprints above jog and faces the ball when close', () => {
    const s = steerState();
    const p = s.players[3]!;
    put(s, 3, 0, 28);
    const top = s.attrs[3]!.topSpeed;
    arrive(s, 3, 0.5, 29, 3);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.tgtX).toBe(0.5);
    expect(p.tgtZ).toBe(29);
    expect(p.tgtSpeed).toBe(3);
    expect(p.wantSprint).toBe(0);
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBe(s.ball.x);
    arrive(s, 3, -40, 999, 99);
    expect(p.tgtZ).toBeLessThan(BOARD_Z);
    expect(p.tgtSpeed).toBeCloseTo(top, 9);
    expect(p.wantSprint).toBe(1);
    expect(p.lookAt).toBe(0);
    arrive(s, 3, 1, 1, -4);
    expect(p.tgtSpeed).toBe(0);
    // No dead zone: a keeper-style fine adjustment still arrives.
    arrive(s, 3, 0.1, 28, 2);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
  });

  it('is a no-op for an inactive player, a locked player and a bad slot', () => {
    const s = steerState();
    const p = s.players[3]!;
    Object.assign(p, { act: ActionKind.GK_DIVE, moveMode: MoveMode.LOCKED, tgtX: 1, tgtZ: 2 });
    arrive(s, 3, 9, 9, 4);
    expect(p.moveMode).toBe(MoveMode.LOCKED);
    expect(p.tgtX).toBe(1);
    Object.assign(p, { act: ActionKind.NONE, moveMode: MoveMode.STOP, active: 0 });
    arrive(s, 3, 9, 9, 4);
    expect(p.moveMode).toBe(MoveMode.STOP);
    expect(() => arrive(s, -1, 0, 0, 1)).not.toThrow();
    expect(() => arrive(s, NUM_SLOTS, 0, 0, 1)).not.toThrow();
    // Keeper rush is a moving action: arrive() steers him.
    const k = s.players[0]!;
    Object.assign(k, { act: ActionKind.GK_RUSH, moveMode: MoveMode.STOP });
    arrive(s, 0, k.x + 5, k.z, 7);
    expect(k.moveMode).toBe(MoveMode.ARRIVE);
  });
});

/** Signed angle change from (ax, az) to (bx, bz), radians (test-side only). */
function dAngle(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(ax * bz - az * bx, ax * bx + az * bz);
}

describe('TAI-07 glitch: Players: orbit or jitter around a target', () => {
  const starts: { name: string; x: number; z: number; vx: number; vz: number; job: AiJob; speedMul: number }[] = [];
  for (const d of [1.2, 3, 8, 20]) {
    starts.push({ name: `at rest ${d} m`, x: -d, z: 0, vx: 0, vz: 0, job: AiJob.HOLD_SHAPE, speedMul: 0.6 });
    starts.push({ name: `sprinting past ${d} m`, x: -d, z: 0.8, vx: 0, vz: 8, job: AiJob.RECOVER, speedMul: 1 });
    starts.push({ name: `running in ${d} m`, x: -d, z: 0, vx: 7, vz: 0, job: AiJob.MARK, speedMul: 0.85 });
    starts.push({ name: `running away ${d} m`, x: d * 0.7, z: d * 0.7, vx: 5, vz: 5, job: AiJob.COVER, speedMul: 0.7 });
  }
  for (const c of starts) {
    it(`stops on the spot without orbiting or jittering: ${c.name}`, () => {
      const s = steerState();
      const tx = 0, tz = 0;
      put(s, 5, c.x, c.z, c.vx, c.vz);
      const top = s.attrs[5]!.topSpeed;
      const p = s.players[5]!;
      let sweep = 0;
      let prevRx = p.x - tx, prevRz = p.z - tz;
      let near = false;
      let lateTravel = 0;
      let lastX = p.x, lastZ = p.z;
      let modeFlips = 0;
      let lastMode = -1;
      run(s, 600, () => { assignJob(s, 5, c.job, tx, tz, top * c.speedMul, -1); }, (k) => {
        const rx = p.x - tx, rz = p.z - tz;
        const d = Math.hypot(rx, rz);
        if (d < 3) near = true;
        if (near && d > 0.3 && Math.hypot(prevRx, prevRz) > 0.3) sweep += dAngle(prevRx, prevRz, rx, rz);
        prevRx = rx; prevRz = rz;
        if (k >= 360) lateTravel += Math.hypot(p.x - lastX, p.z - lastZ);
        // After the player has first come to a hold, the intent never changes again (no toggling).
        if (lastMode >= 0 && p.moveMode !== lastMode) modeFlips++;
        if (lastMode >= 0 || p.moveMode === MoveMode.STOP) lastMode = p.moveMode;
        lastX = p.x; lastZ = p.z;
      });
      const dEnd = Math.hypot(p.x - tx, p.z - tz);
      expect(dEnd).toBeLessThanOrEqual(LT.deadZone);
      expect(Math.abs(sweep)).toBeLessThan(Math.PI); // never circles the spot
      expect(lateTravel).toBeLessThan(0.02); // last 4 s: standing still, no micro-steps
      expect(lastMode).toBe(MoveMode.STOP); // it did come to a hold
      expect(modeFlips).toBe(0); // and never toggled afterwards
      expect(speedOf(s, 5)).toBeLessThan(0.01);
    });
  }

  it('a target that jiggles by a few centimetres every tick causes no micro-movement', () => {
    const s = steerState();
    put(s, 5, -6, 0);
    const p = s.players[5]!;
    let travel = 0;
    let lastX = 0, lastZ = 0;
    run(s, 600, (k) => {
      const j = 0.15 * ((k * 7919) % 13 - 6) / 6; // deterministic +-0.15 m noise
      assignJob(s, 5, AiJob.HOLD_SHAPE, j, -j * 0.5, 5, -1);
    }, (k) => {
      if (k === 240) { lastX = p.x; lastZ = p.z; }
      if (k > 240) { travel += Math.hypot(p.x - lastX, p.z - lastZ); lastX = p.x; lastZ = p.z; }
    });
    expect(travel).toBeLessThan(0.02);
    expect(Math.hypot(p.x, p.z)).toBeLessThan(LT.deadZone + 0.15);
  });
});

describe('TAI-07 steering: moving targets', () => {
  it('follows a target moving in a straight line smoothly (no stop-go, bounded lag, smooth velocity)', () => {
    const s = steerState();
    put(s, 5, -30, 0);
    const p = s.players[5]!;
    const top = s.attrs[5]!.topSpeed;
    const v = 2.5;
    let maxLag = 0, minSp = 99, maxSp = 0, maxDv = 0, stops = 0;
    let pvx = 0, pvz = 0;
    run(s, 600, (k) => { assignJob(s, 5, AiJob.HOLD_SHAPE, -30 + v * (k / 60), 0, top * 0.6, -1); }, (k) => {
      const tx = -30 + v * (k / 60);
      if (k >= 180) {
        maxLag = Math.max(maxLag, Math.hypot(p.x - tx, p.z));
        const sp = speedOf(s, 5);
        minSp = Math.min(minSp, sp); maxSp = Math.max(maxSp, sp);
        maxDv = Math.max(maxDv, Math.hypot(p.vx - pvx, p.vz - pvz));
        if (p.moveMode !== MoveMode.ARRIVE) stops++;
      }
      pvx = p.vx; pvz = p.vz;
    });
    expect(stops).toBe(0);
    expect(maxLag).toBeLessThan(T_PLAYER.arriveRadius);
    expect(minSp).toBeGreaterThan(v * 0.7);
    expect(maxSp).toBeLessThan(v * 1.3);
    expect(maxDv).toBeLessThan(0.25); // per tick: no velocity spikes
  });

  it('follows a target moving on a circle smoothly', () => {
    const s = steerState();
    const R = 15, w = 3 / 15; // 3 m/s
    put(s, 5, R, 0);
    const p = s.players[5]!;
    const top = s.attrs[5]!.topSpeed;
    let maxLag = 0, maxDv = 0;
    let pvx = 0, pvz = 0;
    const tgt = (k: number): [number, number] => [R * Math.cos(w * k / 60), R * Math.sin(w * k / 60)];
    run(s, 900, (k) => { const [x, z] = tgt(k); assignJob(s, 5, AiJob.MARK, x, z, top * 0.7, -1); }, (k) => {
      const [x, z] = tgt(k);
      if (k >= 180) {
        maxLag = Math.max(maxLag, Math.hypot(p.x - x, p.z - z));
        maxDv = Math.max(maxDv, Math.hypot(p.vx - pvx, p.vz - pvz));
      }
      pvx = p.vx; pvz = p.vz;
    });
    expect(maxLag).toBeLessThan(T_PLAYER.arriveRadius);
    expect(maxDv).toBeLessThan(0.25);
  });

  for (const v of [0.3, 0.08]) {
    it(`follows a slowly moving target (${v} m/s) without reversing or stuttering`, () => {
      const s = steerState();
      put(s, 5, -0.2, 0);
      const p = s.players[5]!;
      let reversals = 0, starts = 0, wasMoving = false, maxLag = 0;
      run(s, 1200, (k) => { assignJob(s, 5, AiJob.HOLD_SHAPE, v * (k / 60), 0, 5, -1); }, (k) => {
        const tx = v * (k / 60);
        const sp = speedOf(s, 5);
        if (sp > 0.02 && p.vx < -0.02) reversals++;
        const moving = sp > 0.02;
        if (moving && !wasMoving) starts++;
        wasMoving = moving;
        if (k > 120) maxLag = Math.max(maxLag, Math.abs(p.x - tx));
      });
      expect(reversals).toBe(0);
      // Either continuous following or a few deliberate steps (each at least ~the dead zone), never micro-steps.
      expect(starts).toBeLessThanOrEqual(Math.ceil((v * 20) / (LT.deadZone * 0.5)) + 1);
      expect(maxLag).toBeLessThan(LT.deadZone + 0.3);
    });
  }
});

describe('TAI-07 glitch: Players: run in place against each other', () => {
  it('two teammates sent to the same spot both come to rest instead of pushing forever', () => {
    const s = steerState();
    put(s, 5, -6, 0);
    put(s, 6, 6, 0.4);
    const top = s.attrs[5]!.topSpeed;
    let late = 0;
    run(s, 480, () => {
      assignJob(s, 5, AiJob.HOLD_SHAPE, 0, 0, top * 0.6, -1);
      assignJob(s, 6, AiJob.SUPPORT, 0, 0, top * 0.6, -1);
    }, (k) => { if (k >= 360) late = Math.max(late, speedOf(s, 5), speedOf(s, 6)); });
    expect(late).toBeLessThan(LT.restSpeed);
    const a = s.players[5]!, b = s.players[6]!;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(2 * T_PLAYER.bodyRadius - T_PLAYER.overlapTolerance);
    expect(Math.min(Math.hypot(a.x, a.z), Math.hypot(b.x, b.z))).toBeLessThan(LT.occupiedRadius + 0.2);
  });

  it('a player whose spot is taken by a standing opponent holds short of it', () => {
    const s = steerState();
    put(s, 15, 0, 0); // opponent parked on the spot (his home is there)
    put(s, 5, -10, 0);
    const top = s.attrs[5]!.topSpeed;
    let late = 0;
    run(s, 420, () => { assignJob(s, 5, AiJob.MARK, 0, 0, top * 0.8, -1); }, (k) => {
      if (k >= 300) late = Math.max(late, speedOf(s, 5));
    });
    expect(late).toBeLessThan(LT.restSpeed);
    const d = Math.hypot(s.players[5]!.x, s.players[5]!.z);
    expect(d).toBeLessThanOrEqual(LT.occupiedStopDist + LT.occupiedHoldExtra);
    expect(d).toBeGreaterThan(2 * T_PLAYER.bodyRadius - T_PLAYER.overlapTolerance);
  });
});
