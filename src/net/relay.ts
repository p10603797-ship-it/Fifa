/**
 * [NET-FIX, D-044] Optional TURN relay configured at run time, with no rebuild: a `relay.json` file next to index.html.
 *
 * Without a relay, two devices that cannot reach each other directly (mobile data / carrier-grade NAT, many guest and
 * office networks) never connect ('blocked'). There is no free public TURN relay without an account, so the build ships
 * none (src/net/config.ts); the person who publishes the game can add one by dropping this file beside index.html:
 *
 *   { "iceServers": [{ "urls": "turn:relay.example.com:3478", "username": "u", "credential": "p" }] }
 *       the servers are appended to the STUN list for this room;
 *   { "credentialsUrl": "https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>" }
 *       an https URL that answers a JSON array of RTCIceServer (Metered's format) or { "iceServers": [...] }; it is
 *       fetched each time a room opens, so short-lived credentials stay fresh.
 *
 * The online screen calls loadRelay() when it creates or joins a room. relay.json is fetched from the page's own
 * directory (same origin, cache 'no-store', RELAY_TIMEOUT_MS); the credentials URL with the same timeout and no
 * cookies. Everything is validated strictly (validateIceServers: only stun: / turn: / turns: URLs, string username and
 * credential, TURN entries must carry both, at most MAX_RELAY_SERVERS servers); anything malformed is dropped and
 * logged to diagnostics. A missing file (404, the default deploy), a network error or a timeout means "no relay" and
 * never stops the room from opening. The service worker never answers relay.json from its cache (public/sw.js).
 *
 * The key in a Metered credentials URL is meant for browsers (it only mints short-lived TURN credentials); it lives in
 * the deployed relay.json, never in this repository.
 */

/** The file name, resolved against the page URL (same directory as index.html). */
export const RELAY_FILE = 'relay.json';
/** Each fetch (relay.json, then the credentials URL) gives up after this, ms. */
export const RELAY_TIMEOUT_MS = 3000;
/** At most this many ICE servers are taken from a relay config (the rest is ignored and logged). */
export const MAX_RELAY_SERVERS = 10;
/** At most this many URLs per server entry. */
export const MAX_URLS_PER_SERVER = 6;
const MAX_URL_CHARS = 512;
const MAX_SECRET_CHARS = 512;

/** What loadRelay found. */
export interface RelayConfig {
  /** Validated servers to append to the STUN list for this room (empty: no relay). */
  iceServers: RTCIceServer[];
  /** Where they came from: 'none' (no file), 'file' (iceServers in relay.json), 'credentials' (the credentials URL). */
  source: 'none' | 'file' | 'credentials';
  /**
   * relay.json asked for a relay (TURN servers, or a credentials URL), whether or not it could be fetched: a blocked
   * connection then reads "the relay could not be reached" rather than "ask for a relay".
   */
  declared: boolean;
  /** Problems found on the way (logged to diagnostics), for tests and the report. */
  problems: string[];
}

export const NO_RELAY: Readonly<RelayConfig> = Object.freeze({ iceServers: [], source: 'none', declared: false, problems: [] }) as Readonly<RelayConfig>;

