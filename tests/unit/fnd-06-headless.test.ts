/**
 * FND-06: headless runner (tools/headless.ts), config variation and hostile input generators.
 */
import { describe, expect, it } from 'vitest';
import { Command, KickKind, ModeId, Period } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn, createInputFrame, INPUT_FIELDS, type InputFrame } from '../../src/contracts/input';
import { createMatchConfig } from '../../src/contracts/state';
import { PACKED_FRAME_INTS, packFrames, unpackFrames } from '../../src/sim/core/serialize';
import { initMatch, periodLength } from '../../src/sim/init';
import { replayFramesAt } from '../../src/sim/replay';
import { CLUBS } from '../../src/data/clubs';
import { defaultMaxTicks, EVENT_NAMES, isPassStatKind, runMatch } from '../../tools/headless';
import { fuzzConfig, soakConfig } from '../../tools/lib/configs';
import { createHostile, HOSTILE_KINDS } from '../../tools/lib/hostile';

function botConfig(seed: number) {
  const c = createMatchConfig();
  c.seed = seed;
  c.halfMinutes = 2;
  c.humans = [
    { kind: 0, side: -1, assist: 0, autoSwitch: 1, fastPower: 0 },
    { kind: 0, side: -1, assist: 0, autoSwitch: 1, fastPower: 0 },
  ];
  return c;
}

describe('FND-06 runMatch', () => {
  it('same seed twice gives the same hash; another seed gives another hash', () => {
    const a = runMatch({ config: botConfig(5), maxTicks: 1200, checker: 'core' });
    const b = runMatch({ config: botConfig(5), maxTicks: 1200, checker: 'core' });
    const c = runMatch({ config: botConfig(6), maxTicks: 1200, checker: 'core' });
    expect(a.exception).toBeUndefined();
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
  });

  it('terminates at maxTicks and reports ticks, phase, events and stats', () => {
    const r = runMatch({ config: botConfig(1), maxTicks: 300 });
    expect(r.ticks).toBe(300);
    expect(r.finished).toBe(false);
    expect(Object.keys(r.events)).toEqual(EVENT_NAMES.filter((n) => n !== undefined));
    expect(r.stats.goals).toEqual([r.state.teams[0]!.goals, r.state.teams[1]!.goals]);
    const poss = r.stats.possessionPct[0] + r.stats.possessionPct[1];
    expect(poss === 0 || Math.abs(poss - 100) < 1e-9).toBe(true);
    expect(r.perf.simMsAvg).toBeGreaterThan(0);
    expect(r.invariantFailures.count).toBe(r.invariantFailures.first.length);
  });

  it('default maxTicks covers the halves (+ extra time and shoot-out for cup rules) + 30%', () => {
    const c = botConfig(1);
    const half = periodLength(c, Period.FIRST_HALF);
    expect(defaultMaxTicks(c)).toBeGreaterThanOrEqual(Math.ceil(2 * half * 1.3));
    const cup = { ...c, cupRules: 1 };
    expect(defaultMaxTicks(cup)).toBeGreaterThan(defaultMaxTicks(c) + 2 * periodLength(cup, Period.ET_FIRST));
    expect(defaultMaxTicks({ ...c, mode: ModeId.PRACTICE })).toBeGreaterThan(0);
  });

  it('captures an exception (here from the input script) instead of throwing', () => {
    const r = runMatch({
      config: botConfig(1), maxTicks: 500,
      inputs: (tick) => { if (tick === 50) throw new Error('boom'); },
    });
    expect(r.exception?.message).toBe('boom');
    expect(r.exception?.where).toBe('inputs');
    expect(r.ticks).toBe(49);
  });

  it('collects invariant failures: a score change without a GOAL event is caught by the core set', () => {
    const r = runMatch({
      config: botConfig(1), maxTicks: 40, checker: 'core',
      onTick: (s) => { if (s.tick === 10) s.teams[0]!.goals += 3; },
    });
    expect(r.invariantFailures.count).toBeGreaterThanOrEqual(1);
    expect(r.invariantFailures.byName.score).toBeGreaterThanOrEqual(1);
    expect(r.invariantFailures.first[0]).toContain('t=11 [score] team 0 score changed by 3 with 0 GOAL event(s)');
  });

  it('checker none skips invariants; onTick returning true stops the run', () => {
    const r = runMatch({ config: botConfig(1), maxTicks: 1000, checker: 'none', onTick: (s) => s.tick >= 77 });
    expect(r.ticks).toBe(77);
    expect(r.invariantFailures.count).toBe(0);
    expect(r.perf.checkMsAvg).toBe(0);
  });

  it('fastCutscenes feeds SKIP edges (button + command) in cut-scene phases, visible in the replay', () => {
    const r = runMatch({ config: botConfig(1), maxTicks: 4, fastCutscenes: true, record: true, checker: 'none' });
    const f = [createInputFrame(), createInputFrame()];
    replayFramesAt(r.replay!, 1, f); // tick 1 is simulated from PRE_MATCH, phaseT 0
    expect(f[0]!.buttons & Btn.SKIP).toBe(Btn.SKIP);
    expect(f[1]!.cmd).toBe(Command.SKIP);
  });

  it('isPassStatKind covers foot passes, crosses, through balls and headed / volleyed passes only', () => {
    expect(isPassStatKind(KickKind.GROUND_PASS)).toBe(true);
    expect(isPassStatKind(KickKind.THROUGH_DINKED)).toBe(true);
    expect(isPassStatKind(KickKind.HEADER_PASS)).toBe(true);
    expect(isPassStatKind(KickKind.SHOT_NORMAL)).toBe(false);
    expect(isPassStatKind(KickKind.CLEARANCE)).toBe(false);
    expect(isPassStatKind(KickKind.GOAL_KICK)).toBe(false);
    expect(EVENT_NAMES[EventType.PASS_COMPLETE]).toBe('PASS_COMPLETE');
  });
});

