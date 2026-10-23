/**
 * SGN-02 controls audit: the section 9 touch rows that had no device-to-sim test, or only a mocked or weak one, end to
 * end: the REAL touch source (tests/unit/qf-3-touch-rig.ts: pointer manager, stick, attack and defence clusters,
 * pitch gestures, set-piece swipe, mapper) feeding the real step() pipeline with the real kickers (SIM-08..12),
 * skills (SIM-13), tackles (SIM-14), keeper (GKP) and switching (SIM-16). Nothing is mocked. Each test is named after
 * its row (docs/CONTROLS_AUDIT.md maps every section 9 / 10 row to its tests).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AutoSwitch, KickKind, MatchPhase, RestartKind, SkillMove } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { createDefaultSettings } from '../../src/contracts/settings';
import type { SimState } from '../../src/contracts/state';
import { ClusterSlot } from '../../src/contracts/touch';
import { BALL_RADIUS, GOAL_HALF_WIDTH } from '../../src/contracts/constants';
import { humanController } from '../../src/modes/setup';
import { createLaunchSolution, solveLaunchSpin } from '../../src/sim/ball/flight';
import { NULL_SINK } from '../../src/sim/core/events';
import { aerialChance } from '../../src/sim/kicks/aerial';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario, type ScenarioHuman } from '../harness/scenario';
import { centreOn, createTouchRig, scr, type TouchRig } from '../unit/qf-3-touch-rig';

const P = 9;

/** Everyone parked far away except the actors; CPU brains off. */
function park(s: SimState, keep: number[]): void {
  for (let i = 0; i < 22; i++) {
    if (keep.includes(i)) continue;
    const p = s.players[i]!;
    const team = i < 11 ? 0 : 1;
    p.vx = 0; p.vz = 0;
    if (i % 11 === 0) { p.x = team === 0 ? -50 : 50; p.z = 0; continue; }
    p.x = team === 0 ? -40 : 40; p.z = -30 + (i % 11) * 5.5;
  }
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
}

/** P1 controls #9 with the ball at (x, z); teammate #10 at (mx, mz). */
function attack(x = 10, z = 0, mx = 25, mz = -8, human: Partial<ScenarioHuman> = {}, seed?: number): SimState {
  const s = makeScenario({
    seed, phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: P, ...human }],
    players: [{ slot: P, x, z, fx: 1, fz: 0 }, { slot: 10, x: mx, z: mz }],
    ball: { owner: P, x: x + 0.4, y: 0.11, z, lastTouchTeam: 0, lastTouch: P },
  });
  park(s, [P, 10]);
  s.attrs[P]!.skillMoves = 5;
  return s;
}

/** P1 controls #4 at (dx, dz); the away #18 carries the ball at (cx, cz) and is pinned there before each tick. */
function defence(dx: number, dz: number, cx: number, cz = 0, cvx = 0): { r: TouchRig; s: SimState; pin: () => void } {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: dx, z: dz, fx: 1, fz: 0 }, { slot: 18, x: cx, z: cz, fx: -1, fz: 0, vx: cvx }, { slot: 5, x: -10, z: -15 }],
    ball: { owner: 18, lastTouchTeam: 1, lastTouch: 18, x: cx - 0.5, y: 0.11, z: cz },
  });
  park(s, [4, 18, 5]);
  const r = createTouchRig(s);
  const pin = (): void => {
    const q = s.players[18]!;
    if (s.ball.owner !== 18) return;
    q.x = cx; q.z = cz; q.vx = cvx; q.vz = 0; q.fx = -1; q.fz = 0;
    s.ball.x = cx - 0.5; s.ball.z = cz; s.ball.vx = cvx; s.ball.vz = 0;
  };
  return { r, s, pin };
}

/** Press a cluster slot for `ms` (a tap below the tap time, a hold above it) with finger 2. */
function press(r: TouchRig, slot: ClusterSlot, ms: number): void {
  const p = r.slot(slot);
  r.down(2, p.x, p.y);
  r.wait(ms);
  r.up(2, p.x, p.y);
}

