import { describe, expect, it, vi } from 'vitest';
import type { DeviceInfo, DeviceRegistry } from '../../src/contracts/app';
import { Command, GestureKind, SkillMove } from '../../src/contracts/enums';
import { Btn, createInputFrame, type InputFrame, type InputSampleContext, type InputSource } from '../../src/contracts/input';
import type { ReadonlySimState } from '../../src/contracts/state';
import { ANY_DEVICE, createCommandQueue, createLocalInputProvider, mergeInputFrame } from '../../src/app/localInput';

function frame(over: Partial<InputFrame>): InputFrame {
  return { ...createInputFrame(), ...over };
}

describe('FND-04 mergeInputFrame', () => {
  it('ORs buttons and takes the larger movement and aim', () => {
    const dst = createInputFrame();
    mergeInputFrame(dst, frame({ buttons: Btn.PASS, mx: 20, mz: 0, ax: 0, az: 100 }));
    mergeInputFrame(dst, frame({ buttons: Btn.SPRINT, mx: 0, mz: -90, ax: 10, az: 0 }));
    expect(dst.buttons).toBe(Btn.PASS | Btn.SPRINT);
    expect([dst.mx, dst.mz]).toEqual([0, -90]);
    expect([dst.ax, dst.az]).toEqual([0, 100]);
  });

  it('keeps the first non-zero power, curve, skill, command and gesture', () => {
    const dst = createInputFrame();
    mergeInputFrame(dst, frame({ power: 0, skill: SkillMove.NONE, cmd: Command.NONE }));
    mergeInputFrame(dst, frame({ power: 50, curve: -20, skill: SkillMove.ROULETTE, cmd: Command.TACTIC_TEAM_PRESS, cmdArg: 3, gesture: GestureKind.TAP, gx: 10, gz: -4, gSlot: 7, gFlags: 1 }));
    mergeInputFrame(dst, frame({ power: 99, curve: 40, skill: SkillMove.STEP_OVER, cmd: Command.SKIP, cmdArg: 9, gesture: GestureKind.SWIPE, gx: 99, gSlot: 2 }));
    expect(dst.power).toBe(50);
    expect(dst.curve).toBe(-20);
    expect(dst.skill).toBe(SkillMove.ROULETTE);
    expect([dst.cmd, dst.cmdArg]).toEqual([Command.TACTIC_TEAM_PRESS, 3]);
    expect([dst.gesture, dst.gx, dst.gz, dst.gSlot, dst.gFlags]).toEqual([GestureKind.TAP, 10, -4, 7, 1]);
  });
});

