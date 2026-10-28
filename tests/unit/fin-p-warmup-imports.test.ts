/**
 * [FIN-P skeptic] sim/init.ts must not import the tick pipeline.
 *
 * The sim warm-up (FIN-P) first lived in init.ts and imported sim/step.ts and rules/restart from there. That changed the
 * evaluation order of the sim's module graph for every importer of init.ts (the scenario harness, the app), and the
 * tai-08 carrier scenarios' module doubles (vi.mock of kicks/lob, kicks/shot, kicks/through) were bypassed through the
 * kicks <-> actions/registry cycle: the real starter ran, the recording double never saw the kick, and three tests failed
 * (clearance, cross, lob pass in tests/scenario/tai-08-carrier.test.ts; they passed at f2e442b, before the warm-up).
 * The implementation now lives in sim/step.ts and binds itself to init.ts (bindSimWarmUp).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { simWarmedTicks, warmUpSim } from '../../src/sim/init';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Relative runtime imports of a source file (type-only imports skipped), resolved to files. */
function deps(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /^(import|export)\s+(type\s+)?[^;]*?from\s+'(\.[^']+)'|^import\s+'(\.[^']+)'/gms;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    if (m[2]) continue;
    const spec = m[3] ?? m[4]!;
    const p = normalize(join(dirname(file), spec));
    for (const c of [`${p}.ts`, join(p, 'index.ts')]) if (existsSync(c)) { out.push(c); break; }
  }
  return out;
}

function reachable(from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...deps(f));
  }
  return seen;
}

describe('fin-p: the warm-up does not change the sim module graph', () => {
  it('fin-p: sim/init.ts reaches neither sim/step.ts nor the controller resolver at load (tai-08 module doubles keep working)', () => {
    const r = reachable(join(ROOT, 'src/sim/init.ts'));
    expect(r.size).toBeGreaterThan(10);
    expect(r.has(join(ROOT, 'src/sim/step.ts'))).toBe(false);
    expect(r.has(join(ROOT, 'src/sim/control/resolveActions.ts'))).toBe(false);
  });

  it('fin-p: without sim/step.ts loaded the warm-up is a no-op; loading it binds the implementation', async () => {
    expect(warmUpSim(() => { throw new Error('not bound: never builds a state'); })).toBe(0);
    expect(simWarmedTicks()).toBe(0);
    await import('../../src/sim/step');
    const { initMatch } = await import('../../src/sim/init');
    const { benchSetup } = await import('../../src/platform/benchHook');
    expect(warmUpSim((c) => initMatch(c), benchSetup(1).config)).toBeGreaterThan(1000);
    expect(simWarmedTicks()).toBeGreaterThan(1000);
  }, 120_000);
});
