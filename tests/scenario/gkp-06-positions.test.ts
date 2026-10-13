/**
 * [GKP-06] Keeper positions per set-piece kind through the real step pipeline (awardRestart -> RUL-11 / kind
 * modules / TAI-13 / keeperTick), both ends and both attack directions: corners (line, far post, facing the ball),
 * free kicks (side the wall does not cover, depth by distance, always legal), throw-ins and kick-offs (GKP-01),
 * goal kicks (he is the taker and walks to the ball), human keepers left alone.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_AREA_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM, RESTART_DISTANCE, teamFirstSlot,
} from '../../src/contracts/constants';
import { ActionKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { NULL_SINK } from '../../src/sim/core/events';
import { idealKeeperSpot } from '../../src/sim/keeper/positioning';
import {
  cornerKeeperSpot, freeKickKeeperSpot, keeperSetPieceSpot, LOCAL_TUNING as LT, SpotKind, wallShadow,
} from '../../src/sim/keeper/setpieces';
import { awardRestart, isLegalRestartPosition } from '../../src/sim/rules/restart';
import { T_RULES } from '../../src/contracts/tuning';
import { makeScenario, runTicks, runUntil, type ScenarioHuman } from '../harness/scenario';

interface Scene { s: SimState; attack: number; def: number; keeper: number; end: number; own: number }

/** In play, a human on the attacking side (so the restart waits 12 s for him), optional second human. */
function scene(seed: number, attack: number, swap: boolean, extra: ScenarioHuman[] = []): Scene {
  const def = attack === 0 ? 1 : 0;
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, humans: [{ side: attack }, ...extra], teams: swap ? [{ dir: -1 }, { dir: 1 }] : undefined,
  });
  if (swap) mirror(s);
  const end = s.teams[attack]!.dir;
  return { s, attack, def, keeper: s.teams[def]!.keeperSlot, end, own: end };
}

/** Second-half directions: everybody to the other end (initMatch placed them for the first half). */
function mirror(s: SimState): void {
  for (const p of s.players) { p.x = -p.x; p.fx = -p.fx; }
}

function dist(s: SimState, slot: number, x: number, z: number): number {
  const p = s.players[slot]!;
  return Math.hypot(p.x - x, p.z - z);
}

const ENDS: [number, boolean][] = [[0, false], [1, false], [0, true], [1, true]];

describe('GKP-06 corners', () => {
  it.each(ENDS)('attack %i swap %s: on his line toward the far post, facing the ball, both corners', (attack, swap) => {
    for (const sz of [1, -1]) {
      const sc = scene(4, attack, swap);
      const { s, keeper, end } = sc;
      s.players[keeper]!.x = end * (HALF_LENGTH - 6);
      s.players[keeper]!.z = sz * 3;
      awardRestart(s, RestartKind.CORNER, attack, end * HALF_LENGTH, sz * HALF_WIDTH, NULL_SINK);
      expect(s.match.phase).toBe(MatchPhase.CORNER);
      runTicks(s, 200, undefined, { check: 'core' });
      expect(s.match.phase).toBe(MatchPhase.CORNER);
      const spot = { x: 0, z: 0 };
      expect(keeperSetPieceSpot(s, sc.def, spot)).toBe(SpotKind.SET);
      cornerKeeperSpot(s, sc.def, TMP);
      expect(spot).toEqual(TMP);
      // On his line (cornerDepth off it), on the far-post side of the goal centre.
      expect(spot.x).toBeCloseTo(end * (HALF_LENGTH - LT.cornerDepth), 6);
      expect(spot.z).toBeCloseTo(-sz * LT.cornerFarZ, 6);
      const p = s.players[keeper]!;
      expect(dist(s, keeper, spot.x, spot.z)).toBeLessThan(0.35);
      expect(p.act).toBe(ActionKind.NONE); // free: GKP-03 can claim the cross at once
      expect(p.lookAt).toBe(1);
      expect(p.lookX).toBeCloseTo(s.ball.x, 6);
      expect(p.lookZ).toBeCloseTo(s.ball.z, 6);
      // The attacking keeper keeps his open-play spot at the other end.
      const ak = s.teams[attack]!.keeperSlot;
      idealKeeperSpot(s, attack, TMP);
      expect(dist(s, ak, TMP.x, TMP.z)).toBeLessThan(1.0);
    }
  });
});

