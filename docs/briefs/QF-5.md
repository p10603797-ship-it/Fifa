# QF-5 — Build, install, offline, storage, audio lifecycle: QA-39, QA-40, QA-41, FIX-11

Area (exclusive for this wave): `src/platform/**`, `src/audio/**`, `src/app/**`, `public/**`, `index.html`,
`tools/postbuild.mjs`, `tools/size-check.ts`, `vite.config.ts`.
Charter (BRIEF §3, §4 single-file build, §8 Sound, §13 load time, §14 glitch list audio):
- QA-39 load time (splash interactive, tap to menu), bundle size (<= 4 MB gzip), warm-up hitches on match start.
- QA-40 install (manifest, icons, apple tags), offline (service worker serves everything with the network gone),
  update (new version toast, no mixed versions), storage failure (blocked, full, IDB timeouts) — the game still plays.
- QA-41 audio lifecycle: silent after background (must recover), crowd loop clicking, sounds stacking after a pause,
  unlock on first gesture, volume settings live.
- FIX-11 fixes in this area; also the app/session lifecycle (pause rules, hidden page, rematch/quit leaks).
- Licence notices (PLT-06 CR 2, SGN-05): dist/index.html must carry the third-party notices (three.js MIT, PeerJS MIT,
  webrtc-adapter BSD-3, binarypack / sdp / eventemitter3 MIT, @msgpack/msgpack ISC, OFL 1.1 for both fonts) — e.g. one
  HTML comment after the doctype built from node_modules/*/LICENSE in tools/postbuild.mjs, plus a Credits and licences
  view under Settings > Diagnostics. Never publish or deploy anything; the GitHub Pages workflow file stays in
  docs/DEPLOY.md until the user decides.
