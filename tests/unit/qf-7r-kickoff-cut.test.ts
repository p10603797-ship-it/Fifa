/**
 * [QF-7R] INTEGRATION_ISSUES (from QF-12): "PRE_MATCH -> KICK_OFF cut moves players up to 11.9 m in one tick: confirm
 * the establishing shot hides it". The real renderer (every module, stand-in WebGL core) over a CPU v CPU match from
 * PRE_MATCH: on the frame of the tick that teleports the teams to their kick-off spots, the cinematic camera leaves
 * the establishing shot with a cut (never a blend across the jump), and snapTeleports draws every jumped player at his
 * new spot (never part-way). Several seeds.
 */
import { describe, expect, it } from 'vitest';
import type { PerspectiveCamera, Scene } from 'three';
import { createDefaultSettings } from '../../src/contracts/settings';
import { createInputFrame } from '../../src/contracts/input';
import { MatchPhase } from '../../src/contracts/enums';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { createGameRenderer, INTERP_TELEPORT, snapTeleports } from '../../src/render/index';
import { CineShot, type CinematicCameraModule } from '../../src/render/camera/cinematic';
import type { RendererCore } from '../../src/render/renderer';
import { createInterpState } from '../../src/render/types';
import { cloneLiveState } from '../../src/app/liveState';
import { copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';

describe('QF-7R kick-off teleport behind a camera cut', () => {
  it('the PRE_MATCH -> KICK_OFF teleport happens on a cut out of the establishing shot, drawn at the new spots', () => {
    const g = globalThis as unknown as { window?: unknown; __dotkickCinematic?: CinematicCameraModule };
    const hadWindow = 'window' in g;
    if (!hadWindow) g.window = globalThis; // the cinematic camera's debug hook (window.__dotkickCinematic)
    try {
      const three = {
        shadowMap: { enabled: false, type: 0, autoUpdate: true, needsUpdate: false },
        info: { render: { calls: 0, triangles: 0 }, memory: { textures: 0, geometries: 0 } },
        extensions: { has: () => false, get: () => null },
        capabilities: { getMaxAnisotropy: () => 4, maxTextureSize: 4096, isWebGL2: true },
        domElement: { width: 885, height: 615 },
        render(scene: Scene, camera: PerspectiveCamera) { scene.onAfterRender(this as never, scene, camera, null as never, null as never, null as never); },
        compile() {}, setRenderTarget() {}, getRenderTarget() { return null; }, clear() {}, readRenderTargetPixels() {},
        initTexture() {}, compileAsync() { return Promise.resolve(); },
      };
      const core = {
        available: true, failure: '', renderer: three, lost: false, scale: 0.75, aspect: 1.44, bufferWidth: 885,
        bufferHeight: 615, pixelRatio: 0.75, lossCount: 0, restoreCount: 0, resize() {}, setScale() {},
        onContextLost() { return () => {}; }, onContextRestored() { return () => {}; }, readStats(o: unknown) { return o; },
        rebuild() { return { materials: 0, textures: 0, missingTextures: 0 }; }, dispose() {},
      } as unknown as RendererCore;
      const clock = new Float64Array(1);
      const r = createGameRenderer({ createCore: () => core, quality: { now: () => clock[0]!, nextFrame: () => Promise.resolve(), hidden: () => true } });
      r.init({} as HTMLCanvasElement, createDefaultSettings());
      const interp = createInterpState();
      for (const seed of [1, 2, 3, 20261023]) {
        const cfg = createMatchConfig();
        cfg.seed = seed;
        cfg.humans = cfg.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
        const curr = initMatch(cfg);
        const prev = cloneLiveState(curr);
        r.setMatch(curr, CLUBS);
        const cine = g.__dotkickCinematic!;
        expect(cine).toBeDefined();
        const ev = createEventBuffer();
        const frames = [createInputFrame(), createInputFrame()];
        const info = { nowMs: 0, dtMs: 1000 / 60, frame: 0, ticks: 1, paused: false };
        let seen = false;
        let wasEstablishing = false;
        for (let k = 0; k < 2000 && !seen; k++) {
          copyState(prev, curr);
          step(curr, frames, ev);
          const cuts = cine.cuts;
          info.frame++; info.nowMs += 1000 / 60; clock[0] = info.nowMs;
          r.render(prev, curr, 1, info);
          if (prev.match.phase !== MatchPhase.PRE_MATCH) { wasEstablishing = cine.shot === CineShot.ESTABLISHING; continue; }
          if (curr.match.phase === MatchPhase.PRE_MATCH) { wasEstablishing = cine.shot === CineShot.ESTABLISHING; continue; }
          seen = true;
          let jumped = 0;
          for (let i = 0; i < 22; i++) {
            const p = prev.players[i]!, c = curr.players[i]!;
            if (Math.hypot(c.x - p.x, c.z - p.z) > INTERP_TELEPORT.player) jumped++;
          }
          expect(jumped, `seed ${seed}: the kick-off set-up teleports players`).toBeGreaterThan(0);
          expect(wasEstablishing, `seed ${seed}: the pre-match shows the establishing shot`).toBe(true);
          expect(cine.cuts, `seed ${seed}: a cut on the teleport frame`).toBe(cuts + 1);
          expect(cine.shot, `seed ${seed}: the main camera after the cut`).not.toBe(CineShot.ESTABLISHING);
          // Interpolated positions at any alpha: the jumped players are drawn at their new spots.
          for (const alpha of [0, 0.5, 1]) {
            for (let i = 0; i < 22; i++) {
              interp.x[i] = prev.players[i]!.x + (curr.players[i]!.x - prev.players[i]!.x) * alpha;
              interp.z[i] = prev.players[i]!.z + (curr.players[i]!.z - prev.players[i]!.z) * alpha;
            }
            snapTeleports(interp, prev, curr);
            for (let i = 0; i < 22; i++) {
              const p = prev.players[i]!, c = curr.players[i]!;
              if (Math.hypot(c.x - p.x, c.z - p.z) > INTERP_TELEPORT.player) {
                expect(interp.x[i]).toBeCloseTo(c.x, 4); // InterpState holds float32
                expect(interp.z[i]).toBeCloseTo(c.z, 4);
              }
            }
          }
        }
        expect(seen, `seed ${seed}: PRE_MATCH -> KICK_OFF within 2000 ticks`).toBe(true);
      }
    } finally {
      if (!hadWindow) delete g.window;
    }
  });
});
