/**
 * [SGN-04] Does the benchmark match go through the worst cases? (BRIEF section 13 "Proving it": the fixed-seed,
 * 90-second bot-v-bot match runs "through the worst cases: a crowded penalty area, a corner, a goal with net ripple, a
 * replay".) The benchmark is deterministic: the app plays benchSetup(seed) with no input, so this probe steps the same
 * match headless and reports what happens inside the measured window on a 60 fps device (benchHook: warm-up of 5 s
 * and at least 300 ticks, then 90 s of play; cut-scenes play in full, nobody skips): the phases seen, whether a
 * corner, a goal and its replay fall inside the window, and how crowded the busiest penalty area gets.
 *
 *   npx tsx tests/perf/sgn-04-bench-coverage.ts                  the shipped seed (BENCH_DEFAULTS.seed)
 *   npx tsx tests/perf/sgn-04-bench-coverage.ts --seed 12345     another seed
 *   npx tsx tests/perf/sgn-04-bench-coverage.ts --search 300     the first seeds (from 1) whose window covers every case
 * Exit 1 when the checked seed misses a case (not with --search).
 * [FIN-P] `net`: the ball entered a net in the window (an EventType.NET: the renderer's net ripple), required with the
 * goal; the CLI runs only when invoked directly, so tests/perf/fin-p-bench-coverage.test.ts imports coverage().
 */
import '../../tools/lib/env';
import { HALF_LENGTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { pathToFileURL } from 'node:url';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { BENCH_DEFAULTS, benchSetup } from '../../src/platform/benchHook';

/** Players inside one penalty area that count as a crowded box (a corner or a box free kick brings 12-16). */
export const CROWDED = 12;
const WARM_TICKS = Math.max(BENCH_DEFAULTS.warmupTicks, BENCH_DEFAULTS.warmupSeconds * 60);
const WINDOW_TICKS = BENCH_DEFAULTS.seconds * 60;
const BOX_X = HALF_LENGTH - PENALTY_AREA_DEPTH;

export interface Coverage {
  seed: number; corner: number; goal: number; net: number; replay: number; crowdedTicks: number; maxInBox: number; phases: string; ok: boolean;
}

const NAMES = ['pre', 'kickOff', 'inPlay', 'throwIn', 'goalKick', 'corner', 'freeKick', 'penalty', 'goal', 'celebration', 'replay', 'halfTime', 'fullTime', 'etBreak', 'shootOut', 'post'];

export function coverage(seed: number): Coverage {
  const s = initMatch(benchSetup(seed).config);
  const frames = [createInputFrame(), createInputFrame()];
  const ev = createEventBuffer();
  let corner = 0, goal = 0, net = 0, replay = 0, crowdedTicks = 0, maxInBox = 0, last = -1;
  const phases: string[] = [];
  for (let t = 0; t < WARM_TICKS + WINDOW_TICKS; t++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    step(s, frames, ev);
    if (t < WARM_TICKS) continue;
    const ph = s.match.phase;
    if (ph !== last) { phases.push(`${(t / 60).toFixed(0)}s:${NAMES[ph] ?? ph}`); last = ph; }
    if (ph === MatchPhase.CORNER) corner = 1;
    if (ph === MatchPhase.GOAL) goal = 1;
    if (ph === MatchPhase.REPLAY) replay = 1;
    for (let e = 0; e < ev.count; e++) if (ev.get(e).type === EventType.NET) net = 1;
    for (let side = -1; side <= 1; side += 2) {
      let n = 0;
      for (let i = 0; i < 22; i++) {
        const p = s.players[i]!;
        if (p.x * side > BOX_X && Math.abs(p.z) < PENALTY_AREA_HALF_WIDTH) n++;
      }
      if (n > maxInBox) maxInBox = n;
      if (n >= CROWDED) crowdedTicks++;
    }
  }
  const ok = corner === 1 && goal === 1 && net === 1 && replay === 1 && crowdedTicks > 0;
  return { seed, corner, goal, net, replay, crowdedTicks, maxInBox, phases: phases.join(' '), ok };
}

const argv = process.argv.slice(2);
const at = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!invokedDirectly) {
  // imported (tests): no CLI
} else if (at('search') !== undefined) {
  const n = Number(at('search'));
  for (let seed = 1; seed <= n; seed++) {
    const c = coverage(seed);
    if (c.ok) console.log(JSON.stringify(c));
  }
} else {
  const c = coverage(Number(at('seed') ?? BENCH_DEFAULTS.seed));
  console.log(JSON.stringify(c));
  process.exit(c.ok ? 0 : 1);
}
