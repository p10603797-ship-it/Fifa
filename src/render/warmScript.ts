/**
 * [QF-7R] Render JIT warm-up script (BRIEF section 13 "Warm-up": "run each animation and effect once off screen. The
 * first slide tackle or replay in a match must not hitch.").
 *
 * GameRenderer.warmUp() (render/index.ts) runs it once per renderer on the loading screen, before the shader compile:
 * WARM_TUNING.ticks sim ticks of a scripted private match, two animation frames per tick (alpha 0.5 and 1, as on a
 * 120 Hz display), through every module's real update() and onEvents() (all but the quality module, whose frame-time
 * signal must only see real frames) and both cameras and the replay: every slot cycles through every ActionKind and
 * kick kind (wind-up, contact, follow-through, charged kicks, restarts of the same action, dives both ways, the three
 * celebrations...), locomotion at every speed band, turning, strafing, jockeying and shielding; the ball is dribbled
 * with touches due, passed along the ground, lofted high, shot into both nets and held by the keepers; the match walks
 * through open play, every restart phase (with set-up teleports), a goal, the celebration and the replay. index.ts
 * then re-applies setMatch(live state) to every module (and resets the animator), so nothing of the script remains on
 * screen or in any module's memory. Nothing is drawn.
 *
 * Why: V8 and JSC optimise a function for the branches it has run. A branch first reached during play (the first
 * slide, dive, header, set piece...) makes the optimised code bail out ("insufficient type feedback"), run
 * unoptimised for a while (in V8 boxing every double: ~1-6 KB of garbage per frame) and recompile: a hitch plus a
 * burst of allocation in the first minutes of a match (INT-C finding; tests/perf/int-c-render-alloc.test.ts).
 *
 * SHAPE RULE: the private states are built like the live state (createSimState, then a field-by-field copy of the
 * live state), so they share the live objects' hidden classes and the feedback gathered here is the feedback of play.
 * Hence the script writes integers into every field the sim keeps integral (actions, flags, slots, phase, tick) and
 * fractions only into fields the sim itself makes fractional (positions, velocities, facing, ball kinematics, power):
 * a fraction in an integral field would change that field's representation for the live objects as well and slow
 * the sim down for the whole session (measured: +25 % sim time with every field made fractional).
 *
 * Never touches the live state. Allocates its private states once per call (loading screen only).
 */

import { HALF_LENGTH, NUM_SLOTS, PLAYERS_PER_TEAM } from '../contracts/constants';
import type { PlayerData } from '../contracts/data';
import { ActionKind, KickKind, MatchPhase, RestartKind, SkillMove } from '../contracts/enums';
import { EventType, type EventBuffer, type SimEvent } from '../contracts/events';
import { createSimState, MoveMode, type MatchConfig, type PlayerState, type ReadonlySimState, type SimState } from '../contracts/state';

export const WARM_TUNING = { // TUNING-CR (render-only: loading-screen warm-up)
  /** Scripted sim ticks (two animation frames each). */
  ticks: 300,
  /** Ticks per action slot of a player's programme (actions last up to actionSpan - 2 ticks). */
  actionSpan: 26,
  /** Ticks per locomotion speed band. */
  speedSpan: 23,
  /** Radius of the loops players run around their spots (m). */
  loopRadius: 5,
} as const;

/** Locomotion speed bands (m/s): idle, walk, jog, run, sprint, flat out. */
const SPEEDS = [0, 0.7, 2.2, 4.4, 6.6, 8.6] as const;

/** One programme entry: action, kick kind, duration, contact tick (-1 none), actA, actB, charged (1/0). */
type Step = readonly [ActionKind, KickKind, number, number, number, number, number];

