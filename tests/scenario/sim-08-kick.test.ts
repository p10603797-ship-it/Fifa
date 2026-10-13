/**
 * [SIM-08] The generic KICK action (wind-up, charging, contact, recovery, whiffs, movement) driven through the real
 * action dispatcher, pass and go, and passes through the full pipeline (human PASS presses, kick-off, determinism).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { T_PASS, T_PLAYER } from '../../src/contracts/tuning';
import { actionsTick, beginAction } from '../../src/sim/actions/dispatch';
import { ballStepTick } from '../../src/sim/ball/contact';
import { cloneState } from '../../src/sim/core/clone';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { INVARIANT_LIMITS } from '../../src/sim/debug/invariants';
import { LOCAL_TUNING as LT, startPass } from '../../src/sim/kicks/pass';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';
import { giveBall, MATE_A, MATE_B, OPP_A, PASSER, place, quiet, req, skill, type ReqOpts } from '../unit/sim-08-helpers';

const REC = T_PASS.contact + T_PASS.recovery;
const W = T_PASS.windup;

interface Step {
  /** actionsTick call index (1 = the tick the action started). */
  t: number;
  events: SimEvent[];
}

/**
 * Advance the action stage only (no locomotion / contacts): `before(t, s)` runs ahead of each actionsTick (the
 * resolver's slot in the pipeline); `ballPhysics` also steps the ball after it. Returns the events per call.
 */
function actTicks(s: SimState, n: number, before?: (t: number, s: SimState) => void, ballPhysics = false): Step[] {
  const ev = createEventBuffer();
  const out: Step[] = [];
  for (let t = 1; t <= n; t++) {
    s.tick++;
    ev.begin(s.tick);
    if (before) before(t, s);
    actionsTick(s, ev);
    if (ballPhysics) ballStepTick(s.ball, null);
    const events = ev.toArray();
    out.push({ t, events });
    const p = s.players[PASSER]!;
    if (p.act !== ActionKind.NONE && p.actCharging === 0) {
      expect(p.actT).toBeLessThanOrEqual(p.actDur + INVARIANT_LIMITS.actionSlackTicks);
    }
  }
  return out;
}

function kickTicks(steps: Step[], slot = PASSER): number[] {
  const r: number[] = [];
  for (const st of steps) for (const e of st.events) if (e.type === EventType.KICK && e.a === slot) r.push(st.t);
  return r;
}

function kickEvent(steps: Step[]): SimEvent | undefined {
  for (const st of steps) for (const e of st.events) if (e.type === EventType.KICK) return e;
  return undefined;
}

function startAt(s: SimState, kind: KickKind = KickKind.GROUND_PASS, o: ReqOpts = {}): void {
  expect(startPass(s, PASSER, kind, req({ power: 0.5, targetSlot: MATE_A, ...o }), NULL_SINK)).toBe(1);
}

function scene(): SimState {
  const s = quiet();
  place(s, MATE_A, 15, 2);
  return s;
}

// ---------------------------------------------------------------- timing

