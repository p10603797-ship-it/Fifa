/**
 * Event buffer (preallocated, no allocation per tick). [FND-03]
 */
import { MAX_EVENTS_PER_TICK, type EventBuffer, type EventType, type SimEvent } from '../../contracts/events';

export interface EventBufferImpl extends EventBuffer {
  /** Events dropped because the buffer was full this tick. */
  readonly dropped: number;
  /** Copy of the events of the last tick (testing). Allocates. */
  toArray(): SimEvent[];
}

/**
 * [FIN-P skeptic] One class, so every buffer shares the same begin / emit / get functions. The closure-based buffer
 * (an object literal of arrow / method closures per createEventBuffer call) gave each buffer its own function objects:
 * code the sim warm-up (sim/init.ts warmUpSim, its own buffer) had optimised with a call target of the warm-up's
 * buffer deoptimised ("wrong call target") the first time it called the match's buffer, `step` itself on the match's
 * first tick (events.begin), then every function at its first emit, and ran unoptimised (boxing every double) until
 * re-optimised: the first ~1500 ticks of the bench match allocated ~22 KB a tick under step()
 * (tests/perf/fin-p-bench-alloc.test.ts). Same behaviour, same API.
 */
class SimEventBuffer implements EventBufferImpl {
  private readonly items: SimEvent[];
  private readonly capacity: number;
  private n = 0;
  private t = 0;
  private lost = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.items = Array.from({ length: capacity }, () => ({ type: 0 as EventType, tick: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0 }));
  }

  get count(): number { return this.n; }

  get dropped(): number { return this.lost; }

  get(i: number): SimEvent { return this.items[i]!; }

  begin(t: number): void { this.n = 0; this.lost = 0; this.t = t; }

  emit(type: EventType, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0): void {
    if (this.n >= this.capacity) { this.lost++; return; }
    const e = this.items[this.n++]!;
    e.type = type; e.tick = this.t; e.a = a; e.b = b; e.c = c; e.d = d; e.x = x; e.y = y; e.z = z;
  }

  toArray(): SimEvent[] { return this.items.slice(0, this.n).map((e) => ({ ...e })); }
}

export function createEventBuffer(capacity: number = MAX_EVENTS_PER_TICK): EventBufferImpl {
  return new SimEventBuffer(capacity);
}

/** A sink that discards everything (predictions, AI look-ahead). */
export const NULL_SINK = { emit() { /* discard */ } };
