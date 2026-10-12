/**
 * [GFX-04] Goals and nets with ripple (section 8 "Look"; NET events ripple the net).
 * Geometry follows contracts/constants: inside of the posts at z = +-GOAL_HALF_WIDTH, underside of the bar at
 * GOAL_HEIGHT, POST_RADIUS cylinders standing on the goal line, net GOAL_DEPTH deep.
 *
 * WAVE 0 BASELINE (FND-05): white posts and bars as one instanced cylinder mesh (6 instances, 1 draw call) and a
 * simple net box (back, roof, sides) with a generated grid texture (1 draw call). GFX-04 adds the shaped net,
 * ripple on NET events and quality tiers.
 */

import {
  BufferAttribute, BufferGeometry, CylinderGeometry, DataTexture, DoubleSide, InstancedMesh, LinearFilter,
  LinearMipmapLinearFilter, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, Quaternion, RepeatWrapping,
  RGBAFormat, Vector3,
} from 'three';
import { GOAL_DEPTH, GOAL_HALF_WIDTH, GOAL_HEIGHT, HALF_LENGTH, POST_RADIUS } from '../contracts/constants';
import type { RenderContext, RenderFrame, RenderModule } from './types';

/** Net mesh cell size (m). */
const NET_CELL = 0.14;

export interface GoalsModule extends RenderModule {
  readonly frame: InstancedMesh;
  readonly net: Mesh;
}

/** Instance transforms for the goal frame: [post -z, post +z, bar] for the goal at -x, then the goal at +x. */
export function goalFrameMatrices(): Matrix4[] {
  const out: Matrix4[] = [];
  const postH = GOAL_HEIGHT + 2 * POST_RADIUS;
  const barLen = 2 * (GOAL_HALF_WIDTH + 2 * POST_RADIUS);
  const q = new Quaternion();
  const qBar = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  for (const end of [-1, 1]) {
    const x = end * (HALF_LENGTH - POST_RADIUS);
    for (const side of [-1, 1]) {
      out.push(new Matrix4().compose(new Vector3(x, postH / 2, side * (GOAL_HALF_WIDTH + POST_RADIUS)), q, new Vector3(1, postH, 1)));
    }
    out.push(new Matrix4().compose(new Vector3(x, GOAL_HEIGHT + POST_RADIUS, 0), qBar, new Vector3(1, barLen, 1)));
  }
  return out;
}

function createNetTexture(): DataTexture {
  const n = 16;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const line = x < 2 || y < 2;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = line ? 235 : 0;
    }
  }
  const tex = new DataTexture(data, n, n, RGBAFormat);
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Net box for both goals: back, roof and two sides per goal. UVs in cells so the grid tiles. */
function createNetGeometry(): BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number, uLen: number, vLen: number): void => {
    // a-b-c-d counter-clockwise; two triangles a,b,c and a,c,d.
    const u = uLen / NET_CELL, v = vLen / NET_CELL;
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    uv.push(0, 0, u, 0, u, v, 0, 0, u, v, 0, v);
  };
  const w = GOAL_HALF_WIDTH, h = GOAL_HEIGHT;
  for (const end of [-1, 1]) {
    const x0 = end * HALF_LENGTH;
    const x1 = end * (HALF_LENGTH + GOAL_DEPTH);
    quad(x1, 0, -w, x1, 0, w, x1, h, w, x1, h, -w, 2 * w, h); // back
    quad(x0, h, -w, x0, h, w, x1, h, w, x1, h, -w, 2 * w, GOAL_DEPTH); // roof
    quad(x0, 0, -w, x1, 0, -w, x1, h, -w, x0, h, -w, GOAL_DEPTH, h); // side -z
    quad(x0, 0, w, x1, 0, w, x1, h, w, x0, h, w, GOAL_DEPTH, h); // side +z
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geo.computeVertexNormals();
  return geo;
}

export function createGoals(ctx: RenderContext): GoalsModule {
  const cyl = new CylinderGeometry(POST_RADIUS, POST_RADIUS, 1, 12, 1);
  const frameMat = new MeshLambertMaterial({ color: 0xf6f6f2 });
  const mats = goalFrameMatrices();
  const frame = new InstancedMesh(cyl, frameMat, mats.length);
  for (let i = 0; i < mats.length; i++) frame.setMatrixAt(i, mats[i]!);
  frame.instanceMatrix.needsUpdate = true;
  frame.computeBoundingSphere();
  frame.name = 'goal-frames';
  frame.visible = false;

  const netTex = createNetTexture();
  const netGeo = createNetGeometry();
  const netMat = new MeshBasicMaterial({
    color: 0xffffff, map: netTex, transparent: true, opacity: 0.85, side: DoubleSide, depthWrite: false,
  });
  const net = new Mesh(netGeo, netMat);
  net.name = 'goal-nets';
  net.renderOrder = 2;
  net.visible = false;

  ctx.scene.add(frame);
  ctx.scene.add(net);

  return {
    frame,
    net,
    setMatch() { frame.visible = true; net.visible = true; },
    update(_f: RenderFrame) { /* GFX-04: net ripple */ },
    warmUp() { if (ctx.renderer) ctx.renderer.initTexture(netTex); },
    clearMatch() { frame.visible = false; net.visible = false; },
    dispose() {
      ctx.scene.remove(frame);
      ctx.scene.remove(net);
      cyl.dispose(); frameMat.dispose(); frame.dispose();
      netGeo.dispose(); netMat.dispose(); netTex.dispose();
    },
  };
}
