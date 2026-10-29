/**
 * [SIM-07] First touch, trapping and aerial control. When a moving ball reaches a player who is receiving
 * (intended receiver, chaser, or anyone whose path it crosses and who chooses to control it), resolve the
 * first touch from ball speed and height, the ballControl attribute, pressure, and whether sprint is held:
 * clean control (takePossession), a heavy touch (ball knocked ahead with error), or a miss.
 * Runs in the contact phase after keepers, aerials, tackles and interceptions.
 *
 * WHEN receiveContacts ACTS (one ball contact at most per tick; nothing at all when ballTouchedThisTick):
 *  - Live play only: IN_PLAY, or a restart phase once the restart has been taken (same rule as GKP-02). Never with
 *    the ball owned, in a keeper's hands, in the net, or over a line this tick (ball.cross: the rules award it).
 *  - A FIRST TOUCH needs a moving ball: horizontal speed > minTrapSpeed, or airborne (not grounded and lifted off
 *    its resting height), at most T_TOUCH.trapHeight high. Slower ground balls are SIM-06 pick-ups.
 *  - Reach (height-aware, swept over this tick's ball segment so nothing slips through): ball centre at or below
 *    T_DRIBBLE.controlHeight (feet): T_TOUCH.receiveRadius; above it up to trapHeight (thigh / chest):
 *    receiveRadius * chestReachMul. The ball is taken by the candidate it reaches first along the segment (ties:
 *    lower slot).
 *  - Candidates: free (isFree: active, act NONE, not stunned), noTouchT expired, not the last kicker within
 *    selfKickTicks of his kick, and one of: the intended receiver (ball.passTarget), a team chaser (team.chaser),
 *    a human- or CPU-controlled player (p.ctrl >= 0), or a keeper (only when GKP did not claim: GKP-02 runs first and
 *    any GK action makes him busy). While a teammate's pass is in flight untouched (see "untouched pass"):
 *      - on the passer's team only the intended receiver and controlled players take it (a chaser or keeper who is
 *        not the target lets it run on to him);
 *      - outfield opponents leave a pass at or below interceptHeight to SIM-14 interceptContacts (which ran just
 *        before and decides interceptions with its own odds); higher passes they may chest / thigh down.
 *  - First-time plays: a player whose resolver already started a KICK / SHOT / HEADER / VOLLEY wind-up for the
 *    arriving ball (ReqFlag.FIRST_TIME) is busy, so he is never a candidate: the ball is left for the kick module.
 *
 * QUALITY (touchQuality, pure, 0..1): q = 1 - D * m.
 *  D = baseDifficulty + speed (hardDifficulty at T_TOUCH.hardBallSpeed, linear from softSpeed and on above it; the
 *  speed is the ball's speed relative to the player, so running onto a pass is harder and taking a through ball in
 *  stride easier) + height (0 at heightEasy .. heightDifficulty at trapHeight) + pressure (pressureDifficulty x
 *  query.pressureOn) + sprint held (sprintDifficulty when wantSprint / sprinting) + facing (facingDifficulty x
 *  (1 - cos) / 2 between his facing and the way the ball comes at him, weighted by relative speed up to
 *  facingRefSpeed). m = skillMulWorst .. skillMulBest by ballControl (1 .. 99).
 *
 * OUTCOME (four s.rng draws per first touch, always, so the stream does not depend on the outcome):
 *  - clean with probability unlerp(qHeavyLo, qCleanHi, q); otherwise a miss with probability (1 - q / qMissHi)
 *    (clamped) x how far from his body the ball's path passes (0 through T_PLAYER.bodyRadius .. 1 at the edge of his
 *    reach: a ball fired straight at him cannot slip past, it comes off him), else a heavy touch.
 *  - CLEAN: takePossession; the ball is settled ahead of him in his movement / stick direction (DIRECT stick, ARRIVE
 *    target, else his velocity, else his facing) at the dribble lead for his speed (T_DRIBBLE.touchAheadClose
 *    standing .. touchAheadJog at a jog .. touchAheadSprint at top speed: a sprint trap runs further ahead): its
 *    velocity is set so it rolls to that spot in front of where he will be when the FIRST_TOUCH window ends (rolling
 *    friction and his slowed run included), spin removed; a ball in the air drops at cushionVy. Possession is kept
 *    by ball.owner (SIM-06 leaves a FIRST_TOUCH owner's ball alone, except that opponents can still poke it away);
 *    no applyKick, so lastKick* / offside data are untouched (a reception is not a new pass).
 *  - HEAVY: applyKick with KickKind.FIRST_TOUCH (not a pass kind: no offside snapshot, no back-pass taint, clears
 *    passTarget): the ball leaves him at his velocity plus a push that would roll it 1..T_TOUCH.heavyTouchMax m
 *    (worse touches further) in his intended direction bent by the incoming ball (heavyCarry) and a deterministic
 *    angular error up to heavyAngleMax x (1 - q); a chest / thigh heavy touch pops up (heavyPopVy). Possession is
 *    not kept: noTouchT = heavyNoTouchTicks, so neither this module nor SIM-06 gives it straight back to him.
 *  - MISS: the ball runs on untouched; noTouchT = missNoTouchTicks so he does not try again as it passes.
 *  - Events: clean and heavy emit KICK (a = slot, b = KickKind.FIRST_TOUCH, c = incoming relative speed /
 *    touchPowerRef) for audio; takePossession emits POSSESSION on a change of team.
 *
 * FIRST_TOUCH ACTION (clean and heavy): beginAction(FIRST_TOUCH, firstTouchTicks (+ aerialExtraTicks for a chest /
 * thigh trap so the window lasts until the ball is down), no contact tick). While it runs he is not free (no other
 * action; the resolver re-fires a buffered press after it), sprint is cancelled and movement capped at slowFraction
 * of jog (DIRECT stick magnitude / ARRIVE tgtSpeed: idempotent caps on the intent written earlier in the tick). A
 * clean trap whose ball is lost (poked away) ends the window at once.
 *  ACTION FIELDS: actA = TouchOutcome (1 clean, 2 heavy); actPower = quality 0..1; actDirX/Z = settle / knock
 *  direction; actX/actZ = settle target point (clean) or the knock's rest point (heavy); actCurve = contact height
 *  (m: foot / thigh / chest for the animation); actB = incoming ball speed relative to him (m/s); actSlot = passer
 *  of a received pass (-1 otherwise); actKick = KickKind.FIRST_TOUCH.
 *
 * PASS_COMPLETE (a = receiver, b = passer = ball.lastKickBy): the pass-completion stat. An "untouched pass" is a
 * ball whose last kick is a pass kind (isCompletablePassKind: the foot passes of isFootPassKind plus HEADER_PASS) and that nobody
 * has touched since (lastTouch === lastKickBy, lastTouchTick === lastKickTick). It is completed, at most once per
 * tick and once per pass (the first two routes touch the ball, so it is no longer untouched; the first-time route
 * fires only on the arrival edge), when a teammate of the passer:
 *  - controls it cleanly with a first touch, or takes a heavy touch (heavyCountsAsComplete = 1: the pass reached him,
 *    as broadcast stats count it; set 0 to count clean control only);
 *  - picks it up slowly: a low untouched pass slower than pickUpMaxSpeed whose nearest SIM-06-eligible player within
 *    T_DRIBBLE.controlRadius is a free teammate. This module then takes possession for him (exactly what SIM-06 would
 *    do one stage later; SIM-06 controls the ball from the next tick) so the completion is recorded;
 *  - plays it first time: the pass first comes within firstTimeReach (and below trapHeight, headerTop for a header) of
 *    a teammate already in a first-time KICK / SHOT / VOLLEY / HEADER wind-up (edge: outside on the previous tick).
 *    No ball contact is made here; the kick module strikes it.
 *
 * Determinism / cost: plain arithmetic and Math.sqrt (the heavy-touch error rotation uses a Taylor sin / cos), s.rng
 * only; slot-order loops with strict-< tie breaks; module scratch only, numbers cross helper calls through a
 * Float64Array (no allocation per tick). Per tick O(22) with early exits; a first touch costs well under 1 us.
 *
 * IMPORT CYCLE: actions/registry reads firstTouchHandler while building its tables and this module imports
 * actions/dispatch (-> registry). The registry-facing export is the shell from firstTouchHooks.ts (no runtime
 * imports), re-exported FIRST below; the implementation is bound at the end of this file.
 */
