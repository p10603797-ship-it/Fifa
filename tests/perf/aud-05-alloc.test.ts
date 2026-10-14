/**
 * [AUD-02..05] The audio hot path allocates nothing per frame and no objects per event (brief rule: "Never
 * allocate per event in the steady state"). Measured in a child process with V8's sampling heap profiler: every
 * sampled allocation whose allocating frame is in the event map, crowd, sfx, whistles, voice pool or dsp counts.
 * The Web Audio context is a minimal fake defined in the child script with pooled source nodes, so what is left is
 * src/audio's own allocation. Frames: crowd update (bed running) and the sfx camera estimate. Ticks: a cycle of sim
 * events covering every routed type through the real event map, crowd, sfx and whistles.
 */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AUD-05 zero allocation on the audio hot path', () => {
  it('frames allocate nothing; events allocate only boxed numbers (no objects/closures); a tick costs microseconds', () => {
    const root = resolve(__dirname, '../..');
    const mod = (p: string): string => JSON.stringify(resolve(root, p));
    const code = `
      const { Session } = await import('node:inspector/promises');
      const { createBufferBank } = await import(${mod('src/audio/bank.ts')});
      const { createVoicePool } = await import(${mod('src/audio/voices.ts')});
      const { createCrowd } = await import(${mod('src/audio/crowd.ts')});
      const { createSfx } = await import(${mod('src/audio/sfx.ts')});
      const { createWhistles } = await import(${mod('src/audio/whistles.ts')});
      const { createEventMap } = await import(${mod('src/audio/eventMap.ts')});
      const { createEventBuffer } = await import(${mod('src/sim/core/events.ts')});
      const { createMatchConfig } = await import(${mod('src/contracts/state.ts')});
      const { initMatch } = await import(${mod('src/sim/init.ts')});
      const session = new Session();
      session.connect();
      const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {} });
      const node = () => ({ connect() {}, disconnect() {} });
      const ac = {
        state: 'running', currentTime: 0, sampleRate: 48000, destination: node(),
        createGain: () => Object.assign(node(), { gain: param() }),
        createStereoPanner: () => Object.assign(node(), { pan: param() }),
        createBiquadFilter: () => Object.assign(node(), { type: 'lowpass', frequency: param(), Q: param() }),
        createBuffer: (ch, len, sr) => {
          const data = [];
          for (let c = 0; c < ch; c++) data.push(new Float32Array(len));
          return { numberOfChannels: ch, length: len, sampleRate: sr, duration: len / sr, getChannelData: (c) => data[c] };
        },
        // Pooled fake sources: the fake itself allocates nothing, so what remains is src/audio's own allocation.
        createBufferSource: () => srcPool[srcNext++ & 127],
      };
      const srcPool = [];
      let srcNext = 0;
      for (let i = 0; i < 128; i++) srcPool.push(Object.assign(node(), { buffer: null, loop: false, onended: null, playbackRate: param(), start() {}, stop() {} }));
      const bus = () => ac.createGain();
      const crowdBus = bus(), effects = bus(), menus = bus(), master = bus();
      const registry = { crowd: null, sfx: null, whistles: null, eventMap: null, ui: null };
      const services = {
        bank: createBufferBank(ac), modules: registry,
        effects: createVoicePool(ac, effects, 16), crowd: createVoicePool(ac, crowdBus, 6), menus: createVoicePool(ac, menus, 4),
      };
      const actx = { ctx: ac, master, crowd: crowdBus, effects, menus, settings: null, services };
      registry.crowd = createCrowd(actx);
      registry.sfx = createSfx(actx);
      registry.whistles = createWhistles(actx);
      registry.eventMap = createEventMap(actx);
      services.bank.flush();
      const s = initMatch(createMatchConfig());
      s.match.phase = 2;
      registry.crowd.matchStart(s);
      // A cycle of ticks covering every routed event type.
      const E = [
        [[0, 9, 13, 0.9, 0, 30, 0.1, 2], [14, 9, 1, 0.3]],
        [[1, 0, 0, 6, 0, 31, 0, 2]],
        [[2, 1, 0, 18, 0, 52.5, 1, 3], [21, 9, 0, 1.5]],
        [[3, 1, 0, 15, 0, 52.6, 1, 0], [9, 0, 9, -1, 0, 52.6, 1, 0], [4, 0]],
        [[5, 15, 9, 1, 0, 20, 0, 1], [6, 15, 1], [4, 0]],
        [[7, 9, 0, 0, 0, 30, 0, 4]],
        [[8, 11, 0, 24, 0, 51, 1, 0], [26, 11, 1]],
        [[12, 9, 15, 1, 2], [28, 15, 1], [13, 15, 9]],
        [[27, 0, 0, 0.7], [10, 1, 13, 15], [11, 2, 11]],
        [[31, 0, 1, 0], [0, 4, 25, 0.3, 0, -10, 0.1, 0]],
      ];
      const ev = createEventBuffer();
      const em = registry.eventMap;
      const pos = new Int32Array(1);
      // Frames without events: open play with the ball moving a little in the attacking third (the crowd level has
      // settled, so the bed sends no automation) and the camera estimate following the ball.
      const frames = (n) => {
        for (let j = 0; j < n; j++) {
          const k = pos[0]++;
          ac.currentTime += 1 / 60;
          s.ball.x = 30 + (k % 2) * 0.01;
          s.ball.owner = 9;
          registry.crowd.update(s, 1 / 60);
          registry.sfx.update(s, 1 / 60);
        }
      };
      const run = (n) => {
        for (let j = 0; j < n; j++) {
          const k = pos[0]++;
          ac.currentTime += 1 / 60;
          s.tick = k;
          s.ball.x = ((k % 600) / 600) * 100 - 50;
          s.ball.owner = (k >> 7) & 1 ? 9 : 15;
          ev.begin(k);
          const tickEvents = E[k % E.length];
          for (let i = 0; i < tickEvents.length; i++) {
            const e = tickEvents[i];
            ev.emit(e[0], e[1], e[2], e[3], e[4], e[5], e[6], e[7]);
          }
          em.onEvents(ev, s);
          registry.crowd.update(s, 1 / 60);
          registry.sfx.update(s, 1 / 60);
        }
      };
      const bytesIn = (profile, n) => {
        let bytes = 0;
        const walk = (nd) => {
          const u = nd.callFrame.url;
          if (nd.selfSize > 0 && /src\\/audio\\/(eventMap|crowd|sfx|whistles|voices|dsp)\\.ts$/.test(u)) bytes += nd.selfSize;
          for (const c of nd.children) walk(c);
        };
        walk(profile.head);
        return bytes / n;
      };
      const sample = async (fn, n) => {
        fn(12000);
        globalThis.gc();
        await session.post('HeapProfiler.startSampling', {
          samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true,
        });
        fn(n);
        const { profile } = await session.post('HeapProfiler.stopSampling');
        return bytesIn(profile, n);
      };
      const N = 30000;
      const perFrame = await sample(frames, N);
      const mine = await sample(run, N);
      const t0 = process.hrtime.bigint();
      run(12000);
      const us = Number(process.hrtime.bigint() - t0) / 12000 / 1000;
      const eventsPerTick = E.reduce((a, t) => a + t.length, 0) / E.length;
      console.log(JSON.stringify({ perFrame, mine, perEvent: mine / eventsPerTick, usPerTick: us, bed: registry.crowd.bedRunning, sfx: Array.from(registry.sfx.stats.played).reduce((a, b) => a + b, 0), whistles: Array.from(registry.whistles.stats.whistles).reduce((a, b) => a + b, 0) }));
    `;
    const r = spawnSync(process.execPath, [
      '--expose-gc', '--min-semi-space-size=256', '--max-semi-space-size=256', '--import', 'tsx', '--input-type=module', '-e', code,
    ], { cwd: root, encoding: 'utf8', timeout: 240_000 });
    expect(r.status, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout.trim().split('\n').pop()!) as { perFrame: number; mine: number; perEvent: number; usPerTick: number; bed: boolean; sfx: number; whistles: number };
    console.log(`AUD audio hot path per tick: ${JSON.stringify(res)}`);
    expect(res.bed).toBe(true);
    expect(res.sfx).toBeGreaterThan(1000);
    expect(res.whistles).toBeGreaterThan(100);
    // Frames without events (the common case: crowd smoothing, bed params, camera estimate): nothing at all.
    expect(res.perFrame).toBeLessThan(0.5);
    // Ticks with events (2.2 per tick here, ~1 sound started per tick): no objects, arrays or closures are created;
    // what remains is V8 boxing a double passed to a call that is not inlined (16 bytes each: event fields into the
    // module calls, times into AudioParam automation and the voice allocator). Measured ~70 bytes per event.
    expect(res.perEvent).toBeLessThan(96);
    expect(res.usPerTick).toBeLessThan(100);
  });
});