type Log = (kind: string, message: string, data?: unknown) => void;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A stun: / turn: / turns: URL (RFC 7064 / 7065 shape: scheme, host, optional port and query; no spaces). */
export function isIceUrl(u: unknown): u is string {
  return typeof u === 'string' && u.length <= MAX_URL_CHARS && /^(stun|turns?):[^\s/?#][^\s]*$/i.test(u);
}

/** True when the URL is a TURN relay (turn: / turns:). */
export function isTurnUrl(u: string): boolean {
  return /^turns?:/i.test(u);
}

/** URLs of one RTCIceServer as a list. */
export function serverUrls(s: RTCIceServer): string[] {
  return typeof s.urls === 'string' ? [s.urls] : [...s.urls];
}

/** True when any server in the list is a TURN relay. */
export function hasTurn(servers: readonly RTCIceServer[] | undefined): boolean {
  return !!servers && servers.some((s) => serverUrls(s).some(isTurnUrl));
}

/**
 * Strict validation of an RTCIceServer list from outside the build. Returns the clean servers (only urls, username,
 * credential kept) and one line per problem. A malformed entry is dropped, the rest kept; more than MAX_RELAY_SERVERS
 * entries keep the first ones. A TURN URL without a string username and credential is dropped (a browser would
 * refuse the whole configuration). Pure.
 */
export function validateIceServers(raw: unknown): { servers: RTCIceServer[]; problems: string[] } {
  const problems: string[] = [];
  const servers: RTCIceServer[] = [];
  if (!Array.isArray(raw)) return { servers, problems: ['iceServers is not a list'] };
  let capped = false;
  raw.forEach((entry: unknown, i) => {
    if (servers.length >= MAX_RELAY_SERVERS) {
      if (!capped) problems.push(`more than ${MAX_RELAY_SERVERS} servers: the rest is ignored`);
      capped = true;
      return;
    }
    if (!isRecord(entry)) {
      problems.push(`server ${i}: not an object`);
      return;
    }
    const rawUrls = typeof entry.urls === 'string' ? [entry.urls] : Array.isArray(entry.urls) ? entry.urls as unknown[] : null;
    if (!rawUrls || rawUrls.length === 0 || rawUrls.length > MAX_URLS_PER_SERVER) {
      problems.push(`server ${i}: urls must be a URL or a list of 1-${MAX_URLS_PER_SERVER} URLs`);
      return;
    }
    if (!rawUrls.every(isIceUrl)) {
      problems.push(`server ${i}: only stun:, turn: and turns: URLs are allowed`);
      return;
    }
    const urls = rawUrls as string[];
    const { username, credential } = entry;
    if (username !== undefined && (typeof username !== 'string' || username.length > MAX_SECRET_CHARS)) {
      problems.push(`server ${i}: username must be a string`);
      return;
    }
    if (credential !== undefined && (typeof credential !== 'string' || credential.length > MAX_SECRET_CHARS)) {
      problems.push(`server ${i}: credential must be a string`);
      return;
    }
    if (urls.some(isTurnUrl) && (typeof username !== 'string' || typeof credential !== 'string')) {
      problems.push(`server ${i}: a turn: server needs a username and a credential`);
      return;
    }
    const s: RTCIceServer = { urls: urls.length === 1 ? urls[0]! : urls };
    if (typeof username === 'string') s.username = username;
    if (typeof credential === 'string') s.credential = credential;
    servers.push(s);
  });
  return { servers, problems };
}

/** What a relay.json file asks for. Pure. */
export type RelayFile =
  | { kind: 'servers'; servers: RTCIceServer[]; problems: string[] }
  | { kind: 'credentials'; url: string }
  | { kind: 'invalid'; problem: string };

/** An https URL (the credentials endpoint must be https so a key never travels in clear). */
export function isHttpsUrl(u: unknown): u is string {
  if (typeof u !== 'string' || u.length > 2048) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse the JSON of relay.json: { iceServers: [...] } or { credentialsUrl: 'https://...' }. Pure. */
export function parseRelayFile(raw: unknown): RelayFile {
  if (!isRecord(raw)) return { kind: 'invalid', problem: 'relay.json is not a JSON object' };
  if (raw.credentialsUrl !== undefined) {
    if (!isHttpsUrl(raw.credentialsUrl)) return { kind: 'invalid', problem: 'credentialsUrl must be an https:// URL' };
    return { kind: 'credentials', url: raw.credentialsUrl };
  }
  if (raw.iceServers !== undefined) {
    const v = validateIceServers(raw.iceServers);
    return { kind: 'servers', servers: v.servers, problems: v.problems };
  }
  return { kind: 'invalid', problem: 'relay.json needs "iceServers" or "credentialsUrl"' };
}

/** Parse a credentials endpoint's answer: a JSON array of RTCIceServer, or { iceServers: [...] }. Pure. */
export function parseCredentials(raw: unknown): { servers: RTCIceServer[]; problems: string[] } {
  if (Array.isArray(raw)) return validateIceServers(raw);
  if (isRecord(raw) && raw.iceServers !== undefined) return validateIceServers(raw.iceServers);
  return { servers: [], problems: ['the credentials URL did not answer a list of ICE servers'] };
}

/** `extra` appended to `base` (copies; base undefined counts as empty). Pure. */
export function mergeIceServers(base: readonly RTCIceServer[] | undefined, extra: readonly RTCIceServer[]): RTCIceServer[] {
  return [...(base ?? []), ...extra].map((s) => ({ ...s }));
}

/** The relay.json URL for a page (same directory; query and hash dropped). */
export function relayUrlFor(pageHref: string): string {
  return new URL(RELAY_FILE, pageHref).href;
}

/** A URL without its query string (a credentials URL carries the key there: never logged). */
export function redactUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}${x.search ? '?…' : ''}`;
  } catch {
    return '(invalid URL)';
  }
}

export interface LoadRelayOptions {
  /** relay.json URL (default: beside the page). */
  url?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  log?: Log;
}

async function fetchJson(fetchFn: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; json?: unknown; html?: boolean }> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl?.abort();
      reject(new Error(`no answer within ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([fetchFn(url, { ...init, signal: ctl?.signal }), timeout]);
    if (!res.ok) return { status: res.status };
    const type = res.headers?.get?.('content-type') ?? '';
    // A host that answers missing files with its HTML page (an SPA fallback) has no relay.json either.
    if (/text\/html/i.test(type)) return { status: res.status, html: true };
    const text = await Promise.race([res.text(), timeout]);
    return { status: res.status, json: JSON.parse(text) as unknown };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Fetch and validate the relay for one room. Never rejects: any failure resolves to no (or fewer) servers, with the
 * reason logged to diagnostics under 'net'.
 */
export async function loadRelay(opts: LoadRelayOptions = {}): Promise<RelayConfig> {
  const log = opts.log;
  const timeoutMs = opts.timeoutMs ?? RELAY_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const problems: string[] = [];
  const note = (p: string): void => {
    problems.push(p);
    log?.('net', `relay: ${p}`);
  };
  if (!fetchFn) return { ...NO_RELAY, problems: [] };
  let url: string;
  try {
    url = opts.url ?? relayUrlFor(typeof location !== 'undefined' ? location.href : '');
  } catch {
    return { ...NO_RELAY, problems: [] };
  }
  let file: RelayFile;
  try {
    const r = await fetchJson(fetchFn, url, {
      cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' },
    }, timeoutMs);
    if (r.status === 404 || r.status === 410 || r.html) {
      log?.('net', 'relay: none (no relay.json beside the page; direct connections only)');
      return { ...NO_RELAY, problems: [] };
    }
    if (r.json === undefined) {
      note(`relay.json answered HTTP ${r.status}; ignored`);
      return { ...NO_RELAY, problems };
    }
    file = parseRelayFile(r.json);
  } catch (err) {
    note(`relay.json could not be read (${err instanceof Error ? err.message : String(err)}); ignored`);
    return { ...NO_RELAY, problems };
  }
  if (file.kind === 'invalid') {
    note(`${file.problem}; ignored`);
    return { ...NO_RELAY, problems };
  }
  if (file.kind === 'servers') {
    for (const p of file.problems) note(`relay.json ${p}`);
    const declared = hasTurn(file.servers);
    log?.('net', `relay: ${file.servers.length} server(s) from relay.json${declared ? ' (TURN)' : ' (no TURN)'}`);
    return { iceServers: file.servers, source: file.servers.length > 0 ? 'file' : 'none', declared, problems };
  }
  // credentialsUrl
  try {
    const r = await fetchJson(fetchFn, file.url, {
      cache: 'no-store', credentials: 'omit', mode: 'cors', headers: { accept: 'application/json' },
    }, timeoutMs);
    if (r.json === undefined) {
      note(`the credentials URL ${redactUrl(file.url)} answered HTTP ${r.status}; no relay for this room`);
      return { iceServers: [], source: 'none', declared: true, problems };
    }
    const v = parseCredentials(r.json);
    for (const p of v.problems) note(`credentials ${p}`);
    log?.('net', `relay: ${v.servers.length} server(s) from ${redactUrl(file.url)}${hasTurn(v.servers) ? ' (TURN)' : ' (no TURN)'}`);
    return { iceServers: v.servers, source: v.servers.length > 0 ? 'credentials' : 'none', declared: true, problems };
  } catch (err) {
    note(`the credentials URL ${redactUrl(file.url)} failed (${err instanceof Error ? err.message : String(err)}); no relay for this room`);
    return { iceServers: [], source: 'none', declared: true, problems };
  }
}
