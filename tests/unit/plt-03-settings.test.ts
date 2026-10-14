/**
 * [PLT-03] Settings store: defaults, merge of partial / old data, v0 migration, corrupt JSON recovery, blocked and
 * full storage, range clamping, debounced saves with flush on hide, subscribe, reset, diagnostics lines.
 * Node only, over the fake localStorage in plt-03-fakes.ts and a manual clock.
 */
import { describe, expect, it, vi } from 'vitest';
import { AssistLevel, CameraType, KitSlot, PadFamily, QualityTier, SkillMove } from '../../src/contracts/enums';
import { createDefaultSettings, SETTINGS_SCHEMA_VERSION, type Settings } from '../../src/contracts/settings';
import { CLUB_COUNT } from '../../src/data/clubs';
import {
  countRepairs, createSettingsStore, decodeSettings, mergeWithDefaults, migrateSettings, migrateSettingsV0,
  SETTINGS_BACKUP_KEY, SETTINGS_KEY, SETTINGS_LIMITS, SETTINGS_MIGRATIONS, STORAGE_LOG_KIND,
  type SettingsMigration, type SettingsStoreOptions,
} from '../../src/platform/settingsStore';
import { createMemoryStorage, createSafeStorage, PROBE_KEY, type KeyValueStorage } from '../../src/platform/storage';
import { createFakeStorage, createManualTimers, type FakeStorage } from './plt-03-fakes';

/** Store over a fake localStorage with a manual clock and no lifecycle listeners (unless given). */
function setup(initial?: Record<string, string>, opts: SettingsStoreOptions = {}, fake: FakeStorage = createFakeStorage({ initial })) {
  const timers = createManualTimers();
  const storage = createSafeStorage(fake);
  const lines: string[] = [];
  const store = createSettingsStore(storage, {
    timers, lifecycle: null, log: (kind, message) => { lines.push(`${kind}: ${message}`); }, ...opts,
  });
  const saved = (): Settings => JSON.parse(fake.map.get(SETTINGS_KEY)!) as Settings;
  const settingsWrites = (): number => fake.writes.filter((k) => k === SETTINGS_KEY).length;
  return { fake, storage, store, timers, lines, saved, settingsWrites };
}

/** Keys the store wrote (the availability probe of createSafeStorage left out). */
function appWrites(fake: FakeStorage): string[] {
  return fake.writes.filter((k) => k !== PROBE_KEY);
}

function blob(v: unknown): string {
  return JSON.stringify(v);
}

describe('PLT-03 defaults', () => {
  it('empty storage gives the defaults, persistent, and writes nothing until a change', () => {
    const { store, fake, lines } = setup();
    expect(store.get()).toEqual(createDefaultSettings());
    expect(store.get().schema).toBe(SETTINGS_SCHEMA_VERSION);
    expect(store.persistent).toBe(true);
    expect(appWrites(fake)).toEqual([]);
    expect(lines).toEqual([]);
    expect(store.pending).toBe(false);
    expect(store.recoveries).toBe(0);
  });

  it('the defaults are inside every documented range (no repairs)', () => {
    expect(countRepairs(createDefaultSettings())).toBe(0);
    expect(mergeWithDefaults(createDefaultSettings())).toEqual(createDefaultSettings());
  });

  it('a clean stored blob loads as is and is not rewritten', () => {
    const s = createDefaultSettings();
    s.nickname = 'Ada';
    s.audio.crowd = 0.25;
    const { store, fake } = setup({ [SETTINGS_KEY]: blob(s) });
    expect(store.get()).toEqual(s);
    expect(appWrites(fake)).toEqual([]);
  });
});

