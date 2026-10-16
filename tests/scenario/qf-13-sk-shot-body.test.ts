/**
 * [QF-13 skeptic] SIM-14 interceptContacts: an outfield defender whose keeper "claims" the ball (GK_RUSH / GK_CATCH /
 * GK_DIVE / GK_PUNCH within keeperPriorityDist: the glitch-list rule against the keeper fighting a defender) was
 * skipped altogether, body included, so a fresh shot passed straight through his chest into the net while the keeper
 * dived behind him (a scan of goals whose untouched shot passed within his body: 1 of 43 goals, soak seed 801 #4,
 * a volley 0.17 m from the defender's centre at 1.18 m). The claim now calls off only a pass interception and the
 * stretched-leg roll; a body in a shot's path stops it.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EventType } from '../../src/contracts/events';
import type { SimState } from '../../src/contracts/state';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { deserializeState } from '../../src/sim/core/serialize';
import { interceptContacts } from '../../src/sim/defend/tackle';
import { createEventBuffer, type EventBufferImpl } from '../../src/sim/core/events';
import { keeperScenario, miniTick, runShot, shoot, xAt } from '../unit/gkp-02-helpers';
import { runTicks } from '../harness/scenario';

const load = (name: string): SimState => deserializeState(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** The keeper pipeline plus SIM-14's interception / block stage (the real contact order: keeper first). */
function tickWithBlocks(s: SimState, ev: EventBufferImpl): void {
  miniTick(s, ev);
  interceptContacts(s, ev);
}

describe('QF-13 skeptic: a shot cannot pass through a defender while his keeper goes for it', () => {
  it('the volley that went through a defender into the net is blocked by him (seed 801 #4)', () => {
    const s = load('qf-13-sk-shot-through-body.state.json');
    const D = 2;
    expect(s.ball.lastKickKind).toBe(KickKind.VOLLEY_SHOT);
    const goals = s.teams[0]!.goals + s.teams[1]!.goals;
    let blockedBy = -1, scored = false;
    runTicks(s, 40, undefined, {
      until: (_st, evs) => {
        for (const e of evs) {
          if (e.type === EventType.INTERCEPT && blockedBy < 0) blockedBy = e.a;
          if (e.type === EventType.GOAL) scored = true;
        }
        return false;
      },
    });
    expect(blockedBy).toBe(D); // was: no contact, the ball 0.17 m from his centre at chest height
    expect(scored).toBe(false); // was: a goal
    expect(s.teams[0]!.goals + s.teams[1]!.goals).toBe(goals);
  });

  it('a defender standing in front of his set / diving keeper blocks every shot through his body (grid)', () => {
    let shots = 0, claimed = 0, blocked = 0, through = 0;
    for (const seed of [1, 2, 3]) {
      for (const ty of [0.3, 0.9, 1.4]) {
        for (const dz of [-0.15, 0, 0.15]) {
          for (const speed of [20, 27]) {
            const s = keeperScenario({ gk: 80, u: 1.2, seed });
            // Team 0's defender 2.2 m in front of the keeper, on the shot's line, standing.
            const D = 4;
            const d = s.players[D]!;
            d.x = xAt(3.4); d.z = dz; d.vx = 0; d.vz = 0; d.fx = 1; d.fz = 0; d.act = ActionKind.NONE;
            shoot(s, { u: 16, z: 0, tz: 0, ty, speed });
            const ev = createEventBuffer();
            let hit = -1, keeperClaimed = false;
            for (let i = 0; i < 60 && hit < 0; i++) {
              tickWithBlocks(s, ev);
              const k = s.players[0]!;
              if (k.act === ActionKind.GK_CATCH || k.act === ActionKind.GK_DIVE) keeperClaimed = true;
              for (let e = 0; e < ev.count; e++) if (ev.get(e).type === EventType.INTERCEPT) hit = ev.get(e).a;
              if (s.ball.lastTouch === 0) break; // the keeper got to it first
            }
            shots++;
            if (keeperClaimed) claimed++;
            if (hit === D) blocked++; else through++;
          }
        }
      }
    }
    expect(shots).toBe(54);
    expect(claimed).toBeGreaterThan(20); // the keeper is set / diving for most of them (the claim that skipped him)
    expect(through).toBe(0);
    expect(blocked).toBe(shots);
  });

  it('a pass to the keeper rushing out is still left to him (the keeper-fights-a-defender rule stays for passes)', () => {
    // The claim keeps calling off an outfield interception of a slow ball the keeper is rushing to: runShot's keeper
    // pipeline with the block stage plays it to the keeper, not to the defender beside its path.
    const s = keeperScenario({ gk: 80, u: 6, seed: 4 });
    const D = 4;
    const d = s.players[D]!;
    d.x = xAt(6.6); d.z = 1.1; d.vx = 0; d.vz = 0; d.act = ActionKind.NONE;
    shoot(s, { u: 20, z: 0, tz: 0, speed: 9, kind: KickKind.GROUND_PASS });
    s.ball.passTarget = -1;
    const r = runShot(s, 150, tickWithBlocks);
    expect(r.events.some((e) => e.type === EventType.INTERCEPT && e.a === D)).toBe(false);
  });
});

