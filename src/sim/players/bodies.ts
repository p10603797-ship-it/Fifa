/**
 * [SIM-05] Body contact: players collide as soft circles weighted by strength (no overlap beyond tolerance
 * for more than 1 s), shoulder-to-shoulder when running alongside, shielding puts the body between ball and
 * opponent (SHIELD action / p.shielding). Players never walk through the goal frame or net.
 * Emits BODY_CONTACT for audio.
 *
 * Runs as pipeline stage 6 (after SIM-04 locomotion, before ball physics). Per tick:
 *  1. Per-player scratch: body radius (T_PLAYER.bodyRadius scaled +-10% by height), inverse mass (strength;
 *     x shieldMassMul for an active shielder), anchors (a keeper inside his own goal area or holding the ball, the
 *     restart taker before the restart is taken: never pushed by bodies), movement intent (for the slide-around).
 *  2. Shielding (isShielding: the ball owner in the SHIELD action): the body swings round the ball onto the
 *     ball-opponent line (never pushed out toward the opponent: the standoff is the strength duel), lookAt the nearest
 *     opponent, a speed backstop (SIM-04 caps the SHIELD speed itself), and the challenger is held off (shieldBlocks).
 *     [QF-16] Held off, not walked back: a shielder backing into the challenger (faster than shieldDriveSpeed along the
 *     contact normal) is the one held off for that pair.
 *     [QF-16 third attempt] Brace: likewise a walking ball carrier (intended speed below braceMaxSpeed) driving into an
 *     opponent who stands his ground (on his feet, his intent giving way slower than braceGiveSpeed along the normal) is
 *     the one held off: a human walked a top-level CPU defender back 10 m into his six-yard box. Intents, not
 *     velocities: the contact's normal damping hands the pushed man the pusher's speed every tick. Only in a pair with a
 *     human-controlled player (ctrl below CPU_CONTROLLER_BASE): bot-v-bot contact is unchanged.
 *  The slide-around: a player whose intent pushes into a body that blocks his way (ARRIVE target well beyond it; stick
 *  pushers only round teammates or an opponent pushing back) is nudged sideways, both of a head-on pair to their own
 *  right unless their intents/velocities prefer a side, so nobody runs in place and same-target players do not orbit.
 *  3. Up to T_BODY.iterations Gauss-Seidel passes over all active pairs in fixed slot order (i < j); another
 *     pass runs only while the last one met an overlap above passOverlap. Positional separation split by priority
 *     (a man down in a restart set-up [QF-13 skeptic] > anchor / shield hold > constraint pin > free) and inverse
 *     mass: a soft fraction of the overlap, hard to at
 *     least hardMin when the overlap is beyond tolerance. On the first pass also: velocity damping along the contact
 *     normal, the slide-around nudge for players pushing into a body that blocks their way (anti "run in place"),
 *     BODY_CONTACT events. After each pass: SIM-04 confinePlayer (boards, goal frame and net) for every player the
 *     pass moved near a board or goal; a player moved back by it is pinned for the rest of the tick.
 *
 * Shielding contract (SIM-15 / TAI / SIM-04 / SIM-06 / SIM-14):
 *  - The SHIELD action is the shield state (SIM-04 derives p.shielding = act SHIELD and caps the speed). The
 *    resolver starts/stops it with bodiesShield.ts applyShieldIntent(s, slot, held) every tick (or startShield /
 *    stopShield). The handler ends it when the player loses the ball, the keeper has it in hands, he is stunned, or
 *    p.shielding is written to 0 (release) after the first tick. A pass/shot press while shielding: stopShield first
 *    (the starters need isFree).
 *  - SIM-06: keep the ball at shieldBallSpot() (far side of the body from the challenger) while isShielding().
 *  - SIM-06 / SIM-14: shieldBlocks() / shieldFactor() say whether a challenger can get at the ball.
 *  - SIM-14: shoulderToShoulder() / shoulderPartner() say a shoulder challenge is possible.
 *  - This file must not import sim/actions/dispatch (registry imports it: cycle); starters live in bodiesShield.ts.
 *
 * Determinism: plain arithmetic + Math.sqrt only, fixed iteration order, no allocation per tick (module scratch).
 */
import {
  BOARD_X, BOARD_Z, CPU_CONTROLLER_BASE, DT, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, GOAL_DEPTH, GOAL_HALF_WIDTH, HALF_LENGTH, NUM_SLOTS,
  POST_RADIUS,
} from '../../contracts/constants';
import { ActionKind, MatchPhase } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import type { ActionHandler } from '../../contracts/systems';
import { MoveMode, type SimState } from '../../contracts/state';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_PLAYER, T_BODY } from '../../contracts/tuning';
import { confinePlayer } from './locomotion';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_BODY. */
export const LOCAL_TUNING = T_BODY;


const L = T_BODY;
const EPS = 1e-9;
/** Absolute floor for the hard separation (keeps every pair clear of the section 14 overlap invariant). */
const HARD_FLOOR = 2 * T_PLAYER.bodyRadius - T_PLAYER.overlapTolerance + L.hardMargin;
const NET_BACK_X = HALF_LENGTH + GOAL_DEPTH;
/**
 * Pre-check for SIM-04 confinePlayer: it only moves a body centre that is inside a goal box (posts + netting + mouth,
 * grown by a body radius) or within a body radius of the boards. Outside these zones (grown by NEAR_MARGIN) the call
 * is skipped (cost).
 */
