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
import { CLUBS } from '../data/clubs';
import { getFormation } from '../data/formations';
import { rngInt, rngSeed } from './core/rng';
import { accelFor, topSpeedFor } from './players/locomotion';
import { preparePracticeState } from './rules/practice';

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
      let x = t.dir * fs.nx * HALF_LENGTH * 0.95;
      if (t.dir * x > -1) x = -t.dir * 1;
      p.x = x;
      p.z = t.dir * fs.nz * HALF_WIDTH * 0.9;
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
  return s;
}
