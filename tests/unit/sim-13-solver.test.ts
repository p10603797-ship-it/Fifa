/**
 * SIM-13 unit tests. kicks/skills.ts is imported FIRST on purpose: the import cycle skills -> actions/dispatch ->
 * actions/registry -> skills must still hand the registry the real SKILL / FAKE handlers and skill-touch solver
 * (skillsHooks.ts shells), or no skill move would ever run. Also: solveSkillTouch (KNOCK_ON / SKILL_TOUCH /
 * DRIBBLE_TOUCH launches, rest point, error, refusals, purity) and the tuning tables' consistency.
 */
import { fakeHandler, LOCAL_TUNING, skillHandler, solveSkillTouch, startSkill } from '../../src/sim/kicks/skills';
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, SkillMove } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createKickLaunch } from '../../src/contracts/systems';
import { T_BALL, T_DRIBBLE, T_SKILL } from '../../src/contracts/tuning';
import { ACTION_HANDLERS, KICK_SOLVERS } from '../../src/sim/actions/registry';
import { ballStepTick } from '../../src/sim/ball/contact';
import { hashState } from '../../src/sim/core/hash';
import { NULL_SINK } from '../../src/sim/core/events';
import { findEvents, runTicks } from '../harness/scenario';
import { SKILLER, skillScene } from '../scenario/sim-13-helpers';

describe('SIM-13 import order (skills.ts imported before the pipeline)', () => {
  it('the registry holds the real SKILL / FAKE handlers and the skill-touch solver', () => {
    expect(ACTION_HANDLERS[ActionKind.SKILL]).toBe(skillHandler);
    expect(ACTION_HANDLERS[ActionKind.FAKE]).toBe(fakeHandler);
    for (const k of [KickKind.KNOCK_ON, KickKind.SKILL_TOUCH, KickKind.DRIBBLE_TOUCH]) expect(KICK_SOLVERS[k]).toBe(solveSkillTouch);
  });

  it('and they run: a step-over started before the first step plays out and touches the ball', () => {
    const s = skillScene({ vx: 2 });
    expect(startSkill(s, SKILLER, SkillMove.STEP_OVER, 0, 1, NULL_SINK)).toBe(1);
    const ev = runTicks(s, T_SKILL.duration[SkillMove.STEP_OVER]!);
    expect(findEvents(ev, EventType.KICK, (e) => e.b === KickKind.SKILL_TOUCH)).toHaveLength(1);
    expect(s.players[SKILLER]!.act).toBe(ActionKind.NONE);
  });
});

/** A skiller (standing or running along +x) with the ball at his feet and a kick of `kind` toward (dx, dz). */
function touchScene(kind: KickKind, dx: number, dz: number, vx = 0, power = 0.5) {
  const s = skillScene({ vx });
  const p = s.players[SKILLER]!;
  Object.assign(p, { act: ActionKind.KICK, actKick: kind, actDirX: dx, actDirZ: dz, actPower: power, actT: 2, actDur: 12, actContact: 2 });
  return { s, p };
}

/** Roll the launch on an otherwise free ball until it stops; returns where it stopped. */
function rollOut(s: ReturnType<typeof skillScene>, vx: number, vz: number): { x: number; z: number } {
  const b = { ...s.ball, vx, vy: 0, vz, owner: -1 };
  for (let i = 0; i < 2000 && (b.vx !== 0 || b.vz !== 0); i++) ballStepTick(b, null);
  return { x: b.x, z: b.z };
}

