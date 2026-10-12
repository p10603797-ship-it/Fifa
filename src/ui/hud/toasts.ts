/**
 * [UIX-06] Toasts for goals, cards, substitutions and offside (transform/opacity animation only).
 * WAVE 0 STUB (FND-04): mounts an empty container. HUD rules: write to the DOM only when a value changes; animate
 * with transform and opacity only; nothing overlaps the touch controls or the safe areas.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { h } from '../components';

export function createToasts(): HudPart {
  let root: HTMLElement | null = null;
  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      void ctx;
      root = h('div', { class: 'hud-toasts' });
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
