/**
 * PAD-06: every set-piece row of BRIEF section 10 "Tactics, set pieces and menus", end to end: a restart awarded through
 * RUL-11 (tests/controls/pad-06-helpers.ts), mock Standard Gamepad states -> PAD-01 manager -> PAD-02 mapper (PAD-04
 * D-pad sequences, PAD-05 right stick) -> InputFrame -> the real step() pipeline (SIM-15 routes set-piece frames to
 * RUL-05 free kicks + walls, RUL-04 corners, RUL-02 throw-ins, RUL-06 penalties; GKP-06 keeper; SIM-08..11 kicks).
 * Each test is named after its row; the outcome is read from the sim (restart aim / reticle / wall state, the action
 * started, the KickKind the ball was launched with, the keeper's dive choice).
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, Command, KickKind, RestartKind } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { WallMode } from '../../src/sim/rules/freekick';
import { ThrowFlag } from '../../src/sim/rules/throwin';
import { all, holdDuring, padMatch, tapAt, type PadMatch, type PadScript } from './pad-02-helpers';
import { firstKick, PadButton, setPieceScene, wallEvents } from './pad-06-helpers';

const FK = (o: { humanSide?: number } = {}): SimState => setPieceScene(RestartKind.FREE_KICK, 0, 28.5, -6, o);
const CORNER = (): SimState => setPieceScene(RestartKind.CORNER, 0, HALF_LENGTH, 34);
const THROW = (): SimState => setPieceScene(RestartKind.THROW_IN, 0, 10, 34);
const PEN = (o: { humanSide?: number } = {}): SimState => setPieceScene(RestartKind.PENALTY, 0, 0, 0, o);

/** Hold the left / right stick (screen space) from tick `from` for `n` ticks, then centre it. */
function leftHold(from: number, n: number, x: number, y: number): PadScript {
  return (tick, sub, r) => {
    if (sub !== 0) return;
    if (tick === from) r.left(x, y);
    if (tick === from + n) r.left(0, 0);
  };
}
function rightHold(from: number, n: number, x: number, y: number): PadScript {
  return (tick, sub, r) => {
    if (sub !== 0) return;
    if (tick === from) r.right(x, y);
    if (tick === from + n) r.right(0, 0);
  };
}

/** Run until the first KICK event (at most n ticks); returns its KickKind and the kicker. */
function kickOf(m: PadMatch, script: PadScript, n = 90): { kind: KickKind; slot: number } {
  for (let i = 0; i < n && !firstKick(m); i++) m.run(1, script);
  const k = firstKick(m);
  expect(k, 'no kick was launched').not.toBeNull();
  return { kind: k!.b as KickKind, slot: k!.a };
}

/** Table rows that end in a kick: [row name, scene, script built from the first tick, expected KickKind(s)]. */
type KickRow = [string, () => SimState, (t0: number) => PadScript, KickKind | readonly KickKind[]];

const KICK_ROWS: KickRow[] = [
  ['Free kick: shoot (Circle)', FK, (t) => tapAt(PadButton.CIRCLE, t + 2), KickKind.FREE_KICK_SHOT],
  ['Free kick: finesse (R1 + Circle)', FK, (t) => all(holdDuring(PadButton.R1, t + 1, t + 6), tapAt(PadButton.CIRCLE, t + 2)), KickKind.SHOT_FINESSE],
  ['Free kick: chip (L1 + Circle)', FK, (t) => all(holdDuring(PadButton.L1, t + 1, t + 6), tapAt(PadButton.CIRCLE, t + 2)), KickKind.SHOT_CHIP],
  ['Free kick: ground pass (Cross)', FK, (t) => tapAt(PadButton.CROSS, t + 2), KickKind.GROUND_PASS],
  ['Free kick: lob or cross (Square)', FK, (t) => tapAt(PadButton.SQUARE, t + 2), [KickKind.CROSS, KickKind.LOB_PASS]],
  ['Corner: lob cross (Square)', CORNER, (t) => tapAt(PadButton.SQUARE, t + 2), KickKind.CROSS],
  ['Corner: short pass (Cross)', CORNER, (t) => tapAt(PadButton.CROSS, t + 2), KickKind.GROUND_PASS],
  ['Penalty: shoot (Circle)', PEN, (t) => tapAt(PadButton.CIRCLE, t + 2), KickKind.PENALTY],
  ['Penalty: finesse (R1 + Circle)', PEN, (t) => all(holdDuring(PadButton.R1, t + 1, t + 6), tapAt(PadButton.CIRCLE, t + 2)), KickKind.SHOT_FINESSE],
  ['Penalty: chip (L1 + Circle)', PEN, (t) => all(holdDuring(PadButton.L1, t + 1, t + 6), tapAt(PadButton.CIRCLE, t + 2)), KickKind.SHOT_CHIP],
];