const OUTFIELD: readonly Step[] = [
  [ActionKind.KICK, KickKind.GROUND_PASS, 20, 8, 0, 0, 0],
  [ActionKind.SHOT, KickKind.SHOT_POWER, 24, 10, 0, 0, 1],
  [ActionKind.SLIDE_TACKLE, KickKind.NONE, 24, 8, 0, 0, 0],
  [ActionKind.HEADER, KickKind.HEADER_SHOT, 18, 6, 0, 0, 0],
  [ActionKind.KICK, KickKind.LOB_PASS, 22, 9, 0, 0, 1],
  [ActionKind.FIRST_TOUCH, KickKind.FIRST_TOUCH, 12, 3, 0, 0, 0],
  [ActionKind.VOLLEY, KickKind.VOLLEY_SHOT, 18, 6, 0, 0, 0],
  [ActionKind.STAND_TACKLE, KickKind.TACKLE_POKE, 18, 6, 0, 0, 0],
  [ActionKind.SKILL, KickKind.NONE, 20, -1, 0, 0, 0],
  [ActionKind.KICK, KickKind.CROSS, 22, 9, 0, 0, 0],
  [ActionKind.SHOT, KickKind.SHOT_FINESSE, 22, 9, 0, 0, 0],
  [ActionKind.HARD_TACKLE, KickKind.NONE, 18, 6, 0, 0, 0],
  [ActionKind.FAKE, KickKind.NONE, 14, -1, 0, 0, 0],
  [ActionKind.STUMBLE, KickKind.NONE, 16, -1, 0, 0, 0],
  [ActionKind.FALLEN, KickKind.NONE, 22, -1, 0, 0, 0],
  [ActionKind.GET_UP, KickKind.NONE, 20, -1, 0, 0, 0],
  [ActionKind.KICK, KickKind.CLEARANCE, 20, 8, 0, 0, 0],
  [ActionKind.SHOULDER, KickKind.NONE, 14, 5, 0, 0, 0],
  [ActionKind.PUSH_PULL, KickKind.NONE, 14, 5, 0, 0, 0],
  [ActionKind.HEADER, KickKind.HEADER_PASS, 18, 6, 0, 0, 0],
  [ActionKind.SHOT, KickKind.SHOT_CHIP, 22, 9, 0, 0, 0],
  [ActionKind.VOLLEY, KickKind.VOLLEY_PASS, 18, 6, 0, 0, 0],
  [ActionKind.SHIELD, KickKind.NONE, 20, -1, 0, 0, 0],
  [ActionKind.KICK, KickKind.DRIVEN_PASS, 20, 8, 0, 0, 0],
  [ActionKind.THROW_IN, KickKind.NONE, 22, 12, 0, 0, 0],
  [ActionKind.SHOT, KickKind.SHOT_LOW_DRIVEN, 22, 9, 0, 0, 0],
  [ActionKind.KICK, KickKind.THROUGH_DINKED, 20, 8, 0, 0, 0],
  [ActionKind.WALL_JUMP, KickKind.NONE, 18, -1, 1, 0, 0],
  [ActionKind.SHOT, KickKind.SHOT_NORMAL, 22, 9, 0, 0, 0],
  [ActionKind.CELEBRATE, KickKind.NONE, 24, -1, 0, 0, 0],
  [ActionKind.DEJECTED, KickKind.NONE, 24, -1, 0, 0, 0],
  [ActionKind.KICK, KickKind.HIGH_LOB, 22, 9, 0, 0, 0],
  [ActionKind.WALL_JUMP, KickKind.NONE, 18, -1, 0, 0, 0],
  [ActionKind.SET_PIECE, KickKind.NONE, 20, -1, 0, 0, 0],
  [ActionKind.KICK, KickKind.GROUND_CROSS, 20, 8, 0, 0, 0],
  [ActionKind.WALL_JUMP, KickKind.NONE, 18, -1, 2, 0, 0],
];

