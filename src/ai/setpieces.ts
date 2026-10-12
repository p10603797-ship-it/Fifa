/**
 * [TAI-13] Set-piece AI, attacking and defending: scripted positions for corners (incl. corner tactics), free
 * kicks (attackers, wall chosen by RUL-05), throw-ins, goal kicks, kick-offs and penalties (SET_PIECE jobs,
 * legal distances respected so RUL-11 rarely needs to teleport); cpuSetPiece fills the CPU's InputFrame to take
 * set pieces (aim, power hold, curl) and to defend them.
 */
import type { InputFrame } from '../contracts/input';
import type { EventSink } from '../contracts/events';
import type { SimState } from '../contracts/state';

export function setPiecePositions(s: SimState, team: number, ev: EventSink): void { /* stub */ }
export function cpuSetPiece(s: SimState, team: number, out: InputFrame, ev: EventSink): void { /* stub */ }
