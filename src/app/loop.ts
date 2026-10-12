/**
 * The single requestAnimationFrame loop (ARCHITECTURE rule 5, brief section 4). [FND-04]
 *
 * Every animation frame:
 *  1. beforeFrame hook (coalesced resize), input provider pump (pads, network) while a match exists.
 *  2. While the session is ticking: accumulator (loopMath) -> 0..3 ticks. Before each tick copyState(prev, curr);
 *     frames from the TickInputProvider (the sim is held while provider.ready(tick + 1) is false); step(); then the
 *     tick's events go to renderer, HUD, audio and stats; session.afterTick() watches phases.
 *  3. Render prev -> curr with alpha, HUD update. While paused only when invalidated (resize, context restore).
 *  4. audio.update, menu input poll (menus and the pause overlay, not during live play), screen.onFrame.
 * Resuming (from pause, hidden page, loading) resets the accumulator, so missed time is never fast-forwarded.
 * Exceptions are caught per frame and reported (recovery screen); the loop itself never stops on an error.
 * No allocation per frame: FrameInfo, FrameStats and timing objects are created once.
 */
import type { AudioEngine, FrameInfo, GameRenderer, HudPart } from '../contracts/app';
import { MAX_FRAME_MS } from '../contracts/constants';
import type { EventBuffer } from '../contracts/events';
import type { CameraProjector, InputFrame } from '../contracts/input';
import type { SimState } from '../contracts/state';
import { copyState as simCopyState } from '../sim/core/clone';
import { step as simStep } from '../sim/step';
import { alphaOf, beginFrame, createLoopTiming, endFrame, resetLoopTiming } from './loopMath';
import type { AppRouter, FrameStats, LoopSession } from './types';

export type StepFn = (s: SimState, frames: readonly InputFrame[], events: EventBuffer) => void;
export type CopyStateFn = (dst: SimState, src: SimState) => void;

export interface LoopDeps {
  session: LoopSession & { readonly paused: boolean };
  renderer: GameRenderer;
  hud: HudPart;
  audio: AudioEngine;
  router: Pick<AppRouter, 'current' | 'currentScreen'>;
  /** Menu navigation (pads + keyboard -> MenuAction). Polled except during live play. */
  menuInput?: { poll(nowMs: number): void } | null;
  getProjector(): CameraProjector | null;
  onError(err: unknown, where: string): void;
  /** Start of every frame (coalesced resize etc.). */
  beforeFrame?(frame: FrameInfo): void;
  /** End of every frame: debug overlay, Low Power Mode detector. busyMs = sim + render time this frame. */
  afterFrame?(frame: FrameInfo, busyMs: number): void;
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

/** FrameStats plus its (allocation-free) recorders. */
export function createFrameStats(): FrameStatsRecorder {
  let simSum = 0;
  let renderSum = 0;
  const stats: FrameStats = {
    frame: 0, fps: 0, frameMs: 0, ticks: 0, totalTicks: 0,
    simMsLast: 0, simMsEma: 0, simMsAvg: 0, simMsMax: 0,
    renderMsLast: 0, renderMsEma: 0, renderMsAvg: 0, renderMsMax: 0,
    sampleTicks: 0, sampleFrames: 0, stalled: false,
    frameTimes: new Float32Array(FRAME_TIME_SAMPLES), head: 0,
    reset() {
      simSum = 0;
      renderSum = 0;
      stats.simMsAvg = 0; stats.simMsMax = 0; stats.renderMsAvg = 0; stats.renderMsMax = 0;
      stats.sampleTicks = 0; stats.sampleFrames = 0;
    },
  };
  return {
    stats,
    addSim(ms) {
      stats.simMsLast = ms;
      stats.simMsEma = stats.simMsEma === 0 ? ms : stats.simMsEma + (ms - stats.simMsEma) * EMA;
      simSum += ms;
      stats.sampleTicks++;
      stats.simMsAvg = simSum / stats.sampleTicks;
      if (ms > stats.simMsMax) stats.simMsMax = ms;
    },
    addRender(ms) {
      stats.renderMsLast = ms;
      stats.renderMsEma = stats.renderMsEma === 0 ? ms : stats.renderMsEma + (ms - stats.renderMsEma) * EMA;
      renderSum += ms;
      stats.sampleFrames++;
      stats.renderMsAvg = renderSum / stats.sampleFrames;
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
  let lastNow = 0;
  let hasLast = false;
  let wasTicking = false;
  let dirty = true;
  let alpha = 1;
  let frameEma = 0;

  const onRaf = (t: number): void => {
    rafId = 0;
    if (!running) return;
    rafId = raf(onRaf);
    frame(t);
  };

  function frame(nowMs: number): void {
    // Real frame interval for menus, audio and stats (independent of the sim accumulator).
    let raw = hasLast ? nowMs - lastNow : 0;
    if (!(raw > 0)) raw = 0;
    lastNow = nowMs;
    hasLast = true;
    info.nowMs = nowMs;
    info.dtMs = raw > MAX_FRAME_MS ? MAX_FRAME_MS : raw;
    info.frame++;
    info.ticks = 0;
    info.paused = session.paused;
    let busy = 0;
    try {
      deps.beforeFrame?.(info);
      const rt = session.runtime();
      if (rt) rt.provider.pump(nowMs);

      let ticking = session.ticking;
      let ran = 0;
      let stalled = false;
      if (ticking && rt) {
        if (!wasTicking) resetLoopTiming(timing);
        wasTicking = true;
        const due = beginFrame(timing, nowMs);
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
            renderer.onEvents(ev, rt.curr);
            hud.onEvents(ev, rt.curr);
            audio.onEvents(ev, rt.curr);
          }
          rt.stats.onTick(rt.curr, ev);
          session.afterTick(rt);
          if (!session.ticking) break;
        }
        endFrame(timing, ran, stalled);
        alpha = alphaOf(timing);
        dirty = true;
        ticking = session.ticking;
      } else {
        wasTicking = false;
      }
      info.ticks = ran;
      stats.ticks = ran;
      stats.totalTicks += ran;
      stats.stalled = stalled;

      const live = session.runtime();
      if (live && dirty) {
        dirty = false;
        const t0 = clock();
        renderer.render(live.prev, live.curr, alpha, info);
        hud.update(live.curr, info, deps.getProjector());
        const renderMs = clock() - t0;
        recorder.addRender(renderMs);
        busy += renderMs;
      }
      audio.update(live ? live.curr : null, info.dtMs / 1000);
      if (deps.menuInput && !(ticking && router.current === 'match')) deps.menuInput.poll(nowMs);
      const screen = router.currentScreen();
      if (screen && screen.onFrame) screen.onFrame(info);
      deps.afterFrame?.(info, busy);
    } catch (err) {
      deps.onError(err, 'loop');
    }
    stats.frame = info.frame;
    stats.frameMs = raw;
    if (raw > 0) {
      frameEma = frameEma === 0 ? raw : frameEma + (raw - frameEma) * EMA;
      stats.fps = 1000 / frameEma;
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
