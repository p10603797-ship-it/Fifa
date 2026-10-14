/**
 * TAI-06 unit tests: team phase classification (updateTeamPhase), possession bookkeeping (possT/lostT), counter and
 * recovery job assignment (assignTransition) on hand-built states, mirrored for both attack directions.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { AiJob, KickKind, MatchPhase, RestartKind, TacticalFocus, TeamPhase, TeamStyle } from '../../src/contracts/enums';
import { EventType, type EventSink } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { assignJob, resetJobs } from '../../src/ai/jobs';
import {
  assignTransition, attackWindowTicks, CLOCK_MAX, controlTeam, counterMargin, defendWindowTicks, LOCAL_TUNING,
  possessionStatus, updateTeamPhase,
} from '../../src/ai/transition';
import { NULL_SINK } from '../../src/sim/core/events';
import { makeScenario } from '../harness/scenario';

interface Rec { type: number; a: number; b: number; c: number }
function recSink(): EventSink & { ev: Rec[] } {
  const ev: Rec[] = [];
  return { ev, emit(type, a = 0, b = 0, c = 0) { ev.push({ type, a, b, c }); } };
}

/** In-play state, nobody controlled (every outfielder job-driven), given styles. */
function base(style0: TeamStyle = TeamStyle.POSSESSION, style1: TeamStyle = TeamStyle.POSSESSION, seed = 11): SimState {
  // Same club on both sides so mirrored states have identical attributes.
  const s = makeScenario({
    seed, phase: MatchPhase.IN_PLAY, config: { homeClub: 0, awayClub: 0 }, teams: [{ style: style0 }, { style: style1 }],
  });
  for (const p of s.players) p.ctrl = -1;
  for (const c of s.ctrl) c.slot = -1;
  return s;
}

/** Place slot (team-local index idx) at (u, v) in its team's frame; home too unless given. */
function place(s: SimState, team: number, idx: number, u: number, v: number, hu = u, hv = v): void {
  const p = s.players[team * 11 + idx]!;
  const d = s.teams[team]!.dir;
  p.x = d * u; p.z = d * v; p.vx = 0; p.vz = 0;
  p.homeX = d * hu; p.homeZ = d * hv;
}

/** Record that `team` has had the ball for a while (settled clocks, settled phase). */
function settle(s: SimState, team: number, phaseIn: TeamPhase = TeamPhase.ATTACK): void {
  const a = s.teams[team]!, b = s.teams[1 - team]!;
  a.possT = 300; a.lostT = 900; a.phase = phaseIn; a.phaseT = 300;
  b.possT = 900; b.lostT = 300; b.phase = TeamPhase.DEFEND; b.phaseT = 300;
}

/** Ball at slot's feet, owned by him (a fresh contact this tick). */
function own(s: SimState, slot: number): void {
  const p = s.players[slot]!, b = s.ball;
  b.x = p.x; b.z = p.z; b.px = p.x; b.pz = p.z; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0;
  b.owner = slot; b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick;
}

/** Ball loose at (x, z) in pitch coordinates. */
function ballAt(s: SimState, x: number, z: number): void {
  const b = s.ball;
  b.x = x; b.z = z; b.px = x; b.pz = z; b.owner = -1;
}

function tick(s: SimState, sink: EventSink = NULL_SINK): void {
  s.tick++;
  updateTeamPhase(s, 0, sink);
  updateTeamPhase(s, 1, sink);
}

function jobs(s: SimState): void {
  for (const t of [0, 1]) { resetJobs(s, t); assignTransition(s, t, NULL_SINK); }
}

/**
 * Team A (index `a`) camped in the other half, team D (1 - a) defending deep with two strikers up; D's CM (idx 6)
 * has just won the ball at u_D = -36 (team frames). Positions are given in each team's own frame.
 */
function counterSetup(a: number, styleD: TeamStyle, aBack = 2): SimState {
  const d = 1 - a;
  const s = base(a === 0 ? TeamStyle.POSSESSION : styleD, a === 0 ? styleD : TeamStyle.POSSESSION);
  // Defending side (wins the ball), own frame.
  place(s, d, 0, -50, 0);
  place(s, d, 1, -40, 18); place(s, d, 2, -44, 6); place(s, d, 3, -44, -6); place(s, d, 4, -40, -18);
  place(s, d, 5, -34, 24); place(s, d, 6, -36, 8); place(s, d, 7, -36, -8); place(s, d, 8, -34, -24);
  place(s, d, 9, -8, 6); place(s, d, 10, -10, -8);
  // Attacking side, own frame (u > 0 = in the other half). `aBack` players stay back beyond u_D = -5.
  place(s, a, 0, -45, 0);
  // Defenders in the order they stay back: the two CBs, then the full-backs.
  const back = [[2, -6, 8], [3, -6, -8], [1, -6, 20], [4, -6, -20]];
  const up = [[2, 30, 8], [3, 30, -8], [1, 28, 20], [4, 28, -20]];
  for (let k = 0; k < 4; k++) {
    const r = k < aBack ? back[k]! : up[k]!;
    place(s, a, r[0]!, r[1]!, r[2]!);
  }
  place(s, a, 5, 36, 22, 30, 22); place(s, a, 6, 24, 6, 18, 6); place(s, a, 7, 26, -6, 18, -6);
  place(s, a, 8, 36, -22, 30, -22); place(s, a, 9, 40, 5); place(s, a, 10, 42, -4);
  settle(s, a);
  own(s, d * 11 + 6);
  return s;
}

