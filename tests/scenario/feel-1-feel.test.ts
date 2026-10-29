/**
 * [FEEL-1] The user's playtest feedback, as scripted human-input scenarios through the real pipeline (pad frames:
 * stick + button bits; touch gestures where the input is touch-only). Measurement helpers: feel-1-helpers.ts; the
 * before / after numbers are in docs/TUNING.md (FEEL-1).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, AssistLevel, AutoSwitch, Foot, GestureKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { T_DRIBBLE } from '../../src/contracts/tuning';
import { KEY_BUTTONS } from '../../src/input/keyboard';
import { selectReceiver } from '../../src/sim/kicks/pass';
import { makeScenario, runTicks } from '../harness/scenario';
import {
  HS, INTENDED, dribbleScenario, passScenario, receiveScenario, shotScenario, type ReceiveCase,
} from './feel-1-helpers';

describe('FEEL-1 #1 receiving magnet: he never runs past a ball he is running at', () => {
  const grid = (g: Partial<ReceiveCase>): ReceiveCase[] => {
    const out: ReceiveCase[] = [];
    for (const v of [12, 16]) for (const path of [-8, 8]) for (const err of [-15, 15]) {
      out.push({ ballSpeed: g.kind === 'loose' ? v * 0.5 : v, pathDeg: path, dist: 22, aimErrDeg: err, seed: 1, mode: 'chase', sprint: true, kind: 'pass', ...g } as ReceiveCase);
    }
    return out;
  };
  it('a pass he sprints at with the stick 15 degrees off is collected and kept (was 22%)', () => {
    for (const c of grid({ mode: 'fixed' })) {
      const r = receiveScenario(c);
      expect(r.got, JSON.stringify(c)).toBe(true);
      expect(r.kept30, JSON.stringify(c)).toBe(true);
    }
  });
  it('a pass crossing his run is met (he leads the ball) and kept', () => {
    for (const c of grid({ mode: 'cross' })) {
      const r = receiveScenario(c);
      expect(r.kept30, JSON.stringify(c)).toBe(true);
    }
  });
  it('a loose ball he sprints at with the stick 15 degrees off is picked up, not run past', () => {
    for (const c of grid({ kind: 'loose', mode: 'fixed' })) {
      const r = receiveScenario(c);
      expect(r.got, JSON.stringify(c)).toBe(true);
    }
  });
  it('a sprinting first touch stays playable: the ball within 2 m of him half a second later', () => {
    for (const c of grid({ mode: 'chase' })) {
      const r = receiveScenario(c);
      expect(r.kept30).toBe(true);
      expect(r.after30).toBeLessThan(2);
    }
  });
  it('the magnet leaves a pass meant for a teammate alone (no steering onto it)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 3, humans: [{ side: 0, slot: HS, autoSwitch: AutoSwitch.OFF }] });
    const p = s.players[HS]!;
    p.x = 0; p.z = 0; p.vx = 0; p.vz = 0;
    Object.assign(s.ball, { x: -12, z: 1.5, px: -12, pz: 1.5, y: 0.11, py: 0.11, vx: 14, vz: 0, vy: 0, grounded: 1, owner: -1,
      lastKickBy: 6, lastKickTeam: 0, lastKickKind: KickKind.GROUND_PASS, lastKickTick: s.tick, lastTouch: 6, lastTouchTeam: 0,
      lastTouchTick: s.tick, passTarget: 7 });
    let maxZ = -9;
    runTicks(s, 20, (_t, _st, out) => { out[0]!.mx = -127; out[0]!.buttons = Btn.SPRINT; }, {
      until: (st) => { maxZ = Math.max(maxZ, st.players[HS]!.z); return false; },
    });
    expect(maxZ).toBeLessThan(0.05); // straight along his stick (-x), never drawn sideways onto the ball's line at z 1.5
  });
  it('Manual assistance shrinks the capture radius (a ball 7 m off his line is not chased)', () => {
    const run = (assist: AssistLevel): number => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 4, humans: [{ side: 0, slot: HS, assist, autoSwitch: AutoSwitch.OFF }] });
      const p = s.players[HS]!;
      p.x = 0; p.z = 0; p.vx = 0; p.vz = 0;
      s.attrs[HS]!.ballControl = 99;
      Object.assign(s.ball, { x: 6, z: 3.5, px: 6, pz: 3.5, y: 0.11, py: 0.11, vx: 0, vz: 0, owner: -1, lastTouch: 13, lastTouchTeam: 1, passTarget: -1 });
      let z = 0;
      runTicks(s, 30, (_t, _st, out) => { out[0]!.mx = 127; }, { until: (st) => { z = Math.max(z, st.players[HS]!.z); return false; } });
      return z;
    };
    expect(run(AssistLevel.ASSISTED)).toBeGreaterThan(0.3);
    expect(run(AssistLevel.MANUAL)).toBeLessThan(0.05);
  });
});

describe('FEEL-1 #2 close control: the ball stays near his feet at a jog, a sprint and an R1 controlled sprint', () => {
  const avg = (style: 'jog' | 'sprint' | 'r1', turn?: number) => {
    let mean = 0, max = 0, speed = 0, kept = 0;
    for (let seed = 1; seed <= 3; seed++) {
      // (Turns toward -z: the parked opponents stand along z = +32 and would come and tackle him.)
      const r = dribbleScenario({ style, ticks: 240, seed, turnDeg: turn, turnAt: turn ? 150 : undefined });
      mean += r.mean / 3; max = Math.max(max, r.max); speed += r.speed / 3; kept += r.kept ? 1 : 0;
    }
    return { mean, max, speed, kept };
  };
  it('jog dribble keeps the ball about 0.5-1 m ahead', () => {
    const r = avg('jog');
    expect(r.kept).toBe(3);
    expect(r.mean).toBeGreaterThan(0.5);
    expect(r.max).toBeLessThan(1.0);
  });
  it('sprint dribble keeps it 1-1.8 m ahead, not launched (was 2.05 m mean, 2.4 m peaks)', () => {
    const r = avg('sprint');
    expect(r.kept).toBe(3);
    expect(r.mean).toBeGreaterThan(1.0);
    expect(r.max).toBeLessThan(1.8);
  });
  it('R1 controlled sprint is tight (0.4-0.8 m) and a little slower than a full sprint, faster than a jog', () => {
    const r1 = avg('r1'), sp = avg('sprint'), jog = avg('jog');
    expect(r1.kept).toBe(3);
    expect(r1.mean).toBeGreaterThan(0.4);
    expect(r1.max).toBeLessThan(0.95);
    expect(r1.speed).toBeLessThan(sp.speed - 0.5);
    expect(r1.speed).toBeGreaterThan(jog.speed + 1);
  });
  it('a 90-degree turn at a sprint keeps the ball (was lost every time)', () => {
    expect(avg('sprint', -90).kept).toBe(3);
    expect(avg('r1', -90).kept).toBe(3);
  });
  it('poke window: an opponent standing just ahead of a human sprint dribble still pokes it away between touches', () => {
    let won = 0;
    for (const seed of [1, 2, 3]) {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: [{ side: 0, slot: HS, autoSwitch: AutoSwitch.OFF }] });
      for (let i = 1; i < 22; i++) { if (i === HS || i === 11) continue; const q = s.players[i]!; q.x = -48 + (i % 11); q.z = i < 11 ? -30 : 30; q.vx = 0; q.vz = 0; }
      const p = s.players[HS]!; p.x = -20; p.z = 0; p.fx = 1; p.fz = 0;
      Object.assign(s.ball, { x: -19.5, z: 0, px: -19.5, pz: 0, y: 0.11, py: 0.11, vx: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
      let placed = false;
      runTicks(s, 120, (t, st, out) => {
        out[0]!.mx = 127; out[0]!.buttons = Btn.SPRINT;
        // After 60 ticks, a defender stands 1.6 m ahead of the dribbler, right on the ball's line.
        if (!placed && t > 60) { placed = true; const d = st.players[13]!; d.x = st.players[HS]!.x + 1.6; d.z = 0.15; d.vx = 0; d.vz = 0; }
      }, { until: (st) => st.ball.owner !== HS });
      if (s.ball.owner !== HS) won++;
    }
    expect(won).toBe(3);
  });
  it('the CPU dribbles on its calibrated touches (close control is the human-controlled player\'s)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 2 });
    let maxLead = 0;
    for (let i = 1; i < 22; i++) { if (i === HS || i === 11) continue; const q = s.players[i]!; q.x = -48 + (i % 11); q.z = i < 11 ? -30 : 30; }
    const p = s.players[HS]!; p.x = -20; p.z = 0; p.fx = 1; p.fz = 0;
    Object.assign(s.ball, { x: -19.5, z: 0, px: -19.5, pz: 0, y: 0.11, py: 0.11, vx: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
    runTicks(s, 150, (_t, st) => { const q = st.players[HS]!; q.moveMode = 1; q.ix = 1; q.iz = 0; q.wantSprint = 1; }, {
      until: (st) => { if (st.ball.owner === HS) maxLead = Math.max(maxLead, st.ball.x - st.players[HS]!.x); return false; },
    });
    expect(maxLead).toBeGreaterThan(1.9); // T_DRIBBLE.touchAheadSprint 2.4 (bands calibrated on it; D-029)
  });
  it('dribbling / control / agility still matter: a poor dribbler pushes it further at a sprint', () => {
    const lo = dribbleScenario({ style: 'sprint', ticks: 240, seed: 1, skill: 40 });
    const hi = dribbleScenario({ style: 'sprint', ticks: 240, seed: 1, skill: 90 });
    expect(lo.mean).toBeGreaterThan(hi.mean + 0.2);
    expect(lo.max).toBeLessThan(T_DRIBBLE.loseRadius - 0.5);
  });
});

describe('FEEL-1 #3 assisted passing: a slightly-off pass still finds the man', () => {
  it('Assisted: stick up to 45 degrees off still reaches the intended teammate (tap to long hold, 12-28 m)', () => {
    let n = 0, ok = 0;
    for (const off of [15, 30, 45]) for (const sg of [1, -1]) for (const dist of [12, 20, 28]) for (const hold of [3, 30]) {
      const r = passScenario({ offDeg: off * sg, dist, hold, assist: AssistLevel.ASSISTED, seed: 1, decoyDeg: 75 * -sg, decoyDist: 25 });
      n++; if (r.reached) ok++;
    }
    expect(ok / n).toBeGreaterThanOrEqual(0.95);
  });
  it('hold adds pace but never sends a 15 m pass to nobody', () => {
    let prev = 0;
    for (const hold of [3, 30, 70]) {
      const r = passScenario({ offDeg: 0, dist: 15, hold, assist: AssistLevel.ASSISTED, seed: 1 });
      expect(r.reached).toBe(true);
      expect(r.speed).toBeGreaterThanOrEqual(prev);
      expect(r.speed).toBeLessThan(18);
      prev = r.speed;
    }
  });
  it('a tap prefers the nearer of two teammates about as far off the stick; a full power bar the farther', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: [{ side: 0, slot: HS }] });
    for (let i = 1; i < 11; i++) { if (i === HS) continue; const q = s.players[i]!; q.x = -48; q.z = -30 + i * 6; q.vx = 0; q.vz = 0; }
    for (let i = 11; i < 22; i++) { const q = s.players[i]!; q.x = -40 + (i - 11) * 7; q.z = 32; }
    const p = s.players[HS]!; p.x = -10; p.z = 0;
    const near = s.players[INTENDED]!; near.x = 10; near.z = 0; near.vx = 0; near.vz = 0;
    // Near: 20 m along +x; far: 45 m at -40 degrees; stick -20 degrees (20 off each).
    const far = s.players[10]!; far.x = -10 + 45 * Math.cos(-0.698); far.z = 45 * Math.sin(-0.698); far.vx = 0; far.vz = 0;
    const a = (-20 * Math.PI) / 180;
    expect(selectReceiver(s, HS, Math.cos(a), Math.sin(a), 0.05, AssistLevel.ASSISTED, 0)).toBe(INTENDED);
    expect(selectReceiver(s, HS, Math.cos(a), Math.sin(a), 1, AssistLevel.ASSISTED, 0)).toBe(10);
  });
  it('Semi narrows the cone; Manual keeps the stick direction (no receiver selection)', () => {
    const semi = passScenario({ offDeg: 45, dist: 20, hold: 3, assist: AssistLevel.SEMI, seed: 1 });
    expect(semi.target).not.toBe(INTENDED);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 1, humans: [{ side: 0, slot: HS }] });
    expect(selectReceiver(s, HS, 1, 0, 0.3, AssistLevel.MANUAL, 0)).toBe(-1);
  });
});

describe('FEEL-1 #4 shooting variety you can see in the flight', () => {
  const at = (style: 'normal' | 'finesse' | 'power' | 'trivela', x: number, z: number, aimZ: number) =>
    shotScenario({ style, x, z, aimZ, hold: 20, seed: 3 });
  it('normal shots carry a natural slight curve and still go where aimed', () => {
    const r = at('normal', 30, -8, 2.5);
    expect(r.kind).toBe(KickKind.SHOT_NORMAL);
    expect(Math.abs(r.curve)).toBeGreaterThan(0.4);
    expect(Math.abs(r.curve)).toBeLessThan(2);
    expect(Math.abs(r.crossZ - 2.5)).toBeLessThan(0.6);
  });
  it('finesse (R1 + SHOOT) clearly curls back in to the far corner and is slower than a normal shot', () => {
    const n = at('normal', 30, -8, 2.5), f = at('finesse', 30, -8, 2.5);
    expect(f.kind).toBe(KickKind.SHOT_FINESSE);
    expect(f.curve).toBeLessThan(-3); // launched wide of the far post, bending back toward the centre
    expect(f.speed).toBeLessThan(n.speed - 3);
    expect(Math.abs(f.crossZ - 2.5)).toBeLessThan(0.6);
  });
  it('power shot (L1 + R1 + SHOOT): longer wind-up, much faster, straight', () => {
    const n = at('normal', 30, -8, 2.5), pw = at('power', 30, -8, 2.5);
    expect(pw.kind).toBe(KickKind.SHOT_POWER);
    expect(pw.speed).toBeGreaterThan(n.speed + 4);
    expect(Math.abs(pw.curve)).toBeLessThan(0.1);
    // A tap: the power shot's longer wind-up shows (a held charge strikes on release for both).
    const nt = shotScenario({ style: 'normal', x: 30, z: -8, aimZ: 2.5, hold: 3, seed: 3 });
    const pt = shotScenario({ style: 'power', x: 30, z: -8, aimZ: 2.5, hold: 3, seed: 3 });
    expect(pt.windup).toBeGreaterThan(nt.windup + 3);
  });
  it('trivela (L2 + SHOOT) bends the other way to a finesse shot from the same spot, from either side', () => {
    for (const [z, aim] of [[8, -2.5], [-8, 2.5]] as const) {
      const f = at('finesse', 30, z, aim), t = at('trivela', 30, z, aim);
      expect(t.kind).toBe(KickKind.SHOT_TRIVELA);
      expect(Math.abs(t.curve)).toBeGreaterThan(2.5);
      expect(Math.abs(t.crossZ - aim)).toBeLessThan(0.7);
      expect(Math.sign(t.curve)).toBe(-Math.sign(f.curve)); // from either side: finesse bends in, trivela bends out
    }
  });
  for (const src of ['pad L2 + Circle', 'keyboard C + K'] as const) it(`${src} with L2 already held (shielding off a marker): the shield ends and the trivela is struck`, () => {
    const L2 = src === 'pad L2 + Circle' ? Btn.SHIELD : KEY_BUTTONS.KeyC!;
    const CIRCLE = src === 'pad L2 + Circle' ? Btn.SHOOT : KEY_BUTTONS.KeyK!;
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 6, humans: [{ side: 0, slot: HS, autoSwitch: AutoSwitch.OFF }] });
    const p = s.players[HS]!; p.x = 28; p.z = -6; p.fx = 1; p.fz = 0;
    const m = s.players[13]!; m.x = 26.8; m.z = -6.3; m.vx = 0; m.vz = 0; // a marker at his back: L2 is a real shield
    Object.assign(s.ball, { x: 28.5, z: -6, px: 28.5, pz: -6, y: 0.11, py: 0.11, vx: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
    let kind = -1, shielded = false;
    runTicks(s, 90, (t, st, out) => {
      const f = out[0]!;
      f.buttons |= L2;
      if (st.players[HS]!.act === ActionKind.SHIELD) shielded = true;
      if (t > 40 && t < 46) { f.mx = 127; f.mz = 30; f.buttons |= CIRCLE; }
    }, { until: (_st, ev) => { for (const e of ev) if (e.type === EventType.KICK && e.a === HS && e.b !== KickKind.DRIBBLE_TOUCH) kind = e.b; return kind >= 0; } });
    expect(shielded).toBe(true);
    expect(kind).toBe(KickKind.SHOT_TRIVELA);
  });
  it('touch: a curved swipe toward goal against his natural curl is a trivela, with it a finesse', () => {
    const shoot = (curve: number): number => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 5, humans: [{ side: 0, slot: HS, autoSwitch: AutoSwitch.OFF }] });
      s.attrs[HS]!.foot = Foot.RIGHT;
      const p = s.players[HS]!; p.x = 30; p.z = 0; p.fx = 1; p.fz = 0;
      Object.assign(s.ball, { x: 30.5, z: 0, px: 30.5, pz: 0, y: 0.11, py: 0.11, vx: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
      let kind = -1;
      runTicks(s, 40, (t, _st, out) => {
        if (t === s.tick + 1 && kind < 0) {
          const f = out[0]!;
          f.gesture = GestureKind.CURVED_SWIPE; f.gdx = 127; f.gdz = 0; f.gPower = 80; f.gCurve = curve;
          f.gx = 300; f.gz = 0; f.gSlot = -1;
        }
      }, { until: (_st, ev) => { for (const e of ev) if (e.type === EventType.KICK && e.a === HS) kind = e.b; return kind >= 0; } });
      return kind;
    };
    expect(shoot(60)).toBe(KickKind.SHOT_TRIVELA);
    expect(shoot(-60)).toBe(KickKind.SHOT_FINESSE);
  });
});