/** A 40 px button swipe from the slot centre (dx, dy = screen direction). */
function swipeBtn(r: TouchRig, slot: ClusterSlot, dx: number, dy: number): void {
  const p = r.slot(slot);
  r.down(2, p.x, p.y);
  r.wait(17); r.move(2, p.x + dx * 14, p.y + dy * 14);
  r.wait(17); r.move(2, p.x + dx * 40, p.y + dy * 40);
  r.wait(17); r.up(2, p.x + dx * 40, p.y + dy * 40);
}

function tap(r: TouchRig, x: number, y: number, id = 30): void {
  r.down(id, x, y); r.wait(50); r.up(id, x, y);
}
function doubleTap(r: TouchRig, x: number, y: number): void {
  tap(r, x, y); r.wait(80); tap(r, x + 2, y + 2);
}

/** A pitch swipe through `pts` over `ms` (finger 31), optionally bent sideways by `bend` px at its middle. */
function swipe(r: TouchRig, x0: number, y0: number, x1: number, y1: number, ms: number, bend = 0, id = 31): void {
  r.down(id, x0, y0);
  const steps = 8;
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
  for (let i = 1; i <= steps; i++) {
    r.wait(ms / steps);
    const k = i / steps, off = bend * 4 * k * (1 - k);
    r.move(id, x0 + dx * k + (-dy / len) * off, y0 + dy * k + (dx / len) * off);
  }
  r.up(id, x1, y1);
}

/**
 * Tick until the ball reaches the goal line (x = 52.5) with the away keeper pinned out of the way; the ball height there
 * (interpolated), or -1 if it never gets there.
 */
function heightAtGoalLine(r: TouchRig, n = 150): number {
  const s = r.s;
  for (let i = 0; i < n; i++) {
    const k = s.players[s.teams[1]!.keeperSlot]!;
    k.x = 52; k.z = 28; k.vx = 0; k.vz = 0;
    const px = s.ball.x, py = s.ball.y;
    r.tick();
    if (s.ball.x >= 52.5) return py + (s.ball.y - py) * ((52.5 - px) / (s.ball.x - px));
  }
  return -1;
}

const kicksBy = (r: TouchRig, slot: number): SimEvent[] => r.events.filter((e) => e.type === EventType.KICK && e.a === slot);

/** Tick until `slot` kicks (KICK event); returns the kick event and the ball velocity right after it, or null. */
function untilKick(r: TouchRig, slot: number, n = 60): { e: SimEvent; vy: number; speed: number; act: ActionKind; kind: KickKind; curve: number; tx: number; tz: number; target: number } | null {
  let act = ActionKind.NONE, kind = KickKind.NONE, curve = 0, tx = 0, tz = 0, target = -1;
  for (let i = 0; i < n; i++) {
    const before = r.events.length;
    r.tick();
    const p = r.s.players[slot]!;
    if (p.act !== ActionKind.NONE && p.act !== ActionKind.SHIELD && p.actKick !== KickKind.NONE) {
      act = p.act; kind = p.actKick; curve = p.actCurve; tx = p.actX; tz = p.actZ; target = p.actSlot;
    }
    for (let k = before; k < r.events.length; k++) {
      const e = r.events[k]!;
      if (e.type === EventType.KICK && e.a === slot) {
        const b = r.s.ball;
        return { e, vy: b.vy, speed: Math.hypot(b.vx, b.vy, b.vz), act, kind, curve, tx, tz, target };
      }
    }
  }
  return null;
}

// =================================================================================================== attack buttons

