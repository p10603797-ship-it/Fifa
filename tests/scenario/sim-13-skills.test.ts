/**
 * SIM-13 skill moves and fake shot through the real tick pipeline (step): every move runs its fixed duration and
 * leaves the ball near the player in the exit direction; exit directions; star gating and refusals; vulnerable
 * windows (inSkillVulnerableWindow, and the opponent on the ball's path who wins it in the window); the fake that
 * converts a shot / lob wind-up; no ball stuck after skills (glitch list); determinism (repeat runs, mid-move clones).
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { ActionKind, KickKind, MatchPhase, SkillMove, isShotKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { T_DRIBBLE, T_SKILL } from '../../src/contracts/tuning';
import { cloneState } from '../../src/sim/core/clone';
import { hashState } from '../../src/sim/core/hash';
import { inSkillVulnerableWindow, LOCAL_TUNING, startFake, startSkill } from '../../src/sim/kicks/skills';
import { findEvents, runTicks } from '../harness/scenario';
import { MATE, OPP, SKILLER, angleBetween, ballRel, recorder, skillScene, stick } from './sim-13-helpers';

const ALL: SkillMove[] = [
  SkillMove.BALL_ROLL, SkillMove.STEP_OVER, SkillMove.BODY_FEINT, SkillMove.DRAG_BACK, SkillMove.FAKE_SHOT,
  SkillMove.ROULETTE, SkillMove.HEEL_FLICK, SkillMove.KNOCK_ON, SkillMove.STOP_BALL, SkillMove.STOP_FACE_GOAL,
  SkillMove.HARD_STOP,
];
const STOPS: SkillMove[] = [SkillMove.STOP_BALL, SkillMove.STOP_FACE_GOAL, SkillMove.HARD_STOP];
const isStop = (k: SkillMove): boolean => STOPS.includes(k);
/** Moves whose body ends facing the exit. */
const TURNS: SkillMove[] = [
  SkillMove.STEP_OVER, SkillMove.BODY_FEINT, SkillMove.DRAG_BACK, SkillMove.FAKE_SHOT, SkillMove.ROULETTE,
  SkillMove.HEEL_FLICK, SkillMove.KNOCK_ON,
];
const name = (k: SkillMove): string => SkillMove[k]!;

/** Exit for a start facing +x and a request toward +z * side (+1 = his right). */
function expectedExit(k: SkillMove, side: number): [number, number] {
  switch (k) {
    case SkillMove.BALL_ROLL: return [0, side]; // pure sideways
    case SkillMove.DRAG_BACK: return [-1, 0]; // straight back
    case SkillMove.KNOCK_ON: return [0, side]; // the request itself
    case SkillMove.STOP_BALL: case SkillMove.HARD_STOP: case SkillMove.STOP_FACE_GOAL: return [1, 0];
    default: {
      const a = LOCAL_TUNING.exitAngle[k]!;
      return [Math.cos(a), side * Math.sin(a)];
    }
  }
}

function speed(vx: number, vz: number): number { return Math.sqrt(vx * vx + vz * vz); }

/** Start move k (asserting it started), then step until the action ends (max duration + 5). */
function runMove(s: SimState, k: SkillMove, dirX: number, dirZ: number, inputs?: Parameters<typeof runTicks>[2]) {
  const p = s.players[SKILLER]!;
  const rec = recorder();
  expect(startSkill(s, SKILLER, k, dirX, dirZ, rec)).toBe(1);
  expect(rec.events).toEqual([[EventType.SKILL, SKILLER, k]]);
  const ex = p.actDirX, ez = p.actDirZ;
  const f0x = p.fx, f0z = p.fz;
  let ticks = 0, maxY = 0, spin = 0, minAlongF0 = 1e9;
  let fx = p.fx, fz = p.fz;
  const events = runTicks(s, T_SKILL.duration[k]! + 5, inputs, {
    check: 'core',
    until: (st) => {
      ticks++;
      if (st.ball.y > maxY) maxY = st.ball.y;
      spin += angleBetween(fx, fz, p.fx, p.fz);
      fx = p.fx; fz = p.fz;
      const along = ballRel(st, SKILLER, f0x, f0z).along;
      if (along < minAlongF0) minAlongF0 = along;
      return p.act !== ActionKind.SKILL;
    },
  });
  return { ticks, ex, ez, f0x, f0z, maxY, spin, minAlongF0, events };
}

