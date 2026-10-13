/**
 * SIM-12 scenario helpers: a quiet IN_PLAY scene (CPU brains off, everyone parked far from the +x penalty area,
 * keepers in goal), crosses launched with the sim's own launch solver, and a free-ball arrival probe at a goal line.
 */
import { AssistLevel, AutoSwitch, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { createBallState, type BallState, type PlayerAttrs, type SimState } from '../../src/contracts/state';
import { BALL_RADIUS, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH } from '../../src/contracts/constants';
import { ballStepTick } from '../../src/sim/ball/contact';
import { copyBallState, createLaunchSolution, solveLaunchSpin } from '../../src/sim/ball/flight';
import { aerialChance } from '../../src/sim/kicks/aerial';
import { makeScenario, runTicks } from '../harness/scenario';

export interface QuietOpts {
  seed?: number;
  /** Slot P1 controls (team 0), or undefined for no human. */
  human?: number;
  assist?: AssistLevel;
  /** Park the away keeper by the far corner flag (keeps him out of header-mechanics measurements). */
  keeperAway?: boolean;
}

/** Quiet IN_PLAY scene: no CPU brains, players parked away from the +x penalty area, keepers in goal. */
export function quietScene(o: QuietOpts = {}): SimState {
  const humans = o.human !== undefined
    ? [{ side: 0, slot: o.human, assist: o.assist ?? AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }]
    : 0;
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans, seed: o.seed ?? 7 });
  for (const c of [2, 3]) {
    const ctl = s.ctrl[c]!;
    if (ctl.slot >= 0 && s.players[ctl.slot]!.ctrl === c) s.players[ctl.slot]!.ctrl = -1;
    ctl.kind = ControllerKind.NONE;
    ctl.side = -1;
    ctl.slot = -1;
    s.teams[c - 2]!.cpu.active = 0;
  }
  for (let i = 0; i < 22; i++) {
    if (i === o.human) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1;
    const k = i % 11;
    if (k === 0) { p.x = team === 0 ? -50 : o.keeperAway ? 50 : 51; p.z = team === 1 && o.keeperAway ? -33 : 0; } else { p.x = team === 0 ? -44 : -36; p.z = -30 + k * 5.5; }
    p.vx = 0; p.vz = 0; p.fx = team === 0 ? 1 : -1; p.fz = 0;
  }
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = 0; b.z = 0; b.y = 0.11; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.px = 0; b.py = 0.11; b.pz = 0; b.passTarget = -1; b.shotBy = -1;
  return s;
}

/** Place a player (standing, facing `fx`), with optional attribute overrides. */
export function place(s: SimState, slot: number, x: number, z: number, attrs?: Partial<PlayerAttrs>, fx?: number): void {
  const p = s.players[slot]!;
  p.x = x; p.z = z; p.vx = 0; p.vz = 0;
  p.fx = fx ?? (p.team === 0 ? 1 : -1); p.fz = 0;
  if (attrs) Object.assign(s.attrs[slot]!, attrs);
}

const SOL = createLaunchSolution();

/**
 * Launch a cross by `crosser` from (fromX, fromZ) that would first land at (toX, toZ) at launch angle `angle`
 * (lastTouch / lastKick / passTarget bookkeeping as a kick would leave it). Returns the launch speed.
 */
export function launchCross(
  s: SimState, crosser: number, fromX: number, fromZ: number, toX: number, toZ: number, angle: number, target = -1,
): number {
  const b = s.ball;
  const p = s.players[crosser]!;
  p.x = fromX - 0.8; p.z = fromZ; p.vx = 0; p.vz = 0;
  const v = solveLaunchSpin(toX - fromX, toZ - fromZ, angle, BALL_RADIUS, 0, 0, SOL);
  b.x = fromX; b.y = BALL_RADIUS; b.z = fromZ; b.px = fromX; b.py = BALL_RADIUS; b.pz = fromZ;
  b.vx = SOL.vx; b.vy = SOL.vy; b.vz = SOL.vz; b.sx = 0; b.sy = 0; b.sz = 0;
  b.grounded = 0; b.bounces = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0;
  b.lastTouch = crosser; b.lastTouchTeam = p.team; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
  b.lastKickBy = crosser; b.lastKickTeam = p.team; b.lastKickKind = KickKind.CROSS; b.lastKickTick = s.tick;
  b.passTarget = target; b.passX = toX; b.passZ = toZ; b.shotBy = -1;
  p.lastTouchTick = s.tick;
  return v;
}

