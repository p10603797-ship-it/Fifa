# PLT-03 — Storage, settings schema, migrations
Owns: `src/platform/storage.ts`, `src/platform/settingsStore.ts`. Spec: BRIEF §3 ("Keep settings and progress in localStorage or IndexedDB with a schema version
and migrations. Fall back to memory if storage is blocked."), contracts/settings.ts (Settings, SETTINGS_SCHEMA_VERSION, createDefaultSettings), app.ts
SettingsStore. Stubs by FND-04/FND-06 (read src/platform/* and public/*). BRIEF §3 (target device and iPadOS behaviours), §4 build output, §19 deliverables.
Implement: storage wrapper (localStorage with quota/security errors caught; optional IndexedDB for larger progress like cup saves and replays), SettingsStore:
load (parse safely, validate shape against defaults deep-merge so new keys appear, clamp ranges), migrations table by schema number, save debounced, subscribe,
reset, persistent flag false when storage is blocked (memory fallback), progress API (cup saves, records, replays) with versioning and corruption recovery
(bad JSON -> backup key + defaults, logged to diagnostics).
Tests: unit with a fake Storage (Node): defaults, merge of partial/old data, migration from a v0 shape, corrupted JSON recovery, blocked storage fallback,
debounce, subscribe.
