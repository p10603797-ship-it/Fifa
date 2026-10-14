/**
 * [NET-01] Lockstep core: the TickInputProvider for online 1v1, fed by the local devices and the remote peer.
 *
 *   const provider = createLockstepProvider({ transport, localHuman: 0, localSources: [src], delay: 3 });
 *   ctx.session.start({ config, bindings: [], inputProvider: provider, modeData: ... });   // NET-06
 *
 * Each side samples its own human's frame when it takes tick t and schedules it for tick t + delayFor(t), sends it
 * on the 'inputs' channel (with up to T_NET.redundancy unacknowledged frames repeated in every packet), and buffers
 * the other side's frames by tick. ready(tick) is true only when both frames of `tick` exist; otherwise the sim is
 * held and `waiting` is set (show a small indicator; `waitingMs` says for how long). The remote input is never
 * guessed: take() without both frames throws. Frames are indexed by tick, so the order packets arrive in never
 * matters, and every frame is immutable once generated (duplicates and late copies are ignored).
 *
 *  - Start: the local frames of ticks firstTick .. firstTick + delay - 1 are neutral (nothing was sampled yet); they
 *    are sent like any other frame, so the two sides never assume anything about each other's frames.
 *  - Commands (tactics, subs, skip) from queueCommand(localHuman, ...) travel inside the next generated local frame,
 *    so both sides apply them on the same tick. Commands for the other human are ignored (they come over the wire).
 *  - Resends: while stalled (every RESEND_WAITING_MS) or idle (every RESEND_IDLE_MS) pump() resends from the oldest
 *    frame the other side has not acknowledged, so losing more than 10 packets in a row cannot deadlock.
 *  - Adaptive delay (NET-04, adaptive.ts): RTT samples from the transport drive the target; the host announces
 *    switches at an agreed future tick. A raise fills the skipped ticks with "held" frames (axes and held buttons of
 *    the previous frame, no edges); a drop simply samples nothing until t + delay passes the newest frame.
 *  - Time sync (adaptive.ts TimeSync): every packet carries the sender's tick and frame advantage; when this side
 *    runs HOLD_THRESHOLD ticks ahead it holds its sim once for k + holdCatchUpTicks ticks (ready() false, but not
 *    `waiting`), because the app loop makes up to MAX_TICKS_PER_FRAME - 1 held ticks afterwards. Without it the
 *    leading side would stall briefly on every late frame and catch up again, for the whole match.
 *  - Desync guard (NET-05, desync.ts): the state handed to take() is the result of tick state.tick, so take() hashes
 *    it every 30 ticks, the host sends a snapshot on a mismatch, and the guest hard-syncs inside take(): the state
 *    is replaced in place (copyState) and the frames for snapshot tick + 1 are returned, after which the loop simply
 *    continues from state.tick + 1 (re-simulating with the frames kept in history: HISTORY_TICKS per side).
 *
 * Both sides must use the same firstTick and the same frame order (frames[0] = host human, frames[1] = guest human).
 * The provider owns `localSources` (dispose() disposes them); it never closes the transport (the session owns it).
 */
import { createCommandQueue, mergeInputFrame } from '../app/localInput';
import type { TickInputProvider } from '../contracts/app';
import { MAX_HUMANS, MAX_TICKS_PER_FRAME } from '../contracts/constants';
import type { Command } from '../contracts/enums';
import {
  Btn, clearInputFrame, copyInputFrame, createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext,
  type InputSource,
} from '../contracts/input';
import type { ReadonlySimState, SimState } from '../contracts/state';
import {
  createAdaptiveDelay, createDelaySync, createFrameRing, createTimeSync, decodeRedundant, encodeRedundant, NET_DELAY_START,
  NET_REDUNDANCY, TICK_MS, type AdaptiveDelay, type RedundancyMode, type TimeSync,
} from './adaptive';
import { createDesyncGuard, type DesyncGuard } from './desync';
import { FRAME_INTS } from './packet';
import type { InputPacket, NetTransport } from './types';

const LOCAL_TUNING = {
  /** Frames kept per side for resends and resync re-simulation, ticks (8.5 s). */
  historyTicks: 512,
  /** Resend interval while stalled waiting for the other side, ms. */
  resendWaitingMs: 33,
  /** Resend interval while no new frame was sent (paused, delay just dropped), ms. */
  resendIdleMs: 200,
} as const; // TUNING-CR

export const HISTORY_TICKS: number = LOCAL_TUNING.historyTicks;
export const RESEND_WAITING_MS: number = LOCAL_TUNING.resendWaitingMs;
export const RESEND_IDLE_MS: number = LOCAL_TUNING.resendIdleMs;