describe('TAI-06 phase classification table', () => {
  const RESTARTS = [MatchPhase.KICK_OFF, MatchPhase.THROW_IN, MatchPhase.GOAL_KICK, MatchPhase.CORNER, MatchPhase.FREE_KICK, MatchPhase.PENALTY];
  const DEAD = [MatchPhase.PRE_MATCH, MatchPhase.GOAL, MatchPhase.CELEBRATION, MatchPhase.REPLAY, MatchPhase.HALF_TIME,
    MatchPhase.FULL_TIME, MatchPhase.EXTRA_TIME, MatchPhase.SHOOT_OUT, MatchPhase.POST_MATCH];

  // [owner team, ball u in the owner's frame, expected owner phase, expected other phase]
  const TABLE: [number, number, TeamPhase, TeamPhase][] = [];
  for (const team of [0, 1]) {
    TABLE.push([team, -45, TeamPhase.BUILD_UP, TeamPhase.DEFEND]);
    TABLE.push([team, -25, TeamPhase.BUILD_UP, TeamPhase.DEFEND]);
    TABLE.push([team, -10, TeamPhase.ATTACK, TeamPhase.DEFEND]);
    TABLE.push([team, 0, TeamPhase.ATTACK, TeamPhase.DEFEND]);
    TABLE.push([team, 30, TeamPhase.ATTACK, TeamPhase.DEFEND]);
    TABLE.push([team, 50, TeamPhase.ATTACK, TeamPhase.DEFEND]);
  }
  it.each(TABLE)('settled possession, team %i, ball u=%f -> %i / other %i', (team, u, want, other) => {
    const s = base();
    settle(s, team, TeamPhase.DEFEND); // previous phase neutral (no hysteresis memory)
    s.teams[team]!.phase = TeamPhase.DEFEND;
    const slot = team * 11 + 6;
    place(s, team, 6, u, 3);
    own(s, slot);
    tick(s);
    expect(s.teams[team]!.phase).toBe(want);
    expect(s.teams[1 - team]!.phase).toBe(other);
    expect(possessionStatus(s, team)).toBe(1);
    expect(possessionStatus(s, 1 - team)).toBe(0);
  });

  it.each(RESTARTS)('restart phase %i -> SET_PIECE for both teams (restart team holds possession)', (ph) => {
    const s = base();
    settle(s, 0);
    s.match.phase = ph;
    s.match.restart.team = 1;
    s.match.restart.kind = RestartKind.THROW_IN;
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.SET_PIECE);
    expect(s.teams[1]!.phase).toBe(TeamPhase.SET_PIECE);
    expect(possessionStatus(s, 1)).toBe(1);
    expect(s.teams[1]!.possT).toBe(0);
    expect(s.teams[0]!.lostT).toBe(0);
  });

  it.each(DEAD)('dead-ball phase %i -> SET_PIECE, possession unchanged', (ph) => {
    const s = base();
    settle(s, 0);
    s.match.phase = ph;
    ballAt(s, 10, 0);
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.SET_PIECE);
    expect(s.teams[1]!.phase).toBe(TeamPhase.SET_PIECE);
    expect(possessionStatus(s, 0)).toBe(1);
    expect(s.teams[0]!.possT).toBe(301);
  });

  it('build-up / attack switch has hysteresis around the own-third line', () => {
    const s = base();
    settle(s, 0, TeamPhase.BUILD_UP);
    const line = -HALF_LENGTH / 3, h = LOCAL_TUNING.thirdHysteresis;
    const seq: [number, TeamPhase][] = [
      [line - 1, TeamPhase.BUILD_UP], [line + h - 0.1, TeamPhase.BUILD_UP], [line + h + 0.1, TeamPhase.ATTACK],
      [line + 0.5, TeamPhase.ATTACK], [line - h + 0.1, TeamPhase.ATTACK], [line - h - 0.1, TeamPhase.BUILD_UP],
      [line + 1, TeamPhase.BUILD_UP],
    ];
    for (const [u, want] of seq) {
      place(s, 0, 6, u, 0);
      own(s, 6);
      tick(s);
      expect(s.teams[0]!.phase, `u=${u}`).toBe(want);
    }
  });

  it('phaseT counts ticks in the phase and resets on a change; clocks count and cap', () => {
    const s = base();
    settle(s, 0, TeamPhase.ATTACK);
    s.teams[0]!.phaseT = 0;
    place(s, 0, 6, 10, 0); own(s, 6);
    tick(s); tick(s); tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.ATTACK);
    expect(s.teams[0]!.phaseT).toBe(3);
    expect(s.teams[0]!.possT).toBe(303);
    expect(s.teams[0]!.lostT).toBe(903);
    place(s, 0, 6, -40, 0); own(s, 6);
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.BUILD_UP);
    expect(s.teams[0]!.phaseT).toBe(0);
    s.teams[0]!.possT = CLOCK_MAX - 1; s.teams[0]!.lostT = CLOCK_MAX; s.teams[0]!.phaseT = CLOCK_MAX;
    tick(s);
    expect(s.teams[0]!.possT).toBe(CLOCK_MAX - 1 + 1);
    expect(s.teams[0]!.lostT).toBe(CLOCK_MAX);
    expect(s.teams[0]!.phaseT).toBe(CLOCK_MAX);
  });

  it('corrupt clocks / phaseT are repaired to finite values', () => {
    const s = base();
    s.teams[0]!.possT = Number.NaN; s.teams[0]!.lostT = -5; s.teams[0]!.phaseT = Number.POSITIVE_INFINITY;
    place(s, 0, 6, 10, 0); own(s, 6);
    tick(s);
    for (const k of ['possT', 'lostT', 'phaseT'] as const) {
      expect(Number.isFinite(s.teams[0]![k])).toBe(true);
      expect(s.teams[0]![k]).toBeGreaterThanOrEqual(0);
    }
    expect(possessionStatus(s, 0)).toBe(1);
  });
});

