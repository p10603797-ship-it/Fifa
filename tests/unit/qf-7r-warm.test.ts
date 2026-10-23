/**
 * [QF-7R] The loading-screen warm-up (BRIEF section 13 "Warm-up": run each animation and effect once off screen; the
 * first slide tackle or replay must not hitch) must leave no trace: GameRenderer.warmUp() runs the JIT warm-up script
 * (render/warmScript.ts: a scripted private match through every module) and the modules' event-path warm loops (goals:
 * net entries and post hits; effects: puffs, grass, flash; replay: goal sequences), then the live match must look
 * exactly as if none of it had run. Checked bit for bit on what is drawn: every visible object's world matrix, every
 * visible instanced mesh's instance matrices / colours / count, every shader uniform and draw range, and the camera,
 * on every frame of 1500 ticks of a live CPU v CPU match (2 frames per tick), against renderers loaded without it.
 */
import { describe, expect, it } from 'vitest';
import type { Object3D, PerspectiveCamera, Scene } from 'three';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createGameRenderer, type GameRendererOptions } from '../../src/render/index';
import type { RendererCore } from '../../src/render/renderer';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

interface Rig {
  r: ReturnType<typeof createGameRenderer>;
  scene: Scene | null;
  camera: PerspectiveCamera | null;
  clock: Float64Array;
}

function rig(opts: Partial<GameRendererOptions> = {}): Rig {
  const out: Rig = { r: null as unknown as Rig['r'], scene: null, camera: null, clock: new Float64Array(1) };
  const three = {
    shadowMap: { enabled: false, type: 0, autoUpdate: true, needsUpdate: false },
    info: { render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } },
    extensions: { has: () => false, get: () => null },
    capabilities: { getMaxAnisotropy: () => 4, maxTextureSize: 4096, isWebGL2: true },
    domElement: { width: 885, height: 615 },
    render(scene: Scene, camera: PerspectiveCamera) {
      out.scene = scene; out.camera = camera;
      scene.onAfterRender(this as never, scene, camera, null as never, null as never, null as never);
    },
    compile() {}, setRenderTarget() {}, getRenderTarget() { return null; }, clear() {}, readRenderTargetPixels() {},
    initTexture() {}, compileAsync() { return Promise.resolve(); },
  };
  const core = {
    available: true, failure: '', renderer: three, lost: false, scale: 0.75, aspect: 1.44, bufferWidth: 885,
    bufferHeight: 615, pixelRatio: 0.75, lossCount: 0, restoreCount: 0, resize() {}, setScale() {},
    onContextLost() { return () => {}; }, onContextRestored() { return () => {}; }, readStats(o: unknown) { return o; },
    rebuild() { return { materials: 0, textures: 0, missingTextures: 0 }; }, dispose() {},
  } as unknown as RendererCore;
  out.r = createGameRenderer({
    createCore: () => core,
    quality: { now: () => out.clock[0]!, nextFrame: () => Promise.resolve(), hidden: () => true },
    ...opts,
  });
  out.r.init({} as HTMLCanvasElement, createDefaultSettings());
  return out;
}

/** Everything a frame draws, as one string (bit-exact: numbers through JSON keep every digit). */
function snapshot(scene: Scene, camera: PerspectiveCamera): string {
  const rows: unknown[] = [];
  camera.updateMatrixWorld(true);
  rows.push(['camera', Array.from(camera.matrixWorld.elements), Array.from(camera.projectionMatrix.elements)]);
  // What is drawn: visible objects only (a hidden object's leftover uniform, e.g. the particle size scale cached from
  // the last frame that had particles, is recomputed before it draws again; if stale state ever showed, the frame it
  // shows in differs).
  scene.traverseVisible((o: Object3D) => {
    const row: unknown[] = [o.name || o.type, Array.from(o.matrixWorld.elements)];
    const im = o as Object3D & { isInstancedMesh?: boolean; count?: number; instanceMatrix?: { array: ArrayLike<number> }; instanceColor?: { array: ArrayLike<number> } | null };
    if (im.isInstancedMesh) {
      row.push(im.count, Array.from(im.instanceMatrix!.array));
      if (im.instanceColor) row.push(Array.from(im.instanceColor.array));
    }
    const mat = (o as { material?: { uniforms?: Record<string, { value: unknown }>; opacity?: number } }).material;
    if (mat && !Array.isArray(mat)) {
      row.push(mat.opacity);
      if (mat.uniforms) {
        for (const [k, u] of Object.entries(mat.uniforms)) {
          const v = u.value as { toArray?: () => number[] } | number | unknown[] | null;
          row.push(k, typeof v === 'number' ? v : v && typeof (v as { toArray?: unknown }).toArray === 'function'
            ? (v as { toArray: () => number[] }).toArray()
            : Array.isArray(v) ? v.map((x) => (x && typeof (x as { toArray?: unknown }).toArray === 'function' ? (x as { toArray: () => number[] }).toArray() : x)) : null);
        }
      }
    }
    const g = (o as { geometry?: { drawRange?: { start: number; count: number } } }).geometry;
    if (g && g.drawRange) row.push(g.drawRange.start, g.drawRange.count);
    rows.push(row);
  });
  return JSON.stringify(rows);
}

