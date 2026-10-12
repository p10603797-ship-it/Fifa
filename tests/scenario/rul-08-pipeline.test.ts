/**
 * RUL-08 offside through the real step() pipeline: rulesTick -> offsideTick ordering, real ball flight, the real
 * RUL-01 phase machine and RUL-11 restart flow (award, setup delay, legal positions, taken -> IN_PLAY).
 *
 * Mocked so only the test decides who touches the ball and nobody runs around:
 *  - team AI and CPU brains: no-ops (players stand where the test puts them);
 *  - contacts (SIM/GKP contact stages): replaced by a per-test hook that makes the kicks and receptions through
 *    the real sim/core/kick.ts helpers (applyKick / takePossession) at the contact stage of a tick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HALF_WIDTH, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick, takePossession } from '../../src/sim/core/kick';
import { INVARIANT_NAMES, createInvariantChecker } from '../../src/sim/debug/invariants';
import { isOffsidePosition } from '../../src/sim/rules/offside';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { makeScenario } from '../harness/scenario';

const H = vi.hoisted(() => ({
  hook: null as null | ((s: unknown, ev: unknown) => void),
}));

vi.mock('../../src/ai/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/index')>()),
  teamAiTick: () => { /* none */ },
}));
vi.mock('../../src/ai/cpu/index', async (orig) => ({
  ...(await orig<typeof import('../../src/ai/cpu/index')>()),
  cpuThink: () => { /* none */ },
}));
vi.mock('../../src/sim/contacts', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/contacts')>()),
  contactsTick: (s: unknown, ev: unknown) => { H.hook?.(s, ev); },
}));

beforeEach(() => { H.hook = null; });

type Hook = (s: SimState, ev: EventSink) => void;
function setHook(fn: Hook | null): void {
  H.hook = fn as ((s: unknown, ev: unknown) => void) | null;
}

// ---------------------------------------------------------------- harness

const CHECKS = INVARIANT_NAMES.filter((n) => n !== 'chaser'); // team AI is mocked out
const L = createKickLaunch();

interface Scene { s: SimState; dir: number; kicker: number; striker: number; liner: number; keeper: number }

function put(s: SimState, slot: number, dir: number, u: number, z: number): void {
  const p = s.players[slot]!;
  p.x = dir * u; p.z = z; p.vx = 0; p.vz = 0;
}

/** Home (team 0, attacking +x) in possession: attackers at u = -20, defenders' liner at lineU, others 5 m deeper. */
function scene(o: { lineU?: number; ballU?: number; strikerU?: number; strikerZ?: number; restU?: number; offside?: number } = {}): Scene {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, config: { offside: o.offside ?? 1 } });
  const dir = s.teams[0]!.dir;
  const lineU = o.lineU ?? 30;
  const ballU = o.ballU ?? 10;
  for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
    put(s, i, dir, -20, -25 + 5 * i);
    put(s, PLAYERS_PER_TEAM + i, dir, o.restU ?? lineU - 5, -25 + 5 * i);
  }
  const sc: Scene = { s, dir, kicker: 6, striker: 9, liner: PLAYERS_PER_TEAM + 4, keeper: PLAYERS_PER_TEAM };
  put(s, 0, dir, -50, 0);
  put(s, sc.keeper, dir, 50, 0);
  put(s, sc.liner, dir, lineU, 4);
  put(s, sc.kicker, dir, ballU - 0.6, 0);
  put(s, sc.striker, dir, o.strikerU ?? 36, o.strikerZ ?? 6);
  const b = s.ball;
  b.x = dir * ballU; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = 0; b.py = 0.11;
  b.vx = 0; b.vy = 0; b.vz = 0; b.owner = -1;
  return sc;
}

