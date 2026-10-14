/**
 * [NET-04] Round-trip measurement, adaptive input delay with an agreed switch tick, redundancy (encoder / decoder
 * with de-duplication) and loss tolerance, plus the frame-advantage time sync. No network.
 */
import { describe, expect, it } from 'vitest';
import { createInputFrame } from '../../src/contracts/input';
import { T_NET } from '../../src/contracts/tuning';
import {
  computeTargetDelay, createAdaptiveDelay, createDelaySync, createFrameRing, createRttEstimator, createRttMeter,
  createTimeSync, CTRL_DELAY, decodeRedundant, encodeRedundant, NET_DELAY_MAX, NET_DELAY_MIN, NET_DELAY_START, NET_REDUNDANCY,
  TICK_MS,
} from '../../src/net/adaptive';
import { FRAME_INTS } from '../../src/net/packet';
import type { ControlMessage, InputPacket } from '../../src/net/types';
import { netsimConfig, runNetsim } from '../../tools/netsim';

describe('NET-04 delay formula and constants', () => {
  it('follows clamp(ceil((rtt/2 + 2*jitter) / tickMs) + 1, 2, 8)', () => {
    expect([NET_DELAY_MIN, NET_DELAY_MAX, NET_DELAY_START, NET_REDUNDANCY]).toEqual([T_NET.delayMin, T_NET.delayMax, T_NET.delayInitial, T_NET.redundancy]);
    expect(computeTargetDelay(0, 0)).toBe(2);
    expect(computeTargetDelay(50, 5)).toBe(4); // (25 + 10) / 16.67 = 2.1 -> 3 + 1
    expect(computeTargetDelay(160, 7)).toBe(7); // (80 + 14) / 16.67 = 5.64 -> 6 + 1
    expect(computeTargetDelay(400, 50)).toBe(8);
    expect(computeTargetDelay(Number.NaN, 0)).toBe(8);
    expect(computeTargetDelay(2 * TICK_MS, 0)).toBe(2); // exactly one tick one way -> 1 + 1
  });
});

describe('NET-04 round-trip measurement', () => {
  it('smooths samples RFC 6298 style and ignores implausible ones', () => {
    const e = createRttEstimator();
    expect(e.add(100)).toBe(true);
    expect([e.rttMs, e.jitterMs]).toEqual([100, 50]);
    expect(e.add(-1)).toBe(false);
    expect(e.add(Number.NaN)).toBe(false);
    expect(e.add(60_000)).toBe(false);
    for (let i = 0; i < 60; i++) e.add(100 + (i % 2 === 0 ? 10 : -10));
    expect(e.rttMs).toBeGreaterThan(95);
    expect(e.rttMs).toBeLessThan(105);
    expect(e.jitterMs).toBeGreaterThan(5);
    expect(e.jitterMs).toBeLessThan(15);
    expect(e.samples).toBe(61);
  });

  it('pings every interval and times the echo with its own clock', () => {
    const toB: ControlMessage[] = [];
    const toA: ControlMessage[] = [];
    const samples: number[] = [];
    const a = createRttMeter({ send: (m) => toB.push(m), intervalMs: 500, onSample: (s) => samples.push(s) });
    const b = createRttMeter({ send: (m) => toA.push(m), intervalMs: 0 });
    a.pump(1000);
    a.pump(1200); // not due yet
    expect(toB.map((m) => m.type)).toEqual(['$ping']);
    expect(b.handle(toB[0]!, 50_000)).toBe(true); // the other clock does not matter
    expect(toA.map((m) => m.type)).toEqual(['$pong']);
    expect(a.handle(toA[0]!, 1080)).toBe(true);
    expect(samples).toEqual([80]);
    expect(a.rttMs).toBe(80);
    expect(a.handle({ type: 'lobby:x' }, 0)).toBe(false);
    a.pump(1500);
    expect(toB.length).toBe(2);
  });
});

