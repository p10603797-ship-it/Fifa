/**
 * RUL-03 integration: the whole pipeline (team AI, keepers, contacts, CPU brains, resolver, rules) from a ball rolling
 * out over the goal line to the goal kick being taken and play resuming, for both teams and both halves, bot v bot and
 * with a human taker. Only SIM-08 startPass / SIM-09 startLob are replaced (they are Wave 1 stubs here): they kick
 * the ball at once through core/kick.ts applyKick along the request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BALL_RADIUS, HALF_LENGTH } from '../../src/contracts/constants';
import { KickKind, MatchPhase, RestartKind } from '../../src/contracts/enums';
import { EventType, type EventSink, type SimEvent } from '../../src/contracts/events';
import { Btn } from '../../src/contracts/input';
import type { SimState } from '../../src/contracts/state';
import { ReqFlag, createKickLaunch, type ActionRequest } from '../../src/contracts/systems';
import { T_RULES } from '../../src/contracts/tuning';
import { applyKick } from '../../src/sim/core/kick';
import { LOCAL_TUNING } from '../../src/sim/rules/goalkick';
import { findEvents, makeScenario, runUntil } from '../harness/scenario';

const K = vi.hoisted(() => ({ calls: [] as { kind: number; flags: number; slot: number; tick: number }[] }));

function kick(s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink, lofted: boolean): number {
  K.calls.push({ kind, flags: req.flags, slot, tick: s.tick });
  const l = createKickLaunch();
  const sp = lofted ? 20 : 14;
  l.vx = req.dirX * sp; l.vz = req.dirZ * sp; l.vy = lofted ? 9 : 0;
  l.kind = kind; l.target = req.targetSlot; l.tx = s.ball.x + req.dirX * 20; l.tz = s.ball.z + req.dirZ * 20;
  applyKick(s, slot, l, req.power, ev);
  return 1;
}

vi.mock('../../src/sim/kicks/pass', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/pass')>()),
  startPass: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => kick(s, slot, kind, req, ev, false),
}));
vi.mock('../../src/sim/kicks/lob', async (orig) => ({
  ...(await orig<typeof import('../../src/sim/kicks/lob')>()),
  startLob: (s: SimState, slot: number, kind: number, req: ActionRequest, ev: EventSink) => kick(s, slot, kind, req, ev, true),
}));

beforeEach(() => { K.calls.length = 0; });

/** Ball rolling out over the goal line at `end`, wide of the goal, last touched by `toucher`. */
function rollOut(s: SimState, end: number, z: number, toucher: number): void {
  const b = s.ball;
  b.x = end * (HALF_LENGTH - 1.5); b.y = BALL_RADIUS; b.z = z;
  b.px = b.x; b.py = b.y; b.pz = b.z;
  b.vx = end * 12; b.vy = 0; b.vz = 0; b.grounded = 1; b.owner = -1; b.heldBy = -1;
  b.lastTouch = toucher; b.lastTouchTeam = s.players[toucher]!.team; b.lastTouchTick = s.tick;
}

const cases = [
  { name: 'home keeper, first half', swap: false, end: -1, toucher: 20, team: 0, z: 18 },
  { name: 'away keeper, first half', swap: false, end: 1, toucher: 9, team: 1, z: -22 },
  { name: 'home keeper, second half', swap: true, end: 1, toucher: 20, team: 0, z: -12 },
  { name: 'away keeper, second half', swap: true, end: -1, toucher: 9, team: 1, z: 25 },
];

describe('RUL-03 integration (real pipeline)', () => {
  it.each(cases)('bot v bot, $name: out -> goal kick -> taken by the CPU without a watchdog -> play on', (c) => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 0, seed: 21 });
    if (c.swap) {
      s.teams[0]!.dir = -1; s.teams[1]!.dir = 1;
      for (const p of s.players) { p.x = -p.x; p.homeX = -p.homeX; p.fx = -p.fx; }
    }
    rollOut(s, c.end, c.z, c.toucher);
    let gkTick = -1;
    const { events, reached } = runUntil(s, (st) => {
      if (gkTick < 0 && st.match.phase === MatchPhase.GOAL_KICK) gkTick = st.tick;
      return gkTick >= 0 && st.match.phase === MatchPhase.IN_PLAY;
    }, 600, undefined, 'core');
    expect(reached).toBe(true);
    const aw = findEvents(events, EventType.RESTART_AWARDED);
    expect(aw).toHaveLength(1);
    expect([aw[0]!.a, aw[0]!.b]).toEqual([RestartKind.GOAL_KICK, c.team]);
    expect(Math.sign(aw[0]!.z)).toBe(Math.sign(c.z));
    expect(K.calls).toHaveLength(1);
    expect(K.calls[0]!.slot).toBe(s.teams[c.team]!.keeperSlot);
    expect(K.calls[0]!.flags & ReqFlag.SET_PIECE).toBe(ReqFlag.SET_PIECE);
    expect(K.calls[0]!.tick - gkTick).toBeLessThanOrEqual(T_RULES.restartSetupTicks + T_RULES.cpuRestartDelay + LOCAL_TUNING.cpuGraceTicks + 2);
    expect(findEvents(events, EventType.WATCHDOG)).toEqual([] as SimEvent[]);
    expect(findEvents(events, EventType.OFFSIDE)).toEqual([] as SimEvent[]);
    expect(s.ball.lastKickBy).toBe(s.teams[c.team]!.keeperSlot);
  });

  it('human taker: LOB press after ready -> long kick, play on', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, humans: 1, seed: 5 });
    rollOut(s, -1, 15, 20);
    let pressed = false;
    const { events, reached } = runUntil(s, (st) => st.match.phase === MatchPhase.IN_PLAY && K.calls.length > 0, 600, (_t, st, out) => {
      if (!pressed && st.match.phase === MatchPhase.GOAL_KICK && st.match.restart.ready === 1) {
        out[0]!.buttons = Btn.LOB;
        pressed = true;
      }
    }, 'core');
    expect(reached).toBe(true);
    expect(K.calls).toHaveLength(1);
    expect(K.calls[0]!.kind).toBe(KickKind.LOB_PASS);
    expect(K.calls[0]!.slot).toBe(s.teams[0]!.keeperSlot);
    expect(findEvents(events, EventType.WATCHDOG)).toEqual([] as SimEvent[]);
  });
});
