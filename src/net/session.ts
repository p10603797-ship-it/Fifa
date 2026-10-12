/**
 * [NET-06] Online match session: pause (3 each, capped at 30 s), disconnect, 20 s rejoin window, then Finish
 * against CPU or End Match; builds the MatchSetup (lockstep provider) for ctx.session.start. WAVE 0 STUB (FND-04).
 * Nothing outside src/net imports this except the online screen (NET-07). Local play works with src/net removed.
 */
import type { AppContext, MatchSetup } from '../contracts/app';
import type { Lobby } from './lobby';

export interface OnlineSession {
  readonly lobby: Lobby;
  /** Build the setup once the lobby has started. */
  setup(): MatchSetup;
  readonly pausesLeft: number;
  dispose(): void;
}

/** True when this browser can attempt online play (WebRTC data channels present). */
export function onlineSupported(): boolean {
  return typeof globalThis !== 'undefined' && typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
}

export function createOnlineSession(ctx: AppContext, lobby: Lobby): OnlineSession {
  void ctx;
  void lobby;
  throw new Error('not implemented (NET-06)');
}
