/**
 * [NET-FIX-2, D-045] Same-Wi-Fi iPads (no network, no DOM beyond what the modules need):
 *  - local-network mode (src/net/localMode.ts): the microphone is asked only on request, held through one attempt,
 *    every track stopped on release / at the cap / when released while Safari is still asking; denied and unavailable
 *    are told apart; the log gets only "local mode ..." lines;
 *  - ICE snapshot additions (src/net/ice.ts): host candidate kinds (real IP / mDNS) and "same network" from the srflx
 *    addresses, which never leave the probe;
 *  - online screen texts (src/ui/screens/online.ts): the 'same-network' blocked variant, advice that fits both cases
 *    when unknown, the connecting progress line, the host's failed-stage words, honest local-mode copy;
 *  - "update ready" (src/platform/pwa.ts): an offered update stays ready until applied, once, by the menu or by
 *    itself when the page returns to the menu.
 */
import { describe, expect, it } from 'vitest';
import {
  createIceProbe, describeIce, hostKindOf, isMdnsAddress, sameNetworkOf, type IceReport,
} from '../../src/net/ice';
import { createLocalNetworkMode, localModeErrorResult, type MediaStreamLike } from '../../src/net/localMode';
import { applyUpdate, applyUpdateIfIdle, holdUpdate, onUpdateReady, setUpdateReady, updateReady } from '../../src/platform/pwa';
import {
  BLOCKED_TEXT, blockedVariant, errorText, JOIN_FAILED_TEXT, LOCAL_MODE_GUEST_MS, LOCAL_MODE_HOST_MS, LOCAL_MODE_TEXT, progressText,
  secondsLeftText, STAGE_TEXT,
} from '../../src/ui/screens/online';

// ============================================================ local-network mode

