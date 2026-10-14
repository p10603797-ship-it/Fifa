/**
 * [NET-01] Lockstep core: identical frame streams and sim hashes on both peers under latency, reordering, duplication
 * and loss; stalls (never guesses) when a remote frame is missing; neutral start frames; commands inside frames;
 * arrival order never matters. Uses the in-memory transport / netsim harness only (no network).
 */
import { describe, expect, it } from 'vitest';
import { Command } from '../../src/contracts/enums';
import { Btn, clearInputFrame, createInputFrame, type InputFrame, type InputSource } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { createLockstepProvider, RESEND_WAITING_MS } from '../../src/net/lockstep';
import { createManualClock, createMemoryTransportPair } from '../../src/net/memoryTransport';
import { createEmitter, FRAME_INTS, unpackSenderFrame } from '../../src/net/packet';
import type { ControlMessage, InputPacket, NetTransport, TransportEvent } from '../../src/net/types';
import { initMatch } from '../../src/sim/init';
import { netsimConfig, runNetsim } from '../../tools/netsim';

/** Input source returning a scripted frame for each sampled (target) tick. */
function scripted(fn: (tick: number, out: InputFrame) => void): InputSource & { calls: number[] } {
  const calls: number[] = [];
  return {
    id: 'scripted', kind: 'net', calls,
    sample(out, ctx) {
      calls.push(ctx.tick);
      fn(ctx.tick, out);
    },
    releaseAll() {},
    dispose() {},
  };
}

/** Minimal NetTransport that records what is sent and lets the test deliver packets by hand. */
function fakeTransport(role: 'host' | 'guest'): NetTransport & {
  sent: InputPacket[]; control: ControlMessage[]; deliver(p: InputPacket): void; deliverControl(m: ControlMessage): void;
} {
  const inputs = createEmitter<InputPacket>();
  const reliable = createEmitter<ControlMessage>();
  const events = createEmitter<TransportEvent>();
  const sent: InputPacket[] = [];
  const control: ControlMessage[] = [];
  return {
    state: 'open', role, rtt: 0, jitter: 0, sent, control,
    open: () => Promise.resolve(),
    reconnect: () => Promise.resolve(),
    sendInputs(p) {
      sent.push({ ...p, data: p.data.slice(0, p.count * FRAME_INTS) });
    },
    sendReliable(m) {
      control.push(m);
    },
    onInputs: (fn) => inputs.on(fn),
    onReliable: (fn) => reliable.on(fn),
    onEvent: (fn) => events.on(fn),
    close() {},
    deliver: (p) => inputs.emit(p),
    deliverControl: (m) => reliable.emit(m),
  };
}

function frames2(): InputFrame[] {
  return [createInputFrame(), createInputFrame()];
}

/** Packet carrying `frames` for ticks first.. (as the other side would send it). */
function packetOf(first: number, list: InputFrame[], ack = -1): InputPacket {
  const data = new Int16Array(list.length * FRAME_INTS);
  // Mirrors packFrames for one human (INPUT_FIELDS order; NET-02 tests the real codec).
  for (let i = 0; i < list.length; i++) {
    const f = list[i]!;
    const vals = [f.mx, f.mz, f.ax, f.az, f.buttons & 0xffff, f.power, f.curve, f.skill, f.cmd, f.cmdArg, f.gesture, f.gx, f.gz,
      f.gSlot, f.gdx, f.gdz, f.gPower, f.gCurve, f.gFlags & 0xffff];
    for (let k = 0; k < FRAME_INTS; k++) data[i * FRAME_INTS + k] = vals[k]!;
  }
  return { firstTick: first, count: list.length, ack, tick: first - 1, adv: 0, data };
}

