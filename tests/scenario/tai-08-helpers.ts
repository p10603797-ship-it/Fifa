/**
 * TAI-08 test doubles for the modules the carrier engine calls that are still stubs in Wave 1: TAI-09
 * scorePassOptions, TAI-10 estimateXg / bestDribble / chooseSkill, and (for whole-match runs) the SIM-09/10/11
 * starters. They follow the documented contracts with small, deterministic geometric models so the carrier's own
 * logic (scoring, commitment, execution through the InputFrame) can be tested now. Test-only code: plain Math is fine.
 *
 * Control: tests set fields of `CTL` (shared by the doubles) to force situations, e.g. CTL.passes = 'none'.
 */
import { GOAL_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, PLAYERS_PER_TEAM } from '../../src/contracts/constants';
import { ActionKind, KickKind, SkillMove } from '../../src/contracts/enums';
import type { EventSink } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { createKickLaunch, type ActionRequest, type StyleWeights } from '../../src/contracts/systems';
import type { PassOption } from '../../src/ai/cpu/passing';
import { applyKick } from '../../src/sim/core/kick';
import { inCrossingZone, inPenaltyArea } from '../../src/sim/pitch/geometry';

export interface StartRec { via: string; slot: number; kind: number; power: number; charging: number; dirX: number; dirZ: number;
  target: number; hasTarget: number; tx: number; tz: number; tick: number; flags: number }

export const CTL = {
  /** 'model' = geometric model; 'none' = no options; 'custom' = exactly CTL.custom. */
  passes: 'model' as 'model' | 'none' | 'custom',
  custom: [] as Omit<PassOption, 'score'>[],
  /** Forced team style weights (null = TAI-12 styleWeights). */
  style: null as StyleWeights | null,
  /** Forced xG (null = model). */
  xg: null as number | null,
  /** Forced skill move (null = model). */
  skill: null as number | null,
  /** Forced dribble score (null = model). */
  dribbleScore: null as number | null,
  /** Kick starters: 'record' = begin a charging action and record; 'kick' = launch the ball at once; 'refuse' = return 0. */
  starters: 'record' as 'record' | 'kick' | 'refuse',
  /** Calls of scorePassOptions (tick numbers). */
  scoreCalls: [] as number[],
  starts: [] as StartRec[],
};

export function resetCtl(): void {
  CTL.passes = 'model';
  CTL.custom.length = 0;
  CTL.style = null;
  CTL.xg = null;
  CTL.skill = null;
  CTL.dribbleScore = null;
  CTL.starters = 'record';
  CTL.scoreCalls.length = 0;
  CTL.starts.length = 0;
}

function first(team: number): number { return team === 0 ? 0 : PLAYERS_PER_TEAM; }

