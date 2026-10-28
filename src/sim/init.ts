/**
 * Match initialisation. Lead-owned. Builds a SimState for a MatchConfig: seeds the RNG, copies squads and
 * attributes, places both teams in formation in their own halves, sets up human controllers and CPU brains.
 * Phase starts at PRE_MATCH; RUL-01 moves to config.startPhase.
 * [QF-1] Practice modes get their layout here (rules/practice preparePracticeState: free play takes the opponent's
 * outfield players off), so every caller of initMatch (app, replays, headless tools) starts the same game.
 */
import { HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM, teamFirstSlot } from '../contracts/constants';
import { ATTRIBUTE_KEYS, type Club, type PlayerData } from '../contracts/data';
import { AutoSwitch, AssistLevel, ControllerKind, MatchPhase, Period } from '../contracts/enums';
import { createSimState, RosterStatus, type MatchConfig, type PlayerAttrs, type SimState } from '../contracts/state';
import { T_MATCH_FLOW } from '../contracts/tuning';
import { CLUBS } from '../data/clubs';
import { getFormation } from '../data/formations';
import { primeStateCodegen, settleStateShapes, shapeSettlingOn } from './core/clone';
import { primeHashCodegen } from './core/hash';
import { rngInt, rngSeed } from './core/rng';
import { accelFor, topSpeedFor } from './players/locomotion';
import { preparePracticeState } from './rules/practice';

/** Production build (the shipped app): the loading screen warms the sim up (warmUpOnce, below). */
const PROD = typeof __DEV_BUILD__ !== 'undefined' && !__DEV_BUILD__;

/** Copy a squad member's attributes into a PlayerAttrs (+ derived top speed and acceleration). */
export function copyAttrs(dst: PlayerAttrs, src: Readonly<PlayerData>): void {
  const d = dst as unknown as Record<string, number>;
  const s = src as unknown as Record<string, number>;
  for (const k of ATTRIBUTE_KEYS) d[k] = s[k]!;
  dst.height = src.height;
  dst.foot = src.foot;
  dst.weakFoot = src.weakFoot;
  dst.skillMoves = src.skillMoves;
  dst.shirt = src.shirt;
  dst.topSpeed = topSpeedFor(dst);
  dst.accel = accelFor(dst);
}

/** Period length in ticks for a config: halfMinutes real minutes; extra-time periods are a third of that. */
export function periodLength(config: MatchConfig, period: Period): number {
  const half = Math.round(config.halfMinutes * 60 * 60);
  return period >= Period.ET_FIRST ? Math.round(half / 3) : half;
}

export function initMatch(config: MatchConfig, clubs: readonly Club[] = CLUBS): SimState {
  // [FIN-P] Once per process in the app: compile and optimise the sim on the loading screen, not in the first match
  // (warmUpOnce, below; no effect on any state but its own scratch match).
  if (PROD) warmUpOnce((c) => initMatch(c, clubs), config);
  const homeClub = clubs[config.homeClub] ?? clubs[0]!;
  const awayClub = clubs[config.awayClub] ?? clubs[1]!;
  const squads = [homeClub.squad, awayClub.squad];
  const s = createSimState(config, squads);
  rngSeed(s.rng, config.seed >>> 0);
  s.match.phase = MatchPhase.PRE_MATCH;
  s.match.period = Period.FIRST_HALF;
  s.match.periodLen = periodLength(config, Period.FIRST_HALF);

  for (let team = 0; team < 2; team++) {
    const club = team === 0 ? homeClub : awayClub;
    const t = s.teams[team]!;
    t.clubIdx = club.id;
    t.kit = team === 0 ? config.homeKit : config.awayKit;
    t.formation = team === 0 ? config.homeFormation : config.awayFormation;
    t.style = club.style;
    t.dir = team === 0 ? 1 : -1;
    for (let r = 0; r < t.roster.length; r++) t.roster[r] = r < PLAYERS_PER_TEAM ? RosterStatus.PLAYING : RosterStatus.BENCH;
    t.onPitch = PLAYERS_PER_TEAM;
    t.keeperSlot = teamFirstSlot(team);
    const form = getFormation(t.formation);
    for (let i = 0; i < PLAYERS_PER_TEAM; i++) {
      const slot = teamFirstSlot(team) + i;
      const p = s.players[slot]!;
      const fs = form.slots[i]!;
      p.team = team;
      p.slot = slot;
      p.rosterIdx = i;
      p.formIdx = i;
      p.role = fs.role;
      p.isKeeper = i === 0 ? 1 : 0;
      p.active = 1;
      copyAttrs(s.attrs[slot]!, club.squad[i]!);
      // Own half, formation shape (RUL-01 setupKickOff refines).
      let x = t.dir * fs.nx * HALF_LENGTH * T_MATCH_FLOW.initDepthScale;
      if (t.dir * x > -T_MATCH_FLOW.initOwnHalfMargin) x = -t.dir * T_MATCH_FLOW.initOwnHalfMargin;
      p.x = x;
      p.z = t.dir * fs.nz * HALF_WIDTH * T_MATCH_FLOW.initWidthScale;
      p.homeX = p.x;
      p.homeZ = p.z;
      p.fx = t.dir;
      p.fz = 0;
      t.homeX[i] = p.x;
      t.homeZ[i] = p.z;
    }
  }

  // Human controllers.
  for (let h = 0; h < 2; h++) {
    const cfg = config.humans[h];
    const c = s.ctrl[h]!;
    if (cfg && cfg.kind === ControllerKind.HUMAN && cfg.side >= 0) {
      c.kind = ControllerKind.HUMAN;
      c.side = cfg.side;
      c.assist = cfg.assist;
      c.autoSwitch = cfg.autoSwitch;
      c.fastPower = cfg.fastPower;
    }
  }
  // CPU brains for sides with no human.
  for (let team = 0; team < 2; team++) {
    let human = false;
    for (let h = 0; h < 2; h++) if (s.ctrl[h]!.kind === ControllerKind.HUMAN && s.ctrl[h]!.side === team) human = true;
    const c = s.ctrl[2 + team]!;
    const brain = s.teams[team]!.cpu;
    if (!human) {
      c.kind = ControllerKind.CPU;
      c.side = team;
      c.assist = AssistLevel.ASSISTED;
      c.autoSwitch = AutoSwitch.AUTO;
      brain.active = 1;
      brain.level = config.difficulty;
    }
  }

  s.match.firstKickoffTeam = rngInt(s.rng, 2);
  s.match.kickoffTeam = s.match.firstKickoffTeam;
  s.ball.x = 0; s.ball.y = 0.11; s.ball.z = 0;
  s.ball.px = 0; s.ball.py = 0.11; s.ball.pz = 0;
  preparePracticeState(s);
  // [FIN-P] Every numeric field gets its double representation now, not on its first fraction in play (no value
  // changes; see core/clone.ts settleStateShapes). Production builds (core/clone.ts shapeSettlingOn).
  if (shapeSettlingOn()) settleStateShapes(s);
  // [TUN-7S skeptic] Compile the state copier / hasher now (the loading screen), once per process, not in the first
  // ticks of play. No effect on the state.
  primeStateCodegen(s);
  primeHashCodegen(s);
  return s;
}

