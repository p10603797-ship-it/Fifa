/**
 * [GFX-16] Replay ring buffer and playback: ring wrap and read-back, memory bound, recording rules (play phases only,
 * one snapshot per sim tick at any refresh rate, rewind clears), the replay planner (two angles, slow motion on the
 * final second before the goal, inside the budget), and playback through the module: frame substitution (every later
 * module sees the recorded state), angle cuts, the sim's REPLAY phase starting / ending playback (skip), stopReplay,
 * pause, and the goal-sequence cap. THREE-free logic, Node only.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { NUM_SLOTS, TICK_HZ } from '../../src/contracts/constants';
import { ActionKind, CameraType, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import {
  B_X, B_Z, BALL_FIELDS, createReplay, createReplayPlan, createReplayRing, LOCAL_TUNING, P_X, PLAYER_FIELDS, planReplay,
  recordsPhase, REPLAY_CAPACITY, REPLAY_SECONDS, ReplayAngle, replayPlaybackOf, replayRateAt, replayWall, SNAPSHOT_FLOATS,
  type ReplayModule,
} from '../../src/render/replay';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { aidsActive } from '../../src/render/markers';
import { initMatch } from '../../src/sim/init';

function makeCtx(): RenderContext {
  const st = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(), settings: st, clubs: [],
    size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { type: CameraType.BROADCAST, height: 10, zoom: 10 }, reducedMotion: false, night: false,
  };
}

class FakeEvents implements EventBuffer {
  list: SimEvent[] = [];
  get count(): number { return this.list.length; }
  get(i: number): Readonly<SimEvent> { return this.list[i]!; }
  begin(tick: number): void { void tick; this.list = []; }
  emit(type: EventType, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0): void {
    this.list.push({ type, tick: 0, a, b, c, d, x, y, z });
  }
}

/** Ball x along a straight run toward the +x goal (linear in ticks, so interpolation is exact). */
const ballXAt = (t: number): number => -40 + t * 0.15;
const playerXAt = (i: number, t: number): number => -50 + i * 4 + t * 0.05;

function newState(): SimState {
  const s = initMatch(createMatchConfig()) as SimState;
  s.match.phase = MatchPhase.IN_PLAY;
  return s;
}

function poseState(s: SimState, t: number, phase: MatchPhase = MatchPhase.IN_PLAY): void {
  s.tick = t;
  s.match.phase = phase;
  s.ball.x = ballXAt(t); s.ball.y = 0.11; s.ball.z = 2; s.ball.vx = 9; s.ball.inNet = 0;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    p.x = playerXAt(i, t); p.z = (i % 7) - 3; p.vx = 3; p.vz = 0; p.fx = 1; p.fz = 0;
    p.act = i === 5 ? ActionKind.SHOT : ActionKind.NONE;
    p.actT = t % 40;
  }
}

interface Rig { ctx: RenderContext; rep: ReplayModule; s: SimState; f: RenderFrame; ev: FakeEvents }

function makeRig(): Rig {
  const ctx = makeCtx();
  const rep = createReplay(ctx);
  const s = newState();
  rep.setMatch!(s, []);
  const f: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
  return { ctx, rep, s, f, ev: new FakeEvents() };
}

/** One rendered frame of the live state (as index.ts does: live prev/curr, then replay.update). */
function frame(r: Rig, dtMs = 1000 / 60, paused = false): void {
  r.f.prev = r.s;
  r.f.curr = r.s;
  r.f.alpha = 1;
  r.f.frame.dtMs = dtMs;
  r.f.frame.paused = paused;
  r.f.frame.frame++;
  const it = r.f.interp;
  for (let i = 0; i < NUM_SLOTS; i++) { it.x[i] = r.s.players[i]!.x; it.z[i] = r.s.players[i]!.z; }
  it.ballX = r.s.ball.x; it.ballY = r.s.ball.y; it.ballZ = r.s.ball.z;
  r.rep.update(r.f);
}

