import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single self-contained index.html: all JS, CSS and fonts inlined (section 4).
// manifest.webmanifest, sw.js and icons are copied from /public beside it and are optional at runtime.
export default defineConfig({
  base: './',
  plugins: [viteSingleFile({ removeViteModuleLoader: true })],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    // The single-file build never preloads modules: drop the unused polyfill and its fetch() code (SGN-05).
    modulePreload: { polyfill: false },
    reportCompressedSize: true,
    sourcemap: false,
    // Keep module-level const/let as written (Vite 8 / Rolldown default turns them into var). V8 then types module
    // constants precisely instead of boxing doubles that meet them in hot code: sim+AI allocation 8.0 -> 6.6 KB/tick and
    // the 4x proxy gate's worst-tick p99 down ~0.5 ms (FIN-P2, D-026). An import cycle that read a binding before its
    // initialisation would now throw (TDZ) instead of reading undefined; the full e2e campaign runs on this build.
    rolldownOptions: { output: { topLevelVar: false } },
  },
  define: {
    __DEV_BUILD__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  server: { host: true },
});
