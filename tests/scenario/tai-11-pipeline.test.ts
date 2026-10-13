/**
 * TAI-11 CPU defending through the real step() pipeline: a human (P1, slot 9) dribbles at team 1, whose CPU brain
 * defends with the same InputFrame a human would produce. SIM-15 resolves it, SIM-16 switches, SIM-04 moves the
 * players. SIM-14's startTackle is wrapped by a recording spy (it is a Wave 1 stub that refuses every tackle; the spy
 * keeps refusing so the dribble continues and every press can be inspected at the moment the resolver turns it into a
 * tackle request).
 * Proves: the controlled defender gets goal-side and jockeys at ~3 m, presses reach startTackle as standing tackles /
 * shoulder challenges (never push-pull, hard or slide from behind) only after the level's tackle timing, better levels
 * strike earlier in the exposure window, a TAP / MOD_L switch really moves control, THROUGH starts a held keeper rush,
 * and the whole thing is deterministic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionKind as AK } from '../../src/contracts/enums';

const SPY = vi.hoisted(() => ({
  calls: [] as { tick: number; slot: number; kind: number; age: number; dBall: number; ballOff: number }[],
}));

vi.mock('../../src/sim/defend/tackle', async (orig) => {
  const real = await orig<typeof import('../../src/sim/defend/tackle')>();
  return {
    ...real,
    startTackle: (s: import('../../src/contracts/state').SimState, slot: number, kind: AK): number => {
      const p = s.players[slot]!;
      const b = s.ball;
      const o = b.owner >= 0 ? s.players[b.owner]! : null;
      SPY.calls.push({
        tick: s.tick, slot, kind,
        age: o ? s.tick - o.lastTouchTick : -1,
        dBall: Math.hypot(b.x - p.x, b.z - p.z),
        ballOff: o ? Math.hypot(b.x - o.x, b.z - o.z) : -1,
      });
      return 0;
    },
  };
});

import { HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, Difficulty, GestureKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_LEVEL } from '../../src/contracts/tuning';
import { DEFEND_TUNING as L } from '../../src/ai/cpu/defending';
import { hashState } from '../../src/sim/core/hash';
import { RushMode } from '../../src/sim/keeper/sweeper';
import { findEvents, makeScenario, runTicks } from '../harness/scenario';

const C = 9; // human carrier (team 0 attacks +x)
const D = 15; // CPU defender (team 1 defends x = +52.5)
const T = 16;
const CPU = 3;

beforeEach(() => { SPY.calls.length = 0; });

interface PipeOpts { level?: Difficulty; seed?: number; cx?: number; cz?: number; dx?: number; dz?: number }

function pipeScene(o: PipeOpts = {}): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed: o.seed ?? 3,
    config: { difficulty: o.level ?? Difficulty.PROFESSIONAL },
  });
  const q = s.players[C]!;
  q.x = o.cx ?? 0; q.z = o.cz ?? 0; q.vx = 0; q.vz = 0; q.fx = 1; q.fz = 0;
  const p = s.players[D]!;
  p.x = q.x + (o.dx ?? 12); p.z = q.z + (o.dz ?? 4); p.vx = 0; p.vz = 0; p.fx = -1; p.fz = 0;
  // Keep the rest of team 1 out of the duel (they still play: TAI modules move them).
  for (let i = 12; i < 22; i++) {
    if (i === D) continue;
    const r = s.players[i]!;
    r.x = 46 + (i % 3); r.z = (i % 2 === 0 ? 1 : -1) * (14 + (i - 12) * 2); r.vx = 0; r.vz = 0; // wide: not in the goal channel
  }
  const b = s.ball;
  b.x = q.x + 0.5; b.z = q.z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0; b.lastTouchTick = 0;
  const ctl = s.ctrl[CPU]!;
  ctl.slot = D; p.ctrl = CPU;
  s.teams[1]!.cpu.seenOwner = C;
  return s;
}

/** P1 dribbles toward +x at `mag` stick, weaving in z. */
function dribble(mag: number, weave: number) {
  return (tick: number, _s: SimState, out: InputFrame[]): void => {
    const f = out[0]!;
    const z = weave * Math.sin(tick / 23);
    const n = Math.hypot(1, z);
    f.mx = Math.round((127 * mag) / n);
    f.mz = Math.round((127 * mag * z) / n);
  };
}

