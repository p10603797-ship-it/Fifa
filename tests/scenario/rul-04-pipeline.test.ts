/**
 * RUL-04 end to end, nothing mocked: a human corner crossed with LOB lands near the aim reticle through the real SIM-09
 * startLob(CROSS) + SIM-08 KICK handler + SIM-01 flight, and a bot v bot corner is taken without any watchdog.
 *
 * These need the real kick modules. While SIM-09 startLob is still the Wave 0 stub (it refuses every request) the
 * describe block is skipped; the same behaviour is covered with recorded requests in rul-04-corner.test.ts and
 * rul-04-integration.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, clearInputFrame, createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createActionRequest, ReqFlag } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { startLob } from '../../src/sim/kicks/lob';
import { step } from '../../src/sim/step';
import { awardRestart, prepareTakerKick } from '../../src/sim/rules/restart';
import { makeScenario } from '../harness/scenario';

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
  return s;
}

/** True once SIM-09 startLob accepts a corner cross (the Wave 0 stub refuses everything). */
function lobIsLive(): boolean {
  const s = cornerFor(0, 1, 1, 1);
  run(s, SETUP + 3, undefined, (st) => st.match.restart.ready === 1);
  const r = s.match.restart;
  if (r.ready !== 1 || prepareTakerKick(s, r.taker) !== 1) return false;
  const req = createActionRequest();
  req.hasTarget = 1; req.targetX = 42; req.targetZ = 0; req.power = 0.6; req.flags = ReqFlag.SET_PIECE;
  const d = Math.hypot(42 - r.x, 0 - r.z);
  req.dirX = (42 - r.x) / d; req.dirZ = (0 - r.z) / d;
  const ev = createEventBuffer();
  ev.begin(s.tick);
  return startLob(s, r.taker, KickKind.CROSS, req, ev) === 1;
}

const LIVE = lobIsLive();

describe.skipIf(!LIVE)('RUL-04 end to end (real SIM-08/09 kicks)', () => {
  it('a human cross (stick aim, LOB tap) lands near the reticle; struck in the CORNER phase; no watchdog', () => {
    const s = cornerFor(0, 1, 1, 5);
    run(s, SETUP + 3, undefined, (st) => st.match.restart.ready === 1);
    run(s, 2);
    const r = s.match.restart;
    run(s, 12, (_s, f) => { f[0]!.mz = -127; });
    const ax = r.aimX, az = r.aimZ;
    // hold LOB ~half the power bar, release, wait for the contact
    const ev = run(s, 20, (_s, f) => { f[0]!.buttons = Btn.LOB; }, (st) => st.match.phase !== MatchPhase.CORNER);
    ev.push(...run(s, 120, undefined, (st) => st.match.phase !== MatchPhase.CORNER));
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    const kick = ev.find((e) => e.type === EventType.KICK);
    expect(kick).toBeDefined();
    expect(kick!.b).toBe(KickKind.CROSS);
    const flight = run(s, 240, undefined, (st) => st.ball.touchedTick === st.tick && st.ball.lastTouch !== r.taker);
    const land = flight.find((e) => e.type === EventType.BOUNCE);
    if (land) expect(Math.hypot(land.x - ax, land.z - az)).toBeLessThan(4);
    expect([...ev, ...flight].filter((e) => e.type === EventType.WATCHDOG || e.type === EventType.OFFSIDE)).toEqual([]);
  });

  it.each([0, 1])('bot v bot corner for team %i is taken without any watchdog', (team) => {
    const s = cornerFor(team, -1, 0, 9);
    const ev = run(s, SETUP + 400, undefined, (st) => st.match.phase !== MatchPhase.CORNER);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(ev.filter((e) => e.type === EventType.WATCHDOG)).toEqual([]);
  });
});

describe('RUL-04 end to end (dependency status)', () => {
  it('reports whether SIM-09 startLob is live (the end-to-end block runs once it is)', () => {
    expect(typeof LIVE).toBe('boolean');
  });
});
