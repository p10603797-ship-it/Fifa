/**
 * A GameRenderer that draws nothing. [FND-04]
 * Used when WebGL is unavailable (the menus keep working and the recovery screen explains why matches cannot
 * start) and by unit tests of the loop and session.
 */
import type { GameRenderer } from '../contracts/app';
import type { CameraProjector } from '../contracts/input';
import type { RenderStats } from '../contracts/render';

const NULL_PROJECTOR: CameraProjector = {
  screenToPitch: () => false,
  pitchToScreen: () => false,
  stickRotation: () => 0,
};

export function createNullRenderer(): GameRenderer {
  const stats: RenderStats = { drawCalls: 0, triangles: 0, textures: 0, geometries: 0, resolutionScale: 1, qualityTier: 0 };
  return {
    projector: NULL_PROJECTOR,
    init() {},
    setMatch() {},
    warmUp: () => Promise.resolve(),
    resize() {},
    render() {},
    onEvents() {},
    setCamera() {},
    setQuality() {},
    stats: () => stats,
    startReplay: () => false,
    stopReplay() {},
    replaying: false,
    clearMatch() {},
    dispose() {},
  };
}
