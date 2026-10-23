/**
 * [QF-7R] A minimal DOM stand-in for driving the in-match HUD in Node (no DOM library in this project): elements with
 * attributes, dataset, style, classList and children; text nodes; canvases whose 2D context is a stub; document,
 * window and getComputedStyle globals. Used by tests/unit/qf-7r-hud-alloc-probe.ts (allocation, child process) and
 * tests/unit/qf-7r-radar.test.ts (what the radar draws).
 *
 * `neverOptimize` (the probe passes V8's %NeverOptimizeFunction) keeps every stand-in method out of the optimiser, as
 * the browser's bindings are out of reach of the JIT: a fractional number the HUD passes them is boxed by the caller.
 * `record`: canvas contexts log their calls (name and arguments) in `calls` (tests only: logging allocates).
 */
export interface CanvasCall {
  name: string;
  args: unknown[];
}

export interface FakeCanvasContext extends Record<string, unknown> {
  readonly calls: CanvasCall[];
  readonly canvas: unknown;
}

export interface FakeDom {
  /** A detached root element to mount HUD parts into. */
  readonly root: FakeElement;
  /** Every canvas created (in creation order). */
  readonly canvases: FakeElement[];
  uninstall(): void;
}

export interface FakeElement {
  tagName: string;
  width: number;
  height: number;
  hidden: boolean;
  dataset: Record<string, string>;
  childNodes: unknown[];
  getAttribute(k: string): string | null;
  getContext(kind: string): FakeCanvasContext | null;
}

const CANVAS_METHODS = ['setTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc',
  'fill', 'stroke', 'drawImage', 'save', 'restore', 'translate', 'scale', 'rotate', 'fillText', 'strokeText', 'rect', 'ellipse'];