/** Launch from `slot` toward (tx, tz) at ground speed `speed` (m/s) with lift vy. */
function launch(s: SimState, slot: number, kind: KickKind, target: number, tx: number, tz: number, speed: number, vy: number, ev: EventSink): void {
  const b = s.ball;
  const dx = tx - b.x;
  const dz = tz - b.z;
  const d = Math.sqrt(dx * dx + dz * dz) || 1;
  L.vx = (dx / d) * speed; L.vy = vy; L.vz = (dz / d) * speed;
  L.sx = 0; L.sy = 0; L.sz = 0; L.kind = kind; L.target = target; L.tx = tx; L.tz = tz; L.onTarget = 0;
  applyKick(s, slot, L, 0.6, ev);
}

/** Gives the ball to `slot` once it is within `reach` m of him (low enough to control). */
function receiveWhenClose(s: SimState, slot: number, reach: number, ev: EventSink): boolean {
  const b = s.ball;
  const p = s.players[slot]!;
  const dx = b.x - p.x;
  const dz = b.z - p.z;
  if (b.owner === -1 && b.y < 1.5 && dx * dx + dz * dz <= reach * reach) {
    takePossession(s, slot, ev);
    b.vx = p.vx; b.vy = 0; b.vz = p.vz;
    return true;
  }
  return false;
}

function run(s: SimState, n: number, until?: (s: SimState, ev: readonly SimEvent[]) => boolean): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker(CHECKS);
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    step(s, frames, events);
    const tickEv = events.toArray();
    all.push(...tickEv);
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until?.(s, tickEv)) break;
  }
  return all;
}

const ofType = (ev: readonly SimEvent[], t: EventType): SimEvent[] => ev.filter((e) => e.type === t);

/** Slot 7 of the kicking team stands next to the restart spot so RUL-11 picks him as the taker (not the receiver). */
const TAKER = 7;

/** Award a restart on the real flow and run until it is ready to be taken (by TAKER). */
function readyRestart(s: SimState, kind: RestartKind, team: number, x: number, z: number): void {
  const tk = teamFirstSlot(team) + TAKER;
  const tp = s.players[tk]!;
  tp.x = x - Math.sign(x) * 1.2; tp.z = z - Math.sign(z) * 1.2; tp.vx = 0; tp.vz = 0;
  const ev = createEventBuffer();
  ev.begin(s.tick);
  awardRestart(s, kind, team, x, z, ev);
  expect(s.match.restart.kind).toBe(kind);
  run(s, T_RULES.restartSetupTicks + 5, (st) => st.match.restart.ready === 1);
  expect(s.match.restart.ready).toBe(1);
  expect(s.match.restart.taken).toBe(0);
  // The keeper takes goal kicks; otherwise the player next to the spot.
  expect(s.match.restart.taker).toBe(kind === RestartKind.GOAL_KICK ? s.teams[team]!.keeperSlot : tk);
}

/**
 * Hook: the restart taker plays the ball to `receiver` at the next tick; `deliverAfter` ticks later the ball is
 * at the receiver's feet and he controls it.
 */
function takeAndDeliver(s: SimState, kind: KickKind, receiver: number, deliverAfter: number): { kickTick: number; offsidePosAtKick: boolean } {
  const info = { kickTick: -1, offsidePosAtKick: false };
  expect(s.match.restart.taker).not.toBe(receiver);
  setHook((st, ev) => {
    const r = st.match.restart;
    if (info.kickTick < 0) {
      const p = st.players[receiver]!;
      info.offsidePosAtKick = isOffsidePosition(st, receiver);
      launch(st, r.taker, kind, receiver, p.x, p.z, 16, 3, ev);
      info.kickTick = st.tick;
      return;
    }
    if (st.tick === info.kickTick + deliverAfter) {
      const p = st.players[receiver]!;
      const b = st.ball;
      b.x = p.x + 0.3 * st.teams[p.team]!.dir; b.y = 0.11; b.z = p.z; b.vx = 0; b.vy = 0; b.vz = 0;
      takePossession(st, receiver, ev);
    }
  });
  return info;
}

// ---------------------------------------------------------------- open play

