/**
 * SIM-16 switching allocates nothing per tick. SIM-04 ticksToReach is replaced by an arithmetic stand-in so the
 * measurement covers this module only (in V8 a call into a non-inlined function boxes its double arguments; that
 * engine artefact does not exist on JavaScriptCore). Heap is measured with gc exposed via v8 flags.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { AssistLevel, AutoSwitch, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { switchTick } from '../../src/sim/control/switching';

vi.mock('../../src/sim/players/locomotion', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/sim/players/locomotion')>();
  return {
    ...orig,
    ticksToReach: (s: SimState, slot: number, x: number, z: number): number => {
      const p = s.players[slot]!;
      const dx = x - p.x, dz = z - p.z;
      return Math.ceil((Math.sqrt(dx * dx + dz * dz) / 8) * 60);
    },
  };
});

function budgetState(): SimState {
  const cfg = createMatchConfig();
  cfg.humans = [
    { kind: ControllerKind.HUMAN, side: 0, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AUTO, fastPower: 0 },
    { kind: ControllerKind.HUMAN, side: 1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
  ];
  const s = initMatch(cfg);
  s.match.phase = MatchPhase.IN_PLAY;
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    p.x = -45 + (i % 11) * 9;
    p.z = (i < 11 ? -1 : 1) * (4 + (i % 5) * 5);
    p.vx = (i % 3) - 1;
    p.vz = (i % 2) - 0.5;
  }
  return s;
}

/** Situation k: 0 opponent carrier (path sampling), 1 loose ground ball, 2 air ball. */
function budgetSituation(s: SimState, k: number): void {
  const b = s.ball;
  if (k === 0) {
    const p = s.players[19]!;
    p.vx = -6; p.vz = 1;
    b.owner = 19; b.heldBy = -1; b.x = p.x; b.z = p.z; b.y = 0.11; b.passTarget = -1;
  } else if (k === 1) {
    b.owner = -1; b.heldBy = -1; b.x = 5; b.z = 3; b.y = 0.11; b.vx = -9; b.vz = 2; b.vy = 0; b.grounded = 1;
    b.lastTouchTeam = 1; b.passTarget = -1; b.shotBy = -1;
  } else {
    b.owner = -1; b.heldBy = -1; b.x = 30; b.z = -5; b.y = 1.2; b.vx = -20; b.vz = 3; b.vy = 9; b.grounded = 0;
    b.lastTouchTeam = 1; b.passTarget = -1; b.shotBy = -1;
  }
  b.lastTouchTick = s.tick;
}

function budgetRun(s: SimState, n: number, k: number, ev = createEventBuffer(), withSwitching = true): void {
  for (let i = 0; i < n; i++) {
    s.tick++;
    budgetSituation(s, k);
    ev.begin(s.tick);
    for (let c = 0; c < 4; c++) {
      const ctl = s.ctrl[c]!;
      if (ctl.kind === ControllerKind.NONE) continue;
      ctl.prevButtons = ctl.buttons;
      ctl.buttons = i % 40 === 0 ? Btn.MOD_L : 0;
      if (withSwitching) switchTick(s, c, ev);
    }
  }
}

describe('SIM-16 allocation', () => {
  it('switchTick allocates nothing per tick (carrier, loose ball, air ball, manual presses)', () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const s = budgetState();
    const ev = createEventBuffer();
    const n = 20000;
    const measure = (k: number, withSwitching: boolean): number => {
      budgetRun(s, 5000, k, ev, withSwitching);
      gc();
      const h0 = process.memoryUsage().heapUsed;
      budgetRun(s, n, k, ev, withSwitching);
      return (process.memoryUsage().heapUsed - h0) / n;
    };
    const got: string[] = [];
    let worst = 0;
    for (const k of [0, 1, 2]) {
      // The harness's own double stores into state fields can allocate in V8: subtract that baseline.
      const base = measure(k, false);
      const bytes = measure(k, true) - base;
      got.push(`situation ${k}: ${bytes.toFixed(1)} B/tick (baseline ${base.toFixed(1)})`);
      if (bytes > worst) worst = bytes;
    }
    // An object or array per tick would be >= 16 bytes per tick; allow GC/JIT noise below that.
    expect(worst, got.join('; ')).toBeLessThan(16);
  }, 120_000);
});