describe('PAD-06 §10 set pieces: rows that launch the ball', () => {
  for (const [name, mk, script, want] of KICK_ROWS) {
    it(name, () => {
      const s = mk();
      const taker = s.match.restart.taker;
      expect(s.ctrl[0]!.slot).toBe(taker);
      const m = padMatch(s);
      const k = kickOf(m, script(s.tick));
      expect(k.slot).toBe(taker);
      if (Array.isArray(want)) expect(want).toContain(k.kind);
      else expect(k.kind).toBe(want);
      expect(s.match.restart.taken).toBe(1);
    });
  }
});

describe('PAD-06 §10 Free kick', () => {
  it('Free kick: aim (left stick) moves the aim; at rest it keeps it', () => {
    const s = FK();
    expect(s.match.restart.aimZ).toBe(0); // goal centre with a wall
    const m = padMatch(s);
    // From (28.5, -6) a ray along (1, 0.15) meets the goal line at z ~ -2.4: inside the posts.
    m.run(12, leftHold(s.tick + 2, 6, 1, 0.15));
    expect(s.match.restart.aimX).toBeCloseTo(HALF_LENGTH, 1);
    expect(s.match.restart.aimZ).toBeLessThan(-1);
    const z = s.match.restart.aimZ;
    m.run(10);
    expect(s.match.restart.aimZ).toBe(z);
    expect(s.match.restart.taken).toBe(0);
  });

  it('Free kick: add curl or dip (right stick): across the aim curls, along it dips', () => {
    const s = FK();
    const m = padMatch(s);
    // Unit vector of the aim (ball -> aim point), screen space = pitch (x, z) on the broadcast camera.
    const r = s.match.restart;
    const ax = r.aimX - s.ball.x, az = r.aimZ - s.ball.z;
    const al = Math.hypot(ax, az);
    const ux = ax / al, uz = az / al;
    const curl0 = r.aimCurve;
    m.run(20, rightHold(s.tick + 2, 12, -uz, ux)); // across the aim
    expect(s.match.restart.aimCurve).not.toBe(curl0);
    const curl1 = s.match.restart.aimCurve;
    const dip0 = s.match.restart.side;
    m.run(20, rightHold(s.tick + 2, 12, ux, uz)); // along the aim
    expect(s.match.restart.side).not.toBe(dip0);
    expect(s.match.restart.aimCurve).toBeCloseTo(curl1, 2); // stick quantisation leaves a trace across the aim
    expect(Math.abs(s.match.restart.side - dip0)).toBeGreaterThan(50 * Math.abs(s.match.restart.aimCurve - curl1));
    expect(s.match.restart.taken).toBe(0);
  });

  it('Free kick: choose the taker (R2) swaps in the next taker and hands him the controller', () => {
    const s = FK();
    const t0 = s.match.restart.taker;
    const m = padMatch(s);
    m.run(10, tapAt(PadButton.R2, s.tick + 2));
    expect(m.frames.some((f) => (f.buttons & Btn.SPRINT) !== 0)).toBe(true);
    expect(s.match.restart.taker).not.toBe(t0);
    m.run(4);
    expect(s.ctrl[0]!.slot).toBe(s.match.restart.taker);
    expect(s.match.restart.taken).toBe(0);
  });
});

