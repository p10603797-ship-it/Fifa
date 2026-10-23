/**
 * [UIX-07] Power bar by the controlled player (brief section 12: "Power bar by the player, mirrored on the pressed
 * touch button" — the touch-button mirror is TCH-09's): while a human charges a pass / shot / lob / through ball
 * (ctrl.powerBtn !== 0), a small bar in the player colour (P1 ember, P2 cyan) floats above his head, placed with the
 * renderer's CameraProjector (pitchToScreen of the player at ANCHOR_Y m), filled by ctrl.power (transform: scaleX).
 * On release it fades out holding the final value.
 *
 * Writes only on change: position as a translate3d in whole pixels when the projected anchor moves, the fill when the
 * power moves by a whole percent, the shown state when charging starts or stops. Everything animates with transform
 * and opacity only. No projector (renderer not loaded) or a point behind the camera hides the bar.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { ControllerKind } from '../../contracts/enums';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { h, injectStyle } from '../components';
import { HUD_LARGE_SCALE, HUD_SHARED_CSS, bindLargerHud } from './hudShared';

/** Presentation constants (UI, not gameplay; no tuning.ts entry needed). */
export const POWER_BAR_TUNING = {
  /** Height above the ground the bar anchors to: the tip of the renderer's overhead marker (render/markers.ts MARKER_Y), m. */
  anchorY: 2.25,
  /** The overhead marker's world size and its on-screen clamp (render/markers.ts markerWorld / markerMinPx / markerMaxPx):
   *  the bar sits above the marker so the two never overlap. */
  markerWorld: 0.8,
  markerMinPx: 20,
  markerMaxPx: 40,
  /** Bar size, CSS px at HUD scale 1, and the gap above the marker. */
  width: 64,
  height: 8,
  lift: 6,
  /** Keep the bar this far inside the viewport edges, CSS px. */
  edge: 8,
  /** Fill resolution (one write per step). */
  steps: 100,
} as const;

const CSS = `
.hud-power { position:absolute; left: 0; top: 0; width: 0; height: 0; }
.hud-power[hidden] { display:none; }
.hud-pb { position:absolute; left: 0; top: 0; width: calc(${POWER_BAR_TUNING.width}px * var(--hs));
  height: calc(${POWER_BAR_TUNING.height}px * var(--hs)); box-sizing: border-box; padding: 1px; border-radius: 5px;
  background: rgba(7,7,13,.78); border: 1px solid var(--hairline-strong); opacity: 0;
  transition: opacity 160ms var(--ease, ease-out); will-change: transform, opacity; }
.hud-pb.is-on { opacity: 1; transition-duration: 60ms; }
.hud-pb .pb-fill { width: 100%; height: 100%; border-radius: 3px; transform-origin: 0 50%; transform: scaleX(0); will-change: transform; }
.hud-pb--p1 .pb-fill { background: var(--p1); }
.hud-pb--p2 .pb-fill { background: var(--p2); }
`;

/** Power 0..1 -> fill step 0..steps. Pure. */
export function powerStep(power: number, steps: number = POWER_BAR_TUNING.steps): number {
  if (!Number.isFinite(power) || power <= 0) return 0;
  if (power >= 1) return steps;
  return Math.round(power * steps);
}

/**
 * Top-left of the bar (CSS px, whole pixels) for a projected anchor point (sx, sy): centred over it, its bottom `lift`
 * px above, clamped inside a vw x vh viewport with `edge` px margins. Pure.
 */
export function powerBarPosition(
  sx: number, sy: number, vw: number, vh: number, w: number, hgt: number, lift: number, edge: number, out: { x: number; y: number },
): { x: number; y: number } {
  let x = sx - w / 2;
  let y = sy - lift - hgt;
  const maxX = vw - edge - w;
  const maxY = vh - edge - hgt;
  x = x > maxX ? maxX : x;
  y = y > maxY ? maxY : y;
  x = x < edge ? edge : x;
  y = y < edge ? edge : y;
  out.x = Math.round(x);
  out.y = Math.round(y);
  return out;
}

