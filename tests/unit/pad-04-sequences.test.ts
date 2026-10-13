/**
 * PAD-04: D-pad tactic sequences (BRIEF section 10 "Tactics, set pieces and menus") and the device-level double-press
 * latch. Pure recogniser fed with synthetic edge streams (every sequence -> command, timeouts, invalid continuations,
 * diagonals, corner context), then the device path with the real pad manager and mock Gamepad objects (own edge
 * detection, interleaved face buttons, disconnects, latched output, suspension), the HUD bridge and the latch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Command, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputSampleContext } from '../../src/contracts/input';
import type { ReadonlySimState } from '../../src/contracts/state';
import { T_PAD } from '../../src/contracts/tuning';
import { createPadManager, PadButton, type PadManager } from '../../src/input/pad/manager';
import { mapPadButtons } from '../../src/input/pad/mapper';
import {
  clearPadSequenceHud, createPadSequences, createPressLatch, DpadBit, DpadDir, getPadSequencePending, isTeamCornerContext,
  PAD_SEQUENCE_MENUS, PAD_SEQUENCE_TUNING, padDpadBits, padSequenceCommand, padSequenceKindFor, readPadSequenceHud,
  setPadSequencesSuspended, type PadSequenceContext, type PadSequenceHudState, type PadSequences,
} from '../../src/input/pad/sequences';

const W = T_PAD.dpadSequenceMs;
const { UP, DOWN, LEFT, RIGHT } = DpadBit;
const BIT_OF: number[] = [UP, DOWN, LEFT, RIGHT];

afterEach(() => {
  setPadSequencesSuspended(false);
  clearPadSequenceHud();
});

/** Feed a stream of [edges, ms] and return the non-NONE commands with their times. */
function run(seq: PadSequences, stream: [number, number][], corner = false): [Command, number][] {
  const out: [Command, number][] = [];
  for (const [e, t] of stream) {
    const c = seq.update(e, t, corner);
    if (c !== Command.NONE) out.push([c, t]);
  }
  return out;
}

// ------------------------------------------------------------------ every sequence

