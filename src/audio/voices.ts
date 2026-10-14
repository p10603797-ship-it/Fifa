/**
 * [AUD-01] One-shot voice limiting, so sounds never stack (glitch list: "sounds stacking after a pause").
 *
 * Each bus gets a VoicePool with a fixed number of voices, created once at unlock: a persistent GainNode (and a
 * StereoPannerNode where the browser has one) per voice, connected to the bus. Playing a sound creates only the
 * AudioBufferSourceNode (a one-shot by Web Audio design) and plays a pre-rendered buffer through a free voice.
 * When every voice is busy the allocator steals: the lowest priority first, then the oldest. A stolen voice is
 * faded out over a few milliseconds (no click) and the new sound starts right after the fade. A second sound of
 * the same `group` within the retrigger window replaces the first instead of adding a voice, so two identical
 * events a tick apart never double up. When no voice may be stolen (all busy with higher priority) the new sound is
 * dropped.
 *
 * VoiceAllocator is pure bookkeeping over preallocated typed arrays (unit-tested in Node); createVoicePool wires it
 * to Web Audio. Hot path: play() allocates nothing besides the source node of the sound that starts.
 */

const LOCAL_TUNING = {
  /** Fade applied to a stolen voice before the new sound starts on it, s. */
  stealFade: 0.008,
  /** A sound of the same group starting within this time of the previous one replaces it, s. */
  retriggerWindow: 0.035,
  /** Playback rate limits (Web Audio accepts far more; these keep durations sane). */
  minRate: 0.0625,
  maxRate: 16,
} as const; // TUNING-CR

export const VOICE_TUNING = LOCAL_TUNING;

/** No group: never retriggers. */
export const NO_GROUP = -1;

/** Fixed-capacity voice bookkeeping: which voice a new sound gets and whether it steals one. */
export class VoiceAllocator {
  readonly capacity: number;
  /** Start time of the sound on each voice (context seconds). */
  readonly start: Float64Array;
  /** End time of the sound on each voice; a voice is free when end <= now. -1 = never used / released. */
  readonly end: Float64Array;
  readonly priority: Float64Array;
  readonly group: Int32Array;
  /** Set by acquire(): 1 when the returned voice was still sounding (stolen or retriggered), else 0. */
  stolen = 0;
  /** Counters (diagnostics, tests). */
  plays = 0;
  steals = 0;
  retriggers = 0;
  drops = 0;

  constructor(capacity: number) {
    const n = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
    this.capacity = n;
    this.start = new Float64Array(n);
    this.end = new Float64Array(n).fill(-1);
    this.priority = new Float64Array(n);
    this.group = new Int32Array(n).fill(NO_GROUP);
  }

  /**
   * Pick a voice for a sound that starts at `now` and lasts `duration` seconds. Order: a same-group voice that
   * started within `retriggerWindow` (replaced), else a free voice (lowest index), else steal the sounding voice
   * with the lowest priority not above `priority`, oldest first. Returns -1 (dropped) when nothing may be stolen.
   */
  acquire(now: number, duration: number, priority = 0, group = NO_GROUP, retriggerWindow: number = LOCAL_TUNING.retriggerWindow): number {
    const t = Number.isFinite(now) && now > 0 ? now : 0;
    const dur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const prio = Number.isFinite(priority) ? priority : 0;
    const win = Number.isFinite(retriggerWindow) && retriggerWindow > 0 ? retriggerWindow : 0;
    this.stolen = 0;
    let free = -1;
    let retrig = -1;
    let victim = -1;
    let vPrio = Infinity;
    let vStart = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.end[i]! <= t) {
        if (free < 0) free = i;
        continue;
      }
      if (group !== NO_GROUP && retrig < 0 && this.group[i] === group && t - this.start[i]! <= win) retrig = i;
      const p = this.priority[i]!;
      if (p > prio) continue;
      const s = this.start[i]!;
      if (p < vPrio || (p === vPrio && s < vStart)) {
        victim = i;
        vPrio = p;
        vStart = s;
      }
    }
    let v: number;
    if (retrig >= 0) {
      v = retrig;
      this.stolen = 1;
      this.retriggers++;
    } else if (free >= 0) {
      v = free;
    } else if (victim >= 0) {
      v = victim;
      this.stolen = 1;
      this.steals++;
    } else {
      this.drops++;
      return -1;
    }
    this.start[v] = t;
    this.end[v] = t + dur;
    this.priority[v] = prio;
    this.group[v] = group;
    this.plays++;
    return v;
  }

  /** Move a voice's window (the pool delays a sound that waits for a steal fade). */
  setWindow(v: number, start: number, end: number): void {
    if (v < 0 || v >= this.capacity) return;
    this.start[v] = start;
    this.end[v] = end;
  }

  /** Mark a voice as fading out until `until`: still busy, but the first to be stolen. */
  fadeOut(v: number, until: number): void {
    if (v < 0 || v >= this.capacity) return;
    this.end[v] = until;
    this.priority[v] = -Infinity;
    this.group[v] = NO_GROUP;
  }

  release(v: number): void {
    if (v < 0 || v >= this.capacity) return;
    this.end[v] = -1;
    this.group[v] = NO_GROUP;
  }

  /** Voices still sounding at `now`. */
  active(now: number): number {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) if (this.end[i]! > now) n++;
    return n;
  }

  reset(): void {
    this.end.fill(-1);
    this.group.fill(NO_GROUP);
    this.priority.fill(0);
  }
}

