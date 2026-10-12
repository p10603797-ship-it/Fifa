/**
 * [PAD-04] Device-level sequences (section 10 "Tactics, set pieces and menus"): D-pad tactics within
 * T_PAD.dpadSequenceMs —
 *   up then up / left / right / down  -> TACTIC_OFFSIDE_TRAP / TACTIC_TEAM_PRESS / TACTIC_EXTRA_STRIKER / TACTIC_GET_IN_BOX
 *   right then up / left / right      -> FOCUS_DEFAULT / FOCUS_DEFENDING / FOCUS_ATTACKING
 *   down then down                    -> QUICK_SUB
 *   corner: down then up / left / right / down -> CORNER_FAR_POST / EDGE_OF_BOX / CROWD_KEEPER / NEAR_POST
 * The result is a Command edge written into InputFrame.cmd. Button combos and double taps on the face buttons
 * are resolved in the sim from edges (SIM-15), not here.
 *
 * WAVE 0 STUB (FND-05): never produces a command. PAD-04 implements it (with a small HUD prompt via the app).
 */

import { Command } from '../../contracts/enums';

export interface PadSequences {
  /**
   * Feed D-pad press edges for this frame (bit 0 up, 1 down, 2 left, 3 right) and whether a corner is being taken.
   * Returns the Command completed this frame, or Command.NONE.
   */
  update(dpadEdges: number, nowMs: number, cornerContext: boolean): Command;
  /** First press of a sequence waiting for the second (for a HUD hint), -1 none. */
  readonly pending: number;
  reset(): void;
}

export function createPadSequences(): PadSequences {
  return {
    pending: -1,
    update() { return Command.NONE; },
    reset() { /* PAD-04 */ },
  };
}