describe('SIM-08 KICK action timing', () => {
  it('contacts at the wind-up tick, recovers, then frees the player', () => {
    const s = scene();
    startAt(s);
    const p = s.players[PASSER]!;
    const steps = actTicks(s, W + REC + 3, (t) => {
      if (t < W) expect(s.ball.owner).toBe(PASSER);
    });
    expect(kickTicks(steps)).toEqual([W]);
    const e = kickEvent(steps)!;
    expect(e.b).toBe(KickKind.GROUND_PASS);
    expect(e.c).toBe(0.5);
    expect(s.ball.lastKickBy).toBe(PASSER);
    expect(s.ball.owner).toBe(-1);
    expect(s.ball.passTarget).toBe(MATE_A);
    expect(Math.hypot(s.ball.vx, s.ball.vz)).toBeGreaterThanOrEqual(T_PASS.groundMin);
    expect(p.act).toBe(ActionKind.NONE);
    // The action ended exactly contact + recovery after it started.
    const s2 = scene();
    startAt(s2);
    actTicks(s2, W + REC - 1);
    expect(s2.players[PASSER]!.act).toBe(ActionKind.KICK);
    expect(s2.players[PASSER]!.actDone).toBe(1);
    expect(s2.players[PASSER]!.actContact).toBe(W);
    actTicks(s2, 1);
    expect(s2.players[PASSER]!.act).toBe(ActionKind.NONE);
  });

  it('charging holds the contact until release, with the power reached at release', () => {
    const s = scene();
    startAt(s, KickKind.GROUND_PASS, { power: 0.02, charging: 1 });
    const p = s.players[PASSER]!;
    const release = 25;
    const steps = actTicks(s, release + REC + 2, (t) => {
      if (p.act !== ActionKind.KICK || p.actDone === 1) return;
      p.actPower = Math.min(1, t / T_PASS.powerFillTicks); // the resolver's power bar
      if (t === release) p.actCharging = 0;
    });
    expect(kickTicks(steps)).toEqual([release]);
    expect(kickEvent(steps)!.c).toBeCloseTo(release / T_PASS.powerFillTicks, 12);
    const s2 = scene();
    startAt(s2, KickKind.GROUND_PASS, { charging: 1 });
    actTicks(s2, release - 1);
    const q = s2.players[PASSER]!;
    expect(q.actDone).toBe(0);
    expect(s2.ball.owner).toBe(PASSER);
    q.actCharging = 0;
    actTicks(s2, 1);
    expect(q.actDone).toBe(1);
    expect(q.actContact).toBe(release);
    expect(q.actDur).toBe(release + REC);
  });

  it('a charge released during the wind-up still contacts at the wind-up tick', () => {
    const s = scene();
    startAt(s, KickKind.GROUND_PASS, { charging: 1 });
    const steps = actTicks(s, W + 2, (t, st) => { if (t === 3) st.players[PASSER]!.actCharging = 0; });
    expect(kickTicks(steps)).toEqual([W]);
  });

  it('glitch: power bar stuck full - a charge that is never released kicks at the cap and the action ends', () => {
    const s = scene();
    startAt(s, KickKind.GROUND_PASS, { charging: 1, power: 1 });
    const p = s.players[PASSER]!;
    const cap = W + T_PASS.powerFillTicks + LT.chargeWaitExtraTicks;
    let charged = 0;
    const steps = actTicks(s, cap + REC + 2, () => { if (p.actCharging === 1) charged++; });
    expect(kickTicks(steps)).toEqual([cap]);
    expect(charged).toBeLessThan(INVARIANT_LIMITS.maxChargeTicks);
    expect(p.act).toBe(ActionKind.NONE);
    expect(p.actCharging).toBe(0);
  });
});

// ---------------------------------------------------------------- whiffs

