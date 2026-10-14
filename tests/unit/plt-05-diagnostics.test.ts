/**
 * [PLT-05] Diagnostics ring buffer, levels and report; global error handler (recovery) with its loop guard and the
 * Resume sanity check; debug overlay helpers (corner taps, pads, pointers, frame bands); diagnostics screen helpers
 * (hold-to-close, replay file validation). Node, no DOM.
 */
import { describe, expect, it } from 'vitest';
import type { AppContext, PlatformInfo, ScreenId, ScreenParams, SettingsStore } from '../../src/contracts/app';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { initMatch } from '../../src/sim/init';
import { createDiagnostics, describeData, formatLogLine, levelOf, MAX_LINE_CHARS } from '../../src/platform/diagnostics';
import {
  currentRecovery, describeError, installRecovery, isBenignError, isRecoveryScreenError, isStateSane,
} from '../../src/platform/recovery';
import { createMemoryStorage } from '../../src/platform/storage';
import { createSettingsStore, SETTINGS_KEY } from '../../src/platform/settingsStore';
import { appReplayRecorder } from '../../src/platform/replayRecorder';
import {
  createCornerTapDetector, createPointerTracker, describePad, frameBand, phaseName,
} from '../../src/ui/debugOverlay';
import { createHoldDetector, readReplayText } from '../../src/ui/screens/diagnostics';
import { canResume, resumeNavigation } from '../../src/ui/screens/recovery';

function fakeSettings(): SettingsStore & { s: Settings } {
  const subs: ((s: Readonly<Settings>) => void)[] = [];
  const store = {
    s: createDefaultSettings(),
    get() { return store.s; },
    update(mut: (s: Settings) => void) { const n = structuredClone(store.s); mut(n); store.s = n; for (const f of subs) f(n); },
    subscribe(fn: (s: Readonly<Settings>) => void) { subs.push(fn); return () => subs.splice(subs.indexOf(fn), 1); },
    reset() { store.s = createDefaultSettings(); },
    persistent: false,
    loadProgress: () => null,
    saveProgress: () => undefined,
    clearProgress: () => undefined,
  };
  return store;
}

describe('PLT-05 diagnostics', () => {
  it('keeps the last N lines in order, with levels and counts', () => {
    let t = 0;
    const d = createDiagnostics(fakeSettings(), { capacity: 8, now: () => (t += 1000) });
    for (let i = 0; i < 12; i++) d.log(i % 3 === 0 ? 'error' : i % 3 === 1 ? 'warn' : 'boot', `line ${i}`);
    const r = d.recent();
    expect(r).toHaveLength(8);
    expect(r[0]).toContain('line 4');
    expect(r[7]).toContain('line 11');
    expect(r[7]).toMatch(/^12\.00s \[boot\] line 11$/);
    expect(d.total).toBe(12);
    expect(d.count('error')).toBe(4);
    expect(d.count('warn')).toBe(4);
    expect(d.count('info')).toBe(4);
    expect(d.recentAtLeast('error').every((l) => l.includes('[error]'))).toBe(true);
    expect(d.recentAtLeast('warn')).toHaveLength(5);
    expect(d.lastError).toBe('line 9');
    d.clear();
    expect(d.recent()).toHaveLength(0);
    expect(d.lastError).toBeNull();
  });

  it('levels, data formatting and line capping', () => {
    expect(levelOf('error')).toBe('error');
    expect(levelOf('warning')).toBe('warn');
    expect(levelOf('debug')).toBe('debug');
    expect(levelOf('storage')).toBe('info');
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(describeData(cyc)).toBe('[object Object]');
    expect(describeData({ a: 1 })).toBe('{"a":1}');
    expect(describeData(undefined)).toBe('');
    expect(formatLogLine(1500, 'x', 'y'.repeat(5000)).length).toBe(MAX_LINE_CHARS + 3);
  });

  it('report has version, storage, settings, sections (a throwing one is contained) and the log', () => {
    const d = createDiagnostics(fakeSettings(), { wallClock: () => new Date(0) });
    d.log('boot', 'hello');
    d.addSection('Match', () => 'seed 7, tick 42');
    d.addSection('Broken', () => { throw new Error('nope'); });
    d.addSection('Match', () => 'seed 8, tick 43'); // same name replaces
    const text = d.report();
    expect(text).toMatch(/^DotKick \d+\.\d+\.\d+ \(sim \d+\)/);
    expect(text).toContain('Time: 1970-01-01T00:00:00.000Z');
    expect(text).toContain('Storage: memory only');
    expect(text).toContain('Settings: {');
    expect(text).toContain('Match: seed 8, tick 43');
    expect(text).not.toContain('seed 7');
    expect(text).toContain('Broken: unavailable (Error: nope)');
    expect(text).toContain('[boot] hello');
    d.removeSection('Broken');
    expect(d.report()).not.toContain('Broken');
  });

  it('setDebug flips settings.debug only on change', () => {
    const st = fakeSettings();
    const d = createDiagnostics(st);
    let updates = 0;
    st.subscribe(() => updates++);
    d.setDebug(false);
    expect(updates).toBe(0);
    d.setDebug(true);
    expect(d.debug).toBe(true);
    expect(updates).toBe(1);
  });

  it('PLT-03 storage problems reach the diagnostics log (store logger wiring)', () => {
    const storage = createMemoryStorage();
    storage.set(SETTINGS_KEY, '{"schema":1,"audio":{"mas');
    const store = createSettingsStore(storage, { lifecycle: null, debounceMs: 0 });
    const d = createDiagnostics(store);
    expect(d.recent().some((l) => l.includes('[storage]') && /corrupt|backup/i.test(l))).toBe(true);
    expect(d.report()).toMatch(/Storage: .+/);
    store.dispose();
  });
});

