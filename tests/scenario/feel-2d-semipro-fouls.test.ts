/**
 * [FEEL-2D] Regression tests for D-042: CPU defenders' fouls on a human dribbler did not rise with the level. The FEEL-2
 * skeptic's duel probe (four centre-back / full-back / midfield geometries, a defender 9-13 m ahead and -1.5 / 0.3 / 1.6 m
 * to the side, R1 / sprint / jog, drag-back, late step, zig-zag, stop-and-go and wide moves, seeds 41-42: 360 duels a
 * level) counted 4 / 2 / 21 / 8 / 12 / 9 fouls from Beginner to Legend on 2f7a87d: Semi-Pro about 2.5 x Amateur /
 * Professional, mostly rash tackles and slides after a stop-and-go burst. The burst starts no duel window (the stop
 * disengages the duel, and on re-engaging the reference lateral velocity is the burst's own), so the duel context's
 * safety held only through duelEng: a slide was still allowed there, and a rash tackle needed no ball first, so the
 * dribbler crossing in front of the defender met the tackle body first; a careful tackle on a dribbler slowed to 0.8 m
 * of the defender after a window closed (the duel context over) had no ball-first or body test either, and a poke /
 * rash lunge while blocking a human jogging at him (no duel context while blocking) closed at 7-8 m/s. Semi-Pro is the
 * first level whose tackle timing (8 ticks) fits a sprinting human's touch interval while its decision noise is still
 * high, and it reads 40% of the steps (Amateur is sold 90%), so it was where these met. Scenes here are the probe's.
 */
import { describe, expect, it } from 'vitest';
import { AssistLevel, AutoSwitch, Difficulty, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, type InputFrame } from '../../src/contracts/input';
import { makeScenario, runTicks } from '../harness/scenario';

const GX = 52.5;
type Move = 'stopgo' | 'drag';
type Style = 'r1' | 'sprint' | 'jog';
interface Scene { att: number; def: number; x0: number; z0: number; gap: number }
/** The probe's geometries: attacker slot, defender slot, start x / z, defender distance ahead. */
const SCENES: readonly Scene[] = [
  { att: 10, def: 13, x0: -2, z0: -11, gap: 10 },
  { att: 9, def: 14, x0: 14, z0: 1, gap: 9 },
  { att: 7, def: 16, x0: 22, z0: 12, gap: 11 },
  { att: 8, def: 15, x0: -12, z0: 6, gap: 13 },
];
const LATS = [-1.5, 0.3, 1.6];
const STYLES: readonly Style[] = ['r1', 'sprint', 'jog'];

function stick(f: InputFrame, dx: number, dz: number, mag: number): void {
  const l = Math.hypot(dx, dz);
  if (!(l > 1e-9)) return;
  f.mx = Math.round((dx / l) * 127 * mag); f.mz = Math.round((dz / l) * 127 * mag);
}

/** One duel: the human dribbler (side 0) runs at goal past one CPU defender (everyone else parked). 'stopgo': within
 *  6 m of the defender he stops for 20 ticks, then bursts 45 degrees away from the defender's side, sprinting, for 30;
 *  'drag': at 5 m a step to the defender's side for 15 ticks, then away for 25. Then straight on at goal. Returns the
 *  number of fouls (the scene ends at the first) and whether he beat the defender. */
