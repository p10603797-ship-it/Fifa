/**
 * [NET-07 / INT-08] e2e helpers for online play without the public network: an in-page NetTransport over
 * BroadcastChannel (two pages of one browser context talk like two devices) installed through the online screen's test
 * hook window.__dotkickNetTest, plus small navigation helpers. Nothing here touches the PeerJS broker.
 *
 * The fake follows the NetTransport contract (src/net/types.ts): open('host') waits for a guest; open('guest') dials
 * and rejects 'code-not-found' when nobody answers, 'room-full' when the host already has a guest; a heartbeat makes a
 * vanished page read as 'disconnected' after 10 s; reconnect() re-dials (guest) or waits (host). Set
 * window.__dotkickNetTest.failOpen = '<reason>' to make the next open() fail with that reason (error screens).
 */
import { expect, type Page } from '@playwright/test';

export const ROOM_CODE = 'KQZ7MP';

/** Chromium's own messages about the container's software GPU (not from page scripts). */
export const GPU_ENVIRONMENT_NOISE = [/GL Driver Message/, /Automatic fallback to software WebGL/, /GroupMarkerNotSet/];

export function collectConsole(page: Page): string[] {
  const out: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (GPU_ENVIRONMENT_NOISE.some((re) => re.test(text))) return;
    out.push(`${m.type()}: ${text}`);
  });
  page.on('pageerror', (e) => out.push(`pageerror: ${e.message}`));
  return out;
}

interface HookOptions {
  code: string;
  failOpen?: string;
  startCountdownMs?: number;
}

/** Runs in the page before the app (addInitScript): defines the BroadcastChannel transport and the hook. */
function installFakeTransport(opts: HookOptions): void {
  type Fn = (v: unknown) => void;
  type Wait = { resolve: () => void; reject: (e: Error) => void } | null;
  const FRAME_INTS = 19;
  /** Silence that reads as a drop (the container's software WebGL can block a page for seconds while loading). */
  const SILENCE_MS = 10_000;
  const w = window as unknown as { __dotkickNetTest?: Record<string, unknown> };
  function makeTransport(): unknown {
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    let state = 'idle';
    let role: string | null = null;
    let peerId: string | null = null;
    let ch: BroadcastChannel | null = null;
    let closedByUser = false;
    let openWait: Wait = null;
    let reconnectWait: Wait = null;
    let lastHeard = 0;
    let hbTimer: ReturnType<typeof setInterval> | null = null;
    const L: Record<string, Fn[]> = { inputs: [], reliable: [], events: [] };
    const emit = (k: string, v: unknown): void => {
      for (const f of L[k]!.slice()) {
        try {
          f(v);
        } catch (e) {
          console.error(e);
        }
      }
    };
    const post = (m: Record<string, unknown>): void => {
      if (ch) ch.postMessage({ ...m, from: id });
    };
    const settle = (err: Error | null): void => {
      const ws = [openWait, reconnectWait];
      openWait = null;
      reconnectWait = null;
      for (const x of ws) {
        if (!x) continue;
        if (err) x.reject(err);
        else x.resolve();
      }
    };
    const up = (): void => {
      state = 'open';
      lastHeard = performance.now();
      emit('events', { type: 'connected' });
      settle(null);
    };
    const down = (): void => {
      if (state !== 'open') return;
      peerId = null;
      state = role === 'host' ? 'connecting' : 'closed';
      emit('events', { type: 'disconnected', reason: 'disconnected' });
    };
    const fail = (reason: string): void => {
      state = 'failed';
      emit('events', { type: 'error', reason });
      settle(new Error(reason));
    };
    const dial = (): void => {
      state = 'connecting';
      post({ k: 'dial' });
      setTimeout(() => {
        if (state === 'connecting' && role === 'guest') {
          if (reconnectWait && !openWait) {
            state = 'closed';
            const x = reconnectWait;
            reconnectWait = null;
            x.reject(new Error('code-not-found'));
          } else fail('code-not-found');
        }
      }, 1200);
    };
    const onMsg = (ev: MessageEvent): void => {
      const m = ev.data as Record<string, unknown>;
      if (!m || m.from === id || (m.to && m.to !== id)) return;
      if (m.from === peerId) lastHeard = performance.now();
      switch (m.k) {
        case 'dial':
          if (role !== 'host' || closedByUser) return;
          if (state === 'open' && peerId && m.from === peerId) {
            post({ k: 'accept', to: m.from }); // the same guest re-dialing after it noticed a drop first
            return;
          }
          if (state === 'open' && peerId) {
            post({ k: 'full', to: m.from });
            return;
          }
          if (state !== 'connecting') return;
          peerId = m.from as string;
          post({ k: 'accept', to: m.from });
          up();
          break;
        case 'accept':
          if (role !== 'guest' || state !== 'connecting') return;
          peerId = m.from as string;
          up();
          break;
        case 'full':
          if (role !== 'guest' || state !== 'connecting') break;
          if (reconnectWait && !openWait) {
            state = 'closed'; // a re-dial the host refused for now: retryable
            const x = reconnectWait;
            reconnectWait = null;
            x.reject(new Error('room-full'));
          } else fail('room-full');
          break;
        case 'in':
          if (m.from === peerId && state === 'open') emit('inputs', m.p);
          break;
        case 'rel':
          if (m.from === peerId && state === 'open') emit('reliable', m.p);
          break;
        case 'bye':
          if (m.from === peerId) down();
          break;
        default:
          break;
      }
    };
    const t = {
      get state() { return state; },
      get role() { return role; },
      get rtt() { return state === 'open' ? 16 : 0; },
      get jitter() { return state === 'open' ? 2 : 0; },
      open(r: string, code: string): Promise<void> {
        role = r;
        const hook = w.__dotkickNetTest ?? {};
        const forced = hook.failOpen as string | undefined;
        return new Promise<void>((resolve, reject) => {
          openWait = { resolve, reject };
          if (forced) {
            setTimeout(() => fail(forced), 80);
            return;
          }
          ch = new BroadcastChannel(`dk-room-${code}`);
          ch.onmessage = onMsg;
          hbTimer = setInterval(() => {
            if (state !== 'open') return;
            post({ k: 'hb', to: peerId });
            if (performance.now() - lastHeard > SILENCE_MS) down();
          }, 400);
          if (r === 'host') state = 'connecting';
          else dial();
        });
      },
      reconnect(): Promise<void> {
        if (state === 'open') return Promise.resolve();
        if (closedByUser || role === null || state === 'failed') return Promise.reject(new Error('disconnected'));
        return new Promise<void>((resolve, reject) => {
          reconnectWait = { resolve, reject };
          if (role === 'guest') dial();
        });
      },
      sendInputs(p: { firstTick: number; count: number; ack: number; tick: number; adv: number; data: Int16Array }): void {
        if (state !== 'open') return;
        post({ k: 'in', to: peerId, p: { firstTick: p.firstTick, count: p.count, ack: p.ack, tick: p.tick, adv: p.adv, data: p.data.slice(0, p.count * FRAME_INTS) } });
      },
      sendReliable(m: unknown): void {
        if (state !== 'open') return;
        post({ k: 'rel', to: peerId, p: JSON.parse(JSON.stringify(m)) });
      },
      onInputs(f: Fn) {
        L.inputs!.push(f);
        return () => { L.inputs = L.inputs!.filter((x) => x !== f); };
      },
      onReliable(f: Fn) {
        L.reliable!.push(f);
        return () => { L.reliable = L.reliable!.filter((x) => x !== f); };
      },
      onEvent(f: Fn) {
        L.events!.push(f);
        return () => { L.events = L.events!.filter((x) => x !== f); };
      },
      close(): void {
        if (closedByUser) return;
        if (state === 'open') post({ k: 'bye', to: peerId });
        closedByUser = true;
        state = 'closed';
        if (hbTimer) clearInterval(hbTimer);
        settle(new Error('disconnected'));
        const c = ch;
        ch = null;
        setTimeout(() => c?.close(), 50);
      },
    };
    return t;
  }
  w.__dotkickNetTest = {
    createTransport: () => makeTransport(),
    code: opts.code,
    startCountdownMs: opts.startCountdownMs ?? 300,
    failOpen: opts.failOpen,
  };
}

