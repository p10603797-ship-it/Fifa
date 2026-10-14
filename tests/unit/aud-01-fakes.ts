/**
 * [AUD-01] Test fakes: a Web Audio context whose AudioParams evaluate their automation timeline (so tests can
 * sample a gain over time and prove there is no step = no click), plus a window that records gesture listeners.
 */
import { vi } from 'vitest';

type AutoKind = 'set' | 'lin' | 'target';
interface AutoEvent {
  kind: AutoKind;
  t: number;
  v: number;
  tc: number;
}

export interface Clock {
  currentTime: number;
}

/** AudioParam with a simplified but faithful automation timeline (setValue, linearRamp, setTarget, cancel). */
export class FakeParam {
  events: AutoEvent[] = [];
  base: number;
  /** Method names called, in order (assert that a change was a ramp, not a step). */
  log: string[] = [];
  constructor(private readonly clock: Clock, v: number) {
    this.base = v;
  }
  get value(): number {
    return this.valueAt(this.clock.currentTime);
  }
  set value(v: number) {
    this.log.push('value');
    this.events = this.events.filter((e) => e.t < this.clock.currentTime);
    this.insert({ kind: 'set', t: this.clock.currentTime, v, tc: 0 });
  }
  private insert(e: AutoEvent): void {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.t > e.t) i--;
    this.events.splice(i, 0, e);
  }
  setValueAtTime(v: number, t: number): this {
    this.log.push('setValueAtTime');
    this.insert({ kind: 'set', t, v, tc: 0 });
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.log.push('linearRampToValueAtTime');
    this.insert({ kind: 'lin', t, v, tc: 0 });
    return this;
  }
  setTargetAtTime(v: number, t: number, tc: number): this {
    this.log.push('setTargetAtTime');
    this.insert({ kind: 'target', t, v, tc });
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.log.push('cancelScheduledValues');
    this.events = this.events.filter((e) => e.t < t);
    return this;
  }
  /** Value at time t following the timeline. */
  valueAt(t: number): number {
    let mode: 'const' | 'target' = 'const';
    let cur = this.base;
    let tgt = 0;
    let tc = 1;
    let t0 = 0;
    let v0 = 0;
    const at = (x: number): number => (mode === 'const' ? cur : tgt + (v0 - tgt) * Math.exp(-(x - t0) / tc));
    let lastT = 0;
    for (const e of this.events) {
      if (e.t > t) {
        if (e.kind === 'lin') {
          const start = at(lastT);
          const span = e.t - lastT;
          return span > 0 ? start + ((e.v - start) * (t - lastT)) / span : e.v;
        }
        break;
      }
      if (e.kind === 'target') {
        v0 = at(e.t);
        t0 = e.t;
        tgt = e.v;
        tc = e.tc;
        mode = 'target';
      } else {
        cur = e.v;
        mode = 'const';
      }
      lastT = e.t;
    }
    return at(t);
  }
  /** Largest change between consecutive samples at `rate` Hz over [from, to]. */
  maxStep(from: number, to: number, rate = 48000): number {
    let max = 0;
    let prev = this.valueAt(from);
    const n = Math.ceil((to - from) * rate);
    for (let i = 1; i <= n; i++) {
      const v = this.valueAt(Math.min(to, from + i / rate));
      max = Math.max(max, Math.abs(v - prev));
      prev = v;
    }
    return max;
  }
}

export class FakeNode {
  outputs: unknown[] = [];
  disconnected = 0;
  connect(n: unknown): unknown {
    this.outputs.push(n);
    return n;
  }
  disconnect(): void {
    this.disconnected++;
    this.outputs = [];
  }
}

export class FakeGain extends FakeNode {
  readonly gain: FakeParam;
  constructor(clock: Clock) {
    super();
    this.gain = new FakeParam(clock, 1);
  }
}

export class FakePanner extends FakeNode {
  readonly pan: FakeParam;
  constructor(clock: Clock) {
    super();
    this.pan = new FakeParam(clock, 0);
  }
}

export class FakeCompressor extends FakeNode {
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  constructor(clock: Clock) {
    super();
    this.threshold = new FakeParam(clock, -24);
    this.knee = new FakeParam(clock, 30);
    this.ratio = new FakeParam(clock, 12);
    this.attack = new FakeParam(clock, 0.003);
    this.release = new FakeParam(clock, 0.25);
  }
}

export class FakeBuffer {
  readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    return this.data[c]!;
  }
}

export class FakeBiquad extends FakeNode {
  type = 'lowpass';
  readonly frequency: FakeParam;
  readonly Q: FakeParam;
  constructor(clock: Clock) {
    super();
    this.frequency = new FakeParam(clock, 350);
    this.Q = new FakeParam(clock, 1);
  }
}

export class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency: FakeParam;
  onended: (() => void) | null = null;
  startedAt = -1;
  stoppedAt = -1;
  constructor(clock: Clock) {
    super();
    this.frequency = new FakeParam(clock, 440);
  }
  start(t = 0): void {
    this.startedAt = t;
  }
  stop(t = 0): void {
    this.stoppedAt = t;
  }
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  startOffset = 0;
  readonly playbackRate: FakeParam;
  onended: (() => void) | null = null;
  startedAt = -1;
  stoppedAt = -1;
  stopCalls = 0;
  constructor(clock: Clock) {
    super();
    this.playbackRate = new FakeParam(clock, 1);
  }
  start(t = 0, offset = 0): void {
    if (this.startedAt >= 0) throw new Error('InvalidStateError: start twice');
    this.startedAt = t;
    this.startOffset = offset;
  }
  stop(t = 0): void {
    this.stopCalls++;
    this.stoppedAt = t;
  }
}