// ---------------------------------------------------------------- every move

describe('SIM-13 every move runs its duration and leaves the ball near the player in the exit direction', () => {
  for (const k of ALL) {
    for (const v of [0, 4, 8]) {
      for (const side of [1, -1]) {
        it(`${name(k)} from ${v} m/s, request to his ${side > 0 ? 'right' : 'left'}`, () => {
          const s = skillScene({ vx: v });
          const p = s.players[SKILLER]!;
          const [ex, ez] = expectedExit(k, side);
          // The request: sideways, except the drag-back's "left stick flicked backward" (slightly to the side).
          const [qx, qz] = k === SkillMove.DRAG_BACK ? [-0.95, 0.3 * side] : [0, side];
          // Stops are "release the stick": no input. Other moves: the stick then follows the move out.
          const r = runMove(s, k, qx, qz, isStop(k) ? undefined : stick(ex, ez));
          expect(r.ex).toBeCloseTo(ex, 6);
          expect(r.ez).toBeCloseTo(ez, 6);
          expect(r.ticks).toBe(T_SKILL.duration[k]!); // completes in its fixed duration
          expect(p.act).toBe(ActionKind.NONE);
          expect(p.moveMode).not.toBe(MoveMode.LOCKED);
          const rel = ballRel(s, SKILLER, ex, ez);
          const b = s.ball;
          if (k === SkillMove.KNOCK_ON) {
            // Pushed far ahead into space: loose, rolling on along the exit, the knocker as its target.
            expect(b.owner).toBe(-1);
            expect(b.lastKickKind).toBe(KickKind.KNOCK_ON);
            expect(b.lastKickBy).toBe(SKILLER);
            expect(b.passTarget).toBe(SKILLER);
            expect(rel.along).toBeGreaterThan(1);
            expect(b.vx * ex + b.vz * ez).toBeGreaterThan(5);
            expect(findEvents(r.events, EventType.KICK, (e) => e.a === SKILLER && e.b === KickKind.KNOCK_ON)).toHaveLength(1);
            expect(p.vx * ex + p.vz * ez).toBeGreaterThan(v > 0 ? 0 : 1); // bursting after it
          } else if (isStop(k)) {
            // Speed killed, ball dead at his feet in front of him.
            expect(b.owner).toBe(SKILLER);
            expect(speed(p.vx, p.vz)).toBeLessThan(0.3);
            expect(speed(b.vx - p.vx, b.vz - p.vz)).toBeLessThan(0.3);
            expect(rel.along).toBeGreaterThan(0.2);
            expect(rel.along).toBeLessThan(0.6);
            expect(Math.abs(rel.side)).toBeLessThan(0.1);
          } else {
            expect(b.owner).toBe(SKILLER);
            expect(rel.along).toBeGreaterThan(0.2);
            expect(rel.dist).toBeLessThan(1.5);
            expect(Math.abs(rel.side)).toBeLessThan(0.6);
            expect(p.vx * ex + p.vz * ez).toBeGreaterThan(0); // moving off along the exit
            expect(b.vx * ex + b.vz * ez).toBeGreaterThan(0);
            expect(findEvents(r.events, EventType.KICK, (e) => e.a === SKILLER && e.b === KickKind.SKILL_TOUCH)).toHaveLength(1);
          }
          if (TURNS.includes(k)) expect(p.fx * ex + p.fz * ez).toBeGreaterThan(0.9);
          if (k === SkillMove.BALL_ROLL) expect(p.fx * r.f0x + p.fz * r.f0z).toBeGreaterThan(0.9);
          expect(findEvents(r.events, EventType.SHOT)).toHaveLength(0);
        });
      }
    }
  }

  it('ROULETTE: the body spins a full turn (and the exit angle) toward the chosen side', () => {
    for (const side of [1, -1]) {
      const r = runMove(skillScene({ vx: 3 }), SkillMove.ROULETTE, 0, side, stick(0, side));
      expect(side * r.spin).toBeGreaterThan(2 * Math.PI);
    }
  });

  it('DRAG_BACK: the ball is pulled back under and behind the body, which turns round', () => {
    const r = runMove(skillScene({ vx: 5 }), SkillMove.DRAG_BACK, -1, 0, stick(-1, 0));
    expect(r.minAlongF0).toBeLessThan(-0.3);
    expect(Math.abs(r.spin)).toBeGreaterThan(0.9 * Math.PI);
  });

  it('HEEL_FLICK: lifts the ball forward over (airborne), and the dribbler collects it ahead', () => {
    const s = skillScene({ vx: 4 });
    const r = runMove(s, SkillMove.HEEL_FLICK, 1, 0, stick(1, 0));
    expect(r.maxY).toBeGreaterThan(0.6);
    expect(ballRel(s, SKILLER, r.ex, r.ez).along).toBeGreaterThan(0);
    runTicks(s, 90, stick(1, 0), { check: 'core' });
    expect(s.ball.owner).toBe(SKILLER);
    expect(s.ball.y).toBeLessThan(T_DRIBBLE.controlHeight);
    expect(ballRel(s, SKILLER, 1, 0).dist).toBeLessThan(T_DRIBBLE.loseRadius);
  });

  it('STOP_FACE_GOAL: stops and turns to face the attacked goal with the ball in front', () => {
    // Team 0 attacks +x; he runs toward his own goal (-x) at 5 m/s.
    const s = skillScene({ x: 10, z: 6, vx: -5, fx: -1, fz: 0 });
    const p = s.players[SKILLER]!;
    runMove(s, SkillMove.STOP_FACE_GOAL, 0, 0);
    const gx = s.teams[0]!.dir * HALF_LENGTH - p.x, gz = -p.z;
    const gl = speed(gx, gz);
    expect(p.fx * gx / gl + p.fz * gz / gl).toBeGreaterThan(0.98);
    expect(speed(p.vx, p.vz)).toBeLessThan(0.3);
    const rel = ballRel(s, SKILLER, p.fx, p.fz);
    expect(rel.along).toBeGreaterThan(0.25);
    expect(Math.abs(rel.side)).toBeLessThan(0.15);
  });

  it('HARD_STOP kills the speed faster than STOP_BALL (both stop a sprinter dead within the move)', () => {
    const until = (k: SkillMove): number => {
      const s = skillScene({ vx: 8 });
      const p = s.players[SKILLER]!;
      startSkill(s, SKILLER, k, 0, 0, recorder());
      let n = 0;
      runTicks(s, 30, undefined, { until: () => (++n, speed(p.vx, p.vz) < 0.2) });
      return n;
    };
    const hard = until(SkillMove.HARD_STOP), stop = until(SkillMove.STOP_BALL);
    expect(hard).toBeLessThan(stop);
    expect(hard).toBeLessThanOrEqual(T_SKILL.duration[SkillMove.HARD_STOP]!);
    expect(stop).toBeLessThanOrEqual(T_SKILL.duration[SkillMove.STOP_BALL]!);
  });

  it('agility changes the exit run (faster out of a step-over at 99 than at 1)', () => {
    const out = (agility: number): number => {
      const s = skillScene({ vx: 3 });
      s.attrs[SKILLER]!.agility = agility;
      const p = s.players[SKILLER]!;
      const r = runMove(s, SkillMove.STEP_OVER, 0, 1, stick(0, 1));
      return p.vx * r.ex + p.vz * r.ez;
    };
    expect(out(99)).toBeGreaterThan(out(1) + 0.5);
  });
});

