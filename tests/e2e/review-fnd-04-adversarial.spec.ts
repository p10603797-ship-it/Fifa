/**
 * REVIEW of FND-04 (independent reviewer): adversarial end-to-end tests for the app shell.
 * Recovery after the whistle, half-time recovery, square windows, quit/restart leaks, blocked or corrupt storage,
 * hidden page during loading, bfcache, pointercancel / blur mid-hold, resize storms, WebGL context loss,
 * phase flow (half-time, full-time, rematch, change teams) and touch target sizes. 120 Hz timing is covered in
 * tests/unit/review-fnd-04-adversarial.test.ts (SwiftShader cannot hold 60 fps at iPad size, so an e2e rate test
 * would measure the container, not the loop).
 * Requires `npx vite build` first (playwright.config.ts serves dist/ with vite preview).
 * Phases are driven by writing state.match.phase (the Wave 0 sim does not change phases yet); the session watches
 * phases after every tick exactly as it will with the real rules.
 */
import { expect, test, type Page } from '@playwright/test';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
/** MatchPhase values (src/contracts/enums.ts). */
const PHASE = { IN_PLAY: 2, HALF_TIME: 11, FULL_TIME: 12, POST_MATCH: 15 } as const;
const COMMAND_SKIP = 15;

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

async function tick(page: Page): Promise<number> {
  return page.evaluate(() => window.__dotkick!.ctx.session.getState()?.tick ?? -1);
}

async function current(page: Page): Promise<string | null> {
  return page.evaluate(() => window.__dotkick!.ctx.router.current);
}

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  const start = page.getByTestId('splash-start');
  await expect(start).toBeVisible();
  await start.tap();
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
}

async function waitMatch(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded;
  }, null, { timeout: 30_000 });
}

async function kickOff(page: Page): Promise<void> {
  await page.getByTestId('main-kickoff').tap();
  await waitMatch(page);
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 10, null, { timeout: 10_000 });
}

async function setPhase(page: Page, phase: number): Promise<void> {
  await page.evaluate((p) => {
    const rt = window.__dotkick!.app.session.runtime()!;
    rt.curr.match.phase = p;
  }, phase);
}

async function setVisibility(page: Page, state: 'hidden' | 'visible'): Promise<void> {
  await page.evaluate((s) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => s });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => s === 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

async function injectUncaughtError(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('review-fnd-04 injected error');
    }, 0);
  });
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'recovery');
}

/** Movement magnitude and buttons of human 0's frame for the latest tick (read from the runtime frames). */
async function human0Frame(page: Page): Promise<{ m: number; buttons: number }> {
  return page.evaluate(() => {
    const f = window.__dotkick!.app.session.runtime()!.frames[0]!;
    return { m: Math.hypot(f.mx, f.mz), buttons: f.buttons };
  });
}

async function waitTicks(page: Page, n: number): Promise<void> {
  const t0 = await tick(page);
  await page.waitForFunction((t) => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) >= t, t0 + n, { timeout: 10_000 });
}

