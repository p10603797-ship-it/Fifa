/**
 * [QF-11] The QF-2 whole-match glitch scan (QA-12 passes / knock-ons out of play, QA-13 shots into the man, QA-15 one
 * loose-ball chaser per team) at both ends of the retuned ladder: Beginner (80-tick reaction delay, noisy decisions,
 * loose marking, slow keeper) and Legend (noiseless, patient carrier). The level changes decisions and timing, never
 * these guarantees. Same checks and limits as tests/scenario/qf-2-match-scan.test.ts (Professional).
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

function scan(n: number, seed: number, level: Difficulty): Scan {
  const out: Scan = { matches: n, passes: 0, passesOut: [], knockOns: 0, knockOnsOut: [], shots: 0, shotsIntoMan: 0, chaserTicks: 0, badChaser: [] };
  for (let m = 0; m < n; m++) {
    const config = soakConfig(m, seed, { halfMinutes: 2, difficulty: level });
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

for (const [name, level, seed] of [['Beginner', Difficulty.BEGINNER, 0x11b0], ['Legend', Difficulty.LEGEND, 0x11e0]] as const) {
  describe(`QF-11 whole-match scan at ${name} (2-minute halves)`, () => {
    // [QF-13 skeptic] Beginner over 12 matches: QA-13's ratio over its first 4 is a handful of shots (8 of 21 into the
    // man on the QF-13 skeptic tree, 4 of them in one match), while 16 matches give 0.19 (0.15 on the WIP tree).
    const r = scan(level === Difficulty.BEGINNER ? 12 : 4, seed, level);

    it('the scan saw open play: passes, shots and loose balls', () => {
      // (A control on the sample, not a band: a patient Legend carrier made 75-90 ground / driven passes here; since QF-13
      // skeptic 50-65: header passes can be intercepted and a turning carrier no longer loses his ball to re-collect it
      // (16 short Legend matches: 21.6 -> 16.5 a match).)
      expect(r.passes).toBeGreaterThan(40);
      expect(r.shots).toBeGreaterThan(5);
      expect(r.chaserTicks).toBeGreaterThan(1000);
    });

    it('QA-12 straight-out ground / driven passes stay rare', () => {
      expect(r.passesOut.length, r.passesOut.join('\n')).toBeLessThanOrEqual(r.matches * 1.5);
    });

    it('QA-12 a knock-on is played past the man, not out of play', () => {
      expect(r.knockOnsOut, r.knockOnsOut.join('\n')).toEqual([]);
    });

    it('QA-13 the CPU rarely shoots straight into the man in front of it', () => {
      expect(r.shotsIntoMan / r.shots).toBeLessThan(0.35);
    });

    it('QA-15 exactly one loose-ball chaser per team, every tick the ball is free', () => {
      expect(r.badChaser).toEqual([]);
    });
  });
}
