/**
 * [AUD-02/03/04] Match audio in a real browser (Web Audio in headless Chromium), one match:
 *  - AUD-02: the crowd bed loops run during the match and the intensity follows play; reactions play; no errors.
 *  - AUD-03: real gameplay produces ball sounds; injected KICK / POST / NET / TACKLE events sound; a burst of 60
 *    sounds stays within the effects voice cap.
 *  - AUD-04: WHISTLE events of every kind trigger the whistles (and the final whistle the full-time sting).
 * The buffer bank is flushed once (software rendering is slow here; on a device it renders in the background).
 * Run: npx vite build --outDir dist-e2e/aud-01 --emptyOutDir && PW_DIST=dist-e2e/aud-01 PW_PORT=4201 npx playwright test tests/e2e/aud-02-match-audio.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { KickKind } from '../../src/contracts/enums';
import { EventType, WhistleKind } from '../../src/contracts/events';
import type { CrowdModule } from '../../src/audio/crowd';
import { AUDIO_ENGINE_TUNING, type AudioEngineImpl } from '../../src/audio/engine';
import type { SfxModule } from '../../src/audio/sfx';
import type { WhistleModule } from '../../src/audio/whistles';

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

/** Feed one tick of synthetic events through the engine (as the loop does after a sim tick). */
async function inject(page: Page, events: number[][]): Promise<void> {
  await page.evaluate((list) => {
    const d = window.__dotkick!.ctx;
    const evs: { type: number; tick: number; a: number; b: number; c: number; d: number; x: number; y: number; z: number }[] = [];
    for (const e of list) evs.push({ type: e[0]!, tick: 0, a: e[1] ?? 0, b: e[2] ?? 0, c: e[3] ?? 0, d: e[4] ?? 0, x: e[5] ?? 0, y: e[6] ?? 0, z: e[7] ?? 0 });
    const buf = {
      get count() { return evs.length; },
      get: (i: number) => evs[i]!,
      begin: () => undefined,
      emit: () => undefined,
    };
    (d.audio as unknown as AudioEngineImpl).onEvents(buf as never, d.session.getState()!);
  }, events);
}

test.describe('AUD-02/03/04 match audio', () => {
  test('crowd bed and reactions, ball/frame/net/tackle sounds within the voice cap, whistles by kind; no errors', async ({ page }) => {
    test.setTimeout(120_000);
    const messages = collectConsole(page);
    await page.goto('/');
    await page.getByTestId('splash-start').tap();
    await page.getByTestId('main-kickoff').tap();
    await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 30, null, { timeout: 60_000 });
    await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).services!.bank.flush());

    await test.step('AUD-02 crowd bed runs and follows the match', async () => {
      await page.waitForFunction(() => {
        const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
        return (a.services!.modules.crowd as unknown as CrowdModule).bedRunning;
      });
      const c = await page.evaluate(() => {
        const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
        const crowd = a.services!.modules.crowd as unknown as CrowdModule;
        return { intensity: crowd.intensity, target: crowd.target, crowdLevel: a.info().levels.crowd };
      });
      expect(c.intensity).toBeGreaterThan(0);
      expect(c.intensity).toBeLessThanOrEqual(1);
      expect(c.crowdLevel).toBeGreaterThan(0);
      await inject(page, [[EventType.SHOT, 9, 1, 0.4], [EventType.ATTACK_BUILD, 0, 0, 1]]);
      await inject(page, [[EventType.GOAL, 0, 9, -1, 0, 52.6, 1, 0]]);
      const reactions = await page.evaluate(() => {
        const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
        return Array.from((a.services!.modules.crowd as unknown as CrowdModule).stats.reactions).reduce((x, y) => x + y, 0);
      });
      expect(reactions).toBeGreaterThanOrEqual(2);
    });

    await test.step('AUD-03 gameplay and injected events sound; the voice cap holds', async () => {
      // Real play: the sim's own kicks and touches reach the sfx module.
      await page.waitForFunction(() => {
        const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
        return Array.from((a.services!.modules.sfx as unknown as SfxModule).stats.played).reduce((x, y) => x + y, 0) > 0;
      }, null, { timeout: 60_000 });
      await inject(page, [[EventType.KICK, 9, KickKind.SHOT_POWER, 1, 0, 40, 0.1, 0]]);
      await inject(page, [[EventType.POST, 1, 1, 20, 0, 52.5, 2.4, 1], [EventType.NET, 1, 0, 18, 0, 52.6, 1, 0]]);
      await inject(page, [[EventType.TACKLE, 9, 15, 1, 2]]);
      const r = await page.evaluate((cap) => {
        const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
        const sfx = a.services!.modules.sfx as unknown as SfxModule;
        const pool = a.services!.effects;
        let max = 0;
        for (let i = 0; i < 60; i++) {
          sfx.kick(13 + (i % 5), (i % 10) / 10, i - 30);
          max = Math.max(max, pool.active());
        }
        return { played: Array.from(sfx.stats.played), max, cap };
      }, AUDIO_ENGINE_TUNING.effectsVoices);
      expect(r.played[2]).toBeGreaterThanOrEqual(1); // strike
      expect(r.played[6]).toBeGreaterThanOrEqual(1); // post / bar
      expect(r.played[7]).toBeGreaterThanOrEqual(1); // net
      expect(r.played[9]).toBeGreaterThanOrEqual(1); // slide tackle
      expect(r.max).toBeLessThanOrEqual(r.cap);
    });

    await test.step('AUD-04 whistle events of each kind trigger whistles; the final one the full-time sting', async () => {
      for (const k of [WhistleKind.SHORT, WhistleKind.START, WhistleKind.LONG, WhistleKind.FINAL]) await inject(page, [[EventType.WHISTLE, k]]);
      const w = await page.evaluate(() => {
        const a = window.__dotkick!.ctx.audio as unknown as AudioEngineImpl;
        const wh = a.services!.modules.whistles as unknown as WhistleModule;
        return { whistles: Array.from(wh.stats.whistles), stings: Array.from(wh.stats.stings) };
      });
      for (let k = 0; k < 4; k++) expect(w.whistles[k], `whistle kind ${k}`).toBeGreaterThanOrEqual(1);
      expect(w.stings[2]).toBeGreaterThanOrEqual(1); // full time
      expect(w.stings[1]).toBeGreaterThanOrEqual(1); // goal (from the GOAL event above)
    });

    const info = await page.evaluate(() => (window.__dotkick!.ctx.audio as unknown as AudioEngineImpl).info());
    expect(info.state).toBe('running');
    expect(info.moduleFailures.every((n) => n === 0)).toBe(true);
    expect(info.bankFailed).toBe(0);
    expect(messages).toEqual([]);
  });
});
