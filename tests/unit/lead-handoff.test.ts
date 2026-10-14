/**
 * Command.HAND_TO_CPU (D-019): a human hands their side to its CPU brain through the frame; deterministic, and the
 * match keeps running with the CPU playing that side.
 */
import { describe, expect, it } from 'vitest';
import { Command, ControllerKind } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

function run(handAt: number, ticks: number) {
  const cfg = createMatchConfig();
  cfg.seed = 77;
  const s = initMatch(cfg);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  for (let t = 0; t < ticks; t++) {
    frames[0] = createInputFrame();
    if (t === handAt) {
      frames[0].cmd = Command.HAND_TO_CPU;
      frames[0].cmdArg = 0;
    }
    step(s, frames, ev);
  }
  return s;
}

describe('HAND_TO_CPU', () => {
  it('turns the human controller off and activates the side CPU brain', () => {
    const s = run(120, 600);
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.NONE);
    expect(s.ctrl[2]!.kind).toBe(ControllerKind.CPU);
    expect(s.ctrl[2]!.side).toBe(0);
    expect(s.teams[0]!.cpu.active).toBe(1);
    for (const p of s.players) expect(p.ctrl).not.toBe(0);
  });

  it('is deterministic', () => {
    expect(hashState(run(200, 900))).toBe(hashState(run(200, 900)));
  });
});
