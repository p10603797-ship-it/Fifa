/**
 * [QF-17] FIX-10 half-time hitch: the router keeps the match screen mounted under the half-time overlay
 * (RouterOptions.overlays, ui/index.ts SCREEN_OVERLAYS) and can build that overlay ahead (AppRouter.prepare, done by
 * the session on the loading screen). Covered here:
 *  - router layering: cover / uncover without remount, every other navigation unmounting top first, params, Back,
 *    replace, queued navigation, errors, and the old behaviour without the option;
 *  - prepare: hidden container, adoption with onReveal, base screens inserted under it, stale / failed / discarded;
 *  - the real session + loop + sim with the real overlay config: the walk through half time to the final screen,
 *    pause at half time, quit, practice / shoot-out (nothing prepared), extra time, and a seeded fuzz of the lifecycle
 *    with layer invariants after every frame;
 *  - the match screen's cover hooks (HUD hidden, stale pause menu hidden, team orders handed over), the half-time
 *    screen built ahead and refreshed on reveal, and modals never hosted by a hidden prepared screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSetup, ScreenId, ScreenParams } from '../../src/contracts/app';
import { Command, ControllerKind, MatchPhase, ModeId, Period, PracticeKind } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createLoop } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession, halfTimeAhead } from '../../src/app/session';
import type { AppRouter, AppSession, LayeredScreen } from '../../src/app/types';
import { SCREEN_OVERLAYS } from '../../src/ui/index';
import { closeTopModal, openModal } from '../../src/ui/components';
import { createHalfTimeScreen, HALF_STAT_KEYS } from '../../src/ui/screens/halfTime';
import { createMatchScreen, MATCH_COVERED_CLASS } from '../../src/ui/screens/match';
import { resetTeamOrders, setFocusOrder, teamOrders } from '../../src/ui/screens/pause';
import { makeScenario } from '../harness/scenario';
import { makeAppDom, type FakeElement } from './uix-01-fakedom';

// ============================================================ fakes

interface FakeContainer {
  name: ScreenId;
  style: { opacity: string; transform: string };
  attrs: Map<string, string>;
  parentNode: FakeRoot | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  remove(): void;
}
interface FakeRoot {
  children: FakeContainer[];
  appendChild(c: FakeContainer): FakeContainer;
  insertBefore(c: FakeContainer, ref: FakeContainer): FakeContainer;
}

function fakeRoot(): FakeRoot {
  const root: FakeRoot = {
    children: [],
    appendChild(c) {
      c.remove();
      root.children.push(c);
      c.parentNode = root;
      return c;
    },
    insertBefore(c, ref) {
      c.remove();
      const i = root.children.indexOf(ref);
      root.children.splice(i < 0 ? root.children.length : i, 0, c);
      c.parentNode = root;
      return c;
    },
  };
  return root;
}

function fakeContainer(name: ScreenId): FakeContainer {
  const c: FakeContainer = {
    name,
    style: { opacity: '', transform: '' },
    attrs: new Map(),
    parentNode: null,
    setAttribute(k, v) { c.attrs.set(k, v); },
    removeAttribute(k) { c.attrs.delete(k); },
    hasAttribute(k) { return c.attrs.has(k); },
    remove() {
      const p = c.parentNode;
      if (!p) return;
      const i = p.children.indexOf(c);
      if (i >= 0) p.children.splice(i, 1);
      c.parentNode = null;
    },
  };
  return c;
}

/** Router over fake containers with recording screens: log lines like 'mount match#1', 'covered match#1'. */
function routerRig(opts: { overlays?: boolean; failMount?: ScreenId[]; failCovered?: boolean; onCovered?: (r: AppRouter) => void } = {}) {
  const root = fakeRoot();
  const log: string[] = [];
  const errors: string[] = [];
  const focus = { attach: vi.fn(), detach: vi.fn() };
  const live = new Set<string>();
  const counts = new Map<ScreenId, number>();
  const frames: string[] = [];
  const router: AppRouter = createRouter(root as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: (id) => fakeContainer(id) as unknown as HTMLElement,
    overlays: opts.overlays === false ? undefined : { 'half-time': ['match'] },
    onError: (err, where) => errors.push(`${where}: ${String(err)}`),
  });
  const ids: ScreenId[] = ['main', 'loading', 'match', 'half-time', 'full-time', 'settings', 'recovery'];
  for (const id of ids) {
    router.register(id, (): LayeredScreen => {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      const tag = `${id}#${n}`;
      let backResult = id === 'half-time';
      return {
        id,
        mount(_c: HTMLElement, _ctx: AppContext, params: ScreenParams) {
          log.push(`mount ${tag}`);
          live.add(tag);
          if (params.backFalse) backResult = false;
          if (opts.failMount?.includes(id)) throw new Error(`mount failed ${tag}`);
        },
        unmount() { log.push(`unmount ${tag}`); live.delete(tag); },
        onBack() { log.push(`back ${tag}`); return backResult; },
        onFrame() { frames.push(tag); },
        onCovered() {
          log.push(`covered ${tag}`);
          if (opts.failCovered) throw new Error('covered failed');
          opts.onCovered?.(router);
        },
        onUncovered() { log.push(`uncovered ${tag}`); },
        onReveal() { log.push(`reveal ${tag}`); },
      };
    });
  }
  const order = (): string[] => root.children.map((c) => `${c.name}${c.hasAttribute('data-prepared') ? '(prepared)' : ''}`);
  return { router, root, log, errors, focus, live, order, frames, take: () => log.splice(0) };
}

