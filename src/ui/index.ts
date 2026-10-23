/**
 * [FND-04] Screen registration: every ScreenId (contracts/app.ts) maps to the factory in its own file. The Record
 * type makes a missing screen a compile error. Wave 1 owners replace the factories' implementations, not the names.
 */
import type { Router, ScreenFactory, ScreenId } from '../contracts/app';
import { createControlsEditorScreen } from '../input/touch/editor';
import { createCupScreen } from './screens/cup';
import { createDiagnosticsScreen } from './screens/diagnostics';
import { createFullTimeScreen } from './screens/fullTime';
import { createHalfTimeScreen } from './screens/halfTime';
import { createLoadingScreen } from './screens/loading';
import { createMainScreen } from './screens/main';
import { createMatchScreen } from './screens/match';
import { createMatchSettingsScreen } from './screens/matchSettings';
import { createModeSetupScreen } from './screens/modeSetup';
import { createOnlineScreen } from './screens/online';
import { createPracticeScreen } from './screens/practice';
import { createRecoveryScreen } from './screens/recovery';
import { createRemapScreen } from './screens/remap';
import { createSettingsScreen } from './screens/settings';
import { createSideSelectScreen } from './screens/sideSelect';
import { createSplashScreen } from './screens/splash';
import { createTeamSelectScreen } from './screens/teamSelect';
import { createTutorialScreen } from './screens/tutorial';

export const SCREEN_FACTORIES: Readonly<Record<ScreenId, ScreenFactory>> = {
  splash: createSplashScreen,
  main: createMainScreen,
  'mode-setup': createModeSetupScreen,
  'team-select': createTeamSelectScreen,
  'side-select': createSideSelectScreen,
  'match-settings': createMatchSettingsScreen,
  loading: createLoadingScreen,
  match: createMatchScreen,
  'half-time': createHalfTimeScreen,
  'full-time': createFullTimeScreen,
  settings: createSettingsScreen,
  cup: createCupScreen,
  practice: createPracticeScreen,
  'online-lobby': createOnlineScreen,
  diagnostics: createDiagnosticsScreen,
  recovery: createRecoveryScreen,
  'controls-editor': createControlsEditorScreen,
  tutorial: createTutorialScreen,
  remap: createRemapScreen,
};

/**
 * [QF-17] Overlay screens and the screens each is shown over without unmounting them (RouterOptions.overlays): the
 * match screen stays mounted under the half-time overlay, so half time and the second-half kick-off swap no DOM.
 */
export const SCREEN_OVERLAYS: Readonly<Partial<Record<ScreenId, readonly ScreenId[]>>> = {
  'half-time': ['match'],
};

/** Register every screen with the router. */
export function registerScreens(router: Router): void {
  for (const id of Object.keys(SCREEN_FACTORIES) as ScreenId[]) router.register(id, SCREEN_FACTORIES[id]);
}
