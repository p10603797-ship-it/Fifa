/**
 * [FEEL-2] Scripted human-input scenarios for CPU defending against a human dribbler (jockey, mirror, shoulder) and for
 * shot types against a real keeper. Real pipeline (makeScenario + step), pad-shaped InputFrames. Shared by
 * tests/scenario/feel-2-*.test.ts and the measurement runner tests/scenario/feel-2-measure.ts.
 */
import { AssistLevel, AutoSwitch, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { makeScenario, runTicks } from '../harness/scenario';

export const HS = 9;
/** The CPU centre-back the dribbler takes on (standingTackle 91). */
export const CB = 14;

function stick(f: InputFrame, dx: number, dz: number, mag = 1): void {
  const l = Math.hypot(dx, dz);
  if (!(l > 1e-9)) return;
  f.mx = Math.round((dx / l) * 127 * mag);
  f.mz = Math.round((dz / l) * 127 * mag);
}

function park(s: SimState, keep: readonly number[]): void {
  for (let i = 0; i < 22; i++) {
    if (i === HS || i === 0 || i === 11 || keep.includes(i)) continue;
    const p = s.players[i]!;
    if (i < 11) { p.x = -48; p.z = -30 + i * 6; } else { p.x = -40 + (i - 11) * 7; p.z = 32; }
    p.vx = 0; p.vz = 0;
  }
}

export type DefOutcome = 'lost' | 'beat' | 'none';

export interface DefCase {
  style: 'sprint' | 'r1' | 'jog';
  level: Difficulty;
  seed: number;
  /** Defender's lateral offset from the dribbler's line, m. */
  lat: number;
  /** Side-step: stick z component (0 = straight at him) once he is within `weaveAt` m. */
  weave: number;
  weaveAt?: number;
  /** Override the dribbler's dribbling / ballControl / agility (1..99). */
  skill?: number;
  /** Override the defender's standingTackle / defensive awareness proxies (interceptions) (1..99). */
  defSkill?: number;
  /** Start distance between them along x, m (default 14). */
  gap?: number;
  /** Side-step always toward +z (not away from the defender's side: a single move, no zig-zag). */
  fixedSide?: boolean;
}

export interface DefResult {
  res: DefOutcome;
  fouls: number;
  /** Closest centre-to-centre distance dribbler - defender, m (overlap: below 2 x bodyRadius by a margin). */
  minSep: number;
  /** Largest one-tick jump of the defender's position, m (teleport check). */
  maxJump: number;
  /** Ticks the defender was within 4 m with the stick more than half pushed, free, but slower than 0.3 m/s (running in
   *  place). */
  stuck: number;
  /** Direction reversals of the defender's lateral velocity faster than 0.8 m/s inside 4 m (jitter). */
  flips: number;
  /** Ticks until the outcome. */
  ticks: number;
  /** How the ball was lost: the winning TACKLE's ChallengeKind ('t<kind>'), 'other' (a steal / poke / block), ''. */
  how: string;
  /** The defender's challenges (TACKLE events) and how many won the ball. */
  tackles: number;
  won: number;
  /** Lost rolls (the ball was in the zone) and whiffs / body contacts among the lost challenges. */
  rollLost: number;
}

/**
 * Human dribbles from (-20, 0) up +x at a CPU centre-back (slot CB) at (-20 + gap, lat) of `level`; within weaveAt m
 * he side-steps by `weave` (stick z) away from the defender's side. 'lost' = ball won without a foul, 'beat' = past
 * him by 4 m (or still on the ball after 6 s and past him by 1 m, or level and 2.5 m clear to the side), 'none' = a
 * foul or neither.
 */
export function vsDefender(c: DefCase): DefResult {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed: c.seed, config: { difficulty: c.level },
    humans: [{ side: 0, slot: HS, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
  });
  park(s, [CB]);
  const p = s.players[HS]!;
  p.x = -20; p.z = 0; p.fx = 1; p.fz = 0;
  if (c.skill !== undefined) { const a = s.attrs[HS]!; a.dribbling = c.skill; a.ballControl = c.skill; a.agility = c.skill; }
  if (c.defSkill !== undefined) { const a = s.attrs[CB]!; a.standingTackle = c.defSkill; a.interceptions = c.defSkill; }
  const d = s.players[CB]!;
  d.x = -20 + (c.gap ?? 14); d.z = c.lat; d.vx = 0; d.vz = 0; d.fx = -1; d.fz = 0;
  Object.assign(s.ball, { x: -19.5, y: 0.11, z: 0, px: -19.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  const wa = c.weaveAt ?? 6;
  let res: DefOutcome = 'none';
  let fouls = 0, minSep = 1e9, maxJump = 0, stuck = 0, flips = 0, lastVz = 0, ticks = 0, how = '', tackles = 0, won = 0, rollLost = 0;
  let ox = d.x, oz = d.z;
  runTicks(s, 360, (_t, st, out) => {
    const f = out[0]!;
    const q = st.players[HS]!, dd = st.players[CB]!;
    let dz = 0;
    if (dd.x - q.x < wa && dd.x - q.x > -1) dz = c.fixedSide === true || q.z >= dd.z ? c.weave : -c.weave;
    stick(f, 1, dz, c.style === 'jog' ? 0.9 : 1);
    if (c.style === 'sprint') f.buttons |= Btn.SPRINT;
    else if (c.style === 'r1') f.buttons |= Btn.MOD_R;
  }, {
    until: (st, ev) => {
      ticks++;
      for (const e of ev) {
        if (e.type === EventType.FOUL) fouls++;
        if (e.type === EventType.TACKLE && e.a === CB) { tackles++; if (e.c === 1) { won++; how = `t${e.d}`; } else if (e.y > 0.05) rollLost++; }
      }
      const q = st.players[HS]!, dd = st.players[CB]!;
      const sep = Math.hypot(q.x - dd.x, q.z - dd.z);
      if (sep < minSep) minSep = sep;
      const j = Math.hypot(dd.x - ox, dd.z - oz);
      if (j > maxJump) maxJump = j;
      ox = dd.x; oz = dd.z;
      const ctl = dd.ctrl >= 0 ? st.ctrl[dd.ctrl] : undefined;
      const sp = Math.hypot(dd.vx, dd.vz);
      if (sep < 4 && ctl !== undefined && Math.hypot(ctl.mx, ctl.mz) > 0.5 && sp < 0.3 && dd.stunT <= 0 && dd.act === 0) stuck++;
      if (sep < 4 && Math.abs(dd.vz) > 0.8 && Math.abs(lastVz) > 0.8 && dd.vz * lastVz < 0) flips++;
      if (Math.abs(dd.vz) > 0.8) lastVz = dd.vz;
      if (st.ball.owner !== HS) { res = fouls === 0 ? 'lost' : 'none'; if (how === '') how = 'other'; return true; }
      if (q.x > dd.x + 4) { res = 'beat'; return true; }
      return false;
    },
  });
  // Still on the ball after 6 s and past him, or clear of him to the side (no longer in front of him): beaten too.
  const qe = s.players[HS]!, de = s.players[CB]!;
  if (res === 'none' && fouls === 0 && s.ball.owner === HS && (qe.x > de.x + 1 || (qe.x > de.x - 1 && Math.abs(qe.z - de.z) > 2.5))) res = 'beat';
  return { res, fouls, minSep, maxJump, stuck, flips, ticks, how, tackles, won, rollLost };
}

export interface DefSummary { n: number; beat: number; lost: number; none: number; fouls: number; minSep: number; maxJump: number; stuck: number; flips: number; how: Record<string, number>; tackles: number; won: number; rollLost: number }

/** The FEEL-2 side-step grid: seeds x lateral offsets x side-step sizes, R1 and sprint. */
export function sideStepGrid(level: Difficulty, opts: { seeds?: readonly number[]; lats?: readonly number[]; weaves?: readonly number[]; styles?: readonly DefCase['style'][]; skill?: number } = {}): DefSummary {
  const sum: DefSummary = { n: 0, beat: 0, lost: 0, none: 0, fouls: 0, minSep: 1e9, maxJump: 0, stuck: 0, flips: 0, how: {}, tackles: 0, won: 0, rollLost: 0 };
  for (const style of opts.styles ?? ['r1', 'sprint']) for (const seed of opts.seeds ?? [1, 2, 3, 4]) for (const lat of opts.lats ?? [-1.5, 0, 1.5]) for (const weave of opts.weaves ?? [0.4, 0.8]) {
    const r = vsDefender({ style, level, seed, lat, weave, skill: opts.skill });
    sum.n++;
    if (r.res === 'beat') sum.beat++; else if (r.res === 'lost') sum.lost++; else sum.none++;
    sum.fouls += r.fouls; sum.minSep = Math.min(sum.minSep, r.minSep); sum.maxJump = Math.max(sum.maxJump, r.maxJump);
    sum.stuck += r.stuck; sum.flips += r.flips; sum.tackles += r.tackles; sum.won += r.won; sum.rollLost += r.rollLost;
    if (r.res === 'lost') sum.how[r.how] = (sum.how[r.how] ?? 0) + 1;
  }
  return sum;
}

export const BODY_TOUCH = 2 * T_PLAYER.bodyRadius;

// ------------------------------------------------------------------ shots against a keeper

export type KShot = 'normal' | 'finesse' | 'power' | 'trivela';
/** SHOOT hold, ticks (power about 0.7; the FEEL-1 flight scenarios use 20). */
export const HOLD = 30;

/** Five spots 16-21 m from goal (shooter x, z). The FEEL-1 runner's five spots are not in the tree (D-034). */
export const SPOTS: readonly (readonly [number, number])[] = [[36, 0], [38, -7], [38, 7], [33, -5], [33, 5]];
/** Aims (goal-line z): 0.66 m and 1.26 m inside either post (far and near corner). */
export const AIMS: readonly number[] = [3.0, -3.0, 2.4, -2.4];

/**
 * Shot from (x, z) aiming at goal-line z = aimZ against the CPU's (team 1) keeper of `level` in goal, defenders parked.
 * Returns 'goal', 'saved' (keeper touched / held it), 'off' (wide / over / frame).
 */
export function shotVsKeeper(style: KShot, x: number, z: number, aimZ: number, seed: number, shooter?: number, level = Difficulty.PROFESSIONAL, setKeeper = true, hold = HOLD): 'goal' | 'saved' | 'off' {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, config: { difficulty: level },
    humans: [{ side: 0, slot: HS, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
  });
  park(s, []);
  const p = s.players[HS]!;
  p.x = x; p.z = z; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
  if (shooter !== undefined) { const a = s.attrs[HS]!; a.finishing = shooter; a.longShots = shooter; a.curve = shooter; a.shotPower = shooter; }
  const k = s.players[11]!;
  if (setKeeper) { k.x = 51.5; k.z = 0; k.vx = 0; k.vz = 0; k.fx = -1; k.fz = 0; }
  Object.assign(s.ball, { x: x + 0.5, y: 0.11, z, px: x + 0.5, py: 0.11, pz: z, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  const adx = 52.5 - x, adz = aimZ - z;
  let kicked = false, keeperTouched = false;
  let out = 'off' as 'goal' | 'saved' | 'off';
  runTicks(s, 260, (tk, _st, o) => {
    const f = o[0]!;
    if (kicked) return;
    stick(f, adx, adz);
    if (style === 'finesse') f.buttons |= Btn.MOD_R;
    if (style === 'power') f.buttons |= Btn.MOD_R | Btn.MOD_L;
    if (style === 'trivela') f.buttons |= Btn.SHIELD;
    if (tk - 1 < hold) f.buttons |= Btn.SHOOT;
  }, {
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.KICK && e.a === HS) kicked = true;
        if (e.type === EventType.GOAL) { out = 'goal'; return true; }
        if (kicked && e.type === EventType.SAVE) keeperTouched = true;
      }
      if (kicked && st.ball.heldBy === 11) keeperTouched = true;
      if (kicked && st.match.phase !== MatchPhase.IN_PLAY) return true;
      if (kicked && st.ball.x < 40 && st.ball.owner < 0 && Math.hypot(st.ball.vx, st.ball.vz) < 1) return true;
      return false;
    },
  });
  if (out === 'goal') return 'goal';
  return keeperTouched ? 'saved' : 'off';
}

/** Scoring rate of a shot type from the five spots at both corners, seeds; the keeper set on his line
 *  (setKeeper) or caught off it where the scenario puts him (about 8.6 m out, the FEEL-1 runner's keeper). */
export function shotRate(style: KShot, seeds: readonly number[], shooter?: number, setKeeper = true): { n: number; goals: number; saved: number; off: number } {
  const r = { n: 0, goals: 0, saved: 0, off: 0 };
  for (const [x, z] of SPOTS) for (const aim of AIMS) for (const seed of seeds) {
    const o = shotVsKeeper(style, x, z, aim, seed, shooter, Difficulty.PROFESSIONAL, setKeeper);
    r.n++;
    if (o === 'goal') r.goals++; else if (o === 'saved') r.saved++; else r.off++;
  }
  return r;
}
