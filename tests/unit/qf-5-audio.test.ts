/**
 * [QF-5] Audio lifecycle QA (QA-41): silent after background, sounds stacking after a pause, crowd loop clicking,
 * unlock on the first gesture, volume settings live. Real engine + real sound modules on the AUD-01 fake context.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UiSound } from '../../src/contracts/app';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createMatchConfig } from '../../src/contracts/state';
import { CLUBS } from '../../src/data/clubs';
import { AUDIO_ENGINE_TUNING as T, createAudioEngine } from '../../src/audio/engine';
import { CrowdCue, type CrowdModule } from '../../src/audio/crowd';
import { createSettingsStore } from '../../src/platform/settingsStore';
import { createMemoryStorage } from '../../src/platform/storage';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { asContext, bootRealEngine, createFakeContext, createFakeWindow, flush, type FakeGain } from './aud-01-fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Make ac.suspend() settle later (a real browser applies it asynchronously); returns a function that settles it. */
function deferSuspend(ac: ReturnType<typeof createFakeContext>): () => void {
  const pending: (() => void)[] = [];
  ac.suspend = vi.fn(() => new Promise<void>((resolve) => {
    pending.push(() => {
      if (ac.state !== 'closed') ac.setState('suspended');
      resolve();
    });
  }));
  return () => {
    for (const p of pending.splice(0)) p();
  };
}

describe('QF-5 audio lifecycle', () => {
  it('glitch: silent after returning from the background - a quick hide/show while the suspend is still pending comes back without a tap', async () => {
    const { ac, engine, win } = await bootRealEngine({ createEngine: createAudioEngine });
    expect(ac.state).toBe('running');
    const settle = deferSuspend(ac);
    engine.suspend(); // page hidden: ac.suspend() is in flight
    expect(ac.state).toBe('running');
    engine.resume(); // page visible again before the browser applied the suspend
    settle(); // the suspend lands after the resume request
    await flush();
    // No user gesture happened: a controller-only player must still hear the game.
    expect(win.armed()).toBe(0);
    expect(ac.state).toBe('running');
    expect(engine.info().outputUp).toBe(true);
    expect(engine.info().wanted).toBe(true);
  });
});

function matchState() {
  const config = createMatchConfig();
  config.seed = 11;
  return initMatch(config, CLUBS);
}

/** A fresh engine on a fake context that is unlocked but whose buffers are NOT pre-rendered yet. */
async function freshEngine(now: () => number = () => 0) {
  const win = createFakeWindow();
  vi.stubGlobal('window', win);
  const ac = createFakeContext();
  const settings = createSettingsStore(createMemoryStorage());
  const errors: string[] = [];
  const engine = createAudioEngine(settings, { createContext: () => asContext(ac), onModuleError: (e, w) => errors.push(`${w}: ${String(e)}`), now });
  return { win, ac, settings, engine, errors };
}

const buses = (ac: ReturnType<typeof createFakeContext>) => {
  const [master, crowd, effects, menus, out] = ac.created.gains as FakeGain[];
  return { master: master!, crowd: crowd!, effects: effects!, menus: menus!, out: out! };
};

describe('QF-5 audio warm-up (QA-39)', () => {
  it('a match started right after the unlock has every buffer ready at kick-off and renders nothing during play', async () => {
    const { ac, engine, errors } = await freshEngine();
    await engine.unlock();
    await flush();
    const bank = engine.services!.bank;
    expect(bank.pending).toBeGreaterThan(0); // the menus had no time to pre-render
    const s = matchState();
    engine.warmUp(); // the session's loading step
    engine.matchStart(s);
    expect(bank.pending).toBe(0);
    expect(bank.failed).toBe(0);
    const crowd = engine.services!.modules.crowd as CrowdModule;
    engine.update(s, 1 / 60);
    expect(crowd.bedRunning).toBe(true); // the bed starts with the match, not seconds later
    const pump = vi.spyOn(bank, 'pump');
    for (let i = 0; i < 120; i++) {
      ac.advance(1 / 60);
      engine.update(s, 1 / 60);
    }
    expect(pump).not.toHaveBeenCalled();
    // The first kick of the match is heard (its buffer exists).
    const before = ac.created.sources.length;
    const ev = createEventBuffer();
    ev.begin(1);
    ev.emit(EventType.KICK, 1, KickKind.SHOT_NORMAL, 0.8);
    engine.onEvents(ev, s);
    expect(ac.created.sources.length).toBeGreaterThan(before);
    expect(errors).toEqual([]);
  });
});

