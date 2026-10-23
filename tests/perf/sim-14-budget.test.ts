/**
 * SIM-14 — the tackle / interception contact stages and the tackle / down-state handlers allocate nothing per tick and
 * stay cheap. A busy scene is looped: four tacklers (stand, hard, slide, push) held in their contact windows without
 * reaching ball or man, two down players (lying-body scan), a pass in flight beside two defenders (full candidate scan,
 * no entry) and the actions stage running every handler. Heap growth is the best of several windows after a warm-up.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { actionsTick } from '../../src/sim/actions/dispatch';
import { NULL_SINK } from '../../src/sim/core/events';
import { interceptContacts, knockDown, startTackle, tackleContacts } from '../../src/sim/defend/tackle';
import { P1, P2, owned, place, scene } from '../scenario/sim-14-helpers';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

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

describe('SIM-14 per-tick cost', () => {
  it('the contact stages and handlers allocate nothing per tick', () => {
    // [TUN-7S] Measured in a child process with --single-threaded (synchronous compilation: the same bytes whatever the
    // CPU load; tests/perf/qf-7r-alloc-flags.ts). In the Vitest worker this read 96 B/tick under load.
    const r = spawnSync(process.execPath, ['--single-threaded', '--expose-gc', '--import', 'tsx', 'tests/perf/tun-7s-sim-14-probe.ts'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { bytes } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytes: number };
    console.log(`SIM-14 busy contact scene: ${bytes.toFixed(2)} bytes per tick (best window)`);
    expect(bytes).toBeLessThan(4);
  }, 120_000);

  it('a busy scene costs a few microseconds per tick (best window)', () => {
    const s = setup();
    drive(s, 20000);
    let best = 1e9;
    for (let w = 0; w < 5; w++) {
      const t0 = performance.now();
      drive(s, 20000);
      const us = ((performance.now() - t0) / 20000) * 1000;
      if (us < best) best = us;
    }
    console.log(`SIM-14 busy contact scene: ${best.toFixed(3)} us per tick (best window)`);
    expect(best).toBeLessThan(25);
  }, 120_000);
});
