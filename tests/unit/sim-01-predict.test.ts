/**
 * SIM-01 predictions: predictBall equals the sim bit-for-bit (ballTick on a real SimState), landIndex semantics,
 * input untouched, count clamping, held balls; ticksToHeight against brute-force stepping.
 */
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, GOAL_HALF_WIDTH, HALF_LENGTH } from '../../src/contracts/constants';
import { createBallState, createMatchConfig, type BallState, type SimState } from '../../src/contracts/state';
import { createBallPrediction, MAX_PREDICT_TICKS } from '../../src/contracts/systems';
import { ballStepTick, ballTick } from '../../src/sim/ball/contact';
import { copyBallState, LAND_HEIGHT, launchSpin, predictBall, ticksToHeight } from '../../src/sim/ball/flight';
import { createEventBuffer } from '../../src/sim/core/events';
import { createV3 } from '../../src/sim/core/vec';
import { initMatch } from '../../src/sim/init';

/** Small deterministic LCG for test case generation (tests only). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}

function setBall(b: BallState, x: number, y: number, z: number, vx: number, vy: number, vz: number, sx = 0, sy = 0, sz = 0): BallState {
  b.x = x; b.y = y; b.z = z; b.px = x; b.py = y; b.pz = z;
  b.vx = vx; b.vy = vy; b.vz = vz; b.sx = sx; b.sy = sy; b.sz = sz;
  b.grounded = y <= BALL_RADIUS + 1e-9 && vy === 0 ? 1 : 0;
  b.owner = -1; b.heldBy = -1; b.inNet = 0; b.bounces = 0;
  return b;
}

let state: SimState | null = null;
function sim(): SimState {
  if (!state) state = initMatch(createMatchConfig());
  return state;
}

/** Run the real per-tick ball update n ticks and compare every sample with predictBall, bit-exact. */
function expectPredictionMatchesSim(label: string, n: number): void {
  const s = sim();
  const ev = createEventBuffer();
  const pred = createBallPrediction();
  predictBall(s.ball, n, pred);
  expect(pred.count).toBe(Math.min(n, MAX_PREDICT_TICKS));
  for (let i = 0; i < pred.count; i++) {
    ev.begin(i);
    ballTick(s, ev);
    if (!(Object.is(pred.x[i], s.ball.x) && Object.is(pred.y[i], s.ball.y) && Object.is(pred.z[i], s.ball.z))) {
      throw new Error(`${label}: tick ${i}: predicted (${pred.x[i]}, ${pred.y[i]}, ${pred.z[i]}) vs sim (${s.ball.x}, ${s.ball.y}, ${s.ball.z})`);
    }
  }
}

