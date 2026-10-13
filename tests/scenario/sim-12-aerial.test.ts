/**
 * SIM-12 scenario tests on the real step() pipeline: human headers and volleys from crosses (speeds, reaching the
 * goal), AI attackers attacking crosses aimed at them, AI defenders heading clear, aerial duels (winner from heading /
 * height / strength, deterministic per seed), beaten jumpers stumbling, no double contact, power bar held through
 * the contact, invariants, and the glitch-list regressions this module touches.
 */
import { describe, expect, it } from 'vitest';
import { ActionKind, ControllerKind, KickKind } from '../../src/contracts/enums';
import { EventType, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { PlayerAttrs, SimState } from '../../src/contracts/state';
import { cloneState } from '../../src/sim/core/clone';
import { hashState } from '../../src/sim/core/hash';
import { runTicks } from '../harness/scenario';
import { arrivalAtGoal, launchCross, place, pressOnChance, quietScene, runAerial } from './sim-12-helpers';

const ATT = 9;
const ATT2 = 10;
const DEF = 13;
const DEF2 = 14;

function kickOf(events: readonly SimEvent[], slot: number): SimEvent | undefined {
  return events.find((e) => e.type === EventType.KICK && e.a === slot);
}

/** One of 30 cross variations for a human header at the +x goal. */
function humanHeaderCase(seed: number): { s: SimState; hold: number } {
  const s = quietScene({ human: ATT, seed, keeperAway: true });
  const ax = 39.5 + (seed % 4) * 1.2;
  const az = -3 + (seed % 7);
  place(s, ATT, ax, az);
  launchCross(s, 7, 34 + (seed % 6), seed % 2 ? -28 : 28, ax + 1, az, 0.45 + (seed % 3) * 0.05, seed % 3 === 0 ? -1 : ATT);
  return { s, hold: 8 + (seed % 5) * 8 };
}

describe('SIM-12 human headers and volleys from crosses', () => {
  it('headers from crosses reach the goal at believable speeds (10-20 m/s) and mostly hit the target', () => {
    let n = 0, inMouth = 0, reached = 0;
    let lo = 1e9, hi = 0, alo = 1e9, ahi = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { s, hold } = humanHeaderCase(seed);
      const r = runAerial(s, 180, pressOnChance(ATT, Btn.SHOOT, hold));
      expect(r.aerials.length, `seed ${seed}`).toBe(1);
      expect(r.aerials[0]!.a).toBe(ATT);
      expect(r.aerials[0]!.b).toBe(1);
      expect(kickOf(r.events, ATT)!.b).toBe(KickKind.HEADER_SHOT);
      n++;
      lo = Math.min(lo, r.launchSpeed); hi = Math.max(hi, r.launchSpeed);
      const arr = arrivalAtGoal(r.after!, 1);
      if (arr.reached) {
        reached++;
        alo = Math.min(alo, arr.speed); ahi = Math.max(ahi, arr.speed);
        if (arr.inMouth) inMouth++;
      }
    }
    console.log(`SIM-12 headers: ${n} contacts, launch ${lo.toFixed(1)}-${hi.toFixed(1)} m/s, at the line ${alo.toFixed(1)}-${ahi.toFixed(1)} m/s, ${reached} reached the line, ${inMouth} inside the mouth`);
    expect(lo).toBeGreaterThanOrEqual(10);
    expect(hi).toBeLessThanOrEqual(20);
    expect(reached).toBe(n);
    expect(alo).toBeGreaterThanOrEqual(10);
    expect(ahi).toBeLessThanOrEqual(20);
    expect(inMouth / n).toBeGreaterThanOrEqual(0.5);
  });

  it('volleys of low crosses launch at 20-30 m/s and reach the goal', () => {
    let lo = 1e9, hi = 0, inMouth = 0;
    const N = 12;
    for (let seed = 1; seed <= N; seed++) {
      const s = quietScene({ human: ATT, seed, keeperAway: true });
      const az = -2 + (seed % 5);
      place(s, ATT, 38, az);
      launchCross(s, 7, 27 + (seed % 3), -20 + seed, 39.5, az, 0.22 + (seed % 4) * 0.02, ATT);
      const r = runAerial(s, 150, pressOnChance(ATT, Btn.SHOOT, 10 + (seed % 3) * 12));
      expect(r.aerials.length, `seed ${seed}`).toBe(1);
      expect(r.aerials[0]!.b).toBe(0);
      expect(kickOf(r.events, ATT)!.b).toBe(KickKind.VOLLEY_SHOT);
      lo = Math.min(lo, r.launchSpeed); hi = Math.max(hi, r.launchSpeed);
      const arr = arrivalAtGoal(r.after!, 1);
      expect(arr.reached, `seed ${seed}`).toBe(true);
      if (arr.inMouth) inMouth++;
    }
    console.log(`SIM-12 volleys: launch ${lo.toFixed(1)}-${hi.toFixed(1)} m/s, ${inMouth}/${N} inside the mouth`);
    expect(lo).toBeGreaterThanOrEqual(20);
    expect(hi).toBeLessThanOrEqual(30);
    expect(inMouth).toBeGreaterThanOrEqual(N / 2);
  });

  it('holding the button through the contact (power bar) still heads, and the action ends inside its budget', () => {
    const { s } = humanHeaderCase(4);
    const r = runAerial(s, 240, pressOnChance(ATT, Btn.SHOOT, 1000));
    expect(r.aerials.length).toBe(1);
    expect(s.players[ATT]!.act).not.toBe(ActionKind.HEADER);
    // And the whole run with every invariant checked (action budgets, overlaps, chasers, ...).
    const { s: s2 } = humanHeaderCase(4);
    expect(() => runTicks(s2, 240, pressOnChance(ATT, Btn.SHOOT, 1000), { check: 'all' })).not.toThrow();
  });

  it('a late press (the ball 0.2 s away) still plays the ball in the air', () => {
    // (No pass target here: SIM-15 walks an idle intended receiver along the ball's ground track; see the report.)
    const mk = (seed: number): SimState => {
      const s = quietScene({ human: ATT, seed, keeperAway: true });
      const ax = 39.5 + (seed % 4) * 1.2;
      const az = -3 + (seed % 7);
      place(s, ATT, ax, az);
      launchCross(s, 7, 34 + (seed % 6), seed % 2 ? -28 : 28, ax + 1, az, 0.45 + (seed % 3) * 0.05, -1);
      return s;
    };
    for (let seed = 1; seed <= 8; seed++) {
      // When would an early press have met the ball? Press 12 ticks before that instead (a tap).
      let pressAt = -1;
      runTicks(mk(seed), 180, pressOnChance(ATT, Btn.SHOOT, 20), {
        until: (st) => {
          const p = st.players[ATT]!;
          if (p.act === ActionKind.HEADER && p.actContact - p.actT === 12) { pressAt = st.tick; return true; }
          return false;
        },
      });
      expect(pressAt, `seed ${seed}`).toBeGreaterThan(0);
      const r = runAerial(mk(seed), 180, (tick, _st, out) => { if (tick === pressAt + 1) out[0]!.buttons = Btn.SHOOT; });
      expect(r.aerials.length, `seed ${seed}`).toBe(1);
      expect(r.aerials[0]!.a).toBe(ATT);
    }
  });

  it('a header pass (PASS + stick toward a teammate) finds him', () => {
    const s = quietScene({ human: ATT, seed: 21 });
    runTicks(s, 1); // TAI shape: home positions
    const mate = s.players[ATT2]!;
    place(s, ATT2, mate.homeX, mate.homeZ);
    // The human stands 12 m from his teammate, toward the own goal; the ball drops on him.
    const hx = mate.homeX - 12;
    const hz = mate.homeZ;
    place(s, ATT, hx, hz);
    launchCross(s, 7, hx - 14, hz - 10, hx + 0.8, hz, 0.75, -1);
    const r = runAerial(s, 200, pressOnChance(ATT, Btn.PASS, 20, { mx: 127, mz: 0 }));
    expect(r.aerials.length).toBe(1);
    expect(kickOf(r.events, ATT)!.b).toBe(KickKind.HEADER_PASS);
    expect(r.after!.passTarget).toBe(ATT2);
  });
});

