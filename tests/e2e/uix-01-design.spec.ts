/**
 * UIX-01 Dot design system end to end (built app, iPad landscape 1180 x 820 plus 4:3 and 21:9):
 *  - fonts: the five Latin faces are inlined as data URIs in index.html and loaded (document.fonts), the UI uses them;
 *  - dot field: animates behind the menus at <= 30 fps from the app loop, follows focus, and is stopped and hidden in
 *    a match, including when a menu opened over the paused match keeps forwarding frames;
 *  - components: a gallery screen built from window.__dotkickUi works by touch alone and by keyboard alone (toggle,
 *    slider drag and steps, selector, segmented, tabs with Q / E, modal closed by Escape without leaving the screen);
 *  - screenshots of the main menu and the gallery at three aspect ratios (dist-e2e/uix-01-shots/*.png).
 * Run: npx vite build --outDir dist-e2e/uix-01 --emptyOutDir && PW_DIST=dist-e2e/uix-01 PW_PORT=4391 npx playwright test tests/e2e/uix-01-design.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Outside test-results/ (other agents' Playwright runs clear it). dist-e2e/ is git-ignored.
const SHOTS = resolve(process.cwd(), 'dist-e2e/uix-01-shots');
const DIST = resolve(process.cwd(), process.env.PW_DIST ?? 'dist');
const GPU_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (GPU_NOISE.some((re) => re.test(m.text()))) return;
    out.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  const start = page.getByTestId('splash-start');
  await expect(start).toBeVisible();
  await start.tap();
  await page.waitForFunction(() => window.__dotkick?.ctx.router.current === 'main');
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
}

function stats(page: Page): Promise<{ draws: number; frames: number; visible: boolean; mounted: boolean; blocked: boolean; parallaxX: number }> {
  return page.evaluate(() => {
    const s = window.__dotkickDotField!.stats;
    return { draws: s.draws, frames: s.frames, visible: s.visible, mounted: s.mounted, blocked: s.blocked, parallaxX: s.parallaxX };
  });
}

/** Non-transparent pixels in a 64 x 64 grid sample of the dot-field canvas. */
function inkedSamples(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.dotfield');
    if (!c) return -1;
    const g = c.getContext('2d')!;
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const px = Math.floor((x + 0.5) * (c.width / 64));
        const py = Math.floor((y + 0.5) * (c.height / 64));
        // Sample a 5 x 5 neighbourhood (dots are small).
        let hit = false;
        for (let dy = -2; dy <= 2 && !hit; dy++) {
          for (let dx = -2; dx <= 2 && !hit; dx++) {
            const i = ((py + dy) * c.width + (px + dx)) * 4;
            if (d[i + 3]! > 10) hit = true;
          }
        }
        if (hit) n++;
      }
    }
    return n;
  });
}

