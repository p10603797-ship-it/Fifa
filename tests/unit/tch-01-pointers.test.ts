/**
 * TCH-01 pointer manager: the pure routing core (createPointerRouter) with synthetic pointer sequences, and the DOM
 * binding (createPointerManager) driven through Node EventTarget fakes for the touch layer, window and document.
 * Real controls (stick TCH-02, generic button TCH-03) are used where the quality bar is about held inputs.
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Btn } from '../../src/contracts/input';
import {
  createTouchIntentState, TouchButtonId, TouchEdge, type TouchControl, type TouchIntentState,
} from '../../src/contracts/touch';
import { createTouchButton, type TouchButtonControl } from '../../src/input/touch/button';
import { heldToButtons } from '../../src/input/touch/mapper';
import {
  createPointerManager, createPointerRouter, MAX_POINTERS, PointerKind, pointerKindOf, type PointerManager,
} from '../../src/input/touch/pointers';
import { createStick, type StickControl } from '../../src/input/touch/stick';

// ------------------------------------------------------------------ recording controls

function rec(name: string, log: string[], hit: (x: number, y: number) => boolean): TouchControl {
  return {
    hit,
    down: (id) => { log.push(`${name}.down#${id}`); },
    move: (id) => { log.push(`${name}.move#${id}`); },
    up: (id) => { log.push(`${name}.up#${id}`); },
    cancel: (id) => { log.push(`${name}.cancel#${id}`); },
    releaseAll: () => { log.push(`${name}.releaseAll`); },
  };
}

const W = 1180, H = 820;
/** Zones used by the recording rigs: a button at the bottom right, the stick in the left half, gestures elsewhere. */
const inButton = (x: number, y: number): boolean => (x - 1060) ** 2 + (y - 740) ** 2 <= 56 * 56;
const inStick = (x: number): boolean => x < W / 2;

function recRig(): { log: string[]; controls: TouchControl[] } {
  const log: string[] = [];
  return { log, controls: [rec('btn', log, inButton), rec('stick', log, inStick), rec('gest', log, () => true)] };
}

// ------------------------------------------------------------------ real-control rig

interface RealRig {
  state: TouchIntentState;
  pause: TouchButtonControl;
  pass: TouchButtonControl;
  shoot: TouchButtonControl;
  sprint: TouchButtonControl;
  stick: StickControl;
  gestLog: string[];
  controls: TouchControl[];
}

/** Pause, PASS, SHOOT, SPRINT & SKILL, stick (left half), gestures (everything else): the TCH-07 priority order. */
function realRig(): RealRig {
  const state = createTouchIntentState();
  const pause = createTouchButton({ state, id: TouchButtonId.PAUSE, geom: { cx: 1126, cy: 54, r: 30 } });
  const pass = createTouchButton({ state, id: TouchButtonId.PASS, geom: { cx: 930, cy: 748, r: 38 } });
  const shoot = createTouchButton({ state, id: TouchButtonId.SHOOT, geom: { cx: 1084, cy: 610, r: 38 } });
  const sprint = createTouchButton({ state, id: TouchButtonId.SPRINT_SKILL, geom: { cx: 1084, cy: 748, r: 48 } });
  const stick = createStick({ state, zone: (x) => x < W / 2 });
  const gestLog: string[] = [];
  const gestures = rec('gest', gestLog, () => true);
  return { state, pause, pass, shoot, sprint, stick, gestLog, controls: [pause, pass, shoot, sprint, stick, gestures] };
}

const bit = (id: TouchButtonId): number => 1 << id;
const edgesOf = (s: TouchIntentState, id: TouchButtonId): TouchEdge[] => {
  const out: TouchEdge[] = [];
  for (let i = 0; i < s.buttonEventCount; i++) if (s.buttonEvents[i]!.button === id) out.push(s.buttonEvents[i]!.edge);
  return out;
};

// ------------------------------------------------------------------ DOM fakes

class FakeEl extends EventTarget {
  readonly captured: number[] = [];
  /** Dispatch lostpointercapture synchronously from releasePointerCapture (some engines do). */
  syncLost = true;
  setPointerCapture(id: number): void { if (!this.captured.includes(id)) this.captured.push(id); }
  hasPointerCapture(id: number): boolean { return this.captured.includes(id); }
  releasePointerCapture(id: number): void {
    const i = this.captured.indexOf(id);
    if (i < 0) return;
    this.captured.splice(i, 1);
    if (this.syncLost) this.dispatchEvent(pe('lostpointercapture', id));
  }
}

class FakeWin extends EventTarget {
  innerWidth = W;
  innerHeight = H;
  readonly screen = { orientation: new EventTarget() };
  private timers: ((() => void) | null)[] = [];
  setTimeout(fn: () => void): number { this.timers.push(fn); return this.timers.length; }
  clearTimeout(h: number): void { if (h > 0 && h <= this.timers.length) this.timers[h - 1] = null; }
  get pendingTimers(): number { return this.timers.filter((t) => t !== null).length; }
  flush(): void {
    const t = this.timers;
    this.timers = [];
    for (const f of t) f?.();
  }
}

