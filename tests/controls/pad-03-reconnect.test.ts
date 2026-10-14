/**
 * PAD-03 reconnect flow (section 10 "Disconnect mid-match: auto-pause with a reconnect card. Any pad button resumes.
 * Offer to hand that side to touch or the CPU."): the state machine over the real pad manager (PAD-01) and device
 * registry (bound pads), a session double with the real session's pause rules, card text, hand-off, queueing, pause
 * take-over, refused resumes, and the glitch "controller disconnect during a penalty" through the real sim.
 */
import { describe, expect, it } from 'vitest';
import type { HumanBinding, MatchSetup, PlatformInfo, SettingsStore } from '../../src/contracts/app';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame, type InputSource } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createDeviceRegistry, type DotkickDeviceRegistry } from '../../src/input/devices';
import { createPadManager, PadButton, type PadManager } from '../../src/input/pad/manager';
import {
  createReconnectFlow, createReconnectWatcher, RECONNECT_PAUSER, reconnectCardText, type ReconnectFlow, type ReconnectSession,
} from '../../src/input/pad/reconnect';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { makeScenario, runTicks } from '../harness/scenario';
import { mockPad, setBtn, type MockPad } from './pad-02-helpers';

// ---------------------------------------------------------------- doubles

interface FakeSession extends ReconnectSession {
  active: boolean;
  finished: boolean;
  paused: boolean;
  pausedBy: number;
  hidden: boolean;
  setup: MatchSetup;
  calls: [number, readonly string[] | 'cpu'][];
  resumes: number;
  hook: boolean;
}

/** Same pause rules as src/app/session.ts: only the pauser (or anyone for -1) resumes; hidden refuses. */
function fakeSession(bindings: HumanBinding[], hook = true): FakeSession {
  const s: FakeSession = {
    active: true, finished: false, paused: false, pausedBy: -1, hidden: false, calls: [], resumes: 0, hook,
    setup: { config: {} as MatchSetup['config'], bindings },
    pause(by) {
      if (!s.active || s.finished || s.paused) return;
      s.paused = true;
      s.pausedBy = by;
    },
    resume(by) {
      if (!s.active) return false;
      if (!s.paused) return true;
      if (s.pausedBy !== -1 && by !== s.pausedBy) return false;
      if (s.hidden) return false;
      s.paused = false;
      s.pausedBy = -1;
      s.resumes++;
      return true;
    },
    getSetup: () => s.setup,
  };
  if (hook) {
    s.setHumanDevice = (h, d) => {
      s.calls.push([h, d]);
      const b = s.setup.bindings.find((x) => x.human === h);
      if (b) b.deviceIds = d === 'cpu' ? [] : d.slice();
      return true;
    };
  }
  return s;
}

interface Rig {
  pads: MockPad[];
  list: (MockPad | null)[];
  mgr: PadManager;
  reg: DotkickDeviceRegistry;
  t: number;
  poll(): void;
  press(i: number, b?: number): void;
  release(i: number, b?: number): void;
  tap(i: number, b?: number): void;
  unplug(i: number): void;
  plug(i: number): void;
}

function rig(n = 2, touch = true): Rig {
  const pads = Array.from({ length: n }, (_, i) => mockPad(i));
  const list: (MockPad | null)[] = [null, null, null, null];
  pads.forEach((p, i) => { list[i] = p; });
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  const settings = createDefaultSettings();
  const store: SettingsStore = {
    get: () => settings, update: (m) => m(settings), subscribe: () => () => {}, reset: () => {}, persistent: false,
    loadProgress: () => null, saveProgress: () => {}, clearProgress: () => {},
  };
  const platform: PlatformInfo = { isIPad: true, isTouch: touch, isStandalone: false, supportsFullscreen: false, safeArea: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) };
  const reg = createDeviceRegistry({
    touchRoot: { ownerDocument: { defaultView: null } } as unknown as HTMLElement,
    getProjector: () => null, getState: () => null, settings: store, platform, onPause: () => {}, pads: mgr,
  });
  const r: Rig = {
    pads, list, mgr, reg, t: 1000,
    poll() { r.t += 16; mgr.poll(r.t); },
    press(i, b = 0) { setBtn(pads[i]!, b, 1); r.poll(); },
    release(i, b = 0) { setBtn(pads[i]!, b, 0); r.poll(); },
    tap(i, b = 0) { r.press(i, b); r.release(i, b); },
    unplug(i) { list[i] = null; pads[i]!.connected = false; r.poll(); },
    plug(i) { pads[i]!.connected = true; list[i] = pads[i]!; r.poll(); },
  };
  for (let i = 0; i < n; i++) r.tap(i); // activate: 'pad:1', 'pad:2', ...
  return r;
}