describe('TAI-06 possession bookkeeping', () => {
  it('fresh state: first known possession is adopted without a transition', () => {
    const s = base();
    expect(possessionStatus(s, 0)).toBe(-1);
    place(s, 1, 6, -30, 0); own(s, 17);
    tick(s);
    expect(possessionStatus(s, 1)).toBe(1);
    expect(possessionStatus(s, 0)).toBe(0);
    expect(s.teams[1]!.phase).toBe(TeamPhase.BUILD_UP);
    expect(s.teams[0]!.phase).toBe(TeamPhase.DEFEND);
  });

  it('untouched loose ball with no history: nobody in possession, both defend', () => {
    const s = base();
    ballAt(s, 0, 0);
    tick(s);
    expect(possessionStatus(s, 0)).toBe(-1);
    expect(possessionStatus(s, 1)).toBe(-1);
    expect(s.teams[0]!.phase).toBe(TeamPhase.DEFEND);
    expect(s.teams[1]!.phase).toBe(TeamPhase.DEFEND);
    expect(controlTeam(s, 0, -1)).toBe(-1);
  });

  it('own pass in flight keeps possession (no phase change, no transition)', () => {
    const s = base();
    settle(s, 0);
    ballAt(s, 5, 2);
    const b = s.ball;
    b.lastTouch = 6; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 6; b.lastKickTeam = 0;
    b.lastKickTick = s.tick; b.lastKickKind = KickKind.GROUND_PASS; b.passTarget = 9;
    tick(s);
    expect(possessionStatus(s, 0)).toBe(1);
    expect(s.teams[0]!.phase).toBe(TeamPhase.ATTACK);
    expect(s.teams[1]!.phase).toBe(TeamPhase.DEFEND);
  });

  it('a deflection or tackle poke by the opponent is sticky (50/50 never flips the phase)', () => {
    for (const kind of [KickKind.DEFLECTION, KickKind.TACKLE_POKE, KickKind.GK_PARRY, KickKind.GK_PUNCH, KickKind.GK_TIP]) {
      const s = base();
      settle(s, 0);
      ballAt(s, 10, 0);
      const b = s.ball;
      b.lastTouch = 14; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 14; b.lastKickTeam = 1;
      b.lastKickTick = s.tick; b.lastKickKind = kind;
      tick(s);
      expect(possessionStatus(s, 0), `kind ${kind}`).toBe(1);
      expect(s.teams[1]!.phase, `kind ${kind}`).toBe(TeamPhase.DEFEND);
      // A plain touch (recordTouch without a kick) is sticky too.
      b.lastKickTick = s.tick - 10; b.lastTouchTick = s.tick;
      tick(s);
      expect(possessionStatus(s, 0)).toBe(1);
    }
  });

  it('a clearance by the opponent hands possession over at once (just lost -> TRANSITION_DEFEND)', () => {
    const s = base();
    settle(s, 0);
    ballAt(s, 30, 0);
    const b = s.ball;
    b.lastTouch = 13; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 13; b.lastKickTeam = 1;
    b.lastKickTick = s.tick; b.lastKickKind = KickKind.CLEARANCE;
    tick(s);
    expect(possessionStatus(s, 1)).toBe(1);
    expect(s.teams[1]!.possT).toBe(0);
    expect(s.teams[0]!.lostT).toBe(0);
    expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
  });

  it('a shot in flight keeps the shooting team in possession; a keeper catch hands it over', () => {
    const s = base();
    settle(s, 0);
    ballAt(s, 45, 1);
    const b = s.ball;
    b.lastTouch = 9; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.lastKickBy = 9; b.lastKickTeam = 0;
    b.lastKickTick = s.tick; b.lastKickKind = KickKind.SHOT_NORMAL; b.shotBy = 9;
    tick(s);
    expect(possessionStatus(s, 0)).toBe(1);
    expect(s.teams[0]!.phase).toBe(TeamPhase.ATTACK);
    // The keeper (slot 11) catches it.
    b.owner = 11; b.heldBy = 11; b.lastTouch = 11; b.lastTouchTeam = 1; b.lastTouchTick = s.tick;
    tick(s);
    expect(possessionStatus(s, 1)).toBe(1);
    expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
  });

  it('keeper catch with the opponents committed forward -> TRANSITION_ATTACK (quick release window for GKP-04)', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    own(s, 0); // team 0 keeper holds it at u = -50
    s.ball.heldBy = 0;
    expect(counterMargin(s, 0)).toBeGreaterThanOrEqual(0);
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
    expect(s.teams[1]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
  });

  it('possT / lostT: gain zeroes possT, loss zeroes lostT, both mirror across teams', () => {
    const s = base();
    settle(s, 0);
    place(s, 1, 6, -30, 0); own(s, 17);
    tick(s);
    const [t0, t1] = s.teams as [typeof s.teams[0], typeof s.teams[0]];
    expect(t1.possT).toBe(0);
    expect(t0.lostT).toBe(0);
    expect(t1.lostT).toBe(301);
    expect(t0.possT).toBe(301);
    for (let i = 0; i < 10; i++) tick(s);
    expect(t1.possT).toBe(10);
    expect(t0.lostT).toBe(10);
    expect(possessionStatus(s, 1)).toBe(1);
    expect(possessionStatus(s, 0)).toBe(0);
  });

  it('possession change during a restart never starts a transition when play resumes', () => {
    const s = base();
    settle(s, 0);
    s.match.phase = MatchPhase.THROW_IN;
    s.match.restart.team = 1; s.match.restart.kind = RestartKind.THROW_IN;
    place(s, 1, 6, -20, 30); own(s, 17);
    for (let i = 0; i < 40; i++) tick(s);
    expect(s.teams[1]!.phase).toBe(TeamPhase.SET_PIECE);
    s.match.phase = MatchPhase.IN_PLAY;
    tick(s);
    expect(s.teams[1]!.phase).toBe(TeamPhase.BUILD_UP); // u = -20: own third, no TRANSITION_ATTACK
    expect(s.teams[0]!.phase).toBe(TeamPhase.DEFEND);
  });
});

