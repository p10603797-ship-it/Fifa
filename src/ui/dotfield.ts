/**
 * [UIX-01] Animated dot-field background behind the menus. WAVE 0 STUB (FND-04): the menus use a static CSS dot
 * pattern (components.css .screen background) until UIX-01 lands.
 * UIX-01: a small 2D canvas animated from the app loop (screen.onFrame), stopped completely during matches so it
 * never costs a frame (brief section 12).
 */

export interface DotField {
  /** Attach the canvas under root (behind the screen content). */
  mount(root: HTMLElement): void;
  /** Advance one animation frame (called from a menu screen's onFrame). */
  frame(nowMs: number): void;
  /** Stop drawing (match start) / resume drawing (back in menus). */
  setActive(active: boolean): void;
  dispose(): void;
}

export function createDotField(): DotField {
  return {
    mount(root) {
      void root;
    },
    frame(nowMs) {
      void nowMs;
    },
    setActive(active) {
      void active;
    },
    dispose() {
      /* nothing allocated */
    },
  };
}
