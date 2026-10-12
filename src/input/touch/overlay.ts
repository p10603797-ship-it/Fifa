/**
 * [TCH-09] Touch overlay rendering (section 9 "Touch quality bar"): DOM for the floating stick, the right-hand
 * cluster and the pause button, drawn from the same TouchIntentState the controls write. sync() runs
 * synchronously after every pointer event (pressed state within one frame of touch-down) and once per animation
 * frame; it writes to the DOM only when a value changed and animates with transforms only. Settings: opacity,
 * mirror, size (TCH-08). Power bar on the pressed button, direction hints on a 250 ms hold, and auto-hide while a
 * controller drives the side (TouchIntentState.hiddenByPad) are TCH-09 work.
 *
 * WAVE 0 BASELINE (FND-05). TCH-09 owns and refines it.
 */

import './overlay.css';
import { TouchButtonId, type TouchIntentState } from '../../contracts/touch';
import { T_TOUCHUI } from '../../contracts/tuning';
import { ATTACK_BUTTONS, type ClusterLayout } from './attack';

const KNOB = 56;

export interface TouchOverlay {
  /** The full-screen layer that receives pointer events. */
  readonly el: HTMLElement;
  /** Reflect the intent state (pressed buttons, stick). Cheap when nothing changed. */
  sync(): void;
  /** Position the buttons for a new layout. */
  layout(l: ClusterLayout): void;
  setOpacity(o: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

export function createTouchOverlay(root: HTMLElement, state: TouchIntentState, stickRadius = T_TOUCHUI.stickRadius): TouchOverlay {
  const doc = root.ownerDocument;
  const el = doc.createElement('div');
  el.className = 'dk-touch';
  el.setAttribute('data-touch-layer', '');

  const stick = doc.createElement('div');
  stick.className = 'dk-stick';
  const base = doc.createElement('div');
  base.className = 'dk-stick-base';
  base.style.width = `${stickRadius * 2}px`;
  base.style.height = `${stickRadius * 2}px`;
  const knob = doc.createElement('div');
  knob.className = 'dk-stick-knob';
  stick.append(base, knob);
  el.append(stick);

  /** Button elements indexed by TouchButtonId (null when not shown). */
  const btnEls: (HTMLElement | null)[] = new Array<HTMLElement | null>(9).fill(null);
  for (const [, id, label] of ATTACK_BUTTONS) {
    const b = doc.createElement('div');
    b.className = id === TouchButtonId.SPRINT_SKILL ? 'dk-tbtn dk-tbtn--big' : 'dk-tbtn';
    b.setAttribute('data-btn', String(id));
    b.textContent = label;
    btnEls[id] = b;
    el.append(b);
  }
  const pause = doc.createElement('div');
  pause.className = 'dk-tbtn dk-tbtn--pause';
  pause.setAttribute('data-btn', String(TouchButtonId.PAUSE));
  pause.setAttribute('aria-label', 'Pause');
  const icon = doc.createElement('span');
  icon.className = 'dk-pause-icon';
  pause.append(icon);
  btnEls[TouchButtonId.PAUSE] = pause;
  el.append(pause);
  root.append(el);

  let lastHeld = -1;
  let lastActive = false;
  let lastOx = NaN, lastOy = NaN, lastTx = NaN, lastTy = NaN;

  function place(b: HTMLElement, cx: number, cy: number, r: number): void {
    b.style.width = `${r * 2}px`;
    b.style.height = `${r * 2}px`;
    b.style.transform = `translate3d(${cx - r}px, ${cy - r}px, 0)`;
  }

  return {
    el,
    sync() {
      const held = state.held;
      if (held !== lastHeld) {
        for (let i = 0; i < btnEls.length; i++) {
          const b = btnEls[i];
          if (!b) continue;
          const on = (held & (1 << i)) !== 0;
          if (on !== ((lastHeld & (1 << i)) !== 0) || lastHeld === -1) b.classList.toggle('is-pressed', on);
        }
        lastHeld = held;
      }
      if (state.stickActive !== lastActive) {
        lastActive = state.stickActive;
        stick.classList.toggle('is-active', lastActive);
      }
      if (lastActive) {
        if (state.stickOriginX !== lastOx || state.stickOriginY !== lastOy) {
          lastOx = state.stickOriginX; lastOy = state.stickOriginY;
          base.style.transform = `translate3d(${lastOx - stickRadius}px, ${lastOy - stickRadius}px, 0)`;
        }
        // Knob follows the thumb, clamped to the base radius.
        let tx = state.stickThumbX, ty = state.stickThumbY;
        const dx = tx - lastOx, dy = ty - lastOy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > stickRadius) { tx = lastOx + (dx / d) * stickRadius; ty = lastOy + (dy / d) * stickRadius; }
        if (tx !== lastTx || ty !== lastTy) {
          lastTx = tx; lastTy = ty;
          knob.style.transform = `translate3d(${tx - KNOB / 2}px, ${ty - KNOB / 2}px, 0)`;
        }
      }
    },
    layout(l: ClusterLayout) {
      for (const [slot, id] of ATTACK_BUTTONS) {
        const g = l.slots[slot];
        place(btnEls[id]!, g.cx, g.cy, g.r);
      }
      place(pause, l.pause.cx, l.pause.cy, l.pause.r);
    },
    setOpacity(o: number) {
      el.style.opacity = String(Math.max(0.2, Math.min(1, o)));
    },
    setVisible(v: boolean) {
      el.style.display = v ? '' : 'none';
    },
    dispose() {
      el.remove();
    },
  };
}
