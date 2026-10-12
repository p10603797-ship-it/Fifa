/**
 * SIM-15 scenario helpers: a controlled player in a quiet scene (other players parked away from the action, the
 * opposing CPU brain off unless asked), and a scripted input runner on the real step() pipeline.
 */
import { AutoSwitch, AssistLevel, ControllerKind, MatchPhase } from '../../src/contracts/enums';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import { makeScenario } from '../harness/scenario';

export interface SceneOpts {
  /** Controlled slot of P1 (side 0). Default 9. */
  slot?: number;
  x?: number;
  z?: number;
  vx?: number;
  vz?: number;
  /** 'feet' = P1's player owns the ball at his feet (default), 'loose' = ball loose at ballX/Z, 'none' = parked. */
  ball?: 'feet' | 'loose' | 'none';
  assist?: AssistLevel;
  autoSwitch?: AutoSwitch;
  fastPower?: number;
  /** Keep the away CPU brain (default off). */
  cpu?: boolean;
  /** Second human on side 1 (P2). */
  p2Slot?: number;
  phase?: MatchPhase;
  seed?: number;
}

/** Build a quiet IN_PLAY scene with P1 controlling `slot`. */
export function scene(o: SceneOpts = {}): SimState {
  const slot = o.slot ?? 9;
  const humans: { side: number; slot: number; assist?: AssistLevel; autoSwitch?: AutoSwitch; fastPower?: number }[] = [
    { side: 0, slot, assist: o.assist ?? AssistLevel.ASSISTED, autoSwitch: o.autoSwitch ?? AutoSwitch.OFF, fastPower: o.fastPower ?? 0 },
  ];
  if (o.p2Slot !== undefined) humans.push({ side: 1, slot: o.p2Slot, autoSwitch: AutoSwitch.OFF });
  const s = makeScenario({ phase: o.phase ?? MatchPhase.IN_PLAY, humans, seed: o.seed ?? 7 });
  if (!o.cpu && o.p2Slot === undefined) {
    const c3 = s.ctrl[3]!;
    if (c3.slot >= 0 && s.players[c3.slot]!.ctrl === 3) s.players[c3.slot]!.ctrl = -1;
    c3.kind = ControllerKind.NONE;
    c3.side = -1;
    c3.slot = -1;
    s.teams[1]!.cpu.active = 0;
  }
  // Park everyone else away from the centre of the action (keepers at their goals).
  for (let i = 0; i < 22; i++) {
    if (i === slot) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1;
    const k = i % 11;
    if (k === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; } else { p.x = team === 0 ? -44 : 44; p.z = -30 + k * 5.5; }
    p.vx = 0; p.vz = 0; p.fx = team === 0 ? 1 : -1; p.fz = 0;
  }
  const p = s.players[slot]!;
  p.x = o.x ?? 10; p.z = o.z ?? 0; p.vx = o.vx ?? 0; p.vz = o.vz ?? 0; p.fx = 1; p.fz = 0;
  const b = s.ball;
  const mode = o.ball ?? 'feet';
  if (mode === 'feet') {
    b.x = p.x + 0.5; b.z = p.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
    b.owner = slot; b.heldBy = -1; b.lastTouch = slot; b.lastTouchTeam = p.team; b.lastTouchTick = 0;
  } else if (mode === 'none') {
    b.owner = -1; b.heldBy = -1;
  }
  return s;
}

export type Script = (i: number, s: SimState, f: InputFrame, f2: InputFrame) => Partial<InputFrame> | void;

/** Run n ticks of the real pipeline; script(i = 1..n) returns P1's frame fields (and may edit P2's frame / state). */
export function run(s: SimState, n: number, script?: Script): void {
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  for (let i = 1; i <= n; i++) {
    const f = createInputFrame();
    const f2 = createInputFrame();
    const r = script ? script(i, s, f, f2) : undefined;
    if (r) Object.assign(f, r);
    frames[0] = f;
    frames[1] = f2;
    step(s, frames, ev);
  }
}

/** Keep P1's ball at the feet of `slot` (scaffolding for stubs of the dribble module). */
export function keepBall(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  b.x = p.x + 0.5; b.z = p.z; b.y = 0.11; b.vx = p.vx; b.vz = p.vz; b.vy = 0; b.px = b.x; b.pz = b.z; b.py = b.y;
  b.owner = slot; b.heldBy = -1;
}
