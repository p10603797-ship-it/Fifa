/**
 * [MOD-01] Match setup helpers (Wave 0 version by FND-04).
 *
 * defaultSetup(ctx): the quick local match behind Kick-Off on the main menu. Human 0 plays home with every local
 * device bound (touch, keyboard, any pad, including pads that connect during the match via ANY_DEVICE); the away
 * side is CPU. Rules, clubs, kits, half length and difficulty come from settings.match. The seed comes from the
 * app (never Math.random inside sim).
 */
import type { AppContext, HumanBinding, MatchSetup } from '../contracts/app';
import { ControllerKind, ModeId } from '../contracts/enums';
import type { Settings } from '../contracts/settings';
import { createMatchConfig, type ControllerConfig, type MatchConfig } from '../contracts/state';
import { ANY_DEVICE } from '../app/localInput';
import { newMatchSeed } from '../app/session';

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
  c.halfMinutes = Math.max(2, Math.min(10, Math.round(m.halfMinutes)));
  c.night = m.night ? 1 : 0;
  c.offside = m.offside ? 1 : 0;
  c.fouls = m.fouls ? 1 : 0;
  c.difficulty = m.difficulty;
  c.replaySeconds = m.replays ? c.replaySeconds : 0;
  c.humans = [
    { kind: ControllerKind.NONE, side: -1, assist: settings.controls.assist, autoSwitch: settings.controls.autoSwitch, fastPower: 0 },
    { kind: ControllerKind.NONE, side: -1, assist: settings.controls.assist, autoSwitch: settings.controls.autoSwitch, fastPower: 0 },
  ];
  return c;
}

/** Every local device id, plus ANY_DEVICE so devices that connect later are bound too. */
export function allLocalDevices(ctx: AppContext): string[] {
  const ids: string[] = [];
  try {
    for (const d of ctx.devices.list()) if (d.connected) ids.push(d.id);
  } catch {
    /* registry not ready: rely on the wildcard */
  }
  ids.push(ANY_DEVICE);
  return ids;
}

/** The default local match: human 0 at home on every local device vs the CPU. */
export function defaultSetup(ctx: AppContext): MatchSetup {
  const settings = ctx.settings.get();
  const config = configFromSettings(settings, ModeId.KICK_OFF);
  config.humans[0] = humanController(settings, 0);
  const bindings: HumanBinding[] = [{ human: 0, deviceIds: allLocalDevices(ctx) }];
  return { config, bindings };
}
