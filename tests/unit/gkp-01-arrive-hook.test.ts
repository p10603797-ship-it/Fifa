/**
 * GKP-01: keeperPositioning steers through ai/steer arrive() (TAI-07) once it is implemented, and writes the ARRIVE
 * intent itself while arrive() is a stub. Here arrive() is mocked to behave like an implementation.
 */
import { describe, expect, it, vi } from 'vitest';
import { ControllerKind } from '../../src/contracts/enums';
import { createMatchConfig, MoveMode, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';

const calls: { slot: number; x: number; z: number; speed: number; modeSeen: number; prevTgtX: number }[] = [];
let implemented = true;

// [QF-2] The rest of ai/steer stays real: GKP-03 (keeper/sweeper.ts, loaded through the action registry) builds its
// intercept estimate with createInterceptEstimate at module load, and a mock without it failed to import.
vi.mock('../../src/ai/steer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ai/steer')>()),
  assignChaser: () => undefined,
  executeJobs: () => undefined,
  arrive: (s: SimState, slot: number, x: number, z: number, speed: number) => {
    const p = s.players[slot]!;
    calls.push({ slot, x, z, speed, modeSeen: p.moveMode, prevTgtX: p.tgtX });
    if (!implemented) return;
    // An implementation with a dead zone: keeps the old target when the new one is within 0.1 m.
    p.moveMode = MoveMode.ARRIVE;
    if (Math.hypot(x - p.tgtX, z - p.tgtZ) > 0.1) { p.tgtX = x; p.tgtZ = z; }
    p.tgtSpeed = speed * 0.9;
    p.lookAt = 0;
    p.wantSprint = 1;
  },
}));

const { idealKeeperSpot, keeperPositioning } = await import('../../src/sim/keeper/positioning');

function setup(): SimState {
  const cfg = createMatchConfig();
  cfg.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
  ];
  const s = initMatch(cfg);
  s.ball.x = -36; s.ball.z = 8;
  return s;
}

describe('GKP-01 arrive() hook', () => {
  const ev = createEventBuffer();

  it('uses an implemented arrive(): its target/speed stand, the previous target is visible to it, facing stays ours', () => {
    implemented = true;
    calls.length = 0;
    const s = setup();
    const p = s.players[0]!;
    const o = { x: 0, z: 0 };
    idealKeeperSpot(s, 0, o);
    p.x = o.x + 1; p.z = o.z; p.tgtX = o.x + 0.05; p.tgtZ = o.z; // previous target within the dead zone
    keeperPositioning(s, 0, ev);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slot).toBe(0);
    expect(calls[0]!.x).toBe(o.x);
    expect(calls[0]!.z).toBe(o.z);
    expect(calls[0]!.prevTgtX).toBe(o.x + 0.05);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.tgtX).toBe(o.x + 0.05); // arrive's dead zone kept the old target
    expect(p.tgtSpeed).toBeCloseTo(calls[0]!.speed * 0.9, 12);
    // Keeper-specific facing and pace override whatever arrive() chose.
    expect(p.lookAt).toBe(1);
    expect(p.wantSprint).toBe(0);
    expect(p.lookX).toBe(s.ball.x);
  });

  it('writes the ARRIVE intent itself while arrive() is a stub', () => {
    implemented = false;
    calls.length = 0;
    const s = setup();
    const p = s.players[0]!;
    p.moveMode = MoveMode.ARRIVE; p.tgtX = 0; p.tgtZ = 0; p.tgtSpeed = 0; // stale intent from an earlier tick
    keeperPositioning(s, 0, ev);
    const o = { x: 0, z: 0 };
    idealKeeperSpot(s, 0, o);
    expect(calls).toHaveLength(1);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.tgtX).toBe(o.x);
    expect(p.tgtZ).toBe(o.z);
    expect(p.tgtSpeed).toBe(calls[0]!.speed);
    expect(p.lookAt).toBe(1);
  });
});
