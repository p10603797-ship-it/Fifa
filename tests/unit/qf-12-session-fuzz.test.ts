/**
 * [QF-12] Session lifecycle fuzz (FIX-11 follow-up: pause rules, hidden page, rematch / quit, half-time / full-time
 * screens): the real session, router, loop and sim step with fake presentation and two local humans on two pads.
 * Seeded random sequences of start, pause / resume / requestPause by either human or the system, hide / show, block /
 * unblock, restart, quit, hand-to-CPU, SKIP, clock jumps toward half-time and full time, and frames of play.
 * After every operation:
 *  - nothing is reported through onError and nothing throws;
 *  - the router shows what the session state calls for (main without a match; loading while it loads; the match
 *    screen while paused; half-time / full-time in those phases; the final full-time screen once finished);
 *  - ticking is exactly loaded && !paused && !finished && !hidden && !blocked;
 *  - a human pause refuses the other human, and nobody is ever locked out: with the page shown and unblocked the
 *    pauser (or anyone, for a system pause or a pauser handed to the CPU) can always resume.
 * [QF-17] FIX-11: deterministic. restart() drew its new match seed from Math.random (the session's default newSeed),
 * so every run walked different matches and the coverage asserts passed or failed by chance; the rig now hands the
 * session a seeded newSeed, so a seed list always replays the same walk. The phases the walk went through are recorded
 * on every tick (the session's onTick hook) instead of being sampled once per operation, where a whole half-time break
 * could fall between two samples, and the screen / ticking checks also run after every frame of play.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSetup, Screen, ScreenId } from '../../src/contracts/app';
import { Command, ControllerKind, MatchPhase, Period } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createLoop } from '../../src/app/loop';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession, PAUSE_DEBOUNCE_MS } from '../../src/app/session';
import type { AppSession } from '../../src/app/types';

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RigHooks {
  /** Seed of the walk: restart() seeds derive from it (default 1). */
  seed?: number;
  /** Every tick (session onTick, before phase watching). */
  onTick?(phase: number): void;
  /** After every frame of play. */
  afterFrame?(): void;
}

function rig(hooks: RigHooks = {}) {
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
  }
  router.go('main');
  const renderer = createNullRenderer();
  const hud = { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() };
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const devices: DeviceRegistry = {
    list: () => [
      { id: 'pad:1', kind: 'pad', label: 'Pad 1', connected: true } as never,
      { id: 'pad:2', kind: 'pad', label: 'Pad 2', connected: true } as never,
    ],
    subscribe: () => () => undefined,
    lastActive: () => null,
    createSource: ((id: string) => ({ id, kind: 'pad', sample() {}, releaseAll() {}, dispose() {} })) as never,
  };
  const diagnostics = { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' };
  const errors: string[] = [];
  let now = 1000;
  let restarts = 0;
  const session = createSession({
    router, renderer, hud, audio, devices, diagnostics, clubs: CLUBS, getProjector: () => null,
    onError: (err, where) => errors.push(`${where}: ${String(err)}`),
    yieldFrame: () => Promise.resolve(), now: () => now,
    onTick: hooks.onTick ? (rt) => hooks.onTick!(rt.curr.match.phase) : undefined,
    // Never Math.random (the default): the same seed must replay the same walk.
    newSeed: () => (Math.imul((hooks.seed ?? 1) >>> 0, 0x9e3779b1) ^ Math.imul(++restarts, 0x85ebca6b)) >>> 0,
  }) as AppSession;
  let frameT = 0;
  const loop = createLoop({
    session, renderer, hud, audio, router, getProjector: () => null, onError: (err, where) => errors.push(`${where}: ${String(err)}`),
    raf: () => 1, caf: () => undefined, now: () => 0,
  });
  loop.start();
  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) {
      frameT += 50; // 3 ticks per frame
      now += 50;
      loop.frame(frameT);
      hooks.afterFrame?.();
    }
  };
  return { router, session, errors, loop, frames, advance: (ms: number) => { now += ms; } };
}

function twoHumanSetup(seed: number, onFinish?: MatchSetup['onFinish']): MatchSetup {
  const config = createMatchConfig();
  config.seed = seed;
  config.halfMinutes = 2;
  config.humans = [
    { ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 },
    { ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 1 },
  ];
  return { config, bindings: [{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['pad:2'] }], onFinish };
}

/** What the router must show for the session's state. */
function expectedScreen(s: AppSession): ScreenId[] {
  if (!s.active) return ['main'];
  if (!s.loaded) return ['loading'];
  if (s.finished) return ['full-time'];
  if (s.paused) return ['match'];
  const ph = s.getState()!.match.phase;
  if (ph === MatchPhase.HALF_TIME) return ['half-time'];
  if (ph === MatchPhase.FULL_TIME) return ['full-time'];
  return ['match'];
}

