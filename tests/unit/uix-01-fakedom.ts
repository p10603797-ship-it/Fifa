/**
 * UIX-01 test helper: a small fake DOM for Node (no jsdom). Enough of the DOM for src/ui/components.ts and
 * src/ui/dotfield.ts: an element tree with attributes / dataset / classList / style, bubbling events with capture,
 * stopPropagation and stopImmediatePropagation, a selector engine for the selectors those files use (tag, #id,
 * .class, [attr], [attr="v"], :scope, descendant and child combinators, comma lists), layout rects, pointer capture,
 * a recording 2D canvas context, and a document / window pair.
 */

type Listener = { fn: (e: FakeEvent) => void; capture: boolean; once: boolean };

export class FakeEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  target: FakeNode | null = null;
  currentTarget: FakeNode | null = null;
  defaultPrevented = false;
  propagationStopped = false;
  immediateStopped = false;
  detail: unknown;
  key = '';
  repeat = false;
  pointerId = 1;
  pointerType = 'touch';
  button = 0;
  clientX = 0;
  clientY = 0;
  animationName = '';
  constructor(type: string, init: Partial<FakeEvent> & { bubbles?: boolean; cancelable?: boolean } = {}) {
    this.type = type;
    this.bubbles = init.bubbles ?? true;
    this.cancelable = init.cancelable ?? true;
    Object.assign(this, { ...init, bubbles: this.bubbles, cancelable: this.cancelable });
  }
  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this.propagationStopped = true;
  }
  stopImmediatePropagation(): void {
    this.propagationStopped = true;
    this.immediateStopped = true;
  }
}

export class FakeNode {
  parentNode: FakeElement | null = null;
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean; once?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const once = typeof opts === 'object' && !!opts?.once;
    const l = this.listeners.get(type) ?? [];
    if (l.some((x) => x.fn === fn && x.capture === capture)) return;
    l.push({ fn, capture, once });
    this.listeners.set(type, l);
  }
  removeEventListener(type: string, fn: (e: FakeEvent) => void, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const l = this.listeners.get(type);
    if (!l) return;
    const i = l.findIndex((x) => x.fn === fn && x.capture === capture);
    if (i >= 0) l.splice(i, 1);
  }
  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }
  /** Run this node's listeners for one phase. */
  invoke(e: FakeEvent, capturePhase: boolean | null): void {
    const l = this.listeners.get(e.type);
    if (!l) return;
    e.currentTarget = this;
    for (const x of [...l]) {
      if (capturePhase !== null && x.capture !== capturePhase) continue;
      if (x.once) this.removeEventListener(e.type, x.fn, x.capture);
      x.fn(e);
      if (e.immediateStopped) return;
    }
  }
  /** Path from the outermost ancestor (window) down to this node. */
  path(): FakeNode[] {
    const out: FakeNode[] = [];
    let n: FakeNode | null = this as FakeNode;
    while (n) {
      out.unshift(n);
      n = n.parentNode ?? (n instanceof FakeDocument ? n.defaultView : n instanceof FakeElement && n.tagName === 'HTML' ? n.ownerDocument : null);
    }
    return out;
  }
  dispatchEvent(e: FakeEvent): boolean {
    e.target = this;
    const path = this.path();
    for (let i = 0; i < path.length - 1 && !e.propagationStopped; i++) path[i]!.invoke(e, true);
    if (!e.propagationStopped) this.invoke(e, null);
    if (e.bubbles) for (let i = path.length - 2; i >= 0 && !e.propagationStopped; i--) path[i]!.invoke(e, false);
    return !e.defaultPrevented;
  }
}

class FakeClassList {
  constructor(private readonly el: FakeElement) {}
  private get list(): string[] {
    return (this.el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  }
  private write(l: string[]): void {
    this.el.setAttribute('class', l.join(' '));
  }
  add(...c: string[]): void {
    const l = this.list;
    for (const x of c) if (!l.includes(x)) l.push(x);
    this.write(l);
  }
  remove(...c: string[]): void {
    this.write(this.list.filter((x) => !c.includes(x)));
  }
  contains(c: string): boolean {
    return this.list.includes(c);
  }
  toggle(c: string, on?: boolean): boolean {
    const want = on ?? !this.contains(c);
    if (want) this.add(c); else this.remove(c);
    return want;
  }
}

function kebab(k: string): string {
  return k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

function makeDataset(el: FakeElement): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get: (_t, k) => (typeof k === 'string' ? (el.getAttribute(`data-${kebab(k)}`) ?? undefined) : undefined),
    set: (_t, k, v) => {
      if (typeof k === 'string') el.setAttribute(`data-${kebab(k)}`, String(v));
      return true;
    },
    deleteProperty: (_t, k) => {
      if (typeof k === 'string') el.removeAttribute(`data-${kebab(k)}`);
      return true;
    },
    has: (_t, k) => typeof k === 'string' && el.hasAttribute(`data-${kebab(k)}`),
  });
}