describe('TAI-06 transitions (counters after interceptions, recovery windows)', () => {
  it.each([0, 1])('interception deep with the opponent committed: team %i counters, the loser transitions to defend', (d) => {
    const a = 1 - d;
    const s = counterSetup(a, TeamStyle.POSSESSION);
    expect(counterMargin(s, d)).toBeGreaterThanOrEqual(0);
    tick(s);
    expect(s.teams[d]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
    expect(s.teams[a]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
    expect(s.teams[d]!.phaseT).toBe(0);
    expect(s.teams[d]!.possT).toBe(0);
    expect(s.teams[a]!.lostT).toBe(0);
  });

  it('interception against a set defence: no counter (build-up), loser still transitions to defend', () => {
    const s = base();
    settle(s, 1);
    own(s, 2); // team 0 CB in his own third, everybody in kick-off shape
    expect(counterMargin(s, 0)).toBeLessThan(0);
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.BUILD_UP);
    expect(s.teams[1]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
  });

  it('counter style counters from a lower space threshold than possession style', () => {
    const margins: Record<number, number> = {};
    for (const style of [TeamStyle.POSSESSION, TeamStyle.DIRECT, TeamStyle.COUNTER]) {
      const s = counterSetup(1, style, 4); // four opponents back, two of ours up
      margins[style] = counterMargin(s, 0);
      tick(s);
      const want = margins[style]! >= 0 ? TeamPhase.TRANSITION_ATTACK : TeamPhase.BUILD_UP;
      expect(s.teams[0]!.phase, `style ${style}`).toBe(want);
    }
    expect(margins[TeamStyle.POSSESSION]!).toBeLessThan(0);
    expect(margins[TeamStyle.COUNTER]!).toBeGreaterThanOrEqual(0);
  });

  it('TRANSITION_ATTACK lasts the style window, then reverts to build-up/attack', () => {
    for (const style of [TeamStyle.POSSESSION, TeamStyle.COUNTER]) {
      const s = counterSetup(1, style);
      tick(s);
      expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
      const w = attackWindowTicks(s.teams[0]!);
      let n = 1;
      while (s.teams[0]!.phase === TeamPhase.TRANSITION_ATTACK && n < 1000) { tick(s); n++; }
      expect(n - 1, `style ${style}`).toBe(w); // n counts the tick that left the phase too
      expect(s.teams[0]!.phase).toBe(TeamPhase.BUILD_UP);
    }
    expect(attackWindowTicks({ style: TeamStyle.COUNTER } as never)).toBe(T_AI.transitionTicks);
  });

  it('TRANSITION_ATTACK ends early when the space is gone (opponents got back)', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
    for (let k = 1; k <= 10; k++) place(s, 1, k, -20, -30 + k * 6); // all ten back in their own half (team-1 frame u = -20)
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.BUILD_UP);
  });

  it('TRANSITION_DEFEND lasts T_AI.transitionTicks while out of possession, then DEFEND', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    tick(s);
    expect(s.teams[1]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
    let n = 1;
    while (s.teams[1]!.phase === TeamPhase.TRANSITION_DEFEND && n < 1000) { tick(s); n++; }
    expect(n - 1).toBe(defendWindowTicks());
    expect(n - 1).toBe(T_AI.transitionTicks);
    expect(s.teams[1]!.phase).toBe(TeamPhase.DEFEND);
  });

  it('regaining the ball during TRANSITION_DEFEND switches straight to the attack side', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    tick(s);
    expect(s.teams[1]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
    for (let i = 0; i < 20; i++) tick(s);
    own(s, 11 + 6); // team 1 wins it straight back
    tick(s);
    expect(possessionStatus(s, 1)).toBe(1);
    expect([TeamPhase.TRANSITION_ATTACK, TeamPhase.ATTACK, TeamPhase.BUILD_UP]).toContain(s.teams[1]!.phase);
    expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
  });
});

