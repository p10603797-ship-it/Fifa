/**
 * [QF-4] Headless live-render rig: the real sim (CPU v CPU) steps the real pipeline and the real GameRenderer
 * (render/index.ts: interpolation, replay, broadcast + cinematic cameras, module order, events) draws every frame
 * through a fake WebGL core; the scene modules are the real player model (GFX-07 + GFX-12 driver), so poses,
 * skeletons and camera transforms are exactly what the app would draw. No WebGL, no DOM.
 * Helpers measure what a viewer sees: screen points through the drawn camera and whether a player's body hides the
 * ball (projected body capsules from the drawn skeleton against the projected ball).
 */
import { PerspectiveCamera, Vector3, type Scene, type WebGLRenderer } from 'three';
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import { ControllerKind, RestartKind } from '../../src/contracts/enums';
import type { EventBuffer } from '../../src/contracts/events';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { RenderStats } from '../../src/contracts/render';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createGameRenderer, type DotkickRenderer } from '../../src/render/index';
import { BODY, FRAME_SIZE, Joint } from '../../src/render/players/fk';
import { createPlayerModel, type PlayerModelModule } from '../../src/render/players/model';
import type { RebuildReport, RendererCore } from '../../src/render/renderer';
import type { RenderContext, RenderModule } from '../../src/render/types';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';

export interface LiveRig {
  r: DotkickRenderer;
  /** Current and previous sim state (render interpolates between them). */
  s: SimState;
  prev: SimState;
  model: PlayerModelModule;
  /** The renderer context the modules share. */
  ctx: RenderContext;
  /** The camera of the last drawn frame (what the fake core was asked to draw with). */
  camera: PerspectiveCamera;
  w: number;
  h: number;
  ev: EventBufferImpl;
  frames: InputFrame[];
  /** Draws so far. */
  draws: number;
  /** One sim tick, then `framesPerTick` drawn frames (alpha k / framesPerTick). */
  tick(framesPerTick?: number): void;
  /** Award a restart through RUL-11 (events reach the renderer like a tick's events). */
  award(kind: RestartKind, team: number, x: number, z: number): void;
  /** Resize the viewport (CSS px). */
  resize(w: number, h: number): void;
}

export interface LiveRigOptions {
  seed?: number;
  w?: number;
  h?: number;
  settings?: Settings;
  config?: Partial<MatchConfig>;
  /** Humans stay as configured (default: both CPU). */
  keepHumans?: boolean;
  /** Called after every drawn frame with the camera it was drawn with. */
  onDraw?: (camera: PerspectiveCamera) => void;
}

function fakeCore(onDraw: (camera: PerspectiveCamera) => void): RendererCore {
  const three = {
    shadowMap: { enabled: false },
    info: { render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } },
    extensions: { has: () => false },
    domElement: { width: 885, height: 615 },
    render(scene: Scene, camera: PerspectiveCamera) {
      onDraw(camera);
      (scene.onAfterRender as unknown as (...a: unknown[]) => void).call(scene, this, scene, camera, null, null, null);
    },
    compile() {},
    setRenderTarget() {},
    getRenderTarget() { return null; },
    clear() {},
    readRenderTargetPixels() {},
  };
  let scale = 0.75;
  return {
    available: true, failure: '', renderer: three as unknown as WebGLRenderer,
    get lost() { return false; },
    get scale() { return scale; },
    aspect: 1180 / 820, bufferWidth: 885, bufferHeight: 615, pixelRatio: 0.75, lossCount: 0, restoreCount: 0,
    resize() {},
    setScale(s: number) { scale = s; },
    onContextLost() { return () => {}; },
    onContextRestored() { return () => {}; },
    readStats(out: RenderStats) { return out; },
    rebuild(): RebuildReport { return { materials: 0, textures: 0, missingTextures: 0 }; },
    dispose() {},
  } as unknown as RendererCore;
}