// Re-export the handler shell FIRST (import-cycle safety with actions/registry; see firstTouchHooks.ts).
export { firstTouchHandler } from './firstTouchHooks';
import { bindFirstTouchImpl } from './firstTouchHooks';
import { BALL_RADIUS, CPU_CONTROLLER_BASE, DT, NUM_SLOTS, PLAYERS_PER_TEAM, teamFirstSlot } from '../../contracts/constants';
import { ActionKind, CrossKind, KickKind, MatchPhase, isFootPassKind, isShotKind } from '../../contracts/enums';
import { EventType, type EventSink } from '../../contracts/events';
import { MoveMode, type BallState, type SimState } from '../../contracts/state';
import { createKickLaunch } from '../../contracts/systems';
import { RESTART_PHASES } from '../../contracts/transitions';
import { T_BALL, T_DRIBBLE, T_FEEL, T_PLAYER, T_TOUCH, T_FIRST_TOUCH } from '../../contracts/tuning';
import { beginAction, isFree } from '../actions/dispatch';
import { applyKick, ballTouchedThisTick, takePossession } from '../core/kick';
import { clamp01, unlerp } from '../core/dmath';
import { pressureOn } from '../core/query';
import { rngFloat } from '../core/rng';
import { maxSpeed } from './locomotion';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_FIRST_TOUCH. */
export const LOCAL_TUNING = T_FIRST_TOUCH;


const L = T_FIRST_TOUCH;

/** FIRST_TOUCH outcome codes (p.actA during the action). */
export const TouchOutcome = { NONE: 0, CLEAN: 1, HEAVY: 2, MISS: 3 } as const;

const CTRL_H = T_DRIBBLE.controlHeight;
const CR2 = T_DRIBBLE.controlRadius * T_DRIBBLE.controlRadius;
const REST_Y = BALL_RADIUS + L.airborneLift;

// ---------------------------------------------------------------- tables and scratch (no per-tick allocation)

/** 1 for restart phases (live once the restart has been taken). Indexed by MatchPhase. */
const RESTART_PHASE = new Uint8Array(MatchPhase.POST_MATCH + 1);
for (const ph of RESTART_PHASES) RESTART_PHASE[ph] = 1;

/**
 * Numbers passed between helpers. V8 boxes a double passed to (or returned from) a call it does not inline, so the
 * contact-path helpers take and return their numbers through this typed array instead (no allocation).
 */
const F = new Float64Array(24);
/** Contact height, reach radius, entry parameter (reachParam / pickReceiver). */
const F_Y = 0, F_R = 1, F_T = 2;
/** Intended direction and clean lead (intendedDir). */
const F_UX = 3, F_UZ = 4, F_LEAD = 5;
/** Quality inputs (relative speed, height) and result (qualityF). */
const F_QW = 6, F_QH = 7, F_Q = 8;
/** missRoom result; the heavy-touch draws (distance, angle). */
const F_ROOM = 9, F_R2 = 10, F_R3 = 11;
/** Speed input of leadAtF, m/s. */
const F_SP = 12;
/** [QF-9] Clean-settle solver (settlePeak): lead along u now, his speed along u now, the window's speed cap, the window
 *  length (s), his acceleration, the wanted peak lead, the trial ball speed. */
