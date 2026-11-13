/**
 * [GATE] Test and tooling side of the password lock (src/app/gate.ts, D-047): every automated browser run starts on
 * an unlocked device, exactly like a player's iPad after the first unlock.
 *
 * - playwright.config.ts seeds the unlock record through `use.storageState` (gateUnlockedStorageState) for the
 *   served origin (localhost and 127.0.0.1 on PW_PORT). Playwright Test applies it to the `page` / `context`
 *   fixtures and to every browser.newContext() made inside a spec (including chromium.launch() in a spec).
 * - Specs that serve the game from another origin (their own static server) or clear localStorage and reload, and the
 *   perf harnesses and tools/bench.ts that launch Chromium themselves, call unlockGateInContext(context): an init
 *   script that writes the record before the page runs, on every navigation, on any origin.
 * - The lock itself is tested on a context with nothing seeded: tests/e2e/gate-01-lock.spec.ts.
 */
import type { BrowserContext } from '@playwright/test';
import { GATE_UNLOCK_KEY, unlockRecordJson } from '../../src/app/gate';

/** The unlock record every test context starts with (unlocked at epoch 0: clearly a test seed). */
export const GATE_TEST_UNLOCK_VALUE = unlockRecordJson(0);

/** Playwright storage state with the unlock record for each origin (e.g. `http://localhost:4173`). */
export function gateUnlockedStorageState(origins: readonly string[]): {
  cookies: [];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
} {
  return {
    cookies: [],
    origins: origins.map((origin) => ({ origin, localStorage: [{ name: GATE_UNLOCK_KEY, value: GATE_TEST_UNLOCK_VALUE }] })),
  };
}

/** Init script: the unlock record is in localStorage before the page script runs (any origin, every navigation). */
export async function unlockGateInContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(({ key, value }: { key: string; value: string }) => {
    try {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    } catch {
      /* storage blocked (opaque origin, a spec that blocks it): the page shows the lock */
    }
  }, { key: GATE_UNLOCK_KEY, value: GATE_TEST_UNLOCK_VALUE });
}
