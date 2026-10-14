/**
 * GKP-06 test fake for SIM-11 (kicks/shot.ts, still a Wave 1 stub when GKP-06 was built): startShot begins a real
 * SHOT action (wind-up, contact at SHOT.windup, recovery) through its documented contract, and the SHOT handler
 * strikes at contact (actT >= actContact, not charging, not done) through core/kick applyKick, so a penalty strikes
 * inside the actions stage exactly like a real shot would. Imports contracts only (loaded from inside vi.mock
 * factories, before the sim modules); applyKick is injected by the test file (SHOT.applyKick = applyKick).
 *
 * SIM-11 is implemented now; the fake stays so the save / goal tests can place a penalty exactly (no kicking error).
 *
 * Usage: vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./gkp-06-fakes')).mockShot(await o()));
 */
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT } from '../../src/contracts/constants';
import type { EventSink } from '../../src/contracts/events';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { createKickLaunch, type ActionHandler, type ActionRequest, type KickLaunch } from '../../src/contracts/systems';
import { T_BALL } from '../../src/contracts/tuning';

type ApplyKick = (s: SimState, slot: number, l: KickLaunch, power: number, ev: EventSink) => void;

export const SHOT = {
  /** Wind-up ticks (contact tick relative to the start) and recovery ticks. */
  windup: 10,
  recovery: 14,
  /** 1: aim at the request's target point (RUL-07 / CPU kicks); 0: at (tx, tz). Height at the goal line ty, speed m/s. */
  useReq: 1,
  tx: 0,
  ty: 1.0,
  tz: 0,
  speed: 22,
  /** Refuse every start (safety-net tests). */
  refuse: false,
  /** Honour req.charging (power bar held: the resolver releases it). */
  charging: true,
  calls: 0,
  strikes: [] as { tick: number; slot: number; tz: number; ty: number }[],
  applyKick: null as ApplyKick | null,
};

export function resetShot(): void {
  SHOT.windup = 10;
  SHOT.recovery = 14;
  SHOT.useReq = 1;
  SHOT.tx = 0;
  SHOT.ty = 1.0;
  SHOT.tz = 0;
  SHOT.speed = 22;
  SHOT.refuse = false;
  SHOT.charging = true;
  SHOT.calls = 0;
  SHOT.strikes.length = 0;
}

export function fakeStartShot(s: SimState, slot: number, kind: number, req: ActionRequest, _ev: EventSink): number {
  SHOT.calls++;
  if (SHOT.refuse) return 0;
  const p = s.players[slot]!;
  if (p.active !== 1 || p.act !== ActionKind.NONE || p.stunT > 0) return 0;
  p.act = ActionKind.SHOT;
  p.actT = 0;
  p.actDur = SHOT.windup + SHOT.recovery;
  p.actContact = SHOT.windup;
  p.actDone = 0;
  p.actCharging = SHOT.charging && req.charging === 1 ? 1 : 0;
  p.actKick = kind as KickKind;
  p.actPower = req.charging === 1 ? 0.6 : req.power;
  const useReq = SHOT.useReq === 1 && req.hasTarget === 1;
  p.actX = useReq ? req.targetX : SHOT.tx;
  p.actZ = useReq ? req.targetZ : SHOT.tz;
  p.moveMode = MoveMode.LOCKED;
  return 1;
}

export const fakeShotHandler: ActionHandler = {
  update(s, slot, ev) {
    const p = s.players[slot]!;
    if (p.actDone === 1 || p.actCharging === 1 || p.actT < p.actContact) return;
    p.actDone = 1;
    const b = s.ball;
    const tx = p.actX, tz = p.actZ, ty = SHOT.ty;
    const dx = tx - b.x, dz = tz - b.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (!(d > 1e-6)) return;
    const v = SHOT.speed;
    const tf = d / v;
    const l = createKickLaunch();
    l.vx = (dx / d) * v;
    l.vz = (dz / d) * v;
    l.vy = (ty - b.y) / tf + 0.5 * T_BALL.gravity * tf;
    l.kind = p.actKick === KickKind.NONE ? KickKind.PENALTY : p.actKick;
    l.target = -1;
    l.tx = tx;
    l.tz = tz;
    l.onTarget = tz > -GOAL_HALF_WIDTH && tz < GOAL_HALF_WIDTH && ty < GOAL_HEIGHT ? 1 : 0;
    SHOT.strikes.push({ tick: s.tick, slot, tz, ty });
    SHOT.applyKick!(s, slot, l, p.actPower, ev);
  },
  end(s, slot) {
    const p = s.players[slot]!;
    if (p.moveMode === MoveMode.LOCKED) p.moveMode = MoveMode.STOP;
  },
};

/**
 * kicks/shot.ts re-exports the import-cycle-safe shell of its SHOT handler (kicks/shotHooks.ts); actions/registry may
 * have bound that shell object while the original module was evaluated (the cycle shot -> dispatch -> registry ->
 * shot), so replacing the export alone would not reach the registry. The shell's methods are patched in place
 * instead: every holder of the shell (registry included) then runs the fake. Per test file (vitest isolates files).
 */
export function mockShot(o: Record<string, unknown>): Record<string, unknown> {
  const shell = o.shotHandler as { update: ActionHandler['update']; end: ActionHandler['end'] } | undefined;
  if (shell) {
    shell.update = fakeShotHandler.update;
    shell.end = fakeShotHandler.end;
  }
  return { ...o, startShot: fakeStartShot, shotHandler: shell ?? fakeShotHandler };
}