class FakeDoc extends EventTarget {
  visibilityState: 'visible' | 'hidden' = 'visible';
}

interface PeInit { pointerType?: string; button?: number; buttons?: number; cancelable?: boolean; target?: unknown }

function pe(type: string, id: number, x = 0, y = 0, o: PeInit = {}): Event {
  const e = new Event(type, { cancelable: o.cancelable ?? true, bubbles: true });
  Object.defineProperties(e, {
    pointerId: { value: id },
    clientX: { value: x },
    clientY: { value: y },
    pointerType: { value: o.pointerType ?? 'touch' },
    button: { value: o.button ?? 0 },
    buttons: { value: o.buttons ?? 1 },
  });
  if (o.target !== undefined) Object.defineProperty(e, 'target', { value: o.target });
  return e;
}

function te(type: string, touches: number, cancelable = true): Event {
  const e = new Event(type, { cancelable, bubbles: true });
  Object.defineProperty(e, 'touches', { value: { length: touches } });
  return e;
}

interface Dom {
  el: FakeEl;
  win: FakeWin;
  doc: FakeDoc;
  pm: PointerManager;
  changes: number[];
  downs: [number, number, number][];
  t: { now: number };
  down(id: number, x: number, y: number, o?: PeInit): Event;
  move(id: number, x: number, y: number, o?: PeInit): Event;
  up(id: number, x: number, y: number, o?: PeInit): Event;
  cancel(id: number): Event;
}

function dom(controls: TouchControl[], held?: () => number): Dom {
  const el = new FakeEl();
  const win = new FakeWin();
  const doc = new FakeDoc();
  const changes: number[] = [];
  const downs: [number, number, number][] = [];
  const t = { now: 1000 };
  const pm = createPointerManager({
    el: el as unknown as HTMLElement,
    controls,
    onChange: () => { changes.push(held ? held() : 0); },
    onDown: (x, y, owner) => { downs.push([x, y, owner]); },
    now: () => t.now,
    win: win as unknown as Window,
    doc: doc as unknown as Document,
  });
  const send = (type: string) => (id: number, x: number, y: number, o: PeInit = {}): Event => {
    const e = pe(type, id, x, y, o);
    el.dispatchEvent(e);
    return e;
  };
  return {
    el, win, doc, pm, changes, downs, t,
    down: send('pointerdown'),
    move: send('pointermove'),
    up: (id, x, y, o = {}) => send('pointerup')(id, x, y, { buttons: 0, ...o }),
    cancel: (id) => send('pointercancel')(id, 0, 0, { buttons: 0 }),
  };
}

// ================================================================== pure core

