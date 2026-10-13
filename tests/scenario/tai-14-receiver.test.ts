/**
 * TAI-14 receiver assist through the real step pipeline (BRIEF §6 Passing: "The intended receiver moves to collect
 * on his own until the user steers him"): a job-driven intended receiver gets RECEIVE at the interception point and
 * meets the pass earlier than standing still (both attack directions, several geometries); through balls are met in
 * stride; the assist stops when a controller takes him / an opponent touches the ball / for keepers and restarts;
 * ctrl.receiver marks him; determinism. Commands sent in InputFrames reach applyCommand through SIM-15.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { AXIS_SCALE, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { AiJob, AutoSwitch, Command, KickKind, MatchPhase, TacticalFocus } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { receiverAssist } from '../../src/ai/tactics';
import { resetJobs } from '../../src/ai/jobs';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { step } from '../../src/sim/step';
import { findEvents, makeScenario, runTicks, type ScenarioHuman } from '../harness/scenario';

interface Pass {
  team: number;
  /** Ball start and velocity. */
  bx: number; bz: number; vx: number; vz: number;
  /** Receiver slot and position (+ optional velocity). */
  r: number; rx: number; rz: number; rvx?: number; rvz?: number;
  kind?: KickKind;
  /** Intended reception point (ball.passX/Z, as the kick solver sets it); default the receiver's position. */
  px?: number; pz?: number;
}

/**
 * Open-play pass in flight from `passer` (team's slot 6) to the receiver; everybody else parked far from the ball's
 * path. assist = true: the receiver is the intended receiver and job-driven (one human on the team, auto-switch OFF,
 * driving a far-away player). assist = false (standing baseline): no intended receiver and a second human of the same
 * side holds the receiver with an idle stick, so he stands still and nobody else goes for the ball.
 */
function scene(c: Pass, assist: boolean): SimState {
  const first = c.team === 0 ? 0 : 11;
  const passer = first + 6;
  const far = first + 2;
  const humans: ScenarioHuman[] = [{ side: c.team, slot: far, autoSwitch: AutoSwitch.OFF }];
  if (!assist) humans.push({ side: c.team, slot: c.r, autoSwitch: AutoSwitch.OFF });
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed: 3, humans,
    ball: {
      x: c.bx, z: c.bz, vx: c.vx, vz: c.vz, owner: -1, passTarget: assist ? c.r : -1, passX: c.px ?? c.rx, passZ: c.pz ?? c.rz,
      lastKickTeam: c.team, lastTouchTeam: c.team, lastKickBy: passer, lastTouch: passer,
      lastKickKind: c.kind ?? KickKind.GROUND_PASS, lastKickTick: 0, lastTouchTick: 0,
    },
  });
  const back = -Math.sign(c.vx) || -1; // park everyone behind the ball's direction of travel
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    if (i === c.r || p.isKeeper === 1) continue;
    p.x = back * (i < 11 ? 40 : 30); p.z = -30 + 2.5 * (i % 11); p.homeX = p.x; p.homeZ = p.z;
  }
  Object.assign(s.players[passer]!, { x: c.bx - Math.sign(c.vx), z: c.bz, homeX: c.bx - Math.sign(c.vx), homeZ: c.bz });
  Object.assign(s.players[c.r]!, {
    x: c.rx, z: c.rz, vx: c.rvx ?? 0, vz: c.rvz ?? 0, homeX: c.rx, homeZ: c.rz,
    fx: c.rvx ? Math.sign(c.rvx) : -Math.sign(c.vx), fz: 0,
  });
  return s;
}

interface Run { touchTick: number; ownTick: number; jobs: AiJob[]; path: { x: number; z: number; vx: number; tgtX: number }[]; marker: number[] }

/** Step until the receiver owns the ball (or maxTicks), recording what he did. */
function receive(s: SimState, r: number, maxTicks = 240): Run {
  const run: Run = { touchTick: -1, ownTick: -1, jobs: [], path: [], marker: [] };
  const t0 = s.tick;
  runTicks(s, maxTicks, undefined, {
    check: 'core',
    until: (st) => {
      const p = st.players[r]!;
      run.jobs.push(p.job);
      run.path.push({ x: p.x, z: p.z, vx: p.vx, tgtX: p.tgtX });
      run.marker.push(st.ctrl[0]!.receiver);
      if (run.touchTick < 0 && st.ball.lastTouch === r) run.touchTick = st.tick - t0;
      if (st.ball.owner === r) { run.ownTick = st.tick - t0; return true; }
      return st.match.phase !== MatchPhase.IN_PLAY;
    },
  });
  return run;
}

const PASSES: Record<string, Pass> = {
  straight: { team: 0, bx: 0, bz: 0, vx: 14, vz: 0, r: 9, rx: 24, rz: 0.4 },
  diagonal: { team: 0, bx: -5, bz: -10, vx: 12, vz: 6, r: 10, rx: 14.5, rz: 0.3 },
  wide: { team: 0, bx: -10, bz: 20, vx: 16, vz: -2, r: 7, rx: 18, rz: 16 },
  awayStraight: { team: 1, bx: 0, bz: 0, vx: -14, vz: 0, r: 20, rx: -24, rz: -0.4 },
  awayDiagonal: { team: 1, bx: 5, bz: 10, vx: -12, vz: -6, r: 19, rx: -14.5, rz: -0.3 },
};

