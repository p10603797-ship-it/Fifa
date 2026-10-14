/**
 * [QF-1] Practice rules inside the sim (charter: move preparePracticeState into sim/init and practiceRulesTick into
 * sim/step after rulesTick) and config.startPhase IN_PLAY (D-013: PRE_MATCH -> IN_PLAY), through the plain sim step.
 */
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { AssistLevel, AutoSwitch, CardKind, ControllerKind, MatchPhase, ModeId, PracticeKind, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { initMatch } from '../../src/sim/init';
import { practiceRulesTick as modesPracticeRulesTick, preparePracticeState as modesPrepare } from '../../src/modes/practice';
import { showCard } from '../../src/sim/rules/fouls';
import { practiceSpotPoint, preparePracticeState } from '../../src/sim/rules/practice';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { fuzzJobs } from '../../tools/fuzz';
import { runJob } from '../../tools/lib/jobs';

function practiceConfig(kind: PracticeKind, spot = 0, seed = 4242): MatchConfig {
  const c = createMatchConfig();
  c.seed = seed;
  c.mode = ModeId.PRACTICE;
  c.practice = kind;
  c.startPhase = MatchPhase.IN_PLAY;
  c.replaySeconds = 0;
  c.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 },
  ];
  (c as MatchConfig & { practiceSpot?: number }).practiceSpot = spot;
  return c;
}

interface Entry { phase: number; team: number; x: number; z: number }

/** Plain sim step only (no app hook); optionally the old modes/practice hook after it (as app stepWithModes does). */
function run(s: SimState, ticks: number, appHook = false): { entries: Entry[]; awards: number; hashes: string[] } {
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker('core');
  const entries: Entry[] = [];
  const hashes: string[] = [];
  let awards = 0;
  for (let i = 0; i < ticks; i++) {
    const before = s.match.phase;
    step(s, frames, ev);
    if (appHook) modesPracticeRulesTick(s, ev);
    for (let k = 0; k < ev.count; k++) if (ev.get(k).type === EventType.RESTART_AWARDED) awards++;
    const fails = checker.check(s, ev);
    if (fails.length > 0) throw new Error(`invariants at t=${s.tick}:\n${fails.join('\n')}`);
    if (s.match.phase !== before) entries.push({ phase: s.match.phase, team: s.match.restart.team, x: s.match.restart.x, z: s.match.restart.z });
    if (i % 60 === 0) hashes.push(String(hashState(s)));
  }
  return { entries, awards, hashes };
}

