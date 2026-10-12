/**
 * [TCH-04] Defence and keeper button sets and the attack-defence swap (section 9 "Defence buttons", "Attack
 * buttons" keeper row):
 *  - Defence: SPRINT & TACKLE (large: tap tackle / push-pull, hold sprint + press, swipe left hard tackle), SLIDE
 *    (becomes CLEAR when a first-time clearance is on), SWITCH (tap best defender, swipe directional), 2ND DEF
 *    (tap call, hold keep pressing, swipe down keeper rush).
 *  - Keeper with the ball: PASS throws, THROUGH driven throw, SHOOT drop kick, SPRINT & SKILL drops the ball.
 *  - The cluster swaps the moment possession changes; a thumb already down keeps its old meaning until it lifts
 *    (TouchButtonEvent.mode records the mode at touch-down).
 *
 * WAVE 0 BASELINE (FND-05): chooseClusterMode() picks ATTACK / DEFENCE / KEEPER from possession; the defence button
 * controls are not created yet (the skeleton shows the attack cluster only). TCH-04 implements the sets.
 */

import { slotTeam } from '../../contracts/constants';
import type { ReadonlySimState } from '../../contracts/state';
import { ClusterMode, type TouchIntentState } from '../../contracts/touch';
import type { ClusterLayout } from './attack';
import type { TouchButtonControl } from './button';

/** Which button set the right cluster shows for `side` (0 home, 1 away). Pure. */
export function chooseClusterMode(state: ReadonlySimState | null, side: number): ClusterMode {
  if (!state || side < 0) return ClusterMode.ATTACK;
  const b = state.ball;
  if (b.heldBy >= 0) return slotTeam(b.heldBy) === side ? ClusterMode.KEEPER : ClusterMode.DEFENCE;
  if (b.owner >= 0) return slotTeam(b.owner) === side ? ClusterMode.ATTACK : ClusterMode.DEFENCE;
  // Loose ball: keep attack unless the opponents touched it last.
  return b.lastTouchTeam >= 0 && b.lastTouchTeam !== side ? ClusterMode.DEFENCE : ClusterMode.ATTACK;
}

export interface DefenceCluster {
  readonly controls: readonly TouchButtonControl[];
  relayout(layout: ClusterLayout): void;
}

/** Defence buttons (SPRINT_TACKLE, SLIDE/CLEAR, SWITCH, SECOND_DEF). WAVE 0 STUB: no controls. */
export function createDefenceCluster(_state: TouchIntentState, _layout: ClusterLayout, _enabled?: () => boolean): DefenceCluster {
  return { controls: [], relayout() { /* TCH-04 */ } };
}
