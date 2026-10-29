/**
 * [FEEL-1 skeptic] Scripted human-input scenarios the first FEEL-1 pass did not try: a square pass received on the run
 * and then taken up the pitch, a hard square pass chased with the stick on the ball, sharp sprint turns and reversals
 * with the ball, keyboard 8-way steering. Real pipeline (makeScenario + step), pad-shaped InputFrames.
 */
import { describe, expect, it } from 'vitest';
import { AssistLevel, AutoSwitch, Difficulty, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { makeScenario, runTicks } from '../harness/scenario';

const HS = 9;

function stick(f: InputFrame, dx: number, dz: number, kb = false): void {
  let l = Math.hypot(dx, dz);
  if (!(l > 1e-9)) return;
  if (kb) { // keyboard: 8-way at full deflection
    const a = Math.round(Math.atan2(dz, dx) / (Math.PI / 4)) * (Math.PI / 4);
    dx = Math.cos(a); dz = Math.sin(a); l = 1;
  }
  f.mx = Math.round((dx / l) * 127);
  f.mz = Math.round((dz / l) * 127);
}

function base(seed: number): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed, humans: [{ side: 0, slot: HS, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }] });
  for (let i = 0; i < 22; i++) {
    if (i === HS || i === 0 || i === 11) continue;
    const p = s.players[i]!;
    if (i < 11) { p.x = -48; p.z = -30 + i * 6; } else { p.x = -40 + (i - 11) * 7; p.z = 32; }
    p.vx = 0; p.vz = 0;
  }
  return s;
}

interface SideResult { got: boolean; kept: boolean; after: number }

/**
 * He sprints up the pitch (+x, 7 m/s); a teammate's pass comes square from his left/right (ball `v` m/s from `dist` m
 * to the side, 8 m ahead of him, `path` degrees off square). The user chases it with the stick on the ball and, the
 * moment he has it, pushes the stick straight up the pitch again (sprint held throughout).
 */
function sidePass(v: number, path: number, dist: number, seed: number, kb: boolean): SideResult {
  const s = base(seed);
  const p = s.players[HS]!;
  p.x = 0; p.z = 0; p.vx = 7; p.vz = 0; p.fx = 1; p.fz = 0;
  const a = (path * Math.PI) / 180;
  Object.assign(s.ball, {
    x: 8, y: 0.11, z: dist, px: 8, py: 0.11, pz: dist, vx: v * Math.sin(a), vy: 0, vz: -v * Math.cos(a), grounded: 1,
    owner: -1, heldBy: -1, lastKickBy: 6, lastKickTeam: 0, lastKickKind: KickKind.GROUND_PASS, lastKickTick: s.tick,
    lastTouch: 6, lastTouchTeam: 0, lastTouchTick: s.tick, passTarget: HS,
  });
  let got = -1, kept = false, after = NaN;
  runTicks(s, 300, (_t, st, out) => {
    const f = out[0]!;
    const q = st.players[HS]!;
    if (got >= 0) stick(f, 1, 0, kb); else stick(f, st.ball.x - q.x, st.ball.z - q.z, kb);
    f.buttons |= Btn.SPRINT;
  }, {
    until: (st) => {
      const q = st.players[HS]!;
      if (got < 0) { if (st.ball.owner === HS) got = st.tick; return false; }
      if (st.tick - got === 40) { kept = st.ball.owner === HS; after = Math.hypot(st.ball.x - q.x, st.ball.z - q.z); return true; }
      return false;
    },
  });
  return { got: got >= 0, kept, after };
}