const F_D0 = 13, F_V0 = 14, F_CAP = 15, F_TW = 16, F_ACC = 17, F_TGT = 18, F_UBT = 19;
/** [QF-9] Time until a cushioned ball lands (0 on the ground): it carries on at its speed until then, s. */
const F_TL = 20;
const LAUNCH = createKickLaunch();

function validSlot(slot: number): boolean {
  return slot >= 0 && slot < NUM_SLOTS;
}

/** Live play for ball contacts: IN_PLAY, or a restart phase once the restart has been taken (as GKP-02). */
function contactsLive(s: SimState): boolean {
  const ph = s.match.phase;
  if (ph === MatchPhase.IN_PLAY) return true;
  return RESTART_PHASE[ph] === 1 && s.match.restart.taken === 1;
}

/** A pass kind (isFootPassKind) that nobody has touched since it was kicked. */
export function isUntouchedPass(b: Readonly<BallState>): boolean {
  const k = b.lastKickBy;
  return validSlot(k) && b.lastTouch === k && b.lastTouchTick === b.lastKickTick && isCompletablePassKind(b.lastKickKind);
}

/**
 * Kick kinds a teammate can complete (PASS_COMPLETE): the foot passes plus HEADER_PASS [INT-A: a headed pass that
 * reaches a teammate is a completed pass; without it every header pass counted as a failed attempt in the soak's
 * pass-completion band]. The stats screen (modes/stats.ts) still counts only foot passes as attempts and completions.
 */
export function isCompletablePassKind(k: KickKind): boolean {
  return isFootPassKind(k) || k === KickKind.HEADER_PASS;
}

// ---------------------------------------------------------------- quality

/**
 * 0..1 quality of a first touch for slot given incoming ball speed (m/s) and height (m). Pure.
 * ballSpeed is the ball's speed relative to the player (receiveContacts passes the 3-D relative speed); the facing
 * term reads the ball's current velocity relative to him; pressure, sprint and ballControl come from state.
 */
export function touchQuality(s: SimState, slot: number, ballSpeed: number, height: number): number {
  if (!validSlot(slot)) return 0;
  F[F_QW] = ballSpeed;
  F[F_QH] = height;
  qualityF(s, slot);
  return F[F_Q]!;
}

/** touchQuality on F[F_QW] (relative speed) and F[F_QH] (height); result in F[F_Q]. */
function qualityF(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  const spd = F[F_QW]! > 0 ? F[F_QW]! : 0;
  const h = F[F_QH]! > 0 ? F[F_QH]! : 0;
  let d = L.baseDifficulty;
  if (spd > L.softSpeed) d += L.hardDifficulty * (spd - L.softSpeed) / (T_TOUCH.hardBallSpeed - L.softSpeed);
  d += L.heightDifficulty * unlerp(L.heightEasy, T_TOUCH.trapHeight, h);
  d += L.pressureDifficulty * pressureOn(s, slot);
  if (p.wantSprint === 1 || p.sprinting === 1) d += L.sprintDifficulty;
  const b = s.ball;
  const wx = b.vx - p.vx, wz = b.vz - p.vz;
  const w = Math.sqrt(wx * wx + wz * wz);
  const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
  if (w > 1e-6 && fl > 1e-9) {
    // cos = 1 when the ball comes straight at his front, -1 when it comes from behind him.
    const cos = -(p.fx * wx + p.fz * wz) / (fl * w);
    d += L.facingDifficulty * (1 - cos) * 0.5 * clamp01(w / L.facingRefSpeed);
  }
  const c = clamp01((s.attrs[slot]!.ballControl - 1) / 98);
  const m = L.skillMulWorst + (L.skillMulBest - L.skillMulWorst) * c;
  const q = 1 - d * m;
  F[F_Q] = q > 0 ? (q < 1 ? q : 1) : 0;
}

// ---------------------------------------------------------------- reach

/**
 * Can slot reach the ball along this tick's segment (b.p* -> b.*)? Returns 1 and the segment parameter where it first
 * comes within his height-aware reach (F[F_T], 0..1), the ball height there (F[F_Y]) and the reach radius used
 * (F[F_R]); 0 if it never does. Feet (centre <= T_DRIBBLE.controlHeight): receiveRadius; thigh / chest (up to
 * trapHeight): receiveRadius * chestReachMul. Tested at the closest approach, then at the end of the tick (a dropping
 * ball can come into the chest band late).
 */
