/**
 * Team AI pipeline per tick. Lead-owned. Drives every player no controller is driving, on both teams.
 * Order per team: phase -> tactics -> shape -> reset jobs -> (set pieces | chaser, defence, press, transition,
 * support, runs, receiver assist) -> keeper -> execute jobs.
 */
import { MatchPhase } from '../contracts/enums';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';
import { RESTART_PHASES } from '../contracts/transitions';
import { keeperTick } from '../sim/keeper';
import { resetJobs } from './jobs';
import { updateShape } from './shape';
import { assignSupport } from './support';
import { assignRuns } from './runs';
import { assignDefensiveShape } from './defshape';
import { assignPressing } from './press';
import { assignTransition, updateTeamPhase } from './transition';
import { assignChaser, executeJobs } from './steer';
import { setPiecePositions } from './setpieces';
import { receiverAssist, tacticsTick } from './tactics';

export function teamAiTick(s: SimState, ev: EventSink): void {
  const phase = s.match.phase;
  const restart = RESTART_PHASES.includes(phase) || phase === MatchPhase.SHOOT_OUT;
  for (let team = 0; team < 2; team++) {
    updateTeamPhase(s, team, ev);
    tacticsTick(s, team, ev);
    updateShape(s, team, ev);
    resetJobs(s, team);
    if (phase !== MatchPhase.IN_PLAY) {
      // [INT-A, TAI-05 CR] assignPressing only runs in open play: clear its press / cover picks so nobody (SIM-15's
      // second-defender press, the next open-play tick's hysteresis) reads a stale pick from before the stoppage.
      const t = s.teams[team]!;
      t.pressSlot = -1;
      t.coverSlot = -1;
    }
    if (restart) {
      setPiecePositions(s, team, ev);
    } else if (phase === MatchPhase.IN_PLAY) {
      assignChaser(s, team, ev);
      assignDefensiveShape(s, team, ev);
      assignPressing(s, team, ev);
      assignTransition(s, team, ev);
      assignSupport(s, team, ev);
      assignRuns(s, team, ev);
      receiverAssist(s, team, ev);
    }
    keeperTick(s, team, ev);
    executeJobs(s, team, ev);
  }
}
