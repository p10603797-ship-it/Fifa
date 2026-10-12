/**
 * [UIX-05] Mode setup (Kick-Off, Play a Friend, Cup, Shoot-out, Practice). WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createModeSetupScreen(): Screen {
  return createPlaceholderScreen('mode-setup', 'Choose a mode', {
    actions: [
      { label: 'Kick-Off', testId: 'mode-kickoff', primary: true, onSelect: (ctx) => ctx.router.go('team-select') },
      { label: 'Play a Friend', testId: 'mode-friend', onSelect: (ctx) => ctx.router.go('side-select') },
      { label: 'Cup', testId: 'mode-cup', onSelect: (ctx) => ctx.router.go('cup') },
      { label: 'Practice', testId: 'mode-practice', onSelect: (ctx) => ctx.router.go('practice') },
    ],
    note: 'Mode setup arrives with UIX-05.',
  });
}
