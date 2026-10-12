import { describe, expect, it } from 'vitest';
import type { Router, ScreenFactory, ScreenId } from '../../src/contracts/app';
import { registerScreens, SCREEN_FACTORIES } from '../../src/ui/index';

const ALL: ScreenId[] = [
  'splash', 'main', 'mode-setup', 'team-select', 'side-select', 'match-settings', 'loading', 'match', 'half-time',
  'full-time', 'settings', 'cup', 'practice', 'online-lobby', 'diagnostics', 'recovery', 'controls-editor', 'tutorial',
  'remap',
];

describe('FND-04 screen registration', () => {
  it('registers a factory for every ScreenId and each creates a screen with its id', () => {
    const seen = new Map<ScreenId, ScreenFactory>();
    const router = { register: (id: ScreenId, f: ScreenFactory) => seen.set(id, f) } as unknown as Router;
    registerScreens(router);
    expect([...seen.keys()].sort()).toEqual([...ALL].sort());
    for (const id of ALL) {
      const screen = SCREEN_FACTORIES[id]();
      expect(screen.id).toBe(id);
      expect(typeof screen.mount).toBe('function');
      expect(typeof screen.unmount).toBe('function');
    }
  });
});
