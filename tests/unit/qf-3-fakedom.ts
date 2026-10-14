/**
 * [QF-3] A fake window / document / element set with event listeners, just enough to run the REAL touch source
 * (src/input/touch/index.ts createTouchInput: overlay DOM, pointer manager listeners, capture, lifecycle events) in
 * Node. Builds on the TCH-09 fake DOM (tch-09-fakedom.ts) and adds addEventListener / dispatch, pointer capture and a
 * window with size, timers and screen.orientation.
 */
import { FakeDoc, FakeEl } from './tch-09-fakedom';

type Listener = (e: FakeEvent) => void;

export interface FakeEvent {
  type: string;
  target: unknown;
  cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  [k: string]: unknown;
}

export class Emitter {
  private ls: Record<string, Listener[]> = {};
  addEventListener(type: string, fn: Listener): void {
    (this.ls[type] ??= []).push(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    const l = this.ls[type];
    if (!l) return;
    const i = l.indexOf(fn);
    if (i >= 0) l.splice(i, 1);
  }
  listenerCount(type: string): number {
    return this.ls[type]?.length ?? 0;
  }
  dispatch(type: string, fields: Record<string, unknown> = {}): FakeEvent {
    const e: FakeEvent = {
      type, target: this, cancelable: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      ...fields,
    };
    for (const fn of (this.ls[type] ?? []).slice()) fn(e);
    return e;
  }
}

/** An element with listeners and pointer capture. */
export class EvEl extends FakeEl {
  private em = new Emitter();
  captured = new Set<number>();
  addEventListener(type: string, fn: Listener): void { this.em.addEventListener(type, fn); }
  removeEventListener(type: string, fn: Listener): void { this.em.removeEventListener(type, fn); }
  listenerCount(type: string): number { return this.em.listenerCount(type); }
  dispatch(type: string, fields: Record<string, unknown> = {}): FakeEvent {
    return this.em.dispatch(type, { target: this, ...fields });
  }
  setPointerCapture(id: number): void { this.captured.add(id); }
  hasPointerCapture(id: number): boolean { return this.captured.has(id); }
  releasePointerCapture(id: number): void { this.captured.delete(id); }
}

export class FakeWindow extends Emitter {
  innerWidth: number;
  innerHeight: number;
  screen = { orientation: new Emitter() };
  constructor(w: number, h: number) {
    super();
    this.innerWidth = w;
    this.innerHeight = h;
  }
  setTimeout(fn: () => void, ms: number): unknown { return globalThis.setTimeout(fn, ms); }
  clearTimeout(id: unknown): void { globalThis.clearTimeout(id as ReturnType<typeof setTimeout>); }
}

export class EvDoc extends FakeDoc {
  private em = new Emitter();
  visibilityState: 'visible' | 'hidden' = 'visible';
  constructor(readonly defaultView: FakeWindow) { super(); }
  override createElement(tag: string): EvEl { return new EvEl(this, tag); }
  addEventListener(type: string, fn: Listener): void { this.em.addEventListener(type, fn); }
  removeEventListener(type: string, fn: Listener): void { this.em.removeEventListener(type, fn); }
  listenerCount(type: string): number { return this.em.listenerCount(type); }
  dispatch(type: string, fields: Record<string, unknown> = {}): FakeEvent { return this.em.dispatch(type, { target: this, ...fields }); }
}

/** A window + document + root element (the registry's touchRoot). */
export function fakePage(w: number, h: number): { win: FakeWindow; doc: EvDoc; root: EvEl } {
  const win = new FakeWindow(w, h);
  const doc = new EvDoc(win);
  const root = doc.createElement('div');
  return { win, doc, root };
}

/** Depth-first search for the first element carrying a class. */
export function findByClass(root: FakeEl, cls: string): EvEl | null {
  if (root.classList.contains(cls)) return root as EvEl;
  for (const c of root.children) {
    const f = findByClass(c, cls);
    if (f) return f;
  }
  return null;
}
