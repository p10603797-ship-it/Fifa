/**
 * The single requestAnimationFrame loop (ARCHITECTURE rule 5, brief section 4). [FND-04]
 *
 * Every animation frame:
 *  1. beforeFrame hook (coalesced resize), input provider pump (pads, network) while a match exists.
 *  2. While the session is ticking: accumulator (loopMath) -> 0..3 ticks. Before each tick copyState(prev, curr);
 *     frames from the TickInputProvider (the sim is held while provider.ready(tick + 1) is false); step(); then the
 *     tick's events go to renderer, HUD, audio and stats; session.afterTick() watches phases.
 *  3. Render prev -> curr with alpha, HUD update. While paused only when invalidated (resize, context restore).
 *  4. audio.update, menu input poll, screen.onFrame.
 * Resuming (from pause, hidden page, loading) resets the accumulator, so missed time is never fast-forwarded.
 * Exceptions are caught per stage (input pump, ticks, each event consumer, render, HUD, audio, menu input,
 * screen.onFrame, hooks) and reported (recovery screen): the loop never stops, and a stage that throws every frame
 * never starves the stages after it (controller-only players can always operate the recovery screen).
 * No allocation per frame: FrameInfo, FrameStats and timing objects are created once.
 *
 * [INT-B] The tick's events also go to deps.rumble (pad rumble, after audio; its own try).
 * [QF-12] The default step is the plain sim step: the practice rules run inside the sim since QF-1 (sim/step
 * practiceRulesTick, sim/init preparePracticeState), so stepWithModes is that step under its INT-B name.
 */
import type { AudioEngine, FrameInfo, GameRenderer, HudPart } from '../contracts/app';
import { MAX_FRAME_MS } from '../contracts/constants';
import type { EventBuffer } from '../contracts/events';
import type { CameraProjector, InputFrame } from '../contracts/input';
import type { ReadonlySimState, SimState } from '../contracts/state';
import { copyState as simCopyState } from '../sim/core/clone';
import { step as simStep } from '../sim/step';
import { alphaOf, beginFrame, createLoopTiming, endFrame, resetLoopTiming } from './loopMath';
import type { AppRouter, FrameStats, LoopSession } from './types';

export type StepFn = (s: SimState, frames: readonly InputFrame[], events: EventBuffer) => void;
export type CopyStateFn = (dst: SimState, src: SimState) => void;

/**
 * One tick of every mode: the plain sim step (practice rules included, QF-1). Kept under the INT-B name for callers
 * and tests; it is the same function as src/sim/step.ts step.
 */
export const stepWithModes: StepFn = simStep;

export interface LoopDeps {
  session: LoopSession & { readonly paused: boolean };
  renderer: GameRenderer;
  hud: HudPart;
  audio: AudioEngine;
  router: Pick<AppRouter, 'current' | 'currentScreen'>;
  /** Pad rumble: the tick's events after audio (PAD-07 createRumbleListener). */
  rumble?: { onEvents(events: EventBuffer, state: ReadonlySimState): void } | null;
  /** Menu navigation (pads + keyboard -> MenuAction). Polled every frame. */
  menuInput?: { poll(nowMs: number): void } | null;
  getProjector(): CameraProjector | null;
  onError(err: unknown, where: string): void;
  /** Start of every frame (coalesced resize etc.). */
  beforeFrame?(frame: FrameInfo): void;
  /**
   * End of every frame: debug overlay, Low Power Mode detector. stats.busyMs = sim + render time this frame. [QF-7R]
   * The frame's numbers are read from `stats`, never passed as a number: a double argument to a call V8 does not
   * inline is boxed (a 16-byte heap allocation every frame).
   */
  afterFrame?(frame: FrameInfo, stats: Readonly<FrameStats>): void;
  /** Injected for tests; default src/sim/step.ts and src/sim/core/clone.ts. */
  step?: StepFn;
  copyState?: CopyStateFn;
  raf?: (cb: (t: number) => void) => number;
  caf?: (id: number) => void;
  /** High-resolution clock for sim/render timings (default performance.now). */
  now?: () => number;
}

export interface GameLoop {
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** Forget accumulated time (resume, page shown again): never fast-forward. */
  resetTiming(): void;
  /** Render on the next frame even while paused (resize, context restored, settings change). */
  invalidate(): void;
  /** Run one frame at `nowMs` (the rAF callback; tests call it directly). */
  frame(nowMs: number): void;
  readonly stats: FrameStats;
  readonly info: Readonly<FrameInfo>;
}

const FRAME_TIME_SAMPLES = 240;
const EMA = 0.1;

