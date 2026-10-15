import { describe, expect, it } from 'vitest';
import { runMatch } from '../../tools/headless';
import { createMatchConfig } from '../../src/contracts/state';
import { createStatsTracker } from '../../src/modes/stats';
import { Period } from '../../src/contracts/enums';

describe('probe stats', () => {
  for (const seed of [11, 12, 13, 14]) {
    it('seed ' + seed, () => {
      const config = createMatchConfig();
      config.seed = seed;
      config.halfMinutes = 2;
      config.cupRules = seed % 2;
      config.homeClub = seed % 20; config.awayClub = (seed * 7 + 3) % 20;
      if (config.awayClub === config.homeClub) config.awayClub = (config.homeClub + 1) % 20;
      const tr = createStatsTracker();
      let resetDone = false;
      const r = runMatch({ config, fastCutscenes: true, checker: 'none', onTick: (s, ev) => {
        if (!resetDone) { tr.reset(s); resetDone = true; }
        tr.onTick(s, ev);
      } });
      const sm = tr.summary(r.state);
      const issues: string[] = [];
      const st = r.stats;
      for (let t = 0; t < 2; t++) {
        const T = sm.teams[t]!;
        const tag = (k: string, a: number, b: number) => { if (a !== b) issues.push(`t${t} ${k}: tracker ${a} vs headless ${b}`); };
        tag('goals', T.goals, r.state.teams[t]!.goals);
        tag('shots', T.shots, st.shots[t]);
        tag('onTarget', T.shotsOnTarget, st.shotsOnTarget[t]);
        tag('fouls', T.fouls, st.fouls[t]);
        tag('yellow', T.yellow, st.yellows[t]);
        tag('red', T.red, st.reds[t]);
        tag('offsides', T.offsides, st.offsides[t]);
        tag('saves', T.saves, st.saves[t]);
        tag('corners', T.corners, st.corners[t]);
        tag('tackles', T.tackles, st.tackles[t]);
        tag('tacklesWon', T.tacklesWon, st.tacklesWon[t]);
        tag('interceptions', T.interceptions, st.interceptions[t]);
        const pl = sm.players.filter((p) => p.team === t);
        const sum = (k: keyof typeof pl[0]) => pl.reduce((a, p) => a + (p[k] as number), 0);
        if (sum('shots') !== T.shots) issues.push(`t${t} player shots ${sum('shots')} vs ${T.shots}`);
        if (sum('passes') !== T.passes) issues.push(`t${t} player passes ${sum('passes')} vs ${T.passes}`);
        if (sum('passesCompleted') !== T.passesCompleted) issues.push(`t${t} player pc ${sum('passesCompleted')} vs ${T.passesCompleted}`);
        if (sum('saves') !== T.saves) issues.push(`t${t} player saves ${sum('saves')} vs ${T.saves}`);
        if (sum('tackles') !== T.tacklesWon) issues.push(`t${t} player tackles ${sum('tackles')} vs won ${T.tacklesWon}`);
        const og = sm.goals.filter((g) => g.team === t && g.ownGoal).length;
        if (sum('goals') + og !== T.goals && sm.forfeit < 0) issues.push(`t${t} player goals ${sum('goals')}+og${og} vs ${T.goals}`);
        if (sm.goals.filter((g) => g.team === t).length !== T.goals && sm.forfeit < 0) issues.push(`t${t} goal records`);
        if (pl.length < 11) issues.push(`t${t} only ${pl.length} players`);
        for (const p of pl) { if (p.minutes < 0 || p.minutes > 121 || !(p.rating >= 0 && p.rating <= 10)) issues.push(`bad player ${JSON.stringify(p)}`); }
        if (T.passesCompleted > T.passes || T.shotsOnTarget > T.shots) issues.push('ratio');
      }
      if (Math.abs(sm.teams[0].possession + sm.teams[1].possession - 1) > 1e-9) issues.push('possession sum');
      const mins = sm.goals.map((g) => g.minute);
      for (let i = 1; i < mins.length; i++) if (mins[i]! < mins[i - 1]!) issues.push('goal minutes order ' + mins.join(','));
      console.log(`seed ${seed} period ${r.state.match.period} goals ${sm.teams[0].goals}-${sm.teams[1].goals} so ${JSON.stringify(sm.shootout)} winner ${sm.winner} potm ${JSON.stringify(sm.playerOfMatch)} poss ${sm.teams[0].possession.toFixed(3)} vs ${st.possessionPct.join('/')} passes ${sm.teams[0].passes}/${sm.teams[1].passes} vs hl ${st.passes.join('/')} pc ${sm.teams[0].passesCompleted}/${sm.teams[1].passesCompleted} vs ${st.passesCompleted.join('/')} mins ${mins.join(',')}`);
      console.log('ISSUES', seed, issues);
      expect(r.finished).toBe(true);
    }, 120000);
  }
});