describe('TAI-14 receiver assist: the intended receiver moves to collect (full pipeline)', () => {
  for (const [name, c] of Object.entries(PASSES)) {
    it(`meets the pass earlier than standing still: ${name}`, () => {
      const stand = receive(scene(c, false), c.r);
      const go = receive(scene(c, true), c.r);
      expect(stand.ownTick, 'standing baseline receives the ball').toBeGreaterThan(0);
      expect(go.ownTick, 'assisted receiver receives the ball').toBeGreaterThan(0);
      // At least a quarter of a second earlier.
      expect(go.ownTick, `${name}: assisted ${go.ownTick} vs standing ${stand.ownTick}`).toBeLessThan(stand.ownTick - 15);
      // He had the RECEIVE job while the ball travelled, and the controller's receiver marker named him.
      expect(go.jobs.slice(0, go.jobs.length - 1).every((j) => j === AiJob.RECEIVE)).toBe(true);
      expect(go.marker.slice(0, go.marker.length - 1).every((m) => m === c.r)).toBe(true);
      // He moved toward the ball (against its direction of travel), not away.
      const sp = Math.hypot(c.vx, c.vz);
      const end = go.path[go.path.length - 1]!;
      const toward = -((end.x - c.rx) * c.vx + (end.z - c.rz) * c.vz) / sp;
      expect(toward, `${name}: metres moved toward the ball`).toBeGreaterThan(2);
    });
  }

  it('through ball: the runner keeps running onto it in stride (never turns back) and collects it', () => {
    for (const team of [0, 1]) {
      const d = team === 0 ? 1 : -1;
      // Played from behind him into the space ahead, led to (20, 4.66) on the ball's line as SIM-10 would.
      const c: Pass = {
        team, bx: 0, bz: 0, vx: d * 15, vz: d * 3.5, r: team === 0 ? 9 : 20, rx: d * 10, rz: d * 6, rvx: d * 7, rvz: 0,
        kind: KickKind.THROUGH_GROUND, px: d * 20, pz: d * 4.66,
      };
      const s = scene(c, true);
      const run = receive(s, c.r);
      expect(run.ownTick, `team ${team}`).toBeGreaterThan(0);
      for (let k = 0; k < run.path.length - 1; k++) {
        const pt = run.path[k]!;
        expect(d * pt.vx, `team ${team} tick ${k}: still running forward`).toBeGreaterThan(0);
        // The target was chosen this tick from where he stood before moving (the previous sample).
        const before = k === 0 ? c.rx : run.path[k - 1]!.x;
        if (run.jobs[k] === AiJob.RECEIVE) expect(d * pt.tgtX, `team ${team} tick ${k}: target not behind`).toBeGreaterThanOrEqual(d * before - 1 - 1e-9);
      }
      expect(d * run.path[run.path.length - 1]!.x, 'gained ground').toBeGreaterThan(d * c.rx + 5);
    }
  });
});

