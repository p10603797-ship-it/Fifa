/**
 * [MOD-01] Match setup builders (BRIEF §11 Modes: Kick-Off "pick teams, kits, difficulty, half length, friendly or cup
 * rules, day or night, and rule toggles"; Play a Friend on the same iPad; §1 "be in a match within a minute").
 *
 * defaultSetup(ctx): the quick local match behind Play now on the main menu. Human 0 plays home with every local
 * device bound (touch, keyboard, any pad, including pads that connect during the match via ANY_DEVICE); the away
 * side is CPU. Rules, clubs, kits, half length and difficulty come from settings.match. The finished match is added
 * to the lifetime records (modes/records.ts withRecords).
 *
 * buildSetup(ctx, choices): the general builder used by every mode. Missing choices fall back to settings.match.
 *  - seed: a fresh app-side seed (app/session newMatchSeed) unless choices.seed is given; the sim only ever uses it.
 *  - clubs: valid indices into ctx.clubs (out of range -> the saved default, then 0 / 1); formations default to each
 *    club's preferred formation (settings.match.homeFormation is the human's saved choice for the home side).
 *  - kits: requested slots run through the GFX-08 clash check (render/kits resolveKits); the slot it settles on is
 *    stored, so the config always names kits that read apart.
 *  - humans / bindings from side select: a human with a side (0 / 1) and at least one device is HUMAN with a
 *    binding; any other human is NONE with side -1 and no binding. Sides without a human are played by the CPU
 *    (sim/init). Duplicate human indices keep the first entry. Bindings are sorted by human index.
 *  - halves clamp to 2..10 whole minutes; difficulty clamps to the Difficulty range.
 *  - mode rules (applyModeRules): SHOOT_OUT starts in SHOOT_OUT with cup rules; PRACTICE starts IN_PLAY with the
 *    practice kind (MOD-04 adds the practice layout); CUP forces cup rules; others start with a KICK_OFF.
 */
import type { AppContext, HumanBinding, MatchSetup } from '../contracts/app';
import type { Club } from '../contracts/data';
import { ControllerKind, Difficulty, FormationId, KitSlot, MatchPhase, ModeId, PracticeKind } from '../contracts/enums';
import type { Settings } from '../contracts/settings';
import { createMatchConfig, type ControllerConfig, type MatchConfig } from '../contracts/state';
import { ANY_DEVICE } from '../app/localInput';
import { newMatchSeed } from '../app/session';
import { resolveKits } from '../render/kits';
import { withRecords } from './records';

/** Half length bounds, real minutes (BRIEF §5). */
export const HALF_MINUTES_MIN = 2;
export const HALF_MINUTES_MAX = 10;
export const HALF_MINUTES_DEFAULT = 4;

/** Controller config for a human on `side` using the player's control settings. */
export function humanController(settings: Readonly<Settings>, side: number): ControllerConfig {
  return {
    kind: ControllerKind.HUMAN,
    side,
    assist: settings.controls.assist,
    autoSwitch: settings.controls.autoSwitch,
    fastPower: settings.controls.touch.fastPowerBar ? 1 : 0,
  };
}

/** A human slot that sits out. */
export function noHuman(settings: Readonly<Settings>): ControllerConfig {
  return { kind: ControllerKind.NONE, side: -1, assist: settings.controls.assist, autoSwitch: settings.controls.autoSwitch, fastPower: 0 };
}

/** Half length clamped to 2..10 whole minutes (non-finite -> the default 4). */
export function clampHalfMinutes(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : HALF_MINUTES_DEFAULT;
  return n < HALF_MINUTES_MIN ? HALF_MINUTES_MIN : n > HALF_MINUTES_MAX ? HALF_MINUTES_MAX : n;
}

/** Difficulty clamped to the enum range. */
export function clampDifficulty(v: unknown): Difficulty {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : Difficulty.PROFESSIONAL;
  return (n < Difficulty.BEGINNER ? Difficulty.BEGINNER : n > Difficulty.LEGEND ? Difficulty.LEGEND : n) as Difficulty;
}

function clampKit(v: unknown, def: KitSlot): KitSlot {
  return v === KitSlot.HOME || v === KitSlot.AWAY ? v : def;
}

function clampFormation(v: unknown): FormationId | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= FormationId.F442 && v <= FormationId.F41212 ? (v as FormationId) : null;
}