class FakeStyle {
  readonly props = new Map<string, string>();
  cssText = '';
  setProperty(k: string, v: string): void {
    this.props.set(k, v);
  }
  getPropertyValue(k: string): string {
    return this.props.get(k) ?? '';
  }
  removeProperty(k: string): void {
    this.props.delete(k);
  }
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Records every 2D call (name + args). */
export class FakeContext2D {
  readonly calls: { name: string; args: unknown[] }[] = [];
  fillStyle: unknown = '#000';
  globalAlpha = 1;
  constructor(readonly canvas: FakeElement) {}
  private rec(name: string, args: unknown[]): void {
    this.calls.push({ name, args });
  }
  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }
  reset(): void {
    this.calls.length = 0;
  }
  setTransform(...a: unknown[]): void { this.rec('setTransform', a); }
  clearRect(...a: unknown[]): void { this.rec('clearRect', a); }
  fillRect(...a: unknown[]): void { this.rec('fillRect', a); }
  beginPath(): void { this.rec('beginPath', []); }
  moveTo(...a: unknown[]): void { this.rec('moveTo', a); }
  arc(...a: unknown[]): void { this.rec('arc', a); }
  fill(): void { this.rec('fill', [this.fillStyle]); }
  drawImage(...a: unknown[]): void { this.rec('drawImage', a); }
  createRadialGradient(): { addColorStop(o: number, c: string): void } {
    this.rec('createRadialGradient', []);
    return { addColorStop: () => undefined };
  }
}

export class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  readonly classList: FakeClassList;
  readonly dataset: Record<string, string>;
  readonly style = new FakeStyle();
  private readonly attrs = new Map<string, string>();
  private ownText = '';
  rect: Rect | null = { left: 0, top: 0, width: 100, height: 60 };
  // form-ish
  type = '';
  value = '';
  disabled = false;
  tabIndex = -1;
  // canvas
  width = 300;
  height = 150;
  canvasSupported = true;
  ctx2d: FakeContext2D | null = null;
  // probes
  focusCalls = 0;
  captured = new Set<number>();
  constructor(readonly ownerDocument: FakeDocument, tag: string) {
    super();
    this.tagName = tag.toUpperCase();
    this.classList = new FakeClassList(this);
    this.dataset = makeDataset(this);
  }
  get className(): string {
    return this.getAttribute('class') ?? '';
  }
  set className(v: string) {
    this.setAttribute('class', v);
  }
  get id(): string {
    return this.getAttribute('id') ?? '';
  }
  set id(v: string) {
    this.setAttribute('id', v);
  }
  get hidden(): boolean {
    return this.hasAttribute('hidden');
  }
  set hidden(v: boolean) {
    if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden');
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    for (const c of [...this.children]) c.remove();
    this.ownText = v ?? '';
  }
  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get firstElementChild(): FakeElement | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode;
  }
  get isConnected(): boolean {
    let n: FakeElement | null = this as FakeElement;
    while (n) {
      if (n.tagName === 'HTML' && n === this.ownerDocument.documentElement) return true;
      n = n.parentNode;
    }
    return false;
  }
  append(...nodes: (FakeElement | string)[]): void {
    for (const n of nodes) {
      if (typeof n === 'string') {
        const t = this.ownerDocument.createElement('#text');
        t.ownText = n;
        this.appendChild(t);
      } else {
        this.appendChild(n);
      }
    }
  }
  appendChild(n: FakeElement): FakeElement {
    n.remove();
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  prepend(n: FakeElement): void {
    this.insertBefore(n, this.firstChild);
  }
  insertBefore(n: FakeElement, ref: FakeElement | null): FakeElement {
    if (n === ref) return n;
    n.remove();
    n.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n); else this.children.splice(i, 0, n);
    return n;
  }
  removeChild(n: FakeElement): FakeElement {
    const i = this.children.indexOf(n);
    if (i >= 0) this.children.splice(i, 1);
    n.parentNode = null;
    return n;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(n: FakeElement | null): boolean {
    let x: FakeElement | null = n;
    while (x) {
      if (x === this) return true;
      x = x.parentNode;
    }
    return false;
  }
  closest(sel: string): FakeElement | null {
    let x: FakeElement | null = this as FakeElement;
    while (x) {
      if (matches(x, sel, null)) return x;
      x = x.parentNode;
    }
    return null;
  }
  matches(sel: string): boolean {
    return matches(this, sel, null);
  }
  querySelectorAll(sel: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const c of e.children) {
        if (matches(c, sel, this)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel: string): FakeElement | null {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    const r = this.rect ?? { left: 0, top: 0, width: 0, height: 0 };
    return { left: r.left, top: r.top, right: r.left + r.width, bottom: r.top + r.height, width: r.width, height: r.height };
  }
  getClientRects(): unknown[] {
    return this.rect ? [this.rect] : [];
  }
  click(): void {
    this.dispatchEvent(new FakeEvent('click'));
  }
  focus(): void {
    this.focusCalls++;
    this.ownerDocument.activeElement = this;
    this.dispatchEvent(new FakeEvent('focusin'));
  }
  setPointerCapture(id: number): void {
    this.captured.add(id);
  }
  hasPointerCapture(id: number): boolean {
    return this.captured.has(id);
  }
  releasePointerCapture(id: number): void {
    this.captured.delete(id);
  }
  getContext(kind: string): FakeContext2D | null {
    if (this.tagName !== 'CANVAS' || kind !== '2d' || !this.canvasSupported) return null;
    if (!this.ctx2d) this.ctx2d = new FakeContext2D(this);
    return this.ctx2d;
  }
}

// ------------------------------------------------------------ selectors

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: { name: string; value: string | null }[];
  scope: boolean;
}

