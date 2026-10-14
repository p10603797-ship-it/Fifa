/**
 * UIX-08 unit + scenario tests: pause rules, team / human mapping, the team-orders outbox (coalescing, confirmation,
 * refusal timeout, burst then one per frame) against the real sim pipeline, substitution validation (keeper rule,
 * a substituted player cannot return, max 5), token layout (no overlapping players in any formation) and helpers.
 * The DOM side (drag and drop, select-and-swap, pages, Back) is covered by tests/e2e/uix-08-pause.spec.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SUBS } from '../../src/contracts/constants';
import { Command, FormationId, MatchPhase, Role, TacticalFocus } from '../../src/contracts/enums';
import { RosterStatus, type SimState } from '../../src/contracts/state';
import { createCommandQueue } from '../../src/app/localInput';
import { FORMATIONS } from '../../src/data/formations';
import {
  PAUSE_TUNING, createTeamOrders, defaultManagedTeam, effectiveFocus, effectiveFormation, effectiveTactic, encodeSub,
  humanForTeam, manageableTeams, mayControlPause, pauseCountersText, pendingSubList, pumpTeamOrders, reconcileOrders,
  refusalMessage, resetTeamOrders, setFocusOrder, setFormationOrder, setTacticOrder, staminaLevel, subRefusal,
  subsRemaining, takeOrders, teamOfHuman, teamOrders, tokenPosition, TOKEN_INSET, type OrderCommand,
} from '../../src/ui/screens/pause';
import { makeScenario, runTicks } from '../harness/scenario';

/** Squad indices 11..17 of a team: the outfield substitutes and the bench keeper. */
function bench(s: SimState, team: number): { field: number[]; keeper: number } {
  const field: number[] = [];
  let keeper = -1;
  for (let r = 11; r < 18; r++) {
    if (s.squads[team]![r]!.pos === Role.GK) keeper = r;
    else field.push(r);
  }
  return { field, keeper };
}

beforeEach(() => resetTeamOrders());

describe('UIX-08 pause rules', () => {
  it('only the pauser may resume / restart / quit a human pause; anyone after a system pause', () => {
    expect(mayControlPause(-1, 0)).toBe(true);
    expect(mayControlPause(-1, 1)).toBe(true);
    expect(mayControlPause(-1, -1)).toBe(true);
    expect(mayControlPause(0, 0)).toBe(true);
    expect(mayControlPause(0, 1)).toBe(false);
    expect(mayControlPause(1, 0)).toBe(false);
    expect(mayControlPause(1, -1)).toBe(false);
  });

  it('refusal messages name the pauser and the action; a system pause explains the window', () => {
    expect(refusalMessage(0)).toBe('Only Player 1 can resume');
    expect(refusalMessage(1, 'quit')).toBe('Only Player 2 can quit');
    expect(refusalMessage(0, 'restart')).toBe('Only Player 1 can restart');
    expect(refusalMessage(-1)).not.toMatch(/Player/);
  });

  it('online pause counters are read from the mode payload when present', () => {
    expect(pauseCountersText(undefined)).toBe('');
    expect(pauseCountersText({})).toBe('');
    expect(pauseCountersText({ pausesLeft: 2 })).toBe('Pauses left: 2');
    expect(pauseCountersText({ pausesLeft: [3, 1] })).toBe('P1 pauses left: 3 · P2 pauses left: 1');
    expect(pauseCountersText({ pausesLeft: 'x' })).toBe('');
  });
});

describe('UIX-08 teams and humans', () => {
  it('one human: manages his own side only', () => {
    const s = makeScenario({ humans: 1 });
    expect(humanForTeam(s, 0)).toBe(0);
    expect(humanForTeam(s, 1)).toBe(-1);
    expect(teamOfHuman(s, 0)).toBe(0);
    expect(teamOfHuman(s, 1)).toBe(-1);
    expect(manageableTeams(s, 0, false)).toEqual([0]);
    expect(defaultManagedTeam(s, -1, -1)).toBe(0);
  });

  it('two humans on different sides: both teams, the acting human first; online only his own', () => {
    const s = makeScenario({ humans: 2 });
    expect(manageableTeams(s, 1, false)).toEqual([0, 1]);
    expect(defaultManagedTeam(s, 1, 0)).toBe(1);
    expect(defaultManagedTeam(s, -1, 0)).toBe(0);
    expect(defaultManagedTeam(s, -1, 1)).toBe(1);
    expect(manageableTeams(s, 1, true)).toEqual([1]);
    expect(defaultManagedTeam(s, 1, 0, true)).toBe(1);
  });

  it('no human: nothing to manage', () => {
    const s = makeScenario({ humans: 0 });
    expect(manageableTeams(s, 0, false)).toEqual([]);
    expect(defaultManagedTeam(s, 0, -1)).toBe(-1);
  });

  it('SUBSTITUTE argument is outSlot | inRoster << 8', () => {
    expect(encodeSub(9, 14)).toBe(9 | (14 << 8));
    expect(encodeSub(21, 17) & 255).toBe(21);
    expect((encodeSub(21, 17) >> 8) & 255).toBe(17);
  });
});