describe('QF-5 volume settings are live', () => {
  it('master, crowd, effects and menus follow settings.update at once, as ramps (no step), paused or not', async () => {
    const { ac, engine, settings } = await bootRealEngine({ createEngine: createAudioEngine });
    const b = buses(ac);
    const settle = (): void => {
      for (let i = 0; i < 30; i++) ac.advance(1 / 60);
    };
    settings.update((st) => { st.audio.master = 0.25; st.audio.crowd = 0.5; st.audio.effects = 0.75; st.audio.menus = 0.1; });
    expect(b.master.gain.log.at(-1)).toBe('setTargetAtTime');
    settle();
    expect(b.master.gain.value).toBeCloseTo(0.25, 3);
    expect(b.crowd.gain.value).toBeCloseTo(0.5, 3);
    expect(b.effects.gain.value).toBeCloseTo(0.75, 3);
    expect(b.menus.gain.value).toBeCloseTo(0.1, 3);
    engine.setPaused(true);
    settings.update((st) => { st.audio.crowd = 1; st.audio.effects = 1; });
    settle();
    expect(b.crowd.gain.value).toBeCloseTo(T.pauseCrowdDuck, 3); // ducked, at the new level
    expect(b.effects.gain.value).toBeCloseTo(0, 3); // muted while paused
    engine.setPaused(false);
    settle();
    expect(b.crowd.gain.value).toBeCloseTo(1, 3);
    expect(b.effects.gain.value).toBeCloseTo(1, 3);
    // A slider drag never steps: every sample between two updates is between the old and new levels.
    const t0 = ac.currentTime;
    settings.update((st) => { st.audio.master = 1; });
    const g = b.master.gain;
    let prev = g.valueAt(t0);
    for (let i = 1; i <= 50; i++) {
      const v = g.valueAt(t0 + i / 1000);
      expect(v - prev).toBeLessThan(0.05);
      prev = v;
    }
  });
});

describe('QF-5 sounds stacking after a pause (real modules)', () => {
  it('glitch: sounds stacking after a pause - events and cues during a pause are dropped, a burst after it plays one voice per sound', async () => {
    const { ac, engine } = await bootRealEngine({ createEngine: createAudioEngine });
    const s = matchState();
    engine.matchStart(s);
    engine.update(s, 1 / 60);
    const svc = engine.services!;
    engine.setPaused(true);
    const ev = createEventBuffer();
    for (let t = 0; t < 120; t++) {
      ev.begin(t + 1);
      ev.emit(EventType.KICK, 1, KickKind.GROUND_PASS, 0.9);
      ev.emit(EventType.WHISTLE, 0);
      ev.emit(EventType.GOAL, 0);
      engine.onEvents(ev, s); // the sim does not tick while paused; even if a consumer called us, nothing queues
      ac.advance(1 / 60);
      engine.update(s, 1 / 60);
    }
    expect(svc.effects.active()).toBe(0);
    expect(svc.crowd.active()).toBe(0);
    engine.setPaused(false);
    // The same tick's duplicates and a re-trigger within a few ticks never pile up.
    for (let t = 0; t < 3; t++) {
      ev.begin(200 + t);
      for (let k = 0; k < 8; k++) ev.emit(EventType.KICK, 1, KickKind.GROUND_PASS, 0.9);
      engine.onEvents(ev, s);
      ac.advance(1 / 240);
    }
    expect(svc.effects.active()).toBeLessThanOrEqual(2);
  });
});