/** Play `seconds` of IN_PLAY then a goal at the end and `goalPhase` s of GOAL phase. Returns the goal tick. */
function playGoal(r: Rig, t0: number, seconds: number, goalPhase = 1): number {
  const n = Math.round(seconds * TICK_HZ);
  for (let t = t0; t < t0 + n; t++) { poseState(r.s, t); frame(r); }
  const goal = t0 + n;
  r.s.match.goalTick = goal;
  for (let t = goal; t < goal + Math.round(goalPhase * TICK_HZ); t++) {
    poseState(r.s, t, MatchPhase.GOAL);
    r.s.ball.inNet = t >= goal + 6 ? 1 : 0;
    frame(r);
  }
  return goal;
}

/** Celebration (not recorded) then the sim enters REPLAY (event + state). */
function enterReplay(r: Rig, celebrationSec = 4): void {
  const t0 = r.s.tick + 1;
  for (let t = t0; t < t0 + celebrationSec * TICK_HZ; t++) { poseState(r.s, t, MatchPhase.CELEBRATION); frame(r); }
  r.s.tick++;
  r.s.match.phase = MatchPhase.REPLAY;
  r.ev.begin(r.s.tick);
  r.ev.emit(EventType.PHASE_CHANGE, MatchPhase.CELEBRATION, MatchPhase.REPLAY);
  r.rep.onEvents!(r.ev, r.s);
}

