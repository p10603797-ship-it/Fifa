/**
 * GKP-01: keeper positioning through the real tick pipeline (step -> teamAiTick -> keeperTick -> keeperPositioning ->
 * locomotion). The ball is pinned or scripted each tick so only the keeper logic under test moves things.
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { MatchPhase } from '../../src/contracts/enums';
import type { SimState } from '../../src/contracts/state';
import { T_PLAYER } from '../../src/contracts/tuning';
import { idealKeeperSpot } from '../../src/sim/keeper/positioning';
import { makeScenario, runTicks } from '../harness/scenario';
import { takePossession } from '../../src/sim/core/kick';
import { NULL_SINK } from '../../src/sim/core/events';

const MIN_LINE = 0.3;
/** How close arrival steering stops (plus slack for the locomotion model). */
const SETTLE = T_PLAYER.arriveStop + 0.1;

const uOf = (dir: number, x: number): number => dir * x + HALF_LENGTH;
const xOf = (dir: number, u: number): number => dir * (u - HALF_LENGTH);

interface Setup { team: number; swapped: boolean }
const SETUPS: Setup[] = [
  { team: 0, swapped: false }, { team: 1, swapped: false }, { team: 0, swapped: true }, { team: 1, swapped: true },
];
const label = (c: Setup): string => `team ${c.team}${c.swapped ? ' (sides swapped)' : ''}`;

/**
 * [QF-2] Parked scene: IN_PLAY with the ball at (bu, bz) relative to `team`'s goal, owned by an opponent carrier who
 * stands on it, and the keeper at (ku, kz). Every other player is parked (re-placed at rest before every tick): the
 * carrier on the ball, one of the keeper's defenders 1.5 m goal-side of him (he engages the carrier, so GKP-03 sees no
 * one-on-one) and the rest in the far half. The CPU brains are off, so nobody plays the ball. The old scene pinned a
 * LOOSE ball inside GKP-03's come-out zone of a full bot match: the keeper rightly raced out for it and the bots chased
 * it, so the GKP-01 positioning these tests are about never got to settle.
 */
interface Scene { s: SimState; dir: number; k: number; carrier: number; marker: number; park: Float64Array }

function scenario(c: Setup, bu: number, bz: number, ku: number, kz: number): Scene {
  const dirs = c.swapped ? [-1, 1] : [1, -1];
  const dir = dirs[c.team]!;
  const k = c.team === 0 ? 0 : 11;
  const opp = 1 - c.team;
  const carrier = opp * 11 + 9;
  const marker = c.team * 11 + 2;
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    teams: [{ dir: dirs[0] }, { dir: dirs[1] }],
    ball: { x: xOf(dir, bu), y: 0.11, z: bz, vx: 0, vy: 0, vz: 0 },
    players: [{ slot: k, x: xOf(dir, ku), z: kz, vx: 0, vz: 0 }],
  });
  s.teams[0]!.cpu.active = 0;
  s.teams[1]!.cpu.active = 0;
  const park = new Float64Array(44);
  for (let i = 0; i < 22; i++) {
    // The far half (from this keeper's goal), spread out; the other keeper on his line.
    const isOtherKeeper = i === (c.team === 0 ? 11 : 0);
    park[2 * i] = isOtherKeeper ? xOf(dir, 2 * HALF_LENGTH - 1) : xOf(dir, HALF_LENGTH + 15 + (i % 4) * 8);
    park[2 * i + 1] = isOtherKeeper ? 0 : -27 + (i % 11) * 5.4;
  }
  const sc: Scene = { s, dir, k, carrier, marker, park };
  pin(sc, xOf(dir, bu), bz, 0, 0);
  return sc;
}

/**
 * Before every tick: the carrier on the ball (pitch point, velocity), the marker 1.5 m goal-side of him, everyone else
 * but the keeper under test parked. [INT-A] The ball is nobody's pass (passTarget cleared).
 */