export function installFakeDom(opts: { neverOptimize?: (f: unknown) => void; record?: boolean } = {}): FakeDom {
  const nat = opts.neverOptimize ?? ((): void => {});
  const record = opts.record === true;
  const noop = (): void => {};
  const canvases: FakeElement[] = [];

  const makeContext = (canvas: unknown): FakeCanvasContext => {
    const calls: CanvasCall[] = [];
    const c: Record<string, unknown> = { calls, canvas, lineWidth: 1, fillStyle: '', strokeStyle: '', globalAlpha: 1, font: '', textAlign: '', textBaseline: '' };
    for (const m of CANVAS_METHODS) {
      const f = record
        ? function (this: unknown, ...args: unknown[]): void { calls.push({ name: m, args }); }
        : function (this: unknown): void {};
      nat(f);
      c[m] = f;
    }
    return c as FakeCanvasContext;
  };

  class FakeClassList {
    private readonly set = new Set<string>();
    add(...c: string[]): void { for (const x of c) this.set.add(x); }
    remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
    toggle(c: string, on?: boolean): boolean { const v = on ?? !this.set.has(c); if (v) this.set.add(c); else this.set.delete(c); return v; }
    contains(c: string): boolean { return this.set.has(c); }
  }
  class FakeNode {
    nodeType = 1;
    parentNode: FakeNode | null = null;
    childNodes: FakeNode[] = [];
    nodeValue: string | null = null;
    get children(): FakeNode[] { return this.childNodes; }
    get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
    append(...nodes: (FakeNode | string)[]): void {
      for (const n of nodes) {
        const c = typeof n === 'string' ? new FakeText(n) : n;
        c.parentNode = this;
        this.childNodes.push(c);
      }
    }
    appendChild(n: FakeNode): FakeNode { this.append(n); return n; }
    prepend(...nodes: (FakeNode | string)[]): void { this.append(...nodes); }
    replaceChildren(...nodes: (FakeNode | string)[]): void { this.childNodes = []; this.append(...nodes); }
    insertBefore(n: FakeNode): FakeNode { this.append(n); return n; }
    removeChild(n: FakeNode): FakeNode { this.childNodes = this.childNodes.filter((c) => c !== n); return n; }
    remove(): void { if (this.parentNode) this.parentNode.removeChild(this); this.parentNode = null; }
    get textContent(): string { return this.nodeValue ?? this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v: string) { this.childNodes = []; if (v !== '') this.append(v); }
  }
  class FakeText extends FakeNode {
    constructor(v: string) { super(); this.nodeType = 3; this.nodeValue = v; }
    get data(): string { return this.nodeValue ?? ''; }
  }
  class FakeEl extends FakeNode {
    className = '';
    id = '';
    hidden = false;
    width = 300;
    height = 150;
    readonly dataset: Record<string, string> = {};
    readonly style: Record<string, unknown> = { cssText: '', transform: '', setProperty: noop, removeProperty: noop, getPropertyValue: () => '' };
    readonly classList = new FakeClassList();
    private readonly attrs = new Map<string, string>();
    private ctx: FakeCanvasContext | null = null;
    constructor(readonly tagName: string) { super(); }
    setAttribute(k: string, v: string): void { this.attrs.set(k, String(v)); }
    getAttribute(k: string): string | null { return this.attrs.get(k) ?? null; }
    removeAttribute(k: string): void { this.attrs.delete(k); }
    hasAttribute(k: string): boolean { return this.attrs.has(k); }
    toggleAttribute(k: string, on?: boolean): boolean { const v = on ?? !this.attrs.has(k); if (v) this.attrs.set(k, ''); else this.attrs.delete(k); return v; }
    addEventListener(): void {}
    removeEventListener(): void {}
    querySelector(): null { return null; }
    querySelectorAll(): FakeEl[] { return []; }
    closest(): null { return null; }
    getBoundingClientRect(): Record<string, number> { return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 40, width: 100, height: 40 }; }
    getContext(kind: string): FakeCanvasContext | null {
      if (kind !== '2d' || this.tagName !== 'canvas') return null;
      if (!this.ctx) this.ctx = makeContext(this);
      return this.ctx;
    }
    set innerHTML(_v: string) { this.childNodes = []; }
  }
  for (const C of [FakeNode.prototype, FakeEl.prototype, FakeText.prototype, FakeClassList.prototype]) {
    for (const k of Object.getOwnPropertyNames(C)) {
      if (k === 'constructor') continue;
      const d = Object.getOwnPropertyDescriptor(C, k)!;
      if (typeof d.value === 'function') nat(d.value);
      if (d.get) nat(d.get);
      if (d.set) nat(d.set);
    }
  }
  const head = new FakeEl('head');
  const body = new FakeEl('body');
  const documentElement = new FakeEl('html');
  const byId = new Map<string, FakeEl>();
  const g = globalThis as Record<string, unknown>;
  const saved = { document: g.document, window: g.window, getComputedStyle: g.getComputedStyle };
  g.document = {
    head, body, documentElement,
    createElement: (t: string) => {
      const el = new FakeEl(t);
      if (t === 'canvas') canvases.push(el as unknown as FakeElement);
      return el;
    },
    createTextNode: (v: string) => new FakeText(v),
    getElementById: (id: string) => byId.get(id) ?? null,
    addEventListener: noop, removeEventListener: noop,
    querySelector: () => null,
  };
  head.appendChild = (n: FakeNode): FakeNode => {
    if (n instanceof FakeEl && n.id) byId.set(n.id, n);
    FakeNode.prototype.append.call(head, n);
    return n;
  };
  g.window = {
    innerWidth: 1180, innerHeight: 820, devicePixelRatio: 2, addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  };
  g.getComputedStyle = () => ({ getPropertyValue: () => '' });
  return {
    root: new FakeEl('div') as unknown as FakeElement,
    canvases,
    uninstall() {
      g.document = saved.document;
      g.window = saved.window;
      g.getComputedStyle = saved.getComputedStyle;
    },
  };
}
