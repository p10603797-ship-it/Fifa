import { describe, expect, it, vi } from 'vitest';
import type { AppContext, ScreenId, SettingsStore } from '../../src/contracts/app';
import { UiSound } from '../../src/contracts/app';
import { AUDIO_ENGINE_TUNING } from '../../src/audio/engine';
import { ControllerKind, MatchPhase, ModeId, RestartKind } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { EventType } from '../../src/contracts/events';
import { createMemoryStorage } from '../../src/platform/storage';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { detectIpad } from '../../src/platform/info';
import { classifyViewport, installIpadHardening } from '../../src/platform/ipados';
import { describeError, installRecovery, isBenignError } from '../../src/platform/recovery';
import { createDiagnostics } from '../../src/platform/diagnostics';
import { createCornerTapDetector } from '../../src/ui/debugOverlay';
import { createStatsTracker } from '../../src/modes/stats';
import { defaultSetup } from '../../src/modes/setup';
import { ANY_DEVICE } from '../../src/app/localInput';
import { createAudioEngine } from '../../src/audio/engine';
import { createEventBuffer } from '../../src/sim/core/events';
import type { ReadonlySimState } from '../../src/contracts/state';

describe('FND-04 platform detection', () => {
  it('detects iPads including iPadOS desktop-mode user agents', () => {
    expect(detectIpad('Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X)', 'iPad', 5)).toBe(true);
    expect(detectIpad('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 5)).toBe(true);
    expect(detectIpad('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 'MacIntel', 0)).toBe(false);
    expect(detectIpad('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Win32', 10)).toBe(false);
    expect(detectIpad('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'iPhone', 5)).toBe(false);
  });

  it('classifies portrait and too-small windows', () => {
    expect(classifyViewport(1180, 820)).toEqual({ portrait: false, tooSmall: false });
    expect(classifyViewport(820, 1180)).toEqual({ portrait: true, tooSmall: false });
    expect(classifyViewport(500, 300)).toEqual({ portrait: false, tooSmall: true });
    expect(classifyViewport(2560, 1080)).toEqual({ portrait: false, tooSmall: false });
  });

  // INT-B: GFX-02's detector (render/quality.ts) is the only Low Power Mode path; reportFrame is a kept no-op, so the
  // old frame-time detector case is gone. The app no longer calls reportFrame at all.
  it('reportFrame never suspects Low Power Mode (one detector: GFX-02)', () => {
    const onLowPowerSuspected = vi.fn();
    const hard = installIpadHardening({ onLowPowerSuspected });
    for (let i = 0; i < 300; i++) hard.reportFrame(33.3, 4);
    expect(onLowPowerSuspected).not.toHaveBeenCalled();
    hard.dispose();
  });
});

describe('FND-04 debug overlay toggle', () => {
  it('needs 5 taps in the top-left corner within 2 s', () => {
    const d = createCornerTapDetector();
    expect(d.tap(10, 10, 0)).toBe(false);
    expect(d.tap(10, 10, 100)).toBe(false);
    expect(d.tap(10, 10, 200)).toBe(false);
    expect(d.tap(10, 10, 300)).toBe(false);
    expect(d.tap(10, 10, 400)).toBe(true);
    // Too slow.
    for (let i = 0; i < 5; i++) expect(d.tap(5, 5, 10_000 + i * 600)).toBe(false);
    // A tap elsewhere resets the sequence.
    d.reset();
    for (let i = 0; i < 4; i++) d.tap(5, 5, 20_000 + i * 10);
    expect(d.tap(500, 500, 20_050)).toBe(false);
    expect(d.tap(5, 5, 20_060)).toBe(false);
  });
});

describe('FND-04 recovery and diagnostics', () => {
  it('describes errors and filters benign browser noise', () => {
    expect(describeError(new TypeError('x is undefined'))).toBe('TypeError: x is undefined');
    expect(describeError('plain')).toBe('plain');
    expect(describeError({ a: 1 })).toBe('{"a":1}');
    expect(isBenignError('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isBenignError('Script error.')).toBe(true);
    expect(isBenignError('TypeError: boom')).toBe(false);
  });

  it('pauses the match and shows the recovery screen once per error storm', () => {
    let now = 0;
    const go = vi.fn((id: ScreenId) => { router.current = id; });
    const router = { current: 'match' as ScreenId | null, go };
    const session = { active: true, paused: false, pause: vi.fn(() => { session.paused = true; }) };
    const diagnostics = { log: vi.fn() };
    const ctx = { router, session, diagnostics } as unknown as AppContext;
    const rec = installRecovery(ctx, { now: () => now });
    rec.reportError(new Error('tick failed'), 'loop');
    expect(session.pause).toHaveBeenCalledWith(-1);
    expect(go).toHaveBeenCalledWith('recovery', { message: 'Error: tick failed', where: 'loop' });
    now = 50;
    rec.reportError(new Error('again'), 'loop');
    expect(go).toHaveBeenCalledTimes(1);
    rec.reportError('ResizeObserver loop limit exceeded', 'window.onerror');
    expect(rec.errors).toBe(2);
    expect(diagnostics.log).toHaveBeenCalledTimes(3);
    rec.dispose();
  });

  it('keeps a bounded log and builds a report', () => {
    const settings = createSettingsStore(createMemoryStorage());
    let t = 0;
    const d = createDiagnostics(settings, { capacity: 8, now: () => (t += 1000) });
    for (let i = 0; i < 20; i++) d.log('test', `line ${i}`, i === 19 ? { x: 1 } : undefined);
    d.log('error', 'bad thing', new Error('why'));
    expect(d.recent().length).toBe(8);
    expect(d.recent()[0]).toContain('line 13');
    expect(d.recent().at(-1)).toContain('bad thing');
    expect(d.lastError).toBe('bad thing');
    expect(d.total).toBe(22); // 21 lines plus the settings store's storage line (PLT-03 logger attached at creation)
    d.addSection('Replay', () => 'none');
    d.addSection('Broken', () => { throw new Error('nope'); });
    const r = d.report();
    expect(r).toContain('DotKick');
    expect(r).toContain('Replay: none');
    expect(r).toContain('Broken: unavailable');
    expect(r).toContain('line 19 | {"x":1}');
    d.setDebug(true);
    expect(settings.get().debug).toBe(true);
    expect(d.debug).toBe(true);
  });
});

describe('FND-04 stats tracker', () => {
  it('counts shots, possession, passes and goals from events and state', () => {
    const s = {
      tick: 0,
      ball: { owner: -1 },
      teams: [{ goals: 0 }, { goals: 0 }],
      players: Array.from({ length: 22 }, (_, i) => ({ rosterIdx: i % 11 })),
      match: { phase: MatchPhase.IN_PLAY, period: 1, periodT: 0, periodLen: 100, addedT: 0, shootout: { active: 0, winner: -1, goals: [0, 0] }, winner: -1, forfeitTeam: -1 },
    } as unknown as ReadonlySimState & { tick: number; ball: { owner: number }; teams: { goals: number }[] };
    const t = createStatsTracker();
    t.reset(s);
    const ev = createEventBuffer();
    // 3 ticks home possession, 1 tick away.
    for (const owner of [3, 4, 5, 14]) {
      (s.ball as { owner: number }).owner = owner;
      ev.begin(++s.tick);
      t.onTick(s, ev);
    }
    (s.ball as { owner: number }).owner = -1; // loose ball: stays with the last owner (MOD-05 sticky possession)
    ev.begin(++s.tick);
    ev.emit(EventType.SHOT, 9, 1, 0.3);
    ev.emit(EventType.SHOT, 15, 0, 0.1);
    ev.emit(EventType.KICK, 4, 1, 0.5); // ground pass
    ev.emit(EventType.PASS_COMPLETE, 6, 4);
    ev.emit(EventType.RESTART_AWARDED, RestartKind.CORNER, 1);
    ev.emit(EventType.GOAL, 0, 9, 4, 0);
    t.onTick(s, ev);
    s.teams[0]!.goals = 1;
    const sum = t.summary(s);
    expect(sum.teams[0].shots).toBe(1);
    expect(sum.teams[0].shotsOnTarget).toBe(1);
    expect(sum.teams[1].shots).toBe(1);
    expect(sum.teams[0].passes).toBe(1);
    expect(sum.teams[0].passesCompleted).toBe(1);
    expect(sum.teams[1].corners).toBe(1);
    expect(sum.teams[0].possession).toBeCloseTo(0.6); // 3 home ticks of 5 IN_PLAY ticks (MOD-05 definition)
    expect(sum.goals).toEqual([{ team: 0, rosterIdx: 9, assistRosterIdx: 4, ownGoal: false, minute: 1 }]);
    expect(sum.winner).toBe(0);
    expect(sum.ticks).toBe(5);
    t.reset(s);
    s.teams[0]!.goals = 0;
    expect(t.summary(s).goals).toEqual([]);
    expect(t.summary(s).winner).toBe(-1);
  });
});

describe('FND-04 default setup', () => {
  it('binds every local device (plus later ones) to human 0 at home; away is CPU', () => {
    const settings = createSettingsStore(createMemoryStorage());
    settings.update((s) => { s.match.halfMinutes = 6; s.match.awayClub = 7; });
    const devices = {
      list: () => [
        { id: 'touch', kind: 'touch', label: 'Touch', family: 0, connected: true },
        { id: 'keyboard', kind: 'keyboard', label: 'Keyboard', family: 0, connected: true },
        { id: 'pad:0', kind: 'pad', label: 'Pad', family: 0, connected: false },
      ],
    };
    const ctx = { settings, devices } as unknown as AppContext;
    const a = defaultSetup(ctx);
    const b = defaultSetup(ctx);
    expect(a.bindings).toEqual([{ human: 0, deviceIds: ['touch', 'keyboard', ANY_DEVICE] }]);
    expect(a.config.humans[0]!.kind).toBe(ControllerKind.HUMAN);
    expect(a.config.humans[0]!.side).toBe(0);
    expect(a.config.humans[1]!.kind).toBe(ControllerKind.NONE);
    expect(a.config.mode).toBe(ModeId.KICK_OFF);
    expect(a.config.halfMinutes).toBe(6);
    expect(a.config.awayClub).toBe(7);
    expect(Number.isInteger(a.config.seed) && a.config.seed >= 0 && a.config.seed <= 0xffffffff).toBe(true);
    expect(a.config.seed).not.toBe(b.config.seed);
  });
});

// ---------------------------------------------------------------- audio engine with a fake AudioContext

function fakeAudioContext() {
  const gains: { gain: { value: number; setTargetAtTime: (v: number) => void }; connect: () => void; disconnect: () => void }[] = [];
  const ac = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    destination: {},
    createGain() {
      const g = { gain: { value: 1, setTargetAtTime(v: number) { g.gain.value = v; } }, connect() {}, disconnect() {} };
      gains.push(g);
      return g;
    },
    createBuffer: () => ({}),
    createBufferSource: () => ({ buffer: null, connect() {}, start() {} }),
    createOscillator: () => ({ type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {}, disconnect() {}, onended: null }),
    resume: vi.fn(() => { ac.state = 'running'; return Promise.resolve(); }),
    suspend: vi.fn(() => { ac.state = 'suspended'; return Promise.resolve(); }),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
  };
  return { ac, gains };
}

describe('FND-04 audio engine', () => {
  it('creates the context once on unlock, builds buses and follows volumes and pause', async () => {
    const settings = createSettingsStore(createMemoryStorage());
    const { ac, gains } = fakeAudioContext();
    const make = vi.fn(() => ac as unknown as AudioContext);
    const engine = createAudioEngine(settings, { createContext: make });
    expect(engine.unlocked).toBe(false);
    engine.playUi(UiSound.CONFIRM); // before unlock: silent no-op
    await engine.unlock();
    await engine.unlock();
    expect(make).toHaveBeenCalledTimes(1);
    expect(engine.unlocked).toBe(true);
    const [master, crowd, effects, menus] = gains;
    const d = createDefaultSettings().audio;
    expect(master!.gain.value).toBe(d.master);
    expect(crowd!.gain.value).toBe(d.crowd);
    engine.setPaused(true);
    // AUD-01 brief: the crowd is ducked (not muted) for the pause menu.
    expect(crowd!.gain.value).toBeCloseTo(d.crowd * AUDIO_ENGINE_TUNING.pauseCrowdDuck, 6);
    expect(effects!.gain.value).toBe(0);
    expect(menus!.gain.value).toBe(d.menus);
    settings.update((s) => { s.audio.menus = 0.2; });
    expect(menus!.gain.value).toBe(0.2);
    engine.setPaused(false);
    expect(crowd!.gain.value).toBe(d.crowd);
    engine.suspend();
    expect(ac.suspend).toHaveBeenCalledTimes(1);
    engine.resume();
    expect(ac.resume).toHaveBeenCalledTimes(2);
    engine.dispose();
    expect(ac.close).toHaveBeenCalled();
  });

  it('is a silent no-op without Web Audio', async () => {
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => null });
    await engine.unlock();
    expect(engine.unlocked).toBe(false);
    engine.setPaused(true);
    engine.suspend();
    engine.resume();
    engine.update(null, 0.016);
    engine.playUi(UiSound.BACK);
    expect(engine.context).toBeNull();
  });
});

describe('FND-04 settings store type', () => {
  it('SettingsStore satisfies the contract shape', () => {
    const s: SettingsStore = createSettingsStore(createMemoryStorage());
    expect(typeof s.loadProgress).toBe('function');
  });
});