describe('PLT-03 merge of partial and old data', () => {
  it('a partial blob keeps its values, new keys appear with defaults, unknown keys are dropped', () => {
    const { store, saved, lines } = setup({
      [SETTINGS_KEY]: blob({
        schema: 1,
        audio: { master: 0.4 },
        controls: { touch: { mirror: true } },
        camera: { type: CameraType.WIDE },
        retiredOption: 7,
      }),
    });
    const d = createDefaultSettings();
    const s = store.get();
    expect(s.audio).toEqual({ ...d.audio, master: 0.4 });
    expect(s.controls.touch.mirror).toBe(true);
    expect(s.controls.touch.opacity).toBe(d.controls.touch.opacity);
    expect(s.controls.pad).toEqual(d.controls.pad);
    expect(s.camera).toEqual({ ...d.camera, type: CameraType.WIDE });
    expect(s.accessibility).toEqual(d.accessibility);
    expect((s as unknown as Record<string, unknown>).retiredOption).toBeUndefined();
    // Written back in the canonical shape (every key present, the retired one gone).
    expect(saved()).toEqual(s);
    expect(lines).toEqual([]);
  });

  it('mistyped values fall back per field and are counted as repairs', () => {
    const { store, lines } = setup({
      [SETTINGS_KEY]: blob({ schema: 1, audio: { master: 'loud', crowd: 0.3 }, debug: 'yes', controls: 5, nickname: 42 }),
    });
    const d = createDefaultSettings();
    expect(store.get().audio.master).toBe(d.audio.master);
    expect(store.get().audio.crowd).toBe(0.3);
    expect(store.get().debug).toBe(false);
    expect(store.get().controls).toEqual(d.controls);
    expect(store.get().nickname).toBe(d.nickname);
    expect(lines).toEqual([`${STORAGE_LOG_KIND}: settings: 4 invalid value(s) replaced or clamped`]);
  });

  it('free-form records keep valid entries and drop invalid ones', () => {
    const s = mergeWithDefaults({
      controls: {
        touch: {
          layout: { 0: { dx: 10, dy: 20, scale: 1.1 }, 1: { dx: 'x', dy: 0, scale: 1 }, 2: 'nope', 3: { dx: 1, dy: 2 } },
          gestureEnabled: { tapToPass: false, swipe: 'on' },
        },
        pad: { remaps: { padA: [0, 1, 2.5, -7, 300, 'x'], padB: 'nope' } },
      },
      setPieceHintsSeen: { 1: 2, 2: -3, 3: 2.6, 4: 'x' },
      tutorialDone: { basics: true, shooting: 1 },
    });
    expect(s.controls.touch.layout).toEqual({ 0: { dx: 10, dy: 20, scale: 1.1 }, 3: { dx: 1, dy: 2, scale: 1 } });
    expect(s.controls.touch.gestureEnabled).toEqual({ tapToPass: false });
    expect(s.controls.pad.remaps).toEqual({ padA: [0, 1, -1, -1, -1, -1] });
    expect(s.setPieceHintsSeen).toEqual({ 1: 2, 2: 0, 3: 3 });
    expect(s.tutorialDone).toEqual({ basics: true });
  });

  it('prototype keys in stored records never reach an object prototype', () => {
    const text = '{"schema":1,"tutorialDone":{"__proto__":{"polluted":true},"ok":true},"controls":{"pad":{"remaps":{"constructor":[1]}}}}';
    const { store } = setup({ [SETTINGS_KEY]: text });
    const s = store.get();
    expect(s.tutorialDone).toEqual({ ok: true });
    expect(Object.getPrototypeOf(s.tutorialDone)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(s.controls.pad.remaps)).toEqual([]);
  });
});