describe('PAD-04 every D-pad sequence maps to its Command (BRIEF section 10 table)', () => {
  const rows: [string, number, number, boolean, Command][] = [
    ['quick tactics: up, up -> offside trap', UP, UP, false, Command.TACTIC_OFFSIDE_TRAP],
    ['quick tactics: up, left -> team press', UP, LEFT, false, Command.TACTIC_TEAM_PRESS],
    ['quick tactics: up, right -> extra striker', UP, RIGHT, false, Command.TACTIC_EXTRA_STRIKER],
    ['quick tactics: up, down -> get in the box', UP, DOWN, false, Command.TACTIC_GET_IN_BOX],
    ['tactical focus: right, up -> default', RIGHT, UP, false, Command.FOCUS_DEFAULT],
    ['tactical focus: right, left -> defending', RIGHT, LEFT, false, Command.FOCUS_DEFENDING],
    ['tactical focus: right, right -> attacking', RIGHT, RIGHT, false, Command.FOCUS_ATTACKING],
    ['quick substitution: down, down -> quick sub', DOWN, DOWN, false, Command.QUICK_SUB],
    ['corner: down, up -> far post', DOWN, UP, true, Command.CORNER_FAR_POST],
    ['corner: down, left -> edge of box', DOWN, LEFT, true, Command.CORNER_EDGE_OF_BOX],
    ['corner: down, right -> crowd the keeper', DOWN, RIGHT, true, Command.CORNER_CROWD_KEEPER],
    ['corner: down, down -> near post', DOWN, DOWN, true, Command.CORNER_NEAR_POST],
    ['quick tactics still work during a corner: up, left', UP, LEFT, true, Command.TACTIC_TEAM_PRESS],
    ['tactical focus still works during a corner: right, right', RIGHT, RIGHT, true, Command.FOCUS_ATTACKING],
  ];
  it.each(rows)('%s', (_name, a, b, corner, cmd) => {
    const seq = createPadSequences();
    expect(seq.update(a, 1000, corner)).toBe(Command.NONE);
    expect(seq.pending).toBe(BIT_OF.indexOf(a));
    // Release frames in between do nothing.
    expect(seq.update(0, 1100, corner)).toBe(Command.NONE);
    expect(seq.update(b, 1300, corner)).toBe(cmd);
    expect(seq.pending).toBe(-1);
    expect(seq.getPending()).toBeNull();
  });

  it('the pure lookup agrees with the recogniser for all 16 pairs in and out of a corner', () => {
    for (const corner of [false, true]) {
      for (let a = 0; a < 4; a++) {
        for (let b = 0; b < 4; b++) {
          const seq = createPadSequences();
          seq.update(BIT_OF[a]!, 0, corner);
          const got = seq.update(BIT_OF[b]!, 100, corner);
          expect(got).toBe(padSequenceCommand(a, b, corner));
        }
      }
    }
    expect(padSequenceCommand(DpadDir.LEFT, DpadDir.UP, false)).toBe(Command.NONE);
    expect(padSequenceCommand(DpadDir.RIGHT, DpadDir.DOWN, false)).toBe(Command.NONE);
    expect(padSequenceCommand(DpadDir.DOWN, DpadDir.UP, false)).toBe(Command.NONE);
    expect(padSequenceCommand(7, 0, false)).toBe(Command.NONE);
  });

  it('pending kind per first press: up tactics, right focus, down sub (corner: corner), left none', () => {
    expect(padSequenceKindFor(DpadDir.UP, false)).toBe('tactics');
    expect(padSequenceKindFor(DpadDir.RIGHT, false)).toBe('focus');
    expect(padSequenceKindFor(DpadDir.DOWN, false)).toBe('sub');
    expect(padSequenceKindFor(DpadDir.DOWN, true)).toBe('corner');
    expect(padSequenceKindFor(DpadDir.LEFT, false)).toBeNull();
    expect(padSequenceKindFor(-1, false)).toBeNull();
    for (const [bit, corner, kind] of [[UP, false, 'tactics'], [RIGHT, false, 'focus'], [DOWN, false, 'sub'], [DOWN, true, 'corner']] as const) {
      const seq = createPadSequences();
      seq.update(bit, 50, corner);
      expect(seq.getPending()).toBe(kind);
      expect(seq.pendingSinceMs).toBe(50);
    }
  });

  it('D-pad left alone opens nothing and a lone first press never produces a command', () => {
    const seq = createPadSequences();
    expect(run(seq, [[LEFT, 0], [0, 16], [LEFT, 32], [0, 48]])).toEqual([]);
    expect(seq.pending).toBe(-1);
    expect(run(seq, [[UP, 100], [0, 116]])).toEqual([]);
    expect(seq.getPending()).toBe('tactics');
  });

  it('holding a direction never repeats: only press edges count', () => {
    const seq = createPadSequences();
    // up pressed once and "held" (no new edges): no command however long.
    const stream: [number, number][] = [[UP, 0]];
    for (let t = 16; t < 1000; t += 16) stream.push([0, t]);
    expect(run(seq, stream)).toEqual([]);
    expect(seq.update(UP, 1000, false)).toBe(Command.TACTIC_OFFSIDE_TRAP);
  });

  it('after a command the recogniser is idle: up x4 toggles the offside trap twice, up x3 once plus a pending sequence', () => {
    const seq = createPadSequences();
    expect(run(seq, [[UP, 0], [UP, 200], [UP, 400], [UP, 600]]).map((x) => x[0]))
      .toEqual([Command.TACTIC_OFFSIDE_TRAP, Command.TACTIC_OFFSIDE_TRAP]);
    const seq2 = createPadSequences();
    expect(run(seq2, [[UP, 0], [UP, 200], [UP, 400]]).map((x) => x[0])).toEqual([Command.TACTIC_OFFSIDE_TRAP]);
    expect(seq2.getPending()).toBe('tactics');
  });

  it('cmdArg is 0 for every sequence command and the HUD menus list exactly the valid continuations', () => {
    const f = createInputFrame();
    const seq = createPadSequences();
    seq.updateHeld(0, 0);
    seq.updateHeld(UP, 10);
    seq.updateHeld(0, 20);
    seq.updateHeld(LEFT, 30);
    f.cmdArg = 99;
    seq.applyTo(f);
    expect(f.cmd).toBe(Command.TACTIC_TEAM_PRESS);
    expect(f.cmdArg).toBe(0);

    const labels = (k: keyof typeof PAD_SEQUENCE_MENUS) => PAD_SEQUENCE_MENUS[k].options.map((o) => o.label);
    expect(labels('tactics')).toEqual(['Offside trap', 'Team press', 'Extra striker', 'Get in the box']);
    expect(labels('focus')).toEqual(['Default', 'Defending', 'Attacking']);
    expect(labels('sub')).toEqual(['Quick sub']);
    expect(labels('corner')).toEqual(['Far post', 'Edge of box', 'Crowd the keeper', 'Near post']);
    for (const k of ['tactics', 'focus', 'sub', 'corner'] as const) {
      const m = PAD_SEQUENCE_MENUS[k];
      expect(m.kind).toBe(k);
      expect(padSequenceKindFor(m.first, k === 'corner')).toBe(k);
      for (const o of m.options) {
        expect(o.cmd).not.toBe(Command.NONE);
        expect(o.cmd).toBe(padSequenceCommand(m.first, o.dir, k === 'corner'));
      }
      // Every valid continuation is listed.
      let valid = 0;
      for (let d = 0; d < 4; d++) if (padSequenceCommand(m.first, d, k === 'corner') !== Command.NONE) valid++;
      expect(m.options).toHaveLength(valid);
    }
  });
});

// ------------------------------------------------------------------ timeouts

