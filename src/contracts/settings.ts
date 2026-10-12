/**
 * Persistent settings schema (section 12). Lead-owned, frozen after Wave 0.
 * Stored by platform/storage.ts (PLT-03) with SETTINGS_SCHEMA_VERSION and migrations.
 */

import {
  AssistLevel, AutoSwitch, CameraType, Difficulty, FormationId, KitSlot, PadFamily, QualityTier, SkillMove,
} from './enums';

export const SETTINGS_SCHEMA_VERSION = 1;

/** One touch control's placement, in CSS points from the anchored corner, plus scale. */
export interface ControlPlacement {
  /** Offset from the right edge (buttons) or left edge (stick), pt. */
  dx: number;
  /** Offset from the bottom edge, pt. */
  dy: number;
  /** Size multiplier 0.7..1.4. */
  scale: number;
}

export interface TouchSettings {
  /** Placement per touch button id (TouchButtonId as string key) — layout from the controls editor. */
  layout: Record<string, ControlPlacement>;
  /** Spacing multiplier between buttons. */
  spacing: number;
  /** 0.2..1 */
  opacity: number;
  /** Mirror controls for left-handers. */
  mirror: boolean;
  /** Floating (default) or fixed stick. */
  floatingStick: boolean;
  gestures: boolean;
  /** Hide PASS, THROUGH, SHOOT (gestures only). */
  gesturesOnly: boolean;
  fastPowerBar: boolean;
  /** Per-gesture enables (keys = gesture rule names from section 9). */
  gestureEnabled: Record<string, boolean>;
  /** Skill slots: tap, swipe up, swipe right. */
  skillTap: SkillMove;
  skillUp: SkillMove;
  skillRight: SkillMove;
  /** Number of matches in which direction hints are still shown. */
  hintMatchesLeft: number;
}

export interface PadSettings {
  familyOverride: PadFamily;
  rumble: boolean;
  /** Custom remaps for non-standard pads, keyed by pad id string: action -> button index. */
  remaps: Record<string, number[]>;
}

export interface ControlSettings {
  assist: AssistLevel;
  autoSwitch: AutoSwitch;
  touch: TouchSettings;
  pad: PadSettings;
}

export interface CameraSettings {
  type: CameraType;
  /** 0..20 */
  height: number;
  /** 0..20 */
  zoom: number;
}

export interface MatchDefaults {
  halfMinutes: number;
  difficulty: Difficulty;
  offside: boolean;
  fouls: boolean;
  night: boolean;
  homeClub: number;
  awayClub: number;
  homeKit: KitSlot;
  awayKit: KitSlot;
  homeFormation: FormationId;
  replays: boolean;
}

export interface AudioSettings {
  /** 0..1 each */
  master: number;
  crowd: number;
  effects: number;
  menus: number;
}

export interface GraphicsSettings {
  tier: QualityTier;
  showFps: boolean;
  /** 0 = automatic dynamic resolution, else fixed 0.6..1.0. */
  resolutionScale: number;
}

export interface AccessibilitySettings {
  highContrastKits: boolean;
  largerHud: boolean;
  reducedCameraMotion: boolean;
  colourBlindMarkers: boolean;
}

export interface Settings {
  schema: number;
  controls: ControlSettings;
  camera: CameraSettings;
  match: MatchDefaults;
  audio: AudioSettings;
  graphics: GraphicsSettings;
  accessibility: AccessibilitySettings;
  /** Hidden debug overlay toggle. */
  debug: boolean;
  /** Per-restart-kind hint counters (key = RestartKind). */
  setPieceHintsSeen: Record<string, number>;
  /** Shown once: Low Power Mode hint, Add to Home Screen hint. */
  lowPowerHintShown: boolean;
  homeScreenHintShown: boolean;
  /** Tutorial completion flags. */
  tutorialDone: Record<string, boolean>;
  nickname: string;
}

export function createDefaultSettings(): Settings {
  return {
    schema: SETTINGS_SCHEMA_VERSION,
    controls: {
      assist: AssistLevel.ASSISTED,
      autoSwitch: AutoSwitch.AIR_AND_LOOSE,
      touch: {
        layout: {}, spacing: 1, opacity: 0.85, mirror: false, floatingStick: true, gestures: true, gesturesOnly: false,
        fastPowerBar: false, gestureEnabled: {}, skillTap: SkillMove.STEP_OVER, skillUp: SkillMove.ROULETTE,
        skillRight: SkillMove.HEEL_FLICK, hintMatchesLeft: 3,
      },
      pad: { familyOverride: PadFamily.AUTO, rumble: true, remaps: {} },
    },
    camera: { type: CameraType.BROADCAST, height: 10, zoom: 10 },
    match: {
      halfMinutes: 4, difficulty: Difficulty.PROFESSIONAL, offside: true, fouls: true, night: false, homeClub: 0, awayClub: 1,
      homeKit: KitSlot.HOME, awayKit: KitSlot.AWAY, homeFormation: FormationId.F442, replays: true,
    },
    audio: { master: 0.8, crowd: 0.8, effects: 0.9, menus: 0.7 },
    graphics: { tier: QualityTier.AUTO, showFps: false, resolutionScale: 0 },
    accessibility: { highContrastKits: false, largerHud: false, reducedCameraMotion: false, colourBlindMarkers: false },
    debug: false,
    setPieceHintsSeen: {},
    lowPowerHintShown: false,
    homeScreenHintShown: false,
    tutorialDone: {},
    nickname: 'Player',
  };
}
