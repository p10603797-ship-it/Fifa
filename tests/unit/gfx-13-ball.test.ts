/**
 * [GFX-13] Ball, spin and blob shadows: panel texture pattern, blob size / fade with height, spin integration
 * (rolling without slipping, airborne sim spin, clamps, placements, hands, pause), and the module in a headless
 * scene (meshes, draw calls, positions, inactive player blobs, quality tiers, dispose). Node only; the e2e spec
 * gfx-13-markers checks the pixels.
 */
import { spawnSync } from 'node:child_process';
import { Mesh, PerspectiveCamera, Quaternion, Scene, SRGBColorSpace, Vector3, type WebGLRenderer } from 'three';
import { describe, expect, it } from 'vitest';
import { BALL_RADIUS, NUM_SLOTS } from '../../src/contracts/constants';
import { MatchPhase, QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createMatchConfig, type SimState } from '../../src/contracts/state';
import {
  BALL_DOTS, BALL_PANEL_COLOURS, BALL_SEGMENTS, BALL_TUNING, SHADOW_Y, advanceBallSpin, ballBlob, ballPanelAt,
  createBall, createBallSpin, createBallTexture, resetBallSpin,
} from '../../src/render/ball';
import { fillInterp } from '../../src/render/index';
import { createInterpState, type RenderContext, type RenderFrame } from '../../src/render/types';
import { initMatch } from '../../src/sim/init';

function makeCtx(tier = QualityTier.BALANCED): RenderContext {
  const s = createDefaultSettings();
  return {
    renderer: null as unknown as WebGLRenderer, scene: new Scene(), camera: new PerspectiveCamera(22, 1180 / 820, 2, 600),
    settings: s, clubs: [], size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier, cameraSettings: { ...s.camera },
    reducedMotion: false, night: false,
  };
}

function makeFrame(s: SimState, dtMs = 1000 / 60, paused = false): RenderFrame {
  const interp = createInterpState();
  fillInterp(interp, s, s, 1);
  return { prev: s, curr: s, alpha: 1, frame: { nowMs: 0, dtMs, frame: 0, ticks: 1, paused }, interp };
}

describe('GFX-13 ball panel texture', () => {
  it('twelve dots at the icosahedron vertices, alternately ink and ember, ringed by a seam, white between', () => {
    for (let i = 0; i < 12; i++) {
      const x = BALL_DOTS[i * 3]!, y = BALL_DOTS[i * 3 + 1]!, z = BALL_DOTS[i * 3 + 2]!;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
      expect(ballPanelAt(x, y, z)).toBe(i % 2 === 0 ? 1 : 2);
    }
    // Nearest-neighbour dots are 63.4 degrees apart: the midpoint of two neighbours is white.
    const a = [BALL_DOTS[0]!, BALL_DOTS[1]!, BALL_DOTS[2]!];
    const b = [BALL_DOTS[3]!, BALL_DOTS[4]!, BALL_DOTS[5]!];
    const m = [a[0]! + b[0]!, a[1]! + b[1]!, a[2]! + b[2]!];
    const l = Math.hypot(m[0]!, m[1]!, m[2]!);
    expect(ballPanelAt(m[0]! / l, m[1]! / l, m[2]! / l)).toBe(0);
    // Just outside the dot radius: seam.
    const r = BALL_TUNING.dotRadius + BALL_TUNING.seamWidth / 2;
    const n = new Vector3(a[0], a[1], a[2]).applyAxisAngle(new Vector3(1, 0, 0), r);
    expect(ballPanelAt(n.x, n.y, n.z)).toBe(3);
  });

  it('texture is equirectangular 128 x 64 sRGB, mostly white with ink, ember and seam texels, mipmapped', () => {
    const tex = createBallTexture();
    expect(tex.image.width).toBe(128);
    expect(tex.image.height).toBe(64);
    expect(tex.colorSpace).toBe(SRGBColorSpace);
    expect(tex.generateMipmaps).toBe(true);
    const d = tex.image.data as Uint8Array;
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) {
      const c = (d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!;
      const k = BALL_PANEL_COLOURS.indexOf(c);
      expect(k).toBeGreaterThanOrEqual(0);
      counts[k]!++;
      expect(d[i + 3]).toBe(255);
    }
    const total = 128 * 64;
    expect(counts[0]! / total).toBeGreaterThan(0.5);
    for (const k of [1, 2, 3]) expect(counts[k]!, `panel ${k}`).toBeGreaterThan(total * 0.02);
    tex.dispose();
  });

  it('texel mapping matches SphereGeometry UVs: the texel at a vertex UV shows that vertex direction', () => {
    // SphereGeometry: u = phi / 2pi, v = 1 - theta / pi, direction (-cos phi sin theta, cos theta, sin phi sin theta).
    const tex = createBallTexture();
    const d = tex.image.data as Uint8Array;
    for (let i = 0; i < 12; i++) {
      const x = BALL_DOTS[i * 3]!, y = BALL_DOTS[i * 3 + 1]!, z = BALL_DOTS[i * 3 + 2]!;
      const theta = Math.acos(y);
      let phi = Math.atan2(z, -x);
      if (phi < 0) phi += 2 * Math.PI;
      const u = phi / (2 * Math.PI), v = 1 - theta / Math.PI;
      const ti = Math.min(127, Math.floor(u * 128)), tj = Math.min(63, Math.floor(v * 64));
      const o = (tj * 128 + ti) * 4;
      expect((d[o]! << 16) | (d[o + 1]! << 8) | d[o + 2]!, `dot ${i}`).toBe(BALL_PANEL_COLOURS[i % 2 === 0 ? 1 : 2]);
    }
    tex.dispose();
  });
});

