/**
 * Snapshots and replays. [FND-03]
 * Snapshot = JSON-safe serialisation of the full state (incl. config + squads) for online resync, recovery
 * and replay keyframes. Replay = { simVersion, config, squads hash, seed, inputs per tick } (FND-06 records).
 */
import type { SimState } from '../../contracts/state';
import type { InputFrame } from '../../contracts/input';

export function serializeState(s: SimState): string { throw new Error('FND-03'); }
export function deserializeState(json: string): SimState { throw new Error('FND-03'); }
/** Pack frames for all humans of one tick into a compact int array (network / replay). */
export function packFrames(frames: readonly InputFrame[], out: Int16Array, offset: number): number { throw new Error('FND-03'); }
export function unpackFrames(src: Int16Array, offset: number, frames: InputFrame[]): number { throw new Error('FND-03'); }
