/**
 * [PLT-05] Live replay recorder and replay playback provider: a match recorded tick by tick from the real sim plays
 * back to the same hashes (playReplay and the session provider), a changed input is detected as a divergence, a
 * recorder that joins mid-match records nothing, the snapshot falls back to the last checkpoint when the live state
 * moved on, and attachReplayRecorder wraps the session's afterTick without breaking it.
 */
import { describe, expect, it } from 'vitest';
import type { SessionControl } from '../../src/contracts/app';
import { MAX_HUMANS } from '../../src/contracts/constants';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import type { MatchRuntime } from '../../src/app/types';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { playReplay, parseReplay } from '../../src/sim/replay';
import { step } from '../../src/sim/step';
import {
  attachReplayRecorder, createLiveReplayRecorder, createReplayInputProvider, describeReplayCheck, replayFileName,
  replayPlaybackProblem, replaySetup,
} from '../../src/platform/replayRecorder';

function frameFor(tick: number, f: InputFrame): void {
  // Deterministic, varied human input: stick sweeps and a sprint / pass pattern.
  f.mx = ((tick * 7) % 255) - 127;
  f.mz = ((tick * 13) % 255) - 127;
  f.buttons = (tick % 90 < 40 ? Btn.SPRINT : 0) | (tick % 120 === 60 ? Btn.PASS : 0);
}

function record(ticks: number, seed = 7) {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  const s = initMatch(cfg);
  const frames = [createInputFrame(), createInputFrame()];
  const ev = createEventBuffer();
  const rec = createLiveReplayRecorder({ chunkTicks: 50 });
  for (let t = 1; t <= ticks; t++) {
    frameFor(t, frames[0]!);
    step(s, frames, ev);
    rec.onTick(frames, s);
  }
  return { s, rec };
}