// ---------------------------------------------------------------- from the controls

describe('SIM-13 started from the controls (SIM-15 resolver -> startSkill / startFake)', () => {
  it('frame.skill BALL_ROLL with the stick to the right: SKILL event, ball rolled to his right', () => {
    const s = skillScene({ vx: 2 });
    const p = s.players[SKILLER]!;
    const ev = runTicks(s, 2, (t, _s, out) => { out[0]!.mz = 127; out[0]!.skill = t === 1 ? SkillMove.BALL_ROLL : 0; });
    expect(findEvents(ev, EventType.SKILL)).toEqual([expect.objectContaining({ a: SKILLER, b: SkillMove.BALL_ROLL })]);
    expect(p.act).toBe(ActionKind.SKILL);
    runTicks(s, T_SKILL.duration[SkillMove.BALL_ROLL]!, stick(0, 1), { check: 'core' });
    expect(p.act).toBe(ActionKind.NONE);
    expect(ballRel(s, SKILLER, 0, 1).along).toBeGreaterThan(0.2);
    expect(s.ball.owner).toBe(SKILLER);
  });

  it('knock-on: SPRINT + right-stick flick pushes the ball far ahead toward the flick', () => {
    const s = skillScene({ vx: 6 });
    const ev = runTicks(s, 20, (t, _s, out) => {
      out[0]!.mx = 127;
      out[0]!.buttons = Btn.SPRINT | (t === 1 ? Btn.RS_FLICK : 0);
      out[0]!.ax = t === 1 ? 127 : 0;
    }, { check: 'core' });
    expect(findEvents(ev, EventType.SKILL)).toEqual([expect.objectContaining({ a: SKILLER, b: SkillMove.KNOCK_ON })]);
    expect(findEvents(ev, EventType.KICK, (e) => e.b === KickKind.KNOCK_ON)).toHaveLength(1);
    expect(s.ball.x - s.players[SKILLER]!.x).toBeGreaterThan(1);
    expect(s.ball.vx).toBeGreaterThan(6);
  });

  it('fake pass: PASS pressed during a lob wind-up converts it (resolver convertPresses -> startFake); the stick picks the cut', () => {
    const s = skillScene({ vx: 2 });
    const p = s.players[SKILLER]!;
    Object.assign(p, { act: ActionKind.KICK, actKick: KickKind.LOB_PASS, actT: 3, actDur: 30, actContact: 12, actDone: 0, actCharging: 1 });
    s.ctrl[0]!.buttons = Btn.LOB; // Square held (the lob's power bar), Cross pressed now
    const ev = runTicks(s, 1, (_t, _s, out) => { out[0]!.buttons = Btn.LOB | Btn.PASS; out[0]!.mz = -127; });
    expect(p.act).toBe(ActionKind.FAKE);
    expect(findEvents(ev, EventType.SKILL)).toEqual([expect.objectContaining({ a: SKILLER, b: SkillMove.FAKE_SHOT })]);
    expect(p.actDirZ).toBeLessThan(-0.9); // cut to his left (-z when facing +x)
  });
});

