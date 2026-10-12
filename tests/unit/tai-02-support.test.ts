/**
 * TAI-02: attacking support play and passing angles (src/ai/support.ts). Direct calls of assignSupport /
 * callSupport on hand-built states (resetJobs first, as ai/index does), plus a randomised fuzz and the budget.
 */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { GOAL_AREA_DEPTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS } from '../../src/contracts/constants';
import { AiJob, ControllerKind, MatchPhase, Role, TeamPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import {
  assignSupport, callSupport, laneClearance, LOCAL_TUNING as T, pickCallSupporter, SUPPORT_CALL_TICKS, supportAnchor,
} from '../../src/ai/support';
import { isJobDriven, resetJobs } from '../../src/ai/jobs';
import { NULL_SINK } from '../../src/sim/core/events';
import { secondLastDefenderX } from '../../src/sim/core/query';
import { rngFloat, rngInt, rngSeed } from '../../src/sim/core/rng';
import { makeScenario } from '../harness/scenario';

type Spot = [slot: number, role: Role, x: number, z: number];

/** Team 0 (attacking +x) in a 4-4-2 around a midfield carrier; team 1 in a mid block. */
const HOME_442: Spot[] = [
  [0, Role.GK, -48, 0],
  [1, Role.RB, -20, 22], [2, Role.CB, -28, 7], [3, Role.CB, -28, -7], [4, Role.LB, -20, -22],
  [5, Role.RM, -2, 24], [6, Role.CM, -6, 6], [7, Role.CM, 0, -4], [8, Role.LM, -2, -24],
  [9, Role.ST, 18, 5], [10, Role.ST, 16, -6],
];
const AWAY_BLOCK: Spot[] = [
  [11, Role.GK, 49, 0],
  [12, Role.RB, 24, -18], [13, Role.CB, 24, -6], [14, Role.CB, 24, 6], [15, Role.LB, 24, 18],
  [16, Role.RM, 8, -20], [17, Role.CM, 8, -8], [18, Role.CM, 8, 7], [19, Role.LM, 8, 20],
  [20, Role.ST, -3, -12], [21, Role.ST, -3, 12],
];

interface Setup {
  home?: Spot[];
  away?: Spot[];
  carrier?: number;
  phase?: TeamPhase;
  /** Mirror everything (point reflection) and flip attack directions. */
  mirror?: boolean;
}

function build(o: Setup = {}): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0 });
  const m = o.mirror ? -1 : 1;
  s.teams[0]!.dir = m;
  s.teams[1]!.dir = -m;
  for (const [slot, role, x, z] of [...(o.home ?? HOME_442), ...(o.away ?? AWAY_BLOCK)]) {
    const p = s.players[slot]!;
    p.role = role;
    p.isKeeper = role === Role.GK ? 1 : 0;
    p.x = m * x; p.z = m * z; p.homeX = p.x; p.homeZ = p.z; p.vx = 0; p.vz = 0;
    s.teams[p.team]!.homeX[p.formIdx] = p.x;
    s.teams[p.team]!.homeZ[p.formIdx] = p.z;
  }
  const c = o.carrier ?? 7;
  if (c >= 0) {
    const p = s.players[c]!;
    s.ball.owner = c;
    s.ball.x = p.x; s.ball.z = p.z; s.ball.px = p.x; s.ball.pz = p.z;
    s.ball.lastTouch = c; s.ball.lastTouchTeam = p.team;
    const ci = 2 + p.team; // the CPU brain drives the carrier
    s.ctrl[ci]!.slot = c;
    p.ctrl = ci;
  }
  s.teams[0]!.phase = o.phase ?? TeamPhase.ATTACK;
  return s;
}

function run(s: SimState, team = 0): void {
  resetJobs(s, team);
  assignSupport(s, team, NULL_SINK);
}

function supporters(s: SimState, team = 0): number[] {
  const out: number[] = [];
  const a = team === 0 ? 0 : 11;
  for (let i = a; i < a + 11; i++) if (s.players[i]!.job === AiJob.SUPPORT) out.push(i);
  return out;
}

