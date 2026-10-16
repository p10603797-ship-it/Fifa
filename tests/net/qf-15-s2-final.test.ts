/**
 * [QF-15 second pass] Online final whistle (QA-42, FIX-12), attacked from angles the first pass did not use.
 *
 * Defect fixed (src/net/session.ts): a stale or garbled 'session:final' whose tick lies behind the frames the friend
 * has already sent was kept, and the comparison at our own whistle reported a false 'mismatch' (log + "did not agree at
 * the final whistle" notice) although both games ended identically. The first pass ignored only finals ahead of what
 * the friend can have reached and finals one tick behind (withdrawn when the frames go on); a final 12 or 60 ticks
 * behind stayed and spoiled the verdict. A game that finished at tick F generated frames up to F + its input delay
 * (<= NET_DELAY_MAX), or NET_DELAY_MAX more when a resync or the final hard-sync rewound it after it had gone past F;
 * frames beyond that contradict the final, and such a final is now ignored on arrival or dropped as soon as the
 * friend's frames pass it.
 *
 * Also pinned here (no defect found, new angles): a cup match decided in a shoot-out, a link drop at the whistle while
 * one side's whistle moved, every order of the host's resync snapshot and its final whistle, a pause or a hidden page
 * on the late side while it waits for the friend's final state, a guest page that reloads during the full-time whistle
 * (the final check after a rejoin), and the late guest's page reloading while it waits.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import type { MemoryLinkOptions } from '../../src/net/memoryTransport';
import { SESSION_FINAL, SESSION_FINAL_STATE } from '../../src/net/session';
import type { ControlMessage } from '../../src/net/types';
import { createOnlinePair, type PairOptions } from './net-06-harness';
import { expectCleanFinish, expectHonestVerdict, finalWhistleTick, lastHashedTick } from './qf-15-harness';

const LOSSY: MemoryLinkOptions = { latencyMs: 80, jitterMs: 20, loss: 0.05 };

/** Both sides level the score on the 1st tick of every FULL_TIME (same tick on both: the sims stay identical). */
const levelAtFullTime = (s: SimState): void => {
  if (s.match.phase === MatchPhase.FULL_TIME && s.match.phaseT === 1) s.teams[1]!.goals = s.teams[0]!.goals;
};

