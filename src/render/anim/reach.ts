/**
 * [QF-4] Ball-contact reach for the animator (GFX-12 mapper), FIX-08 / QA-32: "the kicking foot meets the ball on the
 * contact tick" for the ball the sim actually kicks, not only for the ball spot the clips were authored for.
 *
 *  - kickReach (foot-kick clips: pass, shot, power shot, finesse, volley, keeper drop kick, skill touch): the clip's
 *    contact point (REACH_BALL: where its boot meets the ball at the contact phase, measured once from the clip) is
 *    moved onto the predicted ball: the root shifts toward the ball by up to rootMax (a lunge) and drops by up to
 *    rootDropMax when the boot target is beyond the leg (a stretch), the kicking leg is re-solved with IK toward the
 *    ball and the support foot is re-planted where the clip put it; foot pitches kept. kickOffset + kickApply split
 *    it so the animator can rate-limit the boot offset between frames.
 *  - touchReach (locomotion: dribble touches, first touches): the leg's toe reaches toward the back of the ball by up
 *    to touchMax, foot pitch kept.
 * Inputs in the RCH scratch (model space of the posed player, reference-body metres: +x forward, +y up, +z right):
 * [0..2] ball centre, [3] weight 0..1. Allocation-free (module scratch, typed arrays only).
 */
import { AnimId, createPose, POSE_SIZE, PoseIdx, type Pose } from '../../contracts/render';
import { BODY, createSkeleton, FRAME_SIZE, Joint, solvePoseFK } from '../players/fk';
import { ACTION_CONTACT, ACTION_IMPLS } from './actions';
import { PP } from './locomotion';
import { FPA, FPR, footPitchS, IKT, legIKS, setFootPitchS } from './poseMath';

const LOCAL_TUNING = { // TUNING-CR (render-only animation constants)
  /** Largest root shift toward the ball (m, model) and the share of the contact offset the root takes. */
  rootMax: 0.3,
  rootShare: 0.5,
  /** Largest pelvis drop for a boot target beyond the leg (m, model), and the share of the leg (thigh + shin) the
   *  stretch aims for. */
  rootDropMax: 0.14,
  legReach: 0.97,
  /** Largest contact offset applied (m, model): a ball further from the clip's spot is reached as far as this goes;
   *  beyond kickGiveUp it is out of any reach (the sim whiffs, or a stale prediction) and the clip plays as authored
   *  (the reach fades out between the two). */
  kickMax: 0.9,
  kickGiveUp: 1.3,
  /** Ball centre ahead of the toe along the boot at contact (m): the toe touches the back of the ball. */
  toeToBall: 0.08,
  /** Locomotion touches: largest toe correction (m, model), and the root lunge toward the ball (share, cap m).
   *  [QF-4 skeptic] 0.38 / 0.22 -> 0.55 / 0.3: with the faster passes of QF-2 (assistArriveMin 7 m/s) most first touches
   *  happen at the sim's receive radius (1.0-1.1 m from the player) and the boot stopped 0.5-1 m short of the ball. */
  touchMax: 0.55,
  touchRootShare: 0.4,
  touchRootMax: 0.3,
  /** A ball further than this from the toe (m) is not reached for (a touch the body could never make). */
  touchGiveUp: 1.4,
} as const;

export const REACH_TUNING = LOCAL_TUNING;

/**
 * Diagnostics / tests switch (A/B measurements in one process while the sim changes underneath): 0 turns a part off.
 * kick = kickReach, touch = touch reach, align = the dribble's run-cycle phase alignment (mapper.ts).
 */
export const REACH_SWITCH = { kick: 1, touch: 1, align: 1 };

/** Reach arguments: [0..2] ball centre (model space), [3] weight 0..1. */
export const RCH = new Float64Array(4);

/** Clips kickReach supports. */
export function reachClip(anim: AnimId): boolean {
  return anim === AnimId.PASS || anim === AnimId.SHOT || anim === AnimId.POWER_SHOT || anim === AnimId.FINESSE
    || anim === AnimId.VOLLEY || anim === AnimId.GK_KICK || anim === AnimId.SKILL;
}

