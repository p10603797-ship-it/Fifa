/**
 * [GFX-13] Ball and blob shadows (section 8 "Look": "Shadows are blobs or cheap projections"; section 13: no
 * real-time shadow maps at the default tier). The ball is drawn at the interpolated position; its blob shadow
 * sits on the grass under it, shrinking and fading with height so high balls stay readable. One instanced blob
 * per player too (feet contact reads at broadcast distance).
 *
 * WAVE 0 BASELINE (FND-05): white sphere of BALL_RADIUS, ball blob, 22 player blobs (one instanced draw).
 * GFX-13 adds spin/roll, a panel texture, landing markers and quality tiers.
 */

import {
  DataTexture, DynamicDrawUsage, InstancedMesh, LinearFilter, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  PlaneGeometry, RGBAFormat, SphereGeometry,
} from 'three';
import { BALL_RADIUS, NUM_SLOTS } from '../contracts/constants';
import type { RenderContext, RenderFrame, RenderModule } from './types';

/** Height of shadow decals above the grass (m), above the pitch plane to avoid z-fighting. */
export const SHADOW_Y = 0.02;
const PLAYER_BLOB_SIZE = 1.15;

export interface BallModule extends RenderModule {
  readonly ball: Mesh;
  readonly shadow: Mesh;
  readonly playerShadows: InstancedMesh;
}

/** Radial alpha blob texture (generated, no assets). */
export function createBlobTexture(size = 64): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - c) * (x - c) + (y - c) * (y - c)) / c;
      const a = d >= 1 ? 0 : (1 - d * d) * (1 - d * d);
      const i = (y * size + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new DataTexture(data, size, size, RGBAFormat);
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

export function createBall(ctx: RenderContext): BallModule {
  const ballGeo = new SphereGeometry(BALL_RADIUS, 16, 12);
  const ballMat = new MeshLambertMaterial({ color: 0xffffff, emissive: 0x303030 });
  const ball = new Mesh(ballGeo, ballMat);
  ball.name = 'ball';
  ball.visible = false;
  ball.renderOrder = 1;

  const blobTex = createBlobTexture();
  const quad = new PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  const shadowMat = new MeshBasicMaterial({
    color: 0x000000, map: blobTex, transparent: true, opacity: 0.55, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const shadow = new Mesh(quad, shadowMat);
  shadow.name = 'ball-shadow';
  shadow.visible = false;
  shadow.renderOrder = 1;

  const playerShadowMat = new MeshBasicMaterial({
    color: 0x000000, map: blobTex, transparent: true, opacity: 0.38, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
  const playerShadows = new InstancedMesh(quad, playerShadowMat, NUM_SLOTS);
  playerShadows.name = 'player-shadows';
  playerShadows.instanceMatrix.setUsage(DynamicDrawUsage);
  playerShadows.frustumCulled = false;
  playerShadows.visible = false;
  playerShadows.renderOrder = 1;
  const m = playerShadows.instanceMatrix.array as Float32Array;
  for (let i = 0; i < NUM_SLOTS; i++) {
    const o = i * 16;
    m.fill(0, o, o + 16);
    m[o + 15] = 1;
  }

  ctx.scene.add(ball);
  ctx.scene.add(shadow);
  ctx.scene.add(playerShadows);

  return {
    ball,
    shadow,
    playerShadows,
    setMatch() {
      ball.visible = true;
      shadow.visible = true;
      playerShadows.visible = true;
    },
    update(f: RenderFrame) {
      const it = f.interp;
      ball.position.set(it.ballX, it.ballY, it.ballZ);
      const h = Math.max(0, it.ballY - BALL_RADIUS);
      const sc = BALL_RADIUS * 3.2 * (1 + h * 0.12);
      shadow.position.set(it.ballX, SHADOW_Y + 0.002, it.ballZ);
      shadow.scale.set(sc, 1, sc);
      shadowMat.opacity = 0.55 / (1 + h * 0.35);
      const s = f.curr;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const o = i * 16;
        const size = s.players[i]!.active === 1 ? PLAYER_BLOB_SIZE : 0;
        m[o] = size; m[o + 5] = 1; m[o + 10] = size;
        m[o + 12] = it.x[i]!; m[o + 13] = SHADOW_Y; m[o + 14] = it.z[i]!;
      }
      playerShadows.instanceMatrix.needsUpdate = true;
    },
    clearMatch() {
      ball.visible = false;
      shadow.visible = false;
      playerShadows.visible = false;
    },
    dispose() {
      ctx.scene.remove(ball, shadow, playerShadows);
      ballGeo.dispose(); ballMat.dispose();
      quad.dispose(); shadowMat.dispose(); playerShadowMat.dispose(); blobTex.dispose();
      playerShadows.dispose();
    },
  };
}
