/**
 * [QF-4] QA-33 / QA-34 / QA-35 in the shipped app (Chromium + SwiftShader, DPR 1):
 *  (a) HUD layout by touch at 1180x820, 4:3 (1024x768), 16:10 (1280x800) and 19.5:9 (1688x780): no HUD part overlaps
 *      the touch controls or another HUD part, everything inside the viewport, also with a set-piece hint showing;
 *      then rotation to portrait and back and a resize: the camera follows the new aspect and the ball projects where
 *      it is drawn.
 *  (b) Per-scene budgets in a CPU v CPU match: draw calls <= 80, triangles <= 200k and texture memory <= 64 MB at
 *      kick-off, open play, a corner, a free kick, a goal kick, a goal + replay and a night match; screenshots of the
 *      set-piece cameras (QF-4 camera fixes) to look at.
 * Screenshots: tmp/qf-4/*.png (LOOK at them).
 * Run: npx vite build --outDir dist-e2e/qf-4 --emptyOutDir && PW_DIST=dist-e2e/qf-4 PW_PORT=4404 npx playwright test tests/e2e/qf-4-look.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectConsole, frames, Touch, touchTestId, waitRoute } from './int-b-harness';

const OUT = join(process.cwd(), 'tmp', 'qf-4');
mkdirSync(OUT, { recursive: true });
const shot = (page: Page, name: string): Promise<Buffer> => page.screenshot({ path: join(OUT, `${name}.png`) });

type Rect = { name: string; l: number; t: number; r: number; b: number };

/** Visible HUD parts and touch controls as rects (CSS px). */
function layout(page: Page): Promise<{ hud: Rect[]; touch: Rect[]; w: number; h: number }> {
  return page.evaluate(() => {
    const rects = (sel: string, name: string): { name: string; l: number; t: number; r: number; b: number }[] => {
      const out: { name: string; l: number; t: number; r: number; b: number }[] = [];
      document.querySelectorAll<HTMLElement>(sel).forEach((el, i) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return;
        // Effective opacity (a hidden hint is a child of a transparent container).
        let op = 1;
        let p: HTMLElement | null = el;
        while (p) {
          const ps = getComputedStyle(p);
          if (p.hidden || ps.display === 'none') return;
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
    return { hud, touch, w: window.innerWidth, h: window.innerHeight };
  });
}

function overlap(a: Rect, b: Rect, tol = 2): boolean {
  return a.l < b.r - tol && b.l < a.r - tol && a.t < b.b - tol && b.t < a.b - tol;
}

function checkLayout(L: { hud: Rect[]; touch: Rect[]; w: number; h: number }, tag: string): void {
  expect(L.hud.length, `${tag}: HUD parts visible`).toBeGreaterThanOrEqual(2);
  expect(L.touch.length, `${tag}: touch controls visible`).toBeGreaterThanOrEqual(4);
  for (const r of [...L.hud, ...L.touch]) {
    expect(r.l, `${tag} ${r.name} left`).toBeGreaterThanOrEqual(-0.5);
    expect(r.t, `${tag} ${r.name} top`).toBeGreaterThanOrEqual(-0.5);
    expect(r.r, `${tag} ${r.name} right`).toBeLessThanOrEqual(L.w + 0.5);
    expect(r.b, `${tag} ${r.name} bottom`).toBeLessThanOrEqual(L.h + 0.5);
  }
  for (const a of L.hud) {
    for (const b of L.touch) expect(overlap(a, b), `${tag}: ${a.name} overlaps ${b.name} ${JSON.stringify([a, b])}`).toBe(false);
    for (const b of L.hud) if (a !== b) expect(overlap(a, b), `${tag}: ${a.name} overlaps ${b.name}`).toBe(false);
  }
}

test.describe('QF-4 look: HUD layout, resize / rotation, budgets per scene', () => {
  test('HUD clear of the touch controls at 1180x820, 4:3, 16:10 and 19.5:9; rotation and resize keep the camera aspect', async ({ page }) => {
    test.setTimeout(300_000);
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
    // Drive the loop by hand (deterministic, fast): stop rAF, step frames.
    await page.evaluate(() => {
      const d = window.__dotkick!;
      d.app.loop.stop();
      const w = window as unknown as { __qf4Now: number; __qf4Step: (n: number, dt: number) => void };
      w.__qf4Now = performance.now();
      w.__qf4Step = (n: number, dt: number) => { for (let i = 0; i < n; i++) { w.__qf4Now += dt; d.app.loop.frame(w.__qf4Now); } };
    });
    const step = (n: number, dt = 1000 / 60): Promise<void> =>
      page.evaluate(([k, d]) => (window as unknown as { __qf4Step: (n: number, dt: number) => void }).__qf4Step(k!, d!), [n, dt]);
    // Into open play (the human's kick-off is taken by the CPU fallback after its wait).
    for (let i = 0; i < 40; i++) {
      await step(30, 50);
      if (await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.match.phase === 2)) break;
    }
    const sizes: [number, number][] = [[1180, 820], [1024, 768], [1280, 800], [1688, 780]];
    let hintsShown = 0;
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h });
      await frames(page, 2);
      await step(8);
      const L = await layout(page);
      await shot(page, `hud-${w}x${h}`);
      checkLayout(L, `${w}x${h}`);
      // Swipe hints around a held big button (first matches): inside the viewport and clear of the HUD.
      const big = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('.dk-tbtn--big');
        const r = el?.getBoundingClientRect();
        return r && r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
      });
      if (big) {
        await t.down(1, big.x, big.y);
        let on = 0;
        for (let k = 0; k < 60 && on === 0; k++) {
          await step(2);
          await page.waitForTimeout(50);
          on = await page.locator('.dk-tbtn--big .dk-hint.is-on').count();
        }
        if (on > 0) {
          hintsShown++;
          await page.waitForTimeout(250); // the fade-in
          await step(2);
          await shot(page, `hud-${w}x${h}-swipe-hints`);
          const H = await layout(page);
          expect(H.touch.some((r) => r.name.startsWith('swipeHint')), `${w}x${h}: swipe hints measured`).toBe(true);
          checkLayout(H, `${w}x${h} swipe hints`);
        }
        await t.up();
        await step(4);
      }
      // Camera follows the aspect: the projector maps the ball onto the canvas where it is drawn.
      const cam = await page.evaluate(() => {
        const d = window.__dotkick!;
        const s = d.ctx.session.getState()!;
        const o = { x: 0, y: 0 };
        const ok = d.app.renderer.projector.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, o);
        const c = document.getElementById('game') as HTMLCanvasElement;
        return { ok, x: o.x, y: o.y, cw: c.clientWidth, ch: c.clientHeight };
      });
      expect(cam.cw).toBe(w);
      expect(cam.ch).toBe(h);
      expect(cam.ok).toBe(true);
      expect(cam.x).toBeGreaterThan(0);
      expect(cam.x).toBeLessThan(w);
      expect(cam.y).toBeGreaterThan(0);
      expect(cam.y).toBeLessThan(h * 0.86);
    }
    expect(hintsShown, 'swipe hints shown on a held big button').toBeGreaterThan(0);
    // A set-piece hint card (first corners) with the touch controls: still clear.
    await page.setViewportSize({ width: 1024, height: 768 });
    await frames(page, 2);
    await page.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getState()! as unknown as { teams: { dir: number }[]; ball: Record<string, number>; tick: number };
      const a = s.teams[0]!.dir > 0 ? 0 : 1;
      const def = 1 - a;
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = 50.5; b.z = 22; b.y = 0.3; b.vx = 10; b.vy = 0; b.vz = 0; b.px = 50.5; b.py = 0.3; b.pz = 22;
      b.grounded = 0; b.shotBy = -1; b.passTarget = -1; b.lastTouch = def * 11 + 4; b.lastTouchTeam = def; b.lastTouchTick = s.tick;
      b.lastKickTeam = def; b.lastKickBy = def * 11 + 4;
    });
    for (let i = 0; i < 20; i++) {
      await step(10);
      if (await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.match.phase === 5)) break;
    }
    await step(70);
    await shot(page, 'hud-1024x768-corner-hint');
    checkLayout(await layout(page), '1024x768 corner');
    // Portrait: the game pauses behind the rotate notice; back to landscape: the camera aspect follows.
    await page.setViewportSize({ width: 820, height: 1180 });
    await frames(page, 6);
    await step(4);
    await shot(page, 'rotate-portrait');
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(true);
    await page.setViewportSize({ width: 1366, height: 1024 });
    await frames(page, 6);
    await page.evaluate(() => window.__dotkick!.ctx.session.resume(-1));
    await step(10);
    const aspect = await page.evaluate(() => {
      const d = window.__dotkick!;
      const s = d.ctx.session.getState()!;
      const o = { x: 0, y: 0 };
      d.app.renderer.projector.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, o);
      const c = document.getElementById('game') as HTMLCanvasElement;
      return { x: o.x, y: o.y, cw: c.clientWidth, ch: c.clientHeight, paused: d.ctx.session.paused };
    });
    await shot(page, 'rotate-back-1366x1024');
    expect(aspect.paused).toBe(false);
    expect(aspect.cw).toBe(1366);
    expect(aspect.ch).toBe(1024);
    expect(aspect.x).toBeGreaterThan(0);
    expect(aspect.x).toBeLessThan(1366);
    checkLayout(await layout(page), '1366x1024');
    expect(errors).toEqual([]);
  });

  test('budgets per scene (draw calls, triangles, texture memory) and set-piece camera screenshots', async ({ page }) => {
    test.setTimeout(420_000);
    const errors = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').click();
    await page.getByTestId('main-kickoff').click();
    await page.waitForFunction(() => {
      const d = window.__dotkick;
      return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
    }, null, { timeout: 90_000, polling: 250 });
    const start = async (night: number, seed: number): Promise<void> => {
      await page.evaluate(([n, sd]) => {
        const d = window.__dotkick!;
        const setup = d.ctx.session.getSetup()!;
        d.ctx.session.quit();
        const humans = setup.config.humans.map((hh) => ({ ...hh, kind: 0, side: -1 }));
        d.ctx.session.start({ ...setup, bindings: [], config: { ...setup.config, night: n!, seed: sd!, humans } });
      }, [night, seed]);
      await page.waitForFunction(() => {
        const d = window.__dotkick!;
        return d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
      }, null, { timeout: 120_000, polling: 250 });
      await page.evaluate(() => {
        const d = window.__dotkick!;
        d.app.loop.stop();
        const w = window as unknown as Record<string, unknown>;
        let now = performance.now();
        type S = { tick: number; match: { phase: number; restart: { ready: number } }; ball: Record<string, number>; teams: { dir: number }[]; players: Record<string, number>[] };
        const st = (): S => d.ctx.session.getState() as unknown as S;
        const r = d.app.renderer as unknown as { render: (...a: unknown[]) => void };
        w.__qf4 = {
          run(max: number, phase: number, render: boolean, dt: number) {
            const orig = r.render;
            if (!render) r.render = () => {};
            const t0 = st().tick;
            try {
              for (let g = 0; g < 200000; g++) {
                now += dt; d.app.loop.frame(now);
                const s = st();
                if (s.tick - t0 >= max || !d.app.session.ticking) break;
                if (phase >= 0 && s.match.phase === phase) break;
              }
            } finally { r.render = orig; }
            return st().match.phase;
          },
          show(n: number) {
            for (let i = 0; i < n; i++) { now += 1000 / 60; d.app.loop.frame(now); }
            const rs = d.app.renderer.stats();
            const tm = window.__dotkickTextureMemory!();
            const c = w.__dotkickCinematic as { shot?: number } | undefined;
            return { calls: rs.drawCalls, tris: rs.triangles, texMB: +(tm.bytes / (1024 * 1024)).toFixed(2), textures: tm.textures, gpuTextures: rs.textures, geometries: rs.geometries, phase: st().match.phase, shot: c?.shot ?? -1 };
          },
          loose(x: number, z: number, vx: number, defTouch: boolean) {
            const s = st();
            const a = s.teams[0]!.dir > 0 ? 0 : 1;
            const team = defTouch ? 1 - a : a;
            const b = s.ball;
            b.owner = -1; b.heldBy = -1; b.x = x; b.z = z; b.y = 0.3; b.vx = vx; b.vy = 0; b.vz = 0; b.px = x; b.py = 0.3; b.pz = z;
            b.grounded = 0; b.shotBy = -1; b.passTarget = -1; b.lastTouch = team * 11 + 4; b.lastTouchTeam = team;
            b.lastTouchTick = s.tick; b.lastKickTeam = team; b.lastKickBy = team * 11 + 4;
          },
          shotOnGoal() {
            const s = st();
            const a = s.teams[0]!.dir > 0 ? 0 : 1;
            const k = s.players[(1 - a) * 11]!;
            k.x = 51.5; k.z = -3.4;
            const b = s.ball;
            b.owner = -1; b.heldBy = -1; b.x = 36; b.z = 4; b.y = 0.6; b.vx = 26; b.vy = 1.5; b.vz = -0.7; b.px = 36; b.py = 0.6; b.pz = 4;
            b.grounded = 0; b.passTarget = -1; b.lastTouch = a * 11 + 9; b.lastTouchTeam = a; b.lastTouchTick = s.tick;
            b.lastKickTeam = a; b.lastKickBy = a * 11 + 9; b.shotBy = a * 11 + 9; b.shotTick = s.tick;
          },
          foul() {
            const s = st() as unknown as { tick: number; teams: { dir: number }[]; players: Record<string, number>[]; ball: Record<string, number>; match: { challenges: Record<string, number>[] } };
            const a = s.teams[0]!.dir > 0 ? 0 : 1;
            const def = 1 - a;
            const v = s.players[a * 11 + 9]!, o = s.players[def * 11 + 5]!;
            v.x = 26; v.z = 6; v.vx = 0; v.vz = 0; o.x = 25.2; o.z = 6; o.vx = 0; o.vz = 0;
            const b = s.ball;
            b.owner = def * 11 + 5; b.heldBy = -1; b.x = 25.6; b.z = 6; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0; b.px = b.x; b.py = b.y; b.pz = b.z;
            const c = s.match.challenges[0]!;
            c.active = 1; c.tackler = def * 11 + 5; c.victim = a * 11 + 9; c.kind = 1; c.ballFirst = 0; c.fromBehind = 1;
            c.closingSpeed = 6; c.x = 26; c.z = 6; c.tick = s.tick;
          },
        };
      });
    };
    type Q = { run(max: number, phase: number, render: boolean, dt: number): number; show(n: number): Record<string, number>; loose(x: number, z: number, vx: number, d: boolean): void; shotOnGoal(): void; foul(): void };
    const q = {
      run: (max: number, phase: number, render = false, dt = 50) => page.evaluate((a) => (window as unknown as { __qf4: Q }).__qf4.run(a[0]!, a[1]!, a[2] === 1, a[3]!), [max, phase, render ? 1 : 0, dt]),
      show: (n = 3) => page.evaluate((k) => (window as unknown as { __qf4: Q }).__qf4.show(k), n),
      loose: (x: number, z: number, vx: number, d: boolean) => page.evaluate((a) => (window as unknown as { __qf4: Q }).__qf4.loose(a[0]!, a[1]!, a[2]!, a[3] === 1), [x, z, vx, d ? 1 : 0]),
      shotOnGoal: () => page.evaluate(() => (window as unknown as { __qf4: Q }).__qf4.shotOnGoal()),
      foul: () => page.evaluate(() => (window as unknown as { __qf4: Q }).__qf4.foul()),
    };
    const report: Record<string, Record<string, number>> = {};
    const scene = async (name: string, n = 3): Promise<Record<string, number>> => {
      const r = await q.show(n);
      report[name] = r;
      await shot(page, `scene-${name}`);
      expect(r.calls, `${name} draw calls`).toBeLessThanOrEqual(80);
      expect(r.calls, `${name} drew`).toBeGreaterThan(5);
      expect(r.tris, `${name} triangles`).toBeLessThanOrEqual(200_000);
      expect(r.texMB, `${name} texture MB`).toBeLessThanOrEqual(64);
      // Every texture the GPU holds is one the scene references (textureMemory counts them all).
      expect(r.gpuTextures, `${name} GPU textures vs counted`).toBeLessThanOrEqual(r.textures);
      return r;
    };
    await start(0, 20261014);
    await q.run(600, 1, false, 50);
    await q.run(20, -1, true, 1000 / 60);
    await scene('kickoff');
    await q.run(1200, 2, false, 50);
    await q.run(900, -1, false, 50);
    await q.run(30, -1, true, 1000 / 60);
    await scene('openplay');
    // Corner: set-up (main camera), then the corner camera with the taker beside the ball.
    await q.loose(50.5, 22, 10, true);
    await q.run(300, 5, false, 50);
    await q.run(20, -1, true, 1000 / 60);
    const cs = await scene('corner-setup');
    expect(cs.shot).toBe(0);
    await q.run(50, -1, true, 1000 / 60);
    const cv = await scene('corner-view');
    expect(cv.shot).toBe(2);
    // Goal kick.
    await q.run(6000, 2, false, 50);
    await q.loose(50.5, -14, 10, false);
    await q.run(300, 4, false, 50);
    await q.run(75, -1, true, 1000 / 60);
    const gk = await scene('goal-kick');
    expect(gk.shot).toBe(1);
    // Free kick 26 m out.
    await q.run(6000, 2, false, 50);
    let ph = -1;
    for (let i = 0; i < 12 && ph !== 6; i++) {
      await q.run(30, 2, false, 50);
      await q.foul();
      ph = await q.run(6, 6, false, 50);
    }
    expect(ph).toBe(6);
    await q.run(75, -1, true, 1000 / 60);
    const fk = await scene('free-kick');
    expect(fk.shot).toBe(1);
    // Goal and the replay.
    await q.run(6000, 2, false, 50);
    await q.run(360, -1, true, 50);
    await q.shotOnGoal();
    await q.run(240, 8, true, 50);
    await scene('goal', 2);
    await q.run(1500, 10, false, 50);
    await q.run(12, -1, true, 1000 / 60);
    await scene('replay', 2);
    // Night match.
    await start(1, 4242);
    await q.run(2000, 2, false, 50);
    await q.run(40, -1, true, 1000 / 60);
    await scene('night');
    console.log('QF-4 scenes', JSON.stringify(report));
    expect(errors).toEqual([]);
  });
});