test.describe('REVIEW FND-04 adversarial', () => {
  test('recovery Resume after the final whistle does not strand the player on a finished match', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await setPhase(page, PHASE.POST_MATCH);
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'full-time' && window.__dotkick!.app.session.finished);
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    await injectUncaughtError(page);
    await page.getByTestId('recovery-resume').tap();
    await page.waitForTimeout(300);
    const where = await current(page);
    // Observed with the FND-04 build: 'match' with a finished match, no pause menu, and Back/Escape/pause do nothing.
    if (where === 'match') {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const stuck = await page.evaluate(() => ({
        cur: window.__dotkick!.ctx.router.current,
        finished: window.__dotkick!.app.session.finished,
        paused: window.__dotkick!.ctx.session.paused,
        pauseMenu: !!document.querySelector('[data-testid="pause-menu"]:not([hidden])'),
      }));
      expect(stuck, 'soft-lock: finished match on the match screen with no way out').toEqual({
        cur: 'full-time', finished: true, paused: false, pauseMenu: false,
      });
    }
    expect(where).toBe('full-time');
  });

  test('recovery Resume during half-time returns to the half-time screen', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await setPhase(page, PHASE.HALF_TIME);
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'half-time');
    await injectUncaughtError(page);
    await page.getByTestId('recovery-resume').tap();
    await page.waitForTimeout(300);
    const s = await page.evaluate(() => ({
      cur: window.__dotkick!.ctx.router.current,
      phase: window.__dotkick!.ctx.session.getState()!.match.phase,
      paused: window.__dotkick!.ctx.session.paused,
    }));
    // The sim is still in HALF_TIME and running, so the half-time screen (with Continue) must be shown.
    expect(s).toEqual({ cur: 'half-time', phase: 11, paused: false });
  });

  test('square window: the rotate card and the pause state agree', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({
      card: getComputedStyle(document.getElementById('rotate')!).display !== 'none',
      paused: window.__dotkick!.ctx.session.paused,
    }));
    // The card says "The game is paused"; it must not cover a running match (or the match must pause).
    expect(s.card, `rotate card shown=${s.card} while paused=${s.paused}`).toBe(s.paused);
  });

  test('a refused resume while the window is too small does not leave a false "Only Player 0" message', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await page.setViewportSize({ width: 500, height: 300 });
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
    // Keyboard Enter on the focused Resume button while blocked (the rotate card covers the menu).
    await page.evaluate(() => (document.querySelector('[data-testid="pause-resume"]') as HTMLButtonElement).click());
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    const who = await page.locator('.pause-who').textContent();
    expect(who ?? '').not.toMatch(/Player 0/);
  });

  test('quit and restart twice: no leaked listeners, overlays, screens or styles', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    const cdp = await page.context().newCDPSession(page);
    const listenerCounts = async (): Promise<{ window: number; document: number }> => {
      const out = { window: 0, document: 0 };
      for (const key of ['window', 'document'] as const) {
        const { result } = await cdp.send('Runtime.evaluate', { expression: key });
        const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId! });
        out[key] = listeners.length;
        await cdp.send('Runtime.releaseObject', { objectId: result.objectId! });
      }
      return out;
    };
    const domCounts = () => page.evaluate(() => ({
      touch: document.getElementById('touch')!.querySelectorAll('*').length,
      ui: document.getElementById('ui')!.children.length,
      hud: document.getElementById('hud')!.querySelectorAll('*').length,
      styles: document.head.querySelectorAll('style').length,
      body: document.body.children.length,
    }));

    await kickOff(page);
    const inMatch1 = await domCounts();
    await page.keyboard.press('Escape');
    await page.getByTestId('pause-quit').tap();
    await page.getByTestId('pause-quit-confirm').tap(); // UIX-08 quit confirmation (INT-B)
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    const base = await listenerCounts();
    const baseDom = await domCounts();

    for (let round = 0; round < 2; round++) {
      await kickOff(page);
      // Restart twice from the pause menu.
      for (let r = 0; r < 2; r++) {
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('pause-menu')).toBeVisible();
        await page.getByTestId('pause-restart').tap();
        await waitMatch(page);
        await page.waitForTimeout(300);
        expect(await domCounts()).toEqual(inMatch1);
      }
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pause-menu')).toBeVisible();
      await page.getByTestId('pause-quit').tap();
      await page.getByTestId('pause-quit-confirm').tap(); // UIX-08 quit confirmation (INT-B)
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
    }
    expect(await listenerCounts()).toEqual(base);
    expect(await domCounts()).toEqual(baseDom);
    expect(messages).toEqual([]);
  });

  test('blocked localStorage (SecurityError on access) boots, plays and quits with no errors', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    const messages = collectConsole(page);
    await bootToMain(page);
    expect(await page.evaluate(() => window.__dotkick!.ctx.settings.persistent)).toBe(false);
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.audio.master = 0.5; }));
    expect(await page.evaluate(() => window.__dotkick!.ctx.settings.get().audio.master)).toBe(0.5);
    await kickOff(page);
    await page.keyboard.press('Escape');
    await page.getByTestId('pause-quit').tap();
    // UIX-08: Quit asks for confirmation first (INT-B: updated for the pause menu's quit-confirm dialog).
    await page.getByTestId('pause-quit-confirm').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    expect(messages).toEqual([]);
  });

  test('quota-full localStorage (every setItem throws) boots and keeps settings in memory', async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.setItem = function setItem(): void {
        throw new DOMException('quota', 'QuotaExceededError');
      };
    });
    const messages = collectConsole(page);
    await bootToMain(page);
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.debug = true; }));
    await expect(page.getByTestId('debug-overlay')).toBeVisible();
    await page.evaluate(() => window.__dotkick!.ctx.settings.update((s) => { s.debug = false; }));
    await kickOff(page);
    expect(messages).toEqual([]);
  });

  test('corrupt and out-of-range stored settings never reach the recovery screen', async ({ page }) => {
    await page.addInitScript(() => {
      if (sessionStorage.getItem('review-seeded')) return;
      sessionStorage.setItem('review-seeded', '1');
      localStorage.setItem('dotkick.settings', JSON.stringify({
        schema: 1,
        camera: { type: 99, height: -50, zoom: 1e6 },
        graphics: { tier: 42, showFps: true, resolutionScale: 7 },
        audio: { master: 9, crowd: -3, effects: 'loud', menus: null },
        match: { halfMinutes: 0, homeClub: 999, awayClub: -4, homeFormation: 77, difficulty: 55, homeKit: 9, awayKit: -1 },
        controls: { assist: 9, autoSwitch: 9, touch: { opacity: 40, spacing: -2 } },
      }));
    });
    const messages = collectConsole(page);
    const visited: string[] = [];
    await page.exposeFunction('__reviewVisit', (id: string) => { visited.push(id); });
    await page.addInitScript(() => {
      const t = setInterval(() => {
        const d = (window as unknown as { __dotkick?: { ctx: { router: { current: string | null } } } }).__dotkick;
        const w = window as unknown as { __reviewVisit(id: string): void; __last?: string | null };
        if (d && d.ctx.router.current !== w.__last) {
          w.__last = d.ctx.router.current;
          if (w.__last) w.__reviewVisit(w.__last);
        }
      }, 20);
      void t;
    });
    await bootToMain(page);
    await kickOff(page);
    await page.waitForTimeout(500);
    expect(visited).not.toContain('recovery');
    expect(messages).toEqual([]);
  });

  test('hidden page during loading: the match opens paused with the pause menu and never ticks while hidden', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    // [FND-04 fix] Kick-Off and the hide in the same task, so the page is hidden while the loading screen is up.
    // A tap followed by a separate setVisibility() round trip raced the ~200 ms load: under SwiftShader the first
    // match frame holds the page for over a second, so the hide often landed after the match had started ticking.
    const during = await page.evaluate(() => {
      (document.querySelector('[data-testid="main-kickoff"]') as HTMLButtonElement).click();
      const at = window.__dotkick!.ctx.router.current;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      return at;
    });
    expect(during).toBe('loading');
    await page.waitForTimeout(1500);
    const hidden = await page.evaluate(() => ({
      tick: window.__dotkick!.ctx.session.getState()?.tick ?? 0,
      running: window.__dotkick!.app.loop.running,
      paused: window.__dotkick!.ctx.session.paused,
    }));
    expect(hidden.running).toBe(false);
    expect(hidden.tick).toBe(0);
    await setVisibility(page, 'visible');
    await waitMatch(page);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    const t0 = await tick(page);
    await page.waitForTimeout(300);
    expect(await tick(page)).toBe(t0);
    await page.getByTestId('pause-resume').tap();
    await waitTicks(page, 5);
    expect(messages).toEqual([]);
  });

  test('bfcache pagehide -> pageshow pauses, restarts the loop and shows the pause menu', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    expect(await page.evaluate(() => window.__dotkick!.app.loop.running)).toBe(false);
    expect(await page.evaluate(() => window.__dotkick!.ctx.session.pausedBy)).toBe(-1);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    expect(await page.evaluate(() => window.__dotkick!.app.loop.running)).toBe(true);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-resume').tap();
    await waitTicks(page, 5);
    expect(messages).toEqual([]);
  });

  test('pointercancel and window blur mid-hold release the stick (no stuck movement)', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    const cdp = await page.context().newCDPSession(page);
    const hold = async (): Promise<void> => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 220, y: 560, id: 7 }] });
      for (let i = 1; i <= 6; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 220 + i * 25, y: 560, id: 7 }] });
      }
      await waitTicks(page, 3);
    };
    // 1. pointercancel (iPadOS multitasking gesture).
    await hold();
    expect((await human0Frame(page)).m, 'stick held: movement expected').toBeGreaterThan(0.2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await waitTicks(page, 3);
    expect((await human0Frame(page)).m).toBe(0);
    // 2. window blur while the finger is still down.
    await hold();
    expect((await human0Frame(page)).m).toBeGreaterThan(0.2);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await waitTicks(page, 3);
    expect((await human0Frame(page)).m).toBe(0);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    // 3. pause mid-hold, finger lifted while paused, resume: nothing stuck.
    await hold();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.getByTestId('pause-resume').tap();
    await waitTicks(page, 5);
    expect((await human0Frame(page)).m).toBe(0);
    expect(messages).toEqual([]);
  });

  test('resize storm mid-match keeps ticking; too-small pauses and recovers to the pause menu', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    for (const [w, h] of [[1366, 1024], [1024, 768], [2100, 900], [1180, 820], [1600, 760]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await waitTicks(page, 4);
      expect(await page.evaluate(() => window.__dotkick!.ctx.session.paused)).toBe(false);
    }
    await page.setViewportSize({ width: 500, height: 300 });
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
    await expect(page.locator('#rotate .msg-small')).toBeVisible();
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.getByTestId('pause-resume').tap();
    await waitTicks(page, 5);
    expect(messages).toEqual([]);
  });

  test('WebGL context loss pauses; after restore the match resumes from the pause menu', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await bootToMain(page);
    await kickOff(page);
    const lost = await page.evaluate(() => {
      const gl = (document.getElementById('game') as HTMLCanvasElement).getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      (window as unknown as { __ext: WEBGL_lose_context }).__ext = ext;
      ext.loseContext();
      return true;
    });
    test.skip(!lost, 'WEBGL_lose_context unavailable');
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await page.evaluate(() => (window as unknown as { __ext: WEBGL_lose_context }).__ext.restoreContext());
    await page.waitForTimeout(500);
    await page.getByTestId('pause-resume').tap();
    await waitTicks(page, 10);
    expect(await current(page)).toBe('match');
    expect(pageErrors).toEqual([]);
  });

  test('phase flow: half-time Continue sends SKIP; full-time Rematch gets a new seed; Change teams then Back', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    // Record commands the provider delivers to human 0.
    await page.evaluate(() => {
      const p = window.__dotkick!.app.session.runtime()!.provider as unknown as { take: (...a: unknown[]) => void };
      const orig = p.take.bind(p);
      (window as unknown as { __cmds: number[] }).__cmds = [];
      p.take = (t: unknown, f: unknown, s: unknown) => {
        orig(t, f, s);
        const fr = (f as { cmd: number; buttons: number }[])[0]!;
        if (fr.cmd !== 0) (window as unknown as { __cmds: number[] }).__cmds.push(fr.cmd, fr.buttons);
      };
    });
    await setPhase(page, PHASE.HALF_TIME);
    await expect(page.getByTestId('ht-continue')).toBeVisible();
    await page.getByTestId('ht-continue').tap();
    await page.waitForFunction(() => (window as unknown as { __cmds: number[] }).__cmds.length > 0);
    const cmds = await page.evaluate(() => (window as unknown as { __cmds: number[] }).__cmds);
    expect(cmds[0]).toBe(COMMAND_SKIP);
    expect(cmds[1]! & (1 << 9)).toBe(1 << 9);
    await setPhase(page, PHASE.IN_PLAY);
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'match');
    await setPhase(page, PHASE.FULL_TIME);
    await expect(page.getByTestId('ft-continue')).toBeVisible();
    await setPhase(page, PHASE.POST_MATCH);
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    await expect(page.getByTestId('ft-stats')).toBeVisible();
    const seed1 = await page.evaluate(() => window.__dotkick!.ctx.session.getSetup()!.config.seed);
    await page.getByTestId('ft-rematch').tap();
    await waitMatch(page);
    const after = await page.evaluate(() => ({
      seed: window.__dotkick!.ctx.session.getSetup()!.config.seed,
      finished: window.__dotkick!.app.session.finished,
      stack: (window.__dotkick!.app.router.stack as readonly string[]).slice(),
      overlays: document.getElementById('touch')!.children.length,
    }));
    expect(after.seed).not.toBe(seed1);
    expect(after.finished).toBe(false);
    expect(after.stack).toEqual(['main', 'match']);
    expect(after.overlays).toBe(1);
    await setPhase(page, PHASE.POST_MATCH);
    await expect(page.getByTestId('ft-change-teams')).toBeVisible();
    await page.getByTestId('ft-change-teams').tap();
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'team-select');
    await page.getByTestId('back').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    expect(await page.evaluate(() => (window.__dotkick!.app.router.stack as readonly string[]).slice())).toEqual(['main']);
    expect(messages).toEqual([]);
  });

  test('every visible control on core screens is at least 60 px in both dimensions', async ({ page }) => {
    const small: string[] = [];
    const check = async (where: string): Promise<void> => {
      const bad = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('#ui button, #ui [data-focus]')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
          if (r.width < 60 || r.height < 60) out.push(`${el.dataset.testid ?? el.textContent}: ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
        return out;
      });
      for (const b of bad) small.push(`${where} ${b}`);
    };
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await check('splash');
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    await check('main');
    for (const id of ['main-settings', 'main-diagnostics', 'main-mode-kickoff']) { // INT-B: UIX-02 mode entries
      await page.getByTestId(id).tap();
      await expect(page.getByTestId('back')).toBeVisible();
      await check(id);
      await page.getByTestId('back').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
    }
    await kickOff(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await check('pause');
    expect(small).toEqual([]);
  });

  test('Escape on the loading screen cancels cleanly; the pending load never opens a match', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    // Kick-Off and Escape in the same task, so the press lands while the loading screen is up.
    const during = await page.evaluate(() => {
      (document.querySelector('[data-testid="main-kickoff"]') as HTMLButtonElement).click();
      const at = window.__dotkick!.ctx.router.current;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      return at;
    });
    expect(during).toBe('loading');
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({
      cur: window.__dotkick!.ctx.router.current,
      active: window.__dotkick!.ctx.session.active,
      layer: document.body.classList.contains('match-active'),
      touch: document.getElementById('touch')!.children.length,
    }));
    expect(s).toEqual({ cur: 'main', active: false, layer: false, touch: 0 });
    await kickOff(page);
    expect(messages).toEqual([]);
  });
});
