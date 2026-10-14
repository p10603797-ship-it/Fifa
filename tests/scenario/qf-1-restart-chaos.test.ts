/**
 * [QF-1] QA-06 restart chaos: in real matches (bot v bot, one or two hostile humans), every kind of restart is awarded
 * at random moments, for either team, at random spots (inside and outside the pitch, in the boxes, at the flags) and
 * often on top of a pending one. Every tick is checked against the full invariant set; no restart may need the
 * watchdog, sit past its timeout, go to the wrong end, or leave two restarts queued.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { MatchPhase, RestartKind, WatchdogReason } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createEventBuffer } from '../../src/sim/core/events';
import { createInvariantChecker } from '../../src/sim/debug/invariants';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';
import { createHostile, HOSTILE_KINDS, type HostileGen } from '../../tools/lib/hostile';
import { makeScenario } from '../harness/scenario';

function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}

const KINDS = [RestartKind.THROW_IN, RestartKind.GOAL_KICK, RestartKind.CORNER, RestartKind.FREE_KICK, RestartKind.PENALTY, RestartKind.KICK_OFF];

interface ChaosResult { awards: number; taken: number }

/** One chaos match `n` (deterministic): random awards on top of live play, every tick checked against 'all'. */
function chaosMatch(n: number): ChaosResult {
  let awards = 0, taken = 0;
  const rnd = lcg(1000 + n);
  const humans = n % 3; // bot v bot, one human, two humans
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 500 + n, humans, match: { periodT: 600 } });
  const gens: HostileGen[] = [];
  for (let h = 0; h < humans; h++) gens.push(createHostile(HOSTILE_KINDS[(n + h) % HOSTILE_KINDS.length]!, 77 + n, h));
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const checker = createInvariantChecker('all');
  const watchdogs: SimEvent[] = [];
  let nextAward = 30 + Math.floor(rnd() * 200);
  for (let t = 0; t < 2400; t++) {
    clearInputFrame(frames[0]!); clearInputFrame(frames[1]!);
    for (let h = 0; h < gens.length; h++) gens[h]!.fill(s.tick + 1, s, frames[h]!);
    step(s, frames, ev);
    for (let k = 0; k < ev.count; k++) {
      const e = ev.get(k);
      if (e.type === EventType.WATCHDOG && e.a !== WatchdogReason.OTHER) watchdogs.push({ ...e });
      if (e.type === EventType.PHASE_CHANGE && e.b === MatchPhase.IN_PLAY && e.a !== MatchPhase.PRE_MATCH) taken++;
    }
    const fails = checker.check(s, ev);
    if (fails.length > 0) throw new Error(`match ${n} t=${s.tick}:\n  ${fails.slice(0, 4).join('\n  ')}`);
    if (s.match.phase === MatchPhase.POST_MATCH) break;
    if (t === nextAward) {
      nextAward = t + 20 + Math.floor(rnd() * 260);
      const kind = KINDS[Math.floor(rnd() * KINDS.length)]!;
      const team = rnd() < 0.5 ? 0 : 1;
      const x = (rnd() * 2 - 1) * (HALF_LENGTH + 4);
      const z = (rnd() * 2 - 1) * (HALF_WIDTH + 4);
      const before = s.match.phase;
      ev.begin(s.tick);
      awardRestart(s, kind, team, x, z, ev);
      if (s.match.phase !== before) awards++;
      checker.reset(); // the award happened between ticks: its phase change is not in the next tick's events
      // Whatever was asked, the restart in force is for one team at a legal spot of its kind.
      const r = s.match.restart;
      if (s.match.phase >= MatchPhase.THROW_IN && s.match.phase <= MatchPhase.PENALTY) {
        expect(r.team === 0 || r.team === 1).toBe(true);
        expect(Math.abs(r.x)).toBeLessThanOrEqual(HALF_LENGTH + 1e-9);
        expect(Math.abs(r.z)).toBeLessThanOrEqual(HALF_WIDTH + 1e-9);
        const attackDir = s.teams[r.team]!.dir;
        if (r.kind === RestartKind.CORNER || r.kind === RestartKind.PENALTY) expect(Math.sign(r.x)).toBe(attackDir);
        if (r.kind === RestartKind.GOAL_KICK) expect(Math.sign(r.x)).toBe(-attackDir);
      }
    }
  }
  expect(watchdogs.map((e) => `t=${e.tick} reason ${e.a} b ${e.b}`), `match ${n}`).toEqual([]);
  return { awards, taken };
}

describe('QF-1 QA-06 restart chaos', { timeout: 600_000 }, () => {
  it('glitch overlap — a goal-line wall whose first slot is where the keeper stands (chaos match 15: free kick 5.5 m out, 8.7 m wide)', () => {
    // Before QF-1: RUL-05 slid the wall member into the keeper's spot every tick; SIM-05 pushed him into the next
    // member; the two overlapped for over a second (overlap invariant at t=2035).
    chaosMatch(15);
  });

  it('glitch two restarts queued / restart given to the wrong team — 40 matches of random awards on top of live play', () => {
    let awards = 0, taken = 0;
    for (let n = 0; n < 40; n++) {
      const r = chaosMatch(n);
      awards += r.awards;
      taken += r.taken;
    }
    expect(awards).toBeGreaterThan(100);
    expect(taken).toBeGreaterThan(100);
  });
});