function platformOf(touch: boolean): Pick<PlatformInfo, 'isTouch'> {
  return { isTouch: touch };
}

function setupFlow(o: { pads?: number; touch?: boolean; hook?: boolean; bindings?: HumanBinding[]; bind?: [string, number][] } = {}) {
  const r = rig(o.pads ?? 2, o.touch ?? true);
  const bindings = o.bindings ?? [{ human: 0, deviceIds: ['pad:1'] }];
  const session = fakeSession(bindings, o.hook ?? true);
  const sources: InputSource[] = [];
  for (const [id, h] of o.bind ?? [['pad:1', 0]]) sources.push(r.reg.createSource(id, h));
  const flow = createReconnectFlow({ session, devices: r.reg, platform: platformOf(o.touch ?? true) });
  const step = (): void => { r.poll(); flow.update(r.t); };
  return { r, session, flow, sources, step };
}

// ---------------------------------------------------------------- state machine

describe('PAD-03 reconnect flow: disconnect -> pause + card -> any button resumes', () => {
  it('a bound pad that disconnects mid-match pauses at once and shows the card', () => {
    const { r, session, flow } = setupFlow();
    expect(flow.card).toBeNull();
    r.unplug(0);
    expect(session.paused).toBe(true);
    expect(session.pausedBy).toBe(RECONNECT_PAUSER);
    expect(flow.card).toMatchObject({ human: 0, deviceId: 'pad:1', label: 'Controller 1', reconnected: false, canTouch: true, canCpu: true, more: 0 });
    const t = reconnectCardText(flow.card!);
    expect(t.player).toBe('Player 1');
    expect(t.title).toBe('Controller 1 disconnected');
    expect(t.body).toBe('Press any button on a controller to continue, or hand this side to:');
  });

  it("while the card is up nobody else lifts the pause (player's Options, pause menu Resume, system resume)", () => {
    const { r, session } = setupFlow();
    r.unplug(0);
    expect(session.resume(0)).toBe(false);
    expect(session.resume(1)).toBe(false);
    expect(session.resume(-1)).toBe(false);
    expect(session.paused).toBe(true);
  });

  it('the same pad back (any index) relabels the card; its button press resumes', () => {
    const { r, session, flow, step } = setupFlow();
    r.unplug(0);
    r.plug(0);
    expect(flow.card!.reconnected).toBe(true);
    expect(reconnectCardText(flow.card!).title).toBe('Controller 1 reconnected');
    expect(reconnectCardText(flow.card!).body).toBe('Press any button to continue, or hand this side to:');
    step();
    expect(session.paused).toBe(true); // no press yet
    setBtn(r.pads[0]!, PadButton.EAST, 1);
    step();
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(false);
    expect(session.resumes).toBe(1);
  });

  it('a press on another, unbound pad binds it to that human and resumes', () => {
    const { r, session, flow, step } = setupFlow();
    r.unplug(0);
    step();
    setBtn(r.pads[1]!, PadButton.SOUTH, 1);
    step();
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(false);
    expect(session.calls).toEqual([[0, ['pad:1', 'pad:2']]]);
  });

  it("a pad bound to the other human never resumes player 1's card", () => {
    const { r, session, flow, step } = setupFlow({
      bindings: [{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['pad:2'] }], bind: [['pad:1', 0], ['pad:2', 1]],
    });
    r.unplug(0);
    step();
    setBtn(r.pads[1]!, PadButton.SOUTH, 1);
    step();
    expect(flow.card).not.toBeNull();
    expect(session.paused).toBe(true);
    expect(session.calls).toEqual([]);
  });

  it('a press that was already down when the card opened does not count; Home / Share are never read', () => {
    const { r, session, flow, step } = setupFlow();
    setBtn(r.pads[1]!, PadButton.SOUTH, 1);
    r.poll();
    r.unplug(0);
    step();
    step();
    expect(flow.card).not.toBeNull();
    setBtn(r.pads[1]!, 16, 1); // index 16 = Home on many pads (belongs to iPadOS)
    step();
    expect(flow.card).not.toBeNull();
    setBtn(r.pads[1]!, PadButton.SOUTH, 0);
    step();
    setBtn(r.pads[1]!, PadButton.SOUTH, 1);
    step();
    expect(session.paused).toBe(false);
  });
});

