/**
 * [GATE] Password lock, pure logic (D-047). The UI is src/ui/screens/gate.ts; src/main.ts runs boot() only once the
 * lock is open, so nothing of the game (splash, menus, a `?room=` / `#room=` join link, `?bench=1`) runs before.
 *
 * - A code is 12 characters from CODE_ALPHABET, shown as XXXX-XXXX-XXXX. What the player types is normalised
 *   (normaliseCode: upper case, every character that is not A-Z or 0-9 removed), so "abcd efgh jkmn" and
 *   "ABCD-EFGH-JKMN" are the same code.
 * - Only hashes are shipped (src/data/gateCodes.ts): lowercase hex SHA-256 of the UTF-8 string GATE_HASH_PREFIX +
 *   normalised code. crypto.subtle when the page is a secure context, else the plain-TypeScript fallback
 *   (src/app/sha256.ts; plain http on a LAN address).
 * - Single use is per device: the device remembers the hashes it has redeemed (GATE_USED_KEY) and refuses them again
 *   ('used'), even after the unlock record itself is gone. There is no server, and this module makes no network
 *   request. The redeem step is behind CodeRedeemer, so an online checker that makes a code single-use across every
 *   device can replace createLocalRedeemer later ('offline-error' is its "could not reach the checker" answer).
 * - Once a code is accepted the unlock record (GATE_UNLOCK_KEY) is written and every later start goes straight in.
 *   When storage cannot keep it (private browsing, site data blocked) the game still opens for this session and the
 *   screen says so (UnlockOutcome.remembered false).
 * - Storage is src/platform/storage.ts safe storage (never throws; memory fallback). Malformed stored values count
 *   as "locked" (unlock record) or "nothing redeemed" (used list: only well-formed hashes are kept).
 *
 * Test hook (e2e, never set in production): window.__dotkickGateTest = { hashes: [...] } set before the page script
 * runs (an init script) adds accepted hashes, so e2e can unlock with its own test codes (tests/e2e/gate-harness.ts).
 * Like any lock that runs only in the browser, a technical person with a computer can get past it (developer tools);
 * see README "Password lock".
 */
import { GAME_NAME } from '../contracts/constants';
import type { KeyValueStorage } from '../platform/storage';
import { sha256HexFallback, toHex, utf8 } from './sha256';

/** Hash input prefix: hash = SHA-256(GATE_HASH_PREFIX + normalised code). Changing it invalidates every code. */
export const GATE_HASH_PREFIX = 'dotkick-gate-v1:';
/** Storage key of the unlock record ({ v: 1, at: epoch ms }). */
export const GATE_UNLOCK_KEY = 'dotkick.gate.unlock.v1';
/** Storage key of the redeemed hashes on this device ({ v: 1, used: [hash, ...] }). */
export const GATE_USED_KEY = 'dotkick.gate.used.v1';
/** Code alphabet (no I, L, O, 0 or 1, which are easy to misread). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Characters in a code (shown in groups of four). */
export const CODE_LENGTH = 12;

const HASH_RE = /^[0-9a-f]{64}$/;

/** Texts shown by the lock screen (src/ui/screens/gate.ts; tests read them). */
export const GATE_TEXT = {
  prompt: `Enter your password to unlock ${GAME_NAME}`,
  wrong: "That password doesn't work. Check it and try again.",
  used: 'That password has already been used.',
  offline: "Couldn't check the password. Check your internet connection and try again.",
  empty: 'Type your password, then tap Unlock.',
  checking: 'Checking…',
  notRemembered:
    'Unlocked for now. This browser will not remember it (private browsing or website data turned off), so you will ' +
    'need a password again next time.',
} as const;

/** Answer of one redeem attempt. 'offline-error': an online checker could not be reached (never from the local one). */
export type RedeemResult = 'ok' | 'wrong' | 'used' | 'offline-error';

/** The step that decides whether a code opens the game (local now; an online checker can be plugged in later). */
export interface CodeRedeemer {
  redeem(code: string): Promise<RedeemResult>;
}

/** Hex SHA-256 of a UTF-8 string. */
export type Digest = (text: string) => Promise<string>;