describe('RUL-08 in the real pipeline: open play', () => {
  it('through ball to a striker in an offside position: flagged as he reaches it, free kick where he is', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36 });
    const { s } = sc;
    let kicked = false;
    setHook((st, ev) => {
      if (!kicked) {
        const p = st.players[sc.striker]!;
        launch(st, sc.kicker, KickKind.THROUGH_GROUND, sc.striker, p.x, p.z, 15, 0, ev);
        kicked = true;
        return;
      }
      receiveWhenClose(st, sc.striker, 1, ev);
    });
    const ev = run(s, 400, (st, e) => e.some((x) => x.type === EventType.OFFSIDE));
    const off = ofType(ev, EventType.OFFSIDE);
    expect(off).toHaveLength(1);
    expect(off[0]!.a).toBe(sc.striker);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.kind).toBe(RestartKind.FREE_KICK);
    expect(s.match.restart.team).toBe(1);
    const p = s.players[sc.striker]!;
    expect(off[0]!.x).toBeCloseTo(p.x, 6);
    expect(off[0]!.z).toBeCloseTo(p.z, 6);
    // The ball reached him (within the receiver reach) before anybody else touched it.
    expect(ofType(ev, EventType.GOAL)).toHaveLength(0);
    // Play then restarts with the defending team's free kick and goes on normally.
    setHook(null);
    run(s, T_RULES.restartSetupTicks + 2);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.offside.flags).toBe(0);
  });

  it('the same ball to an onside striker is received without a flag', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 28 });
    const { s } = sc;
    let kicked = false;
    let got = false;
    setHook((st, ev) => {
      if (!kicked) {
        const p = st.players[sc.striker]!;
        launch(st, sc.kicker, KickKind.THROUGH_GROUND, sc.striker, p.x, p.z, 15, 0, ev);
        kicked = true;
        return;
      }
      if (!got) got = receiveWhenClose(st, sc.striker, 1, ev);
    });
    const ev = run(s, 400, () => got);
    expect(got).toBe(true);
    run(s, 5);
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ball.owner).toBe(sc.striker);
    expect(s.match.offside.flags).toBe(0);
  });

  it('glitch: offside given against a player in his own half (pipeline)', () => {
    // The defending team has pushed up into the attackers' half; the striker is past all of them but in his own half.
    const sc = scene({ lineU: -12, restU: -17, ballU: -25, strikerU: -2, strikerZ: 3 });
    const { s } = sc;
    let kicked = false;
    let got = false;
    setHook((st, ev) => {
      if (!kicked) {
        const p = st.players[sc.striker]!;
        launch(st, sc.kicker, KickKind.GROUND_PASS, sc.striker, p.x, p.z, 14, 0, ev);
        kicked = true;
        return;
      }
      if (!got) got = receiveWhenClose(st, sc.striker, 1, ev);
    });
    const ev = run(s, 400, () => got);
    expect(got).toBe(true);
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('offside switched off: the striker in an offside position receives and play goes on', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 36, offside: 0 });
    const { s } = sc;
    let kicked = false;
    let got = false;
    setHook((st, ev) => {
      if (!kicked) {
        const p = st.players[sc.striker]!;
        launch(st, sc.kicker, KickKind.THROUGH_GROUND, sc.striker, p.x, p.z, 15, 0, ev);
        kicked = true;
        return;
      }
      if (!got) got = receiveWhenClose(st, sc.striker, 1, ev);
    });
    const ev = run(s, 400, () => got);
    expect(got).toBe(true);
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});

// ---------------------------------------------------------------- restarts

