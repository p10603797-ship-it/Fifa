/** FND-03: tests for the lead-owned preallocated event buffer in src/sim/core/events.ts. */
import { describe, expect, it } from 'vitest';
import { EventType, MAX_EVENTS_PER_TICK } from '../../src/contracts/events';
import { createEventBuffer, NULL_SINK } from '../../src/sim/core/events';

describe('createEventBuffer', () => {
  it('starts empty with the default capacity MAX_EVENTS_PER_TICK', () => {
    const ev = createEventBuffer();
    expect(ev.count).toBe(0);
    expect(ev.dropped).toBe(0);
    ev.begin(1);
    for (let i = 0; i < MAX_EVENTS_PER_TICK + 5; i++) ev.emit(EventType.BOUNCE, i);
    expect(ev.count).toBe(MAX_EVENTS_PER_TICK);
    expect(ev.dropped).toBe(5);
  });

  it('stamps the tick from begin() and defaults unused params to 0', () => {
    const ev = createEventBuffer(8);
    ev.begin(42);
    ev.emit(EventType.GOAL, 1, 9);
    ev.emit(EventType.KICK, 3, 4, 0.5, 1, 10, 0.11, -2);
    expect(ev.count).toBe(2);
    expect(ev.get(0)).toEqual({ type: EventType.GOAL, tick: 42, a: 1, b: 9, c: 0, d: 0, x: 0, y: 0, z: 0 });
    expect(ev.get(1)).toEqual({ type: EventType.KICK, tick: 42, a: 3, b: 4, c: 0.5, d: 1, x: 10, y: 0.11, z: -2 });
  });

  it('begin() clears the count and the dropped counter', () => {
    const ev = createEventBuffer(2);
    ev.begin(1);
    ev.emit(EventType.KICK); ev.emit(EventType.KICK); ev.emit(EventType.KICK);
    expect(ev.dropped).toBe(1);
    ev.begin(2);
    expect(ev.count).toBe(0);
    expect(ev.dropped).toBe(0);
    expect(ev.toArray()).toEqual([]);
  });

  it('overflow keeps the first events and drops the rest', () => {
    const ev = createEventBuffer(3);
    ev.begin(7);
    for (let i = 0; i < 6; i++) ev.emit(EventType.BOUNCE, i);
    expect(ev.toArray().map((e) => e.a)).toEqual([0, 1, 2]);
    expect(ev.dropped).toBe(3);
  });

  it('reuses preallocated event objects (no allocation per emit)', () => {
    const ev = createEventBuffer(4);
    ev.begin(1);
    ev.emit(EventType.KICK, 1);
    const first = ev.get(0);
    ev.begin(2);
    ev.emit(EventType.SAVE, 2);
    expect(ev.get(0)).toBe(first);
    expect(first.type).toBe(EventType.SAVE);
    expect(first.tick).toBe(2);
  });

  it('toArray returns detached copies of this tick only', () => {
    const ev = createEventBuffer(4);
    ev.begin(1);
    ev.emit(EventType.KICK, 1);
    ev.emit(EventType.BOUNCE, 2);
    const arr = ev.toArray();
    expect(arr.length).toBe(2);
    expect(arr[0]).not.toBe(ev.get(0));
    ev.begin(2);
    ev.emit(EventType.WHISTLE, 9);
    expect(arr[0]!.a).toBe(1);
    expect(ev.toArray().length).toBe(1);
  });

  it('a zero-capacity buffer drops everything', () => {
    const ev = createEventBuffer(0);
    ev.begin(1);
    ev.emit(EventType.KICK);
    expect(ev.count).toBe(0);
    expect(ev.dropped).toBe(1);
  });
});

describe('NULL_SINK', () => {
  it('accepts and discards events', () => {
    expect(() => NULL_SINK.emit()).not.toThrow();
  });
});
