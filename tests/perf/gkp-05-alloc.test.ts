/**
 * [GKP-05] Per-tick keeper-handling paths allocate nothing (GK_HOLD update in every move mode, release wind-up,
 * canHandle); the release solver, run once per release at contact, creates no objects (only bounded V8 double boxing
 * inside the SIM-01 launch solver and deterministic trig). Measured in-process like tests/unit/sim-01-perf.test.ts:
 * min over four rounds after a long warm-up (JIT code objects land on the heap and are noise, not allocation).
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { KickKind } from '../../src/contracts/enums';
import { MoveMode } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { createEventBuffer } from '../../src/sim/core/events';
import {
  canHandle, holdHandler, solveKeeperRelease, startKeeperRelease, throwHandler,
} from '../../src/sim/keeper/handling';
import { KEEPER, MATE, keeperBall, keeperHolding, request, xAt } from '../unit/gkp-05-helpers';

function bytesPerCall(fn: () => void, n = 20000): number {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  for (let i = 0; i < n; i++) fn();
  let best = 1e9;
  for (let r = 0; r < 4; r++) {
    gc();
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < n; i++) fn();
    const b = (process.memoryUsage().heapUsed - h0) / n;
    if (b < best) best = b;
  }
  return best;
}

describe('GKP-05 allocation', () => {
  const ev = createEventBuffer();

  it('GK_HOLD update allocates nothing (stop, stick, arrival intents; at and away from the hold-box edges)', () => {
    for (const mode of [MoveMode.STOP, MoveMode.DIRECT, MoveMode.ARRIVE]) {
      for (const u of [0.3, 6]) {
        const { s } = keeperHolding({ u, humans: [{ side: 0, slot: KEEPER }] });
        const k = s.players[KEEPER]!;
        const fn = (): void => {
          s.tick++;
          k.actB = s.tick - 100;
          k.moveMode = mode; k.ix = -0.8; k.iz = 0.5; k.tgtX = -60; k.tgtZ = 30; k.tgtSpeed = 6;
          k.vx = -1.5; k.vz = 0.4;
          ev.begin(s.tick);
          holdHandler.update(s, KEEPER, ev);
        };
        const b = bytesPerCall(fn);
        expect(b, `mode ${mode} u ${u}: ${b.toFixed(2)} B/call`).toBeLessThan(8);
      }
    }
  }, 120_000);

  it('a release wind-up tick allocates nothing; canHandle allocates nothing', () => {
    const { s } = keeperHolding({ mate: { x: xAt(4) + 25, z: 6 } });
    startKeeperRelease(s, KEEPER, KickKind.GK_DROP_KICK, request({ targetSlot: MATE, power: 0.5 }), ev);
    const k = s.players[KEEPER]!;
    const wind = bytesPerCall(() => {
      s.tick++;
      k.actB = s.tick - 10;
      k.actT = 1 + (s.tick % 10);
      k.fx = 0; k.fz = 1;
      ev.begin(s.tick);
      throwHandler.update(s, KEEPER, ev);
    });
    expect(wind, `${wind.toFixed(2)} B/call`).toBeLessThan(8);
    const loose = keeperBall();
    const ch = bytesPerCall(() => { canHandle(loose, KEEPER); });
    expect(ch, `${ch.toFixed(2)} B/call`).toBeLessThan(8);
  }, 120_000);

  it('the release solver creates no objects (bounded boxing only, once per release)', () => {
    const out = createKickLaunch();
    for (const kind of [KickKind.GK_THROW, KickKind.GK_ROLL, KickKind.GK_DROP_KICK]) {
      const { s } = keeperHolding({ mate: { x: xAt(4) + 30, z: 4 } });
      startKeeperRelease(s, KEEPER, kind, request({ targetSlot: MATE, power: 0.6 }), ev);
      const b = bytesPerCall(() => { solveKeeperRelease(s, KEEPER, out); }, 4000);
      expect(b, `${KickKind[kind]}: ${b.toFixed(2)} B/call`).toBeLessThan(1024);
    }
  }, 120_000);
});
