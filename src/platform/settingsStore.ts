/**
 * [PLT-03] Settings store: schema version, migrations, validation, debounced saves, progress saves.
 *
 * Settings (BRIEF §3 storage, §12 settings screens; contracts/settings.ts) live under SETTINGS_KEY as the JSON of a
 * whole Settings object (`schema` included).
 *  - Load: parse safely, run SETTINGS_MIGRATIONS from the stored `schema` up to SETTINGS_SCHEMA_VERSION, deep-merge
 *    over createDefaultSettings() (new keys appear with their defaults, unknown keys are dropped, mistyped values
 *    fall back) and clamp every value to its documented range (SETTINGS_LIMITS, enums, club indices). Bad JSON, a
 *    non-object or a throwing migration is corruption: the raw text goes to SETTINGS_BACKUP_KEY, the defaults are
 *    used and written back, and a 'storage' line goes to diagnostics. A repaired or migrated blob is written back at
 *    once; a blob from a newer schema is left untouched until the player changes a setting.
 *  - update(): mutate a copy, merge + clamp, and if anything changed replace the settings object (consumers rely on
 *    a new object per change), notify subscribers and save. Saves are debounced with a leading edge: the first
 *    change after a quiet period is written at once, a burst (slider drag) is coalesced and written when it goes
 *    quiet (LOCAL_TUNING.saveDebounceMs) or at least every LOCAL_TUNING.saveMaxWaitMs. pagehide and a hidden page
 *    flush a pending write; reset() writes at once.
 *  - persistent: false when storage is blocked (memory fallback) or the last settings write failed (quota).
 *
 * Progress (cup saves, records; sync, localStorage) is stored per key under PROGRESS_PREFIX in a versioned envelope
 * `{ "$dotkick": 1, "v": <data version>, "data": <value> }`. PROGRESS_SCHEMAS (registerProgressSchema) gives a key
 * its data version, migrations and validator; legacy raw values (Wave 0 builds) load as data version 0. A value
 * that is bad JSON, a broken envelope, fails a migration or fails validation moves to PROGRESS_BACKUP_PREFIX + key,
 * loadProgress returns null (the caller uses its defaults) and diagnostics gets a line. A value from a newer build's
 * data version is returned as is, or ignored but left in place when it fails this build's validator.
 * Large progress (replays, megabytes) uses the same envelope in an IndexedDB blob store (saveLargeProgress, async),
 * opened on first use and falling back to memory.
 *
 * Diagnostics: the store is created before diagnostics, so log lines are buffered until setLogger() attaches a sink
 * (boot: `settings.setLogger(diagnostics.log)`).
 */
import type { SettingsStore } from '../contracts/app';
import {
  AssistLevel, AutoSwitch, CameraType, Difficulty, FormationId, KitSlot, PadFamily, QualityTier, SkillMove,
} from '../contracts/enums';
import { createDefaultSettings, SETTINGS_SCHEMA_VERSION, type ControlPlacement, type Settings } from '../contracts/settings';
import { T_PERF } from '../contracts/tuning';
import { CLUB_COUNT } from '../data/clubs';
import { createBlobStore, createSafeStorage, type BlobStore, type KeyValueStorage, type StorageOp } from './storage';

export { createDefaultSettings };

const LOCAL_TUNING = { // TUNING-CR (platform timing, not gameplay)
  /** Quiet time after the last settings change of a burst before it is written, ms. */
  saveDebounceMs: 300,
  /** Longest a pending settings write waits while changes keep coming (slider drag), ms. */
  saveMaxWaitMs: 1500,
  /** Log lines kept while no diagnostics sink is attached (oldest dropped). */
  maxBufferedNotes: 32,
  /** Characters of a corrupt value quoted in the diagnostics line. */
  corruptQuoteChars: 160,
} as const;

/**
 * Valid ranges of the stored settings (contracts/settings.ts documents most of them). Exported so settings screens
 * use the same bounds. Values outside are clamped on load and on every update.
 */
export const SETTINGS_LIMITS = {
  /** ControlPlacement.scale, size multiplier. */
  placementScaleMin: 0.7,
  placementScaleMax: 1.4,
  /** |ControlPlacement.dx| and |dy|, pt. A sanity bound only: the touch layer keeps controls on screen. */
  placementOffsetMax: 4096,
  /** Entries kept per free-form record (layout, gesture flags, remaps, hint counters, tutorial flags). */
  recordEntriesMax: 128,
  /** TouchSettings.spacing multiplier (the button cluster never packs tighter than 1). */
  spacingMin: 1,
  spacingMax: 2,
  /** TouchSettings.opacity. */
  opacityMin: 0.2,
  opacityMax: 1,
  /** TouchSettings.hintMatchesLeft, matches. */
  hintMatchesMax: 99,
  /** CameraSettings.height and zoom (slider steps). */
  cameraMin: 0,
  cameraMax: 20,
  /** MatchDefaults.halfMinutes, minutes (same bounds as modes/setup.ts). */
  halfMinutesMin: 2,
  halfMinutesMax: 10,
  /** AudioSettings volumes. */
  volumeMin: 0,
  volumeMax: 1,
  /** GraphicsSettings.resolutionScale when fixed (0 = automatic). */
  resolutionScaleMin: T_PERF.resScaleMin,
  resolutionScaleMax: T_PERF.resScaleMax,
  /** setPieceHintsSeen counters. */
  hintCountMax: 1000,
  /** PadSettings.remaps: slots per pad and largest raw button index (-1 = unbound). */
  remapLengthMax: 64,
  remapIndexMax: 255,
  /** Settings.nickname, characters (code points) after trimming. */
  nicknameMaxChars: 16,
} as const;

