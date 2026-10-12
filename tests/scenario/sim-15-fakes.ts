/**
 * SIM-15 test fakes: recording starters and idle action handlers, installed with vi.mock in the sim-15 scenario
 * tests so the real step() pipeline runs while every action start the resolver requests is observable and
 * deterministic, independent of the state of the starter modules (SIM-08..14, GKP-03/05, TAI-02/03/14, RUL-*).
 * Imports contracts only (it is loaded from inside vi.mock factories, before the sim modules).
 *
 * Usage in a test file:
 *   vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./sim-15-fakes')).mockPass(await o()));
 */
import { ActionKind } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import type { InputFrame } from '../../src/contracts/input';
import type { PlayerState, SimState } from '../../src/contracts/state';
import type { ActionHandler, ActionRequest } from '../../src/contracts/systems';

export interface Call {
  fn: string;
  slot: number;
  kind: number;
  flags: number;
  power: number;
  charging: number;
  dirX: number;
  dirZ: number;
  targetSlot: number;
  hasTarget: number;
  targetX: number;
  targetZ: number;
  curve: number;
  assist: number;
  tick: number;
  ok: number;
  /** Extra argument (team, command, ctrl index, ...). */
  arg: number;
  arg2: number;
}

export const CALLS: Call[] = [];

/** Behaviour switches for the fakes (reset by resetFakes). */
export const FAKE = {
  /** Starters accept when the player is free (else refuse everything). */
  accept: true,
  /** aerialChance return value. */
  aerial: 0,
  /** canHandle return value. */
  canHandle: true,
  /** Record calls (off for allocation measurements). */
  log: true,
  /** Buttons the mocked CPU carrier / defender brain writes into its frame. */
  cpuButtons: 0,
};

export function resetFakes(): void {
  CALLS.length = 0;
  FAKE.accept = true;
  FAKE.aerial = 0;
  FAKE.canHandle = true;
  FAKE.log = true;
  FAKE.cpuButtons = 0;
}

export const idle: ActionHandler = { update() { /* idle */ }, end() { /* idle */ } };

function free(p: PlayerState): boolean {
  return p.active === 1 && p.act === ActionKind.NONE && p.stunT <= 0;
}

function begin(p: PlayerState, kind: ActionKind, dur: number, contact: number): void {
  p.act = kind; p.actT = 0; p.actDur = dur; p.actContact = contact; p.actDone = 0; p.actCharging = 0;
}

function log(fn: string, s: SimState, slot: number, kind: number, req: ActionRequest | null, ok: number, arg = 0, arg2 = 0): void {
  if (!FAKE.log) return;
  CALLS.push({
    fn, slot, kind, ok, arg, arg2, tick: s.tick,
    flags: req ? req.flags : 0, power: req ? req.power : 0, charging: req ? req.charging : 0,
    dirX: req ? req.dirX : 0, dirZ: req ? req.dirZ : 0, targetSlot: req ? req.targetSlot : -1,
    hasTarget: req ? req.hasTarget : 0, targetX: req ? req.targetX : 0, targetZ: req ? req.targetZ : 0,
    curve: req ? req.curve : 0, assist: req ? req.assist : 0,
  });
}

/** Kick-type starter: free player with the ball (or FIRST_TIME / GESTURE requests) starts `act`. */
function kickStarter(fn: string, act: ActionKind) {
  return (s: SimState, slot: number, kind: number, req: ActionRequest, _ev: EventSink): number => {
    const p = s.players[slot]!;
    const ok = FAKE.accept && free(p) ? 1 : 0;
    if (ok) {
      begin(p, act, 19, 8);
      p.actKick = kind;
      p.actPower = req.power;
      p.actCharging = req.charging;
    }
    log(fn, s, slot, kind, req, ok);
    return ok;
  };
}

/** The calls of one starter (accepted only by default). */
export function calls(fn: string, okOnly = true): Call[] {
  return CALLS.filter((c) => c.fn === fn && (!okOnly || c.ok === 1));
}

/** Accepted calls by any of the kick starters, in order. */
export function starts(slot?: number): Call[] {
  return CALLS.filter((c) => c.ok === 1 && (slot === undefined || c.slot === slot));
}

// ---------------------------------------------------------------- module factories

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

export function mockShot(o: Mod, withMarkLowDriven = true): Mod {
  const m: Mod = { ...o, startShot: kickStarter('startShot', ActionKind.SHOT), shotHandler: idle };
  if (withMarkLowDriven) {
    m.markLowDriven = (s: SimState, slot: number): void => {
      const p = s.players[slot]!;
      log('markLowDriven', s, slot, p.actKick, null, 1);
    };
  } else {
    delete m.markLowDriven;
  }
  return m;
}

