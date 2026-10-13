/**
 * [GKP-06] Pure parts of the keeper-at-set-pieces module: spot geometry (corners, penalties, free kicks with and
 * without a wall, legality), the AI dive choice (weights by foot, composure, history; kick-keyed determinism), human
 * choice decoding, dive targets and the contact-tick predicate.
 */
import { describe, expect, it } from 'vitest';
import {
  GOAL_HALF_WIDTH, HALF_LENGTH, RESTART_DISTANCE, teamFirstSlot,
} from '../../src/contracts/constants';
import { ActionKind, Foot, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { initMatch } from '../../src/sim/init';
import { keeperMaxReach } from '../../src/sim/keeper/saves';
import {
  aiDiveChoice, aiDiveChoiceFrom, cornerKeeperSpot, createDiveChoice, freeKickKeeperSpot, humanDiveChoice,
  keeperSetPieceSpot, kickContactThisTick, LOCAL_TUNING as LT, penaltyContactTick, penaltyDiveTarget,
  penaltyKeeperSpot, SpotKind, wallShadow,
} from '../../src/sim/keeper/setpieces';

function state(dir0 = 1): SimState {
  const s = initMatch(createMatchConfig());
  s.teams[0]!.dir = dir0;
  s.teams[1]!.dir = -dir0;
  return s;
}

/** A restart of `kind` for `team` at (x, z) written straight into the record (pure-function tests). */
function restart(s: SimState, kind: RestartKind, phase: MatchPhase, team: number, x: number, z: number): void {
  const m = s.match;
  m.phase = phase;
  const r = m.restart;
  r.kind = kind; r.team = team; r.x = x; r.z = z; r.taker = teamFirstSlot(team) + 9; r.ready = 1; r.taken = 0;
  r.wallCount = 0; r.wall.fill(-1); r.wallX = 0; r.wallZ = 0; r.side = 0; r.aimPower = 0;
  s.ball.x = x; s.ball.z = z;
}

/** A wall of n members on the line ball -> (goal line, zAim), 9.15 m from the ball, for the defending team. */
function wall(s: SimState, def: number, n: number, zAim: number): void {
  const r = s.match.restart;
  const gx = -s.teams[def]!.dir * HALF_LENGTH;
  const dx = gx - r.x, dz = zAim - r.z;
  const d = Math.hypot(dx, dz);
  r.wallCount = n;
  r.wallX = r.x + (dx / d) * RESTART_DISTANCE;
  r.wallZ = r.z + (dz / d) * RESTART_DISTANCE;
  for (let i = 0; i < n; i++) r.wall[i] = teamFirstSlot(def) + 1 + i;
}

const OUT = { x: 0, z: 0 };
const SH = { lo: 0, hi: 0 };

describe('GKP-06 spots', () => {
  it.each([1, -1])('penalty / corner spots for both teams (dir0 %i)', (dir0) => {
    for (const def of [0, 1]) {
      const s = state(dir0);
      const own = -s.teams[def]!.dir;
      penaltyKeeperSpot(s, def, OUT);
      expect(OUT.x).toBeCloseTo(own * (HALF_LENGTH - LT.penLineDepth), 9);
      expect(OUT.z).toBe(0);
      for (const sz of [1, -1]) {
        restart(s, RestartKind.CORNER, MatchPhase.CORNER, 1 - def, own * (HALF_LENGTH - 0.5), sz * 33.5);
        cornerKeeperSpot(s, def, OUT);
        expect(OUT.x).toBeCloseTo(own * (HALF_LENGTH - LT.cornerDepth), 9);
        expect(OUT.z).toBeCloseTo(-sz * LT.cornerFarZ, 9); // toward the far post
        expect(keeperSetPieceSpot(s, def, OUT)).toBe(SpotKind.SET);
        expect(keeperSetPieceSpot(s, 1 - def, OUT)).toBe(SpotKind.OPEN); // the attacking keeper: open play
      }
    }
  });

  it('kinds without a set-piece spot are OPEN (GKP-01): kick-off, throw-in, goal kick he does not take, outside restarts', () => {
    const s = state();
    restart(s, RestartKind.THROW_IN, MatchPhase.THROW_IN, 1, -30, 34);
    expect(keeperSetPieceSpot(s, 0, OUT)).toBe(SpotKind.OPEN);
    restart(s, RestartKind.KICK_OFF, MatchPhase.KICK_OFF, 0, 0, 0);
    expect(keeperSetPieceSpot(s, 0, OUT)).toBe(SpotKind.OPEN);
    expect(keeperSetPieceSpot(s, 1, OUT)).toBe(SpotKind.OPEN);
    restart(s, RestartKind.GOAL_KICK, MatchPhase.GOAL_KICK, 1, 47, 6);
    expect(keeperSetPieceSpot(s, 0, OUT)).toBe(SpotKind.OPEN);
    s.match.restart.taker = s.teams[1]!.keeperSlot; // he takes it
    expect(keeperSetPieceSpot(s, 1, OUT)).toBe(SpotKind.TAKER);
    expect(Math.hypot(OUT.x - 47, OUT.z - 6)).toBeLessThan(1.0); // behind the ball
    s.match.phase = MatchPhase.IN_PLAY;
    expect(keeperSetPieceSpot(s, 1, OUT)).toBe(SpotKind.OPEN);
    s.match.phase = MatchPhase.CORNER; // stale record (kind does not match the phase)
    expect(keeperSetPieceSpot(s, 1, OUT)).toBe(SpotKind.OPEN);
  });

  it('shoot-out: the defending keeper on his line centre, the waiting keeper holds, the kicker none', () => {
    const s = state();
    s.match.phase = MatchPhase.SHOOT_OUT;
    const so = s.match.shootout;
    so.active = 1; so.team = 0; so.kicker = 9; so.keeper = s.teams[1]!.keeperSlot;
    expect(keeperSetPieceSpot(s, 1, OUT)).toBe(SpotKind.SET);
    expect(OUT.x).toBeCloseTo(HALF_LENGTH - LT.penLineDepth, 9);
    expect(keeperSetPieceSpot(s, 0, OUT)).toBe(SpotKind.HOLD);
    so.kicker = s.teams[0]!.keeperSlot;
    expect(keeperSetPieceSpot(s, 0, OUT)).toBe(SpotKind.OPEN);
    so.active = 0;
    expect(keeperSetPieceSpot(s, 1, OUT)).toBe(SpotKind.OPEN);
  });
});

describe('GKP-06 free kicks (pure)', () => {
  it.each([[1, 1], [1, -1], [-1, 1], [-1, -1]])('dir0 %i, side %i: the wall shadows the near post, he takes the far side', (dir0, side) => {
    for (const def of [0, 1]) {
      const s = state(dir0);
      const own = -s.teams[def]!.dir;
      const u = 22;
      restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1 - def, own * (HALF_LENGTH - u), side * 6);
      wall(s, def, 4, side * (GOAL_HALF_WIDTH - 0.4));
      expect(wallShadow(s, s.teams[def]!.dir, SH)).toBe(1);
      // The shadow reaches the near post.
      if (side > 0) expect(SH.hi).toBeGreaterThan(GOAL_HALF_WIDTH - 0.3); else expect(SH.lo).toBeLessThan(-GOAL_HALF_WIDTH + 0.3);
      expect(freeKickKeeperSpot(s, def, OUT)).toBe(1);
      // His goal-line point (where the line from the ball through him meets the line) is on the open side.
      const ub = HALF_LENGTH - own * s.match.restart.x;
      const uk = HALF_LENGTH - own * OUT.x;
      const zl = s.match.restart.z + (OUT.z - s.match.restart.z) * (ub / (ub - uk));
      expect(Math.sign(zl - 0.5 * (SH.lo + SH.hi))).toBe(-side);
      if (side > 0 && SH.lo > -GOAL_HALF_WIDTH + 2) expect(zl).toBeLessThan(SH.lo);
      if (side < 0 && SH.hi < GOAL_HALF_WIDTH - 2) expect(zl).toBeGreaterThan(SH.hi);
      expect(Math.abs(zl)).toBeLessThan(GOAL_HALF_WIDTH);
      expect(uk).toBeGreaterThanOrEqual(LT.minLineDist);
      expect(Math.hypot(OUT.x - s.match.restart.x, OUT.z - s.match.restart.z)).toBeGreaterThan(RESTART_DISTANCE + LT.legalMargin - 1e-9);
      // Mirror symmetry: the same free kick on the other side gives the mirrored spot.
      const s2 = state(dir0);
      restart(s2, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1 - def, own * (HALF_LENGTH - u), -side * 6);
      wall(s2, def, 4, -side * (GOAL_HALF_WIDTH - 0.4));
      const o2 = { x: 0, z: 0 };
      freeKickKeeperSpot(s2, def, o2);
      expect(o2.x).toBeCloseTo(OUT.x, 9);
      expect(o2.z).toBeCloseTo(-OUT.z, 9);
    }
  });

  it('a central free kick with a wall to one side: he stands on the open side, nearer the centre than its middle', () => {
    const s = state();
    restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + 20, 0);
    wall(s, 0, 3, 2.2);
    wallShadow(s, 1, SH);
    expect(SH.lo).toBeGreaterThan(-1);
    expect(freeKickKeeperSpot(s, 0, OUT)).toBe(1);
    expect(OUT.z).toBeLessThan(0);
    const mid = 0.5 * (SH.lo - GOAL_HALF_WIDTH); // middle of the open part
    expect(OUT.z).toBeGreaterThan(mid); // a ball over the wall into the covered part is still in reach
    // The weighted centre of the mouth (open 1, shadowed fkShadowWeight), on the line toward the ball.
    const lo = SH.lo, hi = Math.min(SH.hi, GOAL_HALF_WIDTH), cut = 1 - LT.fkShadowWeight;
    const anchor = (-cut * 0.5 * (hi * hi - lo * lo)) / (2 * GOAL_HALF_WIDTH - cut * (hi - lo));
    expect(OUT.z).toBeCloseTo(anchor, 6); // central ball: the spot keeps the anchor's z (the line is along x)
  });

  it('the spot moves continuously as the wall is moved sideways (no jumps)', () => {
    const s = state();
    restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + 21, 4);
    s.attrs[0]!.gkPositioning = 99;
    let prev = { x: 0, z: 0 };
    let maxJump = 0;
    for (let i = 0; i <= 200; i++) {
      wall(s, 0, 5, -5 + i * 0.05);
      freeKickKeeperSpot(s, 0, OUT);
      if (i > 0) maxJump = Math.max(maxJump, Math.hypot(OUT.x - prev.x, OUT.z - prev.z));
      prev = { x: OUT.x, z: OUT.z };
    }
    expect(maxJump).toBeLessThan(0.1);
  });

  it('a wall covering the whole mouth (wide free kick): near the line from the goal centre to the ball', () => {
    const s = state();
    restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + 10, 16);
    wall(s, 0, 4, 1);
    expect(wallShadow(s, 1, SH)).toBe(1);
    expect(SH.lo).toBeLessThan(-GOAL_HALF_WIDTH);
    expect(SH.hi).toBeGreaterThan(GOAL_HALF_WIDTH);
    freeKickKeeperSpot(s, 0, OUT);
    const u = OUT.x + HALF_LENGTH;
    expect(u).toBeGreaterThan(LT.minLineDist);
    const anchor = (OUT.z * 10 - 16 * u) / (10 - u); // his goal-line point (line from the ball through him)
    expect(Math.abs(anchor)).toBeLessThan(1e-6); // fully shadowed mouth: its centre
    // A record claiming more members than the wall holds is read as a full wall (5).
    s.match.restart.wallCount = 40;
    expect(wallShadow(s, 1, SH)).toBe(1);
    expect(SH.hi - SH.lo).toBeLessThan(40);
  });

  it('an unusable planned wall centre falls back to the members; no members and no centre = no wall', () => {
    const s = state();
    restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + 22, 5);
    wall(s, 0, 3, 3.2);
    const r = s.match.restart;
    const cx = r.wallX, cz = r.wallZ;
    for (let i = 0; i < 3; i++) { const q = s.players[r.wall[i]!]!; q.x = cx; q.z = cz + (i - 1) * 0.7; }
    expect(wallShadow(s, 1, SH)).toBe(1);
    const lo = SH.lo, hi = SH.hi;
    r.wallX = 0; r.wallZ = 0; // garbage planned centre
    expect(wallShadow(s, 1, SH)).toBe(1);
    expect(SH.lo).toBeCloseTo(lo, 6);
    expect(SH.hi).toBeCloseTo(hi, 6);
    r.wall.fill(-1);
    expect(wallShadow(s, 1, SH)).toBe(0);
    // A wall behind the ball does not count.
    r.wallX = r.x + 9; r.wallZ = r.z; r.wall[0] = 3;
    s.players[3]!.x = r.x + 9; s.players[3]!.z = r.z;
    expect(wallShadow(s, 1, SH)).toBe(0);
  });

  it('close free kicks: on the goal line between the posts (ball nearer than 9.15 m to the line), else outside the circle', () => {
    const s = state();
    for (const [u, z] of [[6, 0], [7, -4], [8.5, 9], [9.3, 0], [9.6, 1], [11, -2]] as const) {
      restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + u, z);
      expect(freeKickKeeperSpot(s, 0, OUT)).toBe(1);
      const depth = OUT.x + HALF_LENGTH;
      const d = Math.hypot(OUT.x - (-HALF_LENGTH + u), OUT.z - z);
      expect(depth).toBeGreaterThanOrEqual(LT.minLineDist - 1e-9);
      if (d < RESTART_DISTANCE) {
        expect(u).toBeLessThan(RESTART_DISTANCE);
        expect(depth).toBeCloseTo(LT.lineDepth, 9);
        expect(Math.abs(OUT.z)).toBeLessThanOrEqual(GOAL_HALF_WIDTH - LT.lineInsidePost + 1e-9);
      } else {
        expect(d).toBeGreaterThan(RESTART_DISTANCE + LT.legalMargin - 1e-6);
      }
    }
  });

  it('beyond fkMaxDist there is no free-kick spot', () => {
    const s = state();
    restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + LT.fkMaxDist + 1, 0);
    expect(freeKickKeeperSpot(s, 0, OUT)).toBe(0);
    expect(keeperSetPieceSpot(s, 0, OUT)).toBe(SpotKind.OPEN);
  });

  it('a poor positioning keeper under-shifts toward the centre', () => {
    const s = state();
    restart(s, RestartKind.FREE_KICK, MatchPhase.FREE_KICK, 1, -HALF_LENGTH + 20, 6);
    wall(s, 0, 4, 3.3);
    s.attrs[0]!.gkPositioning = 99;
    freeKickKeeperSpot(s, 0, OUT);
    const good = OUT.z;
    s.attrs[0]!.gkPositioning = 1;
    freeKickKeeperSpot(s, 0, OUT);
    expect(Math.abs(OUT.z)).toBeLessThan(Math.abs(good));
  });
});