export function createLiveRig(o: LiveRigOptions = {}): LiveRig {
  const cfg = createMatchConfig();
  cfg.seed = o.seed ?? 20261014;
  if (o.config) Object.assign(cfg, o.config);
  if (!o.keepHumans) cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const s = initMatch(cfg) as SimState;
  const prev = cloneState(s);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  let model: PlayerModelModule | null = null;
  const clock = { t: 1000 };
  const rig: LiveRig = {
    r: null as unknown as DotkickRenderer, s, prev, model: null as unknown as PlayerModelModule, ctx: null as unknown as RenderContext,
    camera: new PerspectiveCamera(), w: o.w ?? 1180, h: o.h ?? 820, ev, frames, draws: 0,
    tick(framesPerTick = 1) {
      copyState(prev, s);
      step(s, frames, ev);
      rig.r.onEvents(ev, s);
      for (let k = 0; k < framesPerTick; k++) {
        const dtMs = 1000 / (60 * framesPerTick);
        clock.t += dtMs;
        rig.r.render(prev, s, k / framesPerTick, { nowMs: clock.t, dtMs, frame: rig.draws + 1, ticks: k === 0 ? 1 : 0, paused: false });
      }
    },
    award(kind, team, x, z) {
      ev.begin(s.tick);
      awardRestart(s, kind, team, x, z, ev);
      rig.r.onEvents(ev as EventBuffer, s);
    },
    resize(w, h) {
      rig.w = w; rig.h = h;
      rig.r.resize(w, h, 1);
    },
  };
  const r = createGameRenderer({
    createCore: () => fakeCore((cam) => { rig.camera = cam; rig.draws++; o.onDraw?.(cam); }),
    createModules: (ctx) => {
      rig.ctx = ctx;
      model = createPlayerModel(ctx);
      return [model as RenderModule];
    },
    quality: { now: () => clock.t, nextFrame: () => Promise.resolve(), hidden: () => false },
  });
  rig.r = r;
  r.init({} as HTMLCanvasElement, o.settings ?? createDefaultSettings());
  r.resize(rig.w, rig.h, 1);
  r.setMatch(s, CLUBS);
  rig.model = model!;
  return rig;
}

const V = new Vector3();

/** Screen point (CSS px, y down) and view depth of a world point through `cam`; null when behind it. */
export function toScreen(cam: PerspectiveCamera, w: number, h: number, x: number, y: number, z: number): { x: number; y: number; depth: number } | null {
  cam.updateMatrixWorld(true);
  V.set(x, y, z).applyMatrix4(cam.matrixWorldInverse);
  const depth = -V.z;
  if (!(depth > cam.near)) return null;
  V.applyMatrix4(cam.projectionMatrix);
  return { x: (V.x + 1) * 0.5 * w, y: (1 - V.y) * 0.5 * h, depth };
}

/** Screen radius (px) of a sphere of radius r (m) at view depth d. */
export function screenRadius(cam: PerspectiveCamera, h: number, r: number, depth: number): number {
  return (r * h) / (2 * Math.tan((cam.fov * Math.PI) / 360) * depth);
}

/** World point of joint j's local point (reference-body metres) in a world skeleton. */
export function jointPoint(sk: Float64Array, j: number, lx: number, ly: number, lz: number): [number, number, number] {
  const o = j * FRAME_SIZE;
  return [
    sk[o]! * lx + sk[o + 3]! * ly + sk[o + 6]! * lz + sk[o + 9]!,
    sk[o + 1]! * lx + sk[o + 4]! * ly + sk[o + 7]! * lz + sk[o + 10]!,
    sk[o + 2]! * lx + sk[o + 5]! * ly + sk[o + 8]! * lz + sk[o + 11]!,
  ];
}

