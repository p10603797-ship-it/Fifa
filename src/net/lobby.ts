/**
 * [NET-03] Lobby flow: create/join a room, exchange nicknames, versions and team picks, ready up; the host owns
 * the match settings. WAVE 0 STUB (FND-04): factories throw until NET-03 lands.
 */
import type { MatchConfig } from '../contracts/state';
import type { NetTransport } from './transport';

export type LobbyError = 'broker-unreachable' | 'code-not-found' | 'room-full' | 'version-mismatch' | 'blocked' | 'disconnected';

export interface LobbyPeer {
  nickname: string;
  /** Club index picked, -1 until chosen. */
  club: number;
  ready: boolean;
}

export interface Lobby {
  readonly code: string;
  readonly isHost: boolean;
  readonly self: LobbyPeer;
  readonly peer: LobbyPeer | null;
  setClub(club: number): void;
  setReady(ready: boolean): void;
  /** Host only: the settings both sides will play with. */
  setConfig(config: MatchConfig): void;
  onChange(fn: () => void): () => void;
  onError(fn: (err: LobbyError) => void): () => void;
  /** Resolves with the agreed config when both are ready. */
  waitForStart(): Promise<{ config: MatchConfig; transport: NetTransport; localSide: number }>;
  leave(): void;
}

export function createLobby(opts: { host: boolean; code?: string; nickname: string }): Lobby {
  void opts;
  throw new Error('not implemented (NET-03)');
}
