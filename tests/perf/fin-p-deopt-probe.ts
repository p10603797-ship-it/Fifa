/**
 * [FIN-P] Child-process probe for tests/unit/fin-p-warmup.test.ts (run with --trace-deopt): does building the match's
 * state after the sim warm-up throw away the optimised code the warm-up produced? Plays warmUpSim (as the app's loading
 * screen does), prints a marker, builds the match state with initMatch (what the app does next), prints a marker, plays
 * `ticks` ticks of it and prints a last marker. The test counts V8's "marking dependent code ... for deoptimization"
 * lines between the markers.
 *
 *   node --trace-deopt --import tsx tests/perf/fin-p-deopt-probe.ts [ticks]
 */
import '../../tools/lib/env';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch, warmUpSim } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { setShapeSettling } from '../../src/sim/core/clone';
import { benchSetup } from '../../src/platform/benchHook';

// The production behaviour (initMatch and the copier settle state shapes in production builds only).
setShapeSettling(true);

const ticks = Number(process.argv[2] ?? 300);
const config = benchSetup(1).config;
warmUpSim((c) => initMatch(c), config);
console.log('FINP-MARK warmed');
const s = initMatch(config);
console.log('FINP-MARK built');
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();
for (let t = 0; t < ticks; t++) {
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  step(s, frames, ev);
}
console.log('FINP-MARK played');
