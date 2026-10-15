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
  },
  define: {
    __DEV_BUILD__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  server: { host: true },
});
