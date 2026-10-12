import { describe, expect, it, vi } from 'vitest';
import { MAX_FRAME_MS, MAX_TICKS_PER_FRAME } from '../../src/contracts/constants';
import type { FrameInfo, StatsTracker, TickInputProvider } from '../../src/contracts/app';
import { createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createLoop } from '../../src/app/loop';
import {
  alphaOf, beginFrame, createLoopTiming, endFrame, resetLoopTiming, snapFrameMs, TICK_MS, type LoopTiming,
} from '../../src/app/loopMath';
import { createNullRenderer } from '../../src/app/nullRenderer';
import type { MatchRuntime } from '../../src/app/types';
import { createEventBuffer } from '../../src/sim/core/events';
import type { EventBuffer } from '../../src/contracts/events';

/** Run frames at a fixed refresh rate for `durationMs`; returns the total ticks. */
function runAt(hz: number, durationMs: number, t: LoopTiming = createLoopTiming(), start = 1000): number {
  const interval = 1000 / hz;
  let ticks = 0;
  const frames = Math.round(durationMs / interval);
  for (let i = 0; i <= frames; i++) {
    const due = beginFrame(t, start + i * interval);
    ticks += due;
    endFrame(t, due, false);
  }
  return ticks;
}

describe('FND-04 loop timing (pure)', () => {
  it('runs the same number of ticks at 60 Hz and 120 Hz over 2 s', () => {
    const t60 = runAt(60, 2000);
    const t120 = runAt(120, 2000);
    expect(t60).toBe(120);
    expect(t120).toBe(120);
  });

  it('keeps real-time speed at other refresh rates (30, 90, 144 Hz)', () => {
    for (const hz of [30, 90, 144]) {
      const ticks = runAt(hz, 2000);
      expect(Math.abs(ticks - 120)).toBeLessThanOrEqual(1);
    }
  });

  it('tolerates rAF timestamp jitter at 60 Hz without losing or gaining ticks', () => {
    const t = createLoopTiming();
    let now = 0;
    let ticks = 0;
    const pattern = [16, 17, 17, 16.5, 16.9, 16.4];
    let elapsed = 0;
    beginFrame(t, now);
    for (let i = 0; i < 600; i++) {
      const dt = pattern[i % pattern.length]!;
      now += dt;
      elapsed += dt;
      const due = beginFrame(t, now);
      ticks += due;
      endFrame(t, due, false);
    }
    expect(Math.abs(ticks - elapsed / TICK_MS)).toBeLessThanOrEqual(1.01);
  });

  it('snaps intervals close to whole and half ticks only', () => {
    expect(snapFrameMs(16.6)).toBeCloseTo(TICK_MS, 9);
    expect(snapFrameMs(8.4)).toBeCloseTo(TICK_MS / 2, 9);
    expect(snapFrameMs(33.2)).toBeCloseTo(TICK_MS * 2, 9);
    expect(snapFrameMs(11.1)).toBe(11.1);
    expect(snapFrameMs(20)).toBe(20);
  });

  it('clamps a long frame to MAX_FRAME_MS and runs at most MAX_TICKS_PER_FRAME', () => {
    const t = createLoopTiming();
    beginFrame(t, 0);
    const due = beginFrame(t, 500);
    expect(t.dtMs).toBe(MAX_FRAME_MS);
    expect(t.rawDtMs).toBe(500);
    expect(due).toBe(MAX_TICKS_PER_FRAME);
    endFrame(t, due, false);
    // The backlog beyond whole ticks is dropped: the next normal frame runs one tick, not a burst.
    expect(t.acc).toBeLessThan(TICK_MS);
    expect(beginFrame(t, 500 + TICK_MS)).toBe(1);
  });

  it('never fast-forwards after a reset (resume / page shown again)', () => {
    const t = createLoopTiming();
    runAt(60, 500, t, 0);
    resetLoopTiming(t);
    // 10 s later (the page was hidden): the first frame adds nothing.
    expect(beginFrame(t, 10_500)).toBe(0);
    endFrame(t, 0, false);
    expect(beginFrame(t, 10_500 + TICK_MS)).toBe(1);
  });

  it('treats negative or NaN intervals as zero', () => {
    const t = createLoopTiming();
    beginFrame(t, 100);
    expect(beginFrame(t, 50)).toBe(0);
    expect(beginFrame(t, Number.NaN)).toBe(0);
    expect(t.acc).toBeGreaterThanOrEqual(0);
  });

  it('keeps at most one frame of ticks while stalled (lockstep wait)', () => {
    const t = createLoopTiming();
    beginFrame(t, 0);
    for (let i = 1; i <= 30; i++) {
      beginFrame(t, i * TICK_MS);
      endFrame(t, 0, true);
    }
    expect(t.acc).toBeLessThanOrEqual(MAX_TICKS_PER_FRAME * TICK_MS + 1e-9);
    const due = beginFrame(t, 31 * TICK_MS);
    expect(due).toBe(MAX_TICKS_PER_FRAME);
  });

  it('alpha stays within [0, 1]', () => {
    const t = createLoopTiming();
    beginFrame(t, 0);
    for (let i = 1; i < 200; i++) {
      const due = beginFrame(t, i * 7.3);
      endFrame(t, due, false);
      const a = alphaOf(t);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------- loop with fakes

interface FakeState { tick: number; copiedFrom: number }

function makeHarness(opts: { ready?: (tick: number) => boolean; stepThrows?: boolean } = {}) {
  const curr = { tick: 0, copiedFrom: -1 } as unknown as SimState & FakeState;
  const prev = { tick: 0, copiedFrom: -1 } as unknown as SimState & FakeState;
  const events = createEventBuffer();
  const provider: TickInputProvider = {
    ready: opts.ready ?? (() => true),
    take: vi.fn(),
    pump: vi.fn(),
    waiting: false,
    releaseAll: vi.fn(),
    dispose: vi.fn(),
  };
  const stats: StatsTracker = { reset: vi.fn(), onTick: vi.fn(), summary: vi.fn() as never };
  const rt: MatchRuntime = { prev, curr, provider, frames: [createInputFrame(), createInputFrame()], events, stats };
  const session = { paused: false, ticking: true, hasRuntime: true, runtime: () => (session.hasRuntime ? rt : null), afterTick: vi.fn() };
  const renderer = createNullRenderer();
  const render = vi.spyOn(renderer, 'render');
  const onEvents = vi.spyOn(renderer, 'onEvents');
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: false, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const onFrame = vi.fn((f: FrameInfo) => void f);
  const router = { current: 'match' as const, currentScreen: () => ({ id: 'match' as const, mount() {}, unmount() {}, onFrame }) };
  const menuInput = { poll: vi.fn() };
  const onError = vi.fn();
  let stepCount = 0;
  const step = vi.fn((s: SimState, _frames: unknown, ev: EventBuffer) => {
    if (opts.stepThrows) throw new Error('boom');
    s.tick++;
    stepCount++;
    ev.begin(s.tick);
    if (s.tick % 2 === 0) ev.emit(0);
  });
  const copyState = vi.fn((dst: SimState, src: SimState) => {
    (dst as unknown as FakeState).tick = src.tick;
    (dst as unknown as FakeState).copiedFrom = src.tick;
  });
  const loop = createLoop({
    session, renderer, hud, audio, router, menuInput, getProjector: () => null, onError, step, copyState,
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  return { loop, session, rt, curr, prev, provider, render, onEvents, hud, audio, menuInput, onFrame, onError, step, copyState, stats, get stepCount() { return stepCount; } };
}

describe('FND-04 game loop', () => {
  it('copies curr into prev before every tick and steps with provider frames', () => {
    const h = makeHarness();
    h.loop.frame(0);
    h.loop.frame(TICK_MS * 2);
    expect(h.stepCount).toBe(2);
    expect(h.copyState).toHaveBeenCalledTimes(2);
    expect(h.prev.tick).toBe(1); // prev = state before the latest tick
    expect(h.curr.tick).toBe(2);
    expect(h.provider.take).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.provider.take).mock.calls[0]![0]).toBe(1);
    expect(h.stats.onTick).toHaveBeenCalledTimes(2);
    expect(h.session.afterTick).toHaveBeenCalledTimes(2);
  });

  it('dispatches events to renderer, HUD and audio only for ticks that have events', () => {
    const h = makeHarness();
    h.loop.frame(0);
    h.loop.frame(TICK_MS * 3); // ticks 1..3, events on tick 2 only
    expect(h.onEvents).toHaveBeenCalledTimes(1);
    expect(h.hud.onEvents).toHaveBeenCalledTimes(1);
    expect(h.audio.onEvents).toHaveBeenCalledTimes(1);
  });

  it('runs the same ticks at 60 Hz and 120 Hz through the real loop', () => {
    const a = makeHarness();
    const b = makeHarness();
    for (let i = 0; i <= 120; i++) a.loop.frame(i * (1000 / 60));
    for (let i = 0; i <= 240; i++) b.loop.frame(i * (1000 / 120));
    expect(a.stepCount).toBe(120);
    expect(b.stepCount).toBe(120);
  });

  it('holds the sim while the provider is not ready', () => {
    let allow = 2;
    const h = makeHarness({ ready: (tick) => tick <= allow });
    h.loop.frame(0);
    for (let i = 1; i <= 10; i++) h.loop.frame(i * TICK_MS);
    expect(h.stepCount).toBe(2);
    expect(h.loop.stats.stalled).toBe(true);
    allow = 1000;
    h.loop.frame(11 * TICK_MS);
    // Catches up by at most one frame's worth of ticks.
    expect(h.stepCount).toBe(2 + MAX_TICKS_PER_FRAME);
  });

  it('does not tick or fast-forward while paused, and renders only when invalidated', () => {
    const h = makeHarness();
    h.loop.frame(0);
    h.loop.frame(TICK_MS);
    expect(h.stepCount).toBe(1);
    const renders = h.render.mock.calls.length;
    h.session.paused = true;
    h.session.ticking = false;
    for (let i = 2; i < 300; i++) h.loop.frame(i * TICK_MS);
    expect(h.stepCount).toBe(1);
    expect(h.render.mock.calls.length).toBe(renders);
    h.loop.invalidate();
    h.loop.frame(300 * TICK_MS);
    expect(h.render.mock.calls.length).toBe(renders + 1);
    // Resume: the first frame after resuming adds no time.
    h.session.paused = false;
    h.session.ticking = true;
    h.loop.frame(301 * TICK_MS);
    expect(h.stepCount).toBe(1);
    h.loop.frame(302 * TICK_MS);
    expect(h.stepCount).toBe(2);
  });

  it('polls menu input, calls screen.onFrame and audio.update every frame', () => {
    const h = makeHarness();
    h.session.hasRuntime = false;
    h.session.ticking = false;
    for (let i = 0; i < 5; i++) h.loop.frame(i * 16);
    expect(h.menuInput.poll).toHaveBeenCalledTimes(5);
    expect(h.onFrame).toHaveBeenCalledTimes(5);
    expect(h.audio.update).toHaveBeenCalledTimes(5);
    expect(h.audio.update.mock.calls[4]![0]).toBeNull();
    expect(h.render).not.toHaveBeenCalled();
  });

  it('reports a throwing tick and keeps running frames', () => {
    const h = makeHarness({ stepThrows: true });
    h.loop.frame(0);
    h.loop.frame(TICK_MS);
    expect(h.onError).toHaveBeenCalledTimes(1);
    h.session.ticking = false;
    h.loop.frame(TICK_MS * 2);
    expect(h.menuInput.poll).toHaveBeenCalled();
  });

  it('records frame stats and supports reset()', () => {
    const h = makeHarness();
    for (let i = 0; i < 10; i++) h.loop.frame(i * TICK_MS);
    const s = h.loop.stats;
    expect(s.totalTicks).toBe(9);
    expect(s.sampleTicks).toBe(9);
    expect(s.frame).toBe(10);
    expect(s.fps).toBeGreaterThan(55);
    s.reset();
    expect(s.sampleTicks).toBe(0);
    expect(s.simMsMax).toBe(0);
  });

  it('renders a newly loaded match once even if it starts paused', () => {
    const h = makeHarness();
    h.session.paused = true;
    h.session.ticking = false;
    h.loop.frame(0);
    expect(h.render).toHaveBeenCalledTimes(1);
    h.loop.frame(16);
    expect(h.render).toHaveBeenCalledTimes(1);
  });
});