const WIDTH_Z = HALF_WIDTH - T.widthMargin;
const isWidthSpot = (s: SimState, i: number): boolean => Math.abs(Math.abs(s.players[i]!.tgtZ) - WIDTH_Z) < 1e-9;
const carrierDist = (s: SimState, i: number): number => {
  const p = s.players[i]!;
  return Math.hypot(p.tgtX - s.ball.x, p.tgtZ - s.ball.z);
};

describe('TAI-02 assignSupport: possession gate', () => {
  it('gives no SUPPORT jobs when the opponents have the ball', () => {
    const s = build({ carrier: 17 });
    run(s);
    expect(supporters(s)).toEqual([]);
  });

  it('gives no SUPPORT jobs on a loose ball that is not our pass in flight', () => {
    const s = build({ carrier: -1 });
    s.ball.owner = -1;
    s.ball.passTarget = -1;
    run(s);
    expect(supporters(s)).toEqual([]);
  });

  it('supports the receiver at the reception point while our pass is in flight', () => {
    const s = build({ carrier: -1 });
    s.ball.owner = -1;
    s.ball.x = 0; s.ball.z = -4;
    s.ball.passTarget = 10; s.ball.passX = 14; s.ball.passZ = -8;
    s.ball.lastKickTeam = 0; s.ball.lastTouchTeam = 0; s.ball.lastKickBy = 7;
    const a = { slot: -1, x: 0, z: 0 };
    expect(supportAnchor(s, 0, a)).toBe(10);
    expect([a.x, a.z]).toEqual([14, -8]);
    run(s);
    const sup = supporters(s).filter((i) => !isWidthSpot(s, i));
    expect(sup.length).toBeGreaterThanOrEqual(2);
    expect(sup).not.toContain(10);
    for (const i of sup) {
      const p = s.players[i]!;
      expect(Math.hypot(p.tgtX - 14, p.tgtZ + 8)).toBeGreaterThanOrEqual(T.minFromCarrier);
      expect(laneClearance(s, 0, 14, -8, p.tgtX, p.tgtZ)).toBeGreaterThan(0);
    }
  });

  it('a pass deflected by an opponent is no longer an anchor', () => {
    const s = build({ carrier: -1 });
    s.ball.owner = -1;
    s.ball.passTarget = 10; s.ball.passX = 14; s.ball.passZ = -8;
    s.ball.lastKickTeam = 0; s.ball.lastTouchTeam = 1;
    run(s);
    expect(supporters(s)).toEqual([]);
  });
});

