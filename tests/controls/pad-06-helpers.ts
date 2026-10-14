/**
 * PAD-06 test helpers: set-piece scenes (a restart awarded through RUL-11 awardRestart and run until restart.ready,
 * CPU brains off so only the pad acts) and small readers for what a pad press started (the first KICK event).
 */
import { ControllerKind, MatchPhase, type RestartKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createEventBuffer } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario, runTicks } from '../harness/scenario';
import { PadButton as PB, type PadMatch } from './pad-02-helpers';

/** Standard positions by their PlayStation names (section 10 tables). */
export const PadButton = { ...PB, CROSS: PB.SOUTH, CIRCLE: PB.EAST, SQUARE: PB.WEST, TRIANGLE: PB.NORTH } as const;

export interface SetPieceOptions {
  /** Side P1 (ctrl[0]) plays for. Default: the restart's team (P1 takes it). */
  humanSide?: number;
  seed?: number;
}

/** Award `kind` to `team` at (x, z), CPU brains off, run neutral ticks until restart.ready. */
export function setPieceScene(kind: RestartKind, team: number, x: number, z: number, o: SetPieceOptions = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: o.humanSide ?? team }], seed: o.seed ?? 7 });
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE;
    ctl.side = -1;
    ctl.slot = -1;
    s.teams[c - 2]!.cpu.active = 0;
  }
  const ev = createEventBuffer();
  ev.begin(s.tick);
  awardRestart(s, kind, team, x, z, ev);
  for (let i = 0; i < 400 && s.match.restart.ready !== 1; i++) runTicks(s, 1);
  if (s.match.restart.ready !== 1) throw new Error(`restart ${kind} never got ready`);
  return s;
}

/** The first KICK event of the match so far (a = slot, b = KickKind), or null. */
export function firstKick(m: PadMatch): SimEvent | null {
  return m.events.find((e) => e.type === EventType.KICK) ?? null;
}

/** WALL events (a = member slot). */
export function wallEvents(m: PadMatch): SimEvent[] {
  return m.events.filter((e) => e.type === EventType.WALL);
}
