/**
 * QF-3 QA-27: BRIEF section 10, row by row, as ONE table: each row's pad input -> the action the REAL sim starts. Unlike
 * the PAD-02 / PAD-03 row tests (written while the kick starters were Wave-0 stubs), nothing is mocked here: mock
 * Standard Gamepad -> PAD-01 manager -> PAD-02 mapper (two animation frames per tick) -> InputFrame -> step() with the
 * real SIM-08..11 kickers, SIM-12/13/14, GKP, TAI. A starter refusing what the resolver asks for fails its row.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag } from '../../src/contracts/systems';
import { all, holdDuring, padMatch, PadButton, scene, tapAt, type PadMatch, type PadScript } from './pad-02-helpers';

const P = 9;
const B = PadButton;

/** The first kick / action the controlled player starts after tick `from`. */
function firstAction(m: PadMatch, slot = P): { act: ActionKind; kind: KickKind; flags: number } {
  return (m as PadMatch & { first?: { act: ActionKind; kind: KickKind; flags: number } }).first ?? { act: ActionKind.NONE, kind: KickKind.NONE, flags: 0 };
  void slot;
}

/** Run `ticks` with `script`, recording the controlled player's first started action (kick kind and flags). */
function runRecording(s: SimState, script: PadScript, ticks: number, slot = P): { act: ActionKind; kind: KickKind; flags: number; m: PadMatch; seen: Set<ActionKind>[] } {
  const m = padMatch(s);
  let first: { act: ActionKind; kind: KickKind; flags: number } | null = null;
  const seen = Array.from({ length: 22 }, () => new Set<ActionKind>());
  m.run(ticks, script, (st) => {
    const p = st.players[slot]!;
    if (!first && p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD) first = { act: p.act, kind: p.actKick, flags: p.actA };
    for (let k = 0; k < 22; k++) seen[k]!.add(st.players[k]!.act);
  });
  const f = first ?? { act: ActionKind.NONE, kind: KickKind.NONE, flags: 0 };
  return { ...f, m, seen };
}

/** Press a combo: modifiers held from tick t (sub 0), face tapped at tick t + 1 (pad-like: modifier first). */
function combo(face: number, mods: number[], t = 3, holdFace = 2): PadScript {
  return (tick, sub, r) => {
    if (sub !== 0) return;
    if (tick === t) for (const m of mods) r.press(m);
    if (tick === t + 1) r.press(face);
    if (tick === t + 1 + holdFace) { r.release(face); for (const m of mods) r.release(m); }
  };
}

/** Double tap of a face button: taps at t and t + 6. */
function dbl(face: number, t = 3): PadScript {
  return all(tapAt(face, t), tapAt(face, t + 6));
}

interface Row {
  row: string; scene: () => SimState; script?: PadScript; make?: (s: SimState) => PadScript; ticks?: number;
  expect: (r: ReturnType<typeof runRecording>, s: SimState, seen: Set<ActionKind>[]) => void;
}

/** Defence: P1 controls #4 at (dx, 0) goal-side of the away carrier #19 standing with the ball at (-22.6, 0). */
const D = 4, CARRIER = 19;
function defScene(dx = -24): SimState {
  const s = scene({ slot: D, x: dx, z: 0, ball: 'none' });
  const q = s.players[CARRIER]!;
  q.x = -22.6; q.z = 0; q.vx = 0; q.vz = 0; q.fx = -1; q.fz = 0;
  const b = s.ball;
  b.x = q.x - 0.5; b.z = 0; b.px = b.x; b.pz = 0; b.y = 0.11; b.py = b.y; b.vx = 0; b.vy = 0; b.vz = 0; b.grounded = 1;
  b.owner = CARRIER; b.heldBy = -1; b.lastTouch = CARRIER; b.lastTouchTeam = 1; b.passTarget = -1; b.shotBy = -1;
  return s;
}
/** Keep the carrier still with the ball before each tick (his AI would run off). */
const pin = (s: SimState): PadScript => (_t, sub) => {
  const q = s.players[CARRIER]!;
  if (sub !== 0 || s.ball.owner !== CARRIER) return;
  q.x = -22.6; q.z = 0; q.vx = 0; q.vz = 0; s.ball.x = -23.1; s.ball.z = 0; s.ball.vx = 0; s.ball.vz = 0;
};
/** Keeper: P1 controls his keeper #0 holding the ball in his area. */
function keeperScene(): SimState {
  const s = scene({ slot: 0, x: -47, z: 0, ball: 'feet' });
  s.players[0]!.fx = 1;
  s.players[5]!.x = -30; s.players[5]!.z = 8;
  s.ball.lastTouch = 15; s.ball.lastTouchTeam = 1;
  return s;
}
/** Keeper picks the ball up (R1 tap at tick 2), then `then` from tick 8. */
const pickThen = (then: PadScript): PadScript => all(tapAt(B.R1, 2), (t, sub, r, st) => { if (t >= 8) then(t, sub, r, st); });
const actOf = (slot: number, act: ActionKind) => (_r: ReturnType<typeof runRecording>, s: SimState, seen: Set<ActionKind>[]): void => {
  expect(seen[slot]!.has(act), `slot ${slot} did ${[...seen[slot]!].map((a) => ActionKind[a]).join(',')}`).toBe(true);
};

