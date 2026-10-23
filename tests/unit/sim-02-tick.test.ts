/**
 * SIM-02 ballTick: px/py/pz bookkeeping, hands skip, SIM-03 detectCrossing on every substep segment (the scoring
 * segment is seen with inNet still 0, so a goal is neither lost nor counted twice), world clamp, determinism
 * (bit-identical; ballTick == ballStepTick so SIM-01 predictions match the sim), budget and zero allocation.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DT, HALF_LENGTH, HALF_WIDTH, WORLD_MAX_X, WORLD_MAX_Y, WORLD_MAX_Z } from '../../src/contracts/constants';
import { CrossKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createBallState, type BallState, type SimState } from '../../src/contracts/state';
import { ballStepTick, ballSubsteps, ballTick } from '../../src/sim/ball/contact';
import { createEventBuffer } from '../../src/sim/core/events';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import { GL, GW, R, ball, inNetBox, runBall } from './sim-02-helpers';

/** Every detectCrossing call: the substep segment and the inNet flag SIM-03 sees at that moment. */
const calls = vi.hoisted(() => ({ list: [] as { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; inNet: number; tick: number }[] }));

vi.mock('../../src/sim/pitch/geometry', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sim/pitch/geometry')>();
  return {
    ...orig,
    detectCrossing: (s: SimState, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): CrossKind => {
      calls.list.push({ x0, y0, z0, x1, y1, z1, inNet: s.ball.inNet, tick: s.tick });
      return CrossKind.NONE;
    },
  };
});

/** One scenario state reused for ball-only tests (ballTick reads only s.ball and s.tick; detectCrossing is mocked). */
const BASE = makeScenario({ phase: MatchPhase.IN_PLAY });
const FRESH_BALL = createBallState();
function scenarioWithBall(over: Partial<BallState>): SimState {
  const s = BASE;
  Object.assign(s.ball, FRESH_BALL, over);
  if (over.y !== undefined && over.grounded === undefined) s.ball.grounded = over.y > R ? 0 : 1;
  return s;
}

const TICK_EV = createEventBuffer();
function tickBall(s: SimState, n: number): ReturnType<typeof createEventBuffer> {
  const ev = TICK_EV;
  for (let i = 0; i < n; i++) {
    s.tick++;
    ev.begin(s.tick);
    s.ball.cross = CrossKind.NONE;
    ballTick(s, ev);
  }
  return ev;
}

const KIN: (keyof BallState)[] = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'sx', 'sy', 'sz', 'grounded', 'bounces', 'inNet'];

