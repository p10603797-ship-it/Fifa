/**
 * [FND-06] Allocation probe for the invariant checker (run by tests/unit/fnd-06-review-fixes.test.ts in a child
 * process): node --expose-gc --import tsx tests/harness/alloc-probe.ts [checks]
 * Prints JSON { <invariant name or 'all'>: bytes allocated per passing check }.
 */
import '../../tools/lib/env';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { createInvariantChecker, INVARIANT_NAMES, type InvariantName } from '../../src/sim/debug/invariants';
import { initMatch } from '../../src/sim/init';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc');
const cfg = createMatchConfig();
cfg.humans = [
  { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
  { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
];
const s = initMatch(cfg);
s.match.phase = MatchPhase.IN_PLAY;
s.match.prevPhase = MatchPhase.KICK_OFF;
s.ctrl[2]!.slot = 9; s.players[9]!.ctrl = 2;
s.ctrl[3]!.slot = 20; s.players[20]!.ctrl = 3;
s.teams[0]!.chaser = 10; s.teams[1]!.chaser = 15;
for (let i = 0; i < 22; i++) { s.players[i]!.x = -50 + i * 4.5; s.players[i]!.z = (i % 5) * 3; }

const n = Number(process.argv[2] ?? 20000);
const out: Record<string, number> = {};
for (const name of [...INVARIANT_NAMES, 'all'] as (InvariantName | 'all')[]) {
  const c = createInvariantChecker(name === 'all' ? 'all' : [name]);
  for (let i = 0; i < 5000; i++) {
    s.tick++;
    if (c.check(s, null).length > 0) throw new Error(`${name} failed on the probe state`);
  }
  gc();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < n; i++) { s.tick++; c.check(s, null); }
  out[name] = (process.memoryUsage().heapUsed - h0) / n;
}
console.log(JSON.stringify(out));
