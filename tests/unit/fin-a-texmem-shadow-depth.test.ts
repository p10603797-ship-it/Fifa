/**
 * [FIN-A] item 2: textureMemory() (render/index.ts) counted a light's shadow map colour attachment only. three.js gives
 * every non-VSM shadow map a DepthTexture (32-bit, 4 B/texel) that lives on the GPU too: 4 MB more for the 1024 map at
 * QUALITY. It is now counted (bytes and texture count).
 */
import { describe, expect, it } from 'vitest';
import { DepthFormat, DepthTexture, DirectionalLight, Scene, UnsignedIntType, WebGLRenderTarget } from 'three';
import { textureMemory } from '../../src/render/index';

function shadowScene(size: number, withDepth: boolean): Scene {
  const scene = new Scene();
  const sun = new DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(size, size);
  // What WebGLShadowMap.render builds on the first shadow pass (PCF, three r186).
  const map = new WebGLRenderTarget(size, size);
  if (withDepth) {
    map.depthTexture = new DepthTexture(size, size, UnsignedIntType);
    map.depthTexture.format = DepthFormat;
  }
  sun.shadow.map = map;
  scene.add(sun);
  return scene;
}

describe('FIN-A: texture memory counts the shadow map depth texture', () => {
  it('a 1024 PCF shadow map counts 4 MB colour + 4 MB depth (2 textures)', () => {
    const tm = textureMemory(shadowScene(1024, true));
    expect(tm.textures).toBe(2);
    expect(tm.bytes).toBe(2 * 1024 * 1024 * 4);
  });

  it('a shadow target without a depth texture still counts only its colour attachment', () => {
    const tm = textureMemory(shadowScene(512, false));
    expect(tm.textures).toBe(1);
    expect(tm.bytes).toBe(512 * 512 * 4);
  });
});