/** Upper case, every character that is not A-Z or 0-9 removed. Pure. */
export function normaliseCode(input: string): string {
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** A normalised code as XXXX-XXXX-XXXX (groups of four). Pure. */
export function formatCode(code: string): string {
  const n = normaliseCode(code);
  return n.replace(/(.{4})(?=.)/g, '$1-');
}

/** True for a lowercase 64-digit hex string. Pure. */
export function isGateHash(v: unknown): v is string {
  return typeof v === 'string' && HASH_RE.test(v);
}

interface SubtleLike {
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
}

/** crypto.subtle when this page has it (secure contexts only), else null. */
function getSubtle(): SubtleLike | null {
  try {
    const c = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto;
    const s = c?.subtle;
    return s && typeof s.digest === 'function' ? s : null;
  } catch {
    return null;
  }
}

/** Digest via crypto.subtle (null when it is missing). */
export function subtleDigest(): Digest | null {
  const s = getSubtle();
  if (!s) return null;
  return async (text) => toHex(new Uint8Array(await s.digest('SHA-256', utf8(text))));
}

/** The plain-TypeScript digest (always available). */
export const fallbackDigest: Digest = (text) => Promise.resolve(sha256HexFallback(text));

/** crypto.subtle when available, else the fallback; a subtle digest that rejects falls back too. */
export function defaultDigest(): Digest {
  const subtle = subtleDigest();
  if (!subtle) return fallbackDigest;
  return async (text) => {
    try {
      return await subtle(text);
    } catch {
      return sha256HexFallback(text);
    }
  };
}

/** The hash a code is stored under (src/data/gateCodes.ts). */
export function hashCode(code: string, digest: Digest = defaultDigest()): Promise<string> {
  return digest(GATE_HASH_PREFIX + normaliseCode(code));
}

/** Unlock record as stored under GATE_UNLOCK_KEY. */
export interface UnlockRecord {
  v: 1;
  /** When the device was unlocked, epoch ms. */
  at: number;
}

/** The stored unlock record, or null when missing or malformed (malformed = locked). Pure. */
export function parseUnlockRecord(raw: string | null): UnlockRecord | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as { v?: unknown; at?: unknown };
  if (r.v !== 1 || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  return { v: 1, at: r.at };
}

/** JSON of an unlock record (also what the e2e harness seeds). Pure. */
export function unlockRecordJson(at: number): string {
  return JSON.stringify({ v: 1, at } satisfies UnlockRecord);
}

/** Redeemed hashes stored under GATE_USED_KEY; anything malformed is dropped. Pure. */
export function parseUsedList(raw: string | null): string[] {
  if (raw === null) return [];
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof v !== 'object' || v === null) return [];
  const list = (v as { used?: unknown }).used;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const h of list) if (isGateHash(h) && !out.includes(h)) out.push(h);
  return out;
}

export interface LocalRedeemerOptions {
  storage: KeyValueStorage;
  /** Accepted hashes (src/data/gateCodes.ts, plus test hashes). Malformed entries are ignored. */
  hashes: readonly string[];
  digest?: Digest;
}

/**
 * Redeemer that checks the shipped hashes and remembers redeemed ones on this device. A code is 'wrong' when its
 * hash is not accepted, 'used' when this device has redeemed it before, else 'ok' (and it is recorded as used).
 * Attempts run one at a time, so two quick submits of one code never both pass.
 */
export function createLocalRedeemer(opts: LocalRedeemerOptions): CodeRedeemer {
  const accepted = new Set(opts.hashes.filter(isGateHash));
  const digest = opts.digest ?? defaultDigest();
  const storage = opts.storage;
  let queue: Promise<unknown> = Promise.resolve();
  const attempt = async (code: string): Promise<RedeemResult> => {
    const n = normaliseCode(code);
    if (n.length === 0) return 'wrong';
    const h = await hashCode(n, digest);
    if (!accepted.has(h)) return 'wrong';
    const used = parseUsedList(storage.get(GATE_USED_KEY));
    if (used.includes(h)) return 'used';
    used.push(h);
    storage.set(GATE_USED_KEY, JSON.stringify({ v: 1, used }));
    return 'ok';
  };
  return {
    redeem(code) {
      const p = queue.then(() => attempt(code));
      queue = p.catch(() => undefined);
      return p;
    },
  };
}

/** What one unlock attempt gave. */
export interface UnlockOutcome {
  result: RedeemResult;
  /** True when the unlock was written to storage that survives a reload (only meaningful for 'ok'). */
  remembered: boolean;
}

export interface Gate {
  /** True when this device holds a valid unlock record (sync: boot does not wait). */
  isUnlocked(): boolean;
  /** Redeem a code; on 'ok' the unlock record is written. Never rejects (a failing redeemer counts as offline-error). */
  unlock(code: string): Promise<UnlockOutcome>;
}

export interface GateOptions {
  storage: KeyValueStorage;
  redeemer: CodeRedeemer;
  /** Clock for the unlock record (tests). Default Date.now. */
  now?: () => number;
}

export function createGate(opts: GateOptions): Gate {
  const { storage, redeemer } = opts;
  const now = opts.now ?? (() => Date.now());
  return {
    isUnlocked() {
      return parseUnlockRecord(storage.get(GATE_UNLOCK_KEY)) !== null;
    },
    async unlock(code) {
      let result: RedeemResult;
      try {
        result = await redeemer.redeem(code);
      } catch {
        result = 'offline-error';
      }
      if (result !== 'ok') return { result, remembered: false };
      const wrote = storage.set(GATE_UNLOCK_KEY, unlockRecordJson(now()));
      return { result, remembered: wrote && storage.persistent };
    },
  };
}

/** Test hook shape (see the file header). */
export interface GateTestHook {
  hashes?: readonly string[];
}

declare global {
  interface Window {
    /** e2e only: extra accepted hashes, set by an init script before the page runs. Never set in production. */
    __dotkickGateTest?: GateTestHook;
  }
}

/** Shipped hashes plus the test hook's (when an e2e init script set it). */
export function acceptedHashes(shipped: readonly string[]): string[] {
  const out = shipped.filter(isGateHash);
  try {
    const hook = typeof window !== 'undefined' ? window.__dotkickGateTest : undefined;
    const extra = hook && Array.isArray(hook.hashes) ? hook.hashes : [];
    for (const h of extra) if (isGateHash(h) && !out.includes(h)) out.push(h);
  } catch {
    /* a broken hook adds nothing */
  }
  return out;
}
