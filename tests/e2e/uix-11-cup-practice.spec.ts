/**
 * UIX-11 e2e: cup and practice screens through the real app.
 *  - Cup by touch: new cup (8 teams, a club) -> draw -> bracket; the human tie is quick-simmed through the debug hook
 *    and the bracket updates; the cup persists across a reload (Continue); Play match starts the tie (mode CUP, the
 *    tie's clubs), a quit comes back with the tie still to play, and a tie that reaches POST_MATCH is recorded and
 *    the cup screen returns with the result. Layout at 1180x820, 1024x768 (4:3) and 1260x540 (21:9): every control
 *    >= 60 pt, inside the viewport, no overlaps; screenshots in tmp/uix-11/.
 *  - Keyboard alone: Cup (draw by Enter, Play focused, Escape back) and Practice (L1/R1 = Q/E entries, Enter starts).
 *  - Practice entries start the right sessions (free play, free kicks at a spot, corners, penalties); Tutorial opens
 *    the tutorial screen.
 *
 *   npx vite build --outDir dist-e2e/uix-11 --emptyOutDir
 *   PW_DIST=dist-e2e/uix-11 PW_PORT=4211 npx playwright test tests/e2e/uix-11-cup-practice.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SHOTS = process.env.UIX11_SHOTS || join(process.cwd(), 'tmp', 'uix-11');
mkdirSync(SHOTS, { recursive: true });

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

interface CupView {
  size: number;
  round: number;
  finished: boolean;
  humanClubs: number[];
  rounds: { home: number; away: number; homeGoals: number; awayGoals: number; winner: number }[][];
}

/** The bits of window.__dotkick / __dotkickCup this spec reads (loosely typed on purpose). */
type Win = {
  __dotkick?: { ctx: { router: { current: string | null }; session: { active: boolean; getSetup(): { config: Record<string, number>; modeData?: unknown } | null; getState(): unknown; quit(): void } } };
  __dotkickCup?: { state(): CupView | null; simulate(): boolean };
};

const route = (page: Page): Promise<string | null> => page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.router.current);
const focused = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);
const cupState = (page: Page): Promise<CupView | null> => page.evaluate(() => (window as unknown as Win).__dotkickCup?.state() ?? null);
const setupConfig = (page: Page): Promise<Record<string, number> | null> =>
  page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.session.getSetup()?.config ?? null);

async function boot(page: Page, clear = true): Promise<void> {
  await page.goto('/');
  if (clear) {
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  }
  await expect(page.getByTestId('splash-start')).toBeVisible();
  await page.touchscreen.tap(40, 300);
  await expect.poll(() => route(page)).toBe('main');
}

/** Every visible focusable control: >= 60 px tall, inside the viewport, not overlapping another. */
async function checkLayout(page: Page, label: string): Promise<void> {
  const r = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('#ui .screen [data-focus], #ui .screen button'))
      .filter((e) => e.offsetParent !== null && !e.hasAttribute('data-focus-skip'));
    const rects = els.map((e) => ({ id: e.dataset.testid ?? e.textContent?.trim().slice(0, 20) ?? '?', r: e.getBoundingClientRect() }));
    const small = rects.filter((x) => x.r.height < 59.5).map((x) => `${x.id}:${Math.round(x.r.height)}`);
    const outside = rects.filter((x) => x.r.left < -0.5 || x.r.top < -0.5 || x.r.right > innerWidth + 0.5 || x.r.bottom > innerHeight + 0.5).map((x) => x.id);
    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i]!.r;
        const b = rects[j]!.r;
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ox > 1 && oy > 1) overlaps.push(`${rects[i]!.id} x ${rects[j]!.id}`);
      }
    }
    const scroll = document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1;
    return { count: rects.length, small, outside, overlaps, scroll };
  });
  expect(r.count, `${label}: controls`).toBeGreaterThanOrEqual(2);
  expect(r.small, `${label}: >= 60 pt`).toEqual([]);
  expect(r.outside, `${label}: inside the viewport`).toEqual([]);
  expect(r.overlaps, `${label}: no overlaps`).toEqual([]);
  expect(r.scroll, `${label}: no page scroll`).toBe(false);
}

