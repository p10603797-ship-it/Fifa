/**
 * RUL-04 integration: corners through the real pipeline with the real team AI, TAI-13 set-piece positions and CPU
 * brains, keepers and contacts. Only SIM-08 startPass / SIM-09 startLob are replaced (they record the request and kick
 * the ball at once through core/kick.ts applyKick; a targeted lob flies to its point with SIM-01 solveLaunchSpin), so
 * these tests do not depend on the kick modules being finished.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, RESTART_DISTANCE } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_PASS, T_RULES } from '../../src/contracts/tuning';
import { createLaunchSolution, solveLaunchSpin } from '../../src/sim/ball/flight';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { step } from '../../src/sim/step';
import { awardRestart } from '../../src/sim/rules/restart';
import { LOCAL_TUNING, inCornerBox } from '../../src/sim/rules/corner';
import { makeScenario } from '../harness/scenario';

interface Call {
  fn: 'pass' | 'lob';
  slot: number;
  kind: number;
  target: number;
  flags: number;
  hasTarget: number;
  targetX: number;
  targetZ: number;
  rt: number;
  phase: number;
  far: number[];
}

const K = vi.hoisted(() => ({ calls: [] as unknown[] }));
const SOL = createLaunchSolution();

function record(fn: 'pass' | 'lob', s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink): number {
  const r = s.match.restart;
  const far: number[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active === 1 && p.team !== r.team) far.push(Math.hypot(p.x - r.x, p.z - r.z));
  }
  (K.calls as Call[]).push({
    fn, slot, kind, target: req.targetSlot, flags: req.flags, hasTarget: req.hasTarget, targetX: req.targetX,
    targetZ: req.targetZ, rt: r.t, phase: s.match.phase, far,
  });
  const b = s.ball;
  const l = createKickLaunch();
  let tx = b.x + req.dirX * 10, tz = b.z + req.dirZ * 10;
  if (req.hasTarget === 1) { tx = req.targetX; tz = req.targetZ; } else if (req.targetSlot >= 0) {
    tx = s.players[req.targetSlot]!.x; tz = s.players[req.targetSlot]!.z;
  }
  if (fn === 'lob') {
    solveLaunchSpin(tx - b.x, tz - b.z, T_PASS.lobAngle, BALL_RADIUS, 0, 0, SOL);
    l.vx = SOL.vx; l.vy = SOL.vy; l.vz = SOL.vz;
  } else {
    const d = Math.hypot(tx - b.x, tz - b.z);
    l.vx = ((tx - b.x) / d) * 12; l.vz = ((tz - b.z) / d) * 12; l.vy = 0;
  }
  l.kind = kind;
  l.target = req.targetSlot;
  l.tx = tx; l.tz = tz;
  applyKick(s, slot, l, req.power, ev);
  return 1;
}

vi.mock('../../src/sim/kicks/pass', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/pass')>()),
  startPass: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => record('pass', s, slot, kind, req, ev),
}));
vi.mock('../../src/sim/kicks/lob', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/lob')>()),
  startLob: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => record('lob', s, slot, kind, req, ev),
}));

beforeEach(() => { K.calls.length = 0; });
const calls = (): Call[] => K.calls as Call[];

const SETUP = T_RULES.restartSetupTicks;

function run(s: SimState, n: number, inputs?: (s: SimState, f: InputFrame[]) => void, until?: (s: SimState) => boolean): SimEvent[] {
  const events = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker('core');
  const all: SimEvent[] = [];
  for (let i = 0; i < n; i++) {
    clearInputFrame(frames[0]!);
    clearInputFrame(frames[1]!);
    inputs?.(s, frames);
    step(s, frames, events);
    for (let k = 0; k < events.count; k++) all.push({ ...events.get(k) });
    const fails = checker.check(s, events);
    if (fails.length > 0) throw new Error(`invariant failure at t=${s.tick}:\n  ${fails.join('\n  ')}`);
    if (until?.(s)) break;
  }
  return all;
}

function cornerFor(team: number, side: number, humans: number, seed: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans, seed });
  const e = s.teams[team]!.dir;
  const ev = createEventBuffer();
  ev.begin(s.tick);
  awardRestart(s, RestartKind.CORNER, team, e * HALF_LENGTH, side * HALF_WIDTH, ev);
  expect(s.match.phase).toBe(MatchPhase.CORNER);
  return s;
}

describe('RUL-04 integration (real team AI, TAI-13, keepers, contacts)', () => {
  const cases: { team: number; side: number; seed: number }[] = [];
  for (const team of [0, 1]) for (const side of [1, -1]) for (const seed of [3, 11]) cases.push({ team, side, seed });

  it.each(cases)('bot v bot: team $team side $side seed $seed -> taken from CORNER by the CPU, opponents 9.15 m away, no watchdog',
    ({ team, side, seed }) => {
      const s = cornerFor(team, side, 0, seed);
      const ev = run(s, SETUP + T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks + 200, undefined,
        (st) => st.match.phase !== MatchPhase.CORNER);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(ev.filter((e) => e.type === EventType.WATCHDOG)).toEqual([]);
      expect(calls()).toHaveLength(1);
      const c = calls()[0]!;
      expect(c.phase).toBe(MatchPhase.CORNER); // no offside from corners: struck in the CORNER phase
      expect(s.players[c.slot]!.team).toBe(team);
      expect(c.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
      expect(c.rt - SETUP).toBeLessThanOrEqual(T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks);
      for (const d of c.far) expect(d).toBeGreaterThanOrEqual(RESTART_DISTANCE - 0.35);
      if (c.fn === 'lob' && c.kind === KickKind.CROSS && c.hasTarget === 1 && c.target < 0) {
        expect(inCornerBox(s, team, c.targetX, c.targetZ, 0.5)).toBe(true);
      }
      expect(ev.filter((e) => e.type === EventType.OFFSIDE)).toEqual([]);
    });

  it('human v CPU: the human aims with the stick and crosses (LOB); TAI-13 keeps the defenders legal; play resumes', () => {
    const s = cornerFor(0, 1, 1, 5);
    run(s, SETUP + 2, undefined, (st) => st.match.restart.ready === 1);
    run(s, 2);
    const r = s.match.restart;
    expect(s.ctrl[0]!.slot).toBe(r.taker);
    run(s, 15, (_s, f) => { f[0]!.mz = -127; });
    const ax = r.aimX, az = r.aimZ;
    const ev = run(s, 1, (_s, f) => { f[0]!.buttons = Btn.LOB; });
    expect(calls()).toHaveLength(1);
    const c = calls()[0]!;
    expect([c.fn, c.kind, c.hasTarget, c.targetX, c.targetZ]).toEqual(['lob', KickKind.CROSS, 1, ax, az]);
    for (const d of c.far) expect(d).toBeGreaterThanOrEqual(RESTART_DISTANCE - 0.35);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    const later = run(s, 180);
    expect([...ev, ...later].filter((e) => e.type === EventType.WATCHDOG || e.type === EventType.OFFSIDE)).toEqual([]);
  });
});