export const SETTINGS_KEY = 'dotkick.settings';
export const PROGRESS_PREFIX = 'dotkick.progress.';
/** Corrupt values are moved under this prefix (kept for bug reports, removed by reset() / clearProgress()). */
export const BACKUP_PREFIX = 'dotkick.backup.';
export const SETTINGS_BACKUP_KEY = BACKUP_PREFIX + 'settings';
export const PROGRESS_BACKUP_PREFIX = BACKUP_PREFIX + 'progress.';
/** Blob-store keys of large progress and of its corrupt backups. */
export const LARGE_PROGRESS_PREFIX = 'progress.';
export const LARGE_BACKUP_PREFIX = 'backup.progress.';

/** Diagnostics sink, same shape as Diagnostics.log. */
export type StorageLogFn = (kind: string, message: string, data?: unknown) => void;
/** Kind of every line this module logs. */
export const STORAGE_LOG_KIND = 'storage';

// ============================================================ helpers

type Rec = Record<string, unknown>;

const hasOwn = Object.prototype.hasOwnProperty;

function isPlainObject(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keys that could reach an object's prototype when copied. */
function safeKey(k: string): boolean {
  return k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
}

function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** JSON deep copy that returns undefined for values JSON cannot hold instead of throwing. */
function tryCloneJson(v: unknown): unknown {
  try {
    const text = JSON.stringify(v);
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return undefined;
  }
}

function enumValues(e: object): readonly number[] {
  return Object.values(e as Rec).filter((x): x is number => typeof x === 'number');
}

const ASSIST_VALUES = enumValues(AssistLevel);
const AUTOSWITCH_VALUES = enumValues(AutoSwitch);
const SKILL_VALUES = enumValues(SkillMove);
const PAD_FAMILY_VALUES = enumValues(PadFamily);
const CAMERA_VALUES = enumValues(CameraType);
const DIFFICULTY_VALUES = enumValues(Difficulty);
const FORMATION_VALUES = enumValues(FormationId);
const QUALITY_VALUES = enumValues(QualityTier);
/** A team's kit choice: home or away (the keeper kit is used automatically for keepers only). */
const TEAM_KIT_VALUES: readonly number[] = [KitSlot.HOME, KitSlot.AWAY];

/** Count of values replaced or clamped by the merge / validation pass. */
interface Repairs {
  n: number;
}

// ============================================================ merge + validation

function mergeValue(def: unknown, stored: unknown, fix: Repairs): unknown {
  if (Array.isArray(def)) {
    if (Array.isArray(stored)) return tryCloneJson(stored) ?? cloneJson(def);
    if (stored !== undefined) fix.n++;
    return cloneJson(def);
  }
  if (isPlainObject(def)) {
    if (!isPlainObject(stored)) {
      if (stored !== undefined) fix.n++;
      return cloneJson(def);
    }
    const keys = Object.keys(def);
    // An empty default object is a free-form record (layout, remaps, flags): copy it; validate() checks each entry.
    if (keys.length === 0) {
      const out: Rec = {};
      for (const k of Object.keys(stored)) {
        if (!safeKey(k)) {
          fix.n++;
          continue;
        }
        const v = tryCloneJson(stored[k]);
        if (v === undefined) fix.n++;
        else out[k] = v;
      }
      return out;
    }
    const out: Rec = {};
    for (const k of keys) out[k] = mergeValue(def[k], hasOwn.call(stored, k) ? stored[k] : undefined, fix);
    return out;
  }
  if (typeof def === 'number') {
    if (typeof stored === 'number' && Number.isFinite(stored)) return stored;
    if (stored !== undefined) fix.n++;
    return def;
  }
  if (typeof def === 'boolean') {
    if (typeof stored === 'boolean') return stored;
    if (stored !== undefined) fix.n++;
    return def;
  }
  if (typeof def === 'string') {
    if (typeof stored === 'string') return stored;
    if (stored !== undefined) fix.n++;
    return def;
  }
  return def;
}

function clampNum(v: number, min: number, max: number, fix: Repairs): number {
  if (v < min) {
    fix.n++;
    return min;
  }
  if (v > max) {
    fix.n++;
    return max;
  }
  return v;
}

function clampInt(v: number, min: number, max: number, fix: Repairs): number {
  const r = Math.round(v);
  if (r !== v) fix.n++;
  return clampNum(r, min, max, fix);
}

function oneOf(v: number, allowed: readonly number[], def: number, fix: Repairs): number {
  if (allowed.includes(v)) return v;
  fix.n++;
  return def;
}

function clubIndex(v: number, def: number, fix: Repairs): number {
  if (CLUB_COUNT <= 0) return v;
  if (Number.isInteger(v) && v >= 0 && v < CLUB_COUNT) return v;
  fix.n++;
  return def >= 0 && def < CLUB_COUNT ? def : 0;
}

function resolutionScale(v: number, fix: Repairs): number {
  const L = SETTINGS_LIMITS;
  if (v === 0) return 0;
  if (v < 0) {
    fix.n++;
    return 0;
  }
  return clampNum(v, L.resolutionScaleMin, L.resolutionScaleMax, fix);
}

function boolRecord(rec: Rec, fix: Repairs): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  let n = 0;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v !== 'boolean' || n >= SETTINGS_LIMITS.recordEntriesMax) {
      fix.n++;
      continue;
    }
    out[k] = v;
    n++;
  }
  return out;
}