describe('PLT-05 live replay recorder', () => {
  it('records every tick into chunks and the snapshot replays to identical hashes', () => {
    const { s, rec } = record(400);
    expect(rec.ticks).toBe(400);
    expect(rec.recording).toBe(true);
    const replay = rec.snapshot()!;
    expect(replay).not.toBeNull();
    expect(replay.ticks).toBe(400);
    expect(replay.finalHash).toBe(hashState(s));
    expect(replay.hashes.length).toBe(Math.floor(400 / replay.hashInterval));
    // JSON round trip (the saved file) and the FND-06 playback agree.
    const back = parseReplay(JSON.stringify(replay));
    const pb = playReplay(back);
    expect(pb.divergedAt).toBe(-1);
    expect(pb.hash).toBe(replay.finalHash);
    expect(pb.squadsMatch).toBe(true);
    expect(rec.summary()).toContain('400 ticks');
  });

  it('the playback provider feeds the recorded frames and reports a match', () => {
    const { rec } = record(300);
    const replay = rec.snapshot()!;
    const results: string[] = [];
    const { setup, provider } = replaySetup(replay, { onResult: (c) => results.push(describeReplayCheck(c)) });
    expect(setup.bindings).toEqual([]);
    expect(setup.inputProvider).toBe(provider);
    const s = initMatch(setup.config);
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let t = 1; t <= replay.ticks + 30; t++) {
      expect(provider.ready(t)).toBe(true);
      provider.take(t, frames, s);
      step(s, frames, ev);
    }
    expect(provider.check.verdict).toBe('match');
    expect(provider.check.divergedAt).toBe(-1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatch(/^replay matched: 300 ticks/);
    // After the recording ends the humans send neutral frames.
    expect(frames[0]!.mx).toBe(0);
    expect(frames[0]!.buttons).toBe(0);
  });

  it('detects a divergence at the first checkpoint after changed inputs', () => {
    const { rec } = record(300);
    const replay = rec.snapshot()!;
    const p = createReplayInputProvider(replay);
    const s = initMatch(replay.config);
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let t = 1; t <= replay.ticks + 1; t++) {
      p.take(t, frames, s);
      if (t >= 100 && t < 220) { frames[0]!.mx = 127 - frames[0]!.mx; frames[0]!.buttons ^= Btn.SPRINT; } // corrupted input
      step(s, frames, ev);
    }
    expect(p.check.verdict).toBe('diverged');
    expect(p.check.divergedAt).toBeGreaterThanOrEqual(120);
    expect(p.check.divergedAt % replay.hashInterval === 0 || p.check.divergedAt === replay.ticks).toBe(true);
  });

  it('a recorder that joins mid-match records nothing until the next match', () => {
    const cfg = createMatchConfig();
    const s = initMatch(cfg);
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    const rec = createLiveReplayRecorder();
    for (let t = 1; t <= 20; t++) {
      step(s, frames, ev);
      if (t > 5) rec.onTick(frames, s);
    }
    expect(rec.ticks).toBe(0);
    expect(rec.snapshot()).toBeNull();
    expect(rec.problem).toBe('joined mid-match');
    // A new match starts recording at its first tick.
    const s2 = initMatch(cfg);
    step(s2, frames, ev);
    rec.onTick(frames, s2);
    expect(rec.ticks).toBe(1);
    expect(rec.problem).toBeNull();
  });

  it('a skipped tick stops the recording; the snapshot is the prefix up to the last checkpoint', () => {
    const { s, rec } = record(130);
    const frames = [createInputFrame(), createInputFrame()];
    step(s, frames, createEventBuffer()); // tick 131 not recorded
    step(s, frames, createEventBuffer());
    rec.onTick(frames, s); // tick 132
    expect(rec.recording).toBe(false);
    expect(rec.problem).toMatch(/tick 132 after 130/);
    const replay = rec.snapshot()!;
    expect(replay.ticks).toBe(120); // two checkpoints of 60
    expect(playReplay(replay).divergedAt).toBe(-1);
  });

  it('stops at the longest recording and keeps a valid prefix', () => {
    const cfg = createMatchConfig();
    const s = initMatch(cfg);
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    const rec = createLiveReplayRecorder({ maxTicks: 90, chunkTicks: 32 });
    for (let t = 1; t <= 100; t++) {
      step(s, frames, ev);
      rec.onTick(frames, s);
    }
    expect(rec.ticks).toBe(90);
    expect(rec.problem).toBe('longest recording reached');
    const replay = rec.snapshot()!;
    expect(replay.ticks).toBe(60);
    expect(playReplay(replay).divergedAt).toBe(-1);
  });

  it('replayPlaybackProblem rejects malformed files and other sim versions', () => {
    const { rec } = record(61);
    const replay = rec.snapshot()!;
    expect(replayPlaybackProblem(replay)).toBeNull();
    expect(replayPlaybackProblem({})).toMatch(/format/);
    expect(replayPlaybackProblem({ ...replay, frames: [1, 2, 3] })).toMatch(/frames length/);
    expect(replayPlaybackProblem({ ...replay, simVersion: 999 })).toMatch(/sim version 999/);
    expect(replayFileName(replay, '2026-10-14T10:00:00')).toBe(`dotkick-replay-7-61t-2026-10-14T10-00-00.json`);
  });

  it('attachReplayRecorder wraps afterTick, keeps the original call and detaches cleanly', () => {
    const calls: number[] = [];
    const session = {
      afterTick(rt: MatchRuntime) { calls.push(rt.curr.tick); },
    } as unknown as SessionControl & { afterTick(rt: MatchRuntime): void };
    const original = session.afterTick;
    const rec = createLiveReplayRecorder();
    const detach = attachReplayRecorder(session, rec)!;
    expect(detach).toBeTypeOf('function');
    const cfg = createMatchConfig();
    const curr = initMatch(cfg);
    const frames: InputFrame[] = [];
    for (let i = 0; i < MAX_HUMANS; i++) frames.push(createInputFrame());
    const rt = { prev: cloneState(curr), curr, frames, events: createEventBuffer() } as unknown as MatchRuntime;
    for (let t = 1; t <= 5; t++) {
      step(curr, frames, rt.events);
      session.afterTick(rt);
    }
    expect(calls).toEqual([1, 2, 3, 4, 5]);
    expect(rec.ticks).toBe(5);
    detach();
    expect(session.afterTick).toBe(original);
    expect(attachReplayRecorder({} as SessionControl, rec)).toBeNull();
  });

  it('a recorder that throws is reported once and never breaks the session tick', () => {
    const calls: number[] = [];
    const session = { afterTick() { calls.push(1); } } as unknown as SessionControl & { afterTick(rt: unknown): void };
    const errors: unknown[] = [];
    const bad = { ...createLiveReplayRecorder(), onTick() { throw new Error('boom'); } };
    attachReplayRecorder(session, bad, (e) => errors.push(e));
    session.afterTick({ frames: [], curr: { tick: 1 } as SimState });
    session.afterTick({ frames: [], curr: { tick: 2 } as SimState });
    expect(calls).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });
});
