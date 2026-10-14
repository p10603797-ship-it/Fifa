/**
 * [QF-4] QA-34 texture memory per scene: textureMemory() (render/index.ts, window.__dotkickTextureMemory) walks the
 * scene's materials. Textures bound only through onBeforeCompile uniforms held in a closure (the pitch's grass detail,
 * the players' shirt-number atlas) were invisible to it, so the e2e budget counted 4 textures while the GPU held 6.
 * Materials now expose those uniforms as userData.uniforms; the context-restore rebuild walks them too.
 */
import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene } from 'three';
import { QualityTier } from '../../src/contracts/enums';
import { createDefaultSettings } from '../../src/contracts/settings';
import { CLUBS } from '../../src/data/clubs';
import { textureMemory } from '../../src/render/index';
import { createPitch } from '../../src/render/pitch';
import { createPlayerModel } from '../../src/render/players/model';
import type { RenderContext } from '../../src/render/types';

function ctxOf(): RenderContext {
  const settings = createDefaultSettings();
  return {
    renderer: null as unknown as RenderContext['renderer'], scene: new Scene(), camera: new PerspectiveCamera(22, 1.44, 2, 600),
    settings, clubs: CLUBS, size: { cssW: 1180, cssH: 820, dpr: 1, scale: 0.75 }, tier: QualityTier.BALANCED,
    cameraSettings: { ...settings.camera }, reducedMotion: false, night: false,
  };
}

describe('QF-4 QA-34: texture memory counts every texture a material samples', () => {
  it('the pitch grass detail and the shirt-number atlas (onBeforeCompile uniforms) are counted', () => {
    const ctx = ctxOf();
    const pitch = createPitch(ctx);
    const model = createPlayerModel(ctx);
    const tm = textureMemory(ctx.scene);
    const img = pitch.detail.image as { width: number; height: number };
    const detailBytes = img.width * img.height * 4;
    expect(tm.bytes).toBeGreaterThanOrEqual(detailBytes);
    const num = (model.mesh.material as { userData: { uniforms?: { uNumAtlas?: { value: unknown } } } }).userData.uniforms?.uNumAtlas?.value;
    expect(num, 'number atlas uniform exposed').toBeTruthy();
    // The grass detail and the number atlas (the kit atlas joins at setMatch).
    expect(tm.textures).toBeGreaterThanOrEqual(2);
  });
});