describe('PAD-06 §10 Defending a free kick', () => {
  function defending(): SimState {
    const s = FK({ humanSide: 1 });
    expect(s.match.restart.wallCount).toBeGreaterThanOrEqual(2);
    expect(s.ctrl[0]!.side).toBe(1);
    return s;
  }

  it('Defending a free kick: wall jump (Triangle)', () => {
    const s = defending();
    const m = padMatch(s);
    m.run(4, tapAt(PadButton.TRIANGLE, s.tick + 2));
    const r = s.match.restart;
    expect(wallEvents(m).length).toBe(r.wallCount);
    for (let i = 0; i < r.wallCount; i++) {
      const p = s.players[r.wall[i]!]!;
      expect(p.act).toBe(ActionKind.WALL_JUMP);
      expect(p.actA).toBe(WallMode.JUMP);
    }
  });

  it('Defending a free kick: wall charge (Cross) arms the wall to charge at the kick', () => {
    const s = defending();
    const m = padMatch(s);
    m.run(4, tapAt(PadButton.CROSS, s.tick + 2));
    const r = s.match.restart;
    for (let i = 0; i < r.wallCount; i++) {
      const p = s.players[r.wall[i]!]!;
      expect(p.act).toBe(ActionKind.WALL_JUMP);
      expect(p.actA).toBe(WallMode.ARMED);
    }
  });

  it('Defending a free kick: move wall (L2 or R2) slides it sideways, opposite ways', () => {
    const shift = (b: number): [number, number] => {
      const s = defending();
      const x0 = s.match.restart.wallX, z0 = s.match.restart.wallZ;
      const m = padMatch(s);
      m.run(30, holdDuring(b, s.tick + 2, 9999));
      expect(s.match.restart.taken).toBe(0);
      return [s.match.restart.wallX - x0, s.match.restart.wallZ - z0];
    };
    const l = shift(PadButton.L2);
    const r = shift(PadButton.R2);
    expect(Math.hypot(l[0], l[1])).toBeGreaterThan(0.3);
    expect(Math.hypot(r[0], r[1])).toBeGreaterThan(0.3);
    expect(l[0] * r[0] + l[1] * r[1]).toBeLessThan(0);
  });
});

describe('PAD-06 §10 Corner', () => {
  it('Corner: aim (left stick) moves the reticle', () => {
    const s = CORNER();
    const x0 = s.match.restart.aimX, z0 = s.match.restart.aimZ;
    const m = padMatch(s);
    m.run(12, leftHold(s.tick + 2, 8, -1, 0));
    expect(s.match.restart.aimX).toBeLessThan(x0 - 0.5);
    expect(Math.abs(s.match.restart.aimZ - z0)).toBeLessThan(0.5);
    expect(s.match.restart.taken).toBe(0);
  });

  it('Corner: target reticle (right stick) moves it too, faster', () => {
    const left = CORNER();
    const right = CORNER();
    const zl0 = left.match.restart.aimZ, zr0 = right.match.restart.aimZ;
    padMatch(left).run(8, leftHold(left.tick + 2, 4, 0, -1));
    padMatch(right).run(8, rightHold(right.tick + 2, 4, 0, -1));
    const dl = zl0 - left.match.restart.aimZ, dr = zr0 - right.match.restart.aimZ;
    expect(dl).toBeGreaterThan(0);
    expect(dr).toBeGreaterThan(dl);
  });

  it('Corner: corner tactics (D-pad down, then up = far post) set the tactic and move the reticle there', () => {
    const s = CORNER();
    const m = padMatch(s);
    const before = { x: s.match.restart.aimX, z: s.match.restart.aimZ };
    m.run(16, all(tapAt(PadButton.DPAD_DOWN, s.tick + 2), tapAt(PadButton.DPAD_UP, s.tick + 6)));
    expect(m.frames.some((f) => f.cmd === Command.CORNER_FAR_POST)).toBe(true);
    expect(s.teams[0]!.cornerTactic).toBe(Command.CORNER_FAR_POST);
    // Far post from a corner at z = +34: the reticle goes to the -z side of the goal mouth.
    expect(s.match.restart.aimZ).toBeLessThan(before.z);
    expect(s.match.restart.taken).toBe(0);
  });
});

