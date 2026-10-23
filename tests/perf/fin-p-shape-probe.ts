/**
 * [FIN-P] Child-process probe for tests/unit/fin-p-warmup.test.ts (needs --allow-natives-syntax): does a state keep its
 * hidden classes (maps) through play? Builds a reference state with initMatch (kept untouched), then lets warmUpSim
 * play its scratch match (open play, then corners, free kicks with walls, a penalty, throw-ins and goal kicks for both
 * teams) on another initMatch state, and compares each played object's map with its twin in the reference. Prints JSON
 * { objects, changed: [names], ticks }. Without initMatch's settleStateShapes every object kind changes map in play (V8
 * Smi -> Double field representation on a field's first fraction), which deoptimises the optimised code that read it.
 *
 *   node --allow-natives-syntax --import tsx tests/perf/fin-p-shape-probe.ts
 */
import '../../tools/lib/env';
import type { SimState } from '../../src/contracts/state';
import { initMatch } from '../../src/sim/init';
import { warmUpSim } from '../../src/sim/warmup';
import { benchSetup } from '../../src/platform/benchHook';

const sameMap = new Function('a', 'b', 'return %HaveSameMap(a, b);') as (a: object, b: object) => boolean;

const ref = initMatch(benchSetup(2).config);
let played: SimState | null = null;
const ticks = warmUpSim((c) => { played = initMatch(c); return played; }, benchSetup(1).config);
const a = played as unknown as SimState;
const pairs: [string, object, object][] = [
  ['ball', a.ball, ref.ball], ['match', a.match, ref.match], ['restart', a.match.restart, ref.match.restart],
  ['advantage', a.match.advantage, ref.match.advantage], ['challenge', a.match.challenges[0]!, ref.match.challenges[0]!],
  ['player', a.players[3]!, ref.players[3]!], ['keeper', a.players[11]!, ref.players[11]!], ['attrs', a.attrs[3]!, ref.attrs[3]!],
  ['team', a.teams[0]!, ref.teams[0]!], ['homeX', a.teams[0]!.homeX, ref.teams[0]!.homeX], ['cpu', a.teams[0]!.cpu, ref.teams[0]!.cpu],
  ['cpuOut', a.teams[1]!.cpu.out, ref.teams[1]!.cpu.out], ['ctrl', a.ctrl[2]!, ref.ctrl[2]!], ['rng', a.rng, ref.rng],
];
const changed = pairs.filter(([, x, y]) => !sameMap(x, y)).map(([n]) => n);
console.log(JSON.stringify({ objects: pairs.length, changed, ticks }));
