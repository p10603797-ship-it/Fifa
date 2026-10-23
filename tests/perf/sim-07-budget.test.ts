/**
 * [SIM-07] Budget: receiveContacts and the FIRST_TOUCH handler are cheap (< 0.02 ms per tick in every case, typically
 * well under a microsecond; the whole sim + AI budget is 2.5 ms) and allocate nothing on the per-tick paths (the
 * candidate scan with no contact, an owned ball, the FIRST_TOUCH window). The contact path itself runs once per
 * reception: it creates no objects, but depending on V8's inlining state a few doubles handed to non-inlined calls
 * (e.g. the KICK event's power / position into EventSink.emit) may be boxed, so it is held to < 128 bytes per first
 * touch (measured 0..32).
 *
 * Measured in a plain Node child process (node --expose-gc --import tsx) rather than inside the Vitest worker (its SSR
 * transform makes every imported binding a getter, which would measure the runner). Best of many short batches so a
 * busy shared machine does not make the timing flaky. The per-iteration setup (re-aiming the ball at the receiver)
 * is included in the timing, so the numbers are upper bounds.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const imp = (p: string): string => JSON.stringify(join(ROOT, p));

const PROBE = `
  await import(${imp('tools/lib/env.ts')});
  await import(${imp('src/sim/actions/dispatch.ts')});
  const { createEventBuffer } = await import(${imp('src/sim/core/events.ts')});
  const H = await import(${imp('tests/unit/sim-07-helpers.ts')});
  const FT = await import(${imp('src/sim/players/firstTouch.ts')});
  const { rngSeed } = await import(${imp('src/sim/core/rng.ts')});
  const ev = createEventBuffer();
  let events = 0;
  const s = H.baseState(1);
  const R = H.RECV;
  const optClean = { speed: 9 };
  const optHard = { speed: 22, dist: 0.4, lateral: 0.6 };
  const optAir = { speed: 7, y: 1.35, vy: -2, dist: 0.5 };
  const optFar = { speed: 15, dist: 30, pass: false };
  const cases = {
    // A soft pass trapped cleanly every call.
    clean: () => { H.resetPlayer(s, R, H.RX, H.RZ); H.incoming(s, R, optClean); s.tick++; ev.begin(s.tick); FT.receiveContacts(s, ev); events += ev.count; },
    // Hard ball, weak receiver: clean / heavy / miss mix (applyKick on heavies).
    mixed: () => { H.resetPlayer(s, R, H.RX, H.RZ); s.attrs[R].ballControl = 30; H.incoming(s, R, optHard); s.tick++; ev.begin(s.tick); FT.receiveContacts(s, ev); events += ev.count; },
    // Chest trap.
    aerial: () => { H.resetPlayer(s, R, H.RX, H.RZ); H.incoming(s, R, optAir); s.tick++; ev.begin(s.tick); FT.receiveContacts(s, ev); events += ev.count; },
    // The common tick: a loose ball in flight nowhere near anyone (full candidate scan, no contact).
    scan: () => { s.tick++; ev.begin(s.tick); FT.receiveContacts(s, ev); events += ev.count; },
    // The other common tick: the ball is owned (early exit).
    owned: () => { s.tick++; ev.begin(s.tick); FT.receiveContacts(s, ev); events += ev.count; },
    // FIRST_TOUCH window update.
    window: () => { const p = s.players[R]; p.moveMode = 1; p.ix = 1; p.iz = 0; p.wantSprint = 1; FT.firstTouchHandler.update(s, R, ev); },
  };
  const prep = {
    clean: () => {}, mixed: () => { rngSeed(s.rng, 9); }, aerial: () => {},
    scan: () => { H.resetPlayer(s, R, H.RX, H.RZ); H.incoming(s, R, optFar); s.teams[0].chaser = 3; s.teams[1].chaser = 14; s.ctrl[0].slot = R; s.players[R].ctrl = 0; },
    owned: () => { s.ball.owner = 4; },
    window: () => { H.resetPlayer(s, R, H.RX, H.RZ); H.incoming(s, R, optClean); s.tick++; ev.begin(s.tick); FT.receiveContacts(s, ev); s.players[R].actDur = 1e9; },
  };
  const out = { us: {}, bytes: {} };
  for (const name of Object.keys(cases)) {
    prep[name]();
    const fn = cases[name];
    for (let i = 0; i < 20000; i++) fn();
    let best = Infinity;
    for (let b = 0; b < 30; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 500; i++) fn();
      best = Math.min(best, (performance.now() - t0) / 500);
    }
    out.us[name] = best * 1000;
    let bytes = Infinity;
    for (let r = 0; r < 3; r++) {
      globalThis.gc();
      const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 100000; i++) fn();
      bytes = Math.min(bytes, (process.memoryUsage().heapUsed - h0) / 100000);
    }
    out.bytes[name] = bytes;
  }
  out.events = events;
  console.log(JSON.stringify(out));
`;

describe('SIM-07 budget', () => {
  const r = spawnSync(process.execPath, [
// [TUN-7S] --single-threaded (tests/perf/qf-7r-alloc-flags.ts): compiles synchronously, so the measured bytes do not
// depend on CPU load (under load the optimised code arrived later and the window ran boxing baseline code).
    '--single-threaded', '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', PROBE,
  ], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
  const ok = r.status === 0;
  const res = ok ? JSON.parse(r.stdout.trim().split('\n').pop()!) as { us: Record<string, number>; bytes: Record<string, number>; events: number } : null;
  if (res) console.log(`SIM-07 probe: ${JSON.stringify(res)}`);

  it('probe ran', () => { expect(r.status, r.stderr).toBe(0); });

  for (const name of ['scan', 'owned', 'window']) {
    it(`per-tick path ${name}: no allocation, < 20 us per call`, () => {
      expect(res).not.toBeNull();
      expect(res!.bytes[name], `${name} bytes/call`).toBeLessThan(0.5);
      expect(res!.us[name], `${name} us/call`).toBeLessThan(20);
    });
  }
  for (const name of ['clean', 'mixed', 'aerial']) {
    it(`contact path ${name}: < 128 bytes and < 20 us per first touch`, () => {
      expect(res).not.toBeNull();
      expect(res!.bytes[name], `${name} bytes/call`).toBeLessThan(128);
      expect(res!.us[name], `${name} us/call`).toBeLessThan(20);
    });
  }
  it('the probe really made contacts', () => { expect(res!.events).toBeGreaterThan(100000); });
});
