/**
 * [TAI-06] Team phase and transitions: updateTeamPhase sets team.phase/phaseT (build-up, attack, defend,
 * transition attack/defend, set piece) from possession and ball position, and team.possT/lostT;
 * assignTransition drives counter-attack runs after winning the ball and RECOVER runs after losing it.
 *
 * Possession (who "has the ball" for the team phase; derived each tick from SimState, no module memory):
 *  - Restart phases: the team taking the restart (match.restart.team).
 *  - Ball owned (dribbling, keeper holding): the owner's team.
 *  - Ball loose after a deliberate kick and untouched since (pass, through ball, cross, clearance, shot, keeper
 *    throw/kick, dribble/first touch): the kicking team keeps it while the ball travels, so a pass in flight never
 *    changes possession and a clearance hands it over at once.
 *  - Ball loose after a deflection, tackle poke, parry, punch or tip: unchanged (sticky) until someone takes it, so a
 *    50/50 never flips the phase back and forth.
 *  - Otherwise unchanged; with no history at all, the team that touched the ball last (or nobody: -1).
 * Clocks (state): team.possT = ticks since the team last gained possession, team.lostT = ticks since it last lost it
 * (both count up every tick, capped at CLOCK_MAX). The team is in possession iff possT < lostT; equal clocks mean
 * "unknown" (fresh state) and the first known possession is adopted without a transition. A gain sets possT = 0, a
 * loss lostT = 0 (also during stoppages, so the clocks stay honest).
 *
 * Phase (updateTeamPhase, every tick, both teams, before every other AI module):
 *  - Any match phase but IN_PLAY -> SET_PIECE (restarts, kick-offs, cut-scenes, shoot-out).
 *  - IN_PLAY, in possession: on the tick the ball is won in open play -> TRANSITION_ATTACK when there is space ahead
 *    (counterMargin >= 0), kept for the style's window (T_AI.transitionTicks x windowScale) while the space lasts
 *    (margin >= -stayTolerance); otherwise BUILD_UP with the ball in the own third (u < -17.5 m), ATTACK further up,
 *    with a +-thirdHysteresis band so the phase never flickers on the line.
 *  - IN_PLAY, not in possession: on the tick the ball is lost in open play -> TRANSITION_DEFEND for
 *    T_AI.transitionTicks; otherwise DEFEND. A possession change during a stoppage never starts a transition (both
 *    sides had time to reorganise).
 *  - Space ahead (counterMargin): our outfield attackers beyond (line - runnerReach) + the style's counterExtra minus
 *    the opponents' outfield rest defence beyond line = max(ball u + breakAhead, breakMinU).
 *  - ATTACK_BUILD (crowd): while in possession with the ball in the final third, emitted when the ball enters it,
 *    when the ball is won there, and every attackBuildInterval ticks; c = intensity 0..1 (depth and centrality).
 *
 * Jobs (assignTransition, IN_PLAY only, after chaser/defence/press, before support/runs):
 *  - TRANSITION_ATTACK: after the style's breakDelay, the best runners by role counter weight (data/tactics runs.counter
 *    x phase/focus run scales, position factor for players behind the ball) break at sprint: the most advanced
 *    inBehindRunners get RUN_IN_BEHIND targets runAhead m beyond the ball (or beyond themselves when already ahead of
 *    it) in spread lanes (ordered by current lateral position, so paths do not cross), held onside (offside on) and
 *    short of the goal line; the next supportRunners get SUPPORT targets supportAhead m ahead of the ball (never behind
 *    their own depth), supportWide m to their side of it. The carrier and the intended receiver never run. Counter
 *    style breaks at once with more runners, deeper, from a lower space threshold.
 *  - TRANSITION_DEFEND: every job-driven outfield player whose recover duty (duties.recover x phase/focus/style duty
 *    scales) reaches recoverDutyMin sprints to a goal-side point: depth min(home, ball u - recoverDepth) (outside the
 *    own goal area), lateral on the ball-goal line blended toward his home lane by lateralKeep. RECOVER is given to a
 *    player caught upfield (level with or ahead of the ball); to a goal-side player whose home is deeper until he is
 *    recoverDepth goal-side (the shape then takes him on to the same home: no turn-around); and to a player whose home
 *    is ahead of the goal-side point while he is not deeper than it (he holds there). Each case keeps one target on
 *    both sides of its boundary, so there is no RECOVER/HOLD flip-flop. A goal-side player already marking, tracking
 *    or covering is left alone. Strikers (low recover duty) stay up as outlets.
 * Everything is computed in the team frame (u = dir * x toward the attacked goal, v = dir * z) and mirrored back.
 * Determinism: slot-order loops, plain arithmetic (no transcendental Math), allocation-free per tick (module scratch is
 * rewritten before every use; nothing persists outside SimState).
 */