describe('QF-5 unlock on the first gesture', () => {
  it('a gesture-less start (pad) creates the context suspended with gestures armed; the first tap runs it and plays the held START', async () => {
    let clock = 0;
    const { win, ac, engine } = await freshEngine(() => clock);
    ac.mode = 'refuse'; // no user activation: resume() resolves but the context stays suspended
    void engine.unlock();
    engine.playUi(UiSound.START);
    await flush();
    expect(ac.state).toBe('suspended');
    expect(win.armed()).toBeGreaterThan(0);
    expect(engine.unlocked).toBe(false);
    // Hidden and back before any tap: still waiting for a gesture, never a resume loop.
    engine.suspend();
    engine.resume();
    await flush();
    expect(win.armed()).toBeGreaterThan(0);
    ac.mode = 'run';
    clock += 100;
    engine.playUi(UiSound.START);
    win.fire('click');
    await flush();
    expect(ac.state).toBe('running');
    expect(engine.unlocked).toBe(true);
    expect(win.armed()).toBe(0);
    expect(engine.info().outputUp).toBe(true);
    expect(engine.services!.menus.active()).toBe(1); // the held START played once, not twice
  });
});

describe('QF-5 controller-only players are never left in silence', () => {
  it('glitch: silent after returning from the background - an unlocked context the OS leaves suspended is resumed without any gesture', async () => {
    const { ac, engine, win } = await bootRealEngine({ createEngine: createAudioEngine });
    // The OS suspends the running context while the page is visible (end of an interruption, audio session change).
    ac.mode = 'refuse';
    ac.setState('suspended');
    await flush();
    expect(ac.state).toBe('suspended');
    expect(engine.info().outputUp).toBe(false);
    // Nobody touches the screen. Once the browser allows it again, the engine's own retry brings the sound back.
    ac.mode = 'run';
    for (let i = 0; i < 90 && ac.state !== 'running'; i++) engine.update(null, 1 / 60);
    await flush();
    expect(ac.state).toBe('running');
    expect(engine.info().outputUp).toBe(true);
    expect(win.armed()).toBe(0);
    // Retries are paced (not every frame) and stop while the page is hidden.
    ac.mode = 'refuse';
    ac.setState('suspended');
    const calls = ac.resume.mock.calls.length;
    for (let i = 0; i < 120; i++) engine.update(null, 1 / 60);
    expect(ac.resume.mock.calls.length - calls).toBeLessThanOrEqual(3);
    engine.suspend();
    const hiddenCalls = ac.resume.mock.calls.length;
    for (let i = 0; i < 300; i++) engine.update(null, 1 / 60);
    expect(ac.resume.mock.calls.length).toBe(hiddenCalls);
  });

  it('a context that never ran (pad start, no gesture yet) is not nagged with resume calls; iOS "interrupted" waits for the OS', async () => {
    const { ac, engine } = await freshEngine();
    ac.mode = 'refuse';
    void engine.unlock();
    await flush();
    const calls = ac.resume.mock.calls.length;
    for (let i = 0; i < 300; i++) engine.update(null, 1 / 60);
    expect(ac.resume.mock.calls.length).toBe(calls);
    const b = await bootRealEngine({ createEngine: createAudioEngine });
    b.ac.mode = 'hang';
    b.ac.setState('interrupted');
    const c2 = b.ac.resume.mock.calls.length;
    for (let i = 0; i < 300; i++) b.engine.update(null, 1 / 60);
    expect(b.ac.resume.mock.calls.length).toBe(c2);
  });
});

