/**
 * [NET-08] Network simulator and two-instance harness: two full peers (lockstep provider + sim, each with its own
 * frame loop mirroring src/app/loopMath) in one process, connected by the seeded in-memory link of
 * src/net/memoryTransport.ts on virtual time (latency, jitter, loss, duplication, reordering, bandwidth cap,
 * retransmission delays on the reliable channel). Scripted random human inputs drive both humans; the CPU plays the
 * other 20 players. Reports stalls, max stall, desyncs, resyncs, delay switches and whether the final hashes and
 * the two frame streams are equal. Never touches the network.
 *
 * Like the app, a lobby phase (lobbyMs, default 3 s of pings) comes first and picks the start delay from the measured
 * round trip; pass `delay` (and lobbyMs: 0) for a cold start at a fixed delay.
 *
 *   const r = await runNetsim({ config: netsimConfig({ seed: 7, halfMinutes: 2 }),
 *     link: { latencyMs: 80, jitterMs: 20, loss: 0.05, reliableLoss: 0.05, seed: 7 } });
 *   r.hashesEqual, r.framesEqual, r.host.desyncs, r.guest.maxStallAfterWarmupMs
 *
 * CLI (definition of done 5: a full match at 80 ms each way, 20 ms jitter and 5 % loss with no desync):
 *   npx tsx tools/netsim.ts --halves 2 --latency 80 --jitter 20 --loss 0.05 --seed 7 [--json] [--desync-tick 600] [--lobby 3000]
 * Exit code 1 when the run is not clean (hashes or frames differ, unrepaired desync, unfinished).
 */
import './lib/env';
import { pathToFileURL } from 'node:url';
import { beginFrame, createLoopTiming, endFrame, TICK_MS, type LoopTiming } from '../src/app/loopMath';
import { MAX_HUMANS } from '../src/contracts/constants';
import { AssistLevel, AutoSwitch, Command, ControllerKind, MatchPhase } from '../src/contracts/enums';
import type { EventBuffer } from '../src/contracts/events';
import { Btn, createInputFrame, type InputFrame, type InputSampleContext, type InputSource } from '../src/contracts/input';
import { createMatchConfig, type MatchConfig, type SimState } from '../src/contracts/state';
import { CUTSCENE_PHASES } from '../src/contracts/transitions';
import { T_NET } from '../src/contracts/tuning';
import { computeTargetDelay, type DelaySwitch } from '../src/net/adaptive';
import { createLockstepProvider, type LockstepProvider } from '../src/net/lockstep';
import {
  createManualClock, createMemoryTransportPair, type MemoryLinkConditions, type MemoryLinkStats,
} from '../src/net/memoryTransport';
import type { NetTransport } from '../src/net/types';
import { createEventBuffer } from '../src/sim/core/events';
import { hashInputFrame, hashState } from '../src/sim/core/hash';
import { initMatch } from '../src/sim/init';
import { step } from '../src/sim/step';
import { parseArgs } from './lib/args';

/** Seeded link conditions plus the knobs of createMemoryTransportPair that matter for a run. */
export interface NetsimLink extends MemoryLinkConditions {
  seed?: number;
  pingIntervalMs?: number;
}

