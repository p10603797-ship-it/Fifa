/** Build-time flag: true in dev builds and tests (vite/vitest define it; tools set globalThis.__DEV_BUILD__).
 *  Sim code should test it as `typeof __DEV_BUILD__ !== 'undefined' && __DEV_BUILD__`. */
declare const __DEV_BUILD__: boolean;