describe('SIM-02 ballTick', () => {
  it('records px/py/pz at the start of the tick and integrates', () => {
    const s = scenarioWithBall({ x: 10, y: 3, z: -4, vx: 5, vy: 2, vz: 1 });
    tickBall(s, 1);
    expect(s.ball.px).toBe(10);
    expect(s.ball.py).toBe(3);
    expect(s.ball.pz).toBe(-4);
    expect(s.ball.x).toBeGreaterThan(10);
  });

  it('skips integration (and crossing) while the ball is held in a keeper\'s hands', () => {
    const s = scenarioWithBall({ x: 52.4, y: 1.2, z: 0, vx: 10, vy: 0, heldBy: 0, owner: 0 });
    calls.list.length = 0;
    tickBall(s, 10);
    expect(s.ball.x).toBe(52.4);
    expect(s.ball.y).toBe(1.2);
    expect(s.ball.px).toBe(52.4);
    expect(calls.list).toHaveLength(0);
  });

  it('calls detectCrossing on the substep segments beyond a line; they chain from px to x', () => {
    for (const [x, z, vx, vz] of [[50, 0.5, 30, 0], [0, 32, 2, 25], [-50, -2, -36, 1]] as [number, number, number, number][]) {
      const s = scenarioWithBall({ x, y: R, z, vx, vz });
      for (let t = 0; t < 30; t++) {
        calls.list.length = 0;
        const n = ballSubsteps(s.ball);
        tickBall(s, 1);
        const b = s.ball;
        const beyond = Math.abs(b.x) > HALF_LENGTH || Math.abs(b.z) > HALF_WIDTH;
        if (beyond) expect(calls.list.length).toBeGreaterThanOrEqual(1);
        expect(calls.list.length).toBeLessThanOrEqual(n);
        for (const c of calls.list) {
          // Every reported segment ends beyond a line (the filter) and is a piece of this tick's path.
          expect(Math.abs(c.x1) > HALF_LENGTH || Math.abs(c.z1) > HALF_WIDTH).toBe(true);
        }
        for (let i = 1; i < calls.list.length; i++) {
          // Consecutive substeps: segments are contiguous when both were reported.
          const p = calls.list[i - 1]!;
          const c = calls.list[i]!;
          if (c.x0 === p.x1) expect([c.y0, c.z0]).toEqual([p.y1, p.z1]);
        }
        if (calls.list.length === n) {
          expect(calls.list[0]!.x0).toBe(b.px);
          expect(calls.list[n - 1]!.x1).toBe(b.x);
        }
      }
    }
  });

  it('the substep segment that crosses into the goal is reported with inNet = 0, later ones with inNet = end (no double goal)', () => {
    for (const end of [-1, 1]) {
      const s = scenarioWithBall({ x: end * 45, y: 1, z: 0.5, vx: end * 36, vy: 0.5 });
      calls.list.length = 0;
      const ev = createEventBuffer();
      let netTick = -1;
      for (let i = 0; i < 60; i++) {
        s.tick++;
        ev.begin(s.tick);
        ballTick(s, ev);
        if (findEvents(ev.toArray(), EventType.NET).length > 0) netTick = s.tick;
      }
      expect(s.ball.inNet).toBe(end);
      // The first segment whose end is wholly over the line inside the mouth.
      const plane = HALF_LENGTH + R;
      const idx = calls.list.findIndex((c) => end * c.x1 > plane && Math.abs(c.z1) < GW);
      expect(idx).toBeGreaterThanOrEqual(0);
      const scoring = calls.list[idx]!;
      expect(end * scoring.x0).toBeLessThanOrEqual(plane);
      expect(scoring.inNet).toBe(0);
      expect(scoring.tick).toBe(netTick);
      for (let i = idx + 1; i < calls.list.length; i++) expect(calls.list[i]!.inNet).toBe(end);
    }
  });

  it('a fast ball cannot skip a line: the segment crossing it is always reported (sweep of speeds and heights)', () => {
    let crossed = 0;
    for (let sp = 8; sp <= 40; sp += 0.7) {
      for (const [y, vy] of [[R, 0], [1.5, 3], [6, -2]] as [number, number][]) {
        for (const [z, dz] of [[25, 0.4], [-2, 0.3], [-25, -0.35]] as [number, number][]) {
          const s = scenarioWithBall({ x: 45, y, z, vx: sp, vy, vz: sp * dz });
          calls.list.length = 0;
          let beyondX = false;
          let beyondZ = false;
          for (let t = 0; t < 200; t++) {
            tickBall(s, 1);
            if (s.ball.x > HALF_LENGTH + R) beyondX = true;
            if (Math.abs(s.ball.z) > HALF_WIDTH + R) beyondZ = true;
          }
          const goalLine = calls.list.some((c) => c.x0 <= HALF_LENGTH + R && c.x1 > HALF_LENGTH + R);
          const touch = calls.list.some((c) => Math.abs(c.z0) <= HALF_WIDTH + R && Math.abs(c.z1) > HALF_WIDTH + R);
          if (beyondX) expect(goalLine).toBe(true);
          if (beyondZ) expect(touch).toBe(true);
          if (beyondX || beyondZ) crossed++;
        }
      }
    }
    expect(crossed).toBeGreaterThan(300);
  });

  it('keeps the ball inside the world bounds', () => {
    const s = scenarioWithBall({ x: 200, y: 500, z: -300, vx: 40, vy: 40, vz: -40 });
    tickBall(s, 5);
    const b = s.ball;
    expect(Math.abs(b.x)).toBeLessThanOrEqual(WORLD_MAX_X);
    expect(Math.abs(b.z)).toBeLessThanOrEqual(WORLD_MAX_Z);
    expect(b.y).toBeLessThanOrEqual(WORLD_MAX_Y);
    expect(b.y).toBeGreaterThanOrEqual(R);
  });

  it('ballTick gives exactly the kinematics of ballStepTick (SIM-01 predictBall == sim, bit for bit)', () => {
    let seed = 12345;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    for (let k = 0; k < 40; k++) {
      const over = {
        x: (rnd() - 0.5) * 110, y: R + rnd() * 6, z: (rnd() - 0.5) * 72,
        vx: (rnd() - 0.5) * 70, vy: (rnd() - 0.3) * 20, vz: (rnd() - 0.5) * 60,
        sx: (rnd() - 0.5) * 20, sy: (rnd() - 0.5) * 20, sz: (rnd() - 0.5) * 20,
      };
      const s = scenarioWithBall(over);
      const copy = createBallState();
      Object.assign(copy, s.ball);
      const ev = createEventBuffer();
      for (let t = 0; t < 240; t++) {
        s.tick++;
        ev.begin(s.tick);
        ballTick(s, ev);
        ballStepTick(copy, null);
        for (const f of KIN) if (!Object.is(s.ball[f], copy[f])) throw new Error(`diverged at ${k}/${t} on ${f}`);
      }
    }
  });

  it('is deterministic: the same start gives bit-identical states and events', () => {
    const run = (): { states: number[]; events: number[] } => {
      const states: number[] = [];
      const events: number[] = [];
      let seed = 777;
      const rnd = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (let k = 0; k < 60; k++) {
        const end = rnd() < 0.5 ? -1 : 1;
        const b = ball({
          x: end * (GL - 2 - rnd() * 20), y: R + rnd() * 2.5, z: (rnd() - 0.5) * 14,
          vx: end * (10 + rnd() * 30), vy: rnd() * 8, vz: (rnd() - 0.5) * 12, sy: (rnd() - 0.5) * 15, sz: (rnd() - 0.5) * 30,
        });
        const r = runBall(b, 240);
        for (const f of KIN) states.push(b[f] as number);
        for (const e of r.events) events.push(e.type, e.a, e.b, e.c, e.x, e.y, e.z);
      }
      return { states, events };
    };
    const a = run();
    const b = run();
    expect(a.states.length).toBe(b.states.length);
    for (let i = 0; i < a.states.length; i++) expect(Object.is(a.states[i], b.states[i])).toBe(true);
    expect(b.events).toEqual(a.events);
    expect(a.events.length).toBeGreaterThan(100);
  });

  it('stays inside the budget: ballTick < 0.05 ms per tick, worst case (fast ball at the goal frame)', () => {
    const s = scenarioWithBall({});
    const ev = createEventBuffer();
    const b = s.ball;
    const reset = (i: number): void => {
      b.x = 50 + (i % 7) * 0.1; b.y = 1 + (i % 5) * 0.3; b.z = 3.3 + (i % 3) * 0.2;
      b.vx = 36; b.vy = 1; b.vz = 2; b.sx = 0; b.sy = 5; b.sz = 0; b.inNet = 0; b.heldBy = -1;
    };
    const iters = 4000;
    let best = Infinity;
    for (let batch = 0; batch < 7; batch++) {
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) {
        if (i % 20 === 0) reset(i);
        ev.begin(i);
        ballTick(s, ev);
      }
      best = Math.min(best, (performance.now() - t0) / iters);
    }
    console.log(`ballTick worst-case: ${(best * 1000).toFixed(2)} us`);
    expect(best).toBeLessThan(0.05);
  });

  it('does not allocate per tick (child process with --expose-gc)', () => {
    const root = resolve(__dirname, '../..');
    const code = `
      const { createBallState } = await import(${JSON.stringify(resolve(root, 'src/contracts/state.ts'))});
      const { ballStepTick } = await import(${JSON.stringify(resolve(root, 'src/sim/ball/contact.ts'))});
      const { createEventBuffer } = await import(${JSON.stringify(resolve(root, 'src/sim/core/events.ts'))});
      const b = createBallState(); const ev = createEventBuffer(); ev.begin(1);
      const resets = {
        roll: (i) => { b.x = (i % 9) - 4; b.y = 0.11; b.z = 0; b.vx = 10 + (i % 7); b.vy = 0; b.vz = 1; b.grounded = 1; b.inNet = 0; },
        air: (i) => { b.x = 0; b.y = 3; b.z = (i % 5); b.vx = 10 + (i % 7); b.vy = 3; b.vz = 1; b.grounded = 0; b.inNet = 0; },
        goal: (i) => { b.x = 48 + (i % 9) * 0.5; b.y = 0.2 + (i % 11) * 0.25; b.z = -4 + (i % 13) * 0.6;
          b.vx = 30 + (i % 7); b.vy = (i % 5) - 1; b.vz = (i % 3) - 1; b.inNet = 0; b.grounded = 0; },
        board: (i) => { b.x = 50; b.y = 0.5; b.z = 30 + (i % 5); b.vx = 20; b.vy = 2; b.vz = 20; b.inNet = 0; b.grounded = 0; },
      };
      const loop = (r, n) => { for (let i = 0; i < n; i++) { if (i % 40 === 0) { r(i); ev.begin(i); } ballStepTick(b, null); } };
      for (let k = 0; k < 3; k++) for (const r of Object.values(resets)) loop(r, 20000);
      const out = {};
      for (const [name, r] of Object.entries(resets)) {
        let best = Infinity;
        for (let k = 0; k < 3; k++) {
          globalThis.gc();
          const h0 = process.memoryUsage().heapUsed;
          loop(r, 100000);
          best = Math.min(best, (process.memoryUsage().heapUsed - h0) / 100000);
        }
        out[name] = best;
      }
      console.log(JSON.stringify(out));
    `;
    // [TUN-7S] --single-threaded: synchronous compilation, load-independent bytes (tests/perf/qf-7r-alloc-flags.ts).
    const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: root, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    console.log(`ballStepTick bytes/tick: ${JSON.stringify(out)}`);
    // Open play (rolling, flying): nothing. Near the goal frame / boards: well under a byte per tick (V8 JIT noise).
    expect(out.roll).toBeLessThan(0.25);
    expect(out.air).toBeLessThan(0.25);
    expect(out.goal).toBeLessThan(2);
    expect(out.board).toBeLessThan(2);
  });

  it('scenario (real pipeline): a shot into an empty net emits NET once and the ball stays in', () => {
    const players = [];
    for (let i = 0; i < 22; i++) players.push({ slot: i, x: -45 + (i % 6), z: -25 + i * 2 });
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 44, y: 1, z: 0.8, vx: 32, vy: 1.6 }, players });
    let atNet: number[] | null = null;
    const events = runTicks(s, 45, undefined, {
      // The rules may move the ball later in the same tick (goal, or the RUL-11 watchdog while SIM-03 is a stub):
      // record the ball as ballTick left it, from the NET event.
      until: (_st, tickEvents) => {
        const n = tickEvents.find((e) => e.type === EventType.NET);
        if (n && !atNet) atNet = [n.a, n.x, n.y, n.z];
        return false;
      },
    });
    const nets = findEvents(events, EventType.NET);
    expect(nets).toHaveLength(1);
    expect(atNet).not.toBeNull();
    const [a, x, y, z] = atNet!;
    expect(a).toBe(1);
    expect(inNetBox(1, x!, y!, z!)).toBe(true);
    expect(x!).toBeGreaterThan(GL + R);
    expect(findEvents(events, EventType.POST)).toHaveLength(0);
  });

  it('DT sanity: one tick at rest moves nothing', () => {
    const s = scenarioWithBall({ x: 3, y: R, z: 4 });
    tickBall(s, 1);
    expect(s.ball.x).toBe(3);
    expect(DT).toBeCloseTo(1 / 60, 12);
  });
});
