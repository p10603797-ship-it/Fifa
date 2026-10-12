/**
 * [PAD-02] Controller -> InputFrame (section 10, EA SPORTS FC 26 Classic layout, bound by POSITION on the Standard
 * Gamepad mapping; InputFrame buttons are positional-semantic, DECISIONS D-004):
 *
 *   index  PlayStation / Xbox   InputFrame
 *   0      Cross / A            Btn.PASS
 *   1      Circle / B           Btn.SHOOT
 *   2      Square / X           Btn.LOB
 *   3      Triangle / Y         Btn.THROUGH
 *   4      L1 / LB              Btn.MOD_L
 *   5      R1 / RB              Btn.MOD_R
 *   6      L2 / LT (> 0.3)      Btn.SHIELD   (analogue trigger, T_PAD.triggerThreshold)
 *   7      R2 / RT (> 0.3)      Btn.SPRINT
 *   9      Options / Menu       pause (edge -> onPause), not an InputFrame bit
 *   12-15  D-pad                tactics sequences (PAD-04, stub)
 *   left stick                  mx / mz (stick right = +x, stick up = -z via CameraProjector.stickRotation)
 *   right stick                 ax / az (+ RS_FLICK / RS_HOLD from PAD-05, stub)
 *   8 Create/View, 10/11 L3/R3: unbound. 16 Home and 17 Share belong to iPadOS: never bound.
 *
 * Presses shorter than one tick are latched in pollFrame and reported by the next sample(), so no tap is lost at
 * 120 Hz. releaseAll() suppresses buttons that are still physically held until they are released.
 * Modifier combos, double taps, holds and power are resolved in the sim from button edges (SIM-15).
 *
 * WAVE 0 BASELINE (FND-05). PAD-02 owns and refines it (PAD-03..06 add their rows through their own files).
 */

import { Btn, clearInputFrame, type InputFrame, type InputSampleContext, type InputSource } from '../../contracts/input';
import { T_PAD } from '../../contracts/tuning';
import { writeAimAxes, writeMoveAxes } from '../axes';
import { getPadManager, PadButton, padPressedEdge, type PadManager, type PadSlot } from './manager';

/** Standard button index -> Btn bit for the digital face/shoulder buttons. */
export const PAD_BUTTON_BITS: readonly number[] = [
  Btn.PASS, Btn.SHOOT, Btn.LOB, Btn.THROUGH, Btn.MOD_L, Btn.MOD_R,
];

/** Btn bits for a pad slot's current state (pure, no allocation). */
export function mapPadButtons(s: Readonly<PadSlot>): number {
  let bits = 0;
  for (let b = 0; b < PAD_BUTTON_BITS.length; b++) if ((s.pressed & (1 << b)) !== 0) bits |= PAD_BUTTON_BITS[b]!;
  if (s.value[PadButton.L2]! > T_PAD.triggerThreshold) bits |= Btn.SHIELD;
  if (s.value[PadButton.R2]! > T_PAD.triggerThreshold) bits |= Btn.SPRINT;
  return bits;
}

export interface PadSourceOptions {
  /** Device key ('pad:<n>') of the PadSlot to read. */
  key: string;
  /** Called on an Options / Menu press. */
  onPause(): void;
  /** Defaults to the shared page manager. */
  manager?: PadManager;
  /** Clock for the fallback poll when pollFrame is not called (defaults to performance.now). */
  now?: () => number;
}

export interface PadInputSource extends InputSource {
  readonly key: string;
}

export function createPadSource(opts: PadSourceOptions): PadInputSource {
  const manager = opts.manager ?? getPadManager();
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let latched = 0;
  let suppress = 0;
  let disposed = false;

  function readFrame(nowMs: number): PadSlot | null {
    manager.poll(nowMs);
    const s = manager.find(opts.key);
    if (!s || !s.connected) {
      latched = 0;
      suppress = 0;
      return null;
    }
    const bits = mapPadButtons(s);
    suppress &= bits; // a suppressed button is re-armed once physically released
    latched |= bits & ~suppress;
    if (padPressedEdge(s, PadButton.START)) opts.onPause();
    return s;
  }

  return {
    id: opts.key,
    key: opts.key,
    kind: 'pad',
    pollFrame(nowMs: number) {
      if (!disposed) readFrame(nowMs);
    },
    sample(out: InputFrame, ctx: InputSampleContext) {
      clearInputFrame(out);
      if (disposed) return;
      // Fallback when nobody calls pollFrame this frame (keeps pads alive; never double-polls within 12 ms).
      const t = now();
      if (manager.lastPollMs < 0 || t - manager.lastPollMs > 12) readFrame(t);
      const s = manager.find(opts.key);
      if (!s || !s.connected) return;
      writeMoveAxes(out, s.lx, s.ly, ctx.projector);
      writeAimAxes(out, s.rx, s.ry, ctx.projector);
      const bits = mapPadButtons(s);
      suppress &= bits;
      out.buttons = ((bits & ~suppress) | latched) & ~suppress;
      latched = 0;
    },
    releaseAll() {
      latched = 0;
      const s = manager.find(opts.key);
      suppress = s && s.connected ? mapPadButtons(s) : 0;
    },
    dispose() {
      disposed = true;
      latched = 0;
    },
  };
}
