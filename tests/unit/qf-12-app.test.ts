/**
 * [QF-12] App, modes and screens follow-up: regression tests for defects found in the QF-12 hunt (one describe per
 * defect, named after the symptom).
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppContext, DeviceRegistry, MatchSummary, Screen, ScreenId } from '../../src/contracts/app';
import { ControllerKind, KitSlot, MatchPhase, ModeId, Period } from '../../src/contracts/enums';
import { T_RULES } from '../../src/contracts/tuning';
import { step } from '../../src/sim/step';
import { pumpSkip, sendSkip, skipPending } from '../../src/ui/screens/halfTime';
import { createMatchConfig } from '../../src/contracts/state';
import { initMatch } from '../../src/sim/init';
import { resolveKits, resolveMatchKits } from '../../src/render/kits';
import { defaultSetup } from '../../src/modes/setup';
import { teamKit, wornShirts } from '../../src/ui/hud/scoreboard';
import { quickPlaySummary, rgbToCss } from '../../src/ui/screens/main';
import { CLUBS } from '../../src/data/clubs';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { createSession } from '../../src/app/session';
import type { AppSession } from '../../src/app/types';
import { createCup, loadCup } from '../../src/modes/cup';
import { cupTieFinished } from '../../src/ui/screens/cup';
import { cupResultOf } from '../../src/ui/screens/fullTime';
import { emptyTeamStats } from '../../src/modes/stats';
import { loadRecords } from '../../src/modes/records';
import { newFlow, type FlowMode } from '../../src/ui/screens/matchFlow';
import { optionsFromSettings, startSetup } from '../../src/ui/screens/matchSettings';
import { fakeCtx } from './mod-01-fakes';

function summary(g0: number, g1: number, winner: number, shootout: [number, number] | null = null): MatchSummary {
  const a = emptyTeamStats();
  const b = emptyTeamStats();
  a.goals = g0;
  b.goals = g1;
  return { teams: [a, b], players: [], goals: [], playerOfMatch: null, shootout, winner, forfeit: -1, ticks: 1000 };
}

describe('QF-12 records: matches started through the Kick-Off / Friend / Shoot-out flow count', () => {
  const modes: [FlowMode, string][] = [[ModeId.KICK_OFF, 'Kick-Off'], [ModeId.FRIEND_LOCAL, 'Play a Friend'], [ModeId.SHOOT_OUT, 'Shoot-out']];
  for (const [mode, name] of modes) {
    it(`${name}: Start's setup records the finished match once; a quit or a restart's teardown never does`, () => {
      const ctx = fakeCtx();
      const flow = newFlow(ctx, mode);
      flow.setup.config.humans[0] = { ...flow.setup.config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 };
      flow.setup.bindings = [{ human: 0, deviceIds: ['touch'] }];
      const setup = startSetup(ctx, flow.setup, optionsFromSettings(ctx.settings.get()), mode);
      expect(loadRecords(ctx.settings).played).toBe(0);
      setup.onFinish!(summary(2, 1, 0), true); // quit: not kept
      expect(loadRecords(ctx.settings).played).toBe(0);
      setup.onFinish!(summary(2, 1, 0), false);
      let r = loadRecords(ctx.settings);
      expect(r.played).toBe(1);
      expect(r.won).toBe(1);
      expect(r.goalsFor).toBe(2);
      // Rematch (session.restart spreads the setup with a new seed): the next finished match counts once more.
      const rematch = { ...setup, config: { ...setup.config, seed: 99 } };
      rematch.onFinish!(summary(0, 1, 1), false);
      r = loadRecords(ctx.settings);
      expect(r.played).toBe(2);
      expect(r.lost).toBe(1);
      expect(r.streak).toBe(0);
      expect(r.bestStreak).toBe(1);
    });
  }

  it('a CPU-only flow match (both humans sitting out) is not recorded', () => {
    const ctx = fakeCtx();
    const flow = newFlow(ctx, ModeId.KICK_OFF);
    const setup = startSetup(ctx, flow.setup, optionsFromSettings(ctx.settings.get()), ModeId.KICK_OFF);
    setup.onFinish!(summary(1, 0, 0), false);
    expect(loadRecords(ctx.settings).played).toBe(0);
  });
});

/** Real router + session with fake presentation (no DOM), screens as empty stubs. */
function sessionRig() {
  const focus = { attach: vi.fn(), detach: vi.fn(), handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined) };
  const router = createRouter({ appendChild: () => undefined } as unknown as HTMLElement, () => ({ focus } as unknown as AppContext), {
    listen: false,
    createContainer: () => ({ remove() {} }) as unknown as HTMLElement,
  });
  const mounted: { id: ScreenId; params: Record<string, unknown> }[] = [];
  for (const id of ['main', 'cup', 'loading', 'match', 'half-time', 'full-time'] as ScreenId[]) {
    router.register(id, (): Screen => ({ id, mount(_r, _c, params) { mounted.push({ id, params }); }, unmount() {} }));
  }
  router.go('main');
  router.go('cup');
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
  return { router, session, errors, mounted };
}

