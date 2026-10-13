/**
 * PAD-01 e2e: the real page's shared pad manager + device registry with mocked pads (navigator.getGamepads
 * overridden before any page script). Connect-on-press, Controller 1 / 2 labels in press order, a sub-frame first
 * tap caught through gamepadconnected, a bound pad disconnect / reconnect at a new index reported once each with the
 * same device id. L3 / R3 are used to press, so menus do not react.
 */
import { expect, test, type Page } from '@playwright/test';

const MOCK_PADS = `
  const mk = (index, id) => ({
    id, index, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], vibrationActuator: null,
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  });
  window.__mk = mk;
  window.__pads = [
    mk(0, 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
    mk(1, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
    null, null,
  ];
  window.__set = (i, b, v) => { const p = window.__pads[i]; p.buttons[b].value = v; p.buttons[b].pressed = v > 0.5; };
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => window.__pads });
`;

interface PadWin {
  __pads: (Record<string, unknown> | null)[];
  __mk(index: number, id: string): Record<string, unknown>;
  __set(i: number, b: number, v: number): void;
  __padEvents: [string, number, boolean][];
  __src?: { dispose(): void };
}

type Row = { id: string; label: string; family: number; connected: boolean };

const padRows = (page: Page): Promise<Row[]> => page.evaluate(() => window.__dotkick!.ctx.devices.list()
  .filter((d) => d.kind === 'pad').map((d) => ({ id: d.id, label: d.label, family: d.family, connected: d.connected })));

async function waitFrames(page: Page, n: number): Promise<void> {
  const f0 = await page.evaluate(() => window.__dotkickFrameStats!.frame);
  await page.waitForFunction((f) => window.__dotkickFrameStats!.frame >= f, f0 + n, { timeout: 30_000 });
}

async function tapButton(page: Page, i: number, b: number): Promise<void> {
  await page.evaluate(([pi, pb]) => (window as unknown as PadWin).__set(pi!, pb!, 1), [i, b]);
  await waitFrames(page, 2);
  await page.evaluate(([pi, pb]) => (window as unknown as PadWin).__set(pi!, pb!, 0), [i, b]);
  await waitFrames(page, 2);
}

test('pads join on a press, are labelled in press order, and a bound pad reconnecting at a new index keeps its id', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(MOCK_PADS);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__dotkick && !!window.__dotkickFrameStats);
  await waitFrames(page, 5);
  const screen0 = await page.evaluate(() => window.__dotkick!.ctx.router.current);

  // Connected but never pressed: not listed. Sticks do not count.
  await page.evaluate(() => { ((window as unknown as PadWin).__pads[0]!.axes as number[])[0] = 1; });
  await waitFrames(page, 3);
  expect(await padRows(page)).toEqual([]);
  await page.evaluate(() => { ((window as unknown as PadWin).__pads[0]!.axes as number[])[0] = 0; });

  // The DualSense (index 1) is pressed first: Controller 1. Then the Xbox pad: Controller 2.
  await tapButton(page, 1, 10);
  await tapButton(page, 0, 11);
  expect(await padRows(page)).toEqual([
    { id: 'pad:2', label: 'Controller 1', family: 1, connected: true },
    { id: 'pad:1', label: 'Controller 2', family: 2, connected: true },
  ]);

  // A third pad whose first press is shorter than a frame: caught through the gamepadconnected snapshot.
  await page.evaluate(() => {
    const w = window as unknown as PadWin;
    const p = w.__mk(2, 'Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)');
    (p.buttons as { pressed: boolean; value: number }[])[10] = { pressed: true, value: 1 };
    w.__pads[2] = p;
    const e = new Event('gamepadconnected') as Event & { gamepad: unknown };
    e.gamepad = { ...p, buttons: (p.buttons as object[]).map((b) => ({ ...b })) };
    window.dispatchEvent(e);
    (p.buttons as { pressed: boolean; value: number }[])[10] = { pressed: false, value: 0 }; // released at once
  });
  await page.waitForFunction(() => window.__dotkick!.ctx.devices.list().some((d) => d.id === 'pad:3'));
  expect((await padRows(page)).find((r) => r.id === 'pad:3')!.label).toBe('Controller 3');

  // Bind the DualSense to human 1 (as a match does) and watch bound-pad changes.
  await page.evaluate(() => {
    const w = window as unknown as PadWin;
    const reg = window.__dotkick!.ctx.devices as unknown as {
      createSource(id: string, h: number): { dispose(): void };
      onBoundPadChange(fn: (id: string, h: number, c: boolean) => void): () => void;
    };
    w.__padEvents = [];
    reg.onBoundPadChange((id, h, c) => w.__padEvents.push([id, h, c]));
    w.__src = reg.createSource('pad:2', 1);
  });

  // Bluetooth drop: the event and the polling diff both see it; reported once.
  await page.evaluate(() => {
    const w = window as unknown as PadWin;
    const p = w.__pads[1]!;
    p.connected = false;
    w.__pads[1] = null;
    const e = new Event('gamepaddisconnected') as Event & { gamepad: unknown };
    e.gamepad = p;
    window.dispatchEvent(e);
  });
  await waitFrames(page, 3);
  expect(await page.evaluate(() => (window as unknown as PadWin).__padEvents)).toEqual([['pad:2', 1, false]]);
  expect((await padRows(page)).find((r) => r.id === 'pad:2')!.connected).toBe(false);

  // Back at a new index (3): same id, same label, reported once.
  await page.evaluate(() => {
    const w = window as unknown as PadWin;
    w.__pads[3] = w.__mk(3, 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
  });
  await page.waitForFunction(() => (window as unknown as PadWin).__padEvents.length === 2);
  await waitFrames(page, 3);
  expect(await page.evaluate(() => (window as unknown as PadWin).__padEvents)).toEqual([['pad:2', 1, false], ['pad:2', 1, true]]);
  expect((await padRows(page)).find((r) => r.id === 'pad:2')).toEqual({ id: 'pad:2', label: 'Controller 1', family: 1, connected: true });
  expect((await padRows(page)).filter((r) => r.id.startsWith('pad:'))).toHaveLength(3);

  await page.evaluate(() => (window as unknown as PadWin).__src!.dispose());
  // L3 / R3 presses did not drive the menus.
  expect(await page.evaluate(() => window.__dotkick!.ctx.router.current)).toBe(screen0);
  expect(errors).toEqual([]);
});