describe('SGN-02 section 9 attack buttons (real touch source -> real sim)', () => {
  for (const [label, slot, x] of [
    ['PASS', ClusterSlot.LOW, 10],
    ['THROUGH', ClusterSlot.MID, 10],
    ['SHOOT', ClusterSlot.HIGH, 30],
  ] as const) {
    it(`${label} hold for power: a 450 ms hold strikes clearly harder than a tap`, () => {
      const power: number[] = [];
      const speed: number[] = [];
      for (const ms of [50, 450]) {
        const r = createTouchRig(attack(x));
        r.tick(2);
        press(r, slot, ms);
        const k = untilKick(r, P);
        expect(k, `${label} ${ms} ms kicked`).not.toBeNull();
        power.push(k!.e.c);
        speed.push(k!.speed);
      }
      expect(power[1]!).toBeGreaterThan(power[0]! + 0.15);
      expect(speed[1]!).toBeGreaterThan(speed[0]!);
    });
  }

  /** P1's striker #9 under a cross from teammate #7 (the PAD-02 aerial scenes): header at (41, 0), volley at (38, 2). */
  function aerial(kind: 'header' | 'volley'): SimState {
    const [px, pz] = kind === 'header' ? [41, 0] : [38, 2];
    const s = makeScenario({
      phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: P, autoSwitch: AutoSwitch.OFF }],
      players: [{ slot: P, x: px, z: pz, fx: 1, fz: 0 }],
    });
    park(s, [P, 7]);
    for (let i = 12; i < 22; i++) { s.players[i]!.x = -36; s.players[i]!.z = -30 + (i - 11) * 5.5; }
    s.players[11]!.x = 51;
    const [fx, fz, tx, tz, ang] = kind === 'header' ? [38, -28, 42, 0, 0.5] : [28, -18, 39.5, 2, 0.24];
    const crosser = s.players[7]!;
    crosser.x = fx - 0.8; crosser.z = fz;
    const sol = createLaunchSolution();
    solveLaunchSpin(tx - fx, tz - fz, ang, BALL_RADIUS, 0, 0, sol);
    const b = s.ball;
    b.x = fx; b.y = BALL_RADIUS; b.z = fz; b.px = fx; b.py = BALL_RADIUS; b.pz = fz;
    b.vx = sol.vx; b.vy = sol.vy; b.vz = sol.vz; b.sx = 0; b.sy = 0; b.sz = 0;
    b.grounded = 0; b.bounces = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0;
    b.lastTouch = 7; b.lastTouchTeam = 0; b.lastTouchTick = s.tick; b.touchedTick = s.tick;
    b.lastKickBy = 7; b.lastKickTeam = 0; b.lastKickKind = KickKind.CROSS; b.lastKickTick = s.tick;
    b.passTarget = -1; b.shotBy = -1;
    return s;
  }

  for (const [kind, act] of [['header', ActionKind.HEADER], ['volley', ActionKind.VOLLEY]] as const) {
    it(`SHOOT tap or hold = shot, volley or header: a ball arriving at ${kind} height is a ${kind}`, () => {
      // Dry run: the first tick #9 has an aerial chance.
      const dry = createTouchRig(aerial(kind));
      let chanceTick = -1;
      for (let i = 0; i < 150 && chanceTick < 0; i++) { dry.tick(); if (aerialChance(dry.s, P) > 0) chanceTick = dry.s.tick; }
      expect(chanceTick).toBeGreaterThan(0);
      // Real run: SHOOT goes down a few ticks before the chance and is held through it (power charges).
      const r = createTouchRig(aerial(kind));
      const p = r.slot(ClusterSlot.HIGH);
      let got = ActionKind.NONE;
      for (let i = 0; i < 150 && got === ActionKind.NONE; i++) {
        if (r.s.tick === chanceTick - 4) r.down(2, p.x, p.y);
        if (r.s.tick === chanceTick + 8) r.up(2, p.x, p.y);
        r.tick();
        const a = r.s.players[P]!.act;
        if (a === ActionKind.HEADER || a === ActionKind.VOLLEY) got = a;
      }
      expect(ActionKind[got]).toBe(ActionKind[act]);
    });
  }

  it('SHOOT swipe left: fake shot - a skill FAKE_SHOT, no shot is struck and the ball stays at his feet', () => {
    const r = createTouchRig(attack(30));
    r.tick(2);
    swipeBtn(r, ClusterSlot.HIGH, -1, 0);
    let faked = false;
    for (let i = 0; i < 45; i++) { r.tick(); if (r.s.players[P]!.act === ActionKind.FAKE) faked = true; }
    expect(faked).toBe(true);
    expect(r.events.some((e) => e.type === EventType.SKILL && e.a === P && e.b === SkillMove.FAKE_SHOT)).toBe(true);
    expect(r.events.some((e) => e.type === EventType.SHOT)).toBe(false);
    // Only the fake's own touch and dribble touches: no pass or shot left his foot.
    expect(kicksBy(r, P).map((e) => KickKind[e.b]).filter((k) => k !== 'SKILL_TOUCH' && k !== 'DRIBBLE_TOUCH')).toEqual([]);
    expect(r.s.ball.owner).toBe(P);
  });

  it('SPRINT & SKILL hold to sprint: with the stick pushed he sprints (faster than the same push without it)', () => {
    const run = (sprint: boolean): { want: number; dx: number; v: number; own: number } => {
      const r = createTouchRig(attack(-20));
      r.tick(2);
      r.down(1, 250, 520); r.move(1, 330, 520);
      const big = r.slot(ClusterSlot.BIG);
      if (sprint) r.down(2, big.x, big.y);
      const x0 = r.s.players[P]!.x;
      r.tick(90);
      const p = r.s.players[P]!;
      return { want: p.wantSprint, dx: p.x - x0, v: Math.hypot(p.vx, p.vz), own: r.s.ball.owner };
    };
    const sprint = run(true), jog = run(false);
    expect(sprint.want).toBe(1);
    expect(jog.want).toBe(0);
    expect(sprint.own).toBe(P); // still dribbling
    expect(sprint.v).toBeGreaterThan(jog.v + 1.5); // past jog top speed (~5.5 m/s)
    expect(sprint.dx).toBeGreaterThan(jog.dx);
  });

  it('Skill slots are editable in settings: tap, swipe up and swipe right play the moves chosen in the controls editor', () => {
    const cases: [string, (r: TouchRig) => void][] = [
      ['tap', (r) => press(r, ClusterSlot.BIG, 50)],
      ['up', (r) => swipeBtn(r, ClusterSlot.BIG, 0, -1)],
      ['right', (r) => swipeBtn(r, ClusterSlot.BIG, 1, 0)],
    ];
    for (const [label, act] of cases) {
      const r = createTouchRig(attack());
      r.updateSettings((t) => { t.skillTap = SkillMove.BALL_ROLL; t.skillUp = SkillMove.DRAG_BACK; t.skillRight = SkillMove.BODY_FEINT; });
      r.tick(2);
      act(r);
      r.tick(30);
      const want = label === 'tap' ? SkillMove.BALL_ROLL : label === 'up' ? SkillMove.DRAG_BACK : SkillMove.BODY_FEINT;
      const skills = r.events.filter((e) => e.type === EventType.SKILL && e.a === P).map((e) => SkillMove[e.b]);
      expect(skills, label).toEqual([SkillMove[want]]);
    }
  });
});