// ---------------------------------------------------------------- gating and refusals

describe('SIM-13 star gating', () => {
  for (const k of ALL) {
    const need = T_SKILL.minStars[k]!;
    it(`${name(k)} needs ${need} skill stars`, () => {
      const s = skillScene({ stars: need - 1 });
      const h = hashState(s);
      const rec = recorder();
      expect(startSkill(s, SKILLER, k, 0, 1, rec)).toBe(0);
      expect(rec.events).toHaveLength(0);
      expect(hashState(s)).toBe(h);
      s.attrs[SKILLER]!.skillMoves = need;
      expect(startSkill(s, SKILLER, k, 0, 1, rec)).toBe(1);
      expect(s.players[SKILLER]!.act).toBe(ActionKind.SKILL);
    });
  }

  it('the harder moves (roulette, heel flick) need 3 stars; 2-star players still have the basics', () => {
    const s = skillScene({ stars: 2 });
    expect(startSkill(s, SKILLER, SkillMove.ROULETTE, 0, 1, recorder())).toBe(0);
    expect(startSkill(s, SKILLER, SkillMove.HEEL_FLICK, 0, 1, recorder())).toBe(0);
    expect(startSkill(s, SKILLER, SkillMove.STEP_OVER, 0, 1, recorder())).toBe(1);
  });
});

describe('SIM-13 refusals leave the state untouched', () => {
  const cases: [string, (s: SimState) => void, SkillMove?][] = [
    ['not the ball owner', (s) => { s.ball.owner = -1; }],
    ['an opponent owns the ball', (s) => { s.ball.owner = OPP; }],
    ['ball in a keeper\'s hands', (s) => { s.ball.heldBy = SKILLER; }],
    ['ball out of reach', (s) => { s.ball.x += 2; }],
    ['knock-on: ball beyond the knock-on reach', (s) => { s.ball.x += 3; }, SkillMove.KNOCK_ON],
    ['ball in the air', (s) => { s.ball.y = 1.2; }],
    ['busy in another action', (s) => { Object.assign(s.players[SKILLER]!, { act: ActionKind.KICK, actDur: 20 }); }],
    ['stunned', (s) => { s.players[SKILLER]!.stunT = 5; }],
    ['not on the pitch', (s) => { s.players[SKILLER]!.active = 0; }],
    ['not in play (throw-in)', (s) => { s.match.phase = MatchPhase.THROW_IN; }],
  ];
  for (const [label, mut, k] of cases) {
    it(label, () => {
      const s = skillScene();
      mut(s);
      const h = hashState(s);
      const rec = recorder();
      expect(startSkill(s, SKILLER, k ?? SkillMove.STEP_OVER, 0, 1, rec)).toBe(0);
      expect(rec.events).toHaveLength(0);
      expect(hashState(s)).toBe(h);
    });
  }

  it('bad slots and move indices', () => {
    const s = skillScene();
    const h = hashState(s);
    for (const slot of [-1, 22, 1.5, NaN]) expect(startSkill(s, slot, SkillMove.STEP_OVER, 0, 1, recorder())).toBe(0);
    for (const k of [0, 12, 2.5, -3, NaN]) expect(startSkill(s, SKILLER, k as SkillMove, 0, 1, recorder())).toBe(0);
    expect(hashState(s)).toBe(h);
    expect(inSkillVulnerableWindow(s, -1)).toBe(false);
    expect(inSkillVulnerableWindow(s, 99)).toBe(false);
  });

  it('a non-finite request direction counts as "facing"', () => {
    const s = skillScene();
    expect(startSkill(s, SKILLER, SkillMove.KNOCK_ON, NaN, Infinity, recorder())).toBe(1);
    const p = s.players[SKILLER]!;
    expect(p.actDirX).toBeCloseTo(1, 9);
    expect(p.actDirZ).toBeCloseTo(0, 9);
  });
});