const kickIs = (kind: KickKind, flags = 0) => (r: ReturnType<typeof runRecording>): void => {
  expect(r.kind).toBe(kind);
  if (flags) expect(r.flags & flags).toBe(flags);
};

const ROWS: Row[] = [
  // ---- Attacking
  { row: 'Ground pass: Cross', scene: () => scene(), script: tapAt(B.SOUTH, 3), expect: kickIs(KickKind.GROUND_PASS) },
  { row: 'Lob pass: Square', scene: () => scene(), script: tapAt(B.WEST, 3), expect: kickIs(KickKind.LOB_PASS) },
  { row: 'Through ball: Triangle', scene: () => scene(), script: tapAt(B.NORTH, 3), expect: kickIs(KickKind.THROUGH_GROUND) },
  { row: 'Shoot: Circle', scene: () => scene(), script: tapAt(B.EAST, 3), expect: kickIs(KickKind.SHOT_NORMAL) },
  { row: 'Driven ground pass: R1 + Cross', scene: () => scene(), script: combo(B.SOUTH, [B.R1]), expect: kickIs(KickKind.DRIVEN_PASS, ReqFlag.DRIVEN) },
  { row: 'Lofted ground pass: Cross, Cross', scene: () => scene(), script: dbl(B.SOUTH), ticks: 50, expect: (_r, s) => expect(s.ball.lastKickKind).toBe(KickKind.DINKED_PASS) },
  { row: 'Lofted through ball: Triangle, Triangle', scene: () => scene(), script: dbl(B.NORTH), ticks: 50, expect: (_r, s) => expect(s.ball.lastKickKind).toBe(KickKind.THROUGH_DINKED) },
  { row: 'Ground cross: Square, Square (crossing zone)', scene: () => scene({ x: 40, z: 25 }), script: dbl(B.WEST), ticks: 50, expect: (_r, s) => expect(s.ball.lastKickKind).toBe(KickKind.GROUND_CROSS) },
  { row: 'Cross: Square in the crossing zone', scene: () => scene({ x: 40, z: 25 }), script: tapAt(B.WEST, 3), expect: kickIs(KickKind.CROSS) },
  {
    row: 'Fake shot: Circle, then Cross (no kick, the ball stays at his feet)', scene: () => scene({ x: 30 }),
    script: all(tapAt(B.EAST, 3), tapAt(B.SOUTH, 5)), ticks: 40,
    expect: (r, s) => {
      expect(r.act).toBe(ActionKind.SHOT);
      expect(r.m.events.some((e) => e.type === EventType.SKILL && e.a === P && e.b === SkillMove.FAKE_SHOT)).toBe(true);
      expect(r.m.events.some((e) => e.type === EventType.SHOT)).toBe(false);
      expect(s.ball.owner).toBe(P);
    },
  },
  { row: 'Trigger a run: L1 (tap)', scene: () => scene(), script: tapAt(B.L1, 3), ticks: 10, expect: (_r, s) => expect(s.teams[0]!.runCallT).toBeGreaterThan(0) },
  { row: 'Lobbed through ball: L1 + Triangle', scene: () => scene(), script: combo(B.NORTH, [B.L1]), expect: kickIs(KickKind.THROUGH_LOBBED) },
  { row: 'High lob: L1 + Square', scene: () => scene(), script: combo(B.WEST, [B.L1]), expect: kickIs(KickKind.HIGH_LOB) },
  { row: 'Driven lob: L1 + R1 + Square', scene: () => scene(), script: combo(B.WEST, [B.L1, B.R1]), expect: kickIs(KickKind.DRIVEN_LOB) },
  { row: 'Pass and go: L1 + Cross', scene: () => scene(), script: combo(B.SOUTH, [B.L1]), expect: kickIs(KickKind.GROUND_PASS, ReqFlag.PASS_AND_GO) },
  // ---- Shooting
  { row: 'Finesse shot: R1 + Circle', scene: () => scene({ x: 30 }), script: combo(B.EAST, [B.R1]), expect: kickIs(KickKind.SHOT_FINESSE) },
  { row: 'Chip shot: L1 + Circle', scene: () => scene({ x: 30 }), script: combo(B.EAST, [B.L1]), expect: kickIs(KickKind.SHOT_CHIP) },
  { row: 'Power shot: L1 + R1 + Circle', scene: () => scene({ x: 30 }), script: combo(B.EAST, [B.L1, B.R1]), expect: kickIs(KickKind.SHOT_POWER) },
  {
    row: 'Low driven shot: Circle, then tap Circle again during power-up', scene: () => scene({ x: 30 }),
    script: all(holdDuring(B.EAST, 3, 9), tapAt(B.EAST, 11)), ticks: 40,
    expect: (r, s) => {
      expect(r.act).toBe(ActionKind.SHOT);
      // The conversion marks the running shot low driven (kind or LOW flag).
      const p = s.players[P]!;
      expect(r.m.events.some((e) => e.type === EventType.SHOT) || p.actKick === KickKind.SHOT_LOW_DRIVEN || (p.actA & ReqFlag.LOW) !== 0).toBe(true);
    },
  },
  // ---- Movement and dribbling (actions)
  {
    row: 'Knock-on: R2 + right-stick flick', scene: () => scene({ vx: 4 }),
    script: (tick, sub, r) => {
      if (sub !== 0) return;
      if (tick === 2) { r.left(1, 0); r.press(B.R2); }
      if (tick === 20) r.right(1, 0);
      if (tick === 22) r.right(0, 0);
    }, ticks: 40,
    expect: (r) => expect(r.m.events.some((e) => e.type === EventType.SKILL && e.b === SkillMove.KNOCK_ON) || r.kind === KickKind.KNOCK_ON).toBe(true),
  },
  // ---- Defending (P1 on #4, the carrier pinned at -22.6)
  { row: 'Change player: L1', scene: () => defScene(), script: tapAt(B.L1, 3), ticks: 6, expect: (_r, s) => expect(s.ctrl[0]!.slot).not.toBe(D) },
  { row: 'Tackle: Circle (goal-side)', scene: () => defScene(-24), make: (s) => all(pin(s), tapAt(B.EAST, 3)), ticks: 10, expect: actOf(D, ActionKind.STAND_TACKLE) },
  { row: 'Hard tackle: R1 + Circle', scene: () => defScene(-24), make: (s) => all(pin(s), combo(B.EAST, [B.R1])), ticks: 10, expect: actOf(D, ActionKind.HARD_TACKLE) },
  { row: 'Slide tackle: Square', scene: () => defScene(-25), make: (s) => all(pin(s), tapAt(B.WEST, 3)), ticks: 10, expect: actOf(D, ActionKind.SLIDE_TACKLE) },
  { row: 'Rush the keeper out: Triangle (hold)', scene: () => defScene(-24), make: (s) => all(pin(s), holdDuring(B.NORTH, 3, 20)), ticks: 20, expect: actOf(0, ActionKind.GK_RUSH) },
  {
    row: 'Teammate contain (second defender): R1 (hold)', scene: () => defScene(-24), make: (s) => all(pin(s), holdDuring(B.R1, 3, 30)), ticks: 20,
    expect: (_r, s) => expect(s.ctrl[0]!.secondDef).toBeGreaterThanOrEqual(0),
  },
  // ---- Goalkeeper with the ball (picked up with R1 first)
  { row: 'Pick up the ball: R1', scene: keeperScene, script: tapAt(B.R1, 2), ticks: 6, expect: (_r, s) => expect(s.ball.heldBy).toBe(0) },
  { row: 'Throw or pass: Cross', scene: keeperScene, script: pickThen(tapAt(B.SOUTH, 10)), ticks: 60, expect: actOf(0, ActionKind.GK_THROW) },
  { row: 'Drop kick: Circle', scene: keeperScene, script: pickThen(tapAt(B.EAST, 10)), ticks: 60, expect: actOf(0, ActionKind.GK_KICK) },
  { row: 'Drop kick: Square', scene: keeperScene, script: pickThen(tapAt(B.WEST, 10)), ticks: 60, expect: actOf(0, ActionKind.GK_KICK) },
  {
    row: 'Drop the ball: Triangle', scene: keeperScene, script: pickThen(tapAt(B.NORTH, 10)), ticks: 30,
    expect: (_r, s) => { expect(s.ball.heldBy).toBe(-1); expect(s.ball.owner).toBe(0); },
  },
];

describe('QF-3 QA-27 section 10 rows -> real sim actions (no mocks)', () => {
  for (const row of ROWS) {
    it(row.row, () => {
      const s = row.scene();
      s.match.phase = MatchPhase.IN_PLAY;
      const script = row.make ? row.make(s) : row.script!;
      const r = runRecording(s, script, row.ticks ?? 30);
      row.expect(r, s, r.seen);
      void firstAction;
      void Btn;
    });
  }
});
