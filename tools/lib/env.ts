/**
 * [FND-06] Node environment shim for the headless tools. Import it first: Vite and Vitest replace the
 * compile-time flag __DEV_BUILD__ (test builds assert on illegal transitions), but tsx / node do not, so the
 * tools define it as a global (true: soak and fuzz are test builds).
 */
const g = globalThis as unknown as Record<string, unknown>;
if (g.__DEV_BUILD__ === undefined) g.__DEV_BUILD__ = true;

export const DEV_BUILD = g.__DEV_BUILD__ === true;