const TMP = { x: 0, z: 0 };
const SH = { lo: 0, hi: 0 };

/** Award a free kick. RUL-05 builds its own wall when it is implemented; otherwise (Wave 1 stub) the test gives it a
 *  wall of n defenders of `def` the way RUL-05 documents it (the wall on the ball -> near-post line, 9.15 m away). */
function freeKickWithWall(sc: Scene, u: number, z: number, n: number): void {
  const { s, attack, def, end } = sc;
  const bx = end * (HALF_LENGTH - u);
  awardRestart(s, RestartKind.FREE_KICK, attack, bx, z, NULL_SINK);
  expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
  const r = s.match.restart;
  if (r.wallCount > 0) return; // RUL-05's own wall
  if (n > 0) {
    const nz = z >= 0 ? GOAL_HALF_WIDTH - 0.5 : -GOAL_HALF_WIDTH + 0.5; // near post side
    const dx = end * HALF_LENGTH - r.x, dz = nz - r.z;
    const d = Math.hypot(dx, dz);
    r.wallCount = n;
    r.wallX = r.x + (dx / d) * RESTART_DISTANCE;
    r.wallZ = r.z + (dz / d) * RESTART_DISTANCE;
    const first = teamFirstSlot(def);
    for (let i = 0; i < n; i++) r.wall[i] = first + 2 + i;
  }
}

