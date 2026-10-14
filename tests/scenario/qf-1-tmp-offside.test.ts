import { it } from 'vitest';
import { KickKind, MatchPhase } from '../../src/contracts/enums';
import { EventType } from '../../src/contracts/events';
import { NUM_SLOTS } from '../../src/contracts/constants';
import { runMatch } from '../../tools/headless';
import { soakConfig } from '../../tools/lib/configs';

const SKIP = new Set([KickKind.DRIBBLE_TOUCH, KickKind.FIRST_TOUCH, KickKind.DEFLECTION, KickKind.SKILL_TOUCH, KickKind.KNOCK_ON]);
it('probe offside', () => {
  const out: string[] = [];
  let total = 0, kicksN = 0;
  for (let i = 0; i < 8; i++) {
    const config = soakConfig(i, 616, { halfMinutes: 3, cupShare: 0 });
    const snap = [null, null] as ({ t: number; kind: number; phase: number; kicker: number; bx: number; xs: Float64Array; dir: number } | null)[];
    let prevPhase = -1;
    runMatch({ config, checker: 'core', fastCutscenes: true, onTick: (s, ev) => {
      for (let k = 0; k < ev.count; k++) {
        const e = ev.get(k);
        if (e.type === EventType.KICK && !SKIP.has(e.b)) {
          const p = s.players[e.a]!;
          kicksN++;
          const xs = new Float64Array(NUM_SLOTS);
          for (let j = 0; j < NUM_SLOTS; j++) xs[j] = s.players[j]!.active ? s.players[j]!.x : NaN;
          snap[p.team] = { t: s.tick, kind: e.b, phase: prevPhase, kicker: e.a, bx: e.x, xs, dir: s.teams[p.team]!.dir };
        }
        if (e.type === EventType.OFFSIDE) {
          total++;
          const p = s.players[e.a]!;
          const sn = snap[p.team];
          if (!sn) { out.push(`m${i} t=${s.tick} offside ${e.a} without a team kick`); continue; }
          const d = sn.dir;
          const ax = sn.xs[e.a]! * d;
          const defs: number[] = [];
          for (let j = 0; j < NUM_SLOTS; j++) if (s.players[j]!.team !== p.team && !Number.isNaN(sn.xs[j]!)) defs.push(sn.xs[j]! * d);
          defs.sort((a, b) => b - a);
          const second = defs[1] ?? -1e9;
          const problems: string[] = [];
          if (ax <= 0) problems.push('own half');
          if (ax < sn.bx * d - 0.3) problems.push('behind ball');
          if (ax < second - 0.3) problems.push(`behind 2nd-last (${(ax - second).toFixed(2)})`);
          if (sn.phase === MatchPhase.THROW_IN || sn.phase === MatchPhase.GOAL_KICK || sn.phase === MatchPhase.CORNER) problems.push(`from ${MatchPhase[sn.phase]}`);
          if (sn.kicker === e.a) problems.push('own kick');
          if (problems.length) out.push(`m${i} t=${s.tick} slot ${e.a} kick@${sn.t} kind ${KickKind[sn.kind]} phase ${MatchPhase[sn.phase]}: ${problems.join(', ')} ax=${ax.toFixed(2)} ball=${(sn.bx*d).toFixed(2)} 2nd=${second.toFixed(2)}`);
        }
      }
      prevPhase = s.match.phase;
    } });
  }
  throw new Error(`QFOFF offsides=${total} kicks=${kicksN}\n${out.slice(0, 20).join('\n')}`);
}, 900000);