const NEAR_MARGIN = 0.15;
const BODY_R_MAX = T_PLAYER.bodyRadius * (1 + L.radiusHeightScale);
const NEAR_GOAL_X = HALF_LENGTH - BODY_R_MAX - NEAR_MARGIN;
const NEAR_GOAL_Z = GOAL_HALF_WIDTH + POST_RADIUS + BODY_R_MAX + NEAR_MARGIN;
const NEAR_BOARD_X = BOARD_X - BODY_R_MAX - NEAR_MARGIN;
const NEAR_BOARD_Z = BOARD_Z - BODY_R_MAX - NEAR_MARGIN;

// Module-local copies of imported constants used per tick (imported bindings can be accessor calls in dev tooling).
const NS = NUM_SLOTS;
const HALF_NS = NUM_SLOTS / 2;
const TICK_DT = DT;
const BODY_R = T_PLAYER.bodyRadius;
const OVERLAP_TOL = T_PLAYER.overlapTolerance;
const ARRIVE_STOP = T_PLAYER.arriveStop;
/** [QF-9] Largest speed change of a give-way in one tick: his braking (T_PLAYER.decel) over a tick, m/s. */
const BRAKE_DV = T_PLAYER.decel * DT;
const SHIELD_SPEED_FRAC = T_PLAYER.shieldSpeedFraction;
const JOG_FRAC = T_PLAYER.jogFraction;
const KEEPER_MIN_DEPTH = HALF_LENGTH - GOAL_AREA_DEPTH - L.keeperAreaSlack;
const KEEPER_MAX_Z = GOAL_AREA_HALF_WIDTH + L.keeperAreaSlack;
const ACT_SHIELD = ActionKind.SHIELD;
const ACT_FALLEN = ActionKind.FALLEN;
const ACT_GET_UP = ActionKind.GET_UP;
const MODE_DIRECT = MoveMode.DIRECT;
const MODE_ARRIVE = MoveMode.ARRIVE;
const EV_BODY_CONTACT = EventType.BODY_CONTACT;
const RESTART_LIST = RESTART_PHASES;

// ---------------------------------------------------------------- module scratch (never carries state across ticks)

const sActive = new Uint8Array(NS);
const sRad = new Float64Array(NS);
/** Inverse mass (strength; shield multiplier for the shielder). */
const sIm = new Float64Array(NS);
/** Inverse mass from strength only (split between two bodies of the same priority level above 0). */
const sImRaw = new Float64Array(NS);
/** 1 = anchored this tick (keeper priority, restart taker): outranks pins and free bodies. */
const sAnc = new Uint8Array(NS);
/** 1 = clamped by a constraint this tick (immovable for the remaining passes unless the other body is anchored). */
const sPin = new Uint8Array(NS);
/**
 * [QF-13 skeptic] 1 = lying on the ground (FALLEN / GET_UP) during a restart set-up: outranks everything, the walkers
 * go round him. The set-up walkers (the anchored taker first) shoved a man lying by the foul spot up to 2 m along the
 * ground (the closing speed handed to him, then his LOCKED slide), at 0.8 set-ups a match, twice onto the free-kick
 * ball placed beside him.
 */
const sDown = new Uint8Array(NS);
/** Position at the start of the stage (after locomotion). */
const sX0 = new Float64Array(NS);
const sZ0 = new Float64Array(NS);
/** Movement intent: 0 none, 1 DIRECT, 2 ARRIVE; unit direction; ARRIVE distance to the target. */
const sDrive = new Uint8Array(NS);
const sUx = new Float64Array(NS);
const sUz = new Float64Array(NS);
const sTd = new Float64Array(NS);
/** 1 = the shielding owner holds this opponent off (shieldBlocks). */
const sHold = new Uint8Array(NS);
let sShielder = -1;
/** [QF-16] Brace: the ball owner (not shielding, in play; -1 none), who is on his feet (1) and each player's intended
 *  velocity (SIM-04 movement intent: the stick x his jog / top speed, or toward his ARRIVE target), m/s. */
let sOwner = -1;
let sWalk = 0;
const sSet = new Uint8Array(NS);
const sIvx = new Float64Array(NS);
const sIvz = new Float64Array(NS);
/** [0] = largest overlap met by the last pass, m (typed-array scratch: a module-level double would be boxed). */
const sPass = new Float64Array(1);
let sEvents = 0;

// ---------------------------------------------------------------- body properties

/** Collision radius of a slot's body, m: T_PLAYER.bodyRadius scaled +-10% by height. */
export function bodyRadiusOf(s: SimState, slot: number): number {
  const h = s.attrs[slot]!.height;
  let t = (h - L.heightRef) / L.heightSpan;
  if (!(t > -1)) t = -1; else if (t > 1) t = 1; // also maps NaN to -1
  return BODY_R * (1 + L.radiusHeightScale * t);
}

