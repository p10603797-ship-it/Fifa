/**
 * PAD-03: every row of BRIEF section 10 "Defending" and "Goalkeeper with the ball", end to end: mock Standard Gamepad
 * states -> PAD-01 manager -> PAD-02 mapper (two animation frames per tick) -> InputFrame -> the real step() pipeline
 * (SIM-15 resolver, SIM-16 switching, SIM-14 tackles, GKP-03 keeper rush, GKP-05 handling / distribution). Each test is
 * named after its row.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { LT } from '../../src/sim/control/resolveShared';
import { all, holdDuring, padMatch, PadButton as PB, scene, tapAt, type PadMatch, type PadScript } from './pad-02-helpers';

/** Standard positions by their PlayStation names (section 10 tables). */
const PadButton = { ...PB, CROSS: PB.SOUTH, CIRCLE: PB.EAST, SQUARE: PB.WEST, TRIANGLE: PB.NORTH } as const;

/** P1's defender (team 0 attacks +x, so his own goal is at x = -52.5) and the opposing carrier. */
const D = 4;
const CARRIER = 19;
const GK = 0;

/** Opponent carrier at (cx, cz) with the ball, moving (vx, vz); P1's defender at (dx, dz). */
function defScene(o: { dx?: number; dz?: number; cx?: number; cz?: number; vx?: number; vz?: number; pvx?: number; pvz?: number } = {}): SimState {
  const s = scene({ slot: D, x: o.dx ?? -24, z: o.dz ?? 0, vx: o.pvx ?? 0, vz: o.pvz ?? 0, ball: 'none' });
  const q = s.players[CARRIER]!;
  q.x = o.cx ?? -22.5; q.z = o.cz ?? 0; q.vx = o.vx ?? 0; q.vz = o.vz ?? 0; q.fx = -1; q.fz = 0;
  const b = s.ball;
  b.x = q.x - 0.5; b.z = q.z; b.px = b.x; b.pz = b.z; b.y = 0.11; b.py = b.y; b.vx = q.vx; b.vy = 0; b.vz = q.vz; b.grounded = 1;
  b.owner = CARRIER; b.heldBy = -1; b.lastTouch = CARRIER; b.lastTouchTeam = 1; b.lastTouchTick = 0; b.passTarget = -1; b.shotBy = -1;
  return s;
}

/** Keep the carrier standing still (his AI would run off with the ball): re-park him before each tick. */
function pinCarrier(s: SimState): PadScript {
  const q = s.players[CARRIER]!;
  const x = q.x, z = q.z;
  return (_t, sub) => {
    if (sub !== 0 || s.ball.owner !== CARRIER) return;
    q.x = x; q.z = z; q.vx = 0; q.vz = 0;
    s.ball.x = x - 0.5; s.ball.z = z; s.ball.vx = 0; s.ball.vz = 0;
  };
}

function actsOf(m: PadMatch, slot: number, n: number, script: PadScript): ActionKind[] {
  const seen: ActionKind[] = [];
  m.run(n, script, (st) => { const a = st.players[slot]!.act; if (seen[seen.length - 1] !== a) seen.push(a); });
  return seen;
}

