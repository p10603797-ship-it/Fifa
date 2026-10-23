/**
 * [UIX-07] Controlled-player panels beside the radar (brief section 12: "Controlled-player name and stamina sit beside
 * it: player 1 on the left, player 2 on the right"; section 6: stamina shows on the HUD): for each human controller
 * with a controlled player, a P1 / P2 tag in the player colour, the shirt number (JetBrains Mono, tabular figures), the
 * HUD (short) name and a stamina bar (transform: scaleX) that turns amber below T_PLAYER.staminaLowThreshold and red
 * below STAMINA_CRITICAL.
 *
 * Writes only on change: shown / hidden per human, name and number when the controlled slot or its roster entry
 * changes, the bar when stamina moves by a whole percent, the low / critical state when it crosses a threshold. The
 * panels hug the radar (or the screen centre when the radar is off) at the bottom, clear of the stick zone corner and
 * the button cluster.
 */
import type { AppContext, FrameInfo, HudPart } from '../../contracts/app';
import type { Club } from '../../contracts/data';
import { ControllerKind } from '../../contracts/enums';
import type { EventBuffer } from '../../contracts/events';
import type { CameraProjector } from '../../contracts/input';
import type { ReadonlySimState } from '../../contracts/state';
import { T_PLAYER, T_TOUCHUI } from '../../contracts/tuning';
import { h, injectStyle } from '../components';
import { HUD_LARGE_SCALE, HUD_SHARED_CSS, bindLargerHud, onRadarPref, radarEnabled } from './hudShared';
import { RADAR_TUNING, radarCanvasSize } from './radar';
import { numStr } from './scoreboard';
import { rosterName } from './toasts';

/** Presentation constants (UI, not gameplay; no tuning.ts entry needed). */
export const PLAYER_INFO_TUNING = {
  /** Panel width, CSS px at HUD scale 1. */
  width: 150,
  /** Gap between a panel and the radar (or the screen centre), CSS px. */
  gap: 10,
  /** Below this stamina the bar turns red (amber below T_PLAYER.staminaLowThreshold). */
  staminaCritical: 0.2,
  /** Stamina bar resolution: one write per this many steps of 0..1. */
  steps: 100,
} as const;

/**
 * Width kept free at each bottom corner for the touch button cluster (T_TOUCHUI: system edge margin + big + gap +
 * small button + the arc's swing), CSS px. The cluster sits bottom right (bottom left when mirrored), so the panels
 * shrink (names ellipsize) rather than reach it on narrow screens.
 */
const CLUSTER_RESERVE_PX = T_TOUCHUI.systemEdgeMargin + T_TOUCHUI.bigButton + T_TOUCHUI.buttonGap + T_TOUCHUI.smallButton + 40;

const CSS = `
.hud-player-info { position:absolute; left: 50%; bottom: calc(var(--safe-bottom, 0px) + ${RADAR_TUNING.bottom}px); width: 0; height: 0; }
.hud-player-info[hidden] { display:none; }
.hud-pi { position:absolute; bottom: 0; box-sizing: border-box; overflow: hidden;
  width: max(0px, min(calc(${PLAYER_INFO_TUNING.width}px * var(--hs)), calc(50vw - var(--rh, 0px) - ${PLAYER_INFO_TUNING.gap}px - ${CLUSTER_RESERVE_PX}px)));
  display:flex; align-items:center; gap: calc(8px * var(--hs)); padding: calc(7px * var(--hs)) calc(10px * var(--hs));
  border-radius: calc(12px * var(--hs)); background: rgba(7,7,13,.78); border: 1px solid var(--hairline);
  font-family: var(--font-ui); color: var(--text-1); line-height: 1.1; }
.hud-pi[hidden] { display:none; }
.hud-pi--p1 { right: calc(var(--rh, 0px) + ${PLAYER_INFO_TUNING.gap}px); border-left: 3px solid var(--p1); }
.hud-pi--p2 { left: calc(var(--rh, 0px) + ${PLAYER_INFO_TUNING.gap}px); border-right: 3px solid var(--p2); flex-direction: row-reverse; text-align: right; }
.hud-pi .pi-num { flex:none; min-width: 1.6em; font-family: var(--font-num); font-variant-numeric: tabular-nums;
  font-size: calc(20px * var(--hs)); font-weight: 600; text-align: center; }
.hud-pi--p1 .pi-num { color: var(--p1); }
.hud-pi--p2 .pi-num { color: var(--p2); }
.hud-pi .pi-main { display:flex; flex-direction:column; gap: calc(5px * var(--hs)); min-width: 0; flex: 1; }
.hud-pi .pi-name { font-size: calc(13px * var(--hs)); font-weight: 700; letter-spacing: .06em; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; }
.hud-pi .pi-bar { position:relative; height: calc(5px * var(--hs)); border-radius: 3px; background: var(--surface-4); overflow:hidden; }
.hud-pi .pi-fill { position:absolute; inset: 0; border-radius: 3px; background: var(--success); transform-origin: 0 50%;
  transform: scaleX(1); will-change: transform; }
.hud-pi--p2 .pi-fill { transform-origin: 100% 50%; }
.hud-pi[data-stamina="low"] .pi-fill { background: var(--warning); }
.hud-pi[data-stamina="critical"] .pi-fill { background: var(--error); }
`;

/** Stamina 0..1 -> bar step 0..steps (whole percent by default). Pure. */
export function staminaStep(stamina: number, steps: number = PLAYER_INFO_TUNING.steps): number {
  if (!Number.isFinite(stamina) || stamina <= 0) return 0;
  if (stamina >= 1) return steps;
  return Math.round(stamina * steps);
}