describe('GKP-06 free kicks', () => {
  it.each(ENDS)('attack %i swap %s: wall on the near post -> keeper on the uncovered side, legal, facing the ball', (attack, swap) => {
    for (const z of [7, -7]) {
      const sc = scene(5, attack, swap);
      const { s, keeper, def, end } = sc;
      s.players[keeper]!.x = end * (HALF_LENGTH - 2);
      s.players[keeper]!.z = 0;
      freeKickWithWall(sc, 21, z, 4);
      runTicks(s, 180, undefined, { check: 'core' });
      expect(s.match.phase).toBe(MatchPhase.FREE_KICK);
      const spot = { x: 0, z: 0 };
      expect(keeperSetPieceSpot(s, def, spot)).toBe(SpotKind.SET);
      expect(dist(s, keeper, spot.x, spot.z)).toBeLessThan(0.35);
      // The shadow of the wall covers the near post; he stands on the other side of it.
      expect(wallShadow(s, s.teams[def]!.dir, SH)).toBe(1);
      const sgn = z > 0 ? 1 : -1;
      if (sgn > 0) expect(SH.hi).toBeGreaterThan(GOAL_HALF_WIDTH - 0.5);
      else expect(SH.lo).toBeLessThan(-GOAL_HALF_WIDTH + 0.5);
      // His projection on the goal line from the ball lies outside the shadow, on the far side.
      const p = s.players[keeper]!;
      const ub = HALF_LENGTH + s.teams[def]!.dir * s.ball.x;
      const uk = HALF_LENGTH + s.teams[def]!.dir * p.x;
      const zl = s.ball.z + (p.z - s.ball.z) * (ub / (ub - uk));
      expect(Math.sign(zl - 0.5 * (SH.lo + SH.hi))).toBe(-sgn); // the side the wall does not cover
      expect(Math.abs(zl)).toBeLessThan(GOAL_HALF_WIDTH);
      expect(Math.hypot(p.x - s.ball.x, p.z - s.ball.z)).toBeGreaterThan(RESTART_DISTANCE);
      expect(isLegalRestartPosition(s, keeper)).toBe(true);
      expect(p.lookAt).toBe(1);
    }
  });

  it('depth grows with the distance of the free kick', () => {
    const depths: number[] = [];
    for (const u of [14, 20, 26, 32]) {
      const sc = scene(6, 0, false);
      freeKickWithWall(sc, u, 3, 3);
      expect(freeKickKeeperSpot(sc.s, sc.def, TMP)).toBe(1);
      depths.push(HALF_LENGTH + sc.s.teams[sc.def]!.dir * TMP.x);
    }
    for (let i = 1; i < depths.length; i++) expect(depths[i]!).toBeGreaterThan(depths[i - 1]!);
    expect(depths[0]!).toBeGreaterThanOrEqual(LT.minLineDist);
    expect(depths[3]!).toBeLessThanOrEqual(LT.fkDepthFar + 1e-9);
  });

  it('no wall: GKP-01 open-play spot for the ball (made legal)', () => {
    const sc = scene(6, 1, false);
    awardRestart(sc.s, RestartKind.FREE_KICK, 1, sc.end * (HALF_LENGTH - 30), 12, NULL_SINK);
    sc.s.match.restart.wallCount = 0; // (RUL-05 may build a 2-man wall here)
    expect(freeKickKeeperSpot(sc.s, sc.def, TMP)).toBe(1);
    idealKeeperSpot(sc.s, sc.def, SPOT2);
    expect(TMP.x).toBeCloseTo(SPOT2.x, 6);
    expect(TMP.z).toBeCloseTo(SPOT2.z, 6);
  });

  it('far from goal (beyond fkMaxDist): open-play positioning', () => {
    const sc = scene(6, 0, false);
    awardRestart(sc.s, RestartKind.FREE_KICK, 0, sc.end * (HALF_LENGTH - 45), 0, NULL_SINK);
    expect(keeperSetPieceSpot(sc.s, sc.def, TMP)).toBe(SpotKind.OPEN);
  });

  // Glitch list, Restarts: "opponents inside the required distance blocking forever" (keeper variant): his spot is
  // always legal, so RUL-11 never has to push him and he never fights its push.
  it.each([
    [7, 0, 3], [7, 0, -9], [6, 1, 12], [9.4, 0, 0], [9.6, 1, 2], [10.5, 0, -1], [12, 1, 5],
  ])('glitch "opponents inside the required distance blocking forever": free kick %f m out (attack %i, z %f) - keeper legal every tick', (u, attack, z) => {
    const sc = scene(8, attack, false);
    const { s, keeper, end } = sc;
    s.players[keeper]!.x = end * (HALF_LENGTH - 3);
    s.players[keeper]!.z = -z * 0.3;
    freeKickWithWall(sc, u, z, u < RESTART_DISTANCE ? 0 : 3);
    const r = s.match.restart;
    let illegalAfterReady = 0;
    runTicks(s, 300, undefined, {
      check: 'core',
      until: (st) => {
        if (st.match.phase !== MatchPhase.FREE_KICK) return true;
        if (r.ready === 1 && r.t > T_RULES.restartSetupTicks + 90 && !isLegalRestartPosition(st, keeper)) illegalAfterReady++;
        return false;
      },
    });
    expect(illegalAfterReady).toBe(0);
    expect(freeKickKeeperSpot(s, sc.def, TMP)).toBe(1);
    expect(dist(s, keeper, TMP.x, TMP.z)).toBeLessThan(0.4);
    const p = s.players[keeper]!;
    const depth = HALF_LENGTH + s.teams[sc.def]!.dir * p.x;
    expect(depth).toBeGreaterThan(0); // never behind his line
    const far = Math.hypot(p.x - s.ball.x, p.z - s.ball.z) > RESTART_DISTANCE;
    // Within 9.15 m of the line: outside the circle or on his goal line between the posts (the legal places).
    if (u < RESTART_DISTANCE && !far) {
      expect(depth).toBeLessThan(0.7);
      expect(Math.abs(p.z)).toBeLessThan(GOAL_HALF_WIDTH);
    } else {
      expect(far).toBe(true);
    }
  });
});

const SPOT2 = { x: 0, z: 0 };

