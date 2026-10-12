/**
 * [FND-06] Match config variation for soak and fuzz: seeds, clubs, formations, kits, difficulties, rule toggles,
 * cup rules, replays, day/night. Deterministic from (base seed, match index), so any failure reproduces from the
 * printed seed + index or from the saved config.
 */
import {
  AssistLevel, AutoSwitch, ControllerKind, Difficulty, FormationId, KitSlot, MatchPhase, ModeId, PracticeKind,
} from '../../src/contracts/enums';
import { createMatchConfig, type ControllerConfig, type MatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createRng, mix32, pick, rngChance, rngInt, rngIntIn } from './rand';

export const FORMATION_COUNT = FormationId.F41212 + 1;
export const DIFFICULTY_COUNT = Difficulty.LEGEND + 1;

export function noHuman(): ControllerConfig {
  return { kind: ControllerKind.NONE, side: -1, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.AIR_AND_LOOSE, fastPower: 0 };
}

export interface SoakConfigOptions {
  halfMinutes: number;
  /** Fraction of cup-rules matches (extra time + shoot-out when level). */
  cupShare?: number;
  /** Fix every match to this difficulty instead of varying it. */
  difficulty?: Difficulty;
}

/** Bot-v-bot config for soak match `index`. */
export function soakConfig(index: number, baseSeed: number, o: SoakConfigOptions): MatchConfig {
  const r = createRng(mix32(baseSeed, index));
  const c = createMatchConfig();
  c.seed = mix32(baseSeed ^ 0x5eed, index);
  const nClubs = CLUBS.length;
  c.homeClub = rngInt(r, nClubs);
  c.awayClub = (c.homeClub + 1 + rngInt(r, Math.max(1, nClubs - 1))) % nClubs;
  c.homeFormation = rngInt(r, FORMATION_COUNT) as FormationId;
  c.awayFormation = rngInt(r, FORMATION_COUNT) as FormationId;
  c.homeKit = KitSlot.HOME;
  c.awayKit = KitSlot.AWAY;
  c.halfMinutes = o.halfMinutes;
  c.difficulty = o.difficulty ?? (rngInt(r, DIFFICULTY_COUNT) as Difficulty);
  c.offside = rngChance(r, 0.85) ? 1 : 0;
  c.fouls = rngChance(r, 0.85) ? 1 : 0;
  c.cupRules = rngChance(r, o.cupShare ?? 0.2) ? 1 : 0;
  c.mode = c.cupRules ? ModeId.CUP : ModeId.KICK_OFF;
  c.night = rngInt(r, 2);
  c.replaySeconds = rngChance(r, 0.5) ? 8 : 0;
  c.humans = [noHuman(), noHuman()];
  c.startPhase = MatchPhase.KICK_OFF;
  return c;
}

/** Human controller with random assist / auto-switch / power-bar settings. */
function randomHuman(r: ReturnType<typeof createRng>, side: number): ControllerConfig {
  return {
    kind: ControllerKind.HUMAN, side,
    assist: rngInt(r, 3) as AssistLevel,
    autoSwitch: rngInt(r, 3) as AutoSwitch,
    fastPower: rngInt(r, 2),
  };
}

export type HumanSetup = 'p1-home' | 'p1-away' | 'p1-vs-p2' | 'coop';

export interface FuzzConfig {
  config: MatchConfig;
  humans: HumanSetup;
  /** False for modes without an end (practice). */
  expectFinish: boolean;
}

/** Config for fuzz match `index`: one or two humans, varied modes (kick-off, cup, shoot-out, practice). */
export function fuzzConfig(index: number, baseSeed: number, halfMinutes: number): FuzzConfig {
  const base = soakConfig(index, baseSeed ^ 0xf022, { halfMinutes, cupShare: 0.25 });
  const r = createRng(mix32(baseSeed ^ 0xabcd, index));
  const roll = rngInt(r, 100);
  const humans: HumanSetup = roll < 35 ? 'p1-home' : roll < 50 ? 'p1-away' : roll < 85 ? 'p1-vs-p2' : 'coop';
  switch (humans) {
    case 'p1-home': base.humans = [randomHuman(r, 0), noHuman()]; break;
    case 'p1-away': base.humans = [randomHuman(r, 1), noHuman()]; break;
    case 'p1-vs-p2': base.humans = [randomHuman(r, 0), randomHuman(r, 1)]; base.mode = ModeId.FRIEND_LOCAL; break;
    case 'coop': {
      const side = rngInt(r, 2);
      base.humans = [randomHuman(r, side), randomHuman(r, side)];
      break;
    }
  }
  let expectFinish = true;
  const mode = rngInt(r, 100);
  if (mode < 10) {
    base.mode = ModeId.SHOOT_OUT;
    base.startPhase = MatchPhase.SHOOT_OUT;
    base.cupRules = 0;
  } else if (mode < 15) {
    base.mode = ModeId.PRACTICE;
    base.practice = pick(r, [PracticeKind.FREE_PLAY, PracticeKind.FREE_KICKS, PracticeKind.CORNERS, PracticeKind.PENALTIES]);
    base.cupRules = 0;
    expectFinish = false;
  }
  base.halfMinutes = rngIntIn(r, Math.min(halfMinutes, 2), halfMinutes);
  return { config: base, humans, expectFinish };
}
