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
 *   The same physical press arriving through several paths is collapsed (BACK_DEDUPE_MS).
 * - Navigation requested while another navigation is running (e.g. inside mount) is queued and run afterwards.
 */
import type { AppContext, Screen, ScreenFactory, ScreenId, ScreenParams } from '../contracts/app';
import type { AppRouter } from './types';

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
  now?: () => number;
}

interface Entry {
  id: ScreenId;
  params: ScreenParams;
}

type Op = { kind: 'go' | 'replace' | 'reset'; id: ScreenId; params: ScreenParams } | { kind: 'back' };

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('input, textarea, select, [contenteditable="true"]') !== null;
}

export function createRouter(root: HTMLElement, getCtx: () => AppContext, opts: RouterOptions = {}): AppRouter {
  const factories = new Map<ScreenId, ScreenFactory>();
  const stack: Entry[] = [];
  const now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  let screen: Screen | null = null;
  let container: HTMLElement | null = null;
  let busy = false;
  const queue: Op[] = [];
  let lastBackAt = -Infinity;
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

  function unmountCurrent(): void {
    const s = screen;
    const c = container;
    screen = null;
    container = null;
    if (c) {
      try {
        getCtx().focus.detach(c);
      } catch (err) {
        fail(err, 'focus.detach');
      }
    }
    if (s) {
      try {
        s.unmount();
      } catch (err) {
        fail(err, `unmount ${s.id}`);
      }
    }
    if (c) c.remove();
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
    const c = makeContainer(top.id);
    root.appendChild(c);
    container = c;
    try {
      screen = factory();
      screen.mount(c, ctx, top.params);
    } catch (err) {
      fail(err, `mount ${top.id}`);
    }
    try {
      ctx.focus.attach(c);
    } catch (err) {
      fail(err, 'focus.attach');
    }
  }

  function apply(op: Op): void {
    if (op.kind === 'back') {
      if (screen && screen.onBack) {
        let handled = false;
        try {
          handled = screen.onBack();
        } catch (err) {
          fail(err, `onBack ${screen.id}`);
          handled = true;
        }
        if (handled) return;
      }
      if (stack.length <= 1) return;
      unmountCurrent();
      stack.pop();
      mountTop();
      return;
    }
    const entry: Entry = { id: op.id, params: op.params };
    unmountCurrent();
    if (op.kind === 'reset') {
      stack.length = 0;
      stack.push(entry);
    } else if (op.kind === 'replace') {
      if (stack.length > 0) stack[stack.length - 1] = entry;
      else stack.push(entry);
      // A replace may create a duplicate further down (e.g. replace loading by match): drop the older copy.
      const idx = stack.findIndex((e) => e.id === op.id);
      if (idx >= 0 && idx < stack.length - 1) stack.splice(idx, stack.length - 1 - idx);
    } else {
      const idx = stack.findIndex((e) => e.id === op.id);
      if (idx >= 0) {
        stack.length = idx;
      }
      stack.push(entry);
    }
    mountTop();
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
    currentScreen: () => screen,
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
      if (t - lastBackAt < BACK_DEDUPE_MS) return;
      lastBackAt = t;
      void source;
      router.back();
    },
    dispose() {
      for (const d of disposers.splice(0)) d();
      unmountCurrent();
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
