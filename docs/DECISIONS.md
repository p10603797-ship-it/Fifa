# Decisions

Decisions taken where the brief is silent or the environment forces a choice. Newest last.

| Id | Decision | Why |
|---|---|---|
| D-001 | TypeScript 5.9.3 (not 6.x/7.x) | typescript-eslint 8.71 supports < 6.1; 7.x is the native compiler without the JS API that tooling expects. |
| D-002 | Vite 8.3.4, Vitest 5.0.4, Playwright 1.56.1, Three 0.186.1, PeerJS 1.5.5, vite-plugin-singlefile 2.3.3; fonts from @fontsource 5.3.0 (OFL) | Pinned current stable versions; Playwright 1.56.1 matches the container's preinstalled Chromium build 1194. |
| D-003 | Only Chromium exists in the build container (no WebKit/Firefox binaries, and installing browsers is not allowed). Playwright WebKit project auto-enables when a WebKit build is present. Determinism is verified in Node and Chromium here; cross-engine safety comes from the deterministic math module (no transcendental Math calls in sim/ai). | Environment limit. Re-scoped in TEST_REPORT; the device checklist covers Safari. |
| D-004 | InputFrame buttons are positional-semantic (FC Classic positions: PASS=Cross/A, SHOOT=Circle/B, LOB=Square/X, THROUGH=Triangle/Y, MOD_L=L1, MOD_R=R1, SHIELD=L2, SPRINT=R2) with context aliases (TACKLE, SLIDE, SWITCH, ...). The sim resolves meaning from context. | Keeps one input format, lets holds/combos/possession swaps resolve deterministically in the sim, and touch maps onto the same bits. |
| D-005 | Agents share one working tree with exclusive file ownership; the lead commits between batches and runs the verify gate. No per-agent git worktrees. | 4-CPU container; later agents build on real implementations instead of stubs; exclusive ownership makes merges trivial anyway. |
| D-006 | SIM-15 split into SIM-15 (action input resolution) and SIM-16 (player switching). Roster total 201. | Both are large; switching is a self-contained module. |
| D-007 | 22 fixed on-pitch slots (team 0: 0-10, team 1: 11-21). A substitution swaps the roster index and attributes into the slot; a sent-off player's slot becomes inactive. | Fixed-size typed state, simple invariants. |
| D-008 | After a restart's setup delay any player not in a legal position is moved there instantly (hidden by the restart camera cut). | Guarantees legal restarts and no "blocking forever" glitches. |
| D-009 | Saves are always made by the keeper AI, also on human sides; humans control rush-out, pick-up and distribution. | Matches console behaviour and the brief's GKP split. |
| D-010 | The lead wrote the toolchain (FND-01) and contracts + sim/ai skeleton (FND-02) directly. | They are the frozen foundation every other assignment depends on. |
| D-011 | Pitch-space input: stick right = +x, stick down = +z for the broadcast camera; other cameras rotate via CameraProjector.stickRotation(). | Predictable control under a fixed side camera; network frames are camera-independent. |