// ---------------------------------------------------------------- vulnerable windows

describe('SIM-13 vulnerable windows', () => {
  for (const k of ALL) {
    const vs = T_SKILL.vulnStart[k]!, ve = T_SKILL.vulnEnd[k]!;
    it(`${name(k)}: inSkillVulnerableWindow exactly while ${vs} <= actT < ${ve}`, () => {
      const s = skillScene({ vx: 3 });
      const p = s.players[SKILLER]!;
      startSkill(s, SKILLER, k, 0, 1, recorder());
      const seen: [number, boolean][] = [];
      runTicks(s, T_SKILL.duration[k]!, isStop(k) ? undefined : stick(0, 1), {
        until: (st) => { seen.push([p.act === ActionKind.SKILL ? p.actT : -1, inSkillVulnerableWindow(st, SKILLER)]); return false; },
      });
      expect(seen).toHaveLength(T_SKILL.duration[k]!);
      for (const [t, w] of seen) expect(w).toBe(t >= vs && t < ve);
    });
  }

  it('FAKE uses the fake-shot window; players not in a skill are never vulnerable', () => {
    const s = skillScene({ vx: 2 });
    const p = s.players[SKILLER]!;
    expect(inSkillVulnerableWindow(s, SKILLER)).toBe(false);
    Object.assign(p, { act: ActionKind.SHOT, actKick: KickKind.SHOT_NORMAL, actT: 2, actDur: 25, actContact: 10, actDone: 0 });
    expect(inSkillVulnerableWindow(s, SKILLER)).toBe(false);
    expect(startFake(s, SKILLER, recorder())).toBe(1);
    const vs = T_SKILL.vulnStart[SkillMove.FAKE_SHOT]!, ve = T_SKILL.vulnEnd[SkillMove.FAKE_SHOT]!;
    for (let t = 1; t < T_SKILL.duration[SkillMove.FAKE_SHOT]!; t++) {
      runTicks(s, 1);
      expect(p.act).toBe(ActionKind.FAKE);
      expect(inSkillVulnerableWindow(s, SKILLER)).toBe(t >= vs && t < ve);
    }
    expect(inSkillVulnerableWindow(s, OPP)).toBe(false);
  });
});

