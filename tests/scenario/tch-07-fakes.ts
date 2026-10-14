/**
 * TCH-07 test fakes (adapted from the SIM-15 scenario fakes): recording starters and idle action handlers, installed
 * with vi.mock in tests/scenario/tch-07-touch-sim.test.ts, so the real step() pipeline (SIM-15 resolution, switching,
 * dispatch) runs on the mapper's frames while every action start the resolver requests is observable, independent
 * of how far the starter modules (SIM-08..14, GKP-03/05, TAI-02/03) are. Imports contracts only (loaded from inside
 * vi.mock factories, before the sim modules).
 */
import { ActionKind, KickKind } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import type { PlayerState, SimState } from '../../src/contracts/state';
import type { ActionHandler, ActionRequest } from '../../src/contracts/systems';

export interface Call {
  fn: string;
  slot: number;
  kind: number;
  flags: number;
  power: number;
  charging: number;
  tick: number;
  ok: number;
  arg: number;
}

export const CALLS: Call[] = [];

export function resetFakes(): void {
  CALLS.length = 0;
}

const idle: ActionHandler = { update() { /* idle */ }, end() { /* idle */ } };

function free(p: PlayerState): boolean {
  return p.active === 1 && p.act === ActionKind.NONE && p.stunT <= 0;
}

function begin(p: PlayerState, kind: ActionKind, dur: number, contact: number): void {
  p.act = kind; p.actT = 0; p.actDur = dur; p.actContact = contact; p.actDone = 0; p.actCharging = 0;
}

function log(fn: string, s: SimState, slot: number, kind: number, req: ActionRequest | null, ok: number, arg = 0): void {
  CALLS.push({ fn, slot, kind, ok, arg, tick: s.tick, flags: req ? req.flags : 0, power: req ? req.power : 0, charging: req ? req.charging : 0 });
}

function kickStarter(fn: string, act: ActionKind) {
  return (s: SimState, slot: number, kind: number, req: ActionRequest, _ev: EventSink): number => {
    const p = s.players[slot]!;
    const ok = free(p) ? 1 : 0;
    if (ok) {
      begin(p, act, 30, 20);
      p.actKick = kind;
      p.actPower = req.power;
      p.actCharging = req.charging;
    }
    log(fn, s, slot, kind, req, ok);
    return ok;
  };
}

/** Accepted calls of one starter. */
export function calls(fn: string): Call[] {
  return CALLS.filter((c) => c.fn === fn && c.ok === 1);
}

/** Accepted starts of any starter (excluding taps / runs), in order. */
export function starts(): Call[] {
  return CALLS.filter((c) => c.ok === 1);
}

type Mod = Record<string, unknown>;

export function mockPass(o: Mod): Mod {
  return { ...o, startPass: kickStarter('startPass', ActionKind.KICK), kickHandler: idle };
}
export function mockLob(o: Mod): Mod {
  return { ...o, startLob: kickStarter('startLob', ActionKind.KICK) };
}
export function mockThrough(o: Mod): Mod {
  return { ...o, startThrough: kickStarter('startThrough', ActionKind.KICK) };
}
export function mockShot(o: Mod): Mod {
  return {
    ...o,
    startShot: kickStarter('startShot', ActionKind.SHOT),
    shotHandler: idle,
    markLowDriven: (s: SimState, slot: number): void => { log('markLowDriven', s, slot, s.players[slot]!.actKick, null, 1); },
  };
}
export function mockAerial(o: Mod): Mod {
  return {
    ...o,
    startHeader: kickStarter('startHeader', ActionKind.HEADER),
    startVolley: kickStarter('startVolley', ActionKind.VOLLEY),
    aerialChance: (): number => 0,
    aerialContacts: (): void => { /* isolated */ },
    headerHandler: idle,
    volleyHandler: idle,
  };
}
export function mockSkills(o: Mod): Mod {
  return {
    ...o,
    startSkill: (s: SimState, slot: number, skill: number, _dx: number, _dz: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = free(p) && s.ball.owner === slot ? 1 : 0;
      if (ok) { begin(p, ActionKind.SKILL, 12, -1); p.actSkill = skill; }
      log('startSkill', s, slot, skill, null, ok);
      return ok;
    },
    startFake: (s: SimState, slot: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = (p.act === ActionKind.SHOT || p.act === ActionKind.KICK) && p.actDone === 0 ? 1 : 0;
      const kind = p.actKick;
      if (ok) begin(p, ActionKind.FAKE, 10, -1);
      log('startFake', s, slot, kind, null, ok);
      return ok;
    },
    skillHandler: idle,
    fakeHandler: idle,
  };
}
export function mockTackle(o: Mod): Mod {
  return {
    ...o,
    startTackle: (s: SimState, slot: number, kind: ActionKind, target: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = free(p) ? 1 : 0;
      if (ok) begin(p, kind, kind === ActionKind.SLIDE_TACKLE ? 60 : 24, 6);
      log('startTackle', s, slot, kind, null, ok, target);
      return ok;
    },
    startClearance: kickStarter('startClearance', ActionKind.KICK),
    tackleContacts: (): void => { /* isolated */ },
    interceptContacts: (): void => { /* isolated */ },
    quickGetUp: (s: SimState, slot: number): void => { log('quickGetUp', s, slot, s.players[slot]!.act, null, 1); },
    standTackleHandler: idle, hardTackleHandler: idle, slideTackleHandler: idle, shoulderHandler: idle,
    pushPullHandler: idle, stumbleHandler: idle, fallenHandler: idle, getUpHandler: idle,
  };
}
export function mockSweeper(o: Mod): Mod {
  return {
    ...o,
    startKeeperRush: (s: SimState, slot: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = free(p) ? 1 : 0;
      if (ok) begin(p, ActionKind.GK_RUSH, 30, -1);
      log('startKeeperRush', s, slot, 0, null, ok);
      return ok;
    },
    keeperComeOut: (): void => { /* isolated */ },
    rushHandler: idle,
  };
}
export function mockHandling(o: Mod): Mod {
  return {
    ...o,
    canHandle: (): boolean => true,
    keeperPickUp: (s: SimState, slot: number, _ev: EventSink): void => {
      s.ball.owner = slot; s.ball.heldBy = slot;
      begin(s.players[slot]!, ActionKind.GK_HOLD, 600, -1);
      log('keeperPickUp', s, slot, 0, null, 1);
    },
    startKeeperRelease: (s: SimState, slot: number, kind: number, req: ActionRequest, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = p.active === 1 && (p.act === ActionKind.NONE || p.act === ActionKind.GK_HOLD) ? 1 : 0;
      if (ok) {
        const thr = kind === KickKind.GK_THROW || kind === KickKind.GK_DRIVEN_THROW;
        begin(p, thr ? ActionKind.GK_THROW : ActionKind.GK_KICK, 24, 10);
        p.actKick = kind; p.actPower = req.power; p.actCharging = req.charging;
      }
      log('startKeeperRelease', s, slot, kind, req, ok);
      return ok;
    },
    holdHandler: idle, throwHandler: idle, gkKickHandler: idle,
  };
}
export function mockRuns(o: Mod): Mod {
  return { ...o, triggerRun: (s: SimState, team: number): void => { log('triggerRun', s, -1, 0, null, 1, team); } };
}
export function mockSupport(o: Mod): Mod {
  return { ...o, callSupport: (s: SimState, team: number): void => { log('callSupport', s, -1, 0, null, 1, team); } };
}
