/**
 * [QF-15] Online final whistle (QA-42, FIX-12): a divergence after the last 30-tick hash before POST_MATCH.
 *
 * Root cause of the QF-6 glitch test failure at 4225336: T_RULES.fullTimeMinTicks (90) made FULL_TIME last >= 90
 * ticks, so a nudge at its first tick is followed by three periodic hashes, detected, and repaired by the host's
 * snapshot long before POST_MATCH; both final states are identical and 'ok' is right. The test's premise had moved;
 * it now nudges after the last hash the exchange computes (qf-6-glitch.test.ts).
 *
 * Defect found on the way (fixed in src/net/session.ts): a divergence there that moves the final whistle itself (the
 * full-time timer, a skip) left one side at its full-time screen and the other in FULL_TIME waiting for frames that
 * never come: finalCheck stayed 'pending' on both sides (never reported) and the late side showed "<friend> is not
 * responding" with Finish against CPU after 20 s, its lobby stuck in 'playing' (no rematch). Now the late side notices
 * when it passes the friend's final tick, reports it, asks for the friend's final state and hard-syncs to it.
 * Also fixed: a resync snapshot overtaken by the friend's final rewound the late side into a silent repair after the
 * mismatch had been reported (snapshots are held once past the friend's whistle), and a garbled 'session:final' (a
 * tick we cannot have reached) spoiled the comparison at our own whistle (ignored now; a suspicion raised by one just
 * behind us is withdrawn when the friend's frames go on).
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import { createInputFrame } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { SESSION_FINAL, SESSION_FINAL_STATE } from '../../src/net/session';
import { cloneState } from '../../src/sim/core/clone';
import { serializeState } from '../../src/sim/core/serialize';
import { createEventBuffer } from '../../src/sim/core/events';
import { step } from '../../src/sim/step';
import type { MemoryLinkOptions } from '../../src/net/memoryTransport';
import { createOnlinePair, hashState, type PairOptions } from './net-06-harness';
import { expectCleanFinish, expectHonestVerdict, finalWhistleTick, lastHashedTick, runWithNudge } from './qf-15-harness';

const LINKS: { name: string; link?: MemoryLinkOptions }[] = [
  { name: '30 ms' },
  { name: '80 ms / 20 ms / 5 %', link: { latencyMs: 80, jitterMs: 20, loss: 0.05 } },
];

const moveTimer = (d: number) => (s: SimState): void => {
  s.match.phaseT += d;
};

describe('QF-15 final whistle: divergences after the last 30-tick hash', () => {
  for (const { name, link } of LINKS) {
    it(`glitch: desync — a divergence after the last 30-tick hash that moves the final whistle is caught at once, reported on both sides, and the late side takes the finished side's final state (${name})`, async () => {
      const opts: PairOptions = link ? { link } : {};
      const post = await finalWhistleTick(opts);
      const at = lastHashedTick(post) + 1;
      for (const late of ['guest', 'host'] as const) {
        // -30 ticks on the full-time timer: the late side's whistle would come 30 ticks after the friend's, far past the
        // friend's last frames (its input delay). Was: finalCheck 'pending' on both sides, the late side "not
        // responding" after 20 s, its lobby still 'playing'.
        const r = await runWithNudge(opts, late, at, moveTimer(-30));
        const { h } = r;
        expect(r.hit, late).toBe(at);
        expectCleanFinish(h);
        expect(r.bothFinishedAfterMs, late).toBeGreaterThanOrEqual(0);
        expect(r.bothFinishedAfterMs, late).toBeLessThan(1500); // not the 20 s unresponsive window
        const lateP = late === 'host' ? h.host : h.guest;
        const early = late === 'host' ? h.guest : h.host;
        expect(lateP.os!.stats.finalAdopted, late).toBe(true);
        expect(early.os!.stats.finalAdopted, late).toBe(false);
        expectHonestVerdict(h);
        expect(h.host.os!.stats.finalCheck).toBe('mismatch');
        expect(lateP.logs.some((l) => l.includes('passed the friend\'s final whistle')), late).toBe(true);
        expect(lateP.notices.some((n) => n.includes('not responding')), late).toBe(false);
        // The late side shows the finished side's final: its state is that POST_MATCH state, one (inputless) tick on.
        const ef = early.state!;
        expect(ef.tick).toBe(post);
        expect(ef.match.phase).toBe(MatchPhase.POST_MATCH);
        const expected = cloneState(ef);
        step(expected, [createInputFrame(), createInputFrame()], createEventBuffer());
        expect(lateP.state!.tick).toBe(post + 1);
        expect(hashState(lateP.state!)).toBe(hashState(expected));
        const goals = (x: typeof lateP): number[] => x.session.lastSummary!.teams.map((t) => t.goals);
        expect(goals(lateP)).toEqual(goals(early));
        expect(lateP.session.lastSummary!.winner).toBe(early.session.lastSummary!.winner);
      }
    }, 120_000);
  }

  it('glitch: desync — any divergence in the last ticks before the final whistle (positions or the full-time timer, either side) ends with both sides finished and an honest verdict', async () => {
    const nudges: [string, (s: SimState) => void][] = [
      ['x', (s) => {
        s.players[7]!.x += 0.4;
      }],
      ['timer+5', moveTimer(5)],
      ['timer-40', moveTimer(-40)],
    ];
    let runs = 0;
    let mismatches = 0;
    let adoptions = 0;
    for (const { link } of LINKS) {
      const opts: PairOptions = link ? { link } : {};
      const post = await finalWhistleTick(opts);
      const last = lastHashedTick(post);
      const ticks = [...new Set([last - 1, last + 1, post - 1, post])].filter((t) => t > 0 && t <= post);
      for (const at of ticks) {
        for (const [kind, nudge] of nudges) {
          for (const who of ['guest', 'host'] as const) {
            const r = await runWithNudge(opts, who, at, nudge, 1000);
            const tag = `${kind} @${at} (post ${post}, last hash ${last}) on ${who}`;
            expect(r.hit, tag).toBe(at);
            expect(r.bothFinishedAfterMs, tag).toBeGreaterThanOrEqual(0);
            expect(r.bothFinishedAfterMs, tag).toBeLessThan(2000);
            expectCleanFinish(r.h);
            expectHonestVerdict(r.h);
            runs++;
            if (r.h.host.os!.stats.finalCheck === 'mismatch') mismatches++;
            if (r.h.host.os!.stats.finalAdopted || r.h.guest.os!.stats.finalAdopted) adoptions++;
            // A moved player the exchange never hashed can only be caught by the final check (a timer change on the
            // whistle tick itself may be wiped by the phase change: then both finals agree and 'ok' is honest).
            if (at > last && kind === 'x') expect(r.h.host.os!.stats.finalCheck, tag).toBe('mismatch');
          }
        }
      }
    }
    expect(runs).toBeGreaterThanOrEqual(40);
    expect(mismatches).toBeGreaterThan(0);
    expect(adoptions).toBeGreaterThan(0);
  }, 300_000);

  it('glitch: desync — a resync snapshot that arrives after the friend\'s final whistle (its final overtook the snapshot) never turns a reported mismatch into a silent repair', async () => {
    // The guest's full-time timer drifts just before the last hash: the host sees it there and sends a snapshot (gzip,
    // encoded asynchronously), but its 'session:final' overtakes the snapshot. The guest, already past the host's final
    // tick, had reported the mismatch; then the late snapshot rewound it and it replayed to an identical final on its
    // own: the verdict said 'mismatch' (notice on both screens) for two identical finals, with no hard-sync to explain it.
    // Now a game past the friend's final whistle takes only the friend's final state.
    for (const { link } of LINKS) {
      const opts: PairOptions = link ? { link } : {};
      const post = await finalWhistleTick(opts);
      const last = lastHashedTick(post);
      const h = createOnlinePair(opts);
      await h.startMatch();
      h.guest.onTick = (s) => {
        if (s.tick === last - 1) s.match.phaseT -= 40;
      };
      const raw = h.room.pair.host;
      const send = raw.sendReliable.bind(raw);
      const held: typeof send extends (m: infer M) => void ? M[] : never = [];
      let finalSent = false;
      raw.sendReliable = (m) => {
        if (m.type === 'ls:snap' && !finalSent) {
          held.push(m);
          return;
        }
        send(m);
        if (m.type === SESSION_FINAL && !finalSent) {
          finalSent = true;
          for (const x of held.splice(0)) send(x);
        }
      };
      expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000)).toBe(true);
      await h.run(2000);
      expect(finalSent).toBe(true);
      expect(h.host.os!.stats.desyncs).toBe(1); // the last hash saw it
      expectCleanFinish(h);
      expectHonestVerdict(h);
    }
  }, 120_000);

  it('a rematch after a final-whistle hard-sync starts clean and ends in step', async () => {
    const post = await finalWhistleTick();
    const r = await runWithNudge({}, 'guest', lastHashedTick(post) + 1, moveTimer(-30));
    const h = r.h;
    expect(h.guest.os!.stats.finalAdopted).toBe(true);
    const old = h.host.os!;
    h.guest.onTick = null;
    await h.rematch();
    expect(h.host.os).not.toBe(old);
    expect(h.host.os!.stats.finalCheck).toBe('pending');
    expect(h.guest.os!.stats.finalAdopted).toBe(false);
    expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000)).toBe(true);
    await h.run(500);
    expect(h.host.state!.tick).toBe(h.guest.state!.tick);
    expect(hashState(h.host.state!)).toBe(hashState(h.guest.state!));
    expect(h.host.os!.stats.finalCheck).toBe('ok');
    expect(h.guest.os!.stats.finalCheck).toBe('ok');
    expect(h.host.os!.stats.desyncs + h.guest.os!.stats.desyncs).toBe(0);
  }, 120_000);

  it('the late side\'s request lost with a dropped link is sent again once the link is back, and the hard-sync still happens', async () => {
    const post = await finalWhistleTick();
    const h = createOnlinePair();
    await h.startMatch();
    const at = lastHashedTick(post) + 1;
    h.guest.onTick = (s) => {
      if (s.tick === at) s.match.phaseT -= 30;
    };
    // Drop the finished host's answer once (the link dies with it), then let the session re-dial.
    const raw = h.room.pair.host;
    const send = raw.sendReliable.bind(raw);
    let dropped = 0;
    raw.sendReliable = (m) => {
      if (m.type === SESSION_FINAL_STATE && dropped === 0) {
        dropped++;
        h.room.pair.sever();
        return;
      }
      send(m);
    };
    expect(await h.runUntil(() => h.host.session.finished, 120_000)).toBe(true);
    expect(await h.runUntil(() => dropped > 0, 5000)).toBe(true);
    expect(h.guest.session.finished).toBe(false);
    expect(await h.runUntil(() => h.guest.session.finished, 15_000)).toBe(true); // re-dial (~1 s), request again, hard-sync
    await h.run(1000);
    expect(h.guest.os!.stats.finalAdopted).toBe(true);
    expectCleanFinish(h);
    expectHonestVerdict(h);
  }, 120_000);

  it('the friend left before answering: the late side still reports it and can finish against the CPU', async () => {
    const post = await finalWhistleTick();
    const h = createOnlinePair();
    await h.startMatch();
    const at = lastHashedTick(post) + 1;
    h.guest.onTick = (s) => {
      if (s.tick === at) s.match.phaseT -= 30;
    };
    // The host leaves the room the moment its match ends (before the guest's request can reach it).
    let left = false;
    h.host.session.afterTick = ((orig) => (rt) => {
      orig(rt);
      if (!left && h.host.session.finished) {
        left = true;
        h.host.os!.dispose();
        h.host.lobby.leave();
      }
    })(h.host.session.afterTick.bind(h.host.session));
    expect(await h.runUntil(() => left, 120_000)).toBe(true);
    expect(await h.runUntil(() => h.guest.os!.status.kind === 'opponent-gone', 25_000)).toBe(true);
    expect(h.guest.os!.stats.finalCheck).toBe('mismatch');
    expect(h.guest.logs.some((l) => l.includes('desync at full time'))).toBe(true);
    expect(h.guest.os!.finishAgainstCpu()).toBe(true);
    expect(await h.runUntil(() => h.guest.session.finished, 20_000)).toBe(true);
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.guest.errors).toEqual([]);
  }, 120_000);

  it('a stray or garbled session:final mid-match (a tick just behind ours, or one we cannot have reached) never holds, ends or desyncs the match, nor spoils the final verdict', async () => {
    const h = createOnlinePair({ config: { halfMinutes: 0.2 } });
    await h.startMatch();
    await h.run(1500);
    const t = h.guest.state!.tick;
    h.room.pair.host.sendReliable({ type: SESSION_FINAL, tick: t - 1, h: 12345, mt: 'm1' });
    h.room.pair.host.sendReliable({ type: SESSION_FINAL, tick: t + 900_000, h: 1, mt: 'm1' });
    h.room.pair.host.sendReliable({ type: SESSION_FINAL_STATE, tick: t - 1, i: 0, n: 1, data: '{"garbage":1}', mt: 'm1' });
    await h.run(500);
    expect(h.guest.state!.tick).toBeGreaterThan(t + 20); // never held waiting for a final state
    expect(h.guest.os!.status.kind).not.toBe('ended');
    expect(h.guest.os!.stats.finalAdopted).toBe(false);
    expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000)).toBe(true);
    await h.run(500);
    expect(h.host.state!.tick).toBe(h.guest.state!.tick);
    expect(hashState(h.host.state!)).toBe(hashState(h.guest.state!));
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.guest.logs.some((l) => l.includes('did not hold'))).toBe(true); // the suspicion was withdrawn
    expect(h.host.os!.stats.finalCheck).toBe('ok');
    expect(h.guest.os!.stats.finalCheck).toBe('ok');
    expect(h.guest.os!.provider.lockstep?.guard.held ?? false).toBe(false);
    expect(h.guest.errors).toEqual([]);
  }, 120_000);

  it('an unusable final state (wrong phase) is never applied: the late side keeps waiting and gets the not-responding choice', async () => {
    const post = await finalWhistleTick();
    const h = createOnlinePair();
    await h.startMatch();
    const at = lastHashedTick(post) + 1;
    h.guest.onTick = (s) => {
      if (s.tick === at) s.match.phaseT -= 30;
    };
    // The host's real answer is dropped; a final state that is not a POST_MATCH state arrives instead.
    const raw = h.room.pair.host;
    const send = raw.sendReliable.bind(raw);
    raw.sendReliable = (m) => {
      if (m.type !== SESSION_FINAL_STATE) send(m);
    };
    expect(await h.runUntil(() => h.host.session.finished, 120_000)).toBe(true);
    expect(await h.runUntil(() => h.guest.os!.stats.finalCheck === 'mismatch', 5000)).toBe(true);
    expect(h.guest.session.finished).toBe(false);
    const fake = cloneState(h.guest.state!);
    fake.tick = post;
    send({ type: SESSION_FINAL_STATE, tick: post, i: 0, n: 1, data: serializeState(fake), mt: 'm1' });
    await h.run(1000);
    expect(h.guest.logs.some((l) => l.includes('final state is unusable'))).toBe(true);
    expect(h.guest.os!.stats.finalAdopted).toBe(false);
    expect(h.guest.state!.match.phase).not.toBe(MatchPhase.POST_MATCH);
    expect(h.guest.os!.status.kind).not.toBe('ended');
    // Nothing usable comes: the watchdog's card after the rejoin window, then Finish against CPU ends it normally.
    expect(await h.runUntil(() => h.guest.os!.status.kind === 'opponent-gone', 25_000)).toBe(true);
    expect(h.guest.os!.status.reason).toBe('unresponsive');
    expect(h.guest.os!.finishAgainstCpu()).toBe(true);
    expect(await h.runUntil(() => h.guest.session.finished, 20_000)).toBe(true);
    expect(h.guest.os!.status.kind).toBe('finished');
    expect(h.host.os!.status.kind).toBe('finished'); // the finished side keeps its full-time screen
    expect(h.host.os!.stats.finalCheck).toBe('mismatch');
    expect(h.guest.errors).toEqual([]);
  }, 120_000);
});