describe('SIM-13 the ball can be won only in the window', () => {
  it('ball roll into a defender: he wins it inside the window (POSSESSION, the move ends, the skiller cannot touch at once)', () => {
    const s = skillScene({ opp: { x: 0.3, z: 1.15 } });
    const p = s.players[SKILLER]!;
    startSkill(s, SKILLER, SkillMove.BALL_ROLL, 0, 1, recorder());
    let wonAt = -1;
    const ev = runTicks(s, T_SKILL.duration[SkillMove.BALL_ROLL]!, undefined, {
      check: 'core',
      until: (st) => {
        if (st.ball.owner === OPP && wonAt < 0) wonAt = st.tick;
        return wonAt >= 0;
      },
    });
    expect(wonAt).toBeGreaterThan(0);
    expect(p.act).toBe(ActionKind.NONE);
    const vs = T_SKILL.vulnStart[SkillMove.BALL_ROLL]!, ve = T_SKILL.vulnEnd[SkillMove.BALL_ROLL]!;
    // The move started before tick 1, so the tick number is the move's actT.
    expect(wonAt).toBeGreaterThanOrEqual(vs);
    expect(wonAt).toBeLessThan(ve);
    expect(findEvents(ev, EventType.POSSESSION, (e) => e.a === 1 && e.b === OPP)).toHaveLength(1);
    expect(p.noTouchT).toBeGreaterThan(T_DRIBBLE.dispossessedNoTouch - 3);
    runTicks(s, 10, undefined, { check: 'core' });
    expect(s.ball.owner).toBe(OPP);
  });

  it('roulette beside a defender: protected before the window, won once it opens', () => {
    const s = skillScene({ opp: { x: 0.75, z: 0.3 } });
    startSkill(s, SKILLER, SkillMove.ROULETTE, 0, 1, recorder());
    let wonAt = -1;
    runTicks(s, T_SKILL.duration[SkillMove.ROULETTE]!, undefined, {
      check: 'core',
      until: (st) => { if (st.ball.owner !== SKILLER && wonAt < 0) wonAt = st.tick; return wonAt >= 0; },
    });
    expect(wonAt).toBeGreaterThanOrEqual(T_SKILL.vulnStart[SkillMove.ROULETTE]!);
    expect(wonAt).toBeLessThan(T_SKILL.vulnEnd[SkillMove.ROULETTE]!);
    expect(s.ball.owner).toBe(OPP);
  });

  it('a teammate on the path never takes it', () => {
    const s = skillScene({ mate: { x: 0.3, z: 1.15 } });
    const p = s.players[SKILLER]!;
    startSkill(s, SKILLER, SkillMove.BALL_ROLL, 0, 1, recorder());
    runTicks(s, T_SKILL.duration[SkillMove.BALL_ROLL]!, undefined, { check: 'core', until: () => s.ball.owner !== SKILLER });
    expect(s.ball.owner).toBe(SKILLER);
    expect(p.act).toBe(ActionKind.NONE);
    expect(s.players[MATE]!.act).toBe(ActionKind.NONE);
  });

  it('a skiller whose ball is taken by someone else (e.g. a SIM-14 tackle) stops the move at once', () => {
    const s = skillScene({ opp: { x: 2, z: 0 } });
    const p = s.players[SKILLER]!;
    startSkill(s, SKILLER, SkillMove.ROULETTE, 0, 1, recorder());
    runTicks(s, 5);
    expect(p.act).toBe(ActionKind.SKILL);
    s.ball.owner = OPP; // as a tackle would via takePossession
    runTicks(s, 1);
    expect(p.act).toBe(ActionKind.NONE);
    expect(p.moveMode).not.toBe(MoveMode.LOCKED);
  });

  it('a SKILL set up by hand (no start facing / exit) or corrupted mid-move ends at once, never scripting NaNs', () => {
    const s = skillScene({ vx: 3 });
    const p = s.players[SKILLER]!;
    Object.assign(p, { act: ActionKind.SKILL, actSkill: SkillMove.STEP_OVER, actT: 0, actDur: 26, actContact: -1, actX: 0, actZ: 0 });
    runTicks(s, 1, undefined, { check: 'core' });
    expect(p.act).toBe(ActionKind.NONE);
    const s2 = skillScene({ vx: 3 });
    const p2 = s2.players[SKILLER]!;
    startSkill(s2, SKILLER, SkillMove.ROULETTE, 0, 1, recorder());
    runTicks(s2, 3, undefined, { check: 'core' });
    p2.actDirX = NaN;
    runTicks(s2, 1, undefined, { check: 'core' });
    expect(p2.act).toBe(ActionKind.NONE);
    expect(Number.isFinite(p2.fx) && Number.isFinite(p2.vx) && Number.isFinite(s2.ball.vx)).toBe(true);
  });

  it('a phase change (ball out of play) ends the move', () => {
    const s = skillScene();
    const p = s.players[SKILLER]!;
    startSkill(s, SKILLER, SkillMove.STEP_OVER, 0, 1, recorder());
    runTicks(s, 3);
    s.match.phase = MatchPhase.THROW_IN;
    runTicks(s, 1);
    expect(p.act).toBe(ActionKind.NONE);
  });
});

// ---------------------------------------------------------------- fake shot