describe('PAD-03 §10 Defending', () => {
  it('Change player: L1 switches P1 to another defender', () => {
    const s = defScene({ dx: -40, dz: 20 }); // P1 is far away: someone else is better placed
    const m = padMatch(s);
    m.run(6, tapAt(PadButton.L1, 3));
    expect(m.frames.some((f) => (f.buttons & Btn.MOD_L) !== 0)).toBe(true);
    expect(s.ctrl[0]!.slot).not.toBe(D);
    expect(s.players[s.ctrl[0]!.slot]!.team).toBe(0);
    expect(s.players[s.ctrl[0]!.slot]!.isKeeper).toBe(0);
  });

  it('Change player (directional): a right-stick flick switches to the teammate that way', () => {
    const s = defScene({ dx: -30, dz: 0 });
    const m = padMatch(s);
    // Flick down (screen) = +z on the broadcast camera: the teammates parked at z > 0.
    m.run(10, (tick, sub, r) => {
      if (tick === 3 && sub === 0) r.right(0, 1);
      if (tick === 4 && sub === 1) r.right(0, 0);
    });
    expect(m.frames.some((f) => (f.buttons & Btn.RS_FLICK) !== 0 && f.az > 0)).toBe(true);
    const now = s.ctrl[0]!.slot;
    expect(now).not.toBe(D);
    expect(s.players[now]!.z).toBeGreaterThan(s.players[D]!.z);
  });

  it('Tackle: Circle goal-side of the carrier is a standing tackle', () => {
    const s = defScene({ dx: -24, cx: -22.6 });
    const m = padMatch(s);
    expect(actsOf(m, D, 10, all(pinCarrier(s), tapAt(PadButton.CIRCLE, 3)))).toContain(ActionKind.STAND_TACKLE);
  });

  it('Push or pull when chasing: Circle from behind the carrier', () => {
    const s = defScene({ dx: -21.2, cx: -22.6 }); // behind him (he runs toward x = -52.5)
    const m = padMatch(s);
    expect(actsOf(m, D, 10, all(pinCarrier(s), tapAt(PadButton.CIRCLE, 3)))).toContain(ActionKind.PUSH_PULL);
  });

  it('Shoulder challenge: Circle running alongside the carrier', () => {
    const v = LT.shoulderMinSpeed + 3;
    const s = defScene({ dx: -22.6, dz: 1.1, cx: -22.6, cz: 0, vx: -v, pvx: -v });
    const m = padMatch(s);
    m.run(1, (_t, sub, r) => { if (sub === 0) r.left(-1, 0); });
    const acts = actsOf(m, D, 4, all((_t, sub, r) => { if (sub === 0) r.left(-1, 0); }, tapAt(PadButton.CIRCLE, s.tick + 1)));
    expect(acts).toContain(ActionKind.SHOULDER);
  });

  it('Clearance (by context): Circle with a loose ball arriving in his own third clears it', () => {
    const s = scene({ slot: D, x: -40, z: 0, ball: 'none' });
    const b = s.ball;
    b.x = -37; b.z = 0; b.px = b.x; b.pz = b.z; b.y = 0.11; b.vx = -6; b.vy = 0; b.vz = 0; b.grounded = 1;
    b.owner = -1; b.heldBy = -1; b.lastTouch = CARRIER; b.lastTouchTeam = 1;
    const m = padMatch(s);
    m.run(50, holdDuring(PadButton.CIRCLE, 2, 4));
    expect(m.events.some((e) => e.type === EventType.KICK && e.a === D)).toBe(true);
    expect(s.ball.lastKickKind).toBe(KickKind.CLEARANCE);
    expect(s.ball.vx).toBeGreaterThan(5); // away from his own goal
  });

  it('Hard tackle: R1 + Circle', () => {
    const s = defScene({ dx: -24, cx: -22.6 });
    const m = padMatch(s);
    expect(actsOf(m, D, 10, all(pinCarrier(s), holdDuring(PadButton.R1, 2, 6), tapAt(PadButton.CIRCLE, 3)))).toContain(ActionKind.HARD_TACKLE);
  });

  it('Slide tackle: Square', () => {
    const s = defScene({ dx: -25, cx: -22.6 });
    const m = padMatch(s);
    expect(actsOf(m, D, 10, all(pinCarrier(s), tapAt(PadButton.SQUARE, 3)))).toContain(ActionKind.SLIDE_TACKLE);
  });

  it('Quick get-up after a slide: Square again ends the slide sooner', () => {
    const slideTicks = (quick: boolean): number => {
      const s = defScene({ dx: -30, cx: -22.6 }); // a slide into space (no contact)
      const m = padMatch(s);
      let n = 0;
      const script = all(pinCarrier(s), tapAt(PadButton.SQUARE, 3), quick ? tapAt(PadButton.SQUARE, 16) : () => {});
      m.run(120, script, (st) => { if (st.players[D]!.act === ActionKind.SLIDE_TACKLE) n++; });
      return n;
    };
    const normal = slideTicks(false);
    expect(normal).toBeGreaterThan(0);
    expect(slideTicks(true)).toBeLessThan(normal);
  });

  it('Contain: Cross (hold) shadows the carrier goal-side, facing him', () => {
    const s = defScene({ dx: -27, dz: 3, cx: -20 });
    const m = padMatch(s);
    m.run(8, all(pinCarrier(s), holdDuring(PadButton.CROSS, 2, 99)));
    const p = s.players[D]!;
    expect(m.frames.at(-1)!.buttons & Btn.PASS).toBe(Btn.PASS);
    expect(p.moveMode).toBe(MoveMode.ARRIVE);
    expect(p.tgtX).toBeLessThan(s.players[CARRIER]!.x); // goal-side (own goal at -x)
    expect(Math.hypot(p.tgtX - s.players[CARRIER]!.x, p.tgtZ - s.players[CARRIER]!.z)).toBeCloseTo(LT.containDist, 1);
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBeCloseTo(s.players[CARRIER]!.x, 2);
    expect(p.lookZ).toBeCloseTo(s.players[CARRIER]!.z, 2);
  });

  it('Teammate contain (second defender): R1 (hold) sends the best teammate at the carrier; release calls him off', () => {
    const s = defScene({ dx: -30, cx: -20 });
    const m = padMatch(s);
    m.run(10, all(pinCarrier(s), holdDuring(PadButton.R1, 2, 99)));
    const helper = s.ctrl[0]!.secondDef;
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(helper).not.toBe(D);
    expect(s.players[helper]!.team).toBe(0);
    expect(s.players[helper]!.isKeeper).toBe(0);
    const d0 = Math.hypot(s.players[helper]!.x - s.players[CARRIER]!.x, s.players[helper]!.z - s.players[CARRIER]!.z);
    m.run(40, all(pinCarrier(s), holdDuring(PadButton.R1, 0, 99)));
    const d1 = Math.hypot(s.players[helper]!.x - s.players[CARRIER]!.x, s.players[helper]!.z - s.players[CARRIER]!.z);
    expect(d1).toBeLessThan(d0 - 1);
    m.run(LT.secondDefTapTicks + 4, (tick, sub, r) => { if (sub === 0) r.release(PadButton.R1); });
    expect(s.ctrl[0]!.secondDef).toBe(-1);
  });

  it('Jockey: L2 (hold) keeps facing the carrier without sprinting', () => {
    const s = defScene({ dx: -27, dz: 2, cx: -20 });
    const m = padMatch(s);
    m.run(6, all(pinCarrier(s), holdDuring(PadButton.L2, 2, 99), (_t, sub, r) => { if (sub === 0) r.left(0, 1); }));
    const p = s.players[D]!;
    expect(m.frames.at(-1)!.buttons & Btn.SHIELD).toBe(Btn.SHIELD);
    expect(p.lookAt).toBe(1);
    expect(p.lookX).toBeCloseTo(s.players[CARRIER]!.x, 2);
    expect(p.lookZ).toBeCloseTo(s.players[CARRIER]!.z, 2);
    expect(p.wantSprint).toBe(0);
    expect(p.moveMode).toBe(MoveMode.DIRECT);
  });

  it('Sprint jockey: L2 + R2 jockeys at sprint', () => {
    const s = defScene({ dx: -32, dz: 2, cx: -20 });
    const m = padMatch(s);
    m.run(6, all(pinCarrier(s), holdDuring(PadButton.L2, 2, 99), holdDuring(PadButton.R2, 2, 99), (_t, sub, r) => { if (sub === 0) r.left(1, 0); }));
    const p = s.players[D]!;
    expect(m.frames.at(-1)!.buttons & (Btn.SHIELD | Btn.SPRINT)).toBe(Btn.SHIELD | Btn.SPRINT);
    expect(p.lookAt).toBe(1);
    expect(p.wantSprint).toBe(1);
  });

  it('Rush the keeper out: Triangle (hold)', () => {
    const s = defScene({ dx: -30, cx: -36 });
    const m = padMatch(s);
    const acts = actsOf(m, GK, 10, all(pinCarrier(s), holdDuring(PadButton.TRIANGLE, 2, 99)));
    expect(acts).toContain(ActionKind.GK_RUSH);
  });
});

