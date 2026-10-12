/**
 * [UIX-11] Practice screens: free play, free kicks, corners, penalties, tutorial entry. WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createPracticeScreen(): Screen {
  return createPlaceholderScreen('practice', 'Practice', { note: 'Practice arrives with UIX-11 and MOD-04.' });
}