/**
 * [QF-7S] bodyRadiusOf with the result in BODY_RADIUS_OUT[0] (same arithmetic), for per-tick callers that V8 does not
 * inline it into: a returned double is boxed (16 B per call; SIM-14's tackle contact checks made six a tick).
 */
export const BODY_RADIUS_OUT = new Float64Array(1);
export function bodyRadiusInto(s: SimState, slot: number): void {
  const h = s.attrs[slot]!.height;
  let t = (h - L.heightRef) / L.heightSpan;
  if (!(t > -1)) t = -1; else if (t > 1) t = 1; // also maps NaN to -1
  BODY_RADIUS_OUT[0] = BODY_R * (1 + L.radiusHeightScale * t);
}

/** Body mass (dimensionless, ~0.6..1.4) from strength; before shield and anchor modifiers. */
export function bodyMassOf(s: SimState, slot: number): number {
  let st = s.attrs[slot]!.strength;
  if (!(st > 1)) st = 1; else if (st > 99) st = 99;
  return 1 + L.strengthMassK * (st - 50) / 50;
}

/** Distance below which two bodies touch (sum of radii), m. */
export function contactDistance(s: SimState, a: number, b: number): number {
  return bodyRadiusOf(s, a) + bodyRadiusOf(s, b);
}

function isRestartPhase(phase: MatchPhase): boolean {
  for (let k = 0; k < RESTART_LIST.length; k++) if (RESTART_LIST[k] === phase) return true;
  return false;
}

/** Keeper inside his own goal area (with slack, goal mouth included), or holding the ball: bodies never push him. */
export function keeperHasPriority(s: SimState, slot: number): boolean {
  const p = s.players[slot]!;
  if (p.isKeeper !== 1 || p.active !== 1) return false;
  if (s.ball.heldBy === slot) return true;
  const t = s.teams[p.team];
  if (!t) return false;
  const depth = -t.dir * p.x; // HALF_LENGTH on the own goal line, larger behind it
  const az = p.z < 0 ? -p.z : p.z;
  return depth >= KEEPER_MIN_DEPTH && depth <= NET_BACK_X && az <= KEEPER_MAX_Z;
}

/** True when bodies never push this slot this tick (keeper priority, restart taker). */
export function isAnchored(s: SimState, slot: number): boolean {
  if (keeperHasPriority(s, slot)) return true;
  const m = s.match;
  return m.restart.taker === slot && m.restart.taken === 0 && isRestartPhase(m.phase);
}

// ---------------------------------------------------------------- shielding

/** Ball owner (feet, not hands) in the SHIELD action, not stunned. */
export function isShielding(s: SimState, slot: number): boolean {
  if (slot < 0 || slot >= NS) return false;
  const p = s.players[slot]!;
  const b = s.ball;
  return p.active === 1 && p.act === ACT_SHIELD && b.owner === slot && b.heldBy < 0 && p.stunT <= 0;
}

/** Nearest active opponent (not on the ground) within shieldRange of `slot`; -1 none. Ties: lower slot. */
export function shieldTarget(s: SimState, slot: number): number {
  const p = s.players[slot]!;
  const first = p.team === 0 ? HALF_NS : 0;
  let best = -1;
  let bestD2 = L.shieldRange * L.shieldRange;
  for (let j = first; j < first + HALF_NS; j++) {
    const q = s.players[j]!;
    if (q.active !== 1 || q.team === p.team || q.act === ACT_FALLEN || q.act === ACT_GET_UP) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = j; }
  }
  return best;
}

/** True if the owner's body lies between the challenger and the ball (within reach of the line from one to the other). */
function shieldCovers(s: SimState, owner: number, challenger: number): boolean {
  const o = s.players[owner]!, c = s.players[challenger]!, b = s.ball;
  const ocx = o.x - c.x, ocz = o.z - c.z;
  if (ocx * ocx + ocz * ocz > L.shieldRange * L.shieldRange) return false;
  const cbx = b.x - c.x, cbz = b.z - c.z;
  const len2 = cbx * cbx + cbz * cbz;
  if (len2 < EPS) return false;
  const len = Math.sqrt(len2);
  const proj = (ocx * cbx + ocz * cbz) / len; // owner's distance along challenger -> ball
  const r = bodyRadiusOf(s, owner);
  if (proj <= 0 || proj > len + 0.5 * r) return false;
  const px = ocx - (cbx / len) * proj, pz = ocz - (cbz / len) * proj;
  const lim = r + L.shieldCoverMargin;
  return px * px + pz * pz <= lim * lim;
}

/**
 * How well `owner` shields the ball from `challenger`, 0..1 (0 = no effect). Non-zero only when the owner is shielding,
 * the challenger is an active opponent within shieldRange and the owner's body covers the ball from him; then a
 * strength duel (owner + shieldStrengthBonus vs challenger) mapped over shieldFactorSpan, 0.5 at a tie. Pure.
 */
