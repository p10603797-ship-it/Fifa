# PLT-02 — iPadOS hardening
Owns: `src/platform/ipados.ts`, `src/platform/viewport.css`. Spec: BRIEF §3 iPadOS and Safari behaviours (viewport-fit=cover, no user scaling, safe-area
insets, controls 24 pt clear of the bottom edge and top corners; browser gestures off on the game surface; windowing 4:3-21:9 and a minimum playable size;
orientation landscape either way up, portrait pauses with a rotate screen; Low Power Mode hint; full screen in a Safari tab where the API exists), glitch list
(rotation/backgrounding/resize mid-hold). Stubs by FND-04/FND-06 (read src/platform/* and public/*). BRIEF §3 (target device and iPadOS behaviours), §4 build output, §19 deliverables.
Implement/complete: CSS (safe-area variables, touch-action none, user-select none, -webkit-touch-callout none, tap highlight off, overscroll none on html/body,
fixed full-viewport layout that survives the iPad Safari toolbar showing/hiding), JS: block gesturestart/change/end, double-tap zoom (touchend timing),
contextmenu, long-press; orientation and size watcher (portrait -> pause + rotate overlay, too small -> pause + message, resume only by user), visualViewport
handling, fullscreen helper (requestFullscreen on the root where supported; hidden in standalone), Low Power Mode hint wiring from GFX-02's detector (one-time
toast). Expose a small API used by the session/router.
Tests: e2e — portrait viewport shows the rotate screen and pauses; tiny window message; no pinch-zoom (visualViewport.scale stays 1 after a synthetic pinch);
safe-area variables applied; resize mid-hold releases inputs (with TCH).
