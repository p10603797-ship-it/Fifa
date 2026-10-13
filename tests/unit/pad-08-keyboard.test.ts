/**
 * PAD-08: keyboard InputSource (src/input/keyboard.ts): every Btn, movement, D-pad tactics keys (1-4, Ctrl / Alt +
 * arrows), right stick on the numpad and Alt + I J K L through the PAD-05 recogniser, skill keys, the press latch,
 * releaseAll, stuck-key guards. Node EventTarget, fake clock, real SimState (tests/harness/scenario.ts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { AXIS_SCALE, Btn, createInputFrame, type InputFrame, type InputSampleContext } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_PAD } from '../../src/contracts/tuning';
import {
  createKeyboardSource, isEditableTarget, KEY_BUTTONS, KEY_DPAD, KEY_RSTICK, KEY_RSTICK_ALT, KEY_SKILLS, skillKeyDirection,
} from '../../src/input/keyboard';
import { clearPadSequenceHud, getPadSequencePending } from '../../src/input/pad/sequences';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

interface KeyExtra { repeat?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; target?: unknown }

function kev(type: string, code: string, extra: KeyExtra = {}): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, 'code', { value: code });
  Object.defineProperty(e, 'repeat', { value: extra.repeat === true });
  Object.defineProperty(e, 'ctrlKey', { value: extra.ctrlKey === true });
  Object.defineProperty(e, 'altKey', { value: extra.altKey === true });
  Object.defineProperty(e, 'metaKey', { value: extra.metaKey === true });
  if (extra.target) Object.defineProperty(e, 'target', { value: extra.target });
  return e;
}

class FakeDoc extends EventTarget {
  visibilityState = 'visible';
}

/** Controlled player 9 (home, facing +x) owns the ball in play. */
function inPlayState(over: Parameters<typeof makeScenario>[0] = {}): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: 9 }],
    players: [{ slot: 9, x: 0, z: 0, fx: 1, fz: 0 }],
    ball: { x: 0.5, y: 0.11, z: 0, owner: 9 },
    ...over,
  });
}

const live: { dispose(): void }[] = [];
afterEach(() => {
  for (const k of live.splice(0)) k.dispose();
  clearPadSequenceHud();
});

function rig(state: SimState = inPlayState()) {
  const target = new EventTarget();
  const doc = new FakeDoc();
  let t = 1000;
  const onPause = vi.fn();
  const kb = createKeyboardSource({ onPause, target, doc, now: () => t });
  live.push(kb);
  const ctx: InputSampleContext = { tick: 1, human: 0, side: 0, state, projector: null };
  const out = createInputFrame();
  const down = (code: string, extra: KeyExtra = {}): Event => {
    const e = kev('keydown', code, extra);
    target.dispatchEvent(e);
    return e;
  };
  const up = (code: string, extra: KeyExtra = {}): Event => {
    const e = kev('keyup', code, extra);
    target.dispatchEvent(e);
    return e;
  };
  /** One animation frame: the app's pump calls pollFrame. */
  const frame = (ms = 16): void => { t += ms; kb.pollFrame(t); };
  /** Sample a copy of the frame for the coming tick. */
  const sample = (): InputFrame => { kb.sample(out, ctx); return { ...out }; };
  /** Frame + sample (one tick at 60 Hz). */
  const tick = (ms = 16): InputFrame => { frame(ms); return sample(); };
  return { target, doc, kb, ctx, down, up, frame, sample, tick, onPause, advance: (ms: number) => { t += ms; } };
}

const ALL_BTN = Object.values(Btn).reduce((a, b) => a | b, 0);

