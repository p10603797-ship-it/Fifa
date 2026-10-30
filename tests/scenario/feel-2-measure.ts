/**
 * [FEEL-2] Measurement runner for tests/scenario/feel-2-*.test.ts (feel-2-helpers): `npx tsx
 * tests/scenario/feel-2-measure.ts [grid|skill|straight|chase|diagonal|weave|shot|shotpoor] [levels]`; SEEDS=21,22,23
 * picks the grid's seeds, SHOT_SEEDS_A / SHOT_SEEDS_B the shot probes'.
 */
import { Difficulty } from '../../src/contracts/enums';
import {
  chases, diagonalMoves, levelChases, shotRate, shotRateB, sideStepGrid, straightRuns, weavingJogger, type KShot,
} from './feel-2-helpers';

const which = process.argv[2] ?? 'grid';
const levels = (process.argv[3] ?? '0,1,2,3,4,5').split(',').map(Number) as Difficulty[];
const seeds = (process.env.SEEDS ?? '21,22,23').split(',').map(Number);
const pct = (a: number, b: number): string => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;
const j = (o: object): string => JSON.stringify(o);

if (which === 'grid') for (const lv of levels) { const g = sideStepGrid(lv, { seeds }); console.log(`GRID L${lv} beat ${pct(g.beat, g.n)} ${j(g)}`); }
if (which === 'skill') for (const lv of levels) for (const skill of [35, 90]) { const g = sideStepGrid(lv, { seeds, skill }); console.log(`SKILL L${lv} skill ${skill} beat ${pct(g.beat, g.n)} ${j(g)}`); }
if (which === 'straight') for (const lv of levels) console.log(`STRAIGHT L${lv} ${j(straightRuns(lv))}`);
if (which === 'chase') for (const lv of levels) console.log(`CHASE L${lv} sx10 ${j(chases(lv, 10))} sx25 ${j(chases(lv, 25))} level ${j(levelChases(lv))}`);
if (which === 'diagonal') for (const lv of levels) console.log(`DIAGONAL L${lv} ${j(diagonalMoves(lv))}`);
if (which === 'weave') for (const lv of levels) console.log(`WEAVE L${lv} ${j(weavingJogger(lv))}`);
if (which === 'shot' || which === 'shotpoor') {
  const shooter = which === 'shotpoor' ? 40 : undefined;
  const sa = (process.env.SHOT_SEEDS_A ?? '4,5,6,7,8,9,10,11,12').split(',').map(Number);
  const sb = (process.env.SHOT_SEEDS_B ?? '71,72,73').split(',').map(Number);
  for (const st of (process.env.KINDS ?? 'normal,finesse,power,trivela').split(',') as KShot[]) {
    const a1 = shotRate(st, sa, shooter, true), a2 = shotRate(st, sa, shooter, false);
    const b1 = shotRateB(st, sb, shooter, true), b2 = shotRateB(st, sb, shooter, false);
    const g = a1.goals + a2.goals + b1.goals + b2.goals, n = a1.n + a2.n + b1.n + b2.n;
    console.log(`SHOT ${st} shooter=${shooter ?? 'slot9'} A set ${j(a1)} A off ${j(a2)} B set ${j(b1)} B off ${j(b2)} pooled ${pct(g, n)} (n=${n})`);
  }
}