describe('PAD-04 timeouts (T_PAD.dpadSequenceMs)', () => {
  it('a second press exactly at the window completes; one ms later it opens a new sequence instead', () => {
    const a = createPadSequences();
    expect(run(a, [[UP, 5000], [RIGHT, 5000 + W]])).toEqual([[Command.TACTIC_EXTRA_STRIKER, 5000 + W]]);
    const b = createPadSequences();
    expect(run(b, [[UP, 5000], [RIGHT, 5000 + W + 1]])).toEqual([]);
    // The late press opened a focus sequence at its own time, which completes within its own window.
    expect(b.getPending()).toBe('focus');
    expect(b.pendingSinceMs).toBe(5000 + W + 1);
    expect(b.update(LEFT, 5000 + W + 1 + 300, false)).toBe(Command.FOCUS_DEFENDING);
  });

  it('a pending sequence expires on an idle poll after the window; getPending(now) and remainingMs read the clock', () => {
    const seq = createPadSequences();
    seq.update(DOWN, 0, false);
    expect(seq.remainingMs(200)).toBe(W - 200);
    expect(seq.getPending(W)).toBe('sub');
    expect(seq.getPending(W + 1)).toBeNull(); // read-only check, nothing changed yet
    expect(seq.getPending()).toBe('sub');
    expect(seq.remainingMs(W + 1)).toBe(0);
    seq.update(0, W + 1, false);
    expect(seq.pending).toBe(-1);
    expect(seq.getPending()).toBeNull();
    // down again after the timeout: a fresh first press, not a quick sub.
    expect(seq.update(DOWN, W + 50, false)).toBe(Command.NONE);
    expect(seq.getPending()).toBe('sub');
    expect(seq.remainingMs(W + 50)).toBe(W);
  });

  it('a small step back of the clock is tolerated; a jump back beyond the window cancels; non-finite times are ignored', () => {
    const seq = createPadSequences();
    seq.update(UP, 1000, false);
    expect(seq.remainingMs(990)).toBe(W);
    expect(seq.update(LEFT, 990, false)).toBe(Command.TACTIC_TEAM_PRESS); // rAF stamp slightly before a now() stamp
    seq.update(UP, 5000, false);
    expect(seq.update(UP, 5000 - W - 1, false)).toBe(Command.NONE); // big jump back: cancelled, this press opens anew
    expect(seq.pendingSinceMs).toBe(5000 - W - 1);
    expect(seq.update(LEFT, Number.NaN, false)).toBe(Command.NONE);
    expect(seq.update(LEFT, Number.POSITIVE_INFINITY, false)).toBe(Command.NONE);
    expect(seq.getPending()).toBe('tactics');
    expect(seq.update(LEFT, 5000 - W + 50, false)).toBe(Command.TACTIC_TEAM_PRESS);
  });

  it('setContext accepts the InputSampleContext a pad source receives', () => {
    const seq = createPadSequences();
    const ctx: InputSampleContext = {
      tick: 1, human: 0, side: 0, projector: null,
      state: cornerState(MatchPhase.CORNER, RestartKind.CORNER, 0) as unknown as InputSampleContext['state'],
    };
    seq.setContext(ctx);
    seq.updateHeld(0, 0);
    seq.updateHeld(DOWN, 10);
    expect(seq.getPending()).toBe('corner');
  });

  it('createPadSequences({ windowMs }) overrides the window; a bad value falls back to T_PAD', () => {
    const seq = createPadSequences({ windowMs: 300 });
    expect(seq.windowMs).toBe(300);
    expect(run(seq, [[UP, 0], [UP, 301]])).toEqual([]);
    expect(createPadSequences({ windowMs: Number.NaN }).windowMs).toBe(W);
    expect(createPadSequences({ windowMs: -5 }).windowMs).toBe(W);
  });
});

// ------------------------------------------------------------------ invalid continuations, diagonals

