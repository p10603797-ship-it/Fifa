/**
 * [QF-2] QA-21 keeper glitches (BRIEF §14 glitch list, Keeper) through the real pipeline: whole bot matches
 * (tools/headless runMatch, Professional, short halves) scanned every tick, plus a staged scene for the defender who
 * used to volley a shot clear from in front of his planted keeper.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, AiJob, Difficulty, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { LOCAL_TUNING as KIN } from '../../src/sim/keeper/saveKinematics';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario, runTicks } from '../harness/scenario';

/** Distance of x from team t's own goal line (>= 0 in front of it). */
function depthOf(s: SimState, team: number, x: number): number {
  return HALF_LENGTH + s.teams[team]!.dir * x;
}

/** A new AI rush this soon after the previous one ended counts as a flip-flop, ticks. */
const RUSH_FLIP_TICKS = 3;

interface Scan { dives: number; lateDives: string[]; stuck: string[]; fights: string[]; flips: string[]; rushes: number; ticks: number }

/** Run `n` Professional bot matches (2-minute halves) and scan every tick for the keeper glitches. */
function scanMatches(n: number, seed: number): Scan {
  const out: Scan = { dives: 0, lateDives: [], stuck: [], fights: [], flips: [], rushes: 0, ticks: 0 };
  for (let m = 0; m < n; m++) {
    const config = soakConfig(m, seed, { halfMinutes: 2, difficulty: Difficulty.PROFESSIONAL });
    const prevAct = [ActionKind.NONE, ActionKind.NONE];
    const diveStart = [-1, -1];
    const diveDur = [0, 0];
    const rushEnd = [-1e9, -1e9];
    runMatch({
      config, checker: 'core', fastCutscenes: true,
      onTick: (s) => {
        out.ticks++;
        for (let t = 0; t < 2; t++) {
          const ks = s.teams[t]!.keeperSlot;
          if (ks < 0) continue;
          const k = s.players[ks]!;
          const b = s.ball;
          // Dive start: the ball must still be in front of his plane (never a dive after it has passed him).
          if (k.act === ActionKind.GK_DIVE && prevAct[t] !== ActionKind.GK_DIVE) {
            out.dives++;
            diveStart[t] = s.tick;
            diveDur[t] = k.actDur;
            const bd = depthOf(s, t, b.px), kd = depthOf(s, t, k.x);
            if (bd < kd - KIN.planeBackReach - 0.3 && s.match.phase === MatchPhase.IN_PLAY) {
              out.lateDives.push(`m${m} t${s.tick} team ${t}: dive with the ball ${(kd - bd).toFixed(2)} m behind him`);
            }
          }
          // Every dive ends within its fixed duration (+1 tick for the dispatcher) and frees him.
          if (k.act === ActionKind.GK_DIVE && diveStart[t] >= 0 && s.tick - diveStart[t]! > diveDur[t]! + 1) {
            out.stuck.push(`m${m} t${s.tick} team ${t}: still diving ${s.tick - diveStart[t]!} ticks (dur ${diveDur[t]})`);
            diveStart[t] = -1;
          }
          if (k.act !== ActionKind.GK_DIVE) diveStart[t] = -1;
          // Never fights a defender: while an AI keeper rushes for a loose ball no outfield teammate chases it too.
          // (The rush starts in keeperTick, after TAI-07 picked this tick's chaser: from his second tick on.)
          if (k.act === ActionKind.GK_RUSH && k.actT > 1 && b.owner < 0 && s.match.phase === MatchPhase.IN_PLAY) {
            const first = t === 0 ? 0 : 11;
            for (let i = first; i < first + 11; i++) {
              const q = s.players[i]!;
              if (i !== ks && q.active === 1 && q.job === AiJob.CHASE_LOOSE) {
                out.fights.push(`m${m} t${s.tick} team ${t}: keeper rushing while ${i} chases the same ball`);
                break;
              }
            }
          }
          // An AI rush that ends is not started again within rushFlipTicks (no start / abort / start flip-flop).
          if (k.act === ActionKind.GK_RUSH && prevAct[t] !== ActionKind.GK_RUSH) {
            out.rushes++;
            if (s.tick - rushEnd[t]! <= RUSH_FLIP_TICKS) out.flips.push(`m${m} t${s.tick} team ${t}: rush restarted ${s.tick - rushEnd[t]!} ticks after the last one ended`);
          }
          if (k.act !== ActionKind.GK_RUSH && prevAct[t] === ActionKind.GK_RUSH) rushEnd[t] = s.tick;
          prevAct[t] = k.act;
        }
      },
    });
  }
  return out;
}

