/**
 * [MOD-01..05] Test fakes shared by the MOD unit tests: an in-memory SettingsStore (progress is JSON round-tripped
 * like real storage) and a minimal AppContext with the real clubs.
 */
import type { AppContext, DeviceInfo, SettingsStore } from '../../src/contracts/app';
import { PadFamily } from '../../src/contracts/enums';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { CLUBS } from '../../src/data/clubs';

export interface FakeSettings extends SettingsStore {
  progress: Map<string, string>;
  saves: number;
}

export function fakeSettings(mut?: (s: Settings) => void): FakeSettings {
  let s = createDefaultSettings();
  if (mut) mut(s);
  const progress = new Map<string, string>();
  const subs = new Set<(s: Readonly<Settings>) => void>();
  const store: FakeSettings = {
    progress,
    saves: 0,
    get: () => s,
    update(fn) {
      const next = structuredClone(s);
      fn(next);
      s = next;
      for (const f of subs) f(s);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    reset() {
      s = createDefaultSettings();
    },
    persistent: true,
    loadProgress<T>(key: string): T | null {
      const v = progress.get(key);
      return v === undefined ? null : (JSON.parse(v) as T);
    },
    saveProgress<T>(key: string, value: T) {
      store.saves++;
      progress.set(key, JSON.stringify(value));
    },
    clearProgress() {
      progress.clear();
    },
  };
  return store;
}

export const DEVICES: DeviceInfo[] = [
  { id: 'touch', kind: 'touch', label: 'Touch', family: PadFamily.AUTO, connected: true },
  { id: 'keyboard', kind: 'keyboard', label: 'Keyboard', family: PadFamily.AUTO, connected: true },
];

export function pad(i: number): DeviceInfo {
  return { id: `pad:${i}`, kind: 'pad', label: `Controller ${i + 1}`, family: PadFamily.XBOX, connected: true };
}

export function fakeCtx(opts: { settings?: FakeSettings; devices?: DeviceInfo[]; lastActive?: string | null } = {}): AppContext & { settings: FakeSettings } {
  const settings = opts.settings ?? fakeSettings();
  const devices = opts.devices ?? DEVICES;
  const nav: string[] = [];
  return {
    settings,
    clubs: CLUBS,
    devices: {
      list: () => devices.slice(),
      subscribe: () => () => undefined,
      createSource: () => {
        throw new Error('not in unit tests');
      },
      lastActive: () => opts.lastActive ?? null,
    },
    router: {
      current: null,
      go: (id: string) => nav.push(id),
      replace: (id: string) => nav.push(id),
      back: () => nav.push('<back>'),
      register: () => undefined,
    },
  } as unknown as AppContext & { settings: FakeSettings };
}