test.describe('UIX-11 cup and practice', () => {
  test('cup by touch: draw, bracket, simulated tie, persistence, play / quit / result; layouts', async ({ page }) => {
    test.setTimeout(240_000);
    const messages = collectConsole(page);
    await boot(page);
    await page.getByTestId('main-cup').tap();
    await expect.poll(() => route(page)).toBe('cup');
    await expect(page.getByTestId('cup-new')).toBeVisible();
    await page.getByTestId('cup-size-8').tap();
    await page.getByTestId('cup-club-' + (await page.evaluate(() => {
      const w = window as unknown as { __dotkick: { ctx: { clubs: { code: string }[] } } };
      return w.__dotkick.ctx.clubs[4]!.code.toLowerCase();
    }))).tap();
    for (const s of [{ w: 1180, h: 820, n: '1180x820' }, { w: 1024, h: 768, n: '4x3' }, { w: 1260, h: 540, n: '21x9' }]) {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.waitForTimeout(150);
      await checkLayout(page, `new cup ${s.n}`);
      await page.screenshot({ path: join(SHOTS, `cup-new-${s.n}.png`) });
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.getByTestId('cup-draw').tap();
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    let st = (await cupState(page))!;
    expect(st.size).toBe(8);
    expect(st.humanClubs).toEqual([4]);
    expect(st.round).toBe(0);
    await expect(page.getByTestId('cup-play')).toBeVisible();
    await expect(page.getByTestId('cup-next-tie')).toContainText(await page.evaluate(() => {
      const w = window as unknown as { __dotkick: { ctx: { clubs: { name: string }[] } } };
      return w.__dotkick.ctx.clubs[4]!.name;
    }));

    // Play match starts the human tie; a quit comes back to the cup with the tie still to play.
    await page.getByTestId('cup-play').tap();
    await expect.poll(() => setupConfig(page)).not.toBeNull();
    const cfg = (await setupConfig(page))!;
    const tie = st.rounds[0]!.find((t) => t.home === 4 || t.away === 4)!;
    expect(cfg.mode).toBe(3); // ModeId.CUP
    expect(cfg.cupRules).toBe(1);
    expect([cfg.homeClub, cfg.awayClub]).toEqual([tie.home, tie.away]);
    await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.session.quit());
    await expect.poll(() => route(page)).toBe('cup');
    await expect(page.getByTestId('cup-play')).toBeVisible();
    expect((await cupState(page))!.rounds[0]!.find((t) => t.home === 4 || t.away === 4)!.winner).toBe(-1);

    // A tie that reaches POST_MATCH (forced here, a human 3-0 win) is recorded: the session is released and the cup
    // screen returns with the result, the other ties of the round filled in.
    await page.getByTestId('cup-play').tap();
    await expect.poll(() => route(page), { timeout: 90_000 }).toBe('match');
    const side = await page.evaluate(() => {
      const ctx = (window as unknown as Win).__dotkick!.ctx;
      const c = ctx.session.getSetup()!.config as unknown as { humans: { side: number }[] };
      const s = ctx.session.getState() as { teams: { goals: number }[]; match: { phase: number; winner: number; finished: number } };
      const sideNow = c.humans[0]!.side;
      s.teams[sideNow]!.goals = 3;
      s.match.winner = sideNow;
      s.match.finished = 1;
      s.match.phase = 15; // POST_MATCH
      return sideNow;
    });
    expect(side === 0 || side === 1).toBe(true);
    await expect.poll(() => route(page), { timeout: 30_000 }).toBe('cup');
    await expect(page.getByTestId('cup-result')).toContainText('Through');
    st = (await cupState(page))!;
    expect(st.rounds[0]!.find((t) => t.home === 4 || t.away === 4)!.winner).toBe(4);
    expect(st.rounds[0]!.every((t) => t.winner >= 0)).toBe(true);
    expect(st.round).toBe(1);
    await expect(page.getByTestId('cup-tie-1-0')).not.toContainText('TBD');
    expect(await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.session.active)).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('match-active'))).toBe(false);
    await page.screenshot({ path: join(SHOTS, 'cup-after-match.png') });

    // Simulate the semi-final through the debug hook: the bracket fills in (through to the final, or out).
    expect(await page.evaluate(() => (window as unknown as Win).__dotkickCup!.simulate())).toBe(true);
    st = (await cupState(page))!;
    await expect(page.getByTestId('cup-result')).toBeVisible();
    const humanWon = st.rounds[1]!.find((t) => t.home === 4 || t.away === 4)!.winner === 4;
    if (humanWon) {
      expect(st.round).toBe(2);
      await expect(page.getByTestId('cup-play')).toBeVisible();
    } else {
      expect(st.finished).toBe(true);
      await expect(page.getByTestId('cup-champion')).toBeVisible();
    }
    for (const s of [{ w: 1180, h: 820, n: '1180x820' }, { w: 1024, h: 768, n: '4x3' }, { w: 1260, h: 540, n: '21x9' }]) {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.waitForTimeout(150);
      await checkLayout(page, `bracket ${s.n}`);
      await page.screenshot({ path: join(SHOTS, `cup-bracket-${s.n}.png`) });
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // Progress saves: reload and continue.
    const before = JSON.stringify(st);
    await boot(page, false);
    await page.getByTestId('main-cup').tap();
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    expect(JSON.stringify(await cupState(page))).toBe(before);
    // New cup over a saved one asks first; a 16-team bracket fits at every aspect ratio.
    await page.getByTestId('cup-new').tap();
    if (!st.finished) {
      await expect(page.getByTestId('cup-new-confirm')).toBeVisible();
      await page.getByTestId('cup-new-ok').tap();
    }
    await expect(page.getByTestId('cup-new')).toBeVisible();
    await page.getByTestId('cup-size-16').tap();
    await page.getByTestId('cup-draw').tap();
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    expect((await cupState(page))!.size).toBe(16);
    for (const s of [{ w: 1180, h: 820, n: '1180x820' }, { w: 1024, h: 768, n: '4x3' }, { w: 1260, h: 540, n: '21x9' }]) {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.waitForTimeout(150);
      await checkLayout(page, `bracket16 ${s.n}`);
      await page.screenshot({ path: join(SHOTS, `cup-bracket16-${s.n}.png`) });
    }
    await page.setViewportSize({ width: 1180, height: 820 });

    // Back goes to the main menu.
    await page.getByTestId('back').tap();
    await expect.poll(() => route(page)).toBe('main');
    expect(messages).toEqual([]);
  });

  test('keyboard alone: cup draw and practice start', async ({ page }) => {
    const messages = collectConsole(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect.poll(() => route(page)).toBe('main');
    await page.evaluate(() => (window as unknown as { __dotkick: { ctx: { router: { go(id: string): void } } } }).__dotkick.ctx.router.go('cup'));
    await expect.poll(() => route(page)).toBe('cup');
    await expect.poll(() => focused(page)).toBe('cup-draw');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => focused(page)).not.toBe('cup-draw');
    // Walk back to the draw button and confirm.
    for (let i = 0; i < 6 && (await focused(page)) !== 'cup-draw'; i++) await page.keyboard.press('ArrowUp');
    await expect.poll(() => focused(page)).toBe('cup-draw');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('cup-bracket')).toBeVisible();
    await expect.poll(() => focused(page)).toBe('cup-play');
    await page.screenshot({ path: join(SHOTS, 'cup-keyboard.png') });
    await page.keyboard.press('Escape');
    await expect.poll(() => route(page)).toBe('main');

    await page.evaluate(() => (window as unknown as { __dotkick: { ctx: { router: { go(id: string): void } } } }).__dotkick.ctx.router.go('practice'));
    await expect.poll(() => route(page)).toBe('practice');
    await expect.poll(() => focused(page)).toBe('practice-start');
    await page.keyboard.press('KeyE'); // R1: next entry
    await page.keyboard.press('KeyE');
    await expect(page.getByTestId('practice-panel-title')).toHaveText('Corners');
    await expect.poll(() => focused(page)).toBe('practice-start');
    await page.screenshot({ path: join(SHOTS, 'practice-keyboard.png') });
    await page.keyboard.press('Enter');
    await expect.poll(() => setupConfig(page)).not.toBeNull();
    const cfg = (await setupConfig(page))!;
    expect([cfg.mode, cfg.practice]).toEqual([5, 3]); // PRACTICE, CORNERS
    await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.session.quit());
    await expect.poll(() => route(page)).toBe('practice');
    await expect(page.getByTestId('practice-panel-title')).toHaveText('Corners');
    expect(messages).toEqual([]);
  });

  test('practice entries start the right sessions by touch; Tutorial opens the tutorial', async ({ page }) => {
    const messages = collectConsole(page);
    await boot(page);
    await page.getByTestId('main-practice').tap();
    await expect.poll(() => route(page)).toBe('practice');
    for (const s of [{ w: 1180, h: 820, n: '1180x820' }, { w: 1024, h: 768, n: '4x3' }, { w: 1260, h: 540, n: '21x9' }]) {
      await page.setViewportSize({ width: s.w, height: s.h });
      await page.getByTestId('practice-free-kicks').tap();
      await page.waitForTimeout(100);
      await checkLayout(page, `practice ${s.n}`);
      await page.screenshot({ path: join(SHOTS, `practice-${s.n}.png`) });
    }
    await page.setViewportSize({ width: 1180, height: 820 });
    const cases: [string, number, string | null, number][] = [
      ['practice-free-play', 1, null, 0],
      ['practice-free-kicks', 2, 'inc', 1],
      ['practice-corners', 3, 'practice-spot-corner-right', 1],
      ['practice-penalties', 4, null, 0],
    ];
    for (const [id, kind, spotSel, spot] of cases) {
      await page.getByTestId(id).tap();
      if (spotSel === 'inc') await page.locator('[data-testid="practice-spot"] [data-adjust="inc"]').tap();
      else if (spotSel) await page.getByTestId(spotSel).tap();
      await page.getByTestId('practice-start').tap();
      await expect.poll(() => setupConfig(page)).not.toBeNull();
      const cfg = (await setupConfig(page))!;
      expect([cfg.mode, cfg.practice, cfg.startPhase], id).toEqual([5, kind, 2]);
      if (kind === 2 || kind === 3) expect(cfg.practiceSpot, id).toBe(spot);
      await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.session.quit());
      await expect.poll(() => route(page)).toBe('practice');
    }
    await page.getByTestId('practice-tutorial').tap();
    await page.getByTestId('practice-start').tap();
    await expect.poll(() => route(page)).toBe('tutorial');
    expect(await page.evaluate(() => (window as unknown as Win).__dotkick!.ctx.session.active)).toBe(false);
    expect(messages).toEqual([]);
  });
});
