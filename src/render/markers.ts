/**
 * [GFX-13] On-pitch aids (section 8 "Look"): a marker above each controlled player (one colour per human: P1 ember
 * #FF6B35, P2 cyan #35D0FF), a ring under the intended receiver, a faint marker on the next switch target
 * (ctrl.nextSwitch), a landing marker for high balls, edge-of-screen arrows for an off-screen ball, and
 * colour-blind-safe variants (settings.accessibility.colourBlindMarkers).
 *
 * WAVE 0 BASELINE (FND-05): a downward cone above and a flat ring under each human-controlled player, both unlit,
 * two instanced draws for both humans. GFX-13 adds the other aids.
 */

import {
  Color, ConeGeometry, DynamicDrawUsage, InstancedMesh, MeshBasicMaterial, RingGeometry,
} from 'three';
import { MAX_HUMANS } from '../contracts/constants';
import { ControllerKind } from '../contracts/enums';
import type { RenderContext, RenderFrame, RenderModule } from './types';

/** Human marker colours, indexed by human (0 = P1 ember, 1 = P2 cyan). */
export const HUMAN_COLOURS: readonly number[] = [0xff6b35, 0x35d0ff];
/** Cone tip height above the grass (m). */
export const MARKER_Y = 2.25;

export interface MarkersModule extends RenderModule {
  readonly cones: InstancedMesh;
  readonly rings: InstancedMesh;
}

export function createMarkers(ctx: RenderContext): MarkersModule {
  const coneGeo = new ConeGeometry(0.34, 0.55, 12, 1);
  coneGeo.rotateX(Math.PI); // tip down
  coneGeo.translate(0, 0.275, 0); // tip at the origin
  const coneMat = new MeshBasicMaterial({ color: 0xffffff });
  const cones = new InstancedMesh(coneGeo, coneMat, MAX_HUMANS);
  cones.name = 'human-markers';
  cones.instanceMatrix.setUsage(DynamicDrawUsage);
  cones.frustumCulled = false;
  cones.renderOrder = 3;

  const ringGeo = new RingGeometry(0.62, 0.8, 28, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const rings = new InstancedMesh(ringGeo, ringMat, MAX_HUMANS);
  rings.name = 'human-rings';
  rings.instanceMatrix.setUsage(DynamicDrawUsage);
  rings.frustumCulled = false;
  rings.renderOrder = 2;

  const c = new Color();
  for (let h = 0; h < MAX_HUMANS; h++) {
    c.setHex(HUMAN_COLOURS[h]!);
    cones.setColorAt(h, c);
    rings.setColorAt(h, c);
  }
  const cm = cones.instanceMatrix.array as Float32Array;
  const rm = rings.instanceMatrix.array as Float32Array;
  const place = (arr: Float32Array, h: number, x: number, y: number, z: number, s: number): void => {
    const o = h * 16;
    arr.fill(0, o, o + 16);
    arr[o] = s; arr[o + 5] = s; arr[o + 10] = s; arr[o + 15] = 1;
    arr[o + 12] = x; arr[o + 13] = y; arr[o + 14] = z;
  };
  for (let h = 0; h < MAX_HUMANS; h++) { place(cm, h, 0, -50, 0, 0); place(rm, h, 0, -50, 0, 0); }
  cones.visible = false;
  rings.visible = false;
  ctx.scene.add(cones);
  ctx.scene.add(rings);

  return {
    cones,
    rings,
    setMatch() { cones.visible = true; rings.visible = true; },
    update(f: RenderFrame) {
      const s = f.curr;
      const it = f.interp;
      for (let h = 0; h < MAX_HUMANS; h++) {
        const ctl = s.ctrl[h];
        const slot = ctl && ctl.kind === ControllerKind.HUMAN ? ctl.slot : -1;
        if (slot < 0 || s.players[slot]!.active !== 1) {
          place(cm, h, 0, -50, 0, 0);
          place(rm, h, 0, -50, 0, 0);
          continue;
        }
        const ht = s.attrs[slot]!.height > 0 ? s.attrs[slot]!.height / 180 : 1;
        place(cm, h, it.x[slot]!, MARKER_Y * ht, it.z[slot]!, 1);
        place(rm, h, it.x[slot]!, 0.025, it.z[slot]!, 1);
      }
      cones.instanceMatrix.needsUpdate = true;
      rings.instanceMatrix.needsUpdate = true;
    },
    clearMatch() { cones.visible = false; rings.visible = false; },
    dispose() {
      ctx.scene.remove(cones, rings);
      coneGeo.dispose(); coneMat.dispose(); ringGeo.dispose(); ringMat.dispose();
      cones.dispose(); rings.dispose();
    },
  };
}
