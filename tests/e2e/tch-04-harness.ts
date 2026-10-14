/**
 * TCH-04 e2e harness page entry (not a spec): the real pointer manager (TCH-01), the real attack cluster (TCH-03) and
 * the real defence cluster + cluster controller (TCH-04) on a blank page, driven by real browser touch input, wired
 * the way the touch source does it (src/input/touch/cluster.ts header): pointer onChange -> cluster.sync(now) ->
 * slot DOM; a rAF loop -> cluster.update(now) -> slot DOM. The slot DOM is a minimal stand-in for the overlay
 * (TCH-09): one element per ClusterSlot showing cluster.labels and the pressed state. Button events are drained into
 * `log` ("<button>:<edge>:<dir>:<mode>") as the mapper does once per tick. tests/e2e/tch-04-swap.spec.ts bundles this
 * file with esbuild and injects it.
 */
import { ClusterMode, ClusterSlot, createTouchIntentState, type SwipeDir, type TouchButtonId } from '../../src/contracts/touch';
import { computeClusterLayout, createAttackCluster } from '../../src/input/touch/attack';
import { createClusterController, createDefenceCluster } from '../../src/input/touch/cluster';
import { createPointerManager } from '../../src/input/touch/pointers';

export interface Tch04Harness {
  log: string[];
  held(): number;
  /** Controller view per ClusterSlot. */
  labels(): string[];
  ids(): number[];
  modes(): number[];
  pressed(): number;
  /** What the slot DOM shows: label text and pressed class per ClusterSlot. */
  dom(): { text: string; pressed: boolean }[];
  setMode(mode: ClusterMode): void;
  setClear(on: boolean): void;
  centre(slot: ClusterSlot): { x: number; y: number };
  aim(button: TouchButtonId): { dir: SwipeDir; dx: number; dy: number; seq: number };
  clear(): void;
}

declare global {
  interface Window { __tch04?: Tch04Harness }
}

const el = document.createElement('div');
el.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;touch-action:none;user-select:none;';
document.body.style.margin = '0';
document.body.append(el);

const st = createTouchIntentState();
st.mode = ClusterMode.ATTACK;
const layout = computeClusterLayout(window.innerWidth, window.innerHeight, { top: 0, right: 0, bottom: 0, left: 0 });
const attack = createAttackCluster(st, layout);
const defence = createDefenceCluster(st, layout);
const cluster = createClusterController({ state: st, attack, defence });

const slotEls: HTMLElement[] = [];
for (let s = ClusterSlot.BIG; s <= ClusterSlot.HIGH; s++) {
  const g = layout.slots[s];
  const b = document.createElement('div');
  b.setAttribute('data-slot', String(s));
  b.style.cssText = `position:absolute;left:${g.cx - g.r}px;top:${g.cy - g.r}px;width:${g.r * 2}px;height:${g.r * 2}px;border-radius:50%;pointer-events:none;`;
  el.append(b);
  slotEls.push(b);
}
let shown = -1;
function paint(): void {
  if (cluster.version === shown) return;
  shown = cluster.version;
  for (let s = 0; s < 4; s++) {
    const b = slotEls[s]!;
    if (b.textContent !== cluster.labels[s]) b.textContent = cluster.labels[s]!;
    b.classList.toggle('is-pressed', (cluster.pressed & (1 << s)) !== 0);
  }
}

const log: string[] = [];
function drain(): void {
  for (let i = 0; i < st.buttonEventCount; i++) {
    const e = st.buttonEvents[i]!;
    log.push(`${e.button}:${e.edge}:${e.dir}:${e.mode}`);
  }
  st.buttonEventCount = 0;
}

createPointerManager({
  el,
  controls: cluster.controls,
  onChange: () => {
    cluster.sync(performance.now());
    paint();
    drain();
  },
});

function frame(): void {
  cluster.update(performance.now());
  paint();
  drain();
  requestAnimationFrame(frame);
}
cluster.update(performance.now());
paint();
requestAnimationFrame(frame);

window.__tch04 = {
  log,
  held: () => st.held,
  labels: () => cluster.labels.slice(),
  ids: () => cluster.ids.slice(),
  modes: () => cluster.modes.slice(),
  pressed: () => cluster.pressed,
  dom: () => slotEls.map((b) => ({ text: b.textContent ?? '', pressed: b.classList.contains('is-pressed') })),
  setMode: (mode) => { st.mode = mode; },
  setClear: (on) => { st.clearOn = on; },
  centre: (slot) => ({ x: layout.slots[slot].cx, y: layout.slots[slot].cy }),
  aim: (button) => {
    const a = defence.swipeAim(button);
    return { dir: a.dir, dx: a.dx, dy: a.dy, seq: a.seq };
  },
  clear: () => { log.length = 0; },
};