export interface VoicePool {
  readonly capacity: number;
  readonly allocator: VoiceAllocator;
  /**
   * Play `buffer` once through a voice of this pool. gain 0..4 (linear), pan -1..1 (left..right), rate = playback
   * rate (pitch), priority (higher steals lower; equal steals the oldest), group (same group retriggers instead of
   * stacking; NO_GROUP never does), delay = seconds from now. Returns the voice index, or -1 when dropped
   * (also whenever the context is not running: nothing is queued against a frozen clock).
   */
  play(buffer: AudioBuffer | null, gain?: number, pan?: number, rate?: number, priority?: number, group?: number, delay?: number): number;
  /** Voices sounding now. */
  active(): number;
  /** Fade out and stop every sounding voice (pause, match end, backgrounding). */
  stopAll(fade?: number): void;
  dispose(): void;
}

export interface VoicePoolOptions {
  stealFade?: number;
  retriggerWindow?: number;
}

/** Sources disconnect themselves when they end (assigned by reference: no closure per sound). */
function disconnectOnEnd(this: AudioScheduledSourceNode): void {
  try {
    this.disconnect();
  } catch {
    /* already disconnected */
  }
}

function finiteOr(v: number | undefined, d: number): number {
  return v !== undefined && Number.isFinite(v) ? v : d;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Cancel future automation on `p` and set it to `v` at time `t` (plain value write where automation is missing). */
function setAt(p: AudioParam, v: number, t: number): void {
  try {
    if (typeof p.setValueAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(t);
      p.setValueAtTime(v, t);
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = v;
}

/** Linear fade of `p` from `from` at `t` to `to` at `t + dur`. */
function fadeAt(p: AudioParam, from: number, to: number, t: number, dur: number): void {
  try {
    if (typeof p.linearRampToValueAtTime === 'function' && typeof p.setValueAtTime === 'function') {
      if (typeof p.cancelScheduledValues === 'function') p.cancelScheduledValues(t);
      p.setValueAtTime(from, t);
      p.linearRampToValueAtTime(to, t + dur);
      return;
    }
  } catch {
    /* fall back */
  }
  p.value = to;
}

/**
 * Build `capacity` voices on `bus`. Voices whose nodes cannot be created (very old browsers, test fakes) are
 * skipped, so the pool may be smaller than asked; capacity reports the real size.
 */
export function createVoicePool(ctx: BaseAudioContext, bus: AudioNode, capacity: number, opts: VoicePoolOptions = {}): VoicePool {
  const stealFade = Math.max(0.001, finiteOr(opts.stealFade, LOCAL_TUNING.stealFade));
  const retrigWin = Math.max(0, finiteOr(opts.retriggerWindow, LOCAL_TUNING.retriggerWindow));
  const gains: GainNode[] = [];
  const panners: (StereoPannerNode | null)[] = [];
  const want = Number.isFinite(capacity) && capacity > 0 ? Math.floor(capacity) : 0;
  const canPan = typeof (ctx as Partial<BaseAudioContext>).createStereoPanner === 'function';
  for (let i = 0; i < want; i++) {
    try {
      const g = ctx.createGain();
      g.gain.value = 0;
      let p: StereoPannerNode | null = null;
      if (canPan) {
        try {
          p = ctx.createStereoPanner();
        } catch {
          p = null;
        }
      }
      if (p) {
        g.connect(p);
        p.connect(bus);
      } else {
        g.connect(bus);
      }
      gains.push(g);
      panners.push(p);
    } catch {
      break;
    }
  }
  const n = gains.length;
  const alloc = new VoiceAllocator(n);
  const sources: (AudioBufferSourceNode | null)[] = new Array<AudioBufferSourceNode | null>(n).fill(null);
  /** Gain each voice was last set to (start value of a steal fade). */
  const level = new Float64Array(n);
  let disposed = false;

  function stopSource(v: number, at: number): void {
    const s = sources[v];
    if (!s) return;
    try {
      s.stop(at);
    } catch {
      /* not started or already stopped */
    }
  }

  return {
    capacity: n,
    allocator: alloc,
    play(buffer, gain = 1, pan = 0, rate = 1, priority = 0, group = NO_GROUP, delay = 0) {
      if (disposed || !buffer || n === 0) return -1;
      // A suspended/interrupted clock is frozen: a sound queued now would burst out with all the others on resume.
      if (ctx.state !== 'running') return -1;
      const r = clamp(finiteOr(rate, 1), LOCAL_TUNING.minRate, LOCAL_TUNING.maxRate);
      const g = clamp(finiteOr(gain, 1), 0, 4);
      const pn = clamp(finiteOr(pan, 0), -1, 1);
      const now = ctx.currentTime;
      const t0 = now + Math.max(0, finiteOr(delay, 0));
      const dur = (Number.isFinite(buffer.duration) ? buffer.duration : 0) / r;
      const v = alloc.acquire(t0, dur, priority, group, retrigWin);
      if (v < 0) return -1;
      const gp = gains[v]!.gain;
      let start = t0;
      if (alloc.stolen) {
        // Fade the old sound out on this voice, then start the new one: no click, no overlap.
        start = t0 + stealFade;
        fadeAt(gp, level[v]!, 0, t0, stealFade);
        stopSource(v, start);
        alloc.setWindow(v, start, start + dur);
      }
      let src: AudioBufferSourceNode;
      try {
        src = ctx.createBufferSource();
        src.buffer = buffer;
        if (r !== 1) src.playbackRate.value = r;
        src.onended = disconnectOnEnd;
        src.connect(gains[v]!);
      } catch {
        alloc.release(v);
        return -1;
      }
      if (alloc.stolen) {
        try {
          gp.setValueAtTime(g, start);
        } catch {
          gp.value = g;
        }
      } else {
        setAt(gp, g, start);
      }
      level[v] = g;
      const p = panners[v];
      if (p) setAt(p.pan, pn, start);
      try {
        src.start(start);
      } catch {
        alloc.release(v);
        return -1;
      }
      sources[v] = src;
      return v;
    },
    active() {
      return disposed ? 0 : alloc.active(ctx.currentTime);
    },
    stopAll(fade = 0.05) {
      if (disposed) return;
      const now = ctx.currentTime;
      const f = Math.max(0.001, finiteOr(fade, 0.05));
      for (let v = 0; v < n; v++) {
        if (alloc.end[v]! <= now) continue;
        fadeAt(gains[v]!.gain, level[v]!, 0, now, f);
        level[v] = 0;
        stopSource(v, now + f);
        alloc.fadeOut(v, now + f);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const now = ctx.currentTime;
      for (let v = 0; v < n; v++) {
        stopSource(v, now);
        sources[v] = null;
        try {
          gains[v]!.disconnect();
          panners[v]?.disconnect();
        } catch {
          /* ignore */
        }
      }
      alloc.reset();
    },
  };
}