import { GOAL_AREA_DEPTH, HALF_LENGTH, HALF_WIDTH, NUM_SLOTS } from '../contracts/constants';
import { AiJob, KickKind, MatchPhase, TeamPhase } from '../contracts/enums';
import { EventType, type EventSink } from '../contracts/events';
import type { SimState, TeamState } from '../contracts/state';
import { RESTART_PHASES } from '../contracts/transitions';
import { T_AI, T_TRANSITION } from '../contracts/tuning';
import { focusModifier, phaseOffset, rolePreset, slotRole, tacticFlags } from '../data/tactics';
import { otherTeam, secondLastDefenderX, teamEnd, teamStart } from '../sim/core/query';
import { effectiveFocus } from './cpu/levels';
import { assignJob, isJobDriven } from './jobs';

/** [TUN-1] Old name kept for importers outside the sim / AI (tests, input): the block is contracts/tuning.ts T_TRANSITION. */
export const LOCAL_TUNING = T_TRANSITION;


const LT = T_TRANSITION;

/** Upper bound of the phase and possession clocks (structural; ~207 days of play). */
export const CLOCK_MAX = 1 << 30;

const OWN_THIRD_U = -HALF_LENGTH / 3;
const FINAL_THIRD_U = HALF_LENGTH / 3;
const RECOVER_MIN_U = -HALF_LENGTH + GOAL_AREA_DEPTH + LT.goalAreaMargin;

// ---------------------------------------------------------------- tables (built once at load)

const N_PHASES = MatchPhase.POST_MATCH + 1;
/** 1 for restart phases (possession = the restart team). */
const IS_RESTART = new Uint8Array(N_PHASES);
for (const ph of RESTART_PHASES) IS_RESTART[ph] = 1;

const N_KICKS = KickKind.SHOT_TRIVELA + 1;
/** 1 = a deliberate kick: the kicking team keeps possession while the ball travels. 0 = a contact that does not
 *  establish possession (deflection, poke, parry, punch, tip). */
const CONTROL_KICK = new Uint8Array(N_KICKS);
for (let k = 1; k < N_KICKS; k++) CONTROL_KICK[k] = 1;
for (const k of [KickKind.DEFLECTION, KickKind.TACKLE_POKE, KickKind.GK_PARRY, KickKind.GK_PUNCH, KickKind.GK_TIP]) {
  CONTROL_KICK[k] = 0;
}

// ---------------------------------------------------------------- scratch (rewritten before every use)

const MAX_RUNNERS = 4;
const selSlot = new Int32Array(MAX_RUNNERS);
const selScore = new Float64Array(MAX_RUNNERS);
const selU = new Float64Array(MAX_RUNNERS);
const selV = new Float64Array(MAX_RUNNERS);
const laneSlot = new Int32Array(MAX_RUNNERS);
const laneV = new Float64Array(MAX_RUNNERS);

// ---------------------------------------------------------------- helpers