describe('UIX-08 team orders (outbox)', () => {
  it('coalesces: a formation picked three times is one command; a toggle on and off again is none', () => {
    const s = makeScenario({ humans: 1 });
    const t = s.teams[0]!;
    const o = createTeamOrders();
    setFormationOrder(o, t, FormationId.F433);
    setFormationOrder(o, t, FormationId.F352);
    setFormationOrder(o, t, FormationId.F4231);
    setTacticOrder(o, t, 1, 1);
    setTacticOrder(o, t, 1, 0);
    setFocusOrder(o, t, TacticalFocus.DEFAULT);
    const out: OrderCommand[] = [];
    takeOrders(o, t, s.tick, 99, out);
    expect(out).toEqual([{ cmd: Command.SET_FORMATION, arg: FormationId.F4231 }]);
    expect(effectiveFormation(o, t)).toBe(FormationId.F4231);
    expect(effectiveTactic(o, t, 1)).toBe(0);
    expect(effectiveFocus(o, t)).toBe(TacticalFocus.DEFAULT);
    // Sent orders are not sent again.
    out.length = 0;
    takeOrders(o, t, s.tick, 99, out);
    expect(out).toEqual([]);
  });

  it('picking the current formation again cancels the order', () => {
    const s = makeScenario({ humans: 1 });
    const t = s.teams[0]!;
    const o = createTeamOrders();
    setFormationOrder(o, t, FormationId.F433);
    setFormationOrder(o, t, t.formation);
    expect(o.formation).toBe(-1);
  });

  it('substitutions go first; the burst limit holds; the rest follow one per call', () => {
    const s = makeScenario({ humans: 1 });
    const t = s.teams[0]!;
    const b = bench(s, 0);
    const o = teamOrders(s, 0);
    setFormationOrder(o, t, FormationId.F433);
    setTacticOrder(o, t, 0, 1);
    o.subs.push({ out: 9, inRoster: b.field[0]!, sentTick: -1 }, { out: 10, inRoster: b.field[1]!, sentTick: -1 });
    const sent: [number, Command, number][] = [];
    const send = (h: number, c: Command, a: number): void => void sent.push([h, c, a]);
    expect(pumpTeamOrders(s, send, 2)).toBe(2);
    expect(sent.map((x) => x[1])).toEqual([Command.SUBSTITUTE, Command.SUBSTITUTE]);
    expect(pumpTeamOrders(s, send, 1)).toBe(1);
    expect(sent[2]![1]).toBe(Command.SET_FORMATION);
    expect(pumpTeamOrders(s, send, 1)).toBe(1);
    expect(sent[3]![1]).toBe(Command.TACTIC_OFFSIDE_TRAP);
    expect(pumpTeamOrders(s, send, 1)).toBe(0);
    expect(sent.every((x) => x[0] === 0)).toBe(true);
  });

  it('scenario: orders made while paused reach the sim through the command queue and apply at the stoppage', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    const t = s.teams[0]!;
    const b = bench(s, 0);
    const o = teamOrders(s, 0);
    o.subs.push({ out: 9, inRoster: b.field[0]!, sentTick: -1 });
    o.subs.push({ out: 6, inRoster: b.field[1]!, sentTick: -1 });
    setFormationOrder(o, t, FormationId.F433);
    setTacticOrder(o, t, 1, 1);
    setFocusOrder(o, t, TacticalFocus.ATTACKING);
    const queue = createCommandQueue();
    const send = (h: number, c: Command, a: number): void => queue.push(h, c, a);
    // Resume: a burst, then one order per frame (here one per tick) as the pause menu's update() does.
    pumpTeamOrders(s, send, PAUSE_TUNING.resumeBurst);
    runTicks(s, 30, (_tick, st, frames) => {
      pumpTeamOrders(st, send, 1);
      queue.applyTo(frames);
    });
    expect(t.roster[b.field[0]!]).toBe(RosterStatus.PLAYING);
    expect(t.roster[b.field[1]!]).toBe(RosterStatus.PLAYING);
    expect(t.roster[9]).toBe(RosterStatus.SUBBED_OFF);
    expect(s.players[9]!.rosterIdx).toBe(b.field[0]);
    expect(s.players[6]!.rosterIdx).toBe(b.field[1]);
    expect(t.subsUsed).toBe(2);
    expect(t.formation).toBe(FormationId.F433);
    expect(t.teamPress).toBe(1);
    expect(t.focus).toBe(TacticalFocus.ATTACKING);
    // Everything confirmed: the outbox is empty.
    reconcileOrders(o, t, s.tick);
    expect(o).toEqual(createTeamOrders());
    expect(subsRemaining(o, t)).toBe(MAX_SUBS - 2);
  });

  it('a substitution waits in the sim queue during open play and is shown pending until the next stoppage', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.IN_PLAY });
    const t = s.teams[0]!;
    const b = bench(s, 0);
    const o = teamOrders(s, 0);
    o.subs.push({ out: 9, inRoster: b.field[0]!, sentTick: -1 });
    const queue = createCommandQueue();
    pumpTeamOrders(s, (h, c, a) => queue.push(h, c, a), 4);
    runTicks(s, 3, (_tick, _st, frames) => queue.applyTo(frames));
    reconcileOrders(o, t, s.tick);
    if (s.match.phase === MatchPhase.IN_PLAY) {
      // Moved from this menu's outbox into the sim's queue: still pending, no longer cancellable, counts as used.
      expect(o.subs).toEqual([]);
      expect(t.roster[b.field[0]!]).toBe(RosterStatus.BENCH);
      const pend = pendingSubList(o, t);
      expect(pend).toEqual([{ out: 9, inRoster: b.field[0], queued: true, local: -1 }]);
      expect(subsRemaining(o, t)).toBe(MAX_SUBS - 1);
    }
  });

  it('an order the sim refuses is dropped after commandConfirmTicks (the menu stops showing it)', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    const t = s.teams[0]!;
    const b = bench(s, 0);
    const o = teamOrders(s, 0);
    // The bench keeper for an outfield player: the sim refuses it.
    o.subs.push({ out: 5, inRoster: b.keeper, sentTick: -1 });
    const queue = createCommandQueue();
    pumpTeamOrders(s, (h, c, a) => queue.push(h, c, a), 4);
    runTicks(s, PAUSE_TUNING.commandConfirmTicks + 2, (_tick, _st, frames) => queue.applyTo(frames));
    expect(t.roster[b.keeper]).toBe(RosterStatus.BENCH);
    reconcileOrders(o, t, s.tick);
    expect(o.subs).toEqual([]);
  });

  it('a team without a human drops its orders; a new match starts with an empty outbox', () => {
    const s = makeScenario({ humans: 1 });
    const o1 = teamOrders(s, 1);
    setFormationOrder(o1, s.teams[1]!, FormationId.F532);
    const sent: number[] = [];
    pumpTeamOrders(s, (_h, c) => void sent.push(c), 9);
    expect(sent).toEqual([]);
    expect(teamOrders(s, 1).formation).toBe(-1);
    const o0 = teamOrders(s, 0);
    setFormationOrder(o0, s.teams[0]!, FormationId.F532);
    const s2 = makeScenario({ humans: 1 });
    expect(teamOrders(s2, 0).formation).toBe(-1);
  });
});