describe('PAD-03 hand-off to touch or the CPU', () => {
  it('Touch rebinds the human to the touch device and resumes', () => {
    const { r, session, flow } = setupFlow();
    r.unplug(0);
    expect(flow.handOff('touch')).toBe(true);
    expect(session.calls).toEqual([[0, ['touch']]]);
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(false);
  });

  it('Touch is not offered without a touch screen, or while the other human already plays on touch', () => {
    const a = setupFlow({ touch: false });
    a.r.unplug(0);
    expect(a.flow.card!.canTouch).toBe(false);
    expect(a.flow.handOff('touch')).toBe(false);
    const b = setupFlow({ bindings: [{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['touch'] }] });
    b.r.unplug(0);
    expect(b.flow.card!.canTouch).toBe(false);
    expect(b.flow.card!.canCpu).toBe(true);
  });

  it('CPU takes the side for the rest of the match; later disconnects of that human are ignored', () => {
    const { r, session, flow, step } = setupFlow({ pads: 3 });
    r.unplug(0);
    expect(flow.handOff('cpu')).toBe(true);
    expect(session.calls).toEqual([[0, 'cpu']]);
    expect(session.paused).toBe(false);
    // Even if a pad of that human comes back and goes again, the CPU keeps the side.
    r.plug(0);
    step();
    r.unplug(0);
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(false);
  });

  it('without the session hook (setHumanDevice CR) no hand-off is offered; the own pad still resumes', () => {
    const { r, session, flow, step } = setupFlow({ hook: false });
    r.unplug(0);
    expect(flow.card).toMatchObject({ canTouch: false, canCpu: false });
    expect(reconnectCardText(flow.card!).body).toBe('Press any button on a controller to continue.');
    expect(flow.handOff('cpu')).toBe(false);
    setBtn(r.pads[1]!, PadButton.SOUTH, 1);
    step();
    expect(flow.card).not.toBeNull(); // an unbound pad cannot be bound without the hook
    setBtn(r.pads[1]!, PadButton.SOUTH, 0);
    r.plug(0);
    step();
    setBtn(r.pads[0]!, PadButton.WEST, 1);
    step();
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(false);
  });
});