function reachParam(s: SimState, slot: number): number {
  const b = s.ball;
  const p = s.players[slot]!;
  const ox = b.px - p.x, oz = b.pz - p.z;
  const dx = b.x - b.px, dz = b.z - b.pz;
  const l2 = dx * dx + dz * dz;
  let tc = l2 > 1e-12 ? -(ox * dx + oz * dz) / l2 : 1;
  if (tc < 0) tc = 0; else if (tc > 1) tc = 1;
  // [FEEL-1] A human-controlled player steering (stick not idle) stretches for it: the receiving magnet's reach bonus.
  const c = p.ctrl;
  const bonus = c >= 0 && c < CPU_CONTROLLER_BASE && s.ctrl[c]!.stickIdleT === 0 ? T_FEEL.magnetReachBonus : 0;
  for (let k = 0; k < 2; k++) {
    const t = k === 0 ? tc : 1;
    if (k === 1 && tc === 1) break;
    const y = b.py + (b.y - b.py) * t;
    let r = y <= CTRL_H ? T_TOUCH.receiveRadius : y <= T_TOUCH.trapHeight ? T_TOUCH.receiveRadius * L.chestReachMul : 0;
    if (r <= 0) continue;
    r += bonus;
    const cx = ox + dx * t, cz = oz + dz * t;
    if (cx * cx + cz * cz > r * r) continue;
    let te = 0;
    const c0 = ox * ox + oz * oz - r * r;
    if (c0 > 0 && l2 > 1e-12) {
      const bh = ox * dx + oz * dz;
      const disc = bh * bh - l2 * c0;
      te = disc > 0 ? (-bh - Math.sqrt(disc)) / l2 : t;
      if (te < 0) te = 0; else if (te > t) te = t;
    }
    F[F_T] = te;
    F[F_Y] = y;
    F[F_R] = r;
    return 1;
  }
  return 0;
}

/**
 * The candidate the moving ball reaches first this tick (see header), or -1. pass = 1 while a pass is in flight
 * untouched. F[F_Y] / F[F_R] = ball height and reach radius at his contact point.
 */
function pickReceiver(s: SimState, pass: number): number {
  const b = s.ball;
  const selfKick = s.tick - b.lastKickTick < L.selfKickTicks ? b.lastKickBy : -1;
  const passTeam = pass === 1 ? b.lastKickTeam : -1;
  // [QF-9] A fresh shot's outfield opponents block it in SIM-14 interceptContacts (body in its path, or a stretched
  // leg's roll), which ran just before: they never "receive" it here (the controlled presser / chaser used to take every
  // shot passing within receiveRadius at any speed, while any other defender in its path was a ghost).
  // (Fresh shot as SIM-14 isFreshShot, inline: this module must not import defend/tackle.)
  const fresh = validSlot(b.shotBy) && b.shotBy === b.lastKickBy && isShotKind(b.lastKickKind) &&
    b.lastTouch === b.lastKickBy && b.lastTouchTick === b.lastKickTick;
  const shotTeam = pass === 0 && fresh ? b.lastKickTeam : -1;
  const target = validSlot(b.passTarget) ? b.passTarget : -1;
  let best = -1;
  let bestT = 2;
  let bestY = 0;
  let bestR = 0;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (i === selfKick || !isFree(p) || p.noTouchT > 0) continue;
    const keeper = p.isKeeper === 1;
    const ctrl = p.ctrl >= 0;
    const chaser = s.teams[p.team]!.chaser === i;
    if (!(i === target || ctrl || keeper || chaser)) continue;
    if (pass === 1 && p.team === passTeam && target >= 0 && i !== target && !ctrl) continue;
    if (reachParam(s, i) === 0 || !(F[F_T]! < bestT)) continue;
    // Outfield opponents of an untouched low pass: SIM-14 interceptions. Of a fresh shot: SIM-14 blocks.
    if (pass === 1 && p.team !== passTeam && !keeper && F[F_Y]! <= L.interceptHeight) continue;
    if (shotTeam >= 0 && p.team !== shotTeam && !keeper) continue;
    best = i;
    bestT = F[F_T]!;
    bestY = F[F_Y]!;
    bestR = F[F_R]!;
  }
  F[F_Y] = bestY;
  F[F_R] = bestR;
  return best;
}

// ---------------------------------------------------------------- touches

/** Settle / knock direction (F_UX, F_UZ): stick, arrive target, velocity, facing; and the clean lead F_LEAD. */
function intendedDir(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  let ux = 0, uz = 0, ok = 0;
  if (p.moveMode === MoveMode.DIRECT) {
    const m = Math.sqrt(p.ix * p.ix + p.iz * p.iz);
    if (m > L.stickDead) { ux = p.ix / m; uz = p.iz / m; ok = 1; }
  } else if (p.moveMode === MoveMode.ARRIVE) {
    const dx = p.tgtX - p.x, dz = p.tgtZ - p.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > T_PLAYER.arriveStop) { ux = dx / d; uz = dz / d; ok = 1; }
  }
  if (ok === 0 || !(ux * ux + uz * uz > 0.5)) {
    const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if (sp > L.standSpeed) { ux = p.vx / sp; uz = p.vz / sp; } else {
      const fl = Math.sqrt(p.fx * p.fx + p.fz * p.fz);
      if (fl > 1e-9) { ux = p.fx / fl; uz = p.fz / fl; } else { ux = s.teams[p.team]!.dir; uz = 0; }
    }
  }
  F[F_UX] = ux;
  F[F_UZ] = uz;
  leadF(s, slot);
}

/**
 * How far ahead of his feet a clean trap settles the ball, m, from slot's current speed (the dribble leads):
 * T_DRIBBLE.touchAheadClose standing .. touchAheadJog at jog speed .. touchAheadSprint at top speed. Pure.
 */
export function trapLead(s: SimState, slot: number): number {
  leadF(s, slot);
  return F[F_LEAD]!;
}

/** trapLead into F[F_LEAD]. */
function leadF(s: SimState, slot: number): void {
  const p = s.players[slot]!;
  F[F_SP] = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  leadAtF(s, slot);
}

