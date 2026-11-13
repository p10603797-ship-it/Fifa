/**
 * [LOOK] Reusable capture of the player look and run cycle for art / animation review (no assertions beyond the
 * frames being drawn). Skipped unless LOOK_OUT is set, so the normal suite is unaffected.
 *
 * Writes to $LOOK_OUT (PNG, deviceScaleFactor 1, iPad landscape 1180 x 820, Chromium + SwiftShader WebGL2):
 *  - close-ups through window.__dotkickPlayers of an outfield player (slot 9) and a keeper (slot 0), standing alone:
 *      <who>-idle-front.png, <who>-idle-34.png (full body), <who>-front.png / <who>-back.png (close, raised: face,
 *        collar, number), <who>-back-full.png,
 *      <who>-turn-lean-front.png / -back.png (TURN_LEAN, sprint style, turning right at 2.5 rad/s, 7 m/s),
 *      keeper only: keeper-ready-34.png (KEEPER_READY);
 *      <who>-<jog|sprint>-<side|34>-p<k>.png: 8 evenly spaced stride-cycle phases (cycle = k * 2 PI / 8), side view
 *        from the player's right and a three-quarter front view; cropped around the player at full resolution;
 *      <who>-<jog|sprint>-sheet.png: contact sheet of those 16 frames (top row side, bottom row three-quarter);
 *  - three frames of open play in a CPU v CPU match from the normal broadcast camera (match-1..3.png, HUD and touch
 *    controls hidden), each with a 2x crop around the ball (match-<n>-crop.png);
 *  - a live close-up strip of the fastest running player as the real mapper drives him (live-run-sheet.png);
 *  - stats.json: draw calls / triangles of every match frame (window.__dotkickRendererStats), resolution scale,
 *    quality tier, player mesh info, clip speeds.
 * Held clips are the bare pose functions (mapper.poseFnFor): no mapper lean / breathing layers, no foot lock; the live
 * strip shows the full pipeline.
 *
 * LOOK_TIER (optional) forces Settings > Graphics tier (1 PERFORMANCE, 2 BALANCED, 3 QUALITY) before the captures; unset
 * leaves AUTO, which picks PERFORMANCE under SwiftShader (the baseline in reports/look/before was taken that way).
 * Run: npx vite build --outDir dist-e2e/look --emptyOutDir &&
 *      LOOK_OUT=$PWD/reports/look/before PW_DIST=dist-e2e/look PW_PORT=4290 npx playwright test tests/e2e/look-capture.spec.ts --trace off
 */
import { test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.LOOK_OUT ?? '';
/** Optional quality tier to force (contracts/enums.ts QualityTier: 1 PERFORMANCE, 2 BALANCED, 3 QUALITY); unset = AUTO. */
const TIER = Number(process.env.LOOK_TIER ?? '0') | 0;
const CANVAS_ONLY = '#ui, #hud, #touch, .dk-touch { visibility: hidden !important; }';
const OUTFIELD = 9;
const KEEPER = 0;
/** contracts/render.ts AnimId values. */
const A = { IDLE: 0, JOG: 1, SPRINT: 2, TURN_LEAN: 3, KEEPER_READY: 18 } as const;
const JOG_SPEED = 5;
const SPRINT_SPEED = 8.5;
const PHASES = 8;
/** Crop around the close-up player (CSS px of the 1180 x 820 viewport) and the contact-sheet cell size. */
const CROP = { x: 210, y: 10, w: 760, h: 800 };
const CELL = { w: 304, h: 320 };

test.skip(!OUT, 'LOOK_OUT not set: look capture is a manual tool');

function save(name: string, png: Buffer): void {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, name), png);
}

