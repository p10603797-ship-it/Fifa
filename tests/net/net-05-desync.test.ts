/**
 * [NET-05] Hash exchange, desync detection and snapshot resync: snapshot round trips (JSON and gzip), injected
 * divergence detected within 30 ticks and repaired on either side, hard-sync when the guest is ahead of or behind the
 * snapshot tick, logs with seed / tick / inputs / diff, and no false positives over a long run.
 */
import { describe, expect, it } from 'vitest';
import { createInputFrame, type InputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import {
  compressionAvailable, createDesyncGuard, CTRL_HASH, CTRL_SNAP, CTRL_SNAP_OK, decodeSnapshot, encodeSnapshot, encodeSnapshotSync,
  HASH_INTERVAL_TICKS, SNAPSHOT_CHUNK_CHARS,
} from '../../src/net/desync';
import type { ControlMessage } from '../../src/net/types';
import { cloneState, diffState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { hashState } from '../../src/sim/core/hash';
import { serializeState } from '../../src/sim/core/serialize';
import { initMatch } from '../../src/sim/init';
import { step } from '../../src/sim/step';
import { netsimConfig, runNetsim } from '../../tools/netsim';

function playedState(ticks: number, seed = 4): SimState {
  const s = initMatch(netsimConfig({ seed }));
  const ev = createEventBuffer();
  const fr: InputFrame[] = [createInputFrame(), createInputFrame()];
  for (let i = 0; i < ticks; i++) {
    fr[0]!.mx = (i * 7) % 255 - 127;
    fr[1]!.mz = (i * 13) % 255 - 127;
    step(s, fr, ev);
  }
  return s;
}

describe('NET-05 snapshots', () => {
  it('round-trip bit-exactly as JSON and as gzip + base64, in chunks', async () => {
    const s = playedState(240);
    const sync = encodeSnapshotSync(s);
    expect(sync.codec).toBe('json');
    expect(sync.tick).toBe(240);
    for (const c of sync.chunks) expect(c.length).toBeLessThanOrEqual(SNAPSHOT_CHUNK_CHARS);
    const a = await decodeSnapshot('json', sync.chunks);
    expect(hashState(a)).toBe(hashState(s));
    expect(diffState(a, s)).toBeNull();
    expect(compressionAvailable()).toBe(true); // Node 18+ and Safari 16.4+
    const gz = await encodeSnapshot(s, 'gzip');
    expect(gz.codec).toBe('gzip');
    expect(gz.chars).toBeLessThan(sync.chars / 2);
    const b = await decodeSnapshot('gzip', gz.chunks);
    expect(hashState(b)).toBe(hashState(s));
    expect(serializeState(b)).toBe(serializeState(s));
  });

  it('captures the state synchronously, so stepping on during compression cannot leak into the snapshot', async () => {
    const s = playedState(60);
    const want = hashState(s);
    const pending = encodeSnapshot(s, 'gzip');
    step(s, [createInputFrame(), createInputFrame()], createEventBuffer());
    const got = await decodeSnapshot('gzip', (await pending).chunks);
    expect(got.tick).toBe(60);
    expect(hashState(got)).toBe(want);
  });

  it('rejects corrupt or hostile snapshots', async () => {
    const s = playedState(10);
    const json = encodeSnapshotSync(s).chunks.join('');
    await expect(decodeSnapshot('json', [json.slice(0, json.length - 5)])).rejects.toThrow();
    await expect(decodeSnapshot('json', ['{"__proto__":{"x":1}}'])).rejects.toThrow(SyntaxError);
    await expect(decodeSnapshot('gzip', ['bm90IGd6aXA='])).rejects.toThrow();
  });
});

/** Two guards wired back to back through queues (delivered when flushed). */
function guardPair(log?: (k: string, m: string, d?: unknown) => void) {
  const toGuest: ControlMessage[] = [];
  const toHost: ControlMessage[] = [];
  const host = createDesyncGuard({ isHost: true, send: (m) => toGuest.push(JSON.parse(JSON.stringify(m)) as ControlMessage), log, compress: 'none' });
  const guest = createDesyncGuard({ isHost: false, send: (m) => toHost.push(JSON.parse(JSON.stringify(m)) as ControlMessage), log, compress: 'none' });
  const flush = (): void => {
    while (toGuest.length || toHost.length) {
      for (const m of toGuest.splice(0)) guest.handle(m);
      for (const m of toHost.splice(0)) host.handle(m);
    }
  };
  return { host, guest, toGuest, toHost, flush };
}

describe('NET-05 desync guard', () => {
  it('exchanges a hash every 30 ticks (tick 0 included) and reports no false positives over a long identical run', () => {
    expect(HASH_INTERVAL_TICKS).toBe(30);
    const { host, guest, toGuest, flush } = guardPair();
    const a = initMatch(netsimConfig({ seed: 9 }));
    const b = cloneState(a);
    const ev = createEventBuffer();
    const fr: InputFrame[] = [createInputFrame(), createInputFrame()];
    let sent = 0;
    for (let t = 0; t <= 1800; t++) {
      if (host.afterTick(a) >= 0) sent++;
      guest.afterTick(b);
      if (t % 7 === 0) flush(); // hashes arrive late and in bursts
      fr[0]!.mx = (t * 31) % 255 - 127;
      step(a, fr, ev);
      step(b, fr, ev);
    }
    flush();
    expect(sent).toBe(61);
    expect(toGuest.length).toBe(0);
    expect(host.stats.hashesCompared).toBe(61);
    expect(guest.stats.hashesCompared).toBe(61);
    expect(host.desyncs + guest.desyncs).toBe(0);
  });

  it('detects a mismatch on both sides, the host sends a snapshot and a guest that is ahead rewinds to it', () => {
    const logs: { m: string; d: unknown }[] = [];
    const { host, guest, toGuest, toHost, flush } = guardPair((_k, m, d) => logs.push({ m, d }));
    const a = playedState(90);
    const b = cloneState(a);
    b.ball.vx += 1; // divergence at tick 90
    expect(host.afterTick(a)).toBe(hashState(a));
    guest.afterTick(b);
    flush();
    expect(host.desyncs).toBe(1);
    expect(guest.desyncs).toBe(1);
    expect(guest.resyncing).toBe(true);
    // The host's next tick: it captures and sends its state (tick 91).
    step(a, [createInputFrame(), createInputFrame()], createEventBuffer());
    host.afterTick(a);
    const snaps = toGuest.filter((m) => m.type === CTRL_SNAP);
    expect(snaps.length).toBeGreaterThan(0);
    expect(snaps[0]).toMatchObject({ e: 1, tick: 91, codec: 'json', i: 0 });
    for (const m of toGuest.splice(0)) guest.handle(m);
    // The guest is already at tick 95: it rewinds to 91.
    for (let i = 0; i < 5; i++) step(b, [createInputFrame(), createInputFrame()], createEventBuffer());
    expect(b.tick).toBe(95);
    expect(guest.applyPending(b)).toBe(true);
    expect(b.tick).toBe(91);
    expect(hashState(b)).toBe(hashState(a));
    expect(toHost.at(-1)).toEqual({ type: CTRL_SNAP_OK, e: 1, tick: 91, ok: 1 });
    flush();
    expect(host.resyncs).toBe(1);
    expect(host.lastResyncTick).toBe(91);
    expect(guest.lastResyncTick).toBe(91);
    expect(guest.resyncing).toBe(false);
    expect(host.resyncing).toBe(false);
    // The next hash comparison verifies the repair.
    const ev = createEventBuffer();
    const fr = [createInputFrame(), createInputFrame()];
    while (a.tick < 120) step(a, fr, ev);
    while (b.tick < 120) step(b, fr, ev);
    host.afterTick(a);
    guest.afterTick(b);
    flush();
    expect(host.stats.verified).toBe(1);
    expect(guest.stats.verified).toBe(1);
    expect(host.desyncs + guest.desyncs).toBe(2); // the one incident, counted once per side
    // Both logged seed, tick and hashes; the guest also the first differing field.
    const desyncLog = logs.find((l) => l.m.startsWith('desync at tick 90'))!;
    expect(desyncLog.d).toMatchObject({ seed: 4, tick: 90 });
    const synced = logs.find((l) => l.m.includes('hard-synced to tick 91 from tick 95'))!;
    expect(synced.m).toMatch(/first difference: \(local 4 ticks ahead\) \S+/);
    expect(guest.reports[0]!.diff).toMatch(/^\(local 4 ticks ahead\) /);
  });

  it('a guest that is behind the snapshot tick keeps playing until it reaches it', () => {
    const { host, guest, toGuest, flush } = guardPair();
    const a = playedState(30);
    const b = cloneState(a);
    b.rng.a = (b.rng.a ^ 1) >>> 0;
    host.afterTick(a);
    guest.afterTick(b);
    flush();
    const fr = [createInputFrame(), createInputFrame()];
    const ev = createEventBuffer();
    while (a.tick < 36) step(a, fr, ev);
    host.afterTick(a);
    for (const m of toGuest.splice(0)) guest.handle(m);
    expect(b.tick).toBe(30);
    expect(guest.applyPending(b)).toBe(false); // not there yet
    while (b.tick < 36) step(b, fr, ev);
    const before = cloneState(b);
    expect(guest.applyPending(b)).toBe(true);
    expect(hashState(b)).toBe(hashState(a));
    expect(guest.reports[0]!.diff).toBe(diffState(before, a)); // same tick: the real first difference
    expect(guest.reports[0]!.diff).not.toBeNull();
  });

  it('ignores stale guest hashes from before the latest snapshot and retries when the guest cannot decode', () => {
    const { host, guest, toGuest, flush } = guardPair();
    const a = playedState(30);
    const b = cloneState(a);
    b.ball.x += 0.25;
    host.afterTick(a);
    guest.afterTick(b);
    flush();
    host.afterTick(a); // same tick again: no new hash, but the requested snapshot goes out
    expect(toGuest.some((m) => m.type === CTRL_SNAP)).toBe(true);
    toGuest.length = 0;
    // A stale guest hash (epoch 0) for a later tick must not start a second incident.
    expect(host.remoteHash(60, 123, 0)).toBe(false);
    // The guest reports a broken snapshot: the host sends a fresh one at its next tick.
    host.handle({ type: CTRL_SNAP_OK, e: 1, tick: 30, ok: 0 });
    expect(host.resyncing).toBe(true);
    host.afterTick(a);
    const again = toGuest.filter((m) => m.type === CTRL_SNAP);
    expect(again[0]).toMatchObject({ e: 2 });
    for (const m of toGuest.splice(0)) guest.handle(m);
    expect(guest.applyPending(b)).toBe(true);
    expect(guest.stats.epoch).toBe(2);
    expect(host.desyncs).toBe(1);
    expect(guest.handle({ type: CTRL_HASH, tick: 'x' })).toBe(true); // malformed: consumed, ignored
    expect(guest.handle({ type: 'lobby:x' })).toBe(false);
  });
});

describe('NET-05 resync in the two-instance harness', () => {
  it('injected divergence on the guest is detected within 30 ticks and repaired (gzip snapshot)', async () => {
    const logs: string[] = [];
    const r = await runNetsim({
      config: netsimConfig({ seed: 12 }),
      maxTicks: 1500,
      link: { latencyMs: 60, jitterMs: 15, loss: 0.03, reliableLoss: 0.03, seed: 12 },
      injectDesync: { peer: 1, tick: 610 },
      log: (_k, m) => logs.push(m),
    });
    expect(r.injectedAtTick).toBe(610);
    for (const p of [r.host, r.guest]) {
      expect(p.desyncs).toBe(1);
      expect(p.firstDesyncTick).toBeGreaterThan(610);
      expect(p.firstDesyncTick - 610).toBeLessThanOrEqual(30);
      expect(p.resyncs).toBe(1);
    }
    expect(r.host.verified).toBe(1);
    expect(r.hashesEqual).toBe(true);
    expect(r.framesEqual).toBe(true);
    expect(r.ok).toBe(true);
    expect(logs.some((m) => m.includes('[peer 0] resync: snapshot of tick') && m.includes('gzip'))).toBe(true);
    expect(logs.some((m) => m.includes('[peer 0] desync at tick') && m.includes('seed 12'))).toBe(true);
    expect(logs.some((m) => m.includes('[peer 1] desync at tick') && m.includes('seed 12'))).toBe(true);
    expect(logs.some((m) => m.includes('[peer 1] resync: hard-synced') && /first difference: (?!none)/.test(m))).toBe(true);
  });

  it('divergence on the host is repaired too (the host is the authority), with plain JSON snapshots', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 13 }),
      maxTicks: 1200,
      compress: 'none',
      link: { latencyMs: 40, jitterMs: 10, seed: 13 },
      injectDesync: { peer: 0, tick: 400, mutate: (s) => { s.teams[1]!.goals += 1; } },
    });
    expect(r.host.desyncs).toBe(1);
    expect(r.guest.resyncs).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.goals[1]).toBeGreaterThanOrEqual(1); // the guest adopted the host's (mutated) state
  });
});
