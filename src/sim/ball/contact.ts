/**
 * [SIM-02] Ball contact: ground bounce (restitution + spin friction), rolling resistance, posts and crossbar
 * as rigid cylinders, the net as a soft volume that absorbs and holds the ball, side netting / roof deflect
 * from outside, advertising boards. Swept / sub-stepped so nothing tunnels at 36 m/s.
 * Calls SIM-03 detectCrossing for every substep segment. Emits BOUNCE, POST, NET.
 * When s.ball.heldBy >= 0 the ball is carried in a keeper's hands (GKP-05 positions it): skip integration.
 * WAVE 0 BASELINE: simple air step + ground bounce + rolling friction, no frame collisions.
 */
import { BALL_RADIUS, DT } from '../../contracts/constants';
import type { EventSink } from '../../contracts/events';
import { T_BALL } from '../../contracts/tuning';
import type { BallState, SimState } from '../../contracts/state';
import { ballAirStep } from './flight';

/**
 * One pure physics substep of dt seconds for a ball (air or ground, bounce, roll, goal frame, net, boards).
 * ev may be null (prediction). Must be deterministic and allocation-free.
 */
export function ballPhysicsStep(b: BallState, dt: number, ev: EventSink | null): void {
  if (b.y > BALL_RADIUS + 1e-6 || b.vy > 0) {
    ballAirStep(b, dt);
    if (b.y < BALL_RADIUS) {
      b.y = BALL_RADIUS;
      b.vy = -b.vy * T_BALL.restitution;
      if (b.vy < T_BALL.rollThresholdVy) { b.vy = 0; b.grounded = 1; }
    }
  } else {
    b.y = BALL_RADIUS; b.vy = 0; b.grounded = 1;
    const sp = Math.sqrt(b.vx * b.vx + b.vz * b.vz);
    if (sp > 0) {
      const ns = Math.max(0, sp - T_BALL.rollDecel * dt);
      b.vx *= ns / sp; b.vz *= ns / sp;
    }
    b.x += b.vx * dt; b.z += b.vz * dt;
  }
}

/** Per-tick ball update: records px/py/pz, substeps, crossing detection, events. */
export function ballTick(s: SimState, ev: EventSink): void {
  const b = s.ball;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  if (b.heldBy >= 0) return;
  ballPhysicsStep(b, DT, ev);
}
