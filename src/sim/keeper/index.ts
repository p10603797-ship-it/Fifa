/**
 * Keeper pipeline per team. Lead-owned. Called from ai/index.ts teamAiTick for each team.
 */
import { ActionKind, MatchPhase } from '../../contracts/enums';
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';
import { RESTART_PHASES } from '../../contracts/transitions';
import { keeperPositioning } from './positioning';
import { keeperSaveDecision } from './saves';
import { keeperComeOut } from './sweeper';
import { keeperDistributionAi } from './distribution';
import { keeperSetPiece } from './setpieces';
import { isHumanSlot } from '../core/query';

export function keeperTick(s: SimState, team: number, ev: EventSink): void {
  const k = s.teams[team]!.keeperSlot;
  if (k < 0 || s.players[k]!.active !== 1) return;
  const phase = s.match.phase;
  if (RESTART_PHASES.includes(phase) || phase === MatchPhase.SHOOT_OUT) {
    keeperSetPiece(s, team, ev);
    return;
  }
  if (phase !== MatchPhase.IN_PLAY) return;
  keeperSaveDecision(s, team, ev);
  keeperComeOut(s, team, ev);
  const p = s.players[k]!;
  if (s.ball.heldBy === k && !isHumanSlot(s, k)) keeperDistributionAi(s, team, ev);
  if (p.act === ActionKind.NONE && !isHumanSlot(s, k)) keeperPositioning(s, team, ev);
}