describe('TCH-01 pointer router (pure core)', () => {
  it('pointerKindOf maps pointerType (unknown and empty count as touch)', () => {
    expect(pointerKindOf('touch')).toBe(PointerKind.TOUCH);
    expect(pointerKindOf('pen')).toBe(PointerKind.PEN);
    expect(pointerKindOf('mouse')).toBe(PointerKind.MOUSE);
    expect(pointerKindOf('')).toBe(PointerKind.TOUCH);
  });

  it('routes by zone priority: buttons > stick zone (left half) > pitch gestures (everything else)', () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    expect(r.down(1, 1060, 740, 0)).toBe(0); // on the button
    expect(r.down(2, 200, 600, 0)).toBe(1); // left half
    expect(r.down(3, 800, 300, 0)).toBe(2); // right half, off the cluster
    expect(log).toEqual(['btn.down#1', 'stick.down#2', 'gest.down#3']);
    expect(r.active).toBe(3);
    expect([r.ownerOf(1), r.ownerOf(2), r.ownerOf(3), r.ownerOf(4)]).toEqual([0, 1, 2, -1]);
    // A button inside the stick zone (mirrored layout) still wins over the stick: buttons come first.
    const log2: string[] = [];
    const r2 = createPointerRouter([rec('btn', log2, (x, y) => (x - 120) ** 2 + (y - 740) ** 2 <= 56 * 56), rec('stick', log2, inStick), rec('gest', log2, () => true)]);
    expect(r2.down(7, 120, 740, 0)).toBe(0);
    expect(r2.down(8, 300, 740, 0)).toBe(1);
  });

  it('routing happens once, at down: a pointer stays with its control wherever it moves', () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    r.down(1, 200, 600, 0); // stick
    r.move(1, 1060, 740, 1); // slides over the button
    r.move(1, 800, 200, 2); // and over the pitch
    r.up(1, 800, 200, 3);
    expect(log).toEqual(['stick.down#1', 'stick.move#1', 'stick.move#1', 'stick.up#1']);
    expect(r.active).toBe(0);
  });

  it('a pointer nothing claims is not tracked: its moves and up are ignored', () => {
    const log: string[] = [];
    const r = createPointerRouter([rec('btn', log, inButton)]);
    expect(r.down(1, 10, 10, 0)).toBe(-1);
    expect(r.move(1, 20, 20, 1)).toBe(false);
    expect(r.up(1, 20, 20, 2)).toBe(false);
    expect(r.cancel(1, 2)).toBe(false);
    expect(r.active).toBe(0);
    expect(log).toEqual([]);
  });

  it('cancel releases only that pointer\'s control', () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    r.down(1, 1060, 740, 0);
    r.down(2, 200, 600, 0);
    expect(r.cancel(1, 5)).toBe(true);
    expect(r.cancel(1, 6)).toBe(false); // second cancel of the same pointer is a no-op
    r.move(2, 220, 600, 7);
    expect(log).toEqual(['btn.down#1', 'stick.down#2', 'btn.cancel#1', 'stick.move#2']);
    expect(r.active).toBe(1);
  });

  it('releaseAll cancels every tracked pointer, then releaseAll on every control; those fingers are ignored afterwards', () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    r.down(1, 1060, 740, 0);
    r.down(2, 200, 600, 0);
    expect(r.releaseAll(9)).toBe(2);
    expect(log.slice(2)).toEqual(['btn.cancel#1', 'stick.cancel#2', 'btn.releaseAll', 'stick.releaseAll', 'gest.releaseAll']);
    expect(r.active).toBe(0);
    log.length = 0;
    expect(r.move(2, 300, 600, 10)).toBe(false);
    expect(r.up(1, 1060, 740, 11)).toBe(false);
    expect(log).toEqual([]);
  });

  it(`a full table (${MAX_POINTERS} pointers) ignores further pointers until one lifts`, () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    for (let i = 0; i < MAX_POINTERS; i++) expect(r.down(100 + i, 800, 100 + i, 0)).toBe(2);
    expect(r.down(999, 200, 600, 0)).toBe(-1);
    expect(r.active).toBe(MAX_POINTERS);
    expect(log).not.toContain('stick.down#999');
    r.up(103, 0, 0, 1);
    expect(r.down(999, 200, 600, 2)).toBe(1);
    expect(r.active).toBe(MAX_POINTERS);
  });

  it('a reused pointer id whose up was lost cancels the stale entry and is routed afresh', () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    r.down(5, 1060, 740, 0); // button; its pointerup never arrives
    expect(r.down(5, 200, 600, 1)).toBe(1); // same id lands on the stick
    expect(log).toEqual(['btn.down#5', 'btn.cancel#5', 'stick.down#5']);
    expect(r.active).toBe(1);
  });

  it('a control that calls releaseAll from up (PAUSE) sees no pointer twice', () => {
    const log: string[] = [];
    const ctls: TouchControl[] = [];
    const r = createPointerRouter(ctls);
    ctls.push({ ...rec('pause', log, (x, y) => x > 1100 && y < 100), up: (id) => { log.push(`pause.up#${id}`); r.releaseAll(5); } });
    ctls.push(rec('stick', log, inStick));
    r.down(1, 200, 600, 0);
    r.down(2, 1130, 50, 1);
    r.up(2, 1130, 50, 2);
    expect(log).toEqual(['stick.down#1', 'pause.down#2', 'pause.up#2', 'stick.cancel#1', 'pause.releaseAll', 'stick.releaseAll']);
    expect(r.active).toBe(0);
    // A control whose releaseAll re-enters releaseAll does not recurse forever.
    const log2: string[] = [];
    const ctls2: TouchControl[] = [];
    const r2 = createPointerRouter(ctls2);
    ctls2.push({ ...rec('loop', log2, () => true), releaseAll: () => { log2.push('loop.releaseAll'); r2.releaseAll(1); } });
    r2.down(1, 0, 0, 0);
    expect(r2.releaseAll(1)).toBe(1);
    expect(log2).toEqual(['loop.down#1', 'loop.cancel#1', 'loop.releaseAll']);
  });

  it('a control that throws while being released does not leave the others held (first error is rethrown)', () => {
    const { log, controls } = recRig();
    const boom: TouchControl = { ...controls[0]!, cancel: () => { throw new Error('boom cancel'); }, releaseAll: () => { throw new Error('boom all'); } };
    const r = createPointerRouter([boom, controls[1]!, controls[2]!]);
    r.down(1, 1060, 740, 0);
    r.down(2, 200, 600, 0);
    r.down(3, 800, 300, 0);
    expect(() => r.releaseAll(4)).toThrow('boom cancel');
    expect(r.active).toBe(0);
    expect(log).toContain('stick.cancel#2');
    expect(log).toContain('gest.cancel#3');
    expect(log).toContain('stick.releaseAll');
    expect(log).toContain('gest.releaseAll');
  });

  it('cancelKind cancels only pointers of that kind that went down at or before maxSeq', () => {
    const { log, controls } = recRig();
    const r = createPointerRouter(controls);
    r.down(1, 200, 600, 0, PointerKind.TOUCH);
    r.down(2, 800, 300, 0, PointerKind.MOUSE);
    const seq = r.seq;
    r.down(3, 1060, 740, 0, PointerKind.TOUCH);
    expect(r.countKind(PointerKind.TOUCH)).toBe(2);
    expect(r.cancelKind(PointerKind.TOUCH, 1, seq)).toBe(1);
    expect(log.slice(3)).toEqual(['stick.cancel#1']);
    expect([r.ownerOf(1), r.ownerOf(2), r.ownerOf(3)]).toEqual([-1, 2, 0]);
    expect(r.kindAt(0)).toBe(PointerKind.TOUCH);
    expect(r.usedAt(0)).toBe(false);
  });

  it('five simultaneous pointers each drive their own control and lift in any order (real stick and buttons)', () => {
    const g = realRig();
    const r = createPointerRouter(g.controls);
    r.down(11, 200, 600, 0); // stick
    r.down(12, 1084, 748, 0); // SPRINT
    r.down(13, 930, 748, 0); // PASS
    r.down(14, 1084, 610, 0); // SHOOT
    r.down(15, 800, 300, 0); // pitch gesture
    expect(r.active).toBe(5);
    expect(g.state.held).toBe(bit(TouchButtonId.SPRINT_SKILL) | bit(TouchButtonId.PASS) | bit(TouchButtonId.SHOOT));
    r.move(11, 260, 600, 1);
    expect(g.state.stickActive).toBe(true);
    expect(g.state.stickX).toBeGreaterThan(0.5);
    // Lift PASS, then the stick, then the gesture, then SPRINT, then SHOOT; the others stay as they were each time.
    r.up(13, 930, 748, 2);
    expect(g.state.held).toBe(bit(TouchButtonId.SPRINT_SKILL) | bit(TouchButtonId.SHOOT));
    expect(g.state.stickActive).toBe(true);
    r.up(11, 260, 600, 3);
    expect(g.state.stickActive).toBe(false);
    expect(g.state.held).toBe(bit(TouchButtonId.SPRINT_SKILL) | bit(TouchButtonId.SHOOT));
    r.up(15, 800, 300, 4);
    expect(g.gestLog).toEqual(['gest.down#15', 'gest.up#15']);
    r.up(12, 1084, 748, 5);
    expect(g.state.held).toBe(bit(TouchButtonId.SHOOT));
    r.up(14, 1084, 610, 6);
    expect(g.state.held).toBe(0);
    expect(r.active).toBe(0);
  });

  it('a thumb that slides off a held button keeps the hold until it lifts', () => {
    const g = realRig();
    const r = createPointerRouter(g.controls);
    r.down(1, 1084, 748, 0);
    for (let i = 1; i <= 10; i++) r.move(1, 1084 - i * 60, 748 - i * 30, i * 16); // far off the button, over the pitch
    expect(g.state.held & bit(TouchButtonId.SPRINT_SKILL)).not.toBe(0);
    expect(heldToButtons(g.state.held) & Btn.SPRINT).not.toBe(0);
    expect(g.gestLog).toEqual([]);
    r.up(1, 484, 448, 400);
    expect(g.state.held).toBe(0);
  });

  it('stick, buttons and gestures never steal each other\'s touches', () => {
    const g = realRig();
    const r = createPointerRouter(g.controls);
    r.down(1, 200, 600, 0); // stick
    r.move(1, 250, 600, 1);
    const sx = g.state.stickX, ox = g.state.stickOriginX;
    // A second finger in the stick zone does not take the stick over.
    r.down(2, 400, 300, 2);
    r.move(2, 300, 200, 3);
    expect(g.state.stickX).toBe(sx);
    expect(g.state.stickOriginX).toBe(ox);
    // A gesture finger that slides into the stick zone and over the cluster stays a gesture.
    r.down(3, 800, 300, 4);
    r.move(3, 200, 600, 5);
    r.move(3, 1084, 748, 6);
    expect(g.state.stickX).toBe(sx);
    expect(g.state.held).toBe(0);
    // A button finger sliding over the stick zone stays the button.
    r.down(4, 930, 748, 7);
    r.move(4, 100, 700, 8);
    expect(g.state.stickX).toBe(sx);
    expect(g.state.held).toBe(bit(TouchButtonId.PASS));
    // The stick finger sliding over the cluster stays the stick (and presses nothing).
    r.move(1, 1084, 748, 9);
    expect(g.state.held).toBe(bit(TouchButtonId.PASS));
    expect(g.gestLog).toEqual(['gest.down#3', 'gest.move#3', 'gest.move#3']);
    // Lifting the second stick-zone finger leaves the stick driven by the first.
    r.up(2, 300, 200, 10);
    expect(g.state.stickActive).toBe(true);
  });

  it('no allocation per routed event (child process with --expose-gc; the probe detects a control that allocates)', () => {
    const script = `
      import { createPointerRouter } from ${JSON.stringify(new URL('../../src/input/touch/pointers.ts', import.meta.url).pathname)};
      const sink = [];
      const noop = () => {};
      const alloc = (id) => { sink[id & 7] = { id }; };
      const mk = (lo, hi, move) => ({ hit: (x) => x >= lo && x < hi, down: noop, move, up: noop, cancel: noop, releaseAll: noop });
      function probe(move) {
        const r = createPointerRouter([mk(0, 100, move), mk(100, 200, move), mk(200, 300, move), mk(300, 400, move), mk(400, 500, move)]);
        const cycle = (base) => {
          for (let p = 0; p < 5; p++) r.down(base + p, p * 100 + 5, 10, 0, 0);
          for (let m = 0; m < 4; m++) for (let p = 0; p < 5; p++) r.move(base + p, p * 100 + 5 + m, 10, 1);
          for (let p = 0; p < 4; p++) r.up(base + p, 0, 0, 2);
          r.cancel(base + 4, 3);
          if ((base & 1023) === 0) r.releaseAll(4);
        };
        for (let i = 0; i < 20000; i++) cycle(i * 5);
        globalThis.gc();
        const h0 = process.memoryUsage().heapUsed;
        const n = 20000;
        for (let i = 0; i < n; i++) cycle(1e6 + i * 5);
        return (process.memoryUsage().heapUsed - h0) / (n * 30);
      }
      console.log(JSON.stringify({ clean: probe(noop), allocating: probe(alloc) }));
    `;
    const out = execFileSync(process.execPath, ['--expose-gc', '--min-semi-space-size=64', '--max-semi-space-size=64', '--import', 'tsx', '--input-type=module', '-e', script], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const res = JSON.parse(out.trim().split('\n').pop()!) as { clean: number; allocating: number };
    // Sanity: the probe sees a control that allocates one small object per move (a fixed 64 MB new space keeps the
    // scavenger from hiding garbage during the measured loop).
    expect(res.allocating).toBeGreaterThan(4);
    expect(res.clean).toBeLessThan(0.5);
  });
});

