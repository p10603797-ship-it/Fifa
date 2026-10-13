/**
 * PAD-02 test wrappers for the kick starters, installed with vi.mock in the pad-02 row tests. Each wrapper calls the
 * REAL starter first and records the resolver's request (kind, ReqFlag flags, power, charging, direction). Starters
 * that are still Wave-0 stubs (SIM-08 pass, SIM-09 lob, SIM-10 through, SIM-11 shot: they return 0) fall back to a
 * minimal action start (p.act / p.actKick / p.actPower / p.actCharging) so the pipeline continues exactly as the
 * resolver intends; as soon as a real starter accepts, its own action is kept. Imports contracts only (it is loaded
 * from inside vi.mock factories, before the sim modules).
 *
 *   vi.mock('../../src/sim/kicks/pass', async (o) => (await import('./pad-02-fakes')).wrapPass(await o()));
 */
import { ActionKind } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import type { ActionRequest } from '../../src/contracts/systems';

export interface StartCall {
  fn: string;
  slot: number;
  kind: number;
  flags: number;
  power: number;
  charging: number;
  dirX: number;
  dirZ: number;
  tick: number;
  /** What the real starter returned. */
  real: number;
  /** What the resolver got back (real, or 1 from the stub fallback). */
  ok: number;
}

export const STARTS: StartCall[] = [];

/** Fallback for stub starters (true = start the action when the real starter returns 0). */
export const WRAP = { fallback: true };

export function resetStarts(): void {
  STARTS.length = 0;
  WRAP.fallback = true;
}

type Mod = Record<string, unknown>;
type KickStarter = (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => number;

/** Fallback action length / contact tick (ticks): long enough for the double-tap and fake windows. */
const FALLBACK_DUR = 24;
const FALLBACK_CONTACT = 10;

function wrapKick(fn: string, real: KickStarter, act: ActionKind): KickStarter {
  return (s, slot, kind, req, ev) => {
    const p = s.players[slot]!;
    const free = p.active === 1 && p.act === ActionKind.NONE && p.stunT <= 0;
    const r = real(s, slot, kind, req, ev);
    let ok = r;
    if (r !== 1 && WRAP.fallback && free) {
      p.act = act; p.actT = 0; p.actDur = FALLBACK_DUR; p.actContact = FALLBACK_CONTACT; p.actDone = 0;
      p.actKick = kind; p.actPower = req.power; p.actCharging = req.charging;
      ok = 1;
    }
    STARTS.push({
      fn, slot, kind, flags: req.flags, power: req.power, charging: req.charging, dirX: req.dirX, dirZ: req.dirZ,
      tick: s.tick, real: r, ok,
    });
    return ok;
  };
}

export function wrapPass(o: Mod): Mod {
  return { ...o, startPass: wrapKick('startPass', o.startPass as KickStarter, ActionKind.KICK) };
}
export function wrapLob(o: Mod): Mod {
  return { ...o, startLob: wrapKick('startLob', o.startLob as KickStarter, ActionKind.KICK) };
}
export function wrapThrough(o: Mod): Mod {
  return { ...o, startThrough: wrapKick('startThrough', o.startThrough as KickStarter, ActionKind.KICK) };
}

/** startShot wrapped; markLowDriven (SIM-11, optional export) is recorded when the real module has it. */
export function wrapShot(o: Mod): Mod {
  const m: Mod = { ...o, startShot: wrapKick('startShot', o.startShot as KickStarter, ActionKind.SHOT) };
  if (typeof o.markLowDriven === 'function') {
    const real = o.markLowDriven as (s: SimState, slot: number) => unknown;
    m.markLowDriven = (s: SimState, slot: number): unknown => {
      const p = s.players[slot]!;
      STARTS.push({
        fn: 'markLowDriven', slot, kind: p.actKick, flags: 0, power: p.actPower, charging: p.actCharging, dirX: 0, dirZ: 0,
        tick: s.tick, real: 1, ok: 1,
      });
      return real(s, slot);
    };
  }
  return m;
}

/** Calls of one starter (accepted only by default). */
export function startsOf(fn: string, okOnly = true): StartCall[] {
  return STARTS.filter((c) => c.fn === fn && (!okOnly || c.ok === 1));
}