describe('NET-01 lockstep: two peers stay identical', () => {
  it('produce identical frame streams and identical sim hashes over 3,000 ticks with random latency, reordering, duplication and loss', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 101 }),
      maxTicks: 3000,
      link: { latencyMs: 35, jitterMs: 70, duplicate: 0.15, reorder: 0.15, reorderMs: 60, loss: 0.05, reliableLoss: 0.05, seed: 101 },
    });
    expect(r.host.ticks).toBe(3000);
    expect(r.guest.ticks).toBe(3000);
    expect(r.framesEqual).toBe(true);
    expect(r.firstFrameMismatch).toBe(-1);
    expect(r.hashesEqual).toBe(true);
    expect(r.host.desyncs + r.guest.desyncs).toBe(0);
    expect(r.host.duplicateFrames).toBeGreaterThan(0); // redundancy + duplication delivered copies that were ignored
    expect(r.link.hostToGuest.inputsDuplicated + r.link.hostToGuest.inputsReordered).toBeGreaterThan(50);
    expect(r.ok).toBe(true);
  });

  it('recovers from a burst that loses every input packet for 600 ms (catch-up resends, no deadlock)', async () => {
    const r = await runNetsim({
      config: netsimConfig({ seed: 5 }),
      maxTicks: 900,
      link: { latencyMs: 20, jitterMs: 5, seed: 5 },
      linkChanges: [{ atMs: 4000, conditions: { loss: 1 } }, { atMs: 4600, conditions: { loss: 0 } }],
    });
    expect(r.host.ticks).toBe(900);
    expect(r.guest.ticks).toBe(900);
    expect(r.framesEqual && r.hashesEqual).toBe(true);
    expect(r.host.maxStallMs).toBeGreaterThan(400); // the burst really held both sims
    expect(r.host.resends + r.guest.resends).toBeGreaterThan(0);
  });
});