describe('SIM-12 AI aerials', () => {
  it('an AI attacker attacks a cross aimed at him and heads at goal', () => {
    let shots = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const s = quietScene({ seed });
      place(s, ATT, 40 + (seed % 3), -2 + (seed % 5));
      const p = s.players[ATT]!;
      launchCross(s, 7, 36, seed % 2 ? -28 : 28, p.x + 1, p.z, 0.5, ATT);
      const r = runAerial(s, 180);
      // (A rebound off the keeper may give him a second header later: a new flight.)
      expect(r.aerials.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      expect(r.aerials[0]!.a).toBe(ATT);
      if (kickOf(r.events, ATT)!.b === KickKind.HEADER_SHOT) shots++;
      expect(arrivalAtGoal(r.after!, 1).reached).toBe(true);
    }
    expect(shots).toBe(10);
  });

  it('a CPU-brain controlled attacker attacks the cross too', () => {
    const s = quietScene({ seed: 3 });
    const ctl = s.ctrl[2]!;
    ctl.kind = ControllerKind.CPU; ctl.side = 0; ctl.slot = ATT; s.players[ATT]!.ctrl = 2;
    place(s, ATT, 41, 0);
    launchCross(s, 7, 36, -28, 42, 0, 0.5, ATT);
    const r = runAerial(s, 180);
    expect(r.aerials.length).toBe(1);
    expect(r.aerials[0]!.a).toBe(ATT);
  });

  it('an AI attacker volleys a waist-high ball in the box at goal', () => {
    const s = quietScene({ seed: 5 });
    place(s, ATT, 40, 1);
    launchCross(s, 7, 30, -18, 41.5, 1, 0.24, ATT);
    const r = runAerial(s, 150);
    expect(r.aerials.length).toBe(1);
    expect(r.aerials[0]!.b).toBe(0);
    expect(kickOf(r.events, ATT)!.b).toBe(KickKind.VOLLEY_SHOT);
    expect(r.launchSpeed).toBeGreaterThanOrEqual(20);
    expect(r.launchSpeed).toBeLessThanOrEqual(30);
  });

  it('AI defenders head crosses clear: high and away from their goal', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = quietScene({ seed });
      place(s, DEF, 41 + (seed % 3), -1 + (seed % 3));
      const d = s.players[DEF]!;
      launchCross(s, 7, 36, seed % 2 ? -28 : 28, d.x + 1, d.z, 0.5, -1);
      const r = runAerial(s, 180);
      expect(r.aerials.length, `seed ${seed}`).toBe(1);
      expect(r.aerials[0]!.a).toBe(DEF);
      expect(kickOf(r.events, DEF)!.b).toBe(KickKind.HEADER_PASS);
      const a = r.after!;
      expect(a.vx).toBeLessThan(0); // away team defends +x
      expect(a.vy).toBeGreaterThan(3);
      expect(r.launchSpeed).toBeGreaterThanOrEqual(12);
      expect(r.launchSpeed).toBeLessThanOrEqual(20);
    }
  });

  it('a contested high ball in midfield is headed on by the AI toward the attack', () => {
    let forward = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const s = quietScene({ seed });
      place(s, ATT, 2, 0);
      place(s, DEF, 2.6, 0.8);
      // A long ball from the away half dropping on them (as from a goal kick): away team played it.
      launchCross(s, 15, 35, 4, 2.5, 0, 0.75, -1);
      const r = runAerial(s, 240);
      expect(r.aerials.length, `seed ${seed}`).toBeGreaterThanOrEqual(1);
      const w = r.aerials[0]!.a;
      expect([ATT, DEF]).toContain(w);
      const dir = s.teams[s.players[w]!.team]!.dir;
      if (r.after!.vx * dir > 0) forward++;
    }
    expect(forward).toBe(6);
  });

  it('glitch "Players: two teammates chase": two AI teammates under a cross never both jump for it', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const s = quietScene({ seed });
      place(s, ATT, 41, -0.6);
      place(s, ATT2, 41.3, 0.6);
      launchCross(s, 7, 36, seed % 2 ? -28 : 28, 42, 0, 0.5, -1);
      let both = 0;
      runTicks(s, 180, undefined, {
        until: (st) => {
          let n = 0;
          for (const k of [ATT, ATT2]) if (st.players[k]!.act === ActionKind.HEADER && st.players[k]!.actDone === 0) n++;
          if (n > 1) both++;
          return false;
        },
      });
      expect(both, `seed ${seed}`).toBe(0);
    }
  });
});