describe('TAI-14 receiver assist stops when it should', () => {
  it('a human who takes the receiver and moves the stick steers him: no RECEIVE job, he follows the stick', () => {
    const c = PASSES.straight!;
    const s = scene(c, true);
    runTicks(s, 20);
    expect(s.players[c.r]!.job).toBe(AiJob.RECEIVE);
    // SIM-16 hands him to the human (as a manual or auto switch would), who pushes the stick to +z.
    s.players[2]!.ctrl = -1;
    s.ctrl[0]!.slot = c.r;
    s.players[c.r]!.ctrl = 0;
    let vz = 0;
    runTicks(s, 25, (_t, _st, out) => { out[0]!.mz = AXIS_SCALE; }, {
      until: (st) => {
        const p = st.players[c.r]!;
        expect(p.job).not.toBe(AiJob.RECEIVE);
        expect(st.ctrl[0]!.receiver).toBe(-1);
        vz = p.vz;
        return st.ball.owner >= 0;
      },
    });
    expect(vz).toBeGreaterThan(1);
  });

  it('a pass touched by an opponent, a ball already owned, a pass to the keeper or a restart phase: no RECEIVE', () => {
    const ev = createEventBuffer();
    const c = PASSES.straight!;
    const cases: [string, (s: SimState) => void][] = [
      ['deflected by an opponent', (s) => { s.ball.lastTouchTeam = 1; s.ball.lastTouch = 15; }],
      ['ball owned', (s) => { s.ball.owner = 6; }],
      ['ball in hands', (s) => { s.ball.heldBy = 0; s.ball.owner = 0; }],
      ['kicked by the other team', (s) => { s.ball.lastKickTeam = 1; }],
      ['restart phase', (s) => { s.match.phase = MatchPhase.THROW_IN; }],
      ['receiver controlled', (s) => { s.players[2]!.ctrl = -1; s.ctrl[0]!.slot = c.r; s.players[c.r]!.ctrl = 0; }],
      ['receiver sent off', (s) => { s.players[c.r]!.active = 0; }],
    ];
    for (const [label, mutate] of cases) {
      const s = scene(c, true);
      mutate(s);
      resetJobs(s, 0);
      receiverAssist(s, 0, ev);
      for (let i = 0; i < 11; i++) expect(s.players[i]!.job, `${label}: slot ${i}`).not.toBe(AiJob.RECEIVE);
      expect(s.ctrl[0]!.receiver === -1 || s.ctrl[0]!.receiver === s.ctrl[0]!.slot, label).toBe(true);
    }
    // A pass to our own keeper: the keeper pipeline (GKP) collects it; nobody gets RECEIVE, no marker.
    const s = scene(c, true);
    s.ball.passTarget = 0;
    resetJobs(s, 0);
    receiverAssist(s, 0, ev);
    for (let i = 0; i < 11; i++) expect(s.players[i]!.job).not.toBe(AiJob.RECEIVE);
    expect(s.ctrl[0]!.receiver).toBe(-1);
  });

  it('a stale receiver marker written by the assist is cleared once the pass is over', () => {
    const c = PASSES.straight!;
    const s = scene(c, true);
    const ev = createEventBuffer();
    resetJobs(s, 0);
    receiverAssist(s, 0, ev);
    expect(s.ctrl[0]!.receiver).toBe(c.r);
    s.ball.owner = c.r;
    s.ball.passTarget = -1;
    resetJobs(s, 0);
    receiverAssist(s, 0, ev);
    expect(s.ctrl[0]!.receiver).toBe(-1);
  });

  it('a receiver who cannot reach the pass in the horizon still goes after it (toward where the ball is going)', () => {
    const c: Pass = { team: 0, bx: 0, bz: 0, vx: 22, vz: 0, r: 9, rx: 5, rz: 25 };
    const s = scene(c, true);
    resetJobs(s, 0);
    receiverAssist(s, 0, createEventBuffer());
    const p = s.players[c.r]!;
    expect(p.job).toBe(AiJob.RECEIVE);
    expect(p.tgtX).toBeGreaterThan(p.x);
    expect(Math.abs(p.tgtZ)).toBeLessThan(1);
    expect(Number.isFinite(p.tgtX) && Number.isFinite(p.tgtZ)).toBe(true);
  });
});

describe('TAI-14 determinism and commands through the pipeline', () => {
  it('same scene twice -> identical hash every tick; interleaving two sims or cloning mid-pass changes nothing', () => {
    const c = PASSES.diagonal!;
    const a = scene(c, true), b = scene(c, true), d = scene(c, true);
    const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
    const ea = createEventBuffer(), eb = createEventBuffer(), ed = createEventBuffer();
    let clone: SimState | null = null;
    for (let k = 0; k < 150; k++) {
      step(a, frames, ea);
      step(b, frames, eb);
      expect(hashState(b), `tick ${a.tick}`).toBe(hashState(a));
      if (k === 40) clone = cloneState(a);
    }
    for (let k = 0; k < 150; k++) step(d, frames, ed);
    expect(hashState(d)).toBe(hashState(a));
    const c2 = clone!;
    const e2 = createEventBuffer();
    for (let k = 41; k < 150; k++) step(c2, frames, e2);
    expect(hashState(c2)).toBe(hashState(a));
  });

  it('InputFrame commands reach applyCommand via SIM-15 for the controller\'s side and emit TACTIC', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 1 }] });
    const plan: [Command, number][] = [
      [Command.TACTIC_TEAM_PRESS, 0], [Command.FOCUS_ATTACKING, 0], [Command.SET_FORMATION, 2], [Command.TACTIC_OFFSIDE_TRAP, 0],
    ];
    const ev = runTicks(s, plan.length * 2, (tick, _st, out) => {
      const k = tick - 1;
      if (k % 2 === 0 && k / 2 < plan.length) { out[0]!.cmd = plan[k / 2]![0]; out[0]!.cmdArg = plan[k / 2]![1]; }
    });
    const tactics = findEvents(ev, EventType.TACTIC).map((e) => [e.a, e.b, e.c]);
    expect(tactics).toEqual([
      [1, Command.TACTIC_TEAM_PRESS, 1], [1, Command.FOCUS_ATTACKING, TacticalFocus.ATTACKING], [1, Command.SET_FORMATION, 2],
      [1, Command.TACTIC_OFFSIDE_TRAP, 1],
    ]);
    const t = s.teams[1]!;
    expect([t.teamPress, t.focus, t.formation, t.offsideTrap]).toEqual([1, TacticalFocus.ATTACKING, 2, 1]);
    expect(s.teams[0]!.teamPress).toBe(0);
    // Shape updated with the new formation in the same tick: every active player's home is his team.homeX entry.
    for (let i = 11; i < 22; i++) {
      const p = s.players[i]!;
      expect(p.homeX).toBe(t.homeX[p.formIdx]);
    }
  });
});
