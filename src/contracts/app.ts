/**
 * App-level contracts: screens, session, renderer, HUD, audio, stats, devices, settings store.
 * Lead-owned, frozen after Wave 0.
 */

import type { Club } from './data';
import type { Command, PadFamily, QualityTier } from './enums';
import type { EventBuffer } from './events';
import type { CameraProjector, InputFrame, InputSource } from './input';
import type { RenderStats } from './render';
import type { AudioSettings, CameraSettings, Settings } from './settings';
import type { MatchConfig, ReadonlySimState } from './state';

// ============================================================ frame info

export interface FrameInfo {
  /** rAF timestamp, ms. */
  nowMs: number;
  /** Real elapsed since the last frame, ms (clamped to MAX_FRAME_MS). */
  dtMs: number;
  frame: number;
  /** Ticks simulated this frame (0..3). */
  ticks: number;
  paused: boolean;
}

// ============================================================ screens & router

export type ScreenId =
  | 'splash' | 'main' | 'mode-setup' | 'team-select' | 'side-select' | 'match-settings' | 'loading' | 'match'
  | 'half-time' | 'full-time' | 'settings' | 'cup' | 'practice' | 'online-lobby' | 'diagnostics' | 'recovery'
  | 'controls-editor' | 'tutorial' | 'remap';

export type ScreenParams = Record<string, unknown>;

export interface Screen {
  readonly id: ScreenId;
  mount(root: HTMLElement, ctx: AppContext, params: ScreenParams): void;
  unmount(): void;
  /** Return true if the screen handled Back itself (closed a panel). Otherwise the router goes back. */
  onBack?(): boolean;
  /** Called every animation frame while mounted (menus that animate). Keep it cheap. */
  onFrame?(frame: FrameInfo): void;
}

export type ScreenFactory = () => Screen;

export interface Router {
  readonly current: ScreenId | null;
  go(id: ScreenId, params?: ScreenParams): void;
  /** Replace the current screen without adding history. */
  replace(id: ScreenId, params?: ScreenParams): void;
  back(): void;
  register(id: ScreenId, factory: ScreenFactory): void;
}

// ============================================================ settings & storage

export interface SettingsStore {
  get(): Readonly<Settings>;
  /** Mutate and persist. */
  update(mut: (s: Settings) => void): void;
  subscribe(fn: (s: Readonly<Settings>) => void): () => void;
  reset(): void;
  /** False when storage is blocked and settings live in memory only. */
  readonly persistent: boolean;
  loadProgress<T>(key: string): T | null;
  saveProgress<T>(key: string, value: T): void;
  clearProgress(): void;
}

// ============================================================ audio

export enum UiSound {
  MOVE = 0,
  CONFIRM = 1,
  BACK = 2,
  ERROR = 3,
  TOGGLE = 4,
  START = 5,
  COUNTDOWN = 6,
}

export interface AudioEngine {
  /** Create/resume the AudioContext. Call from a user gesture. */
  unlock(): Promise<void>;
  readonly unlocked: boolean;
  setVolumes(v: AudioSettings): void;
  /** Consume the events of the latest tick. */
  onEvents(events: EventBuffer, state: ReadonlySimState): void;
  /** Per animation frame: crowd intensity smoothing, loops. state null in menus. */
  update(state: ReadonlySimState | null, dtSec: number): void;
  playUi(kind: UiSound): void;
  matchStart(state: ReadonlySimState): void;
  matchEnd(): void;
  /** Duck/mute for the pause menu. */
  setPaused(paused: boolean): void;
  /** Background / interruption handling. */
  suspend(): void;
  resume(): void;
}

// ============================================================ renderer & HUD

