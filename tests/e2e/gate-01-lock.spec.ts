/**
 * [GATE] Password lock end to end (D-047), on contexts with NOTHING seeded (every other spec starts unlocked through
 * playwright.config.ts storageState). Test codes only (tests/e2e/gate-harness.ts), accepted through the test hook.
 *
 * - A fresh device shows the lock, and nothing of the game runs (no app, no splash), whatever the address: the plain
 *   page, a share link (?room= / #room=), the benchmark (?bench=1), any other hash.
 * - A wrong code is refused; a test code (typed in lower case with spaces, Enter submits) unlocks onto the splash and
 *   the share link survives; a reload goes straight in (the lock never mounts); after clearing only the unlock record
 *   the same code says "already used" and another code unlocks; the menus are reachable afterwards.
 * - Storage that cannot remember (private browsing): the code opens the game for this visit with a plain notice and
 *   Continue; a reload shows the lock again.
 * - On-screen keyboard: with the visual viewport shrunk (and moved) as the iPad keyboard does, in landscape and
 *   portrait, the field and the Unlock button stay inside the visible part; the portrait card does not cover the lock.
 * - Two tabs: when one tab unlocks, a tab still on the lock goes in by itself (storage event); without that event, its
 *   next submit goes in without spending another code, and the code the first tab just used is not called "used".
 * - Offline: once unlocked and the service worker is installed, a reload with the server gone goes straight in.
 * - No crypto.subtle (plain http on a LAN address): the plain-TypeScript SHA-256 unlocks the same code.
 * - Zero console errors or warnings throughout.
 *
 * Build first: npx vite build --outDir dist-e2e/gate --emptyOutDir
 * Run: PW_DIST=dist-e2e/gate PW_PORT=4361 npx playwright test tests/e2e/gate-01-lock.spec.ts --trace off
 */
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { GATE_TEXT, GATE_UNLOCK_KEY, GATE_USED_KEY } from '../../src/app/gate';
import { TEST_CODES, acceptTestCodes, testCodeHash } from './gate-harness';
import { startStaticServer } from './plt-04-server';

const DIST = resolve(process.env.PW_DIST ?? 'dist');

test.use({ storageState: { cookies: [], origins: [] } });

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

/** Records (in sessionStorage-free window state) whether the lock was ever mounted on this page load. */
async function watchLockMounts(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __gateMounts: number };
    w.__gateMounts = 0;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof HTMLElement && n.dataset.testid === 'gate') w.__gateMounts++;
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
}

const gateMounts = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __gateMounts: number }).__gateMounts);
const appBooted = (page: Page): Promise<boolean> => page.evaluate(() => window.__dotkick !== undefined);

async function expectLocked(page: Page): Promise<void> {
  await expect(page.getByTestId('gate')).toBeVisible();
  await expect(page.getByTestId('gate-prompt')).toHaveText(GATE_TEXT.prompt);
  // Give a would-be boot every chance to run: nothing of the game appears.
  await page.waitForTimeout(400);
  expect(await appBooted(page)).toBe(false);
  await expect(page.getByTestId('splash-start')).toHaveCount(0);
  await expect(page.getByTestId('main-kickoff')).toHaveCount(0);
}

async function submit(page: Page, code: string, via: 'tap' | 'enter' = 'tap'): Promise<void> {
  const input = page.getByTestId('gate-input');
  await input.fill(code);
  if (via === 'enter') await input.press('Enter');
  else await page.getByTestId('gate-submit').tap();
}

