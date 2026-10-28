/**
 * [FIN-P skeptic] Every event buffer shares one set of methods, so code optimised against one buffer (the sim warm-up's)
 * keeps its optimised code when it emits into another (the match's).
 *
 * createEventBuffer built an object literal of closures per call: every buffer had its own `begin` / `emit` functions.
 * The loading-screen warm-up (sim/init.ts warmUpSim) plays with its own buffer, so V8 optimised `step` and every emitting
 * function with the warm-up buffer's functions as call targets; in the match each of them deoptimised ("wrong call
 * target") the first time it called the match's buffer: `step` on the first tick (events.begin), then each function at
 * its first emit in play (a first interception, first-time pass, post hit, ...: 6 in the bench window), each followed by
 * unoptimised ticks until re-optimised. Now one class (sim/core/events.ts SimEventBuffer).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EventType } from '../../src/contracts/events';
import { createEventBuffer } from '../../src/sim/core/events';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

describe('fin-p: event buffers share their methods (no deopt at the first emit of the match)', () => {
  it('fin-p: two event buffers have the same begin / emit / get functions, and stay independent', () => {
    const a = createEventBuffer(), b = createEventBuffer(2);
    expect(a.emit).toBe(b.emit);
    expect(a.begin).toBe(b.begin);
    expect(a.get).toBe(b.get);
    a.begin(7);
    b.begin(9);
    a.emit(EventType.GOAL, 1, 2, 3, 4, 5.5, 6.5, 7.5);
    b.emit(EventType.NET);
    b.emit(EventType.NET);
    b.emit(EventType.NET); // over capacity 2: dropped
    expect(a.count).toBe(1);
    expect(b.count).toBe(2);
    expect(b.dropped).toBe(1);
    expect(a.dropped).toBe(0);
    expect({ ...a.get(0) }).toEqual({ type: EventType.GOAL, tick: 7, a: 1, b: 2, c: 3, d: 4, x: 5.5, y: 6.5, z: 7.5 });
    expect(b.get(1).tick).toBe(9);
    expect(a.toArray()).toEqual([{ type: EventType.GOAL, tick: 7, a: 1, b: 2, c: 3, d: 4, x: 5.5, y: 6.5, z: 7.5 }]);
  });

  it('fin-p: the bench match after the sim warm-up has no "wrong call target" deopt (was step + 5 emitting functions)', () => {
    const r = spawnSync(process.execPath, ['--trace-deopt', '--import', 'tsx', 'tests/perf/fin-p-deopt-probe.ts', '5400'],
      { cwd: ROOT, encoding: 'utf8', timeout: 150_000, maxBuffer: 256 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const lines = r.stdout.split('\n');
    const built = lines.findIndex((l) => l.startsWith('FINP-MARK built'));
    const played = lines.findIndex((l) => l.startsWith('FINP-MARK played'));
    expect(built).toBeGreaterThan(0);
    expect(played).toBeGreaterThan(built);
    const wrong = lines.slice(built, played).filter((l) => l.includes('bailout') && l.includes('wrong call target'));
    expect(wrong.map((l) => /JSFunction (\S+)/.exec(l)?.[1] ?? l)).toEqual([]);
  }, 180_000);
});
