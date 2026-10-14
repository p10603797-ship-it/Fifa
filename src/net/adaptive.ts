/**
 * [NET-04] Round-trip measurement, adaptive input delay (2..8 ticks, start 3) and input redundancy (the last 10
 * frames in every packet). Pure logic, no timers: callers pass the time and the tick.
 *
 * Round trip
 *   createRttEstimator()   RFC 6298 smoothing: srtt += (s - srtt) / 8, rttvar += (|srtt - s| - rttvar) / 4.
 *                          jitter = rttvar (smoothed mean deviation of the round trip).
 *   createRttMeter(...)    '$ping' { t } every intervalMs on the reliable channel, answered with '$pong' { t }; the
 *                          sender's own clock times the round trip. Both transports embed one (NetTransport.rtt,
 *                          .jitter and the { type: 'rtt', sampleMs } event).
 *
 * Input delay
 *   computeTargetDelay(rtt, jitter) = clamp(ceil((rtt / 2 + 2 * jitter) / tickMs) + 1, 2, 8).
 *   createAdaptiveDelay()  feeds samples through the estimator, applies hysteresis (raise after RAISE_SAMPLES
 *                          consecutive higher targets; lower only after LOWER_SAMPLES consecutive samples with at
 *                          least LOWER_MARGIN_TICKS of slack), and answers delayFor(tick) from a list of agreed
 *                          switches (schedule(delay, atTick)).
 *   createDelaySync(...)   the agreement: the guest reports its target ('ls:target'); the host takes the larger of
 *                          both targets and announces { type: 'ls:delay', delay, at } with `at` far enough ahead
 *                          (LEAD) that both peers switch on the same tick. A late announcement still applies on the
 *                          guest's next tick (correctness never depends on it: every frame is defined once by its
 *                          sender; the agreed tick only keeps both sides' latency equal).
 *   Frames are generated at take(t) for tick t + delayFor(t): a raise fills the skipped ticks with "held" copies of
 *   the previous frame (edges cleared), a drop skips sampling until t + delay passes the newest frame (lockstep.ts).
 *
 * Redundancy
 *   createFrameRing(cap)   packed frames by tick (FRAME_INTS int16 each) with a contiguity watermark.
 *   encodeRedundant(...)   'newest' mode: the newest frames not yet acknowledged, at most `redundancy` of them (every
 *                          packet repeats up to the last 10 frames, so a lost packet needs no resend). 'catch-up' mode
 *                          (resends while idle / stalled): from the oldest unacknowledged frame forward, so a peer that
 *                          lost more than 10 packets in a row always gets the frame it is stuck on.
 *   decodeRedundant(...)   stores only frames not seen before (de-duplication by tick; first arrival wins, frames are
 *                          immutable once sent), ignoring ticks already contiguous or absurdly far ahead.
 */
import { TICK_HZ } from '../contracts/constants';
import type { InputFrame } from '../contracts/input';
import { T_NET } from '../contracts/tuning';
import { CTRL_PING, CTRL_PONG, FRAME_INTS, packSenderFrame, unpackSenderFrame } from './packet';
import type { ControlMessage, InputPacket } from './types';

const LOCAL_TUNING = {
  /** Ping interval on the reliable channel, ms. */
  pingIntervalMs: 500,
  /** EWMA gain of the smoothed round trip (RFC 6298 alpha), 0..1. */
  rttGain: 1 / 8,
  /** EWMA gain of the round-trip mean deviation (RFC 6298 beta), 0..1. */
  jitterGain: 1 / 4,
  /** Consecutive samples whose target is above the current one before raising (500 ms each). */
  raiseSamples: 2,
  /** Consecutive samples with room to spare before lowering (8 x 500 ms = 4 s). */
  lowerSamples: 8,
  /** Lower only when the unrounded target is at least this many ticks below (current - 1). */
  lowerMarginTicks: 0.25,
  /** Agreed switch tick: at least this many ticks after the host's tick when announced. */
  switchLeadMinTicks: 45,
  /** Round-trip samples above this are ignored (suspended tab, clock jump), ms. */
  maxSampleMs: 10_000,
} as const; // TUNING-CR

