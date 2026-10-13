/**
 * TCH-03 e2e harness page entry (not a spec): the real pointer manager (TCH-01) and the real attack cluster (TCH-03)
 * on a blank page, driven by real browser touch input. tests/e2e/tch-03-buttons.spec.ts bundles this file with
 * esbuild and injects it. A rAF loop calls cluster.update(now) (as the touch source's pollFrame does) and drains the
 * button event queue into `log` ("<button>:<edge>:<dir>:<mode>"), like the mapper does once per tick.
 */
import { ClusterMode, createTouchIntentState, type TouchButtonId } from '../../src/contracts/touch';
import { computeClusterLayout, createAttackCluster, SLOT_ATTACK_BUTTON } from '../../src/input/touch/attack';
import { createPointerManager } from '../../src/input/touch/pointers';

export interface Tch03Harness {
  /** Drained button events, "<button>:<edge>:<dir>:<mode>", and their timestamps (ms, performance.now). */
  log: string[];
  times: number[];
  /** Hint mask changes, [ms, mask]. */
  hints: [number, number][];
  held(): number;
  hintMask(): number;
  setMode(mode: ClusterMode): void;
  centre(id: TouchButtonId): { x: number; y: number };
  clear(): void;
}

declare global {
  interface Window { __tch03?: Tch03Harness }
}

const el = document.createElement('div');
el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;touch-action:none;user-select:none;';
document.body.style.margin = '0';
document.body.append(el);

const st = createTouchIntentState();
st.mode = ClusterMode.ATTACK;
const layout = computeClusterLayout(window.innerWidth, window.innerHeight, { top: 0, right: 0, bottom: 0, left: 0 });
const cluster = createAttackCluster(st, layout, undefined, { hints: () => true });
const log: string[] = [];
const times: number[] = [];
const hints: [number, number][] = [];
let lastMask = 0;

function drain(): void {
  for (let i = 0; i < st.buttonEventCount; i++) {
    const e = st.buttonEvents[i]!;
    log.push(`${e.button}:${e.edge}:${e.dir}:${e.mode}`);
    times.push(e.tMs);
  }
  st.buttonEventCount = 0;
  const m = cluster.hintMask;
  if (m !== lastMask) {
    lastMask = m;
    hints.push([performance.now(), m]);
  }
}

createPointerManager({ el, controls: cluster.controls, onChange: drain });

function frame(): void {
  cluster.update(performance.now());
  drain();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.__tch03 = {
  log,
  times,
  hints,
  held: () => st.held,
  hintMask: () => cluster.hintMask,
  setMode: (mode) => { st.mode = mode; },
  centre: (id) => {
    const slot = SLOT_ATTACK_BUTTON.indexOf(id);
    const g = layout.slots[slot]!;
    return { x: g.cx, y: g.cy };
  },
  clear: () => { log.length = 0; times.length = 0; hints.length = 0; },
};
