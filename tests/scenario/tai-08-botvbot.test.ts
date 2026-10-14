/**
 * TAI-08 (with TAI-11) bot v bot quick runs through the real step() pipeline: both teams are CPU brains (cpuCarrier on
 * the ball, cpuDefend off it) acting only through their InputFrames, with every real module as it is in the tree.
 * The one exception is optional: TAI-10 estimateXg can be swapped for the contract double of tai-08-helpers (XG.double)
 * because while TAI-10 is a Wave-1 stub (xG always 0) the CPU never shoots; the run with the double proves the carrier
 * shoots once it gets an xG. Rough stats are printed for the lead's report (BRIEF §7 targets: goals 2.0-3.6, shots
 * 14-26 per match, possession 40-60 %, pass completion 70-88 %); assertions stay loose because SIM-14 tackles, SIM-10/11
 * lob / through kicks and TAI-10 are still stubs in places.
 */
import { describe, expect, it, vi } from 'vitest';

const XG = vi.hoisted(() => ({ double: false }));

vi.mock('../../src/ai/cpu/shooting', async (orig) => {
  const real = await orig<typeof import('../../src/ai/cpu/shooting')>();
  const h = await import('./tai-08-helpers');
  return {
    ...real,
    estimateXg: (s: import('../../src/contracts/state').SimState, slot: number, x: number, z: number): number =>
      XG.double ? h.xgDouble(s, slot, x, z) : real.estimateXg(s, slot, x, z),
  };
});

import { CPU_CONTROLLER_BASE, HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { estimateXg } from '../../src/ai/cpu/shooting';
import { hashState } from '../../src/sim/core/hash';
import { makeScenario, runTicks, type ScenarioPlayer } from '../harness/scenario';
import { resetCtl } from './tai-08-helpers';

const PASS_KINDS = new Set<number>([
  KickKind.GROUND_PASS, KickKind.DRIVEN_PASS, KickKind.DINKED_PASS, KickKind.LOB_PASS, KickKind.HIGH_LOB,
  KickKind.DRIVEN_LOB, KickKind.CROSS, KickKind.GROUND_CROSS, KickKind.LOW_CROSS, KickKind.THROUGH_GROUND,
  KickKind.THROUGH_LOBBED, KickKind.THROUGH_DINKED,
]);

interface Stats {
  ticks: number; inPlay: number; passes: number; completed: number; shots: number; onTarget: number; goals: number;
  tackles: number; tacklePresses: number; possession: [number, number]; possChanges: number; illegal: number; hash: number;
}

function botMatch(seed: number, ticks: number): Stats {
  resetCtl();
  const s: SimState = makeScenario({ humans: 0, seed });
  const st: Stats = {
    ticks, inPlay: 0, passes: 0, completed: 0, shots: 0, onTarget: 0, goals: 0, tackles: 0, tacklePresses: 0,
    possession: [0, 0], possChanges: 0, illegal: 0, hash: 0,
  };
  const prev = [0, 0];
  const events = runTicks(s, ticks, undefined, {
    until: (state) => {
      if (state.match.phase === MatchPhase.IN_PLAY) {
        st.inPlay++;
        const o = state.ball.owner;
        if (o >= 0) st.possession[state.players[o]!.team]!++;
      }
      for (let t = 0; t < 2; t++) {
        const f = state.teams[t]!.cpu.out;
        if (Math.hypot(f.mx, f.mz) > 127.5 || !Number.isInteger(f.mx) || !Number.isInteger(f.mz)) st.illegal++;
        const o = state.ball.owner;
        const defending = o < 0 || state.players[o]!.team !== t;
        if (defending && (f.buttons & Btn.SHOOT) !== 0 && (prev[t]! & Btn.SHOOT) === 0 && o >= 0) st.tacklePresses++;
        prev[t] = f.buttons;
      }
      return false;
    },
  });
  for (const e of events) {
    if (e.type === EventType.KICK && PASS_KINDS.has(e.b)) st.passes++;
    else if (e.type === EventType.PASS_COMPLETE) st.completed++;
    else if (e.type === EventType.SHOT) { st.shots++; if (e.b === 1) st.onTarget++; }
    else if (e.type === EventType.GOAL) st.goals++;
    else if (e.type === EventType.TACKLE) st.tackles++;
    else if (e.type === EventType.POSSESSION) st.possChanges++;
  }
  st.hash = hashState(s);
  return st;
}

function report(name: string, st: Stats): void {
  const own = st.possession[0] + st.possession[1];
  const min = st.ticks / 3600;
  console.log(
    `[TAI-08 bot v bot] ${name}: ${min.toFixed(1)} min, passes ${st.passes} (${(st.passes / min).toFixed(1)}/min), ` +
    `completion ${st.passes ? ((100 * st.completed) / st.passes).toFixed(0) : '-'}%, shots ${st.shots} (on target ` +
    `${st.onTarget}), goals ${st.goals}, possession ${own ? ((100 * st.possession[0]) / own).toFixed(0) : '-'}% / ` +
    `${own ? ((100 * st.possession[1]) / own).toFixed(0) : '-'}%, possession changes ${st.possChanges}, tackle presses ` +
    `${st.tacklePresses}, tackles ${st.tackles}`,
  );
}

/** True when TAI-10's estimateXg is live (a clean shot from the penalty spot is worth something). */
function xgLive(): boolean {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 1 });
  const x = s.teams[0]!.dir * (HALF_LENGTH - 11);
  s.players[9]!.x = x; s.players[9]!.z = 0;
  return estimateXg(s, 9, x, 0) > 0;
}