// ============================================================ router layering

describe('QF-17 router overlays (FIX-10): the match screen stays mounted under half time', () => {
  it('half time covers the match screen (no unmount, onCovered) and the kick-off uncovers it (no remount, onUncovered)', () => {
    const r = routerRig();
    r.router.go('main');
    r.router.go('match');
    r.take();
    r.focus.detach.mockClear();
    r.router.go('half-time');
    expect(r.take()).toEqual(['covered match#1', 'mount half-time#1']);
    expect(r.router.current).toBe('half-time');
    expect(r.router.stack).toEqual(['main', 'match', 'half-time']);
    expect(r.router.currentScreen()!.id).toBe('half-time');
    expect(r.order()).toEqual(['match', 'half-time']);
    expect(r.focus.detach).not.toHaveBeenCalled();
    expect(r.focus.attach).toHaveBeenLastCalledWith(r.root.children[1]);
    r.router.go('match');
    expect(r.take()).toEqual(['unmount half-time#1', 'uncovered match#1']);
    expect(r.router.stack).toEqual(['main', 'match']);
    expect(r.router.currentScreen()!.id).toBe('match');
    expect(r.order()).toEqual(['match']);
    expect(r.focus.detach).toHaveBeenCalledTimes(1);
    expect(r.errors).toEqual([]);
  });

  it('pause at half time and back, twice: still the one match screen; each half-time overlay is a fresh instance', () => {
    const r = routerRig();
    r.router.go('match');
    for (let i = 0; i < 2; i++) {
      r.router.go('half-time');
      r.router.go('match'); // pause (the session shows the match screen while paused)
    }
    r.router.go('half-time');
    expect(r.live).toEqual(new Set(['match#1', 'half-time#3']));
    expect(r.log.filter((l) => l.startsWith('mount match'))).toEqual(['mount match#1']);
    expect(r.log.filter((l) => l.startsWith('covered')).length).toBe(3);
    expect(r.log.filter((l) => l.startsWith('uncovered')).length).toBe(2);
  });

  it('only the current screen gets frames: a covered match screen gets no onFrame and no onBack', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.go('half-time');
    r.router.currentScreen()!.onFrame!({} as never);
    r.router.back(); // half-time handles Back itself (Continue)
    expect(r.frames).toEqual(['half-time#1']);
    expect(r.log.filter((l) => l.startsWith('back'))).toEqual(['back half-time#1']);
    expect(r.router.current).toBe('half-time');
  });

  it('Back from an overlay that does not handle it pops it and uncovers the screen below without a remount', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.go('half-time', { backFalse: true });
    r.take();
    r.router.back();
    expect(r.take()).toEqual(['back half-time#1', 'unmount half-time#1', 'uncovered match#1']);
    expect(r.router.current).toBe('match');
  });

  it('every other navigation unmounts all layers, top first: go to another screen, resetTo, replace, a non-overlay push', () => {
    const cases: [string, (rt: AppRouter) => void, string[]][] = [
      ['go main (unwind)', (rt) => rt.go('main'), ['unmount half-time#1', 'unmount match#1', 'mount main#2']],
      ['resetTo main', (rt) => rt.resetTo('main'), ['unmount half-time#1', 'unmount match#1', 'mount main#2']],
      ['go recovery (push)', (rt) => rt.go('recovery'), ['unmount half-time#1', 'unmount match#1', 'mount recovery#1']],
      ['go full-time (not declared over match)', (rt) => rt.go('full-time'), ['unmount half-time#1', 'unmount match#1', 'mount full-time#1']],
      ['go loading (restart)', (rt) => rt.go('loading'), ['unmount half-time#1', 'unmount match#1', 'mount loading#1']],
    ];
    for (const [name, nav, want] of cases) {
      const r = routerRig();
      r.router.go('main');
      r.router.go('match');
      r.router.go('half-time');
      r.take();
      nav(r.router);
      expect(r.take(), name).toEqual(want);
      expect(r.root.children.length, name).toBe(1);
      expect(r.live.size, name).toBe(1);
    }
  });

  it('replacing the overlay by itself keeps the match covered (no uncover / cover pair, no remount)', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.go('half-time');
    r.take();
    r.router.replace('half-time');
    expect(r.take()).toEqual(['unmount half-time#1', 'mount half-time#2']);
    expect(r.router.stack).toEqual(['match', 'half-time']);
  });

  it('back to the match with other params remounts it (only an identical entry is reused)', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.go('half-time');
    r.take();
    r.router.go('match', { fresh: 1 });
    expect(r.take()).toEqual(['unmount half-time#1', 'unmount match#1', 'mount match#2']);
  });

  it('go to the current top screen still remounts it, as before (only a covered entry is reused)', () => {
    const r = routerRig();
    r.router.go('match');
    r.take();
    r.router.go('match');
    expect(r.take()).toEqual(['unmount match#1', 'mount match#2']);
  });

  it('without the overlays option the router swaps screens exactly as before', () => {
    const r = routerRig({ overlays: false });
    r.router.go('match');
    r.take();
    r.router.go('half-time');
    expect(r.take()).toEqual(['unmount match#1', 'mount half-time#1']);
    r.router.go('match');
    expect(r.take()).toEqual(['unmount half-time#1', 'mount match#2']);
    expect(r.router.prepare!('half-time')).toBe(false);
  });

  it('a throwing onCovered is reported and the overlay still shows; navigation from inside onCovered is queued', () => {
    const r = routerRig({ failCovered: true });
    r.router.go('match');
    r.router.go('half-time');
    expect(r.router.current).toBe('half-time');
    expect(r.errors).toEqual(['onCovered match: Error: covered failed']);
    const q = routerRig({ onCovered: (rt) => rt.go('match') });
    q.router.go('match');
    q.router.go('half-time');
    expect(q.router.current).toBe('match');
    expect(q.log).toEqual(['mount match#1', 'covered match#1', 'mount half-time#1', 'unmount half-time#1', 'uncovered match#1']);
  });

  it('dispose unmounts every layer and the prepared screen', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.go('half-time');
    r.router.prepare!('half-time', { other: 1 });
    r.router.dispose();
    expect(r.live.size).toBe(0);
    expect(r.root.children.length).toBe(0);
  });
});