function fakeMedia() {
  const timers: { fn: () => void; at: number; id: number }[] = [];
  let now = 0;
  let nextId = 1;
  const streams: { tracks: { stopped: boolean; stop(): void }[] }[] = [];
  const calls: unknown[] = [];
  let answer: 'grant' | 'deny' | 'none' | 'hang' = 'grant';
  let pendingResolve: ((s: MediaStreamLike) => void) | null = null;
  const lines: string[] = [];
  const make = (): MediaStreamLike & { tracks: { stopped: boolean; stop(): void }[] } => {
    const t = { stopped: false, stop() { this.stopped = true; } };
    const s = { tracks: [t], getTracks: () => s.tracks };
    streams.push(s);
    return s;
  };
  const lm = createLocalNetworkMode({
    getUserMedia: (c) => {
      calls.push(c);
      if (answer === 'deny') return Promise.reject(Object.assign(new Error('no'), { name: 'NotAllowedError' }));
      if (answer === 'none') return Promise.reject(Object.assign(new Error('no mic'), { name: 'NotFoundError' }));
      if (answer === 'hang') return new Promise((r) => { pendingResolve = r; });
      return Promise.resolve(make());
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ fn, at: now + ms, id });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    log: (k, m) => lines.push(`[${k}] ${m}`),
  });
  return {
    lm, streams, calls, lines,
    set answer(a: 'grant' | 'deny' | 'none' | 'hang') { answer = a; },
    resolvePending: () => pendingResolve?.(make()),
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

describe('NET-FIX-2 local-network mode', () => {
  it('asks for audio only, holds the track through the attempt, stops every track on release', async () => {
    const f = fakeMedia();
    let changes = 0;
    f.lm.onChange(() => changes++);
    expect(f.lm.active).toBe(false);
    const p = f.lm.enable(LOCAL_MODE_GUEST_MS);
    expect(f.calls).toEqual([{ audio: true }]); // asked synchronously, inside the tap; audio only, never video
    expect(f.lm.pending).toBe(true);
    expect(await p).toBe('on');
    expect(f.lm.active).toBe(true);
    expect(f.streams[0]!.tracks[0]!.stopped).toBe(false);
    f.lm.release('link open');
    expect(f.lm.active).toBe(false);
    expect(f.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(f.lines).toEqual(['[net] local mode on', '[net] local mode off (link open)']);
    expect(changes).toBeGreaterThanOrEqual(2);
    f.lm.release('again'); // idempotent, nothing more logged
    expect(f.lines.length).toBe(2);
  });

  it('the cap stops the track by itself; enabling again re-arms the cap without asking twice', async () => {
    const f = fakeMedia();
    expect(await f.lm.enable(LOCAL_MODE_HOST_MS)).toBe('on');
    f.advance(LOCAL_MODE_HOST_MS - 1000);
    expect(f.lm.active).toBe(true);
    expect(await f.lm.enable(LOCAL_MODE_HOST_MS)).toBe('on'); // re-armed
    expect(f.calls.length).toBe(1);
    f.advance(LOCAL_MODE_HOST_MS - 1000);
    expect(f.lm.active).toBe(true);
    f.advance(1000);
    expect(f.lm.active).toBe(false);
    expect(f.streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(f.lines.at(-1)).toBe('[net] local mode off (time limit)');
  });

  it('denied, no microphone and no getUserMedia are reported; nothing is held', async () => {
    const f = fakeMedia();
    f.answer = 'deny';
    expect(await f.lm.enable(1000)).toBe('denied');
    expect(f.lm.active).toBe(false);
    expect(f.lm.pending).toBe(false);
    f.answer = 'none';
    expect(await f.lm.enable(1000)).toBe('unavailable');
    expect(f.lines).toEqual(['[net] local mode denied', '[net] local mode unavailable']);
    const none = createLocalNetworkMode({ getUserMedia: null, log: () => undefined });
    expect(await none.enable(1000)).toBe('unavailable');
    expect(localModeErrorResult({ name: 'SecurityError' })).toBe('denied');
    expect(localModeErrorResult({ name: 'NotReadableError' })).toBe('unavailable');
    expect(localModeErrorResult(null)).toBe('unavailable');
  });

  it('released while Safari still asks (the player left): the late stream is stopped at once', async () => {
    const f = fakeMedia();
    f.answer = 'hang';
    const p = f.lm.enable(1000);
    f.lm.release('left');
    f.resolvePending();
    expect(await p).toBe('cancelled');
    expect(f.lm.active).toBe(false);
    expect(f.streams[0]!.tracks[0]!.stopped).toBe(true);
    expect(f.lines.join('\n')).not.toContain('local mode on');
  });

  it('a track the system ends (interruption, permission revoked) turns the mode off; stale or own stops do not', async () => {
    type Listened = { stopped: boolean; stop(): void; fire(): void; listeners: (() => void)[];
      addEventListener(t: 'ended', fn: () => void): void; removeEventListener(t: 'ended', fn: () => void): void };
    const tracks: Listened[] = [];
    const make = (): MediaStreamLike => {
      const t: Listened = {
        stopped: false, listeners: [],
        stop() { this.stopped = true; }, // like a real track, stop() itself never fires 'ended'
        fire() { this.stopped = true; for (const fn of this.listeners.slice()) fn(); },
        addEventListener(_t, fn) { this.listeners.push(fn); },
        removeEventListener(_t, fn) { const i = this.listeners.indexOf(fn); if (i >= 0) this.listeners.splice(i, 1); },
      };
      tracks.push(t);
      return { getTracks: () => [t] };
    };
    const lines: string[] = [];
    let changes = 0;
    const lm = createLocalNetworkMode({ getUserMedia: () => Promise.resolve(make()), log: (k, m) => lines.push(`[${k}] ${m}`) });
    lm.onChange(() => changes++);
    expect(await lm.enable(LOCAL_MODE_HOST_MS)).toBe('on');
    expect(tracks[0]!.listeners.length).toBe(1);
    const before = changes;
    tracks[0]!.fire(); // iOS ended it (a call, Siri, Settings)
    expect(lm.active).toBe(false);
    expect(changes).toBe(before + 1); // the toggle re-renders as off
    expect(lines.at(-1)).toBe('[net] local mode off (ended)');
    expect(tracks[0]!.listeners.length).toBe(0); // released: listener removed
    // Our own release removes the listener; a late 'ended' from an old track never turns off a newer one.
    expect(await lm.enable(LOCAL_MODE_HOST_MS)).toBe('on');
    const oldListener = tracks[1]!.listeners[0]!;
    lm.release('link open');
    expect(tracks[1]!.listeners.length).toBe(0);
    expect(await lm.enable(LOCAL_MODE_HOST_MS)).toBe('on');
    oldListener(); // a browser that still delivers the old track's 'ended'
    expect(lm.active).toBe(true);
    expect(lines.filter((l) => l.endsWith('(ended)')).length).toBe(1);
    lm.release('left');
    expect(tracks[2]!.stopped).toBe(true);
  });

  it('the copy is short and honest: the microphone, why, nothing recorded, you can say no', () => {
    expect(LOCAL_MODE_TEXT.explain).toMatch(/microphone/);
    expect(LOCAL_MODE_TEXT.explain).toMatch(/see each other on the Wi-Fi/);
    expect(LOCAL_MODE_TEXT.explain).toMatch(/nothing is recorded/);
    expect(LOCAL_MODE_TEXT.explain).toMatch(/you can say no/);
    expect(LOCAL_MODE_TEXT.denied).toMatch(/try again the normal way/);
    expect(LOCAL_MODE_TEXT.unavailable).toMatch(/not available/);
    expect(LOCAL_MODE_GUEST_MS).toBe(30_000);
    expect(LOCAL_MODE_HOST_MS).toBe(120_000);
  });
});

// ============================================================ ICE snapshot additions

describe('NET-FIX-2 host candidate kinds and "same network"', () => {
  it('pure helpers', () => {
    expect(isMdnsAddress('1f2e3d4c-aaaa-bbbb-cccc-0123456789ab.local')).toBe(true);
    expect(isMdnsAddress('192.168.1.20')).toBe(false);
    expect(hostKindOf(true, true)).toBe('ip+mdns');
    expect(hostKindOf(false, true)).toBe('mdns');
    expect(hostKindOf(false, false)).toBe('none');
    expect(sameNetworkOf(new Set(['81.2.3.4']), new Set(['81.2.3.4', '9.9.9.9']))).toBe(true);
    expect(sameNetworkOf(new Set(['81.2.3.4']), new Set(['9.9.9.9']))).toBe(false);
    expect(sameNetworkOf(new Set(), new Set(['9.9.9.9']))).toBeNull();
  });

  it('a probe tells mDNS-only from real host candidates and sees a shared public address without exposing it', () => {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const pc = {
      iceGatheringState: 'complete', iceConnectionState: 'failed', signalingState: 'stable',
      localDescription: { sdp: 'v=0\r\n' } as { sdp: string } | null,
      remoteDescription: {
        sdp: 'v=0\r\na=candidate:9 1 udp 2122260223 abcd.local 50000 typ host\r\na=candidate:8 1 udp 1686052607 81.2.3.4 50001 typ srflx raddr 0.0.0.0 rport 0\r\n',
      } as { sdp: string } | null,
      addEventListener: (t: string, fn: (e: unknown) => void) => { (listeners[t] ??= []).push(fn); },
      removeEventListener: () => undefined,
    };
    const probe = createIceProbe();
    probe.watch({ peerConnection: pc });
    // Safari without a microphone grant: an mDNS host candidate; then (Chromium-style) one with .address.
    for (const f of listeners.icecandidate ?? []) {
      f({ candidate: { candidate: 'candidate:1 1 udp 2122260223 0b1c2d3e-0000-4000-8000-000000000000.local 54400 typ host' } });
      f({ candidate: { type: 'srflx', address: '81.2.3.4', candidate: 'candidate:2 1 udp 1686052607 81.2.3.4 54400 typ srflx raddr 0.0.0.0 rport 0' } });
    }
    const s = probe.snapshot();
    expect(s.localHost).toBe('mdns');
    expect(s.remoteHost).toBe('mdns');
    expect(s.sameNetwork).toBe(true);
    expect(JSON.stringify(s)).not.toContain('81.2.3.4');
    const line = describeIce({ ...s, stage: 'ice', relayConfigured: false, servers: 4 });
    expect(line).toMatch(/host addresses local mdns remote mdns, same network yes$/);
    expect(line).not.toMatch(/81\.2|\.local/);
    // With the microphone grant: a real local address.
    for (const f of listeners.icecandidate ?? []) f({ candidate: { type: 'host', address: '192.168.1.20', candidate: 'candidate:3 1 udp 1 192.168.1.20 5 typ host' } });
    expect(probe.snapshot().localHost).toBe('ip+mdns');
    probe.dispose();
  });
});

// ============================================================ online screen texts

describe('NET-FIX-2 blocked copy, progress and the host notice', () => {
  const report = (over: Partial<IceReport>): IceReport => ({
    local: ['host', 'srflx'], remote: ['host', 'srflx'], gathering: 'complete', ice: 'failed', signaling: 'stable', remoteDescription: true,
    localHost: 'mdns', remoteHost: 'mdns', sameNetwork: null, stage: 'ice', relayConfigured: false, servers: 4, ...over,
  });

  it('both sides share a public address: "same network", never "use the same Wi-Fi"; local-network mode first', () => {
    expect(blockedVariant(null, report({ sameNetwork: true }))).toBe('same-network');
    const t = BLOCKED_TEXT['same-network'];
    expect(t.title).toBe('Your network blocked the connection');
    expect(t.body).toMatch(/look like they are on the same network, but it did not let them talk to each other directly/);
    expect(t.body).toMatch(/local-network mode.*hotspot.*relay/);
    expect(t.body).not.toMatch(/same Wi-Fi/);
    // A relay configured keeps the relay variants.
    expect(blockedVariant(null, report({ sameNetwork: true, relayConfigured: true }))).toBe('relay-unreachable');
  });

  it('a shared public address may be carrier-grade NAT, not one Wi-Fi: the title says "your network", never blames the Wi-Fi', () => {
    const t = BLOCKED_TEXT['same-network'];
    expect(t.title).not.toMatch(/Wi-Fi/);
    expect(t.title).toMatch(/^Your network/);
    expect(t.body).not.toMatch(/the Wi-Fi did not/);
    expect(t.body).toMatch(/hotspot.*relay/); // advice that works on any network
  });

  it('unknown or different networks: the advice fits both cases', () => {
    expect(blockedVariant(null, report({ sameNetwork: false }))).toBe('no-relay');
    expect(blockedVariant(null, report({}))).toBe('no-relay');
    const body = errorText('blocked').body;
    expect(body).toMatch(/On different networks, such as mobile data, put both devices on the same Wi-Fi/);
    expect(body).toMatch(/Already on the same Wi-Fi\? Try local-network mode/);
    for (const v of ['relay-unreachable', 'relay-failed'] as const) expect(BLOCKED_TEXT[v].body).toMatch(/On the same Wi-Fi, try local-network mode/);
  });

  it('connecting progress: plain stage words and the seconds left', () => {
    expect(progressText(null)).toBe('Connecting…');
    expect(progressText({ stage: 'broker', timeoutMs: 10_000, relay: false })).toBe('Finding the room…');
    expect(progressText({ stage: 'dialling', timeoutMs: 15_000, relay: false })).toBe('Connecting to your friend…');
    expect(progressText({ stage: 'dialling', timeoutMs: 15_000, relay: true })).toBe('Connecting to your friend, directly or through the relay…');
    expect(progressText({ stage: 'handshake', timeoutMs: 5000, relay: false })).toBe('Connected, checking the game versions…');
    const p = { stage: 'dialling' as const, timeoutMs: 15_000, relay: false };
    expect(secondsLeftText(p, 1000, 1000)).toBe('Gives up in 15 s');
    expect(secondsLeftText(p, 1000, 4500)).toBe('Gives up in 12 s');
    expect(secondsLeftText(p, 1000, 99_000)).toBe('Gives up in 0 s');
    expect(secondsLeftText(null, 0, 0)).toBe('');
  });

  it('the host notice names the failed stage in plain words and offers local-network mode', () => {
    expect(JOIN_FAILED_TEXT.title).toBe('A friend tried to join, but your devices could not connect');
    expect(JOIN_FAILED_TEXT.advice).toMatch(/local-network mode/);
    for (const t of Object.values(STAGE_TEXT)) {
      expect(t).toMatch(/\.$/);
      expect(t).not.toMatch(/ICE|WebRTC|TURN|STUN|srflx|candidate|SDP/);
    }
    expect(STAGE_TEXT.ice).toMatch(/neither could reach the other/);
  });
});

// ============================================================ update ready

describe('NET-FIX-2 an offered update stays ready until applied', () => {
  it('holdUpdate keeps it ready; applyUpdate runs it once and clears it; listeners hear both', () => {
    setUpdateReady(null);
    let runs = 0;
    let heard = 0;
    const off = onUpdateReady(() => heard++);
    const once = holdUpdate(() => runs++);
    expect(updateReady()).toBe(true);
    expect(applyUpdate()).toBe(true);
    expect(runs).toBe(1);
    expect(updateReady()).toBe(false);
    once(); // the toast's Reload after the menu's: still once
    expect(runs).toBe(1);
    expect(applyUpdate()).toBe(false);
    expect(heard).toBeGreaterThanOrEqual(2);
    off();
  });

  it('accepted through the toast: no longer ready for the menu', () => {
    setUpdateReady(null);
    let runs = 0;
    const once = holdUpdate(() => runs++);
    once();
    expect(runs).toBe(1);
    expect(updateReady()).toBe(false);
  });

  it('on return to the page: applied only when reloading loses nothing (the menu), never in a match', () => {
    setUpdateReady(null);
    let runs = 0;
    holdUpdate(() => runs++);
    const lines: string[] = [];
    expect(applyUpdateIfIdle(undefined)).toBe(false); // no canReloadNow: never by itself
    expect(applyUpdateIfIdle(() => false, (m) => lines.push(m))).toBe(false); // a match / the lobby
    expect(applyUpdateIfIdle(() => { throw new Error('x'); })).toBe(false);
    expect(runs).toBe(0);
    expect(updateReady()).toBe(true);
    expect(applyUpdateIfIdle(() => true, (m) => lines.push(m))).toBe(true);
    expect(runs).toBe(1);
    expect(lines).toEqual(['update ready and the app is on the menu: reloading into the new version']);
    expect(applyUpdateIfIdle(() => true)).toBe(false); // nothing ready any more
  });
});
