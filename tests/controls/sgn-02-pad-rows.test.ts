/**
 * SGN-02 controls audit: the section 10 controller rows whose only end-to-end test was weak, end to end with nothing
 * mocked: mock Standard Gamepad -> PAD-01 manager -> PAD-02 mapper (two animation frames per tick) -> InputFrame ->
 * the real step() pipeline with the real SIM-08..11 kickers. Each test is named after its row.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { all, holdDuring, padMatch, PadButton, scene, tapAt, type PadMatch, type PadScript } from './pad-02-helpers';

const P = 9;

/** The kinds of every KICK event #9 made (dribble touches left out). */
function kicks(m: PadMatch): string[] {
  return m.events.filter((e) => e.type === EventType.KICK && e.a === P && e.b !== KickKind.DRIBBLE_TOUCH).map((e) => KickKind[e.b]!);
}

/** Modifiers held from tick t, the face button pressed at t + 1 and held `hold` ticks, then all released. */
function combo(face: number, mods: number[], t = 3, hold = 2): PadScript {
  return (tick, sub, r) => {
    if (sub !== 0) return;
    if (tick === t) for (const b of mods) r.press(b);
    if (tick === t + 1) r.press(face);
    if (tick === t + 1 + hold) { r.release(face); for (const b of mods) r.release(b); }
  };
}

describe('SGN-02 section 10 rows (real pad pipeline, real kickers)', () => {
  it('Driven lob / driven cross: L1 + R1 + Square in the crossing zone is a driven (low) cross; outside it a driven lob', () => {
    const zone = scene({ x: 40, z: 25 });
    const mz = padMatch(zone);
    mz.run(60, combo(PadButton.WEST, [PadButton.L1, PadButton.R1]));
    expect(kicks(mz)).toEqual(['LOW_CROSS']);
    const open = scene({ x: 10, z: 0 });
    const mo = padMatch(open);
    mo.run(60, combo(PadButton.WEST, [PadButton.L1, PadButton.R1]));
    expect(kicks(mo)).toEqual(['DRIVEN_LOB']);
  });

  it('Low driven shot: Circle, then tap Circle again during power-up strikes SHOT_LOW_DRIVEN; one held Circle is a normal shot', () => {
    const low = scene({ x: 30 });
    const ml = padMatch(low);
    let sawShot = false;
    ml.run(60, all(holdDuring(PadButton.EAST, 3, 9), tapAt(PadButton.EAST, 11)), (st) => {
      if (st.players[P]!.act === ActionKind.SHOT) sawShot = true;
    });
    expect(sawShot).toBe(true);
    expect(kicks(ml)).toEqual(['SHOT_LOW_DRIVEN']);
    expect(ml.events.filter((e) => e.type === EventType.SHOT && e.a === P)).toHaveLength(1);

    const normal = scene({ x: 30 });
    const mn = padMatch(normal);
    mn.run(60, holdDuring(PadButton.EAST, 3, 9));
    expect(kicks(mn)).toEqual(['SHOT_NORMAL']);
  });

  it('Shot (hold for power): a longer Circle hold strikes harder (real SIM-11, KICK power and ball speed)', () => {
    const run = (hold: number): { c: number; v: number } => {
      const s = scene({ x: 25 });
      const m = padMatch(s);
      let v = 0;
      let kicked = false;
      m.run(80, holdDuring(PadButton.EAST, 3, 3 + hold), (st) => {
        if (!kicked && m.events.some((e) => e.type === EventType.KICK && e.a === P && e.b === KickKind.SHOT_NORMAL)) {
          kicked = true;
          v = Math.hypot(st.ball.vx, st.ball.vy, st.ball.vz);
        }
      });
      const e = m.events.find((x) => x.type === EventType.KICK && x.a === P && x.b === KickKind.SHOT_NORMAL);
      expect(e, `hold ${hold}`).toBeDefined();
      return { c: e!.c, v };
    };
    const tapShot = run(2), heldShot = run(30);
    expect(heldShot.c).toBeGreaterThan(tapShot.c + 0.3);
    expect(heldShot.v).toBeGreaterThan(tapShot.v + 3);
  });
});
