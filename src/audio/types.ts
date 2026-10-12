/**
 * Audio module interface shared by the engine (AUD-01) and the sound modules (AUD-02..05). [FND-04]
 * FROZEN after Wave 0: AUD agents implement these shapes; ask the lead for changes.
 *
 * The engine owns the AudioContext and four buses: master -> destination, and crowd / effects / menus -> master.
 * Modules are created once, on the first unlock() (a user gesture), with an AudioCtx. They connect their nodes to
 * one of the buses and never to the destination directly. Every hook is optional except dispose().
 * Hot-path rule: onEvents and update run during play; no allocation per call except creating the Web Audio nodes
 * of a sound that actually starts.
 */
import type { SettingsStore, UiSound } from '../contracts/app';
import type { EventBuffer } from '../contracts/events';
import type { ReadonlySimState } from '../contracts/state';

export interface AudioCtx {
  readonly ctx: AudioContext;
  /** Master bus (settings.audio.master) -> destination. */
  readonly master: GainNode;
  /** Crowd bed and reactions (settings.audio.crowd) -> master. */
  readonly crowd: GainNode;
  /** Ball, body, goal frame, whistles (settings.audio.effects) -> master. */
  readonly effects: GainNode;
  /** Menu sounds (settings.audio.menus) -> master. */
  readonly menus: GainNode;
  readonly settings: SettingsStore;
}

export interface AudioModule {
  /** Events of the latest sim tick. Called only for ticks with at least one event. */
  onEvents?(events: EventBuffer, state: ReadonlySimState): void;
  /** Per animation frame; state is null in menus. */
  update?(state: ReadonlySimState | null, dtSec: number): void;
  /** Pause menu shown/hidden (stop loops, avoid stacking sounds after a pause). */
  setPaused?(paused: boolean): void;
  /** A match is about to start (crowd bed in, kick-off sting). */
  matchStart?(state: ReadonlySimState): void;
  /** The match ended or was quit (fade loops out). */
  matchEnd?(): void;
  dispose(): void;
}

/** The menu sound module (AUD-05) additionally plays UI sounds. */
export interface UiAudioModule extends AudioModule {
  play(kind: UiSound): void;
}

/** Factory signature every module file exports as create<Name>(ctx). */
export type AudioModuleFactory<M extends AudioModule = AudioModule> = (ctx: AudioCtx) => M;