function parseCompound(s: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [], scope: false };
  const re = /(:scope)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]|^([a-zA-Z*][\w-]*)/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(s)) !== null) {
    consumed += m[0].length;
    if (m[1]) c.scope = true;
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], value: m[5] ?? null });
    else if (m[6]) c.tag = m[6] === '*' ? null : m[6].toUpperCase();
  }
  if (consumed !== s.length) throw new Error(`fake DOM: unsupported selector part '${s}'`);
  return c;
}

function matchCompound(e: FakeElement, c: Compound, scope: FakeElement | null): boolean {
  if (c.scope) return e === scope;
  if (c.tag && e.tagName !== c.tag) return false;
  if (c.id && e.id !== c.id) return false;
  for (const k of c.classes) if (!e.classList.contains(k)) return false;
  for (const a of c.attrs) {
    const v = e.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== null && v !== a.value) return false;
  }
  return true;
}

function matchesComplex(e: FakeElement, sel: string, scope: FakeElement | null): boolean {
  const tokens = sel.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  // Right to left.
  const parts: { comp: Compound; comb: ' ' | '>' | null }[] = [];
  let comb: ' ' | '>' | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (t === '>') {
      comb = '>';
      continue;
    }
    parts.push({ comp: parseCompound(t), comb });
    comb = ' ';
  }
  // parts[0] is the subject; parts[i].comb is the combinator between parts[i-1] (right) and parts[i] (left)
  const rec = (el: FakeElement, idx: number): boolean => {
    if (!matchCompound(el, parts[idx]!.comp, scope)) return false;
    if (idx === parts.length - 1) return true;
    const next = parts[idx + 1]!;
    if (next.comb === '>') {
      const p = el.parentNode;
      return p !== null && rec(p, idx + 1);
    }
    let p = el.parentNode;
    while (p) {
      if (rec(p, idx + 1)) return true;
      p = p.parentNode;
    }
    return false;
  };
  return rec(e, 0);
}

function matches(e: FakeElement, sel: string, scope: FakeElement | null): boolean {
  if (e.tagName === '#TEXT') return false;
  return sel.split(',').some((part) => matchesComplex(e, part, scope));
}

// ------------------------------------------------------------ document / window

export class FakeWindow extends FakeNode {
  innerWidth = 1180;
  innerHeight = 820;
  devicePixelRatio = 1;
  isSecureContext = true;
  reducedMotion = false;
  /** CSS custom properties returned by getComputedStyle(...).getPropertyValue. */
  readonly cssVars = new Map<string, string>([
    ['--dot-color', '#f7f0ee'],
    ['--dot-accent', '#ff6b35'],
    ['--dot-spacing', '26px'],
  ]);
  document!: FakeDocument;
  getComputedStyle(_el: FakeElement): { getPropertyValue(k: string): string; visibility: string; display: string; pointerEvents: string } {
    return { getPropertyValue: (k) => this.cssVars.get(k) ?? '', visibility: 'visible', display: 'block', pointerEvents: 'auto' };
  }
  matchMedia(q: string): { matches: boolean; media: string } {
    const read = (): boolean => (q.includes('reduce') ? this.reducedMotion : false);
    return {
      media: q,
      get matches() {
        return read();
      },
    };
  }
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  readonly defaultView: FakeWindow;
  readonly created: FakeElement[] = [];
  /** When false, canvases have no 2D context. */
  canvasSupported = true;
  constructor() {
    super();
    this.defaultView = new FakeWindow();
    this.defaultView.document = this;
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeElement {
    const e = new FakeElement(this, tag);
    if (e.tagName === 'CANVAS') e.canvasSupported = this.canvasSupported;
    this.created.push(e);
    return e;
  }
  getElementById(id: string): FakeElement | null {
    if (this.documentElement.id === id) return this.documentElement;
    return this.documentElement.querySelector(`#${id}`);
  }
  querySelector(sel: string): FakeElement | null {
    return this.documentElement.querySelector(sel);
  }
  querySelectorAll(sel: string): FakeElement[] {
    return this.documentElement.querySelectorAll(sel);
  }
}

/** A document with <div id="ui"> holding one <div class="screen"> (returned as `screen`). */
export function makeAppDom(): { doc: FakeDocument; win: FakeWindow; ui: FakeElement; screen: FakeElement } {
  const doc = new FakeDocument();
  const ui = doc.createElement('div');
  ui.id = 'ui';
  doc.body.appendChild(ui);
  const screen = doc.createElement('div');
  screen.className = 'screen';
  ui.appendChild(screen);
  return { doc, win: doc.defaultView, ui, screen };
}