export function shieldFactor(s: SimState, owner: number, challenger: number): number {
  if (challenger < 0 || challenger >= NS || owner === challenger || !isShielding(s, owner)) return 0;
  const o = s.players[owner]!, c = s.players[challenger]!;
  if (c.active !== 1 || c.team === o.team) return 0;
  if (!shieldCovers(s, owner, challenger)) return 0;
  const diff = s.attrs[owner]!.strength + L.shieldStrengthBonus - s.attrs[challenger]!.strength;
  const f = 0.5 + diff / L.shieldFactorSpan;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** True when the shielding owner holds the challenger off the ball (SIM-06 pick-up / SIM-14 tackle gate). Pure. */
export function shieldBlocks(s: SimState, owner: number, challenger: number): boolean {
  return shieldFactor(s, owner, challenger) >= 0.5;
}

/**
 * Where SIM-06 should keep the ball while `slot` shields: shieldBallDist behind the body on the far side from the
 * nearest opponent. Returns false (out untouched) when not shielding or nobody is within shieldRange.
 */
export function shieldBallSpot(s: SimState, slot: number, out: { x: number; z: number }): boolean {
  if (!isShielding(s, slot)) return false;
  const c = shieldTarget(s, slot);
  if (c < 0) return false;
  const p = s.players[slot]!, q = s.players[c]!;
  let dx = p.x - q.x, dz = p.z - q.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < EPS) { dx = -p.fx; dz = -p.fz; } else { dx /= d; dz /= d; }
  out.x = p.x + dx * L.shieldBallDist;
  out.z = p.z + dz * L.shieldBallDist;
  return true;
}

/** Face the nearest opponent while shielding (lookAt intent read by SIM-04); no opponent near = normal facing. */
export function shieldLook(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const c = shieldTarget(s, slot);
  if (c < 0) { p.lookAt = 0; return; }
  const q = s.players[c]!;
  p.lookAt = 1;
  p.lookX = q.x;
  p.lookZ = q.z;
}

/** ActionKind.SHIELD handler (shielding while in possession with L2 held). */
export const shieldHandler: ActionHandler = {
  update(s, slot) {
    const p = s.players[slot]!;
    const b = s.ball;
    // p.shielding is SIM-04's "act is SHIELD" flag; 0 after the first tick means the resolver released it.
    if (b.owner !== slot || b.heldBy >= 0 || p.stunT > 0 || (p.actT > 1 && p.shielding === 0)) {
      p.actDur = p.actT; // the dispatcher ends it this tick
      return;
    }
    p.actDur = p.actT + 1; // open-ended while held
    p.shielding = 1;
    shieldLook(s, slot);
  },
  end(s, slot) {
    const p = s.players[slot]!;
    p.shielding = 0;
    p.lookAt = 0;
  },
};

/**
 * Shield movement (stage 6): speed backstop (SIM-04 caps the SHIELD speed; this cap ignores stamina so it only
 * catches a missing cap), swing the body round the ball onto the ball-opponent line, keep facing the opponent.
 * Call-free on purpose (no double returns across calls: no allocation).
 */
function shieldStep(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const vmax = L.shieldSpeedBackstop * SHIELD_SPEED_FRAC * JOG_FRAC * s.attrs[slot]!.topSpeed;
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  if (sp > vmax && sp > EPS) {
    const k = vmax / sp;
    p.x -= p.vx * (1 - k) * TICK_DT;
    p.z -= p.vz * (1 - k) * TICK_DT;
    p.vx *= k;
    p.vz *= k;
  }
  const c = shieldTarget(s, slot);
  if (c < 0) return;
  const q = s.players[c]!;
  const b = s.ball;
  let ux = q.x - b.x, uz = q.z - b.z;
  const ul = Math.sqrt(ux * ux + uz * uz);
  const ox = p.x - b.x, oz = p.z - b.z;
  const rho = Math.sqrt(ox * ox + oz * oz);
  if (rho > 1e-6 && ul > 1e-6) {
    // Swing round the ball (arc step of at most shieldTrackSpeed) onto the ball-opponent line, and close in when
    // farther than shieldBallDist; never move out toward the opponent: the standoff is the strength duel of the contact.
    ux /= ul; uz /= ul;
    let dx = ox / rho, dz = oz / rho;
    const step = L.shieldTrackSpeed * TICK_DT;
    const ang = step / (rho > L.shieldBallDist ? rho : L.shieldBallDist); // radians this tick (small)
    const gx = ux - dx, gz = uz - dz;
    if (gx * gx + gz * gz <= ang * ang) { dx = ux; dz = uz; } else {
      const side = dx * uz - dz * ux >= 0 ? 1 : -1; // turn toward the opponent's side (exactly opposite: +)
      const nx = dx - side * dz * ang, nz = dz + side * dx * ang;
      const nl = Math.sqrt(nx * nx + nz * nz);
      dx = nx / nl; dz = nz / nl;
    }
    let r = rho;
    if (r > L.shieldBallDist) { r -= step; if (r < L.shieldBallDist) r = L.shieldBallDist; }
    p.x = b.x + dx * r;
    p.z = b.z + dz * r;
  }
  p.lookAt = 1;
  p.lookX = q.x;
  p.lookZ = q.z;
}

