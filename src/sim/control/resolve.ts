/**
 * [SIM-15] Action input resolution: turns each controller's InputFrame (humans from the frames argument, CPU
 * brains from s.teams[t].cpu.out) into intents and actions for its controlled player, inside the sim so it
 * replays exactly. Tracks button edges / hold ticks / double-taps (s.ctrl[i].holdT, pressTick, releaseTick),
 * resolves modifier combos when the FACE button is pressed (never when the modifier is), buffers presses up to
 * T_INPUT.bufferTicks before the player can act, fills the power bar (p.actPower while p.actCharging; fast
 * power bar setting), maps context (attacking / defending / keeper in hands / aerial ball) to actions per the
 * section 9 and 10 tables, applies gestures (tap/double-tap/swipe targets), commands (tactics, subs, skip) and
 * routes restart phases to the set-piece input functions (SETPIECE_INPUT in sim/rules/restart.ts).
 * Calls SIM-16 switching for player changes. Never reads which device produced a frame.
 * WAVE 0 BASELINE: movement only (stick -> DIRECT intent of the controlled player, sprint). SIM-15 replaces it.
 */
import { AXIS_SCALE, Btn, type InputFrame } from '../../contracts/input';
import { ControllerKind } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { MoveMode, type SimState } from '../../contracts/state';
import { MAX_HUMANS, CPU_CONTROLLER_BASE } from '../../contracts/constants';
import { ensureControlledPlayer } from './switching';

export function resolveControllers(s: SimState, humanFrames: readonly InputFrame[], ev: EventSink): void {
  for (let c = 0; c < s.ctrl.length; c++) {
    const ctl = s.ctrl[c]!;
    if (ctl.kind === ControllerKind.NONE || ctl.side < 0) continue;
    const f = c < MAX_HUMANS ? humanFrames[c] : s.teams[c - CPU_CONTROLLER_BASE]!.cpu.out;
    if (!f) continue;
    ctl.prevButtons = ctl.buttons;
    ctl.buttons = f.buttons;
    ctl.mx = f.mx / AXIS_SCALE;
    ctl.mz = f.mz / AXIS_SCALE;
    ensureControlledPlayer(s, c, ev);
    if (ctl.slot < 0) continue;
    const p = s.players[ctl.slot]!;
    p.moveMode = MoveMode.DIRECT;
    p.ix = ctl.mx;
    p.iz = ctl.mz;
    p.wantSprint = (f.buttons & Btn.SPRINT) !== 0 ? 1 : 0;
    p.lookAt = 0;
  }
}
