/**
 * [UIX-12] Guided tutorial for the input device in use. WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createTutorialScreen(): Screen {
  return createPlaceholderScreen('tutorial', 'Tutorial', { note: 'The tutorial arrives with UIX-12.' });
}