/**
 * [QF-13 skeptic] Passes through bodies (a scan of untouched passes whose path ran within 0.25 m of an upright
 * opponent's centre: 29 in 8 Professional matches, none touched): SIM-14 counted only isFootPassKind as a pass, so a
 * header pass (a flick-on dropping at 7-14 m/s) passed through opponents' legs, and a pass above interceptMaxHeight
 * (1.0 m) through their chests and heads. Header passes now count, and a body stops a pass up to shotBlockHeight.
 */
describe('QF-13 skeptic: passes do not go through opponents', () => {
  /** A pass from 5 m in front of opponent D (slot 4, standing) straight at him, at height `yAt` when it reaches him. */
  function passThrough(kind: KickKind, yAt: number, speed: number, dz: number, seed: number): number {
    const s = keeperScenario({ gk: 80, u: 1, seed });
    const D = 4;
    const d = s.players[D]!;
    d.x = xAt(10); d.z = dz; d.vx = 0; d.vz = 0; d.fx = 1; d.fz = 0; d.act = ActionKind.NONE; d.noTouchT = 0;
    shoot(s, { u: 15, z: 0, tz: 0, speed, kind }); // the kick's bookkeeping (last kick / touch by slot 20)
    const b = s.ball;
    const t = 5 / speed;
    b.y = yAt; b.vy = 0.5 * 9.81 * t; // up and back down to yAt when it reaches him
    b.vx = -speed; b.vz = 0; b.grounded = 0; b.px = b.x; b.py = b.y; b.pz = b.z;
    b.passTarget = -1;
    const ev = createEventBuffer();
    for (let i = 0; i < 40; i++) {
      tickWithBlocks(s, ev);
      for (let e = 0; e < ev.count; e++) if (ev.get(e).type === EventType.INTERCEPT) return ev.get(e).a;
      if (s.ball.lastTouch !== 20) return s.ball.lastTouch;
    }
    return -1;
  }

  it('a header pass rolling / dropping through an opponent\'s legs is intercepted or blocked by him', () => {
    let n = 0, hit = 0;
    for (const seed of [1, 2, 3]) for (const dz of [-0.1, 0, 0.1]) for (const speed of [8, 11, 14]) {
      n++;
      if (passThrough(KickKind.HEADER_PASS, 0.3, speed, dz, seed) === 4) hit++;
    }
    expect(hit).toBe(n); // was 0: no interception roll, no body contact
  });

  it('a pass at chest / head height through an opponent hits him', () => {
    let n = 0, hit = 0;
    for (const seed of [1, 2]) for (const dz of [-0.1, 0, 0.1]) for (const y of [1.2, 1.5, 1.7]) {
      n++;
      if (passThrough(KickKind.LOB_PASS, y, 15, dz, seed) === 4) hit++;
    }
    expect(hit).toBe(n); // was 0 above interceptMaxHeight
  });
});
