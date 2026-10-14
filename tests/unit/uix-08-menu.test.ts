/**
 * UIX-08 menu tests on the UIX-01 fake DOM (Node, no jsdom): the quick-sub prompt opened by a frame carrying
 * Command.QUICK_SUB (pauses for that human, lists the most tired players, select-and-swap, Done resumes and the order
 * goes out), refusals for a non-pauser, Back on sub-pages (menu action and Escape) returning to the main page, and
 * the flush of remaining orders when the match screen goes away while play runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MenuAction, type AppContext } from '../../src/contracts/app';
import { Command, Role } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { closeTopModal } from '../../src/ui/components';
import { createPauseMenu, resetTeamOrders, teamOrders, type PauseMenu } from '../../src/ui/screens/pause';
import { makeScenario } from '../harness/scenario';
import { FakeElement, FakeEvent, makeAppDom, type FakeWindow } from './uix-01-fakedom';

type Sub = (a: MenuAction) => boolean | void;

// The fake DOM has no replaceChildren: add it for this file.
const proto = FakeElement.prototype as unknown as { replaceChildren?: (...n: FakeElement[]) => void };
if (!proto.replaceChildren) {
  proto.replaceChildren = function (this: FakeElement, ...nodes: FakeElement[]) {
    while (this.children.length > 0) this.removeChild(this.children[0]!);
    for (const n of nodes) this.append(n);
  };
}

let win: FakeWindow;
let screen: FakeElement;
let s: SimState;
let frames: InputFrame[];
let subs: Sub[];
let session: {
  active: boolean; paused: boolean; pausedBy: number; pause: (h: number) => void; resume: (h: number) => boolean;
  restart: () => void; quit: () => void; queueCommand: ReturnType<typeof vi.fn>; getState: () => SimState; getSetup: () => unknown;
  runtime: () => { curr: SimState; frames: InputFrame[] };
};
let lastDevice: string | null;
let menu: PauseMenu;

function makeCtx(): AppContext {
  subs = [];
  session = {
    active: true, paused: false, pausedBy: -1,
    pause(h) {
      if (this.paused) return;
      this.paused = true;
      this.pausedBy = h;
    },
    resume(h) {
      if (!this.paused) return true;
      if (this.pausedBy !== -1 && h !== this.pausedBy) return false;
      this.paused = false;
      this.pausedBy = -1;
      return true;
    },
    restart: vi.fn(), quit: vi.fn(), queueCommand: vi.fn(),
    getState: () => s,
    getSetup: () => ({ config: s.config, bindings: [{ human: 0, deviceIds: ['touch'] }, { human: 1, deviceIds: ['keyboard'] }] }),
    runtime: () => ({ curr: s, frames }),
  };
  return {
    session, clubs: CLUBS,
    audio: { playUi: vi.fn() },
    router: { go: vi.fn(), back: vi.fn() },
    settings: { get: () => createDefaultSettings(), update: vi.fn(), subscribe: () => () => undefined },
    devices: { lastActive: () => lastDevice, list: () => [] },
    focus: {
      attach: vi.fn(), detach: vi.fn(), focus: vi.fn(), handle: vi.fn(),
      onAction: (fn: Sub) => {
        subs.unshift(fn);
        return () => {
          const i = subs.indexOf(fn);
          if (i >= 0) subs.splice(i, 1);
        };
      },
    },
  } as unknown as AppContext;
}

/** Send a menu action to the subscribers like the FocusNavigator (latest first); true when consumed. */
function action(a: MenuAction): boolean {
  for (const fn of subs.slice()) if (fn(a) === true) return true;
  return false;
}

const q = (id: string): FakeElement | null => screen.querySelector(`[data-testid="${id}"]`);
const click = (id: string): void => {
  const el = q(id);
  if (!el) throw new Error(`no ${id}`);
  el.dispatchEvent(new FakeEvent('click', { detail: 0 }));
};

function benchField(team: number): number[] {
  const out: number[] = [];
  for (let r = 11; r < 18; r++) if (s.squads[team]![r]!.pos !== Role.GK) out.push(r);
  return out;
}

beforeEach(() => {
  const dom = makeAppDom();
  win = dom.win;
  screen = dom.screen;
  vi.stubGlobal('document', dom.doc);
  vi.stubGlobal('window', dom.win);
  resetTeamOrders();
  s = makeScenario({ humans: 2 });
  frames = [createInputFrame(), createInputFrame()];
  lastDevice = 'touch';
  menu = createPauseMenu();
  menu.mount(screen as unknown as HTMLElement, makeCtx());
});

afterEach(() => {
  menu.dispose();
  while (closeTopModal()) { /* leftovers */ }
  vi.unstubAllGlobals();
});

