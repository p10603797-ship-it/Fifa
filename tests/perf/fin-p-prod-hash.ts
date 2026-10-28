/**
 * [FIN-P skeptic] tools/hash-table.ts in production-build mode (diagnostic, not a test): __DEV_BUILD__ = false before
 * anything loads, so initMatch runs the sim warm-up once per process (sim/init.ts warmUpOnce) and every new state and
 * copy target gets its shapes settled (core/clone.ts shapeSettlingOn), as in the shipped app. The table must equal the
 * dev-build table of the tree before FIN-P (the warm-up and settling must be invisible to every match that follows).
 *
 *   npx tsx tests/perf/fin-p-prod-hash.ts --compare before.json [--part 0/3]
 */
(globalThis as unknown as Record<string, unknown>).__DEV_BUILD__ = false;
await import('../../tools/hash-table');

export {};
