/**
 * [UIX-05] Match settings (difficulty, half length, rules, day/night). WAVE 0 STUB (FND-04): starts the default
 * local match.
 */
import type { Screen } from '../../contracts/app';
import { defaultSetup } from '../../modes/setup';
import { createPlaceholderScreen } from '../components';

export function createMatchSettingsScreen(): Screen {
  return createPlaceholderScreen('match-settings', 'Match settings', {
    actions: [
      {
        label: 'Start match',
        testId: 'settings-start',
        primary: true,
        onSelect: (ctx) => {
          if (!ctx.session.active) ctx.session.start(defaultSetup(ctx));
        },
      },
    ],
    note: 'Match settings arrive with UIX-05.',
  });
}