// ============================================================ prepare

describe('QF-17 router prepare (FIX-10): the half-time overlay built ahead', () => {
  it('builds it hidden (data-prepared, aria-hidden, opacity 0, off screen), not a focus root, not the current screen', () => {
    const r = routerRig();
    r.router.go('match');
    r.focus.attach.mockClear();
    expect(r.router.prepare!('half-time')).toBe(true);
    const c = r.root.children[1]!;
    expect(c.attrs.get('aria-hidden')).toBe('true');
    expect(c.hasAttribute('data-prepared')).toBe(true);
    expect(c.style.opacity).toBe('0');
    expect(c.style.transform).toBe('scale(0)');
    expect(r.focus.attach).not.toHaveBeenCalled();
    expect(r.router.current).toBe('match');
    expect(r.router.prepared).toBe('half-time');
    expect(r.log).toContain('mount half-time#1');
    expect(r.router.prepare!('half-time')).toBe(true); // same params: kept
    expect(r.log.filter((l) => l === 'mount half-time#2')).toEqual([]);
    expect(r.router.prepare!('full-time')).toBe(false); // not an overlay screen
    expect(r.router.prepared).toBe('half-time');
    r.router.go('half-time');
    expect(r.router.prepare!('half-time')).toBe(false); // showing: no hidden second instance
    expect(r.router.prepared).toBeNull();
    expect(r.root.children.length).toBe(2);
  });

  it('half time shows the prepared instance: no new mount, onReveal, shown, focus root attached', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.prepare!('half-time');
    r.take();
    r.focus.attach.mockClear();
    r.router.go('half-time');
    expect(r.take()).toEqual(['covered match#1', 'reveal half-time#1']);
    const c = r.root.children[1]!;
    expect(c.hasAttribute('data-prepared')).toBe(false);
    expect(c.hasAttribute('aria-hidden')).toBe(false);
    expect(c.style).toEqual({ opacity: '', transform: '' });
    expect(r.focus.attach).toHaveBeenCalledWith(c);
    expect(r.router.prepared).toBeNull();
    expect(r.router.currentScreen()!.id).toBe('half-time');
    r.router.go('match');
    expect(r.take()).toEqual(['unmount half-time#1', 'uncovered match#1']);
  });

  it('prepared on the loading screen: the match screen mounted next goes under it (DOM order), then half time uses it', () => {
    const r = routerRig();
    r.router.go('main');
    r.router.go('loading');
    r.router.prepare!('half-time');
    expect(r.order()).toEqual(['loading', 'half-time(prepared)']);
    r.router.replace('match');
    expect(r.order()).toEqual(['match', 'half-time(prepared)']);
    expect(r.router.mounted).toEqual(['match']);
    r.take();
    r.router.go('half-time');
    expect(r.take()).toEqual(['covered match#1', 'reveal half-time#1']);
    expect(r.order()).toEqual(['match', 'half-time']);
    expect(r.router.mounted).toEqual(['match', 'half-time']);
  });

  it('mounting a screen that is not its base takes it out of the DOM (pause menu -> settings, a full-time screen): no hidden duplicate test ids', () => {
    // [QF-17 skeptic] Out of the DOM but kept (it used to be dropped): back on the match screen it goes over it again
    // and the half time uses it (see qf-17-skeptic-halftime.test.ts for the session flow).
    for (const id of ['settings', 'full-time', 'recovery'] as ScreenId[]) {
      const r = routerRig();
      r.router.go('match');
      r.router.prepare!('half-time');
      r.router.go(id);
      expect(r.router.prepared, id).toBe('half-time');
      expect(r.order(), id).toEqual([id]);
      expect(r.live, id).toEqual(new Set([`${id}#1`, 'half-time#1'])); // the overlay instance is kept, not in the DOM
      r.router.back(); // the match screen again, the prepared overlay back over it
      expect(r.order(), id).toEqual(['match', 'half-time(prepared)']);
      r.take();
      r.router.go('half-time');
      expect(r.take(), id).toEqual(['covered match#2', 'reveal half-time#1']);
    }
  });

  it('a prepared screen that cannot be used is dropped and a fresh one mounted: other params, or not over its base', () => {
    const a = routerRig();
    a.router.go('match');
    a.router.prepare!('half-time', { v: 1 });
    a.take();
    a.router.go('half-time');
    expect(a.take()).toEqual(['covered match#1', 'unmount half-time#1', 'mount half-time#2']);
    expect(a.root.children.length).toBe(2);
    const b = routerRig();
    b.router.go('main');
    b.router.prepare!('half-time');
    b.take();
    b.router.go('half-time');
    expect(b.take()).toEqual(['unmount main#1', 'unmount half-time#1', 'mount half-time#2']);
    expect(b.order()).toEqual(['half-time']);
    // A prepared screen while another (non-base) screen is shown stays in the DOM until something else mounts, which
    // takes it out of the DOM (kept: QF-17 skeptic).
    const c = routerRig();
    c.router.go('main');
    c.router.prepare!('half-time');
    expect(c.order()).toEqual(['main', 'half-time(prepared)']);
    c.router.go('settings');
    expect(c.router.prepared).toBe('half-time');
    expect(c.order()).toEqual(['settings']);
    expect(b.order()).toEqual(['half-time']);
  });

  it('resetTo and discardPrepared unmount it; a new prepare with other params replaces it', () => {
    const r = routerRig();
    r.router.go('match');
    r.router.prepare!('half-time');
    r.router.prepare!('half-time', { v: 2 });
    expect(r.log).toContain('unmount half-time#1');
    r.router.discardPrepared!();
    expect(r.live).toEqual(new Set(['match#1']));
    r.router.prepare!('half-time');
    r.router.resetTo('main');
    expect(r.live).toEqual(new Set(['main#1']));
    expect(r.router.prepared).toBeNull();
    expect(r.order()).toEqual(['main']);
  });

  it('a prepare whose mount throws reports it, leaves nothing behind and returns false', () => {
    const r = routerRig({ failMount: ['half-time'] });
    r.router.go('match');
    expect(r.router.prepare!('half-time')).toBe(false);
    expect(r.router.prepared).toBeNull();
    expect(r.order()).toEqual(['match']);
    expect(r.errors[0]).toMatch(/^prepare half-time: Error: mount failed/);
  });
});

