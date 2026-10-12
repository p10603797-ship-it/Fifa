/**
 * Independent review of FND-06: adversarial tests for the invariant checker (src/sim/debug/invariants.ts).
 * Failing tests here are confirmed defects and stay as regression tests once fixed.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker, INVARIANT_LIMITS, type InvariantChecker } from '../../src/sim/debug/invariants';
import { initMatch } from '../../src/sim/init';

type Ev = [EventType, number?, number?, number?, number?];

/** CPU v CPU state in IN_PLAY with valid controllers and chasers (passes 'all'). */
function playing(): SimState {
  const cfg = createMatchConfig();
  cfg.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: 0, autoSwitch: 0, fastPower: 0 },
  ];
  const s = initMatch(cfg);
  s.match.phase = MatchPhase.IN_PLAY;
  s.match.prevPhase = MatchPhase.KICK_OFF;
  s.ctrl[2]!.slot = 9; s.players[9]!.ctrl = 2;
  s.ctrl[3]!.slot = 20; s.players[20]!.ctrl = 3;
  s.teams[0]!.chaser = 10;
  s.teams[1]!.chaser = 15;
  return s;
}

function evs(tick: number, list: Ev[] = []): EventBufferImpl {
  const ev = createEventBuffer();
  ev.begin(tick);
  for (const [type, a, b, c, d] of list) ev.emit(type, a, b, c, d);
  return ev;
}

/** Advance one tick: s.tick++, mutate, check with the given events. */
function tickWith(c: InvariantChecker, s: SimState, mutate: (s: SimState) => void = () => {}, list: Ev[] = []): readonly string[] {
  s.tick++;
  mutate(s);
  return c.check(s, evs(s.tick, list));
}

describe('review FND-06 invariants: robustness (never throws on a corrupt state)', () => {
  it('does not throw when the previous tick had an invalid phase and this tick changes phase without an event', () => {
    // Defect: checkPhase calls isLegalTransition(prevPhase=99, phase) -> LEGAL_TRANSITIONS[99] is undefined -> TypeError.
    const s = playing();
    const c = createInvariantChecker('all');
    expect(c.check(s, evs(s.tick))).toEqual([]);
    const m1 = tickWith(c, s, (st) => { st.match.phase = 99 as MatchPhase; });
    expect(m1.join('\n')).toContain('invalid phase 99');
    let m2: readonly string[] = [];
    expect(() => { m2 = tickWith(c, s, (st) => { st.match.phase = MatchPhase.IN_PLAY; }); }).not.toThrow();
    expect(m2.join('\n')).toMatch(/\[phase\]/);
  });

  it('does not throw for a non-integer previous phase either', () => {
    const s = playing();
    const c = createInvariantChecker('core');
    c.check(s, evs(s.tick));
    tickWith(c, s, (st) => { st.match.phase = 2.5 as MatchPhase; });
    expect(() => tickWith(c, s, (st) => { st.match.phase = MatchPhase.IN_PLAY; })).not.toThrow();
  });

  it('never mutates the state it checks (hash identical on passing and failing paths)', () => {
    const s = playing();
    const c = createInvariantChecker('all');
    const h0 = hashState(s);
    c.check(s, evs(s.tick));
    expect(hashState(s)).toBe(h0);
    s.tick++;
    s.ball.owner = 40; // invalid
    s.players[3]!.x = Number.NaN;
    s.teams[0]!.goals = 7; // no GOAL event
    const h1 = hashState(s);
    const msgs = c.check(s, evs(s.tick));
    expect(msgs.length).toBeGreaterThan(0);
    expect(hashState(s)).toBe(h1);
  });
});

describe('review FND-06 invariants: each goal counts once', () => {
  it('flags a second GOAL event (and score increment) for the same goal on the next tick, during the GOAL cut-scene', () => {
    // Brief section 14 glitch list: "Goals: counted twice". A GOAL event re-emitted while the match is already in the
    // GOAL phase (ball bounces back over the line during the cut-scene) increments the score twice for one goal.
    const s = playing();
    const c = createInvariantChecker('all');
    c.check(s, evs(s.tick));
    const first = tickWith(c, s, (st) => {
      st.teams[0]!.goals = 1;
      st.match.prevPhase = MatchPhase.IN_PLAY;
      st.match.phase = MatchPhase.GOAL;
      st.match.phaseT = 0;
      st.ball.owner = -1;
    }, [[EventType.GOAL, 0, 9, -1, 0], [EventType.PHASE_CHANGE, MatchPhase.IN_PLAY, MatchPhase.GOAL]]);
    expect(first).toEqual([]);
    const second = tickWith(c, s, (st) => { st.teams[0]!.goals = 2; st.match.phaseT = 1; }, [[EventType.GOAL, 0, 9, -1, 0]]);
    expect(second.join('\n')).toMatch(/\[score\]/);
  });

  it('flags a GOAL event in a phase where no goal can be scored (HALF_TIME)', () => {
    const s = playing();
    s.match.phase = MatchPhase.HALF_TIME;
    s.match.prevPhase = MatchPhase.IN_PLAY;
    const c = createInvariantChecker('all');
    c.check(s, evs(s.tick));
    const msgs = tickWith(c, s, (st) => { st.teams[1]!.goals = 1; }, [[EventType.GOAL, 1, 15, -1, 0]]);
    expect(msgs.join('\n')).toMatch(/\[score\]/);
  });
});

