# PLT-04 — Single-file build, size budget, fonts
Owns: `tools/postbuild.mjs`, `tools/size-check.ts`, `src/ui/fonts/**` (if subsetted font files are produced). Spec: BRIEF §3 (Download 4 MB or less compressed;
main menu within 3 s on Wi-Fi), §4 ("Build output: one self-contained index.html with all JavaScript, CSS and fonts inlined. Beside it sit
manifest.webmanifest, sw.js and icons ... The HTML must still run if those extras are missing."), §19 ("dist/index.html runs from a plain static server with
nothing else beside it"; relative paths only). Stubs by FND-04/FND-06 (read src/platform/* and public/*). BRIEF §3 (target device and iPadOS behaviours), §4 build output, §19 deliverables.
Implement: postbuild (verify dist/index.html is self-contained: no external script/style/font URLs, no absolute paths; copy/verify manifest, sw.js (inject a
build version), icons beside it; report raw/gzip/brotli sizes; fail over 4 MB gzip), size-check (breakdown by module via the Vite build manifest or a
rollup-plugin-visualizer-like pass you write; budget table in docs/PERF_REPORT.md section "Bundle"), fonts: ensure only Latin subsets of the two fonts
(@fontsource latin woff2 files) are inlined; consider subsetting further if needed. Startup: measure time to main menu in Playwright with network throttling
(simulate ~Wi-Fi 20 Mbit) and report.
Tests: e2e — dist/index.html served alone (no manifest/sw/icons) boots to the main menu with zero console errors; size budget check passes.
