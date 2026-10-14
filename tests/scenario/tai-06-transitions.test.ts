/**
 * TAI-06 scenario tests through the real tick pipeline (sim/step.ts -> ai/index.ts teamAiTick: updateTeamPhase ->
 * shape -> jobs -> assignTransition -> TAI-07 executeJobs -> SIM-04 locomotion), with whatever the other modules
 * currently implement around it (SIM-06 possession and the CPU brains may still be stubs: the carrier is held on
 * the ball by the test where it matters).
 */
import { describe, expect, it } from 'vitest';
import { AiJob, ControllerKind, MatchPhase, TeamPhase, TeamStyle } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_AI } from '../../src/contracts/tuning';
import { LOCAL_TUNING, possessionStatus } from '../../src/ai/transition';
import { hashState } from '../../src/sim/core/hash';
import { makeScenario, runTicks } from '../harness/scenario';

function place(s: SimState, team: number, idx: number, u: number, v: number): void {
  const p = s.players[team * 11 + idx]!;
  const d = s.teams[team]!.dir;
  p.x = d * u; p.z = d * v; p.vx = 0; p.vz = 0; p.homeX = p.x; p.homeZ = p.z;
}

/**
 * Team A (`a`) camped in the other half after a long spell on the ball; team D's CM (idx 6) has just intercepted
 * at u_D = -36. Two of A's defenders stay back (u_A = -6), two of D's strikers are up (u_D = -8 / -10).
 */
function interception(a: number, styleD: TeamStyle, seed = 5): SimState {
  const d = 1 - a;
  const styles = a === 0 ? [TeamStyle.POSSESSION, styleD] : [styleD, TeamStyle.POSSESSION];
  const s = makeScenario({
    seed, phase: MatchPhase.IN_PLAY, config: { homeClub: 0, awayClub: 0 },
    teams: [{ style: styles[0] }, { style: styles[1] }],
  });
  place(s, d, 0, -50, 0);
  place(s, d, 1, -40, 18); place(s, d, 2, -44, 6); place(s, d, 3, -44, -6); place(s, d, 4, -40, -18);
  place(s, d, 5, -34, 24); place(s, d, 6, -36, 8); place(s, d, 7, -36, -8); place(s, d, 8, -34, -24);
  place(s, d, 9, -8, 6); place(s, d, 10, -10, -8);
  place(s, a, 0, -45, 0);
  place(s, a, 1, 28, 20); place(s, a, 2, -6, 8); place(s, a, 3, -6, -8); place(s, a, 4, 28, -20);
  place(s, a, 5, 40, 22); place(s, a, 6, 38, 4); place(s, a, 7, 39, -9); place(s, a, 8, 41, -22);
  place(s, a, 9, 44, 5); place(s, a, 10, 45, -4);
  const ta = s.teams[a]!, td = s.teams[d]!;
  ta.possT = 300; ta.lostT = 900; ta.phase = TeamPhase.ATTACK; ta.phaseT = 300;
  td.possT = 900; td.lostT = 300; td.phase = TeamPhase.DEFEND; td.phaseT = 300;
  // No CPU brains: every player but the scripted carrier is team AI (the CPU modules may still be stubs, and a CPU
  // controller switching between defenders would take players in and out of the job system).
  for (const k of [2, 3]) { s.ctrl[k]!.kind = ControllerKind.NONE; s.ctrl[k]!.side = -1; s.ctrl[k]!.slot = -1; }
  for (const t of s.teams) t.cpu.active = 0;
  for (const p of s.players) p.ctrl = -1;
  const c = s.players[d * 11 + 6]!;
  const b = s.ball;
  b.x = c.x; b.z = c.z; b.px = c.x; b.pz = c.z; b.y = 0.11; b.owner = c.slot;
  b.lastTouch = c.slot; b.lastTouchTeam = d; b.lastTouchTick = s.tick;
  return s;
}