describe('GFX-13 blob shadows', () => {
  it('ball blob grows and fades with height, never below the opacity floor, finite for junk input', () => {
    const o = { h: 0, size: 0, opacity: 0 };
    ballBlob(0, o);
    expect(o.size).toBeCloseTo(BALL_RADIUS * BALL_TUNING.ballBlobRadii, 9);
    expect(o.opacity).toBeCloseTo(BALL_TUNING.ballBlobOpacity, 9);
    let lastSize = o.size, lastOp = o.opacity;
    for (const h of [0.5, 1, 3, 6, 12]) {
      ballBlob(h, o);
      expect(o.size).toBeGreaterThan(lastSize);
      expect(o.opacity).toBeLessThan(lastOp);
      lastSize = o.size; lastOp = o.opacity;
    }
    ballBlob(80, o);
    expect(o.opacity).toBe(BALL_TUNING.ballBlobMinOpacity);
    for (const junk of [-5, Number.NaN, Infinity]) {
      ballBlob(junk, o);
      expect(Number.isFinite(o.size) && Number.isFinite(o.opacity)).toBe(true);
      expect(o.size).toBeCloseTo(BALL_RADIUS * BALL_TUNING.ballBlobRadii, 9);
    }
  });
});

describe('GFX-13 ball spin', () => {
  const top = (q: Quaternion): Vector3 => new Vector3(0, 1, 0).applyQuaternion(q);

  it('first frame only records the position', () => {
    const st = createBallSpin();
    expect(advanceBallSpin(st, 3, 0.11, 2, 0, 0, 0, 1 / 60, false)).toBe(0);
    expect(st.has).toBe(true);
    expect(st.q.equals(new Quaternion())).toBe(true);
  });

  it('rolling +x without slipping: angle = travel / radius and the top of the ball moves toward +x', () => {
    const st = createBallSpin();
    advanceBallSpin(st, 0, 0.11, 0, 0, 0, 0, 1 / 60, false);
    const a = advanceBallSpin(st, 0.05, 0.11, 0, 0, 0, 0, 1 / 60, false);
    expect(a).toBeCloseTo(0.05 / BALL_RADIUS, 9);
    const t = top(st.q);
    expect(t.x).toBeGreaterThan(0.4);
    expect(Math.abs(t.z)).toBeLessThan(1e-9);
  });

  it('rolling +z: the top moves toward +z; curl spin sy adds a turn about +y on the ground', () => {
    const st = createBallSpin();
    advanceBallSpin(st, 0, 0.11, 0, 0, 0, 0, 1 / 60, false);
    advanceBallSpin(st, 0, 0.11, 0.04, 0, 0, 0, 1 / 60, false);
    expect(top(st.q).z).toBeGreaterThan(0.3);
    const st2 = createBallSpin();
    advanceBallSpin(st2, 0, 0.11, 0, 0, 0, 0, 1 / 60, false);
    const a = advanceBallSpin(st2, 0, 0.11, 0, 0, 12, 0, 1 / 60, false);
    expect(a).toBeCloseTo(12 / 60, 9);
    const fwd = new Vector3(1, 0, 0).applyQuaternion(st2.q);
    expect(fwd.z).toBeLessThan(0); // +12 rad/s about +y turns +x toward -z
  });

  it('airborne: turns with the sim spin * dt (backspin about the horizontal axis)', () => {
    const st = createBallSpin();
    advanceBallSpin(st, 0, 3, 0, 0, 0, 0, 1 / 60, false);
    const a = advanceBallSpin(st, 0.3, 3.1, 0, 0, 0, 9, 1 / 60, false);
    expect(a).toBeCloseTo(9 / 60, 9);
    const axis = new Vector3();
    const q = st.q;
    const ang = 2 * Math.acos(Math.min(1, q.w));
    axis.set(q.x, q.y, q.z).divideScalar(Math.sin(ang / 2));
    expect(axis.z).toBeCloseTo(1, 6);
  });

  it('per-frame angle clamped (fast roll never strobes backwards)', () => {
    const st = createBallSpin();
    advanceBallSpin(st, 0, 0.11, 0, 0, 0, 0, 1 / 60, false);
    const a = advanceBallSpin(st, 0.5, 0.11, 0, 0, 0, 0, 1 / 60, false); // 30 m/s roll: 4.5 rad in one frame
    expect(a).toBe(BALL_TUNING.maxSpinStepRad);
    expect(top(st.q).x).toBeGreaterThan(0); // still turns forward
  });

  it('no rotation for placements, a ball in hands, a paused frame, or junk spin; state stays finite', () => {
    const st = createBallSpin();
    advanceBallSpin(st, 0, 0.11, 0, 0, 0, 0, 1 / 60, false);
    expect(advanceBallSpin(st, 20, 0.11, 0, 0, 0, 0, 1 / 60, false)).toBe(0); // restart placement
    expect(advanceBallSpin(st, 20.05, 1.2, 0, 30, 30, 30, 1 / 60, true)).toBe(0); // in hands
    expect(advanceBallSpin(st, 20.1, 0.11, 0, 0, 0, 0, 0, false)).toBe(0); // paused
    expect(advanceBallSpin(st, 20.1, 3, 0, Number.NaN, Infinity, 0, 1 / 60, false)).toBe(0); // junk airborne spin
    expect(st.q.equals(new Quaternion())).toBe(true);
    advanceBallSpin(st, Number.NaN, 0.11, 0, 0, 0, 0, 1 / 60, false);
    expect(st.lastX).toBe(20.1); // junk positions are not recorded
    resetBallSpin(st);
    expect(st.has).toBe(false);
  });
});

