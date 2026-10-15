/**
 * MOD-04: Practice arena and set-piece practice. Setups valid for every kind; free play fields only the opponent
 * keeper and runs without a clock through the real pipeline with the invariants on; set-piece repetition re-awards
 * the same restart at the chosen spot; the tutorial driver advances on the actions it observes.
 * [QF-12 refit] The practice hooks run inside the sim since QF-1 (initMatch lays out free play, step re-awards the
 * practice restart), so these cases check the layout after initMatch and count RESTART_AWARDED events of the plain
 * step instead of the old app hook's return values.
 */
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { ControllerKind, Difficulty, KickKind, MatchPhase, ModeId, PracticeKind, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import type { MatchConfig, SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import {
  buildPracticeSetup, clampSpot, createTutorialDriver, practiceAttemptOver, practiceRestartKind, practiceRulesTick, practiceSpotOf,
  practiceSpotWorld, preparePracticeState, PRACTICE_SPOTS, tutorialDeviceFor, tutorialSteps, type PracticeData,
} from '../../src/modes/practice';
import { DEVICES, fakeCtx, pad } from '../unit/mod-01-fakes';

const KINDS = [PracticeKind.FREE_PLAY, PracticeKind.FREE_KICKS, PracticeKind.CORNERS, PracticeKind.PENALTIES, PracticeKind.TUTORIAL];

/** Step the real pipeline (practice rules inside `step`) with the core invariants; returns phase entries and the
 *  RESTART_AWARDED events of `kind` for the home side. */
function run(s: SimState, ticks: number, kind: RestartKind = RestartKind.NONE): { entries: { phase: number; team: number; x: number; z: number }[]; awards: number } {
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker('core');
  const entries: { phase: number; team: number; x: number; z: number }[] = [];
  let awards = 0;
  for (let i = 0; i < ticks; i++) {
    const before = s.match.phase;
    step(s, frames, ev);
    for (let k = 0; k < ev.count; k++) {
      const e = ev.get(k);
      if (e.type === EventType.RESTART_AWARDED && e.a === kind && e.b === 0) awards++; // the practice restart, practising side
    }
    const fails = checker.check(s, ev);
    if (fails.length > 0) throw new Error(`invariants at t=${s.tick}:\n${fails.join('\n')}`);
    if (s.match.phase !== before) entries.push({ phase: s.match.phase, team: s.match.restart.team, x: s.match.restart.x, z: s.match.restart.z });
  }
  return { entries, awards };
}

function botConfig(kind: PracticeKind, spot = 0): MatchConfig {
  const setup = buildPracticeSetup(fakeCtx(), kind, { spot, humans: [] });
  setup.config.seed = 4242;
  return setup.config;
}

describe('MOD-04 practice setups', () => {
  it('every kind: mode PRACTICE, the kind, IN_PLAY start, no replays, human at home vs the CPU', () => {
    const ctx = fakeCtx();
    for (const kind of KINDS) {
      const s = buildPracticeSetup(ctx, kind);
      expect(s.config.mode).toBe(ModeId.PRACTICE);
      expect(s.config.practice).toBe(kind);
      expect(s.config.startPhase).toBe(MatchPhase.IN_PLAY);
      expect(s.config.replaySeconds).toBe(0);
      expect(s.config.cupRules).toBe(0);
      expect(s.config.humans[0]).toMatchObject({ kind: ControllerKind.HUMAN, side: 0 });
      expect(s.bindings).toHaveLength(1);
      expect((s.modeData as PracticeData).kind).toBe(kind);
      const st = initMatch(s.config);
      expect(st.ctrl[3]!.kind).toBe(ControllerKind.CPU);
    }
    expect(buildPracticeSetup(ctx, PracticeKind.TUTORIAL).config.difficulty).toBe(Difficulty.BEGINNER);
    expect(buildPracticeSetup(ctx, 99 as PracticeKind).config.practice).toBe(PracticeKind.FREE_PLAY);
  });

  it('set-piece spots: chosen spot travels with the config; out-of-range spots clamp', () => {
    const ctx = fakeCtx();
    const s = buildPracticeSetup(ctx, PracticeKind.FREE_KICKS, { spot: 3 });
    expect(practiceSpotOf(s.config)).toBe(3);
    expect((s.modeData as PracticeData).spot).toBe(3);
    expect(practiceSpotOf(buildPracticeSetup(ctx, PracticeKind.CORNERS, { spot: 7 }).config)).toBe(0);
    expect(clampSpot(PracticeKind.CORNERS, 1)).toBe(1);
    expect(clampSpot(PracticeKind.FREE_PLAY, 1)).toBe(0);
    expect(practiceRestartKind(PracticeKind.PENALTIES)).toBe(RestartKind.PENALTY);
    expect(practiceRestartKind(PracticeKind.TUTORIAL)).toBe(RestartKind.NONE);
    const out = { x: 0, z: 0 };
    practiceSpotWorld(PracticeKind.FREE_KICKS, 1, -1, out);
    expect(out).toEqual({ x: -(52.5 - 21), z: 9 });
    for (const spot of PRACTICE_SPOTS[PracticeKind.FREE_KICKS]!) {
      // Outside the penalty area: deeper than 16.5 m or wider than 20.16 m.
      expect(spot.dist > 16.5 || Math.abs(spot.right) > 20.16).toBe(true);
    }
  });

  it('tutorial device: the device used last (touch when unknown)', () => {
    expect(tutorialDeviceFor(fakeCtx({ devices: [...DEVICES, pad(0)], lastActive: 'pad:0' }).devices)).toBe('pad');
    expect(tutorialDeviceFor(fakeCtx({ lastActive: 'keyboard' }).devices)).toBe('keyboard');
    expect(tutorialDeviceFor(fakeCtx().devices)).toBe('touch');
    expect(tutorialDeviceFor(null)).toBe('touch');
    const s = buildPracticeSetup(fakeCtx({ devices: [...DEVICES, pad(0)], lastActive: 'pad:0' }), PracticeKind.TUTORIAL);
    expect((s.modeData as PracticeData).device).toBe('pad');
  });
});

describe('MOD-04 free play', () => {
  it('your team against the opponent keeper only, no clock, invariants hold through the real pipeline', () => {
    const s = initMatch(botConfig(PracticeKind.FREE_PLAY));
    // initMatch already applied the layout (QF-1); the re-exported hook is idempotent.
    expect(preparePracticeState(s)).toBe(0);
    let active = 0;
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) active += s.players[PLAYERS_PER_TEAM + i]!.active;
    expect(active).toBe(1);
    expect(s.players[s.teams[1]!.keeperSlot]!.active).toBe(1);
    expect(s.teams[1]!.onPitch).toBe(1);
    expect(s.teams[0]!.onPitch).toBe(PLAYERS_PER_TEAM);
    run(s, 1800);
    expect(s.match.forfeitTeam).toBe(-1);
    expect(s.match.periodT).toBe(0);
    expect(s.match.clockRunning).toBe(0);
    expect(s.match.phase).not.toBe(MatchPhase.POST_MATCH);
  });

  it('other kinds keep both teams full', () => {
    for (const kind of [PracticeKind.FREE_KICKS, PracticeKind.CORNERS, PracticeKind.PENALTIES, PracticeKind.TUTORIAL]) {
      const s = initMatch(botConfig(kind));
      expect(preparePracticeState(s)).toBe(0);
      expect(s.teams[1]!.onPitch).toBe(PLAYERS_PER_TEAM);
    }
  });
});

describe('MOD-04 set-piece repetition (practice rules inside the sim step)', () => {
  const cases: [PracticeKind, MatchPhase, number][] = [
    [PracticeKind.CORNERS, MatchPhase.CORNER, 1],
    [PracticeKind.FREE_KICKS, MatchPhase.FREE_KICK, 0],
    [PracticeKind.PENALTIES, MatchPhase.PENALTY, 0],
  ];
  for (const [kind, phase, spot] of cases) {
    it(`${PracticeKind[kind]}: the same restart is awarded again after every attempt, at the chosen spot`, () => {
      const cfg = botConfig(kind, spot);
      const s = initMatch(cfg);
      preparePracticeState(s);
      const { entries, awards } = run(s, 3000, practiceRestartKind(kind));
      const restarts = entries.filter((e) => e.phase >= MatchPhase.THROW_IN && e.phase <= MatchPhase.PENALTY);
      const practice = restarts.filter((e) => e.phase === phase);
      expect(awards).toBeGreaterThanOrEqual(3);
      expect(practice.length).toBeGreaterThanOrEqual(3);
      // Every restart that was entered is the practice restart for the practising side at the spot.
      const want = { x: 0, z: 0 };
      practiceSpotWorld(kind, spot, s.teams[0]!.dir, want);
      for (const e of practice) {
        expect(e.team).toBe(0);
        if (kind !== PracticeKind.CORNERS) {
          expect(e.x).toBeCloseTo(want.x, 0);
          expect(e.z).toBeCloseTo(want.z, 0);
        } else {
          expect(Math.sign(e.z)).toBe(Math.sign(want.z));
          expect(Math.sign(e.x)).toBe(Math.sign(want.x));
        }
      }
      expect(restarts.every((e) => e.phase === phase && e.team === 0)).toBe(true);
      expect(s.match.watchdogCount).toBe(0);
    });
  }

  it('attempt rules: over when the defenders own the ball or after the time limit; free play is never touched', () => {
    const s = initMatch(botConfig(PracticeKind.CORNERS));
    s.match.phase = MatchPhase.IN_PLAY;
    s.match.prevPhase = MatchPhase.CORNER;
    s.match.phaseT = 10;
    s.ball.owner = 9;
    expect(practiceAttemptOver(s, 0, RestartKind.CORNER)).toBe(false);
    s.ball.owner = 15;
    expect(practiceAttemptOver(s, 0, RestartKind.CORNER)).toBe(true);
    s.ball.owner = -1;
    s.match.phaseT = 10_000;
    expect(practiceAttemptOver(s, 0, RestartKind.CORNER)).toBe(true);
    s.match.phaseT = 0;
    s.match.prevPhase = MatchPhase.KICK_OFF;
    expect(practiceAttemptOver(s, 0, RestartKind.CORNER)).toBe(true);
    const fp = initMatch(botConfig(PracticeKind.FREE_PLAY));
    expect(practiceRulesTick(fp, createEventBuffer())).toBe(0);
  });
});

describe('MOD-04 tutorial driver', () => {
  function feed(drv: ReturnType<typeof createTutorialDriver>, s: SimState, events: [EventType, number, number, number][] = []): boolean {
    const ev = createEventBuffer();
    s.tick++;
    ev.begin(s.tick);
    for (const [t, a, b, c] of events) ev.emit(t, a, b, c);
    return drv.onTick(s, ev);
  }

  it('steps per device; advances on observed actions; skip and reset', () => {
    expect(tutorialSteps('pad').map((x) => x.id)).toEqual(['move', 'sprint', 'pass', 'through', 'shoot', 'tackle', 'switch', 'skill', 'setpiece']);
    expect(tutorialSteps('touch')[2]!.text).toContain('PASS');
    expect(tutorialSteps('pad')[2]!.text).toContain('Cross');
    const s = initMatch(buildPracticeSetup(fakeCtx(), PracticeKind.TUTORIAL).config);
    const slot = 9;
    s.ctrl[0]!.slot = slot;
    s.players[slot]!.ctrl = 0;
    const drv = createTutorialDriver('touch', 0);
    expect(drv.current!.id).toBe('move');
    expect(feed(drv, s)).toBe(false); // baseline
    s.players[slot]!.x += 3;
    expect(feed(drv, s)).toBe(false);
    s.players[slot]!.x += 4;
    expect(feed(drv, s)).toBe(true);
    expect(drv.current!.id).toBe('sprint');
    s.players[slot]!.sprinting = 1;
    let done = false;
    for (let i = 0; i < 60 && !done; i++) done = feed(drv, s);
    expect(done).toBe(true);
    expect(feed(drv, s, [[EventType.KICK, 4, KickKind.GROUND_PASS, 0]])).toBe(false); // not his player
    expect(feed(drv, s, [[EventType.KICK, slot, KickKind.GROUND_PASS, 0]])).toBe(true);
    expect(feed(drv, s, [[EventType.KICK, slot, KickKind.GROUND_PASS, 0]])).toBe(false); // through ball wanted
    expect(feed(drv, s, [[EventType.KICK, slot, KickKind.THROUGH_LOBBED, 0]])).toBe(true);
    expect(feed(drv, s, [[EventType.SHOT, slot, 1, 0]])).toBe(true);
    expect(feed(drv, s, [[EventType.TACKLE, slot, 15, 1]])).toBe(true);
    expect(feed(drv, s, [[EventType.SWITCH, 9, 7, 1]])).toBe(false); // P2's switch
    expect(feed(drv, s, [[EventType.SWITCH, 9, 7, 0]])).toBe(true);
    drv.skip();
    expect(drv.current!.id).toBe('setpiece');
    s.match.restart.team = 0;
    expect(feed(drv, s, [[EventType.PHASE_CHANGE, MatchPhase.KICK_OFF, MatchPhase.IN_PLAY, 0]])).toBe(false);
    expect(feed(drv, s, [[EventType.PHASE_CHANGE, MatchPhase.CORNER, MatchPhase.IN_PLAY, 0]])).toBe(true);
    expect(drv.done).toBe(true);
    expect(drv.completed).toEqual([true, true, true, true, true, true, true, false, true]);
    expect(feed(drv, s, [[EventType.SHOT, slot, 1, 0]])).toBe(false);
    drv.reset();
    expect(drv.index).toBe(0);
    expect(drv.completed.every((c) => !c)).toBe(true);
  });
});
