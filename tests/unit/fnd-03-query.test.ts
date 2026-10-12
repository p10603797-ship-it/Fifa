/** FND-03: tests for the lead-owned read-only queries in src/sim/core/query.ts. */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH, NUM_SLOTS } from '../../src/contracts/constants';
import { ControllerKind } from '../../src/contracts/enums';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import {
  attackGoalX, controllerOf, defendGoalX, distToAttackLine, distToBall, isActive, isHumanSlot, nearestDistOfTeam, nearestOfTeam,
  opponentsWithin, otherTeam, possessingTeam, pressureOn, progressX, secondLastDefenderX, teamDir, teamEnd, teamHasHuman, teamStart,
} from '../../src/sim/core/query';
import { initMatch } from '../../src/sim/init';

/** State with every player parked far away (x = 0, z = 30 + slot) so tests place only who they need. */
function setup(): SimState {
  const s = initMatch(createMatchConfig());
  for (const p of s.players) { p.x = 0; p.z = 30 + p.slot * 0.1; }
  return s;
}

describe('team helpers', () => {
  it('otherTeam / teamStart / teamEnd / teamDir', () => {
    const s = setup();
    expect(otherTeam(0)).toBe(1);
    expect(otherTeam(1)).toBe(0);
    expect([teamStart(0), teamEnd(0), teamStart(1), teamEnd(1)]).toEqual([0, 11, 11, 22]);
    expect([teamDir(s, 0), teamDir(s, 1)]).toEqual([1, -1]);
  });

  it('isActive bounds and the active flag', () => {
    const s = setup();
    expect(isActive(s, 0)).toBe(true);
    expect(isActive(s, -1)).toBe(false);
    expect(isActive(s, NUM_SLOTS)).toBe(false);
    s.players[4]!.active = 0;
    expect(isActive(s, 4)).toBe(false);
  });

  it('goal lines, distance to attack line and progress follow team.dir', () => {
    const s = setup();
    expect(attackGoalX(s, 0)).toBe(HALF_LENGTH);
    expect(defendGoalX(s, 0)).toBe(-HALF_LENGTH);
    expect(attackGoalX(s, 1)).toBe(-HALF_LENGTH);
    expect(distToAttackLine(s, 0, 40)).toBe(12.5);
    expect(distToAttackLine(s, 1, 40)).toBe(92.5);
    expect(progressX(s, 0, HALF_LENGTH)).toBe(1);
    expect(progressX(s, 1, HALF_LENGTH)).toBe(-1);
    s.teams[0]!.dir = -1; // second half
    expect(attackGoalX(s, 0)).toBe(-HALF_LENGTH);
    expect(progressX(s, 0, -26.25)).toBe(0.5);
  });
});

describe('ball queries', () => {
  it('possessingTeam and distToBall', () => {
    const s = setup();
    expect(possessingTeam(s)).toBe(-1);
    s.ball.owner = 13;
    expect(possessingTeam(s)).toBe(1);
    s.ball.x = 3; s.ball.z = 4;
    s.players[2]!.x = 0; s.players[2]!.z = 0;
    expect(distToBall(s, 2)).toBe(5);
  });
});

describe('nearestOfTeam / nearestDistOfTeam', () => {
  it('finds the nearest active player honouring exclude and keeper flags', () => {
    const s = setup();
    s.players[0]!.x = 1; s.players[0]!.z = 0; // keeper closest
    s.players[3]!.x = 2; s.players[3]!.z = 0;
    s.players[5]!.x = 3; s.players[5]!.z = 0;
    expect(nearestOfTeam(s, 0, 0, 0, -1, true)).toBe(0);
    expect(nearestOfTeam(s, 0, 0, 0, -1, false)).toBe(3);
    expect(nearestOfTeam(s, 0, 0, 0, 3, false)).toBe(5);
    s.players[5]!.active = 0;
    expect(nearestOfTeam(s, 0, 0, 0, 3, false)).not.toBe(5);
    expect(nearestDistOfTeam(s, 0, 0, 0)).toBe(1);
  });

  it('returns -1 / 1e9 when the team has no eligible player', () => {
    const s = setup();
    for (let i = 11; i < 22; i++) s.players[i]!.active = 0;
    expect(nearestOfTeam(s, 1, 0, 0, -1, true)).toBe(-1);
    expect(nearestDistOfTeam(s, 1, 0, 0)).toBe(1e9);
  });

  it('ties resolve to the lowest slot (deterministic)', () => {
    const s = setup();
    s.players[4]!.x = 1; s.players[4]!.z = 0;
    s.players[6]!.x = -1; s.players[6]!.z = 0;
    expect(nearestOfTeam(s, 0, 0, 0, -1, false)).toBe(4);
  });
});

