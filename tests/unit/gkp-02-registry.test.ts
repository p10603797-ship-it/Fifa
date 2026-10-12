/**
 * [GKP-02] Integration: the GK_DIVE / GK_CATCH handlers reach the action registry even when keeper/saves.ts is the
 * first module to enter the saves -> dispatch -> registry -> saves import cycle (it is imported FIRST here on purpose),
 * and saves work with the real GKP-05 keeper/handling.ts (no test double).
 */
import { catchHandler, diveHandler, keeperSaveDecision } from '../../src/sim/keeper/saves';
import { describe, expect, it } from 'vitest';
import { ActionKind, MatchPhase, SaveKind } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { ACTION_HANDLERS } from '../../src/sim/actions/registry';
import { makeScenario, runTicks } from '../harness/scenario';
import { KEEPER, keeperScenario, runShot, shoot, xAt } from './gkp-02-helpers';

describe('GKP-02 registry and real keeper handling', () => {
  it('the action registry dispatches GK_DIVE and GK_CATCH to the GKP-02 handlers', () => {
    expect(ACTION_HANDLERS[ActionKind.GK_DIVE]).toBe(diveHandler);
    expect(ACTION_HANDLERS[ActionKind.GK_CATCH]).toBe(catchHandler);
    expect(typeof keeperSaveDecision).toBe('function');
  });

  it('a catchable shot is caught into the hands with the real GKP-05 pick-up (SAVE CATCH, KEEPER_HANDS, GK_HOLD)', () => {
    const s = keeperScenario({ gk: 80, u: 3 });
    shoot(s, { u: 18, z: 0, tz: 0, ty: 1.0, speed: 13 });
    const r = runShot(s);
    expect(r.outcome).toBe('save');
    expect(r.save?.b).toBe(SaveKind.CATCH);
    expect(s.ball.heldBy).toBe(KEEPER);
    expect(s.players[KEEPER]!.act).toBe(ActionKind.GK_HOLD);
    expect(r.events.filter((e) => e.type === EventType.KEEPER_HANDS && e.a === KEEPER && e.b === 1)).toHaveLength(1);
  });

  it('keepers are always AI for saves: a human-controlled keeper still dives for a shot', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 12, humans: [{ side: 0, slot: KEEPER }] });
    s.players[KEEPER]!.x = xAt(2); s.players[KEEPER]!.z = 0;
    for (let i = 1; i < 22; i++) if (i !== 11) { s.players[i]!.x = 20; s.players[i]!.z = -30 + i * 2.5; }
    shoot(s, { u: 16, z: 0, tz: -2.0, ty: 0.4, speed: 27 });
    let dived = false;
    let touched = false;
    runTicks(s, 120, undefined, {
      until: (st) => {
        if (st.players[KEEPER]!.act === ActionKind.GK_DIVE) dived = true;
        if (st.ball.lastTouch === KEEPER) touched = true;
        return touched;
      },
    });
    expect(dived).toBe(true);
    expect(touched).toBe(true);
  });

  it('a dive happens in the full step pipeline (decision in teamAiTick, contact in contactsTick)', () => {
    const s = makeScenario({ phase: MatchPhase.IN_PLAY, seed: 11 });
    s.players[KEEPER]!.x = xAt(2); s.players[KEEPER]!.z = 0;
    for (let i = 1; i < 22; i++) if (i !== 11) { s.players[i]!.x = 20; s.players[i]!.z = -30 + i * 2.5; }
    shoot(s, { u: 16, z: 0, tz: 2.0, ty: 0.4, speed: 27 });
    let dived = false;
    let touched = false;
    runTicks(s, 120, undefined, {
      until: (st) => {
        if (st.players[KEEPER]!.act === ActionKind.GK_DIVE) dived = true;
        if (st.ball.lastTouch === KEEPER) touched = true;
        return touched;
      },
    });
    expect(dived).toBe(true);
    expect(touched).toBe(true);
  });
});