describe('PAD-06 §10 Throw-in', () => {
  it('Throw-in: move along the line (left stick)', () => {
    const s = THROW();
    const taker = s.match.restart.taker;
    const x0 = s.players[taker]!.x;
    const m = padMatch(s);
    m.run(40, leftHold(s.tick + 2, 30, 1, 0));
    expect(s.players[taker]!.x).toBeGreaterThan(x0 + 0.5);
    expect(Math.abs(s.players[taker]!.x - x0)).toBeLessThanOrEqual(3.01); // brief: within 3 m of the spot
    expect(s.match.restart.taken).toBe(0);
  });

  it('Throw-in: short throw (Cross)', () => {
    const s = THROW();
    const taker = s.match.restart.taker;
    const m = padMatch(s);
    let flags = -1;
    const k = kickOf(m, tapAt(PadButton.CROSS, s.tick + 2), 120);
    const p = s.players[taker]!;
    if (p.act === ActionKind.THROW_IN) flags = p.actB;
    expect(k.kind).toBe(KickKind.THROW_IN);
    expect(k.slot).toBe(taker);
    if (flags >= 0) expect(flags & ThrowFlag.LONG).toBe(0);
  });

  it('Throw-in: long throw (hold Square) goes farther than the short one', () => {
    const dist = (long: boolean): number => {
      const s = THROW();
      const m = padMatch(s);
      const t = s.tick;
      kickOf(m, long ? holdDuring(PadButton.SQUARE, t + 2, t + 40) : tapAt(PadButton.CROSS, t + 2), 120);
      const x = s.ball.x, z = s.ball.z;
      let far = 0;
      m.run(90, undefined, (st) => { far = Math.max(far, Math.hypot(st.ball.x - x, st.ball.z - z)); });
      return far;
    };
    let longFlag = 0;
    {
      const s = THROW();
      const taker = s.match.restart.taker;
      const m = padMatch(s);
      m.run(30, holdDuring(PadButton.SQUARE, s.tick + 2, 9999), (st) => {
        const p = st.players[taker]!;
        if (p.act === ActionKind.THROW_IN && (p.actB & ThrowFlag.LONG) !== 0) longFlag = 1;
        if (p.act === ActionKind.THROW_IN && p.actCharging === 1) longFlag = 1;
      });
    }
    expect(longFlag).toBe(1);
    expect(dist(true)).toBeGreaterThan(dist(false));
  });
});

describe('PAD-06 §10 Penalty', () => {
  it('Penalty: aim (left stick) on the goal line, kept when released', () => {
    const s = PEN();
    const m = padMatch(s);
    m.run(12, leftHold(s.tick + 2, 6, 0.3, 1)); // stick down-right: +z side of the goal
    expect(s.match.restart.aimZ).toBeGreaterThan(0.5);
    const z = s.match.restart.aimZ;
    m.run(6);
    expect(s.match.restart.aimZ).toBe(z);
    expect(s.match.restart.taken).toBe(0);
  });
});

describe('PAD-06 §10 Saving a penalty', () => {
  function saving(): SimState {
    const s = PEN({ humanSide: 1 });
    expect(s.ctrl[0]!.side).toBe(1);
    expect(s.ctrl[0]!.slot).toBe(s.teams[1]!.keeperSlot);
    return s;
  }

  it('Saving a penalty: move along the line (left stick)', () => {
    const s = saving();
    const k = s.teams[1]!.keeperSlot;
    const z0 = s.players[k]!.z;
    const m = padMatch(s);
    m.run(30, leftHold(s.tick + 2, 25, 0, 1));
    expect(s.players[k]!.z).toBeGreaterThan(z0 + 0.3);
  });

  it('Saving a penalty: dive (right stick) commits the dive side', () => {
    for (const [y, side] of [[1, 1], [-1, -1]] as const) {
      const s = saving();
      const m = padMatch(s);
      const t0 = s.tick;
      m.run(8, (tick, sub, r) => {
        if (tick === t0 + 2 && sub === 0) r.right(0, y);
        if (tick === t0 + 3 && sub === 1) r.right(0, 0);
      });
      expect(m.frames.some((f) => (f.buttons & Btn.RS_FLICK) !== 0)).toBe(true);
      expect(s.match.restart.side).toBe(side);
    }
  });
});
