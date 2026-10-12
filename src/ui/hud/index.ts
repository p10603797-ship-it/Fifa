/**
 * [FND-04] In-match HUD: composes the HUD parts (scoreboard, toasts, radar, player info, power bar, hints) into one
 * HudPart under #hud. The loop calls update() every rendered frame and onEvents() after ticks with events; each
 * part writes to the DOM only on change. Hidden (no updates) outside matches.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { h } from '../components';
import { createHints } from './hints';
import { createPlayerInfo } from './playerInfo';
import { createPowerBar } from './powerBar';
import { createRadar } from './radar';
import { createScoreboard } from './scoreboard';
import { createToasts } from './toasts';

export interface Hud extends HudPart {
  readonly parts: readonly HudPart[];
  readonly visible: boolean;
}

export function createHud(): Hud {
  const parts: HudPart[] = [createScoreboard(), createToasts(), createRadar(), createPlayerInfo(), createPowerBar(), createHints()];
  let root: HTMLElement | null = null;
  let visible = false;
  return {
    parts,
    get visible() {
      return visible;
    },
    mount(parent: HTMLElement, ctx: AppContext) {
      root = h('div', { class: 'hud-root', testId: 'hud' });
      root.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      root.hidden = true;
      parent.append(root);
      for (const p of parts) p.mount(root, ctx);
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      for (const p of parts) p.setMatch(state, clubs);
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      if (!visible) return;
      for (let i = 0; i < parts.length; i++) parts[i]!.update(state, frame, projector);
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      for (let i = 0; i < parts.length; i++) parts[i]!.onEvents(events, state);
    },
    setVisible(v: boolean) {
      visible = v;
      if (root) root.hidden = !v;
      for (const p of parts) p.setVisible(v);
    },
    dispose() {
      for (const p of parts) p.dispose();
      root?.remove();
      root = null;
    },
  };
}
