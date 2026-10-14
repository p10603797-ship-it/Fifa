/**
 * TAI-07 regressions through the real step pipeline for the intended receiver of our own pass (ball.passTarget).
 * Glitch: "Players: two teammates chase or nobody does". The receiver's claim on the chase (which bypasses arrival
 * time and hysteresis, so TAI-14's RECEIVE and the chaser agree) must end when an opponent deflects the pass and
 * must not hold while the receiver is down; otherwise nobody near the ball goes for it.
 * Team 0 has one human (auto-switch off) parked far away, so no CPU brain or switch takes over the AI players.
 */
import '../../src/sim/actions/dispatch'; // load the action registry before the keeper modules (import-cycle order)
import { describe, expect, it } from 'vitest';
import { NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../src/contracts/constants';
import { ActionKind, AiJob, AutoSwitch, MatchPhase } from '../../src/contracts/enums';
import { MoveMode, type BallState, type SimState } from '../../src/contracts/state';
import { makeScenario, runTicks } from '../harness/scenario';

function chaseJobs(s: SimState, team: number): number[] {
  const out: number[] = [];
  for (let i = teamFirstSlot(team); i < teamFirstSlot(team) + PLAYERS_PER_TEAM; i++) {
    if (s.players[i]!.active === 1 && s.players[i]!.job === AiJob.CHASE_LOOSE) out.push(i);
  }
  return out;
}

/** Loose ball with our pass from 5 to 9 on its way (as applyKick / recordTouch leave it); everyone else parked. */
function passScenario(ball: Partial<BallState>): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 2, autoSwitch: AutoSwitch.OFF }],
    ball: {
      owner: -1, heldBy: -1, passTarget: 9, lastKickBy: 5, lastKickTeam: 0, lastKickTick: 0,
      lastTouch: 5, lastTouchTeam: 0, lastTouchTick: 0, ...ball,
    },
  });
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.isKeeper === 1) continue;
    p.x = i < PLAYERS_PER_TEAM ? -45 : 45; p.z = -30 + 3 * (i % PLAYERS_PER_TEAM);
    p.homeX = p.x; p.homeZ = p.z; p.vx = 0; p.vz = 0;
  }
  Object.assign(s.players[5]!, { x: -20, z: -5, homeX: -20, homeZ: -5 });
  return s;
}

describe('TAI-07 glitch: Players: two teammates chase or nobody does (intended receiver, full pipeline)', () => {
  it('regression (deflected pass): the teammate 3.6 m from the deflected ball chases and wins it, not the far receiver', () => {
    // Opponent 16 deflected our pass; it lies dead 3.6 m from 6 while the receiver 9 is 40 m away.
    const s = passScenario({ x: 0, z: 0, vx: 0, vz: 0, lastTouch: 16, lastTouchTeam: 1 });
    Object.assign(s.players[9]!, { x: 40, z: 0, homeX: 40, homeZ: 0 });
    Object.assign(s.players[6]!, { x: -3.6, z: 0, homeX: -3.6, homeZ: 0 });
    let loose = 0;
    runTicks(s, 120, undefined, {
      until: (st) => {
        if (st.ball.owner !== -1 || st.match.phase !== MatchPhase.IN_PLAY) return true;
        loose++;
        expect(st.teams[0]!.chaser, `tick ${st.tick}`).toBe(6);
        expect(chaseJobs(st, 0)).toEqual([6]);
        return false;
      },
    });
    expect(loose).toBeGreaterThan(5);
    expect(s.ball.owner).toBe(6);
  });

  it('regression (fallen receiver): a teammate chases while the receiver is down, and keeps it when he gets up', () => {
    // Our pass is intact, but its receiver 9 is on the ground (30 ticks) far up the pitch; 6 is 5 m from the ball.
    const s = passScenario({ x: 0, z: 0, vx: 2.5, vz: 0 });
    Object.assign(s.players[9]!, {
      x: 30, z: 0, homeX: 30, homeZ: 0, act: ActionKind.FALLEN, actT: 0, actDur: 30, moveMode: MoveMode.LOCKED,
    });
    Object.assign(s.players[6]!, { x: -5, z: 0, homeX: -5, homeZ: 0 });
    let loose = 0, upLoose = 0;
    let firstD = -1, lastD = -1;
    runTicks(s, 240, undefined, {
      until: (st) => {
        if (st.ball.owner !== -1 || st.match.phase !== MatchPhase.IN_PLAY) return true;
        loose++;
        if (st.players[9]!.act !== ActionKind.FALLEN && st.players[9]!.act !== ActionKind.GET_UP) upLoose++;
        expect(st.teams[0]!.chaser, `tick ${st.tick}`).toBe(6);
        expect(chaseJobs(st, 0)).toEqual([6]);
        const p = st.players[6]!;
        lastD = Math.hypot(p.x - st.ball.x, p.z - st.ball.z);
        if (firstD < 0) firstD = lastD;
        return false;
      },
    });
    expect(upLoose).toBeGreaterThan(5); // the receiver was back on his feet while the ball was still loose
    expect(loose).toBeGreaterThan(upLoose);
    expect(lastD).toBeLessThan(firstD); // 6 went for it instead of drifting away
    expect(s.ball.owner).toBe(6);
  });
});