describe('PAD-03 several cards, pause ownership, refused resumes', () => {
  it('two missing humans queue oldest first; play resumes only after both are back', () => {
    const { r, session, flow, step } = setupFlow({
      pads: 3, bindings: [{ human: 0, deviceIds: ['pad:1'] }, { human: 1, deviceIds: ['pad:2'] }], bind: [['pad:1', 0], ['pad:2', 1]],
    });
    r.unplug(0);
    r.unplug(1);
    expect(flow.pending()).toEqual([0, 1]);
    expect(flow.card).toMatchObject({ human: 0, more: 1 });
    expect(reconnectCardText(flow.card!).more).toBe('Another controller is also disconnected.');
    r.plug(1);
    step();
    setBtn(r.pads[1]!, PadButton.SOUTH, 1); // player 2's own pad resolves player 2's card
    step();
    expect(flow.pending()).toEqual([0]);
    expect(session.paused).toBe(true);
    setBtn(r.pads[2]!, PadButton.SOUTH, 1); // a spare pad takes player 1's side
    step();
    expect(flow.pending()).toEqual([]);
    expect(session.paused).toBe(false);
  });

  it("a pause someone already held is taken over and handed back (that player's pause menu returns, no auto-resume)", () => {
    const { r, session, flow, step } = setupFlow();
    session.pause(0); // player 1 opened the pause menu
    r.unplug(0);
    expect(session.pausedBy).toBe(RECONNECT_PAUSER);
    expect(session.resume(0)).toBe(false);
    r.plug(0);
    step();
    setBtn(r.pads[0]!, PadButton.SOUTH, 1);
    step();
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(true);
    expect(session.pausedBy).toBe(0);
  });

  it('a resume the session refuses (hidden page) is retried, then shows the pause menu instead of resuming', () => {
    const { r, session, flow, step } = setupFlow();
    r.unplug(0);
    r.plug(0);
    step();
    session.hidden = true;
    setBtn(r.pads[0]!, PadButton.SOUTH, 1);
    step();
    expect(flow.card).toBeNull();
    expect(flow.holding).toBe(true);
    expect(session.pausedBy).toBe(RECONNECT_PAUSER);
    session.hidden = false;
    flow.update(r.t + 16);
    expect(flow.holding).toBe(false);
    expect(session.paused).toBe(true);
    expect(session.pausedBy).toBe(-1);
  });

  it('an idle paired pad that falls asleep while its human plays on touch never interrupts him', () => {
    const { r, session, flow } = setupFlow({ bindings: [{ human: 0, deviceIds: ['pad:1', 'touch'] }] });
    flow.noteActivity('touch', r.t + 5);
    r.unplug(0);
    expect(flow.card).toBeNull();
    expect(session.paused).toBe(false);
  });

  it('no card outside a live match (not active / finished); the session ending clears every card', () => {
    const a = setupFlow();
    a.session.active = false;
    a.r.unplug(0);
    expect(a.flow.card).toBeNull();
    const b = setupFlow();
    b.session.finished = true;
    b.r.unplug(0);
    expect(b.flow.card).toBeNull();
    const c = setupFlow();
    c.r.unplug(0);
    expect(c.flow.card).not.toBeNull();
    c.session.finished = true;
    c.flow.update(c.r.t + 16);
    expect(c.flow.card).toBeNull();
  });

  it('subscribe fires on card changes; dispose releases the pause it holds', () => {
    const { r, session, flow } = setupFlow();
    let n = 0;
    const off = flow.subscribe(() => { n++; });
    r.unplug(0);
    expect(n).toBe(1);
    r.plug(0);
    expect(n).toBe(2);
    off();
    flow.dispose();
    expect(session.paused).toBe(false);
  });

  it('Wave 0 watcher (kept): reports bound pads going away and coming back', () => {
    const r = rig(1);
    const log: string[] = [];
    const w = createReconnectWatcher({ manager: r.mgr, keys: ['pad:1'], onDisconnect: (k) => log.push(`-${k}`), onReconnect: (k) => log.push(`+${k}`) });
    r.unplug(0);
    expect(w.missing()).toEqual(['pad:1']);
    r.plug(0);
    expect(log).toEqual(['-pad:1', '+pad:1']);
    w.dispose();
  });
});

// ---------------------------------------------------------------- glitch: disconnect during a penalty