/** The trap lead for speed F[F_SP] (m/s) into F[F_LEAD]. */
function leadAtF(s: SimState, slot: number): void {
  const sp = F[F_SP]!;
  // [FEEL-1] A human-controlled receiver settles it at his close-control leads (T_FEEL.human*).
  const pc = s.players[slot]!.ctrl;
  const hc = pc >= 0 && pc < CPU_CONTROLLER_BASE;
  const close = T_DRIBBLE.touchAheadClose, jogLead = hc ? T_FEEL.humanTouchAheadJog : T_DRIBBLE.touchAheadJog;
  const sprintLead = hc ? T_FEEL.humanTouchAheadSprint : T_DRIBBLE.touchAheadSprint;
  const top = maxSpeed(s, slot, true);
  const jog = top * T_PLAYER.jogFraction;
  let lead: number;
  if (!(sp > L.standSpeed)) lead = close;
  else if (sp <= jog || jog <= L.standSpeed) lead = close + (jogLead - close) * clamp01((sp - L.standSpeed) / (jog - L.standSpeed));
  else lead = jogLead + (sprintLead - jogLead) * (top > jog + 1e-9 ? clamp01((sp - jog) / (top - jog)) : 1);
  F[F_LEAD] = lead;
}

/**
 * [QF-9] Does the clean-settle ball's lead over the receiver along u peak at F[F_TGT] or more, for the trial ball
 * speed F[F_UBT]? 1-D model along u: the ball rolls (SIM-02: rollDecel + rollDamping * v; a cushioned ball first carries
 * on in the air for F[F_TL] s); he runs from F[F_V0] toward
 * the FIRST_TOUCH speed cap F[F_CAP] (braking at T_PLAYER.decel, accelerating at F[F_ACC]) for the window F[F_TW] s,
 * then holds the speed he has (never backward). The lead counts only once the ball is at least as fast as he is (a
 * soft touch that first drops back counts where it comes to rest ahead of him), as in SIM-06's push solver. Increasing
 * in the ball speed (bisection). Inputs through F (V8 would box double arguments).
 */
function settlePeak(): number {
  const h = L.settleSolveStep;
  const n = Math.ceil(L.settleSolveHorizon / h);
  const ra = T_BALL.rollDecel, rc = T_BALL.rollDamping, rest = T_BALL.restSpeed, dec = T_PLAYER.decel;
  const d0 = F[F_D0]!, cap = F[F_CAP]!, tw = F[F_TW]!, acc = F[F_ACC]!, tgt = F[F_TGT]!, tl = F[F_TL]!;
  let vb = F[F_UBT]!, vp = F[F_V0]!, lead = d0;
  let rising = vb >= vp ? 1 : 0;
  let best = rising === 1 ? d0 : -1e9;
  if (best >= tgt) return 1;
  let hold = -1;
  for (let k = 1; k <= n; k++) {
    let nvb = vb;
    if (k * h > tl) {
      nvb = vb - (ra + rc * vb) * h;
      if (nvb < rest) nvb = 0;
    }
    let nvp = vp;
    if (k * h <= tw) {
      if (vp > cap) { nvp = vp - dec * h; if (nvp < cap) nvp = cap; } else if (vp < cap) {
        nvp = vp + (vp < 0 ? dec : acc) * h;
        if (nvp > cap) nvp = cap;
      }
    } else {
      if (hold < 0) hold = vp > 0 ? vp : 0;
      if (vp < hold) { nvp = vp + dec * h; if (nvp > hold) nvp = hold; }
    }
    lead += 0.5 * (vb + nvb) * h - 0.5 * (vp + nvp) * h;
    vb = nvb;
    vp = nvp;
    if (rising === 0 && vb >= vp) rising = 1;
    if (rising === 1 && lead > best) best = lead;
    if (best >= tgt) return 1;
    // Past the window, the ball no faster than he runs and he no longer speeding up: the lead only falls from here.
    if (hold >= 0 && vb <= vp && vp >= hold) break;
  }
  return 0;
}

/**
 * Clean control (QF-9 rewrite of the settle): the ball is settled in his intended direction u so that it stays in his
 * reach. Along u its speed is solved (settlePeak) so that its lead over him peaks at the trap lead for the speed he
 * will have when the FIRST_TOUCH window of dur ticks ends (the window caps his run at slowFraction of jog: a sprinting
 * receiver brakes, so "plan with the capped speed"); sideways it moves with him and closes its offset from his line
 * (at most settleLatMax, and slowly enough to roll to rest on the line rather than across it). Was: the ball was given
 * whatever speed reached the lead spot ahead of his capped position exactly at the window's end; for a sprinting
 * receiver that fired it at 14 m/s while he braked to 7 m/s, so the "controlled" ball ran 2.6 m clear within 15 ticks
 * and he lost it (QF-2 CR: qf-2-cr-first-touch-sprint). F[F_UX], F[F_UZ] = u (intendedDir). p.actX / actZ = the lead
 * spot ahead of where he will be when the window ends (animation).
 */