describe('QF-2 keeper glitches over whole bot matches', () => {
  const scan = scanMatches(6, 0x2f2);

  it('the scan saw real keeper work (dives) over several matches', () => {
    expect(scan.ticks).toBeGreaterThan(6 * 2 * 2 * 60 * 60);
    expect(scan.dives).toBeGreaterThan(0);
  });

  it('glitch: Keeper dives after the ball has passed — no dive starts with the ball already behind his plane', () => {
    expect(scan.lateDives).toEqual([]);
  });

  it('glitch: Keeper stays stuck in a dive — every dive ends within its fixed duration', () => {
    expect(scan.stuck).toEqual([]);
  });

  it('glitch: Keeper fights a defender for the same ball — no outfield teammate chases a ball the keeper rushes for', () => {
    expect(scan.fights).toEqual([]);
  });

  it('GKP-03 come-out never flip-flops: an AI rush is not restarted the tick after it was aborted', () => {
    expect(scan.rushes).toBeGreaterThan(0);
    expect(scan.flips).toEqual([]);
  });
});

describe('QF-2 keeper and defender on the same shot (real pipeline)', () => {
  it('glitch: Keeper fights a defender for the same ball — a defender leaves the shot his planted keeper is set to catch', () => {
    // Team 0 defends x = -52.5. A 14 m/s shot from 18 m straight at the keeper (2 m off his line); defender 3 stands
    // beside him. SIM-12's automatic volley clearance used to step in front of the planted keeper and hack it away.
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 7, humans: 0 });
    for (let i = 0; i < 22; i++) {
      if (i === 0 || i === 3) continue;
      const p = s.players[i]!;
      p.x = 15 + (i % 6) * 5; p.z = -25 + i * 2.3; p.vx = 0; p.vz = 0;
    }
    s.players[11]!.x = 50; s.players[11]!.z = 0;
    const k = s.players[0]!;
    k.x = -50.5; k.z = 0; k.vx = 0; k.vz = 0; k.fx = 1; k.fz = 0;
    const d = s.players[3]!;
    d.x = -50.5; d.z = 0.6; d.vx = 0; d.vz = 0;
    const b = s.ball;
    b.owner = -1; b.heldBy = -1; b.x = -34.5; b.z = 0; b.y = 0.2; b.px = b.x; b.pz = 0; b.py = 0.2;
    b.vx = -14; b.vz = 0; b.vy = 3.2; b.grounded = 0;
    b.lastTouch = 20; b.lastTouchTeam = 1; b.lastTouchTick = s.tick; b.lastKickBy = 20; b.lastKickTeam = 1;
    b.lastKickKind = KickKind.SHOT_NORMAL; b.lastKickTick = s.tick; b.shotBy = 20; b.shotOnTarget = 1; b.passTarget = -1;
    let defenderStruck = false;
    const ev = runTicks(s, 150, undefined, {
      check: 'core',
      until: (st) => {
        const q = st.players[3]!;
        if (q.act === ActionKind.VOLLEY || q.act === ActionKind.HEADER) defenderStruck = true;
        return st.ball.heldBy === 0 || st.ball.lastTouch === 0;
      },
    });
    expect(defenderStruck).toBe(false);
    expect(s.ball.lastTouch).toBe(0);
    expect(ev.some((e) => e.type === EventType.GOAL)).toBe(false);
  });
});
