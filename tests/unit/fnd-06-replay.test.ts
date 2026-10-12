/**
 * FND-06: replay record and playback (brief section 14 point 4: "a saved replay plays back identically").
 */
import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { PACKED_FRAME_INTS } from '../../src/sim/core/serialize';
import { initMatch } from '../../src/sim/init';
import {
  createReplayRecorder, parseReplay, playReplay, REPLAY_HASH_INTERVAL, replayFramesAt, replayProblem, type Replay,
} from '../../src/sim/replay';
import { step } from '../../src/sim/step';
import { runMatch } from '../../tools/headless';

const TICKS = 1500;

function twoHumans(seed: number): MatchConfig {
  const c = createMatchConfig();
  c.seed = seed;
  c.halfMinutes = 2;
  c.humans = [
    { kind: 1, side: 0, assist: 0, autoSwitch: 1, fastPower: 0 },
    { kind: 1, side: 1, assist: 1, autoSwitch: 2, fastPower: 1 },
  ];
  return c;
}

/** Deterministic scripted input: stick sweeps, button taps and holds, the odd skill and gesture. */
function script(tick: number, _s: SimState, out: InputFrame[]): void {
  for (let h = 0; h < 2; h++) {
    const f = out[h]!;
    const phase = (tick + h * 37) % 240;
    f.mx = phase < 120 ? 127 : -90;
    f.mz = ((tick * 7) % 255) - 127;
    if (phase % 30 < 8) f.buttons |= Btn.PASS;
    if (phase > 200) f.buttons |= Btn.SPRINT | Btn.SHOOT;
    if (tick % 97 === 0) f.skill = 2;
    if (tick % 151 === 0) { f.gesture = 3; f.gx = 120; f.gz = -40; f.gdx = 90; f.gdz = 10; f.gPower = 80; }
  }
}

function recorded(seed = 7): { replay: Replay; hash: number } {
  const r = runMatch({ config: twoHumans(seed), inputs: script, maxTicks: TICKS, checker: 'none', record: true });
  expect(r.exception).toBeUndefined();
  return { replay: r.replay!, hash: r.hash };
}

describe('FND-06 replay', () => {
  it('records frames, checkpoint hashes and the final hash', () => {
    const { replay, hash } = recorded();
    expect(replay.simVersion).toBe(SIM_VERSION);
    expect(replay.ticks).toBe(TICKS);
    expect(replay.frames).toHaveLength(TICKS * PACKED_FRAME_INTS);
    expect(replay.hashes).toHaveLength(Math.floor(TICKS / REPLAY_HASH_INTERVAL));
    expect(replay.finalHash).toBe(hash);
    expect(replay.seed).toBe(7);
    expect(replayProblem(replay)).toBeNull();
  });

  it('record -> play gives the identical final hash and no divergence', () => {
    const { replay, hash } = recorded();
    const p = playReplay(replay);
    expect(p.divergedAt).toBe(-1);
    expect(p.hash).toBe(hash);
    expect(p.ticks).toBe(TICKS);
    expect(p.squadsMatch).toBe(true);
  });

  it('survives a JSON round trip (save / load) and plays back identically', () => {
    const { replay, hash } = recorded(11);
    const loaded = parseReplay(JSON.stringify(replay));
    const p = playReplay(loaded);
    expect(p.divergedAt).toBe(-1);
    expect(p.hash).toBe(hash);
  });

  it('reports the first diverging checkpoint when the seed is changed', () => {
    const { replay } = recorded();
    const bad: Replay = { ...replay, config: { ...replay.config, seed: replay.config.seed + 1 } };
    const p = playReplay(bad);
    expect(p.divergedAt).toBe(REPLAY_HASH_INTERVAL);
  });

  it('reports a tampered checkpoint and a tampered final hash at the right tick', () => {
    const { replay } = recorded();
    const hashes = replay.hashes.slice();
    hashes[4] = (hashes[4]! ^ 1) >>> 0;
    expect(playReplay({ ...replay, hashes }).divergedAt).toBe(5 * REPLAY_HASH_INTERVAL);
    expect(playReplay({ ...replay, finalHash: (replay.finalHash ^ 1) >>> 0 }).divergedAt).toBe(TICKS);
  });

  it('stopAtDivergence and maxTicks stop playback early; onTick sees every tick', () => {
    const { replay } = recorded();
    const bad: Replay = { ...replay, config: { ...replay.config, seed: 999 } };
    expect(playReplay(bad, undefined, { stopAtDivergence: true }).ticks).toBe(REPLAY_HASH_INTERVAL);
    let n = 0;
    const p = playReplay(replay, () => { n++; }, { maxTicks: 100 });
    expect(p.ticks).toBe(100);
    expect(n).toBe(100);
    expect(p.divergedAt).toBe(-1);
  });

  it('refuses another SIM_VERSION and malformed files', () => {
    const { replay } = recorded();
    expect(() => playReplay({ ...replay, simVersion: SIM_VERSION + 1 })).toThrow(/simVersion/);
    expect(() => parseReplay(JSON.stringify({ ...replay, frames: replay.frames.slice(1) }))).toThrow(/frames length/);
    expect(() => parseReplay('{"format":1}')).toThrow(SyntaxError);
    expect(replayProblem(null)).toBe('not an object');
  });

  it('replayFramesAt returns the frames recorded for a tick', () => {
    const { replay } = recorded();
    const out = [createInputFrame(), createInputFrame()];
    const expected = [createInputFrame(), createInputFrame()];
    const s = initMatch(twoHumans(7));
    for (const tick of [1, 97, 151, 1500]) {
      for (const f of expected) Object.assign(f, createInputFrame());
      script(tick, s, expected);
      replayFramesAt(replay, tick, out);
      expect(out).toEqual(expected);
    }
  });

  it('a recorder used manually matches the state hash and copies the config', () => {
    const config = twoHumans(3);
    const rec = createReplayRecorder(config);
    config.seed = 12345; // later edits must not leak into the replay
    const s = initMatch(twoHumans(3));
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < 200; i++) {
      frames[0]!.buttons = i % 3 === 0 ? Btn.PASS : 0;
      step(s, frames, ev);
      rec.record(frames, s);
    }
    const replay = rec.finish(s);
    expect(replay.config.seed).toBe(3);
    expect(replay.finalHash).toBe(hashState(s));
    expect(playReplay(replay).hash).toBe(hashState(s));
    expect(s.match.phase).toBeGreaterThanOrEqual(MatchPhase.PRE_MATCH);
  });

  it('a recorder detects out-of-sync use (record must follow every step)', () => {
    const s = initMatch(twoHumans(3));
    const rec = createReplayRecorder(s.config);
    s.tick = 5;
    expect(() => rec.record([createInputFrame(), createInputFrame()], s)).toThrow(/out|tick/);
  });
});