const KEEPER: readonly Step[] = [
  [ActionKind.GK_DIVE, KickKind.NONE, 22, 6, 0, -1, 0],
  [ActionKind.GK_CATCH, KickKind.NONE, 14, 5, 1, 0, 0],
  [ActionKind.GK_HOLD, KickKind.NONE, 20, -1, 0, 0, 0],
  [ActionKind.GK_THROW, KickKind.GK_THROW, 20, 8, 0, 0, 0],
  [ActionKind.GK_DIVE, KickKind.NONE, 22, 6, 1, 1, 0],
  [ActionKind.GK_PUNCH, KickKind.GK_PUNCH, 14, 5, 0, 0, 0],
  [ActionKind.GK_KICK, KickKind.GK_DROP_KICK, 22, 9, 0, 0, 0],
  [ActionKind.GK_DIVE, KickKind.NONE, 22, 6, 2, -1, 0],
  [ActionKind.GK_RUSH, KickKind.NONE, 20, -1, 0, 0, 0],
  [ActionKind.GK_THROW, KickKind.GK_ROLL, 20, 8, 0, 0, 0],
  [ActionKind.GK_CATCH, KickKind.NONE, 14, 5, 0, 0, 0],
  [ActionKind.GK_DIVE, KickKind.NONE, 22, 6, 2, 1, 0],
  [ActionKind.GK_KICK, KickKind.GOAL_KICK, 22, 9, 0, 0, 0],
  [ActionKind.GK_DIVE, KickKind.NONE, 22, 6, 0, 1, 0],
  [ActionKind.GK_DIVE, KickKind.NONE, 22, 6, 1, -1, 0],
  [ActionKind.CELEBRATE, KickKind.NONE, 24, -1, 1, 0, 0],
];

/** Match phases of the script: [first tick, phase, restart kind]. Open play first and most. */
const PHASES: readonly (readonly [number, MatchPhase, RestartKind])[] = [
  [0, MatchPhase.KICK_OFF, RestartKind.KICK_OFF],
  [12, MatchPhase.IN_PLAY, RestartKind.NONE],
  [96, MatchPhase.CORNER, RestartKind.CORNER],
  [118, MatchPhase.IN_PLAY, RestartKind.NONE],
  [130, MatchPhase.FREE_KICK, RestartKind.FREE_KICK],
  [152, MatchPhase.THROW_IN, RestartKind.THROW_IN],
  [166, MatchPhase.GOAL_KICK, RestartKind.GOAL_KICK],
  [178, MatchPhase.PENALTY, RestartKind.PENALTY],
  [196, MatchPhase.IN_PLAY, RestartKind.NONE],
  [214, MatchPhase.GOAL, RestartKind.NONE],
  [226, MatchPhase.CELEBRATION, RestartKind.NONE],
  [244, MatchPhase.REPLAY, RestartKind.NONE],
  [286, MatchPhase.IN_PLAY, RestartKind.NONE],
];

/** The module stack the script drives (render/index.ts). */
export interface WarmTarget {
  /** One animation frame of every module (as GameRenderer.render, without the draw). */
  frame(prev: ReadonlySimState, curr: ReadonlySimState, alpha: number, nowMs: number, dtMs: number, frame: number): void;
  /** The events of one tick (as GameRenderer.onEvents). */
  events(ev: EventBuffer, state: ReadonlySimState): void;
}

/** Copy every plain value of src into dst in place (same layout; arrays element-wise); config / squads skipped. */
function copyInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k in src) {
    if (k === '__proto__' || k === 'config' || k === 'squads') continue;
    const v = src[k];
    const d = dst[k];
    if (typeof v === 'number') {
      if (typeof d === 'number') dst[k] = v;
    } else if (typeof v === 'object' && v !== null && typeof d === 'object' && d !== null) {
      if (Array.isArray(v) && Array.isArray(d)) {
        const n = v.length < d.length ? v.length : d.length;
        for (let i = 0; i < n; i++) {
          const e = v[i];
          if (typeof e === 'number' && typeof d[i] === 'number') d[i] = e;
          else if (typeof e === 'object' && e !== null && typeof d[i] === 'object' && d[i] !== null) {
            copyInto(d[i] as Record<string, unknown>, e as Record<string, unknown>);
          }
        }
      } else if (!Array.isArray(v) && !Array.isArray(d) && !ArrayBuffer.isView(v) && !ArrayBuffer.isView(d)) {
        copyInto(d as Record<string, unknown>, v as Record<string, unknown>);
      }
    }
  }
}

/** A minimal EventBuffer (same record layout as the sim's). */
function createWarmEvents(): EventBuffer {
  const items: SimEvent[] = [];
  for (let i = 0; i < 16; i++) items.push({ type: 0 as EventType, tick: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0 });
  let count = 0;
  let tick = 0;
  return {
    get count() { return count; },
    get(i: number) { return items[i]!; },
    begin(t: number) { count = 0; tick = t; },
    emit(type: EventType, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0) {
      if (count >= items.length) return;
      const e = items[count++]!;
      e.type = type; e.tick = tick; e.a = a; e.b = b; e.c = c; e.d = d; e.x = x; e.y = y; e.z = z;
    },
  };
}

