/**
 * UIX-05 unit tests: the local match flow (matchFlow.ts), mode setup routes (modeSetup.ts), match settings options
 * (matchSettings.ts) and the loading screen's tips and progress (loading.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceInfo, MatchSetup, ScreenParams } from '../../src/contracts/app';
import { CameraType, ControllerKind, Difficulty, MatchPhase, ModeId, PadFamily } from '../../src/contracts/enums';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { CLUBS } from '../../src/data/clubs';
import { PadButton } from '../../src/input/pad/manager';
import {
  PROGRESS_CAP, TIPS, controlTip, loadingProgress, playerDevice, tipKindFor, tipText,
} from '../../src/ui/screens/loading';
import {
  DEFAULT_REPLAY_SECONDS, cloneSetup, goNext, lastMode, newFlow, nextFlowScreen, readFlow, rememberFlowMode,
} from '../../src/ui/screens/matchFlow';
import {
  applyMatchOptions, buildMatchSetup, hasCpuSide, optionsFromSettings, persistOptions, type MatchOptions,
} from '../../src/ui/screens/matchSettings';
import { MODE_ENTRIES, modeEntryFor, modeRoute } from '../../src/ui/screens/modeSetup';

interface FakeCtx {
  ctx: AppContext;
  go: ReturnType<typeof vi.fn>;
  settings: Settings;
}

function fakeCtx(opts: { devices?: DeviceInfo[]; last?: string | null; touch?: boolean; running?: MatchSetup | null } = {}): FakeCtx {
  const settings = createDefaultSettings();
  const go = vi.fn();
  const ctx = {
    router: { go, back: vi.fn(), replace: vi.fn(), register: vi.fn(), current: null },
    settings: {
      get: () => settings,
      update: (fn: (s: Settings) => void) => fn(settings),
      subscribe: () => () => undefined,
      reset: () => undefined,
      persistent: false,
      loadProgress: () => null,
      saveProgress: () => undefined,
      clearProgress: () => undefined,
    },
    devices: {
      list: () => opts.devices ?? [],
      subscribe: () => () => undefined,
      createSource: () => { throw new Error('no'); },
      lastActive: () => opts.last ?? null,
    },
    platform: { isTouch: opts.touch ?? true, isIPad: true, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) },
    session: { getSetup: () => opts.running ?? null },
    clubs: CLUBS,
  } as unknown as AppContext;
  return { ctx, go, settings };
}

const dev = (id: string, kind: DeviceInfo['kind'], family = PadFamily.GENERIC): DeviceInfo => ({ id, kind, label: id, family, connected: true });

describe('UIX-05 match flow', () => {
  it('steps: mode setup -> team select -> side select -> match settings -> (start)', () => {
    for (const m of [ModeId.KICK_OFF, ModeId.FRIEND_LOCAL, ModeId.SHOOT_OUT] as const) {
      expect(nextFlowScreen(m, 'mode-setup')).toBe('team-select');
      expect(nextFlowScreen(m, 'team-select')).toBe('side-select');
      expect(nextFlowScreen(m, 'side-select')).toBe('match-settings');
      expect(nextFlowScreen(m, 'match-settings')).toBeNull();
    }
  });

  it('a new flow starts from settings.match with no humans; Shoot-out starts in the shoot-out phase', () => {
    const { ctx, settings } = fakeCtx();
    settings.match.homeClub = 6;
    settings.match.awayClub = 11;
    settings.match.halfMinutes = 7;
    const f = newFlow(ctx, ModeId.KICK_OFF);
    expect(f.setup.config.homeClub).toBe(6);
    expect(f.setup.config.awayClub).toBe(11);
    expect(f.setup.config.halfMinutes).toBe(7);
    expect(f.setup.config.homeFormation).toBe(CLUBS[6]!.formation);
    expect(f.setup.config.awayFormation).toBe(CLUBS[11]!.formation);
    expect(f.setup.config.humans.every((h) => h.kind === ControllerKind.NONE)).toBe(true);
    expect(f.setup.bindings).toEqual([]);
    expect(f.setup.config.startPhase).toBe(MatchPhase.KICK_OFF);
    const s = newFlow(ctx, ModeId.SHOOT_OUT);
    expect(s.setup.config.mode).toBe(ModeId.SHOOT_OUT);
    expect(s.setup.config.startPhase).toBe(MatchPhase.SHOOT_OUT);
    expect(s.setup.config.cupRules).toBe(1);
    expect(newFlow(ctx, ModeId.FRIEND_LOCAL).setup.config.mode).toBe(ModeId.FRIEND_LOCAL);
  });

  it('readFlow keeps a valid flow, else builds one and stores it in the params (Back keeps the working copy)', () => {
    const { ctx } = fakeCtx();
    const a = newFlow(ctx, ModeId.FRIEND_LOCAL);
    const p1: ScreenParams = { mode: a.mode, setup: a.setup };
    expect(readFlow(ctx, p1).setup).toBe(a.setup);
    const p2: ScreenParams = {};
    const b = readFlow(ctx, p2);
    expect(p2.setup).toBe(b.setup);
    expect(readFlow(ctx, p2).setup).toBe(b.setup);
    // Malformed setup: replaced.
    const p3: ScreenParams = { mode: ModeId.SHOOT_OUT, setup: { config: 3 } };
    expect(readFlow(ctx, p3).setup.config.mode).toBe(ModeId.SHOOT_OUT);
    // Frozen params do not throw.
    expect(() => readFlow(ctx, Object.freeze({}) as ScreenParams)).not.toThrow();
  });

  it('a flow without a mode resumes the last mode started (full-time Change teams)', () => {
    const { ctx } = fakeCtx();
    rememberFlowMode(ModeId.FRIEND_LOCAL);
    expect(lastMode()).toBe(ModeId.FRIEND_LOCAL);
    expect(readFlow(ctx, {}).mode).toBe(ModeId.FRIEND_LOCAL);
    rememberFlowMode(ModeId.KICK_OFF);
    const running = newFlow(ctx, ModeId.SHOOT_OUT).setup;
    expect(readFlow(fakeCtx({ running }).ctx, {}).mode).toBe(ModeId.SHOOT_OUT);
  });

  it('the next step gets a deep copy: later steps never change an earlier one', () => {
    const { ctx, go } = fakeCtx();
    const f = newFlow(ctx, ModeId.KICK_OFF);
    f.setup.bindings.push({ human: 0, deviceIds: ['touch'] });
    expect(goNext(ctx, 'team-select', f)).toBe('side-select');
    const [id, params] = go.mock.calls[0]! as [string, { mode: number; setup: MatchSetup }];
    expect(id).toBe('side-select');
    expect(params.mode).toBe(ModeId.KICK_OFF);
    params.setup.config.homeClub = 19;
    params.setup.config.humans[0]!.side = 1;
    params.setup.bindings[0]!.deviceIds.push('pad:1');
    expect(f.setup.config.homeClub).not.toBe(19);
    expect(f.setup.config.humans[0]!.side).not.toBe(1);
    expect(f.setup.bindings[0]!.deviceIds).toEqual(['touch']);
    const c = cloneSetup(f.setup);
    expect(c).toEqual(f.setup);
    expect(goNext(ctx, 'match-settings', f)).toBeNull();
  });
});

describe('UIX-05 mode setup', () => {
  it('lists the five modes; unknown params select Kick-Off; online friend maps to Play a Friend', () => {
    expect(MODE_ENTRIES.map((e) => e.mode)).toEqual([ModeId.KICK_OFF, ModeId.FRIEND_LOCAL, ModeId.SHOOT_OUT, ModeId.CUP, ModeId.PRACTICE]);
    expect(modeEntryFor(undefined).mode).toBe(ModeId.KICK_OFF);
    expect(modeEntryFor('x').mode).toBe(ModeId.KICK_OFF);
    expect(modeEntryFor(ModeId.FRIEND_ONLINE).mode).toBe(ModeId.FRIEND_LOCAL);
    expect(modeEntryFor(ModeId.SHOOT_OUT).label).toBe('Shoot-out');
  });

  it('routes: local modes to team select with a fresh flow; online to the lobby; cup and practice to their screens', () => {
    const { ctx } = fakeCtx();
    const [id, p] = modeRoute(ctx, ModeId.KICK_OFF);
    expect(id).toBe('team-select');
    expect(p.mode).toBe(ModeId.KICK_OFF);
    expect((p.setup as MatchSetup).config.mode).toBe(ModeId.KICK_OFF);
    expect(modeRoute(ctx, ModeId.FRIEND_LOCAL)[0]).toBe('team-select');
    expect(modeRoute(ctx, ModeId.FRIEND_LOCAL, true)[0]).toBe('online-lobby');
    expect(modeRoute(ctx, ModeId.SHOOT_OUT)[0]).toBe('team-select');
    expect(modeRoute(ctx, ModeId.CUP)[0]).toBe('cup');
    expect(modeRoute(ctx, ModeId.PRACTICE)[0]).toBe('practice');
  });
});

describe('UIX-05 match settings', () => {
  const opts = (o: Partial<MatchOptions> = {}): MatchOptions => ({
    difficulty: Difficulty.LEGEND, halfMinutes: 9, cupRules: true, night: true, offside: false, fouls: false, replays: false,
    camera: CameraType.WIDE, ...o,
  });

  it('starts from settings.match (clamped) and the remembered rules choice', () => {
    const s = createDefaultSettings();
    s.match.halfMinutes = 30;
    s.match.difficulty = 42 as Difficulty;
    s.camera.type = CameraType.CLOSE;
    const o = optionsFromSettings(s, true);
    expect(o).toEqual({
      difficulty: Difficulty.PROFESSIONAL, halfMinutes: 10, cupRules: true, night: false, offside: true, fouls: true, replays: true,
      camera: CameraType.CLOSE,
    });
    s.match.halfMinutes = 0.4;
    expect(optionsFromSettings(s).halfMinutes).toBe(2);
  });

  it('applies the options to the config; Shoot-out keeps its phase and cup rules', () => {
    const { ctx } = fakeCtx();
    const k = newFlow(ctx, ModeId.KICK_OFF).setup.config;
    applyMatchOptions(k, opts(), ModeId.KICK_OFF);
    expect([k.difficulty, k.halfMinutes, k.cupRules, k.night, k.offside, k.fouls, k.replaySeconds]).toEqual([Difficulty.LEGEND, 9, 1, 1, 0, 0, 0]);
    applyMatchOptions(k, opts({ replays: true, cupRules: false, halfMinutes: 1 }), ModeId.KICK_OFF);
    expect([k.replaySeconds, k.cupRules, k.halfMinutes]).toEqual([DEFAULT_REPLAY_SECONDS, 0, 2]);
    const so = newFlow(ctx, ModeId.SHOOT_OUT).setup.config;
    const half = so.halfMinutes;
    applyMatchOptions(so, opts({ cupRules: false, halfMinutes: 3 }), ModeId.SHOOT_OUT);
    expect(so.cupRules).toBe(1);
    expect(so.startPhase).toBe(MatchPhase.SHOOT_OUT);
    expect(so.halfMinutes).toBe(half);
    expect(so.night).toBe(1);
  });

  it('remembers the choices in settings.match and settings.camera', () => {
    const { ctx } = fakeCtx();
    const s = createDefaultSettings();
    const c = newFlow(ctx, ModeId.KICK_OFF).setup.config;
    c.homeClub = 12;
    c.awayClub = 3;
    persistOptions(s, opts(), c, ModeId.KICK_OFF);
    expect(s.match).toMatchObject({ difficulty: Difficulty.LEGEND, halfMinutes: 9, night: true, offside: false, fouls: false, replays: false, homeClub: 12, awayClub: 3 });
    expect(s.camera.type).toBe(CameraType.WIDE);
    // Shoot-out leaves the open-play rules alone.
    const t = createDefaultSettings();
    persistOptions(t, opts(), c, ModeId.SHOOT_OUT);
    expect(t.match.halfMinutes).toBe(4);
    expect(t.match.offside).toBe(true);
    expect(t.match.difficulty).toBe(Difficulty.LEGEND);
  });

  it('difficulty matters only with a CPU side', () => {
    const { ctx } = fakeCtx();
    const c = newFlow(ctx, ModeId.FRIEND_LOCAL).setup.config;
    expect(hasCpuSide(c)).toBe(true);
    c.humans[0] = { ...c.humans[0]!, kind: ControllerKind.HUMAN, side: 0 };
    expect(hasCpuSide(c)).toBe(true);
    c.humans[1] = { ...c.humans[1]!, kind: ControllerKind.HUMAN, side: 0 };
    expect(hasCpuSide(c)).toBe(true); // co-op: away is CPU
    c.humans[1] = { ...c.humans[1]!, side: 1 };
    expect(hasCpuSide(c)).toBe(false);
  });

  it('the setup to start is a copy with the options applied (the flow stays untouched)', () => {
    const { ctx } = fakeCtx();
    const f = newFlow(ctx, ModeId.KICK_OFF);
    f.setup.bindings = [{ human: 0, deviceIds: ['pad:1'] }];
    const s = buildMatchSetup(f.setup, opts(), ModeId.KICK_OFF);
    expect(s.config.halfMinutes).toBe(9);
    expect(f.setup.config.halfMinutes).toBe(4);
    expect(s.bindings).toEqual([{ human: 0, deviceIds: ['pad:1'] }]);
    expect(s.bindings).not.toBe(f.setup.bindings);
  });
});

describe('UIX-05 loading screen', () => {
  it('progress estimate rises monotonically and never reaches the end before the match is ready', () => {
    let prev = -1;
    for (let t = 0; t <= 60_000; t += 250) {
      const p = loadingProgress(t);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(PROGRESS_CAP);
      prev = p;
    }
    expect(loadingProgress(0)).toBe(0);
    expect(loadingProgress(-5)).toBe(0);
    expect(loadingProgress(Number.NaN)).toBe(0);
    expect(loadingProgress(5_000)).toBeGreaterThan(0.9);
  });

  it('tips follow player 1\'s bound device; wildcards fall back to the last used device, then the platform', () => {
    const devices = [dev('touch', 'touch'), dev('pad:1', 'pad', PadFamily.PLAYSTATION), dev('keyboard', 'keyboard')];
    const setup = (ids: string[]): MatchSetup => ({ config: newFlow(fakeCtx().ctx, ModeId.KICK_OFF).setup.config, bindings: [{ human: 1, deviceIds: ['touch'] }, { human: 0, deviceIds: ids }] });
    const a = fakeCtx({ devices, last: 'keyboard' }).ctx;
    expect(tipKindFor(a, setup(['pad:1']))).toBe('pad');
    expect(playerDevice(a, setup(['pad:1']))!.family).toBe(PadFamily.PLAYSTATION);
    expect(tipKindFor(a, setup(['*']))).toBe('keyboard');
    expect(tipKindFor(a, null)).toBe('keyboard');
    expect(tipKindFor(fakeCtx({ touch: true }).ctx, null)).toBe('touch');
    expect(tipKindFor(fakeCtx({ touch: false }).ctx, null)).toBe('keyboard');
  });

  it('controller tips name the buttons of the pad family (PAD-07 labels)', () => {
    const tip = TIPS.pad[0]!;
    expect(tip.some((p) => typeof p !== 'string' && p.btn === PadButton.SOUTH)).toBe(true);
    expect(tipText(tip, PadFamily.PLAYSTATION)).toMatch(/^Cross ground pass, Square lob or cross, Triangle through ball, Circle shoot\.$/);
    expect(tipText(tip, PadFamily.XBOX)).toMatch(/^A ground pass, X lob or cross, Y through ball, B shoot\.$/);
    for (const kind of ['touch', 'pad', 'keyboard'] as const) {
      expect(TIPS[kind].length).toBeGreaterThan(1);
      for (const t of TIPS[kind]) expect(tipText(t).length).toBeGreaterThan(10);
    }
    const ctx = fakeCtx({ devices: [dev('pad:1', 'pad', PadFamily.PLAYSTATION)], last: 'pad:1' }).ctx;
    expect(controlTip(ctx, 0)).toContain('Cross');
    expect(controlTip(ctx, -7)).toBe(tipText(TIPS.pad[7 % TIPS.pad.length]!, PadFamily.PLAYSTATION));
  });
});