describe('TAI-02 assignSupport: triangles and open lanes', () => {
  it('2-3 teammates near the carrier take SUPPORT jobs in the 8-20 m band with open lanes', () => {
    const s = build();
    run(s);
    const close = supporters(s).filter((i) => !isWidthSpot(s, i));
    expect(close.length).toBeGreaterThanOrEqual(2);
    expect(close.length).toBeLessThanOrEqual(T.maxClose);
    const c = s.players[7]!;
    for (const i of close) {
      const p = s.players[i]!;
      const d = carrierDist(s, i);
      expect(d).toBeGreaterThanOrEqual(T.bandMin - 1e-9);
      expect(d).toBeLessThanOrEqual(T.bandMax + 1e-9);
      expect(laneClearance(s, 0, c.x, c.z, p.tgtX, p.tgtZ)).toBeGreaterThan(0);
      expect(p.jobSlot).toBe(7);
    }
  });

  it('never picks a point behind an opponent relative to the carrier', () => {
    // CM at (0, 12) is screened by an opponent standing on the lane at (0, 5).
    const home = HOME_442.map((sp): Spot => (sp[0] === 6 ? [6, Role.CM, 0, 12] : sp));
    const away = AWAY_BLOCK.map((sp): Spot => (sp[0] === 18 ? [18, Role.CM, 0, 5] : sp));
    const s = build({ home, away, carrier: 7 });
    s.players[7]!.x = 0; s.players[7]!.z = -4; s.ball.x = 0; s.ball.z = -4;
    expect(laneClearance(s, 0, 0, -4, 0, 12)).toBeLessThan(0); // the home spot is blocked
    run(s);
    const p = s.players[6]!;
    expect(p.job).toBe(AiJob.SUPPORT);
    expect(laneClearance(s, 0, 0, -4, p.tgtX, p.tgtZ)).toBeGreaterThan(0);
    expect(Math.abs(p.tgtX)).toBeGreaterThan(2); // moved off the screened line
  });

  it('close supporters offer distinct lanes (triangles, not one line)', () => {
    const s = build();
    run(s);
    const c = s.players[7]!;
    const close = supporters(s).filter((i) => !isWidthSpot(s, i));
    for (let a = 0; a < close.length; a++) {
      for (let b = a + 1; b < close.length; b++) {
        const p = s.players[close[a]!]!, q = s.players[close[b]!]!;
        const ux = p.tgtX - c.x, uz = p.tgtZ - c.z, vx = q.tgtX - c.x, vz = q.tgtZ - c.z;
        const cos = (ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz));
        expect(cos).toBeLessThan(T.laneCosMax);
      }
    }
  });

  it('support targets stay onside (behind the offside line unless level with the ball)', () => {
    const away = AWAY_BLOCK.map((sp): Spot => (sp[0] >= 12 && sp[0] <= 15 ? [sp[0], sp[1], 20, sp[3]] : sp));
    const s = build({ away, carrier: 7 });
    run(s);
    const line = secondLastDefenderX(s, 1);
    expect(line).toBe(20);
    for (const i of supporters(s)) expect(s.players[i]!.tgtX).toBeLessThanOrEqual(line - T.onsideMargin + 1e-9);
  });

  it('a holding midfielder offers a safe back option behind an advanced carrier', () => {
    const home = HOME_442.map((sp): Spot => (sp[0] === 6 ? [6, Role.CDM, -8, 2] : sp));
    const s = build({ home, carrier: 9 });
    run(s);
    const h = s.players[6]!;
    const c = s.players[9]!;
    expect(h.job).toBe(AiJob.SUPPORT);
    expect(h.tgtX).toBeLessThan(c.x); // behind the carrier
    const d = Math.hypot(h.tgtX - c.x, h.tgtZ - c.z);
    expect(d).toBeGreaterThanOrEqual(T.holdNear - 1e-9);
    expect(d).toBeLessThanOrEqual(T.holdFar + 1e-9);
    expect(laneClearance(s, 0, c.x, c.z, h.tgtX, h.tgtZ)).toBeGreaterThan(0);
  });

  it('the holding midfielder does not drop behind a carrier who is behind him', () => {
    const home = HOME_442.map((sp): Spot => (sp[0] === 6 ? [6, Role.CDM, -8, 2] : sp));
    const s = build({ home, carrier: 2, phase: TeamPhase.BUILD_UP });
    run(s);
    const h = s.players[6]!;
    if (h.job === AiJob.SUPPORT) expect(h.tgtX).toBeGreaterThan(s.players[2]!.x);
  });

  it('the holding midfielder keeps his rest-defence spot when the carrier is far upfield', () => {
    const home = HOME_442.map((sp): Spot => (sp[0] === 6 ? [6, Role.CDM, -8, 2] : sp[0] === 9 ? [9, Role.ST, 30, 5] : sp));
    const away = AWAY_BLOCK.map((sp): Spot => (sp[0] >= 12 && sp[0] <= 15 ? [sp[0], sp[1], 38, sp[3]] : sp));
    const s = build({ home, away, carrier: 9 });
    expect(30 - -8).toBeGreaterThan(T.holdAheadMax);
    run(s);
    expect(s.players[6]!.job).toBe(AiJob.HOLD_SHAPE);
  });

  it('supporters jog; only the called supporter gets a sprint speed cap', () => {
    const s = build();
    callSupport(s, 0, NULL_SINK);
    run(s);
    const called = 6;
    expect(s.players[called]!.tgtSpeed).toBe(s.attrs[called]!.topSpeed * T.speedCall);
    for (const i of supporters(s)) {
      if (i === called) continue;
      expect(s.players[i]!.tgtSpeed).toBeLessThanOrEqual(s.attrs[i]!.topSpeed * 0.6 + 1e-9);
    }
  });

  it('rest defence: centre-backs do not join the triangles in attack', () => {
    const s = build({ carrier: 6 });
    s.players[6]!.x = -14; s.players[6]!.z = 2;
    s.ball.x = -14; s.ball.z = 2;
    run(s);
    expect(s.players[2]!.job).toBe(AiJob.HOLD_SHAPE);
    expect(s.players[3]!.job).toBe(AiJob.HOLD_SHAPE);
  });
});