describe('UIX-08 substitution validation', () => {
  it('accepts a valid substitution at a stoppage and in open play', () => {
    for (const phase of [MatchPhase.THROW_IN, MatchPhase.IN_PLAY]) {
      const s = makeScenario({ humans: 1, phase });
      expect(subRefusal(s, 0, 9, bench(s, 0).field[0]!, createTeamOrders())).toBe('');
    }
  });

  it('keeper rule: only a keeper replaces the keeper, a bench keeper only replaces the keeper', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    const b = bench(s, 0);
    const o = createTeamOrders();
    expect(subRefusal(s, 0, 0, b.field[0]!, o)).toBe('Only a keeper can replace the keeper');
    expect(subRefusal(s, 0, 5, b.keeper, o)).toBe('A keeper can only replace the keeper');
    expect(subRefusal(s, 0, 0, b.keeper, o)).toBe('');
  });

  it('a substituted player cannot return; a player on the pitch is not a substitute', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    s.teams[0]!.roster[12] = RosterStatus.SUBBED_OFF;
    const o = createTeamOrders();
    expect(subRefusal(s, 0, 9, 12, o)).toBe('A substituted player cannot return');
    expect(subRefusal(s, 0, 9, 3, o)).toBe('Already on the pitch');
    expect(subRefusal(s, 0, 15, bench(s, 0).field[0]!, o)).toBe('Pick a player on the pitch');
  });

  it('a player or substitute already in a pending substitution cannot be used twice', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    const b = bench(s, 0);
    const o = createTeamOrders();
    o.subs.push({ out: 9, inRoster: b.field[0]!, sentTick: -1 });
    expect(subRefusal(s, 0, 9, b.field[1]!, o)).toBe('That player is already coming off');
    expect(subRefusal(s, 0, 8, b.field[0]!, o)).toBe('That substitute is already coming on');
  });

  it('max five substitutions: used + queued in the sim + ordered here', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    const t = s.teams[0]!;
    const b = bench(s, 0);
    t.subsUsed = 3;
    t.subOut[0] = 2;
    t.subIn[0] = b.field[3]!;
    t.subCount = 1;
    const o = createTeamOrders();
    expect(subsRemaining(o, t)).toBe(1);
    o.subs.push({ out: 9, inRoster: b.field[0]!, sentTick: -1 });
    expect(subsRemaining(o, t)).toBe(0);
    expect(subRefusal(s, 0, 8, b.field[1]!, o)).toBe('No substitutions left');
  });

  it('closed in a shoot-out and once the match is over', () => {
    const s = makeScenario({ humans: 1, phase: MatchPhase.SHOOT_OUT });
    expect(subRefusal(s, 0, 9, bench(s, 0).field[0]!, createTeamOrders())).toBe('Substitutions are closed');
    const s2 = makeScenario({ humans: 1, phase: MatchPhase.THROW_IN });
    s2.match.finished = 1;
    expect(subRefusal(s2, 0, 9, bench(s2, 0).field[0]!, createTeamOrders())).toBe('Substitutions are closed');
  });
});