describe('QF-15 second pass: online final whistle', () => {
  it('glitch: desync — a stale or garbled session:final behind our tick (the friend\'s frames already went past it) never spoils the final verdict', async () => {
    for (const back of [12, 60]) {
      for (const target of ['guest', 'host'] as const) {
        const h = createOnlinePair({ config: { halfMinutes: 0.2 } });
        await h.startMatch();
        await h.run(3000);
        const victim = target === 'guest' ? h.guest : h.host;
        const from = target === 'guest' ? h.room.pair.host : h.room.pair.guest;
        const t = victim.state!.tick;
        from.sendReliable({ type: SESSION_FINAL, tick: t - back, h: 777, mt: 'm1' });
        expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000)).toBe(true);
        await h.run(1000);
        const tag = `${back} behind into the ${target}`;
        expect(h.host.state!.tick, tag).toBe(h.guest.state!.tick);
        // was: 'mismatch' on the victim, with the notice and a 'desync at full time' report for two identical finals
        expect(h.host.os!.stats.finalCheck, tag).toBe('ok');
        expect(h.guest.os!.stats.finalCheck, tag).toBe('ok');
        expect(victim.notices.some((n) => n.includes('did not agree')), tag).toBe(false);
        expect(victim.logs.some((l) => l.includes('desync at full time')), tag).toBe(false);
        expect(victim.logs.some((l) => l.includes('contradicted by its frames')), tag).toBe(true);
        expectCleanFinish(h);
      }
    }
  }, 120_000);

  it('glitch: desync — a divergence after the last hash in the last RESULT of a cup shoot-out is caught; the late side takes the finished side\'s final state and both screens show the same winner', async () => {
    const opts: PairOptions = { config: { cupRules: 1 } };
    const d = createOnlinePair(opts);
    await d.startMatch();
    let before = -1;
    d.host.onTick = (s) => {
      levelAtFullTime(s);
      if (before < 0 && s.match.phase === MatchPhase.POST_MATCH) before = s.match.prevPhase;
    };
    d.guest.onTick = levelAtFullTime;
    expect(await d.runUntil(() => d.host.session.finished && d.guest.session.finished, 300_000)).toBe(true);
    await d.run(1000);
    expect(before).toBe(MatchPhase.SHOOT_OUT); // extra time, then penalties
    expect(d.host.os!.stats.finalCheck).toBe('ok');
    const post = d.host.state!.tick;
    const at = lastHashedTick(post) + 1;
    const nudges: [string, (s: SimState) => void, boolean][] = [
      // the RESULT timer: the late side's whistle comes 40 ticks after the friend's, past its last frames
      ['result timer -40', (s) => {
        s.match.shootout.subT -= 40;
      }, true],
      // a moved player: both whistles on the same tick, two different final states
      ['player x', (s) => {
        s.players[2]!.x += 0.5;
      }, false],
    ];
    for (const [kind, nudge, adopt] of nudges) {
      for (const who of ['guest', 'host'] as const) {
        const tag = `${kind} on the ${who}`;
        const h = createOnlinePair(opts);
        await h.startMatch();
        const me = who === 'host' ? h.host : h.guest;
        const other = who === 'host' ? h.guest : h.host;
        let hit = -1;
        other.onTick = levelAtFullTime;
        me.onTick = (s) => {
          levelAtFullTime(s);
          if (hit < 0 && s.tick === at) {
            hit = at;
            expect(s.match.phase, tag).toBe(MatchPhase.SHOOT_OUT);
            nudge(s);
          }
        };
        expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 300_000), tag).toBe(true);
        await h.run(1500);
        expect(hit, tag).toBe(at);
        expectCleanFinish(h);
        expectHonestVerdict(h);
        expect(h.host.os!.stats.finalCheck, tag).toBe('mismatch');
        expect(me.os!.stats.finalAdopted, tag).toBe(adopt);
        expect(other.os!.stats.finalAdopted, tag).toBe(false);
        expect(h.host.session.lastSummary!.winner, tag).toBe(h.guest.session.lastSummary!.winner);
        expect(h.host.state!.match.shootout.goals, tag).toEqual(h.guest.state!.match.shootout.goals);
      }
    }
  }, 300_000);

  it('glitch: desync — the link drops at the final whistle while one side\'s whistle moved: after the re-dial the late side still gets the final state and both rooms reopen', async () => {
    const post = await finalWhistleTick();
    const at = lastHashedTick(post) + 1;
    for (const dropAt of [post - 1, post]) {
      for (const late of ['guest', 'host'] as const) {
        const tag = `drop at ${dropAt} (whistle ${post}), late ${late}`;
        const h = createOnlinePair();
        await h.startMatch();
        const lp = late === 'guest' ? h.guest : h.host;
        const ep = late === 'guest' ? h.host : h.guest;
        let dropped = false;
        lp.onTick = (s) => {
          if (s.tick === at) s.match.phaseT -= 30;
        };
        ep.onTick = (s) => {
          if (!dropped && s.tick === dropAt) {
            dropped = true;
            h.room.pair.sever(); // at the whistle tick: the early side's 'session:final' is sent with the link down
          }
        };
        expect(await h.runUntil(() => h.host.session.finished && h.guest.session.finished, 120_000), tag).toBe(true);
        await h.run(3000);
        expect(dropped, tag).toBe(true);
        expect(lp.os!.stats.finalAdopted, tag).toBe(true);
        expectCleanFinish(h);
        expectHonestVerdict(h);
        expect(lp.state!.tick, tag).toBe(post + 1);
      }
    }
  }, 120_000);

  it('glitch: desync — any order of the host\'s resync snapshot and its final whistle (each held back up to 600 ms) ends both sides finished with an honest verdict', async () => {
    for (const link of [undefined, LOSSY]) {
      const opts: PairOptions = link ? { link } : {};
      const post = await finalWhistleTick(opts);
      const last = lastHashedTick(post);
      for (const [snapMs, finalMs] of [[60, 600], [0, 600], [300, 0], [300, 300], [600, 100]] as const) {
        const tag = `${link ? 'lossy' : '30 ms'}: snapshot +${snapMs} ms, final +${finalMs} ms`;
        const h = createOnlinePair(opts);
        await h.startMatch();
        h.guest.onTick = (s) => {
          if (s.tick === last - 1) s.match.phaseT -= 40; // seen by the last hash: the host sends a snapshot
        };
        const raw = h.room.pair.host;
        const send = raw.sendReliable.bind(raw);
        const held: { m: ControlMessage; at: number }[] = [];
        raw.sendReliable = (m) => {
          const ms = m.type === 'ls:snap' ? snapMs : m.type === SESSION_FINAL ? finalMs : 0;
          if (ms > 0) held.push({ m, at: h.clock.now() + ms });
          else send(m);
        };
        for (let i = 0; i < 4000 && !(h.host.session.finished && h.guest.session.finished && held.length === 0); i++) {
          await h.run(16);
          for (let k = 0; k < held.length; k++) {
            if (held[k]!.at > h.clock.now()) continue;
            send(held[k]!.m);
            held.splice(k--, 1);
          }
        }
        await h.run(2000);
        expect(h.host.os!.stats.desyncs, tag).toBe(1);
        expectCleanFinish(h);
        expectHonestVerdict(h);
        // Either the snapshot repaired it before the whistle ('ok'), or the guest went past the host's whistle first and
        // took the host's final state (then never the snapshot as well).
        const g = h.guest.os!.stats;
        if (g.finalAdopted) expect(g.resyncs, tag).toBe(0);
        else expect(h.guest.os!.stats.finalCheck, tag).toBe('ok');
      }
    }
  }, 120_000);

  it('glitch: desync — the late side pauses or hides its page while it waits for the friend\'s final state: the hard-sync waits for the resume and both matches still end cleanly', async () => {
    const post = await finalWhistleTick();
    const at = lastHashedTick(post) + 1;
    for (const how of ['pause', 'hidden'] as const) {
      for (const late of ['guest', 'host'] as const) {
        const tag = `${how} on the late ${late}`;
        const h = createOnlinePair();
        await h.startMatch();
        const lp = late === 'guest' ? h.guest : h.host;
        lp.onTick = (s) => {
          if (s.tick === at) s.match.phaseT -= 30;
        };
        expect(await h.runUntil(() => lp.os!.stats.finalCheck === 'mismatch', 120_000), tag).toBe(true);
        if (how === 'pause') lp.session.pause(lp.os!.localHuman);
        else lp.session.setHidden(true);
        expect(lp.session.paused, tag).toBe(true);
        await h.run(how === 'pause' ? 3000 : 25_000); // hidden: longer than the 20 s watchdog window
        expect(lp.session.finished, tag).toBe(false); // nothing is applied while the game is held
        expect(lp.os!.status.kind, tag).toBe('paused');
        if (how === 'hidden') lp.session.setHidden(false);
        if (lp.session.paused) lp.session.resume(lp.session.pausedBy);
        await h.run(1000);
        expect(lp.os!.stats.finalAdopted, tag).toBe(true);
        expectCleanFinish(h);
        expectHonestVerdict(h);
      }
    }
  }, 120_000);

  it('a guest page that reloads during the full-time whistle (before or after the last hash) rejoins, both reach the same final whistle and the final check says ok on both sides', async () => {
    const post = await finalWhistleTick();
    const last = lastHashedTick(post);
    for (const at of [last - 5, last + 2]) {
      const h = createOnlinePair();
      await h.startMatch();
      expect(await h.runUntil(() => h.guest.state!.tick >= at, 120_000)).toBe(true);
      expect(h.guest.state!.match.phase).toBe(MatchPhase.FULL_TIME);
      const g = h.reloadGuest();
      expect(await h.runUntil(() => h.host.session.finished && g.session.finished, 120_000), `reload at ${at}`).toBe(true);
      await h.run(1500);
      expect(g.os!.stats.rejoins, `reload at ${at}`).toBe(1);
      expect(g.state!.tick, `reload at ${at}`).toBe(h.host.state!.tick);
      expect(h.host.os!.stats.finalCheck, `reload at ${at}`).toBe('ok');
      expect(g.os!.stats.finalCheck, `reload at ${at}`).toBe('ok');
      expect(h.host.lobby.phase).toBe('lobby');
      expect(g.lobby.phase).toBe('lobby');
    }
  }, 120_000);

  it('a late guest whose page reloads while it waits for the final state joins the finished host\'s room as a fresh guest', async () => {
    const post = await finalWhistleTick();
    const at = lastHashedTick(post) + 1;
    const h = createOnlinePair();
    await h.startMatch();
    h.guest.onTick = (s) => {
      if (s.tick === at) s.match.phaseT -= 30;
    };
    const raw = h.room.pair.host;
    const send = raw.sendReliable.bind(raw);
    raw.sendReliable = (m) => {
      if (m.type !== SESSION_FINAL_STATE) send(m); // the answer never comes: the guest sits waiting
    };
    expect(await h.runUntil(() => h.guest.os!.stats.finalCheck === 'mismatch', 120_000)).toBe(true);
    await h.run(500);
    expect(h.host.session.finished).toBe(true);
    expect(h.guest.session.finished).toBe(false);
    const g = h.reloadGuest();
    await h.run(4000);
    expect(g.lobby.phase).toBe('lobby');
    expect(g.lobby.error).toBeNull();
    expect(h.host.lobby.phase).toBe('lobby');
    expect(h.host.lobby.peer?.nickname).toBe('Ben');
    expect(h.host.os!.status.kind).toBe('finished');
    expect(h.host.os!.stats.finalCheck).toBe('mismatch');
    expect(h.host.errors).toEqual([]);
    expect(g.errors).toEqual([]);
  }, 120_000);
});
