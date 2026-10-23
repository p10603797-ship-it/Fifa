/**
 * SGN-02 controls audit, section 9 touch quality bar: "Show direction hints on a 250 ms hold during the first few
 * matches". Two halves, both real code:
 *  - the gate: the real touch source shows a held button's direction hints only while
 *    settings.controls.touch.hintMatchesLeft > 0 (src/input/touch/index.ts hints());
 *  - the count: the real HUD hints part (src/ui/hud/hints.ts) takes one match off hintMatchesLeft when a match played
 *    on touch reaches full time, once per match, never for practice or a match played without touch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, MatchSetup } from '../../src/contracts/app';
import { MatchPhase, ModeId, PracticeKind } from '../../src/contracts/enums';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import { ClusterSlot } from '../../src/contracts/touch';
import { createHints } from '../../src/ui/hud/hints';
import { makeScenario } from '../harness/scenario';
import { createTouchRig } from '../unit/qf-3-touch-rig';
import { FakeElement, makeAppDom } from '../unit/uix-01-fakedom';

describe('SGN-02 direction hints on a 250 ms hold: shown only while hint matches are left', () => {
  it('a held PASS shows its hints after 250 ms with matches left; none when the count is 0', () => {
    for (const left of [2, 0]) {
      const s = makeScenario({
        phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }],
        players: [{ slot: 9, x: 10, z: 0, fx: 1, fz: 0 }],
        ball: { owner: 9, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0, lastTouch: 9 },
      });
      for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
      const r = createTouchRig(s, { settings: { hintMatchesLeft: left } });
      r.tick(2);
      const p = r.slot(ClusterSlot.LOW);
      r.down(2, p.x, p.y);
      r.wait(150);
      expect(r.src.cluster.hintMask, `${left}: not before 250 ms`).toBe(0);
      r.wait(170);
      if (left > 0) expect(r.src.cluster.hintMask).not.toBe(0);
      else expect(r.src.cluster.hintMask).toBe(0);
      r.up(2, p.x, p.y);
      r.tick(1);
      expect(r.src.cluster.hintMask).toBe(0);
    }
  });
});

describe('SGN-02 "during the first few matches": one hint match is used up per match played on touch', () => {
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
  afterEach(() => { vi.unstubAllGlobals(); });

  function ctxFor(setup: MatchSetup, settings: Settings, touchConnected = true): AppContext {
    return {
      session: { getSetup: () => setup, getState: () => null, runtime: () => null, active: true, paused: false },
      settings: { get: () => settings, update: (mut: (x: Settings) => void) => mut(settings), subscribe: () => () => undefined },
      devices: { lastActive: () => 'touch', list: () => (touchConnected ? [{ id: 'touch', kind: 'touch', connected: true }] : []) },
      platform: { isTouch: true },
      audio: { playUi: () => undefined },
    } as unknown as AppContext;
  }

  /** Mount the hints part for `s`, play to full time, update a few frames; the hint matches left afterwards. */
  function playToFullTime(s: SimState, deviceIds: string[], left: number): number {
    const settings = createDefaultSettings();
    settings.controls.touch.hintMatchesLeft = left;
    const setup: MatchSetup = { config: s.config as MatchSetup['config'], bindings: [{ human: 0, deviceIds }] };
    const hints = createHints();
    while (screen.children.length > 0) screen.removeChild(screen.children[0]!);
    hints.mount(screen as unknown as HTMLElement, ctxFor(setup, settings));
    hints.setMatch(s, []);
    const frame = { dtMs: 16, alpha: 1, ticks: 1, paused: false } as never;
    hints.update(s, frame, null);
    expect(settings.controls.touch.hintMatchesLeft, 'nothing used up during the match').toBe(left);
    s.match.phase = MatchPhase.POST_MATCH;
    s.match.finished = 1;
    for (let i = 0; i < 5; i++) hints.update(s, frame, null);
    hints.dispose();
    return settings.controls.touch.hintMatchesLeft;
  }

  it('a Kick-Off played on touch uses one match (once, however many frames follow full time); 0 stays 0', () => {
    expect(playToFullTime(makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY }), ['touch'], 3)).toBe(2);
    expect(playToFullTime(makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY }), ['touch'], 1)).toBe(0);
    expect(playToFullTime(makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY }), ['touch'], 0)).toBe(0);
  });

  it('practice and a match played on a controller only do not use a hint match', () => {
    const practice = makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY, config: { mode: ModeId.PRACTICE, practice: PracticeKind.FREE_PLAY } });
    expect(playToFullTime(practice, ['touch'], 3)).toBe(3);
    expect(playToFullTime(makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY }), ['pad:1'], 3)).toBe(3);
  });
});
