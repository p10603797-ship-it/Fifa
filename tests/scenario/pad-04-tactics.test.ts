/**
 * PAD-04 scenario: D-pad sequences from a mock pad through the recogniser into the human's InputFrame, stepped through
 * the real sim pipeline (SIM-15 resolver -> TAI-14 applyCommand). Quick tactics and tactical focus change the human's
 * team; during the human's own corner, down then left sets the corner routine; during the opponents' corner, down then
 * down is a quick sub (app-level: the sim changes nothing).
 */
import { describe, expect, it } from 'vitest';
import { Command, MatchPhase, RestartKind, TacticalFocus } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createPadManager, PadButton } from '../../src/input/pad/manager';
import { createPadSequences, isTeamCornerContext, type PadSequences } from '../../src/input/pad/sequences';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario, runTicks } from '../harness/scenario';

interface MockButton { pressed: boolean; touched: boolean; value: number }

/** A mock DualSense polled by the real manager; frames() presses D-pad buttons one per frame with releases between. */
function padRig(seq: PadSequences) {
  const buttons: MockButton[] = Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = { id: 'DualSense Wireless Controller', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons };
  const mgr = createPadManager(() => [pad] as unknown as Gamepad[], { eventTarget: null });
  let t = 0;
  const poll = (): void => { t += 16; mgr.poll(t); seq.updatePad(mgr.find('pad:1'), t); };
  const set = (b: number, on: boolean): void => { buttons[b]!.pressed = on; buttons[b]!.value = on ? 1 : 0; };
  set(PadButton.L3, true); poll(); set(PadButton.L3, false); poll();
  return {
    /** Tap each button (one frame down, one up). */
    tap(...bs: number[]): void {
      for (const b of bs) { set(b, true); poll(); set(b, false); poll(); }
    },
  };
}

/** The pad source's sample(): context from the state, command into the frame. */
function sampleInto(seq: PadSequences, s: SimState, out: InputFrame[], human = 0): void {
  const side = s.ctrl[human]!.side;
  seq.setContext({ state: s, side, human });
  seq.applyTo(out[human]!);
}

describe('PAD-04 D-pad tactics reach the sim', () => {
  it('up, right toggles extra striker; right, right sets attacking focus; up, up toggles the offside trap', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 1 });
    const seq = createPadSequences();
    const pad = padRig(seq);
    const t0 = s.teams[0]!;
    expect([t0.extraStriker, t0.focus, t0.offsideTrap]).toEqual([0, TacticalFocus.DEFAULT, 0]);

    pad.tap(PadButton.DPAD_UP, PadButton.DPAD_RIGHT);
    runTicks(s, 1, (_t, st, out) => sampleInto(seq, st, out));
    expect(t0.extraStriker).toBe(1);

    pad.tap(PadButton.DPAD_RIGHT, PadButton.DPAD_RIGHT);
    runTicks(s, 1, (_t, st, out) => sampleInto(seq, st, out));
    expect(t0.focus).toBe(TacticalFocus.ATTACKING);

    pad.tap(PadButton.DPAD_UP, PadButton.DPAD_UP);
    runTicks(s, 1, (_t, st, out) => sampleInto(seq, st, out));
    expect(t0.offsideTrap).toBe(1);
    // The opponents are untouched and the command is written once only (next ticks carry nothing).
    expect([s.teams[1]!.extraStriker, s.teams[1]!.offsideTrap, s.teams[1]!.focus]).toEqual([0, 0, TacticalFocus.DEFAULT]);
    runTicks(s, 5, (_t, st, out) => sampleInto(seq, st, out));
    expect(t0.offsideTrap).toBe(1);
  });

  it('own corner: down, left sets the edge-of-box routine; opponents\' corner: down, down is a quick sub only', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 1 });
    const ev = createEventBuffer();
    const dir = s.teams[0]!.dir;
    awardRestart(s, RestartKind.CORNER, 0, 52.5 * dir, 34, ev);
    expect(s.match.phase).toBe(MatchPhase.CORNER);
    expect(isTeamCornerContext(s, 0)).toBe(true);
    expect(isTeamCornerContext(s, 1)).toBe(false);

    const seq = createPadSequences();
    const pad = padRig(seq);
    // One sample first so the recogniser knows the context (as in the running game).
    runTicks(s, 1, (_t, st, out) => sampleInto(seq, st, out));
    pad.tap(PadButton.DPAD_DOWN);
    expect(seq.getPending()).toBe('corner');
    pad.tap(PadButton.DPAD_LEFT);
    const frames: Command[] = [];
    runTicks(s, 1, (_t, st, out) => { sampleInto(seq, st, out); frames.push(out[0]!.cmd); });
    expect(frames).toEqual([Command.CORNER_EDGE_OF_BOX]);
    expect(s.teams[0]!.cornerTactic).toBe(Command.CORNER_EDGE_OF_BOX);

    // Opponents' corner for a human on side 0.
    const s2 = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 1 });
    awardRestart(s2, RestartKind.CORNER, 1, 52.5 * s2.teams[1]!.dir, -34, createEventBuffer());
    expect(s2.match.phase).toBe(MatchPhase.CORNER);
    expect(isTeamCornerContext(s2, 0)).toBe(false);
    const seq2 = createPadSequences();
    const pad2 = padRig(seq2);
    runTicks(s2, 1, (_t, st, out) => sampleInto(seq2, st, out));
    pad2.tap(PadButton.DPAD_DOWN);
    expect(seq2.getPending()).toBe('sub');
    pad2.tap(PadButton.DPAD_DOWN);
    const cmds: Command[] = [];
    const before = JSON.stringify([s2.teams[0], s2.teams[1]].map((t) => [t!.cornerTactic, t!.offsideTrap, t!.focus, t!.subsUsed]));
    runTicks(s2, 1, (_t, st, out) => { sampleInto(seq2, st, out); cmds.push(out[0]!.cmd); });
    expect(cmds).toEqual([Command.QUICK_SUB]);
    const after = JSON.stringify([s2.teams[0], s2.teams[1]].map((t) => [t!.cornerTactic, t!.offsideTrap, t!.focus, t!.subsUsed]));
    expect(after).toBe(before);
  });

  it('a corner prompt opened during the corner closes when the corner is taken', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 1 });
    awardRestart(s, RestartKind.CORNER, 0, 52.5 * s.teams[0]!.dir, 34, createEventBuffer());
    const seq = createPadSequences();
    const pad = padRig(seq);
    runTicks(s, 1, (_t, st, out) => sampleInto(seq, st, out));
    pad.tap(PadButton.DPAD_DOWN);
    expect(seq.getPending()).toBe('corner');
    // The corner is played: rules mark it taken and return to IN_PLAY.
    s.match.restart.taken = 1;
    s.match.phase = MatchPhase.IN_PLAY;
    const f = createInputFrame();
    seq.setContext({ state: s, side: 0, human: 0 });
    seq.applyTo(f);
    expect(seq.getPending()).toBeNull();
    expect(f.cmd).toBe(Command.NONE);
  });
});