function pin(sc: Scene, x: number, z: number, vx: number, vz: number): void {
  const s = sc.s;
  const b = s.ball;
  b.x = x; b.z = z; b.y = 0.11; b.vx = vx; b.vz = vz; b.vy = 0; b.px = x; b.pz = z; b.py = 0.11; b.grounded = 1;
  b.passTarget = -1;
  for (let i = 0; i < 22; i++) {
    if (i === sc.k) continue;
    const p = s.players[i]!;
    if (i === sc.carrier) { p.x = x; p.z = z; p.vx = vx; p.vz = vz; }
    else if (i === sc.marker) {
      const gx = sc.dir * -HALF_LENGTH - x, gz = -z;
      const gl = Math.hypot(gx, gz) || 1;
      p.x = x + (gx / gl) * 1.5; p.z = z + (gz / gl) * 1.5; p.vx = vx; p.vz = vz;
    } else { p.x = sc.park[2 * i]!; p.z = sc.park[2 * i + 1]!; p.vx = 0; p.vz = 0; }
  }
  if (b.owner !== sc.carrier) takePossession(s, sc.carrier, NULL_SINK);
}

function facingDot(s: SimState, k: number): number {
  const p = s.players[k]!;
  const dx = s.ball.x - p.x, dz = s.ball.z - p.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  return d < 1e-6 ? 1 : (p.fx * dx + p.fz * dz) / d;
}

