/**
 * SIM-12 allocates nothing per tick: aerialContacts (contests, AI starts, the prediction cache), the HEADER / VOLLEY
 * handler updates and aerialChance, over a ball dropping into a two-player duel, measured with gc exposed via v8
 * flags (the hot scan makes no calls with double arguments, which V8 would box), and the baseline run steps a scratch ball
 * once per tick through SIM-02 ballStepTick (what the memoised prediction integrates per tick; SIM-02 owns its
 * allocation profile). Long warm-up: the first runs measure JIT compilation, not the code. Also a time budget check.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ActionKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { aerialChance, aerialContacts } from '../../src/sim/kicks/aerial';
import { createBallState, type BallState } from '../../src/contracts/state';
import { copyBallState } from '../../src/sim/ball/flight';
import { ballStepTick, ballTick } from '../../src/sim/ball/contact';
import { launchCross, place, quietScene } from '../scenario/sim-12-helpers';

const ATT = 9;
const DEF = 13;

/** A duel scene and the ball state at the cross; loops replay the last 100 ticks of the flight over and over. */
function scene(): { s: SimState; ball0: BallState; tick0: number } {
  const s = quietScene({ seed: 5 });
  place(s, ATT, 42, -0.45);
  place(s, DEF, 42, 0.45);
  launchCross(s, 7, 30, 0, 42.6, 0, 0.9, ATT);
  const ev = createEventBuffer();
  for (let i = 0; i < 20; i++) { s.tick++; ev.begin(s.tick); ballTick(s, ev); }
  const ball0 = createBallState();
  copyBallState(ball0, s.ball);
  return { s, ball0, tick0: s.tick };
}

const SCRATCH = createBallState();

function run(sc: { s: SimState; ball0: BallState; tick0: number }, n: number, measure: boolean, ev = createEventBuffer()): void {
  const s = sc.s;
  for (let i = 0; i < n; i++) {
    const k = i % 100;
    if (k === 0) {
      copyBallState(s.ball, sc.ball0);
      for (const slot of [ATT, DEF]) {
        const p = s.players[slot]!;
        p.act = ActionKind.NONE; p.actT = 0; p.actDone = 0; p.x = 42; p.z = slot === ATT ? -0.45 : 0.45; p.vx = 0; p.vz = 0;
      }
    }
    s.tick++;
    ev.begin(s.tick);
    ballTick(s, ev);
    if (!measure) {
      if (k === 0) copyBallState(SCRATCH, sc.ball0);
      ballStepTick(SCRATCH, null);
      continue;
    }
    for (const slot of [ATT, DEF]) {
      const p = s.players[slot]!;
      if (p.act !== ActionKind.NONE) {
        p.actT++;
        ACTION_HANDLERS[p.act]!.update(s, slot, ev);
        if (p.actT >= p.actDur) p.act = ActionKind.NONE;
      }
    }
    aerialChance(s, ATT);
    aerialContacts(s, ev);
  }
}

describe('SIM-12 allocation and cost', () => {
  it('aerialContacts, the handlers and aerialChance allocate nothing per tick', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const sc = scene();
    const ev = createEventBuffer();
    const n = 20000;
    run(sc, 30000, true, ev);
    run(sc, 10000, false, ev);
    const measure = (withAerial: boolean): number => {
      run(sc, 5000, withAerial, ev);
      gc();
      const h0 = process.memoryUsage().heapUsed;
      run(sc, n, withAerial, ev);
      return (process.memoryUsage().heapUsed - h0) / n;
    };
    // Minimum of three rounds: GC and JIT noise only ever add bytes.
    let base = 1e9;
    let bytes = 1e9;
    for (let r = 0; r < 3; r++) {
      const b0 = measure(false);
      const b1 = measure(true);
      if (b0 < base) base = b0;
      if (b1 - b0 < bytes) bytes = b1 - b0;
    }
    console.log(`SIM-12 allocation: ${bytes.toFixed(1)} B/tick over baseline ${base.toFixed(1)} B/tick`);
    // An object or array per tick would be >= 16 bytes per tick; allow GC/JIT noise below that.
    expect(bytes, `${bytes.toFixed(1)} B/tick (baseline ${base.toFixed(1)})`).toBeLessThan(16);
  }, 120_000);

  it('per-tick cost of the aerial stage stays small during a contested cross', () => {
    const sc = scene();
    run(sc, 2000, true);
    const n = 5000;
    const t0 = performance.now();
    run(sc, n, true);
    const withMs = (performance.now() - t0) / n;
    const t1 = performance.now();
    run(sc, n, false);
    const baseMs = (performance.now() - t1) / n;
    const us = (withMs - baseMs) * 1000;
    console.log(`SIM-12 aerial stage: ${us.toFixed(1)} us/tick (ball flight + duel + AI scan; baseline ball tick ${(baseMs * 1000).toFixed(1)} us)`);
    // A loose guard against pathological regressions (the shared test machine is often heavily loaded; typical
    // unloaded cost is a few microseconds).
    expect(us).toBeLessThan(400);
  }, 120_000);
});