describe('TAI-02 assignSupport: width', () => {
  it('wide players hold width near the touchline in build-up', () => {
    const s = build({ carrier: 2, phase: TeamPhase.BUILD_UP });
    run(s);
    for (const [slot, side] of [[5, 1], [8, -1]] as const) {
      const p = s.players[slot]!;
      expect(p.job).toBe(AiJob.SUPPORT);
      expect(p.tgtZ).toBe(side * WIDTH_Z);
      expect(p.tgtX).toBe(p.homeX);
    }
  });

  it('width is mirrored for a team attacking -x', () => {
    const s = build({ carrier: 2, phase: TeamPhase.BUILD_UP, mirror: true });
    run(s);
    expect(s.players[5]!.tgtZ).toBe(-WIDTH_Z);
    expect(s.players[8]!.tgtZ).toBe(WIDTH_Z);
    expect(s.players[5]!.tgtX).toBe(2);
  });

  it('a side without wide players gets its width from the full-back in build-up (diamond)', () => {
    const home = HOME_442.map((sp): Spot => (sp[0] === 5 ? [5, Role.CAM, 6, 3] : sp[0] === 8 ? [8, Role.CM, -6, -12] : sp));
    const s = build({ home, carrier: 2, phase: TeamPhase.BUILD_UP });
    run(s);
    expect(s.players[1]!.job).toBe(AiJob.SUPPORT);
    expect(s.players[1]!.tgtZ).toBe(HALF_WIDTH - T.fbWidthMargin);
    expect(s.players[4]!.job).toBe(AiJob.SUPPORT);
    expect(s.players[4]!.tgtZ).toBe(-(HALF_WIDTH - T.fbWidthMargin));
  });

  it('wide players stretch the play in midfield circulation too', () => {
    const s = build({ carrier: 7, phase: TeamPhase.ATTACK });
    run(s);
    expect(s.players[5]!.job).toBe(AiJob.SUPPORT);
    expect(s.players[5]!.tgtZ).toBe(WIDTH_Z);
  });

  it('in the final third (outside build-up) wide players are not pinned to the touchline', () => {
    const home = HOME_442.map((sp): Spot => (sp[0] === 9 ? [9, Role.ST, 36, 4] : sp[0] === 5 ? [5, Role.RM, 26, 20] : sp[0] === 8 ? [8, Role.LM, 26, -20] : sp));
    const away = AWAY_BLOCK.map((sp): Spot => (sp[0] >= 12 && sp[0] <= 15 ? [sp[0], sp[1], 42, sp[3]] : sp));
    const s = build({ home, away, carrier: 9, phase: TeamPhase.ATTACK });
    run(s);
    for (const i of [5, 8]) if (s.players[i]!.job === AiJob.SUPPORT) expect(isWidthSpot(s, i)).toBe(false);
  });
});

describe('TAI-02 assignSupport: priorities and eligibility', () => {
  it('does not override higher-priority jobs, keepers, or human-controlled players', () => {
    const s = build();
    // A human controls the right midfielder.
    s.ctrl[0]!.kind = ControllerKind.HUMAN; s.ctrl[0]!.side = 0; s.ctrl[0]!.slot = 5; s.players[5]!.ctrl = 0;
    resetJobs(s, 0);
    // A higher job given earlier this tick (press/chaser/transition run order in ai/index).
    s.players[10]!.job = AiJob.RUN_IN_BEHIND; s.players[10]!.tgtX = 30; s.players[10]!.tgtZ = -6;
    assignSupport(s, 0, NULL_SINK);
    expect(s.players[10]!.job).toBe(AiJob.RUN_IN_BEHIND);
    expect(s.players[10]!.tgtX).toBe(30);
    expect(s.players[5]!.job).toBe(AiJob.NONE);
    expect(s.players[0]!.job).toBe(AiJob.NONE);
    expect(s.players[7]!.job).toBe(AiJob.NONE); // the carrier
    for (const i of supporters(s)) expect(isJobDriven(s, i)).toBe(true);
  });

  it('only touches the team it is called for', () => {
    const s = build();
    resetJobs(s, 1);
    run(s, 0);
    for (let i = 11; i < 22; i++) expect(s.players[i]!.job === AiJob.SUPPORT).toBe(false);
  });

  it('works short-handed (sent-off players are skipped)', () => {
    const s = build();
    s.players[6]!.active = 0;
    s.players[10]!.active = 0;
    run(s);
    expect(s.players[6]!.job).toBe(AiJob.NONE);
    expect(supporters(s).filter((i) => !isWidthSpot(s, i)).length).toBeGreaterThanOrEqual(2);
  });
});