/*
 * ---------------------------------------------------------------- [FIN-P] sim + AI warm-up
 * Sim + AI warm-up on the loading screen (BRIEF section 13 "Warm-up": during loading ... run each animation and
 * effect once off screen, so the first slide tackle or replay in a match does not hitch; and the throttled proxy gate,
 * DoD 6). A JavaScript engine compiles a function the first time it runs, re-compiles it optimised once it is hot, and
 * the sim's state objects settle their hidden classes (a field's first double generalises its map, which deoptimises
 * every function that read it) during the first thousands of ticks of a session. Without a warm-up all of that lands
 * inside the ticks of the first match: in Chromium under 4x CPU throttling most ticks over the 4 ms budget in the first
 * 90 s carried compile or deopt work (tests/perf/fin-p-tick-trace.ts).
 *
 * warmUpSim() builds three scratch states (the first two thrown away: see the comment there), plays a scratch CPU v CPU
 * match on the third (cut-scenes skipped) and then each restart kind for both teams on it, then a short fresh match,
 * T_WARMUP ticks in all, each tick as the app loop runs it (copyState into an interpolation state first, a hashState
 * every few ticks), with its own states, input frames and event buffer: nothing outside the scratch states is written,
 * so the match that follows is bit-identical with or without it (tests/unit/fin-p-warmup.test.ts compares hash
 * timelines; tools/hash-table.ts IDENTICAL). initMatch runs it once per process in production builds (warmUpOnce: the
 * app's loading screen of the first match, +1.9 s in desktop Chromium and +9 s under 4x CPU throttling,
 * tests/perf/fin-p-load-time.ts); dev builds, tests and the Node tools skip it (hundreds of test files would each pay
 * it) unless they call warmUpSim() themselves.
 * [FIN-P skeptic] The implementation lives in sim/step.ts (it plays the step pipeline) and binds itself here when step.ts
 * loads (bindSimWarmUp; the app always loads step.ts before its first initMatch). init.ts itself imports nothing of the
 * tick pipeline: importing step / rules from here (as the warm-up first did) changed the evaluation order of the sim's
 * module graph for every importer of init.ts, and the tai-08 carrier scenarios' module doubles (vi.mock of
 * kicks/lob, shot, through) then met the real starters through the kicks <-> actions/registry cycle: 3 tests failed
 * (tests/unit/fin-p-warmup-imports.test.ts).
 */

/** The warm-up implementation (sim/step.ts binds it): run, ticks run so far, phases seen. */
export interface SimWarmUp {
  run(makeState: (c: MatchConfig) => SimState, base: MatchConfig | null): number;
  ticks(): number;
  phases(): number;
}

let impl: SimWarmUp | null = null;
/** warmUpOnce has run (or tried to) in this process. */
let attempted = false;

/** sim/step.ts installs the warm-up implementation when it loads. */
export function bindSimWarmUp(w: SimWarmUp): void {
  impl = w;
}

/** Ticks warmUpSim ran in this process (0 = never). */
export function simWarmedTicks(): number {
  return impl ? impl.ticks() : 0;
}

/** Bit mask (1 << MatchPhase) of the phases the warm-up went through in this process. */
export function simWarmedPhases(): number {
  return impl ? impl.phases() : 0;
}

/**
 * Play the warm-up (T_WARMUP.openPlayTicks of open play, then T_WARMUP.sceneTicks per restart scene, then a short fresh
 * match) on scratch states made by `makeState` (initMatch). Returns the ticks run (0 when sim/step.ts is not loaded).
 * Writes nothing but the scratch states.
 */
export function warmUpSim(makeState: (c: MatchConfig) => SimState, base: MatchConfig | null = null): number {
  return impl ? impl.run(makeState, base) : 0;
}

/**
 * The loading-screen entry (initMatch, production builds): warmUpSim once per process, before the first match's state
 * is built. Never throws: a failing warm-up only costs the warm-up (the match itself would fail the same way anyway).
 */
export function warmUpOnce(makeState: (c: MatchConfig) => SimState, base: MatchConfig): void {
  if (attempted || impl === null) return;
  attempted = true;
  try {
    warmUpSim(makeState, base);
  } catch {
    // optional work: the match loads without it
  }
}