/** Register and open a gallery screen built from the design-system builders (window.__dotkickUi). */
async function openGallery(page: Page): Promise<void> {
  await page.evaluate(() => {
    type Fn = (...a: unknown[]) => unknown;
    const ui = window.__dotkickUi as Record<string, Fn>;
    const app = window.__dotkick!.app;
    const field = window.__dotkickDotField!;
    const log: string[] = [];
    (window as unknown as { __galleryLog: string[] }).__galleryLog = log;
    app.router.register('tutorial', () => {
      let host: HTMLElement | null = null;
      return {
        id: 'tutorial',
        mount(root: HTMLElement, ctx: unknown) {
          host = root;
          field.mount(root);
          root.classList.add('screen--gallery');
          const el = (x: unknown): HTMLElement => (x as { el: HTMLElement }).el;
          const tabs = ui.createTabs!([{ id: 'play', label: 'Play', testId: 'g-tab-play' }, { id: 'audio', label: 'Audio', testId: 'g-tab-audio' }, { id: 'video', label: 'Video', testId: 'g-tab-video' }], 'play', (id: unknown) => log.push(`tab:${id}`), { ctx, testId: 'g-tabs' });
          const left = document.createElement('div');
          left.className = 'g-col';
          left.append(
            ui.createButton!('Kick-Off', () => log.push('primary'), { variant: 'primary', size: 'lg', autofocus: true, testId: 'g-primary', hint: 'Quick match against the CPU', ctx }) as Node,
            ui.createButton!('Secondary', () => log.push('secondary'), { testId: 'g-secondary', ctx }) as Node,
            el(ui.createToggle!('Show radar', false, (v: unknown) => log.push(`toggle:${v}`), { testId: 'g-toggle', hint: 'Bottom centre', ctx })),
            el(ui.createSlider!('Music volume', 0.5, (v: unknown) => log.push(`slider:${v}`), { testId: 'g-slider', ctx })),
            el(ui.createSelector!('Difficulty', [{ value: 1, label: 'Amateur' }, { value: 2, label: 'Pro' }, { value: 3, label: 'World Class' }], 2, (v: unknown) => log.push(`sel:${v}`), { testId: 'g-selector', ctx })),
          );
          const right = document.createElement('div');
          right.className = 'g-col';
          right.append(
            el(ui.createSegmented!('Camera', [{ value: 'tele', label: 'Tele', testId: 'g-seg-tele' }, { value: 'broadcast', label: 'Broadcast', testId: 'g-seg-broadcast' }, { value: 'wide', label: 'Wide', testId: 'g-seg-wide' }], 'broadcast', (v: unknown) => log.push(`seg:${v}`), { ctx, testId: 'g-seg' })),
            ui.createList!([{ label: 'Goals', value: '2 - 1' }, { label: 'Possession', value: '54%' }, { label: 'Player of the match', detail: 'Ava Moreno, ST', value: '8.6', onSelect: () => log.push('row') }], { testId: 'g-list', ctx }) as Node,
            ui.createCard!({ eyebrow: 'Home', title: 'Harbour Athletic', body: 'Rating 84  /  4-3-3', onSelect: () => log.push('card'), selected: true, testId: 'g-card', ctx }) as Node,
            ui.createButton!('Open dialog', () => {
              ui.openModal!(ctx, { title: 'Quit the match?', body: 'The score so far is not saved.', testId: 'g-modal', actions: [{ label: 'Stay', testId: 'g-modal-stay' }, { label: 'Quit', primary: true, testId: 'g-modal-quit', onSelect: () => log.push('quit') }] });
            }, { testId: 'g-open-modal', ctx }) as Node,
            ui.createButton!('Toast', () => ui.showToast!('Settings saved', { kind: 'success', testId: 'g-toast' }), { variant: 'ghost', testId: 'g-toast-btn', ctx }) as Node,
          );
          const grid = document.createElement('div');
          grid.className = 'g-grid ui-scroll';
          grid.append(left, right);
          const back = ui.createBackButton!(ctx);
          const title = document.createElement('h1');
          title.className = 'ui-title';
          title.textContent = 'Dot design system';
          const style = document.createElement('style');
          style.textContent = '.screen--gallery{justify-content:flex-start;padding-top:calc(var(--safe-top,0px) + 96px);gap:var(--space-4)}' +
            '.g-grid{display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);width:min(1040px,100%)}' +
            '.g-col{display:flex;flex-direction:column;gap:var(--space-3);min-width:0}' +
            '.screen--gallery .tabs{width:min(1040px,100%)}';
          root.append(style, back as Node, title, el(tabs), grid);
        },
        unmount() {
          if (host) field.unmount(host);
        },
        onBack() {
          return (ui.closeTopModal as () => boolean)();
        },
        onFrame(f: { nowMs: number }) {
          field.frame(f.nowMs);
        },
      };
    });
    app.router.go('tutorial');
  });
  await expect(page.getByTestId('g-primary')).toBeVisible();
}

const galleryLog = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __galleryLog: string[] }).__galleryLog.slice());