export interface GameRenderer {
  readonly projector: CameraProjector;
  init(canvas: HTMLCanvasElement, settings: Readonly<Settings>): void;
  /** Build match-specific resources (kits, crests, lighting). */
  setMatch(state: ReadonlySimState, clubs: readonly Club[]): void;
  /** Compile shaders, upload textures, run each animation/effect once off screen. */
  warmUp(): Promise<void>;
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  /** Draw a frame interpolating prev -> curr by alpha (0..1). */
  render(prev: ReadonlySimState, curr: ReadonlySimState, alpha: number, frame: FrameInfo): void;
  onEvents(events: EventBuffer, state: ReadonlySimState): void;
  setCamera(c: CameraSettings, reducedMotion: boolean): void;
  setQuality(tier: QualityTier): void;
  stats(): RenderStats;
  /** Goal replay from the render ring buffer (GFX-16). */
  startReplay(seconds: number): boolean;
  stopReplay(): void;
  readonly replaying: boolean;
  /** Menus: draw nothing and release per-match resources. */
  clearMatch(): void;
  /** Apply the latest settings snapshot (the SettingsStore replaces its object on every update). */
  setSettings(s: Readonly<Settings>): void;
  /** WebGL context lost / restored notifications (the session pauses, then resumes from the pause menu). Return unsubscribe. */
  onContextLost(fn: () => void): () => void;
  onContextRestored(fn: () => void): () => void;
  dispose(): void;
}

