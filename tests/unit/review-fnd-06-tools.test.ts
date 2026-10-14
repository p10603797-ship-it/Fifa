/**
 * Independent review of FND-06: adversarial tests for the soak / fuzz tooling (bands, reproduction command, worker
 * pool failure modes), hostile replays through the real pipeline, replay comparison, postbuild and bench budgets.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { ControllerKind, Difficulty } from '../../src/contracts/enums';
import { createMatchConfig, type MatchConfig } from '../../src/contracts/state';
import { computeBenchResult, type BenchSamples } from '../../src/platform/benchHook';
import { playReplay, type Replay } from '../../src/sim/replay';
import { createMatchStats, runMatch } from '../../tools/headless';
import { createHostile, type HostileKind } from '../../tools/lib/hostile';
import type { MatchReport } from '../../tools/lib/jobs';
import { bands } from '../../tools/lib/report';
import { compareReplays } from '../../tools/replay-inspect';

const ROOT = resolve(__dirname, '../..');
const TMP = mkdtempSync(join(tmpdir(), 'review-fnd06-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function node(args: string[], timeout = 180_000): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout, env: { ...process.env, FORCE_COLOR: '0' } });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs');

// ---------------------------------------------------------------- statistics bands

function report(homePct: number, goals: [number, number] = [1, 1]): MatchReport {
  const config = createMatchConfig();
  config.difficulty = Difficulty.PROFESSIONAL;
  const stats = createMatchStats();
  stats.goals = goals;
  stats.shots = [10, 10];
  stats.passes = [200, 200];
  stats.passesCompleted = [160, 160];
  stats.fouls = [5, 5];
  stats.possessionTicks = [homePct * 100, (100 - homePct) * 100];
  stats.possessionPct = [homePct, 100 - homePct];
  return { finished: true, config, stats } as unknown as MatchReport;
}

describe('review FND-06 statistics bands', () => {
  it('possession band passes for evenly shared matches', () => {
    const b = bands(Array.from({ length: 20 }, () => report(50))).bands.filter((x) => x.name.startsWith('possession'));
    expect(b.length).toBeGreaterThan(0);
    expect(b.every((x) => x.pass)).toBe(true);
  });

  it('possession band FAILS when every match is 80/20 (alternating which side dominates)', () => {
    // Brief section 7: "Possession 40-60% for each side". Averaging the home share over matches always lands near 50
    // for a symmetric population, so a band on that average can never fail; lopsided matches must fail it.
    const pop = Array.from({ length: 20 }, (_, i) => report(i % 2 === 0 ? 80 : 20));
    const b = bands(pop).bands.filter((x) => x.name.startsWith('possession'));
    expect(b.length).toBeGreaterThan(0);
    expect(b.some((x) => !x.pass)).toBe(true);
  });
});

// ---------------------------------------------------------------- soak CLI failure modes

describe('review FND-06 soak CLI', () => {
  it('the printed reproduction command does not enforce population bands on the single re-run match', () => {
    // fmtFailure prints "re-run: npx tsx tools/soak.ts --seed S --enforce E --halfMinutes M --only K". With --only the
    // run has one match, and section 7 bands are enforced on that single match (not --short), so a reproduction
    // reports RESULT: FAIL / exit 1 on the bands even when the match itself passes the enforced set.
    // Since Wave 2 a single short match passes, so no failure prints a re-run line any more: build the same command
    // fmtFailure would print (rerunCommand + --only K) and check it.
    const rerun = node([TSX, 'tools/soak.ts', '--seed', '1', '--enforce', 'all', '--halfMinutes', '2', '--only', '0', '--quiet', '--max-replays', '0']);
    expect(rerun.out).toContain('[reported, not enforced]');
  }, 200_000);

  it('a single passing match reproduced with --only exits 0', () => {
    const r = node([TSX, 'tools/soak.ts', '--seed', '1', '--enforce', 'core', '--halfMinutes', '2', '--only', '3', '--quiet', '--max-replays', '0']);
    expect(r.out).toContain('failures: none');
    expect(r.out).toContain('RESULT: PASS');
    expect(r.code).toBe(0);
  }, 200_000);

  it('exits non-zero (never silently 0) when the worker threads fail to start', () => {
    // A worker that dies before posting "ready" is dropped without a report and never replaced; with every worker
    // gone the pool promise never settles, the event loop empties and the process exits 0 after printing only the
    // header line, so `npm run verify` would pass without running a single match.
    const dir = join(TMP, 'failworker');
    mkdirSync(dir, { recursive: true });
    const preload = join(dir, 'fail.mjs');
    writeFileSync(preload, "import { isMainThread } from 'node:worker_threads';\nif (!isMainThread) throw new Error('simulated worker boot failure');\n");
    const r = node(['--import', 'tsx', '--import', preload, 'tools/soak.ts', '--short', '--matches', '2', '--workers', '2', '--quiet', '--max-replays', '0'], 120_000);
    expect(r.code).not.toBeNull();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/RESULT: FAIL|worker/i);
  }, 150_000);
});

// ---------------------------------------------------------------- hostile replays through the real pipeline

function twoHumans(seed: number): MatchConfig {
  const c = createMatchConfig();
  c.seed = seed;
  c.halfMinutes = 2;
  c.humans = [
    { kind: ControllerKind.HUMAN, side: 0, assist: 0, autoSwitch: 1, fastPower: 0 },
    { kind: ControllerKind.HUMAN, side: 1, assist: 2, autoSwitch: 0, fastPower: 1 },
  ];
  return c;
}

describe('review FND-06 hostile input replays', () => {
  const kinds: HostileKind[] = ['extremes', 'allButtons', 'gestures', 'commands', 'mixed'];
  for (const kind of kinds) {
    it(`a '${kind}' fuzz match replays identically after a JSON round trip`, () => {
      const g0 = createHostile(kind, 1234, 0);
      const g1 = createHostile(kind, 5678, 1);
      const r = runMatch({
        config: twoHumans(99), maxTicks: 900, checker: 'none', record: true,
        inputs: (tick, s, out) => { g0.fill(tick, s, out[0]!); g1.fill(tick, s, out[1]!); },
      });
      expect(r.exception).toBeUndefined();
      const replay = JSON.parse(JSON.stringify(r.replay)) as Replay;
      const p = playReplay(replay);
      expect(p.divergedAt).toBe(-1);
      expect(p.hash).toBe(r.hash);
    });
  }

  it('compareReplays names the first tick whose inputs differ', () => {
    const base = (tick: number): number => (tick % 7 === 0 ? 127 : -127);
    const a = runMatch({ config: twoHumans(3), maxTicks: 200, checker: 'none', record: true, inputs: (t, _s, out) => { out[0]!.mx = base(t); } });
    const b = runMatch({
      config: twoHumans(3), maxTicks: 200, checker: 'none', record: true,
      inputs: (t, _s, out) => { out[0]!.mx = base(t); if (t === 77) out[1]!.buttons = 1; },
    });
    const c = compareReplays(a.replay!, b.replay!);
    expect(c.inputTick).toBe(77);
    const same = compareReplays(a.replay!, a.replay!);
    expect(same).toEqual({ inputTick: -1, stateTick: -1, diff: null });
  });
});

// ---------------------------------------------------------------- postbuild

describe('review FND-06 postbuild', () => {
  it('fails without dist/index.html, passes a small file, fails a file over 4 MB gzip', () => {
    const missing = join(TMP, 'dist-missing');
    mkdirSync(missing, { recursive: true });
    expect(node(['tools/postbuild.mjs', missing], 60_000).code).toBe(1);

    const small = join(TMP, 'dist-small');
    mkdirSync(small, { recursive: true });
    // postbuild rejects a page with no inline module script (the game code would be missing).
    writeFileSync(join(small, 'index.html'), '<!doctype html><title>x</title>' + '<p>x</p>'.repeat(1000) + '<script type="module">1</script>');
    const ok = node(['tools/postbuild.mjs', small], 60_000);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('postbuild: PASS');

    const big = join(TMP, 'dist-big');
    mkdirSync(big, { recursive: true });
    writeFileSync(join(big, 'index.html'), randomBytes(4 * 1024 * 1024 + 64 * 1024)); // incompressible
    expect(node(['tools/postbuild.mjs', big], 60_000).code).toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------- bench budgets are inclusive

function samples(o: Partial<BenchSamples> = {}): BenchSamples {
  const frameMs = new Float64Array(600).fill(1000 / 60);
  return {
    frameMs, frames: 600, drawCallsSum: 600 * 40, drawCallsMax: 40, trianglesSum: 600 * 1e5, trianglesMax: 1e5, renderSamples: 600,
    resolutionScale: 0.75, qualityTier: 1, simMsAvg: 1, simMsMax: 2, ticks: 600, renderMsAvg: 3, renderMsMax: 5, ...o,
  };
}
const ENV = { seed: 1, userAgent: 'test', screen: '1x1@1' };

describe('review FND-06 bench budgets (section 13 limits are inclusive)', () => {
  it('exact limits pass, one over fails, and only proxy budgets decide proxyPass', () => {
    expect(computeBenchResult(samples({ drawCallsMax: 80, trianglesMax: 200_000, simMsAvg: 2.5, simMsMax: 4 }), ENV).proxyPass).toBe(true);
    expect(computeBenchResult(samples({ drawCallsMax: 81 }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples({ trianglesMax: 200_001 }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples({ simMsMax: 4.01 }), ENV).proxyPass).toBe(false);
    const slow = samples({ frameMs: new Float64Array(600).fill(40) });
    const r = computeBenchResult(slow, ENV);
    expect(r.pass).toBe(false);
    expect(r.proxyPass).toBe(true);
  });

  it('missing sim or renderer stats fail the proxy gate instead of passing by default', () => {
    expect(computeBenchResult(samples({ simMsAvg: null, simMsMax: null }), ENV).proxyPass).toBe(false);
    expect(computeBenchResult(samples({ renderSamples: 0 }), ENV).proxyPass).toBe(false);
  });
});