describe('PAD-04 invalid continuations and diagonals', () => {
  it('right then down is not focus: the down press opens a quick-sub sequence (down again -> QUICK_SUB)', () => {
    const seq = createPadSequences();
    expect(run(seq, [[RIGHT, 0], [DOWN, 100]])).toEqual([]);
    expect(seq.getPending()).toBe('sub');
    expect(seq.update(DOWN, 200, false)).toBe(Command.QUICK_SUB);
  });

  it('down then up outside a corner opens quick tactics; down then left clears everything', () => {
    const seq = createPadSequences();
    expect(run(seq, [[DOWN, 0], [UP, 100]])).toEqual([]);
    expect(seq.getPending()).toBe('tactics');
    expect(seq.update(LEFT, 200, false)).toBe(Command.TACTIC_TEAM_PRESS);
    expect(run(seq, [[DOWN, 300], [LEFT, 400]])).toEqual([]);
    expect(seq.getPending()).toBeNull();
    expect(seq.update(DOWN, 500, false)).toBe(Command.NONE); // fresh first press
  });

  it('two D-pad edges in one poll (a rocker diagonal) are ignored, idle or pending', () => {
    const seq = createPadSequences();
    expect(seq.update(UP | RIGHT, 0, false)).toBe(Command.NONE);
    expect(seq.pending).toBe(-1);
    seq.update(UP, 100, false);
    expect(seq.update(LEFT | DOWN, 200, false)).toBe(Command.NONE);
    expect(seq.getPending()).toBe('tactics');
    expect(seq.pendingSinceMs).toBe(100);
    expect(seq.update(UP | DOWN | LEFT | RIGHT, 250, false)).toBe(Command.NONE);
    expect(seq.update(DOWN, 300, false)).toBe(Command.TACTIC_GET_IN_BOX);
  });

  it('bits outside the D-pad nibble are ignored', () => {
    const seq = createPadSequences();
    expect(seq.update(UP | 0x30, 0, false)).toBe(Command.NONE);
    expect(seq.update(0x100 | UP, 10, false)).toBe(Command.TACTIC_OFFSIDE_TRAP);
  });

  it('reset() forgets a pending sequence', () => {
    const seq = createPadSequences();
    seq.update(UP, 0, false);
    seq.reset();
    expect(seq.pending).toBe(-1);
    expect(seq.update(UP, 10, false)).toBe(Command.NONE);
  });

  it('is deterministic: two recognisers fed the same long random edge stream emit identical commands', () => {
    let x = 12345;
    const rnd = (): number => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 4294967296; };
    const stream: [number, number][] = [];
    let t = 0;
    for (let i = 0; i < 5000; i++) {
      t += 8 + Math.floor(rnd() * 400);
      const r = rnd();
      stream.push([r < 0.5 ? 0 : r < 0.95 ? BIT_OF[Math.floor(rnd() * 4)]! : UP | LEFT, t]);
    }
    const corner = (i: number): boolean => i % 700 < 300;
    const runC = (seq: PadSequences): [Command, number][] => {
      const out: [Command, number][] = [];
      stream.forEach(([e, tt], i) => { const c = seq.update(e, tt, corner(i)); if (c) out.push([c, tt]); });
      return out;
    };
    const a = runC(createPadSequences());
    const b = runC(createPadSequences());
    expect(a.length).toBeGreaterThan(100);
    expect(a).toEqual(b);
    // Every command is one of the sequence commands.
    const allowed = new Set([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14]);
    for (const [c] of a) expect(allowed.has(c)).toBe(true);
  });
});

// ------------------------------------------------------------------ corner context

function cornerState(phase: MatchPhase, kind: RestartKind, team: number, taken = 0): ReadonlySimState {
  return { match: { phase, restart: { kind, team, taken } } } as unknown as ReadonlySimState;
}

describe('PAD-04 corner context (corner tactics only while the human\'s own team takes a corner)', () => {
  it('isTeamCornerContext: own corner not yet taken only', () => {
    expect(isTeamCornerContext(cornerState(MatchPhase.CORNER, RestartKind.CORNER, 0), 0)).toBe(true);
    expect(isTeamCornerContext(cornerState(MatchPhase.CORNER, RestartKind.CORNER, 1), 1)).toBe(true);
    expect(isTeamCornerContext(cornerState(MatchPhase.CORNER, RestartKind.CORNER, 1), 0)).toBe(false); // defending
    expect(isTeamCornerContext(cornerState(MatchPhase.CORNER, RestartKind.CORNER, 0, 1), 0)).toBe(false); // taken
    expect(isTeamCornerContext(cornerState(MatchPhase.IN_PLAY, RestartKind.CORNER, 0), 0)).toBe(false);
    expect(isTeamCornerContext(cornerState(MatchPhase.FREE_KICK, RestartKind.FREE_KICK, 0), 0)).toBe(false);
    expect(isTeamCornerContext(cornerState(MatchPhase.CORNER, RestartKind.CORNER, 0), -1)).toBe(false);
    expect(isTeamCornerContext(null, 0)).toBe(false);
    expect(isTeamCornerContext(undefined, 0)).toBe(false);
  });

  it('down, down is the near-post corner routine for the attacking human and a quick sub for the defending one', () => {
    const own = createPadSequences();
    const opp = createPadSequences();
    const st = cornerState(MatchPhase.CORNER, RestartKind.CORNER, 0);
    own.setContext({ state: st, side: 0, human: 0 });
    opp.setContext({ state: st, side: 1, human: 1 });
    const feed = (s: PadSequences): Command[] => {
      const out: Command[] = [];
      for (const [h, t] of [[0, 0], [DOWN, 10], [0, 20], [DOWN, 30]] as const) { const c = s.updateHeld(h, t); if (c) out.push(c); }
      return out;
    };
    expect(feed(own)).toEqual([Command.CORNER_NEAR_POST]);
    expect(feed(opp)).toEqual([Command.QUICK_SUB]);
  });

  it('a pending corner sequence is cancelled when the corner is taken before the second press', () => {
    const seq = createPadSequences();
    const live = cornerState(MatchPhase.CORNER, RestartKind.CORNER, 0);
    seq.setContext({ state: live, side: 0, human: 0 });
    seq.updateHeld(0, 0);
    seq.updateHeld(DOWN, 10);
    expect(seq.getPending()).toBe('corner');
    expect(getPadSequencePending(0)).toBe('corner');
    // The corner is played (phase back to IN_PLAY): the prompt closes at once, the next press is a fresh first press.
    seq.setContext({ state: cornerState(MatchPhase.IN_PLAY, RestartKind.CORNER, 0, 1), side: 0, human: 0 });
    expect(seq.getPending()).toBeNull();
    expect(getPadSequencePending(0)).toBeNull();
    seq.updateHeld(0, 20);
    expect(seq.updateHeld(UP, 30)).toBe(Command.NONE);
    expect(seq.getPending()).toBe('tactics');
    // The pure API cancels too when its cornerContext argument drops.
    const p = createPadSequences();
    p.update(DOWN, 0, true);
    expect(p.update(LEFT, 10, false)).toBe(Command.NONE);
    expect(p.getPending()).toBeNull();
  });

  it('a quick-sub sequence opened before a corner stays a quick sub (kind locked at the first press)', () => {
    const seq = createPadSequences();
    expect(run(seq, [[DOWN, 0]], false)).toEqual([]);
    expect(seq.update(DOWN, 100, true)).toBe(Command.QUICK_SUB);
  });
});

