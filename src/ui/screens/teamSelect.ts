/**
 * [UIX-03] Team and kit select. WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createTeamSelectScreen(): Screen {
  return createPlaceholderScreen('team-select', 'Teams and kits', {
    actions: [{ label: 'Continue', testId: 'team-continue', primary: true, onSelect: (ctx) => ctx.router.go('side-select') }],
    note: 'Team and kit select arrives with UIX-03.',
  });
}