describe('PAD-08 keyboard: every InputFrame button has a key', () => {
  it('face, shoulder, trigger and skip keys map to their Btn bit (positional, like the pad)', () => {
    const r = rig();
    for (const [code, bit] of Object.entries(KEY_BUTTONS)) {
      r.down(code);
      expect(r.tick().buttons, code).toBe(bit);
      expect(r.tick().buttons, `${code} held`).toBe(bit);
      r.up(code);
      expect(r.tick().buttons, `${code} released`).toBe(0);
    }
  });

  it('the union over all keys (buttons, a right-stick flick and hold) covers every Btn bit', () => {
    const r = rig();
    let seen = 0;
    for (const code of Object.keys(KEY_BUTTONS)) {
      r.down(code);
      seen |= r.tick().buttons;
      r.up(code);
      r.tick();
    }
    r.down('Numpad6');
    for (let ms = 0; ms <= T_PAD.rsHoldMs + 48; ms += 16) seen |= r.tick().buttons;
    r.up('Numpad6');
    r.tick();
    expect(seen).toBe(ALL_BTN);
  });

  it('pause on Esc / P press edges only (auto-repeat never toggles)', () => {
    const r = rig();
    r.down('Escape');
    r.down('Escape', { repeat: true });
    r.down('KeyP');
    r.down('KeyP', { repeat: true });
    expect(r.onPause).toHaveBeenCalledTimes(2);
  });
});

describe('PAD-08 keyboard: movement', () => {
  it('WASD and arrows move in pitch space; Alt + WASD still moves; Ctrl + W (browser shortcut) does not', () => {
    const r = rig();
    r.down('KeyD');
    expect(r.tick().mx).toBe(AXIS_SCALE);
    r.up('KeyD');
    r.down('KeyW', { altKey: true });
    expect(r.tick().mz).toBe(-AXIS_SCALE);
    r.up('KeyW');
    r.down('KeyW', { ctrlKey: true });
    const f = r.tick();
    expect([f.mx, f.mz]).toEqual([0, 0]);
  });
});

describe('PAD-08 keyboard: D-pad tactics keys', () => {
  it('1-4 are D-pad up / down / left / right: 1,1 offside trap; 4,2 defending focus... ; 2,2 quick sub', () => {
    expect(KEY_DPAD).toEqual({ Digit1: 1, Digit2: 2, Digit3: 4, Digit4: 8 });
    const cases: [string, string, Command][] = [
      ['Digit1', 'Digit1', Command.TACTIC_OFFSIDE_TRAP],
      ['Digit1', 'Digit3', Command.TACTIC_TEAM_PRESS],
      ['Digit1', 'Digit4', Command.TACTIC_EXTRA_STRIKER],
      ['Digit1', 'Digit2', Command.TACTIC_GET_IN_BOX],
      ['Digit4', 'Digit1', Command.FOCUS_DEFAULT],
      ['Digit4', 'Digit3', Command.FOCUS_DEFENDING],
      ['Digit4', 'Digit4', Command.FOCUS_ATTACKING],
      ['Digit2', 'Digit2', Command.QUICK_SUB],
    ];
    for (const [a, b, cmd] of cases) {
      const r = rig();
      r.down(a); r.up(a);
      expect(r.tick().cmd).toBe(Command.NONE);
      expect(getPadSequencePending(0)).not.toBeNull(); // the HUD prompt shows the keyboard's pending sequence
      r.down(b); r.up(b);
      const f = r.tick();
      expect(f.cmd, `${a} ${b}`).toBe(cmd);
      expect(f.cmdArg).toBe(0);
      expect(f.mx).toBe(0); // D-pad keys never move
      expect(r.tick().cmd).toBe(Command.NONE); // one command per sequence
      r.kb.dispose();
    }
  });

  it('Ctrl or Alt + arrow is the D-pad and never moves; the layer stays with the key until it is released', () => {
    const r = rig();
    r.down('ArrowRight', { ctrlKey: true });
    let f = r.tick();
    expect(f.mx).toBe(0);
    expect(r.kb.dpad).toBe(8);
    // Ctrl let go while the arrow is still down: its auto-repeat (no modifier now) must not start moving.
    r.down('ArrowRight', { repeat: true });
    f = r.tick();
    expect(f.mx).toBe(0);
    r.up('ArrowRight');
    expect(r.kb.dpad).toBe(0);
    r.down('ArrowLeft', { altKey: true });
    r.up('ArrowLeft');
    f = r.tick();
    expect(f.cmd).toBe(Command.FOCUS_DEFENDING); // right, then left
    r.down('ArrowRight');
    expect(r.tick().mx).toBe(AXIS_SCALE); // no modifier: movement as before
  });

  it('Ctrl + digit (browser tab switch) is never a D-pad press', () => {
    const r = rig();
    r.down('Digit1', { ctrlKey: true }); r.up('Digit1');
    r.tick();
    r.down('Digit1', { ctrlKey: true }); r.up('Digit1');
    expect(r.tick().cmd).toBe(Command.NONE);
    expect(getPadSequencePending(0)).toBeNull();
  });

  it('two D-pad taps inside one frame are a sequence in press order (up then down), not a diagonal', () => {
    const r = rig();
    r.down('Digit1'); r.up('Digit1');
    r.down('Digit2'); r.up('Digit2');
    expect(r.tick(200).cmd).toBe(Command.TACTIC_GET_IN_BOX);
    const q = rig();
    q.down('Digit2'); q.up('Digit2');
    q.down('Digit1'); q.up('Digit1');
    expect(q.tick(200).cmd).toBe(Command.NONE); // down then up is not a sequence outside a corner
  });

  it('holding a D-pad key never repeats a press (auto-repeat ignored)', () => {
    const r = rig();
    r.down('Digit2');
    r.tick();
    for (let i = 0; i < 5; i++) { r.down('Digit2', { repeat: true }); expect(r.tick().cmd).toBe(Command.NONE); }
  });
});

