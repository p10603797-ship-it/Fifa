/**
 * [GFX-07] Player model and instancing (section 8 "Look", section 13 "Instancing"): players built in code from
 * simple parts (head, torso, upper and lower arms and legs, boots), one InstancedMesh per body part for all 22
 * players, per-instance transform and colour, poses from the animation mapper (GFX-12), kits and numbers from
 * the GFX-08 atlas.
 *
 * WAVE 0 BASELINE (FND-05): 22 capsules in ONE InstancedMesh (one draw call). Each capsule is coloured with the
 * team's resolved shirt colour (keepers use the keeper kit), scaled by the player's height and slightly flattened
 * front-to-back so the facing reads, positioned and oriented from the interpolated render state. Inactive
 * (sent-off) slots collapse to a zero matrix. GFX-07 replaces the capsule with the part-based model.
 */

import { CapsuleGeometry, Color, DynamicDrawUsage, InstancedMesh, MeshLambertMaterial } from 'three';
import { NUM_SLOTS } from '../../contracts/constants';
import type { Club } from '../../contracts/data';
import type { ReadonlySimState } from '../../contracts/state';
import { resolveMatchKits } from '../kits';
import type { RenderContext, RenderFrame, RenderModule } from '../types';

/** Capsule dimensions for a 180 cm player (m). */
export const CAPSULE_RADIUS = 0.27;
export const CAPSULE_HEIGHT = 1.8;
/** Depth (front-to-back) scale so the facing is visible from above. */
const DEPTH_SCALE = 0.72;

export interface PlayerModelModule extends RenderModule {
  readonly mesh: InstancedMesh;
}

/**
 * Write a column-major instance matrix: feet at (x, 0, z), model +x turned to face (fx, fz), uniform height scale h,
 * depth scale d along the facing. No allocation.
 */
export function writeFacingMatrix(arr: Float32Array | number[], i: number, x: number, z: number, fx: number, fz: number, h: number, d: number): void {
  const o = i * 16;
  // Rotation about y taking +x to (fx, 0, fz); model +z (the player's right) goes to (-fz, 0, fx).
  arr[o] = fx * d; arr[o + 1] = 0; arr[o + 2] = fz * d; arr[o + 3] = 0;
  arr[o + 4] = 0; arr[o + 5] = h; arr[o + 6] = 0; arr[o + 7] = 0;
  arr[o + 8] = -fz * h; arr[o + 9] = 0; arr[o + 10] = fx * h; arr[o + 11] = 0;
  arr[o + 12] = x; arr[o + 13] = 0; arr[o + 14] = z; arr[o + 15] = 1;
}

export function createPlayerModel(ctx: RenderContext): PlayerModelModule {
  const geo = new CapsuleGeometry(CAPSULE_RADIUS, CAPSULE_HEIGHT - 2 * CAPSULE_RADIUS, 6, 12, 1);
  geo.translate(0, CAPSULE_HEIGHT / 2, 0);
  const mat = new MeshLambertMaterial({ color: 0xffffff });
  const mesh = new InstancedMesh(geo, mat, NUM_SLOTS);
  mesh.name = 'players';
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.frustumCulled = false; // instances move; the cached bounding sphere would cull wrongly
  mesh.visible = false;
  const colour = new Color(0xffffff);
  for (let i = 0; i < NUM_SLOTS; i++) mesh.setColorAt(i, colour);
  const matrices = mesh.instanceMatrix.array as Float32Array;
  for (let i = 0; i < NUM_SLOTS; i++) writeFacingMatrix(matrices, i, 0, 0, 1, 0, 0, 0);
  ctx.scene.add(mesh);

  // Resolved shirt colours per team (0xRRGGBB) and the keeper slots they were applied for.
  const shirt = [0xd7263d, 0x1b6cff];
  const keeperShirt = [0x222222, 0xeeee22];
  const appliedKeeper = [-1, -1];

  function applyColours(state: ReadonlySimState): void {
    for (let i = 0; i < NUM_SLOTS; i++) {
      const p = state.players[i]!;
      const t = p.team === 1 ? 1 : 0;
      const isKeeper = state.teams[t]!.keeperSlot === i;
      colour.setHex(isKeeper ? keeperShirt[t]! : shirt[t]!);
      mesh.setColorAt(i, colour);
    }
    appliedKeeper[0] = state.teams[0]!.keeperSlot;
    appliedKeeper[1] = state.teams[1]!.keeperSlot;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    mesh,
    setMatch(state: ReadonlySimState, clubs: readonly Club[]) {
      const kits = resolveMatchKits(state, clubs);
      shirt[0] = kits.outfield[0].shirt; shirt[1] = kits.outfield[1].shirt;
      keeperShirt[0] = kits.keeper[0].shirt; keeperShirt[1] = kits.keeper[1].shirt;
      applyColours(state);
      mesh.visible = true;
    },
    update(f: RenderFrame) {
      const s = f.curr;
      if (s.teams[0]!.keeperSlot !== appliedKeeper[0] || s.teams[1]!.keeperSlot !== appliedKeeper[1]) applyColours(s);
      const it = f.interp;
      for (let i = 0; i < NUM_SLOTS; i++) {
        const p = s.players[i]!;
        if (p.active !== 1) {
          writeFacingMatrix(matrices, i, 0, -50, 1, 0, 0, 0);
          continue;
        }
        const h = s.attrs[i]!.height > 0 ? s.attrs[i]!.height / 180 : 1;
        writeFacingMatrix(matrices, i, it.x[i]!, it.z[i]!, it.fx[i]!, it.fz[i]!, h, h * DEPTH_SCALE);
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    clearMatch() { mesh.visible = false; },
    dispose() {
      ctx.scene.remove(mesh);
      geo.dispose();
      mat.dispose();
      mesh.dispose();
    },
  };
}
