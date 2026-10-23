/**
 * [TUN-7S] SIM-14 allocation probe, run by tests/perf/sim-14-budget.test.ts in a child process with deterministic
 * tiering (node --single-threaded --expose-gc --import tsx tests/perf/tun-7s-sim-14-probe.ts): the busy contact scene of
 * the SIM-14 budget test (four tacklers held in their contact windows, two down players, a pass in flight beside two
 * defenders, every handler) after a warm-up; prints the best-of-four-windows heap growth per tick as JSON. Measured in
 * the Vitest worker it was load sensitive (its SSR transform's getters, background compilation): 96 B/tick under load.
 */
import '../../tools/lib/env';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { NULL_SINK } from '../../src/sim/core/events';
import { interceptContacts, knockDown, startTackle, tackleContacts } from '../../src/sim/defend/tackle';
import { P1, P2, owned, place, scene } from '../scenario/sim-14-helpers';

const TACKLERS: [number, ActionKind][] = [
  [P2, ActionKind.STAND_TACKLE], [19, ActionKind.HARD_TACKLE], [18, ActionKind.SLIDE_TACKLE], [17, ActionKind.PUSH_PULL],
];

function setup(): SimState {
  const s = scene(1);
  place(s, P1, 0, 0, 1, 0);
  owned(s, P1, 0.5, 0);
  for (let i = 0; i < TACKLERS.length; i++) {
    const [slot, k] = TACKLERS[i]!;
    place(s, slot, 10 + i * 6, -10, 1, 0);
    if (startTackle(s, slot, k, k === ActionKind.PUSH_PULL ? P1 : -1, NULL_SINK) !== 1) throw new Error(`no ${ActionKind[k]}`);
  }
  place(s, 5, -20, 15, 1, 0);
  place(s, 6, -10, 15, 1, 0);
  knockDown(s, 5, ActionKind.FALLEN, NULL_SINK);
  knockDown(s, 6, ActionKind.STUMBLE, NULL_SINK);
  place(s, 16, 0, 22.5, -1, 0);
  place(s, 15, 3, 21.6, -1, 0);
  return s;
}

function drive(s: SimState, n: number): void {
  for (let i = 0; i < n; i++) {
    s.tick++;
    for (let t = 0; t < TACKLERS.length; t++) {
      const p = s.players[TACKLERS[t]![0]]!;
      p.act = TACKLERS[t]![1];
      p.actT = p.actContact + 1; p.actDone = 0; p.actA = 0; p.actDur = 60;
      p.x = 10 + t * 6; p.z = -10; p.vx = 0; p.vz = 0;
    }
    s.players[5]!.actT = 2;
    s.players[6]!.actT = 2;
    // a home pass beside two away defenders, never entering their reach (fields written directly: no allocation)
    const b = s.ball;
    b.x = -5 + (i % 40) * 0.25; b.px = b.x - 0.25; b.z = 20; b.pz = 20; b.y = 0.11; b.py = 0.11;
    b.vx = 15; b.vz = 0; b.vy = 0; b.owner = -1; b.heldBy = -1;
    b.lastTouch = 8; b.lastKickBy = 8; b.lastTouchTeam = 0; b.lastKickTeam = 0; b.lastKickKind = KickKind.GROUND_PASS;
    b.lastTouchTick = s.tick - 1; b.lastKickTick = s.tick - 1; b.touchedTick = s.tick - 1;
    actionsTick(s, NULL_SINK);
    tackleContacts(s, NULL_SINK);
    interceptContacts(s, NULL_SINK);
  }
}

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');
const s = setup();
drive(s, 20000);
let bytes = 1e9;
for (let w = 0; w < 4; w++) {
  gc();
  const h0 = process.memoryUsage().heapUsed;
  drive(s, 20000);
  const b = (process.memoryUsage().heapUsed - h0) / 20000;
  if (b < bytes) bytes = b;
}
console.log(JSON.stringify({ bytes }));
