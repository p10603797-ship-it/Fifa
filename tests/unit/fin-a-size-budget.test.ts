/**
 * [FIN-A] item 3: tools/size-check.ts failed on its src/contracts early-warning group budget (80 KB) since every
 * gameplay number moved into contracts/tuning.ts (TUN-1 / TUN-7S): the group measured 110.5 KB of module code at
 * sign-off (total bundle 819.6 KB gzip of 4 MB). The group budget now has room above that; the 4 MB gate is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { GROUP_BUDGETS_KB, TOTAL_GZIP_BUDGET } from '../../tools/size-check';

/** src/contracts module code at sign-off (npx tsx tools/size-check.ts, 2026-10-23), KB. */
const CONTRACTS_AT_SIGNOFF_KB = 110.5;

describe('FIN-A: size-check budgets', () => {
  it('the src/contracts group budget has at least 25% room above its size at sign-off (was 80 KB < 110.5 KB)', () => {
    expect(GROUP_BUDGETS_KB['src/contracts']).toBeGreaterThanOrEqual(CONTRACTS_AT_SIGNOFF_KB * 1.25);
  });

  it('the total gate is still 4 MB gzip', () => {
    expect(TOTAL_GZIP_BUDGET).toBe(4 * 1024 * 1024);
  });
});