describe('FND-06 config variation', () => {
  it('soak configs are deterministic, bot-v-bot and in range', () => {
    for (let i = 0; i < 50; i++) {
      const a = soakConfig(i, 9, { halfMinutes: 3 });
      expect(soakConfig(i, 9, { halfMinutes: 3 })).toEqual(a);
      expect(a.homeClub).not.toBe(a.awayClub);
      expect(a.homeClub).toBeLessThan(CLUBS.length);
      expect(a.awayClub).toBeLessThan(CLUBS.length);
      expect(a.homeFormation).toBeLessThanOrEqual(5);
      expect(a.difficulty).toBeLessThanOrEqual(5);
      expect(a.halfMinutes).toBe(3);
      expect(a.humans.every((h) => h.kind === 0)).toBe(true);
      expect(() => initMatch(a)).not.toThrow();
    }
    expect(soakConfig(0, 1, { halfMinutes: 2 }).seed).not.toBe(soakConfig(1, 1, { halfMinutes: 2 }).seed);
  });

  it('fuzz configs have one or two humans and varied modes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const f = fuzzConfig(i, 3, 2);
      seen.add(f.humans);
      const humans = f.config.humans.filter((h) => h.kind === 1);
      expect(humans.length).toBeGreaterThanOrEqual(1);
      if (f.config.mode === ModeId.PRACTICE) expect(f.expectFinish).toBe(false);
    }
    expect([...seen].sort()).toEqual(['coop', 'p1-away', 'p1-home', 'p1-vs-p2']);
  });
});

describe('FND-06 hostile input generators', () => {
  function runGen(kind: (typeof HOSTILE_KINDS)[number], seed: number, ticks: number): InputFrame[] {
    const s = initMatch(createMatchConfig());
    const g = createHostile(kind, seed, 0);
    const out: InputFrame[] = [];
    for (let t = 1; t <= ticks; t++) {
      const f = createInputFrame();
      g.fill(t, s, f);
      out.push(f);
    }
    return out;
  }

  it('every generator is deterministic per seed and stays inside the replay codec ranges', () => {
    const packed = new Int16Array(PACKED_FRAME_INTS);
    const back = [createInputFrame(), createInputFrame()];
    for (const kind of HOSTILE_KINDS) {
      const a = runGen(kind, 42, 600);
      expect(runGen(kind, 42, 600)).toEqual(a);
      for (const f of a) {
        const r = f as unknown as Record<string, number>;
        for (const k of INPUT_FIELDS) {
          const v = r[k]!;
          expect(Number.isInteger(v)).toBe(true);
          if (k === 'buttons' || k === 'gFlags') { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(0xffff); } else {
            expect(v).toBeGreaterThanOrEqual(-32768);
            expect(v).toBeLessThanOrEqual(32767);
          }
        }
        // The replay codec carries the frame exactly, so fuzz matches replay.
        packFrames([f, f], packed, 0);
        unpackFrames(packed, 0, back);
        expect(back[0]).toEqual(f);
      }
    }
  });

  it('hostile kinds produce what they promise', () => {
    const all = runGen('allButtons', 1, 100);
    expect(all.some((f) => (f.buttons & 0x7ff) === 0x7ff)).toBe(true);
    const flip = runGen('flip', 1, 10);
    for (let i = 1; i < flip.length; i++) expect(Math.sign(flip[i]!.mx)).toBe(-Math.sign(flip[i - 1]!.mx));
    const skip = runGen('skipSpam', 1, 50);
    expect(skip.every((f) => (f.buttons & Btn.SKIP) !== 0)).toBe(true);
    expect(skip.some((f) => f.cmd === Command.SUBSTITUTE)).toBe(true); // PRE_MATCH is a stoppage
    const ext = runGen('extremes', 1, 50);
    expect(ext.some((f) => f.mx === 32767 || f.mx === -32768)).toBe(true);
    const gest = runGen('gestures', 1, 200);
    expect(gest.some((f) => f.gesture > 5)).toBe(true); // unknown gesture kinds
    expect(runGen('idle', 1, 20).every((f) => f.buttons === 0 && f.mx === 0)).toBe(true);
    expect(runGen('mixed', 7, 2000).length).toBe(2000);
  });
});
