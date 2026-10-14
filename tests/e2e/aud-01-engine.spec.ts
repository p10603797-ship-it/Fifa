/**
 * [AUD-01] Audio engine lifecycle in a real browser (Web Audio in headless Chromium):
 *  - no AudioContext before the first tap; the splash tap unlocks it (running), output fades up, limiter in place;
 *  - buffers are pre-rendered by the frame loop; the voice cap holds under a burst of 40 one-shots;
 *  - hidden page suspends the context, visible resumes it (glitch: silent after returning from the background);
 *  - pause menu: crowd ducked, effects muted and one-shots stopped (glitch: sounds stacking after a pause);
 *  - zero console errors or warnings throughout.
 * Run: npx vite build --outDir dist-e2e/aud-01 --emptyOutDir && PW_DIST=dist-e2e/aud-01 PW_PORT=4201 npx playwright test tests/e2e/aud-01-engine.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { AUDIO_ENGINE_TUNING, type AudioEngineImpl } from '../../src/audio/engine';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function audioState(page: Page): Promise<string> {
  return page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state);
}

test.describe('AUD-01 audio engine', () => {
  test('unlock on tap, pre-render, voice cap, suspend on hidden and resume on visible, no errors', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    // Nothing is created before the user gesture (no autoplay warning).
    expect(await audioState(page)).toBe('none');
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state === 'running');
    const graph = await page.evaluate(() => {
      const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
      const s = a.services!;
      return { unlocked: a.unlocked, caps: [s.effects.capacity, s.crowd.capacity, s.menus.capacity], info: a.info() };
    });
    expect(graph.unlocked).toBe(true);
    expect(graph.caps).toEqual([AUDIO_ENGINE_TUNING.effectsVoices, AUDIO_ENGINE_TUNING.crowdVoices, AUDIO_ENGINE_TUNING.menusVoices]);
    expect(graph.info.moduleFailures.every((n) => n === 0)).toBe(true);

    // A module-style buffer is rendered by the running frame loop (update() pumps the bank).
    await page.evaluate(() => {
      const s = (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!;
      s.bank.define('aud01.e2e.tick', 0.4, 1, (out, from, to, sr) => {
        const ch = out[0]!;
        for (let i = from; i < to; i++) ch[i] = 0.2 * Math.sin(i * 0.07) * Math.exp((-12 * i) / sr);
      });
    });
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!.bank.pending === 0);
    const burst = await page.evaluate(() => {
      const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
      const s = a.services!;
      const buf = s.bank.get(s.bank.handle('aud01.e2e.tick'));
      let maxActive = 0;
      for (let i = 0; i < 40; i++) {
        s.effects.play(buf, 0.5, (i % 5) / 2 - 1, 1 + (i % 4) * 0.05);
        maxActive = Math.max(maxActive, s.effects.active());
      }
      return { ok: buf !== null, maxActive, steals: s.effects.allocator.steals, outputUp: a.info().outputUp };
    });
    expect(burst.ok).toBe(true);
    expect(burst.maxActive).toBe(AUDIO_ENGINE_TUNING.effectsVoices);
    expect(burst.steals).toBe(40 - AUDIO_ENGINE_TUNING.effectsVoices);
    expect(burst.outputUp).toBe(true);
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!.effects.active() === 0);

    // Background and back.
    await setVisibility(page, 'hidden');
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state === 'suspended');
    await setVisibility(page, 'visible');
    await page.waitForFunction(() => {
      const i = (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info();
      return i.state === 'running' && i.outputUp;
    });
    // The clock really moves again (not a zombie context).
    const t0 = await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).context!.currentTime);
    await page.waitForFunction((t) => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).context!.currentTime > t + 0.1, t0);
    expect(await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().stalled)).toBe(false);
    expect(messages).toEqual([]);
  });

  test('pause menu ducks the crowd and stops one-shots; hidden mid-match suspends, return resumes; no errors', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 30, null, { timeout: 60_000 });
    expect(await audioState(page)).toBe('running');

    // Fill the effects pool, then pause: one-shots stop, effects bus mutes, crowd stays (ducked).
    await page.evaluate(() => {
      const s = (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!;
      s.bank.define('aud01.e2e.long', 2, 1, (out, from, to) => {
        const ch = out[0]!;
        for (let i = from; i < to; i++) ch[i] = 0.05 * Math.sin(i * 0.03);
      });
      s.bank.flush();
      const buf = s.bank.get(s.bank.handle('aud01.e2e.long'));
      for (let i = 0; i < 8; i++) s.effects.play(buf, 0.3);
    });
    expect(await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!.effects.active())).toBeGreaterThanOrEqual(8);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    expect(await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).paused)).toBe(true);
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!.effects.active() === 0);
    // The real AudioParams settle on the ducked mix: crowd at a fraction, effects silent, menus untouched.
    await page.waitForFunction((duck) => {
      const d = window.__dotkick!.ctx;
      const v = d.settings.get().audio;
      const l = (d.audio as unknown as AudioEngineImpl).info().levels;
      return Math.abs(l.crowd - v.crowd * duck) < 0.01 && l.effects < 0.01 && Math.abs(l.menus - v.menus) < 0.01 && l.crowd > 0;
    }, AUDIO_ENGINE_TUNING.pauseCrowdDuck);

    // Hidden while paused, then back: running again, still paused (the pause menu shows).
    await setVisibility(page, 'hidden');
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state === 'suspended');
    await setVisibility(page, 'visible');
    await page.waitForFunction(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info().state === 'running');
    expect(await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).paused)).toBe(true);

    await page.getByTestId('pause-resume').tap();
    await page.waitForFunction(() => !(window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).paused);
    await page.waitForFunction(() => {
      const d = window.__dotkick!.ctx;
      const v = d.settings.get().audio;
      const l = (d.audio as unknown as AudioEngineImpl).info().levels;
      return Math.abs(l.crowd - v.crowd) < 0.01 && Math.abs(l.effects - v.effects) < 0.01 && l.output > 0.99;
    });
    const tick = await page.evaluate(() => window.__dotkick!.ctx.session.getState()!.tick);
    await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > t + 10, tick);
    const info = await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info());
    expect(info.state).toBe('running');
    expect(info.outputUp).toBe(true);
    expect(info.stalled).toBe(false);
    expect(info.moduleFailures.every((n) => n === 0)).toBe(true);
    expect(messages).toEqual([]);
  });
});
