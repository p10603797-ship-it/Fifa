/**
 * [QF-2 skeptic] QA-13 / QA-21: penalty saves. Over 50 shoot-out kicks (cup bot matches, soak seed 31, Professional)
 * the keeper saved 2 (87% scored, 4% saved); when he had guessed the right side he still saved 1 in 19. GKP-02's
 * dive capsule slopes from the feet (hip - 0.5 m) up to the hands, so GKP-06's mid dive (hands at 1.05 m) covered
 * only up to ~1.1 m near his body, and every CPU penalty is struck at 1.1-1.6 m: it went in over a keeper who had
 * gone the right way. The AI also dived low 42% of the time (a low dive cannot reach a ball above 0.6 m), and the CPU
 * aimed every penalty 0.45-1.1 m inside a post, beyond a full dive in time.
 * Fix: diveMidY 1.05 -> 1.2, AI dive heights low / mid 0.42 / 0.38 -> 0.25 / 0.5, CPU penalty inset 0.45-1.7 m.
 * Shoot-outs over 36 cup matches: 81.5% scored (189 kicks), a right guess saves 15%.
 * The kick is SIM-11's contract fake (tests/scenario/gkp-06-fakes.ts) aimed exactly; the keeper is a human whose
 * stored choice (restart.side / aimPower) is the AI's kind of choice: the right side, mid height.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sim/kicks/shot', async (o) => (await import('./gkp-06-fakes')).mockShot(await o()));
import '../../src/sim/actions/dispatch';

import { HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { createActionRequest } from '../../src/contracts/systems';
import { NULL_SINK } from '../../src/sim/core/events';
import { applyKick } from '../../src/sim/core/kick';
import { startShot } from '../../src/sim/kicks/shot';
import { LOCAL_TUNING as GK6 } from '../../src/sim/keeper/setpieces';
import { LOCAL_TUNING as TAI13 } from '../../src/ai/setpieces';
import { awardRestart, prepareTakerKick } from '../../src/sim/rules/restart';
import { makeScenario, runTicks, runUntil } from '../harness/scenario';
import { SHOT, resetShot } from './gkp-06-fakes';

SHOT.applyKick = applyKick;
beforeEach(() => resetShot());

/** A penalty for team 0 at (goal line, tz, ty) and speed sp; team 1's keeper (gk 75) dives `side` at height class h. */
function penalty(tz: number, ty: number, sp: number, side: number, h: number): 'goal' | 'save' | 'other' {
  const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 9, humans: [{ side: 0 }, { side: 1 }] });
  const k = s.teams[1]!.keeperSlot;
  const a = s.attrs[k]!;
  a.gkDiving = 75; a.gkHandling = 75; a.gkReflexes = 75; a.gkPositioning = 75;
  awardRestart(s, RestartKind.PENALTY, 0, 40, 0, NULL_SINK);
  expect(runUntil(s, (st) => st.match.restart.ready === 1, 200, undefined, 'core').reached).toBe(true);
  runTicks(s, 20, undefined, { check: 'core' });
  const r = s.match.restart;
  r.side = side; r.aimPower = h;
  SHOT.useReq = 0; SHOT.tx = s.teams[0]!.dir * (HALF_LENGTH + 0.6); SHOT.tz = tz; SHOT.ty = ty; SHOT.speed = sp;
  expect(prepareTakerKick(s, r.taker)).toBe(1);
  const req = createActionRequest();
  req.power = 0.8;
  expect(startShot(s, r.taker, KickKind.PENALTY, req, NULL_SINK)).toBe(1);
  let goal = false, touched = false;
  runTicks(s, 80, undefined, {
    check: 'core',
    until: (st, ev) => {
      if (st.ball.lastTouch === k) touched = true;
      if (ev.some((e) => e.type === EventType.GOAL)) goal = true;
      return goal || touched;
    },
  });
  return goal ? 'goal' : touched ? 'save' : 'other';
}

describe('QF-2 penalty saves (GKP-06 dive heights, real dive physics)', () => {
  it('a right guess at mid height saves chest-high penalties inside his reach (was: in over him)', () => {
    // Each of these went in at diveMidY 1.05 (the ball passed above the sloping dive capsule).
    for (const [tz, ty, sp] of [[1.9, 1.25, 26], [2.8, 1.5, 26], [2.2, 1.45, 27]] as const) {
      expect(penalty(tz, ty, sp, 1, 1), `z ${tz} y ${ty}`).toBe('save');
    }
    // Still saved: a lower mid-height ball, and the earlier GKP-06 reference shot.
    expect(penalty(2.3, 0.9, 22, 1, 1)).toBe('save');
    expect(penalty(1.5, 1.1, 26, 1, 1)).toBe('save');
  });

  it('the wrong way is still a goal, and a ball inside the post beyond a full dive in time still beats him', () => {
    expect(penalty(1.9, 1.25, 26, -1, 1)).toBe('goal');
    expect(penalty(3.3, 1.3, 28, 1, 1)).toBe('goal');
  });

  it('the AI keeper dives mid-height most often, and CPU kickers do not aim every penalty at the corner', () => {
    expect(GK6.aiMidChance).toBeGreaterThan(GK6.aiLowChance);
    expect(GK6.diveMidY).toBeGreaterThanOrEqual(1.15);
    expect(TAI13.penInsetMax).toBeGreaterThanOrEqual(1.5);
  });
});