// ====================================================================== Goalkeeper with the ball

/** P1 controls his keeper holding the ball in his area (GKP-05 pick-up from his feet). */
function keeperScene(): SimState {
  const s = scene({ slot: GK, x: -47, z: 0, ball: 'feet' });
  s.players[GK]!.fx = 1;
  // A teammate to throw to and space ahead.
  const t = s.players[5]!;
  t.x = -30; t.z = 8;
  s.ball.lastTouch = 15; s.ball.lastTouchTeam = 1; // not a back-pass
  return s;
}

function pickUp(m: PadMatch): void {
  m.run(6, tapAt(PadButton.R1, 2));
  expect(m.s.ball.heldBy).toBe(GK);
  expect(m.s.players[GK]!.act).toBe(ActionKind.GK_HOLD);
}

/** Kick kind the keeper released with: actKick of his GK_THROW / GK_KICK action, then the ball's lastKickKind. */
function released(m: PadMatch, script: PadScript, n = 60): { act: ActionKind; kind: KickKind; ball: KickKind } {
  let act = ActionKind.NONE as ActionKind;
  let kind = KickKind.NONE as KickKind;
  m.run(n, script, (st) => {
    const p = st.players[GK]!;
    if (act === ActionKind.NONE && (p.act === ActionKind.GK_THROW || p.act === ActionKind.GK_KICK)) { act = p.act; kind = p.actKick; }
  });
  return { act, kind, ball: m.s.ball.lastKickKind };
}