function settleBall(s: SimState, slot: number, dur: number): void {
  const p = s.players[slot]!;
  const b = s.ball;
  const ux = F[F_UX]!, uz = F[F_UZ]!;
  const T = dur * DT;
  // His run over the window, slowed to the FIRST_TOUCH cap (braking at T_PLAYER.decel).
  const sp = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
  const cap = maxSpeed(s, slot, true) * T_PLAYER.jogFraction * L.slowFraction;
  let avg = sp, vEnd = sp;
  if (sp > cap) {
    const tc = (sp - cap) / T_PLAYER.decel;
    avg = tc >= T ? sp - 0.5 * T_PLAYER.decel * T : ((sp + cap) * 0.5 * tc + cap * (T - tc)) / T;
    vEnd = tc >= T ? sp - T_PLAYER.decel * T : cap;
  }
  F[F_SP] = vEnd;
  leadAtF(s, slot);
  const lead = F[F_LEAD]!;
  const k = sp > 1e-6 ? (avg / sp) * T : 0;
  p.actX = p.x + p.vx * k + ux * lead;
  p.actZ = p.z + p.vz * k + uz * lead;
  // Along u: solve the ball speed whose lead peaks at `lead`.
  const rx = b.x - p.x, rz = b.z - p.z;
  const v0 = p.vx * ux + p.vz * uz;
  F[F_D0] = rx * ux + rz * uz;
  F[F_V0] = v0;
  F[F_CAP] = cap;
  F[F_TW] = T;
  const at = s.attrs[slot]!;
  F[F_ACC] = (at.accel > 0 ? at.accel : T_PLAYER.accelMin);
  F[F_TGT] = lead;
  // A ball cushioned from the air (cushionVy) carries on until it lands.
  let tLand = 0;
  if (b.y > REST_Y) {
    const vy = L.cushionVy, g = T_BALL.gravity, hgt = b.y - BALL_RADIUS;
    tLand = (vy + Math.sqrt(vy * vy + 2 * g * hgt)) / g;
  }
  F[F_TL] = tLand;
  let lo = 0;
  let hi = (v0 > cap ? v0 : cap) + L.settleSolveHiExtra;
  if (hi > L.settleMaxSpeed) hi = L.settleMaxSpeed;
  F[F_UBT] = lo;
  if (settlePeak() === 1) hi = lo;
  else {
    F[F_UBT] = hi;
    if (settlePeak() === 1) {
      for (let i = 0; i < L.settleSolveIters; i++) {
        const mid = 0.5 * (lo + hi);
        F[F_UBT] = mid;
        if (settlePeak() === 1) hi = mid; else lo = mid;
      }
    }
  }
  // The speed that brings the ball to the lead spot ahead of his capped run exactly when the window ends (rolling, or
  // carried in the air until it lands; a ball beyond the spot is drawn back to it), capped by the solved speed so its
  // lead never runs on past the trap lead.
  const du = (p.vx * k) * ux + (p.vz * k) * uz + lead - F[F_D0]!;
  const adu = du < 0 ? -du : du;
  let vt = 0;
  if (adu > 1e-6) {
    if (tLand >= T) vt = adu / T;
    else {
      const a = T_BALL.rollDecel, c = T_BALL.rollDamping;
      vt = (adu + 0.5 * a * T * T) / (T * (1 - 0.5 * c * T));
      if (vt * (1 - c * T) < a * T) vt = Math.sqrt(2 * a * adu);
    }
    if (du < 0) vt = -vt;
  }
  const vu = vt < hi ? vt : hi;
  // Sideways (n = (-uz, ux)): his own sideways speed at the window's end plus a correction that brings the ball onto
  // his line by the window's end (at least settleLatMinTime, at most settleLatMax); a ball that will move mostly
  // sideways is instead given the speed that rolls it to rest on his line (it would otherwise roll on across it).
  const e0 = rz * ux - rx * uz;
  const pn = sp > 1e-6 ? (-p.vx * uz + p.vz * ux) * (vEnd / sp) : 0;
  const ae = e0 < 0 ? -e0 : e0;
  const tl = T > L.settleLatMinTime ? T : L.settleLatMinTime;
  let corr = ae / tl;
  if (corr > L.settleLatMax) corr = L.settleLatMax;
  const avu = vu < 0 ? -vu : vu;
  if (avu < corr) {
    const stop = Math.sqrt(2 * T_BALL.rollDecel * ae);
    if (corr > stop) corr = stop;
  }
  const vn = pn + (e0 > 0 ? -corr : corr);
  let vx = ux * vu - uz * vn;
  let vz = uz * vu + ux * vn;
  const v = Math.sqrt(vx * vx + vz * vz);
  if (v > L.settleMaxSpeed) { vx *= L.settleMaxSpeed / v; vz *= L.settleMaxSpeed / v; }
  b.vx = vx;
  b.vz = vz;
  b.sx = 0; b.sy = 0; b.sz = 0;
  if (b.y > REST_Y) { b.vy = L.cushionVy; b.grounded = 0; } else if (b.vy > 0) b.vy = 0;
}

/** Resolve slot's first touch of the moving ball (contact height F[F_Y], reach radius F[F_R]). */
function firstTouch(s: SimState, slot: number, pass: number, ev: EventSink): void {
  const b = s.ball;
  const p = s.players[slot]!;
  const wx = b.vx - p.vx, wy = b.vy, wz = b.vz - p.vz;
  F[F_QW] = Math.sqrt(wx * wx + wy * wy + wz * wz);
  F[F_QH] = F[F_Y]!;
  qualityF(s, slot);
  const q = F[F_Q]!;
  const r0 = rngFloat(s.rng);
  const r1 = rngFloat(s.rng);
  F[F_R2] = rngFloat(s.rng);
  F[F_R3] = rngFloat(s.rng);
  const passer = b.lastKickBy;
  // The passer's slot when this completes a teammate's pass, else -1.
  const mate = pass === 1 && p.team === b.lastKickTeam && slot !== passer ? passer : -1;
  if (r0 < unlerp(L.qHeavyLo, L.qCleanHi, q)) { cleanTouch(s, slot, mate, ev); return; }
  missRoom(s, slot);
  if (r1 < (1 - q / L.qMissHi) * F[F_ROOM]!) {
    // ---- miss: the ball runs on
    if (p.noTouchT < L.missNoTouchTicks) p.noTouchT = L.missNoTouchTicks;
    return;
  }
  heavyTouch(s, slot, mate, ev);
}

