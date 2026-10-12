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

export function createEventBuffer(capacity: number = MAX_EVENTS_PER_TICK): EventBufferImpl {
  const items: SimEvent[] = Array.from({ length: capacity }, () => ({ type: 0 as EventType, tick: 0, a: 0, b: 0, c: 0, d: 0, x: 0, y: 0, z: 0 }));
  let count = 0;
  let tick = 0;
  let dropped = 0;
  return {
    get count() { return count; },
    get dropped() { return dropped; },
    get(i: number) { return items[i]!; },
    begin(t: number) { count = 0; dropped = 0; tick = t; },
    emit(type: EventType, a = 0, b = 0, c = 0, d = 0, x = 0, y = 0, z = 0) {
      if (count >= capacity) { dropped++; return; }
      const e = items[count++]!;
      e.type = type; e.tick = tick; e.a = a; e.b = b; e.c = c; e.d = d; e.x = x; e.y = y; e.z = z;
    },
    toArray() { return items.slice(0, count).map((e) => ({ ...e })); },
  };
}

/** A sink that discards everything (predictions, AI look-ahead). */
export const NULL_SINK = { emit() { /* discard */ } };