export interface HudPart {
  mount(root: HTMLElement, ctx: AppContext): void;
  setMatch(state: ReadonlySimState, clubs: readonly Club[]): void;
  /** Per animation frame. Write to the DOM only when a value changes. */
  update(state: ReadonlySimState, frame: FrameInfo, projector: CameraProjector | null): void;
  onEvents(events: EventBuffer, state: ReadonlySimState): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

// ============================================================ stats

export interface TeamMatchStats {
  goals: number;
  shots: number;
  shotsOnTarget: number;
  /** 0..1 */
  possession: number;
  passes: number;
  passesCompleted: number;
  tackles: number;
  tacklesWon: number;
  fouls: number;
  yellow: number;
  red: number;
  offsides: number;
  corners: number;
  saves: number;
  interceptions: number;
}

export interface PlayerMatchStats {
  team: number;
  rosterIdx: number;
  goals: number;
  assists: number;
  shots: number;
  passes: number;
  passesCompleted: number;
  tackles: number;
  saves: number;
  /** 0..10 match rating. */
  rating: number;
  minutes: number;
}

export interface GoalRecord {
  team: number;
  rosterIdx: number;
  assistRosterIdx: number;
  ownGoal: boolean;
  /** Displayed match minute. */
  minute: number;
}

export interface MatchSummary {
  teams: [TeamMatchStats, TeamMatchStats];
  players: PlayerMatchStats[];
  goals: GoalRecord[];
  playerOfMatch: { team: number; rosterIdx: number } | null;
  shootout: [number, number] | null;
  winner: number;
  forfeit: number;
  ticks: number;
}

export interface StatsTracker {
  reset(state: ReadonlySimState): void;
  /** After every sim tick. */
  onTick(state: ReadonlySimState, events: EventBuffer): void;
  summary(state: ReadonlySimState): MatchSummary;
}

// ============================================================ inputs, devices, menus

/** Supplies the human InputFrames for each tick (local devices, or the online lockstep). */
export interface TickInputProvider {
  /** True when inputs for `tick` exist for every human. Local providers are always ready. */
  ready(tick: number): boolean;
  /** Fill frames[0..MAX_HUMANS-1] for `tick`. */
  take(tick: number, frames: InputFrame[], state: ReadonlySimState): void;
  /** Per animation frame (network pump, pad polling). */
  pump(nowMs: number): void;
  /** True while stalled waiting for a remote input. */
  readonly waiting: boolean;
  releaseAll(): void;
  /** Queue a command (tactics, subs, SKIP) into the given human's next local frame (lockstep sends it with the frame). */
  queueCommand?(human: number, cmd: Command, arg: number): void;
  dispose(): void;
}

export interface DeviceInfo {
  id: string;
  kind: 'touch' | 'pad' | 'keyboard';
  label: string;
  family: PadFamily;
  connected: boolean;
}

export interface DeviceRegistry {
  list(): DeviceInfo[];
  subscribe(fn: (devices: DeviceInfo[]) => void): () => void;
  /** Create the InputSource for a device bound to a human index. */
  createSource(deviceId: string, human: number): InputSource;
  /** Most recently used device id (for tutorial / glyphs). */
  lastActive(): string | null;
}

export enum MenuAction {
  UP = 0,
  DOWN = 1,
  LEFT = 2,
  RIGHT = 3,
  CONFIRM = 4,
  BACK = 5,
  TAB_PREV = 6,
  TAB_NEXT = 7,
  /** Options / Menu button (pause). */
  START = 8,
}

/** Menu focus engine (PAD-08): every screen works by touch alone and by controller alone. */
export interface FocusNavigator {
  /** Discover focusable elements ([data-focus] or buttons) under root and show a focus ring. */
  attach(root: HTMLElement): void;
  detach(root: HTMLElement): void;
  handle(action: MenuAction): void;
  focus(el: HTMLElement): void;
  /** Subscribe to menu actions (screens use this for tabs, sliders). */
  onAction(fn: (a: MenuAction) => boolean | void): () => void;
}

// ============================================================ session

export interface HumanBinding {
  human: number;
  /** Device ids from DeviceRegistry. '*' (ANY_DEVICE in app/localInput.ts) also binds devices that appear later (pads join on a button press). */
  deviceIds: string[];
}

/** Mode hooks the session consults (online 1v1: NET-06). All optional; local modes leave them out. */
export interface MatchHooks {
  /** Asked before a pause (pausing = true) or resume takes effect; byHuman -1 = system. Return false to refuse. */
  allowPause?(byHuman: number, pausing: boolean): boolean;
  /** After the pause state changed (online: tell the peer). */
  onPauseChange?(paused: boolean, byHuman: number): void;
  /** On quit or restart, before match resources are released (online: tell the peer, close the room). */
  onQuit?(): void;
}

export interface MatchSetup {
  config: MatchConfig;
  /** Mode hooks (online pause rules and quit notification). */
  hooks?: MatchHooks;
  bindings: HumanBinding[];
  /** Mode-specific payload (cup tie, practice kind, online session handle). */
  modeData?: unknown;
  /** Called when the match reaches POST_MATCH (or is quit) with its summary. */
  onFinish?: (summary: MatchSummary | null, quit: boolean) => void;
  /** Override the input provider (online lockstep). */
  inputProvider?: TickInputProvider;
}

export interface SessionControl {
  readonly active: boolean;
  start(setup: MatchSetup): void;
  /** Pause by human index (-1 = system). */
  pause(byHuman: number): void;
  /** Returns false if this human may not resume (only the pauser can). */
  resume(byHuman: number): boolean;
  readonly paused: boolean;
  readonly pausedBy: number;
  restart(): void;
  quit(): void;
  /** Queue a command (tactics, subs) into the given human's next InputFrame. */
  queueCommand(human: number, cmd: Command, arg: number): void;
  /**
   * Rebind a human to other local devices, or hand the side to the CPU ('cpu' -> Command.HAND_TO_CPU through the
   * frame, deterministic). Returns false when not possible (online, no match).
   */
  setHumanDevice(human: number, devices: readonly string[] | 'cpu'): boolean;
  getState(): ReadonlySimState | null;
  getSetup(): MatchSetup | null;
}

// ============================================================ platform & diagnostics

export interface PlatformInfo {
  readonly isIPad: boolean;
  readonly isTouch: boolean;
  readonly isStandalone: boolean;
  readonly supportsFullscreen: boolean;
  /** Safe-area insets in CSS px. */
  safeArea(): { top: number; right: number; bottom: number; left: number };
}

export interface Diagnostics {
  log(kind: string, message: string, data?: unknown): void;
  recent(): readonly string[];
  readonly debug: boolean;
  setDebug(on: boolean): void;
  /** Copy-able report (version, device, settings, recent log, last replay). */
  report(): string;
}

export interface AppContext {
  router: Router;
  settings: SettingsStore;
  audio: AudioEngine;
  focus: FocusNavigator;
  devices: DeviceRegistry;
  session: SessionControl;
  platform: PlatformInfo;
  diagnostics: Diagnostics;
  clubs: readonly Club[];
}
