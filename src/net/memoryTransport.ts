/**
 * [NET-02] In-memory NetTransport pair for tests and tools/netsim.ts (NET-08 builds its lossy network simulator on
 * it). Never touches the network. WAVE 0 STUB (FND-04): the factory throws until NET-02 lands.
 */
import type { NetTransport } from './types';

export interface MemoryLinkOptions {
  /** One-way latency, ms (default 0). */
  latencyMs?: number;
  /** Random extra delay 0..jitterMs, ms (default 0). */
  jitterMs?: number;
  /** Probability 0..1 that an 'inputs' packet is dropped (the reliable channel never drops). Default 0. */
  loss?: number;
  /** Seed for the jitter / loss generator, so runs are reproducible. */
  seed?: number;
  /** Clock and scheduler (tests drive time by hand). Default: performance.now / setTimeout. */
  now?(): number;
  schedule?(fn: () => void, delayMs: number): void;
}

/** A connected host / guest pair. Both open() calls resolve once the other side has opened too. */
export interface MemoryTransportPair {
  host: NetTransport;
  guest: NetTransport;
  /** Deliver everything due at the current time (manual scheduling). */
  flush(): void;
  /** Simulate the link dropping: both sides get 'disconnected'. */
  sever(): void;
}

export function createMemoryTransportPair(opts: MemoryLinkOptions = {}): MemoryTransportPair {
  void opts;
  throw new Error('not implemented (NET-02)');
}