describe('NET-04 adaptive delay controller (synthetic RTT series)', () => {
  it('drops to 2 on a LAN only after sustained slack, raises within two samples, ignores single spikes', () => {
    const d = createAdaptiveDelay();
    expect(d.target).toBe(3);
    const trace: number[] = [];
    for (let i = 0; i < 40; i++) {
      d.sample(20);
      trace.push(d.target);
    }
    expect(trace.slice(0, 7).every((t) => t === 3)).toBe(true); // hysteresis: no instant drop
    expect(trace.at(-1)).toBe(2);
    // Latency jumps to 160 ms round trip: raised after exactly two samples.
    d.sample(160);
    expect(d.target).toBe(2);
    d.sample(160);
    expect(d.target).toBeGreaterThanOrEqual(7);
    // Settles after the lowering hold, keeping the margin: raw (80 / 16.67 + 1 = 5.8) is within LOWER_MARGIN of 6,
    // so 7 stays (one step down needs a quarter tick of slack).
    for (let i = 0; i < 60; i++) d.sample(160);
    expect(computeTargetDelay(d.rttMs, d.jitterMs)).toBe(6);
    expect(d.target).toBe(7);
    // One spike does not raise (the jitter estimate jumps, but the following samples fall back below the average).
    d.sample(600);
    for (let i = 0; i < 6; i++) d.sample(160);
    expect(d.target).toBe(7);
    // A sustained increase does.
    d.sample(260);
    d.sample(260);
    expect(d.target).toBe(8);
    for (let i = 0; i < 80; i++) d.sample(60);
    expect(d.target).toBe(computeTargetDelay(d.rttMs, d.jitterMs));
    // Clamped at 8 on a terrible link.
    for (let i = 0; i < 10; i++) d.sample(900);
    expect(d.target).toBe(8);
  });

  it('changes delayFor only at agreed ticks', () => {
    const d = createAdaptiveDelay({ initial: 3 });
    expect(d.delayFor(10)).toBe(3);
    d.schedule(6, 100);
    expect(d.delayFor(99)).toBe(3);
    expect(d.delayFor(100)).toBe(6);
    expect(d.delay).toBe(6);
    d.schedule(9, 200); // clamped to 8
    d.schedule(4, 150); // replaces the later one
    expect(d.switches).toEqual([{ delay: 6, atTick: 100 }, { delay: 4, atTick: 150 }]);
    expect(d.delayFor(160)).toBe(4);
    expect(d.delayFor(120)).toBe(6); // history kept for re-simulation after a resync
    expect(d.scheduled).toBe(4);
  });
});

