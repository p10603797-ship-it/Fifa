/**
 * [MOD-04] Practice arena and set-piece practice. WAVE 0 STUB (FND-04).
 * MOD-04: free play against a keeper with no clock, free kicks, corners, penalties and the guided tutorial
 * (PracticeKind), each a MatchSetup with config.mode = PRACTICE.
 */
import type { AppContext, MatchSetup } from '../contracts/app';
import { ModeId, PracticeKind } from '../contracts/enums';
import { defaultSetup } from './setup';

export function buildPracticeSetup(ctx: AppContext, kind: PracticeKind = PracticeKind.FREE_PLAY): MatchSetup {
  const setup = defaultSetup(ctx);
  setup.config.mode = ModeId.PRACTICE;
  setup.config.practice = kind;
  return setup;
}