interface DuelOpts { att: Partial<PlayerAttrs>; def: Partial<PlayerAttrs> }

/** Attacker and defender shoulder to shoulder under a high ball dropping between them. */
function duel(seed: number, o: DuelOpts): { s: SimState; events: SimEvent[]; winner: number } {
  const s = quietScene({ seed });
  place(s, ATT, 42, -0.45, o.att);
  place(s, DEF, 42, 0.45, o.def);
  launchCross(s, 7, 30, 0, 42.6, 0, 0.9, ATT);
  const r = runAerial(s, 200);
  return { s, events: r.events, winner: r.aerials.length > 0 ? r.aerials[0]!.a : -1 };
}

const BASE: Partial<PlayerAttrs> = { heading: 60, strength: 60, height: 182, agility: 60 };
const STRONG: Partial<PlayerAttrs> = { heading: 90, strength: 88, height: 192, agility: 70 };
const WEAK: Partial<PlayerAttrs> = { heading: 40, strength: 40, height: 174, agility: 55 };

function winRate(o: DuelOpts, n = 40): { att: number; def: number } {
  let att = 0, def = 0;
  for (let seed = 1; seed <= n; seed++) {
    const w = duel(seed, o).winner;
    if (w === ATT) att++;
    else if (w === DEF) def++;
  }
  return { att: att / n, def: def / n };
}