/** Clean control (quality F[F_Q], contact height F[F_QH], relative speed F[F_QW]); mate = passer or -1. */
function cleanTouch(s: SimState, slot: number, mate: number, ev: EventSink): void {
  const b = s.ball;
  const p = s.players[slot]!;
  intendedDir(s, slot);
  const dur = T_TOUCH.firstTouchTicks + (F[F_QH]! > CTRL_H ? L.aerialExtraTicks : 0);
  takePossession(s, slot, ev);
  beginAction(p, ActionKind.FIRST_TOUCH, dur, -1);
  settleBall(s, slot, dur);
  p.actA = TouchOutcome.CLEAN;
  p.actSlot = mate;
  p.actKick = KickKind.FIRST_TOUCH;
  p.actDirX = F[F_UX]!;
  p.actDirZ = F[F_UZ]!;
  p.actPower = F[F_Q]!;
  p.actCurve = F[F_QH]!;
  p.actB = F[F_QW]!;
  ev.emit(EventType.KICK, slot, KickKind.FIRST_TOUCH, clamp01(F[F_QW]! / L.touchPowerRef), 0, b.x, b.y, b.z);
  if (mate >= 0) ev.emit(EventType.PASS_COMPLETE, slot, mate);
}

/** Heavy touch (quality F[F_Q], contact height F[F_QH], relative speed F[F_QW], draws F[F_R2], F[F_R3]). */
function heavyTouch(s: SimState, slot: number, mate: number, ev: EventSink): void {
  const b = s.ball;
  const p = s.players[slot]!;
  const q = F[F_Q]!;
  intendedDir(s, slot);
  let hx = F[F_UX]!, hz = F[F_UZ]!;
  const wx = b.vx - p.vx, wz = b.vz - p.vz;
  const wh = Math.sqrt(wx * wx + wz * wz);
  if (wh > 1e-6) {
    let carry = L.heavyCarry * wh / T_TOUCH.hardBallSpeed;
    if (carry > L.heavyCarryMax) carry = L.heavyCarryMax;
    hx += (wx / wh) * carry;
    hz += (wz / wh) * carry;
  }
  const hl = Math.sqrt(hx * hx + hz * hz);
  if (hl > 1e-6) { hx /= hl; hz /= hl; } else { hx = F[F_UX]!; hz = F[F_UZ]!; }
  // Rotate by the error angle (|th| <= heavyAngleMax): Taylor sin / cos, deterministic plain arithmetic
  // (|error| < 1e-6 at 0.6 rad).
  const th = L.heavyAngleMax * (1 - q) * (2 * F[F_R3]! - 1);
  const t2 = th * th;
  const ca = 1 - t2 / 2 * (1 - t2 / 12 * (1 - t2 / 30 * (1 - t2 / 56)));
  const sa = th * (1 - t2 / 6 * (1 - t2 / 20 * (1 - t2 / 42 * (1 - t2 / 72))));
  const dirX = hx * ca - hz * sa;
  const dirZ = hx * sa + hz * ca;
  const bad = clamp01(1 - q / L.qCleanHi);
  const dist = 1 + (T_TOUCH.heavyTouchMax - 1) * bad * (L.heavyTouchRandMin + (1 - L.heavyTouchRandMin) * F[F_R2]!);
  const vk = Math.sqrt(2 * T_BALL.rollDecel * dist);
  LAUNCH.vx = p.vx + dirX * vk;
  LAUNCH.vy = F[F_QH]! > CTRL_H ? L.heavyPopVy : 0;
  LAUNCH.vz = p.vz + dirZ * vk;
  LAUNCH.sx = 0; LAUNCH.sy = 0; LAUNCH.sz = 0;
  LAUNCH.kind = KickKind.FIRST_TOUCH;
  LAUNCH.target = -1;
  LAUNCH.tx = p.x + dirX * dist;
  LAUNCH.tz = p.z + dirZ * dist;
  LAUNCH.onTarget = 0;
  applyKick(s, slot, LAUNCH, clamp01(F[F_QW]! / L.touchPowerRef), ev);
  beginAction(p, ActionKind.FIRST_TOUCH, T_TOUCH.firstTouchTicks, -1);
  p.actA = TouchOutcome.HEAVY;
  p.actSlot = mate;
  p.actKick = KickKind.FIRST_TOUCH;
  p.actDirX = dirX;
  p.actDirZ = dirZ;
  p.actPower = q;
  p.actCurve = F[F_QH]!;
  p.actB = F[F_QW]!;
  p.actX = LAUNCH.tx;
  p.actZ = LAUNCH.tz;
  if (p.noTouchT < L.heavyNoTouchTicks) p.noTouchT = L.heavyNoTouchTicks;
  if (mate >= 0 && L.heavyCountsAsComplete === 1) ev.emit(EventType.PASS_COMPLETE, slot, mate);
}

/**
 * F[F_ROOM] = 0..1: how far from slot's body the ball's horizontal path (relative to him) passes: 0 when it comes
 * through his body circle (it cannot slip past him), 1 at the edge of his reach F[F_R].
 */
function missRoom(s: SimState, slot: number): void {
  const b = s.ball;
  const p = s.players[slot]!;
  const ox = b.x - p.x, oz = b.z - p.z;
  const wx = b.vx - p.vx, wz = b.vz - p.vz;
  const w = Math.sqrt(wx * wx + wz * wz);
  let d = Math.sqrt(ox * ox + oz * oz);
  // Still coming at him: the closest approach of its line; already going away: where it is now.
  if (w > 1e-6 && ox * wx + oz * wz < 0) {
    const c = (ox * wz - oz * wx) / w;
    d = c < 0 ? -c : c;
  }
  F[F_ROOM] = unlerp(T_PLAYER.bodyRadius, F[F_R]!, d);
}

// ---------------------------------------------------------------- pass completion without a first touch