const FILL_STR: readonly string[] = Array.from({ length: POWER_BAR_TUNING.steps + 1 }, (_, i) => `scaleX(${i / POWER_BAR_TUNING.steps})`);

interface Bar {
  el: HTMLElement;
  fill: HTMLElement;
  on: boolean;
  x: number;
  y: number;
  step: number;
}

function makeBar(human: number): Bar {
  const tag = human === 0 ? 'p1' : 'p2';
  const fill = h('div', { class: 'pb-fill', testId: `pb-${tag}-fill` });
  const el = h('div', { class: `hud-pb hud-pb--${tag}`, testId: `pb-${tag}`, attrs: { 'aria-hidden': 'true' } }, fill);
  return { el, fill, on: false, x: -99999, y: -99999, step: -1 };
}

export function createPowerBar(): HudPart {
  let root: HTMLElement | null = null;
  const bars: Bar[] = [];
  let unbindLarge: (() => void) | null = null;
  let hs = 1;
  const scr = { x: 0, y: 0 };
  const pos = { x: 0, y: 0 };

  function setOn(b: Bar, on: boolean): void {
    if (b.on === on) return;
    b.on = on;
    b.el.classList.toggle('is-on', on);
  }

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      injectStyle('hud-shared', HUD_SHARED_CSS);
      injectStyle('hud-power', CSS);
      bars.length = 0;
      bars.push(makeBar(0), makeBar(1));
      root = h('div', { class: 'hud-part hud-power', testId: 'hud-power' }, bars[0]!.el, bars[1]!.el);
      parent.append(root);
      unbindLarge = bindLargerHud(ctx, root, (large) => {
        hs = large ? HUD_LARGE_SCALE : 1;
      });
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      void state;
      void clubs;
      for (const b of bars) setOn(b, false);
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void frame;
      const T = POWER_BAR_TUNING;
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        const c = state.ctrl[i];
        const charging = !!c && c.kind === ControllerKind.HUMAN && c.powerBtn !== 0 && c.slot >= 0 && c.slot < state.players.length;
        if (!charging || !projector) {
          setOn(b, false);
          continue;
        }
        const p = state.players[c.slot]!;
        if (!projector.pitchToScreen(p.x, T.anchorY, p.z, scr) || !Number.isFinite(scr.x) || !Number.isFinite(scr.y)) {
          setOn(b, false);
          continue;
        }
        // Clear the renderer's overhead marker: its projected size, clamped like the renderer clamps it.
        const ax = scr.x;
        const ay = scr.y;
        let markerPx: number = T.markerMinPx;
        if (projector.pitchToScreen(p.x, T.anchorY + T.markerWorld, p.z, scr) && Number.isFinite(scr.y)) {
          const m = ay - scr.y;
          markerPx = m < T.markerMinPx ? T.markerMinPx : m > T.markerMaxPx ? T.markerMaxPx : m;
        }
        const vw = typeof window !== 'undefined' ? window.innerWidth : 1180;
        const vh = typeof window !== 'undefined' ? window.innerHeight : 820;
        powerBarPosition(ax, ay, vw, vh, T.width * hs, T.height * hs, markerPx + T.lift * hs, T.edge, pos);
        if (pos.x !== b.x || pos.y !== b.y) {
          b.x = pos.x;
          b.y = pos.y;
          b.el.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
        }
        const step = powerStep(c.power);
        if (step !== b.step) {
          b.step = step;
          b.fill.style.transform = FILL_STR[step]!;
        }
        setOn(b, true);
      }
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      void events;
      void state;
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
      if (!v) for (const b of bars) setOn(b, false);
    },
    dispose() {
      unbindLarge?.();
      unbindLarge = null;
      root?.remove();
      root = null;
      bars.length = 0;
    },
  };
}