describe('TAI-02 callSupport', () => {
  it('calls the best midfielder and stores it in team.supportSlot / supportCallT', () => {
    const s = build();
    expect(pickCallSupporter(s, 0)).toBe(6);
    callSupport(s, 0, NULL_SINK);
    expect(s.teams[0]!.supportSlot).toBe(6);
    expect(s.teams[0]!.supportCallT).toBe(SUPPORT_CALL_TICKS);
    expect(SUPPORT_CALL_TICKS).toBe(120);
  });

  it('the called player comes toward the carrier at sprint speed for 2 s, then the call clears', () => {
    const s = build();
    s.players[6]!.x = -14; s.players[6]!.z = 10; // ~20 m away
    callSupport(s, 0, NULL_SINK);
    const c = s.players[7]!;
    for (let k = 1; k <= SUPPORT_CALL_TICKS; k++) {
      run(s);
      const p = s.players[6]!;
      expect(p.job).toBe(AiJob.SUPPORT);
      expect(Math.hypot(p.tgtX - c.x, p.tgtZ - c.z)).toBeLessThanOrEqual(T.callDist + 1e-9);
      expect(p.tgtSpeed).toBe(s.attrs[6]!.topSpeed * T.speedCall);
      expect(s.teams[0]!.supportCallT).toBe(SUPPORT_CALL_TICKS - k);
    }
    expect(s.teams[0]!.supportSlot).toBe(-1);
    run(s);
    expect(Math.hypot(s.players[6]!.tgtX - c.x, s.players[6]!.tgtZ - c.z)).toBeGreaterThan(T.callDist);
  });

  it('prefers midfielders over a nearer forward or defender', () => {
    const s = build();
    s.players[10]!.x = 5; s.players[10]!.z = -8; // striker 6.4 m away
    s.players[3]!.x = -4; s.players[3]!.z = -9; // centre-back 6.4 m away
    expect(pickCallSupporter(s, 0)).toBe(6); // midfielder 11.7 m away
    s.players[6]!.x = -20; s.players[6]!.z = 14; // now 26 m away: the striker wins
    expect(pickCallSupporter(s, 0)).toBe(10);
  });

  it('is a no-op without possession or outside IN_PLAY', () => {
    const s = build({ carrier: 17 });
    callSupport(s, 0, NULL_SINK);
    expect(s.teams[0]!.supportSlot).toBe(-1);
    const s2 = build();
    s2.match.phase = MatchPhase.THROW_IN;
    callSupport(s2, 0, NULL_SINK);
    expect(s2.teams[0]!.supportSlot).toBe(-1);
    expect(s2.teams[0]!.supportCallT).toBe(0);
  });

  it('never calls a human-controlled player or the keeper', () => {
    const s = build();
    s.ctrl[0]!.kind = ControllerKind.HUMAN; s.ctrl[0]!.side = 0; s.ctrl[0]!.slot = 6; s.players[6]!.ctrl = 0;
    s.players[0]!.x = 2; s.players[0]!.z = -6;
    const c = pickCallSupporter(s, 0);
    expect(c).not.toBe(6);
    expect(c).not.toBe(0);
    expect(c).toBeGreaterThan(0);
  });

  it('is cancelled when the opponents win the ball', () => {
    const s = build();
    callSupport(s, 0, NULL_SINK);
    run(s);
    s.ball.owner = 17;
    run(s);
    expect(s.teams[0]!.supportSlot).toBe(-1);
    expect(s.teams[0]!.supportCallT).toBe(0);
  });

  it('is cancelled when the called player receives the ball or a human takes him over', () => {
    const s = build();
    callSupport(s, 0, NULL_SINK);
    s.ball.owner = 6;
    run(s);
    expect(s.teams[0]!.supportSlot).toBe(-1);
    const s2 = build();
    callSupport(s2, 0, NULL_SINK);
    s2.ctrl[0]!.kind = ControllerKind.HUMAN; s2.ctrl[0]!.side = 0; s2.ctrl[0]!.slot = 6; s2.players[6]!.ctrl = 0;
    run(s2);
    expect(s2.teams[0]!.supportSlot).toBe(-1);
    expect(s2.teams[0]!.supportCallT).toBe(0);
  });

  it('keeps counting down through a loose ball and resumes when we have it again', () => {
    const s = build();
    callSupport(s, 0, NULL_SINK);
    run(s);
    s.ball.owner = -1; s.ball.passTarget = -1;
    run(s);
    expect(s.teams[0]!.supportSlot).toBe(6);
    expect(s.teams[0]!.supportCallT).toBe(SUPPORT_CALL_TICKS - 2);
    expect(s.players[6]!.job).toBe(AiJob.HOLD_SHAPE);
    s.ball.owner = 7;
    run(s);
    expect(s.players[6]!.job).toBe(AiJob.SUPPORT);
  });

  it('a call overrides a SUPPORT job given earlier but not a higher job', () => {
    const s = build();
    callSupport(s, 0, NULL_SINK);
    resetJobs(s, 0);
    s.players[6]!.job = AiJob.CHASE_LOOSE; s.players[6]!.tgtX = -30;
    assignSupport(s, 0, NULL_SINK);
    expect(s.players[6]!.job).toBe(AiJob.CHASE_LOOSE);
    expect(s.players[6]!.tgtX).toBe(-30);
    expect(s.teams[0]!.supportCallT).toBe(SUPPORT_CALL_TICKS - 1); // the call still runs down
  });

  it('a second call restarts the timer', () => {
    const s = build();
    callSupport(s, 0, NULL_SINK);
    for (let k = 0; k < 50; k++) run(s);
    expect(s.teams[0]!.supportCallT).toBe(SUPPORT_CALL_TICKS - 50);
    callSupport(s, 0, NULL_SINK);
    expect(s.teams[0]!.supportCallT).toBe(SUPPORT_CALL_TICKS);
    expect(s.teams[0]!.supportSlot).toBe(6);
  });
});

