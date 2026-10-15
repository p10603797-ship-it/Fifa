/**
 * INT-B: session wiring for the app layer.
 *  - setHumanDevice (D-019, PAD-03 card): 'cpu' hands the side over through the frame (Command.HAND_TO_CPU) and
 *    drops that human's sources; a device list rebinds the human mid-match (dropped sources disposed, new ones
 *    created, kept ones untouched, setup bindings updated); refusals (online / custom provider, no match, not a
 *    playing human, a device another human names).
 *  - local provider rebind: explicit beats wildcard, a pad handed away is never reclaimed by a wildcard.
 *  - SessionDeps.onTick runs first in afterTick (replay recorder); errors are reported once per match.
 *  - onPause / onMatchEnd hooks (rumble stop); pause releases every source synchronously and a pause while paused is
 *    ignored (PAD-02 CR 2).
 *  - prepareState: an injected hook runs once on the fresh state; [QF-12] by default the session adds nothing (the
 *    practice free-play layout comes from sim/init initMatch itself).
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  AppContext, DeviceInfo, DeviceRegistry, HumanBinding, MatchSetup, Screen, ScreenId, TickInputProvider,
} from '../../src/contracts/app';
import { NUM_SLOTS, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { Btn, clearInputFrame, type InputFrame, type InputSource } from '../../src/contracts/input';
import { Command, ControllerKind, ModeId, PracticeKind } from '../../src/contracts/enums';
import { createMatchConfig, type MatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createNullRenderer } from '../../src/app/nullRenderer';
import { createRouter } from '../../src/app/router';
import { cleanDeviceIds, createSession, withBinding, type SessionDeps } from '../../src/app/session';
import { ANY_DEVICE, createLocalInputProvider, type LocalInputProvider } from '../../src/app/localInput';
import type { AppSession, MatchRuntime } from '../../src/app/types';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const flush = async (): Promise<void> => {
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
};

interface FakeSource extends InputSource {
  disposed: boolean;
  released: number;
  human: number;
  /** Buttons this source reports every sample. */
  hold: number;
}