/** A valid club index for `clubs` (else `fallback`, else 0). */
export function clampClub(clubs: readonly Club[], v: unknown, fallback: number): number {
  const n = clubs.length;
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && (n === 0 || x < n);
  if (ok(v)) return v;
  if (ok(fallback)) return fallback;
  return 0;
}

/**
 * Kit slots after the GFX-08 clash check: the requested slots, or the ones the check switched to. If the check
 * settles on a built-in fallback kit the requested slot is kept (the renderer applies the same check).
 */
export function resolveKitSlots(clubs: readonly Club[], homeClub: number, awayClub: number, homeKit: KitSlot, awayKit: KitSlot, highContrast = false): [KitSlot, KitSlot] {
  try {
    const k = resolveKits(clubs[homeClub] ?? null, clubs[awayClub] ?? null, homeKit, awayKit, highContrast);
    const h = k.fallback[0] ? homeKit : clampKit(k.slot[0], homeKit);
    const a = k.fallback[1] ? awayKit : clampKit(k.slot[1], awayKit);
    return [h, a];
  } catch {
    return [homeKit, awayKit];
  }
}

/** Mode-specific config fields (pure): start phase, cup rules, practice kind. */
export function applyModeRules(config: MatchConfig, mode: ModeId, practice: PracticeKind = PracticeKind.NONE): void {
  config.mode = mode;
  config.practice = PracticeKind.NONE;
  config.startPhase = MatchPhase.KICK_OFF;
  if (mode === ModeId.SHOOT_OUT) {
    config.startPhase = MatchPhase.SHOOT_OUT;
    config.cupRules = 1;
  } else if (mode === ModeId.CUP) {
    config.cupRules = 1;
  } else if (mode === ModeId.PRACTICE) {
    config.practice = practice === PracticeKind.NONE ? PracticeKind.FREE_PLAY : practice;
    config.startPhase = MatchPhase.IN_PLAY;
    config.cupRules = 0;
  }
}

/** Match config from the saved match defaults (no humans set; callers fill config.humans). */
export function configFromSettings(settings: Readonly<Settings>, mode: ModeId = ModeId.KICK_OFF, seed = newMatchSeed()): MatchConfig {
  const m = settings.match;
  const c = createMatchConfig();
  c.seed = seed >>> 0;
  c.mode = mode;
  c.homeClub = m.homeClub;
  c.awayClub = m.awayClub;
  c.homeKit = m.homeKit;
  c.awayKit = m.awayKit;
  c.homeFormation = m.homeFormation;
  c.halfMinutes = clampHalfMinutes(m.halfMinutes);
  c.night = m.night ? 1 : 0;
  c.offside = m.offside ? 1 : 0;
  c.fouls = m.fouls ? 1 : 0;
  c.difficulty = m.difficulty;
  c.replaySeconds = m.replays ? c.replaySeconds : 0;
  c.humans = [noHuman(settings), noHuman(settings)];
  return c;
}

/** Every local device id, plus ANY_DEVICE so devices that connect later are bound too. */
export function allLocalDevices(ctx: Pick<AppContext, 'devices'>): string[] {
  const ids: string[] = [];
  try {
    for (const d of ctx.devices.list()) if (d.connected) ids.push(d.id);
  } catch {
    /* registry not ready: rely on the wildcard */
  }
  ids.push(ANY_DEVICE);
  return ids;
}

/** Side-select result for one human. side -1 sits out. */
export interface HumanChoice {
  human: number;
  side: number;
  deviceIds: string[];
}

/** Everything a mode may choose; missing fields use settings.match. */
export interface MatchChoices {
  mode?: ModeId;
  seed?: number;
  homeClub?: number;
  awayClub?: number;
  homeKit?: KitSlot;
  awayKit?: KitSlot;
  homeFormation?: FormationId;
  awayFormation?: FormationId;
  difficulty?: Difficulty;
  halfMinutes?: number;
  cupRules?: boolean;
  night?: boolean;
  offside?: boolean;
  fouls?: boolean;
  replays?: boolean;
  practice?: PracticeKind;
  /** Side select: per human, side and devices. Omitted = human 0 at home on every local device. */
  humans?: HumanChoice[];
  /** Skip the kit clash check (keep the requested slots). */
  rawKits?: boolean;
}

