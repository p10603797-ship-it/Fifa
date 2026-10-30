/**
 * [FEEL-2] Scripted human-input scenarios for CPU defending against a human dribbler (the duel: sold / read, safe
 * challenges, shoulder challenge) and for shot types against a real keeper. Real pipeline (makeScenario + step),
 * pad-shaped InputFrames. Shared by tests/scenario/feel-2-*.test.ts and the runner tests/scenario/feel-2-measure.ts.
 *
 * The side-step grid (sideStepGrid) is the FEEL-2 skeptics' multi-geometry probe (D-035): a centre-back in the centre
 * (two setups), a full-back against a winger, the edge of the box and midfield (two each) plus the FEEL-1 skeptic's
 * centre-back, the dribbler starting 10-14 m from his defender at three lateral offsets, side steps from 4.5 and 7 m
 * (away from the defender, a double step, a step to a fixed side; on the wing a cut inside, down the line, a double
 * step), R1 and sprint. Beaten: on the ball 2.5 m nearer goal than his defender, or past x 48, or the keeper winning it
 * after the dribbler got past his defender, or still on the ball at the end with the defender not in front of him (an
 * escort counts as a beat).
 */
import { AssistLevel, AutoSwitch, Difficulty, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { DEFEND_DEBUG, DUEL_DEBUG, DUEL_SOLD } from '../../src/ai/cpu/defending';
import { makeScenario, runTicks } from '../harness/scenario';

export const HS = 9;
/** The CPU centre-back of the straight-run, chase and diagonal scenes (standingTackle 91). */
export const CB = 14;
export const BODY_TOUCH = 2 * T_PLAYER.bodyRadius;
const GOAL_X = 52.5;

function stick(f: InputFrame, dx: number, dz: number, mag = 1): void {
  const l = Math.hypot(dx, dz);
  if (!(l > 1e-9)) return;
  f.mx = Math.round((dx / l) * 127 * mag);
  f.mz = Math.round((dz / l) * 127 * mag);
}

/** Everyone but the two keepers and `keep` out of the way. */
function parkAll(s: SimState, keep: readonly number[]): void {
  for (let i = 0; i < 22; i++) {
    if (keep.includes(i) || i === 0 || i === 11) continue;
    const p = s.players[i]!;
    if (i < 11) { p.x = -50; p.z = -30 + i * 6; } else { p.x = -45 + (i - 11) * 6; p.z = -33; }
    p.vx = 0; p.vz = 0;
  }
}

function humanScene(level: Difficulty, seed: number, slot: number): SimState {
  return makeScenario({
    phase: MatchPhase.IN_PLAY, seed, config: { difficulty: level },
    humans: [{ side: 0, slot, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
  });
}

/** Reset the sticky debug reasons between scenes. */
export function resetWhy(): void { DEFEND_DEBUG.why0 = 0; DEFEND_DEBUG.why1 = 0; }

// ------------------------------------------------------------------ the side-step duel

export type Move = 'straight' | 'away' | 'plus' | 'double' | 'cutin' | 'line';
export type Style = 'r1' | 'sprint' | 'jog';
export type DuelOutcome = 'beat' | 'lost' | 'foul' | 'out' | 'none';

export interface DuelCase {
  att: number; def: number; level: Difficulty; seed: number;
  /** Dribbler start; the defender `gap` m toward goal from him and `lat` m to the side. */
  x0: number; z0: number; gap: number; lat: number;
  style: Style; move: Move;
  /** Side-step stick share and the distance to his defender at which he starts it, m. */
  mag: number; at: number;
  /** Override the dribbler's dribbling / ballControl / agility (1..99). */
  skill?: number;
  /** [FEEL-2 round 2] Leave both teams in place (no parking): the CPU may switch to a cover defender mid-duel. */
  full?: boolean;
  /** [FEEL-2 round 2] Side-step length, ticks (then straight on at goal); undefined = held to the end. */
  stepTicks?: number;
}

export interface DuelResult {
  res: DuelOutcome;
  fouls: number; cards: number; reds: number; pens: number;
  /** Longest run of ticks the defender spent within 1.8 m of the dribbler, not goal-side, while he kept the ball. */
  escort: number;
  /** Closest centre distance dribbler - defender (m) and largest one-tick jump of the defender in play (m). */
  minSep: number; maxJump: number;
  /** [FEEL-2 round 2] Ticks the CPU's controlled defender was "sold" (DUEL_SOLD), and of those the ticks on a defender
   *  other than the one who drew the window (a cover defender inheriting a feint he never faced). */
  soldTicks: number; inheritedSold: number;
}

/** One duel scene (see the file header). */
export function duel(c: DuelCase): DuelResult {
  const s = humanScene(c.level, c.seed, c.att);
  if (c.full !== true) parkAll(s, [c.att, c.def]);
  let gx = GOAL_X - c.x0, gz = -c.z0;
  const gl = Math.hypot(gx, gz); gx /= gl; gz /= gl;
  const nx = -gz, nz = gx;
  const a = s.players[c.att]!;
  a.x = c.x0; a.z = c.z0; a.fx = gx; a.fz = gz; a.vx = 0; a.vz = 0;
  if (c.skill !== undefined) { const at = s.attrs[c.att]!; at.dribbling = c.skill; at.ballControl = c.skill; at.agility = c.skill; }
  const d = s.players[c.def]!;
  d.x = c.x0 + gx * c.gap + nx * c.lat; d.z = c.z0 + gz * c.gap + nz * c.lat; d.vx = 0; d.vz = 0; d.fx = -gx; d.fz = -gz;
  const bx = c.x0 + gx * 0.5, bz = c.z0 + gz * 0.5;
  Object.assign(s.ball, { x: bx, y: 0.11, z: bz, px: bx, py: 0.11, pz: bz, vx: 0, vy: 0, vz: 0, owner: c.att, lastTouch: c.att, lastTouchTeam: 0, heldBy: -1 });
  const r: DuelResult = { res: 'none', fouls: 0, cards: 0, reds: 0, pens: 0, escort: 0, minSep: 9, maxJump: 0, soldTicks: 0, inheritedSold: 0 };
  let escRun = 0, startT = -1, sideSign = 0, ox = d.x, oz = d.z, past = false;
  let moves = DUEL_DEBUG.moves1, drew = -1;
  DUEL_DEBUG.st1 = 0; DUEL_DEBUG.sl1 = -1;
  const dist = (x: number, z: number): number => Math.hypot(GOAL_X - x, z);
  runTicks(s, 420, (_t, st, out) => {
    const f = out[0]!; const q = st.players[c.att]!; const dd = st.players[c.def]!;
    let ux = GOAL_X - q.x, uz = -q.z; const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
    const vx = -uz, vz = ux;
    const along = (dd.x - q.x) * ux + (dd.z - q.z) * uz;
    const latD = (dd.x - q.x) * vx + (dd.z - q.z) * vz;
    let side = 0;
    if (c.move !== 'straight' && (along < c.at && along > -1 || startT >= 0 && c.stepTicks !== undefined) &&
      !(startT >= 0 && c.stepTicks !== undefined && st.tick - startT >= c.stepTicks)) {
      if (startT < 0) { startT = st.tick; sideSign = latD >= 0 ? -1 : 1; }
      const el = st.tick - startT;
      if (c.move === 'away') side = latD >= 0 ? -1 : 1;
      else if (c.move === 'plus') side = 1;
      else if (c.move === 'double') side = el < 18 ? -sideSign : sideSign;
      else if (c.move === 'cutin') side = -Math.sign(q.z * vz || 1);
      else side = Math.sign(q.z * vz || 1);
    }
    stick(f, ux + vx * side * c.mag, uz + vz * side * c.mag, c.style === 'jog' ? 0.9 : 1);
    if (c.style === 'sprint') f.buttons |= Btn.SPRINT; else if (c.style === 'r1') f.buttons |= Btn.MOD_R;
  }, {
    until: (st, ev) => {
      let foul = false;
      for (const e of ev) {
        if (e.type === EventType.FOUL) { foul = true; r.fouls++; if (e.d === 1) r.pens++; }
        if (e.type === EventType.CARD) { r.cards++; if (e.b === 2 || e.b === 3) r.reds++; }
      }
      if (DUEL_DEBUG.moves1 !== moves) { moves = DUEL_DEBUG.moves1; if (DUEL_DEBUG.st1 === DUEL_SOLD) drew = DUEL_DEBUG.sl1; }
      if (DUEL_DEBUG.st1 === DUEL_SOLD) { r.soldTicks++; if (DUEL_DEBUG.sl1 !== drew) r.inheritedSold++; }
      const q = st.players[c.att]!, dd = st.players[c.def]!;
      const sep = Math.hypot(q.x - dd.x, q.z - dd.z);
      if (sep < r.minSep) r.minSep = sep;
      const j = Math.hypot(dd.x - ox, dd.z - oz);
      if (j > r.maxJump && st.match.phase === MatchPhase.IN_PLAY) r.maxJump = j;
      ox = dd.x; oz = dd.z;
      const b = st.ball;
      if (sep < 1.8 && b.owner === c.att && dist(dd.x, dd.z) > dist(q.x, q.z) - 0.3) { escRun++; if (escRun > r.escort) r.escort = escRun; } else escRun = 0;
      let ux = GOAL_X - q.x, uz = -q.z; const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
      if (b.owner === c.att && (dd.x - q.x) * ux + (dd.z - q.z) * uz < -1) past = true;
      if (foul) { r.res = 'foul'; return true; }
      if (st.match.phase !== MatchPhase.IN_PLAY) { r.res = 'out'; return true; }
      if (b.owner >= 11 || (b.owner < 0 && b.lastTouchTeam === 1)) {
        const by = b.owner >= 0 ? b.owner : b.lastTouch;
        const kp = by >= 0 ? st.players[by] : undefined;
        r.res = past && kp !== undefined && kp.isKeeper === 1 ? 'beat' : 'lost';
        return true;
      }
      if (b.owner === c.att && dist(q.x, q.z) < dist(dd.x, dd.z) - 2.5) { r.res = 'beat'; return true; }
      if (q.x > 48) { r.res = 'beat'; return true; }
      return false;
    },
  });
  if (r.res === 'none' && s.ball.owner === c.att) {
    const q = s.players[c.att]!, dd = s.players[c.def]!;
    let ux = GOAL_X - q.x, uz = -q.z; const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
    if (dist(q.x, q.z) < dist(dd.x, dd.z) - 0.5 || (dd.x - q.x) * ux + (dd.z - q.z) * uz < 0.5) r.res = 'beat';
  }
  return r;
}

type Setup = Pick<DuelCase, 'att' | 'def' | 'x0' | 'z0' | 'gap'>;
/** The grid's geometries (the FEEL-2 skeptics' probe, D-035). */
export const SETUPS: Readonly<Record<string, readonly Setup[]>> = {
  cb: [{ att: 9, def: 13, x0: 5, z0: -3, gap: 12 }, { att: 10, def: 14, x0: 10, z0: 4, gap: 11 }],
  fb: [{ att: 5, def: 15, x0: 5, z0: 20, gap: 12 }, { att: 8, def: 12, x0: 8, z0: -21, gap: 12 }],
  box: [{ att: 9, def: 14, x0: 18, z0: 2, gap: 10 }, { att: 10, def: 13, x0: 16, z0: -6, gap: 11 }],
  mid: [{ att: 6, def: 17, x0: -20, z0: 3, gap: 12 }, { att: 7, def: 18, x0: -15, z0: -8, gap: 12 }],
  theirs: [{ att: 9, def: 14, x0: -20, z0: 0, gap: 14 }],
};

export interface GridOpts {
  seeds?: readonly number[]; lats?: readonly number[]; ats?: readonly number[]; styles?: readonly Style[];
  scens?: readonly string[]; skill?: number;
  /** [FEEL-2 round 2] Side-step length, ticks, then straight on at goal (undefined: held while he closes). */
  stepTicks?: number;
}

export interface GridSummary {
  n: number; beat: number; lost: number; foul: number; fouls: number; cards: number; reds: number; pens: number;
  /** Scenes with an escort over 1.5 s (90 ticks). */
  escorts: number; minSep: number; maxJump: number;
}

/** The side-step grid at one level (see the file header): 108 scenes a seed. */
export function sideStepGrid(level: Difficulty, o: GridOpts = {}): GridSummary {
  const g: GridSummary = { n: 0, beat: 0, lost: 0, foul: 0, fouls: 0, cards: 0, reds: 0, pens: 0, escorts: 0, minSep: 9, maxJump: 0 };
  for (const sc of o.scens ?? ['cb', 'fb', 'box', 'mid', 'theirs']) {
    const moves: Move[] = sc === 'fb' ? ['cutin', 'line', 'double'] : ['away', 'double', 'plus'];
    for (const style of o.styles ?? ['r1', 'sprint']) for (const b of SETUPS[sc]!) for (const seed of o.seeds ?? [21, 22, 23]) {
      for (const lat of o.lats ?? [-1, 0.7, 2]) for (const move of moves) for (const at of o.ats ?? [4.5, 7]) {
        const r = duel({ ...b, level, seed, style, lat, move, mag: 0.6, at, skill: o.skill, stepTicks: o.stepTicks });
        g.n++;
        if (r.res === 'beat') g.beat++; else if (r.res === 'lost') g.lost++; else if (r.res === 'foul') g.foul++;
        g.fouls += r.fouls; g.cards += r.cards; g.reds += r.reds; g.pens += r.pens;
        if (r.escort >= 90) g.escorts++;
        if (r.minSep < g.minSep) g.minSep = r.minSep;
        if (r.maxJump > g.maxJump) g.maxJump = r.maxJump;
      }
    }
  }
  return g;
}

/** [FEEL-2 round 2] Side steps with both teams left in place (no parking): the CPU switches to a cover defender in
 *  some of them. Central setups (cb, box, mid), away / double / plus, R1 and sprint, three lateral offsets, from 4.5 m. */
export interface FullSummary { n: number; beat: number; lost: number; fouls: number; soldTicks: number; inheritedSold: number; inheritedScenes: number }
export function fullTeamSideSteps(level: Difficulty, seeds: readonly number[] = [31, 32]): FullSummary {
  const g: FullSummary = { n: 0, beat: 0, lost: 0, fouls: 0, soldTicks: 0, inheritedSold: 0, inheritedScenes: 0 };
  for (const sc of ['cb', 'box', 'mid']) for (const b of SETUPS[sc]!) for (const style of ['r1', 'sprint'] as const) {
    for (const seed of seeds) for (const lat of [-1, 0.7, 2]) for (const move of ['away', 'double', 'plus'] as const) {
      const r = duel({ ...b, level, seed, style, lat, move, mag: 0.6, at: 4.5, full: true });
      g.n++;
      if (r.res === 'beat') g.beat++; else if (r.res === 'lost') g.lost++;
      g.fouls += r.fouls; g.soldTicks += r.soldTicks; g.inheritedSold += r.inheritedSold;
      if (r.inheritedSold > 0) g.inheritedScenes++;
    }
  }
  return g;
}

// ------------------------------------------------------------------ other human-carrier scenes

export interface FoulTally { n: number; lost: number; fouls: number; cards: number; yellows: number; reds: number; pens: number }
function tally(): FoulTally { return { n: 0, lost: 0, fouls: 0, cards: 0, yellows: 0, reds: 0, pens: 0 }; }
function countEvents(t: FoulTally, ev: readonly { type: EventType; b: number; d: number }[]): void {
  for (const e of ev) {
    if (e.type === EventType.FOUL) { t.fouls++; if (e.d === 1) t.pens++; }
    if (e.type === EventType.CARD) { t.cards++; if (e.b === 1) t.yellows++; else t.reds++; }
  }
}

/**
 * Straight at a centre-back: the human from (px, 0) runs at goal (jog at stick 0.6 / 0.75 / 0.9, R1, sprint), straight
 * or with a slow 0.25 weave, at CB 8 m ahead and -1 / 0 / 1 m to the side (the skeptics' "backoff" scene). lost = the
 * defending team won it.
 */
export function straightRuns(level: Difficulty, pxs: readonly number[] = [10, 24], seeds: readonly number[] = [1, 2, 3, 4]): FoulTally {
  const t = tally();
  for (const px of pxs) for (const mode of ['jog60', 'jog75', 'jog90', 'r1', 'sprint']) for (const seed of seeds) for (const lat of [-1, 0, 1]) for (const wz of [0, 0.25]) {
    const s = humanScene(level, seed, HS);
    parkAll(s, [HS, CB]);
    const p = s.players[HS]!; p.x = px; p.z = 0; p.fx = 1; p.fz = 0;
    const d = s.players[CB]!; d.x = px + 8; d.z = lat; d.vx = 0; d.vz = 0; d.fx = -1; d.fz = 0;
    Object.assign(s.ball, { x: px + 0.5, y: 0.11, z: 0, px: px + 0.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
    const mag = mode.startsWith('jog') ? Number(mode.slice(3)) / 100 : 1;
    let lost = false;
    runTicks(s, 600, (tick, _st, out) => {
      const f = out[0]!;
      stick(f, 1, wz * Math.sin(tick / 25), mag);
      if (mode === 'sprint') f.buttons |= Btn.SPRINT; else if (mode === 'r1') f.buttons |= Btn.MOD_R;
    }, {
      until: (st, ev) => {
        countEvents(t, ev);
        if (st.match.phase !== MatchPhase.IN_PLAY) return true;
        if (st.ball.owner !== HS && (st.ball.owner >= 11 || st.ball.lastTouchTeam === 1)) { lost = true; return true; }
        return st.players[HS]!.x > st.players[CB]!.x + 4 && st.ball.owner === HS;
      },
    });
    t.n++; if (lost) t.lost++;
  }
  return t;
}

/**
 * A beaten centre-back chasing a human who runs at goal at R1 / sprint, starting 0-2.5 m behind or level and 0.8-1.4 m
 * to the side at 6 m/s (the skeptics' shoulder scene), from x = sx: fouls, penalties, cards and shoulder challenges.
 */
export function chases(level: Difficulty, sx: number, seeds: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8]): FoulTally & { shoulders: number } {
  const t = { ...tally(), shoulders: 0 };
  for (const style of ['r1', 'sprint']) for (const seed of seeds) for (const [ox, oz] of [[-1.5, 1.2], [-0.5, 1.0], [-2.5, 0.8], [-1, -1.2], [0, 1.4]] as const) for (const ang of [0, 0.3]) {
    const s = humanScene(level, seed, HS);
    parkAll(s, [HS, CB]);
    const p = s.players[HS]!; p.x = sx; p.z = -6 * ang; p.fx = 1; p.fz = 0; p.vx = 6; p.vz = 0;
    const d = s.players[CB]!; d.x = sx + ox; d.z = p.z + oz; d.vx = 6; d.vz = 0; d.fx = 1; d.fz = 0;
    Object.assign(s.ball, { x: p.x + 0.6, y: 0.11, z: p.z, px: p.x + 0.6, py: 0.11, pz: p.z, vx: 6, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
    let lost = false;
    runTicks(s, 240, (_t, st, out) => {
      const f = out[0]!; const q = st.players[HS]!;
      stick(f, GOAL_X - q.x, -q.z);
      f.buttons |= style === 'sprint' ? Btn.SPRINT : Btn.MOD_R;
    }, {
      until: (st, ev) => {
        countEvents(t, ev);
        for (const e of ev) if (e.type === EventType.TACKLE && e.a === CB && e.d === 3) t.shoulders++;
        if (st.match.phase !== MatchPhase.IN_PLAY) return true;
        if (st.ball.owner !== HS && (st.ball.owner >= 11 || st.ball.lastTouchTeam === 1)) { lost = true; return true; }
        return false;
      },
    });
    t.n++; if (lost) t.lost++;
  }
  return t;
}

/**
 * Level and alongside: the centre-back starts beside a human sprinting / R1-running at goal from x = -20 (0.3 m ahead
 * of him, 1 m to the side, both at 6 m/s): shoulder challenges (TACKLE kind SHOULDER), fouls and cards.
 */
export function levelChases(level: Difficulty, seeds: readonly number[] = [1, 2, 3, 4, 5, 6]): FoulTally & { shoulders: number } {
  const t = { ...tally(), shoulders: 0 };
  for (const style of ['r1', 'sprint']) for (const seed of seeds) for (const [ox, oz] of [[0.3, 1.0], [0.3, -1.0], [0, 0.95]] as const) {
    const s = humanScene(level, seed, HS);
    parkAll(s, [HS, CB]);
    const p = s.players[HS]!; p.x = -20; p.z = 0; p.fx = 1; p.fz = 0; p.vx = 6; p.vz = 0;
    const d = s.players[CB]!; d.x = -20 + ox; d.z = oz; d.vx = 6; d.vz = 0; d.fx = 1; d.fz = 0;
    Object.assign(s.ball, { x: p.x + 0.6, y: 0.11, z: 0, px: p.x + 0.6, py: 0.11, pz: 0, vx: 6, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
    let lost = false;
    runTicks(s, 240, (_t, st, out) => {
      const f = out[0]!; const q = st.players[HS]!;
      stick(f, GOAL_X - q.x, -q.z);
      f.buttons |= style === 'sprint' ? Btn.SPRINT : Btn.MOD_R;
    }, {
      until: (st, ev) => {
        countEvents(t, ev);
        for (const e of ev) if (e.type === EventType.TACKLE && e.a === CB && e.d === 3) t.shoulders++;
        if (st.match.phase !== MatchPhase.IN_PLAY) return true;
        if (st.ball.owner !== HS) { lost = st.ball.owner >= 11 || st.ball.lastTouchTeam === 1; return true; }
        return false;
      },
    });
    t.n++; if (lost) t.lost++;
  }
  return t;
}

/**
 * A constant diagonal (stick (1, 0.3 / 0.5 / 0.7), R1 / sprint / jog) at a centre-back off to the side: the dribbler's
 * lateral direction never changes, so no side step may be detected (DUEL_DEBUG.moves1 counts the CPU's draws).
 */
export function diagonalMoves(level: Difficulty, seeds: readonly number[] = [1, 2, 3, 4, 5, 6]): { n: number; moves: number } {
  const before = DUEL_DEBUG.moves1;
  let n = 0;
  for (const style of ['r1', 'sprint', 'jog']) for (const seed of seeds) for (const lat of [0.3, 0.5, 0.7]) {
    const s = humanScene(level, seed, HS);
    parkAll(s, [HS, CB]);
    const p = s.players[HS]!; p.x = -20; p.z = 0; p.fx = 1; p.fz = 0;
    const d = s.players[CB]!; d.x = -6; d.z = 3; d.vx = 0; d.vz = 0; d.fx = -1; d.fz = 0;
    Object.assign(s.ball, { x: -19.5, y: 0.11, z: 0, px: -19.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
    runTicks(s, 300, (_t, _st, out) => {
      const f = out[0]!; stick(f, 1, lat, style === 'jog' ? 0.9 : 1);
      if (style === 'sprint') f.buttons |= Btn.SPRINT; else if (style === 'r1') f.buttons |= Btn.MOD_R;
    }, { until: (st) => st.ball.owner !== HS || st.players[HS]!.x > st.players[CB]!.x + 3 });
    n++;
  }
  return { n, moves: DUEL_DEBUG.moves1 - before };
}

/**
 * The TAI-11 pipeline's weaving jogger (stick 0.5-0.74 with a 0.25-0.55 weave) at a defender 9-12 m ahead, the rest
 * of his team deep: fouls and cards against him, and how often the ball was won.
 */
export function weavingJogger(level: Difficulty, ns = 48): FoulTally {
  const t = tally();
  const C = 9, D = 15, CPU = 3;
  for (let seed = 1; seed <= ns; seed++) {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: C }], seed, config: { difficulty: level } });
    const q = s.players[C]!; q.x = 0; q.z = 0; q.vx = 0; q.vz = 0; q.fx = 1; q.fz = 0;
    const p = s.players[D]!; p.x = 9 + (seed % 4); p.z = (seed % 5) - 2; p.vx = 0; p.vz = 0; p.fx = -1; p.fz = 0;
    for (let i = 12; i < 22; i++) { if (i === D) continue; const r = s.players[i]!; r.x = 46 + (i % 3); r.z = (i % 2 === 0 ? 1 : -1) * (14 + (i - 12) * 2); r.vx = 0; r.vz = 0; }
    const b = s.ball; b.x = 0.5; b.z = 0; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
    b.owner = C; b.heldBy = -1; b.lastTouch = C; b.lastTouchTeam = 0; b.lastTouchTick = 0;
    const ctl = s.ctrl[CPU]!; ctl.slot = D; p.ctrl = CPU; s.teams[1]!.cpu.seenOwner = C;
    const mag = 0.5 + (seed % 3) * 0.12, wv = 0.25 + (seed % 4) * 0.1;
    let lost = false;
    runTicks(s, 600, (tick, _s, out) => { stick(out[0]!, 1, wv * Math.sin(tick / 23), mag); }, {
      until: (st, ev) => {
        countEvents(t, ev);
        if (st.ball.owner !== C) { lost = true; return true; }
        const sl = st.ctrl[CPU]!.slot; const pp = st.players[sl >= 0 ? sl : D]!;
        return st.players[C]!.x > pp.x + 4 || st.match.phase !== MatchPhase.IN_PLAY;
      },
    });
    t.n++; if (lost) t.lost++;
  }
  return t;
}

// ------------------------------------------------------------------ shots against a keeper

export type KShot = 'normal' | 'finesse' | 'power' | 'trivela';
/** SHOOT hold, ticks (power about 0.7; the FEEL-1 flight scenarios use 20). */
export const HOLD = 30;

/** Probe A (the first FEEL-2 probe): five spots 16-21 m from goal (shooter x, z) ... */
export const SPOTS: readonly (readonly [number, number])[] = [[36, 0], [38, -7], [38, 7], [33, -5], [33, 5]];
/** ... aimed (goal-line z) 0.66 m and 1.26 m inside either post, SHOOT held 30 ticks. */
export const AIMS: readonly number[] = [3.0, -3.0, 2.4, -2.4];
/** Probe B (the FEEL-2 skeptics' independent set): the five spots plus (30, -10) and (41, 12), the stick 3.2 and 1.6 m
 *  off the goal centre, SHOOT held 22 and 36 ticks. */
export const SPOTS_B: readonly (readonly [number, number])[] = [...SPOTS, [30, -10], [41, 12]];
export const AIMS_B: readonly number[] = [3.2, -3.2, 1.6, -1.6];
export const HOLDS_B: readonly number[] = [22, 36];

/**
 * Shot from (x, z) aiming at goal-line z = aimZ against the CPU's (team 1) keeper of `level` in goal, defenders parked.
 * Returns 'goal', 'saved' (keeper touched / held it), 'off' (wide / over / frame).
 */
export function shotVsKeeper(style: KShot, x: number, z: number, aimZ: number, seed: number, shooter?: number, level = Difficulty.PROFESSIONAL, setKeeper = true, hold = HOLD, runUp = 0): 'goal' | 'saved' | 'off' {
  const s = humanScene(level, seed, HS);
  parkAll(s, [HS]);
  const p = s.players[HS]!;
  // [FEEL-2 round 2] runUp > 0: he starts runUp m back and R1-dribbles at goal, pressing SHOOT on reaching x (the keeper
  // reads the run and comes out; the FEEL-2 skeptics' running probe).
  const sx = x - runUp;
  p.x = sx; p.z = z; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0;
  if (shooter !== undefined) { const a = s.attrs[HS]!; a.finishing = shooter; a.longShots = shooter; a.curve = shooter; a.shotPower = shooter; }
  const k = s.players[11]!;
  if (setKeeper) { k.x = 51.5; k.z = 0; k.vx = 0; k.vz = 0; k.fx = -1; k.fz = 0; }
  Object.assign(s.ball, { x: sx + 0.5, y: 0.11, z, px: sx + 0.5, py: 0.11, pz: z, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  let kicked = false, keeperTouched = false, pressAt = runUp > 0 ? -1 : 1;
  let out = 'off' as 'goal' | 'saved' | 'off';
  runTicks(s, 260 + (runUp > 0 ? 120 : 0), (tk, st, o) => {
    const f = o[0]!;
    if (kicked) return;
    const q = st.players[HS]!;
    if (runUp > 0) stick(f, GOAL_X - q.x, aimZ - q.z); else stick(f, GOAL_X - x, aimZ - z);
    if (pressAt < 0) {
      if (q.x < x) { f.buttons |= Btn.MOD_R; return; }
      pressAt = tk;
    }
    if (style === 'finesse') f.buttons |= Btn.MOD_R;
    if (style === 'power') f.buttons |= Btn.MOD_R | Btn.MOD_L;
    if (style === 'trivela') f.buttons |= Btn.SHIELD;
    if (tk - pressAt < hold) f.buttons |= Btn.SHOOT;
  }, {
    until: (st, ev) => {
      for (const e of ev) {
        if (e.type === EventType.KICK && e.a === HS && ((e.b >= KickKind.SHOT_NORMAL && e.b <= KickKind.SHOT_LOW_DRIVEN) || e.b === KickKind.SHOT_TRIVELA)) kicked = true;
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

export interface ShotTally { n: number; goals: number; saved: number; off: number }

/** Probe A: the five spots at both corners, seeds; the keeper set on his line (setKeeper) or caught off it where the
 *  scenario puts him (about 8.6 m out). */
export function shotRate(style: KShot, seeds: readonly number[], shooter?: number, setKeeper = true): ShotTally {
  const r = { n: 0, goals: 0, saved: 0, off: 0 };
  for (const [x, z] of SPOTS) for (const aim of AIMS) for (const seed of seeds) {
    const o = shotVsKeeper(style, x, z, aim, seed, shooter, Difficulty.PROFESSIONAL, setKeeper);
    r.n++;
    if (o === 'goal') r.goals++; else if (o === 'saved') r.saved++; else r.off++;
  }
  return r;
}

/** [FEEL-2 round 2] Probe R (the FEEL-2 skeptics' round-2 running probe): SPOTS_R at both corners (AIMS_R), struck at
 *  the end of a 5 m R1 run (SHOOT 26 ticks), the keeper set on his line (he comes out at the runner) or where the
 *  scenario puts him; `level` keeper. */
export const SPOTS_R: readonly (readonly [number, number])[] = [...SPOTS, [28, 4], [40, -14]];
export const AIMS_R: readonly number[] = [2.8, -2.8, 2.0, -2.0];
export function shotRateRun(style: KShot, seeds: readonly number[], shooter?: number, setKeeper = true, level = Difficulty.PROFESSIONAL, runUp = 5): ShotTally {
  const r = { n: 0, goals: 0, saved: 0, off: 0 };
  for (const [x, z] of SPOTS_R) for (const aim of AIMS_R) for (const seed of seeds) {
    const o = shotVsKeeper(style, x, z, aim, seed, shooter, level, setKeeper, 26, runUp);
    r.n++;
    if (o === 'goal') r.goals++; else if (o === 'saved') r.saved++; else r.off++;
  }
  return r;
}

/** Probe B (SPOTS_B x AIMS_B x HOLDS_B x seeds), one keeper situation. */
export function shotRateB(style: KShot, seeds: readonly number[], shooter?: number, setKeeper = true): ShotTally {
  const r = { n: 0, goals: 0, saved: 0, off: 0 };
  for (const [x, z] of SPOTS_B) for (const aim of AIMS_B) for (const seed of seeds) for (const hold of HOLDS_B) {
    const o = shotVsKeeper(style, x, z, aim, seed, shooter, Difficulty.PROFESSIONAL, setKeeper, hold);
    r.n++;
    if (o === 'goal') r.goals++; else if (o === 'saved') r.saved++; else r.off++;
  }
  return r;
}
