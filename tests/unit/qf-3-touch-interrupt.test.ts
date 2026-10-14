/**
 * QF-3 QA-24: pointercancel and interruptions in the middle of every hold, through the real touch source on a fake
 * DOM (qf-3-touch-rig: the real pointer manager listens on the fake window / document / touch layer). Holds: the
 * stick, SPRINT, a charging PASS (power bar), 2ND DEF, a set-piece swipe with its preview, a pitch finger. Interruptions:
 * pointercancel, lostpointercapture, window blur, page hidden, pagehide, orientationchange, screen.orientation change,
 * a real resize, touchend reporting no finger left (the pointerup never came), and the session's releaseAll (pause).
 * After each: the very next frame holds nothing, the sim's charge ends (no power bar stuck full), the stale pointer's
 * later moves do nothing, and a fresh touch works again.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, RestartKind } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ClusterSlot } from '../../src/contracts/touch';
import { NULL_SINK } from '../../src/sim/core/events';
import { awardRestart } from '../../src/sim/rules/restart';
import { makeScenario } from '../harness/scenario';
import { centreOn, createTouchRig, scr, type TouchRig } from './qf-3-touch-rig';

function attackState(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 9 }], players: [{ slot: 9, x: 10, z: 0 }],
    ball: { owner: 9, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

function defenceState(): SimState {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY, humans: [{ side: 0, slot: 4 }],
    players: [{ slot: 4, x: -24, z: 2 }, { slot: 18, x: -20, z: 0 }],
    ball: { owner: 18, lastTouchTeam: 1, x: -19.6, y: 0.11, z: 0 },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return s;
}

interface Hold {
  name: string;
  state(): SimState;
  /** Start the hold with pointer 1; returns where the finger is. */
  start(r: TouchRig): { x: number; y: number };
  /** The hold shows in the frame / intent state now. */
  live(r: TouchRig): boolean;
}

const HOLDS: Hold[] = [
  {
    name: 'stick', state: attackState,
    start: (r) => { r.down(1, 250, 520); r.drag(1, 250, 520, 320, 520, 50, 3); return { x: 320, y: 520 }; },
    live: (r) => r.frames.at(-1)!.mx > 60,
  },
  {
    name: 'SPRINT', state: attackState,
    start: (r) => { const p = r.slot(ClusterSlot.BIG); r.down(1, p.x, p.y); r.wait(300); return p; },
    live: (r) => (r.frames.at(-1)!.buttons & Btn.SPRINT) !== 0,
  },
  {
    name: 'PASS charging', state: attackState,
    start: (r) => { const p = r.slot(ClusterSlot.LOW); r.down(1, p.x, p.y); r.wait(300); return p; },
    live: (r) => (r.frames.at(-1)!.buttons & Btn.PASS) !== 0 && r.s.ctrl[0]!.powerBtn !== 0,
  },
  {
    name: '2ND DEF', state: defenceState,
    start: (r) => { const p = r.slot(ClusterSlot.MID); r.down(1, p.x, p.y); r.wait(300); return p; },
    live: (r) => (r.frames.at(-1)!.buttons & Btn.MOD_R) !== 0,
  },
  {
    name: 'free-kick swipe', state: () => {
      const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: [{ side: 0 }], ball: { owner: -1, x: 30, z: 5, y: 0.11 } });
      awardRestart(s, RestartKind.FREE_KICK, 0, 30, 5, NULL_SINK);
      return s;
    },
    start: (r) => {
      for (let i = 0; i < 400 && r.s.match.restart.ready !== 1; i++) r.tick();
      centreOn(r.s.ball.x, r.s.ball.z);
      r.tick();
      const b = scr(r.s.ball.x, r.s.ball.z), t = scr(45, 2);
      r.down(1, b.x, b.y);
      r.drag(1, b.x, b.y, t.x, t.y, 200, 6);
      return t;
    },
    live: (r) => r.st.previewCount > 1,
  },
];

interface Interruption { name: string; run(r: TouchRig): void }

