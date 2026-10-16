/**
 * [QF-13] SIM-12 AI aerial starts on a shot: an AI-driven defender 0.4-1.4 m from the shooter started a volley / header
 * clearance on a 17-27 m/s shot on the next scan tick and played it away as an aimed 24 m/s clearance 2-6 ticks after
 * the strike (about 1 a match at Professional: no reaction time at all). Now nobody starts a header / volley on a fresh
 * shot sooner than T_AERIAL.aiShotReactTicks after the strike; inside that time only a body in the shot's path (TAC-02
 * block) stops it.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, KickKind } from '../../src/contracts/enums';
import { type SimState } from '../../src/contracts/state';
import { T_AERIAL } from '../../src/contracts/tuning';
import { NULL_SINK } from '../../src/sim/core/events';
import { aerialContacts } from '../../src/sim/kicks/aerial';
import { place, quietScene } from './sim-12-helpers';

const ATT = 9; // team 0 shooter, attacking +x
const DEF = 15; // team 1 defender in the shot's way, beside its line

/** A shot by ATT struck `age` ticks ago from (38, 0), passing DEF (6.5 m on) at volley height about 0.33 s later. */
function shotScene(seed: number, age: number, defZ: number): SimState {
  const s = quietScene({ seed });
  place(s, ATT, 37.6, 0);
  place(s, DEF, 44.5, defZ, undefined, -1);
  s.tick = 3000 + 2; // team 1 scans on (tick + 1) % 3 === 0
  const b = s.ball;
  // Where a 20 m/s shot struck at (38.0, 0.3) with vy 2.2 is `age` ticks later (constant velocity is close enough).
  const t = age / 60;
  b.x = 38.0 + 20 * t; b.z = 0; b.y = 0.3 + 2.2 * t - 4.9 * t * t;
  b.vx = 20; b.vz = 0; b.vy = 2.2 - 9.81 * t;
  b.px = b.x - 20 / 60; b.pz = 0; b.py = b.y - b.vy / 60;
  b.sx = 0; b.sy = 0; b.sz = 0; b.grounded = 0; b.bounces = 0; b.owner = -1; b.heldBy = -1; b.inNet = 0;
  b.shotBy = ATT; b.lastKickBy = ATT; b.lastKickTeam = 0; b.lastKickKind = KickKind.SHOT_NORMAL;
  b.lastTouch = ATT; b.lastTouchTeam = 0; b.passTarget = -1;
  b.lastKickTick = s.tick - age; b.lastTouchTick = s.tick - age; b.touchedTick = s.tick - age;
  s.players[ATT]!.lastTouchTick = s.tick - age;
  return s;
}

/** Runs the contact phase on DEF's team scan tick; true when DEF started a header / volley on the shot. */
function starts(s: SimState): boolean {
  aerialContacts(s, NULL_SINK);
  const a = s.players[DEF]!.act;
  return a === ActionKind.VOLLEY || a === ActionKind.HEADER;
}

describe('QF-13 SIM-12: no superhuman reaction to a shot', () => {
  it('glitch: shot volleyed clear two ticks after it was struck — no AI defender starts a header / volley on a shot inside the reaction time', () => {
    expect(T_AERIAL.aiShotReactTicks).toBeGreaterThanOrEqual(8);
    let early = 0, late = 0;
    for (let seed = 1; seed <= 6; seed++) {
      for (const z of [0.45, 0.55, -0.5]) {
        for (let age = 1; age < T_AERIAL.aiShotReactTicks; age += 3) if (starts(shotScene(seed, age, z))) early++;
        // Control: the same shot once the reaction time has passed (the ball a little further on) is played.
        if (starts(shotScene(seed, T_AERIAL.aiShotReactTicks, z))) late++;
      }
    }
    expect(early).toBe(0);
    expect(late).toBeGreaterThan(0);
  });

  it('a ball that is not a fresh shot (a cross, or a shot someone touched since) is still met at once', () => {
    let n = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = shotScene(seed, 2, 0.5);
      s.ball.lastKickKind = KickKind.CROSS; s.ball.shotBy = -1;
      if (starts(s)) n++;
    }
    expect(n).toBeGreaterThan(0);
  });
});