describe('UIX-08 team-management pitch layout', () => {
  it('positions stay inside the pitch box; the keeper stands at the left goal', () => {
    for (const f of FORMATIONS) {
      for (let i = 0; i < 11; i++) {
        const p = tokenPosition(f.id, i);
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(1);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(1);
        if (i > 0) expect(p.x).toBeGreaterThan(0.15);
      }
      expect(tokenPosition(f.id, 0)).toEqual({ x: 0, y: 0.5 });
    }
  });

  it('regression (overlapping tokens): no two players of any formation overlap on the smallest pitch (600x340, 72x60 tokens)', () => {
    const W = 600, H = 340, TW = 72, TH = 60;
    const px = (p: { x: number; y: number }) => ({
      x: TOKEN_INSET.x + (W - 2 * TOKEN_INSET.x) * p.x,
      y: TOKEN_INSET.y + (H - 2 * TOKEN_INSET.y) * p.y,
    });
    for (const f of FORMATIONS) {
      for (let i = 0; i < 11; i++) {
        for (let j = i + 1; j < 11; j++) {
          const a = px(tokenPosition(f.id, i));
          const b = px(tokenPosition(f.id, j));
          const dx = Math.abs(a.x - b.x);
          const dy = Math.abs(a.y - b.y);
          expect(dx >= TW || dy >= TH, `${f.name} slots ${i} and ${j}: ${dx.toFixed(0)}x${dy.toFixed(0)}`).toBe(true);
        }
      }
    }
  });

  it('stamina bands', () => {
    expect(staminaLevel(1)).toBe('high');
    expect(staminaLevel(0.65)).toBe('high');
    expect(staminaLevel(0.5)).toBe('mid');
    expect(staminaLevel(0.2)).toBe('low');
  });
});