describe('FND-04 command queue', () => {
  it('delivers one command per frame, FIFO, and SKIP also sets Btn.SKIP', () => {
    const q = createCommandQueue(4);
    q.push(0, Command.SKIP, 0);
    q.push(0, Command.FOCUS_ATTACKING, 0);
    q.push(1, Command.SUBSTITUTE, 0x0305);
    const frames = [createInputFrame(), createInputFrame()];
    q.applyTo(frames);
    expect(frames[0]!.cmd).toBe(Command.SKIP);
    expect(frames[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    expect([frames[1]!.cmd, frames[1]!.cmdArg]).toEqual([Command.SUBSTITUTE, 0x0305]);
    const next = [createInputFrame(), createInputFrame()];
    q.applyTo(next);
    expect(next[0]!.cmd).toBe(Command.FOCUS_ATTACKING);
    expect(next[1]!.cmd).toBe(Command.NONE);
  });

  it('does not overwrite a device command and drops the oldest on overflow', () => {
    const q = createCommandQueue(2);
    q.push(0, Command.TACTIC_OFFSIDE_TRAP, 0);
    q.push(0, Command.TACTIC_TEAM_PRESS, 0);
    q.push(0, Command.TACTIC_GET_IN_BOX, 0);
    expect(q.size(0)).toBe(2);
    const frames = [frame({ cmd: Command.QUICK_SUB }), createInputFrame()];
    q.applyTo(frames);
    expect(frames[0]!.cmd).toBe(Command.QUICK_SUB);
    expect(q.size(0)).toBe(2);
    const f2 = [createInputFrame(), createInputFrame()];
    q.applyTo(f2);
    expect(f2[0]!.cmd).toBe(Command.TACTIC_TEAM_PRESS);
    q.push(5, Command.SKIP, 0); // out of range human is ignored
    q.push(0, Command.NONE, 0);
    expect(q.size(0)).toBe(1);
  });
});

function fakeSource(id: string, write: (out: InputFrame, ctx: InputSampleContext) => void): InputSource & { calls: InputSampleContext[] } {
  const calls: InputSampleContext[] = [];
  return {
    id, kind: 'pad', calls,
    sample(out, ctx) { calls.push({ ...ctx }); write(out, ctx); },
    releaseAll: vi.fn(), pollFrame: vi.fn(), dispose: vi.fn(),
  };
}

function registry(initial: DeviceInfo[], writers: Record<string, (out: InputFrame) => void>) {
  let list = initial;
  const subs: ((d: DeviceInfo[]) => void)[] = [];
  const sources: Record<string, ReturnType<typeof fakeSource>> = {};
  const reg: DeviceRegistry = {
    list: () => list,
    subscribe(fn) { subs.push(fn); return () => { subs.splice(subs.indexOf(fn), 1); }; },
    createSource(id, human) {
      if (id === 'broken') throw new Error('no such device');
      const s = fakeSource(id, (out) => writers[id]?.(out));
      (s as { human?: number }).human = human;
      sources[id] = s;
      return s;
    },
    lastActive: () => null,
  };
  return {
    reg, sources, subs,
    connect(d: DeviceInfo) { list = [...list, d]; for (const fn of subs) fn(list); },
  };
}

const dev = (id: string, kind: DeviceInfo['kind'] = 'pad'): DeviceInfo => ({ id, kind, label: id, family: 0, connected: true });
const state = { ctrl: [{ side: 0 }, { side: 1 }, { side: -1 }, { side: -1 }] } as unknown as ReadonlySimState;

describe('FND-04 local input provider', () => {
  it('samples every source of each human and merges them', () => {
    const r = registry([dev('touch', 'touch'), dev('keyboard', 'keyboard'), dev('pad:0')], {
      touch: (o) => { o.mx = 30; o.buttons = Btn.PASS; },
      keyboard: (o) => { o.mx = 127; o.buttons = Btn.SPRINT; },
      'pad:0': (o) => { o.az = -127; o.buttons = Btn.SHOOT; },
    });
    const p = createLocalInputProvider(
      [{ human: 0, deviceIds: ['touch', 'keyboard'] }, { human: 1, deviceIds: ['pad:0'] }],
      r.reg, () => state, () => null,
    );
    expect(p.ready(1)).toBe(true);
    expect(p.waiting).toBe(false);
    const frames = [createInputFrame(), createInputFrame()];
    frames[0]!.buttons = Btn.LOB; // stale data must be cleared
    p.take(12, frames, state);
    expect(frames[0]!.buttons).toBe(Btn.PASS | Btn.SPRINT);
    expect(frames[0]!.mx).toBe(127);
    expect(frames[1]!.buttons).toBe(Btn.SHOOT);
    expect(frames[1]!.az).toBe(-127);
    const ctx = r.sources['pad:0']!.calls[0]!;
    expect([ctx.tick, ctx.human, ctx.side]).toEqual([12, 1, 1]);
  });

  it('injects queued commands into the next frame', () => {
    const r = registry([dev('touch', 'touch')], {});
    const p = createLocalInputProvider([{ human: 0, deviceIds: ['touch'] }], r.reg, () => state, () => null);
    p.queueCommand(0, Command.SKIP, 0);
    const frames = [createInputFrame(), createInputFrame()];
    p.take(1, frames, state);
    expect(frames[0]!.cmd).toBe(Command.SKIP);
    expect(frames[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    p.take(2, frames, state);
    expect(frames[0]!.cmd).toBe(Command.NONE);
  });

  it('ANY_DEVICE binds devices present now and devices that connect later', () => {
    const r = registry([dev('touch', 'touch'), dev('pad:0')], { 'pad:1': (o) => { o.buttons = Btn.THROUGH; } });
    const p = createLocalInputProvider(
      [{ human: 0, deviceIds: ['touch', ANY_DEVICE] }, { human: 1, deviceIds: ['pad:0'] }],
      r.reg, () => state, () => null,
    );
    expect(p.sourceCount).toBe(2);
    expect((r.sources['pad:0'] as { human?: number }).human).toBe(1); // explicit binding wins over the wildcard
    r.connect(dev('pad:1'));
    expect(p.sourceCount).toBe(3);
    expect((r.sources['pad:1'] as { human?: number }).human).toBe(0);
    const frames = [createInputFrame(), createInputFrame()];
    p.take(1, frames, state);
    expect(frames[0]!.buttons).toBe(Btn.THROUGH);
    p.dispose();
    expect(r.subs.length).toBe(0);
  });

  it('pump polls sources; releaseAll and dispose reach every source', () => {
    const r = registry([dev('touch', 'touch'), dev('pad:0')], {});
    const p = createLocalInputProvider([{ human: 0, deviceIds: ['touch', 'pad:0'] }], r.reg, () => state, () => null);
    p.pump(123);
    expect(r.sources.touch!.pollFrame).toHaveBeenCalledWith(123);
    p.releaseAll();
    expect(r.sources.touch!.releaseAll).toHaveBeenCalledTimes(1);
    expect(r.sources['pad:0']!.releaseAll).toHaveBeenCalledTimes(1);
    p.dispose();
    p.dispose();
    expect(r.sources.touch!.dispose).toHaveBeenCalledTimes(1);
    expect(p.sourceCount).toBe(0);
  });

  it('reports a device that cannot create a source and keeps the others', () => {
    const r = registry([dev('touch', 'touch')], { touch: (o) => { o.buttons = Btn.PASS; } });
    const onError = vi.fn();
    const p = createLocalInputProvider([{ human: 0, deviceIds: ['broken', 'touch'] }], r.reg, () => state, () => null, { onError });
    expect(onError).toHaveBeenCalledTimes(1);
    const frames = [createInputFrame(), createInputFrame()];
    p.take(1, frames, state);
    expect(frames[0]!.buttons).toBe(Btn.PASS);
  });
});
