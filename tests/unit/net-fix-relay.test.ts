/**
 * [NET-FIX, D-044] Online connection fix, pure parts:
 *  - the ICE list: explicit public STUN servers, never PeerJS's TURN defaults (their hosts have no DNS records);
 *  - relay.json parsing and strict validation (src/net/relay.ts) and loadRelay with a fake fetch: absent (404 / an
 *    HTML fallback), servers, a credentials URL (Metered's array, or { iceServers }), timeouts, malformed input;
 *  - connection-stage diagnostics (src/net/ice.ts): candidate types from SDP and candidates, the failing stage;
 *  - the 'blocked' screen variants (src/ui/screens/online.ts blockedVariant / BLOCKED_TEXT);
 *  - the service worker never answers relay.json (public/sw.js run in a vm).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ICE_SERVERS, NET_CONFIG } from '../../src/net/config';
import {
  candidateTypeOf, candidateTypesFromSdp, createIceProbe, describeIce, failedStage, type IceReport, type IceSnapshot,
} from '../../src/net/ice';
import {
  hasTurn, isIceUrl, loadRelay, MAX_RELAY_SERVERS, mergeIceServers, parseCredentials, parseRelayFile, redactUrl, relayUrlFor,
  serverUrls, validateIceServers,
} from '../../src/net/relay';
import { BLOCKED_TEXT, blockedVariant, errorText } from '../../src/ui/screens/online';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('NET-FIX ICE server list', () => {
  it('NET_CONFIG lists alive public STUN servers explicitly, no TURN and none of the PeerJS relays', () => {
    const urls = (NET_CONFIG.iceServers ?? []).flatMap(serverUrls);
    expect(urls).toEqual([
      'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478',
    ]);
    expect(urls.every((u) => u.startsWith('stun:'))).toBe(true);
    expect(hasTurn(NET_CONFIG.iceServers)).toBe(false);
    expect(JSON.stringify(NET_CONFIG.iceServers)).not.toMatch(/peerjs|openrelay|metered|username|credential/);
    expect(urls.length).toBeLessThanOrEqual(5); // each server costs gathering time
    expect(NET_CONFIG.iceServers).toEqual(DEFAULT_ICE_SERVERS);
  });

  it('mergeIceServers appends the relay to the base list and copies both', () => {
    const turn = { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' };
    const m = mergeIceServers(NET_CONFIG.iceServers, [turn]);
    expect(m.length).toBe(NET_CONFIG.iceServers!.length + 1);
    expect(m[m.length - 1]).toEqual(turn);
    expect(m[m.length - 1]).not.toBe(turn);
    expect(mergeIceServers(undefined, [turn])).toEqual([turn]);
    expect(mergeIceServers([], [])).toEqual([]);
  });
});

describe('NET-FIX relay.json validation', () => {
  it('accepts stun:, turn: and turns: URLs with string username / credential, keeping only those keys', () => {
    const v = validateIceServers([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:a.example.com:80', 'turn:a.example.com:443?transport=tcp', 'turns:a.example.com:443?transport=tcp'], username: 'u1', credential: 'c1', extra: 'dropped', credentialType: 'oauth' },
    ]);
    expect(v.problems).toEqual([]);
    expect(v.servers).toEqual([
      { urls: 'stun:stun.example.com:3478' },
      { urls: ['turn:a.example.com:80', 'turn:a.example.com:443?transport=tcp', 'turns:a.example.com:443?transport=tcp'], username: 'u1', credential: 'c1' },
    ]);
    expect(hasTurn(v.servers)).toBe(true);
  });

  it('drops malformed entries one by one and says why', () => {
    const v = validateIceServers([
      { urls: 'https://evil.example.com' },
      { urls: 'javascript:alert(1)' },
      { urls: 'turn:x.example.com:3478' }, // TURN without credentials: a browser would reject the whole config
      { urls: 'turn:x.example.com:3478', username: 5, credential: 'p' },
      { urls: 'stun:ok.example.com', credential: { a: 1 } },
      { urls: [] },
      { urls: 'stun: spaced.example.com' },
      'stun:bare-string.example.com',
      null,
      { urls: 'stun:kept.example.com:3478' },
    ]);
    expect(v.servers).toEqual([{ urls: 'stun:kept.example.com:3478' }]);
    expect(v.problems.length).toBe(9);
    expect(v.problems.join('\n')).toMatch(/only stun:, turn: and turns:/);
    expect(v.problems.join('\n')).toMatch(/needs a username and a credential/);
    expect(validateIceServers({ urls: 'stun:x' }).problems).toEqual(['iceServers is not a list']);
  });

  it(`keeps at most ${MAX_RELAY_SERVERS} servers`, () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ urls: `stun:s${i}.example.com` }));
    const v = validateIceServers(many);
    expect(v.servers.length).toBe(MAX_RELAY_SERVERS);
    expect(v.problems).toEqual([`more than ${MAX_RELAY_SERVERS} servers: the rest is ignored`]);
  });

  it('isIceUrl is strict', () => {
    for (const ok of ['stun:a.b', 'stun:a.b:3478', 'turn:1.2.3.4:3478?transport=udp', 'turns:a.b:443', 'TURN:a.b']) expect(isIceUrl(ok), ok).toBe(true);
    for (const bad of ['', 'stun:', 'stun:/a', 'http://a', 'turn:a b', 'stun:a\nb', 5, null, `stun:${'a'.repeat(600)}`]) expect(isIceUrl(bad), String(bad)).toBe(false);
  });

  it('parseRelayFile: { iceServers } or { credentialsUrl: https }, nothing else', () => {
    expect(parseRelayFile({ iceServers: [{ urls: 'stun:a.b' }] })).toEqual({ kind: 'servers', servers: [{ urls: 'stun:a.b' }], problems: [] });
    expect(parseRelayFile({ credentialsUrl: 'https://app.metered.live/api/v1/turn/credentials?apiKey=k' }))
      .toEqual({ kind: 'credentials', url: 'https://app.metered.live/api/v1/turn/credentials?apiKey=k' });
    expect(parseRelayFile({ credentialsUrl: 'http://app.metered.live/x' }).kind).toBe('invalid');
    expect(parseRelayFile({ credentialsUrl: 'javascript:alert(1)' }).kind).toBe('invalid');
    expect(parseRelayFile([{ urls: 'stun:a.b' }]).kind).toBe('invalid');
    expect(parseRelayFile({}).kind).toBe('invalid');
    expect(parseRelayFile('x').kind).toBe('invalid');
    expect(parseRelayFile(null).kind).toBe('invalid');
  });

  it('parseCredentials reads Metered\'s array and the { iceServers } shape', () => {
    const metered = [
      { urls: 'stun:stun.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: 'abc', credential: 'def' },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'abc', credential: 'def' },
    ];
    expect(parseCredentials(metered).servers).toEqual(metered);
    expect(parseCredentials({ iceServers: metered }).servers).toEqual(metered);
    expect(parseCredentials({ error: 'bad key' }).servers).toEqual([]);
    expect(parseCredentials({ error: 'bad key' }).problems.length).toBe(1);
  });

  it('relay.json sits beside the page; credentials URLs are logged without their query (the key)', () => {
    expect(relayUrlFor('https://u.github.io/Fifa/?room=KQZ7MP#x')).toBe('https://u.github.io/Fifa/relay.json');
    expect(relayUrlFor('https://u.github.io/Fifa/index.html')).toBe('https://u.github.io/Fifa/relay.json');
    expect(redactUrl('https://app.metered.live/api/v1/turn/credentials?apiKey=SECRET')).toBe('https://app.metered.live/api/v1/turn/credentials?…');
    expect(redactUrl('nope')).toBe('(invalid URL)');
  });
});

// ============================================================ loadRelay with a fake fetch

type Route = (url: string, init: RequestInit) => Promise<Response> | Response;

function fakeFetch(route: Route): { fetchFn: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return route(url, init ?? {});
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const PAGE_RELAY = 'https://game.example/dk/relay.json';
const TURN = { urls: 'turn:relay.example.com:3478', username: 'u', credential: 'p' };

function logs(): { log: (k: string, m: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { lines, log: (k, m) => lines.push(`[${k}] ${m}`) };
}

describe('NET-FIX loadRelay', () => {
  it('absent file (404, the default deploy): no relay, nothing declared, one quiet log line', async () => {
    const { fetchFn, calls } = fakeFetch(() => new Response('not found', { status: 404 }));
    const l = logs();
    const r = await loadRelay({ url: PAGE_RELAY, fetchFn, log: l.log });
    expect(r).toEqual({ iceServers: [], source: 'none', declared: false, problems: [] });
    expect(calls.length).toBe(1);
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(l.lines).toEqual(['[net] relay: none (no relay.json beside the page; direct connections only)']);
  });

  it('a host that answers a missing file with its HTML page counts as absent', async () => {
    const { fetchFn } = fakeFetch(() => new Response('<!doctype html><title>DotKick</title>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect((await loadRelay({ url: PAGE_RELAY, fetchFn })).declared).toBe(false);
  });

  it('{ iceServers }: validated servers for this room', async () => {
    const { fetchFn } = fakeFetch(() => json({ iceServers: [TURN, { urls: 'ftp://x' }] }));
    const l = logs();
    const r = await loadRelay({ url: PAGE_RELAY, fetchFn, log: l.log });
    expect(r.iceServers).toEqual([TURN]);
    expect(r.source).toBe('file');
    expect(r.declared).toBe(true);
    expect(r.problems.length).toBe(1);
    expect(l.lines.join('\n')).toMatch(/1 server\(s\) from relay.json \(TURN\)/);
    expect(l.lines.join('\n')).not.toContain('"p"');
  });

  it('{ credentialsUrl }: fetched without cookies, Metered array accepted, the key never logged', async () => {
    const cred = 'https://dotkick.metered.live/api/v1/turn/credentials?apiKey=SECRETKEY';
    const { fetchFn, calls } = fakeFetch((url) => (url === PAGE_RELAY ? json({ credentialsUrl: cred }) : json([{ urls: 'stun:stun.relay.metered.ca:80' }, TURN])));
    const l = logs();
    const r = await loadRelay({ url: PAGE_RELAY, fetchFn, log: l.log });
    expect(r).toMatchObject({ source: 'credentials', declared: true, iceServers: [{ urls: 'stun:stun.relay.metered.ca:80' }, TURN] });
    expect(calls.map((c) => c.url)).toEqual([PAGE_RELAY, cred]);
    expect(calls[1]!.init.credentials).toBe('omit');
    expect(calls[1]!.init.cache).toBe('no-store');
    expect(l.lines.join('\n')).not.toContain('SECRETKEY');
  });

  it('a failing credentials URL: no servers, but the relay counts as declared (the screen says it could not be reached)', async () => {
    const cred = 'https://dotkick.metered.live/api/v1/turn/credentials?apiKey=K';
    for (const answer of [() => json({ error: 'invalid key' }, 401), () => Promise.reject(new TypeError('Failed to fetch')), () => json({ nope: 1 })]) {
      const { fetchFn } = fakeFetch((url) => (url === PAGE_RELAY ? json({ credentialsUrl: cred }) : answer()));
      const l = logs();
      const r = await loadRelay({ url: PAGE_RELAY, fetchFn, log: l.log });
      expect(r.iceServers).toEqual([]);
      expect(r.declared).toBe(true);
      expect(l.lines.length).toBeGreaterThan(0);
      expect(l.lines.join('\n')).not.toMatch(/apiKey=K/);
    }
  });

  it('malformed JSON, a bad shape, a server error or a network error: ignored and logged, never thrown', async () => {
    const answers: Route[] = [
      () => new Response('{not json', { status: 200, headers: { 'content-type': 'application/json' } }),
      () => json({ servers: [] }),
      () => json([TURN]),
      () => json({ credentialsUrl: 'http://insecure.example.com' }),
      () => new Response('oops', { status: 500 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
    ];
    for (const a of answers) {
      const { fetchFn } = fakeFetch(a);
      const l = logs();
      const r = await loadRelay({ url: PAGE_RELAY, fetchFn, log: l.log });
      expect(r.iceServers).toEqual([]);
      expect(r.declared).toBe(false);
      expect(l.lines.length).toBe(1);
      expect(r.problems.length).toBe(1);
    }
  });

  it('gives up after the timeout (a host that never answers does not hold the room)', async () => {
    const { fetchFn } = fakeFetch((_url, init) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const t0 = Date.now();
    const r = await loadRelay({ url: PAGE_RELAY, fetchFn, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(r.iceServers).toEqual([]);
    expect(r.problems[0]).toMatch(/no answer within 50 ms/);
  });
});

// ============================================================ ICE diagnostics

const SDP_LOCAL = 'v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.20 54400 typ host generation 0\r\na=candidate:2 1 udp 1686052607 81.2.3.4 54400 typ srflx raddr 192.168.1.20 rport 54400\r\n';
const SDP_REMOTE = 'v=0\r\na=candidate:9 1 udp 2122260223 abcd.local 50000 typ host\r\n';

function snap(over: Partial<IceSnapshot>): IceSnapshot {
  return { local: ['host', 'srflx'], remote: ['host'], gathering: 'complete', ice: 'failed', signaling: 'stable', remoteDescription: true, ...over };
}

describe('NET-FIX connection-stage diagnostics', () => {
  it('reads candidate types from SDP and from candidate objects', () => {
    expect(candidateTypesFromSdp(SDP_LOCAL)).toEqual(['host', 'srflx']);
    expect(candidateTypesFromSdp(SDP_REMOTE)).toEqual(['host']);
    expect(candidateTypesFromSdp('a=candidate:3 1 udp 1 10.0.0.1 3478 typ relay raddr 81.2.3.4 rport 1\r\n')).toEqual(['relay']);
    expect(candidateTypesFromSdp(null)).toEqual([]);
    expect(candidateTypeOf({ type: 'relay' })).toBe('relay');
    expect(candidateTypeOf({ type: null, candidate: 'candidate:2 1 udp 1 81.2.3.4 1 typ srflx raddr 0.0.0.0 rport 0' })).toBe('srflx');
    expect(candidateTypeOf({ candidate: '' })).toBeNull();
    expect(candidateTypeOf(null)).toBeNull();
  });

  it('names the failing stage', () => {
    expect(failedStage(snap({ remoteDescription: false, remote: [] }))).toBe('signalling');
    expect(failedStage(snap({ local: [] }))).toBe('gathering');
    expect(failedStage(snap({ remote: [] }))).toBe('signalling');
    expect(failedStage(snap({ ice: 'checking' }))).toBe('ice');
    expect(failedStage(snap({ ice: 'failed' }))).toBe('ice');
    expect(failedStage(snap({ ice: 'connected' }))).toBe('channel');
  });

  it('a probe follows a peer connection by its events only and keeps what it saw after the connection closes', () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const pc = {
      iceGatheringState: 'new', iceConnectionState: 'new', signalingState: 'have-local-offer',
      localDescription: { sdp: 'v=0\r\n' } as { sdp: string } | null, remoteDescription: null as { sdp: string } | null,
      addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ??= []).push(fn); },
      removeEventListener: (t: string, fn: (e: unknown) => void) => { listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn); },
    };
    const fire = (t: string, e: unknown = {}): void => { for (const f of listeners[t] ?? []) f(e); };
    const probe = createIceProbe();
    probe.watch({ peerConnection: pc });
    probe.watch({ peerConnection: pc }); // once
    probe.watch({}); // no RTCPeerConnection: ignored
    expect(Object.values(listeners).every((l) => l.length === 1)).toBe(true);
    fire('icecandidate', { candidate: { type: 'host', candidate: 'candidate:1 1 udp 1 192.168.1.20 1 typ host' } });
    fire('icecandidate', { candidate: { candidate: 'candidate:2 1 udp 1 81.2.3.4 1 typ srflx raddr 0.0.0.0 rport 0' } });
    fire('icecandidate', { candidate: null }); // end of gathering
    pc.iceGatheringState = 'complete';
    pc.signalingState = 'stable';
    pc.remoteDescription = { sdp: SDP_REMOTE };
    pc.iceConnectionState = 'checking';
    fire('iceconnectionstatechange');
    pc.iceConnectionState = 'failed';
    fire('iceconnectionstatechange');
    // PeerJS closes it on failure: the snapshot keeps the last real states.
    pc.iceConnectionState = 'closed';
    pc.signalingState = 'closed';
    const s = probe.snapshot();
    expect(s).toEqual({ local: ['host', 'srflx'], remote: ['host'], gathering: 'complete', ice: 'failed', signaling: 'stable', remoteDescription: true });
    expect(failedStage(s)).toBe('ice');
    probe.dispose();
    expect(Object.values(listeners).every((l) => l.length === 0)).toBe(true);
  });

  it('describeIce is one plain line for the diagnostics report', () => {
    const r: IceReport = { ...snap({}), stage: 'ice', relayConfigured: false, servers: 4 };
    expect(describeIce(r)).toBe('ice failed at ice: local host+srflx, remote host, ice failed, gathering complete, signalling stable, 4 ICE server(s), no TURN');
    expect(describeIce({ ...r, stage: null, local: [], relayConfigured: true })).toMatch(/^ice connected: local none, .* incl\. TURN$/);
  });
});

// ============================================================ the blocked screen

describe('NET-FIX blocked screen text', () => {
  const ice = (local: IceReport['local'], relayConfigured = false): IceReport => ({ ...snap({ local }), stage: 'ice', relayConfigured, servers: 4 });
  const relay = (declared: boolean) => ({ iceServers: declared ? [TURN] : [], source: declared ? 'file' as const : 'none' as const, declared, problems: [] });

  it('no relay configured: try the same Wi-Fi, or ask the game\'s owner for a relay', () => {
    expect(blockedVariant(null, null)).toBe('no-relay');
    expect(blockedVariant(relay(false), ice(['host', 'srflx']))).toBe('no-relay');
    const t = BLOCKED_TEXT['no-relay'];
    expect(t).toBe(errorText('blocked'));
    expect(t.body).toMatch(/could not reach each other directly/);
    expect(t.body).toMatch(/different networks, such as mobile data/);
    expect(t.body).toMatch(/same Wi-Fi/);
    expect(t.body).toMatch(/add a relay/);
  });

  it('a relay configured but no relay candidate gathered: the relay could not be reached', () => {
    expect(blockedVariant(relay(true), ice(['host', 'srflx']))).toBe('relay-unreachable');
    expect(blockedVariant(relay(true), null)).toBe('relay-unreachable');
    expect(blockedVariant(null, ice(['host'], true))).toBe('relay-unreachable'); // TURN given through the config itself
    expect(BLOCKED_TEXT['relay-unreachable'].title).toBe('Could not reach the relay');
    expect(BLOCKED_TEXT['relay-unreachable'].body).toMatch(/relay server .* could not be reached/);
  });

  it('the relay was reached and the link still failed', () => {
    expect(blockedVariant(relay(true), ice(['host', 'srflx', 'relay']))).toBe('relay-failed');
    expect(BLOCKED_TEXT['relay-failed'].body).toMatch(/even through the relay/);
  });

  it('every variant is plain language: a title, sentences ending in a full stop, no internal codes', () => {
    for (const t of Object.values(BLOCKED_TEXT)) {
      expect(t.title.length).toBeGreaterThan(5);
      expect(t.body).toMatch(/\.$/);
      expect(`${t.title} ${t.body}`).not.toMatch(/ICE|WebRTC|TURN|STUN|srflx|candidate|null|undefined/);
      expect(t.body).toMatch(/same Wi-Fi/);
    }
  });
});

// ============================================================ service worker

describe('NET-FIX service worker and relay.json', () => {
  it('never answers relay.json (network only), while the shell is still answered', () => {
    const SCOPE = 'https://game.example/dk/';
    const handlers: Record<string, ((e: unknown) => void)[]> = {};
    const self = {
      location: { href: `${SCOPE}sw.js`, origin: 'https://game.example' },
      registration: { scope: SCOPE },
      clients: { claim: () => Promise.resolve() },
      skipWaiting: () => Promise.resolve(),
      addEventListener: (t: string, fn: (e: unknown) => void) => { (handlers[t] ??= []).push(fn); },
    };
    const caches = { open: async () => ({ put: async () => undefined, match: async () => undefined }), keys: async () => [], delete: async () => true };
    runInNewContext(readFileSync(`${root}public/sw.js`, 'utf8'), {
      self, URL, Request, Response, setTimeout, clearTimeout, Promise, caches, fetch: async () => new Response('x'),
    });
    const fetchEvent = (url: string, mode = 'cors') => {
      const e = { request: { method: 'GET', url, mode }, responded: false, respondWith() { this.responded = true; }, waitUntil() { /* */ } };
      for (const fn of handlers.fetch ?? []) fn(e);
      return e;
    };
    expect(fetchEvent(`${SCOPE}relay.json`).responded).toBe(false);
    expect(fetchEvent(`${SCOPE}relay.json?x=1`).responded).toBe(false);
    expect(fetchEvent(SCOPE, 'navigate').responded).toBe(true);
    expect(readFileSync(`${root}public/sw.js`, 'utf8')).toContain("if (/\\/relay\\.json$/.test(url.pathname)) return;");
  });
});