export const NET_DELAY_MIN: number = T_NET.delayMin;
export const NET_DELAY_MAX: number = T_NET.delayMax;
export const NET_DELAY_START: number = T_NET.delayInitial;
export const NET_REDUNDANCY: number = T_NET.redundancy;
/** Default ping interval, ms. */
export const NET_PING_INTERVAL_MS: number = LOCAL_TUNING.pingIntervalMs;
/** One sim tick, ms. */
export const TICK_MS = 1000 / TICK_HZ;

/** Control types owned by the delay agreement. */
export const CTRL_DELAY = 'ls:delay';
export const CTRL_TARGET = 'ls:target';

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------- round trip

export interface RttEstimator {
  /** Smoothed round trip, ms (0 before the first sample). */
  readonly rttMs: number;
  /** Smoothed mean deviation, ms (0 before the first sample). */
  readonly jitterMs: number;
  readonly samples: number;
  /** Add one raw sample; returns false (ignored) when it is not a plausible round trip. */
  add(sampleMs: number): boolean;
  reset(): void;
}

export function createRttEstimator(): RttEstimator {
  let srtt = 0;
  let rttvar = 0;
  let n = 0;
  return {
    get rttMs() { return srtt; },
    get jitterMs() { return rttvar; },
    get samples() { return n; },
    add(s) {
      if (!Number.isFinite(s) || s < 0 || s > LOCAL_TUNING.maxSampleMs) return false;
      if (n === 0) {
        srtt = s;
        rttvar = s / 2;
      } else {
        rttvar += (Math.abs(srtt - s) - rttvar) * LOCAL_TUNING.jitterGain;
        srtt += (s - srtt) * LOCAL_TUNING.rttGain;
      }
      n++;
      return true;
    },
    reset() {
      srtt = 0;
      rttvar = 0;
      n = 0;
    },
  };
}

export interface RttMeter extends RttEstimator {
  /** Send a ping when one is due. Call often (every frame or on a timer). */
  pump(nowMs: number): void;
  /** Consume '$ping' (answers with '$pong') and '$pong' (records a sample); false for any other message. */
  handle(msg: ControlMessage, nowMs: number): boolean;
}

export interface RttMeterOptions {
  send(msg: ControlMessage): void;
  /** Ping interval, ms (default 500). */
  intervalMs?: number;
  /** Every accepted raw sample. */
  onSample?(sampleMs: number): void;
}

export function createRttMeter(opts: RttMeterOptions): RttMeter {
  const est = createRttEstimator();
  const interval = opts.intervalMs ?? LOCAL_TUNING.pingIntervalMs;
  let lastPing = -Infinity;
  return {
    get rttMs() { return est.rttMs; },
    get jitterMs() { return est.jitterMs; },
    get samples() { return est.samples; },
    add: (s) => est.add(s),
    reset() {
      est.reset();
      lastPing = -Infinity;
    },
    pump(nowMs) {
      if (interval <= 0 || nowMs - lastPing < interval) return;
      lastPing = nowMs;
      opts.send({ type: CTRL_PING, t: nowMs });
    },
    handle(msg, nowMs) {
      if (msg.type === CTRL_PING) {
        opts.send({ type: CTRL_PONG, t: msg.t });
        return true;
      }
      if (msg.type !== CTRL_PONG) return false;
      const t = msg.t;
      if (typeof t === 'number' && est.add(nowMs - t)) opts.onSample?.(nowMs - t);
      return true;
    },
  };
}

// ---------------------------------------------------------------- input delay

/** Unrounded delay formula (before ceil and clamp): (rtt / 2 + 2 * jitter) / tickMs + 1. */
export function rawTargetDelay(rttMs: number, jitterMs: number, tickMs = TICK_MS): number {
  return (rttMs / 2 + 2 * jitterMs) / tickMs + 1;
}

