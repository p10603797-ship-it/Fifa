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

/** IN_PLAY bot match with the ball at (bu, bz) relative to `team`'s goal and its keeper at (ku, kz). */
function scenario(c: Setup, bu: number, bz: number, ku: number, kz: number): { s: SimState; dir: number; k: number } {
  const dirs = c.swapped ? [-1, 1] : [1, -1];
  const dir = dirs[c.team]!;
  const k = c.team === 0 ? 0 : 11;
  const other = c.team === 0 ? 11 : 0;
  const otherDir = dirs[1 - c.team]!;
  const s = makeScenario({
    phase: MatchPhase.IN_PLAY,
    teams: [{ dir: dirs[0] }, { dir: dirs[1] }],
    ball: { x: xOf(dir, bu), y: 0.11, z: bz, vx: 0, vy: 0, vz: 0 },
    players: [
      { slot: k, x: xOf(dir, ku), z: kz, vx: 0, vz: 0 },
      { slot: other, x: xOf(otherDir, 1), z: 0, vx: 0, vz: 0 },
    ],
  });
  return { s, dir, k };
}

/**
 * Pin the ball at a pitch point with a given velocity (applied before every tick). [INT-A] A pinned ball is nobody's
 * pass: passTarget is cleared, or a CPU defender's back pass during the settle phase sends the keeper to meet it
 * (GKP-01 receivePass) along a path the pin never lets it follow.
 */
function pin(s: SimState, x: number, z: number, vx: number, vz: number): void {
  const b = s.ball;
  b.x = x; b.z = z; b.y = 0.11; b.vx = vx; b.vz = vz; b.vy = 0; b.px = x; b.pz = z; b.py = 0.11; b.grounded = 1;
  b.passTarget = -1;
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
        const { s, dir, k } = scenario(c, bu, bz, 0.5, 0);
        const bx = xOf(dir, bu);
        runTicks(s, 300, (_t, st) => pin(st, bx, bz, 0, 0), { check: 'core' });
        const p = s.players[k]!;
        const o = { x: 0, z: 0 };
        idealKeeperSpot(s, c.team, o);
        expect(Math.hypot(p.x - o.x, p.z - o.z)).toBeLessThanOrEqual(SETTLE);
        // At rest: no micro-movement, still facing the ball.
        let path = 0;
        let px = p.x, pz = p.z;
        runTicks(s, 300, (_t, st) => pin(st, bx, bz, 0, 0), {
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
      const { s, dir, k } = scenario(c, bu, -15, 1, -1);
      const bx = xOf(dir, bu);
      runTicks(s, 240, (_t, st) => pin(st, bx, -15, 0, 0));
      const p = s.players[k]!;
      const startZ = p.z;
      let flips = 0, lastSign = 0, minDot = 1, maxLag = 0, zWhenCentral = Number.NaN;
      const o = { x: 0, z: 0 };
      const ticks = 360;
      let i = 0;
      runTicks(s, ticks + 60, (_t, st) => {
        const z = Math.min(15, -15 + speed * i / 60);
        pin(st, bx, z, 0, z < 15 ? speed : 0);
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
        const { s, dir, k } = scenario(c, bu, bz, -0.6, bz > 0 ? 1 : 0);
        const bx = xOf(dir, bu);
        let crossedIn = false;
        runTicks(s, 360, (_t, st) => pin(st, bx, bz, 0, 0), {
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
        const { s, dir, k } = scenario(c, 0.5, 20, ku, kz);
        const bx = xOf(dir, 0.5);
        runTicks(s, 600, (_t, st) => pin(st, bx, 20, 0, 0), { check: 'core' });
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
        const { s, dir, k } = scenario(c, bu, bz, 14, 2);
        const p = s.players[k]!;
        p.vx = -dir * 8; // sprinting toward his own goal
        const bx = xOf(dir, bu);
        let minU = 1e9;
        runTicks(s, 420, (_t, st) => pin(st, bx, bz, 0, 0), {
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
      const { s, dir, k } = scenario(c, 30, 0, 1, 0);
      let n = 0;
      let minU = 1e9;
      // A deterministic tour: the ball weaves through the box, along the byline and back out, at up to 12 m/s.
      runTicks(s, 1800, (_t, st) => {
        const t = n / 60;
        n++;
        const bu = 0.4 + 14 * (0.5 + 0.5 * Math.cos(t * 0.9));
        const bz = 26 * Math.sin(t * 0.55);
        const vu = -14 * 0.5 * 0.9 * Math.sin(t * 0.9), vz = 26 * 0.55 * Math.cos(t * 0.55);
        pin(st, xOf(dir, bu), bz, dir * vu, vz);
      }, {
        check: 'core',
        until: (st) => { minU = Math.min(minU, uOf(dir, st.players[k]!.x)); return false; },
      });
      expect(minU).toBeGreaterThan(0);
    }
  });

  it('is deterministic: identical runs give bit-identical keeper paths', () => {
    const run = (): number[] => {
      const { s, dir, k } = scenario({ team: 1, swapped: false }, 18, -12, 2, 3);
      const out: number[] = [];
      let n = 0;
      runTicks(s, 400, (_t, st) => { pin(st, xOf(dir, 18 - n * 0.02), -12 + n * 0.06, 0, 3.6); n++; }, {
        until: (st) => { const p = st.players[k]!; out.push(p.x, p.z, p.vx, p.vz, p.fx, p.fz); return false; },
      });
      return out;
    };
    const a = run(), b = run();
    expect(a.length).toBe(2400);
    for (let i = 0; i < a.length; i++) expect(Object.is(a[i], b[i])).toBe(true);
  });
});
