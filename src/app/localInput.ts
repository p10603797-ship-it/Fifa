/**
 * Local TickInputProvider: merges every InputSource bound to a human into one InputFrame per tick. [FND-04]
 *
 * Merge rules (mergeInputFrame): buttons OR; movement and aim each from the source with the larger magnitude;
 * power, curve, skill, command and gesture from the first source that sets them. Queued commands (tactics, subs,
 * skip) go into the human's next frame, one per tick; Command.SKIP also sets Btn.SKIP. Always ready (local input
 * never stalls). releaseAll() on pause, blur and visibility changes.
 *
 * Binding ANY_DEVICE ('*') to a human also binds devices that appear later (a pad shows up only after its first
 * button press), unless another human names that device explicitly.
 */
import type { DeviceRegistry, HumanBinding, TickInputProvider } from '../contracts/app';
import { MAX_HUMANS } from '../contracts/constants';
import { Command, GestureKind, SkillMove } from '../contracts/enums';
import {
  Btn, clearInputFrame, createInputFrame, type CameraProjector, type InputFrame, type InputSampleContext, type InputSource,
} from '../contracts/input';
import type { ReadonlySimState, SimState } from '../contracts/state';

/** Device id wildcard: bind every local device, including ones that connect during the match. */
export const ANY_DEVICE = '*';

export interface LocalInputProvider extends TickInputProvider {
  /** Queue a command into `human`'s next frame (one command per frame, FIFO). */
  queueCommand(human: number, cmd: Command, arg: number): void;
  /** Number of live input sources (tests, diagnostics). */
  readonly sourceCount: number;
}

export interface LocalInputOptions {
  onError?(err: unknown, where: string): void;
}

/** Merge `src` into `dst` (see module doc). Allocation-free. */
export function mergeInputFrame(dst: InputFrame, src: InputFrame): void {
  dst.buttons |= src.buttons;
  if (src.mx * src.mx + src.mz * src.mz > dst.mx * dst.mx + dst.mz * dst.mz) {
    dst.mx = src.mx;
    dst.mz = src.mz;
  }
  if (src.ax * src.ax + src.az * src.az > dst.ax * dst.ax + dst.az * dst.az) {
    dst.ax = src.ax;
    dst.az = src.az;
  }
  if (dst.power === 0 && src.power !== 0) dst.power = src.power;
  if (dst.curve === 0 && src.curve !== 0) dst.curve = src.curve;
  if (dst.skill === SkillMove.NONE && src.skill !== SkillMove.NONE) dst.skill = src.skill;
  if (dst.cmd === Command.NONE && src.cmd !== Command.NONE) {
    dst.cmd = src.cmd;
    dst.cmdArg = src.cmdArg;
  }
  if (dst.gesture === GestureKind.NONE && src.gesture !== GestureKind.NONE) {
    dst.gesture = src.gesture;
    dst.gx = src.gx;
    dst.gz = src.gz;
    dst.gSlot = src.gSlot;
    dst.gdx = src.gdx;
    dst.gdz = src.gdz;
    dst.gPower = src.gPower;
    dst.gCurve = src.gCurve;
    dst.gFlags = src.gFlags;
  }
}

export interface CommandQueue {
  push(human: number, cmd: Command, arg: number): void;
  /** Put at most one queued command into each human's frame whose cmd is still NONE. */
  applyTo(frames: InputFrame[]): void;
  clear(): void;
  size(human: number): number;
}

/** Fixed-capacity FIFO of commands per human (oldest dropped on overflow). Allocation-free after creation. */
export function createCommandQueue(capacity = 8): CommandQueue {
  const cmds: number[][] = [];
  const args: number[][] = [];
  const head: number[] = [];
  const count: number[] = [];
  for (let h = 0; h < MAX_HUMANS; h++) {
    cmds.push(new Array<number>(capacity).fill(0));
    args.push(new Array<number>(capacity).fill(0));
    head.push(0);
    count.push(0);
  }
  return {
    push(human, cmd, arg) {
      if (human < 0 || human >= MAX_HUMANS || cmd === Command.NONE) return;
      if (count[human]! >= capacity) {
        head[human] = (head[human]! + 1) % capacity;
        count[human]!--;
      }
      const i = (head[human]! + count[human]!) % capacity;
      cmds[human]![i] = cmd;
      args[human]![i] = arg;
      count[human]!++;
    },
    applyTo(frames) {
      for (let h = 0; h < MAX_HUMANS; h++) {
        const f = frames[h];
        if (!f || count[h] === 0 || f.cmd !== Command.NONE) continue;
        const i = head[h]!;
        f.cmd = cmds[h]![i]!;
        f.cmdArg = args[h]![i]!;
        if (f.cmd === Command.SKIP) f.buttons |= Btn.SKIP;
        head[h] = (i + 1) % capacity;
        count[h]!--;
      }
    },
    clear() {
      for (let h = 0; h < MAX_HUMANS; h++) {
        head[h] = 0;
        count[h] = 0;
      }
    },
    size: (human) => count[human] ?? 0,
  };
}