function dataUrlPng(url: string): Buffer {
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

async function shot(page: Page, name: string): Promise<void> {
  save(name, await page.screenshot({ style: CANVAS_ONLY }));
}

/** CPU v CPU match (both humans become CPU), loop stopped and driven by hand. */
async function startCpuMatch(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('splash-start').click();
  await page.getByTestId('main-kickoff').click();
  await page.waitForFunction(() => {
    const d = window.__dotkick;
    return !!d && d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 90_000, polling: 250 });
  await page.evaluate(() => {
    const d = window.__dotkick!;
    const setup = d.ctx.session.getSetup()!;
    d.ctx.session.quit();
    const humans = setup.config.humans.map((hh) => ({ ...hh, kind: 0, side: -1 }));
    d.ctx.session.start({ ...setup, bindings: [], config: { ...setup.config, night: 0, seed: 1234, humans } });
  });
  await page.waitForFunction(() => {
    const d = window.__dotkick!;
    return d.ctx.router.current === 'match' && d.app.session.loaded && d.ctx.session.getState() !== null;
  }, null, { timeout: 120_000, polling: 250 });
  if (TIER) {
    // Settings > Graphics tier (AUTO picks PERFORMANCE under SwiftShader; a real iPad gets BALANCED or QUALITY).
    await page.evaluate((t) => window.__dotkick!.ctx.settings.update((st) => { st.graphics.tier = t; }), TIER);
    await page.waitForFunction((t) => window.__dotkickRendererStats!().qualityTier === t, TIER, { timeout: 30_000, polling: 100 });
  }
  await page.addStyleTag({ content: CANVAS_ONLY });
  await page.evaluate(() => {
    const d = window.__dotkick!;
    d.app.loop.stop();
    const w = window as unknown as { __lookNow: number; __lookStep: (n: number, dt: number) => void };
    w.__lookNow = performance.now();
    w.__lookStep = (n: number, dt: number) => { for (let i = 0; i < n; i++) { w.__lookNow += dt; d.app.loop.frame(w.__lookNow); } };
  });
}

const step = (page: Page, n: number, dt = 1000 / 60): Promise<void> =>
  page.evaluate(([k, d]) => (window as unknown as { __lookStep: (n: number, dt: number) => void }).__lookStep(k!, d!), [n, dt]);

/**
 * Hide everyone but the listed slots (inactive players are not drawn), put those at (x, z) facing +x, standing still;
 * the ball sits under the first one's feet just below the grass (its centre stays on screen in every close-up, so the
 * off-screen ball arrow stays away).
 */
async function stage(page: Page, placed: [number, number, number][]): Promise<void> {
  await page.evaluate((list) => {
    const rt = window.__dotkick!.app.session.runtime()!;
    type P = { x: number; z: number; fx: number; fz: number; vx: number; vz: number; active: number };
    for (const s of [rt.prev, rt.curr] as unknown as { players: P[]; ball: { x: number; y: number; z: number; vx: number; vy: number; vz: number; owner: number } }[]) {
      s.players.forEach((p, i) => { p.x = -45 + i * 3; p.z = -33; p.fx = 1; p.fz = 0; p.vx = 0; p.vz = 0; p.active = 0; });
      for (const [slot, x, z] of list) { const p = s.players[slot]!; p.x = x; p.z = z; p.active = 1; }
      const [, bx, bz] = list[0]!;
      s.ball.x = bx; s.ball.y = -0.12; s.ball.z = bz; s.ball.vx = 0; s.ball.vy = 0; s.ball.vz = 0; s.ball.owner = -1;
    }
    const P = window.__dotkickPlayers!;
    for (let i = 0; i < 22; i++) P.holdPose(i, null);
  }, placed);
}

/** Ball height (m) in prev and curr (the close-ups keep it on screen but out of sight). */
async function setBallY(page: Page, y: number): Promise<void> {
  await page.evaluate((by) => {
    const rt = window.__dotkick!.app.session.runtime()!;
    for (const s of [rt.prev, rt.curr] as unknown as { ball: { y: number } }[]) s.ball.y = by;
  }, y);
}

/**
 * Hold a clip on `slot`, put the close-up camera on it, draw frames, and (same task: the drawing buffer is not
 * preserved) copy the crop into the contact sheet cell (col, row) and return the crop as a PNG data URL.
 */
async function holdAndGrab(page: Page, slot: number, clip: [number, number, number, number, number, number], cam: [number, number, number], cell: [number, number] | null): Promise<string> {
  return page.evaluate(([s, c, v, cl, crop, cellSz]) => {
    const dk = window.__dotkick!;
    const rt = dk.app.session.runtime()!;
    const P = window.__dotkickPlayers!;
    P.holdClip(s, c[0], c[1], c[2], c[3], c[4], c[5]);
    P.closeUp(s, v[0], v[1], v[2]);
    const info = { nowMs: 0, dtMs: 16, frame: 0, ticks: 0, paused: false };
    for (let i = 0; i < 2; i++) { info.frame++; info.nowMs += 16; dk.app.renderer.render(rt.prev, rt.curr, 1, info); }
    const gl = document.getElementById('game') as HTMLCanvasElement;
    const kx = gl.width / window.innerWidth, ky = gl.height / window.innerHeight;
    const one = document.createElement('canvas');
    one.width = crop.w; one.height = crop.h;
    one.getContext('2d')!.drawImage(gl, crop.x * kx, crop.y * ky, crop.w * kx, crop.h * ky, 0, 0, crop.w, crop.h);
    if (cl) {
      const w = window as unknown as { __lookSheet?: HTMLCanvasElement };
      w.__lookSheet!.getContext('2d')!.drawImage(one, 0, 0, crop.w, crop.h, cl[0] * cellSz.w, cl[1] * cellSz.h, cellSz.w, cellSz.h);
    }
    return one.toDataURL('image/png');
  }, [slot, clip, cam, cell, CROP, CELL] as const);
}

async function newSheet(page: Page, cols: number, rows: number): Promise<void> {
  await page.evaluate(([c, r, cell]) => {
    const w = window as unknown as { __lookSheet?: HTMLCanvasElement };
    const cv = document.createElement('canvas');
    cv.width = c * cell.w; cv.height = r * cell.h;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    w.__lookSheet = cv;
  }, [cols, rows, CELL] as const);
}

async function sheetPng(page: Page, labels: string[]): Promise<Buffer> {
  const url = await page.evaluate(([cell, lab]) => {
    const w = window as unknown as { __lookSheet?: HTMLCanvasElement };
    const cv = w.__lookSheet!;
    const g = cv.getContext('2d')!;
    g.font = '14px monospace';
    g.fillStyle = '#fff';
    const cols = cv.width / cell.w;
    lab.forEach((t, i) => g.fillText(t, (i % cols) * cell.w + 6, Math.floor(i / cols) * cell.h + 18));
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let x = cell.w; x < cv.width; x += cell.w) { g.beginPath(); g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, cv.height); g.stroke(); }
    for (let y = cell.h; y < cv.height; y += cell.h) { g.beginPath(); g.moveTo(0, y + 0.5); g.lineTo(cv.width, y + 0.5); g.stroke(); }
    return cv.toDataURL('image/png');
  }, [CELL, labels] as const);
  return dataUrlPng(url);
}