const settle = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

describe('QF-12 cup: a finished tie shows the final full-time screen (stats, player of the match) before the cup', () => {
  it('POST_MATCH -> full-time (final, summary) with the tie recorded; Continue -> the cup with its result card; a quit -> the cup, tie unplayed', async () => {
    const ctx = fakeCtx();
    const run = createCup(ctx, { size: 8, humanClubs: [3], seed: 77 });
    const at = run.pendingTie()!;
    const r = sessionRig();
    const setup = run.nextMatch({ onFinished: (_s, quit) => cupTieFinished(r.router, quit) })!;
    expect(cupResultOf(setup.modeData)).toEqual(at);
    r.session.start(setup);
    await settle();
    expect(r.router.current).toBe('match');
    // The tie ends: a human win.
    const rt = r.session.runtime()!;
    const side = setup.config.humans[0]!.side;
    rt.curr.teams[side]!.goals = 2;
    rt.curr.match.winner = side;
    rt.curr.match.finished = 1;
    rt.curr.match.phase = MatchPhase.POST_MATCH;
    r.session.afterTick(rt);
    expect(r.session.finished).toBe(true);
    expect(r.router.current).toBe('full-time');
    const ft = r.mounted[r.mounted.length - 1]!;
    expect(ft.id).toBe('full-time');
    expect(ft.params.final).toBe(true);
    expect(ft.params.summary).not.toBeNull();
    // Recorded already (the saved cup moved on), before any button on the screen.
    const saved = loadCup(ctx)!;
    expect(saved.state.rounds[at.round]![at.tie]!.winner).toBe(3);
    // Continue (fullTime.ts ft-cup): release the match, back to the cup with the result card.
    const result = cupResultOf(r.session.getSetup()!.modeData);
    r.session.quit();
    r.router.go('cup', result ? { result } : {});
    expect(r.router.stack).toEqual(['main', 'cup']);
    expect(r.mounted[r.mounted.length - 1]!.params.result).toEqual(at);
    expect(r.session.active).toBe(false);

    // Next tie, quit from the pause menu: straight back to the cup, the tie still to play.
    const run2 = loadCup(ctx)!;
    const at2 = run2.pendingTie();
    if (at2) {
      const setup2 = run2.nextMatch({ onFinished: (_s, quit) => cupTieFinished(r.router, quit) })!;
      r.session.start(setup2);
      await settle();
      r.session.pause(0);
      r.session.quit();
      expect(r.router.current).toBe('cup');
      expect(r.router.stack).toEqual(['main', 'cup']);
      expect(loadCup(ctx)!.state.rounds[at2.round]![at2.tie]!.winner).toBe(-1);
    }
    expect(r.errors).toEqual([]);
  });

  it('cupResultOf reads only a cup payload', () => {
    expect(cupResultOf({ kind: 'cup', seed: 1, round: 2, tie: 1 })).toEqual({ round: 2, tie: 1 });
    expect(cupResultOf({ kind: 'online', round: 0, tie: 0 })).toBeNull();
    expect(cupResultOf({ kind: 'cup', round: 1.5, tie: 0 })).toBeNull();
    expect(cupResultOf(null)).toBeNull();
    expect(cupResultOf(undefined)).toBeNull();
  });
});

describe('QF-12 kits: the HUD, the Play now card and the Play now setup show the kits the players wear', () => {
  const pairs: [number, number][] = [];
  for (let h = 0; h < CLUBS.length; h++) for (let a = 0; a < CLUBS.length; a++) if (h !== a) pairs.push([h, a]);

  it('HUD colours (scoreboard chip, radar, toast chip) follow the renderer\'s clash check for a raw HOME / AWAY request (online, old Play now)', () => {
    let clashing = 0;
    for (const [h, a] of pairs) {
      const c = createMatchConfig();
      c.homeClub = h;
      c.awayClub = a;
      c.homeKit = KitSlot.HOME;
      c.awayKit = KitSlot.AWAY;
      const s = initMatch(c, CLUBS);
      const pitch = resolveMatchKits(s, CLUBS, false);
      const worn = wornShirts(s, CLUBS, false)!;
      expect(worn, `${h}-${a}`).toEqual([pitch.outfield[0].shirt, pitch.outfield[1].shirt]);
      // The requested kit the HUD used to show differs from the worn one for the clashing pairings.
      const req = [teamKit(CLUBS[h], s.teams[0]!.kit)!.shirt, teamKit(CLUBS[a], s.teams[1]!.kit)!.shirt];
      if (req[0] !== worn[0] || req[1] !== worn[1]) clashing++;
      const hc = resolveMatchKits(s, CLUBS, true);
      expect(wornShirts(s, CLUBS, true), `${h}-${a} high contrast`).toEqual([hc.outfield[0].shirt, hc.outfield[1].shirt]);
    }
    expect(clashing).toBeGreaterThan(0);
  });

  it('Play now (defaultSetup) requests kits that need no switch, and the main menu card shows the worn shirts, for every saved club pair', () => {
    for (const [h, a] of pairs) {
      const ctx = fakeCtx();
      ctx.settings.update((st) => {
        st.match.homeClub = h;
        st.match.awayClub = a;
        st.match.homeKit = KitSlot.HOME;
        st.match.awayKit = KitSlot.AWAY;
      });
      const setup = defaultSetup(ctx);
      const k = resolveKits(CLUBS[h]!, CLUBS[a]!, setup.config.homeKit, setup.config.awayKit, false);
      expect(k.slot, `${h}-${a} config kits are the worn kits`).toEqual([setup.config.homeKit, setup.config.awayKit]);
      const card = quickPlaySummary(ctx.settings.get(), CLUBS);
      expect(card.home.color, `${h}-${a} card home`).toBe(rgbToCss(k.outfield[0].shirt));
      expect(card.away.color, `${h}-${a} card away`).toBe(rgbToCss(k.outfield[1].shirt));
    }
  });
});