describe('SIM-08 KICK whiffs', () => {
  it('tackled away during the wind-up: whiff at once, the ball untouched, recovery after it', () => {
    const s = scene();
    place(s, OPP_A, 1.0, 0.3);
    startAt(s);
    const p = s.players[PASSER]!;
    const steps = actTicks(s, 4, (t, st) => {
      if (t === 4) { st.ball.owner = OPP_A; st.ball.vx = 1.5; }
    });
    expect(kickTicks(steps)).toEqual([]);
    expect(p.actDone).toBe(1);
    expect(p.actContact).toBe(4);
    expect(p.actDur).toBe(4 + REC);
    expect(s.ball.vx).toBe(1.5);
    expect(s.ball.owner).toBe(OPP_A);
    const more = actTicks(s, REC + 1);
    expect(kickTicks(more)).toEqual([]);
    expect(p.act).toBe(ActionKind.NONE);
  });

  it('ball poked out of reach before contact: whiff, nothing kicked', () => {
    const s = scene();
    startAt(s);
    const steps = actTicks(s, W + 2, (t, st) => {
      if (t === 5) { st.ball.owner = -1; st.ball.x = 3.5; st.ball.z = 1; st.ball.vx = 0; }
    });
    expect(kickTicks(steps)).toEqual([]);
    expect(s.players[PASSER]!.actDone).toBe(1);
    expect(s.ball.lastKickBy).not.toBe(PASSER);
  });

  it('a first-time ball arriving a few ticks late delays the contact (grace) and is struck', () => {
    const s = scene();
    const b = s.ball;
    b.owner = -1; b.x = 2.3; b.z = 0; b.vx = -6; b.lastTouch = OPP_A; b.lastTouchTeam = 1;
    startAt(s, KickKind.GROUND_PASS, { flags: ReqFlag.FIRST_TIME });
    const steps = actTicks(s, W + LT.contactGraceTicks + 2, undefined, true);
    const k = kickTicks(steps);
    expect(k).toHaveLength(1);
    expect(k[0]!).toBeGreaterThan(W);
    expect(k[0]!).toBeLessThanOrEqual(W + LT.contactGraceTicks);
    expect(s.ball.lastKickBy).toBe(PASSER);
    expect(s.players[PASSER]!.actContact).toBe(k[0]!);
  });

  it('a ball arriving too late even for the grace: whiff', () => {
    const s = scene();
    const b = s.ball;
    b.owner = -1; b.x = 2.5; b.z = 0; b.vx = -3; b.lastTouch = OPP_A; b.lastTouchTeam = 1;
    startAt(s, KickKind.GROUND_PASS, { flags: ReqFlag.FIRST_TIME });
    const steps = actTicks(s, W + REC + 2, undefined, true);
    expect(kickTicks(steps)).toEqual([]);
    expect(s.players[PASSER]!.act).toBe(ActionKind.NONE);
  });

  it('his own ball still dropping at contact (after a chest trap) is struck once it is low enough', () => {
    const s = scene();
    startAt(s);
    const steps = actTicks(s, W + LT.contactGraceTicks + 2, (t, st) => {
      if (t === W) { st.ball.y = 0.95; st.ball.vy = -2; st.ball.grounded = 0; }
      if (t >= W) { st.ball.vx = 0; st.ball.vz = 0; }
    }, true);
    const k = kickTicks(steps);
    expect(k).toHaveLength(1);
    expect(k[0]!).toBeGreaterThan(W);
    expect(k[0]!).toBeLessThan(W + LT.contactGraceTicks);
    // Held up there for good: whiff when the grace runs out.
    const s2 = scene();
    startAt(s2);
    const steps2 = actTicks(s2, W + LT.contactGraceTicks + REC + 1, (t, st) => { if (t >= W) { st.ball.y = 1.5; st.ball.vy = 0; } });
    expect(kickTicks(steps2)).toEqual([]);
    expect(s2.players[PASSER]!.act).toBe(ActionKind.NONE);
  });

  it('dead ball (play stopped during the wind-up): no kick', () => {
    const s = scene();
    startAt(s);
    const steps = actTicks(s, W + 1, (t, st) => { if (t === 3) st.match.phase = MatchPhase.GOAL; });
    expect(kickTicks(steps)).toEqual([]);
  });

  it('ball already played by someone else this tick: no second contact', () => {
    const s = scene();
    startAt(s);
    const steps = actTicks(s, W + 1, (t, st) => {
      if (t === W) { st.ball.owner = -1; st.ball.touchedTick = st.tick; st.ball.lastTouch = OPP_A; }
    });
    expect(kickTicks(steps)).toEqual([]);
  });

  it('a KICK whose solver cannot make the kick whiffs safely (no solver / solver refuses)', () => {
    for (const kind of [KickKind.THROW_IN, KickKind.NONE]) {
      const s = scene();
      const p = s.players[PASSER]!;
      beginAction(p, ActionKind.KICK, W + REC, W);
      p.actKick = kind;
      const steps = actTicks(s, W + REC + 1);
      expect(kickTicks(steps)).toEqual([]);
      expect(p.act).toBe(ActionKind.NONE);
      expect(s.ball.owner).toBe(PASSER);
    }
  });
});

// ---------------------------------------------------------------- movement

