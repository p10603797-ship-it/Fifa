/**
 * [UIX-07] Controlled player name and stamina beside the radar: player 1 left, player 2 right.
 * WAVE 0 STUB (FND-04): mounts an empty container. HUD rules: write to the DOM only when a value changes; animate
 * with transform and opacity only; nothing overlaps the touch controls or the safe areas.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { h } from '../components';

export function createPlayerInfo(): HudPart {
  let root: HTMLElement | null = null;
  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      void ctx;
      root = h('div', { class: 'hud-player-info' });
      parent.append(root);
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      void state;
      void clubs;
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void state;
      void frame;
      void projector;
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      void events;
      void state;
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
    },
    dispose() {
      root?.remove();
      root = null;
    },
  };
}
