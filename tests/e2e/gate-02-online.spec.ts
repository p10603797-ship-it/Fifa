/**
 * [GATE] The password lock with the online checker (D-048), on contexts with nothing seeded.
 *
 * Mocked checker (page.route on the published checker's address, shared state across devices, so no real password is
 * ever involved): a wrong code is refused; a code unlocks onto the splash; a reload goes straight in WITHOUT asking the
 * checker again; a second device with the same code is told it has been used; a cut connection shows the "connect"
 * message and does not spend the code, and trying again works; an answer lost after the checker used the code still
 * opens the game on retry (same device id). Zero console errors or warnings.
 *
 * Real TEST checker (only when GATE_TEST_URL and GATE_TEST_CODES are set; codes come from outside the repository and
 * are spent by the run): two devices, one code: the first unlocks, the second is told it has been used.
 *
 * Build first: npx vite build --outDir dist-e2e/gate --emptyOutDir
 * Run: PW_DIST=dist-e2e/gate PW_PORT=4362 npx playwright test tests/e2e/gate-02-online.spec.ts --trace off
 */
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { GATE_TEXT } from '../../src/app/gate';
import { GATE_SERVER_URL } from '../../src/data/gateConfig';
import { TEST_CODES, testCodeHash } from './gate-harness';

test.use({ storageState: { cookies: [], origins: [] } });

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    // A cut connection is the scenario under test: the browser reports the failed request itself.
    if (/Failed to load resource|ERR_FAILED|ERR_INTERNET_DISCONNECTED|net::/.test(text)) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

/** A stand-in for the checker shared by every device in a test: hash -> device that used it. */
class MockChecker {
  readonly used = new Map<string, string>();
  requests = 0;
  /** What the next requests do: answer, cut the connection, or use the code and lose the answer. */
  mode: 'answer' | 'cut' | 'lose-answer' = 'answer';
  constructor(readonly accepted: readonly string[]) {}

  async install(context: BrowserContext): Promise<void> {
    await context.route(GATE_SERVER_URL, (route) => this.handle(route));
  }

  private async handle(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    this.requests++;
    if (this.mode === 'cut') return route.abort('internetdisconnected');
    const { code, device } = JSON.parse(req.postData() ?? '{}') as { code: string; device: string };
    const hash = testCodeHash(code);
    let result: string;
    if (!this.accepted.includes(hash)) result = 'wrong';
    else if (!this.used.has(hash)) {
      this.used.set(hash, device);
      result = 'ok';
    } else result = this.used.get(hash) === device ? 'ok' : 'used';
    if (this.mode === 'lose-answer') return route.abort('connectionreset');
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ result }) });
  }
}

async function newDevice(browser: Browser, checker: MockChecker): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  await checker.install(context);
  const page = await context.newPage();
  const errors = collectConsole(page);
  await page.goto('/');
  await expect(page.getByTestId('gate')).toBeVisible();
  return { context, page, errors };
}

async function submit(page: Page, code: string): Promise<void> {
  await page.getByTestId('gate-input').fill(code);
  await page.getByTestId('gate-submit').tap();
}

const message = (page: Page) => page.getByTestId('gate-message');
const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick?.ctx.router.current ?? null);

test('online checker: wrong, ok, reload without asking again, used on a second device', async ({ browser }) => {
  const checker = new MockChecker([testCodeHash(TEST_CODES[0])]);
  const a = await newDevice(browser, checker);
  await submit(a.page, 'WRNG-WRNG-WRNG');
  await expect(message(a.page)).toHaveText(GATE_TEXT.wrong);
  await submit(a.page, TEST_CODES[0].toLowerCase().replace(/-/g, ' '));
  await expect(a.page.getByTestId('gate')).toHaveCount(0);
  await expect.poll(() => route(a.page)).toBe('splash');
  const before = checker.requests;
  await a.page.reload();
  await expect.poll(() => route(a.page)).toBe('splash');
  await expect(a.page.getByTestId('gate')).toHaveCount(0);
  expect(checker.requests).toBe(before); // an unlocked device never contacts the checker

  const b = await newDevice(browser, checker);
  await submit(b.page, TEST_CODES[0]);
  await expect(message(b.page)).toHaveText(GATE_TEXT.used);
  await expect(b.page.getByTestId('gate')).toBeVisible();
  expect(await b.page.evaluate(() => window.__dotkick === undefined)).toBe(true);
  expect([...a.errors, ...b.errors]).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test('online checker: a cut connection says so and spends nothing; a lost answer still opens on retry', async ({ browser }) => {
  const checker = new MockChecker([testCodeHash(TEST_CODES[1]), testCodeHash(TEST_CODES[2])]);
  const a = await newDevice(browser, checker);
  checker.mode = 'cut';
  await submit(a.page, TEST_CODES[1]);
  await expect(message(a.page)).toHaveText(GATE_TEXT.offline);
  expect(checker.used.size).toBe(0);
  checker.mode = 'answer';
  await submit(a.page, TEST_CODES[1]);
  await expect(a.page.getByTestId('gate')).toHaveCount(0);

  const b = await newDevice(browser, checker);
  checker.mode = 'lose-answer'; // the checker uses the code, the answer never arrives
  await submit(b.page, TEST_CODES[2]);
  await expect(message(b.page)).toHaveText(GATE_TEXT.offline);
  expect(checker.used.has(testCodeHash(TEST_CODES[2]))).toBe(true);
  checker.mode = 'answer';
  await submit(b.page, TEST_CODES[2]);
  await expect(b.page.getByTestId('gate')).toHaveCount(0);
  await expect.poll(() => route(b.page)).toBe('splash');
  expect([...a.errors, ...b.errors]).toEqual([]);
  await a.context.close();
  await b.context.close();
});

test('real TEST checker: one code, two devices', async ({ browser }) => {
  const url = process.env.GATE_TEST_URL;
  const code = (process.env.GATE_TEST_CODES ?? '').split(',').filter(Boolean)[0];
  test.skip(!url || !code, 'set GATE_TEST_URL and GATE_TEST_CODES to run against the test checker');
  const devices: { context: BrowserContext; page: Page; errors: string[] }[] = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    await context.addInitScript((u: string) => {
      (window as unknown as { __dotkickGateTest?: { serverUrl: string } }).__dotkickGateTest = { serverUrl: u };
    }, url!);
    const page = await context.newPage();
    const errors = collectConsole(page);
    await page.goto('/');
    devices.push({ context, page, errors });
  }
  await submit(devices[0]!.page, code!);
  await expect(devices[0]!.page.getByTestId('gate')).toHaveCount(0, { timeout: 15_000 });
  await submit(devices[1]!.page, code!);
  await expect(message(devices[1]!.page)).toHaveText(GATE_TEXT.used, { timeout: 15_000 });
  expect(devices.flatMap((d) => d.errors)).toEqual([]);
  for (const d of devices) await d.context.close();
});
