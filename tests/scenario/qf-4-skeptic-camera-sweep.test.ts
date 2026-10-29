/**
 * [QF-4 skeptic] QA-31 sweeps from angles the first pass did not run (its live sweeps used the default Broadcast
 * camera at fixed 60 / 120 Hz pacing): every camera type with the Height / Zoom sliders at their extremes, 4:3 and
 * 19.5:9, mirrored controls, reduced camera motion, irregular frame pacing (a 60 Hz display dropping frames), and goal
 * replays + establishing shots. Live CPU v CPU through the real GameRenderer (tests/scenario/qf-4-rig.ts).
 * Checks per drawn frame of open play on the main camera: the camera inside its envelope (never below its height band,
 * never into the stand), the drawn (interpolated) ball on screen and above the touch controls / HUD radar.
 */
import { describe, expect, it } from 'vitest';
import { GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, HALF_WIDTH } from '../../src/contracts/constants';
import { CameraType, MatchPhase } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { T_CAMERA } from '../../src/contracts/tuning';
import { cameraEnvelope, radarZoneMargin, touchZoneMargin, touchZones } from '../../src/render/camera/broadcast';
import { LOCAL_TUNING as CINE } from '../../src/render/camera/cinematic';
import { copyState } from '../../src/sim/core/clone';
import { step } from '../../src/sim/step';
import { createLiveRig, toScreen } from './qf-4-rig';

interface Case { type: CameraType; height: number; zoom: number; w: number; h: number; mirror: boolean; reduced: boolean; jitter: boolean; seed: number }

function sweep(c: Case, ticks: number): { frames: number; off: number; under: number; outEnv: number; worst: string } {
  const st = createDefaultSettings();
  st.camera.type = c.type; st.camera.height = c.height; st.camera.zoom = c.zoom;
  st.controls.touch.mirror = c.mirror;
  st.accessibility.reducedCameraMotion = c.reduced;
  const Z = touchZones(st, { clusterW: 0, clusterH: 0, stickW: 0, stickH: 0, mirror: false, hudScale: 1 });
  const env = cameraEnvelope(c.type, { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 });
  const g = createLiveRig({ seed: c.seed, w: c.w, h: c.h, settings: st, config: { halfMinutes: 3 } });
  let rnd = c.seed * 7919 + 13;
  const rand = (): number => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  let acc = 0, now = 1000, frame = 0, done = 0;
  const out = { frames: 0, off: 0, under: 0, outEnv: 0, worst: '' };
  while (done < ticks) {
    // A 60 Hz display: steady, or dropping a frame now and then (33-50 ms) with +-20% jitter.
    const dt = !c.jitter ? 1 / 60 : rand() < 0.04 ? 0.033 + rand() * 0.017 : (1 / 60) * (0.8 + rand() * 0.4);
    acc += dt; now += dt * 1000;
    let n = 0;
    while (acc >= 1 / 60) {
      copyState(g.prev, g.s);
      step(g.s, g.frames, g.ev);
      g.r.onEvents(g.ev, g.s);
      acc -= 1 / 60; n++; done++;
    }
    frame++;
    const alpha = acc * 60;
    g.r.render(g.prev, g.s, alpha, { nowMs: now, dtMs: dt * 1000, frame, ticks: n, paused: false });
    const cam = g.camera, p = cam.position;
    const main = c.type === CameraType.END_TO_END ? p.y > 9 : p.z > HALF_WIDTH + 20;
    if (g.s.match.phase !== MatchPhase.IN_PLAY || !main) continue;
    out.frames++;
    const pb = g.prev.ball, cb = g.s.ball;
    const bx = pb.x + (cb.x - pb.x) * alpha, by = pb.y + (cb.y - pb.y) * alpha, bz = pb.z + (cb.z - pb.z) * alpha;
    const q = toScreen(cam, c.w, c.h, bx, by, bz);
    if (!q || q.x < 0 || q.x > c.w || q.y < 0 || q.y > c.h) { out.off++; if (!out.worst) out.worst = `off t${g.s.tick}`; continue; }
    const m = Math.max(T_CAMERA.ballBottomMargin, touchZoneMargin(q.x, c.w, c.h, Z), radarZoneMargin(q.x, c.w, c.h, Z));
    if (q.y > (1 - m) * c.h + 2) { out.under++; if (!out.worst) out.worst = `under t${g.s.tick} ${q.x.toFixed(0)},${q.y.toFixed(0)}`; }
    if (p.x < env.minX - 0.01 || p.x > env.maxX + 0.01 || p.y < env.minY - 0.01 || p.y > env.maxY + 0.01 || p.z < env.minZ - 0.01 || p.z > env.maxZ + 0.01) out.outEnv++;
  }
  return out;
}