function countRecord(rec: Rec, max: number, fix: Repairs): Record<string, number> {
  const out: Record<string, number> = {};
  let n = 0;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || n >= SETTINGS_LIMITS.recordEntriesMax) {
      fix.n++;
      continue;
    }
    out[k] = clampInt(v, 0, max, fix);
    n++;
  }
  return out;
}

function finiteField(o: Rec, k: string): number | null {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function layoutRecord(rec: Rec, fix: Repairs): Record<string, ControlPlacement> {
  const L = SETTINGS_LIMITS;
  const out: Record<string, ControlPlacement> = {};
  let n = 0;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (!isPlainObject(v) || n >= L.recordEntriesMax) {
      fix.n++;
      continue;
    }
    const dx = finiteField(v, 'dx');
    const dy = finiteField(v, 'dy');
    if (dx === null || dy === null) {
      fix.n++;
      continue;
    }
    let scale = finiteField(v, 'scale');
    if (scale === null) {
      fix.n++;
      scale = 1;
    }
    out[k] = {
      dx: clampNum(dx, -L.placementOffsetMax, L.placementOffsetMax, fix),
      dy: clampNum(dy, -L.placementOffsetMax, L.placementOffsetMax, fix),
      scale: clampNum(scale, L.placementScaleMin, L.placementScaleMax, fix),
    };
    n++;
  }
  return out;
}

function remapRecord(rec: Rec, fix: Repairs): Record<string, number[]> {
  const L = SETTINGS_LIMITS;
  const out: Record<string, number[]> = {};
  let n = 0;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (!Array.isArray(v) || n >= L.recordEntriesMax) {
      fix.n++;
      continue;
    }
    if (v.length > L.remapLengthMax) fix.n++;
    const len = Math.min(v.length, L.remapLengthMax);
    const list: number[] = [];
    for (let i = 0; i < len; i++) {
      const b = v[i] as unknown;
      if (typeof b === 'number' && Number.isInteger(b) && b >= -1 && b <= L.remapIndexMax) list.push(b);
      else {
        fix.n++;
        list.push(-1);
      }
    }
    out[k] = list;
    n++;
  }
  return out;
}