describe('SIM-08 KICK movement', () => {
  it('slowed during the wind-up, LOCKED at contact, then handed back with a ramp', () => {
    const caps: number[] = [];
    const modes: number[] = [];
    const release = 12;
    // Record what locomotion would see after each action stage.
    const s2 = scene();
    startAt(s2, KickKind.GROUND_PASS, { charging: 1 });
    const q = s2.players[PASSER]!;
    const ev = createEventBuffer();
    for (let t = 1; t <= release + REC + 1; t++) {
      s2.tick++;
      ev.begin(s2.tick);
      if (!(q.act !== ActionKind.NONE && q.moveMode === MoveMode.LOCKED)) {
        q.moveMode = MoveMode.DIRECT; q.ix = 0.6; q.iz = 0.8; q.wantSprint = 1;
      }
      if (t === release) q.actCharging = 0;
      actionsTick(s2, ev);
      modes.push(q.moveMode);
      caps.push(q.moveMode === MoveMode.DIRECT ? Math.hypot(q.ix, q.iz) : -1);
      if (t < release) {
        expect(q.moveMode).toBe(MoveMode.DIRECT);
        expect(Math.hypot(q.ix, q.iz)).toBeCloseTo(LT.windupMoveScale, 12);
        expect(q.wantSprint).toBe(0);
        expect(Math.atan2(q.iz, q.ix)).toBeCloseTo(Math.atan2(0.8, 0.6), 12);
      }
    }
    // Contact at `release`: LOCKED for contactLockTicks, one STOP tick, then DIRECT with a rising cap.
    for (let i = 0; i < LT.contactLockTicks; i++) expect(modes[release - 1 + i]).toBe(MoveMode.LOCKED);
    expect(modes[release - 1 + LT.contactLockTicks]).toBe(MoveMode.STOP);
    const ramp = caps.slice(release + LT.contactLockTicks, release + REC - 1);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]!).toBeGreaterThanOrEqual(ramp[i - 1]!);
    expect(ramp[0]!).toBeGreaterThanOrEqual(LT.windupMoveScale);
    // Action over: the intent is the resolver's again (uncapped).
    expect(q.act).toBe(ActionKind.NONE);
    expect(Math.hypot(q.ix, q.iz)).toBeCloseTo(1, 12);
  });

  it('an ARRIVE intent is capped at the slowed speed during the wind-up', () => {
    const s = scene();
    startAt(s);
    const p = s.players[PASSER]!;
    actTicks(s, 3, () => { p.moveMode = MoveMode.ARRIVE; p.tgtX = 20; p.tgtZ = 0; p.tgtSpeed = 9; p.wantSprint = 1; });
    expect(p.tgtSpeed).toBeCloseTo(LT.windupMoveScale * s.attrs[PASSER]!.topSpeed * T_PLAYER.jogFraction, 12);
    expect(p.wantSprint).toBe(0);
  });

  it('end() never leaves the player locked (interrupted at contact)', () => {
    const s = scene();
    startAt(s);
    actTicks(s, W);
    const p = s.players[PASSER]!;
    expect(p.moveMode).toBe(MoveMode.LOCKED);
    p.actDur = p.actT; // let the dispatcher end it next tick
    actTicks(s, 1);
    expect(p.act).toBe(ActionKind.NONE);
    expect(p.moveMode).not.toBe(MoveMode.LOCKED);
  });
});

// ---------------------------------------------------------------- pass and go

describe('SIM-08 pass and go', () => {
  it('a PASS_AND_GO pass sets the team run request at contact', () => {
    const s = scene();
    const team = s.teams[0]!;
    startAt(s, KickKind.GROUND_PASS, { flags: ReqFlag.PASS_AND_GO });
    actTicks(s, W - 1);
    expect(team.passGoSlot).toBe(-1);
    actTicks(s, 1);
    expect(team.passGoSlot).toBe(PASSER);
    expect(team.passGoT).toBe(LT.passGoTicks);
    expect(LT.passGoTicks).toBe(120);
  });

  it('plain passes, whiffs and kick-offs leave it alone', () => {
    for (const kind of [KickKind.GROUND_PASS, KickKind.KICK_OFF]) {
      const s = scene();
      startAt(s, kind, { flags: kind === KickKind.KICK_OFF ? ReqFlag.PASS_AND_GO : 0 });
      actTicks(s, W + 1);
      expect(s.teams[0]!.passGoSlot).toBe(-1);
    }
    const s = scene();
    startAt(s, KickKind.DRIVEN_PASS, { flags: ReqFlag.PASS_AND_GO | ReqFlag.DRIVEN });
    actTicks(s, W + 1, (t, st) => { if (t === 2) st.ball.owner = OPP_A; });
    expect(s.teams[0]!.passGoSlot).toBe(-1);
  });
});

// ---------------------------------------------------------------- full pipeline

/** IN_PLAY with P1 on PASSER (ball at his feet at (0, 0)), two teammates ahead, the rest parked deep. */
function live(seed = 3): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: PASSER }], seed });
  for (let i = 0; i < 22; i++) {
    if (i === 0 || i === 11 || i === PASSER) continue;
    place(s, i, (i < 11 ? -22 : 22) + (i % 3), -25 + (i % 11) * 5);
  }
  place(s, PASSER, 0, 0);
  s.players[PASSER]!.ctrl = 0;
  skill(s, PASSER, 85);
  place(s, MATE_A, 16, 6);
  place(s, MATE_B, 14, -9);
  giveBall(s, PASSER);
  return s;
}

/**
 * Hold `buttons` with stick (mx, mz) for `ticks` ticks once the passer is free with the ball; the stick is released
 * once he has struck the ball (control passes to the receiver, who then collects on his own).
 */
function pressWhenReady(buttons: number, mx: number, mz: number, ticks: number) {
  let pressed = 0;
  let done = false;
  return (_t: number, st: SimState, out: { mx: number; mz: number; buttons: number }[]): void => {
    const f = out[0]!;
    if (st.ball.lastKickBy === PASSER) return;
    f.mx = mx; f.mz = mz;
    if (done) return;
    if (pressed === 0 && !(st.players[PASSER]!.act === ActionKind.NONE && st.ball.owner === PASSER)) return;
    f.buttons = buttons;
    pressed++;
    if (pressed >= ticks) done = true;
  };
}