/** Camera yaw / pitch / x per drawn frame of open play on the main camera, with the frame times. */
function cameraTrace(seed: number, ticks: number, jitter: boolean): { t: number[]; x: number[]; yaw: number[]; pitch: number[] } {
  const g = createLiveRig({ seed, config: { halfMinutes: 3 } });
  let rnd = seed * 7919 + 13;
  const rand = (): number => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  let acc = 0, now = 0, frame = 0, done = 0;
  const out = { t: [] as number[], x: [] as number[], yaw: [] as number[], pitch: [] as number[] };
  const e = { x: 0, y: 0 };
  while (done < ticks) {
    const dt = !jitter ? 1 / 60 : rand() < 0.04 ? 0.033 + rand() * 0.017 : (1 / 60) * (0.8 + rand() * 0.4);
    acc += dt; now += dt;
    let n = 0;
    while (acc >= 1 / 60) {
      copyState(g.prev, g.s);
      step(g.s, g.frames, g.ev);
      g.r.onEvents(g.ev, g.s);
      acc -= 1 / 60; n++; done++;
    }
    frame++;
    g.r.render(g.prev, g.s, acc * 60, { nowMs: now * 1000, dtMs: dt * 1000, frame, ticks: n, paused: false });
    const c = g.camera;
    if (g.s.match.phase !== MatchPhase.IN_PLAY || c.position.z < HALF_WIDTH + 20) { out.t.push(NaN); out.x.push(NaN); out.yaw.push(NaN); out.pitch.push(NaN); continue; }
    // Yaw / pitch from the camera's forward vector.
    const q = c.quaternion;
    const fx = -2 * (q.x * q.z + q.w * q.y), fy = -2 * (q.y * q.z - q.w * q.x), fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    e.x = Math.atan2(-fx, -fz); e.y = Math.atan2(-fy, Math.hypot(fx, fz));
    out.t.push(now); out.x.push(c.position.x); out.yaw.push(e.x); out.pitch.push(e.y);
  }
  return out;
}

/** 99th percentile of |second derivative| (per s^2) of a sampled channel, skipping gaps (NaN) and cuts (> jump). */
function accelP99(t: number[], v: number[], jump: number): number {
  const a: number[] = [];
  for (let k = 1; k + 1 < t.length; k++) {
    const t0 = t[k - 1]!, t1 = t[k]!, t2 = t[k + 1]!;
    if (!(t0 === t0 && t1 === t1 && t2 === t2)) continue;
    const d1 = v[k]! - v[k - 1]!, d2 = v[k + 1]! - v[k]!;
    if (Math.abs(d1) > jump || Math.abs(d2) > jump) continue;
    a.push(Math.abs(d2 / (t2 - t1) - d1 / (t1 - t0)) / ((t2 - t0) / 2));
  }
  a.sort((p, q) => p - q);
  return a[Math.floor(a.length * 0.99)] ?? NaN;
}