/** Stage-internal shieldBlocks for the active shielder (body radius from scratch; boolean result, call-free). */
function holdsOff(s: SimState, owner: number, challenger: number): boolean {
  const o = s.players[owner]!, c = s.players[challenger]!, b = s.ball;
  if (c.active !== 1 || c.team === o.team) return false;
  if (s.attrs[owner]!.strength + L.shieldStrengthBonus < s.attrs[challenger]!.strength) return false;
  const ocx = o.x - c.x, ocz = o.z - c.z;
  if (ocx * ocx + ocz * ocz > L.shieldRange * L.shieldRange) return false;
  const cbx = b.x - c.x, cbz = b.z - c.z;
  const len2 = cbx * cbx + cbz * cbz;
  if (len2 < EPS) return false;
  const len = Math.sqrt(len2);
  const proj = (ocx * cbx + ocz * cbz) / len;
  const r = sRad[owner]!;
  if (proj <= 0 || proj > len + 0.5 * r) return false;
  const px = ocx - (cbx / len) * proj, pz = ocz - (cbz / len) * proj;
  const lim = r + L.shieldCoverMargin;
  return px * px + pz * pz <= lim * lim;
}

// ---------------------------------------------------------------- shoulder to shoulder

/**
 * True if a and b (active, different slots) are running alongside each other in body contact: both faster than
 * shoulderMinSpeed, running directions roughly parallel, side by side, within touching distance + shoulderSlack. Pure.
 */
export function shoulderToShoulder(s: SimState, a: number, b: number): boolean {
  if (a === b || a < 0 || b < 0 || a >= NS || b >= NS) return false;
  const p = s.players[a]!, q = s.players[b]!;
  if (p.active !== 1 || q.active !== 1) return false;
  const dx = q.x - p.x, dz = q.z - p.z;
  const lim = bodyRadiusOf(s, a) + bodyRadiusOf(s, b) + L.shoulderSlack;
  if (dx * dx + dz * dz > lim * lim) return false;
  return alongside(s, a, b);
}

/** Running side by side (speeds, parallel running directions, normal across the run). Int arguments: call-cheap. */
function alongside(s: SimState, a: number, b: number): boolean {
  const p = s.players[a]!, q = s.players[b]!;
  const avx = p.vx, avz = p.vz, bvx = q.vx, bvz = q.vz;
  const sa = Math.sqrt(avx * avx + avz * avz), sb = Math.sqrt(bvx * bvx + bvz * bvz);
  if (sa < L.shoulderMinSpeed || sb < L.shoulderMinSpeed) return false;
  const dx = q.x - p.x, dz = q.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return false;
  const ax = avx / sa, az = avz / sa, bx = bvx / sb, bz = bvz / sb;
  if (ax * bx + az * bz < L.shoulderParallelCos) return false;
  const mx = ax + bx, mz = az + bz;
  const ml = Math.sqrt(mx * mx + mz * mz); // >= sqrt(2 + 2 * parallelCos) > 0
  const side = (dx * mx + dz * mz) / (d * ml);
  return side < L.shoulderSideMax && side > -L.shoulderSideMax;
}

/** Nearest opponent running shoulder to shoulder with `slot`, -1 none (for SIM-14 shoulder challenges). */
export function shoulderPartner(s: SimState, slot: number): number {
  if (slot < 0 || slot >= NS) return -1;
  const p = s.players[slot]!;
  let best = -1;
  let bestD2 = Infinity;
  for (let j = 0; j < NS; j++) {
    const q = s.players[j]!;
    if (j === slot || q.team === p.team || !shoulderToShoulder(s, slot, j)) continue;
    const dx = q.x - p.x, dz = q.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { bestD2 = d2; best = j; }
  }
  return best;
}

// ---------------------------------------------------------------- the stage

function prepare(s: SimState): void {
  const b = s.ball;
  sShielder = b.owner >= 0 && b.owner < NS && isShielding(s, b.owner) ? b.owner : -1;
  sWalk = 0;
  sOwner = s.match.phase === MatchPhase.IN_PLAY && b.owner >= 0 && b.owner < NS && b.heldBy < 0 && sShielder < 0 ? b.owner : -1;
  sEvents = 0;
  const setup = s.match.restart.taken === 0 && isRestartPhase(s.match.phase);
  for (let i = 0; i < NS; i++) {
    const p = s.players[i]!;
    sActive[i] = p.active === 1 ? 1 : 0;
    sPin[i] = 0;
    sAnc[i] = 0;
    sDown[i] = 0;
    sHold[i] = 0;
    sDrive[i] = 0;
    sSet[i] = 0;
    sIvx[i] = 0;
    sIvz[i] = 0;
    if (p.active !== 1) continue;
    sSet[i] = p.stunT <= 0 && p.act !== ActionKind.STUMBLE && p.act !== ACT_FALLEN && p.act !== ACT_GET_UP &&
      p.act !== ActionKind.GK_DIVE ? 1 : 0;
    intentVel(s, i);
    if (i === sOwner) sWalk = sIvx[i]! * sIvx[i]! + sIvz[i]! * sIvz[i]! < L.braceMaxSpeed * L.braceMaxSpeed ? 1 : 0;
    sRad[i] = bodyRadiusOf(s, i);
    const m = bodyMassOf(s, i);
    sImRaw[i] = 1 / m;
    sIm[i] = i === sShielder ? 1 / (m * L.shieldMassMul) : 1 / m;
    sAnc[i] = isAnchored(s, i) ? 1 : 0;
    if (setup && (p.act === ACT_FALLEN || p.act === ACT_GET_UP)) sDown[i] = 1;
    // Movement intent for the slide-around (not for players holding a facing: jockey, contain, shield).
    if (p.lookAt === 1 || p.stunT > 0 || i === sShielder) continue;
    if (p.moveMode === MODE_DIRECT) {
      const mag = Math.sqrt(p.ix * p.ix + p.iz * p.iz);
      if (mag > L.slideMinIntent) { sDrive[i] = 1; sUx[i] = p.ix / mag; sUz[i] = p.iz / mag; }
    } else if (p.moveMode === MODE_ARRIVE) {
      const dx = p.tgtX - p.x, dz = p.tgtZ - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > ARRIVE_STOP + L.slideMinIntent) { sDrive[i] = 2; sUx[i] = dx / d; sUz[i] = dz / d; sTd[i] = d; }
    }
  }
}

