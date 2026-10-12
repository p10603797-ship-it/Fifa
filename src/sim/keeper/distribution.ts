/**
 * [GKP-04] Distribution AI for keepers not controlled by a human: throw, roll, drop kick, driven kick, and a
 * quick release when a counter-attack is on. Picks targets with SIM-08 selectReceiver / TAI-09 scoring and
 * starts releases through GKP-05 startKeeperRelease. Releases well within 6 s.
 */
import type { EventSink } from '../../contracts/events';
import type { SimState } from '../../contracts/state';

export function keeperDistributionAi(s: SimState, team: number, ev: EventSink): void { /* stub */ }