describe('NET-04 delay agreement', () => {
  it('the host announces the larger target at a future tick and both sides switch on that tick', () => {
    const toGuest: ControlMessage[] = [];
    const toHost: ControlMessage[] = [];
    const ha = createAdaptiveDelay();
    const ga = createAdaptiveDelay();
    const host = createDelaySync({ isHost: true, adaptive: ha, send: (m) => toGuest.push(m) });
    const guest = createDelaySync({ isHost: false, adaptive: ga, send: (m) => toHost.push(m) });
    // The guest sees a bad link (its target rises), the host a good one.
    for (let i = 0; i < 4; i++) ga.sample(200);
    for (let i = 0; i < 4; i++) ha.sample(10);
    guest.update(100);
    expect(toHost).toEqual([{ type: 'ls:target', target: ga.target }]);
    for (const m of toHost.splice(0)) host.handle(m);
    host.update(102);
    const ann = toGuest.find((m) => m.type === CTRL_DELAY)!;
    expect(ann.delay).toBe(ga.target);
    expect(ann.at).toBeGreaterThanOrEqual(102 + 45);
    host.update(103); // one switch in flight at a time
    expect(toGuest.filter((m) => m.type === CTRL_DELAY).length).toBe(1);
    guest.update(104);
    for (const m of toGuest.splice(0)) guest.handle(m);
    expect(ga.switches).toEqual(ha.switches);
    const at = ann.at as number;
    expect([ha.delayFor(at - 1), ga.delayFor(at - 1)]).toEqual([3, 3]);
    expect([ha.delayFor(at), ga.delayFor(at)]).toEqual([ga.target, ga.target]);
    expect(guest.late).toBe(0);
    expect(host.changes).toBe(1);
  });

  it('an announcement that arrives after its tick applies on the guest`s next tick', () => {
    const ga = createAdaptiveDelay();
    const guest = createDelaySync({ isHost: false, adaptive: ga, send: () => {} });
    guest.update(500);
    guest.handle({ type: CTRL_DELAY, delay: 7, at: 480 });
    expect(guest.late).toBe(1);
    expect(ga.switches).toEqual([{ delay: 7, atTick: 501 }]);
    expect(guest.handle({ type: 'lobby:x' })).toBe(false);
  });

  it('both peers switch delay at the same tick when the link gets worse mid-match (netsim)', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 21 }),
      maxTicks: 1500,
      link: { latencyMs: 5, jitterMs: 2, seed: 21 },
      linkChanges: [{ atMs: 8000, conditions: { latencyMs: 80, jitterMs: 20 } }],
    });
    expect(r.ok).toBe(true);
    expect(r.host.switches.length).toBeGreaterThanOrEqual(2); // down on the LAN-like link, then up
    expect(r.guest.switches).toEqual(r.host.switches);
    expect(r.guest.lateDelaySwitches).toBe(0);
    expect(r.host.delayMin).toBe(2);
    expect(r.host.delayFinal).toBe(8);
  });
});

describe('NET-04 redundancy', () => {
  function ringWith(first: number, last: number): ReturnType<typeof createFrameRing> {
    const ring = createFrameRing(64, 1);
    const f = createInputFrame();
    for (let t = first; t <= last; t++) {
      f.mx = t;
      ring.putFrame(t, f);
    }
    return ring;
  }
  const pkt = (): InputPacket => ({ firstTick: 0, count: 0, ack: -1, tick: 0, adv: 0, data: new Int16Array(NET_REDUNDANCY * FRAME_INTS) });

  it('every packet repeats the newest unacknowledged frames, at most 10', () => {
    const ring = ringWith(1, 30);
    const p = pkt();
    expect(encodeRedundant(ring, 30, 0, 17, 'newest', NET_REDUNDANCY, p)).toBe(true);
    expect([p.firstTick, p.count, p.ack]).toEqual([21, 10, 17]);
    expect(encodeRedundant(ring, 30, 26, 17, 'newest', NET_REDUNDANCY, p)).toBe(true);
    expect([p.firstTick, p.count]).toEqual([27, 4]); // acknowledged frames are not repeated
    expect(encodeRedundant(ring, 30, 30, 17, 'newest', NET_REDUNDANCY, p)).toBe(true);
    expect([p.firstTick, p.count]).toEqual([30, 1]); // always at least the newest (carries our ack)
    // Catch-up resends start at the oldest frame the other side is missing.
    expect(encodeRedundant(ring, 30, 4, 17, 'catch-up', NET_REDUNDANCY, p)).toBe(true);
    expect([p.firstTick, p.count]).toEqual([5, 10]);
    expect(encodeRedundant(ring, 0, -1, -1, 'newest', NET_REDUNDANCY, p)).toBe(false);
  });

  it('the decoder de-duplicates by tick and ignores known or absurd ticks', () => {
    const src = ringWith(1, 40);
    const dst = createFrameRing(64, 1);
    const p = pkt();
    encodeRedundant(src, 10, 0, 0, 'newest', NET_REDUNDANCY, p); // ticks 1..10
    expect(decodeRedundant(p, dst)).toBe(10);
    expect(decodeRedundant(p, dst)).toBe(0); // duplicate packet
    expect(dst.contiguous).toBe(10);
    encodeRedundant(src, 14, 0, 0, 'newest', NET_REDUNDANCY, p); // ticks 5..14: only 11..14 are new
    expect(decodeRedundant(p, dst)).toBe(4);
    const far = { ...p, firstTick: 14 + 40 }; // more than half the ring ahead
    expect(decodeRedundant(far, dst)).toBe(0);
    const f = createInputFrame();
    expect(dst.getFrame(12, f)).toBe(true);
    expect(f.mx).toBe(12);
  });

  it('redundancy recovers 5% loss without stalls at 80 ms each way and 20 ms jitter', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 33 }),
      maxTicks: 1800,
      delay: 8,
      adaptive: false,
      startOffsetMs: 0,
      warmupTicks: 60,
      link: { latencyMs: 80, jitterMs: 20, loss: 0.05, reliableLoss: 0.05, seed: 33 },
    });
    const dropped = r.link.hostToGuest.inputsDropped + r.link.guestToHost.inputsDropped;
    expect(dropped).toBeGreaterThan(100); // 5 % of ~3,600 packets
    expect(r.host.stallsAfterWarmup).toBe(0);
    expect(r.guest.stallsAfterWarmup).toBe(0);
    expect(r.host.resends + r.guest.resends).toBeLessThan(10); // redundancy did the work, not resends
    expect(r.ok).toBe(true);
  });

  it('with adaptive delay the same link settles at 8 and stalls stay rare and short after warm-up', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 34 }),
      maxTicks: 2400,
      link: { latencyMs: 80, jitterMs: 20, loss: 0.05, reliableLoss: 0.05, seed: 34 },
    });
    expect(r.ok).toBe(true);
    expect(r.host.delayFinal).toBe(8);
    for (const p of [r.host, r.guest]) {
      expect(p.stallsAfterWarmup).toBeLessThanOrEqual(10);
      expect(p.maxStallAfterWarmupMs).toBeLessThanOrEqual(34);
    }
  });
});