describe('PLT-03 clamp ranges', () => {
  it('out-of-range numbers, unknown enum values and bad club indices are clamped or reset', () => {
    // The blob of the FND-04 adversarial e2e test (corrupt and out-of-range stored settings).
    const s = mergeWithDefaults({
      schema: 1,
      camera: { type: 99, height: -50, zoom: 1e6 },
      graphics: { tier: 42, showFps: true, resolutionScale: 7 },
      audio: { master: 9, crowd: -3, effects: 'loud', menus: null },
      match: { halfMinutes: 0, homeClub: 999, awayClub: -4, homeFormation: 77, difficulty: 55, homeKit: 9, awayKit: -1 },
      controls: { assist: 9, autoSwitch: 9, touch: { opacity: 40, spacing: -2, skillTap: 99, hintMatchesLeft: 1e9 } },
    });
    const d = createDefaultSettings();
    expect(s.camera).toEqual({ type: d.camera.type, height: 0, zoom: SETTINGS_LIMITS.cameraMax });
    expect(s.graphics).toEqual({ tier: d.graphics.tier, showFps: true, resolutionScale: SETTINGS_LIMITS.resolutionScaleMax });
    expect(s.audio).toEqual({ master: 1, crowd: 0, effects: d.audio.effects, menus: d.audio.menus });
    expect(s.match.halfMinutes).toBe(SETTINGS_LIMITS.halfMinutesMin);
    expect(s.match.homeClub).toBe(d.match.homeClub);
    expect(s.match.awayClub).toBe(d.match.awayClub);
    expect(s.match.homeFormation).toBe(d.match.homeFormation);
    expect(s.match.difficulty).toBe(d.match.difficulty);
    expect(s.match.homeKit).toBe(KitSlot.HOME);
    expect(s.match.awayKit).toBe(KitSlot.AWAY);
    expect(s.controls.assist).toBe(d.controls.assist);
    expect(s.controls.autoSwitch).toBe(d.controls.autoSwitch);
    expect(s.controls.touch.opacity).toBe(SETTINGS_LIMITS.opacityMax);
    expect(s.controls.touch.spacing).toBe(SETTINGS_LIMITS.spacingMin);
    expect(s.controls.touch.skillTap).toBe(SkillMove.STEP_OVER);
    expect(s.controls.touch.hintMatchesLeft).toBe(SETTINGS_LIMITS.hintMatchesMax);
  });

  it('valid enum values, the last club and fractional values are kept or rounded where integers are required', () => {
    const s = mergeWithDefaults({
      controls: { assist: AssistLevel.MANUAL, pad: { familyOverride: PadFamily.SWITCH } },
      graphics: { tier: QualityTier.QUALITY, resolutionScale: 0.3 },
      match: { homeClub: CLUB_COUNT - 1, halfMinutes: 6.4, homeKit: KitSlot.KEEPER },
      camera: { height: 12.5 },
    });
    expect(s.controls.assist).toBe(AssistLevel.MANUAL);
    expect(s.controls.pad.familyOverride).toBe(PadFamily.SWITCH);
    expect(s.graphics.tier).toBe(QualityTier.QUALITY);
    expect(s.graphics.resolutionScale).toBe(SETTINGS_LIMITS.resolutionScaleMin);
    expect(s.match.homeClub).toBe(CLUB_COUNT - 1);
    expect(s.match.halfMinutes).toBe(6);
    expect(s.match.homeKit).toBe(KitSlot.HOME); // the keeper kit is not a team kit choice
    expect(s.camera.height).toBe(12.5);
    expect(mergeWithDefaults({ graphics: { resolutionScale: -1 } }).graphics.resolutionScale).toBe(0);
  });

  it('layout placements are clamped to the documented scale and a sane offset', () => {
    const s = mergeWithDefaults({ controls: { touch: { layout: { a: { dx: -1e9, dy: 1e9, scale: 9 }, b: { dx: 5, dy: 5, scale: 0.1 } } } } });
    expect(s.controls.touch.layout.a).toEqual({ dx: -SETTINGS_LIMITS.placementOffsetMax, dy: SETTINGS_LIMITS.placementOffsetMax, scale: SETTINGS_LIMITS.placementScaleMax });
    expect(s.controls.touch.layout.b!.scale).toBe(SETTINGS_LIMITS.placementScaleMin);
  });

  it('records are capped at recordEntriesMax entries', () => {
    const flags: Record<string, boolean> = {};
    for (let i = 0; i < SETTINGS_LIMITS.recordEntriesMax + 40; i++) flags['t' + i] = true;
    expect(Object.keys(mergeWithDefaults({ tutorialDone: flags }).tutorialDone)).toHaveLength(SETTINGS_LIMITS.recordEntriesMax);
  });

  it('nicknames are trimmed, stripped of control and bidi characters and cut to nicknameMaxChars', () => {
    const nick = (v: unknown): string => mergeWithDefaults({ nickname: v }).nickname;
    expect(nick('  Ada  ')).toBe('Ada');
    expect(nick('A\u0000d‮a\n')).toBe('Ada');
    expect(nick('x'.repeat(40))).toBe('x'.repeat(SETTINGS_LIMITS.nicknameMaxChars));
    expect(Array.from(nick('⚽'.repeat(30)))).toHaveLength(SETTINGS_LIMITS.nicknameMaxChars);
    expect(nick('   ')).toBe(createDefaultSettings().nickname);
    expect(nick('Zoë 😀')).toBe('Zoë 😀');
  });

  it('update() clamps too: a slider writing past its range stores the bound', () => {
    const { store, saved } = setup();
    store.update((s) => { s.controls.touch.opacity = 0.05; s.audio.master = 1.5; s.camera.type = 42 as CameraType; });
    expect(store.get().controls.touch.opacity).toBe(SETTINGS_LIMITS.opacityMin);
    expect(store.get().audio.master).toBe(1);
    expect(store.get().camera.type).toBe(CameraType.BROADCAST);
    expect(saved().controls.touch.opacity).toBe(SETTINGS_LIMITS.opacityMin);
  });
});

