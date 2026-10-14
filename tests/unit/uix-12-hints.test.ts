/**
 * UIX-12: set-piece hint rules (who gets a card, three uses per restart kind), hint content for every restart and
 * device, device glyph chips, device choice, tutorial progress in settings and the TutorialTracker observing a
 * practice match — with the real sim pipeline (move, sprint, pass) and with scripted events (the other steps).
 */
import { describe, expect, it } from 'vitest';
import type { DeviceInfo, SettingsStore } from '../../src/contracts/app';
import { ControllerKind, KickKind, MatchPhase, PadFamily, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { createDefaultSettings, type Settings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { takePossession } from '../../src/sim/core/kick';
import { keyChip, keyboardKeyLabel, lineText, linesFor } from '../../src/ui/hud/controlGlyphs';
import {
  HINT_TUNING, PENALTY_SAVE_HINT, SET_PIECE_HINTS, hintTarget, hintUses, restartKindOfPhase, shouldShowHint, type HintTarget,
} from '../../src/ui/hud/hints';
import { pickDevice, type DeviceSpec } from '../../src/ui/hud/hudShared';
import {
  TUTORIAL_STEPS, TUTORIAL_TUNING, TutorialTracker, markStepDone, markTutorialDone, nextOpenStep, resetTutorial, stepKey,
  tutorialComplete, tutorialProgress,
} from '../../src/ui/screens/tutorialSteps';
import { makeScenario, runTicks } from '../harness/scenario';

function fakeSettings(): SettingsStore & { value: Settings } {
  const store = {
    value: createDefaultSettings(),
    persistent: false,
    get() {
      return store.value;
    },
    update(mut: (s: Settings) => void) {
      const next = structuredClone(store.value);
      mut(next);
      store.value = next;
    },
    subscribe() {
      return () => undefined;
    },
    reset() {
      store.value = createDefaultSettings();
    },
    loadProgress<T>(): T | null {
      return null;
    },
    saveProgress() {},
    clearProgress() {},
  };
  return store;
}

/** An EventBuffer over a fixed list (one tick). */
function buf(list: Partial<SimEvent>[]): EventBuffer {
  const evs: SimEvent[] = list.map((e) => ({ type: EventType.KICK, tick: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0, ...e }));
  return { get count() { return evs.length; }, get: (i: number) => evs[i]!, begin: () => undefined, emit: () => undefined };
}

const TOUCH: DeviceSpec = { kind: 'touch', family: PadFamily.GENERIC };
const XBOX: DeviceSpec = { kind: 'pad', family: PadFamily.XBOX };
const PS: DeviceSpec = { kind: 'pad', family: PadFamily.PLAYSTATION };
const KEYS: DeviceSpec = { kind: 'keyboard', family: PadFamily.GENERIC };

describe('UIX-12 set-piece hint rules', () => {
  it('maps each restart phase to its restart kind (shoot-out kicks count as penalties)', () => {
    expect(restartKindOfPhase(MatchPhase.KICK_OFF)).toBe(RestartKind.KICK_OFF);
    expect(restartKindOfPhase(MatchPhase.THROW_IN)).toBe(RestartKind.THROW_IN);
    expect(restartKindOfPhase(MatchPhase.GOAL_KICK)).toBe(RestartKind.GOAL_KICK);
    expect(restartKindOfPhase(MatchPhase.CORNER)).toBe(RestartKind.CORNER);
    expect(restartKindOfPhase(MatchPhase.FREE_KICK)).toBe(RestartKind.FREE_KICK);
    expect(restartKindOfPhase(MatchPhase.PENALTY)).toBe(RestartKind.PENALTY);
    expect(restartKindOfPhase(MatchPhase.SHOOT_OUT)).toBe(RestartKind.PENALTY);
    expect(restartKindOfPhase(MatchPhase.IN_PLAY)).toBe(RestartKind.NONE);
  });

  it('hints show for the first three uses of each restart kind, then stop', () => {
    expect(HINT_TUNING.uses).toBe(3);
    const seen: Record<string, number> = {};
    let shown = 0;
    for (let i = 0; i < 6; i++) {
      if (shouldShowHint(seen, RestartKind.CORNER)) {
        shown++;
        seen[String(RestartKind.CORNER)] = hintUses(seen, RestartKind.CORNER) + 1;
      }
    }
    expect(shown).toBe(3);
    expect(seen[String(RestartKind.CORNER)]).toBe(3);
    // Each kind counts on its own.
    expect(shouldShowHint(seen, RestartKind.THROW_IN)).toBe(true);
    expect(shouldShowHint(seen, RestartKind.NONE)).toBe(false);
    // Damaged counters read as zero.
    expect(hintUses({ '4': Number.NaN }, RestartKind.CORNER)).toBe(0);
    expect(hintUses(undefined, RestartKind.CORNER)).toBe(0);
  });

  it('the human playing the awarded side takes the hint; a penalty also coaches the human saving it', () => {
    const out: HintTarget = { human: -1, taking: true };
    const one = makeScenario({ humans: 1 });
    expect(hintTarget(one, RestartKind.CORNER, 0, out)).toEqual({ human: 0, taking: true });
    expect(hintTarget(one, RestartKind.CORNER, 1, out)).toEqual({ human: -1, taking: true });
    expect(hintTarget(one, RestartKind.PENALTY, 1, out)).toEqual({ human: 0, taking: false });
    const two = makeScenario({ humans: 2 });
    expect(hintTarget(two, RestartKind.THROW_IN, 1, out)).toEqual({ human: 1, taking: true });
    expect(hintTarget(two, RestartKind.PENALTY, 0, out)).toEqual({ human: 0, taking: true });
    const bots = makeScenario({ humans: 0 });
    expect(hintTarget(bots, RestartKind.PENALTY, 0, out).human).toBe(-1);
  });

  it('every restart kind has hint lines for touch and pads (keyboard uses the pad lines)', () => {
    for (const kind of [RestartKind.KICK_OFF, RestartKind.THROW_IN, RestartKind.GOAL_KICK, RestartKind.CORNER, RestartKind.FREE_KICK, RestartKind.PENALTY]) {
      const h = SET_PIECE_HINTS[kind]!;
      expect(h.title.length).toBeGreaterThan(0);
      expect(linesFor(h.lines, TOUCH).length).toBeGreaterThan(0);
      expect(linesFor(h.lines, XBOX).length).toBeGreaterThan(0);
      expect(linesFor(h.lines, KEYS)).toBe(h.lines.pad);
    }
    expect(linesFor(PENALTY_SAVE_HINT.lines, TOUCH).length).toBeGreaterThan(0);
  });

  it('the corner card reads "lob to cross, pass for short" with the device glyphs', () => {
    const corner = SET_PIECE_HINTS[RestartKind.CORNER]!;
    const xbox = linesFor(corner.lines, XBOX).map((l) => lineText(l, XBOX));
    expect(xbox).toContain('[X] Lob cross');
    expect(xbox).toContain('[A] Short pass');
    const ps = linesFor(corner.lines, PS).map((l) => lineText(l, PS));
    expect(ps.some((t) => t.includes('Square') && t.includes('Lob cross'))).toBe(true);
    const keys = linesFor(corner.lines, KEYS).map((l) => lineText(l, KEYS));
    expect(keys).toContain('[U] Lob cross');
    expect(keys).toContain('[J] Short pass');
    const touch = linesFor(corner.lines, TOUCH).map((l) => lineText(l, TOUCH));
    expect(touch).toContain('[PASS] Play it short');
  });
});

describe('UIX-12 glyph chips', () => {
  it('pads draw PAD-07 glyphs by family; the keyboard shows its key caps; touch names the buttons', () => {
    expect(keyChip(XBOX, Btn.PASS).label).toBe('A');
    expect(keyChip(XBOX, Btn.PASS).svg).toMatch(/^<svg/);
    expect(keyChip(PS, Btn.PASS).label).toBe('Cross');
    expect(keyChip(XBOX, 'LS').svg).toMatch(/^<svg/);
    expect(keyChip(KEYS, Btn.PASS).label).toBe('J');
    expect(keyChip(KEYS, Btn.SPRINT).label).toBe('Shift');
    expect(keyChip(KEYS, 'LS').label).toBe('WASD');
    expect(keyChip(TOUCH, Btn.THROUGH).label).toBe('THROUGH');
    expect(keyChip(TOUCH, 'SWIPE').label).toBe('SWIPE');
    expect(keyboardKeyLabel(Btn.SKIP)).toBe('Space');
    expect(keyboardKeyLabel(1 << 20)).toBe('');
  });

  it('chips are cached per device and key', () => {
    expect(keyChip(XBOX, Btn.SHOOT)).toBe(keyChip(XBOX, Btn.SHOOT));
  });
});

describe('UIX-12 device choice', () => {
  const touch: DeviceInfo = { id: 'touch', kind: 'touch', label: 'Touch', family: PadFamily.GENERIC, connected: true };
  const kb: DeviceInfo = { id: 'keyboard', kind: 'keyboard', label: 'Keyboard', family: PadFamily.GENERIC, connected: true };
  const pad: DeviceInfo = { id: 'pad:0', kind: 'pad', label: 'Controller 1', family: PadFamily.PLAYSTATION, connected: true };
  const list = [touch, kb, pad];

  it('prefers the last used device when it is bound to the human', () => {
    expect(pickDevice(list, ['touch', '*'], 'pad:0', true)).toEqual({ kind: 'pad', family: PadFamily.PLAYSTATION });
    expect(pickDevice(list, ['touch'], 'pad:0', true).kind).toBe('touch');
    expect(pickDevice(list, ['pad:0'], 'keyboard', true).kind).toBe('pad');
  });

  it('applies the pad family override from settings', () => {
    expect(pickDevice(list, ['pad:0'], null, false, PadFamily.XBOX)).toEqual({ kind: 'pad', family: PadFamily.XBOX });
  });

  it('falls back to touch on a touch platform, else the keyboard', () => {
    expect(pickDevice([], [], null, true).kind).toBe('touch');
    expect(pickDevice([], [], null, false).kind).toBe('keyboard');
  });
});

describe('UIX-12 tutorial progress in settings', () => {
  it('marks steps per device, completes the device when every step is done, and resets', () => {
    const st = fakeSettings();
    expect(tutorialProgress(st, 'pad').every((d) => !d)).toBe(true);
    markStepDone(st, 'pad', 'pass');
    expect(st.value.tutorialDone[stepKey('pad', 'pass')]).toBe(true);
    expect(tutorialProgress(st, 'pad')[2]).toBe(true);
    expect(tutorialProgress(st, 'touch')[2]).toBe(false);
    for (const s of TUTORIAL_STEPS) markStepDone(st, 'pad', s.id);
    expect(tutorialComplete(st, 'pad')).toBe(true);
    resetTutorial(st, 'pad');
    expect(tutorialComplete(st, 'pad')).toBe(false);
    expect(tutorialProgress(st, 'pad').some(Boolean)).toBe(false);
    markTutorialDone(st, 'touch');
    expect(tutorialComplete(st, 'touch')).toBe(true);
    expect(tutorialProgress(st, 'touch').every(Boolean)).toBe(true);
  });

  it('nextOpenStep wraps and reports -1 when everything is done', () => {
    expect(nextOpenStep([true, false, true], 0)).toBe(1);
    expect(nextOpenStep([false, true, true], 1)).toBe(0);
    expect(nextOpenStep([true, true], 0)).toBe(-1);
    expect(nextOpenStep([], 0)).toBe(-1);
  });

  it('lists the nine steps in the brief order', () => {
    expect(TUTORIAL_STEPS.map((s) => s.id)).toEqual(['move', 'sprint', 'pass', 'through', 'shoot', 'tackle', 'switch', 'skill', 'setpiece']);
  });
});

/** Run ticks feeding the tracker exactly as the HUD does (state per frame, events per tick). */
function play(s: SimState, tr: TutorialTracker, n: number, input: (t: number, out: import('../../src/contracts/input').InputFrame[]) => void): number[] {
  const done: number[] = [];
  const events = createEventBuffer();
  runTicks(s, n, (t, _s, out) => input(t, out), {
    events,
    until: (st) => {
      const a = tr.observeEvents(events, st);
      if (a >= 0) done.push(a);
      const b = tr.observeState(st, 1);
      if (b >= 0) done.push(b);
      return false;
    },
  });
  return done;
}

describe('UIX-12 tutorial tracker on the real sim pipeline', () => {
  it('"move" completes after running under stick input, then "sprint" after sprinting', () => {
    const s = makeScenario({ humans: [{ side: 0, slot: 9 }], phase: MatchPhase.IN_PLAY, ball: { x: 30, y: 0.11, z: 25 } });
    const tr = new TutorialTracker('keyboard', 0);
    tr.start([]);
    expect(tr.current?.id).toBe('move');
    // Standing still does nothing.
    expect(play(s, tr, 40, () => undefined)).toEqual([]);
    expect(tr.progress).toBe(0);
    const doneMove = play(s, tr, TUTORIAL_TUNING.moveTicks + 30, (_t, out) => {
      out[0]!.mx = -127;
    });
    expect(doneMove).toEqual([0]);
    expect(tr.current?.id).toBe('sprint');
    const doneSprint = play(s, tr, TUTORIAL_TUNING.sprintTicks + 40, (_t, out) => {
      out[0]!.mz = 127;
      out[0]!.buttons = Btn.SPRINT;
    });
    expect(doneSprint).toEqual([1]);
    expect(tr.current?.id).toBe('pass');
  });

  it('"pass" completes on the human player\'s ground pass', () => {
    const s = makeScenario({ humans: [{ side: 0, slot: 9 }], phase: MatchPhase.IN_PLAY });
    const p = s.players[9]!;
    Object.assign(s.ball, { x: p.x + 0.5, y: 0.11, z: p.z, px: p.x + 0.5, py: 0.11, pz: p.z, vx: 0, vy: 0, vz: 0 });
    takePossession(s, 9, createEventBuffer());
    const tr = new TutorialTracker('pad', 0);
    tr.start([true, true]);
    expect(tr.current?.id).toBe('pass');
    const done = play(s, tr, 60, (t, out) => {
      if (t % 30 < 3) out[0]!.buttons = Btn.PASS;
    });
    expect(done).toEqual([2]);
    expect(tr.current?.id).toBe('through');
  });
});

describe('UIX-12 tutorial tracker on scripted events', () => {
  function at(step: number): { s: SimState; tr: TutorialTracker } {
    const s = makeScenario({ humans: [{ side: 0, slot: 9 }], phase: MatchPhase.IN_PLAY });
    const tr = new TutorialTracker('pad', 0);
    tr.start(TUTORIAL_STEPS.map((_, i) => i < step));
    return { s, tr };
  }

  it('ignores the right event from someone else and the wrong event from the human', () => {
    const { s, tr } = at(3); // through
    expect(tr.observeEvents(buf([{ type: EventType.KICK, a: 10, b: KickKind.THROUGH_GROUND }]), s)).toBe(-1);
    expect(tr.observeEvents(buf([{ type: EventType.KICK, a: 9, b: KickKind.GROUND_PASS }]), s)).toBe(-1);
    expect(tr.observeEvents(buf([{ type: EventType.KICK, a: 9, b: KickKind.THROUGH_LOBBED }]), s)).toBe(3);
  });

  it('shoot: a SHOT (or shot kick) by the human', () => {
    const { s, tr } = at(4);
    expect(tr.observeEvents(buf([{ type: EventType.SHOT, a: 9, b: 1 }]), s)).toBe(4);
    const b = at(4);
    expect(b.tr.observeEvents(buf([{ type: EventType.KICK, a: 9, b: KickKind.SHOT_FINESSE }]), b.s)).toBe(4);
  });

  it('tackle: TACKLE with the human\'s player as tackler, won or missed', () => {
    const { s, tr } = at(5);
    expect(tr.observeEvents(buf([{ type: EventType.TACKLE, a: 12, b: 9, c: 1 }]), s)).toBe(-1);
    expect(tr.observeEvents(buf([{ type: EventType.TACKLE, a: 9, b: 15, c: 0 }]), s)).toBe(5);
  });

  it('switch: needs the change-player press (an auto-switch does not count) on a pad', () => {
    const { s, tr } = at(6);
    s.tick = 500;
    expect(tr.observeEvents(buf([{ type: EventType.SWITCH, tick: 500, a: 9, b: 7, c: 0 }]), s)).toBe(-1);
    s.ctrl[0]!.pressTick[4] = 495;
    expect(tr.observeEvents(buf([{ type: EventType.SWITCH, tick: 500, a: 9, b: 7, c: 1 }]), s)).toBe(-1); // other controller
    expect(tr.observeEvents(buf([{ type: EventType.SWITCH, tick: 500, a: 9, b: 7, c: 0 }]), s)).toBe(6);
  });

  it('switch on touch: counts while the opponents carry the ball (SWITCH button or teammate tap)', () => {
    const s = makeScenario({ humans: [{ side: 0, slot: 9 }], phase: MatchPhase.IN_PLAY });
    const tr = new TutorialTracker('touch', 0);
    tr.start(TUTORIAL_STEPS.map((_, i) => i < 6));
    s.ball.owner = -1;
    expect(tr.observeEvents(buf([{ type: EventType.SWITCH, a: 9, b: 7, c: 0 }]), s)).toBe(-1);
    s.ball.owner = 15;
    expect(tr.observeEvents(buf([{ type: EventType.SWITCH, a: 9, b: 7, c: 0 }]), s)).toBe(6);
  });

  it('skill: SKILL by the human', () => {
    const { s, tr } = at(7);
    expect(tr.observeEvents(buf([{ type: EventType.SKILL, a: 9, b: 2 }]), s)).toBe(7);
  });

  it('set pieces: a restart of the human\'s side that ends in play; the other side\'s restart does not count', () => {
    const { s, tr } = at(8);
    s.match.phase = MatchPhase.THROW_IN;
    s.match.restart.team = 1;
    expect(tr.observeState(s, 1)).toBe(-1);
    s.match.phase = MatchPhase.IN_PLAY;
    expect(tr.observeState(s, 1)).toBe(-1);
    s.match.phase = MatchPhase.CORNER;
    s.match.restart.team = 0;
    expect(tr.observeState(s, 1)).toBe(-1);
    s.match.phase = MatchPhase.IN_PLAY;
    expect(tr.observeState(s, 1)).toBe(8);
    expect(tr.complete).toBe(true);
    expect(tr.current).toBeNull();
  });

  it('skip completes the current step; start resumes at the first open step from a saved list', () => {
    const tr = new TutorialTracker('touch', 0);
    tr.start([true, false, true, false], 0);
    expect(tr.index).toBe(1);
    expect(tr.skip()).toBe(1);
    expect(tr.index).toBe(3);
    tr.start([true, false, true, false], 2);
    expect(tr.index).toBe(3);
  });

  it('does nothing without a human controller', () => {
    const s = makeScenario({ humans: 0, phase: MatchPhase.IN_PLAY });
    const tr = new TutorialTracker('pad', 0);
    tr.start([true, true]);
    expect(s.ctrl[0]!.kind).not.toBe(ControllerKind.HUMAN);
    expect(tr.observeEvents(buf([{ type: EventType.KICK, a: 9, b: KickKind.GROUND_PASS }]), s)).toBe(-1);
    expect(tr.observeState(s, 3)).toBe(-1);
  });
});
