/**
 * [MOD-03] Shoot-out mode. WAVE 0 STUB (FND-04): builds a setup that starts straight in SHOOT_OUT.
 * MOD-03: team pick, taker order, result screen, rematch.
 */
import type { AppContext, MatchSetup } from '../contracts/app';
import { MatchPhase, ModeId } from '../contracts/enums';
import { defaultSetup } from './setup';

export function buildShootoutSetup(ctx: AppContext): MatchSetup {
  const setup = defaultSetup(ctx);
  setup.config.mode = ModeId.SHOOT_OUT;
  setup.config.startPhase = MatchPhase.SHOOT_OUT;
  setup.config.cupRules = 1;
  return setup;
}
