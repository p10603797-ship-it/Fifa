/**
 * [QF-12 skeptic] Regression tests for defects found by the second QF-12 pass (one describe per defect, named after
 * the symptom): records counted 2-3 times after Change teams, half-time team orders lost in the command queue, Back
 * on a finished cup tie leaving the cup, toast chips ignoring the high-contrast kits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSetup, MatchSummary, Screen, ScreenId } from '../../src/contracts/app';
import { COMMAND_QUEUE_CAPACITY } from '../../src/app/localInput';
import { MAX_SUBS } from '../../src/contracts/constants';
import { ControllerKind, FormationId, KitSlot, MatchPhase, ModeId, Period, Role, TacticalFocus } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import { createMatchConfig, RosterStatus } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import type { AppSession } from '../../src/app/types';
import { loadRecords } from '../../src/modes/records';
import { defaultSetup } from '../../src/modes/setup';
import { emptyTeamStats } from '../../src/modes/stats';
import { resolveMatchKits } from '../../src/render/kits';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { closeTopModal } from '../../src/ui/components';
import { kitHex } from '../../src/ui/hud/scoreboard';
import { createToasts } from '../../src/ui/hud/toasts';
import { changeTeams, createFullTimeScreen } from '../../src/ui/screens/fullTime';
import type { FlowParams } from '../../src/ui/screens/matchFlow';
import { optionsFromSettings, startSetup } from '../../src/ui/screens/matchSettings';
import {
  pumpTeamOrders, resetTeamOrders, setFocusOrder, setFormationOrder, setTacticOrder, teamOrders,
} from '../../src/ui/screens/pause';
import { fakeCtx } from './mod-01-fakes';
import { FakeElement, makeAppDom } from './uix-01-fakedom';

function summary(g0: number, g1: number, winner: number): MatchSummary {
  const a = emptyTeamStats();
  const b = emptyTeamStats();
  a.goals = g0;
  b.goals = g1;
  return { teams: [a, b], players: [], goals: [], playerOfMatch: null, shootout: null, winner, forfeit: -1, ticks: 1000 };
}

// ---------------------------------------------------------------------------------------------- records

describe('QF-12 records: a match started after full-time Change teams counts once, for the clubs and side played', () => {
  /** Full-time Change teams on `played`: the flow params handed to team select (fullTime.ts changeTeams). */
  function changeTeamsFrom(ctx: AppContext, played: MatchSetup): FlowParams {
    const go = vi.fn();
    const c = { ...ctx, session: { getSetup: () => played, quit: vi.fn() }, router: { go } } as unknown as AppContext;
    changeTeams(c);
    expect(go).toHaveBeenCalledTimes(1);
    expect(go.mock.calls[0]![0]).toBe('team-select');
    return go.mock.calls[0]![1] as FlowParams;
  }

  it('Play now -> Change teams -> Start, twice: each finished match counts once (was 2, then 3 times)', () => {
    const ctx = fakeCtx() as unknown as AppContext;
    const first = defaultSetup(ctx);
    first.onFinish!(summary(1, 0, 0), false);
    expect(loadRecords(ctx.settings).played).toBe(1);
    const flow = changeTeamsFrom(ctx, first);
    const second = startSetup(ctx, flow.setup, optionsFromSettings(ctx.settings.get()), flow.mode);
    second.onFinish!(summary(2, 0, 0), false);
    expect(loadRecords(ctx.settings).played).toBe(2);
    const flow2 = changeTeamsFrom(ctx, second);
    const third = startSetup(ctx, flow2.setup, optionsFromSettings(ctx.settings.get()), flow2.mode);
    third.onFinish!(summary(0, 1, 1), false);
    const r = loadRecords(ctx.settings);
    expect(r.played).toBe(3);
    expect(r.won).toBe(2);
    expect(r.lost).toBe(1);
    expect(r.goalsFor).toBe(3);
  });

  it('the record reads the setup actually played: new clubs and the human moved to the away side', () => {
    const ctx = fakeCtx() as unknown as AppContext;
    const first = defaultSetup(ctx);
    const flow = changeTeamsFrom(ctx, first);
    // Team select / side select on the copy: other clubs, the human now plays away.
    flow.setup.config.homeClub = 5;
    flow.setup.config.awayClub = 9;
    flow.setup.config.humans[0] = { ...flow.setup.config.humans[0]!, kind: ControllerKind.HUMAN, side: 1 };
    const second = startSetup(ctx, flow.setup, optionsFromSettings(ctx.settings.get()), flow.mode);
    // The away side (the human) wins 3-0.
    second.onFinish!(summary(0, 3, 1), false);
    const r = loadRecords(ctx.settings);
    expect(r.played).toBe(1);
    expect(r.won).toBe(1);
    expect(r.lost).toBe(0);
    expect(r.goalsFor).toBe(3);
    expect(r.biggestWin).toEqual({ goalsFor: 3, goalsAgainst: 0, club: 9, opponent: 5 });
  });

  it('a quit after Change teams records nothing; the wrapped onFinish of the old match never runs twice', () => {
    const ctx = fakeCtx() as unknown as AppContext;
    const inner = vi.fn();
    const first = { ...defaultSetup(ctx), onFinish: undefined } as MatchSetup;
    const wrappedFirst = startSetup(ctx, { ...first, onFinish: inner }, optionsFromSettings(ctx.settings.get()), ModeId.KICK_OFF);
    const flow = changeTeamsFrom(ctx, wrappedFirst);
    const second = startSetup(ctx, flow.setup, optionsFromSettings(ctx.settings.get()), flow.mode);
    second.onFinish!(summary(1, 1, -1), true);
    expect(loadRecords(ctx.settings).played).toBe(0);
    expect(inner).toHaveBeenCalledTimes(1);
    second.onFinish!(summary(1, 1, -1), false);
    expect(loadRecords(ctx.settings).played).toBe(1);
    expect(inner).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------------------------- team orders

/** Real router + session + local input provider with fake presentation (no DOM). */
function sessionRig() {
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  for (const id of ['main', 'loading', 'match', 'half-time', 'full-time'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount() {}, unmount() {} }));
  }
  router.go('main');
  const audio = {
    unlock: vi.fn(), unlocked: true, setVolumes: vi.fn(), onEvents: vi.fn(), update: vi.fn(), playUi: vi.fn(),
    matchStart: vi.fn(), matchEnd: vi.fn(), setPaused: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  };
  const devices: DeviceRegistry = {
    list: () => [], subscribe: () => () => undefined, lastActive: () => null,
    createSource: ((id: string) => ({ id, kind: 'touch', sample() {}, releaseAll() {}, dispose() {} })) as never,
  };
  const errors: string[] = [];
  const session = createSession({
    router, renderer: createNullRenderer(),
    hud: { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() },
    audio, devices, diagnostics: { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' },
    clubs: CLUBS, getProjector: () => null, yieldFrame: () => Promise.resolve(),
    onError: (err, where) => errors.push(`${where}: ${String(err)}`),
  }) as AppSession;
  return { router, session, errors };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

describe('QF-12 team orders: a full half-time outbox handed over at once reaches the sim (no order lost in the command queue)', () => {
  beforeEach(() => resetTeamOrders());

  it(`5 substitutions + formation + focus + 4 tactics made from the half-time shortcut all apply (was: 2 of 5 subs; capacity ${COMMAND_QUEUE_CAPACITY})`, async () => {
    const r = sessionRig();
    const config = createMatchConfig();
    config.seed = 99;
    config.halfMinutes = 2;
    config.humans[0] = { ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 };
    r.session.start({ config, bindings: [{ human: 0, deviceIds: ['touch'] }] });
    await settle();
    const rt = r.session.runtime()!;
    const s = rt.curr;
    const tickOnce = (): void => {
      rt.provider.take(s.tick + 1, rt.frames, s);
      step(s, rt.frames, rt.events);
      r.session.afterTick(rt);
    };
    // Play to half-time quickly (the clock jumped near the end, restarts taken by their timeouts).
    for (let i = 0; i < 20_000 && s.match.phase !== MatchPhase.HALF_TIME; i++) {
      const m = s.match;
      if (m.period === Period.FIRST_HALF && m.clockRunning === 1 && m.periodT < m.periodLen - 2) {
        m.periodT = m.periodLen - 2;
        m.addedT = 0;
      }
      if (m.phase >= MatchPhase.KICK_OFF && m.phase <= MatchPhase.PENALTY && m.restart.ready === 1 && m.restart.timeoutT > 2) m.restart.timeoutT = 2;
      tickOnce();
    }
    expect(s.match.phase).toBe(MatchPhase.HALF_TIME);
    // The half-time Substitutions shortcut pauses; the player orders everything there is to order.
    r.session.pause(0);
    const t = s.teams[0]!;
    const o = teamOrders(s, 0);
    const bench: number[] = [];
    for (let i = 11; i < 18; i++) if (s.squads[0]![i]!.pos !== Role.GK) bench.push(i);
    const outs = [9, 8, 7, 6, 5];
    for (let i = 0; i < MAX_SUBS; i++) o.subs.push({ out: outs[i]!, inRoster: bench[i]!, sentTick: -1 });
    setFormationOrder(o, t, t.formation === FormationId.F433 ? FormationId.F442 : FormationId.F433);
    const wantFormation = o.formation;
    setFocusOrder(o, t, TacticalFocus.ATTACKING);
    for (let i = 0; i < 4; i++) setTacticOrder(o, t, i, 1);
    // Resume returns to the half-time screen; the match screen's pause menu goes away while play runs and hands every
    // order over at once (pause.ts dispose: pumpTeamOrders(..., Infinity)).
    expect(r.session.resume(0)).toBe(true);
    const sent = pumpTeamOrders(s, (h, c, a) => r.session.queueCommand(h, c, a), Number.POSITIVE_INFINITY);
    expect(sent).toBe(MAX_SUBS + 6);
    for (let i = 0; i < 30; i++) tickOnce();
    for (let i = 0; i < MAX_SUBS; i++) expect(t.roster[bench[i]!], `substitute ${bench[i]} came on`).toBe(RosterStatus.PLAYING);
    expect(t.subsUsed).toBe(MAX_SUBS);
    expect(t.formation).toBe(wantFormation);
    expect(t.focus).toBe(TacticalFocus.ATTACKING);
    expect([t.offsideTrap, t.teamPress, t.extraStriker, t.getInBox]).toEqual([1, 1, 1, 1]);
    expect(r.errors).toEqual([]);
    r.session.quit();
  });
});

// ---------------------------------------------------------------------------------------------- full-time Back

describe('QF-12 cup: Back on a finished tie\'s final full-time screen goes back to the cup with the result card', () => {
  let screen: FakeElement;
  const proto = FakeElement.prototype as unknown as { replaceChildren?: (...n: FakeElement[]) => void };
  if (!proto.replaceChildren) {
    proto.replaceChildren = function (this: FakeElement, ...nodes: FakeElement[]) {
      while (this.children.length > 0) this.removeChild(this.children[0]!);
      for (const n of nodes) this.append(n);
    };
  }
  beforeEach(() => {
    const dom = makeAppDom();
    screen = dom.screen;
    vi.stubGlobal('document', dom.doc);
    vi.stubGlobal('window', dom.win);
  });
  afterEach(() => {
    while (closeTopModal()) { /* leftovers */ }
    vi.unstubAllGlobals();
  });

  function mountFinal(mode: ModeId, modeData: unknown) {
    const config = createMatchConfig();
    config.mode = mode;
    const quit = vi.fn();
    const go = vi.fn();
    const ctx = {
      session: { getState: () => null, getSetup: () => ({ config, bindings: [], modeData }), quit, restart: vi.fn() },
      router: { go, back: vi.fn() },
      clubs: CLUBS, audio: { playUi: vi.fn() },
      settings: { get: () => createDefaultSettings(), update: vi.fn(), subscribe: () => () => undefined },
      devices: { lastActive: () => null, list: () => [] },
      focus: { attach: vi.fn(), detach: vi.fn(), focus: vi.fn(), handle: vi.fn(), onAction: () => () => undefined },
    } as unknown as AppContext;
    const ft = createFullTimeScreen();
    ft.mount(screen as unknown as HTMLElement, ctx, { final: true, summary: summary(2, 1, 0) });
    return { ft, quit, go };
  }

  it('cup tie: Back = Continue (quit the finished match, the cup with { result }); was: the main menu', () => {
    const { ft, quit, go } = mountFinal(ModeId.CUP, { kind: 'cup', seed: 5, round: 1, tie: 2 });
    expect(screen.querySelector('[data-testid="ft-cup"]')).not.toBeNull();
    expect(ft.onBack!()).toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith('cup', { result: { round: 1, tie: 2 } });
    ft.unmount();
  });

  it('other modes: Back stays Quit (main menu)', () => {
    const { ft, quit, go } = mountFinal(ModeId.KICK_OFF, undefined);
    expect(ft.onBack!()).toBe(true);
    expect(quit).toHaveBeenCalledTimes(1);
    expect(go).not.toHaveBeenCalled();
    ft.unmount();
  });
});

// ---------------------------------------------------------------------------------------------- toasts, high contrast

describe('QF-12 kits: the toast chip shows the high-contrast shirt the players wear when that setting is on', () => {
  let screen: FakeElement;
  beforeEach(() => {
    const dom = makeAppDom();
    screen = dom.screen;
    vi.stubGlobal('document', dom.doc);
    vi.stubGlobal('window', dom.win);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('goal toast chip = resolveMatchKits(..., highContrast) shirt; follows the setting toggled mid-match', async () => {
    const { initMatch } = await import('../../src/sim/init');
    const config = createMatchConfig();
    config.homeClub = 2;
    config.awayClub = 7;
    config.homeKit = KitSlot.HOME;
    config.awayKit = KitSlot.AWAY;
    const s = initMatch(config, CLUBS);
    let settings: Settings = createDefaultSettings();
    settings.accessibility.highContrastKits = true;
    const ctx = {
      settings: { get: () => settings, update: vi.fn(), subscribe: () => () => undefined },
    } as unknown as AppContext;
    const toasts = createToasts();
    toasts.mount(screen as unknown as HTMLElement, ctx);
    toasts.setMatch(s, CLUBS);
    const chip = (): string => (screen.querySelector('.ht-chip') as unknown as { style: { background: string } }).style.background;
    const goal = (team: number): void => {
      const ev = createEventBuffer();
      ev.emit(EventType.GOAL, team, team === 0 ? 9 : 20, -1, 0);
      toasts.onEvents(ev, s);
      toasts.update(s, { dtMs: 16, alpha: 1, ticks: 1, paused: false } as never, null);
    };
    goal(0);
    const hc = resolveMatchKits(s, CLUBS, true);
    expect(chip()).toBe(kitHex(hc.outfield[0].shirt));
    // The setting goes off mid-match: the next toast uses the normal worn shirt.
    settings = createDefaultSettings();
    for (let i = 0; i < 400; i++) toasts.update(s, { dtMs: 16, alpha: 1, ticks: 1, paused: false } as never, null);
    goal(1);
    for (let i = 0; i < 60; i++) toasts.update(s, { dtMs: 16, alpha: 1, ticks: 1, paused: false } as never, null);
    const plain = resolveMatchKits(s, CLUBS, false);
    expect(chip()).toBe(kitHex(plain.outfield[1].shirt));
    expect(kitHex(hc.outfield[0].shirt)).not.toBe(kitHex(plain.outfield[0].shirt));
    toasts.dispose();
  });
});