describe('SIM-08 passes in the full pipeline', () => {
  for (const [name, mx, mz, want] of [['MATE_A', 120, 45, MATE_A], ['MATE_B', 105, -67, MATE_B]] as const) {
    it(`a tapped PASS with the stick toward ${name} picks him, strikes at the wind-up and completes`, () => {
      const s = live();
      let kickTick = -1;
      let target = -2;
      const ev = runTicks(s, 200, pressWhenReady(Btn.PASS, mx, mz, 3), {
        check: 'core',
        until: (st, tev) => {
          for (const e of tev) if (e.type === EventType.KICK && e.a === PASSER) { kickTick = st.tick; target = st.ball.passTarget; }
          return tev.some((e) => e.type === EventType.PASS_COMPLETE);
        },
      });
      const kicks = findEvents(ev, EventType.KICK, (e) => e.a === PASSER);
      expect(kicks).toHaveLength(1);
      expect(kicks[0]!.b).toBe(KickKind.GROUND_PASS);
      expect(kickTick).toBeGreaterThan(0);
      expect(target).toBe(want);
      const done = findEvents(ev, EventType.PASS_COMPLETE);
      expect(done).toHaveLength(1);
      expect(done[0]!.a).toBe(want);
      expect(done[0]!.b).toBe(PASSER);
    });
  }

  it('R1 + PASS strikes a driven pass and PASS, PASS a dinked one', () => {
    for (const [buttons, kind] of [[Btn.MOD_R | Btn.PASS, KickKind.DRIVEN_PASS]] as const) {
      const s = live();
      const ev = runTicks(s, 60, pressWhenReady(buttons, 120, 45, 3), { check: 'core' });
      const k = findEvents(ev, EventType.KICK, (e) => e.a === PASSER);
      expect(k.map((e) => e.b)).toEqual([kind]);
    }
    const s = live();
    let n = 0;
    const ev = runTicks(s, 60, (_t, st, out) => {
      const f = out[0]!;
      f.mx = 120; f.mz = 45;
      if (n === 0 && !(st.players[PASSER]!.act === ActionKind.NONE && st.ball.owner === PASSER)) return;
      n++;
      if (n <= 3 || (n >= 7 && n <= 9)) f.buttons = Btn.PASS;
    }, { check: 'core' });
    const k = findEvents(ev, EventType.KICK, (e) => e.a === PASSER);
    expect(k.map((e) => e.b)).toEqual([KickKind.DINKED_PASS]);
  });

  it('the kick-off is struck as KICK_OFF and play goes live (CPU and human sides)', () => {
    for (const humans of [0, 1]) {
      const s = makeScenario({ seed: 5, humans });
      const ev = runTicks(s, 900, (_t, st, out) => {
        if (humans === 1 && st.match.phase === MatchPhase.KICK_OFF && st.match.restart.ready === 1 && st.tick % 20 < 3) {
          out[0]!.buttons = Btn.PASS;
        }
      }, { check: 'core', until: (st) => st.match.phase === MatchPhase.IN_PLAY && st.ball.lastKickKind === KickKind.KICK_OFF && st.tick > 0 });
      const ko = findEvents(ev, EventType.KICK, (e) => e.b === KickKind.KICK_OFF);
      expect(ko).toHaveLength(1);
      expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
      expect(findEvents(ev, EventType.WATCHDOG)).toHaveLength(0);
    }
  });

  it('determinism: the same seed and inputs give the same hash; a clone continues identically', () => {
    const run = (): { h: number; mid: SimState; end: SimState } => {
      const s = live(11);
      const inputs = pressWhenReady(Btn.PASS, 120, 45, 3);
      runTicks(s, 40, inputs);
      const mid = cloneState(s);
      runTicks(s, 160, inputs);
      return { h: hashState(s), mid, end: s };
    };
    const a = run();
    const b = run();
    expect(a.h).toBe(b.h);
    const c = a.mid;
    runTicks(c, 160, (_t, _st, out) => { out[0]!.mx = 60; out[0]!.mz = -40; });
    const d = cloneState(b.mid);
    runTicks(d, 160, (_t, _st, out) => { out[0]!.mx = 60; out[0]!.mz = -40; });
    expect(hashState(c)).toBe(hashState(d));
  });
});
