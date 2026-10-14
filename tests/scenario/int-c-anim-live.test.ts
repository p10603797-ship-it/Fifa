/**
 * [INT-C] GFX-12 animation in live play, without WebGL: the real sim (CPU v CPU, fixed seed) steps the real pipeline;
 * the real player model (GFX-07) with the GFX-12 driver poses all 22 players from interpolated render frames, as
 * render/index.ts does. Measured in the world, like the e2e: (1) planted boots do not slide while players run, turn,
 * speed up and slow down; (2) the kicking boot meets the ball on KICK events of kick actions.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { ActionKind, ControllerKind, MatchPhase, QualityTier } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createInputFrame } from '../../src/contracts/input';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { fillInterp } from '../../src/render/index';
import { createPlayerModel } from '../../src/render/players/model';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { cloneState, copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

const TOE = [0.2, -0.08], HEEL = [-0.07, -0.08]; // fk.ts BODY.toeX / heelX, -ankleY
const ANKLES = [9, 12];

function worldPoint(S: Float64Array, j: number, lx: number, ly: number, out: number[]): void {
  const o = j * 12;
  out[0] = S[o]! * lx + S[o + 3]! * ly + S[o + 9]!;
  out[1] = S[o + 1]! * lx + S[o + 4]! * ly + S[o + 10]!;
  out[2] = S[o + 2]! * lx + S[o + 5]! * ly + S[o + 11]!;
}

interface Measure {
  slipP50: number; stationary: number; grounded: number; kicks: number; contactMedian: number; contactMax: number;
  /** Kick actions launched with the ball out of a boot's reach (sim side: > 1 m away or above 0.5 m). */
  outOfReach: number;
}

