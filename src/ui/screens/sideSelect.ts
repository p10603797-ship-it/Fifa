/**
 * [UIX-04] Side select and device assignment (each input slides left for home, right for away, centre sits out).
 * WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createSideSelectScreen(): Screen {
  return createPlaceholderScreen('side-select', 'Choose sides', {
    actions: [{ label: 'Continue', testId: 'side-continue', primary: true, onSelect: (ctx) => ctx.router.go('match-settings') }],
    note: 'Side select arrives with UIX-04.',
  });
}