/** Distance from point (px, pz) to the segment a -> b. */
function segDist(ax: number, az: number, bx: number, bz: number, px: number, pz: number): number {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

/** Completion model: the closest opponent to the lane (excluding the passer's immediate marker behind him). */
export function laneModel(s: SimState, team: number, x0: number, z0: number, x1: number, z1: number): number {
  const opp = team === 0 ? 1 : 0;
  let minLane = 1e9, minRecv = 1e9;
  for (let i = first(opp); i < first(opp) + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const d = segDist(x0, z0, x1, z1, q.x, q.z);
    // An opponent right next to the passer does not block the lane unless he is in front of the ball.
    const fromPasser = Math.hypot(q.x - x0, q.z - z0);
    const ahead = (q.x - x0) * (x1 - x0) + (q.z - z0) * (z1 - z0);
    if (!(fromPasser < 1.5 && ahead <= 0)) minLane = Math.min(minLane, d);
    minRecv = Math.min(minRecv, Math.hypot(q.x - x1, q.z - z1));
  }
  const dist = Math.hypot(x1 - x0, z1 - z0);
  const lane = Math.max(0, Math.min(1, (minLane - 0.7) / 3.5));
  const len = 1 - Math.max(0, dist - 20) / 60;
  const recv = Math.max(0.4, Math.min(1, 0.4 + minRecv / 5));
  return Math.max(0.02, Math.min(0.98, lane * len * recv));
}

function dangerAt(team: number, s: SimState, x: number, z: number): number {
  const gx = s.teams[team]!.dir * HALF_LENGTH;
  const g = Math.hypot(gx - x, z);
  return Math.max(0, Math.min(1, 0.45 * Math.exp(-g / 9)));
}

function put(out: PassOption[], n: number, target: number, kind: KickKind, x: number, z: number, c: number, progress: number, danger: number): number {
  if (n >= out.length) return n;
  const o = out[n]!;
  o.target = target; o.kind = kind; o.x = x; o.z = z; o.completion = c; o.progress = progress; o.danger = danger;
  o.score = c + progress / 40 + danger;
  return n + 1;
}

/** TAI-09 scorePassOptions double: ground passes to every teammate 4..45 m away, through balls to forward runners,
 *  crosses to teammates in the box from the crossing zone. */
export function scorePassDouble(s: SimState, slot: number, out: PassOption[]): number {
  CTL.scoreCalls.push(s.tick);
  if (CTL.passes === 'none') return 0;
  if (CTL.passes === 'custom') {
    let k = 0;
    for (const o of CTL.custom) k = put(out, k, o.target, o.kind, o.x, o.z, o.completion, o.progress, o.danger);
    return k;
  }
  const p = s.players[slot]!;
  const team = p.team;
  const dir = s.teams[team]!.dir;
  let n = 0;
  for (let i = first(team); i < first(team) + PLAYERS_PER_TEAM; i++) {
    if (i === slot) continue;
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < 4 || d > 45) continue;
    if (q.isKeeper === 1 && d > 25) continue;
    const c = laneModel(s, team, p.x, p.z, q.x, q.z);
    n = put(out, n, i, KickKind.GROUND_PASS, q.x, q.z, c, dir * (q.x - p.x), dangerAt(team, s, q.x, q.z));
    if (q.isKeeper === 0 && dir * q.vx > 2 && dir * (q.x - p.x) > 5) {
      const lx = Math.max(-HALF_LENGTH + 2, Math.min(HALF_LENGTH - 2, q.x + q.vx * 1.2));
      const lz = Math.max(-HALF_WIDTH + 2, Math.min(HALF_WIDTH - 2, q.z + q.vz * 1.2));
      const c2 = laneModel(s, team, p.x, p.z, lx, lz);
      n = put(out, n, i, KickKind.THROUGH_GROUND, lx, lz, c2, dir * (lx - p.x), dangerAt(team, s, lx, lz));
    }
    if (inCrossingZone(p.x, p.z, dir) && inPenaltyArea(q.x, q.z, dir)) {
      n = put(out, n, i, KickKind.CROSS, q.x, q.z, 0.55, dir * (q.x - p.x), dangerAt(team, s, q.x, q.z));
    }
  }
  return n;
}

/** TAI-10 estimateXg double: distance and angle, blockers in the shooting triangle, pressure. */
export function xgDouble(s: SimState, slot: number, x: number, z: number): number {
  if (CTL.xg !== null) return CTL.xg;
  const p = s.players[slot]!;
  const team = p.team;
  const gx = s.teams[team]!.dir * HALF_LENGTH;
  const g = Math.hypot(gx - x, z);
  const cosA = Math.abs(gx - x) / Math.max(g, 1e-6);
  let xg = 0.55 * Math.exp(-g / 7.5) * (0.4 + 0.6 * cosA);
  const opp = team === 0 ? 1 : 0;
  for (let i = first(opp); i < first(opp) + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1 || q.isKeeper === 1) continue;
    const dPost = Math.min(segDist(x, z, gx, GOAL_HALF_WIDTH, q.x, q.z), segDist(x, z, gx, -GOAL_HALF_WIDTH, q.x, q.z), segDist(x, z, gx, 0, q.x, q.z));
    if (dPost < 0.8) xg *= 0.6;
    if (Math.hypot(q.x - x, q.z - z) < 2) xg *= 0.75;
  }
  return Math.max(0, Math.min(1, xg));
}

const DIRS = Array.from({ length: 12 }, (_, i) => ({ x: Math.cos((i * Math.PI) / 6), z: Math.sin((i * Math.PI) / 6) }));

