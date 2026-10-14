/**
 * [UIX-06 / UIX-07 / UIX-12] Helpers shared by the HUD parts (helper file of the UIX-06/07/12 assignments).
 *
 *  - bindLargerHud(ctx, el, onChange?): toggles `.hud-lg` on a part's root when settings.accessibility.largerHud
 *    changes (one class write per change, never per frame). Parts size themselves with `--hs` (1 or HUD_LARGE_SCALE).
 *  - Radar preference (radarEnabled / setRadarEnabled / onRadarPref): shown or hidden, stored with
 *    SettingsStore.saveProgress(RADAR_PREF_KEY) until Settings gets a field for it (contract change request), with
 *    listeners so the radar and the player-info panels follow at once. The in-match touch layer sits above the HUD
 *    (index.html: #touch z 2 over #hud z 1), so the toggle lives in menus (settings / pause), not under a tap.
 *  - Control devices: pickDevice() (pure) and humanDevice(ctx, human) tell which device a human plays with (touch, a
 *    pad and its family, or the keyboard): the hints, the tutorial and the coach card draw that device's glyphs.
 *  - minuteLabel(): the displayed match minute ("23'", "45+2'") used by toasts.
 *
 * Nothing here allocates per frame; DOM is touched only from callbacks fired on settings / preference changes.
 */
import type { AppContext, DeviceInfo, SettingsStore } from '../../contracts/app';
import { PadFamily, Period } from '../../contracts/enums';
import type { Settings } from '../../contracts/settings';
import { effectiveFamily } from '../../input/pad/glyphs';

/** Scale of every HUD part when settings.accessibility.largerHud is on. */
export const HUD_LARGE_SCALE = 1.25;

/** CSS shared by every part: the size variable. Injected by each part (injectStyle dedupes by id). */
export const HUD_SHARED_CSS = `
.hud-part { --hs: 1; }
.hud-part.hud-lg { --hs: ${HUD_LARGE_SCALE}; }
`;

/** Toggle `.hud-lg` on `el` whenever settings.accessibility.largerHud changes. Returns the unsubscribe. */
export function bindLargerHud(ctx: AppContext, el: HTMLElement, onChange?: (large: boolean) => void): () => void {
  let cur: boolean | null = null;
  const apply = (s: Readonly<Settings>): void => {
    const v = !!s.accessibility?.largerHud;
    if (v === cur) return;
    cur = v;
    el.classList.toggle('hud-lg', v);
    onChange?.(v);
  };
  try {
    apply(ctx.settings.get());
    return ctx.settings.subscribe(apply);
  } catch {
    return () => undefined;
  }
}

// ============================================================ radar preference

/** Progress-store key of the radar preference ({ on: boolean }). */
export const RADAR_PREF_KEY = 'hud.radar';

type RadarListener = (on: boolean) => void;
const radarListeners: RadarListener[] = [];

/** True unless the player turned the radar off. */
export function radarEnabled(settings: SettingsStore | null | undefined): boolean {
  if (!settings) return true;
  try {
    const v = settings.loadProgress<{ on?: unknown }>(RADAR_PREF_KEY);
    return !(v && typeof v === 'object' && v.on === false);
  } catch {
    return true;
  }
}

/** Show or hide the radar (persisted) and notify the HUD parts at once. Menus call this (settings / pause). */
export function setRadarEnabled(settings: SettingsStore | null | undefined, on: boolean): void {
  try {
    settings?.saveProgress(RADAR_PREF_KEY, { on });
  } catch {
    /* storage blocked: the change still applies for this session */
  }
  const list = radarListeners.slice();
  for (const fn of list) {
    try {
      fn(on);
    } catch {
      /* one broken listener never blocks the others */
    }
  }
}

/** Subscribe to radar preference changes. Returns the unsubscribe. */
export function onRadarPref(fn: RadarListener): () => void {
  radarListeners.push(fn);
  return () => {
    const i = radarListeners.indexOf(fn);
    if (i >= 0) radarListeners.splice(i, 1);
  };
}