describe('GFX-16 ring buffer', () => {
  it('holds at least REPLAY_SECONDS of sim ticks', () => {
    expect(REPLAY_CAPACITY).toBeGreaterThanOrEqual(REPLAY_SECONDS * TICK_HZ);
    expect(createReplayRing().capacity).toBe(REPLAY_CAPACITY);
  });

  it('memory bound: fixed typed arrays, under 2 MB', () => {
    const ring = createReplayRing();
    expect(ring.bytes).toBe(REPLAY_CAPACITY * (SNAPSHOT_FLOATS * 4 + 8));
    expect(ring.bytes).toBeLessThan(2 * 1024 * 1024);
    const s = newState();
    for (let t = 0; t < REPLAY_CAPACITY * 3; t++) { poseState(s, t); ring.record(s); }
    expect(ring.bytes).toBe(REPLAY_CAPACITY * (SNAPSHOT_FLOATS * 4 + 8));
    expect(ring.count).toBe(REPLAY_CAPACITY);
  });

  it('wraps: keeps the newest capacity ticks in order and reads them back exactly', () => {
    const ring = createReplayRing(64);
    const s = newState();
    for (let t = 0; t < 64 + 37; t++) { poseState(s, t); ring.record(s); }
    expect(ring.count).toBe(64);
    expect(ring.tickAt(0)).toBe(37);
    expect(ring.tickAt(63)).toBe(100);
    for (let k = 0; k < 64; k++) {
      const t = 37 + k;
      expect(ring.tickAt(k)).toBe(t);
      expect(ring.ballField(k, B_X)).toBeCloseTo(ballXAt(t), 4);
      expect(ring.playerField(k, 9, P_X)).toBeCloseTo(playerXAt(9, t), 4);
    }
    const out = newState();
    ring.readInto(10, out);
    expect(out.tick).toBe(47);
    expect(out.ball.x).toBeCloseTo(ballXAt(47), 4);
    expect(out.players[5]!.act).toBe(ActionKind.SHOT);
    expect(out.players[5]!.actT).toBe(47 % 40);
    expect(out.players[3]!.x).toBeCloseTo(playerXAt(3, 47), 4);
  });

  it('records every PLAYER_FIELDS / BALL_FIELDS value', () => {
    const ring = createReplayRing(8);
    const s = newState();
    const p = s.players[7]! as unknown as Record<string, number>;
    PLAYER_FIELDS.forEach((k, i) => { p[k] = i + 0.5; });
    const b = s.ball as unknown as Record<string, number>;
    BALL_FIELDS.forEach((k, i) => { b[k] = -(i + 0.25); });
    s.tick = 5;
    ring.record(s);
    const out = newState();
    ring.readInto(0, out);
    const q = out.players[7]! as unknown as Record<string, number>;
    PLAYER_FIELDS.forEach((k, i) => expect(q[k]).toBeCloseTo(i + 0.5, 5));
    const ob = out.ball as unknown as Record<string, number>;
    BALL_FIELDS.forEach((k, i) => expect(ob[k]).toBeCloseTo(-(i + 0.25), 5));
  });

  it('one snapshot per tick: duplicates skipped, an older tick (new match / rewind) clears', () => {
    const ring = createReplayRing(32);
    const s = newState();
    for (let t = 0; t < 10; t++) { poseState(s, t); expect(ring.record(s)).toBe(true); expect(ring.record(s)).toBe(false); }
    expect(ring.count).toBe(10);
    poseState(s, 3);
    expect(ring.record(s)).toBe(true);
    expect(ring.count).toBe(1);
    expect(ring.tickAt(0)).toBe(3);
  });

  it('floorIndex and contiguousFrom (a gap in the recording is a cut)', () => {
    const ring = createReplayRing(64);
    const s = newState();
    for (let t = 0; t < 10; t++) { poseState(s, t); ring.record(s); }
    for (let t = 300; t < 320; t += 2) { poseState(s, t); ring.record(s); }
    expect(ring.floorIndex(-1)).toBe(-1);
    expect(ring.floorIndex(4.5)).toBe(4);
    expect(ring.floorIndex(9)).toBe(9);
    expect(ring.floorIndex(150)).toBe(9);
    expect(ring.floorIndex(303)).toBe(11);
    expect(ring.floorIndex(1e9)).toBe(ring.count - 1);
    expect(ring.contiguousFrom(LOCAL_TUNING.gapTicks)).toBe(10);
    expect(ring.tickAt(ring.contiguousFrom(LOCAL_TUNING.gapTicks))).toBe(300);
    expect(ring.contiguousFrom(1000)).toBe(0);
  });

  it('interpInto blends positions and re-normalises facing', () => {
    const ring = createReplayRing(8);
    const s = newState();
    poseState(s, 0); s.players[2]!.fx = 1; s.players[2]!.fz = 0; ring.record(s);
    poseState(s, 1); s.players[2]!.fx = 0; s.players[2]!.fz = 1; ring.record(s);
    const it = createInterpState();
    ring.interpInto(0, 1, 0.5, it);
    expect(it.ballX).toBeCloseTo(ballXAt(0.5), 4);
    expect(it.x[4]).toBeCloseTo(playerXAt(4, 0.5), 4);
    expect(Math.hypot(it.fx[2]!, it.fz[2]!)).toBeCloseTo(1, 5);
    expect(it.fx[2]).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it('records only play phases', () => {
    for (const ph of [MatchPhase.KICK_OFF, MatchPhase.IN_PLAY, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER,
      MatchPhase.FREE_KICK, MatchPhase.PENALTY, MatchPhase.GOAL, MatchPhase.SHOOT_OUT]) expect(recordsPhase(ph)).toBe(true);
    for (const ph of [MatchPhase.PRE_MATCH, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME, MatchPhase.FULL_TIME,
      MatchPhase.EXTRA_TIME, MatchPhase.POST_MATCH]) expect(recordsPhase(ph)).toBe(false);
  });
});

describe('GFX-16 replay planner', () => {
  const T = TICK_HZ;

  it('two angles inside the budget: side build-up then behind-goal finish, slow final second', () => {
    const plan = createReplayPlan();
    const end = 1000, goal = end - 0.6 * T, oldest = end - 8 * T;
    planReplay(7, oldest, end, goal, plan);
    expect(plan.count).toBe(2);
    expect(plan.seg[0].angle).toBe(ReplayAngle.SIDE);
    expect(plan.seg[1].angle).toBe(ReplayAngle.BEHIND_GOAL);
    expect(plan.wall).toBeLessThanOrEqual(7 + 1e-9);
    expect(plan.wall).toBeGreaterThan(6.9);
    expect(plan.seg[0].from).toBeGreaterThanOrEqual(oldest);
    expect(plan.seg[0].to).toBeCloseTo(goal + LOCAL_TUNING.tail * T, 6);
    expect(plan.seg[1].from).toBeCloseTo(goal - LOCAL_TUNING.secondLead * T, 6);
    // Slow motion over the final second before the goal only.
    expect(replayRateAt(plan, goal - 0.5 * T)).toBe(LOCAL_TUNING.slowRate);
    expect(replayRateAt(plan, goal - 1.2 * T)).toBe(1);
    expect(replayRateAt(plan, goal + 0.1 * T)).toBe(1);
    expect(LOCAL_TUNING.slowRate).toBeLessThan(1);
    expect(LOCAL_TUNING.slowRate).toBeGreaterThanOrEqual(0.5);
    // Segment walls add up.
    expect(plan.seg[0].wall + plan.seg[1].wall).toBeCloseTo(plan.wall, 9);
    expect(replayWall(plan, plan.seg[0].from, plan.seg[0].to)).toBeCloseTo(plan.seg[0].wall, 9);
  });

  it('short budget or little build-up keeps one side angle', () => {
    const plan = createReplayPlan();
    planReplay(3, 0, 600, 560, plan);
    expect(plan.count).toBe(1);
    expect(plan.seg[0].angle).toBe(ReplayAngle.SIDE);
    expect(plan.wall).toBeCloseTo(3, 6);
    planReplay(7, 500, 600, 560, plan); // only 1 s of build-up recorded
    expect(plan.count).toBe(1);
    expect(plan.seg[0].from).toBe(500);
  });

  it('no goal in the window: the newest tick is the end, nothing to plan without content', () => {
    const plan = createReplayPlan();
    planReplay(5, 0, 480, -1, plan);
    expect(plan.goal).toBe(480);
    expect(plan.seg[0].to).toBe(480);
    expect(planReplay(5, 100, 100, 100, plan).count).toBe(0);
    expect(planReplay(0, 0, 480, 400, plan).count).toBe(0);
    expect(planReplay(Number.NaN, 0, 480, 400, plan).count).toBe(0);
  });

  it('never exceeds the budget nor the recorded window (randomised)', () => {
    const plan = createReplayPlan();
    let seed = 7;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 500; i++) {
      const end = 1000 + rnd() * 5000;
      const oldest = end - rnd() * REPLAY_SECONDS * T;
      const goal = end - rnd() * 1.5 * T;
      const budget = rnd() * 12;
      planReplay(budget, oldest, end, goal, plan);
      expect(plan.wall).toBeLessThanOrEqual(budget + 1e-6);
      for (let k = 0; k < plan.count; k++) {
        expect(plan.seg[k].from).toBeGreaterThanOrEqual(oldest - 1e-9);
        expect(plan.seg[k].to).toBeLessThanOrEqual(end + 1e-9);
        expect(plan.seg[k].to).toBeGreaterThan(plan.seg[k].from);
      }
    }
  });
});

describe('GFX-16 playback', () => {
  it('start() is false with nothing recorded', () => {
    const r = makeRig();
    expect(r.rep.start(7)).toBe(false);
    expect(r.rep.playing).toBe(false);
  });

  it('the sim REPLAY phase starts playback; the frame is substituted with the recorded state', () => {
    const r = makeRig();
    const goal = playGoal(r, 100, 9);
    enterReplay(r);
    expect(r.rep.playing).toBe(true);
    const link = replayPlaybackOf(r.ctx);
    expect(link.playing).toBe(true);
    expect(link.angle).toBe(ReplayAngle.SIDE);
    expect(link.goalEnd).toBe(1);
    expect(r.rep.plan.count).toBe(2);
    expect(r.rep.plan.goal).toBe(goal);
    // Budget = the REPLAY phase length (7 s by default).
    expect(r.rep.plan.wall).toBeCloseTo(Math.min(r.s.config.replaySeconds, T_RULES.replayTicks / TICK_HZ), 3);
    for (let i = 0; i < 30; i++) {
      frame(r);
      expect(r.f.curr).not.toBe(r.s);
      expect(r.f.prev).not.toBe(r.s);
      const c = r.f.prev.tick + (r.f.curr.tick - r.f.prev.tick) * r.f.alpha;
      expect(r.f.interp.ballX).toBeCloseTo(ballXAt(c), 3);
      expect(r.f.interp.x[3]).toBeCloseTo(playerXAt(3, c), 3);
      expect(c).toBeGreaterThanOrEqual(r.rep.plan.seg[0].from - 1e-6);
      // Static facts come from the live state: the phase stays REPLAY (on-pitch aids hidden).
      expect(r.f.curr.match.phase).toBe(MatchPhase.REPLAY);
      expect(aidsActive(r.f.curr.match.phase)).toBe(false);
      expect(r.f.curr.players[5]!.act).toBe(ActionKind.SHOT);
    }
    // Recording is paused while playing.
    const n = r.rep.ring.count;
    frame(r);
    expect(r.rep.ring.count).toBe(n);
  });

  it('plays the plan: slow motion before the goal, a cut to the second angle, then holds until the phase ends', () => {
    const r = makeRig();
    const goal = playGoal(r, 100, 9);
    enterReplay(r);
    const link = replayPlaybackOf(r.ctx);
    const plan = r.rep.plan;
    const cuts0 = link.cuts;
    let sawSlow = false, sawSecond = false;
    let lastC = -Infinity;
    for (let i = 0; i < Math.ceil(plan.wall * 60) + 30; i++) {
      frame(r);
      const c = r.f.prev.tick + (r.f.curr.tick - r.f.prev.tick) * r.f.alpha;
      if (link.segment === 0) {
        if (c > goal - 0.9 * TICK_HZ && c < goal - 0.1 * TICK_HZ) {
          expect(link.rate).toBe(LOCAL_TUNING.slowRate);
          sawSlow = true;
        }
        expect(c).toBeGreaterThanOrEqual(lastC - 1e-6);
      } else if (!sawSecond) {
        sawSecond = true;
        expect(link.angle).toBe(ReplayAngle.BEHIND_GOAL);
        expect(link.cuts).toBe(cuts0 + 1);
        expect(c).toBeLessThan(lastC); // jumped back for the second angle
      }
      lastC = c;
    }
    expect(sawSlow).toBe(true);
    expect(sawSecond).toBe(true);
    // Past the plan: still playing (holding the last frame) while the sim's REPLAY phase lasts.
    expect(r.rep.playing).toBe(true);
    expect(r.f.curr.tick).toBeLessThanOrEqual(plan.seg[1].to + 1);
    // Phase ends without an event (safety net): playback stops and the live frame is drawn.
    r.s.match.phase = MatchPhase.KICK_OFF;
    frame(r);
    expect(r.rep.playing).toBe(false);
    expect(r.f.curr).toBe(r.s);
  });

  it('skippable: the sim leaving REPLAY (skip) or stopReplay ends playback at once', () => {
    const r = makeRig();
    playGoal(r, 100, 9);
    enterReplay(r);
    frame(r);
    r.s.match.phase = MatchPhase.KICK_OFF;
    r.ev.begin(r.s.tick);
    r.ev.emit(EventType.PHASE_CHANGE, MatchPhase.REPLAY, MatchPhase.KICK_OFF);
    r.rep.onEvents!(r.ev, r.s);
    expect(r.rep.playing).toBe(false);
    expect(replayPlaybackOf(r.ctx).playing).toBe(false);
    // stop()
    const r2 = makeRig();
    playGoal(r2, 100, 9);
    enterReplay(r2);
    expect(r2.rep.playing).toBe(true);
    r2.rep.stop();
    expect(r2.rep.playing).toBe(false);
    frame(r2);
    expect(r2.f.curr).toBe(r2.s);
  });

  it('replays off: entering and leaving REPLAY in one tick never starts playback', () => {
    const r = makeRig();
    playGoal(r, 100, 9);
    r.s.match.phase = MatchPhase.KICK_OFF;
    r.ev.begin(r.s.tick);
    r.ev.emit(EventType.PHASE_CHANGE, MatchPhase.CELEBRATION, MatchPhase.REPLAY);
    r.ev.emit(EventType.PHASE_CHANGE, MatchPhase.REPLAY, MatchPhase.KICK_OFF);
    r.rep.onEvents!(r.ev, r.s);
    expect(r.rep.playing).toBe(false);
    const r2 = makeRig();
    playGoal(r2, 100, 9);
    r2.s.config.replaySeconds = 0;
    enterReplay(r2);
    expect(r2.rep.playing).toBe(false);
  });

  it('respects the 12 s goal-sequence cap', () => {
    const r = makeRig();
    playGoal(r, 100, 9);
    enterReplay(r, 9); // long celebration: only 12 - 10 s left
    const left = (T_RULES.goalSequenceMaxTicks - (r.s.tick - r.s.match.goalTick)) / TICK_HZ;
    expect(r.rep.playing).toBe(true);
    expect(r.rep.plan.wall).toBeLessThanOrEqual(left + 1e-6);
  });

  it('pause freezes playback; frame time drives it', () => {
    const r = makeRig();
    playGoal(r, 100, 9);
    enterReplay(r);
    frame(r);
    const t0 = r.f.prev.tick + (r.f.curr.tick - r.f.prev.tick) * r.f.alpha;
    for (let i = 0; i < 20; i++) frame(r, 16, true);
    const t1 = r.f.prev.tick + (r.f.curr.tick - r.f.prev.tick) * r.f.alpha;
    expect(t1).toBeCloseTo(t0, 9);
    frame(r, 1000 / 60 * 6); // 0.1 s at 1x outside the slow window: 6 ticks
    const t2 = r.f.prev.tick + (r.f.curr.tick - r.f.prev.tick) * r.f.alpha;
    expect(t2 - t1).toBeCloseTo(6, 3);
  });

  it('a manual startReplay during play ends with its plan', () => {
    const r = makeRig();
    playGoal(r, 100, 6, 0);
    expect(r.rep.start(2)).toBe(true);
    const plan = r.rep.plan;
    expect(plan.count).toBe(1);
    for (let i = 0; i < Math.ceil(plan.wall * 60) + 5; i++) frame(r);
    expect(r.rep.playing).toBe(false);
  });

  it('records each sim tick once at 120 Hz and both states of a multi-tick frame', () => {
    const r = makeRig();
    for (let t = 0; t < 60; t++) {
      poseState(r.s, t);
      frame(r, 1000 / 120);
      frame(r, 1000 / 120); // a 120 Hz frame without a tick
    }
    expect(r.rep.ring.count).toBe(60);
    // Two separate states: prev (tick 99) and curr (tick 100), one frame.
    const prev = newState();
    poseState(prev, 99);
    poseState(r.s, 100);
    r.f.prev = prev; r.f.curr = r.s; r.f.alpha = 0.5;
    r.rep.update(r.f);
    expect(r.rep.ring.tickAt(r.rep.ring.count - 2)).toBe(99);
    expect(r.rep.ring.tickAt(r.rep.ring.count - 1)).toBe(100);
  });

  it('only the newest contiguous play is replayed (a cut-scene splits the recording)', () => {
    const r = makeRig();
    playGoal(r, 100, 9);
    enterReplay(r);
    r.rep.stop();
    // Kick-off and 3 s of play, then a second goal.
    const t0 = r.s.tick + 200;
    const goal2 = playGoal(r, t0, 3);
    enterReplay(r);
    expect(r.rep.playing).toBe(true);
    expect(r.rep.plan.seg[0].from).toBeGreaterThanOrEqual(t0);
    expect(r.rep.plan.goal).toBe(goal2);
  });

  it('clearMatch empties the ring and stops; goal end follows the net', () => {
    const r = makeRig();
    // Toward the -x goal this time.
    for (let t = 0; t < 400; t++) { poseState(r.s, t); r.s.ball.x = 30 - t * 0.2; frame(r); }
    r.s.match.goalTick = 400;
    for (let t = 400; t < 440; t++) { poseState(r.s, t, MatchPhase.GOAL); r.s.ball.x = -53; r.s.ball.inNet = -1; frame(r); }
    enterReplay(r);
    expect(replayPlaybackOf(r.ctx).goalEnd).toBe(-1);
    expect(Math.abs(replayPlaybackOf(r.ctx).goalZ)).toBeLessThanOrEqual(3.66);
    r.rep.clearMatch!();
    expect(r.rep.playing).toBe(false);
    expect(r.rep.ring.count).toBe(0);
    expect(r.rep.start(5)).toBe(false);
    expect(B_Z).toBe(2);
  });
});
