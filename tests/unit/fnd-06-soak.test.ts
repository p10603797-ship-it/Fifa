/**
 * FND-06: the soak and fuzz CLIs run end to end (worker threads, determinism check, reporting, JSON output).
 * `soak --short` must be green on the current build; fuzz is only checked for running and reporting, because it is
 * meant to find bugs in Wave 1 modules.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../..');
const TMP = mkdtempSync(join(tmpdir(), 'fnd06-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function tsx(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 240_000, env: { ...process.env, FORCE_COLOR: '0' },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('FND-06 soak and fuzz CLIs', () => {
  it('soak --short (10 matches, 2-minute halves, enforce core) runs green with a determinism check', () => {
    const json = join(TMP, 'soak.json');
    const r = tsx(['tools/soak.ts', '--matches', '10', '--short', '--workers', '2', '--json', json, '--max-replays', '0']);
    expect(r.out).toContain('RESULT: PASS');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/determinism: PASS/);
    expect(r.out).toContain('statistics bands');
    const report = JSON.parse(readFileSync(json, 'utf8')) as {
      ok: boolean; totals: { matches: number; exceptions: number; enforcedInvariantFailures: number }; matches: unknown[];
      bands: { bands: { name: string; pass: boolean }[] };
    };
    expect(report.ok).toBe(true);
    expect(report.totals.matches).toBe(10);
    expect(report.totals.exceptions).toBe(0);
    expect(report.totals.enforcedInvariantFailures).toBe(0);
    expect(report.matches).toHaveLength(10);
    expect(report.bands.bands.map((b) => b.name)).toContain('pass completion');
  }, 240_000);

  it('fuzz runs hostile matches on workers and reports a determinism check and a result line', () => {
    const json = join(TMP, 'fuzz.json');
    const r = tsx(['tools/fuzz.ts', '--matches', '3', '--enforce', 'core', '--workers', '1', '--json', json, '--max-replays', '0']);
    expect(r.code === 0 || r.code === 1).toBe(true);
    expect(r.out).toMatch(/RESULT: (PASS|FAIL)/);
    expect(r.out).toMatch(/determinism: PASS/);
    const report = JSON.parse(readFileSync(json, 'utf8')) as { totals: { matches: number }; ok: boolean };
    expect(report.totals.matches).toBe(3);
    expect(report.ok).toBe(r.code === 0);
  }, 240_000);

  it('rejects unknown flags with exit code 2', () => {
    const r = tsx(['tools/soak.ts', '--matchez', '3']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('unknown flag --matchez');
  }, 60_000);
});