/** Keep the carrier on the ball (moving it `speed` m/s toward the attacked goal) whatever the stubs do. */
function holdCarrier(slot: number, speed: number) {
  return (_tick: number, s: SimState): void => {
    const p = s.players[slot]!;
    const b = s.ball;
    const dir = s.teams[p.team]!.dir;
    b.x += (dir * speed) / 60;
    b.px = b.x; b.pz = b.z; b.vx = 0; b.vz = 0; b.y = 0.11; b.vy = 0;
    b.owner = slot; b.lastTouch = slot; b.lastTouchTeam = p.team; b.touchedTick = s.tick + 1;
    p.x = b.x - dir * 0.4; p.z = b.z; p.vx = dir * speed; p.vz = 0;
  };
}

const u = (s: SimState, team: number, x: number): number => s.teams[team]!.dir * x;

/** A break by this module: RUN_IN_BEHIND, or SUPPORT at sprint (TAI-02's supporters jog). */
const isBreak = (s: SimState, slot: number): boolean => {
  const p = s.players[slot]!;
  return p.job === AiJob.RUN_IN_BEHIND || (p.job === AiJob.SUPPORT && p.tgtSpeed === s.attrs[slot]!.topSpeed);
};

describe('TAI-06 counters after interceptions (pipeline)', () => {
  it.each([0, 1])('team %i intercepts: counter phase, runners break at sprint, the losers recover', (d) => {
    const a = 1 - d;
    const s = interception(a, TeamStyle.COUNTER);
    const carrier = d * 11 + 6;
    runTicks(s, 1, holdCarrier(carrier, 0), { check: 'core' });
    expect(s.teams[d]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
    expect(s.teams[a]!.phase).toBe(TeamPhase.TRANSITION_DEFEND);
    expect(possessionStatus(s, d)).toBe(1);

    const start = [9, 10].map((k) => u(s, d, s.players[d * 11 + k]!.x));
    const runners = new Set<number>();
    let maxSpeed = 0;
    runTicks(s, 60, holdCarrier(carrier, 0), {
      check: 'core',
      until: (st) => {
        for (let k = 1; k < 11; k++) {
          const p = st.players[d * 11 + k]!;
          if (isBreak(st, d * 11 + k)) {
            runners.add(k);
            expect(u(st, d, p.tgtX)).toBeGreaterThan(u(st, d, st.ball.x));
          }
          if (k === 9 || k === 10) maxSpeed = Math.max(maxSpeed, Math.hypot(p.vx, p.vz));
        }
        return false;
      },
    });
    expect(s.teams[d]!.phase).toBe(TeamPhase.TRANSITION_ATTACK);
    expect(runners.size).toBeGreaterThanOrEqual(2);
    expect(runners.size).toBeLessThanOrEqual(3);
    expect(runners.has(2) || runners.has(3)).toBe(false); // centre-backs never break
    // The strikers break forward at sprint (above jog speed).
    const end = [9, 10].map((k) => u(s, d, s.players[d * 11 + k]!.x));
    for (let i = 0; i < 2; i++) expect(end[i]! - start[i]!).toBeGreaterThan(3);
    expect(maxSpeed).toBeGreaterThan(s.attrs[d * 11 + 9]!.topSpeed * 0.6 + 0.3);
  });

  it('counter style breaks faster and with more runners than possession style', () => {
    const adv: Record<number, number> = {};
    const cnt: Record<number, number> = {};
    const first: Record<number, number> = {};
    for (const style of [TeamStyle.POSSESSION, TeamStyle.COUNTER]) {
      const s = interception(1, style);
      const start = [9, 10].map((k) => s.players[k]!.x);
      const runners = new Set<number>();
      first[style] = -1;
      runTicks(s, 120, holdCarrier(6, 0), {
        check: 'core',
        until: (st) => {
          for (let k = 1; k < 11; k++) {
            if (!isBreak(st, k)) continue;
            runners.add(k);
            if (first[style]! < 0 && st.players[k]!.tgtSpeed === st.attrs[k]!.topSpeed) first[style] = st.tick;
          }
          return false;
        },
      });
      adv[style] = [9, 10].reduce((acc, k, i) => acc + s.players[k]!.x - start[i]!, 0);
      cnt[style] = runners.size;
    }
    // Counter: breaks on the first tick, three runners, both strikers sprint for the line.
    expect(first[TeamStyle.COUNTER]).toBe(1);
    expect(first[TeamStyle.POSSESSION]!).toBe(1 + LOCAL_TUNING.breakDelay[TeamStyle.POSSESSION]!);
    expect(cnt[TeamStyle.COUNTER]!).toBeGreaterThan(cnt[TeamStyle.POSSESSION]!);
    expect(adv[TeamStyle.COUNTER]!).toBeGreaterThan(adv[TeamStyle.POSSESSION]! + 1);
  });

  it('the counter window ends after the style window and the team settles into build-up / attack', () => {
    const s = interception(1, TeamStyle.COUNTER);
    let first = -1, last = -1;
    runTicks(s, T_AI.transitionTicks + 30, holdCarrier(6, 0), {
      until: (st) => {
        if (st.teams[0]!.phase === TeamPhase.TRANSITION_ATTACK) { if (first < 0) first = st.tick; last = st.tick; }
        return false;
      },
    });
    expect(first).toBe(1);
    expect(last - first + 1).toBeLessThanOrEqual(T_AI.transitionTicks);
    expect([TeamPhase.BUILD_UP, TeamPhase.ATTACK]).toContain(s.teams[0]!.phase);
  });
});

describe('TAI-06 recovery runs (pipeline)', () => {
  /** Team-A players with recover duty caught upfield: the 4-4-2 midfield four at u = 38-41, ball at u = 36. */
  const RECOVERERS = [5, 6, 7, 8];
  /** Margin for judging "caught upfield" after the tick's movement (jobs are assigned before locomotion), m. */
  const MOVE_SLACK = 0.5;

  interface RecoveryTrace {
    /** Midfielders that held RECOVER at some tick (the recovery runners). */
    recover: Set<number>;
    /** Midfielders that held a job more urgent than RECOVER (PRESS, CHASE_LOOSE, ...) at some tick. */
    urgent: Set<number>;
    /** First tick each recovery runner was goal-side of the ball. */
    goalSide: Map<number, number>;
    /** Strikers that ever held RECOVER (must stay empty: they are outlets). */
    strikersRecover: Set<number>;
    /** Contract breaches: a player clearly caught upfield during TRANSITION_DEFEND without RECOVER or a more urgent job. */
    missed: string[];
  }

  /**
   * Per-tick check of the recovery contract while team `a` is in TRANSITION_DEFEND: every midfielder clearly caught
   * upfield holds RECOVER unless a more urgent job owns him (assignJob never lowers priority: PRESS 10 > RECOVER 9, so
   * TAI-05's presser keeps pressing). Records who ran and when each runner got goal-side.
   */
  function traceRecovery(a: number): { tr: RecoveryTrace; until: (st: SimState) => boolean } {
    const tr: RecoveryTrace = { recover: new Set(), urgent: new Set(), goalSide: new Map(), strikersRecover: new Set(), missed: [] };
    const until = (st: SimState): boolean => {
      const ub = u(st, a, st.ball.x);
      const inWindow = st.match.phase === MatchPhase.IN_PLAY && st.teams[a]!.phase === TeamPhase.TRANSITION_DEFEND;
      for (const k of RECOVERERS) {
        const p = st.players[a * 11 + k]!;
        const up = u(st, a, p.x);
        if (p.job === AiJob.RECOVER) tr.recover.add(k);
        if (p.job > AiJob.RECOVER) tr.urgent.add(k);
        if (inWindow && up > ub - LOCAL_TUNING.goalSideMargin + MOVE_SLACK && p.job < AiJob.RECOVER) {
          tr.missed.push(`tick ${st.tick} idx ${k} at u ${up.toFixed(2)} (ball ${ub.toFixed(2)}) job ${AiJob[p.job]}`);
        }
        if (p.job === AiJob.RECOVER && !tr.goalSide.has(k)) tr.goalSide.set(k, -1); // ran; goal-side tick below
        if (tr.goalSide.get(k) === -1 && up < ub - LOCAL_TUNING.goalSideMargin) tr.goalSide.set(k, st.tick);
      }
      for (const k of [9, 10]) if (st.players[a * 11 + k]!.job === AiJob.RECOVER) tr.strikersRecover.add(k);
      return false;
    };
    return { tr, until };
  }

  /** Shared assertions: the contract held every tick, at most the presser was exempt, every runner ended goal-side. */
  function expectRecovered(s: SimState, a: number, tr: RecoveryTrace, ticks: number): void {
    expect(tr.missed, 'caught upfield without RECOVER or a more urgent job').toEqual([]);
    // Everyone not on a recovery run was owned by a more urgent job; with the carrier held on the ball that can only be
    // the one presser, so at least three of the four midfielders make recovery runs.
    for (const k of RECOVERERS) {
      if (!tr.recover.has(k)) expect(tr.urgent.has(k), `idx ${k} neither recovered nor had a more urgent job`).toBe(true);
    }
    expect(tr.recover.size, 'recovery runners').toBeGreaterThanOrEqual(RECOVERERS.length - 1);
    const ub = u(s, a, s.ball.x);
    for (const k of tr.recover) {
      const t = tr.goalSide.get(k)!;
      expect(t, `idx ${k} got goal-side`).toBeGreaterThan(0);
      expect(t, `idx ${k} goal-side tick`).toBeLessThanOrEqual(ticks);
      expect(u(s, a, s.players[a * 11 + k]!.x), `idx ${k} still goal-side at the end`)
        .toBeLessThan(ub - LOCAL_TUNING.goalSideMargin);
    }
    // Strikers (low recover duty) are never sent on recovery runs: they stay outlets (TAI-01's shape still moves them).
    expect([...tr.strikersRecover], 'strikers on RECOVER').toEqual([]);
  }

  it.each([0, 1])('team %i loses the ball: caught-upfield players get goal-side of the ball within 3 s', (a) => {
    const d = 1 - a;
    const s = interception(a, TeamStyle.POSSESSION);
    const { tr, until } = traceRecovery(a);
    runTicks(s, 180, holdCarrier(d * 11 + 6, 0), { check: 'core', until });
    expectRecovered(s, a, tr, 180);
  });

  it('recovery keeps up with a carrier running at 3 m/s: every recoverer ends goal-side within 4 s', () => {
    const s = interception(0, TeamStyle.POSSESSION); // team 0 loses it; team 1 runs toward -x
    const { tr, until } = traceRecovery(0);
    runTicks(s, 240, holdCarrier(17, 3), { check: 'core', until });
    expectRecovered(s, 0, tr, 240);
  });

  it('a midfielder on a more urgent job (TAI-05 presser) keeps it; the other caught midfielders still recover', () => {
    // Regression for the press/recover overlap: the CM nearest the ball is team.pressSlot (PRESS 10 outranks RECOVER 9),
    // which must neither break the recovery runs of the others nor be overridden by them.
    // (tests/unit/tai-06-phase.test.ts pins the same precedence on a hand-built state, independent of TAI-05.)
    for (const a of [0, 1]) {
      const s = interception(a, TeamStyle.POSSESSION);
      const { tr, until } = traceRecovery(a);
      const pressers = new Set<number>();
      runTicks(s, 60, holdCarrier((1 - a) * 11 + 6, 0), {
        until: (st) => {
          until(st);
          const ps = st.teams[a]!.pressSlot;
          if (ps >= 0) {
            pressers.add(ps - a * 11);
            expect(st.players[ps]!.job, `pressSlot ${ps} job at tick ${st.tick}`).toBe(AiJob.PRESS);
          }
          return false;
        },
      });
      expect(tr.missed).toEqual([]);
      for (const k of RECOVERERS) {
        if (tr.urgent.has(k)) continue; // owned by the press (or another more urgent job) whenever caught upfield
        expect(tr.recover.has(k), `idx ${k} (never on a more urgent job) made a recovery run`).toBe(true);
      }
      // Whoever pressed among the four never ran a recovery run while pressing (checked per tick above), and the
      // others ran: at most the pressers are missing from the recovery runners.
      let pressingMid = 0;
      for (const k of RECOVERERS) if (pressers.has(k)) pressingMid++;
      expect(tr.recover.size).toBeGreaterThanOrEqual(RECOVERERS.length - pressingMid);
    }
  });

  it('Players glitch "orbit or jitter": recovering players settle (no RECOVER flip-flop, no oscillation)', () => {
    const s = interception(0, TeamStyle.POSSESSION);
    const flips = new Array<number>(11).fill(0);
    const prev = new Array<number>(11).fill(-1);
    runTicks(s, 170, holdCarrier(17, 0), {
      until: (st) => {
        for (let k = 1; k < 11; k++) {
          const isRec = st.players[k]!.job === AiJob.RECOVER ? 1 : 0;
          if (prev[k] !== -1 && prev[k] !== isRec) flips[k]!++;
          prev[k] = isRec;
        }
        return false;
      },
    });
    for (let k = 1; k < 11; k++) expect(flips[k]!, `idx ${k}`).toBeLessThanOrEqual(1);
    // At the end of the window the recoverers stand still on their points (no orbiting).
    for (const k of RECOVERERS) {
      const p = s.players[k]!;
      if (p.job === AiJob.RECOVER) expect(Math.hypot(p.vx, p.vz), `idx ${k}`).toBeLessThan(1.5);
    }
  });
});

describe('TAI-06 determinism and invariants', () => {
  it('same seed and script -> identical hash and phase trace', () => {
    const run = (): { hash: number; trace: string } => {
      const s = interception(1, TeamStyle.DIRECT, 9);
      const trace: number[] = [];
      runTicks(s, 200, holdCarrier(6, 2), {
        until: (st) => {
          trace.push(st.teams[0]!.phase, st.teams[1]!.phase, st.teams[0]!.possT, st.teams[1]!.lostT);
          return false;
        },
      });
      return { hash: hashState(s), trace: trace.join(',') };
    };
    const r1 = run(), r2 = run();
    expect(r2.hash).toBe(r1.hash);
    expect(r2.trace).toBe(r1.trace);
  });

  it('bot v bot from kick-off: phases valid, clocks finite and consistent between the teams, core invariants hold', () => {
    for (const seed of [1, 2, 3]) {
      const s = makeScenario({ seed, phase: MatchPhase.KICK_OFF });
      let before = s.match.phase; // the match phase the team AI saw (rules change it later in the tick)
      runTicks(s, 900, undefined, {
        check: 'core',
        until: (st) => {
          for (const t of st.teams) {
            expect(t.phase >= TeamPhase.BUILD_UP && t.phase <= TeamPhase.SET_PIECE).toBe(true);
            expect(Number.isFinite(t.possT) && Number.isFinite(t.lostT) && Number.isFinite(t.phaseT)).toBe(true);
            expect(t.phase === TeamPhase.SET_PIECE).toBe(before !== MatchPhase.IN_PLAY);
          }
          before = st.match.phase;
          const p0 = possessionStatus(st, 0), p1 = possessionStatus(st, 1);
          if (p0 !== -1 || p1 !== -1) expect(p0 + p1).toBe(1);
          return false;
        },
      });
    }
  });
});