describe('SIM-13 fake shot / fake pass', () => {
  function windingUp(act = ActionKind.SHOT, kick = KickKind.SHOT_NORMAL): SimState {
    const s = skillScene({ vx: 3 });
    Object.assign(s.players[SKILLER]!, {
      act, actKick: kick, actT: 6, actDur: 25, actContact: 10, actDone: 0, actCharging: 1, actPower: 0.6, moveMode: MoveMode.LOCKED,
    });
    return s;
  }

  it('converts a SHOT wind-up (power bar charging) into the fake: no ball struck, ball cut along the stick and kept', () => {
    const s = windingUp();
    const p = s.players[SKILLER]!;
    const rec = recorder();
    s.ctrl[0]!.mx = 0; s.ctrl[0]!.mz = 1; s.ctrl[0]!.stickIdleT = 0;
    expect(startFake(s, SKILLER, rec)).toBe(1);
    expect(rec.events).toEqual([[EventType.SKILL, SKILLER, SkillMove.FAKE_SHOT]]);
    expect(p.act).toBe(ActionKind.FAKE);
    expect(p.actCharging).toBe(0);
    expect(p.actKick).toBe(KickKind.NONE);
    const ex = p.actDirX, ez = p.actDirZ;
    expect(ez).toBeGreaterThan(0.9); // cut to his right
    let n = 0;
    const ev = runTicks(s, 40, stick(ex, ez), { check: 'core', until: () => (++n, p.act !== ActionKind.FAKE) });
    expect(n).toBe(T_SKILL.duration[SkillMove.FAKE_SHOT]!);
    expect(findEvents(ev, EventType.SHOT)).toHaveLength(0);
    expect(findEvents(ev, EventType.KICK, (e) => isShotKind(e.b))).toHaveLength(0);
    expect(s.ball.shotBy).toBe(-1);
    expect(s.ball.owner).toBe(SKILLER);
    const rel = ballRel(s, SKILLER, ex, ez);
    expect(rel.along).toBeGreaterThan(0.2);
    expect(rel.dist).toBeLessThan(1.5);
  });

  it('refused after contact, without the ball, outside a kick wind-up, out of play or with no skill stars', () => {
    const cases: [string, (s: SimState) => void][] = [
      ['after contact', (s) => { s.players[SKILLER]!.actDone = 1; }],
      ['first-time kick (ball not his)', (s) => { s.ball.owner = -1; }],
      ['header', (s) => { s.players[SKILLER]!.act = ActionKind.HEADER; }],
      ['no action', (s) => { s.players[SKILLER]!.act = ActionKind.NONE; }],
      ['skill already running', (s) => { s.players[SKILLER]!.act = ActionKind.SKILL; }],
      ['out of play', (s) => { s.match.phase = MatchPhase.CORNER; }],
      ['no skill stars', (s) => { s.attrs[SKILLER]!.skillMoves = 0; }],
      ['stunned', (s) => { s.players[SKILLER]!.stunT = 3; }],
    ];
    for (const [label, mut] of cases) {
      const s = windingUp();
      mut(s);
      const h = hashState(s);
      const rec = recorder();
      expect(startFake(s, SKILLER, rec), label).toBe(0);
      expect(rec.events, label).toHaveLength(0);
      expect(hashState(s), label).toBe(h);
    }
    expect(startFake(skillScene(), -1, recorder())).toBe(0);
  });

  it('fake from a lob wind-up with the stick released cuts to the preferred foot side', () => {
    for (const foot of [0, 1]) {
      const s = windingUp(ActionKind.KICK, KickKind.LOB_PASS);
      s.attrs[SKILLER]!.foot = foot;
      s.ctrl[0]!.stickIdleT = 5;
      s.players[SKILLER]!.moveMode = MoveMode.LOCKED;
      expect(startFake(s, SKILLER, recorder())).toBe(1);
      expect(Math.sign(s.players[SKILLER]!.actDirZ)).toBe(foot === 0 ? 1 : -1);
    }
  });
});

// ---------------------------------------------------------------- no ball stuck (glitch list)