const SK = createSkeleton();
const SCRATCH = createPose();

/** Model-space toe (heel = 0) or heel (heel = 1) sole point of ankle joint j of the pose last solved into SK, into OUT3. */
const OUT3 = new Float64Array(3);
function solePointS(j: number, heel: number): void {
  const o = j * FRAME_SIZE;
  const lx = heel === 1 ? BODY.heelX : BODY.toeX, ly = -BODY.ankleY;
  OUT3[0] = SK[o]! * lx + SK[o + 3]! * ly + SK[o + 9]!;
  OUT3[1] = SK[o + 1]! * lx + SK[o + 4]! * ly + SK[o + 10]!;
  OUT3[2] = SK[o + 2]! * lx + SK[o + 5]! * ly + SK[o + 11]!;
}


/**
 * SIM-06's kicking spot (sim/players/possession.ts LOCAL_TUNING.holdAhead, m ahead of the feet on the facing): an owned
 * ball is held there through a kick's wind-up, so the ground-kick clips were authored to strike it there. Mirrored here
 * (render must not import sim modules).
 */
const SIM_HOLD_AHEAD = 0.5;

/**
 * Canonical ball centre per clip for the right foot (model space), 3 values per AnimId (NaN when unsupported): for the
 * ground kicks (pass, shot, power shot, finesse) the sim's kicking spot, where an owned ball sits at the contact (no
 * correction then); for the volley, the keeper's drop kick and the skill touch the toe point at the clip's contact
 * phase plus toeToBall along the boot. Built once at module load.
 */
export const REACH_BALL = new Float64Array((AnimId.STRAFE + 1) * 3).fill(NaN);
for (let a = 0; a <= AnimId.STRAFE; a++) {
  const id = a as AnimId;
  const impl = ACTION_IMPLS[id];
  const cf = ACTION_CONTACT[id];
  if (!reachClip(id) || !impl || cf === undefined) continue;
  if (id === AnimId.PASS || id === AnimId.SHOT || id === AnimId.POWER_SHOT || id === AnimId.FINESSE) {
    REACH_BALL[a * 3] = SIM_HOLD_AHEAD; REACH_BALL[a * 3 + 1] = 0.11; REACH_BALL[a * 3 + 2] = 0;
    continue;
  }
  PP[0] = cf; PP[1] = 0; PP[2] = 0; PP[3] = 1; PP[4] = 0;
  impl(SCRATCH);
  solvePoseFK(SCRATCH, SK);
  solePointS(Joint.ANKLE_R, 0);
  const tx = OUT3[0]!, ty = OUT3[1]!, tz = OUT3[2]!;
  solePointS(Joint.ANKLE_R, 1);
  let ux = tx - OUT3[0]!, uy = ty - OUT3[1]!, uz = tz - OUT3[2]!;
  const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  ux /= l; uy /= l; uz /= l;
  REACH_BALL[a * 3] = tx + ux * LOCAL_TUNING.toeToBall;
  REACH_BALL[a * 3 + 1] = ty + uy * LOCAL_TUNING.toeToBall;
  REACH_BALL[a * 3 + 2] = tz + uz * LOCAL_TUNING.toeToBall;
}

/** Ankle joint origin of leg `side` (-1 left / +1 right) of the pose last solved into SK, into OUT3. */
function ankleOf(side: number): void {
  const o = (side < 0 ? Joint.ANKLE_L : Joint.ANKLE_R) * FRAME_SIZE;
  OUT3[0] = SK[o + 9]!; OUT3[1] = SK[o + 10]!; OUT3[2] = SK[o + 11]!;
}

/** Kick reach offset (model metres) of the kicking boot: written by kickOffset, read by kickApply. */
export const KOF = new Float64Array(3);

/**
 * The boot offset kick reach applies for the ball in RCH with weight RCH[3] (clamped to kickMax, faded out toward
 * kickGiveUp, times the weight) into KOF. Returns 0 (KOF zeroed) for unsupported clips, a zero weight, a ball out of
 * reach or non-finite input.
 */