export interface LockstepOptions {
  transport: NetTransport;
  /** Human index of the local player (0 host, 1 guest). */
  localHuman: number;
  /** Local devices merged into the local frame (owned by the provider from now on). */
  localSources: InputSource[];
  /**
   * Initial input delay in ticks (T_NET.delayInitial, or a start value the host picked from transport.rtt with
   * computeTargetDelay). Every frame is self-described, so correctness never depends on both sides using the same
   * value, but they should (the host's later switches apply to both).
   */
  delay: number;
  /** First tick the session will take (default 1: initMatch leaves state.tick at 0). Same on both sides. */
  firstTick?: number;
  /** Adapt the delay to the measured round trip (default true). False keeps `delay` fixed. */
  adaptive?: boolean;
  /** Resync authority (default: transport.role === 'host', or localHuman === 0 before open). */
  isHost?: boolean;
  /** Camera projector for gesture sources (default none). */
  getProjector?: () => CameraProjector | null;
  /** Diagnostics.log compatible: desyncs, resyncs, source errors. */
  log?: (kind: string, message: string, data?: unknown) => void;
  /** Snapshot compression for resyncs (default 'auto'). */
  compress?: 'auto' | 'gzip' | 'none';
  /** The guest hard-synced: the live state is now the snapshot of `tick` (it was at `fromTick`). */
  onResync?: (tick: number, fromTick: number) => void;
  /** Frames repeated per packet (default T_NET.redundancy = 10). */
  redundancy?: number;
  /** Hash interval, ticks (default T_NET.hashInterval = 30). */
  hashInterval?: number;
  /** Frame-advantage time sync (default true). */
  timeSync?: boolean;
  /**
   * Ticks of held time the host loop makes up after a hold (default MAX_TICKS_PER_FRAME - 1, matching
   * src/app/loopMath endFrame); a hold sheds k ticks by holding k + holdCatchUpTicks. Use 0 for a loop that drops
   * the time of held frames.
   */
  holdCatchUpTicks?: number;
}

export interface LockstepStats {
  /** Times the sim was held waiting for the other side, and how long. */
  stalls: number;
  maxStallMs: number;
  totalStallMs: number;
  /** Latest tick handed to the sim. */
  lastTaken: number;
  /** Newest local frame generated. */
  newestLocal: number;
  /** Every remote frame up to this tick has arrived. */
  remoteContiguous: number;
  /** Newest tick of ours the other side acknowledged. */
  remoteAck: number;
  packetsSent: number;
  resends: number;
  packetsReceived: number;
  framesReceived: number;
  duplicateFrames: number;
  delay: number;
  /** Time sync: ticks this side runs ahead (negative = behind), holds done and ticks they shed. */
  advantage: number;
  holds: number;
  heldTicks: number;
  delayChanges: number;
  lateDelaySwitches: number;
  rttMs: number;
  jitterMs: number;
  desyncs: number;
  resyncs: number;
  lastResyncTick: number;
}

export interface LockstepProvider extends TickInputProvider {
  /** Commands (tactics, subs, skip) travel inside the local frame so both sides apply them on the same tick. */
  queueCommand(human: number, cmd: number, arg: number): void;
  /** Input delay in effect, ticks. */
  readonly delay: number;
  /** How long the current stall has lasted, ms (0 when not waiting). */
  readonly waitingMs: number;
  readonly stats: LockstepStats;
  readonly adaptive: AdaptiveDelay;
  readonly guard: DesyncGuard;
  readonly timeSync: TimeSync;
  /** True while a time-sync hold keeps the sim still (not a stall: no waiting indicator). */
  readonly holding: boolean;
  /** Packed frames of ticks from..to for both humans (diagnostics, desync reports). */
  describeInputs(fromTick: number, toTick: number): { tick: number; h0: number[] | null; h1: number[] | null }[];
}

/** Copy the continuous part of `src` (axes, held buttons, curve) into `dst`, without edges. */
function holdFrame(dst: InputFrame, src: InputFrame): void {
  clearInputFrame(dst);
  dst.mx = src.mx;
  dst.mz = src.mz;
  dst.ax = src.ax;
  dst.az = src.az;
  dst.buttons = src.buttons & ~(Btn.RS_FLICK | Btn.SKIP);
  dst.curve = src.curve;
}

interface MutableSampleContext {
  tick: number;
  human: number;
  side: number;
  state: SimState;
  projector: CameraProjector | null;
}

