/**
 * [QF-17 skeptic] FIX-10 half-time hitch, second pass: defects the first QF-17 pass left.
 *  - D-S1: a visit to the pause menu's settings / controls / remap screen in the first half dropped the half-time
 *    screen built ahead (the router unmounted it whenever a non-base screen mounted), so that match's half time was a
 *    fresh mount again (the old ~20 ms hitch at 4x). The router now takes the prepared container out of the DOM (no
 *    hidden duplicate test ids under the other screen) and keeps the instance; back on the match screen it goes over
 *    it again and the half time reveals it.
 *  - D-S2: the match screen kept under the half-time overlay was fully exposed: its own pause button (keyboard / pad /
 *    mouse play) showed through the half-time scrim as a dimmed icon in the corner, and assistive tech could reach its
 *    controls under the overlay (before QF-17 the match screen was not in the DOM during half time). A covered screen's
 *    container now carries aria-hidden, and the covered match screen hides its pause button (visibility, no layout).
 * Router + real session + loop + sim over fake containers; the match screen CSS over the uix-01 fake DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSetup, ScreenId } from '../../src/contracts/app';
import { Command, ControllerKind, MatchPhase, Period } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createLoop } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import type { AppRouter, AppSession, LayeredScreen } from '../../src/app/types';
import { SCREEN_OVERLAYS } from '../../src/ui/index';
import { createMatchScreen, MATCH_COVERED_CLASS } from '../../src/ui/screens/match';
import { makeScenario } from '../harness/scenario';
import { makeAppDom } from './uix-01-fakedom';

// ============================================================ fakes

interface FakeContainer {
  name: ScreenId;
  style: { opacity: string; transform: string };
  attrs: Map<string, string>;
  parentNode: FakeRoot | null;
  setAttribute(k: string, v: string): void;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  getAttribute(k: string): string | null;
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
    getAttribute(k) { return c.attrs.get(k) ?? null; },
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

const SCREENS: ScreenId[] = ['main', 'loading', 'match', 'half-time', 'full-time', 'settings', 'controls-editor', 'remap'];

/** Real session + loop + sim over a router with the app's overlay config and recording screens. */
function rig(seed = 1) {
  const root = fakeRoot();
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const errors: string[] = [];
  const router: AppRouter = createRouter(root as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: (id) => fakeContainer(id) as unknown as HTMLElement,
    overlays: SCREEN_OVERLAYS,
    onError: (err, where) => errors.push(`${where}: ${String(err)}`),
  });
  const live = new Map<string, { covered: boolean; container: FakeContainer; revealed: number }>();
  const made = new Map<ScreenId, number>();
  for (const id of SCREENS) {
    router.register(id, (): LayeredScreen => {
      const n = (made.get(id) ?? 0) + 1;
      made.set(id, n);
      const tag = `${id}#${n}`;
      return {
        id,
        mount(c: HTMLElement) { live.set(tag, { covered: false, container: c as unknown as FakeContainer, revealed: 0 }); },
        unmount() { live.delete(tag); },
        onCovered() { live.get(tag)!.covered = true; },
        onUncovered() { live.get(tag)!.covered = false; },
        onReveal() { live.get(tag)!.revealed++; },
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
  const tags = (id: ScreenId): string[] => [...live.keys()].filter((k) => k.startsWith(`${id}#`));
  const order = (): string[] => root.children.map((c) => `${c.name}${c.hasAttribute('data-prepared') ? '(prepared)' : ''}`);
  return { router, root, session, errors, frames, live, made, tags, order, advance: (ms: number) => { now += ms; } };
}

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function setup(seed: number): MatchSetup {
  const config = createMatchConfig();
  config.seed = seed;
  config.halfMinutes = 2;
  config.humans = [{ ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 }, { ...config.humans[1]! }];
  return { config, bindings: [{ human: 0, deviceIds: ['pad:1'] }] };
}

/** Jump the running half's clock to its end and play until the phase is `want` (Continue through other breaks). */
function playTo(r: ReturnType<typeof rig>, want: MatchPhase, maxFrames = 4000): void {
  for (let i = 0; i < maxFrames; i++) {
    const st = r.session.runtime()?.curr;
    if (!st || st.match.phase === want) return;
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

/** What the pause menu's leaveTo() does: pause, open a full screen, come back with its Back button, resume. */
function visitFromPause(r: ReturnType<typeof rig>, id: ScreenId): void {
  r.advance(1000);
  r.session.pause(0);
  expect(r.router.current).toBe('match');
  r.router.go(id);
  r.router.back();
  expect(r.router.current).toBe('match');
  r.advance(1000);
  expect(r.session.resume(0)).toBe(true);
}

// ============================================================ D-S1

describe('QF-17 skeptic D-S1: the half-time screen built ahead survives a visit to settings, controls or remap', () => {
  it('pause menu -> settings / controls / remap -> back in the first half: half time still reveals the screen built on the loading screen (no fresh mount)', async () => {
    for (const id of ['settings', 'controls-editor', 'remap'] as ScreenId[]) {
      const r = rig();
      r.session.start(setup(71));
      await flush();
      expect(r.router.prepared, id).toBe('half-time');
      const prepared = r.live.get('half-time#1')!.container;
      r.frames(20);
      r.advance(1000);
      r.session.pause(0);
      r.router.go(id);
      // While the other screen shows, the prepared container is out of the DOM (no hidden duplicate test ids), kept.
      expect(r.order(), id).toEqual([id]);
      expect(prepared.parentNode, id).toBeNull();
      expect(r.router.prepared, id).toBe('half-time');
      r.router.back();
      // The match screen is mounted again (a new instance) and the prepared overlay goes back over it, still hidden.
      expect(r.order(), id).toEqual(['match', 'half-time(prepared)']);
      expect(r.root.children[1], id).toBe(prepared);
      r.advance(1000);
      expect(r.session.resume(0), id).toBe(true);
      playTo(r, MatchPhase.HALF_TIME);
      expect(r.router.current, id).toBe('half-time');
      expect(r.made.get('half-time'), id).toBe(1); // the instance built on the loading screen, revealed
      expect(r.live.get('half-time#1')!.revealed, id).toBe(1);
      expect(r.order(), id).toEqual(['match', 'half-time']);
      expect(r.live.get('match#2')!.covered, id).toBe(true);
      playTo(r, MatchPhase.KICK_OFF);
      expect(r.router.current, id).toBe('match');
      expect(r.order(), id).toEqual(['match']);
      expect(r.errors, id).toEqual([]);
      r.session.dispose();
    }
  });

  it('quit in the first half, or from the settings screen while the screen built ahead is out of the DOM, drops it (nothing leaks)', async () => {
    const r = rig();
    r.session.start(setup(72));
    await flush();
    r.session.quit();
    expect(r.router.prepared).toBeNull();
    expect(r.tags('half-time')).toEqual([]);
    r.session.start(setup(73));
    await flush();
    r.advance(1000);
    r.session.pause(0);
    r.router.go('settings');
    expect(r.router.prepared).toBe('half-time');
    r.session.quit(); // from the settings screen: teardown drops the detached instance (nothing leaks)
    expect(r.router.prepared).toBeNull();
    expect(r.tags('half-time')).toEqual([]);
    expect(r.order()).toEqual(['main']);
    expect(r.errors).toEqual([]);
  });

  it('seeded fuzz, 8 seeds x 140 operations with settings / controls / remap visits: at most one half-time instance, the prepared one is in the DOM only over the match screen (last, hidden), and a first half time with a screen built ahead always reveals it', { timeout: 300_000 }, async () => {
    let reveals = 0;
    let visits = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = rig(seed);
      let a = (seed * 0x2545f491) >>> 0;
      const rnd = (): number => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
      const log: string[] = [];
      let lastCur: ScreenId | null = null;
      let preparedAtHt: string | null = null;
      const check = (what: string): void => {
        const tag = `seed ${seed} after ${what}\n${log.slice(-10).join('\n')}`;
        expect(r.errors, tag).toEqual([]);
        const cur = r.router.current;
        const hts = r.tags('half-time');
        expect(hts.length, tag).toBeLessThanOrEqual(1);
        const inDom = r.root.children.filter((c) => c.name === 'half-time');
        expect(inDom.length, tag).toBeLessThanOrEqual(1);
        if (r.router.prepared) {
          const pc = r.live.get(hts[0]!)!.container;
          expect(pc.hasAttribute('data-prepared'), tag).toBe(true);
          if (pc.parentNode) {
            expect(cur === 'match' || cur === 'loading', tag).toBe(true);
            expect(r.root.children[r.root.children.length - 1], tag).toBe(pc);
          } else {
            expect(cur !== 'match', tag).toBe(true);
          }
        }
        // Entering half time: the screen built ahead (if any was left at the end of the previous step) is the one shown.
        if (cur === 'half-time' && lastCur !== 'half-time' && preparedAtHt) {
          expect(hts[0], tag).toBe(preparedAtHt);
          reveals++;
        }
        if (cur === 'half-time') {
          expect(r.order(), tag).toEqual(['match', 'half-time']);
          // D-S2: the covered match container is out of the accessibility tree; uncovered, it is back.
          expect(r.root.children[0]!.getAttribute('aria-hidden'), tag).toBe('true');
        } else if (cur === 'match') {
          expect(r.root.children[0]!.hasAttribute('aria-hidden'), tag).toBe(false);
        }
        lastCur = cur;
        preparedAtHt = r.router.prepared ? hts[0]! : null;
      };
      for (let i = 0; i < 140; i++) {
        const s = r.session;
        const x = rnd();
        let what = '';
        if (!s.active || x < 0.01) { what = 'start'; s.start(setup(seed * 1000 + i)); await flush(); }
        else if (x < 0.14) {
          const id = (['settings', 'controls-editor', 'remap'] as ScreenId[])[Math.floor(rnd() * 3)]!;
          what = `visit ${id}`;
          if (s.loaded && !s.finished && r.router.current === 'match' && s.getState()!.match.phase !== MatchPhase.HALF_TIME) {
            visitFromPause(r, id);
            visits++;
          }
        } else if (x < 0.2) { what = 'pause'; r.advance(300); s.pause(0); }
        else if (x < 0.28) { what = 'resume'; r.advance(300); s.resume(0); }
        else if (x < 0.29) { what = 'restart'; s.restart(); await flush(); }
        else if (x < 0.3) { what = 'quit'; s.quit(); }
        else if (x < 0.38) { what = 'SKIP'; s.queueCommand(0, Command.SKIP, 0); }
        else if (x < 0.52) {
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
      r.session.dispose();
      // Nothing built ahead is left behind (a half-time screen still showing stays: the router outlives the session).
      expect(r.router.prepared, `seed ${seed}`).toBeNull();
      expect(r.tags('half-time').length, `seed ${seed}`).toBe(r.router.mounted!.includes('half-time') ? 1 : 0);
    }
    expect(visits).toBeGreaterThan(20);
    expect(reveals).toBeGreaterThan(0);
  });
});

// ============================================================ D-S2

describe('QF-17 skeptic D-S2: the match screen under the half-time overlay is not exposed', () => {
  it('router: a covered container carries aria-hidden; uncovered (kick-off, pause at half time) it is gone; a pause-time remount has none', async () => {
    const r = rig();
    r.session.start(setup(74));
    await flush();
    const match = r.root.children[0]!;
    expect(match.name).toBe('match');
    expect(match.hasAttribute('aria-hidden')).toBe(false);
    playTo(r, MatchPhase.HALF_TIME);
    expect(match.getAttribute('aria-hidden')).toBe('true');
    expect(r.root.children[1]!.hasAttribute('aria-hidden')).toBe(false); // the revealed overlay
    r.advance(1000);
    r.session.pause(0); // pause at half time: the match screen (with its menu) is the current screen again
    expect(r.router.current).toBe('match');
    expect(match.hasAttribute('aria-hidden')).toBe(false);
    r.advance(1000);
    r.session.resume(0);
    expect(match.getAttribute('aria-hidden')).toBe('true');
    playTo(r, MatchPhase.KICK_OFF);
    expect(r.router.current).toBe('match');
    expect(match.hasAttribute('aria-hidden')).toBe(false);
    expect(r.errors).toEqual([]);
    r.session.dispose();
  });

  describe('match screen (fake DOM)', () => {
    beforeEach(() => {
      const dom = makeAppDom();
      dom.screen.remove();
      vi.stubGlobal('document', dom.doc);
      vi.stubGlobal('window', dom.win);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('its own pause button (keyboard / pad play) is hidden by the covered style, not left showing through the half-time scrim', () => {
      const s = makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY });
      const setupV = { config: s.config, bindings: [{ human: 0, deviceIds: ['keyboard'] }] } as unknown as MatchSetup;
      const ctx = {
        session: {
          active: true, paused: false, pausedBy: -1, finished: false, pause: vi.fn(), resume: vi.fn(), queueCommand: vi.fn(),
          getState: () => s, getSetup: () => setupV, runtime: () => ({ curr: s, frames: [] }),
        },
        clubs: CLUBS, audio: { playUi: vi.fn() }, router: { go: vi.fn(), back: vi.fn() },
        settings: { get: () => createDefaultSettings(), update: vi.fn(), subscribe: () => () => undefined },
        devices: { lastActive: () => 'keyboard', list: () => [{ id: 'keyboard', kind: 'keyboard', connected: true }] },
        platform: { isTouch: false },
        focus: { attach: vi.fn(), detach: vi.fn(), focus: vi.fn(), handle: vi.fn(), onAction: () => () => undefined },
      } as unknown as AppContext;
      const doc = (globalThis as unknown as { document: Document }).document;
      const c = doc.createElement('div');
      doc.getElementById('ui')!.appendChild(c);
      const m = createMatchScreen();
      m.mount(c as unknown as HTMLElement, ctx, {});
      const btn = c.querySelector<HTMLElement>('[data-testid="match-pause"]')!;
      expect(btn.hidden).toBe(false); // no touch device bound: the screen shows its own pause button
      m.onCovered!();
      expect(doc.body.classList.contains(MATCH_COVERED_CLASS)).toBe(true);
      // The covered rule hides it by visibility (no layout); the HUD / touch rule alone left it at 22 % through the scrim.
      const css = doc.getElementById('style-match')!.textContent ?? '';
      const rule = /body\.match-covered\s+\.screen--match\s+\.match-pause\s*\{\s*visibility:\s*hidden;?\s*\}/;
      expect(css).toMatch(rule);
      expect(btn.classList.contains('match-pause')).toBe(true);
      expect(c.classList.contains('screen--match')).toBe(true);
      m.onUncovered!();
      expect(doc.body.classList.contains(MATCH_COVERED_CLASS)).toBe(false);
      expect(btn.hidden).toBe(false);
      m.unmount();
    });
  });
});