describe('RUL-08 in the real pipeline: restarts', () => {
  it('glitch: offside given from a throw-in (pipeline)', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 40, strikerZ: 20 });
    const { s } = sc;
    readyRestart(s, RestartKind.THROW_IN, 0, 22, HALF_WIDTH);
    const info = takeAndDeliver(s, KickKind.THROW_IN, sc.striker, 40);
    const ev = run(s, 120);
    expect(info.kickTick).toBeGreaterThan(0);
    expect(info.offsidePosAtKick).toBe(true); // he was in an offside position when the ball was played
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ball.owner).toBe(sc.striker);
  });

  it('glitch: offside given from a goal kick (pipeline)', () => {
    const sc = scene({ lineU: 10, ballU: -40, strikerU: 20, strikerZ: -4, restU: 5 });
    const { s } = sc;
    readyRestart(s, RestartKind.GOAL_KICK, 0, -48, 4);
    const info = takeAndDeliver(s, KickKind.GOAL_KICK, sc.striker, 60);
    const ev = run(s, 140);
    expect(info.kickTick).toBeGreaterThan(0);
    expect(info.offsidePosAtKick).toBe(true); // he was in an offside position when the ball was played
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ball.owner).toBe(sc.striker);
  });

  it('glitch: offside given from a corner (pipeline)', () => {
    // Striker on the goal line beyond the corner spot and every defender but the keeper.
    const sc = scene({ lineU: 44, restU: 40, ballU: 10, strikerU: 52.3, strikerZ: 2 });
    const { s } = sc;
    // Ball placed inside the arc but off the lines, so the striker on the goal line is ahead of the ball.
    readyRestart(s, RestartKind.CORNER, 0, 51.8, HALF_WIDTH - 0.5);
    expect(s.match.restart.x).toBeCloseTo(51.8, 9);
    const info = takeAndDeliver(s, KickKind.CROSS, sc.striker, 50);
    const ev = run(s, 130);
    expect(info.kickTick).toBeGreaterThan(0);
    expect(info.offsidePosAtKick).toBe(true); // he was in an offside position when the ball was played
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(0);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.ball.owner).toBe(sc.striker);
  });

  it('offside applies from a free kick: flagged on reception, free kick back to the defenders', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 38, strikerZ: 12 });
    const { s } = sc;
    readyRestart(s, RestartKind.FREE_KICK, 0, 18, 0);
    const info = takeAndDeliver(s, KickKind.LOB_PASS, sc.striker, 50);
    const ev = run(s, 130, (st, e) => e.some((x) => x.type === EventType.OFFSIDE));
    expect(info.kickTick).toBeGreaterThan(0);
    expect(info.offsidePosAtKick).toBe(true);
    const off = ofType(ev, EventType.OFFSIDE);
    expect(off).toHaveLength(1);
    expect(off[0]!.a).toBe(sc.striker);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.team).toBe(1);
    const phases = ofType(ev, EventType.PHASE_CHANGE).map((e) => [e.a, e.b]);
    expect(phases).toContainEqual([MatchPhase.FREE_KICK, MatchPhase.IN_PLAY]);
    expect(phases).toContainEqual([MatchPhase.IN_PLAY, MatchPhase.FREE_KICK]);
  });

  it('a throw-in to a teammate who then passes on judges the next pass normally', () => {
    const sc = scene({ lineU: 30, ballU: 10, strikerU: 40, strikerZ: 15 });
    const { s } = sc;
    const mate = teamFirstSlot(0) + 8;
    put(s, mate, sc.dir, 24, 28);
    readyRestart(s, RestartKind.THROW_IN, 0, 22, HALF_WIDTH);
    const info = takeAndDeliver(s, KickKind.THROW_IN, mate, 30);
    run(s, 60);
    expect(info.kickTick).toBeGreaterThan(0);
    expect(s.ball.owner).toBe(mate);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    // Now the teammate plays it on to the striker, who is in an offside position at this pass.
    let passed = false;
    setHook((st, ev) => {
      if (!passed) {
        const p = st.players[sc.striker]!;
        launch(st, mate, KickKind.THROUGH_GROUND, sc.striker, p.x, p.z, 15, 0, ev);
        passed = true;
        return;
      }
      receiveWhenClose(st, sc.striker, 1, ev);
    });
    const ev = run(s, 300, (st, e) => e.some((x) => x.type === EventType.OFFSIDE));
    expect(ofType(ev, EventType.OFFSIDE)).toHaveLength(1);
    expect(s.match.restart.team).toBe(1);
  });
});