describe('PLT-03 migrations', () => {
  const v0Blob = {
    // No schema field: a pre-versioned blob with legacy representations.
    controls: { assist: '2', touch: { mirror: 1, gestures: 'false', opacity: '0.5', gestureEnabled: { swipe: 0 } } },
    audio: { master: '0.6', crowd: 0.4 },
    camera: { type: CameraType.CLOSE, height: '12' },
    debug: 1,
    lowPowerHintShown: 'true',
    tutorialDone: { basics: 1, shooting: 'false' },
    setPieceHintsSeen: { 3: '2' },
    nickname: 'Old',
  };

  it('migrates a v0 shape (no schema, 0/1 booleans, numeric strings) to the current schema', () => {
    const { store, saved, lines } = setup({ [SETTINGS_KEY]: blob(v0Blob) });
    const s = store.get();
    expect(s.schema).toBe(SETTINGS_SCHEMA_VERSION);
    expect(s.controls.assist).toBe(AssistLevel.MANUAL);
    expect(s.controls.touch.mirror).toBe(true);
    expect(s.controls.touch.gestures).toBe(false);
    expect(s.controls.touch.opacity).toBe(0.5);
    expect(s.controls.touch.gestureEnabled).toEqual({ swipe: false });
    expect(s.audio.master).toBe(0.6);
    expect(s.audio.crowd).toBe(0.4);
    expect(s.camera).toEqual({ type: CameraType.CLOSE, height: 12, zoom: createDefaultSettings().camera.zoom });
    expect(s.debug).toBe(true);
    expect(s.lowPowerHintShown).toBe(true);
    expect(s.tutorialDone).toEqual({ basics: true, shooting: false });
    expect(s.setPieceHintsSeen).toEqual({ 3: 2 });
    expect(s.nickname).toBe('Old');
    // Written back at the current schema; the next load is clean.
    expect(saved()).toEqual(s);
    expect(lines).toContain(`${STORAGE_LOG_KIND}: settings migrated from schema 0 to ${SETTINGS_SCHEMA_VERSION}`);
    const again = setup({ [SETTINGS_KEY]: JSON.stringify(saved()) });
    expect(again.store.get()).toEqual(s);
    expect(appWrites(again.fake)).toEqual([]);
  });

  it('the v0 migration is registered at index 0 and does not mutate its input', () => {
    expect(SETTINGS_MIGRATIONS[0]).toBe(migrateSettingsV0);
    const input = JSON.parse(blob(v0Blob)) as Record<string, unknown>;
    const copy = JSON.parse(blob(v0Blob)) as Record<string, unknown>;
    const out = migrateSettingsV0(input);
    expect(input).toEqual(copy);
    expect(out.schema).toBe(1);
  });

  it('runs a migration chain step by step from the stored schema', () => {
    const calls: number[] = [];
    const migrations: Record<number, SettingsMigration> = {
      0: (raw) => { calls.push(0); return { ...raw, schema: 1 }; },
      1: (raw) => { calls.push(1); const a = raw.audio as Record<string, number>; return { ...raw, audio: { ...a, master: a.master / 2 } }; },
      2: (raw) => { calls.push(2); return { ...raw, nickname: 'v3' }; },
    };
    const { store, saved } = setup({ [SETTINGS_KEY]: blob({ schema: 1, audio: { master: 0.8 } }) }, { migrations, schemaVersion: 3 });
    expect(calls).toEqual([1, 2]);
    expect(store.get().audio.master).toBeCloseTo(0.4);
    expect(store.get().nickname).toBe('v3');
    expect(store.get().schema).toBe(3);
    expect(saved().schema).toBe(3);
    // A schema below 0 or a fractional one never loops forever.
    expect(decodeSettings(blob({ schema: -1e9 }), migrations, 3).fromSchema).toBe(0);
    expect(decodeSettings(blob({ schema: 2.7 }), migrations, 3).fromSchema).toBe(2);
  });

  it('a blob from a newer schema is read but not rewritten until the player edits a setting', () => {
    const newer = { schema: SETTINGS_SCHEMA_VERSION + 3, nickname: 'Future', futureOnly: { x: 1 } };
    const { store, fake, lines, saved } = setup({ [SETTINGS_KEY]: blob(newer) });
    expect(store.get().nickname).toBe('Future');
    expect(store.get().schema).toBe(SETTINGS_SCHEMA_VERSION);
    expect(appWrites(fake)).toEqual([]);
    expect(lines.some((l) => l.includes('newer schema'))).toBe(true);
    store.update((s) => { s.debug = true; });
    expect(saved().schema).toBe(SETTINGS_SCHEMA_VERSION);
  });

  it('migrateSettings is pure and returns the defaults for unusable input', () => {
    expect(migrateSettings(undefined)).toEqual(createDefaultSettings());
    expect(migrateSettings(42)).toEqual(createDefaultSettings());
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(migrateSettings(cyclic)).toEqual(createDefaultSettings());
  });
});

