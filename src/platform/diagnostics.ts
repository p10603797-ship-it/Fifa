/**
 * [PLT-05] Diagnostics log and report (Wave 0 version by FND-04).
 *
 * A fixed-size ring buffer of recent log lines plus a copy-able report (version, device, settings, recent log).
 * Never writes to the console in production builds (e2e requires zero console output); dev builds mirror errors.
 */
import type { Diagnostics, SettingsStore } from '../contracts/app';
import { GAME_NAME, GAME_VERSION, SIM_VERSION } from '../contracts/constants';

export interface DiagnosticsImpl extends Diagnostics {
  /** Last message logged with kind 'error', or null. */
  readonly lastError: string | null;
  /** Number of lines logged since boot. */
  readonly total: number;
  /** Extra report sections (e.g. last replay summary) contributed by other modules. */
  addSection(name: string, fn: () => string): void;
}

export interface DiagnosticsOptions {
  capacity?: number;
  now?: () => number;
}

function describeData(data: unknown): string {
  if (data === undefined) return '';
  if (data instanceof Error) return data.stack ?? `${data.name}: ${data.message}`;
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

export function createDiagnostics(settings: SettingsStore, opts: DiagnosticsOptions = {}): DiagnosticsImpl {
  const capacity = Math.max(8, opts.capacity ?? 200);
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const ring: string[] = new Array<string>(capacity).fill('');
  let head = 0;
  let count = 0;
  let total = 0;
  let lastError: string | null = null;
  const sections = new Map<string, () => string>();

  function log(kind: string, message: string, data?: unknown): void {
    const extra = describeData(data);
    const line = `${(now() / 1000).toFixed(2)}s [${kind}] ${message}${extra ? ' | ' + extra : ''}`;
    ring[head] = line.length > 2000 ? line.slice(0, 2000) + '...' : line;
    head = (head + 1) % capacity;
    if (count < capacity) count++;
    total++;
    if (kind === 'error') {
      lastError = message;
      if (import.meta.env?.DEV) console.warn(line);
    }
  }

  function recent(): readonly string[] {
    const out: string[] = [];
    const start = (head - count + capacity) % capacity;
    for (let i = 0; i < count; i++) out.push(ring[(start + i) % capacity]!);
    return out;
  }

  return {
    log,
    recent,
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
      sections.set(name, fn);
    },
    report() {
      const lines: string[] = [];
      lines.push(`${GAME_NAME} ${GAME_VERSION} (sim ${SIM_VERSION})`);
      lines.push(`Time: ${new Date().toISOString()}`);
      if (typeof navigator !== 'undefined') lines.push(`UA: ${navigator.userAgent}`);
      if (typeof window !== 'undefined') {
        lines.push(`Viewport: ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`);
        if (window.screen) lines.push(`Screen: ${window.screen.width}x${window.screen.height}`);
      }
      lines.push(`Storage: ${settings.persistent ? 'persistent' : 'memory only'}`);
      lines.push(`Settings: ${JSON.stringify(settings.get())}`);
      for (const [name, fn] of sections) {
        let text: string;
        try {
          text = fn();
        } catch (err) {
          text = `unavailable (${String(err)})`;
        }
        lines.push(`${name}: ${text}`);
      }
      lines.push(`Log (${count} of ${total}):`);
      for (const l of recent()) lines.push('  ' + l);
      return lines.join('\n');
    },
  };
}