/** Code points never kept in a nickname: C0/C1 controls, line separators, bidi overrides and isolates, BOM. */
function bannedCodePoint(c: number): boolean {
  return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ||
    (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
}

function cleanNickname(v: string, def: string, fix: Repairs): string {
  let kept = '';
  for (const ch of v) if (!bannedCodePoint(ch.codePointAt(0)!)) kept += ch;
  const chars = Array.from(kept.trim());
  const out = (chars.length > SETTINGS_LIMITS.nicknameMaxChars ? chars.slice(0, SETTINGS_LIMITS.nicknameMaxChars) : chars).join('').trim();
  const res = out === '' ? def : out;
  if (res !== v) fix.n++;
  return res;
}

/** Clamp every field of a merged Settings object to its valid range, in place. */
function validate(s: Settings, d: Settings, fix: Repairs): void {
  const L = SETTINGS_LIMITS;
  const c = s.controls;
  c.assist = oneOf(c.assist, ASSIST_VALUES, d.controls.assist, fix);
  c.autoSwitch = oneOf(c.autoSwitch, AUTOSWITCH_VALUES, d.controls.autoSwitch, fix);
  const t = c.touch;
  const dt = d.controls.touch;
  t.layout = layoutRecord(t.layout as Rec, fix);
  t.spacing = clampNum(t.spacing, L.spacingMin, L.spacingMax, fix);
  t.opacity = clampNum(t.opacity, L.opacityMin, L.opacityMax, fix);
  t.gestureEnabled = boolRecord(t.gestureEnabled as Rec, fix);
  t.skillTap = oneOf(t.skillTap, SKILL_VALUES, dt.skillTap, fix);
  t.skillUp = oneOf(t.skillUp, SKILL_VALUES, dt.skillUp, fix);
  t.skillRight = oneOf(t.skillRight, SKILL_VALUES, dt.skillRight, fix);
  t.hintMatchesLeft = clampInt(t.hintMatchesLeft, 0, L.hintMatchesMax, fix);
  c.pad.familyOverride = oneOf(c.pad.familyOverride, PAD_FAMILY_VALUES, d.controls.pad.familyOverride, fix);
  c.pad.remaps = remapRecord(c.pad.remaps as Rec, fix);

  s.camera.type = oneOf(s.camera.type, CAMERA_VALUES, d.camera.type, fix);
  s.camera.height = clampNum(s.camera.height, L.cameraMin, L.cameraMax, fix);
  s.camera.zoom = clampNum(s.camera.zoom, L.cameraMin, L.cameraMax, fix);

  const m = s.match;
  m.halfMinutes = clampInt(m.halfMinutes, L.halfMinutesMin, L.halfMinutesMax, fix);
  m.difficulty = oneOf(m.difficulty, DIFFICULTY_VALUES, d.match.difficulty, fix);
  m.homeClub = clubIndex(m.homeClub, d.match.homeClub, fix);
  m.awayClub = clubIndex(m.awayClub, d.match.awayClub, fix);
  m.homeKit = oneOf(m.homeKit, TEAM_KIT_VALUES, d.match.homeKit, fix);
  m.awayKit = oneOf(m.awayKit, TEAM_KIT_VALUES, d.match.awayKit, fix);
  m.homeFormation = oneOf(m.homeFormation, FORMATION_VALUES, d.match.homeFormation, fix);

  const a = s.audio;
  a.master = clampNum(a.master, L.volumeMin, L.volumeMax, fix);
  a.crowd = clampNum(a.crowd, L.volumeMin, L.volumeMax, fix);
  a.effects = clampNum(a.effects, L.volumeMin, L.volumeMax, fix);
  a.menus = clampNum(a.menus, L.volumeMin, L.volumeMax, fix);

  s.graphics.tier = oneOf(s.graphics.tier, QUALITY_VALUES, d.graphics.tier, fix);
  s.graphics.resolutionScale = resolutionScale(s.graphics.resolutionScale, fix);

  s.setPieceHintsSeen = countRecord(s.setPieceHintsSeen as Rec, L.hintCountMax, fix);
  s.tutorialDone = boolRecord(s.tutorialDone as Rec, fix);
  s.nickname = cleanNickname(s.nickname, d.nickname, fix);
}

/** Merge + validate; returns the settings and the number of values that had to be replaced or clamped. */
function sanitize(stored: unknown, defaults: Settings): { settings: Settings; repairs: number } {
  const fix: Repairs = { n: 0 };
  const settings = mergeValue(defaults, stored, fix) as Settings;
  validate(settings, defaults, fix);
  return { settings, repairs: fix.n };
}

/**
 * Merge a stored blob over the defaults: every default key exists with the default's type, unknown keys are
 * dropped, and every value is clamped to its range (SETTINGS_LIMITS, enums, club indices). Pure.
 */
export function mergeWithDefaults(stored: unknown, defaults: Settings = createDefaultSettings()): Settings {
  return sanitize(stored, defaults).settings;
}

/** Number of values mergeWithDefaults would replace or clamp (0 for a clean blob). Pure. */
export function countRepairs(stored: unknown): number {
  return sanitize(stored, createDefaultSettings()).repairs;
}

// ============================================================ migrations

/** Upgrades a raw settings blob from schema v to v + 1 (registered as SETTINGS_MIGRATIONS[v]). */
export type SettingsMigration = (raw: Record<string, unknown>) => Record<string, unknown>;

/** Leniently convert legacy representations where the default has another type: 0/1 or "true"/"false" to booleans,
 * numeric strings to numbers. Walks only the keys the default tree knows; everything else is kept as is. */
function coerceLegacy(def: unknown, raw: unknown): unknown {
  if (isPlainObject(def) && Object.keys(def).length > 0) {
    if (!isPlainObject(raw)) return raw;
    const out: Rec = {};
    for (const k of Object.keys(raw)) {
      if (!safeKey(k)) continue;
      out[k] = hasOwn.call(def, k) ? coerceLegacy(def[k], raw[k]) : raw[k];
    }
    return out;
  }
  if (typeof def === 'boolean') return coerceBool(raw);
  if (typeof def === 'number') return coerceNumber(raw);
  return raw;
}

function coerceBool(v: unknown): unknown {
  if (v === 0 || v === 1) return v === 1;
  if (v === 'true' || v === 'false') return v === 'true';
  return v;
}

function coerceNumber(v: unknown): unknown {
  if (typeof v !== 'string' || v.trim() === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function coerceRecordValues(rec: unknown, coerce: (v: unknown) => unknown): unknown {
  if (!isPlainObject(rec)) return rec;
  const out: Rec = {};
  for (const k of Object.keys(rec)) if (safeKey(k)) out[k] = coerce(rec[k]);
  return out;
}

/**
 * v0 -> v1. v0 is any blob written before the `schema` field existed: the same tree, but booleans may be stored as
 * 0/1 or "true"/"false" and numbers as numeric strings (raw form values). Coerces those and stamps schema 1; the
 * merge that follows fills new keys and drops anything still invalid.
 */
export function migrateSettingsV0(raw: Record<string, unknown>): Record<string, unknown> {
  const out = coerceLegacy(createDefaultSettings(), raw) as Rec;
  if (isPlainObject(out.controls) && isPlainObject(out.controls.touch)) {
    out.controls.touch.gestureEnabled = coerceRecordValues(out.controls.touch.gestureEnabled, coerceBool);
  }
  out.tutorialDone = coerceRecordValues(out.tutorialDone, coerceBool);
  out.setPieceHintsSeen = coerceRecordValues(out.setPieceHintsSeen, coerceNumber);
  out.schema = 1;
  return out;
}

/**
 * Migration chain. Add `SETTINGS_MIGRATIONS[n] = (raw) => ...` when bumping SETTINGS_SCHEMA_VERSION from n to n + 1.
 * Entry 0 upgrades pre-versioned blobs (no `schema` field). A missing entry is the identity (the merge over the
 * defaults adds new keys by itself).
 */
export const SETTINGS_MIGRATIONS: Record<number, SettingsMigration> = {
  0: migrateSettingsV0,
};

export type SettingsLoadStatus = 'missing' | 'ok' | 'migrated' | 'newer' | 'corrupt';

export interface SettingsDecodeResult {
  settings: Settings;
  status: SettingsLoadStatus;
  /** Schema the stored blob declared (0 when absent or unreadable). */
  fromSchema: number;
  /** Values replaced or clamped by the merge (0 for corrupt and missing). */
  repairs: number;
  /** Why the blob is corrupt, else ''. */
  reason: string;
}

function storedSchema(blob: Rec): number {
  const v = blob.schema;
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function defaultsAt(target: number): Settings {
  const d = createDefaultSettings();
  d.schema = target;
  return d;
}

/**
 * Parse, migrate, merge and validate stored settings text. Never throws. `text` null = nothing stored. Pure.
 */
export function decodeSettings(
  text: string | null,
  migrations: Record<number, SettingsMigration> = SETTINGS_MIGRATIONS,
  target: number = SETTINGS_SCHEMA_VERSION,
): SettingsDecodeResult {
  if (text === null) return { settings: defaultsAt(target), status: 'missing', fromSchema: 0, repairs: 0, reason: '' };
  const corrupt = (reason: string, fromSchema = 0): SettingsDecodeResult =>
    ({ settings: defaultsAt(target), status: 'corrupt', fromSchema, repairs: 0, reason });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return corrupt('bad JSON');
  }
  if (!isPlainObject(raw)) return corrupt('not an object');
  const from = storedSchema(raw);
  let blob: Rec = { ...raw };
  for (let v = from; v < target; v++) {
    const m = migrations[v];
    if (!m) continue;
    try {
      const next = m(blob);
      if (!isPlainObject(next)) return corrupt(`migration ${v} returned no object`, from);
      blob = next;
    } catch {
      return corrupt(`migration ${v} failed`, from);
    }
  }
  const { settings, repairs } = sanitize(blob, createDefaultSettings());
  settings.schema = target;
  const status: SettingsLoadStatus = from > target ? 'newer' : from < target ? 'migrated' : 'ok';
  return { settings, status, fromSchema: from, repairs, reason: '' };
}

/**
 * Bring a raw stored value to the current schema and merge it over the defaults. Unknown or corrupt input yields
 * the defaults. A blob from a newer schema keeps every compatible field. Pure.
 */
export function migrateSettings(
  raw: unknown,
  migrations: Record<number, SettingsMigration> = SETTINGS_MIGRATIONS,
  target: number = SETTINGS_SCHEMA_VERSION,
): Settings {
  if (!isPlainObject(raw)) return defaultsAt(target);
  let text: string;
  try {
    text = JSON.stringify(raw);
  } catch {
    return defaultsAt(target);
  }
  return decodeSettings(text, migrations, target).settings;
}

// ============================================================ progress envelope

/** Envelope marker key and format of stored progress values. */
export const PROGRESS_MARK = '$dotkick';
export const PROGRESS_FORMAT = 1;

/** Versioning for one progress key. */
export interface ProgressSchema {
  /** Data version written with every save (integer 1..PROGRESS_VERSION_MAX). */
  version: number;
  /** migrations[v] upgrades the data from version v to v + 1 (v = 0: legacy raw values). Missing = identity. */
  migrations?: Record<number, (data: unknown) => unknown>;
  /** True when the (migrated) data has the expected shape; false moves it to the backup key. Also checked on save. */
  validate?: (data: unknown) => boolean;
}

export const PROGRESS_VERSION_MAX = 10_000;
const DEFAULT_PROGRESS_SCHEMA: ProgressSchema = { version: 1 };

/** Registry read at call time by every store created without `progressSchemas`. Use registerProgressSchema. */
export const PROGRESS_SCHEMAS: Record<string, ProgressSchema> = {};

/** Give a progress key (e.g. 'cup', 'records') its data version, migrations and validator. */
export function registerProgressSchema(key: string, schema: ProgressSchema): void {
  const v = schema.version;
  if (!Number.isInteger(v) || v < 1 || v > PROGRESS_VERSION_MAX) {
    throw new RangeError(`progress schema "${key}": version must be an integer 1..${PROGRESS_VERSION_MAX}`);
  }
  PROGRESS_SCHEMAS[key] = schema;
}

/** Envelope text for `value` at data `version`, or null when the value cannot be serialised. Pure. */
export function encodeProgress(value: unknown, version: number): string | null {
  try {
    if (JSON.stringify(value) === undefined) return null;
    return JSON.stringify({ [PROGRESS_MARK]: PROGRESS_FORMAT, v: version, data: value });
  } catch {
    return null;
  }
}

export type ProgressDecodeResult =
  | { status: 'ok' | 'migrated' | 'newer'; data: unknown; version: number }
  | { status: 'empty' }
  /** Saved by a newer build in a data version this build cannot validate: ignored and left in place. */
  | { status: 'unreadable'; version: number }
  | { status: 'corrupt'; reason: string };

/** Parse a stored progress value (envelope or legacy raw JSON), migrate and validate it. Never throws. Pure. */
export function decodeProgress(text: string, schema: ProgressSchema = DEFAULT_PROGRESS_SCHEMA): ProgressDecodeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'corrupt', reason: 'bad JSON' };
  }
  let version = 0;
  let data: unknown = parsed;
  if (isPlainObject(parsed) && hasOwn.call(parsed, PROGRESS_MARK)) {
    const v = parsed.v;
    if (typeof v !== 'number' || !Number.isFinite(v) || !hasOwn.call(parsed, 'data')) {
      return { status: 'corrupt', reason: 'bad envelope' };
    }
    version = Math.max(0, Math.floor(v));
    data = parsed.data;
  }
  if (data === null || data === undefined) return { status: 'empty' };
  const target = Math.min(PROGRESS_VERSION_MAX, Math.max(1, Math.floor(schema.version)));
  const status: 'ok' | 'migrated' | 'newer' = version > target ? 'newer' : version < target ? 'migrated' : 'ok';
  if (status === 'migrated') {
    for (let v = version; v < target; v++) {
      const m = schema.migrations ? schema.migrations[v] : undefined;
      if (!m) continue;
      try {
        data = m(data);
      } catch {
        return { status: 'corrupt', reason: `migration ${v} failed` };
      }
    }
    if (data === null || data === undefined) return { status: 'corrupt', reason: 'migration returned nothing' };
    version = target;
  }
  if (schema.validate) {
    let ok: boolean;
    try {
      ok = schema.validate(data) === true;
    } catch {
      ok = false;
    }
    if (!ok) return status === 'newer' ? { status: 'unreadable', version } : { status: 'corrupt', reason: 'failed validation' };
  }
  return { status, data, version };
}

