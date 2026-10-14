/**
 * [AUD-01] Engine services for the sound modules (AUD-02..05).
 *
 * The engine attaches these to the AudioCtx it hands to every module factory on unlock. src/audio/types.ts is
 * frozen, so they ride on the same object and modules read them with getAudioServices(ctx):
 *
 *   const svc = getAudioServices(ctx);
 *   const kick = svc ? svc.bank.define('sfx.kick', 0.25, 1, renderKick) : -1;   // once, in the factory
 *   ...
 *   svc?.effects.play(svc.bank.get(kick), gain, pan, rate, priority, group);   // per event: no synthesis
 *
 * - effects / crowd / menus: capped one-shot voice pools on that bus (voice stealing, same-group retrigger), so
 *   sounds never stack. The engine stops them on pause, match start/end and backgrounding.
 * - bank: buffers rendered once after unlock in small chunks per frame (no hitch); get() is null until ready.
 * - modules: the other modules by name, for cross-module cues at event time.
 * Long-running loops (the crowd bed) may own their nodes directly; they still connect only to a bus.
 */
import type { BufferBank } from './bank';
import type { AudioCtx, AudioModule } from './types';
import type { VoicePool } from './voices';

export type AudioModuleName = 'crowd' | 'sfx' | 'whistles' | 'eventMap' | 'ui';

/**
 * The created modules by name, filled by the engine once every factory has run (null for a module whose factory
 * threw). For cross-module cues at event time, e.g. the event map (AUD-05) calling the sfx module (AUD-03): cast to
 * the concrete module type its file exports. Do not read it inside a factory (later modules do not exist yet).
 */
export type AudioModuleRegistry = { readonly [K in AudioModuleName]: AudioModule | null };

export interface AudioServices {
  readonly effects: VoicePool;
  readonly crowd: VoicePool;
  readonly menus: VoicePool;
  readonly bank: BufferBank;
  readonly modules: AudioModuleRegistry;
}

/** The AudioCtx the engine builds: the frozen shape plus services. */
export interface AudioCtxWithServices extends AudioCtx {
  readonly services: AudioServices;
}

/** Services of an engine-built AudioCtx, or null (a context built elsewhere, e.g. a module's own unit test). */
export function getAudioServices(ctx: AudioCtx): AudioServices | null {
  const s = (ctx as Partial<AudioCtxWithServices>).services;
  return s ?? null;
}
