/**
 * [RUL-11] Restart safety and the common restart flow: awardRestart (fills s.match.restart, emits
 * RESTART_AWARDED, calls the kind's Setup, sets the phase), restartTick (setup delay T_RULES.restartSetupTicks,
 * then legal positions for every player — opponents >= 9.15 m / 2 m at throw-ins, kick-off halves — by
 * teleporting anyone not there in time; ready flag; timeout default for humans after 12 s; CPU takes after
 * T_RULES.cpuRestartDelay), never two restarts queued, never the wrong team, taker always valid (re-pick if sent
 * off / substituted). SET_PIECE action handler (taker waiting). SETPIECE_INPUT routes controller frames by kind.
 */
import { RestartKind } from '../../contracts/enums';
import type { ActionHandler, SetPieceInputFn } from '../../contracts/systems';
import type { EventSink } from '../../contracts/events';
import type { InputFrame } from '../../contracts/input';
import type { SimState } from '../../contracts/state';
import { kickOffInput } from './machine';
import { throwInInput } from './throwin';
import { goalKickInput } from './goalkick';
import { cornerInput } from './corner';
import { freeKickInput } from './freekick';
import { penaltyInput } from './penalty';

export function awardRestart(s: SimState, kind: RestartKind, team: number, x: number, z: number, ev: EventSink): void { /* stub */ }
export function restartTick(s: SimState, ev: EventSink): void { /* stub */ }
/** Move every player not in a legal position for the current restart to the nearest legal spot (teleport). */
export function legalizePositions(s: SimState): void { /* stub */ }

/** Set-piece input routing by RestartKind. */
export const SETPIECE_INPUT: readonly (SetPieceInputFn | null)[] = [
  null, kickOffInput, throwInInput, goalKickInput, cornerInput, freeKickInput, penaltyInput,
];
void RestartKind;

export const setPieceHandler: ActionHandler = {
  update(s, slot, ev) { /* stub */ },
  end(s, slot, interrupted) { /* stub */ },
};