// ============================================================ recovery

interface FakeCtx {
  ctx: AppContext;
  navs: { id: ScreenId; params?: ScreenParams }[];
  pauses: number[];
  setState(s: SimState | null): void;
  router: { current: ScreenId | null };
}

function fakeCtx(): FakeCtx {
  const navs: FakeCtx['navs'] = [];
  const pauses: number[] = [];
  let state: SimState | null = null;
  const router = {
    current: 'match' as ScreenId | null,
    go(id: ScreenId, params?: ScreenParams) { navs.push({ id, params }); router.current = id; },
    replace(id: ScreenId) { router.current = id; },
    back() { router.current = 'match'; },
    register() { /* none */ },
  };
  const session = {
    get active() { return state !== null; },
    paused: false,
    pausedBy: -1,
    pause(h: number) { session.paused = true; pauses.push(h); },
    resume() { session.paused = false; return true; },
    start() { /* none */ },
    restart() { /* none */ },
    quit() { state = null; },
    queueCommand() { /* none */ },
    getState: () => state,
    getSetup: () => null,
    afterTick() { /* loop hook */ },
  };
  const platform: PlatformInfo = { isIPad: true, isTouch: true, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 20, left: 0 }) };
  const settings = fakeSettings();
  const diagnostics = createDiagnostics(settings);
  const ctx = { router, session, platform, diagnostics, settings } as unknown as AppContext;
  return { ctx, navs, pauses, setState: (s) => { state = s; }, router };
}