function cpuMatch(seed: number): SimState {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
  return initMatch(cfg);
}

/** Load every rig on the same live match (warm per rig), play `ticks` ticks at 2 frames per tick, compare frames. */
async function playAndCompare(rigs: Rig[], warm: boolean[], seed: number, ticks: number): Promise<{ frames: number; firstDiff: string }> {
  const curr = cpuMatch(seed);
  const prev = cloneState(curr);
  const ev = createEventBuffer();
  const inputs = [createInputFrame(), createInputFrame()];
  for (let i = 0; i < rigs.length; i++) {
    rigs[i]!.r.setMatch(curr, CLUBS);
    if (warm[i]) await rigs[i]!.r.warmUp();
  }
  const info = { nowMs: 0, dtMs: 1000 / 120, frame: 0, ticks: 1, paused: false };
  let frames = 0;
  for (let k = 0; k < ticks; k++) {
    copyState(prev, curr);
    step(curr, inputs, ev);
    for (const g of rigs) if (ev.count > 0) g.r.onEvents(ev, curr);
    for (let a = 1; a <= 2; a++) {
      info.frame++; info.nowMs += 1000 / 120; info.ticks = a === 1 ? 1 : 0;
      let ref = '';
      for (let i = 0; i < rigs.length; i++) {
        const g = rigs[i]!;
        g.clock[0] = info.nowMs;
        g.r.render(prev, curr, a * 0.5, info);
        const snap = snapshot(g.scene!, g.camera!);
        if (i === 0) ref = snap;
        else if (snap !== ref) {
          const ja = JSON.parse(ref) as unknown[], jb = JSON.parse(snap) as unknown[];
          let row = 0;
          while (row < ja.length && JSON.stringify(ja[row]) === JSON.stringify(jb[row])) row++;
          return { frames, firstDiff: `tick ${k} frame ${a} rig ${i}: ${JSON.stringify(ja[row]).slice(0, 160)} vs ${JSON.stringify(jb[row]).slice(0, 160)}` };
        }
      }
      frames++;
    }
  }
  return { frames, firstDiff: '' };
}

describe('QF-7R warm-up leaves no trace', () => {
  it('the JIT warm-up script leaves no trace on the live match (bit-identical frames)', async () => {
    const res = await playAndCompare([rig({ warmScript: false }), rig()], [true, true], 20261014, 1500);
    expect(res.firstDiff).toBe('');
    expect(res.frames).toBe(3000);
  }, 120_000);

  it('the whole warm-up (script, goal-net / post, effects and replay warm loops) leaves no trace', async () => {
    const res = await playAndCompare([rig(), rig()], [false, true], 4242, 1500);
    expect(res.firstDiff).toBe('');
  }, 120_000);

  it('warm-up never touches the live state', async () => {
    const g = rig();
    const curr = cpuMatch(99);
    for (let k = 0; k < 120; k++) step(curr, [createInputFrame(), createInputFrame()], createEventBuffer());
    const before = JSON.stringify(curr);
    g.r.setMatch(curr, CLUBS);
    await g.r.warmUp();
    expect(JSON.stringify(curr)).toBe(before);
  }, 60_000);

  it('a second match on the same renderer (rematch) skips the script but still leaves no trace', async () => {
    const a = rig({ warmScript: false }), b = rig();
    // First match on both (b runs the script now), then the comparison on a second match.
    for (const g of [a, b]) { g.r.setMatch(cpuMatch(5), CLUBS); await g.r.warmUp(); g.r.clearMatch(); }
    const res = await playAndCompare([a, b], [true, true], 6, 600);
    expect(res.firstDiff).toBe('');
  }, 120_000);
});
