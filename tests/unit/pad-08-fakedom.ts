/**
 * PAD-08 test helper: a minimal fake DOM (Node has no DOM) with exactly the API src/input/focus.ts uses: element
 * tree, attributes, classList, rects, closest / querySelectorAll for compound attribute selectors, click, focus,
 * scrollIntoView, range / checkbox inputs, a document with head / body / documentElement and a window EventTarget.
 */
import type { FocusRect } from '../../src/input/focus';

class FakeClassList {
  private readonly set = new Set<string>();
  add(...c: string[]): void { for (const x of c) this.set.add(x); }
  remove(...c: string[]): void { for (const x of c) this.set.delete(x); }
  contains(c: string): boolean { return this.set.has(c); }
  toggle(c: string, on?: boolean): boolean {
    const want = on ?? !this.set.has(c);
    if (want) this.set.add(c); else this.set.delete(c);
    return want;
  }
}

interface Compound { tag: string; attrs: { name: string; value: string | null }[] }

function parseSelector(sel: string): Compound[] {
  return sel.split(',').map((part) => {
    const s = part.trim();
    const m = /^([a-zA-Z]*)((?:\[[^\]]+\])*)$/.exec(s);
    if (!m) throw new Error(`fake DOM: unsupported selector '${s}'`);
    const attrs: { name: string; value: string | null }[] = [];
    const re = /\[([^=\]]+)(?:="([^"]*)")?\]/g;
    let a: RegExpExecArray | null;
    while ((a = re.exec(m[2]!)) !== null) attrs.push({ name: a[1]!, value: a[2] ?? null });
    return { tag: m[1]!.toUpperCase(), attrs };
  });
}

export class FakeElement extends EventTarget {
  readonly tagName: string;
  readonly ownerDocument: FakeDocument;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  readonly classList = new FakeClassList();
  private readonly attrs = new Map<string, string>();
  /** Layout box; null = not rendered (display: none). */
  rect: FocusRect | null = null;
  disabled = false;
  isContentEditable = false;
  textContent = '';
  // Inputs.
  type = '';
  value = '';
  checked = false;
  min = 0;
  max = 100;
  step = 1;
  // Probes.
  clicks = 0;
  focusCalls = 0;
  scrolls = 0;

  constructor(doc: FakeDocument, tag: string) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }

  get id(): string { return this.attrs.get('id') ?? ''; }
  set id(v: string) { this.attrs.set('id', v); }

  get isConnected(): boolean {
    return this.top() === this.ownerDocument.documentElement;
  }

  private top(): FakeElement {
    return this.parentElement ? this.parentElement.top() : this;
  }

  /** This element and its ancestors, nearest first. */
  private chain(): FakeElement[] {
    const out: FakeElement[] = [];
    for (let e: FakeElement | null = this.parentElement; e; e = e.parentElement) out.push(e);
    return [this as FakeElement, ...out];
  }

  append(...kids: FakeElement[]): void {
    for (const k of kids) {
      k.remove();
      k.parentElement = this;
      this.children.push(k);
    }
  }

  remove(): void {
    const p = this.parentElement;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentElement = null;
  }

  setAttribute(n: string, v: string): void { this.attrs.set(n, String(v)); }
  getAttribute(n: string): string | null { return this.attrs.has(n) ? this.attrs.get(n)! : null; }
  hasAttribute(n: string): boolean { return this.attrs.has(n); }
  removeAttribute(n: string): void { this.attrs.delete(n); }

  matches(sel: string): boolean {
    return parseSelector(sel).some((c) => (c.tag === '' || c.tag === this.tagName)
      && c.attrs.every((a) => this.attrs.has(a.name) && (a.value === null || this.attrs.get(a.name) === a.value)));
  }

  closest<T = FakeElement>(sel: string): T | null {
    for (const e of this.chain()) if (e.matches(sel)) return e as unknown as T;
    return null;
  }

  contains(o: unknown): boolean {
    for (let e = o as FakeElement | null; e; e = e.parentElement) if (e === this) return true;
    return false;
  }

  querySelectorAll<T = FakeElement>(sel: string): T[] {
    const out: FakeElement[] = [];
    const walk = (e: FakeElement): void => {
      for (const k of e.children) {
        if (k.matches(sel)) out.push(k);
        walk(k);
      }
    };
    walk(this);
    return out as unknown as T[];
  }

  querySelector<T = FakeElement>(sel: string): T | null {
    return (this.querySelectorAll<T>(sel)[0] ?? null);
  }

  /** Rendered when it has a rect and no ancestor (or itself) carries [hidden]. */
  private rendered(): boolean {
    if (!this.rect || !this.isConnected) return false;
    for (const e of this.chain()) if (e.hasAttribute('hidden')) return false;
    return true;
  }

  getClientRects(): FocusRect[] { return this.rendered() ? [this.rect!] : []; }

  getBoundingClientRect(): FocusRect & { width: number; height: number } {
    const r = this.rect ?? { left: 0, top: 0, right: 0, bottom: 0 };
    return { ...r, width: r.right - r.left, height: r.bottom - r.top };
  }

  click(): void {
    if (this.disabled) return;
    this.clicks++;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') {
      this.checked = !this.checked;
      this.dispatchEvent(new Event('input'));
      this.dispatchEvent(new Event('change'));
    }
    this.dispatchEvent(new Event('click'));
  }

  focus(): void {
    this.focusCalls++;
    this.ownerDocument.activeElement = this;
  }

  scrollIntoView(): void { this.scrolls++; }

  stepUp(): void { this.stepBy(1); }
  stepDown(): void { this.stepBy(-1); }
  private stepBy(dir: number): void {
    const v = Number(this.value === '' ? this.min : this.value);
    this.value = String(Math.max(this.min, Math.min(this.max, v + dir * this.step)));
  }
}

export class FakeWindow extends EventTarget {
  readonly Event = Event;
  readonly CustomEvent = CustomEvent;
}

export class FakeDocument {
  readonly defaultView = new FakeWindow();
  readonly documentElement: FakeElement;
  readonly head: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;

  constructor() {
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.head, this.body);
  }

  createElement(tag: string): FakeElement { return new FakeElement(this, tag); }

  getElementById(id: string): FakeElement | null {
    const all = this.documentElement.querySelectorAll('[id]');
    return all.find((e) => e.id === id) ?? null;
  }
}

/** Element with attributes and a rect (x, y, w, h), appended to parent. */
export function box(
  parent: FakeElement, tag: string, attrs: Record<string, string> = {}, r: [number, number, number, number] | null = null,
): FakeElement {
  const e = parent.ownerDocument.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (r) e.rect = { left: r[0], top: r[1], right: r[0] + r[2], bottom: r[1] + r[3] };
  parent.append(e);
  return e;
}