describe('GKP-01 keeper movement (real pipeline)', () => {
  for (const c of SETUPS) {
    it(`walks to the ideal spot and settles without jitter: ${label(c)}`, () => {
      for (const [bu, bz] of [[HALF_LENGTH, 0], [18, 10], [2, -20], [11, -4]] as const) {
        const sc = scenario(c, bu, bz, 0.5, 0);
        const { s, dir, k } = sc;
        const bx = xOf(dir, bu);
        runTicks(s, 300, (_t, st) => pin(sc, bx, bz, 0, 0), { check: 'core' });
        const p = s.players[k]!;
        const o = { x: 0, z: 0 };
        idealKeeperSpot(s, c.team, o);
        expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeLessThanOrEqual(SETTLE);
        // At rest: no micro-movement, still facing the ball.
        let path = 0;
        let px = p.x, pz = p.z;
        runTicks(s, 300, (_t, st) => pin(sc, bx, bz, 0, 0), {
          check: 'core',
          until: (st) => {
            const q = st.players[k]!;
            path += Math.hypot(q.x - px, q.z - pz);
            px = q.x; pz = q.z;
            expect(facingDot(st, k)).toBeGreaterThan(0.99);
            return false;
          },
        });
        expect(path).toBeLessThan(0.02);
        expect(Math.hypot(p.vx, p.vz)).toBeLessThan(0.01);
        expect(uOf(dir, p.x)).toBeGreaterThan(0);
      }
    });

    it(`steps across with the ball, facing it (shuffles, never turns his back): ${label(c)}`, () => {
      const bu = 18, speed = 5;
      const sc = scenario(c, bu, -15, 1, -1);
        const { s, dir, k } = sc;
      const bx = xOf(dir, bu);
      runTicks(s, 240, (_t, st) => pin(sc, bx, -15, 0, 0));
      const p = s.players[k]!;
      const startZ = p.z;
      let flips = 0, lastSign = 0, minDot = 1, maxLag = 0, zWhenCentral = Number.NaN;
      const o = { x: 0, z: 0 };
      const ticks = 360;
      let i = 0;
      runTicks(s, ticks + 60, (_t, st) => {
        const z = Math.min(15, -15 + speed * i / 60);
        pin(sc, bx, z, 0, z < 15 ? speed : 0);
        i++;
      }, {
        check: 'core',
        until: (st) => {
          const q = st.players[k]!;
          if (Math.abs(q.vz) > 0.05) {
            const sg = Math.sign(q.vz);
            if (lastSign !== 0 && sg !== lastSign) flips++;
            lastSign = sg;
          }
          minDot = Math.min(minDot, facingDot(st, k));
          idealKeeperSpot(st, c.team, o);
          maxLag = Math.max(maxLag, Math.hypot(q.x - o.x, q.z - o.z));
          if (Number.isNaN(zWhenCentral) && st.ball.z >= 0) zWhenCentral = q.z;
          expect(uOf(dir, q.x)).toBeGreaterThan(0);
          return false;
        },
      });
      expect(startZ).toBeLessThan(-1.5);
      expect(p.z).toBeGreaterThan(1.5);
      expect(Math.abs(zWhenCentral)).toBeLessThan(1);
      expect(flips).toBe(0);
      expect(minDot).toBeGreaterThan(0.95);
      expect(maxLag).toBeLessThan(1.5);
    });
  }

  it('glitch: Keeper carries it over his own line — a keeper starting behind his line (in the goal mouth) walks out and stays in front of it', () => {
    for (const c of SETUPS) {
      for (const [bu, bz] of [[0.5, 20], [0.5, -25], [HALF_LENGTH, 0], [2, 0]] as const) {
        const sc = scenario(c, bu, bz, -0.6, bz > 0 ? 1 : 0);
        const { s, dir, k } = sc;
        const bx = xOf(dir, bu);
        let crossedIn = false;
        runTicks(s, 360, (_t, st) => pin(sc, bx, bz, 0, 0), {
          check: 'core',
          until: (st) => {
            const u = uOf(dir, st.players[k]!.x);
            if (u > 0) crossedIn = true;
            else if (crossedIn) throw new Error(`${label(c)} ball (${bu}, ${bz}): keeper went back over his line (u=${u})`);
            return false;
          },
        });
        expect(crossedIn).toBe(true);
        expect(uOf(dir, s.players[k]!.x)).toBeGreaterThanOrEqual(MIN_LINE - 0.02);
      }
    }
  });

  it('glitch: Keeper carries it over his own line — a keeper behind his goal (beside or behind the net) gets back in front', () => {
    for (const c of SETUPS) {
      for (const [ku, kz] of [[-2.6, 1], [-2.6, 4.5], [-1, 5], [-0.5, -6]] as const) {
        const sc = scenario(c, 0.5, 20, ku, kz);
        const { s, dir, k } = sc;
        const bx = xOf(dir, 0.5);
        runTicks(s, 600, (_t, st) => pin(sc, bx, 20, 0, 0), { check: 'core' });
        const p = s.players[k]!;
        const o = { x: 0, z: 0 };
        idealKeeperSpot(s, c.team, o);
        expect(uOf(dir, p.x)).toBeGreaterThanOrEqual(MIN_LINE - 0.02);
        expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeLessThanOrEqual(SETTLE);
      }
    }
  });

  it('glitch: Keeper carries it over his own line — a keeper caught high and running back stops in front of it', () => {
    for (const c of SETUPS) {
      for (const [bu, bz] of [[0.5, -25], [2, 0], [0.5, 30]] as const) {
        const sc = scenario(c, bu, bz, 14, 2);
        const { s, dir, k } = sc;
        const p = s.players[k]!;
        p.vx = -dir * 8; // sprinting toward his own goal
        const bx = xOf(dir, bu);
        let minU = 1e9;
        runTicks(s, 420, (_t, st) => pin(sc, bx, bz, 0, 0), {
          check: 'core',
          until: (st) => { minU = Math.min(minU, uOf(dir, st.players[k]!.x)); return false; },
        });
        const o = { x: 0, z: 0 };
        idealKeeperSpot(s, c.team, o);
        expect(minU).toBeGreaterThan(0);
        expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeLessThanOrEqual(SETTLE);
      }
    }
  });

  it('glitch: Keeper carries it over his own line — never crosses it while the ball moves all around the box', () => {
    for (const c of SETUPS) {
      const sc = scenario(c, 30, 0, 1, 0);
        const { s, dir, k } = sc;
      let n = 0;
      let minU = 1e9;
      // A deterministic tour: the ball weaves through the box, along the byline and back out, at up to 12 m/s.
      runTicks(s, 1800, (_t, st) => {
        const t = n / 60;
        n++;
        const bu = 0.4 + 14 * (0.5 + 0.5 * Math.cos(t * 0.9));
        const bz = 26 * Math.sin(t * 0.55);
        const vu = -14 * 0.5 * 0.9 * Math.sin(t * 0.9), vz = 26 * 0.55 * Math.cos(t * 0.55);
        pin(sc, xOf(dir, bu), bz, dir * vu, vz);
      }, {
        check: 'core',
        until: (st) => { minU = Math.min(minU, uOf(dir, st.players[k]!.x)); return false; },
      });
      expect(minU).toBeGreaterThan(0);
    }
  });

  it('is deterministic: identical runs give bit-identical keeper paths', () => {
    const run = (): number[] => {
      const sc = scenario({ team: 1, swapped: false }, 18, -12, 2, 3);
        const { s, dir, k } = sc;
      const out: number[] = [];
      let n = 0;
      runTicks(s, 400, (_t, st) => { pin(sc, xOf(dir, 18 - n * 0.02), -12 + n * 0.06, 0, 3.6); n++; }, {
        until: (st) => { const p = st.players[k]!; out.push(p.x, p.z, p.vx, p.vz, p.fx, p.fz); return false; },
      });
      return out;
    };
    const a = run(), b = run();
    expect(a.length).toBe(2400);
    for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);
  });
});
