/**
 * [NET-01] Lockstep core: a TickInputProvider fed by the local devices and the remote peer. Each side sends its
 * InputFrame for tick + delay; ready(tick) is false (sim held, waiting indicator) until both inputs exist. Never
 * guesses the remote input. WAVE 0 STUB (FND-04): factories throw until NET-01 lands.
 */
import type { TickInputProvider } from '../contracts/app';
import type { InputSource } from '../contracts/input';
import type { NetTransport } from './transport';

export interface LockstepOptions {
  transport: NetTransport;
  /** Human index of the local player (0 host, 1 guest). */
  localHuman: number;
  /** Local devices merged into the local frame. */
  localSources: InputSource[];
  /** Initial input delay in ticks. */
  delay: number;
}

export interface LockstepProvider extends TickInputProvider {
  /** Commands (tactics, subs, skip) travel inside the local frame so both sides apply them on the same tick. */
  queueCommand(human: number, cmd: number, arg: number): void;
  readonly delay: number;
}

export function createLockstepProvider(opts: LockstepOptions): LockstepProvider {
  void opts;
  throw new Error('not implemented (NET-01)');
}