export function createLockstepProvider(opts: LockstepOptions): LockstepProvider {
  const tr = opts.transport;
  const local = opts.localHuman;
  if (MAX_HUMANS !== 2 || (local !== 0 && local !== 1)) throw new RangeError(`lockstep: localHuman must be 0 or 1, got ${local}`);
  const remote = 1 - local;
  const isHost = opts.isHost ?? (tr.role !== null ? tr.role === 'host' : local === 0);
  const firstTick = opts.firstTick ?? 1;
  const redundancy = Math.max(1, opts.redundancy ?? NET_REDUNDANCY);
  const useAdaptive = opts.adaptive !== false;
  const adaptive = createAdaptiveDelay({ initial: opts.delay ?? NET_DELAY_START });
  const fixedDelay = Math.max(1, Math.round(opts.delay ?? NET_DELAY_START));
  const startDelay = useAdaptive ? adaptive.delayFor(firstTick) : fixedDelay;
  const log = opts.log;
  const useTimeSync = opts.timeSync !== false;
  const holdCatchUp = Math.max(0, opts.holdCatchUpTicks ?? MAX_TICKS_PER_FRAME - 1);
  const timeSync = createTimeSync();
  let holdUntil = -Infinity;

  const localRing = createFrameRing(HISTORY_TICKS, firstTick);
  const remoteRing = createFrameRing(HISTORY_TICKS, firstTick);
  const sources = opts.localSources.slice();
  const queue = createCommandQueue();
  const packet: InputPacket = { firstTick: 0, count: 0, ack: -1, tick: -1, adv: 0, data: new Int16Array(redundancy * FRAME_INTS) };
  const genFrame = createInputFrame();
  const prevFrame = createInputFrame();
  const sampleScratch = createInputFrame();
  const remoteDummy = createInputFrame();
  const applyList: InputFrame[] = [];
  applyList[local] = genFrame;
  applyList[remote] = remoteDummy;
  const sampleCtx: MutableSampleContext = { tick: 0, human: local, side: -1, state: null as unknown as SimState, projector: null };

  let lastGen = firstTick + startDelay - 1;
  for (let t = firstTick; t <= lastGen; t++) localRing.putFrame(t, prevFrame); // neutral start frames
  let remoteAck = firstTick - 1;
  let lastNow = 0;
  let lastSendMs = -Infinity;
  let waiting = false;
  let stallStart = 0;
  let lastTaken = firstTick - 1;
  let disposed = false;
  const st = {
    stalls: 0, maxStallMs: 0, totalStallMs: 0, packetsSent: 0, resends: 0, packetsReceived: 0, framesReceived: 0,
    duplicateFrames: 0,
  };

  function describeInputs(fromTick: number, toTick: number): { tick: number; h0: number[] | null; h1: number[] | null }[] {
    const out: { tick: number; h0: number[] | null; h1: number[] | null }[] = [];
    for (let t = Math.max(firstTick, fromTick); t <= toTick; t++) {
      const l = localRing.values(t);
      const r = remoteRing.values(t);
      out.push({ tick: t, h0: local === 0 ? l : r, h1: local === 0 ? r : l });
    }
    return out;
  }

  const guard = createDesyncGuard({
    isHost,
    send: (m) => tr.sendReliable(m),
    interval: opts.hashInterval,
    log,
    describeInputs,
    compress: opts.compress,
    onApplied: opts.onResync,
  });
  const sync = createDelaySync({ isHost, adaptive, send: (m) => tr.sendReliable(m) });

  function send(mode: RedundancyMode): void {
    if (disposed || !encodeRedundant(localRing, lastGen, remoteAck, remoteRing.contiguous, mode, redundancy, packet)) return;
    packet.tick = lastTaken;
    packet.adv = timeSync.localAdvantage;
    tr.sendInputs(packet);
    st.packetsSent++;
    if (mode === 'catch-up') st.resends++;
    lastSendMs = lastNow;
  }

  const unsubs = [
    tr.onInputs((p) => {
      if (disposed) return;
      st.packetsReceived++;
      if (p.ack > remoteAck) remoteAck = p.ack;
      timeSync.onPacket(lastTaken, p.tick, p.adv);
      const added = decodeRedundant(p, remoteRing);
      st.framesReceived += added;
      st.duplicateFrames += p.count - added;
    }),
    tr.onReliable((m) => {
      if (disposed) return;
      if (guard.handle(m)) return;
      if (useAdaptive) sync.handle(m);
    }),
    tr.onEvent((e) => {
      if (!disposed && e.type === 'rtt') adaptive.sample(e.sampleMs); // fixed delay: still measured for stats
    }),
  ];

  /** Sample the local devices into genFrame for `target`. */
  function sample(target: number, state: SimState): void {
    clearInputFrame(genFrame);
    sampleCtx.tick = target;
    sampleCtx.state = state;
    const ctrl = state.ctrl[local];
    sampleCtx.side = ctrl ? ctrl.side : -1;
    sampleCtx.projector = opts.getProjector ? opts.getProjector() : null;
    for (let i = 0; i < sources.length; i++) {
      clearInputFrame(sampleScratch);
      try {
        sources[i]!.sample(sampleScratch, sampleCtx as InputSampleContext);
      } catch (err) {
        log?.('net', `input source ${sources[i]!.id} failed: ${String(err)}`);
        continue;
      }
      mergeInputFrame(genFrame, sampleScratch);
    }
    queue.applyTo(applyList);
  }

  /** Generate local frames up to t + delay; true when something new was generated. */
  function generate(t: number, state: SimState): boolean {
    const target = t + (useAdaptive ? adaptive.delayFor(t) : fixedDelay);
    if (target <= lastGen) return false;
    while (lastGen + 1 < target) {
      holdFrame(genFrame, prevFrame);
      localRing.putFrame(++lastGen, genFrame);
    }
    sample(target, state);
    localRing.putFrame(target, genFrame);
    copyInputFrame(prevFrame, genFrame);
    lastGen = target;
    return true;
  }

  send('newest'); // the neutral start frames

  const provider: LockstepProvider = {
    get waiting() { return waiting; },
    get waitingMs() { return waiting ? lastNow - stallStart : 0; },
    get delay() { return useAdaptive ? adaptive.delay : fixedDelay; },
    adaptive,
    guard,
    timeSync,
    get holding() { return lastNow < holdUntil; },
    get stats(): LockstepStats {
      return {
        stalls: st.stalls, maxStallMs: Math.max(st.maxStallMs, waiting ? lastNow - stallStart : 0), totalStallMs: st.totalStallMs,
        lastTaken, newestLocal: lastGen, remoteContiguous: remoteRing.contiguous, remoteAck, packetsSent: st.packetsSent,
        resends: st.resends, packetsReceived: st.packetsReceived, framesReceived: st.framesReceived,
        duplicateFrames: st.duplicateFrames, delay: provider.delay, advantage: timeSync.advantage, holds: timeSync.holds,
        heldTicks: timeSync.heldTicks, delayChanges: sync.changes, lateDelaySwitches: sync.late,
        rttMs: adaptive.rttMs, jitterMs: adaptive.jitterMs, desyncs: guard.desyncs, resyncs: guard.resyncs,
        lastResyncTick: guard.lastResyncTick,
      };
    },
    describeInputs,
    ready(tick) {
      if (lastNow < holdUntil) return false; // time-sync hold: deliberate, not a stall
      const ok = localRing.has(tick) && remoteRing.has(tick);
      if (!ok) {
        if (!waiting) {
          waiting = true;
          stallStart = lastNow;
          st.stalls++;
        }
      } else if (waiting) {
        waiting = false;
        const d = lastNow - stallStart;
        st.totalStallMs += d;
        if (d > st.maxStallMs) st.maxStallMs = d;
      }
      return ok;
    },
    take(_tick, frames, state: ReadonlySimState) {
      const s = state as unknown as SimState;
      guard.applyPending(s);
      guard.afterTick(s);
      const t = s.tick + 1;
      if (useAdaptive) sync.update(s.tick);
      for (let h = 0; h < frames.length; h++) {
        const out = frames[h];
        if (!out) continue;
        if (h === local) {
          if (!localRing.getFrame(t, out)) throw new Error(`lockstep: no local input for tick ${t}`);
        } else if (h === remote) {
          if (!remoteRing.getFrame(t, out)) throw new Error(`lockstep: no remote input for tick ${t} (take() without ready())`);
        } else clearInputFrame(out);
      }
      lastTaken = t;
      if (generate(t, s)) send('newest');
    },
    pump(nowMs) {
      lastNow = nowMs;
      for (let i = 0; i < sources.length; i++) {
        const src = sources[i]!;
        if (!src.pollFrame) continue;
        try {
          src.pollFrame(nowMs);
        } catch (err) {
          log?.('net', `input source ${src.id} poll failed: ${String(err)}`);
        }
      }
      if (useTimeSync && !waiting && nowMs >= holdUntil) {
        const k = timeSync.poll(nowMs);
        if (k > 0) {
          holdUntil = nowMs + (k + holdCatchUp) * TICK_MS;
          log?.('net', `time sync: ${timeSync.advantage.toFixed(2)} ticks ahead, holding ${k + holdCatchUp} ticks`);
        }
      }
      if (nowMs - lastSendMs >= (waiting ? RESEND_WAITING_MS : RESEND_IDLE_MS)) send('catch-up');
    },
    queueCommand(human, cmd, arg) {
      if (human === local) queue.push(local, cmd as Command, arg);
    },
    releaseAll() {
      for (const s of sources) {
        try {
          s.releaseAll();
        } catch (err) {
          log?.('net', `input source ${s.id} releaseAll failed: ${String(err)}`);
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const u of unsubs) u();
      guard.dispose();
      for (const s of sources) {
        try {
          s.dispose();
        } catch (err) {
          log?.('net', `input source ${s.id} dispose failed: ${String(err)}`);
        }
      }
      sources.length = 0;
      queue.clear();
    },
  };
  return provider;
}