describe('QF-4 skeptic QA-31: camera settings, aspects and frame pacing', () => {
  it('glitch: jitter - a 60 Hz display dropping and jittering frames does not shake the main camera (motion as smooth as at steady pacing)', () => {
    const steady = cameraTrace(5, 3000, false), rough = cameraTrace(5, 3000, true);
    const rows: string[] = [];
    for (const [name, jump] of [['x', 3], ['yaw', 0.2], ['pitch', 0.2]] as const) {
      const a0 = accelP99(steady.t, steady[name], jump), a1 = accelP99(rough.t, rough[name], jump);
      rows.push(`${name} ${a0.toFixed(3)} -> ${a1.toFixed(3)}`);
      expect(a0, name).toBeGreaterThan(0);
      // The smoothing runs on real frame time and interpolated positions: uneven frames add no shake.
      expect(a1, `${name} acceleration p99 steady -> rough pacing: ${rows.join(', ')}`).toBeLessThan(a0 * 1.35 + 1e-3);
    }
  }, 300000);

  it('glitch: dipping below ground or into the stand - every camera type at slider extremes keeps the camera in its box and the ball on screen, clear of the controls', () => {
    const cases: Case[] = [
      // [FEEL-1] seed 3 -> 5: the FEEL-1 shot changes reshaped seed 3's match (a goal + replay early: 1031 open-play frames), every seed-3 case
      { type: CameraType.BROADCAST, height: 0, zoom: 20, w: 1180, h: 820, mirror: false, reduced: false, jitter: true, seed: 5 },
      { type: CameraType.BROADCAST, height: 20, zoom: 0, w: 1688, h: 780, mirror: false, reduced: true, jitter: true, seed: 5 },
      { type: CameraType.WIDE, height: 20, zoom: 0, w: 1024, h: 768, mirror: true, reduced: false, jitter: false, seed: 4 },
      { type: CameraType.CLOSE, height: 0, zoom: 20, w: 1024, h: 768, mirror: false, reduced: false, jitter: true, seed: 4 },
      { type: CameraType.CLOSE, height: 0, zoom: 20, w: 1024, h: 768, mirror: true, reduced: false, jitter: false, seed: 4 },
      { type: CameraType.END_TO_END, height: 0, zoom: 20, w: 1180, h: 820, mirror: false, reduced: false, jitter: true, seed: 5 },
      { type: CameraType.END_TO_END, height: 20, zoom: 0, w: 1688, h: 780, mirror: true, reduced: true, jitter: false, seed: 5 },
    ];
    for (const c of cases) {
      const r = sweep(c, 2400);
      const tag = `${CameraType[c.type]} h${c.height} z${c.zoom} ${c.w}x${c.h}${c.mirror ? ' mirror' : ''}${c.reduced ? ' reduced' : ''}${c.jitter ? ' jitter' : ''}`;
      expect(r.frames, `${tag}: open-play frames on the main camera`).toBeGreaterThan(1200);
      expect(r.outEnv, `${tag}: frames outside the camera envelope`).toBe(0);
      expect(r.off, `${tag}: frames with the ball off screen ${r.worst}`).toBe(0);
      expect(r.under, `${tag}: frames with the ball under the controls / radar ${r.worst}`).toBe(0);
    }
  }, 600000);

  it('goal replays and establishing shots stay in front of the stands, above the grass and out of the goals', () => {
    // Seed 25 scores early (its replay starts at tick 1716): the replay plays both angles. [FIN-K] Was seed 8 (a goal
    // around tick 1630), which no longer scores inside the 3000 ticks after FIN-K's sim changes.
    const g = createLiveRig({ seed: 25, config: { halfMinutes: 3 } });
    let replay = 0, est = 0, angleCuts = 0;
    let last: { x: number; y: number; z: number } | null = null;
    for (let t = 0; t < 3000; t++) {
      g.tick();
      const ph = g.s.match.phase, c = g.camera.position;
      const rep = ph === MatchPhase.REPLAY, es = ph === MatchPhase.PRE_MATCH || ph === MatchPhase.HALF_TIME || ph === MatchPhase.FULL_TIME;
      if (!rep && !es) { last = null; continue; }
      if (rep) replay++; else est++;
      const tag = `${MatchPhase[ph]} t${g.s.tick} camera ${c.x.toFixed(1)},${c.y.toFixed(1)},${c.z.toFixed(1)}`;
      expect(Math.abs(c.x), tag).toBeLessThanOrEqual(CINE.maxX + 0.01);
      expect(Math.abs(c.z), tag).toBeLessThanOrEqual(CINE.maxZ + 0.01);
      expect(c.y, tag).toBeGreaterThanOrEqual(CINE.minY - 0.01);
      const inGoal = Math.abs(c.x) > HALF_LENGTH - 0.2 && Math.abs(c.x) < HALF_LENGTH + 2.2 && Math.abs(c.z) < GOAL_HALF_WIDTH + 0.2 && c.y < GOAL_HEIGHT + 0.2;
      expect(inGoal, `${tag}: inside a goal`).toBe(false);
      if (rep && last && Math.hypot(c.x - last.x, c.y - last.y, c.z - last.z) > 3) angleCuts++;
      last = rep ? { x: c.x, y: c.y, z: c.z } : null;
    }
    expect(est).toBeGreaterThan(100);
    expect(replay).toBeGreaterThan(200);
    // One cut between the two angles; the rest of the replay moves smoothly.
    expect(angleCuts).toBeLessThanOrEqual(1);
  }, 300000);
});