describe('PAD-03 glitch: controller disconnect during a penalty', () => {
  /** P1 (side 0) takes a penalty with a real pad through the real registry, flow and sim; ticks run only while not paused. */
  function penaltyMatch() {
    const r = rig(2);
    const session = fakeSession([{ human: 0, deviceIds: ['pad:1'] }]);
    const src = r.reg.createSource('pad:1', 0);
    const flow: ReconnectFlow = createReconnectFlow({ session, devices: r.reg, platform: platformOf(true) });
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], seed: 11 });
    const ev = createEventBuffer();
    ev.begin(s.tick);
    awardRestart(s, RestartKind.PENALTY, 0, 0, 0, ev);
    for (let i = 0; i < 200 && s.match.restart.ready !== 1; i++) runTicks(s, 1);
    expect(s.match.phase).toBe(MatchPhase.PENALTY);
    expect(s.match.restart.ready).toBe(1);
    const frames: InputFrame[] = [createInputFrame(), createInputFrame()];
    let ticksRun = 0;
    let wasPaused = false;
    /** One animation frame (two at 120 Hz per tick): flow update, pad poll, then a tick unless paused. */
    const frame = (): void => {
      r.t += 1000 / 60;
      flow.update(r.t);
      src.pollFrame!(r.t);
      if (session.paused) { wasPaused = true; return; }
      if (wasPaused) { src.releaseAll(); wasPaused = false; } // the session's resume releases every input
      src.sample(frames[0]!, { tick: s.tick + 1, human: 0, side: 0, state: s, projector: null });
      step(s, frames, ev);
      ticksRun++;
    };
    return { r, s, session, flow, src, frame, ticks: () => ticksRun };
  }

  it('no tick sees the lost pad: the penalty clock stands still, the aim is kept and nothing is struck while it is gone', () => {
    const m = penaltyMatch();
    const taker = m.s.match.restart.taker;
    // Aim at the right-hand corner with the left stick, let go of it (the aim persists).
    m.r.pads[0]!.axes[0] = 0.2; m.r.pads[0]!.axes[1] = 1;
    for (let i = 0; i < 10; i++) m.frame();
    m.r.pads[0]!.axes[0] = 0; m.r.pads[0]!.axes[1] = 0;
    for (let i = 0; i < 4; i++) m.frame();
    const aimZ = m.s.match.restart.aimZ;
    expect(aimZ).not.toBe(0);
    const restartT = m.s.match.restart.t;
    const tick0 = m.s.tick;
    // The pad dies mid-penalty.
    m.r.list[0] = null;
    m.r.pads[0]!.connected = false;
    for (let i = 0; i < 600; i++) m.frame(); // 10 s gone (RUL-11 would force a default kick at its 12 s timeout)
    expect(m.session.paused).toBe(true);
    expect(m.flow.card).toMatchObject({ human: 0, reconnected: false });
    expect(m.s.tick).toBe(tick0);
    expect(m.s.match.restart.t).toBe(restartT);
    expect(m.s.match.restart.taken).toBe(0);
    expect(m.s.players[taker]!.act).not.toBe(ActionKind.SHOT);
    // Back: the press that resumes never reaches the game (no shot from it), the aim is the one set before.
    m.r.pads[0]!.connected = true;
    m.r.list[0] = m.r.pads[0]!;
    m.frame();
    setBtn(m.r.pads[0]!, PadButton.EAST, 1); // Circle = SHOOT in a penalty: here it only resumes
    m.frame();
    expect(m.session.paused).toBe(false);
    for (let i = 0; i < 20; i++) m.frame();
    expect(m.s.match.restart.taken).toBe(0);
    expect(m.s.players[taker]!.act).not.toBe(ActionKind.SHOT);
    expect(m.s.match.restart.aimZ).toBe(aimZ);
    // Releasing and pressing Circle again takes the penalty toward the kept aim.
    setBtn(m.r.pads[0]!, PadButton.EAST, 0);
    m.frame();
    setBtn(m.r.pads[0]!, PadButton.EAST, 1);
    for (let i = 0; i < 6; i++) m.frame();
    setBtn(m.r.pads[0]!, PadButton.EAST, 0);
    let struck = false;
    for (let i = 0; i < 90 && !struck; i++) { m.frame(); struck = m.s.match.restart.taken === 1 || m.s.match.phase !== MatchPhase.PENALTY; }
    expect(struck).toBe(true);
    expect(Math.sign(m.s.ball.vz || m.s.ball.z)).toBe(Math.sign(aimZ));
  });

  it('a pad lost while Circle is held mid power-up never releases the shot during the outage', () => {
    const m = penaltyMatch();
    const taker = m.s.match.restart.taker;
    setBtn(m.r.pads[0]!, PadButton.EAST, 1);
    for (let i = 0; i < 6; i++) m.frame();
    const charging = m.s.players[taker]!.actCharging;
    const tick0 = m.s.tick;
    m.r.list[0] = null;
    m.r.pads[0]!.connected = false;
    for (let i = 0; i < 120; i++) m.frame();
    expect(m.session.paused).toBe(true);
    expect(m.s.tick).toBe(tick0);
    expect(m.s.players[taker]!.actCharging).toBe(charging);
    expect(m.s.match.restart.taken).toBe(0);
    const power = m.s.players[taker]!.actPower;
    // Back and resumed: Circle is no longer held, so the power-up ends at the power reached before the outage
    // (the sim has no "cancel charge"; the outage itself never added or released anything).
    m.r.pads[0]!.connected = true;
    m.r.list[0] = m.r.pads[0]!;
    setBtn(m.r.pads[0]!, PadButton.EAST, 0);
    m.frame();
    setBtn(m.r.pads[0]!, PadButton.SOUTH, 1);
    m.frame();
    expect(m.session.paused).toBe(false);
    expect(m.s.players[taker]!.actPower).toBeGreaterThanOrEqual(power);
  });
});