describe('GKP-06 dive choice', () => {
  const N = 200;
  function grid(natural: number, hist: number, comp: number): { mid: number; nat: number; other: number; h: number[] } {
    const c = createDiveChoice();
    let mid = 0, nat = 0, other = 0;
    const h = [0, 0, 0];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        aiDiveChoiceFrom((i + 0.5) / N, (j + 0.5) / N, natural, hist, comp, c);
        if (c.side === 0) mid++; else if (c.side === natural) nat++; else other++;
        h[c.height]!++;
      }
    }
    return { mid: mid / (N * N), nat: nat / (N * N), other: other / (N * N), h: h.map((v) => v / (N * N)) };
  }

  it('weights: middle, natural side by composure, heights', () => {
    const lo = grid(1, 0, 1);
    expect(lo.mid).toBeCloseTo(LT.aiMiddleChance, 2);
    expect(lo.nat).toBeCloseTo((1 - LT.aiMiddleChance) * LT.aiNaturalWorst, 2);
    const hi = grid(-1, 0, 99);
    expect(hi.nat).toBeCloseTo((1 - LT.aiMiddleChance) * LT.aiNaturalBest, 2);
    expect(hi.nat).toBeGreaterThan(hi.other);
    expect(lo.h[0]!).toBeCloseTo(LT.aiLowChance, 2);
    expect(lo.h[1]!).toBeCloseTo(LT.aiMidChance, 2);
    expect(lo.h[2]!).toBeCloseTo(1 - LT.aiLowChance - LT.aiMidChance, 2);
  });

  it('history moves the side chance toward the previous side', () => {
    const none = grid(1, 0, 50);
    const same = grid(1, 1, 50);
    const opp = grid(1, -1, 50);
    expect(same.nat - none.nat).toBeCloseTo((1 - LT.aiMiddleChance) * LT.aiHistoryWeight, 2);
    expect(none.nat - opp.nat).toBeCloseTo((1 - LT.aiMiddleChance) * LT.aiHistoryWeight, 2);
  });

  it('aiDiveChoice: natural side by foot and end, deterministic per kick, s.rng untouched, varies across kicks', () => {
    for (const dir0 of [1, -1]) {
      const s = state(dir0);
      const keeper = s.teams[1]!.keeperSlot;
      const kicker = 9;
      const end = -s.teams[1]!.dir; // the goal the kicker attacks
      for (const foot of [Foot.RIGHT, Foot.LEFT]) {
        s.attrs[kicker]!.foot = foot;
        s.attrs[kicker]!.composure = 1;
        const natural = foot === Foot.LEFT ? end : -end;
        const rng = { ...s.rng };
        const c = createDiveChoice(), c2 = createDiveChoice();
        let nat = 0, opp = 0, mid = 0;
        const sides = new Set<number>();
        for (let t = 100; t < 1100; t++) {
          aiDiveChoice(s, kicker, keeper, t, c);
          aiDiveChoice(s, kicker, keeper, t, c2);
          expect(c2).toEqual(c);
          sides.add(c.side);
          if (c.side === 0) mid++; else if (c.side === natural) nat++; else opp++;
        }
        expect(s.rng).toEqual(rng);
        expect(sides.size).toBe(3);
        expect(nat).toBeGreaterThan(opp * 1.4);
        expect(mid).toBeGreaterThan(50);
        expect(mid).toBeLessThan(160);
      }
    }
  });

  it('another seed gives other choices for the same kick ticks', () => {
    const a = state();
    const sb = initMatch({ ...createMatchConfig(), seed: 99 });
    const ca = createDiveChoice(), cb = createDiveChoice();
    let diff = 0;
    for (let t = 0; t < 200; t++) {
      aiDiveChoice(a, 9, 11, t, ca);
      aiDiveChoice(sb, 9, 11, t, cb);
      if (ca.side !== cb.side || ca.height !== cb.height) diff++;
    }
    expect(diff).toBeGreaterThan(80);
  });

  it('human choice decoding (restart.side / aimPower)', () => {
    const s = state();
    const c = createDiveChoice();
    const r = s.match.restart;
    for (const [side, ap, ws, wh] of [[1, 2, 1, 2], [-1, 0, -1, 0], [0, 1, 0, 1], [0.4, 1.4, 1, 1], [-3, 7, -1, 2]] as const) {
      r.side = side; r.aimPower = ap;
      humanDiveChoice(s, c);
      expect([c.side, c.height]).toEqual([ws, wh]);
    }
  });
});