describe('TAI-02 mirroring', () => {
  it('a point-mirrored pitch with dir = -1 gives point-mirrored targets', () => {
    for (const [carrier, phase] of [[7, TeamPhase.ATTACK], [2, TeamPhase.BUILD_UP], [9, TeamPhase.ATTACK]] as const) {
      const a = build({ carrier, phase });
      const b = build({ carrier, phase, mirror: true });
      callSupport(a, 0, NULL_SINK);
      callSupport(b, 0, NULL_SINK);
      run(a); run(b);
      for (let i = 0; i < 11; i++) {
        const p = a.players[i]!, q = b.players[i]!;
        expect(q.job).toBe(p.job);
        expect(q.tgtX).toBeCloseTo(-p.tgtX, 9);
        expect(q.tgtZ).toBeCloseTo(-p.tgtZ, 9);
      }
    }
  });
});

describe('TAI-02 fuzz: targets are legal and no two supporters share a spot', () => {
  it('500 random possession states', () => {
    const r = { a: 0, b: 0, c: 0, d: 0 };
    rngSeed(r, 2024);
    let total = 0;
    for (let n = 0; n < 500; n++) {
      const s = build();
      const dir = rngInt(r, 2) === 0 ? 1 : -1;
      s.teams[0]!.dir = dir; s.teams[1]!.dir = -dir;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        if (p.isKeeper === 1) continue;
        p.x = (rngFloat(r) * 2 - 1) * 50; p.z = (rngFloat(r) * 2 - 1) * 33;
        p.homeX = p.x + (rngFloat(r) * 2 - 1) * 8; p.homeZ = p.z + (rngFloat(r) * 2 - 1) * 8;
        p.vx = (rngFloat(r) * 2 - 1) * 7; p.vz = (rngFloat(r) * 2 - 1) * 7;
        p.role = (1 + rngInt(r, 14)) as Role;
        p.active = rngFloat(r) < 0.05 ? 0 : 1;
      }
      s.players[0]!.x = -dir * 49; s.players[11]!.x = dir * 49;
      const carrier = rngInt(r, 11);
      s.players[carrier]!.active = 1;
      s.ctrl[2]!.slot = carrier; s.players[7]!.ctrl = -1; s.players[carrier]!.ctrl = 2;
      s.ball.owner = carrier; s.ball.x = s.players[carrier]!.x; s.ball.z = s.players[carrier]!.z;
      s.teams[0]!.phase = [TeamPhase.BUILD_UP, TeamPhase.ATTACK, TeamPhase.TRANSITION_ATTACK][rngInt(r, 3)]!;
      if (rngFloat(r) < 0.5) callSupport(s, 0, NULL_SINK);
      run(s);
      const tm = s.teams[0]!;
      expect(tm.supportCallT).toBeGreaterThanOrEqual(0);
      expect(tm.supportSlot === -1 || (tm.supportSlot >= 0 && tm.supportSlot < 11)).toBe(true);
      const line = dir * secondLastDefenderX(s, 1);
      const onside = Math.max(0, dir * s.ball.x, line - T.onsideMargin);
      const sup = supporters(s);
      total += sup.length;
      for (const i of sup) {
        const p = s.players[i]!;
        expect(Number.isFinite(p.tgtX) && Number.isFinite(p.tgtZ) && Number.isFinite(p.tgtSpeed)).toBe(true);
        expect(p.tgtSpeed).toBeGreaterThan(0);
        expect(Math.abs(p.tgtX)).toBeLessThanOrEqual(HALF_LENGTH - T.edgeMargin + 1e-9);
        expect(Math.abs(p.tgtZ)).toBeLessThanOrEqual(HALF_WIDTH - T.edgeMargin + 1e-9);
        expect(dir * p.tgtX).toBeGreaterThanOrEqual(-HALF_LENGTH + GOAL_AREA_DEPTH + T.edgeMargin - 1e-9);
        expect(dir * p.tgtX).toBeLessThanOrEqual(onside + 1e-9);
        expect(i).not.toBe(carrier);
        expect(s.players[i]!.isKeeper).toBe(0);
        if (i !== tm.supportSlot) expect(carrierDist(s, i)).toBeGreaterThanOrEqual(T.minFromCarrier - 1e-9);
        for (const j of sup) {
          if (j <= i) continue;
          const q = s.players[j]!;
          expect(Math.hypot(p.tgtX - q.tgtX, p.tgtZ - q.tgtZ)).toBeGreaterThanOrEqual(T.hardSeparation - 1e-9);
        }
      }
    }
    expect(total).toBeGreaterThan(500);
  });
});