describe('SIM-12 aerial duels', () => {
  it('the winner depends on heading, height and strength, deterministically over seeds', () => {
    const strong = winRate({ att: STRONG, def: WEAK });
    const swapped = winRate({ att: WEAK, def: STRONG });
    const equal = winRate({ att: BASE, def: BASE });
    const heading = winRate({ att: { ...BASE, heading: 92 }, def: { ...BASE, heading: 35 } });
    const height = winRate({ att: { ...BASE, height: 196 }, def: { ...BASE, height: 170 } });
    const strength = winRate({ att: { ...BASE, strength: 95 }, def: { ...BASE, strength: 30 } });
    console.log(`SIM-12 duels (attacker win rate): strong ${strong.att}, swapped ${swapped.att} (def ${swapped.def}), equal ${equal.att} (def ${equal.def}), heading ${heading.att}, height ${height.att}, strength ${strength.att}`);
    expect(strong.att).toBeGreaterThanOrEqual(0.85);
    expect(swapped.def).toBeGreaterThanOrEqual(0.85);
    expect(equal.att).toBeGreaterThanOrEqual(0.25);
    expect(equal.def).toBeGreaterThanOrEqual(0.25);
    expect(heading.att).toBeGreaterThanOrEqual(0.65);
    expect(height.att).toBeGreaterThanOrEqual(0.65);
    expect(strength.att).toBeGreaterThanOrEqual(0.6);
    // Every duel had a winner (somebody always plays the ball).
    expect(strong.att + strong.def).toBe(1);
    expect(equal.att + equal.def).toBe(1);
  });

  it('the same seed gives the same duel, bit for bit', () => {
    for (const seed of [3, 17, 29]) {
      const a = duel(seed, { att: BASE, def: BASE });
      const b = duel(seed, { att: BASE, def: BASE });
      expect(b.winner).toBe(a.winner);
      expect(hashState(b.s)).toBe(hashState(a.s));
    }
  });

  it('a clone taken mid-flight continues identically, even stepped interleaved with the original (no module memory)', () => {
    const s = quietScene({ seed: 8 });
    place(s, ATT, 42, -0.45, BASE);
    place(s, DEF, 42, 0.45, BASE);
    launchCross(s, 7, 30, 0, 42.6, 0, 0.9, ATT);
    runTicks(s, 50);
    const c = cloneState(s);
    const ref = cloneState(s);
    // Interleave the original and the clone tick by tick (the prediction memo sees alternating ball states), and run
    // a third copy alone: all three must agree bit for bit.
    for (let i = 0; i < 150; i++) { runTicks(s, 1); runTicks(c, 1); }
    runTicks(ref, 150);
    expect(hashState(c)).toBe(hashState(s));
    expect(hashState(ref)).toBe(hashState(s));
  });

  it('a jumper beaten in the air by a stronger opponent stumbles; the winner never does', () => {
    let stumbled = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const s = quietScene({ seed });
      place(s, ATT, 42, -0.45, STRONG);
      place(s, DEF, 42, 0.45, { ...WEAK, strength: 30 });
      launchCross(s, 7, 30, 0, 42.6, 0, 0.9, ATT);
      let defStumble = false, attStumble = false;
      runTicks(s, 200, undefined, {
        until: (st) => {
          if (st.players[DEF]!.act === ActionKind.STUMBLE) defStumble = true;
          if (st.players[ATT]!.act === ActionKind.STUMBLE) attStumble = true;
          return false;
        },
      });
      if (defStumble) stumbled++;
      expect(attStumble).toBe(false);
    }
    expect(stumbled).toBeGreaterThanOrEqual(12);
  });

  it('no double contact: one aerial contact per flight, nobody plays the headed ball again in the air', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { events } = duel(seed, { att: BASE, def: BASE });
      const aerials = events.filter((e) => e.type === EventType.AERIAL);
      expect(aerials.length, `seed ${seed}`).toBe(1);
      // The touch sequence: the crosser, then exactly one header; no second touch within 0.5 s.
      const t0 = aerials[0]!.tick;
      const kicks = events.filter((e) => e.type === EventType.KICK && e.tick > t0 && e.tick < t0 + 30);
      expect(kicks.length).toBe(0);
    }
  });

  it('glitch "Ball stuck: between two players": a contested header always plays the ball on', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const s = quietScene({ seed });
      place(s, ATT, 42, -0.45, BASE);
      place(s, DEF, 42, 0.45, BASE);
      launchCross(s, 7, 30, 0, 42.6, 0, 0.9, ATT);
      const r = runAerial(s, 200, undefined);
      expect(r.after, `seed ${seed}`).not.toBeNull();
      // Half a second after the header the ball has left the two jumpers well behind.
      const s2 = quietScene({ seed });
      place(s2, ATT, 42, -0.45, BASE);
      place(s2, DEF, 42, 0.45, BASE);
      launchCross(s2, 7, 30, 0, 42.6, 0, 0.9, ATT);
      runTicks(s2, r.contactTick + 30);
      const b = s2.ball;
      for (const k of [ATT, DEF]) {
        const p = s2.players[k]!;
        expect(Math.hypot(b.x - p.x, b.z - p.z), `seed ${seed}`).toBeGreaterThan(3);
      }
    }
  });

  it('every duel scenario passes all invariants', () => {
    for (const seed of [2, 9]) {
      const s = quietScene({ seed });
      place(s, ATT, 42, -0.45, STRONG);
      place(s, DEF, 42, 0.45, WEAK);
      place(s, DEF2, 42.5, -1.5, BASE);
      launchCross(s, 7, 30, 0, 42.6, 0, 0.9, ATT);
      expect(() => runTicks(s, 300, undefined, { check: 'all' })).not.toThrow();
    }
  });
});
