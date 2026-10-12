/**
 * [GFX-03] Pitch: grass with mowing stripes and white line markings (section 8 "Look"), wear (GFX-03 later).
 *
 * The markings are symmetric about both axes, so the texture holds ONE quarter of the pitch (x >= 0, z >= 0,
 * out to the run-off) and the plane samples it with mirrored-repeat UVs: four times the texel density for the
 * same memory (2048 x 1024 RGBA ~ 10.7 MB with mipmaps), trilinear + anisotropic filtering keeps the far
 * touchline stable without MSAA. Lines follow contracts/constants: touchlines, goal lines, halfway line, centre
 * circle and spot, penalty and goal areas, penalty spots and arcs, corner arcs. Lines lie inside the area they
 * bound (outer edge on the boundary), LINE_WIDTH wide. One draw call.
 *
 * WAVE 0 BASELINE (FND-05). GFX-03 owns and refines this file (grass detail, wear, quality tiers).
 */

import {
  CanvasTexture, LinearMipmapLinearFilter, LinearFilter, Mesh, MeshLambertMaterial, MirroredRepeatWrapping, PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import {
  CENTRE_CIRCLE_RADIUS, CORNER_ARC_RADIUS, GOAL_AREA_DEPTH, GOAL_AREA_HALF_WIDTH, HALF_LENGTH, HALF_WIDTH, LINE_WIDTH,
  PENALTY_ARC_RADIUS, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH, PENALTY_SPOT_DIST,
} from '../contracts/constants';
import type { RenderContext, RenderFrame, RenderModule } from './types';

/** Quarter extents (m): the textured grass reaches past the advertising boards (BOARD_X 58, BOARD_Z 40). */
export const PITCH_QX = 60;
export const PITCH_QZ = 42;
/**
 * Mowing stripe width along x (m): 21 stripes over the 105 m pitch, the centre stripe straddling the halfway
 * line, so each goal line falls on a stripe boundary (2.5 + 10 * 5 = 52.5).
 */
export const STRIPE_WIDTH = 5;
export const GRASS_LIGHT = '#4f9a3f';
export const GRASS_DARK = '#438a35';
const TEX_W = 2048;
const TEX_H = 1024;
const SPOT_RADIUS = 0.12;

export interface PitchModule extends RenderModule {
  readonly mesh: Mesh;
}

/** Draw the quarter-pitch texture into a 2D canvas context of size w x h (x right = +x, y down = +z). */
export function drawQuarterPitch(g: CanvasRenderingContext2D, w: number, h: number): void {
  const sx = w / PITCH_QX, sz = h / PITCH_QZ;
  g.save();
  g.scale(sx, sz);
  // Stripes (bands across the pitch): half of the centre stripe, then alternating full stripes.
  g.fillStyle = GRASS_LIGHT;
  g.fillRect(0, 0, STRIPE_WIDTH / 2, PITCH_QZ);
  for (let i = 0; STRIPE_WIDTH / 2 + i * STRIPE_WIDTH < PITCH_QX; i++) {
    g.fillStyle = i % 2 === 0 ? GRASS_DARK : GRASS_LIGHT;
    g.fillRect(STRIPE_WIDTH / 2 + i * STRIPE_WIDTH, 0, STRIPE_WIDTH, PITCH_QZ);
  }
  const L = LINE_WIDTH;
  g.fillStyle = 'rgba(245,245,240,0.95)';
  g.strokeStyle = 'rgba(245,245,240,0.95)';
  g.lineWidth = L;
  // Touchline and goal line (outer edge on the boundary).
  g.fillRect(0, HALF_WIDTH - L, HALF_LENGTH, L);
  g.fillRect(HALF_LENGTH - L, 0, L, HALF_WIDTH);
  // Halfway line, centred on x = 0 (mirroring completes the other half of its width).
  g.fillRect(0, 0, L / 2, HALF_WIDTH);
  // Penalty area (front edge at x = 52.5 - 16.5, side at z = 20.16).
  const pax = HALF_LENGTH - PENALTY_AREA_DEPTH;
  g.fillRect(pax, 0, L, PENALTY_AREA_HALF_WIDTH);
  g.fillRect(pax, PENALTY_AREA_HALF_WIDTH - L, PENALTY_AREA_DEPTH, L);
  // Goal area.
  const gax = HALF_LENGTH - GOAL_AREA_DEPTH;
  g.fillRect(gax, 0, L, GOAL_AREA_HALF_WIDTH);
  g.fillRect(gax, GOAL_AREA_HALF_WIDTH - L, GOAL_AREA_DEPTH, L);
  // Centre circle (radius to the outer edge of the line) and spot.
  g.beginPath();
  g.arc(0, 0, CENTRE_CIRCLE_RADIUS - L / 2, 0, Math.PI / 2);
  g.stroke();
  g.beginPath();
  g.arc(0, 0, SPOT_RADIUS, 0, Math.PI / 2);
  g.lineTo(0, 0);
  g.fill();
  // Penalty spot.
  const psx = HALF_LENGTH - PENALTY_SPOT_DIST;
  g.beginPath();
  g.arc(psx, 0, SPOT_RADIUS, 0, Math.PI * 2);
  g.fill();
  // Penalty arc: the part of the 9.15 m circle around the spot that lies outside the penalty area.
  const cosA = (psx - pax) / PENALTY_ARC_RADIUS;
  const a = Math.acos(Math.max(-1, Math.min(1, cosA)));
  g.beginPath();
  g.arc(psx, 0, PENALTY_ARC_RADIUS - L / 2, Math.PI - a, Math.PI);
  g.stroke();
  // Corner arc.
  g.beginPath();
  g.arc(HALF_LENGTH, HALF_WIDTH, CORNER_ARC_RADIUS - L / 2, Math.PI, Math.PI * 1.5);
  g.stroke();
  g.restore();
}

function createPitchTexture(ctx: RenderContext): CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = TEX_W;
  canvas.height = TEX_H;
  const g = canvas.getContext('2d');
  if (!g) return null;
  drawQuarterPitch(g, TEX_W, TEX_H);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = MirroredRepeatWrapping;
  tex.wrapT = MirroredRepeatWrapping;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  const maxAniso = ctx.renderer ? ctx.renderer.capabilities.getMaxAnisotropy() : 1;
  tex.anisotropy = Math.max(1, Math.min(8, maxAniso));
  return tex;
}

export function createPitch(ctx: RenderContext): PitchModule {
  const geo = new PlaneGeometry(PITCH_QX * 2, PITCH_QZ * 2, 1, 1);
  geo.rotateX(-Math.PI / 2);
  // UV = (x / QX, z / QZ) in [-1, 1]; mirrored-repeat wrapping folds it onto the quarter texture.
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / PITCH_QX, pos.getZ(i) / PITCH_QZ);
  uv.needsUpdate = true;

  const tex = createPitchTexture(ctx);
  const mat = new MeshLambertMaterial({ color: tex ? 0xffffff : 0x4a9440, map: tex });
  const mesh = new Mesh(geo, mat);
  mesh.name = 'pitch';
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.visible = false;
  ctx.scene.add(mesh);

  return {
    mesh,
    setMatch() { mesh.visible = true; },
    update(_f: RenderFrame) { /* static */ },
    warmUp() { if (tex && ctx.renderer) ctx.renderer.initTexture(tex); },
    clearMatch() { mesh.visible = false; },
    dispose() {
      ctx.scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      tex?.dispose();
    },
  };
}