export interface FrameStatsRecorder {
  readonly stats: FrameStats;
  addSim(ms: number): void;
  addRender(ms: number): void;
}

/**
 * FrameStats plus its (allocation-free) recorders. [QF-7R] The running sums live in a Float64Array, not in closure
 * variables: a double stored in a closure variable is a new heap number every time (V8 boxes context slots).
 */
export function createFrameStats(): FrameStatsRecorder {
  const sums = new Float64Array(2); // [sim ms, render ms] since reset()
  const stats: FrameStats = {
    frame: 0, fps: 0, frameMs: 0, busyMs: 0, ticks: 0, totalTicks: 0,
    simMsLast: 0, simMsEma: 0, simMsAvg: 0, simMsMax: 0,
    renderMsLast: 0, renderMsEma: 0, renderMsAvg: 0, renderMsMax: 0,
    sampleTicks: 0, sampleFrames: 0, stalled: false,
    frameTimes: new Float32Array(FRAME_TIME_SAMPLES), head: 0,
    reset() {
      sums[0] = 0;
      sums[1] = 0;
      stats.simMsAvg = 0; stats.simMsMax = 0; stats.renderMsAvg = 0; stats.renderMsMax = 0;
      stats.sampleTicks = 0; stats.sampleFrames = 0;
    },
  };
  return {
    stats,
    addSim(ms) {
      stats.simMsLast = ms;
      stats.simMsEma = stats.simMsEma === 0 ? ms : stats.simMsEma + (ms - stats.simMsEma) * EMA;
      sums[0] = sums[0]! + ms;
      stats.sampleTicks++;
      stats.simMsAvg = sums[0]! / stats.sampleTicks;
      if (ms > stats.simMsMax) stats.simMsMax = ms;
    },
    addRender(ms) {
      stats.renderMsLast = ms;
      stats.renderMsEma = stats.renderMsEma === 0 ? ms : stats.renderMsEma + (ms - stats.renderMsEma) * EMA;
      sums[1] = sums[1]! + ms;
      stats.sampleFrames++;
      stats.renderMsAvg = sums[1]! / stats.sampleFrames;
      if (ms > stats.renderMsMax) stats.renderMsMax = ms;
    },
  };
}