describe('TAI-02 no two supporters on the same spot', () => {
  it('clustered homes and dense opponents: support targets stay >= hardSeparation apart (2000 states)', () => {
    const r = { a: 0, b: 0, c: 0, d: 0 };
    rngSeed(r, 99);
    let pairs = 0;
    for (let n = 0; n < 2000; n++) {
      const s = build();
      const cx = (rngFloat(r) * 2 - 1) * 30, cz = (rngFloat(r) * 2 - 1) * 20;
      const hx = cx + (rngFloat(r) * 2 - 1) * 15, hz = cz + (rngFloat(r) * 2 - 1) * 15;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        if (p.isKeeper === 1) continue;
        if (i < 11) {
          // every teammate wants nearly the same spot
          p.homeX = hx + (rngFloat(r) * 2 - 1) * 2; p.homeZ = hz + (rngFloat(r) * 2 - 1) * 2;
          p.x = p.homeX; p.z = p.homeZ;
          p.role = rngInt(r, 2) === 0 ? Role.CM : Role.ST;
        } else {
          p.x = cx + (rngFloat(r) * 2 - 1) * 18; p.z = cz + (rngFloat(r) * 2 - 1) * 18;
        }
      }
      const c = 1 + rngInt(r, 10);
      s.players[7]!.ctrl = -1;
      s.players[c]!.x = cx; s.players[c]!.z = cz; s.players[c]!.ctrl = 2; s.ctrl[2]!.slot = c;
      s.ball.owner = c; s.ball.x = cx; s.ball.z = cz;
      if (rngFloat(r) < 0.3) callSupport(s, 0, NULL_SINK);
      run(s);
      const sup = supporters(s);
      for (const i of sup) {
        for (const j of sup) {
          if (j <= i) continue;
          pairs++;
          const p = s.players[i]!, q = s.players[j]!;
          expect(Math.hypot(p.tgtX - q.tgtX, p.tgtZ - q.tgtZ)).toBeGreaterThanOrEqual(T.hardSeparation - 1e-9);
        }
      }
    }
    expect(pairs).toBeGreaterThan(3000);
  });
});