test.describe('UIX-01 Dot design system', () => {
  test('fonts are inlined as data URIs, loaded, and used by the UI', async ({ page }) => {
    const html = readFileSync(resolve(DIST, 'index.html'), 'utf8');
    const uris = html.match(/data:font\/woff2;base64,[A-Za-z0-9+/=]+/g) ?? [];
    expect(uris).toHaveLength(5);
    const bytes = uris.reduce((n, u) => n + Math.floor(((u.length - 'data:font/woff2;base64,'.length) * 3) / 4), 0);
    expect(bytes).toBeLessThan(120_000); // Latin subsets only
    expect(html).not.toMatch(/url\(["']?(https?:)?\/\/[^)]*\.(woff2?|ttf|otf)/);
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);

    const messages = collectConsole(page);
    await bootToMain(page);
    const fonts = await page.evaluate(async () => {
      await document.fonts.ready;
      const faces: string[] = [];
      document.fonts.forEach((f) => {
        if (f.status === 'loaded') faces.push(`${f.family.replace(/["']/g, '')} ${f.weight}`);
      });
      const checks = ['400 16px "Space Grotesk"', '500 16px "Space Grotesk"', '700 16px "Space Grotesk"', '400 16px "JetBrains Mono"', '600 16px "JetBrains Mono"']
        .map((q) => document.fonts.check(q));
      const title = document.querySelector('#ui h1, #ui .ui-title');
      return {
        faces: faces.sort(),
        checks,
        bodyFont: getComputedStyle(document.body).fontFamily,
        titleFont: title ? getComputedStyle(title).fontFamily : '',
        numFont: (() => {
          const n = document.createElement('span');
          n.className = 'num';
          document.body.append(n);
          const f = getComputedStyle(n);
          const out = `${f.fontFamily} | ${f.fontVariantNumeric}`;
          n.remove();
          return out;
        })(),
      };
    });
    expect(fonts.faces).toEqual(['JetBrains Mono 400', 'JetBrains Mono 600', 'Space Grotesk 400', 'Space Grotesk 500', 'Space Grotesk 700']);
    expect(fonts.checks).toEqual([true, true, true, true, true]);
    expect(fonts.bodyFont).toMatch(/^"?Space Grotesk"?/);
    expect(fonts.titleFont).toMatch(/Space Grotesk/);
    expect(fonts.numFont).toMatch(/^"?JetBrains Mono"?.*\| tabular-nums$/);
    expect(messages).toEqual([]);
  });

  test('dot field: animates behind the menus at <= 30 fps, follows focus, and stops completely in a match', async ({ page }) => {
    test.setTimeout(180_000);
    const messages = collectConsole(page);
    await bootToMain(page);
    // The main menu (UIX-02) shows the shared field behind its content.
    await expect(page.locator('[data-screen="main"] > canvas.dotfield')).toHaveCount(1);
    await expect(page.locator('canvas.dotfield')).toBeVisible();
    const a = await stats(page);
    const t0 = Date.now();
    await page.waitForTimeout(2000);
    const b = await stats(page);
    const secs = (Date.now() - t0) / 1000;
    const rate = (b.draws - a.draws) / secs;
    const loopRate = (b.frames - a.frames) / secs;
    expect(rate, `draw rate ${rate.toFixed(1)}/s, loop ${loopRate.toFixed(1)}/s`).toBeGreaterThan(8);
    expect(rate).toBeLessThanOrEqual(31.5);
    expect(b.visible && b.mounted && !b.blocked).toBe(true);
    expect(await inkedSamples(page)).toBeGreaterThan(400);

    // Parallax: focus on the left vs the right of the gallery moves the layers the other way.
    await openGallery(page);
    await page.keyboard.press('ArrowDown'); // first press reveals the ring
    await page.waitForTimeout(1500);
    const leftX = (await stats(page)).parallaxX;
    for (let i = 0; i < 2; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1500);
    const rightX = (await stats(page)).parallaxX;
    expect(leftX).toBeLessThan(0);
    expect(rightX).toBeGreaterThan(leftX + 0.15);

    // Into a match: the menu screens unmount, the field is hidden and draws nothing.
    await page.evaluate(() => window.__dotkick!.app.router.go('main'));
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match' && (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 60_000 });
    const m0 = await stats(page);
    const tick0 = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
    await page.waitForTimeout(1500);
    const m1 = await stats(page);
    const tick1 = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
    expect(tick1).toBeGreaterThan(tick0); // the match is running
    expect(m1.draws).toBe(m0.draws);
    expect(m1.mounted).toBe(false);
    expect(m1.visible).toBe(false);
    expect(await page.locator('canvas.dotfield:visible').count()).toBe(0);

    // A menu opened over the paused match (like Settings from the pause menu) keeps forwarding frames: still no drawing.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await openGallery(page);
    const g0 = await stats(page);
    await page.waitForTimeout(1000);
    const g1 = await stats(page);
    expect(g1.frames).toBeGreaterThan(g0.frames); // frames arrive...
    expect(g1.draws).toBe(g0.draws); // ...but nothing is drawn
    expect(g1.blocked).toBe(true);
    expect(await page.locator('canvas.dotfield:visible').count()).toBe(0);

    // Quit back to the menus: the field runs again.
    await page.evaluate(() => window.__dotkick!.ctx.session.quit());
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    const q0 = await stats(page);
    await page.waitForTimeout(800);
    expect((await stats(page)).draws).toBeGreaterThan(q0.draws);
    expect(messages).toEqual([]);
  });

  test('dot field draw cost stays small (script time per drawn frame, fastest of 6 batches, software Chromium)', async ({ page }) => {
    await bootToMain(page);
    const r = await page.evaluate(() => {
      const f = window.__dotkickDotField!;
      const loop = window.__dotkick!.app.loop;
      loop.stop();
      let now = 1e7;
      f.frame(now); // layout
      const draws0 = f.stats.draws;
      // The container is shared by many agents: the fastest batch is the honest cost, the others measure the load.
      let best = Infinity;
      for (let b = 0; b < 6; b++) {
        const t0 = performance.now();
        for (let i = 0; i < 10; i++) {
          now += 34;
          f.frame(now);
        }
        best = Math.min(best, (performance.now() - t0) / 10);
      }
      loop.start();
      return { ms: best, drawn: f.stats.draws - draws0, dots: f.stats.dots };
    });
    expect(r.drawn).toBe(60);
    expect(r.dots).toBeGreaterThan(1000);
    // About 1 ms on an idle machine; the budget catches an order-of-magnitude regression (e.g. one fill per dot).
    expect(r.ms, `${r.ms.toFixed(2)} ms per draw for ${r.dots} dots`).toBeLessThan(6);
  });

  test('components work by touch alone', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await openGallery(page);
    const toggle = page.getByTestId('g-toggle');
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    // Real touch drag on the slider track (CDP touch events -> pointer events with capture).
    const slider = page.getByTestId('g-slider');
    const track = slider.locator('.sld__track');
    const box = (await track.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width * 0.5, y }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * 0.8, y: y + 30 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: box.x + box.width * 0.9, y: y + 60 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(slider).toHaveAttribute('aria-valuenow', '0.9');
    await expect(slider.locator('.sld__value')).toHaveText('90%');

    const selector = page.getByTestId('g-selector');
    await selector.locator('[data-adjust="inc"]').tap();
    await expect(selector.locator('.sel__value')).toHaveText('World Class');
    await page.getByTestId('g-seg-wide').tap();
    await expect(page.getByTestId('g-seg-wide')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('g-tab-video').tap();
    await expect(page.getByTestId('g-tab-video')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId('g-open-modal').tap();
    await expect(page.getByTestId('g-modal')).toBeVisible();
    // A tap on the scrim (outside the dialog) closes it; the screen stays.
    await page.touchscreen.tap(20, 800);
    await expect(page.getByTestId('g-modal')).toHaveCount(0);
    expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('tutorial');

    await page.getByTestId('g-toast-btn').tap();
    await expect(page.getByTestId('g-toast')).toBeVisible();
    // It removes itself after its CSS fade-out (no timers).
    await expect(page.getByTestId('g-toast')).toHaveCount(0, { timeout: 6000 });

    // Every focusable control is at least 60 x 60 CSS px.
    const small = await page.evaluate(() => {
      const out: string[] = [];
      document.querySelectorAll<HTMLElement>('[data-screen="tutorial"] [data-focus]').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.height < 59.5 || r.width < 59.5) out.push(`${e.dataset.testid ?? e.className} ${r.width}x${r.height}`);
      });
      return out;
    });
    expect(small).toEqual([]);

    // Every change reached its onChange once, in order (slider changes are live while dragging).
    const log = (await galleryLog(page)).filter((x) => !x.startsWith('slider:'));
    expect(log).toEqual(['toggle:true', 'sel:3', 'seg:wide', 'tab:video']);
    expect(await galleryLog(page)).toContain('slider:0.9');
    expect(messages).toEqual([]);
  });

  test('components work by keyboard (controller) alone, with a visible focus ring', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__dotkick?.ctx.router.current === 'main');
    await openGallery(page);
    const focused = (): Promise<string | null> => page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);
    await expect.poll(focused).toBe('g-primary');
    // Start with the ring hidden (as after a touch): the first direction press only reveals it.
    await page.evaluate(() => (window.__dotkick!.ctx.focus as unknown as { hideRing(): void }).hideRing());
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => page.evaluate(() => document.documentElement.hasAttribute('data-focus-visible'))).toBe(true);
    const ring = await page.evaluate(() => {
      const e = document.querySelector<HTMLElement>('[data-focused]')!;
      const cs = getComputedStyle(e);
      return { visible: document.documentElement.hasAttribute('data-focus-visible'), outline: cs.outlineStyle, color: cs.outlineColor };
    });
    expect(ring.visible).toBe(true);
    expect(ring.outline).toBe('solid');
    expect(ring.color).toBe('rgb(255, 107, 53)');

    // Walk down to the toggle and flip it with Enter, then LEFT switches it off again.
    await expect.poll(focused).toBe('g-primary');
    await page.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe('g-secondary');
    await page.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe('g-toggle');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('g-toggle')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByTestId('g-toggle')).toHaveAttribute('aria-checked', 'false');

    // Slider: LEFT / RIGHT step it (focus stays).
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(60);
    await expect.poll(focused).toBe('g-slider');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('g-slider')).toHaveAttribute('aria-valuenow', '0.6');
    await expect.poll(focused).toBe('g-slider');
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(SHOTS, 'focus-ring-ipad-1180x820.png') });

    // Selector: RIGHT goes to the next option.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(60);
    await expect.poll(focused).toBe('g-selector');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('g-selector').locator('.sel__value')).toHaveText('World Class');

    // Tabs: E / Q switch tabs from anywhere on the screen.
    await page.keyboard.press('e');
    await expect(page.getByTestId('g-tab-audio')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('q');
    await page.waitForTimeout(60);
    await page.keyboard.press('q');
    await expect(page.getByTestId('g-tab-video')).toHaveAttribute('aria-selected', 'true');

    // Modal: Enter opens, focus moves into it, Escape closes it and the screen stays.
    await page.evaluate(() => (document.querySelector('[data-testid="g-open-modal"]') as HTMLElement).focus());
    await page.waitForTimeout(60);
    await expect.poll(focused).toBe('g-open-modal');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('g-modal')).toBeVisible();
    await page.waitForTimeout(60);
    await expect.poll(focused).toBe('g-modal-quit');
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(60);
    await expect.poll(focused).toBe('g-modal-stay');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('g-modal')).toHaveCount(0);
    await page.waitForTimeout(400); // past the router's key / menu Back de-dupe window
    expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('tutorial');
    await expect.poll(focused).toBe('g-open-modal'); // focus returns where it was
    // Back (Escape) with no modal leaves the screen.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'main');
    expect(messages).toEqual([]);
  });

  for (const vp of [
    { name: 'ipad-1180x820', width: 1180, height: 820 },
    { name: '4x3-1024x768', width: 1024, height: 768 },
    { name: '21x9-1260x540', width: 1260, height: 540 },
  ]) {
    test(`screenshots: main menu and gallery at ${vp.name}`, async ({ page }) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await bootToMain(page);
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(SHOTS, `main-${vp.name}.png`) });
      await openGallery(page);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.getByTestId('g-toast-btn').click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOTS, `gallery-${vp.name}.png`) });
      // Nothing scrolls off: the page never overflows the viewport.
      const overflow = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
      expect(overflow.w).toBeLessThanOrEqual(vp.width);
      expect(overflow.h).toBeLessThanOrEqual(vp.height);
      await page.getByTestId('g-open-modal').click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOTS, `modal-${vp.name}.png`) });
    });
  }
});