// ============================================================ store

/** Timer hooks (tests inject a manual clock). */
export interface StoreTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Event targets for the flush-on-hide listeners. */
export interface LifecycleTargets {
  /** Receives 'pagehide'. */
  window: EventTarget | null;
  /** Receives 'visibilitychange'; flushes when visibilityState is 'hidden'. */
  document: (EventTarget & { readonly visibilityState?: string }) | null;
}

export interface SettingsStoreOptions {
  migrations?: Record<number, SettingsMigration>;
  /** Target schema (tests). Defaults to SETTINGS_SCHEMA_VERSION. */
  schemaVersion?: number;
  /** Quiet time before a burst of updates is written, ms (0 = write every update at once). */
  debounceMs?: number;
  /** Longest a pending write waits during a continuous burst, ms. */
  maxWaitMs?: number;
  timers?: StoreTimers;
  /** Flush-on-hide targets; default the global window and document when present. null disables. */
  lifecycle?: LifecycleTargets | null;
  /** Diagnostics sink (or attach later with setLogger). */
  log?: StorageLogFn;
  /** Progress versioning; default the shared PROGRESS_SCHEMAS registry (read at call time). */
  progressSchemas?: Record<string, ProgressSchema>;
  /** Store for large progress; default an IndexedDB blob store created on first use. */
  blobs?: BlobStore;
}