// ============================================================ real session + loop + sim

function sessionRig(seed = 1) {
  const root = fakeRoot();
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const errors: string[] = [];
  const router = createRouter(root as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: (id) => fakeContainer(id) as unknown as HTMLElement,
    overlays: SCREEN_OVERLAYS,
    onError: (err, where) => errors.push(`${where}: ${String(err)}`),
  });
  const live = new Map<string, { covered: boolean }>();
  const made = new Map<ScreenId, number>();
  const badFrames: string[] = [];
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time'] as ScreenId[]) {
    router.register(id, (): LayeredScreen => {
      const n = (made.get(id) ?? 0) + 1;
      made.set(id, n);
      const tag = `${id}#${n}`;
      return {
        id,
        mount() { live.set(tag, { covered: false }); },
        unmount() { live.delete(tag); },
        onCovered() { live.get(tag)!.covered = true; },
        onUncovered() { live.get(tag)!.covered = false; },
        onFrame() { if (live.get(tag)?.covered !== false) badFrames.push(tag); },
      };
    });
  }
  router.go('main');
  const renderer = createNullRenderer();
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const devices: DeviceRegistry = {
    list: () => [{ id: 'pad:1', kind: 'pad', label: 'Pad 1', connected: true } as never],
    subscribe: () => () => undefined,
    lastActive: () => null,
    createSource: ((id: string) => ({ id, kind: 'pad', sample() {}, releaseAll() {}, dispose() {} })) as never,
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' };
  let now = 1000;
  let restarts = 0;
  const session = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: CLUBS, getProjector: () => null,
    onError: (err, where) => errors.push(`${where}: ${String(err)}`),
    yieldFrame: () => Promise.resolve(), now: () => now,
    newSeed: () => (Math.imul(seed, 0x9e3779b1) ^ ++restarts) >>> 0,
  }) as AppSession;
  let frameT = 0;
  const loop = createLoop({
    session, renderer, hud, audio, router, getProjector: () => null, onError: (err, where) => errors.push(`${where}: ${String(err)}`),
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  loop.start();
  const frames = (n: number, after?: () => void): void => {
    for (let i = 0; i < n; i++) {
      frameT += 50;
      now += 50;
      loop.frame(frameT);
      after?.();
    }
  };
  const mounted = (id: ScreenId): string[] => [...live.keys()].filter((k) => k.startsWith(`${id}#`));
  return { router, root, session, errors, frames, live, made, mounted, badFrames, advance: (ms: number) => { now += ms; } };
}

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function setup(seed: number, mutate?: (c: MatchSetup['config']) => void): MatchSetup {
  const config = createMatchConfig();
  config.seed = seed;
  config.halfMinutes = 2;
  config.humans = [{ ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 }, { ...config.humans[1]! }];
  mutate?.(config);
  return { config, bindings: [{ human: 0, deviceIds: ['pad:1'] }] };
}

/** Jump the running half's clock to its last half second and play until the phase is `want` (or frames run out). */
function playTo(r: ReturnType<typeof sessionRig>, want: MatchPhase, maxFrames = 4000): void {
  for (let i = 0; i < maxFrames; i++) {
    const st = r.session.runtime()?.curr;
    if (!st) return;
    if (st.match.phase === want) return;
    if (st.match.clockRunning === 1 && (st.match.period === Period.FIRST_HALF || st.match.period === Period.SECOND_HALF)) {
      st.match.periodT = Math.max(st.match.periodT, st.match.periodLen - 30);
      st.match.addedT = 0;
    }
    if ((st.match.phase === MatchPhase.HALF_TIME || st.match.phase === MatchPhase.FULL_TIME) && want !== st.match.phase) {
      r.session.queueCommand(0, Command.SKIP, 0);
    }
    r.frames(1);
  }
}

describe('QF-17 session with the real overlay config (FIX-10)', () => {
  it('a match from loading to its final screen: half time built on the loading screen, shown over the mounted match screen, the match never remounted', async () => {
    const r = sessionRig();
    r.session.start(setup(41));
    expect(r.router.current).toBe('loading');
    await flush();
    expect(r.router.current).toBe('match');
    expect(r.router.prepared).toBe('half-time');
    expect(r.mounted('half-time')).toEqual(['half-time#1']); // the prepared one, hidden
    playTo(r, MatchPhase.HALF_TIME);
    expect(r.router.current).toBe('half-time');
    expect(r.router.prepared).toBeNull();
    expect(r.made.get('half-time')).toBe(1); // the prepared instance is the one shown
    expect(r.live.get('match#1')).toEqual({ covered: true });
    playTo(r, MatchPhase.KICK_OFF);
    expect(r.router.current).toBe('match');
    expect(r.live.get('match#1')).toEqual({ covered: false });
    expect(r.mounted('half-time')).toEqual([]);
    expect(r.made.get('match')).toBe(1);
    playTo(r, MatchPhase.POST_MATCH);
    expect(r.session.finished).toBe(true);
    expect(r.router.current).toBe('full-time');
    expect(r.router.prepared).toBeNull();
    expect([...r.live.keys()]).toEqual(['full-time#2']);
    expect(r.badFrames).toEqual([]);
    expect(r.errors).toEqual([]);
    r.session.quit();
    expect(r.router.current).toBe('main');
    expect([...r.live.keys()]).toEqual(['main#2']);
  });

  it('pause during half time shows the match screen (uncovered, same instance) and resume covers it again', async () => {
    const r = sessionRig();
    r.session.start(setup(42));
    await flush();
    playTo(r, MatchPhase.HALF_TIME);
    r.advance(1000);
    r.session.pause(0);
    expect(r.router.current).toBe('match');
    expect(r.live.get('match#1')).toEqual({ covered: false });
    r.advance(1000);
    expect(r.session.resume(0)).toBe(true);
    expect(r.router.current).toBe('half-time');
    expect(r.live.get('match#1')).toEqual({ covered: true });
    expect(r.made.get('match')).toBe(1);
    expect(r.made.get('half-time')).toBe(2); // the prepared one was used and closed by the pause; this one is new
    expect(r.errors).toEqual([]);
  });

  it('quit or restart in the first half drops the prepared screen; the restarted match prepares its own', async () => {
    const r = sessionRig();
    r.session.start(setup(43));
    await flush();
    r.frames(10);
    r.session.restart();
    expect(r.router.prepared).toBeNull();
    await flush();
    expect(r.router.prepared).toBe('half-time');
    expect(r.mounted('half-time')).toEqual(['half-time#2']);
    r.session.quit();
    expect(r.router.prepared).toBeNull();
    expect(r.mounted('half-time')).toEqual([]);
    expect(r.root.children.map((c) => c.name)).toEqual(['main']);
  });

  it('practice and a shoot-out start never reach half time: nothing is built ahead', async () => {
    for (const mutate of [
      (c: MatchSetup['config']) => { c.mode = ModeId.PRACTICE; c.practice = PracticeKind.FREE_PLAY; c.startPhase = MatchPhase.IN_PLAY; },
      (c: MatchSetup['config']) => { c.mode = ModeId.SHOOT_OUT; c.startPhase = MatchPhase.SHOOT_OUT; c.cupRules = 1; },
    ]) {
      const r = sessionRig();
      r.session.start(setup(44, mutate));
      await flush();
      expect(r.router.current).toBe('match');
      expect(r.router.prepared).toBeNull();
      expect(r.errors).toEqual([]);
      r.session.dispose();
    }
  });

  it('halfTimeAhead: first halves of normal and extra time only, never practice, a finished match or partial states', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    expect(halfTimeAhead(s)).toBe(true);
    s.match.period = Period.SECOND_HALF;
    expect(halfTimeAhead(s)).toBe(false);
    s.match.period = Period.ET_FIRST;
    expect(halfTimeAhead(s)).toBe(true);
    s.match.phase = MatchPhase.HALF_TIME;
    expect(halfTimeAhead(s)).toBe(false);
    s.match.phase = MatchPhase.IN_PLAY;
    s.match.finished = 1;
    expect(halfTimeAhead(s)).toBe(false);
    s.match.finished = 0;
    s.config.mode = ModeId.PRACTICE;
    expect(halfTimeAhead(s)).toBe(false);
    expect(halfTimeAhead({} as SimState)).toBe(false);
  });

  it('the break before extra time builds the extra-time half-time screen a second in; full time drops it', async () => {
    const r = sessionRig();
    r.session.start(setup(45));
    await flush();
    playTo(r, MatchPhase.KICK_OFF); // into the second half via half time
    r.router.discardPrepared!();
    // Force the break before extra time (as the rules machine does after a cup draw).
    const st = r.session.runtime()!.curr;
    st.match.phase = MatchPhase.EXTRA_TIME;
    st.match.phaseT = 0;
    r.frames(1);
    expect(r.session.runtime()!.curr.match.phase).toBe(MatchPhase.EXTRA_TIME);
    expect(r.router.prepared).toBeNull(); // not in the frame the break starts (the match screen comes back then)
    const rt = r.session.runtime()!.curr;
    rt.match.phaseT = 70; // a second into the 3 s break
    r.frames(1);
    expect(r.session.runtime()!.curr.match.phase).toBe(MatchPhase.EXTRA_TIME);
    expect(r.router.prepared).toBe('half-time');
    expect(r.router.current).toBe('match');
    const s2 = r.session.runtime()!.curr;
    s2.match.phase = MatchPhase.FULL_TIME;
    s2.match.phaseT = 0;
    r.frames(1);
    expect(r.router.prepared).toBeNull();
    expect(r.mounted('half-time')).toEqual([]);
  });
});