export function mockAerial(o: Mod): Mod {
  return {
    ...o,
    startHeader: kickStarter('startHeader', ActionKind.HEADER),
    startVolley: kickStarter('startVolley', ActionKind.VOLLEY),
    aerialChance: (): number => FAKE.aerial,
    aerialContacts: (): void => { /* isolated */ },
    headerHandler: idle,
    volleyHandler: idle,
  };
}

export function mockSkills(o: Mod): Mod {
  return {
    ...o,
    startSkill: (s: SimState, slot: number, skill: number, dx: number, dz: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = FAKE.accept && free(p) && s.ball.owner === slot ? 1 : 0;
      if (ok) { begin(p, ActionKind.SKILL, 12, -1); p.actSkill = skill; }
      log('startSkill', s, slot, skill, null, ok, dx, dz);
      return ok;
    },
    startFake: (s: SimState, slot: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = (p.act === ActionKind.SHOT || p.act === ActionKind.KICK) && p.actDone === 0 ? 1 : 0;
      if (ok) begin(p, ActionKind.FAKE, 10, -1);
      log('startFake', s, slot, p.actKick, null, ok);
      return ok;
    },
    skillHandler: idle,
    fakeHandler: idle,
  };
}

export function mockTackle(o: Mod, withQuickGetUp = true): Mod {
  const m: Mod = {
    ...o,
    startTackle: (s: SimState, slot: number, kind: ActionKind, target: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = FAKE.accept && free(p) ? 1 : 0;
      if (ok) begin(p, kind, kind === ActionKind.SLIDE_TACKLE ? 60 : 24, 6);
      log('startTackle', s, slot, kind, null, ok, target);
      return ok;
    },
    startClearance: kickStarter('startClearance', ActionKind.KICK),
    tackleContacts: (): void => { /* isolated */ },
    interceptContacts: (): void => { /* isolated */ },
    standTackleHandler: idle, hardTackleHandler: idle, slideTackleHandler: idle, shoulderHandler: idle,
    pushPullHandler: idle, stumbleHandler: idle, fallenHandler: idle, getUpHandler: idle,
  };
  if (withQuickGetUp) {
    m.quickGetUp = (s: SimState, slot: number): void => { log('quickGetUp', s, slot, s.players[slot]!.act, null, 1); };
  } else {
    delete m.quickGetUp;
  }
  return m;
}

export function mockSweeper(o: Mod): Mod {
  return {
    ...o,
    startKeeperRush: (s: SimState, slot: number, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = FAKE.accept && free(p) ? 1 : 0;
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
    canHandle: (): boolean => FAKE.canHandle,
    keeperPickUp: (s: SimState, slot: number, _ev: EventSink): void => {
      const p = s.players[slot]!;
      s.ball.owner = slot; s.ball.heldBy = slot;
      begin(p, ActionKind.GK_HOLD, 600, -1);
      log('keeperPickUp', s, slot, 0, null, 1);
    },
    startKeeperRelease: (s: SimState, slot: number, kind: number, req: ActionRequest, _ev: EventSink): number => {
      const p = s.players[slot]!;
      const ok = FAKE.accept && p.active === 1 && (p.act === ActionKind.NONE || p.act === ActionKind.GK_HOLD) ? 1 : 0;
      if (ok) {
        begin(p, kind === 28 || kind === 29 || kind === 30 ? ActionKind.GK_THROW : ActionKind.GK_KICK, 24, 10);
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
export function mockTactics(o: Mod): Mod {
  return {
    ...o,
    applyCommand: (s: SimState, team: number, cmd: number, arg: number): void => { log('applyCommand', s, -1, cmd, null, 1, team, arg); },
  };
}
export function mockSubs(o: Mod): Mod {
  return {
    ...o,
    requestSub: (s: SimState, team: number, out: number, inR: number): number => { log('requestSub', s, out, team, null, 1, inR); return 1; },
  };
}

function setPieceLogger(kind: number) {
  return (s: SimState, c: number, f: InputFrame, _ev: EventSink): void => { log('setPieceInput', s, -1, kind, null, 1, c, f.buttons); };
}
export function mockRestart(o: Mod): Mod {
  return { ...o, SETPIECE_INPUT: [null, setPieceLogger(1), setPieceLogger(2), setPieceLogger(3), setPieceLogger(4), setPieceLogger(5), setPieceLogger(6)] };
}
export function mockShootout(o: Mod): Mod {
  return { ...o, shootoutInput: (s: SimState, c: number, f: InputFrame): void => { log('shootoutInput', s, -1, 0, null, 1, c, f.buttons); } };
}

export function mockCpuCarrier(o: Mod): Mod {
  return { ...o, cpuCarrier: (_s: SimState, _team: number, out: InputFrame): void => { out.buttons = FAKE.cpuButtons; } };
}
export function mockCpuDefending(o: Mod): Mod {
  return { ...o, cpuDefend: (_s: SimState, _team: number, out: InputFrame): void => { out.buttons = FAKE.cpuButtons; } };
}