// ================================================================================================== defence buttons

describe('SGN-02 section 9 defence buttons (real touch source -> real sim)', () => {
  function actsWhile(r: TouchRig, pin: () => void, slot: number, n: number): Set<ActionKind> {
    const seen = new Set<ActionKind>();
    for (let i = 0; i < n; i++) { pin(); r.tick(); seen.add(r.s.players[slot]!.act); }
    return seen;
  }

  it('SPRINT & TACKLE tap: push or pull when chasing (from behind the carrier)', () => {
    const { r, pin } = defence(-21.2, 0, -22.6); // behind him: he runs toward x = -52.5
    r.tick(2);
    press(r, ClusterSlot.BIG, 50);
    const seen = actsWhile(r, pin, 4, 20);
    expect([...seen].map((a) => ActionKind[a])).toContain('PUSH_PULL');
    expect(seen.has(ActionKind.STAND_TACKLE)).toBe(false);
  });

  it('SPRINT & TACKLE hold: sprint, and press the carrier when close (stick released): he closes him down, no tackle', () => {
    const { r, s, pin } = defence(-27, 3, -19);
    r.tick(2);
    const big = r.slot(ClusterSlot.BIG);
    r.down(2, big.x, big.y);
    const d0 = Math.hypot(s.players[4]!.x - -19, s.players[4]!.z - 0);
    let sprinted = false;
    const seen = new Set<ActionKind>();
    for (let i = 0; i < 75; i++) { pin(); r.tick(); if (s.players[4]!.wantSprint === 1) sprinted = true; seen.add(s.players[4]!.act); }
    const d1 = Math.hypot(s.players[4]!.x - -19, s.players[4]!.z - 0);
    r.up(2, big.x, big.y);
    expect(sprinted).toBe(true);
    expect(d1).toBeLessThan(d0 - 3);
    expect(seen.has(ActionKind.STAND_TACKLE) || seen.has(ActionKind.HARD_TACKLE)).toBe(false);
  });

  it('2ND DEF hold: keep him pressing - the second defender stays on while held and goes after the lift', () => {
    const { r, s, pin } = defence(-24, 0, -22.6);
    r.tick(2);
    const mid = r.slot(ClusterSlot.MID);
    r.down(2, mid.x, mid.y);
    let onTicks = 0;
    for (let i = 0; i < 240; i++) { pin(); r.tick(); if (s.ctrl[0]!.secondDef >= 0) onTicks++; }
    // Held for 4 s: on (after the tap time) for the whole hold, far longer than a tapped call.
    expect(onTicks).toBeGreaterThan(240 - 20);
    r.up(2, mid.x, mid.y);
    let offAt = -1;
    for (let i = 0; i < 240 && offAt < 0; i++) { pin(); r.tick(); if (s.ctrl[0]!.secondDef < 0) offAt = i; }
    expect(offAt).toBeGreaterThanOrEqual(0);
    // A tap calls him for a while only.
    const t = defence(-24, 0, -22.6);
    t.r.tick(2);
    press(t.r, ClusterSlot.MID, 50);
    let tapOn = 0;
    for (let i = 0; i < 240; i++) { t.pin(); t.r.tick(); if (t.s.ctrl[0]!.secondDef >= 0) tapOn++; }
    expect(tapOn).toBeGreaterThan(0);
    expect(tapOn).toBeLessThan(onTicks);
  });

  it('Moving the stick near the carrier without sprinting contains him automatically (jockey): he faces the carrier', () => {
    const run = (sprint: boolean): { lookAt: number; lookX: number } => {
      const { r, s, pin } = defence(-21, 0, -18, 0, -3);
      r.tick(2);
      r.down(1, 250, 520); r.move(1, 330, 520); // stick toward +x (at the carrier)
      if (sprint) { const big = r.slot(ClusterSlot.BIG); r.down(2, big.x, big.y); }
      for (let i = 0; i < 3; i++) { pin(); r.tick(); }
      return { lookAt: s.players[4]!.lookAt, lookX: s.players[4]!.lookX };
    };
    const jockey = run(false);
    expect(jockey.lookAt).toBe(1);
    expect(jockey.lookX).toBeCloseTo(-18, 0);
    expect(run(true).lookAt).toBe(0); // sprinting: no automatic jockey
  });
});