export type ResumeMode = 'run' | 'refuse' | 'hang' | 'reject';

export interface FakeContextOptions {
  pan?: boolean;
  compressor?: boolean;
  state?: AudioContextState | 'interrupted';
}

/** Fake AudioContext. `mode` decides what resume() does; setState fires statechange like a browser. */
export function createFakeContext(opts: FakeContextOptions = {}) {
  const listeners: Record<string, (() => void)[]> = {};
  const created = {
    gains: [] as FakeGain[], panners: [] as FakePanner[], sources: [] as FakeSource[], buffers: [] as FakeBuffer[], compressors: [] as FakeCompressor[],
    filters: [] as FakeBiquad[], oscillators: [] as FakeOscillator[],
  };
  const destination = new FakeNode();
  const ac = {
    state: (opts.state ?? 'suspended') as string,
    currentTime: 0,
    sampleRate: 48000,
    destination,
    mode: 'run' as ResumeMode,
    created,
    createGain: vi.fn(() => {
      const g = new FakeGain(ac);
      created.gains.push(g);
      return g;
    }),
    createStereoPanner: opts.pan === false ? undefined : vi.fn(() => {
      const p = new FakePanner(ac);
      created.panners.push(p);
      return p;
    }),
    createDynamicsCompressor: opts.compressor === false ? undefined : vi.fn(() => {
      const c = new FakeCompressor(ac);
      created.compressors.push(c);
      return c;
    }),
    createBiquadFilter: vi.fn(() => {
      const f = new FakeBiquad(ac);
      created.filters.push(f);
      return f;
    }),
    createOscillator: vi.fn(() => {
      const o = new FakeOscillator(ac);
      created.oscillators.push(o);
      return o;
    }),
    createBuffer: vi.fn((ch: number, len: number, sr: number) => {
      const b = new FakeBuffer(ch, len, sr);
      created.buffers.push(b);
      return b;
    }),
    createBufferSource: vi.fn(() => {
      const s = new FakeSource(ac);
      created.sources.push(s);
      return s;
    }),
    resume: vi.fn(() => {
      if (ac.mode === 'hang') return new Promise<void>(() => undefined);
      if (ac.mode === 'reject') return Promise.reject(new Error('NotAllowedError'));
      if (ac.mode === 'run' && ac.state !== 'running' && ac.state !== 'closed') ac.setState('running');
      return Promise.resolve();
    }),
    suspend: vi.fn(() => {
      if (ac.state !== 'closed') ac.setState('suspended');
      return Promise.resolve();
    }),
    close: vi.fn(() => {
      ac.setState('closed');
      return Promise.resolve();
    }),
    addEventListener: vi.fn((type: string, fn: () => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      const l = listeners[type];
      if (l) listeners[type] = l.filter((f) => f !== fn);
    }),
    listenerCount: (type: string) => listeners[type]?.length ?? 0,
    /** Change state and fire statechange (like a browser). */
    setState(s: string) {
      if (ac.state === s) return;
      ac.state = s;
      for (const fn of [...(listeners.statechange ?? [])]) fn();
    },
    /** Change state silently (a browser that misses the event). */
    setStateQuiet(s: string) {
      ac.state = s;
    },
    advance(dt: number) {
      if (ac.state === 'running') ac.currentTime += dt;
    },
  };
  return ac;
}

export type FakeContext = ReturnType<typeof createFakeContext>;

export function asContext(ac: FakeContext): AudioContext {
  return ac as unknown as AudioContext;
}

/** The user-gesture events the engine arms to resume a context. */
export const GESTURE_TYPES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click'] as const;

/** window stand-in: records listeners per event type; fire() calls them like a browser would. */
export function createFakeWindow() {
  const handlers = new Map<string, Set<() => void>>();
  return {
    handlers,
    count: (type: string) => handlers.get(type)?.size ?? 0,
    /** Gesture listeners currently armed (other listeners, e.g. the settings store's 'storage', do not count). */
    armed: () => {
      let n = 0;
      for (const t of GESTURE_TYPES) n += handlers.get(t)?.size ?? 0;
      return n;
    },
    addEventListener: vi.fn((type: string, fn: () => void) => {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: () => void) => {
      handlers.get(type)?.delete(fn);
    }),
    fire(type: string) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn();
    },
  };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

/**
 * The real engine with the real sound modules (AUD-02..05) on a fake context: unlocked (running) and with every
 * buffer rendered. For module tests that go through the engine's services (voice pools, bank, registry).
 */
export async function bootRealEngine(opts: { createEngine: typeof import('../../src/audio/engine').createAudioEngine }) {
  const { createSettingsStore } = await import('../../src/platform/settingsStore');
  const { createMemoryStorage } = await import('../../src/platform/storage');
  const win = createFakeWindow();
  vi.stubGlobal('window', win);
  const ac = createFakeContext();
  const settings = createSettingsStore(createMemoryStorage());
  const errors: string[] = [];
  const engine = opts.createEngine(settings, {
    createContext: () => asContext(ac),
    onModuleError: (e, where) => errors.push(`${where}: ${String(e)}`),
    now: () => 0,
  });
  await engine.unlock();
  await flush();
  engine.services!.bank.flush();
  return { ac, engine, settings, errors, win };
}

/** Sources started on a fake context whose buffer has `length` samples (identify a pre-rendered sound by size). */
export function sourcesWithLength(ac: FakeContext, length: number): FakeSource[] {
  return ac.created.sources.filter((s) => s.buffer !== null && s.buffer.length === length);
}
