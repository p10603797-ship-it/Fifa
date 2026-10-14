/**
 * [QF-1] QA-09 clock, half end and extra time over real bot matches (every tick checked): the clock never runs
 * backwards or skips, it runs only in clock phases, a period never ends with a shot in flight, the half-end extension
 * stays within the 20 s cap (plus one shot's flight), and every match ends with the right number of periods.
 */
import { describe, expect, it } from 'vitest';
import { MatchPhase, Period } from '../../src/contracts/enums';
import { Btn } from '../../src/contracts/input';
import { EventType } from '../../src/contracts/events';
import { CLOCK_PHASES } from '../../src/contracts/transitions';
import { T_RULES } from '../../src/contracts/tuning';
import { LOCAL_TUNING as RUL01 } from '../../src/sim/rules/machine';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';
import { makeScenario, runTicks } from '../harness/scenario';

describe('QF-1 QA-09 clock and half end in real matches', { timeout: 600_000 }, () => {
  it('glitch half ends during a shot in flight / timer drift — 6 bot matches (cup rules on half of them), every tick checked', () => {
    for (let i = 0; i < 6; i++) {
      const config = soakConfig(i, 909, { halfMinutes: 2, cupShare: 0.5 });
      let prevT = 0;
      let prevPeriod = -1;
      const problems: string[] = [];
      let periodEnds = 0;
      let lastPhase = -1;
      const r = runMatch({
        config, checker: 'core', fastCutscenes: true,
        onTick: (s, ev) => {
          const m = s.match;
          if (m.period !== prevPeriod) { prevPeriod = m.period; prevT = m.periodT; }
          const d = m.periodT - prevT;
          // The clock advances by exactly one in a tick whose rules stage ends in a clock phase (or ends the period).
          let ended = false;
          for (let k = 0; k < ev.count; k++) {
            const e = ev.get(k);
            if (e.type === EventType.PERIOD_END) {
              ended = true;
              periodEnds++;
              const b = s.ball;
              if (b.shotBy >= 0 && s.tick - b.shotTick < RUL01.shotFlightMaxTicks && lastPhase === MatchPhase.IN_PLAY && m.forfeitTeam < 0) {
                problems.push(`t=${s.tick} period ${e.a} ended with a shot in flight (shot at ${b.shotTick})`);
              }
              if (m.extensionT > T_RULES.halfEndExtensionTicks + RUL01.shotFlightMaxTicks) problems.push(`t=${s.tick} extension ${m.extensionT}`);
            }
          }
          const clockPhase = CLOCK_PHASES.includes(m.phase) || ended;
          if (d < 0) problems.push(`t=${s.tick} clock ran backwards ${prevT} -> ${m.periodT}`);
          if (d > 1) problems.push(`t=${s.tick} clock skipped ${prevT} -> ${m.periodT}`);
          if (d === 1 && !clockPhase && m.forfeitTeam < 0) problems.push(`t=${s.tick} clock ran in phase ${m.phase}`);
          if (d === 0 && clockPhase && !ended && m.forfeitTeam < 0 && m.finished === 0 && m.period <= Period.ET_SECOND &&
            lastPhase !== MatchPhase.KICK_OFF && CLOCK_PHASES.includes(lastPhase)) problems.push(`t=${s.tick} clock stopped in phase ${m.phase}`);
          prevT = m.periodT;
          lastPhase = m.phase;
        },
      });
      expect(r.exception).toBeUndefined();
      expect(problems.slice(0, 5), `match ${i}`).toEqual([]);
      expect(r.finished, `match ${i}`).toBe(true);
      // Two halves, plus two extra-time periods for a cup tie level after 90 minutes.
      expect([2, 4]).toContain(periodEnds);
    }
  });

  it('the final whistle cannot be skipped before fullTimeMinTicks (online repair window), then a SKIP ends it', () => {
    const s = makeScenario({ phase: MatchPhase.FULL_TIME, humans: 1, match: { period: Period.SECOND_HALF } });
    let pressAt = s.tick + 2;
    const phases: string[] = [];
    runTicks(s, T_RULES.fullTimeMinTicks + 20, (tick, st, out) => {
      if (tick === pressAt) out[0]!.buttons = Btn.SKIP;
      // A press on every 10th tick while it still shows FULL_TIME: only those from fullTimeMinTicks on count.
      if (tick === pressAt + 1 && st.match.phase === MatchPhase.FULL_TIME) pressAt += 10;
    }, { check: 'core', until: (st) => { phases.push(`${st.match.phaseT}:${MatchPhase[st.match.phase]}`); return st.match.phase === MatchPhase.POST_MATCH; } });
    expect(s.match.phase).toBe(MatchPhase.POST_MATCH);
    // It ended on the first press at or after fullTimeMinTicks, well before fullTimeTicks.
    const lastFt = phases.filter((p) => p.endsWith(':FULL_TIME')).pop()!;
    const t = Number(lastFt.split(':')[0]);
    expect(t).toBeGreaterThanOrEqual(T_RULES.fullTimeMinTicks - 1);
    expect(t).toBeLessThan(T_RULES.fullTimeMinTicks + 10);
    expect(T_RULES.fullTimeTicks).toBeGreaterThan(T_RULES.fullTimeMinTicks + 10);
  });
});
