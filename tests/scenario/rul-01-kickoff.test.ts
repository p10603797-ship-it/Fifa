/**
 * RUL-01: kick-off setup (legal positions for every formation and direction, taker + partner, ball on the spot),
 * kick-off input (PASS -> SIM-08 startPass KICK_OFF), timeout defaults, the forced-kick safety net, readiness and
 * the start whistle, taker re-pick, and the glitch lines "kick-off with players in the wrong half" and
 * "stay off the pitch after a throw-in or celebration".
 *
 * SIM-08 startPass is wrapped: by default it records the request and refuses (like the Wave 0 stub); tests that
 * need a working pass switch it to apply the kick at once through core/kick.ts applyKick.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALL_RADIUS, CENTRE_CIRCLE_RADIUS, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot,
} from '../../src/contracts/constants';
import { ActionKind, FormationId, KickKind, MatchPhase, ModeId, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType, WhistleKind, type EventSink } from '../../src/contracts/events';
import { Btn, createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_PLAYER, T_RULES } from '../../src/contracts/tuning';
import { createEventBuffer } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import {
  LOCAL_TUNING, kickOffDefault, kickOffInput, kickOffTick, rulesTick, setupKickOff,
} from '../../src/sim/rules/machine';
import { findEvents, makeScenario, runTicks, runUntil } from '../harness/scenario';

const pass = vi.hoisted(() => ({
  accept: false,
  calls: [] as { slot: number; kind: number; target: number; flags: number; power: number; dirX: number; dirZ: number; tick: number }[],
}));

vi.mock('../../src/sim/kicks/pass', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/sim/kicks/pass')>();
  return {
    ...mod,
    startPass: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => {
      pass.calls.push({ slot, kind, target: req.targetSlot, flags: req.flags, power: req.power, dirX: req.dirX, dirZ: req.dirZ, tick: s.tick });
      if (!pass.accept) return 0;
      const l = createKickLaunch();
      const q = s.players[req.targetSlot]!;
      l.vx = (q.x - s.ball.x) * 2; l.vz = (q.z - s.ball.z) * 2; l.kind = kind; l.target = req.targetSlot; l.tx = q.x; l.tz = q.z;
      applyKick(s, slot, l, req.power, ev);
      return 1;
    },
  };
});

beforeEach(() => {
  pass.accept = false;
  pass.calls.length = 0;
});

const EV = createEventBuffer();

function tickRules(s: SimState) {
  s.tick++;
  EV.begin(s.tick);
  s.match.phaseT++;
  s.ball.cross = 0;
  rulesTick(s, EV);
  return EV.toArray();
}

/** A state in KICK_OFF for `team` (setupKickOff + phase), not ready yet. */
function kickOffState(team: number, opts: Parameters<typeof makeScenario>[0] = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.KICK_OFF, ...opts });
  EV.begin(s.tick);
  setupKickOff(s, team, EV);
  return s;
}

function expectLegalKickOff(s: SimState, label: string): void {
  const m = s.match;
  const kt = m.restart.team;
  const minSep = 2 * T_PLAYER.bodyRadius - T_PLAYER.overlapTolerance;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1) continue;
    const dir = s.teams[p.team]!.dir;
    expect(dir * p.x, `${label}: slot ${i} own half`).toBeLessThanOrEqual(0);
    expect(Math.abs(p.x), `${label}: slot ${i} inside`).toBeLessThan(HALF_LENGTH);
    expect(Math.abs(p.z), `${label}: slot ${i} inside`).toBeLessThan(HALF_WIDTH);
    if (p.team !== kt) expect(Math.hypot(p.x, p.z), `${label}: slot ${i} outside the circle`).toBeGreaterThanOrEqual(CENTRE_CIRCLE_RADIUS);
    expect(p.act).toBe(ActionKind.NONE);
    expect([p.vx, p.vz]).toEqual([0, 0]);
    for (let j = i + 1; j < NUM_SLOTS; j++) {
      const q = s.players[j]!;
      if (q.active !== 1) continue;
      expect(Math.hypot(p.x - q.x, p.z - q.z), `${label}: slots ${i}/${j} overlap`).toBeGreaterThanOrEqual(minSep);
    }
  }
  const b = s.ball;
  expect([b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner, b.heldBy]).toEqual([0, BALL_RADIUS, 0, 0, 0, 0, -1, -1]);
  const r = m.restart;
  expect([r.kind, r.ready, r.taken, r.timeoutT]).toEqual([RestartKind.KICK_OFF, 0, 0, T_RULES.restartTimeoutTicks]);
  const tk = s.players[r.taker]!;
  expect(tk.team).toBe(kt);
  expect(tk.isKeeper).toBe(0);
  const dir = s.teams[kt]!.dir;
  expect(tk.x).toBeCloseTo(-dir * LOCAL_TUNING.kickOffTakerBehind, 9);
  expect(tk.z).toBe(0);
  expect([tk.fx, tk.fz]).toEqual([dir, 0]);
  // A teammate beside him (the nearest teammate to the ball) for the short pass.
  let near = -1, nd = 1e9;
  const first = teamFirstSlot(kt);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === r.taker || s.players[i]!.active !== 1) continue;
    const d = Math.hypot(s.players[i]!.x, s.players[i]!.z);
    if (d < nd) { nd = d; near = i; }
  }
  expect(nd, `${label}: partner distance`).toBeLessThan(2.5);
  expect([r.aimX, r.aimZ]).toEqual([s.players[near]!.x, s.players[near]!.z]);
}