describe('TAI-06 assignTransition jobs', () => {
  it.each([0, 1])('counter (team %i): 2-3 runners break at sprint ahead of the ball, carrier and CBs never run', (d) => {
    for (const style of [TeamStyle.POSSESSION, TeamStyle.COUNTER]) {
      const s = counterSetup(1 - d, style);
      tick(s);
      s.teams[d]!.phaseT = 20; // past every style's break delay
      jobs(s);
      const dir = s.teams[d]!.dir;
      const ub = dir * s.ball.x;
      const runners: number[] = [];
      for (let k = 1; k < 11; k++) {
        const p = s.players[d * 11 + k]!;
        if (p.job !== AiJob.RUN_IN_BEHIND && p.job !== AiJob.SUPPORT) continue;
        runners.push(k);
        expect(dir * p.tgtX, `idx ${k}`).toBeGreaterThan(ub);
        expect(p.tgtSpeed).toBe(s.attrs[d * 11 + k]!.topSpeed);
        expect(Math.abs(p.tgtZ)).toBeLessThanOrEqual(34 - LOCAL_TUNING.sideMargin + 1e-9);
      }
      const want = LOCAL_TUNING.inBehindRunners[style]! + LOCAL_TUNING.supportRunners[style]!;
      expect(runners.length, `style ${style}`).toBe(want);
      expect(runners).not.toContain(6); // the carrier
      expect(runners).not.toContain(2);
      expect(runners).not.toContain(3);
      expect(runners).toContain(9); // the strikers lead the break
      expect(runners).toContain(10);
    }
  });

  it('counter runs stay onside (offside on) and short of the goal line', () => {
    const s = counterSetup(1, TeamStyle.COUNTER);
    tick(s);
    // The carrier has broken to the halfway line: runAhead (24 m) would take the runners beyond the line.
    place(s, 0, 6, 0, 8); own(s, 6);
    jobs(s);
    // Team 1's second-last defender (incl. keeper) is at team-0 frame u = 6 (the two CBs back at x = +6).
    for (let k = 1; k < 11; k++) {
      const p = s.players[k]!;
      if (p.job === AiJob.RUN_IN_BEHIND) expect(p.tgtX).toBeLessThanOrEqual(6 - LOCAL_TUNING.onsideMargin + 1e-9);
    }
    s.config.offside = 0;
    jobs(s);
    let deep = 0;
    for (let k = 1; k < 11; k++) {
      const p = s.players[k]!;
      if (p.job === AiJob.RUN_IN_BEHIND) {
        expect(p.tgtX).toBeLessThanOrEqual(HALF_LENGTH - LOCAL_TUNING.goalLineMargin);
        if (p.tgtX > 6) deep++;
      }
    }
    expect(deep).toBeGreaterThan(0);
  });

  it('in-behind lanes keep the runners apart and in their lateral order', () => {
    const s = counterSetup(1, TeamStyle.COUNTER);
    tick(s);
    jobs(s);
    const run = [9, 10].map((k) => s.players[k]!);
    expect(run.every((p) => p.job === AiJob.RUN_IN_BEHIND)).toBe(true);
    // Slot 9 is on the right (+z), slot 10 on the left: their lanes keep that order, laneGap apart.
    expect(run[0]!.tgtZ).toBeGreaterThan(run[1]!.tgtZ);
    expect(run[0]!.tgtZ - run[1]!.tgtZ).toBeCloseTo(LOCAL_TUNING.laneGap, 6);
  });

  it('counter style breaks at once; possession style waits for its break delay', () => {
    for (const style of [TeamStyle.POSSESSION, TeamStyle.COUNTER]) {
      const s = counterSetup(1, style);
      tick(s);
      jobs(s);
      const breaking = s.players.slice(1, 11).filter((p) => p.job === AiJob.RUN_IN_BEHIND).length;
      if (LOCAL_TUNING.breakDelay[style]! > 0) expect(breaking, `style ${style}`).toBe(0);
      else expect(breaking, `style ${style}`).toBeGreaterThan(0);
    }
  });

  it('the intended receiver of our pass in flight is not used as a runner', () => {
    const s = counterSetup(1, TeamStyle.COUNTER);
    tick(s);
    const b = s.ball;
    b.owner = -1; b.lastKickBy = 6; b.lastKickTeam = 0; b.lastKickTick = s.tick; b.lastTouch = 6; b.lastTouchTick = s.tick;
    b.lastKickKind = KickKind.GROUND_PASS; b.passTarget = 9;
    tick(s);
    expect(s.teams[0]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
    jobs(s);
    expect(s.players[9]!.job).toBe(AiJob.HOLD_SHAPE);
    expect(s.players[10]!.job).toBe(AiJob.RUN_IN_BEHIND);
  });

  it.each([0, 1])('recovery (team %i loses it): caught-upfield players get RECOVER to goal-side points, strikers stay', (a) => {
    const s = counterSetup(a, TeamStyle.POSSESSION);
    tick(s);
    jobs(s);
    const dir = s.teams[a]!.dir;
    const ub = dir * s.ball.x;
    const rec: number[] = [];
    for (let k = 1; k < 11; k++) {
      const p = s.players[a * 11 + k]!;
      if (p.job !== AiJob.RECOVER) continue;
      rec.push(k);
      expect(dir * p.tgtX, `idx ${k}`).toBeLessThanOrEqual(ub - LOCAL_TUNING.recoverDepth + 1e-9);
      expect(p.tgtSpeed).toBe(s.attrs[a * 11 + k]!.topSpeed);
    }
    // Wide midfielders caught at u = 36 (ball at u = 36) and CMs whose homes (u = 18) are... goal-side: only the
    // caught ones and those with homes ahead of the goal-side point (u_ball - 6 = 30) run.
    expect(rec).toContain(5);
    expect(rec).toContain(8);
    expect(rec).not.toContain(9); // strikers stay up as outlets
    expect(rec).not.toContain(10);
    expect(rec).not.toContain(6); // goal-side with a goal-side home
  });

  it('recovery point lies on the ball-goal line blended toward the home lane', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    tick(s);
    jobs(s);
    const dir = s.teams[1]!.dir;
    const ub = dir * s.ball.x, vb = dir * s.ball.z;
    const p = s.players[11 + 5]!; // RM, home (30, 22)
    expect(p.job).toBe(AiJob.RECOVER);
    const u = ub - LOCAL_TUNING.recoverDepth;
    const vLine = vb * (u + HALF_LENGTH) / (ub + HALF_LENGTH);
    const v = vLine + (22 - vLine) * LOCAL_TUNING.lateralKeep;
    expect(dir * p.tgtX).toBeCloseTo(u, 9);
    expect(dir * p.tgtZ).toBeCloseTo(v, 9);
  });

  it('a goal-side player already marking is not pulled off his man', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    tick(s);
    // Team-1 CM (idx 7) goal-side at u = 25 (ball at u = 36) but with a home ahead of the goal-side point.
    place(s, 1, 7, 25, -6, 34, -6);
    resetJobs(s, 1);
    s.players[11 + 7]!.job = AiJob.MARK;
    assignTransition(s, 1, NULL_SINK);
    expect(s.players[11 + 7]!.job).toBe(AiJob.MARK);
  });

  it.each([0, 1])('team %i: a caught-upfield presser keeps PRESS (more urgent than RECOVER); the others still recover', (a) => {
    // TAI-05 runs before assignTransition and gives the player nearest the ball PRESS (10 > RECOVER 9 in AiJob order).
    const s = counterSetup(a, TeamStyle.POSSESSION);
    tick(s);
    resetJobs(s, a);
    const presser = a * 11 + 5; // RM caught upfield level with the ball (u = 36)
    const d = s.teams[a]!.dir;
    const pp = s.players[presser]!;
    expect(assignJob(s, presser, AiJob.PRESS, pp.x - d * 1.5, pp.z, s.attrs[presser]!.topSpeed * 0.8, a === 0 ? 17 : 6)).toBe(true);
    const before = { x: s.players[presser]!.tgtX, z: s.players[presser]!.tgtZ, sp: s.players[presser]!.tgtSpeed };
    assignTransition(s, a, NULL_SINK);
    const p = s.players[presser]!;
    expect(p.job).toBe(AiJob.PRESS);
    expect([p.tgtX, p.tgtZ, p.tgtSpeed]).toEqual([before.x, before.z, before.sp]);
    // The other caught-upfield wide midfielder still runs, to the same goal-side point as without the press.
    const q = s.players[a * 11 + 8]!;
    expect(q.job).toBe(AiJob.RECOVER);
    expect(d * q.tgtX).toBeLessThanOrEqual(d * s.ball.x - LOCAL_TUNING.recoverDepth + 1e-9);
    const ref = counterSetup(a, TeamStyle.POSSESSION);
    tick(ref);
    resetJobs(ref, a);
    assignTransition(ref, a, NULL_SINK);
    expect(ref.players[presser]!.job).toBe(AiJob.RECOVER); // without the press he would have recovered
    expect([q.tgtX, q.tgtZ]).toEqual([ref.players[a * 11 + 8]!.tgtX, ref.players[a * 11 + 8]!.tgtZ]);
  });

  it('Players glitch "orbit or jitter": recovery target is stable across the goal-side boundary (no RECOVER/HOLD flip-flop)', () => {
    const s = counterSetup(1, TeamStyle.POSSESSION);
    tick(s);
    const dir = s.teams[1]!.dir;
    const ub = dir * s.ball.x;
    // A winger-like player with a home ahead of the ball walks back through every depth: whenever he is not deeper
    // than his recovery point he gets RECOVER to the same point; deeper, he is left to the shape (moving him up into
    // the point again). The target never jumps between the point and the home in between.
    const pt = ub - LOCAL_TUNING.recoverDepth;
    let tgt: number | null = null;
    for (let u = 45; u >= pt - LOCAL_TUNING.holdTolerance + 0.01; u -= 0.25) {
      place(s, 1, 5, u, 20, 40, 22);
      resetJobs(s, 1);
      assignTransition(s, 1, NULL_SINK);
      const p = s.players[11 + 5]!;
      expect(p.job, `u=${u}`).toBe(AiJob.RECOVER);
      if (tgt === null) tgt = p.tgtX;
      expect(p.tgtX).toBe(tgt);
    }
    place(s, 1, 5, pt - 3, 20, 40, 22);
    resetJobs(s, 1);
    assignTransition(s, 1, NULL_SINK);
    expect(s.players[11 + 5]!.job).toBe(AiJob.HOLD_SHAPE);
  });

  it('recover duty: focus and style change who recovers (counter style brings the CF back, high press keeps wingers up)', () => {
    // F433: idx 8 RW, 9 ST, 10 LW. Team 1 loses the ball with the front three caught upfield.
    const run = (style: TeamStyle, focus: TacticalFocus): number[] => {
      const s = counterSetup(1, TeamStyle.POSSESSION);
      s.teams[1]!.style = style;
      s.teams[1]!.focus = focus;
      s.teams[1]!.formation = 1; // 4-3-3
      tick(s);
      jobs(s);
      const out: number[] = [];
      for (let k = 1; k < 11; k++) if (s.players[11 + k]!.job === AiJob.RECOVER) out.push(k);
      return out;
    };
    const def = run(TeamStyle.POSSESSION, TacticalFocus.DEFAULT);
    expect(def).toContain(8); // RW 0.45 * 1.2 = 0.54
    expect(def).not.toContain(9);
    const hp = run(TeamStyle.HIGH_PRESS, TacticalFocus.DEFAULT);
    expect(hp).not.toContain(8); // 0.54 * 0.85 < 0.5
    const att = run(TeamStyle.POSSESSION, TacticalFocus.ATTACKING);
    expect(att).not.toContain(8); // 0.54 * 0.85
  });

  it('no jobs outside IN_PLAY or outside transition phases', () => {
    const s = counterSetup(1, TeamStyle.COUNTER);
    tick(s);
    s.match.phase = MatchPhase.THROW_IN;
    jobs(s);
    expect(s.players.filter((p) => p.job === AiJob.RECOVER || p.job === AiJob.RUN_IN_BEHIND).length).toBe(0);
    s.match.phase = MatchPhase.IN_PLAY;
    s.teams[0]!.phase = TeamPhase.ATTACK;
    s.teams[1]!.phase = TeamPhase.DEFEND;
    jobs(s);
    expect(s.players.filter((p) => p.job !== AiJob.HOLD_SHAPE && p.job !== AiJob.NONE).length).toBe(0);
  });

  it('controlled players are never given transition jobs', () => {
    const s = counterSetup(1, TeamStyle.COUNTER);
    s.players[9]!.ctrl = 2; s.ctrl[2]!.slot = 9;
    s.players[11 + 5]!.ctrl = 3; s.ctrl[3]!.slot = 16;
    tick(s);
    jobs(s);
    expect(s.players[9]!.job).toBe(AiJob.NONE);
    expect(s.players[16]!.job).toBe(AiJob.NONE);
  });
});

