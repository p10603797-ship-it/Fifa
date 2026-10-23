/**
 * Screen router with a history stack (contracts/app.ts Router). [FND-04]
 *
 * - go(id): push a screen. If `id` is already in the history the router unwinds back to that entry instead of
 *   pushing a duplicate (e.g. full-time -> 'main', half-time -> 'match'), so the stack never grows without bound.
 * - replace(id): swap the top entry. resetTo(id): clear the history.
 * - back(): asks the mounted screen first (Screen.onBack returning true means handled), else pops one entry.
 *   At the root it does nothing.
 * - Each mount gets a fresh Screen instance from its factory inside its own container under `root`; the focus
 *   navigator is attached to the container on mount and detached on unmount.
 * - Back inputs: Escape / Backspace (not in text fields, not key repeat), menu BACK (pads, via backFromInput('menu'))
 *   and the browser back gesture (popstate on a sentinel history entry that is re-armed so the page is never left).
 *   A keyboard press seen both as keydown and as the menu input's BACK is collapsed (BACK_DEDUPE_MS).
 * - Navigation requested while another navigation is running (e.g. inside mount) is queued and run afterwards.
 * - [INT-B] onUserBack: a Back from an input device (backFromInput) that pops a screen calls it (the app plays
 *   UiSound.BACK, AUD-05). Not called when the screen handled Back itself (it plays its own sound), at the root, or for
 *   programmatic back() calls (on-screen Back buttons already play the sound on their click).
 * - [QF-17] Overlays (opts.overlays, e.g. 'half-time' over 'match'): going to an overlay screen from a screen it is
 *   declared over keeps that screen mounted underneath (covered: no onFrame, no onBack; LayeredScreen.onCovered)
 *   instead of unmounting it, and leaving the overlay back to that same history entry (go(id) unwinding to it with
 *   equal params, back(), a replace of the overlay) uncovers it without a remount (LayeredScreen.onUncovered). Any
 *   other navigation unmounts every mounted layer, top first, as before. The mounted layers are always the top of the
 *   history. This removes the half-time hitch: the match screen's DOM, its pause menu, the body.in-match style change
 *   and the focus navigator's layout reads for a fresh screen no longer happen at half time and at the second-half
 *   kick-off.
 * - [QF-17] prepare(id, params): an overlay screen can be built ahead (the session does it on the loading screen) in a
 *   hidden container ([data-prepared], aria-hidden, opacity 0 and scaled to nothing: it paints nothing, takes no
 *   touches and every control in it has an empty box, so layout checks and Playwright see it as hidden; the browser
 *   styles and lays it out then). Showing it again changes opacity and transform only (no inherited style, no layout).
 *   The next navigation to it as an overlay with equal params shows that instance (LayeredScreen.onReveal, then the
 *   focus root attaches) instead of mounting a new one. A base screen of the prepared overlay mounted later (the match
 *   screen after the loading screen) is inserted before its container, so the overlay stays above it; mounting any
 *   other screen takes its container out of the DOM (its test ids and controls must not sit hidden under another
 *   screen's) and keeps the instance, which goes back over its base when that is mounted again (QF-17 skeptic: the
 *   match screen back from the pause menu's settings / controls / remap screens; it used to be dropped there). It is
 *   unmounted by a navigation to it that cannot use it (a fresh one is mounted), resetTo, dispose and discardPrepared.
 * - [QF-17 skeptic] A covered screen carries aria-hidden while covered (it used to be out of the DOM at half time).
 */
import type { AppContext, Screen, ScreenFactory, ScreenId, ScreenParams } from '../contracts/app';
import type { AppRouter, LayeredScreen } from './types';

export const BACK_DEDUPE_MS = 250;

export interface RouterOptions {
  /** Install keydown (Escape/Backspace) and popstate listeners. Default true when a window exists. */
  listen?: boolean;
  /** Create a screen container (tests pass fakes). Default: a div.screen with data-screen = id. */
  createContainer?(id: ScreenId): HTMLElement;
  /** Errors thrown by screen mount/unmount/onBack. Default: rethrow. */
  onError?(err: unknown, where: string): void;
  /** After each completed navigation. */
  onChange?(id: ScreenId | null): void;
  /** A Back from an input device popped a screen (see module doc). */
  onUserBack?(): void;
  now?: () => number;
  /** [QF-17] Overlay screens and the screens each may be shown over without unmounting them (see module doc). */
  overlays?: Partial<Record<ScreenId, readonly ScreenId[]>>;
}