describe('QF-1 practice rules run inside the sim', { timeout: 600_000 }, () => {
  it('free play: initMatch already takes the opponent outfield players off; the hook is idempotent', () => {
    const s = initMatch(practiceConfig(PracticeKind.FREE_PLAY));
    let active = 0;
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) active += s.players[PLAYERS_PER_TEAM + i]!.active;
    expect(active).toBe(1);
    expect(s.players[s.teams[1]!.keeperSlot]!.active).toBe(1);
    expect(s.teams[1]!.onPitch).toBe(1);
    expect(s.teams[0]!.onPitch).toBe(PLAYERS_PER_TEAM);
    expect(preparePracticeState(s)).toBe(0);
    expect(modesPrepare(s)).toBe(0);
  });

  it('free play starts straight in play (PRE_MATCH -> IN_PLAY, no kick-off), no clock, no forfeit', () => {
    const s = initMatch(practiceConfig(PracticeKind.FREE_PLAY));
    const { entries } = run(s, 1200);
    expect(entries[0]!.phase).toBe(MatchPhase.IN_PLAY);
    // A kick-off only ever follows a goal (GOAL -> CELEBRATION -> REPLAY -> KICK_OFF), never the start.
    for (let i = 0; i < entries.length; i++) {
      if (entries[i]!.phase === MatchPhase.KICK_OFF) expect([MatchPhase.CELEBRATION, MatchPhase.REPLAY]).toContain(entries[i - 1]!.phase);
    }
    expect(s.match.periodT).toBe(0);
    expect(s.match.forfeitTeam).toBe(-1);
    expect(s.match.watchdogCount).toBe(0);
  });

  const cases: [PracticeKind, MatchPhase, number][] = [
    [PracticeKind.CORNERS, MatchPhase.CORNER, 1],
    [PracticeKind.FREE_KICKS, MatchPhase.FREE_KICK, 2],
    [PracticeKind.PENALTIES, MatchPhase.PENALTY, 0],
  ];
  for (const [kind, phase, spot] of cases) {
    it(`${PracticeKind[kind]}: the plain sim step awards the practice restart again and again, at the chosen spot`, () => {
      const s = initMatch(practiceConfig(kind, spot));
      const { entries, awards } = run(s, 3000);
      const restarts = entries.filter((e) => e.phase >= MatchPhase.THROW_IN && e.phase <= MatchPhase.PENALTY);
      expect(awards).toBeGreaterThanOrEqual(3);
      expect(restarts.length).toBeGreaterThanOrEqual(3);
      expect(restarts.every((e) => e.phase === phase && e.team === 0)).toBe(true);
      const want = { x: 0, z: 0 };
      practiceSpotPoint(kind, spot, s.teams[0]!.dir, want);
      for (const e of restarts) {
        if (kind === PracticeKind.CORNERS) {
          expect(Math.sign(e.x)).toBe(Math.sign(want.x));
          expect(Math.sign(e.z)).toBe(Math.sign(want.z));
        } else {
          expect(e.x).toBeCloseTo(want.x, 0);
          expect(e.z).toBeCloseTo(want.z, 0);
        }
      }
      expect(s.match.restart.kind === RestartKind.NONE || s.match.restart.team === 0).toBe(true);
      expect(s.match.watchdogCount).toBe(0);
    });
  }

  it('the app\'s leftover modes/practice hook after the sim step changes nothing (bit-identical)', () => {
    for (const kind of [PracticeKind.FREE_PLAY, PracticeKind.CORNERS, PracticeKind.PENALTIES]) {
      const a = initMatch(practiceConfig(kind, 0, 77));
      modesPrepare(a);
      const b = initMatch(practiceConfig(kind, 0, 77));
      expect(run(a, 1500, true).hashes).toEqual(run(b, 1500, false).hashes);
    }
  });
});

describe('QF-1 practice restarts stay at the practice spot', { timeout: 600_000 }, () => {
  it('a foul free kick for the practising side elsewhere is replaced by the practice free kick at the spot', () => {
    const s = initMatch(practiceConfig(PracticeKind.FREE_KICKS, 0, 4242));
    // Run to the first practice free kick, then award a free kick for the practising side 9 m short of the spot.
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < 400 && s.match.phase !== MatchPhase.FREE_KICK; i++) step(s, frames, ev);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    const want = { x: 0, z: 0 };
    practiceSpotPoint(PracticeKind.FREE_KICKS, 0, s.teams[0]!.dir, want);
    expect(Math.hypot(s.match.restart.x - want.x, s.match.restart.z - want.z)).toBeLessThan(1);
    s.match.phase = MatchPhase.IN_PLAY; // the attempt was taken; play is live
    s.match.prevPhase = MatchPhase.FREE_KICK;
    s.match.restart.kind = RestartKind.NONE;
    s.match.restart.taken = 1;
    ev.begin(s.tick);
    awardRestart(s, RestartKind.FREE_KICK, 0, want.x - s.teams[0]!.dir * 9, 4, ev);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    step(s, frames, ev);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.team).toBe(0);
    expect(Math.hypot(s.match.restart.x - want.x, s.match.restart.z - want.z)).toBeLessThan(1);
  });
});