/** NaN / Infinity -> 0 (a corrupt ball or player never poisons a target). */
function fin(v: number): number { return v > -1e9 && v < 1e9 ? v : 0; }
function clampN(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }
function styleIdx(t: Readonly<TeamState>): number {
  const st = t.style;
  return st >= 0 && st <= 4 && (st | 0) === st ? st : 0;
}
function dirOf(t: Readonly<TeamState>): number { return t.dir < 0 ? -1 : 1; }
function clockOf(v: number): number { return v >= 0 && v <= CLOCK_MAX ? v : v > CLOCK_MAX ? CLOCK_MAX : 0; }
function tickClock(v: number): number { return v < CLOCK_MAX ? v + 1 : CLOCK_MAX; }

/** Possession status recorded by the clocks: 1 in possession, 0 not, -1 unknown (equal clocks). */
export function possessionStatus(s: SimState, team: number): number {
  const t = s.teams[team]!;
  const a = clockOf(t.possT), b = clockOf(t.lostT);
  return a < b ? 1 : a > b ? 0 : -1;
}

/**
 * Team in possession for the team phase this tick (see the header), given `team`'s recorded status `prev`
 * (1 / 0 / -1, used for sticky loose balls). Returns 0, 1 or -1 (nobody yet).
 */
export function controlTeam(s: SimState, team: number, prev: number): number {
  const b = s.ball;
  const ph = s.match.phase;
  if (ph >= 0 && ph < N_PHASES && IS_RESTART[ph] === 1) {
    const rt = s.match.restart.team;
    if (rt === 0 || rt === 1) return rt;
  }
  const o = b.owner;
  if (o >= 0 && o < NUM_SLOTS) return s.players[o]!.team;
  const lt = b.lastTouch;
  if (lt >= 0 && lt < NUM_SLOTS && b.lastKickBy === lt && b.lastKickTick === b.lastTouchTick) {
    const k = b.lastKickKind;
    if (k >= 0 && k < N_KICKS && CONTROL_KICK[k] === 1) return s.players[lt]!.team;
  }
  if (prev === 1) return team;
  if (prev === 0) return otherTeam(team);
  const ltt = b.lastTouchTeam;
  return ltt === 0 || ltt === 1 ? ltt : -1;
}

/**
 * Space ahead for a counter by `team` with the ball where it is now: our outfield attackers beyond
 * (line - runnerReach), plus the style's counterExtra, minus the opponents' outfield players beyond line, where
 * line = max(ball u + breakAhead, breakMinU) in the team frame. >= 0 means a counter is on.
 */
export function counterMargin(s: SimState, team: number): number {
  const t = s.teams[team]!;
  const dir = dirOf(t);
  const ub = dir * fin(s.ball.x);
  let line = ub + LT.breakAhead;
  if (line < LT.breakMinU) line = LT.breakMinU;
  const reach = line - LT.runnerReach;
  const carrier = s.ball.owner;
  let ours = 0, theirs = 0;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = s.players[i]!;
    if (p.active !== 1 || p.isKeeper === 1) continue;
    const u = dir * p.x;
    if (p.team === team) { if (i !== carrier && u > reach) ours++; } else if (u > line) theirs++;
  }
  return ours + LT.counterExtra[styleIdx(t)]! - theirs;
}

/** TRANSITION_ATTACK window of a team, ticks. */
export function attackWindowTicks(t: Readonly<TeamState>): number {
  return Math.round(T_AI.transitionTicks * LT.attackWindowScale[styleIdx(t)]!);
}

/** TRANSITION_DEFEND window, ticks. */
export function defendWindowTicks(): number {
  return Math.round(T_AI.transitionTicks * LT.defendWindowScale);
}

/** BUILD_UP / ATTACK by ball depth with hysteresis around the own-third line. */
function thirdPhase(prev: TeamPhase, ub: number): TeamPhase {
  if (prev === TeamPhase.BUILD_UP) return ub < OWN_THIRD_U + LT.thirdHysteresis ? TeamPhase.BUILD_UP : TeamPhase.ATTACK;
  if (prev === TeamPhase.ATTACK) return ub > OWN_THIRD_U - LT.thirdHysteresis ? TeamPhase.ATTACK : TeamPhase.BUILD_UP;
  return ub < OWN_THIRD_U ? TeamPhase.BUILD_UP : TeamPhase.ATTACK;
}