/** [QF-16] sIvx/sIvz[i]: player i's intended velocity from his SIM-04 movement intent (DIRECT: the stick x his jog or,
 *  sprinting, top speed (attribute, before stamina: a threshold); ARRIVE: toward the target at most at the target speed;
 *  else 0). Inline arithmetic: a call to locomotion's maxSpeed boxed its result (SIM-05's no-allocation test). */
function intentVel(s: SimState, i: number): void {
  const p = s.players[i]!;
  const ts = s.attrs[i]!.topSpeed;
  const top = ts > 0 ? ts : T_PLAYER.topSpeedMin;
  if (p.moveMode === MODE_DIRECT) {
    const ix = p.ix === p.ix ? p.ix : 0, iz = p.iz === p.iz ? p.iz : 0;
    let m = Math.sqrt(ix * ix + iz * iz);
    if (!(m > 1e-6)) return;
    const v = (p.wantSprint === 1 ? top : top * T_PLAYER.jogFraction) * (m > 1 ? 1 : m);
    m = v / m;
    sIvx[i] = ix * m; sIvz[i] = iz * m;
  } else if (p.moveMode === MODE_ARRIVE) {
    const dx = p.tgtX - p.x, dz = p.tgtZ - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (!(d > ARRIVE_STOP)) return;
    let v = p.tgtSpeed === p.tgtSpeed ? p.tgtSpeed : 0;
    if (v > top) v = top;
    if (!(v > 0)) return;
    sIvx[i] = dx / d * v; sIvz[i] = dz / d * v;
  }
}

/** [QF-16] A human controller's player (controllers below CPU_CONTROLLER_BASE). */
function isHuman(ctrl: number): boolean { return ctrl >= 0 && ctrl < CPU_CONTROLLER_BASE; }

function snapshot(s: SimState): void {
  for (let i = 0; i < NS; i++) {
    const p = s.players[i]!;
    sX0[i] = p.x;
    sZ0[i] = p.z;
  }
}