// ================================================================== DOM binding

describe('TCH-01 pointer manager (DOM binding)', () => {
  it('touch-down reaches its control synchronously with capture and onChange (pressed state within one frame)', () => {
    const g = realRig();
    const d = dom(g.controls, () => g.state.held);
    const e = d.down(7, 1084, 748);
    expect(e.defaultPrevented).toBe(true);
    expect(g.state.held).toBe(bit(TouchButtonId.SPRINT_SKILL));
    expect(d.changes).toEqual([bit(TouchButtonId.SPRINT_SKILL)]); // onChange already sees the pressed bit
    expect(d.el.captured).toEqual([7]);
    expect(d.pm.active).toBe(1);
    expect(d.pm.ownerOf(7)).toBe(3);
    expect(g.state.downAt[TouchButtonId.SPRINT_SKILL]).toBe(1000); // the injected clock
    d.up(7, 1084, 748);
    expect(g.state.held).toBe(0);
    expect(d.changes.length).toBe(2);
    expect(d.pm.active).toBe(0);
  });

  it('five simultaneous touches work through the DOM binding', () => {
    const g = realRig();
    const d = dom(g.controls);
    d.down(11, 200, 600); d.down(12, 1084, 748); d.down(13, 930, 748); d.down(14, 1084, 610); d.down(15, 800, 300);
    expect(d.pm.active).toBe(5);
    expect([...d.el.captured].sort()).toEqual([11, 12, 13, 14, 15]);
    d.move(11, 140, 600);
    expect(g.state.stickX).toBeLessThan(-0.5);
    expect(g.state.held).toBe(bit(TouchButtonId.SPRINT_SKILL) | bit(TouchButtonId.PASS) | bit(TouchButtonId.SHOOT));
    for (const id of [14, 11, 15, 13, 12]) d.up(id, 0, 0);
    expect(g.state.held).toBe(0);
    expect(g.state.stickActive).toBe(false);
    expect(d.pm.active).toBe(0);
  });

  it('ignores mouse (and pen) buttons other than the primary one', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 200, 600, { pointerType: 'mouse', button: 2, buttons: 2 });
    d.down(1, 200, 600, { pointerType: 'mouse', button: 1, buttons: 4 });
    d.down(9, 200, 600, { pointerType: 'pen', button: 5, buttons: 32 });
    expect(log).toEqual([]);
    expect(d.downs).toEqual([]);
    d.down(1, 200, 600, { pointerType: 'mouse', button: 0, buttons: 1 });
    expect(log).toEqual(['stick.down#1']);
    expect(d.downs).toEqual([[200, 600, 1]]);
  });

  it('a mouse whose primary button is released while another is still down counts as lifted', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 1060, 740, { pointerType: 'mouse', button: 0, buttons: 1 });
    d.move(1, 1062, 740, { pointerType: 'mouse', button: -1, buttons: 1 });
    d.move(1, 1062, 740, { pointerType: 'mouse', button: 2, buttons: 3 }); // right pressed too (chorded)
    d.move(1, 1062, 740, { pointerType: 'mouse', button: 0, buttons: 2 }); // left released, right still down
    d.up(1, 1062, 740, { pointerType: 'mouse', button: 2, buttons: 0 });
    expect(log).toEqual(['btn.down#1', 'btn.move#1', 'btn.move#1', 'btn.up#1']);
    expect(d.pm.active).toBe(0);
    expect(d.el.captured).toEqual([]);
    // Hover moves (no button) of an untracked mouse do nothing.
    d.move(1, 100, 100, { pointerType: 'mouse', buttons: 0 });
    expect(log.length).toBe(4);
  });

  it('pointercancel releases only that pointer\'s control', () => {
    const g = realRig();
    const d = dom(g.controls);
    d.down(1, 200, 600); d.move(1, 260, 600);
    d.down(2, 1084, 748);
    d.cancel(2);
    expect(g.state.held).toBe(0);
    expect(edgesOf(g.state, TouchButtonId.SPRINT_SKILL)).toEqual([TouchEdge.DOWN, TouchEdge.CANCEL]);
    expect(g.state.stickActive).toBe(true);
    d.move(1, 140, 600);
    expect(g.state.stickX).toBeLessThan(0);
    expect(d.pm.active).toBe(1);
  });

  it('capture loss releases that pointer; a bubbled lostpointercapture or one after pointerup is a no-op', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 1060, 740);
    d.down(2, 200, 600);
    // Bubbled from a child element of the layer: not ours.
    d.el.dispatchEvent(pe('lostpointercapture', 1, 0, 0, { target: new EventTarget() }));
    expect(d.pm.active).toBe(2);
    // The layer itself lost capture of pointer 1 (e.g. capture moved elsewhere): release without action.
    d.el.dispatchEvent(pe('lostpointercapture', 1));
    expect(log).toEqual(['btn.down#1', 'stick.down#2', 'btn.cancel#1']);
    // Normal lift: pointerup then the implicit lostpointercapture.
    d.up(2, 200, 600);
    d.el.dispatchEvent(pe('lostpointercapture', 2));
    expect(log).toEqual(['btn.down#1', 'stick.down#2', 'btn.cancel#1', 'stick.up#2']);
    expect(d.pm.active).toBe(0);
  });

  it('window blur releases every held input', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 1060, 740); d.down(2, 200, 600); d.down(3, 800, 300);
    d.win.dispatchEvent(new Event('blur'));
    expect(log.slice(3)).toEqual(['btn.cancel#1', 'stick.cancel#2', 'gest.cancel#3', 'btn.releaseAll', 'stick.releaseAll', 'gest.releaseAll']);
    expect(d.pm.active).toBe(0);
    expect(d.el.captured).toEqual([]); // captures dropped (the synchronous lostpointercapture found nothing to cancel)
    d.move(2, 300, 600); d.up(2, 300, 600);
    expect(log.length).toBe(9);
  });

  it('visibilitychange to hidden releases everything; back to visible does not', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 200, 600);
    d.doc.dispatchEvent(new Event('visibilitychange'));
    expect(d.pm.active).toBe(1);
    d.doc.visibilityState = 'hidden';
    d.doc.dispatchEvent(new Event('visibilitychange'));
    expect(d.pm.active).toBe(0);
    expect(log).toContain('stick.cancel#1');
  });

  it.each([
    ['pagehide', (d: Dom) => { d.win.dispatchEvent(new Event('pagehide')); }],
    ['orientationchange', (d: Dom) => { d.win.dispatchEvent(new Event('orientationchange')); }],
    ['screen.orientation change', (d: Dom) => { d.win.screen.orientation.dispatchEvent(new Event('change')); }],
    ['resize mid-hold', (d: Dom) => { d.win.innerWidth = 1024; d.win.innerHeight = 768; d.win.dispatchEvent(new Event('resize')); }],
  ])('%s releases every held input', (_name, fire) => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 1060, 740); d.down(2, 200, 600);
    fire(d);
    expect(d.pm.active).toBe(0);
    expect(log.slice(2)).toEqual(['btn.cancel#1', 'stick.cancel#2', 'btn.releaseAll', 'stick.releaseAll', 'gest.releaseAll']);
  });

  it('a resize event without a size change keeps the hold', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 200, 600);
    d.win.dispatchEvent(new Event('resize'));
    expect(d.pm.active).toBe(1);
    expect(log).toEqual(['stick.down#1']);
  });

  it('prevents default on the game surface: no scroll, zoom, selection, drag, callout or long-press menu', () => {
    const { controls } = recRig();
    const d = dom(controls);
    expect(d.down(1, 200, 600).defaultPrevented).toBe(true);
    expect(d.down(2, 10, 10, { pointerType: 'mouse', button: 2 }).defaultPrevented).toBe(true);
    for (const type of ['touchstart', 'touchmove']) {
      const e = te(type, 1);
      d.el.dispatchEvent(e);
      expect(e.defaultPrevented, type).toBe(true); // also proves the listener is not passive
    }
    const end = te('touchend', 1);
    d.el.dispatchEvent(end);
    expect(end.defaultPrevented).toBe(true); // no emulated mouse events / ghost click into a menu that just opened
    for (const type of ['contextmenu', 'selectstart', 'dragstart', 'dblclick', 'wheel', 'gesturestart', 'gesturechange', 'gestureend']) {
      const e = new Event(type, { cancelable: true, bubbles: true });
      d.el.dispatchEvent(e);
      expect(e.defaultPrevented, type).toBe(true);
    }
    const tc = te('touchcancel', 0, false); // not cancelable: no throw, nothing prevented
    expect(() => d.el.dispatchEvent(tc)).not.toThrow();
    expect(tc.defaultPrevented).toBe(false);
  });

  it('touchend with no finger left cancels touch pointers whose pointerup never came, after the event batch', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 200, 600); // its pointerup will be lost
    d.down(2, 1060, 740);
    d.down(3, 800, 300, { pointerType: 'mouse', button: 0 });
    d.up(2, 1060, 740);
    // Some fingers still on the screen: no sweep.
    d.el.dispatchEvent(te('touchend', 1));
    expect(d.win.pendingTimers).toBe(0);
    d.el.dispatchEvent(te('touchend', 0));
    expect(d.win.pendingTimers).toBe(1);
    expect(d.pm.active).toBe(2); // not synchronously: a pointerup later in the same batch still lands as a lift
    d.down(4, 210, 610); // a new finger lands before the sweep runs: it must survive
    d.win.flush();
    expect(log).toEqual(['stick.down#1', 'btn.down#2', 'gest.down#3', 'btn.up#2', 'stick.down#4', 'stick.cancel#1']);
    expect([d.pm.ownerOf(1), d.pm.ownerOf(3), d.pm.ownerOf(4)]).toEqual([-1, 2, 1]);
    // Nothing stale: the sweep is not even scheduled.
    d.up(4, 0, 0);
    d.el.dispatchEvent(te('touchcancel', 0, false));
    expect(d.win.pendingTimers).toBe(0);
  });

  it('a normal last lift leaves nothing for the sweep, and releaseAll clears a pending sweep', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 200, 600);
    d.up(1, 200, 600);
    d.el.dispatchEvent(te('touchend', 0));
    expect(d.win.pendingTimers).toBe(0);
    d.down(2, 200, 600);
    d.el.dispatchEvent(te('touchend', 0));
    expect(d.win.pendingTimers).toBe(1);
    d.pm.releaseAll();
    expect(d.win.pendingTimers).toBe(0);
    expect(log).toEqual(['stick.down#1', 'stick.up#1', 'stick.down#2', 'stick.cancel#2', 'btn.releaseAll', 'stick.releaseAll', 'gest.releaseAll']);
  });

  it('works with a bare window (no timers, no size): the sweep uses the global timer, any resize releases', async () => {
    const { log, controls } = recRig();
    const el = new FakeEl();
    const win = new EventTarget();
    const pm = createPointerManager({
      el: el as unknown as HTMLElement, controls, now: () => 0,
      win: win as unknown as Window, doc: new FakeDoc() as unknown as Document,
    });
    el.dispatchEvent(pe('pointerdown', 1, 200, 600));
    el.dispatchEvent(te('touchend', 0));
    expect(pm.active).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(pm.active).toBe(0);
    el.dispatchEvent(pe('pointerdown', 2, 1060, 740));
    win.dispatchEvent(new Event('resize'));
    expect(pm.active).toBe(0);
    expect(log).toEqual(['stick.down#1', 'stick.cancel#1', 'btn.down#2', 'btn.cancel#2', 'btn.releaseAll', 'stick.releaseAll', 'gest.releaseAll']);
    pm.dispose();
  });

  it('onDown reports every primary pointerdown with its owner (-1 when nothing claims it)', () => {
    const log: string[] = [];
    const d = dom([rec('btn', log, inButton)]);
    d.down(1, 1060, 740);
    d.down(2, 10, 10);
    expect(d.downs).toEqual([[1060, 740, 0], [10, 10, -1]]);
    expect(d.el.captured).toEqual([1]); // unclaimed pointers are not captured
    expect(d.changes.length).toBe(1);
  });

  it('a pointer id reused after a lost pointerup is re-routed (no dead finger)', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(5, 1060, 740);
    d.down(5, 200, 600);
    expect(log).toEqual(['btn.down#5', 'btn.cancel#5', 'stick.down#5']);
    expect(d.pm.ownerOf(5)).toBe(1);
    expect(d.pm.active).toBe(1);
  });

  it('dispose releases everything and detaches every listener', () => {
    const { log, controls } = recRig();
    const d = dom(controls);
    d.down(1, 200, 600);
    d.el.dispatchEvent(te('touchend', 0));
    d.pm.dispose();
    expect(log).toEqual(['stick.down#1', 'stick.cancel#1', 'btn.releaseAll', 'stick.releaseAll', 'gest.releaseAll']);
    expect(d.win.pendingTimers).toBe(0);
    d.pm.dispose(); // idempotent
    d.pm.releaseAll(); // no-op after dispose
    d.down(2, 200, 600);
    d.win.dispatchEvent(new Event('blur'));
    d.win.innerWidth = 900; d.win.dispatchEvent(new Event('resize'));
    d.doc.visibilityState = 'hidden'; d.doc.dispatchEvent(new Event('visibilitychange'));
    const e = te('touchmove', 1);
    d.el.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(log.length).toBe(5);
    expect(d.pm.active).toBe(0);
  });
});

