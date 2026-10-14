/**
 * [AUD-03] Ball, body and goal-frame sounds: parameter mapping by kind/power/speed, panning, rendered samples, and
 * the module on the real engine (sounds on the effects pool, pan by pitch x vs camera, voice cap under a burst).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChallengeKind, KickKind } from '../../src/contracts/enums';
import { panFor } from '../../src/audio/dsp';
import { AUDIO_ENGINE_TUNING, createAudioEngine } from '../../src/audio/engine';
import {
  bounceCue, estimateCameraX, frameCue, HIT_SPECS, kickCue, netCue, renderHit, SFX_SAMPLE_COUNT, SFX_TUNING as T, SfxSample,
  tackleCue, type SfxCue, type SfxModule,
} from '../../src/audio/sfx';
import { makeScenario } from '../harness/scenario';
import { bootRealEngine, type FakePanner } from './aud-01-fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SR = 48000;
const cue = (): SfxCue => ({ sample: SfxSample.NONE, gain: 0, rate: 1, priority: 0 });

function kickKinds(): KickKind[] {
  return Object.values(KickKind).filter((v): v is KickKind => typeof v === 'number');
}

describe('AUD-03 parameter mapping', () => {
  it('kicks get louder, heavier (lower) and brighter with power', () => {
    for (const k of [KickKind.GROUND_PASS, KickKind.SHOT_NORMAL, KickKind.FIRST_TOUCH, KickKind.HEADER_SHOT]) {
      const soft = { ...kickCue(k, 0.1, cue()) };
      const hard = { ...kickCue(k, 1, cue()) };
      expect(hard.gain, KickKind[k]).toBeGreaterThan(soft.gain);
      expect(hard.rate, KickKind[k]).toBeLessThan(soft.rate);
    }
    // Brightness: a hard pass uses the strike sample (the crack), a soft one the pass sample.
    expect(kickCue(KickKind.DRIVEN_PASS, 0.3, cue()).sample).toBe(SfxSample.PASS);
    expect(kickCue(KickKind.DRIVEN_PASS, 0.95, cue()).sample).toBe(SfxSample.STRIKE);
  });

  it('first touches are softer than passes, passes softer than shots at the same power', () => {
    for (const p of [0.2, 0.5, 0.9]) {
      const touch = kickCue(KickKind.FIRST_TOUCH, p, cue());
      expect(touch.sample).toBe(SfxSample.TOUCH);
      const tg = touch.gain;
      const pg = kickCue(KickKind.GROUND_PASS, p, cue()).gain;
      const sg = kickCue(KickKind.SHOT_POWER, p, cue()).gain;
      expect(tg).toBeLessThan(pg);
      expect(pg).toBeLessThan(sg);
    }
    expect(kickCue(KickKind.DRIBBLE_TOUCH, 1, cue()).sample).toBe(SfxSample.TOUCH);
    expect(kickCue(KickKind.DEFLECTION, 1, cue()).sample).toBe(SfxSample.TOUCH);
  });

  it('hand releases are silent; keeper parries/punches are gloves; headers have their own thud', () => {
    for (const k of [KickKind.THROW_IN, KickKind.GK_THROW, KickKind.GK_ROLL, KickKind.GK_RELEASE, KickKind.NONE]) {
      expect(kickCue(k, 1, cue()).sample, KickKind[k]).toBe(SfxSample.NONE);
    }
    expect(kickCue(KickKind.GK_PARRY, 0.5, cue()).sample).toBe(SfxSample.GLOVE);
    expect(kickCue(KickKind.GK_PUNCH, 0.5, cue()).sample).toBe(SfxSample.GLOVE);
    expect(kickCue(KickKind.HEADER_PASS, 0.5, cue()).sample).toBe(SfxSample.HEADER);
    expect(kickCue(KickKind.GOAL_KICK, 0.5, cue()).sample).toBe(SfxSample.STRIKE);
  });

  it('every KickKind maps to a valid sample with gain in 0..1 and a finite rate, for any power', () => {
    for (const k of kickKinds()) {
      for (const p of [0, 0.5, 1, -3, 7, Number.NaN]) {
        const c = kickCue(k, p, cue());
        expect(c.sample).toBeGreaterThanOrEqual(SfxSample.NONE);
        expect(c.sample).toBeLessThan(SFX_SAMPLE_COUNT);
        expect(c.gain).toBeGreaterThanOrEqual(0);
        expect(c.gain).toBeLessThanOrEqual(1);
        expect(Number.isFinite(c.rate) && c.rate > 0).toBe(true);
      }
    }
  });

  it('bounces scale with impact speed and tiny ones are silent', () => {
    expect(bounceCue(T.minBounceSpeed * 0.5, cue()).sample).toBe(SfxSample.NONE);
    expect(bounceCue(Number.NaN, cue()).sample).toBe(SfxSample.NONE);
    const a = { ...bounceCue(3, cue()) };
    const b = { ...bounceCue(12, cue()) };
    expect(a.sample).toBe(SfxSample.BOUNCE);
    expect(b.gain).toBeGreaterThan(a.gain);
    expect(bounceCue(1000, cue()).gain).toBeLessThanOrEqual(1);
  });

  it('post and bar ring by impact speed (bar a little lower); net by ball speed', () => {
    const post = { ...frameCue(false, 20, cue()) };
    const bar = { ...frameCue(true, 20, cue()) };
    expect(post.sample).toBe(SfxSample.POST);
    expect(bar.rate).toBeLessThan(post.rate);
    expect(frameCue(false, 25, cue()).gain).toBeGreaterThan(frameCue(false, 5, cue()).gain);
    expect(netCue(25, cue()).gain).toBeGreaterThan(netCue(3, cue()).gain);
    expect(netCue(Number.NaN, cue()).gain).toBeGreaterThan(0);
  });

  it('tackles thud, slides scrape, shoulder and keeper challenges are body contact', () => {
    expect(tackleCue(ChallengeKind.STAND, true, cue()).sample).toBe(SfxSample.TACKLE);
    expect(tackleCue(ChallengeKind.STAND, true, cue()).gain).toBeGreaterThan(tackleCue(ChallengeKind.STAND, false, cue()).gain);
    expect(tackleCue(ChallengeKind.SLIDE, false, cue()).sample).toBe(SfxSample.SLIDE);
    expect(tackleCue(ChallengeKind.SHOULDER, true, cue()).sample).toBe(SfxSample.BODY);
    expect(tackleCue(ChallengeKind.KEEPER, true, cue()).sample).toBe(SfxSample.BODY);
  });

  it('pans by pitch x relative to the camera x (estimated from the ball when not reported)', () => {
    expect(estimateCameraX(10)).toBeCloseTo(7, 6);
    expect(estimateCameraX(60)).toBe(T.cameraClamp);
    expect(estimateCameraX(-60)).toBe(-T.cameraClamp);
    expect(estimateCameraX(Number.NaN)).toBe(0);
    expect(panFor(0, 0, T.panSpan, T.panWidth)).toBe(0);
    expect(panFor(30, 0, T.panSpan, T.panWidth)).toBeCloseTo(T.panWidth, 6);
    expect(panFor(-100, 0, T.panSpan, T.panWidth)).toBeCloseTo(-T.panWidth, 6);
    expect(panFor(20, 20, T.panSpan, T.panWidth)).toBe(0);
    expect(panFor(Number.NaN, 0, T.panSpan, T.panWidth)).toBe(0);
  });
});

describe('AUD-03 rendered samples', () => {
  it('every sample is finite, below full scale, starts and ends silent (no click)', () => {
    for (let s = 0; s < SFX_SAMPLE_COUNT; s++) {
      const n = Math.round(HIT_SPECS[s]!.dur * SR);
      const ch = new Float32Array(n);
      const r = renderHit(s);
      for (let f = 0; f < n; f += 4096) r([ch], f, Math.min(n, f + 4096), SR);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        expect(Number.isFinite(ch[i]!)).toBe(true);
        peak = Math.max(peak, Math.abs(ch[i]!));
      }
      expect(peak, SfxSample[s]).toBeLessThan(1);
      expect(peak, SfxSample[s]).toBeGreaterThan(0.1);
      expect(Math.abs(ch[0]!)).toBeLessThan(0.02);
      expect(Math.abs(ch[n - 1]!)).toBeLessThan(1e-3);
    }
  });

  it('the post rings on (a long metallic tail) while a kick is a short thump', () => {
    const energyAfter = (s: SfxSample, t: number): number => {
      const n = Math.round(HIT_SPECS[s]!.dur * SR);
      const ch = new Float32Array(n);
      renderHit(s)([ch], 0, n, SR);
      let e = 0;
      for (let i = Math.round(t * SR); i < n; i++) e += ch[i]! * ch[i]!;
      return e;
    };
    expect(HIT_SPECS[SfxSample.POST]!.dur).toBeGreaterThan(1);
    expect(energyAfter(SfxSample.POST, 0.3)).toBeGreaterThan(10 * energyAfter(SfxSample.STRIKE, 0.15));
  });
});

describe('AUD-03 sfx module on the engine', () => {
  it('plays kicks, bounces, frame, net, tackles and gloves on the effects pool with pan from x', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const sfx = boot.engine.services!.modules.sfx as SfxModule;
    const s = makeScenario({ ball: { x: 0, z: 0 } });
    boot.engine.update(s, 1 / 60);
    sfx.kick(KickKind.SHOT_POWER, 1, 30);
    expect(sfx.stats.played[SfxSample.STRIKE]).toBe(1);
    expect(sfx.stats.lastPan).toBeGreaterThan(0.5);
    sfx.kick(KickKind.GROUND_PASS, 0.4, -30);
    expect(sfx.stats.lastPan).toBeLessThan(-0.5);
    // The camera follows the ball: an event at the ball is centred.
    s.ball.x = 40;
    boot.engine.update(s, 1 / 60);
    sfx.bounce(6, estimateCameraX(40));
    expect(sfx.stats.lastPan).toBeCloseTo(0, 6);
    // A camera x from the renderer overrides the estimate.
    sfx.setCameraX(-20);
    sfx.frame(true, 20, -20);
    expect(sfx.stats.lastPan).toBeCloseTo(0, 6);
    sfx.setCameraX(Number.NaN);
    sfx.net(20, 52.5);
    sfx.tackle(ChallengeKind.SLIDE, true, 0);
    sfx.body(0);
    sfx.glove(0.8, 50);
    sfx.kick(KickKind.THROW_IN, 1, 0); // silent
    const p = sfx.stats.played;
    expect([p[SfxSample.PASS], p[SfxSample.BOUNCE], p[SfxSample.POST], p[SfxSample.NET], p[SfxSample.SLIDE], p[SfxSample.BODY], p[SfxSample.GLOVE]]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(p.reduce((a, b) => a + b, 0)).toBe(8);
    // The voice's panner got the pan (real StereoPanner automation).
    const panners = boot.ac.created.panners as FakePanner[];
    expect(panners.some((pn) => pn.pan.log.includes('setValueAtTime'))).toBe(true);
    expect(boot.errors).toEqual([]);
    boot.engine.dispose();
  });

  it('voice cap respected: a burst of 60 sounds never exceeds the effects pool and nothing throws', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const sfx = boot.engine.services!.modules.sfx as SfxModule;
    const pool = boot.engine.services!.effects;
    let max = 0;
    const kinds = [KickKind.SHOT_NORMAL, KickKind.GROUND_PASS, KickKind.FIRST_TOUCH, KickKind.HEADER_SHOT];
    for (let i = 0; i < 60; i++) {
      boot.ac.advance(0.05); // beyond the retrigger window: each is a new voice unless capped
      sfx.kick(kinds[i % 4]!, (i % 10) / 10, i - 30);
      sfx.frame(i % 2 === 0, 20, 52);
      max = Math.max(max, pool.active());
    }
    expect(max).toBeLessThanOrEqual(AUDIO_ENGINE_TUNING.effectsVoices);
    expect(max).toBeGreaterThan(4);
    expect(pool.allocator.steals + pool.allocator.drops).toBeGreaterThan(0);
    expect(boot.errors).toEqual([]);
    boot.engine.dispose();
  });

  it('the same sound twice within the retrigger window replaces itself instead of stacking', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const sfx = boot.engine.services!.modules.sfx as SfxModule;
    const pool = boot.engine.services!.effects;
    sfx.bounce(8, 0);
    sfx.bounce(8, 0);
    expect(pool.active()).toBe(1);
    expect(pool.allocator.retriggers).toBe(1);
    boot.engine.dispose();
  });

  it('is silent (no throw) without engine services', async () => {
    const { createSfx } = await import('../../src/audio/sfx');
    const { createFakeContext, asContext } = await import('./aud-01-fakes');
    const ac = asContext(createFakeContext({ state: 'running' }));
    const g = ac.createGain();
    const settings = { get: () => ({}), update: () => undefined, subscribe: () => () => undefined } as never;
    const sfx = createSfx({ ctx: ac, master: g, crowd: g, effects: g, menus: g, settings });
    expect(() => sfx.kick(KickKind.SHOT_NORMAL, 1, 0)).not.toThrow();
    expect(sfx.stats.dropped).toBe(1);
  });
});
