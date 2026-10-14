/**
 * [NET-03] Room codes and share links (brief section 11: "the host taps Create Room and gets a 6-character code and a
 * share link. The friend enters the code or opens the link").
 *
 *   generateRoomCode(Math.random)            'K7QWMZ'      (randomRoomCode() uses crypto.getRandomValues when present)
 *   normaliseRoomCode(' k7q-wmz ')           'K7QWMZ'      (null for anything that is not a valid code)
 *   roomLink('K7QWMZ', location.href)        'https://dotkick.app/play/?room=K7QWMZ'
 *   roomCodeFromUrl(location.href)           'K7QWMZ' or null (the app checks this on boot to auto-join)
 *   urlWithoutRoom(location.href)            the same page without ?room= (after leaving a room)
 *
 * Codes are 6 characters from an unambiguous alphabet: no 0/O, no 1/I/L, so a code read aloud or typed from a
 * screenshot cannot be mistyped into another valid code. Typed input is upper-cased and spaces, dashes, dots and
 * underscores are dropped; the ambiguous characters are never part of a code, so input containing them is rejected
 * (normaliseRoomCode returns null) rather than guessed. A pasted share link is accepted in the code field too.
 * 31^6 = 887 million codes; collisions on the broker surface as 'code-taken' and the lobby picks a new code.
 * Pure functions, no DOM: importing this file never touches the network.
 */

/** Unambiguous code alphabet (no 0/O, 1/I/L): 23 letters and 8 digits. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_CODE_LENGTH = 6;
/** Query parameter of share links: `<origin><path>?room=CODE`. */
export const ROOM_PARAM = 'room';

/** Characters people put between groups ("ABC DEF", "ABC-DEF"); dropped by normaliseRoomCode. */
const SEPARATORS = /[\s\-_.·]+/g;

/** New random room code; `random` returns [0, 1) (values outside are clamped). */
export function generateRoomCode(random: () => number): string {
  const n = ROOM_CODE_ALPHABET.length;
  let out = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const r = random();
    let idx = Number.isFinite(r) ? Math.floor(r * n) : 0;
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    out += ROOM_CODE_ALPHABET[idx]!;
  }
  return out;
}

/** A uniform random number in [0, 1) from crypto.getRandomValues (Math.random when crypto is missing). */
export function secureRandom(): number {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint32Array) => Uint32Array } }).crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const a = new Uint32Array(1);
    c.getRandomValues(a);
    return a[0]! / 4294967296;
  }
  return Math.random();
}

/** A new room code from the platform's secure random source. */
export function randomRoomCode(): string {
  return generateRoomCode(secureRandom);
}

/** True when `s` is exactly a valid code (no normalisation). */
export function isRoomCode(s: unknown): s is string {
  if (typeof s !== 'string' || s.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < s.length; i++) if (!ROOM_CODE_ALPHABET.includes(s[i]!)) return false;
  return true;
}

/** True when `ch` (one character, any case) can appear in a code: keypads and keyboard handlers use it. */
export function isRoomCodeChar(ch: string): boolean {
  return ch.length === 1 && ROOM_CODE_ALPHABET.includes(ch.toUpperCase());
}

/**
 * Normalise user input to a valid code (upper case, separators dropped) or null. A pasted share link (anything with
 * `room=`) yields the code it carries.
 */
export function normaliseRoomCode(input: string): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/room=/i.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return roomCodeFromUrl(trimmed);
  const s = trimmed.replace(SEPARATORS, '').toUpperCase();
  return isRoomCode(s) ? s : null;
}

/** "ABCDEF" -> "ABC DEF" for display (partial codes too: "ABCD" -> "ABC D"). */
export function formatRoomCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

function parseUrl(pageUrl: string): URL | null {
  try {
    return new URL(pageUrl);
  } catch {
    try {
      return new URL(pageUrl, 'http://localhost/');
    } catch {
      return null;
    }
  }
}

/**
 * Share link for a code, relative to the current page URL: `<origin><path>?room=CODE` (other query parameters and
 * the hash are dropped, so the link shows nothing but the code). Throws RangeError for an invalid code.
 */
export function roomLink(code: string, pageUrl: string): string {
  const c = normaliseRoomCode(code);
  if (!c) throw new RangeError(`roomLink: invalid room code ${JSON.stringify(code)}`);
  const u = parseUrl(pageUrl);
  if (!u || u.origin === 'null') return `?${ROOM_PARAM}=${c}`;
  return `${u.origin}${u.pathname}?${ROOM_PARAM}=${c}`;
}

/** Room code carried in a page URL (share link: `?room=CODE`, also `#room=CODE`), or null. */
export function roomCodeFromUrl(pageUrl: string): string | null {
  if (typeof pageUrl !== 'string' || pageUrl.length === 0) return null;
  const u = parseUrl(pageUrl);
  if (!u) return null;
  const fromQuery = u.searchParams.get(ROOM_PARAM);
  if (fromQuery !== null) return normaliseCodeOnly(fromQuery);
  const hash = u.hash.replace(/^#\/?/, '');
  if (hash.length > 0) {
    const hp = new URLSearchParams(hash.replace(/^\?/, ''));
    const fromHash = hp.get(ROOM_PARAM);
    if (fromHash !== null) return normaliseCodeOnly(fromHash);
  }
  return null;
}

function normaliseCodeOnly(v: string): string | null {
  const s = v.trim().replace(SEPARATORS, '').toUpperCase();
  return isRoomCode(s) ? s : null;
}

/** The page URL without the room parameter (query and hash forms), for history.replaceState after leaving a room. */
export function urlWithoutRoom(pageUrl: string): string {
  const u = parseUrl(pageUrl);
  if (!u) return pageUrl;
  u.searchParams.delete(ROOM_PARAM);
  if (/(^#\/?|&)room=/i.test(u.hash)) {
    const hp = new URLSearchParams(u.hash.replace(/^#\/?\??/, ''));
    hp.delete(ROOM_PARAM);
    const rest = hp.toString();
    u.hash = rest.length > 0 ? `#${rest}` : '';
  }
  return u.toString();
}