test.describe('GATE-01 password lock', () => {
  test('a fresh device: the lock blocks every address (plain, share links, benchmark, hashes); the field is set up for the iPad', async ({ page }) => {
    const messages = collectConsole(page);
    for (const path of ['/', '/?room=K7QWMZ', '/#room=K7QWMZ', '/?bench=1&benchSeconds=5', '/#main', '/#/online-lobby?room=K7QWMZ', '/index.html#splash']) {
      await page.goto(path);
      await expectLocked(page);
    }
    const input = page.getByTestId('gate-input');
    for (const [attr, value] of [
      ['autocapitalize', 'characters'], ['autocomplete', 'off'], ['autocorrect', 'off'], ['spellcheck', 'false'],
      ['enterkeyhint', 'go'], ['type', 'text'], ['placeholder', 'XXXX-XXXX-XXXX'],
    ] as const) await expect(input, attr).toHaveAttribute(attr, value);
    await expect(input).toBeFocused();
    const button = await page.getByTestId('gate-submit').boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.width).toBeGreaterThanOrEqual(44);
    const field = await input.boundingBox();
    expect(field!.height).toBeGreaterThanOrEqual(44);
    // An empty submit asks for the password; it never reaches the game.
    await page.getByTestId('gate-submit').tap();
    await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.empty);
    expect(await appBooted(page)).toBe(false);
    // A browser that shrinks the whole window for its keyboard: the field and the button still fit.
    await page.setViewportSize({ width: 1180, height: 360 });
    for (const id of ['gate-input', 'gate-submit']) {
      await expect.poll(async () => {
        const box = (await page.getByTestId(id).boundingBox())!;
        return box.y >= 0 && box.y + box.height <= 360.5;
      }, { message: id }).toBe(true);
    }
    expect(messages).toEqual([]);
  });

  test('wrong code refused; a code unlocks onto the splash; reload goes straight in; a used code is refused; another works', async ({ page }) => {
    const messages = collectConsole(page);
    await acceptTestCodes(page);
    await watchLockMounts(page);
    await page.goto('/?room=K7QWMZ');
    await expectLocked(page);

    await submit(page, 'WRNG-WRNG-WRNG');
    await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.wrong);
    await expect(page.getByTestId('gate-input')).toHaveAttribute('aria-invalid', 'true');
    expect(await appBooted(page)).toBe(false);
    // A real-looking code that is not in the list is wrong too.
    await submit(page, 'ABCD-EFGH-JKMN', 'enter');
    await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.wrong);
    expect(await appBooted(page)).toBe(false);

    // Lower case with spaces, submitted with Enter (the iPad keyboard's Go).
    await submit(page, TEST_CODES[0].toLowerCase().replace(/-/g, ' '), 'enter');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await expect(page.getByTestId('gate')).toHaveCount(0);
    expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe('splash');
    expect(page.url()).toContain('room=K7QWMZ'); // the share link is still there for the splash to follow
    const stored = await page.evaluate(([u, k]) => ({ unlock: localStorage.getItem(u!), used: localStorage.getItem(k!) }), [GATE_UNLOCK_KEY, GATE_USED_KEY]);
    expect(JSON.parse(stored.unlock!)).toMatchObject({ v: 1 });
    expect(JSON.parse(stored.used!).used).toEqual([testCodeHash(TEST_CODES[0])]);
    expect(await page.evaluate(() => document.body.classList.contains('dk-gated'))).toBe(false);

    // Reload: straight in, the lock is never mounted.
    await page.goto('/');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    expect(await gateMounts(page)).toBe(0);
    await page.reload();
    await expect(page.getByTestId('splash-start')).toBeVisible();
    expect(await gateMounts(page)).toBe(0);
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();

    // Clear only the unlock record: locked again, and the same code is refused as used.
    await page.evaluate((k) => localStorage.removeItem(k), GATE_UNLOCK_KEY);
    await page.reload();
    await expectLocked(page);
    await submit(page, TEST_CODES[0]);
    await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.used);
    expect(await appBooted(page)).toBe(false);
    // Typing again clears the error; another code unlocks.
    await page.getByTestId('gate-input').fill('T');
    await expect(page.getByTestId('gate-message')).toHaveText('');
    await submit(page, TEST_CODES[1]);
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await page.getByTestId('splash-start').tap();
    await expect(page.getByTestId('main-kickoff')).toBeVisible();
    const used = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!).used as string[], GATE_USED_KEY);
    expect(used.sort()).toEqual([testCodeHash(TEST_CODES[0]), testCodeHash(TEST_CODES[1])].sort());
    expect(messages).toEqual([]);
  });

  test('private browsing (storage cannot be written): opens for this visit with a plain notice; a reload asks again', async ({ page }) => {
    const messages = collectConsole(page);
    await acceptTestCodes(page);
    await page.addInitScript(() => {
      Storage.prototype.setItem = function setItem(): void {
        throw new DOMException('quota', 'QuotaExceededError');
      };
    });
    await page.goto('/');
    await expectLocked(page);
    await submit(page, TEST_CODES[2]);
    await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.notRemembered);
    expect(await appBooted(page)).toBe(false);
    await page.getByTestId('gate-continue').tap();
    await expect(page.getByTestId('splash-start')).toBeVisible();
    await expect(page.getByTestId('gate')).toHaveCount(0);
    await page.reload();
    await expectLocked(page);
    expect(messages).toEqual([]);
  });

  test('on-screen keyboard: the field and Unlock stay visible in landscape and portrait; the portrait card does not cover the lock', async ({ page }) => {
    const messages = collectConsole(page);
    // A stand-in visualViewport the test drives like the iPad keyboard does (layout viewport unchanged).
    await page.addInitScript(() => {
      const vv = new EventTarget() as EventTarget & { height: number; width: number; offsetTop: number; offsetLeft: number; scale: number };
      vv.height = window.innerHeight;
      vv.width = window.innerWidth;
      vv.offsetTop = 0;
      vv.offsetLeft = 0;
      vv.scale = 1;
      Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => vv });
      (window as unknown as { __kb: (h: number, top: number) => void }).__kb = (h, top) => {
        vv.height = h;
        vv.width = window.innerWidth;
        vv.offsetTop = top;
        vv.dispatchEvent(new Event('resize'));
        vv.dispatchEvent(new Event('scroll'));
      };
    });
    const visibleInside = async (top: number, height: number): Promise<void> => {
      for (const id of ['gate-input', 'gate-submit']) {
        const box = (await page.getByTestId(id).boundingBox())!;
        expect(box.y, `${id} top`).toBeGreaterThanOrEqual(top - 0.5);
        expect(box.y + box.height, `${id} bottom`).toBeLessThanOrEqual(top + height + 0.5);
      }
    };
    for (const size of [{ width: 1180, height: 820, kb: 400 }, { width: 820, height: 1180, kb: 420 }, { width: 1024, height: 768, kb: 398 }]) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto('/');
      await expect(page.getByTestId('gate')).toBeVisible();
      await expect(page.locator('#rotate')).toBeHidden(); // portrait: the lock works there too
      await page.getByTestId('gate-input').tap();
      await visibleInside(0, size.height);
      // Keyboard up: the visible part is the top `height - kb` pixels; Safari may also pan it a little.
      const visible = size.height - size.kb;
      await page.evaluate(([h, t]) => (window as unknown as { __kb: (h: number, top: number) => void }).__kb(h!, t!), [visible, 0]);
      await visibleInside(0, visible);
      await page.evaluate(([h, t]) => (window as unknown as { __kb: (h: number, top: number) => void }).__kb(h!, t!), [visible, 120]);
      await visibleInside(120, visible);
      // Typing still works with the keyboard up, and Go submits.
      await page.getByTestId('gate-input').fill('NOPE NOPE NOPE');
      await page.getByTestId('gate-input').press('Enter');
      await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.wrong);
      await visibleInside(120, visible);
      await page.evaluate(([h, t]) => (window as unknown as { __kb: (h: number, top: number) => void }).__kb(h!, t!), [size.height, 0]);
      await visibleInside(0, size.height);
    }
    expect(messages).toEqual([]);
  });

  test('two tabs: an unlock in one tab opens the other without spending a second code', async ({ context }) => {
    await acceptTestCodes(context);
    const a = await context.newPage();
    const b = await context.newPage();
    const msgA = collectConsole(a);
    const msgB = collectConsole(b);
    await a.goto('/');
    await b.goto('/');
    await expectLocked(a);
    await expectLocked(b);
    await submit(a, TEST_CODES[0]);
    await expect(a.getByTestId('splash-start')).toBeVisible();
    // B gets the storage event and goes in by itself.
    await expect(b.getByTestId('splash-start')).toBeVisible();
    await expect(b.getByTestId('gate')).toHaveCount(0);
    expect(await appBooted(b)).toBe(true);
    const usedList = (p: Page): Promise<string[]> =>
      p.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{"used":[]}').used as string[], GATE_USED_KEY);
    expect(await usedList(a)).toEqual([testCodeHash(TEST_CODES[0])]);

    // Same again with the storage event swallowed in the second tab (an engine that does not deliver it):
    // a submit there checks the record first.
    await a.evaluate(([u, k]) => { localStorage.removeItem(u!); localStorage.removeItem(k!); }, [GATE_UNLOCK_KEY, GATE_USED_KEY]);
    const c = await context.newPage();
    const msgC = collectConsole(c);
    await c.addInitScript(() => {
      window.addEventListener('storage', (e) => e.stopImmediatePropagation(), true);
    });
    await a.reload();
    await c.goto('/');
    await expectLocked(a);
    await expectLocked(c);
    await submit(a, TEST_CODES[1]);
    await expect(a.getByTestId('splash-start')).toBeVisible();
    await c.waitForTimeout(300);
    await expect(c.getByTestId('gate')).toBeVisible(); // no event reached it
    // An unused code typed there is NOT spent; the device is unlocked, so it goes in.
    await submit(c, TEST_CODES[2]);
    await expect(c.getByTestId('splash-start')).toBeVisible();
    expect(await usedList(c)).toEqual([testCodeHash(TEST_CODES[1])]);

    // Both tabs submit the same code; tab D (storage event swallowed, hashing slowed down) checks it after tab A
    // has redeemed it and unlocked: D goes in instead of saying "already used".
    await a.evaluate(([u, k]) => { localStorage.removeItem(u!); localStorage.removeItem(k!); }, [GATE_UNLOCK_KEY, GATE_USED_KEY]);
    const d = await context.newPage();
    const msgD = collectConsole(d);
    await d.addInitScript(() => {
      window.addEventListener('storage', (e) => e.stopImmediatePropagation(), true);
      const digest = SubtleCrypto.prototype.digest;
      SubtleCrypto.prototype.digest = function slowDigest(this: SubtleCrypto, ...args: Parameters<SubtleCrypto['digest']>) {
        return new Promise<ArrayBuffer>((res, rej) => setTimeout(() => digest.apply(this, args).then(res, rej), 800));
      };
    });
    await a.reload();
    await d.goto('/');
    await expectLocked(a);
    await expectLocked(d);
    await submit(d, TEST_CODES[3]);
    await submit(a, TEST_CODES[3]);
    await expect(a.getByTestId('splash-start')).toBeVisible();
    await expect(d.getByTestId('splash-start')).toBeVisible();
    await expect(d.getByTestId('gate')).toHaveCount(0);
    expect(await usedList(d)).toEqual([testCodeHash(TEST_CODES[3])]);
    expect([...msgA, ...msgB, ...msgC, ...msgD]).toEqual([]);
  });

  test('offline after the unlock (service worker, server gone): a reload goes straight in', async ({ page }) => {
    const messages = collectConsole(page);
    await acceptTestCodes(page);
    await watchLockMounts(page);
    const server = await startStaticServer(DIST);
    let stopped = false;
    try {
      await page.goto(server.url);
      await expectLocked(page);
      await submit(page, TEST_CODES[3]);
      await expect(page.getByTestId('splash-start')).toBeVisible();
      await expect.poll(() => page.evaluate(async () => {
        const reg = await navigator.serviceWorker.getRegistration();
        return !!reg && !!reg.active && reg.active.state === 'activated' && !!navigator.serviceWorker.controller;
      }), { timeout: 30_000 }).toBe(true);
      expect(messages).toEqual([]);
      await server.stop();
      stopped = true;
      expect(await page.evaluate(() => fetch(`./sw.js?probe=${Date.now()}`).then(() => 'ok', () => 'failed'))).toBe('failed');
      await page.reload();
      await expect(page.getByTestId('splash-start')).toBeVisible();
      expect(await gateMounts(page)).toBe(0);
      await page.getByTestId('splash-start').tap();
      await expect(page.getByTestId('main-kickoff')).toBeVisible();
    } finally {
      if (!stopped) await server.stop();
    }
    // Offline, only the probe above and the browser's own sw.js update check fail to connect (expected).
    expect(messages.filter((m) => !/Failed to load resource: net::ERR_CONNECTION_REFUSED/.test(m))).toEqual([]);
  });

  test('no crypto.subtle (plain http on a LAN address): the built-in SHA-256 unlocks the same code', async ({ page }) => {
    const messages = collectConsole(page);
    await acceptTestCodes(page);
    await page.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'subtle', { configurable: true, get: () => undefined });
    });
    await page.goto('/');
    await expectLocked(page);
    expect(await page.evaluate(() => typeof crypto.subtle)).toBe('undefined');
    await submit(page, 'WRNG-WRNG-WRNG');
    await expect(page.getByTestId('gate-message')).toHaveText(GATE_TEXT.wrong);
    await submit(page, ` ${TEST_CODES[1].toLowerCase()} `, 'enter');
    await expect(page.getByTestId('splash-start')).toBeVisible();
    expect(messages).toEqual([]);
  });
});