// ==================================================================================================== pitch gestures

describe('SGN-02 section 9 pitch gestures (real touch source -> real sim)', () => {
  it('Tap just behind a teammate: ground pass to his feet', () => {
    const r = createTouchRig(attack());
    r.tick(2);
    const m = r.s.players[10]!, p = scr(m.x - 1.2, m.z);
    tap(r, p.x, p.y);
    const k = untilKick(r, P);
    expect(KickKind[k!.kind]).toBe('GROUND_PASS');
    expect(k!.target).toBe(10);
  });

  it('Double-tap the space in front of a teammate: the lobbed version (lobbed through ball)', () => {
    const r = createTouchRig(attack());
    r.tick(2);
    const m = r.s.players[10]!, p = scr(m.x + 7, m.z);
    doubleTap(r, p.x, p.y);
    const k = untilKick(r, P);
    expect(KickKind[k!.kind]).toBe('THROUGH_LOBBED');
  });

  it('In the crossing zone, double-tap toward a post: the cross goes to the near or the far post', () => {
    const target: number[] = [];
    for (const postZ of [GOAL_HALF_WIDTH, -GOAL_HALF_WIDTH]) {
      const r = createTouchRig(attack(42, 26, 45, 2));
      centreOn(42, 15);
      r.tick(2);
      const p = scr(48.5, postZ);
      doubleTap(r, p.x, p.y);
      const k = untilKick(r, P);
      expect(KickKind[k!.kind]).toBe('CROSS');
      target.push(k!.tz);
    }
    expect(target[0]!).toBeCloseTo(GOAL_HALF_WIDTH, 0); // near post (the crosser is on the +z side)
    expect(target[1]!).toBeCloseTo(-GOAL_HALF_WIDTH, 0); // far post
  });

  it('Swipe toward goal: a faster swipe is harder and higher', () => {
    for (const seed of [1, 2, 3]) {
      const out: { c: number; y: number }[] = [];
      for (const ms of [300, 90]) {
        const r = createTouchRig(attack(30, 0, 25, -8, {}, seed));
        centreOn(30, 0);
        r.tick(2);
        swipe(r, 700, 420, 900, 400, ms);
        const k = untilKick(r, P);
        expect(k?.act).toBe(ActionKind.SHOT);
        out.push({ c: k!.e.c, y: heightAtGoalLine(r) });
      }
      expect(out[1]!.c, `seed ${seed} power`).toBeGreaterThan(out[0]!.c);
      expect(out[1]!.y, `seed ${seed} height at the goal line`).toBeGreaterThan(out[0]!.y + 0.3);
    }
  });

  it('Curved swipe toward goal: the finesse shot bends with the swipe (opposite bends curl opposite ways)', () => {
    const curls: number[] = [];
    for (const bend of [50, -50]) {
      const r = createTouchRig(attack(30, 0));
      centreOn(30, 0);
      r.tick(2);
      swipe(r, 700, 420, 900, 400, 160, bend);
      const k = untilKick(r, P);
      expect(KickKind[k!.kind]).toBe('SHOT_FINESSE');
      curls.push(k!.curve);
    }
    expect(Math.sign(curls[0]!)).toBe(-Math.sign(curls[1]!));
    expect(Math.abs(curls[0]!)).toBeGreaterThan(0.05);
  });
});