describe('GFX-13 ball module (headless)', () => {
  function setup(tier = QualityTier.BALANCED): { ctx: RenderContext; s: SimState; mod: ReturnType<typeof createBall> } {
    const ctx = makeCtx(tier);
    const s = initMatch(createMatchConfig());
    s.match.phase = MatchPhase.IN_PLAY;
    const mod = createBall(ctx);
    mod.setMatch!(s, []);
    return { ctx, s, mod };
  }

  it('adds exactly 3 drawables (ball, ball blob, one instanced player-blob mesh) within the triangle budget', () => {
    const { ctx, mod } = setup(QualityTier.QUALITY);
    const meshes = ctx.scene.children.filter((c) => c instanceof Mesh);
    expect(meshes).toHaveLength(3);
    expect(mod.playerShadows.count).toBe(NUM_SLOTS);
    const tris = (m: Mesh): number => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position!.count) / 3;
    expect(tris(mod.ball)).toBeLessThan(1200);
    expect(tris(mod.shadow) + tris(mod.playerShadows) * NUM_SLOTS).toBeLessThan(100);
  });

  it('ball at the interpolated position, blob under it on the grass, scaled and faded by height', () => {
    const { s, mod } = setup();
    s.ball.x = 12; s.ball.y = 4.11; s.ball.z = -6;
    mod.update(makeFrame(s));
    expect(mod.ball.position.toArray()).toEqual([12, 4.11, -6]);
    expect(mod.shadow.position.x).toBe(12);
    expect(mod.shadow.position.z).toBe(-6);
    expect(mod.shadow.position.y).toBeCloseTo(SHADOW_Y + 0.002, 9);
    const o = ballBlob(4, { h: 0, size: 0, opacity: 0 });
    expect(mod.shadow.scale.x).toBeCloseTo(o.size, 6);
    expect((mod.shadow.material as { opacity: number }).opacity).toBeCloseTo(o.opacity, 6);
    expect(mod.shadow.visible).toBe(true);
    // Sunk below the grass (tests hide the ball this way): no blob drawn.
    s.ball.y = -3;
    mod.update(makeFrame(s));
    expect(mod.shadow.visible).toBe(false);
  });

  it('player blobs follow players, scale with height, and collapse for sent-off (inactive) slots', () => {
    const { s, mod } = setup();
    s.players[4]!.x = 7; s.players[4]!.z = 3;
    s.attrs[4]!.height = 198;
    s.players[15]!.active = 0;
    mod.update(makeFrame(s));
    const m = mod.playerShadows.instanceMatrix.array as Float32Array;
    expect(m[4 * 16 + 12]).toBeCloseTo(7, 6);
    expect(m[4 * 16 + 14]).toBeCloseTo(3, 6);
    expect(m[4 * 16]).toBeCloseTo(BALL_TUNING.playerBlobSize * 198 / 180, 5);
    expect(m[15 * 16]).toBe(0);
    expect(m[15 * 16 + 10]).toBe(0);
    for (let i = 0; i < m.length; i++) expect(Number.isFinite(m[i]!)).toBe(true);
  });

  it('the ball rolls as it moves along the ground and stops turning when paused', () => {
    const { s, mod } = setup();
    s.ball.x = 0; s.ball.y = BALL_RADIUS; s.ball.z = 0;
    mod.update(makeFrame(s));
    s.ball.x = 0.1;
    mod.update(makeFrame(s));
    const q1 = mod.ball.quaternion.clone();
    expect(q1.equals(new Quaternion())).toBe(false);
    s.ball.x = 0.2;
    mod.update(makeFrame(s, 16, true));
    expect(mod.ball.quaternion.equals(q1)).toBe(true);
  });

  it('quality tiers swap the sphere detail; QUALITY casts into the shadow map', () => {
    const { mod } = setup(QualityTier.BALANCED);
    const pos = (): number => mod.ball.geometry.attributes.position!.count;
    const bal = pos();
    mod.setQuality!(QualityTier.PERFORMANCE);
    expect(pos()).toBeLessThan(bal);
    expect(mod.ball.castShadow).toBe(false);
    mod.setQuality!(QualityTier.QUALITY);
    expect(pos()).toBeGreaterThan(bal);
    expect(mod.ball.castShadow).toBe(true);
    mod.setQuality!(QualityTier.AUTO);
    expect(pos()).toBe(bal);
    expect(BALL_SEGMENTS[QualityTier.AUTO]).toEqual(BALL_SEGMENTS[QualityTier.BALANCED]);
  });

  it('clearMatch hides everything; dispose removes the meshes from the scene', () => {
    const { ctx, s, mod } = setup();
    mod.update(makeFrame(s));
    mod.clearMatch!();
    expect(mod.ball.visible || mod.shadow.visible || mod.playerShadows.visible).toBe(false);
    mod.update(makeFrame(s));
    expect(mod.shadow.visible).toBe(false);
    mod.dispose();
    expect(ctx.scene.children.filter((c) => c instanceof Mesh)).toHaveLength(0);
  });
});

describe('GFX-13 no per-frame allocation', () => {
  it('ball, blob shadows and every on-pitch aid (landing target, labels, off-screen arrow) allocate nothing per frame', () => {
    const r = spawnSync(process.execPath, ['--expose-gc', '--import', 'tsx', 'tests/unit/gfx-13-alloc-probe.ts', '50000'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 150_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const bytes = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, number>;
    expect(Object.keys(bytes).sort()).toEqual(['ball', 'markers', 'markersArrow']);
    // A single boxed double is 12 bytes; what remains is measurement noise.
    for (const [name, b] of Object.entries(bytes)) expect(b, name).toBeLessThan(8);
  }, 180_000);
});