describe('PAD-08 keyboard: right stick on the numpad and Alt + I J K L', () => {
  it('numpad directions and diagonals write the aim axes; a fresh stroke is one RS_FLICK, a long one RS_HOLD', () => {
    const r = rig();
    r.down('Numpad6');
    let f = r.tick();
    expect([f.ax, f.az]).toEqual([AXIS_SCALE, 0]);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    f = r.tick();
    expect(f.buttons & Btn.RS_FLICK).toBe(0);
    let hold = false;
    for (let ms = 0; ms <= T_PAD.rsHoldMs + 32; ms += 16) hold = hold || (r.tick().buttons & Btn.RS_HOLD) !== 0;
    expect(hold).toBe(true);
    r.up('Numpad6');
    f = r.tick();
    expect(f.buttons & (Btn.RS_HOLD | Btn.RS_FLICK)).toBe(0);
    expect([f.ax, f.az]).toEqual([0, 0]);
    r.down('Numpad7');
    f = r.tick();
    expect(f.ax).toBeLessThan(-80);
    expect(f.az).toBeLessThan(-80);
    expect(f.ax * f.ax + f.az * f.az).toBeLessThanOrEqual(AXIS_SCALE * AXIS_SCALE);
    r.up('Numpad7');
    r.down('Numpad5'); // 5 is down too (8 / 5 / 4 / 6 layout)
    expect(r.tick().az).toBe(AXIS_SCALE);
    expect(Object.keys(KEY_RSTICK)).toHaveLength(9);
  });

  it('Alt + I J K L is the right stick (no face button); without Alt, I J K are THROUGH / PASS / SHOOT and L is unbound', () => {
    expect(KEY_RSTICK_ALT).toEqual({ KeyI: 1, KeyK: 2, KeyJ: 4, KeyL: 8 });
    const r = rig();
    r.down('KeyJ', { altKey: true });
    let f = r.tick();
    expect(f.ax).toBe(-AXIS_SCALE);
    expect(f.buttons & Btn.PASS).toBe(0);
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    r.up('KeyJ'); // Alt may already be up: the key stays in its layer until released
    r.tick();
    r.down('KeyL');
    f = r.tick();
    expect([f.ax, f.buttons]).toEqual([0, 0]);
    r.up('KeyL');
    r.down('KeyJ');
    expect(r.tick().buttons).toBe(Btn.PASS);
  });

  it('a numpad tap to the side is a body feint from the PAD-05 recogniser (facing +x: right = +z = Numpad2)', () => {
    const r = rig();
    r.down('Numpad2');
    let f = r.tick();
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    r.up('Numpad2');
    f = r.tick();
    expect(f.skill).toBe(SkillMove.BODY_FEINT);
    expect([f.ax, f.az]).toEqual([0, AXIS_SCALE]);
  });

  it('two quick taps of one right-stick direction at a low frame rate are two flicks (the stick passed the centre)', () => {
    const r = rig();
    let flicks = 0;
    r.down('Numpad6'); r.up('Numpad6');
    flicks += r.tick(200).buttons & Btn.RS_FLICK ? 1 : 0;
    r.down('Numpad6'); r.up('Numpad6');
    for (let i = 0; i < 3; i++) flicks += r.tick(200).buttons & Btn.RS_FLICK ? 1 : 0;
    expect(flicks).toBe(2);
  });

  it('a right-stick tap shorter than a frame still flicks (latched for the next poll)', () => {
    const r = rig();
    r.down('Numpad8');
    r.up('Numpad8');
    const f = r.tick();
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect(f.az).toBe(-AXIS_SCALE);
  });

  it('Q + E held and a back tap on the movement keys is a drag-back (left stick, PAD-05)', () => {
    const r = rig();
    r.down('KeyQ');
    r.down('KeyE');
    r.tick();
    r.down('KeyA'); // back for a player facing +x
    let skill = SkillMove.NONE;
    for (let i = 0; i < 3 && skill === SkillMove.NONE; i++) skill = r.tick().skill;
    expect(skill).toBe(SkillMove.DRAG_BACK);
  });
});

