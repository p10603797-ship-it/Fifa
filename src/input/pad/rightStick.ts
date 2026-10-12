/**
 * [PAD-05] Right-stick skill moves and directional switching (section 10 "Movement and dribbling", "Defending").
 * Produces Btn.RS_FLICK (edge: stick crossed T_INPUT.flickThreshold this tick, direction in ax/az) and Btn.RS_HOLD
 * (held past the threshold for T_PAD.rsHoldMs). Rolls (forward -> side, back -> side -> forward) are recognised in
 * the sim from the ax/az stream; this layer only cleans the signal and supplies the two bits.
 *
 * WAVE 0 BASELINE (FND-05): flick on crossing the threshold, hold after rsHoldMs. PAD-05 refines it.
 */

import { Btn } from '../../contracts/input';
import { T_INPUT } from '../../contracts/tuning';
import { T_PAD } from '../../contracts/tuning';

export interface RightStickTracker {
  /** Feed the dead-zoned right stick for this frame. */
  update(rx: number, ry: number, nowMs: number): void;
  /** Bits for the next sample (RS_FLICK latched until consumed, RS_HOLD while held). Clears the flick latch. */
  consume(): number;
  reset(): void;
}

export function createRightStick(): RightStickTracker {
  let out = false;
  let outSince = -1;
  let flickLatched = false;
  let holding = false;
  return {
    update(rx, ry, nowMs) {
      const m = Math.sqrt(rx * rx + ry * ry);
      if (m >= T_INPUT.flickThreshold) {
        if (!out) { out = true; outSince = nowMs; flickLatched = true; }
        holding = nowMs - outSince >= T_PAD.rsHoldMs;
      } else if (m < T_INPUT.flickThreshold * 0.6) {
        out = false;
        holding = false;
      }
    },
    consume() {
      let bits = 0;
      if (flickLatched) bits |= Btn.RS_FLICK;
      if (holding) bits |= Btn.RS_HOLD;
      flickLatched = false;
      return bits;
    },
    reset() { out = false; holding = false; flickLatched = false; outSince = -1; },
  };
}