describe('TAI-06 mirroring and determinism', () => {
  it('both attack directions give identical phases and exactly mirrored job targets', () => {
    for (const style of [TeamStyle.POSSESSION, TeamStyle.COUNTER, TeamStyle.HIGH_PRESS]) {
      const A = counterSetup(1, style); // team 0 wins the ball
      const B = counterSetup(0, style); // team 1 wins the ball (mirror image)
      for (let n = 0; n < 30; n++) {
        tick(A); tick(B);
        jobs(A); jobs(B);
        for (let t = 0; t < 2; t++) {
          const ta = A.teams[t]!, tb = B.teams[1 - t]!;
          expect(tb.phase).toBe(ta.phase);
          expect(tb.phaseT).toBe(ta.phaseT);
          expect(tb.possT).toBe(ta.possT);
          expect(tb.lostT).toBe(ta.lostT);
          for (let k = 0; k < 11; k++) {
            const pa = A.players[t * 11 + k]!, pb = B.players[(1 - t) * 11 + k]!;
            expect(pb.job).toBe(pa.job);
            expect(pb.tgtX === -pa.tgtX, `tgtX ${pb.tgtX} vs ${pa.tgtX}`).toBe(true);
            expect(pb.tgtZ === -pa.tgtZ, `tgtZ ${pb.tgtZ} vs ${pa.tgtZ}`).toBe(true);
            expect(pb.tgtSpeed).toBe(pa.tgtSpeed);
          }
        }
      }
    }
  });

  it('pure function of state: same state, same results', () => {
    const A = counterSetup(1, TeamStyle.DIRECT);
    const B = counterSetup(1, TeamStyle.DIRECT);
    for (let n = 0; n < 50; n++) {
      tick(A); jobs(A); jobs(A); // running the job pass twice changes nothing
      tick(B); jobs(B);
      expect(JSON.stringify(A.players)).toBe(JSON.stringify(B.players));
      expect(JSON.stringify(A.teams)).toBe(JSON.stringify(B.teams));
    }
  });
});

