/**
 * [AUD-02] Crowd bed and reactions: intensity mapping and smoothing, reaction choice and perspective, seamless bed
 * loops (named regression: glitch list "crowd loop clicking"), and the module on the real engine (bed loops start
 * at match start, follow intensity with smooth ramps, fade out at match end; reactions on the crowd voice pool).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { ControllerKind, MatchPhase } from '../../src/contracts/enums';
import type { ReadonlySimState } from '../../src/contracts/state';
import {
  bedLevels, CROWD_TUNING as T, CrowdCue, crowdReaction, crowdTarget, goalProximity, perspectiveTeam, Reaction, REACTION_SPECS,
  renderMurmurBed, renderReaction, renderRoarBed, smoothIntensity, type CrowdModule, type ReactionCue,
} from '../../src/audio/crowd';
import { loopRenderer, type MonoSource } from '../../src/audio/dsp';
import { createAudioEngine } from '../../src/audio/engine';
import type { SampleRenderer } from '../../src/audio/bank';
import { makeScenario } from '../harness/scenario';
import { bootRealEngine, FakeBiquad, FakeGain, type FakeSource } from './aud-01-fakes';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SR = 48000;

function render(r: SampleRenderer, seconds: number, channels: number, chunk = 4096): Float32Array[] {
  const n = Math.round(seconds * SR);
  const out = Array.from({ length: channels }, () => new Float32Array(n));
  for (let f = 0; f < n; f += chunk) r(out, f, Math.min(n, f + chunk), SR);
  return out;
}

/** RMS of the sample-to-sample differences (the "normal" step size of a signal). */
function stepRms(ch: Float32Array): number {
  let s = 0;
  for (let i = 1; i < ch.length; i++) s += (ch[i]! - ch[i - 1]!) ** 2;
  return Math.sqrt(s / (ch.length - 1));
}

function rms(ch: Float32Array, from = 0, to = ch.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s += ch[i]! ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
}