/** TAI-10 bestDribble double: 12 directions, space 6 m ahead, progress, staying on the pitch. */
export function dribbleDouble(s: SimState, slot: number, out: { x: number; z: number }): number {
  const p = s.players[slot]!;
  const team = p.team;
  const dir = s.teams[team]!.dir;
  const opp = team === 0 ? 1 : 0;
  let best = -1;
  out.x = 0; out.z = 0;
  for (const d of DIRS) {
    const ax = p.x + d.x * 6, az = p.z + d.z * 6;
    if (Math.abs(ax) > HALF_LENGTH - 1 || Math.abs(az) > HALF_WIDTH - 1) continue;
    let space = 1e9;
    for (let i = first(opp); i < first(opp) + PLAYERS_PER_TEAM; i++) {
      const q = s.players[i]!;
      if (q.active !== 1) continue;
      space = Math.min(space, segDist(p.x, p.z, ax, az, q.x, q.z));
    }
    const sc = Math.min(1, space / 6) * (0.55 + 0.45 * d.x * dir);
    if (sc > best) { best = sc; out.x = d.x; out.z = d.z; }
  }
  if (CTL.dribbleScore !== null) return CTL.dribbleScore;
  return Math.max(0, best);
}

/** TAI-10 chooseSkill double: a body feint when a defender is close in front (stars allowing). */
export function skillDouble(s: SimState, slot: number): SkillMove {
  if (CTL.skill !== null) return CTL.skill as SkillMove;
  const p = s.players[slot]!;
  if (s.attrs[slot]!.skillMoves < 3) return SkillMove.NONE;
  const opp = p.team === 0 ? 1 : 0;
  for (let i = first(opp); i < first(opp) + PLAYERS_PER_TEAM; i++) {
    const q = s.players[i]!;
    if (q.active !== 1) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 2.5 && dx * p.fx + dz * p.fz > 0.5 * d) return SkillMove.BODY_FEINT;
  }
  return SkillMove.NONE;
}

const L = createKickLaunch();

/** Kick starter double (SIM-09/10/11 stubs): records the request, then begins a charging action (record) or launches
 *  the ball at once toward the request's target (kick). */
export function starterDouble(via: string, s: SimState, slot: number, kind: KickKind, req: ActionRequest, ev: EventSink): number {
  const p = s.players[slot]!;
  if (p.active !== 1 || p.act !== ActionKind.NONE || p.stunT > 0) return 0;
  if (s.ball.owner !== slot) return 0;
  CTL.starts.push({ via, slot, kind, power: req.power, charging: req.charging, dirX: req.dirX, dirZ: req.dirZ, target: req.targetSlot,
    hasTarget: req.hasTarget, tx: req.targetX, tz: req.targetZ, tick: s.tick, flags: req.flags });
  if (CTL.starters === 'refuse') return 0;
  const shot = via === 'shot';
  if (CTL.starters === 'record') {
    // beginAction inlined: importing sim/actions/dispatch here would load the registry (and the mocked kick modules)
    // from inside a vi.mock factory.
    p.act = shot ? ActionKind.SHOT : ActionKind.KICK;
    p.actT = 0; p.actDur = 60; p.actContact = 10; p.actDone = 0;
    p.actKick = kind;
    p.actPower = req.power;
    p.actCharging = req.charging === 1 ? 1 : 0;
    p.actDirX = req.dirX; p.actDirZ = req.dirZ;
    return 1;
  }
  const b = s.ball;
  let tx: number, tz: number;
  const dir = s.teams[p.team]!.dir;
  if (shot) {
    tx = dir * HALF_LENGTH;
    const dx = req.dirX !== 0 || req.dirZ !== 0 ? req.dirX : dir;
    const dz = req.dirX !== 0 || req.dirZ !== 0 ? req.dirZ : 0;
    tz = Math.abs(dx) > 1e-3 ? b.z + (tx - b.x) * (dz / dx) : b.z;
  } else if (req.hasTarget === 1) { tx = req.targetX; tz = req.targetZ; }
  else if (req.targetSlot >= 0) { tx = s.players[req.targetSlot]!.x; tz = s.players[req.targetSlot]!.z; }
  else { tx = b.x + (req.dirX || dir) * 30; tz = b.z + req.dirZ * 30; }
  const dx = tx - b.x, dz = tz - b.z;
  const d = Math.hypot(dx, dz) || 1;
  const v = shot ? 25 : Math.min(24, 8 + d * 0.45);
  L.vx = (dx / d) * v; L.vz = (dz / d) * v;
  L.vy = shot ? 1.5 : kind === KickKind.THROUGH_GROUND ? 0 : 7;
  L.sx = 0; L.sy = 0; L.sz = 0;
  L.kind = kind; L.target = shot ? -1 : req.targetSlot; L.tx = tx; L.tz = tz;
  L.onTarget = shot && Math.abs(tz) < GOAL_HALF_WIDTH ? 1 : 0;
  applyKick(s, slot, L, req.power, ev);
  return 1;
}
