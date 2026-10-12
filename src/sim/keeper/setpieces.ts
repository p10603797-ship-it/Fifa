/**
 * [GKP-06] Keeper at set pieces: positioning against free kicks (wall-aware), penalties (on the line, dive
 * choice for AI keepers; user dive input arrives via RUL-06 penalty input), corners (claim zone), goal kicks.
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

export function keeperSetPiece(s: SimState, team: number, ev: EventSink): void { /* stub */ }