// ------------------------------------------------------------------ device path (mock pads)

interface MockButton { pressed: boolean; touched: boolean; value: number }
interface MockPad { id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[]; buttons: MockButton[] }

function mockPad(index: number, mapping = 'standard'): MockPad {
  return {
    id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', index, connected: true, mapping,
    timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
}

interface Rig {
  pad: MockPad;
  list: (MockPad | null)[];
  mgr: PadManager;
  seq: PadSequences;
  t: number;
  /** One animation frame: poll + updatePad. Returns the command completed by this poll. */
  frame(dt?: number): Command;
  set(b: number, on: boolean): void;
  /** Press, frame, release, frame. Returns the commands completed. */
  tap(b: number): Command[];
  /** One tick: setContext + applyTo into a fresh frame. */
  sample(ctx?: PadSequenceContext): ReturnType<typeof createInputFrame>;
}

function rig(seq: PadSequences = createPadSequences(), mapping = 'standard'): Rig {
  const pad = mockPad(0, mapping);
  const list: (MockPad | null)[] = [pad, null, null, null];
  const mgr = createPadManager(() => list as unknown as Gamepad[], { eventTarget: null });
  const r: Rig = {
    pad, list, mgr, seq, t: 1000,
    frame(dt = 16) {
      r.t += dt;
      mgr.poll(r.t);
      return seq.updatePad(mgr.find('pad:1'), r.t);
    },
    set(b, on) { pad.buttons[b]!.pressed = on; pad.buttons[b]!.value = on ? 1 : 0; },
    tap(b) {
      const out: Command[] = [];
      r.set(b, true);
      const c1 = r.frame();
      if (c1) out.push(c1);
      r.set(b, false);
      const c2 = r.frame();
      if (c2) out.push(c2);
      return out;
    },
    sample(ctx = { state: null, side: 0, human: 0 }) {
      const f = createInputFrame();
      seq.setContext(ctx);
      seq.applyTo(f);
      return f;
    },
  };
  // Activate the pad with a stick-free button nobody maps (L3), then settle.
  r.set(PadButton.L3, true); r.frame(); r.set(PadButton.L3, false); r.frame();
  return r;
}

describe('PAD-04 device path: real pad manager, mock Gamepad objects', () => {
  it('D-pad buttons 12..15 drive the recogniser; the command reaches exactly one InputFrame with cmdArg 0', () => {
    const r = rig();
    expect(r.tap(PadButton.DPAD_UP)).toEqual([]);
    expect(r.seq.getPending()).toBe('tactics');
    expect(r.tap(PadButton.DPAD_LEFT)).toEqual([Command.TACTIC_TEAM_PRESS]);
    const f = r.sample();
    expect(f.cmd).toBe(Command.TACTIC_TEAM_PRESS);
    expect(f.cmdArg).toBe(0);
    expect(r.sample().cmd).toBe(Command.NONE);
  });

  it('interleaved buttons: face buttons, shoulders and triggers between the presses neither break nor trigger a sequence', () => {
    const r = rig();
    r.tap(PadButton.DPAD_RIGHT);
    expect(r.tap(PadButton.SOUTH)).toEqual([]);
    r.set(PadButton.R2, true); // sprint held across the second press
    r.frame();
    expect(r.tap(PadButton.WEST)).toEqual([]);
    expect(r.seq.getPending()).toBe('focus');
    // Face button pressed in the same poll as the second D-pad press.
    r.set(PadButton.EAST, true);
    r.set(PadButton.DPAD_RIGHT, true);
    expect(r.frame()).toBe(Command.FOCUS_ATTACKING);
    const s = r.mgr.find('pad:1')!;
    expect(mapPadButtons(s) & (Btn.SHOOT | Btn.SPRINT)).toBe(Btn.SHOOT | Btn.SPRINT); // face/trigger bits unaffected
    r.set(PadButton.EAST, false); r.set(PadButton.DPAD_RIGHT, false); r.set(PadButton.R2, false);
    r.frame();
    expect(r.sample().cmd).toBe(Command.FOCUS_ATTACKING);
    // A long burst of face-button play with no D-pad: never a command, nothing pending.
    for (let i = 0; i < 50; i++) {
      expect(r.tap(i % 12)).toEqual([]);
      expect(r.sample().cmd).toBe(Command.NONE);
    }
    expect(r.seq.getPending()).toBeNull();
  });

  it('a D-pad direction held while another is pressed still counts (only new presses matter)', () => {
    const r = rig();
    r.set(PadButton.DPAD_UP, true);
    r.frame();
    r.frame();
    r.set(PadButton.DPAD_DOWN, true); // up still held
    expect(r.frame()).toBe(Command.TACTIC_GET_IN_BOX);
  });

  it('feeding the same poll twice never doubles a press (own edge detection on held bits)', () => {
    const r = rig();
    r.set(PadButton.DPAD_UP, true);
    r.frame();
    const s = r.mgr.find('pad:1')!;
    expect(r.seq.updatePad(s, r.t)).toBe(Command.NONE); // same snapshot again (e.g. sample's fallback poll)
    expect(r.seq.updatePad(s, r.t + 1)).toBe(Command.NONE);
    expect(r.seq.getPending()).toBe('tactics');
  });

  it('a direction already held when the recogniser starts or after reset() is not a press', () => {
    const seq = createPadSequences();
    const r = rig(seq);
    r.set(PadButton.DPAD_UP, true);
    r.mgr.poll(r.t += 16);
    const fresh = createPadSequences();
    expect(fresh.updatePad(r.mgr.find('pad:1'), r.t)).toBe(Command.NONE);
    expect(fresh.getPending()).toBeNull();
    // Old recogniser: up pressed (pending), reset (pause) while still held, release + press -> only then a press.
    r.frame();
    expect(seq.getPending()).toBe('tactics');
    seq.reset();
    r.frame();
    r.frame();
    expect(seq.getPending()).toBeNull();
    r.set(PadButton.DPAD_UP, false);
    r.frame();
    r.set(PadButton.DPAD_UP, true);
    r.frame();
    expect(seq.getPending()).toBe('tactics');
  });

  it('controller disconnect mid-sequence cancels it, and a D-pad held through the reconnect does not fire', () => {
    const r = rig();
    r.tap(PadButton.DPAD_DOWN);
    expect(r.seq.getPending()).toBe('sub');
    r.list[0] = null; // unplugged
    expect(r.frame()).toBe(Command.NONE);
    expect(r.seq.getPending()).toBeNull();
    r.set(PadButton.DPAD_DOWN, true); // comes back with down held
    r.list[0] = r.pad;
    expect(r.frame()).toBe(Command.NONE);
    expect(r.frame()).toBe(Command.NONE);
    expect(r.seq.getPending()).toBeNull();
    expect(r.sample().cmd).toBe(Command.NONE);
    // Normal play resumes.
    r.set(PadButton.DPAD_DOWN, false);
    r.frame();
    r.tap(PadButton.DPAD_DOWN);
    expect(r.tap(PadButton.DPAD_DOWN)).toEqual([Command.QUICK_SUB]);
  });

  it('a pad without the standard mapping produces nothing unless readDpad supplies the bits', () => {
    const r = rig(createPadSequences(), '');
    r.tap(PadButton.DPAD_UP);
    expect(r.tap(PadButton.DPAD_UP)).toEqual([]);
    expect(padDpadBits(r.mgr.find('pad:1')!)).toBe(0);
    // A remap (PAD-07) can provide the D-pad: here buttons 0 / 1 stand in for up / down.
    const remapped = rig(createPadSequences({ readDpad: (s) => (s.pressed & 1 ? UP : 0) | (s.pressed & 2 ? DOWN : 0) }), '');
    remapped.tap(PadButton.SOUTH);
    expect(remapped.tap(PadButton.EAST)).toEqual([Command.TACTIC_GET_IN_BOX]);
  });

  it('padDpadBits maps buttons 12..15 to bits 0..3', () => {
    const r = rig();
    r.set(PadButton.DPAD_UP, true); r.set(PadButton.DPAD_RIGHT, true); r.set(PadButton.SOUTH, true);
    r.frame();
    expect(padDpadBits(r.mgr.find('pad:1')!)).toBe(UP | RIGHT);
  });

  it('applyTo keeps its command when the frame already carries one, and writes it on the next frame', () => {
    const seq = createPadSequences();
    seq.updateHeld(0, 0);
    seq.updateHeld(DOWN, 10);
    seq.updateHeld(0, 20);
    seq.updateHeld(DOWN, 30);
    const f = createInputFrame();
    f.cmd = Command.SKIP;
    f.cmdArg = 5;
    seq.applyTo(f);
    expect([f.cmd, f.cmdArg]).toEqual([Command.SKIP, 5]);
    const g = createInputFrame();
    seq.applyTo(g);
    expect(g.cmd).toBe(Command.QUICK_SUB);
  });

  it('two commands completed between two samples are written one per frame, in order', () => {
    const seq = createPadSequences();
    const held = [0, UP, 0, UP, 0, RIGHT, 0, RIGHT];
    held.forEach((h, i) => seq.updateHeld(h, i * 8));
    const a = createInputFrame();
    const b = createInputFrame();
    const c = createInputFrame();
    seq.applyTo(a); seq.applyTo(b); seq.applyTo(c);
    expect([a.cmd, b.cmd, c.cmd]).toEqual([Command.TACTIC_OFFSIDE_TRAP, Command.FOCUS_ATTACKING, Command.NONE]);
  });

  it('a latched command nobody samples within latchMaxMs is dropped (ticks stopped)', () => {
    const seq = createPadSequences();
    seq.updateHeld(0, 0);
    seq.updateHeld(UP, 10);
    seq.updateHeld(0, 20);
    seq.updateHeld(UP, 30);
    seq.updateHeld(0, 30 + PAD_SEQUENCE_TUNING.latchMaxMs); // still within: kept
    const keep = createPadSequences();
    keep.updateHeld(0, 0); keep.updateHeld(UP, 10); keep.updateHeld(0, 20); keep.updateHeld(UP, 30);
    keep.updateHeld(0, 30 + PAD_SEQUENCE_TUNING.latchMaxMs);
    const f = createInputFrame();
    keep.applyTo(f);
    expect(f.cmd).toBe(Command.TACTIC_OFFSIDE_TRAP);
    seq.updateHeld(0, 31 + PAD_SEQUENCE_TUNING.latchMaxMs); // too old now
    const g = createInputFrame();
    seq.applyTo(g);
    expect(g.cmd).toBe(Command.NONE);
  });

  it('reset() (releaseAll on pause) drops a latched command and the pending sequence', () => {
    const seq = createPadSequences();
    seq.updateHeld(0, 0); seq.updateHeld(UP, 10); seq.updateHeld(0, 20); seq.updateHeld(UP, 30); seq.updateHeld(0, 40);
    seq.updateHeld(DOWN, 50);
    seq.reset();
    const f = createInputFrame();
    seq.applyTo(f);
    expect(f.cmd).toBe(Command.NONE);
    expect(seq.getPending()).toBeNull();
  });

  it('setPadSequencesSuspended mutes every recogniser; presses made while muted are not replayed afterwards', () => {
    const seq = createPadSequences();
    seq.setContext({ state: null, side: 0, human: 0 });
    seq.updateHeld(0, 0);
    seq.updateHeld(DOWN, 10);
    expect(getPadSequencePending(0)).toBe('sub');
    setPadSequencesSuspended(true); // quick-sub prompt opened, navigated with the D-pad
    expect(getPadSequencePending(0)).toBeNull();
    expect(seq.updateHeld(0, 20)).toBe(Command.NONE);
    expect(seq.updateHeld(DOWN, 30)).toBe(Command.NONE);
    expect(seq.getPending()).toBeNull();
    seq.updateHeld(0, 40);
    expect(seq.updateHeld(UP, 50)).toBe(Command.NONE);
    setPadSequencesSuspended(false);
    // Up is still held from the prompt: not a press. Release and press again: pending only, no command from before.
    expect(seq.updateHeld(UP, 60)).toBe(Command.NONE);
    expect(seq.getPending()).toBeNull();
    seq.updateHeld(0, 70);
    seq.updateHeld(UP, 80);
    expect(seq.getPending()).toBe('tactics');
    const f = createInputFrame();
    seq.applyTo(f);
    expect(f.cmd).toBe(Command.NONE);
  });

  it('a command latched just before suspension is not written while suspended', () => {
    const seq = createPadSequences();
    seq.updateHeld(0, 0); seq.updateHeld(DOWN, 10); seq.updateHeld(0, 20); seq.updateHeld(DOWN, 30);
    setPadSequencesSuspended(true);
    const f = createInputFrame();
    seq.applyTo(f);
    expect(f.cmd).toBe(Command.NONE);
  });
});

// ------------------------------------------------------------------ HUD bridge

describe('PAD-04 HUD pending state per human', () => {
  it('publishes the pending kind for the human set by setContext and clears it on completion, timeout and dispose', () => {
    const seq = createPadSequences();
    seq.setContext({ state: null, side: 1, human: 1 });
    seq.updateHeld(0, 0);
    expect(getPadSequencePending(1)).toBeNull();
    seq.updateHeld(UP, 100);
    expect(getPadSequencePending(1)).toBe('tactics');
    expect(getPadSequencePending(0)).toBeNull();
    const out: PadSequenceHudState = { kind: null, sinceMs: 0, windowMs: 0 };
    expect(readPadSequenceHud(1, out)).toEqual({ kind: 'tactics', sinceMs: 100, windowMs: W });
    seq.updateHeld(0, 120);
    seq.updateHeld(RIGHT, 140);
    expect(getPadSequencePending(1)).toBeNull();
    // Timeout on an idle poll.
    seq.updateHeld(0, 200);
    seq.updateHeld(RIGHT, 220);
    expect(getPadSequencePending(1)).toBe('focus');
    seq.updateHeld(0, 220 + W + 1);
    expect(getPadSequencePending(1)).toBeNull();
    expect(readPadSequenceHud(1, out)).toEqual({ kind: null, sinceMs: -1, windowMs: W });
    // Dispose.
    seq.updateHeld(DOWN, 2000);
    expect(getPadSequencePending(1)).toBe('sub');
    seq.dispose();
    expect(getPadSequencePending(1)).toBeNull();
  });

  it('an idle second pad of the same human never clears the first pad\'s prompt', () => {
    const a = createPadSequences();
    const b = createPadSequences();
    a.setContext({ state: null, side: 0, human: 0 });
    b.setContext({ state: null, side: 0, human: 0 });
    a.updateHeld(0, 0); b.updateHeld(0, 0);
    a.updateHeld(UP, 10);
    b.updateHeld(0, 10); b.updateHeld(0, 20);
    b.setContext({ state: null, side: 0, human: 0 });
    b.reset();
    expect(getPadSequencePending(0)).toBe('tactics');
    b.dispose();
    expect(getPadSequencePending(0)).toBe('tactics');
    a.dispose();
    expect(getPadSequencePending(0)).toBeNull();
  });

  it('moving a recogniser to another human moves its prompt; invalid humans publish nothing', () => {
    const seq = createPadSequences();
    seq.setContext({ state: null, side: 0, human: 0 });
    seq.update(UP, 0, false);
    expect(getPadSequencePending(0)).toBe('tactics');
    seq.setContext({ state: null, side: 1, human: 1 });
    expect(getPadSequencePending(0)).toBeNull();
    expect(getPadSequencePending(1)).toBe('tactics');
    seq.setContext({ state: null, side: 1, human: 7 });
    expect(getPadSequencePending(1)).toBeNull();
    expect(getPadSequencePending(7)).toBeNull();
    expect(getPadSequencePending(-1)).toBeNull();
  });
});

// ------------------------------------------------------------------ double-press latch

/** Sim-side view: count press edges (0 -> 1) of bit 0 over a stream of samples. */
function pressEdges(samples: number[], bit = 1): number {
  let n = 0;
  let prev = 0;
  for (const s of samples) {
    if ((s & bit) !== 0 && (prev & bit) === 0) n++;
    prev = s;
  }
  return n;
}

describe('PAD-04 device-level double-press latch (createPressLatch)', () => {
  it('a tap shorter than a tick is reported for one sample', () => {
    const l = createPressLatch();
    l.poll(1); l.poll(0);
    expect([l.sample(), l.sample()]).toEqual([1, 0]);
  });

  it('a 120 Hz double tap (press, release, press, release inside two ticks) stays two press edges', () => {
    const l = createPressLatch();
    const samples: number[] = [];
    // Poll at 120 Hz, sample at 60 Hz: d u | d u | - -
    for (const pair of [[1, 0], [1, 0], [0, 0], [0, 0]]) {
      l.poll(pair[0]!); l.poll(pair[1]!);
      samples.push(l.sample());
    }
    expect(pressEdges(samples)).toBe(2);
    expect(samples).toEqual([1, 0, 1, 0]);
    // The naive OR-latch the mapper used would have reported [1, 1, 0, 0]: one press.
  });

  it('release + re-press between two samples while reported down inserts one up sample', () => {
    const l = createPressLatch();
    l.poll(1);
    expect(l.sample()).toBe(1);
    l.poll(0); l.poll(1);
    expect(l.sample()).toBe(0);
    expect(l.sample()).toBe(1);
    expect(l.sample()).toBe(1); // still held
    l.poll(0);
    expect(l.sample()).toBe(0);
  });

  it('holds report continuously and independent bits do not disturb each other', () => {
    const l = createPressLatch();
    l.poll(Btn.PASS);
    expect(l.sample()).toBe(Btn.PASS);
    l.poll(Btn.PASS | Btn.SPRINT);
    expect(l.sample()).toBe(Btn.PASS | Btn.SPRINT);
    l.poll(Btn.SPRINT); l.poll(Btn.SPRINT | Btn.PASS); // PASS re-pressed inside one tick, SPRINT held
    expect(l.sample()).toBe(Btn.SPRINT);
    expect(l.sample()).toBe(Btn.SPRINT | Btn.PASS);
  });

  it('caps the queue at pressQueueMax presses per bit (a mash cannot build a backlog)', () => {
    const l = createPressLatch();
    for (let i = 0; i < 6; i++) { l.poll(1); l.poll(0); }
    expect(l.queued(0)).toBe(PAD_SEQUENCE_TUNING.pressQueueMax);
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) samples.push(l.sample());
    expect(pressEdges(samples)).toBe(PAD_SEQUENCE_TUNING.pressQueueMax);
    expect(l.queued(0)).toBe(0);
    expect(l.queued(-1)).toBe(0);
  });

  it('reset() drops queued presses and suppresses held bits until they are released', () => {
    const l = createPressLatch();
    l.poll(1 | 2);
    l.reset();
    expect(l.sample()).toBe(0);
    l.poll(1 | 2);
    expect(l.sample()).toBe(0); // still held: suppressed
    l.poll(2); // bit 0 released
    l.poll(2 | 1); // pressed again: a real press
    expect(l.sample()).toBe(1);
    l.poll(0);
    l.poll(2);
    expect(l.sample()).toBe(2);
  });

  it('works for bit 31', () => {
    const l = createPressLatch();
    l.poll(1 << 31); l.poll(0); l.poll(1 << 31); l.poll(0);
    expect([l.sample(), l.sample(), l.sample(), l.sample()]).toEqual([1 << 31, 0, 1 << 31, 0]);
  });
});