describe('TAI-11 pipeline', () => {
  it('goal-side approach and jockey distance: the controlled defender gets goal-side and jockeys at ~3 m', () => {
    const s = pipeScene({ dx: 14, dz: 8 });
    let goalSideClose = -1;
    const jockeyDist: number[] = [];
    runTicks(s, 300, dribble(0.55, 0.3), {
      check: 'core',
      until: (st) => {
        if (st.ball.owner !== C) return true; // possession changed: the duel is over
        const slot = st.ctrl[CPU]!.slot;
        const p = st.players[slot]!;
        const q = st.players[C]!;
        const d = Math.hypot(p.x - q.x, p.z - q.z);
        if (goalSideClose < 0 && p.x > q.x + 0.5 && d < 4.5) goalSideClose = st.tick;
        if ((st.teams[1]!.cpu.out.buttons & Btn.SHIELD) !== 0) jockeyDist.push(d);
        return false;
      },
    });
    expect(goalSideClose).toBeGreaterThan(0);
    expect(jockeyDist.length).toBeGreaterThan(10);
    for (const d of jockeyDist) {
      expect(d).toBeGreaterThan(0.4);
      expect(d).toBeLessThan(L.jockeyKeepDist + 0.5);
    }
  });

  it('presses reach SIM-14 as standing tackles / shoulder challenges after the level\'s timing; better levels strike earlier', () => {
    const meanAge: number[] = [];
    for (const lv of [Difficulty.BEGINNER, Difficulty.PROFESSIONAL, Difficulty.LEGEND]) {
      const ages: number[] = [];
      for (let seed = 1; seed <= 12; seed++) {
        SPY.calls.length = 0;
        const s = pipeScene({ level: lv, seed, dx: 9 + (seed % 4), dz: (seed % 5) - 2 });
        let lastCpuShoot = -10;
        const presses: number[] = [];
        runTicks(s, 420, dribble(0.5 + (seed % 3) * 0.12, 0.25 + (seed % 4) * 0.1), {
          until: (st) => {
            if ((st.teams[1]!.cpu.out.buttons & Btn.SHOOT) !== 0) { presses.push(st.tick); lastCpuShoot = st.tick; }
            return st.ball.owner !== C && st.tick - lastCpuShoot > 10;
          },
        });
        // The first request of each press (the resolver retries a refused one for a few ticks).
        for (const t of presses) {
          const c = SPY.calls.find((k) => k.tick === t);
          if (!c) continue;
          expect([ActionKind.STAND_TACKLE, ActionKind.SHOULDER]).toContain(c.kind);
          if (c.age >= 0 && c.ballOff > L.exposeDist) ages.push(c.age);
        }
        for (const c of SPY.calls) expect([ActionKind.PUSH_PULL, ActionKind.HARD_TACKLE, ActionKind.SLIDE_TACKLE]).not.toContain(c.kind);
      }
      expect(ages.length, `level ${lv}`).toBeGreaterThan(3);
      // Between-touches presses never come before the level's timing (only skill / first-touch windows count from
      // their own start, and rash lunges need no exposure at all, so the bound is checked on exposed presses).
      for (const a of ages) expect(a).toBeGreaterThanOrEqual(T_LEVEL.tackleTimingTicks[lv]!);
      meanAge.push(ages.reduce((x, y) => x + y, 0) / ages.length);
    }
    console.log(`TAI-11 mean press age after the touch (Beginner, Pro, Legend): ${meanAge.map((a) => a.toFixed(1)).join(', ')}`);
    expect(meanAge[2]!).toBeLessThan(meanAge[0]!);
  });

  it('player choice: a TAP on the best-placed teammate really moves control (SIM-16 manual switch, SWITCH event)', () => {
    const s = pipeScene({ cx: 0, cz: 0, dx: -8, dz: 6 }); // our defender beaten, behind the carrier
    const t = s.players[T]!;
    t.x = 10; t.z = 1; t.vx = 0; t.vz = 0;
    let tapped = -1;
    const ev = runTicks(s, 30, dribble(0.4, 0), {
      until: (st) => {
        const f = st.teams[1]!.cpu.out;
        if (tapped < 0 && (f.gesture === GestureKind.TAP || (f.buttons & Btn.MOD_L) !== 0)) tapped = st.tick;
        return st.ctrl[CPU]!.slot === T;
      },
    });
    expect(tapped).toBeGreaterThan(0);
    expect(s.ctrl[CPU]!.slot).toBe(T);
    const sw = findEvents(ev, EventType.SWITCH).filter((e) => e.c === CPU);
    expect(sw.length).toBeGreaterThanOrEqual(1);
    expect(sw[sw.length - 1]!.b).toBe(T);
  });

  it('keeper rush: THROUGH held on a one-on-one starts a held rush (GKP-03 USER_HOLD)', () => {
    const s = pipeScene({ cx: 39, cz: 1, dx: -4, dz: 2 });
    s.players[C]!.vx = 5;
    const k = s.teams[1]!.keeperSlot;
    let held = false;
    let mode = -1;
    runTicks(s, 20, dribble(0.6, 0), {
      until: (st) => {
        if ((st.teams[1]!.cpu.out.buttons & Btn.THROUGH) !== 0) held = true;
        const kp = st.players[k]!;
        if (kp.act === ActionKind.GK_RUSH) mode = kp.actA;
        return mode === RushMode.USER_HOLD;
      },
    });
    expect(held).toBe(true);
    expect(mode).toBe(RushMode.USER_HOLD);
  });

  it('glitch "Players: orbit or jitter around a target": the CPU defender settles in front of a standing carrier', () => {
    const s = pipeScene({ cx: -5, cz: 0, dx: 9, dz: 5 });
    const pos: { x: number; z: number; vx: number; vz: number; mx: number; mz: number }[] = [];
    runTicks(s, 300, undefined, {
      check: 'core',
      until: (st) => {
        const p = st.players[st.ctrl[CPU]!.slot]!;
        const f = st.teams[1]!.cpu.out;
        pos.push({ x: p.x, z: p.z, vx: p.vx, vz: p.vz, mx: f.mx, mz: f.mz });
        return false;
      },
    });
    expect(s.ball.owner).toBe(C);
    const q = s.players[C]!;
    const tail = pos.slice(-90);
    const first = tail[0]!, last = tail[tail.length - 1]!;
    expect(Math.hypot(last.x - first.x, last.z - first.z)).toBeLessThan(0.3); // settled, not orbiting
    for (const t of tail) expect(Math.hypot(t.vx, t.vz)).toBeLessThan(0.6);
    // Goal-side of the carrier at about the standoff.
    expect(last.x).toBeGreaterThan(q.x + 0.5);
    expect(Math.hypot(last.x - q.x, last.z - q.z)).toBeLessThan(L.jockeyDist);
    // The stick never flips back and forth (jitter).
    let flips = 0;
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1]!, b = tail[i]!;
      if ((a.mx !== 0 || a.mz !== 0) && (b.mx !== 0 || b.mz !== 0) && a.mx * b.mx + a.mz * b.mz < 0) flips++;
    }
    expect(flips).toBeLessThanOrEqual(1);
  });

  it('glitch "Switching: flip-flops between two players": the CPU\'s own switches never bounce back within a second', () => {
    // A carrier sprinting across the pitch past a line of four goal-side defenders, turning back now and then: the
    // best-placed defender keeps changing. Only the defending spell counts (ownership switches are SIM-16's).
    let total = 0;
    for (const seed of [1, 3, 5, 7]) {
      const s = pipeScene({ seed, cx: 0, cz: -24, dx: 10, dz: 4 });
      const zs = [-20, -7, 7, 20];
      [15, 16, 17, 18].forEach((sl, k) => { const r = s.players[sl]!; r.x = 10 + (k % 2) * 3; r.z = zs[k]!; });
      const ev = runTicks(s, 900, (tick, _st, out) => {
        out[0]!.mx = 30; out[0]!.mz = Math.sin(tick / (100 + seed * 10)) >= 0 ? 120 : -120; out[0]!.buttons = Btn.SPRINT;
      }, { until: (st) => st.ball.owner !== C });
      const sw = findEvents(ev, EventType.SWITCH).filter((e) => e.c === CPU);
      total += sw.length;
      for (let i = 2; i < sw.length; i++) {
        const bounced = sw[i]!.b === sw[i - 2]!.b && sw[i]!.tick - sw[i - 2]!.tick < 60;
        expect(bounced, `seed ${seed}: ${sw.map((e) => `${e.tick}:${e.a}->${e.b}`).join(' ')}`).toBe(false);
      }
      for (let i = 1; i < sw.length; i++) expect(sw[i]!.tick - sw[i - 1]!.tick).toBeGreaterThanOrEqual(18); // SIM-16 lock-out
    }
    expect(total).toBeGreaterThanOrEqual(6); // the scenario really exercises the player choice
  });

  it('deterministic: same seed and inputs -> identical CPU frames and state hashes, bot defending for 8 s', () => {
    const run = (): number[] => {
      const s = pipeScene({ level: Difficulty.WORLD_CLASS, seed: 9, dx: 10, dz: -3 });
      const trace: number[] = [];
      runTicks(s, 480, dribble(0.6, 0.4), {
        check: 'core',
        until: (st) => {
          const f = st.teams[1]!.cpu.out;
          trace.push(hashState(st), f.mx, f.mz, f.buttons, f.gesture, f.gSlot);
          return false;
        },
      });
      return trace;
    };
    const a = run();
    const b = run();
    expect(a.length).toBe(480 * 6);
    expect(b).toEqual(a);
  });

  it('bot v bot: both CPU brains defend loose balls and carriers without invariant failures', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 21 });
    s.ball.x = 0; s.ball.z = 0; s.ball.owner = -1; s.ball.vx = 3; s.ball.vz = 1;
    let frames = 0;
    runTicks(s, 600, undefined, {
      check: 'core',
      until: (st) => {
        for (let t = 0; t < 2; t++) {
          const f = st.teams[t]!.cpu.out;
          if (f.mx !== 0 || f.mz !== 0 || f.buttons !== 0) frames++;
          expect(Math.abs(f.mx)).toBeLessThanOrEqual(127);
          expect(Math.abs(f.mz)).toBeLessThanOrEqual(127);
        }
        return st.match.phase !== MatchPhase.IN_PLAY;
      },
    });
    expect(frames).toBeGreaterThan(0);
    expect(Math.abs(s.ball.x)).toBeLessThanOrEqual(HALF_LENGTH + 10);
  });
});
