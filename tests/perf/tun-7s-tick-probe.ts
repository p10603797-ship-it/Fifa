/**
 * [TUN-7S] QA-37 / QF-7S (d) probe: sim + AI tick time (the whole step(): rules, controllers, AI, actions, physics) in
 * worst cases, run in a child process by tests/perf/tun-7s-tick-time.test.ts or by hand:
 *   node --import tsx tests/perf/tun-7s-tick-probe.ts [ticksPerScenario]
 * Scenarios (CPU v CPU, Legend so the AI does the most work): live play (a running match), a crowded box (all 22 inside
 * one penalty area around a bouncing loose ball), 22 chasers (everyone within 15 m of a slow loose ball in midfield), a
 * corner and a free kick on the edge of the box (award, setup, wall, taker: the restart's busiest ticks), a cup match's
 * shoot-out. A scenario that disperses is restored from its template every `reset` ticks (copyState, not timed), and every
 * pass starts from the template. Every tick is timed with performance.now(); prints JSON
 * { [scenario]: { meanUs, p99Us, maxUs, ticks, valid } } where `valid` is the share of measured ticks that were the
 * scenario (in its phase / crowded / chased), so a scenario that drifted out of what it claims to time fails the test.
 * [TUN-7S skeptic] Pass 1 used to continue from where the warm-up pass ended: the shoot-out's measured pass was 77%
 * POST_MATCH ticks (its "13 us" timed the idle state after the shoot-out).
 */
import '../../tools/lib/env';
import { HALF_LENGTH, HALF_WIDTH, PENALTY_AREA_DEPTH, PENALTY_AREA_HALF_WIDTH } from '../../src/contracts/constants';
import { Difficulty, MatchPhase, ModeId, RestartKind } from '../../src/contracts/enums';
import { clearInputFrame, createInputFrame } from '../../src/contracts/input';
import { createMatchConfig, createSimState, type SimState } from '../../src/contracts/state';
import { copyState } from '../../src/sim/core/clone';
import { createEventBuffer } from '../../src/sim/core/events';
import { initMatch } from '../../src/sim/init';
import { awardRestart } from '../../src/sim/rules/restart';
import { step } from '../../src/sim/step';

const N = Number(process.argv[2] ?? 3000);
const frames = [createInputFrame(), createInputFrame()];
const ev = createEventBuffer();

function match(seed: number, shootout = false): SimState {
  const c = createMatchConfig();
  c.seed = seed;
  c.difficulty = Difficulty.LEGEND;
  c.humans = c.humans.map((h) => ({ ...h, kind: 0, side: -1 }));
  if (shootout) { c.mode = ModeId.SHOOT_OUT; c.startPhase = MatchPhase.SHOOT_OUT; }
  return initMatch(c);
}

function tick(s: SimState): void {
  clearInputFrame(frames[0]!);
  clearInputFrame(frames[1]!);
  step(s, frames, ev);
}

/** A running match at kick-off + 40 s of play (or the shoot-out's start). */
function inPlay(seed: number): SimState {
  const s = match(seed);
  for (let i = 0; i < 4000 && !(s.match.phase === MatchPhase.IN_PLAY && s.tick > 2400); i++) tick(s);
  return s;
}

function crowd(s: SimState, cx: number, cz: number, rx: number, rz: number): void {
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const a = (i * 2.399963) % 6.283185307179586;
    const r = 0.25 + 0.75 * ((i * 7) % 22) / 21;
    p.x = cx + Math.cos(a) * rx * r;
    p.z = cz + Math.sin(a) * rz * r;
    p.vx = 0; p.vz = 0;
  }
}

function crowdedBox(): SimState {
  const s = inPlay(11);
  crowd(s, HALF_LENGTH - 8, 0, 7.5, 18);
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = HALF_LENGTH - 10; b.z = 1; b.y = 1.2; b.vx = -3; b.vy = 2; b.vz = 1.5; b.grounded = 0;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  return s;
}

function chasers(): SimState {
  const s = inPlay(12);
  crowd(s, 0, 0, 15, 15);
  const b = s.ball;
  b.owner = -1; b.heldBy = -1; b.x = 0; b.z = 0; b.y = 0.11; b.vx = 1.5; b.vy = 0; b.vz = 0.5; b.grounded = 1;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  return s;
}

function restart(kind: RestartKind, x: number, z: number): SimState {
  const s = inPlay(13);
  crowd(s, HALF_LENGTH - 12, 0, 10, 18);
  ev.begin(s.tick);
  awardRestart(s, kind, 0, x, z, ev);
  return s;
}

interface Stat { meanUs: number; p99Us: number; maxUs: number; ticks: number; valid: number }

/** Scenario checks (after each measured tick). */
type Check = (s: SimState) => boolean;
const inPhase = (ph: MatchPhase): Check => (s) => s.match.phase === ph;
/** Live play: the ball in play or a restart being set up / taken (not a cut-scene or a break). */
const live: Check = (s) => s.match.phase >= MatchPhase.IN_PLAY && s.match.phase <= MatchPhase.PENALTY;
/** At least 18 of the 22 inside one penalty area. */
const crowded: Check = (s) => {
  let a = 0, b = 0;
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    if (Math.abs(p.z) > PENALTY_AREA_HALF_WIDTH) continue;
    if (p.x > HALF_LENGTH - PENALTY_AREA_DEPTH) a++;
    else if (p.x < -HALF_LENGTH + PENALTY_AREA_DEPTH) b++;
  }
  return a >= 18 || b >= 18;
};
/** At least 18 of the 22 within 20 m of the ball. */
const chased: Check = (s) => {
  let n = 0;
  for (let i = 0; i < 22; i++) {
    const p = s.players[i]!;
    const dx = p.x - s.ball.x, dz = p.z - s.ball.z;
    if (dx * dx + dz * dz < 400) n++;
  }
  return n >= 18;
};

function measure(make: () => SimState, reset: number, check: Check): Stat {
  const tpl = make();
  const s = createSimState(tpl.config, tpl.squads);
  const times: number[] = [];
  let valid = 0;
  for (let w = 0; w < 2; w++) { // pass 0 warms the JIT on this scenario; pass 1 is measured (both from the template)
    times.length = 0;
    valid = 0;
    for (let i = 0; i < N; i++) {
      if (i === 0 || (reset > 0 && i % reset === 0)) copyState(s, tpl);
      const t0 = performance.now();
      tick(s);
      times.push((performance.now() - t0) * 1000);
      if (check(s)) valid++;
    }
  }
  times.sort((a, b) => a - b);
  let sum = 0;
  for (const t of times) sum += t;
  return {
    meanUs: sum / times.length, p99Us: times[Math.floor(times.length * 0.99)]!, maxUs: times[times.length - 1]!,
    ticks: times.length, valid: valid / times.length,
  };
}

const out: Record<string, Stat> = {};
out.livePlay = measure(() => inPlay(10), 0, live);
out.crowdedBox = measure(crowdedBox, 30, crowded);
out.chasers22 = measure(chasers, 60, chased);
out.corner = measure(() => restart(RestartKind.CORNER, HALF_LENGTH, HALF_WIDTH), 240, inPhase(MatchPhase.CORNER));
out.freeKickEdgeOfBox = measure(() => restart(RestartKind.FREE_KICK, HALF_LENGTH - 20, 4), 240, inPhase(MatchPhase.FREE_KICK));
out.shootout = measure(() => match(14, true), 0, inPhase(MatchPhase.SHOOT_OUT));
console.log(JSON.stringify(out));