describe('SIM-13 no ball stuck after skills', () => {
  for (const k of ALL) {
    it(`glitch "Ball stuck: between two players": after ${name(k)} the dribbler carries on with the ball`, () => {
      const s = skillScene({ vx: 4 });
      const p = s.players[SKILLER]!;
      const knock = k === SkillMove.KNOCK_ON;
      const r = runMove(s, k, 0.6, 0.8, isStop(k) ? undefined : stick(0.6, 0.8));
      const ex = isStop(k) ? r.f0x : r.ex, ez = isStop(k) ? r.f0z : r.ez;
      const x0 = s.ball.x, z0 = s.ball.z;
      let maxIdle = 0;
      const ev = runTicks(s, knock ? 240 : 90, stick(ex, ez, knock ? Btn.SPRINT : 0), {
        check: 'core',
        until: (st) => { if (st.ball.idleT > maxIdle) maxIdle = st.ball.idleT; return knock && st.ball.owner === SKILLER; },
      });
      expect(s.ball.owner).toBe(SKILLER);
      expect(p.act).not.toBe(ActionKind.SKILL);
      // Touched at least every 45 ticks (the knock-on's ball runs free until he gets back to it: he must, by sprinting).
      expect(maxIdle).toBeLessThan(knock ? 180 : 45);
      expect(speed(s.ball.x - x0, s.ball.z - z0)).toBeGreaterThan(knock ? 0.5 : 3);
      expect(ballRel(s, SKILLER, ex, ez).dist).toBeLessThan(T_DRIBBLE.loseRadius);
      expect(findEvents(ev, EventType.WATCHDOG)).toHaveLength(0);
    });

    it(`glitch "Ball stuck: between two players": ${name(k)} into a standing defender never pins the ball`, () => {
      const [ex, ez] = expectedExit(k, 1);
      const s = skillScene({ vx: 3, opp: { x: 1.3 * ex + 0.2, z: 1.3 * ez } });
      startSkill(s, SKILLER, k, 0, 1, recorder());
      // An owned ball may rest at its owner's feet and a loose one may roll on; a loose, (nearly) still ball must not
      // lie by a body for long (SIM-06 squirts one out after 45 idle ticks).
      let run = 0, worst = 0;
      const ev = runTicks(s, 150, stick(ex, ez), {
        check: 'core',
        until: (st) => {
          const b = st.ball;
          let near = false;
          for (const q of st.players) if (q.active === 1 && Math.hypot(q.x - b.x, q.z - b.z) < 1) near = true;
          run = b.owner < 0 && Math.hypot(b.vx, b.vz) < 0.3 && b.y < 0.2 && near ? run + 1 : 0;
          if (run > worst) worst = run;
          return false;
        },
      });
      expect(worst).toBeLessThan(60);
      expect(findEvents(ev, EventType.WATCHDOG)).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------- determinism

describe('SIM-13 determinism', () => {
  function session(): number[] {
    const s = skillScene({ vx: 3, opp: { x: 6, z: 2 } });
    const hashes: number[] = [];
    const moves = [SkillMove.BALL_ROLL, SkillMove.STEP_OVER, SkillMove.ROULETTE, SkillMove.DRAG_BACK, SkillMove.BODY_FEINT,
      SkillMove.HEEL_FLICK, SkillMove.FAKE_SHOT, SkillMove.STOP_BALL];
    runTicks(s, 400, (t, _s, out) => {
      const f = out[0]!;
      f.mx = Math.round(127 * Math.cos(t * 0.05)); f.mz = Math.round(127 * Math.sin(t * 0.05));
      if (t % 40 === 5) f.skill = moves[((t / 40) | 0) % moves.length]!;
      if (t === 330) { f.buttons = Btn.SPRINT | Btn.RS_FLICK; f.ax = 127; }
    }, { check: 'core', until: (st) => { hashes.push(hashState(st)); return false; } });
    return hashes;
  }

  it('same seed and inputs: identical hash every tick across runs', () => {
    const a = session();
    const b = session();
    expect(a).toHaveLength(400);
    expect(b).toEqual(a);
  });

  for (const k of ALL) {
    it(`${name(k)}: a clone taken mid-move continues identically (all move state lives in SimState)`, () => {
      const s = skillScene({ vx: 5, opp: { x: 1.5, z: 1.2 } });
      startSkill(s, SKILLER, k, 0, 1, recorder());
      runTicks(s, Math.max(1, T_SKILL.vulnStart[k]! - 1), stick(0, 1));
      const c = cloneState(s);
      expect(hashState(c)).toBe(hashState(s));
      const ha: number[] = [], hb: number[] = [];
      runTicks(s, 40, stick(0, 1), { until: (st) => { ha.push(hashState(st)); return false; } });
      runTicks(c, 40, stick(0, 1), { until: (st) => { hb.push(hashState(st)); return false; } });
      expect(hb).toEqual(ha);
    });
  }
});