/** Body capsules (from joint, local start, local end, radius m) approximating the drawn player parts. */
const CAPSULES: [number, [number, number, number], [number, number, number], number][] = [
  [Joint.ROOT, [0, -0.05, 0], [0, 0.05, 0], 0.15],
  [Joint.SPINE, [0, 0.05, 0], [0, BODY.neckY - 0.05, 0], 0.17],
  [Joint.HEAD, [0, BODY.headY, 0], [0, BODY.headY, 0], 0.12],
  [Joint.SHOULDER_L, [0, 0, 0], [0, -BODY.upperArm, 0], 0.05],
  [Joint.SHOULDER_R, [0, 0, 0], [0, -BODY.upperArm, 0], 0.05],
  [Joint.ELBOW_L, [0, 0, 0], [0, -(BODY.foreArm + BODY.hand), 0], 0.045],
  [Joint.ELBOW_R, [0, 0, 0], [0, -(BODY.foreArm + BODY.hand), 0], 0.045],
  [Joint.HIP_L, [0, 0, 0], [0, -BODY.thigh, 0], 0.08],
  [Joint.HIP_R, [0, 0, 0], [0, -BODY.thigh, 0], 0.08],
  [Joint.KNEE_L, [0, 0, 0], [0, -BODY.shin, 0], 0.06],
  [Joint.KNEE_R, [0, 0, 0], [0, -BODY.shin, 0], 0.06],
  [Joint.ANKLE_L, [BODY.heelX, -0.04, 0], [BODY.toeX, -0.04, 0], 0.05],
  [Joint.ANKLE_R, [BODY.heelX, -0.04, 0], [BODY.toeX, -0.04, 0], 0.05],
];

/**
 * How clear the ball is of a player's drawn body on screen: the smallest gap (px) between the projected ball disc and
 * any projected body capsule in front of it (negative = the body covers part of the ball; -2 * ball radius or less
 * = most of it). +Infinity when no body part is in front of the ball.
 */
export function ballClearance(cam: PerspectiveCamera, w: number, h: number, sk: Float64Array, bx: number, by: number, bz: number): number {
  const b = toScreen(cam, w, h, bx, by, bz);
  if (!b) return -Infinity;
  const br = screenRadius(cam, h, BALL_RADIUS, b.depth);
  let best = Infinity;
  for (const [j, a, e, rad] of CAPSULES) {
    for (let k = 0; k <= 6; k++) {
      const u = k / 6;
      const p = jointPoint(sk, j, a[0] + (e[0] - a[0]) * u, a[1] + (e[1] - a[1]) * u, a[2] + (e[2] - a[2]) * u);
      const q = toScreen(cam, w, h, p[0], p[1], p[2]);
      if (!q || q.depth >= b.depth) continue;
      const gap = Math.hypot(q.x - b.x, q.y - b.y) - br - screenRadius(cam, h, rad, q.depth);
      if (gap < best) best = gap;
    }
  }
  return best;
}

/** Projected height (fraction of the screen height) of a player's drawn body: head top to lowest boot. */
export function bodyScreenHeight(cam: PerspectiveCamera, w: number, h: number, sk: Float64Array): number {
  const top = jointPoint(sk, Joint.HEAD, 0, BODY.headY + BODY.headRY, 0);
  const l = jointPoint(sk, Joint.ANKLE_L, 0, -BODY.ankleY, 0);
  const r = jointPoint(sk, Joint.ANKLE_R, 0, -BODY.ankleY, 0);
  const a = toScreen(cam, w, h, top[0], top[1], top[2]);
  const bl = toScreen(cam, w, h, l[0], l[1], l[2]);
  const brr = toScreen(cam, w, h, r[0], r[1], r[2]);
  if (!a || !bl || !brr) return Infinity;
  return (Math.max(bl.y, brr.y) - a.y) / h;
}

/** Slots of the active players. */
export function activeSlots(s: SimState): number[] {
  const out: number[] = [];
  for (let i = 0; i < NUM_SLOTS; i++) if (s.players[i]!.active === 1) out.push(i);
  return out;
}