/** delay = clamp(ceil((rtt / 2 + 2 * jitter) / tickMs) + 1, min, max). */
export function computeTargetDelay(
  rttMs: number, jitterMs: number, tickMs = TICK_MS, min = NET_DELAY_MIN, max = NET_DELAY_MAX,
): number {
  const v = Math.ceil((rttMs / 2 + 2 * jitterMs) / tickMs) + 1;
  return clampInt(Number.isFinite(v) ? v : max, min, max);
}

export interface AdaptiveDelayOptions {
  /** Delay before any switch (default T_NET.delayInitial = 3). */
  initial?: number;
  min?: number;
  max?: number;
  tickMs?: number;
}

export interface DelaySwitch {
  delay: number;
  atTick: number;
}

export interface AdaptiveDelay {
  /** Current input delay in ticks (the one in effect for the latest tick passed to delayFor, or the initial). */
  readonly delay: number;
  /** Smoothed round-trip time, ms. */
  readonly rttMs: number;
  /** Round-trip jitter (smoothed mean deviation), ms. */
  readonly jitterMs: number;
  /** Delay this side wants, after hysteresis (what the agreement should switch to). */
  readonly target: number;
  /** Feed one RTT sample (ms). */
  sample(rttMs: number): void;
  /** Delay to use for the input of `tick` (changes only at agreed ticks). */
  delayFor(tick: number): number;
  /** Agreed switch: from `atTick` on, delayFor returns `delay` (clamped to min..max). */
  schedule(delay: number, atTick: number): void;
  /** Delay after the last scheduled switch (the eventual delay). */
  readonly scheduled: number;
  /** Agreed switches so far, oldest first (bounded history). */
  readonly switches: readonly DelaySwitch[];
}

const SWITCH_HISTORY = 32;

export function createAdaptiveDelay(opts: AdaptiveDelayOptions = {}): AdaptiveDelay {
  const min = opts.min ?? NET_DELAY_MIN;
  const max = opts.max ?? NET_DELAY_MAX;
  const tickMs = opts.tickMs ?? TICK_MS;
  const initial = clampInt(Math.round(opts.initial ?? NET_DELAY_START), min, max);
  const est = createRttEstimator();
  const switches: DelaySwitch[] = [];
  let target = initial;
  let above = 0;
  let below = 0;
  let current = initial;

  function delayAt(tick: number): number {
    for (let i = switches.length - 1; i >= 0; i--) if (tick >= switches[i]!.atTick) return switches[i]!.delay;
    return initial;
  }

  return {
    get delay() { return current; },
    get rttMs() { return est.rttMs; },
    get jitterMs() { return est.jitterMs; },
    get target() { return target; },
    get scheduled() { return switches.length > 0 ? switches[switches.length - 1]!.delay : initial; },
    get switches() { return switches; },
    sample(rttMs) {
      if (!est.add(rttMs)) return;
      const raw = rawTargetDelay(est.rttMs, est.jitterMs, tickMs);
      const want = computeTargetDelay(est.rttMs, est.jitterMs, tickMs, min, max);
      if (want > target) {
        below = 0;
        if (++above >= LOCAL_TUNING.raiseSamples) {
          target = want;
          above = 0;
        }
      } else if (want < target && raw <= target - 1 - LOCAL_TUNING.lowerMarginTicks) {
        above = 0;
        if (++below >= LOCAL_TUNING.lowerSamples) {
          target = want;
          below = 0;
        }
      } else {
        above = 0;
        below = 0;
      }
    },
    delayFor(tick) {
      current = delayAt(tick);
      return current;
    },
    schedule(delay, atTick) {
      const d = clampInt(Math.round(delay), min, max);
      // A new agreement replaces any later one (the host never has two in flight, but stay safe).
      while (switches.length > 0 && switches[switches.length - 1]!.atTick >= atTick) switches.pop();
      switches.push({ delay: d, atTick });
      if (switches.length > SWITCH_HISTORY) switches.shift();
    },
  };
}