function resolvePairs(s: SimState, first: boolean, ev: EventSink): void {
  const ps = s.players;
  let maxOverlap = 0;
  for (let i = 0; i < NS - 1; i++) {
    if (sActive[i] === 0) continue;
    const a = ps[i]!;
    const ra = sRad[i]!;
    for (let j = i + 1; j < NS; j++) {
      if (sActive[j] === 0) continue;
      const b = ps[j]!;
      const rs = ra + sRad[j]!;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rs * rs) continue;
      let d = Math.sqrt(d2);
      let nx: number, nz: number;
      if (d < 1e-6) { nx = -a.fz; nz = a.fx; d = 0; } else { nx = dx / d; nz = dz / d; }
      if (rs - d > maxOverlap) maxOverlap = rs - d;

      // Weights by priority level (a man down in a set-up 3 > anchor or shield hold 2 > constraint pin 1 > free 0):
      // the lower level moves. Same level: free bodies split by inverse mass (strength, shield), immovable ones by
      // strength alone.
      let lvA = sDown[i] === 1 ? 3 : sAnc[i] === 1 ? 2 : sPin[i]!;
      let lvB = sDown[j] === 1 ? 3 : sAnc[j] === 1 ? 2 : sPin[j]!;
      // [QF-16] The shield hold keeps a challenger off the ball; it does not let the shielder walk him back: backing
      // into the challenger (faster than shieldDriveSpeed along the normal) he is the one held off.
      if (sShielder === i && sHold[j] === 1) { if (a.vx * nx + a.vz * nz > L.shieldDriveSpeed) lvB = 2; else lvA = 2; }
      else if (sShielder === j && sHold[i] === 1) { if (-(b.vx * nx + b.vz * nz) > L.shieldDriveSpeed) lvA = 2; else lvB = 2; }
      // [QF-16] Brace: a carrier walking (or running) the ball into an opponent who stands his ground does not push him
      // back; he is the one held off (a human walked a top-level CPU defender back 10 m in 10 s into his six-yard box).
      else if (lvA === 0 && lvB === 0 && a.team !== b.team) {
        if (sOwner === i && sSet[j] === 1 && sIvx[i]! * nx + sIvz[i]! * nz > L.braceDriveSpeed && sWalk === 1 &&
          (isHuman(a.ctrl) || isHuman(b.ctrl)) &&
          sIvx[j]! * nx + sIvz[j]! * nz < L.braceGiveSpeed) lvB = 1;
        else if (sOwner === j && sSet[i] === 1 && -(sIvx[j]! * nx + sIvz[j]! * nz) > L.braceDriveSpeed && sWalk === 1 &&
          (isHuman(a.ctrl) || isHuman(b.ctrl)) &&
          -(sIvx[i]! * nx + sIvz[i]! * nz) < L.braceGiveSpeed) lvA = 1;
      }
      let wA: number;
      if (lvA > lvB) wA = 0;
      else if (lvB > lvA) wA = 1;
      else if (lvA === 0) wA = sIm[i]! / (sIm[i]! + sIm[j]!);
      else wA = sImRaw[i]! / (sImRaw[i]! + sImRaw[j]!);
      const wB = 1 - wA;

      // Positional separation: soft share of the overlap, hard to hardMin when beyond tolerance.
      let hardMin = rs - OVERLAP_TOL;
      if (hardMin < HARD_FLOOR) hardMin = HARD_FLOOR;
      if (hardMin > rs) hardMin = rs;
      let corr = L.softFraction * (rs - d);
      if (d + corr < hardMin) corr = hardMin - d;
      a.x -= nx * corr * wA; a.z -= nz * corr * wA;
      b.x += nx * corr * wB; b.z += nz * corr * wB;

      if (!first) continue;

      // Contact kind (before damping changes the velocities; separation moved both along n, so n is unchanged).
      const vrel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      const closing = vrel < 0 ? -vrel : 0;
      const shoulder = closing > L.shoulderApproach && a.team !== b.team && alongside(s, i, j);

      // Velocity damping along the normal (closing speed only).
      if (closing > 0) {
        const dv = closing * L.normalDamping;
        a.vx -= nx * dv * wA; a.vz -= nz * dv * wA;
        b.vx += nx * dv * wB; b.vz += nz * dv * wB;
      }

      // Slide round a body that blocks the way (anti "run in place"). A player pushes into the other when his intent
      // points within acos(slidePushCos) of the normal and, for ARRIVE, his target lies well beyond the other body.
      // Stick (DIRECT) pushers slide only round teammates or an opponent pushing back (else it is a body duel).
      const kA = sDrive[i]!, kB = sDrive[j]!;
      const pa = kA !== 0 && sUx[i]! * nx + sUz[i]! * nz > L.slidePushCos &&
        (kA === 1 || sTd[i]! > d + sRad[j]! + L.slideMinBeyond);
      const pb = kB !== 0 && -(sUx[j]! * nx + sUz[j]! * nz) > L.slidePushCos &&
        (kB === 1 || sTd[j]! > d + ra + L.slideMinBeyond);
      if (pa || pb) {
        const mates = a.team === b.team;
        const slideA = pa && (kA === 2 || mates || pb);
        const slideB = pb && (kB === 2 || mates || pa);
        if (slideA || slideB) {
          const tx = -nz, tz = nx; // a's right when facing b (b's right is -t)
          // [QF-9] Give way behind a body that moves across the push (along t faster than slideBehindSpeed): the
          // pusher's speed along the other's tangential run is capped slideSpeed below it, so he drops in behind and
          // goes round its back. The world-frame slide (below) against a body running alongside the same way set the
          // pusher's tangential speed to slideSpeed on whichever side the per-tick preferences gave, and when the
          // other body pushed back for a tick ("opposite ways") it reversed him: a runner and a defender running
          // together stayed locked at 0.75 m for 80 ticks with 14 velocity flips (QF-2 CR qf-2-cr-body-lock). Two
          // bodies running the same way that both push: only the one behind (the slower along t; ties: the higher
          // slot) gives way, so they part along their run instead of both braking.
          const vat = a.vx * tx + a.vz * tz, vbt = b.vx * tx + b.vz * tz;
          const wayMin = L.slideBehindSpeed > L.slideSpeed ? L.slideBehindSpeed : L.slideSpeed;
          let wayA = slideA && (vbt > wayMin || vbt < -wayMin);
          let wayB = slideB && (vat > wayMin || vat < -wayMin);
          if (wayA && wayB && vat * vbt > 0) {
            const aFaster = vat > 0 ? vat > vbt : vat < vbt;
            if (aFaster || vat === vbt) wayA = false; else wayB = false;
          }
          // He brakes toward the cap at most at his braking rate (T_PLAYER.decel): giving way is a deceleration, not an
          // instant stop (cutting 4-5 m/s in one tick changed TAI-07's chaser on a header in front of the box).
          const brake = BRAKE_DV;
          if (wayA) {
            const ux = vbt > 0 ? tx : -tx, uz = vbt > 0 ? tz : -tz;
            const cap = (vbt > 0 ? vbt : -vbt) - L.slideSpeed;
            const va = a.vx * ux + a.vz * uz;
            if (va > cap) {
              const dv = va - cap < brake ? va - cap : brake;
              a.vx -= dv * ux; a.vz -= dv * uz;
              a.x -= dv * ux * TICK_DT; a.z -= dv * uz * TICK_DT;
            }
          }
          if (wayB) {
            const ux = vat > 0 ? tx : -tx, uz = vat > 0 ? tz : -tz;
            const cap = (vat > 0 ? vat : -vat) - L.slideSpeed;
            const vb = b.vx * ux + b.vz * uz;
            if (vb > cap) {
              const dv = vb - cap < brake ? vb - cap : brake;
              b.vx -= dv * ux; b.vz -= dv * uz;
              b.x -= dv * ux * TICK_DT; b.z -= dv * uz * TICK_DT;
            }
          }
          // Side preference along t: intent plus the current tangential velocity (keeps a slide going one way).
          const spA = Math.sqrt(a.vx * a.vx + a.vz * a.vz), spB = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
          const prefA = sUx[i]! * tx + sUz[i]! * tz + L.slideVelBias * (a.vx * tx + a.vz * tz) / (spA > 1 ? spA : 1);
          const prefB = sUx[j]! * tx + sUz[j]! * tz + L.slideVelBias * (b.vx * tx + b.vz * tz) / (spB > 1 ? spB : 1);
          let sgA = 0, sgB = 0; // slide direction along t: +1 / -1, 0 = none
          const wsA = slideA && !wayA, wsB = slideB && !wayB; // world-frame slides
          if (wsA && wsB) { sgA = prefA - prefB < -L.slideSideEps ? -1 : 1; sgB = -sgA; } // opposite ways
          else if (wsA) sgA = prefA < -L.slideSideEps ? -1 : 1; // default: a's right
          else if (wsB) sgB = prefB > L.slideSideEps ? 1 : -1; // default: b's right (-t)
          const ds = L.slideSpeed * TICK_DT;
          if (sgA !== 0) {
            const ux = sgA * tx, uz = sgA * tz;
            a.x += ux * ds; a.z += uz * ds;
            const vt = a.vx * ux + a.vz * uz;
            if (vt < L.slideSpeed) { a.vx += (L.slideSpeed - vt) * ux; a.vz += (L.slideSpeed - vt) * uz; }
          }
          if (sgB !== 0) {
            const ux = sgB * tx, uz = sgB * tz;
            b.x += ux * ds; b.z += uz * ds;
            const vt = b.vx * ux + b.vz * uz;
            if (vt < L.slideSpeed) { b.vx += (L.slideSpeed - vt) * ux; b.vz += (L.slideSpeed - vt) * uz; }
          }
        }
      }

      // Events: impacts and shoulder-to-shoulder contacts (rate-limited by the closing speed itself).
      if ((shoulder || closing > L.bumpSpeed) && sEvents < L.maxEventsPerTick) {
        sEvents++;
        const pushed = wB >= wA ? j : i;
        ev.emit(EV_BODY_CONTACT, pushed, shoulder || closing > L.shoveSpeed ? 1 : 0, closing,
          pushed === j ? i : j, (a.x + b.x) * 0.5, 0, (a.z + b.z) * 0.5);
      }
    }
  }
  sPass[0] = maxOverlap;
}

