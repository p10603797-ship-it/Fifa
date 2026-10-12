/**
 * [UIX-11] Cup screens: draw, bracket, next tie, results. WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createCupScreen(): Screen {
  return createPlaceholderScreen('cup', 'Cup', { note: 'The cup arrives with UIX-11 and MOD-02.' });
}
