/**
 * [PLT-05] Diagnostics log and report.
 *
 * - A fixed-size ring buffer of recent log lines with levels. `log(kind, message, data)`: the kind doubles as the
 *   level when it is 'error', 'warn' (or 'warning') or 'debug'; every other kind ('boot', 'storage', 'pwa', ...) is
 *   an info-level category. Lines are formatted once when logged (`<t>s [kind] message | data`), capped at
 *   MAX_LINE_CHARS, and the ring keeps the last `capacity` of them (default 200).
 * - report(): a copy-able plain-text report: game / sim version, time, user agent, viewport and screen, storage mode,
 *   settings, the sections other modules contribute through addSection (recovery adds Device, Match (seed, tick,
 *   phase, state hash) and Replay), level counts, the last error and the recent log.
 * - The PLT-03 settings store's storage problems (corrupt values moved to a backup key, quota, blocked storage) are
 *   logged here: createDiagnostics attaches itself as the store's logger when the store supports setLogger, and the
 *   store replays the lines it buffered before that.
 * - Never writes to the console in production builds (e2e requires zero console output); dev builds mirror errors.
 */
import type { Diagnostics, SettingsStore } from '../contracts/app';
import { GAME_NAME, GAME_VERSION, SIM_VERSION } from '../contracts/constants';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric order of the levels (filtering). */
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

/** Longest stored line; longer lines are cut and end with '...'. */
export const MAX_LINE_CHARS = 2000;

export interface DiagnosticsImpl extends Diagnostics {
  /** Last message logged with kind 'error', or null. */
  readonly lastError: string | null;
  /** Number of lines logged since boot. */
  readonly total: number;
  /** Extra report sections (e.g. last replay summary) contributed by other modules. Same name replaces. */
  addSection(name: string, fn: () => string): void;
  removeSection(name: string): void;
  /** Lines at or above `level` still in the ring, oldest first. */
  recentAtLeast(level: LogLevel): readonly string[];
  /** Lines logged since boot per level. */
  count(level: LogLevel): number;
  /** Forget the ring and the counts (tests, "clear log"). */
  clear(): void;
}

export interface DiagnosticsOptions {
  capacity?: number;
  now?: () => number;
  /** Wall clock for the report's time line (tests). */
  wallClock?: () => Date;
}

/** Level of a log kind. Pure. */
export function levelOf(kind: string): LogLevel {
  switch (kind) {
    case 'error': return 'error';
    case 'warn':
    case 'warning': return 'warn';
    case 'debug': return 'debug';
    default: return 'info';
  }
}

function levelIndex(l: LogLevel): number {
  return l === 'debug' ? 0 : l === 'info' ? 1 : l === 'warn' ? 2 : 3;
}

/** Text for the data part of a log line. Pure; never throws. */
export function describeData(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return data.stack ?? `${data.name}: ${data.message}`;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data) ?? String(data);
  } catch {
    try {
      return String(data);
    } catch {
      return '[unprintable]';
    }
  }
}

/** Format one log line. Pure. */
export function formatLogLine(tMs: number, kind: string, message: string, data?: unknown): string {
  const extra = describeData(data);
  const line = `${(tMs / 1000).toFixed(2)}s [${kind}] ${message}${extra ? ' | ' + extra : ''}`;
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '...' : line;
}

type LoggerCapable = { setLogger?(fn: ((kind: string, message: string, data?: unknown) => void) | null): void; describe?(): string };

export function createDiagnostics(settings: SettingsStore, opts: DiagnosticsOptions = {}): DiagnosticsImpl {
  const capacity = Math.max(8, Math.floor(opts.capacity ?? 200));
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const wallClock = opts.wallClock ?? (() => new Date());
  const ring: string[] = new Array<string>(capacity).fill('');
  const levels = new Uint8Array(capacity);
  const counts = [0, 0, 0, 0];
  let head = 0;
  let count = 0;
  let total = 0;
  let lastError: string | null = null;
  const sections: { name: string; fn: () => string }[] = [];

  function log(kind: string, message: string, data?: unknown): void {
    let line: string;
    try {
      line = formatLogLine(now(), kind, String(message), data);
    } catch {
      line = `[${kind}] ${String(message)}`;
    }
    const lv = levelIndex(levelOf(kind));
    ring[head] = line;
    levels[head] = lv;
    head = (head + 1) % capacity;
    if (count < capacity) count++;
    total++;
    counts[lv]!++;
    if (lv === 3) {
      lastError = String(message);
      if (import.meta.env?.DEV) console.warn(line);
    }
  }

  function collect(minLevel: number): string[] {
    const out: string[] = [];
    const start = (head - count + capacity) % capacity;
    for (let i = 0; i < count; i++) {
      const j = (start + i) % capacity;
      if (levels[j]! >= minLevel) out.push(ring[j]!);
    }
    return out;
  }

  const store = settings as SettingsStore & LoggerCapable;
  if (typeof store.setLogger === 'function') {
    try {
      store.setLogger((kind, message, data) => log(kind, message, data));
    } catch {
      /* the store keeps logging nowhere */
    }
  }

  const diag: DiagnosticsImpl = {
    log,
    recent: () => collect(0),
    recentAtLeast: (level) => collect(levelIndex(level)),
    count: (level) => counts[levelIndex(level)]!,
    get debug() {
      return settings.get().debug;
    },
    setDebug(on) {
      if (settings.get().debug !== on) settings.update((s) => { s.debug = on; });
    },
    get lastError() {
      return lastError;
    },
    get total() {
      return total;
    },
    addSection(name, fn) {
      const i = sections.findIndex((s) => s.name === name);
      if (i >= 0) sections[i] = { name, fn };
      else sections.push({ name, fn });
    },
    removeSection(name) {
      const i = sections.findIndex((s) => s.name === name);
      if (i >= 0) sections.splice(i, 1);
    },
    clear() {
      head = 0;
      count = 0;
      ring.fill('');
      levels.fill(0);
      counts.fill(0);
      lastError = null;
    },
    report() {
      const lines: string[] = [];
      const safe = (fn: () => string): string => {
        try {
          return fn();
        } catch (err) {
          return `unavailable (${describeData(err).split('\n')[0]})`;
        }
      };
      lines.push(`${GAME_NAME} ${GAME_VERSION} (sim ${SIM_VERSION})`);
      lines.push(`Time: ${safe(() => wallClock().toISOString())}`);
      if (typeof navigator !== 'undefined') lines.push(`UA: ${navigator.userAgent}`);
      if (typeof window !== 'undefined') {
        lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`);
        if (window.screen) lines.push(`Screen: ${window.screen.width}x${window.screen.height}`);
      }
      lines.push(`Storage: ${typeof store.describe === 'function' ? safe(() => store.describe!()) : settings.persistent ? 'persistent' : 'memory only'}`);
      lines.push(`Settings: ${safe(() => JSON.stringify(settings.get()))}`);
      for (const s of sections.slice()) lines.push(`${s.name}: ${safe(s.fn)}`);
      lines.push(`Errors: ${counts[3]}  warnings: ${counts[2]}  lines: ${total}`);
      if (lastError !== null) lines.push(`Last error: ${lastError}`);
      lines.push(`Log (${count} of ${total}):`);
      for (const l of collect(0)) lines.push('  ' + l);
      return lines.join('\n');
    },
  };
  return diag;
}
