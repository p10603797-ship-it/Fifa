/**
 * CPU brains. Lead-owned. Fills s.teams[t].cpu.out for every team driven by a CPU brain; the resolver then
 * processes that frame exactly like a human frame (controller index CPU_CONTROLLER_BASE + team).
 */
import { MatchPhase } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import { clearInputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';
import { RESTART_PHASES } from '../../contracts/transitions';
import { possessingTeam } from '../../sim/core/query';
import { cpuCarrier } from './carrier';
import { cpuDefend } from './defending';
import { cpuSetPiece } from '../setpieces';

export function cpuThink(s: SimState, ev: EventSink): void {
  const phase = s.match.phase;
  for (let team = 0; team < 2; team++) {
    const brain = s.teams[team]!.cpu;
    if (brain.active !== 1) continue;
    clearInputFrame(brain.out);
    if (RESTART_PHASES.includes(phase) || phase === MatchPhase.SHOOT_OUT) {
      cpuSetPiece(s, team, brain.out, ev);
    } else if (phase === MatchPhase.IN_PLAY) {
      if (possessingTeam(s) === team) cpuCarrier(s, team, brain.out, ev);
      else cpuDefend(s, team, brain.out, ev);
    }
  }
}