/** 0 fine, 1 low (amber), 2 critical (red). Pure. */
export function staminaLevel(stamina: number): number {
  if (!(stamina >= PLAYER_INFO_TUNING.staminaCritical)) return 2;
  if (stamina < T_PLAYER.staminaLowThreshold) return 1;
  return 0;
}

const LEVEL_ATTR: readonly string[] = ['ok', 'low', 'critical'];
/** scaleX strings for each step (built once: the bar write allocates nothing). */
const SCALE_STR: readonly string[] = Array.from({ length: PLAYER_INFO_TUNING.steps + 1 }, (_, i) => `scaleX(${i / PLAYER_INFO_TUNING.steps})`);

interface Panel {
  el: HTMLElement;
  num: HTMLElement;
  name: HTMLElement;
  fill: HTMLElement;
  hidden: boolean;
  slot: number;
  roster: number;
  team: number;
  step: number;
  level: number;
}

function makePanel(human: number): Panel {
  const tag = human === 0 ? 'p1' : 'p2';
  const num = h('span', { class: 'pi-num', text: '', testId: `pi-${tag}-num` });
  const name = h('span', { class: 'pi-name', text: '', testId: `pi-${tag}-name` });
  const fill = h('div', { class: 'pi-fill', testId: `pi-${tag}-fill` });
  const el = h('div', { class: `hud-pi hud-pi--${tag}`, testId: `pi-${tag}`, attrs: { 'data-stamina': 'ok' } },
    num, h('div', { class: 'pi-main' }, name, h('div', { class: 'pi-bar' }, fill)));
  el.hidden = true;
  return { el, num, name, fill, hidden: true, slot: -1, roster: -1, team: -1, step: -1, level: 0 };
}

export function createPlayerInfo(): HudPart {
  let root: HTMLElement | null = null;
  const panels: Panel[] = [];
  let unbindLarge: (() => void) | null = null;
  let unPref: (() => void) | null = null;
  let radarOn = true;
  let hs = 1;
  let shownRh = -1;
  const radarSize = { w: 0, h: 0 };
  const onWindowResize = (): void => syncRadarGap();

  function syncRadarGap(): void {
    if (!root) return;
    // Radar box = canvas (radar.ts radarCanvasSize) + 4 px padding per side at the HUD scale + 1 px border per side.
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    const rh = radarOn ? Math.round((radarCanvasSize(hs, vh, radarSize).w + 8 * hs + 2) / 2) : 0;
    if (rh === shownRh) return;
    shownRh = rh;
    root.style.setProperty('--rh', `${rh}px`);
  }

  function resetPanels(): void {
    for (const p of panels) {
      p.slot = p.roster = p.team = p.step = -1;
    }
  }

  return {
    mount(parent: HTMLElement, ctx: AppContext) {
      injectStyle('hud-shared', HUD_SHARED_CSS);
      injectStyle('hud-player-info', CSS);
      panels.length = 0;
      panels.push(makePanel(0), makePanel(1));
      root = h('div', { class: 'hud-part hud-player-info', testId: 'hud-player-info' }, panels[0]!.el, panels[1]!.el);
      parent.append(root);
      radarOn = radarEnabled(ctx.settings);
      unbindLarge = bindLargerHud(ctx, root, (large) => {
        hs = large ? HUD_LARGE_SCALE : 1;
        syncRadarGap();
      });
      unPref = onRadarPref((on) => {
        radarOn = on;
        syncRadarGap();
      });
      syncRadarGap();
      if (typeof window !== 'undefined') window.addEventListener('resize', onWindowResize);
    },
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      void state;
      void clubs;
      resetPanels();
    },
    update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null) {
      void frame;
      void projector;
      for (let hIdx = 0; hIdx < panels.length; hIdx++) {
        const pn = panels[hIdx]!;
        const c = state.ctrl[hIdx];
        const slot = c && c.kind === ControllerKind.HUMAN ? c.slot : -1;
        const valid = slot >= 0 && slot < state.players.length;
        if (pn.hidden !== !valid) {
          pn.hidden = !valid;
          pn.el.hidden = !valid;
        }
        if (!valid) continue;
        const p = state.players[slot]!;
        if (slot !== pn.slot || p.rosterIdx !== pn.roster || p.team !== pn.team) {
          pn.slot = slot;
          pn.roster = p.rosterIdx;
          pn.team = p.team;
          const d = state.squads[p.team]?.[p.rosterIdx];
          pn.num.textContent = d ? numStr(d.shirt) : '';
          const nm = rosterName(state, p.team, p.rosterIdx);
          pn.name.textContent = nm;
          pn.el.setAttribute('aria-label', `Player ${hIdx + 1}: ${d ? `${d.shirt} ` : ''}${nm}`);
        }
        const st = p.stamina;
        const step = staminaStep(st);
        if (step !== pn.step) {
          pn.step = step;
          pn.fill.style.transform = SCALE_STR[step]!;
        }
        const level = staminaLevel(st);
        if (level !== pn.level) {
          pn.level = level;
          pn.el.setAttribute('data-stamina', LEVEL_ATTR[level]!);
        }
      }
    },
    onEvents(events: EventBuffer, state: ReadonlySimState) {
      void events;
      void state;
    },
    setVisible(v: boolean) {
      if (root) root.hidden = !v;
    },
    dispose() {
      unbindLarge?.();
      unPref?.();
      unbindLarge = unPref = null;
      if (typeof window !== 'undefined') window.removeEventListener('resize', onWindowResize);
      root?.remove();
      root = null;
      panels.length = 0;
      shownRh = -1;
    },
  };
}