/** Layout for the scripted attack: team 0 (+x) carrier 9 at the edge of the final third, team 1's back four wide. */
const ATTACK: [number, number][] = [
  [-51, 0], [-35, -25], [-38, -8], [-38, 8], [-35, 25], [-25, -15], [-25, 0], [-25, 15], [28, -18], [30, 2], [28, 18],
  [51, 0], [42, -24], [41, -12], [41, 12], [42, 24], [25, -15], [25, 0], [25, 15], [15, -20], [15, 0], [15, 20],
];

/** CPU v CPU from a promising position: ticks until team 0's first SHOT event (-1 = none within maxTicks). */
function attackUntilShot(seed: number, maxTicks: number): { shotTick: number; shooterTeam: number } {
  resetCtl();
  const players: ScenarioPlayer[] = [];
  for (let i = 0; i < 22; i++) {
    const [x, z] = ATTACK[i]!;
    players.push({ slot: i, x, z, vx: i === 9 ? 3 : 0, vz: 0, fx: i < 11 ? 1 : -1, fz: 0, homeX: x, homeZ: z });
  }
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: 0, seed, players,
    ball: { x: 30.6, y: 0.11, z: 2, owner: 9, ownerT: 100, lastTouch: 9, lastTouchTeam: 0 },
  });
  s.ctrl[CPU_CONTROLLER_BASE]!.slot = 9; s.players[9]!.ctrl = CPU_CONTROLLER_BASE;
  let shotTick = -1, shooterTeam = -1;
  runTicks(s, maxTicks, undefined, {
    check: 'core',
    until: (st, evs) => {
      for (const e of evs) if (e.type === EventType.SHOT && shotTick < 0) { shotTick = st.tick; shooterTeam = st.players[e.a]!.team; }
      return shotTick >= 0;
    },
  });
  return { shotTick, shooterTeam };
}

describe('TAI-08 bot v bot quick runs', () => {
  it('whole matches with the real modules: passes (most completed), tackle presses, legal frames; stats reported', () => {
    XG.double = false;
    const runs = [botMatch(1, 10800), botMatch(9, 10800)];
    let presses = 0;
    runs.forEach((st, i) => {
      report(`seed ${i === 0 ? 1 : 9}, real modules (xG ${xgLive() ? 'live' : 'stub'})`, st);
      expect(st.illegal).toBe(0);
      expect(st.inPlay).toBeGreaterThan(5400);
      expect(st.passes).toBeGreaterThanOrEqual(20);
      expect(st.completed / st.passes).toBeGreaterThan(0.5);
      expect(st.possession[0]).toBeGreaterThan(0);
      expect(st.possession[1]).toBeGreaterThan(0);
      presses += st.tacklePresses;
    });
    expect(presses).toBeGreaterThan(0);
  }, 120_000);

  it('CPU v CPU from the edge of the box: the carrier shoots (real xG when live, else the TAI-10 contract double)', () => {
    XG.double = !xgLive();
    try {
      for (const seed of [1, 2, 3]) {
        const r = attackUntilShot(seed, 300);
        expect(r.shotTick, `seed ${seed}`).toBeGreaterThan(0);
        expect(r.shooterTeam).toBe(0);
      }
    } finally {
      XG.double = false;
    }
  }, 60_000);

  it('deterministic: the same seed gives the same match (state hash and stats)', () => {
    XG.double = false;
    const a = botMatch(3, 1800);
    const b = botMatch(3, 1800);
    expect(b).toEqual(a);
  }, 60_000);
});