interface Entry {
  id: ScreenId;
  params: ScreenParams;
}

/** A mounted screen: its history entry, instance and container. */
interface Layer {
  entry: Entry;
  screen: Screen | null;
  container: HTMLElement;
}

/** Same keys with identical values (params of the screens the session navigates to are tiny literals). */
function sameParams(a: ScreenParams, b: ScreenParams): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is(a[k], b[k])) return false;
  return true;
}

type Op = { kind: 'go' | 'replace' | 'reset'; id: ScreenId; params: ScreenParams } | { kind: 'back'; input?: boolean };

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function createRouter(root: HTMLElement, getCtx: () => AppContext, opts: RouterOptions = {}): AppRouter {
  const factories = new Map<ScreenId, ScreenFactory>();
  const stack: Entry[] = [];
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  /** Mounted screens, bottom first; the last one is the current screen. Always the top entries of `stack`. */
  const layers: Layer[] = [];
  const overlays = opts.overlays ?? {};
  let busy = false;
  const queue: Op[] = [];
  let lastKeyBackAt = -Infinity;
  const disposers: (() => void)[] = [];

  const fail = (err: unknown, where: string): void => {
    if (opts.onError) opts.onError(err, where);
    else throw err;
  };

  const makeContainer =
    opts.createContainer ??
    ((id: ScreenId): HTMLElement => {
      const el = document.createElement('div');
      el.className = 'screen';
      el.dataset.screen = id;
      return el;
    });

  /** A screen built ahead by prepare(), hidden, not in `layers` and not a focus root. */
  let prepared: Layer | null = null;

  const topLayer = (): Layer | null => layers[layers.length - 1] ?? null;

  function setHidden(c: HTMLElement, on: boolean): void {
    // Opacity and transform only: showing it again changes no inherited style and no layout (no restyle of its tree).
    const st = (c as Partial<HTMLElement>).style;
    if (st) {
      st.opacity = on ? '0' : '';
      st.transform = on ? 'scale(0)' : '';
    }
    if (typeof c.setAttribute === 'function') {
      if (on) {
        c.setAttribute('aria-hidden', 'true');
        c.setAttribute('data-prepared', '');
      } else {
        c.removeAttribute('aria-hidden');
        c.removeAttribute('data-prepared');
      }
    }
  }

  function discardPrepared(): void {
    const p = prepared;
    if (!p) return;
    prepared = null;
    const s = p.screen;
    p.screen = null;
    if (s) {
      try {
        s.unmount();
      } catch (err) {
        fail(err, `unmount ${s.id}`);
      }
    }
    p.container.remove();
  }

  function canOverlay(id: ScreenId, below: ScreenId): boolean {
    const over = overlays[id];
    return !!over && over.includes(below);
  }

  function unmountLayer(layer: Layer): void {
    const s = layer.screen;
    const c = layer.container;
    layer.screen = null;
    try {
      getCtx().focus.detach(c);
    } catch (err) {
      fail(err, 'focus.detach');
    }
    if (s) {
      try {
        s.unmount();
      } catch (err) {
        fail(err, `unmount ${s.id}`);
      }
    }
    c.remove();
  }

  /** Unmount mounted layers, top first, until `keep` remain. */
  function unmountAbove(keep: number): void {
    while (layers.length > keep) unmountLayer(layers.pop()!);
  }

  /**
   * [QF-17 skeptic] A covered screen is out of the accessibility tree (aria-hidden) while an overlay is over it: before
   * the overlays it was not in the DOM at all during half time, so assistive tech must not reach its controls now.
   */
  function setCovered(layer: Layer, on: boolean): void {
    const c = layer.container;
    if (typeof c.setAttribute !== 'function') return;
    if (on) c.setAttribute('aria-hidden', 'true');
    else c.removeAttribute('aria-hidden');
  }

  function notify(layer: Layer, hook: 'onCovered' | 'onUncovered' | 'onReveal'): void {
    const s = layer.screen as LayeredScreen | null;
    const fn = s ? s[hook] : undefined;
    if (!s || typeof fn !== 'function') return;
    try {
      fn.call(s);
    } catch (err) {
      fail(err, `${hook} ${s.id}`);
    }
  }

  function mountTop(): void {
    const top = stack[stack.length - 1];
    if (!top) return;
    const factory = factories.get(top.id);
    if (!factory) {
      fail(new Error(`No screen registered for '${top.id}'`), 'router');
      return;
    }
    const ctx = getCtx();
    const below = topLayer();
    const p = prepared;
    if (p && p.entry.id === top.id) {
      prepared = null;
      // Usable only as an overlay over its base, with the params it was built with; else it is stale.
      if (p.screen && below && canOverlay(top.id, below.entry.id) && sameParams(p.entry.params, top.params)) {
        p.entry = top;
        if (p.container.parentNode !== root) root.appendChild(p.container); // never shown detached
        setHidden(p.container, false);
        layers.push(p);
        notify(p, 'onReveal');
        try {
          ctx.focus.attach(p.container);
        } catch (err) {
          fail(err, 'focus.attach');
        }
        return;
      }
      prepared = p;
      discardPrepared();
    }
    // [QF-17 skeptic] Any other screen takes the prepared overlay out of the DOM (no hidden duplicate test ids or
    // controls under it) but keeps the instance: when its base is mounted again (the match screen back from the pause
    // menu's settings, controls or remap screen) it goes back over it, so that half time still swaps no DOM. It used to
    // be dropped here, and the half time after such a visit was a fresh mount (the old hitch).
    const pc = prepared ? prepared.container : null;
    const isBase = !!prepared && canOverlay(prepared.entry.id, top.id);
    if (pc && !isBase) pc.remove();
    const c = makeContainer(top.id);
    // A base of the prepared overlay goes under it (the overlay was built first, on the loading screen).
    if (pc && isBase && typeof root.insertBefore === 'function' && pc.parentNode === root) root.insertBefore(c, pc);
    else {
      root.appendChild(c);
      if (pc && isBase) root.appendChild(pc); // back over its base (taken out while another screen showed)
    }
    const layer: Layer = { entry: top, screen: null, container: c };
    layers.push(layer);
    try {
      layer.screen = factory();
      layer.screen.mount(c, ctx, top.params);
    } catch (err) {
      fail(err, `mount ${top.id}`);
    }
    try {
      ctx.focus.attach(c);
    } catch (err) {
      fail(err, 'focus.attach');
    }
  }

  /**
   * Make the mounted layers match the history `next` (bottom first): keep the mounted layers that are still the same
   * entries in place (and end at the new top, or one below a new overlay declared over the kept top), unmount the
   * rest top first, then adopt `next` and mount or uncover the new top.
   */
  function reconcile(next: Entry[]): void {
    let keep = 0;
    if (layers.length > 0) {
      const base = next.indexOf(layers[0]!.entry);
      if (base >= 0) {
        while (keep < layers.length && next[base + keep] === layers[keep]!.entry) keep++;
        const end = base + keep;
        const overlayOnTop = end === next.length - 1 && canOverlay(next[end]!.id, layers[keep - 1]!.entry.id);
        if (end !== next.length && !overlayOnTop) keep = 0;
      }
    }
    // The kept top was covered by the layers about to go: it is uncovered, or stays covered by a new overlay.
    const wasCovered = keep > 0 && keep < layers.length;
    unmountAbove(keep);
    stack.length = 0;
    for (const e of next) stack.push(e);
    const top = topLayer();
    if (top && top.entry === stack[stack.length - 1]) {
      if (wasCovered) {
        setCovered(top, false);
        notify(top, 'onUncovered');
      }
      return;
    }
    if (top && !wasCovered) {
      setCovered(top, true);
      notify(top, 'onCovered');
    }
    mountTop();
  }

  /** True when `e` is mounted below the current screen (covered by an overlay). */
  function covered(e: Entry): boolean {
    for (let i = 0; i < layers.length - 1; i++) if (layers[i]!.entry === e) return true;
    return false;
  }

  function apply(op: Op): void {
    if (op.kind === 'back') {
      const cur = topLayer()?.screen ?? null;
      if (cur && cur.onBack) {
        let handled: boolean;
        try {
          handled = cur.onBack();
        } catch (err) {
          fail(err, `onBack ${cur.id}`);
          handled = true;
        }
        if (handled) return;
      }
      if (stack.length <= 1) return;
      if (op.input && opts.onUserBack) {
        try {
          opts.onUserBack();
        } catch (err) {
          fail(err, 'onUserBack');
        }
      }
      reconcile(stack.slice(0, stack.length - 1));
      return;
    }
    const entry: Entry = { id: op.id, params: op.params };
    const next = stack.slice();
    if (op.kind === 'reset') {
      discardPrepared();
      next.length = 0;
      next.push(entry);
    } else if (op.kind === 'replace') {
      if (next.length > 0) next[next.length - 1] = entry;
      else next.push(entry);
      // A replace may create a duplicate further down (e.g. replace loading by match): drop the older copy.
      const idx = next.findIndex((e) => e.id === op.id);
      if (idx >= 0 && idx < next.length - 1) next.splice(idx, next.length - 1 - idx);
    } else {
      const idx = next.findIndex((e) => e.id === op.id);
      if (idx >= 0) {
        const old = next[idx]!;
        // [QF-17] Back to a screen still mounted under an overlay (half-time -> match): keep it, no remount.
        if (covered(old) && sameParams(old.params, op.params)) {
          next.length = idx + 1;
          reconcile(next);
          return;
        }
        next.length = idx;
      }
      next.push(entry);
    }
    reconcile(next);
  }

  function run(op: Op): void {
    queue.push(op);
    if (busy) return;
    busy = true;
    try {
      let guard = 0;
      while (queue.length > 0 && guard++ < 32) {
        apply(queue.shift()!);
        opts.onChange?.(stack.length ? stack[stack.length - 1]!.id : null);
      }
      queue.length = 0;
    } finally {
      busy = false;
    }
  }

  const router: AppRouter = {
    get current() {
      return stack.length ? stack[stack.length - 1]!.id : null;
    },
    get stack() {
      return stack.map((e) => e.id);
    },
    has(id) {
      return stack.some((e) => e.id === id);
    },
    currentScreen: () => topLayer()?.screen ?? null,
    get prepared() {
      return prepared ? prepared.entry.id : null;
    },
    get mounted() {
      return layers.map((l) => l.entry.id);
    },
    prepare(id, params = {}) {
      const factory = factories.get(id);
      // Never a second, hidden instance of a screen that is showing (its test ids and focus targets would double).
      if (!overlays[id] || !factory || layers.some((l) => l.entry.id === id)) return false;
      if (prepared && prepared.entry.id === id && sameParams(prepared.entry.params, params) && prepared.screen) return true;
      discardPrepared();
      const c = makeContainer(id);
      setHidden(c, true);
      root.appendChild(c);
      const p: Layer = { entry: { id, params }, screen: null, container: c };
      prepared = p;
      try {
        p.screen = factory();
        p.screen.mount(c, getCtx(), params);
      } catch (err) {
        if (prepared === p) discardPrepared();
        fail(err, `prepare ${id}`);
        return false;
      }
      return prepared === p;
    },
    discardPrepared,
    register(id, factory) {
      factories.set(id, factory);
    },
    go(id, params = {}) {
      run({ kind: 'go', id, params });
    },
    replace(id, params = {}) {
      run({ kind: 'replace', id, params });
    },
    resetTo(id, params = {}) {
      run({ kind: 'reset', id, params });
    },
    back() {
      run({ kind: 'back' });
    },
    backFromInput(source) {
      const t = now();
      // A keyboard Escape/Backspace reaches us twice: keydown here, then the menu input's latched BACK on its next
      // poll. Only that pairing is collapsed; pad B and the browser back gesture always count.
      if (source === 'menu' && t - lastKeyBackAt < BACK_DEDUPE_MS) return;
      if (source === 'key') lastKeyBackAt = t;
      run({ kind: 'back', input: true });
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      discardPrepared();
      unmountAbove(0);
      stack.length = 0;
    },
  };

  const listen = opts.listen ?? typeof window !== 'undefined';
  if (listen && typeof window !== 'undefined') {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' && e.key !== 'Backspace') return;
      if (e.key === 'Backspace' && isEditable(e.target)) return;
      if (e.cancelable) e.preventDefault();
      if (e.repeat) return;
      router.backFromInput('key');
    };
    window.addEventListener('keydown', onKey);
    disposers.push(() => window.removeEventListener('keydown', onKey));

    // Browser back (Safari edge swipe, Android back, Alt+Left): keep a sentinel entry so the page is never left.
    const arm = (): void => {
      try {
        history.pushState({ dotkick: true }, '');
      } catch {
        /* rate-limited or unavailable */
      }
    };
    const onPop = (): void => {
      arm();
      router.backFromInput('history');
    };
    arm();
    window.addEventListener('popstate', onPop);
    disposers.push(() => window.removeEventListener('popstate', onPop));
  }

  return router;
}
