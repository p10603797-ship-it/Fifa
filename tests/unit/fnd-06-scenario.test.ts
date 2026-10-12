/**
 * FND-06: scenario helpers (tests/harness/scenario.ts) used by the rules / sim scenario tests.
 */
import { describe, expect, it } from 'vitest';
import { ControllerKind, MatchPhase, Period } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { findEvents, frame, makeScenario, runTicks, runUntil, scenarioConfig } from '../harness/scenario';

describe('FND-06 scenario harness', () => {
  it('makeScenario applies phase, ball, players, teams, match and humans on top of initMatch', () => {
    const s = makeScenario({
      seed: 77,
      phase: MatchPhase.IN_PLAY,
      ball: { x: 40, y: 0.11, z: 2, vx: 20 },
      players: [{ slot: 9, x: 38, z: 2, stamina: 0.5 }, { slot: 11, x: 50, z: 0 }],
      teams: [undefined, { focus: 2 }],
      match: { period: Period.SECOND_HALF, periodT: 1000 },
      humans: [{ side: 0, slot: 9 }],
    });
    expect(s.config.seed).toBe(77);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.match.prevPhase).toBe(MatchPhase.IN_PLAY);
    expect(s.match.clockRunning).toBe(1);
    expect(s.match.period).toBe(Period.SECOND_HALF);
    expect(s.match.periodT).toBe(1000);
    expect([s.ball.x, s.ball.px, s.ball.z, s.ball.pz, s.ball.vx, s.ball.grounded]).toEqual([40, 40, 2, 2, 20, 1]);
    expect([s.players[9]!.x, s.players[9]!.z, s.players[9]!.stamina]).toEqual([38, 2, 0.5]);
    expect(s.players[11]!.x).toBe(50);
    expect(s.teams[1]!.focus).toBe(2);
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.HUMAN);
    expect(s.ctrl[0]!.slot).toBe(9);
    expect(s.players[9]!.ctrl).toBe(0);
    expect(s.ctrl[1]!.kind).toBe(ControllerKind.NONE);
    expect(s.ctrl[3]!.kind).toBe(ControllerKind.CPU); // away side has no human
  });

  it('humans as a count: 0 = bot v bot, 2 = P1 home and P2 away', () => {
    expect(scenarioConfig({ humans: 0 }).humans.every((h) => h.kind === ControllerKind.NONE)).toBe(true);
    const two = scenarioConfig({ humans: 2 }).humans;
    expect(two.map((h) => [h.kind, h.side])).toEqual([[ControllerKind.HUMAN, 0], [ControllerKind.HUMAN, 1]]);
  });

  it('rejects a bad slot', () => {
    expect(() => makeScenario({ players: [{ slot: 22, x: 0 }] })).toThrow(RangeError);
  });

  it('runTicks steps the real pipeline, feeds inputs and returns copies of every event', () => {
    const s = makeScenario({ humans: 1 });
    const seen: number[] = [];
    const ev = runTicks(s, 30, (tick, _st, out) => {
      seen.push(tick);
      if (tick % 2 === 0) out[0]!.buttons = Btn.PASS;
    });
    expect(s.tick).toBe(30);
    expect(seen).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    for (const e of ev) expect(e.tick).toBeGreaterThanOrEqual(1);
    const first = ev[0];
    if (first) expect(findEvents(ev, first.type)).toContain(first);
  });

  it('runTicks with check throws on the first failing tick, naming the invariant', () => {
    const s = makeScenario();
    expect(() => runTicks(s, 20, (tick, st) => { if (tick === 5) st.teams[1]!.goals = 2; }, { check: 'core' }))
      .toThrow(/t=5 \[score\] team 1 score changed by 2 with 0 GOAL event/);
  });

  it('runUntil stops when the predicate holds', () => {
    const s = makeScenario();
    const r = runUntil(s, (st) => st.tick >= 12, 100);
    expect(r.reached).toBe(true);
    expect(s.tick).toBe(12);
    const r2 = runUntil(makeScenario(), () => false, 5);
    expect(r2.reached).toBe(false);
  });

  it('findEvents filters by type and predicate; frame() builds an InputFrame', () => {
    const events = [
      { type: EventType.KICK, tick: 1, a: 3, b: 1, c: 0, d: 0, x: 0, y: 0, z: 0 },
      { type: EventType.GOAL, tick: 2, a: 0, b: 9, c: -1, d: 0, x: 0, y: 0, z: 0 },
      { type: EventType.KICK, tick: 3, a: 5, b: 1, c: 0, d: 0, x: 0, y: 0, z: 0 },
    ];
    expect(findEvents(events, EventType.KICK)).toHaveLength(2);
    expect(findEvents(events, EventType.KICK, (e) => e.a === 5)[0]!.tick).toBe(3);
    const f = frame({ mx: 127, buttons: Btn.SHOOT });
    expect([f.mx, f.buttons, f.gSlot]).toEqual([127, Btn.SHOOT, -1]);
  });
});