describe('QF-5 crowd loop clicking (real crowd module on the real bank)', () => {
  it('glitch: crowd loop clicking - the bed buffers wrap seamlessly at 44.1 and 48 kHz and every bed gain change is a glide (no step)', async () => {
    for (const rate of [44100, 48000]) {
      const win = createFakeWindow();
      vi.stubGlobal('window', win);
      const ac = createFakeContext();
      ac.sampleRate = rate;
      const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => asContext(ac), now: () => 0 });
      await engine.unlock();
      await flush();
      const bank = engine.services!.bank;
      bank.flush();
      // 1) The loop seam: the wrap (last sample -> first) is an ordinary step, at the context's own rate.
      for (const id of ['crowd.bed.murmur', 'crowd.bed.roar']) {
        const buf = bank.get(bank.handle(id)) as unknown as { getChannelData(c: number): Float32Array; numberOfChannels: number; sampleRate: number };
        expect(buf.sampleRate).toBe(rate);
        for (let c = 0; c < buf.numberOfChannels; c++) {
          const ch = buf.getChannelData(c);
          let sum = 0;
          let maxStep = 0;
          for (let i = 1; i < ch.length; i++) {
            const d = Math.abs(ch[i]! - ch[i - 1]!);
            sum += d * d;
            if (d > maxStep) maxStep = d;
          }
          const typical = Math.sqrt(sum / (ch.length - 1));
          const wrap = Math.abs(ch[ch.length - 1]! - ch[0]!);
          expect(wrap, `${id} @${rate} wrap ${wrap} vs typical ${typical}`).toBeLessThan(4 * typical);
          expect(wrap).toBeLessThanOrEqual(maxStep);
        }
      }
      // 2) The playback path: looping sources, gains that only glide (match start, build-up, goal, pause, end).
      const s = matchState();
      engine.matchStart(s);
      engine.update(s, 1 / 60);
      const beds = ac.created.sources.filter((x) => x.loop);
      expect(beds).toHaveLength(2);
      const gains = beds.map((b) => b.outputs[0] as FakeGain);
      for (const g of gains) expect(g.gain.valueAt(ac.currentTime)).toBeLessThan(1e-3); // starts from silence
      const t0 = ac.currentTime;
      const run = (sec: number): void => {
        for (let i = 0; i < Math.round(sec * 60); i++) {
          ac.advance(1 / 60);
          engine.update(s, 1 / 60);
        }
      };
      run(2);
      const crowd = engine.services!.modules.crowd as CrowdModule;
      s.match.phase = MatchPhase.IN_PLAY; // the ball at the goal line: the roar rises
      s.ball.x = 50;
      run(1.5);
      crowd.cue(CrowdCue.GOAL, 0, 1);
      run(1.5);
      engine.setPaused(true);
      run(0.5);
      engine.setPaused(false);
      run(0.5);
      const before = gains.map((g) => g.gain.valueAt(ac.currentTime));
      engine.matchEnd();
      run(2);
      const t1 = ac.currentTime;
      const b = buses(ac);
      for (const g of [...gains.map((x) => x.gain), b.crowd.gain, b.master.gain, b.out.gain]) {
        expect(g.maxStep(t0, t1, rate)).toBeLessThan(0.002);
      }
      // The loops stop only once their gain is inaudible (no click at the stop either).
      for (let k = 0; k < beds.length; k++) {
        const stopAt = beds[k]!.stoppedAt;
        expect(stopAt).toBeGreaterThan(0);
        expect(gains[k]!.gain.valueAt(stopAt)).toBeLessThan(0.01 * Math.max(before[k]!, 0.05));
      }
      engine.dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe('QF-5 zombie context without a tap', () => {
  it('glitch: silent after returning from the background - a "running" context with a frozen clock restarts by itself (bounded tries)', async () => {
    const { ac, engine, win } = await bootRealEngine({ createEngine: createAudioEngine });
    for (let i = 0; i < 10; i++) {
      ac.advance(1 / 60);
      engine.update(null, 1 / 60);
    }
    // The clock freezes while the state says 'running' (iOS after an interruption). Nobody taps.
    let restarted = false;
    for (let i = 0; i < 60 * 3 && !restarted; i++) {
      engine.update(null, 1 / 60);
      restarted = ac.suspend.mock.calls.length > 0;
    }
    expect(restarted).toBe(true);
    await flush();
    expect(ac.state).toBe('running');
    expect(engine.info().stalled).toBe(false);
    // A clock that stays frozen is retried a bounded number of times, never every frame.
    const before = ac.suspend.mock.calls.length;
    for (let i = 0; i < 60 * 30; i++) engine.update(null, 1 / 60);
    await flush();
    expect(ac.suspend.mock.calls.length - before).toBeLessThanOrEqual(T.zombieAutoTries);
    for (let i = 0; i < 60; i++) engine.update(null, 1 / 60);
    expect(engine.info().stalled).toBe(true);
    expect(win.armed()).toBeGreaterThan(0); // a tap still restarts it
    expect(ac.suspend.mock.calls.length - before).toBeLessThanOrEqual(T.zombieAutoTries);
    // Once the clock moves again, a later stall gets fresh tries.
    for (let i = 0; i < 30; i++) {
      ac.advance(1 / 60);
      engine.update(null, 1 / 60);
    }
    const after = ac.suspend.mock.calls.length;
    for (let i = 0; i < 60 * 3; i++) engine.update(null, 1 / 60);
    expect(ac.suspend.mock.calls.length).toBeGreaterThan(after);
  });
});
