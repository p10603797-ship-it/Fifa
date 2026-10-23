/**
 * [QF-12] Monkey run over the whole app shell (BRIEF §14 item 7: every menu path by touch alone and by controller alone
 * with zero console errors or warnings; §14 item 8 runtime safety net). Seeded random walks over the real build:
 * taps on visible controls, keys (arrows, Enter, Escape, Space) and pad buttons (D-pad, Cross, Circle, Square,
 * Triangle, L1, R1, Options) across splash, menus, flows, matches, pause, breaks, settings and diagnostics.
 * After every action: no console error / warning / page error, never the recovery screen, exactly one screen mounted,
 * a router screen is current. Online lobby, the benchmark, full screen, clipboard and the replay file picker are
 * left out (network, long runs, browser permission prompts); everything else is fair game.
 *
 *   npx vite build --outDir dist-e2e/qf-12 --emptyOutDir && node tools/postbuild.mjs dist-e2e/qf-12
 *   PW_DIST=dist-e2e/qf-12 PW_PORT=4412 npx playwright test tests/e2e/qf-12-monkey.spec.ts
 *   QF12_SEEDS=1,2,3 QF12_STEPS=200 ... to widen the run.
 */
import { expect, test, type Page } from '@playwright/test';
import { mockPads, padTap, PAD, route } from './uix-03-harness';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/, /WebGL: /, /GPU stall/];

const SEEDS = (process.env.QF12_SEEDS ?? '11,12').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const STEPS = Number(process.env.QF12_STEPS ?? 90);

/** Controls the monkey never presses (network, long benchmark, permission prompts, file picker). */
const SKIP = /^(diagnostics-bench|diagnostics-copy|diagnostics-replay-file|splash-fullscreen|online-|lobby-)/;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Target { id: string; x: number; y: number }

async function targets(page: Page): Promise<Target[]> {
  return page.evaluate((skip) => {
    const re = new RegExp(skip);
    const out: { id: string; x: number; y: number }[] = [];
    const els = document.querySelectorAll<HTMLElement>('#ui [data-focus], #ui button, #ui [role="tab"], #hud button, .modal button');
    for (const el of Array.from(els)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none') continue;
      if ((el as HTMLButtonElement).disabled) continue;
      const id = el.dataset.testid ?? el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? '?';
      if (re.test(id)) continue;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      // Only what a finger would actually hit at that point.
      const hit = document.elementFromPoint(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) continue;
      out.push({ id, x, y });
    }
    return out;
  }, SKIP.source);
}

async function invariants(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const bad: string[] = [];
    const d = window.__dotkick;
    if (!d) return ['no app handle'];
    const cur = d.ctx.router.current;
    if (cur === null) bad.push('no current screen');
    if (cur === 'recovery') bad.push(`recovery screen: ${document.querySelector('#ui')?.textContent?.slice(0, 200)}`);
    // [QF-17] One screen, or the match screen kept under the half-time overlay; a half-time screen built ahead
    // ([data-prepared], hidden) is not counted.
    const screens = document.querySelectorAll('#ui > .screen:not([data-prepared])').length;
    const mounted = (d.ctx.router as unknown as { mounted?: readonly string[] }).mounted ?? [String(cur)];
    if (screens !== mounted.length) bad.push(`${screens} screens mounted (router: ${mounted.join(' + ')})`);
    if (mounted.length > 1 && mounted.join(' + ') !== 'match + half-time') bad.push(`layers ${mounted.join(' + ')}`);
    // [QF-17 skeptic] At most one screen built ahead, and in the DOM only over the match screen (or on the loading
    // screen it is built on): under any other screen it is out of the DOM (no hidden duplicate test ids).
    const prepared = document.querySelectorAll('#ui > .screen[data-prepared]').length;
    if (prepared > 1) bad.push(`${prepared} screens built ahead`);
    if (prepared === 1 && cur !== 'match' && cur !== 'loading') bad.push(`a screen built ahead left under ${String(cur)}`);
    const s = d.ctx.session as typeof d.ctx.session & { loaded?: boolean };
    if (s.active && s.loaded === true && !s.getState()) bad.push('loaded session without state');
    return bad;
  });
}

for (const seed of SEEDS) {
  test(`monkey seed ${seed}: random touch, key and pad actions over every screen, zero console errors or warnings`, async ({ page }) => {
    test.setTimeout(420_000);
    const messages: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error' && m.type() !== 'warning') return;
      const text = m.text();
      if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
      messages.push(`${m.type()}: ${text}`);
    });
    page.on('pageerror', (e) => messages.push(`pageerror: ${e.message}`));
    await page.addInitScript(mockPads(1));
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    const rnd = mulberry(seed);
    const log: string[] = [];
    const keys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape', 'Space', 'KeyQ', 'KeyE'];
    const pads = [PAD.A, PAD.B, PAD.X, PAD.Y, PAD.L1, PAD.R1, PAD.UP, PAD.DOWN, PAD.LEFT, PAD.RIGHT, 9];
    for (let i = 0; i < STEPS; i++) {
      const where = await route(page);
      if (where === 'online-lobby') {
        await page.keyboard.press('Escape');
        log.push(`${i} ${where} leave lobby`);
        await page.waitForTimeout(80);
        continue;
      }
      // While a match loads or runs, cap the time spent there: quit through the session now and then.
      const r = rnd();
      if ((where === 'match' || where === 'loading') && r < 0.06) {
        await page.evaluate(() => window.__dotkick!.ctx.session.quit());
        log.push(`${i} ${where} session.quit`);
      } else if (r < 0.55) {
        const t = await targets(page);
        if (t.length > 0) {
          const pick = t[Math.floor(rnd() * t.length)]!;
          await page.touchscreen.tap(pick.x, pick.y);
          log.push(`${i} ${where} tap ${pick.id}`);
        }
      } else if (r < 0.8) {
        const k = keys[Math.floor(rnd() * keys.length)]!;
        await page.keyboard.press(k);
        log.push(`${i} ${where} key ${k}`);
      } else {
        const b = pads[Math.floor(rnd() * pads.length)]!;
        await padTap(page, b);
        log.push(`${i} ${where} pad ${b}`);
      }
      await page.waitForTimeout(60);
      const bad = await invariants(page);
      if (bad.length > 0 || messages.length > 0) {
        throw new Error(`seed ${seed} step ${i}: ${[...bad, ...messages].join(' | ')}\nlast actions:\n${log.slice(-15).join('\n')}`);
      }
    }
    const visited: Record<string, number> = {};
    for (const line of log) {
      const w = line.split(' ')[1]!;
      visited[w] = (visited[w] ?? 0) + 1;
    }
    test.info().annotations.push({ type: 'visited', description: JSON.stringify(visited) });
    if (process.env.QF12_VERBOSE) console.log(`seed ${seed} visited ${JSON.stringify(visited)}`);
    expect(messages).toEqual([]);
  });
}
