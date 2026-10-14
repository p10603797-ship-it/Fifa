/**
 * [AUD-01] Pre-rendered sound buffers, generated once after unlock without a frame hitch.
 *
 * Sound modules (AUD-02..05) register their synthesised one-shots and loops here when they are created (inside
 * unlock) and play the finished AudioBuffers through the voice pools: nothing is synthesised per event.
 *
 * - define(id, seconds, channels, render): rendered in JavaScript, in chunks of `chunk` samples, a few
 *   milliseconds per animation frame (the engine pumps from update()), so a long crowd loop never stalls a frame.
 *   The renderer is a pure function of the sample range (`from`..`to`) and the sample rate: it keeps its own state
 *   between chunks only through what it can recompute from `from`, which also makes it worker friendly.
 * - defineGraph(id, seconds, channels, build): built as a Web Audio graph in an OfflineAudioContext, which the
 *   browser renders off the main thread (one at a time). Use where nodes (filters, oscillators) are easier.
 * - get(handle) returns the AudioBuffer once ready, else null (play nothing rather than block).
 * Non-finite samples are written as 0 and every sample is clamped to -1..1 (a NaN would silence the whole graph
 * on some WebKit versions).
 */

const LOCAL_TUNING = {
  /** Samples rendered per chunk (between budget checks). */
  chunk: 4096,
  /** Longest buffer a module may define, s (memory guard). */
  maxSeconds: 30,
  /** Used when the context reports no sample rate (test fakes), Hz. */
  fallbackRate: 48000,
} as const; // TUNING-CR

export const BANK_TUNING = LOCAL_TUNING;

/** Fill out[c][from..to) for every channel c. Called repeatedly with consecutive ranges. */
export type SampleRenderer = (out: readonly Float32Array[], from: number, to: number, sampleRate: number) => void;
/** Build a graph into `ctx` (connect to ctx.destination and start sources at 0). */
export type GraphBuilder = (ctx: OfflineAudioContext) => void;

export enum JobStatus {
  PENDING = 0,
  RENDERING = 1,
  DONE = 2,
  FAILED = 3,
}

export interface BufferBank {
  readonly sampleRate: number;
  /** Register a JavaScript-rendered buffer. Returns its handle; the same id returns the existing handle. */
  define(id: string, seconds: number, channels: number, render: SampleRenderer): number;
  /** Register a buffer rendered by an OfflineAudioContext. Returns its handle; same id -> existing handle. */
  defineGraph(id: string, seconds: number, channels: number, build: GraphBuilder): number;
  /** Handle of a defined id, or -1. */
  handle(id: string): number;
  /** The finished buffer, or null while pending / after a failure / for an unknown handle. */
  get(handle: number): AudioBuffer | null;
  status(handle: number): JobStatus | -1;
  /** Jobs not finished yet (pending or rendering). */
  readonly pending: number;
  readonly failed: number;
  /**
   * Render for up to `budgetMs` (at least one chunk when work is left) and start the next offline render if none
   * is running. Returns true when nothing is left.
   */
  pump(budgetMs: number): boolean;
  /** Finish every JavaScript job now (tests, or a screen that may wait). Offline renders stay asynchronous. */
  flush(): void;
  dispose(): void;
}

export interface BufferBankOptions {
  /** Clock for the budget, ms. Default performance.now. */
  now?: () => number;
  chunk?: number;
  /** A renderer threw or a buffer could not be created. */
  onError?(err: unknown, id: string): void;
  /** OfflineAudioContext factory (tests). Default: OfflineAudioContext / webkitOfflineAudioContext. */
  createOffline?: (channels: number, length: number, sampleRate: number) => OfflineAudioContext | null;
}

interface Job {
  id: string;
  graph: boolean;
  channels: number;
  length: number;
  render: SampleRenderer | null;
  build: GraphBuilder | null;
  status: JobStatus;
  cursor: number;
  buffer: AudioBuffer | null;
  data: Float32Array[] | null;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function defaultOffline(channels: number, length: number, sampleRate: number): OfflineAudioContext | null {
  const g = globalThis as unknown as {
    OfflineAudioContext?: typeof OfflineAudioContext;
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const C = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!C) return null;
  try {
    return new C(channels, length, sampleRate);
  } catch {
    return null;
  }
}

/** Replace non-finite samples with 0 and clamp to -1..1 in ch[from..to). */
export function sanitizeRange(ch: Float32Array, from: number, to: number): void {
  for (let i = from; i < to; i++) {
    const x = ch[i]!;
    if (x !== x || x === Infinity || x === -Infinity) ch[i] = 0;
    else if (x > 1) ch[i] = 1;
    else if (x < -1) ch[i] = -1;
  }
}

export function createBufferBank(ctx: BaseAudioContext, opts: BufferBankOptions = {}): BufferBank {
  const now = opts.now ?? defaultNow;
  const chunk = opts.chunk !== undefined && Number.isFinite(opts.chunk) && opts.chunk >= 1 ? Math.floor(opts.chunk) : LOCAL_TUNING.chunk;
  const makeOffline = opts.createOffline ?? defaultOffline;
  const sr = Number.isFinite(ctx.sampleRate) && ctx.sampleRate > 0 ? ctx.sampleRate : LOCAL_TUNING.fallbackRate;
  const jobs: Job[] = [];
  /** First job that may still need work (everything before it is done or failed). */
  let head = 0;
  let pending = 0;
  let failed = 0;
  let offlineBusy = false;
  let disposed = false;

  function report(err: unknown, id: string): void {
    if (!opts.onError) return;
    try {
      opts.onError(err, id);
    } catch {
      /* reporting must not throw */
    }
  }

  function finish(j: Job, buffer: AudioBuffer | null): void {
    if (j.status === JobStatus.DONE || j.status === JobStatus.FAILED) return;
    j.render = null;
    j.build = null;
    j.data = null;
    pending--;
    if (buffer) {
      j.buffer = buffer;
      j.status = JobStatus.DONE;
    } else {
      j.buffer = null;
      j.status = JobStatus.FAILED;
      failed++;
    }
  }

  function fail(j: Job, err: unknown): void {
    finish(j, null);
    report(err, j.id);
  }

  function add(id: string, seconds: number, channels: number, graph: boolean, render: SampleRenderer | null, build: GraphBuilder | null): number {
    if (disposed) return -1;
    for (let i = 0; i < jobs.length; i++) if (jobs[i]!.id === id) return i;
    const secs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, LOCAL_TUNING.maxSeconds) : 0;
    const ch = Number.isFinite(channels) && channels >= 1 ? Math.min(2, Math.floor(channels)) : 1;
    const job: Job = {
      id, graph, channels: ch, length: Math.max(1, Math.round(secs * sr)), render, build,
      status: JobStatus.PENDING, cursor: 0, buffer: null, data: null,
    };
    jobs.push(job);
    pending++;
    return jobs.length - 1;
  }