describe('TAI-06 ATTACK_BUILD (crowd)', () => {
  it('emitted when the ball enters the final third in possession, periodically while it stays, never for the defenders', () => {
    const s = base();
    settle(s, 0);
    const sink = recSink();
    place(s, 0, 9, 10, 0); own(s, 9);
    tick(s, sink);
    expect(sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD)).toHaveLength(0);
    // Enter: previous ball position in the middle third, now in the final third.
    s.ball.px = 15; s.ball.x = 20; s.players[9]!.x = 20;
    tick(s, sink);
    let ab = sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD);
    expect(ab).toHaveLength(1);
    expect(ab[0]!.a).toBe(0);
    expect(ab[0]!.c).toBeGreaterThan(0);
    expect(ab[0]!.c).toBeLessThanOrEqual(1);
    // Stay in the final third for 2 s: periodic re-emission only.
    sink.ev.length = 0;
    s.ball.px = 20;
    for (let i = 0; i < 120; i++) tick(s, sink);
    ab = sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD);
    expect(ab.length).toBe(2);
    // Deeper and central = more intense.
    sink.ev.length = 0;
    s.ball.px = 10; s.ball.x = 45; s.ball.z = 0;
    tick(s, sink);
    const deep = sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD)[0]!;
    sink.ev.length = 0;
    s.ball.px = 10; s.ball.x = 20; s.ball.z = 30;
    tick(s, sink);
    const wide = sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD)[0]!;
    expect(deep.c).toBeGreaterThan(wide.c);
    // Outside IN_PLAY: nothing.
    sink.ev.length = 0;
    s.match.phase = MatchPhase.CORNER; s.match.restart.team = 0;
    s.ball.px = 10; s.ball.x = 50;
    tick(s, sink);
    expect(sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD)).toHaveLength(0);
  });

  it('winning the ball inside the final third emits at once (mirrored for team 1)', () => {
    const s = base();
    settle(s, 0);
    const sink = recSink();
    place(s, 1, 9, 30, 0); own(s, 20); // team 1 striker wins it at team-1 u = 30
    s.ball.px = s.ball.x;
    tick(s, sink);
    const ab = sink.ev.filter((e) => e.type === EventType.ATTACK_BUILD);
    expect(ab).toHaveLength(1);
    expect(ab[0]!.a).toBe(1);
  });
});