describe('NET-01 lockstep provider', () => {
  it('stalls when a remote frame is missing and never guesses it', async () => {
    const clock = createManualClock();
    const pair = createMemoryTransportPair({ latencyMs: 10, pingIntervalMs: 0, now: clock.now, schedule: clock.schedule });
    const opened = Promise.all([pair.host.open('host', 'X'), pair.guest.open('guest', 'X')]);
    clock.advance(50);
    await opened;
    const hostSrc = scripted((_t, out) => { out.mx = 50; });
    const guestSrc = scripted((_t, out) => { out.mz = -60; });
    const host = createLockstepProvider({ transport: pair.host, localHuman: 0, localSources: [hostSrc], delay: 3, adaptive: false });
    const guest = createLockstepProvider({ transport: pair.guest, localHuman: 1, localSources: [guestSrc], delay: 3, adaptive: false });
    const hs = initMatch(netsimConfig());
    const fr = frames2();
    clock.advance(20); // both sides' neutral start frames (ticks 1..3) arrive
    host.pump(clock.now());
    for (let t = 1; t <= 3; t++) {
      expect(host.ready(t)).toBe(true);
      host.take(t, fr, hs);
      hs.tick = t; // the sim would advance here
      expect(fr[1]).toEqual(createInputFrame()); // the guest's start frames are neutral
    }
    // The guest has not simulated anything, so its frame for tick 4 does not exist: hold, never guess.
    clock.advance(200);
    host.pump(clock.now());
    expect(host.ready(4)).toBe(false);
    expect(host.waiting).toBe(true);
    clock.advance(300);
    host.pump(clock.now());
    expect(host.ready(4)).toBe(false);
    expect(host.waitingMs).toBeGreaterThanOrEqual(300);
    expect(() => host.take(4, fr, hs)).toThrow(/no remote input for tick 4/);
    expect(host.stats.stalls).toBe(1);
    // The guest takes tick 1: it samples and sends its frame for tick 4; the host may continue.
    const gs = initMatch(netsimConfig());
    guest.pump(clock.now());
    expect(guest.ready(1)).toBe(true);
    guest.take(1, frames2(), gs);
    clock.advance(15);
    host.pump(clock.now());
    expect(host.ready(4)).toBe(true);
    expect(host.waiting).toBe(false);
    host.take(4, fr, hs);
    expect(fr[1]!.mz).toBe(-60);
    expect(fr[0]!.mx).toBe(50); // host frame sampled at take(1) for tick 4
    expect(host.stats.maxStallMs).toBeGreaterThanOrEqual(300);
    expect(host.stats.totalStallMs).toBe(host.stats.maxStallMs);
    host.dispose();
    guest.dispose();
  });

  it('uses neutral local frames for the first `delay` ticks and schedules sampled frames for tick + delay', () => {
    const tr = fakeTransport('host');
    const src = scripted((_t, out) => { out.buttons = Btn.SPRINT; out.mx = 127; });
    const p = createLockstepProvider({ transport: tr, localHuman: 0, localSources: [src], delay: 4, adaptive: false });
    // The start packet carries the four neutral frames.
    expect(tr.sent.length).toBe(1);
    expect([tr.sent[0]!.firstTick, tr.sent[0]!.count]).toEqual([1, 4]);
    const neutral = createInputFrame();
    const f = createInputFrame();
    for (let i = 0; i < 4; i++) {
      unpackSenderFrame(tr.sent[0]!.data, i * FRAME_INTS, f);
      expect(f).toEqual(neutral);
    }
    tr.deliver(packetOf(1, [neutral, neutral, neutral, neutral, neutral]));
    const s = initMatch(netsimConfig());
    const fr = frames2();
    p.take(1, fr, s);
    expect(fr[0]).toEqual(neutral);
    expect(src.calls).toEqual([5]); // sampled for tick 1 + 4
    expect(tr.sent.at(-1)!.firstTick + tr.sent.at(-1)!.count - 1).toBe(5);
    s.tick = 4;
    tr.deliver(packetOf(5, [neutral]));
    expect(p.ready(5)).toBe(true);
    p.take(5, fr, s);
    expect(fr[0]!.mx).toBe(127);
    expect(fr[0]!.buttons).toBe(Btn.SPRINT);
    p.dispose();
  });

  it('orders frames by tick whatever order (and how often) packets arrive in', () => {
    const tr = fakeTransport('guest');
    const p = createLockstepProvider({ transport: tr, localHuman: 1, localSources: [], delay: 2, adaptive: false });
    const remote: InputFrame[] = [];
    for (let t = 0; t < 12; t++) {
      const f = createInputFrame();
      f.mx = t * 3 - 10;
      f.buttons = t % 3 === 0 ? Btn.SHOOT : 0;
      remote.push(f);
    }
    // Packets for ticks 1..12 in overlapping windows, delivered shuffled and duplicated.
    const packets = [packetOf(9, remote.slice(8, 12)), packetOf(1, remote.slice(0, 3)), packetOf(5, remote.slice(4, 9)),
      packetOf(9, remote.slice(8, 12)), packetOf(3, remote.slice(2, 6)), packetOf(1, remote.slice(0, 2))];
    for (const pk of packets) tr.deliver(pk);
    // A late, conflicting copy of tick 4 must not replace the first arrival (frames are immutable once sent).
    const bogus = createInputFrame();
    bogus.mx = 99;
    tr.deliver(packetOf(4, [bogus]));
    const s = initMatch(netsimConfig());
    const fr = frames2();
    for (let t = 1; t <= 12; t++) {
      expect(p.ready(t)).toBe(true);
      p.take(t, fr, s);
      s.tick = t;
      expect(fr[0], `tick ${t}`).toEqual(remote[t - 1]);
    }
    expect(p.ready(13)).toBe(false);
    expect(p.stats.duplicateFrames).toBeGreaterThan(0);
    p.dispose();
  });

  it('carries queued commands inside the next local frame (only for the local human)', () => {
    const tr = fakeTransport('host');
    const p = createLockstepProvider({ transport: tr, localHuman: 0, localSources: [], delay: 2, adaptive: false });
    const neutral = createInputFrame();
    tr.deliver(packetOf(1, [neutral, neutral, neutral, neutral, neutral, neutral]));
    p.queueCommand(0, Command.SKIP, 0);
    p.queueCommand(1, Command.SKIP, 7); // the other human's commands come over the wire, never from here
    const s = initMatch(netsimConfig());
    const fr = frames2();
    p.take(1, fr, s); // generates tick 3 with the command
    s.tick = 1;
    p.take(2, fr, s);
    s.tick = 2;
    p.take(3, fr, s);
    expect(fr[0]!.cmd).toBe(Command.SKIP);
    expect(fr[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    expect(fr[1]!.cmd).toBe(Command.NONE);
    const last = tr.sent.at(-1)!;
    const f = createInputFrame();
    unpackSenderFrame(last.data, (last.count - 1) * FRAME_INTS, f);
    expect(f.cmd).toBe(Command.NONE); // one command, one frame
    p.dispose();
  });

  it('a delay raise fills the skipped ticks with held frames (axes and held buttons, no edges)', () => {
    const tr = fakeTransport('host');
    let n = 0;
    const src = scripted((_t, out) => {
      n++;
      out.mx = 40 + n;
      out.buttons = Btn.SPRINT | Btn.RS_FLICK;
      out.cmd = Command.SKIP;
    });
    const p = createLockstepProvider({ transport: tr, localHuman: 0, localSources: [src], delay: 2 });
    const neutral = createInputFrame();
    tr.deliver(packetOf(1, Array.from({ length: 12 }, () => neutral)));
    const s = initMatch(netsimConfig());
    const fr = frames2();
    p.take(1, fr, s); // tick 3 sampled
    s.tick = 1;
    p.adaptive.schedule(5, 2); // agreed: from tick 2 on, delay 5 -> tick 7 next, ticks 4..6 held
    p.take(2, fr, s);
    expect(src.calls).toEqual([3, 7]);
    const got: InputFrame[] = [];
    for (let t = 3; t <= 7; t++) {
      s.tick = t - 1;
      p.take(t, fr, s);
      got.push({ ...fr[0]! });
    }
    expect(got[0]!.mx).toBe(41);
    for (const g of got.slice(1, 4)) {
      expect(g.mx).toBe(41);
      expect(g.buttons).toBe(Btn.SPRINT); // held button kept, flick edge dropped
      expect(g.cmd).toBe(Command.NONE);
    }
    expect(got[4]!.mx).toBe(42);
    expect(p.delay).toBe(5);
    p.dispose();
  });

  it('resends from the oldest unacknowledged frame while stalled', () => {
    const tr = fakeTransport('host');
    const p = createLockstepProvider({ transport: tr, localHuman: 0, localSources: [], delay: 3, adaptive: false });
    const neutral = createInputFrame();
    tr.deliver(packetOf(1, [neutral, neutral, neutral]));
    const s = initMatch(netsimConfig());
    const fr = frames2();
    p.pump(0);
    for (let t = 1; t <= 3; t++) {
      p.take(t, fr, s);
      s.tick = t;
    }
    expect(p.ready(4)).toBe(false);
    const before = tr.sent.length;
    p.pump(RESEND_WAITING_MS + 1);
    expect(tr.sent.length).toBe(before + 1);
    const resend = tr.sent.at(-1)!;
    expect(resend.firstTick).toBe(1); // the other side acknowledged nothing yet
    expect(resend.count).toBe(6); // ticks 1..6 (start frames + the three sampled since)
    expect(p.drained).toBe(false); // ticks 1..3 taken, nothing acknowledged
    // Once it acknowledges tick 5, resends start at 6.
    tr.deliver({ ...packetOf(4, [neutral]), ack: 5 });
    expect(p.drained).toBe(true);
    p.pump(2 * RESEND_WAITING_MS + 2);
    expect(tr.sent.at(-1)!.firstTick).toBe(6);
    p.dispose();
  });

  it('rejects a bad localHuman and disposes its sources', () => {
    const tr = fakeTransport('host');
    expect(() => createLockstepProvider({ transport: tr, localHuman: 2, localSources: [], delay: 3 })).toThrow(RangeError);
    let disposed = 0;
    let released = 0;
    const src: InputSource = {
      id: 's', kind: 'pad', sample: (out) => clearInputFrame(out), releaseAll: () => { released++; }, dispose: () => { disposed++; },
    };
    const p = createLockstepProvider({ transport: tr, localHuman: 0, localSources: [src], delay: 3 });
    p.releaseAll();
    p.dispose();
    p.dispose();
    expect([released, disposed]).toEqual([1, 1]);
    const s: SimState = initMatch(netsimConfig());
    void s;
  });
});