// ======================================================================================================= set pieces

/** P1 on side 0; `kind` awarded to `team` at (x, z); ticks until the restart is ready; camera on the ball. */
function restart(kind: RestartKind, team: number, x: number, z: number): TouchRig {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], ball: { owner: -1, x, z, y: 0.11 } });
  awardRestart(s, kind, team, x, z, NULL_SINK);
  const r = createTouchRig(s);
  for (let i = 0; i < 400 && s.match.restart.ready !== 1; i++) r.tick();
  expect(s.match.restart.ready).toBe(1);
  centreOn(s.ball.x, s.ball.z);
  r.tick();
  return r;
}

/** Swipe from the ball toward pitch point (tx, tz) over ms, bent by `bend` px; returns the taker's kick. */
function swipeFromBall(r: TouchRig, tx: number, tz: number, ms: number, bend = 0): NonNullable<ReturnType<typeof untilKick>> {
  const taker = r.s.match.restart.taker;
  const b = scr(r.s.ball.x, r.s.ball.z), t = scr(tx, tz);
  swipe(r, b.x, b.y, t.x, t.y, ms, bend, 8);
  const k = untilKick(r, taker, 90);
  expect(k, 'the taker kicked').not.toBeNull();
  return k!;
}

describe('SGN-02 section 9 set pieces on touch (real touch source -> real sim)', () => {
  it('Free kick at goal: swipe speed sets power and height; the curve sets curl', () => {
    const rs = restart(RestartKind.FREE_KICK, 0, 30, 5);
    const slow = swipeFromBall(rs, 52.5, 1, 400);
    const slowY = heightAtGoalLine(rs);
    const rf = restart(RestartKind.FREE_KICK, 0, 30, 5);
    const fast = swipeFromBall(rf, 52.5, 1, 120);
    const fastY = heightAtGoalLine(rf);
    for (const k of [slow, fast]) expect(KickKind[k.kind]).toBe('FREE_KICK_SHOT');
    expect(fast.e.c).toBeGreaterThan(slow.e.c + 0.2);
    expect(slowY).toBeGreaterThan(0);
    expect(fastY).toBeGreaterThan(slowY + 0.15);
    const straight = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 30, 5), 52.5, 1, 200);
    const left = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 30, 5), 52.5, 1, 200, 60);
    const right = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 30, 5), 52.5, 1, 200, -60);
    expect(Math.abs(straight.curve)).toBeLessThan(0.2);
    expect(Math.abs(left.curve)).toBeGreaterThan(0.2);
    expect(Math.sign(left.curve)).toBe(-Math.sign(right.curve));
  });

  it('Wide free kick: swipe from the ball into the box crosses there; a faster swipe goes higher; a curved one curls', () => {
    const slow = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 32, 26), 46, 0, 380);
    const fast = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 32, 26), 46, 0, 140);
    for (const k of [slow, fast]) expect(['CROSS', 'LOB_PASS', 'HIGH_LOB', 'DRIVEN_LOB', 'LOW_CROSS']).toContain(KickKind[k.kind]);
    expect(fast.vy).toBeGreaterThan(slow.vy);
    const bent = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 32, 26), 46, 0, 220, 60);
    const other = swipeFromBall(restart(RestartKind.FREE_KICK, 0, 32, 26), 46, 0, 220, -60);
    expect(Math.abs(bent.curve)).toBeGreaterThan(0.2);
    expect(Math.sign(bent.curve)).toBe(-Math.sign(other.curve));
  });

  it('Penalty: a faster swipe is harder (more power, faster ball)', () => {
    const slow = swipeFromBall(restart(RestartKind.PENALTY, 0, 41.5, 0), 52.5, -2.5, 380);
    const fast = swipeFromBall(restart(RestartKind.PENALTY, 0, 41.5, 0), 52.5, -2.5, 100);
    expect(fast.e.c).toBeGreaterThan(slow.e.c);
    expect(fast.speed).toBeGreaterThan(slow.speed);
  });
});

