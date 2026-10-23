/**
 * [QF-7R] The match's second live state (MatchRuntime.prev, refreshed by copyState(prev, curr) every tick and read by
 * the renderer every frame) has the live state's own hidden classes (src/app/liveState.ts; BRIEF section 13 "No
 * allocation in hot paths", "Heap growth in play: none that is steady").
 *
 * Regression for: the session built prev with sim/core/clone.ts's cloneState, whose `out = {}; out[k] = v` copies made
 * every nested object of prev (22 players, 22 attribute sets, ball, match, teams, controllers) a dictionary-mode object
 * in V8 (measured in the live Chromium page: %HasFastProperties(curr.players[0]) true, prev false). Every read of prev
 * was then a hash lookup on a map curr does not share (render interpolation, replay recording: the replay ring's
 * record(prev) alone allocated 8.6 KB per frame in Chromium, 1.1 KB after this fix). Probe:
 * tests/unit/qf-7r-live-state-probe.ts (a real match started through the app session; V8 natives in a child process).
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMatchConfig } from '../../src/contracts/state';
import { cloneLiveState } from '../../src/app/liveState';
import { copyState, diffState } from '../../src/sim/core/clone';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { createEventBuffer } from '../../src/sim/core/events';
import { createInputFrame } from '../../src/contracts/input';
import { ALLOC_FLAGS } from '../perf/qf-7r-alloc-flags';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function runLiveStateProbe(): { shapes: Record<string, { fast: boolean; same: boolean }> } {
  const r = spawnSync(process.execPath, [
    '--allow-natives-syntax', ...ALLOC_FLAGS, '--expose-gc', '--import', 'tsx', 'tests/unit/qf-7r-live-state-probe.ts', 'shapes',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 200_000 });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as ReturnType<typeof runLiveStateProbe>;
}

describe('QF-7R live prev state', () => {
  it('prev of a match started by the session has fast properties and curr\'s hidden class in every nested object', () => {
    const res = runLiveStateProbe();
    console.log(`QF-7R live state: ${JSON.stringify(res)}`);
    expect(Object.keys(res.shapes).sort()).toEqual(expect.arrayContaining(['attrs[]', 'ball', 'ctrl[]', 'match', 'players[]', 'teams[]']));
    for (const [k, v] of Object.entries(res.shapes)) {
      expect(v.fast, `${k}: prev in dictionary mode`).toBe(true);
      expect(v.same, `${k}: prev's hidden class differs from curr's`).toBe(true);
    }
  }, 240_000);

  it('cloneLiveState copies every value (hash and diff equal) and stays a valid copyState target over live play', () => {
    const cfg = createMatchConfig();
    cfg.seed = 7;
    const curr = initMatch(cfg);
    const prev = cloneLiveState(curr);
    expect(prev).not.toBe(curr);
    expect(prev.players[0]).not.toBe(curr.players[0]);
    expect(prev.config).toBe(curr.config);
    expect(prev.squads).toBe(curr.squads);
    expect(hashState(prev)).toBe(hashState(curr));
    expect(diffState(prev, curr)).toBeNull();
    const frames = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    for (let i = 0; i < 600; i++) {
      copyState(prev, curr);
      step(curr, frames, ev);
    }
    copyState(prev, curr);
    expect(hashState(prev)).toBe(hashState(curr));
    expect(diffState(prev, curr)).toBeNull();
  });
});