describe('QF-17 lifecycle fuzz with layers (FIX-10, real session, router, loop and sim)', () => {
  it('12 seeds x 160 operations: the right screen, the match screen mounted once and covered exactly under half time, no frames to covered screens, no stray prepared screen', { timeout: 300_000 }, async () => {
    let halfTimes = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const r = sessionRig(seed);
      let a = (seed * 2654435761) >>> 0;
      const rnd = (): number => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const log: string[] = [];
      const check = (what: string): void => {
        const s = r.session;
        const tag = `seed ${seed} after ${what}\n${log.slice(-10).join('\n')}`;
        expect(r.errors, tag).toEqual([]);
        const cur = r.router.current;
        const matchMounted = r.mounted('match');
        expect(matchMounted.length, tag).toBeLessThanOrEqual(1);
        if (cur === 'match' || cur === 'half-time') expect(matchMounted.length, tag).toBe(1);
        const m = matchMounted[0] ? r.live.get(matchMounted[0])! : null;
        if (m) expect(m.covered, tag).toBe(cur === 'half-time');
        // Live screens = the layers (1, or 2 under half time) + at most one prepared half-time screen.
        const layers = cur === 'half-time' ? 2 : 1;
        expect(r.live.size - layers, tag).toBe(r.router.prepared ? 1 : 0);
        expect(r.root.children.length, tag).toBe(r.live.size);
        if (s.finished || (s.getState() && s.getState()!.match.phase === MatchPhase.FULL_TIME)) expect(r.router.prepared, tag).toBeNull();
        if (cur === 'half-time') halfTimes++;
      };
      for (let i = 0; i < 160; i++) {
        const s = r.session;
        const x = rnd();
        let what = '';
        if (!s.active || x < 0.01) { what = 'start'; s.start(setup(seed * 1000 + i)); await flush(); }
        else if (x < 0.1) { what = 'pause'; s.pause(0); }
        else if (x < 0.2) { what = 'resume'; r.advance(300); s.resume(0); }
        else if (x < 0.25) { what = 'hide/show'; s.setHidden(true); s.setHidden(false); r.advance(300); s.resume(-1); }
        else if (x < 0.27) { what = 'restart'; s.restart(); await flush(); }
        else if (x < 0.28) { what = 'quit'; s.quit(); }
        else if (x < 0.36) { what = 'SKIP'; s.queueCommand(0, Command.SKIP, 0); }
        else if (x < 0.5) {
          what = 'clock jump';
          const st = s.runtime()?.curr;
          if (st && st.match.clockRunning === 1 && (st.match.period === Period.FIRST_HALF || st.match.period === Period.SECOND_HALF)) {
            st.match.periodT = Math.max(st.match.periodT, st.match.periodLen - 30);
            st.match.addedT = 0;
          }
        } else {
          const n = 1 + Math.floor(rnd() * 40);
          what = `frames(${n})`;
          r.frames(n, () => check(what));
        }
        log.push(`${i} ${what} -> ${r.router.current} paused=${s.paused} phase=${s.getState()?.match.phase ?? '-'} prepared=${r.router.prepared}`);
        check(what);
      }
      expect(r.badFrames, `seed ${seed}`).toEqual([]);
      r.session.dispose();
    }
    expect(halfTimes).toBeGreaterThan(0);
  });
});