// ==================================================================================================== quality bar

describe('SGN-02 section 9 controls editor settings reach the sim', () => {
  it('Fast power bar (settings -> humanController -> sim): the same 500 ms PASS hold charges clearly more', () => {
    const power: number[] = [];
    for (const fast of [false, true]) {
      const st = createDefaultSettings();
      st.controls.touch.fastPowerBar = fast;
      const cfg = humanController(st, 0);
      const r = createTouchRig(attack(10, 0, 25, -8, { fastPower: cfg.fastPower, autoSwitch: cfg.autoSwitch }), { settings: { fastPowerBar: fast } });
      expect(r.s.ctrl[0]!.fastPower).toBe(fast ? 1 : 0);
      r.tick(2);
      press(r, ClusterSlot.LOW, 500);
      power.push(untilKick(r, P)!.e.c);
    }
    expect(power[1]!).toBeGreaterThan(power[0]! + 0.15);
  });

  it('Auto-switch level (settings -> humanController -> sim): Off keeps the passer while his pass travels; Air and loose / Auto switch to the receiver', () => {
    for (const level of [AutoSwitch.OFF, AutoSwitch.AIR_AND_LOOSE, AutoSwitch.AUTO]) {
      const st = createDefaultSettings();
      st.controls.autoSwitch = level;
      const cfg = humanController(st, 0);
      const r = createTouchRig(attack(10, 0, 25, -8, { autoSwitch: cfg.autoSwitch, fastPower: cfg.fastPower }));
      expect(r.s.ctrl[0]!.autoSwitch).toBe(level);
      r.tick(2);
      press(r, ClusterSlot.LOW, 50);
      const inFlight: number[] = [];
      for (let i = 0; i < 60; i++) {
        r.tick();
        const b = r.s.ball;
        if (b.owner < 0 && b.passTarget === 10 && kicksBy(r, P).length > 0) inFlight.push(r.s.ctrl[0]!.slot);
      }
      expect(inFlight.length, AutoSwitch[level]).toBeGreaterThan(3);
      if (level === AutoSwitch.OFF) expect(new Set(inFlight), 'Off').toEqual(new Set([P]));
      else expect(inFlight.at(-1), AutoSwitch[level]).toBe(10);
    }
  });
});
