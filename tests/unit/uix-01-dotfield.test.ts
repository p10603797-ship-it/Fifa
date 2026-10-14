/**
 * UIX-01 dot field: pure parts (30 fps cadence, easing, buckets, layout), and the field on a fake DOM: it draws only
 * while mounted, active and out of a match, never schedules its own frames, batches its fills, follows focus with a
 * parallax response, honours reduced motion, and withDotField wires it into a screen's lifecycle.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext, FrameInfo, Screen } from '../../src/contracts/app';
import {
  bucketAlpha, bucketStyles, buildFloaters, createDotField, DOTFIELD, easeToward, emberBucket, focusOffset, gridSize,
  hash01, neutralBucket, shouldDraw, withDotField, wrapInto, type DotField,
} from '../../src/ui/dotfield';
import { FakeContext2D, FakeDocument, FakeElement, FakeEvent, makeAppDom } from './uix-01-fakedom';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Run frames at hz for ms starting at t0; returns the last time. */
function run(field: DotField, hz: number, ms: number, t0 = 1000): number {
  const dt = 1000 / hz;
  let t = t0;
  for (let i = 0; i <= Math.round(ms / dt); i++) {
    field.frame(t);
    t += dt;
  }
  return t - dt;
}

function setup(): { doc: FakeDocument; screen: FakeElement; field: DotField } {
  const { doc, screen } = makeAppDom();
  const field = createDotField({ doc: doc as unknown as Document });
  return { doc, screen, field };
}

function canvasOf(screen: FakeElement): FakeElement | null {
  return screen.querySelector('canvas.dotfield');
}