describe('PLT-05 recovery (global error handler)', () => {
  it('pauses the match and shows the recovery screen with the message', () => {
    let t = 0;
    const f = fakeCtx();
    f.setState(initMatch(createMatchConfig()));
    const rec = installRecovery(f.ctx, { now: () => t, listen: false });
    expect(currentRecovery()).toBe(rec);
    expect(appReplayRecorder()).toBe(rec.replay);
    rec.reportError(new TypeError('bad thing'), 'loop.tick');
    expect(f.pauses).toEqual([-1]);
    expect(f.navs).toEqual([{ id: 'recovery', params: { message: 'TypeError: bad thing', where: 'loop.tick' } }]);
    expect(rec.errors).toBe(1);
    expect(rec.lastError).toEqual({ message: 'TypeError: bad thing', where: 'loop.tick' });
    expect(f.ctx.diagnostics.recent().some((l) => l.includes('[error] loop.tick: TypeError: bad thing'))).toBe(true);
    const report = f.ctx.diagnostics.report();
    expect(report).toMatch(/Match: seed \d+, tick 0, phase \d+, score 0-0, hash [0-9a-f]{8}/);
    expect(report).toContain('Device: iPad yes');
    expect(report).toContain('Replay: nothing recorded yet');
    expect(report).toContain('Recovery: 1 error(s), last at loop.tick');
    t = 5000;
    rec.dispose();
    expect(currentRecovery()).toBeNull();
    expect(appReplayRecorder()).toBeNull();
    expect(f.ctx.diagnostics.report()).not.toContain('Recovery:');
  });

  it('benign browser noise is logged as a warning and never navigates', () => {
    const f = fakeCtx();
    const rec = installRecovery(f.ctx, { now: () => 0, listen: false });
    rec.reportError('ResizeObserver loop completed with undelivered notifications.', 'window.onerror');
    rec.reportError('Script error.', 'window.onerror');
    expect(f.navs).toHaveLength(0);
    expect(rec.errors).toBe(0);
    expect(f.ctx.diagnostics.recent().filter((l) => l.includes('[warn]'))).toHaveLength(2);
    rec.dispose();
  });

  it('loop guard: no navigation while on recovery, one per second, and an error storm ends in the static fallback', () => {
    let t = 0;
    const f = fakeCtx();
    f.setState(initMatch(createMatchConfig()));
    const rec = installRecovery(f.ctx, { now: () => t, listen: false });
    rec.reportError(new Error('1'), 'a');
    rec.reportError(new Error('2'), 'b'); // already on recovery
    expect(f.navs).toHaveLength(1);
    f.router.current = 'match';
    t = 500;
    rec.reportError(new Error('3'), 'c'); // rate-limited
    expect(f.navs).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      t += 1500;
      f.router.current = 'match';
      rec.reportError(new Error(`storm ${i}`), 'loop.tick');
    }
    expect(f.navs).toHaveLength(4);
    expect(rec.fatal).toBe(false);
    t += 1500;
    f.router.current = 'match';
    rec.reportError(new Error('storm 4'), 'loop.tick');
    expect(rec.fatal).toBe(true);
    expect(f.navs).toHaveLength(4);
    t += 5000;
    f.router.current = 'match';
    rec.reportError(new Error('after'), 'loop.tick');
    expect(f.navs).toHaveLength(4); // nothing navigates after the fallback
    expect(rec.canResume()).toBe(false);
    rec.dispose();
  });

  it('an error inside the recovery screen itself switches to the static fallback (no loop)', () => {
    const f = fakeCtx();
    const rec = installRecovery(f.ctx, { now: () => 0, listen: false });
    rec.reportError(new Error('first'), 'loop.tick');
    expect(f.router.current).toBe('recovery');
    rec.reportError(new Error('mount failed'), 'mount recovery');
    expect(rec.fatal).toBe(true);
    expect(f.navs).toHaveLength(1);
    expect(isRecoveryScreenError('onBack recovery')).toBe(true);
    expect(isRecoveryScreenError('mount match')).toBe(false);
    rec.dispose();
  });

  it('Resume is offered only for a sane state and not for an error that keeps coming back after resuming', () => {
    let t = 0;
    const f = fakeCtx();
    const rec = installRecovery(f.ctx, { now: () => t, listen: false });
    expect(rec.canResume()).toBe(false); // no match
    const s = initMatch(createMatchConfig());
    f.setState(s);
    expect(rec.canResume()).toBe(true);
    expect(canResume(f.ctx)).toBe(true);
    s.ball.x = Number.NaN;
    expect(rec.canResume()).toBe(false);
    s.ball.x = 0;
    s.players[3]!.x = 500;
    expect(isStateSane(s)).toBe(false);
    s.players[3]!.x = 0;
    expect(isStateSane(s)).toBe(true);
    // The same error straight after each resume: Resume disappears after maxRepeats.
    rec.reportError(new Error('x'), 'loop.tick');
    for (let i = 0; i < 2; i++) {
      t += 4000;
      rec.noteResume();
      f.router.current = 'match';
      t += 100;
      rec.reportError(new Error('x'), 'loop.tick');
      expect(f.router.current).toBe('recovery'); // a resume lets the error show again at once
    }
    expect(rec.canResume()).toBe(false);
    rec.dispose();
  });

  it('pure helpers', () => {
    expect(describeError(new RangeError('r'))).toBe('RangeError: r');
    expect(describeError('s')).toBe('s');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    expect(describeError(undefined)).toBe('undefined');
    expect(isBenignError('ResizeObserver loop limit exceeded')).toBe(true);
    expect(isBenignError('TypeError: x')).toBe(false);
    expect(isStateSane(null)).toBe(false);
    expect(resumeNavigation('half-time', false)).toBe('stay');
    expect(resumeNavigation('loading', false)).toBe('replace-match');
    expect(resumeNavigation('recovery', false)).toBe('go-match');
  });
});