test.describe('LOOK capture', () => {
  test('player close-ups, run-cycle phases, broadcast frames and budgets', async ({ page }) => {
    test.setTimeout(900_000);
    const stats: Record<string, unknown> = { jogSpeed: JOG_SPEED, sprintSpeed: SPRINT_SPEED, phases: PHASES };
    await startCpuMatch(page);
    stats.playerInfo = await page.evaluate(() => window.__dotkickPlayers!.info());

    // ---------------------------------------------------------------- broadcast frames of open play
    const into = await page.evaluate(() => {
      const d = window.__dotkick!;
      const w = window as unknown as { __lookNow: number };
      const r = d.app.renderer as unknown as { render: (...a: unknown[]) => void };
      const orig = r.render;
      r.render = () => {};
      try {
        for (let g = 0; g < 20000; g++) {
          w.__lookNow += 50; d.app.loop.frame(w.__lookNow);
          if ((d.ctx.session.getState() as unknown as { match: { phase: number } }).match.phase === 2 && g > 40) break;
        }
      } finally { r.render = orig; }
      return (d.ctx.session.getState() as unknown as { tick: number }).tick;
    });
    stats.openPlayTick = into;
    const matchStats: unknown[] = [];
    for (let n = 1; n <= 3; n++) {
      await step(page, n === 1 ? 90 : 150); // ~1.5 s, then 2.5 s apart at 60 Hz (rendered: the camera settles)
      const st = await page.evaluate(() => {
        const d = window.__dotkick!;
        const s = d.ctx.session.getState() as unknown as { tick: number; match: { phase: number }; ball: { x: number; y: number; z: number }; players: { vx: number; vz: number }[] };
        const rs = window.__dotkickRendererStats!();
        const o = { x: 0, y: 0 };
        d.app.renderer.projector.pitchToScreen(s.ball.x, s.ball.y, s.ball.z, o);
        const running = s.players.filter((p) => Math.hypot(p.vx, p.vz) > 2).length;
        return { tick: s.tick, phase: s.match.phase, drawCalls: rs.drawCalls, triangles: rs.triangles, resolutionScale: rs.resolutionScale, qualityTier: rs.qualityTier, ball: [o.x, o.y], running };
      });
      matchStats.push(st);
      await shot(page, `match-${n}.png`);
      const cx = Math.max(0, Math.min(1180 - 400, Math.round(st.ball[0]! - 200)));
      const cy = Math.max(0, Math.min(820 - 280, Math.round(st.ball[1]! - 170)));
      const crop = await page.screenshot({ style: CANVAS_ONLY, clip: { x: cx, y: cy, width: 400, height: 280 } });
      save(`match-${n}-crop-raw.png`, crop);
      // 2x nearest upscale of the crop so the broadcast-size players can be inspected.
      const up = await page.evaluate(async (b64) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const cv = document.createElement('canvas');
        cv.width = img.width * 2; cv.height = img.height * 2;
        const g = cv.getContext('2d')!;
        g.imageSmoothingEnabled = false;
        g.drawImage(img, 0, 0, cv.width, cv.height);
        return cv.toDataURL('image/png');
      }, crop.toString('base64'));
      save(`match-${n}-crop.png`, dataUrlPng(up));
    }
    stats.match = matchStats;

    // ---------------------------------------------------------------- live close-up strip (full mapper pipeline)
    const fastest = await page.evaluate(() => {
      const s = window.__dotkick!.ctx.session.getState() as unknown as { players: { vx: number; vz: number; active: number }[] };
      let best = 1, bv = -1;
      s.players.forEach((p, i) => { const v = Math.hypot(p.vx, p.vz); if (p.active === 1 && i !== 0 && i !== 11 && v > bv) { bv = v; best = i; } });
      return { slot: best, speed: bv };
    });
    stats.live = fastest;
    await newSheet(page, 8, 1);
    const liveLabels: string[] = [];
    for (let k = 0; k < 8; k++) {
      const sp = await page.evaluate(([slot, crop, cell, kk]) => {
        const d = window.__dotkick!;
        const w = window as unknown as { __lookNow: number; __lookSheet: HTMLCanvasElement };
        const P = window.__dotkickPlayers!;
        P.closeUp(slot, 6.5, 90, 1.0);
        for (let i = 0; i < 3; i++) { w.__lookNow += 1000 / 60; d.app.loop.frame(w.__lookNow); }
        const gl = document.getElementById('game') as HTMLCanvasElement;
        const kx = gl.width / window.innerWidth, ky = gl.height / window.innerHeight;
        w.__lookSheet.getContext('2d')!.drawImage(gl, crop.x * kx, crop.y * ky, crop.w * kx, crop.h * ky, kk * cell.w, 0, cell.w, cell.h);
        const p = (d.ctx.session.getState() as unknown as { players: { vx: number; vz: number }[] }).players[slot]!;
        return Math.hypot(p.vx, p.vz);
      }, [fastest.slot, CROP, CELL, k] as const);
      liveLabels.push(`+${k * 50}ms ${sp.toFixed(1)}m/s`);
    }
    save('live-run-sheet.png', await sheetPng(page, liveLabels));
    await page.evaluate(() => window.__dotkickPlayers!.closeUp(-1));

    // ---------------------------------------------------------------- held-clip close-ups
    /** Close-up cameras: distance (m), angle from the player's front (deg, 90 = from his right), eye height (m). */
    const views = { side: [6.5, 90, 1.0], q34: [6.5, 35, 1.3] } as const;
    for (const [who, slot] of [['outfield', OUTFIELD], ['keeper', KEEPER]] as const) {
      await stage(page, [[slot, 0, 0]]);
      // Idle: front, three-quarter (full body).
      await holdAndGrab(page, slot, [A.IDLE, 0.3, 0, 0, 1, 0], [6.2, 0, 1.2], null);
      await shot(page, `${who}-idle-front.png`);
      await holdAndGrab(page, slot, [A.IDLE, 0.3, 0, 0, 1, 0], [6.2, 35, 1.3], null);
      await shot(page, `${who}-idle-34.png`);
      if (slot === KEEPER) {
        await holdAndGrab(page, slot, [A.KEEPER_READY, 0, 0, 0, 1, 0], [6.2, 35, 1.3], null);
        await shot(page, 'keeper-ready-34.png');
      }
      // Front and back views, idle pose: close and raised (the close-up looks at 1 m, so a high eye keeps the head in
      // frame: face, collar, number), and the full back at eye level.
      // The raised view's frustum misses the ball under his feet: hide it inside the chest meanwhile.
      await setBallY(page, 1.2);
      await holdAndGrab(page, slot, [A.IDLE, 0.3, 0, 0, 1, 0], [4.4, 0, 2.6], null);
      await shot(page, `${who}-front.png`);
      await holdAndGrab(page, slot, [A.IDLE, 0.3, 0, 0, 1, 0], [4.4, 180, 2.6], null);
      await shot(page, `${who}-back.png`);
      await setBallY(page, -0.12);
      await holdAndGrab(page, slot, [A.IDLE, 0.3, 0, 0, 1, 0], [6.2, 180, 1.2], null);
      await shot(page, `${who}-back-full.png`);
      // Turn lean: sprint style, turning right at 2.5 rad/s, 7 m/s; from the front at mid-stance, from behind mid-flight.
      await holdAndGrab(page, slot, [A.TURN_LEAN, 0, 0, 7, 2.5, 1], [6.5, 0, 1.0], null);
      await shot(page, `${who}-turn-lean-front.png`);
      await holdAndGrab(page, slot, [A.TURN_LEAN, 0, Math.PI / 2, 7, 2.5, 1], [6.5, 180, 1.0], null);
      await shot(page, `${who}-turn-lean-back.png`);
      // Run cycles: 8 phases x (side, three-quarter front).
      for (const [name, anim, speed] of [['jog', A.JOG, JOG_SPEED], ['sprint', A.SPRINT, SPRINT_SPEED]] as const) {
        await newSheet(page, PHASES, 2);
        const labels: string[] = [];
        for (const [row, vname] of [[0, 'side'], [1, 'q34']] as const) {
          const v = views[vname];
          for (let k = 0; k < PHASES; k++) {
            const cyc = (k * 2 * Math.PI) / PHASES;
            const url = await holdAndGrab(page, slot, [anim, 0, cyc, speed, 1, 0], [v[0], v[1], v[2]], [k, row]);
            save(`${who}-${name}-${vname === 'side' ? 'side' : '34'}-p${k}.png`, dataUrlPng(url));
            labels[row * PHASES + k] = `${name} ${vname} ${k}/8`;
          }
        }
        save(`${who}-${name}-sheet.png`, await sheetPng(page, labels));
      }
      await page.evaluate((s) => window.__dotkickPlayers!.holdPose(s, null), slot);
    }
    await page.evaluate(() => window.__dotkickPlayers!.closeUp(-1));
    save('stats.json', Buffer.from(JSON.stringify(stats, null, 2)));
  });
});