describe('RUL-01 setupKickOff', () => {
  it('legal positions for every formation, both kicking teams, both directions', () => {
    for (let f = FormationId.F442; f <= FormationId.F41212; f++) {
      for (let g = FormationId.F442; g <= FormationId.F41212; g += 2) {
        for (const team of [0, 1]) {
          for (const dir0 of [1, -1]) {
            const s = kickOffState(team, { config: { homeFormation: f, awayFormation: g }, teams: [{ dir: dir0 }, { dir: -dir0 }] });
            expectLegalKickOff(s, `${FormationId[f]} v ${FormationId[g]} team ${team} dir ${dir0}`);
            expect(s.match.kickoffTeam).toBe(team);
          }
        }
      }
    }
  });

  it('glitch "kick-off with players in the wrong half": everyone is moved into his own half, opponents out of the circle', () => {
    const players = [];
    for (let i = 0; i < NUM_SLOTS; i++) players.push({ slot: i, x: i < 11 ? 30 - i : -30 + i - 11, z: (i % 7) - 3 });
    const s = kickOffState(0, { players });
    expectLegalKickOff(s, 'scrambled');
  });

  it('glitch "stay off the pitch after a throw-in or celebration": players outside the lines are brought back', () => {
    const s = kickOffState(1, {
      players: [{ slot: 3, x: 10, z: 37 }, { slot: 14, x: -56, z: 2 }, { slot: 20, x: 55, z: -38 }, { slot: 9, x: 0, z: -36 }],
    });
    expectLegalKickOff(s, 'off the pitch');
  });

  it('ends every action, clears stale advantage / challenges / offside flags and ball state', () => {
    const s = makeScenario({ phase: MatchPhase.REPLAY, players: [{ slot: 4, act: ActionKind.CELEBRATE, actT: 3, actDur: 240 }, { slot: 15, act: ActionKind.DEJECTED, actT: 3, actDur: 240 }] });
    s.match.advantage.active = 1;
    s.match.challenges[0]!.active = 1;
    s.match.offside.flags = 0b1010;
    Object.assign(s.ball, { owner: 7, shotBy: 9, passTarget: 8, inNet: 1, x: 52, vx: 3 });
    EV.begin(s.tick);
    setupKickOff(s, 0, EV);
    expect(s.players[4]!.act).toBe(ActionKind.NONE);
    expect(s.players[15]!.act).toBe(ActionKind.NONE);
    expect([s.match.advantage.active, s.match.challenges[0]!.active, s.match.offside.flags]).toEqual([0, 0, 0]);
    expect([s.ball.owner, s.ball.shotBy, s.ball.passTarget, s.ball.inNet, s.ball.x, s.ball.vx]).toEqual([-1, -1, -1, 0, 0, 0]);
    expect(s.match.phase).toBe(MatchPhase.REPLAY); // setup does not change the phase
  });

  it('a team playing short still kicks off legally; sent-off players are left where they are', () => {
    const s = makeScenario({ phase: MatchPhase.KICK_OFF, players: [{ slot: 9, active: 0, x: 0, z: 42 }, { slot: 10, active: 0, x: 1, z: 42 }] });
    EV.begin(s.tick);
    setupKickOff(s, 0, EV);
    expect([s.players[9]!.x, s.players[9]!.z]).toEqual([0, 42]);
    expect([9, 10]).not.toContain(s.match.restart.taker);
    expectLegalKickOff(s, 'short-handed');
  });
});

