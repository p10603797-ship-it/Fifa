/**
 * [NET-07] Online screens: create/join room, lobby, status and plain-language errors. WAVE 0 STUB (FND-04).
 * The only file outside src/net that may import src/net (local play must work with the network code removed).
 */
import type { Screen } from '../../contracts/app';
import { onlineSupported } from '../../net/session';
import { createPlaceholderScreen } from '../components';

export function createOnlineScreen(): Screen {
  return createPlaceholderScreen('online-lobby', 'Play online', {
    note: onlineSupported() ? 'Online 1v1 arrives with the NET squad.' : 'This browser cannot make peer-to-peer connections.',
  });
}