describe('GKP-06 throw-ins, kick-offs, goal kicks', () => {
  it.each(ENDS)('attack %i swap %s: throw-in near his goal -> GKP-01 spot for the ball', (attack, swap) => {
    const sc = scene(9, attack, swap);
    const { s, def, keeper, end } = sc;
    awardRestart(s, RestartKind.THROW_IN, attack, end * (HALF_LENGTH - 20), HALF_WIDTH, NULL_SINK);
    expect(s.match.phase).toBe(MatchPhase.THROW_IN);
    runTicks(s, 160, undefined, { check: 'core' });
    expect(keeperSetPieceSpot(s, def, TMP)).toBe(SpotKind.OPEN);
    idealKeeperSpot(s, def, TMP);
    expect(dist(s, keeper, TMP.x, TMP.z)).toBeLessThan(0.5);
  });

  it.each([0, 1])('kick-off (human side %i waits): both keepers in goal', (team) => {
    const s = makeScenario({ seed: 10, humans: [{ side: team }], match: { kickoffTeam: team, firstKickoffTeam: team } });
    const r = runUntil(s, (st) => st.match.phase === MatchPhase.KICK_OFF, 900, undefined, 'core');
    expect(r.reached).toBe(true);
    for (let t = 0; t < 2; t++) { // start them off their spots
      const p = s.players[s.teams[t]!.keeperSlot]!;
      p.x = -s.teams[t]!.dir * (HALF_LENGTH - 9);
      p.z = 3;
    }
    runTicks(s, 200, undefined, { check: 'core' });
    expect(s.match.phase).toBe(MatchPhase.KICK_OFF);
    for (let t = 0; t < 2; t++) {
      const k = s.teams[t]!.keeperSlot;
      const p = s.players[k]!;
      const depth = HALF_LENGTH + s.teams[t]!.dir * p.x;
      expect(depth).toBeGreaterThan(0.2);
      expect(depth).toBeLessThan(GOAL_AREA_DEPTH);
      expect(Math.abs(p.z)).toBeLessThan(1.0);
    }
  });

  it.each(ENDS)('attack %i swap %s: own goal kick - he is the taker and walks to the ball, then RUL-11 / RUL-03 own him', (kicking, swap) => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 11, humans: [{ side: kicking }], teams: swap ? [{ dir: -1 }, { dir: 1 }] : undefined });
    if (swap) mirror(s);
    const k = s.teams[kicking]!.keeperSlot;
    const own = -s.teams[kicking]!.dir;
    s.players[k]!.x = own * (HALF_LENGTH - 1.5);
    s.players[k]!.z = 0;
    awardRestart(s, RestartKind.GOAL_KICK, kicking, own * HALF_LENGTH, 8, NULL_SINK);
    expect(s.match.phase).toBe(MatchPhase.GOAL_KICK);
    const r = s.match.restart;
    expect(r.taker).toBe(k);
    expect(keeperSetPieceSpot(s, kicking, TMP)).toBe(SpotKind.TAKER);
    const d0 = dist(s, k, TMP.x, TMP.z);
    let prev = d0;
    let closer = 0;
    runTicks(s, 45, undefined, {
      check: 'core',
      until: (st) => { const d = dist(st, k, TMP.x, TMP.z); if (d < prev - 1e-9) closer++; prev = d; return false; },
    });
    expect(r.ready).toBe(0);
    const d1 = dist(s, k, TMP.x, TMP.z);
    expect(d1).toBeLessThan(d0 - 1.0); // on his way during the setup
    expect(closer).toBeGreaterThan(40); // every tick (after the first) closer
    runTicks(s, 45, undefined, { check: 'core' });
    expect(r.ready).toBe(1);
    expect(s.players[k]!.act).toBe(ActionKind.SET_PIECE);
    expect(dist(s, k, r.x, r.z)).toBeLessThan(1.0);
    // The other keeper keeps his open-play spot.
    const o = s.teams[kicking === 0 ? 1 : 0]!.keeperSlot;
    idealKeeperSpot(s, kicking === 0 ? 1 : 0, TMP);
    expect(dist(s, o, TMP.x, TMP.z)).toBeLessThan(1.0);
  });
});

describe('GKP-06 human keepers', () => {
  it('a human controlling his keeper at a corner is left alone (no AI steering)', () => {
    const def = 1;
    const k = teamFirstSlot(def);
    const sc = scene(12, 0, false, [{ side: def, slot: k }]);
    const { s, end } = sc;
    s.players[k]!.x = end * (HALF_LENGTH - 3);
    s.players[k]!.z = 2;
    awardRestart(s, RestartKind.CORNER, 0, end * HALF_LENGTH, HALF_WIDTH, NULL_SINK);
    runTicks(s, 3, undefined, { check: 'core' });
    expect(s.ctrl[1]!.slot).toBe(k);
    runTicks(s, 120, undefined, { check: 'core' });
    expect(dist(s, k, end * (HALF_LENGTH - 3), 2)).toBeLessThan(0.3);
    expect(s.players[k]!.moveMode).not.toBe(2 /* ARRIVE */);
    expect(k).toBeLessThan(PLAYERS_PER_TEAM * 2);
  });
});