describe('QF-1 free play: the lone keeper\'s restarts', { timeout: 600_000 }, () => {
  /** Free play in IN_PLAY with `kind` just awarded to the keeper-only side (team 1) at (x, z), then one step. */
  function awardToKeeperSide(kind: RestartKind, x: number, z: number): SimState {
    const s = initMatch(practiceConfig(PracticeKind.FREE_PLAY, 0, 515));
    const ev = createEventBuffer();
    const frames = [createInputFrame(), createInputFrame()];
    for (let i = 0; i < 900 && s.match.phase !== MatchPhase.IN_PLAY; i++) step(s, frames, ev);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    ev.begin(s.tick);
    awardRestart(s, kind, 1, x, z, ev);
    expect(s.match.restart.kind).toBe(kind);
    step(s, frames, ev);
    return s;
  }

  it('glitch taker missing — a throw-in, corner or penalty for the keeper-only side becomes his goal kick, taken without the watchdog', () => {
    for (const [kind, x, z] of [
      [RestartKind.THROW_IN, 10, -34], [RestartKind.THROW_IN, -30, 34], [RestartKind.CORNER, -52.5, -34],
      [RestartKind.PENALTY, -41, 0], [RestartKind.FREE_KICK, -20, 5],
    ] as [RestartKind, number, number][]) {
      const s = awardToKeeperSide(kind, x, z);
      expect(s.teams[1]!.dir).toBe(-1);
      const r = s.match.restart;
      expect(s.match.phase, RestartKind[kind]).toBe(MatchPhase.GOAL_KICK);
      expect(r.team).toBe(1);
      expect(r.x).toBeGreaterThan(40); // team 1 attacks -x in the first half: his goal area is at +x
      expect(Math.sign(r.z) || 1).toBe(Math.sign(z) || 1);
      const { entries } = run(s, 900);
      expect(entries.some((e) => e.phase === MatchPhase.IN_PLAY), RestartKind[kind]).toBe(true);
      expect(s.match.watchdogCount, RestartKind[kind]).toBe(0);
    }
  });

  it('his own free kick inside his area stays his free kick', () => {
    const s = awardToKeeperSide(RestartKind.FREE_KICK, 44, 6);
    expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
    expect(s.match.restart.team).toBe(1);
    run(s, 900);
    expect(s.match.watchdogCount).toBe(0);
  });

  it('a red card for the lone keeper is shown but he stays in goal (practice sends nobody off)', () => {
    const s = initMatch(practiceConfig(PracticeKind.FREE_PLAY, 0, 515));
    const k = s.teams[1]!.keeperSlot;
    const ev = createEventBuffer();
    ev.begin(s.tick);
    showCard(s, k, CardKind.RED, ev);
    showCard(s, 3, CardKind.YELLOW, ev);
    showCard(s, 3, CardKind.YELLOW, ev);
    const cards = ev.toArray().filter((e) => e.type === EventType.CARD).map((e) => [e.a, e.b]);
    expect(cards).toEqual([[k, CardKind.RED], [3, CardKind.YELLOW], [3, CardKind.SECOND_YELLOW]]);
    expect(s.players[k]!.active).toBe(1);
    expect(s.players[k]!.isKeeper).toBe(1);
    expect(s.teams[1]!.onPitch).toBe(1);
    expect(s.players[3]!.active).toBe(1);
    expect(s.teams[0]!.onPitch).toBe(PLAYERS_PER_TEAM);
    run(s, 600);
  });

  it('fuzz seed 404 #20 (free play, p1 v p2, hostile input: the keeper fouls) keeps every invariant, no watchdog', () => {
    const [job] = fuzzJobs({
      matches: 1, workers: 1, seed: 404, enforce: 'all', halfMinutes: 2, json: null, maxReplays: 0, only: 20, quiet: true,
      jobTimeoutSeconds: null,
    });
    const r = runJob(job!, { replayDir: '', replayPrefix: 'qf-1', replayBudget: () => false });
    expect(r.watchdogReasons).toEqual({});
    expect(r.reasons).toEqual([]);
  });

  it('fuzz seed 303 #91 (free play, p1 v p2, hostile input) finishes without a RESTART_BLOCKED watchdog', () => {
    const [job] = fuzzJobs({
      matches: 1, workers: 1, seed: 303, enforce: 'all', halfMinutes: 2, json: null, maxReplays: 0, only: 91, quiet: true,
      jobTimeoutSeconds: null,
    });
    const r = runJob(job!, { replayDir: '', replayPrefix: 'qf-1', replayBudget: () => false });
    expect(r.watchdogReasons).toEqual({});
    expect(r.reasons).toEqual([]);
  });
});
