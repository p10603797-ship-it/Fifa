/** [FEEL-2] Measurement runner: `npx tsx tests/scenario/feel-2-measure.ts [def|skill|straight|shot|shotpoor]`. */
import { Difficulty } from '../../src/contracts/enums';
import { BODY_TOUCH, shotRate, sideStepGrid, vsDefender, type KShot } from './feel-2-helpers';

const which = process.argv[2] ?? 'all';
const levels = (process.argv[3] ?? '0,1,2,3,4,5').split(',').map(Number) as Difficulty[];
const SEEDS = Array.from({ length: Number(process.env.SEEDS ?? 4) }, (_, i) => i + 1);
const pct = (a: number, b: number): string => `${((100 * a) / Math.max(1, b)).toFixed(0)}%`;

if (which === 'all' || which === 'def') {
  for (const lv of levels) for (const style of ['r1', 'sprint'] as const) {
    const r = sideStepGrid(lv, { styles: [style], seeds: SEEDS });
    console.log(`DEF level=${lv} ${style.padEnd(6)} n=${r.n} beat=${pct(r.beat, r.n)} lost=${pct(r.lost, r.n)} none=${r.none} fouls=${r.fouls} minSep=${r.minSep.toFixed(2)} (touch ${BODY_TOUCH.toFixed(2)}) maxJump=${r.maxJump.toFixed(3)} stuck=${r.stuck} flips=${r.flips} how=${JSON.stringify(r.how)} tackles=${r.tackles} won=${r.won} rollLost=${r.rollLost}`);
  }
}
if (which === 'all' || which === 'skill') {
  for (const lv of levels) for (const sk of [35, 90]) {
    const r = sideStepGrid(lv, { skill: sk, seeds: SEEDS });
    console.log(`SKILL level=${lv} skill=${sk} n=${r.n} beat=${pct(r.beat, r.n)} lost=${pct(r.lost, r.n)} fouls=${r.fouls}`);
  }
}
if (which === 'all' || which === 'straight') {
  for (const lv of levels) {
    let n = 0, lost = 0, beat = 0;
    for (const style of ['r1', 'sprint', 'jog'] as const) for (const seed of [1, 2, 3, 4]) for (const lat of [-0.5, 0, 0.5]) {
      const r = vsDefender({ style, level: lv, seed, lat, weave: 0 });
      n++; if (r.res === 'lost') lost++; else if (r.res === 'beat') beat++;
    }
    console.log(`STRAIGHT level=${lv} n=${n} lost=${pct(lost, n)} beat=${pct(beat, n)}`);
  }
}
if (which === 'all' || which === 'shot') {
  const seeds = [4, 5, 6, 7, 8, 9, 10, 11, 12];
  for (const [label, shooter, setK] of [['set keeper', undefined, true], ['keeper off line', undefined, false], ['poor shooter (40), set keeper', 40, true], ['poor shooter (40), off line', 40, false]] as const) {
    const row: string[] = [];
    for (const st of ['normal', 'finesse', 'power', 'trivela'] as KShot[]) {
      const r = shotRate(st, seeds, shooter, setK);
      row.push(`${st} ${pct(r.goals, r.n)} (off ${pct(r.off, r.n)})`);
    }
    console.log(`SHOT ${label.padEnd(30)} n=180 each: ${row.join('  ')}`);
  }
}
