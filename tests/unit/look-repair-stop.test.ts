/**
 * [REPAIR 3] Look review round 3, blocking: stopping from a run. Measured through the whole player model (GFX-12
 * animator driving GFX-07, with its foot lock and ground snap) in the world, as the drawn boots are: every toe on the
 * grass (within 3 mm) stays within 2 cm of where it came down and never moves more than 2 cm in one frame, through
 * braking at the sim's rates, the switch to idle, the idle fade and the settling steps; also a start from rest straight
 * after a stop (the run's first stance) and a body that settles back over the sim position once standing.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { MatchPhase, QualityTier } from '../../src/contracts/enums';
import { AnimId, PoseIdx } from '../../src/contracts/render';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createAnimator } from '../../src/render/anim/mapper';
import { fillInterp } from '../../src/render/index';
import { BODY, Joint } from '../../src/render/players/fk';
import { createPlayerModel } from '../../src/render/players/model';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { cloneState } from '../../src/sim/core/clone';
import { initMatch } from '../../src/sim/init';

const SLOT = 6;

function rig() {
  const settings = createDefaultSettings();
  const ctx: RenderContext = {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.44, 2, 600),
    settings, clubs: CLUBS, size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
  const model = createPlayerModel(ctx);
  const curr = initMatch(createMatchConfig()) as SimState;
  curr.match.phase = MatchPhase.IN_PLAY;
  const p = curr.players[SLOT]!;
  p.x = 0; p.z = 0; p.vx = 0; p.vz = 0; p.fx = 1; p.fz = 0;
  curr.ball.x = 50; curr.ball.z = 30; curr.ball.owner = -1; curr.ball.heldBy = -1;
  model.setMatch!(curr, CLUBS);
  const anim = createAnimator();
  model.setPoseDriver(anim.driver);
  const prev = cloneState(curr);
  const f: RenderFrame = { prev, curr, alpha: 1, frame: { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false }, interp: createInterpState() };
  return { model, prev, curr, f, anim };
}
type Rig = ReturnType<typeof rig>;

function tick(r: Rig, x: number, v: number): void {
  const a = r.prev.players[SLOT]!, b = r.curr.players[SLOT]!;
  a.x = b.x; a.z = b.z; a.vx = b.vx; a.vz = b.vz;
  b.x = x; b.vx = v;
  r.prev.tick = r.curr.tick; r.curr.tick++;
  r.f.frame.frame++; r.f.frame.nowMs += 1000 / 60;
  fillInterp(r.f.interp, r.prev, r.curr, 1);
  r.model.update(r.f);
}

/** World toe point (k 0 left, 1 right) of the drawn skeleton. */
function toe(r: Rig, k: number, out: number[]): void {
  const S = r.model.skeletons[SLOT]!;
  const o = (k === 0 ? Joint.ANKLE_L : Joint.ANKLE_R) * 12;
  const lx = BODY.toeX, ly = -BODY.ankleY;
  out[0] = S[o]! * lx + S[o + 3]! * ly + S[o + 9]!;
  out[1] = S[o + 1]! * lx + S[o + 4]! * ly + S[o + 10]!;
  out[2] = S[o + 2]! * lx + S[o + 5]! * ly + S[o + 11]!;
}

/** Drive speed profile v(t) along +x for n frames; planted-toe slip and one-frame moves from frame `from`. */
function drive(r: Rig, n: number, vAt: (t: number) => number, from: number): { slip: number; jump: number; contacts: number; x: number } {
  for (let t = 0; t < 40; t++) tick(r, 0, 0);
  let x = 0, slip = 0, jump = 0, contacts = 0;
  const q = [0, 0, 0];
  const start: (number[] | null)[] = [null, null];
  const last: (number[] | null)[] = [null, null];
  for (let t = 0; t < n; t++) {
    const v = vAt(t);
    x += v / 60;
    tick(r, x, v);
    if (t < from) continue;
    for (let k = 0; k < 2; k++) {
      toe(r, k, q);
      if (q[1]! < 0.003) {
        const s = start[k], l = last[k];
        if (!s) { start[k] = [q[0]!, q[2]!]; contacts++; } else slip = Math.max(slip, Math.hypot(q[0]! - s[0]!, q[2]! - s[1]!));
        if (l) jump = Math.max(jump, Math.hypot(q[0]! - l[0]!, q[2]! - l[1]!));
        last[k] = [q[0]!, q[2]!];
      } else { start[k] = null; last[k] = null; }
    }
  }
  return { slip, jump, contacts, x };
}