describe('SIM-13 solveSkillTouch', () => {
  const L = LOCAL_TUNING;
  const cases: [KickKind, number, number, number][] = [
    [KickKind.KNOCK_ON, L.knockRel, L.knockMin, L.knockMax],
    [KickKind.SKILL_TOUCH, L.skillTouchRel, L.skillTouchMin, L.skillTouchMax],
    [KickKind.DRIBBLE_TOUCH, L.dribbleTouchRel, L.dribbleTouchMin, L.dribbleTouchMax],
  ];
  for (const [kind, rel, vmin, vmax] of cases) {
    it(`${KickKind[kind]}: along the request at the player's speed + ${rel} x (0.5 + power), within [${vmin}, ${vmax}]`, () => {
      for (const [vx, power] of [[0, 0.5], [3, 0.5], [6, 1], [9, 0.9], [0, 0]] as const) {
        const { s } = touchScene(kind, 1, 0, vx, power);
        s.attrs[SKILLER]!.dribbling = 99; s.attrs[SKILLER]!.ballControl = 99; // no error
        const out = createKickLaunch();
        expect(solveSkillTouch(s, SKILLER, out)).toBe(1);
        const want = Math.min(vmax, Math.max(vmin, vx + rel * (0.5 + power)));
        expect(Math.hypot(out.vx, out.vz)).toBeCloseTo(want, 9);
        expect(out.vz).toBeCloseTo(0, 9);
        expect(out.vy).toBe(0);
        expect([out.sx, out.sy, out.sz]).toEqual([0, 0, 0]);
        expect(out.kind).toBe(kind);
        expect(out.target).toBe(SKILLER);
        expect(out.onTarget).toBe(0);
        // tx/tz: where the ball rolls to a stop (SIM-02 rolling model).
        const stop = rollOut(s, out.vx, out.vz);
        expect(Math.hypot(out.tx - stop.x, out.tz - stop.z)).toBeLessThan(0.15);
      }
    });
  }

  it('no direction requested: along the facing', () => {
    const { s, p } = touchScene(KickKind.KNOCK_ON, 0, 0);
    p.fx = 0; p.fz = -1;
    s.attrs[SKILLER]!.dribbling = 99; s.attrs[SKILLER]!.ballControl = 99;
    const out = createKickLaunch();
    expect(solveSkillTouch(s, SKILLER, out)).toBe(1);
    expect(out.vx).toBeCloseTo(0, 9);
    expect(out.vz).toBeLessThan(-L.knockMin + 1e-9);
  });

  it('direction error: bounded by errMax x (1 - control quality), wider for poor dribblers, one s.rng draw per touch', () => {
    const spread = (attr: number): number => {
      let worst = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const { s } = touchScene(KickKind.KNOCK_ON, 1, 0);
        s.rng.a = seed * 7919; s.rng.b = seed * 104729; s.rng.c = seed; s.rng.d = 1;
        s.attrs[SKILLER]!.dribbling = attr; s.attrs[SKILLER]!.ballControl = attr;
        const out = createKickLaunch();
        const before = { ...s.rng };
        solveSkillTouch(s, SKILLER, out);
        expect(s.rng).not.toEqual(before);
        const err = Math.abs(Math.atan2(out.vz, out.vx));
        expect(err).toBeLessThanOrEqual(L.knockErrMax + 1e-12);
        if (err > worst) worst = err;
      }
      return worst;
    };
    expect(spread(1)).toBeGreaterThan(0.5 * L.knockErrMax);
    expect(spread(99)).toBeLessThan(1e-12);
  });

  it('pure: only the RNG changes, and the same state gives the same launch', () => {
    const { s } = touchScene(KickKind.SKILL_TOUCH, 0.6, 0.8, 2);
    const a = createKickLaunch(), b = createKickLaunch();
    const rng = { ...s.rng };
    const h0 = hashState({ ...s, rng });
    expect(solveSkillTouch(s, SKILLER, a)).toBe(1);
    expect(hashState({ ...s, rng })).toBe(h0);
    Object.assign(s.rng, rng);
    expect(solveSkillTouch(s, SKILLER, b)).toBe(1);
    expect(b).toEqual(a);
  });

  it('refuses (no state change, no RNG draw): other kinds, ball out of reach / high / in hands, inactive, bad slot', () => {
    const muts: [string, (s: ReturnType<typeof skillScene>) => void][] = [
      ['ground pass kind', (s) => { s.players[SKILLER]!.actKick = KickKind.GROUND_PASS; }],
      ['no kind', (s) => { s.players[SKILLER]!.actKick = KickKind.NONE; }],
      ['out of reach', (s) => { s.ball.x += T_DRIBBLE.controlRadius + 0.2; }],
      ['ball high', (s) => { s.ball.y = T_DRIBBLE.controlHeight + 0.1; }],
      ['ball in hands', (s) => { s.ball.heldBy = 0; }],
      ['inactive', (s) => { s.players[SKILLER]!.active = 0; }],
    ];
    for (const [label, mut] of muts) {
      const { s } = touchScene(KickKind.KNOCK_ON, 1, 0);
      mut(s);
      const h = hashState(s);
      expect(solveSkillTouch(s, SKILLER, createKickLaunch()), label).toBe(0);
      expect(hashState(s), label).toBe(h);
    }
    const { s } = touchScene(KickKind.KNOCK_ON, 1, 0);
    for (const slot of [-1, 22, 0.5]) expect(solveSkillTouch(s, slot, createKickLaunch())).toBe(0);
  });

  it('reach grows with the player\'s speed (a sprinter meets a ball a stride ahead)', () => {
    const { s } = touchScene(KickKind.KNOCK_ON, 1, 0, 8);
    s.ball.x = s.players[SKILLER]!.x + T_DRIBBLE.controlRadius + 0.5;
    expect(solveSkillTouch(s, SKILLER, createKickLaunch())).toBe(1);
    s.players[SKILLER]!.vx = 0;
    expect(solveSkillTouch(s, SKILLER, createKickLaunch())).toBe(0);
  });

  it('never faster than the ball speed cap', () => {
    const { s } = touchScene(KickKind.KNOCK_ON, 1, 0, 60, 1);
    const out = createKickLaunch();
    expect(solveSkillTouch(s, SKILLER, out)).toBe(1);
    expect(Math.hypot(out.vx, out.vz)).toBeLessThanOrEqual(Math.min(L.knockMax, T_BALL.maxSpeed));
  });
});

describe('SIM-13 tuning tables', () => {
  it('per-move tables cover every SkillMove; exit touches and windows fall inside each move', () => {
    const n = SkillMove.HARD_STOP + 1;
    const L = LOCAL_TUNING;
    for (const tab of [L.exitAngle, L.releaseFrac, L.pushSpeed, L.exitSpeed, L.lift, T_SKILL.duration, T_SKILL.minStars,
      T_SKILL.vulnStart, T_SKILL.vulnEnd]) expect(tab).toHaveLength(n);
    for (let k = 1; k < n; k++) {
      const d = T_SKILL.duration[k]!;
      expect(d).toBeGreaterThan(0);
      expect(T_SKILL.vulnStart[k]!).toBeLessThan(T_SKILL.vulnEnd[k]!);
      expect(T_SKILL.vulnEnd[k]!).toBeLessThanOrEqual(d);
      if (L.releaseFrac[k]! < 1) {
        expect(Math.round(L.releaseFrac[k]! * d)).toBeGreaterThanOrEqual(1);
        expect(Math.round(L.releaseFrac[k]! * d)).toBeLessThan(d);
      }
    }
    expect(L.knockTouchTick).toBeLessThan(T_SKILL.duration[SkillMove.KNOCK_ON]!);
  });
});