export interface DelaySync {
  /** Consume 'ls:delay' / 'ls:target'; false for other messages. */
  handle(msg: ControlMessage): boolean;
  /** Once per taken tick with the tick just reached: the guest reports its target, the host may announce a switch. */
  update(tick: number): void;
  /** Switches announced (host) or accepted (guest). */
  readonly changes: number;
  /** Announcements that reached the guest after their tick (applied on its next tick instead). */
  readonly late: number;
  /** The other side's target as last reported (host only; -1 before). */
  readonly remoteTarget: number;
}

export interface DelaySyncOptions {
  isHost: boolean;
  adaptive: AdaptiveDelay;
  send(msg: ControlMessage): void;
  tickMs?: number;
}

export function createDelaySync(opts: DelaySyncOptions): DelaySync {
  const a = opts.adaptive;
  const tickMs = opts.tickMs ?? TICK_MS;
  let remoteTarget = -1;
  let lastSent = -1;
  let changes = 0;
  let late = 0;
  let tickNow = 0;
  return {
    get changes() { return changes; },
    get late() { return late; },
    get remoteTarget() { return remoteTarget; },
    handle(msg) {
      if (msg.type === CTRL_TARGET) {
        if (opts.isHost && typeof msg.target === 'number' && Number.isInteger(msg.target)) remoteTarget = msg.target;
        return true;
      }
      if (msg.type !== CTRL_DELAY) return false;
      if (!opts.isHost && typeof msg.delay === 'number' && typeof msg.at === 'number' && Number.isInteger(msg.at) && msg.at >= 0) {
        let at = msg.at;
        if (at <= tickNow) {
          late++;
          at = tickNow + 1;
        }
        a.schedule(msg.delay, at);
        changes++;
      }
      return true;
    },
    update(tick) {
      tickNow = tick;
      if (!opts.isHost) {
        if (a.target !== lastSent) {
          lastSent = a.target;
          opts.send({ type: CTRL_TARGET, target: lastSent });
        }
        return;
      }
      const sw = a.switches;
      if (sw.length > 0 && sw[sw.length - 1]!.atTick > tick) return; // one switch in flight at a time
      const want = remoteTarget > a.target ? remoteTarget : a.target;
      if (want === a.scheduled) return;
      const lead = Math.max(LOCAL_TUNING.switchLeadMinTicks, 2 * NET_DELAY_MAX + Math.ceil((2 * a.rttMs) / tickMs));
      const at = tick + lead;
      a.schedule(want, at);
      changes++;
      opts.send({ type: CTRL_DELAY, delay: a.scheduled, at });
    },
  };
}

// ---------------------------------------------------------------- frame ring

export interface FrameRing {
  readonly capacity: number;
  /** First tick that counts for contiguity. */
  readonly base: number;
  /** Newest tick T such that every tick base..T is stored (base - 1 when none). */
  readonly contiguous: number;
  /** Newest tick stored (base - 1 when none). */
  readonly newest: number;
  has(tick: number): boolean;
  /** Store FRAME_INTS values from src[offset..] for `tick` (replaces whatever used that slot). */
  put(tick: number, src: Int16Array, offset: number): void;
  putFrame(tick: number, frame: InputFrame): void;
  /** Unpack the frame of `tick` into `out`; false when not stored. */
  getFrame(tick: number, out: InputFrame): boolean;
  /** Copy the packed values of `tick` to out[offset..]; false when not stored. */
  copyOut(tick: number, out: Int16Array, offset: number): boolean;
  /** The packed values of `tick` as a plain array (diagnostics), or null. */
  values(tick: number): number[] | null;
  /** Forget everything and start contiguity at `base`. */
  reset(base: number): void;
}