export async function installNetHook(page: Page, opts: Partial<HookOptions> = {}): Promise<void> {
  await page.addInitScript(installFakeTransport, { code: opts.code ?? ROOM_CODE, failOpen: opts.failOpen, startCountdownMs: opts.startCountdownMs });
}

export const route = (page: Page): Promise<string | null> => page.evaluate(() => window.__dotkick?.ctx.router.current ?? null);
export const focused = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector<HTMLElement>('[data-focused]')?.dataset.testid ?? null);

/** Wait for n animation frames. */
export async function frames(page: Page, n = 2): Promise<void> {
  await page.evaluate((k) => new Promise<void>((res) => {
    let left = k;
    const step = (): void => { if (--left <= 0) res(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }), n);
}

/** Splash -> main menu by touch. */
export async function bootToMain(page: Page, path = '/'): Promise<void> {
  await page.goto(path);
  await expect(page.getByTestId('splash-start')).toBeVisible();
  await page.getByTestId('splash-start').click();
  await expect.poll(() => route(page)).toBe('main');
}

/** Main menu -> Play a Friend -> Online (the real menu path). */
export async function openOnlineFromMenu(page: Page): Promise<void> {
  await page.getByTestId('main-friend').click();
  await expect.poll(() => route(page)).toBe('mode-setup');
  await page.getByTestId('mode-friend-online').click();
  await expect.poll(() => route(page)).toBe('online-lobby');
}

export const onlineState = (page: Page): Promise<{ phase: string | null; status: string | null; code: string | null }> =>
  page.evaluate(() => {
    const o = window.__dotkickOnline;
    return { phase: o?.phase() ?? null, status: o?.status() ?? null, code: o?.code() ?? null };
  });

export const simTick = (page: Page): Promise<number> => page.evaluate(() => window.__dotkick?.ctx.session.getState()?.tick ?? -1);
