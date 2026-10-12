/**
 * [GFX-05] Stadium, advertising boards, sky, day and floodlit-night lighting (section 8 "Look", section 13
 * "Cheap shading": one directional light plus ambient, no real-time shadow maps at the default tier).
 *
 * WAVE 0 BASELINE (FND-05): a large surrounding ground plane, a sky/background colour, one directional light
 * and one ambient light, with a night variant (config.night). GFX-05 adds stands, original boards (instanced or
 * merged), floodlights and quality tiers.
 */

import { AmbientLight, Color, DirectionalLight, Mesh, MeshLambertMaterial, PlaneGeometry } from 'three';
import type { Club } from '../contracts/data';
import type { ReadonlySimState } from '../contracts/state';
import type { RenderContext, RenderFrame, RenderModule } from './types';

export interface StadiumLook {
  sky: number;
  ground: number;
  sunColour: number;
  sunIntensity: number;
  ambientColour: number;
  ambientIntensity: number;
}

export const DAY_LOOK: StadiumLook = {
  sky: 0x8fb8d8, ground: 0x2f5a2a, sunColour: 0xfff4e0, sunIntensity: 2.6, ambientColour: 0xdfe8ff, ambientIntensity: 1.25,
};
export const NIGHT_LOOK: StadiumLook = {
  sky: 0x0b1020, ground: 0x1d3a1c, sunColour: 0xf2f6ff, sunIntensity: 2.4, ambientColour: 0x9aa8d0, ambientIntensity: 1.0,
};

export interface StadiumModule extends RenderModule {
  readonly sun: DirectionalLight;
  readonly ambient: AmbientLight;
}

export function createStadium(ctx: RenderContext): StadiumModule {
  const groundGeo = new PlaneGeometry(600, 600, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);
  const groundMat = new MeshLambertMaterial({ color: DAY_LOOK.ground });
  const ground = new Mesh(groundGeo, groundMat);
  ground.name = 'stadium-ground';
  ground.position.y = -0.03;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  ground.visible = false;

  // Sun high above the near-left of the camera so players are lit on the side the camera sees.
  const sun = new DirectionalLight(DAY_LOOK.sunColour, DAY_LOOK.sunIntensity);
  sun.position.set(-40, 90, 60);
  sun.target.position.set(0, 0, 0);
  const ambient = new AmbientLight(DAY_LOOK.ambientColour, DAY_LOOK.ambientIntensity);
  const background = new Color(0x07070d);

  ctx.scene.add(ground);
  ctx.scene.add(sun);
  ctx.scene.add(sun.target);
  ctx.scene.add(ambient);

  function apply(look: StadiumLook): void {
    background.setHex(look.sky);
    ctx.scene.background = background;
    groundMat.color.setHex(look.ground);
    sun.color.setHex(look.sunColour);
    sun.intensity = look.sunIntensity;
    ambient.color.setHex(look.ambientColour);
    ambient.intensity = look.ambientIntensity;
  }

  return {
    sun,
    ambient,
    setMatch(state: ReadonlySimState, _clubs: readonly Club[]) {
      apply(state.config.night === 1 ? NIGHT_LOOK : DAY_LOOK);
      ground.visible = true;
    },
    update(_f: RenderFrame) { /* static */ },
    clearMatch() {
      ground.visible = false;
      background.setHex(0x07070d);
    },
    dispose() {
      ctx.scene.remove(ground, sun, sun.target, ambient);
      groundGeo.dispose();
      groundMat.dispose();
      sun.dispose();
      ambient.dispose();
      if (ctx.scene.background === background) ctx.scene.background = null;
    },
  };
}
