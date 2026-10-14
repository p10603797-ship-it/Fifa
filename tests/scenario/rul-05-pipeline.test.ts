/**
 * RUL-05 in the full pipeline, nothing mocked: TAI-13 CPU brains and set-piece layout, GKP-06 keeper, contacts, the
 * real (partly stubbed) kick modules. Free kicks at many spots for both teams are taken without the safety nets, the
 * wall stays legal (9.15 m) until the kick, every invariant holds, a defending human's wall jump / move work beside the
 * CPU, and the same seed and inputs give the same state hash.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, RESTART_DISTANCE } from '../../src/contracts/constants';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { awardRestart } from '../../src/sim/rules/restart';
import { WallMode } from '../../src/sim/rules/freekick';
import { step } from '../../src/sim/step';
import { makeScenario, type ScenarioHuman, type ScenarioInputs } from '../harness/scenario';

const GX = HALF_LENGTH;

function copyEvent(e: Readonly<SimEvent>): SimEvent {
  return { type: e.type, tick: e.tick, a: e.a, b: e.b, c: e.c, d: e.d, x: e.x, y: e.y, z: e.z };
}

interface Trace {
  events: SimEvent[];
  readyTick: number;
  kickTick: number;
  minWallDist: number;
}

/** Award a free kick and run the real pipeline (every invariant checked) until `after` ticks past the kick. */
function play(team: number, x: number, z: number, opts: { humans?: ScenarioHuman[] | number; seed?: number;
  inputs?: ScenarioInputs; after?: number; max?: number } = {}): { s: SimState; t: Trace } {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: opts.humans ?? 0, seed: opts.seed ?? 5 });
  const events = createEventBuffer();
  events.begin(s.tick);
  awardRestart(s, RestartKind.FREE_KICK, team, x, z, events);
  const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker('all');
  const t: Trace = { events: [], readyTick: -1, kickTick: -1, minWallDist: Infinity };
  const r = s.match.restart;
  const max = opts.max ?? 1200;
  for (let i = 0; i < max; i++) {
    for (const f of frames) Object.assign(f, createInputFrame());
    if (opts.inputs) opts.inputs(s.tick + 1, s, frames);
    step(s, frames, events);
    for (let k = 0; k < events.count; k++) t.events.push(copyEvent(events.get(k)));
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (t.readyTick < 0 && r.ready === 1) t.readyTick = s.tick;
    if (s.match.phase === MatchPhase.FREE_KICK && r.ready === 1 && r.taken === 0) {
      for (let w = 0; w < r.wallCount; w++) {
        const p = s.players[r.wall[w]!]!;
        t.minWallDist = Math.min(t.minWallDist, Math.hypot(p.x - r.x, p.z - r.z));
      }
    }
    if (t.kickTick < 0 && r.taken === 1) t.kickTick = s.tick;
    if (t.kickTick >= 0 && s.tick - t.kickTick >= (opts.after ?? 60)) break;
  }
  return { s, t };
}

const SPOTS: readonly (readonly [number, number])[] = [
  [GX - 18, 0], [GX - 23, -7], [GX - 29, 12], [GX - 9, 26], [GX - 7, 2], [-5, 10], [GX - 34, -2],
];

describe('RUL-05 free kicks in the full pipeline', () => {
  it('bot v bot: every free kick is taken by the CPU in time, the wall keeps 9.15 m, no watchdog, invariants hold', () => {
    for (const team of [0, 1]) {
      for (const [x, z] of SPOTS) {
        const sx = team === 0 ? x : -x;
        const { s, t } = play(team, sx, z, { seed: 3 + team });
        const r = s.match.restart;
        const tag = `team ${team} at (${sx}, ${z})`;
        expect(t.readyTick, tag).toBeGreaterThan(0);
        expect(t.kickTick, tag).toBeGreaterThan(0);
        // TAI-13 or the RUL-05 CPU fallback: well before RUL-11's 4 s CPU watchdog.
        expect(t.kickTick - t.readyTick, tag).toBeLessThan(T_RULES.cpuRestartDelay + 120);
        const kick = t.events.find((e) => e.type === EventType.KICK && e.tick === t.kickTick)!;
        expect(kick, tag).toBeDefined();
        expect(s.players[kick.a]!.team, tag).toBe(team);
        expect(t.events.filter((e) => e.type === EventType.WATCHDOG), tag).toHaveLength(0);
        if (r.wallCount > 0) {
          // A wall at the goal line (kick closer than 9.15 m) is the one legal exception.
          const lineWall = HALF_LENGTH - Math.abs(r.x) < RESTART_DISTANCE;
          if (!lineWall) expect(t.minWallDist, tag).toBeGreaterThanOrEqual(RESTART_DISTANCE);
          for (let w = 0; w < r.wallCount; w++) expect(s.players[r.wall[w]!]!.team, tag).toBe(1 - team);
        }
        expect(s.match.phase === MatchPhase.IN_PLAY || s.match.phase !== MatchPhase.FREE_KICK, tag).toBe(true);
      }
    }
  });

  it('a defending human jumps and moves the wall while the CPU takes the kick', () => {
    let jumped = 0;
    let wallZ0 = Number.NaN;
    const { s, t } = play(0, GX - 21, 0, {
      humans: [{ side: 1 }],
      inputs: (tick, st, out) => {
        const r = st.match.restart;
        if (r.ready !== 1 || r.taken === 1) return;
        if (Number.isNaN(wallZ0)) wallZ0 = r.wallZ;
        if (tick - (st.tick - r.t + T_RULES.restartSetupTicks) < 20) out[0]!.buttons = Btn.SHIELD;
        // Jump as the CPU taker winds up his kick.
        const tk = st.players[r.taker]!;
        if (tk.act === ActionKind.KICK || tk.act === ActionKind.SHOT) out[0]!.buttons |= Btn.THROUGH;
      },
    });
    const r = s.match.restart;
    expect(t.kickTick).toBeGreaterThan(0);
    const moved = Math.abs(r.wallZ - wallZ0);
    for (const e of t.events) if (e.type === EventType.WALL && e.b === WallMode.JUMP) jumped++;
    expect(moved).toBeGreaterThan(0.3);
    expect(jumped).toBe(r.wallCount);
    expect(t.minWallDist).toBeGreaterThanOrEqual(RESTART_DISTANCE);
    expect(t.events.filter((e) => e.type === EventType.WATCHDOG)).toHaveLength(0);
  });

  it('determinism: the same seed and inputs give the same state hash', () => {
    const inputs: ScenarioInputs = (tick, st, out) => {
      if (st.match.restart.ready === 1 && tick % 7 === 0) out[0]!.buttons = Btn.SPRINT;
      if (tick % 11 === 0) { out[0]!.mx = 90; out[0]!.mz = -60; out[0]!.ax = -127; }
    };
    const a = play(0, GX - 24, 5, { humans: [{ side: 0 }], seed: 9, inputs, max: 400, after: 1000 }).s;
    const b = play(0, GX - 24, 5, { humans: [{ side: 0 }], seed: 9, inputs, max: 400, after: 1000 }).s;
    expect(hashState(a)).toBe(hashState(b));
    expect(a.tick).toBe(b.tick);
  });
});