describe('review FND-06 invariants: keeper area geometry', () => {
  function holding(s: SimState, slot: number, x: number, z: number): void {
    const k = s.players[slot]!;
    k.x = x; k.z = z;
    s.ball.x = x; s.ball.z = z; s.ball.y = 1;
    s.ball.owner = slot; s.ball.heldBy = slot;
  }

  it('home keeper (dir +1, own goal at -52.5): inside his area passes, the opposition area fails', () => {
    const s = playing();
    const c = createInvariantChecker(['keeperArea']);
    holding(s, 0, -HALF_LENGTH + 10, 5);
    expect(c.check(s, null)).toEqual([]);
    holding(s, 0, HALF_LENGTH - 10, 5);
    expect(c.check(s, null).join('\n')).toMatch(/keeper 0 holds the ball outside his own area/);
  });

  it('after the half-time switch (home dir -1) the own area is at +52.5', () => {
    const s = playing();
    s.teams[0]!.dir = -1;
    s.teams[1]!.dir = 1;
    const c = createInvariantChecker(['keeperArea']);
    holding(s, 0, HALF_LENGTH - 10, -5);
    expect(c.check(s, null)).toEqual([]);
    holding(s, 0, -HALF_LENGTH + 10, -5);
    expect(c.check(s, null).length).toBe(1);
  });

  it('respects the 1 m slack at the edge of the box and behind the goal line', () => {
    const s = playing();
    const c = createInvariantChecker(['keeperArea']);
    const slack = INVARIANT_LIMITS.keeperAreaSlack;
    holding(s, 11, HALF_LENGTH - 16.5 - slack + 0.01, 0); // away keeper, just inside the slack
    expect(c.check(s, null)).toEqual([]);
    holding(s, 11, HALF_LENGTH - 16.5 - slack - 0.01, 0);
    expect(c.check(s, null).length).toBe(1);
    holding(s, 11, HALF_LENGTH + slack + 0.5, 0); // carried over his own line
    expect(c.check(s, null).length).toBe(1);
    holding(s, 11, HALF_LENGTH - 5, 20.16 + slack + 0.01); // wide of the box
    expect(c.check(s, null).length).toBe(1);
  });
});

describe('review FND-06 invariants: temporal limits are consecutive and exact', () => {
  it('overlap: 60 ticks, one tick apart, 60 ticks again never fails; 61 consecutive fails once per tick after', () => {
    const s = playing();
    const c = createInvariantChecker(['overlap']);
    const a = s.players[5]!;
    const b = s.players[16]!;
    b.x = a.x + 0.1; b.z = a.z;
    c.check(s, null);
    for (let i = 1; i < INVARIANT_LIMITS.overlapTicks; i++) expect(tickWith(c, s)).toEqual([]);
    b.x = a.x + 5;
    expect(tickWith(c, s)).toEqual([]);
    b.x = a.x + 0.1;
    for (let i = 0; i < INVARIANT_LIMITS.overlapTicks; i++) expect(tickWith(c, s)).toEqual([]);
    const m = tickWith(c, s);
    expect(m.length).toBe(1);
    expect(m[0]).toMatch(/players 5 .* and 16 /);
  });

  it('overlap counter resets when one of the pair leaves the pitch', () => {
    const s = playing();
    const c = createInvariantChecker(['overlap']);
    const a = s.players[5]!;
    const b = s.players[16]!;
    b.x = a.x; b.z = a.z;
    c.check(s, null);
    for (let i = 1; i < 50; i++) tickWith(c, s);
    b.active = 0;
    tickWith(c, s);
    b.active = 1;
    for (let i = 0; i < 50; i++) expect(tickWith(c, s)).toEqual([]);
  });

  it('action budget: actT = actDur + 2 passes, actDur + 3 fails; charging is exempt until 120 ticks', () => {
    const s = playing();
    const c = createInvariantChecker(['action']);
    const p = s.players[7]!;
    p.act = ActionKind.SHIELD; p.actDur = 10; p.actT = 12;
    expect(c.check(s, null)).toEqual([]);
    p.actT = 13;
    expect(tickWith(c, s).join('\n')).toMatch(/player 7 .* past its budget: actT=13 actDur=10/);
    p.actT = 500; p.actCharging = 1;
    for (let i = 0; i < INVARIANT_LIMITS.maxChargeTicks; i++) expect(tickWith(c, s)).toEqual([]);
    expect(tickWith(c, s).join('\n')).toMatch(/player 7 has charged SHIELD for 121 ticks/);
  });

  it('chaser: a loose ball whose chaser belongs to the other team fails after the grace tick', () => {
    const s = playing();
    s.ball.owner = -1;
    s.teams[1]!.chaser = 3; // a home player as away chaser
    const c = createInvariantChecker(['chaser']);
    expect(c.check(s, null)).toEqual([]);
    expect(tickWith(c, s).join('\n')).toMatch(/team 1 chaser is 3/);
  });
});

describe('review FND-06 invariants: cost', () => {
  it("a passing 'all' check of a full 22-player state costs well under 0.5 ms", () => {
    const s = playing();
    const c = createInvariantChecker('all');
    for (let i = 0; i < 22; i++) { s.players[i]!.x = -50 + i * 4.5; s.players[i]!.z = (i % 5) * 3; }
    c.check(s, null);
    for (let i = 0; i < 2000; i++) { s.tick++; c.check(s, null); }
    const t0 = performance.now();
    const n = 5000;
    for (let i = 0; i < n; i++) { s.tick++; if (c.check(s, null).length) throw new Error('unexpected failure'); }
    expect((performance.now() - t0) / n).toBeLessThan(0.5);
  });
});
