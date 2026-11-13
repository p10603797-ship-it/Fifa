/**
 * [GATE] e2e helpers for the password lock (D-047). Test codes are this file's own (never the shipped ones); their
 * hashes reach the page through the test hook window.__dotkickGateTest (src/app/gate.ts), set by an init script.
 *
 * - unlockGateInContext (tools/lib/gateUnlock.ts): seed the unlock record on any origin (own static servers, specs
 *   that clear localStorage and reload).
 * - acceptTestCodes + unlockWithTestCode: for specs whose storage is blocked (private browsing), where no record can
 *   be seeded: type a test code on the lock screen, then Continue past the "not remembered" notice.
 */
import { createHash } from 'node:crypto';
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { GATE_HASH_PREFIX, normaliseCode } from '../../src/app/gate';

export { unlockGateInContext } from '../../tools/lib/gateUnlock';

/** Test codes (not shipped; accepted only through the test hook). */
export const TEST_CODES = ['TSTA-2345-6789', 'TSTB-ABCD-EFGH', 'TSTC-JKMN-PQRS', 'TSTD-TUVW-XYZ2'] as const;

/** The hash the game stores a code under (same recipe as src/app/gate.ts hashCode, with node:crypto). */
export function testCodeHash(code: string): string {
  return createHash('sha256').update(GATE_HASH_PREFIX + normaliseCode(code), 'utf8').digest('hex');
}

/** Make the page accept the test codes (init script, before the page runs). */
export async function acceptTestCodes(target: Page | BrowserContext, codes: readonly string[] = TEST_CODES): Promise<void> {
  const hashes = codes.map(testCodeHash);
  await target.addInitScript((hs: string[]) => {
    (window as unknown as { __dotkickGateTest?: { hashes: string[] } }).__dotkickGateTest = { hashes: hs };
  }, hashes);
}

/**
 * On the lock screen: type `code`, tap Unlock, and (storage that cannot remember) tap Continue. Resolves once the
 * lock is gone. Call acceptTestCodes before the page loads.
 */
export async function unlockWithTestCode(page: Page, code: string = TEST_CODES[0]): Promise<void> {
  await expect(page.getByTestId('gate')).toBeVisible();
  await page.getByTestId('gate-input').fill(code);
  await page.getByTestId('gate-submit').tap();
  await page.waitForFunction(() => !document.querySelector('[data-testid="gate"]') || !!document.querySelector('[data-testid="gate-continue"]'));
  const cont = page.getByTestId('gate-continue');
  if ((await cont.count()) > 0) await cont.tap();
  await expect(page.getByTestId('gate')).toHaveCount(0);
}
