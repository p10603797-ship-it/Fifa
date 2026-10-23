/**
 * [SGN-03] Determinism in Chromium on the built app (BRIEF section 14 point 4, DoD 1): the same seed and inputs give
 * the same state hash across three runs, for ten configs (seeds, clubs, formations, every difficulty, rule toggles,
 * cup rules, night), and every Chromium recording plays back identically in Node (tools/replay-inspect.ts); a saved
 * replay with real keyboard input plays back identically after a page reload (Settings > Diagnostics save / load).
 *
 * The hash comes from the shipped app's own recorder (window.__dotkick.app.replay.snapshot(): hashState after every
 * 60th tick and after the last tick). Software WebGL is far too slow to draw thousands of frames, so the driver stops
 * the rAF loop, stubs renderer.render and calls loop.frame() itself (3 ticks a frame, the loop's own sim path).
 * WebKit and Firefox are not installed in this container: NOT VERIFIABLE HERE.
 *
 *   npm run build && cp -r dist dist-e2e/sgn-03 (or vite build --outDir dist-e2e/sgn-03 && node tools/postbuild.mjs dist-e2e/sgn-03)
 *   PW_DIST=dist-e2e/sgn-03 PW_PORT=4503 npx playwright test tests/e2e/sgn-03-determinism.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const OUT_DIR = 'reports/sgn-03/replays';
/** Ticks per run (40 s of play); a multiple of the recorder's 60-tick hash interval. */
const TICKS = 2400;
const HASH_INTERVAL = 60;

interface Cfg {
  seed: number; homeClub: number; awayClub: number; homeFormation: number; awayFormation: number;
  difficulty: number; offside: number; fouls: number; cupRules: number; night: number;
}

/** Ten configs: every difficulty, all six formations, rule toggles off, cup rules, night. */
const CONFIGS: Cfg[] = [
  { seed: 1, homeClub: 0, awayClub: 1, homeFormation: 0, awayFormation: 1, difficulty: 3, offside: 1, fouls: 1, cupRules: 0, night: 0 },
  { seed: 7, homeClub: 2, awayClub: 3, homeFormation: 2, awayFormation: 3, difficulty: 0, offside: 1, fouls: 1, cupRules: 0, night: 1 },
  { seed: 42, homeClub: 4, awayClub: 5, homeFormation: 4, awayFormation: 5, difficulty: 1, offside: 0, fouls: 1, cupRules: 0, night: 0 },
  { seed: 919, homeClub: 6, awayClub: 7, homeFormation: 5, awayFormation: 0, difficulty: 2, offside: 1, fouls: 0, cupRules: 1, night: 0 },
  { seed: 2027, homeClub: 8, awayClub: 9, homeFormation: 1, awayFormation: 2, difficulty: 4, offside: 0, fouls: 0, cupRules: 0, night: 1 },
  { seed: 31337, homeClub: 10, awayClub: 11, homeFormation: 3, awayFormation: 4, difficulty: 5, offside: 1, fouls: 1, cupRules: 1, night: 0 },
  { seed: 123456, homeClub: 12, awayClub: 13, homeFormation: 0, awayFormation: 0, difficulty: 3, offside: 1, fouls: 1, cupRules: 0, night: 1 },
  { seed: 4000000000, homeClub: 14, awayClub: 15, homeFormation: 2, awayFormation: 5, difficulty: 5, offside: 1, fouls: 1, cupRules: 0, night: 0 },
  { seed: 65535, homeClub: 16, awayClub: 17, homeFormation: 4, awayFormation: 1, difficulty: 0, offside: 0, fouls: 1, cupRules: 1, night: 1 },
  { seed: 8, homeClub: 18, awayClub: 19, homeFormation: 5, awayFormation: 3, difficulty: 4, offside: 1, fouls: 0, cupRules: 0, night: 0 },
];

interface Snap { ticks: number; finalHash: number; hashes: number[]; seed: number; replayJson: string; nonZeroInputs: number }

function watchConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    errors.push(`${msg.type()}: ${text}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
}

async function waitMatchLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 120_000, polling: 250 });
}

/** Stop the rAF loop and the drawing; the test calls loop.frame() itself from here on. */
async function takeOverLoop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const d = window.__dotkick!;
    d.app.loop.stop();
    (d.app.renderer as unknown as { render: () => void }).render = () => {};
    (window as unknown as { __sgn03Now: number }).__sgn03Now = performance.now();
  });
}

/** Run loop frames (50 ms each: 3 ticks) until the state reaches `until` or `maxFrames` ran; returns the tick. */
async function drive(page: Page, until: number, maxFrames: number): Promise<number> {
  return page.evaluate(([u, max]) => {
    const d = window.__dotkick!;
    const w = window as unknown as { __sgn03Now: number };
    let n = 0;
    while ((d.ctx.session.getState()?.tick ?? 0) < u! && n < max!) {
      w.__sgn03Now += 50;
      d.app.loop.frame(w.__sgn03Now);
      n++;
    }
    return d.ctx.session.getState()?.tick ?? -1;
  }, [until, maxFrames]);
}

async function snapshot(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    const r = window.__dotkick!.app.replay.snapshot();
    if (!r) throw new Error('no replay recorded');
    let nz = 0;
    for (const v of r.frames) if (v !== 0) nz++;
    return { ticks: r.ticks, finalHash: r.finalHash >>> 0, hashes: r.hashes.map((h) => h >>> 0), seed: r.seed, replayJson: JSON.stringify(r), nonZeroInputs: nz };
  });
}

/** Start a CPU v CPU match with `cfg` over the kick-off setup (no humans, no devices). */
async function startCpuMatch(page: Page, cfg: Cfg): Promise<void> {
  await page.evaluate((c) => {
    const d = window.__dotkick!;
    const w = window as unknown as { __sgn03Base?: ReturnType<typeof d.ctx.session.getSetup> };
    if (!w.__sgn03Base) w.__sgn03Base = d.ctx.session.getSetup();
    const base = w.__sgn03Base!;
    d.app.loop.start();
    d.ctx.session.quit();
    const humans = base.config.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
    d.ctx.session.start({ ...base, bindings: [], config: { ...base.config, ...c, humans } });
  }, cfg);
  await waitMatchLoaded(page);
}

function nodeReplayCheck(file: string): string {
  // Plays the Chromium recording in Node and compares every 60-tick hash and the final hash; exit 1 on divergence.
  const out = execFileSync('npx', ['tsx', 'tools/replay-inspect.ts', file, '--every', '100000'], { encoding: 'utf8', timeout: 120_000 });
  return out.split('\n').filter((l) => /final hash/.test(l)).join(' ');
}

const hex = (h: number): string => (h >>> 0).toString(16).padStart(8, '0');

test.describe('SGN-03 determinism in Chromium', () => {
  test.setTimeout(900_000);

  test('same seed and inputs give the same hash across 3 runs for 10 configs, and each plays back identically in Node', async ({ page }) => {
    const errors = watchConsole(page);
    mkdirSync(OUT_DIR, { recursive: true });
    await bootToMain(page);
    await page.getByTestId('main-kickoff').tap();
    await waitMatchLoaded(page);
    const rows: string[] = [];
    for (let k = 0; k < CONFIGS.length; k++) {
      const cfg = CONFIGS[k]!;
      const runs: Snap[] = [];
      for (let run = 0; run < 3; run++) {
        await startCpuMatch(page, cfg);
        await takeOverLoop(page);
        const t = await drive(page, TICKS, TICKS);
        expect(t, `config ${k} run ${run} reached tick ${TICKS}`).toBeGreaterThanOrEqual(TICKS);
        runs.push(await snapshot(page));
      }
      const n = TICKS / HASH_INTERVAL;
      const at = runs.map((r) => r.hashes.slice(0, n));
      for (const r of runs) expect(r.hashes.length, `config ${k}: checkpoints`).toBeGreaterThanOrEqual(n);
      expect(at[1], `config ${k}: run 2 v run 1, every 60-tick hash to tick ${TICKS}`).toEqual(at[0]);
      expect(at[2], `config ${k}: run 3 v run 1, every 60-tick hash to tick ${TICKS}`).toEqual(at[0]);
      const file = `${OUT_DIR}/chromium-config-${k}.json`;
      writeFileSync(file, runs[0]!.replayJson);
      const node = nodeReplayCheck(file);
      expect(node, `config ${k}: Node playback of the Chromium recording`).toContain('IDENTICAL');
      rows.push(`config ${k} seed ${cfg.seed} diff ${cfg.difficulty}: hash@${TICKS} ${hex(at[0]![n - 1]!)} x3 (ticks ${runs.map((r) => r.ticks).join('/')}); Node: ${node}`);
    }
    writeFileSync(`${OUT_DIR}/chromium-hash-table.txt`, `${rows.join('\n')}\n`);
    console.log(rows.join('\n'));
    expect(errors).toEqual([]);
  });

  test('a saved replay with keyboard input plays back identically after a page reload', async ({ page }) => {
    const errors = watchConsole(page);
    mkdirSync(OUT_DIR, { recursive: true });
    await bootToMain(page);
    await page.getByTestId('main-kickoff').tap();
    await waitMatchLoaded(page);
    await takeOverLoop(page);
    // Real keyboard input between frame batches: run, sprint, pass, shoot, lob, switch.
    const keys = ['KeyD', 'KeyW', 'ShiftLeft', 'KeyJ', 'KeyA', 'KeyK', 'KeyS', 'KeyU', 'KeyQ', 'KeyI'];
    let tick = await drive(page, 30, 200);
    for (let i = 0; i < 40; i++) {
      const key = keys[i % keys.length]!;
      await page.keyboard.down(key);
      tick = await drive(page, tick + 18, 50);
      await page.keyboard.up(key);
      tick = await drive(page, tick + 12, 50);
    }
    await drive(page, Math.max(tick, 1500), 2000);
    const rec = await snapshot(page);
    expect(rec.ticks).toBeGreaterThanOrEqual(1500);
    expect(rec.nonZeroInputs, 'the recording holds real human input').toBeGreaterThan(100);
    // Save through Settings > Diagnostics (download), as a player would.
    await page.evaluate(() => { window.__dotkick!.app.loop.start(); window.__dotkick!.ctx.session.quit(); });
    await expect(page.getByTestId('main-diagnostics')).toBeVisible();
    await page.getByTestId('main-diagnostics').tap();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('diagnostics-replay-save').tap()]);
    const saved = await download.path();
    const replay = JSON.parse(readFileSync(saved, 'utf8')) as { ticks: number; finalHash: number; hashes: number[] };
    expect(replay.ticks).toBe(rec.ticks);
    expect(replay.finalHash >>> 0).toBe(rec.finalHash);
    const file = `${OUT_DIR}/chromium-keyboard-reload.json`;
    writeFileSync(file, readFileSync(saved, 'utf8'));

    // Reload: a fresh page, nothing in memory. Load the file and let it play to its last tick.
    await page.reload();
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-diagnostics')).toBeVisible();
    await page.getByTestId('main-diagnostics').tap();
    await page.getByTestId('diagnostics-replay-file').setInputFiles(file);
    await waitMatchLoaded(page);
    await takeOverLoop(page);
    await drive(page, replay.ticks + 6, replay.ticks + 60);
    await expect(page.getByTestId('replay-verdict')).toContainText(`replay matched: ${replay.ticks} ticks`, { timeout: 30_000 });
    const log = await page.evaluate(() => window.__dotkick!.ctx.diagnostics.recent().join('\n'));
    expect(log).toContain('replay matched');
    expect(log).not.toMatch(/diverged/);
    const node = nodeReplayCheck(file);
    expect(node).toContain('IDENTICAL');
    console.log(`keyboard replay: ${replay.ticks} ticks, ${rec.nonZeroInputs} non-zero input ints, final ${hex(replay.finalHash)}; after reload: matched; Node: ${node}`);
    expect(errors).toEqual([]);
  });
});
