/**
 * [QF-7R] HUD and touch-overlay DOM writes only on change (BRIEF section 12 "HUD parts write to the DOM only on change";
 * section 13): during live play every DOM mutation under the page (HUD, touch controls, overlays) must change
 * something. A MutationObserver records every attribute, text and child-list mutation with its old value over ~30 s of
 * a live match (a human on touch v CPU, with a goal (toast, score, replay) and then a throw-in for the human (set-piece hint)); a mutation whose value afterwards equals its old value is a redundant write
 * (style recalculation and layout for nothing, every frame it happens). Also reports writes per second per element.
 * WebGL draw calls are stubbed (the GPU raster is software here and would hold the page at a few fps; the HUD is DOM).
 *
 *   npx vite build --outDir dist-e2e/qf-7r --emptyOutDir
 *   PW_DIST=dist-e2e/qf-7r PW_PORT=4417 npx playwright test tests/e2e/qf-7r-hud.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { collectConsole, waitMatch, waitRoute } from './int-b-harness';

const NODRAW = `
(() => {
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const m of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      if (C.prototype[m]) C.prototype[m] = function () {};
    }
  }
})();
`;

interface Report { frames: number; seconds: number; mutations: number; redundant: string[]; perSecond: [string, number][]; goals: number }

/** Observe all DOM mutations for `ms` of play; returns redundant writes and the busiest targets. */
async function observe(page: Page, ms: number): Promise<Report> {
  return page.evaluate((dur) => new Promise<Report>((done) => {
    const recs: MutationRecord[] = [];
    const mo = new MutationObserver((list) => { for (const r of list) recs.push(r); });
    mo.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true,
    });
    let frames = 0;
    const t0 = performance.now();
    // Events the HUD reacts to, through the sim's own rules: the ball over the touchline off the CPU side (a throw-in
    // for the human: set-piece hint) and later into the CPU's net (goal toast, score, replay). Written into the live
    // state the way tests/e2e/int-c-live.spec.ts does.
    type B = Record<string, number>;
    const st = (): { tick: number; ball: B; teams: { dir: number }[] } => (window as unknown as { __dotkick: { ctx: { session: { getState(): unknown } } } }).__dotkick.ctx.session.getState() as never;
    const loose = (x: number, z: number, y: number, vx: number, vz: number, team: number, slot: number): void => {
      const s = st();
      const b = s.ball;
      b.owner = -1; b.heldBy = -1; b.x = x; b.z = z; b.y = y; b.vx = vx; b.vy = 0; b.vz = vz;
      b.px = x; b.py = y; b.pz = z; b.grounded = 1; b.shotBy = -1; b.passTarget = -1;
      b.lastTouch = slot; b.lastTouchTeam = team; b.lastTouchTick = s.tick; b.lastKickTeam = team; b.lastKickBy = slot;
    };
    let poked = 0;
    const tick = (): void => {
      frames++;
      const el = performance.now() - t0;
      const inPlay = (st() as unknown as { match: { phase: number } }).match.phase === 2;
      if (poked === 0 && inPlay && el > dur * 0.1) {
        poked = 1;
        const e = st().teams[0]!.dir > 0 ? 1 : -1; // the net team 0 (the human's side) attacks
        // Wholly over the line on the next tick, wide of the keeper (from 52.2 m at 12 m/s it took two ticks and the
        // keeper sometimes got there first: no goal, and the toast / score path went unobserved).
        loose(e * 52.4, 3.3, 1.9, e * 20, 0, 0, 9);
      }
      if (poked === 1 && inPlay && el > dur * 0.5) { poked = 2; loose(10, 33.6, 0.11, 0, 6, 1, 15); }
      if (el < dur) { requestAnimationFrame(tick); return; }
      for (const r of mo.takeRecords()) recs.push(r);
      mo.disconnect();
      const name = (n: Node | null): string => {
        let el: Node | null = n;
        while (el && !(el instanceof Element)) el = el.parentNode;
        if (!el) return '?';
        const e = el as Element;
        const id = e.getAttribute('data-testid');
        return id ? `[${id}]` : `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(e.className && typeof e.className === 'string' ? e.className : '').split(' ')[0]}`;
      };
      // Value after each mutation: the next record's old value for the same target / attribute, else the live value.
      type Key = string;
      const seq = new Map<Node, Map<Key, number[]>>();
      recs.forEach((r, i) => {
        if (r.type === 'childList') return;
        const k = r.type === 'attributes' ? `@${r.attributeName}` : '#text';
        let m = seq.get(r.target);
        if (!m) { m = new Map(); seq.set(r.target, m); }
        let a = m.get(k);
        if (!a) { a = []; m.set(k, a); }
        a.push(i);
      });
      const redundant: string[] = [];
      for (const [node, m] of seq) {
        for (const [k, idx] of m) {
          for (let j = 0; j < idx.length; j++) {
            const r = recs[idx[j]!]!;
            const after = j + 1 < idx.length ? recs[idx[j + 1]!]!.oldValue
              : k === '#text' ? (node as CharacterData).data : (node as Element).getAttribute(k.slice(1));
            if (after === r.oldValue && redundant.length < 40) redundant.push(`${name(node)} ${k} = ${JSON.stringify(after)?.slice(0, 80)}`);
          }
        }
      }
      // Child lists replaced with the same text (textContent = same string).
      for (const r of recs) {
        if (r.type !== 'childList' || r.removedNodes.length !== 1 || r.addedNodes.length !== 1) continue;
        const a = r.removedNodes[0]!, b = r.addedNodes[0]!;
        if (a.nodeType === 3 && b.nodeType === 3 && a.textContent === b.textContent && redundant.length < 40) {
          redundant.push(`${name(r.target)} childList text = ${JSON.stringify(b.textContent)?.slice(0, 80)}`);
        }
      }
      const counts = new Map<string, number>();
      for (const r of recs) {
        const k = `${name(r.target)} ${r.type === 'attributes' ? '@' + r.attributeName : r.type}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const secs = (performance.now() - t0) / 1000;
      const perSecond = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([k, v]) => [k, Math.round((v / secs) * 10) / 10] as [string, number]);
      const t = st().teams as unknown as { goals: number }[];
      done({ frames, seconds: secs, mutations: recs.length, redundant, perSecond, goals: t[0]!.goals + t[1]!.goals });
    };
    requestAnimationFrame(tick);
  }), ms);
}

test('HUD and touch controls write the DOM only on change during live play', async ({ page }) => {
  test.setTimeout(180_000);
  const errors = collectConsole(page);
  await page.addInitScript(NODRAW);
  await page.goto('/');
  await expect(page.getByTestId('splash-start')).toBeVisible();
  await page.touchscreen.tap(40, 410);
  await waitRoute(page, 'main');
  await page.getByTestId('main-kickoff').tap();
  await waitMatch(page);
  // Into open play (the kick-off is taken by the CPU or after its timeout), then a few seconds of steady play.
  await page.waitForFunction(() => {
    const st = (window as unknown as { __dotkick: { ctx: { session: { getState(): { match: { phase: number } } | null } } } }).__dotkick.ctx.session.getState();
    return !!st && st.match.phase === 2;
  }, null, { timeout: 60_000, polling: 100 });
  await page.waitForTimeout(1500);
  const rep = await observe(page, 30000);
  console.log(`QF-7R HUD DOM writes: ${JSON.stringify({ frames: rep.frames, seconds: Math.round(rep.seconds * 10) / 10, mutations: rep.mutations, perSecond: rep.perSecond })}`);
  expect(rep.frames).toBeGreaterThan(100);
  expect(rep.goals, 'the forced goal was scored (toast, score and replay observed)').toBeGreaterThan(0);
  expect(rep.redundant, rep.redundant.join('\n')).toEqual([]);
  expect(errors.filter((e) => !/GPU stall|GL Driver/.test(e))).toEqual([]);
});