describe('QF-12 full-time interim: Continue pressed before the sim takes a SKIP is kept, not lost', () => {
  async function toFullTime() {
    const r = sessionRig();
    const config = createMatchConfig();
    config.seed = 4321;
    config.halfMinutes = 2;
    config.humans[0] = { ...config.humans[0]!, kind: ControllerKind.HUMAN, side: 0 };
    r.session.start({ config, bindings: [{ human: 0, deviceIds: ['touch'] }] });
    await settle();
    const rt = r.session.runtime()!;
    const ctx = { session: r.session, devices: { lastActive: () => null, list: () => [] } } as unknown as AppContext;
    const tickOnce = (): void => {
      const next = rt.curr.tick + 1;
      rt.provider.take(next, rt.frames, rt.curr);
      step(rt.curr, rt.frames, rt.events);
      r.session.afterTick(rt);
    };
    for (let i = 0; i < 20_000 && rt.curr.match.phase !== MatchPhase.FULL_TIME; i++) {
      const m = rt.curr.match;
      if ((m.period === Period.FIRST_HALF || m.period === Period.SECOND_HALF) && m.clockRunning === 1 && m.periodT < m.periodLen - 2) {
        m.periodT = m.periodLen - 2;
        m.addedT = 0;
      }
      if (m.phase >= MatchPhase.KICK_OFF && m.phase <= MatchPhase.PENALTY && m.restart.ready === 1 && m.restart.timeoutT > 2) m.restart.timeoutT = 2;
      tickOnce();
    }
    expect(rt.curr.match.phase).toBe(MatchPhase.FULL_TIME);
    expect(r.router.current).toBe('full-time');
    return { r, rt, ctx, tickOnce };
  }

  it('Continue in the first ticks of FULL_TIME ends the break at fullTimeMinTicks (was: ignored, the whole fullTimeTicks)', async () => {
    const { rt, ctx, tickOnce, r } = await toFullTime();
    expect(rt.curr.match.phaseT).toBeLessThan(T_RULES.fullTimeMinTicks);
    sendSkip(ctx); // the interim screen's Continue / Back
    expect(skipPending()).toBe(true);
    let ticks = 0;
    while (rt.curr.match.phase === MatchPhase.FULL_TIME && ticks < T_RULES.fullTimeTicks + 10) {
      pumpSkip(ctx); // the screen's onFrame
      tickOnce();
      ticks++;
    }
    expect(rt.curr.match.phase).toBe(MatchPhase.POST_MATCH);
    expect(ticks).toBeLessThanOrEqual(T_RULES.fullTimeMinTicks + 3);
    expect(ticks).toBeLessThan(T_RULES.fullTimeTicks - 30);
    expect(skipPending()).toBe(false);
    expect(r.session.finished).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('a kept Continue is dropped when the break ends by itself or the match is left; a late press goes at once', async () => {
    const { rt, ctx, tickOnce, r } = await toFullTime();
    while (rt.curr.match.phaseT < T_RULES.fullTimeMinTicks) tickOnce();
    sendSkip(ctx);
    expect(skipPending()).toBe(false); // accepted now: queued straight away
    for (let i = 0; i < 3 && rt.curr.match.phase === MatchPhase.FULL_TIME; i++) tickOnce();
    expect(rt.curr.match.phase).toBe(MatchPhase.POST_MATCH);
    r.session.quit();
    // A press kept in one match never leaks into the next.
    const b = await toFullTime();
    sendSkip(b.ctx);
    expect(skipPending()).toBe(true);
    b.r.session.quit();
    pumpSkip(b.ctx);
    expect(skipPending()).toBe(false);
  });
});