export interface NetsimOptions {
  /** Both peers play this config (humans[0] = host, humans[1] = guest; see netsimConfig). */
  config: MatchConfig;
  link?: NetsimLink;
  /**
   * Initial input delay. Default: what the lobby picks (computeTargetDelay from the round trip measured during the
   * lobby phase, see lobbyMs), or T_NET.delayInitial when nothing was measured.
   */
  delay?: number;
  /**
   * The link pings for this long before the match starts, like the lobby does in the app (the start delay and the
   * lockstep's round-trip estimate come from it), ms. Default 3000; 0 starts cold.
   */
  lobbyMs?: number;
  /** Adaptive delay (default true). */
  adaptive?: boolean;
  /** Frame-advantage time sync in the providers (default true). */
  timeSync?: boolean;
  /** Stop both peers at this tick (default: when both reach POST_MATCH). */
  maxTicks?: number;
  /** Seed of the scripted human inputs (default config.seed). */
  inputSeed?: number;
  /** 'random' (default) or 'idle' (humans only skip cut-scenes). */
  inputs?: 'random' | 'idle';
  /** Animation frame interval per peer, ms (default 1000 / 60 both). */
  frameMs?: [number, number];
  /** The guest starts its match this much later, ms (default: one-way latency, like a "start" message). */
  startOffsetMs?: number;
  /** Stalls that begin before this tick are reported apart (start-up and the first delay adaptation). Default 300. */
  warmupTicks?: number;
  /** Flip state on one peer after `tick` (default: nudge player 4's x by 0.5 m). */
  injectDesync?: { peer: 0 | 1; tick: number; mutate?: (s: SimState) => void };
  /** Change link conditions mid-run. */
  linkChanges?: { atMs: number; conditions: MemoryLinkConditions }[];
  /** Freeze one peer's frame loop for `ms` at `atMs` (a GC pause or a busy main thread). */
  hiccups?: { peer: 0 | 1; atMs: number; ms: number }[];
  compress?: 'auto' | 'gzip' | 'none';
  /** Diagnostics.log compatible sink for both peers (peer index in the message). */
  log?: (kind: string, message: string, data?: unknown) => void;
  /** After every tick of either peer. */
  onTick?: (peer: number, s: SimState, frames: readonly InputFrame[]) => void;
  /** Virtual-time safety cap, ms (default: enough for maxTicks or the match at 4x slowdown + 60 s). */
  maxVirtualMs?: number;
  /**
   * Mirror loopMath.endFrame exactly (true, default: a stalled frame keeps up to MAX_TICKS_PER_FRAME ticks of
   * backlog and catches up afterwards) or drop the backlog of stalled frames (false: the proposed loop change that
   * lets the leading peer settle behind its partner instead of stalling periodically).
   */
  stallCatchUp?: boolean;
}

export interface NetsimPeerReport {
  ticks: number;
  finalHash: number;
  finished: boolean;
  /** Stall episodes (a frame with ticks due but no input), total and after warmupTicks. */
  stalls: number;
  stallsAfterWarmup: number;
  maxStallMs: number;
  maxStallAfterWarmupMs: number;
  totalStallMs: number;
  desyncs: number;
  firstDesyncTick: number;
  resyncs: number;
  lastResyncTick: number;
  verified: number;
  delayFinal: number;
  delayMin: number;
  delayMax: number;
  /** Agreed delay switches (identical on both peers when every announcement arrived in time). */
  switches: DelaySwitch[];
  lateDelaySwitches: number;
  rttMs: number;
  jitterMs: number;
  /** Time sync: final advantage (ticks ahead), holds and ticks shed. */
  advantage: number;
  holds: number;
  heldTicks: number;
  packetsSent: number;
  resends: number;
  duplicateFrames: number;
}

export interface NetsimReport {
  host: NetsimPeerReport;
  guest: NetsimPeerReport;
  /** Both peers reached POST_MATCH (or maxTicks). */
  finished: boolean;
  /** Same tick and same hashState at the end. */
  hashesEqual: boolean;
  /** Both peers handed the sim identical frames for every tick both simulated. */
  framesEqual: boolean;
  firstFrameMismatch: number;
  endPhase: number;
  goals: [number, number];
  virtualMs: number;
  wallMs: number;
  link: { hostToGuest: MemoryLinkStats; guestToHost: MemoryLinkStats };
  injectedAtTick: number;
  /** Clean run: finished, hashes and frames equal, and every desync (if any) repaired and verified. */
  ok: boolean;
}

// ---------------------------------------------------------------- config & inputs

