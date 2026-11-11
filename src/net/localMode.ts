/**
 * [NET-FIX-2, D-045] Local-network mode: let two devices on the same Wi-Fi see each other's real local address.
 *
 * Safari offers only mDNS host candidates ('<uuid>.local') unless the page has been granted camera or microphone
 * capture: WebKit's RTCController lifts ICE candidate filtering for the document once getUserMedia is granted, and the
 * RTCPeerConnections created after that offer real local IP addresses. Between two iPads, mDNS names often do not
 * resolve (many home routers filter multicast), and the public (srflx) addresses need NAT hairpinning on the same
 * router, which many routers lack; with no TURN relay, nothing else can connect them. One side offering real host
 * candidates is enough: the other side learns a peer-reflexive candidate from its connectivity checks.
 *
 * So, only when the player asks (a button / toggle on the online screen), enable() calls
 * navigator.mediaDevices.getUserMedia({ audio: true }) BEFORE the connection gathers candidates, holds the track
 * through that connection attempt, and release() stops every track as soon as the link opens, fails, the player
 * leaves, or the cap passes (enable's capMs). A track the system ends by itself (an iOS interruption, the permission
 * revoked in Settings) releases the mode too ('ended'), so the screen never says "on" for a dead track; WebKit's lift of
 * the candidate filtering is per document and outlives the track either way. Nothing is recorded or sent: the stream is never attached to the
 * connection, read, or kept. Nothing is persisted. The diagnostics log gets only "local mode on / denied /
 * unavailable / off (why)".
 *
 *   const lm = createLocalNetworkMode({ log });
 *   const r = await lm.enable(30_000);   // 'on' | 'denied' | 'unavailable' | 'cancelled'
 *   ... dial / answer ...
 *   lm.release('link open');
 *
 * Unverified on a real iPad (D-045): the reasoning is WebKit's, the e2e runs Chromium with a fake microphone.
 */

export type LocalModeResult = 'on' | 'denied' | 'unavailable' | 'cancelled';

export interface MediaTrackLike {
  stop(): void;
  /** [NET-FIX-2] 'ended': the system stopped the track (an interruption, the permission revoked in Settings). */
  addEventListener?(type: 'ended', fn: () => void): void;
  removeEventListener?(type: 'ended', fn: () => void): void;
}

export interface MediaStreamLike {
  getTracks(): MediaTrackLike[];
}

export type GetUserMediaLike = (constraints: { audio: boolean; video?: boolean }) => Promise<MediaStreamLike>;

export interface LocalModeDeps {
  /** Default: navigator.mediaDevices.getUserMedia (null when the browser has none: 'unavailable'). */
  getUserMedia?: GetUserMediaLike | null;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  /** Diagnostics.log compatible. Gets only "local mode ..." lines. */
  log?(kind: string, message: string): void;
}

export interface LocalNetworkMode {
  /** A microphone track is held right now (the mode is on). */
  readonly active: boolean;
  /** The permission request is still open. */
  readonly pending: boolean;
  /**
   * Ask for the microphone (call it straight from the tap: Safari wants the user gesture) and hold the track for at
   * most capMs. Already on: the cap starts again. 'denied': the player (or a policy) said no; 'unavailable': no
   * getUserMedia, no microphone, or not a secure page; 'cancelled': release() came while the request was open.
   */
  enable(capMs: number): Promise<LocalModeResult>;
  /** Stop every track now (idempotent). `why` goes to the log. */
  release(why: string): void;
  /** Called whenever active / pending changes. */
  onChange(fn: () => void): () => void;
}

/** navigator.mediaDevices.getUserMedia, bound, or null. */
export function browserGetUserMedia(): GetUserMediaLike | null {
  try {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md || typeof md.getUserMedia !== 'function') return null;
    return (c) => md.getUserMedia(c) as Promise<MediaStreamLike>;
  } catch {
    return null;
  }
}

/** A getUserMedia rejection -> 'denied' (the player or a policy said no) or 'unavailable' (no microphone...). Pure. */
export function localModeErrorResult(err: unknown): 'denied' | 'unavailable' {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' || name === 'AbortError'
    ? 'denied' : 'unavailable';
}

function tracksOf(stream: MediaStreamLike | null): MediaTrackLike[] {
  if (!stream) return [];
  try {
    return stream.getTracks();
  } catch {
    return [];
  }
}

function stopAll(stream: MediaStreamLike | null, onEnded?: () => void): void {
  for (const t of tracksOf(stream)) {
    try {
      if (onEnded) t.removeEventListener?.('ended', onEnded);
    } catch {
      /* a listener that cannot be removed is harmless: onEnded checks the stream it belongs to */
    }
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

export function createLocalNetworkMode(deps: LocalModeDeps = {}): LocalNetworkMode {
  const gum = deps.getUserMedia === undefined ? browserGetUserMedia() : deps.getUserMedia;
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = (m: string): void => {
    try {
      deps.log?.('net', m);
    } catch {
      /* diagnostics never break the connection */
    }
  };
  let stream: MediaStreamLike | null = null;
  /** The 'ended' listener on the held tracks (one per held stream; never per frame). */
  let onEnded: (() => void) | undefined;
  let pending = false;
  let cap: unknown = null;
  /** Bumped by release(): a request that resolves after it is stopped at once. */
  let gen = 0;
  const listeners: (() => void)[] = [];
  const changed = (): void => {
    for (const fn of listeners.slice()) {
      try {
        fn();
      } catch {
        /* a listener never breaks the mode */
      }
    }
  };
  const armCap = (capMs: number): void => {
    if (cap !== null) clearT(cap);
    cap = setT(() => {
      cap = null;
      mode.release('time limit');
    }, Math.max(0, capMs));
  };

  const mode: LocalNetworkMode = {
    get active() { return stream !== null; },
    get pending() { return pending; },
    enable(capMs) {
      if (stream) {
        armCap(capMs);
        return Promise.resolve('on');
      }
      if (!gum) {
        log('local mode unavailable');
        return Promise.resolve('unavailable');
      }
      const my = ++gen;
      let req: Promise<MediaStreamLike>;
      try {
        req = gum({ audio: true }); // synchronously, inside the tap
      } catch (err) {
        const r = localModeErrorResult(err);
        log(`local mode ${r}`);
        return Promise.resolve(r);
      }
      pending = true;
      changed();
      return req.then(
        (s) => {
          if (my !== gen) {
            stopAll(s); // released (left, cancelled) while Safari was asking
            return 'cancelled' as const;
          }
          pending = false;
          stopAll(stream, onEnded);
          stream = s;
          const ended = (): void => {
            if (stream === s) mode.release('ended'); // the system stopped the track: the mode is off
          };
          onEnded = ended;
          for (const t of tracksOf(s)) {
            try {
              t.addEventListener?.('ended', ended);
            } catch {
              /* no 'ended' events: the cap still releases it */
            }
          }
          armCap(capMs);
          log('local mode on');
          changed();
          return 'on' as const;
        },
        (err: unknown) => {
          if (my !== gen) return 'cancelled' as const;
          pending = false;
          const r = localModeErrorResult(err);
          log(`local mode ${r}`);
          changed();
          return r;
        },
      );
    },
    release(why) {
      gen++;
      const had = stream !== null || pending;
      if (cap !== null) clearT(cap);
      cap = null;
      const s = stream;
      const ended = onEnded;
      stream = null;
      onEnded = undefined;
      pending = false;
      stopAll(s, ended);
      if (s) log(`local mode off (${why})`);
      if (had) changed();
    },
    onChange(fn) {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
  return mode;
}