describe('AUD-02 intensity mapping', () => {
  const P = 0;
  it('rises as the ball nears a goal in open play: midfield < final third < goal line', () => {
    const mid = crowdTarget(MatchPhase.IN_PLAY, 0, 0, 1, P, 0);
    const third = crowdTarget(MatchPhase.IN_PLAY, 30, 0, 1, P, 0);
    const box = crowdTarget(MatchPhase.IN_PLAY, 48, 0, 1, P, 0);
    const line = crowdTarget(MatchPhase.IN_PLAY, HALF_LENGTH, 0, 1, P, 0);
    expect(mid).toBeCloseTo(T.baseInPlay, 6);
    expect(goalProximity(T.finalThirdX - 1)).toBe(0);
    expect(third).toBeGreaterThan(mid);
    expect(box).toBeGreaterThan(third);
    expect(line).toBeCloseTo(T.baseInPlay + T.ballWeight, 6);
    // Symmetric for the other end.
    expect(crowdTarget(MatchPhase.IN_PLAY, -48, 1, -1, 1, 0)).toBeCloseTo(box, 6);
  });

  it('build-up toward the opponent goal counts more than the ball near the own goal; the away side less', () => {
    const attack = crowdTarget(MatchPhase.IN_PLAY, 45, 0, 1, 0, 0);
    const defend = crowdTarget(MatchPhase.IN_PLAY, -45, 0, 1, 0, 0);
    const awayAttack = crowdTarget(MatchPhase.IN_PLAY, -45, 1, -1, 0, 0);
    expect(attack).toBeGreaterThan(awayAttack);
    expect(awayAttack).toBeGreaterThan(defend);
  });

  it('lulls at half time and after the match; set pieces near goal build anticipation; boosts lift play, not lulls', () => {
    expect(crowdTarget(MatchPhase.HALF_TIME, 0, -1, 1, 0, 0)).toBe(T.halfTime);
    expect(crowdTarget(MatchPhase.HALF_TIME, 0, -1, 1, 0, 0.8)).toBe(T.halfTime);
    expect(crowdTarget(MatchPhase.POST_MATCH, 0, -1, 1, 0, 0.8)).toBe(T.postMatch);
    expect(crowdTarget(MatchPhase.HALF_TIME, 0, -1, 1, 0, 0)).toBeLessThan(crowdTarget(MatchPhase.IN_PLAY, 0, -1, 1, 0, 0));
    const pen = crowdTarget(MatchPhase.PENALTY, 41, 0, 1, 0, 0);
    const corner = crowdTarget(MatchPhase.CORNER, 52, 0, 1, 0, 0);
    const throwIn = crowdTarget(MatchPhase.THROW_IN, 0, 0, 1, 0, 0);
    expect(pen).toBeGreaterThan(corner);
    expect(corner).toBeGreaterThan(throwIn);
    expect(crowdTarget(MatchPhase.FREE_KICK, 30, 0, 1, 0, 0)).toBeGreaterThan(crowdTarget(MatchPhase.FREE_KICK, 0, 0, 1, 0, 0));
    expect(crowdTarget(MatchPhase.GOAL, 0, 0, 1, 0, 0)).toBeGreaterThan(0.9);
    expect(crowdTarget(MatchPhase.IN_PLAY, 0, 0, 1, 0, 0.3)).toBeCloseTo(T.baseInPlay + 0.3, 6);
    expect(crowdTarget(MatchPhase.IN_PLAY, 50, 0, 1, 0, 5)).toBe(1);
  });

  it('is finite and in 0..1 for any input', () => {
    for (const v of [Number.NaN, Infinity, -Infinity, 1e9]) {
      const t = crowdTarget(MatchPhase.IN_PLAY, v, 0, v, 0, v);
      expect(Number.isFinite(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    expect(crowdTarget(99 as MatchPhase, 0, -1, 1, 0, 0)).toBe(T.baseInPlay);
  });

  it('smoothing rises faster than it falls, converges, and ignores bad input', () => {
    const up = smoothIntensity(0.2, 0.8, 0.25);
    const down = smoothIntensity(0.8, 0.2, 0.25);
    expect(up - 0.2).toBeGreaterThan(0.8 - down);
    let v = 0;
    for (let i = 0; i < 600; i++) v = smoothIntensity(v, 0.9, 1 / 60);
    expect(v).toBeCloseTo(0.9, 3);
    // A step from 0 to 1 over one 60 Hz frame moves only a little (no jump in the bed level).
    expect(smoothIntensity(0, 1, 1 / 60)).toBeLessThan(0.05);
    expect(smoothIntensity(0.4, Number.NaN, 0.1)).toBe(0.4);
    expect(smoothIntensity(0.4, 1, Number.NaN)).toBe(0.4);
    expect(smoothIntensity(0.4, 1, -1)).toBe(0.4);
  });

  it('bed levels grow with intensity; the roar opens up (louder and brighter)', () => {
    const lo = bedLevels(0, { murmur: 0, roar: 0, roarCutoff: 0 });
    const hi = bedLevels(1, { murmur: 0, roar: 0, roarCutoff: 0 });
    expect(lo.roar).toBe(0);
    expect(hi.murmur).toBeGreaterThan(lo.murmur);
    expect(hi.roar).toBeCloseTo(T.roarMax, 6);
    expect(hi.roarCutoff).toBeGreaterThan(lo.roarCutoff);
    const mid = bedLevels(0.5, { murmur: 0, roar: 0, roarCutoff: 0 });
    expect(mid.roar).toBeLessThan(hi.roar / 2); // quadratic: calm play stays a murmur
  });
});

describe('AUD-02 reactions and perspective', () => {
  const out = (): ReactionCue => ({ reaction: Reaction.NONE, gain: 0, rate: 1, boost: 0 });

  it('goal: a big cheer for the crowd side, a quieter away-end cheer for the other side', () => {
    const home = crowdReaction(CrowdCue.GOAL, 0, 1, 0, out());
    const away = crowdReaction(CrowdCue.GOAL, 1, 1, 0, out());
    expect(home.reaction).toBe(Reaction.CHEER);
    expect(away.reaction).toBe(Reaction.CHEER);
    expect(home.gain).toBe(1);
    expect(away.gain).toBeLessThan(0.5);
    expect(home.boost).toBeGreaterThan(away.boost);
    // Perspective flips with the human's team.
    expect(crowdReaction(CrowdCue.GOAL, 1, 1, 1, out()).gain).toBe(1);
  });

  it('shots ooh (louder for better chances), near misses groan, saves applaud or groan, fouls boo or murmur', () => {
    const weak = crowdReaction(CrowdCue.SHOT, 0, 0.1, 0, out());
    const strong = crowdReaction(CrowdCue.SHOT, 0, 1, 0, out());
    expect(strong.reaction).toBe(Reaction.OOH);
    expect(strong.gain).toBeGreaterThan(weak.gain);
    expect(strong.rate).toBeGreaterThan(weak.rate); // rising ooh
    expect(crowdReaction(CrowdCue.NEAR_MISS, 0, 1, 0, out()).reaction).toBe(Reaction.GROAN);
    expect(crowdReaction(CrowdCue.NEAR_MISS, 1, 1, 0, out()).reaction).toBe(Reaction.MURMUR);
    expect(crowdReaction(CrowdCue.WOODWORK, 0, 1, 0, out()).reaction).toBe(Reaction.GROAN);
    expect(crowdReaction(CrowdCue.SAVE, 0, 1, 0, out()).reaction).toBe(Reaction.APPLAUSE);
    expect(crowdReaction(CrowdCue.SAVE, 1, 1, 0, out()).reaction).toBe(Reaction.GROAN);
    expect(crowdReaction(CrowdCue.FOUL, 1, 1, 0, out()).reaction).toBe(Reaction.BOO);
    expect(crowdReaction(CrowdCue.FOUL, 0, 1, 0, out()).reaction).toBe(Reaction.MURMUR);
    expect(crowdReaction(CrowdCue.CARD, 0, 1, 0, out()).reaction).toBe(Reaction.BOO);
    expect(crowdReaction(CrowdCue.HALF_TIME, -1, 1, 0, out()).reaction).toBe(Reaction.APPLAUSE);
    expect(crowdReaction(CrowdCue.SHOOTOUT_MISS, 1, 1, 0, out()).reaction).toBe(Reaction.CHEER);
  });

  it('every cue gives a reaction with a finite gain in 0..1', () => {
    for (let c = CrowdCue.SHOT; c <= CrowdCue.FULL_TIME; c++) {
      for (const team of [0, 1, -1]) {
        const r = crowdReaction(c, team, 0.7, 0, out());
        expect(r.reaction).not.toBe(Reaction.NONE);
        expect(r.gain).toBeGreaterThan(0);
        expect(r.gain).toBeLessThanOrEqual(1);
        expect(Number.isFinite(r.rate)).toBe(true);
      }
    }
  });

  it('perspective is the human side when only one side has humans, else home', () => {
    const one = makeScenario({ humans: [{ side: 1 }] });
    expect(perspectiveTeam(one)).toBe(1);
    const home = makeScenario({ humans: [{ side: 0 }] });
    expect(perspectiveTeam(home)).toBe(0);
    const both = makeScenario({ humans: [{ side: 0 }, { side: 1 }] });
    expect(perspectiveTeam(both)).toBe(0);
    const cpu = makeScenario({ humans: [] });
    cpu.ctrl[0]!.kind = ControllerKind.NONE;
    expect(perspectiveTeam(cpu)).toBe(0);
    expect(perspectiveTeam(null)).toBe(0);
  });
});

describe('AUD-02 seamless loops (glitch: crowd loop clicking)', () => {
  it('crowd loop clicking: the bed loops wrap with no discontinuity (last sample flows into the first)', () => {
    for (const [name, r] of [['murmur', renderMurmurBed()], ['roar', renderRoarBed()]] as const) {
      const out = render(r, T.bedSeconds, 2);
      for (const ch of out) {
        const n = ch.length;
        const wrap = Math.abs(ch[n - 1]! - ch[0]!);
        const typical = stepRms(ch);
        // A click is a jump of the order of the signal amplitude; the wrap must look like any other step.
        expect(wrap, `${name} wrap ${wrap} vs typical step ${typical}`).toBeLessThan(4 * typical);
        // And the level is the same across the crossfade region as elsewhere (no dip or bump at the seam).
        const fade = Math.round(T.bedFade * SR);
        const seam = rms(ch, n - fade, n);
        const body = rms(ch, fade, n - fade);
        expect(seam / body).toBeGreaterThan(0.75);
        expect(seam / body).toBeLessThan(1.3);
        let peak = 0;
        for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(ch[i]!));
        expect(peak).toBeLessThan(1);
        expect(body).toBeGreaterThan(0.03);
      }
    }
  });

  it('crowd loop clicking: the crossfade maths joins a smooth source exactly (wrap step = a normal step)', () => {
    // A slow sine whose period does not divide the loop: a plain loop would jump at the wrap.
    const f = 3.3;
    const sine = (): MonoSource => {
      let i = 0;
      let sr = SR;
      return { reset(r) { sr = r; i = 0; }, next() { return Math.sin((2 * Math.PI * f * i++) / sr); } };
    };
    const out = render(loopRenderer(0.25, [sine()]), 1, 1)[0]!;
    const n = out.length;
    const maxStep = (2 * Math.PI * f) / SR; // largest step of the unit sine
    expect(Math.abs(out[n - 1]! - out[0]!)).toBeLessThan(2 * maxStep);
    for (let i = 1; i < n; i++) expect(Math.abs(out[i]! - out[i - 1]!)).toBeLessThan(4 * maxStep);
  });

  it('renders the same whatever the chunk size (bank chunks) and restarts cleanly from sample 0', () => {
    const a = render(renderRoarBed(), 1, 2, 4096);
    const b = render(renderRoarBed(), 1, 2, 777);
    expect(Array.from(a[1]!.subarray(0, 2000))).toEqual(Array.from(b[1]!.subarray(0, 2000)));
    expect(a[0]!.every((v, i) => v === b[0]![i])).toBe(true);
    // The two channels are decorrelated (a wide bed, not mono).
    expect(a[0]![1000]).not.toBe(a[1]![1000]);
    const r = renderMurmurBed();
    const first = render(r, 1, 1)[0]!;
    const again = render(r, 1, 1)[0]!;
    expect(again.every((v, i) => v === first[i])).toBe(true);
  });

  it('reaction one-shots are finite, below full scale and end in silence', () => {
    for (let r = 0; r < REACTION_SPECS.length; r++) {
      const out = render(renderReaction(r), REACTION_SPECS[r]!.dur, 2);
      for (const ch of out) {
        let peak = 0;
        for (let i = 0; i < ch.length; i++) {
          expect(Number.isFinite(ch[i]!)).toBe(true);
          peak = Math.max(peak, Math.abs(ch[i]!));
        }
        expect(peak).toBeLessThan(1);
        expect(peak).toBeGreaterThan(0.05);
        expect(Math.abs(ch[0]!)).toBeLessThan(1e-3);
        expect(Math.abs(ch[ch.length - 1]!)).toBeLessThan(1e-3);
      }
    }
  });
});

function crowdOf(engine: ReturnType<typeof createAudioEngine>): CrowdModule {
  return engine.services!.modules.crowd as CrowdModule;
}

function frames(boot: Awaited<ReturnType<typeof bootRealEngine>>, state: ReadonlySimState | null, seconds: number): void {
  const n = Math.round(seconds * 60);
  for (let i = 0; i < n; i++) {
    boot.ac.advance(1 / 60);
    boot.engine.update(state, 1 / 60);
  }
}

describe('AUD-02 crowd module on the engine', () => {
  it('starts two looping bed sources at match start, follows intensity with smooth ramps, fades out at match end', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const crowd = crowdOf(boot.engine);
    expect(crowd.bedRunning).toBe(false);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], ball: { x: 0, z: 0 } });
    boot.engine.matchStart(s);
    expect(crowd.bedRunning).toBe(true);
    expect(crowd.stats.bedStarts).toBe(1);
    const loops = boot.ac.created.sources.filter((x: FakeSource) => x.loop);
    expect(loops.length).toBe(2);
    expect(loops[0]!.buffer!.length).toBe(Math.round(T.bedSeconds * SR));
    // The two loops start at different offsets so their seams never coincide.
    expect(loops[0]!.startOffset).not.toBe(loops[1]!.startOffset);

    frames(boot, s, 3);
    const calm = crowd.intensity;
    expect(calm).toBeCloseTo(T.baseInPlay, 1);
    // Build-up in the final third raises the bed.
    s.ball.x = 48;
    s.ball.owner = 9;
    frames(boot, s, 3);
    expect(crowd.intensity).toBeGreaterThan(calm + 0.2);
    // Bed gains move only through setTargetAtTime (never a step: no zipper noise / click).
    const murmurGain = loops[0]!.outputs[0] as FakeGain;
    const roarGain = loops[1]!.outputs[0] as FakeGain;
    const roarFilter = roarGain.outputs[0] as FakeBiquad;
    expect(roarFilter).toBeInstanceOf(FakeBiquad);
    const bedGains = [murmurGain, roarGain];
    expect(bedGains[0]).toBeInstanceOf(FakeGain);
    expect(bedGains[1]).toBeInstanceOf(FakeGain);
    // The roar opens up (brighter) with the build-up, also by smooth automation.
    expect(roarFilter.frequency.value).toBeGreaterThan(T.roarLpMin + 200);
    // Only the initial value written when the node was created (before any sound) is a plain write.
    expect(roarFilter.frequency.log.slice(1)).not.toContain('value');
    for (const g of bedGains) {
      expect(g.gain.log.slice(1)).not.toContain('value');
      expect(g.gain.maxStep(boot.ac.currentTime - 2, boot.ac.currentTime)).toBeLessThan(0.01);
    }
    // ATTACK_BUILD boosts.
    const before = crowd.target;
    crowd.attackBuild(0, 1);
    frames(boot, s, 0.1);
    expect(crowd.target).toBeGreaterThan(before);

    boot.engine.matchEnd();
    expect(crowd.bedRunning).toBe(false);
    for (const l of loops) expect(l.stoppedAt).toBeCloseTo(boot.ac.currentTime + T.fadeOut, 6);
    // At the stop time the bed is all but silent (no click when the loops stop).
    for (const g of bedGains) expect(g.gain.valueAt(boot.ac.currentTime + T.fadeOut)).toBeLessThan(0.005);
    frames(boot, null, 2);
    for (const g of bedGains) expect(g.gain.value).toBeLessThan(0.005);
    // Ended loops release themselves and their gains.
    for (const l of loops) l.onended?.();
    for (const g of bedGains) expect(g.disconnected).toBeGreaterThan(0);
    expect(boot.errors).toEqual([]);
    boot.engine.dispose();
  });

  it('a new match while the previous bed still fades out gets its own fresh loops and gains (no fight, no click)', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, z: 0 } });
    boot.engine.matchStart(s);
    frames(boot, s, 3);
    const first = boot.ac.created.sources.filter((x: FakeSource) => x.loop);
    const firstGain = first[0]!.outputs[0] as FakeGain;
    boot.engine.matchEnd();
    frames(boot, null, 0.3);
    boot.engine.matchStart(s);
    const all = boot.ac.created.sources.filter((x: FakeSource) => x.loop);
    expect(all.length).toBe(4);
    const secondGain = all[2]!.outputs[0] as FakeGain;
    expect(secondGain).not.toBe(firstGain);
    // The old bed keeps fading to silence; the new one fades in from 0.
    const t = boot.ac.currentTime;
    expect(firstGain.gain.valueAt(t + 1)).toBeLessThan(firstGain.gain.valueAt(t));
    expect(secondGain.gain.valueAt(t)).toBe(0);
    expect(secondGain.gain.valueAt(t + 1)).toBeGreaterThan(0.2);
    boot.engine.dispose();
  });

  it('a settled crowd sends no AudioParam automation (no work per frame once the level is steady)', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 0, z: 0 } });
    boot.engine.matchStart(s);
    frames(boot, s, 8);
    const loops = boot.ac.created.sources.filter((x: FakeSource) => x.loop);
    const murmurGain = loops[0]!.outputs[0] as FakeGain;
    const n = murmurGain.gain.log.length;
    frames(boot, s, 2);
    expect(murmurGain.gain.log.length).toBe(n);
    s.ball.x = 50;
    frames(boot, s, 0.5);
    expect(murmurGain.gain.log.length).toBeGreaterThan(n);
    boot.engine.dispose();
  });

  it('half-time lull: the bed falls toward the lull level during the break', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const crowd = crowdOf(boot.engine);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, ball: { x: 45, z: 0 } });
    boot.engine.matchStart(s);
    frames(boot, s, 3);
    const play = crowd.intensity;
    s.match.phase = MatchPhase.HALF_TIME;
    frames(boot, s, 8);
    expect(crowd.intensity).toBeLessThan(play);
    expect(crowd.intensity).toBeCloseTo(T.halfTime, 1);
    boot.engine.dispose();
  });

  it('reactions play on the crowd pool; a repeat within the cooldown is skipped unless louder; none while paused', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    const crowd = crowdOf(boot.engine);
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }] });
    boot.engine.matchStart(s);
    const pool = boot.engine.services!.crowd;
    crowd.cue(CrowdCue.GOAL, 0, 1);
    expect(crowd.stats.reactions[Reaction.CHEER]).toBe(1);
    expect(pool.active()).toBe(1);
    const cheerLen = Math.round(REACTION_SPECS[Reaction.CHEER]!.dur * SR);
    expect(boot.ac.created.sources.some((x) => x.buffer?.length === cheerLen && x.buffer.numberOfChannels === 2)).toBe(true);
    // Same reaction, not louder, within the cooldown: skipped.
    crowd.cue(CrowdCue.GOAL, 1, 1);
    expect(crowd.stats.skipped).toBe(1);
    expect(crowd.stats.reactions[Reaction.CHEER]).toBe(1);
    boot.ac.advance(T.reactionCooldown + 0.1);
    crowd.cue(CrowdCue.SHOT, 0, 0.8);
    crowd.cue(CrowdCue.NEAR_MISS, 0, 0.8);
    expect(crowd.stats.reactions[Reaction.OOH]).toBe(1);
    expect(crowd.stats.reactions[Reaction.GROAN]).toBe(1);
    boot.engine.setPaused(true);
    crowd.cue(CrowdCue.FOUL, 1, 1);
    expect(crowd.stats.reactions[Reaction.BOO]).toBe(0);
    // Pause stopped the reactions (engine, after a short fade) and the bed keeps running, ducked.
    boot.ac.advance(0.1);
    expect(pool.active()).toBe(0);
    expect(crowd.bedRunning).toBe(true);
    expect(boot.errors).toEqual([]);
    boot.engine.dispose();
  });

  it('starts the bed later when its buffers were not rendered yet at match start', async () => {
    const boot = await bootRealEngine({ createEngine: createAudioEngine });
    // Simulate a fresh engine whose bank is still rendering: dispose and re-unlock without flushing.
    boot.engine.dispose();
    const { createFakeContext, asContext, flush } = await import('./aud-01-fakes');
    const { createSettingsStore } = await import('../../src/platform/settingsStore');
    const { createMemoryStorage } = await import('../../src/platform/storage');
    const ac = createFakeContext();
    const engine = createAudioEngine(createSettingsStore(createMemoryStorage()), { createContext: () => asContext(ac), now: () => 0 });
    await engine.unlock();
    await flush();
    const crowd = engine.services!.modules.crowd as CrowdModule;
    const s = makeScenario({ phase: MatchPhase.IN_PLAY });
    engine.matchStart(s);
    expect(crowd.bedRunning).toBe(false);
    let guard = 0;
    while (!crowd.bedRunning && guard++ < 5000) {
      ac.advance(1 / 60);
      engine.update(s, 1 / 60);
    }
    expect(crowd.bedRunning).toBe(true);
    expect(ac.created.sources.filter((x) => x.loop).length).toBe(2);
    engine.dispose();
  });
});