/**
 * Boards and goal frames (SIM-04 confinePlayer: boards, posts, side and back netting, goal mouth; the keeper may stand
 * on his line) for every player this stage moved, entering from his position at the start of the stage. A player
 * moved back by a constraint is pinned (immovable) for the rest of the tick.
 */
function constrain(s: SimState): void {
  for (let i = 0; i < NS; i++) {
    if (sActive[i] === 0) continue;
    const p = s.players[i]!;
    const x = p.x, z = p.z;
    if (x === sX0[i] && z === sZ0[i]) continue;
    const ax = x < 0 ? -x : x, az = z < 0 ? -z : z;
    // Only near a board or a goal frame (also keeps the non-inlined call, which boxes its arguments, off the hot path).
    if ((ax < NEAR_GOAL_X || az > NEAR_GOAL_Z) && ax < NEAR_BOARD_X && az < NEAR_BOARD_Z) continue;
    confinePlayer(s, i, sX0[i]!, sZ0[i]!);
    if (p.x !== x || p.z !== z) sPin[i] = 1;
  }
}

/** Pipeline stage 6: body collisions, shielding, shoulder contacts, goal frame. */
export function bodyContactTick(s: SimState, ev: EventSink): void {
  snapshot(s);
  prepare(s);
  if (sShielder >= 0) {
    shieldStep(s, sShielder);
    const p = s.players[sShielder]!;
    const first = p.team === 0 ? HALF_NS : 0;
    for (let j = first; j < first + HALF_NS; j++) if (sActive[j] === 1 && holdsOff(s, sShielder, j)) sHold[j] = 1;
  }
  for (let it = 0; it < L.iterations; it++) {
    resolvePairs(s, it === 0, ev);
    constrain(s);
    if (sPass[0]! < L.passOverlap) break;
  }
}