describe('PAD-03 §10 Goalkeeper with the ball', () => {
  it('Pick up the ball: R1 takes it into his hands', () => {
    const m = padMatch(keeperScene());
    expect(m.s.ball.heldBy).toBe(-1);
    pickUp(m);
    expect(m.s.ball.owner).toBe(GK);
  });

  it('Throw or pass: Cross', () => {
    const m = padMatch(keeperScene());
    pickUp(m);
    const r = released(m, tapAt(PadButton.CROSS, m.s.tick + 2));
    expect(r.act).toBe(ActionKind.GK_THROW);
    expect([KickKind.GK_THROW, KickKind.GK_ROLL]).toContain(r.kind);
    expect(m.s.ball.heldBy).toBe(-1);
  });

  it('Driven throw: R1 + Cross', () => {
    const m = padMatch(keeperScene());
    pickUp(m);
    const t = m.s.tick;
    const r = released(m, all(holdDuring(PadButton.R1, t + 2, t + 6), tapAt(PadButton.CROSS, t + 3)));
    expect(r.act).toBe(ActionKind.GK_THROW);
    expect(r.kind).toBe(KickKind.GK_DRIVEN_THROW);
  });

  it('Drop kick: Circle or Square', () => {
    for (const b of [PadButton.CIRCLE, PadButton.SQUARE]) {
      const m = padMatch(keeperScene());
      pickUp(m);
      const r = released(m, tapAt(b, m.s.tick + 2));
      expect(r.act).toBe(ActionKind.GK_KICK);
      expect(r.kind).toBe(KickKind.GK_DROP_KICK);
      expect(m.s.ball.heldBy).toBe(-1);
    }
  });

  it('Driven kick: R1 + Square', () => {
    const m = padMatch(keeperScene());
    pickUp(m);
    const t = m.s.tick;
    const r = released(m, all(holdDuring(PadButton.R1, t + 2, t + 6), tapAt(PadButton.SQUARE, t + 3)));
    expect(r.act).toBe(ActionKind.GK_KICK);
    expect(r.kind).toBe(KickKind.GK_DRIVEN_KICK);
  });

  it('Drop the ball: Triangle puts it at his feet', () => {
    const m = padMatch(keeperScene());
    pickUp(m);
    const r = released(m, tapAt(PadButton.TRIANGLE, m.s.tick + 2), 40);
    expect(r.kind).toBe(KickKind.GK_RELEASE);
    expect(m.s.ball.heldBy).toBe(-1);
    expect(Math.hypot(m.s.ball.x - m.s.players[GK]!.x, m.s.ball.z - m.s.players[GK]!.z)).toBeLessThan(3);
  });

  it('CPU brains are off and P1 drives the keeper (scene sanity)', () => {
    const s = keeperScene();
    expect(s.ctrl[0]!.slot).toBe(GK);
    expect(s.ctrl[2]!.kind).toBe(ControllerKind.NONE);
    expect(s.match.phase).toBe(MatchPhase.IN_PLAY);
  });
});