interface MutableSampleContext {
  tick: number;
  human: number;
  side: number;
  state: SimState;
  projector: CameraProjector | null;
}

export function createLocalInputProvider(
  bindings: readonly HumanBinding[],
  devices: DeviceRegistry,
  getState: () => ReadonlySimState | null,
  getProjector: () => CameraProjector | null,
  opts: LocalInputOptions = {},
): LocalInputProvider {
  const perHuman: InputSource[][] = [];
  for (let h = 0; h < MAX_HUMANS; h++) perHuman.push([]);
  const byDevice = new Map<string, InputSource>();
  const explicit = new Map<string, number>();
  let wildcardHuman = -1;
  const scratch = createInputFrame();
  const queue = createCommandQueue();
  let disposed = false;
  const sampleCtx: MutableSampleContext = { tick: 0, human: 0, side: -1, state: null as unknown as SimState, projector: null };

  const report = (err: unknown, where: string): void => {
    opts.onError?.(err, where);
  };

  for (const b of bindings) {
    if (b.human < 0 || b.human >= MAX_HUMANS) continue;
    for (const id of b.deviceIds) {
      if (id === ANY_DEVICE) {
        if (wildcardHuman < 0) wildcardHuman = b.human;
      } else if (!explicit.has(id)) {
        explicit.set(id, b.human);
      }
    }
  }

  function bind(deviceId: string, human: number): void {
    if (disposed || byDevice.has(deviceId)) return;
    try {
      const src = devices.createSource(deviceId, human);
      byDevice.set(deviceId, src);
      perHuman[human]!.push(src);
    } catch (err) {
      report(err, `createSource ${deviceId}`);
    }
  }

  for (const [id, human] of explicit) bind(id, human);

  function bindNew(): void {
    if (wildcardHuman < 0) return;
    for (const d of devices.list()) {
      if (!d.connected || explicit.has(d.id) || byDevice.has(d.id)) continue;
      bind(d.id, wildcardHuman);
    }
  }
  bindNew();
  const unsubscribe = wildcardHuman >= 0 ? devices.subscribe(() => bindNew()) : null;

  return {
    get waiting() {
      return false;
    },
    get sourceCount() {
      return byDevice.size;
    },
    ready: () => true,
    take(tick, frames, state) {
      sampleCtx.tick = tick;
      sampleCtx.state = state as unknown as SimState;
      sampleCtx.projector = getProjector();
      for (let h = 0; h < MAX_HUMANS; h++) {
        const out = frames[h];
        if (!out) continue;
        clearInputFrame(out);
        const list = perHuman[h]!;
        if (list.length === 0) continue;
        sampleCtx.human = h;
        const ctrl = state.ctrl[h];
        sampleCtx.side = ctrl ? ctrl.side : -1;
        for (let i = 0; i < list.length; i++) {
          clearInputFrame(scratch);
          list[i]!.sample(scratch, sampleCtx as InputSampleContext);
          mergeInputFrame(out, scratch);
        }
      }
      queue.applyTo(frames);
    },
    pump(nowMs) {
      for (let h = 0; h < MAX_HUMANS; h++) {
        const list = perHuman[h]!;
        for (let i = 0; i < list.length; i++) {
          const s = list[i]!;
          if (s.pollFrame) s.pollFrame(nowMs);
        }
      }
    },
    queueCommand(human, cmd, arg) {
      queue.push(human, cmd, arg);
    },
    releaseAll() {
      for (const s of byDevice.values()) {
        try {
          s.releaseAll();
        } catch (err) {
          report(err, 'releaseAll');
        }
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      for (const s of byDevice.values()) {
        try {
          s.dispose();
        } catch (err) {
          report(err, 'dispose source');
        }
      }
      byDevice.clear();
      for (const list of perHuman) list.length = 0;
      queue.clear();
      void getState;
    },
  };
}