async function fuzz(seed: number, ops: number): Promise<{ log: string[]; phases: Set<number>; finishes: number; completed: number; frameChecks: number }> {
  const phases = new Set<number>();
  let hidden = false;
  let blocked = false;
  let finishes = 0;
  let completed = 0;
  let frameChecks = 0;
  const log: string[] = [];
  // Late-bound: the per-frame check needs the rig it is passed to.
  let frameCheck: () => void = () => undefined;
  const r = rig({ seed, onTick: (phase) => phases.add(phase), afterFrame: () => frameCheck() });
  const rnd = mulberry(seed);
  // onFinish runs for a match played to its end (quit false) and for a quit (quit true).
  const onFinish = (_summary: unknown, quit: boolean): void => {
    finishes++;
    if (!quit) completed++;
  };
  const check = (what: string): void => {
    const s = r.session;
    const ctx = `seed ${seed} after ${what}\n${log.slice(-12).join('\n')}`;
    expect(r.errors, ctx).toEqual([]);
    expect(expectedScreen(s), ctx).toContain(r.router.current);
    expect(s.ticking, ctx).toBe(s.active && s.loaded && !s.paused && !s.finished && !hidden && !blocked);
    if (s.paused) expect([-1, 0, 1], ctx).toContain(s.pausedBy);
    const st = s.getState();
    if (st) phases.add(st.match.phase);
  };
  frameCheck = () => {
    frameChecks++;
    check(`frame ${frameChecks}`);
  };
  for (let i = 0; i < ops; i++) {
    const s = r.session;
    const x = rnd();
    const h = Math.floor(rnd() * 3) - 1; // -1, 0, 1
    let what: string;
    if (!s.active || x < 0.005) {
      what = 'start';
      s.start(twoHumanSetup((seed * 1000 + i) >>> 0, onFinish));
      await flush();
    } else if (x < 0.1) {
      what = `pause(${h})`;
      s.pause(h);
    } else if (x < 0.2) {
      what = `resume(${h})`;
      const before = { paused: s.paused, by: s.pausedBy };
      const ok = s.resume(h);
      if (before.paused && before.by >= 0 && h >= 0 && h !== before.by) expect(ok, `seed ${seed}: human ${h} resumed a pause by ${before.by}`).toBe(false);
    } else if (x < 0.27) {
      what = `requestPause(${h})`;
      r.advance(PAUSE_DEBOUNCE_MS + 1);
      s.requestPause(h);
    } else if (x < 0.32) {
      hidden = !hidden;
      what = `setHidden(${hidden})`;
      s.setHidden(hidden);
    } else if (x < 0.36) {
      blocked = !blocked;
      what = `setBlocked(${blocked})`;
      s.setBlocked(blocked);
    } else if (x < 0.365) {
      what = 'restart';
      s.restart();
      await flush();
    } else if (x < 0.37) {
      what = 'quit';
      s.quit();
    } else if (x < 0.39) {
      what = `setHumanDevice(${h < 0 ? 1 : h}, cpu)`;
      s.setHumanDevice(h < 0 ? 1 : h, 'cpu');
    } else if (x < 0.47) {
      what = 'SKIP';
      s.queueCommand(h < 0 ? 0 : h, Command.SKIP, 0);
    } else if (x < 0.6) {
      what = 'clock jump';
      const st = s.runtime()?.curr; // the mutable state (getState() is read-only)
      if (st && (st.match.period === Period.FIRST_HALF || st.match.period === Period.SECOND_HALF) && st.match.clockRunning === 1) {
        st.match.periodT = Math.max(st.match.periodT, st.match.periodLen - 30);
        st.match.addedT = 0;
      } else if (st && (st.match.phase === MatchPhase.HALF_TIME || st.match.phase === MatchPhase.FULL_TIME)) {
        // [QF-17] A break jumps too (Continue), so walks get past half time to full time in their own match.
        what = 'clock jump (SKIP)';
        s.queueCommand(h < 0 ? 0 : h, Command.SKIP, 0);
      }
    } else {
      // Play on (unpausing first now and then, so the walk gets past the breaks to full time).
      if (s.paused && !hidden && !blocked && rnd() < 0.5) s.resume(s.pausedBy);
      const n = 1 + Math.floor(rnd() * 60);
      what = `frames(${n})`;
      r.frames(n);
    }
    log.push(`${i} ${what} -> ${r.router.current} paused=${s.paused}/${s.pausedBy} phase=${s.getState()?.match.phase ?? '-'}`);
    check(what);
    // Never locked out: with the page shown and unblocked, a paused match can always be resumed by someone.
    if (s.active && s.loaded && s.paused && !hidden && !blocked && rnd() < 0.3) {
      const by = s.pausedBy;
      const ok = s.resume(by) || s.resume(0) || s.resume(1) || s.resume(-1);
      expect(ok, `seed ${seed}: nobody could resume a pause by ${by}\n${log.slice(-12).join('\n')}`).toBe(true);
      log.push(`${i} unlock-resume -> ${r.router.current}`);
      check('unlock-resume');
    }
  }
  r.session.dispose();
  return { log, phases, finishes, completed, frameChecks };
}