describe('GKP-06 dive target and contact tick', () => {
  it.each([1, -1])('dive target (dir0 %i): toward the side, forward of the line, inside reach and the post limit', (dir0) => {
    const s = state(dir0);
    const k = s.teams[1]!.keeperSlot;
    const own = -s.teams[1]!.dir;
    const p = s.players[k]!;
    p.x = own * (HALF_LENGTH - 0.3);
    const T = { x: 0, y: 0, z: 0 };
    for (const z0 of [0, 1.5, -2.5, 3.6]) {
      p.z = z0;
      for (const side of [1, -1]) {
        for (const h of [0, 1, 2]) {
          penaltyDiveTarget(s, k, side, h, T);
          expect(side * (T.z - z0)).toBeGreaterThanOrEqual(LT.minDiveLateral - 1e-9);
          expect(side * (T.z - z0)).toBeLessThanOrEqual(keeperMaxReach(s.attrs[k]!) + 1e-9);
          if (Math.abs(z0) < GOAL_HALF_WIDTH) expect(Math.abs(T.z)).toBeLessThanOrEqual(GOAL_HALF_WIDTH + LT.diveBeyondPost + 1e-9);
          expect(T.x).toBeCloseTo(p.x - own * LT.diveForward, 9); // toward the field
          expect(T.y).toBe(h === 0 ? LT.diveLowY : h === 1 ? LT.diveMidY : LT.diveHighY);
        }
      }
    }
  });

  it('kickContactThisTick follows the action contract (actT + 1 >= actContact, not charging, not done)', () => {
    const s = state();
    const p = s.players[9]!;
    p.act = ActionKind.SHOT; p.actT = 8; p.actContact = 10; p.actDone = 0; p.actCharging = 0;
    expect(kickContactThisTick(s, 9)).toBe(false);
    p.actT = 9;
    expect(kickContactThisTick(s, 9)).toBe(true);
    p.actCharging = 1;
    expect(kickContactThisTick(s, 9)).toBe(false);
    p.actCharging = 0; p.actDone = 1;
    expect(kickContactThisTick(s, 9)).toBe(false);
    p.actDone = 0; p.act = ActionKind.KICK;
    expect(kickContactThisTick(s, 9)).toBe(true);
    p.act = ActionKind.FAKE;
    expect(kickContactThisTick(s, 9)).toBe(false);
    p.act = ActionKind.SHOT; p.actContact = -1;
    expect(kickContactThisTick(s, 9)).toBe(false);
    expect(kickContactThisTick(s, -1)).toBe(false);
    expect(kickContactThisTick(s, 22)).toBe(false);
  });

  it('penaltyContactTick: struck this tick, about to strike, struck last tick (late only), otherwise -1', () => {
    const s = state();
    s.tick = 500;
    const b = s.ball;
    b.lastKickBy = 9; b.lastKickTick = 500;
    expect(penaltyContactTick(s, 9, false, false)).toBe(500);
    expect(penaltyContactTick(s, 8, true, true)).toBe(-1);
    b.lastKickTick = 499;
    expect(penaltyContactTick(s, 9, false, false)).toBe(-1);
    expect(penaltyContactTick(s, 9, false, true)).toBe(499);
    b.lastKickTick = 400;
    const p = s.players[9]!;
    p.act = ActionKind.SHOT; p.actT = 9; p.actContact = 10; p.actDone = 0; p.actCharging = 0;
    expect(penaltyContactTick(s, 9, true, false)).toBe(500);
    expect(penaltyContactTick(s, 9, false, true)).toBe(-1);
  });
});