// ============================================================ control devices

export type ControlDevice = 'touch' | 'pad' | 'keyboard';

export interface DeviceSpec {
  kind: ControlDevice;
  /** Pad family for glyphs (GENERIC when not a pad). */
  family: PadFamily;
}

/** Wildcard binding id (app/localInput.ts ANY_DEVICE): also binds devices that appear later. */
const ANY = '*';

function specOf(d: DeviceInfo, override: PadFamily): DeviceSpec {
  return { kind: d.kind, family: d.kind === 'pad' ? effectiveFamily(d.family, override) : PadFamily.GENERIC };
}

/**
 * The device a human plays with. `ids` are the human's bound device ids ('*' binds any device), `last` the most
 * recently used device id. Preference: the last active device when bound; else the first connected bound pad /
 * keyboard / touch in list order; else, with no binding information, the last active device; else touch on a touch
 * platform, keyboard otherwise. Pure.
 */
export function pickDevice(
  list: readonly DeviceInfo[],
  ids: readonly string[] | null,
  last: string | null,
  isTouch: boolean,
  override: PadFamily = PadFamily.AUTO,
): DeviceSpec {
  const any = ids === null || ids.includes(ANY);
  const bound = (d: DeviceInfo): boolean => any || (ids !== null && ids.includes(d.id));
  if (last) {
    for (const d of list) if (d.id === last && bound(d)) return specOf(d, override);
  }
  if (ids !== null) {
    for (const d of list) if (d.connected && ids.includes(d.id)) return specOf(d, override);
  }
  if (any && last === null) {
    for (const d of list) if (d.connected && d.kind === 'pad') return specOf(d, override);
  }
  return { kind: isTouch ? 'touch' : 'keyboard', family: PadFamily.GENERIC };
}

/** The device `human` plays with in the current match (or, outside a match, the last used device). */
export function humanDevice(ctx: AppContext, human: number): DeviceSpec {
  const list = safe(() => ctx.devices.list(), [] as DeviceInfo[]);
  const last = safe(() => ctx.devices.lastActive(), null as string | null);
  const ids = safe((): readonly string[] | null => {
    const setup = ctx.session.getSetup();
    if (!setup) return null;
    const b = setup.bindings.find((x) => x.human === human);
    return b ? b.deviceIds : [];
  }, null);
  const override = safe(() => ctx.settings.get().controls.pad.familyOverride, PadFamily.AUTO);
  const isTouch = safe(() => !!ctx.platform.isTouch, false);
  return pickDevice(list, ids, last, isTouch, override);
}

/** fn() or the fallback when it throws (context services are optional in tests and broken states). */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** True when a touch device is bound to any human of the current match. */
export function touchBoundToMatch(ctx: AppContext): boolean {
  try {
    const setup = ctx.session.getSetup();
    if (!setup) return false;
    const touch = ctx.devices.list().filter((d) => d.kind === 'touch' && d.connected).map((d) => d.id);
    if (touch.length === 0) return false;
    return setup.bindings.some((b) => b.deviceIds.some((id) => id === ANY || touch.includes(id)));
  } catch {
    return false;
  }
}

// ============================================================ match minute

/** Last regular minute of each period (index = Period). */
const PERIOD_END_MIN: readonly number[] = [0, 45, 90, 105, 120, 120];

/**
 * Displayed match minute from displayClock values: the minute in progress ("1'" from 00:00 to 00:59), and in added
 * time the period end plus the added minute ("45+2'"). Allocates the label string (event time only).
 */
export function minuteLabel(min: number, sec: number, period: number): string {
  void sec;
  const m = Math.floor(min) + 1;
  const p = period >= Period.FIRST_HALF && period <= Period.SHOOT_OUT ? period : Period.FIRST_HALF;
  const end = PERIOD_END_MIN[p]!;
  if (p < Period.SHOOT_OUT && m > end) return `${end}+${m - end}'`;
  return `${m}'`;
}