export function kickOffset(anim: AnimId, foot: number): number {
  KOF[0] = 0; KOF[1] = 0; KOF[2] = 0;
  const w = RCH[3]!;
  if (!(w > 0) || !reachClip(anim)) return 0;
  const a = anim * 3;
  const mz = foot === 1 ? -1 : 1;
  let dx = RCH[0]! - REACH_BALL[a]!, dy = RCH[1]! - REACH_BALL[a + 1]!, dz = RCH[2]! - REACH_BALL[a + 2]! * mz;
  if (!(dx === dx) || !(dy === dy) || !(dz === dz)) return 0;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  let wk = w;
  if (d > LOCAL_TUNING.kickMax) {
    const u = (d - LOCAL_TUNING.kickMax) / (LOCAL_TUNING.kickGiveUp - LOCAL_TUNING.kickMax);
    if (u >= 1) return 0;
    wk *= 1 - u * u * (3 - 2 * u);
    const k = LOCAL_TUNING.kickMax / d; dx *= k; dy *= k; dz *= k;
  }
  KOF[0] = dx * wk; KOF[1] = dy * wk; KOF[2] = dz * wk;
  return 1;
}

/**
 * Kick reach on clip pose `out` (anim, kicking foot 0 right / 1 left), toward the ball in RCH with weight RCH[3]. No-op
 * for unsupported clips, a zero weight or non-finite input.
 */
export function kickReach(out: Pose, anim: AnimId, foot: number): void {
  if (kickOffset(anim, foot) === 1) kickApply(out, anim, foot);
}

/**
 * Apply the boot offset in KOF (model metres, from kickOffset, possibly rate limited by the caller) to clip pose `out`:
 * root lunge, kicking leg re-solved to the offset boot, support foot re-planted, foot pitches kept.
 */
export function kickApply(out: Pose, anim: AnimId, foot: number): void {
  if (!reachClip(anim)) return;
  const dx = KOF[0]!, dy = KOF[1]!, dz = KOF[2]!;
  if (!(dx === dx) || !(dy === dy) || !(dz === dz) || (dx === 0 && dy === 0 && dz === 0)) return;
  const kick = foot === 1 ? -1 : 1, support = -kick;
  solvePoseFK(out, SK);
  ankleOf(kick);
  const kx = OUT3[0]! + dx, ky = OUT3[1]! + dy, kz = OUT3[2]! + dz;
  ankleOf(support);
  const sx = OUT3[0]!, sy = OUT3[1]!, sz = OUT3[2]!;
  // Foot pitches before the root moves (legTo re-reads them after the shift: same angles, so same pitches).
  footPitchS(out, kick);
  const pk = FPR[0]!;
  footPitchS(out, support);
  const ps = FPR[0]!;
  // Lunge: the root takes a share of the horizontal offset (capped).
  let rx = dx * LOCAL_TUNING.rootShare, rz = dz * LOCAL_TUNING.rootShare;
  const rl = Math.sqrt(rx * rx + rz * rz);
  if (rl > LOCAL_TUNING.rootMax) { const k = LOCAL_TUNING.rootMax / rl; rx *= k; rz *= k; }
  out[PoseIdx.ROOT_FWD] = out[PoseIdx.ROOT_FWD]! + rx;
  out[PoseIdx.ROOT_SIDE] = out[PoseIdx.ROOT_SIDE]! + rz;
  // Stretch: a boot target beyond the kicking leg's length from its hip lowers the pelvis (the support knee bends)
  // until the leg reaches, by at most rootDropMax (a ball wide of the body is met with a low stretch, not short).
  solvePoseFK(out, SK);
  const ho = (kick < 0 ? Joint.HIP_L : Joint.HIP_R) * FRAME_SIZE;
  const hx = kx - SK[ho + 9]!, hy = SK[ho + 10]! - ky, hz = kz - SK[ho + 11]!;
  const reach = (BODY.thigh + BODY.shin) * LOCAL_TUNING.legReach;
  const h2 = hx * hx + hz * hz;
  if (hy > 0 && h2 + hy * hy > reach * reach) {
    let drop = h2 < reach * reach ? hy - Math.sqrt(reach * reach - h2) : LOCAL_TUNING.rootDropMax;
    if (drop > LOCAL_TUNING.rootDropMax) drop = LOCAL_TUNING.rootDropMax;
    if (drop > 0) out[PoseIdx.ROOT_Y] = out[PoseIdx.ROOT_Y]! - drop;
  }
  IKT[0] = kx; IKT[1] = ky; IKT[2] = kz;
  FPA[0] = pk;
  legIKS(out, kick);
  setFootPitchS(out, kick);
  IKT[0] = sx; IKT[1] = sy; IKT[2] = sz;
  FPA[0] = ps;
  legIKS(out, support);
  setFootPitchS(out, support);
}