describe('PAD-08 keyboard: skill keys', () => {
  it('R F T G H B -> ball roll, body feint, step-over, roulette, heel flick, drag-back with the pad directions', () => {
    expect(KEY_SKILLS).toEqual({
      KeyR: SkillMove.BALL_ROLL, KeyF: SkillMove.BODY_FEINT, KeyT: SkillMove.STEP_OVER, KeyG: SkillMove.ROULETTE,
      KeyH: SkillMove.HEEL_FLICK, KeyB: SkillMove.DRAG_BACK,
    });
    const expected: [string, SkillMove, number, number][] = [
      ['KeyR', SkillMove.BALL_ROLL, 0, AXIS_SCALE], // no steer: right of facing (+z)
      ['KeyF', SkillMove.BODY_FEINT, 0, AXIS_SCALE],
      ['KeyT', SkillMove.STEP_OVER, 0, AXIS_SCALE],
      ['KeyG', SkillMove.ROULETTE, 0, AXIS_SCALE],
      ['KeyH', SkillMove.HEEL_FLICK, AXIS_SCALE, 0], // forward
      ['KeyB', SkillMove.DRAG_BACK, -AXIS_SCALE, 0], // back
    ];
    const r = rig();
    for (const [code, skill, ax, az] of expected) {
      r.down(code);
      const f = r.tick();
      expect(f.skill, code).toBe(skill);
      expect([f.ax, f.az], code).toEqual([ax, az]);
      r.down(code, { repeat: true });
      r.up(code);
      expect(r.tick().skill, `${code} once`).toBe(SkillMove.NONE);
    }
  });

  it('side moves go to the side steered toward (W = up = left of a player facing +x)', () => {
    const r = rig();
    r.down('KeyW');
    r.down('KeyR');
    const f = r.tick();
    expect(f.skill).toBe(SkillMove.BALL_ROLL);
    expect([f.ax, f.az]).toEqual([0, -AXIS_SCALE]);
  });

  it('never on the sample of a right-stick flick (ax/az has one meaning): the skill follows one sample later', () => {
    const r = rig();
    r.down('Numpad6');
    r.down('KeyH');
    let f = r.tick();
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect(f.skill).toBe(SkillMove.NONE);
    f = r.tick();
    expect(f.skill).toBe(SkillMove.HEEL_FLICK);
  });

  it('gated like the pad: nothing while the opponents own the ball, the keeper holds it, or outside IN_PLAY', () => {
    const gated: SimState[] = [
      inPlayState({ ball: { x: 0.5, y: 0.11, z: 0, owner: 14 } }),
      inPlayState({ phase: MatchPhase.THROW_IN }),
      inPlayState({ humans: [{ side: 0, slot: 0 }], players: [{ slot: 0, fx: 1, fz: 0 }], ball: { owner: 0, heldBy: 0 } }),
    ];
    for (const s of gated) {
      const r = rig(s);
      r.down('KeyF');
      expect(r.tick().skill).toBe(SkillMove.NONE);
      expect(r.tick().skill).toBe(SkillMove.NONE); // dropped, not delivered later
    }
    // Loose ball or a teammate's: allowed (the sim buffers it until the controlled player can act).
    const loose = rig(inPlayState({ ball: { x: 5, y: 0.11, z: 0, owner: -1 } }));
    loose.down('KeyF');
    expect(loose.tick().skill).toBe(SkillMove.BODY_FEINT);
  });

  it('skillKeyDirection: facing fallback to the team direction when the facing is zero', () => {
    const s = inPlayState({ players: [{ slot: 9, fx: 0, fz: 0 }] });
    s.teams[0]!.dir = -1;
    const d = { x: 0, z: 0 };
    expect(skillKeyDirection({ state: s, human: 0, side: 0 }, SkillMove.HEEL_FLICK, 0, 0, d)).toBe(true);
    expect([d.x, d.z]).toEqual([-1, 0]);
  });
});

