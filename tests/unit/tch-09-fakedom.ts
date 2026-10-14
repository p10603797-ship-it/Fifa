/**
 * TCH-09 test helper: a tiny fake DOM (just what the touch overlay and similar DOM-writing modules touch), so their
 * write-on-change logic runs in Node. Not a general DOM: createElement, className / classList, style (properties and
 * setProperty), attributes, textContent, append / remove.
 */

export class FakeStyle {
  [k: string]: unknown;
  private vars: Record<string, string> = {};
  setProperty(k: string, v: string): void { this.vars[k] = v; }
  getPropertyValue(k: string): string { return this.vars[k] ?? ''; }
}

export class FakeEl {
  readonly tagName: string;
  className = '';
  private text = '';
  children: FakeEl[] = [];
  parent: FakeEl | null = null;
  attrs: Record<string, string> = {};
  style = new FakeStyle() as FakeStyle & Record<string, string>;
  readonly ownerDocument: FakeDoc;
  readonly classList: { toggle(c: string, on?: boolean): boolean; contains(c: string): boolean; add(c: string): void; remove(c: string): void };

  constructor(doc: FakeDoc, tag: string) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    const list = (): string[] => this.className.split(/\s+/).filter(Boolean);
    const set = (c: string, on: boolean): void => {
      const l = list().filter((x) => x !== c);
      if (on) l.push(c);
      this.className = l.join(' ');
    };
    this.classList = {
      toggle: (c, on) => {
        const want = on === undefined ? !list().includes(c) : on;
        set(c, want);
        return want;
      },
      contains: (c) => list().includes(c),
      add: (c) => set(c, true),
      remove: (c) => set(c, false),
    };
  }

  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.text = v; this.children = []; }

  append(...els: FakeEl[]): void {
    for (const e of els) {
      e.parent?.children.splice(e.parent.children.indexOf(e), 1);
      e.parent = this;
      this.children.push(e);
    }
  }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void { this.attrs[k] = String(v); }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k]! : null; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  hasAttribute(k: string): boolean { return k in this.attrs; }

  /** Depth-first search by a class name. */
  all(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl): void => {
      for (const c of e.children) {
        if (c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  one(cls: string): FakeEl {
    const r = this.all(cls);
    if (r.length === 0) throw new Error(`no .${cls}`);
    return r[0]!;
  }
}

export class FakeDoc {
  createElement(tag: string): FakeEl { return new FakeEl(this, tag); }
}

/** A fake root element (cast to HTMLElement for the module under test). */
export function fakeRoot(): FakeEl {
  return new FakeDoc().createElement('div');
}

export function asHtml(e: FakeEl): HTMLElement {
  return e as unknown as HTMLElement;
}
