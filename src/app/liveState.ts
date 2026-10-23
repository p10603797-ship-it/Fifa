/**
 * [QF-7R] The second live state of a match (MatchRuntime.prev: the state before the latest tick, which the loop
 * refreshes with copyState(prev, curr) every tick and the renderer interpolates from) built with the live state's own
 * hidden classes.
 *
 * Why not cloneState: sim/core/clone.ts builds every nested object generically, `out = {}` then `out[key] = value`
 * for each key. V8 turns an object that grows by keyed stores past a dozen properties into a dictionary-mode (slow
 * properties) object, so prev's players, ball, match, teams, ctrl... were all hash tables (measured in Chromium with
 * %HasFastProperties: curr fast, prev slow; tests/unit/qf-7r-live-state.test.ts). Then every tick:
 *  - copyState(prev, curr) stored ~800 doubles into dictionary slots, a new 16-byte heap number each (~13 KB a tick:
 *    the largest allocation source of a live match, ~25 KB per frame at 60 fps with the replay ring's reads, and the
 *    minor-GC pauses that come with it);
 *  - every read of prev (render interpolation, replay recording, HUD) was a dictionary lookup on a second, different
 *    map from curr's: polymorphic code everywhere a state is read.
 * createSimState() + copyState() gives prev exactly curr's maps (both are built by the same literals), with every
 * value copied: identical content (hashState equal), monomorphic readers, in-place double stores.
 *
 * Loading screen only (allocates one state).
 */
import { createSimState, type SimState } from '../contracts/state';
import { copyState } from '../sim/core/clone';

/** A deep copy of `s` with the hidden classes of a state made by createSimState (sim/init.ts's live states). */
export function cloneLiveState(s: SimState): SimState {
  const out = createSimState(s.config, s.squads);
  copyState(out, s);
  return out;
}