/**
 * Touch reach on a locomotion pose: leg `side`'s toe (0: the leg whose toe is nearer the ball) moves toward the back of
 * the ball in RCH (toeToBall short of its centre along the line from the toe), by at most touchMax, scaled by RCH[3].
 * Foot pitch kept.
 */
export function touchReach(out: Pose, side: number): void {
  const w = RCH[3]!;
  if (!(w > 0)) return;
  solvePoseFK(out, SK);
  let s = side < 0 ? -1 : 1;
  if (side === 0) {
    // The leg whose toe is nearer the ball.
    solePointS(Joint.ANKLE_L, 0);
    const lx = RCH[0]! - OUT3[0]!, ly = RCH[1]! - OUT3[1]!, lz = RCH[2]! - OUT3[2]!;
    solePointS(Joint.ANKLE_R, 0);
    const qx = RCH[0]! - OUT3[0]!, qy = RCH[1]! - OUT3[1]!, qz = RCH[2]! - OUT3[2]!;
    s = lx * lx + ly * ly + lz * lz < qx * qx + qy * qy + qz * qz ? -1 : 1;
  }
  solePointS(s < 0 ? Joint.ANKLE_L : Joint.ANKLE_R, 0);
  let dx = RCH[0]! - OUT3[0]!, dy = RCH[1]! - OUT3[1]!, dz = RCH[2]! - OUT3[2]!;
  if (!(dx === dx) || !(dy === dy) || !(dz === dz)) return;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d > LOCAL_TUNING.toeToBall) || d >= LOCAL_TUNING.touchGiveUp) return;
  const want = d - LOCAL_TUNING.toeToBall;
  // Lunge: the root takes a share of the horizontal reach (capped); the other foot stays where it is.
  let rx = (dx / d) * want * LOCAL_TUNING.touchRootShare * w, rz = (dz / d) * want * LOCAL_TUNING.touchRootShare * w;
  const rl = Math.sqrt(rx * rx + rz * rz);
  if (rl > LOCAL_TUNING.touchRootMax) { const q = LOCAL_TUNING.touchRootMax / rl; rx *= q; rz *= q; }
  let m = want;
  if (m > LOCAL_TUNING.touchMax + Math.sqrt(rx * rx + rz * rz)) m = LOCAL_TUNING.touchMax + Math.sqrt(rx * rx + rz * rz);
  const k = (m * w) / d;
  dx *= k; dy *= k; dz *= k;
  ankleOf(s);
  const ax = OUT3[0]! + dx, ay = OUT3[1]! + dy, az = OUT3[2]! + dz;
  ankleOf(-s);
  const ox = OUT3[0]!, oy = OUT3[1]!, oz = OUT3[2]!;
  footPitchS(out, -s);
  const po = FPR[0]!;
  footPitchS(out, s);
  const ps = FPR[0]!;
  out[PoseIdx.ROOT_FWD] = out[PoseIdx.ROOT_FWD]! + rx;
  out[PoseIdx.ROOT_SIDE] = out[PoseIdx.ROOT_SIDE]! + rz;
  IKT[0] = ax; IKT[1] = ay; IKT[2] = az;
  FPA[0] = ps;
  legIKS(out, s);
  setFootPitchS(out, s);
  IKT[0] = ox; IKT[1] = oy; IKT[2] = oz;
  FPA[0] = po;
  legIKS(out, -s);
  setFootPitchS(out, -s);
}

/**
 * How far (m, model) touchReach would move leg `side`'s toe at full weight toward the ball in RCH[0..2] (0 when it would
 * not reach for it). The animator caps the weight change per frame with it, so a reach never pops the foot.
 */
