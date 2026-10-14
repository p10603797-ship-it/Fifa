/**
 * [QF-5] CR (outside QF-5's area): Settings > Diagnostics needs a "Credits and licences" view (PLT-06 CR 2, SGN-05).
 * The data and the view are ready in src/platform/licences.ts (createCreditsView reads the notices comment that
 * tools/postbuild.mjs writes into dist/index.html); src/ui/screens/diagnostics.ts has to offer it. Marked it.fails
 * until the screen owner applies the CR (then flip it to it()).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('QF-5 CR: Credits and licences view under Settings > Diagnostics', () => {
  it.fails('the diagnostics screen offers a Credits and licences button that mounts createCreditsView()', () => {
    const src = readFileSync(`${root}src/ui/screens/diagnostics.ts`, 'utf8');
    expect(src).toContain("from '../../platform/licences'");
    expect(src).toContain('createCreditsView(');
    expect(src).toMatch(/Credits and licences/);
  });
});