function phaseAt(t: number): number {
  let k = 0;
  for (let i = 0; i < PHASES.length; i++) if (t >= PHASES[i]![0]) k = i;
  return k;
}

/** Restart spot for a restart kind, attacking +x (team 0). */
function restartSpot(kind: RestartKind, out: Float64Array): void {
  out[0] = 0; out[1] = 0;
  if (kind === RestartKind.CORNER) { out[0] = HALF_LENGTH - 0.5; out[1] = 33.5; }
  else if (kind === RestartKind.FREE_KICK) { out[0] = 27.5; out[1] = -6.5; }
  else if (kind === RestartKind.THROW_IN) { out[0] = 12.5; out[1] = -34; }
  else if (kind === RestartKind.GOAL_KICK) { out[0] = -HALF_LENGTH + 5.5; out[1] = 4.5; }
  else if (kind === RestartKind.PENALTY) { out[0] = HALF_LENGTH - 11; out[1] = 0; }
}

/**
 * Run the script through `target`. `live` is only read (copied once). Returns the number of animation frames run.
 * Cost: a few hundred ms unoptimised on the loading screen, once per renderer.
 */
export function runWarmScript(live: ReadonlySimState, target: WarmTarget, ticks: number = WARM_TUNING.ticks): number {
  const cfg = live.config as unknown as MatchConfig;
  const squads = live.squads as unknown as PlayerData[][];
  const curr: SimState = createSimState(cfg, squads);
  const prev: SimState = createSimState(cfg, squads);
  copyInto(curr as unknown as Record<string, unknown>, live as unknown as Record<string, unknown>);
  copyInto(prev as unknown as Record<string, unknown>, live as unknown as Record<string, unknown>);
  const ev = createWarmEvents();
  // Per-slot kinematics: spot, loop angle, position, velocity, facing.
  const hx = new Float64Array(NUM_SLOTS), hz = new Float64Array(NUM_SLOTS), ang = new Float64Array(NUM_SLOTS);
  const px = new Float64Array(NUM_SLOTS), pz = new Float64Array(NUM_SLOTS);
  const spot = new Float64Array(2);
  for (let i = 0; i < NUM_SLOTS; i++) {
    const p = live.players[i]!;
    const keeper = i % PLAYERS_PER_TEAM === 0;
    const side = i < PLAYERS_PER_TEAM ? -1 : 1;
    hx[i] = keeper ? side * (HALF_LENGTH - 3.5) : (Number.isFinite(p.x) && p.x !== 0 ? p.x : side * (8 + (i % PLAYERS_PER_TEAM) * 3.5));
    hz[i] = keeper ? 0 : (Number.isFinite(p.z) ? p.z : 0) + ((i * 7) % 11) - 5;
    ang[i] = i * 0.61;
    px[i] = hx[i]! + WARM_TUNING.loopRadius * Math.cos(ang[i]!);
    pz[i] = hz[i]! + WARM_TUNING.loopRadius * Math.sin(ang[i]!);
  }
  let frames = 0;
  let nowMs = 0;
  let lastPhase = -1;
  const t0 = live.tick + 1;
  for (let t = 0; t < ticks; t++) {
    const tick = t0 + t;
    // prev <- curr (the fields the script writes).
    copyInto(prev as unknown as Record<string, unknown>, curr as unknown as Record<string, unknown>);
    ev.begin(tick);
    curr.tick = tick;
    const pk = phaseAt(t);
    const phase = PHASES[pk]![1];
    const rkind = PHASES[pk]![2];
    const m = curr.match;
    if (pk !== lastPhase) {
      const from = lastPhase < 0 ? MatchPhase.KICK_OFF : PHASES[lastPhase]![1];
      ev.emit(EventType.PHASE_CHANGE, from, phase);
      ev.emit(EventType.WHISTLE, pk & 3);
      if (rkind !== RestartKind.NONE) {
        restartSpot(rkind, spot);
        ev.emit(EventType.RESTART_AWARDED, rkind, 0, 0, 0, spot[0]!, 0, spot[1]!);
      }
      if (phase === MatchPhase.GOAL) {
        m.goalTick = tick;
        m.goalTeam = 0;
        m.goalScorer = 9;
        ev.emit(EventType.GOAL, 0, 9, 7, 0);
      }
      m.prevPhase = m.phase;
      m.phase = phase;
      m.phaseT = 0;
      lastPhase = pk;
    } else {
      m.phaseT = m.phaseT + 1;
    }
    const r = m.restart;
    const setPiece = rkind !== RestartKind.NONE;
    if (setPiece) {
      restartSpot(rkind, spot);
      r.kind = rkind; r.team = 0; r.x = spot[0]!; r.z = spot[1]!; r.taker = 9;
      r.t = m.phaseT; r.ready = m.phaseT >= 6 ? 1 : 0; r.taken = 0; r.timeoutT = 600 - m.phaseT;
      r.wallCount = rkind === RestartKind.FREE_KICK ? 3 : 0;
      for (let w = 0; w < r.wall.length; w++) r.wall[w] = w < r.wallCount ? 14 + w : -1;
      r.side = rkind === RestartKind.CORNER ? 1 : 0;
      r.aimX = HALF_LENGTH - 8.5; r.aimZ = 2.5; r.aimPower = 0.5 + (m.phaseT % 5) * 0.1; r.aimCurve = 0.25;
    } else {
      r.kind = RestartKind.NONE; r.ready = 0; r.taker = -1; r.wallCount = 0;
    }
    const celebrating = phase === MatchPhase.GOAL || phase === MatchPhase.CELEBRATION;
    // ---- players
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = curr.players[i]! as PlayerState;
      const keeper = i % PLAYERS_PER_TEAM === 0;
      const band = SPEEDS[((((t / WARM_TUNING.speedSpan) | 0) + (i % 3)) % SPEEDS.length)]!;
      let speed = setPiece && m.phaseT < 2 ? 0 : band;
      if (keeper && speed > 4.4) speed = 4.4;
      // Turn rate: tight loops every third band (turn lean), wide otherwise.
      const tight = ((t / WARM_TUNING.speedSpan) | 0) % 3 === 2;
      const rad = tight ? WARM_TUNING.loopRadius * 0.4 : WARM_TUNING.loopRadius;
      ang[i] = ang[i]! + speed / 60 / rad * (i & 1 ? 1 : -1);
      if (setPiece && m.phaseT === 0) {
        // Set-up placement: a teleport (snapTeleports, the mapper's teleport branch, camera snaps).
        const s = i < PLAYERS_PER_TEAM ? 1 : -1;
        hx[i] = rkind === RestartKind.KICK_OFF ? -s * (6 + (i % PLAYERS_PER_TEAM) * 3.7) : spot[0]! - s * ((i % PLAYERS_PER_TEAM) * 2.3 + 3);
        hz[i] = spot[1]! * 0.5 + ((i * 5) % 13) - 6;
        if (keeper) { hx[i] = (i < PLAYERS_PER_TEAM ? -1 : 1) * (HALF_LENGTH - 1); hz[i] = 0; }
      }
      const nx = hx[i]! + rad * Math.cos(ang[i]!);
      const nz = hz[i]! + rad * Math.sin(ang[i]!);
      const vx = (nx - px[i]!) * 60, vz = (nz - pz[i]!) * 60;
      px[i] = nx; pz[i] = nz;
      p.x = nx; p.z = nz;
      const vl = Math.sqrt(vx * vx + vz * vz);
      p.vx = vl < 30 ? vx : 0; p.vz = vl < 30 ? vz : 0;
      // Facing: along the run; strafing (90 deg off) and backpedalling (180 deg) in some bands.
      const mode = (((t / WARM_TUNING.speedSpan) | 0) + i) % 5;
      let fx = vl > 1e-6 ? vx / vl : 1, fz = vl > 1e-6 ? vz / vl : 0;
      if (mode === 3) { const k = fx; fx = -fz; fz = k; } else if (mode === 4 && speed < 3) { fx = -fx; fz = -fz; }
      p.fx = fx; p.fz = fz;
      p.sprinting = speed > 6 ? 1 : 0;
      p.jockeying = mode === 3 && speed < 3 ? 1 : 0;
      p.shielding = 0;
      p.moveMode = speed > 0 ? MoveMode.DIRECT : MoveMode.STOP;
      p.lookAt = mode === 3 ? 1 : 0;
      p.lookX = nx + fx * 3; p.lookZ = nz + fz * 3;
      // Action programme.
      const prog = keeper ? KEEPER : OUTFIELD;
      const span = WARM_TUNING.actionSpan;
      const u = (t + i * 7) % span;
      const seg = ((t + i * 7) / span) | 0;
      const st = prog[(seg + i) % prog.length]!;
      let act: ActionKind = st[0];
      if (celebrating) act = i < PLAYERS_PER_TEAM ? ActionKind.CELEBRATE : ActionKind.DEJECTED;
      else if (setPiece && i === 9) act = m.phaseT < 10 ? ActionKind.SET_PIECE : ActionKind.KICK;
      const dur = celebrating ? 60 : setPiece && i === 9 ? 20 : st[2];
      const contact = celebrating ? -1 : setPiece && i === 9 ? (m.phaseT < 10 ? -1 : 8) : st[3];
      const at = setPiece && i === 9 ? (m.phaseT < 10 ? m.phaseT : m.phaseT - 10) : celebrating ? m.phaseT : u;
      if (at < dur) {
        p.act = act;
        p.actT = at;
        p.actDur = st[6] === 1 && at < 12 ? dur + 4 : dur;
        p.actContact = contact;
        p.actDone = contact >= 0 && at >= contact ? 1 : 0;
        p.actKick = act === ActionKind.KICK && setPiece ? KickKind.CROSS : st[1];
        p.actSkill = act === ActionKind.SKILL ? (1 + (seg % 11)) as SkillMove : SkillMove.NONE;
        p.actCharging = st[6] === 1 && at < contact + 2 && (seg & 1) === 0 ? 1 : 0;
        p.actA = celebrating ? i % 3 : st[4];
        p.actB = st[5];
        p.actPower = 0.35 + (at % 7) * 0.09;
        p.actX = nx + fx * 12.5; p.actZ = nz + fz * 12.5;
        p.actDirX = fx; p.actDirZ = fz;
        p.actSlot = (i + 3) % NUM_SLOTS;
        p.actCurve = (seg & 1) === 0 ? 0.25 : -0.25;
        if (contact >= 0 && at === contact && st[1] !== KickKind.NONE) {
          ev.emit(EventType.KICK, i, st[1], p.actPower, 0, nx, 0.11, nz);
        }
      } else {
        p.act = ActionKind.NONE; p.actT = 0; p.actDur = 0; p.actContact = -1; p.actDone = 0; p.actCharging = 0;
        p.actKick = KickKind.NONE; p.actSkill = SkillMove.NONE;
      }
      p.stunT = act === ActionKind.FALLEN || act === ActionKind.STUMBLE ? 10 : 0;
      p.ctrl = i === 9 ? 0 : i === 20 ? 1 : -1;
    }
    // ---- ball
    const b = curr.ball;
    const w = ((t / 20) | 0) % 5;
    const ut = t % 20;
    b.owner = -1; b.heldBy = -1; b.shotBy = -1; b.passTarget = -1; b.inNet = 0; b.grounded = 1;
    b.sx = 0; b.sy = 0; b.sz = 0;
    if (celebrating || phase === MatchPhase.REPLAY) {
      b.x = HALF_LENGTH + 1.25; b.y = 0.6 + (t % 3) * 0.1; b.z = 0.5;
      b.vx = 0.5; b.vy = 0; b.vz = 0; b.inNet = 1;
    } else if (setPiece) {
      b.x = spot[0]!; b.y = rkind === RestartKind.THROW_IN ? 2.1 : 0.11; b.z = spot[1]!;
      b.vx = 0; b.vy = 0; b.vz = 0;
      if (rkind === RestartKind.THROW_IN) { b.owner = 9; }
    } else if (w === 0 || w === 2) {
      // Dribble: the ball at the owner's feet, touches due (touchCd) and taken (lastTouchTick).
      const j = w === 0 ? 9 : 17;
      const o = curr.players[j]!;
      o.act = ActionKind.NONE; o.actT = 0; o.actContact = -1; o.actDone = 0; o.actCharging = 0;
      o.shielding = ut > 14 ? 1 : 0;
      o.touchCd = 8 - (t % 9);
      b.owner = j;
      b.x = o.x + o.fx * 0.55; b.z = o.z + o.fz * 0.55; b.y = 0.11;
      b.vx = o.vx; b.vy = 0; b.vz = o.vz;
      b.sx = o.vz * 9.1; b.sz = -o.vx * 9.1;
      if (o.touchCd === 0) { b.lastTouch = j; b.lastTouchTeam = j < PLAYERS_PER_TEAM ? 0 : 1; b.lastTouchTick = tick; b.touchedTick = tick; }
    } else if (w === 1) {
      // A ground pass to a receiver (touch reach on arrival) then a high ball (landing marker, camera tilt).
      const j = 13;
      const o = curr.players[j]!;
      b.passTarget = j; b.lastKickBy = 9; b.lastKickKind = KickKind.GROUND_PASS; b.lastKickTick = tick - ut;
      const k = 1 - ut / 20;
      b.x = o.x - 9.5 * k; b.z = o.z - 4.5 * k; b.y = 0.11;
      b.vx = 9.5 * 3; b.vy = 0; b.vz = 4.5 * 3;
    } else if (w === 3) {
      const k = ut / 20;
      b.x = -20.5 + 41 * k; b.z = -10.5 + 21 * k; b.y = 0.11 + 13.5 * 4 * k * (1 - k);
      b.vx = 41 * 3; b.vz = 21 * 3; b.vy = 13.5 * 4 * (1 - 2 * k) * 3;
      b.grounded = 0; b.bounces = 0;
      b.sy = 4.5;
      b.lastKickBy = 4; b.lastKickKind = KickKind.HIGH_LOB; b.lastKickTick = tick - ut;
    } else {
      // A shot into the net at +x (ripple), the next at -x.
      const end = ((t / 100) | 0) % 2 === 0 ? 1 : -1;
      const k = ut / 20;
      b.x = end * (HALF_LENGTH - 16.5 + 19.5 * k); b.z = 1.5 * k; b.y = 0.3 + 1.6 * k;
      b.vx = end * 29.5; b.vy = 1.5; b.vz = 2.5;
      b.grounded = 0;
      b.shotBy = end > 0 ? 9 : 20; b.shotTick = tick - ut; b.shotOnTarget = 1;
      b.sy = 7.5 * end;
      if (end * b.x > HALF_LENGTH + 0.11) {
        b.inNet = end;
        if (ut === 18) ev.emit(EventType.NET, end, 0, 29.5);
      }
      if (ut === 10) ev.emit(EventType.POST, end, 0, 22.5);
      if (ut === 12) ev.emit(EventType.SAVE, end > 0 ? 11 : 0, 1, 25.5);
    }
    // Keepers holding the ball in some windows.
    if (!celebrating && !setPiece && w === 4 && ut > 15) {
      const kslot = ((t / 100) | 0) % 2 === 0 ? 11 : 0;
      const kp = curr.players[kslot]!;
      kp.act = ActionKind.GK_HOLD; kp.actT = ut - 16; kp.actDur = 20; kp.actContact = -1; kp.actDone = 0;
      b.owner = kslot; b.heldBy = kslot; b.inNet = 0;
      b.x = kp.x + kp.fx * 0.3; b.y = 1.1; b.z = kp.z + kp.fz * 0.3; b.vx = kp.vx; b.vy = 0; b.vz = kp.vz;
    }
    if ((t % 37) === 5) ev.emit(EventType.TACKLE, 4, 15, 1, 2);
    if ((t % 53) === 7) ev.emit(EventType.FOUL, 15, 4, 1, 0);
    if ((t % 61) === 11) ev.emit(EventType.BOUNCE, 0, 0, 6.5);
    if ((t % 41) === 3) ev.emit(EventType.ATTACK_BUILD, 0, 0, 0.75);
    if (ev.count > 0) target.events(ev, curr);
    for (let a = 1; a <= 2; a++) {
      const dt = 1000 / 120;
      nowMs += dt;
      target.frame(prev, curr, a * 0.5, nowMs, dt, frames);
      frames++;
    }
  }
  return frames;
}