/** Run `ticks` of CPU v CPU play from tick `from`, rendering `framesPerTick` frames per tick. */
function measure(seed: number, from: number, ticks: number, framesPerTick: number): Measure {
  const cfg = createMatchConfig();
  cfg.seed = seed;
  cfg.humans = cfg.humans.map((h) => ({ ...h, kind: ControllerKind.NONE, side: -1 }));
  const curr = initMatch(cfg) as SimState;
  const prev = cloneState(curr);
  const ev = createEventBuffer();
  const frames = [createInputFrame(), createInputFrame()];
  const settings = createDefaultSettings();
  const ctx: RenderContext = {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.44, 2, 600),
    settings, clubs: CLUBS, size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
  const model = createPlayerModel(ctx);
  model.setMatch!(curr, CLUBS);
  const f: RenderFrame = { prev, curr, alpha: 0, frame: { nowMs: 0, dtMs: 1000 / (60 * framesPerTick), frame: 0, ticks: 0, paused: false }, interp: createInterpState() };
  const last: (number[] | null)[] = Array.from({ length: NUM_SLOTS * 4 }, () => null);
  const q = [0, 0, 0];
  const ratios: number[] = [];
  const contact: number[] = [];
  const pendingKicks: { slot: number; x: number; y: number; z: number }[] = [];
  let outOfReach = 0;
  for (let t = 0; t < from + ticks; t++) {
    copyState(prev, curr);
    step(curr, frames, ev);
    const live = t >= from && curr.match.phase === MatchPhase.IN_PLAY;
    for (let i = 0; i < ev.count; i++) {
      const e = ev.get(i);
      if (e.type !== EventType.KICK || !live) continue;
      const p = curr.players[e.a]!;
      // Foot kick actions only (their clips have a contact phase); dribble touches and first touches have none.
      if (p.act !== ActionKind.KICK && p.act !== ActionKind.SHOT) continue;
      // A ball the sim kicks from beyond a boot's reach cannot be met by any pose (reported, not a render fault).
      if (Math.hypot(e.x - p.x, e.z - p.z) > 1 || e.y > 0.5) { outOfReach++; continue; }
      pendingKicks.push({ slot: e.a, x: e.x, y: e.y, z: e.z });
    }
    if (t < from - 30) continue; // let the driver settle before measuring
    for (let k = 0; k < framesPerTick; k++) {
      f.alpha = k / framesPerTick;
      f.frame.frame++;
      f.frame.nowMs += f.frame.dtMs;
      f.frame.ticks = k === 0 ? 1 : 0;
      fillInterp(f.interp, prev, curr, f.alpha);
      model.update(f);
      // The contact tick's frame at alpha 0 is the one that shows the ball at the foot (GFX-12: u = actT + alpha =
      // actContact), with the ball where the KICK event put it.
      if (k === 0) {
        for (const kk of pendingKicks) {
          let best = Infinity;
          for (const j of ANKLES) for (const fp of [TOE, HEEL]) {
            worldPoint(model.skeletons[kk.slot]!, j, fp[0]!, fp[1]!, q);
            best = Math.min(best, Math.hypot(q[0]! - kk.x, q[1]! - kk.y, q[2]! - kk.z));
          }
          contact.push(best);
        }
        pendingKicks.length = 0;
      }
      if (!live) { last.fill(null); continue; }
      for (let slot = 0; slot < NUM_SLOTS; slot++) {
        const p = curr.players[slot]!;
        const speed = Math.hypot(f.interp.vx[slot]!, f.interp.vz[slot]!);
        for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
          const key = slot * 4 + a * 2 + b;
          const fp = b === 0 ? TOE : HEEL;
          worldPoint(model.skeletons[slot]!, ANKLES[a]!, fp[0]!, fp[1]!, q);
          const was = last[key];
          if (was && speed > 2 && p.act === ActionKind.NONE && q[1]! < 0.003 && was[1]! < 0.003) {
            ratios.push((Math.hypot(q[0]! - was[0]!, q[2]! - was[2]!) * 60 * framesPerTick) / speed);
          }
          last[key] = was ? (was[0] = q[0]!, was[1] = q[1]!, was[2] = q[2]!, was) : [q[0]!, q[1]!, q[2]!];
        }
      }
    }
  }
  ratios.sort((x, y) => x - y);
  contact.sort((x, y) => x - y);
  let still = 0;
  for (const r of ratios) if (r < 0.1) still++;
  return {
    slipP50: ratios[(ratios.length - 1) >> 1] ?? -1,
    stationary: ratios.length ? still / ratios.length : -1,
    grounded: ratios.length,
    kicks: contact.length,
    contactMedian: contact[(contact.length - 1) >> 1] ?? -1,
    contactMax: contact[contact.length - 1] ?? -1,
    outOfReach,
  };
}

describe('INT-C animation in live play (sim + GFX-07 model + GFX-12 driver, no WebGL)', () => {
  it('planted boots stay planted while players run, turn and change speed (60 Hz display)', () => {
    const m = measure(20261014, 600, 1500, 1);
    console.log('INT-C anim 60Hz', JSON.stringify(m));
    // An ideal straight run (GFX-09 gait alone) reads p50 ~0.01 and a stationary share of 0.64-0.85 (toe-off and
    // heel-strike frames skim the grass inside the ground snap). Before INT-C: p50 0.43, share 0.22.
    expect(m.grounded).toBeGreaterThan(2000);
    expect(m.slipP50).toBeLessThan(0.08);
    expect(m.stationary).toBeGreaterThan(0.6);
    expect(m.kicks).toBeGreaterThan(3);
    expect(m.contactMedian).toBeLessThan(0.25);
    expect(m.contactMax).toBeLessThan(0.5);
  });

  it('120 Hz display (two frames per tick): same planting; kick actions meet the ball on the contact frame', () => {
    const m = measure(777, 600, 1500, 2);
    console.log('INT-C anim 120Hz', JSON.stringify(m));
    expect(m.grounded).toBeGreaterThan(2000);
    expect(m.slipP50).toBeLessThan(0.08);
    expect(m.stationary).toBeGreaterThan(0.6);
    expect(m.kicks).toBeGreaterThan(3);
    expect(m.contactMedian).toBeLessThan(0.25);
    expect(m.contactMax).toBeLessThan(0.5);
  });
});