function duel(level: Difficulty, sc: Scene, seed: number, lat: number, move: Move, style: Style): { fouls: number; beat: boolean } {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, seed, config: { difficulty: level },
    humans: [{ side: 0, slot: sc.att, assist: AssistLevel.ASSISTED, autoSwitch: AutoSwitch.OFF }],
  });
  for (let i = 0; i < 22; i++) {
    if (i === sc.att || i === sc.def || i === 0 || i === 11) continue;
    const p = s.players[i]!;
    if (i < 11) { p.x = -50; p.z = -30 + i * 6; } else { p.x = -45 + (i - 11) * 6; p.z = -33; }
    p.vx = 0; p.vz = 0;
  }
  let gx = GX - sc.x0, gz = -sc.z0;
  const gl = Math.hypot(gx, gz); gx /= gl; gz /= gl;
  const nx = -gz, nz = gx;
  const a = s.players[sc.att]!;
  a.x = sc.x0; a.z = sc.z0; a.fx = gx; a.fz = gz; a.vx = 0; a.vz = 0;
  const d = s.players[sc.def]!;
  d.x = sc.x0 + gx * sc.gap + nx * lat; d.z = sc.z0 + gz * sc.gap + nz * lat; d.vx = 0; d.vz = 0; d.fx = -gx; d.fz = -gz;
  const bx = sc.x0 + gx * 0.5, bz = sc.z0 + gz * 0.5;
  Object.assign(s.ball, { x: bx, y: 0.11, z: bz, px: bx, py: 0.11, pz: bz, vx: 0, vy: 0, vz: 0, owner: sc.att, lastTouch: sc.att, lastTouchTeam: 0, heldBy: -1 });
  let start = -1, sgn = 0, fouls = 0, beat = false;
  const toGoal = (x: number, z: number): number => Math.hypot(GX - x, z);
  runTicks(s, 480, (tk, st, out) => {
    const f = out[0]!;
    const q = st.players[sc.att]!, dd = st.players[sc.def]!;
    let ux = GX - q.x, uz = -q.z;
    const ul = Math.hypot(ux, uz); ux /= ul; uz /= ul;
    const vx = -uz, vz = ux;
    const along = (dd.x - q.x) * ux + (dd.z - q.z) * uz, latD = (dd.x - q.x) * vx + (dd.z - q.z) * vz;
    if (start < 0 && along < (move === 'stopgo' ? 6 : 5) && along > -1) { start = tk; sgn = latD >= 0 ? -1 : 1; }
    let side = 0, mag = 0.65, stop = false;
    if (start >= 0) {
      const el = tk - start;
      if (move === 'drag') side = el < 15 ? -sgn : el < 40 ? sgn : 0;
      else if (el < 20) stop = true;
      else if (el < 50) { side = sgn; mag = 1; }
    }
    if (stop) return;
    stick(f, ux + vx * side * mag, uz + vz * side * mag, style === 'jog' ? 0.85 : 1);
    if (style === 'sprint' || (move === 'stopgo' && start >= 0)) f.buttons |= Btn.SPRINT;
    else if (style === 'r1') f.buttons |= Btn.MOD_R;
  }, {
    until: (st, ev) => {
      for (const e of ev) if (e.type === EventType.FOUL) fouls++;
      if (fouls > 0 || st.match.phase !== MatchPhase.IN_PLAY) return true;
      const b = st.ball, q = st.players[sc.att]!, dd = st.players[sc.def]!;
      if (b.owner >= 11 || (b.owner < 0 && b.lastTouchTeam === 1)) return true;
      if (b.owner === sc.att && (toGoal(q.x, q.z) < toGoal(dd.x, dd.z) - 2.5 || q.x > 47)) { beat = true; return true; }
      return false;
    },
  });
  return { fouls, beat };
}

function stopGoFouls(level: Difficulty): { n: number; fouls: number; beat: number } {
  const t = { n: 0, fouls: 0, beat: 0 };
  for (const sc of SCENES) for (const seed of [41, 42]) for (const style of STYLES) for (const lat of LATS) {
    const r = duel(level, sc, seed, lat, 'stopgo', style);
    t.n++; t.fouls += r.fouls; if (r.beat) t.beat++;
  }
  return t;
}

describe('FEEL-2D: CPU fouls on a human dribbler do not rise from Amateur to Semi-Pro to Professional (D-042)', () => {
  it('the stop-and-go burst (72 duels a level): Semi-Pro fouls no more than Amateur or Professional', () => {
    const lv = [Difficulty.AMATEUR, Difficulty.SEMI_PRO, Difficulty.PROFESSIONAL].map((l) => stopGoFouls(l));
    console.log(`FEEL-2D stop-and-go Amateur / Semi-Pro / Professional: ${JSON.stringify(lv)}`);
    // 2f7a87d: 2 / 14 / 5 fouls (rash tackles and slides into the burst). Now 2 / 1 / 0.
    expect(lv[1]!.fouls).toBeLessThanOrEqual(Math.max(lv[0]!.fouls, lv[2]!.fouls) + 1);
    for (const t of lv) expect(t.fouls).toBeLessThanOrEqual(2);
  }, 300_000);

  it('the scenes that fouled at Semi-Pro on 2f7a87d are no fouls now', () => {
    const [cb, fb] = [SCENES[0]!, SCENES[1]!];
    // A rash tackle into the burst, the dribbler crossing in front of the defender (seed 41 / 42, all three offsets).
    for (const seed of [41, 42]) for (const lat of LATS) expect(duel(Difficulty.SEMI_PRO, cb, seed, lat, 'stopgo', 'jog').fouls, `rash s${seed} ${lat}`).toBe(0);
    // A slide at the dribbler bursting at him in R1.
    for (const lat of LATS) expect(duel(Difficulty.SEMI_PRO, fb, 41, lat, 'stopgo', 'r1').fouls, `slide ${lat}`).toBe(0);
    // A careful tackle with the bodies 0.8 m apart once the read window closed (the dribbler slowed after the drag).
    expect(duel(Difficulty.SEMI_PRO, cb, 44, 0.3, 'drag', 'jog').fouls, 'careful at body contact').toBe(0);
    // A poke while blocking a human jogging into the blocker at 4.6 m/s.
    expect(duel(Difficulty.SEMI_PRO, cb, 41, -1.5, 'drag', 'jog').fouls, 'poke while blocking').toBe(0);
  }, 300_000);
});