describe('RUL-01 kick-off for reduced sides (practice)', () => {
  it('a side with only its keeper does not kick off: the other side takes it (practice free play)', () => {
    const players = [];
    for (let slot = 12; slot < 22; slot++) players.push({ slot, active: 0, x: 0, z: 42 });
    const s = makeScenario({ phase: MatchPhase.KICK_OFF, config: { mode: ModeId.PRACTICE }, players });
    EV.begin(s.tick);
    setupKickOff(s, 1, EV);
    expect(s.match.restart.team).toBe(0);
    expect(s.match.kickoffTeam).toBe(0);
    expect(s.players[s.match.restart.taker]!.team).toBe(0);
    const k = s.players[11]!;
    expect(s.teams[1]!.dir * k.x).toBeLessThan(-40); // the lone keeper stays in his goal
  });
});

describe('RUL-01 kick-off flow', () => {
  it('ready after the setup delay with one START whistle; taker and ball stay on the spot', () => {
    const s = kickOffState(0);
    const taker = s.match.restart.taker;
    let whistles: number[] = [];
    for (let i = 0; i < T_RULES.restartSetupTicks + 5; i++) {
      if (i === 10) { s.players[taker]!.x = -5; s.players[taker]!.z = 3; s.ball.x = 2; s.ball.vx = 1; }
      const ev = tickRules(s);
      whistles = whistles.concat(findEvents(ev, EventType.WHISTLE).map((e) => e.a * 1000 + s.match.phaseT));
      if (s.match.phaseT < T_RULES.restartSetupTicks) expect(s.match.restart.ready).toBe(0);
    }
    expect(s.match.restart.ready).toBe(1);
    expect(whistles).toEqual([WhistleKind.START * 1000 + T_RULES.restartSetupTicks]);
    expect(s.players[taker]!.x).toBeCloseTo(-s.teams[0]!.dir * LOCAL_TUNING.kickOffTakerBehind, 9);
    expect([s.ball.x, s.ball.vx]).toEqual([0, 0]);
  });

  it('kickOffInput: a PASS press edge from the kicking side starts a short KICK_OFF pass to the nearest teammate', () => {
    const s = kickOffState(0, { humans: 1 });
    const c = s.ctrl[0]!;
    const f = createInputFrame();
    f.buttons = Btn.PASS;
    c.buttons = Btn.PASS; c.prevButtons = 0;
    kickOffInput(s, 0, f, EV);
    expect(pass.calls).toHaveLength(0); // not ready yet
    s.match.restart.ready = 1;
    kickOffInput(s, 1, f, EV); // P2 is not playing
    kickOffInput(s, 3, f, EV); // the other side's CPU
    expect(pass.calls).toHaveLength(0);
    c.prevButtons = Btn.PASS; // held, no edge
    kickOffInput(s, 0, f, EV);
    expect(pass.calls).toHaveLength(0);
    c.prevButtons = 0;
    kickOffInput(s, 0, f, EV);
    expect(pass.calls).toHaveLength(1);
    const call = pass.calls[0]!;
    const r = s.match.restart;
    expect(call.slot).toBe(r.taker);
    expect(call.kind).toBe(KickKind.KICK_OFF);
    expect(call.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
    expect(call.power).toBe(LOCAL_TUNING.kickOffPower);
    const q = s.players[call.target]!;
    expect(q.team).toBe(0);
    expect(Math.hypot(q.x, q.z)).toBeLessThan(2.5);
    expect(Math.hypot(call.dirX, call.dirZ)).toBeCloseTo(1, 9);
  });

  it('a CPU side presses through its frame; flags carry CPU', () => {
    const s = kickOffState(1);
    s.match.restart.ready = 1;
    const c = s.ctrl[3]!;
    c.buttons = Btn.PASS; c.prevButtons = 0;
    const f = createInputFrame();
    f.buttons = Btn.PASS;
    kickOffInput(s, 3, f, EV);
    expect(pass.calls).toHaveLength(1);
    expect(pass.calls[0]!.flags & ReqFlag.CPU).toBe(ReqFlag.CPU);
  });

  it('CPU / AI side: default kick-off after ready + cpuRestartDelay + grace; forced kick (WATCHDOG) if the pass cannot start', () => {
    const s = kickOffState(1);
    const due = T_RULES.restartSetupTicks + T_RULES.cpuRestartDelay + LOCAL_TUNING.kickOffCpuGraceTicks;
    const start = s.tick;
    const events = [];
    while (s.match.phase === MatchPhase.KICK_OFF && s.match.phaseT < due + LOCAL_TUNING.kickOffForceTicks + 5) events.push(...tickRules(s));
    expect(pass.calls[0]!.tick - start).toBe(due);
    expect(s.tick - start).toBe(due + LOCAL_TUNING.kickOffForceTicks);
    expect(pass.calls[0]!.kind).toBe(KickKind.KICK_OFF);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    const wd = findEvents(events, EventType.WATCHDOG);
    expect(wd.map((e) => e.a)).toEqual([WatchdogReason.RESTART_BLOCKED]);
    expect(s.match.watchdogCount).toBe(1);
    // The forced kick went through applyKick: a short kick-off pass toward a teammate.
    expect(s.ball.lastKickKind).toBe(KickKind.KICK_OFF);
    expect(s.ball.lastKickTeam).toBe(1);
    expect(Math.hypot(s.ball.vx, s.ball.vz)).toBeCloseTo(LOCAL_TUNING.kickOffForceSpeed, 9);
    expect(s.match.restart.kind).toBe(RestartKind.NONE);
  });

  it('CPU side with a working pass: default at the due tick, IN_PLAY, no watchdog', () => {
    pass.accept = true;
    const s = kickOffState(0);
    const start = s.tick;
    const events = [];
    while (s.match.phase === MatchPhase.KICK_OFF && s.tick - start < 1000) events.push(...tickRules(s));
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
    expect(s.tick - start).toBe(T_RULES.restartSetupTicks + T_RULES.cpuRestartDelay + LOCAL_TUNING.kickOffCpuGraceTicks);
    expect(findEvents(events, EventType.WATCHDOG)).toHaveLength(0);
  });

  it('human side: the default comes only after the 12 s timeout', () => {
    pass.accept = true;
    const s = kickOffState(0, { humans: 1 });
    const start = s.tick;
    while (s.match.phase === MatchPhase.KICK_OFF && s.tick - start < 2000) tickRules(s);
    expect(s.tick - start).toBe(T_RULES.restartSetupTicks + T_RULES.restartTimeoutTicks);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });

  it('kickOffDefault is a no-op outside KICK_OFF or once taken', () => {
    const s = kickOffState(0);
    s.match.restart.taken = 1;
    kickOffDefault(s, EV);
    s.match.restart.taken = 0;
    s.match.phase = MatchPhase.IN_PLAY;
    kickOffDefault(s, EV);
    kickOffTick(s, EV);
    expect(pass.calls).toHaveLength(0);
  });

  it('taker sent off or substituted during the kick-off: a new taker is picked and placed', () => {
    const s = kickOffState(0);
    const old = s.match.restart.taker;
    s.players[old]!.active = 0;
    tickRules(s);
    const nt = s.match.restart.taker;
    expect(nt).not.toBe(old);
    expect(s.players[nt]!.active).toBe(1);
    expect(s.players[nt]!.team).toBe(0);
    expect(s.players[nt]!.x).toBeCloseTo(-s.teams[0]!.dir * LOCAL_TUNING.kickOffTakerBehind, 9);
  });

  it('from PRE_MATCH through the real pipeline: kick-off, then play (invariants all)', () => {
    const s = makeScenario({ seed: 3 });
    const { reached, events } = runUntil(s, (st) => st.match.phase === MatchPhase.IN_PLAY, 1000, undefined, 'all');
    expect(reached).toBe(true);
    const pcs = findEvents(events, EventType.PHASE_CHANGE).map((e) => `${MatchPhase[e.a]}->${MatchPhase[e.b]}`);
    expect(pcs).toEqual(['PRE_MATCH->KICK_OFF', 'KICK_OFF->IN_PLAY']);
    expect(findEvents(events, EventType.WHISTLE).map((e) => e.a)).toEqual([WhistleKind.START]);
    expect(s.ball.lastKickKind).toBe(KickKind.KICK_OFF);
    expect(s.ball.lastKickTeam).toBe(s.match.firstKickoffTeam);
    void runTicks;
  });
});