/** ATTACK_BUILD intensity 0..1 for a ball at (ub, vb) in the team frame. */
function buildIntensity(ub: number, vb: number, counter: boolean): number {
  const depth = clampN((ub - FINAL_THIRD_U) / LT.buildDepthRange, 0, 1);
  const av = vb < 0 ? -vb : vb;
  const central = 1 - LT.buildCentralLoss * clampN((av - LT.buildCentralZ) / LT.buildCentralRange, 0, 1);
  return clampN(depth * central + (counter ? LT.buildCounterBonus : 0), 0, 1);
}

// ---------------------------------------------------------------- phase

export function updateTeamPhase(s: SimState, team: number, ev: EventSink): void {
  const t = s.teams[team]!;
  const b = s.ball;
  t.possT = clockOf(t.possT);
  t.lostT = clockOf(t.lostT);
  t.phaseT = clockOf(t.phaseT);
  const prev = t.possT < t.lostT ? 1 : t.possT > t.lostT ? 0 : -1;
  const ctl = controlTeam(s, team, prev);
  const cur = ctl === team ? 1 : ctl === -1 ? -1 : 0;

  // Clocks: a gain zeroes possT, a loss zeroes lostT; an unknown -> known status is adopted without a transition.
  let changed = false;
  if (cur === 1 && prev !== 1) {
    changed = prev === 0;
    t.lostT = t.lostT < 1 ? 1 : tickClock(t.lostT);
    t.possT = 0;
  } else if (cur === 0 && prev !== 0) {
    changed = prev === 1;
    t.possT = t.possT < 1 ? 1 : tickClock(t.possT);
    t.lostT = 0;
  } else {
    t.possT = tickClock(t.possT);
    t.lostT = tickClock(t.lostT);
  }

  const dir = dirOf(t);
  const ub = dir * fin(b.x);
  const old = t.phase;
  let ph: TeamPhase;
  if (s.match.phase !== MatchPhase.IN_PLAY) {
    ph = TeamPhase.SET_PIECE;
  } else if (cur === 1) {
    if (changed) {
      ph = counterMargin(s, team) >= 0 ? TeamPhase.TRANSITION_ATTACK : thirdPhase(old, ub);
    } else if (old === TeamPhase.TRANSITION_ATTACK && t.phaseT + 1 < attackWindowTicks(t) &&
      counterMargin(s, team) >= -LT.stayTolerance) {
      ph = TeamPhase.TRANSITION_ATTACK;
    } else {
      ph = thirdPhase(old, ub);
    }
  } else if (changed || (old === TeamPhase.TRANSITION_DEFEND && cur === 0 && t.phaseT + 1 < defendWindowTicks())) {
    ph = TeamPhase.TRANSITION_DEFEND;
  } else {
    ph = TeamPhase.DEFEND;
  }
  if (ph !== old) { t.phase = ph; t.phaseT = 0; } else t.phaseT = tickClock(t.phaseT);

  // Crowd: build-up in the final third.
  if (ph !== TeamPhase.SET_PIECE && cur === 1 && ub > FINAL_THIRD_U) {
    const entered = dir * fin(b.px) <= FINAL_THIRD_U;
    if (changed || entered || s.tick % LT.attackBuildInterval === 0) {
      ev.emit(EventType.ATTACK_BUILD, team, 0, buildIntensity(ub, dir * fin(b.z), ph === TeamPhase.TRANSITION_ATTACK), 0, b.x, b.y, b.z);
    }
  }
}

// ---------------------------------------------------------------- jobs

export function assignTransition(s: SimState, team: number, ev: EventSink): void {
  if (s.match.phase !== MatchPhase.IN_PLAY) return;
  const ph = s.teams[team]!.phase;
  if (ph === TeamPhase.TRANSITION_ATTACK) breakForward(s, team);
  else if (ph === TeamPhase.TRANSITION_DEFEND) recoveryRuns(s, team);
}