/** First-time play: the untouched pass has just come within reach of a teammate already winding up. 1 = emitted. */
function firstTimeCompletion(s: SimState, ev: EventSink): number {
  const b = s.ball;
  const passer = b.lastKickBy;
  const r2 = L.firstTimeReach * L.firstTimeReach;
  const first = teamFirstSlot(b.lastKickTeam === 1 ? 1 : 0);
  for (let i = first; i < first + PLAYERS_PER_TEAM; i++) {
    if (i === passer) continue;
    const p = s.players[i]!;
    const a = p.act;
    if (p.active !== 1 || p.actDone !== 0) continue;
    if (a !== ActionKind.KICK && a !== ActionKind.SHOT && a !== ActionKind.VOLLEY && a !== ActionKind.HEADER) continue;
    const top = a === ActionKind.HEADER ? L.headerTop : T_TOUCH.trapHeight;
    if (!(b.y <= top)) continue;
    const dx = b.x - p.x, dz = b.z - p.z;
    if (dx * dx + dz * dz > r2) continue;
    // Edge: was it out of reach (or too high) on the previous tick (him one tick back along his velocity)?
    const qx = b.px - (p.x - p.vx * DT), qz = b.pz - (p.z - p.vz * DT);
    if (qx * qx + qz * qz <= r2 && b.py <= top) continue;
    ev.emit(EventType.PASS_COMPLETE, i, passer);
    return 1;
  }
  return 0;
}

/**
 * Slow untouched pass: the player SIM-06 would give it to (nearest eligible within controlRadius, ties lower slot,
 * not the passer within selfKickTicks) is a free teammate of the passer -> take possession for him + PASS_COMPLETE.
 */
function slowPassPickUp(s: SimState, ev: EventSink): void {
  const b = s.ball;
  if (!(b.y <= CTRL_H)) return;
  if (!(b.vx * b.vx + b.vz * b.vz < L.pickUpMaxSpeed * L.pickUpMaxSpeed)) return;
  const passer = b.lastKickBy;
  const selfKick = s.tick - b.lastKickTick < L.selfKickTicks ? passer : -1;
  let best = -1;
  let bestD2 = CR2;
  for (let j = 0; j < NUM_SLOTS; j++) {
    const q = s.players[j]!;
    if (j === selfKick || q.active !== 1 || q.stunT > 0 || q.noTouchT > 0) continue;
    const a = q.act;
    const eligible = a === ActionKind.NONE || a === ActionKind.SHIELD || a === ActionKind.FIRST_TOUCH ||
      ((a === ActionKind.KICK || a === ActionKind.SHOT) && q.actDone === 0);
    if (!eligible) continue;
    const dx = b.x - q.x, dz = b.z - q.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > bestD2 || (d2 === bestD2 && best >= 0)) continue;
    best = j;
    bestD2 = d2;
  }
  if (best < 0 || best === passer) return;
  const p = s.players[best]!;
  if (p.team !== b.lastKickTeam) return; // an opponent: SIM-06 gives it to him
  const a = p.act;
  // A first-time wind-up: SIM-06 holds the ball on his kicking spot (completion counted as it arrived).
  if (a !== ActionKind.NONE && a !== ActionKind.SHIELD && a !== ActionKind.FIRST_TOUCH) return;
  takePossession(s, best, ev);
  ev.emit(EventType.PASS_COMPLETE, best, passer);
}

// ---------------------------------------------------------------- contact stage

export function receiveContacts(s: SimState, ev: EventSink): void {
  if (!contactsLive(s)) return;
  const b = s.ball;
  if (b.owner >= 0 || b.heldBy >= 0 || b.inNet !== 0 || b.cross !== CrossKind.NONE) return;
  if (ballTouchedThisTick(s)) return;
  let pass = isUntouchedPass(b) ? 1 : 0;
  // A first-time reception is completed here (event only) and the pass is then no longer counted this tick.
  if (pass === 1 && firstTimeCompletion(s, ev) === 1) pass = 2;
  if (!(b.y <= T_TOUCH.trapHeight)) return;
  const airborne = b.grounded === 0 && b.y > REST_Y;
  if (airborne || b.vx * b.vx + b.vz * b.vz > L.minTrapSpeed * L.minTrapSpeed) {
    const slot = pickReceiver(s, pass === 0 ? 0 : 1);
    if (slot >= 0) {
      firstTouch(s, slot, pass === 1 ? 1 : 0, ev);
      return;
    }
  }
  if (pass === 1) slowPassPickUp(s, ev);
}

// ---------------------------------------------------------------- FIRST_TOUCH action

function ftUpdate(s: SimState, slot: number, _ev: EventSink): void {
  const p = s.players[slot]!;
  // A clean trap whose ball has been poked away: free him at once (the dispatcher ends the action this tick).
  if (p.actA === TouchOutcome.CLEAN && s.ball.owner !== slot) { p.actDur = p.actT; return; }
  p.wantSprint = 0;
  if (p.moveMode === MoveMode.DIRECT) {
    const m = Math.sqrt(p.ix * p.ix + p.iz * p.iz);
    if (m > L.slowFraction) { const k = L.slowFraction / m; p.ix *= k; p.iz *= k; }
  } else if (p.moveMode === MoveMode.ARRIVE) {
    const cap = maxSpeed(s, slot, false) * L.slowFraction;
    if (!(p.tgtSpeed <= cap)) p.tgtSpeed = cap;
  }
}

function ftEnd(_s: SimState, _slot: number, _interrupted: number): void {
  // Nothing to undo: the window only capped the intent; clearAction resets the action fields.
}

bindFirstTouchImpl({ update: ftUpdate, end: ftEnd });
