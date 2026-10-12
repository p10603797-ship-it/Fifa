/**
 * [GFX-15] Set-piece, intro and replay cameras (section 8 "Other cameras"):
 *  - Set pieces: behind the taker for free kicks near goal, penalties and goal kicks; a raised corner view for
 *    corners; the main camera for throw-ins (driven by PHASE_CHANGE / RESTART_AWARDED events and match.restart).
 *  - Cut between cameras, or blend in under 0.3 s (T_CAMERA.blendTime). Never fly across the pitch.
 *  - Kick-off and full time get short, skippable establishing shots.
 *  - Goal replays: two angles (GFX-16 supplies the replayed RenderFrame).
 * While active it owns ctx.camera and its stickRotation() maps the stick for behind-the-taker views.
 *
 * WAVE 0 STUB (FND-05): never active; projector methods work on ctx.camera so it can take over transparently.
 */

import type { CameraSettings } from '../../contracts/settings';
import type { EventBuffer } from '../../contracts/events';
import type { ReadonlySimState } from '../../contracts/state';
import type { CameraModule, RenderContext, RenderFrame } from '../types';
import { projectPitchToScreen, projectScreenToPitch } from './project';

export interface CinematicCameraModule extends CameraModule {
  /** Request the establishing shot for kick-off / full time (skippable). Returns false if not available. */
  establishing(kind: 'kickoff' | 'fulltime'): boolean;
}

export function createCinematicCamera(ctx: RenderContext): CinematicCameraModule {
  const cam = ctx.camera;
  return {
    get active() { return false; },
    update(_f: RenderFrame) { /* GFX-15 */ },
    onEvents(_events: EventBuffer, _state: ReadonlySimState) { /* GFX-15: restart cuts */ },
    setSettings(_c: CameraSettings, _reducedMotion: boolean) { /* GFX-15 */ },
    snap() { /* GFX-15 */ },
    establishing() { return false; },
    screenToPitch(sx, sy, out) { return projectScreenToPitch(cam, ctx.size.cssW, ctx.size.cssH, sx, sy, out); },
    pitchToScreen(x, y, z, out) { return projectPitchToScreen(cam, ctx.size.cssW, ctx.size.cssH, x, y, z, out); },
    stickRotation() { return 0; },
    dispose() { /* nothing owned */ },
  };
}