export function touchNeed(out: Pose, side: number): number {
  solvePoseFK(out, SK);
  solePointS(side < 0 ? Joint.ANKLE_L : Joint.ANKLE_R, 0);
  const dx = RCH[0]! - OUT3[0]!, dy = RCH[1]! - OUT3[1]!, dz = RCH[2]! - OUT3[2]!;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(d > LOCAL_TUNING.toeToBall) || d >= LOCAL_TUNING.touchGiveUp) return 0;
  const m = d - LOCAL_TUNING.toeToBall;
  const cap = LOCAL_TUNING.touchMax + LOCAL_TUNING.touchRootMax;
  return m < cap ? m : cap;
}

/** The leg (-1 left / +1 right) of pose `out` whose toe is nearer the ball in RCH[0..2]. */
export function nearerLeg(out: Pose): number {
  solvePoseFK(out, SK);
  solePointS(Joint.ANKLE_L, 0);
  const lx = RCH[0]! - OUT3[0]!, ly = RCH[1]! - OUT3[1]!, lz = RCH[2]! - OUT3[2]!;
  solePointS(Joint.ANKLE_R, 0);
  const qx = RCH[0]! - OUT3[0]!, qy = RCH[1]! - OUT3[1]!, qz = RCH[2]! - OUT3[2]!;
  return lx * lx + ly * ly + lz * lz < qx * qx + qy * qy + qz * qz ? -1 : 1;
}

/** [QF-7R] touchStepS register: in want (0..1), weight, side (-1 / +1, 0 = pick the nearer leg), max weight step per
 *  frame; out weight, side. */
export const TST = new Float64Array(4);

/**
 * [QF-7R] The animator's per-frame touch-reach planning for the ball in RCH[0..2], in one function (the per-frame form
 * of nearerLeg + touchNeed): a side of 0 becomes the leg whose toe is nearer the ball (nearerLeg); a weight below the
 * wanted one rises by at most maxStep / touchNeed per frame, capped at want. One FK solve for both. Written out rather
 * than calling nearerLeg / touchNeed: those run once per reach, so V8 never optimises them and every double they
 * compute is boxed (garbage each reach); this runs every frame of a reach and is optimised with the animator.
 */
export function touchStepS(out: Pose): void {
  const want = TST[0]!, maxStep = TST[3]!;
  let tw = TST[1]!, side = TST[2]!;
  if (side !== 0 && !(want > tw)) return;
  solvePoseFK(out, SK);
  if (side === 0) {
    solePointS(Joint.ANKLE_L, 0);
    const lx = RCH[0]! - OUT3[0]!, ly = RCH[1]! - OUT3[1]!, lz = RCH[2]! - OUT3[2]!;
    solePointS(Joint.ANKLE_R, 0);
    const qx = RCH[0]! - OUT3[0]!, qy = RCH[1]! - OUT3[1]!, qz = RCH[2]! - OUT3[2]!;
    side = lx * lx + ly * ly + lz * lz < qx * qx + qy * qy + qz * qz ? -1 : 1;
  }
  if (want > tw) {
    solePointS(side < 0 ? Joint.ANKLE_L : Joint.ANKLE_R, 0);
    const dx = RCH[0]! - OUT3[0]!, dy = RCH[1]! - OUT3[1]!, dz = RCH[2]! - OUT3[2]!;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    let need = 0;
    if (d > LOCAL_TUNING.toeToBall && d < LOCAL_TUNING.touchGiveUp) {
      const m = d - LOCAL_TUNING.toeToBall;
      const cap = LOCAL_TUNING.touchMax + LOCAL_TUNING.touchRootMax;
      need = m < cap ? m : cap;
    }
    const step = need > maxStep ? maxStep / need : 1;
    tw = Math.min(want, tw + step);
  }
  TST[1] = tw;
  TST[2] = side;
}

/** Copy helper for tests: a pose's channels into another. */
export function copyPoseInto(src: ArrayLike<number>, dst: Pose): void {
  for (let k = 0; k < POSE_SIZE; k++) dst[k] = src[k]!;
}