/** Humans and bindings consistent with each other (see header). Pure. */
export function humansFromChoices(settings: Readonly<Settings>, humans: readonly HumanChoice[]): { humans: ControllerConfig[]; bindings: HumanBinding[] } {
  const cfg: ControllerConfig[] = [noHuman(settings), noHuman(settings)];
  const bindings: HumanBinding[] = [];
  const seen = [false, false];
  for (const h of humans) {
    if (!h || (h.human !== 0 && h.human !== 1) || seen[h.human]) continue;
    seen[h.human] = true;
    const ids = Array.isArray(h.deviceIds) ? h.deviceIds.filter((d) => typeof d === 'string' && d.length > 0) : [];
    if ((h.side !== 0 && h.side !== 1) || ids.length === 0) continue;
    cfg[h.human] = humanController(settings, h.side);
    bindings.push({ human: h.human, deviceIds: Array.from(new Set(ids)) });
  }
  bindings.sort((a, b) => a.human - b.human);
  return { humans: cfg, bindings };
}

/** Build a MatchSetup from choices over the saved defaults (see header). */
export function buildSetup(ctx: Pick<AppContext, 'settings' | 'devices' | 'clubs'>, choices: MatchChoices = {}): MatchSetup {
  const settings = ctx.settings.get();
  const m = settings.match;
  const clubs = ctx.clubs;
  const mode = choices.mode ?? ModeId.KICK_OFF;
  const c = configFromSettings(settings, mode, choices.seed ?? newMatchSeed());
  c.homeClub = clampClub(clubs, choices.homeClub ?? m.homeClub, 0);
  c.awayClub = clampClub(clubs, choices.awayClub ?? m.awayClub, clubs.length > 1 ? 1 : 0);
  const homeClub = clubs[c.homeClub];
  const awayClub = clubs[c.awayClub];
  const savedHomeFormation = choices.homeClub === undefined || choices.homeClub === m.homeClub ? clampFormation(m.homeFormation) : null;
  c.homeFormation = clampFormation(choices.homeFormation) ?? savedHomeFormation ?? homeClub?.formation ?? FormationId.F442;
  c.awayFormation = clampFormation(choices.awayFormation) ?? awayClub?.formation ?? FormationId.F442;
  const hk = clampKit(choices.homeKit ?? m.homeKit, KitSlot.HOME);
  const ak = clampKit(choices.awayKit ?? m.awayKit, KitSlot.AWAY);
  if (choices.rawKits) {
    c.homeKit = hk;
    c.awayKit = ak;
  } else {
    [c.homeKit, c.awayKit] = resolveKitSlots(clubs, c.homeClub, c.awayClub, hk, ak, settings.accessibility?.highContrastKits === true);
  }
  c.difficulty = clampDifficulty(choices.difficulty ?? m.difficulty);
  c.halfMinutes = clampHalfMinutes(choices.halfMinutes ?? m.halfMinutes);
  if (choices.night !== undefined) c.night = choices.night ? 1 : 0;
  if (choices.offside !== undefined) c.offside = choices.offside ? 1 : 0;
  if (choices.fouls !== undefined) c.fouls = choices.fouls ? 1 : 0;
  if (choices.replays !== undefined) c.replaySeconds = choices.replays ? createMatchConfig().replaySeconds : 0;
  c.cupRules = choices.cupRules ? 1 : 0;
  applyModeRules(c, mode, choices.practice ?? PracticeKind.NONE);
  const humanChoices = choices.humans ?? [{ human: 0, side: 0, deviceIds: allLocalDevices(ctx) }];
  const hb = humansFromChoices(settings, humanChoices);
  c.humans = hb.humans;
  return { config: c, bindings: hb.bindings };
}

/** The default local match: human 0 at home on every local device vs the CPU (recorded in the lifetime records). */
export function defaultSetup(ctx: AppContext): MatchSetup {
  const settings = ctx.settings.get();
  const config = configFromSettings(settings, ModeId.KICK_OFF);
  config.humans[0] = humanController(settings, 0);
  const bindings: HumanBinding[] = [{ human: 0, deviceIds: allLocalDevices(ctx) }];
  return withRecords(ctx.settings, { config, bindings });
}

/** Same setup with a fresh seed only (rematch). Callbacks and the mode payload are kept. */
export function reseedSetup(setup: MatchSetup, seed = newMatchSeed()): MatchSetup {
  return {
    ...setup,
    config: { ...setup.config, seed: seed >>> 0, humans: setup.config.humans.map((h) => ({ ...h })) },
    bindings: setup.bindings.map((b) => ({ human: b.human, deviceIds: b.deviceIds.slice() })),
  };
}
