/**
 * [QF-2] QA-12 / QA-15 / QA-18 match-level regressions found by scanning whole Professional bot matches (tools/headless
 * runMatch, 2-minute halves): passes and knock-ons played straight out of play, one loose-ball chaser per team, and
 * the CPU's shots into the man in front of it.
 */
import { describe, expect, it } from 'vitest';
import { PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { Difficulty, KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

interface Scan {
  matches: number;
  passes: number;
  passesOut: string[];
  knockOns: number;
  knockOnsOut: string[];
  shots: number;
  shotsIntoMan: number;
  chaserTicks: number;
  badChaser: string[];
}

function scan(n: number, seed: number): Scan {
  const out: Scan = { matches: n, passes: 0, passesOut: [], knockOns: 0, knockOnsOut: [], shots: 0, shotsIntoMan: 0, chaserTicks: 0, badChaser: [] };
  for (let m = 0; m < n; m++) {
    const config = soakConfig(m, seed, { halfMinutes: 2, difficulty: Difficulty.PROFESSIONAL });
    let pass: { tick: number; by: number; kind: number } | null = null;
    let knock: { tick: number; by: number } | null = null;
    let prevPhase = -1;
    let looseFor = 0;
    runMatch({
      config, checker: 'core', fastCutscenes: true,
      onTick: (s, ev) => {
        for (let i = 0; i < ev.count; i++) {
          const e = ev.get(i);
          if (e.type === EventType.KICK) {
            if (e.b === KickKind.GROUND_PASS || e.b === KickKind.DRIVEN_PASS) { out.passes++; pass = { tick: s.tick, by: e.a, kind: e.b }; knock = null; }
            else if (e.b === KickKind.KNOCK_ON) { out.knockOns++; knock = { tick: s.tick, by: e.a }; pass = null; }
            else { pass = null; if (e.a !== knock?.by) knock = null; }
          } else if (e.type === EventType.SHOT && s.match.period < 4) {
            // The nearest outfield opponent ahead of the ball within 8 m and within 0.6 m of its line.
            out.shots++;
            const b = s.ball; const v = Math.hypot(b.vx, b.vz);
            if (v > 1) {
              const ux = b.vx / v, uz = b.vz / v;
              const o0 = (1 - s.players[e.a]!.team) * PLAYERS_PER_TEAM;
              for (let j = o0; j < o0 + PLAYERS_PER_TEAM; j++) {
                const q = s.players[j]!;
                if (q.active !== 1 || q.isKeeper === 1) continue;
                const dx = q.x - b.x, dz = q.z - b.z;
                const along = dx * ux + dz * uz;
                if (along < 0.3 || along > 8) continue;
                if (Math.abs(dx * uz - dz * ux) < 0.6) { out.shotsIntoMan++; break; }
              }
            }
          } else if (e.type === EventType.RESTART_AWARDED) {
            const k = e.a;
            if (k === RestartKind.THROW_IN || k === RestartKind.CORNER || k === RestartKind.GOAL_KICK) {
              if (pass && s.ball.lastTouch === pass.by) out.passesOut.push(`m${m} t${s.tick} ${KickKind[pass.kind]} by ${pass.by} -> ${RestartKind[k]}`);
              if (knock && s.ball.lastTouch === knock.by) out.knockOnsOut.push(`m${m} t${s.tick} knock-on by ${knock.by} -> ${RestartKind[k]}`);
            }
            pass = null; knock = null;
          }
        }
        if (s.ball.owner >= 0) { pass = null; if (s.ball.owner !== knock?.by) knock = null; }
        // Exactly one loose-ball chaser per team while the ball is free in open play (BRIEF §7 / §14); the tick a
        // restart is taken the team AI ran in the restart phase (no chaser yet), so open play from the next tick.
        const live = s.match.phase === MatchPhase.IN_PLAY && prevPhase === MatchPhase.IN_PLAY;
        prevPhase = s.match.phase;
        // (A ball kicked loose this tick gets its chasers next tick: the team AI runs before the actions.)
        looseFor = live && s.ball.owner < 0 && s.ball.heldBy < 0 ? looseFor + 1 : 0;
        if (looseFor >= 2) {
          out.chaserTicks++;
          for (let t = 0; t < 2; t++) {
            const ch = s.teams[t]!.chaser;
            const ok = ch >= t * PLAYERS_PER_TEAM && ch < (t + 1) * PLAYERS_PER_TEAM && s.players[ch]!.active === 1;
            if (!ok && out.badChaser.length < 10) out.badChaser.push(`m${m} t${s.tick} team ${t}: chaser ${ch}`);
          }
        }
      },
    });
  }
  return out;
}

describe('QF-2 whole-match scan (Professional, 2-minute halves)', () => {
  const r = scan(4, 0x5c4);

  it('the scan saw open play: passes, shots and loose balls', () => {
    expect(r.passes).toBeGreaterThan(100);
    expect(r.shots).toBeGreaterThan(5);
    expect(r.chaserTicks).toBeGreaterThan(1000);
  });

  it('QA-12 a ground / driven pass is not led out of play: straight-out passes stay rare (was ~3 a match)', () => {
    // SIM-08 / TAI-09 extrapolated a wide receiver's run out of the pitch and clamped the target onto the touchline.
    expect(r.passesOut.length, r.passesOut.join('\n')).toBeLessThanOrEqual(r.matches * 1.5);
  });

  it('QA-12 a knock-on is played past the man, not out of play', () => {
    expect(r.knockOnsOut, r.knockOnsOut.join('\n')).toEqual([]);
  });

  it('QA-13 the CPU rarely shoots straight into the man in front of it (was 40 of 76 shots)', () => {
    expect(r.shotsIntoMan / r.shots).toBeLessThan(0.35);
  });

  it('QA-15 exactly one loose-ball chaser per team, every tick the ball is free', () => {
    expect(r.badChaser).toEqual([]);
  });
});
