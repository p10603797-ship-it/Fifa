/**
 * QF-3 QA-23 (second pass): how a touch strafe (double tap and hold the stick = MOD_L + stick) ENDS. The first pass kept
 * the strafe's MOD_L for at least T_INPUT.tapTicks (a shorter one is an L1 tap = trigger a run). But when the stick
 * lifted inside that minimum, L1 stayed down with the stick released, which the sim reads as "stop and face goal"
 * (section 10: release left stick + L1): a 14-tick STOP_FACE_GOAL skill fired, and a PASS tapped right after the lift
 * was swallowed (pressed during the skill, outside the 6-tick buffer) or came 15 ticks late. Now the strafe's last
 * stick stays with its MOD_L to that minimum and both end together, like a long strafe's lift: a plain stop.
 * Through the real touch source, mapper and sim (qf-3-touch-rig).
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind, MatchPhase, SkillMove } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import { ClusterSlot } from '../../src/contracts/touch';
import { T_INPUT } from '../../src/contracts/tuning';
import { makeScenario } from '../harness/scenario';
import { createTouchRig, type TouchRig } from './qf-3-touch-rig';

const P = 9;
const TICK = 1000 / 60;

/** P1 controls #9 dribbling at 3 m/s with the ball at (10, 0); CPU brains off. */
function attack(): TouchRig {
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    humans: [{ side: 0, slot: P }],
    players: [{ slot: P, x: 10, z: 0, fx: 1, fz: 0, vx: 3 }],
    ball: { owner: P, x: 10.4, y: 0.11, z: 0, lastTouchTeam: 0, lastTouch: P },
  });
  for (const t of [0, 1]) s.teams[t]!.cpu.active = 0;
  return createTouchRig(s);
}

/** Double tap and hold the stick, push it up-right, keep it there for holdMs. */
function strafe(r: TouchRig, holdMs: number): void {
  r.down(1, 300, 500); r.wait(40); r.up(1, 300, 500); r.wait(60);
  r.down(1, 300, 500);
  r.drag(1, 300, 500, 400, 440, 60, 3);
  r.wait(holdMs);
}

function skills(r: TouchRig): number[] {
  return r.events.filter((e) => e.type === EventType.SKILL).map((e) => e.b);
}

describe('QF-3 QA-23 the end of a touch strafe', () => {
  it('a PASS tapped right after a short strafe lifts goes at once: no stop-and-face-goal swallowing it', () => {
    // Strafe holds whose MOD_L is still inside its tap minimum at the lift (180..240 ms after the push) and longer ones.
    for (const hold of [180, 200, 220, 240, 300, 600]) {
      for (const gap of [0, 30, 60, 100]) {
        const r = attack();
        r.tick(2);
        strafe(r, hold);
        r.up(1, 400, 440);
        const lift = r.s.tick;
        r.wait(gap);
        const pass = r.slot(ClusterSlot.LOW);
        r.down(2, pass.x, pass.y); r.wait(60); r.up(2, pass.x, pass.y);
        let kickAt = -1;
        let kind = KickKind.NONE;
        for (let i = 0; i < 40 && kickAt < 0; i++) {
          r.tick();
          const q = r.s.players[P]!;
          if (q.act === ActionKind.KICK && q.actKick !== KickKind.NONE) { kickAt = r.s.tick; kind = q.actKick; }
        }
        const label = `hold ${hold} gap ${gap}`;
        expect(skills(r), label).not.toContain(SkillMove.STOP_FACE_GOAL);
        expect(kind, label).toBe(KickKind.GROUND_PASS);
        // Tap commit (the lift) + the sim's start: never the 15 ticks a stop skill cost.
        expect(kickAt - lift, label).toBeLessThanOrEqual(Math.ceil((gap + 60) / TICK) + 6);
      }
    }
  });

  it('every short strafe ends with no trigger run and no stop-and-face-goal; its stick and MOD_L end on the same frame', () => {
    for (let extra = 0; extra < T_INPUT.tapTicks + 4; extra++) {
      const r = attack();
      r.tick(2);
      r.s.teams[0]!.runCallT = 0;
      const from = r.frames.length;
      strafe(r, (T_INPUT.tapTicks + 1 + extra) * TICK - 60);
      r.up(1, 400, 440);
      let run = false;
      for (let i = 0; i < 30; i++) { r.tick(); if (r.s.teams[0]!.runCallT > 0) run = true; }
      const label = `MOD_L ${extra + 1} ticks at the lift`;
      expect(run, label).toBe(false);
      expect(skills(r), label).toEqual([]);
      // MOD_L never ends while the stick is released (L1 + released stick = stop and face goal), and lasts a tap.
      let modL = 0;
      for (let i = from; i < r.frames.length; i++) {
        const f = r.frames[i]!;
        const l = (f.buttons & Btn.MOD_L) !== 0;
        if (l) {
          modL++;
          expect(f.mx !== 0 || f.mz !== 0, `${label}: frame ${i - from} has L1 with the stick released`).toBe(true);
        } else if (modL > 0) {
          expect(modL, label).toBeGreaterThanOrEqual(T_INPUT.tapTicks);
          expect(f.mx === 0 && f.mz === 0, `${label}: the stick outlived MOD_L`).toBe(true);
          modL = 0;
        }
      }
    }
  });

  for (const [name, cut] of [
    ['pointercancel', (r: TouchRig) => r.cancel(1)],
    ['window blur', (r: TouchRig) => { r.win.dispatch('blur'); }],
    ['orientationchange', (r: TouchRig) => { r.win.dispatch('orientationchange'); }],
  ] as const) {
    it(`glitch: stuck sprint or stick after pointercancel - a short strafe cut by ${name}: no action, all released within a tap time`, () => {
      const r = attack();
      r.tick(2);
      r.s.teams[0]!.runCallT = 0;
      strafe(r, (T_INPUT.tapTicks + 4) * TICK - 60);
      const at = r.frames.length;
      expect(r.frames.at(-1)!.buttons & Btn.MOD_L).toBe(Btn.MOD_L);
      cut(r);
      let run = false;
      for (let i = 0; i < 30; i++) { r.tick(); if (r.s.teams[0]!.runCallT > 0) run = true; }
      expect(run).toBe(false);
      expect(skills(r)).toEqual([]);
      const tail = r.frames.slice(at).findIndex((f) => f.buttons === 0 && f.mx === 0 && f.mz === 0);
      expect(tail).toBeGreaterThanOrEqual(0);
      expect(tail).toBeLessThan(T_INPUT.tapTicks);
      expect(r.frames.slice(at + tail).every((f) => f.buttons === 0 && f.mx === 0 && f.mz === 0)).toBe(true);
      expect(r.st.stickActive).toBe(false);
    });
  }

  it('the session releaseAll mid-strafe still clears the stick and MOD_L on the very next frame', () => {
    const r = attack();
    r.tick(2);
    strafe(r, (T_INPUT.tapTicks + 4) * TICK - 60);
    r.releaseAll();
    const f = r.tick();
    expect(f.buttons).toBe(0);
    expect(f.mx === 0 && f.mz === 0).toBe(true);
  });
});
