/**
 * [QF-16] Scripted human carriers against one CPU defender (the QF-14 escort / still / held carrier scenes): team 0's
 * human (slot 9) has the ball at his feet 3 m in front of team 1's defender (slot 15), everybody else parked behind the
 * play; the human's stick follows a script for up to 10 s. Used by the qf-16 escort, shield and level tests.
 */
import { ActionKind, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import { MoveMode, type SimState } from '../../src/contracts/state';
import { makeScenario, runTicks } from '../harness/scenario';

export const CARRIER = 9;
export const DEFENDER = 15;

/** The scene: carrier at (x, z) facing +x (or -x with his back to goal, the ball behind him), defender gap m ahead. */
export function carrierScene(seed: number, level: Difficulty, x: number, z: number, gap: number, back = false): SimState {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: CARRIER }], seed, config: { difficulty: level } });
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const k = i % 11;
    if (k === 0) { p.x = i < 11 ? -51 : 51; p.z = 0; } else { p.x = -45; p.z = -30 + k * 5.5 + (i < 11 ? 0 : 2); }
    p.vx = 0; p.vz = 0; p.fx = i < 11 ? 1 : -1; p.fz = 0; p.homeX = p.x; p.homeZ = p.z;
    p.act = ActionKind.NONE; p.moveMode = MoveMode.STOP;
  }
  const q = s.players[CARRIER]!;
  q.x = x; q.z = z; q.fx = back ? -1 : 1; q.fz = 0;
  q.lastTouchTick = s.tick;
  const d = s.players[DEFENDER]!;
  d.x = x + gap; d.z = z + 0.3; d.fx = -1;
  const b = s.ball;
  b.x = x + (back ? -0.45 : 0.45); b.z = z; b.y = 0.11; b.px = b.x; b.pz = b.z; b.py = b.y; b.vx = 0; b.vz = 0; b.vy = 0;
  b.grounded = 1;
  b.owner = CARRIER; b.ownerT = 0; b.heldBy = -1; b.lastTouch = CARRIER; b.lastTouchTeam = 0;
  s.teams[1]!.cpu.level = level;
  return s;
}

export type StickScript = (t: number, f: InputFrame) => void;

/** The QF-14 / QF-16 scripted carriers (t = ticks since the start). */
export const SCRIPTS: Record<string, { back?: boolean; f: StickScript }> = {
  straight35: { f: (_t, f) => { f.mx = 35; } },
  straight50: { f: (_t, f) => { f.mx = 50; } },
  straight65: { f: (_t, f) => { f.mx = 65; } },
  jog100: { f: (_t, f) => { f.mx = 100; } },
  diagP: { f: (_t, f) => { f.mx = 30; f.mz = 15; } },
  diagM: { f: (_t, f) => { f.mx = 30; f.mz = -15; } },
  diag45: { f: (_t, f) => { f.mx = 45; f.mz = 30; } },
  across: { f: (_t, f) => { f.mx = 15; f.mz = 35; } },
  strafe: { f: (t, f) => { f.mz = Math.floor(t / 60) % 2 ? 50 : -50; } },
  strafeFwd: { f: (t, f) => { f.mx = 30; f.mz = Math.floor(t / 45) % 2 ? 50 : -50; } },
  circle: { f: (t, f) => { const a = (t * 2 * Math.PI) / 180; f.mx = Math.round(50 * Math.cos(a)); f.mz = Math.round(50 * Math.sin(a)); } },
  nudge: { f: (t, f) => { if (t % 30 < 8) f.mx = 60; } },
  back: { back: true, f: (_t, f) => { f.buttons |= Btn.SHIELD; f.mx = 30; } },
  shieldStrafe: { f: (t, f) => { f.buttons |= Btn.SHIELD; f.mz = Math.floor(t / 60) % 2 ? 50 : -50; } },
};

export interface SceneTally {
  /** Scenes in which the carrier still had the ball (in play) after the run. */
  kept: number;
  /** Furthest progress toward the defended goal (+x) per scene, m. */
  gained: number[];
  /** Balls won by team 1's tackles; fouls by team 1 (penalties counted too). */
  won: number;
  fouls: number;
  pens: number;
}

/** Run `script` for `seeds` scenes (seed 1..seeds; carrier at (bx - seed, bz - seed)) of up to n ticks at `level`. */
export function runScript(name: string, level: Difficulty, seeds: number, n = 600, bx = 10, bz = 5): SceneTally {
  const sc = SCRIPTS[name]!;
  const r: SceneTally = { kept: 0, gained: [], won: 0, fouls: 0, pens: 0 };
  for (let seed = 1; seed <= seeds; seed++) {
    const s = carrierScene(seed, level, bx - seed, bz - seed, 3, sc.back);
    const x0 = s.players[CARRIER]!.x, t0 = s.tick;
    let maxX = x0;
    const ev: SimEvent[] = runTicks(s, n, (t, _st, out) => sc.f(t - t0, out[0]!), {
      until: (st) => {
        if (st.players[CARRIER]!.x > maxX) maxX = st.players[CARRIER]!.x;
        return st.ball.owner !== CARRIER || st.match.phase !== MatchPhase.IN_PLAY;
      },
    });
    if (s.ball.owner === CARRIER && s.match.phase === MatchPhase.IN_PLAY) r.kept++;
    r.gained.push(maxX - x0);
    for (const e of ev) {
      if (e.type === EventType.TACKLE && e.b === CARRIER && e.c === 1 && s.players[e.a]!.team === 1) r.won++;
      if (e.type === EventType.FOUL && s.players[e.a]!.team === 1) { r.fouls++; if (e.d === 1) r.pens++; }
    }
  }
  return r;
}

export const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
