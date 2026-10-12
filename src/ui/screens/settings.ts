/**
 * [UIX-09] Settings: Controls, Camera, Match defaults, Audio, Graphics, Accessibility, Data reset, Diagnostics.
 * WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createSettingsScreen(): Screen {
  return createPlaceholderScreen('settings', 'Settings', {
    actions: [
      { label: 'Touch controls layout', testId: 'settings-controls-editor', onSelect: (ctx) => ctx.router.go('controls-editor') },
      { label: 'Controller remap', testId: 'settings-remap', onSelect: (ctx) => ctx.router.go('remap') },
      { label: 'Tutorial', testId: 'settings-tutorial', onSelect: (ctx) => ctx.router.go('tutorial') },
      { label: 'Diagnostics', testId: 'settings-diagnostics', onSelect: (ctx) => ctx.router.go('diagnostics') },
    ],
    note: 'Full settings arrive with UIX-09.',
  });
}