/** The SettingsStore contract plus PLT-03 extras (flush, logger, progress listing, large progress). */
export interface SettingsStoreImpl extends SettingsStore {
  /** Write a pending debounced change now. Returns false when it could only be kept in memory. */
  flush(): boolean;
  /** True while a debounced write is waiting. */
  readonly pending: boolean;
  /** Corrupt values moved to a backup key since creation (settings and progress). */
  readonly recoveries: number;
  /** Attach the diagnostics sink (null detaches). Lines logged before it was attached are replayed once. */
  setLogger(fn: StorageLogFn | null): void;
  /** Saved progress keys (without the prefix), sorted. */
  progressKeys(): string[];
  removeProgress(key: string): void;
  /** Versioned save to the IndexedDB blob store (replays). Resolves false when kept in memory only. */
  saveLargeProgress<T>(key: string, value: T): Promise<boolean>;
  loadLargeProgress<T>(key: string): Promise<T | null>;
  removeLargeProgress(key: string): Promise<void>;
  largeProgressKeys(): Promise<string[]>;
  /** Remove every large progress value and backup (clearProgress starts this too). */
  clearLargeProgress(): Promise<void>;
  /** One-line storage summary for the diagnostics report. */
  describe(): string;
  /** Flush, cancel the timer and remove the lifecycle listeners. Later updates are written at once. */
  dispose(): void;
}

const defaultTimers: StoreTimers = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function defaultLifecycle(): LifecycleTargets | null {
  const win = typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
  const doc = typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? document : null;
  return win || doc ? { window: win, document: doc } : null;
}

function quote(text: string): string {
  const n = LOCAL_TUNING.corruptQuoteChars;
  return text.length > n ? text.slice(0, n) + '...' : text;
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'object' && err !== null && 'name' in err) return String((err as { name: unknown }).name);
  return String(err);
}