describe('NET-04 time sync', () => {
  it('asks the side that runs ahead to shed its advantage, once per cooldown', () => {
    const ts = createTimeSync();
    // We are at tick t + 4 whenever a packet stamped t arrives; the other side sees us 0 ahead + latency 1.
    for (let i = 0; i < 40; i++) ts.onPacket(104 + i, 100 + i, -2);
    expect(ts.advantage).toBeCloseTo(3, 1);
    expect(ts.poll(10_000)).toBe(3);
    expect(ts.poll(10_500)).toBe(0); // cooling down
    expect([ts.holds, ts.heldTicks]).toEqual([1, 3]);
    const behind = createTimeSync();
    for (let i = 0; i < 40; i++) behind.onPacket(100 + i, 104 + i, 6);
    expect(behind.advantage).toBeLessThan(0);
    expect(behind.poll(10_000)).toBe(0); // only the leader holds
  });

  it('a late-starting guest is absorbed by one hold instead of periodic stalls (netsim)', async () => {
    // 70 ms start offset at 60 ms latency and delay 8: the host's frames always arrive in time, the guest's arrive
    // ~7 ms late, so without time sync the host stalls briefly (and catches up) all match long.
    const run = (timeSync: boolean) => runNetsim({
      config: netsimConfig({ seed: 8 }),
      maxTicks: 2400,
      delay: 8,
      adaptive: false,
      timeSync,
      startOffsetMs: 70,
      warmupTicks: 240,
      link: { latencyMs: 60, jitterMs: 10, seed: 8 },
    });
    const off = await run(false);
    expect(off.ok).toBe(true);
    expect(off.host.stallsAfterWarmup).toBeGreaterThan(20);
    const on = await run(true);
    expect(on.ok).toBe(true);
    expect(on.host.holds).toBeGreaterThanOrEqual(1);
    expect(Math.abs(on.host.advantage)).toBeLessThan(1.5);
    expect(on.host.stallsAfterWarmup + on.guest.stallsAfterWarmup).toBeLessThanOrEqual(1);
  });
});