export function createFrameRing(capacity: number, base = 0): FrameRing {
  const cap = Math.max(16, capacity | 0);
  const tags = new Float64Array(cap).fill(-1);
  const data = new Int16Array(cap * FRAME_INTS);
  let first = base;
  let contig = base - 1;
  let newest = base - 1;
  const slot = (tick: number): number => tick % cap;
  const ring: FrameRing = {
    capacity: cap,
    get base() { return first; },
    get contiguous() { return contig; },
    get newest() { return newest; },
    has: (tick) => tick >= 0 && Number.isInteger(tick) && tags[slot(tick)] === tick,
    put(tick, src, offset) {
      if (tick < 0 || !Number.isInteger(tick)) return;
      const s = slot(tick);
      tags[s] = tick;
      const o = s * FRAME_INTS;
      for (let i = 0; i < FRAME_INTS; i++) data[o + i] = src[offset + i]!;
      if (tick > newest) newest = tick;
      if (tick === contig + 1) {
        contig++;
        while (ring.has(contig + 1)) contig++;
      }
    },
    putFrame(tick, frame) {
      packSenderFrame(frame, scratch, 0);
      ring.put(tick, scratch, 0);
    },
    getFrame(tick, out) {
      if (!ring.has(tick)) return false;
      unpackSenderFrame(data, slot(tick) * FRAME_INTS, out);
      return true;
    },
    copyOut(tick, out, offset) {
      if (!ring.has(tick)) return false;
      const o = slot(tick) * FRAME_INTS;
      for (let i = 0; i < FRAME_INTS; i++) out[offset + i] = data[o + i]!;
      return true;
    },
    values(tick) {
      if (!ring.has(tick)) return null;
      const o = slot(tick) * FRAME_INTS;
      return Array.from(data.subarray(o, o + FRAME_INTS));
    },
    reset(b) {
      tags.fill(-1);
      first = b;
      contig = b - 1;
      newest = b - 1;
    },
  };
  return ring;
}

const scratch = new Int16Array(FRAME_INTS);

// ---------------------------------------------------------------- redundancy codec

export type RedundancyMode = 'newest' | 'catch-up';

/**
 * Fill `out` (whose data holds at least redundancy * FRAME_INTS values) with frames from `ring` ending at or before
 * `newest`, given the other side's acknowledgement `ack` and our own acknowledgement `ownAck` to carry. Returns false
 * when there is nothing to send (no frame stored at all).
 */
export function encodeRedundant(
  ring: FrameRing, newest: number, ack: number, ownAck: number, mode: RedundancyMode, redundancy: number, out: InputPacket,
): boolean {
  if (newest < ring.base || !ring.has(newest)) return false;
  const r = Math.max(1, redundancy | 0);
  let first: number;
  let last: number;
  if (mode === 'newest') {
    last = newest;
    first = Math.max(ack + 1, newest - r + 1, ring.base);
    if (first > last) first = last;
  } else {
    first = Math.max(ack + 1, ring.base, newest - ring.capacity + 1);
    if (first > newest) first = newest;
    last = Math.min(newest, first + r - 1);
  }
  // Every tick between first and last must be stored (they are: local frames are generated without gaps).
  while (!ring.has(first) && first < last) first++;
  let count = 0;
  for (let t = first; t <= last; t++) {
    if (!ring.copyOut(t, out.data, count * FRAME_INTS)) break;
    count++;
  }
  out.firstTick = first;
  out.count = count;
  out.ack = ownAck;
  return count > 0;
}

/**
 * Store the frames of `packet` that `ring` does not have yet. Frames at or below ring.contiguous are known already
 * and frames more than `window` ticks past it are ignored. Returns the number of new frames stored.
 */
export function decodeRedundant(packet: InputPacket, ring: FrameRing, window = ring.capacity >> 1): number {
  let added = 0;
  const limit = ring.contiguous + window;
  const n = Math.min(packet.count, Math.floor(packet.data.length / FRAME_INTS));
  for (let i = 0; i < n; i++) {
    const tick = packet.firstTick + i;
    if (tick <= ring.contiguous || tick > limit || ring.has(tick)) continue;
    ring.put(tick, packet.data, i * FRAME_INTS);
    added++;
  }
  return added;
}