describe('UIX-01 dot field: pure parts', () => {
  it('draws on a steady 30 fps cadence at 30, 60, 120 and 144 Hz', () => {
    for (const hz of [30, 60, 120, 144]) {
      let last = -1;
      let draws = 0;
      const dt = 1000 / hz;
      for (let i = 0; i < hz * 2; i++) {
        const now = 500 + i * dt;
        if (shouldDraw(now, last)) {
          draws++;
          last = now;
        }
      }
      expect(draws, `${hz} Hz`).toBeGreaterThanOrEqual(hz === 144 ? 48 : 58);
      expect(draws, `${hz} Hz`).toBeLessThanOrEqual(61); // never above 30 fps over 2 s
    }
    expect(shouldDraw(100, -1)).toBe(true);
    expect(shouldDraw(100, 200)).toBe(true); // clock went back: draw
  });

  it('eases the same amount at any frame rate', () => {
    let a = 0, b = 0;
    for (let i = 0; i < 60; i++) a = easeToward(a, 1, 1 / 60, 0.4);
    for (let i = 0; i < 30; i++) b = easeToward(b, 1, 1 / 30, 0.4);
    expect(a).toBeCloseTo(b, 6);
    expect(a).toBeGreaterThan(0.9);
    expect(easeToward(0.3, 1, 0, 0.4)).toBe(0.3);
    expect(easeToward(0.3, 1, 0.1, 0)).toBe(1);
  });

  it('maps a focus position to a clamped offset from the screen centre', () => {
    expect(focusOffset(590, 410, 1180, 820)).toEqual({ x: 0, y: 0 });
    expect(focusOffset(1180, 0, 1180, 820)).toEqual({ x: 0.5, y: -0.5 });
    expect(focusOffset(-500, 5000, 1180, 820)).toEqual({ x: -0.5, y: 0.5 });
    expect(focusOffset(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('wraps positions into the tile', () => {
    expect(wrapInto(5, 0, 10)).toBe(5);
    expect(wrapInto(-1, 0, 10)).toBe(9);
    expect(wrapInto(25, -5, 10)).toBe(-5);
    expect(wrapInto(-30.5, -10, 20)).toBeCloseTo(-10.5 + 20, 9);
  });

  it('buckets alphas into a few fill styles', () => {
    expect(neutralBucket(-1)).toBe(0);
    expect(neutralBucket(0)).toBe(0);
    expect(neutralBucket(10)).toBe(5);
    expect(emberBucket(0)).toBe(6);
    expect(emberBucket(1)).toBe(9);
    for (let b = 1; b < 6; b++) expect(bucketAlpha(b)).toBeGreaterThan(bucketAlpha(b - 1));
    const styles = bucketStyles('#f7f0ee', 'rgb(255, 107, 53)');
    expect(styles).toHaveLength(10);
    expect(styles[0]).toMatch(/^rgba\(247, 240, 238, 0\.0\d+\)$/);
    expect(styles[9]).toMatch(/^rgba\(255, 107, 53, 0\.950\)$/);
    expect(bucketStyles('garbage', '#abc')[9]).toBe('rgba(170, 187, 204, 0.950)');
  });

  it('lays out the same floaters every time, inside the wrap tile, ember only on the near layer', () => {
    const a = buildFloaters(1180, 820, 26);
    const b = buildFloaters(1180, 820, 26);
    expect(a.count).toBeGreaterThan(100);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    let ember = 0;
    for (let i = 0; i < a.count; i++) {
      expect(a.x[i]).toBeGreaterThanOrEqual(-a.margin);
      expect(a.x[i]).toBeLessThan(a.spanX - a.margin);
      expect(a.y[i]).toBeGreaterThanOrEqual(-a.margin);
      if (a.ember[i]) {
        ember++;
        expect(a.layer[i]).toBe(2);
      }
    }
    expect(ember).toBeGreaterThan(0);
    expect(ember / a.count).toBeLessThan(0.15); // ember used sparingly
    const g = gridSize(1180, 820, 26);
    expect(g.cols * 26).toBeGreaterThan(1180 + DOTFIELD.parallaxGridPx * 2);
    expect(g.rows * g.rowStep).toBeGreaterThan(820 + DOTFIELD.parallaxGridPx * 2);
    for (let i = 0; i < 100; i++) {
      const v = hash01(i, 7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('UIX-01 dot field on a fake DOM', () => {
  it('mounts its canvas behind the screen content and draws at <= 30 fps from the app loop', () => {
    const { screen, field } = setup();
    screen.append(new FakeElement(screen.ownerDocument, 'h1'));
    field.mount(screen as unknown as HTMLElement);
    const c = canvasOf(screen)!;
    expect(c).not.toBeNull();
    expect(screen.firstChild).toBe(c);
    expect(c.getAttribute('aria-hidden')).toBe('true');
    expect(screen.classList.contains('has-dotfield')).toBe(true);
    expect(c.hidden).toBe(false);
    run(field, 60, 1000);
    expect(field.stats.draws).toBeGreaterThanOrEqual(29);
    expect(field.stats.draws).toBeLessThanOrEqual(31);
    expect(field.stats.visible).toBe(true);
    expect(c.width).toBe(1180);
    expect(c.height).toBe(820);
    expect(field.stats.dots).toBeGreaterThan(1000);
  });

  it('batches dots into at most one fill per alpha bucket per frame', () => {
    const { screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    field.frame(1000);
    const ctx = canvasOf(screen)!.ctx2d as FakeContext2D;
    expect(ctx.count('fill')).toBeLessThanOrEqual(10);
    expect(ctx.count('fill')).toBeGreaterThan(0);
    expect(ctx.count('arc')).toBeGreaterThan(500);
    expect(ctx.count('clearRect')).toBe(1);
  });

  it('calling frame twice with the same timestamp draws once (a screen and a wrapper may both forward onFrame)', () => {
    const { screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    field.frame(1000);
    field.frame(1000);
    expect(field.stats.draws).toBe(1);
  });

  it('never schedules its own frames or timers', () => {
    const raf = vi.fn(() => { throw new Error('requestAnimationFrame called'); });
    const timer = vi.fn(() => { throw new Error('timer called'); });
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('setTimeout', timer);
    vi.stubGlobal('setInterval', timer);
    const { screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    run(field, 60, 500);
    field.setActive(false);
    field.setActive(true);
    field.unmount();
    field.dispose();
    expect(raf).not.toHaveBeenCalled();
    expect(timer).not.toHaveBeenCalled();
  });

  it('its source never asks for animation frames or timers (the app loop drives it through onFrame)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ui/dotfield.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/requestAnimationFrame|setTimeout|setInterval|requestIdleCallback/);
  });

  it('setActive(false) hides the canvas and stops drawing until setActive(true)', () => {
    const { screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    let t = run(field, 60, 200);
    const before = field.stats.draws;
    field.setActive(false);
    expect(canvasOf(screen)!.hidden).toBe(true);
    t = run(field, 60, 1000, t + 16);
    expect(field.stats.draws).toBe(before);
    field.setActive(true);
    expect(canvasOf(screen)!.hidden).toBe(false);
    run(field, 60, 200, t + 16);
    expect(field.stats.draws).toBeGreaterThan(before);
  });

  it('glitch: the dot field never draws during a match, even when a menu over the match keeps calling frame()', () => {
    const { doc, screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    let t = run(field, 60, 200);
    const before = field.stats.draws;
    const ctx = canvasOf(screen)!.ctx2d as FakeContext2D;
    ctx.reset();
    for (const cls of ['match-active', 'in-match']) {
      doc.body.classList.add(cls);
      t = run(field, 60, 1000, t + 16);
      expect(field.stats.draws, cls).toBe(before);
      expect(field.stats.blocked).toBe(true);
      expect(canvasOf(screen)!.hidden, cls).toBe(true);
      expect(ctx.calls.length, cls).toBe(0);
      doc.body.classList.remove(cls);
    }
    run(field, 60, 200, t + 16);
    expect(field.stats.draws).toBeGreaterThan(before);
    expect(canvasOf(screen)!.hidden).toBe(false);
  });

  it('the screen carries .has-dotfield only while the field is visible (a hidden field leaves an overlay screen its scrim)', () => {
    const { doc, screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    expect(screen.classList.contains('has-dotfield')).toBe(true);
    doc.body.classList.add('match-active');
    field.frame(1000);
    expect(screen.classList.contains('has-dotfield')).toBe(false);
    doc.body.classList.remove('match-active');
    field.frame(1100);
    expect(screen.classList.contains('has-dotfield')).toBe(true);
    field.setActive(false);
    expect(screen.classList.contains('has-dotfield')).toBe(false);
    field.setActive(true);
    // Mounting while a match is on (Settings opened from the pause menu) never adds it.
    doc.body.classList.add('match-active');
    const over = doc.createElement('div');
    doc.getElementById('ui')!.appendChild(over);
    field.mount(over as unknown as HTMLElement);
    expect(over.classList.contains('has-dotfield')).toBe(false);
    expect(screen.classList.contains('has-dotfield')).toBe(false);
    // Without a 2D canvas the screen keeps its static CSS dots.
    const d2 = new FakeDocument();
    d2.canvasSupported = false;
    const f2 = createDotField({ doc: d2 as unknown as Document });
    const r2 = d2.createElement('div');
    d2.body.appendChild(r2);
    f2.mount(r2 as unknown as HTMLElement);
    expect(r2.classList.contains('has-dotfield')).toBe(false);
  });

  it('unmount removes the canvas and stops drawing; a later mount on another screen moves it there', () => {
    const { doc, screen, ui, field } = { ...setup(), ui: null as FakeElement | null };
    void ui;
    field.mount(screen as unknown as HTMLElement);
    run(field, 60, 100);
    field.unmount(screen as unknown as HTMLElement);
    expect(canvasOf(screen)).toBeNull();
    expect(screen.classList.contains('has-dotfield')).toBe(false);
    const draws = field.stats.draws;
    run(field, 60, 500, 5000);
    expect(field.stats.draws).toBe(draws);
    const other = doc.createElement('div');
    doc.getElementById('ui')!.appendChild(other);
    field.mount(other as unknown as HTMLElement);
    expect(canvasOf(other)).not.toBeNull();
    run(field, 60, 100, 9000);
    expect(field.stats.draws).toBeGreaterThan(draws);
  });

  it('unmount of a screen that no longer owns the field leaves the new owner alone', () => {
    const { doc, screen, field } = setup();
    const next = doc.createElement('div');
    doc.getElementById('ui')!.appendChild(next);
    field.mount(screen as unknown as HTMLElement);
    field.mount(next as unknown as HTMLElement);
    field.unmount(screen as unknown as HTMLElement);
    expect(canvasOf(next)).not.toBeNull();
    expect(field.stats.mounted).toBe(true);
    expect(screen.classList.contains('has-dotfield')).toBe(false);
  });

  it('follows focus with a parallax response (focus on the right shifts the layers)', () => {
    const { doc, screen, field } = setup();
    field.mount(screen as unknown as HTMLElement);
    const btn = doc.createElement('button');
    btn.rect = { left: 1000, top: 380, width: 160, height: 60 };
    screen.append(btn);
    let t = run(field, 60, 200);
    expect(Math.abs(field.stats.parallaxX)).toBeLessThan(1e-6);
    // Navigator moves focus (keyboard / pad: native focus + [data-focused]).
    btn.setAttribute('data-focused', '');
    btn.focus();
    t = run(field, 60, 200, t + 16);
    const mid = field.stats.parallaxX;
    expect(mid).toBeGreaterThan(0.1);
    t = run(field, 60, 2000, t + 16);
    expect(field.stats.parallaxX).toBeGreaterThan(mid);
    expect(field.stats.parallaxX).toBeCloseTo((1080 / 1180) - 0.5, 2);
    // A touch press moves only [data-focused] (no native focus): pointerdown marks it for re-reading.
    btn.removeAttribute('data-focused');
    const left = doc.createElement('button');
    left.rect = { left: 0, top: 380, width: 100, height: 60 };
    left.setAttribute('data-focused', '');
    screen.append(left);
    left.dispatchEvent(new FakeEvent('pointerdown'));
    run(field, 60, 3000, t + 16);
    expect(field.stats.parallaxX).toBeLessThan(-0.3);
  });

  it('with reduced motion it draws a still frame and redraws only on focus or size changes', () => {
    const { doc, screen, field } = setup();
    doc.defaultView.reducedMotion = true;
    field.mount(screen as unknown as HTMLElement);
    let t = run(field, 60, 1000);
    expect(field.stats.draws).toBe(1);
    const btn = doc.createElement('button');
    btn.rect = { left: 900, top: 100, width: 100, height: 60 };
    btn.setAttribute('data-focused', '');
    screen.append(btn);
    btn.focus();
    t = run(field, 60, 500, t + 16);
    expect(field.stats.draws).toBe(2);
    expect(field.stats.parallaxX).toBeCloseTo(950 / 1180 - 0.5, 6); // snapped, no easing
    doc.defaultView.innerWidth = 1366;
    run(field, 60, 500, t + 16);
    expect(field.stats.draws).toBe(3);
    expect(canvasOf(screen)!.width).toBe(1366);
  });

  it('resizes the canvas with the window and caps the resolution at 2x', () => {
    const { doc, screen, field } = setup();
    doc.defaultView.devicePixelRatio = 3;
    field.mount(screen as unknown as HTMLElement);
    field.frame(1000);
    expect(canvasOf(screen)!.width).toBe(2360);
    doc.defaultView.innerWidth = 1024;
    doc.defaultView.innerHeight = 768;
    field.frame(1005); // a resize draws at once (the canvas was cleared)
    expect(canvasOf(screen)!.width).toBe(2048);
    expect(canvasOf(screen)!.height).toBe(1536);
    expect(field.stats.draws).toBe(2);
  });

  it('does nothing (and never throws) without a 2D canvas or a document', () => {
    const doc = new FakeDocument();
    doc.canvasSupported = false;
    const field = createDotField({ doc: doc as unknown as Document });
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    field.mount(root as unknown as HTMLElement);
    run(field, 60, 200);
    expect(field.stats.draws).toBe(0);
    field.unmount();
    field.dispose();
    const none = createDotField({ doc: null });
    none.mount({} as HTMLElement);
    none.frame(1);
    none.setActive(false);
    none.dispose();
    expect(none.stats.draws).toBe(0);
  });

  it('reads its colours and spacing from the tokens', () => {
    const { doc, screen, field } = setup();
    doc.defaultView.cssVars.set('--dot-accent', '#00ff00');
    doc.defaultView.cssVars.set('--dot-spacing', '40px');
    field.mount(screen as unknown as HTMLElement);
    field.frame(1000);
    const ctx = canvasOf(screen)!.ctx2d as FakeContext2D;
    const styles = ctx.calls.filter((c) => c.name === 'fill').map((c) => String(c.args[0]));
    expect(styles.some((s) => s.startsWith('rgba(0, 255, 0,'))).toBe(true);
    const fewer = field.stats.dots;
    const { screen: s2, field: f2 } = setup();
    f2.mount(s2 as unknown as HTMLElement);
    f2.frame(1000);
    expect(fewer).toBeLessThan(f2.stats.dots);
  });
});

describe('UIX-01 withDotField', () => {
  function fakeScreen(): Screen & { calls: string[] } {
    const calls: string[] = [];
    return {
      id: 'main', calls,
      mount: (root) => { calls.push(`mount:${(root as unknown as FakeElement).children.length}`); },
      unmount: () => { calls.push('unmount'); },
      onBack: () => { calls.push('back'); return true; },
      onFrame: () => { calls.push('frame'); },
    };
  }

  it('mounts the field before the content, drives it from onFrame and detaches it on unmount', () => {
    const { screen, field } = setup();
    const inner = fakeScreen();
    const s = withDotField(() => inner, () => field)();
    expect(s.id).toBe('main');
    s.mount(screen as unknown as HTMLElement, {} as AppContext, {});
    expect(inner.calls[0]).toBe('mount:1'); // the canvas is already there
    const info: FrameInfo = { nowMs: 1000, dtMs: 16, frame: 1, ticks: 0, paused: false };
    s.onFrame!(info);
    expect(field.stats.draws).toBe(1);
    expect(inner.calls).toContain('frame');
    expect(s.onBack!()).toBe(true);
    s.unmount();
    expect(inner.calls).toContain('unmount');
    expect(canvasOf(screen)).toBeNull();
    expect(field.stats.mounted).toBe(false);
  });

  it('a screen without onBack still lets the router go back; unmount detaches even when the inner unmount throws', () => {
    const { screen, field } = setup();
    const s = withDotField(() => ({ id: 'settings', mount() {}, unmount() { throw new Error('boom'); } }), () => field)();
    s.mount(screen as unknown as HTMLElement, {} as AppContext, {});
    expect(s.onBack!()).toBe(false);
    expect(() => s.unmount()).toThrow('boom');
    expect(field.stats.mounted).toBe(false);
  });
});
