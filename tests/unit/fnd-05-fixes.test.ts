/**
 * FND-05 fixes for the independent review (tests/unit/review-fnd-05-*.test.ts, tests/e2e/review-fnd-05-*.spec.ts):
 *  - touch mapper: a DOWN cancelled in the same queue drain fires nothing (TouchEdge.CANCEL = release without action);
 *  - keyboard + menu input: a direction stays held while any of its keys is down (WASD + arrows);
 *  - broadcast camera: the bottom margin holds with the REAL projection for an off-centre ball, at every camera
 *    setting and aspect, while the ball moves fast to the near touchline and corners;
 *  - renderer settings: setSettings / bindSettings keep ctx.settings current and re-apply camera settings.
 * THREE maths only, no WebGL, no DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, type WebGLRenderer } from 'three';
import { MenuAction, type FocusNavigator } from '../../src/contracts/app';
import { CameraType, QualityTier } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import { createDefaultSettings, type CameraSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import {
  createTouchIntentState, pushButtonEvent, SwipeDir, TouchButtonId, TouchEdge, type TouchIntentState,
} from '../../src/contracts/touch';
import { T_CAMERA } from '../../src/contracts/tuning';
import {
  createKeyboardSource, DIR_CODES, DIR_DOWN, DIR_LEFT, DIR_RIGHT, DIR_UP, dirKeyBit, dirsFromKeyMask,
} from '../../src/input/keyboard';
import { createMenuInput, MENU_REPEAT_DELAY_MS } from '../../src/input/menuInput';
import { createPadManager } from '../../src/input/pad/manager';
import { createTouchMapper, latchedDownMask } from '../../src/input/touch/mapper';
import { createBroadcastCamera } from '../../src/render/camera/broadcast';
import { createGameRenderer, fillInterp } from '../../src/render/index';
import { createQuality } from '../../src/render/quality';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

function sampleCtx(): InputSampleContext {
  const s = initMatch(createMatchConfig()) as SimState;
  return { tick: 1, human: 0, side: 0, state: s, projector: null };
}

function keyEvent(type: string, code: string, repeat = false): Event {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, { code, repeat });
  return e;
}

// ------------------------------------------------------------------ touch mapper

describe('FND-05 fix: touch mapper drops cancelled presses', () => {
  const B = (st: TouchIntentState, b: TouchButtonId, e: TouchEdge, t: number): void =>
    pushButtonEvent(st, b, e, SwipeDir.NONE, t, st.mode);
  const bit = (b: TouchButtonId): number => 1 << b;

  it('latchedDownMask: DOWN alone and DOWN+UP latch; DOWN+CANCEL does not; CANCEL alone does nothing', () => {
    const st = createTouchIntentState();
    B(st, TouchButtonId.SHOOT, TouchEdge.DOWN, 0);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(bit(TouchButtonId.SHOOT));
    B(st, TouchButtonId.SHOOT, TouchEdge.UP, 30);
    B(st, TouchButtonId.SHOOT, TouchEdge.TAP, 30);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(bit(TouchButtonId.SHOOT));
    st.buttonEventCount = 0;
    B(st, TouchButtonId.SHOOT, TouchEdge.DOWN, 0);
    B(st, TouchButtonId.SHOOT, TouchEdge.CANCEL, 5);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(0);
    st.buttonEventCount = 0;
    B(st, TouchButtonId.PASS, TouchEdge.CANCEL, 5);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(0);
  });

  it('a real tap then a cancelled press of the same button in one drain still fires the tap once', () => {
    const st = createTouchIntentState();
    B(st, TouchButtonId.PASS, TouchEdge.DOWN, 0);
    B(st, TouchButtonId.PASS, TouchEdge.UP, 20);
    B(st, TouchButtonId.PASS, TouchEdge.DOWN, 40);
    B(st, TouchButtonId.PASS, TouchEdge.CANCEL, 44);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(bit(TouchButtonId.PASS));
  });

  it('cancelling one button does not drop another button pressed in the same drain', () => {
    const st = createTouchIntentState();
    B(st, TouchButtonId.SHOOT, TouchEdge.DOWN, 0);
    B(st, TouchButtonId.THROUGH, TouchEdge.DOWN, 1);
    B(st, TouchButtonId.SHOOT, TouchEdge.CANCEL, 5);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(bit(TouchButtonId.THROUGH));
  });

  it('SPRINT is a hold, never latched: a cancelled sprint press gives no SPRINT bit', () => {
    const st = createTouchIntentState();
    B(st, TouchButtonId.SPRINT_SKILL, TouchEdge.DOWN, 0);
    expect(latchedDownMask(st.buttonEvents, st.buttonEventCount)).toBe(0);
  });

  it('mapper: down+cancel between ticks -> no bit; the queue is drained', () => {
    const st = createTouchIntentState();
    const m = createTouchMapper(st);
    const out = createInputFrame();
    const ctx = sampleCtx();
    B(st, TouchButtonId.SHOOT, TouchEdge.DOWN, 0);
    B(st, TouchButtonId.SHOOT, TouchEdge.CANCEL, 5);
    m.sample(out, ctx);
    expect(out.buttons & Btn.SHOOT).toBe(0);
    expect(st.buttonEventCount).toBe(0);
    // A held THROUGH (finger still down) keeps its bit via state.held regardless of the queue.
    st.held = 1 << TouchButtonId.THROUGH;
    m.sample(out, ctx);
    expect(out.buttons).toBe(Btn.THROUGH);
  });
});

// ------------------------------------------------------------------ keyboard + menu: per-key directions

describe('FND-05 fix: overlapping direction keys', () => {
  it('dirKeyBit / dirsFromKeyMask: one bit per key; a direction is held while any of its keys is', () => {
    expect(DIR_CODES.length).toBe(8);
    const d = dirKeyBit('KeyD'), r = dirKeyBit('ArrowRight'), w = dirKeyBit('KeyW');
    expect(d).not.toBe(r);
    expect(dirKeyBit('KeyJ')).toBe(0);
    expect(dirsFromKeyMask(d | r)).toBe(DIR_RIGHT);
    expect(dirsFromKeyMask(r)).toBe(DIR_RIGHT);
    expect(dirsFromKeyMask(d | w)).toBe(DIR_RIGHT | DIR_UP);
    expect(dirsFromKeyMask(dirKeyBit('KeyA') | dirKeyBit('ArrowDown'))).toBe(DIR_LEFT | DIR_DOWN);
    expect(dirsFromKeyMask(0)).toBe(0);
  });

  it('keyboard: every pair of keys for one direction, release either -> still moving', () => {
    const pairs: [string, string, 'mx' | 'mz', number][] = [
      ['KeyD', 'ArrowRight', 'mx', 127], ['KeyA', 'ArrowLeft', 'mx', -127],
      ['KeyW', 'ArrowUp', 'mz', -127], ['KeyS', 'ArrowDown', 'mz', 127],
    ];
    for (const [a, b, axis, v] of pairs) {
      for (const first of [a, b]) {
        const target = new EventTarget();
        const kb = createKeyboardSource({ onPause: () => {}, target, doc: new EventTarget() });
        const out = createInputFrame();
        const ctx = sampleCtx();
        target.dispatchEvent(keyEvent('keydown', a));
        target.dispatchEvent(keyEvent('keydown', b));
        target.dispatchEvent(keyEvent('keyup', first));
        kb.sample(out, ctx);
        expect(out[axis]).toBe(v);
        target.dispatchEvent(keyEvent('keyup', first === a ? b : a));
        kb.sample(out, ctx);
        expect(out[axis]).toBe(0);
        kb.dispose();
      }
    }
  });

  it('keyboard: blur clears every key, so a later keyup of the other key cannot underflow', () => {
    const target = new EventTarget();
    const kb = createKeyboardSource({ onPause: () => {}, target, doc: new EventTarget() });
    const out = createInputFrame();
    const ctx = sampleCtx();
    target.dispatchEvent(keyEvent('keydown', 'KeyD'));
    target.dispatchEvent(keyEvent('keydown', 'ArrowRight'));
    target.dispatchEvent(new Event('blur'));
    expect(kb.dirs).toBe(0);
    target.dispatchEvent(keyEvent('keyup', 'ArrowRight'));
    target.dispatchEvent(keyEvent('keydown', 'ArrowRight'));
    kb.sample(out, ctx);
    expect(out.mx).toBe(127);
    target.dispatchEvent(keyEvent('keyup', 'ArrowRight'));
    kb.sample(out, ctx);
    expect(out.mx).toBe(0);
  });

  it('menu input: holding W and ArrowUp, releasing ArrowUp keeps UP repeating', () => {
    const target = new EventTarget();
    const handled: MenuAction[] = [];
    const focus = { handle: (a: MenuAction) => { handled.push(a); } } as unknown as FocusNavigator;
    const mi = createMenuInput({ focus, onPause: vi.fn(), pads: createPadManager(() => []), target });
    target.dispatchEvent(keyEvent('keydown', 'KeyW'));
    mi.poll(0);
    target.dispatchEvent(keyEvent('keydown', 'ArrowUp'));
    mi.poll(16); // fresh press edge of a second key
    target.dispatchEvent(keyEvent('keyup', 'ArrowUp'));
    const n = handled.length;
    mi.poll(32);
    mi.poll(16 + MENU_REPEAT_DELAY_MS + 1); // W still down: the repeat fires
    expect(handled.length).toBe(n + 1);
    expect(handled.every((a) => a === MenuAction.UP)).toBe(true);
    target.dispatchEvent(keyEvent('keyup', 'KeyW'));
    const m = handled.length;
    mi.poll(5000);
    expect(handled.length).toBe(m);
    mi.dispose();
  });
});

// ------------------------------------------------------------------ broadcast camera bottom margin

function makeCtx(cssW: number, cssH: number, cam: CameraSettings, reduced: boolean): RenderContext {
  return {
    renderer: null as unknown as WebGLRenderer,
    scene: new Scene(),
    camera: new PerspectiveCamera(),
    settings: createDefaultSettings(),
    clubs: [],
    size: { cssW, cssH, dpr: 2, scale: 0.75 },
    tier: QualityTier.BALANCED,
    cameraSettings: { ...cam },
    reducedMotion: reduced,
    night: false,
  };
}

describe('FND-05 fix: broadcast camera bottom margin with the real projection', () => {
  const limit = 1 - T_CAMERA.ballBottomMargin;
  const paths: [number, number, number, number][] = [
    [0, 0, 0, 34], [0, 0, 52.5, 34], [0, 0, -52.5, 34], [-50, 33.5, 50, 33.5], [30, -20, -40, 36], [-52, 0, 52, 34],
  ];

  it('ball stays above the bottom 15% at every camera type / height / zoom / aspect, moving at 25 m/s', () => {
    let worst = 0;
    let worstCase = '';
    for (const type of [CameraType.BROADCAST, CameraType.WIDE, CameraType.CLOSE]) {
      for (const height of [0, 5, 10, 15, 20]) {
        for (const zoom of [0, 5, 10, 15, 20]) {
          for (const [w, h] of [[1180, 820], [1024, 768], [1600, 686]] as const) {
            for (const reduced of [false, true]) {
              const ctx = makeCtx(w, h, { type, height, zoom }, reduced);
              const cam = createBroadcastCamera(ctx);
              const s = initMatch(createMatchConfig()) as SimState;
              const interp = createInterpState();
              const frame: RenderFrame = { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp };
              const p = { x: 0, y: 0 };
              for (const [ax, az, bx, bz] of paths) {
                cam.snapTo(ax, 0.11, az, 1);
                const len = Math.hypot(bx - ax, bz - az);
                const n = Math.ceil((len / 25) * 60);
                for (let i = 0; i <= n + 30; i++) {
                  const k = Math.min(1, i / n);
                  const b = s.ball;
                  b.x = ax + (bx - ax) * k; b.y = 0.11; b.z = az + (bz - az) * k;
                  b.vx = i < n ? ((bx - ax) / len) * 25 : 0; b.vz = i < n ? ((bz - az) / len) * 25 : 0; b.vy = 0;
                  b.owner = -1; b.heldBy = -1;
                  fillInterp(interp, s, s, 1);
                  cam.update(frame);
                  if (cam.pitchToScreen(b.x, 0.11, b.z, p) && p.y / h > worst) {
                    worst = p.y / h;
                    worstCase = `type ${type} h ${height} z ${zoom} ${w}x${h} reduced ${reduced} ball (${b.x.toFixed(1)}, ${b.z.toFixed(1)})`;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(worst, worstCase).toBeLessThanOrEqual(limit + 1e-4);
  });

  it('snapTo on a ball at the near touchline far off-centre also holds the margin; midfield is untouched', () => {
    for (const type of [CameraType.BROADCAST, CameraType.CLOSE]) {
      const ctx = makeCtx(1180, 820, { type, height: 0, zoom: 20 }, false);
      const cam = createBroadcastCamera(ctx);
      const p = { x: 0, y: 0 };
      for (const [x, z] of [[0, 34], [52.5, 34], [-52.5, 34], [20, 34], [-40, 30]] as const) {
        cam.snapTo(x, 0.11, z, x >= 0 ? 1 : -1);
        expect(cam.pitchToScreen(x, 0.11, z, p)).toBe(true);
        expect(p.y / 820).toBeLessThanOrEqual(limit + 1e-4);
      }
      // A ball near the centre needs no correction: the look point stays at 75% of the ball's z.
      cam.snapTo(0, 0.11, 0, 1);
      expect(cam.lookZ).toBeCloseTo(0, 9);
      cam.snapTo(10, 0.11, -12, 1);
      expect(cam.lookZ).toBeCloseTo(-12 * 0.75, 9);
    }
  });
});

// ------------------------------------------------------------------ renderer settings

describe('FND-05 fix: renderer follows live settings', () => {
  function storeOf(initial: Settings) {
    let cur: Settings = initial;
    const subs = new Set<(s: Readonly<Settings>) => void>();
    return {
      get: () => cur,
      subscribe(fn: (s: Readonly<Settings>) => void) { subs.add(fn); return () => { subs.delete(fn); }; },
      /** Replace the object (as the real SettingsStore does) and notify. */
      update(mut: (s: Settings) => void) {
        const next = JSON.parse(JSON.stringify(cur)) as Settings;
        mut(next);
        cur = next;
        for (const fn of [...subs]) fn(cur);
      },
      get listeners() { return subs.size; },
    };
  }

  function playerFrac(r: ReturnType<typeof createGameRenderer>): number {
    const a = { x: 0, y: 0 }, b = { x: 0, y: 0 };
    r.projector.pitchToScreen(0, 0, 0, a);
    r.projector.pitchToScreen(0, 1.8, 0, b);
    return (a.y - b.y) / 820;
  }

  it('bindSettings applies camera changes from a store that replaces its object; unbind / dispose stop it', () => {
    const r = createGameRenderer();
    r.resize(1180, 820, 2);
    const store = storeOf(createDefaultSettings());
    const unbind = r.bindSettings(store);
    expect(store.listeners).toBe(1);
    const base = playerFrac(r);
    store.update((s) => { s.camera.zoom = 20; });
    const zoomed = playerFrac(r);
    expect(zoomed).toBeGreaterThan(base * 1.2);
    unbind();
    expect(store.listeners).toBe(0);
    store.update((s) => { s.camera.zoom = 0; });
    expect(playerFrac(r)).toBeCloseTo(zoomed, 9);
    // Re-bind, then dispose unsubscribes.
    r.bindSettings(store);
    expect(playerFrac(r)).toBeLessThan(base); // zoom 0 applied on bind
    expect(store.listeners).toBe(1);
    r.dispose();
    expect(store.listeners).toBe(0);
  });

  it('setSettings with the same object or unrelated changes is a no-op for the camera', () => {
    const r = createGameRenderer();
    r.resize(1180, 820, 2);
    const s0 = createDefaultSettings();
    r.setSettings(s0);
    const f0 = playerFrac(r);
    r.setSettings(s0);
    const s1 = { ...s0, audio: { ...s0.audio, master: 0.1 } };
    r.setSettings(s1);
    expect(playerFrac(r)).toBeCloseTo(f0, 12);
    r.dispose();
  });

  it('quality.request re-reads the fixed resolution scale from the CURRENT ctx.settings', () => {
    const settings = createDefaultSettings();
    const ctx = makeCtx(1180, 820, settings.camera, false);
    ctx.settings = settings;
    const setScale = vi.fn();
    const q = createQuality(ctx, { setScale });
    expect(setScale).toHaveBeenLastCalledWith(0.75);
    const next = JSON.parse(JSON.stringify(settings)) as Settings;
    next.graphics.tier = QualityTier.QUALITY;
    next.graphics.resolutionScale = 1;
    ctx.settings = next; // what GameRenderer.setSettings does
    expect(q.request(next.graphics.tier)).toBe(QualityTier.QUALITY);
    expect(setScale).toHaveBeenLastCalledWith(1);
    expect(q.scale).toBe(1);
  });
});
