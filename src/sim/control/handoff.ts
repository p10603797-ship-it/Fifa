/**
 * Command.HAND_TO_CPU: a local human hands their side to its CPU brain for the rest of the match (controller
 * disconnect card, PAD-03). Applied through the frame so replays and the determinism hash see it. [lead, D-019]
 */
import { CPU_CONTROLLER_BASE, MAX_HUMANS } from '../../contracts/constants';
import { AssistLevel, AutoSwitch, ControllerKind } from '../../contracts/enums';
import type { SimState } from '../../contracts/state';
import { restartHandedToCpu } from '../rules/restart';
import { shootoutHandedToCpu } from '../rules/shootout';
import { clearCharge } from './resolveShared';

/** Remove human controller `c` from play; the side's CPU brain takes over unless another human still plays it. */
export function handToCpu(s: SimState, c: number): void {
  if (c < 0 || c >= MAX_HUMANS) return;
  const ctl = s.ctrl[c];
  if (!ctl || ctl.kind !== ControllerKind.HUMAN) return;
  const side = ctl.side;
  // A charge in progress kicks at the power it reached (same as a release).
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i]!;
    if (p.ctrl !== c) continue;
    if (p.actCharging === 1) p.actCharging = 0;
    p.ctrl = -1;
  }
  clearCharge(ctl);
  ctl.kind = ControllerKind.NONE;
  ctl.side = -1;
  ctl.slot = -1;
  ctl.buttons = 0;
  ctl.prevButtons = 0;
  ctl.receiver = -1;
  ctl.secondDef = -1;
  ctl.bufAction = 0;
  ctl.nextSwitch = -1;
  if (side !== 0 && side !== 1) return;
  for (let h = 0; h < MAX_HUMANS; h++) {
    const o = s.ctrl[h]!;
    if (o.kind === ControllerKind.HUMAN && o.side === side) return;
  }
  const cpu = s.ctrl[CPU_CONTROLLER_BASE + side]!;
  cpu.kind = ControllerKind.CPU;
  cpu.side = side;
  cpu.assist = AssistLevel.ASSISTED;
  cpu.autoSwitch = AutoSwitch.AUTO;
  const brain = s.teams[side]!.cpu;
  brain.active = 1;
  brain.level = s.config.difficulty;
  // [FEEL-2C] A restart or shoot-out kick of this side under way: the CPU gets its own take window (D-039).
  restartHandedToCpu(s, side);
  shootoutHandedToCpu(s, side);
}