/** Highest u a runner may target: onside (offside on), never beyond the goal-line margin. Team frame. */
function runLimitU(s: SimState, team: number, dir: number, ub: number): number {
  let lim = HALF_LENGTH - LT.goalLineMargin;
  if (s.config.offside === 1) {
    let onside = dir * secondLastDefenderX(s, otherTeam(team)) - LT.onsideMargin;
    if (onside < ub) onside = ub; // level with or behind the ball is never offside
    if (onside < 0) onside = 0; // nor anywhere in the own half
    if (onside < lim) lim = onside;
  }
  return lim;
}

/** Counter-attack: the best runners break at sprint into space ahead of the ball. */
function breakForward(s: SimState, team: number): void {
  const t = s.teams[team]!;
  const st = styleIdx(t);
  if (t.phaseT < LT.breakDelay[st]!) return;
  const b = s.ball;
  const dir = dirOf(t);
  const ub = dir * fin(b.x), vb = dir * fin(b.z);
  const carrier = b.owner;
  const receiver = carrier === -1 && b.lastKickTeam === team ? b.passTarget : -1;
  const flags = tacticFlags(t);
  const runScale = phaseOffset(TeamPhase.TRANSITION_ATTACK).runScale * focusModifier(effectiveFocus(s, team)).runScale;
  const nIn = LT.inBehindRunners[st]!;
  let want = nIn + LT.supportRunners[st]!;
  if (want > MAX_RUNNERS) want = MAX_RUNNERS;

  // 1. Pick the `want` best runners (score desc, slot order on ties).
  let n = 0;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (i === carrier || i === receiver || !isJobDriven(s, i)) continue;
    const p = s.players[i]!;
    if (p.job > AiJob.RUN_IN_BEHIND) continue; // busy with a more urgent job this tick
    const w = rolePreset(slotRole(t.formation, p.formIdx, flags)).runs.counter * runScale;
    if (w < LT.minCounterWeight) continue;
    const up = dir * fin(p.x);
    const behind = ub - up - LT.behindFull;
    const posF = behind <= 0 ? 1 : clampN(1 - behind / LT.behindRange, LT.behindFloor, 1);
    const score = w * posF;
    if (n === want && score <= selScore[n - 1]!) continue;
    let k = n < want ? n++ : n - 1;
    while (k > 0 && selScore[k - 1]! < score) { selScore[k] = selScore[k - 1]!; selSlot[k] = selSlot[k - 1]!; k--; }
    selScore[k] = score;
    selSlot[k] = i;
  }
  if (n === 0) return;

  // 2. The most advanced go in behind, the rest support. Sort by u desc (ties: slot order).
  for (let a = 0; a < n; a++) {
    const p = s.players[selSlot[a]!]!;
    selU[a] = dir * fin(p.x);
    selV[a] = dir * fin(p.z);
  }
  for (let a = 1; a < n; a++) {
    const sl = selSlot[a]!, u = selU[a]!, v = selV[a]!;
    let k = a;
    while (k > 0 && (selU[k - 1]! < u || (selU[k - 1]! === u && selSlot[k - 1]! > sl))) {
      selSlot[k] = selSlot[k - 1]!; selU[k] = selU[k - 1]!; selV[k] = selV[k - 1]!; k--;
    }
    selSlot[k] = sl; selU[k] = u; selV[k] = v;
  }
  const inB = n < nIn ? n : nIn;
  const uLim = runLimitU(s, team, dir, ub);
  const vLim = HALF_WIDTH - LT.sideMargin;

  // 3. In-behind lanes: ordered by current lateral position so the runs never cross.
  for (let a = 0; a < inB; a++) { laneSlot[a] = selSlot[a]!; laneV[a] = selV[a]!; }
  for (let a = 1; a < inB; a++) {
    const sl = laneSlot[a]!, v = laneV[a]!;
    let k = a;
    while (k > 0 && (laneV[k - 1]! > v || (laneV[k - 1]! === v && laneSlot[k - 1]! > sl))) {
      laneSlot[k] = laneSlot[k - 1]!; laneV[k] = laneV[k - 1]!; k--;
    }
    laneSlot[k] = sl; laneV[k] = v;
  }
  const centre = clampN(vb * LT.laneBallFollow, -LT.laneCentreMax, LT.laneCentreMax);
  for (let a = 0; a < inB; a++) {
    const slot = laneSlot[a]!;
    const p = s.players[slot]!;
    const up = dir * fin(p.x);
    const lane = inB === 1
      ? centre + clampN(laneV[a]! - centre, -LT.laneGap * 0.5, LT.laneGap * 0.5)
      : centre + (a - (inB - 1) * 0.5) * LT.laneGap;
    // runAhead m beyond the ball, or beyond the runner himself when he is already ahead of it (toward the space
    // at the opponents' line); never offside, never into the goal.
    let u = (up > ub ? up : ub) + LT.runAhead[st]!;
    if (u > uLim) u = uLim;
    const v = clampN(lane, -vLim, vLim);
    assignJob(s, slot, AiJob.RUN_IN_BEHIND, dir * u, dir * v, s.attrs[slot]!.topSpeed, -1);
  }

  // 4. Supporting breaks beside and ahead of the ball.
  const anchor = carrier >= 0 ? carrier : receiver;
  for (let a = inB; a < n; a++) {
    const slot = selSlot[a]!;
    let u = ub + LT.supportAhead;
    const hold = selU[a]! < uLim ? selU[a]! : uLim; // a runner already ahead of that point keeps his depth
    if (u < hold) u = hold;
    if (u > uLim) u = uLim;
    const side = selV[a]! >= vb ? 1 : -1;
    const v = clampN(vb + side * LT.supportWide, -vLim, vLim);
    assignJob(s, slot, AiJob.SUPPORT, dir * u, dir * v, s.attrs[slot]!.topSpeed, anchor);
  }
}

