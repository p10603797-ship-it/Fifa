/**
 * Shared e2e helpers for the HUD and tutorial specs (UIX-06, UIX-07, UIX-12): start a match from the main menu,
 * freeze it, drive the HUD by hand (hud.update / hud.onEvents exactly as the loop calls them), count DOM mutations
 * under #hud, and measure element boxes for overlap checks.
 */
import { expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Screenshot path under reports/ (directory created on demand). */
export function shot(name: string): string {
  const p = resolve(REPO_ROOT, 'reports', name);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

export function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

/** Boot, tap through the splash and start the main menu's Kick-Off; resolves once the match ticks. */
export async function startMatch(page: Page, minTick = 20): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').tap();
  await page.getByTestId('main-kickoff').tap();
  await waitTicking(page, minTick);
}

export async function waitTicking(page: Page, minTick = 20): Promise<void> {
  await page.waitForFunction((t) => {
    const d = window.__dotkick;
    if (!d || d.ctx.router.current !== 'match' || !d.app.session.loaded) return false;
    return (d.ctx.session.getState()?.tick ?? 0) > t;
  }, minTick, { timeout: 90_000 });
}

/** Pause the match (system pause) so the loop stops updating the HUD; optionally hide the pause menu (screenshots). */
export async function freeze(page: Page, hideMenu = true): Promise<void> {
  await page.evaluate(() => window.__dotkick!.ctx.session.pause(-1));
  await page.waitForFunction(() => window.__dotkick!.ctx.session.paused);
  if (hideMenu) await page.addStyleTag({ content: '#ui { visibility: hidden !important; }' });
}

/** Run hud.update n times on the current state, as the loop does on rendered frames. */
export async function hudUpdate(page: Page, n = 1, dtMs = 16.7, ticks = 1): Promise<void> {
  await page.evaluate(({ n, dtMs, ticks }) => {
    const d = window.__dotkick!;
    const s = d.ctx.session.getState()!;
    const w = window as unknown as { __hudFrame?: number; __hudNow?: number };
    for (let i = 0; i < n; i++) {
      w.__hudFrame = (w.__hudFrame ?? 1_000_000) + 1;
      w.__hudNow = (w.__hudNow ?? 1_000_000) + dtMs;
      d.app.hud.update(s, { nowMs: w.__hudNow, dtMs, frame: w.__hudFrame, ticks, paused: false }, d.app.renderer.projector);
    }
  }, { n, dtMs, ticks });
}

/** Feed one tick of synthetic events to the HUD (as the loop does after a sim tick). Each event: [type, a, b, c, d]. */
export async function hudEvents(page: Page, events: number[][]): Promise<void> {
  await page.evaluate((list) => {
    const d = window.__dotkick!;
    const s = d.ctx.session.getState()!;
    const evs = list.map((e) => ({ type: e[0]!, tick: s.tick, a: e[1] ?? 0, b: e[2] ?? 0, c: e[3] ?? 0, d: e[4] ?? 0, x: 0, y: 0, z: 0 }));
    const buf = { get count() { return evs.length; }, get: (i: number) => evs[i]!, begin: () => undefined, emit: () => undefined };
    d.app.hud.onEvents(buf as never, s);
  }, events);
}

/** Start counting DOM mutation records under #hud. */
export async function startMutations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __hudMut?: number; __hudObs?: MutationObserver };
    w.__hudObs?.disconnect();
    w.__hudMut = 0;
    w.__hudObs = new MutationObserver((recs) => {
      w.__hudMut = (w.__hudMut ?? 0) + recs.length;
    });
    w.__hudObs.observe(document.getElementById('hud')!, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

/** Mutation records counted since startMutations (flushes pending records first). */
export async function takeMutations(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as unknown as { __hudMut?: number; __hudObs?: MutationObserver };
    const pending = w.__hudObs?.takeRecords().length ?? 0;
    return (w.__hudMut ?? 0) + pending;
  });
}

export interface Box { x: number; y: number; w: number; h: number; name: string }

/** Visible boxes (CSS px) for the given test ids. */
export async function boxes(page: Page, testIds: string[]): Promise<Box[]> {
  return page.evaluate((ids) => {
    const out: { x: number; y: number; w: number; h: number; name: string }[] = [];
    for (const id of ids) {
      const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
      if (!el) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height, name: id });
    }
    return out;
  }, testIds);
}

/** Visible touch controls (buttons and pause) of the touch overlay. */
export async function touchBoxes(page: Page): Promise<Box[]> {
  return page.evaluate(() => {
    const out: { x: number; y: number; w: number; h: number; name: string }[] = [];
    document.querySelectorAll<HTMLElement>('#touch .dk-tbtn').forEach((el, i) => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      out.push({ x: r.x, y: r.y, w: r.width, h: r.height, name: `touch-${i}:${el.textContent ?? ''}` });
    });
    return out;
  });
}

export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Assert no two boxes of `a` overlap each other and none overlaps any of `b`. */
export function expectNoOverlap(a: Box[], b: Box[], label: string): void {
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      expect(overlaps(a[i]!, a[j]!), `${label}: ${a[i]!.name} overlaps ${a[j]!.name}`).toBe(false);
    }
    for (const t of b) expect(overlaps(a[i]!, t), `${label}: ${a[i]!.name} overlaps ${t.name}`).toBe(false);
  }
}

/** Assert every box is inside the viewport. */
export function expectInside(a: Box[], vw: number, vh: number, label: string): void {
  for (const r of a) {
    expect(r.x >= 0 && r.y >= 0 && r.x + r.w <= vw + 0.5 && r.y + r.h <= vh + 0.5, `${label}: ${r.name} outside the viewport`).toBe(true);
  }
}

/** Get the match into open play: take our restart (kick-off, throw-in, ...) with PASS (J), else wait for the CPU's. */
export async function reachInPlay(page: Page): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const st = await page.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getState()!;
      return { phase: s.match.phase, ours: s.match.restart.team === s.ctrl[0]!.side };
    });
    if (st.phase === 2) return;
    if (st.phase >= 1 && st.phase <= 7 && st.ours) {
      await page.keyboard.down('KeyJ');
      await page.waitForTimeout(120);
      await page.keyboard.up('KeyJ');
    }
    await page.waitForTimeout(500);
  }
  throw new Error('match never reached IN_PLAY');
}
