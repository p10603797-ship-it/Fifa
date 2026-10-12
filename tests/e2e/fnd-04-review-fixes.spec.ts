/**
 * FND-04 fixes for the independent review: end-to-end checks beyond tests/e2e/review-fnd-04-adversarial.spec.ts.
 *  - Recovery: Escape (Back) and keyboard Enter resume to the right screen; a throwing setup.onFinish ends on the
 *    final full-time screen; a finished match stranded on 'match' leaves it with Escape.
 *  - Pause menu: the refused-resume note for a system pause never names "Player 0" and expires.
 * Requires `npx vite build` first (playwright.config.ts serves dist/ with vite preview).
 * Phases are driven by writing state.match.phase (the Wave 0 sim does not change phases yet).
 */
import { expect, test, type Page } from '@playwright/test';

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];
const PHASE = { IN_PLAY: 2, HALF_TIME: 11, POST_MATCH: 15 } as const;

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  return out;
}

async function bootToMain(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await expect(page.getByTestId('main-kickoff')).toBeVisible();
}

async function waitRunning(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded;
  }, null, { timeout: 30_000 });
  await page.waitForFunction(() => (window.__dotkick!.ctx.session.getState()?.tick ?? 0) > 5, null, { timeout: 10_000 });
}

async function kickOff(page: Page): Promise<void> {
  await page.getByTestId('main-kickoff').tap();
  await waitRunning(page);
}

async function setPhase(page: Page, phase: number): Promise<void> {
  await page.evaluate((p) => {
    window.__dotkick!.app.session.runtime()!.curr.match.phase = p;
  }, phase);
}

async function injectUncaughtError(page: Page): Promise<void> {
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('fnd-04 injected error');
    }, 0);
  });
  await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'recovery');
  await expect(page.getByTestId('recovery-title')).toBeVisible();
}

const routerState = (page: Page) => page.evaluate(() => ({
  cur: window.__dotkick!.ctx.router.current,
  stack: (window.__dotkick!.app.router.stack as readonly string[]).slice(),
  paused: window.__dotkick!.ctx.session.paused,
  finished: window.__dotkick!.app.session.finished,
}));

test.describe('FND-04 review fixes', () => {
  test('Escape on recovery after the final whistle returns to the final full-time screen', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await setPhase(page, PHASE.POST_MATCH);
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    await injectUncaughtError(page);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    expect(await routerState(page)).toEqual({ cur: 'full-time', stack: ['main', 'match', 'full-time'], paused: false, finished: true });
    // The final screen still works: Quit goes to the main menu.
    await page.getByTestId('ft-quit').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
  });

  test('a throwing setup.onFinish shows recovery; Resume lands on the final full-time screen', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    // Restart the match with a setup whose onFinish throws.
    await page.evaluate(() => {
      const s = window.__dotkick!.ctx.session;
      s.start({ ...s.getSetup()!, onFinish: () => { throw new Error('onFinish bug'); } });
    });
    await waitRunning(page);
    await setPhase(page, PHASE.POST_MATCH);
    await page.waitForFunction(() => window.__dotkick!.ctx.router.current === 'recovery');
    await page.getByTestId('recovery-resume').tap();
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    expect((await routerState(page)).cur).toBe('full-time');
    // Rematch from there starts a clean match.
    await page.getByTestId('ft-rematch').tap();
    await waitRunning(page);
    expect((await routerState(page)).finished).toBe(false);
  });

  test('keyboard alone: Enter on recovery during half-time resumes onto the half-time screen', async ({ page }) => {
    const messages = collectConsole(page);
    await bootToMain(page);
    await kickOff(page);
    await setPhase(page, PHASE.HALF_TIME);
    await expect(page.getByTestId('ht-continue')).toBeVisible();
    await injectUncaughtError(page);
    await expect(page.getByTestId('recovery-resume')).toHaveAttribute('data-focused', '');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('ht-continue')).toBeVisible();
    expect(await routerState(page)).toEqual({ cur: 'half-time', stack: ['main', 'match', 'half-time'], paused: false, finished: false });
    expect(messages).toEqual([]);
  });

  test('a finished match stranded on the match screen leaves it with Escape', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await setPhase(page, PHASE.POST_MATCH);
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
    await page.evaluate(() => window.__dotkick!.ctx.router.go('match'));
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ft-rematch')).toBeVisible();
  });

  test('a refused resume while the window is too small explains why, then returns to "Game paused"', async ({ page }) => {
    await bootToMain(page);
    await kickOff(page);
    await page.setViewportSize({ width: 500, height: 300 });
    await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
    await page.evaluate(() => (document.querySelector('[data-testid="pause-resume"]') as HTMLButtonElement).click());
    const note = await page.locator('.pause-who').textContent();
    expect(note ?? '').not.toMatch(/Player/);
    expect(note ?? '').toMatch(/landscape|window/);
    await page.setViewportSize({ width: 1180, height: 820 });
    await expect(page.getByTestId('pause-menu')).toBeVisible();
    await expect(page.locator('.pause-who')).toHaveText('Game paused', { timeout: 5000 });
    await page.getByTestId('pause-resume').tap();
    await page.waitForFunction(() => !window.__dotkick!.ctx.session.paused);
  });
});