describe('SIM-01 predictBall == sim (bit-exact)', () => {
  it('lofted, driven, rolling, curled and spinning balls over 180 ticks', () => {
    const b = sim().ball;
    const o = createV3();
    const cases: [string, () => void][] = [
      ['lob', () => setBall(b, -10, BALL_RADIUS, 4, 14, 12, -3)],
      ['ground pass', () => setBall(b, 0, BALL_RADIUS, 0, 15, 0, 2)],
      ['hard shot', () => setBall(b, 30, 0.3, 1, 34, 2, -1.5)],
      ['curled free kick', () => setBall(b, 25, BALL_RADIUS, -6, 24, 7, 4, 0, 9, 0)],
      ['chip with backspin', () => { launchSpin(1, 0, 0, 12, o); setBall(b, 35, BALL_RADIUS, 0, 9, 9, 0, o.x, o.y, o.z); }],
      ['dropping ball', () => setBall(b, 5, 6, -2, 0, 0, 0)],
      ['at rest', () => setBall(b, 3, BALL_RADIUS, 3, 0, 0, 0)],
      ['shot at the post', () => setBall(b, HALF_LENGTH - 15, 0.5, GOAL_HALF_WIDTH - 1, 30, 1.5, 0.9)],
      ['toward a corner flag and boards', () => setBall(b, 40, BALL_RADIUS, 25, 25, 3, 20)],
    ];
    for (const [label, init] of cases) {
      init();
      expectPredictionMatchesSim(label, MAX_PREDICT_TICKS);
    }
  });

  it('randomised free-ball states (seeded)', () => {
    const rnd = lcg(0x51301);
    const b = sim().ball;
    for (let k = 0; k < 120; k++) {
      const x = -50 + rnd() * 100;
      const z = -32 + rnd() * 64;
      const y = rnd() < 0.4 ? BALL_RADIUS : BALL_RADIUS + rnd() * 8;
      const sp = rnd() * 36;
      const dir = rnd() * Math.PI * 2;
      const el = rnd() < 0.4 ? 0 : rnd() * 1.2;
      setBall(b, x, y, z, sp * Math.cos(el) * Math.cos(dir), y === BALL_RADIUS && el === 0 ? 0 : sp * Math.sin(el),
        sp * Math.cos(el) * Math.sin(dir), (rnd() - 0.5) * 20, (rnd() - 0.5) * 30, (rnd() - 0.5) * 20);
      expectPredictionMatchesSim(`random #${k}`, 1 + Math.floor(rnd() * MAX_PREDICT_TICKS));
    }
  });

  it('does not modify the input ball', () => {
    const b = createBallState();
    setBall(b, 1, 3, 2, 10, 5, -4, 1, 2, 3);
    const before = createBallState();
    copyBallState(before, b);
    predictBall(b, 120, createBallPrediction());
    ticksToHeight(b, 1);
    expect(b).toEqual(before);
  });

  it('copyBallState copies every BallState field', () => {
    const src = createBallState();
    const keys = Object.keys(src) as (keyof BallState)[];
    let v = 1;
    for (const k of keys) (src as unknown as Record<string, number>)[k] = v++;
    const dst = createBallState();
    copyBallState(dst, src);
    expect(dst).toEqual(src);
  });

  it('count is clamped to [0, MAX_PREDICT_TICKS] and floored', () => {
    const b = createBallState();
    setBall(b, 0, BALL_RADIUS, 0, 10, 0, 0);
    const p = createBallPrediction();
    predictBall(b, 1000, p);
    expect(p.count).toBe(MAX_PREDICT_TICKS);
    predictBall(b, 0, p);
    expect(p.count).toBe(0);
    expect(p.landIndex).toBe(-1);
    predictBall(b, -5, p);
    expect(p.count).toBe(0);
    predictBall(b, Number.NaN, p);
    expect(p.count).toBe(0);
    predictBall(b, 12.9, p);
    expect(p.count).toBe(12);
  });

  it('a ball held in a keeper\'s hands does not move in the prediction (the sim skips it too)', () => {
    const s = sim();
    setBall(s.ball, -48, 1.2, 0.5, 0, 0, 0);
    s.ball.heldBy = 0;
    const p = createBallPrediction();
    predictBall(s.ball, 30, p);
    const ev = createEventBuffer();
    for (let i = 0; i < 30; i++) {
      ballTick(s, ev);
      expect(p.x[i]).toBe(s.ball.x);
      expect(p.y[i]).toBe(s.ball.y);
      expect(p.z[i]).toBe(s.ball.z);
    }
    expect(p.landIndex).toBe(-1);
    s.ball.heldBy = -1;
  });
});