export function netsimConfig(o: { seed?: number; halfMinutes?: number; homeClub?: number; awayClub?: number } = {}): MatchConfig {
  const c = createMatchConfig();
  c.seed = (o.seed ?? 1) >>> 0;
  c.halfMinutes = o.halfMinutes ?? 2;
  if (o.homeClub !== undefined) c.homeClub = o.homeClub;
  if (o.awayClub !== undefined) c.awayClub = o.awayClub;
  const human = (side: number) => ({
    kind: ControllerKind.HUMAN, side, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0,
  });
  c.humans = [human(0), human(1)];
  c.startPhase = MatchPhase.KICK_OFF;
  return c;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRESS_BUTTONS = [Btn.PASS, Btn.SHOOT, Btn.LOB, Btn.THROUGH, Btn.MOD_L, Btn.SHIELD, Btn.PASS, Btn.SHOOT];

/**
 * Scripted human: wanders the stick (new direction every 20-60 ticks), holds sprint half the time, taps action
 * buttons for 1-12 ticks (4 % of ticks), and skips cut-scenes (Btn.SKIP + Command.SKIP every other tick).
 */
export function createScriptedSource(seed: number, mode: 'random' | 'idle' = 'random'): InputSource {
  const r = mulberry32(seed);
  let dirLeft = 0;
  let mx = 0;
  let mz = 0;
  let sprint = false;
  let pressBtn = 0;
  let pressLeft = 0;
  return {
    id: `netsim-${seed}`,
    kind: 'net',
    sample(out: InputFrame, ctx: InputSampleContext) {
      if (CUTSCENE_PHASES.includes(ctx.state.match.phase) && ctx.tick % 2 === 0) {
        out.buttons |= Btn.SKIP;
        out.cmd = Command.SKIP;
      }
      if (mode === 'idle') return;
      if (--dirLeft <= 0) {
        dirLeft = 20 + Math.floor(r() * 40);
        const a = r() * Math.PI * 2;
        const mag = r() < 0.15 ? 0 : 120;
        mx = Math.round(Math.cos(a) * mag);
        mz = Math.round(Math.sin(a) * mag);
        sprint = r() < 0.5;
      }
      out.mx = mx;
      out.mz = mz;
      if (sprint) out.buttons |= Btn.SPRINT;
      if (pressLeft > 0) {
        out.buttons |= pressBtn;
        pressLeft--;
      } else if (r() < 0.04) {
        pressBtn = PRESS_BUTTONS[Math.floor(r() * PRESS_BUTTONS.length)]!;
        pressLeft = 1 + Math.floor(r() * 12);
      }
    },
    releaseAll() {
      pressLeft = 0;
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------- harness

interface Peer {
  idx: number;
  transport: NetTransport;
  state: SimState;
  provider: LockstepProvider | null;
  timing: LoopTiming;
  frames: InputFrame[];
  events: EventBuffer;
  startAt: number;
  nextFrameAt: number;
  frameMs: number;
  finished: boolean;
  inStall: boolean;
  stallBeganMs: number;
  stalls: number;
  stallsAfterWarmup: number;
  maxStallMs: number;
  maxStallAfterWarmupMs: number;
  stallAfterWarmup: boolean;
  totalStallMs: number;
  frameHash: number[];
  delayMin: number;
  delayMax: number;
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function peerReport(p: Peer): NetsimPeerReport {
  const pr = p.provider!;
  const s = pr.stats;
  const g = pr.guard.stats;
  return {
    ticks: p.state.tick, finalHash: hashState(p.state), finished: p.finished,
    stalls: p.stalls, stallsAfterWarmup: p.stallsAfterWarmup, maxStallMs: p.maxStallMs,
    maxStallAfterWarmupMs: p.maxStallAfterWarmupMs, totalStallMs: p.totalStallMs,
    desyncs: g.desyncs, firstDesyncTick: g.firstDesyncTick, resyncs: g.resyncs, lastResyncTick: g.lastResyncTick, verified: g.verified,
    delayFinal: pr.delay, delayMin: p.delayMin, delayMax: p.delayMax, switches: pr.adaptive.switches.map((x) => ({ ...x })),
    lateDelaySwitches: s.lateDelaySwitches, rttMs: s.rttMs, jitterMs: s.jitterMs, advantage: s.advantage, holds: s.holds,
    heldTicks: s.heldTicks, packetsSent: s.packetsSent, resends: s.resends,
    duplicateFrames: s.duplicateFrames,
  };
}

/** Run two peers until both finish (POST_MATCH or maxTicks). */
export async function runNetsim(opts: NetsimOptions): Promise<NetsimReport> {
  const wall0 = Date.now();
  const link = opts.link ?? {};
  const clock = createManualClock();
  const pair = createMemoryTransportPair({ ...link, now: clock.now, schedule: clock.schedule });
  const warmup = opts.warmupTicks ?? 300;
  const inputSeed = (opts.inputSeed ?? opts.config.seed) >>> 0;
  const frameMs = opts.frameMs ?? [TICK_MS, TICK_MS];
  const latency = link.latencyMs ?? 0;
  const maxTicks = opts.maxTicks ?? Infinity;
  const matchTicks = Number.isFinite(maxTicks) ? maxTicks : Math.round(opts.config.halfMinutes * 2 * 3600 * 1.6);
  const maxVirtualMs = opts.maxVirtualMs ?? matchTicks * TICK_MS * 4 + 60_000;
  const changes = (opts.linkChanges ?? []).slice().sort((a, b) => a.atMs - b.atMs);
  const hiccups = (opts.hiccups ?? []).map((h) => ({ ...h, done: false }));

  // Open both ends of the link.
  let opened = false;
  let openError: unknown = null;
  Promise.all([pair.host.open('host', 'NETSIM'), pair.guest.open('guest', 'NETSIM')]).then(
    () => { opened = true; },
    (err: unknown) => { openError = err; },
  );
  for (let i = 0; !opened && openError === null && i < 20_000; i++) {
    clock.advance(1);
    await Promise.resolve();
  }
  if (!opened) throw new Error(`netsim: link did not open (${String(openError)})`);
  // The lobby: both sides are connected for a while before anyone taps Ready (pings measure the round trip).
  const lobbyMs = Math.max(0, opts.lobbyMs ?? 3000);
  for (let ms = 0; ms < lobbyMs; ms += 50) clock.advance(50);
  const delay = opts.delay ?? (pair.host.rtt > 0 ? computeTargetDelay(pair.host.rtt, pair.host.jitter) : T_NET.delayInitial);

  const t0 = clock.now();
  const peers: Peer[] = [0, 1].map((idx) => {
    const frames: InputFrame[] = [];
    for (let h = 0; h < MAX_HUMANS; h++) frames.push(createInputFrame());
    const startAt = t0 + (idx === 1 ? opts.startOffsetMs ?? latency : 0);
    return {
      idx, transport: idx === 0 ? pair.host : pair.guest, state: initMatch(opts.config), provider: null, timing: createLoopTiming(),
      frames, events: createEventBuffer(), startAt, nextFrameAt: startAt, frameMs: frameMs[idx]!, finished: false, inStall: false,
      stallBeganMs: 0, stalls: 0, stallsAfterWarmup: 0, maxStallMs: 0, maxStallAfterWarmupMs: 0, stallAfterWarmup: false,
      totalStallMs: 0, frameHash: [], delayMin: Infinity, delayMax: 0,
    };
  });
  let injectedAtTick = -1;
  const inject = opts.injectDesync;

  const startPeer = (p: Peer): void => {
    p.provider = createLockstepProvider({
      transport: p.transport, localHuman: p.idx, delay, adaptive: opts.adaptive, timeSync: opts.timeSync, isHost: p.idx === 0,
      localSources: [createScriptedSource(inputSeed * 2 + p.idx + 1, opts.inputs ?? 'random')], compress: opts.compress,
      log: opts.log ? (kind, message, data) => opts.log!(kind, `[peer ${p.idx}] ${message}`, data) : undefined,
    });
  };

  const runFrame = (p: Peer, now: number): void => {
    const pr = p.provider!;
    pr.pump(now);
    if (p.finished) return; // keep pumping: the other peer may still need resends
    const due = beginFrame(p.timing, now);
    let ran = 0;
    let stalled = false;
    const s = p.state;
    while (ran < due) {
      if (s.tick >= maxTicks) {
        p.finished = true;
        break;
      }
      if (!pr.ready(s.tick + 1)) {
        stalled = true;
        break;
      }
      pr.take(s.tick + 1, p.frames, s);
      const t = s.tick + 1; // after a possible resync
      step(s, p.frames, p.events);
      ran++;
      p.frameHash[t] = (hashInputFrame(p.frames[0]!) * 31 + hashInputFrame(p.frames[1]!)) >>> 0;
      const d = pr.delay;
      if (d < p.delayMin) p.delayMin = d;
      if (d > p.delayMax) p.delayMax = d;
      if (inject && inject.peer === p.idx && injectedAtTick < 0 && s.tick === inject.tick) {
        if (inject.mutate) inject.mutate(s);
        else s.players[4]!.x += 0.5;
        injectedAtTick = s.tick;
      }
      opts.onTick?.(p.idx, s, p.frames);
      if (s.match.phase === MatchPhase.POST_MATCH) {
        p.finished = true;
        break;
      }
    }
    endFrame(p.timing, ran, stalled);
    if (stalled && opts.stallCatchUp === false) p.timing.acc = 0;
    if (stalled && !p.inStall) {
      p.inStall = true;
      p.stallBeganMs = now;
      p.stalls++;
      p.stallAfterWarmup = s.tick >= warmup;
      if (p.stallAfterWarmup) p.stallsAfterWarmup++;
    } else if (p.inStall && (ran > 0 || p.finished)) {
      p.inStall = false;
      const dur = now - p.stallBeganMs;
      p.totalStallMs += dur;
      if (dur > p.maxStallMs) p.maxStallMs = dur;
      if (p.stallAfterWarmup && dur > p.maxStallAfterWarmupMs) p.maxStallAfterWarmupMs = dur;
    }
  };

  let ci = 0;
  for (;;) {
    const t = Math.min(peers[0]!.nextFrameAt, peers[1]!.nextFrameAt);
    clock.advanceTo(t);
    while (ci < changes.length && t - t0 >= changes[ci]!.atMs) pair.configure(changes[ci++]!.conditions);
    for (const p of peers) {
      if (p.nextFrameAt > t) continue;
      if (!p.provider) startPeer(p);
      runFrame(p, t);
      p.nextFrameAt += p.frameMs;
      for (const h of hiccups) {
        if (!h.done && h.peer === p.idx && t - t0 >= h.atMs) {
          h.done = true;
          p.nextFrameAt += h.ms;
        }
      }
    }
    for (let i = 0; i < 10_000 && peers.some((p) => p.provider?.guard.busy); i++) await settle();
    if (peers[0]!.finished && peers[1]!.finished) break;
    if (t - t0 > maxVirtualMs) break;
  }

  const [hp, gp] = peers as [Peer, Peer];
  const host = peerReport(hp);
  const guest = peerReport(gp);
  let firstFrameMismatch = -1;
  const upto = Math.min(hp.state.tick, gp.state.tick);
  for (let t = 1; t <= upto; t++) {
    if (hp.frameHash[t] !== gp.frameHash[t]) {
      firstFrameMismatch = t;
      break;
    }
  }
  const finished = hp.finished && gp.finished;
  const hashesEqual = hp.state.tick === gp.state.tick && host.finalHash === guest.finalHash;
  const framesEqual = firstFrameMismatch < 0;
  const desyncs = host.desyncs + guest.desyncs;
  const repaired = desyncs === 0 || (host.resyncs > 0 && guest.resyncs > 0 && host.verified > 0);
  for (const p of peers) p.provider!.dispose();
  pair.host.close();
  pair.guest.close();
  return {
    host, guest, finished, hashesEqual, framesEqual, firstFrameMismatch, endPhase: hp.state.match.phase,
    goals: [hp.state.teams[0]!.goals, hp.state.teams[1]!.goals], virtualMs: clock.now() - t0, wallMs: Date.now() - wall0,
    link: { hostToGuest: { ...pair.stats.hostToGuest }, guestToHost: { ...pair.stats.guestToHost } }, injectedAtTick,
    ok: finished && hashesEqual && framesEqual && repaired,
  };
}

/** One-line summary of a report. */
export function formatNetsimReport(r: NetsimReport): string {
  const p = (x: NetsimPeerReport): string =>
    `ticks ${x.ticks} stalls ${x.stalls} (after warmup ${x.stallsAfterWarmup}, max ${x.maxStallAfterWarmupMs.toFixed(0)} ms; ` +
    `max overall ${x.maxStallMs.toFixed(0)} ms) desyncs ${x.desyncs} resyncs ${x.resyncs} delay ${x.delayMin}..${x.delayMax} ` +
    `(final ${x.delayFinal}) rtt ${x.rttMs.toFixed(0)}±${x.jitterMs.toFixed(0)} ms resends ${x.resends} ` +
    `holds ${x.holds} (${x.heldTicks} ticks, adv ${x.advantage.toFixed(2)})`;
  const l = r.link;
  return [
    `netsim ${r.ok ? 'OK' : 'FAIL'}: finished ${r.finished} hashesEqual ${r.hashesEqual} framesEqual ${r.framesEqual} ` +
      `goals ${r.goals[0]}-${r.goals[1]} virtual ${(r.virtualMs / 1000).toFixed(1)} s wall ${(r.wallMs / 1000).toFixed(1)} s`,
    `  host:  ${p(r.host)}`,
    `  guest: ${p(r.guest)}`,
    `  link: inputs dropped ${l.hostToGuest.inputsDropped + l.guestToHost.inputsDropped}/` +
      `${l.hostToGuest.inputsSent + l.guestToHost.inputsSent}, reliable retransmits ` +
      `${l.hostToGuest.reliableRetransmits + l.guestToHost.reliableRetransmits}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2), {
    halves: 'number', latency: 'number', jitter: 'number', loss: 'number', dup: 'number', reorder: 'number',
    bandwidth: 'number', seed: 'number', delay: 'number', fixed: 'boolean', 'max-ticks': 'number', 'desync-tick': 'number',
    json: 'boolean', 'no-catch-up': 'boolean', offset: 'number', lobby: 'number',
  });
  const num = (k: string, d: number): number => (typeof flags[k] === 'number' ? (flags[k] as number) : d);
  const seed = num('seed', 1);
  const loss = num('loss', 0.05);
  const desyncTick = num('desync-tick', -1);
  const r = await runNetsim({
    config: netsimConfig({ seed, halfMinutes: num('halves', 2) }),
    link: {
      latencyMs: num('latency', 80), jitterMs: num('jitter', 20), loss, reliableLoss: loss, duplicate: num('dup', 0),
      reorder: num('reorder', 0), bandwidthBytesPerSec: num('bandwidth', 0), seed,
    },
    delay: typeof flags.delay === 'number' ? (flags.delay as number) : undefined,
    lobbyMs: num('lobby', 3000),
    adaptive: flags.fixed !== true,
    maxTicks: typeof flags['max-ticks'] === 'number' ? (flags['max-ticks'] as number) : undefined,
    injectDesync: desyncTick >= 0 ? { peer: 1, tick: desyncTick } : undefined,
    stallCatchUp: flags['no-catch-up'] !== true,
    startOffsetMs: typeof flags.offset === 'number' ? (flags.offset as number) : undefined,
  });
  console.log(flags.json === true ? JSON.stringify(r, null, 2) : formatNetsimReport(r));
  process.exitCode = r.ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