describe('TAI-02 budget', () => {
  it('assignSupport (incl. resetJobs and an active call) < 0.05 ms per tick', () => {
    const s = build();
    s.players[6]!.x = -14; s.players[6]!.z = 10;
    const fn = (): void => {
      s.teams[0]!.supportSlot = 6; s.teams[0]!.supportCallT = 60;
      resetJobs(s, 0);
      assignSupport(s, 0, NULL_SINK);
    };
    for (let i = 0; i < 3000; i++) fn();
    let best = Infinity;
    for (let b = 0; b < 7; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) fn();
      best = Math.min(best, (performance.now() - t0) / 2000);
    }
    console.log(`TAI-02 assignSupport: ${(best * 1000).toFixed(1)} us/tick`);
    expect(best).toBeLessThan(0.05);
  });
  it('allocates nothing per tick (child process with --expose-gc)', () => {
    const code = `
      import './tools/lib/env.ts';
      import './src/sim/actions/dispatch.ts';
      const { makeScenario } = await import('./tests/harness/scenario.ts');
      const { assignSupport } = await import('./src/ai/support.ts');
      const { resetJobs } = await import('./src/ai/jobs.ts');
      const { NULL_SINK } = await import('./src/sim/core/events.ts');
      const s = makeScenario({ phase: 2, humans: 0 });
      const pos = ${JSON.stringify([...HOME_442, ...AWAY_BLOCK].map((sp) => [sp[2], sp[3]]))};
      for (let i = 0; i < 22; i++) { const p = s.players[i]; p.x = pos[i][0]; p.z = pos[i][1]; p.homeX = p.x; p.homeZ = p.z; }
      s.ball.owner = 7; s.players[7].ctrl = 2; s.ctrl[2].slot = 7; s.teams[0].phase = 1;
      const run = (t) => {
        const c = s.players[7]; c.x = ((t % 200) - 100) * 0.2; c.z = -4 + ((t % 37) - 18) * 0.1; s.ball.x = c.x; s.ball.z = c.z;
        if (t % 150 === 0) { s.teams[0].supportSlot = 6; s.teams[0].supportCallT = 120; }
        s.teams[0].phase = (t >> 6) & 1;
        resetJobs(s, 0); assignSupport(s, 0, NULL_SINK);
      };
      for (let t = 0; t < 5000; t++) run(t);
      const N = 20000; let best = Infinity;
      for (let rep = 0; rep < 6; rep++) {
        globalThis.gc(); const h0 = process.memoryUsage().heapUsed;
        for (let t = 0; t < N; t++) run(t);
        best = Math.min(best, (process.memoryUsage().heapUsed - h0) / N);
      }
      console.log(JSON.stringify({ bytesPerTick: best }));
    `;
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 120_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const { bytesPerTick } = JSON.parse(r.stdout.trim().split('\n').pop()!) as { bytesPerTick: number };
    console.log(`TAI-02 assignSupport: ${bytesPerTick.toFixed(2)} bytes/tick`);
    expect(bytesPerTick).toBeLessThan(24);
  }, 150_000);
});