export function createLoop(deps: LoopDeps): GameLoop {
  const step = deps.step ?? simStep;
  const copyState = deps.copyState ?? simCopyState;
  const raf = deps.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb));
  const caf = deps.caf ?? ((id: number) => cancelAnimationFrame(id));
  const clock = deps.now ?? (() => performance.now());
  const { session, renderer, hud, audio, router } = deps;

  const timing = createLoopTiming();
  const recorder = createFrameStats();
  const stats = recorder.stats;
  const info: FrameInfo = { nowMs: 0, dtMs: 0, frame: 0, ticks: 0, paused: false };
  let running = false;
  let rafId = 0;
  let hasLast = false;
  let wasTicking = false;
  let dirty = true;
  let lastRuntime: unknown = null;
  // [QF-7R] The loop's doubles that outlive a frame (timestamp of the previous frame, render alpha, smoothed frame
  // interval) live in a Float64Array: a double written to a closure variable is a new heap number on every write.
  const F = new Float64Array(3);
  const F_LAST_NOW = 0;
  const F_ALPHA = 1;
  const F_FRAME_EMA = 2;
  F[F_ALPHA] = 1;

  const onRaf = (t: number): void => {
    rafId = 0;
    if (!running) return;
    rafId = raf(onRaf);
    frame(t);
  };

  function frame(nowMs: number): void {
    // Real frame interval for menus, audio and stats (independent of the sim accumulator).
    let raw = hasLast ? nowMs - F[F_LAST_NOW]! : 0;
    if (!(raw > 0)) raw = 0;
    F[F_LAST_NOW] = nowMs;
    hasLast = true;
    info.nowMs = nowMs;
    // [QF-7R] `+`: an imported binding is untyped to V8; as one arm of the conditional it would box the other arm, a
    // heap number every frame (loopMath.ts beginFrame).
    info.dtMs = raw > MAX_FRAME_MS ? +MAX_FRAME_MS : raw;
    info.frame++;
    info.ticks = 0;
    info.paused = session.paused;
    let busy = 0;
    // Every stage has its own try: a stage that throws every frame (a Wave 1 source's pollFrame, an audio module, a
    // HUD part) is reported but never starves the stages after it. Menu input and screen.onFrame must keep running
    // so a controller-only player can always operate the recovery screen. Literal stage names: no allocation.
    if (deps.beforeFrame) {
      try {
        deps.beforeFrame(info);
      } catch (err) {
        deps.onError(err, 'loop.beforeFrame');
      }
    }
    const rt = session.runtime();
    if (rt) {
      try {
        rt.provider.pump(nowMs);
      } catch (err) {
        deps.onError(err, 'loop.pump');
      }
    }

    let ran = 0;
    let stalled = false;
    if (session.ticking && rt) {
      if (!wasTicking) resetLoopTiming(timing);
      wasTicking = true;
      const due = beginFrame(timing, nowMs);
      try {
        while (ran < due) {
          const next = rt.curr.tick + 1;
          if (!rt.provider.ready(next)) {
            stalled = true;
            break;
          }
          copyState(rt.prev, rt.curr);
          rt.provider.take(next, rt.frames, rt.curr);
          const t0 = clock();
          step(rt.curr, rt.frames, rt.events);
          const simMs = clock() - t0;
          recorder.addSim(simMs);
          busy += simMs;
          ran++;
          const ev = rt.events;
          if (ev.count > 0) {
            // Presentation consumers are independent modules: one failing never hides events from the others.
            try {
              renderer.onEvents(ev, rt.curr);
            } catch (err) {
              deps.onError(err, 'loop.renderer.onEvents');
            }
            try {
              hud.onEvents(ev, rt.curr);
            } catch (err) {
              deps.onError(err, 'loop.hud.onEvents');
            }
            try {
              audio.onEvents(ev, rt.curr);
            } catch (err) {
              deps.onError(err, 'loop.audio.onEvents');
            }
            if (deps.rumble) {
              try {
                deps.rumble.onEvents(ev, rt.curr);
              } catch (err) {
                deps.onError(err, 'loop.rumble.onEvents');
              }
            }
          }
          rt.stats.onTick(rt.curr, ev);
          session.afterTick(rt);
          if (!session.ticking) break;
        }
      } catch (err) {
        deps.onError(err, 'loop.tick');
      }
      endFrame(timing, ran, stalled);
      F[F_ALPHA] = alphaOf(timing);
      dirty = true;
    } else {
      wasTicking = false;
    }
    info.ticks = ran;
    stats.ticks = ran;
    stats.totalTicks += ran;
    stats.stalled = stalled;

    const live = session.runtime();
    if (live !== lastRuntime) {
      // A new match (or none): draw it at least once, even when it starts paused.
      lastRuntime = live;
      dirty = true;
      F[F_ALPHA] = 1;
    }
    if (live && dirty) {
      dirty = false;
      const t0 = clock();
      try {
        renderer.render(live.prev, live.curr, F[F_ALPHA]!, info);
      } catch (err) {
        deps.onError(err, 'loop.render');
      }
      try {
        hud.update(live.curr, info, deps.getProjector());
      } catch (err) {
        deps.onError(err, 'loop.hud');
      }
      const renderMs = clock() - t0;
      recorder.addRender(renderMs);
      busy += renderMs;
    }
    try {
      audio.update(live ? live.curr : null, info.dtMs / 1000);
    } catch (err) {
      deps.onError(err, 'loop.audio');
    }
    // Polled every frame so latched keys never go stale; boot swallows menu actions during live play.
    if (deps.menuInput) {
      try {
        deps.menuInput.poll(nowMs);
      } catch (err) {
        deps.onError(err, 'loop.menuInput');
      }
    }
    try {
      const screen = router.currentScreen();
      if (screen && screen.onFrame) screen.onFrame(info);
    } catch (err) {
      deps.onError(err, 'loop.screen');
    }
    stats.busyMs = busy;
    if (deps.afterFrame) {
      try {
        deps.afterFrame(info, stats);
      } catch (err) {
        deps.onError(err, 'loop.afterFrame');
      }
    }
    stats.frame = info.frame;
    stats.frameMs = raw;
    if (raw > 0) {
      const ema = F[F_FRAME_EMA]!;
      const next = ema === 0 ? raw : ema + (raw - ema) * EMA;
      F[F_FRAME_EMA] = next;
      stats.fps = 1000 / next;
      stats.frameTimes[stats.head] = raw;
      stats.head = (stats.head + 1) % FRAME_TIME_SAMPLES;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      hasLast = false;
      wasTicking = false;
      dirty = true;
      resetLoopTiming(timing);
      rafId = raf(onRaf);
    },
    stop() {
      running = false;
      if (rafId !== 0) caf(rafId);
      rafId = 0;
      wasTicking = false;
      resetLoopTiming(timing);
    },
    get running() {
      return running;
    },
    resetTiming() {
      wasTicking = false;
      resetLoopTiming(timing);
    },
    invalidate() {
      dirty = true;
    },
    frame,
    stats,
    info,
  };
}