/** Create the settings store. Storage defaults to safe localStorage with a memory fallback. */
export function createSettingsStore(
  storage: KeyValueStorage = createSafeStorage(),
  opts: SettingsStoreOptions = {},
): SettingsStoreImpl {
  const target = opts.schemaVersion ?? SETTINGS_SCHEMA_VERSION;
  const migrations = opts.migrations ?? SETTINGS_MIGRATIONS;
  const debounceMs = Math.max(0, opts.debounceMs ?? LOCAL_TUNING.saveDebounceMs);
  const maxWaitMs = Math.max(debounceMs, opts.maxWaitMs ?? LOCAL_TUNING.saveMaxWaitMs);
  const timers = opts.timers ?? defaultTimers;
  const schemas = opts.progressSchemas ?? PROGRESS_SCHEMAS;
  const listeners = new Set<(s: Readonly<Settings>) => void>();

  // ---- diagnostics notes (buffered until a sink is attached)
  let logger: StorageLogFn | null = opts.log ?? null;
  const buffered: [string, unknown][] = [];
  function note(message: string, data?: unknown): void {
    if (logger) {
      try {
        logger(STORAGE_LOG_KIND, message, data);
      } catch {
        /* a broken sink must not break storage */
      }
      return;
    }
    if (buffered.length >= LOCAL_TUNING.maxBufferedNotes) buffered.shift();
    buffered.push([message, data]);
  }

  let recoveries = 0;
  let writeFailed = false;
  let disposed = false;

  // ---- load
  const storedText = storage.get(SETTINGS_KEY);
  const loaded = decodeSettings(storedText, migrations, target);
  let current: Settings = loaded.settings;
  let currentJson = JSON.stringify(current);

  if (!storage.persistent) note('storage unavailable or full: settings and progress are kept in memory for this session');
  if (loaded.status === 'corrupt') {
    const text = storedText ?? '';
    storage.set(SETTINGS_BACKUP_KEY, text);
    recoveries++;
    note(`settings corrupt (${loaded.reason}): moved to ${SETTINGS_BACKUP_KEY}, using defaults`, quote(text));
  } else if (loaded.status === 'migrated') {
    note(`settings migrated from schema ${loaded.fromSchema} to ${target}`);
  } else if (loaded.status === 'newer') {
    note(`settings from newer schema ${loaded.fromSchema} read as schema ${target}; left unchanged until edited`);
  }
  if (loaded.repairs > 0) note(`settings: ${loaded.repairs} invalid value(s) replaced or clamped`);

  // ---- debounced writes
  let timer: unknown = null;
  let dirty = false;
  let windowStart = 0;
  let lastChangeAt = 0;

  function writeNow(): boolean {
    dirty = false;
    let ok: boolean;
    try {
      ok = storage.set(SETTINGS_KEY, currentJson);
    } catch {
      ok = false;
    }
    if (!ok && !writeFailed && storage.persistent) note('settings could not be saved (storage full or blocked): kept in memory');
    if (ok && writeFailed) note('settings saved again');
    writeFailed = !ok;
    return ok;
  }

  function arm(ms: number): void {
    timer = timers.setTimeout(onTimer, ms);
  }

  function onTimer(): void {
    timer = null;
    if (!dirty || disposed) return;
    const t = timers.now();
    const wait = Math.min(lastChangeAt + debounceMs - t, windowStart + maxWaitMs - t);
    if (wait > 0) {
      arm(wait);
      return;
    }
    writeNow();
    windowStart = t;
    arm(debounceMs);
  }

  function requestWrite(): void {
    if (debounceMs <= 0 || disposed) {
      writeNow();
      return;
    }
    const t = timers.now();
    if (timer === null) {
      // Leading edge: idle, so write at once and open a coalescing window.
      writeNow();
      windowStart = t;
      arm(debounceMs);
      return;
    }
    dirty = true;
    lastChangeAt = t;
  }

  function flush(): boolean {
    if (!dirty) return !writeFailed;
    return writeNow();
  }

  // Write back a migrated, repaired or recovered blob at once (a newer schema's blob is left alone).
  if (loaded.status !== 'missing' && loaded.status !== 'newer' && storedText !== currentJson) requestWrite();

  // ---- lifecycle: never lose a pending write when the page goes away
  const lifecycle = opts.lifecycle === undefined ? defaultLifecycle() : opts.lifecycle;
  const onPageHide = (): void => {
    flush();
  };
  const onVisibility = (): void => {
    const doc = lifecycle ? lifecycle.document : null;
    if (!doc || doc.visibilityState === 'hidden') flush();
  };
  if (lifecycle) {
    lifecycle.window?.addEventListener('pagehide', onPageHide);
    lifecycle.document?.addEventListener('visibilitychange', onVisibility);
  }

  function notify(): void {
    for (const fn of [...listeners]) {
      try {
        fn(current);
      } catch {
        /* a broken listener must not break settings */
      }
    }
  }

  // ---- progress
  function schemaFor(key: string): ProgressSchema {
    return hasOwn.call(schemas, key) ? schemas[key]! : DEFAULT_PROGRESS_SCHEMA;
  }

  function encodeFor(key: string, value: unknown): string | null {
    const schema = schemaFor(key);
    if (schema.validate) {
      let ok: boolean;
      try {
        ok = schema.validate(value) === true;
      } catch {
        ok = false;
      }
      if (!ok) {
        note(`progress "${key}" failed validation: not saved`);
        return null;
      }
    }
    const text = encodeProgress(value, schema.version);
    if (text === null) note(`progress "${key}" is not serialisable: not saved`);
    return text;
  }

  let blobStore: BlobStore | null = opts.blobs ?? null;
  function blobs(): BlobStore {
    if (!blobStore) {
      blobStore = createBlobStore({
        onError: (op: StorageOp, key: string, err: unknown) => note(`large progress ${op} failed${key ? ` (${key})` : ''}: ${describeErr(err)}`),
      });
    }
    return blobStore;
  }

  const store: SettingsStoreImpl = {
    get: () => current,
    update(mut) {
      const next = cloneJson(current);
      mut(next);
      const { settings } = sanitize(next, createDefaultSettings());
      settings.schema = target;
      const json = JSON.stringify(settings);
      if (json === currentJson) return;
      current = settings;
      currentJson = json;
      requestWrite();
      notify();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    reset() {
      current = defaultsAt(target);
      currentJson = JSON.stringify(current);
      storage.remove(SETTINGS_BACKUP_KEY);
      writeNow();
      notify();
    },
    get persistent() {
      return storage.persistent && !writeFailed;
    },
    loadProgress<T>(key: string): T | null {
      const k = PROGRESS_PREFIX + key;
      const text = storage.get(k);
      if (text === null) return null;
      const schema = schemaFor(key);
      const r = decodeProgress(text, schema);
      if (r.status === 'corrupt') {
        storage.set(PROGRESS_BACKUP_PREFIX + key, text);
        storage.remove(k);
        recoveries++;
        note(`progress "${key}" corrupt (${r.reason}): moved to ${PROGRESS_BACKUP_PREFIX + key}`, quote(text));
        return null;
      }
      if (r.status === 'empty') return null;
      if (r.status === 'unreadable') {
        note(`progress "${key}" was saved by a newer version (data v${r.version}): ignored, left in place`);
        return null;
      }
      if (r.status === 'migrated') {
        const enc = encodeProgress(r.data, r.version);
        if (enc !== null) storage.set(k, enc);
      }
      return r.data as T;
    },
    saveProgress<T>(key: string, value: T): void {
      const k = PROGRESS_PREFIX + key;
      if (value === null || value === undefined) {
        storage.remove(k);
        return;
      }
      const text = encodeFor(key, value);
      if (text === null) return;
      let ok: boolean;
      try {
        ok = storage.set(k, text);
      } catch {
        ok = false;
      }
      if (!ok && storage.persistent) note(`progress "${key}" could not be saved (storage full or blocked): kept in memory`, { bytes: text.length });
    },
    clearProgress() {
      for (const k of storage.keys(PROGRESS_PREFIX)) storage.remove(k);
      for (const k of storage.keys(PROGRESS_BACKUP_PREFIX)) storage.remove(k);
      store.clearLargeProgress().catch(() => undefined);
    },
    flush,
    get pending() {
      return dirty;
    },
    get recoveries() {
      return recoveries;
    },
    setLogger(fn) {
      logger = fn;
      if (!fn) return;
      const lines = buffered.splice(0, buffered.length);
      for (const [message, data] of lines) note(message, data);
    },
    progressKeys() {
      const n = PROGRESS_PREFIX.length;
      return storage.keys(PROGRESS_PREFIX).map((k) => k.slice(n)).sort();
    },
    removeProgress(key) {
      storage.remove(PROGRESS_PREFIX + key);
    },
    async saveLargeProgress<T>(key: string, value: T): Promise<boolean> {
      const b = blobs();
      if (value === null || value === undefined) {
        await b.remove(LARGE_PROGRESS_PREFIX + key);
        return b.persistent;
      }
      const text = encodeFor(key, value);
      if (text === null) return false;
      const ok = await b.set(LARGE_PROGRESS_PREFIX + key, text);
      if (!ok && b.backend !== 'memory') note(`large progress "${key}" kept in memory only`, { bytes: text.length });
      return ok;
    },
    async loadLargeProgress<T>(key: string): Promise<T | null> {
      const b = blobs();
      const k = LARGE_PROGRESS_PREFIX + key;
      const text = await b.get(k);
      if (text === null) return null;
      const r = decodeProgress(text, schemaFor(key));
      if (r.status === 'corrupt') {
        const backup = b.set(LARGE_BACKUP_PREFIX + key, text);
        const removal = b.remove(k);
        recoveries++;
        note(`large progress "${key}" corrupt (${r.reason}): moved to ${LARGE_BACKUP_PREFIX + key}`, quote(text));
        await Promise.all([backup, removal]);
        return null;
      }
      if (r.status === 'empty') return null;
      if (r.status === 'unreadable') {
        note(`large progress "${key}" was saved by a newer version (data v${r.version}): ignored, left in place`);
        return null;
      }
      if (r.status === 'migrated') {
        const enc = encodeProgress(r.data, r.version);
        if (enc !== null) await b.set(k, enc);
      }
      return r.data as T;
    },
    async removeLargeProgress(key: string): Promise<void> {
      await blobs().remove(LARGE_PROGRESS_PREFIX + key);
    },
    async largeProgressKeys(): Promise<string[]> {
      const n = LARGE_PROGRESS_PREFIX.length;
      return (await blobs().keys(LARGE_PROGRESS_PREFIX)).map((k) => k.slice(n));
    },
    async clearLargeProgress(): Promise<void> {
      const b = blobs();
      const a = b.removePrefix(LARGE_PROGRESS_PREFIX);
      const c = b.removePrefix(LARGE_BACKUP_PREFIX);
      await Promise.all([a, c]);
    },
    describe() {
      const mode = !storage.persistent ? 'memory only' : writeFailed ? 'localStorage (last write failed)' : 'localStorage';
      const large = blobStore ? blobStore.backend : 'unopened';
      return `${mode}; schema ${target}; progress keys ${storage.keys(PROGRESS_PREFIX).length}; recoveries ${recoveries}; ` +
        `pending write ${dirty ? 'yes' : 'no'}; large progress ${large}`;
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      if (timer !== null) {
        timers.clearTimeout(timer);
        timer = null;
      }
      if (lifecycle) {
        lifecycle.window?.removeEventListener('pagehide', onPageHide);
        lifecycle.document?.removeEventListener('visibilitychange', onVisibility);
      }
    },
  };
  return store;
}