// ================================================================== glitch list (section 14) regressions

describe('TCH-01 glitch regressions', () => {
  it('glitch: stuck sprint or stick after pointercancel', () => {
    const g = realRig();
    const d = dom(g.controls);
    d.down(1, 200, 600); d.move(1, 270, 560); // stick deflected
    d.down(2, 1084, 748); // sprint held
    expect(heldToButtons(g.state.held) & Btn.SPRINT).not.toBe(0);
    expect(g.state.stickActive).toBe(true);
    // iPadOS multitasking gesture: both touches cancelled mid-hold.
    d.cancel(1);
    d.cancel(2);
    expect(g.state.held).toBe(0);
    expect(heldToButtons(g.state.held) & Btn.SPRINT).toBe(0);
    expect(g.state.stickActive).toBe(false);
    expect(Math.abs(g.state.stickX) + Math.abs(g.state.stickY)).toBe(0);
    expect(edgesOf(g.state, TouchButtonId.SPRINT_SKILL)).not.toContain(TouchEdge.TAP);
    // The cancelled fingers keep moving / lift later: nothing comes back.
    d.move(1, 300, 600); d.move(2, 1000, 700); d.up(1, 300, 600); d.up(2, 1000, 700);
    expect(g.state.held).toBe(0);
    expect(g.state.stickActive).toBe(false);
    expect(d.pm.active).toBe(0);
    // New touches work normally afterwards.
    d.down(3, 1084, 748);
    expect(g.state.held).toBe(bit(TouchButtonId.SPRINT_SKILL));
    d.up(3, 1084, 748);
    expect(g.state.held).toBe(0);
  });

  it.each([
    ['blur', (d: Dom) => { d.win.dispatchEvent(new Event('blur')); }],
    ['visibilitychange hidden', (d: Dom) => { d.doc.visibilityState = 'hidden'; d.doc.dispatchEvent(new Event('visibilitychange')); }],
    ['pagehide', (d: Dom) => { d.win.dispatchEvent(new Event('pagehide')); }],
    ['orientationchange', (d: Dom) => { d.win.dispatchEvent(new Event('orientationchange')); }],
    ['resize', (d: Dom) => { d.win.innerWidth = 1366; d.win.dispatchEvent(new Event('resize')); }],
    ['lost capture', (d: Dom) => { d.el.dispatchEvent(pe('lostpointercapture', 1)); d.el.dispatchEvent(pe('lostpointercapture', 2)); }],
    ['lost pointerup (touchend with no finger left)', (d: Dom) => { d.el.dispatchEvent(te('touchend', 0)); d.win.flush(); }],
  ])('glitch: stuck sprint or stick after %s mid-hold', (_name, fire) => {
    const g = realRig();
    const d = dom(g.controls);
    d.down(1, 200, 600); d.move(1, 200, 520);
    d.down(2, 1084, 748);
    expect(g.state.stickY).toBeLessThan(-0.5);
    fire(d);
    expect(heldToButtons(g.state.held) & Btn.SPRINT).toBe(0);
    expect(g.state.held).toBe(0);
    expect(g.state.stickActive).toBe(false);
    expect(Math.abs(g.state.stickX) + Math.abs(g.state.stickY)).toBe(0);
    expect(edgesOf(g.state, TouchButtonId.SPRINT_SKILL)).toEqual([TouchEdge.DOWN, TouchEdge.CANCEL]);
    d.move(1, 200, 450);
    expect(g.state.stickActive).toBe(false);
  });

  it('glitch: button swipe read as a pitch gesture', () => {
    const g = realRig();
    const d = dom(g.controls);
    // A swipe that starts on PASS and travels far across the pitch (and the stick zone) before lifting.
    d.down(1, 930, 748);
    for (let i = 1; i <= 12; i++) d.move(1, 930 - i * 50, 748 - i * 40);
    d.up(1, 330, 268);
    expect(g.gestLog).toEqual([]);
    expect(g.state.stickActive).toBe(false);
    expect(edgesOf(g.state, TouchButtonId.PASS)).toContain(TouchEdge.SWIPE);
    // A swipe starting on the pitch is a gesture, even when it ends on a button.
    d.down(2, 800, 300);
    d.move(2, 930, 748);
    d.up(2, 930, 748);
    expect(g.gestLog).toEqual(['gest.down#2', 'gest.move#2', 'gest.up#2']);
    expect(g.state.held).toBe(0);
  });
});