describe('PAD-08 keyboard: press latch, releaseAll and stuck-key guards', () => {
  it('a release + re-press between two samples is reported as two presses (a double tap is never merged)', () => {
    const r = rig();
    r.down('KeyJ');
    expect(r.sample().buttons).toBe(Btn.PASS);
    r.up('KeyJ');
    r.down('KeyJ');
    expect(r.sample().buttons).toBe(0);
    expect(r.sample().buttons).toBe(Btn.PASS);
    r.up('KeyJ');
    expect(r.sample().buttons).toBe(0);
  });

  it('releaseAll (pause / resume): movement, right stick and D-pad cleared; held buttons suppressed until released', () => {
    const r = rig();
    r.down('KeyD'); r.down('ShiftLeft'); r.down('Numpad6'); r.down('Digit1');
    r.tick();
    r.kb.releaseAll();
    let f = r.tick();
    expect([f.mx, f.ax, f.buttons, f.cmd]).toEqual([0, 0, 0, Command.NONE]);
    expect(r.kb.held).toBe(0);
    f = r.tick(); // Shift still physically down: suppressed
    expect(f.buttons).toBe(0);
    r.down('Digit1'); r.up('Digit1'); // a fresh first press, not the end of the earlier sequence
    expect(r.tick().cmd).toBe(Command.NONE);
    r.up('ShiftLeft');
    r.down('ShiftLeft');
    expect(r.tick().buttons).toBe(Btn.SPRINT);
  });

  it('Glitch "stuck key after a Cmd shortcut": the release of Cmd releases every key (macOS drops those keyups)', () => {
    const r = rig();
    r.down('KeyJ');
    r.down('KeyD');
    r.down('MetaLeft', { metaKey: true });
    const e = r.down('KeyR', { metaKey: true }); // Cmd + R: the browser's, not a skill
    expect(e.defaultPrevented).toBe(false);
    r.up('MetaLeft'); // J and D keyups never arrive
    r.sample();
    const f = r.tick();
    expect([f.buttons, f.mx, f.skill]).toEqual([0, 0, SkillMove.NONE]);
  });

  it('Glitch "stuck stick / D-pad after blur or a hidden page": both release the right stick and the D-pad too', () => {
    const r = rig();
    r.down('Numpad6'); r.down('Digit1');
    r.tick();
    r.target.dispatchEvent(new Event('blur'));
    let f = r.tick();
    expect([f.ax, f.buttons]).toEqual([0, 0]);
    r.down('Numpad4');
    r.tick();
    r.doc.visibilityState = 'hidden';
    r.doc.dispatchEvent(new Event('visibilitychange'));
    f = r.tick();
    expect([f.ax, f.buttons]).toEqual([0, 0]);
    expect(r.kb.rsDirs).toBe(0);
  });

  it('isEditableTarget: text-like inputs, textarea, select, contenteditable; never sliders, toggles or buttons', () => {
    const yes = [{ tagName: 'input' }, { tagName: 'INPUT', type: 'text' }, { tagName: 'input', type: 'Number' }, { tagName: 'textarea' },
      { tagName: 'select' }, { tagName: 'div', isContentEditable: true }];
    const no = [{ tagName: 'input', type: 'range' }, { tagName: 'input', type: 'checkbox' }, { tagName: 'button' }, { tagName: 'div' }, null, {}];
    for (const t of yes) expect(isEditableTarget(t as unknown as EventTarget), JSON.stringify(t)).toBe(true);
    for (const t of no) expect(isEditableTarget(t as unknown as EventTarget), JSON.stringify(t)).toBe(false);
  });

  it('typing in a text field drives nothing; Ctrl + letter shortcuts are ignored', () => {
    const r = rig();
    r.down('KeyJ', { target: { tagName: 'INPUT' } });
    r.down('Numpad6', { target: { tagName: 'textarea' } });
    r.down('Digit1', { target: { tagName: 'input' } });
    r.down('KeyK', { ctrlKey: true });
    const f = r.tick();
    expect([f.buttons, f.ax, f.cmd]).toEqual([0, 0, Command.NONE]);
  });

  it('preventDefault on game keys (no page scroll / menu bar); not on Esc, Cmd combos or unmapped keys', () => {
    const r = rig();
    for (const code of ['ArrowDown', 'Space', 'KeyJ', 'Numpad8', 'Digit3', 'AltLeft', 'KeyR']) {
      expect(r.down(code).defaultPrevented, code).toBe(true);
      r.up(code);
    }
    expect(r.down('ArrowUp', { ctrlKey: true }).defaultPrevented).toBe(true);
    for (const code of ['Escape', 'KeyZ', 'F5']) expect(r.down(code).defaultPrevented, code).toBe(false);
  });

  it('sample() polls the recognisers itself when pollFrame is not called (headless / no pump)', () => {
    const r = rig();
    r.down('Numpad8');
    r.advance(20);
    const f = r.sample();
    expect(f.buttons & Btn.RS_FLICK).toBe(Btn.RS_FLICK);
    expect(f.az).toBe(-AXIS_SCALE);
  });

  it('dispose: keys do nothing afterwards and the D-pad HUD prompt is withdrawn', () => {
    const r = rig();
    r.down('Digit1'); r.up('Digit1');
    r.tick();
    expect(getPadSequencePending(0)).toBe('tactics');
    r.kb.dispose();
    expect(getPadSequencePending(0)).toBeNull();
    r.down('KeyD'); r.down('KeyP');
    const f = r.tick();
    expect([f.mx, f.buttons]).toEqual([0, 0]);
    expect(r.onPause).not.toHaveBeenCalled();
  });
});

describe('PAD-08 keyboard: scenario through the real sim pipeline', () => {
  it('D held moves the controlled player toward +x; J tapped kicks the ball (same frames as a pad)', () => {
    const s = inPlayState({ ball: { x: 0.4, y: 0.11, z: 0, owner: 9 } });
    const r = rig(s);
    const x0 = s.players[9]!.x;
    r.down('KeyD');
    runTicks(s, 45, (_tick, st, out) => {
      r.frame(16);
      r.kb.sample(out[0]!, { tick: st.tick + 1, human: 0, side: 0, state: st, projector: null });
    });
    expect(s.players[9]!.x).toBeGreaterThan(x0 + 1);
    r.up('KeyD');
    r.down('KeyJ');
    r.up('KeyJ');
    const ev = runTicks(s, 90, (_tick, st, out) => {
      r.frame(16);
      r.kb.sample(out[0]!, { tick: st.tick + 1, human: 0, side: 0, state: st, projector: null });
    });
    expect(findEvents(ev, EventType.KICK).length).toBeGreaterThan(0);
  });
});