describe('[REPAIR 3] stopping from a run (full model, world space)', () => {
  it('a stop at the sim braking rates keeps planted toes within 2 cm and never moves one more than 2 cm in a frame', () => {
    // Run up at 6 m/s^2, run on to frame 150, brake at `dec`, stand. At 79ee1c7: 14-52 cm of slip, 12-32 cm jumps.
    for (const [v0, dec] of [[5, 10], [5, 3], [8.5, 6], [8.5, 10], [2, 4], [3.5, 20], [1, 4]] as const) {
      const r = rig();
      const res = drive(r, 380, (t) => (t < 150 ? Math.min(v0, (6 * (t + 1)) / 60) : Math.max(0, v0 - (dec * (t - 150)) / 60)), 110);
      expect(r.anim.bank.anim[SLOT], `idle after the stop from ${v0} at ${dec}`).toBe(AnimId.IDLE);
      expect(res.contacts, `contacts, stop from ${v0} at ${dec}`).toBeGreaterThanOrEqual(3);
      expect(res.slip, `planted toe slip, stop from ${v0} m/s at ${dec} m/s^2`).toBeLessThan(0.02);
      expect(res.jump, `planted toe one-frame move, stop from ${v0} m/s at ${dec} m/s^2`).toBeLessThan(0.02);
      // Standing: the body is back over the sim position.
      const S = r.model.skeletons[SLOT]!;
      const pose = r.model.poses[SLOT]!;
      expect(Math.abs(S[9]! - res.x), `pelvis over the sim position after the stop from ${v0}`).toBeLessThan(Math.abs(pose[PoseIdx.ROOT_FWD]!) + 0.01);
    }
  });

  it('stop, start, stop again: the run starting from the settled stance keeps its first stances planted too', () => {
    const r = rig();
    const res = drive(r, 600, (t) => {
      const u = t % 200;
      return u < 80 ? Math.min(5, (8 * u) / 60) : u < 120 ? 5 : Math.max(0, 5 - (8 * (u - 120)) / 60);
    }, 0);
    expect(res.contacts).toBeGreaterThanOrEqual(20);
    expect(res.slip, 'planted toe slip').toBeLessThan(0.02);
    expect(res.jump, 'planted toe one-frame move').toBeLessThan(0.02);
  });

  it('a start from rest (players accelerate at 4.5-8 m/s^2) keeps planted toes within 2 cm from the first moving frame', () => {
    for (const acc of [3, 4.5, 6, 8]) {
      const r = rig();
      const res = drive(r, 200, (t) => Math.min(5, (acc * (t + 1)) / 60), 0);
      expect(res.slip, `planted toe slip from rest at ${acc} m/s^2`).toBeLessThan(0.02);
      expect(res.jump, `planted toe one-frame move from rest at ${acc} m/s^2`).toBeLessThan(0.02);
    }
  });

  it('creeping at walking pace in the idle clip steps instead of gliding on the idle stance', () => {
    for (const v of [0.15, 0.3]) {
      const r = rig();
      const res = drive(r, 400, () => v, 60);
      expect(res.contacts, `steps at ${v} m/s`).toBeGreaterThanOrEqual(6);
      expect(res.slip, `planted toe slip at ${v} m/s`).toBeLessThan(0.02);
    }
  });
});