function fakeDevices(ids: string[]) {
  const list: DeviceInfo[] = ids.map((id) => ({
    id, kind: id === 'touch' ? 'touch' : id === 'keyboard' ? 'keyboard' : 'pad', label: id, family: 0, connected: true,
  }));
  const created: FakeSource[] = [];
  const subs: ((d: DeviceInfo[]) => void)[] = [];
  const devices: DeviceRegistry & { created: FakeSource[]; add(id: string): void; live(id: string): FakeSource[] } = {
    created,
    list: () => list,
    subscribe(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
    createSource(id, human) {
      const s: FakeSource = {
        id, kind: 'pad', disposed: false, released: 0, human, hold: 0,
        sample(out: InputFrame) {
          clearInputFrame(out);
          out.buttons = s.hold;
        },
        releaseAll() { s.released++; },
        dispose() { s.disposed = true; },
      };
      created.push(s);
      return s;
    },
    lastActive: () => null,
    add(id) {
      list.push({ id, kind: 'pad', label: id, family: 0, connected: true });
      for (const f of subs.slice()) f(list);
    },
    live: (id) => created.filter((s) => s.id === id && !s.disposed),
  };
  return devices;
}

function harness(devIds: string[] = ['touch', 'pad:1', 'pad:2', 'keyboard'], over: Partial<SessionDeps> = {}) {
  const devices = fakeDevices(devIds);
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
  const onError = vi.fn();
  const providers: LocalInputProvider[] = [];
  const session = createSession({
    router, renderer: createNullRenderer(),
    hud: { mount: vi.fn(), setMatch: vi.fn(), update: vi.fn(), onEvents: vi.fn(), setVisible: vi.fn(), dispose: vi.fn() },
    audio, devices, diagnostics: { log: vi.fn(), recent: () => [], debug: false, setDebug: vi.fn(), report: () => '' },
    clubs: CLUBS, getProjector: () => null,
    createLocalProvider: (...args) => {
      const p = createLocalInputProvider(...args);
      providers.push(p);
      return p;
    },
    yieldFrame: () => Promise.resolve(),
    onError,
    ...over,
  });
  const rt = (): MatchRuntime => (session as AppSession).runtime()!;
  /** One tick through the real provider and sim (what the loop does). */
  const tickOnce = (): void => {
    const r = rt();
    const next = r.curr.tick + 1;
    r.provider.take(next, r.frames, r.curr);
    step(r.curr, r.frames, r.events);
    session.afterTick(r);
  };
  return { session, devices, router, audio, onError, providers, rt, tickOnce };
}

function config(over: Partial<MatchConfig> = {}): MatchConfig {
  const c = createMatchConfig();
  c.seed = 99;
  return { ...c, ...over };
}

function twoHumans(): MatchConfig {
  const c = config();
  c.humans = [
    { ...c.humans[0]!, kind: ControllerKind.HUMAN, side: 0 },
    { ...c.humans[0]!, kind: ControllerKind.HUMAN, side: 1 },
  ];
  return c;
}

async function start(h: ReturnType<typeof harness>, bindings: HumanBinding[], cfg = config(), extra: Partial<MatchSetup> = {}) {
  h.session.start({ config: cfg, bindings, ...extra });
  await flush();
  expect(h.session.loaded).toBe(true);
}

describe('INT-B pure helpers', () => {
  it('withBinding replaces or adds one human, sorted, without touching the input', () => {
    const b: HumanBinding[] = [{ human: 1, deviceIds: ['pad:2'] }, { human: 0, deviceIds: ['touch'] }];
    const out = withBinding(b, 0, ['pad:1']);
    expect(out).toEqual([{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['pad:2'] }]);
    expect(b[1]!.deviceIds).toEqual(['touch']);
    expect(withBinding([], 1, ['touch'])).toEqual([{ human: 1, deviceIds: ['touch'] }]);
  });

  it('cleanDeviceIds de-duplicates and rejects non-strings / empty ids', () => {
    expect(cleanDeviceIds(['a', 'b', 'a'])).toEqual(['a', 'b']);
    expect(cleanDeviceIds([])).toEqual([]);
    expect(cleanDeviceIds(['a', ''])).toBeNull();
    expect(cleanDeviceIds(['a', 3] as unknown as string[])).toBeNull();
  });
});

describe('INT-B setHumanDevice (D-019, PAD-03 reconnect card)', () => {
  it("'cpu' sends HAND_TO_CPU through the frame, drops the human's sources, keeps his binding for a rematch", async () => {
    const h = harness();
    await start(h, [{ human: 0, deviceIds: ['pad:1', 'touch'] }]);
    expect(h.devices.live('pad:1')).toHaveLength(1);
    h.session.pause(-2);
    expect(h.session.setHumanDevice(0, 'cpu')).toBe(true);
    expect(h.devices.live('pad:1')).toHaveLength(0);
    expect(h.devices.live('touch')).toHaveLength(0);
    expect(h.session.getSetup()!.bindings).toEqual([{ human: 0, deviceIds: ['pad:1', 'touch'] }]);
    // While paused nothing ticks; the command waits in the queue and lands on the first tick after the resume.
    expect(h.rt().curr.ctrl[0]!.kind).toBe(ControllerKind.HUMAN);
    expect(h.session.resume(-2)).toBe(true);
    h.tickOnce();
    const s = h.rt().curr;
    expect(s.ctrl[0]!.kind).toBe(ControllerKind.NONE);
    expect(s.ctrl[2]!.kind).toBe(ControllerKind.CPU);
    expect(s.teams[0]!.cpu.active).toBe(1);
    // Handed over for the rest of the match: neither a second hand-off nor a rebind is accepted.
    expect(h.session.setHumanDevice(0, 'cpu')).toBe(false);
    expect(h.session.setHumanDevice(0, ['touch'])).toBe(false);
  });

  it('a device list rebinds mid-match: dropped sources disposed, new ones created, kept ones untouched', async () => {
    const h = harness();
    await start(h, [{ human: 0, deviceIds: ['pad:1', 'keyboard'] }]);
    const kb = h.devices.live('keyboard')[0]!;
    const pad1 = h.devices.live('pad:1')[0]!;
    expect(h.session.setHumanDevice(0, ['keyboard', 'touch'])).toBe(true);
    expect(pad1.disposed).toBe(true);
    expect(kb.disposed).toBe(false);
    expect(h.devices.live('keyboard')).toEqual([kb]);
    const touch = h.devices.live('touch');
    expect(touch).toHaveLength(1);
    expect(touch[0]!.human).toBe(0);
    expect(h.session.getSetup()!.bindings).toEqual([{ human: 0, deviceIds: ['keyboard', 'touch'] }]);
    expect(h.providers[0]!.devicesOf(0).sort()).toEqual(['keyboard', 'touch']);
    // The new source drives the human's frame.
    touch[0]!.hold = Btn.SPRINT;
    const r = h.rt();
    r.provider.take(r.curr.tick + 1, r.frames, r.curr);
    expect(r.frames[0]!.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });

  it('two humans: an unbound pad joins P1 (reconnect press), P2 keeps his pad and frames never cross', async () => {
    const h = harness();
    await start(h, [{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['pad:2'] }], twoHumans());
    h.devices.add('pad:3');
    expect(h.session.setHumanDevice(0, ['pad:1', 'pad:3'])).toBe(true);
    const p3 = h.devices.live('pad:3')[0]!;
    expect(p3.human).toBe(0);
    p3.hold = Btn.PASS;
    const r = h.rt();
    r.provider.take(r.curr.tick + 1, r.frames, r.curr);
    expect(r.frames[0]!.buttons & Btn.PASS).toBe(Btn.PASS);
    expect(r.frames[1]!.buttons & Btn.PASS).toBe(0);
    // P1 may not take P2's pad: two humans never share a device.
    expect(h.session.setHumanDevice(0, ['pad:2'])).toBe(false);
    expect(h.devices.live('pad:2')[0]!.human).toBe(1);
  });

  it('an explicit name beats another human\'s wildcard, and a dropped pad is never reclaimed by the wildcard', async () => {
    const h = harness(['touch', 'pad:1', 'pad:2']);
    await start(h, [{ human: 0, deviceIds: [ANY_DEVICE] }, { human: 1, deviceIds: ['pad:2'] }], twoHumans());
    expect(h.providers[0]!.devicesOf(0).sort()).toEqual(['pad:1', 'touch']);
    // P2's pad died; he takes touch: touch moves from P1's wildcard to P2.
    expect(h.session.setHumanDevice(1, ['touch'])).toBe(true);
    expect(h.providers[0]!.devicesOf(1)).toEqual(['touch']);
    expect(h.providers[0]!.devicesOf(0)).toEqual(['pad:1']);
    // pad:2 (released by P2) shows up again: P1's wildcard must not start driving with it.
    h.devices.add('pad:2');
    expect(h.providers[0]!.devicesOf(0)).toEqual(['pad:1']);
    // A brand-new pad still joins the wildcard human.
    h.devices.add('pad:9');
    expect(h.providers[0]!.devicesOf(0).sort()).toEqual(['pad:1', 'pad:9']);
  });

  it('refuses outside a loaded match, for a custom input provider, a bad human or a non-playing human', async () => {
    const h = harness();
    expect(h.session.setHumanDevice(0, ['touch'])).toBe(false);
    h.session.start({ config: config(), bindings: [{ human: 0, deviceIds: ['touch'] }] });
    expect(h.session.setHumanDevice(0, ['touch'])).toBe(false); // still loading
    await flush();
    expect(h.session.setHumanDevice(-1, ['touch'])).toBe(false);
    expect(h.session.setHumanDevice(2, ['touch'])).toBe(false);
    expect(h.session.setHumanDevice(1, ['pad:1'])).toBe(false); // human 1 does not play (NONE)
    expect(h.session.setHumanDevice(1, 'cpu')).toBe(false);
    expect(h.session.setHumanDevice(0, ['touch', 7] as unknown as string[])).toBe(false);
    h.session.quit();

    const online = harness();
    const provider: TickInputProvider = {
      ready: () => true, take: vi.fn(), pump: vi.fn(), waiting: false, releaseAll: vi.fn(), dispose: vi.fn(), queueCommand: vi.fn(),
    };
    await start(online, [], config(), { inputProvider: provider });
    expect(online.session.setHumanDevice(0, 'cpu')).toBe(false);
    expect(online.session.setHumanDevice(0, ['touch'])).toBe(false);
    expect(provider.queueCommand).not.toHaveBeenCalled();
  });

  it('a rebind survives into restart() (same devices, fresh seed)', async () => {
    const h = harness();
    await start(h, [{ human: 0, deviceIds: ['pad:1'] }]);
    expect(h.session.setHumanDevice(0, ['touch'])).toBe(true);
    h.session.restart();
    await flush();
    expect(h.session.getSetup()!.bindings).toEqual([{ human: 0, deviceIds: ['touch'] }]);
    expect(h.devices.live('pad:1')).toHaveLength(0);
    expect(h.devices.live('touch')).toHaveLength(1);
  });
});

describe('INT-B session hooks', () => {
  it('onTick runs first in afterTick with the runtime; a throwing hook is reported once and play goes on', async () => {
    const order: string[] = [];
    let throwIt = false;
    const h = harness(undefined, {
      onTick: (rt) => {
        order.push(`tick ${rt.curr.tick}`);
        if (throwIt) throw new Error('recorder broke');
      },
    });
    await start(h, [{ human: 0, deviceIds: ['touch'] }]);
    h.tickOnce();
    h.tickOnce();
    expect(order).toEqual(['tick 1', 'tick 2']);
    throwIt = true;
    h.tickOnce();
    h.tickOnce();
    expect(order).toHaveLength(3); // stopped after the first failure
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.onError.mock.calls[0]![1]).toBe('session.onTick');
    // A new match gets the hook back.
    h.session.restart();
    await flush();
    throwIt = false;
    h.tickOnce();
    expect(order).toHaveLength(4);
  });

  it('pause releases every source synchronously and calls onPause; a pause while paused is ignored', async () => {
    const onPause = vi.fn();
    const h = harness(undefined, { onPause });
    await start(h, [{ human: 0, deviceIds: ['touch', 'pad:1'] }]);
    const srcs = h.devices.created.slice();
    h.session.pause(0);
    for (const s of srcs) expect(s.released).toBe(1);
    expect(onPause).toHaveBeenCalledWith(0);
    h.session.pause(1);
    h.session.pause(-1);
    expect(h.session.pausedBy).toBe(0);
    for (const s of srcs) expect(s.released).toBe(1);
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it('onMatchEnd runs at quit after load (rumble stop), not for a load that never finished', async () => {
    const onMatchEnd = vi.fn();
    const h = harness(undefined, { onMatchEnd });
    h.session.start({ config: config(), bindings: [] });
    h.session.quit();
    expect(onMatchEnd).not.toHaveBeenCalled();
    await start(h, [{ human: 0, deviceIds: ['touch'] }]);
    h.session.quit();
    expect(onMatchEnd).toHaveBeenCalledTimes(1);
  });

  it('prepareState runs once on the fresh state, before prev is cloned', async () => {
    const seen: SimState[] = [];
    const h = harness(undefined, { prepareState: (s) => { seen.push(s); s.players[3]!.x = 7.25; } });
    await start(h, [{ human: 0, deviceIds: ['touch'] }]);
    expect(seen).toHaveLength(1);
    const s = h.rt().curr;
    expect(seen[0]).toBe(s);
    expect(s.players[3]!.x).toBe(7.25);
    // prev was cloned after the hook, so interpolation never shows the state before it.
    expect(h.rt().prev.players[3]!.x).toBe(7.25);
  });

  it('qf-12: practice free play through the default session (no prepare hook): initMatch alone fields only the keeper', async () => {
    const h = harness();
    const cfg = config({ mode: ModeId.PRACTICE, practice: PracticeKind.FREE_PLAY });
    await start(h, [{ human: 0, deviceIds: ['touch'] }], cfg);
    const s = h.rt().curr;
    let away = 0;
    for (let i = PLAYERS_PER_TEAM; i < NUM_SLOTS; i++) if (s.players[i]!.active === 1) away++;
    expect(away).toBe(1);
    expect(s.players[s.teams[1]!.keeperSlot]!.active).toBe(1);
    expect(h.rt().prev.players[PLAYERS_PER_TEAM + 5]!.active).toBe(s.players[PLAYERS_PER_TEAM + 5]!.active);
  });

  it('qf-12: a non-practice match through the default session is exactly initMatch (nothing added after it)', async () => {
    const h = harness();
    const cfg = config();
    await start(h, [{ human: 0, deviceIds: ['touch'] }], cfg);
    const fresh = initMatch(cfg, CLUBS);
    expect(h.rt().curr.players.map((p) => p.active)).toEqual(fresh.players.map((p) => p.active));
    expect(h.rt().curr.players.map((p) => p.x)).toEqual(fresh.players.map((p) => p.x));
  });

  it('MatchHooks (online pause rules): allowPause can refuse a pause or a resume; onPauseChange / onQuit are told', async () => {
    const h = harness();
    const calls: string[] = [];
    let allow = true;
    await start(h, [{ human: 0, deviceIds: ['touch'] }], config(), {
      hooks: {
        allowPause: (by, pausing) => {
          calls.push(`allow ${by} ${pausing ? 'pause' : 'resume'}`);
          return allow;
        },
        onPauseChange: (p, by) => { calls.push(`change ${p ? 'paused' : 'resumed'} ${by}`); },
        onQuit: () => { calls.push('quit'); },
      },
    });
    allow = false;
    h.session.pause(0);
    expect(h.session.paused).toBe(false);
    allow = true;
    h.session.pause(0);
    expect(h.session.paused).toBe(true);
    allow = false;
    expect(h.session.resume(0)).toBe(false);
    allow = true;
    expect(h.session.resume(0)).toBe(true);
    h.session.quit();
    expect(calls).toEqual([
      'allow 0 pause', 'allow 0 pause', 'change paused 0', 'allow 0 resume', 'allow 0 resume', 'change resumed 0', 'quit',
    ]);
  });

  it('queueCommand reaches the frame after a rebind (the queue belongs to the provider, not the sources)', async () => {
    const h = harness();
    await start(h, [{ human: 0, deviceIds: ['touch'] }]);
    h.session.setHumanDevice(0, ['pad:1']);
    h.session.queueCommand(0, Command.SKIP, 0);
    const r = h.rt();
    r.provider.take(r.curr.tick + 1, r.frames, r.curr);
    expect(r.frames[0]!.cmd).toBe(Command.SKIP);
  });
});