const INTERRUPTIONS: Interruption[] = [
  { name: 'pointercancel', run: (r) => r.cancel(1) },
  { name: 'lostpointercapture', run: (r) => { r.el.dispatch('lostpointercapture', { pointerId: 1 }); } },
  { name: 'window blur', run: (r) => { r.win.dispatch('blur'); } },
  { name: 'page hidden', run: (r) => { r.doc.visibilityState = 'hidden'; r.doc.dispatch('visibilitychange'); r.doc.visibilityState = 'visible'; } },
  { name: 'pagehide', run: (r) => { r.win.dispatch('pagehide'); } },
  { name: 'orientationchange', run: (r) => { r.win.dispatch('orientationchange'); } },
  { name: 'screen.orientation change', run: (r) => { r.win.screen.orientation.dispatch('change'); } },
  { name: 'resize', run: (r) => { r.win.innerWidth = 1100; r.win.dispatch('resize'); } },
  { name: 'session releaseAll (pause)', run: (r) => r.releaseAll() },
];

describe('QF-3 QA-24 interruptions mid-hold', () => {
  for (const h of HOLDS) {
    for (const it2 of INTERRUPTIONS) {
      it(`glitch: stuck sprint or stick after pointercancel - ${h.name} interrupted by ${it2.name}`, () => {
        const r = createTouchRig(h.state());
        r.tick(2);
        const at = h.start(r);
        r.tick(2);
        expect(h.live(r), `${h.name} live before`).toBe(true);
        it2.run(r);
        r.tick(1);
        const f = r.frames.at(-1)!;
        expect(f.buttons & ~Btn.RS_FLICK, 'no bits on the next frame').toBe(0);
        expect(f.mx === 0 && f.mz === 0, 'stick released').toBe(true);
        expect(r.st.held, 'no held button').toBe(0);
        expect(r.st.previewCount, 'preview cleared').toBe(0);
        // The stale pointer moves and lifts later: nothing comes back.
        r.move(1, at.x + 30, at.y);
        r.tick(3);
        r.up(1, at.x + 30, at.y);
        r.tick(30);
        const g = r.frames.slice(-30);
        expect(g.every((x) => (x.buttons & (Btn.SPRINT | Btn.PASS | Btn.MOD_R)) === 0 && x.mx === 0), 'stale pointer ignored').toBe(true);
        expect(r.s.ctrl[0]!.powerBtn, 'sim charge ended').toBe(0);
        expect(r.st.power, 'overlay power bar empty').toBe(0);
      });
    }
  }

  it('touches leaving the screen: touchend with no finger left cancels a pointer whose pointerup never came', async () => {
    const r = createTouchRig(attackState());
    r.tick(2);
    const p = r.slot(ClusterSlot.BIG);
    r.down(1, p.x, p.y);
    r.down(2, 250, 520);
    r.drag(2, 250, 520, 320, 520, 50, 3);
    r.wait(300);
    expect(r.frames.at(-1)!.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
    r.el.dispatch('touchend', { touches: [] });
    await new Promise((res) => setTimeout(res, 5));
    r.tick(1);
    const f = r.frames.at(-1)!;
    expect(f.buttons).toBe(0);
    expect(f.mx).toBe(0);
  });

  it('after an interruption a fresh touch works at once (stick and button)', () => {
    const r = createTouchRig(attackState());
    r.tick(2);
    r.down(1, 250, 520);
    r.drag(1, 250, 520, 320, 520, 50, 3);
    r.win.dispatch('blur');
    r.tick(2);
    r.down(5, 260, 500);
    r.drag(5, 260, 500, 330, 500, 50, 3);
    const p = r.slot(ClusterSlot.BIG);
    r.down(6, p.x, p.y);
    r.wait(300);
    const f = r.frames.at(-1)!;
    expect(f.mx).toBeGreaterThan(60);
    expect(f.buttons & Btn.SPRINT).toBe(Btn.SPRINT);
  });

  it('rotation mid-hold relayouts the cluster (new viewport) and keeps nothing held', () => {
    const r = createTouchRig(attackState());
    r.tick(2);
    const before = r.slot(ClusterSlot.BIG);
    r.down(1, before.x, before.y);
    r.wait(300);
    r.win.innerWidth = 1024; r.win.innerHeight = 768;
    r.win.dispatch('orientationchange');
    r.win.dispatch('resize');
    r.tick(1);
    expect(r.frames.at(-1)!.buttons).toBe(0);
    const after = r.slot(ClusterSlot.BIG);
    expect(after.x).toBeLessThan(before.x);
    expect(after.x + 48).toBeLessThanOrEqual(1024);
    expect(after.y + 48).toBeLessThanOrEqual(768);
  });
});
