/**
 * [GATE] Online password checker client (D-048): a CodeRedeemer that asks the checker (server/gate-worker/worker.js,
 * URL in src/data/gateConfig.ts), so a password works once across every device.
 *
 * - redeem(code): an empty code is 'wrong' and a code this device has redeemed before is 'used', both without a
 *   request. Otherwise one POST to the checker with { code (normalised), device } and the answer
 *   { result: 'ok' | 'used' | 'wrong' }. A network error, a timeout (timeoutMs), any status but 200 and any other body
 *   are 'offline-error' ("Couldn't check the password. Connect to the internet and try again.").
 * - device: a random id (128 bits, 32 lowercase hex digits) made once and stored under GATE_DEVICE_KEY BEFORE the
 *   first request. The checker answers 'ok' again to the device that used a code, so when an answer is lost on a bad
 *   connection, trying again on the same device still opens the game instead of burning the code.
 * - After 'ok' the code's hash goes into this device's used list (as with the local redeemer), so this device refuses
 *   it again without asking the checker, even offline.
 * - The request is a CORS "simple" request (text/plain body, no custom headers), so the browser sends no preflight:
 *   one round trip on a slow connection. No cookies or credentials, no referrer (a share link's room code stays on
 *   the page). Attempts run one at a time.
 */
import type { KeyValueStorage } from '../platform/storage';
import {
  GATE_DEVICE_KEY, defaultDigest, hashCode, isUsedHere, normaliseCode, rememberUsed, type CodeRedeemer, type Digest, type RedeemResult,
} from './gate';

const DEVICE_RE = /^[0-9a-f]{32}$/;

export interface OnlineRedeemerOptions {
  /** The checker's redeem URL (GATE_SERVER_URL). */
  url: string;
  storage: KeyValueStorage;
  /** Default: the global fetch. */
  fetch?: typeof fetch;
  /** Give up after this long, ms. Default 10000. */
  timeoutMs?: number;
  digest?: Digest;
  /** Random bytes for the device id (tests). Default crypto.getRandomValues. */
  randomBytes?: (n: number) => Uint8Array;
}

function cryptoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256); // no Web Crypto at all (never on iPad Safari)
  return out;
}

/** This device's id for the checker: the stored one, or a new one stored first. */
export function deviceId(storage: KeyValueStorage, randomBytes: (n: number) => Uint8Array = cryptoRandomBytes): string {
  const stored = storage.get(GATE_DEVICE_KEY);
  if (stored !== null && DEVICE_RE.test(stored)) return stored;
  let id = '';
  for (const b of randomBytes(16)) id += (b & 0xff).toString(16).padStart(2, '0');
  storage.set(GATE_DEVICE_KEY, id);
  return id;
}

/** The checker's answer, or 'offline-error' for anything else. Pure. */
export function parseCheckerAnswer(status: number, body: unknown): RedeemResult {
  if (status !== 200 || typeof body !== 'object' || body === null) return 'offline-error';
  const r = (body as { result?: unknown }).result;
  return r === 'ok' || r === 'used' || r === 'wrong' ? r : 'offline-error';
}

export function createOnlineRedeemer(opts: OnlineRedeemerOptions): CodeRedeemer {
  const { url, storage } = opts;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const digest = opts.digest ?? defaultDigest();
  const randomBytes = opts.randomBytes ?? cryptoRandomBytes;
  const fetchFn: typeof fetch | null = opts.fetch ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

  const ask = async (code: string, device: string): Promise<RedeemResult> => {
    if (!fetchFn) return 'offline-error';
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((res) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        res('timeout');
      }, timeoutMs);
    });
    const request = (async (): Promise<RedeemResult> => {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ code, device }),
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: ctrl?.signal,
      });
      if (res.status !== 200) return 'offline-error';
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return 'offline-error';
      }
      return parseCheckerAnswer(res.status, body);
    })().catch((): RedeemResult => 'offline-error');
    try {
      const first = await Promise.race([request, timeout]);
      return first === 'timeout' ? 'offline-error' : first;
    } finally {
      clearTimeout(timer);
    }
  };

  const attempt = async (input: string): Promise<RedeemResult> => {
    const code = normaliseCode(input);
    if (code.length === 0) return 'wrong';
    const h = await hashCode(code, digest);
    if (isUsedHere(storage, h)) return 'used';
    const device = deviceId(storage, randomBytes); // stored before the request
    const result = await ask(code, device);
    if (result === 'ok') rememberUsed(storage, h);
    return result;
  };

  let queue: Promise<unknown> = Promise.resolve();
  return {
    redeem(code) {
      const p = queue.then(() => attempt(code));
      queue = p.catch(() => undefined);
      return p;
    },
  };
}
