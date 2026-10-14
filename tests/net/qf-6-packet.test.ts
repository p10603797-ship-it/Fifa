/**
 * [QF-6] Input packet size. Every packet repeats up to 10 frames (BRIEF §11); at 19 int16 values a frame that made 404
 * bytes per packet, 60 packets a second: ~24 kB/s each way, so a link under that (a weak hotspot) stalled on every tick
 * (netsim at 16 kB/s: 7,600 stalls in one short match). Frames are now sent sparse (a mask of the non-zero values, and a
 * 3-byte marker for a frame equal to the previous one): the same match fits in ~5 kB/s.
 */
import { describe, expect, it } from 'vitest';
import { decodeInputPacket, encodeInputPacket, FRAME_INTS, inputPacketBytes, PACKET_HEADER_BYTES } from '../../src/net/packet';
import type { InputPacket } from '../../src/net/types';
import { netsimConfig, runNetsim } from '../../tools/netsim';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomPacket(r: () => number): InputPacket {
  const count = 1 + Math.floor(r() * 12);
  const data = new Int16Array(count * FRAME_INTS + Math.floor(r() * 3)); // extra values are ignored
  for (let i = 0; i < count; i++) {
    const o = i * FRAME_INTS;
    if (i > 0 && r() < 0.4) {
      for (let k = 0; k < FRAME_INTS; k++) data[o + k] = data[o - FRAME_INTS + k]!; // a held stick
      continue;
    }
    for (let k = 0; k < FRAME_INTS; k++) {
      const x = r();
      data[o + k] = x < 0.6 ? 0 : x < 0.8 ? Math.floor(r() * 255) - 127 : Math.floor(r() * 65536) - 32768;
    }
  }
  return { firstTick: Math.floor(r() * 100000), count, ack: Math.floor(r() * 1000) - 1, tick: Math.floor(r() * 1000) - 1, adv: Math.round((r() * 20 - 10) * 16) / 16 || 0, data };
}

describe('QF-6 sparse input packets', () => {
  it('round-trip 5,000 random packets bit-exactly (zeros, extremes, repeated frames) and never exceed the old worst case by more than the masks', () => {
    const r = rng(42);
    for (let n = 0; n < 5000; n++) {
      const p = randomPacket(r);
      const bytes = encodeInputPacket(p);
      expect(bytes.byteLength).toBeLessThanOrEqual(inputPacketBytes(p.count));
      const q = decodeInputPacket(bytes)!;
      expect(q, `packet ${n}`).not.toBeNull();
      expect([q.firstTick, q.count, q.ack, q.tick, q.adv]).toEqual([p.firstTick, p.count, p.ack, p.tick, p.adv]);
      expect(Array.from(q.data)).toEqual(Array.from(p.data.subarray(0, p.count * FRAME_INTS)));
    }
  });

  it('a typical 10-frame packet (stick + sprint, mostly repeated) is a fraction of the old 404 bytes', () => {
    const data = new Int16Array(10 * FRAME_INTS);
    for (let i = 0; i < 10; i++) {
      data[i * FRAME_INTS] = i < 6 ? 90 : 100; // mx
      data[i * FRAME_INTS + 1] = -40; // mz
      data[i * FRAME_INTS + 4] = 0x10; // buttons
    }
    const bytes = encodeInputPacket({ firstTick: 500, count: 10, ack: 495, tick: 497, adv: 0, data });
    expect(bytes.byteLength).toBe(PACKET_HEADER_BYTES + 2 * (3 + 6) + 8 * 3);
    expect(bytes.byteLength).toBeLessThan(80);
  });

  it('rejects malformed sparse data without throwing', () => {
    const data = new Int16Array(3 * FRAME_INTS);
    data[0] = 5;
    data[FRAME_INTS] = 5; // frame 1 = frame 0 -> repeat marker
    data[2 * FRAME_INTS + 3] = -7;
    const good = encodeInputPacket({ firstTick: 9, count: 3, ack: 8, tick: 8, adv: 0, data });
    expect(decodeInputPacket(good)).not.toBeNull();
    for (let cut = 1; cut < good.byteLength - PACKET_HEADER_BYTES; cut++) {
      expect(decodeInputPacket(good.slice(0, good.byteLength - cut)), `cut ${cut}`).toBeNull();
    }
    const longer = new Uint8Array(good.byteLength + 1);
    longer.set(new Uint8Array(good));
    expect(decodeInputPacket(longer)).toBeNull(); // trailing byte
    const firstRepeat = new Uint8Array(good.slice(0));
    firstRepeat[PACKET_HEADER_BYTES] = 0;
    firstRepeat[PACKET_HEADER_BYTES + 1] = 0;
    firstRepeat[PACKET_HEADER_BYTES + 2] = 0x80; // "same as previous" on the first frame
    expect(decodeInputPacket(firstRepeat)).toBeNull();
    const highBits = new Uint8Array(good.slice(0));
    highBits[PACKET_HEADER_BYTES + 2] |= 0x10; // a value bit past the last field
    expect(decodeInputPacket(highBits)).toBeNull();
  });

  it('a 12 kB/s link at 80 ms each way stays playable (was: a stall on every tick past ~24 kB/s)', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 12 }), maxTicks: 2400,
      link: { latencyMs: 80, jitterMs: 10, loss: 0.02, bandwidthBytesPerSec: 12_000, seed: 12 },
    });
    expect(r.ok).toBe(true);
    const secs = r.virtualMs / 1000;
    expect(r.link.hostToGuest.bytesSent / secs).toBeLessThan(9_000);
    for (const p of [r.host, r.guest]) {
      expect(p.stallsAfterWarmup).toBeLessThan(40);
      expect(p.maxStallAfterWarmupMs).toBeLessThanOrEqual(50);
    }
  });
});