describe('SIM-01 predictBall landIndex', () => {
  it('lob: first sample at or below 0.5 m after descending from above', () => {
    const b = createBallState();
    setBall(b, 0, BALL_RADIUS, 0, 12, 10, 0);
    const p = createBallPrediction();
    predictBall(b, MAX_PREDICT_TICKS, p);
    const li = p.landIndex;
    expect(li).toBeGreaterThan(0);
    expect(p.y[li]).toBeLessThanOrEqual(LAND_HEIGHT);
    expect(p.y[li - 1]).toBeGreaterThan(LAND_HEIGHT);
    for (let i = 0; i < li; i++) {
      // Nothing earlier qualifies: every earlier sample at or below 0.5 m comes before the ball was ever above it.
      if (p.y[i]! <= LAND_HEIGHT) for (let j = 0; j < i; j++) expect(p.y[j]).toBeLessThanOrEqual(LAND_HEIGHT);
    }
  });

  it('ground balls and low skimmers never "land" (-1)', () => {
    const b = createBallState();
    const p = createBallPrediction();
    setBall(b, 0, BALL_RADIUS, 0, 18, 0, 0);
    predictBall(b, MAX_PREDICT_TICKS, p);
    expect(p.landIndex).toBe(-1);
    setBall(b, 0, 0.3, 0, 25, 1, 0); // apex below 0.5 m
    predictBall(b, MAX_PREDICT_TICKS, p);
    expect(p.landIndex).toBe(-1);
  });

  it('a ball already above 0.5 m and falling lands on the first sample at or below it', () => {
    const b = createBallState();
    const p = createBallPrediction();
    setBall(b, 0, 0.55, 0, 3, -6, 0);
    predictBall(b, 10, p);
    expect(p.landIndex).toBe(0);
    expect(p.y[0]).toBeLessThanOrEqual(LAND_HEIGHT);
  });

  it('a lob that runs past the horizon has no landing yet', () => {
    const b = createBallState();
    const p = createBallPrediction();
    setBall(b, 0, BALL_RADIUS, 0, 5, 25, 0);
    predictBall(b, 30, p);
    expect(p.landIndex).toBe(-1);
    for (let i = 0; i < 30; i++) expect(p.y[i]).toBeGreaterThan(LAND_HEIGHT);
  });
});

describe('SIM-01 ticksToHeight', () => {
  /** Brute force with the sim's own step on a copy. */
  function brute(b0: BallState, h: number): number {
    if (b0.y <= h && b0.vy <= 0) return 0;
    const b = createBallState();
    copyBallState(b, b0);
    let prev = b.y;
    for (let k = 1; k <= 300; k++) {
      ballStepTick(b, null);
      if (b.y <= h && (b.y < prev || b.vy <= 0)) return k;
      prev = b.y;
    }
    return -1;
  }

  it('matches brute-force stepping for rising, falling and curling balls at several heights', () => {
    const rnd = lcg(77);
    const b = createBallState();
    for (let k = 0; k < 200; k++) {
      setBall(b, -20 + rnd() * 40, BALL_RADIUS + rnd() * 5, -10 + rnd() * 20, (rnd() - 0.5) * 40, (rnd() - 0.3) * 20,
        (rnd() - 0.5) * 30, 0, (rnd() - 0.5) * 18, 0);
      const h = BALL_RADIUS + rnd() * 3;
      expect(ticksToHeight(b, h), `case ${k}`).toBe(brute(b, h));
    }
  });

  it('a high ball comes down through head height once, after its apex', () => {
    const b = createBallState();
    setBall(b, 0, BALL_RADIUS, 0, 10, 14, 0);
    const k = ticksToHeight(b, 2);
    expect(k).toBeGreaterThan(60);
    const c = createBallState();
    copyBallState(c, b);
    for (let i = 0; i < k; i++) ballStepTick(c, null);
    expect(c.y).toBeLessThanOrEqual(2);
    expect(c.vy).toBeLessThan(0);
  });

  it('already at or below h and not rising: 0; never (rolling ball, h below the ball radius, held): -1', () => {
    const b = createBallState();
    setBall(b, 0, 1.0, 0, 5, -1, 0);
    expect(ticksToHeight(b, 1.5)).toBe(0);
    setBall(b, 0, BALL_RADIUS, 0, 10, 0, 0);
    expect(ticksToHeight(b, 1)).toBe(0);
    expect(ticksToHeight(b, 0.05)).toBe(-1);
    setBall(b, 0, 1.4, 0, 0, 0, 0);
    b.heldBy = 0;
    expect(ticksToHeight(b, 1)).toBe(-1);
    expect(ticksToHeight(b, Number.NaN)).toBe(-1);
  });

  it('a ball that stays above h for more than 300 ticks reports -1', () => {
    const b = createBallState();
    setBall(b, 0, BALL_RADIUS, 0, 0, 39, 0); // straight up: ~6 s in the air
    expect(ticksToHeight(b, 0.5)).toBe(-1);
    expect(ticksToHeight(b, 45)).toBeGreaterThan(0); // but it does come back down through 45 m in time
  });
});