describe('QF-12 session lifecycle fuzz (real session, router, loop and sim)', () => {
  it('24 seeds x 250 random lifecycle operations: right screen, right ticking, no lock-out, no errors', { timeout: 300_000 }, async () => {
    const seen = new Set<number>();
    let finishes = 0;
    let completed = 0;
    let frameChecks = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const r = await fuzz(seed, 250);
      for (const p of r.phases) seen.add(p);
      finishes += r.finishes;
      completed += r.completed;
      frameChecks += r.frameChecks;
    }
    // The walk reaches the break screens, full time and the final screen (not only the opening kick-off). Every
    // tick's phase is recorded, so a break that starts and ends inside one frames() operation still counts; the walk
    // is the same on every run (seeded restarts). `finishes` alone also counted quits (onFinish(summary, true)), so
    // a match played to its end is counted on its own.
    expect(seen.has(MatchPhase.HALF_TIME)).toBe(true);
    expect(seen.has(MatchPhase.FULL_TIME)).toBe(true);
    expect(seen.has(MatchPhase.POST_MATCH)).toBe(true);
    expect(finishes).toBeGreaterThan(0);
    expect(completed).toBeGreaterThan(0);
    expect(frameChecks).toBeGreaterThan(1000);
  });
});

describe('QF-17 FIX-11 session fuzz determinism', () => {
  it('the same seed replays the same walk: operations, screens, pauses and phases (no Math.random, no timers)', { timeout: 120_000 }, async () => {
    const a = await fuzz(17, 150);
    const b = await fuzz(17, 150);
    expect(b.log).toEqual(a.log);
    expect([...b.phases].sort()).toEqual([...a.phases].sort());
    // restart() takes the rig's seeded newSeed (the session default is Math.random): same seed, same rematch.
    const seeds: number[] = [];
    for (let k = 0; k < 2; k++) {
      const r = rig({ seed: 5 });
      r.session.start(twoHumanSetup(9));
      await flush();
      r.session.restart();
      await flush();
      seeds.push(r.session.getSetup()!.config.seed);
      r.session.dispose();
    }
    expect(seeds[0]).toBe(seeds[1]);
    expect(seeds[0]).not.toBe(9);
  });
});

describe('QF-12 local 1v1 pause ownership (real session)', () => {
  it('glitch: both players pausing at once - same frame or 0.3 s apart, either order: one pause owned by the first, the other press neither resumes nor steals it, only the owner resumes', async () => {
    for (const first of [0, 1]) {
      for (const gapMs of [0, 10, PAUSE_DEBOUNCE_MS + 50]) {
        const r = rig();
        r.session.start(twoHumanSetup(500 + first * 10 + gapMs));
        await flush();
        r.frames(5);
        const second = 1 - first;
        r.advance(PAUSE_DEBOUNCE_MS + 1);
        r.session.requestPause(first);
        r.advance(gapMs);
        r.session.requestPause(second);
        const tag = `first ${first}, gap ${gapMs} ms`;
        expect(r.session.paused, tag).toBe(true);
        expect(r.session.pausedBy, tag).toBe(first);
        expect(r.router.current, tag).toBe('match');
        expect(r.session.resume(second), tag).toBe(false);
        expect(r.session.paused, tag).toBe(true);
        r.advance(PAUSE_DEBOUNCE_MS + 1);
        r.session.requestPause(second); // the other player's button again: still refused
        expect(r.session.pausedBy, tag).toBe(first);
        r.advance(PAUSE_DEBOUNCE_MS + 1);
        r.session.requestPause(first); // the owner's button resumes
        expect(r.session.paused, tag).toBe(false);
        expect(r.session.ticking, tag).toBe(true);
        r.frames(3);
        expect(r.errors, tag).toEqual([]);
        r.session.dispose();
      }
    }
  });
});