// ============================================================ screens (fake DOM)

describe('QF-17 match screen cover hooks and the half-time screen built ahead (fake DOM)', () => {
  const proto = (makeAppDom().screen.constructor as { prototype: FakeElement & { replaceChildren?: unknown } }).prototype;
  if (!proto.replaceChildren) {
    proto.replaceChildren = function (this: FakeElement, ...nodes: FakeElement[]) {
      while (this.children.length > 0) this.removeChild(this.children[0]!);
      for (const n of nodes) this.append(n);
    };
  }
  let ui: FakeElement;
  let doc: ReturnType<typeof makeAppDom>['doc'];
  beforeEach(() => {
    const dom = makeAppDom();
    ui = dom.ui;
    doc = dom.doc;
    dom.screen.remove();
    vi.stubGlobal('document', dom.doc);
    vi.stubGlobal('window', dom.win);
    resetTeamOrders();
  });
  afterEach(() => {
    while (closeTopModal()) { /* leftovers */ }
    vi.unstubAllGlobals();
  });

  function ctxFor(state: SimState | null, setupOverride?: MatchSetup) {
    const setupV: MatchSetup = setupOverride ?? { config: (state?.config ?? createMatchConfig()) as MatchSetup['config'], bindings: [{ human: 0, deviceIds: ['touch'] }] };
    const session = {
      active: true, paused: false, pausedBy: -1, finished: false,
      pause: vi.fn(function (this: { paused: boolean; pausedBy: number }, h: number) { this.paused = true; this.pausedBy = h; }),
      resume: vi.fn(function (this: { paused: boolean; pausedBy: number }) { this.paused = false; this.pausedBy = -1; return true; }),
      restart: vi.fn(), quit: vi.fn(), queueCommand: vi.fn(),
      getState: () => state, getSetup: () => setupV, runtime: () => (state ? { curr: state, frames: [] } : null),
    };
    const ctx = {
      session, clubs: CLUBS, audio: { playUi: vi.fn() },
      router: { go: vi.fn(), back: vi.fn() },
      settings: { get: () => createDefaultSettings(), update: vi.fn(), subscribe: () => () => undefined },
      devices: { lastActive: () => 'touch', list: () => [] },
      platform: { isTouch: true },
      focus: { attach: vi.fn(), detach: vi.fn(), focus: vi.fn(), handle: vi.fn(), onAction: () => () => undefined },
    } as unknown as AppContext;
    return { ctx, session };
  }

  function container(id: ScreenId): FakeElement {
    const c = doc.createElement('div');
    c.className = 'screen';
    c.dataset.screen = id;
    ui.appendChild(c);
    return c;
  }

  it('covered: body.match-covered (HUD and touch layers hidden), a stale pause menu hides, queued team orders are sent; uncovered: class gone, pause re-synced', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY });
    const { ctx, session } = ctxFor(s);
    const m = createMatchScreen();
    const c = container('match');
    m.mount(c as unknown as HTMLElement, ctx, {});
    // Paused with the menu up, then resumed: the session covers the screen (half time) before any frame re-syncs it.
    session.paused = true;
    m.onFrame!({ nowMs: 1000 } as never);
    expect(c.querySelector('[data-testid="pause-menu"]')!.hidden).toBe(false);
    const want = (s.teams[0]!.focus + 1) % 3;
    setFocusOrder(teamOrders(s, 0), s.teams[0]!, want);
    expect(teamOrders(s, 0).focus).toBe(want);
    session.paused = false;
    m.onCovered!();
    expect(doc.body.classList.contains(MATCH_COVERED_CLASS)).toBe(true);
    expect(c.querySelector('[data-testid="pause-menu"]')!.hidden).toBe(true);
    expect(session.queueCommand).toHaveBeenCalled();
    session.paused = true;
    m.onUncovered!();
    expect(doc.body.classList.contains(MATCH_COVERED_CLASS)).toBe(false);
    expect(c.querySelector('[data-testid="pause-menu"]')!.hidden).toBe(false);
    m.onCovered!();
    m.unmount();
    expect(doc.body.classList.contains(MATCH_COVERED_CLASS)).toBe(false);
    expect(doc.body.classList.contains('in-match')).toBe(false);
  });

  it('half time built ahead (no state yet): zero stats and both shortcuts; revealed in the break: score, stats, title and shortcuts brought up to date in place', () => {
    let state: SimState | null = null;
    const s = makeScenario({ humans: 1, phase: MatchPhase.HALF_TIME });
    const { ctx } = ctxFor(null, { config: s.config as MatchSetup['config'], bindings: [{ human: 0, deviceIds: ['touch'] }] });
    (ctx.session as unknown as { getState: () => SimState | null }).getState = () => state;
    const ht = createHalfTimeScreen();
    const c = container('half-time');
    ht.mount(c as unknown as HTMLElement, ctx, {});
    const q = (id: string) => c.querySelector(`[data-testid="${id}"]`);
    expect(q('ht-stats')).not.toBeNull();
    for (const k of HALF_STAT_KEYS) expect(q(`stat-${k}`)).not.toBeNull();
    expect(q('stat-shots-home')!.textContent).toBe('0');
    expect(q('ht-team')).not.toBeNull();
    expect(q('ht-tactics')).not.toBeNull();
    const statsEl = q('ht-stats');
    // The break: 2-1, extra time, a replay (no shortcuts), stats from the tracker.
    s.teams[0]!.goals = 2;
    s.teams[1]!.goals = 1;
    s.match.period = Period.ET_FIRST;
    state = s;
    const summary = { teams: [{ goals: 2, shots: 7, shotsOnTarget: 3, possession: 0.6, passes: 50, passesCompleted: 40, tackles: 1, tacklesWon: 1, fouls: 2, yellow: 0, red: 0, offsides: 0, corners: 4, saves: 0, interceptions: 0 },
      { goals: 1, shots: 3, shotsOnTarget: 1, possession: 0.4, passes: 30, passesCompleted: 20, tackles: 2, tacklesWon: 1, fouls: 5, yellow: 0, red: 0, offsides: 0, corners: 1, saves: 2, interceptions: 0 }],
      players: [], goals: [], playerOfMatch: null, shootout: null, winner: -1, forfeit: -1, ticks: 1 };
    (ctx.session as unknown as { runtime: () => unknown }).runtime = () => ({ curr: s, frames: [], stats: { summary: () => summary } });
    (ctx.session as unknown as { getSetup: () => MatchSetup }).getSetup = () => ({ config: s.config as MatchSetup['config'], bindings: [], inputProvider: {} as never, modeData: { replay: true } } as unknown as MatchSetup);
    ht.onReveal!();
    expect(q('brk-goals-0')!.textContent).toBe('2');
    expect(q('brk-goals-1')!.textContent).toBe('1');
    expect(q('half-time-title')!.textContent).toBe('Extra time · half time');
    expect(q('ht-continue')!.textContent).toBe('Continue');
    expect(q('stat-shots-home')!.textContent).toBe('7');
    expect(q('stat-possession-home')!.textContent).toBe('60%');
    expect(q('stat-passes-away')!.textContent).toBe('20/30');
    expect(q('ht-stats')).toBe(statsEl); // updated in place, not rebuilt
    expect(q('ht-team')).toBeNull();
    expect(q('ht-tactics')).toBeNull();
    ht.unmount();
  });

  it('a half-time screen mounted the usual way (state present) builds what it built before: no stats without a tracker', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.HALF_TIME });
    const { ctx } = ctxFor(s);
    const ht = createHalfTimeScreen();
    const c = container('half-time');
    ht.mount(c as unknown as HTMLElement, ctx, {});
    expect(c.querySelector('[data-testid="ht-stats"]')).toBeNull();
    expect(c.querySelector('[data-testid="ht-team"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="half-time-title"]')!.textContent).toBe('Half time');
    ht.unmount();
  });

  it('a modal opened while a hidden prepared screen is the last screen goes on the visible screen, not into the hidden one', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY });
    const { ctx } = ctxFor(s);
    const visible = container('match');
    const hidden = container('half-time');
    hidden.setAttribute('data-prepared', '');
    openModal(ctx, { title: 'Quit match?', testId: 'qf17-modal' });
    expect(visible.querySelector('[data-testid="qf17-modal"]')).not.toBeNull();
    expect(hidden.querySelector('[data-testid="qf17-modal"]')).toBeNull();
  });
});
