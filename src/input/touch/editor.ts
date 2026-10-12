/**
 * [TCH-08] Controls editor and touch settings screen (section 9 "Touch quality bar": drag to reposition, size,
 * spacing, opacity, mirror for left-handers, fixed or floating stick, gestures on or off, fast power bar,
 * auto-switch level, and reset). Writes settings.controls.touch (layout per TouchButtonId as ControlPlacement,
 * spacing, opacity, mirror, floatingStick, gestures, fastPowerBar) and settings.controls.autoSwitch.
 * Works by touch alone and by controller alone (FocusNavigator, [data-focus] elements).
 *
 * WAVE 0 PLACEHOLDER (FND-05): a titled screen with a Back button. TCH-08 implements the editor.
 */

import type { AppContext, Screen, ScreenParams } from '../../contracts/app';

export function createControlsEditorScreen(): Screen {
  let el: HTMLElement | null = null;
  let ctxRef: AppContext | null = null;
  return {
    id: 'controls-editor',
    mount(root: HTMLElement, ctx: AppContext, _params: ScreenParams) {
      ctxRef = ctx;
      el = root.ownerDocument.createElement('section');
      el.className = 'dk-screen dk-controls-editor';
      el.setAttribute('data-screen', 'controls-editor');
      const h = root.ownerDocument.createElement('h1');
      h.textContent = 'Touch controls';
      const p = root.ownerDocument.createElement('p');
      p.textContent = 'The controls editor arrives in a later build.';
      const back = root.ownerDocument.createElement('button');
      back.type = 'button';
      back.textContent = 'Back';
      back.setAttribute('data-focus', '');
      back.setAttribute('data-focus-default', '');
      back.addEventListener('click', () => ctxRef?.router.back());
      el.append(h, p, back);
      root.append(el);
      ctx.focus.attach(el);
    },
    unmount() {
      if (el) {
        ctxRef?.focus.detach(el);
        el.remove();
      }
      el = null;
      ctxRef = null;
    },
  };
}