  /** Render one chunk of a JavaScript job (allocating its AudioBuffer on the first chunk). */
  function renderChunk(j: Job): void {
    if (!j.data) {
      try {
        const buf = ctx.createBuffer(j.channels, j.length, sr);
        const data: Float32Array[] = [];
        for (let c = 0; c < j.channels; c++) data.push(buf.getChannelData(c));
        j.buffer = buf;
        j.data = data;
        j.status = JobStatus.RENDERING;
      } catch (err) {
        fail(j, err);
        return;
      }
    }
    const from = j.cursor;
    const to = Math.min(j.length, from + chunk);
    try {
      j.render!(j.data, from, to, sr);
    } catch (err) {
      fail(j, err);
      return;
    }
    for (let c = 0; c < j.data.length; c++) sanitizeRange(j.data[c]!, from, to);
    j.cursor = to;
    if (to >= j.length) finish(j, j.buffer);
  }

  function startOffline(j: Job): void {
    const oc = makeOffline(j.channels, j.length, sr);
    if (!oc) {
      fail(j, new Error('OfflineAudioContext unavailable'));
      return;
    }
    try {
      j.build!(oc);
    } catch (err) {
      fail(j, err);
      return;
    }
    j.status = JobStatus.RENDERING;
    offlineBusy = true;
    const done = (buf: AudioBuffer | null | undefined): void => {
      offlineBusy = false;
      if (disposed) return;
      if (buf) finish(j, buf);
      else fail(j, new Error('offline render returned no buffer'));
    };
    const onFail = (err: unknown): void => {
      offlineBusy = false;
      if (!disposed) fail(j, err);
    };
    try {
      const p = oc.startRendering() as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(done, onFail);
      else oc.oncomplete = (e: OfflineAudioCompletionEvent) => done(e.renderedBuffer);
    } catch (err) {
      onFail(err);
    }
  }

  const bank: BufferBank = {
    sampleRate: sr,
    define(id, seconds, channels, render) {
      return add(id, seconds, channels, false, render, null);
    },
    defineGraph(id, seconds, channels, build) {
      return add(id, seconds, channels, true, null, build);
    },
    handle(id) {
      for (let i = 0; i < jobs.length; i++) if (jobs[i]!.id === id) return i;
      return -1;
    },
    get(handle) {
      const j = jobs[handle];
      return j && j.status === JobStatus.DONE ? j.buffer : null;
    },
    status(handle) {
      const j = jobs[handle];
      return j ? j.status : -1;
    },
    get pending() {
      return pending;
    },
    get failed() {
      return failed;
    },
    pump(budgetMs) {
      if (disposed || pending === 0) return true;
      const t0 = now();
      const budget = Number.isFinite(budgetMs) ? budgetMs : 0;
      let worked = false;
      for (let i = head; i < jobs.length; i++) {
        const j = jobs[i]!;
        if (j.status === JobStatus.DONE || j.status === JobStatus.FAILED) {
          if (i === head) head++;
          continue;
        }
        if (j.graph) {
          if (j.status === JobStatus.PENDING && !offlineBusy) startOffline(j);
          continue;
        }
        while (j.status === JobStatus.PENDING || j.status === JobStatus.RENDERING) {
          if (worked && now() - t0 >= budget) return false;
          renderChunk(j);
          worked = true;
        }
        if (i === head) head++;
      }
      return pending === 0;
    },
    flush() {
      for (let i = head; i < jobs.length; i++) {
        const j = jobs[i]!;
        if (j.graph) {
          if (j.status === JobStatus.PENDING && !offlineBusy) startOffline(j);
          continue;
        }
        while (j.status === JobStatus.PENDING || j.status === JobStatus.RENDERING) renderChunk(j);
      }
    },
    dispose() {
      disposed = true;
      for (let i = 0; i < jobs.length; i++) {
        const j = jobs[i]!;
        j.render = null;
        j.build = null;
        j.data = null;
        j.buffer = null;
      }
      jobs.length = 0;
      head = 0;
      pending = 0;
    },
  };
  return bank;
}