describe('pressureOn / opponentsWithin', () => {
  it('pressure is 1 at <= 1 m, 0 at >= 6 m, linear in between', () => {
    const s = setup();
    s.players[2]!.x = 0; s.players[2]!.z = 0;
    const opp = s.players[15]!;
    opp.z = 0;
    for (const [d, want] of [[0.5, 1], [1, 1], [3.5, 0.5], [6, 0], [10, 0]] as const) {
      opp.x = d;
      expect(pressureOn(s, 2)).toBeCloseTo(want, 12);
    }
    for (let i = 11; i < 22; i++) s.players[i]!.active = 0;
    expect(pressureOn(s, 2)).toBe(0);
  });

  it('counts active opponents within r (inclusive)', () => {
    const s = setup();
    s.players[12]!.x = 3; s.players[12]!.z = 4; // exactly 5 m
    s.players[13]!.x = 1; s.players[13]!.z = 0;
    s.players[14]!.x = 1; s.players[14]!.z = 1; s.players[14]!.active = 0;
    s.players[1]!.x = 0; s.players[1]!.z = 0; // teammate, ignored
    expect(opponentsWithin(s, 0, 0, 0, 5)).toBe(2);
    expect(opponentsWithin(s, 0, 0, 0, 4.99)).toBe(1);
  });
});

describe('controllers', () => {
  it('controllerOf / isHumanSlot / teamHasHuman', () => {
    const s = setup();
    expect(controllerOf(s, 3)).toBe(-1);
    expect(isHumanSlot(s, 3)).toBe(false);
    s.players[3]!.ctrl = 0;
    expect(isHumanSlot(s, 3)).toBe(true);
    s.players[14]!.ctrl = 3; // CPU brain for team 1
    expect(isHumanSlot(s, 14)).toBe(false);
    expect(teamHasHuman(s, 0)).toBe(true); // default config: P1 human on side 0
    expect(teamHasHuman(s, 1)).toBe(false);
    s.ctrl[1]!.kind = ControllerKind.HUMAN;
    s.ctrl[1]!.side = 1;
    expect(teamHasHuman(s, 1)).toBe(true);
  });
});

describe('secondLastDefenderX', () => {
  it('team attacking +x (defends -x): second deepest including the keeper', () => {
    const s = setup();
    for (let i = 0; i < 11; i++) s.players[i]!.x = -10;
    s.players[0]!.x = -50; // keeper deepest
    s.players[4]!.x = -30.5;
    s.players[5]!.x = -30;
    expect(secondLastDefenderX(s, 0)).toBe(-30.5);
  });

  it('team attacking -x (defends +x): mirrored', () => {
    const s = setup();
    for (let i = 11; i < 22; i++) s.players[i]!.x = 10;
    s.players[11]!.x = 50;
    s.players[16]!.x = 30;
    s.players[17]!.x = 31;
    expect(secondLastDefenderX(s, 1)).toBe(31);
  });

  it('keeper off his line: the second-last can be an outfield player beyond him', () => {
    const s = setup();
    for (let i = 0; i < 11; i++) s.players[i]!.x = 0;
    s.players[0]!.x = -20; // keeper up the pitch
    s.players[2]!.x = -40;
    s.players[3]!.x = -35;
    expect(secondLastDefenderX(s, 0)).toBe(-35);
  });

  it('equal deepest pair and inactive players', () => {
    const s = setup();
    for (let i = 0; i < 11; i++) s.players[i]!.x = 0;
    s.players[0]!.x = -40;
    s.players[1]!.x = -40;
    expect(secondLastDefenderX(s, 0)).toBe(-40);
    s.players[1]!.active = 0;
    s.players[2]!.x = -45;
    s.players[2]!.active = 0;
    expect(secondLastDefenderX(s, 0)).toBe(0);
  });

  it('a single active player is both last and second-last', () => {
    const s = setup();
    for (let i = 1; i < 11; i++) s.players[i]!.active = 0;
    s.players[0]!.x = -48;
    expect(secondLastDefenderX(s, 0)).toBe(-48);
  });
});