describe('FEEL-1 skeptic: receiving on the run', () => {
  it('a square pass received at a sprint, then the stick pushed up the pitch: he keeps the ball (dribble leash; was 44%)', () => {
    let n = 0, kept = 0, far = 0;
    for (const v of [8, 12, 16]) for (const path of [-12, -4, 4, 12]) for (const dist of [16, 26]) {
      const r = sidePass(v, path, dist, 1, false);
      n++; if (r.kept) kept++; if (r.kept && r.after > 1.8) far++;
    }
    expect(kept / n).toBeGreaterThanOrEqual(0.9);
    expect(far).toBe(0);
  });

  it('keyboard (8-way) steering: the same square pass is met and kept after the turn up the pitch', () => {
    let n = 0, kept = 0;
    for (const v of [8, 12, 16]) for (const path of [-4, 4]) for (const dist of [16, 26]) {
      n++; if (sidePass(v, path, dist, 2, true).kept) kept++;
    }
    expect(kept / n).toBeGreaterThanOrEqual(0.9);
  });

  it('a hard (20 m/s) square pass chased with the stick on the ball itself is met (magnet engages on the ball, not only on the meeting point)', () => {
    for (const path of [-4, 4]) {
      const r = sidePass(20, path, 16, 1, false);
      expect(r.got).toBe(true);
    }
  });
});

interface DribResult { kept: boolean; max: number; speed: number }

/** Sprint (or R1) dribble from (-30, 0) up +x; `dirAt(t)` gives the stick direction (deg from +x) at tick t. */
function dribble(style: 'sprint' | 'r1', ticks: number, dirAt: (t: number) => number, seed: number): DribResult {
  const s = base(seed);
  const p = s.players[HS]!;
  p.x = -30; p.z = 0; p.fx = 1; p.fz = 0;
  Object.assign(s.ball, { x: -29.5, y: 0.11, z: 0, px: -29.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  let kept = true, max = 0, sp = 0, n = 0;
  runTicks(s, ticks, (t, _st, out) => {
    const f = out[0]!;
    const a = (dirAt(t) * Math.PI) / 180;
    stick(f, Math.cos(a), Math.sin(a));
    f.buttons |= style === 'sprint' ? Btn.SPRINT : Btn.MOD_R;
  }, {
    until: (st) => {
      const q = st.players[HS]!;
      if (st.ball.owner !== HS) { kept = false; return true; }
      if (st.tick > 60) { max = Math.max(max, Math.hypot(st.ball.x - q.x, st.ball.z - q.z)); sp += Math.hypot(q.vx, q.vz); n++; }
      return false;
    },
  });
  return { kept, max, speed: sp / Math.max(1, n) };
}

describe('FEEL-1 skeptic: sharp turns with the ball', () => {
  it('sprint zig-zag (45 degrees each way every 2/3 s) keeps the ball close at pace (was lost 2 of 4, 5.9 m/s)', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const r = dribble('sprint', 300, (t) => (Math.floor(t / 40) % 2 ? 45 : -45), seed);
      expect(r.kept).toBe(true);
      expect(r.max).toBeLessThan(1.8);
      expect(r.speed).toBeGreaterThan(7.5);
    }
  });

  it('a 180-degree reversal at a sprint or in a controlled sprint keeps the ball (was lost every time)', () => {
    for (const style of ['sprint', 'r1'] as const) for (let seed = 1; seed <= 3; seed++) {
      const r = dribble(style, 260, (t) => (t > 150 ? 180 : 0), seed);
      expect(r.kept).toBe(true);
      expect(r.max).toBeLessThan(2.4);
    }
  });
});

/** Human R1 / sprint dribble from (-20, 0) at a CPU centre-back (slot 14) at (-6, lat); within 6 m he side-steps by
 *  `weave` (stick z). Returns 'lost' (ball won without a foul), 'beat' (past him) or 'none'. */