// ============================================================ overlay + screen helpers

describe('PLT-05 debug overlay and diagnostics screen helpers', () => {
  it('5 taps in the top-left corner within 2 s toggle; a tap elsewhere or a slow sequence does not', () => {
    const d = createCornerTapDetector();
    for (let i = 0; i < 4; i++) expect(d.tap(10, 10, i * 300)).toBe(false);
    expect(d.tap(10, 10, 1300)).toBe(true);
    for (let i = 0; i < 4; i++) d.tap(10, 10, 5000 + i * 100);
    expect(d.tap(300, 300, 5500)).toBe(false); // outside resets
    expect(d.tap(10, 10, 5600)).toBe(false);
    for (let i = 0; i < 5; i++) expect(d.tap(5, 5, 10_000 + i * 600)).toBe(false); // 2.4 s for 5 taps
  });

  it('describes pads (pressed buttons, analog values, axes, non-standard mapping)', () => {
    const line = describePad({
      index: 1, id: 'Mock Pad', connected: true, mapping: '',
      buttons: [{ pressed: true, value: 1 }, { pressed: false, value: 0 }, { pressed: true, value: 0.5 }],
      axes: [0.25, -1],
    });
    expect(line).toBe('pad 1 Mock Pad (non-standard)  btn [0 2=0.50]  axes [+0.25 -1.00]');
  });

  it('tracks pointers down / move / up / cancel', () => {
    const t = createPointerTracker();
    t.handle({ type: 'pointerdown', pointerId: 1, clientX: 10, clientY: 20, pointerType: 'touch' });
    t.handle({ type: 'pointerdown', pointerId: 2, clientX: 30, clientY: 40, pointerType: 'touch' });
    t.handle({ type: 'pointermove', pointerId: 1, clientX: 11, clientY: 21, pointerType: 'touch' });
    t.handle({ type: 'pointermove', pointerId: 9, clientX: 0, clientY: 0, pointerType: 'mouse' }); // hover: ignored
    expect(t.points().map((p) => [p.id, p.x, p.y])).toEqual([[1, 11, 21], [2, 30, 40]]);
    t.handle({ type: 'pointercancel', pointerId: 1, clientX: 0, clientY: 0, pointerType: 'touch' });
    t.handle({ type: 'pointerup', pointerId: 2, clientX: 0, clientY: 0, pointerType: 'touch' });
    expect(t.points()).toHaveLength(0);
  });

  it('frame bands and phase names', () => {
    expect(frameBand(16.7)).toBe(0);
    expect(frameBand(33)).toBe(1);
    expect(frameBand(50)).toBe(2);
    expect(phaseName(2)).toBe('IN_PLAY');
    expect(phaseName(99)).toBe('99');
  });

  it('hold-to-close needs a release first, then holdMs of holding', () => {
    const hd = createHoldDetector(1000);
    expect(hd.step(true, 0)).toBe(false); // held while opening: not armed
    expect(hd.step(true, 2000)).toBe(false);
    expect(hd.step(false, 2100)).toBe(false); // released: armed
    expect(hd.step(true, 2200)).toBe(false);
    expect(hd.step(true, 3000)).toBe(false);
    expect(hd.step(true, 3200)).toBe(true);
  });

  it('readReplayText explains a bad file', () => {
    expect(readReplayText('nope')).toEqual({ problem: 'not a JSON file' });
    expect(readReplayText('{}')).toEqual({ problem: expect.stringMatching(/format/) as unknown as string });
  });
});
