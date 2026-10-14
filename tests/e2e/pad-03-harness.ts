/**
 * PAD-03 e2e harness page entry (not a spec): the real pad manager reading a mocked navigator.getGamepads
 * (window.__pad03pads), the real device registry (bound pads), the real reconnect flow + DOM card (installReconnectFlow)
 * and a session double with the app session's pause rules that steps the real sim once per animation frame while it
 * is not paused (IN_PLAY, or a penalty for P1). tests/e2e/pad-03-reconnect.spec.ts bundles this file with esbuild.
 */
import type { MatchSetup, PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame, type InputSource } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import { createDeviceRegistry } from '../../src/input/devices';
import { createPadManager } from '../../src/input/pad/manager';
import { installReconnectFlow, type ReconnectSession } from '../../src/input/pad/reconnect';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { makeScenario, runTicks } from '../harness/scenario';

type MockPad = { connected: boolean; buttons: { pressed: boolean; touched: boolean; value: number }[]; axes: number[] };

export interface Pad03Harness {
  start(mode: 'play' | 'penalty'): void;
  bind(): void;
  paused(): boolean;
  pausedBy(): number;
  ticks(): number;
  taken(): number;
  aimZ(): number;
  calls(): string[];
}

declare global {
  interface Window { __pad03?: Pad03Harness; __pad03pads?: (MockPad | null)[] }
}

document.body.style.margin = '0';
document.body.style.background = '#07070d';
const ui = document.createElement('div');
ui.id = 'ui';
ui.style.cssText = 'position:fixed;inset:0;';
document.body.append(ui);

const settings = createDefaultSettings();
const store: SettingsStore = {
  get: () => settings, update: (m) => m(settings), subscribe: () => () => {}, reset: () => {}, persistent: false,
  loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
};
const platform: PlatformInfo = { isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
const pads = createPadManager(() => (window.__pad03pads ?? []) as unknown as Gamepad[], { eventTarget: null });
const reg = createDeviceRegistry({
  touchRoot: ui, getProjector: () => null, getState: () => state, settings: store, platform, onPause: () => {}, pads,
});

const calls: string[] = [];
const setup: MatchSetup = { config: {} as MatchSetup['config'], bindings: [{ human: 0, deviceIds: ['pad:1'] }] };
let paused = false;
let pausedBy = -1;
let src: InputSource | null = null;
let wasPaused = false;
const session: ReconnectSession = {
  get active() { return state !== null; },
  get paused() { return paused; },
  get pausedBy() { return pausedBy; },
  finished: false,
  pause(by) { if (state && !paused) { paused = true; pausedBy = by; } },
  resume(by) {
    if (!state) return false;
    if (!paused) return true;
    if (pausedBy !== -1 && by !== pausedBy) return false;
    paused = false; pausedBy = -1;
    return true;
  },
  getSetup: () => setup,
  setHumanDevice(h, d) { calls.push(`${h}:${d === 'cpu' ? 'cpu' : d.join(',')}`); return true; },
};
const handle = installReconnectFlow({ session, devices: reg, platform, root: ui, focus: null, autoFrame: false });

let state: SimState | null = null;
const ev = createEventBuffer();
const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
let ticks = 0;

function frame(t: number): void {
  handle.update(t);
  pads.poll(t);
  if (src) src.pollFrame?.(t);
  if (state && src) {
    if (paused) wasPaused = true;
    else {
      if (wasPaused) { src.releaseAll(); wasPaused = false; }
      src.sample(frames[0]!, { tick: state.tick + 1, human: 0, side: 0, state, projector: null });
      step(state, frames, ev);
      ticks++;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__pad03 = {
  start(mode) {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed: 11 });
    if (mode === 'penalty') {
      ev.begin(s.tick);
      awardRestart(s, RestartKind.PENALTY, 0, 0, 0, ev);
      for (let i = 0; i < 200 && s.match.restart.ready !== 1; i++) runTicks(s, 1);
    }
    state = s;
  },
  bind() { src = reg.createSource('pad:1', 0); },
  paused: () => paused,
  pausedBy: () => pausedBy,
  ticks: () => ticks,
  taken: () => state?.match.restart.taken ?? -1,
  aimZ: () => state?.match.restart.aimZ ?? 0,
  calls: () => calls.slice(),
};