function vsDefender(style: 'sprint' | 'r1', level: Difficulty, seed: number, lat: number, weave: number): 'lost' | 'beat' | 'none' {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, config: { difficulty: level },
    humans: [{ side: 0, slot: HS, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
  });
  for (let i = 0; i < 22; i++) {
    if (i === HS || i === 0 || i === 11 || i === 14) continue;
    const p = s.players[i]!;
    if (i < 11) { p.x = -48; p.z = -30 + i * 6; } else { p.x = -40 + (i - 11) * 7; p.z = 32; }
    p.vx = 0; p.vz = 0;
  }
  const p = s.players[HS]!;
  p.x = -20; p.z = 0; p.fx = 1; p.fz = 0;
  const d = s.players[14]!;
  d.x = -6; d.z = lat; d.vx = 0; d.vz = 0; d.fx = -1; d.fz = 0;
  Object.assign(s.ball, { x: -19.5, y: 0.11, z: 0, px: -19.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
  let res: 'lost' | 'beat' | 'none' = 'none';
  let fouls = 0;
  runTicks(s, 360, (_t, st, out) => {
    const f = out[0]!;
    const q = st.players[HS]!, dd = st.players[14]!;
    let dz = 0;
    if (dd.x - q.x < 6 && dd.x - q.x > -1) dz = q.z >= dd.z ? weave : -weave;
    stick(f, 1, dz);
    f.buttons |= style === 'sprint' ? Btn.SPRINT : Btn.MOD_R;
  }, {
    until: (st, ev) => {
      for (const e of ev) if (e.type === EventType.FOUL) fouls++;
      const q = st.players[HS]!;
      if (st.ball.owner !== HS) { res = fouls === 0 ? 'lost' : 'none'; return true; }
      if (q.x > st.players[14]!.x + 4) { res = 'beat'; return true; }
      return false;
    },
  });
  // Still on the ball after 6 s and past him (he trails the dribbler): beaten too.
  if (res === 'none' && s.ball.owner === HS && s.players[HS]!.x > s.players[14]!.x + 1) res = 'beat';
  return res;
}

describe('FEEL-1 skeptic: close control is not glue', () => {
  it('an R1 dribbler side-stepping a Professional / Legend centre-back can still be tackled (was never: the ball never left exposeDist)', () => {
    let lost = 0, beat = 0;
    for (const level of [Difficulty.PROFESSIONAL, Difficulty.LEGEND]) for (let seed = 1; seed <= 4; seed++) for (const lat of [-1.5, 0, 1.5]) {
      const r = vsDefender('r1', level, seed, lat, 0.4);
      if (r === 'lost') lost++; else if (r === 'beat') beat++;
    }
    expect(lost).toBeGreaterThanOrEqual(3); // measured 5 of 24
    expect(beat).toBeGreaterThanOrEqual(12); // measured 19 of 24 (probe): a good side step still beats him
  });

  it('running the ball straight into a Legend centre-back loses it, at a sprint and in R1', () => {
    for (const style of ['sprint', 'r1'] as const) for (const seed of [1, 2]) {
      expect(vsDefender(style, Difficulty.LEGEND, seed, 0, 0)).toBe('lost');
    }
  });
});

describe('FEEL-1 skeptic: the trivela is a harder technique', () => {
  it('a poor shooter sprays the trivela more than a normal shot from the same spot (error x1.15 v x1.0)', () => {
    const spread = (trivela: boolean): number => {
      let sum = 0, n = 0;
      for (let seed = 1; seed <= 16; seed++) {
        const s = base(seed);
        const p = s.players[HS]!;
        p.x = 30; p.z = 0; p.fx = 1; p.fz = 0;
        const a = s.attrs[HS]!;
        a.finishing = 30; a.longShots = 30; a.curve = 30;
        const k = s.players[11]!; k.x = 60; k.z = 30;
        Object.assign(s.ball, { x: 30.5, y: 0.11, z: 0, px: 30.5, py: 0.11, pz: 0, vx: 0, vy: 0, vz: 0, owner: HS, lastTouch: HS, lastTouchTeam: 0 });
        let crossZ = NaN;
        runTicks(s, 200, (tk, _st, out) => {
          const f = out[0]!;
          stick(f, 22.5, 2.5);
          if (trivela) f.buttons |= Btn.SHIELD;
          if (tk - 1 < 18) f.buttons |= Btn.SHOOT;
        }, { until: (st) => { if (st.ball.x >= 52.5) { crossZ = st.ball.z; return true; } return false; } });
        if (Number.isFinite(crossZ)) { sum += Math.abs(crossZ - 2.5); n++; } // a few hit the frame / are kept out
      }
      expect(n).toBeGreaterThanOrEqual(10);
      return sum / n;
    };
    expect(spread(true)).toBeGreaterThan(spread(false));
  });
});
