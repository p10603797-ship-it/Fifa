import { describe, expect, it, vi } from 'vitest';
import type { AppContext, Screen, ScreenId, ScreenParams } from '../../src/contracts/app';
import { BACK_DEDUPE_MS, createRouter } from '../../src/app/router';

interface FakeEl { id: ScreenId; removed: boolean; remove(): void }

function harness(opts: { onBack?: Partial<Record<ScreenId, () => boolean>>; throwOnMount?: ScreenId[] } = {}) {
  const log: string[] = [];
  const attached: FakeEl[] = [];
  const children: FakeEl[] = [];
  let now = 0;
  const focus = {
    attach: vi.fn((el: FakeEl) => { attached.push(el); }),
    detach: vi.fn((el: FakeEl) => { const i = attached.indexOf(el); if (i >= 0) attached.splice(i, 1); }),
    handle: vi.fn(), focus: vi.fn(), onAction: vi.fn(() => () => undefined),
  };
  const ctx = { focus } as unknown as AppContext;
  const root = { appendChild: (c: FakeEl) => { children.push(c); return c; } } as unknown as HTMLElement;
  const onError = vi.fn();
  const router = createRouter(root, () => ctx, {
    listen: false,
    now: () => now,
    onError,
    createContainer: (id) => {
      const el: FakeEl = { id, removed: false, remove() { this.removed = true; } };
      return el as unknown as HTMLElement;
    },
  });
  const params: Record<string, ScreenParams> = {};
  const make = (id: ScreenId) => (): Screen => ({
    id,
    mount(_root, _ctx, p) {
      if (opts.throwOnMount?.includes(id)) throw new Error(`mount ${id} failed`);
      params[id] = p;
      log.push(`mount ${id}`);
    },
    unmount() { log.push(`unmount ${id}`); },
    onBack: opts.onBack?.[id],
  });
  for (const id of ['splash', 'main', 'settings', 'diagnostics', 'loading', 'match', 'half-time', 'full-time', 'recovery'] as ScreenId[]) {
    router.register(id, make(id));
  }
  return { router, log, attached, children, focus, params, onError, setNow: (t: number) => { now = t; } };
}

describe('FND-04 router', () => {
  it('pushes screens, mounts fresh instances and attaches focus per screen', () => {
    const h = harness();
    h.router.go('main');
    h.router.go('settings', { tab: 'audio' });
    expect(h.router.current).toBe('settings');
    expect(h.router.stack).toEqual(['main', 'settings']);
    expect(h.params.settings).toEqual({ tab: 'audio' });
    expect(h.log).toEqual(['mount main', 'unmount main', 'mount settings']);
    expect(h.attached.map((e) => e.id)).toEqual(['settings']);
    expect(h.children.filter((c) => !c.removed).map((c) => c.id)).toEqual(['settings']);
    expect(h.router.currentScreen()?.id).toBe('settings');
  });

  it('back pops one entry and remounts the previous screen with its params', () => {
    const h = harness();
    h.router.go('main', { a: 1 });
    h.router.go('settings');
    h.router.back();
    expect(h.router.current).toBe('main');
    expect(h.params.main).toEqual({ a: 1 });
    expect(h.attached.map((e) => e.id)).toEqual(['main']);
  });

  it('back at the root does nothing', () => {
    const h = harness();
    h.router.go('main');
    h.router.back();
    h.router.back();
    expect(h.router.stack).toEqual(['main']);
    expect(h.log.filter((l) => l.startsWith('mount'))).toEqual(['mount main']);
  });

  it('respects Screen.onBack returning true', () => {
    let handled = true;
    const h = harness({ onBack: { settings: () => handled } });
    h.router.go('main');
    h.router.go('settings');
    h.router.back();
    expect(h.router.current).toBe('settings');
    handled = false;
    h.router.back();
    expect(h.router.current).toBe('main');
  });

  it('replace swaps the top entry without growing history', () => {
    const h = harness();
    h.router.go('splash');
    h.router.replace('main');
    expect(h.router.stack).toEqual(['main']);
    h.router.go('loading');
    h.router.replace('match');
    expect(h.router.stack).toEqual(['main', 'match']);
  });

  it('go to a screen already in history unwinds to it', () => {
    const h = harness();
    h.router.go('main');
    h.router.go('match');
    h.router.go('half-time');
    h.router.go('match');
    expect(h.router.stack).toEqual(['main', 'match']);
    h.router.go('full-time', { final: true });
    h.router.go('main');
    expect(h.router.stack).toEqual(['main']);
  });

  it('resetTo clears the history', () => {
    const h = harness();
    h.router.go('main');
    h.router.go('settings');
    h.router.go('diagnostics');
    h.router.resetTo('main');
    expect(h.router.stack).toEqual(['main']);
    expect(h.children.filter((c) => !c.removed).length).toBe(1);
  });

  it('queues navigation requested during a mount', () => {
    const h = harness();
    h.router.register('loading', () => ({
      id: 'loading',
      mount() { h.router.replace('match'); },
      unmount() {},
    }));
    h.router.go('main');
    h.router.go('loading');
    expect(h.router.stack).toEqual(['main', 'match']);
  });

  it('reports mount errors and keeps the router consistent', () => {
    const h = harness({ throwOnMount: ['settings'] });
    h.router.go('main');
    h.router.go('settings');
    expect(h.onError).toHaveBeenCalledTimes(1);
    expect(h.router.current).toBe('settings');
    h.router.back();
    expect(h.router.current).toBe('main');
  });

  it('reports an unregistered screen', () => {
    const h = harness();
    h.router.go('tutorial');
    expect(h.onError).toHaveBeenCalledTimes(1);
  });

  it('collapses one physical back press arriving through several input paths', () => {
    const h = harness();
    h.router.go('main');
    h.router.go('settings');
    h.router.go('diagnostics');
    h.setNow(1000);
    h.router.backFromInput('key');
    h.setNow(1016);
    h.router.backFromInput('menu');
    expect(h.router.current).toBe('settings');
    h.setNow(1000 + BACK_DEDUPE_MS + 1);
    h.router.backFromInput('menu');
    expect(h.router.current).toBe('main');
  });

  it('never collapses pad or browser back presses', () => {
    const h = harness();
    h.router.go('main');
    h.router.go('settings');
    h.router.go('diagnostics');
    h.router.go('match');
    h.setNow(1000);
    h.router.backFromInput('key');
    h.setNow(1010);
    h.router.backFromInput('history');
    h.setNow(1020);
    h.router.backFromInput('menu'); // still the keyboard duplicate window: ignored
    expect(h.router.current).toBe('settings');
    h.setNow(5000);
    h.router.backFromInput('menu');
    h.setNow(5010);
    h.router.backFromInput('menu'); // two pad presses
    expect(h.router.current).toBe('main');
  });

  it('dispose unmounts the current screen', () => {
    const h = harness();
    h.router.go('main');
    h.router.dispose();
    expect(h.log).toContain('unmount main');
    expect(h.router.current).toBeNull();
  });
});