/** Recovery runs: players caught upfield sprint to goal-side points on the ball-goal line. */
function recoveryRuns(s: SimState, team: number): void {
  const t = s.teams[team]!;
  const b = s.ball;
  const dir = dirOf(t);
  const ub = dir * fin(b.x), vb = dir * fin(b.z);
  const flags = tacticFlags(t);
  const dutyScale = phaseOffset(TeamPhase.TRANSITION_DEFEND).dutyScale * focusModifier(effectiveFocus(s, team)).dutyScale *
    LT.recoverStyleScale[styleIdx(t)]!;
  const goalSide = ub - LT.recoverDepth;
  const caughtU = ub - LT.goalSideMargin;
  const span = ub + HALF_LENGTH;
  const vLim = HALF_WIDTH - LT.recoverSideMargin;
  const end = teamEnd(team);
  for (let i = teamStart(team); i < end; i++) {
    if (!isJobDriven(s, i)) continue;
    const p = s.players[i]!;
    if (rolePreset(slotRole(t.formation, p.formIdx, flags)).duties.recover * dutyScale < LT.recoverDutyMin) continue;
    const up = dir * fin(p.x);
    const uh = dir * fin(p.homeX);
    const caught = up > caughtU;
    if (!caught && p.job >= AiJob.MARK && p.job <= AiJob.COVER) continue; // goal-side and busy defending
    let u = uh < goalSide ? uh : goalSide;
    if (u < RECOVER_MIN_U) u = RECOVER_MIN_U;
    if (!caught) {
      if (uh > goalSide) {
        if (up < u - LT.holdTolerance) continue; // home ahead: deeper than his point, the shape moves him up into it
      } else if (up <= goalSide) {
        continue; // home deeper: recovered once recoverDepth goal-side; the shape takes him on to his home
      }
    }
    const frac = span > 1e-6 ? clampN((u + HALF_LENGTH) / span, 0, 1) : 0;
    const vLine = vb * frac;
    const v = clampN(vLine + (dir * fin(p.homeZ) - vLine) * LT.lateralKeep, -vLim, vLim);
    assignJob(s, i, AiJob.RECOVER, dir * u, dir * v, s.attrs[i]!.topSpeed, -1);
  }
}
