/**
 * RUL-06 end to end with the REAL SIM-11 shot model (no mocks): "faster is harder to save and less accurate" (BRIEF
 * section 9, penalties on touch). RUL-06 maps the swipe speed to the shot power (rul-06-pipeline.test.ts checks the
 * mapping); SIM-11's error model (T_SHOT.errorPowerKnee) makes the harder kick less accurate. While SIM-11 startShot is
 * still the Wave 0 stub (it refuses every shot) these tests are skipped: dependency SIM-11 (src/sim/kicks/shot.ts).
 */
import { describe, expect, it } from 'vitest';
import { HALF_LENGTH } from '../../src/contracts/constants';
import { AssistLevel, GestureKind, KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createActionRequest, ReqFlag } from '../../src/contracts/systems';
import { NULL_SINK } from '../../src/sim/core/events';
import { startShot } from '../../src/sim/kicks/shot';
import { prepareTakerKick } from '../../src/sim/rules/restart';
import { findEvents, runTicks, runUntil } from '../harness/scenario';
import { penaltyScenario, untilReady } from './rul-06-helpers';

/** True while SIM-11 startShot refuses a valid penalty (the Wave 0 stub). */
function shotStub(): boolean {
  const { s } = penaltyScenario({ team: 0, dir: 1, seed: 1, humans: [{ side: 0 }, { side: 1 }] });
  untilReady(s);
  const t = s.match.restart.taker;
  if (prepareTakerKick(s, t) !== 1) return true;
  const req = createActionRequest();
  req.power = 0.6;
  req.dirX = 1;
  req.hasTarget = 1;
  req.targetX = HALF_LENGTH;
  req.targetZ = 1;
  req.assist = AssistLevel.ASSISTED;
  req.flags = ReqFlag.SET_PIECE;
  return startShot(s, t, KickKind.PENALTY, req, NULL_SINK) !== 1;
}

const SHOT_STUB = shotStub();

interface Kick { speed: number; err: number }

/** A human taker swipes toward z = 1.6 on the goal line at swipe speed gPower; launch speed and aim error. */
function swipeKick(seed: number, gPower: number): Kick | null {
  const { s } = penaltyScenario({ team: 0, dir: 1, seed, humans: [{ side: 0 }, { side: 1 }] });
  untilReady(s);
  const r = s.match.restart;
  const aimZ = 1.6;
  const gdx = 110;
  const gdz = Math.round((aimZ / (HALF_LENGTH - r.x)) * gdx);
  const realAim = (gdz / gdx) * (HALF_LENGTH - r.x);
  runTicks(s, 1, (_t, _st, out) => {
    out[0]!.gesture = GestureKind.SWIPE; out[0]!.gdx = gdx; out[0]!.gdz = gdz; out[0]!.gPower = gPower;
  });
  const res = runUntil(s, (_st, ev) => ev.some((e) => e.type === EventType.KICK), 120);
  if (!res.reached || s.match.phase === MatchPhase.PENALTY) return null;
  const k = findEvents(res.events, EventType.KICK);
  if (k.length === 0) return null;
  const b = s.ball;
  const speed = Math.hypot(b.vx, b.vy, b.vz);
  if (!(b.vx > 0.1)) return null;
  const zLine = b.z + (b.vz / b.vx) * (HALF_LENGTH - b.x);
  return { speed, err: zLine - realAim };
}

describe.skipIf(SHOT_STUB)('RUL-06 with the real SIM-11 (skipped while shot.ts is a stub)', () => {
  it('faster swipe = harder (faster ball) and less accurate (wider spread around the aim)', () => {
    const slow: Kick[] = [];
    const fast: Kick[] = [];
    for (let seed = 100; seed < 140; seed++) {
      const a = swipeKick(seed, 64);
      const b = swipeKick(seed, 127);
      if (a) slow.push(a);
      if (b) fast.push(b);
    }
    expect(slow.length).toBeGreaterThan(30);
    expect(fast.length).toBeGreaterThan(30);
    const mean = (k: Kick[], f: (x: Kick) => number): number => k.reduce((acc, x) => acc + f(x), 0) / k.length;
    const rms = (k: Kick[]): number => Math.sqrt(mean(k, (x) => x.err * x.err));
    expect(mean(fast, (x) => x.speed)).toBeGreaterThan(mean(slow, (x) => x.speed) + 2);
    expect(rms(fast)).toBeGreaterThan(rms(slow));
  });
});