/** Input script: P1 holds `button` for `hold` ticks from the first tick the slot has an aerial chance. */
export function pressOnChance(slot: number, button: number = Btn.SHOOT, hold = 20, stick?: { mx: number; mz: number }) {
  let start = -1;
  return (tick: number, st: SimState, out: { buttons: number; mx: number; mz: number }[]): void => {
    if (start < 0 && aerialChance(st, slot) > 0) start = tick;
    if (start >= 0 && tick - start < hold) out[0]!.buttons = button;
    if (stick) { out[0]!.mx = stick.mx; out[0]!.mz = stick.mz; }
  };
}

const PROBE = createBallState();

export interface Arrival {
  /** The free ball got to the goal line of `end` within the horizon (crossed it, or hit the post / bar there). */
  reached: boolean;
  /** Crossed the goal line inside the mouth (centre inside the posts and under the bar). */
  inMouth: boolean;
  /** Ball speed (3D) on arrival at the goal line (just before it), m/s. */
  speed: number;
  ticks: number;
}

/** Fly a copy of `b` freely (sim physics, goal frame included) to the goal line at x = end * 52.5. */
export function arrivalAtGoal(b: Readonly<BallState>, end: number, horizon = 240): Arrival {
  copyBallState(PROBE, b);
  const near = HALF_LENGTH - 0.6;
  let speed = -1;
  for (let k = 1; k <= horizon; k++) {
    const px = PROBE.x, py = PROBE.y, pz = PROBE.z;
    const sp0 = Math.sqrt(PROBE.vx * PROBE.vx + PROBE.vy * PROBE.vy + PROBE.vz * PROBE.vz);
    ballStepTick(PROBE, null);
    const u0 = end * px, u1 = end * PROBE.x;
    // Arrival speed: as it comes within 0.6 m of the line (before any post / bar / net contact there).
    if (speed < 0 && u1 >= near) speed = sp0;
    if (u0 < HALF_LENGTH && u1 >= HALF_LENGTH) {
      const f = (HALF_LENGTH - u0) / (u1 - u0);
      const z = pz + (PROBE.z - pz) * f;
      const y = py + (PROBE.y - py) * f;
      return { reached: true, inMouth: Math.abs(z) < GOAL_HALF_WIDTH && y < GOAL_HEIGHT, speed, ticks: k };
    }
    // Off the post or the bar: it got there, but bounced back out.
    if (u0 >= near && u1 < u0 && PROBE.inNet === 0) return { reached: true, inMouth: false, speed, ticks: k };
  }
  return { reached: false, inMouth: false, speed: 0, ticks: horizon };
}

export interface AerialRun {
  events: SimEvent[];
  aerials: SimEvent[];
  /** Ball state right after the first aerial contact (null if none). */
  after: BallState | null;
  /** Launch speed of the first aerial contact. */
  launchSpeed: number;
  /** Tick of the first aerial contact. */
  contactTick: number;
}

/** Run the real pipeline n ticks, capturing the ball right after the first AERIAL contact. */
export function runAerial(s: SimState, n: number, inputs?: Parameters<typeof runTicks>[2]): AerialRun {
  let after: BallState | null = null;
  let contactTick = -1;
  const events = runTicks(s, n, inputs, {
    until: (st, ev) => {
      if (after === null && ev.some((e) => e.type === EventType.AERIAL)) {
        after = createBallState();
        copyBallState(after, st.ball);
        contactTick = st.tick;
      }
      return false;
    },
  });
  const aerials = events.filter((e) => e.type === EventType.AERIAL);
  const a = after as BallState | null;
  const launchSpeed = a ? Math.sqrt(a.vx * a.vx + a.vy * a.vy + a.vz * a.vz) : 0;
  return { events, aerials, after: a, launchSpeed, contactTick };
}