describe('UIX-08 quick-sub prompt', () => {
  it('a frame with QUICK_SUB pauses for that human and opens the compact prompt with the most tired players', () => {
    s.players[14]!.stamina = 0.3; // away slot 3
    s.players[17]!.stamina = 0.2; // away slot 6
    frames[1]!.cmd = Command.QUICK_SUB;
    s.tick = 50;
    menu.update(1000);
    expect(session.paused).toBe(true);
    expect(session.pausedBy).toBe(1);
    menu.show();
    expect(menu.page).toBe('quick');
    expect(q('pause-page-quick')).not.toBeNull();
    const tired = q('pause-tired')!.querySelectorAll('[data-drop="xi"]').map((e) => e.dataset.testid);
    expect(tired.length).toBe(4);
    expect(tired.slice(0, 2)).toEqual(['pause-xi-17', 'pause-xi-14']);
    // The same tick is not read twice.
    menu.hide();
    session.paused = false;
    menu.update(1016);
    expect(session.paused).toBe(false);
  });

  it('select-and-swap queues the substitution; Done (or Back) resumes and the order goes out once play runs', () => {
    frames[1]!.cmd = Command.QUICK_SUB;
    s.tick = 10;
    menu.update(0);
    menu.show();
    lastDevice = 'keyboard'; // P2 acts
    const sub = benchField(1)[0]!;
    click(`pause-bench-${sub}`);
    expect(q(`pause-bench-${sub}`)!.hasAttribute('data-selected')).toBe(true);
    click('pause-xi-12');
    expect(teamOrders(s, 1).subs).toEqual([{ out: 12, inRoster: sub, sentTick: -1 }]);
    expect(q(`pause-pending-${sub}`)).not.toBeNull();
    expect(session.queueCommand).not.toHaveBeenCalled();
    // Back on the prompt = Done: P2 paused, P2 resumes.
    expect(action(MenuAction.BACK)).toBe(true);
    expect(session.paused).toBe(false);
    expect(session.queueCommand).toHaveBeenCalledWith(1, Command.SUBSTITUTE, 12 | (sub << 8));
  });

  it('Done by the other human is refused with a note', () => {
    frames[1]!.cmd = Command.QUICK_SUB;
    s.tick = 10;
    menu.update(0);
    menu.show();
    lastDevice = 'touch'; // P1
    click('pause-quick-done');
    expect(session.paused).toBe(true);
    expect(q('pause-sub-note')!.textContent).toBe('Only Player 2 can resume');
  });
});

describe('UIX-08 pause menu rules and Back', () => {
  it('the non-pauser cannot resume, restart or quit; the note names the pauser and returns after REFUSAL_NOTE_MS', () => {
    session.pause(1);
    menu.show();
    lastDevice = 'touch';
    click('pause-resume');
    expect(session.paused).toBe(true);
    const who = screen.querySelector('.pause-who')!;
    expect(who.textContent).toBe('Only Player 2 can resume');
    click('pause-restart');
    expect(session.restart).not.toHaveBeenCalled();
    expect(who.textContent).toBe('Only Player 2 can restart');
    click('pause-quit');
    expect(session.quit).not.toHaveBeenCalled();
    expect(q('pause-quit-dialog')).toBeNull();
    menu.update(performance.now() + 5000);
    expect(screen.querySelector('.pause-who')!.textContent).toBe('Paused by Player 2');
    // The pauser quits through the confirmation.
    lastDevice = 'keyboard';
    click('pause-quit');
    expect(q('pause-quit-dialog')).not.toBeNull();
    click('pause-quit-confirm');
    expect(session.quit).toHaveBeenCalledTimes(1);
  });

  it('Back on a sub-page returns to the main page (menu BACK and Escape); on the main page it is left to the router', () => {
    session.pause(0);
    menu.show();
    click('pause-tactics');
    expect(menu.page).toBe('tactics');
    expect(action(MenuAction.BACK)).toBe(true);
    expect(menu.page).toBe('main');
    expect(action(MenuAction.BACK)).toBe(false);
    click('pause-sound');
    expect(menu.page).toBe('sound');
    const esc = new FakeEvent('keydown', { key: 'Escape' });
    win.dispatchEvent(esc);
    expect(menu.page).toBe('main');
    expect(esc.immediateStopped).toBe(true);
    // On the main page Escape reaches the router untouched.
    const esc2 = new FakeEvent('keydown', { key: 'Escape' });
    win.dispatchEvent(esc2);
    expect(esc2.immediateStopped).toBe(false);
    expect(menu.onBack()).toBe(false);
  });

  it('tactics changes are orders, not commands, while paused; a hidden menu ignores menu actions', () => {
    session.pause(0);
    menu.show();
    click('pause-tactics');
    click('pause-tactic-1');
    expect(teamOrders(s, 0).tactics[1]).toBe(1);
    expect(session.queueCommand).not.toHaveBeenCalled();
    menu.hide();
    expect(action(MenuAction.BACK)).toBe(false);
  });

  it('leaving the match screen while play runs flushes every remaining order; while paused they wait', () => {
    const field = benchField(0);
    const o = teamOrders(s, 0);
    o.subs.push({ out: 9, inRoster: field[0]!, sentTick: -1 }, { out: 8, inRoster: field[1]!, sentTick: -1 });
    o.formation = 2;
    session.pause(0);
    menu.dispose();
    expect(session.queueCommand).not.toHaveBeenCalled();
    menu = createPauseMenu();
    menu.mount(screen as unknown as HTMLElement, makeCtx());
    expect(teamOrders(s, 0).subs.length).toBe(2);
    session.paused = false;
    menu.dispose();
    expect(session.queueCommand).toHaveBeenCalledTimes(3);
    menu = createPauseMenu();
    menu.mount(screen as unknown as HTMLElement, makeCtx());
  });

  it('a controls link leaves for the settings screen and the menu reopens on the Controls page', () => {
    session.pause(0);
    menu.show();
    click('pause-controls');
    click('pause-open-settings');
    menu.dispose();
    menu = createPauseMenu();
    menu.mount(screen as unknown as HTMLElement, makeCtx());
    menu.show();
    expect(menu.page).toBe('controls');
  });
});