describe('PLT-03 corrupted JSON recovery', () => {
  it('bad JSON: raw text goes to the backup key, defaults are used and written, diagnostics get a line', () => {
    const { store, fake, saved, lines } = setup({ [SETTINGS_KEY]: '{"schema":1,"audio":{"mas' });
    expect(store.get()).toEqual(createDefaultSettings());
    expect(fake.map.get(SETTINGS_BACKUP_KEY)).toBe('{"schema":1,"audio":{"mas');
    expect(saved()).toEqual(createDefaultSettings());
    expect(store.recoveries).toBe(1);
    expect(lines).toEqual([`${STORAGE_LOG_KIND}: settings corrupt (bad JSON): moved to ${SETTINGS_BACKUP_KEY}, using defaults`]);
    // The next boot is clean and keeps the backup.
    const again = setup(Object.fromEntries(fake.map));
    expect(again.store.recoveries).toBe(0);
    expect(again.lines).toEqual([]);
    expect(again.fake.map.get(SETTINGS_BACKUP_KEY)).toBe('{"schema":1,"audio":{"mas');
  });

  it.each([
    ['an array', '[1,2,3]', 'not an object'],
    ['a string', '"settings"', 'not an object'],
    ['null', 'null', 'not an object'],
    ['a number', '42', 'not an object'],
    ['empty text', '', 'bad JSON'],
  ])('%s is treated as corrupt', (_name, text, reason) => {
    const { store, fake, lines } = setup({ [SETTINGS_KEY]: text });
    expect(store.get()).toEqual(createDefaultSettings());
    expect(fake.map.get(SETTINGS_BACKUP_KEY)).toBe(text);
    expect(lines[0]).toContain(`(${reason})`);
  });

  it('a throwing migration is corruption too (backup + defaults)', () => {
    const migrations: Record<number, SettingsMigration> = { 0: () => { throw new Error('boom'); } };
    const { store, fake, lines } = setup({ [SETTINGS_KEY]: blob({ nickname: 'x' }) }, { migrations });
    expect(store.get()).toEqual(createDefaultSettings());
    expect(fake.map.get(SETTINGS_BACKUP_KEY)).toBe(blob({ nickname: 'x' }));
    expect(lines[0]).toContain('migration 0 failed');
  });

  it('log lines written before a diagnostics sink exists are replayed once when it is attached', () => {
    const fake = createFakeStorage({ initial: { [SETTINGS_KEY]: '{oops' } });
    const store = createSettingsStore(createSafeStorage(fake), { lifecycle: null, timers: createManualTimers() });
    const log = vi.fn();
    store.setLogger(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toBe(STORAGE_LOG_KIND);
    expect(log.mock.calls[0]![1]).toContain('settings corrupt (bad JSON)');
    expect(log.mock.calls[0]![2]).toBe('{oops');
    store.setLogger(null);
    store.setLogger(log);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('a throwing diagnostics sink never breaks the store', () => {
    const { store } = setup({ [SETTINGS_KEY]: '{oops' }, { log: () => { throw new Error('sink'); } });
    expect(store.get()).toEqual(createDefaultSettings());
    store.update((s) => { s.debug = true; });
    expect(store.get().debug).toBe(true);
  });
});

describe('PLT-03 blocked and full storage', () => {
  it('blocked storage (SecurityError on every access) falls back to memory: persistent false, updates still work', () => {
    const fake = createFakeStorage({ blocked: true });
    const { store, lines } = setup(undefined, {}, fake);
    expect(store.persistent).toBe(false);
    expect(store.get()).toEqual(createDefaultSettings());
    store.update((s) => { s.audio.master = 0.5; });
    expect(store.get().audio.master).toBe(0.5);
    store.saveProgress('records', { won: 1 });
    expect(store.loadProgress<{ won: number }>('records')).toEqual({ won: 1 });
    expect(lines).toEqual([`${STORAGE_LOG_KIND}: storage unavailable or full: settings and progress are kept in memory for this session`]);
  });

  it('no localStorage at all (null backing) is memory only', () => {
    const store = createSettingsStore(createSafeStorage(null), { lifecycle: null });
    expect(store.persistent).toBe(false);
    store.update((s) => { s.debug = true; });
    expect(store.get().debug).toBe(true);
  });

  it('a full but readable localStorage still loads the saved settings (read-only mode)', () => {
    const s = createDefaultSettings();
    s.nickname = 'Kept';
    const fake = createFakeStorage({ initial: { [SETTINGS_KEY]: blob(s), filler: 'x'.repeat(100) } });
    fake.quotaChars = 0; // nothing more fits, not even the probe
    const { store } = setup(undefined, {}, fake);
    expect(store.get().nickname).toBe('Kept');
    expect(store.persistent).toBe(false);
    store.update((x) => { x.nickname = 'New'; });
    expect(store.get().nickname).toBe('New');
    expect(JSON.parse(fake.map.get(SETTINGS_KEY)!).nickname).toBe('Kept');
  });

  it('a quota error mid-session turns persistent false (logged once) and back on after a successful save', () => {
    const { store, fake, lines, timers, saved } = setup();
    expect(store.persistent).toBe(true);
    fake.failWrites = true;
    store.update((s) => { s.debug = true; });
    expect(store.persistent).toBe(false);
    timers.advance(10_000);
    store.update((s) => { s.debug = false; });
    expect(lines.filter((l) => l.includes('could not be saved'))).toHaveLength(1);
    fake.failWrites = false;
    timers.advance(10_000);
    store.update((s) => { s.nickname = 'Back'; });
    expect(store.persistent).toBe(true);
    expect(saved().nickname).toBe('Back');
    expect(lines.some((l) => l.includes('settings saved again'))).toBe(true);
  });

  it('the plain memory storage reports not persistent', () => {
    const store = createSettingsStore(createMemoryStorage(), { lifecycle: null });
    expect(store.persistent).toBe(false);
  });

  it('a KeyValueStorage whose set throws is contained', () => {
    const base = createMemoryStorage();
    const throwing: KeyValueStorage = { ...base, persistent: true, keys: base.keys, set: () => { throw new Error('x'); } };
    const store = createSettingsStore(throwing, { lifecycle: null });
    expect(() => store.update((s) => { s.debug = true; })).not.toThrow();
    expect(store.persistent).toBe(false);
  });
});

describe('PLT-03 debounced saves', () => {
  it('the first change is written at once; a burst is coalesced into one trailing write with the last values', () => {
    const { store, timers, saved, settingsWrites } = setup();
    store.update((s) => { s.audio.master = 0.1; });
    expect(settingsWrites()).toBe(1);
    expect(saved().audio.master).toBe(0.1);
    for (let i = 2; i <= 9; i++) {
      timers.advance(20);
      store.update((s) => { s.audio.master = i / 10; });
    }
    expect(settingsWrites()).toBe(1);
    expect(store.pending).toBe(true);
    expect(store.get().audio.master).toBe(0.9);
    timers.advance(299);
    expect(settingsWrites()).toBe(1);
    timers.advance(1);
    expect(settingsWrites()).toBe(2);
    expect(saved().audio.master).toBe(0.9);
    expect(store.pending).toBe(false);
    // Quiet again: the window closes, and the next change is a fresh leading write.
    timers.advance(1000);
    expect(timers.pendingTimers).toBe(0);
    store.update((s) => { s.audio.master = 0.3; });
    expect(settingsWrites()).toBe(3);
  });

  it('a continuous drag still saves at least every maxWait', () => {
    const { store, timers, settingsWrites, saved } = setup(undefined, { debounceMs: 300, maxWaitMs: 1000 });
    store.update((s) => { s.audio.crowd = 0; });
    for (let t = 0; t < 2500; t += 16) {
      timers.advance(16);
      const value = Math.round((t % 1000) / 10) / 100;
      store.update((s) => { s.audio.crowd = value; });
    }
    // Leading write + one per maxWait window during the 2.5 s drag.
    expect(settingsWrites()).toBeGreaterThanOrEqual(3);
    expect(settingsWrites()).toBeLessThanOrEqual(4);
    timers.advance(2000);
    expect(saved().audio.crowd).toBe(store.get().audio.crowd);
  });

  it('flush() writes a pending change at once', () => {
    const { store, settingsWrites, saved } = setup();
    store.update((s) => { s.debug = true; });
    store.update((s) => { s.nickname = 'Flushed'; });
    expect(settingsWrites()).toBe(1);
    expect(store.flush()).toBe(true);
    expect(settingsWrites()).toBe(2);
    expect(saved().nickname).toBe('Flushed');
    expect(store.flush()).toBe(true); // nothing pending: no extra write
    expect(settingsWrites()).toBe(2);
  });

  it('pagehide and a hidden page flush the pending write; a visible page does not', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const { store, settingsWrites, saved } = setup(undefined, { lifecycle: { window: win, document: doc } });
    store.update((s) => { s.debug = true; });
    store.update((s) => { s.nickname = 'One'; });
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(settingsWrites()).toBe(1);
    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(settingsWrites()).toBe(2);
    expect(saved().nickname).toBe('One');
    store.update((s) => { s.nickname = 'Two'; });
    win.dispatchEvent(new Event('pagehide'));
    expect(saved().nickname).toBe('Two');
  });

  it('dispose() flushes, cancels the timer and removes the listeners; later updates write at once', () => {
    const win = new EventTarget();
    const add = vi.spyOn(win, 'addEventListener');
    const remove = vi.spyOn(win, 'removeEventListener');
    const { store, timers, settingsWrites, saved } = setup(undefined, { lifecycle: { window: win, document: null } });
    expect(add).toHaveBeenCalledWith('pagehide', expect.any(Function));
    store.update((s) => { s.debug = true; });
    store.update((s) => { s.nickname = 'Pending'; });
    store.dispose();
    expect(saved().nickname).toBe('Pending');
    expect(remove).toHaveBeenCalledWith('pagehide', add.mock.calls[0]![1]);
    expect(timers.pendingTimers).toBe(0);
    const before = settingsWrites();
    store.update((s) => { s.nickname = 'After'; });
    store.update((s) => { s.nickname = 'After2'; });
    expect(settingsWrites()).toBe(before + 2);
    store.dispose();
  });

  it('debounceMs 0 writes every change', () => {
    const { store, settingsWrites } = setup(undefined, { debounceMs: 0 });
    store.update((s) => { s.debug = true; });
    store.update((s) => { s.debug = false; });
    store.update((s) => { s.debug = true; });
    expect(settingsWrites()).toBe(3);
  });

  it('reset() writes at once even inside a burst window', () => {
    const { store, saved } = setup();
    store.update((s) => { s.nickname = 'A'; });
    store.update((s) => { s.nickname = 'B'; });
    store.reset();
    expect(saved()).toEqual(createDefaultSettings());
    expect(store.pending).toBe(false);
  });
});

describe('PLT-03 subscribe', () => {
  it('subscribers get the new object on every real change, never on a no-op update', () => {
    const { store } = setup();
    const seen: Readonly<Settings>[] = [];
    const unsub = store.subscribe((s) => { seen.push(s); });
    const first = store.get();
    store.update((s) => { s.controls.assist = AssistLevel.SEMI; });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(store.get());
    expect(seen[0]).not.toBe(first);
    expect(first.controls.assist).toBe(AssistLevel.ASSISTED);
    store.update((s) => { s.controls.assist = AssistLevel.SEMI; }); // same value
    store.update(() => { /* nothing */ });
    store.update((s) => { s.audio.master = 7; s.audio.master = 0.8; }); // ends where it started
    expect(seen).toHaveLength(1);
    unsub();
    store.update((s) => { s.debug = true; });
    expect(seen).toHaveLength(1);
  });

  it('reset() notifies and drops the settings backup', () => {
    const { store, fake } = setup({ [SETTINGS_KEY]: '{bad' });
    expect(fake.map.has(SETTINGS_BACKUP_KEY)).toBe(true);
    const fn = vi.fn();
    store.subscribe(fn);
    store.reset();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fake.map.has(SETTINGS_BACKUP_KEY)).toBe(false);
  });

  it('a throwing mutator leaves the settings untouched and nothing is notified or written', () => {
    const { store, fake } = setup();
    const fn = vi.fn();
    store.subscribe(fn);
    expect(() => store.update((s) => { s.debug = true; throw new Error('ui bug'); })).toThrow('ui bug');
    expect(store.get().debug).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(appWrites(fake)).toEqual([]);
  });

  it('a listener that updates again sees consistent state, and every listener ends on the latest object', () => {
    const { store } = setup();
    const last: Readonly<Settings>[] = [];
    store.subscribe((s) => {
      if (s.nickname === 'A') store.update((x) => { x.nickname = 'B'; });
    });
    store.subscribe((s) => { last.push(s); });
    store.update((s) => { s.nickname = 'A'; });
    expect(store.get().nickname).toBe('B');
    expect(last[last.length - 1]!.nickname).toBe('B');
  });

  it('a throwing subscriber does not stop the others', () => {
    const { store } = setup();
    store.subscribe(() => { throw new Error('bad'); });
    const ok = vi.fn();
    store.subscribe(ok);
    store.update((s) => { s.debug = true; });
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('PLT-03 describe()', () => {
  it('summarises the storage mode for the diagnostics report', () => {
    const { store } = setup();
    expect(store.describe()).toContain('localStorage;');
    expect(store.describe()).toContain(`schema ${SETTINGS_SCHEMA_VERSION}`);
    const blocked = createSettingsStore(createSafeStorage(createFakeStorage({ blocked: true })), { lifecycle: null });
    expect(blocked.describe()).toContain('memory only');
  });
});
