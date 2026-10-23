/**
 * RUL-01 per-tick budget: rulesTick (machine + the live rules it calls in open play), the period-end deferral path,
 * kickOffTick, the CELEBRATE / DEJECTED handlers and displayClock neither allocate per tick nor cost more than a
 * small share of the 2.5 ms sim + AI budget.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { celebrateHandler, dejectedHandler, displayClock, kickOffTick, rulesTick, setupKickOff } from '../../src/sim/rules/machine';
import { makeScenario, runTicks } from '../harness/scenario';

const EV = createEventBuffer();
const step = (s: SimState) => { s.tick++; EV.begin(s.tick); s.match.phaseT++; s.ball.cross = 0; };

function bestMs(fn: () => void, n: number): number {
  let best = Infinity;
  for (let k = 0; k < 5; k++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    best = Math.min(best, (performance.now() - t0) / n);
  }
  return best;
}

describe('RUL-01 budget', () => {
  it('rulesTick in open play, during a deferred period end, kickOffTick and the cut-scene handlers are cheap', () => {
    const play = makeScenario({ phase: MatchPhase.IN_PLAY });
    play.tick = 5000;
    const deferred = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 40, y: 0.11, z: 0 } });
    deferred.tick = 5000;
    deferred.match.periodT = deferred.match.periodLen + 1;
    const ko = makeScenario({ phase: MatchPhase.KICK_OFF });
    EV.begin(ko.tick);
    setupKickOff(ko, 0, EV);
    const g = makeScenario({ phase: MatchPhase.CELEBRATION });
    runTicks(g, 5);
    for (let i = 0; i < 22; i++) { const p = g.players[i]!; p.actSlot = i < 11 && i !== 9 ? 9 : -1; p.actX = 40.5; p.actZ = 10.25; p.actA = i % 3; }
    g.players[9]!.act = 25;
    const clock = { min: 0, sec: 0, added: 0, period: 0 };
    const n = 4000;
    const tPlay = bestMs(() => { step(play); play.match.periodT = 100; rulesTick(play, EV); }, n);
    const tDef = bestMs(() => { step(deferred); deferred.match.extensionT = 0; rulesTick(deferred, EV); }, n);
    expect(deferred.match.phase).toBe(MatchPhase.IN_PLAY);
    const tKo = bestMs(() => { step(ko); ko.match.phaseT = 100; kickOffTick(ko, EV); }, n);
    const tCel = bestMs(() => {
      for (let i = 0; i < 11; i++) celebrateHandler.update(g, i, EV);
      for (let i = 11; i < 22; i++) dejectedHandler.update(g, i, EV);
    }, n);
    const tClk = bestMs(() => displayClock(play, clock), n);
    console.log(`RUL-01 ms/tick: rulesTick play ${tPlay.toFixed(5)}, deferred ${tDef.toFixed(5)}, kickOffTick ${tKo.toFixed(5)}, 22 handlers ${tCel.toFixed(5)}, displayClock ${tClk.toFixed(5)}`);
    expect(tPlay).toBeLessThan(0.05);
    expect(tDef).toBeLessThan(0.05);
    expect(tKo).toBeLessThan(0.02);
    expect(tCel).toBeLessThan(0.02);
    expect(tClk).toBeLessThan(0.005);
  });

  it('allocates nothing per tick (child process with --expose-gc)', () => {
    const root = resolve(__dirname, '../..');
    const imp = (p: string) => JSON.stringify(resolve(root, p));
    const code = `
      const { makeScenario, runTicks } = await import(${imp('tests/harness/scenario.ts')});
      const M = await import(${imp('src/sim/rules/machine.ts')});
      const { createEventBuffer } = await import(${imp('src/sim/core/events.ts')});
      const ev = createEventBuffer();
      const step = (s) => { s.tick++; ev.begin(s.tick); s.match.phaseT++; s.ball.cross = 0; };
      // Best of 5 after a long warm-up: JIT (re)compilation on a busy machine can leave a few KB on one pass.
      const measure = (fn) => {
        for (let i = 0; i < 50000; i++) fn();
        let best = Infinity;
        for (let k = 0; k < 5; k++) {
          globalThis.gc();
          const h0 = process.memoryUsage().heapUsed;
          for (let i = 0; i < 50000; i++) fn();
          best = Math.min(best, (process.memoryUsage().heapUsed - h0) / 50000);
        }
        return best;
      };
      const play = makeScenario({ phase: 2 }); play.tick = 5000; runTicks(play, 20);
      const deferred = makeScenario({ phase: 2, ball: { x: 40, y: 0.11, z: 0 } }); deferred.tick = 5000; runTicks(deferred, 5);
      deferred.match.periodT = deferred.match.periodLen + 1;
      const replay = makeScenario({ phase: 10 }); replay.tick = 5000; replay.match.goalTick = 5000;
      const ko = makeScenario({ phase: 1 }); ev.begin(ko.tick); M.setupKickOff(ko, 0, ev); runTicks(ko, 5);
      const g = makeScenario({ phase: 9 }); runTicks(g, 20);
      for (let i = 0; i < 22; i++) { const p = g.players[i]; p.actSlot = i < 11 && i !== 9 ? 9 : -1; p.actX = 40.5; p.actZ = 10.25; p.actA = i % 3; }
      g.players[9].act = 25;
      const clock = { min: 0, sec: 0, added: 0, period: 0 };
      const out = {
        play: measure(() => { step(play); play.match.periodT = 100; M.rulesTick(play, ev); }),
        deferred: measure(() => { step(deferred); deferred.match.extensionT = 0; M.rulesTick(deferred, ev); }),
        replay: measure(() => { step(replay); replay.match.phaseT = 5; replay.match.goalTick = replay.tick; M.rulesTick(replay, ev); }),
        kickOffTick: measure(() => { step(ko); ko.match.phaseT = 100; M.kickOffTick(ko, ev); }),
        celebrateLeader: measure(() => M.celebrateHandler.update(g, 9, ev)),
        celebrateJoiner: measure(() => M.celebrateHandler.update(g, 3, ev)),
        dejected: measure(() => M.dejectedHandler.update(g, 14, ev)),
        displayClock: measure(() => M.displayClock(play, clock)),
      };
      if (deferred.match.phase !== 2) throw new Error('deferred regime ended');
      console.log(JSON.stringify(out));
    `;
    // [TUN-7S] --single-threaded (tests/perf/qf-7r-alloc-flags.ts): synchronous compilation, so the measured bytes do not
    // depend on CPU load (this read > 1 B/tick once with the round-6 agents running; 0 when rerun alone).
    const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: root, encoding: 'utf8', timeout: 180_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    console.log(`RUL-01 bytes/tick: ${JSON.stringify(out)}`);
    // 'play' also runs RUL-08/09/10's live rules; allow V8 noise there.
    for (const [k, v] of Object.entries(out)) expect(v, k).toBeLessThan(k === 'play' ? 1 : 0.5);
  });
});
