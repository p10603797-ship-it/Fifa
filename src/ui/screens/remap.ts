/**
 * [PAD-07] Controller remap for pads without standard mapping: press the button for each action.
 * WAVE 0 STUB (FND-04).
 */
import type { Screen } from '../../contracts/app';
import { createPlaceholderScreen } from '../components';

export function createRemapScreen(): Screen {
  return createPlaceholderScreen('remap', 'Controller remap', { note: 'Remapping arrives with PAD-07.' });
}
