/**
 * [QF-4 skeptic] Angles the first QF-4 e2e pass did not cover (Chromium + SwiftShader, DPR 1):
 *  (a) HUD layout with Accessibility > Larger HUD at 4:3, the iPad 1180x820 and 19.5:9, with the touch controls normal
 *      and mirrored: no HUD part overlaps another or the touch controls, everything inside the viewport.
 *  (b) Texture memory across matches: three matches in a row with different clubs, kits and a night match (and a
 *      shoot-out) must not leave the previous match's kit / number textures on the GPU (renderer.info.memory.textures
 *      and geometries stay flat); screenshots of the shoot-out behind view (QF-4 skeptic camera fixes) to look at.
 * Screenshots: tmp/qf-4/skeptic-*.png (LOOK at them).
 * Run: npx vite build --outDir dist-e2e/qf-4 --emptyOutDir && PW_DIST=dist-e2e/qf-4 PW_PORT=4404 npx playwright test tests/e2e/qf-4-skeptic.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectConsole, frames, Touch, touchTestId, waitRoute } from './int-b-harness';

const OUT = join(process.cwd(), 'tmp', 'qf-4');
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(OUT, `skeptic-${name}.png`) });

type Rect = { name: string; l: number; t: number; r: number; b: number };

function layout(page: Page): Promise<{ hud: Rect[]; touch: Rect[]; w: number; h: number; lg: number }> {
  return page.evaluate(() => {
    const rects = (sel: string, name: string): { name: string; l: number; t: number; r: number; b: number }[] => {
      const out: { name: string; l: number; t: number; r: number; b: number }[] = [];
      document.querySelectorAll<HTMLElement>(sel).forEach((el, i) => {
        let op = 1;
        let p: HTMLElement | null = el;
        while (p) {
          const ps = getComputedStyle(p);
          if (p.hidden || ps.display === 'none' || ps.visibility === 'hidden') return;
          op *= Number(ps.opacity);
          p = p.parentElement;
        }
        if (op < 0.05) return;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        out.push({ name: `${name}${i}`, l: r.left, t: r.top, r: r.right, b: r.bottom });
      });
      return out;
    };
    const hud = [
      ...rects('.hud-scoreboard', 'scoreboard'), ...rects('.hud-radar', 'radar'), ...rects('.hud-pi', 'playerInfo'),
      ...rects('.hud-toast', 'toast'), ...rects('.hud-hint', 'hint'),
    ];
    const touch = [...rects('.dk-tbtn', 'button'), ...rects('.dk-hint-text', 'swipeHint')];
    return { hud, touch, w: window.innerWidth, h: window.innerHeight, lg: document.querySelectorAll('.hud-lg').length };
  });
}

function overlap(a: Rect, b: Rect, tol = 2): boolean {
  return a.l < b.r - tol && b.l < a.r - tol && a.t < b.b - tol && b.t < a.b - tol;
}

test.describe('QF-4 skeptic: larger HUD layout, texture memory across matches', () => {
  test('larger HUD at 4:3, 1180x820 and 19.5:9, touch controls normal and mirrored: nothing overlaps, all inside the viewport', async ({ page }) => {
    test.setTimeout(240_000);
    const errors = collectConsole(page);
    await page.goto('/');
    const t = await Touch.open(page);
    await touchTestId(page, t, 'splash-start');
    await waitRoute(page, 'main', 20_000);
    await touchTestId(page, t, 'main-kickoff');
    await page.waitForFunction(() => {
      const d = window.__dotkick;
      return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
    }, null, { timeout: 90_000, polling: 250 });
    await expect(page.locator('.dk-touch')).toBeVisible();
    await page.evaluate(() => {
      const d = window.__dotkick!;
      d.app.loop.stop();
      const w = window as unknown as { __sk: number; __skStep: (n: number, dt: number) => void };
      w.__sk = performance.now();
      w.__skStep = (n: number, dt: number) => { for (let i = 0; i < n; i++) { w.__sk += dt; d.app.loop.frame(w.__sk); } };
    });
    const step = (n: number, dt = 1000 / 60): Promise<void> =>
      page.evaluate(([k, dd]) => (window as unknown as { __skStep: (n: number, dt: number) => void }).__skStep(k!, dd!), [n, dt]);
    for (let i = 0; i < 40; i++) {
      await step(30, 50);
      if (await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.match.phase === 2)) break;
    }
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.accessibility.largerHud = true; }));
    for (const mirror of [false, true]) {
      await page.evaluate((m) => window.__dotkick!.ctx.settings.update((s) => { s.controls.touch.mirror = m; }), mirror);
      for (const [w, h] of [[1024, 768], [1180, 820], [1688, 780]] as const) {
        await page.setViewportSize({ width: w, height: h });
        await frames(page, 2);
        await step(8);
        const L = await layout(page);
        const tag = `${w}x${h}${mirror ? ' mirrored' : ''}`;
        await shot(page, `hud-lg-${w}x${h}${mirror ? '-mirror' : ''}`);
        expect(L.lg, `${tag}: larger HUD applied`).toBeGreaterThan(0);
        expect(L.hud.length, `${tag}: HUD parts`).toBeGreaterThanOrEqual(2);
        expect(L.touch.length, `${tag}: touch controls`).toBeGreaterThanOrEqual(4);
        for (const r of [...L.hud, ...L.touch]) {
          expect(r.l, `${tag} ${r.name} left`).toBeGreaterThanOrEqual(-0.5);
          expect(r.t, `${tag} ${r.name} top`).toBeGreaterThanOrEqual(-0.5);
          expect(r.r, `${tag} ${r.name} right`).toBeLessThanOrEqual(L.w + 0.5);
          expect(r.b, `${tag} ${r.name} bottom`).toBeLessThanOrEqual(L.h + 0.5);
        }
        for (const a of L.hud) {
          for (const b of L.touch) expect(overlap(a, b), `${tag}: ${a.name} overlaps ${b.name} ${JSON.stringify([a, b])}`).toBe(false);
          for (const b of L.hud) if (a !== b) expect(overlap(a, b), `${tag}: ${a.name} overlaps ${b.name} ${JSON.stringify([a, b])}`).toBe(false);
        }
      }
    }
    expect(errors).toEqual([]);
  });

  test('three matches in a row (other clubs, kits, night, a shoot-out) leave no GPU textures or geometries behind', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').click();
    await page.getByTestId('main-kickoff').click();
    await page.waitForFunction(() => {
      const d = window.__dotkick;
      return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
    }, null, { timeout: 90_000, polling: 250 });
    const start = async (o: { home: number; away: number; awayKit: number; night: number; shootout: number }): Promise<Record<string, number>> => {
      await page.evaluate((c) => {
        const d = window.__dotkick!;
        const setup = d.ctx.session.getSetup()!;
        d.ctx.session.quit();
        const humans = setup.config.humans.map((hh) => ({ ...hh, kind: 0, side: -1 }));
        d.ctx.session.start({
          ...setup, bindings: [],
          config: { ...setup.config, homeClub: c.home, awayClub: c.away, awayKit: c.awayKit, night: c.night, seed: 5, humans, startPhase: c.shootout === 1 ? 14 : setup.config.startPhase },
        });
      }, o);
      await page.waitForFunction(() => {
        const d = window.__dotkick!;
        return d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
      }, null, { timeout: 120_000, polling: 250 });
      return page.evaluate(async (so) => {
        const d = window.__dotkick!;
        d.app.loop.stop();
        let now = performance.now();
        const st = () => d.ctx.session.getState() as unknown as { match: { phase: number; shootout: { sub: number; subT: number } } };
        // Into the shoot-out's first aim (or a few seconds of the kick-off build-up), then draw some frames.
        for (let i = 0; i < 4000; i++) {
          now += so === 1 ? 50 : 1000 / 60; d.app.loop.frame(now);
          const s = st();
          if (so === 1 ? s.match.phase === 14 && s.match.shootout.sub === 1 && s.match.shootout.subT > 30 : i > 240) break;
        }
        for (let i = 0; i < 4; i++) { now += 1000 / 60; d.app.loop.frame(now); }
        const rs = d.app.renderer.stats();
        const tm = window.__dotkickTextureMemory!();
        return { gpuTextures: rs.textures, geometries: rs.geometries, counted: tm.textures, mb: tm.bytes / 1048576, calls: rs.drawCalls, phase: st().match.phase };
      }, o.shootout);
    };
    const runs: Record<string, number>[] = [];
    runs.push(await start({ home: 0, away: 1, awayKit: 1, night: 0, shootout: 0 }));
    await shot(page, 'match-1');
    runs.push(await start({ home: 4, away: 7, awayKit: 0, night: 1, shootout: 0 }));
    await shot(page, 'match-2-night');
    runs.push(await start({ home: 9, away: 2, awayKit: 1, night: 0, shootout: 1 }));
    await shot(page, 'match-3-shootout-aim');
    runs.push(await start({ home: 3, away: 5, awayKit: 1, night: 0, shootout: 0 }));
    console.log(`QF-4 skeptic texture runs: ${JSON.stringify(runs)}`);
    expect(runs[2]!.phase, 'shoot-out reached').toBe(14);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.gpuTextures, `match ${i + 1}: GPU textures vs the first match`).toBeLessThanOrEqual(runs[0]!.gpuTextures);
      expect(runs[i]!.geometries, `match ${i + 1}: geometries vs the first match`).toBeLessThanOrEqual(runs[0]!.geometries + 2);
      expect(runs[i]!.gpuTextures, `match ${i + 1}: every GPU texture is one the scene uses`).toBeLessThanOrEqual(runs[i]!.counted);
    }
    expect(errors).toEqual([]);
  });
});
